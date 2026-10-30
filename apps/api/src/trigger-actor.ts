// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { ExecutionMetric } from "@pgcf/contracts/execution-usage";
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

/** What a schedule is made of, as the route validated it. */
export interface ScheduleInput {
  cron: string | null;
  every_seconds: number | null;
  statements: string[];
  role: string;
  timeout_ms: number;
  enabled: boolean;
}
export type StoredSchedule = {
  name: string;
  cron: string | null;
  every_seconds: number | null;
  anchor_ms: number;
  statements: string;
  role: string;
  timeout_ms: number;
  enabled: number;
  created_ms: number;
  occurrence_ms: number | null;
  fire_ms: number | null;
  deadline_ms: number | null;
  attempts: number;
  manual_pending: number;
  inflight_ms: number | null;
  inflight_manual: number;
};
export type StoredRun = {
  id: number;
  schedule: string;
  scheduled_ms: number;
  started_ms: number | null;
  finished_ms: number;
  outcome: string;
  sqlstate: string | null;
  attempts: number;
  manual: number;
};
const HOUR_MS = 3_600_000;
/** A closed hour is written to D1 this long after it ended; a failed write waits a minute. */
const COUNTER_FLUSH_DELAY_MS = 60_000;
export const TRIGGER_RUN_HISTORY = 50;
/** An in-flight claim older than this never reported (a crash): its outcome is unknown. */
export const TRIGGER_INFLIGHT_STALE_MS = 20 * 60_000;
const SCHEDULE_START_BATCH = 5;

/** Pending deliveries one database can hold; beyond it a new delivery is dead-lettered at once. */
export const TRIGGER_MAX_PENDING = 10_000;
export const TRIGGER_DELIVERED_RETENTION_MS = 24 * 3_600_000;
export const TRIGGER_DEAD_LETTER_RETENTION_MS = 7 * 86_400_000;
const ALARM_BATCH = 25;
const ALARM_CONCURRENCY = 5;
/** A claimed attempt that never reports is tried again after this long (a crash mid-request). */
const ATTEMPT_LEASE_MS = 30_000;
const MIN_ALARM_GAP_MS = 250;

