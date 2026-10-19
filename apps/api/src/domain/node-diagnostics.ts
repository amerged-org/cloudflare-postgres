// SPDX-License-Identifier: Apache-2.0
import {
  NodeBootReport,
  NodeDiagnostic,
  NodeDiagnosticSummary,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { page } from "../platform/pagination.ts";
import type { NodeCaller } from "./node-auth.ts";

const DAY_MS = 86_400_000;
/** A report is kept this long. */
export const NODE_DIAGNOSTICS_RETENTION_MS = 30 * DAY_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NodeRow {
  last_observed_at: string | null;
  os_boot_id: string | null;
  os_previous_observed_at: string | null;
}

/**
 * Whether a maintenance order of the node was open when its last sample of the previous boot
 * arrived, or closed after it: an order the node's own reboot belongs to. Until this boot's hello
 * is stored, the node's newest sample is that sample. The hello keeps it when it stores the new
 * boot (`os_previous_observed_at`), because from then on the newest sample can be this boot's. An
 * order made after it, while the node was down, is not the reason for the reboot, and a node that
 * never sampled has no order.
 */
async function rebootWasAsked(
  db: D1Database,
  nodeId: string,
  bootId: string,
): Promise<boolean> {
  const node = await db
    .prepare(
      "SELECT last_observed_at,os_boot_id,os_previous_observed_at FROM nodes WHERE id=?",
    )
    .bind(nodeId)
    .first<NodeRow>();
  const at =
    node?.os_boot_id === bootId
      ? node.os_previous_observed_at
      : (node?.last_observed_at ?? null);
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
 * reads; a report of an agent that knew no earlier boot claims no reboot at all.
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
 * Only an administrator reads a node's reports; anyone else is told the node is not there, as an
 * integrator is for every resource that is not its own.
 */
async function administeredNode(c: ApiContext, nodeId: string): Promise<void> {
  const auth = await getAuth(c);
  const found =
    auth.scope === "admin"
      ? await c.env.DB.prepare("SELECT 1 found FROM nodes WHERE id=?")
          .bind(nodeId)
          .first()
      : null;
  if (found === null) throw new ApiError("not_found", "Node not found");
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

/** `GET /v1/nodes/{id}/diagnostics/{diagnostic_id}`: one report with its journal. */
export async function getNodeDiagnostic(
  c: ApiContext,
  nodeId: string,
  diagnosticId: string,
): Promise<Response> {
  await administeredNode(c, nodeId);
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
