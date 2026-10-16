// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DatabaseWithOperation,
  DesiredResponse,
  StorageWriteClaims,
  base64urlToBytes,
  thinStorageClass,
} from "@pgcf/contracts";
import { NodeStorageHeadroomResponse } from "@pgcf/contracts/node-thin-storage";
import * as samplesDomain from "../../src/domain/node-thin-storage-samples.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  gib,
  identityProof,
  iso,
  lvs,
  mib,
  nonce,
  post,
  row,
  sample,
  turnRequested,
} from "./thin-renewal-fixture.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
function sampleLogger() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
async function authorityReceipt(nodeId: string) {
  return env.DB.prepare(
    "SELECT authority_received_at FROM node_thin_storage WHERE node_id=?",
  )
    .bind(nodeId)
    .first<string>("authority_received_at");
}
function acceptedObservations(
  log: ReturnType<typeof sampleLogger>,
  nodeId: string,
) {
  return log.mock.calls.flatMap(([value]) => {
    if (typeof value !== "string") return [];
    const event = JSON.parse(value) as Record<string, unknown>;
    return event.event === "thin_storage_sample_accepted" &&
      event.node_id === nodeId
      ? [event]
      : [];
  });
}
it("observes only a confirmed product CAS with CF clocks and selected SQL metadata", async () => {
  const f = await thinExecutionFixture(releases),
    proof = await identityProof(f),
    log = sampleLogger();
  const first = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, null))).body,
  );
  expect(acceptedObservations(log, f.node)).toHaveLength(0);
  const issued = await row(f),
    supplied = sample(f, first.nonce),
    accepted = NodeStorageHeadroomResponse.parse(
      (await post(f, supplied)).body,
    ),
    receipt = await authorityReceipt(f.node),
    events = acceptedObservations(log, f.node);
  expect(accepted.accepted).toBe(true);
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(Object.keys(event).sort()).toEqual([
    "authority_expires_at",
    "authority_received_at",
    "authority_revision",
    "d1_update_sql_milliseconds",
    "d1_update_sql_timing_scope",
    "d1_update_sql_timing_source",
    "d1_update_total_attempts",
    "event",
    "handler_ms",
    "node_id",
    "node_uid",
    "period_milliseconds",
    "sample_observed_at",
    "scrape_milliseconds",
    "write_allowed",
  ]);
  const serialized = JSON.stringify(event);
  for (const secret of [
    f.agent,
    first.nonce,
    accepted.nonce,
    ...accepted.tokens.map((entry) => entry.token),
  ])
    expect(serialized.includes(secret)).toBe(false);
  expect(event).toMatchObject({
    event: "thin_storage_sample_accepted",
    node_id: f.node,
    node_uid: f.uid,
    authority_revision: proof.revision + 1,
    sample_observed_at: issued.sample_nonce_issued_at,
    authority_received_at: receipt,
    authority_expires_at: accepted.authority!.expires_at,
    period_milliseconds: f.profile.guard_seconds * 200,
    scrape_milliseconds: supplied.scrape_milliseconds,
    write_allowed: true,
    d1_update_sql_timing_scope: "last_attempt",
  });
  expect(["meta.duration", "meta.timings.sql_duration_ms"]).toContain(
    event.d1_update_sql_timing_source,
  );
  // The handler's own time: at least what the update took, never negative, a whole number.
  expect(Number.isInteger(event.handler_ms)).toBe(true);
  expect(Number(event.handler_ms)).toBeGreaterThanOrEqual(0);
  expect(typeof event.d1_update_sql_milliseconds).toBe("number");
  expect(Number.isFinite(event.d1_update_sql_milliseconds)).toBe(true);
  expect(Number(event.d1_update_sql_milliseconds)).toBeGreaterThanOrEqual(0);
  expect(
    event.d1_update_total_attempts === null ||
      (Number.isSafeInteger(event.d1_update_total_attempts) &&
        Number(event.d1_update_total_attempts) > 0),
  ).toBe(true);
  expect(
    NodeStorageHeadroomResponse.parse((await post(f, supplied)).body).accepted,
  ).toBe(false);
  expect(acceptedObservations(log, f.node)).toHaveLength(1);
  await env.DB.prepare(
    "UPDATE node_thin_storage SET sample_nonce_issued_at=? WHERE node_id=?",
  )
    .bind(iso(Date.now() - f.profile.guard_seconds * 500 - 1000), f.node)
    .run();
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, accepted.nonce))).body,
    ).accepted,
  ).toBe(false);
  expect(acceptedObservations(log, f.node)).toHaveLength(1);
});

