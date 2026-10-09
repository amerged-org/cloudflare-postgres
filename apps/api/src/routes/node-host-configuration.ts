// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { NodeId, ErrorBody } from "@pgcf/contracts";
import {
  NodeHostConfigurationRequest,
  NodeHostConfigurationStatus,
} from "@pgcf/contracts/node-host-configuration";
import type { ApiApp } from "../app.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  readNodeHostConfiguration,
  ensureNodeHostConfiguration,
} from "../domain/node-host-configuration.ts";
export function registerNodeHostConfiguration(app: ApiApp) {
  const base = {
    path: "/v1/nodes/{id}/host-configuration",
    tags: ["Compute pool"],
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: NodeId }) },
    responses: {
      200: {
        description:
          "Protected host configuration metadata; private file contents are never returned",
        content: {
          "application/json": { schema: NodeHostConfigurationStatus },
        },
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 500].map((code) => [
          code,
          {
            description: "Request refused",
            content: { "application/json": { schema: ErrorBody } },
          },
        ]),
      ),
    },
  };
  app.openapi(createRoute({ ...base, method: "get" } as const), async (c) => {
    await requireScope(c, "admin");
    return c.json(
      await readNodeHostConfiguration(c.env, NodeId.parse(c.req.param("id"))),
    );
  });
  app.openapi(
    createRoute({
      ...base,
      method: "put",
      request: {
        ...base.request,
        body: {
          required: true,
          content: {
            "application/json": { schema: NodeHostConfigurationRequest },
          },
        },
      },
    } as const),
    async (c) => {
      await requireScope(c, "admin");
      const input = NodeHostConfigurationRequest.parse(await c.req.json());
      return c.json(
        await ensureNodeHostConfiguration(c.env, {
          node_id: NodeId.parse(c.req.param("id")),
          ...input,
        }),
      );
    },
  );
}
