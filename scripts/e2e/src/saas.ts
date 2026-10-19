// SPDX-License-Identifier: Apache-2.0
/**
 * The pure parts of the SaaS benchmark (`saas-bench.ts`): the dataset, the request, its timing,
 * the statistics and the command line. Nothing here imports from Node, so a Worker that probes
 * from inside Cloudflare can bundle this module and report the same record.
 *
 * The request is the plan's metric (section 3.1): five statements in sequence, each one round
 * trip, as a SaaS handler issues them.
 *   1. auth     a session found by its key, joined to its user and account (the first answer);
 *   2. list     a page of 50 tasks of a project;
 *   3. counts   the project's tasks by status;
 *   4. insert   a new task, in a transaction that the update closes;
 *   5. update   a task marked done, then COMMIT.
 * Statements 4 and 5 carry the transaction's BEGIN and COMMIT in their own message, so the
 * transaction costs no round trip of its own and the request keeps the plan's five.
 *
 * Three arms send that request (`ARMS`): `ws` as above, over a WebSocket, five round trips;
 * `http-batch`, over the Edge's `POST /sql`, as one `transaction()` of the five statements (it
 * supplies the BEGIN and COMMIT), one round trip; `http-auth-then-batch`, the session lookup as a
 * query of its own and the other four as one `transaction()`, two round trips.
 */
import { isDatabaseId } from "@pgcf/contracts/ids";
import { safeProbeError } from "./transport.ts";

export const STATEMENT_NAMES = [
  "auth",
  "list",
  "counts",
  "insert",
  "update",
] as const;
export type StatementName = (typeof STATEMENT_NAMES)[number];

/** The plan's gate: the whole request under this at p95 (section 3.1). */
export const GATE_MS = 1000;

/** Row counts of the dataset at scale 1: the size of the operator's earlier benchmark. */
const DATASET = {
  accounts: 2_000,
  users: 100_000,
  sessions: 300_000,
  projects: 10_000,
  tasks: 600_000,
} as const;
type Dataset = { [table in keyof typeof DATASET]: number };

/** The row counts at `scale`: at least 100 projects and 60 tasks in each, so a list page is full. */
export function datasetSize(scale: number): Dataset {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 10)
    throw new RangeError("scale must be in (0, 10]");
  const size = (rows: number, minimum: number) =>
    Math.max(minimum, Math.round(rows * scale));
  const projects = size(DATASET.projects, 100);
  return {
    accounts: size(DATASET.accounts, 3),
    users: size(DATASET.users, 10),
    sessions: size(DATASET.sessions, 10),
    projects,
    tasks: projects * 60,
  };
}

const ANCHOR = "TIMESTAMPTZ '2026-10-01 00:00+00'";

