// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  API_CONTRACT_VERSION,
  BackupCatalog,
  DatabaseWithOperation,
  ErrorBody,
  PlacementRegion,
  Role,
  RoleCreate,
} from "@pgcf/contracts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import type { Env } from "../src/env.ts";

type Operation = {
  description?: string;
  summary?: string;
  operationId?: string;
  security?: Record<string, string[]>[];
  parameters?: {
    name?: string;
    in?: string;
    required?: boolean;
    description?: string;
  }[];
  responses: Record<
    string,
    { headers?: Record<string, unknown>; content?: unknown }
  >;
};
type Document = {
  openapi: string;
  info: { version: string; "x-worker-version"?: WorkerVersionMetadata };
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, Record<string, unknown>>;
};
const methods = new Set(["get", "post", "put", "patch", "delete", "head"]);
const request = (path: string) => new Request("https://api.invalid" + path);
async function document(path: string) {
  const response = await createApp().fetch(request(path), env);
  expect(response.status).toBe(200);
  return response.json<Document>();
}
const operations = (doc: Document) =>
  Object.entries(doc.paths).flatMap(([path, values]) =>
    Object.entries(values)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );

function operation(doc: Document, path: string, method: string): Operation {
  const found = doc.paths[path]?.[method];
  expect(found, method + " " + path).toBeDefined();
  return found!;
}

