// SPDX-License-Identifier: Apache-2.0
import {
  isAdminScope,
  NODE_DIAGNOSTIC_ROW_MAX_BYTES,
  NODE_PROBE_EXPIRY_SECONDS,
  NODE_PROBE_REQUESTS_MAX,
  NodeBootReport,
  NodeDiagnostic,
  NodeDiagnosticRequest,
  NodeDiagnosticSummary,
  NodeJournalEntry,
  NodeProbeDiagnostic,
  NodeProbeRequest,
  NodeProbeResult,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext, AuthPrincipal } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";
import { hintNode } from "./node-hints.ts";
import type { NodeCaller } from "./node-auth.ts";

const DAY_MS = 86_400_000;
/** A report, and a probe with its result, is kept this long. */
export const NODE_DIAGNOSTICS_RETENTION_MS = 30 * DAY_MS;
const PROBE_EXPIRY_MS = NODE_PROBE_EXPIRY_SECONDS * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Column = string | number | null;
const encoder = new TextEncoder();

/** The bytes `text` takes between the quotes of a string in a dump: UTF-8, with `'` written twice. */
function literalBytes(text: string): number {
  let quotes = 0;
  for (let at = text.indexOf("'"); at !== -1; at = text.indexOf("'", at + 1))
    quotes++;
  return encoder.encode(text).byteLength + quotes;
}

/**
 * The bytes of `INSERT INTO "table" VALUES(...);`, the statement that a dump of the control
 * database (D1's export) writes for a row whose columns are `columns`, in the table's order.
 */
function insertBytes(table: string, columns: Column[]): number {
  let bytes = `INSERT INTO "${table}" VALUES(`.length + columns.length - 1 + 2;
  for (const column of columns)
    bytes +=
      column === null
        ? 4
        : typeof column === "number"
          ? String(column).length
          : 2 + literalBytes(column);
  return bytes;
}

/**
 * The JSON to store as the `body` of a row whose other columns are `others`, so that the row's
 * `INSERT` statement in a dump is at most `NODE_DIAGNOSTIC_ROW_MAX_BYTES` (D1 refuses an import of
 * a statement above 100,000 bytes, and a row that exceeds it makes every backup of the database
 * impossible to restore). The node's answer is stored whole when it fits. When it does not, the
 * oldest entries go until the newest that fit remain, and the body says so: `truncated` is true
 * and `dropped_entries` counts them. An answer whose text alone is too long keeps the beginning
 * of the text, cut on a character, with `dropped_entries` 0. The answer is never refused for its
 * size: the node ran the probe, and would send it again.
 */
function bodyWithin(
  table: string,
  others: Column[],
  value: { entries: NodeJournalEntry[]; text?: string },
): string {
  const room =
    NODE_DIAGNOSTIC_ROW_MAX_BYTES - insertBytes(table, [...others, ""]);
  const whole = JSON.stringify(value);
  if (literalBytes(whole) <= room) return whole;
  const count = value.entries.length;
  const marked = (entries: NodeJournalEntry[], text = value.text) =>
    JSON.stringify({
      ...value,
      entries,
      ...(text === undefined ? {} : { text }),
      truncated: true,
      dropped_entries: count - entries.length,
    });
  // The mark counts every entry as dropped, which has at least as many digits as the true count.
  const base = literalBytes(marked([]));
  if (base <= room) {
    let size = base,
      kept = 0;
    for (let at = count - 1; at >= 0; at--) {
      const next =
        size + literalBytes(JSON.stringify(value.entries[at])) + (kept ? 1 : 0);
      if (next > room) break;
      size = next;
      kept++;
    }
    return marked(value.entries.slice(count - kept));
  }
  // Even without an entry the text is too long. A half of a surrogate pair is not a character.
  const text = value.text ?? "";
  const beginning = (end: number) => {
    const cut = text.slice(0, end);
    return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
  };
  let low = 0,
    high = text.length;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (literalBytes(marked([], beginning(middle))) <= room) low = middle;
    else high = middle;
  }
  return marked([], beginning(low));
}

interface NodeRow {
  os_boot_id: string | null;
  os_previous_observed_at: string | null;
}

