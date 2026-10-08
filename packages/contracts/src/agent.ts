// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { gatewayActivityReportSchema } from "./gateway-activity.ts";
import { UsageSample } from "./usage.ts";
import { ProviderInstanceId } from "./nodes.ts";
import { FleetDesiredRelease } from "./releases.ts";
import { RecoverySourceCredentialsMap } from "./region-archive-sources.ts";
import { NodeStorageSample } from "./node-physical-storage.ts";
export { RecoverySourceCredentialsMap } from "./region-archive-sources.ts";
export {
  NodePhysicalStorage,
  NodeStorageSample,
} from "./node-physical-storage.ts";
import {
  BucketName,
  HttpsUrl,
  OperationStatus,
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

export const DesiredRole = z.strictObject({
  name: RoleName,
  owner: z.boolean(),
  password: RolePassword,
  revision: z.number().int().min(1),
});
export type DesiredRole = z.infer<typeof DesiredRole>;

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
    size: DesiredSize,
    roles: z.array(DesiredRole).max(100).default([]),
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
  })
  .refine(
    (value) =>
      value.working_set_bytes <= value.capacity_memory_bytes &&
      (value.available_bytes === null ||
        value.available_bytes <= value.capacity_memory_bytes),
    { message: "Node memory gauges cannot exceed physical capacity" },
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
    backup: BackupObservation.optional(),
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

export const ObservationRequest = z
  .strictObject({
    observed_at: Timestamp,
    nodes: z.array(NodeObservation).max(1000),
    databases: z.array(DatabaseObservation).max(10_000),
    orphans: z.array(Orphan).max(1000),
    /** Partial background samples; an empty inventory here does not replace the region inventory. */
    node_memory_samples: z.array(NodeMemoryObservation).max(1000).optional(),
  })
  .superRefine((value, ctx) => {
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
  });
export type ObservationRequest = z.infer<typeof ObservationRequest>;

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

/** Hint: pull desired state now (optionally only these databases changed). */
export const LinkDesiredHint = z.strictObject({
  type: z.literal("desired"),
  ids: z.array(DatabaseId).max(DESIRED_PAGE_LIMIT_MAX).optional(),
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
