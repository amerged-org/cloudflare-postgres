// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { stringify } from "yaml";
import { newNodeId } from "@pgcf/contracts";
import {
  canonicalNodeProof,
  NODE_PROOF_SESSION_DOMAIN,
  type NodeProofExecutionInput,
} from "@pgcf/contracts/node-proof";
import type { NodeJoinBundle } from "@pgcf/contracts/node-bootstrap";
import { hash } from "../../../scripts/e2e/src/node-network-native.ts";
import { fixture } from "./fixture.ts";
function bundle(
  endpoint: string,
  clusterName: string,
  uid = randomUUID(),
): NodeJoinBundle {
  return {
    version: 1,
    cluster_name: clusterName,
    cluster_endpoint: endpoint,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    kube_system_uid: uid,
    talos_machine_secrets_yaml: "unit sealed material",
    talos_admin_config: "unit sealed admin",
    kubeconfig: stringify({
      apiVersion: "v1",
      kind: "Config",
      "current-context": "sealed",
      clusters: [
        {
          name: "sealed",
          cluster: {
            server: endpoint,
            "certificate-authority-data":
              Buffer.from("unit trusted CA").toString("base64"),
          },
        },
      ],
      users: [
        {
          name: "sealed",
          user: {
            "client-certificate-data": Buffer.from(
              "unit client certificate",
            ).toString("base64"),
            "client-key-data":
              Buffer.from("unit client key").toString("base64"),
          },
        },
      ],
      contexts: [
        { name: "sealed", context: { cluster: "sealed", user: "sealed" } },
      ],
    }),
  };
}
export function proofExecutionFixture(
  mode: "preparation" | "postjoin" = "preparation",
) {
  const bootstrap = fixture();
  bootstrap.spec.provider_instance_id = "17";
  bootstrap.spec.hardware.ipv6 = {
    address: "2001:db8:3::17",
    prefix_length: 64,
    gateway: "2001:db8:3::1",
  };
  bootstrap.input_hash = hash(bootstrap.spec);
  const addresses = {
    ipv4: [bootstrap.spec.hardware.ipv4],
    ipv6: [bootstrap.spec.hardware.ipv6.address],
  };
  const plan: NodeProofExecutionInput["plan"] = {
    version: 1,
    operation_id: bootstrap.spec.operation_id,
    node_id: bootstrap.spec.node_id,
    region_id: bootstrap.spec.region_id,
    provider_instance_id: bootstrap.spec.provider_instance_id,
    intent_hash: hash(randomUUID()),
    operators: { ipv4: [], ipv6: [] },
    relay: {
      provider_instance_id: "98",
      addresses: { ipv4: ["192.0.2.98"], ipv6: ["2001:db8::98"] },
    },
    scan_control: { ipv4: "192.0.2.40", ipv6: "2001:db8::40", port: 443 },
    members: [
      {
        node_id: bootstrap.spec.node_id,
        provider_instance_id: bootstrap.spec.provider_instance_id,
        firewall_id: randomUUID(),
        addresses,
        primary: addresses,
        ownership_sha256: hash(randomUUID()),
        rules: { rules: { inbound: [] } },
        rules_sha256: hash([]),
      },
    ],
  };
  const material = bundle(
      bootstrap.spec.cluster_endpoint,
      bootstrap.spec.cluster_name,
    ),
    sourceMaterial = bundle("https://203.0.113.99:6443/", "source-cluster");
  const source: NodeProofExecutionInput["source"] = {
    kind: "pod",
    node_id: newNodeId(),
    region_id: "source-region",
    provider_instance_id: "99",
    node_name: "source-node",
    node_uid: randomUUID(),
    cluster_uid: sourceMaterial.kube_system_uid,
    ipv4: "203.0.113.99",
    ipv6: "2001:db8:7::99",
    image: `fixture.invalid/regional@sha256:${hash(randomUUID())}`,
    access: { join_bundle: sourceMaterial },
  };
  const signing = generateKeyPairSync("ed25519"),
    now = Date.now();
  const claims: NodeProofExecutionInput["claims"] = {
    version: 1,
    kid: "unit",
    mode,
    session_id: randomUUID(),
    operation_id: bootstrap.spec.operation_id,
    node_id: bootstrap.spec.node_id,
    region_id: bootstrap.spec.region_id,
    provider_instance_id: bootstrap.spec.provider_instance_id,
    binding_sha256: hash(randomUUID()),
    inspection_generation: 1,
    plan_sha256: hash(plan),
    input_hash: bootstrap.input_hash,
    checkpoint_reference: mode === "postjoin" ? "sealed-checkpoint" : null,
    origin: "https://proof.invalid",
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 240_000).toISOString(),
  };
  const input: NodeProofExecutionInput = {
    claims,
    bootstrap,
    cluster_bundle: mode === "postjoin" ? material : null,
    plan,
    binding: {
      plan_sha256: hash(plan),
      readback_at: new Date(now - 1000).toISOString(),
      verification: null,
    },
    source,
    control_keys: {
      unit: signing.publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
    },
    api_base_url: claims.origin,
    session_bearer: "",
  };
  const resign = () => {
    const payload = Buffer.from(canonicalNodeProof(input.claims)).toString(
      "base64url",
    );
    input.session_bearer = `np1.${payload}.${sign(null, Buffer.from(NODE_PROOF_SESSION_DOMAIN + payload), signing.privateKey).toString("base64url")}`;
  };
  resign();
  return { input, resign, material };
}