it("emits no accepted product observation for a real zero-change SQLite CAS", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const current = await nonce(f),
    before = await row(f),
    receipt = await authorityReceipt(f.node),
    log = sampleLogger(),
    trigger = `ignore_thin_sample_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE OF authority_json ON node_thin_storage WHEN NEW.node_id='${f.node}' BEGIN SELECT RAISE(IGNORE); END`,
  );
  try {
    const result = await post(f, sample(f, current));
    expect(result.status).toBe(200);
    expect(NodeStorageHeadroomResponse.parse(result.body)).toMatchObject({
      accepted: false,
      reason: "thin_storage_sample_conflict",
    });
    const stored = await row(f);
    expect(stored.authority_revision).toBe(before.authority_revision);
    expect(stored.authority_json).toBe(before.authority_json);
    expect(await authorityReceipt(f.node)).toBe(receipt);
    expect(acceptedObservations(log, f.node)).toHaveLength(0);
  } finally {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  }
});

it("emits no accepted product observation for a real failed SQLite write", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const current = await nonce(f),
    before = await row(f),
    log = sampleLogger(),
    trigger = `abort_thin_sample_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.exec(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE OF authority_json ON node_thin_storage WHEN NEW.node_id='${f.node}' BEGIN SELECT RAISE(ABORT,'fixture_thin_sample_write_failed'); END`,
  );
  try {
    expect((await post(f, sample(f, current))).status).toBe(500);
    expect(await row(f)).toEqual(before);
    expect(acceptedObservations(log, f.node)).toHaveLength(0);
  } finally {
    await env.DB.exec(`DROP TRIGGER ${trigger}`);
  }
});

