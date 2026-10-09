// SPDX-License-Identifier: Apache-2.0
// Execute the existing TypeScript coordinator at its deterministic I/O boundary.
// These fixtures are conformance inputs, never live acceptance or product defaults.
import { readFile } from "node:fs/promises";
import {
  PowerCoordinator,
  desiredPower,
} from "../../../apps/regional/src/agent/power.ts";
import { MemoryKubernetes } from "../../../apps/regional/test/agent/fixtures.ts";
import { record } from "../../../apps/regional/src/agent/types.ts";
import type { DesiredDatabase, K8sObject } from "../src/index.ts";
import { MAINTENANCE_ROLE } from "../src/maintenance.ts";
import type {
  SleepProbeOptions,
  SleepSafetyResult,
} from "../../../apps/regional/src/agent/sleep.ts";
const uid = (n: number) =>
  `01234567-89ab-4def-8123-${n.toString(16).padStart(12, "0")}`;
const id = `d${"b".repeat(19)}`,
  initial = `op_${"c".repeat(20)}`,
  suspend = `op_${"d".repeat(20)}`,
  resume = `op_${"e".repeat(20)}`;
const closed = "000000010000000000000001";
const raw = await readFile(
  new URL("controller-vectors.generated.json", import.meta.url),
  "utf8",
);
const base = JSON.parse(raw)[0].db as DesiredDatabase;
export function powerIntentVectors() {
  const stopped = {
    ...base,
    generation: 2,
    desired_state: "suspended",
    power: {
      operation: suspend,
      revision: 2,
      mode: "quiesce",
      reason: "manual",
    },
  } as DesiredDatabase;
  const cases = [
    ["absent", base],
    ["manual", stopped],
    ["idle", { ...stopped, power: { ...stopped.power!, reason: "idle" } }],
    [
      "running",
      {
        ...base,
        generation: 3,
        power: {
          operation: resume,
          revision: 3,
          mode: "running",
          reason: null,
        },
      },
    ],
    [
      "wrong-revision",
      { ...stopped, power: { ...stopped.power!, revision: 1 } },
    ],
    ["wrong-state", { ...stopped, desired_state: "running" }],
    [
      "wrong-reason",
      { ...stopped, power: { ...stopped.power!, reason: false } },
    ],
  ] as const;
  return cases.map(([name, db]) => {
    try {
      return { name, db, intent: desiredPower(db as DesiredDatabase) ?? null };
    } catch {
      return { name, db, rejected: true };
    }
  });
}
function setup() {
  const k8s = new MemoryKubernetes();
  let revision = 0;
  const put = (value: K8sObject) => {
    const resource = {
      ...structuredClone(value),
      metadata: {
        ...structuredClone(value.metadata),
        uid: uid(++revision),
        resourceVersion: String(revision),
      },
    };
    k8s.resources.set(
      k8s.key(
        resource.kind,
        resource.metadata.namespace,
        resource.metadata.name,
      ),
      resource,
    );
    k8s.revision = revision;
    return resource;
  };
  const namespace = `pgcf-db-${id}`;
  const ns = put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespace, labels: { "pgcf.io/database-id": id } },
  });
  const cluster = put({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace,
      labels: { "pgcf.io/database-id": id },
    },
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
  const claim = put({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name: "database-1", namespace },
    spec: { volumeName: "pvc-" + uid(3), storageClassName: "pgcf-lvm" },
    status: { phase: "Bound" },
  });
  const volume = put({
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: { name: "pvc-" + uid(3) },
    spec: {
      storageClassName: "pgcf-lvm",
      csi: { driver: "local.csi.openebs.io", volumeHandle: "pvc-" + uid(3) },
      claimRef: { name: "database-1", namespace, uid: claim.metadata.uid },
    },
    status: { phase: "Bound" },
  });
  put({
    apiVersion: "local.openebs.io/v1alpha1",
    kind: "LVMVolume",
    metadata: { name: volume.metadata.name, namespace: "openebs" },
  });
  const fence = put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `gateway-fence-${id}`,
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": id, "pgcf.io/gateway-fence": "true" },
    },
    data: {
      "intent.json": JSON.stringify({
        database: id,
        operation: initial,
        revision: 1,
        mode: "running",
      }),
    },
  });
  put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `storage-${id}`,
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": id },
      annotations: {
        "pgcf.io/generation": "1",
        "pgcf.io/gateway-fence-uid": fence.metadata.uid,
        "pgcf.io/volume-identity": JSON.stringify({
          claimUid: claim.metadata.uid,
          volumeUid: volume.metadata.uid,
          handle: volume.metadata.name,
        }),
      },
    },
    data: {
      state: JSON.stringify({
        namespaceUid: ns.metadata.uid,
        clusterUid: cluster.metadata.uid,
        node: base.node,
        archivePath: base.archive.destination_path,
      }),
    },
  });
  put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "maintenance-credentials",
      namespace,
      labels: { "pgcf.io/database-id": id },
    },
    data: {
      username: Buffer.from(MAINTENANCE_ROLE).toString("base64"),
      password: Buffer.from(base.maintenance!.password).toString("base64"),
    },
  });
  put({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: `ca-${id}`,
      namespace: "pgcf-system",
      labels: { "pgcf.io/database-id": id },
    },
    data: {
      "ca.crt": "conformance fixture; SQL boundary is separately tested",
    },
  });
  put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pgcf-gateway", namespace: "pgcf-system" },
    data: {
      PGCF_ROUTE_KEY: Buffer.from(
        JSON.stringify({
          active: "vector",
          keys: { vector: Buffer.alloc(32, 7).toString("base64url") },
        }),
      ).toString("base64"),
    },
  });
  for (const ordinal of [1, 2])
    put({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: `gateway-${ordinal}`,
        namespace: "pgcf-system",
        labels: { "app.kubernetes.io/name": "pgcf-gateway" },
      },
      spec: { serviceAccountName: "pgcf-gateway" },
      status: {
        podIP: `10.20.0.${ordinal}`,
        containerStatuses: [{ name: "gateway", restartCount: 0 }],
      },
    });
  put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "database-1",
      namespace,
      labels: { "cnpg.io/cluster": "database" },
    },
  });
  const fetcher: typeof fetch = async (_url, options) => {
    const token = new Headers(options?.headers).get("X-PGCF-Control")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    const map = k8s.resources.get(
      k8s.key("ConfigMap", "pgcf-system", `gateway-fence-${id}`),
    )!;
    const intent = JSON.parse(String(record(map.data)["intent.json"]));
    return Response.json({
      database: id,
      operation: claims.operation,
      revision: claims.revision,
      pod: claims.pod,
      mode: intent.mode,
      status:
        intent.mode === "running"
          ? "running"
          : claims.action === "close"
            ? "closed"
            : "idle",
      connections: 0,
      busyConnections: 0,
      pendingDials: 0,
    });
  };
  const target = {
    ...base,
    generation: 2,
    desired_state: "suspended",
    power: {
      operation: suspend,
      revision: 2,
      mode: "quiesce",
      reason: "manual",
    },
  } as DesiredDatabase;
  return { k8s, fetcher, target, cluster, namespace, fence };
}
export async function powerProgressVectors() {
  const vectors = [];
  for (const scenario of [
    "sql_busy",
    "switch_unknown",
    "archive_timeout",
    "safe",
    "confirmed",
    "cold-configuration",
    "wake",
    "awake",
  ] as const) {
    const state = setup();
    let probes = 0;
    const probe = async (
      options: SleepProbeOptions,
    ): Promise<SleepSafetyResult> => {
      probes++;
      if (scenario === "sql_busy" || scenario === "switch_unknown")
        return { safe: false, reason: scenario };
      await options.onClosedSegment!(closed);
      return scenario === "archive_timeout"
        ? { safe: false, reason: "archive_timeout", segment: closed }
        : { safe: true, segment: closed };
    };
    const coordinator = new PowerCoordinator({
      k8s: state.k8s,
      signal: new AbortController().signal,
      region: "eu-test",
      replicas: 2,
      now: () => 100000,
      fetcher: state.fetcher,
      probe,
      resume: async (_options, segment) => ({ safe: true, segment }),
    });
    let db = state.target,
      observation: unknown = await coordinator.suspend(db),
      prepared: string | undefined;
    if (
      ["confirmed", "cold-configuration", "wake", "awake"].includes(scenario)
    ) {
      const cluster = state.k8s.resources.get(
        state.k8s.key("Cluster", state.namespace, "database"),
      )!;
      cluster.status = {
        conditions: [
          { type: "cnpg.io/hibernation", status: "True", reason: "Hibernated" },
        ],
      };
      state.k8s.resources.delete(
        state.k8s.key("Pod", state.namespace, "database-1"),
      );
      observation = await coordinator.suspend(db);
      if (scenario === "cold-configuration") {
        db = { ...db, generation: 3, power: { ...db.power!, revision: 3 } };
        observation = await coordinator.suspend(db);
      }
      if (scenario === "wake" || scenario === "awake") {
        db = {
          ...db,
          generation: 3,
          desired_state: "running",
          power: {
            operation: resume,
            revision: 3,
            mode: "running",
            reason: null,
          },
        };
        const result = await coordinator.prepareRunning(db);
        prepared =
          result === undefined
            ? "proceed"
            : result === null
              ? "pending"
              : "observation";
        if (scenario === "awake")
          observation = await coordinator.finishRunning(db, {
            id,
            generation: 3,
            state: "ready",
            archive: { continuous: true, ready_wal_files: 0 },
          });
      }
    }
    const map = state.k8s.resources.get(
      state.k8s.key("ConfigMap", "pgcf-system", `gateway-fence-${id}`),
    )!;
    const cluster = state.k8s.resources.get(
      state.k8s.key("Cluster", state.namespace, "database"),
    )!;
    vectors.push({
      name: scenario,
      db,
      observation: observation ?? null,
      prepared,
      progress: JSON.parse(String(record(map.data)["power.json"])),
      intent: JSON.parse(String(record(map.data)["intent.json"])),
      hibernation:
        cluster.metadata.annotations?.["cnpg.io/hibernation"] ?? null,
      probes,
    });
  }
  return vectors;
}

