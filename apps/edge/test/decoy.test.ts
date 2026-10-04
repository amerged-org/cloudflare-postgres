// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { newDatabaseId } from "@pgcf/contracts";
import { encodeStartup, encodeSslRequest } from "@pgcf/contracts/pg-wire";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import {
  decoyResponse,
  DECOY_DEADLINE_MS,
  DECOY_MAX_FRAMES,
} from "../src/decoy.ts";
import type { Env } from "../src/env.ts";

const sessions: { socket: WebSocket; ctx: ExecutionContext }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const session of sessions.splice(0)) {
    session.socket.close();
    await waitOnExecutionContext(session.ctx);
  }
  vi.restoreAllMocks();
});
async function unknown(
  options: {
    database?: string;
    user?: string;
    signal?: AbortSignal;
    secret?: string;
    direct?: boolean;
  } = {},
) {
  const database = options.database ?? newDatabaseId(),
    user = options.user ?? "app",
    ctx = createExecutionContext();
  const response = options.direct
    ? decoyResponse(
        { database, user },
        options.secret ?? (env as unknown as Env).ROUTE_MASTER_KEYS,
        options.signal ?? new AbortController().signal,
        ctx,
      )
    : await worker.fetch(
        new Request(
          `https://${["edge", "invalid"].join(".")}/v2?${new URLSearchParams({ database, user })}`,
          {
            headers: {
              Upgrade: "websocket",
              "CF-Connecting-IP": [192, 0, 2, 1].join("."),
            },
            signal: options.signal,
          },
        ),
        env as unknown as Env,
        ctx,
      );
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer";
  socket.accept();
  const messages: Uint8Array[] = [];
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer)
      messages.push(new Uint8Array(event.data));
  });
  let closed = false;
  socket.addEventListener("close", () => {
    closed = true;
    socket.close();
  });
  sessions.push({ socket, ctx });
  return { database, user, socket, messages, closed: () => closed, ctx };
}
it("a valid unknown route offers the PostgreSQL TLS mechanism list after the real matching startup", async () => {
  const connection = await unknown();
  connection.socket.send(
    encodeStartup({ database: connection.database, user: "app" }),
  );
  await expect.poll(() => connection.messages.length).toBeGreaterThan(0);
  const first = connection.messages[0]!;
  expect(first[0]).toBe(0x52);
  expect(new DataView(first.buffer).getUint32(5)).toBe(10);
  expect(new TextDecoder().decode(first.subarray(9))).toBe(
    "SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0",
  );
});

const text = (value: string) => new TextEncoder().encode(value);
function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function password(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = 0x70;
  new DataView(out.buffer).setUint32(1, out.length - 1);
  out.set(body, 5);
  return out;
}
function first(
  nonce = crypto.randomUUID().replaceAll("-", ""),
  gs2 = "n,,",
  mechanism = "SCRAM-SHA-256",
  username = "",
) {
  const body = text(`${gs2}n=${username},r=${nonce}`),
    size = new Uint8Array(4);
  new DataView(size.buffer).setInt32(0, body.length);
  return password(join(text(mechanism + "\0"), size, body));
}
async function challenge(
  connection: Awaited<ReturnType<typeof unknown>>,
  packet = first(),
) {
  connection.socket.send(
    encodeStartup({ database: connection.database, user: connection.user }),
  );
  await expect.poll(() => connection.messages.length).toBe(1);
  connection.socket.send(packet);
  await expect.poll(() => connection.messages.length).toBe(2);
  expect(new DataView(connection.messages[1]!.buffer).getUint32(5)).toBe(11);
  const attributes = Object.fromEntries(
    new TextDecoder()
      .decode(connection.messages[1]!.subarray(9))
      .split(",")
      .map((value) => [value.slice(0, 1), value.slice(2)]),
  );
  expect(attributes.i).toBe("4096");
  return attributes;
}
function final(
  nonce: string,
  binding = "biws",
  proof = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  ),
) {
  return password(text(`c=${binding},r=${nonce},p=${proof}`));
}
async function rejected(
  connection: Awaited<ReturnType<typeof unknown>>,
  code = "28P01",
) {
  await expect.poll(() => connection.closed()).toBe(true);
  const error = connection.messages.find((message) => message[0] === 0x45)!;
  expect(new TextDecoder().decode(error.subarray(5))).toContain(`C${code}\0`);
  expect(
    connection.messages.some(
      (message) =>
        message[0] === 0x52 && new DataView(message.buffer).getUint32(5) === 0,
    ),
  ).toBe(false);
}

