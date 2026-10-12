// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeHostConfigurationPrivate } from "./node-host-configuration.ts";
import { DatabaseId, NodeId, OperationId, RegionId } from "./ids.ts";
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  DesiredStorageStartup,
  NodeThinStorageAuthority,
  StorageLvmUuid,
  ThinStorageProfile,
} from "./database-storage.ts";
import { NodePhysicalStorage } from "./node-physical-storage.ts";
import { STORAGE_AUTHORITY_MAX_LENGTH } from "./storage-write-authority.ts";

const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const NodeName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
export const NodeThinStorageSelection = z.strictObject({
  expected_revision: z.number().int().nonnegative(),
  node_uid: z.uuid(),
  address: z.union([z.ipv4(), z.ipv6()]),
  volume_group_uuid: StorageLvmUuid,
  profile: ThinStorageProfile,
  allow_new_databases: z.boolean(),
});
export type NodeThinStorageSelection = z.infer<typeof NodeThinStorageSelection>;
export const NodeThinStorageState = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  region_id: RegionId,
  revision: z.number().int().positive(),
  profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  profile: ThinStorageProfile,
  allow_new_databases: z.boolean(),
  status: z.enum(["selected", "qualifying", "ready", "blocked"]),
  error_code: z.string().max(128).nullable(),
  updated_at: z.iso.datetime(),
});
export type NodeThinStorageState = z.infer<typeof NodeThinStorageState>;

/** One current absolute-size LVM action, acknowledged before dispatch; no generic command interface. */
export const NodeThinPoolAction = z
  .strictObject({
    kind: z.enum(["initialize", "grow"]),
    state: z.enum(["pending", "dispatched"]),
    nonce: OperationId,
    target_data_bytes: Bytes.positive(),
    target_metadata_bytes: Bytes.positive(),
    expected_pool_uuid: StorageLvmUuid.nullable(),
    driver_pod_uid: z.uuid().nullable(),
    boot_id: z.uuid().nullable(),
    dispatched_at: z.iso.datetime().nullable(),
    deadline_at: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.kind === "initialize") !== (value.expected_pool_uuid === null))
      context.addIssue({
        code: "custom",
        message: "Pool initialization cannot adopt an existing pool",
      });
    if (
      value.state === "dispatched" &&
      (!value.driver_pod_uid ||
        !value.boot_id ||
        !value.dispatched_at ||
        !value.deadline_at)
    )
      context.addIssue({
        code: "custom",
        message:
          "A dispatched pool action requires its physical execution identity",
      });
  });
export type NodeThinPoolAction = z.infer<typeof NodeThinPoolAction>;

export const NodeThinStorageLease = z.strictObject({
  operation_id: OperationId,
  release_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/),
  spec_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  assignment_revision: z.number().int().positive(),
  region_revision: z.number().int().positive(),
  revision: z.number().int().positive(),
  /** Revision of the current identity proof; the report's authority claims the next one. Fast
   * renewals advance the composed authority's revision, never this one. */
  authority_revision: z.number().int().nonnegative(),
  node_id: NodeId,
  region_id: RegionId,
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  name: NodeName,
  provider_instance_id: z.string().min(1).max(128),
  address: z.union([z.ipv4(), z.ipv6()]),
  volume_group_uuid: StorageLvmUuid,
  pool_uuid: StorageLvmUuid.nullable(),
  profile_revision: z.number().int().positive(),
  profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  profile: ThinStorageProfile,
  material_revision: z.number().int().positive(),
  kernel_version: z.string().max(128).nullable(),
  boot_id: z.uuid(),
  /** The completed patch's proved configuration boot; witnesses a STATE-loaded `boot_id`. */
  configuration_boot_id: z.uuid().nullable(),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  required_data_free_bytes: Bytes,
  required_metadata_free_bytes: Bytes,
  action: NodeThinPoolAction.nullable(),
  databases: z
    .array(
      z.strictObject({
        id: DatabaseId,
        generation: z.number().int().positive(),
        storage_generation: z.number().int().positive(),
        desired_state: z.enum(["running", "suspended", "deleted"]),
        archive_path: z.string().min(1).max(2048),
        power_operation: OperationId.nullable(),
        stop_operation: z
          .strictObject({
            operation_id: OperationId,
            kind: z.enum([
              "database.suspend",
              "database.hibernate",
              "database.delete",
            ]),
            generation: z.number().int().positive(),
          })
          .nullable()
          .optional(),
        storage: DesiredDatabaseStorage.nullable(),
        volume: DatabaseStorageVolumeReceipt.nullable(),
        startup: DesiredStorageStartup.nullable(),
      }),
    )
    .max(4096),
});
export type NodeThinStorageLease = z.infer<typeof NodeThinStorageLease>;

