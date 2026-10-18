// SPDX-License-Identifier: Apache-2.0
/**
 * The SaaS benchmark: the plan's metric (section 3.1), measured through the real Edge hostname
 * with the Neon serverless driver over its WebSocket, as an application connects.
 *
 *   node src/saas-bench.ts setup --database <id> [--scale <n>]
 *   node src/saas-bench.ts call  --database <id> [--idle-s <s>] [--followups <n>]
 *   node src/saas-bench.ts run   --databases <id,id,...> --rounds <n> --idle-s <s> [--parallel]
 *
 * `setup` creates and seeds the dataset the request reads (scale 1 is about 510 MB; a smaller
 * `--scale` loads faster). `call` runs the request once on a fresh connection and prints one JSON
 * line: connect_ms (the wake, when the database was cold), ws_open_ms (the Edge's share of it),
 * first_answer_ms, request_ms and statements_ms. The caller lets the database sleep first;
 * `--idle-s` is the time it was idle, recorded in the line. `--followups n` runs n more requests
 * on fresh connections after it and adds their request_ms and the number of requests until one
 * was within 25 % of warm. `run` makes the call on each database in every round, waiting
 * `--idle-s` between rounds so that the databases sleep by themselves (the first round starts
 * at once: the caller has let them sleep), and ends with a summary line: p50 and p95 of
 * connect, first answer and request, the failure count and whether the gate (p95 under 1 s,
 * no failure) was met. It exits 1 when a call failed.
 *
 * `--via probe` makes each call from inside Cloudflare instead of from this machine: a probe
 * Worker, deployed privately, answers `POST <url>?database=<id>&seed=<n>&call=<n>&scale=<n>` with
 * the same record `timeCall` produces (its fields `ok`, `connect_ms`, `first_answer_ms`,
 * `request_ms`, `statements_ms`, optionally `ws_open_ms`, `failed_at`, `error`). The Worker can
 * bundle `saas.ts`, which imports nothing from Node.
 *
 * Environment variables (names only; their values never enter the repository or the output):
 *   PGCF_API_URL, PGCF_API_KEY   the management API and an integrator key of the database's
 *                                project; the role's connection URI is read from it, and its host
 *                                is the Edge hostname the benchmark connects to
 *   PGCF_BENCH_ROLE              the role to connect as (default app)
 *   PGCF_BENCH_PROBE_URL, PGCF_BENCH_PROBE_TOKEN
 *                                the probe Worker and its bearer token, for `--via probe`
 */
import { Client } from "@neondatabase/serverless";
import { WebSocket } from "ws";
import {
  buildRequest,
  parseCommand,
  requestsUntilWarm,
  setupStatements,
  summarize,
  timeCall,
  UsageError,
  type Command,
  type Session,
  type Timed,
} from "./saas.ts";
import { safeProbeError } from "./transport.ts";

/** Longer than the Edge's 60 s bound on a wake, so a slow wake is measured, not cut off. */
const CONNECT_TIMEOUT_MS = 90_000;

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`set ${name}`);
  return value;
}

