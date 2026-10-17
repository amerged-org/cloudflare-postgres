// SPDX-License-Identifier: Apache-2.0
// Thin write authority across a fleet rollout. A rollout moves the release, the assignment and the
// pool policy of the node in one batch, and its patch reaches the node about forty minutes later.
// Authority continues while the facts the thin qualification depends on are the ones the node was
// proven with; every admission and every change of a pinned fact stays behind the assigned release.
// Real D1 and AEAD custody fixtures with controlled metadata; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DesiredResponse } from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  HostStorageLease,
  NodeStorageHeadroomResponse,
} from "@pgcf/contracts/node-thin-storage";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  type AwakeWriter,
  awakeWriter,
  claimsOf,
  leaseEntry,
  renewal,
} from "./parked-tier-fixture.ts";
import {
  addMember,
  assignRelease,
  completePatch,
  extension,
  insertRelease,
  installer,
  kubernetes,
  observeAssignment,
  postgres,
  reordered,
  runtime,
  software,
  startPatch,
} from "./thin-rollout-fixture.ts";
import {
  gib,
  identityProof,
  nonce,
  post,
  report,
  row,
  sample,
} from "./thin-renewal-fixture.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import {
  qualifiedThinStorageSql,
  readCurrentNodeThinStorage,
} from "../../src/domain/node-thin-storage.ts";
import { nodeThinStorageHeadroomSql } from "../../src/domain/storage-capacity.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

const awake = async () => awakeWriter(await thinExecutionFixture(releases));
const desired = async (w: AwakeWriter) =>
  DesiredResponse.parse(
    await (await request("/agent/v1/desired", w.f.agent)).json(),
  );
const lease = async (w: AwakeWriter) =>
  HostStorageLease.parse(
    await (
      await request(`/agent/v1/nodes/${w.f.node}/storage-guard`, w.f.agent)
    ).json(),
  );
const qualification = (w: AwakeWriter) =>
  env.DB.prepare(
    "SELECT qualification_json FROM node_thin_storage WHERE node_id=?",
  )
    .bind(w.f.node)
    .first<string>("qualification_json");
/** Everything the guard and the controller are given for the node, as a pause shows it: the
 * host lease keeps permitting the running writer, no rollout stops it. */
async function paused(w: AwakeWriter, leased = true) {
  expect(await renewal(w)).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_node_unqualified",
    authority: null,
    tokens: [],
  });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "running",
    write_blocked: false,
    runtime_authority: null,
  });
  const page = await desired(w);
  expect(page.region).not.toHaveProperty("storage_samples");
  expect(
    page.region.storage_nodes?.find((entry) => entry.node_id === w.f.node),
  ).toMatchObject({ write_allowed: false });
  expect(
    page.databases.find((database) => database.id === w.id)?.storage_authority,
  ).toBeUndefined();
  if (leased)
    await expect(
      prepareThinStorageLease(w.f.local, w.f.node),
    ).rejects.toThrow();
}

/** One identity turn of the awake writer's node, as the slow loop runs it under the current assignment. */
async function proven(w: AwakeWriter) {
  expect(await prepareThinStorageLease(w.f.local, w.f.node)).not.toBeNull();
  expect(await report(w.f, w.reading())).toMatchObject({ accepted: true });
}

// A release that pins the same thin facts: the controller, the gateway and the API change.

it("keeps accepting samples and renewing tokens while a rollout that pins the same thin facts is pending", async () => {
  const w = await awake(),
    f = w.f;
  let previous = (await renewal(w)).authority!.revision;
  await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  for (let sampled = 0; sampled < 2; sampled++) {
    const response = await renewal(w);
    expect(response.accepted).toBe(true);
    expect(response.authority!.revision).toBe(previous + 1);
    expect(response.authority).toMatchObject({ write_allowed: true });
    expect(
      Date.parse(response.authority!.expires_at) -
        Date.parse(response.authority!.observed_at),
    ).toBeLessThanOrEqual(f.profile.guard_seconds * 1000);
    expect(response.tokens.map((token) => token.database_id)).toEqual([w.id]);
    previous = response.authority!.revision;
  }
  expect((await row(f)).status).toBe("ready");
});

