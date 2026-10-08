// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { SIDECAR, type RecoverySourceCredentialsMap } from "@pgcf/contracts";
import {
  recoveryFixture,
  crossRegionRecoveryFixture,
} from "./recovery-fixture.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { recoveryBuildContext } from "../../src/agent/recovery.ts";
import {
  buildDatabaseManifests,
  restoreAdministrationPassword,
} from "../../src/agent/builders/index.ts";
import { record } from "../../src/agent/types.ts";
import { MemoryKubernetes, metrics, authenticate } from "./fixtures.ts";

test("API source credentials build separate read and write Secrets without a regional source Secret", async (t) => {
  const { db, ctx, source } = crossRegionRecoveryFixture(),
    k8s = new MemoryKubernetes();
  t.mock.method(k8s, "read", async () => {
    throw new Error("source_credentials_must_come_from_api");
  });
  const context = await recoveryBuildContext(db, ctx, k8s, {
    [source.region_id]: {
      bucket: source.bucket,
      endpoint_url: source.endpoint_url,
      access_key_id: "api-source-read-key",
      secret_access_key: "api-source-read-secret",
    },
  });
  assert.deepEqual(context.recoverySource?.credentials, {
    accessKeyId: "api-source-read-key",
    secretAccessKey: "api-source-read-secret",
  });
  assert.deepEqual(context.backup.credentials, ctx.backup.credentials);
  const manifests = buildDatabaseManifests(db, context);
  const credentials = (name: string) =>
    record(
      manifests.find((o) => o.kind === "Secret" && o.metadata.name === name)
        ?.data,
    );
  assert.equal(
    Buffer.from(
      String(credentials("recovery-source-credentials").AWS_ACCESS_KEY_ID),
      "base64",
    ).toString(),
    "api-source-read-key",
  );
  assert.equal(
    Buffer.from(
      String(credentials("archive-credentials").AWS_ACCESS_KEY_ID),
      "base64",
    ).toString(),
    "target-write-key",
  );
});

test("missing or malformed explicit source maps never fall back to a regional Secret or target write keys", async (t) => {
  const { db, ctx, source } = crossRegionRecoveryFixture(),
    k8s = new MemoryKubernetes();
  const sources = {
    [source.region_id]: {
      bucket: source.bucket,
      endpoint_url: source.endpoint_url,
      access_key_id: "legacy-source-read-key",
      secret_access_key: "legacy-source-read-secret",
    },
  };
  k8s.put({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "pgcf-restore-source-s3", namespace: "pgcf-system" },
    data: {
      "sources.json": Buffer.from(JSON.stringify(sources)).toString("base64"),
    },
  });
  const read = t.mock.method(k8s, "read");
  for (const explicit of [
    {},
    { "other-region": sources[source.region_id] },
    {
      [source.region_id]: {
        ...sources[source.region_id],
        bucket: ctx.backup.bucket,
      },
    },
    {
      [source.region_id]: {
        ...sources[source.region_id],
        endpoint_url: ctx.backup.endpointUrl,
      },
    },
    {
      [source.region_id]: {
        ...sources[source.region_id],
        secret_access_key: "invalid\nsecret",
      },
    },
    null,
    [],
  ]) {
    await assert.rejects(
      recoveryBuildContext(
        db,
        ctx,
        k8s,
        explicit as unknown as RecoverySourceCredentialsMap,
      ),
      /^Error: recovery_source_credentials_unavailable$/,
    );
  }
  assert.equal(read.mock.callCount(), 0);
  const legacy = await recoveryBuildContext(db, ctx, k8s);
  assert.equal(read.mock.callCount(), 1);
  assert.deepEqual(legacy.recoverySource?.credentials, {
    accessKeyId: "legacy-source-read-key",
    secretAccessKey: "legacy-source-read-secret",
  });
  assert.equal(k8s.mutations, 0);
});

