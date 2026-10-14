// SPDX-License-Identifier: Apache-2.0
// Real D1/DO metadata tests; no live mount, PostgreSQL or Dev acceptance is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { servingPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import {
  cleanupFixtures,
  request,
  observation,
  observedBody,
} from "./fixtures.ts";
import { publishDatabaseAdmission } from "../../src/domain/database-admission-snapshot.ts";
import {
  finalizeDeferredPoolRoleChange,
  recoverDeferredPoolRoleChanges,
} from "../../src/domain/roles.ts";
import { recordPostgresPoolNodeReport } from "../../src/domain/postgres-pool.ts";
import {
  Operation,
  DatabaseWithOperation,
  DesiredResponse,
} from "@pgcf/contracts";
import {
  DatabaseRuntimeAttestationV2,
  reclaimConfigurationFingerprint,
} from "@pgcf/contracts/reclaim";
import { PgcfClient } from "@pgcf/contracts/client";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { createApp } from "../../src/app.ts";
import { keyring } from "../../src/crypto/keyring.ts";
import type { RoleRow } from "../../src/domain/rows.ts";
import { databaseStartupHeadroomSql } from "../../src/domain/startup-admission.ts";

async function reportResumedReady(
  f: Awaited<ReturnType<typeof servingPostgresPoolFixture>>,
) {
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  ).databases.find((d) => d.id === f.id)!;
  const image = desired.postgres!.image,
    now = Date.now();
  const {
    kind,
    binding_id,
    scope_sha256,
    holder_revision,
    pool_namespace_uid,
    pool_namespace_resource_version,
    ...previous
  } = f.proof;
  void kind;
  void binding_id;
  void scope_sha256;
  void holder_revision;
  void pool_namespace_uid;
  void pool_namespace_resource_version;
  const proof = DatabaseRuntimeAttestationV2.parse({
    ...previous,
    generation: desired.generation,
    route_revision: desired.admission!.route_revision,
    admission_epoch: desired.admission!.admission_epoch,
    applied_role_revisions: desired.roles.map((r) => ({
      name: r.name,
      revision: r.revision,
    })),
    configuration_fingerprint: await reclaimConfigurationFingerprint(
      desired,
      image,
    ),
    pod_uid: crypto.randomUUID(),
    container_id: "f".repeat(64),
    observed_at: now,
    observation: {
      ...previous.observation,
      verified_at: now,
      expires_at: now + 60000,
    },
  });
  const response = await request(
    "/agent/v1/observations",
    f.agent,
    "POST",
    observedBody([
      {
        ...observation(f.id, desired.generation, "ready"),
        power: {
          operation: desired.power!.operation,
          revision: desired.generation,
          state: "awake",
        },
        postgres: { image, image_id: image.split("@")[1]! },
        runtime_attestation: proof,
      },
    ]),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accepted: 1 });
}

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
it("terminates a deferred role operation after proven boot-loss release without applying credentials", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    scope = f.binding.scope;
  const before = await env.DB.prepare(
    "SELECT password_revision,password_ciphertext FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first<{ password_revision: number; password_ciphertext: string }>();
  const response = await request(
    `/v1/databases/${f.id}/roles/app/reset-password`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const op = DatabaseWithOperation.parse(await response.json()).operation,
    newBoot = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
  )
    .bind(newBoot, f.node)
    .run();
  await recordPostgresPoolNodeReport(env, scope.binding_id, {
    ...f.mounted,
    state: "released",
    boot_id: newBoot,
    observed_at: Date.now(),
    clean_stop: false,
    thin_guard: null,
    boot_loss: { holder_boot_id: scope.boot_id, storage: scope.storage },
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: false,
    },
  });
  await finalizeDeferredPoolRoleChange(env, f.id);
  const state = Operation.parse(
    await (await request(`/v1/operations/${op.id}`, f.integrator)).json(),
  );
  expect(state.status).toBe("failed");
  expect(state.error?.code).toBe("pool_holder_unproved");
  const after = await env.DB.prepare(
    "SELECT password_revision,password_ciphertext FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first<{ password_revision: number; password_ciphertext: string }>();
  expect(after?.password_revision).toBe(before?.password_revision);
  expect(after?.password_ciphertext === before?.password_ciphertext).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT password_ciphertext FROM pool_role_mutations WHERE id=?",
    )
      .bind(op.id)
      .first("password_ciphertext"),
  ).toBeNull();
});
it("queues a pool-bound password reset without changing the still-draining writer's credential or generation", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const before = await env.DB.prepare(
    "SELECT password_revision,password_ciphertext FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first<{ password_revision: number; password_ciphertext: string }>();
  const response = await request(
    `/v1/databases/${f.id}/roles/app/reset-password`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const after = await env.DB.prepare(
    "SELECT password_revision,password_ciphertext FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first<{ password_revision: number; password_ciphertext: string }>();
  expect(after?.password_revision).toBe(before?.password_revision);
  expect(after?.password_ciphertext === before?.password_ciphertext).toBe(true);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation);
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
});
it("queues a new role behind physical release and explicitly conflicts with a second pending mutation", async () => {
  const f = await servingPostgresPoolFixture();
  await publishDatabaseAdmission(env, f.id);
  const response = await request(
    `/v1/databases/${f.id}/roles`,
    f.integrator,
    "POST",
    { name: "new_login" },
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM roles WHERE database_id=? AND name='new_login'",
    )
      .bind(f.id)
      .first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
});
it("exposes the deferred operation through normal scoped GET and replay without publishing encrypted credentials", async () => {
  const f = await servingPostgresPoolFixture(),
    key = crypto.randomUUID(),
    path = `/v1/databases/${f.id}/roles/app/reset-password`;
  const response = await request(path, f.integrator, "POST", undefined, key),
    body = DatabaseWithOperation.parse(await response.json());
  expect(response.status).toBe(202);
  expect(response.headers.get("Location")).toBe(
    `/v1/operations/${body.operation.id}`,
  );
  expect(body.operation.kind).toBe("database.role.reset_password");
  const get = await request(
    `/v1/operations/${body.operation.id}`,
    f.integrator,
  );
  expect(get.status).toBe(200);
  expect(Operation.parse(await get.json())).toEqual(body.operation);
  expect(
    (await request(`/v1/operations/${body.operation.id}`, f.otherKey)).status,
  ).toBe(404);
  const replay = await request(path, f.integrator, "POST", undefined, key);
  expect(replay.status).toBe(202);
  expect(DatabaseWithOperation.parse(await replay.json()).operation.id).toBe(
    body.operation.id,
  );
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  const db = desired.databases.find((d) => d.id === f.id)!;
  expect(db.pending_pool_role).toMatchObject({
    operation_id: body.operation.id,
    binding_id: f.binding.scope.binding_id,
    generation: f.proof.generation,
    kind: "reset",
    name: "app",
  });
  expect(db.roles.find((r) => r.name === "app")?.revision).toBe(
    f.proof.applied_role_revisions.find((r) => r.name === "app")?.revision,
  );
  expect(Object.keys(db.pending_pool_role!)).not.toContain(
    "password_ciphertext",
  );
});
it("applies a deferred password exactly once after actual validated nonlazy release and erases the pending ciphertext", async () => {
  const f = await servingPostgresPoolFixture();
  expect(
    await env.DB.prepare(
      `SELECT 1 FROM databases d WHERE d.id=? AND ${databaseStartupHeadroomSql("d")}`,
    )
      .bind(f.id)
      .first(),
  ).not.toBeNull();
  const before = (await (
    await request(
      `/v1/databases/${f.id}/roles/app/connection-uri`,
      f.integrator,
    )
  ).json()) as { uri: string };
  const response = await request(
      `/v1/databases/${f.id}/roles/app/reset-password`,
      f.integrator,
      "POST",
      undefined,
      crypto.randomUUID(),
    ),
    body = DatabaseWithOperation.parse(await response.json());
  expect(await finalizeDeferredPoolRoleChange(env, f.id)).toBe(false);
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "released",
    observed_at: Date.now(),
    clean_stop: true,
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
      mountpoint: null,
    },
  });
  // The report callback may already finalize; repeat is an idempotent refusal, never a second password.
  await finalizeDeferredPoolRoleChange(env, f.id);
  const revision = await env.DB.prepare(
    "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first("password_revision");
  expect(revision).toBe(
    f.proof.applied_role_revisions.find((r) => r.name === "app")!.revision + 1,
  );
  expect(await finalizeDeferredPoolRoleChange(env, f.id)).toBe(false);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation + 1);
  const restart = await env.DB.prepare(
    "SELECT o.kind,o.generation FROM operations o JOIN databases d ON d.power_operation=o.id AND d.id=o.database_id WHERE d.id=? AND o.status='pending'",
  )
    .bind(f.id)
    .first<{ kind: string; generation: number }>();
  expect(restart).toEqual({
    kind: "database.resume",
    generation: f.proof.generation + 1,
  });
  expect(
    Operation.parse(
      await (
        await request(`/v1/operations/${body.operation.id}`, f.integrator)
      ).json(),
    ).status,
  ).toBe("running");
  await reportResumedReady(f);
  const op = Operation.parse(
    await (
      await request(`/v1/operations/${body.operation.id}`, f.integrator)
    ).json(),
  );
  expect(op.status).toBe("succeeded");
  expect(op.completed_at).not.toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT password_ciphertext IS NULL AND password_iv IS NULL AND password_kid IS NULL FROM pool_role_mutations WHERE id=?",
    )
      .bind(op.id)
      .first(),
  ).toEqual({
    "password_ciphertext IS NULL AND password_iv IS NULL AND password_kid IS NULL": 1,
  });
  const credentials = (await (
    await request(
      `/v1/databases/${f.id}/roles/app/connection-uri`,
      f.integrator,
    )
  ).json()) as { uri: string; includes_password: boolean };
  const active = (await env.DB.prepare(
    "SELECT * FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first<RoleRow>())!;
  const decrypted = await keyring(env.CREDENTIAL_KEYS).decrypt(f.id, "app", {
    ciphertext: active.password_ciphertext,
    iv: active.password_iv,
    kid: active.password_kid,
  });
  expect(credentials.includes_password).toBe(true);
  expect(credentials.uri !== before.uri).toBe(true);
  expect(
    decodeURIComponent(new URL(credentials.uri).password) === decrypted,
  ).toBe(true);
});
it("records failed/lost holders as terminal operation failures while preserving the active role and generation", async () => {
  const f = await servingPostgresPoolFixture();
  const before = await env.DB.prepare(
    "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first("password_revision");
  const response = await request(
      `/v1/databases/${f.id}/roles/app/reset-password`,
      f.integrator,
      "POST",
      undefined,
      crypto.randomUUID(),
    ),
    body = DatabaseWithOperation.parse(await response.json());
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "lost",
    observed_at: Date.now(),
    error: "node_boot_changed",
  });
  await finalizeDeferredPoolRoleChange(env, f.id);
  const op = Operation.parse(
    await (
      await request(`/v1/operations/${body.operation.id}`, f.integrator)
    ).json(),
  );
  expect(op.status).toBe("failed");
  expect(op.error?.code).toBe("pool_holder_unproved");
  expect(
    await env.DB.prepare(
      "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
    )
      .bind(f.id)
      .first("password_revision"),
  ).toBe(before);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
});
it("orders concurrent role requests so only one deferred operation owns the unchanged generation", async () => {
  const f = await servingPostgresPoolFixture();
  const results = await Promise.all(
    ["one", "two"].map((name) =>
      request(
        `/v1/databases/${f.id}/roles`,
        f.integrator,
        "POST",
        { name },
        crypto.randomUUID(),
      ),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([202, 409]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM pool_role_mutations WHERE database_id=? AND status='pending'",
    )
      .bind(f.id)
      .first("COUNT(*)"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) FROM roles WHERE database_id=? AND name IN('one','two')",
    )
      .bind(f.id)
      .first("COUNT(*)"),
  ).toBe(0);
});
it("fences a delayed release finalizer when a real D1 trigger supersedes its credential revision", async () => {
  const f = await servingPostgresPoolFixture();
  const response = await request(
      `/v1/databases/${f.id}/roles/app/reset-password`,
      f.integrator,
      "POST",
      undefined,
      crypto.randomUUID(),
    ),
    body = DatabaseWithOperation.parse(await response.json());
  // Complete the physical metadata through real statements, then make the next reservation race.
  const report = {
    ...f.mounted,
    state: "released",
    observed_at: Date.now(),
    clean_stop: true,
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
      mountpoint: null,
    },
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pool_bindings SET state='released',node_report_json=? WHERE id=?",
    ).bind(JSON.stringify(report), f.binding.scope.binding_id),
    env.DB.prepare(
      "UPDATE database_runtime_holders SET state='released',clean_stop=1 WHERE database_id=?",
    ).bind(f.id),
  ]);
  await env.DB.exec(
    "CREATE TRIGGER admission_role_release_race BEFORE UPDATE OF mutation_id ON database_admission_epochs WHEN NEW.mutation_id IS NOT NULL BEGIN UPDATE roles SET password_revision=password_revision+1 WHERE database_id=NEW.database_id AND name='app'; END",
  );
  try {
    // D1 counts trigger writes: the reservation fails closed before any business write.
    await expect(finalizeDeferredPoolRoleChange(env, f.id)).rejects.toThrow(
      "Database admission mutation is in progress",
    );
  } finally {
    await env.DB.exec("DROP TRIGGER admission_role_release_race");
  }
  expect(await finalizeDeferredPoolRoleChange(env, f.id)).toBe(false);
  const operation = Operation.parse(
    await (
      await request(`/v1/operations/${body.operation.id}`, f.integrator)
    ).json(),
  );
  expect(operation.status).toBe("failed");
  expect(operation.error?.code).toBe("superseded");
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation);
});
it("the SDK accepts a real deferred 202 role result and can read its ordinary operation", async () => {
  const f = await servingPostgresPoolFixture(),
    app = createApp();
  const client = new PgcfClient({
    baseUrl: "https://api.example.test",
    apiKey: f.integrator,
    fetch: async (input, init) => {
      const context = createExecutionContext();
      const response = await app.fetch(
        new Request(input, init),
        { ...env, DB_ENDPOINT_HOST: "db.invalid" },
        context,
      );
      await waitOnExecutionContext(context);
      return response;
    },
  });
  const result = await client.resetRolePassword(
    f.id,
    "app",
    crypto.randomUUID(),
  );
  expect(DatabaseWithOperation.parse(result).operation.status).toBe("pending");
  if ("operation" in result)
    expect((await client.getOperation(result.operation.id)).id).toBe(
      result.operation.id,
    );
});
it("a deferred create exposes its new credentials through the existing scoped SDK read only after verified release", async () => {
  const f = await servingPostgresPoolFixture(),
    app = createApp();
  const client = new PgcfClient({
    baseUrl: "https://api.example.test",
    apiKey: f.integrator,
    fetch: async (input, init) => {
      const context = createExecutionContext(),
        response = await app.fetch(
          new Request(input, init),
          { ...env, DB_ENDPOINT_HOST: "db.invalid" },
          context,
        );
      await waitOnExecutionContext(context);
      return response;
    },
  });
  const accepted = DatabaseWithOperation.parse(
    await client.createRole(f.id, { name: "new_login" }, crypto.randomUUID()),
  );
  expect(accepted.operation.status).toBe("pending");
  await expect(
    client.getConnectionUri(f.id, "new_login"),
  ).rejects.toMatchObject({ code: "not_found", status: 404 });
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "released",
    observed_at: Date.now(),
    clean_stop: true,
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
      mountpoint: null,
    },
  });
  await finalizeDeferredPoolRoleChange(env, f.id);
  expect((await client.getOperation(accepted.operation.id)).status).toBe(
    "running",
  );
  await reportResumedReady(f);
  expect((await client.getOperation(accepted.operation.id)).status).toBe(
    "succeeded",
  );
  const credential = await client.getConnectionUri(f.id, "new_login"),
    stored = (await env.DB.prepare(
      "SELECT * FROM roles WHERE database_id=? AND name='new_login'",
    )
      .bind(f.id)
      .first<RoleRow>())!;
  const decrypted = await keyring(env.CREDENTIAL_KEYS).decrypt(
    f.id,
    "new_login",
    {
      ciphertext: stored.password_ciphertext,
      iv: stored.password_iv,
      kid: stored.password_kid,
    },
  );
  expect(credential.includes_password).toBe(true);
  expect(
    decodeURIComponent(new URL(credential.uri).password) === decrypted,
  ).toBe(true);
  expect(
    (
      await request(
        `/v1/databases/${f.id}/roles/new_login/connection-uri`,
        f.otherKey,
      )
    ).status,
  ).toBe(404);
});
it("a lost node terminates the queued operation even without a physical callback, and never applies its password", async () => {
  const f = await servingPostgresPoolFixture();
  const result = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  const revision = await env.DB.prepare(
    "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first("password_revision");
  await env.DB.prepare("UPDATE nodes SET lost_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.node)
    .run();
  expect(await recoverDeferredPoolRoleChanges(env)).toBe(0);
  expect(
    (await (
      await request(`/v1/operations/${result.operation.id}`, f.integrator)
    ).json()) as { status: string },
  ).toMatchObject({ status: "failed" });
  expect(
    await env.DB.prepare(
      "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
    )
      .bind(f.id)
      .first("password_revision"),
  ).toBe(revision);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(f.proof.generation);
});
it("propagates a linked resume failure and never reports queued credentials as usable before readiness", async () => {
  const f = await servingPostgresPoolFixture();
  const role = DatabaseWithOperation.parse(
    await (
      await request(
        `/v1/databases/${f.id}/roles/app/reset-password`,
        f.integrator,
        "POST",
        undefined,
        crypto.randomUUID(),
      )
    ).json(),
  );
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "released",
    observed_at: Date.now(),
    clean_stop: true,
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      nonlazy_unmount_verified: true,
      mountpoint: null,
    },
  });
  const running = Operation.parse(
    await (
      await request(`/v1/operations/${role.operation.id}`, f.integrator)
    ).json(),
  );
  expect(running.status).toBe("running");
  expect(running.completed_at).toBeNull();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE operations SET status='failed',error_code='operation_timeout',error_message='Regional operation exceeded 20 minutes',updated_at=?,completed_at=? WHERE id=(SELECT resume_operation_id FROM pool_role_mutations WHERE id=?)",
  )
    .bind(now, now, role.operation.id)
    .run();
  const failed = Operation.parse(
    await (
      await request(`/v1/operations/${role.operation.id}`, f.integrator)
    ).json(),
  );
  expect(failed.status).toBe("failed");
  expect(failed.error?.code).toBe("operation_timeout");
  expect(
    await env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id)).admit(
      f.id,
      "app",
    ),
  ).toEqual({ ok: false, sqlstate: "57P03" });
});
