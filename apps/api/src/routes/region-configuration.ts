// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ErrorBody,
  RegionId,
  IdempotencyKey,
  RegionConfiguration,
  RegionConfigurationUpdate,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  getRegionConfiguration,
  updateRegionConfiguration,
} from "../platform/regions.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const parameters = z.object({ id: RegionId });
const responses = {
  200: {
    description: "Current region configuration",
    content: json(RegionConfiguration),
  },
  400: {
    description: "Invalid gateway configuration",
    content: json(ErrorBody),
  },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: {
    description: "Administrator scope required",
    content: json(ErrorBody),
  },
  404: { description: "Region not found", content: json(ErrorBody) },
  409: {
    description: "Stale configuration or idempotency conflict",
    content: json(ErrorBody),
  },
  500: { description: "Internal server error", content: json(ErrorBody) },
};

function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerRegionConfiguration(app: ApiApp): void {
  register(
    app,
    {
      method: "get",
      path: "/v1/regions/{id}/configuration",
      tags: ["Regions"],
      security: [{ bearerAuth: [] }],
      request: { params: parameters },
      responses,
    },
    async (c) => getRegionConfiguration(c, RegionId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "put",
      path: "/v1/regions/{id}/configuration",
      tags: ["Regions"],
      security: [{ bearerAuth: [] }],
      description:
        "Atomically updates routing against the expected configuration digest. Provider identity, backup configuration and bootstrap credentials are preserved. Idempotency replay returns the current configuration without reapplying the mutation.",
      request: {
        params: parameters,
        headers: z.object({ "Idempotency-Key": IdempotencyKey.optional() }),
        body: { required: true, content: json(RegionConfigurationUpdate) },
      },
      responses,
    },
    async (c) =>
      updateRegionConfiguration(
        c,
        RegionId.parse(c.req.param("id")),
        RegionConfigurationUpdate.parse(await c.req.json()),
      ),
  );
}
