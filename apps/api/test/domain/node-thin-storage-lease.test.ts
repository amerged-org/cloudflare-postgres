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
import { claimsOf } from "./parked-tier-fixture.ts";
import { gib, mib, nonce, post, sample } from "./thin-renewal-fixture.ts";
import {
  HOST_LEASE_TOMBSTONE_RETENTION_MS,
  runningWriterTokens,
} from "../../src/domain/node-thin-storage.ts";
import type { Env } from "../../src/env.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("names every database the guard acts on with its writer or its explicit block", async () => {
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
  // A new database on its startup hold: no volume yet, no token, and the guard may start it.
  expect(entries.get(node.held.id)).toMatchObject({
    desired_state: "running",
    write_blocked: false,
    volume: null,
    runtime_authority: null,
    startup_operation_id: expect.stringMatching(/^op_/),
    startup_expires_at: expect.any(Number),
  });
  // A live writer carries the token that names its evidenced Pod.
  const running = entries.get(live.id)!;
  expect(running).toMatchObject({
    desired_state: "running",
    write_blocked: false,
    volume: live.receipt,
    startup_operation_id: null,
    startup_expires_at: null,
  });
  expect(claimsOf(running.runtime_authority)).toMatchObject({
    database_id: live.id,
    pod_uid: live.pod,
    lv_uuid: live.receipt!.lv_uuid,
    write_allowed: true,
  });
  // A running database whose Pod nobody evidences is explicitly blocked.
  expect(entries.get(blocked.id)).toMatchObject({
    desired_state: "running",
    write_blocked: true,
    runtime_authority: null,
    startup_expires_at: null,
  });
  // A parked sleep and a sleep whose stop is still running are presented as the running writer
  // they physically are, under the token of the Pod the node evidences.
  for (const sleeper of [parked, stopping]) {
    const entry = entries.get(sleeper.id)!;
    expect(entry).toMatchObject({
      desired_state: "running",
      write_blocked: false,
      volume: sleeper.receipt,
    });
    expect(claimsOf(entry.runtime_authority)).toMatchObject({
      database_id: sleeper.id,
      pod_uid: sleeper.pod,
      generation: sleeper.generation,
    });
  }
  // A deletion whose absence is not read yet keeps its volume and blocks writes; one the node's
  // fresh read found absent says so explicitly, and the guard may forget its scope.
  expect(entries.get(open.id)).toMatchObject({
    desired_state: "deleted",
    write_blocked: true,
    volume: open.receipt,
    runtime_authority: null,
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

// What the guard polls every second costs a fixed number of D1 statements: the agent, the node and
// its reading, and one batch for every database's rows and inputs. The bound is the design's own
// count (six) plus the one conditional read of the physical boot.
const LEASE_STATEMENT_BOUND = 7;
it("costs the same D1 statements for three databases as for forty and a hundred deleted ones", async () => {
  const few = await crowdedNode(3, 5),
    many = await crowdedNode(40, 100);
  const small = await countStatements(() => few.node.lease()),
    large = await countStatements(() => many.node.lease());
  expect(small.result.databases).toHaveLength(3 + 5 + 1);
  expect(large.result.databases).toHaveLength(40 + 100 + 1);
  expect(
    large.result.databases.filter((entry) => entry.runtime_authority),
  ).toHaveLength(40);
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

it("logs what each lease served: the counts, its time and one compact line per live entry", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  const live = await node.add({ kind: "live" }),
    blocked = await node.add({ kind: "blocked" }),
    parked = await node.add({ kind: "parked" });
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
    "live",
    "node_id",
    "tombstones",
  ]);
  expect(line).toMatchObject({
    entries: lease.databases.length,
    tombstones: 2,
  });
  expect(Number.isInteger(line.elapsed_ms)).toBe(true);
  expect(Number(line.elapsed_ms)).toBeGreaterThanOrEqual(0);
  const summary = new Map(
    (line.live as Record<string, unknown>[]).map((entry) => [
      entry.id as string,
      entry,
    ]),
  );
  // Live entries only, named by the first six characters of the database ID.
  expect(summary.size).toBe(4);
  const byId = new Map(
    lease.databases.map((entry) => [entry.database_id, entry]),
  );
  const shown = (id: string) => summary.get(id.slice(0, 6))!;
  expect(shown(node.held.id)).toEqual({
    id: node.held.id.slice(0, 6),
    generation: 1,
    revision: lease.databases[0]!.authority_revision,
    write_blocked: false,
    token: false,
    token_life_s: null,
    token_pod: null,
    startup_valid: true,
    parked: false,
  });
  for (const member of [live, parked]) {
    const entry = shown(member.id);
    expect(entry).toMatchObject({
      generation: byId.get(member.id)!.generation,
      revision: byId.get(member.id)!.authority_revision,
      write_blocked: false,
      token: true,
      token_pod: member.pod.slice(0, 6),
      startup_valid: false,
      parked: member === parked,
    });
    // The life of the token left when the line was written, to a tenth of a second.
    expect(entry.token_life_s as number).toBeGreaterThan(0);
    expect(entry.token_life_s as number).toBeLessThanOrEqual(120);
  }
  expect(shown(blocked.id)).toMatchObject({
    write_blocked: true,
    token: false,
    token_life_s: null,
    startup_valid: false,
  });
  // No token and no other secret is ever part of the line.
  const text = JSON.stringify(line);
  for (const entry of lease.databases)
    if (entry.runtime_authority)
      expect(text.includes(entry.runtime_authority)).toBe(false);
  expect(text.includes(node.f.agent)).toBe(false);
}, 60_000);

it("logs at most twenty live entries and says how many there were", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const node = await thinLeaseNode(await thinExecutionFixture(releases));
  for (let i = 0; i < 24; i++) await node.add({ kind: "live" });
  await node.commit();
  await node.lease();
  const line = servedLines(log, node.f.node)[0]!;
  expect(line.entries).toBe(25);
  expect((line.live as unknown[]).length).toBe(20);
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
