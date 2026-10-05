// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import { parseRouteKeyring } from "./route-token.ts";

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const PrivateText = z
  .string()
  .min(1)
  .max(256 * 1024);
const PositiveBytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    z.ipv4().safeParse(url.hostname).success &&
    url.port === "6443" &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
});

export const NodePlatformSpec = z.strictObject({
  reviewed_commit: z.string().regex(/^[a-f0-9]{40}$/),
  regional_image: z
    .string()
    .max(512)
    .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  configuration_sha256: Digest,
});
export type NodePlatformSpec = z.infer<typeof NodePlatformSpec>;
const RegionalCredential = z
  .string()
  .min(16)
  .max(4096)
  .refine(
    (value) => !/\s/.test(value) && !value.includes(String.fromCharCode(0)),
  );
export const NodePlatformConfiguration = z
  .strictObject({
    version: z.literal(1),
    region_id: RegionId,
    api_host: z
      .string()
      .max(253)
      .regex(
        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
      ),
    agent_key: RegionalCredential,
    route_keyring: z
      .string()
      .min(1)
      .max(16 * 1024)
      .refine((value) => {
        try {
          parseRouteKeyring(value);
          return true;
        } catch {
          return false;
        }
      }),
    tunnel_token: RegionalCredential,
    backup_s3: z.strictObject({
      access_key_id: RegionalCredential,
      secret_access_key: RegionalCredential,
    }),
  })
  .refine(
    (value) =>
      new RegExp(`^pgcf_ak_${value.region_id}_[A-Za-z0-9_-]{43}$`).test(
        value.agent_key,
      ),
    "regional agent identity mismatch",
  );
export type NodePlatformConfiguration = z.infer<
  typeof NodePlatformConfiguration
>;

export const NodeBootstrapSpec = z
  .strictObject({
    version: z.literal(1),
    operation_id: OperationId,
    node_id: NodeId,
    region_id: RegionId,
    provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
    inventory_revision: z.number().int().positive(),
    rescue_host_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
    role: z.enum(["worker", "controlplane"]),
    hostname: z.string().regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/),
    peer_ipv4: z
      .array(z.ipv4())
      .max(64)
      .refine(
        (peers) => new Set(peers).size === peers.length,
        "peer addresses must be distinct",
      )
      .optional(),
    hardware: z.strictObject({
      mac: z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/),
      ipv4: z.ipv4(),
      prefix_length: z.number().int().min(1).max(32),
      gateway: z.ipv4(),
      dns: z.array(z.ipv4()).min(1).max(3),
      install_disk: z
        .string()
        .regex(/^\/dev\/(?:[sv]d[a-z]|nvme[0-9]+n[0-9]+)$/),
      disk_bytes: PositiveBytes,
      rescue_ram_min_bytes: PositiveBytes,
    }),
    image: z.strictObject({
      schematic_id: Digest,
      compressed_sha256: Digest,
      compressed_bytes: PositiveBytes,
      raw_sha256: Digest,
      raw_bytes: PositiveBytes.refine((value) => value % 512 === 0),
      installer_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    }),
    storage: z.strictObject({
      ephemeral_gib: z.number().int().min(4).max(1024),
      lvm_gib: z.number().int().positive().max(100_000),
    }),
    cluster_name: z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/),
    cluster_endpoint: Endpoint,
    cluster_uid: z.string().min(1).max(128).nullable(),
    join_bundle_sha256: Digest.nullable(),
    platform: NodePlatformSpec.optional(),
    transport: z.discriminatedUnion("mode", [
      z.strictObject({
        mode: z.literal("relay"),
        issuer_region_id: RegionId,
      }),
      z.strictObject({
        mode: z.literal("operator_direct"),
        authorization_id: z.uuid(),
      }),
    ]),
  })
  .superRefine((value, context) => {
    if (value.peer_ipv4?.includes(value.hardware.ipv4)) {
      context.addIssue({
        code: "custom",
        message: "peer routes cannot include the node's own address",
      });
    }
    if (value.role === "worker" && value.platform) {
      context.addIssue({
        code: "custom",
        message: "workers join an existing platform",
      });
    }
    if (
      value.role === "worker" &&
      (!value.cluster_uid || !value.join_bundle_sha256)
    ) {
      context.addIssue({
        code: "custom",
        message: "worker requires a protected cluster identity",
      });
    }
    if (value.image.raw_bytes >= value.hardware.disk_bytes) {
      context.addIssue({
        code: "custom",
        message: "image does not fit target disk",
      });
    }
    if (
      (value.storage.ephemeral_gib + value.storage.lvm_gib + 2) * 1024 ** 3 >
      value.hardware.disk_bytes
    ) {
      context.addIssue({
        code: "custom",
        message: "volumes do not fit target disk",
      });
    }
    if (
      value.hardware.rescue_ram_min_bytes <
      value.image.compressed_bytes + value.image.raw_bytes + 512 * 1024 ** 2
    ) {
      context.addIssue({
        code: "custom",
        message: "rescue RAM cannot hold verified image",
      });
    }
  });
