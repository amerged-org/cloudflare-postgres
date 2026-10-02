// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
  DatabaseObservation,
  DesiredDatabase,
  K8sObject,
} from "@pgcf/contracts";
import {
  buildCaConfigMap,
  buildDatabaseManifests,
  databaseNamespace,
} from "./builders/index.ts";
import type { BuildContext } from "./builders/index.ts";
import {
  appliedGeneration,
  ARCHIVE_FAILURE_MS,
  condition,
  DATABASE_LABEL,
  GENERATION_ANNOTATION,
  readyWalFiles,
  WAL_BACKLOG_LIMIT,
} from "./observe.ts";
import { record, string, uid } from "./types.ts";
import type { Kubernetes, Resource } from "./types.ts";

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

const LEDGER_PREFIX = "delete-";
const SYSTEM_NAMESPACE = "pgcf-system";
const DELETE_TIMEOUT_MS = 10 * 60_000;

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
    if (!value || /[\r\n\u0000]/.test(value))
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
  constructor(
    private k8s: Kubernetes,
    private signal: AbortSignal,
    private now = Date.now,
    private fetcher: typeof fetch = fetch,
  ) {}

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
    const applied = Math.max(
      appliedGeneration(namespace),
      appliedGeneration(ledger),
      this.highWater.get(db.id) ?? 0,
    );
    if (db.generation < applied) return null;
    this.highWater.set(db.id, db.generation);
    if (db.desired_state === "deleted")
      return this.delete(db, namespace, ledger);
    if (!ctx) throw new Error("build_context_required");
    if (ledger) throw new Error("database_deletion_irreversible");
    if (namespace?.metadata.deletionTimestamp)
      throw new Error("database_namespace_deleting");

    if (db.generation > appliedGeneration(namespace)) {
      const manifests = buildDatabaseManifests(db, ctx);
      // Keep the last completed revision throughout a partial apply. The fence advances last.
      const first = manifests[0];
      if (
        !first ||
        first.kind !== "Namespace" ||
        first.metadata.name !== namespaceName
      )
        throw new Error("builder_namespace_invalid");
      if (namespace?.metadata.annotations)
        first.metadata.annotations = {
          ...first.metadata.annotations,
          ...namespace.metadata.annotations,
        };
      const hash = createHash("sha256")
        .update(JSON.stringify(manifests))
        .digest("hex");
      if (this.hashes.get(db.id) !== hash) {
        await this.k8s.apply(first);
        const active = await this.k8s.read(
          "Namespace",
          undefined,
          namespaceName,
        );
        if (!active || record(active.status).phase !== "Active") return null;
        assertOwned(active, db.id, namespaceName);
        if (active.metadata.deletionTimestamp)
          throw new Error("database_namespace_deleting");
        for (const manifest of manifests.slice(1)) {
          if (
            manifest.metadata.namespace !== namespaceName ||
            manifest.metadata.labels?.[DATABASE_LABEL] !== db.id
          )
            throw new Error("builder_resource_scope_invalid");
          await this.k8s.apply(manifest);
        }
        this.hashes.set(db.id, hash);
      }
      const current = await this.k8s.read(
        "Namespace",
        undefined,
        namespaceName,
      );
      if (!current) throw new Error("database_namespace_missing");
      assertOwned(current, db.id, namespaceName);
      if (appliedGeneration(current) > db.generation) return null;
      await this.k8s.patch("Namespace", undefined, namespaceName, [
        { op: "test", path: "/metadata/uid", value: uid(current) },
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
    if (!cluster)
      return {
        id: db.id,
        generation: db.generation,
        state: "provisioning",
        archive: { continuous: false, ready_wal_files: null },
      };
    let count: number | null;
    try {
      count = await readyWalFiles(
        this.k8s,
        namespaceName,
        cluster,
        this.signal,
        this.fetcher,
      );
    } catch {
      if (this.signal.aborted) throw new Error("agent_aborted");
      count = null;
    }
    const archive = condition(cluster, "ContinuousArchiving");
    const backlog = count !== null && count >= WAL_BACKLOG_LIMIT;
    const continuous = archive?.status === "True" && !backlog;
    if (continuous) this.archiveFailures.delete(db.id);
    else {
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
    const unhealthy =
      !continuous &&
      this.now() - (this.archiveFailures.get(db.id) ?? this.now()) >=
        ARCHIVE_FAILURE_MS;
    return {
      id: db.id,
      generation: db.generation,
      state:
        unhealthy || backlog
          ? "error"
          : condition(cluster, "Ready")?.status === "True" &&
              continuous &&
              publicCa &&
              count !== null
            ? "ready"
            : "provisioning",
      ...(unhealthy || backlog
        ? { message: "continuous WAL archiving is unhealthy" }
        : {}),
      archive: { continuous, ready_wal_files: count },
    };
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
