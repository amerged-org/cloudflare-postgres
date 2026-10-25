// SPDX-License-Identifier: Apache-2.0
import {
  NODE_ORDER_LIMIT,
  newOperationId,
  type NodeOrder,
  type NodeOrderResult,
} from "@pgcf/contracts";
import type { NodeMaintenance } from "@pgcf/contracts/nodes";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import { hintNode } from "./node-hints.ts";
import type { AdmissionSqlGuard } from "./admission-mutations.ts";

/**
 * The explicit orders that Cloudflare gives a node for moves, retired generations and maintenance
 * (ULTRA plan 7.11, 9.3, 9.5), as the node's desired page lists them behind its wakes and its
 * fence. An order is open until it ends. The node writes a retired generation to disk before it
 * acts, so an order that has ended leaves the page without lifting anything.
 */
interface OrderRow {
  operation: string;
  type: "move" | "superseded" | "maintenance";
  database_id: string | null;
  storage_generation: number | null;
  remove_volume: number;
}

/**
 * The open orders of a node, at most as many as one page may carry. A fenced node's page holds the
 * retired generations and nothing else.
 */
export async function openNodeOrders(
  db: D1Database,
  nodeId: string,
  fenced = false,
): Promise<NodeOrder[]> {
  const rows = await db
    .prepare(
      `SELECT operation,type,database_id,storage_generation,remove_volume FROM lifecycle_orders
      WHERE node_id=? AND closed_at IS NULL ${fenced ? "AND type='superseded'" : ""}
      ORDER BY CASE type WHEN 'move' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END,created_at,operation LIMIT ?`,
    )
    .bind(nodeId, NODE_ORDER_LIMIT)
    .all<OrderRow>();
  return rows.results.map((row): NodeOrder => {
    if (row.type === "maintenance")
      return { type: "maintenance", operation: row.operation };
    const base = {
      operation: row.operation,
      database: row.database_id!,
      storage_generation: row.storage_generation!,
    };
    return row.type === "move"
      ? { type: "move", ...base }
      : { type: "superseded", ...base, remove_volume: row.remove_volume === 1 };
  });
}

/**
 * Whether the node was declared lost: its key is then limited to the fenced scope, whether or not
 * the node is marked lost yet.
 */
export async function isNodeFenced(
  db: D1Database,
  nodeId: string,
): Promise<boolean> {
  return (
    (await db
      .prepare(
        `SELECT 1 fenced FROM nodes n WHERE n.id=? AND (n.lost_at IS NOT NULL
          OR EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id))`,
      )
      .bind(nodeId)
      .first()) !== null
  );
}

/**
 * Retires one storage generation of a database on a node: the node never starts or archives it
 * again, and removes the volume only with `removeVolume`. Inserts nothing when the same order
 * is already open. The caller chooses the statement's place in its batch.
 */
