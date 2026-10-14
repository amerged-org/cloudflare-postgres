// SPDX-License-Identifier: Apache-2.0
// Controlled real D1 metadata fixtures; no host/runtime qualification or Dev evidence.
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  bytesToHex,
  FleetReleaseSpec,
  newOperationId,
  type PostgresPoolQualification,
  ThinStorageProfile,
  NodeThinStorageAuthority,
} from "@pgcf/contracts";
import {
  postgresPoolClassFromDesired,
  PostgresPoolPolicy,
  PoolPodAttestation,
  PoolSleepRecord,
  PoolStorageObservation,
  PoolIoAttestation,
  PoolThinGuardProof,
} from "@pgcf/contracts/postgres-pool";
import {
  admissionSnapshotFixture,
  admissionFixtureReleases,
} from "./admission-snapshot-fixture.ts";
import { POOL_WORKLOAD_PROBE_RESULTS } from "@pgcf/contracts";
import { request } from "./fixtures.ts";
import { insertCompletedThinQualification } from "./thin-qualification-fixture.ts";
import { storageAuthorityPublicKeys } from "../../src/domain/storage-authority.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { canonicalInstallation } from "../../src/domain/node-installation.ts";
import { PostgresPoolQualificationScope } from "../../../../packages/contracts/src/postgres-pool-qualification.ts";
import generatedCompute from "../../../../packages/contracts/native/compute-pool.generated.json" with { type: "json" };
import {
  importRegionAgentKey,
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { ensureNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import { startupReservationStatement } from "../../src/domain/startup-admission.ts";
import type { Env } from "../../src/env.ts";

export interface PostgresPoolFixtureOptions {
  thin?: boolean;
  qualifiedThin?: boolean;
}
export async function postgresPoolFixture(
  options: PostgresPoolFixtureOptions = {},
) {
  const f = await admissionSnapshotFixture(true, {
      ...options,
      actualRam: options.qualifiedThin,
    }),
    now = Date.now();
  const spec = FleetReleaseSpec.parse(
    JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.releaseId)
        .first<string>("spec_json"))!,
    ),
  );
  const additions = ["pool-supervisor", "pgcf-sandbox-controller"].map(
    (name) => ({
      name,
      kind: "image" as const,
      version: "1.0.0",
      reference: `registry.example/${name}@sha256:${"a".repeat(64)}`,
      sha256: "a".repeat(64),
    }),
  );
  const components = [...spec.components, ...additions];
  const role = (value: typeof spec.roles.customer) => ({
    ...value,
    components: [...value.components, "pool-supervisor"],
    talos_extensions: [...value.talos_extensions, "pgcf-sandbox-controller"],
    ...(options.qualifiedThin ? { host_configuration_required: true } : {}),
  });
  const candidateId = "pool-candidate-" + crypto.randomUUID(),
    candidate = {
      ...spec,
      components,
      roles: {
        customer: role(spec.roles.customer),
        control_relay: role(spec.roles.control_relay),
      },
    };
  const thinProfile = options.qualifiedThin
    ? ThinStorageProfile.parse({
        version: 1,
        driver_image: components.find((c) => c.name === "openebs-lvm")!
          .reference,
        initial_data_bytes: 8 * 1024 ** 3,
        growth_bytes: 1024 ** 3,
        maximum_data_bytes: 16 * 1024 ** 3,
        metadata_bytes: 128 * 1024 ** 2,
        vg_reserve_bytes: 512 * 1024 ** 2,
        data_reserve_bytes: 256 * 1024 ** 2,
        metadata_reserve_bytes: 32 * 1024 ** 2,
        startup_reserve_bytes: f.desired.storage!.startup_reserve_bytes,
        write_bytes_per_second: f.desired.storage!.write_bytes_per_second,
        write_iops_per_second: f.desired.storage!.write_iops_per_second,
        guard_seconds: f.desired.storage!.guard_seconds,
        drain_seconds: f.desired.storage!.drain_seconds,
        maximum_volumes: 128,
        maximum_quota_gib: 7,
      })
    : undefined;
  const candidateSpec = thinProfile
    ? FleetReleaseSpec.parse({
        ...candidate,
        thin_storage_sampling_version: 1,
        storage_authority_keys_sha256: (await storageAuthorityPublicKeys(env))
          .sha256,
        thin_storage_qualification: await insertCompletedThinQualification(
          env.DB,
          {
            node_id: f.node,
            region_id: f.region,
            node_uid: f.nodeUid,
            release_id: candidateId,
            spec: FleetReleaseSpec.parse(candidate),
            profile: thinProfile,
            host_extension_image: additions[1]!.reference,
            kernel_version: "6.18.54",
          },
        ),
      })
    : candidate;
  const approved = await request(
    `/v1/fleet/releases/${candidateId}`,
    f.admin,
    "PUT",
    candidateSpec,
  );
  expect(approved.status).toBe(200);
  admissionFixtureReleases.push(candidateId);
  const candidateHash = ((await approved.json()) as { spec_sha256: string })
    .spec_sha256;
  const evidence = JSON.stringify({ controlled_local_metadata: true });
  const evidenceHash = bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evidence)),
    ),
  );
  // The same current CF compute profile later seals the qualified host configuration.
  const currentCompute = {
    ...generatedCompute.lease.policy,
    target_slots: 0,
    profile: {
      ...generatedCompute.lease.policy.profile,
      release_id: candidateId,
    },
  };
  await env.DB.prepare(
    "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?)",
  )
    .bind(
      f.node,
      f.nodeUid,
      candidateId,
      JSON.stringify(currentCompute),
      new Date(now).toISOString(),
    )
    .run();
  const q: PostgresPoolQualification = {
    version: 1,
    run_id: crypto.randomUUID(),
    candidate_release_id: candidateId,
    candidate_spec_sha256: candidateHash,
    scope_sha256: "a".repeat(64),
    evidence_sha256: evidenceHash,
    driver_image: components.find((c) => c.name === "openebs-lvm")!.reference,
    driver_sha256: "c".repeat(64),
    supervisor_sha256: "b".repeat(64),
    host_controller_sha256:
      generatedCompute.lease.policy.profile.controller_sha256,
    postgres_image_sha256: "d".repeat(64),
    archiver_image_sha256: "d".repeat(64),
    receipt_sha256: bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(candidateId),
        ),
      ),
    ),
    qualified_at: new Date(now).toISOString(),
    gates: {
      host_mount_context: true,
      finite_creator_fence: true,
      single_writer: true,
      mount_propagation: true,
      wal_archive: true,
      base_backup: true,
      clean_stop: true,
      thin_write_authority: true,
      thin_io_limits: true,
      thin_expiry_protection: true,
    },
  };
  await env.DB.prepare(
    "INSERT INTO postgres_pool_qualification_receipts(receipt_sha256,run_id,scope_sha256,evidence_sha256,candidate_release_id,candidate_spec_sha256,driver_image,driver_sha256,supervisor_sha256,host_controller_sha256,postgres_image_sha256,archiver_image_sha256,qualified_at,qualification_json,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      q.receipt_sha256,
      q.run_id,
      q.scope_sha256,
      q.evidence_sha256,
      candidateId,
      candidateHash,
      q.driver_image,
      q.driver_sha256,
      q.supervisor_sha256,
      q.host_controller_sha256,
      q.postgres_image_sha256,
      q.archiver_image_sha256,
      q.qualified_at,
      JSON.stringify(q),
      evidence,
    )
    .run();
  const releaseId = "pool-qualified-" + crypto.randomUUID();
  const releaseResponse = await request(
    `/v1/fleet/releases/${releaseId}`,
    f.admin,
    "PUT",
    {
      ...candidateSpec,
      postgres_pool_version: 1,
      postgres_pool_qualification: q,
    },
  );
  expect(releaseResponse.status).toBe(200);
  admissionFixtureReleases.push(releaseId);
  const hash = ((await releaseResponse.json()) as { spec_sha256: string })
    .spec_sha256;
  const node = await env.DB.prepare(
    "SELECT agent_key_hash FROM regions WHERE id=?",
  )
    .bind(f.region)
    .first<string>("agent_key_hash");
  const at = new Date(now).toISOString(),
    sleepGeneration = f.desired.generation + 1,
    sleepOperation = newOperationId();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=? WHERE region_id=?",
    ).bind(releaseId, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(releaseId, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=? WHERE operation_id=?",
    ).bind(releaseId, hash, f.patchId),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) VALUES(?,?,1,?,?,?,?) ON CONFLICT(node_id) DO UPDATE SET facts_json=excluded.facts_json,observed_at=excluded.observed_at,received_at=excluded.received_at",
    ).bind(
      f.node,
      f.nodeUid,
      node,
      JSON.stringify({
        boot_id: f.proof.boot_id,
        components: components.map(({ name, sha256 }) => ({ name, sha256 })),
      }),
      at,
      at,
    ),
    env.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at,completed_at) VALUES(?,'database.hibernate','succeeded',?,?,?,?,?,?)",
    ).bind(sleepOperation, f.project, f.id, sleepGeneration, at, at, at),
    env.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason='idle',generation=?,power_operation=?,observed_generation=?,observed_state='provisioning',observed_power='hibernated' WHERE id=?",
    ).bind(sleepGeneration, sleepOperation, sleepGeneration, f.id),
    env.DB.prepare(
      "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'ready',node_id,size_class_id,generation,? FROM databases WHERE id=?",
    ).bind(at, f.id),
  ]);
  const thinAuthority = thinProfile
    ? await installPoolThinAuthority(
        f,
        thinProfile,
        FleetReleaseSpec.parse(candidateSpec),
        releaseId,
        hash,
      )
    : undefined;
  const klass = await postgresPoolClassFromDesired(f.desired);
  const policy = PostgresPoolPolicy.parse({
    version: 1,
    kind: "postgres_pods",
    target_slots: 1,
    max_idle_cpu_millicores: (klass.cpu_request_millicores + 100) * 2,
    max_idle_memory_mib:
      (Math.ceil(klass.memory_request_bytes / 1024 ** 2) + 128) * 2,
    idle_cpu_millicores: klass.cpu_request_millicores + 100,
    idle_memory_mib: Math.ceil(klass.memory_request_bytes / 1024 ** 2) + 128,
    release_id: releaseId,
    class: klass,
    driver_image: q.driver_image,
    driver_sha256: q.driver_sha256,
    supervisor_image: additions[0]!.reference,
    supervisor_sha256: q.supervisor_sha256,
    host_controller_sha256: q.host_controller_sha256,
    archiver_image: "registry.example/barman@sha256:" + q.archiver_image_sha256,
    archiver_sha256: q.archiver_image_sha256,
  });
  await env.DB.prepare(
    "INSERT INTO node_postgres_pool_policies(node_id,node_uid,revision,release_id,policy_json,updated_at) VALUES(?,?,1,?,?,?)",
  )
    .bind(f.node, f.nodeUid, releaseId, JSON.stringify(policy), at)
    .run();
  const commonStorage = {
    storage_generation: f.proof.storage_generation,
    storage_uid: f.proof.storage_uid,
    namespace_uid: f.proof.namespace_uid,
    cnpg_cluster_uid: f.proof.cnpg_cluster_uid,
    pvc_uid: f.proof.pvc_uid,
    pv_uid: f.proof.pv_uid,
    volume_handle: f.volume.volume_handle,
    volume_group_uuid: f.volume.volume_group_uuid,
    lv_uuid: f.volume.lv_uuid,
  };
  const storage = options.thin
    ? {
        ...commonStorage,
        backend: "lvm-thin-v1" as const,
        thin_id: 42,
        profile: f.desired.storage!,
      }
    : { ...commonStorage, backend: "lvm-thick-v1" as const };
  const sleep = PoolSleepRecord.parse({
    v: 1,
    database_id: f.id,
    generation: sleepGeneration,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    configuration_fingerprint: f.proof.configuration_fingerprint,
    class: klass,
    storage,
    system_identifier: "7459021837620377423",
    timeline: 1,
    clean_stop: true,
    hibernation_on: true,
    instance_pods_absent: true,
    primary_lease_empty: true,
    observed_at: now,
  });
  const storageObservation = PoolStorageObservation.parse({
    v: 1,
    database_id: f.id,
    generation: sleepGeneration,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    storage,
    kernel_proof: {
      device_major: 253,
      device_minor: 1,
      mount_id: null,
      dm_open_count: 0,
      foreign_mounts: 0,
      complete_namespace_scan: false,
      named_namespace_scan_complete: true,
      zero_before_bind: true,
      exclusive_superblock_creation: false,
      nonlazy_unmount_verified: false,
      never_attached_verified: false,
      creator_fence: null,
      mountpoint: null,
    },
    observed_at: now,
  });
  const pod = PoolPodAttestation.parse({
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: crypto.randomUUID(),
    container_ids: options.thin
      ? ["c".repeat(64), "f".repeat(64)]
      : ["c".repeat(64)],
    pool_pod_uid: crypto.randomUUID(),
    pool_pod_name: "pgcf-pool-test",
    pool_pod_ip: "10.1.2.3",
    container_id: "c".repeat(64),
    supervisor_sha256: q.supervisor_sha256,
    supervisor_key_sha256: "e".repeat(64),
    supervisor_public_key_pem: "controlled local public attestation",
    supervisor_certificate_pem: "controlled local public certificate",
    class: klass,
    propagation_verified: true,
    workload_probes: (options.thin
      ? ["c".repeat(64), "f".repeat(64)]
      : ["c".repeat(64)]
    ).map((container_id) => ({
      container_id,
      probe: {
        v: 1,
        uid: 26,
        cap_eff: "0000000000000000",
        cap_sys_admin: false,
        seccomp_mode: 2,
        no_new_privs: true,
        observed_at: now,
        results: Object.fromEntries(
          POOL_WORKLOAD_PROBE_RESULTS.map((name) => [
            name,
            name === "clone3" ? 38 : 1,
          ]),
        ),
      },
    })),
    workload_isolation: {
      uid: 26,
      cap_sys_admin: false,
      seccomp_runtime_default: true,
      namespace_creation_denied: true,
      mount_api_denied: true,
    },
    observed_at: now,
  });
  const { recordPostgresPoolPreparationContext } =
    await import("../../src/domain/postgres-pool-preparation.ts");
  await recordPostgresPoolPreparationContext(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: pod.pool_namespace_uid,
    policy_revision: 1,
    policy,
    observed_at: now,
    expires_at: now + 60000,
    pods: [
      {
        pod_uid: pod.pool_pod_uid,
        pod_name: pod.pool_pod_name,
        pod_ip: pod.pool_pod_ip,
        container_ids: pod.container_ids,
      },
    ],
  });
  return {
    ...f,
    desired: { ...f.desired, generation: sleepGeneration },
    poolReleaseId: releaseId,
    policy,
    sleep,
    storageObservation,
    pod,
    thinProfile,
    thinAuthority,
  };
}

