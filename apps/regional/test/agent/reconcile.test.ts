// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { GENERATION_ANNOTATION } from "../../src/agent/observe.ts";
import { record } from "../../src/agent/types.ts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";
import { roleSecretName } from "../../src/agent/builders/index.ts";

const signal = () => new AbortController().signal;

test("Ready status cannot acknowledge credentials rejected by PostgreSQL", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const rejected = async () => false;
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    rejected,
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "provisioning");
});

test("an applied revision cannot report ready from old runtime spec or role credentials", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.spec).imageName = "old-unapplied-image";
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  record(cluster.spec).imageName = ctx.postgresImage;
  const secret = k8s.resources.get(
    k8s.key("Secret", `pgcf-db-${db.id}`, roleSecretName("app")),
  )!;
  const original = record(secret.data).password;
  record(secret.data).password = Buffer.from(
    fixture().db.roles[0]!.password,
  ).toString("base64");
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  record(secret.data).password = original;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
});

test("operator acknowledgement and primary runtime must match the current role and size", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  const status = record(cluster.status);
  status.secretsResourceVersion = { applicationSecretVersion: "older-secret" };
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
});

test("crash after each mutation converges on restart and a completed rerun has no mutations", async () => {
  const { db, ctx } = fixture();
  const baseline = new MemoryKubernetes();
  assert.equal(
    (
      await new Reconciler(
        baseline,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  const steps = baseline.mutations;
  for (let step = 1; step <= steps; step += 1) {
    const k8s = new MemoryKubernetes();
    k8s.failAfter = step;
    await assert.rejects(
      new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
        db,
        ctx,
      ),
    );
    k8s.failAfter = -1;
    assert.equal(
      (
        await new Reconciler(
          k8s,
          signal(),
          Date.now,
          metrics,
          authenticate,
        ).reconcile(db, ctx)
      )?.state,
      "ready",
    );
    const count = k8s.actions.length;
    assert.equal(
      (
        await new Reconciler(
          k8s,
          signal(),
          Date.now,
          metrics,
          authenticate,
        ).reconcile(db, ctx)
      )?.state,
      "ready",
    );
    assert.equal(k8s.actions.length, count);
  }
});

test("configuration revisions advance monotonically while the archive remains unchanged", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const reconciler = new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  );
  await reconciler.reconcile(db, ctx);
  await reconciler.reconcile({ ...db, generation: 2 }, ctx);
  const before = k8s.actions.length;
  assert.equal(
    await new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
    ).reconcile(db, ctx),
    null,
  );
  assert.equal(k8s.actions.length, before);
  const namespace = await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`);
  assert.equal(namespace?.metadata.annotations?.[GENERATION_ANNOTATION], "2");
  assert.equal(
    record(
      record(
        (await k8s.read("ObjectStore", `pgcf-db-${db.id}`, "archive"))?.spec,
      ).configuration,
    ).destinationPath,
    db.archive.destination_path,
  );
});

test("equal applied generation still observes readiness and repairs missing CA publication", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  k8s.ready = false;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  k8s.resources.delete(k8s.key("ConfigMap", "pgcf-system", `ca-${db.id}`));
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  const ca = await k8s.read("ConfigMap", "pgcf-system", `ca-${db.id}`);
  assert.deepEqual(Object.keys(record(ca?.data)), ["ca.crt"]);
});

test("readiness requires Ready, ContinuousArchiving and published CA", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  k8s.archiving = false;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  record(cluster.status).certificates = {};
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  record(cluster.status).certificates = { serverCASecret: "database-ca" };
  const restarted = new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  );
  assert.equal((await restarted.reconcile(db, ctx))?.state, "ready");
});

test("ten minutes of archive failure or a real WAL backlog reports unhealthy; missing samples stay null", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-02T12:00:00Z");
  k8s.archiving = false;
  k8s.archivingSince = new Date(now - 600_001).toISOString();
  const observation = await new Reconciler(
    k8s,
    signal(),
    () => now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "error");
  assert.equal(observation?.archive.continuous, false);
  const unavailable: typeof fetch = async () => {
    throw new Error("metrics_unavailable");
  };
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        unavailable,
        authenticate,
      ).reconcile(db, ctx)
    )?.archive.ready_wal_files,
    null,
  );
  const backlog: typeof fetch = async () =>
    new Response('cnpg_collector_pg_wal_archive_status{value="ready"} 33\n');
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        backlog,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "error",
  );
});

test("tombstone patches the owned PV before deleting namespace and persists a terminal fence", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  k8s.addStorage(db);
  k8s.actions = [];
  const deleted = {
    ...db,
    generation: 2,
    desired_state: "deleted" as const,
    roles: [],
  };
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(deleted)
    )?.state,
    "deleted",
  );
  const patch = k8s.actions.findIndex((action) =>
    action.startsWith("patch:PersistentVolume"),
  );
  const remove = k8s.actions.findIndex((action) =>
    action.startsWith("delete:Namespace"),
  );
  assert.ok(patch >= 0 && patch < remove);
  assert.equal((await k8s.list("PersistentVolume")).length, 0);
  assert.equal((await k8s.list("LVMVolume")).length, 0);
  assert.equal(await k8s.read("ConfigMap", "pgcf-system", `ca-${db.id}`), null);
  const count = k8s.actions.length;
  assert.equal(
    await new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
    ).reconcile(db, ctx),
    null,
  );
  assert.equal(k8s.actions.length, count);
});

test("delete survives each mutation crash and keeps observing retained LV after namespace and PV vanish", async () => {
  const { db, ctx } = fixture();
  const deleted = {
    ...db,
    generation: 2,
    desired_state: "deleted" as const,
    roles: [],
  };
  const baseline = new MemoryKubernetes();
  await new Reconciler(
    baseline,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  baseline.addStorage(db);
  baseline.mutations = 0;
  await new Reconciler(
    baseline,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(deleted);
  const deleteSteps = baseline.mutations;
  for (let step = 1; step <= deleteSteps; step += 1) {
    const k8s = new MemoryKubernetes();
    await new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
    ).reconcile(db, ctx);
    k8s.addStorage(db);
    k8s.mutations = 0;
    k8s.failAfter = step;
    await assert.rejects(
      new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
        deleted,
      ),
    );
    k8s.failAfter = -1;
    assert.equal(
      (
        await new Reconciler(
          k8s,
          signal(),
          Date.now,
          metrics,
          authenticate,
        ).reconcile(deleted)
      )?.state,
      "deleted",
    );
  }
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  k8s.addStorage(db);
  k8s.autoDeleteStorage = false;
  const now = 1_000_000;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        metrics,
        authenticate,
      ).reconcile(deleted)
    )?.state,
    "deleting",
  );
  for (const [key, value] of k8s.resources)
    if (value.kind === "PersistentVolume") k8s.resources.delete(key);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now + 600_001,
        metrics,
      ).reconcile(deleted)
    )?.state,
    "error",
  );
  for (const [key, value] of k8s.resources)
    if (value.kind === "LVMVolume") k8s.resources.delete(key);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now + 600_002,
        metrics,
      ).reconcile(deleted)
    )?.state,
    "deleted",
  );
});

test("foreign namespace is refused and foreign PV is never reclaimed", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  k8s.put({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: `pgcf-db-${db.id}` },
  });
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      db,
      ctx,
    ),
    /ownership/,
  );
  assert.equal(k8s.actions.length, 0);
});
