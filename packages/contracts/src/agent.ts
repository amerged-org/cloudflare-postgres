// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseRuntimeAttestation } from "./reclaim.ts";
import { DatabaseAdmissionIntent } from "./database-admission.ts";
import { ComputePoolPolicy } from "./compute-pool.ts";
import { gatewayActivityReportSchema } from "./gateway-activity.ts";
import { UsageSample } from "./usage.ts";
import { ProviderInstanceId } from "./nodes.ts";
import { FleetDesiredRelease, FleetReleaseId } from "./releases.ts";
import { RecoverySourceCredentialsMap } from "./region-archive-sources.ts";
import { NodeStorageSample } from "./node-physical-storage.ts";
import {
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
} from "./database-storage.ts";
export {
  DesiredDatabaseStorage,
  DesiredStorageStartup,
  DatabaseStorageVolumeReceipt,
  NodeStorageProtectionProof,
  NodeThinStorageAuthority,
  THIN_AUTHORITY_MAX_SECONDS,
  THIN_INVENTORY_INTERVAL_SECONDS,
  THIN_INVENTORY_MAX_SECONDS,
  ThinStorageProfile,
  thinStorageAuthorityMatches,
  thinStorageInventory,
  thinStorageVolumeReclaimed,
  thinStorageClass,
  thinStorageClassObject,
  thinVolumeAttributesClassObject,
  thinMetadataEstimateBytes,
  thinWriteExposure,
} from "./database-storage.ts";
export * from "./storage-write-authority.ts";
export { RecoverySourceCredentialsMap } from "./region-archive-sources.ts";
export {
  NodePhysicalStorage,
  NodeStorageSample,
} from "./node-physical-storage.ts";
import {
  BucketName,
  HttpsUrl,
  OperationStatus,
  ROLE_CONNECTION_LIMIT_MAX,
  ROLE_LIMIT,
  ROLE_MEMBER_OF_MAX,
  Timestamp,
  TEXT_MAX_LENGTH,
} from "./api.ts";
import { RolePassword } from "./auth.ts";
import { MaintenanceCredential, MAINTENANCE_ROLE } from "./maintenance.ts";
import {
  DATABASE_ID_PATTERN,
  DatabaseId,
  OPERATION_ID_PATTERN,
  OperationId,
  NodeId,
  OWNER_ROLE_NAME,
  REGION_ID_PATTERN,
  RegionId,
  RoleName,
} from "./ids.ts";

export const AGENT_PROTOCOL_VERSION = 1;
export const DESIRED_PAGE_LIMIT_MAX = 200;
export const PG_MAJOR = 18;
export const CONFIGURATION_SCHEMA_REVISION = 1;
export const DesiredPostgres = z.strictObject({
  release_id: FleetReleaseId,
  image: z
    .string()
    .max(512)
    .regex(/^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$/),
  version: z.string().regex(/^18\.[0-9]+(?:\.[0-9]+)?$/),
  configuration_schema_revision: z.literal(CONFIGURATION_SCHEMA_REVISION),
});
export type DesiredPostgres = z.infer<typeof DesiredPostgres>;
export function postgresImageIdMatches(
  image: string,
  imageId: string,
): boolean {
  const digest = image.match(/@sha256:([a-f0-9]{64})$/)?.[1];
  return (
    digest !== undefined &&
    /^(?:(?:docker-pullable|docker|containerd):\/\/)?(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(
      imageId,
    ) &&
    imageId.endsWith(`sha256:${digest}`)
  );
}
/** Barman `serverName` for every database; the path prefix already makes it unique. */
export const ARCHIVE_SERVER_NAME = "database";

const K8sNodeName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/);
const Count = z.number().int().nonnegative();

// ---------- Archive path ----------

