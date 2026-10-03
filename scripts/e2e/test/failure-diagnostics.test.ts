// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Cloudflare, ManagementApi } from "../src/clients.ts";
import { HarnessError } from "../src/core.ts";
import * as acceptance from "../src/run.ts";
import { main, REQUIRED_ENV, Run } from "../src/run.ts";

function environment(): NodeJS.ProcessEnv {
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const node = "pgcf-node";
  return {
    ...Object.fromEntries(
      REQUIRED_ENV.map((name) => [name, randomBytes(32).toString("hex")]),
    ),
    PGCF_E2E_API_URL: `https://${["pgcf-api", "test", "invalid"].join(".")}/`,
    PGCF_E2E_API_WORKER_NAME: "pgcf-api-dev",
    PGCF_E2E_EDGE_WORKER_NAME: "pgcf-edge-dev",
    PGCF_E2E_CONNECTION_RATE_LIMIT_NAMESPACE_ID: "1",
    PGCF_E2E_DATABASE_RATE_LIMIT_NAMESPACE_ID: "2",
    PGCF_E2E_ENDPOINT_HOST: ["pgcf-edge", "test", "invalid"].join("."),
    PGCF_E2E_REGION_ID: "test-region",
    PGCF_E2E_BACKUP_BUCKET: "pgcf-backup-dev",
    PGCF_E2E_BACKUP_JURISDICTION: "eu",
    PGCF_E2E_NODE_NAMES: JSON.stringify([node]),
    PGCF_E2E_REGIONAL_NAMESPACE: "pgcf-system",
    PGCF_E2E_AGENT_DEPLOYMENT_NAME: "pgcf-agent",
    PGCF_E2E_EXPECTED_NODE_UIDS: JSON.stringify({ [node]: randomUUID() }),
    PGCF_E2E_CREDENTIAL_EXPIRIES: JSON.stringify([
      { name: "CLOUDFLARE_API_TOKEN", expires_at: future },
      { name: "PGCF_E2E_ADMIN_KEY", expires_at: null },
      { name: "PGCF_E2E_PROBE_BEARER", expiry_source: "run" },
      { name: "PGCF_E2E_KUBECONFIG", expires_at: future },
    ]),
  };
}

function diagnostic(error: unknown): unknown {
  return (
    acceptance as unknown as {
      acceptanceDiagnostic(error: unknown): unknown;
    }
  ).acceptanceDiagnostic(error);
}

function probeRun(): Run {
  return Object.assign(Object.create(Run.prototype) as Run, {
    runName: "pgcf-e2e-test",
    c: { values: { PGCF_E2E_PROBE_BEARER: randomBytes(32).toString("hex") } },
    deadline: Date.now() + 60_000,
    verifyIdentity: async () => undefined,
    cf: { request: async () => ({ result: { subdomain: "test" } }) },
  });
}

