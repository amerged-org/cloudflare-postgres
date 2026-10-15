// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  DesiredResponse,
  FleetReleaseSpec,
  presentRoles,
} from "@pgcf/contracts";
import { cleanupFixtures, request } from "./fixtures.ts";
import {
  admissionSnapshotFixture,
  admissionFixtureReleases,
} from "./admission-snapshot-fixture.ts";
import {
  claimedPostgresPoolFixture,
  servingPostgresPoolFixture,
} from "./postgres-pool-fixture.ts";
import { postgresPoolFixture } from "./postgres-pool-fixture.ts";
import { qualificationPostgresPoolFixture } from "./postgres-pool-fixture.ts";

it("refreshes a bound Pod attestation only from an actual unchanged current inventory report", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    pool = await import("../../src/domain/postgres-pool.ts");
  await env.DB.prepare(
    "UPDATE pool_pods SET attestation_json=json_set(attestation_json,'$.observed_at',?) WHERE pod_uid=?",
  )
    .bind(Date.now() - 61000, f.pod.pool_pod_uid)
    .run();
  const now = Date.now();
  await pool.recordPostgresPoolInventory(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    observed_at: now,
    pods: [{ ...f.pod, observed_at: now }],
    idle_memory_current_bytes: 0,
    idle_cpu_usage_usec: 0,
  });
  const detail = await request(
    `/agent/v1/pool-bindings/${f.binding.scope.binding_id}`,
    f.agent,
  );
  expect(detail.status).toBe(200);
  expect(
    ((await detail.json()) as { pod_attestation: { observed_at: number } })
      .pod_attestation.observed_at,
  ).toBe(now);
});

it("charges candidate preparation for actual PostgreSQL and archiver Pod requests", async () => {
  const f = await qualificationPostgresPoolFixture();
  const { readPostgresPoolQualificationSetup } =
    await import("../../src/domain/postgres-pool-qualification-authority.ts");
  const setup = await readPostgresPoolQualificationSetup(
    env,
    f.id,
    f.sleep.generation + 1,
  );
  expect(setup?.policy.idle_cpu_millicores).toBe(
    f.policy.class.cpu_request_millicores + 100,
  );
  expect(setup?.policy.idle_memory_mib).toBe(
    Math.ceil(f.policy.class.memory_request_bytes / 1024 ** 2) + 128,
  );
  expect(setup?.policy.host_controller_sha256).toBe(
    f.qualificationScope.software.host_controller_sha256,
  );
});

it("refuses candidate setup and a delayed claim after its sealed host executable profile changes", async () => {
  const f = await qualificationPostgresPoolFixture(),
    { readPostgresPoolQualificationSetup } =
      await import("../../src/domain/postgres-pool-qualification-authority.ts");
  const setup = await readPostgresPoolQualificationSetup(
    env,
    f.id,
    f.sleep.generation + 1,
  );
  expect(setup).toBeDefined();
  const pin = f.qualificationScope.software.host_controller_sha256,
    changed = (pin[0] === "a" ? "b" : "a") + pin.slice(1);
  await env.DB.prepare(
    "UPDATE node_compute_pool_policies SET policy_json=json_set(policy_json,'$.profile.controller_sha256',?) WHERE node_id=?",
  )
    .bind(changed, f.node)
    .run();
  expect(
    await readPostgresPoolQualificationSetup(env, f.id, f.sleep.generation + 1),
  ).toBeUndefined();
  expect(
    (
      await env.DB.prepare(
        `UPDATE databases SET updated_at=updated_at WHERE id=? AND ${setup!.fence.sql}`,
      )
        .bind(f.id, ...setup!.fence.bindings)
        .run()
    ).meta.changes,
  ).toBe(0);
});

it("grants qualification cleanup only to its exact current stop and fences a delayed commit after the run ends", async () => {
  const f = await qualificationPostgresPoolFixture(),
    pool = await import("../../src/domain/postgres-pool.ts");
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  await pool.recordPostgresPoolInventory(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    qualification_run_id: f.qualificationRunId,
    qualification_scope_sha256: f.qualificationScopeHash,
    observed_at: Date.now(),
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  });
  const { withAdmissionMutation } =
    await import("../../src/domain/admission-mutations.ts");
  const claim = await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
        env,
        f.id,
        f.sleep.generation + 1,
        mutation,
      ),
      guard = mutation.guard(f.id);
    await mutation.batch([
      ...plan.statements,
      env.DB.prepare(
        `UPDATE databases SET desired_state='running',generation=generation+1 WHERE id=? AND ${guard.sql}`,
      ).bind(f.id, ...guard.bindings),
    ]);
    return plan.finish();
  });
  if (claim.kind !== "hit") throw new Error("Owned candidate claim missing");
  expect(
    await pool.readPostgresPoolQualificationCleanupAuthority(
      env,
      claim.binding,
    ),
  ).toBeUndefined();
  const stop = await request(
    `/v1/databases/${f.id}/roles`,
    f.integrator,
    "POST",
    { name: "candidate_cleanup" },
    crypto.randomUUID(),
  );
  expect(stop.status).toBe(202);
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='cleanup' WHERE id=?",
  )
    .bind(f.qualificationRunId)
    .run();
  const authority = await pool.readPostgresPoolQualificationCleanupAuthority(
    env,
    claim.binding,
  );
  expect(authority?.operation_id).toBe(
    ((await stop.json()) as { operation: { id: string } }).operation.id,
  );
  if (!authority) throw new Error("Exact candidate cleanup authority absent");
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='failed',completed_at=?,cleanup_json=?,error_code='cleanup_unknown' WHERE id=?",
  )
    .bind(
      Date.now(),
      JSON.stringify({ error: "cleanup_unconfirmed" }),
      f.qualificationRunId,
    )
    .run();
  expect(
    (
      await env.DB.prepare(
        `UPDATE pool_bindings SET updated_at=updated_at WHERE id=? AND ${authority.fence.sql}`,
      )
        .bind(claim.binding.scope.binding_id, ...authority.fence.bindings)
        .run()
    ).meta.changes,
  ).toBe(0);
});