/** The statements that create and seed the dataset, one message each. */
export function setupStatements(scale: number): string[] {
  const n = datasetSize(scale);
  return [
    "DROP TABLE IF EXISTS tasks, projects, sessions, users, accounts CASCADE",
    "CREATE TABLE accounts(id int PRIMARY KEY, name text NOT NULL, plan text NOT NULL)",
    `INSERT INTO accounts SELECT g, 'Account ' || g, (ARRAY['free','pro','team'])[1 + g % 3] FROM generate_series(1, ${n.accounts}) g`,
    "CREATE TABLE users(id int PRIMARY KEY, account_id int NOT NULL REFERENCES accounts, email text NOT NULL UNIQUE, name text NOT NULL, last_seen timestamptz, created_at timestamptz NOT NULL)",
    `INSERT INTO users SELECT g, 1 + g % ${n.accounts}, 'user' || g || '@example.com', 'User ' || g, ${ANCHOR} - (g % 1000) * interval '1 minute', ${ANCHOR} - (g % 365) * interval '1 day' FROM generate_series(1, ${n.users}) g`,
    "CREATE INDEX users_account ON users(account_id)",
    "CREATE TABLE sessions(token uuid PRIMARY KEY, user_id int NOT NULL, last_used timestamptz NOT NULL)",
    `INSERT INTO sessions SELECT md5(g::text)::uuid, 1 + g % ${n.users}, ${ANCHOR} - (g % 5000) * interval '1 second' FROM generate_series(1, ${n.sessions}) g`,
    "CREATE INDEX sessions_user ON sessions(user_id)",
    "CREATE TABLE projects(id int PRIMARY KEY, account_id int NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL)",
    `INSERT INTO projects SELECT g, 1 + g % ${n.accounts}, 'Project ' || g, ${ANCHOR} - (g % 700) * interval '1 day' FROM generate_series(1, ${n.projects}) g`,
    "CREATE INDEX projects_account ON projects(account_id)",
    "CREATE TABLE tasks(id bigserial PRIMARY KEY, project_id int NOT NULL, assignee_id int NOT NULL, status text NOT NULL, title text NOT NULL, body text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)",
    // Every project gets the same number of tasks, and its statuses cycle through all four.
    `INSERT INTO tasks(project_id, assignee_id, status, title, body, created_at, updated_at) SELECT 1 + g % ${n.projects}, 1 + (g * 7) % ${n.users}, (ARRAY['open','doing','review','done'])[1 + (g / ${n.projects}) % 4], 'Task ' || g, repeat('lorem ipsum dolor sit amet ', 6), ${ANCHOR} - g * interval '1 second', ${ANCHOR} FROM generate_series(1, ${n.tasks}) g`,
    "CREATE INDEX tasks_project_created ON tasks(project_id, created_at DESC)",
    "CREATE INDEX tasks_assignee ON tasks(assignee_id)",
    "VACUUM (ANALYZE)",
  ];
}

export interface Statement {
  readonly name: StatementName;
  readonly sql: string;
  /** The rows the statement's last result has on a dataset of this scale; a different count fails the call. */
  readonly rows: number;
}

