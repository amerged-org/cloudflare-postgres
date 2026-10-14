// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  PostgresPoolQualificationScope,
  PostgresPoolQualificationReport,
  PostgresPoolQualificationMeasurement,
  PostgresPoolQualificationProgressReport,
  postgresPoolQualificationGatePassed,
  postgresPoolQualificationScopeHash,
  postgresPoolQualificationProgressHash,
  signPoolQualificationPermission,
  verifyPoolQualificationPermission,
} from "../src/postgres-pool-qualification.ts";

import {
  qualificationScopeFixture,
  qualificationHostFixture,
  qualificationOrdinaryIoFixture,
} from "./postgres-pool-qualification.fixture.ts";

it("scopes qualification to one thin volume, physical node and candidate", () => {
  const scope = qualificationScopeFixture();
  expect(PostgresPoolQualificationScope.safeParse(scope).success).toBe(true);
  const changed = structuredClone(scope);
  changed.storage.node_uid = "00000000-0000-4000-8000-000000000099";
  expect(PostgresPoolQualificationScope.safeParse(changed).success).toBe(false);
  const otherPool = structuredClone(scope);
  otherPool.volume.pool_uuid = otherPool.volume.lv_uuid;
  expect(PostgresPoolQualificationScope.safeParse(otherPool).success).toBe(
    false,
  );
  const otherClaim = structuredClone(scope);
  otherClaim.volume.volume_handle = `pvc-${otherClaim.volume.pv_uid}`;
  expect(PostgresPoolQualificationScope.safeParse(otherClaim).success).toBe(
    false,
  );
  expect(
    PostgresPoolQualificationScope.safeParse({ ...scope, passed: true })
      .success,
  ).toBe(false);
});

it("refuses a device ID the pinned dm-thin kernel cannot address", () => {
  const scope = qualificationScopeFixture();
  expect(
    PostgresPoolQualificationScope.safeParse({ ...scope, thin_id: 1 << 24 })
      .success,
  ).toBe(false);
  expect(
    PostgresPoolQualificationScope.safeParse({
      ...scope,
      thin_id: (1 << 24) - 1,
    }).success,
  ).toBe(true);
});

it("requires measured challenge evidence rather than caller-supplied gate decisions", () => {
  const scope = qualificationScopeFixture();
  expect(
    PostgresPoolQualificationReport.safeParse({
      run_id: scope.run_id,
      scope_sha256: "b".repeat(64),
      sequence: 1,
      nonce: "a".repeat(32),
      producer: "node_agent",
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      candidate_spec_sha256: scope.candidate_spec_sha256,
      started_at: 1,
      observed_at: 2,
      measurement: { gate: "thin_expiry_protection", passed: true },
    }).success,
  ).toBe(false);
});

it("derives thin expiry protection from bounded drain and unchanged device counters", () => {
  const scope = PostgresPoolQualificationScope.parse(
    qualificationScopeFixture(),
  );
  const measured = {
    gate: "thin_expiry_protection" as const,
    binding_id: scope.run_id,
    authority_expires_at: 1_000,
    protection_requested_at: 1_010,
    drained_at: 2_000,
    postmaster_pid: null,
    device_state: "suspended" as const,
    sectors_written_before: 41,
    sectors_written_after: 41,
    allocated_blocks_before: 17,
    allocated_blocks_after: 17,
  };
  expect(postgresPoolQualificationGatePassed(scope, measured)).toBe(true);
  expect(
    postgresPoolQualificationGatePassed(scope, {
      ...measured,
      sectors_written_after: 42,
    }),
  ).toBe(false);
  expect(
    postgresPoolQualificationGatePassed(scope, {
      ...measured,
      drained_at: 1_000 + scope.storage.drain_seconds * 1_000 + 1,
    }),
  ).toBe(false);
});