describe("actual generated API references in the Workers runtime", () => {
  it("publishes complete disjoint scopes with explicit unique operation metadata", async () => {
    const app = createApp();
    const publicDoc = await document("/v1/openapi.json");
    const agentDoc = await document("/agent/v1/openapi.json");
    const docs = [publicDoc, agentDoc];
    expect(
      Object.keys(publicDoc.paths).every(
        (path) => path.startsWith("/v1/") || path === "/healthz",
      ),
    ).toBe(true);
    expect(
      Object.keys(agentDoc.paths).every((path) => path.startsWith("/agent/")),
    ).toBe(true);
    const actual = new Set(
      app.routes
        .filter((route) => methods.has(route.method.toLowerCase()))
        .filter(
          (route) =>
            /^(?:\/v1\/|\/agent\/)/.test(route.path) ||
            route.path === "/healthz",
        )
        .map(
          (route) =>
            route.method.toLowerCase() +
            " " +
            route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
        ),
    );
    const declared = docs.flatMap(operations);
    expect(
      new Set(declared.map((route) => route.method + " " + route.path)),
    ).toEqual(actual);
    for (const { operation } of declared) {
      expect(operation.summary?.trim()).toBeTruthy();
      expect(operation.summary).not.toMatch(
        /^(?:GET|POST|PUT|PATCH|DELETE) \/|^(?:Get|Post|Put|Patch|Delete) v1\b/,
      );
      expect(operation.operationId).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
    expect(
      new Set(declared.map(({ operation }) => operation.operationId)).size,
    ).toBe(declared.length);
    expect(operation(publicDoc, "/v1/fleet/releases", "get").operationId).toBe(
      "listFleetReleases",
    );
    // No route outside these two documents remains, and no callback document is served.
    expect(
      app.routes.some(
        (route) =>
          route.path.startsWith("/internal/") ||
          route.path.startsWith("/fleet-images/") ||
          route.path === "/source-control",
      ),
    ).toBe(false);
    expect(
      (await createApp().fetch(request("/internal/v1/openapi.json"), env))
        .status,
    ).toBe(404);
  });

  it("versions the document by its contract and names the deployed Worker beside it", async () => {
    const metadata = Reflect.get(
      env,
      "CF_VERSION_METADATA",
    ) as WorkerVersionMetadata;
    expect(metadata?.id).toBeTruthy();
    for (const path of ["/v1/openapi.json", "/agent/v1/openapi.json"]) {
      const doc = await document(path);
      // A Worker release changes the Worker version; only the contract changes this one.
      expect(doc.info.version, path).toBe(API_CONTRACT_VERSION);
      expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(doc.info.version).not.toBe(metadata.id);
      expect(doc.info["x-worker-version"]).toEqual(metadata);
    }
  });

  it("fails only documentation explicitly when the runtime binding is missing", async () => {
    const missing = Object.create(env) as Env;
    Object.defineProperty(missing, "CF_VERSION_METADATA", { value: undefined });
    const app = createApp();
    const response = await app.fetch(request("/v1/openapi.json"), missing);
    expect(response.status).toBe(500);
    expect(ErrorBody.parse(await response.json()).error.code).toBe("internal");
    const health = await app.fetch(request("/healthz"), missing);
    expect(health.status).toBe(200);
  });

  it("preserves actual JSON headers, scoped auth and WebSocket response semantics", async () => {
    const publicDoc = await document("/v1/openapi.json");
    const agents = await document("/agent/v1/openapi.json");
    const listed = operation(publicDoc, "/v1/databases", "get");
    expect(listed.parameters).toContainEqual(
      expect.objectContaining({
        name: "X-Request-Id",
        in: "header",
        required: false,
      }),
    );
    expect(listed.responses["200"]!.headers).toHaveProperty("X-Request-Id");
    expect(listed.responses["400"]!.headers).toHaveProperty(
      "X-PGCF-Diagnostic-Id",
    );
    expect(listed.responses).not.toHaveProperty("503");
    expect(listed.responses).not.toHaveProperty("409");
    expect(
      operation(publicDoc, "/v1/operational-health", "get").responses,
    ).toHaveProperty("500");
    expect(
      operation(publicDoc, "/v1/databases", "post").responses["202"]!.headers,
    ).toHaveProperty("Location");
    const link = operation(agents, "/agent/v1/link", "get");
    expect(link.parameters).toContainEqual(
      expect.objectContaining({
        name: "Upgrade",
        in: "header",
        required: true,
      }),
    );
    expect(link.responses["101"]!.content).toBeUndefined();
    expect(operation(agents, "/agent/v1/desired", "get").security).toEqual([
      { AgentBearer: [] },
    ]);
  });

  it("keeps every local component reference resolvable after scope separation", async () => {
    for (const path of ["/v1/openapi.json", "/agent/v1/openapi.json"]) {
      const doc = await document(path);
      const visit = (value: unknown): void => {
        if (value === null || typeof value !== "object") return;
        if (
          "$ref" in value &&
          typeof value.$ref === "string" &&
          value.$ref.startsWith("#/")
        ) {
          let selected: unknown = doc;
          for (const key of value.$ref.slice(2).split("/"))
            selected = (selected as Record<string, unknown> | undefined)?.[
              key.replace(/~1/g, "/").replace(/~0/g, "~")
            ];
          expect(selected, value.$ref).toBeDefined();
        }
        for (const child of Object.values(value)) visit(child);
      };
      visit(doc);
    }
  });

  it("documents supported replay headers", async () => {
    const management = await document("/v1/openapi.json");
    const agent = await document("/agent/v1/openapi.json");
    // Creating a database is idempotent by contract and refuses a request without its key.
    const create = operation(management, "/v1/databases", "post");
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: true }),
    );
    // An optional key stays optional where the handler accepts a request without it.
    expect(
      operation(management, "/v1/size-classes/{id}", "put").parameters,
    ).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: false }),
    );
    expect(
      operation(management, "/v1/nodes/additions", "post").parameters,
    ).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: true }),
    );
    expect(
      operation(
        management,
        "/v1/nodes/additions/{id}/approve",
        "post",
      ).parameters?.some((parameter) => parameter.name === "Idempotency-Key"),
    ).toBe(false);
    expect(
      operation(management, "/v1/projects", "post").responses["201"]!.headers,
    ).toHaveProperty("Location");
    expect(
      operation(management, "/v1/databases/{id}/roles", "post").responses[
        "201"
      ]!.headers,
    ).not.toHaveProperty("Location");
    expect(
      operation(management, "/v1/resource-profiles/{id}", "get").responses,
    ).not.toHaveProperty("403");
    expect(operation(management, "/v1/nodes", "get").responses).toHaveProperty(
      "409",
    );
    expect(
      operation(management, "/v1/fleet/releases", "get").responses,
    ).not.toHaveProperty("409");
    // An active addition with a changed retained intent is a conflict even on the dry-run decision.
    expect(
      operation(management, "/v1/regions/{id}/capacity-decision", "get")
        .responses,
    ).toHaveProperty("409");
    expect(
      operation(agent, "/agent/v1/link", "get").responses["426"]!.content,
    ).toHaveProperty("text/plain");
    const keys = operation(management, "/v1/api-keys", "post");
    expect(keys.description).toContain("first administrator key");
    expect(
      keys.parameters?.find((parameter) => parameter.name === "Idempotency-Key")
        ?.description,
    ).toContain("409");
    expect(
      operation(management, "/v1/regions", "post").parameters?.find(
        (parameter) => parameter.name === "Idempotency-Key",
      )?.description,
    ).toContain("409");
    console.info(
      "generated reference measurements",
      [management, agent].map((doc) => ({
        operations: operations(doc).length,
        schemas: Object.keys(doc.components?.schemas ?? {}).length,
        bytes: new TextEncoder().encode(JSON.stringify(doc)).length,
      })),
    );
  });

  it("documents the role lifecycle: attributes, deletion, required keys and the operation kind", async () => {
    const doc = await document("/v1/openapi.json");
    const create = operation(doc, "/v1/databases/{id}/roles", "post");
    const remove = operation(doc, "/v1/databases/{id}/roles/{name}", "delete");
    const reset = operation(
      doc,
      "/v1/databases/{id}/roles/{name}/reset-password",
      "post",
    );
    for (const mutation of [create, remove, reset])
      expect(mutation.parameters).toContainEqual(
        expect.objectContaining({ name: "Idempotency-Key", required: true }),
      );
    // Reading a role never needs one.
    expect(
      operation(doc, "/v1/databases/{id}/roles", "get").parameters?.some(
        (parameter) => parameter.name === "Idempotency-Key",
      ),
    ).toBe(false);
    expect(remove.operationId).toBe("deleteDatabaseRole");
    expect(remove.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(remove.responses).sort()).toEqual([
      "202",
      "400",
      "401",
      "404",
      "409",
      "500",
    ]);
    expect(remove.responses["202"]!.headers).toHaveProperty("Location");
    for (const text of ["NOLOGIN", "role_not_droppable", "hibernated"])
      expect(remove.description, text).toContain(text);
    for (const text of ["valid_until", "connection_limit", "member_of"])
      expect(create.description, text).toContain(text);
    const schemas = doc.components!.schemas as Record<
      string,
      {
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
        enum?: string[];
        examples?: unknown[];
      }
    >;
    const input = schemas.RoleCreate!;
    expect(input.required).toEqual(["name"]);
    expect(Object.keys(input.properties!)).toEqual([
      "name",
      "valid_until",
      "connection_limit",
      "member_of",
      "bypass_rls",
    ]);
    expect(input.properties!.connection_limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 10000,
    });
    expect(input.properties!.member_of).toMatchObject({
      type: "array",
      maxItems: 8,
      uniqueItems: true,
    });
    expect(input.examples?.length).toBeGreaterThan(0);
    const role = schemas.Role!;
    expect(role.required).toEqual(
      expect.arrayContaining([
        "valid_until",
        "connection_limit",
        "member_of",
        "bypass_rls",
      ]),
    );
    expect(role.examples?.length).toBeGreaterThan(0);
    expect(schemas.OperationKind!.enum).toContain("database.role.delete");
    // The examples are copied by integrators, so each must be valid under its own contract.
    const examples = (content: unknown) =>
      Object.values(
        (
          content as Record<
            string,
            { examples?: Record<string, { value: unknown }> }
          >
        )["application/json"]!.examples!,
      ).map((example) => example.value);
    const accepted = examples(remove.responses["202"]!.content);
    expect(accepted).toHaveLength(2);
    for (const value of accepted)
      expect(DatabaseWithOperation.parse(value).operation.kind).toBe(
        "database.role.delete",
      );
    expect(DatabaseWithOperation.parse(accepted[1]).operation.error?.code).toBe(
      "role_not_droppable",
    );
    const created = examples(create.responses["201"]!.content);
    expect(Role.parse(created[0])).toMatchObject({
      name: "report_a1b2c3",
      member_of: ["reader"],
    });
    const requested = examples(
      (create as unknown as { requestBody: { content: unknown } }).requestBody
        .content,
    );
    expect(RoleCreate.parse(requested[0]).name).toBe("report_a1b2c3");
  });

  it("documents the stable refusal reasons, the retry advice and the required keys of database mutations", async () => {
    const doc = await document("/v1/openapi.json");
    const schemas = doc.components!.schemas as Record<
      string,
      { enum?: string[]; properties?: Record<string, unknown> }
    >;
    expect(schemas.ErrorReason!.enum).toEqual(
      expect.arrayContaining([
        "name_in_use",
        "not_ready",
        "mutation_in_progress",
        "generation_changed",
        "role_limit",
        "role_exists",
      ]),
    );
    expect(schemas.ErrorDetails!.properties).toHaveProperty("reason");
    // Every database mutation an integrator repeats names its key as required.
    for (const [path, method] of [
      ["/v1/databases", "post"],
      ["/v1/databases/{id}", "patch"],
      ["/v1/databases/{id}", "delete"],
      ["/v1/databases/{id}/suspend", "post"],
      ["/v1/databases/{id}/resume", "post"],
      ["/v1/databases/{id}/restore", "post"],
      ["/v1/databases/{id}/idle-time", "put"],
    ] as const)
      expect(
        operation(doc, path, method).parameters,
        `${method} ${path}`,
      ).toContainEqual(
        expect.objectContaining({ name: "Idempotency-Key", required: true }),
      );
    // The answers that advise a delay say so in their headers.
    for (const [path, method, status] of [
      ["/v1/databases/{id}", "patch", "409"],
      ["/v1/databases/{id}", "patch", "503"],
      ["/v1/databases/{id}/resume", "post", "409"],
      ["/v1/databases/{id}/roles", "post", "409"],
    ] as const)
      expect(
        operation(doc, path, method).responses[status]!.headers,
        `${method} ${path} ${status}`,
      ).toHaveProperty("Retry-After");
    expect(
      operation(doc, "/v1/databases", "get").responses["400"]!.headers,
    ).not.toHaveProperty("Retry-After");
  });

  it("keeps nullability at the use site and states what the contracts enforce", async () => {
    type Schema = Record<string, unknown> & {
      type?: string | string[];
      allOf?: Schema[];
      anyOf?: Schema[];
      properties?: Record<string, Schema>;
    };
    const nullable = (schema: Schema | undefined) =>
      Array.isArray(schema?.type) && schema!.type.includes("null");
    for (const path of ["/v1/openapi.json", "/agent/v1/openapi.json"]) {
      const doc = await document(path);
      const schemas = (doc.components?.schemas ?? {}) as Record<string, Schema>;
      // A component that is nullable makes every use of it nullable; nullability belongs to the use.
      expect(
        Object.entries(schemas)
          .filter(([, schema]) => nullable(schema))
          .map(([name]) => name),
        path,
      ).toEqual([]);
      // allOf with a reference and a nullable type would reject the null it is meant to allow.
      const offenders: string[] = [];
      const visit = (value: unknown, at: string): void => {
        if (value === null || typeof value !== "object") return;
        const node = value as Schema;
        if (
          Array.isArray(node.allOf) &&
          node.allOf.some((part) => "$ref" in part) &&
          node.allOf.some((part) => nullable(part))
        )
          offenders.push(at);
        for (const [key, child] of Object.entries(node))
          visit(child, `${at}/${key}`);
      };
      visit(doc, "");
      expect(offenders, path).toEqual([]);
    }
    const doc = await document("/v1/openapi.json");
    const schemas = doc.components!.schemas as Record<string, Schema>;
    expect(schemas.ProjectId).toMatchObject({
      type: "string",
      pattern: "^prj_[a-z0-9]{20}$",
    });
    expect(schemas.Database!.properties!.node_id).toEqual({
      anyOf: [{ $ref: "#/components/schemas/NodeId" }, { type: "null" }],
    });
    expect(schemas.Operation!.properties!.completed_at).toEqual({
      anyOf: [{ $ref: "#/components/schemas/Timestamp" }, { type: "null" }],
    });
    expect(schemas.ApiKey!.properties!.project_id).toEqual({
      anyOf: [{ $ref: "#/components/schemas/ProjectId" }, { type: "null" }],
    });
    // The one timestamp form of the API, as the validators enforce it.
    const timestamp = schemas.Timestamp as { pattern?: string };
    expect(
      new RegExp(timestamp.pattern!).test("2026-10-15T09:30:00.000Z"),
    ).toBe(true);
    for (const refused of [
      "2026-10-15T09:30:00Z",
      "2026-10-15T09:30:00.0Z",
      "2026-10-15T09:30:00.000+00:00",
    ])
      expect(new RegExp(timestamp.pattern!).test(refused), refused).toBe(false);
    // A timestamp that carries its own description is inline: it states the pattern itself.
    const inline = (schema: Schema | undefined) =>
      (schema as { pattern?: string }).pattern;
    for (const field of [
      schemas.Role!.properties!.valid_until,
      schemas.RoleCreate!.properties!.valid_until,
      schemas.BackupCatalog!.properties!.earliest_restorable_time,
      schemas.BackupCatalog!.properties!.latest_restorable_time,
      schemas.Database!.properties!.storage!.properties!.observed_at,
      schemas.DatabaseHealth!.properties!.backup!.properties!
        .last_base_backup_at,
    ])
      expect(inline(field)).toBe(timestamp.pattern);
    expect(
      (schemas.ConnectionUri!.properties!.uri as { pattern?: string }).pattern,
    ).toBe("^postgres:\\/\\/");
    expect(schemas.SizeClassUpsert!.properties!.memory_mib).toMatchObject({
      multipleOf: 256,
      minimum: 256,
    });
    // Counters are safe integers, as the contracts bound them.
    expect(schemas.Database!.properties!.generation).toMatchObject({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  it("documents the rules the validators apply beyond the field types", async () => {
    const doc = await document("/v1/openapi.json");
    const schemas = doc.components!.schemas as Record<
      string,
      { description?: string }
    >;
    expect(schemas.ApiKeyCreate!.description).toMatch(
      /integrator.*project_id/s,
    );
    expect(schemas.RoleName!.description).toMatch(/pgcf_maintenance/);
    expect(schemas.SizeClass!.description).toMatch(/cpu_request_millicores/);
    expect(schemas.SizeClassUpsert!.description).toMatch(
      /cpu_request_millicores/,
    );
    const usage = operation(doc, "/v1/usage", "get");
    expect(usage.description).toMatch(/exactly one/);
    expect(usage.description).toMatch(/31 days/);
    const read = operation(doc, "/v1/databases/{id}", "get");
    expect(read.description).toMatch(/desired_state/);
    expect(read.description).toMatch(/deleted/);
    // A database's own idle time is its own resource: its bounds, what null means and the value
    // that applies; PATCH changes the size class alone.
    const idle = operation(doc, "/v1/databases/{id}/idle-time", "put");
    expect(idle.operationId).toBe("setDatabaseIdleTime");
    expect(idle.description).toMatch(/sleep_after_seconds.*60 to 900.*null/s);
    expect(JSON.stringify(idle)).toContain(
      '"#/components/schemas/DatabaseIdleTime"',
    );
    expect(JSON.stringify(idle.responses["200"])).toContain(
      '"#/components/schemas/Database"',
    );
    expect(
      operation(doc, "/v1/databases/{id}", "patch").description ?? "",
    ).not.toMatch(/sleep_after_seconds/);
    const resize = (doc.components!.schemas as Record<string, object>)
      .DatabaseResize!;
    expect(resize).toMatchObject({ required: ["size_class_id"] });
    expect(JSON.stringify(resize)).not.toMatch(/sleep_after_seconds/);
    expect(
      JSON.stringify(
        (doc.components!.schemas as Record<string, unknown>).Database,
      ),
    ).toMatch(
      /effective_sleep_after_seconds.*null when the database is always warm.*\/v1\/databases\/\{id\}\/warm-reclaim/,
    );
    expect(
      operation(doc, "/v1/databases/{id}/archive", "get").summary,
    ).not.toMatch(/status/);
    // There is no resource behind an API key's path to follow.
    expect(
      operation(doc, "/v1/api-keys", "post").responses["201"]!.headers,
    ).not.toHaveProperty("Location");
    // Every keyed mutation says how long its key is kept and what a body may be.
    // The examples are copied by integrators, so each must be valid under its own contract.
    const exampled = doc.components!.schemas as Record<
      string,
      { examples?: unknown[] }
    >;
    expect(
      BackupCatalog.parse(exampled.BackupCatalog!.examples![0]),
    ).toMatchObject({ database_id: "ab12cd34ef56gh78ij90" });
    expect(
      PlacementRegion.parse(exampled.PlacementRegion!.examples![0]),
    ).toMatchObject({ provider_region: "EU" });
    const keyed = operation(doc, "/v1/databases", "post").parameters!.find(
      (parameter) => parameter.name === "Idempotency-Key",
    )!;
    expect(keyed.description).toMatch(/24 hours/);
    const info = (doc as unknown as { info: { description?: string } }).info;
    expect(info.description).toMatch(/64 KiB/);
    expect(info.description).toMatch(/Content-Type: application\/json/);
  });
});
