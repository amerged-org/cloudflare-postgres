// SPDX-License-Identifier: Apache-2.0
import {
  NODE_ORDER_LIMIT,
  newOperationId,
  type NodeOrder,
  type NodeOrderResult,
} from "@pgcf/contracts";

/**
 * The orders that Cloudflare gives a node for moves and node loss (ULTRA plan 7.11, 9.4, 9.5), as
 * the node's desired page lists them. `move` and `superseded` are open until they end; a `fence`
 * stays on the page of its node for good. The node persists a fence and a superseded generation
 * before it acts, so an order that has ended leaves the page without lifting anything.
 */
interface OrderRow {
  operation: string;
  type: "move" | "superseded" | "fence";
  database_id: string | null;
  storage_generation: number | null;
  remove_volume: number;
}

/** The open orders of a node, the fence first; at most as many as one page may carry. */
export async function openNodeOrders(
  db: D1Database,
  nodeId: string,
): Promise<NodeOrder[]> {
  const rows = await db
    .prepare(
      `SELECT operation,type,database_id,storage_generation,remove_volume FROM lifecycle_orders
      WHERE node_id=? AND (closed_at IS NULL OR type='fence')
      ORDER BY CASE type WHEN 'fence' THEN 0 WHEN 'move' THEN 1 ELSE 2 END,created_at,operation LIMIT ?`,
    )
    .bind(nodeId, NODE_ORDER_LIMIT)
    .all<OrderRow>();
  return rows.results.map((row): NodeOrder => {
    if (row.type === "fence")
      return { type: "fence", operation: row.operation };
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

/** Whether the node was declared lost: its key is then limited to the fenced scope. */
export async function isNodeFenced(
  db: D1Database,
  nodeId: string,
): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 fenced FROM node_losses WHERE node_id=?")
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

/**
 * Records how the node says its orders ended. A retired generation's order ends with `done`; a
 * fence never ends, and its result is only kept for the operator. The orders of a move are
 * settled by the move itself (`database-moves.ts`), which reads the same results.
 */
export async function recordOrderResults(
  db: D1Database,
  nodeId: string,
  results: readonly NodeOrderResult[],
  now: string,
): Promise<void> {
  for (let i = 0; i < results.length; i += 50)
    await db.batch(
      results.slice(i, i + 50).map((result) =>
        db
          .prepare(
            `UPDATE lifecycle_orders SET result_status=?,result_reason=?,
            closed_at=CASE WHEN type='superseded' AND ?='done' THEN ? ELSE closed_at END
            WHERE operation=? AND node_id=? AND closed_at IS NULL`,
          )
          .bind(
            result.status,
            result.reason ?? null,
            result.status,
            now,
            result.operation,
            nodeId,
          ),
      ),
    );
}
