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
import worker, {
  normalizeCloseCode,
  STARTUP_DEADLINE_MS,
} from "../src/index.ts";
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
  bytes: number[];
  closes: number[];
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

async function open(options: { ip?: string | null; bindings?: Env } = {}) {
  const ctx = createExecutionContext();
  const headers = new Headers({ Upgrade: "websocket" });
  const ip = options.ip === undefined ? [192, 0, 2, 1].join(".") : options.ip;
  if (ip !== null) headers.set("CF-Connecting-IP", ip);
  const response = await worker.fetch(
    new Request(`${origin}/v2`, { headers }),
    options.bindings ?? testEnv,
    ctx,
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept({ allowHalfOpen: true });
  const messages: Uint8Array[] = [];
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer)
      messages.push(new Uint8Array(event.data));
  });
  let closeCode: number | null = null;
  socket.addEventListener("close", (event) => {
    closeCode = event.code;
    socket.close();
  });
  live.push({ socket, ctx });
  return { socket, messages, closeCode: () => closeCode, ctx };
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
  for (const { socket, ctx } of live.splice(0)) {
    try {
      socket.close(1000);
    } catch {
      /* Already closed. */
    }
    await waitOnExecutionContext(ctx);
  }
  await testEnv.GATEWAY.fetch(`${gatewayOrigin}/reset`);
  logs.mockRestore();
});

