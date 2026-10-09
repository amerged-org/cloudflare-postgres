// SPDX-License-Identifier: Apache-2.0
import {
  FleetUpdateCandidate,
  FleetUpdateCandidateList,
  FleetUpdatePolicy,
  FleetUpdatePolicyStatus,
  type FleetUpdateCandidateAction,
  type FleetUpdateComponent,
  type FleetUpdatePolicyUpdate,
  type FleetUpdateFacts,
} from "@pgcf/contracts/fleet-updates";
import { FleetReleaseSpec } from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  fleetUpdateSha256,
  readFleetUpdateFeed,
} from "./fleet-update-feeds.ts";

type DatabaseEnv = Pick<Env, "DB">;
interface PolicyRow {
  revision: number;
  policy_json: string;
  discovery_revision: number;
  discovery_json: string;
}
interface Discovery {
  next_at: number;
  last_success_at: number | null;
  error: string | null;
}
type DiscoveryState = Partial<Record<FleetUpdateComponent, Discovery>>;
const CATALOG_LIMIT = 2000;
const SOURCES_PER_TURN = 4;
const POLL_MS = 60 * 60_000; // Public anonymous GitHub reads stay below the normal hourly limit.
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
function conflict(message: string): never {
  throw new ApiError("conflict", message);
}
async function policyRow(db: D1Database): Promise<PolicyRow | null> {
  return db
    .prepare(
      "SELECT revision,policy_json,discovery_revision,discovery_json FROM fleet_update_policy WHERE singleton=1",
    )
    .first<PolicyRow>();
}
async function baseRelease(db: D1Database, id: string) {
  const row = await db
    .prepare("SELECT spec_json,spec_sha256 FROM fleet_releases WHERE id=?")
    .bind(id)
    .first<{ spec_json: string; spec_sha256: string }>();
  if (!row) throw new ApiError("not_found", "Promoted release not found");
  const spec = FleetReleaseSpec.parse(JSON.parse(row.spec_json));
  if ((await fleetUpdateSha256(canonical(spec))) !== row.spec_sha256)
    return conflict("Promoted release integrity changed");
  return { spec, sha256: row.spec_sha256 };
}
export function fleetUpdateVersionParts(value: string): number[] | null {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part <= 2147483647)
    ? parts
    : null;
}
export function fleetUpdatePatchEligible(
  component: FleetUpdateComponent,
  current: string,
  target: string,
  line: string,
): boolean {
  const old = fleetUpdateVersionParts(current),
    next = fleetUpdateVersionParts(target);
  if (
    !old ||
    !next ||
    old.length !== next.length ||
    (component === "postgres" ? old.length !== 2 : old.length !== 3)
  )
    return false;
  const prefix = component === "postgres" ? 1 : 2;
  return (
    old.slice(0, prefix).join(".") === line &&
    next.slice(0, prefix).join(".") === line &&
    next[prefix]! > old[prefix]!
  );
}
function currentVersion(
  spec: FleetReleaseSpec,
  component: FleetUpdateComponent,
): string | null {
  const runtimeNames: Partial<Record<FleetUpdateComponent, string>> = {
    cilium: "image/cilium/cilium",
    "cert-manager": "image/cert-manager/cert-manager-controller",
    "cloudnative-pg": "image/cloudnative-pg/cloudnative-pg",
    "plugin-barman-cloud": "image/plugin-barman-cloud/plugin-barman-cloud",
  };
  // Chart and application releases can have different versions. Discovery follows the runtime feed.
  const runtime =
    spec.components.find(
      (row) =>
        row.kind === "image" &&
        row.name === (runtimeNames[component] ?? component),
    ) ??
    spec.components.find(
      (row) => row.kind === "image" && row.name === component,
    );
  const raw =
    component === "talos"
      ? spec.roles.customer.talos_version
      : component === "kubernetes"
        ? spec.roles.customer.kubernetes_version
        : runtime?.version;
  const value = raw?.replace(/^v/, "");
  return value && fleetUpdateVersionParts(value) ? value : null;
}
/** UTC windows only; critical urgency must come from actual qualification, never release-note keywords. */
export function fleetUpdateWindowOpen(
  policy: FleetUpdatePolicy,
  now: number,
  verifiedSeverity?: "low" | "medium" | "high" | "critical",
): boolean {
  if (!policy.enabled || !Number.isFinite(now)) return false;
  const urgent =
    verifiedSeverity === "critical" ||
    (policy.critical.minimum_severity === "high" &&
      verifiedSeverity === "high");
  if (urgent && policy.critical.allow_outside_window) return true;
  const date = new Date(now),
    minute =
      date.getUTCDay() * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes();
  return policy.windows.some(
    (window) =>
      (minute - (window.weekday * 1440 + window.start_minute) + 10080) % 10080 <
      window.duration_minutes,
  );
}
export async function readFleetUpdatePolicy(db: D1Database) {
  const row = await policyRow(db);
  return FleetUpdatePolicyStatus.parse({
    revision: row?.revision ?? 0,
    policy: row ? JSON.parse(row.policy_json) : null,
    qualification_channel: "unavailable",
  });
}
export async function getFleetUpdatePolicy(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetUpdatePolicy(c.env.DB));
}
export async function updateFleetUpdatePolicy(
  c: ApiContext,
  body: FleetUpdatePolicyUpdate,
): Promise<Response> {
  await requireScope(c, "admin");
  const policy = FleetUpdatePolicy.parse(body.policy),
    base = await baseRelease(c.env.DB, policy.promoted_release_id);
  for (const selected of policy.supported_lines) {
    const version = currentVersion(base.spec, selected.component),
      parts = version && fleetUpdateVersionParts(version);
    if (
      !parts ||
      parts.slice(0, selected.component === "postgres" ? 1 : 2).join(".") !==
        selected.line
    )
      throw new ApiError(
        "invalid_request",
        "Supported patch lines must match the promoted release",
      );
  }
  const policyJson = canonical(policy),
    next = body.expected_revision + 1;
  const read = async () => {
    const state = await readFleetUpdatePolicy(c.env.DB);
    if (state.revision !== next || canonical(state.policy) !== policyJson)
      return conflict("Fleet update policy revision changed");
    return c.json(state);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO fleet_update_policy(singleton,revision,policy_json,updated_at)
        SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM fleet_releases WHERE id=? AND spec_sha256=?)
          AND EXISTS(SELECT 1 FROM regions WHERE id=?)
          AND ((?=0 AND NOT EXISTS(SELECT 1 FROM fleet_update_policy)) OR EXISTS(SELECT 1 FROM fleet_update_policy WHERE singleton=1 AND revision=?))
        ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json,updated_at=excluded.updated_at WHERE fleet_update_policy.revision=?`,
        ).bind(
          next,
          policyJson,
          new Date().toISOString(),
          policy.promoted_release_id,
          base.sha256,
          policy.canary.region_id,
          body.expected_revision,
          body.expected_revision,
          body.expected_revision,
        ),
        lease.completeStatement("fleet-update-policy", 200, {
          sql: "EXISTS(SELECT 1 FROM fleet_update_policy WHERE singleton=1 AND revision=? AND policy_json=?)",
          bindings: [next, policyJson],
        }),
      ]);
      if (result[0]!.meta.changes !== 1)
        return conflict(
          "Fleet update policy revision or canary region changed",
        );
      return read();
    },
  });
}
export async function readFleetUpdateCandidate(
  db: D1Database,
  id: string,
): Promise<FleetUpdateCandidate> {
  const row = await db
    .prepare("SELECT * FROM fleet_update_candidates WHERE id=?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw new ApiError("not_found", "Fleet update candidate not found");
  return candidateView(row);
}
function candidateView(row: Record<string, unknown>): FleetUpdateCandidate {
  const { facts_json, ...fields } = row;
  return FleetUpdateCandidate.parse({
    ...fields,
    facts: JSON.parse(String(facts_json)),
  });
}
export async function getFleetUpdateCandidate(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetUpdateCandidate(c.env.DB, id));
}
export async function listFleetUpdateCandidates(
  c: ApiContext,
  cursor?: string,
): Promise<Response> {
  await requireScope(c, "admin");
  const rows = await c.env.DB.prepare(
    "SELECT * FROM fleet_update_candidates WHERE id>? ORDER BY id LIMIT 51",
  )
    .bind(cursor ?? "")
    .all<Record<string, unknown>>();
  const page = rows.results.slice(0, 50);
  return c.json(
    FleetUpdateCandidateList.parse({
      candidates: page.map(candidateView),
      next_cursor: rows.results.length > 50 ? page.at(-1)!.id : null,
    }),
  );
}
export async function actOnFleetUpdateCandidate(
  c: ApiContext,
  id: string,
  action: "reject" | "resume",
  body: FleetUpdateCandidateAction,
): Promise<Response> {
  await requireScope(c, "admin");
  const row = await policyRow(c.env.DB);
  if (!row || row.revision !== body.expected_policy_revision)
    return conflict("Fleet update policy revision changed");
  const policy = FleetUpdatePolicy.parse(JSON.parse(row.policy_json)),
    candidate = await readFleetUpdateCandidate(c.env.DB, id);
  if (action === "resume") {
    const base = await baseRelease(c.env.DB, policy.promoted_release_id),
      line = policy.supported_lines.find(
        (row) => row.component === candidate.component,
      )?.line;
    if (
      !policy.enabled ||
      candidate.base_release_id !== policy.promoted_release_id ||
      candidate.base_spec_sha256 !== base.sha256 ||
      !line ||
      !fleetUpdatePatchEligible(
        candidate.component,
        candidate.current_version,
        candidate.target_version,
        line,
      )
    )
      return conflict("Candidate is outside current supported authority");
  }
  const state = action === "reject" ? "rejected" : "awaiting_ci",
    reason =
      action === "reject"
        ? "operator_rejected"
        : "qualification_channel_unavailable";
  const read = async () => {
    const current = await readFleetUpdateCandidate(c.env.DB, id);
    if (
      current.revision !== body.expected_revision + 1 ||
      current.state !== state ||
      current.operator_reason !== body.reason
    )
      return conflict("Candidate revision changed");
    return c.json(current);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `UPDATE fleet_update_candidates SET state=?,reason=?,operator_reason=?,policy_revision=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state IN('awaiting_ci','blocked','rejected')
        AND EXISTS(SELECT 1 FROM fleet_update_policy WHERE singleton=1 AND revision=? AND policy_json=?)`,
        ).bind(
          state,
          reason,
          body.reason,
          row.revision,
          new Date().toISOString(),
          id,
          body.expected_revision,
          row.revision,
          row.policy_json,
        ),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM fleet_update_candidates WHERE id=? AND revision=? AND state=? AND operator_reason=?)",
          bindings: [id, body.expected_revision + 1, state, body.reason],
        }),
      ]);
      if (result[0]!.meta.changes !== 1)
        return conflict("Candidate revision or execution state changed");
      return read();
    },
  });
}

/** Read-only integration boundary. No client-supplied receipt or approved-release row can qualify a candidate. */
export async function readFleetUpdatePromotion(
  env: DatabaseEnv,
  id: string,
  now = Date.now(),
) {
  const candidate = await readFleetUpdateCandidate(env.DB, id),
    row = await policyRow(env.DB),
    policy = row ? FleetUpdatePolicy.parse(JSON.parse(row.policy_json)) : null;
  const reasons: string[] = ["qualification_channel_unavailable"];
  if (!policy?.enabled) reasons.push("policy_disabled");
  if (row?.revision !== candidate.policy_revision)
    reasons.push("policy_changed");
  if (policy?.promoted_release_id !== candidate.base_release_id)
    reasons.push("promoted_release_changed");
  if (candidate.state === "rejected" || candidate.state === "blocked")
    reasons.push(`candidate_${candidate.state}`);
  if (policy) {
    const base = await baseRelease(env.DB, policy.promoted_release_id);
    if (candidate.base_spec_sha256 !== base.sha256)
      reasons.push("base_release_integrity_changed");
    const line = policy.supported_lines.find(
      (row) => row.component === candidate.component,
    )?.line;
    if (
      !line ||
      !fleetUpdatePatchEligible(
        candidate.component,
        candidate.current_version,
        candidate.target_version,
        line,
      )
    )
      reasons.push("unsupported_patch_line");
  }
  if (
    !candidate.qualification_run_id ||
    !candidate.qualification_sha256 ||
    !candidate.qualified_at
  )
    reasons.push("awaiting_actual_ci_evidence");
  if (!candidate.canary_receipt_sha256 || !candidate.canary_completed_at)
    reasons.push("awaiting_real_canary");
  else if (
    policy &&
    Date.parse(candidate.canary_completed_at) + policy.soak_seconds * 1000 > now
  )
    reasons.push("canary_soak_pending");
  if (Date.parse(candidate.deadline_at) <= now)
    reasons.push("candidate_deadline_exceeded");
  if (policy && !fleetUpdateWindowOpen(policy, now))
    reasons.push("outside_maintenance_window");
  return {
    candidate_id: id,
    candidate_revision: candidate.revision,
    policy_revision: row?.revision ?? 0,
    canary: policy?.canary ?? null,
    eligible: false as const,
    reasons,
  };
}

async function recordCandidate(
  env: DatabaseEnv,
  revision: number,
  policy: FleetUpdatePolicy,
  base: Awaited<ReturnType<typeof baseRelease>>,
  component: FleetUpdateComponent,
  current: string,
  facts: FleetUpdateFacts,
  now: number,
) {
  const line = policy.supported_lines.find(
    (row) => row.component === component,
  )!.line;
  // Only supported patch proposals enter the catalog; no prerelease, downgrade, minor or major promotion.
  if (!fleetUpdatePatchEligible(component, current, facts.version, line))
    return 0;
  const id = `fu-${await fleetUpdateSha256(canonical({ base: base.sha256, component, current, target: facts.version }))}`,
    timestamp = new Date(now).toISOString();
  const result = await env.DB.prepare(
    `INSERT INTO fleet_update_candidates(id,policy_revision,base_release_id,base_spec_sha256,component,current_version,target_version,facts_json,state,reason,created_at,updated_at,deadline_at)
    SELECT ?,?,?,?,?,?,?,?,'awaiting_ci','qualification_channel_unavailable',?,?,?
    WHERE EXISTS(SELECT 1 FROM fleet_update_policy WHERE singleton=1 AND revision=? AND policy_json=?)
      AND EXISTS(SELECT 1 FROM fleet_releases WHERE id=? AND spec_sha256=?)
      AND (SELECT count(*) FROM fleet_update_candidates)<? ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      id,
      revision,
      policy.promoted_release_id,
      base.sha256,
      component,
      current,
      facts.version,
      canonical(facts),
      timestamp,
      timestamp,
      new Date(now + policy.normal_deadline_hours * 3600_000).toISOString(),
      revision,
      canonical(policy),
      policy.promoted_release_id,
      base.sha256,
      CATALOG_LIMIT,
    )
    .run();
  return result.meta.changes;
}
/** Four fixed sources maximum; one CAS claim before network IO. No purchases or patch execution. */
export async function runFleetUpdates(
  env: DatabaseEnv,
  now = Date.now(),
  request: typeof fetch = fetch,
) {
  const row = await policyRow(env.DB);
  const result = {
    sources: 0,
    discovered: 0,
    failed: 0,
    qualification_channel: "unavailable" as const,
    reason: "policy_disabled",
  };
  if (!row) return result;
  const policy = FleetUpdatePolicy.parse(JSON.parse(row.policy_json));
  if (!policy.enabled) return result;
  const base = await baseRelease(env.DB, policy.promoted_release_id),
    state = JSON.parse(row.discovery_json) as DiscoveryState;
  const due = policy.supported_lines
    .filter(
      (line) => !state[line.component] || state[line.component]!.next_at <= now,
    )
    .slice(0, SOURCES_PER_TURN);
  result.reason = "qualification_channel_unavailable";
  if (!due.length) return result;
  for (const line of due)
    state[line.component] = {
      next_at: now + POLL_MS,
      last_success_at: state[line.component]?.last_success_at ?? null,
      error: null,
    };
  const claim = await env.DB.prepare(
    "UPDATE fleet_update_policy SET discovery_revision=discovery_revision+1,discovery_json=? WHERE singleton=1 AND revision=? AND discovery_revision=? AND policy_json=?",
  )
    .bind(
      canonical(state),
      row.revision,
      row.discovery_revision,
      row.policy_json,
    )
    .run();
  if (claim.meta.changes !== 1) {
    result.reason = "discovery_claim_changed";
    return result;
  }
  const observations = await Promise.allSettled(
    due.map((line) => readFleetUpdateFeed(line.component, now, request)),
  );
  for (const [index, observation] of observations.entries()) {
    const component = due[index]!.component;
    result.sources++;
    if (observation.status === "rejected") {
      result.failed++;
      state[component]!.error = "upstream_unavailable";
      state[component]!.next_at = now + POLL_MS;
      continue;
    }
    state[component]!.last_success_at = now;
    const current = currentVersion(base.spec, component);
    if (!current) {
      result.failed++;
      state[component]!.error = "baseline_version_unavailable";
      continue;
    }
    const line = due[index]!.line;
    // Eight candidate INSERTs maximum across the four sources, leaving room for existing Cron work.
    const proposals = observation.value
      .filter((facts) =>
        fleetUpdatePatchEligible(component, current, facts.version, line),
      )
      .sort(
        (left, right) =>
          fleetUpdateVersionParts(right.version)!.at(-1)! -
          fleetUpdateVersionParts(left.version)!.at(-1)!,
      )
      .slice(0, 2);
    for (const facts of proposals)
      result.discovered += await recordCandidate(
        env,
        row.revision,
        policy,
        base,
        component,
        current,
        facts,
        now,
      );
  }
  await env.DB.prepare(
    "UPDATE fleet_update_policy SET discovery_revision=discovery_revision+1,discovery_json=? WHERE singleton=1 AND revision=? AND discovery_revision=? AND policy_json=?",
  )
    .bind(
      canonical(state),
      row.revision,
      row.discovery_revision + 1,
      row.policy_json,
    )
    .run();
  if (
    (await env.DB.prepare(
      "SELECT count(*) count FROM fleet_update_candidates",
    ).first<number>("count")) === CATALOG_LIMIT
  )
    result.reason = "candidate_catalog_full";
  return result;
}
