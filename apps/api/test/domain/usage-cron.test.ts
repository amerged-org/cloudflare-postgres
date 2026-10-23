// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  newDatabaseId,
  archiveDestinationPath,
  newOperationId,
} from "@pgcf/contracts";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { USAGE_HOUR_MS } from "@pgcf/contracts/usage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCron } from "../../src/cron.ts";
import worker from "../../src/index.ts";
import {
  runUsageCron,
  USAGE_CRON_PAGE_LIMIT,
  USAGE_CRON_STATEMENT_LIMIT,
  USAGE_PRUNE_BATCH,
  USAGE_SAMPLE_RETENTION_MS,
} from "../../src/domain/usage-cron.ts";
import {
  recordUsageSample,
  usageLifecycleStatement,
} from "../../src/domain/usage.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const start = Date.parse("2026-01-01T00:00:00.000Z"),
  iso = (value: number) => new Date(value).toISOString();
const resources = { memory_mib: 512, cpu_millicores: 500 };
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_cron_cursor"),
    env.DB.prepare("DELETE FROM region_hint_cursor"),
    env.DB.prepare("DELETE FROM reconciliation_cursors"),
  ]);
  await cleanupFixtures();
});
async function cohort(count = 1) {
  const f = await fixture(),
    ids = Array.from({ length: count }, () => newDatabaseId()).sort();
  const inserts = ids.flatMap((id) => [
    env.DB.prepare(
      `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,observed_generation,archive_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running','ready',1,1,?,?,?)`,
    ).bind(
      id,
      f.project,
      f.region,
      f.node,
      id,
      f.size,
      `s3://${["fixture", "archive"].join("-")}/${id}`,
      iso(start),
      iso(start),
    ),
    env.DB.prepare(
      "INSERT INTO database_admission_epochs(database_id) VALUES(?)",
    ).bind(id),
  ]);
  for (let offset = 0; offset < inserts.length; offset += 100)
    await env.DB.batch(inserts.slice(offset, offset + 100));
  const event = (
    id: string,
    kind: "created" | "ready" | "deleted",
    offset = 0,
  ) =>
    usageLifecycleStatement(env.DB, {
      database_id: id,
      kind,
      node_id: f.node,
      size_class_id: f.size,
      generation: 1,
      occurred_at: iso(start + offset),
      resources,
    });
  return { ...f, ids, event };
}
async function rows(id: string) {
  return (
    await env.DB.prepare(
      "SELECT hour,metrics,gaps,final FROM usage_hourly WHERE database_id=? ORDER BY hour",
    )
      .bind(id)
      .all<{ hour: string; metrics: string; gaps: string; final: number }>()
  ).results;
}
async function progress(id: string) {
  return (
    await env.DB.prepare(
      "SELECT next_hour FROM usage_rollup_progress WHERE database_id=?",
    )
      .bind(id)
      .first<{ next_hour: string }>()
  )?.next_hour;
}
/** The structured events a spied console method received; other lines are not events. */
function logged(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.flatMap(([line]) => {
    try {
      return [JSON.parse(String(line)) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}
function loseWrite(
  db: D1Database,
  id: string,
  afterCommit: boolean,
): D1Database {
  let once = true;
  const wrap = (
    statement: D1PreparedStatement,
    bindings: unknown[] = [],
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values), values);
        if (property === "run")
          return async () => {
            if (once && bindings[0] === id) {
              once = false;
              if (afterCommit) await target.run();
              throw new Error(
                afterCommit ? "test_lost_response" : "test_partial_failure",
              );
            }
            return target.run();
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          sql.includes("INSERT INTO usage_hourly")
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function countStatements(input: D1Database) {
  let count = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (["first", "all", "run", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            count++;
            return Reflect.apply(Reflect.get(target, property), target, args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const db = new Proxy(input, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          count += batch.length;
          return target.batch(
            batch.map((statement) => originals.get(statement) ?? statement),
          );
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, count: () => count };
}

describe("bounded usage cron", () => {
  it("bounds a real 1000-database cohort and persists a fair continuation", async () => {
    const f = await cohort(1000);
    const first = await runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS);
    expect(first.databases).toBeGreaterThan(0);
    expect(first.databases).toBeLessThanOrEqual(USAGE_CRON_PAGE_LIMIT);
    expect(first.statements).toBeLessThanOrEqual(USAGE_CRON_STATEMENT_LIMIT);
    expect(first.next).toBe(f.ids[first.databases - 1]);
    const count = await env.DB.prepare(
      "SELECT count(DISTINCT database_id) n FROM usage_rollup_progress",
    ).first<{ n: number }>();
    expect(count!.n).toBeLessThanOrEqual(USAGE_CRON_PAGE_LIMIT);
    const second = await runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS);
    expect(second.statements).toBeLessThanOrEqual(USAGE_CRON_STATEMENT_LIMIT);
    expect(second.next! > first.next!).toBe(true);
    expect(await progress(f.ids[999]!)).toBeUndefined();
    console.log(
      JSON.stringify({
        event: "usage_cron_bound",
        cohort: f.ids.length,
        first: {
          databases: first.databases,
          hours: first.hours,
          statements: first.statements,
          exhausted: first.exhausted,
        },
        second: {
          databases: second.databases,
          hours: second.hours,
          statements: second.statements,
          exhausted: second.exhausted,
        },
      }),
    );
  });
  it(
    "keeps the complete cron below its statement bound and pages pending regional hints fairly",
    { timeout: 30_000 },
    async () => {
      const f = await cohort(1000);
      await env.DB.prepare(
        "UPDATE databases SET generation=2 WHERE project_id=?",
      )
        .bind(f.project)
        .run();
      const counted = countStatements(env.DB),
        now = start + 4 * USAGE_HOUR_MS;
      const first = await runCron({ ...env, DB: counted.db }, now);
      expect(counted.count()).toBeLessThanOrEqual(850);
      expect(first.usage.statements).toBeLessThanOrEqual(
        USAGE_CRON_STATEMENT_LIMIT,
      );
      expect(
        await env.DB.prepare(
          "SELECT database_id FROM region_hint_cursor WHERE singleton=1",
        ).first(),
      ).toEqual({ database_id: f.ids[199] });
      const secondCount = countStatements(env.DB);
      await runCron({ ...env, DB: secondCount.db }, now);
      expect(secondCount.count()).toBeLessThanOrEqual(850);
      expect(
        await env.DB.prepare(
          "SELECT database_id FROM region_hint_cursor WHERE singleton=1",
        ).first(),
      ).toEqual({ database_id: f.ids[399] });
      console.log(
        JSON.stringify({
          event: "whole_cron_bound",
          cohort: f.ids.length,
          first_statements: counted.count(),
          second_statements: secondCount.count(),
        }),
      );
    },
  );
  it("continues past a partial failure without skipping its old hour", async () => {
    const f = await cohort(3),
      failed = f.ids[1]!;
    const first = await runUsageCron(
      loseWrite(env.DB, failed, false),
      start + 4 * USAGE_HOUR_MS,
    );
    expect(first.failed).toBe(1);
    expect(await progress(failed)).toBe(iso(start));
    expect((await rows(f.ids[2]!)).length).toBeGreaterThan(0);
    const resumed = await runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS);
    expect(resumed.failed).toBe(0);
    expect(await progress(failed)).toBe(iso(start + 2 * USAGE_HOUR_MS));
    expect(
      (await rows(failed)).some(
        (row) => row.hour === iso(start) && row.final === 1,
      ),
    ).toBe(true);
  });
  it("resumes after a committed rollup loses its response without duplicate usage or traffic", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    await recordUsageSample(
      env.DB,
      { region_id: f.region, source: "gateway" },
      {
        source: "gateway",
        database_id: id,
        producer_id: "gateway_epoch",
        sequence: 0,
        observed_at: iso(start + USAGE_HOUR_MS),
        interval_start: iso(start),
        interval_end: iso(start + USAGE_HOUR_MS),
        expected_producers: ["gateway_epoch"],
        ingress_bytes: 7,
        egress_bytes: 11,
        connections: 1,
        connection_seconds: 3600,
      },
      start + USAGE_HOUR_MS,
    );
    expect(
      (
        await runUsageCron(
          loseWrite(env.DB, id, true),
          start + 4 * USAGE_HOUR_MS,
        )
      ).failed,
    ).toBe(1);
    expect(await progress(id)).toBe(iso(start));
    await runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS);
    const saved = await rows(id),
      first = saved.find((row) => row.hour === iso(start))!;
    expect(JSON.parse(first.metrics)).toMatchObject({
      awake_seconds: 3600,
      memory_mib_seconds: 512 * 3600,
      ingress_bytes: 7,
      connections: 1,
      connection_seconds: 3600,
    });
    expect(saved.filter((row) => row.hour === iso(start))).toHaveLength(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM usage_samples WHERE database_id=?",
        )
          .bind(id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("handles overlapping invocations with immutable rollups and cursor CAS", async () => {
    const f = await cohort(2);
    for (const id of f.ids)
      await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    const results = await Promise.all([
      runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS),
      runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS),
    ]);
    expect(
      results.every(
        (result) =>
          result.failed === 0 &&
          result.statements <= USAGE_CRON_STATEMENT_LIMIT,
      ),
    ).toBe(true);
    for (const id of f.ids) {
      const saved = await rows(id);
      expect(new Set(saved.map((row) => row.hour)).size).toBe(saved.length);
      expect(
        JSON.parse(saved.find((row) => row.hour === iso(start))!.metrics)
          .awake_seconds,
      ).toBe(3600);
      expect(Date.parse((await progress(id))!)).toBeGreaterThanOrEqual(
        start + USAGE_HOUR_MS,
      );
      expect(Date.parse((await progress(id))!)).toBeLessThanOrEqual(
        start + 2 * USAGE_HOUR_MS,
      );
    }
  });
  it("refreshes current-hour durations as measured time advances", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    await runUsageCron(env.DB, start + 30 * 60_000);
    expect(JSON.parse((await rows(id))[0]!.metrics).awake_seconds).toBe(1800);
    await runUsageCron(env.DB, start + 40 * 60_000);
    const saved = await rows(id);
    expect(saved).toHaveLength(1);
    expect(JSON.parse(saved[0]!.metrics).awake_seconds).toBe(2400);
    expect(saved[0]!.final).toBe(0);
  });
  it("finalizes at the two-hour horizon while preserving real missing-sample gaps", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    await runUsageCron(env.DB, start + 3 * USAGE_HOUR_MS - 1);
    expect((await rows(id)).find((row) => row.hour === iso(start))!.final).toBe(
      0,
    );
    await runUsageCron(env.DB, start + 3 * USAGE_HOUR_MS);
    const finalized = (await rows(id)).find((row) => row.hour === iso(start))!;
    expect(finalized.final).toBe(1);
    expect(JSON.parse(finalized.gaps)).toContain("connections");
    expect(JSON.parse(finalized.metrics).connections).toBeNull();
    expect(await progress(id)).toBe(iso(start + USAGE_HOUR_MS));
  });
  it("catches missed old hours without jumping the per-database cursor", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    const now = start + 24 * USAGE_HOUR_MS;
    await runUsageCron(env.DB, now);
    expect(await progress(id)).toBe(iso(start + 2 * USAGE_HOUR_MS));
    for (let visit = 1; visit < 12; visit++) await runUsageCron(env.DB, now);
    expect(await progress(id)).toBe(iso(start + 22 * USAGE_HOUR_MS));
    const saved = await rows(id);
    expect(saved).toHaveLength(25);
    expect(saved.filter((row) => row.final === 1)).toHaveLength(22);
    expect(saved.map((row) => row.hour)).toEqual(
      Array.from({ length: 25 }, (_, index) =>
        iso(start + index * USAGE_HOUR_MS),
      ),
    );
  });
  it("retains deleted database history through the actual deletion hour", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      deletedAt = start + 2 * USAGE_HOUR_MS + 600_000;
    await env.DB.batch([
      f.event(id, "created"),
      f.event(id, "ready"),
      f.event(id, "deleted", deletedAt - start),
      env.DB.prepare(
        "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
      ).bind(iso(deletedAt), id),
    ]);
    await runUsageCron(env.DB, start + 8 * USAGE_HOUR_MS);
    await runUsageCron(env.DB, start + 8 * USAGE_HOUR_MS);
    const saved = await rows(id);
    expect(saved).toHaveLength(3);
    expect(JSON.parse(saved[2]!.metrics)).toMatchObject({
      provisioned_seconds: 600,
      awake_seconds: 600,
    });
    expect(await progress(id)).toBe(iso(start + 3 * USAGE_HOUR_MS));
    await runUsageCron(env.DB, start + 9 * USAGE_HOUR_MS);
    expect(await rows(id)).toEqual(saved);
  });
  it("stops a database whose deletion was recorded only after its hours had been rolled up past it", async () => {
    // A never-placed database is deleted without a lifecycle event, so before its deletion time
    // counted as the end of metering the cron treated it as live and advanced its pointer.
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 40 * USAGE_HOUR_MS,
      deletedAt = start + 2 * USAGE_HOUR_MS + 600_000;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
      ).bind(iso(deletedAt), id),
      env.DB.prepare(
        "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?)",
      ).bind(id, iso(start + 38 * USAGE_HOUR_MS)),
      ...[1, 2, 30].map((hour) =>
        env.DB.prepare(
          `INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload)
        VALUES(?,'backup','r2_a',?,?,?,?,?)`,
        ).bind(
          id,
          hour,
          iso(start + hour * USAGE_HOUR_MS),
          iso(start + hour * USAGE_HOUR_MS),
          iso(start + hour * USAGE_HOUR_MS),
          JSON.stringify({
            source: "backup",
            database_id: id,
            producer_id: "r2_a",
            sequence: hour,
            observed_at: iso(start + hour * USAGE_HOUR_MS),
            backup_bytes: 1,
          }),
        ),
      ),
    ]);
    const result = await runUsageCron(env.DB, now);
    expect(result.failed).toBe(0);
    expect(result.databases).toBe(1);
    // The two samples older than the retention day go; the one inside it follows later.
    expect(result.pruned).toBe(2);
    expect(await rows(id)).toHaveLength(0);
    expect(await progress(id)).toBe(iso(start + 38 * USAGE_HOUR_MS));
  });
  it("fails closed on malformed persisted hour state", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.prepare(
      "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?)",
    )
      .bind(id, "2026-13-01T00:00:00.000Z")
      .run();
    expect((await runUsageCron(env.DB, start + 4 * USAGE_HOUR_MS)).failed).toBe(
      1,
    );
    expect(await rows(id)).toHaveLength(0);
    await expect(
      env.DB.prepare(
        "INSERT INTO usage_cron_cursor(singleton,cursor) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET cursor=excluded.cursor",
      )
        .bind("invalid")
        .run(),
    ).rejects.toThrow();
  });
  it("wires metering into the existing cron without changing lifecycle snapshots", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    const before = await env.DB.prepare(
      "SELECT resource_snapshot FROM lifecycle_events WHERE database_id=? ORDER BY id",
    )
      .bind(id)
      .all();
    const result = await runCron(env, start + 30 * 60_000);
    expect(result.usage.databases).toBe(1);
    expect(result.failed).toBe(0);
    const metrics = JSON.parse((await rows(id))[0]!.metrics);
    expect(metrics.memory_mib_seconds).toBe(512 * 1800);
    expect(
      Object.keys(metrics).filter((name) => name.startsWith("reserved_")),
    ).toEqual([]);
    expect(
      (
        await env.DB.prepare(
          "SELECT resource_snapshot FROM lifecycle_events WHERE database_id=? ORDER BY id",
        )
          .bind(id)
          .all()
      ).results,
    ).toEqual(before.results);
  });
  it("wires the exact R2 backup bytes through the bounded usage cron and hourly row", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = Date.now(),
      current = Math.floor(now / USAGE_HOUR_MS) * USAGE_HOUR_MS;
    const archivePath = archiveDestinationPath(
      env.ARCHIVE_BUCKET_NAME,
      f.region,
      id,
      1,
      newOperationId(),
    );
    await env.DB.prepare(
      "UPDATE databases SET archive_path=?,created_at=? WHERE id=?",
    )
      .bind(archivePath, iso(current), id)
      .run();
    const prefix = `${f.region}/${id}/${archivePath.slice(archivePath.lastIndexOf("/") + 1)}/database/`,
      key = `${prefix}fixture`;
    await env.ARCHIVE.put(key, new Uint8Array(37));
    try {
      const result = await runUsageCron(env.DB, Date.now(), env);
      expect(result.backupMeasured).toBe(1);
      expect(result.backupUnavailable).toBe(0);
      expect(result.statements).toBeLessThanOrEqual(USAGE_CRON_STATEMENT_LIMIT);
      const saved = await rows(id);
      expect(JSON.parse(saved[0]!.metrics).backup_bytes_max).toBe(37);
    } finally {
      await env.ARCHIVE.delete(key);
    }
  });
});

