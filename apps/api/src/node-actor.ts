// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import {
  AgentLinkMessage,
  DatabaseId,
  FleetReleaseId,
  NODE_LINK_MESSAGE_MAX_BYTES,
  NODE_PROTOCOL_VERSION,
  NODE_SAMPLE_INTERVAL_MS,
  NodeId,
  NodeSample,
  type ServerLinkMessage,
} from "@pgcf/contracts";
import type { Env } from "./env.ts";

/** The node whose sockets and samples this object holds, as the Worker authenticated it. */
export const NODE_HEADER = "X-PGCF-Node";
export const NODE_UID_HEADER = "X-PGCF-Node-Uid";
const MINUTE_MS = 60_000;
/** Samples of the last minute are written this long after it ends if no later sample arrived. */
const FLUSH_DELAY_MS = 5_000;
/** The minute rollups placement reads are kept this long (plan 4.8: the peak of 7 days). */
const ROLLUP_RETENTION_MINUTES = 8 * 24 * 60;

/** The sample columns of one `node_minutes` row, folded from the samples of that minute. */
interface Minute {
  minute: number;
  samples: number;
  memory_total_bytes: number;
  memory_used_bytes_sum: number;
  memory_used_bytes_max: number;
  cpu_cores: number;
  cpu_busy_millicores_sum: number;
  cpu_busy_millicores_max: number;
  awake_sum: number;
  awake_max: number;
  awake_memory_mib_sum: number;
  awake_memory_mib_max: number;
  starting_max: number;
  queued_max: number;
  no_room_samples: number;
  pool: NodeSample["pool"];
  volumes_total: number;
  volumes_mounted: number;
  archive_ready_files: number | null;
  archive_oldest_ready_seconds: number | null;
}
interface Attachment {
  hello: boolean;
}

/** What a minute's row holds in D1 once it is written: the minute and how many samples it folds. */
const written = (minute: Minute) => `${minute.minute}:${minute.samples}`;

/** Folds a sample into the row of its minute. */
export function foldSample(
  previous: Minute | undefined,
  sample: NodeSample,
): Minute {
  const minute = Math.floor(Date.parse(sample.observed_at) / MINUTE_MS),
    used = sample.memory.total_bytes - sample.memory.available_bytes,
    base: Minute =
      previous?.minute === minute
        ? previous
        : {
            minute,
            samples: 0,
            memory_total_bytes: 0,
            memory_used_bytes_sum: 0,
            memory_used_bytes_max: 0,
            cpu_cores: 0,
            cpu_busy_millicores_sum: 0,
            cpu_busy_millicores_max: 0,
            awake_sum: 0,
            awake_max: 0,
            awake_memory_mib_sum: 0,
            awake_memory_mib_max: 0,
            starting_max: 0,
            queued_max: 0,
            no_room_samples: 0,
            pool: null,
            volumes_total: 0,
            volumes_mounted: 0,
            archive_ready_files: null,
            archive_oldest_ready_seconds: null,
          };
  return {
    minute,
    samples: base.samples + 1,
    memory_total_bytes: sample.memory.total_bytes,
    memory_used_bytes_sum: base.memory_used_bytes_sum + used,
    memory_used_bytes_max: Math.max(base.memory_used_bytes_max, used),
    cpu_cores: sample.cpu.cores,
    cpu_busy_millicores_sum:
      base.cpu_busy_millicores_sum + sample.cpu.busy_millicores,
    cpu_busy_millicores_max: Math.max(
      base.cpu_busy_millicores_max,
      sample.cpu.busy_millicores,
    ),
    awake_sum: base.awake_sum + sample.awake.length,
    awake_max: Math.max(base.awake_max, sample.awake.length),
    awake_memory_mib_sum: base.awake_memory_mib_sum + sample.awake_memory_mib,
    awake_memory_mib_max: Math.max(
      base.awake_memory_mib_max,
      sample.awake_memory_mib,
    ),
    starting_max: Math.max(base.starting_max, sample.starting),
    queued_max: Math.max(base.queued_max, sample.queued),
    no_room_samples: base.no_room_samples + (sample.room ? 0 : 1),
    pool: sample.pool,
    volumes_total: sample.volumes.total,
    volumes_mounted: sample.volumes.mounted,
    archive_ready_files: sample.archive.ready_files,
    archive_oldest_ready_seconds: sample.archive.oldest_ready_seconds,
  };
}

