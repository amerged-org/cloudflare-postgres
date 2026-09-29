// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  chmodSync,
  statSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { UsageJournal } from "../src/usage-journal.ts";
import { snapshotUsageJournal } from "../src/usage-journal-snapshot.ts";
const identity = {
  regionId: "11111111-1111-4111-8111-111111111111",
  sourceId: "22222222-2222-4222-8222-222222222222",
  sourceEpoch: 1,
};
const environmentId = "33333333-3333-4333-8333-333333333333";
const start = Date.parse("2026-09-29T00:00:00.000Z");
const allocation = {
  key: environmentId + ":memory",
  environmentId,
  specHash: "a".repeat(64),
  resourceUid: "pod:postgres",
  metric: "memory_byte_ms",
  attribution: "primary",
  rate: "9007199254740993",
  continuity: { version: 1, hash: "b".repeat(64) },
  evidenceHash: "c".repeat(64),
};
const observation = (observedAt) => ({
  observedAt,
  complete: true,
  allocations: [allocation],
  issues: [],
  volumeBindings: [],
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pgcf-journal-snapshot-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "source.sqlite");
  const journal = new UsageJournal(path, identity);
  journal.beginSession(start);
  journal.observe(observation(start));
  journal.observe(observation(start + 1));
  t.after(() => {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, journal };
}
function logicalState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA temp_store=MEMORY;BEGIN");
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
  const tables = schema.filter((r) => r.type === "table").map((r) => r.name);
  const data = Object.fromEntries(
    tables.map((name) => {
      const stmt = db.prepare(
        'SELECT * FROM "' + name.replaceAll('"', '""') + '"',
      );
      stmt.setReadBigInts(true);
      return [name, stmt.all()];
    }),
  );
  db.exec("COMMIT");
  db.close();
  return { schema, data };
}

test("captures a complete live WAL usage journal without losing pending gaps, historical receipts, exact sequence state or source identity", async (t) => {
  const f = fixture(t);
  const first = f.journal.pending()[0];
  f.journal.acknowledgeAccepted({
    fact: first,
    regionId: identity.regionId,
    organizationId: "44444444-4444-4444-8444-444444444444",
    projectId: "55555555-5555-4555-8555-555555555555",
    acceptanceSequence: "9007199254740993",
    acceptedAt: "2026-09-29T00:01:00.000Z",
  });
  f.journal.observe(observation(start + 2));
  f.journal.observe({
    observedAt: start + 3,
    complete: false,
    allocations: [],
    issues: [{ code: "inventory_unavailable" }],
    volumeBindings: [],
  });
  const writer = new DatabaseSync(f.path);
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer
    .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='usage_outbox'")
    .run(9007199254740993n);
  writer.close();
  const before = logicalState(f.path);
  const target = join(f.dir, "snapshot");
  const result = await snapshotUsageJournal({
    sourcePath: f.path,
    targetDirectory: target,
    expectedIdentity: identity,
  });
  assert.equal(
    result.status,
    "verified_snapshot",
    "missing full-journal snapshot",
  );
  assert.equal(result.activationSupported, false);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  const file = join(target, "usage.sqlite");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(
    createHash("sha256").update(readFileSync(file)).digest("hex"),
    result.sha256,
  );
  assert.deepEqual(logicalState(file), before);
  assert.deepEqual(logicalState(f.path), before);
  const manifest = JSON.parse(
    readFileSync(join(target, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.activationSupported, false);
  assert.deepEqual(manifest.identity, identity);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(statSync(join(target, "manifest.json")).mode & 0o777, 0o600);
  assert.equal(f.journal.acceptedPage(0, 10).records.length, 1);
  assert(f.journal.pending().length > 0);
  assert(f.journal.status().hasCoverageGaps);
});

test("refuses wrong identity, nonprivate source and occupied custody paths without changing the source or any existing artifact", async (t) => {
  const f = fixture(t),
    before = logicalState(f.path);
  const absent = join(f.dir, "absent");
  await assert.rejects(
    snapshotUsageJournal({
      sourcePath: f.path,
      targetDirectory: absent,
      expectedIdentity: { ...identity, sourceEpoch: 2 },
    }),
    /usage_snapshot_failed/,
  );
  assert.equal(existsSync(absent), false);
  chmodSync(f.path, 0o644);
  await assert.rejects(
    snapshotUsageJournal({
      sourcePath: f.path,
      targetDirectory: absent,
      expectedIdentity: identity,
    }),
    /usage_snapshot_failed/,
  );
  assert.equal(existsSync(absent), false);
  chmodSync(f.path, 0o600);
  const occupied = join(f.dir, "occupied");
  writeFileSync(occupied, "existing-custody", { mode: 0o600 });
  await assert.rejects(
    snapshotUsageJournal({
      sourcePath: f.path,
      targetDirectory: occupied,
      expectedIdentity: identity,
    }),
    /usage_snapshot_failed/,
  );
  assert.equal(readFileSync(occupied, "utf8"), "existing-custody");
  assert.deepEqual(logicalState(f.path), before);
});
