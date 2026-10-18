// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  DatabaseId,
  DatabaseResources,
  DatabaseWithOperation,
  ErrorBody,
  IdempotencyKey,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import { setDatabaseResources } from "../domain/database-resources.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
export function registerDatabaseResources(app: ApiApp): void {
  const route: RouteConfig = {
    method: "put",
    path: "/v1/databases/{id}/resources",
    security: [{ bearerAuth: [] }],
    tags: ["Databases"],
    description:
      "Sets the database's own memory, CPU and storage with an admin key; an integrator key chooses a size class instead and gets 403. All three fields are set, and null hands a field back to the size class. Memory is a multiple of 256 MiB up to the region's per-database maximum (4,096 MiB unless the region sets another); CPU is at least 100 millicores and at most the cores of the region's largest node; storage is at least the database's current size and never shrinks, so a null that would hand back a smaller class value is refused (400). Own values survive a change of size class (`PATCH`). The change is a resize: an awake database gets a new generation and the operation completes when its node reports it, and a sleeping database takes the values at its next wake. A database whose node cannot take the growth is refused with 503 `capacity_exhausted` (reason `node_capacity`) and Retry-After: an awake one when its active RAM would reach 80 % or its storage would pass the pool's logical cap (4 times the pool's data, counting the databases the node has not finished), a sleeping one for its storage alone, because its memory and CPU wait for the wake. Values that leave the effective resources as they are are only recorded, with a completed operation and no new generation.",
    request: {
      headers: z.object({ "Idempotency-Key": IdempotencyKey.optional() }),
      params: z.object({ id: DatabaseId }),
      body: { required: true, content: json(DatabaseResources) },
    },
    responses: {
      202: {
        description: "Operation accepted",
        content: json(DatabaseWithOperation),
      },
      ...Object.fromEntries(
        [
          [400, "Invalid request, or resources outside the region's bounds"],
          [401, "Invalid credentials"],
          [403, "Insufficient scope"],
          [404, "Resource not found"],
          [
            409,
            "Conflict: error.details.reason names the cause; the database is deleted or not ready",
          ],
          [500, "Internal server error"],
          [
            503,
            "The database's node cannot take the growth now; retry after the Retry-After delay",
          ],
        ].map(([code, description]) => [
          code as number,
          { description: description as string, content: json(ErrorBody) },
        ]),
      ),
    },
  };
  app.openapi(createRoute(route), async (c) =>
    setDatabaseResources(
      c,
      DatabaseId.parse(c.req.param("id")),
      DatabaseResources.parse(await c.req.json()),
    ),
  );
}
