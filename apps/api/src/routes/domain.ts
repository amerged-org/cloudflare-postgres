// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  ConnectionUri,
  Database,
  DatabaseCreate,
  DatabaseResize,
  DatabaseId,
  DatabaseWithOperation,
  DesiredQuery,
  DesiredResponse,
  ErrorBody,
  IdempotencyKey,
  ListQuery,
  ObservationRequest,
  Operation,
  OperationId,
  ProjectId,
  Role,
  RoleCreate,
  RoleName,
  listEnvelope,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { agentRegion } from "../domain/agent-auth.ts";
import { archiveSummary } from "../domain/archive.ts";
import {
  createDatabase,
  deleteDatabase,
  listDatabases,
  resizeDatabase,
} from "../domain/databases.ts";
import { changePower } from "../domain/lifecycle.ts";
import { desired } from "../domain/desired.ts";
import { observations, truncateAgentText } from "../domain/observations.ts";
import {
  databaseForRequest,
  databaseView,
  operationForRequest,
  operationView,
} from "../domain/rows.ts";
import {
  connectionUri,
  createRole,
  listRoles,
  resetPassword,
} from "../domain/roles.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: { description: "Insufficient scope", content: json(ErrorBody) },
  404: { description: "Resource not found", content: json(ErrorBody) },
  409: { description: "Conflict", content: json(ErrorBody) },
  500: { description: "Internal server error", content: json(ErrorBody) },
  503: { description: "Capacity unavailable", content: json(ErrorBody) },
};
const responses = (schema: z.ZodType, status = 200) => ({
  ...errors,
  [status]: {
    description: status === 202 ? "Operation accepted" : "Successful response",
    content: json(schema),
  },
});
const security = [{ bearerAuth: [] }];
const headers = z.object({ "Idempotency-Key": IdempotencyKey.optional() });
const params = z.object({ id: DatabaseId });
const roleParams = z.object({ id: DatabaseId, name: RoleName });
const body = (schema: z.ZodType) => ({ required: true, content: json(schema) });
function register(
  app: ApiApp,
  route: RouteConfig,
  handler: (c: ApiContext) => Promise<Response>,
): void {
  app.openapi(createRoute(route), handler);
}

