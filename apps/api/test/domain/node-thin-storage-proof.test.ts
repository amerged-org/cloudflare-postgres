// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  NodeThinStorageAuthority,
  newOperationId,
  thinStorageClass,
} from "@pgcf/contracts";
import { NodeStorageHeadroomResponse } from "@pgcf/contracts/node-thin-storage";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  dispatchThinPoolAction,
  prepareThinStorageLease,
} from "../../src/domain/node-thin-storage-execution.ts";
import { readCurrentNodeThinStorage } from "../../src/domain/node-thin-storage.ts";
import {
  storageProtectionStatements,
  thinStorageDeletionConfirmedSql,
} from "../../src/domain/storage-capacity.ts";
import {
  type Fixture,
  gib,
  identityProof,
  iso,
  lvs,
  mib,
  nonce,
  post,
  report,
  row,
  sample,
} from "./thin-renewal-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
/** The current lease's issue moved into the past, as a slow turn of that length leaves it. */
async function leaseIssuedAgo(f: Fixture, milliseconds: number) {
  const issued = Date.now() - milliseconds;
  await env.DB.prepare(
    "UPDATE node_thin_storage SET updated_at=?,lease_expires_at=? WHERE node_id=?",
  )
    .bind(iso(issued), iso(issued + 95_000), f.node)
    .run();
  return issued;
}
async function endLease(f: Fixture) {
  await env.DB.prepare(
    "UPDATE node_thin_storage SET lease_expires_at=? WHERE node_id=? AND lease_id IS NOT NULL",
  )
    .bind(iso(Date.now() - 1000), f.node)
    .run();
}
const used = (f: Fixture, bytes: number) => ({
  ...f.authority.physical,
  thin_pool: {
    ...f.authority.physical.thin_pool!,
    data_used_bytes_upper_bound: bytes,
  },
});

it("an identity turn holds the executor's 90 s budget instead of the guard", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const input = await prepareThinStorageLease(f.local, f.node);
  expect(
    Date.parse(input!.lease.expires_at) - Date.parse(input!.lease.issued_at),
  ).toBe(95_000);
});

it("records a slow report as an identity proof valid 300 s, even when the authority it composes already expired", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  // The previous proof was read a minute ago; nothing renewed it since.
  const earlier = Date.now() - 60_000;
  await identityProof(f, {
    observed_at: iso(earlier),
    captured_at: iso(earlier),
    expires_at: iso(earlier + 10_000),
    inventory_observed_at: iso(earlier),
    inventory_expires_at: iso(earlier + 300_000),
  });
  await prepareThinStorageLease(f.local, f.node);
  // A 30 s turn against a 10 s guard.
  const issued = await leaseIssuedAgo(f, 30_000);
  expect(await report(f)).toMatchObject({
    accepted: true,
    revision: 3,
    write_allowed: true,
  });
  expect(JSON.parse((await row(f)).authority_json)).toMatchObject({
    revision: 3,
    observed_at: iso(issued),
    expires_at: iso(issued + 10_000),
    inventory_observed_at: iso(issued),
    inventory_expires_at: iso(issued + 300_000),
    inventory_revision: 3,
    write_allowed: true,
  });
  expect((await row(f)).status).toBe("ready");
  expect(
    (await readCurrentNodeThinStorage(f.local, f.node))!.authority,
  ).toBeNull();
  // The next fast sample renews from that proof.
  const renewed = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, await nonce(f)))).body,
  );
  expect(renewed.authority).toMatchObject({
    revision: 4,
    inventory_revision: 3,
    inventory_observed_at: iso(issued),
  });
  expect(
    (await readCurrentNodeThinStorage(f.local, f.node))!.authority?.revision,
  ).toBe(4);
  // The next lease names the identity proof's revision; fast renewals never overtake it.
  await endLease(f);
  const next = await prepareThinStorageLease(f.local, f.node);
  expect(next!.lease.authority_revision).toBe(3);
  expect(await report(f)).toMatchObject({ accepted: true, revision: 5 });
  expect(JSON.parse((await row(f)).authority_json)).toMatchObject({
    revision: 5,
    inventory_revision: 4,
    inventory_observed_at: next!.lease.issued_at,
  });
});