it("projects actual D1 SQL timing and keeps missing or invalid metrics null", async () => {
  const result = await env.DB.prepare("SELECT 1").run();
  const projected = samplesDomain.thinStorageSampleSqlTiming(result.meta);
  const expected = result.meta.timings?.sql_duration_ms ?? result.meta.duration;
  expect(projected.milliseconds).toBe(expected);
  expect(projected.source).toBe(
    result.meta.timings ? "meta.timings.sql_duration_ms" : "meta.duration",
  );
  expect(projected.milliseconds).toBeGreaterThanOrEqual(0);
  expect(samplesDomain.thinStorageSampleSqlTiming({})).toEqual({
    milliseconds: null,
    source: null,
    attempts: null,
  });
  expect(
    samplesDomain.thinStorageSampleSqlTiming({
      duration: Number.NaN,
      timings: { sql_duration_ms: -1 },
      total_attempts: Infinity,
    }),
  ).toEqual({ milliseconds: null, source: null, attempts: null });
  expect(
    samplesDomain.thinStorageSampleSqlTiming({
      duration: "private_sql_duration",
      timings: { sql_duration_ms: true },
      total_attempts: 0,
    }),
  ).toEqual({ milliseconds: null, source: null, attempts: null });
  expect(
    samplesDomain.thinStorageSampleSqlTiming({
      duration: 0,
      total_attempts: 2,
    }),
  ).toEqual({ milliseconds: 0, source: "meta.duration", attempts: 2 });
});
it("rejects a stale qualification context before issuing a product nonce or renewing authority", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const before = await row(f),
    stale = (await env.DB.prepare(
      "SELECT id FROM thin_storage_qualification_runs WHERE node_id=? AND status='completed'",
    )
      .bind(f.node)
      .first<string>("id"))!;
  expect(stale).toMatch(/^op_/);
  const refused = await post(f, {
    ...sample(f, null),
    qualification_run: stale,
  });
  expect(refused.status).toBe(409);
  expect(await row(f)).toEqual(before);
  expect(await turnRequested(f)).toBe(false);
  const current = await nonce(f),
    held = await row(f);
  expect(
    (await post(f, { ...sample(f, current), qualification_run: stale })).status,
  ).toBe(409);
  expect(await row(f)).toEqual(held);
  expect(
    (await post(f, { ...sample(f, current), qualification_run: null })).status,
  ).toBe(200);
});
it("hands out a Cloudflare nonce and renews once against it, anchored at its issue", async () => {
  const f = await thinExecutionFixture(releases),
    proof = await identityProof(f);
  const first = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, null))).body,
  );
  expect(first).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_nonce_invalid",
    period_milliseconds: f.profile.guard_seconds * 200,
    authority: null,
    tokens: [],
  });
  const issued = await row(f);
  expect(issued).toMatchObject({
    sample_nonce: first.nonce,
    authority_revision: proof.revision,
  });
  // A missing nonce is the normal start; it asks for no identity turn.
  expect(await turnRequested(f)).toBe(false);

  const renewed = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, first.nonce))).body,
  );
  const observed = Date.parse(issued.sample_nonce_issued_at!);
  expect(renewed.accepted).toBe(true);
  expect(renewed.nonce).not.toBe(first.nonce);
  expect(renewed.authority).toMatchObject({
    revision: proof.revision + 1,
    observed_at: iso(observed),
    expires_at: iso(observed + f.profile.guard_seconds * 1000),
    write_allowed: true,
    inventory_observed_at: proof.inventory_observed_at,
    inventory_expires_at: proof.inventory_expires_at,
    inventory_revision: proof.inventory_revision,
    physical_lvs: proof.physical_lvs,
    driver_pod_uid: proof.driver_pod_uid,
  });
  expect(
    renewed.authority!.physical.thin_pool!.data_used_bytes_upper_bound,
  ).toBe(64 * mib);
  const stored = await row(f);
  expect(JSON.parse(stored.authority_json)).toEqual(renewed.authority);
  expect(stored).toMatchObject({
    authority_revision: proof.revision + 1,
    status: "ready",
    sample_nonce: renewed.nonce,
    sample_observed_at: iso(observed),
    sample_data_used_bytes: 64 * mib,
  });

  // The nonce is used once.
  const replay = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, first.nonce))).body,
  );
  expect(replay).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_nonce_invalid",
  });
  expect((await row(f)).authority_revision).toBe(proof.revision + 1);
  // A nonce older than guard/2 at receipt renews nothing.
  await env.DB.prepare(
    "UPDATE node_thin_storage SET sample_nonce_issued_at=? WHERE node_id=?",
  )
    .bind(iso(Date.now() - f.profile.guard_seconds * 500 - 1000), f.node)
    .run();
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, replay.nonce))).body,
    ),
  ).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_nonce_invalid",
  });
  expect((await row(f)).authority_revision).toBe(proof.revision + 1);
});

it("never renews beyond the identity proof", async () => {
  const f = await thinExecutionFixture(releases),
    now = Date.now();
  const proof = await identityProof(f, {
    expires_at: iso(now + 50_000),
    inventory_observed_at: iso(now - 250_000),
    inventory_expires_at: iso(now + 50_000),
  });
  const renewed = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, await nonce(f)))).body,
  );
  expect(renewed.authority!.expires_at).toBe(proof.inventory_expires_at);
  // An expired identity proof renews nothing and asks for a slow turn at once.
  await identityProof(f, {
    revision: 4,
    inventory_revision: 4,
    observed_at: iso(now - 290_000),
    captured_at: iso(now - 290_000),
    expires_at: iso(now - 289_000),
    inventory_observed_at: iso(now - 301_000),
    inventory_expires_at: iso(now - 1000),
  });
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, renewed.nonce))).body,
    ),
  ).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_identity_unavailable",
  });
  expect((await row(f)).authority_revision).toBe(4);
  expect(await turnRequested(f)).toBe(true);
});

