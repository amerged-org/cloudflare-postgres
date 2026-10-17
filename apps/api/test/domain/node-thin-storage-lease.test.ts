// SPDX-License-Identifier: Apache-2.0
// What the host guard's lease names for one thin node, and what it costs. Real D1 harness with
// controlled metadata; the live latency of the endpoint is measured on Dev, not here.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { NodeStorageHeadroomResponse } from "@pgcf/contracts/node-thin-storage";
import { countStatements } from "./d1-statements.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { thinLeaseNode } from "./thin-lease-fixture.ts";
import { gib, mib, nonce, post, row, sample } from "./thin-renewal-fixture.ts";
import {
  HOST_LEASE_TOMBSTONE_RETENTION_MS,
  runningWriterTokens,
} from "../../src/domain/node-thin-storage.ts";
import type { Env } from "../../src/env.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

/** The operation a database's archive path was created by: one stable id per database. */
const creation = (archive: string) => archive.slice(-23);
async function archiveOf(id: string) {
  return (await env.DB.prepare("SELECT archive_path FROM databases WHERE id=?")
    .bind(id)
    .first<string>("archive_path"))!;
}
async function generationOf(id: string) {
  return (await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
    .bind(id)
    .first<number>("generation"))!;
}

it("permits every live thin database of the node through its startup window, never by a token or a block", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  const live = await node.add({ kind: "live" }),
    blocked = await node.add({ kind: "blocked" }),
    parked = await node.add({ kind: "parked" }),
    stopping = await node.add({ kind: "stopping" }),
    open = await node.add({ kind: "deleted", confirmed: false }),
    reclaimed = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: 5 * 60_000,
    });
  await node.commit();
  const lease = await node.lease(),
    entries = new Map(
      lease.databases.map((entry) => [entry.database_id, entry]),
    );

  expect(lease.legacy).toEqual([]);
  expect([...entries.keys()].sort()).toEqual(
    [
      node.held.id,
      live.id,
      blocked.id,
      parked.id,
      stopping.id,
      open.id,
      reclaimed.id,
    ].sort(),
  );
  // Awake, asleep, parked, stopping or without an evidenced Pod: one shape. The generation is one
  // past D1's, above every signed token's, so the guard resumes a retained scope once and carries
  // no token forward; the creation operation stays the same across every wake.
  for (const member of [
    { id: node.held.id, receipt: null },
    live,
    blocked,
    parked,
    stopping,
  ]) {
    expect(entries.get(member.id), member.id).toEqual({
      database_id: member.id,
      generation: (await generationOf(member.id)) + 1,
      authority_revision: expect.any(Number),
      write_blocked: false,
      desired_state: "running",
      node_uid: node.f.uid,
      volume_group_uuid: node.f.authority.volume_group_uuid,
      pool_uuid: node.f.authority.pool_uuid,
      profile_sha256: node.f.authority.profile_sha256,
      startup_expires_at: lease.expires_at,
      startup_operation_id: creation(await archiveOf(member.id)),
      volume: member.receipt,
      runtime_authority: null,
      drain: null,
    });
  }
  // A deletion whose absence is not read yet keeps its volume and blocks writes; one the node's
  // fresh read found absent says so explicitly, and the guard may forget its scope.
  expect(entries.get(open.id)).toMatchObject({
    desired_state: "deleted",
    write_blocked: true,
    volume: open.receipt,
    runtime_authority: null,
    startup_operation_id: null,
    drain: null,
  });
  expect(entries.get(reclaimed.id)).toMatchObject({
    desired_state: "deleted",
    write_blocked: false,
    volume: null,
    runtime_authority: null,
    drain: null,
  });
  // Every entry judges the same authority revision of the node.
  expect(
    new Set(lease.databases.map((entry) => entry.authority_revision)).size,
  ).toBe(1);
}, 60_000);

