// SPDX-License-Identifier: Apache-2.0
import {
  desiredPower,
  beginWakePhase,
  measureWakePhase,
  type WakePhaseOutcome,
  type PowerCoordinator,
  type PowerObservation,
} from "./power.ts";
import { createHash } from "node:crypto";
import {
  archiveProbeOptions,
  probeArchive,
  type ArchiveProbeOptions,
  type ArchiveProbeResult,
} from "./archive-probe.ts";
import { ApiException } from "@kubernetes/client-node";
import { gatewayFenceName } from "@pgcf/contracts/gateway-control";
import { retireGatewayFence } from "./retire.ts";
import type {
  DatabaseObservation,
  DesiredDatabase,
  K8sObject,
} from "@pgcf/contracts";
import { ARCHIVE_DESTINATION_PATTERN } from "@pgcf/contracts";
import {
  buildCaConfigMap,
  buildDatabaseManifests,
  databaseNamespace,
  roleSecretName,
} from "./builders/index.ts";
import type { BuildContext } from "./builders/index.ts";
import {
  appliedGeneration,
  acceptedGeneration,
  ACCEPTED_GENERATION_ANNOTATION,
  ARCHIVE_FAILURE_MS,
  ARCHIVE_OBSERVATION_ANNOTATION,
  archiveMetrics,
  condition,
  DATABASE_LABEL,
  GENERATION_ANNOTATION,
  quantity,
  WAL_BACKLOG_LIMIT,
} from "./observe.ts";
import type { ArchiveProgress } from "./observe.ts";
import { record, string, uid } from "./types.ts";
import type { Kubernetes, Resource, Log } from "./types.ts";
import { probeRoles } from "./readiness.ts";
import type { AuthenticationProbe } from "./readiness.ts";

type ApplyStage =
  | "storage_binding"
  | "manifest_build"
  | "namespace_patch"
  | "namespace_create"
  | "manifest_apply"
  | "cluster_patch"
  | "cluster_create"
  | "namespace_readback"
  | "namespace_complete";
const DIAGNOSTIC_HTTP_STATUS = new Set([
  400, 401, 403, 404, 408, 409, 410, 412, 413, 415, 422, 429, 500, 502, 503,
  504,
]);
const APPLY_GUARD_ERRORS = new Set([
  "resource_ownership_conflict",
  "resource_identity_missing",
  "storage_fence_version_missing",
  "storage_fence_missing",
  "storage_fence_identity_changed",
  "database_namespace_version_missing",
  "database_cluster_version_missing",
  "database_namespace_deleting",
  "builder_namespace_invalid",
  "builder_resource_scope_invalid",
]);
function applyFailure(error: unknown): { category: string; status?: number } {
  try {
    const status = error instanceof ApiException ? error.code : undefined;
    if (
      typeof status === "number" &&
      Number.isInteger(status) &&
      DIAGNOSTIC_HTTP_STATUS.has(status)
    ) {
      return {
        category:
          status === 409
            ? "api_conflict"
            : [412, 422].includes(status)
              ? "api_precondition"
              : [401, 403].includes(status)
                ? "api_authorization"
                : status === 404
                  ? "api_not_found"
                  : status === 429 || status >= 500
                    ? "api_unavailable"
                    : "api_rejected",
        status,
      };
    }
    if (
      error instanceof Error &&
      typeof error.message === "string" &&
      error.message.length <= 64 &&
      APPLY_GUARD_ERRORS.has(error.message)
    )
      return { category: "guard" };
  } catch {
    /* Exception contents are untrusted diagnostics input. */
  }
  return { category: "unknown" };
}

interface VolumeIdentity {
  name: string;
  uid: string;
  claimUid: string;
  handle: string;
  lvm?: { name: string; namespace: string; uid: string };
}
interface DeleteState {
  startedAt: number;
  namespaceUid: string | null;
  volumes: VolumeIdentity[];
  completed: boolean;
}
interface StorageState {
  namespaceUid: string | null;
  clusterUid: string | null;
  node: string;
  archivePath: string;
}
interface ArchiveObservation extends ArchiveProgress {
  pendingSince: number | null;
}

function mergeDesired(current: unknown, desired: unknown): unknown {
  if (desired === null || typeof desired !== "object" || Array.isArray(desired))
    return structuredClone(desired);
  const merged = { ...record(current) };
  for (const [key, value] of Object.entries(desired))
    merged[key] = mergeDesired(merged[key], value);
  return merged;
}
function managedContentUnchanged(
  original: unknown,
  current: unknown,
  desired: unknown,
): boolean {
  if (Array.isArray(desired))
    return (
      Array.isArray(original) &&
      Array.isArray(current) &&
      original.length === current.length &&
      original.every((value, index) =>
        managedContentUnchanged(value, current[index], desired[index]),
      )
    );
  if (desired !== null && typeof desired === "object")
    return (
      original !== null &&
      typeof original === "object" &&
      !Array.isArray(original) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      Object.entries(desired).every(([key, value]) =>
        managedContentUnchanged(
          record(original)[key],
          record(current)[key],
          value,
        ),
      )
    );
  return original === current;
}

function ownedByCluster(resource: Resource, cluster: Resource): boolean {
  const owners = record(resource.metadata).ownerReferences;
  return (
    Array.isArray(owners) &&
    owners.some((value) => {
      const owner = record(value);
      return (
        owner.apiVersion === cluster.apiVersion &&
        owner.kind === "Cluster" &&
        owner.name === cluster.metadata.name &&
        owner.uid === cluster.metadata.uid
      );
    })
  );
}

const LEDGER_PREFIX = "delete-";
const STORAGE_PREFIX = "storage-";
const SYSTEM_NAMESPACE = "pgcf-system";
const VOLUME_IDENTITY_ANNOTATION = "pgcf.io/volume-identity";
const DELETE_TIMEOUT_MS = 10 * 60_000;
const CLUSTER_QUANTITY_FIELDS = new Set([
  "resources.requests.cpu",
  "resources.requests.memory",
  "resources.limits.cpu",
  "resources.limits.memory",
  "storage.size",
]);

function containsDesired(
  actual: unknown,
  desired: unknown,
  quantityFields?: ReadonlySet<string>,
  path = "",
): boolean {
  if (quantityFields?.has(path)) {
    try {
      return quantity(actual) === quantity(desired);
    } catch {
      return false;
    }
  }
  if (Array.isArray(desired))
    return (
      Array.isArray(actual) &&
      actual.length === desired.length &&
      desired.every((value, index) =>
        containsDesired(
          actual[index],
          value,
          quantityFields,
          `${path}[${index}]`,
        ),
      )
    );
  if (desired !== null && typeof desired === "object") {
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(desired).every(([key, value]) =>
        containsDesired(
          record(actual)[key],
          value,
          quantityFields,
          path ? `${path}.${key}` : key,
        ),
      )
    );
  }
  return actual === desired;
}

export function assertOwned(
  resource: Resource,
  databaseId: string,
  expectedName: string,
): void {
  if (
    resource.metadata.name !== expectedName ||
    resource.metadata.labels?.[DATABASE_LABEL] !== databaseId
  )
    throw new Error("resource_ownership_conflict");
  uid(resource);
}