export function archiveDestinationPath(
  bucket: string,
  regionId: string,
  databaseId: string,
  generation: number,
  operationId: string,
): string {
  if (!BucketName.safeParse(bucket).success)
    throw new TypeError("invalid bucket name");
  if (!REGION_ID_PATTERN.test(regionId))
    throw new TypeError("invalid region id");
  if (!DATABASE_ID_PATTERN.test(databaseId))
    throw new TypeError("invalid database id");
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new TypeError("invalid generation");
  if (!OPERATION_ID_PATTERN.test(operationId))
    throw new TypeError("invalid operation id");
  return `s3://${bucket}/${regionId}/${databaseId}/g${generation}-${operationId}`;
}

export const ARCHIVE_DESTINATION_PATTERN =
  /^s3:\/\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/([a-z][a-z0-9-]{1,30}[a-z0-9])\/([a-z][a-z0-9]{19})\/g([1-9][0-9]{0,15})-(op_[a-z0-9]{20})$/;

// ---------- Desired state (GET /agent/v1/desired) ----------

export const DesiredQuery = z.strictObject({
  after: DatabaseId.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(DESIRED_PAGE_LIMIT_MAX)
    .default(DESIRED_PAGE_LIMIT_MAX),
});
export type DesiredQuery = z.infer<typeof DesiredQuery>;

export const DesiredSize = z
  .strictObject({
    memory_mib: z.number().int().min(256),
    /** Explicit startup request for an actual-RAM region; the class remains the hard memory limit. */
    memory_request_mib: z.number().int().positive().max(1048576).optional(),
    cpu_millicores: z.number().int().min(100),
    /** CPU scheduling share; cpu_millicores remains the hard limit. */
    cpu_request_millicores: z.number().int().positive().max(256_000).optional(),
    storage_gib: z.number().int().min(1),
    max_connections: z.number().int().min(10),
    archive_timeout_seconds: z.number().int().min(30),
    backup_retention_days: z.number().int().min(1),
  })
  .refine(
    (size) =>
      size.memory_request_mib === undefined ||
      size.memory_request_mib <= size.memory_mib,
    {
      message:
        "PostgreSQL startup memory request cannot exceed its class limit",
    },
  )
  .refine(
    (size) =>
      size.cpu_request_millicores === undefined ||
      size.cpu_request_millicores <= size.cpu_millicores,
    {
      path: ["cpu_request_millicores"],
      message: "PostgreSQL CPU request cannot exceed its class limit",
    },
  );
export type DesiredSize = z.infer<typeof DesiredSize>;

/**
 * A role the database holds. The attributes appear only where they differ from a plain role
 * (no expiry, no limit, no membership, NOBYPASSRLS), so a database without them keeps the wire
 * shape every deployed consumer accepts.
 */
export const DesiredRole = z.strictObject({
  name: RoleName,
  owner: z.boolean(),
  password: RolePassword,
  revision: z.number().int().min(1),
  valid_until: Timestamp.describe(
    "VALID UNTIL; applied at whole seconds, truncated. Absent means no expiry.",
  ).optional(),
  connection_limit: z
    .number()
    .int()
    .min(1)
    .max(ROLE_CONNECTION_LIMIT_MAX)
    .describe("CONNECTION LIMIT. Absent means unlimited.")
    .optional(),
  member_of: z
    .array(RoleName)
    .max(ROLE_MEMBER_OF_MAX)
    .describe(
      "Other present roles of this record the role is a member of. Absent means none.",
    )
    .optional(),
  bypass_rls: z
    .literal(true)
    .describe("BYPASSRLS. Absent means NOBYPASSRLS.")
    .optional(),
});
export type DesiredRole = z.infer<typeof DesiredRole>;
/**
 * A role deleted through the API whose removal from PostgreSQL is not yet confirmed. The region
 * sets it to NOLOGIN, ends its sessions, then drops it, and reports the outcome in the
 * observation's `roles`.
 */
export const DesiredRoleRemoval = z
  .strictObject({
    name: RoleName,
    state: z.literal("absent"),
  })
  .describe("A deleted role the region must remove; it carries no credential.");
