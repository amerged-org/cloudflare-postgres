// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  newDatabaseId,
  archiveDestinationPath,
  newOperationId,
} from "@pgcf/contracts";
import { USAGE_HOUR_MS } from "@pgcf/contracts/usage";
import { afterEach, describe, expect, it } from "vitest";
import { runCron } from "../../src/cron.ts";
import {
  runUsageCron,
  USAGE_CRON_PAGE_LIMIT,
  USAGE_CRON_STATEMENT_LIMIT,
} from "../../src/domain/usage-cron.ts";
import {
  recordUsageSample,
  usageLifecycleStatement,
} from "../../src/domain/usage.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

const start = Date.parse("2026-01-01T00:00:00.000Z"),
  iso = (value: number) => new Date(value).toISOString();
const resources = {
  memory_mib: 512,
  cpu_millicores: 500,
  reserved_memory_mib: 640,
  reserved_cpu_millicores: 600,
  storage_allocated_bytes: 5 * 1024 ** 3,
};
afterEach(async () => {
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
  const inserts = ids.map((id) =>
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
  );
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
    expect(
      JSON.parse((await rows(id))[0]!.metrics).reserved_memory_mib_seconds,
    ).toBe(640 * 1800);
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
  it("wires the exact regional R2 backup bytes through the bounded usage cron and hourly row", async () => {
    const f = await cohort(),
      id = f.ids[0]!,
      now = Date.now(),
      current = Math.floor(now / USAGE_HOUR_MS) * USAGE_HOUR_MS;
    const archivePath = archiveDestinationPath(
      "pgcf-api-us-test",
      f.region,
      id,
      1,
      newOperationId(),
    );
    await env.DB.prepare("UPDATE regions SET backup_bucket=? WHERE id=?")
      .bind("pgcf-api-us-test", f.region)
      .run();
    await env.DB.prepare(
      "UPDATE databases SET archive_path=?,created_at=? WHERE id=?",
    )
      .bind(archivePath, iso(current), id)
      .run();
    const prefix = `${f.region}/${id}/${archivePath.slice(archivePath.lastIndexOf("/") + 1)}/database/`,
      key = `${prefix}fixture`;
    await env.ARCHIVE_US.put(key, new Uint8Array(37));
    await env.ARCHIVE.put(key, new Uint8Array(99));
    try {
      const result = await runUsageCron(env.DB, Date.now(), {
        ...env,
        ARCHIVE_BINDINGS: JSON.stringify({
          [f.region]: { binding: "ARCHIVE_US", bucket: "pgcf-api-us-test" },
        }),
      });
      expect(result.backupMeasured).toBe(1);
      expect(result.backupUnavailable).toBe(0);
      expect(result.statements).toBeLessThanOrEqual(USAGE_CRON_STATEMENT_LIMIT);
      const saved = await rows(id);
      expect(JSON.parse(saved[0]!.metrics).backup_bytes_max).toBe(37);
    } finally {
      await env.ARCHIVE.delete(key);
      await env.ARCHIVE_US.delete(key);
    }
  });
});