it("requires fresh exact cleanup-worker IO rather than reusing the old tenant report", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    scope = f.binding.scope;
  const response = await request(
    `/v1/databases/${f.id}/roles`,
    f.integrator,
    "POST",
    { name: "cleanup_io_writer" },
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const op = ((await response.json()) as { operation: { id: string } })
    .operation.id;
  const pool = await import("../../src/domain/postgres-pool.ts");
  expect(
    await pool.readPostgresPoolCleanupIoAttestation(env, f.binding, op),
  ).toBeUndefined();
  const io = f.mounted.thin_guard!;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture absent");
  const value = {
    v: 1 as const,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    operation_id: op,
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
      tenant_tasks_remaining: 0 as const,
    })),
    cleanup_worker_only_verified: true as const,
    worker: {
      ...io.cgroups[0]!,
      pool_pod_uid: scope.pool_pod_uid,
      executable_sha256: scope.host_controller_sha256,
      pid: 28,
      start_ticks: 44,
    },
  };
  await expect(
    pool.recordPostgresPoolCleanupIoAttestation(env, scope.binding_id, {
      ...value,
      operation_id: "op_" + "x".repeat(20),
    }),
  ).rejects.toThrow();
  await expect(
    pool.recordPostgresPoolCleanupIoAttestation(env, scope.binding_id, {
      ...value,
      worker: {
        ...value.worker,
        executable_sha256:
          (scope.host_controller_sha256[0] === "a" ? "b" : "a") +
          scope.host_controller_sha256.slice(1),
      },
    }),
  ).rejects.toThrow();
  await pool.recordPostgresPoolCleanupIoAttestation(
    env,
    scope.binding_id,
    value,
  );
  expect(
    await pool.readPostgresPoolCleanupIoAttestation(env, f.binding, op),
  ).toEqual(value);
});