it("refuses equal foreign namespaces and operation names without measured durable denial", async () => {
  const scope = PostgresPoolQualificationScope.parse(
    qualificationScopeFixture(),
  );
  expect(
    postgresPoolQualificationGatePassed(scope, {
      ...(await qualificationHostFixture(
        scope,
        await postgresPoolQualificationScopeHash(scope),
        "a".repeat(32),
        1000,
      )),
      caller_pid_namespace_inode: 999,
      initial_pid_namespace_inode: 999,
      caller_user_namespace_inode: 998,
      initial_user_namespace_inode: 998,
      next_namespace_errno: 0,
    }),
  ).toBe(false);
  expect(
    PostgresPoolQualificationReport.safeParse({
      run_id: scope.run_id,
      scope_sha256: "b".repeat(64),
      sequence: 2,
      nonce: "a".repeat(32),
      producer: "node_agent",
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      candidate_spec_sha256: scope.candidate_spec_sha256,
      started_at: 1,
      observed_at: 2,
      measurement: {
        gate: "finite_creator_fence",
        binding_id: scope.run_id,
        deny_record_inode_before_restart: 3,
        deny_record_inode_after_restart: 3,
        deny_record_fsync_errno: 0,
        driver_restarts: 1,
        denied_operations: [
          "node_publish",
          "node_expand",
          "volume_create",
          "snapshot_create",
        ],
        surviving_creation_descriptors: 0,
      },
    }).success,
  ).toBe(false);
});

it("preserves an unknown Barman backup size while requiring the actual completed catalog", () => {
  expect(
    PostgresPoolQualificationMeasurement.safeParse({
      gate: "base_backup",
      binding_id: qualificationScopeFixture().run_id,
      system_identifier: "7412345678901234567",
      timeline: 1,
      backup_id: "20261014T230000",
      catalog_state: "DONE",
      completed_at: 1,
      catalog_sha256: "a".repeat(64),
      bytes: null,
    }).success,
  ).toBe(true);
});

it("signs only a bounded current qualification challenge and detects tampering and expiry", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw Error("Expected actual Ed25519 key pair");
  const now = Date.now(),
    scope = PostgresPoolQualificationScope.parse(qualificationScopeFixture()),
    scopeHash = await postgresPoolQualificationScopeHash(scope),
    claims = {
      v: 1 as const,
      kid: "test-cf",
      scope,
      scope_sha256: scopeHash,
      challenge: {
        run_id: scope.run_id,
        scope_sha256: scopeHash,
        sequence: 1,
        nonce: "a".repeat(32),
        producer: "node_agent" as const,
        gate: "host_mount_context" as const,
        issued_at: now,
        expires_at: now + 60_000,
      },
      execution: {
        node_uid: scope.node_uid,
        boot_id: scope.boot_id,
        candidate_release_id: scope.candidate_release_id,
        candidate_spec_sha256: scope.candidate_spec_sha256,
        verifier_keys_sha256: "9".repeat(64),
        driver_pod_uid: "00000000-0000-4000-8000-000000000099",
        driver_image: scope.software.driver_image,
        driver_sha256: scope.software.driver_sha256,
        host_extension_image: scope.software.host_extension_image,
        host_controller_sha256: scope.software.host_controller_sha256,
        kernel_version: scope.software.kernel_version,
      },
      preparation_sha256: null,
      progress_sha256: await postgresPoolQualificationProgressHash([]),
      iat: now,
      exp: now + 30_000,
    },
    token = await signPoolQualificationPermission(claims, pair.privateKey, now),
    keys = new Map([["test-cf", pair.publicKey]]);
  expect(
    (await verifyPoolQualificationPermission(token, keys, now))?.scope.run_id,
  ).toBe(scope.run_id);
  expect(
    await verifyPoolQualificationPermission(
      token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"),
      keys,
      now,
    ),
  ).toBeNull();
  expect(
    await verifyPoolQualificationPermission(token, keys, now + 30_000),
  ).toBeNull();
  await expect(
    signPoolQualificationPermission(
      { ...claims, exp: now + 30_001 },
      pair.privateKey,
      now,
    ),
  ).rejects.toThrow();
  const prepared = await signPoolQualificationPermission(
    { ...claims, preparation_sha256: "a".repeat(64) },
    pair.privateKey,
    now,
  );
  expect(
    (await verifyPoolQualificationPermission(prepared, keys, now))
      ?.preparation_sha256,
  ).toBe("a".repeat(64));
});

