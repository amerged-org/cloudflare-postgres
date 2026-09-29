// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileEnvironment } from "../src/reconcile.ts";
import { observeUsage } from "../src/usage-observer.ts";
import { AllowanceJournal } from "../src/allowance-journal.ts";
import { reconcileAllowance } from "../src/allowance-supervisor.ts";

const environmentId = "11111111-1111-4111-8111-111111111111";
const regionId = "22222222-2222-4222-8222-222222222222";
const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
const pooling = {
  version: 1,
  image: `ghcr.io/cloudnative-pg/pgbouncer@sha256:${"b".repeat(64)}`,
  mode: "session",
  compute: {
    requests: { cpuMilli: 50, memoryMiB: 64 },
    limits: { cpuMilli: 200, memoryMiB: 256 },
  },
  connections: {
    maxClients: 50,
    poolSize: 5,
    maxDatabaseConnections: 10,
    maxUserConnections: 10,
  },
  timeouts: { queryWaitSeconds: 15, connectSeconds: 10, cancelWaitSeconds: 10 },
};
const spec = {
  name: "pooled",
  regionId,
  catalogVersion: "pooled-v1",
  profileId: "small",
  volumeGiB: 5,
  profile: {
    id: "small",
    postgresImage: `example.invalid/postgres@sha256:${"a".repeat(64)}`,
    compute: { cpuMilli: 500, memoryMiB: 512 },
    storage: {
      classId: "local",
      storageClassName: "test-local",
      minGiB: 5,
      maxGiB: 50,
      stepGiB: 5,
    },
    instances: 1,
    backup: {
      endpointURL: "https://archive.example.invalid",
      region: "auto",
      destinationPath: "s3://fixture-backups",
      retentionPolicy: "7d",
      credentialSecret: {
        namespace: "platform",
        name: "backups",
        accessKeyIdKey: "access",
        secretAccessKeyKey: "secret",
      },
    },
    pooling,
  },
};
const specHash = createHash("sha256")
  .update(JSON.stringify(spec))
  .digest("hex");
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/environment-id": environmentId,
  "pgcf.io/region-id": regionId,
};
const annotations = { "pgcf.io/spec-hash": specHash };
const ids = {
  namespace: "33333333-3333-4333-8333-333333333333",
  cluster: "44444444-4444-4444-8444-444444444444",
  pooler: "55555555-5555-4555-8555-555555555555",
  deployment: "66666666-6666-4666-8666-666666666666",
  quota: "77777777-7777-4777-8777-777777777777",
};
const owner = (kind, name, uid, apiVersion = "apps/v1") => ({
  kind,
  name,
  uid,
  apiVersion,
  controller: true,
});
const metadata = (name, uid) => ({
  name,
  namespace,
  uid,
  resourceVersion: "10",
  generation: 1,
  labels: { ...labels },
  annotations: { ...annotations },
});
function ownedCompute() {
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: metadata("database", ids.cluster),
    spec: { instances: 1 },
    status: { currentPrimary: "database-1" },
  };
  const pooler = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Pooler",
    metadata: {
      ...metadata("database-pool-rw", ids.pooler),
      ownerReferences: [
        owner("Cluster", "database", ids.cluster, "postgresql.cnpg.io/v1"),
      ],
    },
    spec: {
      cluster: { name: "database" },
      instances: 1,
      pgbouncer: { image: pooling.image, poolMode: "session" },
    },
  };
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      ...metadata("database-pool-rw", ids.deployment),
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
  const replicaSet = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      ...metadata("database-pool-rw-hash", "replicaset-uid"),
      ownerReferences: [
        owner("Deployment", "database-pool-rw", ids.deployment),
      ],
    },
    spec: { replicas: 1 },
  };
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...metadata("database-pool-rw-hash-pod", "pooler-pod-uid"),
      labels: {
        "cnpg.io/cluster": "database",
        "cnpg.io/podRole": "pooler",
        "cnpg.io/poolerName": "database-pool-rw",
      },
      ownerReferences: [
        owner("ReplicaSet", replicaSet.metadata.name, replicaSet.metadata.uid),
      ],
    },
    spec: {
      nodeName: "node-1",
      containers: [
        {
          name: "pgbouncer",
          image: pooling.image,
          resources: { requests: { cpu: "50m", memory: "64Mi" } },
        },
      ],
      initContainers: [
        {
          name: "bootstrap-controller",
          resources: { requests: { cpu: "50m", memory: "64Mi" } },
        },
      ],
    },
    status: {
      phase: "Running",
      initContainerStatuses: [
        {
          name: "bootstrap-controller",
          state: { terminated: { exitCode: 0 } },
        },
      ],
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  return { cluster, pooler, deployment, replicaSet, pod };
}

