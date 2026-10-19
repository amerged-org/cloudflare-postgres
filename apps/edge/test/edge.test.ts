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
  newOperationId,
  isDatabaseId,
  isRoleName,
  type NodeKey,
} from "@pgcf/contracts";
import {
  encodeStartup,
  encodeSslRequest,
  encodeErrorResponse,
} from "@pgcf/contracts/pg-wire";
import {
  deriveNodeKeyring,
  parseRouteKeyring,
  verifyRouteToken,
} from "@pgcf/contracts/route-token";
import type { DatabaseWakeTicket } from "@pgcf/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { connectGateway, GatewayConfigError } from "../src/gateway.ts";
import {
  connectionRateKey,
  ADMISSION_DEADLINE_MS,
} from "../src/session-policy.ts";
import type { Env, DatabaseWakeAdmission } from "../src/env.ts";
import {
  seedFixtureDatabase,
  seedKnownDatabase,
  publishPowerObservation,
  createUnrelatedRole,
} from "./actor-entry.js";

const testEnv = env as unknown as Env & { DB: D1Database; GATEWAY: Fetcher };
const origin = `https://${["edge", "invalid"].join(".")}`;
const gatewayOrigin = `https://${["gateway", "invalid"].join(".")}`;
const region = "eu-test";
// Sentinels for the Access service token: they must reach the gateway and nothing else.
const accessId = `sentinel-id-${crypto.randomUUID()}.access`;
const accessSecret = `sentinel-secret-${crypto.randomUUID()}`;
const withAccess = {
  ...testEnv,
  ACCESS_CLIENT_ID: accessId,
  ACCESS_CLIENT_SECRET: accessSecret,
} as Env;
const live: { socket: WebSocket; ctx: ExecutionContext }[] = [];
let logs: ReturnType<typeof vi.spyOn>;
/**
 * Every line but the actor_admit one. The real DatabaseActor runs in this isolate and logs one for
 * each admission, which lands in the same spy; any other line still counts.
 */
const edgeLogs = () =>
  logs.mock.calls.filter(
    ([line]: unknown[]) =>
      !(typeof line === "string" && line.includes('"actor_admit"')),
  );
let database: string;
/** The node the fixture database runs on, with the key it signs its reports with. */
let enrolled: { id: string; uid: string; key: NodeKey };

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
    cf?: { colo: string };
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
      { headers, signal: options.signal, cf: options.cf },
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

async function assertRealRateDenied(
  original: Parameters<typeof open>[0],
  attempted: Parameters<typeof open>[0],
  window: { epoch: number },
): Promise<number> {
  const before = (await stats()).length;
  let rolloverAdmissions = 0;
  if (Math.floor(Date.now() / 60_000) !== window.epoch) {
    let stable = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const epoch = Math.floor(Date.now() / 60_000);
      const probe = await open(original);
      const after = Math.floor(Date.now() / 60_000);
      if (
        JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome === "accepted"
      )
        rolloverAdmissions++;
      else expect(await errorCode(probe)).toBe("53300");
      if (epoch === after) {
        window.epoch = epoch;
        stable = true;
        break;
      }
    }
    expect(
      stable,
      "original bucket must be occupied in one observed real epoch",
    ).toBe(true);
  }
  let denied = await open(attempted);
  if (JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome === "accepted") {
    // The actual Miniflare limiter resets at a real wall-clock minute, independently of Edge fake timers.
    expect(
      Math.floor(Date.now() / 60_000),
      "rate_scope_same_window_unexpected_admission",
    ).toBeGreaterThan(window.epoch);
    rolloverAdmissions++;
    // Probe the original scope too: an incorrectly independent alias must not masquerade as a reset.
    const originalProbe = await open(original);
    expect(
      JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome,
      "rate_scope_reciprocal_violation",
    ).toBe("53300");
    expect(await errorCode(originalProbe)).toBe("53300");
    denied = await open(attempted);
  }
  expect(await errorCode(denied)).toBe("53300");
  expect(await stats()).toHaveLength(before + rolloverAdmissions);
  return rolloverAdmissions;
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

