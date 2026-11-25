// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { refusal, request } from "./domain/fixtures.ts";

afterEach(() => vi.restoreAllMocks());

const SOURCE = [203, 0, 113, 9].join(".");

// Runs first: the isolate logs its missing binding once, and later tests in this file rely on that
// log being the only one.
it("serves the request, and logs once, while the rate limit binding is missing", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const unbound = { API_RATE_LIMITER: undefined } as never;
    const headers = { "CF-Connecting-IP": SOURCE };
    const first = await request(
      "/v1/projects",
      "unknown-key",
      "GET",
      undefined,
      null,
      headers,
      unbound,
    );
    const second = await request(
      "/v1/projects",
      "unknown-key",
      "GET",
      undefined,
      null,
      headers,
      unbound,
    );
    // The key is read and refused as unknown, not failed as a server error.
    expect(await refusal(first)).toMatchObject({ status: 401 });
    expect(await refusal(second)).toMatchObject({ status: 401 });
    const events = logged.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === "rate_limiter_unbound");
    expect(events).toHaveLength(1);
  } finally {
    logged.mockRestore();
  }
});

it("does not limit the health check or the node link path, even past the source's budget", async () => {
  const limit = vi.fn(async () => ({ success: false }));
  for (const path of ["/healthz", "/node/v1/link"]) {
    const response = await request(
      path,
      "unused",
      "GET",
      undefined,
      null,
      { "CF-Connecting-IP": SOURCE },
      { API_RATE_LIMITER: { limit } } as never,
    );
    expect(response.status, path).toBeLessThan(429);
  }
  expect(limit).not.toHaveBeenCalled();
});

it("limits unauthenticated and installer /node/v1 endpoints", async () => {
  const limit = vi.fn(async () => ({ success: false }));
  const bindings = { API_RATE_LIMITER: { limit } } as never;
  for (const [method, path] of [
    ["GET", "/node/v1/openapi.json"],
    ["GET", "/node/v1/releases/1.0.0/pgcf-agent"],
    ["POST", "/node/v1/enroll"],
    ["POST", "/node/v1/installer/progress"],
  ] as const) {
    const response = await request(
      path,
      "unused",
      method,
      method === "POST" ? {} : undefined,
      null,
      { "CF-Connecting-IP": SOURCE },
      bindings,
    );
    expect(await refusal(response), `${method} ${path}`).toMatchObject({
      status: 429,
      code: "rate_limited",
    });
  }
  expect(limit).toHaveBeenCalledTimes(4);
});

it("refuses a source past its budget before the key is read, and admits the next one", async () => {
  const limit = vi.fn(async () => ({ success: false }));
  const bindings = { API_RATE_LIMITER: { limit } } as never;
  // An unknown key would be refused as unauthorized if the key were read first.
  const refused = await request(
    "/v1/projects",
    "unknown-key",
    "GET",
    undefined,
    null,
    { "CF-Connecting-IP": SOURCE },
    bindings,
  );
  expect(await refusal(refused)).toMatchObject({
    status: 429,
    code: "rate_limited",
  });
  expect(limit).toHaveBeenCalledWith({ key: SOURCE });
  const admitted = await request(
    "/v1/projects",
    "unknown-key",
    "GET",
    undefined,
    null,
    { "CF-Connecting-IP": SOURCE },
    { API_RATE_LIMITER: { limit: async () => ({ success: true }) } } as never,
  );
  expect(await refusal(admitted)).toMatchObject({ status: 401 });
});

it("does not count a request without a source address, such as a service binding's", async () => {
  const limit = vi.fn(async () => ({ success: true }));
  await request("/healthz", "unused", "GET", undefined, null, undefined, {
    API_RATE_LIMITER: { limit },
  } as never);
  expect(limit).not.toHaveBeenCalled();
});
