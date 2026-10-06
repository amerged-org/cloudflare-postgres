// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  NodeBootstrapInput,
  NodeBootstrapSpec,
  NodePlatformConfiguration,
  NodePlatformSpec,
  NodeIpv6Network,
} from "./node-bootstrap.ts";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const ProviderId = z.string().regex(/^[1-9][0-9]{0,18}$/);
export const NodeInstallationProfile = z
  .strictObject({
    version: z.literal(1),
    region_id: RegionId,
    provider_product_id: z.string().min(1).max(128),
    relay_issuer_region_id: RegionId,
    dns: NodeBootstrapSpec.shape.hardware.shape.dns,
    storage: NodeBootstrapSpec.shape.storage,
    rescue_client_private_key:
      NodeBootstrapInput.shape.rescue.shape.ssh_private_key,
    first_region: z
      .strictObject({
        cluster_name: NodeBootstrapSpec.shape.cluster_name,
        reviewed_commit: NodePlatformSpec.shape.reviewed_commit,
        regional_image: NodePlatformSpec.shape.regional_image,
        platform: NodePlatformConfiguration,
      })
      .optional(),
  })
  .superRefine((profile, context) => {
    if (
      profile.first_region &&
      profile.first_region.platform.region_id !== profile.region_id
    )
      context.addIssue({
        code: "custom",
        message: "platform region differs from installation profile",
      });
    if (new TextEncoder().encode(JSON.stringify(profile)).length > 256 * 1024)
      context.addIssue({
        code: "custom",
        message: "installation profile exceeds private input bound",
      });
  });
export type NodeInstallationProfile = z.infer<typeof NodeInstallationProfile>;
export const NodeInstallationProfileStatus = z.strictObject({
  region_id: RegionId,
  configured: z.literal(true),
  profile_sha256: Hash,
});
export const NodeInstallationBindingRequest = z.strictObject({
  expected_revision: z.number().int().positive(),
  firewall_id: z.uuid(),
});
export const NodeInstallationBindingStatus = z.strictObject({
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderId,
  profile_sha256: Hash,
  binding_sha256: Hash,
  firewall_id: z.uuid(),
  inspection_generation: z.number().int().nonnegative(),
  inspected: z.boolean(),
});
export const NodeInstallationInspection = z.strictObject({
  purpose: z.literal("pgcf-node-inspection/v1"),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  provider_instance_id: ProviderId,
  profile_sha256: Hash,
  binding_sha256: Hash,
  network_plan_sha256: Hash,
  observed_at: z.iso.datetime({ precision: 3 }),
  rescue_host_fingerprint: NodeBootstrapSpec.shape.rescue_host_fingerprint,
  hardware: NodeBootstrapSpec.shape.hardware
    .omit({ dns: true, rescue_ram_min_bytes: true })
    .safeExtend({
      ram_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      ipv6: NodeIpv6Network.safeExtend({
        gateway: z
          .ipv6()
          .refine((value) => !value.includes("%") && !value.includes(".")),
      }).optional(),
    }),
  image: NodeBootstrapSpec.shape.image,
});
export type NodeInstallationInspection = z.infer<
  typeof NodeInstallationInspection
>;
export const NodeInstallationInspectionRequest = z.strictObject({
  expected_generation: z.number().int().nonnegative(),
  inspection: NodeInstallationInspection,
});

