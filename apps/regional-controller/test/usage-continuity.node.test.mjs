// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageJournal } from "../src/usage-journal.ts";
import { observeUsage } from "../src/usage-observer.ts";

const environmentId = "11111111-1111-4111-8111-111111111111";
const regionId = "22222222-2222-4222-8222-222222222222";
const identity = {
  regionId,
  sourceId: "33333333-3333-4333-8333-333333333333",
  sourceEpoch: 1,
};
const start = Date.parse("2026-09-28T00:00:10.000Z");

function inventory() {
  const namespace = `pgcf-${environmentId.replaceAll("-", "")}`;
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": environmentId,
    "pgcf.io/region-id": regionId,
  };
  const annotations = { "pgcf.io/spec-hash": "a".repeat(64) };
  return {
    namespaces: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: namespace,
          uid: "namespace-uid",
          labels,
          annotations,
        },
      },
    ],
    clusters: [
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: {
          name: "database",
          namespace,
          uid: "cluster-uid",
          labels,
          annotations,
        },
        spec: {
          instances: 1,
          storage: { size: "2Gi", storageClass: "test-local" },
        },
        status: { currentPrimary: "database-1" },
      },
    ],
    pods: [
      {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name: "database-1",
          namespace,
          uid: "pod-primary",
          resourceVersion: "10",
          ownerReferences: [
            {
              kind: "Cluster",
              name: "database",
              apiVersion: "postgresql.cnpg.io/v1",
              uid: "cluster-uid",
              controller: true,
            },
          ],
          labels: {
            "cnpg.io/cluster": "database",
            "cnpg.io/podRole": "instance",
          },
        },
        spec: {
          nodeName: "node-1",
          containers: [
            {
              name: "postgres",
              resources: { requests: { cpu: "250m", memory: "1.5Gi" } },
              volumeMounts: [
                { name: "pgdata", mountPath: "/var/lib/postgresql/data" },
              ],
            },
          ],
          volumes: [
            {
              name: "pgdata",
              persistentVolumeClaim: { claimName: "database-1" },
            },
          ],
        },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      },
    ],
    pvcs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: "database-1", namespace, uid: "pvc-uid" },
        spec: {
          volumeName: "volume-1",
          storageClassName: "test-local",
          resources: { requests: { storage: "2Gi" } },
        },
        status: { phase: "Bound", capacity: { storage: "2Gi" } },
      },
    ],
    pvs: [
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: { name: "volume-1", uid: "pv-uid", resourceVersion: "20" },
        spec: {
          capacity: { storage: "2Gi" },
          storageClassName: "test-local",
          persistentVolumeReclaimPolicy: "Retain",
          claimRef: { namespace, name: "database-1", uid: "pvc-uid" },
        },
        status: { phase: "Bound" },
      },
    ],
  };
}

function snapshot(resources, observedAt, volumes = []) {
  const observed = observeUsage(resources, regionId, volumes);
  assert.deepEqual(observed.issues, [], "the owned observation is complete");
  return { ...observed, observedAt, complete: true };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-usage-continuity-"));
  const path = join(directory, "usage.sqlite");
  let journal = new UsageJournal(path, identity);
  t.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  journal.beginSession(start);
  return {
    path,
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = new UsageJournal(path, identity);
      return journal;
    },
  };
}

test("status and resourceVersion churn preserve allocated time and exact durable facts", (t) => {
  const state = fixture(t);
  const resources = inventory();
  const first = snapshot(resources, start);
  state.journal.observe(first);
  resources.pods[0].metadata.resourceVersion = "11";
  resources.pods[0].status.conditions[0].status = "False";
  resources.pvs[0].metadata.resourceVersion = "21";
  const second = snapshot(resources, start + 1000);
  assert.notEqual(
    first.allocations[0].evidenceHash,
    second.allocations[0].evidenceHash,
    "changed observation evidence remains distinguishable",
  );
  state.journal.observe(second);
  const facts = state.journal.pending();
  assert.deepEqual(
    Object.fromEntries(
      facts.map((fact) => [fact.metric, [fact.status, fact.quantity]]),
    ),
    {
      cpu_millicore_ms: ["provisional", "250000"],
      memory_byte_ms: ["provisional", "1610612736000"],
      data_storage_byte_ms: ["provisional", "2147483648000"],
    },
    "unchanged allocation must retain positive resource-time",
  );
  assert.deepEqual(state.reopen().pending(), facts);
});

test("proven retained storage continues while disappearing compute is recorded as unknown", (t) => {
  const state = fixture(t);
  const resources = inventory();
  state.journal.observe(snapshot(resources, start));
  const known = state.journal.knownVolumes();
  resources.pods = [];
  resources.pvcs = [];
  resources.pvs[0].metadata.resourceVersion = "22";
  resources.pvs[0].status.phase = "Released";
  const retained = snapshot(resources, start + 1000, known);
  state.journal.observe(retained);
  const facts = state.journal.pending();
  const storage = facts.find((fact) => fact.metric === "data_storage_byte_ms");
  assert.deepEqual(
    [storage.status, storage.quantity],
    ["provisional", "2147483648000"],
    "the same retained PV remains an allocated storage resource",
  );
  assert.deepEqual(
    facts
      .filter((fact) => fact.metric !== "data_storage_byte_ms")
      .map((fact) => [fact.status, fact.quantity]),
    [
      ["gap", null],
      ["gap", null],
    ],
  );
  assert.deepEqual(state.reopen().pending(), facts);
  assert.deepEqual(state.journal.knownVolumes(), known);
});

test("legacy checkpoints transition conservatively without rewriting the existing outbox", (t) => {
  const state = fixture(t);
  const resources = inventory();
  state.journal.observe(snapshot(resources, start));
  state.journal.observe(snapshot(resources, start + 1000));
  const oldFacts = state.journal.pending();
  const database = new DatabaseSync(state.path);
  const oldRows = database
    .prepare("SELECT * FROM usage_outbox ORDER BY sequence")
    .all();
  const checkpoints = database
    .prepare("SELECT * FROM allocation_checkpoints")
    .all();
  for (const checkpoint of checkpoints) {
    const allocation = JSON.parse(checkpoint.payload_json);
    delete allocation.continuity;
    database
      .prepare(
        "UPDATE allocation_checkpoints SET payload_json=? WHERE allocation_key=?",
      )
      .run(JSON.stringify(allocation), checkpoint.allocation_key);
  }
  database.close();
  state.journal.observe(snapshot(resources, start + 2000));
  const transitioned = state.journal.pending();
  assert.deepEqual(
    transitioned
      .slice(oldFacts.length)
      .map((fact) => [fact.status, fact.quantity]),
    [
      ["gap", null],
      ["gap", null],
      ["gap", null],
    ],
    "legacy observations cannot establish the new continuity proof",
  );
  state.journal.observe(snapshot(resources, start + 3000));
  const recovered = state.journal.pending();
  assert.deepEqual(
    recovered.slice(transitioned.length).map((fact) => fact.status),
    ["provisional", "provisional", "provisional"],
  );
  assert.deepEqual(recovered.slice(0, oldFacts.length), oldFacts);
  const persisted = new DatabaseSync(state.path);
  assert.deepEqual(
    persisted
      .prepare("SELECT * FROM usage_outbox ORDER BY sequence LIMIT ?")
      .all(oldRows.length),
    oldRows,
    "already queued IDs, payload bytes and hashes must be preserved",
  );
  persisted.close();
  assert.deepEqual(state.reopen().pending(), recovered);
});
