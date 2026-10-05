// SPDX-License-Identifier: Apache-2.0
import type { DesiredDatabase } from "@pgcf/contracts";
import { DATABASE_LABEL } from "./observe.ts";
import {
  record,
  string,
  uid,
  type Kubernetes,
  type Resource,
} from "./types.ts";

const PLUGIN = "barman-cloud.cloudnative-pg.io";
const INTERVAL_MS = 60_000;
export interface BackupHealth {
  observed_at: string;
  health: "ok" | "failing" | "unknown";
  last_completed_at: string | null;
  last_failed_at: string | null;
}
function owned(
  resource: Resource | null,
  db: DesiredDatabase,
  namespace?: string,
): Resource {
  if (
    !resource ||
    !resource.metadata.resourceVersion ||
    resource.metadata.deletionTimestamp ||
    resource.metadata.labels?.[DATABASE_LABEL] !== db.id ||
    resource.metadata.namespace !== namespace
  )
    throw new Error("backup_owner_unknown");
  uid(resource);
  return resource;
}
const fingerprint = (resource: Resource) =>
  JSON.stringify({
    uid: uid(resource),
    version: resource.metadata.resourceVersion,
    metadata: resource.metadata,
    spec: resource.spec,
  });
function time(value: unknown, now: number): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)
  )
    throw new Error("backup_time_unknown");
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > now)
    throw new Error("backup_time_unknown");
  return new Date(parsed).toISOString();
}

