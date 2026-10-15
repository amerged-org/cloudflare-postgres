// SPDX-License-Identifier: Apache-2.0
// What the host guard's lease names for one thin node, and what it costs. Real D1 harness with
// controlled metadata; the live latency of the endpoint is measured on Dev, not here.
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupFixtures } from "./fixtures.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { thinLeaseNode } from "./thin-lease-fixture.ts";
import { claimsOf } from "./parked-tier-fixture.ts";

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