export function supersededStatement(
  db: D1Database,
  order: {
    nodeId: string;
    databaseId: string;
    storageGeneration: number;
    removeVolume: boolean;
    now: string;
  },
  guard: { sql: string; bindings: (string | number | null)[] } = {
    sql: "1=1",
    bindings: [],
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
      SELECT ?,?,'superseded',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM lifecycle_orders o WHERE o.node_id=? AND o.type='superseded'
        AND o.database_id=? AND o.storage_generation=? AND o.remove_volume>=? AND o.closed_at IS NULL) AND (${guard.sql})`,
    )
    .bind(
      newOperationId(),
      order.nodeId,
      order.databaseId,
      order.storageGeneration,
      Number(order.removeVolume),
      order.now,
      order.nodeId,
      order.databaseId,
      order.storageGeneration,
      Number(order.removeVolume),
      ...guard.bindings,
    );
}

interface MaintenanceRow {
  operation: string;
  node_id: string;
  result_status: "done" | "failed" | null;
  result_reason: string | null;
  placement_closed_at: string | null;
  created_at: string;
  closed_at: string | null;
}
const maintenanceSelect = `SELECT operation,node_id,result_status,result_reason,placement_closed_at,created_at,closed_at
  FROM lifecycle_orders WHERE type='maintenance' AND node_id=?`;
const maintenanceView = (row: MaintenanceRow): NodeMaintenance => ({
  operation: row.operation,
  node_id: row.node_id,
  status: row.result_status ?? "open",
  result_reason: row.result_reason,
  placement_closed_at: row.placement_closed_at,
  created_at: row.created_at,
  closed_at: row.closed_at,
});

/** One maintenance cycle of a node, whether it is open or has ended. */
export async function readNodeMaintenance(
  db: D1Database,
  nodeId: string,
  operation: string,
): Promise<NodeMaintenance | null> {
  const row = await db
    .prepare(`${maintenanceSelect} AND operation=?`)
    .bind(nodeId, operation)
    .first<MaintenanceRow>();
  return row === null ? null : maintenanceView(row);
}
async function openNodeMaintenance(
  db: D1Database,
  nodeId: string,
): Promise<NodeMaintenance | null> {
  const row = await db
    .prepare(`${maintenanceSelect} AND closed_at IS NULL`)
    .bind(nodeId)
    .first<MaintenanceRow>();
  return row === null ? null : maintenanceView(row);
}

/**
 * Starts the maintenance cycle of a node (ULTRA plan 9.3, steps 1 and 2): one batch closes the
 * node's placement, unless it is closed already, and gives the node its `maintenance` order, which
 * remembers the close time the cycle wrote so that only a cycle that closed placement reopens it
 * (`recordOrderResults`). A cycle that follows a failed one takes over the closure the failed one
 * left. The node is then hinted to pull its page. A cycle that is open is the answer to a repeat.
 * Refused with 409 for a node that is lost or fenced, and for one that does not run the release
 * of its region: the cycle installs that release's packages with the agent the node runs.
 * `complete` ends the caller's idempotency reservation for the operation that answers; its
 * statement joins the batch that writes the cycle.
 */
export async function startNodeMaintenance(
  env: Pick<Env, "DB" | "NODE_ACTOR">,
  request: { nodeId: string; nodeUid: string },
  complete: (operation: string) => D1PreparedStatement,
  now = Date.now(),
  authority: AdmissionSqlGuard = { sql: "1=1", bindings: [] },
): Promise<NodeMaintenance> {
  const { nodeId } = request;
  const node = await env.DB.prepare(
    `SELECT n.node_uid,n.lost_at,n.reported_release_id,f.release_id desired_release_id,
      EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id) fenced
    FROM nodes n LEFT JOIN fleet_region_releases f ON f.region_id=n.region_id WHERE n.id=?`,
  )
    .bind(nodeId)
    .first<{
      node_uid: string | null;
      lost_at: string | null;
      reported_release_id: string | null;
      desired_release_id: string | null;
      fenced: number;
    }>();
  if (!node) throw new ApiError("not_found", "Node not found");
  if (node.node_uid !== request.nodeUid)
    throw new ApiError(
      "conflict",
      "Maintenance requires the current physical node identity",
    );
  if (node.lost_at !== null || node.fenced === 1)
    throw new ApiError("conflict", "A lost or fenced node has no maintenance");
  const open = await openNodeMaintenance(env.DB, nodeId);
  if (open) {
    await complete(open.operation).run();
    return open;
  }
  if (
    node.desired_release_id === null ||
    node.reported_release_id !== node.desired_release_id
  )
    throw new ApiError(
      "conflict",
      "The node must run the release of its region first: its binaries converge before its packages change",
    );
  const operation = newOperationId(),
    at = new Date(now).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lifecycle_orders(operation,node_id,type,placement_closed_at,created_at)
      SELECT ?,n.id,'maintenance',
        CASE WHEN n.database_placement_closed_at IS NULL THEN ?
          WHEN EXISTS(SELECT 1 FROM lifecycle_orders p WHERE p.node_id=n.id AND p.type='maintenance' AND p.result_status='failed'
            AND p.placement_closed_at=n.database_placement_closed_at) THEN n.database_placement_closed_at END,?
      FROM nodes n JOIN fleet_region_releases f ON f.region_id=n.region_id
      WHERE n.id=? AND n.node_uid=? AND n.lost_at IS NULL AND n.reported_release_id=f.release_id
        AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id)
        AND NOT EXISTS(SELECT 1 FROM lifecycle_orders o WHERE o.node_id=n.id AND o.type='maintenance' AND o.closed_at IS NULL) AND (${authority.sql})`,
    ).bind(operation, at, at, nodeId, request.nodeUid, ...authority.bindings),
    env.DB.prepare(
      `UPDATE nodes SET database_placement_closed_at=(SELECT placement_closed_at FROM lifecycle_orders WHERE operation=?),updated_at=?
      WHERE id=? AND database_placement_closed_at IS NULL
        AND EXISTS(SELECT 1 FROM lifecycle_orders WHERE operation=? AND placement_closed_at IS NOT NULL)`,
    ).bind(operation, at, nodeId, operation),
    complete(operation),
  ]);
  if (results[0]!.meta.changes !== 1) {
    // The node changed since the checks above; another request may have started its cycle.
    const raced = await openNodeMaintenance(env.DB, nodeId);
    if (!raced)
      throw new ApiError("conflict", "Node changed; retry the request", {
        reason: "generation_changed",
      });
    await complete(raced.operation).run();
    return raced;
  }
  await hintNode(env, nodeId).catch(() => 0);
  return (await readNodeMaintenance(env.DB, nodeId, operation))!;
}

