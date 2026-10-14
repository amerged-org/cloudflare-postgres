// SPDX-License-Identifier: Apache-2.0
import type { StorageAuthorityCryptoKey } from "../src/storage-write-authority.ts";
import {
  HostStorageLease,
  NodeThinStorageLease,
} from "../src/node-thin-storage.ts";
import {
  signPoolCleanupAuthority,
  verifyPoolCleanupAuthority,
  PoolCleanupClaims,
} from "../src/pool-cleanup-authority.ts";
import generatedPool from "../native/postgres-pool.generated.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  PoolBindingScope,
  PoolBindClaims,
  PoolNodeReport,
  PoolIoAttestation,
  PoolPodAttestation,
  poolBindingScopeHash,
  signPoolBindPermission,
  verifyPoolBindPermission,
} from "../src/postgres-pool.ts";
import { POOL_WORKLOAD_PROBE_RESULTS } from "../src/pool-workload-probe.ts";

it("keeps distinct server and client CA provenance and exact PEM bytes in a tenant bundle", async () => {
  const { PoolTenantBundle } = await import("../src/postgres-pool.ts"),
    scope = generatedPool.thin_scope,
    server = "\nserver-ca-public-fixture\n",
    client = "client-ca-public-fixture\n";
  const value = {
    v: 1,
    scope,
    scope_sha256: "a".repeat(64),
    holder_revision: 1,
    permission: null,
    storage_authority: null,
    server_certificate_pem: "leaf-public-fixture\n",
    server_private_key_pem: "fixture\n",
    server_ca_pem: server,
    client_ca_pem: client,
    ca_secret_uid: crypto.randomUUID(),
    ca_secret_resource_version: "server-31",
    ca_sha256: "b".repeat(64),
    client_ca_secret_uid: crypto.randomUUID(),
    client_ca_secret_resource_version: "client-47",
    tls_server_name: "database-rw.pgcf-db-" + scope.database_id + ".svc",
    archive: {
      destination_path: "s3://fixture/archive",
      server_name: "database",
      endpoint_url: "https://archive.invalid",
      retention_days: 7,
    },
  };
  const parsed = PoolTenantBundle.parse(value);
  expect(parsed.server_ca_pem).toBe(server);
  expect(parsed.client_ca_pem).toBe(client);
  const { server_ca_pem: _server, ...missing } = value;
  expect(_server).toBe(server);
  expect(PoolTenantBundle.safeParse(missing).success).toBe(false);
});

it("retains a bound Pod beside the ready refill target in one bounded preparation context", async () => {
  const { PoolPodPreparationContext, POSTGRES_POOL } =
    await import("../src/postgres-pool.ts");
  const value = {
    ...generatedPool.preparation,
    pods: [
      generatedPool.preparation.pods[0]!,
      {
        ...generatedPool.preparation.pods[0]!,
        pod_uid: crypto.randomUUID(),
        pod_name: "ready-refill",
      },
    ],
  };
  expect(value.policy.target_slots).toBe(1);
  expect(PoolPodPreparationContext.safeParse(value).success).toBe(true);
  expect(
    PoolPodPreparationContext.safeParse({
      ...value,
      pods: Array.from({ length: POSTGRES_POOL.max_inventory + 1 }, (_, i) => ({
        ...value.pods[0]!,
        pod_uid: crypto.randomUUID(),
        pod_name: "inventory-" + i,
      })),
    }).success,
  ).toBe(false);
});

