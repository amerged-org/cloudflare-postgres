// SPDX-License-Identifier: Apache-2.0
import {
  assertion,
  bearer,
  body,
  error,
  fields,
  installation,
  json,
  meters,
  organizationRead,
  projectFence,
  protectFence,
  sha256,
  timestamp,
  token,
  unprotectFence,
  unsigned,
  uuid,
  vector,
} from "./accounting";
import type {
  AccountingDb,
  AccountingEnv,
  Meter,
  UnitVector,
} from "./accounting";
import type { UsageVersion } from "./usage";
import { runtimeAuthority } from "./runtime-authority";

interface Target {
  id: string;
  organization_id: string;
  project_id: string;
  environment_id: string | null;
  active_account_id: string;
  revision: string;
  execution_epoch: string;
  requested_state: "running" | "paused";
  updated_at: string;
}
interface Account {
  id: string;
  target_id: string;
  period_start: string;
  period_end: string;
  granted_json: string;
  consumed_json: string;
  reserved_json: string;
  gap_count: string;
  version_token: string;
}
interface Environment {
  id: string;
  organization_id: string;
  project_id: string;
  region_id: string;
  spec_revision: number;
  spec_hash: string;
}
interface Receipt {
  id: string;
  request_id: string;
  region_id: string;
  environment_id: string;
  organization_id: string;
  project_id: string;
  spec_revision: number;
  spec_hash: string;
  request_hash: string;
  issued_at: string;
  expires_at: string;
  execution_epoch: string;
  fence_token_hash: string;
  fence_ciphertext: string;
  fence_iv: string;
  fence_key_version: string;
  units_json: string;
  status: "issued" | "settled";
  revision: string;
  gap_count: string;
  version_token: string;
  stopped_at: string | null;
  stop_evidence_hash: string | null;
  settled_at: string | null;
}
interface Binding {
  reservation_id: string;
  account_id: string;
  target_revision: string;
  target_execution_epoch: string;
  reserved_json: string;
}
interface Link {
  fact_id: string;
  reservation_id: string;
  metric: Meter;
  linked_revision: number;
  charged_quantity: string;
  coverage_status: string;
  version_token: string;
}
interface Actor {
  id: string;
  token_hash: string;
}
const scopes = ["budgets:read", "budgets:write", "usage:read"];
const now = () => new Date(Date.now()).toISOString();
const increment = (value: string) => (BigInt(value) + 1n).toString();
const parsed = (value: string): UnitVector => JSON.parse(value) as UnitVector;
const amount = (values: UnitVector, metric: Meter): bigint =>
  BigInt(values[metric] ?? "0");
function arithmetic(
  left: UnitVector,
  right: UnitVector,
  direction: 1 | -1,
): UnitVector {
  const out: UnitVector = {};
  for (const metric of meters) {
    if (!Object.hasOwn(left, metric) && !Object.hasOwn(right, metric)) continue;
    const value =
      amount(left, metric) + BigInt(direction) * amount(right, metric);
    if (value < 0n) throw new Error("ledger_inconsistent");
    out[metric] = value.toString();
  }
  return out;
}
function limited(units: UnitVector, grant: UnitVector): UnitVector {
  return Object.fromEntries(
    Object.keys(grant).map((metric) => [metric, units[metric as Meter] ?? "0"]),
  ) as UnitVector;
}
function targetId(projectId: string, environmentId?: string): string {
  return environmentId
    ? `environment:${environmentId}`
    : `project:${projectId}`;
}

