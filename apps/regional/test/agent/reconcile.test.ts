// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