it("keeps the storage_nodes entry, the storage_samples target and the database token in the desired page across the assignment", async () => {
  const w = await awake();
  await renewal(w);
  const before = await desired(w);
  await assignRelease(w.f, releases);
  const after = await desired(w);
  expect(after.region.storage_nodes).toHaveLength(1);
  expect(Object.keys(after.region.storage_nodes![0]!).sort()).toEqual(
    Object.keys(before.region.storage_nodes![0]!).sort(),
  );
  expect(after.region.storage_nodes![0]).toMatchObject({
    node_id: w.f.node,
    write_allowed: true,
    inventory_revision: expect.any(Number),
  });
  expect(after.region.storage_samples).toHaveLength(1);
  expect(
    claimsOf(
      after.databases.find((database) => database.id === w.id)
        ?.storage_authority,
    ),
  ).toMatchObject({ database_id: w.id, write_allowed: true });
});

it("serves the running entry and the proven boot in the host lease during such a rollout", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases);
  expect((await lease(w)).boot_id).toBe(w.f.qualified.bootId);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "running",
    write_blocked: false,
    runtime_authority: null,
  });
});

it("leases and accepts an identity turn under the new assignment, before and after its patch rewrote the host custody", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f);
  const assigned = await assignRelease(f, releases);
  // The node's custody is still sealed under the release it was proven with.
  const input = (await prepareThinStorageLease(f.local, f.node))!;
  expect(input.lease).toMatchObject({
    release_id: assigned.id,
    assignment_revision: assigned.assignment,
    region_revision: assigned.region,
    boot_id: f.qualified.bootId,
  });
  expect(input.host_configuration.status).toMatchObject({
    sha256: f.host.sha256,
    release_id: f.qualified.releaseId,
  });
  expect(await report(f)).toMatchObject({ accepted: true });
  expect(JSON.parse((await row(f)).authority_json)).toMatchObject({
    inventory_observed_at: input.lease.issued_at,
  });
  // Patch creation seals the same content under the new release.
  await startPatch(f, assigned, { stage: "regional", state: "pending" });
  const next = (await prepareThinStorageLease(f.local, f.node))!;
  expect(next.host_configuration.status).toMatchObject({
    sha256: f.host.sha256,
    release_id: assigned.id,
  });
  expect(await report(f)).toMatchObject({ accepted: true });
});

it("keeps authority across two rollouts in a row without a proof between them", async () => {
  const w = await awake(),
    proof = await qualification(w);
  let revision = (await renewal(w)).authority!.revision;
  for (let rollout = 0; rollout < 2; rollout++) {
    await assignRelease(w.f, releases, {
      patch: { stage: "complete", state: "confirmed" },
    });
    const response = await renewal(w);
    expect(response.accepted).toBe(true);
    expect(response.authority!.revision).toBeGreaterThan(revision);
    revision = response.authority!.revision;
  }
  expect(await qualification(w)).toBe(proof);
});

it("keeps authority while the rollout's patch is halted at regional", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, {
    patch: {
      stage: "regional",
      state: "halted",
      error: "fleet_patch_regional_failed",
    },
  });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({ write_blocked: false });
});

it("resumes at once on a rollback to the release the node was proven with while no patch of the other release started", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, { change: extension });
  expect(await renewal(w)).toMatchObject({ accepted: false });
  await assignRelease(w.f, releases, { release: w.f.qualified.releaseId });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({ write_blocked: false });
});

it("pauses a rollback after the patch of a release that changed a pinned fact completed, until the rollback's own patch completed and one proof read it", async () => {
  const w = await awake(),
    f = w.f;
  await renewal(w);
  // B pins another PostgreSQL version; its patch completes and the node is proven under it.
  await assignRelease(f, releases, {
    change: postgres,
    patch: { stage: "complete", state: "confirmed" },
  });
  await proven(w);
  expect(await renewal(w)).toMatchObject({ accepted: true });
  // A again, before A's own patch: the node still runs B's pins.
  const back = await assignRelease(f, releases, {
    release: f.qualified.releaseId,
  });
  await paused(w);
  await startPatch(f, back, { stage: "complete", state: "confirmed" });
  await proven(w);
  expect(await renewal(w)).toMatchObject({ accepted: true });
});