/** The operation a node names for a generation: the newest one at or before it. */
async function operationOf(generation: number): Promise<string> {
  return (await testEnv.DB.prepare(
    "SELECT id FROM operations WHERE database_id=? AND generation<=? ORDER BY generation DESC,created_at DESC,id DESC LIMIT 1",
  )
    .bind(database, generation)
    .first<string>("id"))!;
}
/** The admission snapshot carries the region's route: a changed route is published again. */
async function updateRegion(set: string, ...values: string[]): Promise<void> {
  await testEnv.DB.prepare(`UPDATE regions SET ${set} WHERE id = ?`)
    .bind(...values, region)
    .run();
  await seedKnownDatabase(testEnv, database);
}
const setGatewayUrl = (url: string) => updateRegion("gateway_url = ?", url);
async function setGatewayMode(mode: string): Promise<void> {
  await setGatewayUrl(`${gatewayOrigin}/pg?mode=${mode}`);
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
    testEnv.DB.prepare("DELETE FROM fleet_releases"),
    testEnv.DB.prepare("DELETE FROM projects"),
    testEnv.DB.prepare("DELETE FROM size_classes"),
  ]);
  const fixture = await seedFixtureDatabase(testEnv, {
    region,
    gatewayUrl: `${gatewayOrigin}/pg`,
    gatewayBinding: "GATEWAY",
  });
  database = fixture.database;
  enrolled = fixture.node as typeof enrolled;
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

  it("a known hint flood is refused by the actual actor before D1 or wake", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const actor = testEnv.DATABASE_ACTOR.get(
      testEnv.DATABASE_ACTOR.idFromName(database),
    );
    await runInDurableObject(
      actor as unknown as DurableObjectStub,
      (instance) => {
        Reflect.set(instance, "admissions", {
          minute: Math.floor(Date.now() / 60000),
          attempts: 12000,
        });
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
    expect(await stats()).toHaveLength(0);
  });

  it("admits from the actual actor's snapshot without a data-plane D1 binding or a D1 read", async () => {
    const queries = vi.spyOn(Object.getPrototypeOf(testEnv.DB), "prepare");
    const bindings = { ...testEnv };
    delete (bindings as { DB?: D1Database }).DB;
    const connection = await open({ bindings });
    expect(queries).not.toHaveBeenCalled();
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

  it("a published project deletion overrides a positive actor snapshot", async () => {
    await testEnv.DB.prepare(
      "UPDATE projects SET deleted_at=? WHERE id=(SELECT project_id FROM databases WHERE id=?)",
    )
      .bind(new Date().toISOString(), database)
      .run();
    await seedKnownDatabase(testEnv, database);
    expect(await errorCode(await open())).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("actual actor D1 failure returns a generic error without contacting Gateway", async () => {
    // A database that is not ready takes the authoritative read, which is the one that fails.
    await testEnv.DB.prepare(
      "UPDATE databases SET observed_state='error' WHERE id=?",
    )
      .bind(database)
      .run();
    await seedKnownDatabase(testEnv, database);
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
        admitWake: async (): Promise<DatabaseWakeAdmission> => {
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

  it("hands the client the gateway's own socket, so frames cost no limiter, Actor or log work", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const limiter = { limit } as unknown as RateLimit;
    const admitWake = vi.fn(
      (
        id: string,
        user: string,
        options: { deadline: number; waiterId: string },
      ) =>
        testEnv.DATABASE_ACTOR.get(
          testEnv.DATABASE_ACTOR.idFromName(id),
        ).admitWake(id, user, options),
    );
    const cancelWakeWaiter = vi.fn(async () => false);
    const get = vi.fn(() => ({ admitWake, cancelWakeWaiter }));
    let upstream: WebSocket | null = null;
    const gateway = {
      async fetch(request: Request) {
        const response = await testEnv.GATEWAY.fetch(request);
        upstream = response.webSocket;
        return response;
      },
    } as Fetcher;
    const connection = await open({
      bindings: {
        ...testEnv,
        GATEWAY: gateway,
        CONNECTION_RATE_LIMITER: limiter,
        DATABASE_CONNECTION_RATE_LIMITER: limiter,
        DATABASE_ACTOR: {
          idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
          get,
        },
      },
    });
    // Not a relay in JavaScript: the runtime carries the frames between the client and the gateway.
    expect(connection.socket).toBe(upstream);
    // The admission: both limiters, one Actor call, one log line.
    expect(limit).toHaveBeenCalledTimes(2);
    expect(admitWake).toHaveBeenCalledTimes(1);
    expect(edgeLogs()).toHaveLength(1);
    const frames = Array.from({ length: 200 }, (_, index) =>
      Uint8Array.of(0x51, 0, 0, 0, 5, index, 0),
    );
    for (const frame of frames) connection.socket.send(frame);
    await expect
      .poll(() => concat(...connection.messages).length)
      .toBe(frames.length * 7);
    expect([...concat(...connection.messages)]).toEqual(
      frames.flatMap((frame) => [...frame]),
    );
    expect(limit).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(admitWake).toHaveBeenCalledTimes(1);
    expect(cancelWakeWaiter).not.toHaveBeenCalled();
    expect(edgeLogs()).toHaveLength(1);
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
    await seedKnownDatabase(testEnv, database);
    const deletedRole = await open();
    expect(await errorCode(deletedRole)).toBe("28P01");
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
      await seedKnownDatabase(testEnv, database);
      const connection = await open();
      expect(await errorCode(connection)).toBe("57P03");
    }
    await testEnv.DB.prepare(
      "UPDATE databases SET desired_state = 'deleted', deleted_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), database)
      .run();
    await seedKnownDatabase(testEnv, database);
    const deleted = await open();
    expect(await errorCode(deleted)).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("refuses routing while an unrelated role revision awaits the node, and routes again once the node reports it", async () => {
    const ctx = createExecutionContext();
    expect((await createUnrelatedRole(testEnv, ctx, database)).status).toBe(
      201,
    );
    await waitOnExecutionContext(ctx);
    expect(
      await testEnv.DB.prepare(
        "SELECT generation,observed_generation,observed_state,observed_power FROM databases WHERE id=?",
      )
        .bind(database)
        .first(),
    ).toEqual({
      generation: 3,
      observed_generation: 2,
      observed_state: "ready",
      observed_power: "awake",
    });
    expect(await errorCode(await open())).toBe("57P03");
    expect(await stats()).toHaveLength(0);
    const operation = await operationOf(3);
    const reported = createExecutionContext();
    expect(
      (
        await publishPowerObservation(
          testEnv,
          reported,
          enrolled,
          database,
          3,
          operation,
          "awake",
        )
      ).status,
    ).toBe(200);
    await waitOnExecutionContext(reported);
    const connection = await open();
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome).toBe(
      "accepted",
    );
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
    expect(edgeLogs()).toHaveLength(1_000);
    // The real limiter has its own wall-clock window; rate denial is checked separately.
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
          async admitWake(
            databaseId: string,
            user: string,
            options: { deadline: number; waiterId: string },
          ) {
            const row = await stub.admitWake(databaseId, user, options);
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
    expect(edgeLogs()).toHaveLength(1);
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
    await updateRegion("gateway_binding = NULL");
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
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
    );
    const verified = await verifyRouteToken(observation.token, {
      region,
      keys: keyring.keys,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("edge must mint the gateway token");
    expect(verified.claims.v).toBe(6);
    expect(verified.claims.user).toBe("app");
    expect(verified.claims.db).toBe(database);
  });

  it("applies a real rate limit", async () => {
    // Real Workers binding, separate limit-one namespace configured in the pool.
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const ip = [192, 0, 2, 2].join(".");
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open({ ip, bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    await assertRealRateDenied({ ip, bindings }, { ip, bindings }, window);
  });

  it("keeps real limiter scope checks when the previous cohort belongs to an older window", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const previousWindow = () => ({
      epoch: Math.floor(Date.now() / 60_000) - 1,
    });
    expect(
      await assertRealRateDenied(
        { bindings, ip: "2001:db8:10::1" },
        { bindings, ip: "2001:0db8:0010:0000:0:0:0:2" },
        previousWindow(),
      ),
    ).toBeGreaterThan(0);
    // An independent bucket must fail after a stable original-scope proof, even with stale setup metadata.
    await expect(
      assertRealRateDenied(
        { bindings, ip: "2001:db8:20::1" },
        { bindings, ip: "2001:db8:30::1" },
        previousWindow(),
      ),
    ).rejects.toThrow(
      /rate_scope_same_window_unexpected_admission|rate_scope_reciprocal_violation/,
    );
    // A priming probe itself may straddle a real window; count actual successful admissions, not a fixed total.
    expect(await stats()).toHaveLength(
      idleUpgradeDiagnostics([]).outcomes.accepted ?? 0,
    );
  });

  it("refuses an independent alias when original admission already consumed the current window but setup recorded an older epoch", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const original = { bindings, ip: "2001:db8:40::1" };
    await open(original);
    expect(await stats()).toHaveLength(1);
    await expect(
      assertRealRateDenied(
        original,
        { bindings, ip: "2001:db8:50::1" },
        { epoch: Math.floor(Date.now() / 60_000) - 1 },
      ),
    ).rejects.toThrow(
      /rate_scope_same_window_unexpected_admission|rate_scope_reciprocal_violation/,
    );
    // A priming probe itself may straddle a real window; count actual successful admissions, not a fixed total.
    expect(await stats()).toHaveLength(
      idleUpgradeDiagnostics([]).outcomes.accepted ?? 0,
    );
  });

  it("isolates database admission buckets when one tenant floods a shared source network", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const other = newDatabaseId();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at,
        runtime_json)
        SELECT ?, project_id, region_id, node_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at,
        json_set(runtime_json, '$.database_id', ?)
        FROM databases WHERE id = ?`,
      ).bind(other, other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
    await seedKnownDatabase(testEnv, other);
    const ip = [0x2001, 0xdb8, 0xa, 0xb, 0, 0, 0, 1]
      .map((part) => part.toString(16))
      .join(":");
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open({ ip, bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const rollover = await assertRealRateDenied(
      { ip, bindings },
      { ip, bindings },
      window,
    );
    const independent = await open({ ip, bindings, database: other });
    const startup = encodeStartup({ user: "app", database: other });
    independent.socket.send(startup);
    await expect
      .poll(async () => (await stats())[1 + rollover]?.bytes)
      .toEqual([...startup]);
    expect(independent.messages[0]?.[0]).not.toBe(0x45);
    expect(await stats()).toHaveLength(2 + rollover);
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
    await seedKnownDatabase(testEnv, database);
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const rollover = await assertRealRateDenied(
      { bindings },
      { bindings },
      window,
    );
    const independent = await open({ bindings, user: otherRole });
    const startup = encodeStartup({ user: otherRole, database });
    independent.socket.send(startup);
    await expect
      .poll(async () => (await stats())[1 + rollover]?.bytes)
      .toEqual([...startup]);
    expect(independent.messages[0]?.[0]).not.toBe(0x45);
    expect(await stats()).toHaveLength(2 + rollover);
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
    const original = {
      ip: [...prefix, "0", "0", "0", "1"].join(":"),
      bindings,
    };
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open(original);
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const rollover = await assertRealRateDenied(
      original,
      { ip: `${prefix.join(":")}::2`, bindings },
      window,
    );
    prefix[3] = ((parseInt(prefix[3]!, 16) + 1) & 0xffff).toString(16);
    const otherSubnet = await open({ ip: `${prefix.join(":")}::2`, bindings });
    otherSubnet.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(2 + rollover);
  });

  it("does not reset admission through caller Worker or forwarded-client headers", async () => {
    const limiter = (env as typeof env & { TEST_RATE_LIMITER: RateLimit })
      .TEST_RATE_LIMITER;
    const bindings = { ...testEnv, CONNECTION_RATE_LIMITER: limiter };
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    await assertRealRateDenied(
      { bindings },
      {
        bindings,
        headers: {
          "CF-Worker": ["claimed-worker", "invalid"].join("."),
          "X-Real-IP": [192, 0, 2, 7].join("."),
          "X-Forwarded-For": [192, 0, 2, 8].join("."),
          "X-Tenant-ID": crypto.randomUUID(),
        },
      },
      window,
    );
  });

  it("a malformed CF-Connecting-IP still answers 53300", async () => {
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
    const window = { epoch: Math.floor(Date.now() / 60_000) };
    const first = await open({ bindings });
    first.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    let rollover = await assertRealRateDenied(
      { bindings },
      { ip: [192, 0, 2, 9].join("."), bindings },
      window,
    );
    const otherRole = "reader";
    await testEnv.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
      password_kid, created_at, updated_at) SELECT database_id, ?, 0, password_ciphertext,
      password_iv, password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
    )
      .bind(otherRole, database)
      .run();
    await seedKnownDatabase(testEnv, database);
    rollover += await assertRealRateDenied(
      { bindings },
      { bindings, user: otherRole },
      window,
    );
    const other = newDatabaseId();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO databases (id, project_id, region_id, node_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at,
        runtime_json)
        SELECT ?, project_id, region_id, node_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at,
        json_set(runtime_json, '$.database_id', ?)
        FROM databases WHERE id = ?`,
      ).bind(other, other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
    await seedKnownDatabase(testEnv, other);
    const independent = await open({ bindings, database: other });
    independent.socket.send(encodeStartup({ user: "app", database: other }));
    await expect.poll(async () => (await stats()).length).toBe(2 + rollover);
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
    const keys = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
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
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
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
    expect(first.claims.v).toBe(6);
    expect(first.claims.user).toBe("app");
    expect(first.claims.db).toBe(database);
    expect(first.claims.rg).toBe(region);
    expect(first.claims.exp - first.claims.iat).toBe(30);
    expect(first.claims.cid).not.toBe(second.claims.cid);
  });

  it("signs the admission's verified target into a v6 route to its node", async () => {
    const instance = crypto.randomUUID();
    await testEnv.DB.prepare("UPDATE databases SET runtime_json=? WHERE id=?")
      .bind(
        JSON.stringify({
          database_id: database,
          node_id: enrolled.id,
          generation: 2,
          storage_generation: 1,
          instance,
          observed_at: Date.now(),
        }),
        database,
      )
      .run();
    await seedKnownDatabase(testEnv, database);
    const connection = await open();
    connection.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
    );
    const claims = {
      v: 6,
      db: database,
      user: "app",
      rg: region,
      node: enrolled.id,
      rev: 2,
      inst: instance,
    };
    expect(
      await verifyRouteToken((await stats())[0]!.token, {
        region,
        node: enrolled.id,
        keys: keyring.keys,
      }),
    ).toMatchObject({ ok: true, claims });
    // Another node's gateway does not take the route.
    expect(
      await verifyRouteToken((await stats())[0]!.token, {
        region,
        node: newNodeId(),
        keys: keyring.keys,
      }),
    ).toMatchObject({ ok: false, reason: "wrong_node" });
    const ctx = createExecutionContext();
    expect((await createUnrelatedRole(testEnv, ctx, database)).status).toBe(
      201,
    );
    await waitOnExecutionContext(ctx);
    // The role advanced the generation; the node applies it and reports the unit ready again.
    const generation = (await testEnv.DB.prepare(
      "SELECT generation FROM databases WHERE id=?",
    )
      .bind(database)
      .first<number>("generation"))!;
    expect(generation).toBe(3);
    const operation = await operationOf(3);
    const reported = createExecutionContext();
    expect(
      (
        await publishPowerObservation(
          testEnv,
          reported,
          enrolled,
          database,
          generation,
          operation,
          "awake",
        )
      ).status,
    ).toBe(200);
    await waitOnExecutionContext(reported);
    const next = await open();
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome).toBe(
      "accepted",
    );
    const startup = encodeStartup({ user: "app", database });
    next.socket.send(startup);
    await expect
      .poll(async () => (await stats())[1]?.bytes)
      .toEqual([...startup]);
    expect(
      await verifyRouteToken((await stats())[1]!.token, {
        region,
        node: enrolled.id,
        keys: keyring.keys,
      }),
    ).toMatchObject({
      ok: true,
      claims: { v: 6, db: database, rg: region, rev: 3, node: enrolled.id },
    });
  });

  it("both limiters and admitWake are called before any of them resolves", async () => {
    const called: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const limiter = (name: string) =>
      ({
        limit: vi.fn(async () => {
          called.push(name);
          await held;
          return { success: true };
        }),
      }) as unknown as RateLimit;
    const admitWake = vi.fn(
      async (
        id: string,
        user: string,
        options: { deadline: number; waiterId: string },
      ) => {
        called.push("actor");
        await held;
        return testEnv.DATABASE_ACTOR.get(
          testEnv.DATABASE_ACTOR.idFromName(id),
        ).admitWake(id, user, options);
      },
    );
    const pending = open({
      bindings: {
        ...testEnv,
        CONNECTION_RATE_LIMITER: limiter("connection"),
        DATABASE_CONNECTION_RATE_LIMITER: limiter("database"),
        DATABASE_ACTOR: {
          idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
          get: () => ({ admitWake, cancelWakeWaiter: async () => false }),
        },
      },
    });
    await expect.poll(() => called.length).toBe(3);
    expect(new Set(called)).toEqual(
      new Set(["connection", "database", "actor"]),
    );
    release();
    const connection = await pending;
    connection.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log.outcome).toBe("accepted");
    expect(log.limiters_ms).toBeGreaterThanOrEqual(0);
    expect(log.admit_ms).toBeGreaterThanOrEqual(0);
  });

  it("logs the admitting colo and the connection id signed into the route", async () => {
    await open({ cf: { colo: "FRA" } });
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log).toMatchObject({ event: "conn_admission", colo: "FRA" });
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
    );
    await expect.poll(async () => (await stats()).length).toBe(1);
    expect(
      await verifyRouteToken((await stats())[0]!.token, {
        region,
        keys: keyring.keys,
      }),
    ).toMatchObject({ ok: true, claims: { cid: log.cid } });
    await open();
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).colo).toBeNull();
  });

  it("logs the Edge's own share of a connect and which database request of its isolate it was", async () => {
    await open();
    const first = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    await open();
    const second = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    // 1 is the isolate's first database request, so a cold start shows in the connect tail.
    expect(first.isolate_requests).toBeGreaterThanOrEqual(1);
    expect(second.isolate_requests).toBe(first.isolate_requests + 1);
    // Everything of the upgrade but the gateway's answer: plan 3.1's "Cloudflare adds at most".
    for (const log of [first, second])
      expect(log.edge_ms).toBe(log.duration_ms - log.gateway_connect_ms);
  });

  it("times the gateway stage of a slow upgrade and of one the gateway refused", async () => {
    await setGatewayMode("slow");
    await open();
    const slow = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(slow.gateway_connect_ms).toBeGreaterThanOrEqual(20);
    expect(slow.edge_ms).toBe(slow.duration_ms - slow.gateway_connect_ms);
    await setGatewayMode("reject");
    const refused = await open();
    expect(await errorCode(refused)).toBe("08006");
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log.outcome).toBe("08006");
    expect(log.gateway_connect_ms).toBeGreaterThanOrEqual(0);
    expect(log.edge_ms).toBe(log.duration_ms - log.gateway_connect_ms);
    // Live, a node's gateway refused every upgrade and the log said only "08006": a refusal now
    // names the gateway's status and its error code, and nothing else of its answer.
    expect(log.gateway_status).toBe(503);
    expect(log.gateway_error).toBe("route_refused");
    expect(JSON.stringify(log)).not.toContain("free text");
  });

  it("counts the wait on a gateway upgrade that the client interrupted as the gateway's, not the Edge's", async () => {
    await setGatewayMode("held");
    const controller = new AbortController();
    const pending = open({ signal: controller.signal });
    await expect.poll(async () => (await stats())[0]?.waiting).toBe(true);
    await new Promise((done) => setTimeout(done, 200));
    controller.abort();
    const connection = await pending;
    expect(await errorCode(connection)).toBe("08006");
    await testEnv.GATEWAY.fetch(`${gatewayOrigin}/release`);
    await waitOnExecutionContext(connection.ctx);
    const log = JSON.parse(logs.mock.calls.at(-1)![0] as string);
    expect(log.outcome).toBe("08006");
    expect(log.gateway_connect_ms).toBeGreaterThanOrEqual(200);
    expect(log.edge_ms).toBe(log.duration_ms - log.gateway_connect_ms);
  });

  it("gets the DatabaseActor with the configured location hint, and none without one", async () => {
    const options: unknown[] = [];
    const namespace = (hint?: string) => ({
      ...testEnv,
      ...(hint ? { DATABASE_ACTOR_LOCATION_HINT: hint } : {}),
      DATABASE_ACTOR: {
        idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
        get: (id: DurableObjectId, option?: unknown) => {
          options.push(option);
          return testEnv.DATABASE_ACTOR.get(id);
        },
      },
    });
    await open({ bindings: namespace("weur") });
    await open({ bindings: namespace() });
    expect(options).toEqual([{ locationHint: "weur" }, undefined]);
  });

  it("a caller without CF-Connecting-IP takes the binding limiter's own budget, never a public bucket", async () => {
    expect(connectionRateKey(null)).toBe("binding");
    let allow = true;
    const limiter = () =>
      ({
        limit: vi.fn(async () => ({ success: allow })),
      }) as unknown as RateLimit & { limit: ReturnType<typeof vi.fn> };
    const binding = limiter(),
      connection = limiter(),
      databaseLimit = limiter();
    const bindings = {
      ...testEnv,
      BINDING_CONNECTION_RATE_LIMITER: binding,
      CONNECTION_RATE_LIMITER: connection,
      DATABASE_CONNECTION_RATE_LIMITER: databaseLimit,
    };
    const connected = await open({ ip: null, bindings });
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).outcome).toBe(
      "accepted",
    );
    expect(binding.limit).toHaveBeenCalledExactlyOnceWith({
      key: JSON.stringify([database, "app", "binding"]),
    });
    expect(connection.limit).not.toHaveBeenCalled();
    expect(databaseLimit.limit).not.toHaveBeenCalled();
    const startup = encodeStartup({ user: "app", database });
    connected.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    allow = false;
    expect(await errorCode(await open({ ip: null, bindings }))).toBe("53300");
    allow = true;
    await open({ bindings });
    expect(binding.limit).toHaveBeenCalledTimes(2);
    expect(connection.limit).toHaveBeenCalledTimes(1);
    expect(databaseLimit.limit).toHaveBeenCalledTimes(1);
  });

  it("a wake admission is signed v5 and opens the gateway once", async () => {
    const wake: DatabaseWakeTicket = {
      operation: newOperationId(),
      generation: 3,
      route_revision: 7,
      role_revision_hash: "a".repeat(64),
    };
    const admitWake = vi.fn(async (): Promise<DatabaseWakeAdmission> => ({
      ok: true,
      region: {
        id: region,
        gateway_url: `${gatewayOrigin}/pg`,
        gateway_binding: "GATEWAY",
      },
      node: enrolled.id,
      wake,
    }));
    const connection = await open({
      bindings: {
        ...testEnv,
        DATABASE_ACTOR: {
          idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
          get: () => ({ admitWake, cancelWakeWaiter: async () => false }),
        },
      },
    });
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(startup);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    expect(await stats()).toHaveLength(1);
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
    );
    const token = (await stats())[0]!.token;
    expect(token.startsWith("v5.")).toBe(true);
    expect(
      await verifyRouteToken(token, { region, keys: keyring.keys }),
    ).toMatchObject({
      ok: true,
      claims: {
        v: 5,
        db: database,
        user: "app",
        rg: region,
        op: wake.operation,
        gen: 3,
        route_revision: 7,
        rh: wake.role_revision_hash,
      },
    });
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).route).toBe("v5");
    expect(admitWake).toHaveBeenCalledTimes(1);
  });

  it("an awake admission is signed v6 with the unit the node reported", async () => {
    const instance = crypto.randomUUID();
    const keyring = await deriveNodeKeyring(
      parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
      enrolled.id,
    );
    const admission = {
      ok: true,
      region: {
        id: region,
        gateway_url: `${gatewayOrigin}/pg`,
        gateway_binding: "GATEWAY",
      },
      node: enrolled.id,
      target: { revision: 2, route_revision: 5, instance },
    } as const;
    const connection = await open({
      bindings: {
        ...testEnv,
        DATABASE_ACTOR: {
          idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
          get: () => ({
            admitWake: async () => admission,
            cancelWakeWaiter: async () => false,
          }),
        },
      },
    });
    connection.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(async () => (await stats()).length).toBe(1);
    expect(
      await verifyRouteToken((await stats())[0]!.token, {
        region,
        node: enrolled.id,
        keys: keyring.keys,
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        v: 6,
        db: database,
        node: enrolled.id,
        rev: 2,
        route_revision: 5,
        inst: instance,
      },
    });
    expect(JSON.parse(logs.mock.calls.at(-1)![0] as string).route).toBe("v6");
  });

  it("a refused limiter answers 53300 even when the actor admitted", async () => {
    const admitWake = vi.fn(
      (
        id: string,
        user: string,
        options: { deadline: number; waiterId: string },
      ) =>
        testEnv.DATABASE_ACTOR.get(
          testEnv.DATABASE_ACTOR.idFromName(id),
        ).admitWake(id, user, options),
    );
    const connection = await open({
      bindings: {
        ...testEnv,
        DATABASE_CONNECTION_RATE_LIMITER: {
          limit: async () => ({ success: false }),
        } as unknown as RateLimit,
        DATABASE_ACTOR: {
          idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
          get: () => ({ admitWake, cancelWakeWaiter: async () => false }),
        },
      },
    });
    expect(await errorCode(connection)).toBe("53300");
    expect(admitWake).toHaveBeenCalledTimes(1);
    expect((await admitWake.mock.results[0]!.value).ok).toBe(true);
    expect(await stats()).toHaveLength(0);
  });

  it("returns a generic PostgreSQL error for gateway failure without replaying", async () => {
    await setGatewayMode("reject");
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(1);
    expect((await stats())[0]!.bytes).toHaveLength(0);
  });

  it("refuses public HTTP fallback before sending a routing token or database bytes", async () => {
    await updateRegion(
      "gateway_binding = NULL, gateway_url = ?",
      `${gatewayOrigin.replace("https:", "http:")}/pg`,
    );
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
  });

  it("allows HTTP only through an explicitly configured trusted service binding", async () => {
    await setGatewayUrl(`${gatewayOrigin.replace("https:", "http:")}/pg`);
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
    await updateRegion("gateway_binding = NULL");
    const connection = await open();
    expect(await errorCode(connection)).toBe("08006");
    const observations = await stats();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.path).toBe("/pg");
    expect(observations[0]!.token).toBeTruthy();
    expect(observations[0]!.bytes).toHaveLength(0);
  });

  describe("Cloudflare Access service token", () => {
    let elsewhere: ReturnType<typeof vi.spyOn>[];
    beforeEach(() => {
      elsewhere = (["error", "warn"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => {}),
      );
    });
    /** Everything the Edge wrote anywhere, as one string. */
    const written = () =>
      JSON.stringify([
        ...logs.mock.calls,
        ...elsewhere.flatMap((spy) => spy.mock.calls),
      ]);
    const expectNoValue = (text: string) => {
      expect(text).not.toContain(accessId);
      expect(text).not.toContain(accessSecret);
    };
    const callerHeaders = {
      "CF-Access-Client-Id": "caller-id",
      "CF-Access-Client-Secret": "caller-secret",
    };
    const lastLog = () => JSON.parse(logs.mock.calls.at(-1)![0] as string);

    it("presents the service token to a public gateway, never what the caller sends", async () => {
      await updateRegion("gateway_binding = NULL");
      const connection = await open({
        bindings: withAccess,
        headers: callerHeaders,
      });
      const startup = encodeStartup({ user: "app", database });
      connection.socket.send(startup);
      await expect
        .poll(async () => (await stats())[0]?.bytes)
        .toEqual([...startup]);
      const { headers } = (await stats())[0]!;
      expect(headers["cf-access-client-id"]).toBe(accessId);
      expect(headers["cf-access-client-secret"]).toBe(accessSecret);
      // The route and the upgrade are the Edge's own as before.
      expect(headers["x-pgcf-route"]).toBeTruthy();
      expectNoValue(written());
    });

    it("presents nothing without the secrets, whatever the caller sends", async () => {
      await updateRegion("gateway_binding = NULL");
      const connection = await open({ headers: callerHeaders });
      const startup = encodeStartup({ user: "app", database });
      connection.socket.send(startup);
      await expect
        .poll(async () => (await stats())[0]?.bytes)
        .toEqual([...startup]);
      const { headers } = (await stats())[0]!;
      expect(
        Object.keys(headers).filter((h) => h.startsWith("cf-access")),
      ).toEqual([]);
      expect(lastLog().config_error).toBeUndefined();
    });

    it("presents nothing over a service binding, which does not go through Access", async () => {
      const connection = await open({ bindings: withAccess });
      const startup = encodeStartup({ user: "app", database });
      connection.socket.send(startup);
      await expect
        .poll(async () => (await stats())[0]?.bytes)
        .toEqual([...startup]);
      const { headers } = (await stats())[0]!;
      expect(
        Object.keys(headers).filter((h) => h.startsWith("cf-access")),
      ).toEqual([]);
    });

    it("refuses before sending anything when only one of the two secrets is set", async () => {
      await updateRegion("gateway_binding = NULL");
      for (const one of [
        { ACCESS_CLIENT_ID: accessId },
        { ACCESS_CLIENT_SECRET: accessSecret },
        { ACCESS_CLIENT_ID: accessId, ACCESS_CLIENT_SECRET: "" },
      ]) {
        const connection = await open({ bindings: { ...testEnv, ...one } });
        expect(await errorCode(connection)).toBe("08006");
        expect(await stats()).toHaveLength(0);
        await waitOnExecutionContext(connection.ctx);
        const log = lastLog();
        expect(log).toMatchObject({
          event: "conn_admission",
          outcome: "08006",
          config_error: "access_secrets_incomplete",
        });
        // Nothing was sent, so there is no gateway answer to name.
        expect(log.gateway_status).toBeUndefined();
        expectNoValue(written());
      }
    });

    it("lets a service binding connect although only one secret is set", async () => {
      const connection = await open({
        bindings: { ...testEnv, ACCESS_CLIENT_ID: accessId },
      });
      const startup = encodeStartup({ user: "app", database });
      connection.socket.send(startup);
      await expect
        .poll(async () => (await stats())[0]?.bytes)
        .toEqual([...startup]);
    });

    it("logs the status of an Access refusal, and a redirect to its login as a failed upgrade", async () => {
      await updateRegion("gateway_binding = NULL");
      for (const [mode, status] of [
        ["status-401", 401],
        ["status-403", 403],
        ["status-530", 530],
        ["access-login", 302],
      ] as const) {
        await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
        await setGatewayMode(mode);
        const connection = await open({ bindings: withAccess });
        expect(await errorCode(connection)).toBe("08006");
        await waitOnExecutionContext(connection.ctx);
        const log = lastLog();
        expect(log).toMatchObject({ outcome: "08006", gateway_status: status });
        // The answer has no error code, and its free text is not kept.
        expect(log.gateway_error).toBeUndefined();
        expect(log.config_error).toBeUndefined();
        expect(JSON.stringify(log)).not.toContain("free text");
        // One request: the redirect to the login page was not followed.
        const observations = await stats();
        expect(observations).toHaveLength(1);
        expect(observations[0]!.bytes).toHaveLength(0);
        expectNoValue(written());
      }
    });

    it("keeps the values out of an error, whether the secrets are incomplete or not a header value", async () => {
      const gateway = {
        id: region,
        gateway_url: `${gatewayOrigin}/pg`,
        gateway_binding: null,
      };
      const token = "route-token";
      const refused = async (bindings: Partial<Env>) => {
        const error = await connectGateway(
          gateway,
          token,
          { ...testEnv, ...bindings },
          new AbortController().signal,
        ).then(
          () => {
            throw new Error("connected");
          },
          (reason: unknown) => reason as Error,
        );
        expectNoValue(`${error.message}${String(error)}${error.stack ?? ""}`);
        return error;
      };
      const incomplete = await refused({ ACCESS_CLIENT_SECRET: accessSecret });
      expect(incomplete).toBeInstanceOf(GatewayConfigError);
      expect(incomplete.message).toBe("invalid gateway configuration");
      // A value that cannot be a header makes no request at all.
      expect(
        await refused({
          ACCESS_CLIENT_ID: accessId,
          ACCESS_CLIENT_SECRET: `${accessSecret}\nbroken`,
        }),
      ).not.toBeInstanceOf(GatewayConfigError);
      expect(await stats()).toHaveLength(0);
      await updateRegion("gateway_binding = NULL");
      const connection = await open({
        bindings: {
          ...testEnv,
          ACCESS_CLIENT_ID: accessId,
          ACCESS_CLIENT_SECRET: `${accessSecret}\nbroken`,
        },
      });
      expect(await errorCode(connection)).toBe("08006");
      expect(await stats()).toHaveLength(0);
      expectNoValue(written());
    });
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
    expect(edgeLogs()).toHaveLength(1);
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
    expect(edgeLogs()).toHaveLength(1);
  });

  it("routes the global fetch fallback to a real test gateway Worker", async () => {
    await updateRegion("gateway_binding = NULL");
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
    await updateRegion("gateway_binding = 'UNCONFIGURED'");
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
    expect(edgeLogs()).toHaveLength(1);
    const log = JSON.parse(edgeLogs()[0]![0] as string);
    expect(log.event).toBe("conn_admission");
    expect(log.database_id).toBe(database);
    expect(log.user).toBe("app");
    expect(log.region_id).toBe(region);
    expect(log.outcome).toBe("accepted");
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
    // Every stage that ran reports its milliseconds, so a slow admission can be located.
    for (const stage of [
      "limiters_ms",
      "admit_ms",
      "token_ms",
      "gateway_connect_ms",
    ])
      expect(log[stage]).toBeGreaterThanOrEqual(0);
    expect(log.route).toBe("v6");
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
    enrolled,
    database,
    3,
    operation,
    "hibernated",
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
  await seedKnownDatabase(testEnv, database);
}

it("wakes an idle database with the real actor: the gateway is dialed at once under a v5 ticket, the claim commits, and the node's ready report lets the request through", async () => {
  await sleeping("idle");
  await setGatewayMode("held");
  const pending = open();
  // The gateway holds the request while the node starts the database.
  await expect.poll(async () => (await stats())[0]?.waiting).toBe(true);
  await expect
    .poll(async () =>
      testEnv.DB.prepare("SELECT desired_state FROM databases WHERE id=?")
        .bind(database)
        .first("desired_state"),
    )
    .toBe("running");
  const row = await testEnv.DB.prepare(
    "SELECT generation,power_operation FROM databases WHERE id=?",
  )
    .bind(database)
    .first<{ generation: number; power_operation: string }>();
  expect(row!.generation).toBe(4);
  const keyring = await deriveNodeKeyring(
    parseRouteKeyring(testEnv.ROUTE_MASTER_KEYS),
    enrolled.id,
  );
  expect(
    await verifyRouteToken((await stats())[0]!.token, {
      region,
      node: enrolled.id,
      keys: keyring.keys,
    }),
  ).toMatchObject({
    ok: true,
    claims: { v: 5, db: database, gen: 4, op: row!.power_operation },
  });
  const ctx = createExecutionContext();
  const response = await publishPowerObservation(
    testEnv,
    ctx,
    enrolled,
    database,
    4,
    row!.power_operation,
    "awake",
  );
  expect(response.status).toBe(200);
  await waitOnExecutionContext(ctx);
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/release`);
  const connection = await pending;
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

it("passes the connection cid and one absolute 60-second deadline to wake and cancels the same waiter on abort", async () => {
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
      ).admitWake(id, user, options);
      reached();
      await held;
      return response;
    },
  );
  const cancel = vi.fn(async () => true);
  const actor = {
    idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
    get: () => ({ admitWake: ensure, cancelWakeWaiter: cancel }),
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
  expect(options.deadline).toBeGreaterThanOrEqual(
    before + ADMISSION_DEADLINE_MS,
  );
  expect(options.deadline).toBeLessThanOrEqual(
    Date.now() + ADMISSION_DEADLINE_MS,
  );
  expect(cancel).toHaveBeenCalledExactlyOnceWith(database, cid);
  release();
  await waitOnExecutionContext(connection.ctx);
  expect(await stats()).toHaveLength(0);
});

it("a wake timeout cancels the waiter once, never forwards late success and keeps the total admission budget at 60 seconds", async () => {
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
      node: enrolled.id,
      target: {
        revision: 2,
        route_revision: 1,
        instance: crypto.randomUUID(),
      },
    };
  });
  const cancel = vi.fn(async () => true);
  const actor = {
    idFromName: (id: string) => testEnv.DATABASE_ACTOR.idFromName(id),
    get: () => ({ admitWake: ensure, cancelWakeWaiter: cancel }),
  };
  vi.useFakeTimers();
  const pending = open({ bindings: { ...testEnv, DATABASE_ACTOR: actor } });
  await started;
  expect(ADMISSION_DEADLINE_MS).toBe(60_000);
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
