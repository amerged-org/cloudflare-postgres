// SPDX-License-Identifier: Apache-2.0
import {
  bearer,
  body,
  error,
  fields,
  installation,
  json,
  sha256,
  timestamp,
  uuid,
  type AccountingDb,
  type AccountingEnv,
  type JsonObject,
} from "./accounting";

const preparerScopes = [
  "maintenance:prepare:claim",
  "maintenance:prepare:report",
] as const;
const scopesText = preparerScopes.join(" ");
const hash = /^[a-f0-9]{64}$/;
const semver =
  /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const image =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const blockers = [
  "inventory_incomplete",
  "identity_changed",
  "quorum_unproven",
  "database_availability_unproven",
  "recovery_unproven",
  "capacity_unreserved",
  "staging_unqualified",
  "evidence_stale",
  "dry_run_failed",
  "dry_run_unproven",
] as const;
type Blocker = (typeof blockers)[number];

interface MaintenancePlan {
  schemaVersion: 1;
  kind: "kubernetes.upgrade";
  clusterUid: string;
  nodeUids: string[];
  fromVersion: string;
  toVersion: string;
  talosVersion: string;
  toolImage: string;
  targetArtifactsHash: string;
}
interface MaintenanceAssessment {
  observedAt: string;
  expiresAt: string;
  evidenceHash: string;
  blockers: Blocker[];
  dryRun: {
    status: "not_run" | "succeeded" | "failed";
    jobUid: string | null;
  };
}
interface PreparationRow {
  id: string;
  region_id: string;
  kind: "maintenance.prepare";
  plan_hash: string;
  plan_json: string;
  status: "queued" | "running" | "assessed";
  eligibility: "blocked" | "eligible" | null;
  created_at: string;
  assessed_at: string | null;
  assessment_json: string | null;
  lease_preparer_token_id: string | null;
  lease_token_hash: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  result_hash: string | null;
}
interface PreparerAuthority {
  id: string;
  tokenHash: string;
}
interface RequestRow {
  request_hash: string;
  operation_id: string;
}

