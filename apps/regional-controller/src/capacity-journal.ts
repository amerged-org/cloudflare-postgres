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
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalCohort } from "./node-cohort.ts";
import { capacityQuotaSpecs } from "./capacity-quota-policy.ts";
import { PodRetirementJournal } from "./pod-retirement.ts";
import type { PodRetirementBinding } from "./pod-retirement.ts";
import { validRuntimeBinding } from "./allowance-journal.ts";
import type {
  CapacityAdmissionAttempt,
  CapacityConsumer,
  CapacityHandoff,
  CapacityNode,
  CapacityPlan,
  CapacityRef,
  CapacitySlotState,
  CapacitySnapshot,
  CapacityStorage,
} from "./capacity-types.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const positive = /^[1-9][0-9]{0,18}$/;
const dns = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const fail = () => new Error("capacity_journal_unproven");
const equal = (a: unknown, b: unknown) =>
  canonicalCohort(a) === canonicalCohort(b);
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const named = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length <= 253 &&
  v.split(".").every((part) => dns.test(part));
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> =>
  object(v) &&
  Object.keys(v).length === fields.length &&
  fields.every((key) => Object.hasOwn(v, key));
function validRef(value: unknown): value is CapacityRef {
  return (
    exact(value, ["name", "namespace", "uid", "resourceVersion"]) &&
    named(value.name) &&
    (value.namespace === "" ||
      (typeof value.namespace === "string" && dns.test(value.namespace))) &&
    typeof value.uid === "string" &&
    uuid.test(value.uid) &&
    typeof value.resourceVersion === "string" &&
    positive.test(value.resourceVersion)
  );
}
function validNode(value: unknown): value is CapacityNode {
  return (
    exact(value, [
      "name",
      "uid",
      "bootId",
      "topologyKey",
      "topologyValue",
      "vgUuid",
    ]) &&
    named(value.name) &&
    typeof value.uid === "string" &&
    uuid.test(value.uid) &&
    typeof value.bootId === "string" &&
    uuid.test(value.bootId) &&
    value.topologyKey === "openebs.io/nodename" &&
    named(value.topologyValue) &&
    (value.vgUuid === null ||
      (typeof value.vgUuid === "string" &&
        /^[A-Za-z0-9-]{1,128}$/.test(value.vgUuid)))
  );
}
function validStorage(value: unknown): value is CapacityStorage {
  return (
    exact(value, [
      "holdPvc",
      "pv",
      "lvmVolume",
      "csiHandle",
      "bytes",
      "storageClassName",
    ]) &&
    validRef(value.holdPvc) &&
    validRef(value.pv) &&
    validRef(value.lvmVolume) &&
    typeof value.csiHandle === "string" &&
    /^[A-Za-z0-9._:-]{1,253}$/.test(value.csiHandle) &&
    typeof value.bytes === "string" &&
    positive.test(value.bytes) &&
    named(value.storageClassName)
  );
}
// Keep the original acquisition receipt. Fresh Kubernetes versions are used
// separately for CAS; ordinary status updates never replace immutable custody.
function sameRef(a: CapacityRef, b: CapacityRef): boolean {
  return a.name === b.name && a.namespace === b.namespace && a.uid === b.uid;
}
function sameStorage(a: CapacityStorage, b: CapacityStorage | null): boolean {
  return (
    b !== null &&
    sameRef(a.holdPvc, b.holdPvc) &&
    sameRef(a.pv, b.pv) &&
    sameRef(a.lvmVolume, b.lvmVolume) &&
    a.csiHandle === b.csiHandle &&
    a.bytes === b.bytes &&
    a.storageClassName === b.storageClassName
  );
}
function validConsumer(value: unknown): value is CapacityConsumer {
  return (
    exact(
      value,
      object(value) && Object.hasOwn(value, "ownerChain")
        ? ["uid", "name", "namespace", "nodeUid", "specHash", "ownerChain"]
        : ["uid", "name", "namespace", "nodeUid", "specHash"],
    ) &&
    typeof value.uid === "string" &&
    uuid.test(value.uid) &&
    named(value.name) &&
    typeof value.namespace === "string" &&
    dns.test(value.namespace) &&
    typeof value.nodeUid === "string" &&
    uuid.test(value.nodeUid) &&
    typeof value.specHash === "string" &&
    sha.test(value.specHash) &&
    (value.ownerChain === undefined ||
      (Array.isArray(value.ownerChain) &&
        value.ownerChain.length >= 1 &&
        value.ownerChain.length <= 4 &&
        value.ownerChain.every(
          (o) =>
            exact(o, ["kind", "name", "uid"]) &&
            ["Cluster", "Job", "ReplicaSet", "Deployment", "Pooler"].includes(
              String(o.kind),
            ) &&
            named(o.name) &&
            typeof o.uid === "string" &&
            uuid.test(o.uid),
        )))
  );
}
function validAttempt(value: unknown): value is CapacityAdmissionAttempt {
  return (
    exact(value, ["id", "slotId", "name", "namespace", "podUid"]) &&
    typeof value.id === "string" &&
    uuid.test(value.id) &&
    typeof value.slotId === "string" &&
    dns.test(value.slotId) &&
    named(value.name) &&
    typeof value.namespace === "string" &&
    dns.test(value.namespace) &&
    (value.podUid === null ||
      (typeof value.podUid === "string" && uuid.test(value.podUid)))
  );
}
function validPlan(plan: CapacityPlan): boolean {
  if (
    !exact(plan, [
      "version",
      "binding",
      "namespace",
      "customerStorageClass",
      "holdNamespace",
      "holdStorageClassPrefix",
      "instances",
      "slots",
    ]) ||
    plan.version !== 1 ||
    !exact(plan.binding, [
      "installationId",
      "regionId",
      "operationId",
      "environmentId",
      "specRevision",
      "specHash",
      "runEpoch",
    ]) ||
    typeof plan.binding.installationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(plan.binding.installationId) ||
    ![
      plan.binding.regionId,
      plan.binding.operationId,
      plan.binding.environmentId,
    ].every((id) => typeof id === "string" && uuid.test(id)) ||
    plan.binding.specRevision !== 1 ||
    typeof plan.binding.specHash !== "string" ||
    !sha.test(plan.binding.specHash) ||
    (plan.binding.runEpoch !== null &&
      (typeof plan.binding.runEpoch !== "string" ||
        !positive.test(plan.binding.runEpoch))) ||
    plan.namespace !==
      "pgcf-" + plan.binding.environmentId.replaceAll("-", "") ||
    !named(plan.customerStorageClass) ||
    typeof plan.holdNamespace !== "string" ||
    !dns.test(plan.holdNamespace) ||
    !named(plan.holdStorageClassPrefix) ||
    !Number.isSafeInteger(plan.instances) ||
    plan.instances < 1 ||
    plan.instances > 32 ||
    !Array.isArray(plan.slots) ||
    plan.slots.length < 2 ||
    plan.slots.length > 34
  )
    return false;
  const names = new Set<string>(),
    reservations = new Set<string>(),
    volumes = new Set<string>();
  for (const slot of plan.slots) {
    if (
      !exact(slot, [
        "id",
        "kind",
        "maintenance",
        "reservationName",
        "holdPvcName",
        "cpuMilli",
        "memoryBytes",
        "cpuLimitMilli",
        "memoryLimitBytes",
        "volumeBytes",
      ]) ||
      typeof slot.id !== "string" ||
      !dns.test(slot.id) ||
      names.has(slot.id) ||
      !["database", "pooler"].includes(slot.kind) ||
      typeof slot.maintenance !== "boolean" ||
      typeof slot.reservationName !== "string" ||
      !dns.test(slot.reservationName) ||
      reservations.has(slot.reservationName) ||
      !Number.isSafeInteger(slot.cpuMilli) ||
      slot.cpuMilli < 1 ||
      slot.cpuMilli > 1_000_000_000 ||
      !Number.isSafeInteger(slot.cpuLimitMilli) ||
      slot.cpuLimitMilli < slot.cpuMilli ||
      slot.cpuLimitMilli > 1_000_000_000 ||
      typeof slot.memoryBytes !== "string" ||
      !positive.test(slot.memoryBytes) ||
      typeof slot.memoryLimitBytes !== "string" ||
      !positive.test(slot.memoryLimitBytes) ||
      BigInt(slot.memoryLimitBytes) < BigInt(slot.memoryBytes) ||
      (slot.kind === "database"
        ? typeof slot.holdPvcName !== "string" ||
          !dns.test(slot.holdPvcName) ||
          volumes.has(slot.holdPvcName) ||
          typeof slot.volumeBytes !== "string" ||
          !positive.test(slot.volumeBytes)
        : slot.holdPvcName !== null ||
          slot.volumeBytes !== null ||
          slot.maintenance)
    )
      return false;
    names.add(slot.id);
    reservations.add(slot.reservationName);
    if (slot.holdPvcName) volumes.add(slot.holdPvcName);
  }
  const databases = plan.slots.filter((slot) => slot.kind === "database");
  return (
    databases.length === plan.instances + 1 &&
    databases.filter((slot) => slot.maintenance).length === 1 &&
    plan.slots.filter((slot) => slot.kind === "pooler").length <= 1
  );
}
export function privateEntry(path: string, directory = false): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (!directory && stat.nlink !== 1)
  )
    throw fail();
  return stat;
}
export function privatePath(path: string): void {
  if (!isAbsolute(path) || path !== resolve(path) || path.length > 4096)
    throw fail();
  const root = parse(path).root;
  let current = root;
  for (const part of dirname(path).slice(root.length).split("/")) {
    if (!part) continue;
    current = join(current, part);
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail();
  }
  privateEntry(dirname(path), true);
}
export function sameIdentity(before: Stats, after: Stats): void {
  for (const field of ["dev", "ino", "uid", "mode"] as const)
    if (before[field] !== after[field]) throw fail();
  // Creating journal entries can change directory nlink. Regular files retain
  // their single-link requirement; never adopt a replacement directory identity.
  if (!before.isDirectory() && before.nlink !== after.nlink) throw fail();
}
function sealedRow(db: DatabaseSync): CapacitySnapshot {
  const rows = db
    .prepare("SELECT payload_json,payload_hash FROM capacity_state WHERE id=1")
    .all() as { payload_json: string; payload_hash: string }[];
  if (
    rows.length !== 1 ||
    Buffer.byteLength(rows[0]!.payload_json) > 1_048_576 ||
    digest(rows[0]!.payload_json) !== rows[0]!.payload_hash
  )
    throw fail();
  const value: unknown = JSON.parse(rows[0]!.payload_json);
  if (!object(value) || canonicalCohort(value) !== rows[0]!.payload_json)
    throw fail();
  return value as unknown as CapacitySnapshot;
}
function initial(plan: CapacityPlan): CapacitySnapshot {
  return {
    version: 2,
    revision: 1,
    plan: structuredClone(plan),
    phase: "pending",
    namespaceUid: null,
    clusterUid: null,
    poolerUid: null,
    quotaUid: null,
    podQuotaGate: null,
    nodeCohort: null,
    poolerDeploymentUid: null,
    retirementBindings: [],
    projectId: null,
    organizationId: null,
    slots: plan.slots.map((slot) => ({
      plan: structuredClone(slot),
      reservation: null,
      holdPvc: null,
      pv: null,
      lvmVolume: null,
      node: null,
      storage: null,
      targetPvc: null,
      handoff: null,
      handoffPhase: "none",
      consumers: [],
      retirements: [],
      computeReleased: false,
    })),
    attempts: [],
  };
}
function retirementScopeHash(
  state: CapacitySnapshot,
  slot: CapacitySlotState,
  consumer: CapacityConsumer,
  binding: PodRetirementBinding,
): string {
  return digest(
    canonicalCohort({
      plan: state.plan,
      namespaceUid: state.namespaceUid,
      clusterUid: state.clusterUid,
      poolerUid: binding.pooler?.uid ?? null,
      poolerDeploymentUid: binding.pooler?.deploymentUid ?? null,
      projectId: state.projectId,
      quotaUid: state.quotaUid,
      nodeCohort: state.nodeCohort,
      slot: slot.plan,
      reservation: slot.reservation,
      node: slot.node,
      storage: slot.storage,
      targetPvc: slot.targetPvc,
      consumer,
      binding,
    }),
  );
}
function validateState(state: CapacitySnapshot): void {
  if (
    !exact(state, [
      "version",
      "revision",
      "plan",
      "phase",
      "namespaceUid",
      "clusterUid",
      "poolerUid",
      "quotaUid",
      "podQuotaGate",
      "nodeCohort",
      "poolerDeploymentUid",
      "retirementBindings",
      "projectId",
      "organizationId",
      "slots",
      "attempts",
    ]) ||
    state.version !== 2 ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !validPlan(state.plan) ||
    ![
      "pending",
      "available",
      "materializing",
      "active",
      "releasing",
      "released",
    ].includes(state.phase) ||
    ![
      state.namespaceUid,
      state.clusterUid,
      state.poolerUid,
      state.quotaUid,
      state.poolerDeploymentUid,
      state.projectId,
      state.organizationId,
    ].every((id) => id === null || (typeof id === "string" && uuid.test(id))) ||
    !Array.isArray(state.slots) ||
    state.slots.length !== state.plan.slots.length ||
    !Array.isArray(state.attempts) ||
    state.attempts.length > 256
  )
    throw fail();
  if (state.podQuotaGate !== null) {
    const gate = state.podQuotaGate;
    const specs = capacityQuotaSpecs(state.plan);
    if (
      !exact(gate, [
        "binding",
        "namespaceUid",
        "clusterUid",
        "quota",
        "closedSpec",
        "openSpec",
        "phase",
        "appliedResourceVersion",
        "confirmedResourceVersion",
      ]) ||
      !equal(gate.binding, state.plan.binding) ||
      !uuid.test(gate.namespaceUid) ||
      gate.namespaceUid !== state.namespaceUid ||
      !uuid.test(gate.clusterUid) ||
      gate.clusterUid !== state.clusterUid ||
      !validRef(gate.quota) ||
      gate.quota.uid !== state.quotaUid ||
      gate.quota.name !== "database-resources" ||
      gate.quota.namespace !== state.plan.namespace ||
      !equal(gate.closedSpec, specs.closed) ||
      !equal(gate.openSpec, specs.open) ||
      !["opening", "applied", "open"].includes(gate.phase) ||
      (gate.phase === "opening"
        ? gate.appliedResourceVersion !== null
        : !positive.test(gate.appliedResourceVersion ?? "")) ||
      (gate.phase !== "open"
        ? gate.confirmedResourceVersion !== null
        : !positive.test(gate.confirmedResourceVersion ?? ""))
    )
      throw fail();
  }
  const uids = new Set<string>();
  if (
    state.nodeCohort !== null &&
    (!exact(state.nodeCohort, ["uid", "hash"]) ||
      !uuid.test(state.nodeCohort.uid) ||
      !sha.test(state.nodeCohort.hash))
  )
    throw fail();
  if (
    !Array.isArray(state.retirementBindings) ||
    state.retirementBindings.length > 4096 ||
    new Set(state.retirementBindings.map((b) => b.podUid)).size !==
      state.retirementBindings.length ||
    state.retirementBindings.some(
      (b) =>
        !exact(b, ["podUid", "binding"]) ||
        !uuid.test(b.podUid) ||
        !validRuntimeBinding(b.binding) ||
        !uuid.test(b.binding.operationId) ||
        b.binding.installationId !== state.plan.binding.installationId ||
        b.binding.regionId !== state.plan.binding.regionId ||
        b.binding.environmentId !== state.plan.binding.environmentId ||
        b.binding.projectId !== state.projectId ||
        b.binding.specRevision !== state.plan.binding.specRevision ||
        b.binding.specHash !== state.plan.binding.specHash ||
        b.binding.runEpoch !== state.plan.binding.runEpoch ||
        b.binding.namespace !== state.plan.namespace ||
        b.binding.namespaceUid !== state.namespaceUid ||
        b.binding.clusterUid !== state.clusterUid ||
        b.binding.quotaUid !== state.quotaUid ||
        !equal(b.binding.nodeCohort, state.nodeCohort) ||
        (b.binding.pooler
          ? b.binding.pooler?.uid !== state.poolerUid ||
            b.binding.pooler?.deploymentUid !== state.poolerDeploymentUid
          : false),
    )
  )
    throw fail();
  for (let at = 0; at < state.slots.length; at++) {
    const slot = state.slots[at]!;
    if (
      !exact(slot, [
        "plan",
        "reservation",
        "holdPvc",
        "pv",
        "lvmVolume",
        "node",
        "storage",
        "targetPvc",
        "handoff",
        "handoffPhase",
        "consumers",
        "retirements",
        "computeReleased",
      ]) ||
      !equal(slot.plan, state.plan.slots[at]) ||
      (slot.reservation !== null &&
        (!validRef(slot.reservation) ||
          slot.reservation.name !== slot.plan.reservationName ||
          slot.reservation.namespace !== "")) ||
      (slot.holdPvc !== null &&
        (!validRef(slot.holdPvc) ||
          slot.plan.kind !== "database" ||
          slot.holdPvc.name !== slot.plan.holdPvcName ||
          slot.holdPvc.namespace !== state.plan.holdNamespace)) ||
      (slot.node !== null && !validNode(slot.node)) ||
      (slot.pv !== null &&
        (!validRef(slot.pv) ||
          slot.pv.namespace !== "" ||
          slot.plan.kind !== "database" ||
          !slot.holdPvc)) ||
      (slot.lvmVolume !== null &&
        (!validRef(slot.lvmVolume) || !slot.lvmVolume.namespace || !slot.pv)) ||
      (slot.storage !== null &&
        (!validStorage(slot.storage) ||
          slot.plan.kind !== "database" ||
          slot.storage.holdPvc.name !== slot.plan.holdPvcName ||
          slot.storage.holdPvc.namespace !== state.plan.holdNamespace ||
          slot.storage.pv.namespace !== "" ||
          !slot.pv ||
          !sameRef(slot.pv, slot.storage.pv) ||
          !slot.lvmVolume ||
          !sameRef(slot.lvmVolume, slot.storage.lvmVolume) ||
          slot.storage.bytes !== slot.plan.volumeBytes ||
          !slot.node?.vgUuid)) ||
      (slot.targetPvc !== null &&
        (!validRef(slot.targetPvc) ||
          slot.targetPvc.namespace !== state.plan.namespace)) ||
      !["none", "intent", "hold_released", "rebound"].includes(
        slot.handoffPhase,
      ) ||
      (slot.handoffPhase === "none"
        ? slot.handoff !== null || slot.targetPvc !== null
        : !slot.handoff ||
          !slot.targetPvc ||
          !equal(slot.targetPvc, slot.handoff.targetPvc)) ||
      !Array.isArray(slot.consumers) ||
      !Array.isArray(slot.retirements) ||
      slot.retirements.length > 128 ||
      slot.consumers.length > 128 ||
      typeof slot.computeReleased !== "boolean"
    )
      throw fail();
    for (const consumer of slot.consumers) {
      if (
        !validConsumer(consumer) ||
        consumer.namespace !== state.plan.namespace ||
        consumer.nodeUid !== slot.node?.uid ||
        uids.has(consumer.uid)
      )
        throw fail();
      uids.add(consumer.uid);
    }
    const retiredIds = new Set<string>();
    for (const receipt of slot.retirements) {
      const consumer = slot.consumers.find((c) => c.uid === receipt.podUid),
        binding = state.retirementBindings.find(
          (b) => b.podUid === receipt.podUid,
        );
      if (
        !exact(receipt, [
          "podUid",
          "proofHash",
          "scopeHash",
          "ownerKind",
          "ownerUid",
          "successorAttemptId",
        ]) ||
        !consumer ||
        !consumer.ownerChain ||
        !binding ||
        retiredIds.has(receipt.podUid) ||
        !sha.test(receipt.proofHash) ||
        receipt.scopeHash !==
          retirementScopeHash(state, slot, consumer, binding.binding) ||
        receipt.ownerKind !== consumer.ownerChain[0]!.kind ||
        receipt.ownerUid !== consumer.ownerChain[0]!.uid ||
        (receipt.successorAttemptId !== null &&
          !state.attempts.some(
            (a) =>
              a.id === receipt.successorAttemptId && a.slotId === slot.plan.id,
          ))
      )
        throw fail();
      retiredIds.add(receipt.podUid);
    }
  }
  const attempts = new Set<string>();
  for (const attempt of state.attempts) {
    const slot = state.slots.find(
      (candidate) => candidate.plan.id === attempt.slotId,
    );
    if (
      !validAttempt(attempt) ||
      attempt.namespace !== state.plan.namespace ||
      !slot ||
      attempts.has(attempt.id) ||
      (attempt.podUid !== null &&
        !slot.consumers.some(
          (consumer) =>
            consumer.uid === attempt.podUid && consumer.name === attempt.name,
        ))
    )
      throw fail();
    attempts.add(attempt.id);
  }
  if (
    state.phase === "released" &&
    state.slots.some((slot) => !slot.computeReleased)
  )
    throw fail();
}