export async function claimedPostgresPoolFixture(
  options: PostgresPoolFixtureOptions = {},
) {
  const f = await postgresPoolFixture(options);
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
  let binding: import("@pgcf/contracts/postgres-pool").PoolBinding | undefined;
  await withAdmissionMutation(env, [f.id], async (mutation) => {
    const plan = await pool.preparePostgresPoolClaim(
        env,
        f.id,
        f.desired.generation + 1,
        mutation,
      ),
      guard = mutation.guard(f.id);
    const operation = newOperationId(),
      at = new Date().toISOString();
    await mutation.batch([
      ...plan.statements,
      ...(options.qualifiedThin
        ? [
            env.DB.prepare(
              "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) VALUES(?,'database.resume','running',?,?,?,?,?)",
            ).bind(
              operation,
              f.project,
              f.id,
              f.desired.generation + 1,
              at,
              at,
            ),
          ]
        : []),
      env.DB.prepare(
        `UPDATE databases SET desired_state='running',observed_state='provisioning',generation=generation+1,power_operation=CASE WHEN ? THEN ? ELSE power_operation END,updated_at=? WHERE id=? AND ${guard.sql}`,
      ).bind(
        Number(!!options.qualifiedThin),
        operation,
        at,
        f.id,
        ...guard.bindings,
      ),
      ...(options.qualifiedThin
        ? [
            startupReservationStatement(env.DB, {
              databaseId: f.id,
              operationId: operation,
              generation: f.desired.generation + 1,
              nodeId: f.node,
              now: at,
            }),
          ]
        : []),
    ]);
    const result = await plan.finish();
    expect(result.kind).toBe("hit");
    if (result.kind === "hit") binding = result.binding;
  });
  if (!binding) throw new Error("Controlled local pool claim failed");
  return { ...f, binding };
}

