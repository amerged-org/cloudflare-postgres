// SPDX-License-Identifier: Apache-2.0
// A Pod that a parked database still holds: the shared pool must neither claim its volume nor
// ignore its CPU. Real local D1/Actor scheduling; no live pool latency is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { postgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  recordPostgresPoolInventory,
  recordPostgresPoolSleep,
  recordPostgresPoolStorageObservation,
} from "../../src/domain/postgres-pool.ts";

afterEach(async () => {
  await cleanupFixtures();
  await env.DB.prepare(
    "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id IN(SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(admissionFixtureReleases))
    .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

async function sleepingWithFreePoolPod() {
  const f = await postgresPoolFixture({ thin: true, qualifiedThin: true });
  await recordPostgresPoolStorageObservation(env, f.id, f.storageObservation);
  await recordPostgresPoolSleep(env, f.id, f.sleep);
  const inventory = (cpu: number) => ({
    v: 1 as const,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    observed_at: f.now,
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: cpu,
  });
  return { f, inventory };
}
const parkedHint = (id: string, pod: string) =>
  env.DB.prepare(
    "UPDATE databases SET parked_json=json_object('v',1,'pod_uid',?,'generation',generation,'cpu_millicores',15,'memory_mib',160,'parked_at',?,'observed_at',?) WHERE id=?",
  ).bind(pod, new Date().toISOString(), new Date().toISOString(), id);
it("parked_cpu_is_part_of_the_pool_inventory_budget", async () => {
  const { f, inventory } = await sleepingWithFreePoolPod();
  // Exactly the free pool Pod's scheduling share fits an otherwise empty node.
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(f.policy.idle_cpu_millicores, f.node)
    .run();
  await parkedHint(f.id, crypto.randomUUID()).run();
  await expect(
    recordPostgresPoolInventory(env, f.node, inventory(12)),
  ).rejects.toThrow("capacity changed before commit");
  await env.DB.prepare("UPDATE databases SET parked_json=NULL WHERE id=?")
    .bind(f.id)
    .run();
  await recordPostgresPoolInventory(env, f.node, inventory(13));
});
