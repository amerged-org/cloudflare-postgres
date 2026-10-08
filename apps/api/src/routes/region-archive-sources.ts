// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  IdempotencyKey,
  RegionId,
  RegionArchiveSource,
  RegionArchiveSourceUpdate,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getRegionArchiveSource,
  updateRegionArchiveSource,
} from "../domain/region-archive-sources.ts";
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
export function registerRegionArchiveSources(app: ApiApp) {
  for (const method of ["get", "put"] as const) {
    const config: RouteConfig = {
      method,
      path: "/v1/regions/{target}/archive-sources/{source}",
      tags: ["Regions"],
      security: [{ bearerAuth: [] }],
      description:
        "Manage a target region's exact source-archive read credentials. Supply bucket-scoped Object Read Only R2 credentials; the API validates the registered source and encrypted custody, not the provider's IAM permissions. Credentials never appear in this response. Rotation waits for referencing restores to finish and advances their configuration generations.",
      request: {
        params: z.object({ target: RegionId, source: RegionId }),
        ...(method === "put"
          ? {
              headers: z.object({
                "Idempotency-Key": IdempotencyKey.optional(),
              }),
              body: {
                required: true,
                content: json(RegionArchiveSourceUpdate),
              },
            }
          : {}),
      },
      responses: {
        200: {
          description: "Configured source without credentials",
          content: json(RegionArchiveSource),
        },
        ...Object.fromEntries(
          [400, 401, 403, 404, 409, 500].map((status) => [
            status,
            { description: "Request refused", content: json(ErrorBody) },
          ]),
        ),
      },
    };
    const handler = async (c: ApiContext) => {
      const target = RegionId.parse(c.req.param("target")),
        source = RegionId.parse(c.req.param("source"));
      return method === "get"
        ? getRegionArchiveSource(c, target, source)
        : updateRegionArchiveSource(
            c,
            target,
            source,
            RegionArchiveSourceUpdate.parse(await c.req.json()),
          );
    };
    app.openapi(createRoute(config), handler);
  }
}
