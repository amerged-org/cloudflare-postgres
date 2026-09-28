import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reconcileEnvironment } from "../src/reconcile.ts";

// One lifecycle regression: a lost create response and process restart must not
// duplicate a cluster or trust stale health, and may never adopt another owner.
test("reclaims uncertain provisioning, verifies current Pods, and rejects another owner", async () => {
  const environmentId = "11111111-1111-4111-8111-111111111111";
  const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
  const spec = {
    name: "disposable",
    regionId: "22222222-2222-4222-8222-222222222222",
    catalogVersion: "test-v1",
    profileId: "small",
    volumeGiB: 5,
    profile: {
      id: "small",
      postgresImage: `example.invalid/postgres:18@sha256:${"a".repeat(64)}`,
      compute: { cpuMilli: 999900, memoryMiB: 960 },
      storage: {
        classId: "local",
        storageClassName: "pgcf-lvm",
        minGiB: 5,
        maxGiB: 50,
        stepGiB: 5,
      },
      instances: 1,
      backup: {
        endpointURL: "https://archive.example.invalid",
        region: "auto",
        destinationPath: "s3://test-backups/pilot",
        retentionPolicy: "7d",
        credentialSecret: {
          namespace: "platform",
          name: "backups",
          accessKeyIdKey: "access",
          secretAccessKeyKey: "secret",
        },
      },
    },
  };
  const claim = {
    operationId: "33333333-3333-4333-8333-333333333333",
    environmentId,
    regionId: spec.regionId,
    kind: "environment.create",
    leaseToken: "opaque-test-only",
    leaseEpoch: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    specRevision: 1,
    specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    spec,
  };
  const config = {
    operatorNamespace: "cnpg-system",
    operatorPodLabels: { "app.kubernetes.io/name": "cloudnative-pg" },
    allowedBackupSecrets: [spec.profile.backup.credentialSecret],
  };
  const resources = new Map();
  const createCounts = new Map();
  const api = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(`${kind}:${ns}:${name}`) ?? null);
    },
    async create(resource) {
      const key = `${resource.kind}:${resource.metadata.namespace ?? ""}:${resource.metadata.name}`;
      assert.equal(resources.has(key), false);
      createCounts.set(
        resource.kind,
        (createCounts.get(resource.kind) ?? 0) + 1,
      );
      const stored = structuredClone(resource);
      stored.metadata.uid = `uid-${resource.kind}`;
      stored.metadata.generation = 1;
      // Actual API readback adds Namespace finalizers and canonical quantities.
      if (resource.kind === "Namespace")
        stored.spec = { finalizers: ["kubernetes"] };
      if (resource.kind === "ResourceQuota") {
        const hard = stored.spec.hard;
        if (/^\d+(m)?$/.test(hard["limits.cpu"])) {
          const cpu =
            Number.parseInt(hard["limits.cpu"]) /
            (hard["limits.cpu"].endsWith("m") ? 1000 : 1);
          hard["limits.cpu"] =
            cpu % 1000 === 0 ? `${cpu / 1000}k` : String(cpu);
        }
        if (hard["requests.memory"].endsWith("Mi"))
          hard["requests.memory"] =
            `${Number.parseInt(hard["requests.memory"]) / 1024}Gi`;
      }
      if (resource.kind === "Cluster") {
        stored.status = {
          readyInstances: 1,
          currentPrimary: "database-1",
          conditions: [
            { type: "Ready", status: "True", observedGeneration: 1 },
          ],
        };
      }
      resources.set(key, stored);
      if (resource.kind === "Cluster")
        throw new Error("connection lost after persistence");
      return structuredClone(stored);
    },
    async readSecret(ns, name) {
      assert.equal(ns, "platform");
      assert.equal(name, "backups");
      return {
        access: "ZmFrZS1hY2Nlc3M=",
        secret: "ZmFrZS1zZWNyZXQ=",
        other: "must-not-copy",
      };
    },
    async listPods() {
      return [structuredClone(pod)];
    },
  };
  const pod = {
    metadata: {
      name: "database-1",
      uid: "pod-uid",
      ownerReferences: [
        { kind: "Cluster", uid: "uid-Cluster", controller: true },
      ],
      labels: { "cnpg.io/cluster": "database", "cnpg.io/podRole": "instance" },
    },
    status: {
      phase: "Succeeded",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const first = await reconcileEnvironment(api, claim, config);
  assert.equal(
    first.ready,
    false,
    "a stale CNPG condition and completed Pod cannot mark an environment ready",
  );
  const cluster = resources.get(`Cluster:${namespace}:database`);
  assert.equal(cluster.spec.enableSuperuserAccess, false);
  assert.equal(cluster.spec.storage.size, "5Gi");
  assert.equal(cluster.spec.resources.limits.memory, "960Mi");
  assert.equal(
    resources.get(`ResourceQuota:${namespace}:database-resources`).spec.hard[
      "limits.cpu"
    ],
    "2k",
  );
  assert.equal(
    resources.get(`ResourceQuota:${namespace}:database-resources`).spec.hard[
      "requests.memory"
    ],
    "2Gi",
  );
  assert.equal(
    resources.get(`NetworkPolicy:${namespace}:default-deny`).spec.policyTypes
      .length,
    2,
  );
  assert.equal(
    resources
      .get(`CiliumNetworkPolicy:${namespace}:database-boundaries`)
      .spec.egress.some(
        (entry) => entry.toFQDNs?.[0]?.matchName === "archive.example.invalid",
      ),
    true,
  );
  assert.deepEqual(
    Object.keys(
      resources.get(`Secret:${namespace}:archive-credentials`).data,
    ).sort(),
    ["accessKeyId", "region", "secretAccessKey"],
  );
  assert.equal(
    resources.get(`Secret:${namespace}:archive-credentials`).data.region,
    Buffer.from("auto").toString("base64"),
  );
  assert.deepEqual(
    resources.get(`ObjectStore:${namespace}:archive`).spec.configuration
      .s3Credentials.region,
    { name: "archive-credentials", key: "region" },
  );
  assert.equal(
    resources.get(`ObjectStore:${namespace}:archive`).spec.configuration
      .destinationPath,
    `s3://test-backups/pilot/${environmentId}/`,
  );
  pod.status.phase = "Running";
  const restarted = await reconcileEnvironment(
    api,
    { ...claim, leaseEpoch: 2 },
    config,
  );
  assert.deepEqual(restarted, {
    ready: true,
    observation: {
      clusterUid: "uid-Cluster",
      clusterGeneration: 1,
      readyInstances: 1,
    },
  });
  assert.equal(createCounts.get("Cluster"), 1);
  cluster.metadata.labels["pgcf.io/environment-id"] = "another-environment";
  await assert.rejects(
    reconcileEnvironment(api, { ...claim, leaseEpoch: 3 }, config),
    (error) => error.code === "ownership_mismatch",
  );
  assert.equal(createCounts.get("Cluster"), 1);
});
