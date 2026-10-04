// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { ErrorBody } from "@pgcf/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApp } from "../src/app.ts";

const diagnosticHeader = "X-PGCF-Diagnostic-Id";
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function request(path: string, init?: RequestInit): Request {
  return new Request(
    new URL(path, `https://${["api", "invalid"].join(".")}`),
    init,
  );
}
function logger() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
function event(log: ReturnType<typeof logger>) {
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toHaveLength(1);
  const parsed = JSON.parse(log.mock.calls[0]![0] as string) as Record<
    string,
    unknown
  >;
  expect(Object.keys(parsed).sort()).toEqual([
    "diagnostic_id",
    "elapsed_ms",
    "event",
    "method",
    "route",
    "status",
  ]);
  expect(parsed.event).toBe("api_request_failed");
  expect(parsed.diagnostic_id).toMatch(uuid);
  expect(typeof parsed.status).toBe("number");
  expect(typeof parsed.elapsed_ms).toBe("number");
  expect(Number.isFinite(parsed.elapsed_ms)).toBe(true);
  expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
  return parsed;
}
afterEach(() => vi.restoreAllMocks());

describe("failed request diagnostics in the Workers runtime", () => {
  it("logs one generated diagnostic for unauthorized requests without caller headers or query data", async () => {
    const log = logger();
    const canary = crypto.randomUUID();
    const response = await createApp().fetch(
      request("/v1/projects", {
        headers: {
          "X-Request-Id": canary,
          [diagnosticHeader]: canary,
          Authorization: `Bearer ${canary}`,
          Cookie: `credential=${canary}`,
        },
      }),
      env,
    );
    expect(response.status).toBe(401);
    const logged = event(log);
    expect(logged.method).toBe("GET");
    expect(logged.route).toBe("/v1/projects");
    expect(logged.status).toBe(401);
    expect(response.headers.get(diagnosticHeader)).toBe(logged.diagnostic_id);
    expect(response.headers.get(diagnosticHeader)).not.toBe(canary);
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    expect(response.headers.get("X-Request-Id")).toBe(canary);
    expect(ErrorBody.parse(await response.json()).error.request_id).toBe(
      canary,
    );
  });

  it("logs the actual matched route template rather than invalid database or role parameters", async () => {
    const log = logger();
    const canary = crypto.randomUUID();
    const response = await createApp().fetch(
      request(
        `/v1/databases/${canary}/roles/${canary}/connection-uri?secret=${canary}`,
      ),
      env,
    );
    expect(response.status).toBe(400);
    const logged = event(log);
    expect(logged.route).toBe("/v1/databases/:id/roles/:name/connection-uri");
    expect(logged.status).toBe(400);
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  });

  it("logs internal failures without exception messages or stacks", async () => {
    const log = logger();
    const canary = crypto.randomUUID();
    const app = createApp();
    app.get("/test/internal", () => {
      throw new Error(canary);
    });
    const response = await app.fetch(
      request(`/test/internal?secret=${canary}`),
      env,
    );
    expect(response.status).toBe(500);
    const logged = event(log);
    expect(logged.route).toBe("unmatched");
    expect(logged.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    expect(ErrorBody.parse(await response.json()).error.code).toBe("internal");
  });

  it("keeps intentional error details in the response while excluding them and body data from diagnostics", async () => {
    const log = logger();
    const canary = crypto.randomUUID();
    const app = createApp();
    app.post("/test/conflict", () => {
      throw new ApiError("conflict", canary, { credential: canary });
    });
    const response = await app.fetch(
      request("/test/conflict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: canary }),
      }),
      env,
    );
    expect(response.status).toBe(409);
    const logged = event(log);
    expect(logged.method).toBe("POST");
    expect(logged.status).toBe(409);
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    expect(ErrorBody.parse(await response.json()).error.details).toEqual({
      credential: canary,
    });
  });

  it("logs malformed and attacker paths only as unmatched and allowlists custom methods", async () => {
    const log = logger();
    const canary = crypto.randomUUID();
    const malicious = request(`/${canary}/%E0%A4%A?secret=${canary}`);
    Object.defineProperty(malicious, "method", {
      value: "LEAK" + canary.replaceAll("-", ""),
    });
    const response = await createApp().fetch(malicious, env);
    expect(response.status).toBeGreaterThanOrEqual(400);
    const logged = event(log);
    expect(logged.route).toBe("unmatched");
    expect(logged.method).toBe("OTHER");
    expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  });

  it("generates separate diagnostic IDs on repeated failures without replaying client identity", async () => {
    const log = logger();
    const app = createApp();
    const first = await app.fetch(request("/missing"), env);
    const second = await app.fetch(request("/missing"), env);
    expect(log).toHaveBeenCalledTimes(2);
    expect(first.headers.get(diagnosticHeader)).toMatch(uuid);
    expect(second.headers.get(diagnosticHeader)).toMatch(uuid);
    expect(first.headers.get(diagnosticHeader)).not.toBe(
      second.headers.get(diagnosticHeader),
    );
  });

  it("keeps successful health, redirect and once-only admin credential responses silent", async () => {
    const log = logger();
    const app = createApp();
    app.get("/test/redirect", (c) => c.redirect("/healthz"));
    const health = await app.fetch(request("/healthz"), env);
    expect(health.status).toBe(200);
    expect(health.headers.get(diagnosticHeader)).toMatch(uuid);
    const redirect = await app.fetch(request("/test/redirect"), env);
    expect(redirect.status).toBe(302);
    await env.DB.prepare("DELETE FROM api_keys").run();
    const response = await app.fetch(
      request("/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.BOOTSTRAP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "test-admin", scope: "admin" }),
      }),
      env,
    );
    expect(response.status).toBe(201);
    const body = await response.json<{ key: string }>();
    expect(body.key).toBeTruthy();
    expect(response.headers.get(diagnosticHeader)).toMatch(uuid);
    expect(log).not.toHaveBeenCalled();
  });
});
