// SPDX-License-Identifier: Apache-2.0
// Real D1/DO ownership metadata; no live CNPG hand-back is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import {
  claimedPostgresPoolFixture,
  servingPostgresPoolFixture,
  currentPoolStartInventory,
} from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  recordPostgresPoolNodeReport,
  readDesiredPostgresPoolBinding,
} from "../../src/domain/postgres-pool.ts";
const extraClasses: string[] = [];

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
  for (const id of extraClasses.splice(0))
    await env.DB.prepare("DELETE FROM size_classes WHERE id=?").bind(id).run();
});

it("selects the exact newer resize owner after the old serving generation finishes draining", async () => {
  const f = await servingPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await currentPoolStartInventory(f);
  const target = "r" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  extraClasses.push(target);
  await env.DB.prepare(
    `INSERT INTO size_classes(id,memory_mib,cpu_millicores,cpu_request_millicores,storage_gib,max_connections,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at)
    SELECT ?,memory_mib,cpu_millicores,cpu_request_millicores,storage_gib,max_connections+1,sleep_after_seconds,archive_timeout_seconds,backup_retention_days,enabled,created_at,updated_at FROM size_classes WHERE id=?`,
  )
    .bind(target, f.size)
    .run();
  const changed = await request(
    `/v1/databases/${f.id}`,
    f.integrator,
    "PATCH",
    { size_class_id: target },
    crypto.randomUUID(),
  );
  expect(changed.status).toBe(202);
  const operation = DatabaseWithOperation.parse(await changed.json()).operation;
  expect(operation.kind).toBe("database.resize");
  expect(operation.generation).toBe(f.binding.scope.generation + 1);
  expect(
    await env.DB.prepare(
      "SELECT state FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first("state"),
  ).toBe("detaching");
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "released",
    thin_guard: null,
    clean_stop: true,
    observed_at: Date.now(),
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
    },
  });
  expect(
    await env.DB.prepare(
      "SELECT kind,state,binding_id FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ kind: "cnpg", state: "active", binding_id: null });
  expect((await readDesiredPostgresPoolBinding(env, f.id)) === undefined).toBe(
    true,
  );
  expect(
    await env.DB.prepare(
      "SELECT state,node_report_json IS NOT NULL retained FROM pool_bindings WHERE id=?",
    )
      .bind(f.binding.scope.binding_id)
      .first(),
  ).toEqual({ state: "released", retained: 1 });
  expect(
    await env.DB.prepare(
      "SELECT generation,size_class_id FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: operation.generation, size_class_id: target });
});

it("selects a newer owned resume after the original holder completes its older suspend drain", async () => {
  const f = await servingPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await currentPoolStartInventory(f);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/suspend`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(202);
  await currentPoolStartInventory(f);
  const resumed = await request(
    `/v1/databases/${f.id}/resume`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(resumed.status).toBe(202);
  const next = DatabaseWithOperation.parse(await resumed.json()).operation;
  expect(next.generation).toBe(f.binding.scope.generation + 2);
  expect(
    await env.DB.prepare(
      "SELECT state FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first("state"),
  ).toBe("detaching");
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "released",
    thin_guard: null,
    clean_stop: true,
    observed_at: Date.now(),
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
    },
  });
  expect(
    await env.DB.prepare(
      "SELECT kind,state,binding_id FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ kind: "cnpg", state: "active", binding_id: null });
  expect(
    await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: next.generation, power_operation: next.id });
  expect((await readDesiredPostgresPoolBinding(env, f.id)) === undefined).toBe(
    true,
  );
});

it("selects ordinary CNPG for the same owned wake after an exact never-attached refusal and retains cleanup history", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
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
  expect(
    await env.DB.prepare(
      "SELECT kind,binding_id,state FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ kind: "cnpg", binding_id: null, state: "active" });
  expect((await readDesiredPostgresPoolBinding(env, f.id)) === undefined).toBe(
    true,
  );
  expect(
    await env.DB.prepare(
      "SELECT state,node_report_json IS NOT NULL retained FROM pool_bindings WHERE id=?",
    )
      .bind(scope.binding_id)
      .first(),
  ).toEqual({ state: "refused", retained: 1 });
  expect(
    await env.DB.prepare(
      "SELECT generation,desired_state FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: scope.generation, desired_state: "running" });
});

it("rolls back the terminal report when the guarded CNPG ownership selection is ignored", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  const scope = f.binding.scope;
  await env.DB.exec(
    "CREATE TRIGGER ignore_pool_cold_owner BEFORE UPDATE OF kind ON database_runtime_holders WHEN NEW.kind='cnpg' BEGIN SELECT RAISE(IGNORE); END",
  );
  try {
    await expect(
      recordPostgresPoolNodeReport(env, scope.binding_id, {
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
      }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT kind,state FROM database_runtime_holders WHERE database_id=?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ kind: "pool", state: "claimed" });
    expect(
      await env.DB.prepare(
        "SELECT state,node_report_json FROM pool_bindings WHERE id=?",
      )
        .bind(scope.binding_id)
        .first(),
    ).toEqual({ state: "claimed", node_report_json: null });
  } finally {
    await env.DB.exec("DROP TRIGGER ignore_pool_cold_owner");
  }
});
