// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { AgentActivityRequest, AgentUsageRequest } from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import {
  ingestAgentActivity,
  ingestAgentUsage,
} from "../domain/agent-metrics.ts";

export function registerAgentMetrics(app: ApiApp): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "AgentBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "AgentKey",
  });
  app.openapi(
    createRoute({
      method: "post",
      path: "/agent/v1/activity",
      tags: ["Agent"],
      security: [{ AgentBearer: [] }],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: AgentActivityRequest } },
        },
      },
      responses: {
        200: {
          description: "Measured activity accepted",
          content: {
            "application/json": {
              schema: z.strictObject({
                accepted: z.number().int().nonnegative(),
                idle_intents: z.number().int().nonnegative(),
              }),
            },
          },
        },
      },
    }),
    async (c) => ingestAgentActivity(c, c.req.valid("json")),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/agent/v1/usage",
      tags: ["Agent"],
      security: [{ AgentBearer: [] }],
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: AgentUsageRequest } },
        },
      },
      responses: {
        200: {
          description:
            "Every sample is acknowledged: recorded, an identical duplicate, or refused for good because its hour is finalized, it overlaps or exceeds the hourly input bound, or its identity was reused with different measurements",
          content: {
            "application/json": {
              schema: z.strictObject({
                recorded: z.number().int().nonnegative(),
                duplicates: z.number().int().nonnegative(),
                refused: z.number().int().nonnegative(),
              }),
            },
          },
        },
      },
    }),
    async (c) => ingestAgentUsage(c, c.req.valid("json")),
  );
}