/**
 * Whether a maintenance order of the node was open when its last sample of the previous boot
 * arrived, or closed after it: an order the node's own reboot belongs to. The hello of the new boot
 * stores that sample (`os_previous_observed_at`): the newest sample the node's actor holds, which
 * D1 may not have yet. A report whose boot has no hello stored yet is refused for the agent to
 * send again: D1's `last_observed_at` can be a minute older than that sample, and a verdict from
 * it can say that no order was open when one was. An order made after the sample, while the node
 * was down, is not the reason for the reboot, and a node that never sampled has no order.
 */
async function rebootWasAsked(
  db: D1Database,
  nodeId: string,
  bootId: string,
): Promise<boolean> {
  const node = await db
    .prepare("SELECT os_boot_id,os_previous_observed_at FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<NodeRow>();
  if (node?.os_boot_id !== bootId)
    throw new ApiError(
      "capacity_exhausted",
      "The hello of this boot is not stored yet; send the report again",
      { reason: "not_ready" },
    );
  const at = node.os_previous_observed_at;
  if (at === null) return false;
  const open = await db
    .prepare(
      `SELECT 1 found FROM lifecycle_orders WHERE node_id=? AND type='maintenance' AND created_at<=?
       AND (closed_at IS NULL OR closed_at>?) LIMIT 1`,
    )
    .bind(nodeId, at, at)
    .first();
  return open !== null;
}

/**
 * `POST /node/v1/diagnostics`: the journal tail of the boot before this one, sent by the agent
 * when its boot ID changed. The report is stored once for a boot, whole or, when its row would
 * be above `NODE_DIAGNOSTIC_ROW_MAX_BYTES` in a backup, as its newest lines that fit
 * (`bodyWithin`): the agent sends it again when the answer was lost, and that send is answered
 * with the stored report's id and verdict. An
 * unexpected reboot (no maintenance order asked for it) is what the `node_unexpected_reboot` alert
 * reads; a report of an agent that knew no earlier boot claims no reboot at all. A report that
 * reaches the API before the hello of its boot is stored (the agent does not order the two) is
 * refused as not ready, and the agent sends it again.
 */
export async function nodeBootReport(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeBootReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid boot report");
  const report = parsed.data;
  const expected =
    report.previous_boot_id === null
      ? null
      : await rebootWasAsked(c.env.DB, node.id, report.boot_id);
  const columns: Column[] = [
    crypto.randomUUID(),
    node.id,
    "boot",
    report.boot_id,
    report.previous_boot_id,
    new Date().toISOString(),
    expected === null ? null : expected ? 1 : 0,
  ];
  await c.env.DB.prepare(
    `INSERT INTO node_diagnostics(id,node_id,kind,boot_id,previous_boot_id,received_at,expected_reboot,body)
     VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(node_id,boot_id) DO NOTHING`,
  )
    .bind(...columns, bodyWithin("node_diagnostics", columns, report))
    .run();
  const stored = await c.env.DB.prepare(
    "SELECT id,expected_reboot FROM node_diagnostics WHERE node_id=? AND boot_id=?",
  )
    .bind(node.id, report.boot_id)
    .first<{ id: string; expected_reboot: number | null }>();
  return c.json({
    id: stored!.id,
    expected_reboot:
      stored!.expected_reboot === null ? null : stored!.expected_reboot === 1,
  });
}

/**
 * `POST /node/v1/diagnostics` carries what the agent has to say of the node: the previous boot's
 * journal after a reboot, or, with `kind` "probe", the answer to a request of an administrator.
 */
export async function nodeDiagnosticUpload(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const probe =
    typeof raw === "object" &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === "probe";
  return probe ? nodeProbeResult(c, node, raw) : nodeBootReport(c, node, raw);
}

/**
 * The answer to one request of the node: kept once, whole or, when its row would be above
 * `NODE_DIAGNOSTIC_ROW_MAX_BYTES` in a backup, cut and marked (`bodyWithin`). A request that is
 * unknown, or is another node's, is not found; an answer for another probe than the one asked is refused. An
 * answer that comes after the request expired is kept too: the node ran the probe, and the page no
 * longer lists the request, so nothing runs twice for it. A second answer is acknowledged and
 * changes nothing.
 */
async function nodeProbeResult(
  c: ApiContext,
  node: NodeCaller,
  raw: unknown,
): Promise<Response> {
  const parsed = NodeProbeResult.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid probe result");
  const result = parsed.data;
  const request = await c.env.DB.prepare(
    `SELECT id,node_id,probe,boot,since_seconds,lines,requested_by_key_id,requested_at
     FROM node_diagnostic_requests WHERE id=? AND node_id=?`,
  )
    .bind(result.diagnostic_id, node.id)
    .first<Omit<ProbeRow, "received_at" | "body">>();
  if (request === null)
    throw new ApiError("not_found", "Diagnostic request not found");
  if (request.probe !== result.probe)
    throw new ApiError("invalid_request", "The result answers another probe");
  const receivedAt = new Date().toISOString();
  const body = bodyWithin(
    "node_diagnostic_requests",
    [
      request.id,
      request.node_id,
      request.probe,
      request.boot,
      request.since_seconds,
      request.lines,
      request.requested_by_key_id,
      request.requested_at,
      receivedAt,
    ],
    result,
  );
  await c.env.DB.prepare(
    "UPDATE node_diagnostic_requests SET received_at=?,body=? WHERE id=? AND node_id=? AND received_at IS NULL",
  )
    .bind(receivedAt, body, result.diagnostic_id, node.id)
    .run();
  return c.json({ id: result.diagnostic_id });
}

/**
 * The requests a node has not answered and that have not expired, the oldest first, at most
 * `NODE_PROBE_REQUESTS_MAX`: what its desired page lists.
 */
export async function openDiagnosticRequests(
  db: D1Database,
  nodeId: string,
  now: number,
): Promise<NodeDiagnosticRequest[]> {
  const rows = await db
    .prepare(
      `SELECT id,probe,boot,since_seconds,lines FROM node_diagnostic_requests
       WHERE node_id=? AND received_at IS NULL AND requested_at>? ORDER BY requested_at,id LIMIT ?`,
    )
    .bind(
      nodeId,
      new Date(now - PROBE_EXPIRY_MS).toISOString(),
      NODE_PROBE_REQUESTS_MAX,
    )
    .all();
  return rows.results.map((row) => NodeDiagnosticRequest.parse(row));
}

/** Deletes the reports older than 30 days. The health phase of the CronWatchdog alarm's alert evaluation calls it. */
export async function purgeNodeDiagnostics(
  db: D1Database,
  now = Date.now(),
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM node_diagnostics WHERE received_at<?")
    .bind(new Date(now - NODE_DIAGNOSTICS_RETENTION_MS).toISOString())
    .run();
  return result.meta.changes;
}

interface DiagnosticRow {
  id: string;
  node_id: string;
  kind: "boot";
  boot_id: string;
  previous_boot_id: string | null;
  received_at: string;
  expected_reboot: number | null;
}
const columns = "id,node_id,kind,boot_id,previous_boot_id,received_at";
const summary = (row: DiagnosticRow): NodeDiagnosticSummary =>
  NodeDiagnosticSummary.parse({
    id: row.id,
    node_id: row.node_id,
    kind: row.kind,
    boot_id: row.boot_id,
    previous_boot_id: row.previous_boot_id,
    received_at: row.received_at,
    expected_reboot:
      row.expected_reboot === null ? null : row.expected_reboot === 1,
  });

/**
 * Only an administrator reads a node's reports and asks it for probes; anyone else is told the node
 * is not there, as an integrator is for every resource that is not its own. A read-only `admin_read`
 * key never gets past `getAuth` on the POST that asks, so no scope is told apart here.
 */
async function administeredNode(
  c: ApiContext,
  nodeId: string,
): Promise<AuthPrincipal> {
  const auth = await getAuth(c);
  const found = isAdminScope(auth.scope)
    ? await c.env.DB.prepare("SELECT 1 found FROM nodes WHERE id=?")
        .bind(nodeId)
        .first()
    : null;
  if (found === null) throw new ApiError("not_found", "Node not found");
  return auth;
}

/**
 * `POST /v1/nodes/{id}/diagnostics`: asks the node to run one probe (SEC-09). The request is kept
 * with the key that made it, and the node is told to pull its page, which lists the request until
 * the node answers it or ten minutes pass. The answer is read with `getNodeDiagnostic`. A request
 * and its answer are kept 30 days.
 */
export async function requestNodeProbe(
  c: ApiContext,
  nodeId: string,
): Promise<Response> {
  const auth = await administeredNode(c, nodeId);
  const request = NodeProbeRequest.parse(await c.req.json());
  const id = crypto.randomUUID(),
    now = Date.now();
  // The minute cron's statements are all spoken for, so the requests older than 30 days go with
  // the next request, of any node.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM node_diagnostic_requests WHERE requested_at<?",
    ).bind(new Date(now - NODE_DIAGNOSTICS_RETENTION_MS).toISOString()),
    c.env.DB.prepare(
      `INSERT INTO node_diagnostic_requests(id,node_id,probe,boot,since_seconds,lines,requested_by_key_id,requested_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      nodeId,
      request.probe,
      request.boot,
      request.since_seconds,
      request.lines,
      auth.id,
      new Date(now).toISOString(),
    ),
  ]);
  // A hint is best effort: the node pulls its page again by itself.
  await hintNode(c.env, nodeId).catch(() => 0);
  return c.json({ diagnostic_id: id }, 202);
}

/** `GET /v1/nodes/{id}/diagnostics`: the node's reports, newest first, without their journal. */
export async function listNodeDiagnostics(
  c: ApiContext,
  nodeId: string,
): Promise<Response> {
  await administeredNode(c, nodeId);
  const pagination = page(c, c.req.query(), (id) => UUID.test(id)),
    cursor = pagination.where("received_at", "id");
  const rows = await c.env.DB.prepare(
    `SELECT ${columns},received_at created_at,expected_reboot FROM node_diagnostics
     WHERE node_id=? AND ${cursor.sql} ORDER BY received_at DESC,id DESC LIMIT ?`,
  )
    .bind(nodeId, ...cursor.bindings, pagination.limit + 1)
    .all<DiagnosticRow & { created_at: string }>();
  const { data, next_cursor } = pagination.envelope(rows.results);
  return c.json({ data: data.map(summary), next_cursor });
}

interface ProbeRow {
  id: string;
  node_id: string;
  probe: string;
  boot: number;
  since_seconds: number;
  lines: number;
  requested_by_key_id: string;
  requested_at: string;
  received_at: string | null;
  body: string | null;
}

/** A request as the API says it: waiting, answered, or unanswered for ten minutes. */
function probeDiagnostic(row: ProbeRow, now: number): NodeProbeDiagnostic {
  const status =
    row.received_at !== null
      ? "received"
      : now - Date.parse(row.requested_at) >= PROBE_EXPIRY_MS
        ? "expired"
        : "requested";
  return NodeProbeDiagnostic.parse({
    id: row.id,
    node_id: row.node_id,
    kind: "probe",
    probe: row.probe,
    boot: row.boot,
    since_seconds: row.since_seconds,
    lines: row.lines,
    requested_by: row.requested_by_key_id,
    requested_at: row.requested_at,
    status,
    received_at: row.received_at,
    body: row.body === null ? null : JSON.parse(row.body),
  });
}

/**
 * `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}`: a probe with its status and result, or a boot
 * report with its journal. The two have their own identifiers.
 */
export async function getNodeDiagnostic(
  c: ApiContext,
  nodeId: string,
  diagnosticId: string,
): Promise<Response> {
  await administeredNode(c, nodeId);
  const probe = await c.env.DB.prepare(
    `SELECT id,node_id,probe,boot,since_seconds,lines,requested_by_key_id,requested_at,received_at,body
     FROM node_diagnostic_requests WHERE node_id=? AND id=?`,
  )
    .bind(nodeId, diagnosticId)
    .first<ProbeRow>();
  if (probe !== null) return c.json(probeDiagnostic(probe, Date.now()));
  const row = await c.env.DB.prepare(
    `SELECT ${columns},expected_reboot,body FROM node_diagnostics WHERE node_id=? AND id=?`,
  )
    .bind(nodeId, diagnosticId)
    .first<DiagnosticRow & { body: string }>();
  if (row === null) throw new ApiError("not_found", "Diagnostic not found");
  return c.json(
    NodeDiagnostic.parse({
      ...summary(row),
      report: JSON.parse(row.body),
    }),
  );
}
