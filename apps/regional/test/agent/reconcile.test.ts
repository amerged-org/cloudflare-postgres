// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { ApiException } from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Log } from "../../src/agent/types.ts";
import type { PowerCoordinator } from "../../src/agent/power.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import {
  ARCHIVE_OBSERVATION_ANNOTATION,
  GENERATION_ANNOTATION,
} from "../../src/agent/observe.ts";
import { record } from "../../src/agent/types.ts";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";
import { roleSecretName } from "../../src/agent/builders/index.ts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";

const signal = () => new AbortController().signal;

function archiveSample(
  pending: number,
  archived: number,
  lastArchived: number,
): typeof fetch {
  return async () =>
    new Response(
      [
        `cnpg_collector_pg_wal_archive_status{value="ready"} ${pending}`,
        `cnpg_pg_stat_archiver_archived_count ${archived}`,
        `cnpg_pg_stat_archiver_last_archived_time ${lastArchived.toExponential()}`,
        "cnpg_pg_stat_archiver_failed_count 0",
      ].join("\n"),
    );
}

test("an already-ready database stays ready during an archive stall and still authenticates current roles", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  let now = Date.parse("2026-10-04T04:36:00Z");
  const sample = archiveSample(4, 8, now / 1000 - 1893.679);
  let probes = 0;
  let accepted = true;
  const probe = async () => {
    probes++;
    return accepted;
  };
  const reconciler = new Reconciler(k8s, signal(), () => now, sample, probe);
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  db.creation!.ever_ready = true;
  now += 600_001;
  const stalled = await reconciler.reconcile(db, ctx);
  assert.equal(stalled?.state, "ready");
  assert.equal(stalled?.archive.continuous, false);
  assert.equal(stalled?.archive.ready_wal_files, 4);
  assert.match(stalled?.message ?? "", /archiving is unhealthy/);
  assert.equal(probes, 2);
  accepted = false;
  assert.notEqual((await reconciler.reconcile(db, ctx))?.state, "ready");
  assert.equal(probes, 3);
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "False" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  accepted = true;
  assert.notEqual((await reconciler.reconcile(db, ctx))?.state, "ready");
  assert.equal(probes, 3);
});

test("never-archived sentinel starts a pending queue timer and survives restart without making CREATE healthy", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const start = Date.parse("2026-10-04T04:36:00Z");
  const sample = archiveSample(1, 0, -1);
  const first = await new Reconciler(
    k8s,
    signal(),
    () => start,
    sample,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(first?.state, "provisioning");
  assert.equal(first?.archive.continuous, false);
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  assert.deepEqual(
    JSON.parse(fence!.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION]!),
    { archivedCount: 0, lastArchivedTime: -1, pendingSince: start },
  );
  const stalled = await new Reconciler(
    k8s,
    signal(),
    () => start + 600_001,
    sample,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(stalled?.state, "error");
  assert.equal(stalled?.archive.continuous, false);
  db.creation!.ever_ready = true;
  const existing = await new Reconciler(
    k8s,
    signal(),
    () => start + 600_002,
    sample,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(existing?.state, "ready");
  assert.equal(existing?.archive.continuous, false);
  const drained = await new Reconciler(
    k8s,
    signal(),
    () => start + 86400_000,
    archiveSample(0, 0, -1),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(drained?.state, "ready");
  assert.equal(drained?.archive.continuous, true);
});

test("exporter reset persists the new baseline without restarting pending time and later real progress resets it", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  let now = Date.parse("2026-10-04T04:36:00Z");
  const start = now;
  let archived = 8;
  let last = now / 1000 - 1;
  const sample: typeof fetch = (...args) =>
    archiveSample(1, archived, last)(...args);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  const identity = structuredClone(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.data,
  );
  now += 599_999;
  archived = 0;
  last = -1;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "provisioning",
  );
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  assert.deepEqual(
    JSON.parse(fence!.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION]!),
    { archivedCount: 0, lastArchivedTime: -1, pendingSince: start },
  );
  now += 2;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "error",
  );
  archived = 1;
  last = now / 1000;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  const advanced = await k8s.read(
    "ConfigMap",
    "pgcf-system",
    `storage-${db.id}`,
  );
  assert.equal(
    JSON.parse(advanced!.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION]!)
      .pendingSince,
    now,
  );
  assert.deepEqual(advanced?.data, identity);
  now += 600_001;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => now,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "error",
  );
});

test("a counter-only reset cannot use a newer timestamp to discard the original pending deadline", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const start = Date.parse("2026-10-04T04:36:00Z");
  await new Reconciler(
    k8s,
    signal(),
    () => start,
    archiveSample(1, 8, start / 1000 - 2),
    authenticate,
  ).reconcile(db, ctx);
  const reset = await new Reconciler(
    k8s,
    signal(),
    () => start + 600_001,
    archiveSample(1, 1, start / 1000 - 1),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(reset?.state, "error");
  assert.equal(reset?.archive.continuous, false);
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  assert.deepEqual(
    JSON.parse(fence!.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION]!),
    {
      archivedCount: 1,
      lastArchivedTime: start / 1000 - 1,
      pendingSince: start,
    },
  );
});

test("existing database readiness remains separate from measured CNPG failure and 32-file backlog health", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-04T04:36:00Z");
  await new Reconciler(
    k8s,
    signal(),
    () => now,
    archiveSample(0, 8, now / 1000 - 1),
    authenticate,
  ).reconcile(db, ctx);
  db.creation!.ever_ready = true;
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    {
      type: "ContinuousArchiving",
      status: "False",
      lastTransitionTime: new Date(now - 600_001).toISOString(),
    },
  ];
  const failed = await new Reconciler(
    k8s,
    signal(),
    () => now,
    archiveSample(0, 8, now / 1000 - 1),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(failed?.state, "ready");
  assert.equal(failed?.archive.continuous, false);
  assert.match(failed?.message ?? "", /archiving is unhealthy/);
  record(cluster.status).conditions = [
    { type: "Ready", status: "True" },
    { type: "ContinuousArchiving", status: "True" },
  ];
  const backlog = await new Reconciler(
    k8s,
    signal(),
    () => now,
    archiveSample(32, 8, now / 1000 - 1),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(backlog?.state, "ready");
  assert.equal(backlog?.archive.continuous, false);
  assert.equal(backlog?.archive.ready_wal_files, 32);
  assert.match(backlog?.message ?? "", /archiving is unhealthy/);
});

test("four pending WAL files with a successful CNPG condition become unhealthy when actual archival progress stalls", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  let now = Date.parse("2026-10-04T04:36:00Z");
  const sample = archiveSample(4, 8, now / 1000 - 1893.679);
  const reconciler = new Reconciler(
    k8s,
    signal(),
    () => now,
    sample,
    authenticate,
  );
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  const identity = structuredClone(fence?.data);
  now += 600_001;
  const stalled = await reconciler.reconcile(db, ctx);
  assert.equal(stalled?.state, "error");
  assert.equal(stalled?.archive.continuous, false);
  assert.equal(stalled?.archive.ready_wal_files, 4);
  assert.deepEqual(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.data,
    identity,
  );
});

test("agent restart preserves the first pending observation instead of restarting the archive stall clock", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const start = Date.parse("2026-10-04T04:36:00Z");
  const sample = archiveSample(1, 8, start / 1000 - 3600);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => start,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "ready",
  );
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        () => start + 600_001,
        sample,
        authenticate,
      ).reconcile(db, ctx)
    )?.state,
    "error",
  );
});

test("idle archive age does not start a timer and real archive progress resets a small queue timer", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  let now = Date.parse("2026-10-04T04:36:00Z");
  let pending = 0;
  let archived = 8;
  let lastArchived = now / 1000 - 86400;
  const sample: typeof fetch = (...args) =>
    archiveSample(pending, archived, lastArchived)(...args);
  const reconciler = new Reconciler(
    k8s,
    signal(),
    () => now,
    sample,
    authenticate,
  );
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  now += 600_001;
  pending = 1;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  now += 599_999;
  archived += 1;
  lastArchived = now / 1000;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  now += 599_999;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  now += 2;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "error");
  pending = 0;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  now += 86400_000;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
});