it("keeps a fast reading taken after the identity lease was issued", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await identityProof(f);
  await prepareThinStorageLease(f.local, f.node);
  const issued = await leaseIssuedAgo(f, 4000);
  const renewed = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, await nonce(f), { physical: used(f, 512 * mib) })))
      .body,
  );
  expect(renewed.authority!.revision).toBe(3);
  // The executor's reading is anchored at its lease's issue, before the sample's nonce.
  expect(await report(f, { physical: used(f, 256 * mib) })).toMatchObject({
    accepted: true,
    revision: 4,
  });
  const stored = NodeThinStorageAuthority.parse(
    JSON.parse((await row(f)).authority_json),
  );
  expect(stored).toMatchObject({
    revision: 4,
    observed_at: renewed.authority!.observed_at,
    expires_at: renewed.authority!.expires_at,
    inventory_observed_at: iso(issued),
    inventory_revision: 3,
  });
  expect(stored.physical.thin_pool!.data_used_bytes_upper_bound).toBe(
    512 * mib,
  );
});

it("recomposes after a real D1 renewal without repeating custody and inventory validation", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await identityProof(f);
  await prepareThinStorageLease(f.local, f.node, false);
  await leaseIssuedAgo(f, 4000);
  const freshNonce = await nonce(f),
    queries: string[] = [];
  let batches = 0;
  // Instrument native D1 calls to schedule an actual authenticated renewal at the CAS boundary.
  // Every SQL statement and response still comes from D1; there are no synthetic database results.
  const db = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          queries.push(sql);
          return target.prepare(sql);
        };
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (++batches === 1)
            expect(
              NodeStorageHeadroomResponse.parse(
                (
                  await post(
                    f,
                    sample(f, freshNonce, { physical: used(f, 512 * mib) }),
                  )
                ).body,
              ).accepted,
            ).toBe(true);
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  expect(await report({ ...f, local: { ...f.local, DB: db } })).toMatchObject({
    accepted: true,
    revision: 4,
    write_allowed: true,
  });
  expect(batches).toBe(2);
  // One input read builds the executor report, one validates it. The retry only reads the node row.
  expect(
    queries.filter((sql) =>
      sql.includes("FROM databases d LEFT JOIN database_start_admissions h"),
    ),
  ).toHaveLength(2);
  expect(
    JSON.parse((await row(f)).authority_json).physical.thin_pool
      .data_used_bytes_upper_bound,
  ).toBe(512 * mib);
});

it("never grants writes from a fresher reading when the identity proof itself has no headroom", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await identityProof(f);
  await prepareThinStorageLease(f.local, f.node, false);
  await leaseIssuedAgo(f, 4000);
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f)))).body,
    ).authority!.write_allowed,
  ).toBe(true);
  const physical = used(f, 2 * gib - 128 * mib);
  expect(await report(f, { physical, write_allowed: false })).toMatchObject({
    accepted: true,
    write_allowed: false,
  });
  expect(await row(f)).toMatchObject({ status: "blocked", error_code: null });
  expect(
    await env.DB.prepare(
      "SELECT inventory_physical_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("inventory_physical_json"),
  ).toBe(JSON.stringify(physical));
});

it("blocks an unconfirmed sampled pool growth that exceeds the identity proof's own pool", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await identityProof(f);
  await prepareThinStorageLease(f.local, f.node, false);
  await leaseIssuedAgo(f, 4000);
  const physical = {
    ...used(f, 2 * gib - 128 * mib),
    free_bytes: f.authority.physical.free_bytes - gib,
    thin_pool: {
      ...used(f, 2 * gib - 128 * mib).thin_pool,
      data_total_bytes: 3 * gib,
    },
  };
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical }))).body,
    ).accepted,
  ).toBe(true);
  await expect(
    report(f, {
      physical: used(f, 2 * gib - 128 * mib),
      write_allowed: false,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await row(f)).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_headroom_inconsistent",
    sample_observed_at: null,
    sample_data_used_bytes: null,
  });
});

