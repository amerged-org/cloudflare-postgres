// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, NodeId, OperationId } from "./ids.ts";
import { NodePhysicalStorage } from "./node-physical-storage.ts";

const Bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const StorageLvmUuid = z
  .string()
  .regex(/^[A-Za-z0-9]{6}-(?:[A-Za-z0-9]{4}-){5}[A-Za-z0-9]{6}$/);
export const ThinStorageClass = z
  .string()
  .regex(/^pgcf-lvm-thin-v1-[a-f0-9]{16}$/);
/** Immutable per-volume authority; absence on an existing database means retained thick LVM. */
export const DesiredDatabaseStorage = z
  .strictObject({
    backend: z.literal("lvm-thin-v1"),
    storage_class: ThinStorageClass,
    volume_attributes_class: ThinStorageClass,
    profile_revision: z.number().int().positive(),
    profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    node_uid: z.uuid(),
    volume_group_uuid: StorageLvmUuid,
    pool_uuid: StorageLvmUuid,
    startup_reserve_bytes: Bytes,
    write_bytes_per_second: Bytes,
    write_iops_per_second: Bytes,
    guard_seconds: z.number().int().min(1).max(120),
    drain_seconds: z.number().int().min(1).max(120),
  })
  .refine(
    (value) =>
      value.storage_class ===
        `pgcf-lvm-thin-v1-${value.profile_sha256.slice(0, 16)}` &&
      value.volume_attributes_class === value.storage_class,
    {
      message:
        "Thin storage and attributes classes must name their immutable profile",
      path: ["storage_class"],
    },
  );
export type DesiredDatabaseStorage = z.infer<typeof DesiredDatabaseStorage>;
/** The existing atomic startup reservation while its CF-owned intent is current. */
export const DesiredStorageStartup = z.strictObject({
  operation_id: OperationId,
  generation: z.number().int().positive(),
  node_uid: z.uuid(),
  budget_bytes: Bytes,
  expires_at: z.iso.datetime(),
});
export type DesiredStorageStartup = z.infer<typeof DesiredStorageStartup>;
/** Frozen physical receipt; configuration generations and lease renewals cannot replace its volume. */
export const DatabaseStorageVolumeReceipt = z.strictObject({
  storage_generation: z.number().int().positive(),
  storage_uid: z.uuid(),
  namespace_uid: z.uuid(),
  cluster_uid: z.uuid(),
  node_uid: z.uuid(),
  volume_group_uuid: StorageLvmUuid,
  pool_uuid: StorageLvmUuid,
  volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
  lv_uuid: StorageLvmUuid,
  pvc_uid: z.uuid(),
  pv_uid: z.uuid(),
});
export type DatabaseStorageVolumeReceipt = z.infer<
  typeof DatabaseStorageVolumeReceipt
>;
export const NodeStorageProtectionProof = z.strictObject({
  database_id: DatabaseId,
  generation: z.number().int().positive(),
  operation_id: OperationId.nullable(),
  storage_uid: z.uuid(),
  namespace_uid: z.uuid(),
  cluster_uid: z.uuid(),
  node_uid: z.uuid(),
  profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  requested_at: z.number().int().nonnegative(),
  hibernation_on: z.literal(true),
  pods_absent: z.literal(true),
});
export type NodeStorageProtectionProof = z.infer<
  typeof NodeStorageProtectionProof
>;

/** Explicit tested settings; no implicit rates, unbounded geometry or logical-quota debit. */
/** Contiguous block IO can touch one extra64KiB allocation chunk per operation. */
export function thinWriteExposure(writeBytes: number, writeOperations: number) {
  if (
    !Number.isSafeInteger(writeBytes) ||
    writeBytes < 0 ||
    !Number.isSafeInteger(writeOperations) ||
    writeOperations < 0
  )
    throw new Error("invalid_thin_write_exposure");
  const chunks = Math.ceil(writeBytes / 65536) + writeOperations;
  const data_bytes = chunks * 65536,
    metadata_bytes = 4 * Math.ceil(chunks / 126) * 4096;
  if (
    !Number.isSafeInteger(data_bytes) ||
    !Number.isSafeInteger(metadata_bytes)
  )
    throw new Error("unbounded_thin_write_exposure");
  return { chunks, data_bytes, metadata_bytes };
}

