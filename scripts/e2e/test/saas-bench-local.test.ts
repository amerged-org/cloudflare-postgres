// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { startRig } from "../../../apps/edge/bench/rig.ts";
import { ARMS, setupStatements } from "../src/saas.ts";

// The probe Worker imports a module that only the Workers runtime has; its benchmark never opens it.
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
const binaries = process.env.PGCF_TEST_POSTGRES_BINDIR;
assert.ok(
  binaries || !process.env.CI,
  "PGCF_TEST_POSTGRES_BINDIR must name PostgreSQL 18 in CI",
);

/** The dataset in the database "postgres", where the rig's /sql shim runs its statements. */
function seedShimDatabase(port: number, password: string): void {
  for (const sql of setupStatements(0.01))
    execFileSync(
      join(binaries!, "psql"),
      [
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "app",
        "-d",
        "postgres",
        "-c",
        sql,
      ],
      {
        env: { PATH: process.env.PATH ?? "", PGPASSWORD: password },
        stdio: "ignore",
      },
    );
}

function bench(
  args: string[],
  env: Record<string, string>,
): Promise<{
  code: number | null;
  lines: Record<string, unknown>[];
  stderr: string;
}> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (bytes: Buffer) => (stdout += bytes));
    child.stderr.on("data", (bytes: Buffer) => (stderr += bytes));
    child.on("close", (code) =>
      done({
        code,
        lines: stdout
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .map((line) => JSON.parse(line) as Record<string, unknown>),
        stderr,
      }),
    );
  });
}

