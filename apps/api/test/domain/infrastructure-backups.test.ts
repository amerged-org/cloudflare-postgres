// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import type { Env } from "../../src/env.ts";
import {
  authorizeBackupOperator,
  configureInfrastructureBackups,
  finishInfrastructureBackup,
  initializeInfrastructureBackup,
  prepareInfrastructureBackupInput,
  infrastructureBackupHealth,
  infrastructureBackupKey,
  infrastructureBackupStatus,
  readInfrastructureBackupConfig,
  recordPreparedBackups,
  runInfrastructureBackupCron,
} from "../../src/domain/infrastructure-backups.ts";
import {
  runInfrastructureHealthAlerts,
  infrastructureAlertStatus,
} from "../../src/domain/infrastructure-alerts.ts";
import { uploadInfrastructureArtifact } from "../../src/workflows/infrastructure-backup.ts";
import {
  storeRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
afterEach(async () => {
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET enabled=0,d1_account_id=NULL,d1_database_id=NULL,d1_region_id=NULL,notification_recipient=NULL,notification_sender=NULL,enabled_at=NULL,updated_at=NULL,revision=0 WHERE singleton=1",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_release_observations WHERE node_id IN(SELECT node_id FROM fleet_node_releases WHERE release_id LIKE 'daily-backup-test-%')",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_releases WHERE release_id LIKE 'daily-backup-test-%'",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_releases WHERE id LIKE 'daily-backup-test-%'",
  ).run();
  await cleanupFixtures();
});
function config(region: string) {
  return {
    enabled: true,
    d1_account_id: "a".repeat(32),
    d1_database_id: crypto.randomUUID(),
    d1_region_id: region,
    notification_recipient: null,
    notification_sender: null,
  };
}
function enabled(): Env {
  return {
    ...env,
    INFRASTRUCTURE_BACKUP_CF_TOKEN: "private-test-export-token",
  };
}
it("defaults off with no recipient; admin API cannot be configured by an integrator", async () => {
  const f = await fixture();
  expect(await readInfrastructureBackupConfig(env.DB)).toMatchObject({
    enabled: false,
    notification_recipient: null,
    notification_sender: null,
  });
  expect(
    (await request("/v1/infrastructure-backups/config", f.integrator)).status,
  ).toBe(403);
  expect(
    (await request("/v1/infrastructure-backups/config", f.admin)).status,
  ).toBe(200);
  await runInfrastructureBackupCron(env);
  expect(await infrastructureBackupStatus(env.DB)).toBeNull();
  await expect(
    configureInfrastructureBackups(
      { ...env, INFRASTRUCTURE_BACKUP_CF_TOKEN: undefined },
      config(f.region),
    ),
  ).rejects.toThrow("D1 export secret");
});
it("uses actual local Workflow missing-instance semantics and one persisted daily id across create ambiguity", async () => {
  const f = await fixture(),
    at = Date.now();
  await expect(
    env.INFRASTRUCTURE_BACKUP.get(crypto.randomUUID()),
  ).rejects.toThrow("instance.not_found");
  const created: string[] = [];
  const binding = {
    ...enabled(),
    INFRASTRUCTURE_BACKUP: {
      async get(id: string) {
        if (created.includes(id))
          return {
            async status() {
              return { status: "queued" };
            },
          };
        return env.INFRASTRUCTURE_BACKUP.get(id);
      },
      async create(options: { id: string }) {
        created.push(options.id);
        throw new Error("response-lost-after-create");
      },
    } as unknown as Workflow<{ run_id: string }>,
  };
  await configureInfrastructureBackups(binding, config(f.region), at);
  await runInfrastructureBackupCron(binding, at);
  await runInfrastructureBackupCron(binding, at + 60000);
  expect(created).toHaveLength(1);
  expect(await infrastructureBackupStatus(env.DB)).toMatchObject({
    id: created[0],
    day: new Date(at).toISOString().slice(0, 10),
    status: "pending",
  });
});
it("first failed run is failing without an older success; stale grace expires and optional email is generic and deduplicated", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(
      enabled(),
      {
        ...config(f.region),
        notification_recipient: "operator@example.com",
        notification_sender: "alerts@example.com",
      },
      at - 3600000,
    );
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,expires_at) VALUES(?,?,?,'running',?,?)",
  )
    .bind(
      run,
      new Date(at).toISOString().slice(0, 10),
      c.revision,
      new Date(at - 1000).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  await finishInfrastructureBackup(
    env,
    run,
    new Error("infrastructure_backup_snapshot_source_unavailable"),
  );
  expect(await infrastructureBackupHealth(env, Date.now())).toContainEqual(
    expect.objectContaining({
      kind: "d1",
      region_id: f.region,
      status: "failing",
    }),
  );
  const sent: {
    url: string;
    body: Record<string, unknown>;
    key: string | null;
  }[] = [];
  const transport: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      body: JSON.parse(init!.body as string),
      key: new Headers(init!.headers).get("Idempotency-Key"),
    });
    return new Response(null, { status: 202 });
  };
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-private-resend-key" },
    Date.now(),
    transport,
  );
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-private-resend-key" },
    Date.now() + 60001,
    transport,
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    url: "https://api.resend.com/emails",
    body: { to: ["operator@example.com"], from: "alerts@example.com" },
  });
  expect(sent[0]!.key).toBe(
    (await infrastructureAlertStatus(env.DB, f.region)).find(
      (a) => a.kind === "infrastructure_backup_failed",
    )!.event_id,
  );
  await env.DB.prepare("DELETE FROM infrastructure_backup_runs").run();
  expect(
    await infrastructureBackupHealth(env, at + 37 * 3600000),
  ).toContainEqual(expect.objectContaining({ status: "stale" }));
});
it("retains lost/stale node episodes using existing heartbeat freshness, without recipient defaults", async () => {
  const f = await fixture(),
    at = Date.now();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at - 200000).toISOString(), f.node)
    .run();
  let sent = 0;
  await runInfrastructureHealthAlerts(
    { ...env, RESEND_API_KEY: "test-secret" },
    at,
    async () => {
      sent++;
      return new Response(null, { status: 202 });
    },
  );
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({
      kind: "regional_node_stale",
      active: true,
      delivered_at: null,
    }),
  );
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(at + 1).toISOString(), f.node)
    .run();
  await runInfrastructureHealthAlerts(env, at + 1);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toContainEqual(
    expect.objectContaining({ kind: "regional_node_stale", active: false }),
  );
});
it("derived backup encryption retains the selected key version without changing credential material", async () => {
  const first = await infrastructureBackupKey(env.CREDENTIAL_KEYS),
    second = await infrastructureBackupKey(env.CREDENTIAL_KEYS);
  expect(first).toEqual(second);
  expect(first.kid).toBe("v1");
  expect(first.key).not.toBe(JSON.parse(env.CREDENTIAL_KEYS).keys.v1);
});
it("prepared artifact receipts accept full D1 rows by their exact bound identity and reject cross-run callbacks", async () => {
  const f = await fixture(),
    at = Date.now(),
    run = crypto.randomUUID(),
    c = await configureInfrastructureBackups(enabled(), config(f.region), at);
  const day = new Date(at).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,expires_at) VALUES(?,?,?,'running',?,?)",
  )
    .bind(
      run,
      day,
      c.revision,
      new Date(at).toISOString(),
      new Date(at + 3600000).toISOString(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,object_key) VALUES(?,'d1-control','d1',?,?,?,'pending',?)",
  )
    .bind(run, day, f.region, c.d1_database_id, `test/${run}`)
    .run();
  const metadata = {
    run_id: run,
    id: "d1-control",
    kind: "d1",
    day,
    region_id: f.region,
    source_id: c.d1_database_id,
    node_id: null,
    node_uid: null,
    cluster_uid: null,
    material_revision: null,
    kid: "v1",
    plaintext_sha256: "a".repeat(64),
    plaintext_bytes: 42,
    encrypted_sha256: "b".repeat(64),
    encrypted_bytes: 80,
  };
  await expect(
    recordPreparedBackups(env, run, [
      { ...metadata, run_id: crypto.randomUUID() },
    ]),
  ).rejects.toThrow("artifact_identity_changed");
  await recordPreparedBackups(env, run, [metadata]);
  expect(await infrastructureBackupStatus(env.DB, run)).toMatchObject({
    artifacts: [{ status: "prepared", plaintext_bytes: 42 }],
  });
  await expect(
    authorizeBackupOperator(env, run, "d1-control", "Bearer invalid"),
  ).rejects.toThrow("capability");
});
it("R2 multipart writes bounded parts and preserves a committed unique object after uncertain completion", async () => {
  const key = `test-infra-${crypto.randomUUID()}`,
    bytes = new Uint8Array(17 * 1024 * 1024 + 7);
  bytes.fill(37);
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 10 * 1024 * 1024));
      controller.enqueue(bytes.subarray(10 * 1024 * 1024));
      controller.close();
    },
  });
  let completions = 0,
    aborts = 0;
  const partSizes: number[] = [];
  const uncertainBucket = {
    async createMultipartUpload(
      objectKey: string,
      options: R2MultipartOptions,
    ) {
      const actual = await env.ARCHIVE.createMultipartUpload(
        objectKey,
        options,
      );
      return {
        async uploadPart(part: number, body: Uint8Array) {
          partSizes.push(body.length);
          return actual.uploadPart(part, body);
        },
        async complete(parts: R2UploadedPart[]) {
          completions++;
          await actual.complete(parts);
          throw new Error("completion_response_lost");
        },
        async abort() {
          aborts++;
          await actual.abort();
        },
      };
    },
    head: (objectKey: string) => env.ARCHIVE.head(objectKey),
  } as unknown as R2Bucket;
  await uploadInfrastructureArtifact(uncertainBucket, key, chunks, {
    run_id: "test-run",
  });
  expect(partSizes).toEqual([
    8 * 1024 * 1024,
    8 * 1024 * 1024,
    1024 * 1024 + 7,
  ]);
  expect(completions).toBe(1);
  expect(aborts).toBe(0);
  const object = await env.ARCHIVE.get(key);
  expect(object!.size).toBe(bytes.length);
  const actual = new Uint8Array(await object!.arrayBuffer());
  expect(actual.length).toBe(bytes.length);
  expect(actual[0]).toBe(37);
  expect(actual.at(-1)).toBe(37);
  await env.ARCHIVE.delete(key);
});

