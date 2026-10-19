// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { buildTrips, type Session } from "../src/saas.ts";

// The probe Worker imports a module that only the Workers runtime has; none of these tests opens a socket with it.
const sockets = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:sockets")
      return {
        url: "data:text/javascript,export function connect() { throw new Error('unexpected_socket_call'); }",
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const worker = await import("../probe/worker.ts");
sockets.deregister();

const cli = resolve(import.meta.dirname, "../src/saas-bench.ts");
const database = "d" + "a".repeat(19);

function bench(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(process.execPath, [cli, ...args], {
        // Not the caller's environment: a real key or probe URL must not reach this test.
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (bytes: Buffer) => (stdout += bytes));
      child.stderr.on("data", (bytes: Buffer) => (stderr += bytes));
      child.on("close", (code) => done({ code, stdout, stderr }));
    },
  );
}

/** The fields of the benchmark's output lines that these tests read. */
interface Line {
  db?: string;
  round?: number;
  arm?: string;
  via?: string;
  ok?: boolean;
  colo?: string;
  ws_open_ms?: number;
  observed_state_before?: string;
  failed_at?: string;
  error?: { error_class: string; sqlstate: string | null };
  request_ms?: number;
  connect_ms?: number;
  followups_ms?: number[];
  requests_until_warm?: number | null;
  followup_failures?: number;
  followup_failed_at?: string;
  followup_error?: { error_class: string; sqlstate: string | null };
  summary?: {
    failures: number;
    followup_failures: number;
    gate_met: boolean;
  };
  arms?: Record<
    string,
    {
      calls: number;
      failures: number;
      request_ms: { p50: number | null; p95: number | null };
      verdict: {
        n: number;
        over_1s: number;
        allowed_over_1s: number | null;
        result: string;
      };
    }
  >;
  healthz?: number;
  public?: { ms: number }[];
  healthz_summary?: {
    samples: number;
    failures: number;
    public: { first: { p50: number | null }; second: { p50: number | null } };
    binding: { first: { p50: number | null }; second: { p50: number | null } };
  };
}

function lines(stdout: string): Line[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
}

const good = {
  ok: true,
  connect_ms: 120.5,
  first_answer_ms: 400.1,
  request_ms: 900.7,
  statements_ms: [1, 2, 3, 4, 5],
};
const failure = {
  ok: false,
  statements_ms: [],
  failed_at: "connect",
  error: { error_class: "Error", sqlstate: "08006", errno: null },
};

