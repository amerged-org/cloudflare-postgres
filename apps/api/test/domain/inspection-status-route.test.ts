// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newOperationId } from "@pgcf/contracts";
import { NodeInstallationInspectionErrorCode } from "@pgcf/contracts/node-installation";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
  for (const region of regions.splice(0)) {
    await env.DB.prepare(
      "DELETE FROM node_installation_bindings WHERE region_id=?",
    )
      .bind(region)
      .run();
    await env.DB.prepare(
      "DELETE FROM node_installation_profiles WHERE region_id=?",
    )
      .bind(region)
      .run();
  }
  await cleanupFixtures();
});

async function setup(withBinding = true) {
  const bound = withBinding ? await boundInstallationFixture() : null,
    f = bound?.fixture ?? (await fixture()),
    operation = bound?.addition.intent.operation_id ?? newOperationId();
  if (bound) regions.push(f.region);
  const status = {
    operation_id: operation,
    inspection_generation: bound?.binding.row.inspection_generation ?? 0,
    binding_sha256: bound?.binding.row.binding_sha256 ?? "a".repeat(64),
    network_plan_sha256:
      bound?.inspection.network_plan_sha256 ?? "b".repeat(64),
    status: "failed",
    error_code: "inspection_host_key_mismatch",
    observed_at: null,
  };
  const inspectionStatus = vi.fn(async () => status),
    inspect = vi.fn(),
    start = vi.fn();
  const idFromName = vi.fn((id: string) => id),
    get = vi.fn(() => ({ inspectionStatus, inspect, start }));
  const bindings = {
    ...env,
    NODE_BOOTSTRAP: { idFromName, get } as unknown as Env["NODE_BOOTSTRAP"],
  };
  const request = async (key: string) => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(
        `https://api.invalid/v1/nodes/additions/${operation}/inspection`,
        { headers: { Authorization: `Bearer ${key}` } },
      ),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };
  return {
    ...f,
    operation,
    status,
    inspectionStatus,
    inspect,
    start,
    idFromName,
    get,
    request,
  };
}

it("requires administrator scope before inspection RPC and returns only read-only typed failure status", async () => {
  const f = await setup();
  const denied = await f.request(f.integrator);
  expect(denied.status).toBe(403);
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.inspectionStatus).not.toHaveBeenCalled();
  const response = await f.request(f.admin);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(f.status);
  expect(f.inspectionStatus).toHaveBeenCalledExactlyOnceWith(f.operation);
  expect(f.idFromName).toHaveBeenCalledExactlyOnceWith(f.operation);
  expect(f.get).toHaveBeenCalledExactlyOnceWith(f.operation);
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("returns a local not-found response for a genuinely missing binding before any inspection RPC", async () => {
  const f = await setup(false);
  expect((await f.request(f.integrator)).status).toBe(403);
  const response = await f.request(f.admin);
  expect(response.status).toBe(404);
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.inspectionStatus).not.toHaveBeenCalled();
});

it("refuses unrecognized native diagnostics without exposing their values", async () => {
  const f = await setup();
  const unsafe = "fixture_private_native_message";
  f.inspectionStatus.mockResolvedValue({ ...f.status, error_code: unsafe });
  const response = await f.request(f.admin);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(unsafe);
  expect(f.inspect).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("accepts only fixed inspection codes and bounded known executable exit codes", () => {
  expect(
    NodeInstallationInspectionErrorCode.safeParse("inspection_report_unknown")
      .success,
  ).toBe(true);
  expect(
    NodeInstallationInspectionErrorCode.safeParse(
      "native_command_failed_ssh_255",
    ).success,
  ).toBe(true);
  expect(
    NodeInstallationInspectionErrorCode.safeParse(
      "native_command_failed_ssh_256",
    ).success,
  ).toBe(false);
  expect(
    NodeInstallationInspectionErrorCode.safeParse("native_command_failed_ssh_0")
      .success,
  ).toBe(false);
  expect(
    NodeInstallationInspectionErrorCode.safeParse(
      "native_command_failed_password_1",
    ).success,
  ).toBe(false);
  expect(
    NodeInstallationInspectionErrorCode.safeParse("arbitrary_native_message")
      .success,
  ).toBe(false);
});
