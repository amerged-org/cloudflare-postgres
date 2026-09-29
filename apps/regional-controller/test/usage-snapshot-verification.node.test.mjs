// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { UsageJournal } from "../src/usage-journal.ts";
import * as snapshots from "../src/usage-journal-snapshot.ts";

const identity = {
  regionId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceEpoch: 1,
};
const verify =
  snapshots.verifyUsageSnapshot ??
  (async () => ({ status: "verification_not_implemented" }));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-snapshot-verification-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.sqlite");
  const journal = new UsageJournal(sourcePath, identity);
  const start = Date.parse("2026-09-29T00:00:00.000Z");
  journal.beginSession(start);
  journal.observe({
    observedAt: start,
    complete: false,
    allocations: [],
    issues: [{ code: "inventory_unavailable" }],
    volumeBindings: [],
  });
  journal.close();
  const targetDirectory = join(directory, "created");
  const receipt = await snapshots.snapshotUsageJournal({
    sourcePath,
    targetDirectory,
    expectedIdentity: identity,
  });
  const recovered = join(directory, "recovered");
  mkdirSync(recovered, { mode: 0o700 });
  for (const name of ["usage.sqlite", "manifest.json"]) {
    copyFileSync(join(targetDirectory, name), join(recovered, name));
    chmodSync(join(recovered, name), 0o600);
  }
  return {
    directory,
    sourcePath,
    targetDirectory,
    recovered,
    receipt,
    input: {
      snapshotDirectory: recovered,
      expectedIdentity: identity,
      expectedSha256: receipt.sha256,
    },
  };
}

function state(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const path = join(directory, name);
        return [
          name,
          { bytes: readFileSync(path), mode: statSync(path).mode & 0o777 },
        ];
      }),
  );
}

function cli(directory, input) {
  const config = join(directory, "verify.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, ...input }), {
    mode: 0o600,
  });
  return spawnSync(
    process.execPath,
    [
      new URL("../src/main.ts", import.meta.url).pathname,
      "verify-usage-snapshot",
      "--config",
      config,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 60000 },
  );
}

test("verifies a recovered complete snapshot against independent custody without changing its bytes or auxiliary files", async (t) => {
  const f = await fixture(t);
  const before = state(f.recovered);
  const original = state(f.targetDirectory);
  const source = readFileSync(f.sourcePath);
  const result = await verify(f.input);
  assert.equal(result.status, "verified_snapshot_custody");
  assert.equal(result.activationSupported, false);
  assert.equal(result.sha256, f.receipt.sha256);
  assert.equal(result.bytes, f.receipt.bytes);
  assert.equal(result.pendingFacts, f.receipt.pendingFacts);
  assert.deepEqual(Object.keys(result).sort(), [
    "activationSupported",
    "bytes",
    "pendingFacts",
    "sha256",
    "status",
  ]);
  const execution = cli(f.directory, f.input);
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout), result);
  assert.deepEqual(state(f.recovered), before);
  assert.deepEqual(state(f.targetDirectory), original);
  assert.deepEqual(readFileSync(f.sourcePath), source);
});

test("rejects a tampered recovered database even when its local manifest digest is rewritten, without exposing or changing custody", async (t) => {
  const f = await fixture(t);
  const path = join(f.recovered, "usage.sqlite");
  const changed = readFileSync(path);
  changed[changed.length - 1] ^= 1;
  writeFileSync(path, changed);
  const manifestPath = join(f.recovered, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sha256 = sha256(changed);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = state(f.recovered);
  await assert.rejects(verify(f.input), {
    message: "usage_snapshot_verification_failed",
  });
  const execution = cli(f.directory, f.input);
  assert.equal(execution.status, 2);
  assert.deepEqual(JSON.parse(execution.stdout), {
    status: "failed",
    error: { code: "usage_snapshot_verification_failed" },
  });
  assert(!execution.stdout.includes(identity.regionId));
  assert(!execution.stdout.includes(f.recovered));
  assert.deepEqual(state(f.recovered), before);
});