test("pending WAL without valid archive progress is uncertain and never healthy proof", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const sample: typeof fetch = async () =>
    new Response('cnpg_collector_pg_wal_archive_status{value="ready"} 4\n');
  const result = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    sample,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(result?.state, "provisioning");
  assert.equal(result?.archive.continuous, false);
  assert.equal(result?.archive.ready_wal_files, 4);
});

test("invalid progress cannot hide the existing 32-file backlog guard", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-04T04:36:00Z");
  const result = await new Reconciler(
    k8s,
    signal(),
    () => now,
    archiveSample(32, 8, now / 1000 + 1),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(result?.state, "error");
  assert.equal(result?.archive.ready_wal_files, 32);
  assert.equal(result?.archive.continuous, false);
});

test("partially missing and duplicated progress samples are uncertain even when the pending queue is empty", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const partial: typeof fetch = async () =>
    new Response(
      'cnpg_collector_pg_wal_archive_status{value="ready"} 0\ncnpg_pg_stat_archiver_archived_count 8\n',
    );
  const result = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    partial,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(result?.state, "provisioning");
  assert.equal(result?.archive.continuous, false);
  const duplicate: typeof fetch = async () =>
    new Response(
      'cnpg_collector_pg_wal_archive_status{value="ready"} 0\ncnpg_pg_stat_archiver_archived_count 8\ncnpg_pg_stat_archiver_archived_count 8\ncnpg_pg_stat_archiver_last_archived_time 1\n',
    );
  const ambiguous = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    duplicate,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(ambiguous?.state, "provisioning");
  assert.equal(ambiguous?.archive.continuous, false);
});

test("future metrics and regressing archive evidence never clear a persisted pending timer", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-04T04:36:00Z");
  await new Reconciler(
    k8s,
    signal(),
    () => now,
    archiveSample(1, 8, now / 1000 - 1),
    authenticate,
  ).reconcile(db, ctx);
  const key = k8s.key("ConfigMap", "pgcf-system", `storage-${db.id}`);
  const before =
    k8s.resources.get(key)!.metadata.annotations?.[
      ARCHIVE_OBSERVATION_ANNOTATION
    ];
  const future = await new Reconciler(
    k8s,
    signal(),
    () => now + 600_001,
    archiveSample(1, 9, now / 1000 + 600.002),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(future?.state, "provisioning");
  assert.equal(future?.archive.continuous, false);
  assert.equal(
    k8s.resources.get(key)!.metadata.annotations?.[
      ARCHIVE_OBSERVATION_ANNOTATION
    ],
    before,
  );
  const regression = await new Reconciler(
    k8s,
    signal(),
    () => now + 600_001,
    archiveSample(1, 7, now / 1000 - 2),
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(regression?.state, "error");
  assert.equal(regression?.archive.continuous, false);
  const reset = JSON.parse(
    k8s.resources.get(key)!.metadata.annotations![
      ARCHIVE_OBSERVATION_ANNOTATION
    ]!,
  );
  assert.equal(reset.pendingSince, JSON.parse(before!).pendingSince);
  assert.equal(reset.archivedCount, 7);
  assert.equal(reset.lastArchivedTime, now / 1000 - 2);
});

test("malformed or future durable observations and invalid clocks fail closed", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-04T04:36:00Z");
  const sample = archiveSample(1, 8, now / 1000 - 1);
  await new Reconciler(
    k8s,
    signal(),
    () => now,
    sample,
    authenticate,
  ).reconcile(db, ctx);
  const fence = k8s.resources.get(
    k8s.key("ConfigMap", "pgcf-system", `storage-${db.id}`),
  )!;
  fence.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION] = "broken";
  await assert.rejects(
    new Reconciler(k8s, signal(), () => now, sample, authenticate).reconcile(
      db,
      ctx,
    ),
    /archive_observation_invalid/,
  );
  fence.metadata.annotations![ARCHIVE_OBSERVATION_ANNOTATION] = JSON.stringify({
    pendingSince: now + 1,
    archivedCount: 8,
    lastArchivedTime: now / 1000 - 1,
  });
  await assert.rejects(
    new Reconciler(k8s, signal(), () => now, sample, authenticate).reconcile(
      db,
      ctx,
    ),
    /archive_observation_invalid/,
  );
  await assert.rejects(
    new Reconciler(k8s, signal(), () => NaN, sample, authenticate).reconcile(
      db,
      ctx,
    ),
    /archive_clock_invalid/,
  );
});

test("durable archive updates reject a foreign fence and concurrent fence resource version", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const now = Date.parse("2026-10-04T04:36:00Z");
  await new Reconciler(
    k8s,
    signal(),
    () => now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const fence = k8s.resources.get(
    k8s.key("ConfigMap", "pgcf-system", `storage-${db.id}`),
  )!;
  const originalLabel = fence.metadata.labels!["pgcf.io/database-id"]!;
  fence.metadata.labels!["pgcf.io/database-id"] = fixture().db.id;
  await assert.rejects(
    new Reconciler(
      k8s,
      signal(),
      () => now,
      archiveSample(1, 8, now / 1000 - 1),
      authenticate,
    ).reconcile(db, ctx),
    /ownership_conflict/,
  );
  fence.metadata.labels!["pgcf.io/database-id"] = originalLabel;
  const patch = k8s.patch.bind(k8s);
  let raced = false;
  k8s.patch = async (kind, namespace, name, operations) => {
    if (
      kind === "ConfigMap" &&
      name === fence.metadata.name &&
      operations.some(
        (op) =>
          record(record(op).value)[ARCHIVE_OBSERVATION_ANNOTATION] !==
          undefined,
      )
    ) {
      raced = true;
      fence.metadata.resourceVersion = String(++k8s.revision);
      assert.ok(
        operations.some(
          (op) =>
            record(op).path === "/metadata/uid" && record(op).op === "test",
        ),
      );
      assert.ok(
        operations.some(
          (op) =>
            record(op).path === "/metadata/resourceVersion" &&
            record(op).op === "test",
        ),
      );
    }
    await patch(kind, namespace, name, operations);
  };
  await assert.rejects(
    new Reconciler(
      k8s,
      signal(),
      () => now,
      archiveSample(1, 8, now / 1000 - 1),
      authenticate,
    ).reconcile(db, ctx),
  );
  assert.equal(raced, true);
  assert.equal(
    fence.metadata.annotations?.[ARCHIVE_OBSERVATION_ANNOTATION],
    undefined,
  );
});

