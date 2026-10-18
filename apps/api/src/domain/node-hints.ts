// SPDX-License-Identifier: Apache-2.0
import { NODE_DESIRED_PAGE_LIMIT_MAX, NodeId } from "@pgcf/contracts";
import type { Env } from "../env.ts";

/** The NodeActor of a node: the link its agent holds, and the newest sample it sent. */
export function nodeActor(env: Pick<Env, "NODE_ACTOR">, nodeId: string) {
  NodeId.parse(nodeId);
  return env.NODE_ACTOR.get(env.NODE_ACTOR.idFromName(nodeId));
}

/**
 * Tells a node to pull its desired page, or with `ids` only those databases. A hint is best
 * effort: the page the node pulls holds the truth, and the node pulls it again by itself.
 */
export async function hintNode(
  env: Pick<Env, "NODE_ACTOR">,
  nodeId: string,
  ids?: readonly string[],
): Promise<number> {
  return nodeActor(env, nodeId).notify(
    ids === undefined || ids.length > NODE_DESIRED_PAGE_LIMIT_MAX
      ? undefined
      : [...ids],
  );
}

/** Hints the node of each database; a database no node serves has nobody to hint. */
export async function hintDatabases(
  env: Pick<Env, "DB" | "NODE_ACTOR">,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await env.DB.prepare(
    "SELECT id,node_id FROM databases WHERE id IN(SELECT value FROM json_each(?)) AND node_id IS NOT NULL",
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; node_id: string }>();
  const nodes = new Map<string, string[]>();
  for (const row of rows.results)
    nodes.set(row.node_id, [...(nodes.get(row.node_id) ?? []), row.id]);
  let delivered = 0;
  for (const [node, databases] of nodes)
    delivered += await hintNode(env, node, databases).catch(() => 0);
  return delivered;
}