it("refuses a sample its witnesses, pool or volumes do not bind to the identity proof", async () => {
  const f = await thinExecutionFixture(releases),
    proof = await identityProof(f);
  let current = await nonce(f);
  const refused = async (overrides: object, reason: string) => {
    const response = NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, current, overrides))).body,
    );
    expect(response, JSON.stringify(overrides)).toMatchObject({
      accepted: false,
      reason,
      authority: null,
      tokens: [],
    });
    current = response.nonce;
  };
  const witnesses = sample(f, current).witnesses;
  for (const changed of [
    { boot_id: crypto.randomUUID() },
    { driver_pod_uid: crypto.randomUUID() },
    { cluster_uid: crypto.randomUUID() },
    { driver_image: `registry.invalid/other@sha256:${"c".repeat(64)}` },
  ])
    await refused(
      { witnesses: { ...witnesses, ...changed } },
      "thin_storage_sample_witness_changed",
    );
  await refused(
    { node_uid: crypto.randomUUID() },
    "thin_storage_sample_witness_changed",
  );
  const pool = sample(f, current).physical;
  await refused(
    {
      physical: {
        ...pool,
        thin_pool: { ...pool.thin_pool, metadata_total_bytes: 64 * mib },
      },
    },
    "thin_storage_sample_pool_changed",
  );
  await refused(
    {
      physical: {
        ...pool,
        thin_pool: {
          ...pool.thin_pool,
          data_total_bytes: gib,
          data_used_bytes_upper_bound: 0,
        },
      },
    },
    "thin_storage_sample_pool_changed",
  );
  await refused(
    { physical: { ...pool, thin_pool: null } },
    "thin_storage_sample_pool_changed",
  );
  // A linear LV the identity proof never read, or a new thin LV without a startup hold.
  const base = sample(f, current).lvs;
  for (const lv of [
    { name: "pvc-unknown", segtype: "linear", size_bytes: gib },
    { name: "pvc-new", segtype: "thin", size_bytes: gib },
    { name: "pgcf_thinpool", segtype: "linear", size_bytes: gib },
  ])
    await refused(
      {
        lvs: [...base.filter((v) => v.name !== lv.name), lv],
        lv_count: lv.name === "pgcf_thinpool" ? 1 : 2,
      },
      "thin_storage_sample_volumes_changed",
    );
  expect((await row(f)).authority_revision).toBe(proof.revision);
  expect(await turnRequested(f)).toBe(true);
  // A matching sample still renews.
  expect(
    NodeStorageHeadroomResponse.parse((await post(f, sample(f, current))).body)
      .accepted,
  ).toBe(true);
});

it("decides write_allowed on the fresh reading with today's headroom rule and asks for growth", async () => {
  const f = await thinExecutionFixture(releases),
    proof = await identityProof(f),
    log = sampleLogger();
  const pool = sample(f, null).physical;
  // 64 MiB free is below the 256 MiB data reserve; the 2 GiB pool can still grow to 32 GiB.
  const full = NodeStorageHeadroomResponse.parse(
    (
      await post(
        f,
        sample(f, await nonce(f), {
          physical: {
            ...pool,
            thin_pool: {
              ...pool.thin_pool,
              data_used_bytes_upper_bound: 2 * gib - 64 * mib,
            },
          },
        }),
      )
    ).body,
  );
  expect(full.accepted).toBe(true);
  expect(full.authority).toMatchObject({
    revision: proof.revision + 1,
    write_allowed: false,
  });
  expect(full.tokens).toEqual([]);
  expect((await row(f)).status).toBe("blocked");
  expect(
    acceptedObservations(log, f.node).map((event) => event.write_allowed),
  ).toEqual([false]);
  expect(await turnRequested(f)).toBe(true);
  // The larger pool after growth renews with writes allowed again.
  const grown = NodeStorageHeadroomResponse.parse(
    (
      await post(
        f,
        sample(f, full.nonce, {
          physical: {
            ...pool,
            free_bytes: pool.free_bytes - 2 * gib,
            thin_pool: {
              ...pool.thin_pool,
              data_total_bytes: 4 * gib,
              data_used_bytes_upper_bound: 2 * gib - 64 * mib,
            },
          },
          lvs: [
            {
              name: "pgcf_thinpool",
              segtype: "thin-pool",
              size_bytes: 4 * gib,
            },
          ],
        }),
      )
    ).body,
  );
  expect(grown.authority).toMatchObject({
    revision: proof.revision + 2,
    write_allowed: true,
  });
  expect((await row(f)).status).toBe("ready");
  expect(
    acceptedObservations(log, f.node).map((event) => event.write_allowed),
  ).toEqual([false, true]);
});

