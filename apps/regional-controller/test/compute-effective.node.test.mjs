// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";

test("proves target compute only after the old Pod is gone and replacement resources are effective", async () => {
  const { observeEffectiveCompute } =
    await import("../src/compute-effective.ts");
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const regionId = "22222222-2222-4222-8222-222222222222";
  const namespaceUid = "33333333-3333-4333-8333-333333333333";
  const clusterUid = "44444444-4444-4444-8444-444444444444";
  const oldPodUid = "55555555-5555-4555-8555-555555555555";
  const newPodUid = "66666666-6666-4666-8666-666666666666";
  const initdbPodUid = "77777777-7777-4777-8777-777777777777";
  const initdbJobUid = "88888888-8888-4888-8888-888888888888";
  const namespaceName = `pgcf-${environmentId.replaceAll("-", "")}`;
  const baseSpecHash = "a".repeat(64);
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": environmentId,
    "pgcf.io/region-id": regionId,
  };
  const annotations = {
    "pgcf.io/spec-hash": baseSpecHash,
    "pgcf.io/run-epoch": "2",
  };
  const namespace = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      uid: namespaceUid,
      resourceVersion: "10",
      labels,
      annotations,
    },
  };
  const targetResources = {
    requests: { cpu: "1", memory: "1Gi" },
    limits: { cpu: "1", memory: "1Gi" },
  };
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace: namespaceName,
      uid: clusterUid,
      generation: 2,
      resourceVersion: "20",
      labels,
      annotations,
    },
    spec: { instances: 1, resources: targetResources },
    status: {
      readyInstances: 1,
      currentPrimary: "database-1",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const pod = (uid, resources) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "database-1",
      namespace: namespaceName,
      uid,
      resourceVersion: uid === oldPodUid ? "30" : "31",
      labels: {
        "cnpg.io/cluster": "database",
        "cnpg.io/podRole": "instance",
        "cnpg.io/instanceRole": "primary",
      },
      ownerReferences: [
        {
          kind: "Cluster",
          name: "database",
          uid: clusterUid,
          apiVersion: "postgresql.cnpg.io/v1",
          controller: true,
        },
      ],
    },
    spec: { containers: [{ name: "postgres", resources }] },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "postgres", ready: true, resources }],
    },
  });
  const oldPod = pod(oldPodUid, {
    requests: { cpu: "500m", memory: "512Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  });
  const newPod = pod(newPodUid, targetResources);
  const completedInitdb = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "database-1-initdb-abc12",
      namespace: namespaceName,
      uid: initdbPodUid,
      resourceVersion: "32",
      labels: {
        "cnpg.io/cluster": "database",
        "cnpg.io/instanceName": "database-1",
        "cnpg.io/jobRole": "initdb",
        "batch.kubernetes.io/job-name": "database-1-initdb",
        "batch.kubernetes.io/controller-uid": initdbJobUid,
      },
      ownerReferences: [
        {
          kind: "Job",
          name: "database-1-initdb",
          uid: initdbJobUid,
          apiVersion: "batch/v1",
          controller: true,
        },
      ],
    },
    status: { phase: "Succeeded" },
  };
  let pods = [oldPod];
  let clusterReads = 0;
  let disappearAfterFirstList = false;
  const api = {
    async read(kind, requestedNamespace, name) {
      if (kind === "Namespace") {
        assert.equal(name, namespaceName);
        return namespace;
      }
      assert.equal(kind, "Cluster");
      assert.equal(requestedNamespace, namespaceName);
      assert.equal(name, "database");
      clusterReads += 1;
      if (disappearAfterFirstList && clusterReads === 2) pods = [];
      return cluster;
    },
    async listPods(requestedNamespace, name) {
      assert.equal(requestedNamespace, namespaceName);
      assert.equal(name, "database");
      return pods;
    },
  };
  const binding = {
    environmentId,
    regionId,
    namespaceUid,
    clusterUid,
    baseSpecHash,
    runEpoch: "2",
    target: { cpuMilli: 1000, memoryMiB: 1024 },
    instances: 1,
    oldPodUids: [oldPodUid],
  };

  assert.equal(await observeEffectiveCompute(api, binding), null);
  pods = [newPod, completedInitdb];
  clusterReads = 0;
  disappearAfterFirstList = true;
  assert.equal(await observeEffectiveCompute(api, binding), null);
  pods = [newPod, completedInitdb];
  clusterReads = 0;
  disappearAfterFirstList = false;
  assert.deepEqual(await observeEffectiveCompute(api, binding), {
    namespaceUid,
    clusterUid,
    clusterGeneration: 2,
    runEpoch: "2",
    cpuMilli: 1000,
    memoryMiB: 1024,
    primaryPodUid: newPodUid,
    podUids: [newPodUid],
  });
});
