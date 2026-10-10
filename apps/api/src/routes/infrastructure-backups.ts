// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import {
  InfrastructureBackupConfig,
  InfrastructureBackupConfigInput,
  InfrastructureBackupHealth,
  InfrastructureBackupRunStatus,
} from "@pgcf/contracts/infrastructure-backups";
import { ApiError, type ApiApp } from "../app.ts";
import { requireScope } from "../middleware/auth.ts";
import {
  authorizeBackupOperator,
  configureInfrastructureBackups,
  infrastructureBackupHealth,
  infrastructureBackupStatus,
  readInfrastructureBackupConfig,
} from "../domain/infrastructure-backups.ts";
import { operatorKubernetesRelay } from "../domain/node-operator.ts";
export function registerInfrastructureBackups(app: ApiApp) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/infrastructure-backups/config",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description:
            "Operator-configured daily infrastructure backups and optional generic email delivery",
          content: {
            "application/json": { schema: InfrastructureBackupConfig },
          },
        },
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(await readInfrastructureBackupConfig(c.env.DB), 200);
    },
  );
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/infrastructure-backups/config",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: InfrastructureBackupConfigInput },
          },
        },
      },
      responses: {
        200: {
          description:
            "Configuration persisted; defaults remain off until the operator enables them",
          content: {
            "application/json": { schema: InfrastructureBackupConfig },
          },
        },
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(
        await configureInfrastructureBackups(c.env, c.req.valid("json")),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/infrastructure-backups",
      tags: ["Infrastructure"],
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: "Latest safe backup receipts and current freshness",
          content: {
            "application/json": {
              schema: z.object({
                latest: InfrastructureBackupRunStatus.nullable(),
                health: z.array(InfrastructureBackupHealth),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      await requireScope(c, "admin");
      return c.json(
        {
          latest: await infrastructureBackupStatus(c.env.DB),
          health: await infrastructureBackupHealth(c.env),
        },
        200,
      );
    },
  );
  app.get(
    "/internal/v1/infrastructure-backups/:run/:artifact/kubernetes",
    async (c) => {
      if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
        throw new ApiError(
          "invalid_request",
          "A backup Kubernetes WebSocket is required",
        );
      const run = z.uuid().parse(c.req.param("run")),
        artifact = c.req.param("artifact"),
        bearer = c.req.header("authorization");
      const authorize = async () => {
        await authorizeBackupOperator(c.env, run, artifact, bearer);
      };
      const selected = await authorizeBackupOperator(
        c.env,
        run,
        artifact,
        bearer,
      );
      return operatorKubernetesRelay(
        c.env,
        selected.node_id!,
        selected.node_uid!,
        authorize,
      );
    },
  );
}