/** Private read-only inspection input; no inferred disk, RAM or image sizes. */
export const NodeInspectionInput = z
  .strictObject({
    version: z.literal(1),
    operation_id: OperationId,
    node_id: NodeId,
    region_id: RegionId,
    provider_instance_id: ProviderId,
    profile_sha256: Hash,
    binding_sha256: Hash,
    network_plan_sha256: Hash,
    expected_generation: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    deadline_at: z.iso.datetime({ precision: 3 }),
    expected_network: NodeBootstrapSpec.shape.hardware.pick({
      mac: true,
      ipv4: true,
      prefix_length: true,
      gateway: true,
      ipv6: true,
    }),
    dns: NodeBootstrapSpec.shape.hardware.shape.dns,
    peer_ipv4: NodeBootstrapSpec.shape.peer_ipv4.unwrap(),
    rescue: NodeBootstrapInput.shape.rescue,
    callback: NodeBootstrapInput.shape.callback,
    transport_url: z.url({ protocol: /^https$/ }).max(2048),
    relay_url: z.url({ protocol: /^wss$/ }).max(2048),
  })
  .superRefine((input, context) => {
    const callback = new URL(input.callback.url),
      transport = new URL(input.transport_url),
      relay = new URL(input.relay_url);
    if (
      callback.pathname !==
        `/internal/v1/node-installation/${input.operation_id}/inspection` ||
      transport.pathname !==
        `/internal/v1/node-installation/${input.operation_id}/transport` ||
      relay.pathname !==
        `/internal/v1/node-installation/${input.operation_id}/relay` ||
      transport.origin !== callback.origin ||
      relay.origin !== callback.origin.replace(/^https:/, "wss:") ||
      [callback, transport, relay].some(
        (url) => url.username || url.password || url.search || url.hash,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Inspection endpoint identity is invalid",
      });
  });
export type NodeInspectionInput = z.infer<typeof NodeInspectionInput>;
export const NodeInspectionTransportRequest = z.strictObject({
  expected_generation: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});

function sshString(bytes: Uint8Array) {
  const result = new Uint8Array(bytes.length + 4);
  new DataView(result.buffer).setUint32(0, bytes.length);
  result.set(bytes, 4);
  return result;
}
function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
const standard64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode64url = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );

/** Generate a different controlled server host identity for each installation binding. */
export async function createNodeRescueHostIdentity(
  routes: { gateway: string; peer_ipv4: string[] } | null = null,
) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair))
    throw new Error("node_rescue_key_generation_failed");
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey),
    privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (
    !(exported instanceof ArrayBuffer) ||
    privateJwk instanceof ArrayBuffer ||
    typeof privateJwk.d !== "string"
  )
    throw new Error("node_rescue_key_generation_failed");
  const raw = new Uint8Array(exported);
  if (raw.length !== 32) throw new Error("node_rescue_key_generation_failed");
  const encoder = new TextEncoder(),
    type = encoder.encode("ssh-ed25519"),
    publicBlob = concat(sshString(type), sshString(raw)),
    check = crypto.getRandomValues(new Uint8Array(4));
  let privateBlob = concat(
    check,
    check,
    sshString(type),
    sshString(raw),
    sshString(concat(decode64url(privateJwk.d), raw)),
    sshString(new Uint8Array()),
  );
  const padding = 8 - (privateBlob.length % 8);
  privateBlob = concat(
    privateBlob,
    Uint8Array.from({ length: padding }, (_, index) => index + 1),
  );
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, 1);
  const encoded = standard64(
    concat(
      encoder.encode("openssh-key-v1\0"),
      sshString(encoder.encode("none")),
      sshString(encoder.encode("none")),
      sshString(new Uint8Array()),
      count,
      sshString(publicBlob),
      sshString(privateBlob),
    ),
  );
  const keyType = "OPENSSH PRIVATE KEY";
  const privateKey = `-----BEGIN ${keyType}-----\n${encoded.match(/.{1,70}/g)!.join("\n")}\n-----END ${keyType}-----\n`,
    publicKey = "ssh-ed25519 " + standard64(publicBlob),
    fingerprint =
      "SHA256:" +
      standard64(
        new Uint8Array(await crypto.subtle.digest("SHA-256", publicBlob)),
      ).replaceAll("=", "");
  const userData =
    "#cloud-config\n" +
    JSON.stringify({
      ssh_deletekeys: false,
      ssh_genkeytypes: [],
      ssh_keys: { ed25519_private: privateKey, ed25519_public: publicKey },
      ...(routes?.peer_ipv4.length
        ? {
            bootcmd: routes.peer_ipv4.map((peer) => [
              "ip",
              "route",
              "replace",
              `${peer}/32`,
              "via",
              routes.gateway,
            ]),
          }
        : {}),
    }) +
    "\n";
  return {
    ssh_host_key: publicKey,
    ssh_host_fingerprint: fingerprint,
    user_data: userData,
  };
}
