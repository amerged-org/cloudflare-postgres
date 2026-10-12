// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { BootstrapError } from "../src/bootstrap-error.ts";
import { createBootstrapServer } from "../src/server.ts";
const bearer = randomBytes(32).toString("base64url"),
  headers = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  };
function dailyInput() {
  return {
    run_id: randomUUID(),
    encryption: { kid: "v1", key: randomBytes(32).toString("base64url") },
    artifacts: [
      {
        id: "d1-control",
        kind: "d1",
        day: "2026-10-10",
        region_id: "eu1",
        source_id: randomUUID(),
        node_id: null,
        node_uid: null,
        cluster_uid: null,
        material_revision: null,
        d1_url: "https://exports.example.test/control.sql",
      },
    ],
  };
}
async function listen(runtime: ReturnType<typeof createBootstrapServer>) {
  await new Promise<void>((resolve) =>
    runtime.server.listen(0, "127.0.0.1", resolve),
  );
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
test("daily server authenticates before parsing, returns safe receipts, streams cipher and verifies full readback", async () => {
  const runtime = createBootstrapServer(bearer, {
    request: async () => new Response("CREATE TABLE marker(id INTEGER);\n"),
  });
  const base = await listen(runtime);
  try {
    const refused = await fetch(base + "/v1/infrastructure-backups", {
      method: "POST",
      body: "invalid json",
    });
    assert.equal(refused.status, 401);
    const input = dailyInput();
    const prepared = await fetch(base + "/v1/infrastructure-backups", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    assert.equal(prepared.status, 200);
    const receipt = (await prepared.json()) as Record<string, unknown>[];
    assert.equal(receipt.length, 1);
    assert.equal("private_file" in receipt[0]!, false);
    assert.equal(JSON.stringify(receipt).includes(input.encryption.key), false);
    const stream = await fetch(base + "/v1/infrastructure-backups/d1-control", {
      headers,
    });
    const encrypted = await stream.arrayBuffer();
    const verified = await fetch(
      base + "/v1/infrastructure-backups/d1-control/verify",
      { method: "POST", headers, body: encrypted },
    );
    assert.equal(verified.status, 200);
    assert.equal(
      ((await verified.json()) as { encrypted_bytes: number }).encrypted_bytes,
      encrypted.byteLength,
    );
    const collision = await fetch(base + "/v1/infrastructure-backups", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...input, run_id: randomUUID() }),
    });
    assert.equal(collision.status, 400);
    const otherJob = await fetch(base + "/v1/patches", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(otherJob.status, 400);
  } finally {
    runtime.stop();
  }
});

test("backup failures keep their actual cause under the infrastructure_backup_ prefix the API records", async () => {
  let source = async (): Promise<Response> => {
    throw new BootstrapError("operator_relay_refused");
  };
  const runtime = createBootstrapServer(bearer, { request: () => source() });
  const base = await listen(runtime),
    input = dailyInput();
  const prepare = async (value: unknown) => {
    const response = await fetch(base + "/v1/infrastructure-backups", {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.deepEqual(await prepare(input), {
      status: 400,
      body: { error_code: "infrastructure_backup_operator_relay_refused" },
    });
    // talos-operator rejects with plain errors whose codes preparation passes through.
    source = async () => {
      throw new Error("operator_local_command_failed");
    };
    assert.deepEqual((await prepare(input)).body, {
      error_code: "infrastructure_backup_operator_local_command_failed",
    });
    source = async () => new Response("refused", { status: 403 });
    assert.deepEqual((await prepare(input)).body, {
      error_code: "infrastructure_backup_source_refused",
    });
    assert.deepEqual((await prepare({ ...input, run_id: randomUUID() })).body, {
      error_code: "infrastructure_backup_input_changed",
    });
    const patch = await fetch(base + "/v1/patches", {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.deepEqual(await patch.json(), {
      error_code: "patch_infrastructure_backup_container_only",
    });
  } finally {
    runtime.stop();
  }
});
