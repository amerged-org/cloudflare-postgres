// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, NodeId, RegionId } from "@pgcf/contracts";
import {
  FleetReleaseId,
  FleetRelease,
  FleetReleaseSpec,
  FleetRegionReleaseUpdate,
  FleetNodeReleaseUpdate,
  FleetRegionReleaseStatus,
  FleetNodeReleaseStatus,
  FleetNodeReleaseObservation,
} from "@pgcf/contracts/releases";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getFleetRelease,
  approveFleetRelease,
  getFleetRegionRelease,
  assignFleetRegionRelease,
  getFleetNodeRelease,
  assignFleetNodeRelease,
  observeFleetNodeRelease,
} from "../domain/fleet-releases.ts";
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 500].map((status) => [
    status,
    { description: "Request failed", content: json(ErrorBody) },
  ]),
);
const headers = z.object({
  "Idempotency-Key": z
    .string()
    .regex(/^[A-Za-z0-9._~-]{1,128}$/)
    .optional(),
});
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
const responses = (schema: z.ZodType) => ({
  ...errors,
  200: { description: "Successful response", content: json(schema) },
});
const common = { tags: ["Fleet releases"], security: [{ bearerAuth: [] }] };
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}
export function registerFleetReleases(app: ApiApp): void {
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/fleet/releases/{id}",
      description:
        "Approves an immutable artifact-pinned release. This records desired configuration; it does not execute a patch or assert current convergence.",
      request: {
        headers,
        params: z.object({ id: FleetReleaseId }),
        body: body(FleetReleaseSpec),
      },
      responses: responses(FleetRelease),
    },
    async (c) =>
      approveFleetRelease(
        c,
        FleetReleaseId.parse(c.req.param("id")),
        FleetReleaseSpec.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/releases/{id}",
      request: { params: z.object({ id: FleetReleaseId }) },
      responses: responses(FleetRelease),
    },
    async (c) => getFleetRelease(c, FleetReleaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/regions/{id}/release",
      request: {
        headers,
        params: z.object({ id: RegionId }),
        body: body(FleetRegionReleaseUpdate),
      },
      responses: responses(FleetRegionReleaseStatus),
    },
    async (c) =>
      assignFleetRegionRelease(
        c,
        RegionId.parse(c.req.param("id")),
        FleetRegionReleaseUpdate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/regions/{id}/release",
      request: { params: z.object({ id: RegionId }) },
      responses: responses(FleetRegionReleaseStatus),
    },
    async (c) => getFleetRegionRelease(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/nodes/{id}/release",
      description:
        "Assigns the region's selected release to the current physical Node UID and declared role using a revision compare-and-set.",
      request: {
        headers,
        params: z.object({ id: NodeId }),
        body: body(FleetNodeReleaseUpdate),
      },
      responses: responses(FleetNodeReleaseStatus),
    },
    async (c) =>
      assignFleetNodeRelease(
        c,
        NodeId.parse(c.req.param("id")),
        FleetNodeReleaseUpdate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/nodes/{id}/release",
      description:
        "Reports convergence from fresh authenticated component inventory. Inventory is an agent observation, not independent artifact attestation.",
      request: { params: z.object({ id: NodeId }) },
      responses: responses(FleetNodeReleaseStatus),
    },
    async (c) => getFleetNodeRelease(c, NodeId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      ...common,
      method: "post",
      path: "/agent/v1/fleet-observations",
      description:
        "Records a full inventory for the current registered regional agent, assignment revision and physical Node UID. Does not authorize patches.",
      request: { body: body(FleetNodeReleaseObservation) },
      responses: responses(z.strictObject({ accepted: z.literal(true) })),
    },
    async (c) =>
      observeFleetNodeRelease(
        c,
        FleetNodeReleaseObservation.parse(await c.req.json()),
      ),
  );
}
