// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

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
  via?: string;
  ok?: boolean;
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

/** A probe Worker that answers call number `n` (0-based) with `answers(n)`. */
async function startProbe(answers: (call: number) => object) {
  const asked: { method?: string; authorization?: string; url?: string }[] = [];
  const server = createServer((request, response) => {
    asked.push({
      method: request.method,
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answers(asked.length - 1)));
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