test("rotated API source credentials update the existing per-database Secret after generation advances", async () => {
  const { db, ctx, source } = crossRegionRecoveryFixture(),
    k8s = new MemoryKubernetes();
  const sources = {
    [source.region_id]: {
      bucket: source.bucket,
      endpoint_url: source.endpoint_url,
      access_key_id: "api-source-read-key",
      secret_access_key: "api-source-read-secret",
    },
  };
  const reconciler = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => false,
    );
  const firstContext = await recoveryBuildContext(db, ctx, k8s, sources);
  await reconciler().reconcile(db, firstContext);
  const namespace = `pgcf-db-${db.id}`;
  const original = await k8s.read(
      "Secret",
      namespace,
      "recovery-source-credentials",
    ),
    originalArchive = await k8s.read(
      "Secret",
      namespace,
      "archive-credentials",
    ),
    originalAdmin = await k8s.read("Secret", namespace, "restore-superuser");
  assert.ok(original);
  assert.ok(originalArchive);
  assert.ok(originalAdmin);
  sources[source.region_id]!.access_key_id = "rotated-api-source-read-key";
  sources[source.region_id]!.secret_access_key =
    "rotated-api-source-read-secret";
  db.generation++;
  const rotatedContext = await recoveryBuildContext(db, ctx, k8s, sources);
  assert.deepEqual(rotatedContext.recoverySource?.credentials, {
    accessKeyId: "rotated-api-source-read-key",
    secretAccessKey: "rotated-api-source-read-secret",
  });
  await reconciler().reconcile(db, rotatedContext);
  const rotated = await k8s.read(
    "Secret",
    namespace,
    "recovery-source-credentials",
  );
  assert.equal(rotated?.metadata.uid, original.metadata.uid);
  assert.notEqual(
    rotated?.metadata.resourceVersion,
    original.metadata.resourceVersion,
  );
  assert.equal(
    Buffer.from(
      String(record(rotated?.data).AWS_ACCESS_KEY_ID),
      "base64",
    ).toString(),
    "rotated-api-source-read-key",
  );
  assert.equal(
    Buffer.from(
      String(record(rotated?.data).AWS_SECRET_ACCESS_KEY),
      "base64",
    ).toString(),
    "rotated-api-source-read-secret",
  );
  assert.deepEqual(
    (await k8s.read("Secret", namespace, "archive-credentials"))?.data,
    originalArchive?.data,
  );
  assert.deepEqual(
    (await k8s.read("Secret", namespace, "restore-superuser"))?.data,
    originalAdmin?.data,
  );
  assert.equal(
    await k8s.read("Secret", "pgcf-system", "pgcf-restore-source-s3"),
    null,
  );
});

test("cross-region recovery uses separately bound source credentials and exact endpoint egress", () => {
  const { db, ctx, source } = crossRegionRecoveryFixture();
  const manifests = buildDatabaseManifests(db, ctx);
  const origin = manifests.find(
    (o) => o.kind === "ObjectStore" && o.metadata.name === "recovery-source",
  )!;
  const archive = manifests.find(
    (o) => o.kind === "ObjectStore" && o.metadata.name === "archive",
  )!;
  const config = record(record(origin.spec).configuration);
  assert.equal(config.endpointURL, source.endpoint_url);
  assert.equal(
    record(record(archive.spec).configuration).endpointURL,
    ctx.backup.endpointUrl,
  );
  assert.equal(
    record(record(config.s3Credentials).accessKeyId).name,
    "recovery-source-credentials",
  );
  const credentials = manifests.find(
    (o) =>
      o.kind === "Secret" && o.metadata.name === "recovery-source-credentials",
  )!;
  assert.equal(
    Buffer.from(
      String(record(credentials.data).AWS_ACCESS_KEY_ID),
      "base64",
    ).toString(),
    "source-read-key",
  );
  const policy = manifests.find((o) => o.kind === "CiliumNetworkPolicy")!;
  const egress = record(policy.spec).egress as Record<string, unknown>[];
  assert.deepEqual(
    egress.flatMap((rule) => (Array.isArray(rule.toFQDNs) ? rule.toFQDNs : [])),
    [
      { matchName: new URL(ctx.backup.endpointUrl).hostname },
      { matchName: new URL(source.endpoint_url).hostname },
    ],
  );
  assert.equal(
    restoreAdministrationPassword(db, ctx),
    restoreAdministrationPassword(db, {
      ...ctx,
      recoverySource: {
        ...ctx.recoverySource,
        credentials: {
          accessKeyId: "rotated-source-read",
          secretAccessKey: "rotated-source-secret",
        },
      },
    }),
  );
  assert.throws(
    () => buildDatabaseManifests(db, { ...ctx, recoverySource: undefined }),
    /recovery source/,
  );
  assert.throws(
    () =>
      buildDatabaseManifests(db, {
        ...ctx,
        recoverySource: {
          ...ctx.recoverySource,
          endpointUrl: "https://foreign.r2.cloudflarestorage.com",
        },
      }),
    /recovery source/,
  );
});

