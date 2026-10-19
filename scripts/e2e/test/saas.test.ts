// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ARMS,
  GATE_MS,
  STATEMENT_NAMES,
  allowedMisses,
  armFor,
  buildBatch,
  buildRequest,
  buildTrips,
  datasetSize,
  parseCommand,
  percentile,
  requestsUntilWarm,
  setupStatements,
  summarize,
  summarizeArm,
  summarizeHealthz,
  timeCall,
  type HealthzSample,
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
  // A follow-up that failed after a good cold call is a failure of the run too.
  const followed = summarize([
    ...calls,
    { ...done(500), followup_failures: 1 },
  ]);
  assert.equal(followed.failures, 0);
  assert.equal(followed.followup_failures, 1);
  assert.equal(followed.gate_met, false);
  assert.equal(summary.followup_failures, 0);
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
  const trips = buildTrips("ws", 1, 1, 1);
  const statements = trips.flat();
  const ended: string[] = [];
  const timed = await timeCall(
    async () => ({
      ...session((sql) => statements.find((s) => s.sql === sql)!.rows, ended),
      socketOpenedAt: 25,
    }),
    trips,
    clock(),
  );
  // The clock moves 10 ms per reading: start at 10, connected at 20, then a send and an answer
  // for each statement; the request ends with the last answer.
  assert.deepEqual(timed, {
    ok: true,
    connect_ms: 10,
    ws_open_ms: 15,
    first_answer_ms: 30,
    request_ms: 110,
    statements_ms: [10, 10, 10, 10, 10],
  });
  assert.deepEqual(ended, ["end"]);
});

