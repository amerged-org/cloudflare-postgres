// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import {
  FleetPatchInput,
  type FleetPatchFacts,
} from "@pgcf/contracts/fleet-patches";
import { canonical, digest } from "../src/bootstrap.ts";

export function patchFixture() {
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
  const spec = {
    version: 1,
    versions_lock_sha256: "c".repeat(64),
    configuration_schema_revision: 1,
    components: names.map((name) => ({
      name,
      kind: name === "api" || name === "edge" ? "worker_bundle" : "image",
      version: "1.0.0",
      reference: `registry.example/${name}${name === "openebs-lvm" ? ":1.0.0" : ""}@sha256:${"d".repeat(64)}`,
      sha256: "d".repeat(64),
    })),
    roles: { control_relay: role, customer: structuredClone(role) },
  };
  const now = new Date().toISOString(),
    node_uid = randomUUID(),
    cluster_uid = randomUUID(),
    operation_id = "op_abcdefghijklmnopqrst",
    node_id = "nod_abcdefghijklmnopqrst";
  const input = FleetPatchInput.parse({
    status: {
      operation_id,
      node_id,
      region_id: "eu-test",
      node_uid,
      cluster_uid,
      release_id: "test-release",
      spec_sha256: digest(canonical(spec)),
      assignment_revision: 1,
      revision: 0,
      stage: "preflight",
      state: "pending",
      baseline: null,
      observed: null,
      error_code: null,
      created_at: now,
      updated_at: now,
      deadline_at: new Date(Date.now() + 3600_000).toISOString(),
    },
    role: "customer",
    spec,
    address: "192.0.2.18",
    k8s_node_name: "test-node",
    cluster_nodes: [
      { node_id, node_uid, k8s_node_name: "test-node", assignment_revision: 1 },
    ],
    cluster_endpoint: "https://192.0.2.18:6443/",
    talos_admin_config: JSON.stringify({
      context: "test",
      contexts: {
        test: {
          ca: "test-only-ca",
          crt: "test-only-client-cert",
          key: "test-only-key",
          "proxy-url": "http://127.0.0.1:2",
        },
      },
    }),
    kubeconfig: JSON.stringify({
      clusters: [
        {
          name: "test",
          cluster: {
            server: "https://192.0.2.18:6443/",
            "certificate-authority-data": "test-only-ca",
            "proxy-url": "http://127.0.0.1:2",
          },
        },
      ],
      users: [
        {
          name: "test",
          user: {
            "client-certificate-data": "test-only-client-cert",
            "client-key-data": "test-only-key",
          },
        },
      ],
      contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
      "current-context": "test",
    }),
    callback: {
      url: `https://api.invalid/internal/v1/fleet-patches/${operation_id}`,
      bearer: "t".repeat(43),
    },
  });
  const facts: FleetPatchFacts = {
    node_uid,
    cluster_uid,
    system_uuid: randomUUID(),
    boot_id: randomUUID(),
    talos_version: "v1.14.0",
    talos_schematic_sha256: "b".repeat(64),
    kubelet_version: "v1.36.3",
    kubernetes_version: "v1.36.3",
    node_ready: true,
    databases_ready: true,
    cluster_nodes: [{ node_uid, kubelet_version: "v1.36.3", node_ready: true }],
    observed_at: now,
  };
  return { input, facts };
}