function stateFromLedger(ledger: Resource): DeleteState {
  try {
    const state = record(JSON.parse(string(record(ledger.data).state) ?? ""));
    if (
      !Number.isSafeInteger(state.startedAt) ||
      (state.startedAt as number) < 0 ||
      (state.namespaceUid !== null && !string(state.namespaceUid)) ||
      typeof state.completed !== "boolean" ||
      !Array.isArray(state.volumes) ||
      state.volumes.length > 100
    )
      throw new Error();
    for (const volumeValue of state.volumes) {
      const volume = record(volumeValue);
      if (
        ![volume.name, volume.uid, volume.claimUid, volume.handle].every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 253,
        )
      )
        throw new Error();
      if (
        volume.lvm !== undefined &&
        ![
          record(volume.lvm).name,
          record(volume.lvm).namespace,
          record(volume.lvm).uid,
        ].every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 253,
        )
      )
        throw new Error();
    }
    return state as unknown as DeleteState;
  } catch {
    throw new Error("delete_ledger_invalid");
  }
}

function stateFromStorage(fence: Resource): StorageState {
  try {
    const state = record(JSON.parse(string(record(fence.data).state) ?? ""));
    const identity = (value: unknown) =>
      value === null ||
      (typeof value === "string" && value.length > 0 && value.length <= 253);
    if (
      !identity(state.namespaceUid) ||
      !identity(state.clusterUid) ||
      (state.namespaceUid === null && state.clusterUid !== null) ||
      typeof state.node !== "string" ||
      state.node.length === 0 ||
      state.node.length > 253 ||
      typeof state.archivePath !== "string" ||
      !ARCHIVE_DESTINATION_PATTERN.test(state.archivePath)
    )
      throw new Error();
    return state as unknown as StorageState;
  } catch {
    throw new Error("storage_fence_invalid");
  }
}

function pendingCreation(db: DesiredDatabase): boolean {
  const creation = db.creation;
  const archive = ARCHIVE_DESTINATION_PATTERN.exec(db.archive.destination_path);
  return Boolean(
    creation &&
    !creation.ever_ready &&
    ["pending", "running"].includes(creation.status) &&
    creation.generation === 1 &&
    archive?.[3] === db.id &&
    archive[4] === "1" &&
    archive[5] === creation.operation_id,
  );
}

function recoveryRequired(
  db: DesiredDatabase,
  reason: string,
): DatabaseObservation {
  return {
    id: db.id,
    generation: db.generation,
    state: "error",
    message: `${reason}; recovery required`,
    archive: { continuous: false, ready_wal_files: null },
  };
}

