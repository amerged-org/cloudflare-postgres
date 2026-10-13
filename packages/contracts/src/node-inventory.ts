// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Node } from "./api.ts";
import {
  FleetNodeRole,
  FleetNodeReleaseStatus,
  FleetReleaseFacts,
} from "./releases.ts";
import { FleetPatchStatus } from "./fleet-patches.ts";

export const NodeFleetObservation = z
  .strictObject({
    state: z.enum(["current", "stale", "unobserved"]),
    observed_at: z.iso.datetime().nullable(),
    talos_version: FleetReleaseFacts.shape.talos_version.unwrap().nullable(),
    kubernetes_version: FleetReleaseFacts.shape.kubernetes_version
      .unwrap()
      .nullable(),
    kubelet_version: FleetReleaseFacts.shape.kubelet_version
      .unwrap()
      .nullable(),
    /** Version is supplied only alongside the matching observed controller runtime image. */
    agent_version: z.string().min(1).max(128).nullable(),
    agent_image_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .meta({ id: "NodeFleetObservation" });

export const NodeLatestPatch = FleetPatchStatus.pick({
  operation_id: true,
  node_uid: true,
  release_id: true,
  assignment_revision: true,
  revision: true,
  stage: true,
  state: true,
  error_code: true,
  created_at: true,
  updated_at: true,
}).meta({ id: "NodeLatestPatch" });

/** Admin inventory, distinct from the legacy Node shape returned by node mutations. */
export const NodeInventory = Node.extend({
  role: FleetNodeRole.nullable(),
  release: FleetNodeReleaseStatus.omit({
    node_id: true,
    region_id: true,
    node_uid: true,
    role: true,
    observed_facts: true,
  }),
  observation: NodeFleetObservation,
  latest_patch: NodeLatestPatch.nullable(),
}).meta({ id: "NodeInventory" });
export type NodeInventory = z.infer<typeof NodeInventory>;
