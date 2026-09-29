// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  SuspendJournal,
  reconcileSuspend,
} from "../../src/suspend-reconcile.ts";

const mode = process.argv[2];
if (mode === "no-work") {
  process.stdout.write(
    JSON.stringify({ mode: "environment-suspend", status: "no_work" }) + "\n",
  );
} else if (mode === "bounded-output") {
  process.on("SIGTERM", () => {});
  // Inherited stdout/stderr keep the supervised child's close event pending
  // until this same-group descendant is also terminated.
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "hold"],
    { stdio: "inherit", env: process.env },
  );
  await once(descendant, "spawn");
  process.stdout.write("private-child-payload" + "x".repeat(131072));
  process.stderr.write("private-child-payload-stderr");
  setInterval(() => {}, 1000);
} else if (mode === "hold") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "stop") {
  const claim = {
    schemaVersion: 1,
    kind: "environment.suspend",
    operationId: "88888888-8888-4888-8888-888888888888",
    organizationId: "99999999-9999-4999-8999-999999999999",
    projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    environmentId: "11111111-1111-4111-8111-111111111111",
    regionId: "22222222-2222-4222-8222-222222222222",
    specRevision: 1,
    specHash: "a".repeat(64),
    runtimeRevision: 1,
    clusterUid: "44444444-4444-4444-8444-444444444444",
    pooler: null,
    leaseToken: "cplease_" + "l".repeat(43),
    leaseEpoch: 1,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  const namespace = "pgcf-" + claim.environmentId.replaceAll("-", "");
  const metadata = (name, uid) => ({
    name,
    namespace,
    uid,
    resourceVersion: "1",
    labels: {
      "app.kubernetes.io/managed-by": "cloudflare-postgres",
      "pgcf.io/environment-id": claim.environmentId,
      "pgcf.io/region-id": claim.regionId,
    },
    annotations: { "pgcf.io/spec-hash": claim.specHash },
  });
  const inventory = {
    namespace: {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        ...metadata(namespace, "33333333-3333-4333-8333-333333333333"),
        namespace: undefined,
      },
    },
    cluster: {
      apiVersion: "postgresql.cnpg.io/v1",
      kind: "Cluster",
      metadata: metadata("database", claim.clusterUid),
      spec: { instances: 1 },
    },
    quota: {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata(
        "database-resources",
        "55555555-5555-4555-8555-555555555555",
      ),
      spec: { hard: { pods: "0" } },
    },
    poolers: [],
    deployments: [],
    pods: [],
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
  inventory.cluster.metadata.annotations["cnpg.io/hibernation"] = "on";
  const journal = new SuspendJournal(
    join(process.argv[3], claim.operationId + ".sqlite"),
    claim,
  );
  try {
    const result = await reconcileSuspend(
      journal,
      {
        inventory: async () => inventory,
        patch: async () => {
          throw new Error("unexpected_fixture_effect");
        },
      },
      () => {},
    );
    if (result.suspended || result.reason !== "physical_verification_pending")
      throw new Error("fixture_stop_not_deferred");
    process.stdout.write(
      JSON.stringify({
        mode: "environment-suspend",
        status: "deferred",
        error: { code: "physical_verification_pending" },
      }) + "\n",
    );
    process.exitCode = 1;
  } finally {
    journal.close();
  }
} else throw new Error("fixture_mode_invalid");
