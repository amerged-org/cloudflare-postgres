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
import { validRunEpoch } from "./run-epoch.ts";
import type {
  AllowanceReceipt,
  AllowanceRequest,
  AllowanceUnits,
  RuntimeAuthority,
  RuntimeBinding,
} from "./allowance-types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const unsigned = /^(?:0|[1-9][0-9]{0,77})$/;
const positive = /^[1-9][0-9]{0,18}$/;
const metrics = new Set([
  "cpu_millicore_ms",
  "memory_byte_ms",
  "data_storage_byte_ms",
]);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const instant = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
export function validAllowanceUnits(value: unknown): value is AllowanceUnits {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 3 &&
    Object.entries(value).every(
      ([key, amount]) =>
        metrics.has(key) && typeof amount === "string" && unsigned.test(amount),
    )
  );
}
function privateEntry(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("allowance_journal_path_not_private");
}
export function validRuntimeBinding(value: RuntimeBinding): boolean {
  return (
    uuid.test(value.regionId) &&
    uuid.test(value.environmentId) &&
    uuid.test(value.projectId) &&
    Number.isSafeInteger(value.specRevision) &&
    value.specRevision > 0 &&
    hash.test(value.specHash) &&
    value.namespace === `pgcf-${value.environmentId.replaceAll("-", "")}` &&
    uuid.test(value.namespaceUid) &&
    uuid.test(value.clusterUid) &&
    uuid.test(value.quotaUid) &&
    (value.runEpoch === undefined || validRunEpoch(value.runEpoch)) &&
    (value.pooler === undefined ||
      (value.pooler !== null &&
        typeof value.pooler === "object" &&
        !Array.isArray(value.pooler) &&
        Object.keys(value.pooler).length === 2 &&
        uuid.test(value.pooler.uid) &&
        uuid.test(value.pooler.deploymentUid)))
  );
}
export class AllowanceJournal {
  readonly binding: RuntimeBinding;
  private readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string, binding: RuntimeBinding) {
    if (!path || path === ":memory:" || !validRuntimeBinding(binding))
      throw new Error("allowance_journal_configuration_invalid");
    this.binding = Object.freeze({
      ...binding,
      ...(binding.pooler
        ? { pooler: Object.freeze({ ...binding.pooler }) }
        : {}),
    });
    this.path = resolve(path);
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
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) privateEntry(this.path + suffix);
    this.db = new DatabaseSync(this.path, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=64; CREATE TABLE IF NOT EXISTS allowance_state(name TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;",
      );
      this.transaction(() => {
        const sealed = this.load<RuntimeBinding>("binding");
        if (sealed && !equal(sealed, this.binding))
          throw new Error("allowance_journal_identity_mismatch");
        if (!sealed) {
          this.put("binding", this.binding);
          this.put("schema_version", 1);
        }
        if (this.load<number>("schema_version") !== 1)
          throw new Error("allowance_journal_schema_unsupported");
      });
      const receipt = this.receipt,
        authority = this.authority;
      if (
        (receipt && !this.validReceipt(receipt)) ||
        (authority && !this.validAuthority(authority))
      )
        throw new Error("allowance_journal_corrupt");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private permissions(): void {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) {
        privateEntry(this.path + suffix);
        chmodSync(this.path + suffix, 0o600);
      }
  }
  private transaction<T>(action: () => T): T {
    if (this.closed) throw new Error("allowance_journal_closed");
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
  private load<T>(name: string): T | null {
    const row = this.db
      .prepare(
        "SELECT payload_json,payload_hash FROM allowance_state WHERE name=?",
      )
      .get(name) as { payload_json: string; payload_hash: string } | undefined;
    if (!row) return null;
    if (digest(row.payload_json) !== row.payload_hash)
      throw new Error("allowance_journal_corrupt");
    return JSON.parse(row.payload_json) as T;
  }
  private put(name: string, value: unknown): void {
    const raw = JSON.stringify(value);
    this.db
      .prepare(
        "INSERT INTO allowance_state VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
      )
      .run(name, raw, digest(raw));
  }
  get receipt(): AllowanceReceipt | null {
    return this.load<AllowanceReceipt>("receipt");
  }
  get authority(): RuntimeAuthority | null {
    return this.load<RuntimeAuthority>("authority");
  }
  get stopState(): "stopping" | "stopped" | null {
    return this.load<"stopping" | "stopped">("stop_state");
  }
  get volumesHash(): string | null {
    return this.load<string>("volumes_hash");
  }
  request(leaseSeconds: number, units: AllowanceUnits): AllowanceRequest {
    if (
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 30 ||
      leaseSeconds > 300 ||
      !validAllowanceUnits(units) ||
      !Object.values(units).some((amount) => BigInt(amount) > 0n)
    )
      throw new Error("allowance_request_invalid");
    return this.transaction(() => {
      const request = this.load<AllowanceRequest>("request");
      if (request) {
        if (
          request.environmentId !== this.binding.environmentId ||
          request.leaseSeconds !== leaseSeconds ||
          !equal(request.units, units)
        )
          throw new Error("allowance_request_conflict");
        return request;
      }
      const next = {
        requestId: randomUUID(),
        environmentId: this.binding.environmentId,
        leaseSeconds,
        units: structuredClone(units),
      };
      this.put("request", next);
      return next;
    });
  }
  private validReceipt(value: AllowanceReceipt): boolean {
    return (
      uuid.test(value.id) &&
      value.environmentId === this.binding.environmentId &&
      value.regionId === this.binding.regionId &&
      value.specRevision === this.binding.specRevision &&
      value.specHash === this.binding.specHash &&
      /^(?:0|[1-9][0-9]{0,18})$/.test(value.epoch) &&
      /^(?:0|[1-9][0-9]{0,18})$/.test(value.revision) &&
      validAllowanceUnits(value.units) &&
      instant(value.issuedAt) &&
      instant(value.expiresAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
      ["issued", "settled"].includes(value.status) &&
      unsigned.test(value.gapCount) &&
      (value.stoppedAt === null || instant(value.stoppedAt)) &&
      /^cprsv_[A-Za-z0-9_-]{43}$/.test(value.fenceToken) &&
      value.runtimeEnforced === false &&
      value.enforcementStatus === "pending_runtime"
    );
  }
  recordReceipt(receipt: AllowanceReceipt): void {
    if (!this.validReceipt(receipt))
      throw new Error("allowance_receipt_invalid");
    this.transaction(() => {
      const prior = this.receipt,
        request = this.load<AllowanceRequest>("request");
      if (
        (prior && !equal(prior, receipt)) ||
        (request && !equal(request.units, receipt.units))
      )
        throw new Error("allowance_receipt_conflict");
      this.put("receipt", receipt);
    });
  }
  private validAuthority(value: RuntimeAuthority): boolean {
    const receipt = this.receipt;
    const valid =
      receipt !== null &&
      value.schemaVersion === 1 &&
      value.reservationId === receipt.id &&
      value.environmentId === this.binding.environmentId &&
      value.regionId === this.binding.regionId &&
      value.projectId === this.binding.projectId &&
      value.specRevision === this.binding.specRevision &&
      value.specHash === this.binding.specHash &&
      value.epoch === receipt.epoch &&
      ["allow", "stop"].includes(value.decision) &&
      typeof value.reason === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(value.reason) &&
      instant(value.observedAt) &&
      instant(value.validUntil) &&
      (value.decision === "stop"
        ? Date.parse(value.validUntil) >= Date.parse(value.observedAt)
        : Date.parse(value.validUntil) > Date.parse(value.observedAt)) &&
      Date.parse(value.validUntil) - Date.parse(value.observedAt) <= 15_000 &&
      validAllowanceUnits(value.units) &&
      equal(value.units, receipt.units) &&
      Array.isArray(value.limitedMetrics) &&
      value.limitedMetrics.length <= 3 &&
      value.limitedMetrics.every((metric) => metrics.has(metric)) &&
      new Set(value.limitedMetrics).size === value.limitedMetrics.length &&
      Array.isArray(value.bindings) &&
      value.bindings.length <= 2 &&
      new Set(value.bindings.map((binding) => binding.targetId)).size ===
        value.bindings.length &&
      new Set(value.bindings.map((binding) => binding.accountId)).size ===
        value.bindings.length &&
      value.bindings.every(
        (binding) =>
          [
            `project:${this.binding.projectId}`,
            `environment:${this.binding.environmentId}`,
          ].includes(binding.targetId) &&
          positive.test(binding.revision) &&
          positive.test(binding.executionEpoch) &&
          uuid.test(binding.accountId) &&
          instant(binding.periodStart) &&
          instant(binding.periodEnd) &&
          Date.parse(binding.periodEnd) > Date.parse(binding.periodStart) &&
          ["running", "paused"].includes(binding.requestedState),
      ) &&
      hash.test(value.evidenceHash) &&
      value.runtimeEnforced === false &&
      value.enforcementStatus === "pending_runtime";
    if (!valid || receipt === null) return false;
    if (value.decision === "stop") return true;
    return (
      value.reason === "authorized" &&
      value.bindings.reduce(
        (sum, binding) => sum + BigInt(binding.executionEpoch),
        0n,
      ) === BigInt(value.epoch) &&
      (value.bindings.length === 0
        ? value.limitedMetrics.length === 0
        : value.limitedMetrics.length > 0) &&
      Date.parse(value.observedAt) >= Date.parse(receipt.issuedAt) &&
      Date.parse(value.validUntil) <= Date.parse(receipt.expiresAt) &&
      value.bindings.every(
        (binding) =>
          binding.requestedState === "running" &&
          Date.parse(binding.periodStart) <= Date.parse(value.observedAt) &&
          Date.parse(binding.periodEnd) >= Date.parse(value.validUntil),
      )
    );
  }
  recordAuthority(authority: RuntimeAuthority): void {
    if (!this.validAuthority(authority))
      throw new Error("allowance_authority_invalid");
    this.transaction(() => {
      const prior = this.authority;
      if (
        prior &&
        Date.parse(authority.observedAt) < Date.parse(prior.observedAt)
      )
        throw new Error("allowance_authority_rollback");
      this.put("authority", authority);
    });
  }
  observeClock(now: number): boolean {
    if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999)
      throw new Error("allowance_clock_invalid");
    return this.transaction(() => {
      const previous = this.load<number>("clock");
      if (previous !== null && now < previous) {
        this.put("stop_state", "stopping");
        this.put("stop_reason", "clock_rollback");
        return false;
      }
      this.put("clock", now);
      return true;
    });
  }
  recordRates(rates: AllowanceUnits): AllowanceUnits {
    if (!validAllowanceUnits(rates)) throw new Error("allowance_rates_invalid");
    return this.transaction(() => {
      const prior = this.load<AllowanceUnits>("rates") ?? {};
      const maximum: AllowanceUnits = {};
      for (const [key, rate] of Object.entries(rates))
        maximum[key] = (
          BigInt(rate) > BigInt(prior[key] ?? "0")
            ? BigInt(rate)
            : BigInt(prior[key] ?? "0")
        ).toString();
      this.put("rates", maximum);
      return maximum;
    });
  }
  beginStop(reason: string, volumesHash: string): void {
    if (!hash.test(volumesHash))
      throw new Error("allowance_volume_evidence_invalid");
    this.transaction(() => {
      const previous = this.volumesHash;
      if (previous && previous !== volumesHash)
        throw new Error("allowance_volume_binding_changed");
      if (!previous) this.put("volumes_hash", volumesHash);
      if (this.stopState !== "stopped") this.put("stop_state", "stopping");
      this.put("stop_reason", reason);
    });
  }
  recordStopped(now: number, volumesHash: string): void {
    this.transaction(() => {
      if (this.volumesHash !== volumesHash)
        throw new Error("allowance_volume_binding_changed");
      if (this.load<string>("stopped_at") === null)
        this.put("stopped_at", new Date(now).toISOString());
      this.put("stop_state", "stopped");
    });
  }
  close(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.permissions();
    this.db.close();
    this.closed = true;
  }
}
