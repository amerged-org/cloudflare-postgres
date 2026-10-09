// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { DatabaseId, OperationId } from "./ids.ts";
import { bytesToBase64url, base64urlToBytes } from "./encoding.ts";
export const RECLAIM_PREFIX = "rc1";
export const RECLAIM_DOMAIN = "pgcf-reclaim-authority/v1\n";
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
export function reclaimClaimsValidAt(
  value: ReclaimClaims,
  now: number,
): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= 0 &&
    value.issued_at <= now + RECLAIM_LIMITS.clock_skew_ms &&
    value.expires_at > now &&
    value.expires_at > value.issued_at &&
    value.expires_at <= value.issued_at + RECLAIM_LIMITS.lease_ms &&
    value.memory_request_bytes < value.memory_limit_bytes &&
    (value.mode === "revoked"
      ? value.budget_bytes === 0 && value.step_bytes === 0
      : value.budget_bytes > 0 &&
        value.step_bytes > 0 &&
        value.step_bytes <= value.budget_bytes)
  );
}
export type ReclaimCryptoKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;
export async function signReclaimIntent(
  value: ReclaimClaims,
  key: ReclaimCryptoKey,
  now = Date.now(),
): Promise<string> {
  const claims = ReclaimClaims.parse(value);
  if (
    key.type !== "private" ||
    key.algorithm.name !== "Ed25519" ||
    !reclaimClaimsValidAt(claims, now)
  )
    throw new Error("invalid_reclaim_signing_authority");
  const body = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key,
    new TextEncoder().encode(RECLAIM_DOMAIN + body),
  );
  const token = `${RECLAIM_PREFIX}.${body}.${bytesToBase64url(new Uint8Array(signature))}`;
  if (token.length > RECLAIM_LIMITS.max_token_bytes)
    throw new Error("reclaim_intent_too_large");
  return token;
}
export async function verifyReclaimIntent(
  token: string,
  keys: ReadonlyMap<string, ReclaimCryptoKey>,
  now = Date.now(),
): Promise<ReclaimClaims | null> {
  if (token.length > RECLAIM_LIMITS.max_token_bytes) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== RECLAIM_PREFIX) return null;
  const body = base64urlToBytes(parts[1]!),
    signature = base64urlToBytes(parts[2]!);
  if (
    !body ||
    !signature ||
    signature.length !== 64 ||
    bytesToBase64url(body) !== parts[1] ||
    bytesToBase64url(signature) !== parts[2]
  )
    return null;
  try {
    const parsed = ReclaimClaims.safeParse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          body,
        ),
      ),
    );
    if (!parsed.success || !reclaimClaimsValidAt(parsed.data, now)) return null;
    const key = keys.get(parsed.data.kid);
    if (!key || key.type !== "public" || key.algorithm.name !== "Ed25519")
      return null;
    return (await crypto.subtle.verify(
      "Ed25519",
      key,
      new Uint8Array(signature),
      new TextEncoder().encode(RECLAIM_DOMAIN + parts[1]),
    ))
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
export const ReclaimTaskSnapshot = z.strictObject({
  v: z.literal(1),
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  pid_namespace_inode: Safe.positive(),
  cri_pid_namespace_inode: Safe.positive(),
  captured_at: Safe,
  expires_at: Safe,
  tasks: z
    .array(
      z.strictObject({
        database_id: DatabaseId,
        namespace: z.string().regex(/^pgcf-db-[a-z][a-z0-9]{19}$/),
        pod_uid: z.uuid(),
        container_id: Hash,
        container_name: z.literal("postgres"),
        pid: Safe.positive(),
        cri_pid: Safe.positive(),
        start_ticks: Safe.positive(),
        cgroup_path: z.string().min(1).max(4096),
        cgroup_inode: Safe.positive(),
        postgres_image_id: z.string().min(1).max(512),
      }),
    )
    .max(RECLAIM_LIMITS.max_tasks),
});
export type ReclaimTaskSnapshot = z.infer<typeof ReclaimTaskSnapshot>;
export const RECLAIM_FILES = {
  tasks: "/run/pgcf-reclaim-input/reclaim.json",
  intents: "/run/pgcf-reclaim-input/reclaim-intents.json",
  state: "/var/lib/pgcf-reclaimer/state.json",
  report: "/run/pgcf-reclaimer/report.json",
} as const;