/**
 * The link of one node (plan 4.9, 5.3): the agent's outbound, hibernatable WebSocket, its newest
 * sample, and the hint that tells it to pull its desired page. The samples of a minute are folded
 * and written to D1 once, and a node's first sample opens it for placement.
 */
export class NodeActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS node_link(singleton INTEGER PRIMARY KEY CHECK(singleton=1),node_id TEXT NOT NULL,node_uid TEXT NOT NULL,sample TEXT,received_at INTEGER,minute TEXT,flushed TEXT)",
    );
  }
  override async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return new Response("WebSocket upgrade required", { status: 426 });
    const node = NodeId.safeParse(request.headers.get(NODE_HEADER)),
      uid = request.headers.get(NODE_UID_HEADER);
    if (
      !node.success ||
      uid === null ||
      !this.env.NODE_ACTOR.idFromName(node.data).equals(this.ctx.id)
    )
      return new Response("Unknown node", { status: 400 });
    this.ctx.storage.sql.exec(
      "INSERT INTO node_link(singleton,node_id,node_uid) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET node_id=excluded.node_id,node_uid=excluded.node_uid",
      node.data,
      uid,
    );
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    for (const old of this.ctx.getWebSockets())
      old.close(1012, "Agent connection replaced");
    this.ctx.acceptWebSocket(server, ["agent"]);
    server.serializeAttachment({ hello: false } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }
  private link() {
    return this.ctx.storage.sql
      .exec<{
        node_id: string;
        node_uid: string;
        sample: string | null;
        received_at: number | null;
        minute: string | null;
        flushed: string | null;
      }>(
        "SELECT node_id,node_uid,sample,received_at,minute,flushed FROM node_link WHERE singleton=1",
      )
      .toArray()[0];
  }
  override async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as Attachment | null;
    const link = this.link();
    let value: unknown;
    try {
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).byteLength >
          NODE_LINK_MESSAGE_MAX_BYTES ||
        link === undefined
      )
        throw new Error("invalid");
      value = JSON.parse(message);
    } catch {
      socket.close(1008, "Invalid link message");
      return;
    }
    const parsed = AgentLinkMessage.safeParse(value);
    if (
      !parsed.success ||
      (parsed.data.type === "hello") === attachment?.hello
    ) {
      socket.close(1008, "Invalid link message");
      return;
    }
    if (parsed.data.type === "hello") {
      socket.serializeAttachment({ hello: true } satisfies Attachment);
      await this.env.DB.prepare(
        "UPDATE nodes SET agent_version=?,reported_release_id=?,updated_at=? WHERE id=? AND node_uid=?",
      )
        .bind(
          parsed.data.agent_version,
          parsed.data.release_id === null
            ? null
            : FleetReleaseId.parse(parsed.data.release_id),
          new Date().toISOString(),
          link.node_id,
          link.node_uid,
        )
        .run();
      socket.send(
        JSON.stringify({
          type: "welcome",
          protocol: NODE_PROTOCOL_VERSION,
        } satisfies ServerLinkMessage),
      );
      return;
    }
    await this.takeSample(link, parsed.data.sample);
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

  private async takeSample(
    link: NonNullable<ReturnType<NodeActor["link"]>>,
    sample: NodeSample,
  ): Promise<void> {
    const now = Date.now(),
      at = Date.parse(sample.observed_at);
    // A sample cannot be from the future, and one from before the previous sample is old news.
    if (at > now + NODE_SAMPLE_INTERVAL_MS) return;
    if (
      link.sample !== null &&
      Date.parse((JSON.parse(link.sample) as NodeSample).observed_at) >= at
    )
      return;
    const previous =
      link.minute === null ? undefined : (JSON.parse(link.minute) as Minute);
    const folded = foldSample(previous, sample);
    this.ctx.storage.sql.exec(
      "UPDATE node_link SET sample=?,received_at=?,minute=? WHERE singleton=1",
      JSON.stringify(sample),
      now,
      JSON.stringify(folded),
    );
    // The first sample after enrollment opens the node for placement at once; the rest wait for
    // their minute to end.
    if (
      previous !== undefined &&
      previous.minute !== folded.minute &&
      link.flushed !== written(previous)
    )
      await this.flush(link, previous, null);
    else if (previous === undefined)
      await this.flush(link, folded, sample, true);
    await this.ctx.storage.setAlarm(
      (folded.minute + 1) * MINUTE_MS + FLUSH_DELAY_MS,
    );
  }
  override async alarm(): Promise<void> {
    const link = this.link();
    if (!link?.minute || !link.sample) return;
    const minute = JSON.parse(link.minute) as Minute;
    if (link.flushed === written(minute)) return;
    await this.flush(link, minute, JSON.parse(link.sample) as NodeSample);
  }

  /** Writes a minute's row, and with `sample` the node's vitals, in one batch. */
  private async flush(
    link: NonNullable<ReturnType<NodeActor["link"]>>,
    minute: Minute,
    sample: NodeSample | null,
    opening = false,
  ): Promise<void> {
    const db = this.env.DB,
      now = new Date().toISOString(),
      pool = minute.pool;
    const statements = [
      db
        .prepare(
          `INSERT INTO node_minutes(node_id,minute,samples,memory_total_bytes,memory_used_bytes_sum,memory_used_bytes_max,
             cpu_cores,cpu_busy_millicores_sum,cpu_busy_millicores_max,awake_sum,awake_max,awake_memory_mib_sum,
             awake_memory_mib_max,starting_max,queued_max,no_room_samples,pool_data_total_bytes,pool_data_used_bytes,
             pool_metadata_total_bytes,pool_metadata_used_bytes,pool_nominal_bytes,volumes_total,volumes_mounted,
             archive_ready_files,archive_oldest_ready_seconds)
           SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes WHERE id=? AND node_uid=?)
           ON CONFLICT(node_id,minute) DO UPDATE SET samples=excluded.samples,memory_total_bytes=excluded.memory_total_bytes,
             memory_used_bytes_sum=excluded.memory_used_bytes_sum,memory_used_bytes_max=excluded.memory_used_bytes_max,
             cpu_cores=excluded.cpu_cores,cpu_busy_millicores_sum=excluded.cpu_busy_millicores_sum,
             cpu_busy_millicores_max=excluded.cpu_busy_millicores_max,awake_sum=excluded.awake_sum,awake_max=excluded.awake_max,
             awake_memory_mib_sum=excluded.awake_memory_mib_sum,awake_memory_mib_max=excluded.awake_memory_mib_max,
             starting_max=excluded.starting_max,queued_max=excluded.queued_max,no_room_samples=excluded.no_room_samples,
             pool_data_total_bytes=excluded.pool_data_total_bytes,pool_data_used_bytes=excluded.pool_data_used_bytes,
             pool_metadata_total_bytes=excluded.pool_metadata_total_bytes,pool_metadata_used_bytes=excluded.pool_metadata_used_bytes,
             pool_nominal_bytes=excluded.pool_nominal_bytes,volumes_total=excluded.volumes_total,
             volumes_mounted=excluded.volumes_mounted,archive_ready_files=excluded.archive_ready_files,
             archive_oldest_ready_seconds=excluded.archive_oldest_ready_seconds`,
        )
        .bind(
          link.node_id,
          minute.minute,
          minute.samples,
          minute.memory_total_bytes,
          minute.memory_used_bytes_sum,
          minute.memory_used_bytes_max,
          minute.cpu_cores,
          minute.cpu_busy_millicores_sum,
          minute.cpu_busy_millicores_max,
          minute.awake_sum,
          minute.awake_max,
          minute.awake_memory_mib_sum,
          minute.awake_memory_mib_max,
          minute.starting_max,
          minute.queued_max,
          minute.no_room_samples,
          pool?.data_total_bytes ?? null,
          pool?.data_used_bytes ?? null,
          pool?.metadata_total_bytes ?? null,
          pool?.metadata_used_bytes ?? null,
          pool?.nominal_bytes ?? null,
          minute.volumes_total,
          minute.volumes_mounted,
          minute.archive_ready_files,
          minute.archive_oldest_ready_seconds,
          link.node_id,
          link.node_uid,
        ),
    ];
    if (sample) {
      // A lost node stays closed and not ready: samples of a fenced node change nothing about it.
      statements.push(
        db
          .prepare(
            `UPDATE nodes SET last_observed_at=?,last_sample_json=?,allocatable_memory_mib=?,allocatable_cpu_millicores=?,
               storage_gib_total=COALESCE(?,storage_gib_total),ready=1,
               schedulable=CASE WHEN last_observed_at IS NULL THEN 1 ELSE schedulable END,updated_at=?
             WHERE id=? AND node_uid=? AND lost_at IS NULL`,
          )
          .bind(
            sample.observed_at,
            JSON.stringify(sample),
            Math.floor(sample.memory.total_bytes / 1024 ** 2),
            sample.cpu.cores * 1000,
            sample.pool === null
              ? null
              : Math.floor(sample.pool.data_total_bytes / 1024 ** 3),
            now,
            link.node_id,
            link.node_uid,
          ),
      );
      if (opening)
        statements.push(
          db
            .prepare(
              `UPDATE node_additions SET status='ready',revision=revision+1,updated_at=?
               WHERE node_id=? AND status IN('audited','bootstrapping')
                 AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND node_uid=? AND lost_at IS NULL)`,
            )
            .bind(now, link.node_id, link.node_id, link.node_uid),
        );
    }
    if (minute.minute % 60 === 0)
      statements.push(
        db
          .prepare("DELETE FROM node_minutes WHERE node_id=? AND minute<?")
          .bind(link.node_id, minute.minute - ROLLUP_RETENTION_MINUTES),
      );
    await db.batch(statements);
    this.ctx.storage.sql.exec(
      "UPDATE node_link SET flushed=? WHERE singleton=1",
      written(minute),
    );
  }

  /**
   * Tells the agent to pull its desired page; with `ids`, only those databases changed. It reaches
   * the socket of an agent that said hello, and the page it pulls holds the truth either way.
   */
  async notify(ids?: string[]): Promise<number> {
    const message: ServerLinkMessage = {
      type: "desired",
      ...(ids ? { ids: ids.map((id) => DatabaseId.parse(id)) } : {}),
    };
    return this.send(JSON.stringify(message));
  }
  private send(message: string): number {
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets("agent")) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
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
  /**
   * The node was declared lost (plan 9.4): its page now holds the fence, so the agent is told to
   * pull it and the link is closed. The fenced key cannot join a new link.
   */
  async fence(): Promise<void> {
    this.send(JSON.stringify({ type: "desired" } satisfies ServerLinkMessage));
    for (const socket of this.ctx.getWebSockets())
      socket.close(1008, "Node declared lost");
  }
  /** What placement and the alerts read of the link without D1: the newest sample and whether it is connected. */
  async latest(): Promise<{
    connected: boolean;
    received_at: number | null;
    sample: NodeSample | null;
  }> {
    const link = this.link();
    return {
      connected: this.ctx
        .getWebSockets("agent")
        .some(
          (socket) =>
            (socket.deserializeAttachment() as Attachment | null)?.hello,
        ),
      received_at: link?.received_at ?? null,
      sample: link?.sample ? NodeSample.parse(JSON.parse(link.sample)) : null,
    };
  }
}