test("reclaims the same owned Pooler with complete readiness, derived TLS names and a quota that reserves database maintenance separately", async () => {
  const compute = ownedCompute();
  const resources = new Map();
  const counts = new Map();
  const key = (kind, ns, name) => `${kind}:${ns}:${name}`;
  const api = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(key(kind, ns, name)) ?? null);
    },
    async create(resource) {
      const stored = structuredClone(resource);
      stored.metadata.uid =
        ids[resource.kind.toLowerCase()] ?? `uid-${resource.kind}`;
      stored.metadata.resourceVersion = "10";
      stored.metadata.generation = 1;
      if (stored.kind === "Cluster")
        stored.status = {
          readyInstances: 1,
          currentPrimary: "database-1",
          conditions: [
            { type: "Ready", status: "True", observedGeneration: 1 },
          ],
        };
      if (stored.kind === "Pooler") {
        stored.status = { phase: "active", image: pooling.image };
        resources.set(
          key("Deployment", namespace, "database-pool-rw"),
          compute.deployment,
        );
        resources.set(
          key("ReplicaSet", namespace, compute.replicaSet.metadata.name),
          compute.replicaSet,
        );
      }
      resources.set(
        key(stored.kind, stored.metadata.namespace ?? "", stored.metadata.name),
        stored,
      );
      counts.set(stored.kind, (counts.get(stored.kind) ?? 0) + 1);
      if (stored.kind === "Pooler") throw new Error("reply_lost_after_commit");
      return structuredClone(stored);
    },
    async readSecret() {
      return { access: "ZmFrZQ==", secret: "ZmFrZQ==" };
    },
    async listPods() {
      return [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: "database-1",
            namespace,
            uid: "primary-pod",
            labels: {
              "cnpg.io/cluster": "database",
              "cnpg.io/podRole": "instance",
            },
            ownerReferences: [
              owner(
                "Cluster",
                "database",
                ids.cluster,
                "postgresql.cnpg.io/v1",
              ),
            ],
          },
          status: {
            phase: "Running",
            conditions: [{ type: "Ready", status: "True" }],
          },
        },
        compute.pod,
      ];
    },
  };
  const claim = {
    operationId: "88888888-8888-4888-8888-888888888888",
    environmentId,
    regionId,
    kind: "environment.create",
    specRevision: 1,
    specHash,
    spec,
  };
  const config = {
    operatorNamespace: "cnpg-system",
    operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
    allowedBackupSecrets: [spec.profile.backup.credentialSecret],
  };
  const first = await reconcileEnvironment(api, claim, config);
  assert.deepEqual(first.observation?.pooler, {
    uid: ids.pooler,
    generation: 1,
    deploymentUid: ids.deployment,
    readyInstances: 1,
  });
  const quota = resources.get(
    key("ResourceQuota", namespace, "database-resources"),
  ).spec.hard;
  assert.equal(quota.pods, "3");
  assert.equal(quota["requests.cpu"], "1100m");
  assert.equal(quota["limits.cpu"], "1400m");
  assert.equal(quota["requests.memory"], "1216Mi");
  assert.equal(quota["limits.memory"], "1536Mi");
  assert.equal(quota.persistentvolumeclaims, "2");
  const cluster = resources.get(key("Cluster", namespace, "database"));
  assert.deepEqual(cluster.spec.certificates.serverAltDNSNames, [
    "database-pool-rw",
    `database-pool-rw.${namespace}`,
    `database-pool-rw.${namespace}.svc`,
  ]);
  const pooler = resources.get(key("Pooler", namespace, "database-pool-rw"));
  assert.equal(
    pooler.spec.pgbouncer.parameters.server_tls_sslmode,
    "verify-full",
  );
  assert.equal(pooler.spec.pgbouncer.parameters.client_tls_sslmode, "require");
  assert.equal(pooler.spec.deploymentStrategy.type, "Recreate");
  assert.equal(pooler.metadata.ownerReferences[0].uid, ids.cluster);
  await reconcileEnvironment(api, claim, config);
  assert.equal(counts.get("Pooler"), 1);
  compute.deployment.status.observedGeneration = 0;
  assert.equal((await reconcileEnvironment(api, claim, config)).ready, false);
  compute.deployment.status.observedGeneration = 1;
  const replicaSetUid = compute.replicaSet.metadata.uid;
  delete compute.replicaSet.metadata.uid;
  delete compute.pod.metadata.ownerReferences[0].uid;
  assert.equal(
    (await reconcileEnvironment(api, claim, config)).ready,
    false,
    "an incomplete ReplicaSet identity must defer rather than match two missing UIDs",
  );
  compute.replicaSet.metadata.uid = replicaSetUid;
  compute.pod.metadata.ownerReferences[0].uid = replicaSetUid;
  pooler.metadata.ownerReferences[0].uid = "foreign-cluster";
  await assert.rejects(
    reconcileEnvironment(api, claim, config),
    (error) => error.code === "ownership_mismatch",
  );
});

