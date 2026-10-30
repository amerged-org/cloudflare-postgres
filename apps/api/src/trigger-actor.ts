// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { WebhookEnvelope } from "@pgcf/contracts/webhooks";
import type { Env } from "./env.ts";
import {
  CONTROL_MAINTENANCE_RETRY_MS,
  controlProducerPaused,
  maintenanceEnvironment,
} from "./control-maintenance.ts";

/** An event as the producer hands it to the database's actor. */
export interface IngestedEvent {
  id: string;
  type: string;
  occurred_at: string;
  project_id: string;
  database_id: string;
  data: Record<string, unknown>;
}

export type StoredDelivery = {
  id: string;
  event_id: string;
  event_type: string;
  webhook_id: string;
  state: "pending" | "delivered" | "dead_lettered";
  attempts: number;
  created_ms: number;
  next_attempt_ms: number | null;
  delivered_ms: number | null;
  last_status: number | null;
  last_error: string | null;
};

/** Pending deliveries one database can hold; beyond it a new delivery is dead-lettered at once. */
export const TRIGGER_MAX_PENDING = 10_000;
export const TRIGGER_DELIVERED_RETENTION_MS = 24 * 3_600_000;
export const TRIGGER_DEAD_LETTER_RETENTION_MS = 7 * 86_400_000;
const ALARM_BATCH = 25;
const ALARM_CONCURRENCY = 5;
/** A claimed attempt that never reports is tried again after this long (a crash mid-request). */
const ATTEMPT_LEASE_MS = 30_000;
const MIN_ALARM_GAP_MS = 250;

type DeliveryRow = {
  id: string;
  event_id: string;
  webhook_id: string;
  attempts: number;
  window_start_ms: number;
  type: string;
  occurred_at: string;
  project_id: string;
  database_id: string;
  data: string;
};

/**
 * One per database that has events for a subscription. It stores the events it is handed, one
 * delivery per matching subscription, and delivers them from its own alarm with the retry rules of
 * `domain/webhook-retry.ts`. Nothing polls it, and a database that never has an event has no actor.
 * Like every Durable Object class this module is evaluated by each cold object, so the delivery
 * code loads with the first alarm.
 */