export async function physicalReclamationVectors() {
  const {
    DesiredDatabaseStorage,
    NodeThinStorageAuthority,
    thinStorageVolumeReclaimed,
  } = await import("../src/database-storage.ts");
  const storage = DesiredDatabaseStorage.parse({
    backend: "lvm-thin-v1",
    storage_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
    volume_attributes_class: "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa",
    profile_revision: 1,
    profile_sha256: "a".repeat(64),
    node_uid: uid(4),
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
    startup_reserve_bytes: 1048576,
    write_bytes_per_second: 1048576,
    write_iops_per_second: 10,
    guard_seconds: 2,
    drain_seconds: 1,
  });
  const authority = NodeThinStorageAuthority.parse({
    node_id: `nod_${"n".repeat(20)}`,
    name: "native-test-node",
    node_uid: uid(4),
    cluster_uid: uid(5),
    revision: 3,
    profile_revision: 1,
    profile_sha256: storage.profile_sha256,
    storage_class: storage.storage_class,
    volume_group_uuid: storage.volume_group_uuid,
    pool_uuid: null,
    driver_pod_uid: uid(6),
    driver_image: `ghcr.io/test/driver@sha256:${"b".repeat(64)}`,
    observed_at: new Date(100001).toISOString(),
    captured_at: new Date(100001).toISOString(),
    expires_at: new Date(102001).toISOString(),
    write_allowed: false,
    physical: {
      volume_group_uuid: storage.volume_group_uuid,
      total_bytes: 10000000,
      free_bytes: 10000000,
      thick_allocated_bytes: 0,
      thin_pool: null,
    },
    physical_lvs: [],
    active_lv_uuids: [],
    data_accounting_complete: true,
    protections: [],
    volumes: [],
  });
  const lv = "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh";
  const variants: Array<[string, typeof authority]> = [
    ["reclaimed_after_last_pool_removed", authority],
    [
      "physical_lv_still_present",
      {
        ...authority,
        physical_lvs: [
          { name: "owned", lv_uuid: lv, size_bytes: 1048576, segtype: "thin" },
        ],
      },
    ],
    [
      "active_kernel_device_still_present",
      { ...authority, active_lv_uuids: [lv] },
    ],
    [
      "physical_accounting_incomplete",
      { ...authority, data_accounting_complete: false },
    ],
    [
      "stale_predelete_report",
      { ...authority, observed_at: new Date(99999).toISOString() },
    ],
    ["replacement_node_uid", { ...authority, node_uid: uid(999) }],
  ];
  return variants.map(([name, value]) => ({
    name,
    db: { node: "native-test-node", storage },
    nodes: [NodeThinStorageAuthority.parse(value)],
    lv,
    after: 100000,
    now: 100002,
    expected: thinStorageVolumeReclaimed(storage, value, lv, 100000, 100002),
  }));
}
