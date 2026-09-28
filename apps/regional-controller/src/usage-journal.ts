// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Allocation,
  AllocationSnapshot,
  RetainedVolumeBinding,
  UsageFact,
  UsageIdentity,
} from "./metering-types.ts";

export interface UsageJournalOptions {
  maxPendingFacts?: number;
  maxPendingBytes?: number;
  maxIntervalMilliseconds?: number;
  maxAllocations?: number;
  maxAcknowledgedFacts?: number;
}
interface Checkpoint {
  allocation_key: string;
  payload_json: string;
  observed_at: number;
  complete: number;
}
interface StoredFact {
  sequence: number;
  fact_id: string;
  payload_json: string;
  payload_hash: string;
  byte_count: number;
  revision: number;
  evidence_hash: string;
}
interface GapRow {
  code: string;
  start_at: number;
  end_at: number;
  occurrences: string;
}
interface State {
  observed_at: number | null;
  complete: number;
  session_id: string | null;
}

const metrics = new Set([
  "cpu_millicore_ms",
  "memory_byte_ms",
  "data_storage_byte_ms",
]);
const attributions = new Set([
  "primary",
  "replica",
  "backup",
  "wal",
  "platform",
]);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const iso = (value: number) => new Date(value).toISOString();
function clock(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999)
    throw new Error("invalid_observation_time");
}
function positive(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error("invalid_journal_limit");
  return value;
}
function privateEntry(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("journal_path_not_private");
}
function validAllocation(allocation: Allocation): boolean {
  return (
    typeof allocation.key === "string" &&
    allocation.key.length > 0 &&
    allocation.key.length <= 512 &&
    uuid.test(allocation.environmentId) &&
    hash.test(allocation.specHash) &&
    typeof allocation.resourceUid === "string" &&
    allocation.resourceUid.length > 0 &&
    allocation.resourceUid.length <= 253 &&
    metrics.has(allocation.metric) &&
    attributions.has(allocation.attribution) &&
    typeof allocation.rate === "string" &&
    /^(?:0|[1-9][0-9]{0,77})$/.test(allocation.rate) &&
    hash.test(allocation.evidenceHash)
  );
}

/**
 * One identity-sealed, file-backed observer journal. Default outbox bounds are
 * 4096 facts/8 MiB; ordinary intervals are at most 30 seconds (and at most two
 * UTC-minute pieces). Full-span unknown ranges are durable coalesced summaries,
 * not unbounded minute backfill. All estimates remain provisional.
 */
export class UsageJournal {
  private readonly path: string;
  private readonly db: DatabaseSync;
  private readonly identity: UsageIdentity;
  private readonly limits: Required<UsageJournalOptions>;
  private sessionId: string | null = null;
  private closed = false;

