// SPDX-License-Identifier: Apache-2.0
// Real-D1 state for authority regressions; these records are never Dev qualification evidence.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
} from "@pgcf/contracts";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import {
  PoolStorageObservation,
  PoolSleepRecord,
  PoolBindingScope,
  PoolNodeReport,
  poolBindingScopeHash,
  PoolPodPreparationContext,
  poolPreparationContextHash,
} from "@pgcf/contracts/postgres-pool";
import type {
  PostgresPoolQualificationRun,
  PostgresPoolQualificationMeasurement,
} from "@pgcf/contracts/postgres-pool-qualification";
import generated from "../../../../packages/contracts/native/postgres-pool.generated.json" with { type: "json" };
import {
  qualificationScopeFixture,
  qualificationHostFixture,
  qualificationOrdinaryIoFixture,
} from "../../../../packages/contracts/test/postgres-pool-qualification.fixture.ts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { readPostgresPoolDatabaseContext } from "../../src/domain/postgres-pool-context.ts";
import {
  installationHash,
  canonicalInstallation,
} from "../../src/domain/node-installation.ts";
import type { Env } from "../../src/env.ts";
import { readPostgresPoolQualificationSetup } from "../../src/domain/postgres-pool-qualification-authority.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";

export async function qualificationHostMeasurement(
  f: Awaited<ReturnType<typeof poolQualificationSource>>,
  run: PostgresPoolQualificationRun,
  nonce: string,
  at = Date.now(),
) {
  const setup = await readPostgresPoolQualificationSetup(
    env as Env,
    f.database,
    run.scope.database_generation,
  );
  expect(setup).toBeDefined();
  const context = PoolPodPreparationContext.parse({
    v: 1,
    node_id: f.node,
    node_uid: run.scope.node_uid,
    boot_id: run.scope.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: crypto.randomUUID(),
    policy_revision: setup!.policy_revision,
    policy: setup!.policy,
    observed_at: at,
    expires_at: at + 60000,
    qualification_run_id: run.id,
    qualification_scope_sha256: run.scope_sha256,
    pods: [
      {
        pod_uid: crypto.randomUUID(),
        pod_name: "qualification-owned",
        pod_ip: "127.0.0.1",
        container_ids: ["a".repeat(64), "b".repeat(64)],
      },
    ],
  });
  await env.DB.prepare(
    `INSERT INTO pool_preparation_contexts(node_id,node_uid,boot_id,context_json,observed_at,expires_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,boot_id=excluded.boot_id,context_json=excluded.context_json,observed_at=excluded.observed_at,expires_at=excluded.expires_at`,
  )
    .bind(
      f.node,
      run.scope.node_uid,
      run.scope.boot_id,
      JSON.stringify(context),
      at,
      at + 60000,
    )
    .run();
  return qualificationHostFixture(
    run.scope,
    run.scope_sha256,
    nonce,
    at,
    await poolPreparationContextHash(context),
    context.pods[0]!.pod_uid,
  );
}