// Custody precedes provider effects. A lost response may recover this same plan,
// never mint a new operation or infer released storage from an elapsed deadline.
export class CapacityJournal {
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly fileIdentity: Stats;
  private readonly directoryIdentity: Stats;
  private readonly plan: CapacityPlan;
  private closed = false;
  static openExisting(path: string): CapacityJournal {
    privatePath(path);
    const before = privateEntry(path);
    const directory = privateEntry(dirname(path), true);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(path + suffix)) privateEntry(path + suffix);
    const db = new DatabaseSync(path, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 5000,
    });
    let plan: CapacityPlan;
    try {
      db.exec(
        "PRAGMA query_only=ON;PRAGMA trusted_schema=OFF;PRAGMA temp_store=MEMORY;",
      );
      const state = sealedRow(db);
      validateState(state);
      plan = state.plan;
    } catch {
      throw fail();
    } finally {
      db.close();
    }
    sameIdentity(before, privateEntry(path));
    sameIdentity(directory, privateEntry(dirname(path), true));
    return new CapacityJournal(path, plan, 2);
  }
  constructor(path: string, plan: CapacityPlan, leaseEpoch = 1) {
    if (!validPlan(plan) || !Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1)
      throw fail();
    privatePath(path);
    this.plan = structuredClone(plan);
    this.path = path;
    this.directoryIdentity = privateEntry(dirname(path), true);
    const existed = existsSync(path);
    if (!existed) {
      if (leaseEpoch !== 1) throw fail();
      const file = openSync(
        path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      const directory = openSync(
        dirname(path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    this.fileIdentity = privateEntry(path);
    this.permissions();
    this.db = new DatabaseSync(path, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    try {
      // Existing custody must already contain the exact schema. Discovery and
      // reclaim never initialize or repair an empty/corrupt caller-selected file.
      if (existed) {
        const tables = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='capacity_state'",
          )
          .all();
        if (tables.length !== 1) throw fail();
      }
      this.db.exec(
        "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA fullfsync=ON;PRAGMA checkpoint_fullfsync=ON;PRAGMA trusted_schema=OFF;PRAGMA wal_autocheckpoint=64;",
      );
      if (!existed) {
        this.db.exec(
          "CREATE TABLE capacity_state(id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;CREATE TABLE capacity_release_authority(id INTEGER PRIMARY KEY CHECK(id=1),payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;",
        );
        this.transaction(() => this.persist(initial(plan)));
      }
      const state = this.snapshot();
      if (!equal(state.plan, this.plan)) throw fail();
    } catch {
      this.db.close();
      throw fail();
    }
  }
  private permissions(): void {
    if (this.closed) throw fail();
    privatePath(this.path);
    sameIdentity(this.fileIdentity, privateEntry(this.path));
    sameIdentity(
      this.directoryIdentity,
      privateEntry(dirname(this.path), true),
    );
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
  private persist(state: CapacitySnapshot): void {
    validateState(state);
    const raw = canonicalCohort(state);
    if (Buffer.byteLength(raw) > 1_048_576) throw fail();
    this.db
      .prepare(
        "INSERT INTO capacity_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,payload_hash=excluded.payload_hash",
      )
      .run(raw, digest(raw));
  }
  snapshot(): CapacitySnapshot {
    this.permissions();
    const state = sealedRow(this.db);
    validateState(state);
    if (!equal(state.plan, this.plan)) throw fail();
    return structuredClone(state);
  }
  private mutate(work: (state: CapacitySnapshot) => void): void {
    this.transaction(() => {
      const state = this.snapshot(),
        prior = canonicalCohort(state);
      work(state);
      if (canonicalCohort(state) === prior) return;
      if (state.revision >= Number.MAX_SAFE_INTEGER) throw fail();
      state.revision++;
      this.persist(state);
    });
  }
  private slot(state: CapacitySnapshot, id: string): CapacitySlotState {
    const found = state.slots.find((slot) => slot.plan.id === id);
    if (!found) throw fail();
    return found;
  }
  private allocatable(state: CapacitySnapshot): void {
    if (["releasing", "released"].includes(state.phase)) throw fail();
  }
  observeReservation(id: string, ref: CapacityRef): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !validRef(ref) ||
        ref.namespace !== "" ||
        ref.name !== slot.plan.reservationName ||
        (slot.reservation && !sameRef(slot.reservation, ref))
      )
        throw fail();
      slot.reservation ??= structuredClone(ref);
    });
  }
  observeNode(id: string, node: CapacityNode): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !slot.reservation ||
        !validNode(node) ||
        (slot.node && !equal(slot.node, node))
      )
        throw fail();
      slot.node ??= structuredClone(node);
    });
  }
  observeStorageClaim(id: string, ref: CapacityRef): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !validRef(ref) ||
        slot.plan.kind !== "database" ||
        ref.namespace !== state.plan.holdNamespace ||
        ref.name !== slot.plan.holdPvcName ||
        (slot.holdPvc && !sameRef(slot.holdPvc, ref))
      )
        throw fail();
      slot.holdPvc ??= structuredClone(ref);
    });
  }
  observeVolumeIdentity(
    id: string,
    kind: "pv" | "lvmVolume",
    ref: CapacityRef,
  ): void {
    if (kind !== "pv" && kind !== "lvmVolume") throw fail();
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !validRef(ref) ||
        slot.plan.kind !== "database" ||
        !slot.holdPvc ||
        (kind === "pv" ? ref.namespace !== "" : !ref.namespace || !slot.pv) ||
        (slot[kind] && !sameRef(slot[kind], ref))
      )
        throw fail();
      slot[kind] ??= structuredClone(ref);
    });
  }
  observeHold(
    id: string,
    observed: {
      reservation: CapacityRef;
      node: CapacityNode;
      storage?: CapacityStorage;
    },
  ): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !validRef(observed.reservation) ||
        !validNode(observed.node) ||
        observed.reservation.name !== slot.plan.reservationName ||
        observed.reservation.namespace !== "" ||
        (slot.plan.kind === "database"
          ? !observed.storage || !validStorage(observed.storage)
          : observed.storage !== undefined)
      )
        throw fail();
      const next = {
        reservation: observed.reservation,
        node: observed.node,
        storage: observed.storage ?? null,
      };
      if (
        (slot.reservation && !sameRef(slot.reservation, next.reservation)) ||
        (slot.node && !equal(slot.node, next.node)) ||
        (slot.storage && !sameStorage(slot.storage, next.storage)) ||
        (slot.pv && (!next.storage || !sameRef(slot.pv, next.storage.pv))) ||
        (slot.lvmVolume &&
          (!next.storage ||
            !sameRef(slot.lvmVolume, next.storage.lvmVolume))) ||
        (slot.holdPvc &&
          (!next.storage || !sameRef(slot.holdPvc, next.storage.holdPvc)))
      )
        throw fail();
      slot.reservation ??= structuredClone(next.reservation);
      slot.node ??= structuredClone(next.node);
      slot.storage ??= structuredClone(next.storage);
      if (next.storage) {
        slot.holdPvc ??= structuredClone(next.storage.holdPvc);
        slot.pv ??= structuredClone(next.storage.pv);
        slot.lvmVolume ??= structuredClone(next.storage.lvmVolume);
      }
    });
  }
  bindRuntime(value: {
    namespaceUid: string;
    clusterUid?: string;
    poolerUid?: string;
    quotaUid?: string;
    poolerDeploymentUid?: string;
    nodeCohort?: { uid: string; hash: string };
    projectId?: string;
    organizationId?: string;
  }): void {
    this.mutate((state) => {
      this.allocatable(state);
      for (const key of [
        "namespaceUid",
        "clusterUid",
        "poolerUid",
        "quotaUid",
        "poolerDeploymentUid",
        "projectId",
        "organizationId",
      ] as const) {
        const next = value[key];
        if (next === undefined) continue;
        if (!uuid.test(next) || (state[key] !== null && state[key] !== next))
          throw fail();
        state[key] = next;
      }
      if (state.clusterUid && !state.namespaceUid) throw fail();
      if (value.nodeCohort) {
        if (
          !uuid.test(value.nodeCohort.uid) ||
          !sha.test(value.nodeCohort.hash) ||
          (state.nodeCohort && !equal(state.nodeCohort, value.nodeCohort))
        )
          throw fail();
        state.nodeCohort ??= structuredClone(value.nodeCohort);
      }
    });
  }
  beginPodQuotaOpening(
    quota: CapacityRef,
    closedSpec: Record<string, unknown>,
  ): void {
    this.mutate((state) => {
      this.allocatable(state);
      const specs = capacityQuotaSpecs(state.plan);
      if (
        !["materializing", "active"].includes(state.phase) ||
        !state.namespaceUid ||
        !state.clusterUid ||
        !validRef(quota) ||
        quota.uid !== state.quotaUid ||
        quota.namespace !== state.plan.namespace ||
        quota.name !== "database-resources" ||
        !equal(closedSpec, specs.closed) ||
        state.slots.some(
          (slot) =>
            !slot.reservation ||
            !slot.node ||
            (slot.plan.kind === "database" && !slot.storage),
        ) ||
        state.slots.find((slot) => slot.plan.id === "database-0")
          ?.handoffPhase !== "rebound"
      )
        throw fail();
      if (state.podQuotaGate) {
        if (!sameRef(state.podQuotaGate.quota, quota)) throw fail();
        return;
      }
      if (
        state.phase !== "materializing" ||
        state.attempts.length !== 0 ||
        state.slots.some((slot) => slot.consumers.length !== 0)
      )
        throw fail();
      state.podQuotaGate = {
        binding: structuredClone(state.plan.binding),
        namespaceUid: state.namespaceUid,
        clusterUid: state.clusterUid,
        quota: structuredClone(quota),
        closedSpec: structuredClone(specs.closed),
        openSpec: structuredClone(specs.open),
        phase: "opening",
        appliedResourceVersion: null,
        confirmedResourceVersion: null,
      };
    });
  }
  recordPodQuotaApplied(
    quota: CapacityRef,
    observedSpec: Record<string, unknown>,
  ): void {
    this.mutate((state) => {
      this.allocatable(state);
      const gate = state.podQuotaGate;
      if (
        !["materializing", "active"].includes(state.phase) ||
        !gate ||
        !validRef(quota) ||
        !sameRef(gate.quota, quota) ||
        !equal(observedSpec, gate.openSpec)
      )
        throw fail();
      if (gate.phase !== "opening") return;
      gate.phase = "applied";
      gate.appliedResourceVersion = quota.resourceVersion;
    });
  }
  confirmPodQuotaOpening(
    quota: CapacityRef,
    observedSpec: Record<string, unknown>,
  ): void {
    this.mutate((state) => {
      this.allocatable(state);
      const gate = state.podQuotaGate;
      if (
        !["materializing", "active"].includes(state.phase) ||
        !gate ||
        gate.phase === "opening" ||
        !validRef(quota) ||
        !sameRef(gate.quota, quota) ||
        !equal(observedSpec, gate.openSpec)
      )
        throw fail();
      if (gate.phase === "open") return;
      gate.phase = "open";
      gate.confirmedResourceVersion = quota.resourceVersion;
    });
  }
  bindRetirementScope(podUid: string, binding: PodRetirementBinding): void {
    this.mutate((state) => {
      if (
        !["materializing", "active"].includes(state.phase) ||
        !state.slots.some((slot) =>
          slot.consumers.some((c) => c.uid === podUid),
        ) ||
        !uuid.test(binding.operationId) ||
        binding.installationId !== state.plan.binding.installationId ||
        binding.regionId !== state.plan.binding.regionId ||
        binding.environmentId !== state.plan.binding.environmentId ||
        binding.projectId !== state.projectId ||
        binding.specRevision !== state.plan.binding.specRevision ||
        binding.specHash !== state.plan.binding.specHash ||
        binding.runEpoch !== state.plan.binding.runEpoch ||
        binding.namespace !== state.plan.namespace ||
        binding.namespaceUid !== state.namespaceUid ||
        binding.clusterUid !== state.clusterUid ||
        !state.quotaUid ||
        binding.quotaUid !== state.quotaUid ||
        !state.nodeCohort ||
        !equal(binding.nodeCohort, state.nodeCohort) ||
        (state.poolerUid
          ? binding.pooler?.uid !== state.poolerUid ||
            binding.pooler?.deploymentUid !== state.poolerDeploymentUid
          : binding.pooler !== undefined)
      )
        throw fail();
      const previous = state.retirementBindings.find(
        (v) => v.podUid === podUid,
      );
      if (previous) {
        if (!equal(previous.binding, binding)) throw fail();
        return;
      }
      if (state.retirementBindings.length >= 4096) throw fail();
      state.retirementBindings.push({
        podUid,
        binding: structuredClone(binding),
      });
    });
  }
  retireConsumer(
    slotId: string,
    podUid: string,
    retirement: PodRetirementJournal,
  ): boolean {
    const state = this.snapshot(),
      slot = this.slot(state, slotId),
      consumer = slot.consumers.find((c) => c.uid === podUid);
    if (
      !(retirement instanceof PodRetirementJournal) ||
      !["materializing", "active"].includes(state.phase) ||
      !consumer ||
      !consumer.ownerChain ||
      slot.computeReleased ||
      !slot.reservation ||
      !slot.node ||
      state.attempts.some((a) => a.slotId === slotId && a.podUid === null)
    )
      return false;
    const expected = state.retirementBindings.find((b) => b.podUid === podUid);
    const record = retirement.roster?.find((r) => r.uid === podUid),
      proof = retirement.proof(podUid);
    if (
      !expected ||
      !record ||
      !proof ||
      proof.version !== 1 ||
      proof.podUid !== podUid ||
      !equal(proof.record, record) ||
      !equal(proof.binding, expected.binding) ||
      record.name !== consumer.name ||
      record.nodeUid !== consumer.nodeUid ||
      record.nodeName !== slot.node.name ||
      record.bootId !== slot.node.bootId ||
      record.specHash !== consumer.specHash ||
      !equal(record.ownerChain, consumer.ownerChain)
    )
      return false;
    const { evidenceHash, ...body } = proof;
    if (
      !sha.test(evidenceHash) ||
      digest(canonicalCohort(body)) !== evidenceHash
    )
      return false;
    const scopeHash = retirementScopeHash(
      state,
      slot,
      consumer,
      expected.binding,
    );
    this.mutate((current) => {
      if (current.revision !== state.revision) throw fail();
      const currentSlot = this.slot(current, slotId),
        previous = currentSlot.retirements.find((r) => r.podUid === podUid);
      if (previous) {
        if (
          previous.proofHash !== evidenceHash ||
          previous.scopeHash !== scopeHash
        )
          throw fail();
        return;
      }
      currentSlot.retirements.push({
        podUid,
        proofHash: evidenceHash,
        scopeHash,
        ownerKind: consumer.ownerChain![0]!.kind,
        ownerUid: consumer.ownerChain![0]!.uid,
        successorAttemptId: null,
      });
    });
    return true;
  }
  available(): void {
    this.mutate((state) => {
      this.allocatable(state);
      if (
        state.slots.some(
          (slot) =>
            !slot.reservation ||
            !slot.node ||
            (slot.plan.kind === "database" && !slot.storage),
        )
      )
        throw fail();
      if (state.phase === "pending") state.phase = "available";
    });
  }
  beginEffects(): void {
    this.mutate((state) => {
      this.allocatable(state);
      if (state.phase === "pending") throw fail();
      if (state.phase === "available") state.phase = "materializing";
    });
  }
  handoff(id: string, intent: CapacityHandoff): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !["materializing", "active"].includes(state.phase) ||
        !slot.storage ||
        !state.namespaceUid ||
        !validRef(intent.targetPvc) ||
        intent.targetPvc.namespace !== state.plan.namespace ||
        !exact(intent, [
          "operator",
          "targetPvc",
          "oldClaimRef",
          "newClaimRef",
        ]) ||
        typeof intent.operator !== "string" ||
        !/^[A-Za-z0-9:._-]{1,253}$/.test(intent.operator) ||
        !object(intent.oldClaimRef) ||
        !object(intent.newClaimRef) ||
        intent.oldClaimRef.uid !== slot.storage.holdPvc.uid ||
        intent.oldClaimRef.name !== slot.storage.holdPvc.name ||
        intent.oldClaimRef.namespace !== slot.storage.holdPvc.namespace ||
        intent.newClaimRef.uid !== intent.targetPvc.uid ||
        intent.newClaimRef.name !== intent.targetPvc.name ||
        intent.newClaimRef.namespace !== intent.targetPvc.namespace ||
        (slot.handoff && !equal(slot.handoff, intent))
      )
        throw fail();
      if (!slot.handoff) {
        slot.handoff = structuredClone(intent);
        slot.targetPvc = structuredClone(intent.targetPvc);
        slot.handoffPhase = "intent";
      }
    });
  }
  handoffProgress(id: string, phase: "hold_released" | "rebound"): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !slot.handoff ||
        !slot.storage ||
        (phase !== "hold_released" && phase !== "rebound") ||
        (phase === "hold_released"
          ? !["intent", "hold_released"].includes(slot.handoffPhase)
          : !["hold_released", "rebound"].includes(slot.handoffPhase))
      )
        throw fail();
      slot.handoffPhase = phase;
    });
  }
  admitAttempt(attempt: CapacityAdmissionAttempt): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, attempt.slotId);
      if (
        !["materializing", "active"].includes(state.phase) ||
        !state.namespaceUid ||
        !state.clusterUid ||
        !validAttempt(attempt) ||
        attempt.namespace !== state.plan.namespace ||
        attempt.podUid !== null ||
        !slot.reservation ||
        !slot.node
      )
        throw fail();
      const previous = state.attempts.find((item) => item.id === attempt.id);
      if (previous) {
        if (
          previous.podUid &&
          slot.retirements.some((r) => r.podUid === previous.podUid)
        )
          throw fail();
        if (!equal({ ...previous, podUid: null }, attempt)) throw fail();
        return;
      }
      if (
        state.attempts.length >= 256 ||
        state.attempts.some(
          (item) =>
            item.slotId === attempt.slotId &&
            (item.podUid === null ||
              !slot.retirements.some((r) => r.podUid === item.podUid)),
        )
      )
        throw fail();
      const predecessor = state.attempts
        .filter((a) => a.slotId === attempt.slotId && a.podUid !== null)
        .at(-1);
      if (predecessor) {
        const receipt = slot.retirements.find(
          (r) => r.podUid === predecessor.podUid,
        );
        if (!receipt || receipt.successorAttemptId !== null) throw fail();
        receipt.successorAttemptId = attempt.id;
      }
      state.attempts.push(structuredClone(attempt));
    });
  }
  observeComputeConsumer(
    id: string,
    consumer: CapacityConsumer,
    attemptId?: string,
  ): void {
    this.mutate((state) => {
      this.allocatable(state);
      const slot = this.slot(state, id);
      if (
        !validConsumer(consumer) ||
        consumer.namespace !== state.plan.namespace ||
        consumer.nodeUid !== slot.node?.uid ||
        !state.clusterUid
      )
        throw fail();
      const prior = slot.consumers.find((item) => item.uid === consumer.uid);
      if (slot.retirements.some((r) => r.podUid === consumer.uid)) throw fail();
      if (prior) {
        if (!equal(prior, consumer)) throw fail();
        return;
      }
      const attempt = state.attempts.find((item) => item.id === attemptId);
      if (
        !attempt ||
        attempt.slotId !== id ||
        attempt.name !== consumer.name ||
        attempt.namespace !== consumer.namespace ||
        attempt.podUid !== null ||
        state.slots.some((item) =>
          item.consumers.some((previous) => previous.uid === consumer.uid),
        ) ||
        slot.consumers.length >= 128
      )
        throw fail();
      attempt.podUid = consumer.uid;
      slot.consumers.push(structuredClone(consumer));
      state.phase = "active";
    });
  }
  beginComputeRelease(): void {
    this.mutate((state) => {
      if (state.phase !== "released") state.phase = "releasing";
    });
  }
  authorizeComputeRelease(retirement: PodRetirementJournal): CapacityRef[] {
    this.beginComputeRelease();
    const state = this.snapshot();
    if (
      !(retirement instanceof PodRetirementJournal) ||
      !state.namespaceUid ||
      !state.clusterUid ||
      !state.projectId ||
      !state.plan.binding.runEpoch ||
      state.attempts.some((attempt) => attempt.podUid === null)
    )
      throw fail();
    const consumers = state.slots.flatMap((slot) => slot.consumers),
      roster = retirement.roster;
    if (
      !roster ||
      consumers.length < 1 ||
      roster.length !== consumers.length ||
      new Set(consumers.map((item) => item.uid)).size !== consumers.length
    )
      throw fail();
    let retirementBinding: unknown = null;
    const proofHashes: { podUid: string; evidenceHash: string }[] = [];
    for (const consumer of consumers) {
      const slot = state.slots.find((item) =>
        item.consumers.some((record) => record.uid === consumer.uid),
      )!;
      const record = roster.find((item) => item.uid === consumer.uid),
        proof = retirement.proof(consumer.uid);
      if (
        !record ||
        !proof ||
        proof.version !== 1 ||
        proof.podUid !== consumer.uid ||
        !equal(proof.record, record) ||
        record.name !== consumer.name ||
        record.nodeUid !== consumer.nodeUid ||
        record.nodeName !== slot.node?.name ||
        record.bootId !== slot.node?.bootId ||
        record.specHash !== consumer.specHash ||
        !uuid.test(proof.binding.operationId) ||
        proof.binding.installationId !== state.plan.binding.installationId ||
        proof.binding.regionId !== state.plan.binding.regionId ||
        proof.binding.environmentId !== state.plan.binding.environmentId ||
        proof.binding.projectId !== state.projectId ||
        proof.binding.specRevision !== state.plan.binding.specRevision ||
        proof.binding.specHash !== state.plan.binding.specHash ||
        proof.binding.runEpoch !== state.plan.binding.runEpoch ||
        proof.binding.namespace !== state.plan.namespace ||
        proof.binding.namespaceUid !== state.namespaceUid ||
        proof.binding.clusterUid !== state.clusterUid ||
        (retirementBinding !== null && !equal(retirementBinding, proof.binding))
      )
        throw fail();
      const { evidenceHash, ...body } = proof;
      if (
        !sha.test(evidenceHash) ||
        digest(canonicalCohort(body)) !== evidenceHash
      )
        throw fail();
      retirementBinding = proof.binding;
      proofHashes.push({ podUid: consumer.uid, evidenceHash });
    }
    // Proof custody is sealed before a caller can delete any Reservation. The
    // irreversible latch alone never authorizes marking compute released.
    const authority = {
      plan: state.plan,
      namespaceUid: state.namespaceUid,
      clusterUid: state.clusterUid,
      projectId: state.projectId,
      retirementBinding,
      consumers,
      attempts: state.attempts,
      reservations: state.slots.map((slot) => slot.reservation),
      proofHashes,
    };
    this.transaction(() => {
      const current = this.snapshot();
      if (current.revision !== state.revision) throw fail();
      const raw = canonicalCohort(authority),
        row = this.db
          .prepare(
            "SELECT payload_json,payload_hash FROM capacity_release_authority WHERE id=1",
          )
          .get() as { payload_json: string; payload_hash: string } | undefined;
      if (row) {
        if (
          digest(row.payload_json) !== row.payload_hash ||
          row.payload_json !== raw
        )
          throw fail();
      } else {
        this.db
          .prepare("INSERT INTO capacity_release_authority VALUES(1,?,?)")
          .run(raw, digest(raw));
        current.revision++;
        this.persist(current);
      }
    });
    return state.slots
      .filter((slot) => !slot.computeReleased)
      .map((slot) => {
        if (!slot.reservation) throw fail();
        return structuredClone(slot.reservation);
      });
  }
  recordComputeReleased(id: string, uid: string): void {
    this.mutate((state) => {
      const slot = this.slot(state, id);
      const row = this.db
        .prepare(
          "SELECT payload_json,payload_hash FROM capacity_release_authority WHERE id=1",
        )
        .get() as { payload_json: string; payload_hash: string } | undefined;
      if (
        !row ||
        Buffer.byteLength(row.payload_json) > 1_048_576 ||
        digest(row.payload_json) !== row.payload_hash
      )
        throw fail();
      const authority: unknown = JSON.parse(row.payload_json);
      if (
        !object(authority) ||
        !equal(authority.plan, state.plan) ||
        authority.namespaceUid !== state.namespaceUid ||
        authority.clusterUid !== state.clusterUid ||
        authority.projectId !== state.projectId ||
        !equal(
          authority.consumers,
          state.slots.flatMap((item) => item.consumers),
        ) ||
        !equal(authority.attempts, state.attempts) ||
        !equal(
          authority.reservations,
          state.slots.map((item) => item.reservation),
        ) ||
        !["releasing", "released"].includes(state.phase) ||
        slot.reservation?.uid !== uid
      )
        throw fail();
      slot.computeReleased = true;
      if (state.slots.every((item) => item.computeReleased))
        state.phase = "released";
    });
  }
  close(): void {
    if (this.closed) return;
    this.permissions();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.permissions();
    this.db.close();
    this.closed = true;
  }
}