export async function qualificationPostgresPoolFixture(
  options: { prewake?: "waiting" | "accepted" } = { prewake: "accepted" },
) {
  const f = await postgresPoolFixture({ thin: true, qualifiedThin: true });
  const original = FleetReleaseSpec.parse(
    JSON.parse(
      (await env.DB.prepare("SELECT spec_json FROM fleet_releases WHERE id=?")
        .bind(f.poolReleaseId)
        .first<string>("spec_json"))!,
    ),
  );
  const {
    postgres_pool_version: _normal,
    postgres_pool_qualification: _receipt,
    ...base
  } = original;
  expect(_normal).toBe(1);
  expect(_receipt).toBeDefined();
  const releaseId = "pool-isolated-" + crypto.randomUUID(),
    candidate = FleetReleaseSpec.parse({
      ...base,
      postgres_pool_qualification_version: 1,
      postgres_pool_candidate: {
        driver_sha256: f.policy.driver_sha256,
        supervisor_sha256: f.policy.supervisor_sha256,
        host_controller_sha256: f.policy.host_controller_sha256,
      },
    });
  const response = await request(
    "/v1/fleet/releases/" + releaseId,
    f.admin,
    "PUT",
    candidate,
  );
  expect(response.status).toBe(200);
  admissionFixtureReleases.push(releaseId);
  const hash = ((await response.json()) as { spec_sha256: string }).spec_sha256;
  const compute = JSON.parse(
    (await env.DB.prepare(
      "SELECT policy_json FROM node_compute_pool_policies WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("policy_json"))!,
  );
  compute.profile.release_id = releaseId;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE fleet_region_releases SET release_id=? WHERE region_id=?",
    ).bind(releaseId, f.region),
    env.DB.prepare(
      "UPDATE fleet_node_releases SET release_id=? WHERE node_id=?",
    ).bind(releaseId, f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET release_id=?,spec_sha256=? WHERE operation_id=?",
    ).bind(releaseId, hash, f.patchId),
    env.DB.prepare(
      "UPDATE node_compute_pool_policies SET release_id=?,policy_json=? WHERE node_id=?",
    ).bind(releaseId, JSON.stringify(compute), f.node),
  ]);
  const host = await ensureNodeHostConfiguration(
    { ...env, NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/" } as Env,
    { node_id: f.node, node_uid: f.nodeUid },
  );
  const qualified = JSON.parse(
    (await env.DB.prepare(
      "SELECT qualification_json FROM node_thin_storage WHERE node_id=?",
    )
      .bind(f.node)
      .first<string>("qualification_json"))!,
  );
  Object.assign(qualified, { release_id: releaseId, spec_sha256: hash });
  qualified.software.host_configuration_sha256 = host.sha256;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
    ).bind(JSON.stringify(qualified), f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET host_configuration_revision=?,host_configuration_sha256=?,observed_json=? WHERE operation_id=?",
    ).bind(
      host.revision,
      host.sha256,
      JSON.stringify({
        boot_id: f.proof.boot_id,
        host_configuration_sha256: host.sha256,
        runtime_admission_sha256: host.profile_sha256,
        node_ready: true,
      }),
      f.patchId,
    ),
  ]);
  const runId = crypto.randomUUID(),
    now = Date.now(),
    scope = PostgresPoolQualificationScope.parse({
      version: 1,
      run_id: runId,
      region_id: f.region,
      node_id: f.node,
      node_uid: f.nodeUid,
      boot_id: f.proof.boot_id,
      cluster_uid: f.proof.cluster_uid,
      database_id: f.id,
      database_generation: f.desired.generation + 1,
      configuration_fingerprint: f.proof.configuration_fingerprint,
      candidate_release_id: releaseId,
      candidate_spec_sha256: hash,
      storage: f.desired.storage,
      volume: f.volume,
      thin_id: 42,
      software: {
        driver_image: f.policy.driver_image,
        driver_sha256: f.policy.driver_sha256,
        supervisor_image: f.policy.supervisor_image,
        supervisor_sha256: f.policy.supervisor_sha256,
        host_controller_sha256: f.policy.host_controller_sha256,
        postgres_image: f.desired.postgres!.image,
        archiver_image: f.policy.archiver_image,
        host_extension_image: candidate.components.find(
          (c) => c.name === "pgcf-sandbox-controller",
        )!.reference,
        kernel_version: candidate.thin_storage_qualification!.kernel_version,
      },
    });
  const scopeHash = await installationHash(scope);
  // Accepted local CF journal metadata, never real kernel or Dev gate evidence.
  const journal = {
    version: 1,
    pending: null,
    entries:
      options.prewake === "waiting"
        ? []
        : [
            {
              sequence: 1,
              producer: "node",
              issued_at: now,
              started_at: now,
              observed_at: now,
              received_at: now,
              measurement: {
                gate: "host_mount_context",
                kernel_version: scope.software.kernel_version,
                caller_pid_namespace_inode: 1,
                initial_pid_namespace_inode: 1,
                caller_user_namespace_inode: 2,
                initial_user_namespace_inode: 2,
                next_namespace_errno: 0,
              },
            },
            {
              sequence: 2,
              producer: "node",
              issued_at: now,
              started_at: now,
              observed_at: now,
              received_at: now,
              measurement: {
                gate: "finite_creator_fence",
                binding_id: null,
                deny_record_inode_before_restart: 12,
                deny_record_inode_after_restart: 12,
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
            },
          ],
  };
  await env.DB.prepare(
    "INSERT INTO postgres_pool_qualification_runs(id,region_id,node_id,node_uid,boot_id,database_id,database_generation,candidate_release_id,candidate_spec_sha256,scope_sha256,scope_json,status,evidence_json,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?)",
  )
    .bind(
      runId,
      f.region,
      f.node,
      f.nodeUid,
      f.proof.boot_id,
      f.id,
      scope.database_generation,
      releaseId,
      hash,
      scopeHash,
      canonicalInstallation(scope),
      JSON.stringify(journal),
      now,
      now,
      now + 300000,
    )
    .run();
  const { readPostgresPoolNodePolicy, recordPostgresPoolPreparationContext } =
    await import("../../src/domain/postgres-pool-preparation.ts");
  const selected = (await readPostgresPoolNodePolicy(env, f.node))!;
  await recordPostgresPoolPreparationContext(env, f.node, {
    v: 1,
    node_id: f.node,
    node_uid: f.nodeUid,
    boot_id: f.proof.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: f.pod.pool_namespace_uid,
    policy_revision: 1,
    policy: selected.policy,
    observed_at: Date.now(),
    expires_at: Date.now() + 60000,
    qualification_run_id: runId,
    qualification_scope_sha256: scopeHash,
    pods: [
      {
        pod_uid: f.pod.pool_pod_uid,
        pod_name: f.pod.pool_pod_name,
        pod_ip: f.pod.pool_pod_ip,
        container_ids: f.pod.container_ids,
      },
    ],
  });
  return {
    ...f,
    qualificationRunId: runId,
    qualificationScope: scope,
    qualificationScopeHash: scopeHash,
    qualificationReleaseId: releaseId,
  };
}