export type DesiredRoleRemoval = z.infer<typeof DesiredRoleRemoval>;
export function isRoleRemoval(
  role: DesiredRole | DesiredRoleRemoval,
): role is DesiredRoleRemoval {
  return "state" in role;
}
/** The roles a database holds now, without those awaiting removal. */
export function presentRoles(db: {
  roles: readonly (DesiredRole | DesiredRoleRemoval)[];
}): DesiredRole[] {
  return db.roles.filter((role): role is DesiredRole => !isRoleRemoval(role));
}

export const DesiredCreation = z.strictObject({
  operation_id: OperationId,
  generation: z.number().int().min(1),
  status: OperationStatus,
  ever_ready: z.boolean(),
});
export type DesiredCreation = z.infer<typeof DesiredCreation>;

export const RecoverySourceArchive = z.strictObject({
  region_id: RegionId,
  bucket: BucketName,
  endpoint_url: HttpsUrl,
  region: z.literal("auto"),
});
export type RecoverySourceArchive = z.infer<typeof RecoverySourceArchive>;

export const DesiredRecovery = z.strictObject({
  operation_id: OperationId,
  source_database_id: DatabaseId,
  source_archive_path: z.string().regex(ARCHIVE_DESTINATION_PATTERN),
  source_storage_generation: z.number().int().positive(),
  source_archive: RecoverySourceArchive.optional(),
  backup_id: z.string().regex(/^[0-9]{8}T[0-9]{6}$/),
  target_time: Timestamp.optional(),
  status: OperationStatus,
  ever_ready: z.boolean(),
});
export type DesiredRecovery = z.infer<typeof DesiredRecovery>;

export const DesiredDatabase = z
  .strictObject({
    id: DatabaseId,
    generation: z.number().int().min(1),
    admission: DatabaseAdmissionIntent.optional(),
    storage_generation: z.number().int().positive().optional(),
    recovery: DesiredRecovery.optional(),
    desired_state: z.enum(["running", "suspended", "deleted"]),
    power: z
      .strictObject({
        operation: OperationId,
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        mode: z.enum(["quiesce", "running"]),
        reason: z.enum(["manual", "idle"]).nullable(),
      })
      .optional(),
    node: K8sNodeName,
    pg_major: z.literal(PG_MAJOR),
    postgres: DesiredPostgres.optional(),
    storage: DesiredDatabaseStorage.optional(),
    size: DesiredSize,
    roles: z
      .array(z.union([DesiredRole, DesiredRoleRemoval]))
      .max(ROLE_LIMIT)
      .default([]),
    maintenance: MaintenanceCredential.optional(),
    // Older desired pages omit this field; omission cannot authorize initial storage.
    creation: DesiredCreation.nullable().optional(),
    archive: z.strictObject({
      destination_path: z.string().regex(ARCHIVE_DESTINATION_PATTERN),
      server_name: z.literal(ARCHIVE_SERVER_NAME),
    }),
  })
  .superRefine((db, ctx) => {
    if (
      (db.desired_state === "suspended" && !db.power) ||
      (db.power &&
        (db.power.revision !== db.generation ||
          (db.desired_state === "suspended"
            ? db.power.mode !== "quiesce" || db.power.reason === null
            : db.power.mode !== "running" || db.power.reason !== null)))
    )
      ctx.addIssue({
        code: "custom",
        path: ["power"],
        message:
          "Power intent must match the current desired state and revision",
      });
    const match = ARCHIVE_DESTINATION_PATTERN.exec(db.archive.destination_path);
    // Desired revisions advance for role changes and deletion without replacing the archive.
    if (
      match &&
      (match[3] !== db.id || Number(match[4]) !== (db.storage_generation ?? 1))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["archive", "destination_path"],
        message:
          "archive path must match this database and physical storage generation",
      });
    }
    if (match && db.creation && match[5] !== db.creation.operation_id) {
      ctx.addIssue({
        code: "custom",
        path: ["creation", "operation_id"],
        message: "creation operation must match the archive path",
      });
    }
    if (db.creation && db.creation.generation > db.generation) {
      ctx.addIssue({
        code: "custom",
        path: ["creation", "generation"],
        message: "creation must not name a future desired revision",
      });
    }
    if (db.recovery) {
      const source = ARCHIVE_DESTINATION_PATTERN.exec(
        db.recovery.source_archive_path,
      );
      if (
        !source ||
        source[3] !== db.recovery.source_database_id ||
        Number(source[4]) !== db.recovery.source_storage_generation ||
        source[1] !== (db.recovery.source_archive?.bucket ?? match?.[1]) ||
        source[2] !== (db.recovery.source_archive?.region_id ?? match?.[2]) ||
        db.recovery.source_database_id === db.id ||
        db.recovery.operation_id !== match?.[5] ||
        db.creation
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["recovery"],
          message:
            "Recovery must bind a separate target and its exact source archive identity",
        });
      }
    }
    const names = new Set<string>();
    let owners = 0;
    for (const role of db.roles) {
      if (role.name === MAINTENANCE_ROLE)
        ctx.addIssue({
          code: "custom",
          path: ["roles"],
          message: "Internal maintenance role cannot be a customer role",
        });
      if (names.has(role.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["roles"],
          message: `duplicate role ${role.name}`,
        });
      }
      names.add(role.name);
      if (isRoleRemoval(role)) {
        if (role.name === OWNER_ROLE_NAME)
          ctx.addIssue({
            code: "custom",
            path: ["roles"],
            message: "The owner role cannot be removed",
          });
        continue;
      }
      if (role.owner) {
        owners += 1;
        if (role.name !== OWNER_ROLE_NAME) {
          ctx.addIssue({
            code: "custom",
            path: ["roles"],
            message: `owner role must be ${OWNER_ROLE_NAME}`,
          });
        }
      }
    }
    // A membership names another role the database holds now; the owner is never a target.
    const present = new Map(
      presentRoles(db).map((role) => [role.name, role] as const),
    );
    for (const role of presentRoles(db))
      for (const target of role.member_of ?? [])
        if (
          target === role.name ||
          target === OWNER_ROLE_NAME ||
          present.get(target)?.owner !== false
        )
          ctx.addIssue({
            code: "custom",
            path: ["roles"],
            message: `${role.name} is a member of ${target}, which is not another role of this database`,
          });
    if (
      owners > 1 ||
      (["running", "suspended"].includes(db.desired_state) && owners !== 1)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "running databases require exactly one owner role",
      });
    }
  });
