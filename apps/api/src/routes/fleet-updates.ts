// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody } from "@pgcf/contracts";
import {
  FleetUpdateCandidate,
  FleetUpdateCandidateAction,
  FleetUpdateCandidateId,
  FleetUpdateCandidateList,
  FleetUpdatePolicyStatus,
  FleetUpdatePolicyUpdate,
} from "@pgcf/contracts/fleet-updates";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  actOnFleetUpdateCandidate,
  getFleetUpdateCandidate,
  getFleetUpdatePolicy,
  listFleetUpdateCandidates,
  updateFleetUpdatePolicy,
} from "../domain/fleet-updates.ts";
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
const responses = (schema: z.ZodType) => ({
  ...errors,
  200: { description: "Successful response", content: json(schema) },
});
const common = { tags: ["Fleet updates"], security: [{ bearerAuth: [] }] };
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
) {
  app.openapi(createRoute(route), handler);
}
/** There is deliberately no upload/approve/promote receipt endpoint. */
export function registerFleetUpdates(app: ApiApp): void {
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/update-policy",
      responses: responses(FleetUpdatePolicyStatus),
    },
    getFleetUpdatePolicy,
  );
  register(
    app,
    {
      ...common,
      method: "put",
      path: "/v1/fleet/update-policy",
      request: {
        headers,
        body: { required: true, content: json(FleetUpdatePolicyUpdate) },
      },
      responses: responses(FleetUpdatePolicyStatus),
    },
    async (c) =>
      updateFleetUpdatePolicy(
        c,
        FleetUpdatePolicyUpdate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/update-candidates",
      request: {
        query: z.object({ cursor: FleetUpdateCandidateId.optional() }),
      },
      responses: responses(FleetUpdateCandidateList),
    },
    async (c) => listFleetUpdateCandidates(c, c.req.query("cursor")),
  );
  register(
    app,
    {
      ...common,
      method: "get",
      path: "/v1/fleet/update-candidates/{id}",
      request: { params: z.object({ id: FleetUpdateCandidateId }) },
      responses: responses(FleetUpdateCandidate),
    },
    async (c) =>
      getFleetUpdateCandidate(
        c,
        FleetUpdateCandidateId.parse(c.req.param("id")),
      ),
  );
  for (const action of ["reject", "resume"] as const)
    register(
      app,
      {
        ...common,
        method: "post",
        path: `/v1/fleet/update-candidates/{id}/${action}`,
        request: {
          headers,
          params: z.object({ id: FleetUpdateCandidateId }),
          body: { required: true, content: json(FleetUpdateCandidateAction) },
        },
        responses: responses(FleetUpdateCandidate),
      },
      async (c) =>
        actOnFleetUpdateCandidate(
          c,
          FleetUpdateCandidateId.parse(c.req.param("id")),
          action,
          FleetUpdateCandidateAction.parse(await c.req.json()),
        ),
    );
}
