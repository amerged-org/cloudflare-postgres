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
  sha256,
  timestamp,
  token,
  unsigned,
  uuid,
  type AccountingDb,
  type AccountingEnv,
  type Meter,
  type UnitVector,
} from "./accounting";

export interface UsageVersion {
  acceptance_seq: string | null;
  fact_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  region_id: string;
  source_id: string;
  source_epoch: number;
  metric: Meter;
  attribution: "primary" | "replica" | "backup" | "wal" | "platform";
  interval_start: string;
  interval_end: string;
  revision: number;
  expected_previous_revision: number;
  quantity: string | null;
  status: "provisional" | "final" | "gap";
  evidence_hash: string;
  payload_hash: string;
  accepted_at: string;
}

export type CorrectionPlanner = (
  db: AccountingDb,
  previous: UsageVersion | null,
  next: UsageVersion,
) => Promise<{
  expectedSettlementVersion: number;
  statements: D1PreparedStatement[];
}>;

interface FactHead extends Omit<
  UsageVersion,
  | "acceptance_seq"
  | "revision"
  | "expected_previous_revision"
  | "quantity"
  | "status"
  | "evidence_hash"
  | "payload_hash"
  | "accepted_at"
> {
  head_revision: number;
  settlement_version: number;
}

interface MeterIdentity {
  region_id: string;
  source_id: string;
  source_epoch: number;
}

interface UsageInput {
  factId: string;
  environmentId: string;
  sourceId: string;
  sourceEpoch: number;
  revision: number;
  expectedPreviousRevision: number;
  metric: Meter;
  attribution: UsageVersion["attribution"];
  start: string;
  end: string;
  quantity: string | null;
  status: UsageVersion["status"];
  evidenceHash: string;
}

interface QueryFilters {
  from: string;
  to: string;
  projectId: string | null;
  environmentId: string | null;
}

interface Cursor {
  version: 1;
  binding: string;
  watermark: string;
  after: { start: string; factId: string };
}

const int64Maximum = 9_223_372_036_854_775_807n;
const usageColumns = `f.fact_id, f.organization_id, f.project_id, f.environment_id,
  f.region_id, f.source_id, f.source_epoch, f.metric, f.attribution,
  f.interval_start, f.interval_end, v.revision, v.expected_previous_revision,
  v.quantity, v.status, v.evidence_hash, v.payload_hash, v.accepted_at,
  CAST(v.acceptance_seq AS TEXT) AS acceptance_seq`;

function integer(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function usageInput(input: unknown): UsageInput | null {
  if (
    !fields(input, [
      "factId",
      "environmentId",
      "sourceId",
      "sourceEpoch",
      "revision",
      "expectedPreviousRevision",
      "metric",
      "attribution",
      "start",
      "end",
      "quantity",
      "status",
      "evidenceHash",
    ]) ||
    typeof input.factId !== "string" ||
    !uuid.test(input.factId) ||
    typeof input.environmentId !== "string" ||
    !uuid.test(input.environmentId) ||
    typeof input.sourceId !== "string" ||
    !uuid.test(input.sourceId) ||
    !integer(input.sourceEpoch, 1) ||
    !integer(input.revision, 1) ||
    !integer(input.expectedPreviousRevision, 0) ||
    !(meters as readonly unknown[]).includes(input.metric) ||
    !["primary", "replica", "backup", "wal", "platform"].includes(
      input.attribution as string,
    ) ||
    !["provisional", "final", "gap"].includes(input.status as string) ||
    typeof input.evidenceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.evidenceHash)
  )
    return null;
  const start = timestamp(input.start);
  const end = timestamp(input.end);
  if (
    start === null ||
    end === null ||
    end <= start ||
    end - start > 60_000 ||
    Math.floor(start / 60_000) !== Math.floor((end - 1) / 60_000) ||
    (input.status === "gap"
      ? input.quantity !== null
      : !unsigned(input.quantity))
  )
    return null;
  return {
    factId: input.factId,
    environmentId: input.environmentId,
    sourceId: input.sourceId,
    sourceEpoch: input.sourceEpoch,
    revision: input.revision,
    expectedPreviousRevision: input.expectedPreviousRevision,
    metric: input.metric as Meter,
    attribution: input.attribution as UsageVersion["attribution"],
    start: input.start as string,
    end: input.end as string,
    quantity: input.quantity as string | null,
    status: input.status as UsageVersion["status"],
    evidenceHash: input.evidenceHash,
  };
}

