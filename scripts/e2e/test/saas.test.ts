// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GATE_MS,
  STATEMENT_NAMES,
  buildRequest,
  datasetSize,
  parseCommand,
  percentile,
  requestsUntilWarm,
  setupStatements,
  summarize,
  timeCall,
  type Session,
  type Timed,
} from "../src/saas.ts";

const database = "d" + "a".repeat(19);
const other = "d" + "b".repeat(19);

test("percentiles are nearest rank, and none for no samples", () => {
  const ten = [9, 1, 8, 2, 7, 3, 6, 4, 5, 10];
  assert.equal(percentile(ten, 0.5), 5);
  assert.equal(percentile(ten, 0.95), 10);
  assert.equal(percentile(ten, 0.1), 1);
  assert.equal(percentile([7], 0.95), 7);
  assert.equal(percentile([], 0.5), null);
  // The samples are not reordered.
  assert.deepEqual(ten.slice(0, 3), [9, 1, 8]);
});

const done = (request: number, connect = 100, first = 300): Timed => ({
  ok: true,
  connect_ms: connect,
  first_answer_ms: first,
  request_ms: request,
  statements_ms: [1, 2, 3, 4, 5],
});

test("a summary counts failures apart and meets the gate only without one", () => {
  const calls = Array.from({ length: 20 }, (_, index) => done(500 + index));
  const summary = summarize(calls);
  assert.deepEqual(summary.request_ms, { p50: 509, p95: 518 });
  assert.equal(summary.calls, 20);
  assert.equal(summary.failures, 0);
  assert.equal(summary.gate_met, true);
  // The slowest 5 % set the p95: two slow calls among twenty-two.
  const slow = summarize([...calls, done(GATE_MS + 1), done(GATE_MS + 2)]);
  assert.equal(slow.request_ms.p95, GATE_MS + 1);
  assert.equal(slow.gate_met, false);
  // A failed call carries no timings into the percentiles, and the gate is lost.
  const failed = summarize([
    ...calls,
    { ok: false, statements_ms: [], failed_at: "connect" },
  ]);
  assert.equal(failed.failures, 1);
  assert.deepEqual(failed.request_ms, summary.request_ms);
  assert.equal(failed.gate_met, false);
  const none = summarize([]);
  assert.equal(none.request_ms.p95, null);
  assert.equal(none.gate_met, false);
});

test("requests until warm counts to the first one within a quarter of the warm median", () => {
  assert.equal(requestsUntilWarm([900, 400, 300, 280, 290, 285]), 3);
  assert.equal(requestsUntilWarm([300, 290, 310, 295]), 1);
  // 357 is just over 285 * 1.25.
  assert.equal(requestsUntilWarm([900, 357, 285, 285], 0.25), 3);
  assert.equal(requestsUntilWarm([900]), null);
  assert.equal(requestsUntilWarm([]), null);
});

test("the dataset keeps a full list page in every project at any scale", () => {
  assert.deepEqual(datasetSize(1), {
    accounts: 2000,
    users: 100000,
    sessions: 300000,
    projects: 10000,
    tasks: 600000,
  });
  for (const scale of [0.0001, 0.01, 0.5, 2]) {
    const size = datasetSize(scale);
    assert.equal(size.tasks, size.projects * 60);
    assert.ok(size.projects >= 100 && size.users >= 10 && size.accounts >= 3);
  }
  for (const scale of [0, -1, Number.NaN, Infinity, 11])
    assert.throws(() => datasetSize(scale), RangeError);
});

test("a request is five statements in the plan's order, fixed by seed and call", () => {
  const request = buildRequest(7, 3, 1);
  assert.deepEqual(
    request.map((statement) => statement.name),
    [...STATEMENT_NAMES],
  );
  assert.deepEqual(request, buildRequest(7, 3, 1));
  assert.notDeepEqual(request, buildRequest(7, 4, 1));
  assert.notDeepEqual(request, buildRequest(8, 3, 1));
  assert.deepEqual(
    request.map((statement) => statement.rows),
    [1, 50, 4, 1, 0],
  );
  // The transaction opens in the insert's message and closes in the update's: five round trips.
  assert.match(request[3]!.sql, /^BEGIN; INSERT INTO tasks/);
  assert.match(request[4]!.sql, /; COMMIT$/);
});

