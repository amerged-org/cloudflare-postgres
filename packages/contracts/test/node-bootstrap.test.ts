// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newNodeId, newOperationId } from "../src/ids.ts";
import {
  NodeBootstrapCallback,
  NodeBootstrapCheckpoint,
  NodeBootstrapMaterial,
  NodeBootstrapTransport,
  NodeRegionSeed,
  NodeJoinBundle,
} from "../src/node-bootstrap.ts";

describe("private bootstrap contracts", () => {
  it("bounds the entire encrypted material to 256 KiB instead of allowing oversized field combinations", () => {
    const cluster = {
      version: 1,
      cluster_name: `cluster-${randomUUID()}`,
      cluster_endpoint: `https://${[192, 0, 2, 5].join(".")}:6443/`,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
    };
    const material = {
      ...cluster,
      talos_machine_secrets_yaml: randomUUID().repeat(3800),
      talos_admin_config: randomUUID().repeat(3800),
    };
    expect(NodeRegionSeed.safeParse(material).success).toBe(false);
    expect(
      NodeJoinBundle.safeParse({
        ...material,
        kube_system_uid: randomUUID(),
        kubeconfig: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it("refuses arbitrary commands, hosts, ports and checkpoint stdout", () => {
    const identity = {
      version: 1,
      operation_id: newOperationId(),
      node_id: newNodeId(),
      region_id: "region-dev",
      input_hash: "a".repeat(64),
      request_id: randomUUID(),
    };
    expect(
      NodeBootstrapCallback.safeParse({
        ...identity,
        kind: "transport",
        payload: { capability: "rescue_ssh" },
      }).success,
    ).toBe(true);
    expect(
      NodeBootstrapCallback.safeParse({
        ...identity,
        kind: "transport",
        payload: {
          capability: "rescue_ssh",
          host: randomUUID(),
          command: "sh",
        },
      }).success,
    ).toBe(false);
    expect(
      NodeBootstrapTransport.safeParse({
        websocket_url: `wss://${randomUUID()}.invalid/`,
        token: randomUUID(),
        expectedTarget: { ip: [192, 0, 2, 5].join("."), port: 5432 },
      }).success,
    ).toBe(false);
    expect(
      NodeBootstrapCheckpoint.safeParse({
        stage: "created",
        status: "running",
        downloaded_bytes: 0,
        written_bytes: 0,
        write_intent_offset: null,
        destructive_intent: false,
        sealed_ref: null,
        pre_reboot_boot_id: null,
        error_code: null,
        stdout: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it("separates a genuine seed from an observed complete join bundle", () => {
    const seed = {
      version: 1,
      cluster_name: `cluster-${randomUUID()}`,
      cluster_endpoint: `https://${[192, 0, 2, 5].join(".")}:6443/`,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: randomUUID(),
      talos_admin_config: randomUUID(),
    };
    expect(
      NodeBootstrapMaterial.safeParse({
        purpose: "region_seed",
        material: seed,
      }).success,
    ).toBe(true);
    expect(
      NodeBootstrapMaterial.safeParse({
        purpose: "join_bundle",
        material: seed,
      }).success,
    ).toBe(false);
    expect(
      NodeBootstrapMaterial.safeParse({
        purpose: "join_bundle",
        material: {
          ...seed,
          kube_system_uid: randomUUID(),
          kubeconfig: randomUUID(),
        },
      }).success,
    ).toBe(true);
  });
});
