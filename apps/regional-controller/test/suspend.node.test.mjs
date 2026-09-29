// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowanceKubernetesFromConfig } from "../src/allowance-kubernetes.ts";

const environmentId = "11111111-1111-4111-8111-111111111111",
  regionId = "22222222-2222-4222-8222-222222222222";
const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
const ids = {
  namespace: "33333333-3333-4333-8333-333333333333",
  cluster: "44444444-4444-4444-8444-444444444444",
  quota: "55555555-5555-4555-8555-555555555555",
  pooler: "66666666-6666-4666-8666-666666666666",
  deployment: "77777777-7777-4777-8777-777777777777",
};
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/environment-id": environmentId,
  "pgcf.io/region-id": regionId,
};
const annotations = { "pgcf.io/spec-hash": "a".repeat(64) };
const metadata = (name, uid) => ({
  name,
  namespace,
  uid,
  resourceVersion: "10",
  generation: 1,
  labels: { ...labels },
  annotations: { ...annotations },
});
const owner = (kind, name, uid, apiVersion) => ({
  kind,
  name,
  uid,
  apiVersion,
  controller: true,
});
function fixture(pooled = false) {
  const claim = {
    schemaVersion: 1,
    kind: "environment.suspend",
    operationId: "88888888-8888-4888-8888-888888888888",
    environmentId,
    organizationId: "99999999-9999-4999-8999-999999999999",
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    regionId,
    specRevision: 1,
    specHash: "a".repeat(64),
    runtimeRevision: 1,
    clusterUid: ids.cluster,
    pooler: pooled ? { uid: ids.pooler, deploymentUid: ids.deployment } : null,
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
      metadata: metadata("database", ids.cluster),
      spec: { instances: 1 },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", ids.quota),
      spec: {
        hard: {
          pods: pooled ? "3" : "2",
          "requests.cpu": "1100m",
          "requests.memory": "1216Mi",
        },
      },
    },
    poolers: [],
    deployments: [],
    pods: [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "database-1",
          namespace,
          uid: "postgres-pod",
          ownerReferences: [
            owner("Cluster", "database", ids.cluster, "postgresql.cnpg.io/v1"),
          ],
        },
        status: { phase: "Running" },
      },
    ],
    pvcs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: {
          name: "database-1",
          namespace,
          uid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
        spec: { volumeName: "volume-1", storageClassName: "local" },
        status: { phase: "Bound" },
      },
    ],
    pvs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: {
          name: "volume-1",
          uid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        },
        spec: {
          storageClassName: "local",
          capacity: { storage: "4Gi" },
          persistentVolumeReclaimPolicy: "Retain",
          claimRef: {
            name: "database-1",
            namespace,
            uid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          },
        },
        status: { phase: "Bound" },
      },
    ],
  };
  if (pooled) {
    inventory.poolers.push({
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Pooler",
      metadata: {
        ...metadata("database-pool-rw", ids.pooler),
        ownerReferences: [
          owner("Cluster", "database", ids.cluster, "postgresql.cnpg.io/v1"),
        ],
      },
      spec: { cluster: { name: "database" }, instances: 1 },
    });
    inventory.deployments.push({
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
      spec: { replicas: 1 },
      status: {
        observedGeneration: 1,
        replicas: 1,
        readyReplicas: 1,
        availableReplicas: 1,
        updatedReplicas: 1,
      },
    });
  }
  const patches = [];
  const runtime = {
    inventory: async () => structuredClone(inventory),
    patch: async (kind, name, operations) => {
      const resource =
        kind === "Cluster"
          ? inventory.cluster
          : kind === "Pooler"
            ? inventory.poolers[0]
            : inventory.quota;
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
      if (kind === "ResourceQuota") inventory.quota.spec.hard.pods = "0";
      else if (kind === "Pooler") inventory.poolers[0].spec.instances = 0;
      else inventory.cluster.metadata.annotations["cnpg.io/hibernation"] = "on";
      throw new Error("lost_committed_patch_reply");
    },
  };
  return { claim, inventory, runtime, patches };
}

function stored(path, name) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT payload_json FROM suspend_state WHERE name=?")
      .get(name)?.payload_json;
  } finally {
    db.close();
  }
}
function legacyEntry(path, name, value) {
  const payload = JSON.stringify(value);
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "INSERT INTO suspend_state VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
    ).run(name, payload, createHash("sha256").update(payload).digest("hex"));
  } finally {
    db.close();
  }
  return payload;
}