export const WarmReclaimPolicy = z
  .strictObject({
    idle_after_seconds: Safe.min(60).max(2592000),
    budget_bytes: Safe.positive().max(RECLAIM_LIMITS.max_budget_bytes),
    step_bytes: Safe.positive().max(RECLAIM_LIMITS.max_step_bytes),
  })
  .refine((v) => v.step_bytes <= v.budget_bytes, {
    message: "Reclaim step exceeds its episode budget",
  });
export type WarmReclaimPolicy = z.infer<typeof WarmReclaimPolicy>;
export const DatabaseRuntimeAttestation = z
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
export type DatabaseRuntimeAttestation = z.infer<
  typeof DatabaseRuntimeAttestation
>;
export const NodeWarmReclaimQualification = z.strictObject({
  v: z.literal(1),
  revision: Safe.positive(),
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  cluster_uid: z.uuid(),
  material_revision: Safe.positive(),
  release_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/),
  kernel_version: z.string().min(1).max(128),
  proof_sha256: Hash,
  qualified_at: Safe,
  worker: z.literal(true),
  isolated_worker_accepted: z.literal(true),
  cgroup_v2: z.literal(true),
  limited_swap: z.literal(true),
  encrypted_swap_bytes: Safe.positive(),
  encrypted_swap_dm_uuids: z
    .array(
      z
        .string()
        .max(253)
        .regex(/^CRYPT-LUKS2-[a-f0-9]{32}-[A-Za-z0-9._-]+$/),
    )
    .min(1)
    .max(8),
  system_services_excluded: z.literal(true),
});
export type NodeWarmReclaimQualification = z.infer<
  typeof NodeWarmReclaimQualification
>;
export const ReclaimIntentSnapshot = z
  .strictObject({
    purpose: z.literal("pgcf-reclaim-intents/v1"),
    node_uid: z.uuid(),
    boot_id: z.uuid(),
    material_revision: Safe.positive(),
    issued_at: Safe,
    expires_at: Safe,
    tokens: z
      .array(z.string().max(RECLAIM_LIMITS.max_token_bytes))
      .max(RECLAIM_LIMITS.max_tasks),
  })
  .refine(
    (v) =>
      v.expires_at > v.issued_at &&
      v.expires_at <= v.issued_at + RECLAIM_LIMITS.snapshot_ms,
    { message: "Reclaim delivery must be short lived" },
  );
export type ReclaimIntentSnapshot = z.infer<typeof ReclaimIntentSnapshot>;
const ReclaimMetrics = z.strictObject({
  memory_current_bytes: Safe,
  swap_current_bytes: Safe,
  memory_stat: z.strictObject({
    anon: Safe.optional(),
    file: Safe.optional(),
    shmem: Safe.optional(),
    zswap: Safe.optional(),
    zswapped: Safe.optional(),
    pswpin: Safe.optional(),
    pswpout: Safe.optional(),
    pgfault: Safe.optional(),
    pgmajfault: Safe.optional(),
  }),
});
export const ReclaimObservation = z.strictObject({
  database_id: DatabaseId,
  operation_id: OperationId,
  intent_revision: Safe.positive(),
  generation: Safe.positive(),
  storage_generation: Safe.positive(),
  pod_uid: z.uuid(),
  container_id: Hash,
  observed_at: Safe,
  outcome: z.enum(["requested", "partial", "unknown", "revoked"]),
  in_flight: z.boolean(),
  requested_total_bytes: Safe.nullable().optional(),
  elapsed_ms: Safe.optional(),
  before: ReclaimMetrics.optional(),
  after: ReclaimMetrics.nullable().optional(),
  reclaimed_bytes: z.null().optional(),
});
export type ReclaimObservation = z.infer<typeof ReclaimObservation>;
export const ReclaimObservations = z.strictObject({
  purpose: z.literal("pgcf-reclaim-observations/v1"),
  node_uid: z.uuid(),
  boot_id: z.uuid(),
  material_revision: Safe.positive(),
  observed_at: Safe,
  results: z.array(ReclaimObservation).max(RECLAIM_LIMITS.max_tasks),
});
export type ReclaimObservations = z.infer<typeof ReclaimObservations>;

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
    roles: { name: string; owner: boolean; revision: number }[];
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
    [...db.roles]
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