export const ThinStorageProfile = z
  .strictObject({
    version: z.literal(1),
    driver_image: z
      .string()
      .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
    initial_data_bytes: Bytes,
    growth_bytes: Bytes,
    maximum_data_bytes: Bytes,
    metadata_bytes: Bytes.max(16 * 1024 ** 3),
    vg_reserve_bytes: Bytes,
    data_reserve_bytes: Bytes,
    metadata_reserve_bytes: Bytes,
    startup_reserve_bytes: Bytes,
    write_bytes_per_second: Bytes,
    write_iops_per_second: Bytes,
    guard_seconds: z.number().int().min(1).max(120),
    drain_seconds: z.number().int().min(1).max(120),
    maximum_volumes: z.number().int().min(1).max(4096),
    maximum_quota_gib: z.number().int().min(1).max(1048576),
  })
  .superRefine((value, context) => {
    if (
      value.initial_data_bytes > value.maximum_data_bytes ||
      value.growth_bytes > value.maximum_data_bytes ||
      value.data_reserve_bytes >= value.initial_data_bytes ||
      value.metadata_reserve_bytes >= value.metadata_bytes
    )
      context.addIssue({
        code: "custom",
        message: "Thin pool geometry cannot preserve its safety margins",
      });
    if (
      !Number.isSafeInteger(value.maximum_quota_gib * 1024 ** 3) ||
      value.maximum_quota_gib * 1024 ** 3 >
        value.maximum_data_bytes - value.data_reserve_bytes
    )
      context.addIssue({
        code: "custom",
        message: "One database quota cannot consume the complete physical pool",
      });
    // Pinned thin_metadata_size1.1.0 estimates 50%-resident 126-entry mapping leaves.
    // Four times that estimate plus a separate safety reserve covers pool geometry;
    // actual metadata/full/drain qualification remains mandatory before selection.
    const metadataFloor =
      thinMetadataEstimateBytes(
        value.maximum_data_bytes,
        value.maximum_volumes,
      ) *
        4 +
      value.metadata_reserve_bytes;
    if (
      !Number.isSafeInteger(metadataFloor) ||
      value.metadata_bytes < metadataFloor
    )
      context.addIssue({
        code: "custom",
        message:
          "Thin metadata does not cover configured physical pool and volume count",
      });
    let exposure = Number.MAX_SAFE_INTEGER;
    try {
      exposure = thinWriteExposure(
        value.write_bytes_per_second *
          (value.guard_seconds + value.drain_seconds),
        value.write_iops_per_second *
          (value.guard_seconds + value.drain_seconds),
      ).data_bytes;
    } catch {
      /* The geometry issue below closes an overflowing bound. */
    }
    const initialPeak =
      value.startup_reserve_bytes + exposure + value.data_reserve_bytes;
    if (
      !Number.isSafeInteger(initialPeak) ||
      initialPeak > value.initial_data_bytes
    )
      context.addIssue({
        code: "custom",
        message: "Thin pool cannot cover one bounded startup and write guard",
      });
  });
export type ThinStorageProfile = z.infer<typeof ThinStorageProfile>;

export function thinMetadataEstimateBytes(
  dataBytes: number,
  volumes: number,
): number {
  if (
    !Number.isSafeInteger(dataBytes) ||
    dataBytes <= 0 ||
    !Number.isSafeInteger(volumes) ||
    volumes <= 0
  )
    throw new Error("invalid_thin_metadata_geometry");
  return (1 + Math.ceil(Math.ceil(dataBytes / 65536) / 126) + volumes) * 4096;
}

export function thinStorageClass(profileSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(profileSha256))
    throw new Error("invalid_thin_profile_hash");
  return `pgcf-lvm-thin-v1-${profileSha256.slice(0, 16)}`;
}

export function thinStorageClassObject(
  profile: ThinStorageProfile,
  profileSha256: string,
) {
  ThinStorageProfile.parse(profile);
  return {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: {
      name: thinStorageClass(profileSha256),
      labels: {
        "pgcf.io/storage-profile": profileSha256.slice(0, 63),
        "pgcf.io/storage-backend": "lvm-thin-v1",
      },
      annotations: { "pgcf.io/storage-profile-sha256": profileSha256 },
    },
    provisioner: "local.csi.openebs.io",
    parameters: {
      storage: "lvm",
      vgpattern: "^pgcf$",
      thinProvision: "yes",
      fsType: "ext4",
      // OpenEBS1.10.1 passes this supported SC parameter to mkfs before publishing the volume.
      formatoptions: "-E lazy_itable_init=0,lazy_journal_init=0",
    },
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
    reclaimPolicy: "Retain",
  };
}

/** OpenEBS1.10.1 consumes these exact case-sensitive VAC keys, never arbitrary SC keys. */
export function thinVolumeAttributesClassObject(
  profile: ThinStorageProfile,
  profileSha256: string,
) {
  const value = ThinStorageProfile.parse(profile);
  return {
    apiVersion: "storage.k8s.io/v1",
    kind: "VolumeAttributesClass",
    metadata: {
      name: thinStorageClass(profileSha256),
      annotations: { "pgcf.io/storage-profile-sha256": profileSha256 },
    },
    driverName: "local.csi.openebs.io",
    parameters: {
      qosBandwithWritePerSec: String(value.write_bytes_per_second),
      qosIopsWriteLimit: String(value.write_iops_per_second),
    },
  };
}