async function installPoolThinAuthority(
  f: Awaited<ReturnType<typeof admissionSnapshotFixture>>,
  profile: ThinStorageProfile,
  spec: FleetReleaseSpec,
  releaseId: string,
  specHash: string,
) {
  const now = Date.now(),
    at = new Date(now).toISOString(),
    storage = f.desired.storage!;
  const authority = NodeThinStorageAuthority.parse({
    node_id: f.node,
    name: f.nodeName,
    node_uid: f.nodeUid,
    cluster_uid: f.proof.cluster_uid,
    revision: 1,
    profile_revision: storage.profile_revision,
    profile_sha256: storage.profile_sha256,
    storage_class: storage.storage_class,
    volume_group_uuid: storage.volume_group_uuid,
    pool_uuid: storage.pool_uuid,
    driver_pod_uid: crypto.randomUUID(),
    driver_image: profile.driver_image,
    observed_at: at,
    captured_at: at,
    expires_at: new Date(now + profile.guard_seconds * 1000).toISOString(),
    write_allowed: true,
    physical: {
      volume_group_uuid: storage.volume_group_uuid,
      total_bytes: 30 * 1024 ** 3,
      free_bytes: 21 * 1024 ** 3,
      thick_allocated_bytes: 0,
      thin_pool: {
        name: "pgcf_thinpool",
        data_total_bytes: profile.initial_data_bytes,
        data_used_bytes_upper_bound: 64 * 1024 ** 2,
        metadata_total_bytes: profile.metadata_bytes,
        metadata_used_bytes_upper_bound: 1024 ** 2,
      },
    },
    physical_lvs: [
      {
        name: f.volume.volume_handle,
        lv_uuid: f.volume.lv_uuid,
        size_bytes: f.desired.size.storage_gib * 1024 ** 3,
        segtype: "thin",
      },
    ],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [
      {
        database_id: f.id,
        generation: f.desired.generation + 1,
        storage_generation: f.volume.storage_generation,
        storage_uid: f.volume.storage_uid,
        namespace_uid: f.volume.namespace_uid,
        cluster_uid: f.volume.cluster_uid,
        volume_handle: f.volume.volume_handle,
        lv_uuid: f.volume.lv_uuid,
        pvc_uid: f.volume.pvc_uid,
        pv_uid: f.volume.pv_uid,
        storage_class: storage.storage_class,
        volume_attributes_class: storage.volume_attributes_class,
        io: [],
      },
    ],
  });
  const compute = {
    ...generatedCompute.lease.policy,
    target_slots: 0,
    profile: {
      ...generatedCompute.lease.policy.profile,
      release_id: releaseId,
    },
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO node_memory_samples(node_id,node_uid,minute,observed_at,working_set_bytes,capacity_memory_bytes,available_bytes,memory_pressure) VALUES(?,?,?,?,?,?,?,0)",
    ).bind(
      f.node,
      f.nodeUid,
      Math.floor(now / 60000),
      at,
      1024 ** 3,
      4 * 1024 ** 3,
      3 * 1024 ** 3,
    ),
    env.DB.prepare(
      "INSERT INTO node_compute_pool_policies VALUES(?,?,1,?,?,?) ON CONFLICT(node_id) DO UPDATE SET release_id=excluded.release_id,policy_json=excluded.policy_json,updated_at=excluded.updated_at",
    ).bind(f.node, f.nodeUid, releaseId, JSON.stringify(compute), at),
    env.DB.prepare(
      "INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,allow_new_databases,authority_revision,authority_json,authority_received_at,material_revision,qualified_driver_image,status,created_at,updated_at) VALUES(?,?,?,'192.0.2.18',?,?,?, ?,1,1,?,?,1,?,'ready',?,?)",
    ).bind(
      f.node,
      f.nodeUid,
      f.proof.cluster_uid,
      storage.volume_group_uuid,
      storage.profile_revision,
      storage.profile_sha256,
      JSON.stringify(profile),
      JSON.stringify(authority),
      at,
      profile.driver_image,
      at,
      at,
    ),
  ]);
  const local = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
  } as Env;
  await importRegionAgentKey(env.DB, local, f.region, f.agent);
  await storeRegionJoinBundle(
    env.DB,
    local.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "pool-thin-fixture",
      cluster_endpoint: "https://192.0.2.18:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "controlled-test-machine",
      talos_admin_config: "controlled-test-admin",
      kube_system_uid: f.proof.cluster_uid,
      kubeconfig: "controlled-test-kube",
    },
  );
  const host = await ensureNodeHostConfiguration(local, {
    node_id: f.node,
    node_uid: f.nodeUid,
  });
  const receipt = {
    profile_revision: storage.profile_revision,
    profile_sha256: await installationHash(profile),
    release_id: releaseId,
    spec_sha256: specHash,
    assignment_revision: 1,
    region_revision: 1,
    boot_id: f.proof.boot_id,
    system_uuid: crypto.randomUUID(),
    software: {
      kernel_version: spec.thin_storage_qualification!.kernel_version,
      host_extension_image:
        spec.thin_storage_qualification!.host_extension_image,
      host_configuration_sha256: host.sha256,
    },
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_thin_storage SET qualification_json=? WHERE node_id=?",
    ).bind(JSON.stringify(receipt), f.node),
    env.DB.prepare(
      "UPDATE fleet_patch_operations SET host_configuration_revision=?,host_configuration_sha256=?,observed_json=? WHERE operation_id=?",
    ).bind(
      host.revision,
      host.sha256,
      JSON.stringify({
        boot_id: f.proof.boot_id,
        host_configuration_sha256: host.sha256,
        runtime_admission_sha256: host.profile_sha256,
        node_ready: true,
      }),
      f.patchId,
    ),
  ]);
  return authority;
}