describe("backup measurement of a deleted database", () => {
  async function deleted(
    deletedAt: (current: number) => number,
    { events = true, visits = 1 } = {},
  ) {
    const f = await cohort(),
      id = f.ids[0]!,
      now = Date.now(),
      current = Math.floor(now / USAGE_HOUR_MS) * USAGE_HOUR_MS,
      removed = deletedAt(current),
      archivePath = archiveDestinationPath(
        env.ARCHIVE_BUCKET_NAME,
        f.region,
        id,
        1,
        newOperationId(),
      );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE databases SET archive_path=?,created_at=? WHERE id=?",
      ).bind(archivePath, iso(current - 5 * USAGE_HOUR_MS), id),
      ...(events
        ? [
            f.event(id, "created", current - 5 * USAGE_HOUR_MS - start),
            f.event(id, "deleted", removed - start),
          ]
        : []),
      env.DB.prepare(
        "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
      ).bind(iso(removed), id),
    ]);
    const prefix = `${f.region}/${id}/${archivePath.slice(archivePath.lastIndexOf("/") + 1)}/database/`,
      key = `${prefix}fixture`;
    await env.ARCHIVE.put(key, new Uint8Array(37));
    let result = await runUsageCron(env.DB, now, env);
    for (let visit = 1; visit < visits; visit++) {
      const again = await runUsageCron(env.DB, now, env);
      result = {
        ...again,
        backupMeasured: result.backupMeasured + again.backupMeasured,
        backupUnavailable: result.backupUnavailable + again.backupUnavailable,
      };
    }
    await env.ARCHIVE.delete(key);
    const backups = (await env.DB.prepare(
      "SELECT count(*) n FROM usage_samples WHERE database_id=? AND source='backup'",
    )
      .bind(id)
      .first<{ n: number }>())!.n;
    return { id, result, backups, current };
  }
  it("measures nothing once the deletion hour has passed", async () => {
    const { result, backups } = await deleted(
      (current) => current - 3 * USAGE_HOUR_MS + 600_000,
    );
    expect(result.databases).toBe(1);
    expect(result.backupMeasured + result.backupUnavailable).toBe(0);
    expect(backups).toBe(0);
  });
  it("still measures during the deletion hour, which its last rollup includes", async () => {
    const { result, backups } = await deleted((current) => current);
    expect(result.backupMeasured).toBe(1);
    expect(backups).toBe(1);
  });
  it("ends a never-placed database with its deletion hour although it has no lifecycle events", async () => {
    // The delete of an unplaced database settles in the API without any regional observation.
    const { id, result, backups, current } = await deleted(
      (current) => current - 3 * USAGE_HOUR_MS + 600_000,
      { events: false, visits: 5 },
    );
    expect(result.backupMeasured + result.backupUnavailable).toBe(0);
    expect(backups).toBe(0);
    const hours = (await rows(id)).map((row) => row.hour);
    expect(hours.at(-1)).toBe(iso(current - 3 * USAGE_HOUR_MS));
    expect(await progress(id)).toBe(iso(current - 2 * USAGE_HOUR_MS));
  });
});

