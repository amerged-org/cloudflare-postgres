// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newNodeId, newOperationId } from "../src/ids.ts";
import {
  NodeBootstrapCallback,
  NodeBootstrapCheckpoint,
  NodeBootstrapMaterial,
  NodeBootstrapTransport,
  NodeRegionSeed,
  NodeJoinBundle,
  NodePlatformConfiguration,
  NodePlatformSpec,
  NodeBootstrapSpec,
} from "../src/node-bootstrap.ts";

describe("private bootstrap contracts", () => {
  it("accepts retained and security-fix Talos patches within the supported 1.14 line", () => {
    const version = NodeRegionSeed.shape.talos_version;
    expect(version.safeParse("1.14.1").success).toBe(true);
    expect(version.safeParse("1.14.2").success).toBe(true);
    expect(version.safeParse("1.15.0").success).toBe(false);
    expect(version.safeParse("2.14.2").success).toBe(false);
    expect(version.safeParse("1.14.2-unknown").success).toBe(false);
  });
  it("keeps peer routes optional and bounds them to distinct IPv4 addresses", () => {
    const peers = NodeBootstrapSpec.shape.peer_ipv4;
    expect(peers.safeParse(undefined).success).toBe(true);
    expect(peers.safeParse([[192, 0, 2, 44].join(".")]).success).toBe(true);
    expect(
      peers.safeParse(Array(2).fill([192, 0, 2, 44].join("."))).success,
    ).toBe(false);
    expect(peers.safeParse([["2001", "db8", "", "44"].join(":")]).success).toBe(
      false,
    );
    expect(
      peers.safeParse(
        Array.from({ length: 65 }, (_, index) =>
          [192, 0, 2, index + 1].join("."),
        ),
      ).success,
    ).toBe(false);
  });
  it("keeps regional configuration private and requires immutable platform sources", () => {
    const region = "region-dev";
    const kid = randomBytes(8).toString("hex");
    const configuration = {
      version: 1,
      region_id: region,
      api_host: `${randomUUID()}.invalid`,
      agent_key: `pgcf_ak_${region}_${randomBytes(32).toString("base64url")}`,
      route_keyring: JSON.stringify({
        active: kid,
        keys: { [kid]: randomBytes(32).toString("base64url") },
      }),
      tunnel_token: randomBytes(64).toString("base64url"),
      backup_s3: {
        access_key_id: randomBytes(16).toString("hex"),
        secret_access_key: randomBytes(32).toString("hex"),
      },
    };
    expect(NodePlatformConfiguration.safeParse(configuration).success).toBe(
      true,
    );
    expect(
      NodePlatformConfiguration.safeParse({
        ...configuration,
        region_id: "region-other",
      }).success,
    ).toBe(false);
    expect(
      NodePlatformConfiguration.safeParse({
        ...configuration,
        api_host: "${PGCF_API_HOST}",
      }).success,
    ).toBe(false);
    expect(
      NodePlatformConfiguration.safeParse({
        ...configuration,
        route_keyring: randomUUID(),
      }).success,
    ).toBe(false);
    const spec = {
      reviewed_commit: randomBytes(20).toString("hex"),
      regional_image: `registry-${randomBytes(4).toString("hex")}.invalid/pgcf@sha256:${randomBytes(32).toString("hex")}`,
      configuration_sha256: randomBytes(32).toString("hex"),
    };
    expect(NodePlatformSpec.safeParse(spec).success).toBe(true);
    expect(
      NodePlatformSpec.safeParse({ ...spec, regional_image: "pgcf:latest" })
        .success,
    ).toBe(false);
    expect(
      NodePlatformSpec.safeParse({ ...spec, reviewed_commit: "main" }).success,
    ).toBe(false);
    expect(
      NodePlatformSpec.safeParse({
        ...spec,
        agent_key: configuration.agent_key,
      }).success,
    ).toBe(false);
  });
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