it("accepts only exact protected post-boot physical absence and retains terminal cleanup detail without a clean sleep", async () => {
  const f = await servingPostgresPoolFixture({ thin: true }),
    scope = f.binding.scope,
    newBoot = crypto.randomUUID();
  const pool = await import("../../src/domain/postgres-pool.ts");
  await env.DB.prepare(
    "UPDATE fleet_node_release_observations SET facts_json=json_set(facts_json,'$.boot_id',?) WHERE node_id=?",
  )
    .bind(newBoot, f.node)
    .run();
  const released = {
    ...f.mounted,
    state: "released" as const,
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
  };
  await expect(
    pool.recordPostgresPoolNodeReport(env, scope.binding_id, {
      ...released,
      boot_loss: { ...released.boot_loss, holder_boot_id: crypto.randomUUID() },
    }),
  ).rejects.toThrow();
  await pool.recordPostgresPoolNodeReport(env, scope.binding_id, released);
  const recovery = await env.DB.prepare(
    "SELECT desired_state,suspension_reason,generation,power_operation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<{
      desired_state: string;
      suspension_reason: string;
      generation: number;
      power_operation: string;
    }>();
  expect(recovery).toMatchObject({
    desired_state: "suspended",
    suspension_reason: "idle",
    generation: scope.generation + 1,
  });
  expect(
    await env.DB.prepare("SELECT kind,generation FROM operations WHERE id=?")
      .bind(recovery!.power_operation)
      .first(),
  ).toEqual({ kind: "database.hibernate", generation: scope.generation + 1 });
  expect(
    await env.DB.prepare(
      "SELECT clean_stop,sleep_json FROM database_runtime_holders WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({ clean_stop: 0, sleep_json: null });
  expect(
    await env.DB.prepare(
      "SELECT runtime_attestation_json FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first("runtime_attestation_json"),
  ).toBeNull();
  const detail = await request(
    `/agent/v1/pool-bindings/${scope.binding_id}`,
    f.agent,
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({
    binding: {
      binding: { state: "released" },
      authority: "revoked",
      permission: null,
      storage_authority: null,
    },
    node_report: {
      boot_loss: { holder_boot_id: scope.boot_id },
      clean_stop: false,
    },
    io_attestation: null,
  });
});

it("returns a complete candidate holder snapshot and retires only unclaimed qualification Pods during cleanup", async () => {
  const f = await qualificationPostgresPoolFixture({ prewake: "waiting" });
  const { recordPostgresPoolInventory } =
    await import("../../src/domain/postgres-pool.ts");
  const inventory = {
    v: 1 as const,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    qualification_run_id: f.qualificationRunId,
    qualification_scope_sha256: f.qualificationScopeHash,
    observed_at: Date.now(),
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  };
  await recordPostgresPoolInventory(env, f.node, inventory);
  const snapshot = await request(
    `/agent/v1/nodes/${f.node}/postgres-pool/bindings`,
    f.agent,
  );
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toMatchObject({
    v: 1,
    node_uid: f.nodeUid,
    bindings: [],
  });
  await env.DB.prepare(
    "UPDATE postgres_pool_qualification_runs SET status='cleanup' WHERE id=?",
  )
    .bind(f.qualificationRunId)
    .run();
  await recordPostgresPoolInventory(env, f.node, {
    ...inventory,
    observed_at: Date.now(),
    pods: [],
    idle_memory_current_bytes: 0,
  });
  expect(
    await env.DB.prepare("SELECT state FROM pool_pods WHERE pod_uid=?")
      .bind(f.pod.pool_pod_uid)
      .first("state"),
  ).toBe("retired");
  await expect(
    recordPostgresPoolInventory(env, f.node, {
      ...inventory,
      observed_at: Date.now(),
    }),
  ).rejects.toThrow();
});

it("does not reuse a qualification-owned free Pod for a normal pool wake", async () => {
  const f = await postgresPoolFixture();
  const pool = await import("../../src/domain/postgres-pool.ts");
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  // Controlled retained inventory inserted with its immutable qualification ownership;
  // do not rewrite an existing Pod's ownership or bypass its single-use trigger.
  await env.DB.prepare(
    "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at,qualification_run_id,qualification_scope_sha256,idle_cpu_millicores,idle_memory_mib) VALUES(?,?,?,?,?,?,'ready',?,?,?,?,?,?)",
  )
    .bind(
      f.pod.pool_pod_uid,
      f.node,
      f.nodeUid,
      f.proof.boot_id,
      1,
      JSON.stringify(f.pod),
      Date.now(),
      Date.now(),
      crypto.randomUUID(),
      "a".repeat(64),
      25,
      32,
    )
    .run();
  const { withAdmissionMutation } =
    await import("../../src/domain/admission-mutations.ts");
  const result = await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
      env,
      f.id,
      f.sleep.generation + 1,
      mutation,
    );
    const guard = mutation.guard(f.id);
    await mutation.batch([
      ...plan.statements,
      env.DB.prepare(
        `UPDATE databases SET desired_state='running',generation=generation+1 WHERE id=? AND ${guard.sql}`,
      ).bind(f.id, ...guard.bindings),
    ]);
    return plan.finish();
  });
  expect(result).toMatchObject({
    kind: "miss",
    reason: "no_eligible_free_pool_pod",
  });
});

it("claims an isolated candidate only from its active authoritative run and aborts a delayed claim after cleanup starts", async () => {
  const f = await qualificationPostgresPoolFixture();
  const pool = await import("../../src/domain/postgres-pool.ts"),
    { withAdmissionMutation } =
      await import("../../src/domain/admission-mutations.ts");
  const { postgresPoolCapable } =
    await import("../../src/domain/fleet-releases.ts");
  expect(await postgresPoolCapable(env.DB, f.region)).toBe(false);
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  await pool.recordPostgresPoolInventory(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    policy_revision: 1,
    qualification_run_id: f.qualificationRunId,
    qualification_scope_sha256: f.qualificationScopeHash,
    observed_at: Date.now(),
    pods: [f.pod],
    idle_memory_current_bytes: 32 * 1024 ** 2,
    idle_cpu_usage_usec: 12,
  });
  const before = (await env.DB.prepare(
    "SELECT generation FROM databases WHERE id=?",
  )
    .bind(f.id)
    .first<number>("generation"))!;
  let prepared = 0;
  await expect(
    withAdmissionMutation(env, [f.id], async (mutation) => {
      const plan = await pool.preparePostgresPoolClaim(
          env,
          f.id,
          before + 1,
          mutation,
        ),
        guard = mutation.guard(f.id);
      prepared = plan.statements.length;
      await env.DB.prepare(
        "UPDATE postgres_pool_qualification_runs SET status='cleanup' WHERE id=?",
      )
        .bind(f.qualificationRunId)
        .run();
      await mutation.batch([
        ...plan.statements,
        env.DB.prepare(
          `UPDATE databases SET desired_state='running',generation=generation+1 WHERE id=? AND ${guard.sql}`,
        ).bind(f.id, ...guard.bindings),
      ]);
    }),
  ).rejects.toThrow();
  expect(prepared).toBeGreaterThan(0);
  expect(
    await env.DB.prepare("SELECT generation FROM databases WHERE id=?")
      .bind(f.id)
      .first("generation"),
  ).toBe(before);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM pool_bindings WHERE database_id=?",
    )
      .bind(f.id)
      .first("count"),
  ).toBe(0);
});