export type DesiredDatabase = z.infer<typeof DesiredDatabase>;

export const DesiredRegion = z.strictObject({
  id: RegionId,
  /** Current authoritative region pool template, including assigned per-Pod overhead. */
  compute_pool: ComputePoolPolicy.nullable().optional(),
  /** High-trust Native physical readbacks; ordinary Regional observations cannot mint these. */
  storage_nodes: z.array(NodeThinStorageAuthority).max(1000).optional(),
  /** Authenticated target-region-only source-read custody; omission preserves legacy installations. */
  recovery_sources: RecoverySourceCredentialsMap.optional(),
  backup: z.strictObject({
    bucket: BucketName,
    endpoint_url: z.url({ protocol: /^https$/ }),
    region: z.literal("auto"),
  }),
  scheduling: z
    .strictObject({
      placement_mode: z.literal("actual_ram"),
      maximum_database_memory_mib: z
        .number()
        .int()
        .positive()
        .max(1048576)
        .multipleOf(256),
      postgres_memory_request_mib: z.number().int().positive().max(1048576),
    })
    .refine(
      (scheduling) =>
        scheduling.postgres_memory_request_mib <=
        scheduling.maximum_database_memory_mib,
      {
        message:
          "PostgreSQL startup request cannot exceed the regional database limit",
      },
    )
    .optional(),
});
export type DesiredRegion = z.infer<typeof DesiredRegion>;