async function batch(
  db: AccountingDb,
  statements: D1PreparedStatement[],
): Promise<boolean> {
  try {
    await db.batch(statements);
    return true;
  } catch {
    return false;
  }
}
async function owner(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId?: string,
): Promise<Response | null> {
  const denied = await organizationRead(request, db, organizationId);
  if (denied) return denied;
  const project = await db
    .prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?")
    .bind(projectId, organizationId)
    .first();
  if (!project) return error(404, "not_found");
  if (
    environmentId &&
    !(await db
      .prepare(
        "SELECT id FROM environments WHERE id = ? AND project_id = ? AND organization_id = ?",
      )
      .bind(environmentId, projectId, organizationId)
      .first())
  )
    return error(404, "not_found");
  return null;
}
async function writer(
  request: Request,
  db: AccountingDb,
  organizationId: string,
): Promise<Actor | Response> {
  const supplied = bearer(request);
  if (!supplied) return error(401, "unauthorized");
  if (!supplied.startsWith("cpbgt_"))
    return error(403, "budget_grantor_required");
  const tokenHash = await sha256(supplied);
  const actor = await db
    .prepare(
      "SELECT id, organization_id, scopes FROM budget_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .bind(tokenHash)
    .first<{ id: string; organization_id: string; scopes: string }>();
  if (!actor || !actor.scopes.split(" ").includes("budgets:write"))
    return error(401, "unauthorized");
  return actor.organization_id === organizationId
    ? { id: actor.id, token_hash: tokenHash }
    : error(404, "not_found");
}
async function regionActor(
  request: Request,
  db: AccountingDb,
  regionId: string,
  required: string,
  historical = false,
): Promise<Actor | Response> {
  const supplied = bearer(request);
  if (!supplied?.startsWith("cprgn_")) return error(401, "unauthorized");
  const tokenHash = await sha256(supplied);
  const row = await db
    .prepare(
      "SELECT t.id, t.region_id, t.scopes, r.status AS region_status FROM region_tokens t JOIN regions r ON r.id = t.region_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
    )
    .bind(tokenHash)
    .first<{
      id: string;
      region_id: string;
      scopes: string;
      region_status: string;
    }>();
  if (!row || !row.scopes.split(" ").includes(required))
    return error(401, "unauthorized");
  if (row.region_id !== regionId) return error(404, "not_found");
  if (!historical && row.region_status === "disabled")
    return error(409, "region_disabled");
  return { id: row.id, token_hash: tokenHash };
}
function actorGuard(
  db: AccountingDb,
  actor: Actor,
  regional = false,
  fresh = false,
): D1PreparedStatement {
  if (regional && fresh)
    return assertion(
      db,
      "EXISTS (SELECT 1 FROM region_tokens t JOIN regions r ON r.id = t.region_id WHERE t.id = ? AND t.token_hash = ? AND t.revoked_at IS NULL AND r.status <> 'disabled')",
      [actor.id, actor.token_hash],
    );
  return assertion(
    db,
    `EXISTS (SELECT 1 FROM ${regional ? "region_tokens" : "budget_tokens"} WHERE id = ? AND token_hash = ? AND revoked_at IS NULL)`,
    [actor.id, actor.token_hash],
  );
}
async function account(db: AccountingDb, id: string): Promise<Account> {
  const row = await db
    .prepare("SELECT * FROM budget_accounts WHERE id = ?")
    .bind(id)
    .first<Account>();
  if (!row) throw new Error("ledger_inconsistent");
  return row;
}
function accountChange(
  db: AccountingDb,
  current: Account,
  consumed: UnitVector,
  reserved: UnitVector,
  gaps = current.gap_count,
): D1PreparedStatement[] {
  return [
    assertion(
      db,
      "EXISTS (SELECT 1 FROM budget_accounts WHERE id = ? AND version_token = ?)",
      [current.id, current.version_token],
    ),
    db
      .prepare(
        "UPDATE budget_accounts SET consumed_json = ?, reserved_json = ?, gap_count = ?, version_token = ? WHERE id = ? AND version_token = ?",
      )
      .bind(
        JSON.stringify(consumed),
        JSON.stringify(reserved),
        gaps,
        crypto.randomUUID(),
        current.id,
        current.version_token,
      ),
    assertion(db, "changes() = 1"),
  ];
}
function receiptGuard(db: AccountingDb, receipt: Receipt): D1PreparedStatement {
  return assertion(
    db,
    "EXISTS (SELECT 1 FROM allowance_reservations WHERE id = ? AND version_token = ? AND revision = ? AND status = ?)",
    [receipt.id, receipt.version_token, receipt.revision, receipt.status],
  );
}
function summary(receipt: Receipt) {
  return {
    id: receipt.id,
    environmentId: receipt.environment_id,
    regionId: receipt.region_id,
    specRevision: receipt.spec_revision,
    specHash: receipt.spec_hash,
    epoch: receipt.execution_epoch,
    revision: receipt.revision,
    units: parsed(receipt.units_json),
    issuedAt: receipt.issued_at,
    expiresAt: receipt.expires_at,
    status: receipt.status,
    gapCount: receipt.gap_count,
    stoppedAt: receipt.stopped_at,
    runtimeEnforced: false,
    enforcementStatus: "pending_runtime",
  };
}
async function protectedReceipt(env: AccountingEnv, receipt: Receipt) {
  const fenceToken = await unprotectFence(
    env,
    {
      keyVersion: receipt.fence_key_version,
      iv: receipt.fence_iv,
      ciphertext: receipt.fence_ciphertext,
    },
    {
      reservationId: receipt.id,
      environmentId: receipt.environment_id,
      regionId: receipt.region_id,
      specHash: receipt.spec_hash,
    },
  );
  return { ...summary(receipt), fenceToken };
}
async function bindings(
  db: AccountingDb,
  receiptId: string,
): Promise<Binding[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM allowance_accounts WHERE reservation_id = ? ORDER BY account_id",
      )
      .bind(receiptId)
      .all<Binding>()
  ).results;
}
async function budget(
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId?: string,
): Promise<Response> {
  const target = await db
    .prepare("SELECT * FROM budget_targets WHERE id = ?")
    .bind(targetId(projectId, environmentId))
    .first<Target>();
  if (!target)
    return json({
      budget: {
        scope: environmentId ? "environment" : "project",
        revision: "0",
        executionEpoch: "0",
        requestedState: "running",
        configured: false,
        unlimitedDimensions: meters,
        runtimeEnforced: false,
        enforcementStatus: "pending_runtime",
        account: null,
        reservations: [],
      },
    });
  const current = await account(db, target.active_account_id);
  const grant = parsed(current.granted_json),
    consumed = parsed(current.consumed_json),
    reserved = parsed(current.reserved_json);
  const remaining: UnitVector = {};
  const overrun: UnitVector = {};
  for (const metric of meters) {
    if (!Object.hasOwn(grant, metric)) continue;
    const left =
      amount(grant, metric) -
      amount(consumed, metric) -
      amount(reserved, metric);
    remaining[metric] = (left > 0n ? left : 0n).toString();
    overrun[metric] = (left < 0n ? -left : 0n).toString();
  }
  const rows = await db
    .prepare(
      `SELECT r.* FROM allowance_reservations r WHERE r.organization_id = ? AND r.project_id = ? ${environmentId ? "AND r.environment_id = ?" : ""} ORDER BY r.issued_at, r.id LIMIT 101`,
    )
    .bind(
      ...(environmentId
        ? [organizationId, projectId, environmentId]
        : [organizationId, projectId]),
    )
    .all<Receipt>();
  return json({
    budget: {
      scope: environmentId ? "environment" : "project",
      revision: target.revision,
      executionEpoch: target.execution_epoch,
      requestedState: target.requested_state,
      configured: true,
      unlimitedDimensions: meters.filter(
        (metric) => !Object.hasOwn(grant, metric),
      ),
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
      account: {
        id: current.id,
        period: { start: current.period_start, end: current.period_end },
        granted: grant,
        consumed,
        reserved,
        remaining,
        overrun,
        gapCount: current.gap_count,
      },
      reservations: rows.results.slice(0, 100).map((row) => ({
        ...summary(row),
        expired: row.status === "issued" && row.expires_at <= now(),
      })),
      reservationsTruncated: rows.results.length > 100,
    },
  });
}
async function reissue(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  organizationId: string,
): Promise<Response> {
  if (!(await installation(request, env))) return error(401, "unauthorized");
  if (
    !(await db
      .prepare("SELECT id FROM organizations WHERE id = ?")
      .bind(organizationId)
      .first())
  )
    return error(404, "not_found");
  const secret = token("cpbgt");
  const at = now();
  await db.batch([
    db
      .prepare(
        "UPDATE budget_tokens SET revoked_at = ? WHERE organization_id = ? AND revoked_at IS NULL",
      )
      .bind(at, organizationId),
    db
      .prepare(
        "INSERT INTO budget_tokens (id, organization_id, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        organizationId,
        await sha256(secret),
        scopes.join(" "),
        at,
      ),
  ]);
  return json({ organizationId, apiToken: secret, scopes }, 201);
}