test(
  "the benchmark sets up, calls and runs through the production Edge on a real PostgreSQL",
  {
    skip:
      !binaries && "PGCF_TEST_POSTGRES_BINDIR names no PostgreSQL 18 binaries",
  },
  async () => {
    const password = randomBytes(16).toString("hex");
    const rig = await startRig({ password });
    const { database } = rig.workerd;
    const key = randomBytes(16).toString("hex");
    // The management API's two routes the benchmark reads: the database's state, which must be
    // asleep for a cold call, and the role's connection URI.
    let observedState = "hibernated";
    const api = createServer((request, response) => {
      const authorized = request.headers.authorization === `Bearer ${key}`;
      const answer =
        authorized && request.url === `/v1/databases/${database}`
          ? { observed_state: observedState, effective_sleep_after_seconds: 60 }
          : authorized &&
              request.url ===
                `/v1/databases/${database}/roles/app/connection-uri`
            ? {
                uri: `postgres://app:${password}@127.0.0.1:${rig.workerd.port}/${database}`,
                includes_password: true,
              }
            : null;
      response.writeHead(answer ? 200 : 404, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(answer ?? {}));
    });
    await new Promise<void>((done) => api.listen(0, "127.0.0.1", done));
    const env = {
      PGCF_API_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`,
      PGCF_API_KEY: key,
    };
    try {
      const setup = await bench(
        ["setup", "--database", database, "--scale", "0.01"],
        env,
      );
      assert.equal(setup.code, 0, setup.stderr);
      assert.equal(setup.lines.length, 17);
      const call = await bench(
        [
          "call",
          "--database",
          database,
          "--scale",
          "0.01",
          "--idle-s",
          "60",
          "--followups",
          "3",
        ],
        env,
      );
      assert.equal(call.code, 0, call.stderr);
      const [record] = call.lines;
      assert.equal(record!.ok, true);
      assert.equal(record!.db, database);
      assert.equal(record!.idle_s, 60);
      assert.equal(record!.observed_state_before, "hibernated");
      assert.equal((record!.statements_ms as number[]).length, 5);
      assert.equal((record!.followups_ms as number[]).length, 3);
      const { connect_ms, ws_open_ms, first_answer_ms, request_ms } =
        record as Record<string, number>;
      assert.ok(ws_open_ms! > 0 && ws_open_ms! <= connect_ms!);
      assert.ok(
        connect_ms! < first_answer_ms! && first_answer_ms! < request_ms!,
      );
      assert.ok(Number.isInteger(record!.requests_until_warm));
      const run = await bench(
        [
          "run",
          "--databases",
          database,
          "--rounds",
          "3",
          "--idle-s",
          "0",
          "--scale",
          "0.01",
        ],
        env,
      );
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.lines.length, 4);
      assert.deepEqual(
        run.lines.slice(0, 3).map((line) => line.round),
        [1, 2, 3],
      );
      const summary = run.lines[3]!.summary as {
        calls: number;
        failures: number;
      };
      assert.equal(summary.calls, 3);
      assert.equal(summary.failures, 0);
      // The shim of the rig runs HTTP requests in the database "postgres", not in the database the
      // WebSocket reaches by its startup message: the dataset goes there too.
      seedShimDatabase(rig.postgres.port, password);
      // The HTTP arms go through the Edge's /sql: the batch is one round trip, the lookup and the
      // transaction after it two, and neither has a connection to time.
      for (const arm of ["http-batch", "http-auth-then-batch"]) {
        const http = await bench(
          [
            "call",
            "--database",
            database,
            "--scale",
            "0.01",
            "--mode",
            arm,
            "--followups",
            "2",
          ],
          env,
        );
        assert.equal(http.code, 0, http.stderr);
        const [line] = http.lines;
        assert.equal(line!.ok, true, JSON.stringify(line!.error));
        assert.equal(line!.arm, arm);
        assert.equal(line!.connect_ms, undefined);
        assert.equal(line!.ws_open_ms, undefined);
        assert.equal(
          (line!.statements_ms as number[]).length,
          arm === "http-batch" ? 1 : 2,
        );
        if (arm === "http-batch")
          assert.equal(line!.first_answer_ms, line!.request_ms);
        else assert.ok(line!.first_answer_ms! < line!.request_ms!);
        assert.equal((line!.followups_ms as number[]).length, 2);
        for (const secret of [key, password])
          assert.ok(!JSON.stringify(http).includes(secret));
      }
      // The three arms take turns on the one database, one round each.
      const arms = await bench(
        [
          "run",
          "--databases",
          database,
          "--rounds",
          "3",
          "--idle-s",
          "0",
          "--scale",
          "0.01",
          "--mode",
          ARMS.join(","),
        ],
        env,
      );
      assert.equal(arms.code, 0, arms.stderr);
      assert.deepEqual(
        arms.lines.slice(0, 3).map((line) => line.arm),
        [...ARMS],
      );
      const verdicts = arms.lines[3]!.arms as Record<
        string,
        { verdict: { n: number } }
      >;
      assert.deepEqual(
        Object.entries(verdicts).map(([arm, { verdict }]) => [arm, verdict.n]),
        ARMS.map((arm) => [arm, 1]),
      );
      // The probe Worker's own code opens the same arms, with the runtime's WebSocket and fetch,
      // and answers with its location; the socket's open time reaches only the WebSocket arm.
      const uri = `postgres://app:${password}@127.0.0.1:${rig.workerd.port}/${database}`;
      for (const arm of ARMS) {
        const answered = await worker.benchCall(
          { arm, database, seed: 5, call: 1, scale: 0.01 },
          uri,
          "FRA",
        );
        assert.equal(answered.ok, true, JSON.stringify(answered.error));
        assert.equal(answered.colo, "FRA");
        if (arm === "ws")
          assert.ok(
            answered.ws_open_ms! > 0 &&
              answered.ws_open_ms! <= answered.connect_ms!,
          );
        else assert.equal(answered.ws_open_ms, undefined);
        assert.ok(!JSON.stringify(answered).includes(password));
      }
      // A database that is awake is not timed as cold: no connection is opened for the call.
      observedState = "ready";
      const awake = await bench(
        ["call", "--database", database, "--scale", "0.01"],
        env,
      );
      assert.equal(awake.code, 1);
      assert.equal(awake.lines[0]!.failed_at, "cold_check");
      assert.equal(awake.lines[0]!.observed_state_before, "ready");
      assert.equal(awake.lines[0]!.connect_ms, undefined);
      observedState = "hibernated";
      // A dataset of another scale answers other row counts: the call fails, it is not timed as fast.
      const wrong = await bench(
        ["call", "--database", database, "--scale", "1"],
        env,
      );
      assert.equal(wrong.code, 1);
      assert.equal(wrong.lines[0]!.ok, false);
      assert.equal(wrong.lines[0]!.failed_at, "auth");
      // Neither the key nor the password reaches the output.
      for (const output of [setup, call, run, awake, wrong])
        for (const secret of [key, password])
          assert.ok(!JSON.stringify(output).includes(secret));
    } finally {
      api.close();
      await rig.stop();
    }
  },
);
