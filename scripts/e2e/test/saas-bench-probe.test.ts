// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
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

test("a probe call asks the Worker for the request and prints its record with the call's identity", async () => {
  const token = randomBytes(16).toString("hex");
  const asked: { method?: string; authorization?: string; url?: string }[] = [];
  const probe = createServer((request, response) => {
    asked.push({
      method: request.method,
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        connect_ms: 120.5,
        first_answer_ms: 400.1,
        request_ms: 900.7,
        statements_ms: [1, 2, 3, 4, 5],
      }),
    );
  });
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(probe.address() as { port: number }).port}/bench`;
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
      { PGCF_BENCH_PROBE_URL: url, PGCF_BENCH_PROBE_TOKEN: token },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      asked.map((request) => [request.method, request.authorization]),
      [
        ["POST", `Bearer ${token}`],
        ["POST", `Bearer ${token}`],
      ],
    );
    // Each call is a number of its own, so the Worker builds another request each time.
    assert.deepEqual(
      asked.map((request) => {
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
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.deepEqual(
      {
        db: lines[0].db,
        round: lines[0].round,
        via: lines[0].via,
        ok: lines[0].ok,
      },
      { db: database, round: 1, via: "probe", ok: true },
    );
    assert.equal(lines[0].request_ms, 900.7);
    assert.equal(lines[2].summary.failures, 0);
    assert.equal(lines[2].summary.gate_met, true);
    assert.ok(!result.stdout.includes(token));
  } finally {
    probe.close();
  }
});

test("a probe that does not answer is a failed call, and a missing variable is named, not its value", async () => {
  const refused = await bench(
    ["call", "--database", database, "--via", "probe"],
    {
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
    {},
  );
  assert.equal(unset.code, 2);
  assert.equal(unset.stderr.trim(), "set PGCF_BENCH_PROBE_URL");
  const nothing = await bench(["call", "--database", database], {});
  assert.equal(nothing.code, 2);
  assert.equal(nothing.stderr.trim(), "set PGCF_API_URL");
});
