// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import {
  backupCanonical,
  backupFields,
  backupHash,
  backupName,
  backupSpec,
  validBackupClaim,
  validBackupDispatch,
} from "./backup-types.ts";
import type {
  BackupArtifact,
  BackupAttempt,
  BackupBinding,
  BackupClaim,
  BackupControl,
  BackupObservation,
  BackupRuntime,
} from "./backup-types.ts";
import type { Resource } from "./types.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const plugin = "barman-cloud.cloudnative-pg.io";
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => contains(actual[index], item))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, item]) =>
        contains((actual as Record<string, unknown>)[key], item),
      )
    );
  return actual === expected;
}
function equal(a: unknown, b: unknown): boolean {
  return backupCanonical(a) === backupCanonical(b);
}
function identified(
  resource: Resource | null,
  kind: string,
  name: string,
  namespace: string,
): resource is Resource {
  return (
    resource !== null &&
    resource.kind === kind &&
    resource.metadata.name === name &&
    (resource.metadata.namespace ?? "") === namespace &&
    uuid.test(resource.metadata.uid ?? "") &&
    typeof resource.metadata.resourceVersion === "string" &&
    resource.metadata.resourceVersion.length > 0 &&
    !resource.metadata.deletionTimestamp
  );
}
function owned(resource: Resource, claim: BackupClaim): boolean {
  const annotations = resource.metadata.annotations ?? {};
  return (
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    resource.metadata.labels?.["pgcf.io/environment-id"] ===
      claim.environmentId &&
    resource.metadata.labels?.["pgcf.io/region-id"] === claim.regionId &&
    annotations["pgcf.io/spec-hash"] === claim.specHash
  );
}
function runMatches(resource: Resource, claim: BackupClaim): boolean {
  return (
    Object.hasOwn(resource.metadata.annotations ?? {}, "pgcf.io/run-epoch") ===
      Object.hasOwn(claim, "runEpoch") &&
    resource.metadata.annotations?.["pgcf.io/run-epoch"] === claim.runEpoch
  );
}
function cpu(milli: number): string {
  if (milli % 1000) return `${milli}m`;
  let value = milli / 1000,
    scale = 0;
  const units = ["", "k", "M"];
  while (value % 1000 === 0 && scale < units.length - 1) {
    value /= 1000;
    scale += 1;
  }
  return `${value}${units[scale]}`;
}
function memory(mib: number): string {
  let value = mib,
    scale = 0;
  const units = ["Mi", "Gi", "Ti", "Pi"];
  while (value % 1024 === 0 && scale < units.length - 1) {
    value /= 1024;
    scale += 1;
  }
  return `${value}${units[scale]}`;
}
function clusterMatches(cluster: Resource, claim: BackupClaim): boolean {
  const compute = {
    cpu: cpu(claim.spec.profile.compute.cpuMilli),
    memory: memory(claim.spec.profile.compute.memoryMiB),
  };
  return (
    cluster.apiVersion === "postgresql.cnpg.io/v1" &&
    cluster.metadata.uid === claim.clusterUid &&
    owned(cluster, claim) &&
    runMatches(cluster, claim) &&
    Number.isSafeInteger(cluster.metadata.generation) &&
    cluster.metadata.generation! > 0 &&
    cluster.metadata.annotations?.["cnpg.io/hibernation"] !== "on" &&
    contains(cluster.spec, {
      instances: claim.spec.profile.instances,
      imageName: claim.spec.profile.postgresImage,
      enableSuperuserAccess: false,
      bootstrap: {
        initdb: { database: "app", owner: "app", dataChecksums: true },
      },
      storage: {
        size: `${claim.spec.volumeGiB}Gi`,
        storageClass: claim.spec.profile.storage.storageClassName,
      },
      resources: { requests: compute, limits: compute },
      plugins: [
        {
          name: plugin,
          enabled: true,
          isWALArchiver: true,
          parameters: { barmanObjectName: "archive", serverName: "database" },
        },
      ],
    })
  );
}
function archiveMatches(store: Resource, claim: BackupClaim): boolean {
  const backup = claim.spec.profile.backup;
  const configuration = record(store.spec?.configuration);
  const sidecar = record(store.spec?.instanceSidecarConfiguration);
  // These are the only CRD-injected defaults in the selected plugin. Never
  // seal extra env/arguments that alter Barman outside the immutable profile.
  if (
    !backupFields(store.spec, [
      "configuration",
      "retentionPolicy",
      "instanceSidecarConfiguration",
    ]) ||
    !backupFields(
      sidecar,
      ["resources"],
      [
        "retentionPolicyIntervalSeconds",
        "logLevel",
        "env",
        "additionalContainerArgs",
      ],
    ) ||
    (Object.hasOwn(sidecar, "retentionPolicyIntervalSeconds") &&
      sidecar.retentionPolicyIntervalSeconds !== 1800) ||
    (Object.hasOwn(sidecar, "logLevel") && sidecar.logLevel !== "info") ||
    (Object.hasOwn(sidecar, "env") && !equal(sidecar.env, [])) ||
    (Object.hasOwn(sidecar, "additionalContainerArgs") &&
      !equal(sidecar.additionalContainerArgs, []))
  )
    return false;
  return (
    store.apiVersion === "barmancloud.cnpg.io/v1" &&
    owned(store, claim) &&
    Number.isSafeInteger(store.metadata.generation) &&
    store.metadata.generation! > 0 &&
    Object.keys(configuration).every((key) =>
      [
        "destinationPath",
        "endpointURL",
        "s3Credentials",
        "wal",
        "data",
      ].includes(key),
    ) &&
    equal(configuration.s3Credentials, {
      region: { name: "archive-credentials", key: "region" },
      accessKeyId: { name: "archive-credentials", key: "accessKeyId" },
      secretAccessKey: { name: "archive-credentials", key: "secretAccessKey" },
    }) &&
    equal(configuration.wal, { compression: "gzip" }) &&
    equal(configuration.data, { compression: "gzip" }) &&
    equal(sidecar.resources, {
      requests: { cpu: "25m", memory: "64Mi" },
      limits: { cpu: "100m", memory: "128Mi" },
    }) &&
    contains(store.spec, {
      configuration: {
        destinationPath: `${backup.destinationPath.replace(/\/+$/, "")}/${claim.environmentId}/`,
        endpointURL: backup.endpointURL,
      },
      retentionPolicy: backup.retentionPolicy,
    })
  );
}
function ready(cluster: Resource, claim: BackupClaim): boolean {
  return (
    (cluster.status?.readyInstances ?? 0) >= claim.spec.profile.instances &&
    typeof cluster.status?.currentPrimary === "string" &&
    /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(
      cluster.status.currentPrimary,
    ) &&
    cluster.status.conditions?.some(
      (condition) =>
        condition.type === "Ready" &&
        condition.status === "True" &&
        (condition.observedGeneration === undefined ||
          condition.observedGeneration === cluster.metadata.generation),
    ) === true
  );
}
function timestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical ===
    (value.includes(".") ? value : value.replace(/Z$/, ".000Z"))
    ? canonical
    : null;
}
function artifact(
  status: Record<string, unknown>,
  claim: BackupClaim,
): BackupArtifact | null {
  const metadata = status.pluginMetadata;
  const startedAt = timestamp(status.startedAt),
    stoppedAt = timestamp(status.stoppedAt);
  const lsn = (value: unknown) =>
    typeof value === "string" && /^[A-F0-9]{1,8}\/[A-F0-9]{1,8}$/.test(value);
  const wal = (value: unknown) =>
    typeof value === "string" && /^[A-F0-9]{24}$/.test(value);
  if (
    status.phase !== "completed" ||
    (status.method !== undefined && status.method !== "plugin") ||
    !Number.isSafeInteger(status.majorVersion) ||
    (status.majorVersion as number) < 10 ||
    (status.majorVersion as number) > 99 ||
    typeof status.backupId !== "string" ||
    !/^\d{8}T\d{6}$/.test(status.backupId) ||
    typeof status.backupName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(status.backupName) ||
    !startedAt ||
    !stoppedAt ||
    Date.parse(stoppedAt) < Date.parse(startedAt) ||
    Date.parse(stoppedAt) > Date.now() ||
    !wal(status.beginWal) ||
    !wal(status.endWal) ||
    !lsn(status.beginLSN) ||
    !lsn(status.endLSN) ||
    status.online !== true ||
    !backupFields(metadata, [
      "timeline",
      "version",
      "name",
      "displayName",
      "clusterUID",
      "pluginName",
    ]) ||
    typeof metadata.timeline !== "string" ||
    !/^[1-9][0-9]{0,9}$/.test(metadata.timeline) ||
    BigInt(metadata.timeline) > 0xffffffffn ||
    metadata.version !== "0.15.0" ||
    metadata.name !== plugin ||
    metadata.pluginName !== plugin ||
    metadata.displayName !== "BarmanCloudInstance" ||
    metadata.clusterUID !== claim.clusterUid
  )
    return null;
  const lsnValue = (value: string) => {
    const [high, low] = value.split("/");
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  if (lsnValue(status.endLSN as string) < lsnValue(status.beginLSN as string))
    return null;
  return {
    backupId: status.backupId,
    backupName: status.backupName,
    majorVersion: status.majorVersion as number,
    startedAt,
    stoppedAt,
    beginWal: status.beginWal as string,
    endWal: status.endWal as string,
    beginLSN: status.beginLSN as string,
    endLSN: status.endLSN as string,
    online: true,
    pluginMetadata: {
      timeline: metadata.timeline,
      version: "0.15.0",
      name: plugin,
      displayName: "BarmanCloudInstance",
      clusterUID: claim.clusterUid,
      pluginName: plugin,
    },
  };
}
function resourceMatches(resource: Resource, desired: Resource): boolean {
  return (
    resource.apiVersion === desired.apiVersion &&
    resource.kind === desired.kind &&
    resource.metadata.name === desired.metadata.name &&
    resource.metadata.namespace === desired.metadata.namespace &&
    !resource.metadata.deletionTimestamp &&
    uuid.test(resource.metadata.uid ?? "") &&
    typeof resource.metadata.resourceVersion === "string" &&
    equal(resource.spec, desired.spec) &&
    equal(
      resource.metadata.ownerReferences,
      desired.metadata.ownerReferences,
    ) &&
    Object.entries(desired.metadata.labels ?? {}).every(
      ([key, value]) => resource.metadata.labels?.[key] === value,
    ) &&
    Object.entries(desired.metadata.annotations ?? {}).every(
      ([key, value]) => resource.metadata.annotations?.[key] === value,
    )
  );
}

export async function reconcileBackup(
  runtime: BackupRuntime,
  control: Pick<BackupControl, "dispatch">,
  claim: BackupClaim,
  attempt: BackupAttempt,
  authorized: () => void,
): Promise<{ terminal: boolean; observation?: BackupObservation }> {
  authorized();
  if (!validBackupClaim(claim)) throw new Error("backup_claim_invalid");
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
  const read = async (
    kind: Parameters<BackupRuntime["read"]>[0],
    ns: string,
    name: string,
  ) => {
    authorized();
    const value = await runtime.read(kind, ns, name);
    authorized();
    return value;
  };
  const sources = async () => {
    const ns = await read("Namespace", "", namespace),
      cluster = await read("Cluster", namespace, "database"),
      store = await read("ObjectStore", namespace, "archive");
    if (
      !identified(ns, "Namespace", namespace, "") ||
      ns.apiVersion !== "v1" ||
      !owned(ns, claim) ||
      !runMatches(ns, claim) ||
      !identified(cluster, "Cluster", "database", namespace) ||
      !clusterMatches(cluster, claim)
    )
      throw new Error("backup_identity_changed");
    if (
      !identified(store, "ObjectStore", "archive", namespace) ||
      !archiveMatches(store, claim)
    )
      throw new Error("backup_archive_changed");
    return { ns, cluster, store };
  };
  const first = await sources();
  if (!ready(first.cluster, claim)) return { terminal: false };
  const binding: BackupBinding = {
    namespaceUid: first.ns.metadata.uid!,
    clusterUid: claim.clusterUid,
    specHash: claim.specHash,
    objectStoreUid: first.store.metadata.uid!,
    objectStoreGeneration: first.store.metadata.generation!,
    objectStoreSpecHash: backupHash(first.store.spec),
    backupName: backupName(claim.backupId),
    backupSpecHash: backupHash(backupSpec()),
  };
  const bindingMatches = (candidate: BackupBinding) =>
    equal(candidate, binding);
  if (claim.dispatch && !bindingMatches(claim.dispatch.binding))
    throw new Error("backup_archive_changed");
  const current = async () => {
    const observed = await sources();
    return (
      observed.ns.metadata.uid === binding.namespaceUid &&
      observed.cluster.metadata.uid === claim.clusterUid &&
      ready(observed.cluster, claim) &&
      observed.store.metadata.uid === binding.objectStoreUid &&
      observed.store.metadata.generation === binding.objectStoreGeneration &&
      backupHash(observed.store.spec) === binding.objectStoreSpecHash
    );
  };
  let resource = await read("Backup", namespace, binding.backupName);
  let freshDispatch = false;
  if (!claim.dispatch) {
    if (resource) throw new Error("backup_identity_changed");
    if (attempt.createAttempted || !(await current()))
      return { terminal: false };
    const nonce = randomUUID();
    authorized();
    const result = await control.dispatch(claim, nonce, binding);
    authorized();
    if (
      !validBackupDispatch(result.dispatch) ||
      result.dispatch.nonce !== nonce ||
      result.dispatch.leaseEpoch !== claim.leaseEpoch ||
      !bindingMatches(result.dispatch.binding) ||
      typeof result.created !== "boolean"
    )
      throw new Error("backup_dispatch_invalid");
    claim.dispatch = result.dispatch;
    freshDispatch = result.created;
  }
  const desired: Resource = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: {
      name: binding.backupName,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "cloudflare-postgres",
        "pgcf.io/environment-id": claim.environmentId,
        "pgcf.io/region-id": claim.regionId,
        "pgcf.io/backup-id": claim.backupId,
      },
      annotations: {
        "pgcf.io/spec-hash": claim.specHash,
        "pgcf.io/backup-operation-id": claim.operationId,
        "pgcf.io/backup-dispatch-nonce": claim.dispatch!.nonce,
        "pgcf.io/backup-dispatch-epoch": String(claim.dispatch!.leaseEpoch),
        "pgcf.io/backup-namespace-uid": binding.namespaceUid,
        "pgcf.io/backup-archive-uid": binding.objectStoreUid,
        "pgcf.io/backup-archive-generation": String(
          binding.objectStoreGeneration,
        ),
        "pgcf.io/backup-archive-spec-hash": binding.objectStoreSpecHash,
        "pgcf.io/backup-spec-hash": binding.backupSpecHash,
        ...(claim.runEpoch === undefined
          ? {}
          : { "pgcf.io/run-epoch": claim.runEpoch }),
      },
      ownerReferences: [
        {
          apiVersion: "postgresql.cnpg.io/v1",
          kind: "Cluster",
          name: "database",
          uid: claim.clusterUid,
          controller: true,
        },
      ],
    },
    spec: backupSpec(),
  };
  if (!resource) {
    // Persisted dispatch and exact replay are observation-only after uncertainty.
    if (!freshDispatch || attempt.createAttempted) return { terminal: false };
    if (!(await current())) return { terminal: false };
    resource = await read("Backup", namespace, binding.backupName);
    if (resource) throw new Error("backup_identity_changed");
    authorized();
    attempt.createAttempted = true;
    try {
      resource = await runtime.create(desired);
    } catch {
      resource = await read("Backup", namespace, binding.backupName);
      if (!resource) return { terminal: false };
    }
    authorized();
  }
  if (
    !resourceMatches(resource, desired) ||
    (attempt.resourceUid !== null &&
      resource.metadata.uid !== attempt.resourceUid)
  )
    throw new Error("backup_identity_changed");
  attempt.resourceUid = resource.metadata.uid!;
  const status = record(resource.status);
  if (!["completed", "failed"].includes(status.phase as string))
    return { terminal: false };
  const completed =
    status.phase === "completed" ? artifact(status, claim) : null;
  if (status.phase === "completed" && !completed) return { terminal: false };
  if (!(await current())) return { terminal: false };
  const latest = await read("Backup", namespace, binding.backupName);
  if (!latest) return { terminal: false };
  if (
    !resourceMatches(latest, desired) ||
    latest.metadata.uid !== resource.metadata.uid
  )
    throw new Error("backup_identity_changed");
  const latestStatus = record(latest.status);
  if (
    latestStatus.phase !== status.phase ||
    (completed && !equal(artifact(latestStatus, claim), completed))
  )
    return { terminal: false };
  authorized();
  return {
    terminal: true,
    observation: {
      namespaceUid: binding.namespaceUid,
      clusterUid: claim.clusterUid,
      objectStoreUid: binding.objectStoreUid,
      objectStoreGeneration: binding.objectStoreGeneration,
      objectStoreSpecHash: binding.objectStoreSpecHash,
      backupResourceUid: latest.metadata.uid!,
      backupResourceVersion: latest.metadata.resourceVersion!,
      backupSpecHash: binding.backupSpecHash,
      phase: status.phase as "completed" | "failed",
      artifact: completed,
      remoteObjectsVerified: false,
      restoreVerified: false,
    },
  };
}
