// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Client, ClientConfig } from "pg";
import {
  archiveProbeOptions,
  probeArchive,
  ARCHIVE_QUERY,
  ARCHIVE_IDENTITY_QUERY,
} from "../../src/agent/archive-probe.ts";
import { MAINTENANCE_ROLE } from "@pgcf/contracts/maintenance";
import {
  fixture,
  MemoryKubernetes,
  metrics,
  authenticate,
} from "./fixtures.ts";
import { Reconciler } from "../../src/agent/reconcile.ts";
import { record } from "../../src/agent/types.ts";
import { GENERATION_ANNOTATION } from "../../src/agent/observe.ts";
import { newDatabaseId, newRolePassword } from "@pgcf/contracts";

function options() {
  const databaseId = newDatabaseId();
  return {
    databaseId,
    namespace: `pgcf-db-${databaseId}`,
    primaryAddress: [10, 20, 0, 1].join("."),
    credentials: { user: MAINTENANCE_ROLE, password: newRolePassword() },
    ca: "invalid",
    signal: new AbortController().signal,
    deadline: Date.now() + 2000,
    now: Date.now,
    verifyBinding: async () => true,
  };
}
test("invalid CA cannot start an archive SQL connection or return fabricated zero", async () => {
  let created = 0;
  await assert.rejects(
    probeArchive(options(), () => {
      created++;
      throw new Error(randomUUID());
    }),
  );
  assert.equal(created, 0);
});
// The query assertions protect the actual default-client statements; doubles remain in this test file only.
test("archive statements contain only read-only identity and archive observations", () => {
  assert.ok(ARCHIVE_QUERY.includes("pg_ls_archive_statusdir"));
  assert.ok(ARCHIVE_QUERY.includes("pg_stat_archiver"));
  assert.ok(ARCHIVE_IDENTITY_QUERY.includes("pg_stat_ssl"));
  assert.ok(
    !/pg_switch_wal|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT)\b/i.test(
      ARCHIVE_QUERY + ARCHIVE_IDENTITY_QUERY,
    ),
  );
});

const id = newDatabaseId(),
  host = `database-rw.pgcf-db-${id}.svc`;
