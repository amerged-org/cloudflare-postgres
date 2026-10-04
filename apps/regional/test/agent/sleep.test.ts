// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Socket } from "node:net";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import { newDatabaseId, newOperationId } from "@pgcf/contracts";
import {
  MAINTENANCE_ROLE,
  SLEEP_BOOTSTRAP_GRANTS,
  probeSleepSafety,
  resumeSleepSafety,
} from "../../src/agent/sleep.ts";
import type {
  SleepClientFactory,
  SleepProbeOptions,
} from "../../src/agent/sleep.ts";

const execute = promisify(execFile);
const IMAGE =
  "ghcr.io/cloudnative-pg/postgresql:18.4-standard-trixie@sha256:ebf3919504d7523a63e8e2fee9b051211de714644b36469275558c624afd50ec";
const databaseId = newDatabaseId();
const host = `database-rw.pgcf-db-${databaseId}.svc`;
const loopback = [127, 0, 0, 1].join(".");
const folder = resolve(
  import.meta.dirname,
  "../../../../.local/spikes/sleep-probe",
  randomUUID(),
);
const container = `pgcf-sleep-${randomBytes(6).toString("hex")}`;
const adminPassword = randomBytes(32).toString("base64url");
const maintenancePassword = randomBytes(32).toString("base64url");
const customerPassword = randomBytes(32).toString("base64url");
const clients = new Set<Client>();
let admin: Client;
let ca: string;
let otherCa: string;
let port: number;
let running = false;
async function command(program: string, args: string[]): Promise<string> {
  try {
    return (
      await execute(program, args, { timeout: 60000, maxBuffer: 1024 * 1024 })
    ).stdout;
  } catch {
    throw new Error("sleep_fixture_command_failed");
  }
}
function localClient(config: ClientConfig): Client {
  const socket = new Socket();
  const connect = socket.connect.bind(socket);
  socket.connect = (() =>
    connect({ host: loopback, port })) as typeof socket.connect;
  const client = new Client({ ...config, stream: () => socket });
  client.on("error", () => {});
  clients.add(client);
  return client;
}
async function connection(
  user: string,
  password: string,
  db = databaseId,
): Promise<Client> {
  const client = localClient({
    host,
    port: 5432,
    database: db,
    user,
    password,
    connectionTimeoutMillis: 5000,
    ssl: { ca, servername: host, rejectUnauthorized: true },
  });
  await client.connect();
  return client;
}
async function finish(client: Client): Promise<void> {
  await client.end();
  clients.delete(client);
}
async function sql(statement: string, values?: unknown[]): Promise<unknown> {
  return admin.query(statement, values);
}
async function archive(enabled: boolean) {
  await command("docker", [
    "exec",
    "--user",
    "26",
    container,
    "sh",
    "-c",
    enabled ? "touch /tmp/archive-enabled" : "rm -f /tmp/archive-enabled",
  ]);
}
function options(duration = 8000): SleepProbeOptions {
  const operation = newOperationId();
  const gatewayPods = [randomUUID(), randomUUID()];
  const value: SleepProbeOptions = {
    databaseId,
    namespace: `pgcf-db-${databaseId}`,
    credentials: { user: MAINTENANCE_ROLE, password: maintenancePassword },
    ca,
    signal: new AbortController().signal,
    deadline: Date.now() + duration,
    quiescence: { operation, revision: 1, gatewayPods },
    verifyQuiescence: async () =>
      gatewayPods.map((pod) => ({
        database: databaseId,
        operation,
        revision: 1,
        mode: "quiesce",
        pod,
        status: "idle",
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      })),
  };
  return value;
}
function tracked(
  change?: (statement: string, result: unknown, client: Client) => unknown,
): { factory: SleepClientFactory; queries: string[]; created: Client[] } {
  const queries: string[] = [];
  const created: Client[] = [];
  return {
    queries,
    created,
    factory: (config) => {
      assert.equal(config.host, host);
      assert.equal(config.port, 5432);
      assert.equal(config.database, databaseId);
      assert.equal(config.user, MAINTENANCE_ROLE);
      assert.equal(
        (config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
        true,
      );
      const client = localClient(config);
      created.push(client);
      const query = client.query.bind(client);
      client.query = (async (...args: unknown[]) => {
        const statement = String(args[0]);
        queries.push(statement);
        const result = await Reflect.apply(query, client, args);
        return change ? change(statement, result, client) : result;
      }) as typeof client.query;
      return client;
    },
  };
}
const switches = (queries: string[]) =>
  queries.filter((query) => query.includes("pg_catalog.pg_switch_wal()"))
    .length;
async function assertClosed(created: Client[]) {
  for (const client of created) {
    assert.equal(client.connection.stream.destroyed, true);
    clients.delete(client);
  }
}

before(
  async () => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const [suffix, name] of [
      ["", host],
      ["other", `other-${host}`],
    ]) {
      await command("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${name}`,
        "-addext",
        `subjectAltName=DNS:${name}`,
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        resolve(folder, `server-secret${suffix}`),
        "-out",
        resolve(folder, `server-certificate${suffix}`),
      ]);
    }
    ca = await readFile(resolve(folder, "server-certificate"), "utf8");
    otherCa = await readFile(
      resolve(folder, "server-certificateother"),
      "utf8",
    );
    await writeFile(resolve(folder, "admin-password"), adminPassword, {
      mode: 0o600,
    });
    await writeFile(
      resolve(folder, "archive-command"),
      `while [ ! -f /tmp/archive-enabled ]; do sleep 0.05; done
cp "$1" "/tmp/archive/$2"
`,
      { mode: 0o644 },
    );
    await writeFile(
      resolve(folder, "configuration"),
      [
        "listen_addresses='*'",
        "ssl=on",
        "ssl_cert_file='/tmp/server-certificate'",
        "ssl_key_file='/tmp/server-secret'",
        "archive_mode=on",
        "archive_command='/bin/sh /tmp/archive-command %p %f'",
        "max_prepared_transactions=8",
        "autovacuum=off",
        "shared_buffers='32MB'",
        "",
      ].join("\n"),
      { mode: 0o644 },
    );
    const script = [
      "set -eu",
      "install -d -m700 -o26 -g102 /tmp/pgdata /tmp/archive",
      "install -m600 -o26 -g102 /fixture/server-secret /tmp/server-secret",
      "install -m644 -o26 -g102 /fixture/server-certificate /tmp/server-certificate",
      "install -m600 -o26 -g102 /fixture/admin-password /tmp/init-password",
      "install -m644 -o26 -g102 /fixture/archive-command /tmp/archive-command",
      "runuser -u postgres -- initdb -D /tmp/pgdata --auth-local=trust --auth-host=scram-sha-256 --pwfile=/tmp/init-password >/dev/null",
      "cat /fixture/configuration >> /tmp/pgdata/postgresql.conf",
      "printf '%s\\n' 'hostssl all all all scram-sha-256' >> /tmp/pgdata/pg_hba.conf",
      "exec runuser -u postgres -- postgres -D /tmp/pgdata",
    ].join("\n");
    await command("docker", [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--detach",
      "--user",
      "0",
      "--name",
      container,
      "--publish",
      `${loopback}::5432`,
      "--volume",
      `${folder}:/fixture:ro`,
      IMAGE,
      "/bin/sh",
      "-c",
      script,
    ]);
    running = true;
    const inspection = JSON.parse(
      await command("docker", ["inspect", container]),
    ) as {
      NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
    }[];
    port = Number(
      inspection[0]!.NetworkSettings.Ports["5432/tcp"]![0]!.HostPort,
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await command("docker", [
          "exec",
          "--user",
          "26",
          container,
          "pg_isready",
          "-U",
          "postgres",
        ]);
        break;
      } catch {
        if (attempt === 99) throw new Error("sleep_fixture_start_failed");
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    admin = await connection("postgres", adminPassword, "postgres");
    await sql(`CREATE DATABASE "${databaseId}"`);
    await finish(admin);
    admin = await connection("postgres", adminPassword);
    for (const grant of SLEEP_BOOTSTRAP_GRANTS) await sql(grant);
    await sql(`ALTER ROLE pgcf_maintenance PASSWORD '${maintenancePassword}'`);
    await sql(`CREATE ROLE customer LOGIN PASSWORD '${customerPassword}'`);
    await archive(true);
  },
  { timeout: 60000 },
);
after(async () => {
  for (const client of clients) {
    client.connection.stream.destroy();
    await client.end().catch(() => {});
  }
  clients.clear();
  if (running) await command("docker", ["rm", "--force", container]);
  await rm(folder, { recursive: true, force: true });
});