describe("raw usage sample retention", () => {
  const principal = (
    f: { region: string },
    source: "agent" | "gateway" | "backup",
  ) => ({ region_id: f.region, source });
  /** One sample of every source inside the given hour offset from `start`. */
  async function record(
    f: Awaited<ReturnType<typeof cohort>>,
    id: string,
    hour: number,
  ) {
    const at = start + hour * USAGE_HOUR_MS,
      now = at + USAGE_HOUR_MS;
    await recordUsageSample(
      env.DB,
      principal(f, "gateway"),
      {
        source: "gateway",
        database_id: id,
        producer_id: "gateway_a",
        sequence: hour,
        observed_at: iso(now),
        interval_start: iso(at),
        interval_end: iso(now),
        expected_producers: ["gateway_a"],
        ingress_bytes: 7 + hour,
        egress_bytes: 11,
        connections: 1,
        connection_seconds: 60,
      },
      now,
    );
    await recordUsageSample(
      env.DB,
      principal(f, "agent"),
      {
        source: "agent",
        database_id: id,
        producer_id: "agent_a",
        sequence: hour,
        observed_at: iso(at + 600_000),
        storage_used_bytes: 1000 + hour,
        storage_allocated_bytes: 5 * 1024 ** 3,
      },
      now,
    );
    await recordUsageSample(
      env.DB,
      principal(f, "backup"),
      {
        source: "backup",
        database_id: id,
        producer_id: "r2_a",
        sequence: hour,
        observed_at: iso(at + 1_200_000),
        backup_bytes: 500 + hour,
      },
      now,
    );
  }
  /** Stored samples per hour offset from `start`. */
  async function perHour(id: string) {
    const stored = await env.DB.prepare(
      "SELECT interval_start FROM usage_samples WHERE database_id=?",
    )
      .bind(id)
      .all<{ interval_start: string }>();
    const counts: Record<number, number> = {};
    for (const { interval_start } of stored.results) {
      const hour = Math.floor(
        (Date.parse(interval_start) - start) / USAGE_HOUR_MS,
      );
      counts[hour] = (counts[hour] ?? 0) + 1;
    }
    return counts;
  }
  const history = async (
    f: { integrator: string },
    id: string,
    hours: number,
  ) =>
    (
      await request(
        `/v1/usage?${new URLSearchParams({
          database_id: id,
          from: iso(start),
          to: iso(start + hours * USAGE_HOUR_MS),
          granularity: "hour",
        })}`,
        f.integrator,
      )
    ).json();

  it("prunes samples of finalized hours past the window and leaves rollups and public history unchanged", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 30 * USAGE_HOUR_MS;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    for (const hour of [0, 1, 7, 28, 29]) await record(f, id, hour);
    expect(USAGE_SAMPLE_RETENTION_MS).toBe(24 * USAGE_HOUR_MS);
    // The first visit finalizes hours 0 and 1; none of their samples is old enough yet.
    expect((await runUsageCron(env.DB, now)).pruned).toBe(0);
    expect(await perHour(id)).toEqual({ 0: 3, 1: 3, 7: 3, 28: 3, 29: 3 });
    const finalized = (await rows(id)).filter((row) => row.final === 1);
    expect(finalized.map((row) => row.hour)).toEqual([
      iso(start),
      iso(start + USAGE_HOUR_MS),
    ]);
    expect(JSON.parse(finalized[0]!.metrics)).toMatchObject({
      ingress_bytes: 7,
      storage_used_bytes_max: 1000,
      backup_bytes_max: 500,
    });
    const before = await history(f, id, 2);
    let pruned = 0;
    for (let visit = 0; visit < 16; visit++)
      pruned += (await runUsageCron(env.DB, now)).pruned;
    // Hours 0 and 1 are final and older than one day; hour 7 is final but inside the window;
    // hours 28 and 29 are not final.
    expect(await perHour(id)).toEqual({ 7: 3, 28: 3, 29: 3 });
    expect(pruned).toBe(6);
    expect(
      (await rows(id)).filter(
        (row) => row.hour < iso(start + 2 * USAGE_HOUR_MS),
      ),
    ).toEqual(finalized);
    expect(await history(f, id, 2)).toEqual(before);
    expect(
      JSON.parse(
        (await rows(id)).find(
          (row) => row.hour === iso(start + 7 * USAGE_HOUR_MS),
        )!.metrics,
      ),
    ).toMatchObject({ ingress_bytes: 14, backup_bytes_max: 507 });
  });
  it("never removes samples of a hour its rollup has not finalized, however old", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 48 * USAGE_HOUR_MS;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    await record(f, id, 0);
    const failed = await runUsageCron(loseWrite(env.DB, id, false), now);
    expect(failed.failed).toBe(1);
    expect(failed.pruned).toBe(0);
    expect(await progress(id)).toBe(iso(start));
    expect(await perHour(id)).toEqual({ 0: 3 });
    await runUsageCron(env.DB, now);
    expect(JSON.parse((await rows(id))[0]!.metrics)).toMatchObject({
      ingress_bytes: 7,
      backup_bytes_max: 500,
    });
    expect((await rows(id))[0]!.final).toBe(1);
    await runUsageCron(env.DB, now);
    expect(await perHour(id)).toEqual({});
  });
  it("prunes everything of a deleted database once its window is closed, rollups included untouched", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 40 * USAGE_HOUR_MS,
      deletedAt = start + 2 * USAGE_HOUR_MS + 600_000;
    await env.DB.batch([
      f.event(id, "created"),
      f.event(id, "ready"),
      f.event(id, "deleted", deletedAt - start),
      env.DB.prepare(
        "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
      ).bind(iso(deletedAt), id),
    ]);
    for (const hour of [0, 1, 2]) await record(f, id, hour);
    // A backup measured after the deletion hour belongs to no rollup at all.
    await recordUsageSample(
      env.DB,
      principal(f, "backup"),
      {
        source: "backup",
        database_id: id,
        producer_id: "r2_late",
        sequence: 99,
        observed_at: iso(start + 4 * USAGE_HOUR_MS + 60_000),
        backup_bytes: 1,
      },
      start + 5 * USAGE_HOUR_MS,
    );
    for (let visit = 0; visit < 6; visit++) await runUsageCron(env.DB, now);
    const saved = await rows(id);
    expect(saved).toHaveLength(3);
    expect(saved.every((row) => row.final === 1)).toBe(true);
    expect(await progress(id)).toBe(iso(start + 3 * USAGE_HOUR_MS));
    expect(await perHour(id)).toEqual({});
    await runUsageCron(env.DB, now);
    expect(await rows(id)).toEqual(saved);
  });
  it("removes a bounded batch per visit and drains a larger backlog across visits", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 40 * USAGE_HOUR_MS,
      extra = 50;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    const insert = env.DB.prepare(
      `INSERT INTO usage_samples(database_id,source,producer_id,sequence,interval_start,interval_end,observed_at,payload)
      VALUES(?,'backup','r2_backlog',?,?,?,?,?)`,
    );
    const statements = Array.from(
      { length: USAGE_PRUNE_BATCH + extra },
      (_, index) => {
        const at = iso(start + 60_000 + index * 1000);
        return insert.bind(
          id,
          index,
          at,
          at,
          at,
          JSON.stringify({
            source: "backup",
            database_id: id,
            producer_id: "r2_backlog",
            sequence: index,
            observed_at: at,
            backup_bytes: index,
          }),
        );
      },
    );
    for (let offset = 0; offset < statements.length; offset += 100)
      await env.DB.batch(statements.slice(offset, offset + 100));
    const count = async () =>
      (await env.DB.prepare(
        "SELECT count(*) n FROM usage_samples WHERE database_id=?",
      )
        .bind(id)
        .first<{ n: number }>())!.n;
    // The first visit finalizes the hour; only then does the pointer cover the backlog.
    await runUsageCron(env.DB, now);
    expect(await count()).toBe(USAGE_PRUNE_BATCH + extra);
    expect((await runUsageCron(env.DB, now)).pruned).toBe(USAGE_PRUNE_BATCH);
    expect(await count()).toBe(extra);
    expect((await runUsageCron(env.DB, now)).pruned).toBe(extra);
    expect(await count()).toBe(0);
  });
  it("keeps the usage rollups running when the housekeeping delete fails", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = start + 40 * USAGE_HOUR_MS;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    await record(f, id, 0);
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.startsWith("DELETE FROM usage_samples"))
              throw new Error("test_prune_failure");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runUsageCron(failing, now);
    const result = await runUsageCron(failing, now);
    expect(result.failed).toBe(0);
    expect(result.pruned).toBe(0);
    expect((await rows(id)).filter((row) => row.final === 1)).toHaveLength(4);
    expect(await perHour(id)).toEqual({ 0: 3 });
    // The log names the failure itself, never a sample payload.
    const events = logged(warn).filter(
      (event) => event.event === "usage_prune_failed",
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toEqual({
      event: "usage_prune_failed",
      database_id: id,
      error: "Error: test_prune_failure",
    });
  });
  it("reports the usage cron result of every scheduled invocation so draining is observable", async () => {
    const f = await cohort(),
      id = f.ids[0]!;
    await env.DB.batch([f.event(id, "created"), f.event(id, "ready")]);
    for (const hour of [0, 1]) await record(f, id, hour);
    // The pointer already covers the first ten hours, so one invocation removes both finalized hours.
    await env.DB.prepare(
      "INSERT INTO usage_rollup_progress(database_id,next_hour) VALUES(?,?)",
    )
      .bind(id, iso(start + 10 * USAGE_HOUR_MS))
      .run();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const context = createExecutionContext();
    await worker.scheduled(
      createScheduledController({
        scheduledTime: Date.now(),
        cron: "* * * * *",
      }),
      env,
      context,
    );
    await waitOnExecutionContext(context);
    const summaries = logged(log).filter(
      (event) => event.event === "cron_completed",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.usage).toMatchObject({
      databases: 1,
      failed: 0,
      pruned: 6,
    });
    // The line carries the time of each step.
    expect(summaries[0]).toMatchObject({
      step_ms: { usage: expect.any(Number) },
    });
    // Only the invocation's own backup measurement of the current hour remains.
    const remaining = await perHour(id);
    expect(remaining[0]).toBeUndefined();
    expect(remaining[1]).toBeUndefined();
  });
});
