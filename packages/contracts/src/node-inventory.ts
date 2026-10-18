// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Node } from "./api.ts";
import { FleetNodeReleaseStatus } from "./releases.ts";

/** What the node's link last reported: `stale` after `NODE_STALE_MS` of silence. */
export const NodeFleetObservation = z
  .strictObject({
    state: z.enum(["current", "stale", "unobserved"]),
    observed_at: z.iso.datetime().nullable(),
    agent_version: z.string().min(1).max(64).nullable(),
  })
  .meta({ id: "NodeFleetObservation" });

/** Admin inventory, distinct from the legacy Node shape returned by node mutations. */
export const NodeInventory = Node.extend({
  release: FleetNodeReleaseStatus.omit({
    node_id: true,
    region_id: true,
    node_uid: true,
  }),
  observation: NodeFleetObservation,
}).meta({ id: "NodeInventory" });
export type NodeInventory = z.infer<typeof NodeInventory>;
