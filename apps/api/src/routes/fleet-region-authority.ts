// SPDX-License-Identifier: Apache-2.0
import { NodeId, OperationId, RegionId } from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import { ApiError } from "../app.ts";
import {
  authorizeFleetRegionRotation,
  checkpointFleetRegionAuthority,
} from "../domain/fleet-region-authority.ts";
import { operatorKubernetesRelay } from "../domain/node-operator.ts";
export function registerFleetRegionAuthority(app: ApiApp) {
  const prefix =
    "/internal/v1/fleet-rollouts/:rollout/regions/:region/rotation";
  app.post(prefix, async (c) =>
    c.json(
      await checkpointFleetRegionAuthority(
        c.env,
        OperationId.parse(c.req.param("rollout")),
        RegionId.parse(c.req.param("region")),
        c.req.header("authorization") ?? null,
        await c.req.json(),
      ),
    ),
  );
  app.get(prefix + "/kubernetes/:node", async (c) => {
    if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
      throw new ApiError("invalid_request", "Kubernetes WebSocket required");
    const rollout = OperationId.parse(c.req.param("rollout")),
      regionId = RegionId.parse(c.req.param("region")),
      nodeId = NodeId.parse(c.req.param("node")),
      bearer = c.req.header("authorization") ?? null,
      selected = await authorizeFleetRegionRotation(
        c.env,
        rollout,
        regionId,
        bearer,
      ),
      member = selected.region.nodes.find((n) => n.node_id === nodeId);
    if (!member)
      throw new ApiError("unauthorized", "Node outside current fleet intent");
    return operatorKubernetesRelay(c.env, nodeId, member.node_uid, async () => {
      const current = await authorizeFleetRegionRotation(
          c.env,
          rollout,
          regionId,
          bearer,
        ),
        same = current.region.nodes.find((n) => n.node_id === nodeId);
      if (!same || same.node_uid !== member.node_uid)
        throw new ApiError("unauthorized", "Fleet node changed");
    });
  });
}