it("refuses configured IO tuples without a measured paired scratch experiment", () => {
  const s = qualificationScopeFixture();
  expect(
    PostgresPoolQualificationMeasurement.safeParse({
      gate: "thin_io_limits",
      binding_id: s.run_id,
      device_major: 253,
      device_minor: 2,
      writer_cgroups: [
        {
          container_id: "a".repeat(64),
          cgroup_inode: 4,
          pid: 12,
          start_ticks: 13,
          pid_namespace: 0xeffffffc,
          device_major: 253,
          device_minor: 2,
          write_bytes_per_second: s.storage.write_bytes_per_second,
          write_iops_per_second: s.storage.write_iops_per_second,
        },
      ],
    }).success,
  ).toBe(false);
});

it("requires equal direct work, both writer counters and unchanged inherited caps", () => {
  const s = PostgresPoolQualificationScope.parse(qualificationScopeFixture()),
    measured = PostgresPoolQualificationMeasurement.parse({
      gate: "thin_io_limits",
      binding_id: s.run_id,
      device_major: 253,
      device_minor: 2,
      ordinary_direct_io: qualificationOrdinaryIoFixture(s),
      writer_cgroups: ["a", "b"].map((id, i) => ({
        container_id: id.repeat(64),
        cgroup_inode: 4 + i,
        pid: 12 + i,
        start_ticks: 13 + i,
        pid_namespace: 0xeffffffc,
        device_major: 253,
        device_minor: 2,
        write_bytes_per_second: s.storage.write_bytes_per_second,
        write_iops_per_second: s.storage.write_iops_per_second,
      })),
    });
  expect(postgresPoolQualificationGatePassed(s, measured)).toBe(true);
  if (measured.gate !== "thin_io_limits" || "failure_code" in measured)
    throw Error("Expected IO vector");
  const reset = structuredClone(measured);
  reset.ordinary_direct_io.capped.writers[0]!.after.wbytes =
    reset.ordinary_direct_io.capped.writers[0]!.before.wbytes - 1;
  expect(postgresPoolQualificationGatePassed(s, reset)).toBe(false);
  const changed = structuredClone(measured);
  changed.ordinary_direct_io.inherited_limits_after[0]!.write_bytes_per_second =
    null;
  expect(postgresPoolQualificationGatePassed(s, changed)).toBe(false);
  const unfinished = structuredClone(measured);
  unfinished.ordinary_direct_io.capped.writers[1]!.completed_bytes = 0;
  expect(postgresPoolQualificationGatePassed(s, unfinished)).toBe(false);
  const ineffective = structuredClone(measured);
  ineffective.ordinary_direct_io.capped.end_offset_nanoseconds =
    ineffective.ordinary_direct_io.capped.start_offset_nanoseconds + 500000000;
  expect(postgresPoolQualificationGatePassed(s, ineffective)).toBe(false);
  const jitter = structuredClone(measured);
  jitter.ordinary_direct_io.capped.end_offset_nanoseconds =
    jitter.ordinary_direct_io.capped.start_offset_nanoseconds +
    jitter.ordinary_direct_io.baseline.end_offset_nanoseconds -
    jitter.ordinary_direct_io.baseline.start_offset_nanoseconds +
    1;
  expect(postgresPoolQualificationGatePassed(s, jitter)).toBe(false);
  const tooSmall = structuredClone(measured);
  tooSmall.ordinary_direct_io.scratch_file_bytes = 8192;
  tooSmall.ordinary_direct_io.workers.forEach((w) => {
    w.work_bytes = 4096;
  });
  for (const phase of [
    tooSmall.ordinary_direct_io.baseline,
    tooSmall.ordinary_direct_io.capped,
  ])
    phase.writers.forEach((w) => {
      w.completed_bytes = 4096;
    });
  expect(postgresPoolQualificationGatePassed(s, tooSmall)).toBe(false);
  const transient = structuredClone(measured);
  transient.ordinary_direct_io.baseline.end_offset_nanoseconds = 100000000;
  transient.ordinary_direct_io.capped.start_offset_nanoseconds = 110000000;
  transient.ordinary_direct_io.capped.end_offset_nanoseconds = 410000000;
  expect(postgresPoolQualificationGatePassed(s, transient)).toBe(false);
  const notClean = structuredClone(measured);
  notClean.ordinary_direct_io.remaining_probe_descriptors = 1;
  expect(postgresPoolQualificationGatePassed(s, notClean)).toBe(false);
});

