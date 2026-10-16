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
// its reading, one batch for every database's rows and inputs, and the pool capability. The bound
// is the design's own count (nine) plus the one conditional read of the physical boot.
const LEASE_STATEMENT_BOUND = 10;
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
const SAMPLE_STATEMENT_BOUND = 16;
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
