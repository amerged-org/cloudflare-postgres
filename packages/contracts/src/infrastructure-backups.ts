// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Timestamp } from "./api.ts";
import { RegionId } from "./ids.ts";

export const InfrastructureBackupKind = z.enum(["d1"]);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Email = z.email().max(320);
const ConfigFields = {
  enabled: z
    .boolean()
    .describe(
      "Daily encrypted capture of the control D1 database into R2. Enabling needs the D1 identity, the INFRASTRUCTURE_BACKUP Workflow binding and the INFRASTRUCTURE_BACKUP_CF_TOKEN secret.",
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
    "Existing region the D1 export is recorded under; the export is stored in the installation's one R2 archive bucket.",
  ),
  notification_recipient: Email.nullable().describe(
    "Address that receives infrastructure alert emails. This legacy address is combined with notification_recipients, without duplicates. Email and webhook delivery are independent; RESEND_API_KEY and notification_sender are required.",
  ),
  notification_recipients: z
    .array(Email)
    .max(10)
    .optional()
    .describe(
      "Additional independent alert email destinations, combined with notification_recipient without case-insensitive duplicates. Omitted on PUT preserves the stored list; [] clears it. Each has its own delivery receipt and retry.",
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
          "Enabled daily backups require the control D1 identity and an existing region to record the export under",
      });
  });
export const InfrastructureBackupConfig = z.strictObject({
  ...ConfigFields,
  notification_recipients: z.array(Email).max(10).default([]),
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
});
export type InfrastructureBackupArtifactIdentity = z.infer<
  typeof InfrastructureBackupArtifactIdentity
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
        "Key in the installation's R2 archive bucket: infrastructure/v1/<day>/<run>/<artifact>.pgcfenc.",
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
      "Attempt within the UTC day, from 1. A failed attempt is retried at least 90 minutes after it ended, at most 3 attempts per day.",
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
    .describe("d1-control, the export of the control D1 database."),
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
