// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newDatabaseId, newProjectId, newOperationId } from "@pgcf/contracts";
import { encodeStartup, encodeSslRequest } from "@pgcf/contracts/pg-wire";
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
import type { Env } from "../src/env.ts";

const testEnv = env as Env & { GATEWAY: Fetcher };
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
  return { socket, messages, textMessages, closeCode: () => closeCode, ctx };
}

async function errorCode(
  connection: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  await expect.poll(() => connection.messages.length).toBeGreaterThan(0);
  const bytes = connection.messages[0]!;
  expect(bytes[0]).toBe(0x45);
  const text = new TextDecoder().decode(bytes.subarray(5));
  const fields = text.split("\0");
  return fields.find((field) => field.startsWith("C"))!.slice(1);
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
    testEnv.DB.prepare("DELETE FROM roles"),
    testEnv.DB.prepare("DELETE FROM databases"),
    testEnv.DB.prepare("DELETE FROM nodes"),
    testEnv.DB.prepare("DELETE FROM regions"),
    testEnv.DB.prepare("DELETE FROM projects"),
    testEnv.DB.prepare("DELETE FROM size_classes"),
  ]);
  database = newDatabaseId();
  const project = newProjectId();
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
      `INSERT INTO databases (id, project_id, region_id, name, size_class_id,
      desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
      VALUES (?, ?, ?, 'edge-test', 'small', 'running', 'ready', 2, 2, ?, ?, ?)`,
    ).bind(
      database,
      project,
      region,
      `s3://test-backups/${region}/${database}/g1-${newOperationId()}`,
      now,
      now,
    ),
    testEnv.DB.prepare(
      `INSERT INTO roles (database_id, name, owner, password_ciphertext,
      password_iv, password_kid, created_at, updated_at) VALUES (?, 'app', 1, ?, ?, 'v1', ?, ?)`,
    ).bind(database, password, iv, now, now),
  ]);
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
});

describe("native edge admission with real Workers D1 and route-token modules", () => {
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
    expect(await errorCode(absentDatabase)).toBe("3D000");
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
    ).toBe("3D000");
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
    expect(await errorCode(deleted)).toBe("3D000");
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
    await vi.advanceTimersByTimeAsync(ADMISSION_DEADLINE_MS);
    vi.useRealTimers();
    expect(
      idle.every(
        (connection) =>
          connection.closeCode() === null && connection.messages.length === 0,
      ),
    ).toBe(true);
    expect(await stats()).toHaveLength(1_000);
    expect(logs.mock.calls).toHaveLength(1_000);
    const denied = await open();
    expect(await errorCode(denied)).toBe("53300");
    expect(await stats()).toHaveLength(1_000);
  });

  it("does not dial after an upgrade request aborts while a real D1 result is pending", async () => {
    let queried!: () => void;
    let release!: () => void;
    const lookupReached = new Promise<void>((resolve) => {
      queried = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = {
      prepare(query: string) {
        return {
          bind(...values: unknown[]) {
            const statement = testEnv.DB.prepare(query).bind(...values);
            return {
              async first<T>() {
                const row = await statement.first<T>();
                expect(row).not.toBeNull();
                queried();
                await resume;
                return row;
              },
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as D1Database;
    const controller = new AbortController();
    const pending = open({
      bindings: { ...testEnv, DB: db },
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
        `INSERT INTO databases (id, project_id, region_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
        SELECT ?, project_id, region_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at
        FROM databases WHERE id = ?`,
      ).bind(other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
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
    const deniedRole = await open({ bindings, user: otherRole });
    expect(await errorCode(deniedRole)).toBe("53300");
    expect(await stats()).toHaveLength(1);
    const other = newDatabaseId();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO databases (id, project_id, region_id, name, size_class_id,
        desired_state, observed_state, generation, observed_generation, archive_path, created_at, updated_at)
        SELECT ?, project_id, region_id, 'second', size_class_id, desired_state, observed_state,
        generation, observed_generation, replace(archive_path, id, ?), created_at, updated_at
        FROM databases WHERE id = ?`,
      ).bind(other, other, database),
      testEnv.DB.prepare(
        `INSERT INTO roles (database_id, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at) SELECT ?, name, owner, password_ciphertext, password_iv,
        password_kid, created_at, updated_at FROM roles WHERE database_id = ?`,
      ).bind(other, database),
    ]);
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
