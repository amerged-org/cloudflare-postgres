// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
declare module "cloudflare:sockets" {
  interface Socket {
    opened: Promise<unknown>;
    closed: Promise<void>;
    close(): Promise<void>;
  }
  export function connect(address: { hostname: string; port: number }): Socket;
}
