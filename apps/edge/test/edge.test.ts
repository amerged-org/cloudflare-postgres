// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import {
  newDatabaseId,
  newNodeId,
  newProjectId,
  newOperationId,
  isDatabaseId,
  isRoleName,
} from "@pgcf/contracts";
import {
  encodeStartup,
  encodeSslRequest,
  encodeErrorResponse,
} from "@pgcf/contracts/pg-wire";
import {
  deriveRegionKeyring,
  parseRouteKeyring,
  verifyRouteToken,
} from "@pgcf/contracts/route-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import {
  connectionRateKey,
  ADMISSION_DEADLINE_MS,
} from "../src/session-policy.ts";
import type { Env, DatabaseAdmission } from "../src/env.ts";
import { seedKnownDatabase, publishPowerObservation } from "./actor-entry.js";

const testEnv = env as unknown as Env & { DB: D1Database; GATEWAY: Fetcher };
const origin = `https://${["edge", "invalid"].join(".")}`;
const gatewayOrigin = `https://${["gateway", "invalid"].join(".")}`;
const region = "eu-test";
const live: { socket: WebSocket; ctx: ExecutionContext }[] = [];
let logs: ReturnType<typeof vi.spyOn>;
let database: string;

interface GatewayObservation {
  token: string;
  headers: Record<string, string>;
  path: string;
  waiting: boolean;
  bytes: number[];
  closes: number[];
  byte_count: number;
  text_frames: number;
}

async function stats(): Promise<GatewayObservation[]> {
  const response = await testEnv.GATEWAY.fetch(`${gatewayOrigin}/stats`);
  return response.json<GatewayObservation[]>();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function open(
  options: {
    ip?: string | null;
    bindings?: Env;
    headers?: HeadersInit;
    database?: string;
    user?: string;
    query?: string;
    signal?: AbortSignal;
  } = {},
) {
  const ctx = createExecutionContext();
  const headers = new Headers(options.headers);
  headers.set("Upgrade", "websocket");
  const ip = options.ip === undefined ? [192, 0, 2, 1].join(".") : options.ip;
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  const response = await worker.fetch(
    new Request(
      `${origin}/v2?${options.query ?? new URLSearchParams({ database: options.database ?? database, user: options.user ?? "app" })}`,
      { headers, signal: options.signal },
    ),
    options.bindings ?? testEnv,
    ctx,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept({ allowHalfOpen: true });
  const messages: Uint8Array[] = [];
  const textMessages: string[] = [];
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer)
      messages.push(new Uint8Array(event.data));
    else if (typeof event.data === "string") textMessages.push(event.data);
  });
  let closeCode: number | null = null;
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
    socket.close();
  });
  live.push({ socket, ctx });
  const parameters = new URLSearchParams(
    options.query ??
      new URLSearchParams({
        database: options.database ?? database,
        user: options.user ?? "app",
      }),
  );
  return {
    socket,
    messages,
    textMessages,
    closeCode: () => closeCode,
    ctx,
    databaseHint: parameters.get("database"),
    userHint: parameters.get("user"),
  };
}

async function errorCode(
  connection: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  if (
    connection.messages.length === 0 &&
    connection.databaseHint &&
    isDatabaseId(connection.databaseHint) &&
    connection.userHint &&
    isRoleName(connection.userHint)
  ) {
    try {
      connection.socket.send(
        encodeStartup({
          database: connection.databaseHint,
          user: connection.userHint,
        }),
      );
    } catch {
      /* Immediate failures may already be closed. */
    }
  }
  await expect.poll(() => connection.messages.length).toBeGreaterThan(0);
  if (connection.messages[0]![0] === 0x52) {
    expect(new DataView(connection.messages[0]!.buffer).getUint32(5)).toBe(10);
    const first = new TextEncoder().encode(
      `n,,n=,r=${crypto.randomUUID().replaceAll("-", "")}`,
    );
    const mechanism = new TextEncoder().encode("SCRAM-SHA-256\0");
    const body = concat(mechanism, new Uint8Array(4), first);
    new DataView(body.buffer).setInt32(mechanism.length, first.length);
    connection.socket.send(passwordFrame(body));
    await expect.poll(() => connection.messages.length).toBeGreaterThan(1);
    expect(new DataView(connection.messages[1]!.buffer).getUint32(5)).toBe(11);
    const challenge = new TextDecoder().decode(
      connection.messages[1]!.subarray(9),
    );
    const nonce = challenge.split(",")[0]!.slice(2);
    const proof = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    connection.socket.send(
      passwordFrame(new TextEncoder().encode(`c=biws,r=${nonce},p=${proof}`)),
    );
  }
  await expect
    .poll(() => connection.messages.some((message) => message[0] === 0x45))
    .toBe(true);
  const bytes = connection.messages.find((message) => message[0] === 0x45)!;
  expect(bytes[0]).toBe(0x45);
  const text = new TextDecoder().decode(bytes.subarray(5));
  const fields = text.split("\0");
  return fields.find((field) => field.startsWith("C"))!.slice(1);
}

function passwordFrame(body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + body.length);
  frame[0] = 0x70;
  new DataView(frame.buffer).setUint32(1, frame.length - 1);
  frame.set(body, 5);
  return frame;
}