async function changePolicy(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  projectId: string,
  environmentId: string | undefined,
  action?: "pause" | "resume",
): Promise<Response> {
  const denied = await owner(
    request,
    db,
    organizationId,
    projectId,
    environmentId,
  );
  if (denied) return denied;
  const actor = await writer(request, db, organizationId);
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (
    !fields(
      input,
      action ? ["expectedRevision"] : ["expectedRevision", "period", "granted"],
    ) ||
    !unsigned(input.expectedRevision)
  )
    return error(400, "invalid_request");
  const fence = await projectFence(db, projectId);
  const id = targetId(projectId, environmentId);
  const target = await db
    .prepare("SELECT * FROM budget_targets WHERE id = ?")
    .bind(id)
    .first<Target>();
  if ((target?.revision ?? "0") !== input.expectedRevision)
    return error(409, "revision_conflict");
  let current: Account | null = target
    ? await account(db, target.active_account_id)
    : null;
  let grant: UnitVector;
  let start: string;
  let end: string;
  let fresh = false;
  if (action) {
    if (!target || !current) return error(409, "budget_not_configured");
    grant = parsed(current.granted_json);
    start = current.period_start;
    end = current.period_end;
  } else {
    grant = vector(input.granted) ?? {};
    if (
      !fields(input.period, ["start", "end"]) ||
      timestamp(input.period.start) === null ||
      timestamp(input.period.end) === null ||
      Object.keys(grant).length === 0
    )
      return error(400, "invalid_request");
    start = input.period.start as string;
    end = input.period.end as string;
    if (start >= end || end <= now()) return error(400, "invalid_period");
    fresh =
      !current || current.period_start !== start || current.period_end !== end;
    if (
      !fresh &&
      current &&
      JSON.stringify(Object.keys(grant).sort()) !==
        JSON.stringify(Object.keys(parsed(current.granted_json)).sort())
    )
      return error(409, "budget_dimensions_immutable");
    if (
      fresh &&
      current &&
      (current.period_end > now() || start < current.period_end)
    )
      return error(409, "period_conflict");
    if (fresh) {
      const overlap = await db
        .prepare(
          `SELECT 1 FROM usage_facts WHERE project_id = ? ${environmentId ? "AND environment_id = ?" : ""} AND interval_start < ? AND interval_end > ? LIMIT 1`,
        )
        .bind(
          ...(environmentId
            ? [projectId, environmentId, end, start]
            : [projectId, end, start]),
        )
        .first();
      const held = await db
        .prepare(
          `SELECT 1 FROM allowance_reservations WHERE project_id = ? ${environmentId ? "AND environment_id = ?" : ""} AND issued_at < ? AND expires_at > ? LIMIT 1`,
        )
        .bind(
          ...(environmentId
            ? [projectId, environmentId, end, start]
            : [projectId, end, start]),
        )
        .first();
      if (overlap || held) return error(409, "retroactive_budget_conflict");
      current = {
        id: crypto.randomUUID(),
        target_id: id,
        period_start: start,
        period_end: end,
        granted_json: JSON.stringify(grant),
        consumed_json: "{}",
        reserved_json: "{}",
        gap_count: "0",
        version_token: crypto.randomUUID(),
      };
    }
  }
  if (!current) return error(500, "state_inconsistent");
  const revision = increment(target?.revision ?? "0");
  const epoch = increment(target?.execution_epoch ?? "0");
  const requestedState =
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "running"
        : (target?.requested_state ?? "running");
  const at = now();
  const statements = [...fence.statements, actorGuard(db, actor)];
  if (!target) {
    statements.push(
      db
        .prepare(
          "INSERT INTO budget_targets (id, organization_id, project_id, environment_id, active_account_id, revision, execution_epoch, requested_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          organizationId,
          projectId,
          environmentId ?? null,
          current.id,
          revision,
          epoch,
          requestedState,
          at,
        ),
    );
  } else {
    statements.push(
      assertion(
        db,
        "EXISTS (SELECT 1 FROM budget_targets WHERE id = ? AND revision = ? AND execution_epoch = ?)",
        [id, target.revision, target.execution_epoch],
      ),
    );
    statements.push(
      db
        .prepare(
          "UPDATE budget_targets SET active_account_id = ?, revision = ?, execution_epoch = ?, requested_state = ?, updated_at = ? WHERE id = ? AND revision = ?",
        )
        .bind(
          current.id,
          revision,
          epoch,
          requestedState,
          at,
          id,
          target.revision,
        ),
    );
    statements.push(assertion(db, "changes() = 1"));
  }
  if (fresh || !target)
    statements.push(
      db
        .prepare(
          "INSERT INTO budget_accounts (id, target_id, period_start, period_end, granted_json, consumed_json, reserved_json, gap_count, version_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          current.id,
          id,
          start,
          end,
          JSON.stringify(grant),
          current.consumed_json,
          current.reserved_json,
          current.gap_count,
          current.version_token,
        ),
    );
  else {
    statements.push(
      assertion(
        db,
        "EXISTS (SELECT 1 FROM budget_accounts WHERE id = ? AND version_token = ?)",
        [current.id, current.version_token],
      ),
    );
    statements.push(
      db
        .prepare(
          "UPDATE budget_accounts SET granted_json = ?, version_token = ? WHERE id = ? AND version_token = ?",
        )
        .bind(
          JSON.stringify(grant),
          crypto.randomUUID(),
          current.id,
          current.version_token,
        ),
    );
    statements.push(assertion(db, "changes() = 1"));
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO budget_revisions (target_id, revision, account_id, execution_epoch, requested_state, granted_json, actor_token_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        revision,
        current.id,
        epoch,
        requestedState,
        JSON.stringify(grant),
        actor.id,
        at,
      ),
  );
  return (await batch(db, statements))
    ? budget(db, organizationId, projectId, environmentId)
    : error(409, "accounting_conflict");
}

