// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reconcileBackup } from "../src/backup-reconcile.ts";
import { backupHash, backupName, backupSpec } from "../src/backup-types.ts";

test("retains one owned base-backup operation across uncertain creation and completion, refusing redispatch, foreign archive and lost authority", async () => {
  const ids = {
    operation: "11111111-1111-4111-8111-111111111111",
    backup: "22222222-2222-4222-8222-222222222222",
    organization: "33333333-3333-4333-8333-333333333333",
    project: "44444444-4444-4444-8444-444444444444",
    environment: "55555555-5555-4555-8555-555555555555",
    region: "66666666-6666-4666-8666-666666666666",
    namespace: "77777777-7777-4777-8777-777777777777",
    cluster: "88888888-8888-4888-8888-888888888888",
    store: "99999999-9999-4999-8999-999999999999",
    resource: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const namespace = `pgcf-${ids.environment.replaceAll("-", "")}`;
  const spec = {
    name: "manual-base-backup",
    regionId: ids.region,
    catalogVersion: "test-v1",
    profileId: "small",
    volumeGiB: 5,
    profile: {
      id: "small",
      postgresImage: `example.invalid/postgres:18@sha256:${"a".repeat(64)}`,
      compute: { cpuMilli: 500, memoryMiB: 512 },
      storage: {
        classId: "local",
        storageClassName: "test-local",
        minGiB: 5,
        maxGiB: 50,
        stepGiB: 5,
      },
      instances: 1,
      backup: {
        endpointURL: "https://archive.example.invalid",
        region: "auto",
        destinationPath: "s3://fixture-backups/base",
        retentionPolicy: "7d",
        credentialSecret: {
          namespace: "platform",
          name: "test-backups",
          accessKeyIdKey: "access",
          secretAccessKeyKey: "secret",
        },
      },
    },
  };
  const claim = {
    schemaVersion: 1,
    kind: "environment.backup",
    operationId: ids.operation,
    backupId: ids.backup,
    organizationId: ids.organization,
    projectId: ids.project,
    environmentId: ids.environment,
    regionId: ids.region,
    specRevision: 1,
    specHash: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    clusterUid: ids.cluster,
    runtimeRevision: 0,
    spec,
    dispatch: null,
    leaseToken: `cplease_${"a".repeat(43)}`,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const labels = {
    "app.kubernetes.io/managed-by": "cloudflare-postgres",
    "pgcf.io/environment-id": ids.environment,
    "pgcf.io/region-id": ids.region,
  };
  const metadata = (name, uid, namespaced = true) => ({
    name,
    ...(namespaced ? { namespace } : {}),
    uid,
    generation: 1,
    resourceVersion: "10",
    labels: { ...labels },
    annotations: { "pgcf.io/spec-hash": claim.specHash },
  });
  const cluster = {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Cluster",
    metadata: metadata("database", ids.cluster),
    spec: {
      instances: 1,
      imageName: spec.profile.postgresImage,
      enableSuperuserAccess: false,
      bootstrap: {
        initdb: { database: "app", owner: "app", dataChecksums: true },
      },
      storage: { size: "5Gi", storageClass: "test-local" },
      resources: {
        requests: { cpu: "500m", memory: "512Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
      plugins: [
        {
          name: "barman-cloud.cloudnative-pg.io",
          enabled: true,
          isWALArchiver: true,
          parameters: { barmanObjectName: "archive", serverName: "database" },
        },
      ],
    },
    status: {
      readyInstances: 1,
      currentPrimary: "database-1",
      conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }],
    },
  };
  const store = {
    apiVersion: "barmancloud.cnpg.io/v1",
    kind: "ObjectStore",
    metadata: metadata("archive", ids.store),
    spec: {
      configuration: {
        destinationPath: `${spec.profile.backup.destinationPath}/${ids.environment}/`,
        endpointURL: spec.profile.backup.endpointURL,
        s3Credentials: {
          region: { name: "archive-credentials", key: "region" },
          accessKeyId: { name: "archive-credentials", key: "accessKeyId" },
          secretAccessKey: {
            name: "archive-credentials",
            key: "secretAccessKey",
          },
        },
        wal: { compression: "gzip" },
        data: { compression: "gzip" },
      },
      retentionPolicy: "7d",
      instanceSidecarConfiguration: {
        resources: {
          requests: { cpu: "25m", memory: "64Mi" },
          limits: { cpu: "100m", memory: "128Mi" },
        },
      },
    },
  };
  const resources = new Map([
    [
      `Namespace::${namespace}`,
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: metadata(namespace, ids.namespace, false),
      },
    ],
    [`Cluster:${namespace}:database`, cluster],
    [`ObjectStore:${namespace}:archive`, store],
  ]);
  let createCount = 0,
    dispatchCount = 0,
    lostCreateReply = true;
  const runtime = {
    async read(kind, ns, name) {
      return structuredClone(resources.get(`${kind}:${ns}:${name}`) ?? null);
    },
    async create(desired) {
      createCount += 1;
      assert.equal(desired.kind, "Backup");
      assert.deepEqual(desired.spec, backupSpec());
      const stored = structuredClone(desired);
      stored.metadata.uid = ids.resource;
      stored.metadata.resourceVersion = "11";
      stored.metadata.generation = 1;
      stored.status = { phase: "started" };
      resources.set(`Backup:${namespace}:${desired.metadata.name}`, stored);
      if (lostCreateReply) {
        lostCreateReply = false;
        throw new Error("lost reply after committed Backup create");
      }
      return structuredClone(stored);
    },
  };
  const control = {
    async dispatch(current, nonce, binding) {
      dispatchCount += 1;
      assert.equal(
        createCount,
        0,
        "durable dispatch must precede physical effect",
      );
      assert.equal(binding.backupName, backupName(ids.backup));
      assert.equal(binding.backupSpecHash, backupHash(backupSpec()));
      assert.equal(binding.objectStoreSpecHash, backupHash(store.spec));
      assert.equal(binding.namespaceUid, ids.namespace);
      return {
        created: true,
        dispatch: {
          version: 1,
          nonce,
          leaseEpoch: current.leaseEpoch,
          binding,
        },
      };
    },
  };
  const attempt = { createAttempted: false, resourceUid: null };
  cluster.spec.plugins[0].enabled = false;
  await assert.rejects(
    reconcileBackup(runtime, control, claim, attempt, () => {}),
    /backup_identity_changed/,
    "a disabled WAL plugin must refuse backup dispatch before physical effects",
  );
  assert.equal(dispatchCount, 0);
  assert.equal(createCount, 0);
  cluster.spec.plugins[0].enabled = true;
  const first = await reconcileBackup(
    runtime,
    control,
    claim,
    attempt,
    () => {},
  );
  assert.equal(
    dispatchCount,
    1,
    "the operation must obtain a winning durable dispatch checkpoint",
  );
  assert.equal(createCount, 1);
  assert.equal(first.terminal, false);
  assert.equal(attempt.resourceUid, ids.resource);
  const name = backupName(ids.backup);
  const resource = resources.get(`Backup:${namespace}:${name}`);
  assert.equal(resource.metadata.ownerReferences[0].uid, ids.cluster);
  const resumed = {
    ...structuredClone(claim),
    leaseEpoch: 2,
    leaseToken: `cplease_${"b".repeat(43)}`,
  };
  assert.equal(
    (
      await reconcileBackup(
        runtime,
        control,
        resumed,
        { createAttempted: false, resourceUid: null },
        () => {},
      )
    ).terminal,
    false,
  );
  assert.equal(createCount, 1);
  assert.equal(dispatchCount, 1);
  resource.status = {
    phase: "completed",
    method: "plugin",
    majorVersion: 18,
    backupId: "20260929T000000",
    backupName: "backup-20260929T000000",
    startedAt: "2026-09-29T00:00:00Z",
    stoppedAt: "2026-09-29T00:00:30Z",
    beginWal: "000000010000000000000001",
    endWal: "000000010000000000000002",
    beginLSN: "0/1000000",
    endLSN: "0/2000000",
    online: true,
    pluginMetadata: {
      timeline: "1",
      version: "0.15.0",
      name: "barman-cloud.cloudnative-pg.io",
      displayName: "BarmanCloudInstance",
      clusterUID: ids.cluster,
      pluginName: "barman-cloud.cloudnative-pg.io",
    },
    error: "must-not-copy-raw-backup-error",
    commandError: "must-not-copy-command-output",
    s3Credentials: { secretName: "must-not-copy-secret-reference" },
  };
  store.metadata.resourceVersion = "12";
  cluster.spec.plugins[0].enabled = false;
  await assert.rejects(
    reconcileBackup(runtime, control, resumed, attempt, () => {}),
    /backup_identity_changed/,
    "a disabled WAL plugin must not yield accepted completed-backup evidence",
  );
  assert.equal(dispatchCount, 1);
  assert.equal(createCount, 1);
  cluster.spec.plugins[0].enabled = true;
  const completed = await reconcileBackup(
    runtime,
    control,
    resumed,
    { createAttempted: false, resourceUid: null },
    () => {},
  );
  assert.equal(completed.terminal, true);
  assert.equal(completed.observation.phase, "completed");
  assert.equal(
    completed.observation.artifact.startedAt,
    "2026-09-29T00:00:00.000Z",
  );
  assert.equal(
    completed.observation.artifact.stoppedAt,
    "2026-09-29T00:00:30.000Z",
  );
  assert.equal(completed.observation.remoteObjectsVerified, false);
  assert.equal(completed.observation.restoreVerified, false);
  assert.equal(JSON.stringify(completed).includes("must-not-copy"), false);
  const accepted = structuredClone(completed.observation);
  resources.delete(`Backup:${namespace}:${name}`);
  assert.equal(
    (
      await reconcileBackup(
        runtime,
        control,
        resumed,
        { createAttempted: false, resourceUid: null },
        () => {},
      )
    ).terminal,
    false,
  );
  assert.equal(
    createCount,
    1,
    "missing recorded Backup must not create another physical artifact",
  );
  resources.set(`Backup:${namespace}:${name}`, structuredClone(resource));
  const replaced = resources.get(`Backup:${namespace}:${name}`);
  replaced.metadata.uid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await assert.rejects(
    reconcileBackup(runtime, control, resumed, attempt, () => {}),
    /backup_identity_changed/,
  );
  resources.set(`Backup:${namespace}:${name}`, structuredClone(resource));
  store.metadata.uid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await assert.rejects(
    reconcileBackup(
      runtime,
      control,
      resumed,
      { createAttempted: false, resourceUid: null },
      () => {},
    ),
    /backup_archive_changed/,
  );
  store.metadata.uid = ids.store;
  const originalRead = runtime.read;
  let permitted = true;
  runtime.read = async (...args) => {
    const current = await originalRead(...args);
    if (args[0] === "Backup") permitted = false;
    return current;
  };
  await assert.rejects(
    reconcileBackup(
      runtime,
      control,
      resumed,
      { createAttempted: false, resourceUid: null },
      () => {
        if (!permitted) throw new Error("authority_lost");
      },
    ),
    /authority_lost/,
  );
  assert.equal(createCount, 1);
  assert.deepEqual(
    accepted,
    completed.observation,
    "accepted artifact evidence is independent of later CR disappearance",
  );
});
