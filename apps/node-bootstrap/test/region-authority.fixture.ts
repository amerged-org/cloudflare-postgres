// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign } from "node:crypto";
import { stringify } from "yaml";
import type { FleetRegionMaterialRotationInput } from "@pgcf/contracts/region-material-rotation";

function der(tag: number, ...contents: Buffer[]) {
  const bytes = Buffer.concat(contents),
    length =
      bytes.length < 128
        ? Buffer.from([bytes.length])
        : bytes.length < 256
          ? Buffer.from([0x81, bytes.length])
          : Buffer.from([0x82, bytes.length >> 8, bytes.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, bytes]);
}
/** A public, throwaway test authority constructed in memory; no custody is read or written. */
export function testAuthority() {
  const pair = generateKeyPairSync("ed25519"),
    algorithm = Buffer.from("300506032b6570", "hex"),
    name = der(
      0x30,
      der(
        0x31,
        der(
          0x30,
          Buffer.from("0603550403", "hex"),
          der(0x0c, Buffer.from("test-only")),
        ),
      ),
    ),
    tbs = der(
      0x30,
      der(0xa0, der(0x02, Buffer.from([2]))),
      der(0x02, Buffer.from([1])),
      algorithm,
      name,
      der(
        0x30,
        der(0x17, Buffer.from("240101000000Z")),
        der(0x17, Buffer.from("491231235959Z")),
      ),
      name,
      pair.publicKey.export({ type: "spki", format: "der" }),
    ),
    bytes = der(
      0x30,
      tbs,
      algorithm,
      der(0x03, Buffer.from([0]), sign(null, tbs, pair.privateKey)),
    ),
    cert = `-----BEGIN CERTIFICATE-----\n${bytes
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    key = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
  return {
    cert,
    key,
    publicKey,
    encoded: {
      crt: Buffer.from(cert).toString("base64"),
      key: Buffer.from(key).toString("base64"),
    },
  };
}

/** A valid prepared rotation input whose single control-plane member is `member`; every value is test-only. */
export function rotationInputFixture(
  member = {
    region_id: "test",
    cluster_uid: "22222222-2222-4222-8222-222222222222",
    node_id: "nod_abcdefghijklmnopqrst",
    node_uid: "11111111-1111-4111-8111-111111111111",
    node_name: "node",
    address: "192.0.2.1",
  },
): FleetRegionMaterialRotationInput {
  const talos = stringify({
      context: "test",
      contexts: {
        test: {
          ca: Buffer.from("test-ca").toString("base64"),
          crt: "test-cert",
          key: "test-key",
        },
      },
    }),
    kube = JSON.stringify({
      "current-context": "test",
      contexts: [{ name: "test", context: { cluster: "test", user: "test" } }],
      clusters: [
        {
          name: "test",
          cluster: {
            server: "https://192.0.2.1:6443",
            "certificate-authority-data":
              Buffer.from("test-ca").toString("base64"),
          },
        },
      ],
      users: [
        {
          name: "test",
          user: {
            "client-certificate-data": "test-cert",
            "client-key-data": "test-key",
          },
        },
      ],
    }),
    seed = {
      version: 1 as const,
      cluster_name: "test-cluster",
      cluster_endpoint: "https://192.0.2.1:6443",
      talos_version: "1.14.1" as const,
      kubernetes_version: "1.36.3" as const,
      talos_machine_secrets_yaml: "private-test-secrets",
      talos_admin_config: talos,
    };
  return {
    rollout_id: "op_abcdefghijklmnopqrst",
    region_id: member.region_id,
    cluster_uid: member.cluster_uid,
    current_revision: 1,
    target_revision: 2,
    checkpoint: {
      revision: 1,
      phase: "trustd-token",
      node_index: 0,
      state: "pending",
    },
    current_seed: seed,
    target_seed: {
      ...seed,
      talos_machine_secrets_yaml: "replacement-test-secrets",
    },
    current_join: {
      ...seed,
      kube_system_uid: member.cluster_uid,
      kubeconfig: kube,
    },
    target_join: {
      ...seed,
      talos_machine_secrets_yaml: "replacement-test-secrets",
      kube_system_uid: member.cluster_uid,
      kubeconfig: kube,
    },
    callback: {
      url: `https://api.example.test/internal/v1/fleet-rollouts/op_abcdefghijklmnopqrst/regions/${member.region_id}/rotation`,
      bearer: "x".repeat(32),
      expires_at: new Date(Date.now() + 600000).toISOString(),
    },
    nodes: [
      {
        node_id: member.node_id,
        node_uid: member.node_uid,
        node_name: member.node_name,
        provider_instance_id: "12345",
        address: member.address,
        role: "controlplane",
        cilium_image: "quay.io/cilium/cilium@sha256:" + "a".repeat(64),
        cilium_image_id: "quay.io/cilium/cilium@sha256:" + "a".repeat(64),
      },
    ],
  };
}
