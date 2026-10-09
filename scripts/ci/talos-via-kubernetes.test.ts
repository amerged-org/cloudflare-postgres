// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

interface NodeProof {
  nodeName: string;
  address: string;
  systemUuid: string;
  bootId: string;
}
interface Carrier {
  name: string;
  uid: string;
  ownerUid: string;
  image: string;
  imageID: string;
}
// Importing the helper must not start its CLI or require JS declaration generation.
const {
  verifyNode,
  selectCiliumPod,
  assertSameCarrier,
  validateTalosCommand,
  stopChild,
} = (await import(
  new URL("../operations/talos-via-kubernetes.mjs", import.meta.url).href
)) as {
  verifyNode(
    binding: unknown,
    namespace: unknown,
    node: unknown,
    knownAddress: string,
  ): NodeProof;
  selectCiliumPod(
    pods: unknown,
    daemonSet: unknown,
    node: NodeProof,
    expectedImage: string,
    expectedImageID: string,
  ): Carrier;
  assertSameCarrier(before: Carrier, after: Carrier): void;
  validateTalosCommand(args: string[], outputDir: string): string[];
  stopChild(child: ChildProcess): Promise<void>;
};

function fixture() {
  const binding = {
      node_uid: crypto.randomUUID(),
      cluster_uid: crypto.randomUUID(),
      node_name: "pgcf-node-fixture",
      material_revision: 1,
    },
    namespace = { metadata: { name: "kube-system", uid: binding.cluster_uid } },
    node = {
      metadata: { name: binding.node_name, uid: binding.node_uid },
      status: {
        conditions: [{ type: "Ready", status: "True" }],
        addresses: [{ type: "InternalIP", address: "192.0.2.40" }],
        nodeInfo: {
          systemUUID: crypto.randomUUID(),
          bootID: crypto.randomUUID(),
        },
      },
    },
    image = `quay.io/cilium/cilium:v1.20.2@sha256:${"a".repeat(64)}`,
    imageID = `quay.io/cilium/cilium@sha256:${"a".repeat(64)}`,
    daemonSet = {
      metadata: {
        name: "cilium",
        namespace: "kube-system",
        uid: crypto.randomUUID(),
      },
      spec: {
        template: {
          spec: {
            hostNetwork: true,
            containers: [{ name: "cilium-agent", image }],
          },
        },
      },
    },
    pod = {
      metadata: {
        name: "cilium-fixture",
        namespace: "kube-system",
        uid: crypto.randomUUID(),
        labels: { "k8s-app": "cilium" },
        ownerReferences: [
          {
            controller: true,
            kind: "DaemonSet",
            name: "cilium",
            uid: daemonSet.metadata.uid,
          },
        ],
      },
      spec: {
        nodeName: binding.node_name,
        hostNetwork: true,
        containers: [{ name: "cilium-agent", image }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          {
            name: "cilium-agent",
            ready: true,
            imageID,
            state: { running: {} },
          },
        ],
      },
    };
  const proof = verifyNode(binding, namespace, node, "192.0.2.40");
  return { binding, namespace, node, image, imageID, daemonSet, pod, proof };
}

test("binds the actual Cluster, Node UID/name, literal IP and physical identity", () => {
  const f = fixture();
  assert.deepEqual(f.proof, {
    nodeName: f.binding.node_name,
    address: "192.0.2.40",
    systemUuid: f.node.status.nodeInfo.systemUUID,
    bootId: f.node.status.nodeInfo.bootID,
  });
  assert.throws(() =>
    verifyNode(
      f.binding,
      { metadata: { uid: crypto.randomUUID() } },
      f.node,
      "192.0.2.40",
    ),
  );
  assert.throws(() =>
    verifyNode(
      f.binding,
      f.namespace,
      { ...f.node, metadata: { ...f.node.metadata, uid: crypto.randomUUID() } },
      "192.0.2.40",
    ),
  );
  assert.throws(() =>
    verifyNode(
      f.binding,
      f.namespace,
      { ...f.node, metadata: { ...f.node.metadata, name: "other-node" } },
      "192.0.2.40",
    ),
  );
  assert.throws(() => verifyNode(f.binding, f.namespace, f.node, "192.0.2.41"));
  assert.throws(() =>
    verifyNode(f.binding, f.namespace, f.node, "node.invalid"),
  );
  assert.throws(() =>
    verifyNode(
      f.binding,
      f.namespace,
      {
        ...f.node,
        status: { ...f.node.status, nodeInfo: { systemUUID: "", bootID: "" } },
      },
      "192.0.2.40",
    ),
  );
});