/**
 * Records how the node says its orders ended and returns how many it took, and whether one of them
 * ended a maintenance order: the node holds its wakes until it pulls a whole page without that
 * order, so the caller hints it. The first result of an order stands, except that a retired
 * generation is retried until it reports `done`, which ends its order, as a maintenance cycle ends
 * with its result; a fence has no row. A maintenance cycle that is done reopens the placement it
 * closed, in the batch that ends it, if the node's close time is still the one the cycle wrote; a
 * failed cycle leaves placement closed. The orders of a move are settled by the move itself
 * (`database-moves.ts`), which reads the same results.
 */
export async function recordOrderResults(
  db: D1Database,
  nodeId: string,
  results: readonly NodeOrderResult[],
  now: string,
): Promise<{ taken: number; maintenanceEnded: boolean }> {
  let taken = 0,
    maintenanceEnded = false;
  for (let i = 0; i < results.length; i += 50) {
    const chunk = results.slice(i, i + 50);
    const outcomes = await db.batch<{ type: string }>(
      chunk.flatMap((result) => [
        db
          .prepare(
            `UPDATE lifecycle_orders SET result_status=?,result_reason=?,
            closed_at=CASE WHEN (type='superseded' AND ?='done') OR type='maintenance' THEN ? ELSE closed_at END
            WHERE operation=? AND node_id=? AND closed_at IS NULL AND (result_status IS NULL OR type='superseded')
            RETURNING type`,
          )
          .bind(
            result.status,
            result.reason ?? null,
            result.status,
            now,
            result.operation,
            nodeId,
          ),
        ...(result.status === "done"
          ? [
              db
                .prepare(
                  `UPDATE nodes SET database_placement_closed_at=NULL,updated_at=?
                  WHERE id=? AND database_placement_closed_at=(SELECT placement_closed_at FROM lifecycle_orders
                    WHERE operation=? AND node_id=? AND type='maintenance' AND result_status='done' AND closed_at=?)`,
                )
                .bind(now, nodeId, result.operation, nodeId, now),
            ]
          : []),
      ]),
    );
    // The statement that ends an order is the first of its result's one or two.
    let at = 0;
    for (const result of chunk) {
      const updated = outcomes[at]!.results;
      taken += updated.length;
      maintenanceEnded ||= updated.some(
        (order) => order.type === "maintenance",
      );
      at += result.status === "done" ? 2 : 1;
    }
  }
  return { taken, maintenanceEnded };
}