test("initial pending CREATE initializes once and its bound identity survives restart", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const reconcile = () =>
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      db,
      ctx,
    );
  assert.equal((await reconcile())?.state, "ready");
  const namespace = await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`);
  const cluster = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  assert.ok(fence);
  const bound = record(JSON.parse(String(record(fence.data).state)));
  assert.equal(bound.namespaceUid, namespace?.metadata.uid);
  assert.equal(bound.clusterUid, cluster?.metadata.uid);
  assert.equal(bound.node, db.node);
  assert.equal(bound.archivePath, db.archive.destination_path);
  assert.equal(fence.metadata.annotations?.[GENERATION_ANNOTATION], "1");
  const before = k8s.actions.length;
  assert.equal((await reconcile())?.state, "ready");
  assert.equal(k8s.actions.length, before);
  assert.equal(
    k8s.actions.filter(
      (action) => action === `create:Namespace:pgcf-db-${db.id}`,
    ).length,
    1,
  );
  assert.equal(
    k8s.actions.filter((action) => action === "create:Cluster:database").length,
    1,
  );
});

test("Cloudflare ready history refuses initialization even if all regional history is absent", async () => {
  const { db, ctx } = fixture();
  db.creation = { ...db.creation!, status: "succeeded", ever_ready: true };
  const k8s = new MemoryKubernetes();
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(k8s.actions.length, 0);
});

test("missing creation authority fails closed before any namespace or storage mutation", async () => {
  const { db, ctx } = fixture();
  delete db.creation;
  const k8s = new MemoryKubernetes();
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(k8s.actions.length, 0);
});

test("a failed CREATE cannot initialize missing storage", async () => {
  const { db, ctx } = fixture();
  db.creation = { ...db.creation!, status: "failed" };
  const k8s = new MemoryKubernetes();
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
    "error",
  );
  assert.equal(k8s.actions.length, 0);
});

test("a later configuration revision cannot authorize first namespace creation", async () => {
  const { db, ctx } = fixture();
  db.generation = 2;
  db.roles[0]!.revision = 2;
  const k8s = new MemoryKubernetes();
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
    "error",
  );
  assert.equal(k8s.actions.length, 0);
});

test("a missing namespace after ready requires recovery instead of recreating empty storage", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
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
  k8s.addStorage(db);
  const volumes = await k8s.list("PersistentVolume");
  const namespace = await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`);
  assert.ok(namespace?.metadata.uid);
  await k8s.delete(
    "Namespace",
    undefined,
    namespace.metadata.name,
    namespace.metadata.uid,
  );
  const before = k8s.actions.length;
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`),
    null,
  );
  assert.equal(await k8s.read("Cluster", `pgcf-db-${db.id}`, "database"), null);
  assert.equal(k8s.actions.length, before);
  assert.deepEqual(await k8s.list("PersistentVolume"), volumes);
});

test("namespace loss retains the durable accepted revision against stale snapshots after restart", async () => {
  const { db, ctx } = fixture();
  const newest = { ...db, generation: 3 };
  const k8s = new MemoryKubernetes();
  const reconciler = new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  );
  await reconciler.reconcile(db, ctx);
  await reconciler.reconcile(newest, ctx);
  const namespace = await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`);
  assert.ok(namespace?.metadata.uid);
  await k8s.delete(
    "Namespace",
    undefined,
    namespace.metadata.name,
    namespace.metadata.uid,
  );
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
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(newest, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(k8s.actions.length, before);
});

test("role changes cannot recreate a bound namespace and fence stale revisions on another restart", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const fenceBefore = await k8s.read(
    "ConfigMap",
    "pgcf-system",
    `storage-${db.id}`,
  );
  const namespace = await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`);
  assert.ok(namespace?.metadata.uid);
  await k8s.delete(
    "Namespace",
    undefined,
    namespace.metadata.name,
    namespace.metadata.uid,
  );
  const updated = {
    ...db,
    generation: 2,
    roles: [
      {
        ...db.roles[0]!,
        revision: 2,
        password: fixture().db.roles[0]!.password,
      },
    ],
  };
  const before = k8s.actions.length;
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(updated, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`),
    null,
  );
  assert.equal(await k8s.read("Cluster", `pgcf-db-${db.id}`, "database"), null);
  assert.deepEqual(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.data,
    fenceBefore?.data,
  );
  assert.ok(
    k8s.actions
      .slice(before)
      .every((action) => action.startsWith("patch:ConfigMap:storage-")),
  );
  const after = k8s.actions.length;
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
  assert.equal(k8s.actions.length, after);
});

test("a namespace UID race during a configuration update cannot create a replacement", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, namespace, name, operations) => {
    if (kind === "Namespace") {
      const current = await k8s.read(kind, namespace, name);
      assert.ok(current?.metadata.uid);
      await k8s.delete(kind, namespace, name, current.metadata.uid);
    }
    await patch(kind, namespace, name, operations);
  };
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      { ...db, generation: 2 },
      ctx,
    ),
  );
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`),
    null,
  );
  assert.equal(await k8s.read("Cluster", `pgcf-db-${db.id}`, "database"), null);
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile({ ...db, generation: 2 }, ctx)
    )?.state,
    "error",
  );
});

test("storage identity rejects placement changes and a replacement namespace before deletion", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const before = k8s.actions.length;
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(
        { ...db, generation: 2, node: `node-${randomUUID().slice(0, 8)}` },
        ctx,
      )
    )?.state,
    "error",
  );
  assert.equal(k8s.actions.length, before);
  k8s.ownedNamespace(db);
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile({
      ...db,
      generation: 2,
      desired_state: "deleted",
      roles: [],
    }),
    /namespace_identity_changed/,
  );
  assert.equal(k8s.actions.length, before);
});

test("a missing Cluster after ready cannot be initialized by a later role revision", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  k8s.resources.delete(k8s.key("Cluster", `pgcf-db-${db.id}`, "database"));
  const before = k8s.actions.length;
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile({ ...db, generation: 2 }, ctx);
  assert.equal(observation?.state, "error");
  assert.match(observation?.message ?? "", /recovery required/);
  assert.equal(await k8s.read("Cluster", `pgcf-db-${db.id}`, "database"), null);
  assert.ok(
    k8s.actions
      .slice(before)
      .every((action) => action.startsWith("patch:ConfigMap:storage-")),
  );
});

test("a fence revision race cannot overwrite a newer durable generation", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, namespace, name, operations) => {
    if (kind === "ConfigMap" && name === `storage-${db.id}`) {
      const current = k8s.resources.get(k8s.key(kind, namespace, name))!;
      current.metadata.annotations![GENERATION_ANNOTATION] = "3";
      current.metadata.resourceVersion = String(++k8s.revision);
    }
    await patch(kind, namespace, name, operations);
  };
  const before = k8s.actions.length;
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      { ...db, generation: 2 },
      ctx,
    ),
  );
  assert.equal(k8s.actions.length, before);
  assert.equal(
    (await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`))?.metadata
      .annotations?.[GENERATION_ANNOTATION],
    "3",
  );
  assert.equal(
    (await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`))?.metadata
      .annotations?.[GENERATION_ANNOTATION],
    "1",
  );
  assert.equal(
    await new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
    ).reconcile({ ...db, generation: 2 }, ctx),
    null,
  );
});

test("a same-UID Cluster version race cannot overwrite a concurrently changed spec", async () => {
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
  db.generation++;
  db.size.memory_mib = 768;
  const newer = {
    ...db,
    generation: 3,
    size: { ...db.size, memory_mib: 1024 },
  };
  const patch = k8s.patch.bind(k8s);
  let changed = false;
  k8s.patch = async (kind, namespace, name, operations) => {
    if (kind === "Cluster" && !changed) {
      changed = true;
      const concurrent = await new Reconciler(
        k8s,
        new AbortController().signal,
        Date.now,
        metrics,
        authenticate,
      ).reconcile(newer, ctx);
      assert.equal(concurrent?.state, "ready");
    }
    await patch(kind, namespace, name, operations);
  };
  await reconcile().catch(() => null);
  assert.equal(changed, true);
  const cluster = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  const restarted = await new Reconciler(
    k8s,
    new AbortController().signal,
    Date.now,
    metrics,
    authenticate,
  ).reconcile(newer, ctx);
  assert.deepEqual(
    {
      memory: record(record(record(cluster?.spec).resources).requests).memory,
      state: restarted?.state,
    },
    { memory: "1024Mi", state: "ready" },
  );
});

test("an older role Secret write cannot replace credentials from a ready newer revision", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const older = {
    ...db,
    generation: 2,
    roles: [
      {
        ...db.roles[0]!,
        revision: 2,
        password: fixture().db.roles[0]!.password,
      },
    ],
  };
  const newer = {
    ...db,
    generation: 3,
    roles: [
      {
        ...db.roles[0]!,
        revision: 3,
        password: fixture().db.roles[0]!.password,
      },
    ],
  };
  const apply = k8s.apply.bind(k8s);
  const patch = k8s.patch.bind(k8s);
  let advanced = false;
  const advance = async (kind: string, name: string) => {
    if (kind === "Secret" && name === roleSecretName("app") && !advanced) {
      advanced = true;
      assert.equal(
        (
          await new Reconciler(
            k8s,
            signal(),
            Date.now,
            metrics,
            authenticate,
          ).reconcile(newer, ctx)
        )?.state,
        "ready",
      );
    }
  };
  k8s.apply = async (resource) => {
    await advance(resource.kind, resource.metadata.name);
    await apply(resource);
  };
  k8s.patch = async (kind, namespace, name, operations) => {
    await advance(kind, name);
    await patch(kind, namespace, name, operations);
  };
  await new Reconciler(k8s, signal(), Date.now, metrics, authenticate)
    .reconcile(older, ctx)
    .catch(() => null);
  assert.equal(advanced, true);
  const secret = await k8s.read(
    "Secret",
    `pgcf-db-${db.id}`,
    roleSecretName("app"),
  );
  assert.equal(
    record(secret?.data).password,
    Buffer.from(newer.roles[0]!.password).toString("base64"),
  );
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(newer, ctx)
    )?.state,
    "ready",
  );
});

test("a running CREATE resumes after the first namespace mutation without initializing twice", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  const create = k8s.create.bind(k8s);
  k8s.create = async (resource) => {
    await create(resource);
    if (resource.kind === "Namespace")
      throw new Error("crash_after_namespace_creation");
  };
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      db,
      ctx,
    ),
  );
  k8s.create = create;
  db.creation = { ...db.creation!, status: "running" };
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
  assert.equal(
    k8s.actions.filter(
      (action) => action === `create:Namespace:pgcf-db-${db.id}`,
    ).length,
    1,
  );
  assert.equal(
    k8s.actions.filter((action) => action === "create:Cluster:database").length,
    1,
  );
});

test("a partial newer revision survives restart and rejects an intermediate stale snapshot", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const intermediate = {
    ...db,
    generation: 2,
    roles: [
      {
        ...db.roles[0]!,
        password: fixture().db.roles[0]!.password,
        revision: 2,
      },
    ],
  };
  const newest = {
    ...db,
    generation: 3,
    roles: [
      {
        ...db.roles[0]!,
        password: fixture().db.roles[0]!.password,
        revision: 3,
      },
    ],
  };
  const patch = k8s.patch.bind(k8s);
  let crash = true;
  k8s.patch = async (kind, namespace, name, operations) => {
    await patch(kind, namespace, name, operations);
    if (crash && kind === "Secret" && name === roleSecretName("app"))
      throw new Error("crash_after_newest_password_write");
  };
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      newest,
      ctx,
    ),
  );
  crash = false;
  const before = k8s.actions.length;
  const stale = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(intermediate, ctx);
  assert.equal(stale, null);
  assert.equal(k8s.actions.length, before);
  assert.equal(
    record(
      (await k8s.read("Secret", `pgcf-db-${db.id}`, roleSecretName("app")))
        ?.data,
    ).password,
    Buffer.from(newest.roles[0]!.password).toString("base64"),
  );
  assert.equal(
    (
      await new Reconciler(
        k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
      ).reconcile(newest, ctx)
    )?.state,
    "ready",
  );
});

test("a PV UID race cannot reclaim a replacement volume or delete its namespace", async () => {
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
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, namespace, name, operations) => {
    if (kind === "PersistentVolume")
      k8s.resources.get(k8s.key(kind, namespace, name))!.metadata.uid =
        randomUUID();
    await patch(kind, namespace, name, operations);
  };
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile({
      ...db,
      generation: 2,
      desired_state: "deleted",
      roles: [],
    }),
  );
  assert.equal(
    record((await k8s.list("PersistentVolume"))[0]?.spec)
      .persistentVolumeReclaimPolicy,
    "Retain",
  );
  assert.ok(await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`));
});