/** A probe Worker that answers call number `n` (0-based) with `answers(n, query)`. */
async function startProbe(
  answers: (call: number, query: URLSearchParams) => object,
) {
  const asked: { method?: string; authorization?: string; url?: string }[] = [];
  const server = createServer((request, response) => {
    asked.push({
      method: request.method,
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        answers(
          asked.length - 1,
          new URL(request.url!, "http://probe").searchParams,
        ),
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    asked,
    url: `http://127.0.0.1:${port}/bench`,
    stop: () => server.close(),
  };
}

/** The management API's one route read before a cold call: the database and whether it sleeps. */
async function startApi(
  key: string,
  answer: () => { status: number; observed_state?: string },
) {
  const asked: { url?: string; authorization?: string }[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    asked.push({
      url: request.url,
      authorization: request.headers.authorization,
    });
    const known =
      request.method === "GET" &&
      request.headers.authorization === `Bearer ${key}` &&
      request.url === `/v1/databases/${database}`;
    const { status, observed_state } = answer();
    response.writeHead(known ? status : 404, {
      "Content-Type": "application/json",
    });
    response.end(
      JSON.stringify(
        known && observed_state
          ? { observed_state, effective_sleep_after_seconds: 60 }
          : {},
      ),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    asked,
    env: {
      PGCF_API_URL: `http://127.0.0.1:${port}`,
      PGCF_API_KEY: key,
    },
    stop: () => server.close(),
  };
}

const hibernated = () => ({ status: 200, observed_state: "hibernated" });

test("a probe call checks that the database sleeps, asks the Worker for the request and prints its record with the call's identity", async () => {
  const token = randomBytes(16).toString("hex");
  const key = randomBytes(16).toString("hex");
  const probe = await startProbe(() => good);
  const api = await startApi(key, hibernated);
  try {
    const result = await bench(
      [
        "run",
        "--databases",
        database,
        "--rounds",
        "2",
        "--idle-s",
        "0",
        "--via",
        "probe",
        "--seed",
        "9",
        "--scale",
        "0.5",
      ],
      {
        ...api.env,
        PGCF_BENCH_PROBE_URL: probe.url,
        PGCF_BENCH_PROBE_TOKEN: token,
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      probe.asked.map((request) => [request.method, request.authorization]),
      [
        ["POST", `Bearer ${token}`],
        ["POST", `Bearer ${token}`],
      ],
    );
    // The state is read before each cold call, with the integrator's key.
    assert.deepEqual(
      api.asked.map((request) => [request.url, request.authorization]),
      [0, 1].map(() => [`/v1/databases/${database}`, `Bearer ${key}`]),
    );
    // Each call is a number of its own, so the Worker builds another request each time.
    assert.deepEqual(
      probe.asked.map((request) => {
        const query = new URL(request.url!, "http://probe").searchParams;
        return [...query.entries()];
      }),
      [0, 1].map((call) => [
        ["database", database],
        ["seed", "9"],
        ["call", String(call)],
        ["scale", "0.5"],
        ["mode", "ws"],
      ]),
    );
    const output = lines(result.stdout);
    assert.equal(output.length, 3);
    assert.deepEqual(
      {
        db: output[0]!.db,
        round: output[0]!.round,
        via: output[0]!.via,
        ok: output[0]!.ok,
        before: output[0]!.observed_state_before,
      },
      {
        db: database,
        round: 1,
        via: "probe",
        ok: true,
        before: "hibernated",
      },
    );
    assert.equal(output[0]!.request_ms, 900.7);
    assert.equal(output[2]!.summary!.failures, 0);
    assert.equal(output[2]!.summary!.followup_failures, 0);
    assert.equal(output[2]!.summary!.gate_met, true);
    for (const secret of [token, key])
      assert.ok(!result.stdout.includes(secret));
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a request that fails after the cold one is kept: in its line, in the summary and in the exit code", async () => {
  const key = randomBytes(16).toString("hex");
  // The cold call and its first follow-up answer; the second follow-up fails.
  const probe = await startProbe((call) => (call === 2 ? failure : good));
  const api = await startApi(key, hibernated);
  const env = {
    ...api.env,
    PGCF_BENCH_PROBE_URL: probe.url,
    PGCF_BENCH_PROBE_TOKEN: "token",
  };
  try {
    const call = await bench(
      ["call", "--database", database, "--via", "probe", "--followups", "3"],
      env,
    );
    assert.equal(call.code, 1);
    const [record] = lines(call.stdout);
    assert.equal(record!.ok, true);
    assert.equal(record!.followup_failures, 1);
    assert.equal(record!.followup_failed_at, "connect");
    assert.equal(record!.followup_error?.error_class, "Error");
    assert.equal(record!.followup_error?.sqlstate, "08006");
    // The requests before the failure are kept; no "until warm" is claimed from a broken series.
    assert.equal(record!.followups_ms?.length, 1);
    assert.equal(record!.requests_until_warm, null);
    probe.asked.length = 0;
    const run = await bench(
      [
        "run",
        "--databases",
        database,
        "--rounds",
        "1",
        "--idle-s",
        "0",
        "--via",
        "probe",
        "--followups",
        "3",
      ],
      env,
    );
    assert.equal(run.code, 1);
    const [, summary] = lines(run.stdout);
    assert.equal(summary!.summary!.failures, 0);
    assert.equal(summary!.summary!.followup_failures, 1);
    assert.equal(summary!.summary!.gate_met, false);
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a database that is not asleep is not timed as cold: no call is made, and the run fails", async () => {
  const key = randomBytes(16).toString("hex");
  const probe = await startProbe(() => good);
  let state = "ready";
  const api = await startApi(key, () => ({
    status: 200,
    observed_state: state,
  }));
  const env = {
    ...api.env,
    PGCF_BENCH_PROBE_URL: probe.url,
    PGCF_BENCH_PROBE_TOKEN: "token",
  };
  try {
    const awake = await bench(
      ["call", "--database", database, "--via", "probe", "--idle-s", "3600"],
      env,
    );
    assert.equal(awake.code, 1);
    const [record] = lines(awake.stdout);
    assert.equal(record!.ok, false);
    assert.equal(record!.failed_at, "cold_check");
    assert.equal(record!.error?.error_class, "NotCold");
    assert.equal(record!.observed_state_before, "ready");
    assert.equal(record!.request_ms, undefined);
    assert.equal(probe.asked.length, 0);
    // In a run, every call of a database that did not sleep is a failed call.
    const run = await bench(
      [
        "run",
        "--databases",
        database,
        "--rounds",
        "2",
        "--idle-s",
        "0",
        "--via",
        "probe",
      ],
      env,
    );
    assert.equal(run.code, 1);
    assert.equal(lines(run.stdout).at(-1)!.summary!.failures, 2);
    assert.equal(lines(run.stdout).at(-1)!.summary!.gate_met, false);
    assert.equal(probe.asked.length, 0);
    state = "hibernated";
    const asleep = await bench(
      ["call", "--database", database, "--via", "probe"],
      env,
    );
    assert.equal(asleep.code, 0, asleep.stderr);
    assert.equal(probe.asked.length, 1);
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a state that cannot be read is a failed call, never a cold one", async () => {
  const key = randomBytes(16).toString("hex");
  const probe = await startProbe(() => good);
  const api = await startApi(key, () => ({ status: 500 }));
  try {
    const result = await bench(
      ["call", "--database", database, "--via", "probe"],
      {
        ...api.env,
        PGCF_BENCH_PROBE_URL: probe.url,
        PGCF_BENCH_PROBE_TOKEN: "token",
      },
    );
    assert.equal(result.code, 1);
    const [record] = lines(result.stdout);
    assert.equal(record!.ok, false);
    assert.equal(record!.failed_at, "cold_check");
    assert.equal(record!.error?.error_class, "Unavailable");
    assert.equal(record!.observed_state_before, undefined);
    assert.equal(probe.asked.length, 0);
    assert.ok(!result.stdout.includes(key));
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a probe that does not answer is a failed call, and a missing variable is named, not its value", async () => {
  const key = randomBytes(16).toString("hex");
  const api = await startApi(key, hibernated);
  try {
    const refused = await bench(
      ["call", "--database", database, "--via", "probe"],
      {
        ...api.env,
        PGCF_BENCH_PROBE_URL: "http://127.0.0.1:1/bench",
        PGCF_BENCH_PROBE_TOKEN: "token",
      },
    );
    assert.equal(refused.code, 1);
    const record = JSON.parse(refused.stdout.trim());
    assert.equal(record.ok, false);
    assert.equal(record.failed_at, "connect");
    assert.equal(record.error.error_class, "ProbeUnavailable");
    const unset = await bench(
      ["call", "--database", database, "--via", "probe"],
      api.env,
    );
    assert.equal(unset.code, 2);
    assert.equal(unset.stderr.trim(), "set PGCF_BENCH_PROBE_URL");
  } finally {
    api.stop();
  }
  const nothing = await bench(
    ["call", "--database", database, "--via", "probe"],
    {},
  );
  assert.equal(nothing.code, 2);
  assert.equal(nothing.stderr.trim(), "set PGCF_API_URL");
});

test("a run of three arms hands the database to one arm per round, in turn, and judges each arm by the distribution-free rule", async () => {
  const key = randomBytes(16).toString("hex");
  // The Worker's answers differ by the arm it was asked for: a WebSocket request over 1 s every
  // time, the batch always under, the session lookup and batch with one failure among its calls.
  let authThenBatchCalls = 0;
  const probe = await startProbe((_call, query) => {
    switch (query.get("mode")) {
      case "ws":
        return {
          ...good,
          request_ms: 1200,
          ws_open_ms: 41.2,
          colo: "FRA",
        };
      case "http-batch":
        return { ...good, request_ms: 800, colo: "FRA" };
      default:
        return authThenBatchCalls++ === 3
          ? failure
          : { ...good, request_ms: 900, colo: "AMS" };
    }
  });
  const api = await startApi(key, hibernated);
  try {
    const result = await bench(
      [
        "run",
        "--databases",
        database,
        "--rounds",
        "180",
        "--idle-s",
        "0",
        "--via",
        "probe",
        "--mode",
        "ws,http-batch,http-auth-then-batch",
      ],
      {
        ...api.env,
        PGCF_BENCH_PROBE_URL: probe.url,
        PGCF_BENCH_PROBE_TOKEN: "token",
      },
    );
    // The arm with the slow requests and the one with the failure lose the rule.
    assert.equal(result.code, 1);
    // Round 1 asked for ws, round 2 for the batch, round 3 for the lookup and batch, and so on.
    const modes = probe.asked.map((request) =>
      new URL(request.url!, "http://probe").searchParams.get("mode"),
    );
    assert.deepEqual(modes.slice(0, 4), [
      "ws",
      "http-batch",
      "http-auth-then-batch",
      "ws",
    ]);
    for (const arm of ["ws", "http-batch", "http-auth-then-batch"])
      assert.equal(modes.filter((mode) => mode === arm).length, 60);
    const output = lines(result.stdout);
    assert.deepEqual(
      output.slice(0, 3).map((line) => [line.round, line.arm]),
      [
        [1, "ws"],
        [2, "http-batch"],
        [3, "http-auth-then-batch"],
      ],
    );
    // The Worker's own location and its WebSocket open time reach the line.
    assert.equal(output[0]!.colo, "FRA");
    assert.equal(output[0]!.ws_open_ms, 41.2);
    assert.equal(output[2]!.colo, "AMS");
    const { arms } = output.at(-1)!;
    assert.deepEqual(arms!.ws!.verdict, {
      n: 60,
      over_1s: 60,
      allowed_over_1s: 0,
      result: "not_met",
    });
    assert.equal(arms!.ws!.request_ms.p95, 1200);
    assert.deepEqual(arms!["http-batch"]!.verdict, {
      n: 60,
      over_1s: 0,
      allowed_over_1s: 0,
      result: "met",
    });
    assert.equal(arms!["http-batch"]!.request_ms.p50, 800);
    assert.deepEqual(arms!["http-auth-then-batch"]!.verdict, {
      n: 60,
      over_1s: 1,
      allowed_over_1s: 0,
      result: "not_met",
    });
    assert.equal(arms!["http-auth-then-batch"]!.failures, 1);
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a run whose rounds do not give every database each arm equally often, or names an unknown arm, is refused before any call", async () => {
  const key = randomBytes(16).toString("hex");
  const probe = await startProbe(() => good);
  const api = await startApi(key, hibernated);
  const env = {
    ...api.env,
    PGCF_BENCH_PROBE_URL: probe.url,
    PGCF_BENCH_PROBE_TOKEN: "token",
  };
  try {
    for (const [rounds, mode, message] of [
      ["4", "ws,http-batch", null],
      [
        "5",
        "ws,http-batch",
        "--rounds must be a multiple of the number of --mode arms",
      ],
      [
        "2",
        "ws,sql",
        "--mode needs distinct arms of ws, http-batch, http-auth-then-batch",
      ],
    ] as const) {
      const result = await bench(
        [
          "run",
          "--databases",
          database,
          "--rounds",
          rounds,
          "--idle-s",
          "0",
          "--via",
          "probe",
          "--mode",
          mode,
        ],
        env,
      );
      if (message === null) {
        assert.equal(result.code, 0, result.stderr);
        continue;
      }
      assert.equal(result.code, 2);
      assert.equal(result.stderr.trim(), message);
    }
    // Only the accepted run called the Worker: four rounds.
    assert.equal(probe.asked.length, 4);
  } finally {
    probe.stop();
    api.stop();
  }
});

test("a call of an HTTP arm sends all its requests on one connection of its own, and no call borrows one a neighbour warmed", async () => {
  const key = randomBytes(16).toString("hex");
  const password = randomBytes(16).toString("hex");
  const answered = ["x"];
  for (const arm of ["http-batch", "http-auth-then-batch"] as const) {
    // The rows each statement of the first three calls must answer, by its text.
    const rows = new Map(
      [0, 1, 2].flatMap((call) =>
        buildTrips(arm, 1, call, 1)
          .flat()
          .map((statement) => [statement.sql, statement.rows] as const),
      ),
    );
    const sockets: number[] = [];
    const reply = (sql: string) => ({
      fields: [{ name: "x", dataTypeID: 25 }],
      rows: Array.from({ length: rows.get(sql)! }, () => answered),
    });
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      let body: unknown = {};
      if (request.method === "POST") {
        // Each request of the driver lands here with the port of the connection it came on.
        sockets.push(request.socket.remotePort!);
        const sent = JSON.parse(Buffer.concat(chunks).toString()) as {
          query?: string;
          queries?: { query: string }[];
        };
        body = sent.queries
          ? { results: sent.queries.map(({ query }) => reply(query)) }
          : reply(sent.query!);
      } else if (request.url === `/v1/databases/${database}`)
        body = { observed_state: "hibernated" };
      else
        body = {
          uri: `postgres://app:${password}@127.0.0.1:${(server.address() as { port: number }).port}/${database}`,
          includes_password: true,
        };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const result = await bench(
        ["call", "--database", database, "--mode", arm, "--followups", "2"],
        {
          PGCF_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          PGCF_API_KEY: key,
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const perCall = buildTrips(arm, 1, 0, 1).length;
      assert.equal(sockets.length, 3 * perCall, arm);
      const connections = [0, 1, 2].map((call) =>
        sockets.slice(call * perCall, (call + 1) * perCall),
      );
      // The requests of one call share a connection.
      for (const own of connections)
        assert.equal(new Set(own).size, 1, `${arm}: ${sockets}`);
      // The cold call and each follow-up use another one.
      assert.equal(new Set(connections.map(([port]) => port)).size, 3, arm);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }
});

/** What the probe Worker answers for `mode=healthz`: two GETs on each path. */
const get = (ms: number) => ({ ms, status: 200, ray_colo: "FRA" });

test("the healthz command asks the Worker for back-to-back GETs, once per sample, and compares the first and the second", async () => {
  const probe = await startProbe((call) =>
    call === 3
      ? { not: "a sample" }
      : {
          colo: "FRA",
          public: [get(180 + call), get(90 + call)],
          binding: [get(120 + call), get(30 + call)],
        },
  );
  try {
    const result = await bench(["healthz", "--samples", "5"], {
      PGCF_BENCH_PROBE_URL: probe.url,
      PGCF_BENCH_PROBE_TOKEN: "token",
    });
    // A sample the Worker could not take is a failure of the run.
    assert.equal(result.code, 1);
    assert.deepEqual(
      probe.asked.map((request) => [
        request.method,
        request.authorization,
        [...new URL(request.url!, "http://probe").searchParams],
      ]),
      [0, 1, 2, 3, 4].map((call) => [
        "POST",
        "Bearer token",
        [
          ["mode", "healthz"],
          ["call", String(call)],
        ],
      ]),
    );
    const output = lines(result.stdout);
    assert.equal(output.length, 6);
    assert.equal(output[0]!.healthz, 1);
    assert.equal(output[0]!.ok, true);
    assert.equal(output[0]!.colo, "FRA");
    assert.equal(output[3]!.ok, false);
    const summary = output[5]!.healthz_summary!;
    assert.equal(summary.samples, 5);
    assert.equal(summary.failures, 1);
    // Calls 0, 1, 2 and 4 answered.
    assert.equal(summary.public.first.p50, 181);
    assert.equal(summary.public.second.p50, 91);
    assert.equal(summary.binding.first.p50, 121);
    assert.equal(summary.binding.second.p50, 31);
  } finally {
    probe.stop();
  }
});

test("a GET the Edge answered with an error page is a failed sample: not ok, out of the percentiles, and the run exits 1", async () => {
  const probe = await startProbe((_call, query) =>
    query.get("call") === "1"
      ? {
          colo: "FRA",
          public: [{ ...get(4), status: 502 }, get(90)],
          binding: [get(30), get(30)],
        }
      : {
          colo: "FRA",
          public: [get(180), get(90)],
          binding: [get(120), get(30)],
        },
  );
  const env = {
    PGCF_BENCH_PROBE_URL: probe.url,
    PGCF_BENCH_PROBE_TOKEN: "token",
  };
  try {
    // Sample 0 is answered 200 by every GET: nothing to fail.
    const clean = await bench(["healthz", "--samples", "1"], env);
    assert.equal(clean.code, 0);
    const result = await bench(["healthz", "--samples", "3"], env);
    assert.equal(result.code, 1);
    const output = lines(result.stdout);
    assert.deepEqual(
      output.slice(0, 3).map((line) => line.ok),
      [true, false, true],
    );
    const summary = output[3]!.healthz_summary!;
    assert.equal(summary.samples, 3);
    assert.equal(summary.failures, 1);
    // The 502 answered in 4 ms; neither it nor its sample's other GETs are in a percentile.
    assert.equal(summary.public.first.p50, 180);
    assert.equal(summary.binding.first.p50, 120);
  } finally {
    probe.stop();
  }
});

test("the Worker reads the arm and the call's identity from its query, and refuses anything else", () => {
  const query = (entries: Record<string, string>) =>
    new URLSearchParams({
      database,
      seed: "9",
      call: "3",
      scale: "0.5",
      mode: "http-batch",
      ...entries,
    });
  assert.deepEqual(worker.benchQuery(query({})), {
    arm: "http-batch",
    database,
    seed: 9,
    call: 3,
    scale: 0.5,
  });
  for (const mode of ["ws", "http-auth-then-batch"])
    assert.equal(worker.benchQuery(query({ mode })).arm, mode);
  const refused: Record<string, string>[] = [
    { mode: "sql" },
    { mode: "" },
    { database: "d1" },
    { seed: "-1" },
    { seed: "1.5" },
    { call: "x" },
    { scale: "0" },
    { scale: "11" },
  ];
  for (const bad of refused)
    assert.throws(
      () => worker.benchQuery(query(bad)),
      { message: "invalid_bench_request" },
      JSON.stringify(bad),
    );
});

/** A session that answers the rows each statement of the request promises, as the Edge's would. */
function answering(arm: "ws" | "http-batch" | "http-auth-then-batch") {
  const rows = new Map(
    buildTrips(arm, 9, 3, 1)
      .flat()
      .map((statement) => [statement.sql, statement.rows]),
  );
  const sent: string[][] = [];
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const query = async (sql: string) => {
    await pause(2);
    sent.push([sql]);
    return rows.get(sql)!;
  };
  const open = async (): Promise<Session> => {
    if (arm !== "ws")
      return {
        connectionless: true,
        query,
        transaction: async (sqls) => {
          await pause(2);
          sent.push([...sqls]);
          return sqls.map((sql) => rows.get(sql)!);
        },
        end: async () => undefined,
      };
    // The socket opened as the connection began, and the connection took a few milliseconds.
    const socketOpenedAt = performance.now();
    await pause(6);
    return { query, end: async () => undefined, socketOpenedAt };
  };
  return { open, sent };
}

test("a WebSocket answer of the Worker carries its own location and when the socket opened; an HTTP answer has no connect time", async () => {
  const uri = `postgres://app:secret@${["edge", "test"].join(".")}/${database}`;
  const ws = answering("ws");
  const socket = await worker.benchCall(
    { arm: "ws", database, seed: 9, call: 3, scale: 1 },
    uri,
    "FRA",
    ws.open,
  );
  assert.equal(socket.ok, true);
  assert.equal(socket.colo, "FRA");
  assert.equal(typeof socket.ws_open_ms, "number");
  // The socket opened as the connection began, and the connection took a few milliseconds.
  assert.ok(socket.ws_open_ms! >= 0 && socket.ws_open_ms! < socket.connect_ms!);
  assert.ok(socket.connect_ms! >= 5);
  assert.equal(socket.statements_ms.length, 5);
  assert.equal(ws.sent.length, 5);
  // The Worker says nothing of its location when the runtime does not.
  const unknown = await worker.benchCall(
    { arm: "ws", database, seed: 9, call: 3, scale: 1 },
    uri,
    null,
    answering("ws").open,
  );
  assert.equal(unknown.colo, null);
  const batch = answering("http-batch");
  const http = await worker.benchCall(
    { arm: "http-batch", database, seed: 9, call: 3, scale: 1 },
    uri,
    "AMS",
    batch.open,
  );
  assert.equal(http.ok, true);
  assert.equal(http.colo, "AMS");
  assert.equal(http.ws_open_ms, undefined);
  assert.equal(http.connect_ms, undefined);
  assert.equal(http.first_answer_ms, http.request_ms);
  // One transaction of the five statements, none with a BEGIN or COMMIT of its own.
  assert.equal(batch.sent.length, 1);
  assert.equal(batch.sent[0]!.length, 5);
  assert.doesNotMatch(batch.sent[0]!.join(" "), /\b(BEGIN|COMMIT)\b/);
  const both = answering("http-auth-then-batch");
  const split = await worker.benchCall(
    { arm: "http-auth-then-batch", database, seed: 9, call: 3, scale: 1 },
    uri,
    "AMS",
    both.open,
  );
  assert.equal(split.ok, true);
  assert.deepEqual(
    both.sent.map((sent) => sent.length),
    [1, 4],
  );
  assert.ok(split.first_answer_ms! < split.request_ms!);
  // The record names the arm's result and the location, never the connection URI.
  assert.ok(!JSON.stringify([socket, http, split]).includes("secret"));
});

/** A GET answered with the `cf-ray` a Cloudflare location puts on it, or none. */
const answer = (ray?: string) => async () =>
  new Response(JSON.stringify({ status: "ok" }), {
    headers: ray ? { "cf-ray": ray } : {},
  });

test("the healthz timing makes two back-to-back GETs on each path, takes the paths in turn and reads the Edge's location from the ray", async () => {
  const log: string[] = [];
  const paths = (binding: boolean) => ({
    public: async () => (log.push("public"), answer("8d1a2b3c4d5e6f70-FRA")()),
    binding: binding ? async () => (log.push("binding"), answer()()) : null,
  });
  const even = await worker.healthzCall(0, "AMS", paths(true));
  assert.deepEqual(log.splice(0), ["public", "public", "binding", "binding"]);
  assert.equal(even.colo, "AMS");
  assert.equal(even.public.length, 2);
  assert.deepEqual(
    even.public.map((get) => [get.status, get.ray_colo]),
    [
      [200, "FRA"],
      [200, "FRA"],
    ],
  );
  assert.deepEqual(
    even.binding!.map((get) => get.ray_colo),
    [null, null],
  );
  for (const get of [...even.public, ...even.binding!])
    assert.ok(Number.isFinite(get.ms) && get.ms >= 0);
  // The next call starts with the other path, so an order effect cancels over the samples.
  await worker.healthzCall(1, "AMS", paths(true));
  assert.deepEqual(log.splice(0), ["binding", "binding", "public", "public"]);
  // Without a service binding there is nothing to compare, and nothing is made up.
  const alone = await worker.healthzCall(1, null, paths(false));
  assert.equal(alone.binding, null);
  assert.equal(alone.colo, null);
  assert.deepEqual(log.splice(0), ["public", "public"]);
  // A ray that is not a location is no location.
  const odd = await worker.healthzCall(0, null, {
    public: answer("not a ray"),
    binding: null,
  });
  assert.equal(odd.public[0]!.ray_colo, null);
});

test("the Worker's benchmark route needs the bearer, a POST and a valid query before it touches anything", async () => {
  const env = {
    PROBE_BEARER: randomBytes(16).toString("hex"),
    INTEGRATOR_KEY: randomBytes(16).toString("hex"),
    DATABASE_ID: database,
    API_URL: `https://${["api", "test"].join(".")}`,
    ENDPOINT_HOST: ["edge", "test"].join("."),
    RUN_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  };
  const original = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = async () => {
    outside++;
    throw new Error("unexpected_provider_call");
  };
  try {
    const ask = (query: string, init: RequestInit = {}) =>
      worker.default.fetch(
        new Request(
          `https://${["probe", "test"].join(".")}/saas-bench?${query}`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
            ...init,
          },
        ),
        env,
      );
    const noBearer = await ask(`database=${database}`, { headers: {} });
    assert.equal(noBearer.status, 401);
    const get = await ask("mode=healthz", { method: "GET" });
    assert.equal(get.status, 405);
    const bad = await ask(
      `database=${database}&seed=1&call=1&scale=1&mode=sql`,
    );
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { code: "invalid_bench_request" });
    assert.equal(outside, 0);
    // The healthz mode needs no database: it reaches the Edge's public hostname once per GET
    // and reports the location the runtime gave the request.
    const hosts: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      hosts.push(new URL(input instanceof Request ? input.url : input).href);
      return answer("8d1a2b3c4d5e6f70-FRA")();
    }) as typeof fetch;
    const request = new Request(
      `https://${["probe", "test"].join(".")}/saas-bench?mode=healthz&call=0`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PROBE_BEARER}` },
      },
    );
    Object.defineProperty(request, "cf", { value: { colo: "AMS" } });
    const reply = await worker.default.fetch(request, env);
    assert.equal(reply.status, 200);
    const body = (await reply.json()) as Record<string, unknown>;
    assert.equal(body.colo, "AMS");
    assert.equal(body.binding, null);
    assert.deepEqual(
      hosts,
      Array(2).fill(`https://${env.ENDPOINT_HOST}/healthz`),
    );
  } finally {
    globalThis.fetch = original;
  }
});
