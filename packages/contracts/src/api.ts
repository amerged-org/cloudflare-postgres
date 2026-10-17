// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { MAINTENANCE_ROLE } from "./maintenance.ts";
import {
  ApiKeyScope,
  ApiKeyString,
  AgentKeyString,
  RegionRouteKeyring,
} from "./auth.ts";
import { base64urlToBytes, bytesToBase64url } from "./encoding.ts";
import {
  DatabaseEffectiveResources,
  DatabaseResourcesCreate,
} from "./database-resources.ts";
import {
  ApiKeyId,
  DatabaseId,
  NodeId,
  OperationId,
  OWNER_ROLE_NAME,
  ProjectId,
  RegionId,
  RoleName,
  SizeClassId,
} from "./ids.ts";

/**
 * The version of the API contract that the served OpenAPI documents carry as `info.version`: the
 * shapes, limits and documented behaviour of the requests and responses. It changes with the
 * contract and only with it, never with a Worker release (that version is `x-worker-version`).
 * Raise the major for a change a client written against the previous version can break on, the
 * minor for an addition, and the patch for a correction of the documentation alone.
 */
export const API_CONTRACT_VERSION = "1.2.0";

/** ISO-8601 UTC timestamp exactly as Date#toISOString renders it. */
export const Timestamp = z.iso
  .datetime({ precision: 3 })
  .meta({ id: "Timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;
/** The pattern of `Timestamp` in the contract's own JSON Schema, which the OpenAPI generator drops. */
export const TIMESTAMP_PATTERN: string = (() => {
  const { pattern } = z.toJSONSchema(z.iso.datetime({ precision: 3 }));
  if (typeof pattern !== "string") throw new Error("timestamp_pattern_missing");
  return pattern;
})();
/** A timestamp with its own description. The generator inlines it, so the pattern is restated. */
const describedTimestamp = (description: string) =>
  Timestamp.meta({ description, pattern: TIMESTAMP_PATTERN });

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
export const IdempotencyKey = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

/** Free-text fields are capped at 4 KB. */
export const TEXT_MAX_LENGTH = 4096;

const DisplayName = z.string().trim().min(1).max(200);
export const DatabaseName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/)
  .meta({ id: "DatabaseName" });
const ExternalId = z.string().min(1).max(200);
const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);
export const BucketName = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
const ProviderName = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

// ---------- Lists and cursors ----------

export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

export const ListQuery = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .default(LIST_LIMIT_DEFAULT),
  cursor: z.string().max(256).optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;

export function listEnvelope<T extends z.ZodType>(item: T) {
  return z.strictObject({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });
}
export interface ListEnvelope<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Cursor {
  created_at: string;
  id: string;
}

const CURSOR_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const CURSOR_MAX_LENGTH = 256;

/** Keyset cursor for lists ordered by (created_at DESC, id DESC). */
export function encodeCursor(
  cursor: Cursor,
  validId: (id: string) => boolean = (id) => CURSOR_ID_PATTERN.test(id),
): string {
  if (!isCanonicalTimestamp(cursor.created_at)) {
    throw new TypeError("cursor created_at must be a canonical timestamp");
  }
  if (cursor.id.includes("|") || !validId(cursor.id)) {
    throw new TypeError("cursor id is malformed");
  }
  const encoded = bytesToBase64url(
    new TextEncoder().encode(`${cursor.created_at}|${cursor.id}`),
  );
  if (encoded.length > CURSOR_MAX_LENGTH)
    throw new TypeError("cursor exceeds length bound");
  return encoded;
}

