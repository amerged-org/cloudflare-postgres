// SPDX-License-Identifier: Apache-2.0
//
// When a region is full for the smallest class it sells (ULTRA plan 4.3, 4.8, 4.10): the pool-closed
// alarm and the capacity cron judge the same class by the same rules as placement. A module of its
// own because it reads the resource bounds, which a ticket claim's few modules (placement.ts is
// among them) must not evaluate (`scripts/ci/actor-admission-imports.test.ts`).
import { ApiError } from "../api-error.ts";
import {
  choosePlacement,
  nodeOnline,
  nodeOpen,
  placementNodes,
  poolState,
  type PlacementNeed,
} from "./placement.ts";
import {
  assertResourcesAllowed,
  effectiveResources,
  NO_OVERRIDES,
  regionBounds,
} from "./resources.ts";
import type { SizeRow } from "./rows.ts";

/**
 * The smallest class a region can sell: the enabled class with the least memory, then CPU, then
 * storage. It is the class the capacity cron buys capacity for when no database waits, and the one
 * the pool-closed alarm judges, so that both call a region full at the same moment.
 */
export async function smallestOfferedClass(
  db: D1Database,
): Promise<SizeRow | null> {
  return db
    .prepare(
      "SELECT * FROM size_classes WHERE enabled=1 ORDER BY memory_mib,cpu_millicores,storage_gib,id LIMIT 1",
    )
    .first<SizeRow>();
}

/**
 * What the smallest class on offer asks of a node in this region, or null when there is none or
 * the region's bounds refuse it (the capacity cron calls that `size_policy_unavailable`).
 */
export async function smallestOfferedNeed(
  db: D1Database,
  regionId: string,
): Promise<PlacementNeed | null> {
  const size = await smallestOfferedClass(db);
  if (!size) return null;
  const need = effectiveResources(size, NO_OVERRIDES);
  try {
    assertResourcesAllowed(
      need,
      NO_OVERRIDES,
      await regionBounds(db, regionId),
    );
  } catch (error) {
    if (error instanceof ApiError) return null;
    throw error;
  }
  return need;
}

/**
 * The nodes of a region, not lost, that cannot take the smallest class on offer (plan 4.3, 4.8):
 * the thin pool's data or metadata is too full, the storage sold plus that class would pass the
 * logical cap, or the node holds `MAX_VOLUMES_PER_NODE` volumes; and, when no node that reports,
 * is open for new databases and has a pool with room can take that class for want of RAM or CPU
 * (the 80 % of plan 4.8, by the measured load: the databases placed since the node's newest
 * sample are not counted), every such node. The region is closed when this list is not empty, and
 * open again once the class fits. A pool without room or without a reading, a node that went
 * quiet, one that is closed by its flags or by a maintenance cycle and one whose load is not known
 * yet are other alarms', or unknown: they are never counted as closed here.
 */
export async function closedPools(
  db: D1Database,
  regionId: string,
  now = Date.now(),
): Promise<string[]> {
  const need = await smallestOfferedNeed(db, regionId),
    nodes = (await placementNodes(db, regionId, now)).filter(
      (node) => node.lost_at === null,
    ),
    storageGib = need?.storage_gib ?? 0;
  const closed = new Set(
    nodes
      .filter((node) =>
        ["data", "metadata", "cap", "volumes"].includes(
          poolState(node, storageGib),
        ),
      )
      .map((node) => node.id),
  );
  if (need !== null) {
    // The nodes whose refusal is a matter of load: placement could take the class there, were
    // the RAM and the CPU free.
    const candidates = nodes.filter(
      (node) =>
        nodeOnline(node, now) &&
        nodeOpen(node) &&
        !["unavailable", "no_room"].includes(poolState(node, storageGib)) &&
        node.ram_peak_ppm !== null &&
        node.cpu_peak_ppm !== null &&
        node.memory_total_bytes !== null &&
        node.cpu_cores !== null,
    );
    // What the load figures say, not the databases placed since the node's newest sample: a burst of
    // creates counts at its full memory until the next sample, a state of seconds that placement
    // honours and an alarm must not announce.
    const measured = candidates.map((node) => ({
      ...node,
      pending_memory_mib: 0,
    }));
    if (candidates.length && choosePlacement(measured, need, now) === null)
      for (const node of candidates) closed.add(node.id);
  }
  return [...closed].sort();
}
