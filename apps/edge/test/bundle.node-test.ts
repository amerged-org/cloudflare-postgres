// SPDX-License-Identifier: Apache-2.0
// A fresh isolate parses and evaluates the whole bundle before its first request is answered. On
// 2026-10-20 zod was 472 KB of the Edge's 488 KB, and the first request of a fresh isolate took
// 136 / 513 ms (p50 / p95) against 16 / 42 ms in a reused one. This builds the Edge as it is
// deployed and fails when a validator library comes back or the bundle outgrows its budget.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const edge = resolve(import.meta.dirname, "..");
const wrangler = resolve(edge, "node_modules/wrangler/bin/wrangler.js");
/** The Edge's own code was 27 KB and the zod-free contracts it uses are about as much again. */
const BUNDLE_BUDGET_BYTES = 64 * 1024;

interface Metafile {
  inputs: Record<string, { imports: { path: string }[] }>;
  outputs: Record<string, { bytes: number }>;
}

const isZod = (path: string) => /(^|\/)zod(@[^/]*)?\//.test(path);

test("the Edge bundle holds no zod and stays within its budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-edge-bundle-"));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        wrangler,
        "deploy",
        "--config",
        "wrangler.example.jsonc",
        "--dry-run",
        "--outdir",
        directory,
        "--metafile",
        join(directory, "meta.json"),
      ],
      {
        cwd: edge,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        timeout: 120_000,
      },
    );
    const meta: Metafile = JSON.parse(
      await readFile(join(directory, "meta.json"), "utf8"),
    );
    const importers = Object.entries(meta.inputs)
      .filter(([, input]) => input.imports.some(({ path }) => isZod(path)))
      .map(([path]) => path)
      .filter((path) => !isZod(path));
    assert.equal(
      Object.keys(meta.inputs).filter(isZod).length,
      0,
      `zod is in the Edge bundle; it comes in through ${importers.join(", ")}`,
    );
    const bytes = Object.entries(meta.outputs)
      .filter(([path]) => path.endsWith(".js"))
      .reduce((sum, [, output]) => sum + output.bytes, 0);
    assert.ok(bytes > 0, "the bundle has no JavaScript output");
    assert.ok(
      bytes <= BUNDLE_BUDGET_BYTES,
      `the Edge bundle is ${bytes} bytes; its budget is ${BUNDLE_BUDGET_BYTES}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