it("binds one fresh control snapshot source and revokes its daily capability on a changed Node UID", async () => {
  const f = await fixture(),
    binding = enabled(),
    now = Date.now(),
    run = crypto.randomUUID(),
    configured = await configureInfrastructureBackups(
      binding,
      config(f.region),
      now,
    ),
    cluster = crypto.randomUUID(),
    release = "daily-backup-test-" + crypto.randomUUID();
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"),
    agent = await env.DB.prepare(
      "SELECT agent_key_hash FROM regions WHERE id=?",
    )
      .bind(f.region)
      .first<string>("agent_key_hash");
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "daily-backup-test",
      cluster_endpoint: "https://192.0.2.40:6443",
      kube_system_uid: cluster,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "cluster: private-test-material\n",
      talos_admin_config: "context: private-test-material\n",
      kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
    },
  );
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(
      release,
      JSON.stringify({
        components: [
          {
            name: "image/cilium/cilium",
            reference: "quay.io/cilium/cilium:v1.20.2@sha256:" + "a".repeat(64),
          },
        ],
      }),
      "c".repeat(64),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'control_relay',1,?)",
    ).bind(f.node, uid, release, new Date(now).toISOString()),
    env.DB.prepare(
      "INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at) VALUES(?,?,1,?,?,?,?)",
    ).bind(
      f.node,
      uid,
      agent,
      JSON.stringify({
        kubernetes_control_plane: true,
        components: [
          { name: "image/cilium/cilium", runtime_image_sha256: "b".repeat(64) },
        ],
      }),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)",
    ).bind(
      run,
      new Date(now).toISOString().slice(0, 10),
      configured.revision,
      new Date(now).toISOString(),
      new Date(now + 3600000).toISOString(),
    ),
  ]);
  const artifacts = await initializeInfrastructureBackup(binding, run);
  expect(artifacts).toHaveLength(2);
  const input = await prepareInfrastructureBackupInput(
      binding,
      run,
      "https://exports.example.test/control.sql",
    ),
    source = input.artifacts.find((value) => value.kind === "etcd")!;
  expect(source.node_id).toBe(f.node);
  expect(source.cluster_uid).toBe(cluster);
  expect(
    (
      await authorizeBackupOperator(
        binding,
        run,
        source.id,
        `Bearer ${source.source!.operator_token}`,
      )
    ).node_id,
  ).toBe(f.node);
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.node)
    .run();
  await expect(
    authorizeBackupOperator(
      binding,
      run,
      source.id,
      `Bearer ${source.source!.operator_token}`,
    ),
  ).rejects.toThrow("authority changed");
  await env.DB.prepare("DELETE FROM fleet_node_releases WHERE node_id=?")
    .bind(f.node)
    .run();
  await env.DB.prepare(
    "DELETE FROM fleet_node_release_observations WHERE node_id=?",
  )
    .bind(f.node)
    .run();
});