function idleUpgradeDiagnostics(
  connections: Pick<
    Awaited<ReturnType<typeof open>>,
    "closeCode" | "messages" | "textMessages"
  >[],
) {
  const closeCodes: Record<string, number> = {},
    sqlstates: Record<string, number> = {};
  let binaryMessages = 0,
    textMessages = 0,
    errorFrames = 0;
  for (const connection of connections) {
    const code = connection.closeCode();
    if (code !== null)
      closeCodes[String(code)] = (closeCodes[String(code)] ?? 0) + 1;
    binaryMessages += connection.messages.length;
    textMessages += connection.textMessages.length;
    for (const frame of connection.messages) {
      if (frame[0] !== 0x45) continue;
      errorFrames++;
      for (let i = 5; i < frame.length && frame[i] !== 0;) {
        const field = frame[i++]!;
        const end = frame.indexOf(0, i);
        if (end < 0) break;
        if (field === 0x43 && end - i === 5) {
          const value = String.fromCharCode(...frame.subarray(i, end));
          if (/^[A-Z0-9]{5}$/.test(value))
            sqlstates[value] = (sqlstates[value] ?? 0) + 1;
        }
        i = end + 1;
      }
    }
  }
  const outcomes: Record<string, number> = {};
  for (const [value] of logs.mock.calls) {
    let outcome = "unclassified";
    try {
      const parsed = JSON.parse(value as string) as { outcome?: unknown };
      if (
        parsed.outcome === "accepted" ||
        (typeof parsed.outcome === "string" &&
          /^[A-Z0-9]{5}$/.test(parsed.outcome))
      )
        outcome = parsed.outcome;
    } catch {
      /* Diagnostics retain counts only. */
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return {
    connections: connections.length,
    closeCodes,
    binaryMessages,
    textMessages,
    errorFrames,
    sqlstates,
    outcomes,
  };
}

async function setGatewayMode(mode: string): Promise<void> {
  await testEnv.DB.prepare("UPDATE regions SET gateway_url = ? WHERE id = ?")
    .bind(`${gatewayOrigin}/pg?mode=${mode}`, region)
    .run();
}

beforeEach(async () => {
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM operations"),
    testEnv.DB.prepare("DELETE FROM lifecycle_events"),
    testEnv.DB.prepare("DELETE FROM roles"),
    testEnv.DB.prepare("DELETE FROM databases"),
    testEnv.DB.prepare("DELETE FROM nodes"),
    testEnv.DB.prepare("DELETE FROM regions"),
    testEnv.DB.prepare("DELETE FROM projects"),
    testEnv.DB.prepare("DELETE FROM size_classes"),
  ]);
  database = newDatabaseId();
  const project = newProjectId();
  const node = newNodeId();
  const now = new Date().toISOString();
  const randomHash = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
  const password = crypto.randomUUID();
  const iv = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))),
  );
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(project, "edge-test", now, now),
    testEnv.DB.prepare(
      `INSERT INTO size_classes (id, memory_mib, cpu_millicores, storage_gib,
      max_connections, archive_timeout_seconds, backup_retention_days, created_at, updated_at)
      VALUES ('small', 512, 250, 1, 20, 300, 7, ?, ?)`,
    ).bind(now, now),
    testEnv.DB.prepare(
      `INSERT INTO regions (id, provider, provider_region, gateway_url,
      gateway_binding, backup_bucket, backup_endpoint_url, agent_key_hash, created_at, updated_at)
      VALUES (?, 'test-provider', 'test-region', ?, 'GATEWAY', 'test-backups', ?, ?, ?, ?)`,
    ).bind(
      region,
      `${gatewayOrigin}/pg`,
      `https://${["backup", "invalid"].join(".")}`,
      randomHash,
      now,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT INTO nodes (id, region_id, k8s_node_name, ready, schedulable,
       allocatable_memory_mib, allocatable_cpu_millicores, platform_reserved_memory_mib,
       storage_gib_total, created_at, updated_at, node_uid, last_observed_at, platform_reserved_cpu_millicores)
       VALUES (?, ?, 'edge-fixture-node', 1, 1, 4096, 2000, 128, 20, ?, ?, ?, ?, 100)`,
    ).bind(node, region, now, now, crypto.randomUUID(), now),
    testEnv.DB.prepare(
      `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
      desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'edge-test', 'small', 'running', 'ready', 2, 2, ?, ?, ?)`,
    ).bind(
      database,
      project,
      region,
      node,
      `s3://test-backups/${region}/${database}/g1-${newOperationId()}`,
      now,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext,
      password_iv, password_kid, created_at, updated_at) VALUES (?, 'app', 1, ?, ?, 'v1', ?, ?)`,
    ).bind(database, password, iv, now, now),
  ]);
  await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, database);
});

afterEach(async () => {
  vi.useRealTimers();
  const connections = live.splice(0);
  for (const { socket } of connections) {
    try {
      socket.close(1000);
    } catch {
      /* Already closed. */
    }
  }
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/release`);
  for (const { ctx } of connections) await waitOnExecutionContext(ctx);
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
  logs.mockRestore();
  vi.restoreAllMocks();
});

