// SPDX-License-Identifier: Apache-2.0
import { createRoute, z } from "@hono/zod-openapi";
import { DatabaseId, NodeId, ErrorBody } from "@pgcf/contracts";
import {
  PoolBindingSnapshot,
  PoolBindingDetails,
  PoolPodInventory,
  PoolStorageObservation,
  PoolSleepRecord,
  PoolNodeReport,
  PoolServingReport,
  PoolSupervisorReport,
  PoolIoAttestation,
  PoolCleanupIoAttestation,
  PoolPodPreparationContext,
} from "@pgcf/contracts/postgres-pool";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import {
  authorizePostgresPoolBinding,
  authorizePostgresPoolDatabase,
  authorizePostgresPoolNode,
  getPostgresPoolBindingSnapshot,
  getPostgresPoolBindingDetails,
  recordPostgresPoolInventory,
  recordPostgresPoolStorageObservation,
  recordPostgresPoolSleep,
  recordPostgresPoolNodeReport,
  recordPostgresPoolServing,
  recordPostgresPoolSupervisorReport,
  recordPostgresPoolIoAttestation,
  recordPostgresPoolCleanupIoAttestation,
} from "../domain/postgres-pool.ts";
import { recordPostgresPoolPreparationContext } from "../domain/postgres-pool-preparation.ts";
const accepted = z.strictObject({ accepted: z.literal(true) });
const content = (schema: z.ZodType) => ({ "application/json": { schema } });
function post(
  app: ApiApp,
  path: string,
  id: z.ZodType,
  body: z.ZodType,
  authorize: (c: ApiContext, id: string) => Promise<unknown>,
  execute: (c: ApiContext, id: string, value: unknown) => Promise<void>,
) {
  app.openapi(
    createRoute({
      method: "post",
      path,
      tags: ["PostgreSQL pool"],
      security: [{ AgentBearer: [] }],
      request: {
        params: z.object({ id }),
        body: { required: true, content: content(body) },
      },
      responses: {
        200: {
          description: "Authenticated scoped pool report accepted",
          content: content(accepted),
        },
        409: {
          description: "Pool holder authority changed",
          content: content(ErrorBody),
        },
      },
    }),
    async (c) => {
      const value = z.string().parse(c.req.param("id"));
      await authorize(c, value);
      await execute(c, value, body.parse(await c.req.json()));
      return c.json({ accepted: true }, 200);
    },
  );
}
export function registerPostgresPool(app: ApiApp) {
  post(
    app,
    "/agent/v1/pool-bindings/{id}/cleanup-io",
    z.uuid(),
    PoolCleanupIoAttestation,
    authorizePostgresPoolBinding,
    (c, id, value) =>
      recordPostgresPoolCleanupIoAttestation(
        c.env,
        id,
        PoolCleanupIoAttestation.parse(value),
      ),
  );
  post(
    app,
    "/agent/v1/nodes/{id}/postgres-pool/preparations",
    NodeId,
    PoolPodPreparationContext,
    authorizePostgresPoolNode,
    (c, id, value) =>
      recordPostgresPoolPreparationContext(
        c.env,
        id,
        PoolPodPreparationContext.parse(value),
      ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/agent/v1/pool-bindings/{id}",
      tags: ["PostgreSQL pool"],
      security: [{ AgentBearer: [] }],
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description:
            "Attested runtime and actual stored node/IO outcome, including terminal cleanup",
          content: content(PoolBindingDetails),
        },
        404: {
          description: "Binding unavailable",
          content: content(ErrorBody),
        },
        409: {
          description: "Current node authority unavailable",
          content: content(ErrorBody),
        },
      },
    }),
    (c) => getPostgresPoolBindingDetails(c, z.uuid().parse(c.req.param("id"))),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/agent/v1/nodes/{id}/postgres-pool/bindings",
      tags: ["PostgreSQL pool"],
      security: [{ AgentBearer: [] }],
      request: {
        params: z.object({ id: NodeId }),
        query: z.object({
          after: z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .default(0),
          wait_ms: z.coerce.number().int().min(0).max(25000).default(0),
        }),
      },
      responses: {
        200: {
          description:
            "Complete current node holder inventory or bounded held delivery",
          content: content(PoolBindingSnapshot),
        },
        409: {
          description: "Pool authority is unavailable",
          content: content(ErrorBody),
        },
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return getPostgresPoolBindingSnapshot(
        c,
        NodeId.parse(c.req.param("id")),
        q.after,
        q.wait_ms,
      );
    },
  );
  post(
    app,
    "/agent/v1/nodes/{id}/postgres-pool/inventory",
    NodeId,
    PoolPodInventory,
    authorizePostgresPoolNode,
    (c, id, value) =>
      recordPostgresPoolInventory(c.env, id, PoolPodInventory.parse(value)),
  );
  post(
    app,
    "/agent/v1/databases/{id}/postgres-pool/storage",
    DatabaseId,
    PoolStorageObservation,
    authorizePostgresPoolDatabase,
    (c, id, value) =>
      recordPostgresPoolStorageObservation(
        c.env,
        id,
        PoolStorageObservation.parse(value),
      ),
  );
  post(
    app,
    "/agent/v1/databases/{id}/postgres-pool/sleep",
    DatabaseId,
    PoolSleepRecord,
    authorizePostgresPoolDatabase,
    (c, id, value) =>
      recordPostgresPoolSleep(c.env, id, PoolSleepRecord.parse(value)),
  );
  post(
    app,
    "/agent/v1/pool-bindings/{id}/node",
    z.uuid(),
    PoolNodeReport,
    authorizePostgresPoolBinding,
    (c, id, value) =>
      recordPostgresPoolNodeReport(c.env, id, PoolNodeReport.parse(value)),
  );
  post(
    app,
    "/agent/v1/pool-bindings/{id}/serving",
    z.uuid(),
    PoolServingReport,
    authorizePostgresPoolBinding,
    (c, id, value) => {
      const report = PoolServingReport.parse(value);
      return recordPostgresPoolServing(
        c.env,
        id,
        report.runtime,
        report.supervisor,
      );
    },
  );
  post(
    app,
    "/agent/v1/pool-bindings/{id}/supervisor",
    z.uuid(),
    PoolSupervisorReport,
    authorizePostgresPoolBinding,
    (c, id, value) =>
      recordPostgresPoolSupervisorReport(
        c.env,
        id,
        PoolSupervisorReport.parse(value),
      ),
  );
  post(
    app,
    "/agent/v1/pool-bindings/{id}/io",
    z.uuid(),
    PoolIoAttestation,
    authorizePostgresPoolBinding,
    (c, id, value) =>
      recordPostgresPoolIoAttestation(
        c.env,
        id,
        PoolIoAttestation.parse(value),
      ),
  );
}