it("keeps every live permit while the node's reading is stale, denies writes, is blocked or the database was protected", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  const live = await node.add({ kind: "live" }),
    parked = await node.add({ kind: "parked" });
  const proof = await node.commit();
  const stale = new Date(Date.now() - 60 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_json=?,authority_received_at=?,status='blocked',error_code='thin_storage_pool_full' WHERE node_id=?",
    ).bind(
      JSON.stringify({ ...proof, write_allowed: false }),
      stale,
      node.f.node,
    ),
    env.DB.prepare(
      "UPDATE databases SET storage_protected_at=?,storage_protected_generation=generation WHERE id=?",
    ).bind(stale, live.id),
  ]);
  const entries = await node.leaseEntries();
  for (const id of [node.held.id, live.id, parked.id])
    expect(entries.get(id), id).toMatchObject({
      desired_state: "running",
      write_blocked: false,
      runtime_authority: null,
      startup_operation_id: creation(await archiveOf(id)),
    });
}, 60_000);

it("names the same startup operation across sleeps and wakes, one generation past D1's", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  const live = await node.add({ kind: "live" });
  await node.commit();
  const before = (await node.leaseEntries()).get(live.id)!;
  // A sleep and a wake each advance the row's generation.
  await env.DB.prepare(
    "UPDATE databases SET generation=generation+2,desired_state='running' WHERE id=?",
  )
    .bind(live.id)
    .run();
  const after = (await node.leaseEntries()).get(live.id)!;
  expect(after.generation).toBe(before.generation + 2);
  expect(after.generation).toBe((await generationOf(live.id)) + 1);
  expect(after.startup_operation_id).toBe(before.startup_operation_id);
}, 60_000);

/** A thin node with `live` running databases the proof evidences and `deleted` ones whose volume
 * the node's fresh read found absent a few minutes ago. */
async function crowdedNode(live: number, deleted: number) {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  for (let i = 0; i < live; i++) await node.add({ kind: "live" });
  for (let i = 0; i < deleted; i++)
    await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: 5 * 60_000,
    });
  return { node, proof: await node.commit() };
}

// What the guard polls every second costs a fixed number of D1 statements: the agent, the node,
// its reading and its databases, plus the one conditional read of the physical boot.
const LEASE_STATEMENT_BOUND = 5;
it("costs the same D1 statements for three databases as for forty and a hundred deleted ones", async () => {
  const few = await crowdedNode(3, 5),
    many = await crowdedNode(40, 100);
  const small = await countStatements(() => few.node.lease()),
    large = await countStatements(() => many.node.lease());
  expect(small.result.databases).toHaveLength(3 + 5 + 1);
  expect(large.result.databases).toHaveLength(40 + 100 + 1);
  expect(
    large.result.databases.filter((entry) => entry.startup_operation_id),
  ).toHaveLength(41);
  expect(large.statements).toBe(small.statements);
  expect(large.statements).toBeLessThanOrEqual(LEASE_STATEMENT_BOUND);
  expect(large.roundTrips).toBe(small.roundTrips);
}, 120_000);

// The accepted sample's whole handler, its token issuance included.
const SAMPLE_STATEMENT_BOUND = 15;
it("issues the tokens of forty databases with the statements of three", async () => {
  const counted = async (live: number, deleted: number) => {
    const { node, proof } = await crowdedNode(live, deleted),
      f = node.f;
    const physical = {
      ...proof.physical,
      thin_pool: {
        ...proof.physical.thin_pool!,
        data_used_bytes_upper_bound: gib,
        metadata_used_bytes_upper_bound: mib,
      },
    };
    const first = await nonce(f);
    const result = await countStatements(() =>
      post(
        f,
        sample(f, first, {
          physical,
          lvs: [
            {
              name: "pgcf_thinpool",
              segtype: "thin-pool",
              size_bytes: 16 * gib,
            },
          ],
          lv_count: 1,
        }),
      ),
    );
    const response = NodeStorageHeadroomResponse.parse(result.result.body);
    expect(response.accepted).toBe(true);
    return { ...result, tokens: response.tokens };
  };
  const small = await counted(3, 5),
    large = await counted(40, 100);
  expect(small.tokens).toHaveLength(3);
  expect(large.tokens).toHaveLength(40);
  expect(large.statements).toBe(small.statements);
  expect(large.statements).toBeLessThanOrEqual(SAMPLE_STATEMENT_BOUND);
  expect(large.roundTrips).toBe(small.roundTrips);
}, 120_000);