describe("native edge admission with real Workers D1 and route-token modules", () => {
  it("idle-upgrade diagnostics retain counts and SQLSTATE without message or log contents", () => {
    const marker = crypto.randomUUID();
    logs.mock.calls.push([
      JSON.stringify({ outcome: marker, message: marker }),
    ]);
    const diagnostic = idleUpgradeDiagnostics([
      {
        closeCode: () => 1000,
        messages: [encodeErrorResponse("08006", marker)],
        textMessages: [marker],
      },
    ]);
    expect(diagnostic).toEqual({
      connections: 1,
      closeCodes: { "1000": 1 },
      binaryMessages: 1,
      textMessages: 1,
      errorFrames: 1,
      sqlstates: { "08006": 1 },
      outcomes: { unclassified: 1 },
    });
    expect(JSON.stringify(diagnostic).includes(marker)).toBe(false);
  });
  it("one thousand distinct unseeded hints make no D1 admission query or gateway call", async () => {
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    const actors = vi.spyOn(
      Object.getPrototypeOf(testEnv.DATABASE_ACTOR),
      "get",
    );
    const unknown = await Promise.all(
      Array.from({ length: 1_000 }, () => open({ database: newDatabaseId() })),
    );
    const codes = await Promise.all(unknown.map(errorCode));
    expect(new Set(codes)).toEqual(new Set(["28P01"]));
    expect(actors).toHaveBeenCalledTimes(1_000);
    expect(queries).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
  }, 30_000);

  it("a seeded unknown role makes no authoritative D1 query or gateway call", async () => {
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    expect(await errorCode(await open({ user: "missing" }))).toBe("28P01");
    expect(queries).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
  });

  it("a known hint flood is refused by the actual actor before D1, wake or the Edge database bucket", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const actor = testEnv.DATABASE_ACTOR.get(
      testEnv.DATABASE_ACTOR.idFromName(database),
    );
    await runInDurableObject(
      actor as unknown as DurableObjectStub,
      (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS database_admission(singleton INTEGER PRIMARY KEY CHECK(singleton=1),minute INTEGER NOT NULL,attempts INTEGER NOT NULL)",
        );
        state.storage.sql.exec(
          "INSERT INTO database_admission VALUES(1,?,12000)",
          Math.floor(Date.now() / 60000),
        );
      },
    );
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    const databaseLimiter = {
      limit: vi.fn(async () => ({ success: true })),
    } as RateLimit;
    expect(
      await errorCode(
        await open({
          bindings: {
            ...testEnv,
            DATABASE_CONNECTION_RATE_LIMITER: databaseLimiter,
          },
        }),
      ),
    ).toBe("53300");
    expect(queries).not.toHaveBeenCalled();
    expect(databaseLimiter.limit).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
  });

  it("uses the actual actor's authoritative D1 read without a data-plane D1 binding", async () => {
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    const bindings = { ...testEnv };
    delete (bindings as { DB?: D1Database }).DB;
    const connection = await open({ bindings });
    expect(queries).toHaveBeenCalledTimes(1);
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    expect(await stats()).toHaveLength(1);
  });

  it("missing actor binding fails closed without falling back to D1 or Gateway", async () => {
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    const bindings = { ...testEnv };
    delete (bindings as { DATABASE_ACTOR?: Env["DATABASE_ACTOR"] })
      .DATABASE_ACTOR;
    expect(await errorCode(await open({ bindings }))).toBe("08006");
    expect(queries).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
  });

  it("a current project deletion overrides a stale positive actor snapshot", async () => {
    await testEnv.DB.prepare(
      "UPDATE projects SET deleted_at=? WHERE id=(SELECT project_id FROM databases WHERE id=?)",
    )
      .bind(new Date().toISOString(), database)
      .run();
    expect(await errorCode(await open())).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("actual actor D1 failure returns a generic error without consuming the database limiter or contacting Gateway", async () => {
    const canary = crypto.randomUUID();
    const queries = vi
      .spyOn(Object.getPrototypeOf(testEnv.DB), "prepare")
      .mockImplementation(() => {
        throw new Error(canary);
      });
    const databaseLimiter = {
      limit: vi.fn(async () => ({ success: true })),
    } as RateLimit;
    const connection = await open({
      bindings: {
        ...testEnv,
        DATABASE_CONNECTION_RATE_LIMITER: databaseLimiter,
      },
    });
    expect(await errorCode(connection)).toBe("08006");
    expect(queries).toHaveBeenCalledTimes(1);
    expect(databaseLimiter.limit).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
    expect(new TextDecoder().decode(connection.messages[0])).not.toContain(
      canary,
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);
  });

  it("actor RPC errors fail closed without leaking exception text or contacting Gateway", async () => {
    const canary = crypto.randomUUID();
    const actor = {
      idFromName: (name: string) => testEnv.DATABASE_ACTOR.idFromName(name),
      get: () => ({
        ensureAwake: async (): Promise<DatabaseAdmission> => {
          throw new Error(canary);
        },
        cancelWakeWaiter: async () => false,
      }),
    };
    const connection = await open({
      bindings: { ...testEnv, DATABASE_ACTOR: actor },
    });
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
    expect(new TextDecoder().decode(connection.messages[0])).not.toContain(
      canary,
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);
  });
  it("returns the unopened gateway WebSocket directly without accepting or relaying it", async () => {
    let upstream: WebSocket | null = null;
    let accept: ReturnType<typeof vi.spyOn> | null = null;
    const gateway = {
      async fetch(request: Request) {
        const response = await testEnv.GATEWAY.fetch(request);
        upstream = response.webSocket;
        accept = vi.spyOn(upstream!, "accept");
        return response;
      },
    } as Fetcher;
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `${origin}/v2?${new URLSearchParams({ database, user: "app" })}`,
        {
          headers: {
            Upgrade: "websocket",
            "CF-Connecting-IP": [192, 0, 2, 1].join("."),
          },
        },
      ),
      { ...testEnv, GATEWAY: gateway },
      ctx,
    );
    expect(await stats()).toHaveLength(1);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(upstream);
    expect(accept).not.toHaveBeenCalled();
    response.webSocket!.accept({ allowHalfOpen: true });
    live.push({ socket: response.webSocket!, ctx });
    accept!.mockRestore();
  });

  it("rejects missing and duplicate admission hints before any gateway call", async () => {
    for (const query of [
      "",
      new URLSearchParams({ database }).toString(),
      new URLSearchParams({ user: "app" }).toString(),
      new URLSearchParams([
        ["database", database],
        ["database", database],
        ["user", "app"],
      ]).toString(),
      new URLSearchParams([
        ["database", database],
        ["user", "app"],
        ["user", "app"],
      ]).toString(),
    ]) {
      const connection = await open({ query });
      expect(["3D000", "28P01", "08P01"]).toContain(
        await errorCode(connection),
      );
    }
    expect(await stats()).toHaveLength(0);
  });
  it("canonicalizes valid IPv4 and IPv6 admission keys with a bounded parser", () => {
    const ipv4 = [192, 0, 2, 1].join(".");
    expect(connectionRateKey(ipv4)).toBe(`ipv4:${ipv4}`);
    expect(connectionRateKey([192, 0, 2, 2].join("."))).not.toBe(
      connectionRateKey(ipv4),
    );
    const prefix = [0x2001, 0xdb8, 0xa, 0xb].map((part) => part.toString(16));
    const short = `${prefix.join(":")}::1`;
    const full = [
      ...prefix.map((part) => part.toUpperCase().padStart(4, "0")),
      "0000",
      "0000",
      "0000",
      "0002",
    ].join(":");
    expect(connectionRateKey(short)).toBe(connectionRateKey(full));
    expect(connectionRateKey(short)).toBe(
      `ipv6:${prefix.map((part) => part.padStart(4, "0")).join(":")}/64`,
    );
    expect(connectionRateKey(`::ffff:${ipv4}`)).toBe(
      connectionRateKey(`::ffff:${[192, 0, 2, 2].join(".")}`),
    );
    expect(connectionRateKey(":".repeat(2))).toBe(
      `ipv6:${Array<string>(4).fill("0000").join(":")}/64`,
    );
    expect(connectionRateKey(`0${ipv4}`)).toBeNull();
    expect(connectionRateKey("a::b::c")).toBeNull();
    expect(connectionRateKey(Array<string>(9).fill("1").join(":"))).toBeNull();
    expect(connectionRateKey("f".repeat(1_000_000))).toBeNull();
    expect(connectionRateKey(`${short}%interface`)).toBeNull();
  });

  it("serves health and requires a WebSocket upgrade for other requests", async () => {
    const ctx = createExecutionContext();
    const health = await worker.fetch(
      new Request(`${origin}/healthz`),
      testEnv,
      ctx,
    );
    expect(await health.json()).toEqual({ status: "ok" });
    expect(
      (await worker.fetch(new Request(`${origin}/v2`), testEnv, ctx)).status,
    ).toBe(426);
  });

  it("distinguishes unknown database and role hints without contacting a gateway", async () => {
    const absentDatabase = await open({ database: newDatabaseId() });
    expect(await errorCode(absentDatabase)).toBe("28P01");
    const absentRole = await open({ user: "missing" });
    expect(await errorCode(absentRole)).toBe("28P01");
    await testEnv.DB.prepare(
      "UPDATE roles SET deleted_at = ? WHERE database_id = ?",
    )
      .bind(new Date().toISOString(), database)
      .run();
    const deletedRole = await open();
    expect(await errorCode(deletedRole)).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("unknown users cannot exhaust the database bucket before a valid role is admitted", async () => {
    let consumed = 0;
    const databaseLimiter = {
      limit: vi.fn(async ({ key }: { key: string }) => {
        expect(key).toBe(database);
        return { success: ++consumed <= 2 };
      }),
    } as RateLimit;
    const bindings = {
      ...testEnv,
      DATABASE_CONNECTION_RATE_LIMITER: databaseLimiter,
    };
    for (let index = 0; index < 2; index++) {
      const user = `r${crypto.randomUUID().replaceAll("-", "")}`;
      const unknown = await open({ bindings, user });
      expect(await errorCode(unknown)).toBe("28P01");
    }
    const valid = await open({ bindings });
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome).toBe(
      "accepted",
    );
    expect(await stats()).toHaveLength(1);
    expect(databaseLimiter.limit).toHaveBeenCalledTimes(1);
    valid.socket.send(encodeStartup({ user: "app", database }));
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...encodeStartup({ user: "app", database })]);
  });

  it("unknown database and role hints never consume a database bucket or contact the gateway", async () => {
    const databaseLimiter = {
      limit: vi.fn(async () => ({ success: true })),
    } as RateLimit;
    const bindings = {
      ...testEnv,
      DATABASE_CONNECTION_RATE_LIMITER: databaseLimiter,
    };
    expect(
      await errorCode(await open({ bindings, database: newDatabaseId() })),
    ).toBe("28P01");
    expect(await errorCode(await open({ bindings, user: "missing" }))).toBe(
      "28P01",
    );
    expect(databaseLimiter.limit).not.toHaveBeenCalled();
    expect(await stats()).toHaveLength(0);
  });

  it("rejects suspended and non-ready databases before a gateway call", async () => {
    const states = [
      { desired: "suspended", observed: "ready", observedGeneration: 2 },
      { desired: "running", observed: "pending", observedGeneration: 0 },
      { desired: "running", observed: "provisioning", observedGeneration: 1 },
      { desired: "running", observed: "deleting", observedGeneration: 2 },
    ];
    for (const state of states) {
      await testEnv.DB.prepare(
        "UPDATE databases SET desired_state = ?, observed_state = ?, observed_generation = ? WHERE id = ?",
      )
        .bind(state.desired, state.observed, state.observedGeneration, database)
        .run();
      const connection = await open();
      expect(await errorCode(connection)).toBe("57P03");
    }
    await testEnv.DB.prepare(
      "UPDATE databases SET desired_state = 'deleted', deleted_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), database)
      .run();
    const deleted = await open();
    expect(await errorCode(deleted)).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("keeps ready routing available across an unrelated role configuration revision", async () => {
    await testEnv.DB.prepare(
      "UPDATE databases SET generation = generation + 1 WHERE id = ?",
    )
      .bind(database)
      .run();
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
  });

  it("forwards split startup, coalesced trailing bytes and later buffered frames once in order", async () => {
    await setGatewayMode("slow");
    const connection = await open();
    const startup = encodeStartup({
      user: "app",
      database,
      options: "-c statement_timeout=1000",
    });
    const trailing = Uint8Array.of(1, 2, 3, 4);
    const later = Uint8Array.of(5, 6, 7);
    connection.socket.send(startup.subarray(0, 3));
    connection.socket.send(startup.subarray(3, 12));
    connection.socket.send(concat(startup.subarray(12), trailing));
    connection.socket.send(later);
    const expected = [...concat(startup, trailing, later)];
    await expect.poll(async () => (await stats())[0]?.bytes).toEqual(expected);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual(expected);
  });

  it("passes GSS, SSL, startup and trailing bytes unchanged to the gateway", async () => {
    const connection = await open();
    const gss = encodeSslRequest();
    new DataView(gss.buffer).setUint32(4, 80877104);
    const startup = encodeStartup({ user: "app", database });
    const payload = concat(
      gss,
      encodeSslRequest(),
      startup,
      Uint8Array.of(21, 22, 23),
    );
    connection.socket.send(payload);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...payload]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...payload]);
  });

  it("passes SSL plus exact startup to the gateway without answering the prelude", async () => {
    const connection = await open();
    const payload = concat(
      encodeSslRequest(),
      encodeStartup({ user: "app", database }),
    );
    connection.socket.send(payload);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...payload]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...payload]);
  });

  it("passes replication, missing-user and unsupported-protocol packets to gateway parsing unchanged", async () => {
    const replication = await open();
    const replicationPacket = encodeStartup({
      user: "app",
      database,
      replication: "database",
    });
    replication.socket.send(replicationPacket);
    const missingUser = await open();
    const missingUserPacket = encodeStartup({ database });
    missingUser.socket.send(missingUserPacket);
    const protocol = await open();
    const packet = encodeStartup({ user: "app", database });
    new DataView(packet.buffer).setUint32(4, 4 << 16);
    protocol.socket.send(packet);
    await expect
      .poll(async () => (await stats()).map((connection) => connection.bytes))
      .toEqual([[...replicationPacket], [...missingUserPacket], [...packet]]);
  });

  it("leaves large-frame bounds and startup buffering to the gateway", async () => {
    await setGatewayMode("count");
    const oversized = await open();
    oversized.socket.send(new Uint8Array(10 * 1024 * 1024));
    await expect
      .poll(async () => (await stats())[0]?.byte_count)
      .toBe(10 * 1024 * 1024);
    await expect.poll(() => oversized.messages.length).toBe(1);
    expect(new DataView(oversized.messages[0]!.buffer).getUint32(0)).toBe(
      10 * 1024 * 1024,
    );
    await setGatewayMode("slow");
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    const trailing = new Uint8Array(64 * 1024);
    connection.socket.send(startup);
    connection.socket.send(trailing);
    await expect
      .poll(async () => (await stats())[1]?.bytes)
      .toEqual([...concat(startup, trailing)]);
  });

  it("does not own the gateway's startup deadline after native admission", async () => {
    vi.useFakeTimers();
    const connection = await open();
    await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS);
    vi.useRealTimers();
    expect(connection.messages).toHaveLength(0);
    expect(connection.closeCode()).toBeNull();
    expect(await stats()).toHaveLength(1);
    expect((await stats())[0]!.bytes).toHaveLength(0);
  });

  it("passes slow partial startup bytes without installing an edge startup timer", async () => {
    vi.useFakeTimers();
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup.subarray(0, 1));
    await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS - 1);
    connection.socket.send(startup.subarray(1, 3));
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup.subarray(0, 3)]);
    expect(connection.closeCode()).toBeNull();
  });

  it("passes fragmented duplicate keys and overflowing startup lengths to gateway validation", async () => {
    const startup = encodeStartup({ user: "app", database });
    const duplicated = concat(
      startup.subarray(0, startup.length - 1),
      new TextEncoder().encode("user\0app\0\0"),
    );
    new DataView(duplicated.buffer).setUint32(0, duplicated.length);
    const duplicate = await open();
    duplicate.socket.send(duplicated.subarray(0, startup.length + 1));
    duplicate.socket.send(new Uint8Array(0));
    duplicate.socket.send(duplicated.subarray(startup.length + 1));
    const connection = await open();
    const invalid = startup.slice();
    new DataView(invalid.buffer).setUint32(0, 0xffffffff);
    connection.socket.send(invalid.subarray(0, 3));
    connection.socket.send(invalid.subarray(3));
    await expect
      .poll(async () => (await stats()).map((value) => value.bytes))
      .toEqual([[...duplicated], [...invalid]]);
  });

  it("passes fragmented maximum-length CancelRequest unchanged to the gateway", async () => {
    const connection = await open();
    const cancel = crypto.getRandomValues(new Uint8Array(268));
    const fields = new DataView(cancel.buffer);
    fields.setUint32(0, cancel.length);
    fields.setUint32(4, 80877102);
    connection.socket.send(cancel.subarray(0, 3));
    connection.socket.send(new Uint8Array(0));
    connection.socket.send(cancel.subarray(3, 11));
    connection.socket.send(cancel.subarray(11));
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...cancel]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...cancel]);
  });

  it("admits one thousand idle native upgrades without installing per-stream edge timers", async () => {
    vi.useFakeTimers();
    const ip = [198, 51, 100, 7].join(".");
    const idle = await Promise.all(
      Array.from({ length: 1_000 }, () => open({ ip })),
    );
    expect(await stats()).toHaveLength(1_000);
    expect(logs.mock.calls).toHaveLength(1_000);
    const denied = await open();
    expect(await errorCode(denied)).toBe("53300");
    expect(await stats()).toHaveLength(1_000);
    const beforeAdvance = idleUpgradeDiagnostics(idle);
    const timersBeforeAdvance = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS);
    const timersAfterAdvance = vi.getTimerCount();
    vi.useRealTimers();
    expect(
      idle.every(
        (connection) =>
          connection.closeCode() === null && connection.messages.length === 0,
      ),
      JSON.stringify({
        beforeAdvance,
        afterAdvance: idleUpgradeDiagnostics(idle),
        timersBeforeAdvance,
        timersAfterAdvance,
      }),
    ).toBe(true);
    expect(await stats()).toHaveLength(1_000);
  }, 30_000);

  it("does not dial after an upgrade request aborts while a real D1 result is pending", async () => {
    let queried!: () => void;
    let release!: () => void;
    const lookupReached = new Promise<void>((resolve) => {
      queried = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actor = {
      idFromName: (name: string) => testEnv.DATABASE_ACTOR.idFromName(name),
      get(id: DurableObjectId) {
        const stub = testEnv.DATABASE_ACTOR.get(id);
        return {
          async ensureAwake(
            databaseId: string,
            user: string,
            options: { deadline: number; waiterId: string },
          ) {
            const row = await stub.ensureAwake(databaseId, user, options);
            expect(row.ok).toBe(true);
            queried();
            await resume;
            return row;
          },
          cancelWakeWaiter: (id: string, waiterId: string) =>
            stub.cancelWakeWaiter(id, waiterId),
        };
      },
    };
    const controller = new AbortController();
    const pending = open({
      bindings: { ...testEnv, DATABASE_ACTOR: actor },
      signal: controller.signal,
    });
    await lookupReached;
    controller.abort();
    const connection = await pending;
    release();
    await waitOnExecutionContext(connection.ctx);
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
    expect(logs.mock.calls).toHaveLength(1);
  });

  it("closes a late gateway upgrade after admission cancellation", async () => {
    let upgraded!: () => void;
    const reachedUpgrade = new Promise<void>((resolve) => {
      upgraded = resolve;
    });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = {
      async fetch(request: Request) {
        const response = await testEnv.GATEWAY.fetch(
          new Request(request, { signal: new AbortController().signal }),
        );
        upgraded();
        await resume;
        return response;
      },
    } as Fetcher;
    const controller = new AbortController();
    const pending = open({
      bindings: { ...testEnv, GATEWAY: gateway },
      signal: controller.signal,
    });
    await reachedUpgrade;
    controller.abort();
    const connection = await pending;
    release();
    expect(await errorCode(connection)).toBe("08006");
    await expect.poll(async () => (await stats())[0]?.closes.length).toBe(1);
  });

  it("replaces caller route headers and excludes authorization and cookies from a public gateway upgrade", async () => {
    await testEnv.DB.prepare(
      "UPDATE regions SET gateway_binding = NULL WHERE id = ?",
    )
      .bind(region)
      .run();
    const callerRoute = crypto.randomUUID();
    const connection = await open({
      headers: {
        Authorization: `Bearer ${crypto.randomUUID()}`,
        Cookie: `session=${crypto.randomUUID()}`,
        "X-PGCF-Route": callerRoute,
      },
    });
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    const observation = (await stats())[0]!;
    expect(observation.headers.authorization).toBeUndefined();
    expect(observation.headers.cookie).toBeUndefined();
    expect(observation.token).not.toBe(callerRoute);
    const keyring = await deriveRegionKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      region,
    );
    const verified = await verifyRouteToken(observation.token, {
      region,
      keys: keyring.keys,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("edge must mint the gateway token");
    expect(verified.claims.v).toBe(2);
    expect(verified.claims.user).toBe("app");
    expect(verified.claims.db).toBe(database);
  });

  it("fails connection admission closed without an IP and applies a real rate limit", async () => {
    const missingIp = await open({ ip: null });
    expect(await errorCode(missingIp)).toBe("53300");
    // Real Workers binding, separate limit-one namespace configured in the pool.
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const ip = [192, 0, 2, 2].join(".");
    const first = await open({ ip, bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const second = await open({ ip, bindings });
    expect(await errorCode(second)).toBe("53300");
    expect(await stats()).toHaveLength(1);
  });

  it("isolates database admission buckets when one tenant floods a shared source network", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const other = newDatabaseId();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
        SELECT ?, project_id, region_id, node_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at
        FROM databases WHERE id = ?`,
      ).bind(other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
    await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, other);
    const ip = [0x2001, 0xdb8, 0xa, 0xb, 0, 0, 0, 1]
      .map((part) => part.toString(16))
      .join(":");
    const first = await open({ ip, bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const flood = await open({ ip, bindings });
    expect(await errorCode(flood)).toBe("53300");
    const independent = await open({ ip, bindings, database: other });
    const startup = encodeStartup({ user: "app", database: other });
    independent.socket.send(startup);
    await expect
      .poll(async () => (await stats())[1]?.bytes)
      .toEqual([...startup]);
    expect(independent.messages[0]?.[0]).not.toBe(0x45);
    expect(await stats()).toHaveLength(2);
  });

  it("isolates admitted roles on one database and shared source network", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const otherRole = "reader";
    await testEnv.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
      password_kid, created_at, updated_at) SELECT database_id, ?, 0, password_ciphertext,
      password_iv, password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
    )
      .bind(otherRole, database)
      .run();
    await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, database);
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const flood = await open({ bindings });
    expect(await errorCode(flood)).toBe("53300");
    const independent = await open({ bindings, user: otherRole });
    const startup = encodeStartup({ user: otherRole, database });
    independent.socket.send(startup);
    await expect
      .poll(async () => (await stats())[1]?.bytes)
      .toEqual([...startup]);
    expect(independent.messages[0]?.[0]).not.toBe(0x45);
    expect(await stats()).toHaveLength(2);
  });

  it("shares IPv6 admission across equivalent hosts in one /64 while preserving other /64s", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const prefix = [
      0x2001,
      0xdb8,
      ...crypto.getRandomValues(new Uint16Array(2)),
    ].map((part) => part.toString(16));
    const first = await open({
      ip: [...prefix, "0", "0", "0", "1"].join(":"),
      bindings,
    });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const sameSubnet = await open({ ip: `${prefix.join(":")}::2`, bindings });
    expect(await errorCode(sameSubnet)).toBe("53300");
    prefix[3] = ((parseInt(prefix[3]!, 16) + 1) & 0xffff).toString(16);
    const otherSubnet = await open({ ip: `${prefix.join(":")}::2`, bindings });
    otherSubnet.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(2);
  });

  it("does not reset admission through caller Worker or forwarded-client headers", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const denied = await open({
      bindings,
      headers: {
        "CF-Worker": ["claimed-worker", "invalid"].join("."),
        "X-Real-IP": [192, 0, 2, 7].join("."),
        "X-Forwarded-For": [192, 0, 2, 8].join("."),
        "X-Tenant-ID": crypto.randomUUID(),
      },
    });
    expect(await errorCode(denied)).toBe("53300");
    expect(await stats()).toHaveLength(1);
  });

  it("rejects malformed or oversized client IPs before a gateway connection", async () => {
    for (const ip of [
      "not-an-address",
      "1".repeat(4096),
      [256, 0, 2, 1].join("."),
      "a::b::c",
    ]) {
      const connection = await open({ ip });
      expect(await errorCode(connection)).toBe("53300");
    }
    expect(await stats()).toHaveLength(0);
  });

  it("limits parsed database identities independently across client IPs", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, DATABASE_CONNECTION_RATE_LIMITER: limiter };
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const denied = await open({ ip: [192, 0, 2, 9].join("."), bindings });
    denied.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(denied)).toBe("53300");
    expect(await stats()).toHaveLength(1);
    const otherRole = "reader";
    await testEnv.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
      password_kid, created_at, updated_at) SELECT database_id, ?, 0, password_ciphertext,
      password_iv, password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
    )
      .bind(otherRole, database)
      .run();
    await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, database);
    const deniedRole = await open({ bindings, user: otherRole });
    expect(await errorCode(deniedRole)).toBe("53300");
    expect(await stats()).toHaveLength(1);
    const other = newDatabaseId();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
        SELECT ?, project_id, region_id, node_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at
        FROM databases WHERE id = ?`,
      ).bind(other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
    await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, other);
    const independent = await open({ bindings, database: other });
    independent.socket.send(encodeStartup({ user: "app", database: other }));
    await expect.poll(async () => (await stats()).length).toBe(2);
  });

  it("rejects malformed and reserved hints without contacting a gateway", async () => {
    const invalidDatabase = await open({ database: "invalid" });
    expect(await errorCode(invalidDatabase)).toBe("3D000");
    const reservedRole = await open({ user: "postgres" });
    expect(await errorCode(reservedRole)).toBe("28P01");
    const reservedPrefix = await open({ user: "pg_reserved" });
    expect(await errorCode(reservedPrefix)).toBe("28P01");
    const malformedRole = await open({ user: "app\0other" });
    expect(await errorCode(malformedRole)).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("signs only the admitted hints while unrelated query values and Startup bytes stay untrusted", async () => {
    const trace = crypto.randomUUID();
    const unadmitted = newDatabaseId();
    const connection = await open({
      query: new URLSearchParams({
        database,
        user: "app",
        cf_trace: trace,
      }).toString(),
    });
    const packet = encodeStartup({ database: unadmitted, user: "missing" });
    connection.socket.send(packet);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...packet]);
    const observation = (await stats())[0]!;
    const keys = await deriveRegionKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      region,
    );
    const verified = await verifyRouteToken(observation.token, {
      region,
      keys: keys.keys,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("admitted route must verify");
    expect(verified.claims.db).toBe(database);
    expect(verified.claims.user).toBe("app");
    expect(observation.path).toBe("/pg");
    expect(JSON.stringify(logs.mock.calls)).not.toContain(trace);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(unadmitted);
  });

  it("mints correct short-lived tokens with unique connection IDs", async () => {
    for (let index = 0; index < 2; index++) {
      const connection = await open();
      connection.socket.send(encodeStartup({ user: "app", database }));
      await expect.poll(async () => (await stats()).length).toBe(index + 1);
    }
    const keyring = await deriveRegionKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      region,
    );
    const observations = await stats();
    const first = await verifyRouteToken(observations[0]!.token, {
      region,
      keys: keyring.keys,
    });
    const second = await verifyRouteToken(observations[1]!.token, {
      region,
      keys: keyring.keys,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("route token must verify");
    expect(first.claims.v).toBe(2);
    expect(first.claims.user).toBe("app");
    expect(first.claims.db).toBe(database);
    expect(first.claims.rg).toBe(region);
    expect(first.claims.exp - first.claims.iat).toBe(30);
    expect(first.claims.cid).not.toBe(second.claims.cid);
  });

  it("returns a generic PostgreSQL error for gateway failure without replaying", async () => {
    await setGatewayMode("reject");
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(1);
    expect((await stats())[0]!.bytes).toHaveLength(0);
  });

  it("refuses public HTTP fallback before sending a routing token or database bytes", async () => {
    await testEnv.DB.prepare(
      "UPDATE regions SET gateway_binding = NULL, gateway_url = ? WHERE id = ?",
    )
      .bind(`${gatewayOrigin.replace("https:", "http:")}/pg`, region)
      .run();
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
  });

  it("allows HTTP only through an explicitly configured trusted service binding", async () => {
    await testEnv.DB.prepare("UPDATE regions SET gateway_url = ? WHERE id = ?")
      .bind(`${gatewayOrigin.replace("https:", "http:")}/pg`, region)
      .run();
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...startup]);
  });

  it("refuses gateway redirects without leaking a token to the redirect target", async () => {
    await setGatewayMode("redirect");
    await testEnv.DB.prepare(
      "UPDATE regions SET gateway_binding = NULL WHERE id = ?",
    )
      .bind(region)
      .run();
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    const observations = await stats();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.path).toBe("/pg");
    expect(observations[0]!.token).toBeTruthy();
    expect(observations[0]!.bytes).toHaveLength(0);
  });

  it("does not reconnect when an upgrade request aborts during gateway connection", async () => {
    await setGatewayMode("held");
    const controller = new AbortController();
    const pending = open({ signal: controller.signal });
    await expect.poll(async () => (await stats())[0]?.waiting).toBe(true);
    controller.abort();
    const connection = await pending;
    expect(await errorCode(connection)).toBe("08006");
    await testEnv.GATEWAY.fetch(`${gatewayOrigin}/release`);
    await waitOnExecutionContext(connection.ctx);
    const observations = await stats();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.bytes).toHaveLength(0);
    expect(logs.mock.calls).toHaveLength(1);
  });

  it("bounds a pending gateway upgrade without sending bytes or reconnecting", async () => {
    await setGatewayMode("held");
    vi.useFakeTimers();
    const pending = open();
    await vi.waitFor(async () =>
      expect((await stats())[0]?.waiting).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS);
    const connection = await pending;
    vi.useRealTimers();
    expect(await errorCode(connection)).toBe("08006");
    await testEnv.GATEWAY.fetch(`${gatewayOrigin}/release`);
    await waitOnExecutionContext(connection.ctx);
    expect(await stats()).toHaveLength(1);
    expect((await stats())[0]!.bytes).toHaveLength(0);
    expect(logs.mock.calls).toHaveLength(1);
  });

  it("routes the global fetch fallback to a real test gateway Worker", async () => {
    await testEnv.DB.prepare(
      "UPDATE regions SET gateway_binding = NULL WHERE id = ?",
    )
      .bind(region)
      .run();
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...startup]);
  });

  it("rejects a missing configured service binding instead of falling back to fetch", async () => {
    await testEnv.DB.prepare(
      "UPDATE regions SET gateway_binding = 'UNCONFIGURED' WHERE id = ?",
    )
      .bind(region)
      .run();
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
  });

  it("logs only admission fields and propagates a native client close without invented byte counts", async () => {
    const connection = await open();
    const payload = concat(
      encodeSslRequest(),
      encodeStartup({ user: "app", database }),
      Uint8Array.of(11, 12, 13, 14, 15),
    );
    connection.socket.send(payload);
    await expect
      .poll(() => concat(...connection.messages).length)
      .toBe(payload.length);
    connection.socket.close(3001, "test completion");
    await expect.poll(async () => (await stats())[0]?.closes).toEqual([3001]);
    expect(logs.mock.calls).toHaveLength(1);
    const log = JSON.parse(logs.mock.calls[0]![0] as string);
    expect(log.event).toBe("conn_admission");
    expect(log.database_id).toBe(database);
    expect(log.user).toBe("app");
    expect(log.region_id).toBe(region);
    expect(log.outcome).toBe("accepted");
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(log)).not.toContain("password");
    expect(Object.keys(log)).not.toContain("ingress_bytes");
    expect(Object.keys(log)).not.toContain("egress_bytes");
    expect(Object.keys(log)).not.toContain("token");
  });

  it("propagates a gateway close to the client without reconnecting", async () => {
    await setGatewayMode("close");
    const connection = await open();
    connection.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(() => connection.messages.length).toBeGreaterThan(0);
    await expect.poll(connection.closeCode).toBe(1012);
    expect(await stats()).toHaveLength(1);
  });

  it("passes text frames unchanged while the real gateway owns binary-frame enforcement", async () => {
    const clientText = await open();
    clientText.socket.send("unsupported");
    await expect.poll(async () => (await stats())[0]?.text_frames).toBe(1);
    await expect.poll(() => clientText.textMessages).toEqual(["unsupported"]);
    await setGatewayMode("text");
    const gatewayText = await open();
    gatewayText.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(() => gatewayText.textMessages).toEqual(["unsupported"]);
    expect(await stats()).toHaveLength(2);
  });

  it("preserves CancelRequest bytes for gateway-owned cancellation", async () => {
    const connection = await open();
    const packet = new Uint8Array(16);
    const view = new DataView(packet.buffer);
    view.setUint32(0, 16);
    view.setUint32(4, 80877102);
    connection.socket.send(packet);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...packet]);
    await expect
      .poll(() => [...concat(...connection.messages)])
      .toEqual([...packet]);
  });
});

