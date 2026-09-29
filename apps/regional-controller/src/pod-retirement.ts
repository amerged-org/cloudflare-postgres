// SPDX-License-Identifier: Apache-2.0
import type { RuntimeBinding } from "./allowance-types.ts";
import type { NodeCohortData } from "./node-cohort.ts";
import type { NodeObserverResult } from "./node-observer.ts";
import type { Resource } from "./types.ts";
import { canonicalCohort, validNodeCohortData } from "./node-cohort.ts";
import { validRuntimeBinding } from "./allowance-journal.ts";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
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
import { dirname, isAbsolute } from "node:path";

export interface PodRetirementRecord {
  uid: string;
  name: string;
  nodeName: string;
  nodeUid: string;
  bootId: string;
  specHash: string;
  regular: string[];
  init: { name: string; nativeSidecar: boolean; restartCount: number }[];
  ownerChain: { kind: string; name: string; uid: string }[];
  restartCounts: Record<string, number>;
  capturedTerminalJob: boolean;
}
export interface PodRetirementProof {
  version: 1;
  binding: PodRetirementBinding;
  podUid: string;
  record: PodRetirementRecord;
  evidenceHash: string;
  terminal: unknown;
  runtime: unknown;
}
export type PodRetirementBinding = RuntimeBinding & {
  operationId: string;
  installationId: string;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runtimeID = /^containerd:\/\/([a-f0-9]{64})$/;
const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const fail = () => new Error("pod_retirement_unproven");
const encode = (value: unknown) => canonicalCohort(value);
const hash = (value: unknown) =>
  createHash("sha256").update(encode(value)).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const same = (left: unknown, right: unknown) => encode(left) === encode(right);
function retirementIdentity(
  binding: PodRetirementBinding,
): PodRetirementBinding {
  return {
    operationId: binding.operationId,
    installationId: binding.installationId,
    regionId: binding.regionId,
    environmentId: binding.environmentId,
    projectId: binding.projectId,
    specRevision: binding.specRevision,
    specHash: binding.specHash,
    namespace: binding.namespace,
    namespaceUid: binding.namespaceUid,
    clusterUid: binding.clusterUid,
    quotaUid: binding.quotaUid,
    runEpoch: binding.runEpoch!,
    nodeCohort: {
      uid: binding.nodeCohort!.uid,
      hash: binding.nodeCohort!.hash,
    },
    ...(binding.pooler
      ? {
          pooler: {
            uid: binding.pooler.uid,
            deploymentUid: binding.pooler.deploymentUid,
          },
        }
      : {}),
  };
}
function matchesTimestamp(nanoseconds: string, timestamp: unknown): boolean {
  if (!/^[1-9][0-9]{0,18}$/.test(nanoseconds) || typeof timestamp !== "string")
    return false;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return false;
  // Kubernetes metav1.Time can truncate the CRI timestamp to whole seconds.
  const observed = BigInt(nanoseconds),
    lower = BigInt(milliseconds) * 1_000_000n;
  return observed >= lower && observed < lower + 1_000_000_000n;
}
function instantNs(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const parts =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]{1,9}))?Z$/.exec(value);
  if (!parts) return null;
  const seconds = Date.parse(parts[1] + "Z");
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    new Date(seconds).toISOString().slice(0, 19) !== parts[1]
  )
    return null;
  return BigInt(seconds) * 1_000_000n + BigInt((parts[2] ?? "").padEnd(9, "0"));
}
function names(containers: unknown): string[] {
  if (!Array.isArray(containers) || containers.length > 64) throw fail();
  const result = containers.map((item) => {
    const container = object(item);
    if (typeof container.name !== "string" || !label.test(container.name))
      throw fail();
    return container.name;
  });
  if (new Set(result).size !== result.length) throw fail();
  return result.sort();
}
function statuses(
  pod: Resource,
  field: string,
  expected: string[],
): Record<string, unknown>[] {
  const value = object(pod.status)[field];
  if (!Array.isArray(value) || value.length !== expected.length) throw fail();
  const found = value.map(object);
  if (!same(found.map((item) => item.name).sort(), expected)) throw fail();
  if (
    found.some(
      (item) =>
        !Number.isSafeInteger(item.restartCount) ||
        Number(item.restartCount) < 0,
    )
  )
    throw fail();
  return found;
}
function controller(resource: Resource): {
  kind: string;
  name: string;
  uid: string;
} {
  const refs = resource.metadata.ownerReferences;
  if (
    refs?.length !== 1 ||
    refs[0]?.controller !== true ||
    !refs[0].name ||
    !uuid.test(refs[0].uid)
  )
    throw fail();
  return { kind: refs[0].kind, name: refs[0].name, uid: refs[0].uid };
}
function terminalStatus(
  status: Record<string, unknown>,
): Record<string, unknown> {
  const state = object(status.state),
    terminated = object(state.terminated);
  if (
    Object.keys(state).filter((key) => state[key] !== undefined).length !== 1 ||
    !Number.isSafeInteger(terminated.exitCode) ||
    typeof status.containerID !== "string" ||
    !runtimeID.test(status.containerID) ||
    (terminated.containerID !== undefined &&
      terminated.containerID !== status.containerID) ||
    !terminated.startedAt ||
    !terminated.finishedAt
  )
    throw fail();
  const start = new Date(terminated.startedAt as string | Date),
    finish = new Date(terminated.finishedAt as string | Date);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(finish.getTime()) ||
    finish < start
  )
    throw fail();
  return {
    name: status.name,
    restartCount: status.restartCount,
    containerId: status.containerID,
    exitCode: terminated.exitCode,
    startedAt: start.toISOString(),
    finishedAt: finish.toISOString(),
  };
}
function privatePath(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw fail();
}
export class PodRetirementJournal {
  readonly finalizer: string;
  private readonly db: DatabaseSync;
  private readonly path: string;
  private readonly binding: PodRetirementBinding;
  private readonly now: () => number;
  private closed = false;
  constructor(
    path: string,
    binding: PodRetirementBinding,
    leaseEpoch = 1,
    now: () => number = Date.now,
  ) {
    if (
      !isAbsolute(path) ||
      !validRuntimeBinding(binding) ||
      !binding.runEpoch ||
      !binding.nodeCohort ||
      !uuid.test(binding.operationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.installationId) ||
      !Number.isSafeInteger(leaseEpoch) ||
      leaseEpoch < 1
    )
      throw fail();
    this.binding = retirementIdentity(binding);
    this.now = now;
    this.path = path;
    this.finalizer = `pgcf.io/retire-${binding.operationId}`;
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    privatePath(parent, true);
    if (!existsSync(path)) {
      if (leaseEpoch > 1) throw new Error("pod_retirement_history_missing");
      const file = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      fsyncSync(file);
      closeSync(file);
      const directory = openSync(parent, constants.O_RDONLY);
      fsyncSync(directory);
      closeSync(directory);
    }
    privatePath(path);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(path + suffix)) privatePath(path + suffix);
    this.db = new DatabaseSync(path, {
      timeout: 5000,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA fullfsync=ON;PRAGMA checkpoint_fullfsync=ON;CREATE TABLE IF NOT EXISTS retirement_state(name TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL) STRICT;",
      );
      this.transaction(() => {
        const prior = this.load<PodRetirementBinding>("binding");
        if (prior && !same(prior, this.binding))
          throw new Error("pod_retirement_identity_mismatch");
        if (!prior) {
          if (leaseEpoch > 1) throw new Error("pod_retirement_history_missing");
          this.put("binding", this.binding);
        }
        if (leaseEpoch > 1 && !this.load("roster"))
          throw new Error("pod_retirement_history_missing");
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private transaction<T>(work: () => T): T {
    if (this.closed) throw fail();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      for (const suffix of ["", "-wal", "-shm"])
        if (existsSync(this.path + suffix)) {
          privatePath(this.path + suffix);
          chmodSync(this.path + suffix, 0o600);
        }
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private load<T = unknown>(name: string): T | null {
    const row = this.db
      .prepare(
        "SELECT payload_json,payload_hash FROM retirement_state WHERE name=?",
      )
      .get(name) as { payload_json: string; payload_hash: string } | undefined;
    if (!row) return null;
    if (
      createHash("sha256").update(row.payload_json).digest("hex") !==
      row.payload_hash
    )
      throw fail();
    return JSON.parse(row.payload_json) as T;
  }
  private put(name: string, value: unknown): void {
    const payload = encode(value);
    if (Buffer.byteLength(payload, "utf8") > 65_536) throw fail();
    this.db
      .prepare("INSERT INTO retirement_state VALUES(?,?,?)")
      .run(name, payload, createHash("sha256").update(payload).digest("hex"));
  }
  get roster(): PodRetirementRecord[] | null {
    return this.load<PodRetirementRecord[]>("roster");
  }
  capture(
    pods: Resource[],
    cohort: NodeCohortData,
    owners: Resource[] = [],
  ): PodRetirementRecord[] {
    if (
      !validNodeCohortData(cohort, this.binding) ||
      hash(cohort) !== this.binding.nodeCohort!.hash ||
      pods.length < 1 ||
      pods.length > 128 ||
      owners.length > 512
    )
      throw fail();
    const records = pods
      .map((pod) => {
        if (
          pod.kind !== "Pod" ||
          pod.apiVersion !== "v1" ||
          pod.metadata.namespace !== this.binding.namespace ||
          !uuid.test(pod.metadata.uid ?? "") ||
          !pod.metadata.name ||
          pod.metadata.deletionTimestamp ||
          pod.metadata.finalizers?.includes(this.finalizer) ||
          !pod.spec ||
          pod.spec.hostPID === true ||
          (Array.isArray(pod.spec.ephemeralContainers) &&
            pod.spec.ephemeralContainers.length > 0)
        )
          throw fail();
        const node = cohort.nodes.find(
          (node) => node.name === pod.spec!.nodeName,
        );
        if (!node) throw fail();
        const direct = controller(pod),
          chain = [direct];
        if (direct.kind === "Cluster") {
          if (
            direct.uid !== this.binding.clusterUid ||
            direct.name !== "database"
          )
            throw fail();
        } else if (direct.kind === "Job" || direct.kind === "ReplicaSet") {
          const matches = owners.filter(
            (owner) =>
              owner.kind === direct.kind &&
              owner.metadata.namespace === this.binding.namespace &&
              owner.metadata.name === direct.name &&
              owner.metadata.uid === direct.uid,
          );
          if (matches.length !== 1) throw fail();
          const ancestor = controller(matches[0]!);
          chain.push(ancestor);
          if (
            direct.kind === "Job"
              ? ancestor.kind !== "Cluster" ||
                ancestor.uid !== this.binding.clusterUid ||
                ancestor.name !== "database"
              : ancestor.kind !== "Deployment" ||
                ancestor.uid !== this.binding.pooler?.deploymentUid ||
                ancestor.name !== "database-pool-rw"
          )
            throw fail();
        } else throw fail();
        const regular = names(pod.spec.containers),
          initNames = names(pod.spec.initContainers ?? []);
        if (
          regular.length < 1 ||
          new Set([...regular, ...initNames]).size !==
            regular.length + initNames.length
        )
          throw fail();
        const normal = statuses(pod, "containerStatuses", regular),
          initial = initNames.length
            ? statuses(pod, "initContainerStatuses", initNames)
            : [];
        const counts = Object.fromEntries(
          [...normal, ...initial].map((status) => [
            String(status.name),
            Number(status.restartCount),
          ]),
        );
        const init = initNames.map((name) => {
          const spec = (pod.spec!.initContainers as unknown[])
            .map(object)
            .find((container) => container.name === name)!;
          if (
            spec.restartPolicy !== undefined &&
            spec.restartPolicy !== "Always"
          )
            throw fail();
          return {
            name,
            nativeSidecar: spec.restartPolicy === "Always",
            restartCount: counts[name]!,
          };
        });
        const terminal = ["Succeeded", "Failed"].includes(
          pod.status?.phase ?? "",
        );
        if (
          terminal &&
          (direct.kind !== "Job" ||
            pod.spec.restartPolicy !== "Never" ||
            init.some((container) => container.nativeSidecar))
        )
          throw fail();
        if (terminal) [...normal, ...initial].forEach(terminalStatus);
        const specBytes = encode(pod.spec);
        if (Buffer.byteLength(specBytes, "utf8") > 65_536) throw fail();
        return {
          uid: pod.metadata.uid!,
          name: pod.metadata.name,
          nodeName: node.name,
          nodeUid: node.uid,
          bootId: node.bootId,
          specHash: hash(pod.spec),
          regular,
          init,
          ownerChain: chain,
          restartCounts: counts,
          capturedTerminalJob: terminal,
        };
      })
      .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
    if (
      new Set(records.map((record) => record.uid)).size !== records.length ||
      new Set(records.map((record) => record.name)).size !== records.length
    )
      throw fail();
    return this.transaction(() => {
      const prior = this.roster;
      if (prior && !same(prior, records))
        throw new Error("pod_retirement_roster_conflict");
      if (!prior) this.put("roster", records);
      return prior ?? records;
    });
  }
  proof(uid: string): PodRetirementProof | null {
    return this.load<PodRetirementProof>("proof:" + uid);
  }
  prove(pod: Resource, result: NodeObserverResult): PodRetirementProof | null {
    try {
      const records = this.roster,
        record = records?.find((record) => record.uid === pod.metadata.uid);
      if (
        !record ||
        pod.kind !== "Pod" ||
        pod.metadata.namespace !== this.binding.namespace ||
        pod.metadata.name !== record.name ||
        pod.spec?.nodeName !== record.nodeName ||
        hash(pod.spec) !== record.specHash ||
        !same(controller(pod), record.ownerChain[0])
      )
        return null;
      const prior = this.proof(record.uid);
      if (
        !pod.metadata.deletionTimestamp ||
        (!prior && !pod.metadata.finalizers?.includes(this.finalizer)) ||
        !["Succeeded", "Failed"].includes(pod.status?.phase ?? "")
      )
        return null;
      const normal = statuses(pod, "containerStatuses", record.regular),
        initial = record.init.length
          ? statuses(
              pod,
              "initContainerStatuses",
              record.init.map((container) => container.name),
            )
          : [];
      const terminal = [...normal, ...initial].map(terminalStatus);
      if (
        [...normal, ...initial].some(
          (status) =>
            status.restartCount !== record.restartCounts[String(status.name)],
        )
      )
        return null;
      const envelope = result.envelope,
        snapshot = envelope?.snapshot,
        scope = snapshot?.scope;
      if (
        !snapshot ||
        result.probeHash !== hash(envelope) ||
        snapshot.version !== 1 ||
        scope?.installationId !== this.binding.installationId ||
        scope.regionId !== this.binding.regionId ||
        scope.nodeName !== record.nodeName ||
        scope.nodeUid !== record.nodeUid ||
        scope.expectedBootId !== record.bootId ||
        snapshot.bootId !== record.bootId ||
        envelope.observerNodeName !== record.nodeName ||
        !Array.isArray(snapshot.sandboxes) ||
        !Array.isArray(snapshot.containers) ||
        snapshot.sandboxes.length + snapshot.containers.length > 4096
      )
        return null;
      const started = instantNs(snapshot.startedAt),
        finished = instantNs(snapshot.finishedAt),
        deleting = instantNs(pod.metadata.deletionTimestamp),
        now = this.now();
      if (
        started === null ||
        finished === null ||
        deleting === null ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        finished < started ||
        finished - started > 30_000_000_000n ||
        started < deleting
      )
        return null;
      const current = BigInt(now) * 1_000_000n;
      if (finished > current || current - finished > 30_000_000_000n)
        return null;
      const original = new Set(records!.map((record) => record.uid));
      if (
        [...snapshot.sandboxes, ...snapshot.containers].some(
          (entry) =>
            entry.namespace === this.binding.namespace &&
            !original.has(entry.podUid),
        )
      )
        return null;
      const sandboxes = snapshot.sandboxes.filter(
          (sandbox) => sandbox.podUid === record.uid,
        ),
        containers = snapshot.containers.filter(
          (container) => container.podUid === record.uid,
        );
      if (
        sandboxes.some(
          (sandbox) =>
            sandbox.namespace !== this.binding.namespace ||
            sandbox.name !== record.name ||
            sandbox.state !== "not_ready",
        ) ||
        containers.some(
          (container) =>
            container.namespace !== this.binding.namespace ||
            container.state !== "exited" ||
            container.finishedAtUnixNs === "0" ||
            ![
              ...record.regular,
              ...record.init.map((container) => container.name),
            ].includes(container.name),
        )
      )
        return null;
      // Kubelet can collect every inactive sandbox and container after recording
      // retained terminal status. Partial remnants still require full correlation.
      if (sandboxes.length !== 0 || containers.length !== 0)
        for (const status of terminal) {
          const id = runtimeID.exec(String(status.containerId))?.[1],
            matches = containers.filter(
              (container) =>
                container.id === id &&
                container.name === status.name &&
                container.attempt === status.restartCount,
            ),
            match = matches[0];
          if (
            !id ||
            matches.length !== 1 ||
            !match ||
            !matchesTimestamp(match.startedAtUnixNs, status.startedAt) ||
            !matchesTimestamp(match.finishedAtUnixNs, status.finishedAt)
          )
            return null;
        }
      const body = {
        version: 1 as const,
        binding: this.binding,
        podUid: record.uid,
        record,
        terminal: {
          deletionTimestamp: pod.metadata.deletionTimestamp,
          phase: pod.status!.phase,
          containers: terminal,
        },
        runtime: {
          probeHash: result.probeHash,
          requestId: envelope.requestId,
          observerPodUid: envelope.observerPodUid,
          observerNamespace: envelope.observerNamespace,
          startedAt: snapshot.startedAt,
          finishedAt: snapshot.finishedAt,
          scope,
          bootId: snapshot.bootId,
          sandboxes,
          containers,
        },
      };
      const proof: PodRetirementProof = { ...body, evidenceHash: hash(body) };
      return this.transaction(() => {
        const previous = this.proof(record.uid);
        if (previous) return previous;
        this.put("proof:" + record.uid, proof);
        return proof;
      });
    } catch {
      return null;
    }
  }
  close(): void {
    if (this.closed) return;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
    this.closed = true;
  }
}
