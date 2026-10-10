// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createBootstrapServer } from "../src/server.ts";
const bearer = randomBytes(32).toString("base64url");
test("daily server authenticates before parsing, returns safe receipts, streams cipher and verifies full readback", async () => {
  const runtime = createBootstrapServer(bearer, {
    request: async () => new Response("CREATE TABLE marker(id INTEGER);\n"),
  });
  await new Promise<void>((resolve) =>
    runtime.server.listen(0, "127.0.0.1", resolve),
  );
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    headers = {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    };
  try {
    const refused = await fetch(base + "/v1/infrastructure-backups", {
      method: "POST",
      body: "invalid json",
    });
    assert.equal(refused.status, 401);
    const input = {
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
