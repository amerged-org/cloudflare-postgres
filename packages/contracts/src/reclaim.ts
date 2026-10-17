// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, OperationId, RegionId, RoleName } from "./ids.ts";
export const RECLAIM_LIMITS = {
  lease_ms: 5000,
  clock_skew_ms: 1000,
  max_token_bytes: 8192,
  max_envelope_bytes: 2 * 1024 * 1024,
  max_budget_bytes: 134217728,
  max_step_bytes: 8388608,
  snapshot_ms: 2000,
  max_tasks: 4096,
} as const;
const Safe = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  Hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Flat signed wire schema; no arbitrary cgroup path or PostgreSQL credential is accepted. */
export const ReclaimClaims = z.strictObject({
  v: z.literal(1),
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  database_id: DatabaseId,
  operation_id: OperationId,
  intent_revision: Safe.positive(),
  generation: Safe.positive(),
  storage_generation: Safe.positive(),
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  cluster_uid: z.uuid(),
  namespace_uid: z.uuid(),
  cnpg_cluster_uid: z.uuid(),
  storage_uid: z.uuid(),
  pvc_uid: z.uuid(),
  pv_uid: z.uuid(),
  pod_uid: z.uuid(),
  container_id: Hash,
  postgres_image_sha256: Hash,
  mode: z.enum(["reclaim", "revoked"]),
  budget_bytes: Safe.max(RECLAIM_LIMITS.max_budget_bytes),
  step_bytes: Safe.max(RECLAIM_LIMITS.max_step_bytes),
  memory_request_bytes: Safe.positive(),
  memory_limit_bytes: Safe.positive(),
  issued_at: Safe,
  expires_at: Safe,
});
export type ReclaimClaims = z.infer<typeof ReclaimClaims>;
export const DatabaseRuntimeAttestationV1 = z
  .strictObject({
    v: z.literal(1),
    database_id: DatabaseId,
    generation: Safe.positive(),
    storage_generation: Safe.positive(),
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    cluster_uid: z.uuid(),
    namespace_uid: z.uuid(),
    cnpg_cluster_uid: z.uuid(),
    storage_uid: z.uuid(),
    pvc_uid: z.uuid(),
    pv_uid: z.uuid(),
    pod_uid: z.uuid(),
    container_id: Hash,
    postgres_image_sha256: Hash,
    memory_request_bytes: Safe.positive(),
    memory_limit_bytes: Safe.positive(),
    observed_at: Safe,
    configuration_fingerprint: Hash,
  })
  .refine((v) => v.memory_request_bytes <= v.memory_limit_bytes, {
    message: "Runtime request exceeds hard limit",
  });
const ResourceVersion = z.string().min(1).max(128);
export const DATABASE_RUNTIME_PROOF_MAX_AGE_MS = 60_000;
export const DatabaseRuntimeObservationContinuity = z.strictObject({
  v: z.literal(1),
  controller_epoch: Hash,
  watch_epoch: Safe.positive(),
  coverage: z.literal("complete"),
  verified_at: Safe,
  expires_at: Safe,
  resource_versions: z.strictObject({
    namespace: ResourceVersion,
    cluster: ResourceVersion,
    pod: ResourceVersion,
    ca_secret: ResourceVersion,
    storage: ResourceVersion,
    pvc: ResourceVersion,
    pv: ResourceVersion,
    node: ResourceVersion,
  }),
});
export const DatabaseRuntimeAttestationV2 = z
  .strictObject({
    ...DatabaseRuntimeAttestationV1.shape,
    v: z.literal(2),
    region_id: RegionId,
    route_revision: Safe.positive(),
    admission_epoch: Safe.positive(),
    applied_role_revisions: z
      .array(z.strictObject({ name: RoleName, revision: Safe.positive() }))
      .max(100),
    tls_server_name: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9.-]+$/),
    ca_secret_uid: z.uuid(),
    ca_secret_resource_version: ResourceVersion,
    ca_sha256: Hash,
    pod_ip: z.union([z.ipv4(), z.ipv6()]),
    postgres_port: z.literal(5432),
    observation: DatabaseRuntimeObservationContinuity,
  })
  .superRefine((proof, context) => {
    if (proof.memory_request_bytes > proof.memory_limit_bytes)
      context.addIssue({
        code: "custom",
        message: "Runtime request exceeds hard limit",
      });
    if (
      new Set(proof.applied_role_revisions.map((role) => role.name)).size !==
      proof.applied_role_revisions.length
    )
      context.addIssue({
        code: "custom",
        path: ["applied_role_revisions"],
        message: "Duplicate applied role revision",
      });
    if (
      proof.observation.verified_at !== proof.observed_at ||
      proof.observation.expires_at !==
        proof.observed_at + DATABASE_RUNTIME_PROOF_MAX_AGE_MS ||
      proof.observation.resource_versions.ca_secret !==
        proof.ca_secret_resource_version
    )
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message:
          "Observation must bind the same verified runtime and CA revision",
      });
  });
