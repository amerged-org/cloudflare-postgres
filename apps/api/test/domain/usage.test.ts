// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseWithOperation, newDatabaseId } from "@pgcf/contracts";
import {
  USAGE_HOUR_MS,
  UsageQuery,
  type UsageLifecycleEvent,
  type UsageSample,
} from "@pgcf/contracts/usage";
import { createApp } from "../../src/app.ts";
import {
  recordUsageSample,
  usageLifecycleStatement,
} from "../../src/domain/usage.ts";
import {
  aggregateUsageDay,
  computeUsageHour,
  rollupUsageHour,
} from "../../src/domain/usage-rollup.ts";
import {
  cleanupFixtures,
  fixture,
  observedBody,
  observation,
  request,
} from "./fixtures.ts";

const epoch = Date.parse("2026-01-01T00:00:00.000Z"),
  iso = (value: number) => new Date(value).toISOString();
const resources = {
  memory_mib: 512,
  cpu_millicores: 500,
  reserved_memory_mib: 640,
  reserved_cpu_millicores: 600,
  storage_allocated_bytes: 5 * 1024 ** 3,
};
const databaseIds: string[] = [];
afterEach(async () => {
  for (const id of databaseIds.splice(0))
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_hourly WHERE database_id=?").bind(id),
      env.DB.prepare("DELETE FROM usage_samples WHERE database_id=?").bind(id),
    ]);
  await cleanupFixtures();
});
async function setup() {
  const f = await fixture(),
    id = newDatabaseId();
  await env.DB.prepare(
    `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,archive_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running',?,?,?)`,
  )
    .bind(
      id,
      f.project,
      f.region,
      f.node,
      "metered",
      f.size,
      `s3://${["fixture", "archive"].join("-")}/${id}`,
      iso(epoch),
      iso(epoch),
    )
    .run();
  databaseIds.push(id);
  const event = (
    kind: UsageLifecycleEvent["kind"],
    offset: number,
    generation = 1,
    snapshot = resources,
  ) =>
    usageLifecycleStatement(env.DB, {
      database_id: id,
      kind,
      occurred_at: iso(epoch + offset),
      generation,
      node_id: f.node,
      size_class_id: f.size,
      resources: snapshot,
    });
  const sample = (
    offset = 0,
    sequence = 0,
  ): Extract<UsageSample, { source: "gateway" }> => ({
    source: "gateway",
    database_id: id,
    producer_id: "gateway_a",
    sequence,
    interval_start: iso(epoch + offset),
    interval_end: iso(epoch + offset + USAGE_HOUR_MS),
    observed_at: iso(epoch + offset + USAGE_HOUR_MS),
    expected_producers: ["gateway_a"],
    ingress_bytes: 0,
    egress_bytes: 0,
    connections: 0,
    connection_seconds: 0,
  });
  return { ...f, id, event, sample };
}
async function getUsage(key: string, query: Record<string, string>) {
  const app = createApp();
  const context = createExecutionContext();
  const response = await app.fetch(
    new Request(
      `https://${["api", "invalid"].join(".")}/v1/usage?${new URLSearchParams(query)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    ),
    env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
describe("hourly usage", () => {
  it("includes a point gauge at the actual current measurement end while excluding the next UTC hour", async () => {
    const f = await setup();
    const sample = (observed: number) => ({
      payload: JSON.stringify({
        source: "backup",
        database_id: f.id,
        producer_id: "archive",
        sequence: observed,
        observed_at: iso(observed),
        backup_bytes: 41,
      }),
    });
    const database = {
      id: f.id,
      project_id: f.project,
      created_at: iso(epoch),
    };
    expect(
      computeUsageHour(
        database,
        epoch,
        [],
        [sample(epoch + 1_800_000)],
        epoch + 1_800_000,
      ).metrics.backup_bytes_max,
    ).toBe(41);
    expect(
      computeUsageHour(
        database,
        epoch,
        [],
        [sample(epoch + USAGE_HOUR_MS)],
        epoch + USAGE_HOUR_MS,
      ).metrics.backup_bytes_max,
    ).toBeNull();
  });
  it("meters actual create and accepted-ready API transitions from their immutable resource snapshots", async () => {
    const f = await fixture();
    const created = DatabaseWithOperation.parse(
      await (await f.create()).json(),
    );
    const id = created.database.id;
    databaseIds.push(id);
    const response = await request(
      "/agent/v1/observations",
      f.agent,
      "POST",
      observedBody([observation(id, 1)]),
    );
    expect(response.status).toBe(200);
    const measuredAt = Date.now() + 2_000;
    const hour = Math.floor(measuredAt / USAGE_HOUR_MS) * USAGE_HOUR_MS;
    const usage = await rollupUsageHour(env.DB, id, hour, measuredAt);
    expect(usage.metrics.awake_seconds).toBeGreaterThan(0);
    expect(usage.metrics.memory_mib_seconds).toBe(
      usage.metrics.awake_seconds! * 512,
    );
    expect(usage.metrics.cpu_millicore_seconds).toBe(
      usage.metrics.awake_seconds! * 500,
    );
    expect(usage.gaps).not.toContain("resource_snapshot");
    expect(usage.metrics.ingress_bytes).toBeNull();
  });
  it("keeps an uncomputed expired hour pending rather than claiming immutable final metrics", async () => {
    const f = await setup();
    const response = await getUsage(f.integrator, {
      database_id: f.id,
      from: iso(epoch),
      to: iso(epoch + USAGE_HOUR_MS),
      granularity: "hour",
    });
    expect(response.status).toBe(200);
    const body = await response.json<{
      data: { final: boolean; gaps: string[] }[];
    }>();
    expect(body.data[0]!.gaps).toContain("rollup_pending");
    expect(body.data[0]!.final).toBe(false);
  });
  it("splits create-ready-sleep-wake-delete across UTC hours", async () => {
    const f = await setup();
    await env.DB.batch([
      f.event("created", 0),
      f.event("ready", 600_000),
      f.event("hibernated", 3_000_000),
      f.event("woke", 4_200_000),
      f.event("deleted", 5_400_000),
    ]);
    const first = await rollupUsageHour(env.DB, f.id, epoch, epoch + 7_200_000),
      second = await rollupUsageHour(
        env.DB,
        f.id,
        epoch + USAGE_HOUR_MS,
        epoch + 7_200_000,
      );
    expect(first.metrics.provisioned_seconds).toBe(3600);
    expect(first.metrics.awake_seconds).toBe(2400);
    expect(second.metrics.provisioned_seconds).toBe(1800);
    expect(second.metrics.awake_seconds).toBe(1200);
    expect(first.metrics.memory_mib_seconds).toBe(512 * 2400);
    expect(second.metrics.reserved_memory_mib_seconds).toBe(640 * 1800);
  });
  it("preserves resize snapshots when the mutable size class changes", async () => {
    const f = await setup(),
      resized = { ...resources, memory_mib: 1024, reserved_memory_mib: 1152 };
    await env.DB.batch([
      f.event("created", 0),
      f.event("ready", 0),
      f.event("resized", 1_800_000, 2, resized),
    ]);
    await env.DB.prepare("UPDATE size_classes SET memory_mib=2048 WHERE id=?")
      .bind(f.size)
      .run();
    const row = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + USAGE_HOUR_MS,
    );
    expect(row.metrics.memory_mib_seconds).toBe((512 + 1024) * 1800);
    await expect(
      env.DB.prepare(
        "UPDATE lifecycle_events SET resource_snapshot=NULL WHERE database_id=?",
      )
        .bind(f.id)
        .run(),
    ).rejects.toThrow("immutable");
  });
  it("does not rewrite a lifecycle transition on a retry with a newer timestamp", async () => {
    const f = await setup();
    await env.DB.batch([
      f.event("created", 0),
      f.event("ready", 0),
      f.event("ready", 60_000, 1, { ...resources, memory_mib: 1024 }),
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM lifecycle_events WHERE database_id=?",
        )
          .bind(f.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
    const row = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + USAGE_HOUR_MS,
    );
    expect(row.metrics.memory_mib_seconds).toBe(512 * 3600);
  });
  it("reports pre-snapshot resources and absent measurement components as gaps", async () => {
    const f = await setup();
    await env.DB.prepare(
      "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) VALUES(?,'created',?,?,1,?)",
    )
      .bind(f.id, f.node, f.size, iso(epoch))
      .run();
    const row = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + USAGE_HOUR_MS,
    );
    expect(row.metrics.provisioned_seconds).toBe(3600);
    expect(row.metrics.memory_mib_seconds).toBeNull();
    expect(row.metrics.ingress_bytes).toBeNull();
    expect(row.metrics.storage_used_bytes_max).toBeNull();
    expect(row.gaps).toEqual(
      expect.arrayContaining([
        "resource_snapshot",
        "traffic_coverage",
        "ingress_bytes",
        "storage_used_bytes_max",
      ]),
    );
  });
  it("records measured zero while a silent active transaction remains awake", async () => {
    const f = await setup();
    await env.DB.batch([f.event("created", 0), f.event("ready", 0)]);
    await recordUsageSample(
      env.DB,
      { region_id: f.region, source: "gateway" },
      { ...f.sample(), connection_seconds: 3600 },
      epoch + USAGE_HOUR_MS,
    );
    await recordUsageSample(
      env.DB,
      { region_id: f.region, source: "agent" },
      {
        source: "agent",
        database_id: f.id,
        producer_id: "node",
        sequence: 0,
        observed_at: iso(epoch + 1),
        storage_used_bytes: 0,
        storage_allocated_bytes: 0,
      },
      epoch + USAGE_HOUR_MS,
    );
    const row = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + USAGE_HOUR_MS,
    );
    expect(row.metrics.ingress_bytes).toBe(0);
    expect(row.metrics.connections).toBe(0);
    expect(row.metrics.connection_seconds).toBe(3600);
    expect(row.metrics.storage_used_bytes_max).toBe(0);
    expect(row.metrics.backup_bytes_max).toBeNull();
    expect(row.metrics.awake_seconds).toBe(3600);
    expect(row.metrics.cpu_millicore_seconds).toBe(500 * 3600);
  });
  it("deduplicates and accepts out-of-order disjoint intervals without double counting", async () => {
    const f = await setup();
    await env.DB.batch([f.event("created", 0), f.event("ready", 0)]);
    const full = f.sample();
    if (full.source !== "gateway") throw new Error("fixture");
    const first = {
        ...full,
        sequence: 1,
        interval_end: iso(epoch + 1_800_000),
        ingress_bytes: 10,
      },
      second = {
        ...full,
        sequence: 2,
        interval_start: iso(epoch + 1_800_000),
        ingress_bytes: 20,
      };
    const principal = { region_id: f.region, source: "gateway" as const };
    expect(
      await recordUsageSample(env.DB, principal, second, epoch + USAGE_HOUR_MS),
    ).toBe("recorded");
    expect(
      await recordUsageSample(env.DB, principal, first, epoch + USAGE_HOUR_MS),
    ).toBe("recorded");
    expect(
      await recordUsageSample(env.DB, principal, second, epoch + USAGE_HOUR_MS),
    ).toBe("duplicate");
    await expect(
      recordUsageSample(
        env.DB,
        principal,
        { ...second, ingress_bytes: 21 },
        epoch + USAGE_HOUR_MS,
      ),
    ).rejects.toThrow("identity");
    await expect(
      recordUsageSample(
        env.DB,
        principal,
        { ...full, sequence: 3 },
        epoch + USAGE_HOUR_MS,
      ),
    ).rejects.toThrow("overlaps");
    const a = await rollupUsageHour(env.DB, f.id, epoch, epoch + USAGE_HOUR_MS),
      b = await rollupUsageHour(env.DB, f.id, epoch, epoch + USAGE_HOUR_MS);
    expect(a.metrics.ingress_bytes).toBe(30);
    expect(b).toEqual(a);
    expect(
      (
        await env.DB.prepare(
          "SELECT count(*) n FROM usage_hourly WHERE database_id=?",
        )
          .bind(f.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
  it("requires every real gateway producer and complete interval coverage", async () => {
    const f = await setup();
    await env.DB.batch([f.event("created", 0), f.event("ready", 0)]);
    const full = f.sample();
    if (full.source !== "gateway") throw new Error("fixture");
    await recordUsageSample(
      env.DB,
      { region_id: f.region, source: "gateway" },
      { ...full, expected_producers: ["gateway_a", "gateway_b"] },
      epoch + USAGE_HOUR_MS,
    );
    const row = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + USAGE_HOUR_MS,
    );
    expect(row.metrics.connections).toBeNull();
    expect(row.gaps).toContain("traffic_coverage");
  });
  it("finalizes exactly two hours after the hour and retains gaps immutably", async () => {
    const f = await setup();
    await env.DB.batch([f.event("created", 0), f.event("ready", 0)]);
    expect(
      (
        await rollupUsageHour(
          env.DB,
          f.id,
          epoch,
          epoch + 3 * USAGE_HOUR_MS - 1,
        )
      ).final,
    ).toBe(false);
    const final = await rollupUsageHour(
      env.DB,
      f.id,
      epoch,
      epoch + 3 * USAGE_HOUR_MS,
    );
    expect(final.final).toBe(true);
    expect(final.metrics.connections).toBeNull();
    await expect(
      recordUsageSample(
        env.DB,
        { region_id: f.region, source: "gateway" },
        f.sample(),
        epoch + 3 * USAGE_HOUR_MS,
      ),
    ).rejects.toThrow("finalized");
    expect(
      await rollupUsageHour(env.DB, f.id, epoch, epoch + 4 * USAGE_HOUR_MS),
    ).toEqual(final);
  });
  it("includes a measurement accepted between the read and final upsert", async () => {
    const f = await setup();
    await env.DB.batch([f.event("created", 0), f.event("ready", 0)]);
    const principal = { region_id: f.region, source: "agent" as const };
    const measured: UsageSample = {
      source: "agent",
      database_id: f.id,
      producer_id: "node",
      sequence: 0,
      observed_at: iso(epoch + 1),
      storage_used_bytes: 0,
      storage_allocated_bytes: resources.storage_allocated_bytes,
    };
    await recordUsageSample(env.DB, principal, measured, epoch + USAGE_HOUR_MS);
    let injected = false;
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "run")
            return async () => {
              if (!injected) {
                injected = true;
                await recordUsageSample(
                  env.DB,
                  principal,
                  {
                    ...measured,
                    sequence: 1,
                    observed_at: iso(epoch + 2),
                    storage_used_bytes: 42,
                  },
                  epoch + 3 * USAGE_HOUR_MS,
                );
              }
              return target.run();
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const racing = new Proxy(env.DB, {
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
    const row = await rollupUsageHour(
      racing,
      f.id,
      epoch,
      epoch + 3 * USAGE_HOUR_MS,
    );
    expect(injected).toBe(true);
    expect(row.final).toBe(true);
    expect(row.metrics.storage_used_bytes_max).toBe(42);
  });
  it("aggregates exactly 24 contiguous UTC hours and propagates missing hours", () => {
    const id = newDatabaseId(),
      project_id = "prj_" + id;
    const rows = Array.from({ length: 24 }, (_, index) =>
      computeUsageHour(
        { id, project_id, created_at: iso(epoch) },
        epoch + index * USAGE_HOUR_MS,
        [
          {
            id: 1,
            kind: "created",
            occurred_at: iso(epoch),
            resource_snapshot: JSON.stringify(resources),
          },
        ],
        [],
        epoch + 27 * USAGE_HOUR_MS,
      ),
    );
    expect(aggregateUsageDay(rows).metrics.provisioned_seconds).toBe(86400);
    expect(aggregateUsageDay(rows).metrics.connections).toBeNull();
    expect(aggregateUsageDay(rows).final).toBe(true);
    expect(() => aggregateUsageDay(rows.slice(1))).toThrow("24");
  });
  it("keeps deleted database history and refuses a foreign integrator scope", async () => {
    const f = await setup();
    await env.DB.batch([
      f.event("created", 0),
      f.event("ready", 0),
      f.event("deleted", USAGE_HOUR_MS),
    ]);
    await rollupUsageHour(env.DB, f.id, epoch, epoch + 3 * USAGE_HOUR_MS);
    await env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
    )
      .bind(iso(epoch + USAGE_HOUR_MS), f.id)
      .run();
    const query = {
      database_id: f.id,
      from: iso(epoch),
      to: iso(epoch + USAGE_HOUR_MS),
      granularity: "hour",
    };
    expect((await getUsage(f.integrator, query)).status).toBe(200);
    expect((await getUsage(f.admin, query)).status).toBe(200);
    expect((await getUsage(f.otherKey, query)).status).toBe(404);
    expect(
      (
        await getUsage(f.otherKey, {
          ...query,
          database_id: "",
          project_id: f.project,
        })
      ).status,
    ).toBe(400);
    const range = {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
    };
    expect(
      (await getUsage(f.otherKey, { ...range, project_id: f.project })).status,
    ).toBe(404);
  });
  it("exposes pending rollup gaps, validates broad queries and paginates UTC days", async () => {
    const f = await setup(),
      range = {
        from: iso(epoch),
        to: iso(epoch + 48 * USAGE_HOUR_MS),
        granularity: "day",
      };
    expect((await getUsage(f.admin, range)).status).toBe(400);
    expect(
      (
        await getUsage(f.admin, {
          ...range,
          project_id: f.project,
          to: iso(epoch + 32 * 24 * USAGE_HOUR_MS),
        })
      ).status,
    ).toBe(400);
    const response = await getUsage(f.integrator, {
      ...range,
      project_id: f.project,
      limit: "1",
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      data: {
        metrics: { awake_seconds: number | null };
        gaps: string[];
        start: string;
        end: string;
      }[];
      next_cursor: string;
    };
    expect(result.data[0]!.start).toBe(iso(epoch));
    expect(result.data[0]!.end).toBe(iso(epoch + 24 * USAGE_HOUR_MS));
    expect(result.data[0]!.metrics.awake_seconds).toBeNull();
    expect(result.data[0]!.gaps).toContain("rollup_pending");
    const next = await getUsage(f.integrator, {
      ...range,
      project_id: f.project,
      limit: "1",
      cursor: result.next_cursor,
    });
    expect(next.status).toBe(200);
    expect(
      ((await next.json()) as { data: { start: string }[] }).data[0]!.start,
    ).toBe(iso(epoch + 24 * USAGE_HOUR_MS));
    expect(
      UsageQuery.safeParse({ ...range, project_id: f.project }).success,
    ).toBe(true);
  });
  it("refuses unauthenticated recorder source or region mismatches", async () => {
    const f = await setup();
    await expect(
      recordUsageSample(
        env.DB,
        { region_id: f.foreign, source: "gateway" },
        f.sample(),
        epoch + USAGE_HOUR_MS,
      ),
    ).rejects.toThrow("not found");
    await expect(
      recordUsageSample(
        env.DB,
        { region_id: f.region, source: "agent" },
        f.sample(),
        epoch + USAGE_HOUR_MS,
      ),
    ).rejects.toThrow("Invalid usage recorder");
  });
});