export type NodeBootstrapSpec = z.infer<typeof NodeBootstrapSpec>;

const ClusterMaterial = {
  version: z.literal(1),
  cluster_name: z.string().min(1).max(63),
  cluster_endpoint: Endpoint,
  talos_version: z.literal("1.14.1"),
  kubernetes_version: z.literal("1.36.3"),
  talos_machine_secrets_yaml: PrivateText,
  talos_admin_config: PrivateText,
};
const materialWithinLimit = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length <= 256 * 1024;
export const NodeRegionSeed = z
  .strictObject(ClusterMaterial)
  .refine(materialWithinLimit, "cluster material exceeds 256 KiB");
export type NodeRegionSeed = z.infer<typeof NodeRegionSeed>;
export const NodeJoinBundle = z
  .strictObject({
    ...ClusterMaterial,
    kube_system_uid: z.string().min(1).max(128),
    kubeconfig: PrivateText,
  })
  .refine(materialWithinLimit, "cluster material exceeds 256 KiB");
export type NodeJoinBundle = z.infer<typeof NodeJoinBundle>;
export const NodeBootstrapMaterial = z.discriminatedUnion("purpose", [
  z.strictObject({
    purpose: z.literal("region_seed"),
    material: NodeRegionSeed,
  }),
  z.strictObject({
    purpose: z.literal("join_bundle"),
    material: NodeJoinBundle,
  }),
]);
export type NodeBootstrapMaterial = z.infer<typeof NodeBootstrapMaterial>;

export const NodeBootstrapInput = z.strictObject({
  spec: NodeBootstrapSpec,
  input_hash: Digest,
  callback: z.strictObject({
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    bearer: z.string().min(32).max(4096),
  }),
  rescue: z.strictObject({
    ssh_private_key: PrivateText,
    ssh_host_key: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/),
    ssh_host_fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  }),
  join_bundle: NodeJoinBundle.nullable(),
  platform: NodePlatformConfiguration.optional(),
});
export type NodeBootstrapInput = z.infer<typeof NodeBootstrapInput>;

export const NodeBootstrapAdmissionBinding = z.strictObject({
  checkpoint_revision: z.number().int().nonnegative(),
  node_uid: z.string().min(1).max(128),
  resource_version: z.string().regex(/^[0-9]+$/),
  kube_system_uid: z.string().min(1).max(128),
  quarantine: z.strictObject({
    key: z.literal("pgcf.io/quarantine"),
    value: z.literal("bootstrap"),
    effect: z.literal("NoSchedule"),
  }),
});
export type NodeBootstrapAdmissionBinding = z.infer<
  typeof NodeBootstrapAdmissionBinding
>;
export const NodeBootstrapAdmissionReceipt = z.strictObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  input_hash: Digest,
  checkpoint_revision: z.number().int().nonnegative(),
  node_uid: z.string().min(1).max(128),
  kube_system_uid: z.string().min(1).max(128),
  previous_resource_version: z.string().regex(/^[0-9]+$/),
  resource_version: z.string().regex(/^[0-9]+$/),
  quarantine_removed: z.literal(true),
});
export type NodeBootstrapAdmissionReceipt = z.infer<
  typeof NodeBootstrapAdmissionReceipt
>;