it("does not reuse a same-region success after the configured D1 database or sealed cluster identity changes", async () => {
  const f = await fixture(),
    now = Date.now(),
    binding = enabled(),
    run = crypto.randomUUID(),
    selected = await configureInfrastructureBackups(
      binding,
      config(f.region),
      now,
    ),
    oldCluster = crypto.randomUUID(),
    newCluster = crypto.randomUUID(),
    nodeUid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid");
  const bundle = (uid: string) => ({
    version: 1 as const,
    cluster_name: "backup-health-test",
    cluster_endpoint: "https://192.0.2.40:6443",
    kube_system_uid: uid,
    talos_version: "1.14.1",
    kubernetes_version: "1.36.5",
    talos_machine_secrets_yaml: "cluster: private-test-material\n",
    talos_admin_config: "context: private-test-material\n",
    kubeconfig: "apiVersion: v1\ncontext: private-test-material\n",
  });
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    bundle(oldCluster),
  );
  const at = new Date(now).toISOString(),
    day = at.slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_runs(id,day,config_revision,status,created_at,completed_at,expires_at) VALUES(?,?,?,'complete',?,?,?)",
    ).bind(
      run,
      day,
      selected.revision,
      at,
      at,
      new Date(now + 3600000).toISOString(),
    ),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,status,completed_at,object_key) VALUES(?,'d1-control','d1',?,?,?,'complete',?,?)",
    ).bind(run, day, f.region, selected.d1_database_id, at, `test/${run}/d1`),
    env.DB.prepare(
      "INSERT INTO infrastructure_backup_artifacts(run_id,id,kind,day,region_id,source_id,node_id,node_uid,cluster_uid,material_revision,status,completed_at,object_key) VALUES(?,'etcd-control','etcd',?,?,?,?,?,?,1,'complete',?,?)",
    ).bind(
      run,
      day,
      f.region,
      oldCluster,
      f.node,
      nodeUid,
      oldCluster,
      at,
      `test/${run}/etcd`,
    ),
  ]);
  expect(
    (await infrastructureBackupHealth(env, now))
      .filter((value) => value.region_id === f.region)
      .map((value) => value.status),
  ).toEqual(["ok", "ok"]);
  await configureInfrastructureBackups(
    binding,
    {
      enabled: true,
      d1_account_id: selected.d1_account_id,
      d1_database_id: crypto.randomUUID(),
      d1_region_id: selected.d1_region_id,
      notification_recipient: null,
      notification_sender: null,
    },
    now + 1,
  );
  const d1AfterReconfiguration = (
    await infrastructureBackupHealth(env, now + 2)
  ).find(
    (value) => value.kind === "d1" && value.region_id === f.region,
  )?.status;
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 2),
    bundle(newCluster),
  );
  await env.DB.prepare(
    "UPDATE regions SET bootstrap_material_revision=2 WHERE id=?",
  )
    .bind(f.region)
    .run();
  const fresh = await infrastructureBackupHealth(env, now + 3);
  expect([
    d1AfterReconfiguration,
    fresh.find((value) => value.kind === "etcd" && value.region_id === f.region)
      ?.status,
  ]).toEqual(["unknown", "unknown"]);
  expect(fresh.every((value) => value.last_completed_at === null)).toBe(true);
});
