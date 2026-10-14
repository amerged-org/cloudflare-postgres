// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import { ErrorBody, NodeId, IdempotencyKey } from "@pgcf/contracts";
import {
  PostgresPoolQualificationRequest,
  PostgresPoolQualificationRun,
  PostgresPoolQualificationInput,
  PostgresPoolQualificationReport,
  PostgresPoolQualificationProgressReport,
} from "@pgcf/contracts/postgres-pool-qualification";
import type { ApiApp } from "../app.ts";
import {
  startPostgresPoolQualification,
  getPostgresPoolQualification,
  cancelPostgresPoolQualification,
  getPostgresPoolQualificationInput,
  reportPostgresPoolQualification,
  recordPostgresPoolQualificationProgress,
} from "../domain/postgres-pool-qualification.ts";
const content = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = (statuses: readonly number[]) =>
  Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: "Request refused",
        content: content(ErrorBody),
      },
    ]),
  );
export function registerPostgresPoolQualification(app: ApiApp) {
  const start: RouteConfig = {
    method: "post",
    path: "/v1/nodes/{id}/postgres-pool/qualifications",
    tags: ["PostgreSQL pool"],
    security: [{ bearerAuth: [] }],
    operationId: "startPostgresPoolQualification",
    summary: "Start one scoped thin-backed PostgreSQL pool qualification",
    description:
      "Qualifies one immutable candidate using an established hibernated thin database and one target wake generation. It enables no normal pool admission. Failed, cancelled or expired runs retain their reservation until actual cleanup is proven.",
    request: {
      params: z.object({ id: NodeId }),
      headers: z.object({ "Idempotency-Key": IdempotencyKey.optional() }),
      body: {
        required: true,
        content: content(PostgresPoolQualificationRequest),
      },
    },
    responses: {
      202: {
        description: "Running scoped qualification",
        content: content(PostgresPoolQualificationRun),
      },
      ...errors([400, 401, 403, 404, 409, 500]),
    },
  };
  app.openapi(createRoute(start), async (c) =>
    startPostgresPoolQualification(
      c,
      NodeId.parse(c.req.param("id")),
      PostgresPoolQualificationRequest.parse(await c.req.json()),
    ),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/postgres-pool/qualifications/{id}",
      tags: ["PostgreSQL pool"],
      security: [{ bearerAuth: [] }],
      operationId: "getPostgresPoolQualification",
      summary: "Read measured pool qualification evidence and cleanup",
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: "Run and measured evidence",
          content: content(PostgresPoolQualificationRun),
        },
        ...errors([400, 401, 403, 404, 500]),
      },
    }),
    async (c) =>
      getPostgresPoolQualification(c, z.uuid().parse(c.req.param("id"))),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/postgres-pool/qualifications/{id}/cancel",
      tags: ["PostgreSQL pool"],
      security: [{ bearerAuth: [] }],
      operationId: "cancelPostgresPoolQualification",
      summary: "Cancel measurements while retaining the cleanup reservation",
      request: { params: z.object({ id: z.uuid() }) },
      responses: {
        200: {
          description: "Run awaiting cleanup or immutable ended run",
          content: content(PostgresPoolQualificationRun),
        },
        ...errors([400, 401, 403, 404, 500]),
      },
    }),
    async (c) =>
      cancelPostgresPoolQualification(c, z.uuid().parse(c.req.param("id"))),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/agent/v1/nodes/{id}/postgres-pool/qualification",
      tags: ["PostgreSQL pool"],
      security: [{ AgentBearer: [] }],
      operationId: "getPostgresPoolQualificationInput",
      summary: "Read the current scoped one-use measurement challenge",
      request: { params: z.object({ id: NodeId }) },
      responses: {
        200: {
          description:
            "Current qualification or no run; this grants no writer authority",
          content: content(
            z.strictObject({
              qualification: PostgresPoolQualificationInput.nullable(),
            }),
          ),
        },
        ...errors([400, 401, 404, 409, 500]),
      },
    }),
    async (c) =>
      getPostgresPoolQualificationInput(c, NodeId.parse(c.req.param("id"))),
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/agent/v1/nodes/{id}/postgres-pool/qualification",
      tags: ["PostgreSQL pool"],
      security: [{ AgentBearer: [] }],
      operationId: "reportPostgresPoolQualification",
      summary:
        "Record scoped progress or consume measured qualification evidence",
      request: {
        params: z.object({ id: NodeId }),
        body: {
          required: true,
          content: content(
            z.union([
              PostgresPoolQualificationReport,
              PostgresPoolQualificationProgressReport,
            ]),
          ),
        },
      },
      responses: {
        200: {
          description:
            "Pending progress recorded without consuming the challenge, or measured gate evidence accepted",
          content: content(
            z.union([
              z.strictObject({ recorded: z.literal(true) }),
              z.strictObject({
                accepted: z.literal(true),
                run: PostgresPoolQualificationRun,
              }),
            ]),
          ),
        },
        ...errors([400, 401, 404, 409, 500]),
      },
    }),
    async (c) => {
      const body = z
          .union([
            PostgresPoolQualificationReport,
            PostgresPoolQualificationProgressReport,
          ])
          .parse(await c.req.json()),
        node = NodeId.parse(c.req.param("id"));
      return "progress" in body
        ? recordPostgresPoolQualificationProgress(c, node, body)
        : reportPostgresPoolQualification(c, node, body);
    },
  );
}
