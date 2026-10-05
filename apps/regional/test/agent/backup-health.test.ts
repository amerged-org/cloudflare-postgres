// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BackupHealthCollector } from "../../src/agent/backup-health.ts";
import { record } from "../../src/agent/types.ts";
import { fixture, MemoryKubernetes } from "./fixtures.ts";

function setup() {
  const { db } = fixture();
  const k8s = new MemoryKubernetes();
  const namespace = k8s.ownedNamespace(db);
  const plugin = "barman-cloud.cloudnative-pg.io";
  const cluster = k8s.put({
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: {
      name: "database",
      namespace: namespace.metadata.name,
      labels: { "pgcf.io/database-id": db.id },
    },
    spec: {
      plugins: [
        {
          name: plugin,
          enabled: true,
          isWALArchiver: true,
          parameters: {
            barmanObjectName: "archive",
            serverName: db.archive.server_name,
          },
        },
      ],
    },
  });
  const store = k8s.put({
    apiVersion: "barmancloud.cnpg.io/v1",
    kind: "ObjectStore",
    metadata: {
      name: "archive",
      namespace: namespace.metadata.name,
      labels: { "pgcf.io/database-id": db.id },
    },
    spec: { configuration: { destinationPath: db.archive.destination_path } },
  });
  const now = Date.parse("2026-01-02T12:00:00.000Z");
  const completed = new Date(now - 60_000).toISOString();
  const owner = () => ({
    apiVersion: cluster.apiVersion,
    kind: cluster.kind,
    name: cluster.metadata.name,
    uid: cluster.metadata.uid,
  });
  const backup = (phase: "completed" | "failed", at = completed) =>
    k8s.put({
      apiVersion: cluster.apiVersion,
      kind: "Backup",
      metadata: {
        name: `backup-${randomUUID()}`,
        namespace: namespace.metadata.name,
        labels: { "cnpg.io/cluster": cluster.metadata.name },
        ...{
          ownerReferences: [owner()],
          creationTimestamp: new Date(now - 120_000).toISOString(),
        },
      },
      spec: {
        cluster: { name: cluster.metadata.name },
        method: "plugin",
        pluginConfiguration: { name: plugin },
      },
      status: {
        phase,
        reconciliationTerminatedAt: at,
        ...(phase === "completed"
          ? {
              backupId: randomUUID(),
              startedAt: new Date(now - 90_000).toISOString(),
              stoppedAt: at,
              pluginMetadata: {
                pluginName: plugin,
                clusterUID: cluster.metadata.uid,
              },
            }
          : {}),
      },
    });
  return { db, k8s, namespace, cluster, store, now, completed, backup, owner };
}

test("completed plugin backups and later failures retain actual timestamps with a bounded cache", async () => {
  const state = setup();
  state.backup("completed");
  let inventories = 0;
  const original = state.k8s.list.bind(state.k8s);
  state.k8s.list = async (...args) => {
    if (args[0] === "Backup") {
      inventories++;
      assert.deepEqual(args.slice(1), [state.namespace.metadata.name]);
    }
    return original(...args);
  };
  const collector = new BackupHealthCollector();
  const first = await collector.collect(
    state.k8s,
    state.db,
    state.namespace,
    state.cluster,
    state.now,
  );
  assert.deepEqual(first, {
    observed_at: new Date(state.now).toISOString(),
    health: "ok",
    last_completed_at: state.completed,
    last_failed_at: null,
  });
  state.backup("failed", new Date(state.now + 30_000).toISOString());
  assert.deepEqual(
    await collector.collect(
      state.k8s,
      state.db,
      state.namespace,
      state.cluster,
      state.now + 45_000,
    ),
    first,
  );
  const next = await collector.collect(
    state.k8s,
    state.db,
    state.namespace,
    state.cluster,
    state.now + 60_000,
  );
  assert.equal(inventories, 2);
  assert.equal(next.health, "failing");
  assert.equal(next.last_completed_at, state.completed);
  assert.equal(next.last_failed_at, new Date(state.now + 30_000).toISOString());
});

