// SPDX-License-Identifier: Apache-2.0
/**
 * HTTP SQL: `POST /sql` in the wire format of the Neon serverless driver's HTTP query mode
 * (`neon()`, `transaction()`). Each request is admitted as a WebSocket connection is admitted (the
 * same limiters, in buckets of their own, and the DatabaseActor's admission), signed a route and
 * forwarded once to the region's gateway, which runs it on a pooled PostgreSQL session
 * (`apps/native-gateway/src/sql.rs`). The Edge never retries a forwarded request: an answer that
 * does not come from the gateway is reported as an unknown outcome (08007).
 *
 * The password of the connection string goes to the gateway in the request body only; it is
 * never logged, and neither are statements or parameters.
 */
import { isDatabaseId, isRoleName } from "@pgcf/contracts";
import {
  ROUTE_TOKEN_HEADER,
  parseRouteKeyring,
  signLegacyRouteToken,
  signRouteToken,
  signWakeRouteToken,
} from "@pgcf/contracts/route-token";
import type { DatabaseWakeAdmission, Env } from "./env.ts";
import type { GatewayRegion } from "./gateway.ts";
import { ADMISSION_DEADLINE_MS, connectionRateKey } from "./session-policy.ts";

/** The largest body the gateway accepts (`MAX_REQUEST_BYTES` in the gateway's sql.rs). */
export const MAX_SQL_REQUEST_BYTES = 4 * 1024 * 1024;
/** The most statements of one transaction (`MAX_STATEMENTS` in the gateway's sql.rs). */
export const MAX_SQL_STATEMENTS = 256;
const ISOLATION_LEVELS = new Set([
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
]);

class SqlFailure extends Error {
  readonly code: string;
  readonly severity: string;
  constructor(code: string, message: string, severity = "ERROR") {
    super(message);
    this.code = code;
    this.severity = severity;
  }
}
const invalid = () => new SqlFailure("08P01", "invalid HTTP SQL request");
const authenticationFailed = () =>
  new SqlFailure("28P01", "password authentication failed", "FATAL");
const unknownOutcome = () =>
  new SqlFailure(
    "08007",
    "the gateway's answer was lost; the request's outcome is unknown and it was not retried",
  );

interface Connection {
  readonly database: string;
  readonly user: string;
  readonly password: string;
}
interface Statement {
  readonly query: string;
  readonly params: (string | null)[];
}
interface Transaction {
  isolation?: string;
  read_only?: boolean;
  deferrable?: boolean;
}
/** Milliseconds of each stage that ran, logged with the request. */
interface Timings {
  limiters_ms?: number;
  admit_ms?: number;
  route?: "v5" | "v4" | "v3" | "v2";
  token_ms?: number;
  gateway_ms?: number;
  gateway_status?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The database, role and password of `Neon-Connection-String`; its host and options are not used. */
function connection(headers: Headers): Connection {
  let url: URL;
  try {
    url = new URL(headers.get("Neon-Connection-String") ?? "");
  } catch {
    throw invalid();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw invalid();
  let database: string, user: string, password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw invalid();
  }
  if (!isDatabaseId(database))
    throw new SqlFailure("3D000", "database does not exist");
  if (!isRoleName(user)) throw new SqlFailure("28P01", "authentication failed");
  if (password === "") throw authenticationFailed();
  return { database, user, password };
}

/** What the driver always sends, and a batch's transaction characteristics. */
function transaction(headers: Headers): Transaction {
  if (
    headers.get("Neon-Raw-Text-Output")?.toLowerCase() !== "true" ||
    headers.get("Neon-Array-Mode")?.toLowerCase() !== "true"
  )
    throw new SqlFailure(
      "0A000",
      "only raw text results in array mode are supported",
    );
  if (headers.has("Authorization"))
    throw new SqlFailure("0A000", "authorization tokens are not supported");
  const characteristics: Transaction = {};
  const isolation = headers.get("Neon-Batch-Isolation-Level");
  if (isolation !== null) {
    if (!ISOLATION_LEVELS.has(isolation)) throw invalid();
    characteristics.isolation = isolation;
  }
  for (const [header, key] of [
    ["Neon-Batch-Read-Only", "read_only"],
    ["Neon-Batch-Deferrable", "deferrable"],
  ] as const) {
    const value = headers.get(header);
    if (value === null) continue;
    if (value !== "true" && value !== "false") throw invalid();
    characteristics[key] = value === "true";
  }
  return characteristics;
}

/** The body, read up to the gateway's bound. */
async function readBody(request: Request): Promise<string> {
  const tooLarge = () => new SqlFailure("54000", "request is too large");
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_SQL_REQUEST_BYTES)
    throw tooLarge();
  if (request.body === null) throw invalid();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SQL_REQUEST_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw invalid();
  }
}