async function sleeping(reason: "manual" | "idle") {
  const operation = newOperationId(),
    now = new Date().toISOString();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,?,'pending',project_id,id,3,?,? FROM databases WHERE id=?",
    ).bind(
      operation,
      reason === "manual" ? "database.suspend" : "database.hibernate",
      now,
      now,
      database,
    ),
    testEnv.DB.prepare(
      "UPDATE databases SET desired_state='suspended',suspension_reason=?,power_operation=?,generation=3,observed_state='provisioning',updated_at=? WHERE id=?",
    ).bind(reason, operation, now, database),
  ]);
  const ctx = createExecutionContext();
  const response = await publishPowerObservation(
    testEnv,
    ctx,
    database,
    3,
    operation,
    "hibernated",
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
  await seedKnownDatabase(testEnv.DB, testEnv.DATABASE_ACTOR, database);
}

it("wakes an idle database with the real actor, contacts no gateway before exact observed readiness, and uses the fresh authoritative route", async () => {
  await sleeping("idle");
  await setGatewayMode("reject");
  const pending = open();
  await expect
    .poll(async () =>
      testEnv.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(database)
        .first("desired_state"),
    )
    .toBe("running");
  expect(await stats()).toHaveLength(0);
  const row = await testEnv.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(database)
    .first<{ generation: number; power_operation: string }>();
  expect(row!.generation).toBe(4);
  await testEnv.DB.prepare("UPDATE regions SET gateway_url=? WHERE id=?")
    .bind(`${gatewayOrigin}/fresh?mode=count`, region)
    .run();
  const ctx = createExecutionContext();
  const response = await publishPowerObservation(
    testEnv,
    ctx,
    database,
    4,
    row!.power_operation,
    "awake",
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
  const connection = await pending;
  expect((await stats())[0]!.path).toBe("/fresh");
  const startup = encodeStartup({ user: "app", database });
  connection.socket.send(startup);
  await expect
    .poll(async () => (await stats())[0]!.byte_count)
    .toBe(startup.length);
  expect(await stats()).toHaveLength(1);
});

it("keeps a real manually suspended actor refused without creating a wake or dialing gateway", async () => {
  await sleeping("manual");
  expect(await errorCode(await open())).toBe("57P03");
  expect(
    await testEnv.DB.prepare(
      "SELECT COUNT(*) n FROM operations WHERE database_id=? AND kind='database.wake'",
    )
      .bind(database)
      .first("n"),
  ).toBe(0);
  expect(await stats()).toHaveLength(0);
});

it("passes the connection cid and one absolute 30-second deadline to wake and cancels the same waiter on abort", async () => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ensure = vi.fn(
    async (
      id: string,
      user: string,
      options: { deadline: number; waiterId: string },
    ) => {
      const response = await testEnv.DATABASE_ACTOR.get(
        testEnv.DATABASE_ACTOR.idFromName(id),
      ).ensureAwake(id, user, options);
      reached();
      await held;
      return response;
    },
  );
  const cancel = vi.fn(async () => true);
  const actor = {
    idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
    get: () => ({ ensureAwake: ensure, cancelWakeWaiter: cancel }),
  };
  const controller = new AbortController();
  const before = Date.now();
  const pending = open({
    signal: controller.signal,
    bindings: { ...testEnv, DATABASE_ACTOR: actor },
  });
  await started;
  expect(await stats()).toHaveLength(0);
  controller.abort();
  const connection = await pending;
  expect(await errorCode(connection)).toBe("08006");
  expect(ensure).toHaveBeenCalledTimes(1);
  const options = ensure.mock.calls[0]![2];
  const cid = JSON.parse(logs.mock.calls.at(-1)![0] as string).cid;
  expect(options.waiterId).toBe(cid);
  expect(options.deadline).toBeGreaterThanOrEqual(before + 30_000);
  expect(options.deadline).toBeLessThanOrEqual(Date.now() + 30_000);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(database, cid);
  release();
  await waitOnExecutionContext(connection.ctx);
  expect(await stats()).toHaveLength(0);
});

