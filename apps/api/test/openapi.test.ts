// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { ErrorBody } from "@pgcf/contracts";
import { NODE_OPERATOR_KUBERNETES_HEADERS } from "@pgcf/contracts/node-operator";
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
    const internalDoc = await document("/internal/v1/openapi.json");
    const docs = [publicDoc, agentDoc, internalDoc];
    expect(
      Object.keys(publicDoc.paths).every(
        (path) =>
          path.startsWith("/v1/") ||
          path === "/healthz" ||
          path === "/fleet-images/v1/raw/{digest}",
      ),
    ).toBe(true);
    expect(
      Object.keys(agentDoc.paths).every((path) => path.startsWith("/agent/")),
    ).toBe(true);
    expect(
      Object.keys(internalDoc.paths).every(
        (path) => path.startsWith("/internal/") || path === "/source-control",
      ),
    ).toBe(true);
    const actual = new Set(
      app.routes
        .filter((route) => methods.has(route.method.toLowerCase()))
        .filter(
          (route) =>
            /^(?:\/v1\/|\/agent\/|\/internal\/)/.test(route.path) ||
            [
              "/healthz",
              "/source-control",
              "/fleet-images/v1/raw/:digest",
            ].includes(route.path),
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
    expect(operation(publicDoc, "/v1/fleet/patches", "get").operationId).toBe(
      "listFleetPatches",
    );
  });

  it("binds the document version to actual Miniflare runtime metadata", async () => {
    const metadata = Reflect.get(
      env,
      "CF_VERSION_METADATA",
    ) as WorkerVersionMetadata;
    expect(metadata?.id).toBeTruthy();
    // Read the built-in binding, never supply a manufactured Worker identity.
    console.info("actual Miniflare version metadata", {
      id: metadata.id,
      tag: metadata.tag,
      timestamp: metadata.timestamp,
    });
    const doc = await document("/v1/openapi.json");
    expect(doc.info.version).toBe(metadata.id);
    expect(doc.info.version).not.toBe("0.0.0");
    expect(doc.info["x-worker-version"]).toEqual(metadata);
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
    const internal = await document("/internal/v1/openapi.json");
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
    const stream = operation(
      publicDoc,
      "/v1/nodes/{id}/operator/kubernetes",
      "get",
    );
    expect(stream.parameters).toContainEqual(
      expect.objectContaining({
        name: "Upgrade",
        in: "header",
        required: true,
      }),
    );
    expect(stream.responses["101"]!.content).toBeUndefined();
    for (const name of Object.values(NODE_OPERATOR_KUBERNETES_HEADERS))
      expect(stream.responses["101"]!.headers).toHaveProperty(name);
    expect(stream.responses).toHaveProperty("400");
    expect(stream.responses).toHaveProperty("401");
    expect(stream.responses).toHaveProperty("403");
    expect(operation(agents, "/agent/v1/desired", "get").security).toEqual([
      { AgentBearer: [] },
    ]);
    expect(
      operation(
        internal,
        "/internal/v1/node-installation/{id}/transport",
        "post",
      ).security,
    ).toEqual([{ CallbackBearer: [] }]);
  });

  it("keeps every local component reference resolvable after scope separation", async () => {
    for (const path of [
      "/v1/openapi.json",
      "/agent/v1/openapi.json",
      "/internal/v1/openapi.json",
    ]) {
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

  it("describes the public raw image handlers without JSON or credential claims", async () => {
    const doc = await document("/v1/openapi.json");
    const get = operation(doc, "/fleet-images/v1/raw/{digest}", "get");
    const head = operation(doc, "/fleet-images/v1/raw/{digest}", "head");
    expect(get.security).toEqual([]);
    expect(get.responses["200"]!.content).toHaveProperty("application/x-xz");
    expect(get.responses["206"]!.headers).toHaveProperty("Content-Range");
    expect(get.responses["404"]!.content).toBeUndefined();
    expect(get.responses["416"]!.content).toBeUndefined();
    expect(head.responses["200"]!.content).toBeUndefined();
    expect(head.responses).not.toHaveProperty("206");
    expect(head.responses).not.toHaveProperty("416");
    expect(Object.keys(doc.paths).some((path) => path.startsWith("/v2/"))).toBe(
      false,
    );
  });

  it("documents supported replay headers and distinct relay refusal boundaries", async () => {
    const management = await document("/v1/openapi.json");
    const agent = await document("/agent/v1/openapi.json");
    const internal = await document("/internal/v1/openapi.json");
    const create = operation(management, "/v1/databases", "post");
    expect(create.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: false }),
    );
    const start = operation(
      management,
      "/v1/nodes/{id}/thin-qualifications",
      "post",
    );
    expect(start.parameters).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", required: true }),
    );
    expect(
      operation(
        management,
        "/v1/fleet/patches/{operation_id}/resume",
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
    expect(
      operation(agent, "/agent/v1/link", "get").responses["426"]!.content,
    ).toHaveProperty("text/plain");
    const byteRelay = operation(
      internal,
      "/internal/v1/fleet-patches/{operation_id}/relay",
      "get",
    );
    expect(
      byteRelay.parameters?.filter((parameter) => parameter.name === "Upgrade"),
    ).toHaveLength(1);
    expect(byteRelay.parameters).toContainEqual(
      expect.objectContaining({ name: "X-PGCF-Bootstrap", required: true }),
    );
    expect(byteRelay.responses["401"]!.content).toHaveProperty("*/*");
    expect(byteRelay.responses["403"]?.content).toHaveProperty(
      "application/json",
    );
    expect(byteRelay.responses["403"]?.content).toHaveProperty("*/*");
    const operatorRelay = operation(
      internal,
      "/internal/v1/infrastructure-backups/{run}/{artifact}/kubernetes",
      "get",
    );
    expect(
      operatorRelay.parameters?.some(
        (parameter) => parameter.name === "X-PGCF-Bootstrap",
      ),
    ).toBe(false);
    expect(operatorRelay.responses).not.toHaveProperty("default");
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
      [management, agent, internal].map((doc) => ({
        operations: operations(doc).length,
        schemas: Object.keys(doc.components?.schemas ?? {}).length,
        bytes: new TextEncoder().encode(JSON.stringify(doc)).length,
      })),
    );
  });

  it("limits callback replies to the outcomes produced by their current actions", async () => {
    const internal = await document("/internal/v1/openapi.json");
    const access = JSON.stringify(
      operation(internal, "/internal/v1/node-proof/{id}/access", "post")
        .responses["200"]!.content,
    );
    expect(access).toContain('"access"');
    expect(access.includes('"scan"')).toBe(false);
    const qualification = JSON.stringify(
      operation(internal, "/internal/v1/thin-qualifications/{id}", "post")
        .responses["200"]!.content,
    );
    expect(qualification).toContain('"running"');
    expect(qualification.includes('"failed"')).toBe(false);
    expect(qualification.includes('"completed"')).toBe(false);
  });
});