function publicFact(row: UsageVersion) {
  return {
    factId: row.fact_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    regionId: row.region_id,
    sourceId: row.source_id,
    sourceEpoch: row.source_epoch,
    revision: row.revision,
    expectedPreviousRevision: row.expected_previous_revision,
    metric: row.metric,
    attribution: row.attribution,
    start: row.interval_start,
    end: row.interval_end,
    quantity: row.quantity,
    status: row.status,
    evidenceHash: row.evidence_hash,
    acceptanceSequence: row.acceptance_seq,
    acceptedAt: row.accepted_at,
  };
}

async function version(
  db: AccountingDb,
  factId: string,
  revision: number,
): Promise<UsageVersion | null> {
  return db
    .prepare(
      `SELECT ${usageColumns} FROM usage_facts AS f JOIN usage_versions AS v ON v.fact_id = f.fact_id WHERE f.fact_id = ? AND v.revision = ?`,
    )
    .bind(factId, revision)
    .first<UsageVersion>();
}

async function reissueMeter(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  regionId: string,
): Promise<Response> {
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    return error(503, "bootstrap_unconfigured");
  if (!(await installation(request, env))) return error(401, "unauthorized");
  const region = await db
    .prepare("SELECT status FROM regions WHERE id = ?")
    .bind(regionId)
    .first<{ status: string }>();
  if (!region) return error(404, "not_found");
  if (region.status === "disabled") return error(409, "region_disabled");
  const apiToken = token("cpmtr");
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO usage_sources (source_id, region_id, source_epoch, created_at) VALUES (?, ?, 1, ?)",
      )
      .bind(crypto.randomUUID(), regionId, now),
    db
      .prepare(
        "UPDATE usage_meter_tokens SET revoked_at = ? WHERE region_id = ? AND revoked_at IS NULL",
      )
      .bind(now, regionId),
    db
      .prepare(
        "INSERT INTO usage_meter_tokens (id, region_id, source_id, source_epoch, token_hash, scopes, created_at) SELECT ?, region_id, source_id, source_epoch, ?, 'usage:write', ? FROM usage_sources WHERE region_id = ?",
      )
      .bind(crypto.randomUUID(), await sha256(apiToken), now, regionId),
  ]);
  const source = await db
    .prepare(
      "SELECT region_id, source_id, source_epoch FROM usage_sources WHERE region_id = ?",
    )
    .bind(regionId)
    .first<MeterIdentity>();
  if (!source) return error(500, "state_inconsistent");
  return json(
    {
      regionId,
      sourceId: source.source_id,
      sourceEpoch: source.source_epoch,
      apiToken,
      scopes: ["usage:write"],
    },
    201,
  );
}

async function meterIdentity(
  request: Request,
  db: AccountingDb,
  regionId: string,
): Promise<MeterIdentity | Response> {
  const supplied = bearer(request);
  if (!supplied || !supplied.startsWith("cpmtr_"))
    return error(401, "unauthorized");
  const identity = await db
    .prepare(
      "SELECT t.region_id, t.source_id, t.source_epoch, r.status FROM usage_meter_tokens AS t JOIN regions AS r ON r.id = t.region_id WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.scopes = 'usage:write'",
    )
    .bind(await sha256(supplied))
    .first<MeterIdentity & { status: string }>();
  if (!identity) return error(401, "unauthorized");
  if (identity.region_id !== regionId) return error(404, "not_found");
  if (identity.status === "disabled") return error(403, "region_disabled");
  return identity;
}

function sameIdentity(head: FactHead, next: UsageVersion): boolean {
  return (
    head.organization_id === next.organization_id &&
    head.project_id === next.project_id &&
    head.environment_id === next.environment_id &&
    head.region_id === next.region_id &&
    head.source_id === next.source_id &&
    head.source_epoch === next.source_epoch &&
    head.metric === next.metric &&
    head.attribution === next.attribution &&
    head.interval_start === next.interval_start &&
    head.interval_end === next.interval_end
  );
}