it("names a deleted database only while a protective scope of it may still need the entry", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  const minute = 60_000,
    retention = HOST_LEASE_TOMBSTONE_RETENTION_MS;
  // The volume was read absent just now and a while ago, and one read absent long ago.
  const fresh = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: minute,
    }),
    inside = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: retention - 5 * minute,
    }),
    beyond = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: retention + 5 * minute,
    }),
    ancient = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: 400 * 24 * 60 * minute,
    });
  // A deletion the node has not read absent yet keeps its protection, however old it is.
  const unconfirmed = await node.add({ kind: "deleted", confirmed: false });
  // A database that never had a volume bound never had a token: no guard holds a scope for it.
  const neverBound = await node.add({
      kind: "deleted",
      confirmed: false,
      receipt: false,
    }),
    neverBoundConfirmed = await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: minute,
      receipt: false,
    });
  const live = await node.add({ kind: "live" });
  await node.commit();
  const entries = await node.leaseEntries();
  expect([...entries.keys()].sort()).toEqual(
    [node.held.id, live.id, fresh.id, inside.id, unconfirmed.id].sort(),
  );
  // What stays is what the guard retires on: deleted, writable, without a volume.
  for (const kept of [fresh, inside])
    expect(entries.get(kept.id)).toMatchObject({
      desired_state: "deleted",
      write_blocked: false,
      volume: null,
    });
  expect(entries.get(unconfirmed.id)).toMatchObject({
    desired_state: "deleted",
    write_blocked: true,
    volume: unconfirmed.receipt,
  });
  for (const gone of [beyond, ancient, neverBound, neverBoundConfirmed])
    expect(entries.has(gone.id)).toBe(false);
}, 60_000);

it("keeps the lease to the live databases and the recent deletions however many were deleted", async () => {
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  for (let i = 0; i < 30; i++) await node.add({ kind: "live" });
  for (let i = 0; i < 100; i++)
    await node.add({
      kind: "deleted",
      confirmed: true,
      confirmedAgo: HOST_LEASE_TOMBSTONE_RETENTION_MS + 60_000,
    });
  for (let i = 0; i < 4; i++)
    await node.add({ kind: "deleted", confirmed: true, confirmedAgo: 1000 });
  await node.commit();
  const lease = await node.lease();
  expect(lease.databases).toHaveLength(1 + 30 + 4);
  expect(
    lease.databases.filter((entry) => entry.desired_state === "deleted"),
  ).toHaveLength(4);
}, 60_000);

function servedLines(log: { mock: { calls: unknown[][] } }, nodeId: string) {
  return log.mock.calls.flatMap(([value]) => {
    if (typeof value !== "string") return [];
    const event = JSON.parse(value) as Record<string, unknown>;
    return event.event === "storage_guard_served" && event.node_id === nodeId
      ? [event]
      : [];
  });
}

it("logs what each lease served: the counts and its time, never an entry's secret", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  await node.add({ kind: "live" });
  await node.add({ kind: "parked" });
  await node.add({ kind: "deleted", confirmed: true, confirmedAgo: 1000 });
  await node.add({ kind: "deleted", confirmed: false });
  await node.commit();
  const lease = await node.lease();
  const lines = servedLines(log, node.f.node);
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(Object.keys(line).sort()).toEqual([
    "elapsed_ms",
    "entries",
    "event",
    "node_id",
    "tombstones",
    "unbound",
  ]);
  // The held start of the fixture has no volume bound yet.
  expect(line).toMatchObject({
    entries: lease.databases.length,
    tombstones: 2,
    unbound: 1,
  });
  expect(Number.isInteger(line.elapsed_ms)).toBe(true);
  expect(Number(line.elapsed_ms)).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(line).includes(node.f.agent)).toBe(false);
}, 60_000);

/** A sample the node's pool answers with room to write, after `crowdedNode`'s proof. */
function roomySample(
  f: Awaited<ReturnType<typeof crowdedNode>>["node"]["f"],
  proof: Awaited<ReturnType<typeof crowdedNode>>["proof"],
  at: string | null,
  usedBytes = gib,
) {
  return sample(f, at, {
    physical: {
      ...proof.physical,
      thin_pool: {
        ...proof.physical.thin_pool!,
        data_used_bytes_upper_bound: usedBytes,
        metadata_used_bytes_upper_bound: mib,
      },
    },
    lvs: [
      { name: "pgcf_thinpool", segtype: "thin-pool", size_bytes: 16 * gib },
    ],
    lv_count: 1,
  });
}
it("allows writes while the pool's free space covers its reserves, however much its volumes could hold", async () => {
  const { node, proof } = await crowdedNode(40, 0),
    f = node.f;
  // Forty volumes and the held start hold far more than the 1 GiB of the 16 GiB pool still free;
  // the free space covers the data and metadata reserve.
  const answer = NodeStorageHeadroomResponse.parse(
    (await post(f, roomySample(f, proof, await nonce(f), 15 * gib))).body,
  );
  expect(answer.accepted).toBe(true);
  expect(answer.authority!.write_allowed).toBe(true);
  expect((await row(f)).status).toBe("ready");
}, 60_000);
const nodeReads = (sql: string[]) =>
  sql.filter((text) =>
    text.startsWith("SELECT t.*,n.region_id,n.k8s_node_name"),
  );

