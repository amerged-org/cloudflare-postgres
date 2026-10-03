// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Cloudflare } from "../src/clients.ts";
import {
  credentialInventory,
  main,
  parseCredentialExpiries,
  REQUIRED_ENV,
} from "../src/run.ts";

const now = Date.UTC(2030, 0, 1);
const future = new Date(now + 3_600_000).toISOString();

function datedInventory() {
  return [
    { name: "CLOUDFLARE_API_TOKEN", expires_at: future },
    { name: "PGCF_E2E_ADMIN_KEY", expires_at: future },
    { name: "PGCF_E2E_PROBE_BEARER", expires_at: future },
    { name: "PGCF_E2E_KUBECONFIG", expires_at: future },
  ];
}

function preflightEnvironment(): NodeJS.ProcessEnv {
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
      { name: "PGCF_E2E_AGENT_KEY", expires_at: null },
      { name: "PGCF_E2E_PROBE_BEARER", expires_at: future },
      { name: "PGCF_E2E_KUBECONFIG", expires_at: future },
    ]),
  };
}

test("E0 preflight accepts explicitly nonexpiring v1 admin and agent keys before provider verification", async (context) => {
  const boundary = new Error("test_provider_boundary");
  let calls = 0;
  context.mock.method(Cloudflare.prototype, "verifyAccount", async () => {
    calls++;
    throw boundary;
  });
  const runId = `${new Date()
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  await assert.rejects(
    main(["--dry-run", "--run-id", runId], preflightEnvironment()),
    (error) => error === boundary,
  );
  assert.equal(calls, 1);
});

test("finite credential expiries retain their shape and normalize valid ISO offsets", () => {
  const entries = datedInventory();
  entries[0]!.expires_at = "2030-01-01T02:00:00+01:00";
  assert.deepEqual(parseCredentialExpiries(entries, now), datedInventory());
  assert.deepEqual(
    credentialInventory(parseCredentialExpiries(entries, now), future, now),
    datedInventory(),
  );
});

test("nonexpiring v1 keys and the run-bound probe keep distinct inventory meanings", () => {
  const entries = [
    { name: "CLOUDFLARE_API_TOKEN", expires_at: future },
    { name: "PGCF_E2E_ADMIN_KEY", expires_at: null },
    { name: "PGCF_E2E_AGENT_KEY", expires_at: null },
    { name: "PGCF_E2E_PROBE_BEARER", expiry_source: "run" },
    { name: "PGCF_E2E_KUBECONFIG", expires_at: future },
  ];
  const parsed = parseCredentialExpiries(entries, now);
  assert.deepEqual(parsed, entries);
  const runExpiry = new Date(now + 7_200_000).toISOString();
  assert.deepEqual(credentialInventory(parsed, runExpiry, now), [
    entries[0],
    entries[1],
    entries[2],
    {
      name: "PGCF_E2E_PROBE_BEARER",
      expiry_source: "run",
      expires_at: runExpiry,
    },
    entries[4],
  ]);
});

test("Cloudflare and kubeclient expiry declarations must remain finite", () => {
  const [cloudflare, admin, probe, kube] = datedInventory();
  assert.throws(
    () =>
      parseCredentialExpiries(
        [{ ...cloudflare, expires_at: null }, admin, probe, kube],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [cloudflare, admin, probe, { ...kube, expires_at: null }],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [cloudflare, admin, probe, { ...kube, expiry_source: "run" }],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
});

test("unknown nonexpiry and ambiguous probe expiry declarations fail closed", () => {
  assert.throws(
    () =>
      parseCredentialExpiries(
        [...datedInventory(), { name: "OTHER_CREDENTIAL", expires_at: null }],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
  const [cloudflare, admin, probe, kube] = datedInventory();
  assert.throws(
    () =>
      parseCredentialExpiries(
        [cloudflare, admin, { ...probe, expires_at: null }, kube],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [cloudflare, admin, { ...probe, expiry_source: "run" }, kube],
        now,
      ),
    { message: "credential_expiry_invalid" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [cloudflare, { name: admin!.name }, probe, kube],
        now,
      ),
    { message: "invalid_response" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [
          ...datedInventory(),
          { name: "OTHER_CREDENTIAL", expires_at: "unknown" },
        ],
        now,
      ),
    { message: "credential_expired" },
  );
});

test("duplicates are refused across dated and nonexpiring declarations", () => {
  assert.throws(
    () =>
      parseCredentialExpiries(
        [...datedInventory(), { name: "PGCF_E2E_ADMIN_KEY", expires_at: null }],
        now,
      ),
    { message: "credential_expiry_duplicate" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries([...datedInventory(), datedInventory()[0]], now),
    { message: "credential_expiry_duplicate" },
  );
});

test("malformed, impossible and expired dates cannot become inventory evidence", () => {
  const [, admin, probe, kube] = datedInventory();
  assert.throws(
    () =>
      parseCredentialExpiries(
        [
          { name: "CLOUDFLARE_API_TOKEN", expires_at: "not-a-date" },
          admin,
          probe,
          kube,
        ],
        now,
      ),
    { message: "credential_expired" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [
          {
            name: "CLOUDFLARE_API_TOKEN",
            expires_at: "2030-02-30T01:00:00.000Z",
          },
          admin,
          probe,
          kube,
        ],
        now,
      ),
    { message: "credential_expired" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [
          { name: "CLOUDFLARE_API_TOKEN", expires_at: "2030-01-02" },
          admin,
          probe,
          kube,
        ],
        now,
      ),
    { message: "credential_expired" },
  );
  assert.throws(
    () =>
      parseCredentialExpiries(
        [
          {
            name: "CLOUDFLARE_API_TOKEN",
            expires_at: new Date(now).toISOString(),
          },
          admin,
          probe,
          kube,
        ],
        now,
      ),
    { message: "credential_expired" },
  );
});

test("the original four required credential names remain mandatory", () => {
  const [cloudflare, admin, probe, kube] = datedInventory();
  assert.throws(() => parseCredentialExpiries([admin, probe, kube], now), {
    message: "credential_expiry_missing",
  });
  assert.throws(() => parseCredentialExpiries([cloudflare, probe, kube], now), {
    message: "credential_expiry_missing",
  });
  assert.throws(() => parseCredentialExpiries([cloudflare, admin, kube], now), {
    message: "credential_expiry_missing",
  });
  assert.throws(
    () => parseCredentialExpiries([cloudflare, admin, probe], now),
    {
      message: "credential_expiry_missing",
    },
  );
});

test("run-bound inventory uses the unchanged finite 24-hour run guard", () => {
  const parsed = parseCredentialExpiries(datedInventory(), now);
  assert.doesNotThrow(() =>
    credentialInventory(parsed, new Date(now + 86_400_000).toISOString(), now),
  );
  assert.throws(
    () =>
      credentialInventory(
        parsed,
        new Date(now + 86_400_001).toISOString(),
        now,
      ),
    { message: "run_expired_cleanup_required" },
  );
  assert.throws(
    () => credentialInventory(parsed, new Date(now).toISOString(), now),
    { message: "run_expired_cleanup_required" },
  );
});