async function ingest(
  request: Request,
  db: AccountingDb,
  regionId: string,
  correctionPlanner?: CorrectionPlanner,
): Promise<Response> {
  const identity = await meterIdentity(request, db, regionId);
  if (identity instanceof Response) return identity;
  const input = usageInput(await body(request));
  if (!input) return error(400, "invalid_request");
  if (
    input.sourceId !== identity.source_id ||
    input.sourceEpoch !== identity.source_epoch
  )
    return error(409, "source_identity_conflict");
  const environment = await db
    .prepare(
      "SELECT organization_id, project_id, region_id FROM environments WHERE id = ?",
    )
    .bind(input.environmentId)
    .first<{
      organization_id: string;
      project_id: string;
      region_id: string;
    }>();
  if (!environment || environment.region_id !== regionId)
    return error(404, "not_found");
  const fence = await projectFence(db, environment.project_id);
  const payloadHash = await sha256(JSON.stringify(input));
  const replay = await version(db, input.factId, input.revision);
  if (replay)
    return replay.payload_hash === payloadHash && replay.region_id === regionId
      ? json({ fact: publicFact(replay) })
      : error(409, "usage_revision_conflict");
  const head = await db
    .prepare("SELECT * FROM usage_facts WHERE fact_id = ?")
    .bind(input.factId)
    .first<FactHead>();
  const next: UsageVersion = {
    acceptance_seq: null,
    fact_id: input.factId,
    organization_id: environment.organization_id,
    project_id: environment.project_id,
    environment_id: input.environmentId,
    region_id: regionId,
    source_id: input.sourceId,
    source_epoch: input.sourceEpoch,
    metric: input.metric,
    attribution: input.attribution,
    interval_start: input.start,
    interval_end: input.end,
    revision: input.revision,
    expected_previous_revision: input.expectedPreviousRevision,
    quantity: input.quantity,
    status: input.status,
    evidence_hash: input.evidenceHash,
    payload_hash: payloadHash,
    accepted_at: new Date().toISOString(),
  };
  if (
    input.revision !== input.expectedPreviousRevision + 1 ||
    (head &&
      (!sameIdentity(head, next) ||
        head.head_revision !== input.expectedPreviousRevision)) ||
    (!head && input.expectedPreviousRevision !== 0)
  )
    return error(409, "usage_revision_conflict");
  const previous = head
    ? await version(db, input.factId, head.head_revision)
    : null;
  if (!correctionPlanner && head && head.settlement_version !== 0)
    return error(503, "correction_planner_unavailable");
  const settlement = correctionPlanner
    ? await correctionPlanner(db, previous, next)
    : {
        expectedSettlementVersion: head?.settlement_version ?? 0,
        statements: [],
      };
  const statements: D1PreparedStatement[] = [...fence.statements];
  if (!head)
    statements.push(
      db
        .prepare(
          "INSERT INTO usage_facts (fact_id, organization_id, project_id, environment_id, region_id, source_id, source_epoch, metric, attribution, interval_start, interval_end, head_revision, settlement_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
        )
        .bind(
          next.fact_id,
          next.organization_id,
          next.project_id,
          next.environment_id,
          next.region_id,
          next.source_id,
          next.source_epoch,
          next.metric,
          next.attribution,
          next.interval_start,
          next.interval_end,
        ),
    );
  statements.push(
    assertion(
      db,
      "EXISTS (SELECT 1 FROM usage_facts WHERE fact_id = ? AND head_revision = ? AND settlement_version = ?)",
      [
        input.factId,
        input.expectedPreviousRevision,
        settlement.expectedSettlementVersion,
      ],
    ),
    ...settlement.statements,
    db
      .prepare(
        "UPDATE usage_facts SET head_revision = ? WHERE fact_id = ? AND head_revision = ? AND settlement_version = ?",
      )
      .bind(
        input.revision,
        input.factId,
        input.expectedPreviousRevision,
        settlement.expectedSettlementVersion,
      ),
    assertion(
      db,
      "EXISTS (SELECT 1 FROM usage_facts WHERE fact_id = ? AND head_revision = ? AND settlement_version = ?)",
      [input.factId, input.revision, settlement.expectedSettlementVersion],
    ),
    db
      .prepare(
        "INSERT INTO usage_versions (fact_id, revision, expected_previous_revision, quantity, status, evidence_hash, payload_hash, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        input.factId,
        input.revision,
        input.expectedPreviousRevision,
        input.quantity,
        input.status,
        input.evidenceHash,
        payloadHash,
        next.accepted_at,
      ),
  );
  try {
    await db.batch(statements);
  } catch {
    const winner = await version(db, input.factId, input.revision);
    if (winner?.payload_hash === payloadHash && winner.region_id === regionId)
      return json({ fact: publicFact(winner) });
    return error(409, "usage_revision_conflict");
  }
  const accepted = await version(db, input.factId, input.revision);
  return accepted
    ? json({ fact: publicFact(accepted) }, 201)
    : error(500, "state_inconsistent");
}

