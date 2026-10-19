// SPDX-License-Identifier: Apache-2.0
import {
  NODE_PROBE_EXPIRY_SECONDS,
  NODE_PROBE_REQUESTS_MAX,
  NodeBootReport,
  NodeDiagnostic,
  NodeDiagnosticRequest,
  NodeDiagnosticSummary,
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
 * when its boot ID changed. The report is stored whole, once for a boot: the agent sends it again
 * when the answer was lost, and that send is answered with the stored report's id and verdict. An
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
  await c.env.DB.prepare(
    `INSERT INTO node_diagnostics(id,node_id,kind,boot_id,previous_boot_id,received_at,expected_reboot,body)
     VALUES(?,?,'boot',?,?,?,?,?) ON CONFLICT(node_id,boot_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      node.id,
      report.boot_id,
      report.previous_boot_id,
      new Date().toISOString(),
      expected === null ? null : expected ? 1 : 0,
      JSON.stringify(report),
    )
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
 * The answer to one request of the node: kept whole, once. A request that is unknown, or is
 * another node's, is not found; an answer for another probe than the one asked is refused. An
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
    "SELECT probe FROM node_diagnostic_requests WHERE id=? AND node_id=?",
  )
    .bind(result.diagnostic_id, node.id)
    .first<{ probe: string }>();
  if (request === null)
    throw new ApiError("not_found", "Diagnostic request not found");
  if (request.probe !== result.probe)
    throw new ApiError("invalid_request", "The result answers another probe");
  await c.env.DB.prepare(
    "UPDATE node_diagnostic_requests SET received_at=?,body=? WHERE id=? AND node_id=? AND received_at IS NULL",
  )
    .bind(
      new Date().toISOString(),
      JSON.stringify(result),
      result.diagnostic_id,
      node.id,
    )
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

/** Deletes the reports older than 30 days. The minute cron calls it. */
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
 * Only an administrator reads a node's reports and asks it for probes; anyone else is told the
 * node is not there, as an integrator is for every resource that is not its own.
 */
async function administeredNode(
  c: ApiContext,
  nodeId: string,
): Promise<AuthPrincipal> {
  const auth = await getAuth(c);
  const found =
    auth.scope === "admin"
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