test("a claim UID race cannot reclaim a volume rebound to another claim", async () => {
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
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, namespace, name, operations) => {
    if (kind === "PersistentVolume")
      record(
        record(k8s.resources.get(k8s.key(kind, namespace, name))!.spec)
          .claimRef,
      ).uid = randomUUID();
    await patch(kind, namespace, name, operations);
  };
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile({
      ...db,
      generation: 2,
      desired_state: "deleted",
      roles: [],
    }),
  );
  assert.equal(
    record((await k8s.list("PersistentVolume"))[0]?.spec)
      .persistentVolumeReclaimPolicy,
    "Retain",
  );
  assert.ok(await k8s.read("Namespace", undefined, `pgcf-db-${db.id}`));
});

test("canonical Cluster quantities satisfy readiness before role authentication", async () => {
  const { db, ctx } = fixture();
  db.size.memory_mib = 1024;
  const k8s = new MemoryKubernetes();
  let authenticated = 0;
  const probe = async () => {
    authenticated++;
    return true;
  };
  const reconcile = () =>
    new Reconciler(k8s, signal(), Date.now, metrics, probe).reconcile(db, ctx);
  assert.equal((await reconcile())?.state, "ready");
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  const resources = record(record(cluster.spec).resources);
  record(resources.requests).memory = "1Gi";
  record(resources.limits).memory = "1Gi";
  record(resources.requests).cpu = "0.5";
  record(resources.limits).cpu = "0.5";
  record(record(cluster.spec).storage).size = "10240Mi";
  const pod = k8s.resources.get(
    k8s.key("Pod", `pgcf-db-${db.id}`, "database-1"),
  )!;
  const podResources = record(
    record((record(pod.spec).containers as unknown[])[0]).resources,
  );
  record(podResources.requests).memory = "1Gi";
  record(podResources.limits).memory = "1Gi";
  record(podResources.requests).cpu = "0.5";
  record(podResources.limits).cpu = "0.5";
  authenticated = 0;
  const before = k8s.actions.length;
  assert.equal((await reconcile())?.state, "ready");
  assert.equal(authenticated, 1);
  assert.equal(k8s.actions.length, before);
});

test("different Cluster quantities and numeric PostgreSQL strings keep readiness fenced", async () => {
  const { db, ctx } = fixture();
  const k8s = new MemoryKubernetes();
  let authenticated = 0;
  const probe = async () => {
    authenticated++;
    return true;
  };
  const reconcile = () =>
    new Reconciler(k8s, signal(), Date.now, metrics, probe).reconcile(db, ctx);
  assert.equal((await reconcile())?.state, "ready");
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  const resources = record(record(cluster.spec).resources);
  authenticated = 0;
  record(resources.requests).cpu = "0.75";
  assert.equal((await reconcile())?.state, "provisioning");
  record(resources.requests).cpu = "0.5";
  record(resources.limits).memory = "1Gi";
  assert.equal((await reconcile())?.state, "provisioning");
  record(resources.limits).memory = "512Mi";
  record(record(cluster.spec).storage).size = "11Gi";
  assert.equal((await reconcile())?.state, "provisioning");
  record(record(cluster.spec).storage).size = "10Gi";
  record(record(record(cluster.spec).postgresql).parameters).max_connections =
    "1e2";
  assert.equal((await reconcile())?.state, "provisioning");
  assert.equal(authenticated, 0);
  record(record(record(cluster.spec).postgresql).parameters).max_connections =
    "100";
  assert.equal((await reconcile())?.state, "ready");
  assert.equal(authenticated, 1);
});

test("stale primary resources and unacknowledged managed-role passwords keep a revision provisioning", async () => {
  const { db, ctx } = fixture();
  db.roles.push({
    name: "reader",
    owner: false,
    password: fixture().db.roles[0]!.password,
    revision: 1,
  });
  const k8s = new MemoryKubernetes();
  const reconcile = () =>
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      db,
      ctx,
    );
  assert.equal((await reconcile())?.state, "ready");
  const pod = k8s.resources.get(
    k8s.key("Pod", `pgcf-db-${db.id}`, "database-1"),
  )!;
  const container = record((record(pod.spec).containers as unknown[])[0]);
  const requests = record(record(container.resources).requests);
  requests.memory = "256Mi";
  assert.equal((await reconcile())?.state, "provisioning");
  requests.memory = "512Mi";
  const cluster = k8s.resources.get(
    k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
  )!;
  const passwordStatus = record(
    record(record(cluster.status).managedRolesStatus).passwordStatus,
  );
  const acknowledged = record(passwordStatus.reader).resourceVersion;
  record(passwordStatus.reader).resourceVersion = "older-secret";
  assert.equal((await reconcile())?.state, "provisioning");
  record(passwordStatus.reader).resourceVersion = acknowledged;
  assert.equal((await reconcile())?.state, "ready");
});

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

