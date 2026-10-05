// SPDX-License-Identifier: Apache-2.0
import { DatabaseId, Timestamp } from "@pgcf/contracts";
import { USAGE_HOUR_MS } from "@pgcf/contracts/usage";
import { rollupUsageHour } from "./usage-rollup.ts";
import { measureBackupUsage } from "./backup-usage.ts";
import type { ArchiveEnvironment } from "./archive-bindings.ts";

export const USAGE_CRON_PAGE_LIMIT = 24;
export const USAGE_CRON_STATEMENT_LIMIT = 600;
export const USAGE_CRON_CATCHUP_HOURS = 2;
class StatementBudgetExceeded extends Error {}
interface DatabasePageRow {
  id: string;
  created_at: string;
  terminal_at: string | null;
}
export interface UsageCronResult {
  databases: number;
  hours: number;
  finalized: number;
  failed: number;
  statements: number;
  exhausted: boolean;
  overlap: boolean;
  next: string | null;
  backupMeasured: number;
  backupUnavailable: number;
}

function boundedDatabase(db: D1Database) {
  let statements = 0;
  const prepared = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const reserve = (amount: number) => {
    if (statements + amount > USAGE_CRON_STATEMENT_LIMIT)
      throw new StatementBudgetExceeded("usage_cron_statement_budget");
    statements += amount;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (
          property === "all" ||
          property === "first" ||
          property === "run" ||
          property === "raw"
        )
          return (...args: unknown[]) => {
            reserve(1);
            return Reflect.apply(Reflect.get(target, property), target, args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    prepared.set(proxy, statement);
    return proxy;
  };
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          reserve(batch.length);
          return target.batch(
            batch.map((statement) => prepared.get(statement) ?? statement),
          );
        };
      if (property === "exec")
        return () => {
          throw new Error("usage_cron_exec_forbidden");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: proxy,
    used: () => statements,
    remaining: () => USAGE_CRON_STATEMENT_LIMIT - statements,
  };
}

function hour(value: string): number {
  Timestamp.parse(value);
  const parsed = Date.parse(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed % USAGE_HOUR_MS !== 0
  )
    throw new Error("invalid_usage_hour_cursor");
  return parsed;
}
function creationHour(value: string): number {
  Timestamp.parse(value);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error("invalid_usage_creation_timestamp");
  return Math.floor(parsed / USAGE_HOUR_MS) * USAGE_HOUR_MS;
}
const iso = (value: number) => new Date(value).toISOString();

export async function runUsageCron(
  input: D1Database,
  now = Date.now(),
  archive?: ArchiveEnvironment,
): Promise<UsageCronResult> {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("invalid_usage_cron_timestamp");
  const current = Math.floor(now / USAGE_HOUR_MS) * USAGE_HOUR_MS;
  const budget = boundedDatabase(input),
    db = budget.db;
  const result: UsageCronResult = {
    databases: 0,
    hours: 0,
    finalized: 0,
    failed: 0,
    statements: 0,
    exhausted: false,
    overlap: false,
    next: null,
    backupMeasured: 0,
    backupUnavailable: 0,
  };
  await db
    .prepare(
      "INSERT INTO usage_cron_cursor(singleton,cursor) VALUES(1,NULL) ON CONFLICT(singleton) DO NOTHING",
    )
    .run();
  const state = await db
    .prepare("SELECT cursor FROM usage_cron_cursor WHERE singleton=1")
    .first<{ cursor: string | null }>();
  if (!state) throw new Error("usage_cron_cursor_missing");
  if (state.cursor !== null) DatabaseId.parse(state.cursor);
  let cursor = state.cursor;
  const page = await db
    .prepare(
      `SELECT d.id,d.created_at,
    CASE WHEN d.observed_state='deleted' THEN (SELECT MAX(occurred_at) FROM lifecycle_events WHERE database_id=d.id AND kind='deleted') ELSE NULL END terminal_at
    FROM databases d WHERE d.id>? ORDER BY d.id LIMIT ?`,
    )
    .bind(cursor ?? "", USAGE_CRON_PAGE_LIMIT + 1)
    .all<DatabasePageRow>();
  const rows = page.results.slice(0, USAGE_CRON_PAGE_LIMIT);
  for (const row of rows) {
    if (budget.remaining() < 2) {
      result.exhausted = true;
      break;
    }
    try {
      DatabaseId.parse(row.id);
      const created = creationHour(row.created_at);
      const terminal =
        row.terminal_at === null ? null : creationHour(row.terminal_at);
      if (terminal !== null && terminal < created)
        throw new Error("invalid_usage_deletion_timestamp");
      let materializationNow = now;
      if (archive) {
        const measured = await measureBackupUsage(
          { ...archive, DB: db },
          row.id,
        );
        if (measured.status === "measured") result.backupMeasured++;
        else result.backupUnavailable++;
        if (measured.sample) {
          const sampled = Date.parse(measured.sample.observed_at);
          if (Math.floor(sampled / USAGE_HOUR_MS) * USAGE_HOUR_MS === current)
            materializationNow = Math.max(now, sampled);
        }
      }
      await db
        .prepare(
          "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?) ON CONFLICT(database_id) DO NOTHING",
        )
        .bind(row.id, iso(created))
        .run();
      const progress = await db
        .prepare(
          "SELECT next_hour FROM usage_rollup_progress WHERE database_id=?",
        )
        .bind(row.id)
        .first<{ next_hour: string }>();
      if (!progress) throw new Error("usage_database_cursor_missing");
      let next = hour(progress.next_hour);
      if (
        next < created ||
        next > current + USAGE_HOUR_MS ||
        (terminal !== null && next > terminal + USAGE_HOUR_MS)
      )
        throw new Error("invalid_usage_database_cursor");
      const visited = new Set<number>();
      for (let index = 0; index < USAGE_CRON_CATCHUP_HOURS; index++) {
        if (next > current || (terminal !== null && next > terminal)) break;
        const metered = await rollupUsageHour(
          db,
          row.id,
          next,
          next === current ? materializationNow : now,
        );
        visited.add(next);
        result.hours++;
        if (metered.final) result.finalized++;
        if (!metered.final) break;
        const updated = await db
          .prepare(
            "UPDATE usage_rollup_progress SET next_hour=? WHERE database_id=? AND next_hour=?",
          )
          .bind(iso(next + USAGE_HOUR_MS), row.id, iso(next))
          .run();
        if (updated.meta.changes === 0) break;
        next += USAGE_HOUR_MS;
      }
      for (const recent of [current - USAGE_HOUR_MS, current]) {
        if (
          recent < created ||
          (terminal !== null && recent > terminal) ||
          visited.has(recent)
        )
          continue;
        await rollupUsageHour(
          db,
          row.id,
          recent,
          recent === current ? materializationNow : now,
        );
        result.hours++;
      }
    } catch (error) {
      if (error instanceof StatementBudgetExceeded) {
        result.exhausted = true;
        break;
      }
      result.failed++;
    }
    if (budget.remaining() < 1) {
      result.exhausted = true;
      break;
    }
    const updated = await db
      .prepare(
        "UPDATE usage_cron_cursor SET cursor=? WHERE singleton=1 AND cursor IS ?",
      )
      .bind(row.id, cursor)
      .run();
    if (updated.meta.changes === 0) {
      result.overlap = true;
      break;
    }
    cursor = row.id;
    result.databases++;
  }
  if (
    !result.exhausted &&
    !result.overlap &&
    rows.length === result.databases &&
    page.results.length <= USAGE_CRON_PAGE_LIMIT
  ) {
    if (budget.remaining() < 1) result.exhausted = true;
    else {
      const updated = await db
        .prepare(
          "UPDATE usage_cron_cursor SET cursor=NULL WHERE singleton=1 AND cursor IS ?",
        )
        .bind(cursor)
        .run();
      if (updated.meta.changes === 1) cursor = null;
      else result.overlap = true;
    }
  }
  result.statements = budget.used();
  result.next = cursor;
  return result;
}
