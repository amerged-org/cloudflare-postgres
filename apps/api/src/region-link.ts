// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  DatabaseId,
  LINK_MESSAGE_MAX_BYTES,
  LinkDesiredHint,
  LinkHello,
  type DesiredResponse,
  type Orphan,
} from "@pgcf/contracts";
import type { Env } from "./env.ts";

export class RegionLink extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS orphan_reports (singleton INTEGER PRIMARY KEY CHECK(singleton=1), observed_at TEXT NOT NULL, orphans TEXT NOT NULL)",
    );
  }
  override async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("WebSocket upgrade required", { status: 426 });
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    for (const old of this.ctx.getWebSockets())
      old.close(1012, "Agent connection replaced");
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({ hello: false });
    return new Response(null, { status: 101, webSocket: client });
  }
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as {
      hello: boolean;
    } | null;
    if (
      typeof message !== "string" ||
      message.length > 4096 ||
      attachment?.hello
    ) {
      socket.close(1008, "Invalid link message");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      socket.close(1008, "Invalid link message");
      return;
    }
    const hello = LinkHello.safeParse(value);
    if (!hello.success) {
      socket.close(1008, "Invalid link message");
      return;
    }
    socket.serializeAttachment({ hello: true });
    socket.send(JSON.stringify({ type: "welcome", protocol: 1 }));
  }
  override async webSocketClose(
    socket: WebSocket,
    code: number,
  ): Promise<void> {
    socket.close(code === 1005 ? 1000 : code === 1006 ? 1011 : code);
  }
  override async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "Link failed");
  }
  /** `desired`: a wake's page of its one database, carried when valid and within the link's bound. */
  async notify(ids?: string[], desired?: DesiredResponse): Promise<number> {
    const hint = LinkDesiredHint.parse({
      type: "desired",
      ...(ids ? { ids: ids.map((id) => DatabaseId.parse(id)) } : {}),
    });
    const message = linkHint(hint, desired);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets("agent")) {
      const attachment = socket.deserializeAttachment() as {
        hello: boolean;
      } | null;
      if (!attachment?.hello) continue;
      try {
        socket.send(message);
        delivered++;
      } catch {
        socket.close(1011, "Link failed");
      }
    }
    return delivered;
  }
  async reportOrphans(observedAt: string, orphans: Orphan[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO orphan_reports(singleton,observed_at,orphans) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=excluded.observed_at,orphans=excluded.orphans WHERE excluded.observed_at>=orphan_reports.observed_at",
      observedAt,
      JSON.stringify(orphans),
    );
  }
}
/**
 * A hint on the wire. The page is carried only when it is a valid one of the hint's one database
 * and the message fits the link; otherwise the IDs alone, and the region pulls. Nothing of the
 * page is logged: it holds the database's credentials.
 */
function linkHint(hint: LinkDesiredHint, desired?: DesiredResponse): string {
  const plain = JSON.stringify(hint);
  if (desired === undefined) return plain;
  const carried = LinkDesiredHint.safeParse({ ...hint, desired });
  const message = carried.success ? JSON.stringify(carried.data) : undefined;
  if (
    message !== undefined &&
    new TextEncoder().encode(message).byteLength <= LINK_MESSAGE_MAX_BYTES
  )
    return message;
  console.warn(
    JSON.stringify({
      event: "link_hint_page_dropped",
      reason: message === undefined ? "invalid" : "too_large",
      ...(hint.ids?.length === 1 ? { database_id: hint.ids[0] } : {}),
    }),
  );
  return plain;
}