test("a call that cannot connect, or fails a statement, says where and keeps no message text", async () => {
  const trips = buildTrips("ws", 1, 1, 1);
  const refused = Object.assign(new Error("password for user app is wrong"), {
    code: "28P01",
  });
  const noConnection = await timeCall(
    async () => {
      throw refused;
    },
    trips,
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
    trips,
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
  const trips = buildTrips("ws", 1, 1, 1);
  const timed = await timeCall(
    async () => session((sql) => (sql.startsWith("SELECT id, title") ? 12 : 1)),
    trips,
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
      arms: ["ws"],
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
      arms: ["ws"],
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

test("the HTTP batch is the request's five statements without the BEGIN and COMMIT that transaction() supplies", () => {
  const request = buildRequest(7, 3, 1);
  const batch = buildBatch(7, 3, 1);
  assert.deepEqual(
    batch.map((statement) => statement.name),
    [...STATEMENT_NAMES],
  );
  // The same row counts: the insert returns its id, the update returns nothing.
  assert.deepEqual(
    batch.map((statement) => statement.rows),
    request.map((statement) => statement.rows),
  );
  // The same statements, the same keys; only the transaction's own control words are gone.
  assert.deepEqual(
    batch.map((statement) => statement.sql),
    request.map((statement) =>
      statement.sql.replace(/^BEGIN; /, "").replace(/; COMMIT$/, ""),
    ),
  );
  for (const statement of batch)
    assert.doesNotMatch(statement.sql, /\b(BEGIN|COMMIT)\b/);
  assert.match(batch[3]!.sql, /^INSERT INTO tasks/);
  assert.match(batch[4]!.sql, /^UPDATE tasks SET .* WHERE id = \d+$/);
  // Fixed by seed and call, like the request.
  assert.deepEqual(batch, buildBatch(7, 3, 1));
  assert.notDeepEqual(batch, buildBatch(7, 4, 1));
  assert.notDeepEqual(batch, buildBatch(8, 3, 1));
});

test("each arm sends the request in its own round trips: five, one, or the session lookup and then the other four", () => {
  const request = buildRequest(7, 3, 1);
  const batch = buildBatch(7, 3, 1);
  assert.deepEqual(ARMS, ["ws", "http-batch", "http-auth-then-batch"]);
  assert.deepEqual(
    buildTrips("ws", 7, 3, 1),
    request.map((statement) => [statement]),
  );
  assert.deepEqual(buildTrips("http-batch", 7, 3, 1), [batch]);
  assert.deepEqual(buildTrips("http-auth-then-batch", 7, 3, 1), [
    [batch[0]],
    batch.slice(1),
  ]);
});

/** An HTTP session: one request is a statement or a transaction, and it opens no connection. */
function httpSession(
  script: (sql: string) => number | Error,
  ended: string[] = [],
): Session {
  const rows = (sql: string) => {
    const answer = script(sql);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return {
    query: async (sql) => rows(sql),
    transaction: async (sqls) => sqls.map(rows),
    end: async () => void ended.push("end"),
    connectionless: true,
  };
}

test("an HTTP batch is one round trip: its first answer is its whole request, and it has no connect time", async () => {
  const trips = buildTrips("http-batch", 7, 3, 1);
  const rows = new Map(trips.flat().map((s) => [s.sql, s.rows]));
  const ended: string[] = [];
  const timed = await timeCall(
    async () => httpSession((sql) => rows.get(sql)!, ended),
    trips,
    clock(),
  );
  assert.deepEqual(timed, {
    ok: true,
    first_answer_ms: 20,
    request_ms: 20,
    // One entry per round trip, not per statement.
    statements_ms: [10],
  });
  assert.equal(timed.first_answer_ms, timed.request_ms);
  assert.deepEqual(ended, ["end"]);
});

test("the session lookup of the second HTTP arm answers first, and the transaction after it ends the request", async () => {
  const trips = buildTrips("http-auth-then-batch", 7, 3, 1);
  const rows = new Map(trips.flat().map((s) => [s.sql, s.rows]));
  const timed = await timeCall(
    async () => httpSession((sql) => rows.get(sql)!),
    trips,
    clock(),
  );
  assert.equal(timed.ok, true);
  assert.deepEqual(timed.statements_ms, [10, 10]);
  assert.equal(timed.first_answer_ms, 20);
  assert.equal(timed.request_ms, 40);
});

test("a batch that answers a wrong size or fails names the statement or its first one, and keeps the first answer", async () => {
  const trips = buildTrips("http-batch", 7, 3, 1);
  const rows = new Map(trips.flat().map((s) => [s.sql, s.rows]));
  const wrong = await timeCall(
    async () =>
      httpSession((sql) =>
        sql.startsWith("SELECT status, count") ? 0 : rows.get(sql)!,
      ),
    trips,
    clock(),
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.failed_at, "counts");
  assert.equal(wrong.error?.error_class, "UnexpectedResult");
  const broken = await timeCall(
    async () =>
      httpSession(() => Object.assign(new Error("boom"), { code: "57014" })),
    trips,
    clock(),
  );
  // A transaction that fails says no more than its first statement.
  assert.equal(broken.failed_at, "auth");
  assert.equal(broken.error?.sqlstate, "57014");
  assert.equal(broken.first_answer_ms, undefined);
  assert.equal(broken.request_ms, undefined);
});

test("a request the Edge refuses over HTTP keeps the driver's error class and the SQLSTATE, and not its message", async () => {
  const refused = Object.assign(new Error("too many connections for secret"), {
    name: "NeonDbError",
    code: "53300",
  });
  const timed = await timeCall(
    async () => httpSession(() => refused),
    buildTrips("http-auth-then-batch", 1, 1, 1),
    clock(),
  );
  assert.equal(timed.ok, false);
  assert.equal(timed.failed_at, "connect");
  assert.deepEqual(timed.error, {
    error_class: "NeonDbError",
    sqlstate: "53300",
    errno: null,
  });
  assert.doesNotMatch(JSON.stringify(timed), /secret/);
});

test("over HTTP a refusal, a wake that is not ready or a network error on the first request is a failed connect, as on a WebSocket; a statement's own error names the statement", async () => {
  const failing = (code: string | undefined) =>
    timeCall(
      async () =>
        httpSession(() =>
          Object.assign(new Error("boom"), { name: "NeonDbError", code }),
        ),
      buildTrips("http-batch", 1, 1, 1),
      clock(),
    );
  // 53300 admission, 57P03 wake, 28P01 password, class 08, and no SQLSTATE at all (a network or a server error).
  for (const code of ["53300", "57P03", "28P01", "08006", undefined])
    assert.equal((await failing(code)).failed_at, "connect", String(code));
  for (const code of ["57014", "42P01"])
    assert.equal((await failing(code)).failed_at, "auth", code);
  // Once a request has been answered, the connection is open: a later failure is a statement's.
  const trips = buildTrips("http-auth-then-batch", 1, 1, 1);
  const rows = new Map(trips.flat().map((s) => [s.sql, s.rows]));
  const later = await timeCall(
    async () =>
      httpSession((sql) =>
        sql.startsWith("SELECT status, count")
          ? Object.assign(new Error("boom"), { code: "53300" })
          : rows.get(sql)!,
      ),
    trips,
    clock(),
  );
  // The transaction names its first statement.
  assert.equal(later.failed_at, "list");
  // A WebSocket session has its connect step: a failed statement on it is the statement.
  const socket = await timeCall(
    async () =>
      session(() => Object.assign(new Error("boom"), { code: "08006" })),
    buildTrips("ws", 1, 1, 1),
    clock(),
  );
  assert.equal(socket.failed_at, "auth");
});

test("the distribution-free rule allows 0 misses from 59 samples, 1 from 93 and 2 from 124", () => {
  const allowed = (n: number) => allowedMisses(n);
  assert.equal(allowed(0), null);
  assert.equal(allowed(58), null);
  assert.equal(allowed(59), 0);
  assert.equal(allowed(92), 0);
  assert.equal(allowed(93), 1);
  assert.equal(allowed(123), 1);
  assert.equal(allowed(124), 2);
  // The first sample size of each count is a minimum: 153 allows 3, 181 allows 4 and 180 still only 3.
  assert.equal(allowed(152), 2);
  assert.equal(allowed(153), 3);
  assert.equal(allowed(180), 3);
  assert.equal(allowed(181), 4);
  // Far beyond the range where 0.95^n is a number a double can hold.
  assert.ok(allowed(20_000)! > 800);
});

const slow = (request: number): Timed => done(request);
const failed: Timed = { ok: false, statements_ms: [], failed_at: "connect" };

test("an arm's verdict counts failures and slow requests as misses against the rule", () => {
  const fast = (n: number) =>
    Array.from({ length: n }, (_, i) => done(400 + i));
  const sixty = summarizeArm(fast(59));
  assert.deepEqual(sixty.verdict, {
    n: 59,
    over_1s: 0,
    allowed_over_1s: 0,
    result: "met",
  });
  assert.equal(sixty.calls, 59);
  assert.deepEqual(sixty.request_ms, { p50: 429, p95: 456 });
  // One slow request among 59 loses the rule; one among 93 does not.
  const oneSlow = summarizeArm([...fast(58), slow(GATE_MS)]);
  assert.equal(oneSlow.verdict.over_1s, 1);
  assert.equal(oneSlow.verdict.result, "not_met");
  const ninetyThree = summarizeArm([...fast(92), slow(GATE_MS + 300)]);
  assert.deepEqual(ninetyThree.verdict, {
    n: 93,
    over_1s: 1,
    allowed_over_1s: 1,
    result: "met",
  });
  // A failed call is a miss, and its time is in no percentile.
  const withFailure = summarizeArm([...fast(92), failed]);
  assert.equal(withFailure.verdict.over_1s, 1);
  assert.equal(withFailure.verdict.result, "met");
  assert.equal(withFailure.failures, 1);
  const twoMisses = summarizeArm([...fast(91), failed, slow(2000)]);
  assert.equal(twoMisses.verdict.result, "not_met");
  // Under 1 s is the gate: a request of exactly 1 s is a miss, one just under is not.
  assert.equal(summarizeArm([slow(GATE_MS - 0.1)]).verdict.over_1s, 0);
  assert.equal(summarizeArm([slow(GATE_MS)]).verdict.over_1s, 1);
  // Too few samples show nothing, however fast.
  const few = summarizeArm(fast(58));
  assert.deepEqual(few.verdict, {
    n: 58,
    over_1s: 0,
    allowed_over_1s: null,
    result: "too_few",
  });
  assert.equal(summarizeArm([]).verdict.result, "too_few");
});

test("the arms take turns on every database: rotated by round and by database, so each pair meets each arm equally", () => {
  const arms = [...ARMS];
  const databases = 4;
  const seen = new Map<string, number>();
  for (let round = 1; round <= 6; round++)
    for (let index = 0; index < databases; index++) {
      const key = `${index}:${armFor(arms, index, round)}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  // Six rounds over three arms: every database got every arm twice.
  for (let index = 0; index < databases; index++)
    for (const arm of arms) assert.equal(seen.get(`${index}:${arm}`), 2);
  // A round gives the arms out in turn, and the next round moves each database to the next arm.
  assert.deepEqual(
    [0, 1, 2].map((index) => armFor(arms, index, 1)),
    ["ws", "http-batch", "http-auth-then-batch"],
  );
  assert.deepEqual(
    [0, 1, 2].map((index) => armFor(arms, index, 2)),
    ["http-batch", "http-auth-then-batch", "ws"],
  );
  assert.equal(armFor(["ws"], 5, 9), "ws");
});

test("--mode names the arms of a run, in a balanced design, and one arm for a call", () => {
  const run = (...extra: string[]) =>
    parseCommand([
      "run",
      "--databases",
      database,
      "--idle-s",
      "3600",
      ...extra,
    ]);
  const modes = "ws,http-batch,http-auth-then-batch";
  assert.deepEqual(
    (run("--rounds", "6", "--mode", modes) as { arms: string[] }).arms,
    [...ARMS],
  );
  assert.deepEqual(
    (run("--rounds", "2", "--mode", "http-batch") as { arms: string[] }).arms,
    ["http-batch"],
  );
  assert.deepEqual(
    (
      parseCommand([
        "call",
        "--database",
        database,
        "--mode",
        "http-auth-then-batch",
      ]) as { arms: string[] }
    ).arms,
    ["http-auth-then-batch"],
  );
  const refused = [
    // Rounds that are not a multiple of the arms leave a database with one arm more than another.
    () => run("--rounds", "4", "--mode", modes),
    () => run("--rounds", "3", "--mode", "ws,ws,http-batch"),
    () => run("--rounds", "3", "--mode", "ws,tcp,http-batch"),
    () => run("--rounds", "3", "--mode", ""),
    () => run("--rounds", "3", "--mode", "ws,"),
    () => parseCommand(["call", "--database", database, "--mode", modes]),
    () => parseCommand(["setup", "--database", database, "--mode", "ws"]),
  ];
  for (const attempt of refused) assert.throws(attempt, /./);
});

test("the healthz command reads a number of samples and a rest between them, and nothing else", () => {
  assert.deepEqual(parseCommand(["healthz"]), {
    command: "healthz",
    samples: 30,
    idleS: 0,
  });
  assert.deepEqual(
    parseCommand(["healthz", "--samples", "40", "--idle-s", "20"]),
    { command: "healthz", samples: 40, idleS: 20 },
  );
  for (const argv of [
    ["healthz", "--samples", "0"],
    ["healthz", "--database", database],
    ["healthz", "--samples"],
  ])
    assert.throws(() => parseCommand(argv), /./, JSON.stringify(argv));
});

test("the healthz summary compares the first and the second call of each path, and counts samples that failed", () => {
  const sample = (first: number, second: number) => ({
    colo: "FRA",
    public: [
      { ms: first + 60, status: 200, ray_colo: "FRA" },
      { ms: second + 60, status: 200, ray_colo: "FRA" },
    ],
    binding: [
      { ms: first, status: 200, ray_colo: null },
      { ms: second, status: 200, ray_colo: null },
    ],
  });
  const summary = summarizeHealthz([
    sample(100, 20),
    sample(120, 30),
    sample(140, 40),
    sample(160, 50),
    null,
  ]);
  assert.equal(summary.samples, 5);
  assert.equal(summary.failures, 1);
  assert.deepEqual(summary.public.first, { p50: 180, p95: 220 });
  assert.deepEqual(summary.public.second, { p50: 90, p95: 110 });
  assert.deepEqual(summary.binding.first, { p50: 120, p95: 160 });
  assert.deepEqual(summary.binding.second, { p50: 30, p95: 50 });
  // Nothing from a path that was not bound.
  const unbound = summarizeHealthz([{ ...sample(100, 20), binding: null }]);
  assert.deepEqual(unbound.binding.first, { p50: null, p95: null });
  assert.deepEqual(summarizeHealthz([]).public.first, { p50: null, p95: null });
});

test("a healthz sample with a GET not answered 200 is a failure: its error page's time is no percentile", () => {
  const sample = (first: number, second: number): HealthzSample => ({
    colo: "FRA",
    public: [
      { ms: first + 60, status: 200, ray_colo: "FRA" },
      { ms: second + 60, status: 200, ray_colo: "FRA" },
    ],
    binding: [
      { ms: first, status: 200, ray_colo: null },
      { ms: second, status: 200, ray_colo: null },
    ],
  });
  const refused = (path: "public" | "binding", call: 0 | 1, status: number) => {
    const bad = sample(5, 5);
    bad[path]![call] = { ms: 5, status, ray_colo: null };
    return bad;
  };
  // 403, 502 and 530 answer in a few milliseconds: they must not pull the percentiles down.
  const summary = summarizeHealthz([
    sample(100, 20),
    sample(120, 30),
    refused("public", 0, 403),
    refused("public", 1, 502),
    refused("binding", 1, 530),
  ]);
  assert.equal(summary.samples, 5);
  assert.equal(summary.failures, 3);
  assert.deepEqual(summary.public.first, { p50: 160, p95: 180 });
  assert.deepEqual(summary.binding.second, { p50: 20, p95: 30 });
  // A sample that is only error pages leaves no percentile.
  const none = summarizeHealthz([refused("public", 0, 502)]);
  assert.equal(none.failures, 1);
  assert.deepEqual(none.binding.first, { p50: null, p95: null });
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
        // The request carries its transaction's BEGIN and COMMIT; the batch gets them from the script,
        // as transaction() gives them over HTTP.
        for (const [request, before, after] of [
          [buildRequest(3, call, 0.01), "", ""],
          [buildBatch(3, call, 0.01), "BEGIN;\n", "\nCOMMIT;"],
        ] as const) {
          const output = await psql(
            before +
              request
                .map(
                  (statement) =>
                    `\\echo @@ ${statement.name}\n${statement.sql};`,
                )
                .join("\n") +
              after,
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