it("refuses a pool physical readback for another LV than the frozen first-placement receipt", async () => {
  const f = await postgresPoolFixture({ thin: true });
  const { recordPostgresPoolStorageObservation } =
    await import("../../src/domain/postgres-pool.ts");
  await expect(
    recordPostgresPoolStorageObservation(env, f.id, {
      ...f.storageObservation,
      storage: {
        ...f.storageObservation.storage,
        lv_uuid: "dddddd-dddd-dddd-dddd-dddd-dddd-dddddd",
      },
    }),
  ).rejects.toThrow();
});
it("retains one immutable cleanup budget across polls and completes it only with verified physical release", async () => {
  const f = await claimedPostgresPoolFixture({
      thin: true,
      qualifiedThin: true,
    }),
    scope = f.binding.scope,
    now = Date.now();
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin custody missing");
  const requested = await request(
    `/v1/databases/${f.id}/roles`,
    f.integrator,
    "POST",
    { name: "cleanup_writer" },
    crypto.randomUUID(),
  );
  expect(requested.status).toBe(202);
  const op = ((await requested.json()) as { operation: { id: string } })
    .operation.id;
  expect(
    await env.DB.prepare("SELECT id FROM operations WHERE id=?")
      .bind(op)
      .first(),
  ).toBeNull();
  const claims = {
    v: 1,
    kid: "test",
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    holder_revision: f.binding.holder_revision,
    operation_id: op,
    cleanup_io_sha256: "a".repeat(64),
    holder_generation: scope.generation,
    database_generation: scope.generation,
    operation_target_generation: scope.generation + 1,
    authority_revision: 2,
    database_id: scope.database_id,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    storage: scope.storage,
    device_major: 253,
    device_minor: 1,
    allocation_reserve_bytes: 5 * 1024 ** 3,
    cleanup_mode: "drain_unmount",
    write_bytes_per_second: scope.storage.profile.write_bytes_per_second,
    write_iops_per_second: scope.storage.profile.write_iops_per_second,
    iat: now,
    exp: now + 5000,
  };

  await env.DB.prepare(
    "INSERT INTO pool_cleanup_grants(binding_id,operation_id,authority_revision,claims_json,issued_at,expires_at,allocation_reserve_bytes,headroom_authority_revision,headroom_snapshot_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)",
  )
    .bind(
      scope.binding_id,
      op,
      2,
      JSON.stringify(claims),
      now,
      now + 5000,
      claims.allocation_reserve_bytes,
      1,
      "a".repeat(64),
      now,
      now,
    )
    .run();
  const { readPostgresPoolCleanupGrant, recordPostgresPoolNodeReport } =
    await import("../../src/domain/postgres-pool.ts");
  expect(
    (await readPostgresPoolCleanupGrant(env, scope.binding_id, op))?.claims,
  ).toEqual(claims);
  await expect(
    env.DB.prepare(
      "UPDATE pool_cleanup_grants SET expires_at=expires_at+1 WHERE binding_id=?",
    )
      .bind(scope.binding_id)
      .run(),
  ).rejects.toThrow();
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
    (await readPostgresPoolCleanupGrant(env, scope.binding_id, op))?.state,
  ).toBe("completed");
});

it("binds pre-grant thin IO to the measured LV and every actual writer, and retains bounded detaching custody", async () => {
  const f = await claimedPostgresPoolFixture({ thin: true });
  const {
    recordPostgresPoolIoAttestation,
    readPostgresPoolIoAttestation,
    readPostgresPoolBinding,
  } = await import("../../src/domain/postgres-pool.ts");
  const scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin first placement missing");
  const device = {
    volume_group_uuid: scope.storage.volume_group_uuid,
    lv_uuid: scope.storage.lv_uuid,
    thin_id: scope.storage.thin_id,
    device_major: 253,
    device_minor: 1,
  };
  const value = {
    v: 1 as const,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_namespace_uid: scope.pool_namespace_uid,
    pool_pod_uid: scope.pool_pod_uid,
    observed_at: Date.now(),
    device,
    shared_pod_io: {
      pod_cgroup_inode: 11,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_bytes_per_second
          : 0,
      write_iops_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_iops_per_second
          : 0,
      io_max_verified: true as const,
      all_writer_cgroups_descendants: true as const,
    },
    cgroups: scope.container_ids.map((container_id, index) => ({
      container_id,
      cgroup_inode: 12 + index,
      pid: 26 + index,
      start_ticks: 42 + index,
      pid_namespace: 13,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_bytes_per_second
          : 0,
      write_iops_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_iops_per_second
          : 0,
      io_max_verified: true as const,
    })),
  };
  await expect(
    recordPostgresPoolIoAttestation(env, scope.binding_id, {
      ...value,
      device: { ...device, lv_uuid: "dddddd-dddd-dddd-dddd-dddd-dddd-dddddd" },
    }),
  ).rejects.toThrow();
  await expect(
    recordPostgresPoolIoAttestation(env, scope.binding_id, {
      ...value,
      cgroups: [value.cgroups[0]!],
    }),
  ).rejects.toThrow();
  await recordPostgresPoolIoAttestation(env, scope.binding_id, value);
  expect(await readPostgresPoolIoAttestation(env, f.binding)).toEqual(value);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pool_bindings SET state='detaching',updated_at=?,detaching_at=? WHERE id=?",
    ).bind(Date.now(), Date.now(), scope.binding_id),
    env.DB.prepare(
      "UPDATE database_runtime_holders SET state='detaching',updated_at=? WHERE binding_id=?",
    ).bind(Date.now(), scope.binding_id),
    env.DB.prepare(
      "UPDATE databases SET generation=generation+1 WHERE id=?",
    ).bind(f.id),
  ]);
  const draining = (await readPostgresPoolBinding(env, scope.binding_id))!;
  await recordPostgresPoolIoAttestation(env, scope.binding_id, {
    ...value,
    observed_at: Date.now(),
  });
  expect((await readPostgresPoolIoAttestation(env, draining))?.device).toEqual(
    device,
  );
  await env.DB.prepare("UPDATE pool_bindings SET state='failed' WHERE id=?")
    .bind(scope.binding_id)
    .run();
  await expect(
    recordPostgresPoolIoAttestation(env, scope.binding_id, {
      ...value,
      observed_at: Date.now(),
    }),
  ).rejects.toThrow();
});