async function holdActive(client: Client): Promise<() => Promise<void>> {
  const pid = (await client.query("SELECT pg_catalog.pg_backend_pid() AS pid"))
    .rows[0].pid;
  const lock = Number.parseInt(randomBytes(4).toString("hex"), 16);
  await admin.query("SELECT pg_catalog.pg_advisory_lock($1::pg_catalog.int8)", [
    lock,
  ]);
  const pending = client.query(
    "SELECT pg_catalog.pg_advisory_lock($1::pg_catalog.int8)",
    [lock],
  );
  const release = async () => {
    await admin.query(
      "SELECT pg_catalog.pg_advisory_unlock($1::pg_catalog.int8)",
      [lock],
    );
    await pending;
  };
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      const row = (
        await admin.query(
          "SELECT state,wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1",
          [pid],
        )
      ).rows[0];
      if (row?.state === "active" && row.wait_event_type === "Lock")
        return release;
      if (Date.now() >= deadline)
        throw new Error("sleep_fixture_active_failed");
      await new Promise((done) => setTimeout(done, 10));
    }
  } catch (error) {
    await release();
    throw error;
  }
}

async function workBlocks(
  kind: "active" | "idle_transaction" | "aborted_transaction" | "prepared",
) {
  const customer = await connection("customer", customerPassword);
  const probe = tracked();
  let release: (() => Promise<void>) | undefined;
  try {
    if (kind === "active") {
      release = await holdActive(customer);
    } else if (kind === "prepared")
      await customer.query(
        "BEGIN; SELECT 1; PREPARE TRANSACTION 'sleep_fixture_prepared'",
      );
    else {
      await customer.query("BEGIN");
      if (kind === "aborted_transaction")
        await customer.query("SELECT 1/0").catch(() => {});
    }
    const result = await probeSleepSafety(options(), probe.factory);
    assert.equal(result.safe, false);
    if (!result.safe)
      assert.equal(
        result.reason,
        kind === "prepared" ? "prepared_work" : "sql_busy",
      );
    assert.equal(switches(probe.queries), 0);
    await assertClosed(probe.created);
  } finally {
    if (release) await release();
    if (kind === "prepared")
      await sql("ROLLBACK PREPARED 'sleep_fixture_prepared'");
    else await customer.query("ROLLBACK");
    await finish(customer);
  }
}

