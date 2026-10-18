// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  ListQuery,
  NodeId,
  RegionId,
  listEnvelope,
} from "@pgcf/contracts";
import {
  FleetReleaseId,
  FleetRelease,
  FleetReleaseSpec,
  FleetRegionReleaseUpdate,
  FleetRegionReleaseStatus,
  FleetNodeReleaseStatus,
} from "@pgcf/contracts/releases";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getFleetRelease,
  listFleetReleases,
  approveFleetRelease,
  getFleetRegionRelease,
  assignFleetRegionRelease,
  getFleetNodeRelease,
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
      method: "get",
      path: "/v1/fleet/releases",
      operationId: "listFleetReleases",
      summary: "List approved fleet releases",
      description:
        "Lists immutable global release approvals, newest approved timestamp and release ID first.",
      request: { query: ListQuery },
      responses: {
        200: {
          description: "Immutable global release approvals",
          content: json(listEnvelope(FleetRelease)),
        },
        400: { description: "Invalid list query", content: json(ErrorBody) },
        401: {
          description: "Authentication required",
          content: json(ErrorBody),
        },
        403: {
          description: "Administrator scope required",
          content: json(ErrorBody),
        },
        500: {
          description: "Internal request failure",
          content: json(ErrorBody),
        },
      },
    },
    listFleetReleases,
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/fleet/releases/{id}",
      description:
        "Approves an immutable release: one node image with its binaries and package lock, the same for every node. This records desired configuration; assigning it to a region makes the region's nodes pull it.",
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
      method: "get",
      path: "/v1/nodes/{id}/release",
      description:
        "Reports how the node stands against its region's release: whether its last hello named the release and its link is fresh.",
      request: { params: z.object({ id: NodeId }) },
      responses: responses(FleetNodeReleaseStatus),
    },
    async (c) => getFleetNodeRelease(c, NodeId.parse(c.req.param("id"))),
  );
}