it("plain SCRAM exchanges for distinct unknown hints have the same message class and generic failure", async () => {
  const database = await unknown(),
    role = await unknown({ user: "reader" });
  const a = await challenge(database),
    b = await challenge(role);
  database.socket.send(final(a.r!));
  role.socket.send(final(b.r!));
  await rejected(database);
  await rejected(role);
  expect(
    database.messages.map((message) =>
      message[0] === 0x52
        ? new DataView(message.buffer).getUint32(5)
        : message[0],
    ),
  ).toEqual([10, 11, 0x45]);
  expect(
    role.messages.map((message) =>
      message[0] === 0x52
        ? new DataView(message.buffer).getUint32(5)
        : message[0],
    ),
  ).toEqual([10, 11, 0x45]);
  expect(database.messages.at(-1)).toEqual(role.messages.at(-1));
});
it("salt is stable per route and secret while every server nonce is fresh", async () => {
  const id = newDatabaseId(),
    a = await unknown({ database: id }),
    b = await unknown({ database: id }),
    c = await unknown({ database: id, user: "reader" }),
    d = await unknown();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const one = await challenge(a, first(nonce)),
    two = await challenge(b, first(nonce)),
    otherRole = await challenge(c, first(nonce)),
    otherDB = await challenge(d, first(nonce));
  expect(one.s).toBe(two.s);
  expect(one.s).not.toBe(otherRole.s);
  expect(one.s).not.toBe(otherDB.s);
  expect(one.r).not.toBe(two.r);
  expect(one.r!.startsWith(nonce)).toBe(true);
  expect(atob(one.s!).length).toBe(16);
  const changed = await unknown({
    database: id,
    direct: true,
    secret: JSON.stringify({
      active: "v1",
      keys: {
        v1: btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        )
          .replaceAll("+", "-")
          .replaceAll("/", "_")
          .replaceAll("=", ""),
      },
    }),
  });
  expect((await challenge(changed, first(nonce))).s).not.toBe(one.s);
});
it("coalesced SSL, GSS, startup and client-first produce bounded PostgreSQL replies in order", async () => {
  const connection = await unknown(),
    gss = encodeSslRequest();
  new DataView(gss.buffer).setUint32(4, 80877104);
  connection.socket.send(
    join(
      encodeSslRequest(),
      gss,
      encodeStartup({ database: connection.database, user: connection.user }),
      first(),
    ),
  );
  await expect.poll(() => connection.messages.length).toBe(4);
  expect(connection.messages.slice(0, 2)).toEqual([
    Uint8Array.of(0x4e),
    Uint8Array.of(0x4e),
  ]);
  expect(
    connection.messages
      .slice(2)
      .map((message) => new DataView(message.buffer).getUint32(5)),
  ).toEqual([10, 11]);
});
it("fragmented startup and password messages preserve the exchange without forwarding bytes", async () => {
  const connection = await unknown(),
    packet = join(
      encodeStartup({ database: connection.database, user: connection.user }),
      first(),
    );
  connection.socket.send(packet.subarray(0, 3));
  connection.socket.send(packet.subarray(3, 12));
  connection.socket.send(packet.subarray(12));
  await expect.poll(() => connection.messages.length).toBe(2);
  const nonce = new TextDecoder()
      .decode(connection.messages[1]!.subarray(9))
      .split(",")[0]!
      .slice(2),
    response = final(nonce);
  connection.socket.send(response.subarray(0, 2));
  connection.socket.send(response.subarray(2, 6));
  connection.socket.send(response.subarray(6));
  await rejected(connection);
});
it("startup database or user mismatches fail before advertising a mechanism", async () => {
  const connection = await unknown();
  connection.socket.send(
    encodeStartup({ database: newDatabaseId(), user: "reader" }),
  );
  await rejected(connection, "28000");
  expect(connection.messages).toHaveLength(1);
});
it("CancelRequest closes silently without a SCRAM or authentication response", async () => {
  const connection = await unknown(),
    cancel = new Uint8Array(16);
  const view = new DataView(cancel.buffer);
  view.setUint32(0, 16);
  view.setUint32(4, 80877102);
  connection.socket.send(cancel);
  await expect.poll(connection.closed).toBe(true);
  expect(connection.messages).toHaveLength(0);
});
it("selected SCRAM-PLUS without certificate binding is refused", async () => {
  const connection = await unknown();
  connection.socket.send(
    encodeStartup({ database: connection.database, user: connection.user }),
  );
  await expect.poll(() => connection.messages.length).toBe(1);
  connection.socket.send(
    first(undefined, "p=tls-server-end-point,,", "SCRAM-SHA-256-PLUS"),
  );
  await rejected(connection);
  expect(connection.messages).toHaveLength(2);
});
it("unsupported GS2 authorization identity is refused", async () => {
  const connection = await unknown();
  connection.socket.send(
    join(
      encodeStartup({ database: connection.database, user: connection.user }),
      first(undefined, "n,a=other,"),
    ),
  );
  await rejected(connection);
});
it("a comma or empty client nonce cannot become a server challenge", async () => {
  const connection = await unknown();
  connection.socket.send(
    join(
      encodeStartup({ database: connection.database, user: connection.user }),
      first("bad,nonce"),
    ),
  );
  await rejected(connection);
  expect(connection.messages).toHaveLength(2);
});
it("invalid SASL lengths fail without retaining a declared allocation", async () => {
  const connection = await unknown(),
    packet = first();
  new DataView(packet.buffer).setUint32(1, 0xfffffff0);
  connection.socket.send(
    join(
      encodeStartup({ database: connection.database, user: connection.user }),
      packet.subarray(0, 5),
    ),
  );
  await rejected(connection);
});
it("a final nonce that differs from the server nonce is refused", async () => {
  const connection = await unknown();
  await challenge(connection);
  connection.socket.send(final("different"));
  await rejected(connection);
});
it("a final certificate-binding value cannot be used for plain SCRAM", async () => {
  const connection = await unknown(),
    attributes = await challenge(connection);
  connection.socket.send(final(attributes.r!, "d3Jvbmc="));
  await rejected(connection);
});
it("a truncated or noncanonical proof cannot authenticate", async () => {
  const connection = await unknown(),
    attributes = await challenge(connection);
  connection.socket.send(final(attributes.r!, "biws", "short"));
  await rejected(connection);
});
it("a structurally valid random proof always fails and never produces SASL success", async () => {
  const connection = await unknown(),
    attributes = await challenge(connection, first(undefined, "y,,"));
  connection.socket.send(final(attributes.r!, "eSws"));
  await rejected(connection);
  expect(connection.messages).toHaveLength(3);
});
it("a partial startup cannot retain more than the protocol maximum", async () => {
  const connection = await unknown(),
    prefix = new Uint8Array(8);
  new DataView(prefix.buffer).setUint32(0, 10000);
  new DataView(prefix.buffer).setUint32(4, 3 << 16);
  connection.socket.send(prefix);
  connection.socket.send(new Uint8Array(9993));
  await rejected(connection);
  expect(connection.messages).toHaveLength(1);
});
it("zero-byte frame floods close at the frame bound", async () => {
  const connection = await unknown();
  for (let i = 0; i <= DECOY_MAX_FRAMES; i++)
    connection.socket.send(new Uint8Array(0));
  await rejected(connection);
  expect(connection.messages).toHaveLength(1);
});
it("an idle decoy closes at its deadline and releases its timer", async () => {
  vi.useFakeTimers();
  const connection = await unknown();
  await vi.advanceTimersByTimeAsync(DECOY_DEADLINE_MS);
  vi.useRealTimers();
  await rejected(connection);
  await waitOnExecutionContext(connection.ctx);
  expect(connection.messages).toHaveLength(1);
});
it("abort closes without an authentication response and cleans its pending lifetime", async () => {
  const controller = new AbortController(),
    connection = await unknown({ signal: controller.signal });
  controller.abort();
  await expect.poll(connection.closed).toBe(true);
  await waitOnExecutionContext(connection.ctx);
  expect(connection.messages).toHaveLength(0);
});
it("startup/auth canaries never enter admission logs", async () => {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {}),
    canary = crypto.randomUUID(),
    connection = await unknown();
  connection.socket.send(
    join(
      encodeStartup({
        database: connection.database,
        user: connection.user,
        options: canary,
      }),
      first(undefined, "n,,", "SCRAM-SHA-256", canary),
    ),
  );
  await expect.poll(() => connection.messages.length).toBe(2);
  expect(JSON.stringify(logs.mock.calls)).not.toContain(canary);
});