test("cross-region source credentials retain their UID/version across revision and restart while source identity stays fenced", async () => {
  const { db, ctx } = crossRegionRecoveryFixture(),
    k8s = new MemoryKubernetes();
  const reconciler = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => false,
    );
  await reconciler().reconcile(db, ctx);
  const namespace = `pgcf-db-${db.id}`;
  const source = await k8s.read(
      "Secret",
      namespace,
      "recovery-source-credentials",
    ),
    admin = await k8s.read("Secret", namespace, "restore-superuser");
  assert.ok(source);
  assert.ok(admin);
  db.generation++;
  await reconciler().reconcile(db, ctx);
  await reconciler().reconcile(db, ctx);
  const repeated = await k8s.read(
      "Secret",
      namespace,
      "recovery-source-credentials",
    ),
    repeatedAdmin = await k8s.read("Secret", namespace, "restore-superuser");
  assert.equal(repeated?.metadata.uid, source.metadata.uid);
  assert.equal(
    repeated?.metadata.resourceVersion,
    source.metadata.resourceVersion,
  );
  assert.equal(repeatedAdmin?.metadata.uid, admin.metadata.uid);
  assert.deepEqual(repeatedAdmin?.data, admin.data);
  const mutations = k8s.mutations;
  db.recovery!.source_archive!.endpoint_url =
    "https://foreign.r2.cloudflarestorage.com";
  const changed = await reconciler().reconcile(db, ctx);
  assert.equal(changed?.state, "error");
  assert.match(changed?.message ?? "", /recovery source identity changed/);
  assert.equal(k8s.mutations, mutations);
  assert.equal(
    (await k8s.read("Secret", namespace, "recovery-source-credentials"))
      ?.metadata.uid,
    source.metadata.uid,
  );
});

test("uses source database recovery and distinct archive rather than creating an empty target", () => {
  const { db, ctx } = recoveryFixture();
  const manifests = buildDatabaseManifests(db, ctx),
    cluster = manifests.find((o) => o.kind === "Cluster")!;
  const spec = record(cluster.spec),
    boot = record(spec.bootstrap),
    recovery = record(boot.recovery);
  assert.equal(boot.initdb, undefined);
  assert.equal(recovery.database, db.recovery!.source_database_id);
  assert.equal(
    record(recovery.recoveryTarget).backupID,
    db.recovery!.backup_id,
  );
  assert.equal(
    record(recovery.recoveryTarget).targetTime,
    db.recovery!.target_time,
  );
  assert.equal(spec.enableSuperuserAccess, true);
  assert.equal(record(spec.superuserSecret).name, "restore-superuser");
  const source = manifests.find(
    (o) => o.kind === "ObjectStore" && o.metadata.name === "recovery-source",
  )!;
  assert.equal(
    record(record(source.spec).configuration).destinationPath,
    db.recovery!.source_archive_path,
  );
});

