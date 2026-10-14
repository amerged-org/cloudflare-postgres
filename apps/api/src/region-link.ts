// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  DatabaseId,
  NodeId,
  LinkDesiredHint,
  LinkHello,
  type Orphan,
} from "@pgcf/contracts";
import {
  DesiredPoolBinding,
  poolBindingScopeHash,
  type DesiredPoolBinding as PoolDelivery,
} from "@pgcf/contracts/postgres-pool";
import type { Env } from "./env.ts";

export class RegionLink extends DurableObject<Env> {
  private poolWaiters = new Map<
    string,
    {
      resolve: (
        value: { revision: number; bindings: PoolDelivery[] } | null,
      ) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS orphan_reports (singleton INTEGER PRIMARY KEY CHECK(singleton=1), observed_at TEXT NOT NULL, orphans TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool_deliveries(binding_id TEXT PRIMARY KEY,node_id TEXT NOT NULL,body TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pool_delivery_sequences(node_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0))",
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
  async notify(ids?: string[]): Promise<number> {
    const hint = LinkDesiredHint.parse({
      type: "desired",
      ...(ids ? { ids: ids.map((id) => DatabaseId.parse(id)) } : {}),
    });
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets("agent")) {
      const attachment = socket.deserializeAttachment() as {
        hello: boolean;
      } | null;
      if (!attachment?.hello) continue;
      try {
        socket.send(JSON.stringify(hint));
        delivered++;
      } catch {
        socket.close(1011, "Link failed");
      }
    }
    return delivered;
  }
  private poolDelivery(nodeId: string) {
    const sequence =
      this.ctx.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM pool_delivery_sequences WHERE node_id=?",
          nodeId,
        )
        .toArray()[0]?.revision ?? 0;
    const rows = this.ctx.storage.sql
      .exec<{ body: string }>(
        "SELECT body FROM pool_deliveries WHERE node_id=? ORDER BY binding_id LIMIT 257",
        nodeId,
      )
      .toArray();
    if (rows.length > 256) throw new Error("pool_delivery_bound_exceeded");
    return {
      revision: sequence,
      bindings: rows.map((row) =>
        DesiredPoolBinding.parse(JSON.parse(row.body)),
      ),
    };
  }
  async notifyPoolBinding(
    nodeId: string,
    value: PoolDelivery,
  ): Promise<number> {
    NodeId.parse(nodeId);
    const delivery = DesiredPoolBinding.parse(value),
      binding = delivery.binding;
    if (
      binding.scope.node_id !== nodeId ||
      (await poolBindingScopeHash(binding.scope)) !== binding.scope_sha256
    )
      throw new Error("pool_delivery_scope_mismatch");
    if (["released", "refused"].includes(binding.state))
      this.ctx.storage.sql.exec(
        "DELETE FROM pool_deliveries WHERE binding_id=? AND node_id=?",
        binding.scope.binding_id,
        nodeId,
      );
    else
      this.ctx.storage.sql.exec(
        "INSERT INTO pool_deliveries(binding_id,node_id,body) VALUES(?,?,?) ON CONFLICT(binding_id) DO UPDATE SET body=excluded.body WHERE pool_deliveries.node_id=excluded.node_id",
        binding.scope.binding_id,
        nodeId,
        JSON.stringify(delivery),
      );
    this.ctx.storage.sql.exec(
      "INSERT INTO pool_delivery_sequences(node_id,revision) VALUES(?,1) ON CONFLICT(node_id) DO UPDATE SET revision=revision+1",
      nodeId,
    );
    const result = this.poolDelivery(nodeId),
      waiter = this.poolWaiters.get(nodeId);
    if (waiter) {
      this.poolWaiters.delete(nodeId);
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    return result.revision;
  }
  async replacePoolBindings(
    nodeId: string,
    values: PoolDelivery[],
  ): Promise<number> {
    NodeId.parse(nodeId);
    if (values.length > 256) throw new Error("pool_delivery_bound_exceeded");
    const bindings = values
      .map((value) => DesiredPoolBinding.parse(value))
      .filter(
        (value) => !["released", "refused"].includes(value.binding.state),
      );
    for (const value of bindings)
      if (
        value.binding.scope.node_id !== nodeId ||
        (await poolBindingScopeHash(value.binding.scope)) !==
          value.binding.scope_sha256
      )
        throw new Error("pool_delivery_scope_mismatch");
    bindings.sort((a, b) =>
      a.binding.scope.binding_id < b.binding.scope.binding_id ? -1 : 1,
    );
    const current = this.poolDelivery(nodeId);
    if (JSON.stringify(current.bindings) === JSON.stringify(bindings))
      return current.revision;
    this.ctx.storage.sql.exec(
      "DELETE FROM pool_deliveries WHERE node_id=?",
      nodeId,
    );
    for (const value of bindings)
      this.ctx.storage.sql.exec(
        "INSERT INTO pool_deliveries(binding_id,node_id,body) VALUES(?,?,?)",
        value.binding.scope.binding_id,
        nodeId,
        JSON.stringify(value),
      );
    this.ctx.storage.sql.exec(
      "INSERT INTO pool_delivery_sequences(node_id,revision) VALUES(?,1) ON CONFLICT(node_id) DO UPDATE SET revision=revision+1",
      nodeId,
    );
    const result = this.poolDelivery(nodeId),
      waiter = this.poolWaiters.get(nodeId);
    if (waiter) {
      this.poolWaiters.delete(nodeId);
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    return result.revision;
  }
  /** One bounded held request per actual node; committed claims wake it without a D1 poll. */
  async waitForPoolBinding(
    nodeId: string,
    afterRevision: number,
    deadline: number,
  ): Promise<{ revision: number; bindings: PoolDelivery[] } | null> {
    NodeId.parse(nodeId);
    const now = Date.now();
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      !Number.isSafeInteger(deadline) ||
      deadline > now + 25000
    )
      throw new Error("invalid_pool_wait");
    const current = this.poolDelivery(nodeId);
    if (current.revision > afterRevision) return current;
    if (deadline <= now) return null;
    const previous = this.poolWaiters.get(nodeId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(null);
      this.poolWaiters.delete(nodeId);
    }
    if (this.poolWaiters.size >= 1000)
      throw new Error("pool_waiter_bound_exceeded");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const current = this.poolWaiters.get(nodeId);
        if (current?.timer === timer) {
          this.poolWaiters.delete(nodeId);
          resolve(null);
        }
      }, deadline - now);
      this.poolWaiters.set(nodeId, { resolve, timer });
    });
  }
  async reportOrphans(observedAt: string, orphans: Orphan[]): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO orphan_reports(singleton,observed_at,orphans) VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET observed_at=excluded.observed_at,orphans=excluded.orphans WHERE excluded.observed_at>=orphan_reports.observed_at",
      observedAt,
      JSON.stringify(orphans),
    );
  }
}
