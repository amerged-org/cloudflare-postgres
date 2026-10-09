// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RegionId } from "./ids.ts";
import { FleetReleaseId } from "./releases.ts";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().min(0).max(2147483647);
const ExpectedRevision = Revision.max(2147483646);
export const FleetUpdateComponent = z.enum([
  "talos",
  "kubernetes",
  "postgres",
  "flux-source",
  "flux-kustomize",
  "flux-helm",
  "flux-notification",
  "cilium",
  "cert-manager",
  "cloudnative-pg",
  "plugin-barman-cloud",
  "barman",
  "openebs-lvm",
  "cloudflared",
]);
export type FleetUpdateComponent = z.infer<typeof FleetUpdateComponent>;
export const FleetUpdateVersion = z
  .string()
  .regex(/^\d+\.\d+(?:\.\d+)?$/)
  .max(32);
export const FleetUpdateCandidateId = z.string().regex(/^fu-[a-f0-9]{64}$/);
export const FleetUpdateWindow = z.strictObject({
  /** UTC; Sunday is zero. A running operation is not aborted when the window closes. */
  weekday: z.number().int().min(0).max(6),
  start_minute: z.number().int().min(0).max(1439),
  duration_minutes: z.number().int().min(1).max(1440),
});
const SupportedLine = z
  .strictObject({
    component: FleetUpdateComponent,
    /** PostgreSQL uses its major (18); other components use major.minor (1.14). */
    line: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .max(24),
  })
  .superRefine((value, ctx) => {
    if ((value.component === "postgres") !== !value.line.includes("."))
      ctx.addIssue({
        code: "custom",
        message: "Patch line must follow the component's version policy",
      });
  });
export const FleetUpdatePolicy = z
  .strictObject({
    enabled: z.boolean(),
    promoted_release_id: FleetReleaseId,
    canary: z.strictObject({ region_id: RegionId, cluster_uid: z.uuid() }),
    windows: z.array(FleetUpdateWindow).max(14),
    supported_lines: z.array(SupportedLine).min(1).max(14),
    soak_seconds: z.number().int().min(60).max(86400),
    normal_deadline_hours: z.number().int().min(1).max(720),
    critical: z.strictObject({
      minimum_severity: z.enum(["high", "critical"]),
      deadline_hours: z.number().int().min(1).max(168),
      allow_outside_window: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.windows.length)
      ctx.addIssue({
        code: "custom",
        message: "Enabled updates require an explicit maintenance window",
      });
    if (
      new Set(value.supported_lines.map((row) => row.component)).size !==
      value.supported_lines.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each component has one supported patch line",
      });
  });
export type FleetUpdatePolicy = z.infer<typeof FleetUpdatePolicy>;
export const FleetUpdatePolicyUpdate = z.strictObject({
  expected_revision: ExpectedRevision,
  policy: FleetUpdatePolicy,
});
export type FleetUpdatePolicyUpdate = z.infer<typeof FleetUpdatePolicyUpdate>;
export const FleetUpdatePolicyStatus = z.strictObject({
  revision: Revision,
  policy: FleetUpdatePolicy.nullable(),
  qualification_channel: z.literal("unavailable"),
});
export const FleetUpdateAdvisory = z.strictObject({
  id: z.string().regex(/^(?:GHSA-[a-z0-9-]{14}|CVE-\d{4}-\d{4,8})$/),
  severity: z.enum(["low", "medium", "high", "critical", "unknown"]),
  published_at: z.iso.datetime(),
  /** Discovery is metadata; CI must establish actual affected shipped versions. */
  affected_version_range: z.string().max(256).nullable(),
  first_patched_version: z.string().max(64).nullable(),
});
export const FleetUpdateFacts = z.strictObject({
  source: FleetUpdateComponent,
  release_id: z.string().regex(/^[A-Za-z0-9._-]{1,96}$/),
  version: FleetUpdateVersion,
  url: z.url().max(512),
  /** Hash of the upstream release body or RSS summary, not CI/changelog qualification. */
  source_text_sha256: Sha256,
  published_at: z.iso.datetime(),
  observed_at: z.iso.datetime(),
  advisories: z.array(FleetUpdateAdvisory).max(20),
  advisory_status: z.enum(["observed", "unavailable", "not_provided"]),
});
export type FleetUpdateFacts = z.infer<typeof FleetUpdateFacts>;
export const FleetUpdateCandidateState = z.enum([
  "awaiting_ci",
  "qualified",
  "canary",
  "promoting",
  "promoted",
  "rejected",
  "blocked",
]);
export const FleetUpdateCandidate = z.strictObject({
  id: FleetUpdateCandidateId,
  revision: Revision,
  policy_revision: Revision,
  base_release_id: FleetReleaseId,
  base_spec_sha256: Sha256,
  component: FleetUpdateComponent,
  current_version: FleetUpdateVersion,
  target_version: FleetUpdateVersion,
  facts: FleetUpdateFacts,
  state: FleetUpdateCandidateState,
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,95}$/),
  operator_reason: z.string().max(512).nullable(),
  candidate_release_id: FleetReleaseId.nullable(),
  candidate_spec_sha256: Sha256.nullable(),
  qualification_run_id: z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .nullable(),
  qualification_sha256: Sha256.nullable(),
  qualified_at: z.iso.datetime().nullable(),
  canary_receipt_sha256: Sha256.nullable(),
  canary_completed_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  deadline_at: z.iso.datetime(),
});
export type FleetUpdateCandidate = z.infer<typeof FleetUpdateCandidate>;
export const FleetUpdateCandidateAction = z.strictObject({
  expected_revision: ExpectedRevision,
  expected_policy_revision: Revision,
  reason: z.string().min(1).max(512),
});
export type FleetUpdateCandidateAction = z.infer<
  typeof FleetUpdateCandidateAction
>;
export const FleetUpdateCandidateList = z.strictObject({
  candidates: z.array(FleetUpdateCandidate).max(50),
  next_cursor: FleetUpdateCandidateId.nullable(),
});