test("active work blocks before WAL switch", () => workBlocks("active"));
test("idle-in-transaction work blocks before WAL switch", () =>
  workBlocks("idle_transaction"));
test("aborted transaction work blocks before WAL switch", () =>
  workBlocks("aborted_transaction"));
test("prepared work blocks before WAL switch", () => workBlocks("prepared"));

test("same-role other maintenance backend is not excluded as the current probe", async () => {
  const other = await connection(MAINTENANCE_ROLE, maintenancePassword);
  const release = await holdActive(other);
  const probe = tracked();
  try {
    assert.deepEqual(await probeSleepSafety(options(), probe.factory), {
      safe: false,
      reason: "sql_busy",
    });
    assert.equal(switches(probe.queries), 0);
    await assertClosed(probe.created);
  } finally {
    await release();
    await finish(other);
  }
});

test("unknown SQL stat fields fail closed without switching WAL", async () => {
  const probe = tracked((statement, result) =>
    statement.includes("AS busy")
      ? { rows: [{ busy: null, prepared: 0 }] }
      : result,
  );
  assert.deepEqual(await probeSleepSafety(options(), probe.factory), {
    safe: false,
    reason: "sql_unknown",
  });
  assert.equal(switches(probe.queries), 0);
  await assertClosed(probe.created);
});

