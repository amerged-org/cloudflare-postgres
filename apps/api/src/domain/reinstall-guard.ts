// SPDX-License-Identifier: Apache-2.0
import { NodeStateError } from "./node-state.ts";

/**
 * The reinstall guard (ULTRA plan 7.11, 9.4). A reinstall overwrites the disk, and with it any WAL
 * that never reached R2. The API therefore refuses to reinstall a lost node's instance, or to run
 * AddNode in recover mode on it, while a database of that node has no proven-sleep record for its
 * current storage generation: the node reported it asleep with that record, and nothing later
 * took it back. Only the owner's explicit acknowledgement lifts the refusal. A fence that is
 * declared but not yet complete refuses too: the old stack may still be running.
 */
const SHOWN = 20;

export async function reinstallBlockers(
  db: D1Database,
  nodeId: string,
  limit = SHOWN + 1,
): Promise<{ id: string; storage_generation: number }[]> {
  return (
    await db
      .prepare(
        `SELECT d.id,d.storage_generation FROM databases d WHERE d.node_id=? AND d.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM database_recovery_points p WHERE p.database_id=d.id AND p.node_id=d.node_id
          AND p.storage_generation=d.storage_generation AND p.state='asleep')
        ORDER BY d.id LIMIT ?`,
      )
      .bind(nodeId, limit)
      .all<{ id: string; storage_generation: number }>()
  ).results;
}

export async function reinstallOverridden(
  db: D1Database,
  nodeId: string,
): Promise<boolean> {
  return (
    (await db
      .prepare(
        "SELECT 1 overridden FROM node_reinstall_overrides WHERE node_id=?",
      )
      .bind(nodeId)
      .first()) !== null
  );
}

/** Throws a conflict that names the databases at risk, unless the node may be reinstalled. */
export async function assertReinstallAllowed(
  db: D1Database,
  nodeId: string,
): Promise<void> {
  const fence = await db
    .prepare("SELECT powered_off_at FROM node_losses WHERE node_id=?")
    .bind(nodeId)
    .first<{ powered_off_at: string | null }>();
  if (fence && fence.powered_off_at === null)
    throw new NodeStateError(
      "conflict",
      "The lost node is not fenced yet: its Tunnel is not deleted or its instance is not confirmed stopped",
    );
  const blockers = await reinstallBlockers(db, nodeId);
  if (blockers.length === 0 || (await reinstallOverridden(db, nodeId))) return;
  const shown = blockers.slice(0, SHOWN).map((blocker) => blocker.id);
  throw new NodeStateError(
    "conflict",
    `Reinstalling would overwrite WAL that never reached R2: ${blockers.length > SHOWN ? `more than ${SHOWN}` : blockers.length} database(s) of this node have no proven-sleep record (${shown.join(", ")}${blockers.length > SHOWN ? ", ..." : ""}). The owner can acknowledge the loss with POST /v1/nodes/${nodeId}/reinstall-override`,
  );
}

/**
 * Records the owner's acknowledgement for a node that was declared lost, and returns the first one
 * on record: a repeat answers the same.
 */
export async function acknowledgeReinstallOverride(
  db: D1Database,
  nodeId: string,
  keyId: string,
  reason: string,
  now: number,
): Promise<{
  node_id: string;
  overridden: true;
  reason: string;
  acknowledged_at: string;
}> {
  const lost = await db
    .prepare("SELECT lost_at FROM nodes WHERE id=?")
    .bind(nodeId)
    .first<{ lost_at: string | null }>();
  if (!lost) throw new NodeStateError("not_found", "Node not found");
  if (lost.lost_at === null)
    throw new NodeStateError(
      "conflict",
      "Only a node that was declared lost can be reinstalled",
    );
  await db
    .prepare(
      "INSERT OR IGNORE INTO node_reinstall_overrides(node_id,key_id,reason,acknowledged_at) VALUES(?,?,?,?)",
    )
    .bind(nodeId, keyId, reason, new Date(now).toISOString())
    .run();
  const stored = (await db
    .prepare(
      "SELECT reason,acknowledged_at FROM node_reinstall_overrides WHERE node_id=?",
    )
    .bind(nodeId)
    .first<{ reason: string; acknowledged_at: string }>())!;
  return { node_id: nodeId, overridden: true, ...stored };
}