it("issues real pre-grant sa1 only from current qualified thin custody, actual IO and a full startup hold", async () => {
  const f = await claimedPostgresPoolFixture({
    thin: true,
    qualifiedThin: true,
  });
  const { issuePostgresPoolStorageAuthority } =
    await import("../../src/domain/node-thin-storage.ts");
  const { recordPostgresPoolIoAttestation } =
    await import("../../src/domain/postgres-pool.ts");
  const { verifyStorageWriteAuthority } =
    await import("@pgcf/contracts/storage-write-authority");
  const { importBootstrapVerificationKeys } =
    await import("@pgcf/contracts/bootstrap-relay");
  const scope = f.binding.scope;
  if (scope.storage.backend !== "lvm-thin-v1")
    throw new Error("Thin fixture missing");
  expect(f.proof.cluster_uid).not.toBe(f.volume.cluster_uid);
  expect(
    await issuePostgresPoolStorageAuthority(env, f.binding),
  ).toBeUndefined();
  const profile = scope.storage.profile,
    device = {
      volume_group_uuid: scope.storage.volume_group_uuid,
      lv_uuid: scope.storage.lv_uuid,
      thin_id: scope.storage.thin_id,
      device_major: 253,
      device_minor: 1,
    };
  await recordPostgresPoolIoAttestation(env, scope.binding_id, {
    v: 1,
    binding_id: scope.binding_id,
    scope_sha256: f.binding.scope_sha256,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_namespace_uid: scope.pool_namespace_uid,
    pool_pod_uid: scope.pool_pod_uid,
    observed_at: Date.now(),
    device,
    shared_pod_io: {
      pod_cgroup_inode: 11,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_bytes_per_second
          : 0,
      write_iops_per_second:
        scope.storage.backend === "lvm-thin-v1"
          ? scope.storage.profile.write_iops_per_second
          : 0,
      io_max_verified: true as const,
      all_writer_cgroups_descendants: true as const,
    },
    cgroups: scope.container_ids.map((container_id, index) => ({
      container_id,
      cgroup_inode: 12 + index,
      pid: 26 + index,
      start_ticks: 42 + index,
      pid_namespace: 13,
      device_major: 253,
      device_minor: 1,
      write_bytes_per_second: profile.write_bytes_per_second,
      write_iops_per_second: profile.write_iops_per_second,
      io_max_verified: true,
    })),
  });
  const token = await issuePostgresPoolStorageAuthority(env, f.binding);
  expect(token).toBeTypeOf("string");
  expect(
    await verifyStorageWriteAuthority(
      token!,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
    ),
  ).toMatchObject({
    generation: scope.generation,
    pod_uid: scope.pool_pod_uid,
    lv_uuid: scope.storage.lv_uuid,
    write_allowed: true,
  });
  await env.DB.prepare(
    "DELETE FROM database_start_admissions WHERE database_id=?",
  )
    .bind(f.id)
    .run();
  expect(
    await issuePostgresPoolStorageAuthority(env, f.binding),
  ).toBeUndefined();
});

it("cannot certify a served binding as never attached after losing its mounted report", async () => {
  const f = await servingPostgresPoolFixture();
  const { recordPostgresPoolNodeReport } =
    await import("../../src/domain/postgres-pool.ts");
  await recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, {
    ...f.mounted,
    state: "lost",
    observed_at: Date.now(),
    error: "current mount report lost",
  });
  const refused = {
    ...f.mounted,
    state: "refused" as const,
    observed_at: Date.now(),
    clean_stop: null,
    kernel_proof: {
      ...f.mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      exclusive_superblock_creation: false,
      nonlazy_unmount_verified: false,
      never_attached_verified: true,
    },
  };
  await expect(
    recordPostgresPoolNodeReport(env, f.binding.scope.binding_id, refused),
  ).rejects.toThrow();
  expect(
    await env.DB.prepare("SELECT state FROM pool_bindings WHERE id=?")
      .bind(f.binding.scope.binding_id)
      .first("state"),
  ).toBe("lost");
});
it("publishes serving thin custody only with its current real sa1 and measured shared Pod budget", async () => {
  const f = await servingPostgresPoolFixture({ thin: true });
  const { readPostgresPoolAdmissionBinding } =
    await import("../../src/domain/postgres-pool.ts");
  expect(
    f.mounted.thin_guard?.shared_pod_io.all_writer_cgroups_descendants,
  ).toBe(true);
  expect(
    await readPostgresPoolAdmissionBinding(env, f.id, f.proof),
  ).toMatchObject({ state: "serving", scope_sha256: f.binding.scope_sha256 });
});

it("clears Ready for the exact released pool writer before legacy admission can reopen", async () => {
  const f = await servingPostgresPoolFixture();
  const { recordPostgresPoolNodeReport } =
    await import("../../src/domain/postgres-pool.ts");
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
    },
  });
  expect(
    await env.DB.prepare(
      "SELECT observed_state,observed_power,runtime_attestation_json FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual({
    observed_state: "provisioning",
    observed_power: "hibernated",
    runtime_attestation_json: null,
  });
});

afterEach(async () => {
  await cleanupFixtures();
  for (const id of admissionFixtureReleases)
    await env.DB.prepare(
      "DELETE FROM postgres_pool_qualification_runs WHERE candidate_release_id=?",
    )
      .bind(id)
      .run();
  for (const id of admissionFixtureReleases)
    await env.DB.prepare(
      "DELETE FROM postgres_pool_qualification_receipts WHERE candidate_release_id=?",
    )
      .bind(id)
      .run();
  for (const id of admissionFixtureReleases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});

it("omits pool-only wire and component names for a confirmed candidate without the full capability", async () => {
  const f = await admissionSnapshotFixture();
  const existing = await env.DB.prepare(
    "SELECT spec_json FROM fleet_releases WHERE id=?",
  )
    .bind(f.releaseId)
    .first<string>("spec_json");
  const spec = FleetReleaseSpec.parse(JSON.parse(existing!));
  const component = {
    name: "pool-supervisor",
    kind: "image" as const,
    version: "1.0.0",
    reference: "registry.example/pool-supervisor@sha256:" + "a".repeat(64),
    sha256: "a".repeat(64),
  };
  const candidate = FleetReleaseSpec.parse({
    ...spec,
    components: [...spec.components, component],
    roles: {
      control_relay: {
        ...spec.roles.control_relay,
        components: [...spec.roles.control_relay.components, "pool-supervisor"],
      },
      customer: {
        ...spec.roles.customer,
        components: [...spec.roles.customer.components, "pool-supervisor"],
      },
    },
  });
  const id = "pool-candidate-" + crypto.randomUUID();
  const response = await request(
    `/v1/fleet/releases/${id}`,
    f.admin,
    "PUT",
    candidate,
  );
  expect(response.status).toBe(200);
  admissionFixtureReleases.push(id);
  const approved = (await response.json()) as { spec_sha256: string };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=? WHERE region_id=?",
    ).bind(id, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(id, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=? WHERE operation_id=?",
    ).bind(id, approved.spec_sha256, f.patchId),
  ]);
  const desired = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(desired.region.postgres_pools).toBeUndefined();
  expect(
    desired.databases.find((db) => db.id === f.id)?.pool_binding,
  ).toBeUndefined();
  expect(
    desired.fleet_release?.release.spec.components.map((c) => c.name),
  ).not.toContain("pool-supervisor");
  expect(
    desired.fleet_release?.release.spec.roles.customer.components,
  ).not.toContain("pool-supervisor");
});

