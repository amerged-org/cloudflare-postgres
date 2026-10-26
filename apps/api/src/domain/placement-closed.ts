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
      "SELECT * FROM size_classes WHERE enabled=1 ORDER BY memory_mib,cpu_millicores,storage_mib,id LIMIT 1",
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

/** What is asked of a node when no class is on offer, or the region's bounds refuse the smallest. */
const NOTHING: PlacementNeed = {
  memory_mib: 0,
  cpu_millicores: 0,
  storage_mib: 0,
};

/**
 * The nodes that make a region closed for the smallest class on offer (plan 4.3, 4.8, 4.10), or
 * none while any node takes it. The region is closed when placement would find no node for that
 * class, by the rules of `choosePlacement` and by the measured load (the databases placed since a
 * node's newest sample are not counted: a burst of creates counts at its full memory until the
 * next sample, a state of seconds that placement honours and an alarm must not announce). A node
 * that is full while another one has room closes nothing: the region is open until the last node
 * that could take the class cannot, and open again as soon as one can. Once the region is closed
 * the list names the nodes whose thin pool refuses the class (data or metadata too full, the
 * storage sold plus that class past the logical cap, or `MAX_VOLUMES_PER_NODE` volumes) and, when
 * the nodes that report, are open for new databases and have a pool with room have no RAM or CPU
 * left for it (CPU peak below 80 %, RAM's higher of peak and current sample plus the class below
 * 80 %, and enough physical CPU cores), every one of those. A pool without room or without a
 * reading, a node that went quiet, one that is closed by its flags or by a maintenance cycle and
 * one whose load is not known yet are other alarms', or unknown: they are never listed here,
 * though they can take no database either.
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
    asked = need ?? NOTHING;
  const measured = nodes.map((node) => ({ ...node, pending_memory_mib: 0 }));
  if (choosePlacement(measured, asked, now) !== null) return [];
  const closed = new Set(
    nodes
      .filter((node) =>
        ["data", "metadata", "cap", "volumes"].includes(
          poolState(node, asked.storage_mib),
        ),
      )
      .map((node) => node.id),
  );
  if (need !== null) {
    // The nodes whose refusal is a matter of load: placement could take the class there, were
    // the RAM and the CPU free.
    const candidates = measured.filter(
      (node) =>
        nodeOnline(node, now) &&
        nodeOpen(node) &&
        !["unavailable", "no_room"].includes(
          poolState(node, asked.storage_mib),
        ) &&
        node.ram_peak_ppm !== null &&
        node.cpu_peak_ppm !== null &&
        node.memory_total_bytes !== null &&
        node.cpu_cores !== null,
    );
    for (const node of candidates) closed.add(node.id);
  }
  return [...closed].sort();
}
