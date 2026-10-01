// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  provisioningAllowanceUnits,
  provisioningResourceEnvelope,
} from "@cloudflare-postgres/resource-envelope";
import { validAllowanceUnits } from "./allowance-journal.ts";
import type {
  AllowanceReceipt,
  AllowanceUnits,
  RuntimeAuthority,
} from "./allowance-types.ts";
import type { Claim, Kubernetes } from "./types.ts";

export const PROVISIONING_FUNDING_SECONDS = 300;
export interface ProvisioningFunding {
  version: 1;
  envelopeVersion: 1;
  operationId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: 1;
  specHash: string;
  runEpoch: string | null;
  fundingSeconds: number;
  rates: AllowanceUnits;
  units: AllowanceUnits;
  reservation: AllowanceReceipt;
}
export interface ProvisioningFundingTransport {
  funding(claim: Claim, fundingSeconds: number): Promise<ProvisioningFunding>;
  authority(reservationId: string): Promise<RuntimeAuthority>;
}
interface Binding {
  operationId: string;
  environmentId: string;
  regionId: string;
  specRevision: 1;
  specHash: string;
  runEpoch: string | null;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const unsigned = /^(?:0|[1-9][0-9]{0,77})$/;
const epoch = /^(?:0|[1-9][0-9]{0,18})$/;
const positive = /^[1-9][0-9]{0,18}$/;
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const instant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function privateEntry(path: string, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("provisioning_funding_path_not_private");
  return stat;
}
export function validateProvisioningJournalDirectory(directory: string): void {
  if (!directory || !isAbsolute(directory) || directory !== resolve(directory))
    throw new Error("provisioning_funding_directory_invalid");
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("provisioning_funding_directory_invalid");
  }
  privateEntry(directory, true);
}

