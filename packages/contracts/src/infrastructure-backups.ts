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
  enabled: z.boolean(),
  d1_account_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
  d1_database_id: z.uuid().nullable(),
  d1_region_id: RegionId.nullable(),
  notification_recipient: Email.nullable(),
  notification_sender: Email.nullable(),
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
  revision: z.number().int().nonnegative(),
  enabled_at: Timestamp.nullable(),
  updated_at: Timestamp.nullable(),
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
    status: z.enum(["pending", "prepared", "complete", "failed"]),
    completed_at: Timestamp.nullable(),
    error_code: z.string().max(128).nullable(),
    object_key: z.string().max(1024),
    kid: z.string().max(64).nullable(),
    plaintext_sha256: Sha256.nullable(),
    plaintext_bytes: z.number().int().nonnegative().nullable(),
    encrypted_sha256: Sha256.nullable(),
    encrypted_bytes: z.number().int().nonnegative().nullable(),
  });
export const InfrastructureBackupRunStatus = z.strictObject({
  id: z.uuid(),
  day: z.iso.date(),
  status: z.enum(["pending", "running", "complete", "failed"]),
  created_at: Timestamp,
  completed_at: Timestamp.nullable(),
  error_code: z.string().max(128).nullable(),
  artifacts: z.array(InfrastructureBackupArtifactStatus).max(65),
});
export const InfrastructureBackupHealth = z.strictObject({
  kind: InfrastructureBackupKind,
  region_id: RegionId,
  status: z.enum(["disabled", "ok", "unknown", "stale", "failing"]),
  last_completed_at: Timestamp.nullable(),
  last_failed_at: Timestamp.nullable(),
  error_code: z.string().max(128).nullable(),
});
