// SPDX-License-Identifier: Apache-2.0
// Real local D1/Actor scheduling; no live pool latency or workload measurement is claimed.
import { env } from "cloudflare:workers";
import { SIDECAR } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  postgresPoolFixture,
  claimedPostgresPoolFixture,
} from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  databaseCpuChargeSql,
  nodeCpuHeadroomSql,
  computePoolOverheadSql,
} from "../../src/domain/startup-admission.ts";
import {
  recordPostgresPoolInventory,
  recordPostgresPoolSleep,
  recordPostgresPoolStorageObservation,
  recordPostgresPoolNodeReport,
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

it("retains the original bound scheduling request after the database class becomes smaller", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await env.DB.prepare(
    "UPDATE size_classes SET cpu_request_millicores=COALESCE(cpu_request_millicores,cpu_millicores)/2 WHERE id=(SELECT size_class_id FROM databases WHERE id=?)",
  )
    .bind(f.id)
    .run();
  expect(
    await env.DB.prepare(
      `SELECT ${databaseCpuChargeSql("d", "s")} charge FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
    )
      .bind(f.id)
      .first("charge"),
  ).toBe(f.policy.idle_cpu_millicores);
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(f.policy.idle_cpu_millicores - 1, f.node)
    .run();
  expect(
    (
      await env.DB.prepare(
        `SELECT n.id FROM nodes n JOIN databases d ON d.node_id=n.id JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND ${nodeCpuHeadroomSql("n", "s", "d")}`,
      )
        .bind(f.id)
        .all()
    ).results,
  ).toEqual([]);
});

it("charges an observed-deleted database's unreleased pool Pod until its exact terminal physical report", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  expect(
    (
      await request(
        `/v1/databases/${f.id}`,
        f.integrator,
        "DELETE",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  await env.DB.prepare(
    "UPDATE databases SET observed_state='deleted',observed_generation=generation WHERE id=?",
  )
    .bind(f.id)
    .run();
  const classCharge = await env.DB.prepare(
    `SELECT COALESCE(s.cpu_request_millicores,s.cpu_millicores)+${SIDECAR.requestCpuMillicores}+${computePoolOverheadSql("n", "cpu_millicores")} charge FROM databases d JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=?`,
  )
    .bind(f.id)
    .first<number>("charge");
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(classCharge! + f.policy.idle_cpu_millicores - 1, f.node)
    .run();
  const canStart = () =>
    env.DB.prepare(
      `SELECT n.id FROM nodes n JOIN databases d ON d.node_id=n.id JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND ${nodeCpuHeadroomSql("n", "s")}`,
    )
      .bind(f.id)
      .all();
  expect((await canStart()).results).toEqual([]);
  const scope = f.binding.scope;
  await recordPostgresPoolNodeReport(env, scope.binding_id, {
    v: 1,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_pod_uid: scope.pool_pod_uid,
    state: "refused",
    observed_at: Date.now(),
    storage_backend: "lvm-thin-v1",
    thin_guard: null,
    clean_stop: null,
    error: null,
    kernel_proof: {
      ...f.storageObservation.kernel_proof,
      never_attached_verified: true,
    },
  });
  expect((await canStart()).results).toEqual([{ id: f.node }]);
});

it("charges the ready pool scheduling share before a cold start and converts that same charge atomically on a hit", async () => {
  const f = await postgresPoolFixture({ thin: true, qualifiedThin: true });
  await recordPostgresPoolStorageObservation(env, f.id, f.storageObservation);
  await recordPostgresPoolSleep(env, f.id, f.sleep);
  await recordPostgresPoolInventory(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    observed_at: f.now,
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  });
  await env.DB.prepare(
    "UPDATE nodes SET allocatable_cpu_millicores=platform_reserved_cpu_millicores+? WHERE id=?",
  )
    .bind(f.policy.idle_cpu_millicores, f.node)
    .run();
  const admitted = () =>
    env.DB.prepare(
      `SELECT n.id FROM nodes n JOIN databases d ON d.node_id=n.id JOIN size_classes s ON s.id=d.size_class_id
     WHERE d.id=? AND ${nodeCpuHeadroomSql("n", "s", "d")}`,
    )
      .bind(f.id)
      .all();
  expect((await admitted()).results).toEqual([]);
  await publishDatabaseAdmission(env, f.id);
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id));
  await actor.ensureAwake(f.id, f.desired.roles.find((r) => r.owner)!.name, {
    deadline: Date.now() + 1000,
  });
  expect(
    await env.DB.prepare("SELECT state FROM pool_pods WHERE pod_uid=?")
      .bind(f.pod.pool_pod_uid)
      .first("state"),
  ).toBe("claimed");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM pool_bindings WHERE database_id=? AND state='claimed'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(1);
  expect((await admitted()).results).toEqual([{ id: f.node }]);
});
