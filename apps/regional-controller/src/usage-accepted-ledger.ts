// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeAcceptedUsageReceipt,
  usageFactFields,
  validUsageFact,
} from "./accepted-usage.ts";
import type {
  AcceptedUsageReceipt,
  UsageFact,
  UsageIdentity,
} from "./metering-types.ts";

export interface AcceptedLedgerLimits {
  maxAcceptedFacts: number;
  maxAcceptedBytes: number;
  maxArchiveBytes: number;
}
export interface AcceptedRecord {
  sequence: number;
  receipt: AcceptedUsageReceipt;
  payloadJson: string;
  payloadHash: string;
  receiptHash: string;
}
export interface AcceptedArchive {
  path: string;
  sha256: string;
  records: number;
  throughSequence: number;
  archiveId: string;
}
interface StoredReceipt {
  sequence: number;
  fact_id: string;
  revision: number;
  payload_json: string;
  payload_hash: string;
  receipt_json: string;
  receipt_hash: string;
  byte_count: number;
  acceptance_sequence: string;
}
interface PendingFact {
  fact_id: string;
  revision: number;
  evidence_hash: string;
  payload_json: string;
  payload_hash: string;
  byte_count: number;
}
interface ArchiveBundle {
  schemaVersion: 1;
  kind: "pgcf-accepted-usage";
  identity: UsageIdentity;
  previousArchive: AcceptedArchive | null;
  records: AcceptedRecord[];
  manifest: {
    archiveId: string;
    fromSequence: number;
    throughSequence: number;
    records: number;
    receiptSetHash: string;
  };
}
type Transaction = <T>(action: () => T) => T;
const hash = /^[a-f0-9]{64}$/;
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value);
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
function localSequence(value: unknown, zero = false): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (zero ? 0 : 1)
  );
}
function pageLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256)
    throw new Error("invalid_accepted_page_limit");
}
function sameFact(left: UsageFact, right: UsageFact): boolean {
  return usageFactFields.every((field) => left[field] === right[field]);
}
function privateStat(stat: Stats, directory = false): void {
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("accepted_archive_not_private");
}
function directorySync(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Accepted evidence is immutable until an operator publishes a verified archive.
// Archive checkpoints are bounded to one row; each bundle links its predecessor.
export class AcceptedUsageLedger {
  private readonly db: DatabaseSync;
  private readonly identity: UsageIdentity;
  private readonly journalPath: string;
  private readonly limits: AcceptedLedgerLimits;
  private readonly transaction: Transaction;
  constructor(
    db: DatabaseSync,
    identity: UsageIdentity,
    journalPath: string,
    limits: AcceptedLedgerLimits,
    transaction: Transaction,
  ) {
    this.db = db;
    this.identity = Object.freeze({ ...identity });
    this.journalPath = journalPath;
    this.limits = Object.freeze({ ...limits });
    this.transaction = transaction;
  }

  initialize(previousVersion: string | undefined): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS usage_accepted_receipts (" +
        "sequence INTEGER PRIMARY KEY AUTOINCREMENT,fact_id TEXT NOT NULL,revision INTEGER NOT NULL," +
        "payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL," +
        "byte_count INTEGER NOT NULL CHECK(byte_count>0),acceptance_sequence TEXT NOT NULL UNIQUE," +
        "UNIQUE(fact_id,revision)) STRICT;" +
        "CREATE TRIGGER IF NOT EXISTS usage_accepted_receipt_immutable BEFORE UPDATE ON usage_accepted_receipts " +
        "BEGIN SELECT RAISE(ABORT,'accepted receipt is immutable'); END;",
    );
    if (previousVersion === "1")
      this.db
        .prepare(
          "INSERT INTO journal_meta (name,value) VALUES ('accepted_history',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run(json({ legacyReceiptHistory: "unknown" }));
    else
      this.db
        .prepare(
          "INSERT OR IGNORE INTO journal_meta (name,value) VALUES ('accepted_history',?)",
        )
        .run(json({ legacyReceiptHistory: "none" }));
    this.history();
  }
  private history(): { legacyReceiptHistory: "unknown" | "none" } {
    const row = this.db
      .prepare("SELECT value FROM journal_meta WHERE name='accepted_history'")
      .get() as { value: string } | undefined;
    const value: unknown = row ? JSON.parse(row.value) : null;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("legacyReceiptHistory" in value) ||
      !["unknown", "none"].includes(value.legacyReceiptHistory as string)
    )
      throw new Error("accepted_history_corrupt");
    return {
      legacyReceiptHistory: value.legacyReceiptHistory as "unknown" | "none",
    };
  }
  markLegacyAcknowledgement(): void {
    this.db
      .prepare("UPDATE journal_meta SET value=? WHERE name='accepted_history'")
      .run(json({ legacyReceiptHistory: "unknown" }));
  }
  private assertIdentity(): void {
    const sealed = this.db
      .prepare("SELECT value FROM journal_meta WHERE name='identity'")
      .get() as { value: string } | undefined;
    if (!sealed || sealed.value !== json(this.identity))
      throw new Error("accepted_identity_conflict");
  }
  private lastArchive(): AcceptedArchive | null {
    const row = this.db
      .prepare(
        "SELECT value FROM journal_meta WHERE name='accepted_last_archive'",
      )
      .get() as { value: string } | undefined;
    if (!row) return null;
    const value: unknown = JSON.parse(row.value);
    if (!this.validArchive(value))
      throw new Error("accepted_archive_checkpoint_corrupt");
    return value;
  }
  private validArchive(value: unknown): value is AcceptedArchive {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).length === 5 &&
      typeof record.path === "string" &&
      isAbsolute(record.path) &&
      record.path === resolve(record.path) &&
      record.path.length <= 4096 &&
      typeof record.sha256 === "string" &&
      hash.test(record.sha256) &&
      typeof record.archiveId === "string" &&
      hash.test(record.archiveId) &&
      localSequence(record.throughSequence) &&
      typeof record.records === "number" &&
      Number.isSafeInteger(record.records) &&
      record.records > 0 &&
      record.records <= 256
    );
  }
  private decode(row: StoredReceipt): AcceptedRecord {
    if (
      !localSequence(row.sequence) ||
      digest(row.payload_json) !== row.payload_hash ||
      digest(row.receipt_json) !== row.receipt_hash ||
      row.byte_count !==
        byteLength(row.payload_json) + byteLength(row.receipt_json)
    )
      throw new Error("accepted_evidence_corrupt");
    const receipt = normalizeAcceptedUsageReceipt(
      JSON.parse(row.receipt_json),
      this.identity,
    );
    const fact: unknown = JSON.parse(row.payload_json);
    if (
      !validUsageFact(fact, this.identity) ||
      !sameFact(fact, receipt.fact) ||
      receipt.fact.factId !== row.fact_id ||
      receipt.fact.revision !== row.revision ||
      receipt.acceptanceSequence !== row.acceptance_sequence ||
      json(receipt) !== row.receipt_json
    )
      throw new Error("accepted_evidence_corrupt");
    return {
      sequence: row.sequence,
      receipt,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash,
      receiptHash: row.receipt_hash,
    };
  }
  counts(): { count: number; bytes: number } {
    return this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(byte_count),0) AS bytes FROM usage_accepted_receipts",
      )
      .get() as { count: number; bytes: number };
  }
  summary() {
    const counts = this.counts(),
      lastArchive = this.lastArchive();
    return {
      acceptedFacts: counts.count,
      acceptedBytes: counts.bytes,
      maxAcceptedFacts: this.limits.maxAcceptedFacts,
      maxAcceptedBytes: this.limits.maxAcceptedBytes,
      acceptedHistory: this.history(),
      ...(lastArchive ? { lastArchive } : {}),
    };
  }
  acknowledge(value: unknown): boolean {
    const receipt = normalizeAcceptedUsageReceipt(value, this.identity);
    const receiptJson = json(receipt),
      receiptHash = digest(receiptJson);
    return this.transaction(() => {
      this.assertIdentity();
      const previous = this.db
        .prepare(
          "SELECT * FROM usage_accepted_receipts WHERE fact_id=? AND revision=?",
        )
        .get(receipt.fact.factId, receipt.fact.revision) as unknown as
        StoredReceipt | undefined;
      if (previous) {
        const record = this.decode(previous);
        if (
          record.receiptHash !== receiptHash ||
          json(record.receipt) !== receiptJson
        )
          throw new Error("accepted_receipt_conflict");
        return true;
      }
      const pending = this.db
        .prepare("SELECT * FROM usage_outbox WHERE fact_id=?")
        .get(receipt.fact.factId) as unknown as PendingFact | undefined;
      if (!pending) return false;
      if (
        digest(pending.payload_json) !== pending.payload_hash ||
        pending.byte_count !== byteLength(pending.payload_json)
      )
        throw new Error("accepted_evidence_corrupt");
      const fact: unknown = JSON.parse(pending.payload_json);
      if (
        !validUsageFact(fact, this.identity) ||
        !sameFact(fact, receipt.fact) ||
        pending.revision !== receipt.fact.revision ||
        pending.evidence_hash !== receipt.fact.evidenceHash
      )
        throw new Error("accepted_receipt_conflict");
      const bytes = byteLength(receiptJson) + pending.byte_count,
        capacity = this.counts();
      if (
        capacity.count >= this.limits.maxAcceptedFacts ||
        capacity.bytes + bytes > this.limits.maxAcceptedBytes
      )
        throw new Error("accepted_capacity_exceeded");
      this.db
        .prepare(
          "INSERT INTO usage_accepted_receipts " +
            "(fact_id,revision,payload_json,payload_hash,receipt_json,receipt_hash,byte_count,acceptance_sequence) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          receipt.fact.factId,
          receipt.fact.revision,
          pending.payload_json,
          pending.payload_hash,
          receiptJson,
          receiptHash,
          bytes,
          receipt.acceptanceSequence,
        );
      const deleted = this.db
        .prepare(
          "DELETE FROM usage_outbox WHERE fact_id=? AND revision=? AND evidence_hash=? AND payload_hash=? AND payload_json=?",
        )
        .run(
          receipt.fact.factId,
          receipt.fact.revision,
          receipt.fact.evidenceHash,
          pending.payload_hash,
          pending.payload_json,
        );
      if (deleted.changes !== 1) throw new Error("accepted_outbox_conflict");
      return true;
    });
  }
  page(afterSequence = 0, limit = 50) {
    this.assertIdentity();
    if (!localSequence(afterSequence, true))
      throw new Error("invalid_accepted_page_sequence");
    pageLimit(limit);
    const rows = this.db
      .prepare(
        "SELECT * FROM usage_accepted_receipts WHERE sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(afterSequence, limit + 1) as unknown as StoredReceipt[];
    const decoded = rows.map((row) => this.decode(row));
    const records = decoded.slice(0, limit),
      lastArchive = this.lastArchive();
    return {
      records,
      nextSequence: decoded.length > limit ? records.at(-1)!.sequence : null,
      history: this.history(),
      ...(lastArchive ? { lastArchive } : {}),
    };
  }
  private archivePath(path: string): string {
    if (!isAbsolute(path) || path.length > 4096)
      throw new Error("accepted_archive_path_invalid");
    const absolute = resolve(path);
    const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
    const journal = join(
      realpathSync(dirname(this.journalPath)),
      basename(this.journalPath),
    );
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (
        absolute === this.journalPath + suffix ||
        canonical === journal + suffix
      )
        throw new Error("accepted_archive_path_conflict");
    privateStat(lstatSync(dirname(absolute)), true);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat) {
      privateStat(stat);
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (!existsSync(this.journalPath + suffix)) continue;
        const journal = lstatSync(this.journalPath + suffix);
        if (stat.dev === journal.dev && stat.ino === journal.ino)
          throw new Error("accepted_archive_path_conflict");
      }
    }
    return absolute;
  }
  private readFile(path: string): Buffer {
    this.archivePath(path);
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = fstatSync(descriptor);
      privateStat(stat);
      if (stat.size > this.limits.maxArchiveBytes)
        throw new Error("accepted_archive_bound");
      const chunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const chunk = Buffer.alloc(
          Math.min(65536, this.limits.maxArchiveBytes - bytes + 1),
        );
        const count = readSync(descriptor, chunk);
        if (count === 0) break;
        bytes += count;
        if (bytes > this.limits.maxArchiveBytes)
          throw new Error("accepted_archive_bound");
        chunks.push(chunk.subarray(0, count));
      }
      fsyncSync(descriptor);
      return Buffer.concat(chunks);
    } finally {
      closeSync(descriptor);
    }
  }
  private fingerprint(records: AcceptedRecord[]): string {
    return digest(
      json(
        records.map((record) => ({
          sequence: record.sequence,
          payloadHash: record.payloadHash,
          receiptHash: record.receiptHash,
        })),
      ),
    );
  }
  private bundle(
    records: AcceptedRecord[],
    previousArchive: AcceptedArchive | null,
  ): ArchiveBundle {
    if (records.length === 0 || records.length > 256)
      throw new Error("accepted_archive_empty");
    const receiptSetHash = this.fingerprint(records);
    const archiveId = digest(
      json({
        kind: "pgcf-accepted-usage",
        schemaVersion: 1,
        identity: this.identity,
        previousArchive,
        receiptSetHash,
      }),
    );
    return {
      schemaVersion: 1,
      kind: "pgcf-accepted-usage",
      identity: { ...this.identity },
      previousArchive,
      records,
      manifest: {
        archiveId,
        fromSequence: records[0]!.sequence,
        throughSequence: records.at(-1)!.sequence,
        records: records.length,
        receiptSetHash,
      },
    };
  }
  private parseBundle(bytes: Buffer): ArchiveBundle {
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error("accepted_archive_invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("accepted_archive_invalid");
    const bundle = value as ArchiveBundle;
    if (
      Object.keys(bundle).length !== 6 ||
      bundle.schemaVersion !== 1 ||
      bundle.kind !== "pgcf-accepted-usage" ||
      json(bundle.identity) !== json(this.identity) ||
      !Array.isArray(bundle.records) ||
      bundle.records.length === 0 ||
      bundle.records.length > 256 ||
      (bundle.previousArchive !== null &&
        !this.validArchive(bundle.previousArchive))
    )
      throw new Error("accepted_archive_identity_conflict");
    let previous = bundle.previousArchive?.throughSequence ?? 0;
    const records = bundle.records.map((record) => {
      if (
        !record ||
        typeof record !== "object" ||
        Object.keys(record).length !== 5 ||
        !localSequence(record.sequence) ||
        record.sequence <= previous ||
        typeof record.payloadJson !== "string" ||
        typeof record.payloadHash !== "string" ||
        !hash.test(record.payloadHash) ||
        digest(record.payloadJson) !== record.payloadHash ||
        typeof record.receiptHash !== "string" ||
        !hash.test(record.receiptHash)
      )
        throw new Error("accepted_archive_evidence_corrupt");
      previous = record.sequence;
      const receipt = normalizeAcceptedUsageReceipt(
        record.receipt,
        this.identity,
      );
      const fact: unknown = JSON.parse(record.payloadJson);
      if (
        digest(json(receipt)) !== record.receiptHash ||
        !validUsageFact(fact, this.identity) ||
        !sameFact(fact, receipt.fact)
      )
        throw new Error("accepted_archive_evidence_corrupt");
      return {
        sequence: record.sequence,
        receipt,
        payloadJson: record.payloadJson,
        payloadHash: record.payloadHash,
        receiptHash: record.receiptHash,
      };
    });
    const expected = this.bundle(records, bundle.previousArchive);
    if (
      json(expected) !== json(bundle) ||
      json(expected) !== bytes.toString("utf8")
    )
      throw new Error("accepted_archive_manifest_conflict");
    return expected;
  }
  private verify(
    path: string,
    expected?: AcceptedArchive,
  ): { bundle: ArchiveBundle; result: AcceptedArchive } {
    const bytes = this.readFile(path),
      bundle = this.parseBundle(bytes);
    const result: AcceptedArchive = {
      path,
      sha256: digest(bytes),
      records: bundle.records.length,
      throughSequence: bundle.manifest.throughSequence,
      archiveId: bundle.manifest.archiveId,
    };
    if (expected && json(result) !== json(expected))
      throw new Error("accepted_archive_checkpoint_conflict");
    return { bundle, result };
  }
  private publish(path: string, bundle: ArchiveBundle): void {
    const bytes = Buffer.from(json(bundle), "utf8");
    if (bytes.length > this.limits.maxArchiveBytes)
      throw new Error("accepted_archive_bound");
    const directory = dirname(path),
      temporary = join(
        directory,
        "." + basename(path) + "." + randomUUID() + ".tmp",
      );
    let descriptor: number | undefined,
      created = false;
    try {
      descriptor = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporary, path);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
        if (digest(this.readFile(path)) !== digest(bytes))
          throw new Error("accepted_archive_file_conflict");
      }
      directorySync(directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (created) {
        unlinkSync(temporary);
        directorySync(directory);
      }
    }
  }
  archive(path: string, limit = 256): AcceptedArchive {
    this.assertIdentity();
    pageLimit(limit);
    const absolute = this.archivePath(path),
      checkpoint = this.lastArchive();
    if (checkpoint?.path === absolute) {
      this.verify(absolute, checkpoint);
      return checkpoint;
    }
    let prepared: { bundle: ArchiveBundle; result: AcceptedArchive };
    if (existsSync(absolute)) {
      prepared = this.verify(absolute);
      if (
        prepared.bundle.records.length > limit ||
        json(prepared.bundle.previousArchive) !== json(checkpoint)
      )
        throw new Error("accepted_archive_batch_conflict");
      directorySync(dirname(absolute));
    } else {
      const rows = this.db
        .prepare(
          "SELECT * FROM usage_accepted_receipts ORDER BY sequence LIMIT ?",
        )
        .all(limit) as unknown as StoredReceipt[];
      const bundle = this.bundle(
        rows.map((row) => this.decode(row)),
        checkpoint,
      );
      this.publish(absolute, bundle);
      prepared = this.verify(absolute);
    }
    return this.transaction(() => {
      this.assertIdentity();
      // Read the durable file again at the retirement boundary. Concurrent
      // appends are harmless; any altered batch/checkpoint aborts the transaction.
      const verified = this.verify(absolute, prepared.result);
      const currentCheckpoint = this.lastArchive();
      if (json(currentCheckpoint) !== json(verified.bundle.previousArchive))
        throw new Error("accepted_archive_checkpoint_conflict");
      const rows = this.db
        .prepare(
          "SELECT * FROM usage_accepted_receipts WHERE sequence<=? ORDER BY sequence LIMIT 257",
        )
        .all(verified.result.throughSequence) as unknown as StoredReceipt[];
      if (rows.length > 256)
        throw new Error("accepted_archive_retirement_bound");
      const records = rows.map((row) => this.decode(row));
      if (json(records) !== json(verified.bundle.records))
        throw new Error("accepted_archive_retirement_conflict");
      for (const record of records) {
        const retired = this.db
          .prepare(
            "DELETE FROM usage_accepted_receipts WHERE sequence=? AND fact_id=? AND revision=? AND payload_hash=? AND receipt_hash=?",
          )
          .run(
            record.sequence,
            record.receipt.fact.factId,
            record.receipt.fact.revision,
            record.payloadHash,
            record.receiptHash,
          );
        if (retired.changes !== 1)
          throw new Error("accepted_archive_retirement_conflict");
      }
      this.db
        .prepare(
          "INSERT INTO journal_meta (name,value) VALUES ('accepted_last_archive',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run(json(verified.result));
      return verified.result;
    });
  }
}
