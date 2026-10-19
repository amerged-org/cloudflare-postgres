// SPDX-License-Identifier: Apache-2.0
/**
 * The SaaS benchmark: the plan's metric (section 3.1), measured through the real Edge hostname
 * with the Neon serverless driver, as an application connects.
 *
 *   node src/saas-bench.ts setup   --database <id> [--scale <n>]
 *   node src/saas-bench.ts call    --database <id> [--idle-s <s>] [--followups <n>] [--mode <arm>]
 *   node src/saas-bench.ts run     --databases <id,id,...> --rounds <n> --idle-s <s> [--mode <arm,arm,...>] [--parallel]
 *   node src/saas-bench.ts healthz [--samples <n>] [--idle-s <s>]
 *
 * `setup` creates and seeds the dataset the request reads (scale 1 is about 510 MB; a smaller
 * `--scale` loads faster). `call` runs the request once on a fresh connection and prints one JSON
 * line: connect_ms (the wake, when the database was cold), ws_open_ms (the Edge's share of it),
 * first_answer_ms, request_ms and statements_ms (one entry per round trip). The caller lets the
 * database sleep first; `--idle-s` is the time it was idle, recorded in the line. A cold call is
 * made only when the management API reports the database `hibernated` (recorded as
 * observed_state_before): one that is awake, or whose state cannot be read, is a failed call
 * (failed_at cold_check) and is never timed as cold. `--followups n` runs n more requests on fresh
 * connections after it and adds their request_ms and the number of requests until one was within
 * 25 % of warm; a follow-up that fails ends the series and is kept in the line (followup_failures,
 * followup_failed_at, followup_error). `run` makes the call on each database in every round,
 * waiting `--idle-s` between rounds so that the databases sleep by themselves (the first round
 * starts at once: the caller has let them sleep), and ends with a summary line: p50 and p95 of
 * connect, first answer and request, the failure and follow-up failure counts and whether the gate
 * (p95 under 1 s, no failure) was met. It exits 1 when a call or a follow-up failed.
 *
 * `--mode` picks the arm that sends the request (saas.ts, `ARMS`): `ws` (the default; a WebSocket,
 * five round trips), `http-batch` (the Edge's `POST /sql`, one `transaction()` of the five
 * statements) or `http-auth-then-batch` (the session lookup as a query, then a `transaction()` of
 * the other four). `run` takes several, `--mode ws,http-batch,http-auth-then-batch`, and compares
 * them on the same databases: a database is cold once per round, so each round gives each database
 * one arm and the arms take turns by round and by database (`--rounds` is a whole number of
 * turns, so each database meets each arm equally often). The last line then also holds `arms`: for
 * each arm its summary and the verdict of the distribution-free rule on the whole request (n,
 * misses over 1 s with failures counted as misses, and whether the p95 is shown under 1 s: 59
 * samples allow no miss, 93 one, 124 two). The HTTP arms use a connection of their own per call.
 *
 * `healthz` has the probe Worker time two back-to-back `GET /healthz` calls on the public hostname
 * and on its service binding to the Edge (the Edge answers them without admission), `--samples`
 * times with `--idle-s` between samples, and prints a line per sample and a summary: the p50 and
 * p95 of the first and of the second call on each path.
 *
 * `--via probe` makes each call from inside Cloudflare instead of from this machine: a probe
 * Worker (`probe/worker.ts`, route `/saas-bench`, deployed privately) answers
 * `POST <url>?database=<id>&seed=<n>&call=<n>&scale=<n>&mode=<arm>` with the same record `timeCall`
 * produces (its fields `ok`, `connect_ms`, `first_answer_ms`, `request_ms`, `statements_ms`,
 * `ws_open_ms` for a WebSocket, `failed_at`, `error`) and `colo`, the Cloudflare location the
 * Worker ran in. It bundles `saas.ts` and `saas-session.ts`, which import nothing from Node.
 *
 * Environment variables (names only; their values never enter the repository or the output):
 *   PGCF_API_URL, PGCF_API_KEY   the management API and an integrator key of the database's
 *                                project; the database's state is read from it before every
 *                                cold call, and the role's connection URI, whose host is the
 *                                Edge hostname the benchmark connects to, for `--via local`
 *   PGCF_BENCH_ROLE              the role to connect as (default app)
 *   PGCF_BENCH_PROBE_URL, PGCF_BENCH_PROBE_TOKEN
 *                                the probe Worker's `/saas-bench` route and its bearer token, for
 *                                `--via probe` and `healthz`
 */
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";
import { neonConfig } from "@neondatabase/serverless";
import { WebSocket } from "ws";
import {
  armFor,
  buildTrips,
  parseCommand,
  requestsUntilWarm,
  setupStatements,
  summarize,
  summarizeArm,
  summarizeHealthz,
  timeCall,
  UsageError,
  type Arm,
  type Command,
  type HealthzSample,
  type Session,
  type Timed,
} from "./saas.ts";
import { CONNECT_TIMEOUT_MS, openHttp, openWebSocket } from "./saas-session.ts";
import { safeProbeError } from "./transport.ts";

