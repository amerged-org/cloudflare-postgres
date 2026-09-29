// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureD1 } from "../src/control-recovery-d1.ts";
import {
  fixture,
  migrationDirectory,
} from "./control-recovery-fixture/fixture.mjs";

const accountId = "a".repeat(32);
const token = "synthetic_test_token_1234567890";

function restConfig(f) {
  const tokenFile = join(f.directory, "d1-read.token");
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return {
    backend: "cloudflare-rest",
    tokenFile,
    accountId,
    migrationDirectory,
    source: f.source,
  };
}

test("captures the complete D1 rowset through the fixed, source-bound REST endpoint", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const config = restConfig(f);
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(
        url,
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${f.source.databaseId}/query`,
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.headers["Content-Type"], "application/json");
      const request = JSON.parse(init.body);
      assert.deepEqual(Object.keys(request), ["sql"]);
      assert.match(request.sql, /^SELECT /);
      assert(Buffer.byteLength(request.sql, "utf8") < 100000);
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [
            {
              success: true,
              meta: {
                served_by_primary: true,
                changed_db: false,
                rows_written: 0,
              },
              results: f.db.prepare(request.sql).all(),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const snapshot = await captureD1(config);
    assert.equal(calls, 1);
    assert.equal(snapshot.source.databaseId, f.source.databaseId);
    assert.equal(
      snapshot.tables.find((table) => table.name === "projects").rows.length,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    f.close();
  }
});

test("redacts provider failure and does not follow a redirect with the token", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const config = restConfig(f);
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(init.redirect, "error");
      return new Response(
        JSON.stringify({ success: false, errors: [{ message: token }] }),
        { status: 401 },
      );
    };
    await assert.rejects(captureD1(config), (error) => {
      assert.equal(error.message, "control_recovery_d1_failed");
      assert(!error.message.includes(token));
      return true;
    });
    assert.equal(calls, 1);
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [{ success: true, results: f.db.prepare(request.sql).all() }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    await assert.rejects(captureD1(config), /control_recovery_d1_failed/);
  } finally {
    globalThis.fetch = originalFetch;
    f.close();
  }
});

test("rejects an oversized D1 REST body while streaming", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  try {
    const config = restConfig(f);
    const chunk = new Uint8Array(1024 * 1024);
    chunk.fill(65);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    let deadline;
    let completed;
    try {
      completed = await Promise.race([
        assert
          .rejects(captureD1(config), /control_recovery_d1_failed/)
          .then(() => true),
        new Promise((resolve) => {
          deadline = setTimeout(() => resolve(false), 1000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    assert.equal(completed, true, "capture must not await stream cancellation");
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
    f.close();
  }
});