export function registerDomain(app: ApiApp): void {
  app.use("/agent/v1/observations", async (c, next) => {
    if (c.req.method === "POST" && c.req.raw.body !== null) {
      const value: unknown = await c.req.raw.clone().json();
      if (
        value &&
        typeof value === "object" &&
        "databases" in value &&
        Array.isArray(value.databases)
      )
        for (const db of value.databases)
          if (
            db &&
            typeof db === "object" &&
            "message" in db &&
            typeof db.message === "string"
          )
            db.message = truncateAgentText(db.message);
      c.req.raw = new Request(c.req.raw, { body: JSON.stringify(value) });
    }
    await next();
  });
  register(
    app,
    {
      method: "post",
      path: "/v1/databases",
      security,
      tags: ["Databases"],
      request: { headers, body: body(DatabaseCreate) },
      responses: responses(DatabaseWithOperation, 202),
    },
    async (c) => createDatabase(c, DatabaseCreate.parse(await c.req.json())),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases",
      security,
      tags: ["Databases"],
      request: {
        query: ListQuery.extend({ project_id: ProjectId.optional() }),
      },
      responses: responses(listEnvelope(Database)),
    },
    listDatabases,
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}",
      security,
      tags: ["Databases"],
      request: { params },
      responses: responses(Database),
    },
    async (c) => {
      await getAuth(c);
      return c.json(
        databaseView(
          await databaseForRequest(
            c,
            DatabaseId.parse(c.req.param("id")),
            true,
          ),
        ),
      );
    },
  );
  register(
    app,
    {
      method: "patch",
      path: "/v1/databases/{id}",
      security,
      tags: ["Databases"],
      request: { headers, params, body: body(DatabaseResize) },
      responses: responses(DatabaseWithOperation, 202),
    },
    async (c) =>
      resizeDatabase(
        c,
        DatabaseId.parse(c.req.param("id")),
        DatabaseResize.parse(await c.req.json()),
      ),
  );
  for (const action of ["suspend", "resume"] as const)
    register(
      app,
      {
        method: "post",
        path: `/v1/databases/{id}/${action}`,
        security,
        tags: ["Databases"],
        request: { headers, params },
        responses: responses(DatabaseWithOperation, 202),
      },
      async (c) => changePower(c, DatabaseId.parse(c.req.param("id")), action),
    );
  register(
    app,
    {
      method: "delete",
      path: "/v1/databases/{id}",
      security,
      tags: ["Databases"],
      request: { headers, params },
      responses: responses(DatabaseWithOperation, 202),
    },
    async (c) => deleteDatabase(c, DatabaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/roles",
      security,
      tags: ["Roles"],
      request: { params },
      responses: responses(listEnvelope(Role)),
    },
    async (c) => listRoles(c, DatabaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/roles",
      security,
      tags: ["Roles"],
      request: { headers, params, body: body(RoleCreate) },
      responses: responses(Role, 201),
    },
    async (c) =>
      createRole(
        c,
        DatabaseId.parse(c.req.param("id")),
        RoleCreate.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/roles/{name}/reset-password",
      security,
      tags: ["Roles"],
      request: { headers, params: roleParams },
      responses: responses(Role),
    },
    async (c) =>
      resetPassword(
        c,
        DatabaseId.parse(c.req.param("id")),
        RoleName.parse(c.req.param("name")),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/roles/{name}/connection-uri",
      security,
      tags: ["Roles"],
      request: { params: roleParams },
      responses: responses(ConnectionUri),
    },
    async (c) =>
      connectionUri(
        c,
        DatabaseId.parse(c.req.param("id")),
        RoleName.parse(c.req.param("name")),
      ),
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/operations/{id}",
      security,
      tags: ["Operations"],
      request: { params: z.object({ id: OperationId }) },
      responses: responses(Operation),
    },
    async (c) => {
      await getAuth(c);
      return c.json(
        operationView(
          await operationForRequest(c, OperationId.parse(c.req.param("id"))),
        ),
      );
    },
  );
  register(
    app,
    {
      method: "get",
      path: "/v1/databases/{id}/archive",
      security,
      tags: ["Backups"],
      request: { params },
      responses: responses(
        z
          .object({
            database_id: DatabaseId,
            base_backup_count: z.number().int().nonnegative(),
            wal_count: z.number().int().nonnegative(),
            bytes: z.number().int().nonnegative(),
          })
          .meta({ id: "ArchiveSummary" }),
      ),
    },
    async (c) => archiveSummary(c, DatabaseId.parse(c.req.param("id"))),
  );
  register(
    app,
    {
      method: "get",
      path: "/agent/v1/desired",
      security,
      tags: ["Agent"],
      request: { query: DesiredQuery },
      responses: responses(DesiredResponse),
    },
    async (c) => desired(c, DesiredQuery.parse(c.req.query())),
  );
  register(
    app,
    {
      method: "post",
      path: "/agent/v1/observations",
      security,
      tags: ["Agent"],
      request: { body: body(ObservationRequest) },
      responses: responses(
        z.object({ accepted: z.number().int().nonnegative() }),
      ),
    },
    async (c) => observations(c, await c.req.json()),
  );
  register(
    app,
    {
      method: "get",
      path: "/agent/v1/link",
      security,
      tags: ["Agent"],
      responses: { ...errors, 101: { description: "Agent WebSocket link" } },
    },
    async (c) => {
      const region = await agentRegion(c);
      const stub = c.env.REGION_LINK.get(
        c.env.REGION_LINK.idFromName(region.id),
      );
      return stub.fetch(
        new Request(c.req.raw.url, {
          headers: { Upgrade: c.req.header("Upgrade") ?? "" },
        }),
      );
    },
  );
}