function environment(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`set ${name}`);
  return value;
}

/** A GET of the management API under the integrator key: its JSON answer. */
async function api(path: string, what: string): Promise<unknown> {
  const response = await fetch(new URL(path, environment("PGCF_API_URL")), {
    headers: { Authorization: `Bearer ${environment("PGCF_API_KEY")}` },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${what} refused (${response.status})`);
  return response.json();
}

/** The role's connection URI from the management API: the Edge host, the database, the password. */
async function connectionUri(database: string): Promise<string> {
  const role = process.env.PGCF_BENCH_ROLE ?? "app";
  const body = (await api(
    `/v1/databases/${database}/roles/${encodeURIComponent(role)}/connection-uri`,
    "connection URI",
  )) as {
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

/** The connections of the call that is sending, so that no call borrows one a neighbour warmed. */
const connections = new AsyncLocalStorage<{
  http: http.Agent;
  https: https.Agent;
}>();

// The driver's `fetch` is global; this one sends on the connection of the call that asks.
neonConfig.fetchFunction = (address: string, init: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(address);
    const secure = target.protocol === "https:";
    const request = (secure ? https : http).request(
      target,
      {
        method: init.method,
        headers: init.headers as Record<string, string>,
        agent: connections.getStore()![secure ? "https" : "http"],
        timeout: CONNECT_TIMEOUT_MS,
      },
      (reply) => {
        const chunks: Buffer[] = [];
        reply.on("data", (chunk: Buffer) => chunks.push(chunk));
        reply.on("error", reject);
        reply.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: reply.statusCode }),
          ),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end(init.body as string);
  });

/** HTTP queries on connections the session owns: a call's requests share them, no other call does. */
function openOwnHttp(uri: string): Session {
  const own = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  const session = openHttp(uri);
  return {
    connectionless: true,
    query: (sql) => connections.run(own, () => session.query(sql)),
    transaction: (sqls) =>
      connections.run(own, () => session.transaction!(sqls)),
    async end() {
      own.http.destroy();
      own.https.destroy();
    },
  };
}

/** One session of the Neon driver as `arm` opens it: on the Edge's `/v2` WebSocket, or its `/sql`. */
function open(uri: string, arm: Arm = "ws"): Promise<Session> {
  return arm === "ws"
    ? openWebSocket(
        uri,
        (address) => new WebSocket(address, { perMessageDeflate: false }),
      )
    : Promise.resolve(openOwnHttp(uri));
}

/** The probe Worker's answer to a POST with `params`, or an error: the shape is checked by the caller. */
async function askProbe(params: Record<string, string>): Promise<unknown> {
  const url = new URL(environment("PGCF_BENCH_PROBE_URL"));
  const token = environment("PGCF_BENCH_PROBE_TOKEN");
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(150_000),
  });
  return response.json();
}

/** One call from a probe Worker; its answer is checked for its shape and nothing else. */
async function probe(
  database: string,
  seed: number,
  call: number,
  scale: number,
  arm: Arm,
): Promise<Timed> {
  try {
    const body = (await askProbe({
      database,
      seed: String(seed),
      call: String(call),
      scale: String(scale),
      mode: arm,
    })) as Timed;
    if (typeof body.ok !== "boolean" || !Array.isArray(body.statements_ms))
      throw new Error("not a record");
    return body;
  } catch (error) {
    // A missing variable is a usage error; any other failure is a probe that did not answer.
    if (error instanceof UsageError) throw error;
    return {
      ok: false,
      statements_ms: [],
      failed_at: "connect",
      error: { error_class: "ProbeUnavailable", sqlstate: null, errno: null },
    };
  }
}

type Calling = Extract<Command, { command: "call" | "run" }>;

/** One request of `arm` on a fresh connection: from this machine, or from the probe Worker. */
async function request(
  options: Calling,
  arm: Arm,
  database: string,
  call: number,
): Promise<Timed> {
  if (options.via === "probe")
    return probe(database, options.seed, call, options.scale, arm);
  try {
    const uri = await connectionUri(database);
    return await timeCall(
      () => open(uri, arm),
      buildTrips(arm, options.seed, call, options.scale),
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

/** The state the management API reports for a database: `hibernated` while it sleeps. */
async function observedState(database: string): Promise<string> {
  const body = (await api(`/v1/databases/${database}`, "database")) as {
    observed_state?: unknown;
  };
  if (typeof body.observed_state !== "string")
    throw new Error("the database state is missing");
  return body.observed_state;
}

/**
 * The cold request of a database, made only when the API reports it asleep: a database that is
 * awake would be timed warm, and one whose state cannot be read cannot be shown to be cold.
 */
async function coldRequest(
  options: Calling,
  arm: Arm,
  database: string,
  call: number,
): Promise<{ before?: string; cold: Timed }> {
  const skipped = (error_class: string): Timed => ({
    ok: false,
    statements_ms: [],
    failed_at: "cold_check",
    error: { error_class, sqlstate: null, errno: null },
  });
  let before: string;
  try {
    before = await observedState(database);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    // The reason can name the API's address; the line carries only its class.
    return { cold: skipped("Unavailable") };
  }
  if (before !== "hibernated") return { before, cold: skipped("NotCold") };
  return { before, cold: await request(options, arm, database, call) };
}

/** The cold request of a database, then its follow-ups: one record, printed as one line. */
async function measure(
  options: Calling,
  arm: Arm,
  database: string,
  round: number,
  calls: { next: number },
): Promise<Timed> {
  const { before, cold } = await coldRequest(
    options,
    arm,
    database,
    calls.next++,
  );
  const record: Record<string, unknown> = {
    db: database,
    round,
    arm,
    via: options.via,
    idle_s: options.idleS,
    at: new Date().toISOString(),
    observed_state_before: before,
    ...cold,
  };
  if (options.followups > 0 && cold.ok) {
    const requests = [cold.request_ms!];
    let broken: Timed | undefined;
    for (let n = 0; n < options.followups && !broken; n++) {
      const next = await request(options, arm, database, calls.next++);
      if (next.ok) requests.push(next.request_ms!);
      else broken = next;
    }
    record.followups_ms = requests.slice(1);
    if (broken) {
      // A failed request ends the series: it is kept, and no "until warm" is claimed from it.
      cold.followup_failures = 1;
      record.followup_failures = 1;
      record.followup_failed_at = broken.failed_at;
      record.followup_error = broken.error;
      record.requests_until_warm = null;
    } else record.requests_until_warm = requestsUntilWarm(requests);
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

/** Whether the probe's answer is two GETs on the public hostname and, if it has one, on the binding. */
function isHealthz(body: unknown): body is HealthzSample {
  const gets = (value: unknown) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((get) => typeof get?.ms === "number");
  const sample = body as Partial<HealthzSample> | null;
  return (
    gets(sample?.public) && (sample?.binding === null || gets(sample?.binding))
  );
}

/** Two back-to-back GETs of `/healthz` on each path, made by the probe Worker. */
async function probeHealthz(call: number): Promise<HealthzSample | null> {
  try {
    const body = await askProbe({ mode: "healthz", call: String(call) });
    return isHealthz(body) ? body : null;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    return null;
  }
}

async function healthz(samples: number, idleS: number): Promise<number> {
  const results: (HealthzSample | null)[] = [];
  for (let n = 0; n < samples; n++) {
    if (n > 0 && idleS > 0)
      await new Promise((done) => setTimeout(done, idleS * 1000));
    const sample = await probeHealthz(n);
    results.push(sample);
    console.log(
      JSON.stringify({ healthz: n + 1, ok: sample !== null, ...sample }),
    );
  }
  const summary = summarizeHealthz(results);
  console.log(JSON.stringify({ healthz_summary: summary }));
  return summary.failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const options = parseCommand(process.argv.slice(2));
  if (options.command === "setup") {
    await setup(options.database, options.scale);
    return 0;
  }
  if (options.command === "healthz")
    return healthz(options.samples, options.idleS);
  const calls = { next: 0 };
  if (options.command === "call") {
    const measured = await measure(
      options,
      options.arms[0]!,
      options.database,
      1,
      calls,
    );
    return measured.ok && !measured.followup_failures ? 0 : 1;
  }
  const results: Timed[] = [];
  const byArm = new Map<Arm, Timed[]>(options.arms.map((arm) => [arm, []]));
  for (let round = 1; round <= options.rounds; round++) {
    if (round > 1 && options.idleS > 0)
      await new Promise((done) => setTimeout(done, options.idleS * 1000));
    // A database is cold once per round: it gets one arm, and the arms take turns.
    const measureOn = async (database: string, index: number) => {
      const arm = armFor(options.arms, index, round);
      const measured = await measure(options, arm, database, round, calls);
      byArm.get(arm)!.push(measured);
      return measured;
    };
    if (options.parallel)
      results.push(...(await Promise.all(options.databases.map(measureOn))));
    else
      for (const [index, database] of options.databases.entries())
        results.push(await measureOn(database, index));
  }
  const summary = summarize(results);
  const arms = Object.fromEntries(
    [...byArm].map(([arm, calls]) => [arm, summarizeArm(calls)]),
  );
  console.log(JSON.stringify({ summary, arms }));
  return summary.failures === 0 && summary.followup_failures === 0 ? 0 : 1;
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