function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
}

async function cursorKey(env: AccountingEnv): Promise<CryptoKey> {
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    throw new Error("cursor_key_unavailable");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.INSTALLATION_BOOTSTRAP_TOKEN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function encodeCursor(
  env: AccountingEnv,
  cursor: Cursor,
): Promise<string> {
  const content = new TextEncoder().encode(JSON.stringify(cursor));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await cursorKey(env),
    content,
  );
  return `${base64(content)}.${base64(new Uint8Array(signature))}`;
}

async function decodeCursor(
  env: AccountingEnv,
  value: string,
  binding: string,
): Promise<Cursor | null> {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value))
    return null;
  try {
    const [content, signature] = value.split(".");
    const bytes = unbase64(content!);
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await cursorKey(env),
        unbase64(signature!),
        bytes,
      ))
    )
      return null;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (
      !fields(parsed, ["version", "binding", "watermark", "after"]) ||
      parsed.version !== 1 ||
      parsed.binding !== binding ||
      !unsigned(parsed.watermark) ||
      BigInt(parsed.watermark) > int64Maximum ||
      !fields(parsed.after, ["start", "factId"]) ||
      timestamp(parsed.after.start) === null ||
      typeof parsed.after.factId !== "string" ||
      !uuid.test(parsed.after.factId)
    )
      return null;
    return parsed as unknown as Cursor;
  } catch {
    return null;
  }
}