export const DesiredResponse = z
  .strictObject({
    region: DesiredRegion,
    fleet_release: FleetDesiredRelease.optional(),
    databases: z.array(DesiredDatabase).max(DESIRED_PAGE_LIMIT_MAX),
    next: DatabaseId.nullable(),
  })
  .superRefine((response, ctx) => {
    response.databases.forEach((database, index) => {
      const scheduling = response.region.scheduling;
      if (
        database.desired_state === "running" &&
        (database.size.memory_request_mib !==
          scheduling?.postgres_memory_request_mib ||
          (scheduling !== undefined &&
            (database.size.memory_mib >
              scheduling.maximum_database_memory_mib ||
              database.size.memory_mib % 256 !== 0)))
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["databases", index, "size"],
          message:
            "Desired memory must bind the explicit regional scheduling policy",
        });
      }
      const match = ARCHIVE_DESTINATION_PATTERN.exec(
        database.archive.destination_path,
      );
      if (
        match &&
        (match[1] !== response.region.backup.bucket ||
          match[2] !== response.region.id)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["databases", index, "archive", "destination_path"],
          message: "archive path must name this response's region and bucket",
        });
      }
    });
  });
export type DesiredResponse = z.infer<typeof DesiredResponse>;

// ---------- Observations (POST /agent/v1/observations) ----------

export const DATABASE_OBSERVED_STATES = [
  "provisioning",
  "hibernated",
  "ready",
  "error",
  "deleting",
  "deleted",
] as const;

export const NodeObservation = z.strictObject({
  node_id: NodeId.optional(),
  provider_instance_id: ProviderInstanceId.optional(),
  node_uid: z.uuid().optional(),
  name: K8sNodeName,
  ready: z.boolean(),
  /** An operator's disabled label can close placement; observations never reopen it. */
  database_placement_enabled: z.literal(false).optional(),
  allocatable_memory_mib: Count,
  allocatable_cpu_millicores: Count,
  storage_gib_total: Count.nullable(),
  platform_reserved_memory_mib: Count,
  platform_reserved_cpu_millicores: Count.nullable().optional(),
  storage: NodeStorageSample.optional(),
});
export type NodeObservation = z.infer<typeof NodeObservation>;

const MemoryBytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const NodeMemorySample = z
  .strictObject({
    node_uid: z.uuid(),
    observed_at: Timestamp,
    working_set_bytes: MemoryBytes,
    capacity_memory_bytes: MemoryBytes.positive(),
    available_bytes: MemoryBytes.nullable(),
    memory_pressure: z.boolean().nullable(),
    /** Kubelet Summary `node.cpu.usageNanoCores` from the same sample; absent from older reporters. */
    cpu_usage_nano_cores: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    /** Node `status.capacity.cpu` in millicores, paired with the CPU usage gauge. */
    capacity_cpu_millicores: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
  })
  .refine(
    (value) =>
      value.working_set_bytes <= value.capacity_memory_bytes &&
      (value.available_bytes === null ||
        value.available_bytes <= value.capacity_memory_bytes),
    { message: "Node memory gauges cannot exceed physical capacity" },
  )
  .refine(
    (value) =>
      (value.cpu_usage_nano_cores ?? null) === null ||
      (value.capacity_cpu_millicores ?? null) !== null,
    { message: "Node CPU usage requires the node CPU capacity" },
  );
export type NodeMemorySample = z.infer<typeof NodeMemorySample>;

export const NodeMemoryObservation = z
  .strictObject({
    node_id: NodeId,
    provider_instance_id: ProviderInstanceId,
    node_uid: z.uuid(),
    memory: NodeMemorySample.nullable(),
  })
  .refine(
    (value) =>
      value.memory === null || value.memory.node_uid === value.node_uid,
    {
      message: "Memory belongs to the authenticated Kubernetes node UID",
    },
  );
export type NodeMemoryObservation = z.infer<typeof NodeMemoryObservation>;

export const BackupObservation = z.strictObject({
  health: z.enum(["ok", "failing", "unknown"]),
  observed_at: Timestamp,
  last_completed_at: Timestamp.nullable(),
  last_failed_at: Timestamp.nullable(),
});
export type BackupObservation = z.infer<typeof BackupObservation>;