it("accepts pool growth with unchanged data when percentage rounding raises the used upper bound", async () => {
  const f = await thinExecutionFixture(releases, {
    guard_seconds: 10,
    initial_data_bytes: 20 * gib,
    growth_bytes: 4 * gib,
  });
  const physical = (size: number, percent: number) => ({
    ...f.authority.physical,
    free_bytes: f.authority.physical.free_bytes - size + 2 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: size,
      data_used_bytes_upper_bound: Math.ceil((size * (percent + 0.01)) / 100),
    },
  });
  const before = physical(20 * gib, 99),
    after = physical(24 * gib, 82.5);
  await identityProof(f, { physical: before });
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical: before }))).body,
    ).accepted,
  ).toBe(true);
  const input = await prepareThinStorageLease(f.local, f.node);
  expect(input!.lease.action).toMatchObject({
    kind: "grow",
    target_data_bytes: 24 * gib,
  });
  await dispatchThinPoolAction(
    f.local,
    f.node,
    input!.lease.action!.nonce,
    f.authority.driver_pod_uid,
    f.qualified.bootId,
  );
  expect(after.thin_pool.data_used_bytes_upper_bound).toBeGreaterThan(
    before.thin_pool.data_used_bytes_upper_bound,
  );
  expect(await report(f, { physical: after })).toMatchObject({
    accepted: true,
    write_allowed: true,
  });
  expect(await row(f)).toMatchObject({ status: "ready", error_code: null });
});

it("blocks a 28 GiB sampled pool when the dispatched growth and final identity proof confirm only 24 GiB", async () => {
  const f = await thinExecutionFixture(releases, {
    guard_seconds: 10,
    initial_data_bytes: 20 * gib,
    growth_bytes: 4 * gib,
  });
  const physical = (size: number) => ({
    ...f.authority.physical,
    free_bytes: f.authority.physical.free_bytes - size + 2 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: size,
      data_used_bytes_upper_bound: Math.ceil(19.8 * gib),
    },
  });
  const before = physical(20 * gib);
  await identityProof(f, { physical: before });
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical: before }))).body,
    ).accepted,
  ).toBe(true);
  const input = await prepareThinStorageLease(f.local, f.node);
  expect(input!.lease.action).toMatchObject({
    kind: "grow",
    target_data_bytes: 24 * gib,
  });
  await leaseIssuedAgo(f, 4000);
  await dispatchThinPoolAction(
    f.local,
    f.node,
    input!.lease.action!.nonce,
    f.authority.driver_pod_uid,
    f.qualified.bootId,
  );
  expect(
    NodeStorageHeadroomResponse.parse(
      (
        await post(
          f,
          sample(f, await nonce(f), { physical: physical(28 * gib) }),
        )
      ).body,
    ).accepted,
  ).toBe(true);
  await expect(
    report(f, { physical: physical(24 * gib) }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await row(f)).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_headroom_inconsistent",
    sample_observed_at: null,
    sample_data_used_bytes: null,
  });
});

it("blocks the node when an identity proof reads more data than the newest earlier sample and its allowance", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await identityProof(f);
  const sampled = async (bytes: number) =>
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical: used(f, bytes) })))
        .body,
    );
  expect((await sampled(64 * mib)).accepted).toBe(true);
  await prepareThinStorageLease(f.local, f.node);
  expect(
    await env.DB.prepare(
      "SELECT lease_sample_data_used_bytes,lease_sample_observed_at=sample_observed_at same FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({ lease_sample_data_used_bytes: 64 * mib, same: 1 });
  // Less used than the sample (a discard) is consistent.
  expect(await report(f, { physical: used(f, 32 * mib) })).toMatchObject({
    accepted: true,
  });
  expect((await sampled(64 * mib)).accepted).toBe(true);
  await prepareThinStorageLease(f.local, f.node);
  // Without a writer or a startup hold nothing could add 1 GiB since the sample.
  await expect(report(f, { physical: used(f, gib) })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await row(f)).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_headroom_inconsistent",
  });
  expect(
    await env.DB.prepare(
      "SELECT lease_id FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("lease_id"),
  ).toBeNull();
});