/** Private sealed custody is supplied only to the existing high-trust Native executor. */
export const NodeThinStorageInput = z.strictObject({
  lease: NodeThinStorageLease,
  class_creation_allowed: z.boolean(),
  host_extension: z.strictObject({
    image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
    version: z.string().max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  host_configuration: NodeHostConfigurationPrivate,
  cluster_endpoint: z.url(),
  talos_admin_config: z
    .string()
    .min(1)
    .max(256 * 1024),
  kubeconfig: z
    .string()
    .min(1)
    .max(256 * 1024),
  callback: z.strictObject({
    url: z.url(),
    bearer: z.string().min(32).max(128),
  }),
});
export type NodeThinStorageInput = z.infer<typeof NodeThinStorageInput>;

export const NodeThinStorageReport = z.strictObject({
  expected_revision: z.number().int().positive(),
  authority: NodeThinStorageAuthority,
  boot_id: z.uuid(),
  system_uuid: z.uuid(),
  software: z.strictObject({
    kernel_version: z.string().max(128),
    host_extension_image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
    host_configuration_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    driver_image_id: z.string().max(1024),
    driver_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    lvm_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    tools_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    thin_tools_version: z.string().max(32).nullable(),
    thin_module_live: z.boolean(),
    cgroup_host_view: z.boolean(),
  }),
  pool_tag: z.string().max(128).nullable(),
  action_applied: z.boolean(),
});
export type NodeThinStorageReport = z.infer<typeof NodeThinStorageReport>;

/** 128 random bits Cloudflare issues, with its own clock, for exactly one sample of one node. */
export const ThinStorageSampleNonce = z.string().regex(/^[a-f0-9]{32}$/);
/** guard_seconds × 200 ms for guards of 1 to 120 s. */
const SamplePeriod = z.number().int().min(200).max(24_000);
/** One node whose controller samples the OpenEBS exporter for Cloudflare. A qualification run's
 * node samples into the run's evidence and renews nothing. */
export const ThinStorageSampleTarget = z.strictObject({
  node_id: NodeId,
  name: NodeName,
  node_uid: z.uuid(),
  period_milliseconds: SamplePeriod,
  qualification_run: OperationId.nullable(),
});
export type ThinStorageSampleTarget = z.infer<typeof ThinStorageSampleTarget>;

/** POST /agent/v1/nodes/{id}/storage-headroom: one complete exporter scrape between two identical
 * identity reads. Cloudflare anchors any renewal at its nonce's issue, never at captured_at. */
export const NodeStorageHeadroomSample = z
  .strictObject({
    /** The previous response's nonce; null only asks for a first one and renews nothing. */
    nonce: ThinStorageSampleNonce.nullable(),
    node_uid: z.uuid(),
    /** Controller wall clock; audit data only. */
    captured_at: z.iso.datetime(),
    physical: NodePhysicalStorage,
    /** Every LV series the exporter reported for VG pgcf (no UUIDs; internal LVs are not listed). */
    lvs: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Za-z0-9_.+[\]-]{1,128}$/),
          segtype: z.string().regex(/^[a-z0-9-]{1,32}$/),
          size_bytes: Bytes.positive(),
        }),
      )
      .max(8192),
    /** The exporter's LV count of VG pgcf; a scrape missing any LV series is not a sample. */
    lv_count: z.number().int().nonnegative().max(8192),
    /** Identities read around the scrape that bind it to Cloudflare's identity proof. */
    witnesses: z.strictObject({
      cluster_uid: z.uuid(),
      boot_id: z.uuid(),
      volume_group_uuid: StorageLvmUuid,
      driver_pod_uid: z.uuid(),
      driver_image: z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
    }),
    scrape_milliseconds: z.number().int().nonnegative().max(600_000),
  })
  .superRefine((value, context) => {
    if (
      value.lvs.length !== value.lv_count ||
      new Set(value.lvs.map((lv) => lv.name)).size !== value.lvs.length ||
      value.physical.volume_group_uuid !== value.witnesses.volume_group_uuid
    )
      context.addIssue({
        code: "custom",
        message:
          "A sample is one complete scrape of the witnessed volume group",
      });
  });
export type NodeStorageHeadroomSample = z.infer<
  typeof NodeStorageHeadroomSample
>;

/** Every answer carries the next nonce. Only an accepted product sample renews: it returns the
 * node's composed storage_nodes entry and every current sa1 token of the node's thin databases. */
