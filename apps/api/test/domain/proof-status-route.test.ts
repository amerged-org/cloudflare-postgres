// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newOperationId } from "@pgcf/contracts";
import { NodeProofErrorCode } from "@pgcf/contracts/node-proof";
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
    mode: "preparation",
    session_id: crypto.randomUUID(),
    binding_sha256: bound?.binding.row.binding_sha256 ?? "a".repeat(64),
    plan_sha256: bound?.inspection.network_plan_sha256 ?? "b".repeat(64),
    input_hash: "c".repeat(64),
    status: "failed",
    error_code: "node_proof_scan_failed",
  };
  const proofStatus = vi.fn(async () => status),
    prove = vi.fn(),
    start = vi.fn();
  const idFromName = vi.fn((id: string) => id),
    get = vi.fn(() => ({ proofStatus, prove, start }));
  const bindings = {
    ...env,
    NODE_BOOTSTRAP: { idFromName, get } as unknown as Env["NODE_BOOTSTRAP"],
  };
  const request = async (key: string, mode = "preparation") => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(
        `https://api.invalid/v1/nodes/additions/${operation}/proof/${mode}`,
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
    proofStatus,
    prove,
    start,
    idFromName,
    get,
    request,
  };
}

it("requires administrator scope before proof lookup and returns only typed read-only failure status", async () => {
  const f = await setup();
  expect((await f.request(f.integrator)).status).toBe(403);
  expect((await f.request(f.integrator, "malformed-mode")).status).toBe(403);
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.proofStatus).not.toHaveBeenCalled();
  const response = await f.request(f.admin);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(f.status);
  expect(f.proofStatus).toHaveBeenCalledExactlyOnceWith(
    f.operation,
    "preparation",
  );
  expect(f.idFromName).toHaveBeenCalledExactlyOnceWith(f.operation);
  expect(f.prove).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("returns local not-found for a missing proof binding before any RPC", async () => {
  const f = await setup(false);
  expect((await f.request(f.integrator)).status).toBe(403);
  expect((await f.request(f.admin)).status).toBe(404);
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.proofStatus).not.toHaveBeenCalled();
});

it("publishes the typed administrator proof getter in the generated OpenAPI document", async () => {
  const response = await createApp().fetch(
    new Request("https://api.invalid/v1/openapi.json"),
    env,
  );
  expect(response.status).toBe(200);
  const document = (await response.json()) as {
    paths: Record<
      string,
      {
        get: {
          security: unknown;
          responses: Record<
            string,
            {
              content: Record<
                string,
                {
                  schema: {
                    type: string;
                    properties: Record<string, unknown>;
                    required: string[];
                  };
                }
              >;
            }
          >;
        };
      }
    >;
  };
  const operation =
    document.paths["/v1/nodes/additions/{id}/proof/{mode}"]?.get;
  expect(operation).toBeDefined();
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  const schema =
    operation?.responses["200"]?.content["application/json"]?.schema;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
    [
      "operation_id",
      "mode",
      "session_id",
      "binding_sha256",
      "plan_sha256",
      "input_hash",
      "status",
      "error_code",
    ].sort(),
  );
  expect(schema?.required).toContain("error_code");
  expect(operation?.responses["403"]).toBeDefined();
  expect(operation?.responses["404"]).toBeDefined();
});

it("reads the postjoin mode without dispatching a proof", async () => {
  const f = await setup();
  f.proofStatus.mockResolvedValue({ ...f.status, mode: "postjoin" });
  const response = await f.request(f.admin, "postjoin");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...f.status, mode: "postjoin" });
  expect(f.proofStatus).toHaveBeenCalledExactlyOnceWith(
    f.operation,
    "postjoin",
  );
  expect(f.prove).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("refuses arbitrary diagnostics without exposing their values", async () => {
  const f = await setup(),
    unsafe = "fixture_private_network_body";
  f.proofStatus.mockResolvedValue({ ...f.status, error_code: unsafe });
  const response = await f.request(f.admin);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(unsafe);
  expect(f.prove).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
});

it("bounds proof codes to known failures and known executable exits", () => {
  expect(
    NodeProofErrorCode.safeParse("proof_source_readback_failed").success,
  ).toBe(true);
  expect(NodeProofErrorCode.safeParse("postjoin_wireguard_mode").success).toBe(
    true,
  );
  expect(
    NodeProofErrorCode.safeParse("node_proof_capability_gap_ipv6").success,
  ).toBe(true);
  expect(
    NodeProofErrorCode.safeParse("native_command_failed_kubectl_255").success,
  ).toBe(true);
  expect(
    NodeProofErrorCode.safeParse("native_command_failed_kubectl_256").success,
  ).toBe(false);
  expect(
    NodeProofErrorCode.safeParse("native_command_failed_kubectl_0").success,
  ).toBe(false);
  expect(
    NodeProofErrorCode.safeParse("node_proof_private_network_body").success,
  ).toBe(false);
  expect(
    NodeProofErrorCode.safeParse("proof_source_private_network_body").success,
  ).toBe(false);
});
