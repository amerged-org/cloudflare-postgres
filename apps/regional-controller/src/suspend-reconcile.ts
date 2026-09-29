// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
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
import { validRuntimeBinding } from "./allowance-journal.ts";
import type {
  AllowanceRuntime,
  RuntimeBinding,
  RuntimeInventory,
} from "./allowance-types.ts";
import { ownedInventory, stopOwnedRuntime, volumeHash } from "./owned-stop.ts";
import { validSuspendClaim } from "./suspend-types.ts";
import type {
  SuspendClaim,
  SuspendObservation,
  SuspendSeal,
} from "./suspend-types.ts";

const hash = /^[a-f0-9]{64}$/;
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
const equal = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function identity(claim: SuspendClaim) {
  return {
    schemaVersion: 1,
    kind: "environment.suspend",
    operationId: claim.operationId,
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    regionId: claim.regionId,
    specRevision: claim.specRevision,
    specHash: claim.specHash,
    runtimeRevision: claim.runtimeRevision,
    clusterUid: claim.clusterUid,
    pooler:
      claim.pooler === null
        ? null
        : { uid: claim.pooler.uid, deploymentUid: claim.pooler.deploymentUid },
    ...(claim.runEpoch === undefined ? {} : { runEpoch: claim.runEpoch }),
  };
}
function privateEntry(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("suspend_journal_path_not_private");
}
export class SuspendJournal {
  readonly claim: SuspendClaim;
  private readonly path: string;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string, claim: SuspendClaim) {
    if (!path || path === ":memory:" || !validSuspendClaim(claim))
      throw new Error("suspend_journal_configuration_invalid");
    // Leases stay in memory; only the immutable operation projection is persisted.
    this.claim = Object.freeze({
      ...claim,
      ...(claim.pooler === null
        ? {}
        : { pooler: Object.freeze({ ...claim.pooler }) }),
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
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=64; CREATE TABLE IF NOT EXISTS suspend_state (name TEXT PRIMARY KEY, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL) STRICT;",
      );
      this.transaction(() => {
        const previous = this.load<unknown>("identity");
        const expected = identity(claim);
        if (previous !== null && !equal(previous, expected))
          throw new Error("suspend_journal_identity_mismatch");
        if (previous === null) {
          this.put("identity", expected);
          this.put("schema_version", 1);
        }
        if (this.load<number>("schema_version") !== 1)
          throw new Error("suspend_journal_schema_unsupported");
      });
      const seal = this.seal;
      if (seal !== null && !this.validSeal(seal))
        throw new Error("suspend_journal_corrupt");
    } catch (failure) {
      this.db.close();
      throw failure;
    }
  }
  private permissions(): void {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(this.path + suffix)) {
        privateEntry(this.path + suffix);
        chmodSync(this.path + suffix, 0o600);
      }
  }
  private transaction<T>(work: () => T): T {
    if (this.closed) throw new Error("suspend_journal_closed");
    this.db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const value = work();
      this.db.exec("COMMIT");
      committed = true;
      this.permissions();
      return value;
    } catch (failure) {
      if (!committed) this.db.exec("ROLLBACK");
      throw failure;
    }
  }
  private load<T>(name: string): T | null {
    const row = this.db
      .prepare(
        "SELECT payload_json, payload_hash FROM suspend_state WHERE name = ?",
      )
      .get(name) as { payload_json: string; payload_hash: string } | undefined;
    if (!row) return null;
    if (digest(row.payload_json) !== row.payload_hash)
      throw new Error("suspend_journal_corrupt");
    return JSON.parse(row.payload_json) as T;
  }
  private put(name: string, value: unknown): void {
    const payload = JSON.stringify(value);
    this.db
      .prepare(
        "INSERT INTO suspend_state VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET payload_json = excluded.payload_json, payload_hash = excluded.payload_hash",
      )
      .run(name, payload, digest(payload));
  }
  private validSeal(value: SuspendSeal): boolean {
    const binding = value?.binding;
    return (
      binding !== null &&
      typeof binding === "object" &&
      validRuntimeBinding(binding) &&
      binding.environmentId === this.claim.environmentId &&
      binding.projectId === this.claim.projectId &&
      binding.regionId === this.claim.regionId &&
      binding.specRevision === this.claim.specRevision &&
      binding.specHash === this.claim.specHash &&
      binding.clusterUid === this.claim.clusterUid &&
      binding.runEpoch === this.claim.runEpoch &&
      equal(binding.pooler ?? null, this.claim.pooler) &&
      typeof value.volumesHash === "string" &&
      hash.test(value.volumesHash)
    );
  }
  get seal(): SuspendSeal | null {
    return this.load<SuspendSeal>("seal");
  }
  capture(value: SuspendSeal): void {
    if (!this.validSeal(value)) throw new Error("suspend_seal_invalid");
    this.transaction(() => {
      const previous = this.seal;
      if (previous !== null && !equal(previous, value))
        throw new Error("suspend_seal_conflict");
      if (previous === null) {
        this.put("seal", value);
        this.put("stage", "stopping");
      }
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
function discoverBinding(
  claim: SuspendClaim,
  inventory: RuntimeInventory,
): RuntimeBinding {
  const binding: RuntimeBinding = {
    regionId: claim.regionId,
    environmentId: claim.environmentId,
    projectId: claim.projectId,
    specRevision: claim.specRevision,
    specHash: claim.specHash,
    namespace: `pgcf-${claim.environmentId.replaceAll("-", "")}`,
    namespaceUid: inventory.namespace.metadata.uid ?? "",
    clusterUid: claim.clusterUid,
    quotaUid: inventory.quota.metadata.uid ?? "",
    ...(claim.pooler === null ? {} : { pooler: { ...claim.pooler } }),
    ...(claim.runEpoch === undefined ? {} : { runEpoch: claim.runEpoch }),
  };
  if (!validRuntimeBinding(binding))
    throw new Error("suspend_binding_unproven");
  return binding;
}
export async function reconcileSuspend(
  journal: SuspendJournal,
  runtime: AllowanceRuntime,
  authorized: () => void,
): Promise<{
  suspended: boolean;
  observation?: SuspendObservation;
  reason?: "physical_verification_pending";
}> {
  try {
    authorized();
    const inventory = await runtime.inventory();
    authorized();
    const previous = journal.seal;
    const binding =
      previous?.binding ?? discoverBinding(journal.claim, inventory);
    if (!ownedInventory(inventory, binding)) return { suspended: false };
    const volumesHash = volumeHash(inventory, binding);
    if (previous !== null && previous.volumesHash !== volumesHash)
      return { suspended: false };
    authorized();
    journal.capture({ binding, volumesHash });
    authorized();
    if (
      !(await stopOwnedRuntime(
        runtime,
        binding,
        volumesHash,
        authorized,
        inventory,
      ))
    )
      return { suspended: false };
    authorized();
    // API absence can follow force deletion while node processes survive.
    // Keep the seal and predecessor observations; neither is physical proof.
    return { suspended: false, reason: "physical_verification_pending" };
  } catch {
    return { suspended: false };
  }
}
