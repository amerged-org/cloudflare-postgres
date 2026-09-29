// SPDX-License-Identifier: Apache-2.0
import {
  bearer,
  error,
  json,
  meters,
  object,
  sha256,
  timestamp,
  uuid,
  vector,
  type AccountingDb,
  type Meter,
  type UnitVector,
} from "./accounting";

type Reason =
  | "authorized"
  | "reservation_expired"
  | "reservation_settled"
  | "region_disabled"
  | "budget_paused"
  | "environment_changed"
  | "environment_deleting"
  | "environment_suspended"
  | "policy_changed"
  | "budget_period_inactive"
  | "unreconciled_usage"
  | "budget_overdrawn"
  | "reservation_unfunded"
  | "snapshot_stale";
interface ActorRow {
  id: string;
  region_id: string;
  scopes: string;
  region_status: string;
}
interface ReceiptRow {
  id: string;
  region_id: string;
  environment_id: string;
  organization_id: string;
  project_id: string;
  spec_revision: number;
  spec_hash: string;
  issued_at: string;
  expires_at: string;
  execution_epoch: string;
  units_json: string;
  status: string;
  gap_count: string;
  version_token: string;
  current_environment_id: string | null;
  current_region_id: string | null;
  current_organization_id: string | null;
  current_project_id: string | null;
  current_spec_revision: number | null;
  current_spec_hash: string | null;
  deletion_operation_id: string | null;
  runtime_version: string | null;
  runtime_desired_state: string | null;
  runtime_phase: string | null;
  project_fence_version: string | null;
}
interface AccountFields {
  account_id: string | null;
  account_target_id: string | null;
  period_start: string | null;
  period_end: string | null;
  granted_json: string | null;
  consumed_json: string | null;
  reserved_json: string | null;
  gap_count: string | null;
  account_version: string | null;
}
interface PolicyRow extends AccountFields {
  target_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string | null;
  active_account_id: string | null;
  revision: string;
  execution_epoch: string;
  requested_state: string;
}
interface OriginalRow extends AccountFields {
  bound_account_id: string;
  target_revision: string;
  target_execution_epoch: string;
  bound_reserved_json: string;
}
interface Binding {
  targetId: string;
  projectId: string;
  revision: string;
  executionEpoch: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  requestedState: "running" | "paused";
}
interface AccountObservation {
  granted: UnitVector;
  consumed: UnitVector;
  reserved: UnitVector;
  gaps: bigint;
}
const accountColumns = `a.id AS account_id, a.target_id AS account_target_id,
  a.period_start, a.period_end, a.granted_json, a.consumed_json, a.reserved_json,
  a.gap_count, a.version_token AS account_version`;
const tokenPredicate = `EXISTS (SELECT 1 FROM region_tokens t WHERE t.id = ?
  AND t.token_hash = ? AND t.region_id = ? AND t.revoked_at IS NULL
  AND instr(' ' || t.scopes || ' ', ' operations:claim ') > 0)`;
function counter(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}
function quantities(value: string | null): UnitVector {
  if (typeof value !== "string") throw new Error("authority_snapshot_invalid");
  const parsed: unknown = JSON.parse(value);
  if (
    !object(parsed) ||
    Object.keys(parsed).some(
      (key) => !(meters as readonly string[]).includes(key),
    ) ||
    !Object.values(parsed).every(counter)
  )
    throw new Error("authority_snapshot_invalid");
  return Object.fromEntries(
    meters
      .filter((metric) => Object.hasOwn(parsed, metric))
      .map((metric) => [metric, parsed[metric]]),
  ) as UnitVector;
}
function account(row: AccountFields): AccountObservation | null {
  if (
    !row.account_id ||
    !row.account_target_id ||
    !row.account_version ||
    timestamp(row.period_start) === null ||
    timestamp(row.period_end) === null ||
    !counter(row.gap_count)
  )
    return null;
  return {
    granted: quantities(row.granted_json),
    consumed: quantities(row.consumed_json),
    reserved: quantities(row.reserved_json),
    gaps: BigInt(row.gap_count),
  };
}
function binding(row: PolicyRow): Binding | null {
  if (
    typeof row.account_id !== "string" ||
    typeof row.period_start !== "string" ||
    typeof row.period_end !== "string" ||
    timestamp(row.period_start) === null ||
    timestamp(row.period_end) === null ||
    !counter(row.revision) ||
    !counter(row.execution_epoch) ||
    (row.requested_state !== "running" && row.requested_state !== "paused")
  )
    return null;
  return {
    targetId: row.target_id,
    projectId: row.project_id,
    revision: row.revision,
    executionEpoch: row.execution_epoch,
    accountId: row.account_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    requestedState: row.requested_state,
  };
}
function amount(value: UnitVector, metric: Meter): bigint {
  return BigInt(value[metric] ?? "0");
}
function expectedHold(units: UnitVector, grant: UnitVector): UnitVector {
  return Object.fromEntries(
    meters
      .filter((metric) => Object.hasOwn(grant, metric))
      .map((metric) => [metric, units[metric] ?? "0"]),
  ) as UnitVector;
}