function statement(value: unknown): Statement {
  if (
    !isObject(value) ||
    typeof value.query !== "string" ||
    !Object.keys(value).every((key) => key === "query" || key === "params")
  )
    throw invalid();
  const params = value.params ?? [];
  if (!Array.isArray(params)) throw invalid();
  return {
    query: value.query,
    // The driver sends text or null; other JSON scalars are sent as their text.
    params: params.map((param: unknown) => {
      if (param === null || typeof param === "string") return param;
      if (typeof param === "number" || typeof param === "boolean")
        return String(param);
      throw invalid();
    }),
  };
}

/** One statement (`{query, params}`) or a transaction (`{queries}`). */
function statements(text: string): {
  queries: Statement[];
  batch: boolean;
} {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isObject(body)) throw invalid();
  if (!("queries" in body)) return { queries: [statement(body)], batch: false };
  if (
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.queries) ||
    body.queries.length > MAX_SQL_STATEMENTS
  )
    throw invalid();
  return { queries: body.queries.map(statement), batch: true };
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * The admission of `index.ts`, ending in a signed route instead of a WebSocket: both limiters
 * and the Actor's admission run together, and the Actor's refusals answer as they do there.
 */
async function admitRoute(
  request: Request,
  env: Env,
  target: Connection,
  cid: string,
  signal: AbortSignal,
  ctx: ExecutionContext,
  timings: Timings,
): Promise<{ region: GatewayRegion; token: string }> {
  const network = connectionRateKey(request.headers.get("CF-Connecting-IP"));
  if (network === null)
    throw new SqlFailure("53300", "connection rate limit exceeded");
  const actor = env.DATABASE_ACTOR.get(
    env.DATABASE_ACTOR.idFromName(target.database),
  );
  const cancel = () =>
    ctx.waitUntil(
      Promise.resolve()
        .then(() => actor.cancelWakeWaiter(target.database, cid))
        .catch(() => false),
    );
  signal.addEventListener("abort", cancel, { once: true });
  const started = Date.now();
  const limited = async (limiter: RateLimit, key: string) =>
    limiter.limit({ key }).finally(() => {
      timings.limiters_ms = Math.max(
        timings.limiters_ms ?? 0,
        Date.now() - started,
      );
    });
  let results: [
    PromiseSettledResult<RateLimitOutcome>,
    PromiseSettledResult<RateLimitOutcome>,
    PromiseSettledResult<DatabaseWakeAdmission>,
  ];
  try {
    results = await Promise.allSettled([
      // HTTP requests count in buckets of their own, so queries never take WebSocket handshakes.
      limited(
        env.CONNECTION_RATE_LIMITER,
        JSON.stringify(["sql", target.database, target.user, network]),
      ),
      limited(
        env.DATABASE_CONNECTION_RATE_LIMITER,
        JSON.stringify(["sql", target.database]),
      ),
      actor
        .admitWake(target.database, target.user, {
          deadline: Date.now() + ADMISSION_DEADLINE_MS,
          waiterId: cid,
        })
        .finally(() => {
          timings.admit_ms = Date.now() - started;
        }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (signal.aborted)
    throw new SqlFailure("08006", "connection admission interrupted");
  const [connectionLimit, databaseLimit, admission] = results;
  if (
    connectionLimit.status === "rejected" ||
    databaseLimit.status === "rejected"
  )
    throw new SqlFailure("53300", "connection admission unavailable");
  if (!connectionLimit.value.success)
    throw new SqlFailure("53300", "connection rate limit exceeded");
  if (!databaseLimit.value.success)
    throw new SqlFailure("53300", "database connection rate limit exceeded");
  if (admission.status === "rejected") throw admission.reason;
  const admitted = admission.value;
  if (!admitted.ok) {
    switch (admitted.sqlstate) {
      case "3D000":
      case "28P01":
        throw authenticationFailed();
      case "57P03":
        throw new SqlFailure("57P03", "database is not accepting connections");
      case "53300":
        throw new SqlFailure(
          "53300",
          "database connection rate limit exceeded",
        );
      default:
        throw new SqlFailure("08006", "gateway connection failed");
    }
  }
  const connection = {
    keyring: parseRouteKeyring(env.ROUTE_MASTER_KEYS),
    region: admitted.region.id,
    db: target.database,
    user: target.user,
    cid,
  };
  const tokenStarted = Date.now();
  let token: string;
  if ("wake" in admitted) {
    timings.route = "v5";
    token = await signWakeRouteToken({ ...connection, wake: admitted.wake });
  } else if (admitted.target) {
    timings.route = admitted.target.route_revision === undefined ? "v3" : "v4";
    token = await signRouteToken({ ...connection, target: admitted.target });
  } else {
    timings.route = "v2";
    token = await signLegacyRouteToken(connection);
  }
  timings.token_ms = Date.now() - tokenStarted;
  return { region: admitted.region, token };
}

/** The admission, bounded as a WebSocket connection's is: 60 s, and the client's abort. */
async function boundedAdmission(
  request: Request,
  env: Env,
  target: Connection,
  cid: string,
  ctx: ExecutionContext,
  timings: Timings,
): Promise<{ region: GatewayRegion; token: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const interrupted = new Promise<never>((_resolve, reject) => {
    const refuse = () =>
      reject(new SqlFailure("08006", "connection admission interrupted"));
    if (controller.signal.aborted) refuse();
    else controller.signal.addEventListener("abort", refuse, { once: true });
  });
  const timer = setTimeout(abort, ADMISSION_DEADLINE_MS);
  const admission = Promise.race([
    interrupted,
    admitRoute(request, env, target, cid, controller.signal, ctx, timings),
  ]);
  ctx.waitUntil(
    admission.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await admission;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

/** Sends the request to the gateway once and passes its answer through. */
async function forward(
  region: GatewayRegion,
  token: string,
  body: string,
  env: Env,
  signal: AbortSignal,
  timings: Timings,
): Promise<Response> {
  const url = new URL(region.gateway_url);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (region.gateway_binding === null && url.protocol !== "https:") ||
    url.username ||
    url.password
  )
    throw new SqlFailure("08006", "gateway connection failed");
  url.pathname = "/sql";
  let send: (request: Request) => Promise<Response> = (request) =>
    fetch(request);
  if (region.gateway_binding !== null) {
    // Only an explicit configured service binding may bypass global fetch.
    const binding = env[region.gateway_binding];
    if (
      typeof binding !== "object" ||
      binding === null ||
      !("fetch" in binding) ||
      typeof binding.fetch !== "function"
    )
      throw new SqlFailure("08006", "gateway connection failed");
    send = (request) => (binding as Fetcher).fetch(request);
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await send(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [ROUTE_TOKEN_HEADER]: token,
        },
        body,
        redirect: "manual",
        signal,
      }),
    );
  } catch {
    throw unknownOutcome();
  } finally {
    timings.gateway_ms = Date.now() - started;
  }
  timings.gateway_status = response.status;
  const typed = response.headers
    .get("Content-Type")
    ?.startsWith("application/json");
  if (response.status === 200 && typed)
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  if (response.status === 400 && typed) {
    const text = await response.text();
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = null;
    }
    if (isObject(answer) && typeof answer.code === "string")
      return new Response(text, {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
  } else {
    await response.body?.cancel();
  }
  throw unknownOutcome();
}

export async function serveSql(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const started = Date.now();
  const cid = crypto.randomUUID();
  const timings: Timings = {};
  let target: Connection | null = null;
  let region: string | null = null;
  let outcome = "accepted";
  try {
    if (request.method !== "POST")
      throw new SqlFailure("08P01", "HTTP SQL requires POST");
    target = connection(request.headers);
    const characteristics = transaction(request.headers);
    const { queries, batch } = statements(await readBody(request));
    if (batch && queries.length === 0) return json({ results: [] }, 200);
    const body = JSON.stringify({
      password: base64url(target.password),
      queries,
      ...(batch ? { transaction: characteristics } : {}),
    });
    if (new TextEncoder().encode(body).byteLength > MAX_SQL_REQUEST_BYTES)
      throw new SqlFailure("54000", "request is too large");
    const admitted = await boundedAdmission(
      request,
      env,
      target,
      cid,
      ctx,
      timings,
    );
    region = admitted.region.id;
    return await forward(
      admitted.region,
      admitted.token,
      body,
      env,
      request.signal,
      timings,
    );
  } catch (error) {
    const failure =
      error instanceof SqlFailure
        ? error
        : new SqlFailure("08006", "gateway connection failed");
    outcome = failure.code;
    return json(
      {
        message: failure.message,
        code: failure.code,
        severity: failure.severity,
      },
      400,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: "sql_admission",
        cid,
        database_id: target?.database ?? null,
        user: target?.user ?? null,
        region_id: region,
        duration_ms: Math.max(0, Date.now() - started),
        ...timings,
        outcome,
      }),
    );
  }
}