it("signs a fixed full allocation reserve for drain/unmount without asserting a total BIO byte cap", async () => {
  const base = { ...generatedPool.cleanup.claims } as Record<string, unknown>;
  delete base.maximum_write_bytes;
  delete base.allocation_reserve_bytes;
  delete base.cleanup_mode;
  const value = {
    ...base,
    allocation_reserve_bytes: 1024 ** 3,
    cleanup_mode: "drain_unmount",
  };
  expect(PoolCleanupClaims.safeParse(value).success).toBe(true);
  expect(
    PoolCleanupClaims.safeParse({ ...value, cleanup_mode: "tenant_start" })
      .success,
  ).toBe(false);
  expect(
    PoolCleanupClaims.safeParse({ ...value, maximum_write_bytes: 1 }).success,
  ).toBe(false);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as {
    privateKey: StorageAuthorityCryptoKey;
    publicKey: StorageAuthorityCryptoKey;
  };
  const parsed = PoolCleanupClaims.parse(value);
  const token = await signPoolCleanupAuthority(parsed, pair.privateKey, 1000);
  expect(
    (
      await verifyPoolCleanupAuthority(
        token,
        new Map([[parsed.kid, pair.publicKey]]),
        1000,
      )
    )?.allocation_reserve_bytes,
  ).toBe(1024 ** 3);
});

it("permits only exact same-boot unclean reference destruction with reaped cleanup custody and global absence", () => {
  const scope = generatedPool.thin_scope,
    mounted = generatedPool.vectors.find(
      (v) => v.name === "finite-creator-fence",
    )!.value as unknown as PoolNodeReport;
  const io = PoolIoAttestation.parse(
    generatedPool.vectors.find((v) => v.name === "measured-thin-device")!.value,
  );
  const worker = {
    ...io.cgroups[0]!,
    pool_pod_uid: scope.pool_pod_uid,
    executable_sha256: scope.host_controller_sha256,
  };
  const value = {
    ...mounted,
    state: "released",
    storage_backend: "lvm-thin-v1",
    thin_guard: null,
    clean_stop: false,
    kernel_proof: {
      ...mounted.kernel_proof,
      mount_id: null,
      dm_open_count: 0,
      device_major: worker.device_major,
      device_minor: worker.device_minor,
      nonlazy_unmount_verified: false,
    },
    reference_destruction: {
      v: 1,
      operation_id: "op_" + "a".repeat(20),
      authority_revision: 9,
      cleanup_io_sha256: "b".repeat(64),
      cleanup_mode: "drain_unmount",
      dispatch_persisted: true,
      worker,
      worker_reaped: true,
      stopped_writers: scope.container_ids.map((container_id) => ({
        container_id,
        cgroup_inode:
          container_id === worker.container_id ? worker.cgroup_inode : 31,
        tenant_tasks_remaining: 0,
      })),
    },
  };
  expect(PoolNodeReport.safeParse(value).success).toBe(true);
  expect(PoolNodeReport.safeParse({ ...value, clean_stop: true }).success).toBe(
    false,
  );
  expect(
    PoolNodeReport.safeParse({
      ...value,
      boot_loss: {
        holder_boot_id: crypto.randomUUID(),
        storage: scope.storage,
      },
    }).success,
  ).toBe(false);
  expect(
    PoolNodeReport.safeParse({
      ...value,
      reference_destruction: {
        ...value.reference_destruction,
        worker_reaped: false,
      },
    }).success,
  ).toBe(false);
});