test("the keys of a request lie inside the dataset, and no text but numbers is interpolated", () => {
  for (const scale of [1, 0.01]) {
    const size = datasetSize(scale);
    for (let call = 0; call < 500; call++) {
      const [auth, list, counts, insert, update] = buildRequest(1, call, scale);
      const session = Number(/md5\('(\d+)'\)/.exec(auth!.sql)![1]);
      const project = Number(/project_id = (\d+) ORDER/.exec(list!.sql)![1]);
      const task = Number(/WHERE id = (\d+);/.exec(update!.sql)![1]);
      assert.ok(session >= 1 && session <= size.sessions);
      assert.ok(project >= 1 && project <= size.projects);
      assert.ok(task >= 1 && task <= size.tasks);
      assert.match(counts!.sql, new RegExp(`project_id = ${project} GROUP`));
      assert.match(insert!.sql, new RegExp(`VALUES \\(${project}, \\d+,`));
    }
  }
});

test("the setup creates the five tables before it seeds, vacuums last, and rejects a bad scale", () => {
  const statements = setupStatements(0.01);
  assert.match(statements[0]!, /^DROP TABLE IF EXISTS/);
  assert.equal(statements.at(-1), "VACUUM (ANALYZE)");
  for (const table of ["accounts", "users", "sessions", "projects", "tasks"]) {
    const create = statements.findIndex((s) =>
      s.startsWith(`CREATE TABLE ${table}(`),
    );
    const seed = statements.findIndex((s) =>
      s.startsWith(`INSERT INTO ${table}`),
    );
    assert.ok(create >= 0 && seed > create, table);
  }
  assert.throws(() => setupStatements(0), RangeError);
});