describe("edge routing with real Workers D1, parser and route-token modules", () => {
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

  it("distinguishes unknown database and role without contacting a gateway", async () => {
    const absentDatabase = await open();
    absentDatabase.socket.send(
      encodeStartup({ user: "app", database: newDatabaseId() }),
    );
    expect(await errorCode(absentDatabase)).toBe("3D000");
    const absentRole = await open();
    absentRole.socket.send(encodeStartup({ user: "missing", database }));
    expect(await errorCode(absentRole)).toBe("28P01");
    await testEnv.DB.prepare(
      "UPDATE roles SET deleted_at = ? WHERE database_id = ?",
    )
      .bind(new Date().toISOString(), database)
      .run();
    const deletedRole = await open();
    deletedRole.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(deletedRole)).toBe("28P01");
    expect(await stats()).toHaveLength(0);
  });

  it("rejects suspended, non-ready and stale readiness before a gateway call", async () => {
    const states = [
      { desired: "suspended", observed: "ready", observedGeneration: 2 },
      { desired: "running", observed: "pending", observedGeneration: 0 },
      { desired: "running", observed: "provisioning", observedGeneration: 1 },
      { desired: "running", observed: "deleting", observedGeneration: 2 },
      { desired: "running", observed: "ready", observedGeneration: 1 },
    ];
    for (const state of states) {
      await testEnv.DB.prepare(
        "UPDATE databases SET desired_state = ?, observed_state = ?, observed_generation = ? WHERE id = ?",
      )
        .bind(state.desired, state.observed, state.observedGeneration, database)
        .run();
      const connection = await open();
      connection.socket.send(encodeStartup({ user: "app", database }));
      expect(await errorCode(connection)).toBe("57P03");
    }
    await testEnv.DB.prepare(
      "UPDATE databases SET desired_state = 'deleted', deleted_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), database)
      .run();
    const deleted = await open();
    deleted.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(deleted)).toBe("3D000");
    expect(await stats()).toHaveLength(0);
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

  it("declines SSL then forwards the exact startup without its encryption prelude", async () => {
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    connection.socket.send(concat(encodeSslRequest(), startup));
    await expect.poll(() => connection.messages[0]?.[0]).toBe(0x4e);
    await expect
      .poll(async () => (await stats())[0]?.bytes)
      .toEqual([...startup]);
    await expect
      .poll(() => [...concat(...connection.messages.slice(1))])
      .toEqual([...startup]);
  });

  it("preserves parser SQLSTATE for replication, missing user and unsupported protocol", async () => {
    const replication = await open();
    replication.socket.send(
      encodeStartup({ user: "app", database, replication: "database" }),
    );
    expect(await errorCode(replication)).toBe("0A000");
    const missingUser = await open();
    missingUser.socket.send(encodeStartup({ database }));
    expect(await errorCode(missingUser)).toBe("28000");
    const protocol = await open();
    const packet = encodeStartup({ user: "app", database });
    new DataView(packet.buffer).setUint32(4, 4 << 16);
    protocol.socket.send(packet);
    expect(await errorCode(protocol)).toBe("0A000");
    expect(await stats()).toHaveLength(0);
  });

  it("bounds a 10 MiB first frame and bytes arriving during gateway connection", async () => {
    const oversized = await open();
    oversized.socket.send(new Uint8Array(10 * 1024 * 1024));
    expect(await errorCode(oversized)).toBe("08P01");
    const pending = await open();
    pending.socket.send(encodeStartup({ user: "app", database }));
    pending.socket.send(new Uint8Array(64 * 1024));
    expect(await errorCode(pending)).toBe("08P01");
    expect(await stats()).toHaveLength(0);
  });

  it("enforces the ten-second startup deadline with fake timers", async () => {
    vi.useFakeTimers();
    const connection = await open();
    await vi.advanceTimersByTimeAsync(STARTUP_DEADLINE_MS);
    vi.useRealTimers();
    expect(await errorCode(connection)).toBe("08P01");
    await expect.poll(connection.closeCode).toBe(1000);
    expect(await stats()).toHaveLength(0);
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
    expect(first.claims.db).toBe(database);
    expect(first.claims.rg).toBe(region);
    expect(first.claims.exp - first.claims.iat).toBe(30);
    expect(first.claims.cid).not.toBe(second.claims.cid);
  });

  it("returns a generic PostgreSQL error for gateway failure without replaying", async () => {
    await setGatewayMode("reject");
    const connection = await open();
    connection.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(1);
    expect((await stats())[0]!.bytes).toHaveLength(0);
  });

  it("refuses public HTTP fallback before sending a routing token or database bytes", async () => {
    await testEnv.DB.prepare("UPDATE regions SET gateway_binding = NULL, gateway_url = ? WHERE id = ?")
      .bind(`${gatewayOrigin.replace("https:", "http:")}/pg`, region).run();
    const connection = await open();
    connection.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
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
    connection.socket.send(encodeStartup({ user: "app", database }));
    expect(await errorCode(connection)).toBe("08006");
    expect(await stats()).toHaveLength(0);
  });

  it("counts bytes manually and propagates a client close to the gateway", async () => {
    const connection = await open();
    const startup = encodeStartup({ user: "app", database });
    const payload = Uint8Array.of(11, 12, 13, 14, 15);
    connection.socket.send(concat(encodeSslRequest(), startup));
    await expect
      .poll(async () => (await stats())[0]?.bytes.length)
      .toBe(startup.length);
    connection.socket.send(payload);
    await expect
      .poll(() => concat(...connection.messages).length)
      .toBe(startup.length + payload.length + 1);
    connection.socket.close(3001, "test completion");
    await expect.poll(async () => (await stats())[0]?.closes).toEqual([3001]);
    await expect.poll(() => logs.mock.calls.length).toBe(1);
    const log = JSON.parse(logs.mock.calls[0]![0] as string);
    expect(log.event).toBe("conn_close");
    expect(log.ingress_bytes).toBe(startup.length + payload.length + 8);
    expect(log.egress_bytes).toBe(startup.length + payload.length + 1);
    expect(log.database_id).toBe(database);
    expect(log.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(log)).not.toContain("password");
  });

  it("propagates a gateway close to the client without reconnecting", async () => {
    await setGatewayMode("close");
    const connection = await open();
    connection.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(() => connection.messages.length).toBeGreaterThan(0);
    await expect.poll(connection.closeCode).toBe(1012);
    expect(await stats()).toHaveLength(1);
  });

  it("rejects text frames in both directions", async () => {
    const clientText = await open();
    clientText.socket.send("unsupported");
    await expect.poll(clientText.closeCode).toBe(1003);
    expect(await stats()).toHaveLength(0);
    await setGatewayMode("text");
    const gatewayText = await open();
    gatewayText.socket.send(encodeStartup({ user: "app", database }));
    await expect.poll(gatewayText.closeCode).toBe(1003);
    expect(await stats()).toHaveLength(1);
  });

  it("silently closes CancelRequest and maps reserved close codes", async () => {
    const connection = await open();
    const packet = new Uint8Array(16);
    const view = new DataView(packet.buffer);
    view.setUint32(0, 16);
    view.setUint32(4, 80877102);
    connection.socket.send(packet);
    await expect.poll(connection.closeCode).toBe(1000);
    expect(connection.messages).toHaveLength(0);
    expect(await stats()).toHaveLength(0);
    expect(normalizeCloseCode(1005)).toBe(1000);
    expect(normalizeCloseCode(1006)).toBe(1011);
    expect(normalizeCloseCode(1015)).toBe(1011);
    expect(normalizeCloseCode(1012)).toBe(1012);
    expect(normalizeCloseCode(3001)).toBe(3001);
  });
});