test("unowned completed plugin metadata can bind the source but failed backups need the exact Cluster owner", async () => {
  const state = setup();
  const completed = state.backup("completed");
  delete record(completed.metadata).ownerReferences;
  const collector = new BackupHealthCollector();
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now,
      )
    ).health,
    "ok",
  );
  const failed = state.backup("failed");
  delete record(failed.metadata).ownerReferences;
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now + 60_000,
      )
    ).health,
    "unknown",
  );
});

test("foreign Cluster metadata or namespaces cannot report a successful base backup", async () => {
  const state = setup();
  const backup = state.backup("completed");
  record(record(backup.status).pluginMetadata).clusterUID = randomUUID();
  const collector = new BackupHealthCollector();
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now,
      )
    ).health,
    "unknown",
  );
  record(record(backup.status).pluginMetadata).clusterUID =
    state.cluster.metadata.uid;
  backup.metadata.namespace = "pgcf-other";
  state.k8s.list = async () => [backup];
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now + 60_000,
      )
    ).health,
    "unknown",
  );
});

test("archive replacement or identity changes during inventory invalidate completion", async () => {
  const state = setup();
  state.backup("completed");
  const collector = new BackupHealthCollector();
  const original = state.k8s.list.bind(state.k8s);
  state.k8s.list = async (...args) => {
    const items = await original(...args);
    if (args[0] === "Backup") state.store.metadata.uid = randomUUID();
    return items;
  };
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now,
      )
    ).health,
    "unknown",
  );
  record(record(state.store.spec).configuration).destinationPath =
    `${state.db.archive.destination_path}-changed`;
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now + 60_000,
      )
    ).health,
    "unknown",
  );
});

test("missing, ambiguous, future and invalid terminal observations remain unknown", async () => {
  const state = setup();
  const collector = new BackupHealthCollector();
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now,
      )
    ).health,
    "unknown",
  );
  const backup = state.backup(
    "completed",
    new Date(state.now + 10_000).toISOString(),
  );
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now,
      )
    ).health,
    "unknown",
  );
  record(backup.status).stoppedAt = state.completed;
  record(backup.status).reconciliationTerminatedAt = state.completed;
  const original = state.k8s.list.bind(state.k8s);
  state.k8s.list = async (...args) => [...(await original(...args)), backup];
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now + 60_000,
      )
    ).health,
    "unknown",
  );
  state.k8s.list = original;
  delete record(backup.status).backupId;
  assert.equal(
    (
      await collector.collect(
        state.k8s,
        state.db,
        state.namespace,
        state.cluster,
        state.now + 120_000,
      )
    ).health,
    "unknown",
  );
});

test("bounded inventory errors are an unknown sample and retain no fabricated terminal timestamp", async () => {
  const state = setup();
  state.k8s.list = async () => {
    throw new Error("inventory_bound_exceeded");
  };
  const result = await new BackupHealthCollector().collect(
    state.k8s,
    state.db,
    state.namespace,
    state.cluster,
    state.now,
  );
  assert.deepEqual(result, {
    observed_at: new Date(state.now).toISOString(),
    health: "unknown",
    last_completed_at: null,
    last_failed_at: null,
  });
});

test("manual Backup CRs are observed without scheduler labels and status version churn does not bypass the minute cache", async () => {
  const state = setup();
  const backup = state.backup("completed");
  delete backup.metadata.labels;
  let inventories = 0;
  const original = state.k8s.list.bind(state.k8s);
  state.k8s.list = async (...args) => {
    inventories++;
    return original(...args);
  };
  const collector = new BackupHealthCollector();
  const first = await collector.collect(
    state.k8s,
    state.db,
    state.namespace,
    state.cluster,
    state.now,
  );
  assert.equal(first.health, "ok");
  state.cluster.metadata.resourceVersion = "changed-status";
  assert.deepEqual(
    await collector.collect(
      state.k8s,
      state.db,
      state.namespace,
      state.cluster,
      state.now + 15_000,
    ),
    first,
  );
  assert.equal(inventories, 1);
});