it("persists one immutable physical binding and prevents state rollback or a second active holder", async () => {
  const f = await admissionSnapshotFixture();
  const pod = crypto.randomUUID(),
    now = Date.now();
  await env.DB.prepare(
    "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,'{}','claimed',?,?)",
  )
    .bind(pod, f.node, f.nodeUid, f.proof.boot_id, now, now)
    .run();
  const binding = crypto.randomUUID();
  const insert = (id: string) =>
    env.DB.prepare(
      "INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1,1,?,'{}','claimed',?,?)",
    ).bind(
      id,
      f.id,
      f.node,
      f.nodeUid,
      f.proof.boot_id,
      pod,
      "a".repeat(64),
      now,
      now,
    );
  await insert(binding).run();
  await expect(insert(crypto.randomUUID()).run()).rejects.toThrow();
  await expect(
    env.DB.prepare("UPDATE pool_bindings SET scope_sha256=? WHERE id=?")
      .bind("b".repeat(64), binding)
      .run(),
  ).rejects.toThrow();
  await env.DB.prepare("UPDATE pool_bindings SET state='mounted' WHERE id=?")
    .bind(binding)
    .run();
  await expect(
    env.DB.prepare("UPDATE pool_bindings SET state='claimed' WHERE id=?")
      .bind(binding)
      .run(),
  ).rejects.toThrow();
});

it("claims a compatible Pod with the wake in one fenced D1 batch and never renews stale route authority", async () => {
  const { postgresPoolFixture } = await import("./postgres-pool-fixture.ts");
  const f = await postgresPoolFixture();
  const pool = await import("../../src/domain/postgres-pool.ts");
  const { withAdmissionMutation } =
    await import("../../src/domain/admission-mutations.ts");
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  await pool.recordPostgresPoolInventory(env, f.node, {
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
  let result:
    | Awaited<
        ReturnType<
          Awaited<ReturnType<typeof pool.preparePostgresPoolClaim>>["finish"]
        >
      >
    | undefined;
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
        env,
        f.id,
        f.desired.generation + 1,
        mutation,
      ),
      guard = mutation.guard(f.id);
    await mutation.batch([
      ...plan.statements,
      env.DB.prepare(
        `UPDATE databases SET desired_state='running',observed_state='provisioning',generation=generation+1 WHERE id=? AND ${guard.sql}`,
      ).bind(f.id, ...guard.bindings),
    ]);
    result = await plan.finish();
  });
  expect(result?.kind).toBe("hit");
  if (result?.kind !== "hit") throw new Error("Pool claim failed");
  const claimed = result.binding;
  expect(claimed.scope.generation).toBe(f.desired.generation + 1);
  expect(claimed.scope.pool_pod_uid).toBe(f.pod.pool_pod_uid);
  const holder = await env.DB.prepare(
    "SELECT kind,binding_id,state FROM database_runtime_holders WHERE database_id=?",
  )
    .bind(f.id)
    .first();
  expect(holder).toEqual({
    kind: "pool",
    binding_id: claimed.scope.binding_id,
    state: "claimed",
  });
  expect(
    (await pool.readDesiredPostgresPoolBinding(env, f.id))?.permission,
  ).toBeTruthy();
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    await mutation.batch([]);
  });
  expect(
    (await pool.readDesiredPostgresPoolBinding(env, f.id))?.permission,
  ).toBeNull();
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
      env,
      f.id,
      f.desired.generation + 2,
      mutation,
    );
    expect((await plan.finish()).kind).toBe("blocked");
    await mutation.batch([]);
  });
});

it("keeps a lost holder blocking until complete authenticated cleanup, including the CNPG wake guard", async () => {
  const f = await admissionSnapshotFixture(),
    now = Date.now(),
    binding = crypto.randomUUID();
  const pods = [crypto.randomUUID(), crypto.randomUUID()];
  for (const pod of pods)
    await env.DB.prepare(
      "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,'{}','claimed',?,?)",
    )
      .bind(pod, f.node, f.nodeUid, f.proof.boot_id, now, now)
      .run();
  const insert = (id: string, pod: string, state: string) =>
    env.DB.prepare(
      "INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,scope_sha256,scope_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1,1,?,'{}',?,?,?)",
    ).bind(
      id,
      f.id,
      f.node,
      f.nodeUid,
      f.proof.boot_id,
      pod,
      "a".repeat(64),
      state,
      now,
      now,
    );
  await insert(binding, pods[0]!, "lost").run();
  const { postgresPoolCnpgWakeGuard } =
    await import("../../src/domain/postgres-pool.ts");
  const guard = postgresPoolCnpgWakeGuard(f.id);
  expect(
    await env.DB.prepare(`SELECT id FROM databases WHERE id=? AND ${guard.sql}`)
      .bind(f.id, ...guard.bindings)
      .first(),
  ).toBeNull();
  await expect(
    insert(crypto.randomUUID(), pods[1]!, "claimed").run(),
  ).rejects.toThrow();
});

