// SPDX-License-Identifier: Apache-2.0
// Real local D1 and signing; these controlled inputs do not claim host cleanup acceptance.
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import {
  PoolCleanupIoAttestation,
  PoolNodeReport,
  poolCleanupIoAttestationHash,
} from "@pgcf/contracts/postgres-pool";
import {
  PoolCleanupClaims,
  signPoolCleanupAuthority,
} from "@pgcf/contracts/pool-cleanup-authority";
import {
  servingPostgresPoolFixture,
  currentPoolStartInventory,
} from "./postgres-pool-fixture.ts";
import { admissionFixtureReleases } from "./admission-snapshot-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { nodeProofSigningKey } from "../../src/domain/node-proof-session.ts";
import { readCurrentNodeThinStorage } from "../../src/domain/node-thin-storage.ts";
import {
  recordPostgresPoolCleanupIoAttestation,
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

it("accepts same-boot reference destruction only for its retained exact fixed grant and leaves credentials unapplied", async () => {
  const f = await servingPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  await currentPoolStartInventory(f);
  const scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1") throw new Error("Thin required");
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
  const oldPassword = await env.DB.prepare(
    "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
  )
    .bind(f.id)
    .first("password_revision");
  const guard = f.mounted.thin_guard!;
  const io = PoolCleanupIoAttestation.parse({
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
    shared_pod_io: guard.shared_pod_io,
    stopped_writers: guard.cgroups.map((c) => ({
      container_id: c.container_id,
      cgroup_inode: c.cgroup_inode,
      tenant_tasks_remaining: 0,
    })),
    cleanup_worker_only_verified: true,
    worker: {
      ...guard.cgroups[0]!,
      pool_pod_uid: scope.pool_pod_uid,
      executable_sha256: scope.host_controller_sha256,
      pid: 28,
      start_ticks: 44,
    },
  });
  await recordPostgresPoolCleanupIoAttestation(env, scope.binding_id, io);
  const authority = (await readCurrentNodeThinStorage(env, f.node))!.authority!;
  const key = await nodeProofSigningKey(env);
  const claims = PoolCleanupClaims.parse({
    v: 1,
    kid: key.kid,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    operation_id: operation.id,
    cleanup_io_sha256: await poolCleanupIoAttestationHash(io),
    holder_generation: scope.generation,
    database_generation: scope.generation,
    operation_target_generation: operation.generation,
    authority_revision: authority.revision + 1,
    database_id: f.id,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    storage: scope.storage,
    device_major: 253,
    device_minor: 1,
    allocation_reserve_bytes: authority.physical_lvs.find(
      (lv) => lv.lv_uuid === scope.storage.lv_uuid,
    )!.size_bytes,
    cleanup_mode: "drain_unmount",
    write_bytes_per_second: io.shared_pod_io.write_bytes_per_second,
    write_iops_per_second: io.shared_pod_io.write_iops_per_second,
    iat: Date.now(),
    exp: Date.now() + 5000,
  });
  const token = await signPoolCleanupAuthority(claims, key.privateKey);
  await env.DB.prepare(
    `INSERT INTO pool_cleanup_grants(binding_id,operation_id,authority_revision,claims_json,authority_token,issued_at,expires_at,allocation_reserve_bytes,headroom_authority_revision,headroom_snapshot_sha256,state,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'issued',?,?)`,
  )
    .bind(
      scope.binding_id,
      operation.id,
      claims.authority_revision,
      JSON.stringify(claims),
      token,
      claims.iat,
      claims.exp,
      claims.allocation_reserve_bytes,
      authority.revision,
      "a".repeat(64),
      claims.iat,
      claims.iat,
    )
    .run();
  const report = PoolNodeReport.parse({
    ...f.mounted,
    state: "released",
    thin_guard: null,
    clean_stop: false,
    observed_at: Date.now(),
    reference_destruction: {
      v: 1,
      operation_id: operation.id,
      authority_revision: claims.authority_revision,
      cleanup_io_sha256: claims.cleanup_io_sha256,
      cleanup_mode: "drain_unmount",
      dispatch_persisted: true,
      worker: io.worker,
      worker_reaped: true,
      stopped_writers: io.stopped_writers,
    },
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      mountpoint: null,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_complete: true,
      nonlazy_unmount_verified: false,
      zero_before_bind: false,
      exclusive_superblock_creation: false,
    },
  });
  const path = `/agent/v1/pool-bindings/${scope.binding_id}/node`;
  expect(
    (
      await request(
        `/agent/v1/pool-bindings/${scope.binding_id}/cleanup-io`,
        f.agent,
        "POST",
        { ...io, observed_at: io.observed_at + 1 },
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        `/agent/v1/pool-bindings/${scope.binding_id}/cleanup-io`,
        f.agent,
        "POST",
        io,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(path, f.agent, "POST", {
        ...report,
        reference_destruction: {
          ...report.reference_destruction!,
          authority_revision: claims.authority_revision + 1,
        },
      })
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(scope.binding_id)
      .first("state"),
  ).toBe("detaching");
  await env.DB.exec(
    `CREATE TRIGGER raced_cleanup_io BEFORE UPDATE OF node_report_json ON pool_bindings
    WHEN NEW.id='${scope.binding_id}' AND NEW.state='released'
    BEGIN UPDATE pool_cleanup_io_attestations SET attestation_json=json_set(attestation_json,'$.worker.pid',29) WHERE binding_id=NEW.id; END`.replace(
      /\n\s*/g,
      " ",
    ),
  );
  try {
    expect((await request(path, f.agent, "POST", report)).status).not.toBe(200);
    expect(
      await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
        .bind(scope.binding_id)
        .first("state"),
    ).toBe("detaching");
    expect(
      await env.DB.prepare(
        "SELECT json_extract(attestation_json,'$.worker.pid') pid FROM pool_cleanup_io_attestations WHERE binding_id=? AND operation_id=?",
      )
        .bind(scope.binding_id, operation.id)
        .first("pid"),
    ).toBe(io.worker.pid);
  } finally {
    await env.DB.exec("DROP TRIGGER raced_cleanup_io");
  }
  expect((await request(path, f.agent, "POST", report)).status).toBe(200);
  expect(
    await env.DB.prepare(
      "SELECT state,clean_stop,sleep_json FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ state: "released", clean_stop: 0, sleep_json: null });
  expect(
    await env.DB.prepare(
      "SELECT status,error_code FROM pool_role_mutations WHERE id=?",
    )
      .bind(operation.id)
      .first(),
  ).toEqual({ status: "failed", error_code: "pool_holder_unproved" });
  expect(
    await env.DB.prepare(
      "SELECT password_revision FROM roles WHERE database_id=? AND name='app'",
    )
      .bind(f.id)
      .first("password_revision"),
  ).toBe(oldPassword);
  expect(
    await env.DB.prepare(
      "SELECT desired_state,suspension_reason,generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: scope.generation + 1,
  });
  await currentPoolStartInventory(f);
  const resumed = await request(
    `/v1/databases/${f.id}/resume`,
    f.integrator,
    "POST",
    undefined,
    crypto.randomUUID(),
  );
  const resumedFailure =
    resumed.status === 202
      ? undefined
      : ((await resumed.clone().json()) as {
          error: { code: string; message: string };
        });
  expect(resumed.status, resumedFailure?.error.message).toBe(202);
  const next = DatabaseWithOperation.parse(await resumed.json()).operation;
  expect(next.kind).toBe("database.resume");
  expect(next.generation).toBe(scope.generation + 2);
  expect(
    await env.DB.prepare(
      "SELECT kind,state,binding_id,sleep_json FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    kind: "cnpg",
    state: "active",
    binding_id: null,
    sleep_json: null,
  });
  expect((await readDesiredPostgresPoolBinding(env, f.id)) === undefined).toBe(
    true,
  );
  expect(
    await env.DB.prepare(
      "SELECT state,node_report_json FROM pool_bindings WHERE id=?",
    )
      .bind(scope.binding_id)
      .first(),
  ).toEqual({ state: "released", node_report_json: JSON.stringify(report) });
  expect(
    await env.DB.prepare(
      "SELECT generation,power_operation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ generation: next.generation, power_operation: next.id });
});