it("bounds the fixed readonly inspector to one prepared Pod and refuses an invented clean result", async () => {
  const pool = await import("../src/postgres-pool.ts"),
    scope = generatedPool.thin_scope;
  const preparation = {
    v: 1,
    node_id: scope.node_id,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: scope.pool_namespace_uid,
    policy_revision: 1,
    policy: generatedPool.vectors.find(
      (v) => v.name === "nested-valid-idle-budget",
    )!.value.policy!,
    observed_at: 1000,
    expires_at: 61000,
    qualification_run_id: crypto.randomUUID(),
    qualification_scope_sha256: "a".repeat(64),
    pods: [
      {
        pod_uid: scope.pool_pod_uid,
        pod_name: scope.pool_pod_name,
        pod_ip: scope.pool_pod_ip,
        container_ids: scope.container_ids,
      },
    ],
  };
  const signal = {
    v: 1,
    command: "inspect_readonly",
    permission: "pq1.fixture.signature",
    qualification_run_id: preparation.qualification_run_id,
    qualification_scope_sha256: "a".repeat(64),
    preparation_sha256: "b".repeat(64),
    nonce: "a".repeat(32),
    database_id: scope.database_id,
    source_generation: scope.generation - 1,
    configuration_fingerprint: scope.configuration_fingerprint,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    storage: scope.storage,
    pool_namespace: "pgcf-pool",
    pool_namespace_uid: scope.pool_namespace_uid,
    pool_pod_uid: scope.pool_pod_uid,
    container_ids: scope.container_ids,
    postgres_image_sha256: scope.class.postgres_image_sha256,
    supervisor_sha256: scope.supervisor_sha256,
    issued_at: 1000,
    expires_at: 31000,
    readonly: true,
    noload: true,
  };
  expect(
    pool.PoolStorageReadRequest.safeParse({ signal, preparation }).success,
  ).toBe(true);
  expect(
    pool.PoolStorageReadRequest.safeParse({
      signal: {
        ...signal,
        pool_pod_uid: crypto.randomUUID(),
      },
      preparation,
    }).success,
  ).toBe(false);
  expect(
    pool.PoolStorageReadSignal.safeParse({ ...signal, expires_at: 31001 })
      .success,
  ).toBe(false);
  const report = {
    v: 1,
    command: "inspect_readonly",
    qualification_run_id: signal.qualification_run_id,
    qualification_scope_sha256: signal.qualification_scope_sha256,
    preparation_sha256: signal.preparation_sha256,
    nonce: signal.nonce,
    database_id: scope.database_id,
    source_generation: scope.generation - 1,
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_pod_uid: scope.pool_pod_uid,
    postgres_image_sha256: scope.class.postgres_image_sha256,
    device_major: 253,
    device_minor: 1,
    state: "read",
    system_identifier: null,
    timeline: null,
    control_state: null,
    observed_at: 1100,
    error: null,
  };
  expect(pool.PoolStorageReadReport.safeParse(report).success).toBe(false);
  expect(
    pool.PoolStorageReadReport.safeParse({
      ...report,
      system_identifier: scope.system_identifier,
      timeline: scope.timeline,
      control_state: "shut down",
    }).success,
  ).toBe(true);
});
import {
  signRouteToken,
  verifyRouteToken,
  deriveRegionKey,
} from "../src/route-token.ts";

export const scopeInput = () => ({
  v: 1 as const,
  binding_id: crypto.randomUUID(),
  database_id: "d" + "a".repeat(19),
  generation: 7,
  route_revision: 19,
  admission_epoch: 23,
  configuration_fingerprint: "a".repeat(64),
  region_id: "eu-test",
  node_id: "nod_" + "a".repeat(20),
  node_uid: crypto.randomUUID(),
  boot_id: crypto.randomUUID(),
  pool_namespace: "pgcf-pool",
  pool_namespace_uid: crypto.randomUUID(),
  container_ids: ["b".repeat(64)],
  pool_pod_uid: crypto.randomUUID(),
  pool_pod_name: "pgcf-pool-test",
  pool_pod_ip: "10.1.2.3",
  container_id: "b".repeat(64),
  supervisor_key_sha256: "c".repeat(64),
  supervisor_sha256: "d".repeat(64),
  driver_image: "registry.example/openebs-lvm@sha256:" + "a".repeat(64),
  driver_sha256: "b".repeat(64),
  host_controller_sha256: "a".repeat(64),
  class: {
    postgres_image_sha256: "e".repeat(64),
    cpu_request_millicores: 100,
    cpu_limit_millicores: 250,
    memory_request_bytes: 256 * 1024 ** 2,
    memory_limit_bytes: 256 * 1024 ** 2,
    configuration_profile_sha256: "f".repeat(64),
  },
  storage: {
    backend: "lvm-thick-v1" as const,
    storage_generation: 1,
    storage_uid: crypto.randomUUID(),
    namespace_uid: crypto.randomUUID(),
    cnpg_cluster_uid: crypto.randomUUID(),
    pvc_uid: crypto.randomUUID(),
    pv_uid: crypto.randomUUID(),
    volume_handle: "pvc-" + crypto.randomUUID(),
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    lv_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
  },
  system_identifier: "7459021837620377423",
  timeline: 1,
  bundle_nonce: crypto.randomUUID(),
});