async function issueAllowance(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  const actor = await regionActor(request, db, regionId, "operations:claim");
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (
    !fields(input, ["requestId", "environmentId", "leaseSeconds", "units"]) ||
    typeof input.requestId !== "string" ||
    !uuid.test(input.requestId) ||
    typeof input.environmentId !== "string" ||
    !uuid.test(input.environmentId) ||
    !Number.isInteger(input.leaseSeconds) ||
    (input.leaseSeconds as number) < 30 ||
    (input.leaseSeconds as number) > 300
  )
    return error(400, "invalid_request");
  const units = vector(input.units);
  if (!units || !Object.values(units).some((value) => BigInt(value!) > 0n))
    return error(400, "invalid_request");
  const environment = await db
    .prepare(
      "SELECT id, organization_id, project_id, region_id, spec_revision, spec_hash FROM environments WHERE id = ? AND region_id = ?",
    )
    .bind(input.environmentId, regionId)
    .first<Environment>();
  if (!environment) return error(404, "not_found");
  const requestHash = await sha256(
    JSON.stringify({
      environmentId: input.environmentId,
      leaseSeconds: input.leaseSeconds,
      units,
    }),
  );
  const fence = await projectFence(db, environment.project_id);
  const replay = await db
    .prepare(
      "SELECT * FROM allowance_reservations WHERE region_id = ? AND request_id = ?",
    )
    .bind(regionId, input.requestId)
    .first<Receipt>();
  if (replay) {
    if (replay.request_hash !== requestHash)
      return error(409, "request_conflict");
    try {
      return json({ reservation: await protectedReceipt(env, replay) });
    } catch {
      return error(503, "fence_key_unavailable");
    }
  }
  const targets = (
    await db
      .prepare(
        "SELECT * FROM budget_targets WHERE project_id = ? AND (environment_id IS NULL OR environment_id = ?) ORDER BY id",
      )
      .bind(environment.project_id, environment.id)
      .all<Target>()
  ).results;
  const holds = await db
    .prepare(
      "SELECT 1 FROM allowance_reservations WHERE project_id = ? AND ((status = 'issued' AND expires_at <= ?) OR gap_count <> '0') LIMIT 1",
    )
    .bind(environment.project_id, now())
    .first();
  if (holds) return error(409, "unreconciled_allowance");
  const id = crypto.randomUUID();
  const issuedAt = now();
  const expiresAt = new Date(
    Date.now() + (input.leaseSeconds as number) * 1000,
  ).toISOString();
  const snapshots: { target: Target; account: Account; units: UnitVector }[] =
    [];
  let epoch = 0n;
  for (const target of targets) {
    const current = await account(db, target.active_account_id);
    if (target.requested_state === "paused") return error(409, "budget_paused");
    if (current.gap_count !== "0") return error(409, "unreconciled_usage");
    if (
      issuedAt < current.period_start ||
      issuedAt >= current.period_end ||
      expiresAt > current.period_end
    )
      return error(409, "budget_period_inactive");
    const grant = parsed(current.granted_json),
      consumed = parsed(current.consumed_json),
      reserved = parsed(current.reserved_json);
    for (const metric of meters) {
      if (
        Object.hasOwn(grant, metric) &&
        amount(consumed, metric) +
          amount(reserved, metric) +
          amount(units, metric) >
          amount(grant, metric)
      )
        return error(409, "budget_exhausted");
    }
    epoch += BigInt(target.execution_epoch);
    snapshots.push({ target, account: current, units: limited(units, grant) });
  }
  const fenceToken = token("cprsv");
  let secured;
  try {
    secured = await protectFence(env, fenceToken, {
      reservationId: id,
      environmentId: environment.id,
      regionId,
      specHash: environment.spec_hash,
    });
  } catch {
    return error(503, "fence_key_unavailable");
  }
  const receipt: Receipt = {
    id,
    request_id: input.requestId,
    region_id: regionId,
    environment_id: environment.id,
    organization_id: environment.organization_id,
    project_id: environment.project_id,
    spec_revision: environment.spec_revision,
    spec_hash: environment.spec_hash,
    request_hash: requestHash,
    issued_at: issuedAt,
    expires_at: expiresAt,
    execution_epoch: epoch.toString(),
    fence_token_hash: await sha256(fenceToken),
    fence_ciphertext: secured.ciphertext,
    fence_iv: secured.iv,
    fence_key_version: secured.keyVersion,
    units_json: JSON.stringify(units),
    status: "issued",
    revision: "0",
    gap_count: "0",
    version_token: crypto.randomUUID(),
    stopped_at: null,
    stop_evidence_hash: null,
    settled_at: null,
  };
  const statements = [
    ...fence.statements,
    actorGuard(db, actor, true, true),
    db
      .prepare(
        "INSERT INTO allowance_reservations (id, request_id, region_id, environment_id, organization_id, project_id, spec_revision, spec_hash, request_hash, issued_at, expires_at, execution_epoch, fence_token_hash, fence_ciphertext, fence_iv, fence_key_version, units_json, status, revision, gap_count, version_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        input.requestId,
        regionId,
        environment.id,
        environment.organization_id,
        environment.project_id,
        environment.spec_revision,
        environment.spec_hash,
        requestHash,
        issuedAt,
        expiresAt,
        epoch.toString(),
        receipt.fence_token_hash,
        secured.ciphertext,
        secured.iv,
        secured.keyVersion,
        JSON.stringify(units),
        "issued",
        "0",
        "0",
        receipt.version_token,
      ),
  ];
  for (const snapshot of snapshots) {
    const current = snapshot.account;
    statements.push(
      ...accountChange(
        db,
        current,
        parsed(current.consumed_json),
        arithmetic(parsed(current.reserved_json), snapshot.units, 1),
      ),
    );
    statements.push(
      db
        .prepare(
          "INSERT INTO allowance_accounts (reservation_id, account_id, target_revision, target_execution_epoch, reserved_json) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(
          id,
          current.id,
          snapshot.target.revision,
          snapshot.target.execution_epoch,
          JSON.stringify(snapshot.units),
        ),
    );
  }
  if (await batch(db, statements))
    return json({ reservation: { ...summary(receipt), fenceToken } }, 201);
  const raced = await db
    .prepare(
      "SELECT * FROM allowance_reservations WHERE region_id = ? AND request_id = ?",
    )
    .bind(regionId, input.requestId)
    .first<Receipt>();
  if (raced?.request_hash === requestHash) {
    try {
      return json({ reservation: await protectedReceipt(env, raced) });
    } catch {
      return error(503, "fence_key_unavailable");
    }
  }
  return error(409, "accounting_conflict");
}

