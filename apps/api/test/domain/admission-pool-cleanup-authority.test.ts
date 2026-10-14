// SPDX-License-Identifier: Apache-2.0
// Controlled D1/crypto metadata only; no live cleanup, mount or worker proof is claimed.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation, thinWriteExposure } from "@pgcf/contracts";
import { PoolCleanupClaims } from "@pgcf/contracts/pool-cleanup-authority";
import { servingPostgresPoolFixture } from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { storageHolds } from "../../src/domain/node-thin-storage-execution.ts";
import { readCurrentNodeThinStorage } from "../../src/domain/node-thin-storage.ts";
import { HostStorageLease } from "@pgcf/contracts/node-thin-storage";
import {
  readPostgresPoolCleanupIoAttestation,
  recordPostgresPoolCleanupIoAttestation,
} from "../../src/domain/postgres-pool.ts";
import { readPostgresPoolFleetFence } from "../../src/domain/postgres-pool-fleet-fence.ts";
import { verifyPoolCleanupAuthority } from "@pgcf/contracts/pool-cleanup-authority";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";

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
it("issues only one bounded cleanup grant after real writer expiry and fresh stopped-worker custody", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture required");
  const response = await request(
    `/v1/databases/${f.id}/roles/app/reset-password`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const operation = DatabaseWithOperation.parse(
    await response.json(),
  ).operation;
  const read = async () =>
    HostStorageLease.parse(
      await (
        await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent)
      ).json(),
    ).databases.find((d) => d.database_id === f.id)!;
  expect((await read()).pool!.cleanup_authority).toBeNull();
  const deadline = await env.DB.prepare(
    "SELECT drain_deadline FROM pool_role_mutations WHERE id=?",
  )
    .bind(operation.id)
    .first<number>("drain_deadline");
  // Real elapsed time, never a mocked clock: no grant can overlap any allowed old-writer token.
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, deadline! - Date.now() + 10)),
  );
  const now = Date.now(),
    current = (await readCurrentNodeThinStorage(env, f.node))!;
  const retained = JSON.parse(current.row.authority_json!),
    authority = {
      ...retained,
      revision: retained.revision + 1,
      observed_at: new Date(now).toISOString(),
      captured_at: new Date(now).toISOString(),
      expires_at: new Date(
        now + scope.storage.profile.guard_seconds * 1000,
      ).toISOString(),
    };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(
      authority.revision,
      JSON.stringify(authority),
      new Date(now).toISOString(),
      f.node,
    )
    .run();
  const io = f.mounted.thin_guard!;
  await recordPostgresPoolCleanupIoAttestation(env, scope.binding_id, {
    v: 1,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    operation_id: operation.id,
    holder_generation: scope.generation,
    database_generation: scope.generation,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    observed_at: Date.now(),
    device: {
      volume_group_uuid: scope.storage.volume_group_uuid,
      lv_uuid: scope.storage.lv_uuid,
      thin_id: scope.storage.thin_id,
      device_major: 253,
      device_minor: 1,
    },
    shared_pod_io: io.shared_pod_io,
    stopped_writers: io.cgroups.map((c) => ({
      container_id: c.container_id,
      cgroup_inode: c.cgroup_inode,
      tenant_tasks_remaining: 0,
    })),
    cleanup_worker_only_verified: true,
    worker: {
      ...io.cgroups[0]!,
      pool_pod_uid: scope.pool_pod_uid,
      executable_sha256: scope.host_controller_sha256,
      pid: 28,
      start_ticks: 44,
    },
  });
  expect(
    await readPostgresPoolCleanupIoAttestation(
      env,
      { ...f.binding, state: "detaching" },
      operation.id,
      Date.now(),
    ),
  ).toBeDefined();
  expect(
    await readPostgresPoolFleetFence(env.DB, scope.region_id),
  ).toBeDefined();
  expect(
    (await readCurrentNodeThinStorage(env, f.node))?.authority,
  ).toBeDefined();
  await env.DB.exec(
    `CREATE TRIGGER interrupted_cleanup_publication BEFORE UPDATE OF state ON pool_cleanup_grants
    WHEN NEW.binding_id='${scope.binding_id}' AND NEW.state='issued'
    BEGIN SELECT RAISE(ABORT,'controlled cleanup publication interrupted'); END`.replace(
      /\n\s*/g,
      " ",
    ),
  );
  try {
    expect(
      (await request(`/agent/v1/nodes/${f.node}/storage-guard`, f.agent))
        .status,
    ).toBe(500);
  } finally {
    await env.DB.exec("DROP TRIGGER interrupted_cleanup_publication");
  }
  const reserved = await env.DB.prepare(
    "SELECT state,claims_json,authority_token,maximum_write_bytes FROM pool_cleanup_grants WHERE binding_id=?",
  )
    .bind(scope.binding_id)
    .first<{
      state: string;
      claims_json: string;
      authority_token: string | null;
      maximum_write_bytes: number;
    }>();
  expect(reserved?.state).toBe("reserved");
  expect(reserved?.authority_token).toBeNull();
  const entry = await read(),
    token = entry.pool!.cleanup_authority;
  expect(token?.startsWith("pc1.")).toBe(true);
  expect(entry.runtime_authority).toBeNull();
  expect(entry.write_blocked).toBe(true);
  const claims = await verifyPoolCleanupAuthority(
    token!,
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    ),
  );
  expect(claims).toMatchObject({
    binding_id: scope.binding_id,
    holder_generation: scope.generation,
    database_generation: scope.generation,
    operation_id: operation.id,
    operation_target_generation: operation.generation,
  });
  expect(claims!.authority_revision).toBeGreaterThan(io.authority_revision);
  expect(JSON.stringify(claims)).toBe(reserved!.claims_json);
  expect(claims!.maximum_write_bytes).toBe(reserved!.maximum_write_bytes);
  expect((await read()).pool!.cleanup_authority === token).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM pool_cleanup_grants WHERE binding_id=?",
    )
      .bind(scope.binding_id)
      .first("n"),
  ).toBe(1);
  expect(
    await verifyPoolCleanupAuthority(
      token!,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
      claims!.exp + 1,
    ),
  ).toBeNull();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, claims!.exp - Date.now() + 10)),
  );
  const later = Date.now(),
    renewed = {
      ...authority,
      revision: authority.revision + 1,
      observed_at: new Date(later).toISOString(),
      captured_at: new Date(later).toISOString(),
      expires_at: new Date(
        later + scope.storage.profile.guard_seconds * 1000,
      ).toISOString(),
    };
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=? WHERE node_id=?",
  )
    .bind(
      renewed.revision,
      JSON.stringify(renewed),
      new Date(later).toISOString(),
      f.node,
    )
    .run();
  expect((await read()).pool!.cleanup_authority).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM pool_cleanup_grants WHERE binding_id=?",
    )
      .bind(scope.binding_id)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT expires_at FROM pool_cleanup_grants WHERE binding_id=?",
    )
      .bind(scope.binding_id)
      .first("expires_at"),
  ).toBe(claims!.exp);
}, 40000);
it("retains the cleanup allocation budget after expiry or an uncertain worker result until physical release", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture required");
  const response = await request(
    `/v1/databases/${f.id}/roles/app/reset-password`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const operation = DatabaseWithOperation.parse(
      await response.json(),
    ).operation,
    now = Date.now(),
    profile = scope.storage.profile;
  const claims = PoolCleanupClaims.parse({
    v: 1,
    kid: "controlled",
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    operation_id: operation.id,
    cleanup_io_sha256: "a".repeat(64),
    holder_generation: scope.generation,
    database_generation: scope.generation,
    operation_target_generation: operation.generation,
    authority_revision: 2,
    database_id: f.id,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    storage: scope.storage,
    device_major: 253,
    device_minor: 1,
    maximum_write_bytes: profile.write_bytes_per_second,
    write_bytes_per_second: profile.write_bytes_per_second,
    write_iops_per_second: profile.write_iops_per_second,
    iat: now,
    exp: now + 1000,
  });
  // This is an accepted local immutable CF reservation, without a signed token or executing worker.
  await env.DB.prepare(
    `INSERT INTO pool_cleanup_grants(binding_id,operation_id,authority_revision,claims_json,issued_at,expires_at,maximum_write_bytes,headroom_authority_revision,headroom_snapshot_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'failed',?,?)`,
  )
    .bind(
      scope.binding_id,
      operation.id,
      2,
      JSON.stringify(claims),
      now,
      now + 1000,
      claims.maximum_write_bytes,
      1,
      "a".repeat(64),
      now,
      now,
    )
    .run();
  await env.DB.prepare(
    "DELETE FROM database_start_admissions WHERE database_id=?",
  )
    .bind(f.id)
    .run();
  const authority = (await readCurrentNodeThinStorage(env, f.node))!.authority;
  const budget = thinWriteExposure(
    claims.maximum_write_bytes,
    profile.write_iops_per_second,
  ).data_bytes;
  const holds = await storageHolds(
    env,
    f.node,
    scope.node_uid,
    authority,
    now + 2000,
  );
  expect(holds.bytes).toBe(budget);
  expect(holds.count).toBe(1);
  expect(holds.ids.has(f.id)).toBe(true);
  expect(holds.operations).toContain(operation.id);
  await env.DB.prepare(
    "UPDATE pool_cleanup_grants SET state='completed' WHERE binding_id=?",
  )
    .bind(scope.binding_id)
    .run();
  expect(
    (await storageHolds(env, f.node, scope.node_uid, authority, now + 2000))
      .bytes,
  ).toBe(0);
});