const folder = mkdtempSync(join(tmpdir(), "pgcf-archive-ca-"));
let ca: string;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(folder, "generated-key"),
      "-out",
      join(folder, "generated-certificate"),
      "-days",
      "1",
      "-subj",
      "/CN=pgcf-test",
      "-addext",
      `subjectAltName=DNS:${host}`,
    ],
    { stdio: "ignore", timeout: 20000 },
  );
  ca = readFileSync(join(folder, "generated-certificate"), "utf8");
} finally {
  rmSync(folder, { recursive: true });
}
function validOptions() {
  return { ...options(), databaseId: id, namespace: `pgcf-db-${id}`, ca };
}
function fake(
  change: {
    identity?: Record<string, unknown>;
    sample?: Record<string, unknown>;
    tls?: boolean;
    peerName?: string;
    queryError?: boolean;
    inetRepresentation?: boolean;
    abort?: AbortController;
  } = {},
) {
  let ended = 0,
    destroyed = 0;
  const queries: string[] = [],
    configs: ClientConfig[] = [];
  const identity = {
    database: id,
    role: MAINTENANCE_ROLE,
    recovery: false,
    server_address: [10, 20, 0, 1].join("."),
    tls: true,
    stats: true,
    only_stats: true,
    archive_listing: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    ...change.identity,
  };
  const sample = {
    ready_wal_files: "4",
    archived_count: "8",
    last_archived_time: String(Date.now() / 1000 - 2),
    failed_count: "0",
    ...change.sample,
  };
  const factory = (config: ClientConfig) => {
    configs.push(config);
    return {
      connection: {
        stream: {
          encrypted: change.tls !== false,
          authorized: change.tls !== false,
          getPeerCertificate: () =>
            change.peerName
              ? { subjectaltname: `DNS:${change.peerName}` }
              : new X509Certificate(ca).toLegacyObject(),
          destroy: () => {
            destroyed++;
          },
        },
      },
      on: () => {},
      connect: async () => {},
      query: async (statement: string) => {
        queries.push(statement);
        if (change.queryError) throw new Error(randomUUID());
        if (change.abort) {
          change.abort.abort();
          return new Promise(() => {});
        }
        return {
          rows: [
            statement === ARCHIVE_IDENTITY_QUERY
              ? change.inetRepresentation
                ? {
                    ...identity,
                    server_address: statement.includes(
                      "pg_catalog.host(pg_catalog.inet_server_addr())",
                    )
                      ? identity.server_address
                      : `${identity.server_address}/32`,
                  }
                : identity
              : sample,
          ],
        };
      },
      end: async () => {
        ended++;
      },
    } as unknown as Client;
  };
  return {
    factory,
    queries,
    configs,
    ended: () => ended,
    destroyed: () => destroyed,
  };
}
test("read-only archive probe uses verified TLS and returns actual counter/progress values without switching WAL", async () => {
  const client = fake(),
    result = await probeArchive(validOptions(), client.factory);
  assert.equal(result.readyWalFiles, 4);
  assert.equal(result.progress.archivedCount, 8);
  assert.equal(result.valid, true);
  assert.deepEqual(client.queries, [ARCHIVE_IDENTITY_QUERY, ARCHIVE_QUERY]);
  assert.equal(client.ended(), 1);
  assert.equal(client.configs[0]!.host, host);
  assert.equal(client.configs[0]!.user, MAINTENANCE_ROLE);
  assert.deepEqual(client.configs[0]!.ssl, {
    ca,
    servername: host,
    rejectUnauthorized: true,
  });
  assert.ok(
    client.configs[0]!.options!.includes("default_transaction_read_only=on"),
  );
});
test("an empty real archive history accepts only the explicit zero-count sentinel", async () => {
  const client = fake({
      sample: {
        ready_wal_files: "0",
        archived_count: "0",
        last_archived_time: "-1",
      },
    }),
    result = await probeArchive(validOptions(), client.factory);
  assert.deepEqual(result.progress, { archivedCount: 0, lastArchivedTime: -1 });
  assert.equal(result.readyWalFiles, 0);
});
test("wrong TLS and certificate hostname cannot produce archive proof", async () => {
  const client = fake({ tls: false });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 0);
  assert.equal(client.ended(), 1);
  const wrong = fake({ peerName: ["other", "invalid"].join(".") });
  await assert.rejects(probeArchive(validOptions(), wrong.factory));
  assert.equal(wrong.queries.length, 0);
  assert.equal(wrong.ended(), 1);
});
test("wrong actual database or role is refused before reading archive state", async () => {
  const client = fake({ identity: { database: newDatabaseId(), role: "app" } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});
test("a recovery server or elevated maintenance role cannot be used", async () => {
  const client = fake({ identity: { recovery: true, rolsuper: true } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});
test("missing or malformed counters never become zero or healthy", async () => {
  const client = fake({
    sample: {
      archived_count: undefined,
      last_archived_time: null,
      ready_wal_files: "NaN",
    },
  });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.ended(), 1);
});
test("unsafe counter magnitudes are refused", async () => {
  const client = fake({ sample: { archived_count: "9007199254740992" } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.ended(), 1);
});
test("future progress and invalid never-archived combinations remain uncertain", async () => {
  const future = fake({
    sample: { last_archived_time: String(Date.now() / 1000 + 100) },
  });
  await assert.rejects(probeArchive(validOptions(), future.factory));
  const invalid = fake({
    sample: { archived_count: "1", last_archived_time: "-1" },
  });
  await assert.rejects(probeArchive(validOptions(), invalid.factory));
  assert.equal(future.ended() + invalid.ended(), 2);
});
test("query failure closes its client without replay or a zero fallback", async () => {
  const client = fake({ queryError: true });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});
test("abort destroys and ends the client and stops subsequent archive queries", async () => {
  const controller = new AbortController(),
    client = fake({ abort: controller });
  await assert.rejects(
    probeArchive(
      { ...validOptions(), signal: controller.signal },
      client.factory,
    ),
  );
  assert.ok(client.destroyed() > 0);
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});
test("expired deadlines and wrong namespace are rejected before connection", async () => {
  const client = fake();
  await assert.rejects(
    probeArchive(
      { ...validOptions(), deadline: Date.now() - 1 },
      client.factory,
    ),
  );
  await assert.rejects(
    probeArchive({ ...validOptions(), namespace: "different" }, client.factory),
  );
  assert.equal(client.configs.length, 0);
});
test("changed owned binding rejects a completed SQL sample", async () => {
  const client = fake();
  await assert.rejects(
    probeArchive(
      { ...validOptions(), verifyBinding: async () => false },
      client.factory,
    ),
  );
  assert.equal(client.queries.length, 2);
  assert.equal(client.ended(), 1);
});

async function boundFixture() {
  const { db, ctx } = fixture(),
    k8s = new MemoryKubernetes();
  db.maintenance = {
    role: MAINTENANCE_ROLE,
    password: newRolePassword(),
    revision: 1,
  };
  await new Reconciler(
    k8s,
    new AbortController().signal,
    Date.now,
    metrics,
    authenticate,
  ).reconcile(db, ctx);
  db.power = {
    operation: db.creation!.operation_id,
    revision: db.generation,
    mode: "running",
    reason: null,
  };
  const namespace = `pgcf-db-${db.id}`,
    cluster = (await k8s.read("Cluster", namespace, "database"))!;
  const certificate = k8s.resources.get(
    k8s.key("Secret", namespace, "database-ca"),
  )!;
  record(certificate.data)["ca.crt"] = Buffer.from(ca).toString("base64");
  record(certificate.metadata).ownerReferences = [
    { kind: "Cluster", name: "database", uid: cluster.metadata.uid },
  ];
  const fence = (await k8s.read(
    "ConfigMap",
    "pgcf-system",
    `storage-${db.id}`,
  ))!;
  return { db, ctx, k8s, cluster, fence, namespace };
}
test("eligible wake binds acknowledged maintenance Secret, CA, namespace, Cluster and primary identities", async () => {
  const f = await boundFixture(),
    options = await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    );
  assert.ok(options);
  assert.equal(options.credentials.password, f.db.maintenance!.password);
  assert.equal(await options.verifyBinding(), true);
  const secret = f.k8s.resources.get(
    f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
  )!;
  secret.metadata.resourceVersion = String(
    Number(secret.metadata.resourceVersion) + 1,
  );
  assert.equal(await options.verifyBinding(), false);
});
test("unacknowledged or foreign maintenance bindings select no SQL probe", async () => {
  const f = await boundFixture(),
    secret = f.k8s.resources.get(
      f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
    )!;
  secret.metadata.labels!["pgcf.io/database-id"] = newDatabaseId();
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
  secret.metadata.labels!["pgcf.io/database-id"] = f.db.id;
  secret.metadata.resourceVersion = String(
    Number(secret.metadata.resourceVersion) + 1,
  );
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
});
test("legacy desired pages keep the exporter without opening SQL", async () => {
  const f = await boundFixture();
  delete f.db.power;
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
});
test("storage generation or current-primary identity changes invalidate an already bound SQL probe", async () => {
  const f = await boundFixture(),
    options = (await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ))!;
  const live = f.k8s.resources.get(
    f.k8s.key("Cluster", f.namespace, "database"),
  )!;
  record(live.status).currentPrimary = "database-next";
  assert.equal(await options.verifyBinding(), false);
  record(live.status).currentPrimary = record(f.cluster.status).currentPrimary;
  live.metadata.annotations![GENERATION_ANNOTATION] = String(
    f.db.generation + 1,
  );
  assert.equal(await options.verifyBinding(), false);
});
test("only the existing statistics membership is accepted", async () => {
  const client = fake({ identity: { only_stats: false } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});

test("eligible reconciliation uses the SQL sample and never scrapes exporter on SQL failure", async () => {
  const f = await boundFixture();
  f.db.creation!.ever_ready = true;
  let samples = 0,
    scrapes = 0;
  const exporter: typeof fetch = async (...args) => {
    scrapes++;
    return metrics(...args);
  };
  const power = {
    prepareRunning: async () => undefined,
    finishRunning: async (_db: unknown, value: unknown) => value,
  } as unknown as import("../../src/agent/power.ts").PowerCoordinator;
  const probe = async () => {
    samples++;
    return {
      readyWalFiles: 0,
      progress: { archivedCount: 0, lastArchivedTime: -1 },
      valid: true as const,
    };
  };
  const observation = await new Reconciler(
    f.k8s,
    new AbortController().signal,
    Date.now,
    exporter,
    authenticate,
    power,
    undefined,
    undefined,
    probe,
  ).reconcile(f.db, f.ctx);
  assert.equal(observation?.state, "ready");
  assert.equal(samples, 1);
  assert.equal(scrapes, 0);
  const logs: {
    event: string;
    fields: Record<string, string | number | boolean>;
  }[] = [];
  const failed = await new Reconciler(
    f.k8s,
    new AbortController().signal,
    Date.now,
    exporter,
    authenticate,
    power,
    (event, fields = {}) => logs.push({ event, fields }),
    undefined,
    async (options) => {
      options.reportFailure?.("binding");
      throw new Error(randomUUID());
    },
  ).reconcile(f.db, f.ctx);
  assert.equal(failed?.state, "ready");
  assert.deepEqual(failed?.archive, {
    continuous: false,
    ready_wal_files: null,
    health: "unknown",
  });
  assert.equal(scrapes, 0);
  assert.deepEqual(
    logs.filter(
      (entry) =>
        entry.event === "wake_archive_transport" ||
        entry.event === "wake_archive_failed",
    ),
    [
      {
        event: "wake_archive_transport",
        fields: { database_id: f.db.id, transport: "sql", reason: "eligible" },
      },
      {
        event: "wake_archive_failed",
        fields: { database_id: f.db.id, stage: "binding" },
      },
    ],
  );
  assert.equal(
    JSON.stringify(logs).includes(f.db.maintenance!.password),
    false,
  );
});
test("a legacy reconciliation still obtains its real exporter sample", async () => {
  const f = await boundFixture();
  delete f.db.power;
  let scrapes = 0,
    sql = 0;
  const exporter: typeof fetch = async (...args) => {
    scrapes++;
    return metrics(...args);
  };
  const observation = await new Reconciler(
    f.k8s,
    new AbortController().signal,
    Date.now,
    exporter,
    authenticate,
    undefined,
    undefined,
    undefined,
    async () => {
      sql++;
      throw new Error("unexpected_SQL");
    },
  ).reconcile(f.db, f.ctx);
  assert.equal(observation?.state, "ready");
  assert.equal(scrapes, 1);
  assert.equal(sql, 0);
});
test("a missing archived count alone is not silently converted into zero", async () => {
  const client = fake({ sample: { archived_count: undefined } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.ended(), 1);
});
test("a wrong session role alone is rejected", async () => {
  const client = fake({ identity: { role: "app" } });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
});
test("the verified primary address must match the actual server", async () => {
  const client = fake({
    identity: { server_address: [10, 20, 0, 2].join(".") },
  });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
});
test("archiver reset remains a real new baseline rather than fabricated health", async () => {
  const client = fake({
      sample: {
        archived_count: "0",
        last_archived_time: "-1",
        ready_wal_files: "4",
      },
    }),
    result = await probeArchive(validOptions(), client.factory);
  assert.deepEqual(result, {
    readyWalFiles: 4,
    progress: { archivedCount: 0, lastArchivedTime: -1 },
    valid: true,
  });
});

test("the identity query requests host notation from PostgreSQL inet before strict Pod-IP comparison", async () => {
  const client = fake({ inetRepresentation: true });
  const result = await probeArchive(validOptions(), client.factory);
  assert.equal(result.readyWalFiles, 4);
  assert.equal(client.ended(), 1);
  assert.deepEqual(client.queries, [ARCHIVE_IDENTITY_QUERY, ARCHIVE_QUERY]);
});
test("CIDR-formatted or arbitrary server input is still refused rather than trimmed", async () => {
  const client = fake({
    identity: { server_address: [10, 20, 0, 1].join(".") + "/32" },
  });
  await assert.rejects(probeArchive(validOptions(), client.factory));
  assert.equal(client.queries.length, 1);
  assert.equal(client.ended(), 1);
});

test("archive selection reports only a fixed future-credential revision reason without credentials", async () => {
  const f = await boundFixture(),
    events: { transport: string; reason: string }[] = [];
  const secret = f.k8s.resources.get(
    f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
  )!;
  secret.metadata.annotations![GENERATION_ANNOTATION] = "3";
  f.db.generation = 2;
  const ns = f.k8s.resources.get(
    f.k8s.key("Namespace", undefined, f.namespace),
  )!;
  ns.metadata.annotations![GENERATION_ANNOTATION] = "2";
  ns.metadata.annotations!["pgcf.io/accepted-generation"] = "2";
  f.cluster.metadata.annotations![GENERATION_ANNOTATION] = "2";
  f.fence.metadata.annotations![GENERATION_ANNOTATION] = "2";
  f.db.power!.revision = 2;
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
    Date.now,
    (transport, reason) => events.push({ transport, reason }),
  );
  assert.equal(options, null);
  assert.deepEqual(events, [
    { transport: "exporter", reason: "maintenance_revision" },
  ]);
  assert.equal(
    JSON.stringify(events).includes(f.db.maintenance!.password),
    false,
  );
});

test("eligible archive selection reports SQL once and ignores a failing diagnostic logger", async () => {
  const f = await boundFixture(),
    events: { transport: string; reason: string }[] = [];
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
    Date.now,
    (transport, reason) => {
      events.push({ transport, reason });
      throw new Error(f.db.maintenance!.password);
    },
  );
  assert.ok(options);
  assert.equal(await options.verifyBinding(), true);
  assert.deepEqual(events, [{ transport: "sql", reason: "eligible" }]);
  assert.equal(
    JSON.stringify(events).includes(f.db.maintenance!.password),
    false,
  );
});

test("a stale local storage fence still refuses SQL and names only its revision predicate", async () => {
  const f = await boundFixture(),
    events: { transport: string; reason: string }[] = [];
  f.db.generation = 2;
  f.fence.metadata.annotations![GENERATION_ANNOTATION] = "1";
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
    Date.now,
    (transport, reason) => events.push({ transport, reason }),
  );
  assert.equal(options, null);
  assert.deepEqual(events, [
    { transport: "exporter", reason: "storage_revision" },
  ]);
});

test("a maintenance password acknowledgment mismatch reports its fixed predicate without an RV", async () => {
  const f = await boundFixture(),
    events: { transport: string; reason: string }[] = [];
  const roles = record(record(f.cluster.status).managedRolesStatus);
  record(record(roles.passwordStatus)[MAINTENANCE_ROLE]).resourceVersion =
    randomUUID();
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
    Date.now,
    (transport, reason) => events.push({ transport, reason }),
  );
  assert.equal(options, null);
  assert.deepEqual(events, [
    { transport: "exporter", reason: "maintenance_ack" },
  ]);
});

test("archive probe failure reports only the fixed identity stage", async () => {
  const events: string[] = [],
    client = fake({ identity: { role: "app" } });
  const value = {
    ...validOptions(),
    reportFailure: (stage: string) => events.push(stage),
  };
  await assert.rejects(probeArchive(value, client.factory), {
    message: "archive_probe_unavailable",
  });
  assert.deepEqual(events, ["identity"]);
  assert.equal(client.ended(), 1);
});

test("archive query failure reports a fixed stage and isolates credential-shaped logger errors", async () => {
  const canary = newRolePassword(),
    events: string[] = [],
    client = fake({ queryError: true });
  await assert.rejects(
    probeArchive(
      {
        ...validOptions(),
        reportFailure: (stage) => {
          events.push(stage);
          throw new Error(canary);
        },
      },
      client.factory,
    ),
    { message: "archive_probe_unavailable" },
  );
  assert.deepEqual(events, ["identity"]);
  assert.equal(JSON.stringify(events).includes(canary), false);
  assert.equal(client.ended(), 1);
  assert.equal(client.queries.length, 1);
});

test("invalid probe configuration and TLS refusal have distinct fixed stages", async () => {
  const configuration: string[] = [],
    tls: string[] = [],
    client = fake({ tls: false });
  await assert.rejects(
    probeArchive(
      {
        ...validOptions(),
        ca: "invalid",
        reportFailure: (stage) => configuration.push(stage),
      },
      client.factory,
    ),
  );
  assert.deepEqual(configuration, ["configuration"]);
  assert.equal(client.configs.length, 0);
  await assert.rejects(
    probeArchive(
      { ...validOptions(), reportFailure: (stage) => tls.push(stage) },
      client.factory,
    ),
  );
  assert.deepEqual(tls, ["tls"]);
  assert.equal(client.ended(), 1);
  assert.equal(client.queries.length, 0);
});

test("archive sample and progress refusals identify the exact validation phase", async () => {
  const sample: string[] = [],
    progress: string[] = [];
  const malformed = fake({ sample: { ready_wal_files: undefined } });
  await assert.rejects(
    probeArchive(
      { ...validOptions(), reportFailure: (stage) => sample.push(stage) },
      malformed.factory,
    ),
  );
  assert.deepEqual(sample, ["sample"]);
  assert.equal(malformed.ended(), 1);
  const future = fake({
    sample: { last_archived_time: String(Date.now() / 1000 + 600) },
  });
  await assert.rejects(
    probeArchive(
      { ...validOptions(), reportFailure: (stage) => progress.push(stage) },
      future.factory,
    ),
  );
  assert.deepEqual(progress, ["progress"]);
  assert.equal(future.ended(), 1);
});

test("archive binding refusal identifies its phase while a valid sample emits no failure event", async () => {
  const events: string[] = [],
    client = fake();
  const value = {
    ...validOptions(),
    reportFailure: (stage: string) => events.push(stage),
  };
  const result = await probeArchive(value, client.factory);
  assert.equal(result.valid, true);
  assert.deepEqual(events, []);
  await assert.rejects(
    probeArchive(
      { ...value, verifyBinding: async () => false },
      client.factory,
    ),
  );
  assert.deepEqual(events, ["binding"]);
  assert.equal(client.ended(), 2);
});

test("expired and aborted probes report bounded deadline failures and retain cleanup", async () => {
  const events: string[] = [],
    abort = new AbortController(),
    client = fake({ abort });
  const value = {
    ...validOptions(),
    reportFailure: (stage: string) => events.push(stage),
  };
  await assert.rejects(
    probeArchive({ ...value, deadline: Date.now() - 1 }, client.factory),
  );
  assert.deepEqual(events, ["deadline"]);
  assert.equal(client.configs.length, 0);
  await assert.rejects(
    probeArchive({ ...value, signal: abort.signal }, client.factory),
  );
  assert.deepEqual(events, ["deadline", "deadline"]);
  assert.equal(client.ended(), 1);
  assert.ok(client.destroyed() >= 1);
});

test("an archive connection exception reports connect without its message or a query retry", async () => {
  const events: string[] = [],
    client = fake(),
    canary = newRolePassword();
  const factory = (config: ClientConfig) => {
    const value = client.factory(config);
    value.connect = async () => {
      throw new Error(canary);
    };
    return value;
  };
  await assert.rejects(
    probeArchive(
      { ...validOptions(), reportFailure: (stage) => events.push(stage) },
      factory,
    ),
    { message: "archive_probe_unavailable" },
  );
  assert.deepEqual(events, ["connect"]);
  assert.equal(JSON.stringify(events).includes(canary), false);
  assert.equal(client.ended(), 1);
  assert.equal(client.queries.length, 0);
});

test("an unchanged older-positive maintenance Secret remains SQL-eligible only with its exact current RV acknowledgment", async () => {
  const f = await boundFixture();
  f.db.generation = 2;
  f.db.power!.revision = 2;
  const ns = f.k8s.resources.get(
    f.k8s.key("Namespace", undefined, f.namespace),
  )!;
  ns.metadata.annotations![GENERATION_ANNOTATION] = "2";
  ns.metadata.annotations!["pgcf.io/accepted-generation"] = "2";
  f.cluster.metadata.annotations![GENERATION_ANNOTATION] = "2";
  f.k8s.resources.set(
    f.k8s.key("Cluster", f.namespace, "database"),
    structuredClone(f.cluster),
  );
  f.fence.metadata.annotations![GENERATION_ANNOTATION] = "2";
  f.k8s.resources.set(
    f.k8s.key("ConfigMap", "pgcf-system", f.fence.metadata.name),
    structuredClone(f.fence),
  );
  const secret = f.k8s.resources.get(
    f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
  )!;
  assert.equal(secret.metadata.annotations![GENERATION_ANNOTATION], "1");
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
  );
  assert.ok(options);
  assert.equal(await options.verifyBinding(), true);
  const ack = record(
    record(record(f.cluster.status).managedRolesStatus).passwordStatus,
  );
  record(ack[MAINTENANCE_ROLE]).resourceVersion = randomUUID();
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
});

