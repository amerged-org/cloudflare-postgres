// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { neon, neonConfig } from "@neondatabase/serverless";
import { newDatabaseId, newNodeId, newOperationId } from "@pgcf/contracts";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  verifyRouteToken,
} from "@pgcf/contracts/route-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { MAX_SQL_REQUEST_BYTES } from "@pgcf/contracts/edge-sql";
import type { DatabaseWakeAdmission, Env } from "../src/env.ts";

const testEnv = env as unknown as Env & { GATEWAY: Fetcher };
const origin = `https://${["edge", "invalid"].join(".")}`;
const gatewayOrigin = `https://${["gateway", "invalid"].join(".")}`;
const region = "eu-test";
const password = "pass word:/@ü";
/** The node the admitted databases run on; the Actor here is a stand-in that names it. */
const node = newNodeId();
let logs: ReturnType<typeof vi.spyOn>;
let database: string;

interface Forwarded {
  token: string;
  headers: Record<string, string>;
  path: string;
  method: string;
  body: string;
}

async function forwarded(): Promise<Forwarded[]> {
  const response = await testEnv.GATEWAY.fetch(`${gatewayOrigin}/stats`);
  return response.json<Forwarded[]>();
}

function connectionString(user = "app", databaseId = database): string {
  return `postgresql://${user}:${encodeURIComponent(password)}@${["db", "invalid"].join(".")}/${databaseId}`;
}

/** An Actor that answers every admission with `admission`, as the real one answers it. */
function admitting(
  admission: DatabaseWakeAdmission | (() => Promise<DatabaseWakeAdmission>),
  bindings: Partial<Env> = {},
): Env {
  const admitWake = vi.fn(async () =>
    typeof admission === "function" ? admission() : admission,
  );
  return {
    ...testEnv,
    ...bindings,
    DATABASE_ACTOR: {
      idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
      get: () => ({ admitWake, cancelWakeWaiter: async () => false }),
    },
  };
}

function awake(mode?: string): DatabaseWakeAdmission & { ok: true } {
  return {
    ok: true,
    region: {
      id: region,
      gateway_url: `${gatewayOrigin}/pg${mode ? `?mode=${mode}` : ""}`,
      gateway_binding: "GATEWAY",
    },
    node,
    target: { revision: 2, route_revision: 5, instance: crypto.randomUUID() },
  };
}

const neonHeaders = (user?: string) => ({
  "Neon-Connection-String": connectionString(user),
  "Neon-Raw-Text-Output": "true",
  "Neon-Array-Mode": "true",
});