export async function backupCredentials(
  k8s: Kubernetes,
): Promise<BuildContext["backup"]["credentials"]> {
  const secret = await k8s.read("Secret", SYSTEM_NAMESPACE, "pgcf-backup-s3");
  const data = record(secret?.data);
  const decode = (name: string) => {
    const encoded = string(data[name]);
    if (
      !encoded ||
      encoded.length > 4096 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new Error("backup_credentials_invalid");
    const value = Buffer.from(encoded, "base64").toString("utf8");
    if (
      !value ||
      /[\r\n]/.test(value) ||
      value.includes(String.fromCharCode(0))
    )
      throw new Error("backup_credentials_invalid");
    return value;
  };
  return {
    accessKeyId: decode("AWS_ACCESS_KEY_ID"),
    secretAccessKey: decode("AWS_SECRET_ACCESS_KEY"),
  };
}

export class Reconciler {
  private hashes = new Map<string, string>();
  private highWater = new Map<string, number>();
  private archiveFailures = new Map<string, number>();
  private k8s: Kubernetes;
  private signal: AbortSignal;
  private now: () => number;
  private fetcher: typeof fetch;
  private authenticate: AuthenticationProbe;
  private power?: PowerCoordinator;
  private log?: Log;
  private phaseNow: () => number;
  private archiveProbe: (
    options: ArchiveProbeOptions,
  ) => Promise<ArchiveProbeResult>;
  constructor(
    k8s: Kubernetes,
    signal: AbortSignal,
    now = Date.now,
    fetcher: typeof fetch = fetch,
    authenticate: AuthenticationProbe = probeRoles,
    power?: PowerCoordinator,
    log?: Log,
    phaseNow = () => performance.now(),
    archiveProbe: (
      options: ArchiveProbeOptions,
    ) => Promise<ArchiveProbeResult> = probeArchive,
  ) {
    this.k8s = k8s;
    this.signal = signal;
    this.now = now;
    this.fetcher = fetcher;
    this.authenticate = authenticate;
    this.power = power;
    this.log = log;
    this.phaseNow = phaseNow;
    this.archiveProbe = archiveProbe;
  }

  hint(): void {
    this.power?.interrupt();
  }

  async reconcile(
    db: DesiredDatabase,
    ctx?: BuildContext,
  ): Promise<PowerObservation | null> {
    const phaseLog =
      db.desired_state === "running" && db.power?.mode === "running"
        ? this.log
        : undefined;
    const finishPrepare = beginWakePhase(
      phaseLog,
      "wake_prepare",
      db.id,
      this.phaseNow,
    );
    const namespaceName = databaseNamespace(db.id);
    const namespace = await this.k8s.read(
      "Namespace",
      undefined,
      namespaceName,
    );
    if (namespace) assertOwned(namespace, db.id, namespaceName);
    const ledger = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      `${LEDGER_PREFIX}${db.id}`,
    );
    if (ledger) assertOwned(ledger, db.id, `${LEDGER_PREFIX}${db.id}`);
    let fence = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      `${STORAGE_PREFIX}${db.id}`,
    );
    if (fence) assertOwned(fence, db.id, `${STORAGE_PREFIX}${db.id}`);
    const applied = Math.max(
      appliedGeneration(namespace),
      acceptedGeneration(namespace),
      appliedGeneration(ledger),
      appliedGeneration(fence),
      this.highWater.get(db.id) ?? 0,
    );
    if (db.generation < applied) return null;
    this.highWater.set(db.id, db.generation);
    let storage: StorageState | undefined;
    try {
      storage = fence ? stateFromStorage(fence) : undefined;
    } catch {
      return recoveryRequired(db, "storage history is invalid");
    }
    if (db.desired_state === "deleted") {
      if (
        namespace &&
        storage?.namespaceUid &&
        uid(namespace) !== storage.namespaceUid
      )
        throw new Error("delete_namespace_identity_changed");
      return this.delete(db, namespace, ledger, fence);
    }
    if (ledger) throw new Error("database_deletion_irreversible");
    if (namespace?.metadata.deletionTimestamp)
      throw new Error("database_namespace_deleting");

    if (
      storage &&
      (storage.node !== db.node ||
        storage.archivePath !== db.archive.destination_path)
    )
      return recoveryRequired(
        db,
        "storage placement or archive identity changed",
      );
    if (
      namespace &&
      storage?.namespaceUid &&
      uid(namespace) !== storage.namespaceUid
    )
      return recoveryRequired(db, "database namespace identity changed");
    if (storage && fence && appliedGeneration(fence) < db.generation)
      fence = await this.saveStorage(db, storage, fence);
    if (!namespace) {
      if (storage?.namespaceUid)
        return recoveryRequired(db, "database namespace is missing");
      if (!pendingCreation(db) || db.generation !== db.creation?.generation)
        return recoveryRequired(
          db,
          "missing namespace has no initial CREATE authority",
        );
      const [ca, volumes] = await Promise.all([
        this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, `ca-${db.id}`),
        this.k8s.list("PersistentVolume"),
      ]);
      if (
        ca ||
        volumes.some(
          (volume) =>
            record(record(volume.spec).claimRef).namespace === namespaceName,
        )
      )
        return recoveryRequired(
          db,
          "missing namespace has prior storage evidence",
        );
    }
    if (record(db).desired_state === "suspended" && !desiredPower(db))
      return recoveryRequired(db, "suspension intent is missing");
    const priorCluster = namespace
      ? await this.k8s.read("Cluster", namespaceName, "database")
      : null;
    if (priorCluster) assertOwned(priorCluster, db.id, "database");
    if (
      priorCluster &&
      storage?.clusterUid &&
      uid(priorCluster) !== storage.clusterUid
    )
      return recoveryRequired(db, "database cluster identity changed");
    if (!priorCluster && (storage?.clusterUid || !pendingCreation(db)))
      return recoveryRequired(db, "database cluster is missing");
    const powerIntent = desiredPower(db);
    if (powerIntent?.mode === "quiesce") {
      if (
        !namespace ||
        !priorCluster ||
        !storage?.namespaceUid ||
        !storage.clusterUid ||
        !fence
      )
        return recoveryRequired(
          db,
          "suspended database storage history is missing",
        );
      if (!this.power)
        return {
          ...recoveryRequired(
            db,
            "power coordinator configuration is unavailable",
          ),
          power: {
            operation: powerIntent.operation,
            revision: powerIntent.revision,
            state: "awake",
            refusal: "unknown",
          },
        };
      if (appliedGeneration(fence) < db.generation)
        await this.saveStorage(db, storage, fence);
      return this.power.suspend(db);
    }
    if (powerIntent) {
      if (!this.power)
        return recoveryRequired(
          db,
          "power coordinator configuration is unavailable",
        );
      if (storage && fence && appliedGeneration(fence) < db.generation)
        fence = await this.saveStorage(db, storage, fence);
      let pending: PowerObservation | null | undefined;
      try {
        pending = await this.power.prepareRunning(db);
      } catch (error) {
        finishPrepare("failed");
        throw error;
      }
      finishPrepare(pending === undefined ? "completed" : "pending");
      if (pending !== undefined) return pending;
    }
    if (!ctx) throw new Error("build_context_required");
    const finishApply = beginWakePhase(
      phaseLog,
      "desired_apply",
      db.id,
      this.phaseNow,
    );
    let applyOutcome: WakePhaseOutcome = "pending";
    let applyStage: ApplyStage = "storage_binding";
    try {
      storage = storage ?? {
        namespaceUid: null,
        clusterUid: null,
        node: db.node,
        archivePath: db.archive.destination_path,
      };
      if (namespace) storage.namespaceUid = uid(namespace);
      if (priorCluster) storage.clusterUid = uid(priorCluster);
      fence = await this.saveStorage(db, storage, fence);

      if (db.generation > appliedGeneration(namespace)) {
        applyStage = "manifest_build";
        const manifests = buildDatabaseManifests(db, ctx);
        // Accepted revisions fence out stale pulls before credentials can change. Completion advances last.
        const first = manifests[0];
        if (
          !first ||
          first.kind !== "Namespace" ||
          first.metadata.name !== namespaceName
        )
          throw new Error("builder_namespace_invalid");
        first.metadata.annotations = {
          ...first.metadata.annotations,
          ...namespace?.metadata.annotations,
          [ACCEPTED_GENERATION_ANNOTATION]: String(db.generation),
        };
        const hash = createHash("sha256")
          .update(JSON.stringify(manifests))
          .digest("hex");
        if (this.hashes.get(db.id) !== hash) {
          if (namespace) {
            applyStage = "namespace_patch";
            if (!namespace.metadata.resourceVersion)
              throw new Error("database_namespace_version_missing");
            await this.k8s.patch("Namespace", undefined, namespaceName, [
              { op: "test", path: "/metadata/uid", value: uid(namespace) },
              {
                op: "test",
                path: "/metadata/resourceVersion",
                value: namespace.metadata.resourceVersion,
              },
              {
                op: "add",
                path: "/metadata/annotations",
                value: first.metadata.annotations,
              },
              {
                op: "add",
                path: "/metadata/labels",
                value: {
                  ...namespace.metadata.labels,
                  ...first.metadata.labels,
                },
              },
            ]);
          } else {
            applyStage = "namespace_create";
            await this.k8s.create(first);
          }
          const active = await this.k8s.read(
            "Namespace",
            undefined,
            namespaceName,
          );
          if (!active)
            return recoveryRequired(
              db,
              "database namespace disappeared during creation",
            );
          assertOwned(active, db.id, namespaceName);
          if (storage.namespaceUid && uid(active) !== storage.namespaceUid)
            return recoveryRequired(db, "database namespace identity changed");
          storage.namespaceUid = uid(active);
          applyStage = "storage_binding";
          fence = await this.saveStorage(db, storage, fence);
          if (record(active.status).phase !== "Active") return null;
          if (acceptedGeneration(active) !== db.generation) return null;
          if (active.metadata.deletionTimestamp)
            throw new Error("database_namespace_deleting");
          for (const manifest of manifests.slice(1)) {
            applyStage = "manifest_apply";
            if (
              manifest.metadata.namespace !== namespaceName ||
              manifest.metadata.labels?.[DATABASE_LABEL] !== db.id
            )
              throw new Error("builder_resource_scope_invalid");
            manifest.metadata.annotations = {
              ...manifest.metadata.annotations,
              [GENERATION_ANNOTATION]: String(db.generation),
            };
            if (manifest.kind === "Cluster") {
              const currentCluster = await this.k8s.read(
                "Cluster",
                namespaceName,
                "database",
              );
              if (currentCluster) {
                assertOwned(currentCluster, db.id, "database");
                if (appliedGeneration(currentCluster) > db.generation)
                  return null;
                if (
                  storage.clusterUid &&
                  uid(currentCluster) !== storage.clusterUid
                )
                  return recoveryRequired(
                    db,
                    "database cluster identity changed",
                  );
                storage.clusterUid = uid(currentCluster);
                applyStage = "storage_binding";
                fence = await this.saveStorage(db, storage, fence);
                if (!currentCluster.metadata.resourceVersion)
                  throw new Error("database_cluster_version_missing");
                applyStage = "cluster_patch";
                await this.patchConfiguration(
                  db,
                  currentCluster,
                  storage.namespaceUid!,
                  manifest,
                  (snapshot, retry) => [
                    {
                      op: "test",
                      path: "/metadata/uid",
                      value: uid(snapshot),
                    },
                    {
                      op: "test",
                      path: "/metadata/resourceVersion",
                      value: snapshot.metadata.resourceVersion,
                    },
                    {
                      op: "add",
                      path: "/metadata/annotations",
                      value: {
                        ...snapshot.metadata.annotations,
                        ...manifest.metadata.annotations,
                      },
                    },
                    {
                      op: "add",
                      path: "/spec",
                      value: retry
                        ? mergeDesired(snapshot.spec, manifest.spec)
                        : {
                            ...record(snapshot.spec),
                            ...record(manifest.spec),
                          },
                    },
                  ],
                );
              } else {
                if (storage.clusterUid || !pendingCreation(db))
                  return recoveryRequired(db, "database cluster is missing");
                applyStage = "cluster_create";
                await this.k8s.create(manifest);
                const created = await this.k8s.read(
                  "Cluster",
                  namespaceName,
                  "database",
                );
                if (!created)
                  return recoveryRequired(
                    db,
                    "database cluster disappeared during creation",
                  );
                assertOwned(created, db.id, "database");
                storage.clusterUid = uid(created);
                applyStage = "storage_binding";
                fence = await this.saveStorage(db, storage, fence);
              }
            } else if (
              !(await this.applyRevision(db, manifest, storage.namespaceUid!))
            )
              return null;
          }
          this.hashes.set(db.id, hash);
        }
        applyStage = "namespace_readback";
        const current = await this.k8s.read(
          "Namespace",
          undefined,
          namespaceName,
        );
        if (!current)
          return recoveryRequired(db, "database namespace is missing");
        assertOwned(current, db.id, namespaceName);
        if (uid(current) !== storage.namespaceUid)
          return recoveryRequired(db, "database namespace identity changed");
        if (
          appliedGeneration(current) > db.generation ||
          acceptedGeneration(current) !== db.generation
        )
          return null;
        applyStage = "namespace_complete";
        await this.k8s.patch("Namespace", undefined, namespaceName, [
          { op: "test", path: "/metadata/uid", value: uid(current) },
          {
            op: "test",
            path: "/metadata/annotations/pgcf.io~1accepted-generation",
            value: String(db.generation),
          },
          {
            op: "add",
            path: "/metadata/annotations",
            value: {
              ...current.metadata.annotations,
              [GENERATION_ANNOTATION]: String(db.generation),
            },
          },
        ]);
      }
      applyOutcome = "completed";
    } catch (error) {
      applyOutcome = "failed";
      try {
        phaseLog?.("wake_apply_failed", {
          phase: "desired_apply",
          stage: applyStage,
          ...applyFailure(error),
          database_id: db.id,
        });
      } catch {
        /* Logging cannot change the original failure. */
      }
      throw error;
    } finally {
      finishApply(applyOutcome);
    }
    // Equal revisions still observe asynchronous CNPG readiness, archiving and CA publication.
    let cluster = await this.k8s.read("Cluster", namespaceName, "database");
    if (!cluster) return recoveryRequired(db, "database cluster is missing");
    assertOwned(cluster, db.id, "database");
    if (uid(cluster) !== storage.clusterUid)
      return recoveryRequired(db, "database cluster identity changed");
    const archiveSource = cluster;
    let count: number | null;
    let progress: ArchiveProgress | null = null;
    let measured = false;
    try {
      const metrics = await measureWakePhase(
        phaseLog,
        "archive_metrics",
        db.id,
        async () => {
          const options = await archiveProbeOptions(
            db,
            archiveSource,
            fence!,
            this.k8s,
            this.signal,
            this.now,
            (transport, reason) =>
              phaseLog?.("wake_archive_transport", {
                database_id: db.id,
                transport,
                reason,
              }),
          );
          if (options)
            options.reportFailure = (stage) =>
              phaseLog?.("wake_archive_failed", { database_id: db.id, stage });
          return options
            ? this.archiveProbe(options)
            : archiveMetrics(
                this.k8s,
                namespaceName,
                archiveSource,
                this.signal,
                this.now,
                this.fetcher,
              );
        },
        this.phaseNow,
      );
      count = metrics.readyWalFiles;
      progress = metrics.progress;
      measured = metrics.valid;
    } catch {
      if (this.signal.aborted) throw new Error("agent_aborted");
      count = null;
    }
    const refreshed = await this.k8s.read("Cluster", namespaceName, "database");
    if (!refreshed) return recoveryRequired(db, "database cluster is missing");
    assertOwned(refreshed, db.id, "database");
    if (
      refreshed.metadata.namespace !== namespaceName ||
      !refreshed.metadata.resourceVersion ||
      uid(refreshed) !== storage.clusterUid ||
      uid(refreshed) !== uid(archiveSource)
    )
      return recoveryRequired(db, "database cluster identity changed");
    if (refreshed.metadata.deletionTimestamp)
      return recoveryRequired(db, "database cluster is deleting");
    if (
      appliedGeneration(refreshed) !== db.generation ||
      acceptedGeneration(refreshed) > db.generation ||
      string(record(refreshed.status).currentPrimary) !==
        string(record(archiveSource.status).currentPrimary)
    )
      return {
        id: db.id,
        generation: db.generation,
        state: "provisioning",
        archive: { continuous: false, ready_wal_files: null },
      };
    cluster = refreshed;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("archive_clock_invalid");
    const stalled = await this.archiveStalled(
      db,
      fence,
      measured ? count : null,
      progress,
      now,
    );
    const archive = condition(cluster, "ContinuousArchiving");
    const backlog = count !== null && count >= WAL_BACKLOG_LIMIT;
    const continuous =
      archive?.status === "True" &&
      measured &&
      count !== null &&
      (count === 0 ||
        (progress !== null &&
          progress.lastArchivedTime !== -1 &&
          stalled !== null)) &&
      !backlog &&
      !stalled;
    if (archive?.status === "True") this.archiveFailures.delete(db.id);
    else if (archive?.status === "False") {
      const transition = Date.parse(string(archive?.lastTransitionTime) ?? "");
      const firstFailure =
        Number.isFinite(transition) && transition <= this.now()
          ? transition
          : this.now();
      this.archiveFailures.set(
        db.id,
        this.archiveFailures.get(db.id) ?? firstFailure,
      );
    }
    const publicCa = await measureWakePhase(
      phaseLog,
      "ca_publication",
      db.id,
      () => this.publishCa(db, cluster, namespaceName),
      this.phaseNow,
    );
    const runtimeResources: Resource[] = [];
    const desiredApplied = await measureWakePhase(
      phaseLog,
      "desired_applied",
      db.id,
      () =>
        this.desiredApplied(db, ctx, cluster, namespaceName, runtimeResources),
      this.phaseNow,
    );
    const caMap = publicCa
      ? await this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, `ca-${db.id}`)
      : null;
    const ca = string(record(caMap?.data)["ca.crt"]);
    const credentialsApplied =
      condition(cluster, "Ready")?.status === "True" &&
      publicCa &&
      desiredApplied &&
      ca
        ? await measureWakePhase(
            phaseLog,
            "role_runtime_auth",
            db.id,
            () => this.authenticate(db, ca, this.signal),
            this.phaseNow,
          )
        : false;
    const storageVerified =
      credentialsApplied &&
      (await measureWakePhase(
        phaseLog,
        "volume_identity",
        db.id,
        () => this.verifyVolumeIdentity(db, fence, runtimeResources),
        this.phaseNow,
      ));
    const runtimeUnchanged =
      storageVerified &&
      (await measureWakePhase(
        phaseLog,
        "runtime_unchanged",
        db.id,
        () => this.runtimeUnchanged(runtimeResources),
        this.phaseNow,
      ));
    const unhealthy =
      stalled === true ||
      (archive?.status === "False" &&
        now - (this.archiveFailures.get(db.id) ?? now) >= ARCHIVE_FAILURE_MS);
    const databaseReady =
      condition(cluster, "Ready")?.status === "True" &&
      publicCa &&
      desiredApplied &&
      credentialsApplied &&
      runtimeUnchanged &&
      storageVerified &&
      count !== null &&
      (continuous ||
        (db.creation?.ever_ready === true && measured && stalled !== null));
    const observation: PowerObservation = {
      id: db.id,
      generation: db.generation,
      state: databaseReady
        ? "ready"
        : unhealthy || backlog
          ? "error"
          : "provisioning",
      ...(unhealthy || backlog
        ? { message: "continuous WAL archiving is unhealthy" }
        : {}),
      archive: { continuous, ready_wal_files: count },
    };
    return this.power
      ? powerIntent
        ? measureWakePhase(
            phaseLog,
            "fence_release",
            db.id,
            () => this.power!.finishRunning(db, observation),
            this.phaseNow,
          )
        : this.power.publishReadyFence(db, observation)
      : observation;
  }

  private async archiveStalled(
    db: DesiredDatabase,
    fence: Resource,
    count: number | null,
    progress: ArchiveProgress | null,
    now: number,
  ): Promise<boolean | null> {
    const saved = fence.metadata.annotations?.[ARCHIVE_OBSERVATION_ANNOTATION];
    let previous: ArchiveObservation | undefined;
    if (saved !== undefined) {
      try {
        const value = record(JSON.parse(saved));
        if (
          Object.keys(value).length !== 3 ||
          (value.pendingSince !== null &&
            (!Number.isSafeInteger(value.pendingSince) ||
              (value.pendingSince as number) < 0 ||
              (value.pendingSince as number) > now)) ||
          !Number.isSafeInteger(value.archivedCount) ||
          (value.archivedCount as number) < 0 ||
          typeof value.lastArchivedTime !== "number" ||
          !Number.isFinite(value.lastArchivedTime) ||
          (value.lastArchivedTime < 0 &&
            !(value.archivedCount === 0 && value.lastArchivedTime === -1)) ||
          value.lastArchivedTime > now / 1000 ||
          ((value.archivedCount as number) > 0 && value.lastArchivedTime === 0)
        )
          throw new Error();
        previous = value as unknown as ArchiveObservation;
      } catch {
        throw new Error("archive_observation_invalid");
      }
    }
    if (count === null || (count > 0 && !progress)) return null;
    if (count === 0 && !previous) return false;
    const reset = Boolean(
      count > 0 &&
      previous &&
      progress &&
      (progress.archivedCount < previous.archivedCount ||
        progress.lastArchivedTime < previous.lastArchivedTime),
    );
    const advanced =
      previous &&
      progress &&
      !reset &&
      (progress.lastArchivedTime > previous.lastArchivedTime ||
        progress.archivedCount > previous.archivedCount);
    const next: ArchiveObservation = {
      ...(progress ?? previous!),
      pendingSince:
        count === 0
          ? null
          : !previous || previous.pendingSince === null || advanced
            ? now
            : previous.pendingSince,
    };
    const encoded = JSON.stringify(next);
    if (saved !== encoded) {
      assertOwned(fence, db.id, `${STORAGE_PREFIX}${db.id}`);
      if (
        fence.metadata.namespace !== SYSTEM_NAMESPACE ||
        !fence.metadata.resourceVersion ||
        appliedGeneration(fence) !== db.generation
      )
        throw new Error("archive_fence_invalid");
      await this.k8s.patch("ConfigMap", SYSTEM_NAMESPACE, fence.metadata.name, [
        { op: "test", path: "/metadata/uid", value: uid(fence) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: fence.metadata.resourceVersion,
        },
        { op: "test", path: "/data/state", value: record(fence.data).state },
        {
          op: "add",
          path: "/metadata/annotations",
          value: {
            ...fence.metadata.annotations,
            [ARCHIVE_OBSERVATION_ANNOTATION]: encoded,
          },
        },
      ]);
      const current = await this.k8s.read(
        "ConfigMap",
        SYSTEM_NAMESPACE,
        fence.metadata.name,
      );
      if (!current) throw new Error("archive_fence_missing");
      assertOwned(current, db.id, fence.metadata.name);
      if (
        uid(current) !== uid(fence) ||
        appliedGeneration(current) !== db.generation ||
        record(current.data).state !== record(fence.data).state ||
        current.metadata.annotations?.[ARCHIVE_OBSERVATION_ANNOTATION] !==
          encoded
      )
        throw new Error("archive_fence_changed");
    }
    return (
      next.pendingSince !== null &&
      now - next.pendingSince >= ARCHIVE_FAILURE_MS
    );
  }

  private async patchConfiguration(
    db: DesiredDatabase,
    original: Resource,
    namespaceUid: string,
    manifest: K8sObject,
    build: (snapshot: Resource, retry: boolean) => unknown[],
  ): Promise<void> {
    this.signal.throwIfAborted();
    try {
      await this.k8s.patch(
        original.kind,
        original.metadata.namespace,
        original.metadata.name,
        build(original, false),
      );
    } catch (error) {
      if (
        !(error instanceof ApiException) ||
        error.code !== 422 ||
        db.desired_state !== "running" ||
        db.power?.mode !== "running" ||
        this.signal.aborted ||
        typeof original.metadata.resourceVersion !== "string" ||
        original.metadata.resourceVersion.length < 1 ||
        original.metadata.resourceVersion.length > 256 ||
        typeof original.metadata.uid !== "string" ||
        !original.metadata.uid ||
        typeof namespaceUid !== "string" ||
        !namespaceUid
      )
        throw error;
      let current: Resource | null, namespace: Resource | null;
      try {
        [current, namespace] = await Promise.all([
          this.k8s.read(
            original.kind,
            original.metadata.namespace,
            original.metadata.name,
          ),
          this.k8s.read("Namespace", undefined, databaseNamespace(db.id)),
        ]);
        if (
          this.signal.aborted ||
          !current ||
          !namespace ||
          current.apiVersion !== original.apiVersion ||
          current.kind !== original.kind ||
          current.metadata.name !== original.metadata.name ||
          current.metadata.namespace !== original.metadata.namespace ||
          current.metadata.namespace !== databaseNamespace(db.id) ||
          current.metadata.uid !== original.metadata.uid ||
          !current.metadata.uid ||
          typeof current.metadata.resourceVersion !== "string" ||
          current.metadata.resourceVersion.length < 1 ||
          current.metadata.resourceVersion.length > 256 ||
          current.metadata.resourceVersion ===
            original.metadata.resourceVersion ||
          current.metadata.deletionTimestamp ||
          original.metadata.deletionTimestamp ||
          namespace.kind !== "Namespace" ||
          namespace.metadata.namespace !== undefined ||
          typeof namespace.metadata.resourceVersion !== "string" ||
          !namespace.metadata.resourceVersion ||
          namespace.metadata.uid !== namespaceUid ||
          namespace.metadata.deletionTimestamp ||
          namespace.metadata.name !== databaseNamespace(db.id) ||
          appliedGeneration(current) > db.generation ||
          acceptedGeneration(current) > db.generation ||
          appliedGeneration(namespace) > db.generation ||
          acceptedGeneration(namespace) !== db.generation ||
          (this.highWater.get(db.id) ?? 0) > db.generation
        )
          throw error;
        assertOwned(current, db.id, original.metadata.name);
        assertOwned(namespace, db.id, databaseNamespace(db.id));
        for (const [key, value] of Object.entries(manifest).filter(
          ([key]) => !["apiVersion", "kind", "metadata"].includes(key),
        ))
          if (!managedContentUnchanged(original[key], current[key], value))
            throw error;
      } catch {
        throw error;
      }
      this.signal.throwIfAborted();
      await this.k8s.patch(
        current.kind,
        current.metadata.namespace,
        current.metadata.name,
        build(current, true),
      );
    }
  }

  private async applyRevision(
    db: DesiredDatabase,
    manifest: K8sObject,
    namespaceUid: string,
  ): Promise<boolean> {
    const { kind, metadata } = manifest;
    const current = await this.k8s.read(
      kind,
      metadata.namespace,
      metadata.name,
    );
    if (!current) {
      await this.k8s.create(manifest);
      return true;
    }
    assertOwned(current, db.id, metadata.name);
    // Namespace completion cannot fence a resource write already in flight.
    if (appliedGeneration(current) > db.generation) return false;
    if (!current.metadata.resourceVersion)
      throw new Error("database_resource_version_missing");
    await this.patchConfiguration(
      db,
      current,
      namespaceUid,
      manifest,
      (snapshot, retry) => [
        { op: "test", path: "/metadata/uid", value: uid(snapshot) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: snapshot.metadata.resourceVersion,
        },
        {
          op: "add",
          path: "/metadata/annotations",
          value: { ...snapshot.metadata.annotations, ...metadata.annotations },
        },
        {
          op: "add",
          path: "/metadata/labels",
          value: { ...snapshot.metadata.labels, ...metadata.labels },
        },
        ...Object.entries(manifest)
          .filter(([key]) => !["apiVersion", "kind", "metadata"].includes(key))
          .map(([key, value]) => ({
            op: "add",
            path: `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            value:
              retry &&
              (key === "spec" || key === "data" || key === "binaryData")
                ? mergeDesired(snapshot[key], value)
                : value,
          })),
      ],
    );
    return true;
  }

  private async desiredApplied(
    db: DesiredDatabase,
    ctx: BuildContext,
    cluster: Resource,
    namespace: string,
    identities: Resource[] = [],
  ): Promise<boolean> {
    assertOwned(cluster, db.id, "database");
    const manifests = buildDatabaseManifests(db, ctx);
    const expectedCluster = manifests.find(
      (resource) => resource.kind === "Cluster",
    );
    if (
      !expectedCluster ||
      !containsDesired(
        cluster.spec,
        expectedCluster.spec,
        CLUSTER_QUANTITY_FIELDS,
      )
    )
      return false;
    for (const manifest of manifests.filter(
      (resource) =>
        resource.kind === "Secret" || resource.kind === "ObjectStore",
    )) {
      const actual = await this.k8s.read(
        manifest.kind,
        namespace,
        manifest.metadata.name,
      );
      if (!actual) return false;
      assertOwned(actual, db.id, manifest.metadata.name);
      if (
        !containsDesired(
          actual.data ?? actual.spec,
          manifest.data ?? manifest.spec,
        )
      )
        return false;
      if (manifest.kind === "Secret") {
        const role = db.roles.find(
          (value) => roleSecretName(value.name) === manifest.metadata.name,
        );
        if (role) {
          if (!actual.metadata.resourceVersion) return false;
          if (role.owner) {
            if (
              record(record(cluster.status).secretsResourceVersion)
                .applicationSecretVersion !== actual.metadata.resourceVersion
            )
              return false;
          } else {
            const rolesStatus = record(
              record(cluster.status).managedRolesStatus,
            );
            const reconciled = record(rolesStatus.byStatus).reconciled;
            if (
              !Array.isArray(reconciled) ||
              !reconciled.includes(role.name) ||
              record(record(rolesStatus.passwordStatus)[role.name])
                .resourceVersion !== actual.metadata.resourceVersion
            )
              return false;
          }
        }
      }
    }
    const primary = string(record(cluster.status).currentPrimary);
    if (
      !primary ||
      !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(primary) ||
      primary.length > 63
    )
      return false;
    const pod = await this.k8s.read("Pod", namespace, primary);
    if (
      !pod ||
      !pod.metadata.uid ||
      !pod.metadata.resourceVersion ||
      !ownedByCluster(pod, cluster) ||
      pod.metadata.deletionTimestamp ||
      pod.metadata.namespace !== namespace ||
      pod.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
      condition(pod, "Ready")?.status !== "True" ||
      record(pod.spec).nodeName !== db.node
    )
      return false;
    const containers = record(pod.spec).containers;
    const postgres = Array.isArray(containers)
      ? containers.map(record).find((value) => value.name === "postgres")
      : undefined;
    if (!postgres || postgres.image !== ctx.postgresImage) return false;
    const compute = record(postgres.resources);
    for (const resources of [
      record(compute.requests),
      record(compute.limits),
    ]) {
      if (
        quantity(resources.memory) !== db.size.memory_mib * 2 ** 20 ||
        quantity(resources.cpu) * 1000 !== db.size.cpu_millicores
      )
        return false;
    }
    const volumes = record(pod.spec).volumes;
    const pgdata = Array.isArray(volumes)
      ? volumes.map(record).find((value) => value.name === "pgdata")
      : undefined;
    const claimName = string(record(pgdata?.persistentVolumeClaim).claimName);
    if (!claimName || claimName !== primary) return false;
    const claim = await this.k8s.read(
      "PersistentVolumeClaim",
      namespace,
      claimName,
    );
    if (
      !claim ||
      !claim.metadata.uid ||
      !claim.metadata.resourceVersion ||
      claim.metadata.deletionTimestamp ||
      claim.metadata.namespace !== namespace ||
      claim.metadata.labels?.["cnpg.io/cluster"] !== "database" ||
      !ownedByCluster(claim, cluster) ||
      record(claim.status).phase !== "Bound" ||
      record(claim.spec).storageClassName !== ctx.storageClass ||
      quantity(
        record(record(record(claim.spec).resources).requests).storage,
      ) !==
        db.size.storage_gib * 2 ** 30 ||
      quantity(record(record(claim.status).capacity).storage) !==
        db.size.storage_gib * 2 ** 30
    )
      return false;
    const volumeName = string(record(claim.spec).volumeName);
    if (!volumeName) return false;
    const volume = await this.k8s.read(
      "PersistentVolume",
      undefined,
      volumeName,
    );
    const reference = record(record(volume?.spec).claimRef);
    if (
      !volume ||
      !volume.metadata.uid ||
      !volume.metadata.resourceVersion ||
      volume.metadata.deletionTimestamp ||
      reference.namespace !== namespace ||
      reference.name !== claimName ||
      reference.uid !== claim.metadata.uid ||
      record(volume.spec).storageClassName !== ctx.storageClass ||
      record(volume.status).phase !== "Bound" ||
      record(record(volume.spec).csi).driver !== "local.csi.openebs.io" ||
      quantity(record(record(volume.spec).capacity).storage) !==
        db.size.storage_gib * 2 ** 30
    )
      return false;
    identities.push(cluster, pod, claim, volume);
    return true;
  }

  private async runtimeUnchanged(resources: Resource[]): Promise<boolean> {
    const current = await Promise.all(
      resources.map((resource) =>
        this.k8s.read(
          resource.kind,
          resource.metadata.namespace,
          resource.metadata.name,
        ),
      ),
    );
    return current.every(
      (resource, index) =>
        resource &&
        !resource.metadata.deletionTimestamp &&
        resource.metadata.uid === resources[index]!.metadata.uid &&
        resource.metadata.resourceVersion ===
          resources[index]!.metadata.resourceVersion,
    );
  }

  private async verifyVolumeIdentity(
    db: DesiredDatabase,
    fence: Resource,
    resources: Resource[],
  ): Promise<boolean> {
    const claim = resources.find(
      (resource) => resource.kind === "PersistentVolumeClaim",
    );
    const volume = resources.find(
      (resource) => resource.kind === "PersistentVolume",
    );
    if (!claim || !volume) return false;
    const handle = string(record(record(volume.spec).csi).volumeHandle);
    if (!handle || handle.length > 253) return false;
    const identity = JSON.stringify({
      claimUid: claim.metadata.uid,
      volumeUid: volume.metadata.uid,
      handle,
    });
    const name = `${STORAGE_PREFIX}${db.id}`;
    const current = await this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, name);
    if (!current) return false;
    assertOwned(current, db.id, name);
    if (
      uid(current) !== uid(fence) ||
      current.metadata.namespace !== SYSTEM_NAMESPACE ||
      !current.metadata.resourceVersion ||
      appliedGeneration(current) !== db.generation ||
      record(current.data).state !== record(fence.data).state
    )
      return false;
    const previous = current.metadata.annotations?.[VOLUME_IDENTITY_ANNOTATION];
    if (previous !== undefined) return previous === identity;
    await this.k8s.patch("ConfigMap", SYSTEM_NAMESPACE, name, [
      { op: "test", path: "/metadata/uid", value: uid(current) },
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: current.metadata.resourceVersion,
      },
      { op: "test", path: "/data/state", value: record(current.data).state },
      {
        op: "add",
        path: "/metadata/annotations",
        value: {
          ...current.metadata.annotations,
          [VOLUME_IDENTITY_ANNOTATION]: identity,
        },
      },
    ]);
    const saved = await this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, name);
    if (saved) assertOwned(saved, db.id, name);
    return (
      saved !== null &&
      saved.metadata.namespace === SYSTEM_NAMESPACE &&
      uid(saved) === uid(current) &&
      appliedGeneration(saved) === db.generation &&
      record(saved.data).state === record(current.data).state &&
      saved.metadata.annotations?.[VOLUME_IDENTITY_ANNOTATION] === identity
    );
  }

  private async publishCa(
    db: DesiredDatabase,
    cluster: Resource,
    namespace: string,
  ): Promise<boolean> {
    const name = string(
      record(record(cluster.status).certificates).serverCASecret,
    );
    if (!name) return false;
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 63)
      throw new Error("server_ca_secret_invalid");
    const secret = await this.k8s.read("Secret", namespace, name);
    const encoded = string(record(secret?.data)["ca.crt"]);
    if (!encoded || encoded.length > 128 * 1024) return false;
    const ca = Buffer.from(encoded, "base64").toString("utf8");
    if (
      !ca.includes("-----BEGIN CERTIFICATE-----") ||
      !ca.includes("-----END CERTIFICATE-----")
    )
      throw new Error("server_ca_invalid");
    const manifest = buildCaConfigMap(db.id, ca);
    const existing = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      manifest.metadata.name,
    );
    if (existing) assertOwned(existing, db.id, manifest.metadata.name);
    if (
      !existing ||
      JSON.stringify(record(existing.data)) !== JSON.stringify(manifest.data)
    )
      await this.k8s.apply(manifest);
    const published = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      manifest.metadata.name,
    );
    if (!published) return false;
    assertOwned(published, db.id, manifest.metadata.name);
    return (
      record(published.data)["ca.crt"] === ca &&
      Object.keys(record(published.data)).length === 1
    );
  }

  private async saveStorage(
    db: DesiredDatabase,
    state: StorageState,
    previous: Resource | null,
  ): Promise<Resource> {
    const data = { ...record(previous?.data), state: JSON.stringify(state) };
    if (
      previous &&
      appliedGeneration(previous) === db.generation &&
      record(previous.data).state === data.state
    )
      return previous;
    const name = `${STORAGE_PREFIX}${db.id}`;
    if (previous) {
      if (!previous.metadata.resourceVersion)
        throw new Error("storage_fence_version_missing");
      await this.k8s.patch("ConfigMap", SYSTEM_NAMESPACE, name, [
        { op: "test", path: "/metadata/uid", value: uid(previous) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: previous.metadata.resourceVersion,
        },
        {
          op: "add",
          path: "/metadata/annotations",
          value: {
            ...previous.metadata.annotations,
            [GENERATION_ANNOTATION]: String(db.generation),
          },
        },
        { op: "add", path: "/data", value: data },
      ]);
    } else
      await this.k8s.create({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
          name,
          namespace: SYSTEM_NAMESPACE,
          labels: { [DATABASE_LABEL]: db.id },
          annotations: { [GENERATION_ANNOTATION]: String(db.generation) },
        },
        data,
      });
    const current = await this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, name);
    if (!current) throw new Error("storage_fence_missing");
    assertOwned(current, db.id, name);
    if (
      appliedGeneration(current) !== db.generation ||
      record(current.data).state !== data.state
    )
      throw new Error("storage_fence_identity_changed");
    return current;
  }

  private async saveLedger(
    db: DesiredDatabase,
    state: DeleteState,
    terminal = false,
  ): Promise<void> {
    if (terminal) {
      const name = `${LEDGER_PREFIX}${db.id}`;
      const current = await this.k8s.read("ConfigMap", SYSTEM_NAMESPACE, name);
      if (
        !current ||
        current.metadata.namespace !== SYSTEM_NAMESPACE ||
        !current.metadata.resourceVersion ||
        appliedGeneration(current) !== db.generation
      )
        throw new Error("delete_ledger_identity_changed");
      assertOwned(current, db.id, name);
      await this.k8s.patch("ConfigMap", SYSTEM_NAMESPACE, name, [
        { op: "test", path: "/metadata/uid", value: uid(current) },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: current.metadata.resourceVersion,
        },
        { op: "test", path: "/data", value: current.data },
        {
          op: "add",
          path: "/data",
          value: { ...record(current.data), state: JSON.stringify(state) },
        },
      ]);
      return;
    }
    const manifest: K8sObject = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: `${LEDGER_PREFIX}${db.id}`,
        namespace: SYSTEM_NAMESPACE,
        labels: { [DATABASE_LABEL]: db.id },
        annotations: { [GENERATION_ANNOTATION]: String(db.generation) },
      },
      data: { state: JSON.stringify(state) },
    };
    await this.k8s.apply(manifest);
  }

  private async delete(
    db: DesiredDatabase,
    namespace: Resource | null,
    ledger: Resource | null,
    fence: Resource | null,
  ): Promise<DatabaseObservation> {
    const namespaceName = databaseNamespace(db.id);
    const state: DeleteState = ledger
      ? stateFromLedger(ledger)
      : {
          startedAt: this.now(),
          namespaceUid: namespace ? uid(namespace) : null,
          volumes: [],
          completed: false,
        };
    if (
      namespace &&
      state.namespaceUid &&
      uid(namespace) !== state.namespaceUid
    )
      throw new Error("delete_namespace_identity_changed");
    const [pvs, lvs] = await Promise.all([
      this.k8s.list("PersistentVolume"),
      this.k8s.list("LVMVolume"),
    ]);
    let changed = !ledger || appliedGeneration(ledger) !== db.generation;
    for (const pv of pvs.filter(
      (pv) => record(record(pv.spec).claimRef).namespace === namespaceName,
    )) {
      const spec = record(pv.spec);
      const claim = record(spec.claimRef);
      const csi = record(spec.csi);
      const handle = string(csi.volumeHandle);
      const claimUid = string(claim.uid);
      if (
        spec.storageClassName !== "pgcf-lvm" ||
        csi.driver !== "local.csi.openebs.io" ||
        !handle ||
        !claimUid
      )
        throw new Error("delete_volume_ownership_invalid");
      const previous = state.volumes.find(
        (volume) => volume.name === pv.metadata.name,
      );
      if (
        previous &&
        (previous.uid !== uid(pv) ||
          previous.claimUid !== claimUid ||
          previous.handle !== handle)
      )
        throw new Error("delete_volume_identity_changed");
      if (!previous) {
        const matches = lvs.filter((lv) => lv.metadata.name === handle);
        if (matches.length > 1)
          throw new Error("delete_lvm_identity_ambiguous");
        const lv = matches[0];
        state.volumes.push({
          name: pv.metadata.name,
          uid: uid(pv),
          claimUid,
          handle,
          ...(lv
            ? {
                lvm: {
                  name: lv.metadata.name,
                  namespace: lv.metadata.namespace ?? "",
                  uid: uid(lv),
                },
              }
            : {}),
        });
        changed = true;
      }
    }
    if (state.completed && (namespace || state.volumes.length))
      throw new Error("delete_terminal_identity_conflict");
    if (changed) await this.saveLedger(db, state);
    for (const volume of state.volumes) {
      const pv = pvs.find((value) => value.metadata.name === volume.name);
      if (!pv) continue;
      if (
        uid(pv) !== volume.uid ||
        record(record(pv.spec).claimRef).uid !== volume.claimUid ||
        record(record(pv.spec).claimRef).namespace !== namespaceName
      )
        throw new Error("delete_volume_identity_changed");
      if (record(pv.spec).persistentVolumeReclaimPolicy !== "Delete")
        await this.k8s.patch("PersistentVolume", undefined, volume.name, [
          { op: "test", path: "/metadata/uid", value: volume.uid },
          { op: "test", path: "/spec/claimRef/uid", value: volume.claimUid },
          {
            op: "test",
            path: "/spec/claimRef/namespace",
            value: namespaceName,
          },
          {
            op: "add",
            path: "/spec/persistentVolumeReclaimPolicy",
            value: "Delete",
          },
        ]);
    }
    if (namespace && !namespace.metadata.deletionTimestamp)
      await this.k8s.delete(
        "Namespace",
        undefined,
        namespaceName,
        uid(namespace),
      );
    const remainingNamespace = await this.k8s.read(
      "Namespace",
      undefined,
      namespaceName,
    );
    const [remainingPvs, remainingLvs] = await Promise.all([
      this.k8s.list("PersistentVolume"),
      this.k8s.list("LVMVolume"),
    ]);
    const remaining =
      remainingNamespace !== null ||
      remainingPvs.some(
        (pv) =>
          record(record(pv.spec).claimRef).namespace === namespaceName ||
          state.volumes.some((volume) => volume.name === pv.metadata.name),
      ) ||
      remainingLvs.some((lv) =>
        state.volumes.some((volume) => volume.handle === lv.metadata.name),
      );
    if (remaining)
      return {
        id: db.id,
        generation: db.generation,
        state:
          this.now() - state.startedAt >= DELETE_TIMEOUT_MS
            ? "error"
            : "deleting",
        ...(this.now() - state.startedAt >= DELETE_TIMEOUT_MS
          ? { message: "storage deletion did not complete within ten minutes" }
          : {}),
        archive: { continuous: false, ready_wal_files: null },
      };
    const gatewayFence = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      gatewayFenceName(db.id),
    );
    const deletionLedger = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      `${LEDGER_PREFIX}${db.id}`,
    );
    if (
      gatewayFence ||
      fence?.metadata.annotations?.["pgcf.io/gateway-fence-uid"] ||
      record(deletionLedger?.data)["gateway-retirement.json"] !== undefined
    ) {
      const retired = await retireGatewayFence(db, {
        k8s: this.k8s,
        signal: this.signal,
        now: this.now,
        fetcher: this.fetcher,
        snapshot: async (signal) => {
          if (!this.power)
            throw new Error("gateway_retirement_configuration_missing");
          return this.power.gatewaySnapshot(signal);
        },
      });
      if (!retired)
        return {
          id: db.id,
          generation: db.generation,
          state: "deleting",
          archive: { continuous: false, ready_wal_files: null },
        };
    }
    const ca = await this.k8s.read(
      "ConfigMap",
      SYSTEM_NAMESPACE,
      `ca-${db.id}`,
    );
    if (ca) {
      assertOwned(ca, db.id, `ca-${db.id}`);
      await this.k8s.delete(
        "ConfigMap",
        SYSTEM_NAMESPACE,
        ca.metadata.name,
        uid(ca),
      );
    }
    if (fence)
      await this.k8s.delete(
        "ConfigMap",
        SYSTEM_NAMESPACE,
        fence.metadata.name,
        uid(fence),
      );
    if (!state.completed) {
      state.completed = true;
      state.volumes = [];
      state.namespaceUid = null;
      await this.saveLedger(db, state, true);
    }
    this.hashes.delete(db.id);
    this.highWater.delete(db.id);
    return {
      id: db.id,
      generation: db.generation,
      state: "deleted",
      archive: { continuous: false, ready_wal_files: 0 },
    };
  }
}