export async function servingPostgresPoolFixture(
  options: PostgresPoolFixtureOptions = {},
) {
  const f = await claimedPostgresPoolFixture({
    ...options,
    qualifiedThin: options.thin ? true : options.qualifiedThin,
  });
  const pool = await import("../../src/domain/postgres-pool.ts");
  const { DatabasePoolRuntimeAttestationV2 } =
    await import("@pgcf/contracts/reclaim");
  const binding = f.binding;
  const scope = binding.scope,
    now = Date.now();
  let thinGuard: import("@pgcf/contracts/postgres-pool").PoolNodeReport["thin_guard"] =
    null;
  if (scope.storage.backend === "lvm-thin-v1") {
    const profile = scope.storage.profile;
    const io = PoolIoAttestation.parse({
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: binding.scope_sha256,
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_namespace_uid: scope.pool_namespace_uid,
      pool_pod_uid: scope.pool_pod_uid,
      observed_at: now,
      device: {
        volume_group_uuid: scope.storage.volume_group_uuid,
        lv_uuid: scope.storage.lv_uuid,
        thin_id: scope.storage.thin_id,
        device_major: 253,
        device_minor: 1,
      },
      shared_pod_io: {
        pod_cgroup_inode: 11,
        device_major: 253,
        device_minor: 1,
        write_bytes_per_second: profile.write_bytes_per_second,
        write_iops_per_second: profile.write_iops_per_second,
        io_max_verified: true,
        all_writer_cgroups_descendants: true,
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
    await pool.recordPostgresPoolIoAttestation(env, scope.binding_id, io);
    const token = await (
      await import("../../src/domain/node-thin-storage.ts")
    ).issuePostgresPoolStorageAuthority(env, binding);
    if (!token)
      throw new Error("Qualified thin fixture has no real signed grant");
    const { verifyStorageWriteAuthority } =
      await import("@pgcf/contracts/storage-write-authority");
    const { importBootstrapVerificationKeys } =
      await import("@pgcf/contracts/bootstrap-relay");
    const claims = await verifyStorageWriteAuthority(
      token,
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      ),
    );
    if (!claims) throw new Error("Controlled signed thin grant invalid");
    thinGuard = PoolThinGuardProof.parse({
      authority_token: token,
      authority_revision: claims.authority_revision,
      expires_at: claims.exp,
      protect_on_expiry_armed: true,
      cgroups: io.cgroups,
      shared_pod_io: io.shared_pod_io,
    });
  }
  const mounted = {
    v: 1 as const,
    binding_id: scope.binding_id,
    scope_sha256: binding.scope_sha256,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_pod_uid: scope.pool_pod_uid,
    state: "mounted" as const,
    observed_at: now,
    clean_stop: null,
    error: null,
    storage_backend: scope.storage.backend,
    thin_guard: thinGuard,
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
        v: 1 as const,
        scope_sha256: binding.scope_sha256,
        storage_uid: scope.storage.storage_uid,
        volume_handle: scope.storage.volume_handle,
        volume_group_uuid: scope.storage.volume_group_uuid,
        lv_uuid: scope.storage.lv_uuid,
        driver_gate_protocol: 1 as const,
        driver_image: scope.driver_image,
        driver_sha256: scope.driver_sha256,
        deny_record_durable: true as const,
        csi_node_publish_serialized: true as const,
        csi_node_expand_serialized: true as const,
        creation_fds_closed: true as const,
      },
      mountpoint: {
        pool_pod_uid: scope.pool_pod_uid,
        root_uid: 0 as const,
        mode: 493 as const,
        tmpfs: true as const,
        opened_beneath: true as const,
        symlink_free: true as const,
      },
    },
  };
  await pool.recordPostgresPoolNodeReport(env, scope.binding_id, mounted);
  const proof = DatabasePoolRuntimeAttestationV2.parse({
    ...f.proof,
    kind: "pool",
    binding_id: scope.binding_id,
    scope_sha256: binding.scope_sha256,
    holder_revision: binding.holder_revision,
    pool_namespace_uid: scope.pool_namespace_uid,
    pool_namespace_resource_version: "81",
    generation: scope.generation,
    admission_epoch: scope.admission_epoch,
    route_revision: scope.route_revision,
    pod_uid: scope.pool_pod_uid,
    pod_ip: scope.pool_pod_ip,
    container_id: scope.container_id,
    observed_at: now,
    observation: {
      ...f.proof.observation,
      verified_at: now,
      expires_at: now + 60000,
    },
  });
  const supervisor = {
    v: 1 as const,
    binding_id: scope.binding_id,
    scope_sha256: binding.scope_sha256,
    bundle_nonce: scope.bundle_nonce,
    state: "ready" as const,
    system_identifier: scope.system_identifier,
    timeline: scope.timeline,
    control_state: "in production" as const,
    postmaster_pid: 26,
    postgres_started_at: now,
    readiness_at: now,
    observed_at: now,
    error: null,
  };
  await pool.recordPostgresPoolServing(
    env,
    scope.binding_id,
    proof,
    supervisor,
  );
  await env.DB.prepare(
    "UPDATE databases SET observed_state='ready',observed_power='awake',observed_generation=generation,runtime_attestation_json=? WHERE id=?",
  )
    .bind(JSON.stringify(proof), f.id)
    .run();
  return {
    ...f,
    binding: { ...binding, state: "serving" as const },
    proof,
    mounted,
    supervisor,
  };
}
