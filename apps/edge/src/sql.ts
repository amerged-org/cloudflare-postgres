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
import { isDatabaseId, isRoleName } from "@pgcf/contracts/ids";
import { ROUTE_TOKEN_HEADER } from "@pgcf/contracts/route-token";
import {
  AdmissionFailure,
  admitRoute,
  bounded,
  edgeShare,
  nextIsolateRequest,
  type AdmissionTimings,
} from "./admission.ts";
import type { Env } from "./env.ts";
import type { GatewayRegion } from "./gateway.ts";

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
interface Timings extends AdmissionTimings {
  /** Reading and understanding the body: a client that uploads slowly shows here, not in edge_ms. */
  body_ms?: number;
  /** The statements of the request, counted and never logged. */
  statements?: number;
  /** The gateway's answer, from the send to its response head. */
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
  const isolateRequests = nextIsolateRequest();
  const cid = crypto.randomUUID();
  const timings: Timings = {};
  let target: Connection | null = null;
  let region: string | null = null;
  let outcome = "accepted";
  try {
    if (request.method !== "POST")
      throw new SqlFailure("08P01", "HTTP SQL requires POST");
    const routed = (target = connection(request.headers));
    const characteristics = transaction(request.headers);
    const bodyStarted = Date.now();
    let understood: ReturnType<typeof statements>;
    try {
      understood = statements(await readBody(request));
    } finally {
      timings.body_ms = Date.now() - bodyStarted;
    }
    const { queries, batch } = understood;
    timings.statements = queries.length;
    if (batch && queries.length === 0) return json({ results: [] }, 200);
    const body = JSON.stringify({
      password: base64url(routed.password),
      queries,
      ...(batch ? { transaction: characteristics } : {}),
    });
    if (new TextEncoder().encode(body).byteLength > MAX_SQL_REQUEST_BYTES)
      throw new SqlFailure("54000", "request is too large");
    // HTTP requests count in buckets of their own, so queries never take WebSocket handshakes.
    const admitted = await bounded(request, ctx, (signal, deadline) =>
      admitRoute(request, env, routed, cid, signal, deadline, ctx, timings, [
        "sql",
      ]),
    ).catch((error: unknown) => {
      if (!(error instanceof AdmissionFailure)) throw error;
      throw error.decoy
        ? authenticationFailed()
        : new SqlFailure(error.sqlstate, error.message);
    });
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
    const duration = Math.max(0, Date.now() - started);
    console.log(
      JSON.stringify({
        event: "sql_admission",
        cid,
        // The Cloudflare location that admitted the request; none on a service binding.
        colo: request.cf?.colo ?? null,
        database_id: target?.database ?? null,
        user: target?.user ?? null,
        region_id: region,
        // From the request's arrival to the response head: the body streams after it.
        duration_ms: duration,
        // The part of it that was the Edge's own: all but the client's upload and the gateway.
        edge_ms: edgeShare(duration, timings.body_ms, timings.gateway_ms),
        // The database requests this isolate has taken, this one included; 1 is its first.
        isolate_requests: isolateRequests,
        ...timings,
        outcome,
      }),
    );
  }
}