  constructor(
    path: string,
    identity: UsageIdentity,
    options: UsageJournalOptions = {},
  ) {
    if (
      !uuid.test(identity.regionId) ||
      !uuid.test(identity.sourceId) ||
      !Number.isSafeInteger(identity.sourceEpoch) ||
      identity.sourceEpoch < 1
    )
      throw new Error("invalid_journal_identity");
    if (path === ":memory:" || !path)
      throw new Error("file_backed_journal_required");
    this.path = resolve(path);
    this.identity = { ...identity };
    this.limits = {
      maxPendingFacts: positive(options.maxPendingFacts ?? 4096, 65536),
      maxPendingBytes: positive(
        options.maxPendingBytes ?? 8 * 1024 * 1024,
        256 * 1024 * 1024,
      ),
      maxIntervalMilliseconds: positive(
        options.maxIntervalMilliseconds ?? 30000,
        60000,
      ),
      maxAllocations: positive(options.maxAllocations ?? 4096, 16384),
      maxAcknowledgedFacts: positive(
        options.maxAcknowledgedFacts ?? 1024,
        16384,
      ),
    };
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateEntry(directory, true);
    if (!existsSync(this.path)) {
      const file = openSync(
        this.path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      fsyncSync(file);
      closeSync(file);
      const parent = openSync(directory, constants.O_RDONLY);
      fsyncSync(parent);
      closeSync(parent);
    }
    privateEntry(this.path);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(this.path + suffix)) privateEntry(this.path + suffix);
    this.db = new DatabaseSync(this.path, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=64; PRAGMA auto_vacuum=INCREMENTAL;",
      );
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS journal_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS journal_state (id INTEGER PRIMARY KEY CHECK(id=1), observed_at INTEGER, complete INTEGER NOT NULL, session_id TEXT) STRICT;
        INSERT OR IGNORE INTO journal_state VALUES (1, NULL, 0, NULL);
        CREATE TABLE IF NOT EXISTS allocation_checkpoints (allocation_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL, observed_at INTEGER NOT NULL, complete INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS retained_volumes (pv_uid TEXT PRIMARY KEY, payload_json TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS usage_outbox (sequence INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, byte_count INTEGER NOT NULL, revision INTEGER NOT NULL, evidence_hash TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS usage_acknowledgements (sequence INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, evidence_hash TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS coverage_gaps (code TEXT PRIMARY KEY, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, occurrences TEXT NOT NULL) STRICT;
      `);
      this.transaction(() => {
        const version = this.db
          .prepare("SELECT value FROM journal_meta WHERE name='schema_version'")
          .get() as { value: string } | undefined;
        if (version && version.value !== "1")
          throw new Error("journal_schema_unsupported");
        const sealed = this.db
          .prepare("SELECT value FROM journal_meta WHERE name='identity'")
          .get() as { value: string } | undefined;
        const expected = JSON.stringify(this.identity);
        if (sealed && sealed.value !== expected)
          throw new Error("identity_mismatch");
        this.db
          .prepare(
            "INSERT OR IGNORE INTO journal_meta VALUES ('schema_version','1')",
          )
          .run();
        this.db
          .prepare("INSERT OR IGNORE INTO journal_meta VALUES ('identity',?)")
          .run(expected);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(action: () => T): T {
    if (this.closed) throw new Error("journal_closed");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const result = action();
      this.db.exec("COMMIT");
      committed = true;
      this.permissions();
      return result;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private permissions(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = this.path + suffix;
      if (existsSync(path)) {
        privateEntry(path);
        chmodSync(path, 0o600);
      }
    }
  }
  private state(): State {
    return this.db
      .prepare(
        "SELECT observed_at,complete,session_id FROM journal_state WHERE id=1",
      )
      .get() as unknown as State;
  }
  private checkpoints(): Checkpoint[] {
    return this.db
      .prepare("SELECT * FROM allocation_checkpoints ORDER BY allocation_key")
      .all() as unknown as Checkpoint[];
  }
  private gap(code: string, start: number, end: number): void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(code)) code = "observation_issue";
    let prior = this.db
      .prepare("SELECT * FROM coverage_gaps WHERE code=?")
      .get(code) as unknown as GapRow | undefined;
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM coverage_gaps")
      .get() as { count: number };
    if (!prior && count.count >= 128) {
      code = "additional_issues";
      prior = this.db
        .prepare("SELECT * FROM coverage_gaps WHERE code=?")
        .get(code) as unknown as GapRow | undefined;
    }
    this.db
      .prepare(
        "INSERT INTO coverage_gaps (code,start_at,end_at,occurrences) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,occurrences=excluded.occurrences",
      )
      .run(
        code,
        Math.min(start, end, prior?.start_at ?? start),
        Math.max(start, end, prior?.end_at ?? end),
        (BigInt(prior?.occurrences ?? "0") + 1n).toString(),
      );
  }
  private counts(): { count: number; bytes: number } {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM usage_outbox",
      )
      .get() as unknown as { count: number; bytes: number };
  }
  private enqueue(
    allocation: Allocation,
    start: number,
    end: number,
    status: "provisional" | "gap",
    reason: string,
    currentEvidence?: string,
  ): void {
    if (end <= start) return;
    const evidenceHash = digest(
      JSON.stringify({
        version: "allocation-observation/v1",
        identity: this.identity,
        allocation,
        start,
        end,
        status,
        reason,
        currentEvidence: currentEvidence ?? null,
      }),
    );
    const fact: UsageFact = {
      factId: randomUUID(),
      environmentId: allocation.environmentId,
      sourceId: this.identity.sourceId,
      sourceEpoch: this.identity.sourceEpoch,
      revision: 1,
      expectedPreviousRevision: 0,
      metric: allocation.metric,
      attribution: allocation.attribution,
      start: iso(start),
      end: iso(end),
      quantity:
        status === "provisional"
          ? (BigInt(allocation.rate) * (BigInt(end) - BigInt(start))).toString()
          : null,
      status,
      evidenceHash,
    };
    const payload = JSON.stringify(fact);
    const bytes = Buffer.byteLength(payload, "utf8");
    const pending = this.counts();
    if (
      pending.count >= this.limits.maxPendingFacts ||
      pending.bytes + bytes > this.limits.maxPendingBytes
    ) {
      this.gap("capacity_exceeded", start, end);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO usage_outbox (fact_id,payload_json,payload_hash,byte_count,revision,evidence_hash) VALUES (?,?,?,?,?,?)",
      )
      .run(
        fact.factId,
        payload,
        digest(payload),
        bytes,
        fact.revision,
        fact.evidenceHash,
      );
  }
  private interval(
    allocation: Allocation,
    start: number,
    end: number,
    reason?: string,
    currentEvidence?: string,
  ): void {
    if (end <= start) return;
    const status = reason ? "gap" : "provisional";
    if (reason) this.gap(reason, start, end);
    const firstEnd = Math.min(end, (Math.floor(start / 60000) + 1) * 60000);
    this.enqueue(
      allocation,
      start,
      firstEnd,
      status,
      reason ?? "stable",
      currentEvidence,
    );
    // Normal bounded intervals have at most two pieces. Unknown long spans emit
    // only their first clipped minute; the full range remains in local summary.
    if (!reason && firstEnd < end)
      this.enqueue(
        allocation,
        firstEnd,
        end,
        status,
        "stable",
        currentEvidence,
      );
  }

  beginSession(at: number): void {
    clock(at);
    const session = randomUUID();
    this.transaction(() => {
      const prior = this.state();
      if (prior.observed_at !== null) {
        this.gap("process_restart", prior.observed_at, at);
        if (at < prior.observed_at)
          this.gap("clock_backward", at, prior.observed_at);
        for (const checkpoint of this.checkpoints())
          this.interval(
            JSON.parse(checkpoint.payload_json) as Allocation,
            checkpoint.observed_at,
            at,
            "process_restart",
          );
      }
      this.db.prepare("DELETE FROM allocation_checkpoints").run();
      this.db
        .prepare(
          "UPDATE journal_state SET observed_at=?,complete=0,session_id=? WHERE id=1",
        )
        .run(Math.max(prior.observed_at ?? at, at), session);
    });
    this.sessionId = session;
  }

  observe(snapshot: AllocationSnapshot): void {
    clock(snapshot.observedAt);
    if (
      typeof snapshot.complete !== "boolean" ||
      !Array.isArray(snapshot.allocations) ||
      snapshot.allocations.length > this.limits.maxAllocations ||
      !snapshot.allocations.every(validAllocation) ||
      new Set(snapshot.allocations.map((allocation) => allocation.key)).size !==
        snapshot.allocations.length ||
      !Array.isArray(snapshot.issues) ||
      snapshot.issues.length > 256 ||
      !Array.isArray(snapshot.volumeBindings) ||
      snapshot.volumeBindings.length > this.limits.maxAllocations
    )
      throw new Error("invalid_allocation_snapshot");
    for (const volume of snapshot.volumeBindings) {
      if (
        volume.regionId !== this.identity.regionId ||
        !uuid.test(volume.environmentId) ||
        !hash.test(volume.specHash) ||
        !volume.pvUid ||
        !volume.namespaceUid ||
        !volume.pvcUid ||
        !volume.clusterUid ||
        !volume.storageClass
      )
        throw new Error("invalid_volume_binding");
    }
    this.transaction(() => {
      const state = this.state();
      if (!this.sessionId || state.session_id !== this.sessionId)
        throw new Error("journal_session_replaced");
      const previousTime = state.observed_at ?? snapshot.observedAt;
      const backward = snapshot.observedAt < previousTime;
      const checkpointTime = Math.max(previousTime, snapshot.observedAt);
      if (backward)
        this.gap("clock_backward", snapshot.observedAt, previousTime);
      if (!snapshot.complete)
        this.gap("incomplete_snapshot", previousTime, snapshot.observedAt);
      for (const issue of snapshot.issues)
        this.gap(issue.code, previousTime, snapshot.observedAt);
      const current = new Map(
        snapshot.allocations.map((allocation) => [allocation.key, allocation]),
      );
      for (const checkpoint of this.checkpoints()) {
        const prior = JSON.parse(checkpoint.payload_json) as Allocation;
        const observed = current.get(prior.key);
        let reason: string | undefined;
        if (!observed) reason = "resource_missing";
        else if (!snapshot.complete || !checkpoint.complete)
          reason = "incomplete_snapshot";
        else if (
          snapshot.issues.some(
            (issue) =>
              issue.key === prior.key ||
              issue.environmentId === prior.environmentId ||
              (!issue.key && !issue.environmentId),
          )
        )
          reason = "observation_issue";
        else if (JSON.stringify(prior) !== JSON.stringify(observed))
          reason = "allocation_changed";
        else if (
          snapshot.observedAt - checkpoint.observed_at >
          this.limits.maxIntervalMilliseconds
        )
          reason = "sampling_gap";
        if (!backward)
          this.interval(
            prior,
            checkpoint.observed_at,
            snapshot.observedAt,
            reason,
            observed?.evidenceHash,
          );
      }
      this.db.prepare("DELETE FROM allocation_checkpoints").run();
      const certain =
        snapshot.complete && snapshot.issues.length === 0 && !backward ? 1 : 0;
      const insert = this.db.prepare(
        "INSERT INTO allocation_checkpoints VALUES (?,?,?,?)",
      );
      for (const allocation of snapshot.allocations)
        insert.run(
          allocation.key,
          JSON.stringify(allocation),
          checkpointTime,
          certain,
        );
      if (snapshot.complete) {
        this.db.prepare("DELETE FROM retained_volumes").run();
        const retain = this.db.prepare(
          "INSERT INTO retained_volumes VALUES (?,?)",
        );
        for (const volume of snapshot.volumeBindings)
          retain.run(volume.pvUid, JSON.stringify(volume));
      }
      this.db
        .prepare("UPDATE journal_state SET observed_at=?,complete=? WHERE id=1")
        .run(checkpointTime, certain);
    });
  }

  pending(limit = 32): UsageFact[] {
    positive(limit, 256);
    const rows = this.db
      .prepare("SELECT * FROM usage_outbox ORDER BY sequence LIMIT ?")
      .all(limit) as unknown as StoredFact[];
    return rows.map((row) => {
      if (digest(row.payload_json) !== row.payload_hash)
        throw new Error("journal_evidence_corrupt");
      return JSON.parse(row.payload_json) as UsageFact;
    });
  }
  acknowledge(
    fact: Pick<UsageFact, "factId" | "revision" | "evidenceHash">,
  ): boolean {
    return this.transaction(() => {
      const pending = this.db
        .prepare("SELECT * FROM usage_outbox WHERE fact_id=?")
        .get(fact.factId) as unknown as StoredFact | undefined;
      if (!pending) {
        const prior = this.db
          .prepare(
            "SELECT revision,evidence_hash FROM usage_acknowledgements WHERE fact_id=?",
          )
          .get(fact.factId) as
          { revision: number; evidence_hash: string } | undefined;
        return (
          prior?.revision === fact.revision &&
          prior.evidence_hash === fact.evidenceHash
        );
      }
      if (
        pending.revision !== fact.revision ||
        pending.evidence_hash !== fact.evidenceHash
      )
        return false;
      this.db
        .prepare(
          "INSERT INTO usage_acknowledgements (fact_id,revision,evidence_hash) VALUES (?,?,?)",
        )
        .run(fact.factId, fact.revision, fact.evidenceHash);
      this.db
        .prepare(
          "DELETE FROM usage_outbox WHERE fact_id=? AND revision=? AND evidence_hash=?",
        )
        .run(fact.factId, fact.revision, fact.evidenceHash);
      this.db
        .prepare(
          "DELETE FROM usage_acknowledgements WHERE sequence NOT IN (SELECT sequence FROM usage_acknowledgements ORDER BY sequence DESC LIMIT ?)",
        )
        .run(this.limits.maxAcknowledgedFacts);
      return true;
    });
  }
  knownVolumes(): RetainedVolumeBinding[] {
    return this.db
      .prepare("SELECT payload_json FROM retained_volumes ORDER BY pv_uid")
      .all()
      .map(
        (row) =>
          JSON.parse(row.payload_json as string) as RetainedVolumeBinding,
      );
  }
  status() {
    const pending = this.counts();
    const gaps = this.db
      .prepare("SELECT * FROM coverage_gaps ORDER BY code")
      .all() as unknown as GapRow[];
    return {
      identity: { ...this.identity },
      provisionalOnly: true,
      hasCoverageGaps: gaps.length > 0,
      gapCount: gaps
        .reduce((total, gap) => total + BigInt(gap.occurrences), 0n)
        .toString(),
      gaps: gaps.map((gap) => ({
        code: gap.code,
        start: gap.start_at,
        end: gap.end_at,
        occurrences: gap.occurrences,
      })),
      pendingFacts: pending.count,
      pendingBytes: pending.bytes,
      maxPendingFacts: this.limits.maxPendingFacts,
      maxPendingBytes: this.limits.maxPendingBytes,
      checkpointObservedAt: this.state().observed_at,
    };
  }
  close(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.permissions();
    this.db.close();
    this.closed = true;
  }
}
