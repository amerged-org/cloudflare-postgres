// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { newNodeId, type DesiredResponse } from "@pgcf/contracts";
import { FleetDesiredRelease } from "@pgcf/contracts/releases";
import { collectFleetInventory } from "../../src/agent/fleet-inventory.ts";
import { AgentApi } from "../../src/agent/api-client.ts";
import { AgentLoop } from "../../src/agent/loop.ts";
import { record, type Resource } from "../../src/agent/types.ts";
import { fixture, MemoryKubernetes } from "./fixtures.ts";

function inventoryFixture() {
  const k8s = new MemoryKubernetes();
  const node = k8s.put({
    apiVersion: "v1",
    kind: "Node",
    metadata: { name: "customer-node" },
    status: {
      allocatable: { memory: "8Gi", cpu: "4" },
      nodeInfo: {
        kubeletVersion: "v1.36.5",
        osImage: "Talos (v1.14.1)",
        bootID: crypto.randomUUID(),
      },
      conditions: [{ type: "Ready", status: "True" }],
    },
  });
  k8s.put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "pgcf-system" },
  });
  const pod = k8s.put({
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: "agent-one",
      namespace: "pgcf-system",
      labels: { app: "pgcf-agent" },
    },
    spec: {
      nodeName: "customer-node",
      containers: [
        {
          name: "agent",
          image: `registry.example/regional@sha256:${"d".repeat(64)}`,
        },
      ],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "agent",
          ready: true,
          restartCount: 0,
          imageID: `registry.example/regional@sha256:${"d".repeat(64)}`,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  });
  Object.assign(pod.metadata, {
    ownerReferences: [
      {
        controller: true,
        uid: crypto.randomUUID(),
        kind: "ReplicaSet",
        name: "agent",
      },
    ],
  });
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "regional",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
  ];
  const role = {
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"a".repeat(64)}`,
    talos_schematic_sha256: "b".repeat(64),
    talos_extensions: [],
    kubernetes_version: "1.36.5",
    components: names.slice(3),
  };
  const desired = FleetDesiredRelease.parse({
    region_id: "eu-test",
    region_revision: 1,
    release: {
      id: "release-one",
      spec_sha256: "e".repeat(64),
      approved_at: new Date().toISOString(),
      spec: {
        version: 1,
        versions_lock_sha256: "c".repeat(64),
        configuration_schema_revision: 1,
        components: names.map((name) => ({
          name,
          kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
          version: "1.0.0",
          reference: `registry.example/${name}@sha256:${"d".repeat(64)}`,
          sha256: "d".repeat(64),
          ...(name === "regional"
            ? {
                workload: {
                  namespace: "pgcf-system",
                  selector: { app: "pgcf-agent" },
                },
              }
            : {}),
        })),
        roles: { control_relay: role, customer: role },
      },
    },
    nodes: [
      {
        node_id: newNodeId(),
        node_uid: node.metadata.uid!,
        k8s_node_name: "customer-node",
        role: "customer",
        revision: 1,
      },
    ],
  });
  return { k8s, node, pod, desired };
}
function putTerminalPod(
  k8s: MemoryKubernetes,
  original: Resource,
  name: string,
  phase: "Succeeded" | "Failed",
) {
  const pod = k8s.put({
    ...structuredClone(original),
    metadata: { ...original.metadata, name },
  });
  const containers = record(pod.spec).containers as Record<string, unknown>[];
  containers[0]!.image = String(containers[0]!.image).replace(
    "d".repeat(64),
    "f".repeat(64),
  );
  const statuses = record(pod.status).containerStatuses as Record<
    string,
    unknown
  >[];
  record(pod.status).phase = phase;
  statuses[0]!.imageID = containers[0]!.image;
  statuses[0]!.ready = false;
  statuses[0]!.state = {
    terminated: { exitCode: phase === "Succeeded" ? 0 : 1 },
  };
}
function staticInventoryFixture() {
  const f = inventoryFixture();
  f.node.metadata.labels = { "node-role.kubernetes.io/control-plane": "" };
  f.desired.nodes[0]!.role = "control_relay";
  f.k8s.put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "kube-system" },
  });
  const image = `registry.example/kube-apiserver@sha256:${"d".repeat(64)}`;
  const pod = f.k8s.put({
    ...structuredClone(f.pod),
    metadata: {
      name: "kube-apiserver-one",
      namespace: "kube-system",
      labels: { component: "kube-apiserver" },
    },
    spec: {
      nodeName: f.node.metadata.name,
      containers: [{ name: "kube-apiserver", image }],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "kube-apiserver",
          ready: true,
          restartCount: 0,
          imageID: image,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  });
  Object.assign(pod.metadata, {
    ownerReferences: [
      {
        controller: true,
        uid: f.node.metadata.uid!,
        kind: "Node",
        name: f.node.metadata.name,
      },
    ],
  });
  return { ...f, pod };
}
test("collects stable actual Node/runtime facts and leaves unobservable release facts absent", async () => {
  const f = inventoryFixture(),
    reports = await collectFleetInventory(f.k8s, f.desired);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0]!.facts, {
    configuration_schema_revision: 1,
    boot_id: record(record(f.node.status).nodeInfo).bootID,
    kubernetes_version: "1.36.5",
    kubelet_version: "1.36.5",
    kubernetes_control_plane: false,
    talos_version: "1.14.1",
    components: [
      {
        name: "regional",
        version: "1.0.0",
        sha256: "d".repeat(64),
        runtime_image_sha256: "d".repeat(64),
      },
    ],
  });
  assert.equal(f.k8s.mutations, 0);
});
test("ignores terminal old workload Pods while observing the Ready current release", async () => {
  const f = inventoryFixture();
  putTerminalPod(f.k8s, f.pod, "agent-completed", "Succeeded");
  putTerminalPod(f.k8s, f.pod, "agent-failed", "Failed");
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [
      {
        name: "regional",
        version: "1.0.0",
        sha256: "d".repeat(64),
        runtime_image_sha256: "d".repeat(64),
      },
    ],
  );
});
test("refuses a workload Pod that becomes terminal during its fresh read", async () => {
  const f = inventoryFixture();
  const original = f.k8s.read.bind(f.k8s);
  f.k8s.read = async (...args) => {
    const value = await original(...args);
    if (args[0] === "Pod" && value) record(value.status).phase = "Succeeded";
    return value;
  };
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [],
  );
});
test("ignores terminal old static Pods while observing the Ready current image", async () => {
  const f = staticInventoryFixture();
  putTerminalPod(f.k8s, f.pod, "kube-apiserver-completed", "Succeeded");
  putTerminalPod(f.k8s, f.pod, "kube-apiserver-failed", "Failed");
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts
      .kubernetes_static_images,
    { apiServer: "d".repeat(64) },
  );
});
test("refuses a static Pod that becomes terminal during its fresh read", async () => {
  const f = staticInventoryFixture();
  const original = f.k8s.read.bind(f.k8s);
  f.k8s.read = async (...args) => {
    const value = await original(...args);
    if (args[0] === "Pod" && value && args[1] === "kube-system")
      record(value.status).phase = "Failed";
    return value;
  };
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts
      .kubernetes_static_images,
    {},
  );
});
test("keeps unqualified runtime child digests distinct from configured release digests", async () => {
  const f = inventoryFixture();
  const statuses = record(f.pod.status).containerStatuses as Record<
    string,
    unknown
  >[];
  statuses[0]!.imageID = `containerd://sha256:${"f".repeat(64)}`;
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [{ name: "regional", runtime_image_sha256: "f".repeat(64) }],
  );
  statuses[0]!.ready = false;
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [],
  );
});
test("an explicit cluster-scoped platform workload can run on the control node while the customer worker is observed", async () => {
  const f = inventoryFixture();
  const component = f.desired.release.spec.components.find(
    (v) => v.name === "regional",
  )!;
  component.workload!.scope = "cluster";
  record(f.pod.spec).nodeName = "control-node";
  assert.equal(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components[0]
      ?.sha256,
    "d".repeat(64),
  );
  delete component.workload!.scope;
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [],
  );
});
test("refuses wrong ownership, restarted Pods and changed physical identity", async () => {
  const f = inventoryFixture();
  f.pod.metadata.labels = { app: "customer" };
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [],
  );
  f.pod.metadata.labels = { app: "pgcf-agent" };
  const original = f.k8s.read.bind(f.k8s);
  f.k8s.read = async (...args) => {
    const value = await original(...args);
    if (args[0] === "Pod" && value)
      (
        record(value.status).containerStatuses as Record<string, unknown>[]
      )[0]!.restartCount = 1;
    return value;
  };
  assert.deepEqual(
    (await collectFleetInventory(f.k8s, f.desired))[0]!.facts.components,
    [],
  );
  f.node.metadata.uid = crypto.randomUUID();
  assert.deepEqual(await collectFleetInventory(f.k8s, f.desired), []);
});
test("preserves release metadata across desired pages, rejects a changed selection and authenticates partial inventory posts", async () => {
  const f = inventoryFixture(),
    db = fixture().db;
  const key = `pgcf_ak_eu-test_${randomBytes(32).toString("base64url")}`;
  let page = 0,
    change = false,
    posted: unknown;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      posted = JSON.parse(text);
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    const second = page++ % 2 === 1;
    response.end(
      JSON.stringify({
        region: {
          id: "eu-test",
          backup: {
            bucket: "pgcf-backups",
            endpoint_url: "https://r2.example.invalid",
            region: "auto",
          },
        },
        databases: second ? [] : [db],
        next: second ? null : db.id,
        fleet_release:
          second && change ? { ...f.desired, region_revision: 2 } : f.desired,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new AgentApi({
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    agentKey: key,
    regionId: "eu-test",
  });
  try {
    assert.deepEqual(
      (await client.desired(new AbortController().signal)).fleet_release,
      f.desired,
    );
    change = true;
    await assert.rejects(
      client.desired(new AbortController().signal),
      /desired_fleet_release_changed/,
    );
    const report = (await collectFleetInventory(f.k8s, f.desired))[0]!;
    await client.fleetObservations(report, new AbortController().signal);
    assert.deepEqual(posted, report);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("coalesces inventory outside reconciliation and respects its minimum interval", async () => {
  const f = inventoryFixture();
  const desired: DesiredResponse = {
    region: {
      id: "eu-test",
      backup: {
        bucket: "pgcf-backups",
        endpoint_url: "https://r2.example.invalid",
        region: "auto",
      },
    },
    databases: [],
    next: null,
    fleet_release: f.desired,
  };
  let pulls = 0,
    posted = 0,
    now = Date.now();
  const api = {
    desired: async () => {
      pulls++;
      return desired;
    },
    observations: async () => {},
    fleetObservations: async () => {
      posted++;
    },
  };
  const loop = new AgentLoop(
    api,
    f.k8s,
    fixture().ctx.postgresImage,
    new AbortController().signal,
    () => {},
    () => now,
  );
  await loop.cycle();
  for (let n = 0; n < 20 && !posted; n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted, 1);
  await loop.cycle();
  assert.equal(posted, 1);
  assert.equal(pulls, 2);
  now += 60_000;
  await loop.cycle();
  for (let n = 0; n < 20 && posted === 1; n++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted, 2);
});