test("missing and zero maintenance credential generations cannot select SQL", async () => {
  const f = await boundFixture(),
    secret = f.k8s.resources.get(
      f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
    )!;
  delete secret.metadata.annotations![GENERATION_ANNOTATION];
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
  secret.metadata.annotations![GENERATION_ANNOTATION] = "0";
  await assert.rejects(
    archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    { message: "applied_generation_invalid" },
  );
});

test("older credential-generation eligibility never accepts changed data or replaced identity", async () => {
  const f = await boundFixture();
  const options = await archiveProbeOptions(
    f.db,
    f.cluster,
    f.fence,
    f.k8s,
    new AbortController().signal,
  );
  assert.ok(options);
  const secret = f.k8s.resources.get(
    f.k8s.key("Secret", f.namespace, "maintenance-credentials"),
  )!;
  record(secret.data).password =
    Buffer.from(newRolePassword()).toString("base64");
  assert.equal(
    await archiveProbeOptions(
      f.db,
      f.cluster,
      f.fence,
      f.k8s,
      new AbortController().signal,
    ),
    null,
  );
  assert.equal(await options.verifyBinding(), false);
  record(secret.data).password = Buffer.from(
    f.db.maintenance!.password,
  ).toString("base64");
  secret.metadata.uid = randomUUID();
  assert.equal(await options.verifyBinding(), false);
});
