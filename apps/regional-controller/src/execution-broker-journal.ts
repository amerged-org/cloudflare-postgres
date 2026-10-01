// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, openSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { privateEntry, privatePath, sameIdentity } from "./capacity-journal.ts";
import { canonicalCohort } from "./node-cohort.ts";
import {
  fields,
  hash,
  permitDuration,
  challengeFor,
} from "./node-delivery-protocol.ts";
import type {
  NodeDeliveryInitialization,
  NodeDeliveryReceipt,
  NodeDeliveryConfiguration,
} from "./node-delivery.ts";
import type { SignedExecutionPermit } from "./execution-permit-types.ts";

export type ExecutionAttemptPhase =
  | "prepared"
  | "dispatching"
  | "issuing"
  | "issued"
  | "publishing"
  | "published"
  | "uncertain"
  | "blocked";
export interface ExecutionAttempt {
  version: 1;
  revision: number;
  key: string;
  init: NodeDeliveryInitialization;
  phase: ExecutionAttemptPhase;
  permit: SignedExecutionPermit | null;
  permitJson: string | null;
  permitHash: string | null;
  receipt: NodeDeliveryReceipt | null;
}
export const brokerFailure = () => new Error("execution_broker_unproven");
const sealed = (value: unknown) => canonicalCohort(value);
const schema = [
  "CREATE TABLE execution_binding(id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT",
  "CREATE TABLE execution_attempts(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT",
];

