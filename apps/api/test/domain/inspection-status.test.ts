// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import { recordNodeInstallationInspection } from "../../src/domain/node-installation.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});

async function setup() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  const operation = f.addition.intent.operation_id,
    start = vi.fn(),
    setInactivityTimeout = vi.fn(),
    response = {
      operation_id: operation,
      expected_generation: 0,
      binding_sha256: f.binding.row.binding_sha256,
      network_plan_sha256: f.inspection.network_plan_sha256,
      status: "failed",
      error_code: "inspection_network_mismatch",
    },
    fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe("GET");
      return Response.json(response);
    }),
    container = {
      running: true,
      start,
      setInactivityTimeout,
      getTcpPort: vi.fn(() => ({ fetch })),
    };
  const status = () =>
    runInDurableObject(
      env.NODE_BOOTSTRAP.get(env.NODE_BOOTSTRAP.idFromName(operation)),
      async (_instance, state) => {
        await state.storage.put(
          "inspection_server_binding_sha256",
          f.binding.row.binding_sha256,
        );
        const previous = Object.getOwnPropertyDescriptor(state, "container");
        Object.defineProperty(state, "container", {
          value: container,
          configurable: true,
        });
        try {
          return await (
            new NodeBootstrap(state, f.bindings) as NodeBootstrap & {
              inspectionStatus(id: string): Promise<Record<string, unknown>>;
            }
          ).inspectionStatus(operation);
        } finally {
          if (previous) Object.defineProperty(state, "container", previous);
          else delete (state as { container?: unknown }).container;
        }
      },
    );
  return {
    f,
    operation,
    start,
    setInactivityTimeout,
    response,
    fetch,
    container,
    status,
  };
}

it("reads the existing native inspection failure before a job without starting or registering anything", async () => {
  const f = await setup();
  expect(await f.status()).toEqual({
    operation_id: f.operation,
    inspection_generation: 0,
    binding_sha256: f.response.binding_sha256,
    network_plan_sha256: f.response.network_plan_sha256,
    status: "failed",
    error_code: "inspection_network_mismatch",
    observed_at: null,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const request = f.fetch.mock.calls[0]![0] as Request;
  expect(request.method).toBe("GET");
  expect(new URL(request.url).pathname).toBe(`/v1/inspections/${f.operation}`);
  expect(request.headers.get("Authorization")).toBe(
    `Bearer ${f.f.binding.inspection_token}`,
  );
  expect(request.body).toBeNull();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.setInactivityTimeout).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(f.operation)
      .first("count(*)"),
  ).toBe(0);
});

it("refuses a changed native generation and an arbitrary error body without leaking it or retrying", async () => {
  const f = await setup();
  f.response.expected_generation = 1;
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "inspection_status_invalid",
  });
  f.response.expected_generation = 0;
  const secret = crypto.randomUUID();
  f.response.error_code = secret;
  const invalid = await f.status();
  expect(invalid).toMatchObject({
    status: "unavailable",
    error_code: "inspection_status_invalid",
  });
  expect(JSON.stringify(invalid)).not.toContain(secret);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  f.fetch.mockImplementationOnce(async (request) => {
    expect(request.method).toBe("GET");
    return new Response("x".repeat(2049));
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "inspection_status_invalid",
  });
  expect(f.start).not.toHaveBeenCalled();
});

it("bounds a stalled native fetch without starting work or registering another request", async () => {
  const f = await setup(),
    abort = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(abort.signal);
  let began!: () => void;
  const fetching = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.fetch.mockImplementationOnce(async (request) => {
    expect(request.method).toBe("GET");
    began();
    return new Promise<Response>(() => {});
  });
  const pending = f.status();
  await fetching;
  expect(timeout).toHaveBeenCalledWith(5000);
  abort.abort();
  expect(await pending).toMatchObject({
    status: "unavailable",
    error_code: "inspection_status_unavailable",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.start).not.toHaveBeenCalled();
});

it("serves the accepted D1 observation when the native container is off without claiming node readiness", async () => {
  const f = await setup();
  await recordNodeInstallationInspection(
    f.f.bindings,
    f.operation,
    0,
    f.f.inspection,
  );
  f.container.running = false;
  const status = await f.status();
  expect(status).toMatchObject({
    operation_id: f.operation,
    status: "reported",
    inspection_generation: 1,
    observed_at: f.f.inspection.observed_at,
    error_code: null,
  });
  expect(status).not.toHaveProperty("hardware");
  expect(status).not.toHaveProperty("ready");
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});