/** The role's connection URI from the management API: the Edge host, the database, the password. */
async function connectionUri(database: string): Promise<string> {
  const role = process.env.PGCF_BENCH_ROLE ?? "app";
  const response = await fetch(
    new URL(
      `/v1/databases/${database}/roles/${encodeURIComponent(role)}/connection-uri`,
      environment("PGCF_API_URL"),
    ),
    {
      headers: { Authorization: `Bearer ${environment("PGCF_API_KEY")}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`connection URI refused (${response.status})`);
  const body = (await response.json()) as {
    uri?: unknown;
    includes_password?: unknown;
  };
  if (typeof body.uri !== "string" || body.includes_password !== true)
    throw new Error("the connection URI carries no password");
  const url = new URL(body.uri);
  if (
    url.protocol !== "postgres:" ||
    decodeURIComponent(url.pathname.slice(1)) !== database
  )
    throw new Error("the connection URI names another database");
  return body.uri;
}

/** One session of the Neon driver on the Edge's `/v2`, the way the driver connects by default. */
async function open(uri: string): Promise<Session> {
  const url = new URL(uri);
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  const opened: { at?: number } = {};
  class TimedSocket extends WebSocket {
    constructor(address: string | URL) {
      super(address, { perMessageDeflate: false });
      this.once("open", () => (opened.at = performance.now()));
    }
  }
  const client = new Client({
    connectionString: uri,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // A loopback endpoint is a local stack; every other host is reached over TLS.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  client.neonConfig.webSocketConstructor =
    TimedSocket as unknown as typeof client.neonConfig.webSocketConstructor;
  client.neonConfig.useSecureWebSocket = !local;
  client.neonConfig.pipelineConnect = "password";
  client.neonConfig.forceDisablePgSSL = true;
  client.neonConfig.wsProxy = () =>
    `${url.host}/v2?${new URLSearchParams({ database, user })}`;
  await client.connect();
  return {
    async query(sql) {
      const result = await client.query(sql);
      // A message of several statements answers with one result each: the last one counts.
      const last = Array.isArray(result) ? result.at(-1) : result;
      return last?.rows.length ?? 0;
    },
    end: () => client.end(),
    get socketOpenedAt() {
      return opened.at;
    },
  };
}

/** One call from a probe Worker; its answer is checked for its shape and nothing else. */
async function probe(
  database: string,
  seed: number,
  call: number,
  scale: number,
): Promise<Timed> {
  const url = new URL(environment("PGCF_BENCH_PROBE_URL"));
  const token = environment("PGCF_BENCH_PROBE_TOKEN");
  url.search = new URLSearchParams({
    database,
    seed: String(seed),
    call: String(call),
    scale: String(scale),
  }).toString();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(150_000),
    });
    const body = (await response.json()) as Timed;
    if (typeof body.ok !== "boolean" || !Array.isArray(body.statements_ms))
      throw new Error("not a record");
    return body;
  } catch {
    return {
      ok: false,
      statements_ms: [],
      failed_at: "connect",
      error: { error_class: "ProbeUnavailable", sqlstate: null, errno: null },
    };
  }
}

type Calling = Extract<Command, { command: "call" | "run" }>;

/** One request on a fresh connection: from this machine, or from the probe Worker. */
async function request(
  options: Calling,
  database: string,
  call: number,
): Promise<Timed> {
  if (options.via === "probe")
    return probe(database, options.seed, call, options.scale);
  try {
    const uri = await connectionUri(database);
    return await timeCall(
      () => open(uri),
      buildRequest(options.seed, call, options.scale),
    );
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // The reason can name the endpoint's credentials; the line carries only its class.
    return {
      ok: false,
      statements_ms: [],
      failed_at: "connect",
      error: { error_class: "Unavailable", sqlstate: null, errno: null },
    };
  }
}

/** The cold request of a database, then its follow-ups: one record, printed as one line. */
async function measure(
  options: Calling,
  database: string,
  round: number,
  calls: { next: number },
): Promise<Timed> {
  const cold = await request(options, database, calls.next++);
  const record: Record<string, unknown> = {
    db: database,
    round,
    via: options.via,
    idle_s: options.idleS,
    at: new Date().toISOString(),
    ...cold,
  };
  if (options.followups > 0 && cold.ok) {
    const requests = [cold.request_ms!];
    for (let n = 0; n < options.followups; n++) {
      const next = await request(options, database, calls.next++);
      if (!next.ok) break;
      requests.push(next.request_ms!);
    }
    record.followups_ms = requests.slice(1);
    record.requests_until_warm = requestsUntilWarm(requests);
  }
  console.log(JSON.stringify(record));
  return cold;
}

async function setup(database: string, scale: number): Promise<void> {
  const session = await open(await connectionUri(database));
  try {
    const statements = setupStatements(scale);
    for (const [index, sql] of statements.entries()) {
      const started = performance.now();
      await session.query(sql);
      console.log(
        JSON.stringify({
          setup: index + 1,
          of: statements.length,
          ms: Math.round(performance.now() - started),
        }),
      );
    }
  } finally {
    await session.end().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const options = parseCommand(process.argv.slice(2));
  if (options.command === "setup") {
    await setup(options.database, options.scale);
    return 0;
  }
  const calls = { next: 0 };
  if (options.command === "call") {
    return (await measure(options, options.database, 1, calls)).ok ? 0 : 1;
  }
  const results: Timed[] = [];
  for (let round = 1; round <= options.rounds; round++) {
    if (round > 1 && options.idleS > 0)
      await new Promise((done) => setTimeout(done, options.idleS * 1000));
    if (options.parallel)
      results.push(
        ...(await Promise.all(
          options.databases.map((database) =>
            measure(options, database, round, calls),
          ),
        )),
      );
    else
      for (const database of options.databases)
        results.push(await measure(options, database, round, calls));
  }
  const summary = summarize(results);
  console.log(JSON.stringify({ summary }));
  return summary.failures === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // A usage error names a flag or a variable; any other failure is reported by its class alone.
  console.error(
    error instanceof UsageError
      ? error.message
      : JSON.stringify(safeProbeError(error)),
  );
  process.exitCode = 2;
}
