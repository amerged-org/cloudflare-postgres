// SPDX-License-Identifier: Apache-2.0
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import {
  BackupCatalog,
  ConnectionUri,
  Database,
  DatabaseCreate,
  DatabaseIdleTime,
  DatabaseResize,
  DatabaseRestore,
  DatabaseRestored,
  DatabaseId,
  DatabaseListQuery,
  DatabaseWithOperation,
  DesiredQuery,
  DesiredResponse,
  ErrorBody,
  IdempotencyKey,
  ListQuery,
  ObservationReport,
  Operation,
  OperationId,
  Role,
  RoleCreate,
  RoleName,
  listEnvelope,
} from "@pgcf/contracts";
import type { ApiApp } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { getAuth } from "../middleware/auth.ts";
import { agentRegion } from "../domain/agent-auth.ts";
import { restoreDatabase } from "../domain/restore.ts";
import { archiveSummary, backupCatalog } from "../domain/archive.ts";
import {
  createDatabase,
  deleteDatabase,
  listDatabaseOperations,
  listDatabases,
  resizeDatabase,
  setDatabaseIdleTime,
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
  deleteRole,
  listRoles,
  resetPassword,
} from "../domain/roles.ts";

const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  400: { description: "Invalid request", content: json(ErrorBody) },
  401: { description: "Invalid credentials", content: json(ErrorBody) },
  403: { description: "Insufficient scope", content: json(ErrorBody) },
  404: { description: "Resource not found", content: json(ErrorBody) },
  409: {
    description:
      "Conflict: error.details.reason names the cause; a Retry-After header marks a refusal that clears by itself",
    content: json(ErrorBody),
  },
  500: { description: "Internal server error", content: json(ErrorBody) },
  503: {
    description: "Capacity unavailable now; retry after the Retry-After delay",
    content: json(ErrorBody),
  },
};
const responses = (schema: z.ZodType, status = 200) => ({
  ...errors,
  [status]: {
    description: status === 202 ? "Operation accepted" : "Successful response",
    content: json(schema),
  },
});
const jsonExample = (schema: z.ZodType, name: string, value: unknown) => ({
  "application/json": { schema, examples: { [name]: { value } } },
});
/** Illustrative values only; they show the shape and are never served as data. */
const exampleDatabase = {
  id: "ab12cd34ef56gh78ij90",
  project_id: "prj_abcdefghij1234567890",
  region_id: "eu-1",
  node_id: "nod_abcdefghij1234567890",
  name: "orders",
  size_class_id: "small",
  resources: { memory_mib: 1024, cpu_millicores: 500, storage_gib: 5 },
  sleep_after_seconds: 300,
  effective_sleep_after_seconds: 300,
  desired_state: "running",
  observed_state: "ready",
  suspension_reason: null,
  generation: 6,
  storage_generation: 1,
  observed_generation: 5,
  status_message: null,
  health: {
    archiving: "ok",
    since: "2030-01-01T09:00:00.000Z",
    backup: { status: "ok", last_base_backup_at: "2030-01-01T03:00:00.000Z" },
    disk: { status: "ok", used_ratio: 0.12 },
  },
  storage: {
    used_bytes: 644245094,
    allocated_bytes: 5368709120,
    observed_at: "2030-01-01T09:29:30.000Z",
  },
  created_at: "2030-01-01T08:00:00.000Z",
  updated_at: "2030-01-01T09:30:00.000Z",
};
const exampleRoleDeletion = {
  database: exampleDatabase,
  operation: {
    id: "op_abcdefghij1234567890",
    kind: "database.role.delete",
    status: "pending",
    project_id: "prj_abcdefghij1234567890",
    database_id: "ab12cd34ef56gh78ij90",
    generation: 6,
    error: null,
    created_at: "2030-01-01T09:30:00.000Z",
    updated_at: "2030-01-01T09:30:00.000Z",
    completed_at: null,
  },
};
const exampleRoleDeletionFailed = {
  ...exampleRoleDeletion,
  operation: {
    ...exampleRoleDeletion.operation,
    status: "failed",
    error: {
      code: "role_not_droppable",
      message:
        "The role owns objects or holds privileges and cannot be dropped; it stays unable to log in until they are removed",
    },
    updated_at: "2030-01-01T09:30:06.000Z",
    completed_at: "2030-01-01T09:30:06.000Z",
  },
};
const exampleRole = {
  database_id: "ab12cd34ef56gh78ij90",
  name: "report_a1b2c3",
  owner: false,
  password_revision: 1,
  created_at: "2030-01-01T09:00:00.000Z",
  updated_at: "2030-01-01T09:00:00.000Z",
  valid_until: "2030-01-01T10:00:00.000Z",
  connection_limit: 5,
  member_of: ["reader"],
  bypass_rls: false,
};
const security = [{ bearerAuth: [] }];
/** Whether a route requires the key is decided by requiredIdempotentPublicRoutes alone. */
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
        query: DatabaseListQuery,
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
      description:
        "Reads one database, a deleted one too: it is answered with 200 and `desired_state: deleted` (`observed_state` is `deleting` until the region has confirmed the removal, then `deleted`). 404 means an unknown ID or a database of another project.",
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
  register(
    app,
    {
      method: "put",
      path: "/v1/databases/{id}/idle-time",
      security,
      tags: ["Databases"],
      description:
        "Sets the database's own idle time before it sleeps (`sleep_after_seconds`, 60 to 900 s); null hands it back to the size class, whose null is always warm. The answer is the database with the `effective_sleep_after_seconds` that now applies. It is accepted in every state but deleted, also while another change is in progress, creates no operation and no new generation, and applies from the next idle check.",
      request: { headers, params, body: body(DatabaseIdleTime) },
      responses: responses(Database),
    },
    async (c) =>
      setDatabaseIdleTime(
        c,
        DatabaseId.parse(c.req.param("id")),
        DatabaseIdleTime.parse(await c.req.json()),
      ),
  );
  register(
    app,
    {
      method: "post",
      path: "/v1/databases/{id}/restore",
      security,
      tags: ["Backups"],
      request: { headers, params, body: body(DatabaseRestore) },
      responses: responses(DatabaseRestored, 202),
    },
    async (c) =>
      restoreDatabase(
        c,
        DatabaseId.parse(c.req.param("id")),
        DatabaseRestore.parse(await c.req.json()),
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
      description:
        "Creates a login role and answers 201 with it. The service generates its password; an integrator key reads it with the connection URI. Optional attributes: `valid_until` (a time in the future, applied at whole seconds, truncated; PostgreSQL's VALID UNTIL: from then on the role cannot log in, and an expired credential does not wake a hibernated database), `connection_limit` (1 to 10000, PostgreSQL's CONNECTION LIMIT), `member_of` (up to 8 other live roles of this database, never `app`, `pgcf_maintenance`, `pg_*` or `cnpg_*`; the role inherits their privileges) and `bypass_rls` (PostgreSQL's BYPASSRLS). A database holds at most 100 roles; a deleted role counts until PostgreSQL has confirmed its removal. The role is registered at once and can connect when the database's `observed_generation` has reached its `generation`. An Idempotency-Key is required; a replay returns the retained result, also after `valid_until` has passed.",
      request: {
        headers,
        params,
        body: {
          required: true,
          content: jsonExample(RoleCreate, "temporary", {
            name: "report_a1b2c3",
            valid_until: "2030-01-01T10:00:00.000Z",
            connection_limit: 5,
            member_of: ["reader"],
          }),
        },
      },
      responses: {
        ...responses(Role, 201),
        201: {
          description: "Role created",
          content: jsonExample(Role, "created", exampleRole),
        },
      },
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
      method: "delete",
      path: "/v1/databases/{id}/roles/{name}",
      security,
      tags: ["Roles"],
      description:
        "Deletes a role. From the moment the request is accepted the role cannot connect: the edge refuses it and it is no longer listed. The answer is 202 with an operation of kind `database.role.delete`. The region sets the role to NOLOGIN, ends its sessions and drops it; the operation succeeds when PostgreSQL has confirmed that. A role that owns objects or holds privileges cannot be dropped: the operation then fails with `role_not_droppable` while the role stays unable to log in; remove those objects, then delete the role again, which starts a new operation. A hibernated database applies the removal at its next wake; the operation succeeds at once, because the role is already unroutable, and deleting the role again once the database runs starts an operation that reports what PostgreSQL did. The owner `app` and the maintenance role cannot be deleted, and neither can a role that other roles are `member_of` until they are deleted. The name can be created again once the removal is confirmed. An Idempotency-Key is required; another request for a role whose removal is in progress returns the same operation.",
      request: { headers, params: roleParams },
      responses: {
        ...responses(DatabaseWithOperation, 202),
        202: {
          description: "Operation accepted",
          content: {
            "application/json": {
              schema: DatabaseWithOperation,
              examples: {
                accepted: { value: exampleRoleDeletion },
                "not droppable": { value: exampleRoleDeletionFailed },
              },
            },
          },
        },
      },
    },
    async (c) =>
      deleteRole(
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
      path: "/v1/databases/{id}/operations",
      security,
      tags: ["Operations"],
      description:
        "Lists every operation of the database, newest first, in the view of `GET /v1/operations/{id}`: the ones you started and the ones PGCF starts itself (idle sleep, wake). A deleted database keeps its operations readable. `limit` is 1 to 100 and `cursor` is the `next_cursor` of the previous page.",
      request: { params, query: ListQuery },
      responses: responses(listEnvelope(Operation)),
    },
    async (c) => listDatabaseOperations(c, DatabaseId.parse(c.req.param("id"))),
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
      path: "/v1/databases/{id}/backups",
      security,
      tags: ["Backups"],
      description:
        "Reads the window a restore can reach and the base backups it can start from, from the catalog the restore path reads. `earliest_restorable_time` is when the oldest restorable base backup finished; `latest_restorable_time` is when the newest archived WAL segment was uploaded, an upper bound. Both are null, with no base backups, while the archive holds no complete base backup with its WAL chain, cannot be read completely, or belongs to a deleted database past its retention. A deleted database inside its retention is read like a live one.",
      request: { params },
      responses: responses(BackupCatalog),
    },
    async (c) => backupCatalog(c, DatabaseId.parse(c.req.param("id"))),
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
      request: { body: body(ObservationReport) },
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