/** A placed thin database with a bound receipt whose LV the proof below may or may not show. */
async function boundDatabase(f: Fixture) {
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  const created = DatabaseWithOperation.parse(await (await f.create()).json());
  const receipt = DatabaseStorageVolumeReceipt.parse({
    storage_generation: 1,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cluster_uid: crypto.randomUUID(),
    node_uid: f.uid,
    volume_group_uuid: f.authority.volume_group_uuid,
    pool_uuid: f.authority.pool_uuid,
    volume_handle: `pvc-${crypto.randomUUID()}`,
    lv_uuid: "VOLUMX-1234-1234-1234-1234-1234-ABCDEF",
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
  });
  expect(
    (
      await env.DB.prepare(
        "UPDATE databases SET storage_volume_json=? WHERE id=? AND node_id=?",
      )
        .bind(JSON.stringify(receipt), created.database.id, f.node)
        .run()
    ).meta.changes,
  ).toBe(1);
  return { created, receipt, physical };
}

function boundVolumeProof(
  f: Fixture,
  bound: Awaited<ReturnType<typeof boundDatabase>>,
  generation = 1,
) {
  const { created, receipt, physical } = bound;
  return {
    physical,
    physical_lvs: [
      lvs.pool,
      lvs.data,
      lvs.meta,
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    volumes: [
      {
        database_id: created.database.id,
        generation,
        storage_generation: 1,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        volume_handle: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        pvc_uid: receipt.pvc_uid,
        pv_uid: receipt.pv_uid,
        storage_class: thinStorageClass(f.authority.profile_sha256),
        volume_attributes_class: thinStorageClass(f.authority.profile_sha256),
        io: [],
      },
    ],
  };
}

it("refuses a stale database generation during an identity turn without blocking the node", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 }),
    bound = await boundDatabase(f);
  await prepareThinStorageLease(f.local, f.node, false);
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1 WHERE id=?",
  )
    .bind(bound.created.database.id)
    .run();
  await expect(report(f, boundVolumeProof(f, bound))).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await row(f)).toMatchObject({ status: "ready", error_code: null });
  expect(
    await env.DB.prepare(
      "SELECT lease_id FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("lease_id"),
  ).not.toBeNull();
});

it("refuses a stale storage generation during an identity turn without blocking the node", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 }),
    bound = await boundDatabase(f);
  await prepareThinStorageLease(f.local, f.node, false);
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+1,storage_generation=storage_generation+1 WHERE id=?",
  )
    .bind(bound.created.database.id)
    .run();
  await expect(report(f, boundVolumeProof(f, bound))).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await row(f)).toMatchObject({ status: "ready", error_code: null });
});

it("deduplicates two startup holds for the same proved volume during a 95 s identity lease", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 }),
    bound = await boundDatabase(f),
    operation = newOperationId();
  await env.DB.batch([
    env.DB.prepare("UPDATE databases SET generation=2 WHERE id=?").bind(
      bound.created.database.id,
    ),
    env.DB.prepare(
      "UPDATE database_start_admissions SET storage_volume_json=? WHERE operation_id=?",
    ).bind(JSON.stringify(bound.receipt), bound.created.operation.id),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.wake','pending',project_id,database_id,2,created_at,updated_at FROM operations WHERE id=?",
    ).bind(operation, bound.created.operation.id),
    env.DB.prepare(
      "INSERT INTO database_start_admissions(operation_id,database_id,generation,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes,storage_volume_json) SELECT ?,database_id,2,node_id,node_uid,budget_bytes,granted_at,grant_sample_observed_at,storage_budget_bytes,storage_volume_json FROM database_start_admissions WHERE operation_id=?",
    ).bind(operation, bound.created.operation.id),
  ]);
  const proof = boundVolumeProof(f, bound, 2);
  proof.physical.thin_pool.data_total_bytes = 8 * gib;
  await identityProof(f, proof);
  const input = await prepareThinStorageLease(f.local, f.node, false);
  expect(input!.lease.required_data_free_bytes).toBe(5 * gib + 256 * mib);
  await leaseIssuedAgo(f, 30_000);
  expect(await report(f, proof)).toMatchObject({
    accepted: true,
    write_allowed: true,
  });
});

