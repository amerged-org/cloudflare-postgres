// SPDX-License-Identifier: Apache-2.0
// A Pod that a parked database still holds: the shared pool must neither claim its volume nor
// ignore its CPU. Real local D1/Actor scheduling; no live pool latency is claimed.
import { env } from "cloudflare:workers";
import { presentRoles } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { postgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  recordPostgresPoolInventory,
  recordPostgresPoolSleep,
  recordPostgresPoolStorageObservation,
} from "../../src/domain/postgres-pool.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";

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

it("pool_claim_is_refused_for_a_parked_database", async () => {
  const { f, inventory } = await sleepingWithFreePoolPod();
  await recordPostgresPoolInventory(env, f.node, inventory(12));
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(f.policy.idle_cpu_millicores + 5000, f.node)
    .run();
  // The parked Pod of this database still holds the volume mounted: no pool Pod may claim it.
  await parkedHint(f.id, crypto.randomUUID()).run();
  await publishDatabaseAdmission(env, f.id);
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id));
  await actor.ensureAwake(
    f.id,
    presentRoles(f.desired).find((r) => r.owner)!.name,
    {
      deadline: Date.now() + 1000,
    },
  );
  expect(
    await env.DB.prepare("SELECT state FROM pool_pods WHERE pod_uid=?")
      .bind(f.pod.pool_pod_uid)
      .first("state"),
  ).toBe("ready");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM pool_bindings WHERE database_id=?",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT outcome,reason FROM pool_claim_attempts WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ outcome: "miss", reason: "parked_pod_holds_volume" });
  // The wake itself is the ordinary one: the database is running at the next generation.
  expect(
    await env.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
      .bind(f.id)
      .first("desired_state"),
  ).toBe("running");
});

it("a_parked_pod_is_not_a_clean_pool_sleep_either", async () => {
  const f = await postgresPoolFixture({ thin: true, qualifiedThin: true });
  await recordPostgresPoolStorageObservation(env, f.id, f.storageObservation);
  await parkedHint(f.id, crypto.randomUUID()).run();
  await expect(recordPostgresPoolSleep(env, f.id, f.sleep)).rejects.toThrow();
});

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
