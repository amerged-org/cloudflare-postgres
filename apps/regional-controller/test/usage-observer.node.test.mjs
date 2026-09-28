import assert from "node:assert/strict";
import test from "node:test";

test("observes owned actual container requests and preserves proven retained volume identity", async () => {
  const { observeUsage } = await import("../src/usage-observer.ts");
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const regionId = "22222222-2222-4222-8222-222222222222";
  const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": environmentId,
    "pgcf.io/region-id": regionId,
  };
  const annotations = { "pgcf.io/spec-hash": "a".repeat(64) };
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace,
      uid: "cluster-uid",
      labels,
      annotations,
    },
    spec: {
      instances: 9,
      resources: { requests: { cpu: "99", memory: "99Gi" } },
      storage: { size: "99Gi", storageClass: "test-local" },
    },
    status: { currentPrimary: "database-1" },
  };
  const owner = [
    {
      kind: "Cluster",
      name: "database",
      apiVersion: "postgresql.cnpg.io/v1",
      uid: cluster.metadata.uid,
      controller: true,
    },
  ];
  const postgres = {
    name: "postgres",
    resources: { requests: { cpu: "250m", memory: "1.5Gi" } },
    volumeMounts: [{ name: "pgdata", mountPath: "/var/lib/postgresql/data" }],
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "database-1",
      namespace,
      uid: "pod-primary",
      ownerReferences: owner,
      labels: { "cnpg.io/cluster": "database", "cnpg.io/podRole": "instance" },
    },
    spec: {
      nodeName: "node-1",
      containers: [
        postgres,
        {
          name: "barman-sidecar",
          resources: { requests: { cpu: "5e-2", memory: "1536Ki" } },
        },
      ],
      volumes: [
        { name: "pgdata", persistentVolumeClaim: { claimName: "database-1" } },
      ],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "False" }],
    },
  };
  const replica = structuredClone(pod);
  replica.metadata.name = "database-2";
  replica.metadata.uid = "pod-replica";
  replica.spec.containers = [
    {
      ...postgres,
      resources: { requests: { cpu: "100m", memory: "9007199254740993" } },
    },
  ];
  replica.spec.volumes = [];
  replica.status.phase = "Pending";
  const impostor = structuredClone(pod);
  impostor.metadata.name = "database-impostor";
  impostor.metadata.uid = "pod-impostor";
  impostor.metadata.ownerReferences[0].uid = "another-cluster";
  const inventory = {
    namespaces: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          uid: "namespace-uid",
          labels,
          annotations,
        },
      },
    ],
    clusters: [cluster],
    pods: [pod, replica, impostor],
    pvcs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: "database-1", namespace, uid: "pvc-uid" },
        spec: {
          volumeName: "volume-1",
          storageClassName: "test-local",
          resources: { requests: { storage: "99Gi" } },
        },
        status: { phase: "Bound", capacity: { storage: "1536Mi" } },
      },
    ],
    pvs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: { name: "volume-1", uid: "pv-uid" },
        spec: {
          capacity: { storage: "2Gi" },
          storageClassName: "test-local",
          persistentVolumeReclaimPolicy: "Retain",
          claimRef: { namespace, name: "database-1", uid: "pvc-uid" },
        },
        status: { phase: "Bound" },
      },
    ],
  };
  const observed = observeUsage(inventory, regionId, []);
  const rate = (metric, attribution, resourceUid) =>
    observed.allocations.find(
      (allocation) =>
        allocation.metric === metric &&
        allocation.attribution === attribution &&
        allocation.resourceUid === resourceUid,
    )?.rate;
  assert.equal(
    rate("cpu_millicore_ms", "primary", "pod-primary:postgres"),
    "250",
  );
  assert.equal(
    rate("memory_byte_ms", "primary", "pod-primary:postgres"),
    "1610612736",
  );
  assert.equal(
    rate("cpu_millicore_ms", "platform", "pod-primary:barman-sidecar"),
    "50",
  );
  assert.equal(
    rate("memory_byte_ms", "platform", "pod-primary:barman-sidecar"),
    "1572864",
  );
  assert.equal(
    rate("cpu_millicore_ms", "replica", "pod-replica:postgres"),
    "100",
  );
  assert.equal(
    rate("memory_byte_ms", "replica", "pod-replica:postgres"),
    "9007199254740993",
  );
  assert.equal(rate("data_storage_byte_ms", "primary", "pv-uid"), "2147483648");
  assert.equal(
    observed.allocations.some((allocation) =>
      allocation.resourceUid.startsWith("pod-impostor"),
    ),
    false,
  );
  assert.equal(
    observed.issues.some((issue) => issue.environmentId === environmentId),
    true,
  );
  assert.equal(observed.volumeBindings.length, 1);

  const retainedInventory = structuredClone(inventory);
  retainedInventory.pods = [];
  retainedInventory.pvcs = [];
  retainedInventory.pvs[0].status.phase = "Released";
  const retained = observeUsage(
    retainedInventory,
    regionId,
    observed.volumeBindings,
  );
  assert.deepEqual(
    retained.allocations.map(({ metric, attribution, resourceUid, rate }) => ({
      metric,
      attribution,
      resourceUid,
      rate,
    })),
    [
      {
        metric: "data_storage_byte_ms",
        attribution: "primary",
        resourceUid: "pv-uid",
        rate: "2147483648",
      },
    ],
  );
  const relabelledOnly = observeUsage(retainedInventory, regionId, []);
  assert.equal(relabelledOnly.allocations.length, 0);
  retainedInventory.pvs[0].spec.claimRef.uid = "different-pvc";
  const reassigned = observeUsage(
    retainedInventory,
    regionId,
    observed.volumeBindings,
  );
  assert.equal(reassigned.allocations.length, 0);
  assert.equal(
    reassigned.issues.some((issue) => issue.environmentId === environmentId),
    true,
  );
});