test("wake phase timings whitelist fields and preserve ready output and resource metadata", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes(),
    at = Date.now();
  const baseline = await new Reconciler(
    k8s,
    signal(),
    () => at,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const before = structuredClone(k8s.resources);
  const canary = randomUUID();
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const power = {
    prepareRunning: async () => undefined,
    finishRunning: async (_db: unknown, value: unknown) => value,
  } as unknown as PowerCoordinator;
  const logs: {
    event: string;
    fields: Record<string, string | number | boolean>;
  }[] = [];
  const log: Log = (event, fields = {}) => logs.push({ event, fields });
  let ticks = 0;
  const measured = await new Reconciler(
    k8s,
    signal(),
    () => at,
    metrics,
    async (...args) => {
      assert.ok(args[0].roles.length);
      assert.ok(canary);
      return authenticate();
    },
    power,
    log,
    () => ticks++,
  ).reconcile(db, ctx);
  assert.deepEqual(measured, baseline);
  assert.deepEqual(k8s.resources, before);
  const phases = logs.filter((entry) => entry.event === "wake_phase");
  assert.deepEqual(
    phases.map((entry) => entry.fields.phase),
    [
      "wake_prepare",
      "desired_apply",
      "archive_metrics",
      "ca_publication",
      "desired_applied",
      "role_runtime_auth",
      "volume_identity",
      "runtime_unchanged",
      "fence_release",
    ],
  );
  for (const entry of phases) {
    assert.equal(entry.event, "wake_phase");
    assert.deepEqual(Object.keys(entry.fields).sort(), [
      "database_id",
      "elapsedMs",
      "outcome",
      "phase",
    ]);
    assert.equal(entry.fields.database_id, db.id);
    assert.equal(entry.fields.elapsedMs, 1);
    assert.equal(entry.fields.outcome, "completed");
  }
  assert.deepEqual(
    logs.filter((entry) => entry.event === "wake_archive_transport"),
    [
      {
        event: "wake_archive_transport",
        fields: {
          database_id: db.id,
          transport: "exporter",
          reason: "legacy_or_missing_maintenance",
        },
      },
    ],
  );
  assert.equal(JSON.stringify(logs).includes(canary), false);
  for (const role of db.roles)
    assert.equal(JSON.stringify(logs).includes(role.password), false);
  assert.equal(
    JSON.stringify(logs).includes(ctx.backup.credentials.secretAccessKey),
    false,
  );
});

test("desired-apply failure reports only a fixed stage/category and a recognized API status", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  const canary = randomUUID(),
    failure = new ApiException(
      422,
      canary,
      { payload: canary },
      { Authorization: canary },
    );
  const create = k8s.create.bind(k8s);
  k8s.create = async (resource) => {
    if (resource.kind === "Namespace") throw failure;
    return create(resource);
  };
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const power = {
    prepareRunning: async () => undefined,
  } as unknown as PowerCoordinator;
  const logs: {
    event: string;
    fields: Record<string, string | number | boolean>;
  }[] = [];
  const reconciler = new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
    power,
    (event, fields = {}) => logs.push({ event, fields }),
  );
  await assert.rejects(
    reconciler.reconcile(db, ctx),
    (error) => error === failure,
  );
  assert.deepEqual(
    logs.find((entry) => entry.event === "wake_apply_failed"),
    {
      event: "wake_apply_failed",
      fields: {
        phase: "desired_apply",
        stage: "namespace_create",
        category: "api_precondition",
        status: 422,
        database_id: db.id,
      },
    },
  );
  assert.equal(JSON.stringify(logs).includes(canary), false);
});

test("configuration generation advance preserves the exact collector checkpoint and unrelated storage data", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  const reconciler = new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  );
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  const fence = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  const checkpoint = JSON.stringify({
    baseline: randomUUID(),
    gapSince: Date.now(),
    outbox: [{ immutable: randomUUID() }],
  });
  record(fence!.data)["measurements.json"] = checkpoint;
  record(fence!.data).independent = randomUUID();
  k8s.put(fence!);
  const before = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  db.generation++;
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  const after = await k8s.read("ConfigMap", "pgcf-system", `storage-${db.id}`);
  assert.equal(record(after!.data)["measurements.json"], checkpoint);
  assert.equal(
    record(after!.data).independent,
    record(before!.data).independent,
  );
  assert.equal(record(after!.data).state, record(before!.data).state);
  assert.equal(after!.metadata.uid, before!.metadata.uid);
});

test("unknown credential-shaped failures remain bounded and logger errors cannot change the original exception", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes(),
    canary = randomUUID() + db.roles[0]!.password;
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const failure = Object.assign(new Error(canary.repeat(100)), {
    code: 409,
    headers: { Authorization: canary },
  });
  const create = k8s.create.bind(k8s);
  k8s.create = async (resource) => {
    if (resource.kind === "Namespace") throw failure;
    return create(resource);
  };
  const power = {
    prepareRunning: async () => undefined,
  } as unknown as PowerCoordinator;
  const logs: {
    event: string;
    fields: Record<string, string | number | boolean>;
  }[] = [];
  const log: Log = (event, fields = {}) => {
    logs.push({ event, fields });
    if (event === "wake_apply_failed") throw new Error(canary);
  };
  await assert.rejects(
    new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      power,
      log,
    ).reconcile(db, ctx),
    (error) => error === failure,
  );
  assert.deepEqual(
    logs.find((entry) => entry.event === "wake_apply_failed"),
    {
      event: "wake_apply_failed",
      fields: {
        phase: "desired_apply",
        stage: "namespace_create",
        category: "unknown",
        database_id: db.id,
      },
    },
  );
  assert.equal(JSON.stringify(logs).includes(canary), false);
});

test("an unrecognized API status is omitted rather than treated as trusted diagnostic data", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes(),
    failure = new ApiException(450, randomUUID(), {}, {});
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const create = k8s.create.bind(k8s);
  k8s.create = async (resource) => {
    if (resource.kind === "Namespace") throw failure;
    return create(resource);
  };
  const power = {
      prepareRunning: async () => undefined,
    } as unknown as PowerCoordinator,
    logs: {
      event: string;
      fields: Record<string, string | number | boolean>;
    }[] = [];
  await assert.rejects(
    new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      power,
      (event, fields = {}) => logs.push({ event, fields }),
    ).reconcile(db, ctx),
    (error) => error === failure,
  );
  assert.equal(
    logs.find((entry) => entry.event === "wake_apply_failed")!.fields.status,
    undefined,
  );
  assert.equal(
    logs.find((entry) => entry.event === "wake_apply_failed")!.fields.category,
    "unknown",
  );
});

test("a concurrent newer collector checkpoint is never replaced by a stale storage snapshot", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  const name = `storage-${db.id}`,
    old = JSON.stringify({ outbox: [randomUUID()] }),
    newer = JSON.stringify({ outbox: [randomUUID()], gapSince: Date.now() });
  const fence = await k8s.read("ConfigMap", "pgcf-system", name);
  await k8s.patch("ConfigMap", "pgcf-system", name, [
    { op: "add", path: "/data/measurements.json", value: old },
  ]);
  const identity = record(fence!.data).state;
  const patch = k8s.patch.bind(k8s);
  let raced = false;
  k8s.patch = async (kind, namespace, resource, operations) => {
    if (
      !raced &&
      kind === "ConfigMap" &&
      resource === name &&
      operations.some((value) => record(value).path === "/data")
    ) {
      raced = true;
      const latest = await k8s.read(kind, namespace, resource);
      await patch(kind, namespace, resource, [
        { op: "test", path: "/metadata/uid", value: latest!.metadata.uid },
        {
          op: "test",
          path: "/metadata/resourceVersion",
          value: latest!.metadata.resourceVersion,
        },
        { op: "add", path: "/data/measurements.json", value: newer },
      ]);
    }
    return patch(kind, namespace, resource, operations);
  };
  db.generation++;
  await assert.rejects(
    new Reconciler(k8s, signal(), Date.now, metrics, authenticate).reconcile(
      db,
      ctx,
    ),
  );
  const current = await k8s.read("ConfigMap", "pgcf-system", name);
  assert.equal(raced, true);
  assert.equal(record(current!.data)["measurements.json"], newer);
  assert.equal(record(current!.data).state, identity);
  assert.equal(current!.metadata.uid, fence!.metadata.uid);
});

