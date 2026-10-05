// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { bytesToHex, newAgentKey, randomString } from "@pgcf/contracts";
import { NodePlatformConfiguration } from "@pgcf/contracts/node-bootstrap";
import { bootstrapPlatformHash } from "../../src/crypto/bootstrap-tickets.ts";
import { NodeBootstrapConfiguration } from "../../src/domain/bootstrap-jobs.ts";
import {
  configureNodeRegionPolicy,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { fixture } from "./fixtures.ts";

const hash = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const standard64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export async function generateRescueHostIdentity() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("test_key_pair_invalid");
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey),
    privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (
    !(publicKey instanceof ArrayBuffer) ||
    !(privateKey instanceof ArrayBuffer)
  )
    throw new Error("test_key_export_invalid");
  const blob = new Uint8Array(51),
    view = new DataView(blob.buffer);
  view.setUint32(0, 11);
  blob.set(new TextEncoder().encode("ssh-ed25519"), 4);
  view.setUint32(15, 32);
  blob.set(new Uint8Array(publicKey), 19);
  return {
    ssh_private_key: `-----BEGIN PRIVATE KEY-----\n${standard64(new Uint8Array(privateKey))}\n-----END PRIVATE KEY-----`,
    ssh_host_key: "ssh-ed25519 " + standard64(blob),
    ssh_host_fingerprint:
      "SHA256:" +
      standard64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", blob)),
      ).replaceAll("=", ""),
  };
}
export async function auditedRescueConfiguration() {
  const f = await fixture(),
    providerId = "1" + randomString("0123456789", 9);
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.node).run();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
    purchases_enabled: false,
    order: null,
  });
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      region_id: f.region,
      mode: "adopt",
      provider_instance_id: providerId,
    },
  });
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: providerId,
      request_id: null,
      reference: crypto.randomUUID(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: providerId,
      provider_region: "EU",
      product_id: crypto.randomUUID(),
      image_id: crypto.randomUUID(),
      reference: crypto.randomUUID(),
      observed_at: new Date().toISOString(),
    },
  );
  const rescue = await generateRescueHostIdentity(),
    platform = NodePlatformConfiguration.parse({
      version: 1,
      region_id: f.region,
      api_host: "api.invalid",
      agent_key: newAgentKey(f.region),
      route_keyring: env.ROUTE_MASTER_KEYS,
      tunnel_token: randomString("abcdefghijklmnopqrstuvwxyz0123456789", 64),
      backup_s3: {
        access_key_id: randomString("abcdefghijklmnopqrstuvwxyz0123456789", 32),
        secret_access_key: randomString(
          "abcdefghijklmnopqrstuvwxyz0123456789",
          64,
        ),
      },
    }),
    body = NodeBootstrapConfiguration.parse({
      expected_revision: addition.revision,
      spec: {
        version: 1,
        operation_id: addition.intent.operation_id,
        node_id: addition.intent.node_id,
        region_id: f.region,
        provider_instance_id: providerId,
        inventory_revision: addition.revision,
        rescue_host_fingerprint: rescue.ssh_host_fingerprint,
        role: "controlplane",
        hostname: addition.intent.requested_hostname,
        hardware: {
          mac: Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(":"),
          ipv4: "192.0.2.17",
          prefix_length: 24,
          gateway: "192.0.2.1",
          dns: ["192.0.2.1"],
          install_disk: "/dev/sda",
          disk_bytes: 64 * 2 ** 30,
          rescue_ram_min_bytes: 2 ** 30,
        },
        image: {
          schematic_id: hash(),
          compressed_sha256: hash(),
          compressed_bytes: 512,
          raw_sha256: hash(),
          raw_bytes: 1024,
          installer_digest: "sha256:" + hash(),
        },
        storage: { ephemeral_gib: 4, lvm_gib: 8 },
        cluster_name:
          "cluster-" + randomString("abcdefghijklmnopqrstuvwxyz", 8),
        cluster_endpoint: "https://192.0.2.17:6443",
        cluster_uid: null,
        join_bundle_sha256: null,
        platform: {
          reviewed_commit: bytesToHex(
            crypto.getRandomValues(new Uint8Array(20)),
          ),
          regional_image: "registry.invalid/pgcf@sha256:" + hash(),
          configuration_sha256: await bootstrapPlatformHash(platform),
        },
        transport: { mode: "relay", issuer_region_id: f.region },
      },
      rescue,
      platform,
    });
  const entry = {
    ssh_host_key: rescue.ssh_host_key,
    ssh_host_fingerprint: rescue.ssh_host_fingerprint,
    user_data: "#cloud-config\n",
  };
  return { fixture: f, addition, body, entry, providerId };
}