/** A small deterministic generator (mulberry32), so the same seed and call give the same request. */
function generator(seed: number, call: number): () => number {
  let state =
    (Math.imul(seed, 0x9e3779b1) ^ Math.imul(call + 1, 0x85ebca6b)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The five statements of call number `call`; `transaction` puts the BEGIN and COMMIT into messages 4 and 5. */
function statementsOf(
  seed: number,
  call: number,
  scale: number,
  transaction: boolean,
): Statement[] {
  const n = datasetSize(scale);
  const random = generator(seed, call);
  const session = 1 + Math.floor(random() * n.sessions);
  // Low project ids are the busy ones, as in a SaaS with a few large customers.
  const project = 1 + Math.floor(random() ** 3 * n.projects);
  const task = 1 + Math.floor(random() * n.tasks);
  const user = 1 + (session % n.users);
  return [
    {
      name: "auth",
      sql: `SELECT s.user_id, u.account_id, u.email, a.plan FROM sessions s JOIN users u ON u.id = s.user_id JOIN accounts a ON a.id = u.account_id WHERE s.token = md5('${session}')::uuid`,
      rows: 1,
    },
    {
      name: "list",
      sql: `SELECT id, title, status, created_at FROM tasks WHERE project_id = ${project} ORDER BY created_at DESC LIMIT 50`,
      rows: 50,
    },
    {
      name: "counts",
      sql: `SELECT status, count(*) FROM tasks WHERE project_id = ${project} GROUP BY status`,
      rows: 4,
    },
    {
      name: "insert",
      sql: `${transaction ? "BEGIN; " : ""}INSERT INTO tasks(project_id, assignee_id, status, title, body, created_at, updated_at) VALUES (${project}, ${user}, 'open', 'bench', 'x', now(), now()) RETURNING id`,
      rows: 1,
    },
    {
      name: "update",
      sql: `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = ${task}${transaction ? "; COMMIT" : ""}`,
      rows: 0,
    },
  ];
}

/**
 * The request of call number `call` of a run seeded `seed`: its keys differ from every other
 * call's, so no call is served from the cache a neighbour warmed. Every interpolated value is an
 * integer this function computed.
 */
export function buildRequest(
  seed: number,
  call: number,
  scale: number,
): Statement[] {
  return statementsOf(seed, call, scale, true);
}

/** The same request for `transaction()` over HTTP, which supplies the BEGIN and COMMIT itself. */
export function buildBatch(
  seed: number,
  call: number,
  scale: number,
): Statement[] {
  return statementsOf(seed, call, scale, false);
}

export const ARMS = ["ws", "http-batch", "http-auth-then-batch"] as const;
export type Arm = (typeof ARMS)[number];

/** The statements one round trip carries. */
export type Trip = readonly Statement[];

/** The round trips `arm` makes for call number `call`, in order. */
export function buildTrips(
  arm: Arm,
  seed: number,
  call: number,
  scale: number,
): Trip[] {
  if (arm === "ws")
    return buildRequest(seed, call, scale).map((statement) => [statement]);
  const batch = buildBatch(seed, call, scale);
  return arm === "http-batch" ? [batch] : [batch.slice(0, 1), batch.slice(1)];
}

/** The arm database number `index` (from 0) takes in round `round` (from 1): the arms take turns. */
export function armFor(
  arms: readonly Arm[],
  index: number,
  round: number,
): Arm {
  return arms[(index + round - 1) % arms.length]!;
}

/** One open session: a statement's last result as its row count. */
export interface Session {
  query(sql: string): Promise<number>;
  /** A session over HTTP: the statements as one transaction in one request, each one's row count. */
  transaction?(sqls: readonly string[]): Promise<number[]>;
  end(): Promise<void>;
  /** On the clock of the call: when the WebSocket opened, if the session can tell. */
  readonly socketOpenedAt?: number;
  /** A session over HTTP opens no connection before its first request, so it has no connect time. */
  readonly connectionless?: true;
}

/** What a call measured. Times are milliseconds from the start of the call, rounded to 0.1. */
export interface Timed {
  ok: boolean;
  /** Until the connection was ready: the wake, when the database was cold. */
  connect_ms?: number;
  /** Until the WebSocket upgrade was answered: Edge admission and the Tunnel, before any wake. */
  ws_open_ms?: number;
  /** Until the first statement's result. */
  first_answer_ms?: number;
  /** Until the last statement's result: the plan's metric. */
  request_ms?: number;
  /** Each round trip's own time, in order: a statement's on a WebSocket, a transaction's over HTTP. */
  statements_ms: number[];
  /**
   * Where a failed call stopped: the check that the database was asleep (made by the driver, not
   * by the call), the connection, or the statement that failed (the first of a transaction whose
   * statement the driver cannot name). Over HTTP, which has no connect step, the first request is
   * the connection as well: its admission refusal, unready wake, wrong password, network or
   * server error is `connect`, as on a WebSocket; a statement's own error names the statement.
   */
  failed_at?: "cold_check" | "connect" | StatementName;
  error?: {
    error_class: string;
    sqlstate: string | null;
    errno: string | null;
  };
  /** Set by the driver: the follow-up requests after this call that failed. */
  followup_failures?: number;
  /** Set by the probe Worker: the Cloudflare location it ran in, null when the runtime does not say. */
  colo?: string | null;
}

class UnexpectedResult extends Error {
  readonly code = "unexpected_result";
  constructor() {
    super("unexpected_result");
    this.name = "Error";
  }
}

export const tenth = (value: number) => Math.round(value * 10) / 10;

/**
 * Whether a failure tells of the connection, not of a statement: class 08, an admission refusal,
 * a wake not ready, a wrong password, or no SQLSTATE at all (a network or server error).
 */
const connectionFailure = (sqlstate: string | null) =>
  sqlstate === null ||
  sqlstate.startsWith("08") ||
  ["53300", "57P03", "28P01"].includes(sqlstate);

/**
 * Opens a session and sends `trips` on it in order, each one a single round trip; a failure ends
 * the call and is recorded. The request ends with the last answer, so a call of one round trip has
 * its first answer as its whole request.
 */
export async function timeCall(
  open: () => Promise<Session>,
  trips: readonly Trip[],
  now: () => number = () => performance.now(),
): Promise<Timed> {
  const started = now();
  const timed: Timed = { ok: false, statements_ms: [] };
  let session: Session | undefined;
  let at: "connect" | StatementName = "connect";
  try {
    session = await open();
    if (!session.connectionless) timed.connect_ms = tenth(now() - started);
    if (session.socketOpenedAt !== undefined)
      timed.ws_open_ms = tenth(session.socketOpenedAt - started);
    let last = started;
    for (const trip of trips) {
      at = trip[0]!.name;
      const sent = now();
      const rows =
        trip.length === 1
          ? [await session.query(trip[0]!.sql)]
          : await session.transaction!(trip.map((statement) => statement.sql));
      last = now();
      timed.statements_ms.push(tenth(last - sent));
      timed.first_answer_ms ??= tenth(last - started);
      for (const [index, statement] of trip.entries()) {
        at = statement.name;
        if (rows[index] !== statement.rows) throw new UnexpectedResult();
      }
    }
    timed.request_ms = tenth(last - started);
    timed.ok = true;
  } catch (error) {
    timed.error = safeProbeError(error);
    timed.failed_at =
      session?.connectionless &&
      timed.statements_ms.length === 0 &&
      connectionFailure(timed.error.sqlstate)
        ? "connect"
        : at;
    if ((error as { code?: unknown } | null)?.code === "unexpected_result")
      timed.error.error_class = "UnexpectedResult";
  } finally {
    await session?.end().catch(() => undefined);
  }
  return timed;
}

/** The nearest-rank percentile of `samples`, or null for none. */
export function percentile(
  samples: readonly number[],
  p: number,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * How many requests ran until one was within `tolerance` of warm, counting that one (1 when the
 * first already was). Warm is the median of the later half of `requests`; null when none got there.
 */
export function requestsUntilWarm(
  requests: readonly number[],
  tolerance = 0.25,
): number | null {
  if (requests.length < 2) return null;
  const warm = percentile(
    requests.slice(Math.floor(requests.length / 2)),
    0.5,
  )!;
  const index = requests.findIndex((ms) => ms <= warm * (1 + tolerance));
  return index < 0 ? null : index + 1;
}

export interface Summary {
  calls: number;
  /** Calls that failed, among them those not made because the database was not asleep. */
  failures: number;
  /** Follow-up requests that failed after a cold call that did not. */
  followup_failures: number;
  request_ms: { p50: number | null; p95: number | null };
  first_answer_ms: { p50: number | null; p95: number | null };
  connect_ms: { p50: number | null; p95: number | null };
  /** The plan's gate: every call and follow-up succeeded and the whole request's p95 is under it. */
  gate_met: boolean;
}

/** The p50 and p95 of the calls that succeeded, and how many did not. */
export function summarize(calls: readonly Timed[]): Summary {
  const done = calls.filter((call) => call.ok);
  const column = (pick: (call: Timed) => number | undefined) => {
    const values = done.map(pick).filter((v): v is number => v !== undefined);
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
  };
  const request = column((call) => call.request_ms);
  const followupFailures = calls.reduce(
    (sum, call) => sum + (call.followup_failures ?? 0),
    0,
  );
  return {
    calls: calls.length,
    failures: calls.length - done.length,
    followup_failures: followupFailures,
    request_ms: request,
    first_answer_ms: column((call) => call.first_answer_ms),
    connect_ms: column((call) => call.connect_ms),
    gate_met:
      calls.length > 0 &&
      done.length === calls.length &&
      followupFailures === 0 &&
      request.p95 !== null &&
      request.p95 < GATE_MS,
  };
}

/** log(e^a + e^b) without leaving the range a double can hold. */
const logAdd = (a: number, b: number) =>
  Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));

/**
 * The most misses (requests over the gate, or failed) that `n` cold samples may have and still
 * show a p95 under it with 95 % confidence, or null when `n` is too small for any: the largest
 * `k` for which a binomial(n, 0.05) has at most 5 % chance of `k` or fewer. Distribution-free:
 * 59 samples allow 0 misses, 93 allow 1 and 124 allow 2.
 */
export function allowedMisses(n: number): number | null {
  const limit = Math.log(0.05);
  const ratio = Math.log(0.05 / 0.95);
  // The log of P(X = k), built term by term, and of P(X <= k).
  let term = n * Math.log(0.95);
  let cumulative = term;
  if (cumulative > limit) return null;
  for (let k = 0; k < n; k++) {
    term += Math.log((n - k) / (k + 1)) + ratio;
    const next = logAdd(cumulative, term);
    if (next > limit) return k;
    cumulative = next;
  }
  return n;
}

export interface Verdict {
  /** Cold samples of the arm, a failed or skipped call among them. */
  n: number;
  /** Misses: the calls that failed and the requests that did not finish under the gate. */
  over_1s: number;
  allowed_over_1s: number | null;
  /** `met`: the whole request's p95 is under the gate with 95 % confidence; `too_few`: no result could show it. */
  result: "met" | "not_met" | "too_few";
}

export interface ArmSummary extends Summary {
  verdict: Verdict;
}

/** The summary of one arm's cold samples, with the verdict of the distribution-free rule on the whole request. */
export function summarizeArm(calls: readonly Timed[]): ArmSummary {
  const over = calls.filter(
    (call) => !(call.ok && call.request_ms! < GATE_MS),
  ).length;
  const allowed = allowedMisses(calls.length);
  return {
    ...summarize(calls),
    verdict: {
      n: calls.length,
      over_1s: over,
      allowed_over_1s: allowed,
      result:
        allowed === null ? "too_few" : over <= allowed ? "met" : "not_met",
    },
  };
}

/** One GET of `/healthz`: until the answer was read, its status, and the location in the `cf-ray` header. */
export interface GetTiming {
  ms: number;
  status: number;
  ray_colo: string | null;
}

/** What the probe Worker answers for `mode=healthz`: two back-to-back GETs on each path. */
export interface HealthzSample {
  colo: string | null;
  public: GetTiming[];
  /** Null when the Worker has no service binding to the Edge. */
  binding: GetTiming[] | null;
}

/**
 * Whether a sample is one to count: the Worker answered, and every GET was answered 200. The time
 * of a 403, 502 or 530 is that of an error page, not of the Edge.
 */
export function healthzAnswered(sample: HealthzSample | null): boolean {
  return (
    sample !== null &&
    [...sample.public, ...(sample.binding ?? [])].every(
      (get) => get.status === 200,
    )
  );
}

/**
 * The p50 and p95 of the first and of the second GET on each path. A sample that failed (null) or
 * has a GET not answered 200 counts in none of them, only in `failures`.
 */
export function summarizeHealthz(samples: readonly (HealthzSample | null)[]) {
  const done = samples.filter(
    (sample): sample is HealthzSample =>
      sample !== null && healthzAnswered(sample),
  );
  const column = (path: "public" | "binding", call: 0 | 1) => {
    const values = done.flatMap((sample) => sample[path]?.[call]?.ms ?? []);
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
  };
  return {
    samples: samples.length,
    failures: samples.length - done.length,
    public: { first: column("public", 0), second: column("public", 1) },
    binding: { first: column("binding", 0), second: column("binding", 1) },
  };
}

/** A command line or environment that cannot be used; its message names the flag or variable, never a value. */
export class UsageError extends Error {}

export type Via = "local" | "probe";

export type Command =
  | { command: "setup"; database: string; scale: number }
  | {
      command: "call";
      database: string;
      arms: Arm[];
      via: Via;
      seed: number;
      scale: number;
      idleS: number;
      followups: number;
    }
  | {
      command: "run";
      databases: string[];
      arms: Arm[];
      via: Via;
      seed: number;
      scale: number;
      idleS: number;
      followups: number;
      rounds: number;
      parallel: boolean;
    }
  | { command: "healthz"; samples: number; idleS: number };

export const USAGE = `usage:
  saas-bench setup   --database <id> [--scale <n>]
  saas-bench call    --database <id> [--idle-s <s>] [--followups <n>] [--mode ${ARMS.join("|")}] [--via local|probe] [--seed <n>] [--scale <n>]
  saas-bench run     --databases <id,id,...> --rounds <n> --idle-s <s> [--mode <arm,arm,...>] [--followups <n>] [--parallel] [--via local|probe] [--seed <n>] [--scale <n>]
  saas-bench healthz [--samples <n>] [--idle-s <s>]`;

/** Reads the command line; throws a message, never a credential, for a line that does not parse. */
export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (
    command !== "setup" &&
    command !== "call" &&
    command !== "run" &&
    command !== "healthz"
  )
    throw new UsageError(USAGE);
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (!flag.startsWith("--"))
      throw new UsageError(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    if (name === "parallel") {
      options.set(name, true);
      continue;
    }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--"))
      throw new UsageError(`--${name} needs a value`);
    if (options.has(name)) throw new UsageError(`--${name} given twice`);
    options.set(name, value);
  }
  const known: Record<string, readonly string[]> = {
    setup: ["database", "scale"],
    call: ["database", "idle-s", "followups", "mode", "via", "seed", "scale"],
    run: [
      "databases",
      "rounds",
      "idle-s",
      "followups",
      "mode",
      "parallel",
      "via",
      "seed",
      "scale",
    ],
    healthz: ["samples", "idle-s"],
  };
  for (const name of options.keys())
    if (!known[command]!.includes(name))
      throw new UsageError(`unknown --${name}`);
  const integer = (name: string, fallback: number | null, minimum: number) => {
    const raw = options.get(name);
    if (raw === undefined) {
      if (fallback === null) throw new UsageError(`--${name} is required`);
      return fallback;
    }
    if (
      typeof raw !== "string" ||
      !/^[0-9]{1,9}$/.test(raw) ||
      Number(raw) < minimum
    )
      throw new UsageError(
        `--${name} must be an integer of at least ${minimum}`,
      );
    return Number(raw);
  };
  const scale = (() => {
    const raw = options.get("scale");
    if (raw === undefined) return 1;
    const value = typeof raw === "string" ? Number(raw) : NaN;
    try {
      datasetSize(value);
    } catch {
      throw new UsageError("--scale must be a number in (0, 10]");
    }
    return value;
  })();
  const database = (name: string, raw: string | true | undefined) => {
    if (typeof raw !== "string" || !isDatabaseId(raw))
      throw new UsageError(`--${name} needs database ids`);
    return raw;
  };
  const via = (): Via => {
    const raw = options.get("via") ?? "local";
    if (raw !== "local" && raw !== "probe")
      throw new UsageError("--via must be local or probe");
    return raw;
  };
  const arms = (): Arm[] => {
    const raw = options.get("mode") ?? "ws";
    const list = typeof raw === "string" ? raw.split(",") : [];
    if (
      !list.every((arm): arm is Arm =>
        (ARMS as readonly string[]).includes(arm),
      ) ||
      new Set(list).size !== list.length
    )
      throw new UsageError(`--mode needs distinct arms of ${ARMS.join(", ")}`);
    return list;
  };
  if (command === "setup")
    return {
      command,
      database: database("database", options.get("database")),
      scale,
    };
  if (command === "healthz")
    return {
      command,
      samples: integer("samples", 30, 1),
      idleS: integer("idle-s", 0, 0),
    };
  const common = {
    arms: arms(),
    via: via(),
    seed: integer("seed", 1, 0),
    scale,
    idleS: integer("idle-s", command === "call" ? 0 : null, 0),
    followups: integer("followups", 0, 0),
  };
  if (command === "call") {
    if (common.arms.length !== 1)
      throw new UsageError("--mode takes one arm for a call");
    return {
      command,
      database: database("database", options.get("database")),
      ...common,
    };
  }
  const list = options.get("databases");
  const databases = typeof list === "string" ? list.split(",") : [];
  if (databases.length === 0 || new Set(databases).size !== databases.length)
    throw new UsageError("--databases needs distinct database ids");
  for (const id of databases) database("databases", id);
  const rounds = integer("rounds", null, 1);
  // Each database takes each arm equally often only over whole turns of the arms.
  if (rounds % common.arms.length !== 0)
    throw new UsageError(
      "--rounds must be a multiple of the number of --mode arms",
    );
  return {
    command,
    databases,
    rounds,
    parallel: options.get("parallel") === true,
    ...common,
  };
}
