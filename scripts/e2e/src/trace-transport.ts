// SPDX-License-Identifier: Apache-2.0
import { createRequire } from "node:module";
import WebSocket from "ws";

export const TRACE_BYTES_MAX = 2_000_000;
export const TRACE_SEND_OPTIONS = {
  binary: false,
  compress: false,
  mask: false,
  fin: true,
} as const;

export interface TailSocket {
  readonly readyState: number;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "open" | "error" | "close",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  send(
    data: string,
    options: typeof TRACE_SEND_OPTIONS,
    callback: (error?: Error) => void,
  ): void;
  terminate(): void;
}
export type TailSocketFactory = (url: string) => TailSocket;

const require = createRequire(import.meta.url);
const version = (require("wrangler/package.json") as { version: string })
  .version;

export const tailSocket: TailSocketFactory = (url) =>
  new WebSocket(url, "trace-v1", {
    headers: { "User-Agent": `wrangler/${version}` },
    maxPayload: TRACE_BYTES_MAX,
    handshakeTimeout: 15_000,
  });
