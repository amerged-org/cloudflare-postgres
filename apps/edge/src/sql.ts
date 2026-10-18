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
import {
  MAX_SQL_REQUEST_BYTES,
  SqlFailure,
  authenticationFailed,
  connection,
  decodeBody,
  forwardBody,
  invalid,
  isObject,
  statements,
  transaction,
  unknownOutcome,
  type Connection,
} from "@pgcf/contracts/edge-sql";
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
import { readRefusal, refusalCode, type GatewayRegion } from "./gateway.ts";

/** Milliseconds of each stage that ran, logged with the request. */
interface Timings extends AdmissionTimings {
  /** Reading and understanding the body: a client that uploads slowly shows here, not in edge_ms. */
  body_ms?: number;
  /** The statements of the request, counted and never logged. */
  statements?: number;
  /** The gateway's answer, from the send to its response head. */
  gateway_ms?: number;
  gateway_status?: number;
  /** The error code of a gateway's refusal (`{"error": …}`), when it sent one. */
  gateway_error?: string;
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
  return decodeBody(bytes);
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
    timings.gateway_error = refusalCode(text);
  } else {
    timings.gateway_error = await readRefusal(response);
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
    const body = forwardBody(routed.password, understood, characteristics);
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