export class TriggerActor extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, maintenanceEnvironment(env));
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS events(
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          project_id TEXT NOT NULL,
          database_id TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS deliveries(
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
          webhook_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN('pending','delivered','dead_lettered')),
          attempts INTEGER NOT NULL DEFAULT 0,
          created_ms INTEGER NOT NULL,
          window_start_ms INTEGER NOT NULL,
          next_attempt_ms INTEGER,
          delivered_ms INTEGER,
          dead_ms INTEGER,
          last_status INTEGER,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(next_attempt_ms) WHERE state='pending';
        CREATE INDEX IF NOT EXISTS deliveries_listing ON deliveries(created_ms DESC, id DESC);
      `);
    });
  }

  /**
   * Stores the event and a delivery for each webhook id, once: an event or delivery id that is
   * already here is left as it is, so the producer may hand over the same event again.
   */
  async ingest(
    event: IngestedEvent,
    webhookIds: readonly string[],
    deliveryIds: readonly string[],
  ): Promise<number> {
    if (webhookIds.length !== deliveryIds.length || webhookIds.length === 0)
      throw new RangeError("One delivery id per webhook is required");
    const now = Date.now();
    let created = 0;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "INSERT OR IGNORE INTO events(id,type,occurred_at,project_id,database_id,data) VALUES(?,?,?,?,?,?)",
        event.id,
        event.type,
        event.occurred_at,
        event.project_id,
        event.database_id,
        JSON.stringify(event.data),
      );
      let pending = sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM deliveries WHERE state='pending'",
        )
        .one().n;
      webhookIds.forEach((webhookId, index) => {
        const full = pending >= TRIGGER_MAX_PENDING;
        const result = sql.exec(
          `INSERT OR IGNORE INTO deliveries(id,event_id,webhook_id,state,attempts,created_ms,window_start_ms,next_attempt_ms,dead_ms,last_error)
           VALUES(?,?,?,?,0,?,?,?,?,?)`,
          deliveryIds[index],
          event.id,
          webhookId,
          full ? "dead_lettered" : "pending",
          now,
          now,
          full ? null : now,
          full ? now : null,
          full ? "expired" : null,
        );
        if (result.rowsWritten > 0) {
          created += 1;
          if (!full) pending += 1;
        }
      });
    });
    if (created > 0) await this.arm(now);
    return created;
  }

  /** Newest first. `before` is the (created_ms, id) of the last row of the previous page. */
  list(
    limit: number,
    before: { created_ms: number; id: string } | null,
  ): { rows: StoredDelivery[]; more: boolean } {
    const rows = this.ctx.storage.sql
      .exec<StoredDelivery>(
        `SELECT d.id, d.event_id, e.type AS event_type, d.webhook_id, d.state, d.attempts,
                d.created_ms, d.next_attempt_ms, d.delivered_ms, d.last_status, d.last_error
         FROM deliveries d JOIN events e ON e.id = d.event_id
         WHERE (?1 IS NULL OR d.created_ms < ?1 OR (d.created_ms = ?1 AND d.id < ?2))
         ORDER BY d.created_ms DESC, d.id DESC LIMIT ?3`,
        before?.created_ms ?? null,
        before?.id ?? "",
        limit + 1,
      )
      .toArray();
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }

  /** Delivers again. A delivery still in its retry schedule is already on its way. */
  async replay(
    deliveryId: string,
  ): Promise<"replayed" | "not_found" | "not_replayable"> {
    const row = this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM deliveries WHERE id=?",
        deliveryId,
      )
      .toArray()[0];
    if (!row) return "not_found";
    if (row.state === "pending") return "not_replayable";
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE deliveries SET state='pending',attempts=0,window_start_ms=?1,next_attempt_ms=?1,
         delivered_ms=NULL,dead_ms=NULL,last_status=NULL,last_error=NULL WHERE id=?2`,
      now,
      deliveryId,
    );
    await this.arm(now);
    return "replayed";
  }

  override async alarm(): Promise<void> {
    if (controlProducerPaused(this.env, "trigger_actor")) {
      await this.ctx.storage.setAlarm(
        Date.now() + CONTROL_MAINTENANCE_RETRY_MS,
      );
      return;
    }
    const started = Date.now();
    // Scheduled first: whatever this cycle does, the loop goes on.
    await this.ctx.storage.setAlarm(started + ATTEMPT_LEASE_MS);
    const due = this.ctx.storage.sql
      .exec<DeliveryRow>(
        `SELECT d.id, d.event_id, d.webhook_id, d.attempts, d.window_start_ms,
                e.type, e.occurred_at, e.project_id, e.database_id, e.data
         FROM deliveries d JOIN events e ON e.id = d.event_id
         WHERE d.state='pending' AND d.next_attempt_ms <= ?
         ORDER BY d.next_attempt_ms LIMIT ?`,
        started,
        ALARM_BATCH,
      )
      .toArray();
    if (due.length > 0) {
      // Claim before sending: a crash leaves the delivery due again after the lease.
      this.ctx.storage.transactionSync(() => {
        for (const row of due)
          this.ctx.storage.sql.exec(
            "UPDATE deliveries SET attempts=attempts+1,next_attempt_ms=? WHERE id=?",
            started + ATTEMPT_LEASE_MS,
            row.id,
          );
      });
      const { attemptDelivery } = await import("./domain/webhook-delivery.ts");
      const { decideRetry } = await import("./domain/webhook-retry.ts");
      for (let i = 0; i < due.length; i += ALARM_CONCURRENCY) {
        await Promise.all(
          due.slice(i, i + ALARM_CONCURRENCY).map(async (row) => {
            const attempts = row.attempts + 1;
            let result;
            try {
              result = await attemptDelivery(
                this.env,
                row.webhook_id,
                {
                  id: row.event_id,
                  type: row.type,
                  occurred_at: row.occurred_at,
                  project_id: row.project_id,
                  database_id: row.database_id,
                  data: JSON.parse(row.data) as Record<string, unknown>,
                } as WebhookEnvelope,
                row.id,
              );
            } catch (error) {
              // Not the receiver's fault (D1 or the keys): the lease retries it, nothing is lost.
              console.error(
                JSON.stringify({
                  event: "webhook_attempt_unavailable",
                  error_class: error instanceof Error ? error.name : "unknown",
                }),
              );
              return;
            }
            const now = Date.now();
            if (result.kind === "delivered") {
              this.ctx.storage.sql.exec(
                "UPDATE deliveries SET state='delivered',delivered_ms=?,next_attempt_ms=NULL,last_status=?,last_error=NULL WHERE id=?",
                now,
                result.status,
                row.id,
              );
              return;
            }
            const decision =
              result.kind === "permanent"
                ? ({ state: "dead_letter", reason: "permanent" } as const)
                : decideRetry({
                    attempts,
                    nowMs: now,
                    createdAtMs: row.window_start_ms,
                    status: result.status,
                    retryAfterSeconds: result.retryAfterSeconds,
                  });
            const lastError = result.kind === "failed" ? result.error : "http";
            if (decision.state === "retry") {
              this.ctx.storage.sql.exec(
                "UPDATE deliveries SET next_attempt_ms=?,last_status=?,last_error=? WHERE id=?",
                decision.at,
                result.status,
                lastError,
                row.id,
              );
            } else {
              this.ctx.storage.sql.exec(
                "UPDATE deliveries SET state='dead_lettered',dead_ms=?,next_attempt_ms=NULL,last_status=?,last_error=? WHERE id=?",
                now,
                result.status,
                decision.reason,
                row.id,
              );
            }
          }),
        );
      }
    }
    this.prune(started);
    await this.arm(Date.now());
  }

  private prune(now: number): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "DELETE FROM deliveries WHERE (state='delivered' AND delivered_ms<?) OR (state='dead_lettered' AND dead_ms<?)",
      now - TRIGGER_DELIVERED_RETENTION_MS,
      now - TRIGGER_DEAD_LETTER_RETENTION_MS,
    );
    sql.exec(
      "DELETE FROM events WHERE NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.event_id=events.id)",
    );
  }

  /** The next alarm is the earliest due delivery; with none pending, a daily visit prunes. */
  private async arm(now: number): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        "SELECT MIN(next_attempt_ms) AS at FROM deliveries WHERE state='pending'",
      )
      .one().at;
    const any = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM deliveries")
      .one().n;
    if (next !== null) {
      await this.ctx.storage.setAlarm(Math.max(next, now + MIN_ALARM_GAP_MS));
    } else if (any > 0) {
      await this.ctx.storage.setAlarm(now + 86_400_000);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }
}