export const DatabaseObservation = z
  .strictObject({
    id: DatabaseId,
    generation: z.number().int().min(1),
    state: z.enum(DATABASE_OBSERVED_STATES),
    postgres: z
      .strictObject({
        image: z
          .string()
          .max(512)
          .regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
        image_id: z.string().max(1024),
      })
      .optional(),
    recovery: z
      .strictObject({
        operation_id: OperationId,
        storage_generation: z.number().int().positive(),
        verified: z.literal(true),
      })
      .optional(),
    power: z
      .strictObject({
        operation: OperationId,
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        state: z.enum(["hibernated", "awake"]),
        refusal: z.enum(["busy", "archive", "unknown"]).optional(),
      })
      .optional(),
    message: z.string().max(TEXT_MAX_LENGTH).optional(),
    /**
     * The fate of the roles the desired record asked to remove: `removed` roles are confirmed
     * absent from PostgreSQL; a `blocked` role is still there, set to NOLOGIN, because dropping
     * it failed on the objects or privileges it holds. Only a ready database reports them.
     */
    roles: z
      .strictObject({
        removed: z
          .array(RoleName)
          .max(ROLE_LIMIT)
          .describe("Roles confirmed absent from PostgreSQL."),
        blocked: z
          .array(RoleName)
          .max(ROLE_LIMIT)
          .describe(
            "Roles that cannot be dropped because they own objects or hold privileges; they stay NOLOGIN.",
          ),
      })
      .describe(
        "The fate of the roles the desired record asked to remove; sent only with a ready database that has such roles.",
      )
      .optional(),
    backup: BackupObservation.optional(),
    runtime_attestation: DatabaseRuntimeAttestation.optional(),
    archive: z.strictObject({
      continuous: z.boolean(),
      ready_wal_files: Count.nullable(),
      health: z.enum(["ok", "failing", "unknown"]).optional(),
    }),
  })
  .superRefine((db, ctx) => {
    if (
      db.archive.health !== undefined &&
      ((db.archive.health === "ok" &&
        (!db.archive.continuous || db.archive.ready_wal_files === null)) ||
        (db.archive.health !== "ok" && db.archive.continuous))
    )
      ctx.addIssue({
        code: "custom",
        path: ["archive", "health"],
        message: "Explicit archive health must match continuous archive proof",
      });
    if (
      db.roles &&
      (db.state !== "ready" ||
        new Set([...db.roles.removed, ...db.roles.blocked]).size !==
          db.roles.removed.length + db.roles.blocked.length)
    )
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message:
          "Role removals are reported by a ready observation and name each role once",
      });
    if (
      db.power?.refusal &&
      (db.state !== "error" || db.power.state !== "awake")
    )
      ctx.addIssue({
        code: "custom",
        path: ["power", "refusal"],
        message: "Refusal requires an awake error observation",
      });
    if (
      (db.state === "hibernated" && !db.power) ||
      (db.power &&
        (db.power.revision !== db.generation ||
          (db.state === "ready" && db.power.state !== "awake") ||
          (db.state === "hibernated" && db.power.state !== "hibernated")))
    )
      ctx.addIssue({
        code: "custom",
        path: ["power"],
        message: "Observed power must match the observation revision and state",
      });
  });
export type DatabaseObservation = z.infer<typeof DatabaseObservation>;

/** A namespace labelled `pgcf.io/database-id` that desired state does not name; reported, never deleted. */
export const Orphan = z.strictObject({
  namespace: z.string().min(1).max(63),
  database_id: z.string().max(253).nullable(),
});
export type Orphan = z.infer<typeof Orphan>;

function uniqueMemorySamples(
  value: { observed_at: string; node_memory_samples?: NodeMemoryObservation[] },
  ctx: z.RefinementCtx,
): void {
  const identities = new Set<string>();
  for (const [index, sample] of (value.node_memory_samples ?? []).entries()) {
    if (
      identities.has(sample.node_id) ||
      (sample.memory !== null &&
        Date.parse(sample.memory.observed_at) > Date.parse(value.observed_at))
    )
      ctx.addIssue({
        code: "custom",
        path: ["node_memory_samples", index],
        message:
          "Memory samples must be unique and no newer than their envelope",
      });
    identities.add(sample.node_id);
  }
}