test("a failing acceptance stage retains its probe failure when cleanup also fails", async (context) => {
  context.mock.method(Run.prototype, "preflight", async function (this: Run) {
    this.state.intents.push("test_intent");
    await this.probe("/metadata");
  });
  for (const method of [
    "verifyIdentity",
    "assertCluster",
    "recoverOwnership",
    "restoreChaos",
    "save",
    "emit",
  ] as const)
    context.mock.method(Run.prototype, method, async () => undefined);
  context.mock.method(Run.prototype, "deleteDatabase", async () => {
    throw new HarnessError("management_http_409");
  });
  context.mock.method(ManagementApi.prototype, "list", async () => []);
  context.mock.method(Cloudflare.prototype, "request", async () => ({
    result: { subdomain: "test" },
  }));
  context.mock.method(Cloudflare.prototype, "list", async () => {
    throw new HarnessError("cloudflare_request_failed");
  });
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "probe_failed" }, { status: 503 }),
  );
  const runId = `${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  await assert.rejects(main(["--run-id", runId], environment()), (error) => {
    assert.equal((error as HarnessError).code, "probe_request_failed");
    assert.deepEqual(diagnostic(error), {
      code: "probe_request_failed",
      stage: "E0",
      http_status: 503,
      probe_code: "probe_failed",
      cleanup: {
        code: "cleanup_incomplete",
        failure_count: 2,
        failures: [
          { stage: "database", code: "management_http_409" },
          { stage: "worker", code: "cloudflare_request_failed" },
        ],
      },
    });
    return true;
  });
});

test("non-JSON probe HTTP failures retain status and exclude arbitrary body text", async (context) => {
  const canary = randomBytes(32).toString("hex");
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(`<html>${canary}</html>`, { status: 502 }),
  );
  await assert.rejects(probeRun().probe("/metadata"), (error) => {
    assert.equal((error as HarnessError).code, "probe_request_failed");
    const result = diagnostic(error);
    assert.deepEqual(result, {
      code: "probe_request_failed",
      http_status: 502,
      probe_code: "unknown",
    });
    assert.equal(JSON.stringify(result).includes(canary), false);
    return true;
  });
});

test("unknown probe codes and provider response fields never reach diagnostics", async (context) => {
  const canary = randomBytes(32).toString("hex");
  context.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { code: canary, message: canary, credential: canary },
      { status: 403, headers: { "X-Test-Credential": canary } },
    ),
  );
  await assert.rejects(probeRun().probe("/metadata"), (error) => {
    assert.deepEqual(diagnostic(error), {
      code: "probe_request_failed",
      http_status: 403,
      probe_code: "unknown",
    });
    return true;
  });
});

test("the supported worker scan error preserves the supplemental-probe requirement", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ code: "worker_scan_unavailable" }, { status: 503 }),
  );
  await assert.rejects(probeRun().probe("/scan"), (error) => {
    assert.deepEqual(diagnostic(error), {
      code: "supplemental_external_tcp_probe_required",
      http_status: 503,
      probe_code: "worker_scan_unavailable",
    });
    return true;
  });
});

test("oversized probe error bodies are cancelled and never parsed for a code", async (context) => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        Buffer.from(
          JSON.stringify({ code: "probe_failed", body: "a".repeat(8192) }),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  context.mock.method(
    globalThis,
    "fetch",
    async () => new Response(body, { status: 500 }),
  );
  await assert.rejects(probeRun().probe("/metadata"), (error) => {
    assert.deepEqual(diagnostic(error), {
      code: "probe_request_failed",
      http_status: 500,
      probe_code: "unknown",
    });
    return true;
  });
  assert.equal(cancelled, true);
});

test("successful cleanup does not erase the original acceptance failure", async (context) => {
  let cleanupCalls = 0;
  context.mock.method(Run.prototype, "preflight", async function (this: Run) {
    this.state.intents.push("test_intent");
    throw new HarnessError("integrator_uri_invalid");
  });
  context.mock.method(Run.prototype, "cleanup", async () => {
    cleanupCalls++;
  });
  const runId = `${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  await assert.rejects(main(["--run-id", runId], environment()), (error) => {
    assert.deepEqual(diagnostic(error), {
      code: "integrator_uri_invalid",
      stage: "E0",
    });
    return true;
  });
  assert.equal(cleanupCalls, 1);
});

test("untyped original and cleanup errors expose no error messages", async (context) => {
  const canary = randomBytes(32).toString("hex");
  context.mock.method(Run.prototype, "preflight", async function (this: Run) {
    this.state.intents.push("test_intent");
    throw new Error(canary);
  });
  context.mock.method(Run.prototype, "cleanup", async () => {
    throw new Error(canary);
  });
  const runId = `${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  await assert.rejects(main(["--run-id", runId], environment()), (error) => {
    assert.deepEqual(diagnostic(error), {
      code: "acceptance_failed",
      stage: "E0",
      cleanup: { code: "acceptance_failed", failure_count: 1 },
    });
    assert.equal(JSON.stringify(diagnostic(error)).includes(canary), false);
    return true;
  });
});

test("configuration errors keep the missing environment names and reject invalid codes", () => {
  assert.deepEqual(
    diagnostic(new HarnessError("missing_environment", ["PGCF_E2E_ADMIN_KEY"])),
    { code: "missing_environment", names: ["PGCF_E2E_ADMIN_KEY"] },
  );
  assert.deepEqual(diagnostic(new HarnessError("error-with-unsafe-text")), {
    code: "acceptance_failed",
  });
});
