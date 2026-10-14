// SPDX-License-Identifier: Apache-2.0
// Real D1/DO ownership metadata; no live CNPG hand-back is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { claimedPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  recordPostgresPoolNodeReport,
  readDesiredPostgresPoolBinding,
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