/**
 * Reports from regional runtimes released before explicit coverage. Omitted orphans keep the
 * recorded orphan inventory. Remove once no released regional runtime sends this shape.
 */
export const ObservationRequest = z
  .strictObject({
    observed_at: Timestamp,
    nodes: z.array(NodeObservation).max(1000),
    databases: z.array(DatabaseObservation).max(10_000),
    /** Omitted for a targeted database report; only a measured inventory replaces orphan state. */
    orphans: z.array(Orphan).max(1000).optional(),
    /** Partial background samples; an empty inventory here does not replace the region inventory. */
    node_memory_samples: z.array(NodeMemoryObservation).max(1000).optional(),
  })
  .superRefine(uniqueMemorySamples);
export type ObservationRequest = z.infer<typeof ObservationRequest>;

/**
 * A partial database update, published as soon as a database observation is verified. It
 * covers only the listed databases: node, orphan and memory inventory stay unchanged.
 */
export const DatabaseObservationUpdate = z.strictObject({
  coverage: z.literal("databases"),
  observed_at: Timestamp,
  databases: z.array(DatabaseObservation).min(1).max(DESIRED_PAGE_LIMIT_MAX),
});
export type DatabaseObservationUpdate = z.infer<
  typeof DatabaseObservationUpdate
>;

/**
 * A completed, identity-checked regional inventory. Only it replaces the orphan report, an
 * empty scan included; it never changes database state.
 */
export const RegionalInventory = z
  .strictObject({
    coverage: z.literal("inventory"),
    observed_at: Timestamp,
    nodes: z.array(NodeObservation).max(1000),
    orphans: z.array(Orphan).max(1000),
    node_memory_samples: z.array(NodeMemoryObservation).max(1000).optional(),
  })
  .superRefine(uniqueMemorySamples);
export type RegionalInventory = z.infer<typeof RegionalInventory>;

/** POST /agent/v1/observations: a report replaces only what its coverage names. */
export const ObservationReport = z.union([
  DatabaseObservationUpdate,
  RegionalInventory,
  ObservationRequest,
]);
export type ObservationReport = z.infer<typeof ObservationReport>;

// ---------- Link messages (GET /agent/v1/link WebSocket) ----------

export const LinkHello = z.strictObject({
  type: z.literal("hello"),
  protocol: z.literal(AGENT_PROTOCOL_VERSION),
  agent_version: z.string().min(1).max(64),
  instance_id: z.string().min(1).max(128),
});
export type LinkHello = z.infer<typeof LinkHello>;

export const LinkWelcome = z.strictObject({
  type: z.literal("welcome"),
  protocol: z.literal(AGENT_PROTOCOL_VERSION),
});
export type LinkWelcome = z.infer<typeof LinkWelcome>;

/** The largest link message either end accepts; a hint's page is carried only within it. */
export const LINK_MESSAGE_MAX_BYTES = 64 * 1024;

/**
 * Hint: pull desired state now (optionally only these databases changed). A wake's hint may carry
 * `desired`, the desired page of its one database as a targeted pull of it reads it right after
 * the claim committed; the region may apply it in place of that pull. Without it, or when the
 * region does not take it, the region pulls.
 */
export const LinkDesiredHint = z
  .strictObject({
    type: z.literal("desired"),
    ids: z.array(DatabaseId).max(DESIRED_PAGE_LIMIT_MAX).optional(),
    desired: DesiredResponse.optional(),
  })
  .superRefine((hint, ctx) => {
    if (
      hint.desired &&
      (hint.ids?.length !== 1 ||
        hint.desired.databases.length !== 1 ||
        hint.desired.databases[0]!.id !== hint.ids[0] ||
        hint.desired.next !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["desired"],
        message: "A hint's page carries exactly the one database it names",
      });
  });
export type LinkDesiredHint = z.infer<typeof LinkDesiredHint>;

export const AgentLinkMessage = z.discriminatedUnion("type", [LinkHello]);
export type AgentLinkMessage = z.infer<typeof AgentLinkMessage>;