export async function runtimeAuthority(
  request: Request,
  db: AccountingDb,
  regionId: string,
  reservationId: string,
): Promise<Response> {
  try {
    if (
      !uuid.test(regionId) ||
      !uuid.test(reservationId) ||
      new URL(request.url).searchParams.size > 0
    )
      return error(400, "invalid_request");
    const supplied = bearer(request);
    if (!supplied?.startsWith("cprgn_")) return error(401, "unauthorized");
    const tokenHash = await sha256(supplied);
    const actorStatement = () =>
      db
        .prepare(
          "SELECT t.id, t.region_id, t.scopes, r.status AS region_status FROM region_tokens t JOIN regions r ON r.id = t.region_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
        )
        .bind(tokenHash);
    const actor = await actorStatement().first<ActorRow>();
    if (!actor || !actor.scopes.split(" ").includes("operations:claim"))
      return error(401, "unauthorized");
    if (actor.region_id !== regionId) return error(404, "not_found");
    const at = Date.now();
    const observedAt = new Date(at).toISOString();
    // One primary transaction observes the receipt, all current applicable
    // policies, original accounts and historical gaps. No fence is advanced.
    const snapshot = await db.batch<
      | ActorRow
      | ReceiptRow
      | PolicyRow
      | OriginalRow
      | { unreconciled_usage: number }
    >([
      actorStatement(),
      db
        .prepare(
          `SELECT q.id, q.region_id, q.environment_id, q.organization_id, q.project_id,
        q.spec_revision, q.spec_hash, q.issued_at, q.expires_at, q.execution_epoch,
        q.units_json, q.status, q.gap_count, q.version_token,
        e.id AS current_environment_id, e.region_id AS current_region_id,
        e.organization_id AS current_organization_id, e.project_id AS current_project_id,
        e.spec_revision AS current_spec_revision, e.spec_hash AS current_spec_hash,
        rt.version_token AS runtime_version, rt.desired_state AS runtime_desired_state,
        rt.phase AS runtime_phase, d.operation_id AS deletion_operation_id,
        f.version_token AS project_fence_version FROM allowance_reservations q
        LEFT JOIN environments e ON e.id = q.environment_id
        LEFT JOIN environment_runtime rt ON rt.environment_id = e.id
        LEFT JOIN environment_deletions d ON d.environment_id = e.id
        LEFT JOIN accounting_fences f ON f.project_id = q.project_id
        WHERE q.id = ? AND q.region_id = ?`,
        )
        .bind(reservationId, regionId),
      db
        .prepare(
          `SELECT t.id AS target_id, t.organization_id, t.project_id, t.environment_id,
        t.active_account_id, t.revision, t.execution_epoch, t.requested_state, ${accountColumns}
        FROM budget_targets t LEFT JOIN budget_accounts a ON a.id = t.active_account_id
        JOIN allowance_reservations q ON q.project_id = t.project_id
        WHERE q.id = ? AND q.region_id = ? AND (t.environment_id IS NULL OR t.environment_id = q.environment_id)
        ORDER BY t.id`,
        )
        .bind(reservationId, regionId),
      db
        .prepare(
          `SELECT b.account_id AS bound_account_id, b.target_revision, b.target_execution_epoch,
        b.reserved_json AS bound_reserved_json, ${accountColumns}
        FROM allowance_accounts b LEFT JOIN budget_accounts a ON a.id = b.account_id
        JOIN allowance_reservations q ON q.id = b.reservation_id
        WHERE q.id = ? AND q.region_id = ? ORDER BY a.target_id, b.account_id`,
        )
        .bind(reservationId, regionId),
      db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM allowance_reservations h
        JOIN allowance_reservations q ON q.project_id = h.project_id
        WHERE q.id = ? AND q.region_id = ?
        AND (h.gap_count <> '0' OR (h.status = 'issued' AND h.expires_at <= ?))) AS unreconciled_usage`,
        )
        .bind(reservationId, regionId, observedAt),
    ]);
    if (snapshot.length !== 5 || snapshot.some((result) => !result.success))
      throw new Error("authority_snapshot_invalid");
    const currentActor = snapshot[0]!.results[0] as ActorRow | undefined;
    if (
      !currentActor ||
      currentActor.id !== actor.id ||
      currentActor.region_id !== regionId ||
      !currentActor.scopes.split(" ").includes("operations:claim")
    )
      return error(401, "unauthorized");
    const receipt = snapshot[1]!.results[0] as ReceiptRow | undefined;
    if (!receipt) return error(404, "not_found");
    const policies = snapshot[2]!.results as unknown as PolicyRow[];
    const originals = snapshot[3]!.results as unknown as OriginalRow[];
    const history = snapshot[4]!.results[0] as
      { unreconciled_usage: number } | undefined;
    if (
      !history ||
      ![0, 1].includes(history.unreconciled_usage) ||
      !counter(receipt.execution_epoch) ||
      !counter(receipt.gap_count) ||
      timestamp(receipt.issued_at) === null ||
      timestamp(receipt.expires_at) === null
    )
      throw new Error("authority_snapshot_invalid");
    const units = vector(JSON.parse(receipt.units_json));
    if (!units || !Object.values(units).some((value) => BigInt(value!) > 0n))
      throw new Error("authority_snapshot_invalid");
    const policyAccounts = policies.map(account);
    const limitedMetrics = meters.filter((metric) =>
      policyAccounts.some(
        (current) => current !== null && Object.hasOwn(current.granted, metric),
      ),
    );
    const originalAccounts = originals.map(account);
    const bindings = policies
      .map(binding)
      .filter((value): value is Binding => value !== null);
    let reason: Reason = "authorized";
    const epoch = policies
      .reduce((sum, policy) => {
        if (!counter(policy.execution_epoch))
          throw new Error("authority_snapshot_invalid");
        return sum + BigInt(policy.execution_epoch);
      }, 0n)
      .toString();
    const samePolicies =
      policies.length === originals.length &&
      bindings.length === policies.length &&
      policies.every((policy, index) => {
        const bound = originals.filter(
          (original) => original.account_target_id === policy.target_id,
        );
        const current = policyAccounts[index];
        return (
          policy.organization_id === receipt.organization_id &&
          policy.project_id === receipt.project_id &&
          policy.target_id ===
            (policy.environment_id === null
              ? `project:${receipt.project_id}`
              : `environment:${receipt.environment_id}`) &&
          bound.length === 1 &&
          policy.active_account_id === policy.account_id &&
          current !== null &&
          current !== undefined &&
          policy.account_target_id === policy.target_id &&
          bound[0]!.bound_account_id === policy.active_account_id &&
          bound[0]!.account_id === policy.active_account_id &&
          bound[0]!.target_execution_epoch === policy.execution_epoch &&
          JSON.stringify(quantities(bound[0]!.bound_reserved_json)) ===
            JSON.stringify(expectedHold(units, current.granted))
        );
      }) &&
      epoch === receipt.execution_epoch;
    if (receipt.status === "settled") reason = "reservation_settled";
    else if (receipt.expires_at <= observedAt) reason = "reservation_expired";
    else if (currentActor.region_status === "disabled")
      reason = "region_disabled";
    else if (
      receipt.current_environment_id !== receipt.environment_id ||
      receipt.current_region_id !== receipt.region_id ||
      receipt.current_organization_id !== receipt.organization_id ||
      receipt.current_project_id !== receipt.project_id ||
      receipt.current_spec_revision !== receipt.spec_revision ||
      receipt.current_spec_hash !== receipt.spec_hash
    )
      reason = "environment_changed";
    else if (receipt.deletion_operation_id !== null)
      reason = "environment_deleting";
    else if (
      receipt.runtime_desired_state !== null &&
      (receipt.runtime_desired_state !== "running" ||
        receipt.runtime_phase !== "running")
    )
      reason = "environment_suspended";
    else if (policies.some((policy) => policy.requested_state === "paused"))
      reason = "budget_paused";
    else if (
      BigInt(receipt.gap_count) > 0n ||
      history.unreconciled_usage === 1 ||
      policyAccounts.some((current) => current !== null && current.gaps > 0n) ||
      originalAccounts.some((current) => current !== null && current.gaps > 0n)
    )
      reason = "unreconciled_usage";
    else if (
      receipt.status !== "issued" ||
      !samePolicies ||
      originalAccounts.some((current) => current === null)
    )
      reason = "policy_changed";
    else if (
      policies.some(
        (policy) =>
          policy.period_start! > observedAt || policy.period_end! <= observedAt,
      )
    )
      reason = "budget_period_inactive";
    else if (
      policyAccounts.some(
        (current) =>
          current !== null &&
          meters.some(
            (metric) =>
              Object.hasOwn(current.granted, metric) &&
              amount(current.consumed, metric) +
                amount(current.reserved, metric) >
                amount(current.granted, metric),
          ),
      )
    )
      reason = "budget_overdrawn";
    else if (
      originals.some((original, index) => {
        const held = quantities(original.bound_reserved_json);
        const current = originalAccounts[index]!;
        return meters.some(
          (metric) => amount(current.reserved, metric) < amount(held, metric),
        );
      })
    )
      reason = "reservation_unfunded";
    const deadline = Math.min(
      at + 15_000,
      Date.parse(receipt.expires_at),
      ...bindings.map((value) => Date.parse(value.periodEnd)),
    );
    if (
      reason === "authorized" &&
      (receipt.issued_at > observedAt ||
        Date.now() < at ||
        Date.now() >= deadline)
    )
      reason = "snapshot_stale";
    const authority = {
      schemaVersion: 1,
      reservationId: receipt.id,
      environmentId: receipt.environment_id,
      projectId: receipt.project_id,
      regionId: receipt.region_id,
      specRevision: receipt.spec_revision,
      specHash: receipt.spec_hash,
      epoch: receipt.execution_epoch,
      decision: reason === "authorized" ? "allow" : "stop",
      reason,
      observedAt,
      validUntil:
        reason === "authorized" ? new Date(deadline).toISOString() : observedAt,
      units,
      limitedMetrics,
      bindings,
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
    };
    const evidenceHash = await sha256(
      JSON.stringify({
        version: "runtime-authority-observation/v1",
        authority,
        actorTokenId: currentActor.id,
        receipt,
        policies,
        originals,
        history,
      }),
    );
    // All supported accounting writers advance the shared project fence. Recheck
    // it with actor, region, receipt and environment after hashing the snapshot.
    const stable = await db
      .prepare(
        `SELECT 1 AS stable FROM allowance_reservations q
      JOIN environments e ON e.id = q.environment_id JOIN regions r ON r.id = q.region_id
      LEFT JOIN environment_runtime rt ON rt.environment_id = e.id
      LEFT JOIN environment_deletions d ON d.environment_id = e.id
      LEFT JOIN accounting_fences f ON f.project_id = q.project_id
      WHERE q.id = ? AND q.region_id = ? AND q.version_token = ? AND q.status = ?
      AND q.expires_at = ? AND r.status = ? AND f.version_token IS ?
      AND e.id IS ? AND e.region_id IS ? AND e.organization_id IS ? AND e.project_id IS ?
      AND e.spec_revision IS ? AND e.spec_hash IS ?
      AND d.operation_id IS ?
      AND rt.version_token IS ? AND rt.desired_state IS ? AND rt.phase IS ? AND ${tokenPredicate}`,
      )
      .bind(
        reservationId,
        regionId,
        receipt.version_token,
        receipt.status,
        receipt.expires_at,
        currentActor.region_status,
        receipt.project_fence_version,
        receipt.current_environment_id,
        receipt.current_region_id,
        receipt.current_organization_id,
        receipt.current_project_id,
        receipt.current_spec_revision,
        receipt.current_spec_hash,
        receipt.deletion_operation_id,
        receipt.runtime_version,
        receipt.runtime_desired_state,
        receipt.runtime_phase,
        actor.id,
        tokenHash,
        regionId,
      )
      .first();
    if (!stable) return error(409, "authority_snapshot_conflict");
    if (reason === "authorized" && (Date.now() < at || Date.now() >= deadline))
      return error(409, "authority_snapshot_conflict");
    return json({ authority: { ...authority, evidenceHash } });
  } catch {
    return error(500, "runtime_authority_unavailable");
  }
}