it("exposes the Pod policy through the canonical discriminated compute-pool API without two active idle budgets", async () => {
  const { postgresPoolFixture } = await import("./postgres-pool-fixture.ts");
  const f = await postgresPoolFixture();
  const before = await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first();
  const response = await request(
    `/v1/nodes/${f.node}/compute-pool`,
    f.admin,
    "PUT",
    {
      expected_revision: 1,
      node_uid: f.nodeUid,
      policy: { ...f.policy, target_slots: 2 },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    revision: 2,
    policy: { kind: "postgres_pods", target_slots: 2 },
  });
  expect(
    await (await request(`/v1/nodes/${f.node}/compute-pool`, f.admin)).json(),
  ).toMatchObject({ revision: 2, policy: { kind: "postgres_pods" } });
  expect(
    await env.DB.prepare(
      "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  const { readDesiredFleetRelease } =
      await import("../../src/domain/fleet-releases.ts"),
    projected = (await readDesiredFleetRelease(env.DB, f.region))!;
  expect(
    projected.release.spec.components.some((c) => c.name === "pool-supervisor"),
  ).toBe(true);
  for (const role of Object.values(projected.release.spec.roles))
    expect(role.components).not.toContain("pool-supervisor");
  const qualified = FleetReleaseSpec.parse(
    JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.poolReleaseId)
        .first<string>("spec_json"))!,
    ),
  );
  qualified.roles.customer.components =
    qualified.roles.customer.components.filter(
      (name) => name !== "pool-supervisor",
    );
  expect(FleetReleaseSpec.safeParse(qualified).success).toBe(false);
  const nativeDesired = await request("/agent/v1/desired", f.agent);
  expect(nativeDesired.status).toBe(200);
  expect(
    DesiredResponse.parse(await nativeDesired.json()).region.postgres_pools?.[0]
      ?.policy.kind,
  ).toBe("postgres_pods");
});

it("delivers a verified committed binding to the actual held node request without a D1 polling loop", async () => {
  const { postgresPoolFixture } = await import("./postgres-pool-fixture.ts");
  const f = await postgresPoolFixture();
  const pool = await import("../../src/domain/postgres-pool.ts"),
    { withAdmissionMutation } =
      await import("../../src/domain/admission-mutations.ts");
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  await pool.recordPostgresPoolInventory(env, f.node, {
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
  const link = env.REGION_LINK.get(env.REGION_LINK.idFromName(f.region));
  const waiting = link.waitForPoolBinding(f.node, 0, Date.now() + 1000);
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
        env,
        f.id,
        f.desired.generation + 1,
        mutation,
      ),
      guard = mutation.guard(f.id);
    await mutation.batch([
      ...plan.statements,
      env.DB.prepare(
        `UPDATE databases SET desired_state='running',observed_state='provisioning',generation=generation+1 WHERE id=? AND ${guard.sql}`,
      ).bind(f.id, ...guard.bindings),
    ]);
    expect((await plan.finish()).kind).toBe("hit");
  });
  const delivered = await waiting;
  expect(delivered?.bindings).toHaveLength(1);
  expect(delivered?.bindings[0]?.binding.scope.pool_pod_uid).toBe(
    f.pod.pool_pod_uid,
  );
  expect(delivered?.bindings[0]?.authority).toBe("current");
  expect(delivered?.bindings[0]?.permission).toBeTruthy();
});

