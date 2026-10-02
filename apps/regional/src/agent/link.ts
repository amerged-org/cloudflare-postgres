// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import type { ClientOptions } from "ws";
import { AGENT_PROTOCOL_VERSION, ServerLinkMessage } from "@pgcf/contracts";
import { backoff } from "./api-client.ts";
import type { AgentConfig } from "./config.ts";
import type { Log } from "./types.ts";

export class AgentLink {
  private instanceId = randomUUID();
  private config: Pick<AgentConfig, "apiUrl" | "agentKey">;
  private hint: () => void;
  private log: Log;
  private version: string;
  private connect: (url: URL, options: ClientOptions) => WebSocket;
  constructor(
    config: Pick<AgentConfig, "apiUrl" | "agentKey">,
    hint: () => void,
    log: Log,
    version = "0.0.0",
    connect: (url: URL, options: ClientOptions) => WebSocket = (url, options) =>
      new WebSocket(url, options),
  ) {
    this.config = config;
    this.hint = hint;
    this.log = log;
    this.version = version;
    this.connect = connect;
  }

  async run(signal: AbortSignal): Promise<void> {
    let attempts = 0;
    while (!signal.aborted) {
      const established = await this.session(signal);
      if (signal.aborted) break;
      attempts = established ? 0 : attempts + 1;
      this.log("agent_link_reconnecting");
      await delay(backoff(attempts, 1_000, 60_000), undefined, {
        signal,
      }).catch(() => {});
    }
  }

  private async session(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const url = new URL("/agent/v1/link", this.config.apiUrl);
    url.protocol = "wss:";
    const socket = this.connect(url, {
      headers: { Authorization: `Bearer ${this.config.agentKey}` },
      handshakeTimeout: 20_000,
      maxPayload: 64 * 1024,
      followRedirects: false,
    });
    let welcomed = false;
    let pong = true;
    const welcomeTimer = setTimeout(() => socket.terminate(), 20_000);
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!pong) {
        socket.terminate();
        return;
      }
      pong = false;
      socket.ping();
    }, 30_000);
    return new Promise<boolean>((resolve) => {
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.on("pong", () => {
        pong = true;
      });
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            type: "hello",
            protocol: AGENT_PROTOCOL_VERSION,
            agent_version: this.version,
            instance_id: this.instanceId,
          }),
        ),
      );
      socket.on("message", (data, binary) => {
        if (binary) {
          socket.close(1003);
          return;
        }
        try {
          const parsed = ServerLinkMessage.safeParse(
            JSON.parse(data.toString()),
          );
          if (!parsed.success) {
            socket.close(1008);
            return;
          }
          if (parsed.data.type === "welcome" && !welcomed) {
            welcomed = true;
            clearTimeout(welcomeTimer);
            this.log("agent_link_connected");
            this.hint();
          } else if (parsed.data.type === "desired" && welcomed) this.hint();
          else socket.close(1008);
        } catch {
          socket.close(1008);
        }
      });
      socket.on("error", () => this.log("agent_link_failed"));
      socket.once("close", () => {
        clearTimeout(welcomeTimer);
        clearInterval(heartbeat);
        signal.removeEventListener("abort", abort);
        resolve(welcomed);
      });
    });
  }
}