async function version(
  db: AccountingDb,
  factId: string,
  revision: number,
): Promise<
  (UsageVersion & { head_revision: number; settlement_version: number }) | null
> {
  return db
    .prepare(
      "SELECT f.*, v.*, CAST(v.acceptance_seq AS TEXT) AS acceptance_seq FROM usage_facts f JOIN usage_versions v ON v.fact_id = f.fact_id WHERE f.fact_id = ? AND v.revision = ?",
    )
    .bind(factId, revision)
    .first<
      UsageVersion & { head_revision: number; settlement_version: number }
    >();
}
function closedKnown(
  fact: UsageVersion,
  receipt: Receipt,
  stoppedAt: string,
): boolean {
  return (
    fact.environment_id === receipt.environment_id &&
    fact.region_id === receipt.region_id &&
    fact.project_id === receipt.project_id &&
    fact.organization_id === receipt.organization_id &&
    fact.status === "final" &&
    fact.quantity !== null &&
    unsigned(fact.quantity) &&
    fact.interval_start >= receipt.issued_at &&
    fact.interval_end <= stoppedAt
  );
}
async function settleAllowance(
  request: Request,
  db: AccountingDb,
  regionId: string,
  receiptId: string,
): Promise<Response> {
  const actor = await regionActor(
    request,
    db,
    regionId,
    "operations:report",
    true,
  );
  if (actor instanceof Response) return actor;
  const input = await body(request);
  if (
    !fields(input, [
      "fenceToken",
      "epoch",
      "expectedRevision",
      "usageRefs",
      "stoppedAt",
      "stopEvidenceHash",
    ]) ||
    typeof input.fenceToken !== "string" ||
    !/^cprsv_[A-Za-z0-9_-]{43}$/.test(input.fenceToken) ||
    !unsigned(input.epoch) ||
    !unsigned(input.expectedRevision) ||
    timestamp(input.stoppedAt) === null ||
    typeof input.stopEvidenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.stopEvidenceHash) ||
    !Array.isArray(input.usageRefs) ||
    input.usageRefs.length < 1 ||
    input.usageRefs.length > 32
  )
    return error(400, "invalid_request");
  const refs: { factId: string; revision: number }[] = [];
  for (const ref of input.usageRefs) {
    if (
      !fields(ref, ["factId", "revision"]) ||
      typeof ref.factId !== "string" ||
      !uuid.test(ref.factId) ||
      !Number.isSafeInteger(ref.revision) ||
      (ref.revision as number) < 1 ||
      refs.some((prior) => prior.factId === ref.factId)
    )
      return error(400, "invalid_request");
    refs.push({ factId: ref.factId, revision: ref.revision as number });
  }
  refs.sort((left, right) => left.factId.localeCompare(right.factId));
  const identity = await db
    .prepare(
      "SELECT project_id FROM allowance_reservations WHERE id = ? AND region_id = ?",
    )
    .bind(receiptId, regionId)
    .first<{ project_id: string }>();
  if (!identity) return error(404, "not_found");
  const fence = await projectFence(db, identity.project_id);
  const receipt = await db
    .prepare(
      "SELECT * FROM allowance_reservations WHERE id = ? AND region_id = ?",
    )
    .bind(receiptId, regionId)
    .first<Receipt>();
  if (
    !receipt ||
    receipt.fence_token_hash !== (await sha256(input.fenceToken)) ||
    receipt.execution_epoch !== input.epoch
  )
    return error(409, "reservation_fence_conflict");
  const evidence = {
    expectedRevision: input.expectedRevision,
    usageRefs: refs,
    stoppedAt: input.stoppedAt,
    stopEvidenceHash: input.stopEvidenceHash,
  };
  const requestHash = await sha256(JSON.stringify(evidence));
  const duplicate = await db
    .prepare(
      "SELECT revision FROM allowance_settlement_versions WHERE reservation_id = ? AND request_hash = ?",
    )
    .bind(receiptId, requestHash)
    .first();
  if (duplicate) return json({ reservation: summary(receipt) });
  if (receipt.revision !== input.expectedRevision)
    return error(409, "revision_conflict");
  const stoppedAt = input.stoppedAt as string;
  if (
    stoppedAt < receipt.issued_at ||
    stoppedAt > now() ||
    (receipt.stopped_at && stoppedAt < receipt.stopped_at)
  )
    return error(400, "invalid_stop_evidence");
  const existing = (
    await db
      .prepare(
        "SELECT * FROM allowance_usage_links WHERE reservation_id = ? ORDER BY fact_id",
      )
      .bind(receiptId)
      .all<Link>()
  ).results;
  if (existing.some((link) => !refs.some((ref) => ref.factId === link.fact_id)))
    return error(409, "settlement_evidence_removed");
  const actual: UnitVector = {};
  const previous: UnitVector = {};
  const statements = [
    ...fence.statements,
    actorGuard(db, actor, true),
    receiptGuard(db, receipt),
  ];
  for (const ref of refs) {
    const fact = await version(db, ref.factId, ref.revision);
    if (
      !fact ||
      fact.head_revision !== ref.revision ||
      !closedKnown(fact, receipt, stoppedAt)
    )
      return error(409, "usage_evidence_conflict");
    const link = await db
      .prepare("SELECT * FROM allowance_usage_links WHERE fact_id = ?")
      .bind(ref.factId)
      .first<Link>();
    if (link && link.reservation_id !== receiptId)
      return error(409, "usage_already_settled");
    const metric = fact.metric as Meter;
    actual[metric] = (
      amount(actual, metric) + BigInt(fact.quantity!)
    ).toString();
    previous[metric] = (
      amount(previous, metric) + BigInt(link?.charged_quantity ?? "0")
    ).toString();
    statements.push(
      assertion(
        db,
        "EXISTS (SELECT 1 FROM usage_facts WHERE fact_id = ? AND head_revision = ? AND settlement_version = ?)",
        [fact.fact_id, fact.head_revision, fact.settlement_version],
      ),
    );
    if (link) {
      statements.push(
        assertion(
          db,
          "EXISTS (SELECT 1 FROM allowance_usage_links WHERE fact_id = ? AND reservation_id = ? AND version_token = ?)",
          [link.fact_id, receiptId, link.version_token],
        ),
      );
      statements.push(
        db
          .prepare(
            "UPDATE allowance_usage_links SET linked_revision = ?, charged_quantity = ?, coverage_status = 'final', version_token = ? WHERE fact_id = ? AND version_token = ?",
          )
          .bind(
            ref.revision,
            fact.quantity,
            crypto.randomUUID(),
            ref.factId,
            link.version_token,
          ),
      );
      statements.push(assertion(db, "changes() = 1"));
    } else {
      statements.push(
        db
          .prepare(
            "INSERT INTO allowance_usage_links (fact_id, reservation_id, metric, linked_revision, charged_quantity, coverage_status, version_token) VALUES (?, ?, ?, ?, ?, 'final', ?)",
          )
          .bind(
            ref.factId,
            receiptId,
            metric,
            ref.revision,
            fact.quantity,
            crypto.randomUUID(),
          ),
      );
      statements.push(
        db
          .prepare(
            "UPDATE usage_facts SET settlement_version = ? WHERE fact_id = ? AND head_revision = ? AND settlement_version = ?",
          )
          .bind(
            fact.settlement_version + 1,
            fact.fact_id,
            fact.head_revision,
            fact.settlement_version,
          ),
      );
      statements.push(assertion(db, "changes() = 1"));
    }
  }
  for (const metric of meters) {
    if (
      amount(parsed(receipt.units_json), metric) > 0n &&
      !Object.hasOwn(actual, metric)
    )
      return error(409, "usage_evidence_incomplete");
  }
  const bound = await bindings(db, receiptId);
  for (const binding of bound) {
    const current = await account(db, binding.account_id);
    const grant = parsed(current.granted_json);
    const before = limited(previous, grant),
      after = limited(actual, grant);
    const consumed = arithmetic(
      arithmetic(parsed(current.consumed_json), before, -1),
      after,
      1,
    );
    const reserved =
      receipt.status === "issued"
        ? arithmetic(
            parsed(current.reserved_json),
            parsed(binding.reserved_json),
            -1,
          )
        : parsed(current.reserved_json);
    const clearedGaps = existing.reduce(
      (count, link) => count + (link.coverage_status !== "final" ? 1n : 0n),
      0n,
    );
    const gaps = BigInt(current.gap_count) - clearedGaps;
    if (gaps < 0n) return error(500, "state_inconsistent");
    statements.push(
      ...accountChange(db, current, consumed, reserved, gaps.toString()),
    );
  }
  const revision = increment(receipt.revision);
  const at = now();
  statements.push(
    db
      .prepare(
        "UPDATE allowance_reservations SET status = 'settled', revision = ?, gap_count = '0', version_token = ?, stopped_at = ?, stop_evidence_hash = ?, settled_at = ? WHERE id = ? AND version_token = ?",
      )
      .bind(
        revision,
        crypto.randomUUID(),
        stoppedAt,
        input.stopEvidenceHash,
        at,
        receiptId,
        receipt.version_token,
      ),
  );
  statements.push(assertion(db, "changes() = 1"));
  statements.push(
    db
      .prepare(
        "INSERT INTO allowance_settlement_versions (reservation_id, revision, request_hash, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(receiptId, revision, requestHash, JSON.stringify(evidence), at),
  );
  if (!(await batch(db, statements))) return error(409, "accounting_conflict");
  const settled = await db
    .prepare("SELECT * FROM allowance_reservations WHERE id = ?")
    .bind(receiptId)
    .first<Receipt>();
  if (!settled) return error(500, "state_inconsistent");
  return json({ reservation: summary(settled) });
}