it("pauses a release with the node's facts that follows a superseded halted patch of a pin change, until its own patch completed", async () => {
  const w = await awake(),
    f = w.f;
  await renewal(w);
  await assignRelease(f, releases, {
    change: postgres,
    patch: {
      stage: "platform",
      state: "halted",
      error: "operator_hold_superseded",
    },
  });
  const next = await assignRelease(f, releases, { change: software });
  await paused(w);
  await startPatch(f, next, { stage: "complete", state: "confirmed" });
  expect(await renewal(w)).toMatchObject({ accepted: true });
});

it("does not resume on an identity proof read before a pinned fact changed when the patch that changed it completed", async () => {
  const w = await awake(),
    f = w.f;
  await renewal(w);
  const assigned = await assignRelease(f, releases, { change: kubernetes });
  await paused(w);
  await startPatch(f, assigned, { stage: "complete", state: "confirmed" });
  // The patch completed, but the node's proof is the one read before it.
  expect(await renewal(w)).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_node_unqualified",
  });
  await proven(w);
  expect(await renewal(w)).toMatchObject({ accepted: true });
});

// A release that changes what the node runs or how the guard is configured stays strict from
// the assignment.

it("pauses at the assignment of a release whose receipt names another host extension digest", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases, { change: extension });
  await paused(w);
});

it("pauses at the assignment of a release that changes only the Talos installer", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases, { change: installer });
  await paused(w);
});

it("stops renewing when the host custody is rewritten with other content during a continuing rollout", async () => {
  const w = await awake(),
    f = w.f;
  await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  expect(await renewal(w)).toMatchObject({ accepted: true });
  await env.DB.prepare(
    "UPDATE node_compute_pool_policies SET policy_json=json_set(policy_json,'$.profile.image',?) WHERE node_id=?",
  )
    .bind(`registry.invalid/sandbox@sha256:${"e".repeat(64)}`, f.node)
    .run();
  const rewritten = await ensureNodeHostConfiguration(f.local, {
    node_id: f.node,
    node_uid: f.uid,
  });
  expect(rewritten.sha256).not.toBe(f.host.sha256);
  await paused(w);
});

it("stops renewing once the observed boot id changes", async () => {
  const w = await awake();
  await assignRelease(w.f, releases);
  expect(await renewal(w)).toMatchObject({ accepted: true });
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
  )
    .bind(crypto.randomUUID(), w.f.node)
    .run();
  // The lease evidence is the patch's: the executor itself refuses a turn on another boot.
  await paused(w, false);
});

it("pauses when the patch of a release that changes the host custody halted at host_config", async () => {
  const w = await awake();
  await assignRelease(w.f, releases, {
    change: runtime,
    runtime: true,
    patch: {
      stage: "host_config",
      state: "halted",
      error: "fleet_patch_host_config_failed",
    },
  });
  await paused(w);
});

it("does not extend authority to a replacement node that reuses the node name", async () => {
  const w = await awake();
  await renewal(w);
  await assignRelease(w.f, releases);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), w.f.node)
    .run();
  const page = await desired(w);
  expect(page.region).not.toHaveProperty("storage_samples");
  expect(page.region).not.toHaveProperty("storage_nodes");
  expect(
    page.databases.find((database) => database.id === w.id)?.storage_authority,
  ).toBeUndefined();
  expect(
    (await readCurrentNodeThinStorage(
      w.f.local,
      w.f.node,
      Date.now(),
      "continuing",
    ))!.authority,
  ).toBeNull();
});