it("confirms a deletion only from an identity read that started after it, never from a fast renewal", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const { created, physical } = await boundDatabase(f);
  const before = Date.now() - 2000;
  await env.DB.prepare("UPDATE databases SET updated_at=? WHERE id=?")
    .bind(iso(before + 1000), created.database.id)
    .run();
  const confirmed = async () =>
    await env.DB.prepare(
      `SELECT ${thinStorageDeletionConfirmedSql("d")} safe FROM databases d WHERE d.id=?`,
    )
      .bind(created.database.id)
      .first("safe");
  // The LV is absent, but the identity read predates the deletion; only the reading is newer.
  await identityProof(f, {
    revision: 3,
    physical,
    observed_at: iso(Date.now()),
    expires_at: iso(Date.now() + 10_000),
    inventory_observed_at: iso(before),
    inventory_expires_at: iso(before + 300_000),
    inventory_revision: 2,
  });
  expect(await confirmed()).toBe(0);
  await identityProof(f, {
    revision: 4,
    physical,
    inventory_revision: 3,
  });
  expect(await confirmed()).toBe(1);
});

it("records a protective stop from an identity proof whose composed authority already expired", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const { created, receipt, physical } = await boundDatabase(f),
    read = Date.now() - 30_000;
  const proof = NodeThinStorageAuthority.parse({
    ...f.authority,
    revision: 3,
    physical,
    observed_at: iso(read),
    captured_at: iso(read),
    expires_at: iso(read + 10_000),
    inventory_observed_at: iso(read),
    inventory_expires_at: iso(read + 300_000),
    inventory_revision: 3,
    write_allowed: false,
    physical_lvs: [
      lvs.pool,
      lvs.data,
      lvs.meta,
      {
        name: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        size_bytes: 5 * gib,
        segtype: "thin",
      },
    ],
    volumes: [
      {
        database_id: created.database.id,
        generation: 1,
        storage_generation: 1,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        volume_handle: receipt.volume_handle,
        lv_uuid: receipt.lv_uuid,
        pvc_uid: receipt.pvc_uid,
        pv_uid: receipt.pv_uid,
        storage_class: thinStorageClass(f.authority.profile_sha256),
        volume_attributes_class: thinStorageClass(f.authority.profile_sha256),
        io: [],
      },
    ],
    protections: [
      {
        database_id: created.database.id,
        generation: 1,
        operation_id: created.operation.id,
        storage_uid: receipt.storage_uid,
        namespace_uid: receipt.namespace_uid,
        cluster_uid: receipt.cluster_uid,
        node_uid: f.uid,
        profile_sha256: f.authority.profile_sha256,
        requested_at: read,
        hibernation_on: true,
        pods_absent: true,
      },
    ],
  });
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=3,authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(JSON.stringify(proof), iso(Date.now()), f.node)
    .run();
  await env.DB.batch(storageProtectionStatements(env.DB, proof));
  expect(
    await env.DB.prepare(
      "SELECT storage_protected_at,storage_protected_operation,observed_power FROM databases WHERE id=?",
    )
      .bind(created.database.id)
      .first(),
  ).toEqual({
    storage_protected_at: iso(read),
    storage_protected_operation: created.operation.id,
    observed_power: "hibernated",
  });
});

it("blocks the node itself when a report is unqualified, never for a report of another lease", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  const lease = await prepareThinStorageLease(f.local, f.node);
  // A report for another lease ends nothing; the executor retries it as a transient refusal.
  await expect(
    report(f, {}, { expected_revision: lease!.lease.revision + 1 }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await row(f)).toMatchObject({ status: "ready", error_code: null });
  await expect(
    report(f, {}, { software: { driver_sha256: "0".repeat(64) } }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await row(f)).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_report_unqualified",
  });
  expect(
    await env.DB.prepare(
      "SELECT lease_id FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first("lease_id"),
  ).toBeNull();
});

it("blocks the node itself when a report's physical identity changed", async () => {
  const f = await thinExecutionFixture(releases, { guard_seconds: 10 });
  await prepareThinStorageLease(f.local, f.node);
  await expect(
    report(f, {}, { system_uuid: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await row(f)).toMatchObject({
    status: "blocked",
    error_code: "thin_storage_report_identity_changed",
  });
});