export async function qualificationCompletionState(
  f: Awaited<ReturnType<typeof poolQualificationSource>>,
  run: PostgresPoolQualificationRun,
) {
  const at = Date.now(),
    s = run.scope,
    bindingId = crypto.randomUUID(),
    replacementDriver = crypto.randomUUID(),
    binding = PoolBindingScope.parse({
      ...generated.thin_scope,
      binding_id: bindingId,
      database_id: s.database_id,
      generation: s.database_generation,
      configuration_fingerprint: s.configuration_fingerprint,
      region_id: s.region_id,
      node_id: s.node_id,
      node_uid: s.node_uid,
      boot_id: s.boot_id,
      class: f.sleep.class,
      driver_image: s.software.driver_image,
      driver_sha256: s.software.driver_sha256,
      supervisor_sha256: s.software.supervisor_sha256,
      host_controller_sha256: s.software.host_controller_sha256,
      storage: f.physical,
      system_identifier: f.sleep.system_identifier,
      timeline: f.sleep.timeline,
    }),
    scopeHash = await poolBindingScopeHash(binding),
    node = PoolNodeReport.parse({
      v: 1,
      binding_id: bindingId,
      scope_sha256: scopeHash,
      node_uid: s.node_uid,
      boot_id: s.boot_id,
      pool_pod_uid: binding.pool_pod_uid,
      state: "released",
      observed_at: at,
      storage_backend: "lvm-thin-v1",
      thin_guard: null,
      kernel_proof: f.kernel,
      clean_stop: true,
      error: null,
    });
  const measurements: PostgresPoolQualificationMeasurement[] = [
    await qualificationHostMeasurement(f, run, "a".repeat(32), at - 800),
    {
      gate: "finite_creator_fence",
      binding_id: null,
      source_generation: s.database_generation - 1,
      volume_handle: s.volume.volume_handle,
      driver_sha256: s.software.driver_sha256,
      deny_record_inode_before_restart: 42,
      deny_record_inode_after_restart: 42,
      deny_record_sha256_before_restart: "a".repeat(64),
      deny_record_sha256_after_restart: "a".repeat(64),
      deny_record_scope_sha256: run.scope_sha256,
      deny_record_fsync_errno: 0,
      driver_restarts: 1,
      driver_pod_uid_before_restart: f.authority.driver_pod_uid,
      driver_pod_uid_after_restart: replacementDriver,
      driver_daemonset_uid: crypto.randomUUID(),
      driver_image: s.software.driver_image,
      driver_deleted_at: at - 900,
      driver_replacement_ready_at: at - 800,
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
          snapshot_uid: crypto.randomUUID(),
          source_volume_handle: s.volume.volume_handle,
          state_at_denial: "Pending",
          requested_at: at - 900,
          deleted_at: at - 800,
          absent_at: at - 800,
        },
      ],
      surviving_creation_descriptors: 0,
      final_dm_open_count: 0,
      physical_snapshot_count: 0,
      physical_observed_at: at - 800,
      progress_sha256: "a".repeat(64),
      device_major: 253,
      device_minor: 2,
    },
    {
      gate: "single_writer",
      binding_id: bindingId,
      before_dm_open_count: 0,
      mounted_dm_open_count: 1,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
      namespaces_inspected: 3,
      exclusive_create_errno: 0,
      unexpected_writer_processes: 0,
    },
    {
      gate: "mount_propagation",
      binding_id: bindingId,
      device_major: 253,
      device_minor: 2,
      contexts: (
        ["node_agent", "kubelet", "supervisor", "archiver"] as const
      ).map((kind, i) => ({
        kind,
        namespace_inode: 100 + i,
        mount_id: 10 + i,
        device_major: 253,
        device_minor: 2,
        filesystem: "ext4",
      })),
    },
    {
      gate: "thin_write_authority",
      binding_id: bindingId,
      authority_revision: 1,
      authority_sha256: "b".repeat(64),
      issued_at: at - 20000,
      expires_at: at - 10000,
      renewed_at: at - 19900,
    },
    {
      gate: "thin_io_limits",
      binding_id: bindingId,
      device_major: 253,
      device_minor: 2,
      ordinary_direct_io: qualificationOrdinaryIoFixture(s),
      writer_cgroups: binding.container_ids.map((container_id, i) => ({
        container_id,
        cgroup_inode: 100 + i,
        pid: 100 + i,
        start_ticks: 200 + i,
        pid_namespace: 300 + i,
        device_major: 253,
        device_minor: 2,
        write_bytes_per_second: s.storage.write_bytes_per_second,
        write_iops_per_second: s.storage.write_iops_per_second,
      })),
    },
    {
      gate: "wal_archive",
      binding_id: bindingId,
      system_identifier: binding.system_identifier,
      timeline: 1,
      wal_segment: "000000010000000000000001",
      archive_exit_code: 0,
      archive_done_at: at - 15000,
      object_received_at: at - 14900,
      uncompressed_bytes: 16777216,
      local_sha256: "c".repeat(64),
      archived_sha256: "c".repeat(64),
    },
    {
      gate: "base_backup",
      binding_id: bindingId,
      system_identifier: binding.system_identifier,
      timeline: 1,
      backup_id: "20261014T230000",
      catalog_state: "DONE",
      completed_at: at - 13000,
      catalog_sha256: "d".repeat(64),
      bytes: null,
    },
    {
      gate: "thin_expiry_protection",
      binding_id: bindingId,
      authority_expires_at: at - 10000,
      protection_requested_at: at - 9990,
      drained_at: at - 9500,
      postmaster_pid: null,
      device_state: "suspended",
      sectors_written_before: 1,
      sectors_written_after: 1,
      allocated_blocks_before: 1,
      allocated_blocks_after: 1,
    },
    {
      gate: "clean_stop",
      binding_id: bindingId,
      system_identifier: binding.system_identifier,
      timeline: 1,
      control_state: "shut down",
      postmaster_pid: null,
      remaining_writer_processes: 0,
      stop_exit_code: 0,
    },
  ];
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET authority_json=json_set(authority_json,'$.driver_pod_uid',?) WHERE node_id=?",
    ).bind(replacementDriver, s.node_id),
    env.DB.prepare(
      "INSERT INTO pool_pods(pod_uid,node_id,node_uid,boot_id,policy_revision,attestation_json,state,binding_id,first_observed_at,last_observed_at) VALUES(?,?,?,?,1,'{}','retired',?,?,?)",
    ).bind(
      binding.pool_pod_uid,
      s.node_id,
      s.node_uid,
      s.boot_id,
      bindingId,
      at,
      at,
    ),
    env.DB.prepare(
      `INSERT INTO pool_bindings(id,database_id,node_id,node_uid,boot_id,pool_pod_uid,generation,route_revision,admission_epoch,holder_revision,
      scope_sha256,scope_json,state,node_report_json,created_at,updated_at,served_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,'released',?,?,?,?)`,
    ).bind(
      bindingId,
      s.database_id,
      s.node_id,
      s.node_uid,
      s.boot_id,
      binding.pool_pod_uid,
      s.database_generation,
      binding.route_revision,
      binding.admission_epoch,
      scopeHash,
      JSON.stringify(binding),
      JSON.stringify(node),
      at - 30000,
      at,
      at - 20000,
    ),
    env.DB.prepare(
      "UPDATE databases SET generation=?,observed_generation=? WHERE id=?",
    ).bind(s.database_generation + 1, s.database_generation + 1, s.database_id),
    env.DB.prepare(
      "UPDATE postgres_pool_qualification_runs SET status='cleanup',evidence_json=?,updated_at=? WHERE id=?",
    ).bind(
      canonicalInstallation({
        version: 1,
        pending: null,
        entries: measurements.map((measurement, i) => ({
          sequence: i + 1,
          producer: [6, 7, 9].includes(i) ? "controller" : "node_agent",
          issued_at: at - 1000,
          started_at: at - 900,
          observed_at: at - 800,
          received_at: at - 700,
          execution: {
            node_uid: s.node_uid,
            boot_id: s.boot_id,
            candidate_release_id: s.candidate_release_id,
            candidate_spec_sha256: s.candidate_spec_sha256,
            verifier_keys_sha256: f.specification.storage_authority_keys_sha256,
            driver_pod_uid:
              i === 0 ? f.authority.driver_pod_uid : replacementDriver,
            driver_image: s.software.driver_image,
            driver_sha256: s.software.driver_sha256,
            host_extension_image: s.software.host_extension_image,
            host_controller_sha256: s.software.host_controller_sha256,
            kernel_version: s.software.kernel_version,
          },
          measurement,
        })),
      }),
      at,
      run.id,
    ),
  ]);
  return {
    bindingId,
    at,
    measurement: {
      gate: "cleanup" as const,
      binding_id: bindingId,
      storage: s.volume,
      remaining_pool_pods: 0,
      remaining_instance_pods: 0,
      remaining_primary_lease_holders: 0,
      cnpg_hibernation: "on" as const,
      remaining_creation_descriptors: 0,
      dm_open_count: 0,
      foreign_mounts: 0,
      named_namespace_scan_errno: 0,
      deny_record: "absent" as const,
      unmount_errno: 0,
    },
  };
}