export const NodeStorageHeadroomResponse = z
  .strictObject({
    accepted: z.boolean(),
    reason: z
      .string()
      .regex(/^thin_storage_sample_[a-z0-9_]{1,80}$/)
      .nullable(),
    nonce: ThinStorageSampleNonce,
    period_milliseconds: SamplePeriod,
    authority: NodeThinStorageAuthority.nullable(),
    tokens: z
      .array(
        z.strictObject({
          database_id: DatabaseId,
          token: z.string().min(1).max(STORAGE_AUTHORITY_MAX_LENGTH),
        }),
      )
      .max(4096),
  })
  .superRefine((value, context) => {
    if (
      value.accepted !== (value.reason === null) ||
      (!value.accepted &&
        (value.authority !== null || value.tokens.length > 0)) ||
      (value.authority === null && value.tokens.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Only an accepted renewal carries authority or tokens",
      });
  });
export type NodeStorageHeadroomResponse = z.infer<
  typeof NodeStorageHeadroomResponse
>;

/** Current stop intent only: bounded old-writer drain, never a tenant startup grant. */
export const HostStorageDrain = z.strictObject({
  operation_id: OperationId,
  kind: z.enum(["database.suspend", "database.hibernate", "database.delete"]),
  generation: z.number().int().positive(),
  authority_revision: z.number().int().positive(),
  expires_at: Bytes,
  budget_bytes: Bytes.positive(),
});
export type HostStorageDrain = z.infer<typeof HostStorageDrain>;

/** Fetched only by the protected host service from its pinned CF HTTPS endpoint. */
export const HostStorageLease = z
  .strictObject({
    purpose: z.literal("pgcf-storage-host/v1"),
    node_uid: z.uuid(),
    boot_id: z.uuid().nullable(),
    material_revision: z.number().int().positive(),
    issued_at: Bytes,
    expires_at: Bytes,
    legacy: z
      .array(
        z.strictObject({
          database_id: DatabaseId,
          generation: z.number().int().positive(),
          namespace: z.string().regex(/^pgcf-db-[a-z0-9]{20}$/),
        }),
      )
      .max(2000),
    databases: z
      .array(
        z.strictObject({
          database_id: DatabaseId,
          generation: z.number().int().positive(),
          authority_revision: z.number().int().nonnegative(),
          // For deleted entries, false plus volume=null is explicit completed physical deletion;
          // absent entries alone never authorize forgetting an existing signed physical scope.
          write_blocked: z.boolean(),
          desired_state: z.enum(["running", "suspended", "deleted"]),
          node_uid: z.uuid(),
          volume_group_uuid: StorageLvmUuid,
          pool_uuid: StorageLvmUuid,
          profile_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          startup_expires_at: Bytes.nullable(),
          startup_operation_id: OperationId.nullable(),
          volume: DatabaseStorageVolumeReceipt.nullable(),
          runtime_authority: z.string().max(4096).nullable(),
          drain: HostStorageDrain.nullable().optional(),
        }),
      )
      .max(4096),
  })
  .superRefine((value, context) => {
    if (
      (value.databases.length > 0 && value.boot_id === null) ||
      value.expires_at <= value.issued_at ||
      value.expires_at > value.issued_at + 120000 ||
      new Set(
        [...value.databases, ...value.legacy].map((entry) => entry.database_id),
      ).size !==
        value.databases.length + value.legacy.length ||
      value.legacy.some(
        (entry) => entry.namespace !== `pgcf-db-${entry.database_id}`,
      ) ||
      value.databases.some(
        (entry) =>
          entry.node_uid !== value.node_uid ||
          (entry.drain != null &&
            (entry.desired_state === "running" ||
              entry.volume === null ||
              entry.drain.generation !== entry.generation ||
              entry.drain.authority_revision !== entry.authority_revision ||
              entry.drain.expires_at > value.expires_at ||
              entry.startup_expires_at !== null ||
              entry.startup_operation_id !== null ||
              entry.runtime_authority !== null ||
              (entry.desired_state === "deleted"
                ? entry.drain.kind !== "database.delete"
                : !["database.suspend", "database.hibernate"].includes(
                    entry.drain.kind,
                  )))) ||
          (entry.startup_expires_at !== null) !==
            (entry.startup_operation_id !== null) ||
          (entry.startup_expires_at !== null &&
            entry.startup_expires_at > value.expires_at),
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Host storage authority must have bounded unique current-node assignments",
      });
  });
export type HostStorageLease = z.infer<typeof HostStorageLease>;
