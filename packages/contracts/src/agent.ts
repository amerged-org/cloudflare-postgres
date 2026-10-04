// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  BucketName,
  OperationStatus,
  Timestamp,
  TEXT_MAX_LENGTH,
} from "./api.ts";
import { RolePassword } from "./auth.ts";
import {
  DATABASE_ID_PATTERN,
  DatabaseId,
  OPERATION_ID_PATTERN,
  OperationId,
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

export const DesiredSize = z.strictObject({
  memory_mib: z.number().int().min(256),
  cpu_millicores: z.number().int().min(100),
  storage_gib: z.number().int().min(1),
  max_connections: z.number().int().min(10),
  archive_timeout_seconds: z.number().int().min(30),
  backup_retention_days: z.number().int().min(1),
});
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

export const DesiredDatabase = z
  .strictObject({
    id: DatabaseId,
    generation: z.number().int().min(1),
    desired_state: z.enum(["running", "deleted"]),
    node: K8sNodeName,
    pg_major: z.literal(PG_MAJOR),
    size: DesiredSize,
    roles: z.array(DesiredRole).max(100).default([]),
    // Older desired pages omit this field; omission cannot authorize initial storage.
    creation: DesiredCreation.nullable().optional(),
    archive: z.strictObject({
      destination_path: z.string().regex(ARCHIVE_DESTINATION_PATTERN),
      server_name: z.literal(ARCHIVE_SERVER_NAME),
    }),
  })
  .superRefine((db, ctx) => {
    const match = ARCHIVE_DESTINATION_PATTERN.exec(db.archive.destination_path);
    // Desired revisions advance for role changes and deletion without replacing the archive.
    if (match && (match[3] !== db.id || Number(match[4]) > db.generation)) {
      ctx.addIssue({
        code: "custom",
        path: ["archive", "destination_path"],
        message:
          "archive path must name this database and not a future generation",
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
    const names = new Set<string>();
    let owners = 0;
    for (const role of db.roles) {
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
    if (owners > 1 || (db.desired_state === "running" && owners !== 1)) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "running databases require exactly one owner role",
      });
    }
  });
export type DesiredDatabase = z.infer<typeof DesiredDatabase>;

export const DesiredResponse = z
  .strictObject({
    region: z.strictObject({
      id: RegionId,
      backup: z.strictObject({
        bucket: BucketName,
        endpoint_url: z.url({ protocol: /^https$/ }),
        region: z.literal("auto"),
      }),
    }),
    databases: z.array(DesiredDatabase).max(DESIRED_PAGE_LIMIT_MAX),
    next: DatabaseId.nullable(),
  })
  .superRefine((response, ctx) => {
    response.databases.forEach((database, index) => {
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
  "ready",
  "error",
  "deleting",
  "deleted",
] as const;

export const NodeObservation = z.strictObject({
  name: K8sNodeName,
  ready: z.boolean(),
  allocatable_memory_mib: Count,
  allocatable_cpu_millicores: Count,
  storage_gib_total: Count.nullable(),
  platform_reserved_memory_mib: Count,
  platform_reserved_cpu_millicores: Count.nullable().optional(),
});
export type NodeObservation = z.infer<typeof NodeObservation>;

export const DatabaseObservation = z.strictObject({
  id: DatabaseId,
  generation: z.number().int().min(1),
  state: z.enum(DATABASE_OBSERVED_STATES),
  message: z.string().max(TEXT_MAX_LENGTH).optional(),
  archive: z.strictObject({
    continuous: z.boolean(),
    ready_wal_files: Count.nullable(),
  }),
});
export type DatabaseObservation = z.infer<typeof DatabaseObservation>;

/** A namespace labelled `pgcf.io/database-id` that desired state does not name; reported, never deleted. */
export const Orphan = z.strictObject({
  namespace: z.string().min(1).max(63),
  database_id: z.string().max(253).nullable(),
});
export type Orphan = z.infer<typeof Orphan>;

export const ObservationRequest = z.strictObject({
  observed_at: Timestamp,
  nodes: z.array(NodeObservation).max(1000),
  databases: z.array(DatabaseObservation).max(10_000),
  orphans: z.array(Orphan).max(1000),
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
