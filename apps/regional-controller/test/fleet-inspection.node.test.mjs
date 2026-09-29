// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { inspectFleet, applyFleetInspection } from "../src/fleet-inspection.ts";
import { prepareMaintenance } from "../src/maintenance.ts";
import { createHash } from "node:crypto";
import { collectFleet } from "../src/fleet-inspection-cli.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const uuid = "11111111-1111-4111-8111-111111111111",
  nodeUid = "22222222-2222-4222-8222-222222222222",
  clusterUid = "33333333-3333-4333-8333-333333333333";
test("correlates only explicit provider and Node enrollment, leaves the builder unmanaged and blocks maintenance after replacement without granting machine or capacity authority", async () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z"),
    configuration = {
      schemaVersion: 1,
      regionId: uuid,
      bindings: [
        {
          instanceId: "101",
          nodeName: "database-node",
          nodeUid,
          regionId: uuid,
        },
      ],
    };
  const provider = {
    provider: "contabo",
    instances: [
      {
        instanceId: "101",
        region: "EU",
        dataCenter: "European Union 2",
        status: "running",
        cpuCores: 4,
        ramMb: "8192",
        diskMb: "163840",
        ipv4: "192.0.2.10",
        ipv6: null,
      },
      {
        instanceId: "102",
        region: "EU",
        dataCenter: "European Union 2",
        status: "running",
        cpuCores: 4,
        ramMb: "8192",
        diskMb: "163840",
        ipv4: "192.0.2.11",
        ipv6: null,
      },
    ],
    observation: {
      startedAt: new Date(now - 1).toISOString(),
      observedAt: new Date(now).toISOString(),
      consistency: "observed-scan",
      enumerationComplete: true,
      evidenceHash: "a".repeat(64),
    },
    actionsEnabled: false,
    machineIdentityVerified: false,
  };
  const node = {
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "database-node", uid: nodeUid },
    status: {
      addresses: [{ type: "InternalIP", address: "192.0.2.10" }],
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: {
        bootID: "44444444-4444-4444-8444-444444444444",
        kubeletVersion: "v1.36.3",
      },
      allocatable: { cpu: "3950m", memory: "7Gi" },
    },
  };
  let nodes = [node],
    currentProvider = provider;
  const transport = {
    provider: async () => currentProvider,
    nodes: async () => nodes,
  };
  const good = await inspectFleet(configuration, transport, now);
  assert.equal(good.status, "observed");
  assert.equal(good.boundNodes.length, 1);
  assert.equal(good.unmanagedInstances.length, 1);
  assert.equal(good.unmanagedInstances[0].instanceId, "102");
  assert.deepEqual(good.blockers, []);
  assert.equal(good.machineIdentityVerified, false);
  assert.equal(good.capacityReserved, false);
  assert.equal(good.actionsEnabled, false);
  assert.match(good.evidenceHash, /^[a-f0-9]{64}$/);
  const plan = {
      schemaVersion: 1,
      kind: "kubernetes.upgrade",
      clusterUid,
      nodeUids: [nodeUid],
      fromVersion: "1.36.3",
      toVersion: "1.36.3",
      talosVersion: "1.14.1",
      toolImage: `ghcr.io/siderolabs/talosctl@sha256:${"b".repeat(64)}`,
      targetArtifactsHash: "c".repeat(64),
    },
    planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const snapshot = {
    complete: true,
    observedAt: now,
    regionId: uuid,
    clusterUid,
    targetNodeUid: nodeUid,
    machineIdentity: null,
    nodes: [{ uid: nodeUid, ready: true, kubernetesVersion: "v1.36.3" }],
    etcd: null,
    databases: [],
    recovery: null,
    staging: null,
    capacity: null,
  };
  assert.equal(applyFleetInspection(snapshot, good).machineIdentity, null);
  assert.equal(applyFleetInspection(snapshot, good).capacity, null);
  nodes = [
    {
      ...node,
      metadata: {
        ...node.metadata,
        uid: "55555555-5555-4555-8555-555555555555",
      },
    },
  ];
  const replaced = await inspectFleet(configuration, transport, now);
  assert(replaced.blockers.includes("node_changed"));
  const guarded = applyFleetInspection(
    {
      ...snapshot,
      machineIdentity: {
        status: "verified",
        planHash,
        evidenceHash: "d".repeat(64),
        observedAt: now,
        expiresAt: now + 60000,
      },
    },
    replaced,
  );
  assert.equal(guarded.complete, false);
  assert.equal(guarded.machineIdentity, null);
  let jobs = 0;
  const result = await prepareMaintenance(
    {
      operationId: "66666666-6666-4666-8666-666666666666",
      regionId: uuid,
      plan,
      planHash,
      leaseToken: "cpmtl_" + "e".repeat(43),
      leaseEpoch: 1,
      leaseExpiresAt: new Date(now + 60000).toISOString(),
    },
    guarded,
    {
      namespace: "pgcf-system",
      talosconfigSecret: "operator-talos",
      endpoints: ["192.0.2.10"],
      now: () => now,
      leaseValid: async () => true,
    },
    {
      readJob: async () => null,
      createJob: async () => {
        jobs++;
        throw new Error("unexpected job");
      },
    },
  );
  assert.equal(result.status, "blocked");
  assert.equal(jobs, 0);
  nodes = [node];
  currentProvider = { ...provider, instances: [provider.instances[1]] };
  const missing = await inspectFleet(configuration, transport, now);
  assert(missing.blockers.includes("provider_missing"));
  assert.equal(missing.capacityReserved, false);
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    await assert.rejects(
      collectFleet({
        ...configuration,
        controlOrigin: "https://control.example.test",
        installationTokenFile: "/unreadable-fleet-token",
        kubeconfigFile: "/unreadable-fleet-kubeconfig",
        kubeconfigContext: "test",
        reportPath: "/unreadable-report",
      }),
      (error) => error.message === "fleet_inspection_failed",
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
  const directory = mkdtempSync(join(tmpdir(), "pgcf-fleet-auth-"));
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  try {
    const installationTokenFile = join(directory, "installer"),
      kubeconfigFile = join(directory, "kubeconfig");
    writeFileSync(installationTokenFile, "fixture-installation-token\n", {
      mode: 0o600,
    });
    writeFileSync(
      kubeconfigFile,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "test",
            cluster: {
              server: "https://127.0.0.1:1",
              "certificate-authority-data": "ZmFrZS1jYQ==",
            },
          },
        ],
        users: [
          {
            name: "test",
            user: {
              exec: {
                apiVersion: "client.authentication.k8s.io/v1",
                command: "/no-such-fleet-auth-helper",
                interactiveMode: "Never",
              },
            },
          },
        ],
        contexts: [
          { name: "test", context: { cluster: "test", user: "test" } },
        ],
        "current-context": "test",
      }),
      { mode: 0o600 },
    );
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error("unexpected_credential_dispatch");
    };
    await assert.rejects(
      collectFleet({
        ...configuration,
        controlOrigin: "https://control.example.test",
        installationTokenFile,
        kubeconfigFile,
        kubeconfigContext: "test",
        reportPath: join(directory, "report"),
      }),
      (error) => error.message === "fleet_inspection_failed",
    );
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
