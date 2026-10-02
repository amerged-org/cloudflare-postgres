// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  createServer,
  createConnection,
  type Server,
  type Socket,
} from "node:net";
import { networkInterfaces } from "node:os";
import { createSecureContext, TLSSocket } from "node:tls";
import { WebSocket } from "ws";
import { newDatabaseId, randomString } from "@pgcf/contracts";
import {
  deriveRegionKeyring,
  signRouteToken,
  type RouteKeyring,
} from "@pgcf/contracts/route-token";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import {
  createGateway,
  type Gateway,
  type GatewayOptions,
} from "../../src/gateway/server.ts";

export const loopback = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.internal && entry.family === "IPv4")?.address;
if (!loopback) throw new Error("a loopback interface is required");
export const database = newDatabaseId();
export const region = `r${randomString("abcdefghijklmnopqrstuvwxyz", 5)}`;
export const master: RouteKeyring = {
  active: "current",
  keys: new Map([["current", crypto.getRandomValues(new Uint8Array(32))]]),
};
export const derived = await deriveRegionKeyring(master, region);

export function certificate(host: string): { cert: string; key: string } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const cert = execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      "/dev/stdin",
      "-days",
      "1",
      "-subj",
      "/CN=pgcf-test",
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    {
      input: key,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  return { cert, key };
}

export const validCertificate = certificate(databaseTarget(database).host);
export const otherCertificate = certificate(
  databaseTarget(newDatabaseId()).host,
);

export async function listen(server: Server): Promise<number> {
  server.listen(0, loopback);
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("server did not listen");
  return address.port;
}

export async function postgresServer(
  credentials = validCertificate,
  onSecure: (socket: TLSSocket) => void = (socket) =>
    socket.on("data", (data: Buffer) => socket.write(data)),
): Promise<{
  server: Server;
  port: number;
  handshakes: () => number;
  close: () => Promise<void>;
}> {
  const context = createSecureContext(credentials);
  const sockets = new Set<Socket>();
  let handshakes = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let received = Buffer.alloc(0);
    const startup = (data: Buffer) => {
      received = Buffer.concat([received, data]);
      if (received.length < 8) return;
      if (!received.equals(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))) {
        socket.destroy();
        return;
      }
      handshakes++;
      socket.removeListener("data", startup);
      socket.write(Buffer.from("S"));
      const secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: context,
      });
      sockets.add(secure);
      secure.on("error", () => {});
      secure.once("close", () => sockets.delete(secure));
      secure.once("secure", () => onSecure(secure));
    };
    socket.on("data", startup);
  });
  const port = await listen(server);
  return {
    server,
    port,
    handshakes: () => handshakes,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function gatewayFor(
  postgresPort: number,
  overrides: Partial<GatewayOptions> = {},
): Promise<{
  gateway: Gateway;
  port: number;
  logs: Readonly<Record<string, string | number>>[];
  events: EventEmitter;
}> {
  const logs: Readonly<Record<string, string | number>>[] = [];
  const events = new EventEmitter();
  const ca = new DatabaseCaCache(async () => validCertificate.cert);
  const gateway = createGateway({
    region,
    keyring: derived,
    dial: createPostgresDial(ca, {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgresPort }),
      timeoutMs: 2_000,
    }),
    log: (event) => {
      logs.push(event);
      events.emit("conn_close", event);
    },
    drainMs: 20,
    ...overrides,
  });
  const port = await listen(gateway.server);
  return { gateway, port, logs, events };
}

export function token(
  overrides: Partial<Parameters<typeof signRouteToken>[0]> = {},
): Promise<string> {
  return signRouteToken({
    keyring: master,
    region,
    db: database,
    cid: randomUUID(),
    ...overrides,
  });
}

export async function signedClaims(
  overrides: Readonly<Record<string, unknown>>,
): Promise<string> {
  const original = await token();
  const encoded = original.split(".")[1] as string;
  const claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const payload = Buffer.from(
    JSON.stringify({ ...claims, ...overrides }),
  ).toString("base64url");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(derived.keys.get(derived.active) as Uint8Array),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    Buffer.from(`pgcf-route/v1\n${payload}`),
  );
  return `v1.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

export function client(
  port: number,
  route: string | undefined,
  path = "/pg",
  headers: Record<string, string> = {},
): WebSocket {
  return new WebSocket(`ws://${loopback}:${port}${path}`, {
    headers: {
      ...headers,
      ...(route === undefined ? {} : { "X-PGCF-Route": route }),
    },
  });
}

export async function open(
  port: number,
  route?: string,
  path = "/pg",
  headers: Record<string, string> = {},
): Promise<WebSocket> {
  const socket = client(port, route ?? (await token()), path, headers);
  await once(socket, "open", { signal: AbortSignal.timeout(5_000) });
  return socket;
}

export async function rejection(
  port: number,
  route: string | undefined,
  path = "/pg",
  headers: Record<string, string> = {},
): Promise<number> {
  const socket = client(port, route, path, headers);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("upgrade did not complete"));
    }, 5_000);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
  });
}
