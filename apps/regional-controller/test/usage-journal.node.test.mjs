import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { UsageJournal } from "../src/usage-journal.ts";

// One real file-backed lifecycle: commit, abrupt process exit, identical replay,
// a bounded outage, exact acknowledgements, and retained regional identity.
test("durably replays exact minute facts and preserves unknown coverage when its buffer fills", () => {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-usage-journal-"));
  const path = join(directory, "usage.sqlite");
  const identity = {
    regionId: "11111111-1111-4111-8111-111111111111",
    sourceId: "22222222-2222-4222-8222-222222222222",
    sourceEpoch: 1,
  };
  const options = {
    maxPendingFacts: 2,
    maxPendingBytes: 4096,
    maxIntervalMilliseconds: 30000,
  };
  const start = Date.parse("2026-09-28T00:00:59.999Z");
  const allocation = {
    key: "pod-uid:cpu",
    environmentId: "33333333-3333-4333-8333-333333333333",
    specHash: "a".repeat(64),
    resourceUid: "pod-uid",
    metric: "cpu_millicore_ms",
    attribution: "primary",
    rate: "9007199254740993",
    evidenceHash: "b".repeat(64),
    continuity: { version: 1, hash: "c".repeat(64) },
  };
  const volume = {
    environmentId: allocation.environmentId,
    regionId: identity.regionId,
    specHash: allocation.specHash,
    namespace: "pgcf-environment",
    namespaceUid: "namespace-uid",
    clusterUid: "cluster-uid",
    pvcName: "database-1",
    pvcUid: "pvc-uid",
    pvName: "database-pv",
    pvUid: "pv-uid",
    storageClass: "regional-local",
    attribution: "primary",
  };
  const snapshot = (observedAt, complete = true) => ({
    observedAt,
    complete,
    allocations: [allocation],
    issues: [],
    volumeBindings: complete ? [volume] : [],
  });
  let journal;
  try {
    const module = new URL("../src/usage-journal.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { UsageJournal } from ${JSON.stringify(module)};
      const journal = new UsageJournal(${JSON.stringify(path)}, ${JSON.stringify(identity)}, ${JSON.stringify(options)});
      journal.beginSession(${start});
      journal.observe(${JSON.stringify(snapshot(start))});
      journal.observe(${JSON.stringify(snapshot(start + 2))});
      // Exit without close(): recovery must come from the committed SQLite WAL.
      process.exit(0);
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.status, 0, child.stderr);
    journal = new UsageJournal(path, identity, options);
    const pending = journal.pending(10);
    assert.equal(
      pending.length,
      2,
      "the committed outbox must survive abrupt exit",
    );
    assert.deepEqual(
      pending.map((fact) => [fact.start, fact.end, fact.quantity, fact.status]),
      [
        [
          new Date(start).toISOString(),
          new Date(start + 1).toISOString(),
          allocation.rate,
          "provisional",
        ],
        [
          new Date(start + 1).toISOString(),
          new Date(start + 2).toISOString(),
          allocation.rate,
          "provisional",
        ],
      ],
    );
    assert.equal(new Set(pending.map((fact) => fact.factId)).size, 2);
    assert.match(pending[0].evidenceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(journal.knownVolumes(), [volume]);
    assert.equal(statSync(path).mode & 0o077, 0);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(path + suffix))
        assert.equal(statSync(path + suffix).mode & 0o077, 0);
    }
    journal.beginSession(start + 10);
    journal.observe(snapshot(start + 20, false));
    journal.observe(snapshot(start + 30));
    assert.deepEqual(
      journal.pending(10),
      pending,
      "capacity pressure cannot rewrite pending evidence",
    );
    assert.equal(journal.status().hasCoverageGaps, true);
    assert.equal(journal.status().provisionalOnly, true);
    assert.ok(
      journal
        .status()
        .gaps.some(
          (gap) =>
            gap.code === "capacity_exceeded" &&
            gap.start <= start + 2 &&
            gap.end >= start + 30,
        ),
    );
    assert.equal(
      journal.acknowledge({ ...pending[0], evidenceHash: "c".repeat(64) }),
      false,
    );
    assert.equal(journal.pending(10).length, 2);
    assert.equal(journal.acknowledge(pending[0]), true);
    assert.equal(
      journal.acknowledge(pending[0]),
      true,
      "matching acknowledgement replay is idempotent",
    );
    journal.close();
    // Lowering the byte cap preserves existing evidence and stops growth.
    journal = new UsageJournal(path, identity, {
      ...options,
      maxPendingBytes: 64,
    });
    assert.deepEqual(journal.pending(10), [pending[1]]);
    assert.equal(journal.acknowledge(pending[0]), true);
    assert.deepEqual(journal.knownVolumes(), [volume]);
    journal.beginSession(start + 40);
    journal.observe(snapshot(start + 50));
    journal.observe(snapshot(start + 60));
    assert.deepEqual(journal.pending(10), [pending[1]]);
    assert.ok(journal.status().pendingBytes > 64);
    assert.ok(BigInt(journal.status().gapCount) > 0n);
    journal.close();
    journal = undefined;
    assert.throws(
      () => new UsageJournal(path, { ...identity, sourceEpoch: 2 }, options),
      /identity_mismatch/,
    );
    journal = new UsageJournal(path, identity, options);
    assert.deepEqual(journal.pending(10), [pending[1]]);
    assert.equal(journal.acknowledge(pending[1]), true);
    assert.equal(journal.pending(10).length, 0);
    assert.equal(
      journal.status().hasCoverageGaps,
      true,
      "delivery cannot erase locally known coverage gaps",
    );
  } finally {
    journal?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