// Bootstrap identity deliberately has no live Kubernetes UIDs. It is separate
// from AllowanceJournal and can never substitute for its runtime/volume custody.
export class ProvisioningFundingJournal {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly binding: Binding;
  private readonly directoryIdentity: {
    dev: number;
    ino: number;
    uid: number;
    mode: number;
  };
  private readonly fileIdentity: {
    dev: number;
    ino: number;
    uid: number;
    mode: number;
  };
  private readonly rates: AllowanceUnits;
  private readonly units: AllowanceUnits;
  private closed = false;
  constructor(directory: string, claim: Claim) {
    validateProvisioningJournalDirectory(directory);
    this.directoryIdentity = privateEntry(directory, true);
    if (
      ![claim.operationId, claim.environmentId, claim.regionId].every(
        (v) => typeof v === "string" && uuid.test(v),
      ) ||
      claim.kind !== "environment.create" ||
      claim.specRevision !== 1 ||
      !/^[a-f0-9]{64}$/.test(claim.specHash) ||
      digest(JSON.stringify(claim.spec)) !== claim.specHash ||
      !Number.isSafeInteger(claim.leaseEpoch) ||
      claim.leaseEpoch < 1 ||
      (claim.runEpoch !== undefined && claim.runEpoch !== "1")
    )
      throw new Error("provisioning_funding_binding_invalid");
    this.binding = {
      operationId: claim.operationId,
      environmentId: claim.environmentId,
      regionId: claim.regionId,
      specRevision: 1,
      specHash: claim.specHash,
      runEpoch: claim.runEpoch ?? null,
    };
    const input = { ...claim.spec.profile, volumeGiB: claim.spec.volumeGiB };
    this.rates = { ...provisioningResourceEnvelope(input).rates };
    this.units = {
      ...provisioningAllowanceUnits(input, PROVISIONING_FUNDING_SECONDS),
    };
    this.path = join(directory, `${claim.operationId}.sqlite`);
    if (!existsSync(this.path)) {
      if (claim.leaseEpoch !== 1)
        throw new Error("provisioning_funding_history_unproven");
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
    this.fileIdentity = privateEntry(this.path);
    this.permissions();
    this.db = new DatabaseSync(this.path, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=64; CREATE TABLE IF NOT EXISTS provisioning_funding_state(name TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;",
      );
      this.transaction(() => {
        const prior = this.load<Binding>("binding");
        if (prior && !equal(prior, this.binding))
          throw new Error("provisioning_funding_identity_mismatch");
        if (!prior) {
          if (claim.leaseEpoch !== 1)
            throw new Error("provisioning_funding_history_unproven");
          this.put("binding", this.binding);
          this.put("schema_version", 1);
        }
        if (this.load<number>("schema_version") !== 1)
          throw new Error("provisioning_funding_schema_unsupported");
        const request = this.load<{
          requestId: string;
          fundingSeconds: number;
        }>("request");
        if (
          request &&
          !equal(request, {
            requestId: claim.operationId,
            fundingSeconds: PROVISIONING_FUNDING_SECONDS,
          })
        )
          throw new Error("provisioning_funding_request_conflict");
        if (!request) {
          if (claim.leaseEpoch !== 1)
            throw new Error("provisioning_funding_history_unproven");
          this.put("request", {
            requestId: claim.operationId,
            fundingSeconds: PROVISIONING_FUNDING_SECONDS,
          });
        }
      });
      const funding = this.funding;
      if (funding && !this.validFunding(funding))
        throw new Error("provisioning_funding_corrupt");
      const authority = this.authority;
      if (authority && (!funding || !validAuthority(authority, funding)))
        throw new Error("provisioning_funding_corrupt");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private permissions(): void {
    const same = (
      a: { dev: number; ino: number; uid: number; mode: number },
      b: { dev: number; ino: number; uid: number; mode: number },
    ) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.uid === b.uid &&
      a.mode === b.mode;
    if (
      !same(
        privateEntry(resolve(this.path, ".."), true),
        this.directoryIdentity,
      ) ||
      !same(privateEntry(this.path), this.fileIdentity)
    )
      throw new Error("provisioning_funding_custody_changed");
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(this.path + suffix)) privateEntry(this.path + suffix);
  }
  private transaction<T>(action: () => T): T {
    if (this.closed) throw new Error("provisioning_funding_journal_closed");
    this.permissions();
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
    this.permissions();
    const row = this.db
      .prepare(
        "SELECT payload_json,payload_hash FROM provisioning_funding_state WHERE name=?",
      )
      .get(name) as { payload_json: string; payload_hash: string } | undefined;
    if (!row) return null;
    if (
      row.payload_json.length > 65_536 ||
      digest(row.payload_json) !== row.payload_hash
    )
      throw new Error("provisioning_funding_corrupt");
    return JSON.parse(row.payload_json) as T;
  }
  private put(name: string, value: unknown): void {
    const raw = JSON.stringify(value);
    if (raw.length > 65_536)
      throw new Error("provisioning_funding_bound_exceeded");
    this.db
      .prepare(
        "INSERT INTO provisioning_funding_state VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
      )
      .run(name, raw, digest(raw));
  }
  get funding(): ProvisioningFunding | null {
    return this.load("funding");
  }
  get authority(): RuntimeAuthority | null {
    return this.load("authority");
  }
  private validFunding(value: ProvisioningFunding): boolean {
    if (
      !object(value) ||
      value.version !== 1 ||
      value.envelopeVersion !== 1 ||
      Object.keys(this.binding).some(
        (key) =>
          value[key as keyof Binding] !== this.binding[key as keyof Binding],
      ) ||
      !uuid.test(value.organizationId) ||
      !uuid.test(value.projectId) ||
      value.fundingSeconds !== PROVISIONING_FUNDING_SECONDS ||
      !equal(value.rates, this.rates) ||
      !equal(value.units, this.units)
    )
      return false;
    const r = value.reservation;
    return (
      object(r) &&
      uuid.test(r.id) &&
      r.environmentId === value.environmentId &&
      r.regionId === value.regionId &&
      r.specRevision === value.specRevision &&
      r.specHash === value.specHash &&
      typeof r.epoch === "string" &&
      epoch.test(r.epoch) &&
      typeof r.revision === "string" &&
      epoch.test(r.revision) &&
      validAllowanceUnits(r.units) &&
      equal(r.units, this.units) &&
      instant(r.issuedAt) &&
      instant(r.expiresAt) &&
      Date.parse(r.expiresAt) - Date.parse(r.issuedAt) ===
        PROVISIONING_FUNDING_SECONDS * 1000 &&
      r.status === "issued" &&
      r.gapCount === "0" &&
      r.stoppedAt === null &&
      typeof r.fenceToken === "string" &&
      /^cprsv_[A-Za-z0-9_-]{43}$/.test(r.fenceToken) &&
      r.runtimeEnforced === false &&
      r.enforcementStatus === "pending_runtime"
    );
  }
  recordFunding(value: ProvisioningFunding): void {
    if (!this.validFunding(value))
      throw new Error("provisioning_funding_receipt_invalid");
    this.transaction(() => {
      const previous = this.funding;
      if (previous && !equal(previous, value))
        throw new Error("provisioning_funding_receipt_conflict");
      this.put("funding", value);
    });
  }
  recordAuthority(value: RuntimeAuthority): void {
    const funding = this.funding;
    if (!funding || !validAuthority(value, funding))
      throw new Error("provisioning_funding_authority_invalid");
    this.transaction(() => {
      const previous = this.authority;
      if (
        previous &&
        Date.parse(value.observedAt) < Date.parse(previous.observedAt)
      )
        throw new Error("provisioning_funding_authority_rollback");
      this.put("authority", value);
    });
  }
  observeClock(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999)
      throw new Error("provisioning_funding_clock_invalid");
    const valid = this.transaction(() => {
      const previous = this.load<number>("clock");
      if (
        this.load<boolean>("clock_blocked") ||
        (previous !== null && now < previous)
      ) {
        this.put("clock_blocked", true);
        return false;
      }
      this.put("clock", now);
      return true;
    });
    if (!valid) throw new Error("provisioning_funding_clock_rollback");
  }
  close(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.permissions();
    this.db.close();
    this.closed = true;
  }
}
function validAuthority(a: RuntimeAuthority, f: ProvisioningFunding): boolean {
  const r = f.reservation;
  if (
    !object(a) ||
    a.schemaVersion !== 1 ||
    a.reservationId !== r.id ||
    a.environmentId !== f.environmentId ||
    a.projectId !== f.projectId ||
    a.regionId !== f.regionId ||
    a.specRevision !== f.specRevision ||
    a.specHash !== f.specHash ||
    a.epoch !== r.epoch ||
    !["allow", "stop"].includes(a.decision) ||
    typeof a.reason !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(a.reason) ||
    !instant(a.observedAt) ||
    !instant(a.validUntil) ||
    Date.parse(a.validUntil) < Date.parse(a.observedAt) ||
    Date.parse(a.validUntil) - Date.parse(a.observedAt) > 15_000 ||
    !equal(a.units, r.units) ||
    !Array.isArray(a.limitedMetrics) ||
    a.limitedMetrics.length > 3 ||
    new Set(a.limitedMetrics).size !== a.limitedMetrics.length ||
    a.limitedMetrics.some((m) => !Object.hasOwn(f.rates, m)) ||
    !Array.isArray(a.bindings) ||
    a.bindings.length > 2 ||
    new Set(a.bindings.map((b) => b.targetId)).size !== a.bindings.length ||
    new Set(a.bindings.map((b) => b.accountId)).size !== a.bindings.length ||
    a.bindings.some(
      (b) =>
        !object(b) ||
        ![`project:${f.projectId}`, `environment:${f.environmentId}`].includes(
          b.targetId,
        ) ||
        typeof b.revision !== "string" ||
        !positive.test(b.revision) ||
        typeof b.executionEpoch !== "string" ||
        !positive.test(b.executionEpoch) ||
        typeof b.accountId !== "string" ||
        !uuid.test(b.accountId) ||
        !instant(b.periodStart) ||
        !instant(b.periodEnd) ||
        Date.parse(b.periodEnd) <= Date.parse(b.periodStart) ||
        !["running", "paused"].includes(b.requestedState),
    ) ||
    typeof a.evidenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(a.evidenceHash) ||
    a.runtimeEnforced !== false ||
    a.enforcementStatus !== "pending_runtime"
  )
    return false;
  if (a.decision === "stop") return true;
  return (
    a.reason === "authorized" &&
    Date.parse(a.validUntil) > Date.parse(a.observedAt) &&
    Date.parse(a.observedAt) >= Date.parse(r.issuedAt) &&
    Date.parse(a.validUntil) <= Date.parse(r.expiresAt) &&
    a.bindings.reduce((sum, b) => sum + BigInt(b.executionEpoch), 0n) ===
      BigInt(r.epoch) &&
    (a.bindings.length
      ? a.limitedMetrics.length > 0
      : a.limitedMetrics.length === 0) &&
    a.bindings.every(
      (b) =>
        b.requestedState === "running" &&
        Date.parse(b.periodStart) <= Date.parse(a.observedAt) &&
        Date.parse(b.periodEnd) >= Date.parse(a.validUntil),
    )
  );
}

export class ProvisioningFundingBarrier {
  private refreshed = false;
  private readonly journal: ProvisioningFundingJournal;
  private readonly transport: ProvisioningFundingTransport;
  private readonly leaseAuthorized: () => void;
  private readonly leaseDeadline: () => number;
  constructor(
    journal: ProvisioningFundingJournal,
    transport: ProvisioningFundingTransport,
    leaseAuthorized: () => void,
    leaseDeadline: () => number,
  ) {
    this.journal = journal;
    this.transport = transport;
    this.leaseAuthorized = leaseAuthorized;
    this.leaseDeadline = leaseDeadline;
  }
  async acquire(claim: Claim): Promise<void> {
    this.leaseAuthorized();
    this.journal.observeClock(Date.now());
    if (!this.journal.funding) {
      const funding = await this.transport.funding(
        claim,
        PROVISIONING_FUNDING_SECONDS,
      );
      this.journal.recordFunding(funding);
    }
    await this.refresh();
  }
  assert(): void {
    this.authorizationDeadline();
  }
  private authorizationDeadline(): number {
    this.leaseAuthorized();
    const now = Date.now();
    this.journal.observeClock(now);
    const f = this.journal.funding,
      a = this.journal.authority;
    if (
      !this.refreshed ||
      !f ||
      !a ||
      a.decision !== "allow" ||
      a.reason !== "authorized" ||
      Date.parse(f.reservation.issuedAt) > now ||
      Date.parse(f.reservation.expiresAt) <= now ||
      Date.parse(a.observedAt) > now ||
      now - Date.parse(a.observedAt) > 15_000 ||
      Date.parse(a.validUntil) <= now
    )
      throw new Error("provisioning_funding_not_authorized");
    let until = BigInt(
      Math.min(
        Date.parse(f.reservation.expiresAt),
        Date.parse(a.validUntil),
        this.leaseDeadline(),
      ),
    );
    for (const [metric, units] of Object.entries(f.units)) {
      if (!unsigned.test(units) || !positive.test(f.rates[metric] ?? ""))
        throw new Error("provisioning_funding_envelope_invalid");
      const funded =
        BigInt(Date.parse(f.reservation.issuedAt)) +
        BigInt(units) / BigInt(f.rates[metric]!);
      if (funded < until) until = funded;
    }
    if (until <= BigInt(now)) throw new Error("provisioning_funding_exhausted");
    return Number(until);
  }
  async refresh(): Promise<void> {
    this.refreshed = false;
    this.leaseAuthorized();
    this.journal.observeClock(Date.now());
    const funding = this.journal.funding;
    if (!funding || Date.parse(funding.reservation.expiresAt) <= Date.now())
      throw new Error("provisioning_funding_expired");
    const authority = await this.transport.authority(funding.reservation.id);
    this.journal.recordAuthority(authority);
    this.refreshed = true;
    this.assert();
  }
  dispatchAuthority(): { check: () => void; expiresAt: () => number } {
    return {
      check: () => this.assert(),
      expiresAt: () => this.authorizationDeadline(),
    };
  }
  wrap(api: Kubernetes): Kubernetes {
    const read = async <T>(action: () => Promise<T>): Promise<T> => {
      this.assert();
      const value = await action();
      this.assert();
      return value;
    };
    return {
      read: (...args) => read(() => api.read(...args)),
      create: async (resource) => {
        await this.refresh();
        this.assert();
        const value = await api.create(resource, this.dispatchAuthority());
        this.assert();
        return value;
      },
      readSecret: (...args) => read(() => api.readSecret(...args)),
      listPods: (...args) => read(() => api.listPods(...args)),
      ...(api.listNodes
        ? { listNodes: () => read(() => api.listNodes!()) }
        : {}),
      ...(api.executionPreflight
        ? {
            executionPreflight: (...args: [string]) =>
              read(() => api.executionPreflight!(...args)),
          }
        : {}),
      ...(api.listEndpointSlices
        ? {
            listEndpointSlices: (...args: [string, string]) =>
              read(() => api.listEndpointSlices!(...args)),
          }
        : {}),
      ...(api.readPublicCertificate
        ? {
            readPublicCertificate: (
              ...args: [string, string, "ca.crt" | "tls.crt"]
            ) => read(() => api.readPublicCertificate!(...args)),
          }
        : {}),
    };
  }
}
