// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileEnvironment } from "../src/reconcile.ts";
import { SuspendJournal, reconcileSuspend } from "../src/suspend-reconcile.ts";

const ids = {
  environment: "11111111-1111-4111-8111-111111111111",
  region: "22222222-2222-4222-8222-222222222222",
  namespace: "33333333-3333-4333-8333-333333333333",
  cluster: "44444444-4444-4444-8444-444444444444",
  quota: "55555555-5555-4555-8555-555555555555",
  pooler: "66666666-6666-4666-8666-666666666666",
  cohort: "77777777-7777-4777-8777-777777777777",
  deployment: "88888888-8888-4888-8888-888888888888",
  replacement: "99999999-9999-4999-8999-999999999999",
};
const namespace = `pgcf-${ids.environment.replaceAll("-", "")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(order(value));
function order(value) {
  if (Array.isArray(value)) return value.map(order);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, order(value[key])]),
    );
  return value;
}
const owner = (kind, name, uid, apiVersion) => ({
  kind,
  name,
  uid,
  apiVersion,
  controller: true,
});
const node = (name, uid, boot) => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { name, uid, resourceVersion: "1" },
  status: { nodeInfo: { bootID: boot } },
});
const initialNodes = [
  node(
    "node-b",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  ),
  node(
    "node-a",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ),
];
const affinity = {
  requiredDuringSchedulingIgnoredDuringExecution: {
    nodeSelectorTerms: [
      {
        matchFields: [
          {
            key: "metadata.name",
            operator: "In",
            values: ["node-a", "node-b"],
          },
        ],
      },
    ],
  },
};
const pooling = {
  version: 1,
  image: `ghcr.io/cloudnative-pg/pgbouncer@sha256:${"e".repeat(64)}`,
  mode: "session",
  compute: {
    requests: { cpuMilli: 100, memoryMiB: 64 },
    limits: { cpuMilli: 200, memoryMiB: 128 },
  },
  connections: {
    maxClients: 10,
    poolSize: 2,
    maxDatabaseConnections: 4,
    maxUserConnections: 4,
  },
  timeouts: { queryWaitSeconds: 10, connectSeconds: 10, cancelWaitSeconds: 10 },
};
const spec = {
  name: "tracked",
  regionId: ids.region,
  catalogVersion: "v1",
  profileId: "small",
  volumeGiB: 4,
  profile: {
    id: "small",
    postgresImage: `ghcr.io/cloudnative-pg/postgresql@sha256:${"d".repeat(64)}`,
    compute: { cpuMilli: 500, memoryMiB: 512 },
    storage: {
      classId: "local",
      storageClassName: "local",
      minGiB: 1,
      maxGiB: 8,
      stepGiB: 1,
    },
    instances: 1,
    pooling,
    executionFencing: { version: 1 },
    nodeTracking: { version: 1 },
    backup: {
      endpointURL: "https://backup.example.invalid",
      region: "auto",
      destinationPath: "s3://private-backup",
      retentionPolicy: "30d",
      credentialSecret: {
        namespace: "platform-secrets",
        name: "backup",
        accessKeyIdKey: "id",
        secretAccessKeyKey: "key",
      },
    },
  },
};
const specHash = hash(JSON.stringify(spec));
const claim = {
  operationId: ids.replacement,
  environmentId: ids.environment,
  regionId: ids.region,
  kind: "environment.create",
  leaseToken: `cplease_${"l".repeat(43)}`,
  leaseEpoch: 1,
  leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  specRevision: 1,
  specHash,
  spec,
  runEpoch: "1",
};
const config = {
  operatorNamespace: "cnpg-system",
  operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
  allowedBackupSecrets: [spec.profile.backup.credentialSecret],
};
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/environment-id": ids.environment,
  "pgcf.io/region-id": ids.region,
};
const annotations = { "pgcf.io/spec-hash": specHash, "pgcf.io/run-epoch": "1" };
const metadata = (name, uid) => ({
  name,
  namespace,
  uid,
  generation: 1,
  resourceVersion: "1",
  labels: { ...labels },
  annotations: { ...annotations },
});
const cohortData = {
  version: 1,
  environmentId: ids.environment,
  regionId: ids.region,
  specHash,
  runEpoch: "1",
  namespaceUid: ids.namespace,
  nodes: [
    {
      name: "node-a",
      uid: initialNodes[1].metadata.uid,
      bootId: initialNodes[1].status.nodeInfo.bootID,
    },
    {
      name: "node-b",
      uid: initialNodes[0].metadata.uid,
      bootId: initialNodes[0].status.nodeInfo.bootID,
    },
  ],
};

function provisioning() {
  const resources = new Map(),
    creations = [],
    nodes = structuredClone(initialNodes);
  let lostCohortReply = true;
  const key = (kind, name) => `${kind}/${name}`;
  function children() {
    const pooler = resources.get(key("Pooler", "database-pool-rw"));
    if (!pooler) return null;
    const childLabels = {
      "cnpg.io/cluster": "database",
      "cnpg.io/poolerName": "database-pool-rw",
      "cnpg.io/podRole": "pooler",
    };
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        ...metadata("database-pool-rw", ids.deployment),
        labels: childLabels,
        ownerReferences: [
          owner(
            "Pooler",
            "database-pool-rw",
            ids.pooler,
            "postgresql.cnpg.io/v1",
          ),
        ],
      },
      spec: {
        replicas: 1,
        template: {
          spec: { containers: [{ name: "pgbouncer", image: pooling.image }] },
        },
      },
      status: {
        observedGeneration: 1,
        replicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
      },
    };
    const rs = {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: {
        ...metadata("database-pool-rw-rs", "replica-set-uid"),
        labels: childLabels,
        ownerReferences: [
          owner("Deployment", "database-pool-rw", ids.deployment, "apps/v1"),
        ],
      },
    };
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        ...metadata("database-pool-rw-pod", "pooler-pod-uid"),
        labels: childLabels,
        ownerReferences: [
          owner(
            "ReplicaSet",
            "database-pool-rw-rs",
            "replica-set-uid",
            "apps/v1",
          ),
        ],
      },
      spec: {
        nodeName: "node-a",
        containers: [{ name: "pgbouncer", image: pooling.image }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      },
    };
    return { deployment, rs, pod };
  }
  const api = {
    async read(kind, ns, name) {
      const child = children();
      if (kind === "Deployment")
        return child ? structuredClone(child.deployment) : null;
      if (kind === "ReplicaSet")
        return child ? structuredClone(child.rs) : null;
      return structuredClone(resources.get(key(kind, name)) ?? null);
    },
    async create(desired) {
      const uid =
        {
          Namespace: ids.namespace,
          ResourceQuota: ids.quota,
          Cluster: ids.cluster,
          Pooler: ids.pooler,
          ConfigMap: ids.cohort,
        }[desired.kind] ?? `${desired.kind}-uid`;
      const resource = {
        ...structuredClone(desired),
        metadata: {
          ...structuredClone(desired.metadata),
          uid,
          generation: 1,
          resourceVersion: "1",
        },
      };
      if (desired.kind === "Cluster")
        resource.status = {
          readyInstances: 1,
          currentPrimary: "database-1",
          conditions: [
            { type: "Ready", status: "True", observedGeneration: 1 },
          ],
        };
      if (desired.kind === "Pooler")
        resource.status = { phase: "active", image: pooling.image };
      creations.push(structuredClone(resource));
      resources.set(key(desired.kind, desired.metadata.name), resource);
      if (desired.kind === "ConfigMap" && lostCohortReply) {
        lostCohortReply = false;
        throw new Error("lost_committed_cohort_reply");
      }
      return structuredClone(resource);
    },
    async readSecret() {
      return { id: "aWQ=", key: "a2V5" };
    },
    async listNodes() {
      return structuredClone(nodes);
    },
    async executionPreflight() {
      return {
        pods: [],
        clusters: [...resources.values()].filter((r) => r.kind === "Cluster"),
        poolers: [...resources.values()].filter((r) => r.kind === "Pooler"),
      };
    },
    async listPods() {
      if (!resources.has(key("Cluster", "database"))) return [];
      const postgres = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          ...metadata("database-1", "postgres-pod-uid"),
          labels: {
            "cnpg.io/cluster": "database",
            "cnpg.io/podRole": "instance",
          },
          ownerReferences: [
            owner("Cluster", "database", ids.cluster, "postgresql.cnpg.io/v1"),
          ],
        },
        spec: { nodeName: "node-a" },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      };
      const child = children();
      return structuredClone(child ? [postgres, child.pod] : [postgres]);
    },
  };
  return { api, resources, creations, nodes, key };
}

test("creates and reuses an immutable pre-execution cohort before compute, confines both CNPG paths and refuses changed node birth or missing history", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-cohort-birth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const operator = {
    ...config,
    nodeTrackingJournalPath: join(directory, "birth.sqlite"),
  };
  const f = provisioning();
  const result = await reconcileEnvironment(f.api, claim, operator);
  assert.equal(result.ready, true);
  const cm = f.resources.get(f.key("ConfigMap", "execution-nodes"));
  assert.ok(
    cm,
    "tracked compute requires the original cohort before it can start",
  );
  assert.equal(cm.immutable, true);
  assert.deepEqual(cm.data, { "cohort.json": canonical(cohortData) });
  assert.deepEqual(cm.metadata.ownerReferences, [
    owner("Namespace", namespace, ids.namespace, "v1"),
  ]);
  const pointer = { uid: ids.cohort, hash: hash(cm.data["cohort.json"]) };
  assert.deepEqual(result.observation.nodeCohort, pointer);
  const createdKinds = f.creations.map((r) => r.kind);
  assert.ok(
    createdKinds.indexOf("ConfigMap") < createdKinds.indexOf("Cluster"),
  );
  assert.ok(createdKinds.indexOf("ConfigMap") < createdKinds.indexOf("Pooler"));
  const cluster = f.resources.get(f.key("Cluster", "database")),
    pooler = f.resources.get(f.key("Pooler", "database-pool-rw"));
  assert.deepEqual(cluster.spec.affinity.nodeAffinity, affinity);
  assert.deepEqual(pooler.spec.template.spec.affinity.nodeAffinity, affinity);
  assert.equal(
    cluster.metadata.annotations["pgcf.io/node-cohort-uid"],
    pointer.uid,
  );
  assert.equal(
    pooler.metadata.annotations["pgcf.io/node-cohort-hash"],
    pointer.hash,
  );
  const replay = await reconcileEnvironment(f.api, claim, operator);
  assert.deepEqual(replay.observation.nodeCohort, pointer);
  assert.equal(
    f.creations.filter((r) => r.kind === "ConfigMap").length,
    1,
    "lost create reply must not recreate the cohort",
  );
  // Both are observed unsafe boundaries: erased API history and missing actual placement.
  f.resources.delete(f.key("ConfigMap", "execution-nodes"));
  f.resources.delete(f.key("Cluster", "database"));
  f.resources.delete(f.key("Pooler", "database-pool-rw"));
  let deletedHistoryError, missingPlacementError, deletedNamespaceError;
  try {
    await reconcileEnvironment(f.api, claim, operator);
  } catch (error) {
    deletedHistoryError = error;
  }
  const originalNamespace = f.resources.get(f.key("Namespace", namespace));
  f.resources.delete(f.key("Namespace", namespace));
  try {
    await reconcileEnvironment(f.api, claim, operator);
  } catch (error) {
    deletedNamespaceError = error;
  }
  assert.equal(
    f.resources.has(f.key("Namespace", namespace)),
    false,
    "a bound Namespace cannot be replaced before its missing UID is refused",
  );
  assert.ok(deletedNamespaceError);
  f.resources.set(f.key("Namespace", namespace), originalNamespace);
  f.resources.set(f.key("ConfigMap", "execution-nodes"), cm);
  f.resources.set(f.key("Cluster", "database"), cluster);
  f.resources.set(f.key("Pooler", "database-pool-rw"), pooler);
  const originalPods = f.api.listPods;
  f.api.listPods = async () => {
    const pods = await originalPods();
    delete pods[0].spec.nodeName;
    delete pods[1].spec.nodeName;
    return pods;
  };
  try {
    await reconcileEnvironment(f.api, claim, operator);
  } catch (error) {
    missingPlacementError = error;
  }
  f.api.listPods = originalPods;
  assert.deepEqual(
    {
      deletedHistoryRejected: !!deletedHistoryError,
      missingPlacementRejected: !!missingPlacementError,
    },
    { deletedHistoryRejected: true, missingPlacementRejected: true },
    "neither erased API history nor unbound Running/Ready compute may be accepted",
  );
  assert.match(
    f.resources.get(f.key("Namespace", namespace)).metadata.annotations[
      "pgcf.io/execution-birth-id"
    ],
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
  );
  f.nodes[0].status.nodeInfo.bootID = ids.replacement;
  await assert.rejects(
    reconcileEnvironment(f.api, claim, operator),
    /node_cohort_birth_changed/,
  );
  f.nodes[0].status.nodeInfo.bootID = initialNodes[0].status.nodeInfo.bootID;
  f.resources.delete(f.key("ConfigMap", "execution-nodes"));
  await assert.rejects(
    reconcileEnvironment(f.api, claim, operator),
    /node_cohort_history_unproven/,
  );
  assert.equal(
    f.creations.filter((r) => r.kind === "ConfigMap").length,
    1,
    "existing compute cannot acquire invented cohort history",
  );
});

test("seals the claimed cohort and full original nodes across stop restart and refuses replacement provenance while retaining volumes and pending physical verification", async (t) => {
  const pointer = { uid: ids.cohort, hash: hash(canonical(cohortData)) };
  const suspendClaim = {
    schemaVersion: 1,
    kind: "environment.suspend",
    operationId: ids.replacement,
    organizationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    projectId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    environmentId: ids.environment,
    regionId: ids.region,
    specRevision: 1,
    specHash,
    runtimeRevision: 1,
    clusterUid: ids.cluster,
    pooler: null,
    runEpoch: "1",
    nodeCohort: pointer,
    leaseToken: `cplease_${"l".repeat(43)}`,
    leaseEpoch: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const inventory = {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { ...metadata(namespace, ids.namespace), namespace: undefined },
    },
    cluster: {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: {
        ...metadata("database", ids.cluster),
        annotations: {
          ...annotations,
          "pgcf.io/node-cohort-uid": pointer.uid,
          "pgcf.io/node-cohort-hash": pointer.hash,
        },
      },
      spec: { instances: 1, affinity: { nodeAffinity: affinity } },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", ids.quota),
      spec: { hard: { pods: "2" } },
    },
    nodeCohort: {
      apiVersion: "v1",
      kind: "ConfigMap",
      immutable: true,
      metadata: {
        ...metadata("execution-nodes", ids.cohort),
        ownerReferences: [owner("Namespace", namespace, ids.namespace, "v1")],
      },
      data: { "cohort.json": canonical(cohortData) },
    },
    nodes: structuredClone(initialNodes),
    poolers: [],
    deployments: [],
    pods: [],
    pvcs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: "database-1", namespace, uid: "pvc-uid" },
        spec: { volumeName: "data", storageClassName: "local" },
        status: { phase: "Bound" },
      },
    ],
    pvs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: { name: "data", uid: "pv-uid" },
        spec: {
          storageClassName: "local",
          capacity: { storage: "4Gi" },
          persistentVolumeReclaimPolicy: "Retain",
          claimRef: { name: "database-1", namespace, uid: "pvc-uid" },
        },
        status: { phase: "Bound" },
      },
    ],
  };
  const directory = mkdtempSync(join(tmpdir(), "pgcf-node-cohort-")),
    path = join(directory, "suspend.sqlite");
  let journal = new SuspendJournal(path, suspendClaim);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const patches = [],
    volumes = structuredClone({ pvcs: inventory.pvcs, pvs: inventory.pvs });
  const runtime = {
    inventory: async () => structuredClone(inventory),
    patch: async (kind, name, ops) => {
      assert.deepEqual(
        journal.seal.binding.nodeCohort,
        pointer,
        "seal cohort before effects",
      );
      patches.push({ kind, name, ops });
      if (kind === "ResourceQuota") inventory.quota.spec.hard.pods = "0";
      else inventory.cluster.metadata.annotations["cnpg.io/hibernation"] = "on";
      throw new Error("lost_committed_stop_reply");
    },
  };
  const first = await reconcileSuspend(journal, runtime, () => {});
  assert.deepEqual(
    journal.seal.binding.nodeCohort,
    pointer,
    "claim pointer must survive durable stop sealing",
  );
  assert.deepEqual(journal.seal.nodeCohort, cohortData);
  assert.equal(first.suspended, false);
  assert.equal(first.reason, "physical_verification_pending");
  assert.equal(patches.length, 2);
  const seal = structuredClone(journal.seal);
  journal.close();
  journal = new SuspendJournal(path, { ...suspendClaim, leaseEpoch: 2 });
  assert.equal(
    (await reconcileSuspend(journal, runtime, () => {})).reason,
    "physical_verification_pending",
  );
  assert.deepEqual(journal.seal, seal);
  assert.equal(patches.length, 2);
  inventory.nodeCohort.metadata.uid = ids.replacement;
  assert.equal(
    (await reconcileSuspend(journal, runtime, () => {})).suspended,
    false,
  );
  assert.equal(patches.length, 2);
  assert.deepEqual(journal.seal, seal);
  inventory.nodeCohort.metadata.uid = ids.cohort;
  inventory.nodes[0].metadata.uid = ids.replacement;
  assert.equal(
    (await reconcileSuspend(journal, runtime, () => {})).suspended,
    false,
  );
  assert.equal(patches.length, 2);
  assert.deepEqual(journal.seal, seal);
  assert.deepEqual({ pvcs: inventory.pvcs, pvs: inventory.pvs }, volumes);
  assert.throws(
    () =>
      new SuspendJournal(path, {
        ...suspendClaim,
        nodeCohort: { ...pointer, uid: ids.replacement },
      }),
    /identity_mismatch/,
  );
});
