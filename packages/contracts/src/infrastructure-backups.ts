// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { NodeId, RegionId } from "./ids.ts";
import { NodeOperatorKubernetesBinding } from "./node-operator.ts";
import { bootstrapLiteralIpSchema } from "./bootstrap-relay.ts";

export const InfrastructureBackupKind = z.enum(["etcd", "d1"]);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const HttpsUrl = z
  .url()
  .max(4096)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  });
const Email = z.email().max(320);
const ConfigFields = {
  enabled: z
    .boolean()
    .describe(
      "Daily encrypted capture of the control D1 database and each regional etcd into R2. Enabling needs the D1 identity, the INFRASTRUCTURE_BACKUP Workflow binding and the INFRASTRUCTURE_BACKUP_CF_TOKEN secret.",
    ),
  d1_account_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable()
    .describe("Cloudflare account ID of the control D1 database."),
  d1_database_id: z
    .uuid()
    .nullable()
    .describe("ID of the control D1 database to export."),
  d1_region_id: RegionId.nullable().describe(
    "Existing region whose R2 archive bucket stores the D1 export.",
  ),
  notification_recipient: Email.nullable().describe(
    "Address that receives infrastructure alert emails. Email is sent only when the Worker secret RESEND_API_KEY and both addresses are set and no valid alert webhook is configured; null disables email.",
  ),
  notification_sender: Email.nullable().describe(
    "From address of alert emails. It must belong to a domain verified in the Resend account of RESEND_API_KEY; a rejected send stays undelivered and is retried. null disables email.",
  ),
};
export const InfrastructureBackupConfigInput = z
  .strictObject(ConfigFields)
  .superRefine((value, ctx) => {
    if (
      value.enabled &&
      (!value.d1_account_id || !value.d1_database_id || !value.d1_region_id)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Enabled daily backups require the control D1 identity and an existing R2 region",
      });
  });
export const InfrastructureBackupConfig = z.strictObject({
  ...ConfigFields,
  revision: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Incremented by every successful PUT. Alert email changes preserve valid in-progress backups and their deadlines. Changing enabled or the D1 account, database or archive region invalidates earlier capture authority; later email changes cannot revive it.",
    ),
  enabled_at: Timestamp.nullable().describe(
    "When backups were last enabled; null while disabled. Freshness counts from here until a backup completes.",
  ),
  updated_at: Timestamp.nullable().describe(
    "Time of the last PUT; null before the first one.",
  ),
});
export type InfrastructureBackupConfig = z.infer<
  typeof InfrastructureBackupConfig
>;

export const InfrastructureBackupArtifactIdentity = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  kind: InfrastructureBackupKind,
  day: z.iso.date(),
  region_id: RegionId,
  source_id: z.string().min(1).max(256),
  node_id: NodeId.nullable(),
  node_uid: z.uuid().nullable(),
  cluster_uid: z.uuid().nullable(),
  material_revision: z.number().int().positive().nullable(),
});
export type InfrastructureBackupArtifactIdentity = z.infer<
  typeof InfrastructureBackupArtifactIdentity
>;
export const InfrastructureBackupSource = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  node_address: bootstrapLiteralIpSchema,
  kubeconfig: z
    .string()
    .min(1)
    .max(256 * 1024),
  talosconfig: z
    .string()
    .min(1)
    .max(256 * 1024),
  binding: NodeOperatorKubernetesBinding,
  operator_url: HttpsUrl,
  operator_token: z.string().min(32).max(512),
  cilium_image: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
  cilium_image_id: z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/),
});
export const InfrastructureBackupArtifactInput =
  InfrastructureBackupArtifactIdentity.safeExtend({
    d1_url: HttpsUrl.optional(),
    source: InfrastructureBackupSource.optional(),
  }).superRefine((value, ctx) => {
    if (
      value.kind === "d1" &&
      (!value.d1_url ||
        value.source ||
        value.node_id ||
        value.node_uid ||
        value.cluster_uid ||
        value.material_revision)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "D1 backup requires only its signed export URL and source identity",
      });
    if (
      value.kind === "etcd" &&
      (!value.source ||
        value.d1_url ||
        !value.node_id ||
        !value.node_uid ||
        !value.cluster_uid ||
        !value.material_revision)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Etcd backup requires the complete current node/cluster authority",
      });
    if (
      value.source &&
      (value.source.node_id !== value.node_id ||
        value.source.node_uid !== value.node_uid ||
        value.source.binding.node_uid !== value.node_uid ||
        value.source.binding.cluster_uid !== value.cluster_uid ||
        value.source.binding.material_revision !== value.material_revision)
    )
      ctx.addIssue({
        code: "custom",
        message: "Snapshot source does not match its bound identity",
      });
  });
