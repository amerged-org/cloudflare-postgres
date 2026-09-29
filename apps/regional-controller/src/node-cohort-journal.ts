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
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CohortNode, NodeCohortPointer } from "./node-cohort.ts";

export interface NodeBirthScope {
  operationId: string;
  environmentId: string;
  regionId: string;
  specHash: string;
  runEpoch: string;
}
export interface NodeBirth extends NodeBirthScope {
  version: 1;
  birthId: string;
  nodes: CohortNode[];
  namespaceUid?: string;
  nodeCohort?: NodeCohortPointer;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function privateEntry(path: string, directory = false): void {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw new Error("node_birth_journal_not_private");
}
function valid(value: unknown, regionId: string): value is NodeBirth {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as NodeBirth,
    keys = Object.keys(v);
  if (
    keys.some(
      (k) =>
        ![
          "version",
          "birthId",
          "operationId",
          "environmentId",
          "regionId",
          "specHash",
          "runEpoch",
          "nodes",
          "namespaceUid",
          "nodeCohort",
        ].includes(k),
    ) ||
    v.version !== 1 ||
    v.regionId !== regionId ||
    ![v.birthId, v.operationId, v.environmentId, v.regionId].every(
      (x) => typeof x === "string" && uuid.test(x),
    ) ||
    typeof v.specHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.specHash) ||
    typeof v.runEpoch !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(v.runEpoch) ||
    !Array.isArray(v.nodes) ||
    v.nodes.length < 1 ||
    v.nodes.length > 32
  )
    return false;
  let previous = "";
  const ids = new Set<string>();
  for (const n of v.nodes) {
    if (
      !n ||
      Object.keys(n).length !== 3 ||
      typeof n.name !== "string" ||
      n.name.length > 253 ||
      !n.name
        .split(".")
        .every((x) => /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(x)) ||
      n.name <= previous ||
      !uuid.test(n.uid) ||
      ids.has(n.uid) ||
      !uuid.test(n.bootId)
    )
      return false;
    previous = n.name;
    ids.add(n.uid);
  }
  if (v.namespaceUid !== undefined && !uuid.test(v.namespaceUid)) return false;
  if (
    v.nodeCohort !== undefined &&
    (!v.namespaceUid ||
      !v.nodeCohort ||
      Object.keys(v.nodeCohort).length !== 2 ||
      !uuid.test(v.nodeCohort.uid) ||
      !/^[a-f0-9]{64}$/.test(v.nodeCohort.hash))
  )
    return false;
  return true;
}
export class NodeCohortJournal {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly regionId: string;
  constructor(path: string, regionId: string) {
    this.regionId = regionId;
    if (!isAbsolute(path) || !uuid.test(regionId))
      throw new Error("node_birth_journal_configuration_invalid");
    this.path = resolve(path);
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateEntry(dir, true);
    if (!existsSync(this.path)) {
      const f = openSync(
        this.path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      fsyncSync(f);
      closeSync(f);
      const d = openSync(dir, constants.O_RDONLY);
      fsyncSync(d);
      closeSync(d);
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
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; CREATE TABLE IF NOT EXISTS node_birth_meta (name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS node_births (environment_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;",
      );
      this.tx(() => {
        const row = this.db
          .prepare("SELECT value FROM node_birth_meta WHERE name='identity'")
          .get() as { value: string } | undefined;
        const expected = JSON.stringify({ version: 1, regionId });
        if (row && row.value !== expected)
          throw new Error("node_birth_journal_identity_mismatch");
        if (!row)
          this.db
            .prepare("INSERT INTO node_birth_meta VALUES('identity',?)")
            .run(expected);
      });
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  private modes() {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) {
        privateEntry(this.path + suffix);
        chmodSync(this.path + suffix, 0o600);
      }
  }
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const v = work();
      this.db.exec("COMMIT");
      committed = true;
      this.modes();
      return v;
    } catch (e) {
      if (!committed) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(environmentId: string): NodeBirth | null {
    const row = this.db
      .prepare(
        "SELECT payload_json,payload_hash FROM node_births WHERE environment_id=?",
      )
      .get(environmentId) as
      { payload_json: string; payload_hash: string } | undefined;
    if (!row) return null;
    if (
      row.payload_json.length > 65_536 ||
      hash(row.payload_json) !== row.payload_hash
    )
      throw new Error("node_birth_journal_corrupt");
    const v: unknown = JSON.parse(row.payload_json);
    if (!valid(v, this.regionId) || v.environmentId !== environmentId)
      throw new Error("node_birth_journal_corrupt");
    return v;
  }
  private put(v: NodeBirth) {
    if (!valid(v, this.regionId))
      throw new Error("node_birth_journal_record_invalid");
    const payload = JSON.stringify(v);
    if (Buffer.byteLength(payload) > 65_536)
      throw new Error("node_birth_journal_bound");
    this.db
      .prepare(
        "INSERT INTO node_births VALUES(?,?,?) ON CONFLICT(environment_id) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
      )
      .run(v.environmentId, payload, hash(payload));
  }
  reserve(
    scope: NodeBirthScope,
    nodes: CohortNode[],
    leaseEpoch: number,
    namespaceAbsent: boolean,
  ): NodeBirth {
    return this.tx(() => {
      const previous = this.get(scope.environmentId);
      if (previous) {
        if (
          Object.entries(scope).some(
            ([k, v]) => previous[k as keyof NodeBirth] !== v,
          )
        )
          throw new Error("node_birth_scope_conflict");
        return previous;
      }
      if (leaseEpoch !== 1 || !namespaceAbsent)
        throw new Error("node_cohort_history_unproven");
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM node_births")
        .get() as { n: number };
      if (count.n >= 4096) throw new Error("node_birth_journal_bound");
      const value: NodeBirth = {
        ...scope,
        version: 1,
        birthId: randomUUID(),
        nodes: structuredClone(nodes),
      };
      this.put(value);
      return value;
    });
  }
  bindNamespace(
    environmentId: string,
    birthId: string,
    uid: string,
  ): NodeBirth {
    return this.tx(() => {
      const value = this.get(environmentId);
      if (
        !value ||
        value.birthId !== birthId ||
        !uuid.test(uid) ||
        (value.namespaceUid && value.namespaceUid !== uid)
      )
        throw new Error("node_birth_namespace_changed");
      if (!value.namespaceUid) {
        value.namespaceUid = uid;
        this.put(value);
      }
      return value;
    });
  }
  bindCohort(environmentId: string, pointer: NodeCohortPointer): NodeBirth {
    return this.tx(() => {
      const value = this.get(environmentId);
      if (!value || !value.namespaceUid)
        throw new Error("node_birth_namespace_unproven");
      if (
        value.nodeCohort &&
        (value.nodeCohort.uid !== pointer.uid ||
          value.nodeCohort.hash !== pointer.hash)
      )
        throw new Error("node_cohort_identity_unproven");
      if (!value.nodeCohort) {
        value.nodeCohort = { uid: pointer.uid, hash: pointer.hash };
        this.put(value);
      }
      return value;
    });
  }
  close() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.modes();
    this.db.close();
  }
}
