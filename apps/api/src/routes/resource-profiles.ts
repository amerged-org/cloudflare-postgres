// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DatabaseId,
  DatabaseResourceProfile,
  DatabaseWithOperation,
  ErrorBody,
  IdempotencyKey,
  ResourceProfileId,
  ResourceProfileUpdate,
  ResourceProfileRevision,
  ResourceProfileAssignment,
  ResourceProfileRollout,
  ResourceProfileRolloutUpdate,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getResourceProfile,
  updateResourceProfile,
  getDatabaseResourceProfile,
  assignDatabaseResourceProfile,
  getResourceProfileRollout,
  updateResourceProfileRollout,
} from "../domain/resource-profiles.ts";
const content = (schema: z.ZodType) => ({ "application/json": { schema } });
function route(
  app: ApiApp,
  method: "get" | "put",
  path: string,
  params: NonNullable<RouteConfig["request"]>["params"],
  response: z.ZodType,
  handler: (c: ApiContext) => Promise<Response>,
  body?: z.ZodType,
  status = 200,
) {
  const config: RouteConfig = {
    method,
    path,
    tags: ["Resource profiles"],
    security: [{ bearerAuth: [] }],
    request: {
      params,
      ...(body
        ? {
            headers: z.object({ "Idempotency-Key": IdempotencyKey.optional() }),
            body: { required: true, content: content(body) },
          }
        : {}),
    },
    responses: {
      [status]: {
        description: "Current resource policy or operation",
        content: content(response),
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 500].map((code) => [
          code,
          { description: "Request refused", content: content(ErrorBody) },
        ]),
      ),
    },
  };
  app.openapi(createRoute(config), handler);
}
export function registerResourceProfiles(app: ApiApp) {
  const profiles = "/v1/resource-profiles/{id}",
    databases = "/v1/databases/{id}/resource-profile";
  route(
    app,
    "get",
    profiles + "/rollout",
    z.object({ id: ResourceProfileId }),
    ResourceProfileRollout,
    (c) =>
      getResourceProfileRollout(c, ResourceProfileId.parse(c.req.param("id"))),
  );
  route(
    app,
    "put",
    profiles + "/rollout",
    z.object({ id: ResourceProfileId }),
    ResourceProfileRollout,
    async (c) =>
      updateResourceProfileRollout(
        c,
        ResourceProfileId.parse(c.req.param("id")),
        ResourceProfileRolloutUpdate.parse(await c.req.json()),
      ),
    ResourceProfileRolloutUpdate,
  );
  route(
    app,
    "get",
    profiles,
    z.object({ id: ResourceProfileId }),
    ResourceProfileRevision,
    (c) => getResourceProfile(c, ResourceProfileId.parse(c.req.param("id"))),
  );
  route(
    app,
    "get",
    profiles + "/revisions/{revision}",
    z.object({
      id: ResourceProfileId,
      revision: z.coerce.number().int().positive(),
    }),
    ResourceProfileRevision,
    (c) =>
      getResourceProfile(
        c,
        ResourceProfileId.parse(c.req.param("id")),
        z.coerce.number().int().positive().parse(c.req.param("revision")),
      ),
  );
  route(
    app,
    "put",
    profiles,
    z.object({ id: ResourceProfileId }),
    ResourceProfileRevision,
    async (c) =>
      updateResourceProfile(
        c,
        ResourceProfileId.parse(c.req.param("id")),
        ResourceProfileUpdate.parse(await c.req.json()),
      ),
    ResourceProfileUpdate,
  );
  route(
    app,
    "get",
    databases,
    z.object({ id: DatabaseId }),
    DatabaseResourceProfile,
    (c) => getDatabaseResourceProfile(c, DatabaseId.parse(c.req.param("id"))),
  );
  route(
    app,
    "put",
    databases,
    z.object({ id: DatabaseId }),
    DatabaseWithOperation,
    async (c) =>
      assignDatabaseResourceProfile(
        c,
        DatabaseId.parse(c.req.param("id")),
        ResourceProfileAssignment.parse(await c.req.json()),
      ),
    ResourceProfileAssignment,
    202,
  );
}
