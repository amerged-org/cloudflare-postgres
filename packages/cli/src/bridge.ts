// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";
import { upstreamUrl, validateOptions } from "./options.ts";
import type { ConnectOptions } from "./options.ts";
import { BackendAuthentication, FrontendPrelude } from "./auth.ts";

export const STREAM_BYTES = 64 * 1024;
export const MESSAGE_BYTES = 1024 * 1024;
export const CLIENT_LIMIT = 16;
export const HANDSHAKE_MS = 10_000;
export const FRAGMENT_LIMIT = 128;
export const HALF_CLOSE_MS = 10_000;

export interface Session {
  local: Socket;
  upstream: WebSocket;
  stream: Duplex;
  authentication: BackendAuthentication;
  frontend: FrontendPrelude;
}
export type Connector = (url: string) => WebSocket;
export const UPSTREAM_OPTIONS: Readonly<WebSocket.ClientOptions> =
  Object.freeze({
    rejectUnauthorized: true,
    followRedirects: false,
    perMessageDeflate: false,
    autoPong: false,
    allowSynchronousEvents: false,
    maxFragments: FRAGMENT_LIMIT,
    maxBufferedChunks: 256,
    maxPayload: MESSAGE_BYTES,
    handshakeTimeout: HANDSHAKE_MS,
  });
export const connectUpstream: Connector = (url) => {
  if (new URL(url).protocol !== "wss:") throw new Error("invalid_endpoint");
  return new WebSocket(url, UPSTREAM_OPTIONS);
};

export interface Bridge {
  readonly host: string;
  readonly port: number;
  readonly clients: number;
  close(): Promise<void>;
}
export interface BridgeHooks {
  connect?: Connector;
  session?: (value: Session) => void;
  disconnected?: () => void;
}

export async function startBridge(
  raw: ConnectOptions,
  hooks: BridgeHooks = {},
): Promise<Bridge> {
  const options = validateOptions(raw);
  const sessions = new Set<Session>();
  const endings = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer(
    { highWaterMark: STREAM_BYTES, allowHalfOpen: true },
    (local) => {
      local.on("error", () => {});
      if (closing || sessions.size >= CLIENT_LIMIT) {
        local.destroy();
        return;
      }
      let upstream: WebSocket;
      try {
        upstream = (hooks.connect ?? connectUpstream)(upstreamUrl(options));
      } catch {
        local.destroy();
        return;
      }
      const stream = createWebSocketStream(upstream, {
        highWaterMark: STREAM_BYTES,
      });
      const authentication = new BackendAuthentication();
      const frontend = new FrontendPrelude(authentication);
      const session = { local, upstream, stream, authentication, frontend };
      sessions.add(session);
      const ended = new Promise<void>((resolve) =>
        upstream.once("close", () => resolve()),
      );
      endings.add(ended);
      void ended.then(() => endings.delete(ended));
      let finished = false;
      let halfCloseTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (halfCloseTimer) clearTimeout(halfCloseTimer);
        local.unpipe(frontend);
        frontend.unpipe(stream);
        stream.unpipe(authentication);
        authentication.unpipe(local);
        local.destroy();
        frontend.destroy();
        authentication.destroy();
        stream.destroy();
        upstream.terminate();
        sessions.delete(session);
        hooks.disconnected?.();
      };
      stream.on("error", finish);
      authentication.on("error", finish);
      frontend.on("error", finish);
      upstream.on("error", finish);
      local.once("error", finish);
      local.once("close", finish);
      local.once("end", () => {
        if (finished) return;
        // WebSocket has no half-close: retain its readable side while queued bytes drain.
        halfCloseTimer = setTimeout(
          finish,
          HALF_CLOSE_MS +
            (upstream.readyState === WebSocket.CONNECTING ? HANDSHAKE_MS : 0),
        );
      });
      stream.once("close", finish);
      upstream.once("close", () => {
        // Let the readable stream flush admitted bytes before ending local TCP.
        if (local.destroyed) finish();
      });
      authentication.once("end", () => local.end());
      upstream.prependListener("message", (_data, binary) => {
        if (!binary) finish();
      });
      upstream.on("ping", (data) => {
        if (upstream.bufferedAmount >= STREAM_BYTES) {
          finish();
          return;
        }
        upstream.pong(data, true, (error) => {
          if (error) finish();
        });
      });
      local.setNoDelay(true);
      hooks.session?.(session);
      local.pipe(frontend);
      frontend.pipe(stream, { end: false });
      stream.pipe(authentication).pipe(local);
    },
  );
  server.maxConnections = CLIENT_LIMIT;
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error("listener_failed"));
    server.once("error", failed);
    server.listen(options.port, [127, 0, 0, 1].join("."), () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const bridge: Bridge = {
    host: address.address,
    port: address.port,
    get clients() {
      return sessions.size;
    },
    close() {
      closing ??= (async () => {
        const listener = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        for (const session of [...sessions]) session.local.destroy();
        await listener;
        await Promise.all([...endings]);
      })();
      return closing;
    },
  };
  server.on("error", () => {
    void bridge.close();
  });
  return bridge;
}
