// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createTestHarness } from "wrangler";

test("the complete production entry loads in workerd and serves health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-edge-entry-"));
  const server = createTestHarness({
    root: directory,
    workers: [
      {
        config: {
          name: "pgcf-edge-entry-test",
          main: resolve(import.meta.dirname, "../src/index.ts"),
          compatibility_date: "2026-10-02",
        },
      },
    ],
  });
  try {
    await server.listen();
    const response = await server.getWorker().fetch("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
