// SPDX-License-Identifier: Apache-2.0
import { NodePolicy, RegionId } from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { hintNode } from "./node-hints.ts";

/**
 * The rules a region's nodes decide by when they act alone (plan 4.3-4.7, 7.5): admission, early
 * sleep, the storage reserve, backup concurrency and write limits. They are operator
 * configuration and stay on every node's desired page.
 */
export async function getNodePolicy(
  c: ApiContext,
  regionId: string,
): Promise<Response> {
  await requireScope(c, "admin");
  const row = await c.env.DB.prepare(
    "SELECT node_policy_json FROM node_region_policies WHERE region_id=?",
  )
    .bind(RegionId.parse(regionId))
    .first<{ node_policy_json: string | null }>();
  if (!row?.node_policy_json)
    throw new ApiError("not_found", "The region has no node policy");
  return c.json(NodePolicy.parse(JSON.parse(row.node_policy_json)));
}

export async function setNodePolicy(
  c: ApiContext,
  regionId: string,
  policy: NodePolicy,
): Promise<Response> {
  await requireScope(c, "admin");
  const region = RegionId.parse(regionId);
  const result = await c.env.DB.prepare(
    `INSERT INTO node_region_policies(region_id,node_policy_json) SELECT id,? FROM regions WHERE id=?
     ON CONFLICT(region_id) DO UPDATE SET node_policy_json=excluded.node_policy_json`,
  )
    .bind(JSON.stringify(policy), region)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError("not_found", "Region not found");
  // The nodes of the region pull the page that carries the policy.
  const nodes = await c.env.DB.prepare(
    "SELECT id FROM nodes WHERE region_id=? AND lost_at IS NULL AND public_key IS NOT NULL",
  )
    .bind(region)
    .all<{ id: string }>();
  c.executionCtx.waitUntil(
    Promise.all(
      nodes.results.map((node) => hintNode(c.env, node.id).catch(() => 0)),
    ),
  );
  return c.json(policy);
}