test("exact archived segment and an actual no-activity switch boundary are safe", async () => {
  const observed: { lsn: string; segment: string }[] = [];
  let primed = false;
  const probe = tracked(async (statement, result) => {
    if (!primed && statement.includes("AS busy")) {
      // Prime a real segment boundary after all connection/catalog reads.
      await admin.query("SELECT pg_catalog.pg_switch_wal()");
      primed = true;
    }
    if (statement.includes("pg_catalog.pg_switch_wal()"))
      observed.push(
        (result as { rows: { lsn: string; segment: string }[] }).rows[0]!,
      );
    return result;
  });
  const result = await probeSleepSafety(options(), probe.factory);
  assert.equal(result.safe, true);
  assert.equal(switches(probe.queries), 1);
  await assertClosed(probe.created);
  assert.equal(observed.length, 1);
  const actual = observed[0]!;
  const [high, low] = actual.lsn.split("/");
  const location = (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  assert.equal(location % BigInt(16 * 1024 * 1024), 0n);
  const closed = location - 1n;
  const expected =
    `00000001${(closed >> 32n).toString(16).padStart(8, "0")}${((closed & 0xffffffffn) >> 24n).toString(16).padStart(8, "0")}`.toUpperCase();
  assert.equal(actual.segment, expected);
  if (result.safe) assert.equal(result.segment, expected);
});

test("an actually held archiver is never acknowledged; known exact segment resumes without another switch", async () => {
  await archive(false);
  await sql(
    "CREATE TABLE IF NOT EXISTS public.sleep_fixture_write (id integer)",
  );
  await sql("INSERT INTO public.sleep_fixture_write VALUES (1)");
  const probe = tracked();
  let result;
  try {
    result = await probeSleepSafety(options(1500), probe.factory);
    assert.equal(result.safe, false);
    if (!result.safe) assert.equal(result.reason, "archive_timeout");
    assert.equal(switches(probe.queries), 1);
    assert.ok(result.segment);
    await assertClosed(probe.created);
  } finally {
    await archive(true);
  }
  const resumed = tracked();
  assert.equal(
    (await resumeSleepSafety(options(), result!.segment!, resumed.factory))
      .safe,
    true,
  );
  assert.equal(switches(resumed.queries), 0);
  await assertClosed(resumed.created);
});

test("lost switch result is unknown and never replayed", async () => {
  const probe = tracked((statement, result) => {
    if (statement.includes("pg_catalog.pg_switch_wal()"))
      throw new Error(randomBytes(32).toString("hex"));
    return result;
  });
  assert.deepEqual(await probeSleepSafety(options(), probe.factory), {
    safe: false,
    reason: "switch_unknown",
  });
  assert.equal(switches(probe.queries), 1);
  await assertClosed(probe.created);
});

test("all-gateway fence mismatch before barrier and after archive refuses safe result", async () => {
  const before = options();
  const read = before.verifyQuiescence;
  let calls = 0;
  before.verifyQuiescence = async (signal) => {
    const reports = (await read(signal)) as { operation: string }[];
    if (++calls === 2) reports[0]!.operation = newOperationId();
    return reports;
  };
  const probe = tracked();
  assert.deepEqual(await probeSleepSafety(before, probe.factory), {
    safe: false,
    reason: "not_quiescent",
  });
  assert.equal(switches(probe.queries), 0);
  await assertClosed(probe.created);
  const after = options();
  const original = after.verifyQuiescence;
  calls = 0;
  after.verifyQuiescence = async (signal) => {
    const reports = (await original(signal)) as { pendingDials: number }[];
    if (++calls === 3) reports[0]!.pendingDials = 1;
    return reports;
  };
  const late = tracked();
  const result = await probeSleepSafety(after, late.factory);
  assert.equal(result.safe, false);
  if (!result.safe) assert.equal(result.reason, "not_quiescent");
  assert.equal(switches(late.queries), 1);
  await assertClosed(late.created);
});

test("public function shadowing cannot manufacture archive success", async () => {
  await sql(
    "CREATE OR REPLACE FUNCTION public.pg_switch_wal() RETURNS pg_catalog.pg_lsn LANGUAGE SQL AS 'SELECT ''0/0''::pg_catalog.pg_lsn'",
  );
  await sql(
    "CREATE OR REPLACE FUNCTION public.pg_ls_archive_statusdir() RETURNS TABLE(name text) LANGUAGE SQL AS 'SELECT ''000000010000000000000001.done''::text'",
  );
  const probe = tracked();
  assert.equal((await probeSleepSafety(options(), probe.factory)).safe, true);
  await assertClosed(probe.created);
  assert.ok(probe.queries.every((statement) => !statement.includes("public.")));
});

async function failedConnection(
  change: "ca" | "password" | "switch_grant" | "archive_grant" | "abort",
) {
  const value = options();
  const probe = tracked();
  if (change === "ca") value.ca = otherCa;
  if (change === "password")
    value.credentials.password = randomBytes(32).toString("hex");
  const grant =
    change === "switch_grant"
      ? "pg_switch_wal"
      : change === "archive_grant"
        ? "pg_ls_archive_statusdir"
        : undefined;
  if (grant)
    await sql(
      `REVOKE EXECUTE ON FUNCTION pg_catalog.${grant}() FROM pgcf_maintenance`,
    );
  if (change === "abort") {
    const controller = new AbortController();
    controller.abort();
    value.signal = controller.signal;
  }
  try {
    const result = await probeSleepSafety(value, probe.factory);
    assert.equal(result.safe, false);
    if (!result.safe)
      assert.equal(
        result.reason,
        change === "switch_grant"
          ? "switch_unknown"
          : change === "abort"
            ? "aborted"
            : "probe_unavailable",
      );
    assert.equal(
      JSON.stringify(result).includes(value.credentials.password),
      false,
    );
    await assertClosed(probe.created);
  } finally {
    if (grant)
      await sql(
        `GRANT EXECUTE ON FUNCTION pg_catalog.${grant}() TO pgcf_maintenance`,
      );
  }
}
test("untrusted TLS CA fails closed and releases its client", () =>
  failedConnection("ca"));
test("invalid maintenance authentication fails without credential diagnostics", () =>
  failedConnection("password"));
test("missing WAL switch privilege refuses and releases its client", () =>
  failedConnection("switch_grant"));
test("missing archive listing privilege refuses after recording the segment", () =>
  failedConnection("archive_grant"));
test("caller abort before connect never creates a client", () =>
  failedConnection("abort"));

test("interrupted recorded barrier resumes its exact segment without replay", async () => {
  const value = options();
  const controller = new AbortController();
  value.signal = controller.signal;
  let recorded: string | undefined;
  value.onClosedSegment = async (segment) => {
    recorded = segment;
    controller.abort();
  };
  const probe = tracked();
  const result = await probeSleepSafety(value, probe.factory);
  assert.equal(result.safe, false);
  if (!result.safe) assert.equal(result.reason, "aborted");
  assert.equal(result.segment, recorded);
  assert.equal(switches(probe.queries), 1);
  await assertClosed(probe.created);
  const resumed = tracked();
  assert.equal(
    (await resumeSleepSafety(options(), recorded!, resumed.factory)).safe,
    true,
  );
  assert.equal(switches(resumed.queries), 0);
  await assertClosed(resumed.created);
});

test("SQL safety is observed again after the exact archive acknowledgement", async () => {
  const customer = await connection("customer", customerPassword);
  const value = options();
  value.onClosedSegment = async () => {
    await customer.query("BEGIN");
  };
  const probe = tracked();
  try {
    const result = await probeSleepSafety(value, probe.factory);
    assert.equal(result.safe, false);
    if (!result.safe) assert.equal(result.reason, "sql_busy");
    assert.equal(switches(probe.queries), 1);
    await assertClosed(probe.created);
  } finally {
    await customer.query("ROLLBACK");
    await finish(customer);
  }
});

test("a different archived filename cannot acknowledge the resumed segment", async () => {
  const absent = "FFFFFFFFFFFFFFFFFFFFFFFF";
  const probe = tracked();
  assert.deepEqual(
    await resumeSleepSafety(options(800), absent, probe.factory),
    { safe: false, reason: "archive_timeout", segment: absent },
  );
  assert.equal(switches(probe.queries), 0);
  await assertClosed(probe.created);
});

test("invalid resume data is refused without echoing it", async () => {
  const canary = randomBytes(32).toString("base64url");
  const probe = tracked();
  assert.deepEqual(await resumeSleepSafety(options(), canary, probe.factory), {
    safe: false,
    reason: "invalid_input",
  });
  assert.equal(probe.created.length, 0);
});

test("input and full gateway-pod inventory cannot select external or customer targets", async () => {
  const probe = tracked();
  const value = options();
  value.namespace = "external";
  assert.deepEqual(await probeSleepSafety(value, probe.factory), {
    safe: false,
    reason: "invalid_input",
  });
  const customer = options();
  customer.credentials.user = "customer";
  assert.deepEqual(await probeSleepSafety(customer, probe.factory), {
    safe: false,
    reason: "invalid_input",
  });
  const partial = options();
  partial.verifyQuiescence = async () => [];
  assert.deepEqual(await probeSleepSafety(partial, probe.factory), {
    safe: false,
    reason: "not_quiescent",
  });
  assert.equal(probe.created.length, 0);
  assert.equal(
    SLEEP_BOOTSTRAP_GRANTS.some((sql) =>
      /PASSWORD|pg_monitor|pg_read_server_files|CHECKPOINT/.test(sql),
    ),
    false,
  );
});

test("the matching gateway inventory cannot change during a probe", async () => {
  const value = options();
  const original = value.verifyQuiescence;
  const replacement = randomUUID();
  let calls = 0;
  value.verifyQuiescence = async (signal) => {
    if (++calls === 1) return original(signal);
    value.quiescence.revision = 2;
    value.quiescence.gatewayPods = [replacement];
    return [
      {
        database: databaseId,
        operation: value.quiescence.operation,
        revision: 2,
        mode: "quiesce",
        pod: replacement,
        status: "idle",
        connections: 0,
        busyConnections: 0,
        pendingDials: 0,
      },
    ];
  };
  const probe = tracked();
  assert.deepEqual(await probeSleepSafety(value, probe.factory), {
    safe: false,
    reason: "not_quiescent",
  });
  assert.equal(switches(probe.queries), 0);
  await assertClosed(probe.created);
});

test("the connected session must actually be the internal maintenance role", async () => {
  const created: Client[] = [];
  const factory: SleepClientFactory = (config) => {
    const client = localClient({
      ...config,
      user: "postgres",
      password: adminPassword,
    });
    created.push(client);
    return client;
  };
  assert.deepEqual(await probeSleepSafety(options(), factory), {
    safe: false,
    reason: "probe_unavailable",
  });
  await assertClosed(created);
});
