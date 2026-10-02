// SPDX-License-Identifier: Apache-2.0
import { Client, Pool } from "@neondatabase/serverless";
import { connect } from "cloudflare:sockets";
import { credentialOccurrences } from "../src/audit.ts";
import { workerScanUnsupported } from "../src/transport.ts";
import { runActive } from "../src/run-expiry.ts";

interface Env {
  PROBE_BEARER: string;
  INTEGRATOR_KEY: string;
  DATABASE_ID: string;
  API_URL: string;
  ENDPOINT_HOST: string;
  RUN_EXPIRES_AT?: string;
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function validTraceMarker(marker: string | undefined): string | undefined {
  if (marker !== undefined && !/^[a-f0-9]{48}$/.test(marker))
    throw new Error("invalid_trace_marker");
  return marker;
}

export function requestTraceMarker(request: Request): string | undefined {
  return validTraceMarker(
    request.headers.get("X-PGCF-E2E-Marker") ?? undefined,
  );
}

export function connectionRequest(
  env: Pick<Env, "DATABASE_ID" | "API_URL" | "INTEGRATOR_KEY">,
  marker?: string,
): Request {
  validTraceMarker(marker);
  const url = new URL(
    `/v1/databases/${encodeURIComponent(env.DATABASE_ID)}/roles/app/connection-uri`,
    env.API_URL,
  );
  const headers = new Headers({
    Authorization: `Bearer ${env.INTEGRATOR_KEY}`,
  });
  if (marker !== undefined) {
    url.searchParams.set("pgcf_trace", marker);
    headers.set("X-PGCF-E2E-Marker", marker);
  }
  return new Request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers,
  });
}

async function connection(env: Env, marker?: string): Promise<string> {
  const reply = await fetch(connectionRequest(env, marker));
  if (!reply.ok) throw new Error("connection_metadata_failed");
  const result = (await reply.json()) as {
    uri: string;
    includes_password: boolean;
  };
  const uri = new URL(result.uri);
  if (
    uri.protocol !== "postgres:" ||
    uri.hostname !== env.ENDPOINT_HOST ||
    decodeURIComponent(uri.pathname.slice(1)) !== env.DATABASE_ID ||
    !result.includes_password ||
    !uri.password ||
    decodeURIComponent(uri.username) !== "app"
  )
    throw new Error("connection_metadata_invalid");
  return result.uri;
}

export function probePool(uri: string, marker?: string): Pool {
  validTraceMarker(marker);
  const db = new Pool({
    connectionString: uri,
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1000,
    query_timeout: 15_000,
  });
  // Pool constructs clients before it emits connect, so configure their streams here.
  db.Client = class extends Client {
    constructor(config?: ConstructorParameters<typeof Client>[0]) {
      super(config);
      this.neonConfig.useSecureWebSocket = true;
      this.neonConfig.pipelineConnect = false;
      this.neonConfig.forceDisablePgSSL = true;
      if (marker !== undefined)
        this.neonConfig.wsProxy = (host) => `${host}/v2?pgcf_trace=${marker}`;
    }
  };
  return db;
}

async function rejects(uri: string, marker?: string): Promise<void> {
  const db = probePool(uri, marker);
  try {
    let rejected = false;
    try {
      await db.query("SELECT 1");
    } catch (error: unknown) {
      // PostgreSQL errors prove protocol rejection; a network timeout does not.
      const code = (error as { code?: string }).code;
      rejected = ["28P01", "28000", "3D000", "57P03"].includes(code ?? "");
    }
    if (!rejected) throw new Error("negative_not_rejected_by_postgres");
  } finally {
    await db.end();
  }
}

async function exercise(
  uri: string,
  marker?: string,
): Promise<Record<string, number>> {
  const db = probePool(uri, marker);
  const timings: Record<string, number> = {};
  const measured = async (name: string, operation: () => Promise<unknown>) => {
    const start = performance.now();
    await operation();
    timings[name] = performance.now() - start;
  };
  try {
    await measured("cold_connect_ms", () => db.query("SELECT 1 AS result"));
    await measured("warm_read_ms", () => db.query("SELECT 1 AS result"));
    const client = await db.connect();
    try {
      await client.query("DROP TABLE IF EXISTS pgcf_e2e_rows");
      await client.query(
        "CREATE TABLE pgcf_e2e_rows (id integer PRIMARY KEY, value text NOT NULL)",
      );
      await measured("commit_ms", async () => {
        await client.query("BEGIN");
        await client.query("INSERT INTO pgcf_e2e_rows VALUES (1, 'committed')");
        await client.query("COMMIT");
      });
      await measured("rollback_ms", async () => {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO pgcf_e2e_rows VALUES (2, 'rolled_back')",
        );
        await client.query("ROLLBACK");
      });
      const result = await client.query<{ id: number; value: string }>(
        "SELECT id, value FROM pgcf_e2e_rows ORDER BY id",
      );
      if (
        result.rows.length !== 1 ||
        result.rows[0]?.id !== 1 ||
        result.rows[0]?.value !== "committed"
      )
        throw new Error("transaction_verification_failed");
    } finally {
      client.release();
    }
    for (const kind of ["password", "database", "user"] as const) {
      const wrong = new URL(uri);
      const unknown = crypto.randomUUID().replaceAll("-", "");
      if (kind === "password") wrong.password = unknown;
      if (kind === "database") wrong.pathname = `/d${unknown.slice(0, 19)}`;
      if (kind === "user") wrong.username = `r${unknown.slice(0, 19)}`;
      await measured(`negative_${kind}_ms`, () => rejects(wrong.href, marker));
    }
    return timings;
  } finally {
    await db.end();
  }
}