export const NodeThinStorageAuthority = z
  .strictObject({
    node_id: NodeId,
    name: z
      .string()
      .max(253)
      .regex(
        /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
      ),
    node_uid: z.uuid(),
    cluster_uid: z.uuid(),
    revision: z.number().int().positive(),
    profile_revision: z.number().int().positive(),
    profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    storage_class: ThinStorageClass,
    volume_group_uuid: StorageLvmUuid,
    pool_uuid: StorageLvmUuid.nullable(),
    driver_pod_uid: z.uuid(),
    driver_image: z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
    /** CF read-start lower bound; captured_at is Native wall-clock audit metadata only. */
    observed_at: z.iso.datetime(),
    captured_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    write_allowed: z.boolean(),
    physical: NodePhysicalStorage,
    /** Complete fresh VG inventory, including internal and unknown LVs; absence is physical evidence. */
    physical_lvs: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Za-z0-9_.+[\]-]{1,128}$/),
          lv_uuid: StorageLvmUuid,
          size_bytes: Bytes,
          segtype: z.string().regex(/^[a-z0-9-]{1,32}$/),
        }),
      )
      .max(8192),
    active_lv_uuids: z.array(StorageLvmUuid).max(8192),
    data_accounting_complete: z.boolean(),
    protections: z.array(NodeStorageProtectionProof).max(4096),
    volumes: z
      .array(
        z.strictObject({
          database_id: DatabaseId,
          generation: z.number().int().positive(),
          storage_generation: z.number().int().positive(),
          storage_uid: z.uuid(),
          namespace_uid: z.uuid(),
          cluster_uid: z.uuid(),
          volume_handle: z.string().regex(/^pvc-[a-f0-9-]{36}$/),
          lv_uuid: StorageLvmUuid,
          pvc_uid: z.uuid(),
          pv_uid: z.uuid(),
          storage_class: z.union([z.literal("pgcf-lvm"), ThinStorageClass]),
          volume_attributes_class: ThinStorageClass.nullable(),
          quiesced: z.boolean().optional(),
          io: z
            .array(
              z.strictObject({
                pod_uid: z.uuid(),
                write_bytes_per_second: Bytes,
                write_iops_per_second: Bytes,
              }),
            )
            .max(8),
        }),
      )
      .max(4096),
  })
  .superRefine((value, context) => {
    if (
      value.physical.volume_group_uuid !== value.volume_group_uuid ||
      (value.pool_uuid === null) !== (value.physical.thin_pool === null)
    )
      context.addIssue({
        code: "custom",
        message: "Host authority and physical pool identities differ",
      });
    const start = Date.parse(value.observed_at),
      end = Date.parse(value.expires_at);
    if (
      end <= start ||
      end - start > 120000 ||
      (value.write_allowed && value.pool_uuid === null)
    )
      context.addIssue({
        code: "custom",
        message: "Host storage authority is unbounded or has no physical pool",
      });
  });
export type NodeThinStorageAuthority = z.infer<typeof NodeThinStorageAuthority>;

export function thinStorageAuthorityMatches(
  storage: DesiredDatabaseStorage,
  authority: NodeThinStorageAuthority | null | undefined,
  nodeName?: string,
  now = Date.now(),
  requireWrite = true,
): boolean {
  return Boolean(
    authority &&
    (!requireWrite ||
      (authority.write_allowed && authority.data_accounting_complete)) &&
    authority.pool_uuid &&
    authority.node_uid === storage.node_uid &&
    authority.volume_group_uuid === storage.volume_group_uuid &&
    authority.pool_uuid === storage.pool_uuid &&
    authority.profile_sha256 === storage.profile_sha256 &&
    authority.profile_revision >= storage.profile_revision &&
    authority.storage_class === storage.storage_class &&
    (nodeName === undefined || authority.name === nodeName) &&
    Number.isSafeInteger(now) &&
    Date.parse(authority.observed_at) <= now + 5000 &&
    Date.parse(authority.observed_at) >= now - 120000 &&
    Date.parse(authority.expires_at) > now &&
    Date.parse(authority.expires_at) - Date.parse(authority.observed_at) <=
      storage.guard_seconds * 1000,
  );
}

/** A completed deletion may remove the last pool; never infer LV absence from an ordinary agent report. */
export function thinStorageVolumeReclaimed(
  storage: DesiredDatabaseStorage,
  authority: NodeThinStorageAuthority | null | undefined,
  lvUuid: string,
  observedAfter: number,
  now = Date.now(),
): boolean {
  return Boolean(
    authority &&
    authority.data_accounting_complete &&
    authority.node_uid === storage.node_uid &&
    authority.volume_group_uuid === storage.volume_group_uuid &&
    authority.profile_sha256 === storage.profile_sha256 &&
    authority.profile_revision >= storage.profile_revision &&
    Date.parse(authority.observed_at) > observedAfter &&
    Date.parse(authority.observed_at) >= now - 120000 &&
    Date.parse(authority.observed_at) <= now + 5000 &&
    Date.parse(authority.expires_at) > now &&
    !authority.physical_lvs.some((lv) => lv.lv_uuid === lvUuid) &&
    !authority.active_lv_uuids.includes(lvUuid),
  );
}
