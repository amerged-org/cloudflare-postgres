// SPDX-License-Identifier: Apache-2.0
/**
 * The benchmark's two ways in, on the Neon serverless driver: a session over the Edge's WebSocket
 * (`/v2`, the driver's default) and one over its HTTP query mode (`/sql`, `neon()`). Nothing here
 * imports from Node, so the laptop and the probe Worker run the same code and differ only in the
 * WebSocket they hand in.
 */
import { Client, neon, neonConfig } from "@neondatabase/serverless";
import type { Session } from "./saas.ts";

/** Longer than the Edge's 60 s bound on a wake, so a slow wake is measured, not cut off. */
export const CONNECT_TIMEOUT_MS = 90_000;

/** A loopback endpoint is a local stack; every other host is reached over TLS. */
const local = (hostname: string) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

// The driver's default sends HTTP queries to api.<domain>; the Edge serves /sql on the host of the
// connection string.
neonConfig.fetchEndpoint = (host, port) =>
  local(host) ? `http://${host}:${port}/sql` : `https://${host}/sql`;

/** What the session needs of a WebSocket: to learn when it opened. */
export interface OpeningSocket {
  addEventListener(type: "open", listener: () => void): void;
}

/**
 * A session over a WebSocket made by `makeSocket`, the way the driver connects by default: startup,
 * password and first query in one message. The session tells when the socket opened.
 */
export async function openWebSocket(
  uri: string,
  makeSocket: (address: string) => OpeningSocket,
): Promise<Session> {
  const url = new URL(uri);
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username);
  const opened: { at?: number } = {};
  const client = new Client({
    connectionString: uri,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  // The driver builds its socket with `new`, so a function that returns the socket it made serves.
  client.neonConfig.webSocketConstructor = function (address: string) {
    const socket = makeSocket(address);
    socket.addEventListener("open", () => (opened.at = performance.now()));
    return socket;
  } as unknown as typeof client.neonConfig.webSocketConstructor;
  client.neonConfig.useSecureWebSocket = !local(url.hostname);
  client.neonConfig.pipelineConnect = "password";
  client.neonConfig.forceDisablePgSSL = true;
  client.neonConfig.wsProxy = () =>
    `${url.host}/v2?${new URLSearchParams({ database, user })}`;
  await client.connect();
  return {
    async query(sql) {
      const result = await client.query(sql);
      // A message of several statements answers with one result each: the last one counts.
      const last = Array.isArray(result) ? result.at(-1) : result;
      return last?.rows.length ?? 0;
    },
    end: () => client.end(),
    get socketOpenedAt() {
      return opened.at;
    },
  };
}

/** A session over HTTP: a statement is a `query()`, several are one `transaction()`. */
export function openHttp(uri: string): Session {
  const sql = neon(uri);
  return {
    connectionless: true,
    async query(text) {
      return (await sql.query(text)).length;
    },
    async transaction(texts) {
      const results = await sql.transaction((txn) =>
        texts.map((text) => txn.query(text)),
      );
      return results.map((rows) => rows.length);
    },
    async end() {},
  };
}