it("returns the renewed token of every thin database on the node", async () => {
  const f = await thinExecutionFixture(releases),
    log = sampleLogger();
  // A 16 GiB pool admits the 5 GiB startup hold of one new database.
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  const created = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
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
        .bind(JSON.stringify(receipt), created.id, f.node)
        .run()
    ).meta.changes,
  ).toBe(1);
  const pod = crypto.randomUUID();
  const proof = await identityProof(f, {
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
    active_lv_uuids: [receipt.lv_uuid],
    volumes: [
      {
        database_id: created.id,
        generation: created.generation,
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
        io: [
          {
            pod_uid: pod,
            write_bytes_per_second: f.profile.write_bytes_per_second,
            write_iops_per_second: f.profile.write_iops_per_second,
          },
        ],
      },
    ],
  });
  const renewed = NodeStorageHeadroomResponse.parse(
    (
      await post(
        f,
        sample(f, await nonce(f), {
          physical: {
            ...physical,
            thin_pool: {
              ...physical.thin_pool,
              data_used_bytes_upper_bound: gib,
              metadata_used_bytes_upper_bound: mib,
            },
          },
          lvs: [
            {
              name: "pgcf_thinpool",
              segtype: "thin-pool",
              size_bytes: 16 * gib,
            },
            {
              name: receipt.volume_handle,
              segtype: "thin",
              size_bytes: 5 * gib,
            },
          ],
          lv_count: 2,
        }),
      )
    ).body,
  );
  expect(renewed.accepted).toBe(true);
  expect(renewed.tokens).toHaveLength(1);
  expect(renewed.tokens[0]!.database_id).toBe(created.id);
  const observations = acceptedObservations(log, f.node);
  expect(observations).toHaveLength(1);
  const serialized = JSON.stringify(observations[0]);
  expect(serialized.includes(renewed.tokens[0]!.token)).toBe(false);
  expect(serialized.includes(renewed.nonce)).toBe(false);
  expect(serialized.includes(f.agent)).toBe(false);
  const claims = StorageWriteClaims.parse(
    JSON.parse(
      new TextDecoder().decode(
        base64urlToBytes(renewed.tokens[0]!.token.split(".")[1]!)!,
      ),
    ),
  );
  expect(claims).toMatchObject({
    database_id: created.id,
    authority_revision: proof.revision + 1,
    pod_uid: pod,
    lv_uuid: receipt.lv_uuid,
    observed_at: Date.parse(renewed.authority!.observed_at),
    exp: Date.parse(renewed.authority!.expires_at),
    write_allowed: true,
  });
});

it("names each sampled thin node in the desired region and nothing for regions without thin storage", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(desired.region.storage_samples).toEqual([
    {
      node_id: f.node,
      name: f.nodeName,
      node_uid: f.uid,
      period_milliseconds: f.profile.guard_seconds * 200,
      qualification_run: null,
    },
  ]);
  // A hard-blocked node is not sampled.
  await env.DB.prepare(
    "UPDATE node_thin_storage SET status='blocked',error_code='thin_storage_driver_unqualified' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  expect(
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).region,
  ).not.toHaveProperty("storage_samples");
  const thick = await fixture();
  const region = (await (
    await request("/agent/v1/desired", thick.agent)
  ).json()) as { region: Record<string, unknown> };
  expect(region.region).not.toHaveProperty("storage_samples");
  expect(region.region).not.toHaveProperty("storage_nodes");
});