export class BackupHealthCollector {
  private readonly cache = new Map<
    string,
    { binding: string; result: BackupHealth }
  >();
  async collect(
    k8s: Kubernetes,
    db: DesiredDatabase,
    namespace: Resource,
    cluster: Resource,
    now: number,
  ): Promise<BackupHealth> {
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("backup_clock_invalid");
    const unknown: BackupHealth = {
      observed_at: new Date(now).toISOString(),
      health: "unknown",
      last_completed_at: null,
      last_failed_at: null,
    };
    try {
      owned(namespace, db);
      owned(cluster, db, namespace.metadata.name);
      if (
        namespace.kind !== "Namespace" ||
        namespace.metadata.name !== `pgcf-db-${db.id}` ||
        cluster.kind !== "Cluster" ||
        cluster.apiVersion !== "postgresql.cnpg.io/v1" ||
        cluster.metadata.name !== "database"
      )
        throw new Error("backup_owner_unknown");
      const plugins = record(cluster.spec).plugins;
      const configured = Array.isArray(plugins)
        ? plugins.map(record).filter((p) => p.name === PLUGIN)
        : [];
      if (
        configured.length !== 1 ||
        configured[0]!.enabled !== true ||
        configured[0]!.isWALArchiver !== true
      )
        throw new Error("backup_archive_unknown");
      const parameters = record(configured[0]!.parameters);
      const name = string(parameters.barmanObjectName);
      if (
        !name ||
        name.length > 63 ||
        !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) ||
        parameters.serverName !== db.archive.server_name
      )
        throw new Error("backup_archive_unknown");
      const store = owned(
        await k8s.read("ObjectStore", namespace.metadata.name, name),
        db,
        namespace.metadata.name,
      );
      if (
        store.kind !== "ObjectStore" ||
        store.apiVersion !== "barmancloud.cnpg.io/v1" ||
        store.metadata.name !== name ||
        record(record(store.spec).configuration).destinationPath !==
          db.archive.destination_path
      )
        throw new Error("backup_archive_unknown");
      const namespaceBefore = fingerprint(namespace),
        clusterBefore = fingerprint(cluster),
        storeBefore = fingerprint(store);
      const binding = JSON.stringify([
        db.generation,
        db.archive,
        namespaceBefore,
        clusterBefore,
        storeBefore,
      ]);
      const prior = this.cache.get(db.id);
      if (
        prior?.binding === binding &&
        now >= Date.parse(prior.result.observed_at) &&
        now - Date.parse(prior.result.observed_at) < INTERVAL_MS
      )
        return { ...prior.result };
      const backups = await k8s.list(
        "Backup",
        namespace.metadata.name,
        `cnpg.io/cluster=${cluster.metadata.name}`,
      );
      if (
        backups.length > 10_000 ||
        new Set(backups.map((backup) => uid(backup))).size !== backups.length
      )
        throw new Error("backup_inventory_unknown");
      let completed: string | null = null,
        failed: string | null = null;
      for (const backup of backups) {
        if (
          backup.kind !== "Backup" ||
          backup.apiVersion !== cluster.apiVersion ||
          backup.metadata.namespace !== namespace.metadata.name ||
          backup.metadata.deletionTimestamp ||
          !backup.metadata.resourceVersion ||
          record(record(backup.spec).cluster).name !== cluster.metadata.name ||
          record(backup.spec).method !== "plugin" ||
          record(record(backup.spec).pluginConfiguration).name !== PLUGIN
        )
          throw new Error("backup_identity_unknown");
        const overrides = record(
          record(record(backup.spec).pluginConfiguration).parameters,
        );
        if (
          (overrides.barmanObjectName !== undefined &&
            overrides.barmanObjectName !== name) ||
          (overrides.serverName !== undefined &&
            overrides.serverName !== db.archive.server_name)
        )
          throw new Error("backup_archive_unknown");
        const status = record(backup.status);
        if (
          (status.destinationPath !== undefined &&
            status.destinationPath !== db.archive.destination_path) ||
          (status.serverName !== undefined &&
            status.serverName !== db.archive.server_name)
        )
          throw new Error("backup_archive_unknown");
        const owners = record(backup.metadata).ownerReferences;
        const clusterOwners = Array.isArray(owners)
          ? owners.map(record).filter((owner) => owner.kind === cluster.kind)
          : [];
        const exactOwner =
          clusterOwners.length === 1 &&
          clusterOwners[0]!.uid === uid(cluster) &&
          clusterOwners[0]!.apiVersion === cluster.apiVersion &&
          clusterOwners[0]!.name === cluster.metadata.name;
        if (clusterOwners.length && !exactOwner)
          throw new Error("backup_owner_unknown");
        const metadata = record(status.pluginMetadata);
        if (
          metadata.clusterUID !== undefined &&
          metadata.clusterUID !== uid(cluster)
        )
          throw new Error("backup_owner_unknown");
        if (
          ["pending", "started", "running", "finalizing"].includes(
            String(status.phase),
          )
        )
          continue;
        const created = time(record(backup.metadata).creationTimestamp, now);
        const terminated = time(status.reconciliationTerminatedAt, now);
        if (terminated < created) throw new Error("backup_time_unknown");
        if (status.phase === "completed") {
          const started = time(status.startedAt, now),
            stopped = time(status.stoppedAt, now);
          if (
            metadata.clusterUID !== uid(cluster) ||
            metadata.pluginName !== PLUGIN ||
            !string(status.backupId) ||
            String(status.backupId).length > 253 ||
            started < created ||
            stopped < started ||
            stopped > terminated
          )
            throw new Error("backup_completion_unknown");
          if (completed === null || stopped > completed) completed = stopped;
        } else if (status.phase === "failed") {
          if (!exactOwner) throw new Error("backup_owner_unknown");
          if (failed === null || terminated > failed) failed = terminated;
        } else throw new Error("backup_phase_unknown");
      }
      const [currentNamespace, currentCluster, currentStore] =
        await Promise.all([
          k8s.read("Namespace", undefined, namespace.metadata.name),
          k8s.read("Cluster", namespace.metadata.name, cluster.metadata.name),
          k8s.read("ObjectStore", namespace.metadata.name, name),
        ]);
      if (
        fingerprint(owned(currentNamespace, db)) !== namespaceBefore ||
        fingerprint(owned(currentCluster, db, namespace.metadata.name)) !==
          clusterBefore ||
        fingerprint(owned(currentStore, db, namespace.metadata.name)) !==
          storeBefore
      )
        throw new Error("backup_identity_changed");
      const result: BackupHealth = {
        ...unknown,
        last_completed_at: completed,
        last_failed_at: failed,
        health:
          failed && (!completed || failed >= completed)
            ? "failing"
            : completed
              ? "ok"
              : "unknown",
      };
      if (this.cache.size >= 10_000 && !this.cache.has(db.id))
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(db.id, { binding, result });
      return { ...result };
    } catch {
      this.cache.delete(db.id);
      return unknown;
    }
  }
}
