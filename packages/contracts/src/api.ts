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
  ApiKeyId,
  DatabaseId,
  NodeId,
  OperationId,
  ProjectId,
  RegionId,
  RoleName,
  SizeClassId,
} from "./ids.ts";

/** ISO-8601 UTC timestamp exactly as Date#toISOString renders it. */
export const Timestamp = z.iso
  .datetime({ precision: 3 })
  .meta({ id: "Timestamp" });
export type Timestamp = z.infer<typeof Timestamp>;

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

/** Administrator-only synchronization after independently verified Kubernetes readback. */
const BootstrapMaterialDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const RegionBootstrapMaterialUpdate = z.strictObject({
  expected_revision: z.number().int().min(1).max(2147483646),
  kubernetes_version: z.enum(["1.36.3", "1.36.5"]),
  talos_version: z
    .string()
    .regex(/^v?\d+\.\d+\.\d+$/)
    .optional(),
  expected_seed_sha256: BootstrapMaterialDigest,
  expected_join_sha256: BootstrapMaterialDigest,
  seed_sha256: BootstrapMaterialDigest,
  join_sha256: BootstrapMaterialDigest,
  provenance_sha256: BootstrapMaterialDigest,
  observed: z.strictObject({
    observed_at: Timestamp,
    kube_system_uid: z.uuid(),
    kubernetes_version: z.enum(["1.36.3", "1.36.5"]),
    talos_version: z
      .string()
      .regex(/^v?\d+\.\d+\.\d+$/)
      .optional(),
    nodes: z
      .array(
        z.strictObject({
          node_id: NodeId,
          node_uid: z.uuid(),
          k8s_node_name: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,252}$/),
          provider_instance_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
        }),
      )
      .min(1)
      .max(16),
  }),
});
export type RegionBootstrapMaterialUpdate = z.infer<
  typeof RegionBootstrapMaterialUpdate
>;
export const RegionBootstrapMaterialStatus = z.strictObject({
  region_id: RegionId,
  revision: z.number().int().min(1).max(2147483647),
  kubernetes_version: z.enum(["1.36.3", "1.36.5"]),
  talos_version: z
    .string()
    .regex(/^v?\d+\.\d+\.\d+$/)
    .optional(),
  seed_sha256: BootstrapMaterialDigest,
  join_sha256: BootstrapMaterialDigest,
  provenance_sha256: BootstrapMaterialDigest.nullable(),
});
export type RegionBootstrapMaterialStatus = z.infer<
  typeof RegionBootstrapMaterialStatus
>;

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
export function encodeCursor(cursor: Cursor): string {
  if (!isCanonicalTimestamp(cursor.created_at)) {
    throw new TypeError("cursor created_at must be a canonical timestamp");
  }
  if (!CURSOR_ID_PATTERN.test(cursor.id)) {
    throw new TypeError("cursor id is malformed");
  }
  return bytesToBase64url(
    new TextEncoder().encode(`${cursor.created_at}|${cursor.id}`),
  );
}

export function decodeCursor(value: string): Cursor | null {
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
  if (!isCanonicalTimestamp(createdAt) || !CURSOR_ID_PATTERN.test(id))
    return null;
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
  sleep_after_seconds: z.number().int().min(60).max(2_592_000).nullable(),
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
  .meta({ id: "SizeClass" });
export type SizeClass = z.infer<typeof SizeClass>;

/** Body of PUT /v1/size-classes/{id}. */
export const SizeClassUpsert = z
  .strictObject({
    ...SizeClassFields,
    memory_mib: SizeClassFields.memory_mib.multipleOf(256),
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
  .meta({ id: "SizeClassUpsert" });
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

export const DatabaseHealth = z
  .strictObject({
    archiving: ArchivingHealth,
    since: Timestamp.nullable(),
  })
  .meta({ id: "DatabaseHealth" });
export type DatabaseHealth = z.infer<typeof DatabaseHealth>;

export const Database = z
  .strictObject({
    id: DatabaseId,
    project_id: ProjectId,
    region_id: RegionId,
    name: DatabaseName,
    size_class_id: SizeClassId,
    desired_state: DesiredState,
    observed_state: ObservedState,
    suspension_reason: z.enum(["manual", "idle"]).nullable().optional(),
    generation: z.number().int().min(1),
    storage_generation: z.number().int().positive().optional(),
    observed_generation: z.number().int().min(0),
    status_message: z.string().max(TEXT_MAX_LENGTH).nullable(),
    health: DatabaseHealth,
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Database" });
export type Database = z.infer<typeof Database>;

export const DatabaseCreate = z
  .strictObject({
    project_id: ProjectId,
    region_id: RegionId,
    name: DatabaseName,
    size_class_id: SizeClassId,
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

export const Role = z
  .strictObject({
    database_id: DatabaseId,
    name: RoleName,
    owner: z.boolean(),
    password_revision: z.number().int().min(1),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .meta({ id: "Role" });
export type Role = z.infer<typeof Role>;

export const RoleCreate = z
  .strictObject({ name: RoleName })
  .refine((role) => role.name !== MAINTENANCE_ROLE, {
    path: ["name"],
    message: "Role name is reserved for internal maintenance",
  })
  .meta({ id: "RoleCreate" });
export type RoleCreate = z.infer<typeof RoleCreate>;

/** The password is part of `uri` only for integrator keys; admin keys never see passwords. */
export const ConnectionUri = z
  .strictObject({
    database_id: DatabaseId,
    role: RoleName,
    host: z.string().min(1).max(253),
    database: DatabaseId,
    uri: z.string().startsWith("postgres://").max(2048),
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
        code: z.string().min(1).max(64),
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
    project_id: ProjectId.nullable(),
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
  .meta({ id: "ApiKeyCreate" });
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;

/** The full key appears only in this creation response. */
export const ApiKeyCreated = z
  .strictObject({ api_key: ApiKey, key: ApiKeyString })
  .meta({ id: "ApiKeyCreated" });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

export const DatabaseRestored = z
  .strictObject({ target_database: Database, operation: Operation })
  .meta({ id: "DatabaseRestored" });
export type DatabaseRestored = z.infer<typeof DatabaseRestored>;