function session(
  script: (sql: string) => number | Error,
  ended: string[] = [],
): Session {
  return {
    query: async (sql) => {
      const answer = script(sql);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    end: async () => void ended.push("end"),
  };
}

function clock(): () => number {
  let now = 0;
  return () => (now += 10);
}

test("a call times the connection, the first answer, the request and each statement", async () => {
  const statements = buildRequest(1, 1, 1);
  const ended: string[] = [];
  const timed = await timeCall(
    async () => ({
      ...session((sql) => statements.find((s) => s.sql === sql)!.rows, ended),
      socketOpenedAt: 25,
    }),
    statements,
    clock(),
  );
  // The clock moves 10 ms per reading: start at 10, connected at 20, then a send and an answer
  // for each statement, and a last reading for the request.
  assert.deepEqual(timed, {
    ok: true,
    connect_ms: 10,
    ws_open_ms: 15,
    first_answer_ms: 30,
    request_ms: 120,
    statements_ms: [10, 10, 10, 10, 10],
  });
  assert.deepEqual(ended, ["end"]);
});

test("a call that cannot connect, or fails a statement, says where and keeps no message text", async () => {
  const statements = buildRequest(1, 1, 1);
  const refused = Object.assign(new Error("password for user app is wrong"), {
    code: "28P01",
  });
  const noConnection = await timeCall(
    async () => {
      throw refused;
    },
    statements,
    clock(),
  );
  assert.equal(noConnection.ok, false);
  assert.equal(noConnection.failed_at, "connect");
  assert.deepEqual(noConnection.error, {
    error_class: "Error",
    sqlstate: "28P01",
    errno: null,
  });
  assert.doesNotMatch(JSON.stringify(noConnection), /password/);
  const ended: string[] = [];
  const broken = await timeCall(
    async () =>
      session(
        (sql) =>
          sql.startsWith("SELECT id, title")
            ? Object.assign(new Error("boom"), { code: "57014" })
            : 1,
        ended,
      ),
    statements,
    clock(),
  );
  assert.equal(broken.ok, false);
  assert.equal(broken.failed_at, "list");
  assert.equal(broken.error?.sqlstate, "57014");
  assert.equal(broken.statements_ms.length, 1);
  assert.equal(broken.request_ms, undefined);
  // The first answer was given before the failure.
  assert.equal(broken.first_answer_ms, 30);
  assert.deepEqual(ended, ["end"]);
});

test("a result of the wrong size fails the call: a missing dataset must not pass for a fast one", async () => {
  const statements = buildRequest(1, 1, 1);
  const timed = await timeCall(
    async () => session((sql) => (sql.startsWith("SELECT id, title") ? 12 : 1)),
    statements,
    clock(),
  );
  assert.equal(timed.ok, false);
  assert.equal(timed.failed_at, "list");
  assert.equal(timed.error?.error_class, "UnexpectedResult");
});

test("the command line is read into one of three commands, or refused", () => {
  assert.deepEqual(parseCommand(["setup", "--database", database]), {
    command: "setup",
    database,
    scale: 1,
  });
  assert.deepEqual(
    parseCommand(["call", "--database", database, "--idle-s", "3600"]),
    {
      command: "call",
      database,
      via: "local",
      seed: 1,
      scale: 1,
      idleS: 3600,
      followups: 0,
    },
  );
  assert.deepEqual(
    parseCommand([
      "run",
      "--databases",
      `${database},${other}`,
      "--rounds",
      "5",
      "--idle-s",
      "7200",
      "--followups",
      "9",
      "--parallel",
      "--via",
      "probe",
      "--seed",
      "42",
      "--scale",
      "0.5",
    ]),
    {
      command: "run",
      databases: [database, other],
      rounds: 5,
      idleS: 7200,
      followups: 9,
      parallel: true,
      via: "probe",
      seed: 42,
      scale: 0.5,
    },
  );
  const refused = [
    [],
    ["bench"],
    ["call"],
    ["call", "--database", "not-an-id"],
    ["call", "--database", database, "--idle-s", "-1"],
    ["call", "--database", database, "--idle-s", "1.5"],
    ["call", "--database", database, "--via", "tunnel"],
    ["call", "--database", database, "--database", database],
    ["call", "--database", database, "--rounds", "2"],
    ["call", "--database", database, "extra"],
    ["call", "--database", database, "--idle-s"],
    ["call", "--database", database, "--scale", "0"],
    ["setup", "--database", database, "--idle-s", "1"],
    ["run", "--databases", database, "--idle-s", "1"],
    ["run", "--databases", database, "--rounds", "0", "--idle-s", "1"],
    [
      "run",
      "--databases",
      `${database},${database}`,
      "--rounds",
      "1",
      "--idle-s",
      "1",
    ],
    ["run", "--databases", `${database},x`, "--rounds", "1", "--idle-s", "1"],
    ["run", "--databases", database, "--rounds", "1"],
  ];
  for (const argv of refused)
    assert.throws(() => parseCommand(argv), /./, JSON.stringify(argv));
});

/** The binaries of a PostgreSQL 18 for the test, or none: CI requires them, a laptop may skip. */
function postgresBinaries(): string | null {
  const directory = process.env.PGCF_TEST_POSTGRES_BINDIR;
  if (directory) return directory;
  assert.ok(
    !process.env.CI,
    "PGCF_TEST_POSTGRES_BINDIR must name PostgreSQL 18 in CI",
  );
  return null;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise((done) => server.close(done));
  return port;
}

test(
  "the dataset and the request run on a real PostgreSQL and answer the sizes they promise",
  {
    skip:
      postgresBinaries() === null &&
      "PGCF_TEST_POSTGRES_BINDIR names no PostgreSQL 18 binaries",
  },
  async () => {
    const binaries = postgresBinaries()!;
    const directory = await mkdtemp(join(tmpdir(), "pgcf-saas-"));
    const data = join(directory, "data");
    const port = await freePort();
    const psql = (script: string) => {
      const file = join(directory, "script.sql");
      return writeFile(file, script, { mode: 0o600 }).then(() =>
        execFileSync(
          join(binaries, "psql"),
          [
            "-X",
            "-q",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            "127.0.0.1",
            "-p",
            String(port),
            "-U",
            "test",
            "-d",
            "postgres",
            "-f",
            file,
          ],
          { encoding: "utf8" },
        ),
      );
    };
    execFileSync(
      join(binaries, "initdb"),
      ["-D", data, "-A", "trust", "-U", "test", "--no-sync"],
      { stdio: "ignore" },
    );
    execFileSync(
      join(binaries, "pg_ctl"),
      [
        "-D",
        data,
        "-o",
        `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories= -c fsync=off`,
        "-l",
        join(directory, "log"),
        "-w",
        "start",
      ],
      { stdio: "ignore" },
    );
    try {
      await psql(
        setupStatements(0.01)
          .map((sql) => `${sql};`)
          .join("\n"),
      );
      for (let call = 0; call < 25; call++) {
        const request = buildRequest(3, call, 0.01);
        const output = await psql(
          request
            .map(
              (statement) => `\\echo @@ ${statement.name}\n${statement.sql};`,
            )
            .join("\n"),
        );
        // Each marker is followed by the rows its statement returned.
        const rows = new Map<string, number>();
        let current = "";
        for (const line of output.split("\n")) {
          if (line.startsWith("@@ ")) rows.set((current = line.slice(3)), 0);
          else if (line !== "") rows.set(current, rows.get(current)! + 1);
        }
        for (const statement of request)
          assert.equal(
            rows.get(statement.name),
            statement.rows,
            `${statement.name} of call ${call}`,
          );
      }
    } finally {
      execFileSync(
        join(binaries, "pg_ctl"),
        ["-D", data, "-m", "fast", "stop"],
        { stdio: "ignore" },
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