export const NodeBootstrapStage = z.enum([
  "created",
  "rescue_verified",
  "image_verified",
  "disk_write_intent",
  "disk_written",
  "gpt_relocation_intent",
  "gpt_relocated",
  "rescue_reboot_intent",
  "talos_maintenance",
  "config_prepared",
  "config_apply_intent",
  "config_applied",
  "talos_reboot_intent",
  "talos_authenticated",
  "kubernetes_bootstrap_intent",
  "kubernetes_joined",
  "cilium_install_intent",
  "cilium_installed",
  "flux_install_intent",
  "flux_installed",
  "platform_sync_intent",
  "platform_ready",
  "regional_install_intent",
  "regional_ready",
  "awaiting_verification",
  "quarantine_release_intent",
  "quarantine_released",
]);
export type NodeBootstrapStage = z.infer<typeof NodeBootstrapStage>;

export const NodeBootstrapCheckpoint = z.strictObject({
  stage: NodeBootstrapStage,
  status: z.enum([
    "running",
    "waiting",
    "failed",
    "cancelled",
    "awaiting_verification",
    "released",
  ]),
  downloaded_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  written_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  write_intent_offset: z.number().int().nonnegative().nullable(),
  destructive_intent: z.boolean(),
  sealed_ref: z.string().min(1).max(128).nullable(),
  pre_reboot_boot_id: z.uuid().nullable(),
  release_node_uid: z.string().min(1).max(128).nullable(),
  release_resource_version: z
    .string()
    .regex(/^[0-9]+$/)
    .nullable(),
  admission_receipt: NodeBootstrapAdmissionReceipt.nullable(),
  error_code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .nullable(),
});
export type NodeBootstrapCheckpoint = z.infer<typeof NodeBootstrapCheckpoint>;

const Identity = {
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  input_hash: Digest,
  request_id: z.uuid(),
};
export const BootstrapCapability = z.enum([
  "rescue_ssh",
  "talos_api",
  "kubernetes_api",
]);
export type BootstrapCapability = z.infer<typeof BootstrapCapability>;

export const NodeBootstrapCallback = z.discriminatedUnion("kind", [
  z.strictObject({ ...Identity, kind: z.literal("read") }),
  z.strictObject({
    ...Identity,
    kind: z.literal("checkpoint"),
    expected_revision: z.number().int().nonnegative(),
    payload: NodeBootstrapCheckpoint,
  }),
  z.strictObject({
    ...Identity,
    kind: z.literal("seal"),
    expected_revision: z.number().int().nonnegative(),
    payload: NodeBootstrapMaterial,
  }),
  z.strictObject({
    ...Identity,
    kind: z.literal("transport"),
    payload: z.strictObject({
      capability: BootstrapCapability,
    }),
  }),
]);
export type NodeBootstrapCallback = z.infer<typeof NodeBootstrapCallback>;

export const NodeBootstrapAuthority = z.strictObject({
  version: z.literal(1),
  operation_id: OperationId,
  node_id: NodeId,
  region_id: RegionId,
  input_hash: Digest,
  provider_instance_id: z.string().regex(/^[1-9][0-9]*$/),
  inventory_revision: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  authorized: z.boolean(),
  admitted: z.boolean(),
  cancelled: z.boolean(),
  rescue_active: z.boolean(),
  admission_authorized: z.boolean(),
  admission_binding: NodeBootstrapAdmissionBinding.nullable(),
  checkpoint: NodeBootstrapCheckpoint,
  protected_material: NodeBootstrapMaterial.nullable(),
});
export type NodeBootstrapAuthority = z.infer<typeof NodeBootstrapAuthority>;

export const NodeBootstrapTransport = z.strictObject({
  websocket_url: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "wss:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  token: z.string().min(32).max(4096),
  expectedTarget: z.strictObject({
    ip: z.ipv4(),
    port: z.union([z.literal(22), z.literal(50000), z.literal(6443)]),
  }),
});
export type NodeBootstrapTransport = z.infer<typeof NodeBootstrapTransport>;

export const NodeBootstrapStatus = z.strictObject({
  operation_id: OperationId,
  input_hash: Digest,
  revision: z.number().int().nonnegative(),
  checkpoint: NodeBootstrapCheckpoint,
});
export type NodeBootstrapStatus = z.infer<typeof NodeBootstrapStatus>;