// Called by usage ingestion after acquiring the shared project fence and before
// accepting its next version. Keep the per-fact linking sentinel unchanged.
export async function planBudgetCorrection(
  db: AccountingDb,
  prior: UsageVersion | null,
  next: UsageVersion,
): Promise<{
  expectedSettlementVersion: number;
  statements: D1PreparedStatement[];
}> {
  const head = await db
    .prepare("SELECT settlement_version FROM usage_facts WHERE fact_id = ?")
    .bind(next.fact_id)
    .first<{ settlement_version: number }>();
  const expectedSettlementVersion = head?.settlement_version ?? 0;
  const link = await db
    .prepare("SELECT * FROM allowance_usage_links WHERE fact_id = ?")
    .bind(next.fact_id)
    .first<Link>();
  if (!link) return { expectedSettlementVersion, statements: [] };
  if (!prior || link.linked_revision !== prior.revision)
    throw new Error("linked_usage_conflict");
  const receipt = await db
    .prepare("SELECT * FROM allowance_reservations WHERE id = ?")
    .bind(link.reservation_id)
    .first<Receipt>();
  if (!receipt || receipt.status !== "settled")
    throw new Error("linked_usage_conflict");
  const known = next.status === "final" && next.quantity !== null;
  const charged = known ? next.quantity! : link.charged_quantity;
  const delta = BigInt(charged) - BigInt(link.charged_quantity);
  const wasGap = link.coverage_status !== "final";
  const gapDelta = known ? (wasGap ? -1n : 0n) : wasGap ? 0n : 1n;
  const bound = await bindings(db, receipt.id);
  const statements = [
    receiptGuard(db, receipt),
    assertion(
      db,
      "EXISTS (SELECT 1 FROM allowance_usage_links WHERE fact_id = ? AND version_token = ? AND linked_revision = ?)",
      [link.fact_id, link.version_token, link.linked_revision],
    ),
  ];
  for (const binding of bound) {
    const current = await account(db, binding.account_id);
    const consumed = parsed(current.consumed_json);
    if (Object.hasOwn(parsed(current.granted_json), link.metric)) {
      const revised = amount(consumed, link.metric) + delta;
      if (revised < 0n) throw new Error("ledger_inconsistent");
      consumed[link.metric] = revised.toString();
    }
    const gaps = BigInt(current.gap_count) + gapDelta;
    if (gaps < 0n) throw new Error("ledger_inconsistent");
    statements.push(
      ...accountChange(
        db,
        current,
        consumed,
        parsed(current.reserved_json),
        gaps.toString(),
      ),
    );
  }
  const receiptGaps = BigInt(receipt.gap_count) + gapDelta;
  if (receiptGaps < 0n) throw new Error("ledger_inconsistent");
  statements.push(
    db
      .prepare(
        "UPDATE allowance_usage_links SET linked_revision = ?, charged_quantity = ?, coverage_status = ?, version_token = ? WHERE fact_id = ? AND version_token = ?",
      )
      .bind(
        next.revision,
        charged,
        known ? "final" : next.status,
        crypto.randomUUID(),
        link.fact_id,
        link.version_token,
      ),
  );
  statements.push(assertion(db, "changes() = 1"));
  statements.push(
    db
      .prepare(
        "UPDATE allowance_reservations SET revision = ?, gap_count = ?, version_token = ? WHERE id = ? AND version_token = ?",
      )
      .bind(
        increment(receipt.revision),
        receiptGaps.toString(),
        crypto.randomUUID(),
        receipt.id,
        receipt.version_token,
      ),
  );
  statements.push(assertion(db, "changes() = 1"));
  statements.push(
    db
      .prepare(
        "INSERT INTO allowance_usage_corrections (reservation_id, fact_id, usage_revision, payload_hash, delta_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        receipt.id,
        next.fact_id,
        next.revision,
        next.payload_hash,
        JSON.stringify({
          [link.metric]: delta.toString(),
          gapCountDelta: gapDelta.toString(),
        }),
        next.accepted_at,
      ),
  );
  return { expectedSettlementVersion, statements };
}