// Private custody precedes dispatch. Existing empty/corrupt files are never
// initialized or adopted on reclaim; CAS phases prevent concurrent issuers.
export class ExecutionBrokerJournal {
  private readonly deliveryIdentity: NodeDeliveryConfiguration;
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly file: Stats;
  private readonly directory: Stats;
  private closed = false;
  constructor(
    directory: string,
    operationId: string,
    binding: unknown,
    leaseEpoch: number,
    deliveryIdentity: NodeDeliveryConfiguration,
  ) {
    this.deliveryIdentity = structuredClone(deliveryIdentity);
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId) ||
      !Number.isSafeInteger(leaseEpoch) ||
      leaseEpoch < 1
    )
      throw brokerFailure();
    this.path = join(directory, operationId + ".execution.sqlite");
    privatePath(this.path);
    this.directory = privateEntry(directory, true);
    const existed = existsSync(this.path);
    if (!existed) {
      if (leaseEpoch !== 1)
        throw new Error("execution_broker_history_unproven");
      const fd = openSync(
        this.path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const parent = openSync(
        directory,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    this.file = privateEntry(this.path);
    this.permissions();
    this.db = new DatabaseSync(this.path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5000,
    });
    try {
      if (existed) this.verifySchema();
      this.db.exec(
        "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA fullfsync=ON;PRAGMA checkpoint_fullfsync=ON;PRAGMA trusted_schema=OFF;PRAGMA wal_autocheckpoint=64;",
      );
      if (!existed) {
        this.db.exec(schema.join(";") + ";");
        this.transaction(() => {
          this.db
            .prepare("INSERT INTO execution_binding VALUES(1,?,?)")
            .run(sealed(binding), hash(sealed(binding)));
        });
      }
      this.verifySchema();
      const stored = this.load(
        "SELECT payload_json,payload_hash FROM execution_binding WHERE id=1",
      );
      if (sealed(stored) !== sealed(binding))
        throw new Error("execution_broker_binding_conflict");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private verifySchema() {
    const rows = this.db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string; sql: string }[];
    if (
      rows.length !== 2 ||
      rows[0]!.name !== "execution_attempts" ||
      rows[0]!.sql !== schema[1] ||
      rows[1]!.name !== "execution_binding" ||
      rows[1]!.sql !== schema[0]
    )
      throw brokerFailure();
  }
  private permissions() {
    if (this.closed) throw brokerFailure();
    privatePath(this.path);
    sameIdentity(this.file, privateEntry(this.path));
    sameIdentity(this.directory, privateEntry(dirname(this.path), true));
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(this.path + suffix)) privateEntry(this.path + suffix);
  }
  private transaction<T>(work: () => T): T {
    this.permissions();
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const value = work();
      this.db.exec("COMMIT");
      committed = true;
      this.permissions();
      return value;
    } catch (error) {
      if (!committed) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private load(sql: string, key?: string): unknown | null {
    this.permissions();
    const rows = (
      key === undefined
        ? this.db.prepare(sql).all()
        : this.db.prepare(sql).all(key)
    ) as { payload_json: string; payload_hash: string }[];
    if (rows.length === 0) return null;
    if (
      rows.length !== 1 ||
      Buffer.byteLength(rows[0]!.payload_json) > 65_536 ||
      hash(rows[0]!.payload_json) !== rows[0]!.payload_hash
    )
      throw brokerFailure();
    const value = JSON.parse(rows[0]!.payload_json);
    if (sealed(value) !== rows[0]!.payload_json) throw brokerFailure();
    return value;
  }
  read(key: string): ExecutionAttempt | null {
    const value = this.load(
      "SELECT payload_json,payload_hash FROM execution_attempts WHERE key=?",
      key,
    );
    if (value === null) return null;
    if (
      !fields(value, [
        "version",
        "revision",
        "key",
        "init",
        "phase",
        "permit",
        "permitJson",
        "permitHash",
        "receipt",
      ]) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 ||
      value.key !== key ||
      ![
        "prepared",
        "dispatching",
        "issuing",
        "issued",
        "publishing",
        "published",
        "uncertain",
        "blocked",
      ].includes(String(value.phase))
    )
      throw brokerFailure();
    const result = value as unknown as ExecutionAttempt;
    if (result.permit !== null) {
      if (
        typeof result.permitJson !== "string" ||
        result.permitJson.length > 32_768
      )
        throw brokerFailure();
      const original = JSON.parse(result.permitJson);
      if (sealed(original) !== sealed(result.permit)) throw brokerFailure();
      permitDuration(original, result.init);
      if (result.permitHash !== hash(result.permitJson)) throw brokerFailure();
      result.permit = original;
    } else if (
      result.permitHash !== null ||
      result.permitJson !== null ||
      ["issued", "publishing", "published"].includes(result.phase)
    )
      throw brokerFailure();
    if ((result.phase === "published") !== (result.receipt !== null))
      throw brokerFailure();
    if (result.phase === "published") this.validatePublication(result);
    return structuredClone(result);
  }
  private validatePublication(record: ExecutionAttempt): void {
    const r = record.receipt,
      peer = this.deliveryIdentity.peers.find(
        (p) => p.nodeName === record.init.scope.nodeName,
      );
    if (
      !peer ||
      !r ||
      !fields(r, [
        "version",
        "type",
        "requestId",
        "self",
        "challengeHash",
        "permitHash",
        "state",
        "deadlineBootNs",
      ]) ||
      r.version !== 1 ||
      r.type !== "receipt" ||
      r.requestId !== record.init.requestId ||
      r.challengeHash !== hash(JSON.stringify(challengeFor(record.init))) ||
      r.permitHash !== record.permitHash ||
      !["published", "replayed"].includes(r.state) ||
      typeof r.deadlineBootNs !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(r.deadlineBootNs) ||
      BigInt(r.deadlineBootNs) > 9223372036854775807n ||
      !fields(r.self, [
        "podUid",
        "namespace",
        "nodeName",
        "installationId",
        "regionId",
      ]) ||
      r.self.podUid !== peer.podUid ||
      r.self.namespace !== this.deliveryIdentity.deliveryNamespace ||
      r.self.nodeName !== peer.nodeName ||
      r.self.installationId !== this.deliveryIdentity.installationId ||
      r.self.regionId !== this.deliveryIdentity.regionId
    )
      throw brokerFailure();
  }
  prepare(init: NodeDeliveryInitialization): ExecutionAttempt {
    const key = init.pod.podUid + ".postgres";
    return this.transaction(() => {
      const current = this.read(key);
      if (current) {
        const candidate = { ...init, requestId: current.init.requestId };
        if (sealed(candidate) !== sealed(current.init))
          throw new Error("execution_broker_attempt_conflict");
        return current;
      }
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM execution_attempts")
        .get() as { n: number };
      if (count.n >= 4096) throw new Error("execution_broker_history_bound");
      const created: ExecutionAttempt = {
        version: 1,
        revision: 0,
        key,
        init: { ...structuredClone(init), requestId: randomUUID() },
        phase: "prepared",
        permit: null,
        permitJson: null,
        permitHash: null,
        receipt: null,
      };
      this.persist(created);
      return created;
    });
  }
  private persist(value: ExecutionAttempt) {
    const raw = sealed(value);
    if (Buffer.byteLength(raw) > 65_536) throw brokerFailure();
    this.db
      .prepare(
        "INSERT INTO execution_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
      )
      .run(value.key, raw, hash(raw));
  }
  advance(
    key: string,
    from: ExecutionAttemptPhase,
    to: ExecutionAttemptPhase,
    evidence?: SignedExecutionPermit | NodeDeliveryReceipt,
  ): ExecutionAttempt {
    return this.transaction(() => {
      const current = this.read(key);
      if (!current || current.phase !== from)
        throw new Error("execution_broker_in_progress_or_blocked");
      const allowed: Partial<
        Record<ExecutionAttemptPhase, ExecutionAttemptPhase>
      > = {
        prepared: "dispatching",
        dispatching: "issuing",
        issuing: "issued",
        issued: "publishing",
        publishing: "published",
      };
      if (allowed[from] !== to) throw brokerFailure();
      current.phase = to;
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw brokerFailure();
      current.revision++;
      if (to === "issued") {
        const permit = evidence as SignedExecutionPermit;
        permitDuration(permit, current.init);
        current.permit = structuredClone(permit);
        current.permitJson = JSON.stringify(permit);
        current.permitHash = hash(current.permitJson);
      }
      if (to === "published") {
        const receipt = evidence as NodeDeliveryReceipt;
        if (
          !receipt ||
          receipt.requestId !== current.init.requestId ||
          receipt.permitHash !== current.permitHash ||
          !["published", "replayed"].includes(receipt.state)
        )
          throw brokerFailure();
        current.receipt = structuredClone(receipt);
        this.validatePublication(current);
      }
      this.persist(current);
      return structuredClone(current);
    });
  }
  hold(key: string): void {
    this.transaction(() => {
      const current = this.read(key);
      if (
        !current ||
        ["published", "uncertain", "blocked", "prepared"].includes(
          current.phase,
        )
      )
        return;
      current.phase = current.phase === "dispatching" ? "blocked" : "uncertain";
      current.revision++;
      this.persist(current);
    });
  }
  close() {
    if (this.closed) return;
    this.permissions();
    this.db.close();
    this.closed = true;
    privatePath(this.path);
    sameIdentity(this.file, privateEntry(this.path));
    sameIdentity(this.directory, privateEntry(dirname(this.path), true));
  }
}
