// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { NodeId, OperationId, RegionId } from "./ids.ts";
import {
  FleetNodeReleaseStatus,
  FleetNodeRole,
  FleetReleaseId,
} from "./releases.ts";
import { FleetRegionMaterialRotationCheckpoint } from "./region-material-rotation.ts";
import { ComputePoolPolicy } from "./compute-pool.ts";
import { FleetPatchStatus } from "./fleet-patches.ts";
const Revision = z.number().int().min(0).max(2147483646);
const NodeTarget = z.strictObject({
  node_id: NodeId,
  node_uid: z.uuid(),
  expected_revision: Revision,
  role: FleetNodeRole,
  address: z.ipv4(),
  compute_pool: z
    .strictObject({ expected_revision: Revision, policy: ComputePoolPolicy })
    .optional(),
});
const RegionTarget = z
  .strictObject({
    region_id: RegionId,
    expected_revision: Revision,
    cluster_uid: z.uuid(),
    material_revision: Revision.min(1),
    staged_material_revision: Revision.min(2).optional(),
    nodes: z.array(NodeTarget).min(1).max(100),
  })
  .superRefine((region, context) => {
    if (
      region.staged_material_revision !== undefined &&
      region.staged_material_revision !== region.material_revision + 1
    )
      context.addIssue({
        code: "custom",
        message:
          "A prepared rotation must select the immediate material successor",
      });
    if (
      new Set(region.nodes.map((node) => node.node_id)).size !==
      region.nodes.length
    )
      context.addIssue({
        code: "custom",
        message: "A physical member may appear once",
      });
  });
/** The array order is the maintenance order, both between clusters and between hosts. */
const FleetRolloutRequestCore = z
  .strictObject({
    release_id: FleetReleaseId,
    maintenance_acknowledged: z.literal(true),
    regions: z.array(RegionTarget).min(1).max(10),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.regions.map((region) => region.region_id)).size !==
      value.regions.length
    )
      context.addIssue({ code: "custom", message: "A region may appear once" });
    const nodes = value.regions.flatMap((region) => region.nodes);
    if (
      nodes.length > 100 ||
      new Set(nodes.map((node) => node.node_id)).size !== nodes.length
    )
      context.addIssue({
        code: "custom",
        message: "Select at most 100 distinct nodes per request",
      });
  });
export const FleetRolloutRequest = FleetRolloutRequestCore.safeExtend({
  expected_previous_rollout_id: OperationId.optional(),
});
export type FleetRolloutRequest = z.infer<typeof FleetRolloutRequest>;
const FleetRolloutIntentCore = FleetRolloutRequestCore.safeExtend({
  rollout_id: OperationId,
  created_at: z.iso.datetime(),
  regions: z
    .array(
      RegionTarget.safeExtend({
        revision: Revision.min(1),
        current_material_revision: Revision.min(1),
        rotation: FleetRegionMaterialRotationCheckpoint.optional(),
        nodes: z
          .array(NodeTarget.extend({ assignment_revision: Revision.min(1) }))
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(10),
});
export const FleetRolloutIntent = FleetRolloutIntentCore.safeExtend({
  previous_intent: FleetRolloutIntentCore.strip().optional(),
});
export type FleetRolloutIntent = z.infer<typeof FleetRolloutIntent>;
export const FleetRolloutStatus = z.strictObject({
  rollout_id: OperationId,
  release_id: FleetReleaseId,
  created_at: z.iso.datetime(),
  state: z.enum(["pending", "running", "blocked", "complete"]),
  reason: z.string().max(128).nullable(),
  regions: z.array(
    z.strictObject({
      region_id: RegionId,
      current_material_revision: Revision.min(1),
      staged_material_revision: Revision.min(1).nullable(),
      rotation: FleetRegionMaterialRotationCheckpoint.nullable(),
      nodes: z.array(
        z.strictObject({
          node_id: NodeId,
          ram_observed_at: z.iso.datetime().nullable(),
          release: FleetNodeReleaseStatus,
          patch: FleetPatchStatus.nullable(),
        }),
      ),
    }),
  ),
});
export type FleetRolloutStatus = z.infer<typeof FleetRolloutStatus>;