export async function budgetRoutes(
  request: Request,
  env: AccountingEnv,
): Promise<Response | null> {
  const db = env.DB.withSession("first-primary");
  const path = new URL(request.url).pathname;
  const authorityPath =
    /^\/v1\/regions\/([^/]+)\/allowance-reservations\/([^/]+)\/authority$/.exec(
      path,
    );
  if (request.method === "GET" && authorityPath)
    return await runtimeAuthority(
      request,
      db,
      authorityPath[1]!,
      authorityPath[2]!,
    );
  const reissuePath =
    /^\/v1\/organizations\/([^/]+)\/budget-tokens\/reissue$/.exec(path);
  if (request.method === "POST" && reissuePath)
    return reissue(request, env, db, reissuePath[1]!);
  const budgetPath =
    /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)(?:\/environments\/([^/]+))?\/budget(?:\/(pause|resume))?$/.exec(
      path,
    );
  if (budgetPath) {
    const organizationId = budgetPath[1]!,
      projectId = budgetPath[2]!,
      environmentId = budgetPath[3];
    if (request.method === "GET" && !budgetPath[4]) {
      const denied = await owner(
        request,
        db,
        organizationId,
        projectId,
        environmentId,
      );
      return denied ?? budget(db, organizationId, projectId, environmentId);
    }
    if (
      (request.method === "PUT" && !budgetPath[4]) ||
      (request.method === "POST" && budgetPath[4])
    )
      return changePolicy(
        request,
        db,
        organizationId,
        projectId,
        environmentId,
        budgetPath[4] as "pause" | "resume" | undefined,
      );
  }
  const reservations =
    /^\/v1\/regions\/([^/]+)\/allowance-reservations(?:\/([^/]+)(?:\/(settlement))?)?$/.exec(
      path,
    );
  if (reservations) {
    if (request.method === "POST" && !reservations[2])
      return issueAllowance(request, env, db, reservations[1]!);
    if (request.method === "POST" && reservations[3])
      return settleAllowance(request, db, reservations[1]!, reservations[2]!);
    if (request.method === "GET" && reservations[2] && !reservations[3]) {
      const actor = await regionActor(
        request,
        db,
        reservations[1]!,
        "operations:claim",
        true,
      );
      if (actor instanceof Response) return actor;
      const receipt = await db
        .prepare(
          "SELECT * FROM allowance_reservations WHERE id = ? AND region_id = ?",
        )
        .bind(reservations[2]!, reservations[1]!)
        .first<Receipt>();
      if (!receipt) return error(404, "not_found");
      try {
        return json({ reservation: await protectedReceipt(env, receipt) });
      } catch {
        return error(503, "fence_key_unavailable");
      }
    }
  }
  return null;
}
