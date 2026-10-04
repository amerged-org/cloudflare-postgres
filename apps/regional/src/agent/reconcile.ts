// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
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
import type { Kubernetes, Resource } from "./types.ts";
import { probeRoles } from "./readiness.ts";
import type { AuthenticationProbe } from "./readiness.ts";

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
  constructor(
    k8s: Kubernetes,
    signal: AbortSignal,
    now = Date.now,
    fetcher: typeof fetch = fetch,
    authenticate: AuthenticationProbe = probeRoles,
  ) {
    this.k8s = k8s;
    this.signal = signal;
    this.now = now;
    this.fetcher = fetcher;
    this.authenticate = authenticate;
  }

  async reconcile(
    db: DesiredDatabase,
    ctx?: BuildContext,
  ): Promise<DatabaseObservation | null> {
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
    if (!ctx) throw new Error("build_context_required");
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
              value: { ...namespace.metadata.labels, ...first.metadata.labels },
            },
          ]);
        } else await this.k8s.create(first);
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
        fence = await this.saveStorage(db, storage, fence);
        if (record(active.status).phase !== "Active") return null;
        if (acceptedGeneration(active) !== db.generation) return null;
        if (active.metadata.deletionTimestamp)
          throw new Error("database_namespace_deleting");
        for (const manifest of manifests.slice(1)) {
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
              fence = await this.saveStorage(db, storage, fence);
              if (!currentCluster.metadata.resourceVersion)
                throw new Error("database_cluster_version_missing");
              await this.k8s.patch("Cluster", namespaceName, "database", [
                {
                  op: "test",
                  path: "/metadata/uid",
                  value: uid(currentCluster),
                },
                {
                  op: "test",
                  path: "/metadata/resourceVersion",
                  value: currentCluster.metadata.resourceVersion,
                },
                {
                  op: "add",
                  path: "/metadata/annotations",
                  value: {
                    ...currentCluster.metadata.annotations,
                    ...manifest.metadata.annotations,
                  },
                },
                {
                  op: "add",
                  path: "/spec",
                  value: {
                    ...record(currentCluster.spec),
                    ...record(manifest.spec),
                  },
                },
              ]);
            } else {
              if (storage.clusterUid || !pendingCreation(db))
                return recoveryRequired(db, "database cluster is missing");
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
              fence = await this.saveStorage(db, storage, fence);
            }
          } else if (!(await this.applyRevision(db, manifest))) return null;
        }
        this.hashes.set(db.id, hash);
      }
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
    // Equal revisions still observe asynchronous CNPG readiness, archiving and CA publication.
    const cluster = await this.k8s.read("Cluster", namespaceName, "database");
    if (!cluster) return recoveryRequired(db, "database cluster is missing");
    assertOwned(cluster, db.id, "database");
    if (uid(cluster) !== storage.clusterUid)
      return recoveryRequired(db, "database cluster identity changed");
    let count: number | null;
    let progress: ArchiveProgress | null = null;
    let measured = false;
    try {
      const metrics = await archiveMetrics(
        this.k8s,
        namespaceName,
        cluster,
        this.signal,
        this.now,
        this.fetcher,
      );
      count = metrics.readyWalFiles;
      progress = metrics.progress;
      measured = metrics.valid;
    } catch {
      if (this.signal.aborted) throw new Error("agent_aborted");
      count = null;
    }
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
    const publicCa = await this.publishCa(db, cluster, namespaceName);
    const runtimeResources: Resource[] = [];
    const desiredApplied = await this.desiredApplied(
      db,
      ctx,
      cluster,
      namespaceName,
      runtimeResources,
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
        ? await this.authenticate(db, ca, this.signal)
        : false;
    const storageVerified =
      credentialsApplied &&
      (await this.verifyVolumeIdentity(db, fence, runtimeResources));
    const runtimeUnchanged =
      storageVerified && (await this.runtimeUnchanged(runtimeResources));
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
    return {
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

  private async applyRevision(
    db: DesiredDatabase,
    manifest: K8sObject,
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
    await this.k8s.patch(kind, metadata.namespace, metadata.name, [
      { op: "test", path: "/metadata/uid", value: uid(current) },
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: current.metadata.resourceVersion,
      },
      {
        op: "add",
        path: "/metadata/annotations",
        value: { ...current.metadata.annotations, ...metadata.annotations },
      },
      {
        op: "add",
        path: "/metadata/labels",
        value: { ...current.metadata.labels, ...metadata.labels },
      },
      ...Object.entries(manifest)
        .filter(([key]) => !["apiVersion", "kind", "metadata"].includes(key))
        .map(([key, value]) => ({
          op: "add",
          path: `/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          value,
        })),
    ]);
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
    const data = { state: JSON.stringify(state) };
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
  ): Promise<void> {
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
      await this.saveLedger(db, state);
    }
    this.hashes.delete(db.id);
    return {
      id: db.id,
      generation: db.generation,
      state: "deleted",
      archive: { continuous: false, ready_wal_files: 0 },
    };
  }
}