test("recovery Job Barman sidecar meets namespace CPU and memory limit requirements", () => {
  const { db, ctx } = recoveryFixture();
  const manifests = buildDatabaseManifests(db, ctx);
  const cluster = manifests.find((o) => o.kind === "Cluster")!;
  const external = record(cluster.spec).externalClusters;
  assert.ok(Array.isArray(external));
  // v0.15.0 recovery Jobs read the external source ObjectStore resources,
  // independently of the ObjectStore used by the instance's WAL archiver.
  const sourceName = record(record(external[0]).plugin).parameters;
  const source = manifests.find(
    (o) =>
      o.kind === "ObjectStore" &&
      o.metadata.name === record(sourceName).barmanObjectName,
  )!;
  assert.ok(source);
  const spec = record(source.spec);
  const sidecar = record(spec.instanceSidecarConfiguration);
  assert.deepEqual(sidecar.resources, {
    requests: {
      cpu: `${SIDECAR.requestCpuMillicores}m`,
      memory: `${SIDECAR.requestMemoryMib}Mi`,
    },
    limits: {
      cpu: `${SIDECAR.limitCpuMillicores}m`,
      memory: `${SIDECAR.limitMemoryMib}Mi`,
    },
  });
  assert.deepEqual(sidecar.env, [
    { name: "AWS_DEFAULT_REGION", value: ctx.backup.region },
  ]);
  assert.equal(spec.retentionPolicy, undefined);
});
test("SQL failure never publishes a target and restart can resume the same recovery storage", async () => {
  const { db, ctx } = recoveryFixture(),
    k8s = new MemoryKubernetes();
  let mapped = false,
    calls = 0;
  const admin = async () => {
    calls++;
    return mapped;
  };
  const reconciler = () =>
    new Reconciler(
      k8s,
      new AbortController().signal,
      Date.now,
      metrics,
      authenticate,
      undefined,
      undefined,
      undefined,
      undefined,
      admin,
    );
  const first = await reconciler().reconcile(db, ctx);
  assert.notEqual(first?.state, "ready");
  assert.ok(calls > 0);
  const original = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  assert.ok(original);
  mapped = true;
  const complete = await reconciler().reconcile(db, ctx);
  assert.equal(complete?.state, "ready");
  assert.deepEqual(complete?.recovery, {
    operation_id: db.recovery!.operation_id,
    storage_generation: 2,
    verified: true,
  });
  const after = await k8s.read("Cluster", `pgcf-db-${db.id}`, "database");
  assert.equal(after?.metadata.uid, original.metadata.uid);
  assert.equal(record(after?.spec).enableSuperuserAccess, false);
  assert.equal(
    await k8s.read("Secret", `pgcf-db-${db.id}`, "restore-superuser"),
    null,
  );
  const repeat = await reconciler().reconcile(db, ctx);
  assert.equal(repeat?.state, "ready");
  assert.equal(
    k8s.actions.filter((a) => a === "create:Cluster:database").length,
    1,
  );
});

test("a restored target can be deleted without resurrecting its retained source", async () => {
  const { db, ctx } = recoveryFixture(),
    k8s = new MemoryKubernetes();
  const reconciler = new Reconciler(
    k8s,
    new AbortController().signal,
    Date.now,
    metrics,
    authenticate,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => true,
  );
  assert.equal((await reconciler.reconcile(db, ctx))?.state, "ready");
  const source = db.recovery!.source_database_id;
  db.desired_state = "deleted";
  db.generation = 2;
  db.recovery = undefined;
  db.roles = [];
  assert.equal((await reconciler.reconcile(db))?.state, "deleted");
  assert.equal(
    await k8s.read("Namespace", undefined, `pgcf-db-${source}`),
    null,
  );
});