export type DatabaseRuntimeAttestationV2 = z.infer<
  typeof DatabaseRuntimeAttestationV2
>;
export const DatabaseRuntimeAttestation = z.union([
  DatabaseRuntimeAttestationV1,
  DatabaseRuntimeAttestationV2,
]);
export type DatabaseRuntimeAttestation = z.infer<
  typeof DatabaseRuntimeAttestation
>;
/** Nonsecret configuration input; power/activity transitions and passwords never enter this digest. */
export function reclaimConfigurationInput(
  db: {
    pg_major: number;
    size: {
      memory_mib: number;
      memory_request_mib?: number;
      cpu_millicores: number;
      cpu_request_millicores?: number;
      storage_gib: number;
      max_connections: number;
      archive_timeout_seconds: number;
      backup_retention_days: number;
    };
    postgres?: { image: string };
    /** Roles awaiting removal (`state: "absent"`) are not part of the configuration. */
    roles: (
      | { name: string; owner: boolean; revision: number }
      | { name: string; state: "absent" }
    )[];
    maintenance?: { revision: number };
    storage_generation?: number;
    archive: { destination_path: string; server_name: string };
    storage?: {
      backend: string;
      storage_class: string;
      volume_attributes_class: string;
      profile_revision: number;
      profile_sha256: string;
      node_uid: string;
      volume_group_uuid: string;
      pool_uuid: string;
      startup_reserve_bytes: number;
      write_bytes_per_second: number;
      write_iops_per_second: number;
      guard_seconds: number;
      drain_seconds: number;
    };
  },
  fallbackImage: string,
): unknown[] {
  const size = db.size,
    storage = db.storage;
  return [
    "pgcf-config/v1",
    db.pg_major,
    db.postgres?.image ?? fallbackImage,
    [
      size.memory_mib,
      size.memory_request_mib ?? size.memory_mib,
      size.cpu_millicores,
      size.cpu_request_millicores ?? size.cpu_millicores,
      size.storage_gib,
      size.max_connections,
      size.archive_timeout_seconds,
      size.backup_retention_days,
    ],
    db.storage_generation ?? 1,
    db.archive.destination_path,
    db.archive.server_name,
    db.roles
      .filter(
        (r): r is Extract<typeof r, { revision: number }> => !("state" in r),
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((r) => [r.name, r.owner, r.revision]),
    db.maintenance?.revision ?? null,
    storage
      ? [
          storage.backend,
          storage.storage_class,
          storage.volume_attributes_class,
          storage.profile_revision,
          storage.profile_sha256,
          storage.node_uid,
          storage.volume_group_uuid,
          storage.pool_uuid,
          storage.startup_reserve_bytes,
          storage.write_bytes_per_second,
          storage.write_iops_per_second,
          storage.guard_seconds,
          storage.drain_seconds,
        ]
      : null,
  ];
}
export async function reclaimConfigurationFingerprint(
  db: Parameters<typeof reclaimConfigurationInput>[0],
  fallbackImage: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(reclaimConfigurationInput(db, fallbackImage)),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
