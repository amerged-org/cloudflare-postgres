// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type { ExecutionSpec, Resource } from "./types.ts";

export interface BackupBinding {
  namespaceUid: string;
  clusterUid: string;
  specHash: string;
  objectStoreUid: string;
  objectStoreGeneration: number;
  objectStoreSpecHash: string;
  backupName: string;
  backupSpecHash: string;
}
export interface BackupDispatch {
  version: 1;
  nonce: string;
  leaseEpoch: number;
  binding: BackupBinding;
}
export interface BackupClaim {
  schemaVersion: 1;
  kind: "environment.backup";
  operationId: string;
  backupId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  regionId: string;
  specRevision: number;
  specHash: string;
  clusterUid: string;
  runtimeRevision: number;
  runEpoch?: string;
  spec: ExecutionSpec;
  dispatch: BackupDispatch | null;
  leaseToken: string;
  leaseEpoch: number;
  leaseExpiresAt: string;
}
export interface BackupArtifact {
  backupId: string;
  backupName: string;
  majorVersion: number;
  startedAt: string;
  stoppedAt: string;
  beginWal: string;
  endWal: string;
  beginLSN: string;
  endLSN: string;
  online: true;
  pluginMetadata: {
    timeline: string;
    version: "0.15.0";
    name: "barman-cloud.cloudnative-pg.io";
    displayName: "BarmanCloudInstance";
    clusterUID: string;
    pluginName: "barman-cloud.cloudnative-pg.io";
  };
}
export interface BackupObservation {
  namespaceUid: string;
  clusterUid: string;
  objectStoreUid: string;
  objectStoreGeneration: number;
  objectStoreSpecHash: string;
  backupResourceUid: string;
  backupResourceVersion: string;
  backupSpecHash: string;
  phase: "completed" | "failed";
  artifact: BackupArtifact | null;
  remoteObjectsVerified: false;
  restoreVerified: false;
}
export interface BackupRuntime {
  read(
    kind: "Namespace" | "Cluster" | "ObjectStore" | "Backup",
    namespace: string,
    name: string,
  ): Promise<Resource | null>;
  create(resource: Resource): Promise<Resource>;
}
export interface BackupControl {
  claim(leaseSeconds: number): Promise<BackupClaim | null>;
  renew(claim: BackupClaim, leaseSeconds: number): Promise<string>;
  dispatch(
    claim: BackupClaim,
    nonce: string,
    binding: BackupBinding,
  ): Promise<{ dispatch: BackupDispatch; created: boolean }>;
  result(claim: BackupClaim, observation: BackupObservation): Promise<void>;
}
export interface BackupAttempt {
  createAttempted: boolean;
  resourceUid: string | null;
}
export function backupCanonical(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, sorted(child)]),
      );
    return item;
  };
  return JSON.stringify(sorted(value));
}
export function backupHash(value: unknown): string {
  return createHash("sha256").update(backupCanonical(value)).digest("hex");
}
export function backupName(id: string): string {
  return `backup-${id.replaceAll("-", "")}`;
}
export function backupSpec(): Record<string, unknown> {
  return {
    cluster: { name: "database" },
    target: "primary",
    method: "plugin",
    pluginConfiguration: { name: "barman-cloud.cloudnative-pg.io" },
  };
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
export function backupFields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}
export function validBackupBinding(value: unknown): value is BackupBinding {
  return (
    backupFields(value, [
      "namespaceUid",
      "clusterUid",
      "specHash",
      "objectStoreUid",
      "objectStoreGeneration",
      "objectStoreSpecHash",
      "backupName",
      "backupSpecHash",
    ]) &&
    [value.namespaceUid, value.clusterUid, value.objectStoreUid].every(
      (item) => typeof item === "string" && uuid.test(item),
    ) &&
    [value.specHash, value.objectStoreSpecHash, value.backupSpecHash].every(
      (item) => typeof item === "string" && hashPattern.test(item),
    ) &&
    Number.isSafeInteger(value.objectStoreGeneration) &&
    (value.objectStoreGeneration as number) > 0 &&
    typeof value.backupName === "string" &&
    /^backup-[a-f0-9]{32}$/.test(value.backupName)
  );
}
export function validBackupDispatch(value: unknown): value is BackupDispatch {
  return (
    backupFields(value, ["version", "nonce", "leaseEpoch", "binding"]) &&
    value.version === 1 &&
    typeof value.nonce === "string" &&
    uuid.test(value.nonce) &&
    Number.isSafeInteger(value.leaseEpoch) &&
    (value.leaseEpoch as number) > 0 &&
    validBackupBinding(value.binding)
  );
}
export function validBackupClaim(value: unknown): value is BackupClaim {
  if (
    !backupFields(
      value,
      [
        "schemaVersion",
        "kind",
        "operationId",
        "backupId",
        "organizationId",
        "projectId",
        "environmentId",
        "regionId",
        "specRevision",
        "specHash",
        "clusterUid",
        "runtimeRevision",
        "spec",
        "dispatch",
        "leaseToken",
        "leaseEpoch",
        "leaseExpiresAt",
      ],
      ["runEpoch"],
    ) ||
    value.schemaVersion !== 1 ||
    value.kind !== "environment.backup" ||
    ![
      value.operationId,
      value.backupId,
      value.organizationId,
      value.projectId,
      value.environmentId,
      value.regionId,
      value.clusterUid,
    ].every((item) => typeof item === "string" && uuid.test(item)) ||
    !Number.isSafeInteger(value.specRevision) ||
    (value.specRevision as number) < 1 ||
    !Number.isSafeInteger(value.runtimeRevision) ||
    (value.runtimeRevision as number) < 0 ||
    typeof value.specHash !== "string" ||
    !hashPattern.test(value.specHash) ||
    typeof value.leaseToken !== "string" ||
    !/^cplease_[A-Za-z0-9_-]{43}$/.test(value.leaseToken) ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    (value.leaseEpoch as number) < 1 ||
    typeof value.leaseExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.leaseExpiresAt)) ||
    (Object.hasOwn(value, "runEpoch") &&
      (typeof value.runEpoch !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(value.runEpoch))) ||
    (value.dispatch !== null && !validBackupDispatch(value.dispatch))
  )
    return false;
  const spec = value.spec as ExecutionSpec | null;
  if (
    !spec?.profile ||
    spec.regionId !== value.regionId ||
    spec.profileId !== spec.profile.id ||
    createHash("sha256").update(JSON.stringify(spec)).digest("hex") !==
      value.specHash ||
    !Number.isSafeInteger(spec.profile.instances) ||
    spec.profile.instances < 1 ||
    spec.profile.instances > 9 ||
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(
      spec.profile.postgresImage,
    ) ||
    !Number.isSafeInteger(spec.volumeGiB) ||
    spec.volumeGiB < 1 ||
    !Number.isSafeInteger(spec.profile.compute?.cpuMilli) ||
    spec.profile.compute.cpuMilli < 1 ||
    !Number.isSafeInteger(spec.profile.compute?.memoryMiB) ||
    spec.profile.compute.memoryMiB < 1 ||
    !spec.profile.backup ||
    !/^[1-9][0-9]{0,3}[dwm]$/.test(spec.profile.backup.retentionPolicy) ||
    !/^s3:\/\/[a-z0-9][a-z0-9.-]*(?:\/[a-zA-Z0-9/._-]*)?$/.test(
      spec.profile.backup.destinationPath,
    ) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(spec.profile.backup.region) ||
    Object.hasOwn(spec.profile, "executionFencing") !==
      Object.hasOwn(value, "runEpoch")
  )
    return false;
  try {
    const endpoint = new URL(spec.profile.backup.endpointURL);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.pathname !== "/" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.port
    )
      return false;
  } catch {
    return false;
  }
  if (value.dispatch !== null) {
    const binding = (value.dispatch as BackupDispatch).binding;
    if (
      binding.clusterUid !== value.clusterUid ||
      binding.specHash !== value.specHash ||
      binding.backupName !== backupName(value.backupId as string) ||
      binding.backupSpecHash !== backupHash(backupSpec())
    )
      return false;
  }
  return true;
}
