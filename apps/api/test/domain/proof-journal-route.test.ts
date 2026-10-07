// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newOperationId } from "@pgcf/contracts";
import { NodeProofJournalStatus } from "@pgcf/contracts/node-proof";
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
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: "observed",
    error_code: null,
    journals: [
      {
        key_sha256: "d".repeat(64),
        stage: "cleanup",
        namespace_uid_sha256: "e".repeat(64),
        pod_uid_sha256: null,
        matches_current_session: false,
      },
    ],
  };
  const proofJournalStatus = vi.fn(async () => status),
    prove = vi.fn(),
    start = vi.fn(),
    proofStatus = vi.fn();
  const idFromName = vi.fn((id: string) => id),
    get = vi.fn(() => ({ proofJournalStatus, prove, start, proofStatus }));
  const bindings = {
    ...env,
    NODE_BOOTSTRAP: { idFromName, get } as unknown as Env["NODE_BOOTSTRAP"],
  };
  const request = async (key: string, id = operation) => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(
        `https://api.invalid/v1/nodes/additions/${id}/proof/preparation/journal`,
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
    proofJournalStatus,
    prove,
    start,
    proofStatus,
    idFromName,
    get,
    request,
  };
}

it("checks administrator scope before malformed parameter validation and returns only journal hashes and stages", async () => {
  const f = await setup();
  expect((await f.request(f.integrator)).status).toBe(403);
  expect((await f.request(f.integrator, "malformed-operation")).status).toBe(
    403,
  );
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.proofJournalStatus).not.toHaveBeenCalled();
  const response = await f.request(f.admin);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(f.status);
  expect(f.proofJournalStatus).toHaveBeenCalledExactlyOnceWith(f.operation);
  expect(f.prove).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.proofStatus).not.toHaveBeenCalled();
});

it("returns local binding not-found before journal RPC", async () => {
  const f = await setup(false);
  expect((await f.request(f.admin)).status).toBe(404);
  expect(f.idFromName).not.toHaveBeenCalled();
  expect(f.get).not.toHaveBeenCalled();
  expect(f.proofJournalStatus).not.toHaveBeenCalled();
});

it("publishes the administrator journal path and bounded response in OpenAPI", async () => {
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
                { schema: { properties: Record<string, unknown> } }
              >;
            }
          >;
        };
      }
    >;
  };
  const operation =
    document.paths["/v1/nodes/additions/{id}/proof/preparation/journal"]?.get;
  expect(operation).toBeDefined();
  expect(operation?.security).toEqual([{ bearerAuth: [] }]);
  expect(
    Object.keys(
      operation?.responses["200"]?.content["application/json"]?.schema
        .properties ?? {},
    ).sort(),
  ).toEqual(
    [
      "operation_id",
      "mode",
      "session_id",
      "binding_sha256",
      "plan_sha256",
      "input_hash",
      "issued_at",
      "expires_at",
      "status",
      "error_code",
      "journals",
    ].sort(),
  );
  expect(operation?.responses["403"]).toBeDefined();
  expect(operation?.responses["404"]).toBeDefined();
  const journals = operation?.responses["200"]?.content["application/json"]
    ?.schema.properties.journals as {
    maxItems: number;
    items: { properties: Record<string, unknown> };
  };
  expect(journals.maxItems).toBe(64);
  expect(Object.keys(journals.items.properties).sort()).toEqual(
    [
      "key_sha256",
      "stage",
      "namespace_uid_sha256",
      "pod_uid_sha256",
      "matches_current_session",
    ].sort(),
  );
});

it("rejects raw ownership records without echoing names or bearers", async () => {
  const f = await setup(),
    unsafe = "fixture-private-ownership-data";
  f.proofJournalStatus.mockResolvedValue(
    Object.assign({}, f.status, {
      raw_record: { namespace: unsafe, bearer: unsafe },
    }),
  );
  const response = await f.request(f.admin);
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain(unsafe);
  expect(f.prove).not.toHaveBeenCalled();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.proofStatus).not.toHaveBeenCalled();
});

it("bounds journal entries and rejects private payload fields and unrecognized diagnostic codes", async () => {
  const f = await setup(),
    entry = f.status.journals[0]!;
  expect(
    NodeProofJournalStatus.safeParse({
      ...f.status,
      journals: Array.from({ length: 64 }, () => entry),
    }).success,
  ).toBe(true);
  expect(
    NodeProofJournalStatus.safeParse({
      ...f.status,
      journals: Array.from({ length: 65 }, () => entry),
    }).success,
  ).toBe(false);
  expect(
    NodeProofJournalStatus.safeParse({
      ...f.status,
      journals: [{ ...entry, pod_name: "fixture-private-pod" }],
    }).success,
  ).toBe(false);
  expect(
    NodeProofJournalStatus.safeParse({
      ...f.status,
      error_code: "proof_private_input",
    }).success,
  ).toBe(false);
});