export const InfrastructureBackupInput = z
  .strictObject({
    run_id: z.uuid(),
    artifacts: z.array(InfrastructureBackupArtifactInput).min(1).max(65),
    encryption: z.strictObject({
      kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
      key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    }),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.artifacts.map((artifact) => artifact.id)).size !==
      value.artifacts.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate infrastructure backup artifact",
      });
  });
export type InfrastructureBackupInput = z.infer<
  typeof InfrastructureBackupInput
>;
export const InfrastructureBackupPreparedArtifact =
  InfrastructureBackupArtifactIdentity.safeExtend({
    run_id: z.uuid(),
    kid: z.string().min(1).max(64),
    plaintext_sha256: Sha256,
    plaintext_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024),
    encrypted_sha256: Sha256,
    encrypted_bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024 + 16384),
  });
export type InfrastructureBackupPreparedArtifact = z.infer<
  typeof InfrastructureBackupPreparedArtifact
>;
export const InfrastructureBackupArtifactStatus =
  InfrastructureBackupArtifactIdentity.safeExtend({
    status: z
      .enum(["pending", "prepared", "complete", "failed"])
      .describe(
        "pending, then prepared (encrypted and hashed), then complete (stored in R2 and fully read back); failed otherwise.",
      ),
    completed_at: Timestamp.nullable(),
    error_code: z.string().max(128).nullable(),
    object_key: z
      .string()
      .max(1024)
      .describe(
        "Key in the region's R2 archive bucket: infrastructure/v1/<day>/<run>/<artifact>.pgcfenc.",
      ),
    kid: z
      .string()
      .max(64)
      .nullable()
      .describe("Credential key version the encryption key is derived from."),
    plaintext_sha256: Sha256.nullable(),
    plaintext_bytes: z.number().int().nonnegative().nullable(),
    encrypted_sha256: Sha256.nullable(),
    encrypted_bytes: z.number().int().nonnegative().nullable(),
  });
export const InfrastructureBackupRunStatus = z.strictObject({
  id: z.uuid(),
  day: z.iso.date().describe("UTC day; at most one complete run per day."),
  attempt: z
    .number()
    .int()
    .positive()
    .describe(
      "Attempt within the UTC day, from 1. A failed attempt is retried at least 90 minutes after it ended, at most 3 attempts per day. A due attempt held back by a fleet patch or a starting thin database takes no number: see deferral in GET /v1/infrastructure-backups.",
    ),
  status: z
    .enum(["pending", "running", "complete", "failed"])
    .describe(
      "pending: recorded, capture not started; running: artifacts fixed, capture in progress; complete: every artifact complete; failed: see error_code, for example infrastructure_backup_deadline after two hours.",
    ),
  created_at: Timestamp,
  completed_at: Timestamp.nullable(),
  error_code: z.string().max(128).nullable(),
  artifacts: z
    .array(InfrastructureBackupArtifactStatus)
    .max(65)
    .describe(
      "d1-control plus one etcd-<region> per captured regional cluster.",
    ),
});
export const InfrastructureBackupDeferral = z.strictObject({
  day: z.iso.date().describe("UTC day of the held-back attempt."),
  reason: z
    .enum(["deferred_by_patch", "deferred_by_thin_start"])
    .describe(
      "deferred_by_patch: a fleet patch operation is unfinished (not complete or host_ready, not halted, before its deadline, on a node that is not lost) or changed in the last 15 minutes. deferred_by_thin_start: a thin database start granted in the last 15 minutes is not yet ready.",
    ),
  first_at: Timestamp.describe("First Cron check that held an attempt back."),
  last_at: Timestamp.describe(
    "Latest Cron check that held an attempt back; the Cron checks every minute, so a value older than a few minutes means the wait ended.",
  ),
  checks: z
    .number()
    .int()
    .positive()
    .describe("Number of Cron checks that held an attempt back on this day."),
});
export const InfrastructureBackupHealth = z.strictObject({
  kind: InfrastructureBackupKind,
  region_id: RegionId,
  status: z
    .enum(["disabled", "ok", "unknown", "stale", "failing"])
    .describe(
      "disabled: backups are off. unknown: the expected source cannot be identified, or nothing completed yet within 36 h of enabling. failing: the latest failed attempt ended at or after the last completed backup (or the enabling); it stays failing while a retry runs, and a later complete attempt clears it. stale: no completed backup for more than 36 h, counted from enabling when none exists. ok otherwise. failing raises infrastructure_backup_failed and stale raises infrastructure_backup_stale for the region.",
    ),
  last_completed_at: Timestamp.nullable().describe(
    "Latest completed backup of this kind, region and source from a complete attempt.",
  ),
  last_failed_at: Timestamp.nullable().describe(
    "End of the latest failed attempt of any artifact.",
  ),
  error_code: z
    .string()
    .max(128)
    .nullable()
    .describe("Error code of the latest failed attempt of any artifact."),
});