it("keeps new placement and wake behind the assignment until its patch completed and one proof read it", async () => {
  const f = await thinExecutionFixture(releases),
    fits = () =>
      env.DB.prepare(
        `SELECT ${nodeThinStorageHeadroomSql()} fits FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
      )
        .bind(f.size, f.node)
        .first<number>("fits");
  // A pool that admits the start of one more database.
  const physical = {
    ...f.authority.physical,
    free_bytes: 80 * gib,
    thin_pool: {
      ...f.authority.physical.thin_pool!,
      data_total_bytes: 16 * gib,
    },
  };
  await identityProof(f, { physical });
  expect(await fits()).toBe(1);
  const assigned = await assignRelease(f, releases);
  // Authority continues; what starts a Pod does not.
  expect(
    NodeStorageHeadroomResponse.parse(
      (await post(f, sample(f, await nonce(f), { physical }))).body,
    ),
  ).toMatchObject({ accepted: true });
  expect(await fits()).toBe(0);
  await startPatch(f, assigned, { stage: "complete", state: "confirmed" });
  await observeAssignment(f);
  expect(await fits()).toBe(0);
  expect(await prepareThinStorageLease(f.local, f.node)).not.toBeNull();
  expect(await report(f, { physical })).toMatchObject({ accepted: true });
  expect(await fits()).toBe(1);
});

// The wire gate: the strict desired schema is served to a controller that parses it.

it("exposes the sampling wire only when the latest completed patch of every member declares the protocol", async () => {
  const w = await awake(),
    f = w.f,
    current = { id: f.qualified.releaseId, sha: f.qualified.specSha },
    member = await addMember(f, current),
    served = async () => {
      const page = await desired(w);
      return page.region.storage_samples?.length === 1;
    };
  expect(await served()).toBe(true);
  // The target declares the protocol and its patch is pending; the members are patched at v1.
  const next = await assignRelease(f, releases, {
    patch: { stage: "regional", state: "pending" },
  });
  expect(await served()).toBe(true);
  // A member whose latest completed patch is of a release without the protocol is not capable,
  // although it once completed a patch at one that declares it and the target declares it.
  const legacy = await insertRelease(releases, {
    ...f.qualified.spec,
    thin_storage_sampling_version: undefined,
  } as FleetReleaseSpec);
  await completePatch(f, member.id, member.uid, legacy, 1, 1);
  expect(await served()).toBe(false);
  expect((await post(f, sample(f, null))).status).toBe(404);
  // The member's next completed patch is at a release that declares it again.
  await completePatch(f, member.id, member.uid, next, 1, next.region);
  expect(await served()).toBe(true);
  // A patch of a release without it that halted after its controller was installed and was
  // superseded never completed, but its controller may run: the wire closes until a patch
  // of a release that declares it completes.
  await completePatch(f, member.id, member.uid, legacy, 1, next.region, {
    stage: "regional",
    state: "halted",
    error: "operator_hold_superseded",
  });
  expect(await served()).toBe(false);
  await completePatch(f, member.id, member.uid, next, 1, next.region);
  expect(await served()).toBe(true);
});

// What the continuity facts compare.

it("stores, once per release, the receipt, the OS blocks, the keys and the pins, and nothing a controller, gateway or API release changes", async () => {
  const f = await thinExecutionFixture(releases),
    text = async (spec: FleetReleaseSpec) =>
      env.DB.prepare(
        "SELECT thin_continuity text FROM fleet_releases WHERE id=?",
      )
        .bind((await insertRelease(releases, spec)).id)
        .first<string>("text"),
    base = await text(f.qualified.spec);
  expect(base).toEqual(expect.any(String));
  expect(await text(software(f.qualified.spec))).toBe(base);
  expect(await text(reordered(f.qualified.spec))).toBe(base);
  for (const change of [
    extension,
    installer,
    kubernetes,
    postgres,
    runtime,
    (spec: FleetReleaseSpec) => ({
      ...spec,
      configuration_schema_revision: spec.configuration_schema_revision + 1,
    }),
    (spec: FleetReleaseSpec) => ({
      ...spec,
      storage_authority_keys_sha256: "1".repeat(64),
    }),
  ])
    expect(await text(change(f.qualified.spec) as FleetReleaseSpec)).not.toBe(
      base,
    );
  // The other role's block counts too: a role change cannot hide a changed fact.
  expect(
    await text({
      ...f.qualified.spec,
      roles: {
        ...f.qualified.spec.roles,
        control_relay: {
          ...f.qualified.spec.roles.control_relay,
          kubernetes_version: "1.36.9",
        },
      },
    }),
  ).not.toBe(base);
});

it("backfills the stored facts of releases that existed before the migration to what the insert trigger computes", async () => {
  const f = await thinExecutionFixture(releases),
    stored = () =>
      env.DB.prepare(
        "SELECT thin_continuity,thin_sampling_version FROM fleet_releases WHERE id=?",
      )
        .bind(f.qualified.releaseId)
        .first(),
    before = await stored(),
    migration = (
      env as unknown as {
        TEST_MIGRATIONS: { name: string; queries: string[] }[];
      }
    ).TEST_MIGRATIONS.find((value) => value.name.includes("thin_facts"))!;
  expect(before).toMatchObject({ thin_sampling_version: 1 });
  await env.DB.prepare(
    "UPDATE fleet_releases SET thin_continuity=NULL,thin_sampling_version=NULL WHERE id=?",
  )
    .bind(f.qualified.releaseId)
    .run();
  // The migration's last statement is the backfill.
  await env.DB.prepare(migration.queries.at(-1)!).run();
  expect(await stored()).toEqual(before);
});

// SQLite refuses an expression tree deeper than 100 levels, and every nested subquery costs more
// than its own conditions: measure the statements the product runs against a margin.

/** `sql` with `levels` more on the deepest WHERE of each of its arms. */
function deeper(sql: string, levels: number) {
  const more = " AND 1".repeat(levels),
    tail = /\s+(?:ORDER BY [^()]*|LIMIT \d+)\s*$/i.exec(sql),
    body = tail ? sql.slice(0, tail.index) : sql;
  return (
    body.replace(/\s+UNION ALL\s+/gi, `${more} UNION ALL `) +
    more +
    (tail ? tail[0] : "")
  );
}
/** The depth of the deepest WHERE of `sql`, by the most levels D1 still accepts on top of it. */
async function depth(sql: string) {
  const refused = async (levels: number) => {
    try {
      await env.DB.prepare(`EXPLAIN ${deeper(sql, levels)}`).all();
      return false;
    } catch (error) {
      // Nothing is bound: a statement that parsed is refused only for its bindings.
      return /too large/.test(String(error));
    }
  };
  let accepted = 0,
    limit = 99;
  while (accepted < limit) {
    const middle = Math.ceil((accepted + limit) / 2);
    if (await refused(middle)) limit = middle - 1;
    else accepted = middle;
  }
  return 100 - accepted;
}

it("keeps every statement that embeds the thin predicates at most 90 levels deep", async () => {
  const seen = new Map<string, string>(),
    database = Object.getPrototypeOf(env.DB) as D1Database,
    prepare = database.prepare;
  database.prepare = function (this: D1Database, sql: string) {
    if (/qverifier|thin_continuity|thin_sampling_version/.test(sql))
      seen.set(sql, sql);
    return prepare.call(this, sql);
  };
  const fits = (f: { size: string; node: string }) =>
    env.DB.prepare(
      `SELECT ${nodeThinStorageHeadroomSql()} fits FROM nodes n JOIN size_classes s ON s.id=? WHERE n.id=?`,
    )
      .bind(f.size, f.node)
      .first();
  try {
    const w = await awake();
    await renewal(w);
    await assignRelease(w.f, releases, {
      patch: { stage: "regional", state: "pending" },
    });
    await renewal(w);
    await leaseEntry(w.f, w.id);
    await desired(w);
    await proven(w);
    await fits(w.f);
  } finally {
    database.prepare = prepare;
  }
  // The sample's compare-and-set, the sampling targets, the wire gate and the lease row among them.
  expect(seen.size).toBeGreaterThanOrEqual(6);
  const deepest: string[] = [];
  for (const sql of seen.values())
    deepest.push(`${await depth(sql)} ${sql.trim().slice(0, 60)}`);
  for (const line of deepest)
    expect(Number(line.split(" ")[0])).toBeLessThanOrEqual(90);
  // A predicate read in a select list (readCurrentNodeThinStorage) is measured on its own.
  for (const mode of ["strict", "continuing"] as const)
    expect(
      await depth(
        `SELECT 1 FROM node_thin_storage t WHERE ${qualifiedThinStorageSql("t", mode)}`,
      ),
    ).toBeLessThanOrEqual(60);
});