export function decodeCursor(
  value: string,
  validId: (id: string) => boolean = (id) => CURSOR_ID_PATTERN.test(id),
): Cursor | null {
  if (value.length === 0 || value.length > CURSOR_MAX_LENGTH) return null;
  const bytes = base64urlToBytes(value);
  if (bytes === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  const parts = text.split("|");
  if (parts.length !== 2) return null;
  const [createdAt, id] = parts as [string, string];
  if (!isCanonicalTimestamp(createdAt) || !validId(id)) return null;
  return { created_at: createdAt, id };
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

// ---------- Projects ----------

export const Project = z
  .strictObject({
    id: ProjectId,
    name: DisplayName,
    external_id: ExternalId.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Project" });
export type Project = z.infer<typeof Project>;

export const ProjectCreate = z
  .strictObject({
    name: DisplayName,
    external_id: ExternalId.optional(),
  })
  .meta({ id: "ProjectCreate" });
export type ProjectCreate = z.infer<typeof ProjectCreate>;

// ---------- Size classes ----------

const SizeClassFields = {
  memory_mib: z.number().int().min(256).max(1_048_576),
  cpu_millicores: z.number().int().min(100).max(256_000),
  /** Scheduling share; omission preserves the legacy request equal to the limit. */
  cpu_request_millicores: z.number().int().positive().max(256_000).optional(),
  storage_gib: z.number().int().min(1).max(65_536),
  max_connections: z.number().int().min(10).max(10_000),
  sleep_after_seconds: z
    .number()
    .int()
    .min(60)
    .max(2_592_000)
    .nullable()
    .describe(
      "Idle time before a database of the class that sets none of its own sleeps; null is always warm.",
    ),
  archive_timeout_seconds: z.number().int().min(30).max(3600),
  backup_retention_days: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
};

export const SizeClass = z
  .strictObject({
    id: SizeClassId,
    ...SizeClassFields,
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .refine(
    (size) =>
      size.cpu_request_millicores === undefined ||
      size.cpu_request_millicores <= size.cpu_millicores,
    {
      path: ["cpu_request_millicores"],
      message: "PostgreSQL CPU request cannot exceed its class limit",
    },
  )
  .meta({
    id: "SizeClass",
    description:
      "cpu_request_millicores, when present, is at most cpu_millicores. memory_mib is a multiple of 256 in a class an operator defines.",
  });
export type SizeClass = z.infer<typeof SizeClass>;

/** Body of PUT /v1/size-classes/{id}. */
export const SizeClassUpsert = z
  .strictObject({
    ...SizeClassFields,
    memory_mib: SizeClassFields.memory_mib
      .multipleOf(256)
      .meta({ multipleOf: 256 }),
  })
  .refine(
    (size) =>
      size.cpu_request_millicores === undefined ||
      size.cpu_request_millicores <= size.cpu_millicores,
    {
      path: ["cpu_request_millicores"],
      message: "PostgreSQL CPU request cannot exceed its class limit",
    },
  )
  .meta({
    id: "SizeClassUpsert",
    description:
      "memory_mib is a multiple of 256, and cpu_request_millicores, when present, is at most cpu_millicores; a violation is a 400.",
  });
export type SizeClassUpsert = z.infer<typeof SizeClassUpsert>;

// ---------- Regions ----------

const RegionFields = {
  provider: ProviderName,
  provider_region: z.string().min(1).max(64),
  gateway_url: HttpUrl,
  gateway_binding: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  backup_bucket: BucketName,
  backup_endpoint_url: HttpsUrl,
};

/** Admin view; the agent key hash is never returned. */
export const Region = z
  .strictObject({
    id: RegionId,
    ...RegionFields,
    agent_last_seen_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Region" });
export type Region = z.infer<typeof Region>;

export const RegionCreate = z
  .strictObject({
    id: RegionId,
    ...RegionFields,
    gateway_binding: RegionFields.gateway_binding.optional(),
  })
  .meta({ id: "RegionCreate" });
export type RegionCreate = z.infer<typeof RegionCreate>;

/**
 * What an integrator key sees of a region: one a database can be placed in. Nothing of its nodes,
 * capacity or cost.
 */
export const PlacementRegion = z
  .strictObject({
    id: RegionId,
    provider_region: RegionFields.provider_region,
  })
  .meta({
    id: "PlacementRegion",
    examples: [{ id: "eu-1", provider_region: "EU" }],
  });
export type PlacementRegion = z.infer<typeof PlacementRegion>;

/** The agent key and derived routing keyring are returned exactly once, at creation. */
export const RegionCreated = z
  .strictObject({
    region: Region,
    agent_key: AgentKeyString,
    route_keyring: RegionRouteKeyring,
  })
  .meta({ id: "RegionCreated" });
export type RegionCreated = z.infer<typeof RegionCreated>;

// ---------- Nodes ----------

export const Node = z
  .strictObject({
    id: NodeId,
    node_uid: z.uuid().nullable().optional(),
    lost_at: Timestamp.nullable().optional(),
    lost_reason: z.string().max(TEXT_MAX_LENGTH).nullable().optional(),
    region_id: RegionId,
    k8s_node_name: z.string().min(1).max(253),
    provider_instance_id: z.string().min(1).max(128).nullable(),
    provider_product: z.string().min(1).max(128).nullable(),
    monthly_price: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,4})?$/)
      .nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    ready: z.boolean(),
    schedulable: z.boolean(),
    database_placement_enabled: z.boolean().optional(),
    database_placement_closed_at: Timestamp.nullable().optional(),
    memory_expansion_triggered_at: Timestamp.nullable().optional(),
    memory_window_observed_at: Timestamp.nullable().optional(),
    memory_window_valid: z.boolean().optional(),
    memory_utilization_ppm: z
      .number()
      .int()
      .min(0)
      .max(1000000)
      .nullable()
      .optional(),
    allocatable_memory_mib: z.number().int().nonnegative(),
    allocatable_cpu_millicores: z.number().int().nonnegative(),
    storage_gib_total: z.number().int().nonnegative().nullable(),
    platform_reserved_memory_mib: z.number().int().nonnegative(),
    platform_reserved_cpu_millicores: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .optional(),
    last_observed_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Node" });
export type Node = z.infer<typeof Node>;

// ---------- Databases ----------

export const DESIRED_STATES = ["running", "suspended", "deleted"] as const;
export const DesiredState = z.enum(DESIRED_STATES).meta({ id: "DesiredState" });
export type DesiredState = z.infer<typeof DesiredState>;

export const OBSERVED_STATES = [
  "pending",
  "provisioning",
  "hibernated",
  "ready",
  "error",
  "deleting",
  "deleted",
] as const;
export const ObservedState = z
  .enum(OBSERVED_STATES)
  .meta({ id: "ObservedState" });
export type ObservedState = z.infer<typeof ObservedState>;

export const ARCHIVING_HEALTH = ["ok", "failing", "unknown"] as const;
export const ArchivingHealth = z.enum(ARCHIVING_HEALTH);
export type ArchivingHealth = z.infer<typeof ArchivingHealth>;

export const BACKUP_HEALTH_STATUSES = [
  "ok",
  "stale",
  "failing",
  "unknown",
] as const;
export const DISK_HEALTH_STATUSES = ["ok", "warning", "unknown"] as const;

/**
 * Measured health of one database. A missing measurement is `unknown` or null, never ok or zero.
 * The operator listing of `GET /v1/operational-health?scope=databases` reads the same producers.
 */
export const DatabaseHealth = z
  .strictObject({
    archiving: ArchivingHealth,
    since: Timestamp.nullable(),
    backup: z.strictObject({
      status: z
        .enum(BACKUP_HEALTH_STATUSES)
        .describe(
          "ok: the last completed base backup is at most 36 h old; stale: older; failing: the region reports failing, or the last failure is newer than the last completion; unknown: no report within 180 s, an unknown report, or no completed backup.",
        ),
      last_base_backup_at: describedTimestamp(
        "When the last completed base backup finished; null while none is known.",
      ).nullable(),
    }),
    disk: z.strictObject({
      status: z
        .enum(DISK_HEALTH_STATUSES)
        .describe(
          "warning: at least 90 % of the allocated storage is used; unknown: no usage sample within 180 s, or the sample measured nothing.",
        ),
      used_ratio: z
        .number()
        .nonnegative()
        .nullable()
        .describe(
          "Used bytes divided by allocated bytes in the newest sample; null when it measured nothing.",
        ),
    }),
  })
  .meta({ id: "DatabaseHealth" });
export type DatabaseHealth = z.infer<typeof DatabaseHealth>;

/** The newest volume figures the region's agent reported for a database. */
export const DatabaseStorage = z.strictObject({
  used_bytes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe(
      "Bytes used on the volume; null when the sample did not measure it.",
    ),
  allocated_bytes: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Bytes of the volume's capacity; null when unknown."),
  observed_at: describedTimestamp(
    "When the agent took the sample; judge its age yourself.",
  ),
});
export type DatabaseStorage = z.infer<typeof DatabaseStorage>;

/** A database's own idle time before it sleeps; null hands it back to its size class. */
const DatabaseSleepAfter = z
  .number()
  .int()
  .min(60)
  .max(900)
  .nullable()
  .describe(
    "The database's own idle time before it sleeps, 60 to 900 s; null when its size class's applies.",
  );

export const Database = z
  .strictObject({
    id: DatabaseId,
    project_id: ProjectId,
    region_id: RegionId,
    node_id: NodeId.nullable(),
    name: DatabaseName,
    size_class_id: SizeClassId,
    resources: DatabaseEffectiveResources.describe(
      "The memory, CPU and storage the database runs with: its own values set through PUT /v1/databases/{id}/resources, else its size class's.",
    ),
    sleep_after_seconds: DatabaseSleepAfter,
    effective_sleep_after_seconds: z
      .number()
      .int()
      .min(60)
      .max(2_592_000)
      .nullable()
      .describe(
        "The idle-sleep threshold: seconds without client activity before the database sleeps, its own sleep_after_seconds, else its size class's; null when the database is always warm.",
      ),
    desired_state: DesiredState,
    observed_state: ObservedState,
    suspension_reason: z.enum(["manual", "idle"]).nullable().optional(),
    generation: z.number().int().min(1),
    storage_generation: z.number().int().positive().optional(),
    observed_generation: z.number().int().min(0),
    status_message: z.string().max(TEXT_MAX_LENGTH).nullable(),
    health: DatabaseHealth,
    storage: DatabaseStorage.nullable().describe(
      "The newest volume figures from the region's agent; null before its first sample.",
    ),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Database" });
export type Database = z.infer<typeof Database>;

export const DatabaseListQuery = ListQuery.extend({
  project_id: ProjectId.optional(),
  region_id: RegionId.optional(),
  node_id: NodeId.optional(),
  desired_state: DesiredState.optional(),
  observed_state: ObservedState.optional(),
  name: DatabaseName.optional().describe(
    "Exact, case-sensitive name; names are unique among the live databases of a project.",
  ),
}).meta({ id: "DatabaseListQuery" });
export type DatabaseListQuery = z.infer<typeof DatabaseListQuery>;

export const DatabaseCreate = z
  .strictObject({
    project_id: ProjectId,
    region_id: RegionId,
    name: DatabaseName,
    size_class_id: SizeClassId,
    sleep_after_seconds: DatabaseSleepAfter.optional(),
    resources: DatabaseResourcesCreate.describe(
      "The database's own memory, CPU and storage instead of its size class's. Admin keys only (403 otherwise).",
    ).optional(),
  })
  .meta({ id: "DatabaseCreate" });
export type DatabaseCreate = z.infer<typeof DatabaseCreate>;

export const DatabasePatch = z
  .strictObject({
    name: DatabaseName.optional(),
    size_class_id: SizeClassId.optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.size_class_id !== undefined,
    { message: "at least one field is required" },
  )
  .meta({ id: "DatabasePatch" });
export type DatabasePatch = z.infer<typeof DatabasePatch>;

export const DatabaseResize = z
  .strictObject({ size_class_id: SizeClassId })
  .meta({ id: "DatabaseResize" });
export type DatabaseResize = z.infer<typeof DatabaseResize>;

export const DatabaseIdleTime = z
  .strictObject({ sleep_after_seconds: DatabaseSleepAfter })
  .meta({ id: "DatabaseIdleTime" });
export type DatabaseIdleTime = z.infer<typeof DatabaseIdleTime>;

export const DatabaseRestore = z
  .discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("full"),
      name: DatabaseName,
      region_id: RegionId.optional(),
    }),
    z.strictObject({
      mode: z.literal("pitr"),
      name: DatabaseName,
      target_time: Timestamp,
      region_id: RegionId.optional(),
    }),
  ])
  .meta({ id: "DatabaseRestore" });
export type DatabaseRestore = z.infer<typeof DatabaseRestore>;

// ---------- Roles and connection URIs ----------

/** PostgreSQL's CONNECTION LIMIT of an API role; omitted or null means unlimited. */
export const ROLE_CONNECTION_LIMIT_MAX = 10000;
/** The roles a new role can be made a member of. */
export const ROLE_MEMBER_OF_MAX = 8;
/** Roles of one database; the owner and roles whose removal is not confirmed count. */
export const ROLE_LIMIT = 100;

/**
 * The instant, in milliseconds since the epoch, from which PostgreSQL refuses the credential of a
 * role whose `valid_until` is given. The region hands the expiry to PostgreSQL as a Kubernetes
 * time, which holds whole seconds, and cuts the fraction: a role is refused from the start of the
 * second its expiry falls in. Everything that decides whether a role may log in uses this instant.
 */
export function roleExpiryInstant(validUntil: string): number {
  return Math.floor(Date.parse(validUntil) / 1000) * 1000;
}

const RoleConnectionLimit = z
  .number()
  .int()
  .min(1)
  .max(ROLE_CONNECTION_LIMIT_MAX);

export const Role = z
  .strictObject({
    database_id: DatabaseId,
    name: RoleName,
    owner: z.boolean(),
    password_revision: z.number().int().min(1),
    created_at: Timestamp,
    updated_at: Timestamp,
    valid_until: describedTimestamp(
      "PostgreSQL VALID UNTIL: from this time, truncated to the whole second, the role cannot log in; null means never. An open session is not ended by it.",
    ).nullable(),
    connection_limit: RoleConnectionLimit.nullable().describe(
      "PostgreSQL CONNECTION LIMIT: concurrent sessions of the role; null means unlimited.",
    ),
    member_of: z
      .array(RoleName)
      .max(ROLE_MEMBER_OF_MAX)
      .describe(
        "The roles this role is a member of and inherits privileges from, ordered by name.",
      ),
    bypass_rls: z
      .boolean()
      .describe(
        "PostgreSQL BYPASSRLS: the role ignores row-level security policies.",
      ),
  })
  .meta({
    id: "Role",
    examples: [
      {
        database_id: "ab12cd34ef56gh78ij90",
        name: "report_a1b2c3",
        owner: false,
        password_revision: 1,
        created_at: "2030-01-01T09:00:00.000Z",
        updated_at: "2030-01-01T09:00:00.000Z",
        valid_until: "2030-01-01T10:00:00.000Z",
        connection_limit: 5,
        member_of: ["reader"],
        bypass_rls: false,
      },
    ],
  });
export type Role = z.infer<typeof Role>;

export const RoleCreate = z
  .strictObject({
    name: RoleName,
    valid_until: describedTimestamp(
      "Must lie in the future when the request executes, truncated to the whole second PostgreSQL applies it at. PostgreSQL enforces it as VALID UNTIL; the edge refuses an expired role before it would wake a hibernated database. No maximum.",
    ).optional(),
    connection_limit: RoleConnectionLimit.describe(
      "PostgreSQL CONNECTION LIMIT, 1 to 10000; omitted means unlimited.",
    ).optional(),
    member_of: z
      .array(RoleName)
      .max(ROLE_MEMBER_OF_MAX)
      .meta({
        uniqueItems: true,
        description:
          "Distinct live roles of this database the role becomes a member of, at most 8; never `app`, `pgcf_maintenance`, `pg_*` or `cnpg_*`.",
      })
      .optional(),
    bypass_rls: z
      .boolean()
      .describe("PostgreSQL BYPASSRLS; defaults to false.")
      .optional(),
  })
  .refine((role) => role.name !== MAINTENANCE_ROLE, {
    path: ["name"],
    message: "Role name is reserved for internal maintenance",
  })
  .refine(
    (role) =>
      (role.member_of ?? []).every(
        (target) =>
          target !== OWNER_ROLE_NAME &&
          target !== MAINTENANCE_ROLE &&
          target !== role.name,
      ) && new Set(role.member_of).size === (role.member_of ?? []).length,
    {
      path: ["member_of"],
      message:
        "member_of names distinct roles other than the owner, the maintenance role and the role itself",
    },
  )
  .meta({
    id: "RoleCreate",
    examples: [
      {
        name: "report_a1b2c3",
        valid_until: "2030-01-01T10:00:00.000Z",
        connection_limit: 5,
        member_of: ["reader"],
      },
    ],
  });
export type RoleCreate = z.infer<typeof RoleCreate>;

/** The password is part of `uri` only for integrator keys; admin keys never see passwords. */
export const ConnectionUri = z
  .strictObject({
    database_id: DatabaseId,
    role: RoleName,
    host: z.string().min(1).max(253),
    database: DatabaseId,
    uri: z
      .string()
      .regex(/^postgres:\/\//)
      .max(2048),
    includes_password: z.boolean(),
  })
  .meta({ id: "ConnectionUri" });
export type ConnectionUri = z.infer<typeof ConnectionUri>;

// ---------- Operations ----------

export const OPERATION_KINDS = [
  "database.create",
  "database.restore",
  "database.delete",
  "database.resize",
  "database.suspend",
  "database.resume",
  "database.hibernate",
  "database.wake",
  "database.role.delete",
] as const;
export const OperationKind = z
  .enum(OPERATION_KINDS)
  .meta({ id: "OperationKind" });
export type OperationKind = z.infer<typeof OperationKind>;

export const OPERATION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export const OperationStatus = z
  .enum(OPERATION_STATUSES)
  .meta({ id: "OperationStatus" });
export type OperationStatus = z.infer<typeof OperationStatus>;

export const Operation = z
  .strictObject({
    id: OperationId,
    kind: OperationKind,
    status: OperationStatus,
    project_id: ProjectId,
    database_id: DatabaseId,
    generation: z.number().int().min(1),
    error: z
      .strictObject({
        code: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "Machine-readable reason of a failed operation, for example `operation_timeout`, `superseded`, `power_busy` or, for database.role.delete, `role_not_droppable`.",
          ),
        message: z.string().max(TEXT_MAX_LENGTH),
      })
      .nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    completed_at: Timestamp.nullable(),
  })
  .meta({ id: "Operation" });
export type Operation = z.infer<typeof Operation>;

/** Response of asynchronous writes such as POST and DELETE /v1/databases. */
export const DatabaseWithOperation = z
  .strictObject({ database: Database, operation: Operation })
  .meta({ id: "DatabaseWithOperation" });
export type DatabaseWithOperation = z.infer<typeof DatabaseWithOperation>;

// ---------- API keys ----------

export const ApiKey = z
  .strictObject({
    id: ApiKeyId,
    scope: ApiKeyScope,
    // A union, so that the component ProjectId is not made nullable for every other use.
    project_id: z.union([ProjectId, z.null()]),
    name: DisplayName,
    lookup_id: z.string().regex(/^[a-z0-9]{12}$/),
    created_at: Timestamp,
    revoked_at: Timestamp.nullable(),
  })
  .meta({ id: "ApiKey" });
export type ApiKey = z.infer<typeof ApiKey>;

/** Integrator keys are bound to one project; admin keys to none. */
export const ApiKeyCreate = z
  .strictObject({
    scope: ApiKeyScope,
    project_id: ProjectId.optional(),
    name: DisplayName,
  })
  .refine(
    (body) => (body.scope === "integrator") === (body.project_id !== undefined),
    {
      message: "integrator keys require project_id; admin keys must omit it",
      path: ["project_id"],
    },
  )
  .meta({
    id: "ApiKeyCreate",
    description:
      "An integrator key requires project_id and is bound to that project; an admin key must omit it. Anything else is a 400.",
  });
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;

/** The full key appears only in this creation response. */
export const ApiKeyCreated = z
  .strictObject({ api_key: ApiKey, key: ApiKeyString })
  .meta({ id: "ApiKeyCreated" });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

/** One base backup a restore can start from: its data and the WAL chain after it are archived. */
export const BaseBackup = z
  .strictObject({
    id: z
      .string()
      .regex(/^[0-9]{8}T[0-9]{6}$/)
      .describe("The backup's identifier in the archive."),
    started_at: Timestamp,
    completed_at: Timestamp,
  })
  .meta({ id: "BaseBackup" });
export type BaseBackup = z.infer<typeof BaseBackup>;

/**
 * What the archive of a database can restore. Both times are null while there is no complete base
 * backup with its WAL chain, or the archive cannot be read completely or is past its retention.
 */
export const BackupCatalog = z
  .strictObject({
    database_id: DatabaseId,
    earliest_restorable_time: describedTimestamp(
      "When the oldest restorable base backup finished: no `pitr` target before it can be restored.",
    ).nullable(),
    latest_restorable_time: describedTimestamp(
      "When the newest archived WAL segment was uploaded: an upper bound of the window. A `pitr` target after the last commit in the archive fails recovery; `full` restores everything archived.",
    ).nullable(),
    base_backups: z
      .array(BaseBackup)
      .max(64)
      .describe(
        "The restorable base backups, newest first; at most 64, the bound of the v1 recovery catalog.",
      ),
  })
  .meta({
    id: "BackupCatalog",
    examples: [
      {
        database_id: "ab12cd34ef56gh78ij90",
        earliest_restorable_time: "2030-01-01T03:00:38.000Z",
        latest_restorable_time: "2030-01-02T09:41:07.000Z",
        base_backups: [
          {
            id: "20300102T030000",
            started_at: "2030-01-02T03:00:00.000Z",
            completed_at: "2030-01-02T03:00:41.000Z",
          },
          {
            id: "20300101T030000",
            started_at: "2030-01-01T03:00:00.000Z",
            completed_at: "2030-01-01T03:00:38.000Z",
          },
        ],
      },
    ],
  });
export type BackupCatalog = z.infer<typeof BackupCatalog>;

export const DatabaseRestored = z
  .strictObject({ target_database: Database, operation: Operation })
  .meta({ id: "DatabaseRestored" });
export type DatabaseRestored = z.infer<typeof DatabaseRestored>;