async function query(
  request: Request,
  env: AccountingEnv,
  db: AccountingDb,
  organizationId: string,
  ndjson: boolean,
): Promise<Response> {
  const denied = await organizationRead(request, db, organizationId, "usage");
  if (denied) return denied;
  const parameters = new URL(request.url).searchParams;
  const allowed = [
    "from",
    "to",
    "projectId",
    "environmentId",
    "limit",
    "cursor",
  ];
  if (
    [...parameters.keys()].some(
      (key) => !allowed.includes(key) || parameters.getAll(key).length !== 1,
    )
  )
    return error(400, "invalid_request");
  const from = parameters.get("from");
  const to = parameters.get("to");
  const start = timestamp(from, true);
  const end = timestamp(to, true);
  const limitText = parameters.get("limit") ?? "50";
  if (
    start === null ||
    end === null ||
    end <= start ||
    end - start > 31 * 86_400_000 ||
    !/^[1-9][0-9]{0,2}$/.test(limitText) ||
    Number(limitText) > 100
  )
    return error(400, "invalid_request");
  const projectId = parameters.get("projectId");
  const environmentId = parameters.get("environmentId");
  if (
    (projectId !== null && !uuid.test(projectId)) ||
    (environmentId !== null && !uuid.test(environmentId))
  )
    return error(400, "invalid_request");
  if (
    projectId !== null &&
    !(await db
      .prepare("SELECT id FROM projects WHERE id = ? AND organization_id = ?")
      .bind(projectId, organizationId)
      .first())
  )
    return error(404, "not_found");
  if (environmentId !== null) {
    const environment = await db
      .prepare(
        "SELECT project_id FROM environments WHERE id = ? AND organization_id = ?",
      )
      .bind(environmentId, organizationId)
      .first<{ project_id: string }>();
    if (
      !environment ||
      (projectId !== null && environment.project_id !== projectId)
    )
      return error(404, "not_found");
  }
  const filters: QueryFilters = {
    from: from!,
    to: to!,
    projectId,
    environmentId,
  };
  const binding = await sha256(JSON.stringify({ organizationId, ...filters }));
  const suppliedCursor = parameters.get("cursor");
  const cursor =
    suppliedCursor === null
      ? null
      : await decodeCursor(env, suppliedCursor, binding);
  if (suppliedCursor !== null && cursor === null)
    return error(400, "invalid_cursor");
  const current = await db
    .prepare(
      "SELECT COALESCE(CAST(MAX(v.acceptance_seq) AS TEXT), '0') AS watermark FROM usage_versions AS v JOIN usage_facts AS f ON f.fact_id = v.fact_id WHERE f.organization_id = ?",
    )
    .bind(organizationId)
    .first<{ watermark: string }>();
  if (!current) return error(500, "state_inconsistent");
  const watermark = cursor?.watermark ?? current.watermark;
  if (BigInt(watermark) > BigInt(current.watermark))
    return error(409, "snapshot_unavailable");
  const conditions = [
    "f.organization_id = ?",
    "f.interval_start >= ?",
    "f.interval_end <= ?",
    "v.acceptance_seq = (SELECT MAX(accepted.acceptance_seq) FROM usage_versions AS accepted WHERE accepted.fact_id = f.fact_id AND accepted.acceptance_seq <= CAST(? AS INTEGER))",
  ];
  const bindings: Array<string | number> = [
    organizationId,
    filters.from,
    filters.to,
    watermark,
  ];
  if (projectId !== null) {
    conditions.push("f.project_id = ?");
    bindings.push(projectId);
  }
  if (environmentId !== null) {
    conditions.push("f.environment_id = ?");
    bindings.push(environmentId);
  }
  if (cursor) {
    conditions.push(
      "(f.interval_start > ? OR (f.interval_start = ? AND f.fact_id > ?))",
    );
    bindings.push(cursor.after.start, cursor.after.start, cursor.after.factId);
  }
  const limit = Number(limitText);
  const result = await db
    .prepare(
      `SELECT ${usageColumns} FROM usage_facts AS f JOIN usage_versions AS v ON v.fact_id = f.fact_id WHERE ${conditions.join(" AND ")} ORDER BY f.interval_start, f.fact_id LIMIT ?`,
    )
    .bind(...bindings, limit + 1)
    .all<UsageVersion>();
  const rows = result.results.slice(0, limit);
  const pageTotals: UnitVector = {};
  const pageTotalsByStatus: { provisional: UnitVector; final: UnitVector } = {
    provisional: {},
    final: {},
  };
  for (const row of rows)
    if (row.quantity !== null && row.status !== "gap") {
      pageTotals[row.metric] = (
        BigInt(pageTotals[row.metric] ?? "0") + BigInt(row.quantity)
      ).toString();
      pageTotalsByStatus[row.status][row.metric] = (
        BigInt(pageTotalsByStatus[row.status][row.metric] ?? "0") +
        BigInt(row.quantity)
      ).toString();
    }
  const last = rows.at(-1);
  const nextCursor =
    result.results.length > limit && last
      ? await encodeCursor(env, {
          version: 1,
          binding,
          watermark,
          after: { start: last.interval_start, factId: last.fact_id },
        })
      : null;
  const records = rows.map(publicFact);
  const metadata = {
    pageTotals,
    pageTotalsByStatus,
    nextCursor,
    snapshot: { watermark },
    window: filters,
    coverage: {
      status: "unknown",
      explicitGapRecords: rows.filter((row) => row.status === "gap").length,
      missingObservations: "unknown",
    },
    latestPageAcceptedAt: rows.reduce<string | null>(
      (latest, row) =>
        latest === null || row.accepted_at > latest ? row.accepted_at : latest,
      null,
    ),
    retention: "indefinite-development-ledger",
  };
  if (!ndjson) return json({ records, ...metadata });
  return new Response(
    [
      ...records.map((record) => JSON.stringify(record)),
      JSON.stringify({ type: "metadata", ...metadata }),
    ].join("\n") + "\n",
    {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function usageRoutes(
  request: Request,
  env: AccountingEnv,
  correctionPlanner?: CorrectionPlanner,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const db = env.DB.withSession("first-primary");
  const issued = /^\/v1\/regions\/([^/]+)\/usage-tokens\/reissue$/.exec(
    pathname,
  );
  if (request.method === "POST" && issued)
    return reissueMeter(request, env, db, issued[1]!);
  const fact = /^\/v1\/regions\/([^/]+)\/usage-facts$/.exec(pathname);
  if (request.method === "POST" && fact)
    return ingest(request, db, fact[1]!, correctionPlanner);
  const queried = /^\/v1\/organizations\/([^/]+)\/usage(\/export)?$/.exec(
    pathname,
  );
  if (request.method === "GET" && queried)
    return query(request, env, db, queried[1]!, Boolean(queried[2]));
  return null;
}
