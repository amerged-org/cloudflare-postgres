// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { stringify } from "yaml";
import {
  NodeBootstrapCallback,
  type NodeBootstrapAuthority,
} from "@pgcf/contracts/node-bootstrap";
import { BootstrapJob, type Command } from "../src/bootstrap.ts";
import { authority, fixture } from "./fixture.ts";

function admissionFixture() {
  const input = fixture();
  let current = authority(input);
  const uid = randomUUID();
  const clusterUID = randomUUID();
  const config = stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: input.spec.cluster_name,
        cluster: {
          server: input.spec.cluster_endpoint,
          "certificate-authority-data": randomBytes(32).toString("base64"),
        },
      },
    ],
    users: [
      {
        name: "admin",
        user: {
          "client-certificate-data": randomBytes(32).toString("base64"),
          "client-key-data": randomBytes(32).toString("base64"),
        },
      },
    ],
    contexts: [
      {
        name: input.spec.cluster_name,
        context: { cluster: input.spec.cluster_name, user: "admin" },
      },
    ],
    "current-context": input.spec.cluster_name,
  });
  current = {
    ...current,
    revision: 7,
    admission_authorized: true,
    admission_binding: {
      checkpoint_revision: 7,
      node_uid: uid,
      resource_version: "41",
      kube_system_uid: clusterUID,
      quarantine: {
        key: "pgcf.io/quarantine",
        value: "bootstrap",
        effect: "NoSchedule",
      },
    },
    protected_material: {
      purpose: "join_bundle",
      material: {
        version: 1,
        cluster_name: input.spec.cluster_name,
        cluster_endpoint: input.spec.cluster_endpoint,
        talos_version: "1.14.1",
        kubernetes_version: "1.36.3",
        talos_machine_secrets_yaml: randomUUID(),
        talos_admin_config: randomUUID(),
        kube_system_uid: clusterUID,
        kubeconfig: config,
      },
    },
    checkpoint: {
      ...current.checkpoint,
      stage: "awaiting_verification",
      status: "awaiting_verification",
      destructive_intent: true,
    },
  };
  const node = {
    metadata: {
      uid,
      resourceVersion: "41",
      labels: {
        "pgcf.io/node-id": input.spec.node_id,
        "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
        "pgcf.io/region": input.spec.region_id,
      },
    },
    spec: {
      taints: [
        { key: "custom", value: "reserved", effect: "NoSchedule" },
        { key: "pgcf.io/quarantine", value: "bootstrap", effect: "NoSchedule" },
      ],
    },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      addresses: [{ type: "InternalIP", address: input.spec.hardware.ipv4 }],
    },
  };
  return { input, current, node, uid, clusterUID };
}

test("authorized release reconciles a lost patch response, preserves other taints and persists its receipt", async () => {
  const state = admissionFixture();
  let current = state.current;
  let patches = 0;
  const job = new BootstrapJob(state.input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      return Response.json(current);
    },
    run: async (command) => {
      assert.equal(command.executable, "kubectl");
      if (command.args.includes("namespace"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({ metadata: { uid: state.clusterUID } }),
        };
      if (command.args.includes("patch")) {
        patches++;
        const patch = JSON.parse(command.stdin!) as Array<{
          op: string;
          path: string;
          value?: unknown;
        }>;
        assert.deepEqual(patch.slice(0, 2), [
          { op: "test", path: "/metadata/uid", value: state.uid },
          { op: "test", path: "/metadata/resourceVersion", value: "41" },
        ]);
        assert.equal(patch[2]?.path, "/spec/taints/1");
        assert.equal(patch[3]?.op, "remove");
        assert.equal(patch[3]?.path, "/spec/taints/1");
        state.node.spec.taints.splice(1, 1);
        state.node.metadata.resourceVersion = "42";
        throw new Error("patch response lost");
      }
      return { exit_code: 0, stdout: JSON.stringify(state.node) };
    },
  });
  const receipt = await job.admit();
  assert.equal(patches, 1);
  assert.equal(receipt.node_uid, state.uid);
  assert.equal(receipt.previous_resource_version, "41");
  assert.equal(receipt.resource_version, "42");
  assert.deepEqual(state.node.spec.taints, [
    { key: "custom", value: "reserved", effect: "NoSchedule" },
  ]);
  assert.equal(current.checkpoint.stage, "quarantine_released");
  assert.equal(current.checkpoint.status, "released");
  assert.equal(current.checkpoint.admission_receipt?.node_uid, state.uid);
  assert.equal(current.admitted, false);
});

test("restart after release intent reads absence without repeating the patch and rejects a replacement Node", async () => {
  const state = admissionFixture();
  let current: NodeBootstrapAuthority = {
    ...state.current,
    checkpoint: {
      ...state.current.checkpoint,
      stage: "quarantine_release_intent",
      release_node_uid: state.uid,
      release_resource_version: "41",
    },
  };
  state.node.spec.taints.splice(1, 1);
  state.node.metadata.resourceVersion = "42";
  let patches = 0;
  const options = {
    request: (async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      return Response.json(current);
    }) as typeof fetch,
    run: async (command: Command) => {
      if (command.args.includes("patch")) {
        patches++;
        throw new Error("patch repeated");
      }
      return {
        exit_code: 0,
        stdout: JSON.stringify(
          command.args.includes("namespace")
            ? { metadata: { uid: state.clusterUID } }
            : state.node,
        ),
      };
    },
  };
  const receipt = await new BootstrapJob(state.input, options).admit();
  assert.equal(patches, 0);
  assert.equal(receipt.node_uid, state.uid);
  state.node.metadata.uid = randomUUID();
  await assert.rejects(
    new BootstrapJob(state.input, options).admit(),
    /admission_node_identity_mismatch/,
  );
  assert.equal(patches, 0);
  current = { ...current, admission_authorized: false };
  await assert.rejects(
    new BootstrapJob(state.input, options).admit(),
    /admission_not_authorized/,
  );
});