test("a real Ready transition during archive collection is verified in the same reconciliation", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  k8s.ready = false;
  let authentications = 0,
    scrapes = 0;
  const sample: typeof fetch = async (...args) => {
    scrapes++;
    const cluster = k8s.resources.get(
      k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
    )!;
    record(cluster.status).conditions = [
      { type: "Ready", status: "True" },
      { type: "ContinuousArchiving", status: "True" },
    ];
    cluster.metadata.resourceVersion = String(
      Number(cluster.metadata.resourceVersion) + 1,
    );
    const primary = String(record(cluster.status).currentPrimary),
      pod = k8s.resources.get(k8s.key("Pod", `pgcf-db-${db.id}`, primary))!;
    record(pod.status).conditions = [{ type: "Ready", status: "True" }];
    pod.metadata.resourceVersion = String(
      Number(pod.metadata.resourceVersion) + 1,
    );
    return metrics(...args);
  };
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    sample,
    async () => {
      authentications++;
      return true;
    },
  ).reconcile(db, ctx);
  assert.equal(scrapes, 1);
  assert.equal(observation?.state, "ready");
  assert.equal(authentications, 1);
  assert.equal(observation?.archive.continuous, true);
});

test("a replacement Cluster during metrics never authenticates or reports Ready", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  let authentications = 0;
  const sample: typeof fetch = async (...args) => {
    const cluster = k8s.resources.get(
      k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
    )!;
    cluster.metadata.uid = randomUUID();
    return metrics(...args);
  };
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    sample,
    async () => {
      authentications++;
      return true;
    },
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "error");
  assert.match(
    observation?.message ?? "",
    /identity changed; recovery required/,
  );
  assert.equal(authentications, 0);
  assert.equal(
    k8s.actions.filter((action) => action === "create:Cluster:database").length,
    1,
  );
});

test("a future Cluster revision after metrics stays pending instead of using the old archive sample", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  let authentications = 0;
  const sample: typeof fetch = async (...args) => {
    const cluster = k8s.resources.get(
      k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
    )!;
    cluster.metadata.annotations![GENERATION_ANNOTATION] = String(
      db.generation + 1,
    );
    return metrics(...args);
  };
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    sample,
    async () => {
      authentications++;
      return true;
    },
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "provisioning");
  assert.deepEqual(observation?.archive, {
    continuous: false,
    ready_wal_files: null,
  });
  assert.equal(authentications, 0);
});

test("a changed currentPrimary after metrics cannot reuse the previous primary archive proof", async () => {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  let authentications = 0;
  const sample: typeof fetch = async (...args) => {
    const cluster = k8s.resources.get(
      k8s.key("Cluster", `pgcf-db-${db.id}`, "database"),
    )!;
    record(cluster.status).currentPrimary = "database-later";
    return metrics(...args);
  };
  const observation = await new Reconciler(
    k8s,
    signal(),
    Date.now,
    sample,
    async () => {
      authentications++;
      return true;
    },
  ).reconcile(db, ctx);
  assert.equal(observation?.state, "provisioning");
  assert.deepEqual(observation?.archive, {
    continuous: false,
    ready_wal_files: null,
  });
  assert.equal(authentications, 0);
});