test("attributes Pooler compute through its complete owner chain and persists a fenced stop until Pooler and all namespace compute are gone", async (t) => {
  const compute = ownedCompute();
  const ns = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { ...metadata(namespace, ids.namespace), namespace: undefined },
  };
  const inventory = {
    namespaces: [ns],
    clusters: [compute.cluster],
    poolers: [compute.pooler],
    deployments: [compute.deployment],
    replicaSets: [compute.replicaSet],
    pods: [compute.pod],
    pvcs: [],
    pvs: [],
  };
  const usage = observeUsage(inventory, regionId);
  assert.equal(usage.issues.length, 0);
  assert.equal(usage.allocations.length, 2);
  assert.deepEqual(
    usage.allocations.map((x) => [x.metric, x.attribution, x.rate]).sort(),
    [
      ["cpu_millicore_ms", "platform", "50"],
      ["memory_byte_ms", "platform", "67108864"],
    ],
  );
  const changed = structuredClone(inventory);
  changed.replicaSets[0].metadata.ownerReferences[0].uid = "foreign-deployment";
  const denied = observeUsage(changed, regionId);
  assert.equal(denied.allocations.length, 0);
  assert.ok(denied.issues.some((x) => x.code === "pooler_owner_unproven"));
  const directory = mkdtempSync(join(tmpdir(), "pgcf-pooler-stop-"));
  const binding = {
    regionId,
    environmentId,
    projectId: "99999999-9999-4999-8999-999999999999",
    specRevision: 1,
    specHash,
    namespace,
    namespaceUid: ids.namespace,
    clusterUid: ids.cluster,
    quotaUid: ids.quota,
    pooler: { uid: ids.pooler, deploymentUid: ids.deployment },
  };
  let journal = new AllowanceJournal(
    join(directory, "allowance.sqlite"),
    binding,
  );
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const runtimeInventory = {
    namespace: ns,
    cluster: compute.cluster,
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", ids.quota),
      spec: {
        hard: {
          pods: "3",
          "requests.cpu": "1100m",
          "requests.memory": "1216Mi",
        },
      },
    },
    poolers: [compute.pooler],
    deployments: [compute.deployment],
    pods: [compute.pod],
    pvcs: [],
    pvs: [],
  };
  const patches = [];
  const runtime = {
    inventory: async () => structuredClone(runtimeInventory),
    patch: async (kind, name, operations) => {
      const resource =
        kind === "Pooler"
          ? compute.pooler
          : kind === "Cluster"
            ? compute.cluster
            : runtimeInventory.quota;
      assert.ok(
        operations.some(
          (op) =>
            op.op === "test" &&
            op.path === "/metadata/uid" &&
            op.value === resource.metadata.uid,
        ),
      );
      assert.ok(
        operations.some(
          (op) =>
            op.op === "test" &&
            op.path === "/metadata/resourceVersion" &&
            op.value === resource.metadata.resourceVersion,
        ),
      );
      const edit = operations.find((op) => op.op !== "test");
      patches.push({ kind, name, edit });
      if (kind === "ResourceQuota") runtimeInventory.quota.spec.hard.pods = "0";
      else if (kind === "Cluster")
        compute.cluster.metadata.annotations["cnpg.io/hibernation"] = "on";
      else {
        assert.equal(edit.path, "/spec/instances");
        assert.equal(edit.value, 0);
        compute.pooler.spec.instances = 0;
        throw new Error("lost_pooler_patch_reply");
      }
    },
  };
  const client = {
    authority: async () => {
      throw new Error("offline");
    },
    reserve: async () => {
      throw new Error("unexpected");
    },
  };
  const now = Date.parse("2026-09-29T00:00:00.000Z");
  assert.equal(
    (await reconcileAllowance(journal, client, runtime, now)).state,
    "stopping",
  );
  assert.equal(compute.pooler.spec.instances, 0);
  journal.close();
  journal = new AllowanceJournal(join(directory, "allowance.sqlite"), binding);
  compute.deployment.spec.replicas = 0;
  compute.deployment.status = {
    observedGeneration: 1,
    replicas: 0,
    readyReplicas: 0,
    availableReplicas: 0,
    updatedReplicas: 0,
  };
  runtimeInventory.pods = [
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "unknown-compute", namespace, uid: "unknown-pod" },
      status: { phase: "Running" },
    },
  ];
  assert.equal(
    (await reconcileAllowance(journal, client, runtime, now + 1000)).state,
    "stopping",
  );
  runtimeInventory.pods = [];
  assert.equal(
    (await reconcileAllowance(journal, client, runtime, now + 2000)).state,
    "stopping",
  );
  assert.equal(patches.filter((x) => x.kind === "Pooler").length, 1);
  assert.deepEqual(runtimeInventory.pvcs, []);
});