export async function poolQualificationSource(releases: string[]) {
  const f = await thinExecutionFixture(releases),
    at = new Date().toISOString(),
    now = Date.now();
  f.authority.physical.free_bytes = 80 * 1024 ** 3;
  f.authority.physical.thin_pool!.data_total_bytes = 16 * 1024 ** 3;
  await env.DB.prepare(
    "UPDATE node_thin_storage SET authority_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(f.authority), f.node)
    .run();
  const created = await f.create();
  expect(created.status).toBe(202);
  const database = ((await created.json()) as { database: { id: string } })
      .database.id,
    profile = (await env.DB.prepare(
      "SELECT storage_profile_json FROM databases WHERE id=?",
    )
      .bind(database)
      .first<string>("storage_profile_json"))!,
    storage = DesiredDatabaseStorage.parse(JSON.parse(profile)),
    base = qualificationScopeFixture(),
    volume = DatabaseStorageVolumeReceipt.parse({
      ...base.volume,
      node_uid: f.uid,
      volume_group_uuid: f.authority.volume_group_uuid,
      pool_uuid: f.authority.pool_uuid,
    });
  const runtimePolicy = JSON.parse(
    (await env.DB.prepare(
      "SELECT policy_json FROM node_compute_pool_policies WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("policy_json"))!,
  );
  // Bind the real sealed host configuration to the current release's source-qualified image.
  runtimePolicy.profile.image = f.qualified.spec.components.find(
    (c) => c.name === "pgcf-sandbox-controller",
  )!.reference;
  await env.DB.prepare(
    "UPDATE node_compute_pool_policies SET policy_json=? WHERE node_id=?",
  )
    .bind(JSON.stringify(runtimePolicy), f.node)
    .run();
  const host = await ensureNodeHostConfiguration(f.local, {
    node_id: f.node,
    node_uid: f.uid,
  });
  f.qualified.qualification.software.host_configuration_sha256 = host.sha256;
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET host_configuration_revision=?,host_configuration_sha256=?,observed_json=json_set(observed_json,'$.host_configuration_sha256',?,'$.runtime_admission_sha256',?) WHERE node_id=?",
  )
    .bind(host.revision, host.sha256, host.sha256, host.profile_sha256, f.node)
    .run();
  const candidate = `pool-${crypto.randomUUID()}`,
    specification = FleetReleaseSpec.parse({
      ...f.qualified.spec,
      route_token_version: 4,
      runtime_attestation_version: 2,
      admission_snapshot_version: 1,
      postgres_pool_qualification_version: 1,
      postgres_pool_candidate: {
        driver_sha256: "e".repeat(64),
        supervisor_sha256: "f".repeat(64),
        host_controller_sha256: runtimePolicy.profile.controller_sha256,
      },
      roles: Object.fromEntries(
        Object.entries(f.qualified.spec.roles).map(([name, role]) => [
          name,
          {
            ...role,
            components: [
              ...new Set([
                ...role.components,
                "pool-supervisor",
                "postgres",
                "barman",
              ]),
            ],
          },
        ]),
      ),
      components: [
        ...f.qualified.spec.components,
        {
          name: "pool-supervisor",
          kind: "image",
          version: "0.1.0",
          reference: `registry.invalid/supervisor@sha256:${"8".repeat(64)}`,
          sha256: "8".repeat(64),
        },
      ],
    }),
    specHash = await installationHash(specification);
  releases.push(candidate);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(candidate, canonicalInstallation(specification), specHash, at),
    env.DB.prepare(
      "UPDATE node_compute_pool_policies SET release_id=? WHERE node_id=?",
    ).bind(candidate, f.node),
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=?,revision=2 WHERE region_id=?",
    ).bind(candidate, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=?,revision=2 WHERE node_id=?",
    ).bind(candidate, f.node),
    env.DB.prepare(
      "UPDATE node_host_configurations SET release_id=? WHERE node_id=?",
    ).bind(candidate, f.node),
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
    ).bind(
      JSON.stringify({
        ...f.qualified.qualification,
        release_id: candidate,
        spec_sha256: specHash,
        assignment_revision: 2,
        region_revision: 2,
      }),
      f.node,
    ),
    env.DB.prepare(
      "UPDATE fleet_node_release_observations SET assignment_revision=2,facts_json=json_set(facts_json,'$.components',json(?)) WHERE node_id=?",
    ).bind(
      JSON.stringify(
        specification.components
          .filter((c) => c.name !== "pool-supervisor")
          .map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      ),
      f.node,
    ),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=?,assignment_revision=2,region_revision=2 WHERE node_id=? AND stage='complete'",
    ).bind(candidate, specHash, f.node),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',observed_state='provisioning',observed_power='hibernated',observed_generation=generation,storage_volume_json=? WHERE id=?",
    ).bind(JSON.stringify(volume), database),
    env.DB.prepare(
      "INSERT INTO lifecycle_events(database_id,kind,generation,size_class_id,occurred_at) SELECT id,'ready',generation,size_class_id,? FROM databases WHERE id=?",
    ).bind(at, database),
    env.DB.prepare(
      "INSERT INTO database_admission_epochs(database_id) VALUES(?) ON CONFLICT DO NOTHING",
    ).bind(database),
  ]);
  const state = await readPostgresPoolDatabaseContext(env as Env, database),
    physical = {
      backend: "lvm-thin-v1" as const,
      storage_generation: volume.storage_generation,
      storage_uid: volume.storage_uid,
      namespace_uid: volume.namespace_uid,
      cnpg_cluster_uid: volume.cluster_uid,
      pvc_uid: volume.pvc_uid,
      pv_uid: volume.pv_uid,
      volume_handle: volume.volume_handle,
      volume_group_uuid: volume.volume_group_uuid,
      lv_uuid: volume.lv_uuid,
      thin_id: base.thin_id,
      profile: storage,
    },
    kernel = {
      device_major: 253,
      device_minor: 2,
      mount_id: null,
      dm_open_count: 0,
      foreign_mounts: 0,
      complete_namespace_scan: false,
      named_namespace_scan_complete: true,
      zero_before_bind: true,
      exclusive_superblock_creation: false,
      nonlazy_unmount_verified: true,
      never_attached_verified: false,
      creator_fence: null,
      mountpoint: null,
    },
    observation = PoolStorageObservation.parse({
      v: 1,
      database_id: database,
      generation: state.row.generation,
      node_uid: f.uid,
      boot_id: f.qualified.bootId,
      storage: physical,
      kernel_proof: kernel,
      observed_at: now,
    }),
    sleep = PoolSleepRecord.parse({
      v: 1,
      database_id: database,
      generation: state.row.generation,
      node_uid: f.uid,
      boot_id: f.qualified.bootId,
      configuration_fingerprint: state.fingerprint,
      class: state.class,
      storage: physical,
      system_identifier: "7412345678901234567",
      timeline: 1,
      clean_stop: true,
      hibernation_on: true,
      instance_pods_absent: true,
      primary_lease_empty: true,
      observed_at: now,
    });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pool_storage_observations(database_id,node_id,observation_json,observed_at) VALUES(?,?,?,?)",
    ).bind(database, f.node, JSON.stringify(observation), now),
    env.DB.prepare(
      "INSERT INTO database_runtime_holders(database_id,kind,revision,binding_id,state,clean_stop,sleep_json,updated_at) VALUES(?,'cnpg',1,NULL,'released',1,?,?)",
    ).bind(database, JSON.stringify(sleep), now),
  ]);
  return {
    ...f,
    database,
    candidate,
    storage,
    volume,
    specification,
    specHash,
    physical,
    kernel,
    sleep,
    request: {
      candidate_release_id: candidate,
      node_uid: f.uid,
      database_id: database,
      expected_generation: state.row.generation,
    },
  };
}
