// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { record } from "../../src/agent/types.ts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";

test("resize waits for actual Pod resources and active settings rather than a stale Ready condition", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  assert.equal(
    (
      await new Reconciler(
        k8s,
        new AbortController().signal,
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  const key = k8s.key("Pod", `pgcf-db-${db.id}`, "database-1");
  const oldPod = structuredClone(k8s.resources.get(key)!);
  const identity = structuredClone(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.data,
  );
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, namespace, name, operations) => {
    await patch(kind, namespace, name, operations);
    if (kind === "Cluster") k8s.resources.set(key, structuredClone(oldPod));
  };
  const desired = structuredClone(db);
  desired.generation++;
  desired.creation!.ever_ready = true;
  desired.size.memory_mib *= 2;
  desired.size.cpu_millicores *= 2;
  desired.size.max_connections += 50;
  let activeSettings = false;
  const probe = async () => activeSettings;
  const reconcile = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      probe,
    ).reconcile(desired, ctx);
  assert.equal((await reconcile())?.state, "provisioning");
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record((record(oldPod.spec).containers as unknown[])[0]).resources =
    structuredClone(record(cluster.spec).resources);
  k8s.resources.set(key, oldPod);
  assert.equal((await reconcile())?.state, "provisioning");
  activeSettings = true;
  assert.equal((await reconcile())?.state, "ready");
  assert.deepEqual(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.data,
    identity,
  );
  assert.equal(desired.archive.destination_path, db.archive.destination_path);
});

test("missing or replaced Pod and PVC cannot acknowledge ready resources", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const reconcile = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
    ).reconcile(db, ctx);
  assert.equal((await reconcile())?.state, "ready");
  const ns = `pgcf-db-${db.id}`;
  const podKey = k8s.key("Pod", ns, "database-1");
  const claimKey = k8s.key("PersistentVolumeClaim", ns, "database-1");
  const pod = k8s.resources.get(podKey)!;
  const claim = k8s.resources.get(claimKey)!;
  k8s.resources.delete(podKey);
  assert.notEqual((await reconcile())?.state, "ready");
  k8s.resources.set(podKey, pod);
  k8s.resources.delete(claimKey);
  assert.notEqual((await reconcile())?.state, "ready");
  k8s.resources.set(claimKey, claim);
  const uid = claim.metadata.uid;
  claim.metadata.uid = randomUUID();
  assert.notEqual((await reconcile())?.state, "ready");
  claim.metadata.uid = uid;
  const owners = record(pod.metadata).ownerReferences;
  record(pod.metadata).ownerReferences = [];
  assert.notEqual((await reconcile())?.state, "ready");
  record(pod.metadata).ownerReferences = owners;
  const race = async () => {
    pod.metadata.uid = randomUUID();
    return true;
  };
  assert.notEqual(
    (
      await new Reconciler(
        k8s,
        new AbortController().signal,
        Date.now,
        metrics,
        race,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
});

test("a fully rebound replacement PVC and PV cannot replace previously acknowledged storage", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const reconcile = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
    ).reconcile(db, ctx);
  assert.equal((await reconcile())?.state, "ready");
  const claim = k8s.resources.get(
    k8s.key("PersistentVolumeClaim", `pgcf-db-${db.id}`, "database-1"),
  )!;
  const volume = k8s.resources.get(
    k8s.key(
      "PersistentVolume",
      undefined,
      String(record(claim.spec).volumeName),
    ),
  )!;
  claim.metadata.uid = randomUUID();
  volume.metadata.uid = randomUUID();
  record(record(volume.spec).claimRef).uid = claim.metadata.uid;
  assert.notEqual((await reconcile())?.state, "ready");
});