it("a wake timeout cancels the waiter once, never forwards late success and keeps the total admission budget at 30 seconds", async () => {
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ensure = vi.fn(async () => {
    reached();
    await held;
    return {
      ok: true as const,
      region: {
        id: region,
        gateway_url: `${gatewayOrigin}/pg`,
        gateway_binding: "GATEWAY",
      },
    };
  });
  const cancel = vi.fn(async () => true);
  const actor = {
    idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
    get: () => ({ ensureAwake: ensure, cancelWakeWaiter: cancel }),
  };
  vi.useFakeTimers();
  const pending = open({ bindings: { ...testEnv, DATABASE_ACTOR: actor } });
  await started;
  expect(ADMISSION_DEADLINE_MS).toBe(30_000);
  await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS);
  const connection = await pending;
  vi.useRealTimers();
  expect(await errorCode(connection)).toBe("08006");
  const cid = JSON.parse(logs.mock.calls.at(-1)![0] as string).cid;
  expect(cancel).toHaveBeenCalledExactlyOnceWith(database, cid);
  expect(ensure).toHaveBeenCalledTimes(1);
  release();
  await waitOnExecutionContext(connection.ctx);
  expect(await stats()).toHaveLength(0);
});

it("aborting an idle wake removes the actual durable actor waiter and never opens gateway", async () => {
  await sleeping("idle");
  const stub = testEnv.DATABASE_ACTOR.get(
    testEnv.DATABASE_ACTOR.idFromName(database),
  ) as unknown as DurableObjectStub;
  const controller = new AbortController();
  const pending = open({ signal: controller.signal });
  await expect
    .poll(() =>
      runInDurableObject(
        stub,
        (instance) =>
          (instance as unknown as { waiters: Map<string, unknown> }).waiters
            .size,
      ),
    )
    .toBe(1);
  expect(await stats()).toHaveLength(0);
  controller.abort();
  const connection = await pending;
  expect(await errorCode(connection)).toBe("08006");
  await waitOnExecutionContext(connection.ctx);
  expect(
    await runInDurableObject(
      stub,
      (instance) =>
        (instance as unknown as { waiters: Map<string, unknown> }).waiters.size,
    ),
  ).toBe(0);
  expect(await stats()).toHaveLength(0);
});