it("allows the finite creator experiment before any tenant binding exists", async () => {
  const s = PostgresPoolQualificationScope.parse(qualificationScopeFixture()),
    m = {
      gate: "finite_creator_fence" as const,
      binding_id: null,
      source_generation: s.database_generation - 1,
      volume_handle: s.volume.volume_handle,
      driver_sha256: s.software.driver_sha256,
      deny_record_inode_before_restart: 42,
      deny_record_inode_after_restart: 42,
      deny_record_sha256_before_restart: "a".repeat(64),
      deny_record_sha256_after_restart: "a".repeat(64),
      deny_record_scope_sha256: await postgresPoolQualificationScopeHash(s),
      deny_record_fsync_errno: 0,
      driver_restarts: 1,
      driver_pod_uid_before_restart: "00000000-0000-4000-8000-000000000091",
      driver_pod_uid_after_restart: "00000000-0000-4000-8000-000000000092",
      driver_daemonset_uid: "00000000-0000-4000-8000-000000000093",
      driver_image: s.software.driver_image,
      driver_deleted_at: 1000,
      driver_replacement_ready_at: 1001,
      agent_owner_deaths: 1,
      before_claim_requests_completed: 1,
      denied_operations: [
        {
          operation: "node_publish",
          grpc_status: 9,
          message: "pool_creator_fence_denied",
        },
        {
          operation: "node_expand",
          grpc_status: 9,
          message: "pool_creator_fence_denied",
        },
        { operation: "volume_reconcile", error: "pool_creator_fence_denied" },
        {
          operation: "snapshot_create",
          error: "pool_creator_fence_denied",
          snapshot_uid: s.run_id,
          source_volume_handle: s.volume.volume_handle,
          state_at_denial: "Pending",
          requested_at: 1000,
          deleted_at: 1001,
          absent_at: 1002,
        },
      ],
      surviving_creation_descriptors: 0,
      final_dm_open_count: 0,
    };
  expect(PostgresPoolQualificationMeasurement.safeParse(m).success).toBe(false);
  const measured = {
    ...m,
    physical_snapshot_count: 0,
    physical_observed_at: 3,
    progress_sha256: "a".repeat(64),
    device_major: 253,
    device_minor: 2,
  };
  expect(PostgresPoolQualificationMeasurement.safeParse(measured).success).toBe(
    true,
  );
  expect(
    postgresPoolQualificationGatePassed(
      s,
      PostgresPoolQualificationMeasurement.parse(measured),
    ),
  ).toBe(true);
  expect(
    postgresPoolQualificationGatePassed(
      s,
      PostgresPoolQualificationMeasurement.parse({
        ...measured,
        final_dm_open_count: 1,
      }),
    ),
  ).toBe(false);
  expect(
    postgresPoolQualificationGatePassed(
      s,
      PostgresPoolQualificationMeasurement.parse({
        ...measured,
        physical_snapshot_count: 1,
      }),
    ),
  ).toBe(false);
});

it("records bounded controller action intent without claiming a measured gate passed", () => {
  const s = qualificationScopeFixture(),
    report = {
      run_id: s.run_id,
      scope_sha256: "a".repeat(64),
      sequence: 2,
      nonce: "b".repeat(32),
      producer: "controller",
      node_uid: s.node_uid,
      boot_id: s.boot_id,
      candidate_spec_sha256: s.candidate_spec_sha256,
      started_at: 1,
      observed_at: 2,
      progress: {
        gate: "finite_creator_fence",
        phase: "driver_delete_intent",
        driver_pod_uid: s.volume.pv_uid,
        driver_pod_name: "driver-known",
        driver_pod_resource_version: "2",
        driver_namespace: "openebs",
        driver_daemonset_uid: s.volume.pvc_uid,
        driver_image: s.software.driver_image,
      },
    };
  expect(
    PostgresPoolQualificationProgressReport.safeParse(report).success,
  ).toBe(true);
  expect(PostgresPoolQualificationReport.safeParse(report).success).toBe(false);
  expect(
    PostgresPoolQualificationProgressReport.safeParse({
      ...report,
      passed: true,
    }).success,
  ).toBe(false);
});