it("keeps desired wire compatible until every sampling-controller patch is confirmed", async () => {
  const f = await thinExecutionFixture(releases, {}, false);
  await identityProof(f);
  const desired = async () =>
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    );
  // An old release must never expose fields its strict controller schema cannot parse.
  const old = await desired();
  expect(old.region).not.toHaveProperty("storage_samples");
  // Dropping inventory fields would misrepresent a pre-delete read as a fresh reclamation proof.
  expect(old.region).not.toHaveProperty("storage_nodes");
  const modern = await thinExecutionFixture(releases);
  await identityProof(modern);
  const pendingNonce = await nonce(modern);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='pending',stage='release_verify' WHERE node_id=?",
  )
    .bind(modern.node)
    .run();
  expect(
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", modern.agent)).json(),
    ).region,
  ).not.toHaveProperty("storage_samples");
  expect((await post(modern, sample(modern, pendingNonce))).status).toBe(404);
  expect((await row(modern)).authority_revision).toBe(2);
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='confirmed',stage='complete' WHERE node_id=?",
  )
    .bind(modern.node)
    .run();
  const capable = DesiredResponse.parse(
    await (await request("/agent/v1/desired", modern.agent)).json(),
  );
  expect(capable.region.storage_samples).toHaveLength(1);
  expect(capable.region.storage_nodes![0]).toHaveProperty(
    "inventory_revision",
    2,
  );
  expect(capable.fleet_release!.release.spec).not.toHaveProperty(
    "thin_storage_sampling_version",
  );
});
it("refuses sample metadata geometry that contradicts the identity proof", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f, {
    write_allowed: false,
    physical: {
      ...f.authority.physical,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        metadata_total_bytes: 256 * mib,
      },
    },
  });
  const renewed = NodeStorageHeadroomResponse.parse(
    (await post(f, sample(f, await nonce(f)))).body,
  );
  expect(renewed).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_pool_changed",
    authority: null,
    tokens: [],
  });
});
it("authenticates the region agent and samples only selected thin nodes of its region", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  expect((await post(f, sample(f, null), f.integrator)).status).toBe(401);
  expect((await post(f, sample(f, null), f.foreignAgent)).status).toBe(404);
  expect((await post(f, { ...sample(f, null), lv_count: 2 })).status).toBe(400);
  const thick = await fixture();
  const response = await request(
    `/agent/v1/nodes/${thick.node}/storage-headroom`,
    thick.agent,
    "POST",
    sample(f, null),
  );
  expect(response.status).toBe(404);
});

it("migration 0046 leaves existing selections unsampled and stores only paired 128-bit nonces", async () => {
  const f = await thinExecutionFixture(releases),
    at = iso(Date.now());
  expect(
    await env.DB.prepare(
      "SELECT sample_nonce,sample_nonce_issued_at,sample_observed_at,sample_data_used_bytes FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    sample_nonce: null,
    sample_nonce_issued_at: null,
    sample_observed_at: null,
    sample_data_used_bytes: null,
  });
  const update = (sql: string, ...values: unknown[]) =>
    env.DB.prepare(`UPDATE node_thin_storage SET ${sql} WHERE node_id=?`)
      .bind(...values, f.node)
      .run();
  for (const [nonce, issued] of [
    ["0123456789ABCDEF0123456789abcdef", at],
    ["0123456789abcdef", at],
    ["0123456789abcdef0123456789abcdef", null],
    [null, at],
  ])
    await expect(
      update("sample_nonce=?,sample_nonce_issued_at=?", nonce, issued),
    ).rejects.toThrow(/CHECK/);
  await expect(
    update("sample_observed_at=?,sample_data_used_bytes=NULL", at),
  ).rejects.toThrow(/CHECK/);
  await update(
    "sample_nonce=?,sample_nonce_issued_at=?,sample_observed_at=?,sample_data_used_bytes=0",
    "0123456789abcdef0123456789abcdef",
    at,
    at,
  );
});