test("requires the exact existing host-network Cilium owner, spec and running image", () => {
  const f = fixture();
  const select = (pod: unknown = f.pod) =>
    selectCiliumPod({ items: [pod] }, f.daemonSet, f.proof, f.image, f.imageID);
  const before = select();
  assert.deepEqual(before, {
    name: f.pod.metadata.name,
    uid: f.pod.metadata.uid,
    ownerUid: f.daemonSet.metadata.uid,
    image: f.image,
    imageID: f.imageID,
  });
  assert.throws(() =>
    select({ ...f.pod, metadata: { ...f.pod.metadata, uid: "unknown" } }),
  );
  assert.throws(() =>
    select({
      ...f.pod,
      metadata: {
        ...f.pod.metadata,
        ownerReferences: [
          { ...f.pod.metadata.ownerReferences[0]!, uid: crypto.randomUUID() },
        ],
      },
    }),
  );
  assert.throws(() =>
    select({ ...f.pod, spec: { ...f.pod.spec, hostNetwork: false } }),
  );
  assert.throws(() =>
    select({
      ...f.pod,
      spec: {
        ...f.pod.spec,
        containers: [{ name: "cilium-agent", image: "other-image" }],
      },
    }),
  );
  assert.throws(() =>
    select({
      ...f.pod,
      status: {
        ...f.pod.status,
        containerStatuses: [
          {
            ...f.pod.status.containerStatuses[0]!,
            imageID: `quay.io/cilium/cilium@sha256:${"b".repeat(64)}`,
          },
        ],
      },
    }),
  );
  const replacement = select({
    ...f.pod,
    metadata: { ...f.pod.metadata, uid: crypto.randomUUID() },
  });
  assert.throws(() => assertSameCarrier(before, replacement));
  assert.doesNotThrow(() => assertSameCarrier(before, { ...before }));
});

test("keeps read commands and local snapshot output within the bounded helper", () => {
  const output = join(tmpdir(), "pgcf-operator-test-output");
  assert.deepEqual(
    validateTalosCommand(["get", "nodestatus", "-o", "json"], output),
    ["get", "nodestatus", "-o", "json"],
  );
  assert.deepEqual(
    validateTalosCommand(["read", "/sys/class/dmi/id/product_uuid"], output),
    ["read", "/sys/class/dmi/id/product_uuid"],
  );
  assert.deepEqual(validateTalosCommand(["version"], output), ["version"]);
  assert.deepEqual(validateTalosCommand(["image", "list"], output), [
    "image",
    "list",
  ]);
  assert.deepEqual(
    validateTalosCommand(["etcd", "snapshot", "preflight.snapshot"], output),
    ["etcd", "snapshot", join(output, "preflight.snapshot")],
  );
  assert.throws(() =>
    validateTalosCommand(["etcd", "snapshot", "../outside.snapshot"], output),
  );
  assert.throws(() =>
    validateTalosCommand(
      ["get", "nodestatus", "--endpoints=192.0.2.41"],
      output,
    ),
  );
  assert.throws(() =>
    validateTalosCommand(["version", "-e192.0.2.41"], output),
  );
  assert.throws(() =>
    validateTalosCommand(["version", "--nodes", "192.0.2.41"], output),
  );
  assert.throws(() =>
    validateTalosCommand(["version", "-n192.0.2.41"], output),
  );
  assert.throws(() =>
    validateTalosCommand(["version", "--context", "other"], output),
  );
  assert.throws(() =>
    validateTalosCommand(["version", "--talosconfig", "other"], output),
  );
  assert.throws(() => validateTalosCommand(["version", "-cother"], output));
  assert.throws(() => validateTalosCommand(["version", "--insecure"], output));
  assert.throws(() =>
    validateTalosCommand(["upgrade", "--image", "other-image"], output),
  );
  assert.throws(
    () =>
      validateTalosCommand(
        ["upgrade-k8s", "--dry-run", "--pre-pull-images=false"],
        output,
      ),
    { message: "talos_upgrade_dry_run_writes_configuration" },
  );
});

test(
  "terminates and reaps the actual owned local child",
  { timeout: 5000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["--eval", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    });
    await once(child, "spawn");
    const [ready] = await once(child.stdout!, "data");
    assert.equal(String(ready), "ready");
    await stopChild(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(child.signalCode, "SIGTERM");
  },
);