async function post(
  bindings: Env,
  body: unknown,
  headers: Record<string, string> = neonHeaders(),
  method = "POST",
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${origin}/sql`, {
      method,
      headers: { "CF-Connecting-IP": [192, 0, 2, 1].join("."), ...headers },
      body: method === "POST" ? JSON.stringify(body) : null,
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function refusal(response: Response): Promise<string> {
  expect(response.status).toBe(400);
  const body = await response.json<{ code: string; message: string }>();
  expect(typeof body.message).toBe("string");
  return body.code;
}

beforeEach(async () => {
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
  database = newDatabaseId();
});

afterEach(async () => {
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
  logs.mockRestore();
  vi.restoreAllMocks();
});

describe("HTTP SQL in the Neon serverless driver's wire format", () => {
  it("the actual driver's query and transaction each reach the gateway once, admitted and signed", async () => {
    const bindings = admitting(awake());
    neonConfig.fetchEndpoint = () => `${origin}/sql`;
    neonConfig.fetchFunction = async (url: string, init: RequestInit) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(url, init),
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    try {
      const sql = neon(connectionString());
      expect(await sql.query("select $1, $2", [1, null])).toEqual([]);
      expect(
        await sql.transaction(
          [sql`insert into items values (${"a"})`, sql`select 1`],
          { isolationLevel: "Serializable", readOnly: true },
        ),
      ).toEqual([[], []]);
    } finally {
      neonConfig.fetchEndpoint = undefined as never;
      neonConfig.fetchFunction = undefined;
    }
    const requests = await forwarded();
    expect(requests).toHaveLength(2);
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      node,
    );
    for (const request of requests) {
      expect(request.path).toBe("/sql");
      expect(request.method).toBe("POST");
      expect(
        await verifyRouteToken(request.token, {
          region,
          node,
          keys: keyring.keys,
        }),
      ).toMatchObject({
        ok: true,
        claims: { v: 6, db: database, user: "app", node },
      });
      // The password travels only in the body, never in a header or the URL.
      expect(JSON.stringify(request.headers)).not.toContain("pass");
      expect(request.headers["neon-connection-string"]).toBeUndefined();
    }
    const encoded = btoa(
      String.fromCharCode(...new TextEncoder().encode(password)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    expect(JSON.parse(requests[0]!.body)).toEqual({
      password: encoded,
      queries: [{ query: "select $1, $2", params: ["1", null] }],
    });
    expect(JSON.parse(requests[1]!.body)).toEqual({
      password: encoded,
      queries: [
        { query: "insert into items values ($1)", params: ["a"] },
        { query: "select 1", params: [] },
      ],
      transaction: { isolation: "Serializable", read_only: true },
    });
    for (const [line] of logs.mock.calls) {
      expect(line).not.toContain("pass");
      expect(line).not.toContain("select");
    }
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log).toMatchObject({
      event: "sql_admission",
      database_id: database,
      route: "v6",
      outcome: "accepted",
      gateway_status: 200,
    });
  });

  it("logs the stages of a request: where it was admitted, its body, its statements and the Edge's share", async () => {
    const bindings = admitting(awake());
    const send = async (queries: unknown[]) => {
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${origin}/sql`, {
          method: "POST",
          headers: {
            "CF-Connecting-IP": [192, 0, 2, 1].join("."),
            ...neonHeaders(),
          },
          body: JSON.stringify({ queries }),
          cf: { colo: "FRA" },
        }),
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(response.status).toBe(200);
      return JSON.parse(logs.mock.calls.at(-1)![0] as string);
    };
    const first = await send([
      { query: "select 1", params: [] },
      { query: "select 2", params: [] },
    ]);
    const second = await send([{ query: "select 1", params: [] }]);
    expect(first).toMatchObject({ event: "sql_admission", colo: "FRA" });
    expect(first.statements).toBe(2);
    expect(second.statements).toBe(1);
    expect(first.body_ms).toBeGreaterThanOrEqual(0);
    // 1 is the isolate's first database request, so a cold start shows in the tail.
    expect(first.isolate_requests).toBeGreaterThanOrEqual(1);
    expect(second.isolate_requests).toBe(first.isolate_requests + 1);
    // Everything of the request but the client's upload and the gateway's answer: plan 3.1's
    // "Cloudflare adds at most".
    for (const log of [first, second])
      expect(log.edge_ms).toBe(log.duration_ms - log.gateway_ms - log.body_ms);
    // Statements are counted, never logged.
    for (const [line] of logs.mock.calls) expect(line).not.toContain("select");
  });

  it("does not count a client's slow upload, nor a refused one's, as the Edge's own time", async () => {
    const bindings = admitting(awake());
    const upload = async (chunks: string[]) => {
      const encoder = new TextEncoder();
      const ctx = createExecutionContext();
      const response = await worker.fetch(
        new Request(`${origin}/sql`, {
          method: "POST",
          headers: {
            "CF-Connecting-IP": [192, 0, 2, 1].join("."),
            ...neonHeaders(),
          },
          body: new ReadableStream({
            async start(controller) {
              for (const [index, chunk] of chunks.entries()) {
                if (index > 0)
                  await new Promise((done) => setTimeout(done, 300));
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
        bindings,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return {
        status: response.status,
        log: JSON.parse(logs.mock.calls.at(-1)![0] as string),
      };
    };
    const slow = await upload([
      '{"queries":[{"query":"select 1",',
      '"params":[]}]}',
    ]);
    expect(slow.status).toBe(200);
    expect(slow.log.body_ms).toBeGreaterThanOrEqual(300);
    expect(slow.log.edge_ms).toBe(
      slow.log.duration_ms - slow.log.gateway_ms - slow.log.body_ms,
    );
    // The upload is the client's as well when the body then turns out not to be a query.
    const refused = await upload(['{"queries":', "7}"]);
    expect(refused.status).toBe(400);
    expect(refused.log.body_ms).toBeGreaterThanOrEqual(300);
    expect(refused.log.edge_ms).toBe(
      refused.log.duration_ms - refused.log.body_ms,
    );
  });

  it("logs no statements for a request refused before its body is understood", async () => {
    const response = await post(admitting(awake()), "not an object" as never);
    expect(response.status).toBe(400);
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log.outcome).toBe("08P01");
    expect(log.statements).toBeUndefined();
    expect(log.gateway_ms).toBeUndefined();
    expect(log.edge_ms).toBe(log.duration_ms - log.body_ms);
  });

  it("the actual driver reads gateway and Edge refusals as PostgreSQL errors", async () => {
    neonConfig.fetchEndpoint = () => `${origin}/sql`;
    let bindings = admitting(awake("sql-error"));
    neonConfig.fetchFunction = async (url: string, init: RequestInit) =>
      worker.fetch(new Request(url, init), bindings, createExecutionContext());
    try {
      const sql = neon(connectionString());
      await expect(sql.query("select")).rejects.toMatchObject({
        code: "42P01",
        message: "relation does not exist",
      });
      bindings = admitting({ ok: false, sqlstate: "28P01" });
      await expect(sql.query("select")).rejects.toMatchObject({
        code: "28P01",
        message: "password authentication failed",
        severity: "FATAL",
      });
    } finally {
      neonConfig.fetchEndpoint = undefined as never;
      neonConfig.fetchFunction = undefined;
    }
  });

  it("a wake admission is forwarded once under a v5 route", async () => {
    const wake = {
      operation: newOperationId(),
      generation: 3,
      route_revision: 7,
      role_revision_hash: "a".repeat(64),
    };
    const response = await post(
      admitting({ ok: true, region: awake().region, node, wake }),
      { query: "select 1", params: [] },
    );
    expect(response.status).toBe(200);
    const [request] = await forwarded();
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      node,
    );
    expect(
      await verifyRouteToken(request!.token, {
        region,
        node,
        keys: keyring.keys,
      }),
    ).toMatchObject({ ok: true, claims: { v: 5, db: database, gen: 3 } });
  });

  it("an empty transaction answers at once without admission", async () => {
    const bindings = admitting(awake());
    const response = await post(bindings, { queries: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    expect(await forwarded()).toHaveLength(0);
  });

  it("refuses malformed requests before admission or any gateway call", async () => {
    const admission = vi.fn(async () => awake());
    const bindings = admitting(admission);
    const query = { query: "select 1", params: [] };
    const cases: [string, Response][] = [
      ["08P01", await post(bindings, query, neonHeaders(), "GET")],
      ["08P01", await post(bindings, query, {})],
      [
        "08P01",
        await post(bindings, query, {
          ...neonHeaders(),
          "Neon-Connection-String": "https://db.invalid/x",
        }),
      ],
      [
        "3D000",
        await post(bindings, query, {
          ...neonHeaders(),
          "Neon-Connection-String": connectionString("app", "Not-An-Id"),
        }),
      ],
      ["28P01", await post(bindings, query, neonHeaders("pg_signal"))],
      [
        "28P01",
        await post(bindings, query, {
          ...neonHeaders(),
          "Neon-Connection-String": `postgresql://app@db.invalid/${database}`,
        }),
      ],
      [
        "0A000",
        await post(bindings, query, {
          ...neonHeaders(),
          "Neon-Array-Mode": "false",
        }),
      ],
      [
        "0A000",
        await post(bindings, query, {
          ...neonHeaders(),
          Authorization: "Bearer token",
        }),
      ],
      [
        "08P01",
        await post(bindings, query, {
          ...neonHeaders(),
          "Neon-Batch-Isolation-Level": "Chaos",
        }),
      ],
      ["08P01", await post(bindings, { query: 1 })],
      ["08P01", await post(bindings, { query: "select", params: [{}] })],
      ["08P01", await post(bindings, { query: "select", user: "other" })],
      [
        "08P01",
        await post(bindings, {
          queries: Array.from({ length: 257 }, () => query),
        }),
      ],
      [
        "54000",
        await post(bindings, {
          query: "x".repeat(MAX_SQL_REQUEST_BYTES),
          params: [],
        }),
      ],
    ];
    for (const [code, response] of cases)
      expect(await refusal(response)).toBe(code);
    expect(admission).not.toHaveBeenCalled();
    expect(await forwarded()).toHaveLength(0);
  });

  it("answers a decoy byte for byte as the gateway refuses a password", async () => {
    // The gateway's answer to a refused password (apps/native-gateway/tests/sql.rs): an unknown
    // database or role and a wrong password cannot be told apart by their bytes.
    const response = await post(admitting({ ok: false, sqlstate: "3D000" }), {
      query: "select 1",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      '{"message":"password authentication failed","code":"28P01","severity":"FATAL"}',
    );
  });

  it("maps admission refusals as the WebSocket path does, without a gateway call", async () => {
    for (const [sqlstate, code] of [
      ["3D000", "28P01"],
      ["28P01", "28P01"],
      ["57P03", "57P03"],
      ["53300", "53300"],
      ["08006", "08006"],
    ] as const) {
      const response = await post(admitting({ ok: false, sqlstate }), {
        query: "select 1",
      });
      expect(await refusal(response)).toBe(code);
      if (sqlstate === "08006")
        expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toMatchObject({
          admit_error: "actor_failure",
        });
    }
    const refused = { limit: async () => ({ success: false }) } as RateLimit;
    expect(
      await refusal(
        await post(
          admitting(awake(), { DATABASE_CONNECTION_RATE_LIMITER: refused }),
          { query: "select 1" },
        ),
      ),
    ).toBe("53300");
    expect(await forwarded()).toHaveLength(0);
  });

  it("logs only the RPC failure category and boolean flags before forwarding SQL", async () => {
    const canary = crypto.randomUUID();
    const bindings = admitting(async () => {
      throw Object.assign(new Error(canary, { cause: { password: canary } }), {
        name: canary,
        retryable: canary,
        overloaded: true,
        remote: canary,
      });
    });
    const response = await post(bindings, { query: `select '${canary}'` });
    const publicAnswer = await response.clone().text();
    expect(await refusal(response)).toBe("08006");
    expect(await forwarded()).toHaveLength(0);
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string)).toMatchObject({
      event: "sql_admission",
      outcome: "08006",
      admit_error: "rpc_exception",
      admit_retryable: false,
      admit_overloaded: true,
      admit_remote: false,
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);
    expect(publicAnswer).not.toContain(canary);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(password);
  });

  it("counts HTTP requests in their own buckets of the same limiters", async () => {
    const connection = vi.fn(async () => ({ success: true }));
    const perDatabase = vi.fn(async () => ({ success: true }));
    const response = await post(
      admitting(awake(), {
        CONNECTION_RATE_LIMITER: { limit: connection } as unknown as RateLimit,
        DATABASE_CONNECTION_RATE_LIMITER: {
          limit: perDatabase,
        } as unknown as RateLimit,
      }),
      { query: "select 1" },
    );
    expect(response.status).toBe(200);
    expect(connection).toHaveBeenCalledExactlyOnceWith({
      key: JSON.stringify(["sql", database, "app", "ipv4:192.0.2.1"]),
    });
    expect(perDatabase).toHaveBeenCalledExactlyOnceWith({
      key: JSON.stringify(["sql", database]),
    });
  });

  it("a caller without CF-Connecting-IP takes the binding limiter's own HTTP bucket, never a public one", async () => {
    const limiter = () =>
      ({
        limit: vi.fn(async () => ({ success: true })),
      }) as unknown as RateLimit & { limit: ReturnType<typeof vi.fn> };
    const binding = limiter(),
      connection = limiter(),
      perDatabase = limiter();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${origin}/sql`, {
        method: "POST",
        headers: neonHeaders(),
        body: JSON.stringify({ query: "select 1" }),
      }),
      admitting(awake(), {
        BINDING_CONNECTION_RATE_LIMITER: binding,
        CONNECTION_RATE_LIMITER: connection,
        DATABASE_CONNECTION_RATE_LIMITER: perDatabase,
      }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(binding.limit).toHaveBeenCalledExactlyOnceWith({
      key: JSON.stringify(["sql", database, "app", "binding"]),
    });
    expect(connection.limit).not.toHaveBeenCalled();
    expect(perDatabase.limit).not.toHaveBeenCalled();
  });

  it("gets the DatabaseActor with the configured location hint, and none without one", async () => {
    const options: unknown[] = [];
    const hinted = (hint?: string): Env => {
      const admitted = admitting(awake());
      return {
        ...admitted,
        ...(hint ? { DATABASE_ACTOR_LOCATION_HINT: hint } : {}),
        DATABASE_ACTOR: {
          ...admitted.DATABASE_ACTOR,
          get: (id: DurableObjectId, option?: unknown) => {
            options.push(option);
            return admitted.DATABASE_ACTOR.get(id);
          },
        },
      };
    };
    expect((await post(hinted("weur"), { query: "select 1" })).status).toBe(
      200,
    );
    expect((await post(hinted(), { query: "select 1" })).status).toBe(200);
    expect(options).toEqual([{ locationHint: "weur" }, undefined]);
  });

  it("passes gateway answers through and reports anything else as an unknown outcome", async () => {
    const error = await post(admitting(awake("sql-error")), {
      query: "select 1",
    });
    expect(error.status).toBe(400);
    expect(await error.json()).toEqual({
      message: "relation does not exist",
      code: "42P01",
      severity: "ERROR",
    });
    const lost = await post(admitting(awake("reject")), { query: "insert" });
    expect(await refusal(lost)).toBe("08007");
    // The outcome is unknown to the client, but the log names what the gateway answered.
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log).toMatchObject({
      outcome: "08007",
      gateway_status: 503,
      gateway_error: "route_refused",
    });
    expect(JSON.stringify(log)).not.toContain("free text");
    // Each request reached the gateway exactly once: nothing is retried.
    expect(await forwarded()).toHaveLength(2);
  });
});

describe("HTTP SQL behind Cloudflare Access", () => {
  // Sentinels for the Access service token: they must reach the gateway and nothing else.
  const accessId = `sentinel-id-${crypto.randomUUID()}.access`;
  const accessSecret = `sentinel-secret-${crypto.randomUUID()}`;
  const both = {
    ACCESS_CLIENT_ID: accessId,
    ACCESS_CLIENT_SECRET: accessSecret,
  };
  /** A gateway on the public network: without a service binding, so Access guards it. */
  function open(mode?: string): DatabaseWakeAdmission & { ok: true } {
    const admission = awake(mode);
    return {
      ...admission,
      region: { ...admission.region, gateway_binding: null },
    };
  }
  const accessHeaders = (request: Forwarded) =>
    Object.keys(request.headers).filter((name) => name.startsWith("cf-access"));
  const lastLog = () => JSON.parse(logs.mock.calls.at(-1)![0] as string);
  /** Everything the Edge wrote or answered, as one string. */
  async function leaks(response: Response): Promise<string> {
    return JSON.stringify([...logs.mock.calls, await response.clone().text()]);
  }

  it("presents the service token to a public gateway, never what the caller sends", async () => {
    const response = await post(
      admitting(open(), both),
      { query: "select 1" },
      {
        ...neonHeaders(),
        "CF-Access-Client-Id": "caller-id",
        "CF-Access-Client-Secret": "caller-secret",
      },
    );
    expect(response.status).toBe(200);
    const [request] = await forwarded();
    expect(request!.headers["cf-access-client-id"]).toBe(accessId);
    expect(request!.headers["cf-access-client-secret"]).toBe(accessSecret);
    expect(request!.token).toBeTruthy();
    const text = await leaks(response);
    expect(text).not.toContain(accessId);
    expect(text).not.toContain(accessSecret);
  });

  it("presents nothing without the secrets, whatever the caller sends, and nothing over a service binding", async () => {
    const caller = {
      ...neonHeaders(),
      "CF-Access-Client-Id": "caller-id",
      "CF-Access-Client-Secret": "caller-secret",
    };
    expect(
      (await post(admitting(open()), { query: "select 1" }, caller)).status,
    ).toBe(200);
    expect(
      (await post(admitting(awake(), both), { query: "select 1" }, caller))
        .status,
    ).toBe(200);
    // Only one secret is no error where Access is not in the way.
    expect(
      (
        await post(
          admitting(awake(), { ACCESS_CLIENT_ID: accessId }),
          { query: "select 1" },
          caller,
        )
      ).status,
    ).toBe(200);
    const requests = await forwarded();
    expect(requests).toHaveLength(3);
    for (const request of requests) expect(accessHeaders(request)).toEqual([]);
  });

  it("refuses before sending anything when only one of the two secrets is set", async () => {
    for (const one of [
      { ACCESS_CLIENT_ID: accessId },
      { ACCESS_CLIENT_SECRET: accessSecret },
      { ACCESS_CLIENT_ID: accessId, ACCESS_CLIENT_SECRET: "" },
    ]) {
      const response = await post(admitting(open(), one), {
        query: "insert",
      });
      // Not an unknown outcome (08007): the request was never sent.
      expect(await refusal(response.clone())).toBe("08006");
      expect(await forwarded()).toHaveLength(0);
      expect(lastLog()).toMatchObject({
        event: "sql_admission",
        outcome: "08006",
        config_error: "access_secrets_incomplete",
      });
      expect(lastLog().gateway_status).toBeUndefined();
      const text = await leaks(response);
      expect(text).not.toContain(accessId);
      expect(text).not.toContain(accessSecret);
    }
  });

  it("refuses before sending anything when a secret cannot be a header value", async () => {
    const response = await post(
      admitting(open(), {
        ...both,
        ACCESS_CLIENT_SECRET: `${accessSecret}\nbroken`,
      }),
      { query: "insert" },
    );
    expect(await refusal(response.clone())).toBe("08006");
    expect(await forwarded()).toHaveLength(0);
    const text = await leaks(response);
    expect(text).not.toContain(accessId);
    expect(text).not.toContain(accessSecret);
  });

  it("logs the status of an Access refusal, and a redirect to its login, as an unknown outcome", async () => {
    for (const [mode, status] of [
      ["status-401", 401],
      ["status-403", 403],
      ["status-530", 530],
      ["access-login", 302],
    ] as const) {
      await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
      const response = await post(admitting(open(mode), both), {
        query: "insert",
      });
      expect(await refusal(response.clone())).toBe("08007");
      expect(lastLog()).toMatchObject({
        outcome: "08007",
        gateway_status: status,
      });
      expect(lastLog().gateway_error).toBeUndefined();
      expect(lastLog().config_error).toBeUndefined();
      // One request; the redirect to the login page was not followed.
      expect(await forwarded()).toHaveLength(1);
      const text = await leaks(response);
      expect(text).not.toContain(accessId);
      expect(text).not.toContain(accessSecret);
      expect(text).not.toContain("free text");
    }
  });
});
