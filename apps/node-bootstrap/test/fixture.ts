// SPDX-License-Identifier: Apache-2.0
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type {
  NodeBootstrapAuthority,
  NodeBootstrapInput,
  NodeBootstrapSpec,
} from "@pgcf/contracts/node-bootstrap";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import {
  canonical,
  digest,
  initialCheckpoint,
  inputHash,
} from "../src/bootstrap.ts";

export function fixture(): NodeBootstrapInput {
  const address = [192, 0, 2, 17].join(".");
  const name = `cluster-${randomBytes(6).toString("hex")}`;
  const keyType = Buffer.from("ssh-ed25519");
  const publicKey = randomBytes(32);
  const blob = Buffer.alloc(4 + keyType.length + 4 + publicKey.length);
  blob.writeUInt32BE(keyType.length);
  keyType.copy(blob, 4);
  blob.writeUInt32BE(publicKey.length, 4 + keyType.length);
  publicKey.copy(blob, 8 + keyType.length);
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replaceAll("=", "")}`;
  const keyPair = generateKeyPairSync("ed25519");
  const spec: NodeBootstrapSpec = {
    version: 1,
    operation_id: newOperationId(),
    node_id: newNodeId(),
    region_id: "region-dev",
    provider_instance_id: String(Math.floor(Math.random() * 100_000) + 1),
    inventory_revision: 1,
    rescue_host_fingerprint: fingerprint,
    role: "controlplane",
    hostname: `node-${randomBytes(6).toString("hex")}`,
    hardware: {
      mac: randomBytes(6).toString("hex").match(/.{2}/g)!.join(":"),
      ipv4: address,
      prefix_length: 24,
      gateway: [192, 0, 2, 1].join("."),
      dns: [[192, 0, 2, 53].join(".")],
      install_disk: "/dev/vda",
      disk_bytes: 160 * 1024 ** 3,
      rescue_ram_min_bytes: 4 * 1024 ** 3,
    },
    image: {
      schematic_id: digest(randomBytes(32)),
      compressed_sha256: digest(randomBytes(32)),
      compressed_bytes: 512 * 1024 ** 2,
      raw_sha256: digest(randomBytes(32)),
      raw_bytes: 1024 ** 3,
      installer_digest: `sha256:${digest(randomBytes(32))}`,
    },
    storage: { ephemeral_gib: 40, lvm_gib: 96 },
    cluster_name: name,
    cluster_endpoint: `https://${address}:6443/`,
    cluster_uid: null,
    join_bundle_sha256: null,
    transport: {
      mode: "relay",
      issuer_region_id: "region-dev",
    },
  };
  return {
    spec,
    input_hash: inputHash(spec),
    callback: {
      url: `https://${randomUUID()}.invalid/internal/v1/node-bootstrap/${spec.operation_id}`,
      bearer: randomBytes(32).toString("base64url"),
    },
    rescue: {
      ssh_private_key: keyPair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      ssh_host_key: `ssh-ed25519 ${blob.toString("base64")}`,
      ssh_host_fingerprint: fingerprint,
    },
    join_bundle: null,
  };
}
export function authority(input: NodeBootstrapInput): NodeBootstrapAuthority {
  return {
    version: 1,
    operation_id: input.spec.operation_id,
    node_id: input.spec.node_id,
    region_id: input.spec.region_id,
    input_hash: input.input_hash,
    provider_instance_id: input.spec.provider_instance_id,
    inventory_revision: input.spec.inventory_revision,
    revision: 0,
    authorized: true,
    admitted: false,
    cancelled: false,
    rescue_active: true,
    admission_authorized: false,
    admission_binding: null,
    checkpoint: initialCheckpoint(),
    protected_material: null,
  };
}

export function platformFixture() {
  const input = fixture();
  const kid = randomBytes(8).toString("hex");
  const platform = {
    version: 1 as const,
    region_id: input.spec.region_id,
    api_host: `${randomUUID()}.invalid`,
    agent_key: `pgcf_ak_${input.spec.region_id}_${randomBytes(32).toString("base64url")}`,
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
  const spec = {
    ...input.spec,
    platform: {
      reviewed_commit: randomBytes(20).toString("hex"),
      regional_image: `registry-${randomBytes(4).toString("hex")}.invalid/pgcf@sha256:${randomBytes(32).toString("hex")}`,
      configuration_sha256: digest(canonical(platform)),
    },
  };
  return { ...input, spec, input_hash: inputHash(spec), platform };
}