it("reads the node once for a sample and signs its tokens from the row its own write left", async () => {
  const { node, proof } = await crowdedNode(3, 2),
    f = node.f;
  const first = await nonce(f);
  const counted = await countStatements(() =>
    post(f, roomySample(f, proof, first)),
  );
  const response = NodeStorageHeadroomResponse.parse(counted.result.body);
  expect(response.accepted).toBe(true);
  expect(response.tokens).toHaveLength(3);
  // The node and the qualification join under it are read before the compare-and-set and not
  // again after it; the compare-and-set carries its own predicate.
  expect(nodeReads(counted.sql)).toHaveLength(1);
  // What reading the written row back signs is what the sample signed.
  expect(response.tokens).toEqual(
    await runningWriterTokens(env as Env, f.node, f.region, Date.now()),
  );
}, 60_000);

function guardLines(log: { mock: { calls: unknown[][] } }, nodeId: string) {
  return servedLines(log, nodeId);
}

it("writes one lease line in thirty per node and the first after a silence", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { node } = await crowdedNode(2, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let i = 0; i < 65; i++) {
    await node.lease();
    vi.setSystemTime(Date.now() + 100);
  }
  // The 1st, 31st and 61st lease.
  expect(guardLines(log, node.f.node)).toHaveLength(3);
  // Quiet for longer than ten seconds: the next lease is written whatever the count says.
  vi.setSystemTime(Date.now() + 10_001);
  await node.lease();
  expect(guardLines(log, node.f.node)).toHaveLength(4);
  await node.lease();
  expect(guardLines(log, node.f.node)).toHaveLength(4);
}, 60_000);

function acceptedLines(log: { mock: { calls: unknown[][] } }, nodeId: string) {
  return log.mock.calls.flatMap(([value]) => {
    if (typeof value !== "string") return [];
    const event = JSON.parse(value) as Record<string, unknown>;
    return event.event === "thin_storage_sample_accepted" &&
      event.node_id === nodeId
      ? [event]
      : [];
  });
}

it("writes one accepted-sample line in thirty per node, and every one that withholds writes or fails", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { node, proof } = await crowdedNode(2, 0),
    f = node.f;
  let next = await nonce(f);
  const accept = async (usedBytes = gib) => {
    const answer = NodeStorageHeadroomResponse.parse(
      (await post(f, roomySample(f, proof, next, usedBytes))).body,
    );
    expect(answer.accepted).toBe(true);
    next = answer.nonce;
    return answer;
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let i = 0; i < 61; i++) {
    await accept();
    vi.setSystemTime(Date.now() + 100);
  }
  // The 1st, 31st and 61st accepted sample.
  expect(acceptedLines(log, f.node)).toHaveLength(3);
  // A sample that leaves the node without room is always written.
  const blocked = await accept(16 * gib - mib);
  expect(blocked.authority!.write_allowed).toBe(false);
  expect(acceptedLines(log, f.node)).toHaveLength(4);
  // One that fails after its compare-and-set is written, and its fields are the same.
  await accept();
  expect(acceptedLines(log, f.node)).toHaveLength(4);
  const prototype = Object.getPrototypeOf(env.DB) as D1Database;
  vi.spyOn(prototype, "batch").mockRejectedValueOnce(
    new Error("d1_unavailable"),
  );
  expect((await post(f, roomySample(f, proof, next))).status).toBe(500);
  const lines = acceptedLines(log, f.node);
  expect(lines).toHaveLength(5);
  expect(Object.keys(lines.at(-1)!).sort()).toEqual(
    Object.keys(lines[0]!).sort(),
  );
}, 60_000);
