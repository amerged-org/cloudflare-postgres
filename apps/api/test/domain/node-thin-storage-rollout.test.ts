// SPDX-License-Identifier: Apache-2.0
// A thin node across a fleet rollout. A rollout moves the release, the assignment and the pool
// policy of the node in one batch, and its patch reaches the node about forty minutes later. The
// host lease keeps permitting the node's databases and the identity turn keeps running.
// Real D1 and AEAD custody fixtures with controlled metadata; no live evidence.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DesiredResponse } from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { HostStorageLease } from "@pgcf/contracts/node-thin-storage";
import { cleanupFixtures, request } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import {
  type AwakeWriter,
  awakeWriter,
  leaseEntry,
} from "./thin-writer-fixture.ts";
import {
  assignRelease,
  extension,
  insertRelease,
  installer,
  kubernetes,
  postgres,
  reordered,
  runtime,
  software,
  startPatch,
} from "./thin-rollout-fixture.ts";
import { identityProof, iso, report, row } from "./thin-proof-fixture.ts";
import { prepareThinStorageLease } from "../../src/domain/node-thin-storage-execution.ts";
import { qualifiedThinStorageSql } from "../../src/domain/node-thin-storage.ts";

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
/** One identity turn of the awake writer's node, as the slow loop runs it under the current assignment. */
async function proven(w: AwakeWriter) {
  expect(await prepareThinStorageLease(w.f.local, w.f.node)).not.toBeNull();
  expect(await report(w.f, w.reading())).toMatchObject({ accepted: true });
}

// A release that pins the same thin facts: the controller, the gateway and the API change.

it("serves the running entry and the proven boot in the host lease during such a rollout", async () => {
  const w = await awake();
  await assignRelease(w.f, releases);
  expect((await lease(w)).boot_id).toBe(w.f.qualified.bootId);
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "running",
    write_blocked: false,
    runtime_authority: null,
  });
});

it("keeps serving the node's storage entry and room while a rollout changes a pinned thin fact", async () => {
  const w = await awake();
  // The last identity proof was read a minute ago: its short write lease has lapsed, its
  // inventory is current.
  const read = Date.now() - 60_000;
  await identityProof(w.f, {
    ...w.reading(),
    observed_at: iso(read),
    captured_at: iso(read),
    expires_at: iso(read + 10_000),
    inventory_observed_at: iso(read),
    inventory_expires_at: iso(read + 300_000),
  });
  await assignRelease(w.f, releases, { change: extension });
  const node = (await desired(w)).region.storage_nodes?.find(
    (entry) => entry.node_id === w.f.node,
  );
  expect(node).toMatchObject({ node_uid: w.f.uid, room: true });
  expect(await leaseEntry(w.f, w.id)).toMatchObject({
    desired_state: "running",
    write_blocked: false,
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
  try {
    const w = await awake();
    await assignRelease(w.f, releases, {
      patch: { stage: "regional", state: "pending" },
    });
    await leaseEntry(w.f, w.id);
    await desired(w);
    await proven(w);
  } finally {
    database.prepare = prepare;
  }
  // The identity turn's lease row among them.
  expect(seen.size).toBeGreaterThanOrEqual(1);
  const deepest: string[] = [];
  for (const sql of seen.values())
    deepest.push(`${await depth(sql)} ${sql.trim().slice(0, 60)}`);
  for (const line of deepest)
    expect(Number(line.split(" ")[0])).toBeLessThanOrEqual(90);
  // A predicate read in a select list (readCurrentNodeThinStorage) is measured on its own.
  expect(
    await depth(
      `SELECT 1 FROM node_thin_storage t WHERE ${qualifiedThinStorageSql("t")}`,
    ),
  ).toBeLessThanOrEqual(60);
});