function text(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function secret(prefix: "cpmtp" | "cpmtl"): string {
  return (
    prefix +
    "_" +
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );
}
function plan(value: unknown): MaintenancePlan | null {
  if (
    !fields(value, [
      "schemaVersion",
      "kind",
      "clusterUid",
      "nodeUids",
      "fromVersion",
      "toVersion",
      "talosVersion",
      "toolImage",
      "targetArtifactsHash",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "kubernetes.upgrade" ||
    !text(value.clusterUid, uuid) ||
    !Array.isArray(value.nodeUids) ||
    value.nodeUids.length < 1 ||
    value.nodeUids.length > 100 ||
    !value.nodeUids.every((node): node is string => text(node, uuid)) ||
    new Set(value.nodeUids).size !== value.nodeUids.length ||
    value.nodeUids.some(
      (node, index, nodes) => index > 0 && nodes[index - 1]! >= node,
    ) ||
    !text(value.fromVersion, semver) ||
    !text(value.toVersion, semver) ||
    !text(value.talosVersion, semver) ||
    !text(value.toolImage, image) ||
    value.toolImage.length > 512 ||
    !text(value.targetArtifactsHash, hash)
  )
    return null;
  const from = value.fromVersion.split(".").map(Number);
  const to = value.toVersion.split(".").map(Number);
  if (
    to[0] !== from[0] ||
    to[1]! < from[1]! ||
    to[1]! > from[1]! + 1 ||
    (to[1] === from[1] && to[2]! < from[2]!)
  )
    return null;
  return {
    schemaVersion: 1,
    kind: "kubernetes.upgrade",
    clusterUid: value.clusterUid,
    nodeUids: [...value.nodeUids],
    fromVersion: value.fromVersion,
    toVersion: value.toVersion,
    talosVersion: value.talosVersion,
    toolImage: value.toolImage,
    targetArtifactsHash: value.targetArtifactsHash,
  };
}
function assessment(value: unknown): MaintenanceAssessment | null {
  if (
    !fields(value, [
      "observedAt",
      "expiresAt",
      "evidenceHash",
      "blockers",
      "dryRun",
    ]) ||
    !text(value.evidenceHash, hash) ||
    !Array.isArray(value.blockers) ||
    value.blockers.length > blockers.length ||
    !value.blockers.every(
      (blocker): blocker is Blocker =>
        typeof blocker === "string" &&
        (blockers as readonly string[]).includes(blocker),
    ) ||
    new Set(value.blockers).size !== value.blockers.length ||
    !fields(value.dryRun, ["status", "jobUid"]) ||
    !["not_run", "succeeded", "failed"].includes(
      value.dryRun.status as string,
    ) ||
    (value.dryRun.jobUid !== null && !text(value.dryRun.jobUid, uuid)) ||
    (value.dryRun.status === "not_run" && value.dryRun.jobUid !== null) ||
    (value.dryRun.status === "succeeded" && value.dryRun.jobUid === null)
  )
    return null;
  const observed = timestamp(value.observedAt);
  const expires = timestamp(value.expiresAt);
  if (
    observed === null ||
    expires === null ||
    expires <= observed ||
    expires - observed > 300_000
  )
    return null;
  return {
    observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    evidenceHash: value.evidenceHash,
    blockers: [...value.blockers].sort(),
    dryRun: {
      status: value.dryRun.status as MaintenanceAssessment["dryRun"]["status"],
      jobUid: value.dryRun.jobUid,
    },
  };
}
function publicPreparation(row: PreparationRow) {
  return {
    id: row.id,
    regionId: row.region_id,
    kind: row.kind,
    planHash: row.plan_hash,
    plan: JSON.parse(row.plan_json) as MaintenancePlan,
    status: row.status,
    assessment:
      row.assessment_json === null
        ? null
        : (JSON.parse(row.assessment_json) as MaintenanceAssessment),
    eligibility: row.eligibility,
    executionSupported: false,
    executionAuthorized: false,
    createdAt: row.created_at,
    assessedAt: row.assessed_at,
  };
}
async function enabledRegion(
  db: AccountingDb,
  regionId: string,
): Promise<Response | null> {
  const region = await db
    .prepare("SELECT status FROM regions WHERE id = ?")
    .bind(regionId)
    .first<{ status: string }>();
  return !region
    ? error(404, "not_found")
    : region.status === "disabled"
      ? error(409, "region_disabled")
      : null;
}
async function authorize(
  request: Request,
  db: AccountingDb,
  regionId: string,
  scope: (typeof preparerScopes)[number],
): Promise<PreparerAuthority | Response> {
  const supplied = bearer(request);
  if (!supplied || !/^cpmtp_[A-Za-z0-9_-]{43}$/.test(supplied))
    return error(401, "unauthorized");
  const tokenHash = await sha256(supplied);
  const row = await db
    .prepare(
      "SELECT t.id, t.region_id, t.scopes, r.status FROM maintenance_preparer_tokens t JOIN regions r ON r.id = t.region_id WHERE t.token_hash = ? AND t.revoked_at IS NULL",
    )
    .bind(tokenHash)
    .first<{ id: string; region_id: string; scopes: string; status: string }>();
  if (!row || !row.scopes.split(" ").includes(scope))
    return error(401, "unauthorized");
  if (row.region_id !== regionId) return error(404, "not_found");
  if (row.status === "disabled") return error(409, "region_disabled");
  return { id: row.id, tokenHash };
}
const activeAuthority =
  "EXISTS (SELECT 1 FROM maintenance_preparer_tokens t JOIN regions r ON r.id = t.region_id WHERE t.id = ? AND t.token_hash = ? AND t.region_id = ? AND t.scopes = ? AND t.revoked_at IS NULL AND r.status <> 'disabled')";
function authorityBindings(
  authority: PreparerAuthority,
  regionId: string,
): string[] {
  return [authority.id, authority.tokenHash, regionId, scopesText];
}
async function read(
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<PreparationRow | null> {
  return db
    .prepare(
      "SELECT * FROM maintenance_preparations WHERE id = ? AND region_id = ?",
    )
    .bind(operationId, regionId)
    .first<PreparationRow>();
}
async function issue(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  if (!(await installation(request, env))) return error(401, "unauthorized");
  const denied = await enabledRegion(db, regionId);
  if (denied) return denied;
  if (!fields(await body(request), [])) return error(400, "invalid_request");
  const apiToken = secret("cpmtp");
  const now = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        "UPDATE maintenance_preparer_tokens SET revoked_at = ? WHERE region_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM regions WHERE id = ? AND status <> 'disabled')",
      )
      .bind(now, regionId, regionId),
    db
      .prepare(
        "INSERT INTO maintenance_preparer_tokens (id, region_id, token_hash, scopes, created_at) SELECT ?, id, ?, ?, ? FROM regions WHERE id = ? AND status <> 'disabled'",
      )
      .bind(
        crypto.randomUUID(),
        await sha256(apiToken),
        scopesText,
        now,
        regionId,
      ),
  ]);
  return results[1]!.meta.changes === 1
    ? json({ apiToken, scopes: preparerScopes }, 201)
    : error(409, "region_disabled");
}
async function create(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  if (!(await installation(request, env))) return error(401, "unauthorized");
  const denied = await enabledRegion(db, regionId);
  if (denied) return denied;
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[A-Za-z0-9._~-]{1,128}$/.test(key))
    return error(400, "invalid_idempotency_key");
  const input = await body(request);
  const canonical = fields(input, ["plan"]) ? plan(input.plan) : null;
  if (!canonical) return error(400, "invalid_request");
  const serialized = JSON.stringify(canonical);
  const planHash = await sha256(serialized);
  const requestHash = await sha256(
    `POST /v1/regions/${regionId}/maintenance/preparations\n${serialized}`,
  );
  const existing = () =>
    db
      .prepare(
        "SELECT request_hash, operation_id FROM maintenance_preparation_requests WHERE region_id = ? AND idempotency_key = ?",
      )
      .bind(regionId, key)
      .first<RequestRow>();
  const replay = async (row: RequestRow): Promise<Response> => {
    if (row.request_hash !== requestHash)
      return error(409, "idempotency_conflict");
    const operation = await read(db, regionId, row.operation_id);
    return operation
      ? json({ preparation: publicPreparation(operation) })
      : error(500, "state_inconsistent");
  };
  const prior = await existing();
  if (prior) return replay(prior);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const written = await db.batch([
      db
        .prepare(
          "INSERT INTO maintenance_preparations (id, region_id, kind, plan_hash, plan_json, status, created_at) SELECT ?, id, 'maintenance.prepare', ?, ?, 'queued', ? FROM regions WHERE id = ? AND status <> 'disabled'",
        )
        .bind(id, planHash, serialized, now, regionId),
      db
        .prepare(
          "INSERT INTO maintenance_preparation_requests (region_id, idempotency_key, request_hash, operation_id, created_at) SELECT region_id, ?, ?, id, ? FROM maintenance_preparations WHERE id = ? AND region_id = ?",
        )
        .bind(key, requestHash, now, id, regionId),
    ]);
    if (written[0]!.meta.changes !== 1) return error(409, "region_disabled");
  } catch {
    const winner = await existing();
    return winner ? replay(winner) : error(500, "write_failed");
  }
  const created = await read(db, regionId, id);
  return created
    ? json({ preparation: publicPreparation(created) }, 201)
    : error(500, "state_inconsistent");
}
async function get(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  if (!(await installation(request, env))) return error(401, "unauthorized");
  const denied = await enabledRegion(db, regionId);
  if (denied) return denied;
  const row = await read(db, regionId, operationId);
  return row
    ? json({ preparation: publicPreparation(row) })
    : error(404, "not_found");
}
function validLease(
  input: JsonObject,
): input is JsonObject & { leaseToken: string; leaseEpoch: number } {
  return (
    text(input.leaseToken, /^cpmtl_[A-Za-z0-9_-]{43}$/) &&
    integer(input.leaseEpoch, 1, Number.MAX_SAFE_INTEGER)
  );
}
async function claim(
  request: Request,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  const authority = await authorize(
    request,
    db,
    regionId,
    "maintenance:prepare:claim",
  );
  if (authority instanceof Response) return authority;
  const input = await body(request);
  if (!fields(input, ["leaseSeconds"]) || !integer(input.leaseSeconds, 30, 300))
    return error(400, "invalid_request");
  const leaseToken = secret("cpmtl");
  const now = Date.now();
  const expiresAt = new Date(now + input.leaseSeconds * 1000).toISOString();
  const operation = await db
    .prepare(
      `UPDATE maintenance_preparations SET status = 'running', lease_token_hash = ?, lease_preparer_token_id = ?, lease_epoch = lease_epoch + 1, lease_expires_at = ? WHERE id = (SELECT id FROM maintenance_preparations WHERE region_id = ? AND lease_epoch < 9007199254740991 AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?)) ORDER BY created_at, id LIMIT 1) AND region_id = ? AND lease_epoch < 9007199254740991 AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?)) AND ${activeAuthority} RETURNING *`,
    )
    .bind(
      await sha256(leaseToken),
      authority.id,
      expiresAt,
      regionId,
      new Date(now).toISOString(),
      regionId,
      new Date(now).toISOString(),
      ...authorityBindings(authority, regionId),
    )
    .first<PreparationRow>();
  return json({
    claim: operation
      ? {
          operationId: operation.id,
          regionId,
          plan: JSON.parse(operation.plan_json) as MaintenancePlan,
          planHash: operation.plan_hash,
          leaseToken,
          leaseEpoch: operation.lease_epoch,
          leaseExpiresAt: operation.lease_expires_at,
        }
      : null,
  });
}
async function renew(
  request: Request,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const authority = await authorize(
    request,
    db,
    regionId,
    "maintenance:prepare:claim",
  );
  if (authority instanceof Response) return authority;
  const input = await body(request);
  if (
    !fields(input, ["leaseToken", "leaseEpoch", "leaseSeconds"]) ||
    !validLease(input) ||
    !integer(input.leaseSeconds, 30, 300)
  )
    return error(400, "invalid_request");
  const now = Date.now();
  const expiresAt = new Date(now + input.leaseSeconds * 1000).toISOString();
  const updated = await db
    .prepare(
      `UPDATE maintenance_preparations SET lease_expires_at = ? WHERE id = ? AND region_id = ? AND status = 'running' AND lease_preparer_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND ${activeAuthority} RETURNING id`,
    )
    .bind(
      expiresAt,
      operationId,
      regionId,
      authority.id,
      await sha256(input.leaseToken),
      input.leaseEpoch,
      new Date(now).toISOString(),
      ...authorityBindings(authority, regionId),
    )
    .first();
  return updated
    ? json({ leaseExpiresAt: expiresAt })
    : error(409, "lease_conflict");
}
async function result(
  request: Request,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  const authority = await authorize(
    request,
    db,
    regionId,
    "maintenance:prepare:report",
  );
  if (authority instanceof Response) return authority;
  const input = await body(request);
  if (
    !fields(input, ["leaseToken", "leaseEpoch", "planHash", "assessment"]) ||
    !validLease(input) ||
    !text(input.planHash, hash)
  )
    return error(400, "invalid_request");
  const canonical = assessment(input.assessment);
  if (!canonical) return error(400, "invalid_request");
  const resultHash = await sha256(
    JSON.stringify({ planHash: input.planHash, assessment: canonical }),
  );
  const leaseHash = await sha256(input.leaseToken);
  const completed = () =>
    db
      .prepare(
        `SELECT * FROM maintenance_preparations WHERE id = ? AND region_id = ? AND status = 'assessed' AND plan_hash = ? AND lease_preparer_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND result_hash = ? AND ${activeAuthority}`,
      )
      .bind(
        operationId,
        regionId,
        input.planHash,
        authority.id,
        leaseHash,
        input.leaseEpoch,
        resultHash,
        ...authorityBindings(authority, regionId),
      )
      .first<PreparationRow>();
  const prior = await completed();
  if (prior) return json({ preparation: publicPreparation(prior) });
  const now = Date.now();
  const observedAt = Date.parse(canonical.observedAt);
  if (
    observedAt > now ||
    now - observedAt > 300_000 ||
    Date.parse(canonical.expiresAt) <= now
  )
    return error(400, "invalid_assessment");
  const eligibility =
    canonical.blockers.length === 0 &&
    canonical.dryRun.status === "succeeded" &&
    canonical.dryRun.jobUid !== null
      ? "eligible"
      : "blocked";
  const updated = await db
    .prepare(
      `UPDATE maintenance_preparations SET status = 'assessed', eligibility = ?, assessed_at = ?, assessment_json = ?, result_hash = ? WHERE id = ? AND region_id = ? AND status = 'running' AND plan_hash = ? AND lease_preparer_token_id = ? AND lease_token_hash = ? AND lease_epoch = ? AND lease_expires_at > ? AND ${activeAuthority} RETURNING *`,
    )
    .bind(
      eligibility,
      new Date(now).toISOString(),
      JSON.stringify(canonical),
      resultHash,
      operationId,
      regionId,
      input.planHash,
      authority.id,
      leaseHash,
      input.leaseEpoch,
      new Date(now).toISOString(),
      ...authorityBindings(authority, regionId),
    )
    .first<PreparationRow>();
  if (updated) return json({ preparation: publicPreparation(updated) }, 201);
  const winner = await completed();
  return winner
    ? json({ preparation: publicPreparation(winner) })
    : error(409, "lease_conflict");
}