type Timing = typeof import("./domain/schedule-timing.ts");

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
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS counters(hour_ms INTEGER NOT NULL, metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(hour_ms, metric));
        CREATE TABLE IF NOT EXISTS schedules(
          name TEXT PRIMARY KEY,
          cron TEXT,
          every_seconds INTEGER,
          anchor_ms INTEGER NOT NULL,
          statements TEXT NOT NULL,
          role TEXT NOT NULL,
          timeout_ms INTEGER NOT NULL,
          enabled INTEGER NOT NULL,
          created_ms INTEGER NOT NULL,
          occurrence_ms INTEGER,
          fire_ms INTEGER,
          deadline_ms INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0,
          manual_pending INTEGER NOT NULL DEFAULT 0,
          inflight_ms INTEGER,
          inflight_manual INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS runs(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          schedule TEXT NOT NULL,
          scheduled_ms INTEGER NOT NULL,
          started_ms INTEGER,
          finished_ms INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          sqlstate TEXT,
          attempts INTEGER NOT NULL,
          manual INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_by_schedule ON runs(schedule, id DESC);
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
      this.remember(event.database_id, event.project_id);
      const data = JSON.stringify(event.data);
      const stored = sql.exec(
        "INSERT OR IGNORE INTO events(id,type,occurred_at,project_id,database_id,data) VALUES(?,?,?,?,?,?)",
        event.id,
        event.type,
        event.occurred_at,
        event.project_id,
        event.database_id,
        data,
      );
      if (stored.rowsWritten > 0) {
        this.count("events_emitted");
        this.count("event_bytes", new TextEncoder().encode(data).length);
      }
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
          if (full) this.count("webhook_deliveries_dead_lettered");
          else pending += 1;
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

  private timingLibrary: Timing | undefined;

  /** Loaded when a schedule needs it: a cold object that has none never evaluates it. */
  private async timing_(): Promise<Timing> {
    return (this.timingLibrary ??= await import("./domain/schedule-timing.ts"));
  }

  /** Creates or replaces a schedule; the first occurrence is the next one after now. */
  async putSchedule(
    databaseId: string,
    projectId: string,
    name: string,
    input: ScheduleInput,
    limit: number,
  ): Promise<"created" | "updated" | "limit"> {
    const { fireTime, intervalAfter, lateLimitMs, nextOccurrence } =
      await this.timing_();
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec<StoredSchedule>("SELECT * FROM schedules WHERE name=?", name)
      .toArray()[0];
    if (
      !existing &&
      sql.exec<{ n: number }>("SELECT count(*) AS n FROM schedules").one().n >=
        limit
    )
      return "limit";
    const now = Date.now();
    this.remember(databaseId, projectId);
    const anchor =
      existing && existing.every_seconds === input.every_seconds
        ? existing.anchor_ms
        : now;
    const timing = {
      cron: input.cron,
      everySeconds: input.every_seconds,
      anchorMs: anchor,
    };
    const occurrence = input.enabled ? nextOccurrence(timing, now) : null;
    const fire =
      occurrence === null
        ? null
        : fireTime(timing, databaseId, name, occurrence);
    const deadline =
      occurrence === null
        ? null
        : fire! + lateLimitMs(intervalAfter(timing, occurrence));
    sql.exec(
      `INSERT INTO schedules(name,cron,every_seconds,anchor_ms,statements,role,timeout_ms,enabled,created_ms,occurrence_ms,fire_ms,deadline_ms)
       VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
       ON CONFLICT(name) DO UPDATE SET cron=?2,every_seconds=?3,anchor_ms=?4,statements=?5,role=?6,timeout_ms=?7,
         enabled=?8,occurrence_ms=?10,fire_ms=?11,deadline_ms=?12,attempts=0`,
      name,
      input.cron,
      input.every_seconds,
      anchor,
      JSON.stringify(input.statements),
      input.role,
      input.timeout_ms,
      input.enabled ? 1 : 0,
      existing?.created_ms ?? now,
      occurrence,
      fire,
      deadline,
    );
    void this.arm(now);
    return existing ? "updated" : "created";
  }

  getSchedule(name: string): StoredSchedule | null {
    return (
      this.ctx.storage.sql
        .exec<StoredSchedule>("SELECT * FROM schedules WHERE name=?", name)
        .toArray()[0] ?? null
    );
  }

  listSchedules(): StoredSchedule[] {
    return this.ctx.storage.sql
      .exec<StoredSchedule>("SELECT * FROM schedules ORDER BY name")
      .toArray();
  }

  deleteSchedule(name: string): boolean {
    const sql = this.ctx.storage.sql;
    const result = sql.exec("DELETE FROM schedules WHERE name=?", name);
    sql.exec("DELETE FROM runs WHERE schedule=?", name);
    return result.rowsWritten > 0;
  }

  listRuns(name: string, limit: number): StoredRun[] {
    return this.ctx.storage.sql
      .exec<StoredRun>(
        "SELECT * FROM runs WHERE schedule=? ORDER BY id DESC LIMIT ?",
        name,
        limit,
      )
      .toArray();
  }

  /** Asks for one run now, besides the regular occurrences; it does not move them. */
  runNow(name: string): "queued" | "not_found" | "busy" {
    const row = this.getSchedule(name);
    if (!row) return "not_found";
    if (row.manual_pending === 1 || row.inflight_ms !== null) return "busy";
    this.ctx.storage.sql.exec(
      "UPDATE schedules SET manual_pending=1 WHERE name=?",
      name,
    );
    void this.arm(Date.now());
    return "queued";
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
        this.count("webhook_attempts", due.length);
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
              this.count("webhook_deliveries_delivered");
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
              this.count("webhook_deliveries_dead_lettered");
            }
          }),
        );
      }
    }
    await this.startSchedules(started);
    await this.flushCounters(started);
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

  private meta(key: string): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ value: string }>("SELECT value FROM meta WHERE key=?", key)
        .toArray()[0]?.value ?? null
    );
  }

  private remember(databaseId: string, projectId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta(key,value) VALUES('database_id',?1),('project_id',?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      databaseId,
      projectId,
    );
  }

  /** Counts in the same synchronous step as the state change it describes. */
  private count(metric: ExecutionMetric, amount = 1): void {
    if (amount === 0) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters(hour_ms,metric,value) VALUES(?,?,?) ON CONFLICT(hour_ms,metric) DO UPDATE SET value=value+excluded.value",
      Math.floor(Date.now() / HOUR_MS) * HOUR_MS,
      metric,
      amount,
    );
  }

  private flushRetryAt = 0;

  /**
   * Writes the closed hours to D1 as absolute values and drops them here only after D1 took them. A
   * closed hour never changes again, so writing it twice is harmless.
   */
  private async flushCounters(now: number): Promise<void> {
    if (now < this.flushRetryAt) return;
    const sql = this.ctx.storage.sql;
    const rows = sql
      .exec<{ hour_ms: number; metric: string; value: number }>(
        "SELECT hour_ms, metric, value FROM counters WHERE hour_ms<? ORDER BY hour_ms LIMIT 100",
        Math.floor(now / HOUR_MS) * HOUR_MS,
      )
      .toArray();
    if (rows.length === 0) return;
    const databaseId = this.meta("database_id"),
      projectId = this.meta("project_id");
    if (!databaseId || !projectId) return;
    try {
      await this.env.DB.batch(
        rows.map((row) =>
          this.env.DB.prepare(
            `INSERT INTO execution_usage(database_id,project_id,hour_start,metric,value) VALUES(?,?,?,?,?)
             ON CONFLICT(database_id,hour_start,metric) DO UPDATE SET value=excluded.value`,
          ).bind(
            databaseId,
            projectId,
            new Date(row.hour_ms).toISOString(),
            row.metric,
            row.value,
          ),
        ),
      );
    } catch (error) {
      this.flushRetryAt = now + COUNTER_FLUSH_DELAY_MS;
      console.error(
        JSON.stringify({
          event: "execution_usage_flush_failed",
          error_class: error instanceof Error ? error.name : "unknown",
        }),
      );
      return;
    }
    for (const row of rows)
      sql.exec(
        "DELETE FROM counters WHERE hour_ms=? AND metric=?",
        row.hour_ms,
        row.metric,
      );
  }

  private databaseId(): string {
    const id = this.meta("database_id");
    if (!id) throw new Error("schedule_database_unknown");
    return id;
  }

  private timing(row: StoredSchedule) {
    return {
      cron: row.cron,
      everySeconds: row.every_seconds,
      anchorMs: row.anchor_ms,
    };
  }

  private record(
    row: StoredSchedule,
    scheduledMs: number,
    startedMs: number | null,
    outcome: string,
    sqlstate: string | null,
    manual: boolean,
  ): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO runs(schedule,scheduled_ms,started_ms,finished_ms,outcome,sqlstate,attempts,manual)
       VALUES(?,?,?,?,?,?,?,?)`,
      row.name,
      scheduledMs,
      startedMs,
      Date.now(),
      outcome,
      sqlstate,
      row.attempts,
      manual ? 1 : 0,
    );
    sql.exec(
      "DELETE FROM runs WHERE schedule=?1 AND id NOT IN(SELECT id FROM runs WHERE schedule=?1 ORDER BY id DESC LIMIT ?2)",
      row.name,
      TRIGGER_RUN_HISTORY,
    );
    this.count(
      outcome.startsWith("skipped")
        ? "schedule_runs_skipped"
        : (`schedule_runs_${outcome}` as ExecutionMetric),
    );
  }

  /**
   * Moves a schedule to its next occurrence after now. An occurrence that came and went while
   * the previous run was still going is recorded as missed, never made up.
   */
  private advance(row: StoredSchedule, now: number, t: Timing): void {
    const { fireTime, intervalAfter, lateLimitMs, nextOccurrence } = t;
    const timing = this.timing(row);
    const databaseId = this.databaseId();
    if (row.occurrence_ms !== null) {
      const following = nextOccurrence(timing, row.occurrence_ms);
      if (
        following !== null &&
        fireTime(timing, databaseId, row.name, following) < now
      )
        this.record(row, following, null, "skipped_missed", null, false);
    }
    const occurrence = nextOccurrence(timing, now);
    const fire =
      occurrence === null
        ? null
        : fireTime(timing, databaseId, row.name, occurrence);
    this.ctx.storage.sql.exec(
      `UPDATE schedules SET occurrence_ms=?,fire_ms=?,deadline_ms=?,attempts=0,inflight_ms=NULL,inflight_manual=0 WHERE name=?`,
      occurrence,
      fire,
      occurrence === null
        ? null
        : fire! + lateLimitMs(intervalAfter(timing, occurrence)),
      row.name,
    );
  }

  /** Starts what is due. A run is not awaited: its claim keeps it from starting twice. */
  private async startSchedules(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (
      sql.exec<{ n: number }>("SELECT count(*) AS n FROM schedules").one().n ===
      0
    )
      return;
    const t = await this.timing_();
    const { intervalAfter, lateLimitMs } = t;
    // A claim that never reported was in flight when this object was lost: send nothing again.
    for (const stale of sql
      .exec<StoredSchedule>(
        "SELECT * FROM schedules WHERE inflight_ms IS NOT NULL AND inflight_ms<?",
        now - TRIGGER_INFLIGHT_STALE_MS,
      )
      .toArray()) {
      this.record(
        stale,
        stale.occurrence_ms ?? now,
        stale.inflight_ms,
        "outcome_unknown",
        null,
        stale.inflight_manual === 1,
      );
      if (stale.inflight_manual === 1)
        sql.exec(
          "UPDATE schedules SET inflight_ms=NULL,inflight_manual=0 WHERE name=?",
          stale.name,
        );
      else this.advance(stale, now, t);
    }
    const due = sql
      .exec<StoredSchedule>(
        `SELECT * FROM schedules WHERE inflight_ms IS NULL AND enabled=1
           AND (manual_pending=1 OR (fire_ms IS NOT NULL AND fire_ms<=?))
         ORDER BY manual_pending DESC, fire_ms LIMIT ?`,
        now,
        SCHEDULE_START_BATCH,
      )
      .toArray();
    for (const row of due) {
      const manual = row.manual_pending === 1;
      if (!manual && row.fire_ms !== null) {
        const interval = intervalAfter(
          this.timing(row),
          row.occurrence_ms ?? row.fire_ms,
        );
        if (now - row.fire_ms > lateLimitMs(interval)) {
          this.record(
            row,
            row.occurrence_ms ?? row.fire_ms,
            null,
            "skipped_missed",
            null,
            false,
          );
          this.advance(row, now, t);
          continue;
        }
      }
      sql.exec(
        "UPDATE schedules SET inflight_ms=?,inflight_manual=?,attempts=attempts+1,manual_pending=0 WHERE name=?",
        now,
        manual ? 1 : 0,
        row.name,
      );
      this.ctx.waitUntil(
        this.fire({ ...row, attempts: row.attempts + 1 }, manual),
      );
    }
  }

  private async fire(row: StoredSchedule, manual: boolean): Promise<void> {
    const sql = this.ctx.storage.sql;
    const t = await this.timing_();
    const started = Date.now();
    const scheduled = manual ? started : (row.occurrence_ms ?? started);
    try {
      const { runScheduleJob } = await import("./domain/schedule-job.ts");
      const run = await runScheduleJob(this.env, {
        databaseId: this.databaseId(),
        role: row.role,
        statements: JSON.parse(row.statements) as string[],
        timeoutMs: row.timeout_ms,
      });
      const finish = (outcome: string, sqlstate: string | null) => {
        this.record(row, scheduled, started, outcome, sqlstate, manual);
        if (manual)
          sql.exec(
            "UPDATE schedules SET inflight_ms=NULL,inflight_manual=0 WHERE name=?",
            row.name,
          );
        else this.advance(row, Date.now(), t);
      };
      if (run.kind === "skipped") {
        finish(
          run.reason === "gone" ? "skipped_deleted" : "skipped_suspended",
          null,
        );
        // A deleted database has no more runs.
        if (run.reason === "gone")
          sql.exec("UPDATE schedules SET enabled=0,fire_ms=NULL WHERE 1=1");
      } else if (run.result.outcome === "capacity_refused") {
        const { capacityBackoffMs } = t;
        const retryAt =
          Date.now() +
          (run.result.retryAfterSeconds !== null
            ? Math.max(
                1_000,
                Math.min(run.result.retryAfterSeconds * 1000, 300_000),
              )
            : capacityBackoffMs(row.attempts));
        if (!manual && row.deadline_ms !== null && retryAt <= row.deadline_ms) {
          // Nothing ran: try the same occurrence again, within its allowance.
          sql.exec(
            "UPDATE schedules SET fire_ms=?,inflight_ms=NULL,inflight_manual=0 WHERE name=?",
            retryAt,
            row.name,
          );
        } else finish("skipped_capacity", run.result.sqlstate);
      } else finish(run.result.outcome, run.result.sqlstate);
    } catch (error) {
      // Before the request was sent (D1 or the keys): release the claim and try again soon.
      console.error(
        JSON.stringify({
          event: "schedule_attempt_unavailable",
          error_class: error instanceof Error ? error.name : "unknown",
        }),
      );
      sql.exec(
        "UPDATE schedules SET fire_ms=?,inflight_ms=NULL,inflight_manual=0,manual_pending=? WHERE name=?",
        Date.now() + 60_000,
        manual ? 1 : 0,
        row.name,
      );
    } finally {
      await this.arm(Date.now());
    }
  }

  /** The next alarm is the earliest thing due; with nothing pending, a daily visit prunes. */
  private async arm(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const times: number[] = [];
    const delivery = sql
      .exec<{ at: number | null }>(
        "SELECT MIN(next_attempt_ms) AS at FROM deliveries WHERE state='pending'",
      )
      .one().at;
    if (delivery !== null) times.push(delivery);
    const schedule = sql
      .exec<{ at: number | null }>(
        `SELECT MIN(CASE WHEN manual_pending=1 THEN ?1 ELSE fire_ms END) AS at FROM schedules
         WHERE enabled=1 AND inflight_ms IS NULL AND (manual_pending=1 OR fire_ms IS NOT NULL)`,
        now,
      )
      .one().at;
    if (schedule !== null) times.push(schedule);
    const counters = sql
      .exec<{ at: number | null }>("SELECT MIN(hour_ms) AS at FROM counters")
      .one().at;
    if (counters !== null)
      times.push(
        Math.max(
          counters + HOUR_MS + COUNTER_FLUSH_DELAY_MS,
          this.flushRetryAt,
        ),
      );
    const inflight = sql
      .exec<{ at: number | null }>(
        "SELECT MIN(inflight_ms) AS at FROM schedules WHERE inflight_ms IS NOT NULL",
      )
      .one().at;
    if (inflight !== null)
      times.push(inflight + TRIGGER_INFLIGHT_STALE_MS + 1_000);
    if (times.length > 0) {
      await this.ctx.storage.setAlarm(
        Math.max(Math.min(...times), now + MIN_ALARM_GAP_MS),
      );
      return;
    }
    const any = sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM deliveries")
      .one().n;
    if (any > 0) await this.ctx.storage.setAlarm(now + 86_400_000);
    else await this.ctx.storage.deleteAlarm();
  }
}
