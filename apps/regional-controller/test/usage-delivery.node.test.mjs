import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { UsageClient } from "../src/usage-client.ts";
import { sampleUsage } from "../src/metering.ts";

test("delivers exact provisional facts only after matching acknowledgement and reloads scoped credentials", async () => {
  const identity = {
    regionId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    sourceEpoch: 1,
  };
  const fact = {
    factId: "33333333-3333-4333-8333-333333333333",
    environmentId: "44444444-4444-4444-8444-444444444444",
    sourceId: identity.sourceId,
    sourceEpoch: identity.sourceEpoch,
    revision: 1,
    expectedPreviousRevision: 0,
    metric: "memory_byte_ms",
    attribution: "primary",
    start: "2026-09-28T00:00:00.000Z",
    end: "2026-09-28T00:00:01.000Z",
    quantity: "900719925474099312345",
    status: "provisional",
    evidenceHash: "a".repeat(64),
  };
  const firstToken = `cpmtr_${"a".repeat(43)}`;
  const rotatedToken = `cpmtr_${"b".repeat(43)}`;
  let token = firstToken;
  let responseMode = "matching";
  const requests = [];
  const client = new UsageClient(
    "https://control.example.test",
    identity,
    async () => token,
    async (url, options) => {
      requests.push({ url: String(url), ...options });
      const accepted = {
        ...fact,
        regionId: identity.regionId,
        acceptanceSequence: "9007199254740993",
        acceptedAt: "2026-09-28T00:00:02.000Z",
      };
      if (responseMode === "mismatch") accepted.quantity = "0";
      if (responseMode === "large") {
        return new Response("x".repeat(65_537), {
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ fact: accepted }, { status: 201 });
    },
  );
  assert.equal(await client.send(fact), true);
  assert.equal(JSON.parse(requests[0].body).quantity, fact.quantity);
  assert.equal(requests[0].redirect, "error");
  assert.equal(requests[0].headers.Authorization, `Bearer ${firstToken}`);
  assert.equal(
    requests[0].url,
    `https://control.example.test/v1/regions/${identity.regionId}/usage-facts`,
  );
  responseMode = "mismatch";
  await assert.rejects(client.send(fact), /usage_acknowledgement_conflict/);
  token = rotatedToken;
  responseMode = "matching";
  assert.equal(await client.send(fact), true);
  assert.equal(requests[2].headers.Authorization, `Bearer ${rotatedToken}`);
  responseMode = "large";
  await assert.rejects(client.send(fact), /usage_response_too_large/);
  assert.throws(
    () =>
      new UsageClient(
        "http://control.example.test",
        identity,
        async () => token,
      ),
    /invalid_usage_configuration/,
  );
  await assert.rejects(
    sampleUsage(
      {
        meteringInventory: async () => ({
          namespaces: [],
          clusters: [],
          pods: [],
          pvcs: [],
          pvs: [],
        }),
      },
      {
        knownVolumes() {
          throw new Error("journal_corrupt");
        },
        observe() {},
      },
      identity.regionId,
      () => {},
    ),
    /journal_corrupt/,
  );
  const directory = mkdtempSync(join(tmpdir(), "pgcf-invalid-start-"));
  try {
    const configPath = join(directory, "regional.json");
    const kubePath = join(directory, "kubeconfig.json");
    const tokenPath = join(directory, "region-token");
    const meterPath = join(directory, "meter-token");
    const journalPath = join(directory, "private", "journal.sqlite");
    writeFileSync(
      configPath,
      JSON.stringify({
        operatorNamespace: "cnpg-system",
        operatorPodLabels: {},
        allowedBackupSecrets: [],
      }),
    );
    writeFileSync(
      kubePath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "test",
            cluster: { server: "https://unused.example.invalid" },
          },
        ],
        contexts: [
          { name: "test", context: { cluster: "test", user: "test" } },
        ],
        "current-context": "test",
        users: [{ name: "test", user: { token: "test-only" } }],
      }),
    );
    writeFileSync(tokenPath, `cprgn_${"a".repeat(43)}`);
    writeFileSync(meterPath, firstToken);
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
      {
        timeout: 2000,
        encoding: "utf8",
        env: {
          ...process.env,
          PGCF_CONTROL_ORIGIN: "https://unused.example.invalid",
          PGCF_REGION_ID: identity.regionId,
          PGCF_REGION_TOKEN_FILE: tokenPath,
          PGCF_KUBECONFIG_FILE: kubePath,
          PGCF_REGIONAL_CONFIG_FILE: configPath,
          PGCF_USAGE_SOURCE_ID: identity.sourceId,
          PGCF_USAGE_SOURCE_EPOCH: "1",
          PGCF_METER_TOKEN_FILE: meterPath,
          PGCF_USAGE_JOURNAL_PATH: journalPath,
          PGCF_LEASE_SECONDS: "invalid",
        },
      },
    );
    assert.equal(
      child.status,
      1,
      "invalid settings must exit before starting metering loops",
    );
    assert.match(child.stderr, /regional_controller_failed/);
    assert.equal(
      existsSync(journalPath),
      false,
      "invalid settings must not create a persistent journal",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