export async function maintenanceRoutes(
  request: Request,
  env: AccountingEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match =
    /^\/v1\/regions\/([^/]+)\/maintenance\/(preparers|preparations)(?:\/([^/]+)(?:\/(lease|result))?)?$/.exec(
      url.pathname,
    );
  if (!match) return null;
  const [, regionId, collection, operationId, action] = match;
  if (!regionId || !uuid.test(regionId) || url.searchParams.size > 0)
    return error(400, "invalid_request");
  try {
    const db = env.DB.withSession("first-primary");
    if (request.method === "POST" && collection === "preparers" && !operationId)
      return await issue(request, env, db, regionId);
    if (collection !== "preparations") return null;
    if (request.method === "POST" && !operationId)
      return await create(request, env, db, regionId);
    if (request.method === "POST" && operationId === "claim" && !action)
      return await claim(request, db, regionId);
    if (!operationId || !uuid.test(operationId)) return null;
    if (request.method === "GET" && !action)
      return await get(request, env, db, regionId, operationId);
    if (request.method === "POST" && action === "lease")
      return await renew(request, db, regionId, operationId);
    if (request.method === "POST" && action === "result")
      return await result(request, db, regionId, operationId);
    return null;
  } catch {
    // Do not expose provider errors, private plan evidence, or credential data.
    return error(500, "maintenance_unavailable");
  }
}