async function scan(
  host: string,
  ports: number[],
): Promise<{ open: number[]; checked: number; timedOut: number }> {
  // Full scans are sent in bounded batches to avoid the Worker subrequest limit.
  if (
    ports.length < 1 ||
    ports.length > 256 ||
    new Set(ports).size !== ports.length ||
    ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
    !/^[a-fA-F0-9:.]+$/.test(host)
  )
    throw new Error("invalid_scan");
  const open: number[] = [];
  let timedOut = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, ports.length) }, async () => {
      while (next < ports.length) {
        const port = ports[next++]!;
        if (workerScanUnsupported(port))
          throw new Error("worker_scan_unavailable");
        const socket = connect({ hostname: host, port });
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Attach the closed rejection handler before connect can fail.
        void socket.closed.catch(() => undefined);
        try {
          const status = await Promise.race([
            socket.opened.then(() => "open"),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("timeout"), 400);
            }),
          ]);
          if (status === "open") open.push(port);
          else timedOut++;
        } catch (error: unknown) {
          const message = String((error as { message?: string }).message ?? "");
          if (workerScanUnsupported(port, message))
            throw new Error("worker_scan_unavailable");
        } finally {
          if (timer) clearTimeout(timer);
          await socket.close().catch(() => undefined);
        }
      }
    }),
  );
  return { open: open.sort((a, b) => a - b), checked: ports.length, timedOut };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!runActive(env.RUN_EXPIRES_AT))
      return response({ code: "run_expired" }, 410);
    if (
      !env.PROBE_BEARER ||
      request.headers.get("Authorization") !== `Bearer ${env.PROBE_BEARER}`
    )
      return response({ code: "unauthorized" }, 401);
    if (request.method !== "POST")
      return response({ code: "method_not_allowed" }, 405);
    try {
      const path = new URL(request.url).pathname;
      const marker = requestTraceMarker(request);
      if (path === "/integrator-trace" && marker === undefined)
        return response({ code: "invalid_trace_marker" }, 400);
      if (path === "/scan") {
        const input = (await request.json()) as {
          host: string;
          ports: number[];
        };
        return response(await scan(input.host, input.ports));
      }
      if (path === "/refusal") {
        await rejects(
          `postgres://app@${env.ENDPOINT_HOST}/${env.DATABASE_ID}`,
          marker,
        );
        return response({ pass: true });
      }
      if (
        ![
          "/canary-audit",
          "/metadata",
          "/integrator-trace",
          "/exercise",
        ].includes(path)
      )
        return response({ code: "not_found" }, 404);
      const uri = await connection(env, marker);
      if (path === "/canary-audit") {
        const input = (await request.json()) as {
          d1: string;
          passwords: string[];
          tails: string[];
        };
        if (
          typeof input.d1 !== "string" ||
          input.d1.length > 2_000_000 ||
          !Array.isArray(input.passwords) ||
          input.passwords.length > 100 ||
          !Array.isArray(input.tails) ||
          input.tails.some((t) => typeof t !== "string" || t.length > 2_000_000)
        )
          throw new Error("audit_input_invalid");
        const password = decodeURIComponent(new URL(uri).password);
        const passwords = input.passwords.map((encoded) => atob(encoded));
        const counts = {
          d1_plaintext_occurrences: credentialOccurrences(password, [input.d1]),
          tail_plaintext_occurrences: credentialOccurrences(
            password,
            input.tails,
          ),
          matching_basic_auth_secrets: passwords.filter((p) => p === password)
            .length,
        };
        return response({
          pass:
            counts.d1_plaintext_occurrences === 0 &&
            counts.tail_plaintext_occurrences === 0 &&
            counts.matching_basic_auth_secrets === 1,
          counts,
        });
      }
      if (path === "/metadata" || path === "/integrator-trace")
        return response({
          includes_password: true,
          host_matches: true,
          database_matches: true,
        });
      if (path === "/exercise")
        return response({ pass: true, timings: await exercise(uri, marker) });
      return response({ code: "not_found" }, 404);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "invalid_trace_marker")
        return response({ code: "invalid_trace_marker" }, 400);
      if (error instanceof Error && error.message === "worker_scan_unavailable")
        return response({ code: "worker_scan_unavailable" }, 503);
      return response({ code: "probe_failed" }, 500);
    }
  },
};