export const ServerLinkMessage = z.discriminatedUnion("type", [
  LinkWelcome,
  LinkDesiredHint,
]);
export type ServerLinkMessage = z.infer<typeof ServerLinkMessage>;

// ---------- Kubernetes ----------

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  [key: string]: unknown;
}

// ---------- Authenticated agent measurements ----------

export const AGENT_MEASUREMENT_BATCH_MAX = 25;
export const GATEWAY_ACTIVITY_FRESH_MS = 30_000;
export const GATEWAY_ACTIVITY_FUTURE_MS = 5_000;
const ActivityCount = z.number().int().nonnegative().max(1_000_000);

/** A real observation-window start bounds earlier possible activity, including process restarts. */
export function gatewayActivityBoundary(
  report: z.infer<typeof gatewayActivityReportSchema>,
): string {
  return [
    report.startedAt,
    report.counterStartedAt,
    report.countersSince,
    report.lastActivityAt,
  ]
    .filter((time): time is string => time !== null)
    .sort()
    .at(-1)!;
}
export const AgentDatabaseActivity = z
  .strictObject({
    id: DatabaseId,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observed_at: Timestamp,
    last_activity_at: Timestamp,
    idle_observed_since: Timestamp.optional(),
    connections: ActivityCount,
    busy_connections: ActivityCount,
    pending_dials: ActivityCount,
    expected_gateway_pods: z.array(z.uuid()).min(1).max(16),
    reports: z.array(gatewayActivityReportSchema).min(1).max(16),
  })
  .superRefine((activity, ctx) => {
    const pods = new Set(activity.expected_gateway_pods);
    const respondents = new Set(activity.reports.map((report) => report.pod));
    const boundary = [
      ...activity.reports.map(gatewayActivityBoundary),
      ...(activity.idle_observed_since === undefined
        ? []
        : [activity.idle_observed_since]),
    ]
      .sort()
      .at(-1);
    const oldest = activity.reports
      .map((report) => report.observedAt)
      .sort()[0]!;
    const total = (field: "connections" | "busyConnections" | "pendingDials") =>
      activity.reports.reduce((sum, report) => sum + report[field], 0);
    if (
      pods.size !== activity.expected_gateway_pods.length ||
      respondents.size !== activity.reports.length ||
      new Set(activity.reports.map((report) => report.processEpoch)).size !==
        activity.reports.length ||
      new Set(activity.reports.map((report) => report.epoch)).size !==
        activity.reports.length ||
      respondents.size !== pods.size ||
      activity.reports.some(
        (report) =>
          !pods.has(report.pod) ||
          report.database !== activity.id ||
          report.revision !== activity.revision,
      ) ||
      activity.connections !== total("connections") ||
      activity.busy_connections !== total("busyConnections") ||
      activity.pending_dials !== total("pendingDials") ||
      activity.busy_connections + activity.pending_dials > 1_000_000 ||
      activity.observed_at !==
        activity.reports
          .map((report) => report.observedAt)
          .sort()
          .at(-1) ||
      (activity.idle_observed_since !== undefined &&
        activity.idle_observed_since > oldest) ||
      activity.last_activity_at !== boundary
    )
      ctx.addIssue({
        code: "custom",
        message: "Activity must match the complete measured gateway inventory",
      });
  });
export type AgentDatabaseActivity = z.infer<typeof AgentDatabaseActivity>;
export const AgentActivityRequest = z
  .strictObject({
    databases: z
      .array(AgentDatabaseActivity)
      .min(1)
      .max(AGENT_MEASUREMENT_BATCH_MAX),
  })
  .refine(
    (body) =>
      new Set(body.databases.map((db) => db.id)).size === body.databases.length,
    { message: "Duplicate activity subject" },
  );
export type AgentActivityRequest = z.infer<typeof AgentActivityRequest>;
export const AgentUsageRequest = z.strictObject({
  samples: z.array(UsageSample).min(1).max(AGENT_MEASUREMENT_BATCH_MAX),
});
export type AgentUsageRequest = z.infer<typeof AgentUsageRequest>;