it("coalesces actual capable Actor cold wakes into one pool holder and returns the verified pool target", async () => {
  const { postgresPoolFixture } = await import("./postgres-pool-fixture.ts");
  const f = await postgresPoolFixture();
  const pool = await import("../../src/domain/postgres-pool.ts"),
    { publishDatabaseAdmission } =
      await import("../../src/domain/database-admission-snapshot.ts");
  const { PoolBinding, PoolBindingScope } =
      await import("@pgcf/contracts/postgres-pool"),
    { DatabasePoolRuntimeAttestationV2 } =
      await import("@pgcf/contracts/reclaim");
  await env.DB.prepare(
    "UPDATE databases SET suspension_reason='idle' WHERE id=?",
  )
    .bind(f.id)
    .run();
  await pool.recordPostgresPoolStorageObservation(
    env,
    f.id,
    f.storageObservation,
  );
  await pool.recordPostgresPoolSleep(env, f.id, f.sleep);
  await pool.recordPostgresPoolInventory(env, f.node, {
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
  await publishDatabaseAdmission(env, f.id);
  const actor = env.DATABASE_ACTOR.get(env.DATABASE_ACTOR.idFromName(f.id));
  const user = presentRoles(f.desired).find((role) => role.owner)!.name;
  const waking = [actor.ensureAwake(f.id, user), actor.ensureAwake(f.id, user)];
  const completed = Promise.all(waking);
  completed.catch(() => undefined);
  let generation = f.desired.generation;
  for (let i = 0; i < 50 && generation === f.desired.generation; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    generation = (await env.DB.prepare(
      "SELECT generation FROM databases WHERE id=?",
    )
      .bind(f.id)
      .first<number>("generation"))!;
  }
  expect(generation).toBe(f.desired.generation + 1);
  const raw = await env.DB.prepare(
    "SELECT * FROM pool_bindings WHERE database_id=?",
  )
    .bind(f.id)
    .first<Record<string, unknown>>();
  const epoch = (await env.DB.prepare(
    "SELECT admission_revision,route_revision FROM database_admission_epochs WHERE database_id=?",
  )
    .bind(f.id)
    .first<{ admission_revision: number; route_revision: number }>())!;
  const now = Date.now();
  let proof:
    typeof f.proof | ReturnType<typeof DatabasePoolRuntimeAttestationV2.parse> =
    {
      ...f.proof,
      generation,
      admission_epoch: epoch.admission_revision,
      route_revision: epoch.route_revision,
      observed_at: now,
      observation: {
        ...f.proof.observation,
        verified_at: now,
        expires_at: now + 60000,
      },
    };
  if (raw) {
    const scope = PoolBindingScope.parse(JSON.parse(raw.scope_json as string)),
      binding = PoolBinding.parse({
        v: 1,
        scope,
        scope_sha256: raw.scope_sha256,
        holder_revision: raw.holder_revision,
        state: raw.state,
        created_at: raw.created_at,
        updated_at: raw.updated_at,
      });
    await pool.recordPostgresPoolNodeReport(env, scope.binding_id, {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_pod_uid: scope.pool_pod_uid,
      state: "mounted",
      observed_at: now,
      clean_stop: null,
      error: null,
      storage_backend: "lvm-thick-v1",
      thin_guard: null,
      kernel_proof: {
        device_major: 253,
        device_minor: 1,
        mount_id: 42,
        dm_open_count: 1,
        foreign_mounts: 0,
        complete_namespace_scan: false,
        named_namespace_scan_complete: true,
        zero_before_bind: true,
        exclusive_superblock_creation: true,
        nonlazy_unmount_verified: false,
        never_attached_verified: false,
        creator_fence: {
          v: 1,
          scope_sha256: binding.scope_sha256,
          storage_uid: scope.storage.storage_uid,
          volume_handle: scope.storage.volume_handle,
          volume_group_uuid: scope.storage.volume_group_uuid,
          lv_uuid: scope.storage.lv_uuid,
          driver_gate_protocol: 1,
          driver_image: scope.driver_image,
          driver_sha256: scope.driver_sha256,
          deny_record_durable: true,
          csi_node_publish_serialized: true,
          csi_node_expand_serialized: true,
          creation_fds_closed: true,
        },
        mountpoint: {
          pool_pod_uid: scope.pool_pod_uid,
          root_uid: 0,
          mode: 493,
          tmpfs: true,
          opened_beneath: true,
          symlink_free: true,
        },
      },
    });
    const poolProof = DatabasePoolRuntimeAttestationV2.parse({
      ...proof,
      kind: "pool",
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      holder_revision: binding.holder_revision,
      pool_namespace_uid: scope.pool_namespace_uid,
      pool_namespace_resource_version: "81",
      pod_uid: scope.pool_pod_uid,
      pod_ip: scope.pool_pod_ip,
      container_id: scope.container_id,
    });
    proof = poolProof;
    await pool.recordPostgresPoolServing(env, scope.binding_id, poolProof, {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      bundle_nonce: scope.bundle_nonce,
      state: "ready",
      system_identifier: scope.system_identifier,
      timeline: scope.timeline,
      control_state: "in production",
      postmaster_pid: 26,
      postgres_started_at: now,
      readiness_at: now,
      observed_at: now,
      error: null,
    });
  }
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation,runtime_attestation_json=? WHERE id=?",
  )
    .bind(JSON.stringify(proof), f.id)
    .run();
  await publishDatabaseAdmission(env, f.id);
  const admitted = await completed;
  expect(admitted[0]).toMatchObject({
    ok: true,
    target: {
      kind: "pool",
      revision: generation,
      route_revision: epoch.route_revision,
      pod_uid: f.pod.pool_pod_uid,
    },
  });
  expect(admitted[1]).toEqual(admitted[0]);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM pool_bindings WHERE database_id=?",
    )
      .bind(f.id)
      .first<number>("count"),
  ).toBe(1);
});

it("keeps a serving binding across a verified CA-only current route while refusing its stale admission proof", async () => {
  const { servingPostgresPoolFixture } =
      await import("./postgres-pool-fixture.ts"),
    f = await servingPostgresPoolFixture();
  const { readPostgresPoolAdmissionBinding } =
    await import("../../src/domain/postgres-pool.ts");
  expect(
    await readPostgresPoolAdmissionBinding(env, f.id, f.proof),
  ).not.toBeNull();
  // Controlled committed CA-only barrier metadata, with the same immutable volume holder.
  await env.DB.prepare(
    "UPDATE database_admission_epochs SET admission_revision=admission_revision+1,route_revision=route_revision+1 WHERE database_id=?",
  )
    .bind(f.id)
    .run();
  expect(await readPostgresPoolAdmissionBinding(env, f.id, f.proof)).toBeNull();
  const now = Date.now(),
    proof = {
      ...f.proof,
      route_revision: f.proof.route_revision + 1,
      admission_epoch: f.proof.admission_epoch + 1,
      ca_secret_resource_version: "82",
      ca_sha256: "b".repeat(64),
      observed_at: now,
      observation: {
        ...f.proof.observation,
        verified_at: now,
        expires_at: now + 60000,
        resource_versions: {
          ...f.proof.observation.resource_versions,
          ca_secret: "82",
        },
      },
    };
  expect(
    (await readPostgresPoolAdmissionBinding(env, f.id, proof))?.scope
      .binding_id,
  ).toBe(f.binding.scope.binding_id);
});