test("seals stop identities before uncertain effects and defers physical completion after restart without trusting saved API-only success", async (t) => {
  const api = await import("../src/suspend-reconcile.ts").catch(() => null);
  assert.equal(
    typeof api?.SuspendJournal,
    "function",
    "missing owned suspend executor implementation",
  );
  const { SuspendJournal, reconcileSuspend } = api;
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "pgcf-suspend-")),
    path = join(directory, "operation.sqlite");
  let journal = new SuspendJournal(path, f.claim);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const volumes = structuredClone({
    pvcs: f.inventory.pvcs,
    pvs: f.inventory.pvs,
  });
  const first = await reconcileSuspend(journal, f.runtime, () => {});
  assert.equal(first.suspended, false);
  assert.equal(f.patches.length, 2);
  assert.equal(f.inventory.quota.spec.hard.pods, "0");
  assert.equal(
    f.inventory.cluster.metadata.annotations["cnpg.io/hibernation"],
    "on",
  );
  const seal = structuredClone(journal.seal);
  journal.close();
  // These are exact predecessor records, not new proof of physical termination.
  const legacyStage = legacyEntry(path, "stage", "suspended");
  const legacyObservation = legacyEntry(path, "observation", {
    namespaceUid: ids.namespace,
    clusterUid: ids.cluster,
    quotaUid: ids.quota,
    volumesHash: seal.volumesHash,
    pooler: null,
    computeAbsent: true,
    quotaPodsZero: true,
    clusterHibernated: true,
    poolerStopped: true,
  });
  journal = new SuspendJournal(path, { ...f.claim, leaseEpoch: 2 });
  // API disappearance can follow force deletion while node processes survive.
  f.inventory.pods = [];
  const recovered = await reconcileSuspend(journal, f.runtime, () => {});
  assert.equal(
    recovered.suspended,
    false,
    "API-only convergence and historical success cannot establish physical completion",
  );
  assert.equal(recovered.reason, "physical_verification_pending");
  assert.equal(recovered.observation, undefined);
  assert.deepEqual(journal.seal, seal);
  assert.equal(stored(path, "stage"), legacyStage);
  assert.equal(stored(path, "observation"), legacyObservation);
  assert.equal(f.patches.length, 2);
  assert.deepEqual({ pvcs: f.inventory.pvcs, pvs: f.inventory.pvs }, volumes);
});

test("refuses replacement identities or lost authority and keeps converged Pooler compute pending without a physical verifier", async (t) => {
  const api = await import("../src/suspend-reconcile.ts").catch(() => null);
  assert.equal(
    typeof api?.SuspendJournal,
    "function",
    "missing owned suspend executor implementation",
  );
  const { SuspendJournal, reconcileSuspend } = api;
  const f = fixture(true);
  const directory = mkdtempSync(join(tmpdir(), "pgcf-suspend-pooler-")),
    path = join(directory, "operation.sqlite");
  const journal = new SuspendJournal(path, f.claim);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let authority = true;
  const authorized = () => {
    if (!authority) throw new Error("lease_lost");
  };
  const original = f.runtime.inventory;
  f.runtime.inventory = async () => {
    const value = await original();
    authority = false;
    return value;
  };
  assert.equal(
    (await reconcileSuspend(journal, f.runtime, authorized)).suspended,
    false,
  );
  assert.equal(f.patches.length, 0);
  f.runtime.inventory = original;
  authority = true;
  assert.equal(
    (await reconcileSuspend(journal, f.runtime, authorized)).suspended,
    false,
  );
  assert.equal(f.inventory.poolers[0].spec.instances, 0);
  assert.equal(f.patches.length, 3);
  f.inventory.deployments[0].spec.replicas = 0;
  f.inventory.deployments[0].status = {
    observedGeneration: 1,
    replicas: 0,
    readyReplicas: 0,
    availableReplicas: 0,
    updatedReplicas: 0,
  };
  f.inventory.pods = [
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "unknown", namespace, uid: "unknown-pod" },
      status: { phase: "Running" },
    },
  ];
  assert.equal(
    (await reconcileSuspend(journal, f.runtime, authorized)).suspended,
    false,
  );
  f.inventory.pods = [];
  f.inventory.quota.metadata.uid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert.equal(
    (await reconcileSuspend(journal, f.runtime, authorized)).suspended,
    false,
  );
  assert.equal(f.patches.length, 3);
  f.inventory.quota.metadata.uid = ids.quota;
  const converged = await reconcileSuspend(journal, f.runtime, authorized);
  assert.equal(
    converged.suspended,
    false,
    "zero API replicas do not prove physical termination",
  );
  assert.equal(converged.reason, "physical_verification_pending");
  assert.equal(converged.observation, undefined);
  assert.equal(stored(path, "stage"), JSON.stringify("stopping"));
  assert.equal(stored(path, "observation"), undefined);
  let adapterAuthority = true;
  let patchRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      adapterAuthority = false;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(f.inventory.poolers[0]));
    } else {
      patchRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(f.inventory.poolers[0]));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const kubeconfig = join(directory, "kubeconfig.json");
    writeFileSync(
      kubeconfig,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        // Loopback-only HTTP fixture; production kubeconfig/TLS is unchanged.
        clusters: [
          {
            name: "test",
            cluster: {
              server: `http://127.0.0.1:${server.address().port}`,
              "insecure-skip-tls-verify": true,
            },
          },
        ],
        contexts: [
          { name: "test", context: { cluster: "test", user: "test" } },
        ],
        "current-context": "test",
        users: [{ name: "test", user: { token: "fixture-only" } }],
      }),
    );
    const seal = journal.seal.binding;
    const adapter = allowanceKubernetesFromConfig(
      kubeconfig,
      "test",
      seal,
      () => {
        if (!adapterAuthority) throw new Error("lease_lost_after_read");
      },
    );
    await assert.rejects(
      adapter.patch("Pooler", "database-pool-rw", [
        { op: "test", path: "/metadata/uid", value: ids.pooler },
        { op: "test", path: "/metadata/resourceVersion", value: "10" },
        { op: "replace", path: "/spec/instances", value: 0 },
      ]),
      /lease_lost_after_read/,
    );
    assert.equal(
      patchRequests,
      0,
      "lease loss during ownership read must prevent the later network mutation",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