describe("PostgreSQL pool authority", () => {
  it("carries actual pool namespace and measured device custody without retagging a draining holder", () => {
    const scope = generatedPool.thin_scope,
      storage = scope.storage,
      now = 1000;
    const pool = {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: generatedPool.cleanup.claims.scope_sha256,
      holder_revision: 3,
      holder_generation: scope.generation,
      holder_boot_id: scope.boot_id,
      state: "detaching",
      pool_namespace: scope.pool_namespace,
      pool_namespace_uid: scope.pool_namespace_uid,
      pool_pod_uid: scope.pool_pod_uid,
      container_ids: scope.container_ids,
      device: {
        volume_group_uuid: storage.volume_group_uuid,
        lv_uuid: storage.lv_uuid,
        thin_id: storage.thin_id,
        device_major: 253,
        device_minor: 1,
      },
      cleanup_authority: null,
    };
    const entry = {
      database_id: scope.database_id,
      generation: 8,
      authority_revision: 8,
      write_blocked: true,
      desired_state: "suspended",
      node_uid: scope.node_uid,
      volume_group_uuid: storage.volume_group_uuid,
      pool_uuid: storage.profile.pool_uuid,
      profile_sha256: storage.profile.profile_sha256,
      startup_expires_at: null,
      startup_operation_id: null,
      runtime_authority: null,
      volume: {
        storage_generation: storage.storage_generation,
        storage_uid: storage.storage_uid,
        namespace_uid: storage.namespace_uid,
        cluster_uid: storage.cnpg_cluster_uid,
        node_uid: scope.node_uid,
        volume_group_uuid: storage.volume_group_uuid,
        pool_uuid: storage.profile.pool_uuid,
        volume_handle: storage.volume_handle,
        lv_uuid: storage.lv_uuid,
        pvc_uid: storage.pvc_uid,
        pv_uid: storage.pv_uid,
      },
      pool,
    };
    const lease = {
      purpose: "pgcf-storage-host/v1",
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      material_revision: 1,
      issued_at: now,
      expires_at: 11000,
      legacy: [],
      databases: [entry],
    };
    expect(
      NodeThinStorageLease.shape.databases.element.safeParse({
        id: scope.database_id,
        generation: 8,
        storage_generation: storage.storage_generation,
        desired_state: "suspended",
        archive_path: "s3://test-archive/database",
        power_operation: null,
        storage: storage.profile,
        volume: entry.volume,
        startup: null,
        pool,
      }).success,
    ).toBe(true);
    expect(HostStorageLease.safeParse(lease).success).toBe(true);
    expect(
      HostStorageLease.safeParse({
        ...lease,
        databases: [
          {
            ...entry,
            pool: {
              ...pool,
              device: {
                ...pool.device,
                lv_uuid: "dddddd-dddd-dddd-dddd-dddd-dddd-dddddd",
              },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      HostStorageLease.safeParse({
        ...lease,
        databases: [{ ...entry, pool: { ...pool, holder_generation: 9 } }],
      }).success,
    ).toBe(false);
    expect(
      HostStorageLease.safeParse({
        ...lease,
        databases: [
          {
            ...entry,
            desired_state: "running",
            write_blocked: false,
            startup_expires_at: 9000,
            startup_operation_id: "op_" + "a".repeat(20),
            pool: { ...pool, device: null },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("refuses a positive Pod attestation if its actual OCI probe allowed namespace creation", () => {
    const scope = scopeInput(),
      now = Date.now();
    const pod = {
      v: 1,
      node_id: scope.node_id,
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_namespace: scope.pool_namespace,
      pool_namespace_uid: scope.pool_namespace_uid,
      container_ids: scope.container_ids,
      pool_pod_uid: scope.pool_pod_uid,
      pool_pod_name: scope.pool_pod_name,
      pool_pod_ip: scope.pool_pod_ip,
      container_id: scope.container_id,
      supervisor_sha256: scope.supervisor_sha256,
      supervisor_key_sha256: scope.supervisor_key_sha256,
      supervisor_public_key_pem: "controlled public key",
      supervisor_certificate_pem: "controlled public certificate",
      class: scope.class,
      propagation_verified: true,
      workload_isolation: {
        uid: 26,
        cap_sys_admin: false,
        seccomp_runtime_default: true,
        namespace_creation_denied: true,
        mount_api_denied: true,
      },
      workload_probes: [
        {
          container_id: scope.container_id,
          probe: {
            v: 1,
            uid: 26,
            cap_eff: "0000000000000000",
            cap_sys_admin: false,
            seccomp_mode: 2,
            no_new_privs: true,
            observed_at: now,
            results: {
              ...Object.fromEntries(
                POOL_WORKLOAD_PROBE_RESULTS.map((name) => [name, 1]),
              ),
              unshare_user: null,
            },
          },
        },
      ],
      observed_at: now,
    };
    expect(PoolPodAttestation.safeParse(pod).success).toBe(false);
  });
  it("keeps cleanup authority separate from writer permission and refuses an extended drain window", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as {
      privateKey: StorageAuthorityCryptoKey;
      publicKey: StorageAuthorityCryptoKey;
    };
    const claims = PoolCleanupClaims.parse(generatedPool.cleanup.claims);
    const token = await signPoolCleanupAuthority(claims, pair.privateKey, 1000);
    const keys = new Map([[claims.kid, pair.publicKey]]);
    expect(await verifyPoolCleanupAuthority(token, keys, 1000)).toEqual(claims);
    expect(await verifyPoolCleanupAuthority(token, keys, 11000)).toBeNull();
    expect(await verifyPoolBindPermission(token, keys, 1000)).toBeNull();
    await expect(
      signPoolCleanupAuthority(
        { ...claims, exp: 11001 },
        pair.privateKey,
        1000,
      ),
    ).rejects.toThrow();
    await expect(
      signPoolCleanupAuthority(
        {
          ...claims,
          write_bytes_per_second:
            claims.storage.profile.write_bytes_per_second + 1,
        },
        pair.privateKey,
        1000,
      ),
    ).rejects.toThrow();
  });
  it("requires a measured thin device and rejects cgroups measured on another device", () => {
    const scope = scopeInput();
    const value = {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: "a".repeat(64),
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_namespace_uid: scope.pool_namespace_uid,
      pool_pod_uid: scope.pool_pod_uid,
      observed_at: Date.now(),
      device: {
        volume_group_uuid: scope.storage.volume_group_uuid,
        lv_uuid: scope.storage.lv_uuid,
        thin_id: 42,
        device_major: 253,
        device_minor: 1,
      },
      shared_pod_io: {
        pod_cgroup_inode: 11,
        device_major: 253,
        device_minor: 1,
        write_bytes_per_second: 1048576,
        write_iops_per_second: 100,
        io_max_verified: true,
        all_writer_cgroups_descendants: true as const,
      },
      cgroups: [
        {
          container_id: scope.container_id,
          cgroup_inode: 12,
          pid: 26,
          start_ticks: 42,
          pid_namespace: 13,
          device_major: 253,
          device_minor: 1,
          write_bytes_per_second: 1048576,
          write_iops_per_second: 100,
          io_max_verified: true,
        },
      ],
    };
    expect(PoolIoAttestation.safeParse(value).success).toBe(true);
    expect(
      PoolIoAttestation.safeParse({
        ...value,
        cgroups: [{ ...value.cgroups[0], device_minor: 2 }],
      }).success,
    ).toBe(false);
    const { device: _device, ...missingDevice } = value;
    expect(_device.thin_id).toBe(42);
    expect(PoolIoAttestation.safeParse(missingDevice).success).toBe(false);
  });
  it("seals the immutable physical scope under its own Ed25519 domain and bounded permission", async () => {
    const scope = PoolBindingScope.parse(scopeInput());
    const scope_sha256 = await poolBindingScopeHash(scope);
    expect(
      await poolBindingScopeHash({
        ...scope,
        storage: { ...scope.storage, pv_uid: crypto.randomUUID() },
      }),
    ).not.toBe(scope_sha256);
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as {
      privateKey: StorageAuthorityCryptoKey;
      publicKey: StorageAuthorityCryptoKey;
    };
    const now = Date.now();
    const claims = PoolBindClaims.parse({
      v: 1,
      kid: "test",
      scope,
      scope_sha256,
      holder_revision: 3,
      iat: now,
      exp: now + 30000,
    });
    const token = await signPoolBindPermission(claims, pair.privateKey, now);
    const keys = new Map([["test", pair.publicKey]]);
    expect(await verifyPoolBindPermission(token, keys, now)).toEqual(claims);
    expect(
      await verifyPoolBindPermission(token.replace(/^pb1/, "sa1"), keys, now),
    ).toBeNull();
    expect(await verifyPoolBindPermission(token, keys, now + 30000)).toBeNull();
    await expect(
      signPoolBindPermission(
        { ...claims, exp: now + 30001 },
        pair.privateKey,
        now,
      ),
    ).rejects.toThrow();
  });

  it("refuses a released volume with any opener or incomplete mount coverage", () => {
    const scope = scopeInput();
    const report = {
      v: 1,
      binding_id: scope.binding_id,
      scope_sha256: "a".repeat(64),
      node_uid: scope.node_uid,
      boot_id: scope.boot_id,
      pool_pod_uid: scope.pool_pod_uid,
      state: "released",
      observed_at: Date.now(),
      storage_backend: "lvm-thick-v1",
      thin_guard: null,
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
        nonlazy_unmount_verified: true,
        never_attached_verified: false,
        creator_fence: null,
        mountpoint: null,
      },
      clean_stop: true,
      error: null,
    };
    expect(PoolNodeReport.safeParse(report).success).toBe(true);
    expect(
      PoolNodeReport.safeParse({
        ...report,
        storage_backend: "lvm-thick-v1",
        thin_guard: null,
        kernel_proof: { ...report.kernel_proof, dm_open_count: 1 },
      }).success,
    ).toBe(false);
    expect(
      PoolNodeReport.safeParse({
        ...report,
        state: "mounted",
        clean_stop: null,
        storage_backend: "lvm-thick-v1",
        thin_guard: null,
        kernel_proof: {
          ...report.kernel_proof,
          mount_id: 42,
          dm_open_count: 1,
          complete_namespace_scan: false,
        },
      }).success,
    ).toBe(false);
  });

  it("signs an explicit v4 pool route while retaining generation and separate route revision", async () => {
    const scope = PoolBindingScope.parse(scopeInput());
    const now = Date.now(),
      master = new Uint8Array(32).fill(9);
    const token = await signRouteToken({
      db: scope.database_id,
      user: "owner",
      cid: crypto.randomUUID(),
      region: scope.region_id,
      now,
      keyring: { active: "test", keys: new Map([["test", master]]) },
      target: {
        kind: "pool",
        revision: scope.generation,
        route_revision: scope.route_revision,
        pod_uid: scope.pool_pod_uid,
        binding_id: scope.binding_id,
        node_uid: scope.node_uid,
        pod_ip: scope.pool_pod_ip,
        storage_generation: scope.storage.storage_generation,
        scope_sha256: await poolBindingScopeHash(scope),
      },
    });
    const verified = await verifyRouteToken(token, {
      region: scope.region_id,
      now,
      keys: new Map([["test", await deriveRegionKey(master, scope.region_id)]]),
    });
    expect(verified.ok).toBe(true);
    if (verified.ok)
      expect(verified.claims).toMatchObject({
        v: 4,
        rev: 7,
        route_revision: 19,
        kind: "pool",
        binding_id: scope.binding_id,
      });
  });
});

it("accepts a proven finite creator fence with honest incomplete global census and refuses missing closure", () => {
  const scope = scopeInput();
  const kernel = {
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
      scope_sha256: "a".repeat(64),
      storage_uid: scope.storage.storage_uid,
      volume_handle: scope.storage.volume_handle,
      volume_group_uuid: scope.storage.volume_group_uuid,
      lv_uuid: scope.storage.lv_uuid,
      driver_gate_protocol: 1,
      driver_image: "registry.example/openebs-lvm@sha256:" + "a".repeat(64),
      driver_sha256: "b".repeat(64),
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
  };
  const report = {
    v: 1,
    binding_id: scope.binding_id,
    scope_sha256: "a".repeat(64),
    node_uid: scope.node_uid,
    boot_id: scope.boot_id,
    pool_pod_uid: scope.pool_pod_uid,
    state: "mounted",
    observed_at: Date.now(),
    storage_backend: "lvm-thick-v1",
    thin_guard: null,
    kernel_proof: kernel,
    clean_stop: null,
    error: null,
  };
  expect(PoolNodeReport.safeParse(report).success).toBe(true);
  expect(
    PoolNodeReport.safeParse({
      ...report,
      storage_backend: "lvm-thick-v1",
      thin_guard: null,
      kernel_proof: { ...kernel, creator_fence: null },
    }).success,
  ).toBe(false);
  expect(
    PoolNodeReport.safeParse({
      ...report,
      storage_backend: "lvm-thick-v1",
      thin_guard: null,
      kernel_proof: {
        ...kernel,
        creator_fence: { ...kernel.creator_fence, creation_fds_closed: false },
      },
    }).success,
  ).toBe(false);
});

it("never downgrades a malformed explicit pool target into a v3 route", async () => {
  const scope = scopeInput();
  const input = {
    db: scope.database_id,
    user: "app",
    cid: crypto.randomUUID(),
    region: scope.region_id,
    keyring: {
      active: "test",
      keys: new Map([["test", new Uint8Array(32).fill(9)]]),
    },
    target: {
      kind: "pool",
      revision: scope.generation,
      pod_uid: scope.pool_pod_uid,
      binding_id: scope.binding_id,
      node_uid: scope.node_uid,
      pod_ip: scope.pool_pod_ip,
      storage_generation: scope.storage.storage_generation,
      scope_sha256: "a".repeat(64),
    },
  };
  await expect(
    signRouteToken(input as Parameters<typeof signRouteToken>[0]),
  ).rejects.toThrow();
});

it("binds thin pool storage to its immutable profile, actual thin ID and node identity", () => {
  const scope = scopeInput();
  const profile = {
    backend: "lvm-thin-v1",
    storage_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    volume_attributes_class: "pgcf-lvm-thin-v1-" + "a".repeat(16),
    profile_revision: 1,
    profile_sha256: "a".repeat(64),
    node_uid: scope.node_uid,
    volume_group_uuid: scope.storage.volume_group_uuid,
    pool_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    startup_reserve_bytes: 1048576,
    write_bytes_per_second: 1048576,
    write_iops_per_second: 100,
    guard_seconds: 30,
    drain_seconds: 10,
  };
  const thin = {
    ...scope,
    storage: { ...scope.storage, backend: "lvm-thin-v1", thin_id: 17, profile },
  };
  expect(PoolBindingScope.safeParse(thin).success).toBe(true);
  expect(
    PoolBindingScope.safeParse({
      ...thin,
      storage: {
        ...thin.storage,
        profile: { ...profile, node_uid: crypto.randomUUID() },
      },
    }).success,
  ).toBe(false);
});
