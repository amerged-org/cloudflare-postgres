// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { stopOwnedRuntime, volumeHash } from "../src/owned-stop.ts";
import { AllowanceJournal } from "../src/allowance-journal.ts";
import { allowanceKubernetesFromConfig } from "../src/allowance-kubernetes.ts";
import { reconcileEnvironment } from "../src/reconcile.ts";

const environmentId = "11111111-1111-4111-8111-111111111111",
  regionId = "22222222-2222-4222-8222-222222222222",
  namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
const binding = {
  environmentId,
  regionId,
  projectId: "99999999-9999-4999-8999-999999999999",
  specRevision: 1,
  specHash: "a".repeat(64),
  namespace,
  namespaceUid: "33333333-3333-4333-8333-333333333333",
  clusterUid: "44444444-4444-4444-8444-444444444444",
  quotaUid: "55555555-5555-4555-8555-555555555555",
};
const labels = {
  "app.kubernetes.io/managed-by": "cloudflare-postgres",
  "pgcf.io/environment-id": environmentId,
  "pgcf.io/region-id": regionId,
};
function inventory(epoch) {
  const metadata = (name, uid) => ({
    name,
    namespace,
    uid,
    resourceVersion: "10",
    labels: { ...labels },
    annotations: {
      "pgcf.io/spec-hash": binding.specHash,
      ...(epoch === undefined ? {} : { "pgcf.io/run-epoch": epoch }),
    },
  });
  return {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        ...metadata(namespace, binding.namespaceUid),
        namespace: undefined,
      },
    },
    cluster: {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: metadata("database", binding.clusterUid),
      spec: { instances: 1 },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("database-resources", binding.quotaUid),
      spec: { hard: { pods: "2" } },
    },
    pods: [],
    pvcs: [],
    pvs: [],
    poolers: [],
    deployments: [],
  };
}

test("an immutable journal epoch prevents stale and legacy stoppers from adopting a later run or a partial epoch transition", async (t) => {
  const state = inventory("2"),
    patches = [];
  const runtime = {
    inventory: async () => structuredClone(state),
    patch: async (kind, name, ops) => {
      patches.push(ops);
      const r = kind === "Cluster" ? state.cluster : state.quota;
      if (kind === "Cluster")
        r.metadata.annotations["cnpg.io/hibernation"] = "on";
      else r.spec.hard.pods = "0";
    },
  };
  const hash = volumeHash(state, binding);
  assert.equal(
    await stopOwnedRuntime(runtime, binding, hash),
    false,
    "an unfenced old stopper cannot adopt annotated resources",
  );
  assert.equal(patches.length, 0);
  assert.equal(
    await stopOwnedRuntime(runtime, { ...binding, runEpoch: "1" }, hash),
    false,
  );
  assert.equal(patches.length, 0);
  const explicit = { ...binding, runEpoch: "2" };
  delete state.quota.metadata.annotations["pgcf.io/run-epoch"];
  assert.equal(await stopOwnedRuntime(runtime, explicit, hash), false);
  assert.equal(patches.length, 0);
  state.quota.metadata.annotations["pgcf.io/run-epoch"] = "2";
  assert.equal(await stopOwnedRuntime(runtime, explicit, hash), true);
  assert.equal(patches.length, 2);
  assert.ok(
    patches.every((ops) =>
      ops.some(
        (op) =>
          op.op === "test" &&
          op.path === "/metadata/annotations/pgcf.io~1run-epoch" &&
          op.value === "2",
      ),
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "pgcf-run-epoch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "allowance.sqlite");
  const journal = new AllowanceJournal(path, explicit);
  journal.close();
  assert.throws(
    () => new AllowanceJournal(path, { ...binding, runEpoch: "3" }),
    /identity_mismatch/,
  );
});

test("new fenced provisioning stamps every controlled resource and the SDK refuses a stale epoch despite fresh UID and resourceVersion", async (t) => {
  const spec = {
    name: "fenced",
    regionId,
    catalogVersion: "fenced-v1",
    profileId: "small",
    volumeGiB: 5,
    profile: {
      id: "small",
      postgresImage: `example.invalid/postgres@sha256:${"a".repeat(64)}`,
      compute: { cpuMilli: 500, memoryMiB: 512 },
      storage: {
        classId: "local",
        storageClassName: "local",
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
      executionFencing: { version: 1 },
    },
  };
  const specHash = createHash("sha256")
      .update(JSON.stringify(spec))
      .digest("hex"),
    resources = [];
  const api = {
    read: async () => null,
    create: async (r) => {
      resources.push(structuredClone(r));
      return {
        ...r,
        metadata: {
          ...r.metadata,
          uid:
            r.kind === "Namespace"
              ? binding.namespaceUid
              : r.kind === "Cluster"
                ? binding.clusterUid
                : r.kind === "ResourceQuota"
                  ? binding.quotaUid
                  : "resource-uid",
          generation: 1,
          resourceVersion: "10",
        },
      };
    },
    readSecret: async () => ({ access: "ZmFrZQ==", secret: "ZmFrZQ==" }),
    listPods: async () => [],
  };
  await reconcileEnvironment(
    api,
    {
      operationId: "66666666-6666-4666-8666-666666666666",
      environmentId,
      regionId,
      kind: "environment.create",
      specRevision: 1,
      specHash,
      spec,
      runEpoch: "1",
    },
    {
      operatorNamespace: "cnpg-system",
      operatorPodLabels: { "app.kubernetes.io/name": "cnpg" },
      allowedBackupSecrets: [spec.profile.backup.credentialSecret],
    },
  );
  const controlled = resources.filter((r) =>
    ["Namespace", "ResourceQuota", "Cluster"].includes(r.kind),
  );
  assert.equal(controlled.length, 3);
  assert.ok(
    controlled.every(
      (r) => r.metadata.annotations["pgcf.io/run-epoch"] === "1",
    ),
  );
  const state = inventory("2"),
    dir = mkdtempSync(join(tmpdir(), "pgcf-epoch-sdk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let patchCount = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      const object = req.url.includes("/resourcequotas/")
        ? state.quota
        : req.url.includes("/clusters/")
          ? state.cluster
          : state.namespace;
      res.end(JSON.stringify(object));
    } else {
      patchCount++;
      res.end(JSON.stringify(state.quota));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const file = join(dir, "kubeconfig.json");
    writeFileSync(
      file,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
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
    const adapter = allowanceKubernetesFromConfig(file, "test", {
      ...binding,
      runEpoch: "1",
    });
    await assert.rejects(
      adapter.patch("ResourceQuota", "database-resources", [
        { op: "test", path: "/metadata/uid", value: binding.quotaUid },
        { op: "test", path: "/metadata/resourceVersion", value: "10" },
        {
          op: "test",
          path: "/metadata/annotations/pgcf.io~1run-epoch",
          value: "1",
        },
        { op: "replace", path: "/spec/hard/pods", value: "0" },
      ]),
    );
    assert.equal(patchCount, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