async function wakeConfigurationFixture() {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  await new Reconciler(
    k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  db.creation!.ever_ready = true;
  db.generation++;
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const power = {
    prepareRunning: async () => undefined,
    finishRunning: async (_db: unknown, value: unknown) => value,
  } as unknown as PowerCoordinator;
  return {
    db,
    ctx,
    k8s,
    reconciler: new Reconciler(
      k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      power,
    ),
  };
}
test("a wake manifest PATCH retries once after a same-UID metadata RV change without losing controller fields", async () => {
  const f = await wakeConfigurationFixture(),
    native = f.k8s.patch.bind(f.k8s),
    namespace = `pgcf-db-${f.db.id}`;
  let attempts = 0;
  f.k8s.patch = async (kind, ns, name, operations) => {
    if (kind === "ObjectStore" && name === "archive") {
      attempts++;
      if (attempts === 1) {
        await native(kind, ns, name, [
          {
            op: "add",
            path: "/metadata/annotations/controller",
            value: "preserved",
          },
          {
            op: "add",
            path: "/spec/controllerSetting",
            value: { enabled: true },
          },
        ]);
        throw new ApiException(
          422,
          "opaque",
          JSON.stringify({ reason: "Invalid" }),
          {},
        );
      }
    }
    return native(kind, ns, name, operations);
  };
  assert.equal((await f.reconciler.reconcile(f.db, f.ctx))?.state, "ready");
  assert.equal(attempts, 2);
  const stored = await f.k8s.read("ObjectStore", namespace, "archive");
  assert.equal(stored!.metadata.annotations!.controller, "preserved");
  assert.deepEqual(record(stored!.spec).controllerSetting, { enabled: true });
});
test("a wake Cluster PATCH retries once after a same-UID status RV change and rebuilds fresh merged spec", async () => {
  const f = await wakeConfigurationFixture(),
    native = f.k8s.patch.bind(f.k8s),
    namespace = `pgcf-db-${f.db.id}`;
  let attempts = 0;
  f.k8s.patch = async (kind, ns, name, operations) => {
    if (
      kind === "Cluster" &&
      operations.some((value) => record(value).path === "/spec")
    ) {
      attempts++;
      if (attempts === 1) {
        await native(kind, ns, name, [
          {
            op: "add",
            path: "/metadata/annotations/controller",
            value: "preserved",
          },
          {
            op: "add",
            path: "/spec/controllerSetting",
            value: { enabled: true },
          },
          { op: "add", path: "/status/controllerReady", value: true },
        ]);
        throw new ApiException(
          422,
          "opaque",
          JSON.stringify({ reason: "Invalid" }),
          {},
        );
      }
    }
    return native(kind, ns, name, operations);
  };
  assert.equal((await f.reconciler.reconcile(f.db, f.ctx))?.state, "ready");
  assert.equal(attempts, 2);
  const stored = await f.k8s.read("Cluster", namespace, "database");
  assert.equal(stored!.metadata.annotations!.controller, "preserved");
  assert.deepEqual(record(stored!.spec).controllerSetting, { enabled: true });
});

async function rejectedWakeRetry(
  change: (
    f: Awaited<ReturnType<typeof wakeConfigurationFixture>>,
    native: MemoryKubernetes["patch"],
    ns: string | undefined,
    name: string,
  ) => Promise<void>,
  failure: Error = new ApiException(
    422,
    "opaque",
    JSON.stringify({ reason: "Invalid" }),
    {},
  ),
  secondFailure = false,
  nonwake = false,
) {
  const f = await wakeConfigurationFixture(),
    native = f.k8s.patch.bind(f.k8s);
  if (nonwake) delete f.db.power;
  let attempts = 0;
  f.k8s.patch = async (kind, ns, name, operations) => {
    if (kind === "ObjectStore" && name === "archive") {
      attempts++;
      if (attempts === 1) {
        await change(f, native, ns, name);
        throw failure;
      }
      if (secondFailure) throw failure;
    }
    return native(kind, ns, name, operations);
  };
  await assert.rejects(
    f.reconciler.reconcile(f.db, f.ctx),
    (error) => error === failure,
  );
  return { f, attempts };
}
test("wake CAS retry rejects a replacement UID", async () => {
  const result = await rejectedWakeRetry(async (f, _native, ns, name) => {
    const current = (await f.k8s.read("ObjectStore", ns, name))!;
    f.k8s.put(current);
  });
  assert.equal(result.attempts, 1);
});
test("wake CAS retry rejects a deleting resource", async () => {
  const result = await rejectedWakeRetry(async (_f, native, ns, name) =>
    native("ObjectStore", ns, name, [
      {
        op: "add",
        path: "/metadata/deletionTimestamp",
        value: new Date().toISOString(),
      },
    ]),
  );
  assert.equal(result.attempts, 1);
});
test("wake CAS retry rejects a future resource revision", async () => {
  const result = await rejectedWakeRetry(async (f, native, ns, name) =>
    native("ObjectStore", ns, name, [
      {
        op: "add",
        path: "/metadata/annotations/pgcf.io~1accepted-generation",
        value: String(f.db.generation + 1),
      },
    ]),
  );
  assert.equal(result.attempts, 1);
});
test("wake CAS retry rejects a future namespace high-water mark", async () => {
  const result = await rejectedWakeRetry(async (f, native, ns, name) => {
    await native("ObjectStore", ns, name, [
      { op: "add", path: "/metadata/annotations/controller", value: "new" },
    ]);
    await native("Namespace", undefined, `pgcf-db-${f.db.id}`, [
      {
        op: "add",
        path: "/metadata/annotations/pgcf.io~1accepted-generation",
        value: String(f.db.generation + 1),
      },
    ]);
  });
  assert.equal(result.attempts, 1);
});
test("wake CAS retry rejects a regressed local high-water mark", async () => {
  const result = await rejectedWakeRetry(async (f, native, ns, name) => {
    await native("ObjectStore", ns, name, [
      { op: "add", path: "/metadata/annotations/controller", value: "new" },
    ]);
    (
      f.reconciler as unknown as { highWater: Map<string, number> }
    ).highWater.set(f.db.id, f.db.generation + 1);
  });
  assert.equal(result.attempts, 1);
});
test("wake CAS retry rejects unchanged resourceVersion and missing versions", async () => {
  const unchanged = await rejectedWakeRetry(async () => {});
  assert.equal(unchanged.attempts, 1);
  const missing = await rejectedWakeRetry(async (f, _native, ns, name) => {
    const current = f.k8s.resources.get(f.k8s.key("ObjectStore", ns, name))!;
    delete current.metadata.resourceVersion;
  });
  assert.equal(missing.attempts, 1);
});
test("wake CAS retry cannot replace concurrently changed managed data", async () => {
  const result = await rejectedWakeRetry(async (_f, native, ns, name) =>
    native("ObjectStore", ns, name, [
      { op: "add", path: "/spec/retentionPolicy", value: "different" },
    ]),
  );
  assert.equal(result.attempts, 1);
});
test("uncertain transport outcomes never trigger a wake PATCH retry", async () => {
  const result = await rejectedWakeRetry(
    async (_f, native, ns, name) =>
      native("ObjectStore", ns, name, [
        { op: "add", path: "/metadata/annotations/controller", value: "new" },
      ]),
    new Error(randomUUID()),
  );
  assert.equal(result.attempts, 1);
});
test("a second wake PATCH failure escapes without a third attempt", async () => {
  const result = await rejectedWakeRetry(
    async (_f, native, ns, name) =>
      native("ObjectStore", ns, name, [
        { op: "add", path: "/metadata/annotations/controller", value: "new" },
      ]),
    new ApiException(422, "opaque", JSON.stringify({ reason: "Invalid" }), {}),
    true,
  );
  assert.equal(result.attempts, 2);
});
test("ordinary non-wake configuration keeps its original single PATCH attempt", async () => {
  const result = await rejectedWakeRetry(
    async (_f, native, ns, name) =>
      native("ObjectStore", ns, name, [
        { op: "add", path: "/metadata/annotations/controller", value: "new" },
      ]),
    new ApiException(422, "opaque", JSON.stringify({ reason: "Invalid" }), {}),
    false,
    true,
  );
  assert.equal(result.attempts, 1);
});
test("aborted wake reconciliation never retries the rejected PATCH or authentication", async () => {
  const f = await wakeConfigurationFixture(),
    controller = new AbortController(),
    native = f.k8s.patch.bind(f.k8s);
  let attempts = 0,
    auth = 0;
  const failure = new ApiException(
    422,
    "opaque",
    JSON.stringify({ reason: "Invalid" }),
    {},
  );
  f.k8s.patch = async (kind, ns, name, operations) => {
    if (kind === "ObjectStore" && name === "archive") {
      attempts++;
      await native(kind, ns, name, [
        { op: "add", path: "/metadata/annotations/controller", value: "new" },
      ]);
      controller.abort();
      throw failure;
    }
    return native(kind, ns, name, operations);
  };
  const power = {
    prepareRunning: async () => undefined,
  } as unknown as PowerCoordinator;
  await assert.rejects(
    new Reconciler(
      f.k8s,
      controller.signal,
      Date.now,
      metrics,
      async () => {
        auth++;
        return true;
      },
      power,
    ).reconcile(f.db, f.ctx),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
  assert.equal(auth, 0);
});

async function unchangedCredentialWakeFixture() {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes(),
    namespace = `pgcf-db-${db.id}`;
  db.roles.push({
    name: "reader",
    owner: false,
    revision: 1,
    password: fixture().db.roles[0]!.password,
  });
  db.maintenance = {
    role: MAINTENANCE_ROLE,
    revision: 1,
    password: fixture().db.roles[0]!.password,
  };
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
  const before = new Map(
    (await k8s.list("Secret", namespace))
      .filter((value) => value.type === "kubernetes.io/basic-auth")
      .map((value) => [value.metadata.name, value]),
  );
  const oldCluster = (await k8s.read("Cluster", namespace, "database"))!;
  const patch = k8s.patch.bind(k8s);
  k8s.patch = async (kind, ns, name, operations) => {
    await patch(kind, ns, name, operations);
    if (
      kind === "Cluster" &&
      operations.some((raw) => record(raw).path === "/spec")
    ) {
      const current = k8s.resources.get(k8s.key(kind, ns, name))!;
      record(current.status).secretsResourceVersion = structuredClone(
        record(oldCluster.status).secretsResourceVersion,
      );
      record(record(current.status).managedRolesStatus).passwordStatus =
        structuredClone(
          record(record(oldCluster.status).managedRolesStatus).passwordStatus,
        );
    }
  };
  db.creation!.ever_ready = true;
  db.generation = 2;
  db.power = {
    operation: db.creation!.operation_id,
    revision: 2,
    mode: "running",
    reason: null,
  };
  const power = {
    prepareRunning: async () => undefined,
    finishRunning: async (_db: unknown, observation: unknown) => observation,
  } as unknown as PowerCoordinator;
  const actionStart = k8s.actions.length;
  return { db, ctx, k8s, namespace, before, power, actionStart };
}

test("a power-only revision preserves exact application and maintenance Secret UID/RV without a credential PATCH", async () => {
  const f = await unchangedCredentialWakeFixture();
  await new Reconciler(
    f.k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
    f.power,
  ).reconcile(f.db, f.ctx);
  for (const [name, original] of f.before) {
    const actual = await f.k8s.read("Secret", f.namespace, name);
    assert.deepEqual(actual, original);
    assert.equal(
      f.k8s.actions.slice(f.actionStart).includes(`patch:Secret:${name}`),
      false,
    );
  }
});

test("an unchanged credential revision keeps exact CNPG acknowledgments and avoids an artificial controller wait", async () => {
  const f = await unchangedCredentialWakeFixture();
  let authentications = 0;
  const observation = await new Reconciler(
    f.k8s,
    signal(),
    Date.now,
    metrics,
    async (db) => {
      assert.deepEqual(db.roles, f.db.roles);
      authentications++;
      return true;
    },
    f.power,
  ).reconcile(f.db, f.ctx);
  assert.equal(observation?.state, "ready");
  assert.equal(authentications, 1);
});

test("a restarted agent preserves unchanged credential RVs while applying the current size", async () => {
  const f = await unchangedCredentialWakeFixture();
  f.db.size.memory_mib = 1024;
  f.db.size.cpu_millicores = 1000;
  f.db.size.max_connections = 200;
  const restarted = new Reconciler(
    f.k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
    f.power,
  );
  assert.equal((await restarted.reconcile(f.db, f.ctx))?.state, "ready");
  const cluster = (await f.k8s.read("Cluster", f.namespace, "database"))!;
  assert.deepEqual(record(record(cluster.spec).resources).requests, {
    cpu: "1000m",
    memory: "1024Mi",
  });
  assert.equal(
    record(record(cluster.spec).postgresql).parameters &&
      record(record(record(cluster.spec).postgresql).parameters)
        .max_connections,
    "200",
  );
  for (const [name, original] of f.before)
    assert.deepEqual(await f.k8s.read("Secret", f.namespace, name), original);
  const before = f.k8s.actions.length;
  assert.equal(
    (
      await new Reconciler(
        f.k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
        f.power,
      ).reconcile(f.db, f.ctx)
    )?.state,
    "ready",
  );
  assert.equal(f.k8s.actions.length, before);
});

test("actual application and maintenance password rotations still PATCH under CAS and await exact new acknowledgments", async () => {
  const f = await unchangedCredentialWakeFixture();
  f.db.roles[0]!.password = fixture().db.roles[0]!.password;
  f.db.roles[0]!.revision = 2;
  f.db.maintenance!.password = fixture().db.roles[0]!.password;
  f.db.maintenance!.revision = 2;
  let auth = 0;
  assert.equal(
    (
      await new Reconciler(
        f.k8s,
        signal(),
        Date.now,
        metrics,
        async () => {
          auth++;
          return true;
        },
        f.power,
      ).reconcile(f.db, f.ctx)
    )?.state,
    "provisioning",
  );
  assert.equal(auth, 0);
  for (const name of [roleSecretName("app"), "maintenance-credentials"]) {
    const actual = (await f.k8s.read("Secret", f.namespace, name))!;
    assert.equal(actual.metadata.uid, f.before.get(name)!.metadata.uid);
    assert.notEqual(
      actual.metadata.resourceVersion,
      f.before.get(name)!.metadata.resourceVersion,
    );
    assert.equal(actual.metadata.annotations![GENERATION_ANNOTATION], "2");
    const password =
      name === "maintenance-credentials"
        ? f.db.maintenance!.password
        : f.db.roles[0]!.password;
    assert.equal(
      record(actual.data).password,
      Buffer.from(password).toString("base64"),
    );
    assert.ok(
      f.k8s.actions.slice(f.actionStart).includes(`patch:Secret:${name}`),
    );
  }
  const cluster = f.k8s.resources.get(
    f.k8s.key("Cluster", f.namespace, "database"),
  )!;
  record(
    record(cluster.status).secretsResourceVersion,
  ).applicationSecretVersion = (await f.k8s.read(
    "Secret",
    f.namespace,
    roleSecretName("app"),
  ))!.metadata.resourceVersion;
  record(record(record(cluster.status).managedRolesStatus).passwordStatus)[
    MAINTENANCE_ROLE
  ] = {
    resourceVersion: (await f.k8s.read(
      "Secret",
      f.namespace,
      "maintenance-credentials",
    ))!.metadata.resourceVersion,
  };
  assert.equal(
    (
      await new Reconciler(
        f.k8s,
        signal(),
        Date.now,
        metrics,
        authenticate,
        f.power,
      ).reconcile(f.db, f.ctx)
    )?.state,
    "ready",
  );
});

test("required credential metadata is repaired rather than silently preserved", async () => {
  const f = await unchangedCredentialWakeFixture(),
    name = roleSecretName("reader");
  const secret = f.k8s.resources.get(f.k8s.key("Secret", f.namespace, name))!;
  secret.metadata.labels!["cnpg.io/reload"] = "false";
  await new Reconciler(
    f.k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
    f.power,
  ).reconcile(f.db, f.ctx);
  const actual = (await f.k8s.read("Secret", f.namespace, name))!;
  assert.equal(actual.metadata.labels!["cnpg.io/reload"], "true");
  assert.notEqual(
    actual.metadata.resourceVersion,
    f.before.get(name)!.metadata.resourceVersion,
  );
  assert.ok(
    f.k8s.actions.slice(f.actionStart).includes(`patch:Secret:${name}`),
  );
});

test("missing credential generation forces a guarded repair; explicit zero remains invalid", async () => {
  const f = await unchangedCredentialWakeFixture(),
    name = roleSecretName("app");
  const secret = f.k8s.resources.get(f.k8s.key("Secret", f.namespace, name))!;
  delete secret.metadata.annotations![GENERATION_ANNOTATION];
  await new Reconciler(
    f.k8s,
    signal(),
    Date.now,
    metrics,
    authenticate,
    f.power,
  ).reconcile(f.db, f.ctx);
  assert.ok(
    f.k8s.actions.slice(f.actionStart).includes(`patch:Secret:${name}`),
  );
  assert.equal(
    (await f.k8s.read("Secret", f.namespace, name))!.metadata.annotations![
      GENERATION_ANNOTATION
    ],
    "2",
  );
  const zero = await unchangedCredentialWakeFixture();
  zero.k8s.resources.get(
    zero.k8s.key("Secret", zero.namespace, name),
  )!.metadata.annotations![GENERATION_ANNOTATION] = "0";
  await assert.rejects(
    new Reconciler(
      zero.k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      zero.power,
    ).reconcile(zero.db, zero.ctx),
    { message: "applied_generation_invalid" },
  );
  assert.equal(
    zero.k8s.actions.slice(zero.actionStart).includes(`patch:Secret:${name}`),
    false,
  );
});

test("future credential revision and foreign ownership never use the unchanged Secret shortcut", async () => {
  const f = await unchangedCredentialWakeFixture(),
    name = roleSecretName("app");
  const secret = f.k8s.resources.get(f.k8s.key("Secret", f.namespace, name))!;
  secret.metadata.annotations![GENERATION_ANNOTATION] = "3";
  const before = structuredClone(secret);
  assert.equal(
    await new Reconciler(
      f.k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      f.power,
    ).reconcile(f.db, f.ctx),
    null,
  );
  assert.deepEqual(await f.k8s.read("Secret", f.namespace, name), before);
  const foreign = await unchangedCredentialWakeFixture();
  foreign.k8s.resources.get(
    foreign.k8s.key("Secret", foreign.namespace, name),
  )!.metadata.labels!["pgcf.io/database-id"] = fixture().db.id;
  await assert.rejects(
    new Reconciler(
      foreign.k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      foreign.power,
    ).reconcile(foreign.db, foreign.ctx),
    { message: "resource_ownership_conflict" },
  );
  assert.equal(
    foreign.k8s.actions
      .slice(foreign.actionStart)
      .includes(`patch:Secret:${name}`),
    false,
  );
});

test("deleting credentials remain pending and credential RV changes during authentication cannot report ready", async () => {
  const f = await unchangedCredentialWakeFixture(),
    name = roleSecretName("app");
  f.k8s.resources.get(
    f.k8s.key("Secret", f.namespace, name),
  )!.metadata.deletionTimestamp = new Date().toISOString();
  assert.equal(
    await new Reconciler(
      f.k8s,
      signal(),
      Date.now,
      metrics,
      authenticate,
      f.power,
    ).reconcile(f.db, f.ctx),
    null,
  );
  assert.equal(
    f.k8s.actions.slice(f.actionStart).includes(`patch:Secret:${name}`),
    false,
  );
  const raced = await unchangedCredentialWakeFixture();
  const observation = await new Reconciler(
    raced.k8s,
    signal(),
    Date.now,
    metrics,
    async () => {
      const secret = raced.k8s.resources.get(
        raced.k8s.key("Secret", raced.namespace, name),
      )!;
      secret.metadata.resourceVersion = String(++raced.k8s.revision);
      return true;
    },
    raced.power,
  ).reconcile(raced.db, raced.ctx);
  assert.notEqual(observation?.state, "ready");
});
