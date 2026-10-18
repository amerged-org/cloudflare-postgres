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
      sql: `BEGIN; INSERT INTO tasks(project_id, assignee_id, status, title, body, created_at, updated_at) VALUES (${project}, ${user}, 'open', 'bench', 'x', now(), now()) RETURNING id`,
      rows: 1,
    },
    {
      name: "update",
      sql: `UPDATE tasks SET status = 'done', updated_at = now() WHERE id = ${task}; COMMIT`,
      rows: 0,
    },
  ];
}

/** One open session: a statement's last result as its row count. */
export interface Session {
  query(sql: string): Promise<number>;
  end(): Promise<void>;
  /** On the clock of the call: when the WebSocket opened, if the session can tell. */
  readonly socketOpenedAt?: number;
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
  /** Each statement's own round trip, in the order of `STATEMENT_NAMES`. */
  statements_ms: number[];
  /**
   * Where a failed call stopped: the check that the database was asleep (made by the driver, not
   * by the call), the connection, or the statement that failed.
   */
  failed_at?: "cold_check" | "connect" | StatementName;
  error?: {
    error_class: string;
    sqlstate: string | null;
    errno: string | null;
  };
  /** Set by the driver: the follow-up requests after this call that failed. */
  followup_failures?: number;
}

class UnexpectedResult extends Error {
  readonly code = "unexpected_result";
  constructor() {
    super("unexpected_result");
    this.name = "Error";
  }
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/** Opens a session and runs `statements` on it in order; a failure ends the call and is recorded. */
export async function timeCall(
  open: () => Promise<Session>,
  statements: readonly Statement[],
  now: () => number = () => performance.now(),
): Promise<Timed> {
  const started = now();
  const timed: Timed = { ok: false, statements_ms: [] };
  let session: Session | undefined;
  let at: "connect" | StatementName = "connect";
  try {
    session = await open();
    timed.connect_ms = tenth(now() - started);
    if (session.socketOpenedAt !== undefined)
      timed.ws_open_ms = tenth(session.socketOpenedAt - started);
    for (const statement of statements) {
      at = statement.name;
      const sent = now();
      const rows = await session.query(statement.sql);
      const answered = now();
      timed.statements_ms.push(tenth(answered - sent));
      timed.first_answer_ms ??= tenth(answered - started);
      if (rows !== statement.rows) throw new UnexpectedResult();
    }
    timed.request_ms = tenth(now() - started);
    timed.ok = true;
  } catch (error) {
    timed.failed_at = at;
    timed.error = safeProbeError(error);
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

/** A command line or environment that cannot be used; its message names the flag or variable, never a value. */
export class UsageError extends Error {}

export type Via = "local" | "probe";

export type Command =
  | { command: "setup"; database: string; scale: number }
  | {
      command: "call";
      database: string;
      via: Via;
      seed: number;
      scale: number;
      idleS: number;
      followups: number;
    }
  | {
      command: "run";
      databases: string[];
      via: Via;
      seed: number;
      scale: number;
      idleS: number;
      followups: number;
      rounds: number;
      parallel: boolean;
    };

export const USAGE = `usage:
  saas-bench setup --database <id> [--scale <n>]
  saas-bench call  --database <id> [--idle-s <s>] [--followups <n>] [--via local|probe] [--seed <n>] [--scale <n>]
  saas-bench run   --databases <id,id,...> --rounds <n> --idle-s <s> [--followups <n>] [--parallel] [--via local|probe] [--seed <n>] [--scale <n>]`;

/** Reads the command line; throws a message, never a credential, for a line that does not parse. */
export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (command !== "setup" && command !== "call" && command !== "run")
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
    call: ["database", "idle-s", "followups", "via", "seed", "scale"],
    run: [
      "databases",
      "rounds",
      "idle-s",
      "followups",
      "parallel",
      "via",
      "seed",
      "scale",
    ],
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
  if (command === "setup")
    return {
      command,
      database: database("database", options.get("database")),
      scale,
    };
  const common = {
    via: via(),
    seed: integer("seed", 1, 0),
    scale,
    idleS: integer("idle-s", command === "call" ? 0 : null, 0),
    followups: integer("followups", 0, 0),
  };
  if (command === "call")
    return {
      command,
      database: database("database", options.get("database")),
      ...common,
    };
  const list = options.get("databases");
  const databases = typeof list === "string" ? list.split(",") : [];
  if (databases.length === 0 || new Set(databases).size !== databases.length)
    throw new UsageError("--databases needs distinct database ids");
  for (const id of databases) database("databases", id);
  return {
    command,
    databases,
    rounds: integer("rounds", null, 1),
    parallel: options.get("parallel") === true,
    ...common,
  };
}
