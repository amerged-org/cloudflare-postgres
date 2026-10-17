// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  INFRA_ALERT_ACTIONS,
  InfraAlert,
  newNodeId,
  type InfraAlertKind,
} from "@pgcf/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  infrastructureAlertStatus,
  runInfrastructureHealthAlerts,
} from "../../src/domain/infrastructure-alerts.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=NULL,notification_sender=NULL WHERE singleton=1",
  ).run();
  await cleanupFixtures();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const ago = (now: number, ms: number) => new Date(now - ms).toISOString();
const HOUR = 3_600_000;

async function database(
  f: Fixture,
  name: string,
  columns: Record<string, string | number | null> = {},
) {
  const created = DatabaseWithOperation.parse(
    await (await f.create(name)).json(),
  );
  const id = created.database.id,
    keys = Object.keys(columns);
  // The create's own lifecycle event is "now"; these databases claim an older history.
  await env.DB.prepare("DELETE FROM lifecycle_events WHERE database_id=?")
    .bind(id)
    .run();
  if (keys.length)
    await env.DB.prepare(
      `UPDATE databases SET ${keys.map((key) => `${key}=?`).join(",")} WHERE id=?`,
    )
      .bind(...Object.values(columns), id)
      .run();
  return id;
}
const awake = (now: number, extra: Record<string, string | number | null>) => ({
  observed_state: "ready",
  observed_power: "awake",
  created_at: ago(now, 100 * HOUR),
  ...extra,
});
/** The webhook receiver of the alert tests: records each event and acknowledges it. */
function receiver() {
  const events: { event: InfraAlert; key: string | null }[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    events.push({
      event: InfraAlert.parse(JSON.parse(init!.body as string)),
      key: new Headers(init!.headers).get("Idempotency-Key"),
    });
    return new Response(null, { status: 204 });
  };
  return {
    events,
    fetcher,
    env: {
      ...env,
      INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
      INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
    },
  };
}
const status = async (f: Fixture, kind: InfraAlertKind) =>
  (await infrastructureAlertStatus(env.DB, f.region)).find(
    (value) => value.kind === kind,
  );

it("alarms a failing WAL archive once, with the databases and the runbook action, by email", async () => {
  const f = await fixture(),
    now = Date.now(),
    failing = await database(
      f,
      "archive-a",
      awake(now, {
        archiving_health: "failing",
        archiving_health_since: ago(now, 20 * 60_000),
      }),
    );
  await database(f, "archive-ok", awake(now, { archiving_health: "ok" }));
  await database(
    f,
    "archive-unknown",
    awake(now, { archiving_health: "unknown" }),
  );
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=?,notification_sender=? WHERE singleton=1",
  )
    .bind("operator@example.com", "alerts@example.com")
    .run();
  const sent: {
    body: Record<string, unknown>;
    key: string | null;
    agent: string | null;
  }[] = [];
  const mail: typeof fetch = async (_url, init) => {
    const headers = new Headers(init!.headers);
    sent.push({
      body: JSON.parse(init!.body as string),
      key: headers.get("Idempotency-Key"),
      agent: headers.get("User-Agent"),
    });
    return new Response(null, { status: 202 });
  };
  const binding = { ...env, RESEND_API_KEY: "test-private-resend-key" };
  await runInfrastructureHealthAlerts(binding, now, mail);
  await runInfrastructureHealthAlerts(binding, now + 61_000, mail);
  expect(sent).toHaveLength(1);
  const episode = await status(f, "database_archive_failing");
  expect(episode).toMatchObject({ active: true });
  expect(sent[0]!.key).toBe(episode!.event_id);
  // The mail API asks for a user agent; a Worker's outbound request does not always carry one.
  expect(sent[0]!.agent).toBe("pgcf-infrastructure-alerts");
  expect(sent[0]!.body.subject).toBe(
    `PGCF infrastructure: database_archive_failing (${f.region})`,
  );
  const event = InfraAlert.parse(JSON.parse(String(sent[0]!.body.text)));
  expect(event).toMatchObject({
    kind: "database_archive_failing",
    region_id: f.region,
    database_ids: [failing],
    action: INFRA_ALERT_ACTIONS.database_archive_failing,
  });
});

it("never alarms an unknown archive, keeps an episode through an unknown reading and clears it once ok", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver(),
    id = await database(
      f,
      "archive",
      awake(now, { archiving_health: "unknown" }),
    ),
    set = (health: string) =>
      env.DB.prepare("UPDATE databases SET archiving_health=? WHERE id=?")
        .bind(health, id)
        .run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "database_archive_failing")).toBeUndefined();
  await set("failing");
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  const first = await status(f, "database_archive_failing");
  expect(first).toMatchObject({ active: true });
  // A controller restart reports the archive unknown for a while: neither a clear nor a new event.
  await set("unknown");
  await runInfrastructureHealthAlerts(hook.env, now + 2000, hook.fetcher);
  expect(await status(f, "database_archive_failing")).toMatchObject({
    active: true,
    event_id: first!.event_id,
  });
  await set("ok");
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  expect(await status(f, "database_archive_failing")).toMatchObject({
    active: false,
  });
  await set("failing");
  await runInfrastructureHealthAlerts(hook.env, now + 4000, hook.fetcher);
  const second = await status(f, "database_archive_failing");
  expect(second).toMatchObject({ active: true });
  expect(second!.event_id).not.toBe(first!.event_id);
  expect(hook.events.map((value) => value.event.kind)).toEqual([
    "database_archive_failing",
    "database_archive_failing",
  ]);
});

it("does not alarm a database that cannot archive and announces each database that newly fails", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await database(
    f,
    "hibernated",
    awake(now, { observed_power: "hibernated", archiving_health: "failing" }),
  );
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "database_archive_failing")).toBeUndefined();
  const a = await database(
      f,
      "a",
      awake(now, {
        archiving_health: "failing",
        archiving_health_since: ago(now, 3 * HOUR),
      }),
    ),
    b = await database(f, "b", awake(now, { archiving_health: "ok" })),
    set = (id: string, health: string) =>
      env.DB.prepare("UPDATE databases SET archiving_health=? WHERE id=?")
        .bind(health, id)
        .run();
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(hook.events[0]!.event.database_ids).toEqual([a]);
  // A second database failing while the first still fails is announced, listing both.
  await set(b, "failing");
  await runInfrastructureHealthAlerts(hook.env, now + 2000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  expect(new Set(hook.events[1]!.event.database_ids)).toEqual(new Set([a, b]));
  expect(hook.events[1]!.event.event_id).not.toBe(
    hook.events[0]!.event.event_id,
  );
  // Neither a listed database recovering nor failing again adds a message.
  await set(a, "ok");
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  await set(a, "failing");
  await runInfrastructureHealthAlerts(hook.env, now + 4000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
});

it("announces a node that goes stale after another was marked lost", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await env.DB.prepare(
    "UPDATE nodes SET last_observed_at=?,lost_at=? WHERE id=?",
  )
    .bind(ago(now, 2 * HOUR), ago(now, HOUR), f.node)
    .run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(hook.events[0]!.event.node_ids).toEqual([f.node]);
  const second = newNodeId(),
    at = new Date(now).toISOString();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid) VALUES (?,?,?,1,4096,2000,30,128,100,?,?,?,?)",
  )
    .bind(
      second,
      f.region,
      `${f.nodeName}-second`,
      ago(now, 10 * 60_000),
      at,
      at,
      crypto.randomUUID(),
    )
    .run();
  // The lost node keeps the episode active, yet the node that went stale now is not hidden by it.
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  expect(new Set(hook.events[1]!.event.node_ids)).toEqual(
    new Set([f.node, second]),
  );
});

it("alarms a base backup older than 36 h of awake time and excludes hibernated, unknown and skipped ones", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver(),
    sample = {
      backup_health: "ok",
      backup_observed_at: ago(now, 10_000),
    };
  const stale = await database(
    f,
    "stale",
    awake(now, { ...sample, backup_last_completed_at: ago(now, 40 * HOUR) }),
  );
  // Routine changes (a role's password, a resize) bump the generation and write a `ready` event
  // without making the database any more backed up.
  await env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'ready',node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(ago(now, HOUR), stale)
    .run();
  // Slept through its 03:00 backup and woke an hour ago: the 36 h count starts at the wake.
  const woke = await database(
    f,
    "woke",
    awake(now, { ...sample, backup_last_completed_at: ago(now, 90 * HOUR) }),
  );
  await env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,'woke',node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(ago(now, HOUR), woke)
    .run();
  await database(
    f,
    "hibernated",
    awake(now, {
      ...sample,
      observed_power: "hibernated",
      backup_last_completed_at: ago(now, 90 * HOUR),
    }),
  );
  await database(
    f,
    "unknown",
    awake(now, {
      backup_health: "unknown",
      backup_observed_at: ago(now, 10_000),
      backup_last_completed_at: ago(now, 90 * HOUR),
    }),
  );
  await database(
    f,
    "old-sample",
    awake(now, {
      backup_health: "ok",
      backup_observed_at: ago(now, 600_000),
      backup_last_completed_at: ago(now, 90 * HOUR),
    }),
  );
  await database(
    f,
    "fresh",
    awake(now, { ...sample, backup_last_completed_at: ago(now, 5 * HOUR) }),
  );
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(hook.events[0]!.event).toMatchObject({
    kind: "database_base_backup_stale",
    database_ids: [stale],
    action: INFRA_ALERT_ACTIONS.database_base_backup_stale,
  });
  // The next completed backup clears the episode.
  await env.DB.prepare(
    "UPDATE databases SET backup_last_completed_at=? WHERE id=?",
  )
    .bind(ago(now, 1000), stale)
    .run();
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(await status(f, "database_base_backup_stale")).toMatchObject({
    active: false,
  });
});

const thinVg = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
  mib = 1024 ** 2,
  gib = 1024 ** 3;
async function thinNode(
  f: Fixture,
  columns: { status: string; code: string | null },
  profile: object = {},
) {
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,material_revision,status,error_code,created_at,updated_at)
    SELECT id,node_uid,?,?,?,1,?,?,1,?,?,?,? FROM nodes WHERE id=?`,
  )
    .bind(
      crypto.randomUUID(),
      "192.0.2.10",
      thinVg,
      "a".repeat(64),
      JSON.stringify(profile),
      columns.status,
      columns.code,
      at,
      at,
      f.node,
    )
    .run();
}
/** The node's fresh physical sample of its thin pool. */
async function poolSample(
  f: Fixture,
  pool: {
    dataTotal: number;
    dataFree: number;
    metadataFree: number;
    vgFree?: number;
  },
) {
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_storage_observations(node_id,node_uid,observed_at,received_at,physical_json) SELECT id,node_uid,?,?,? FROM nodes WHERE id=? ON CONFLICT(node_id) DO UPDATE SET observed_at=excluded.observed_at,physical_json=excluded.physical_json",
  )
    .bind(
      at,
      at,
      JSON.stringify({
        volume_group_uuid: thinVg,
        total_bytes: 100 * gib,
        free_bytes: pool.vgFree ?? 50 * gib,
        thick_allocated_bytes: 0,
        thin_pool: {
          name: "pgcf_thinpool",
          data_total_bytes: pool.dataTotal,
          data_used_bytes_upper_bound: pool.dataTotal - pool.dataFree,
          metadata_total_bytes: gib,
          metadata_used_bytes_upper_bound: gib - pool.metadataFree,
        },
      }),
      f.node,
    )
    .run();
}

it("alarms a thin pool without room, or below its growth point with no growth left, and clears it once it has room", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await thinNode(
    f,
    { status: "ready", code: null },
    {
      growth_bytes: 8 * gib,
      maximum_data_bytes: 64 * gib,
      vg_reserve_bytes: 4 * gib,
      data_reserve_bytes: 512 * mib,
      metadata_reserve_bytes: 64 * mib,
      startup_reserve_bytes: 32 * mib,
    },
  );
  const failing = () =>
    hook.events.at(-1)!.event.thin_storage?.map((entry) => entry.error_code);
  await poolSample(f, {
    dataTotal: 32 * gib,
    dataFree: 8 * gib,
    metadataFree: 512 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toBeUndefined();
  // Below the data reserve: no start or attach on the node.
  await poolSample(f, {
    dataTotal: 32 * gib,
    dataFree: 100 * mib,
    metadataFree: 512 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(failing()).toEqual(["thin_pool_no_room"]);
  await poolSample(f, {
    dataTotal: 32 * gib,
    dataFree: 8 * gib,
    metadataFree: 512 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now + 2000, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: false,
  });
  // Room for now, below the growth point, and the pool at its maximum.
  await poolSample(f, {
    dataTotal: 64 * gib,
    dataFree: 520 * mib,
    metadataFree: 512 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  expect(failing()).toEqual(["thin_pool_growth_exhausted"]);
  await poolSample(f, {
    dataTotal: 32 * gib,
    dataFree: 8 * gib,
    metadataFree: 512 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now + 4000, hook.fetcher);
  // Metadata never grows: twice its reserve is already the alarm.
  await poolSample(f, {
    dataTotal: 32 * gib,
    dataFree: 8 * gib,
    metadataFree: 100 * mib,
  });
  await runInfrastructureHealthAlerts(hook.env, now + 5000, hook.fetcher);
  expect(hook.events).toHaveLength(3);
  expect(failing()).toEqual(["thin_pool_growth_exhausted"]);
});

it("alarms a blocked Thin node with its error code, keeps the episode while it requalifies and clears it once ready", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver(),
    set = (status: string, code: string | null) =>
      env.DB.prepare(
        "UPDATE node_thin_storage SET status=?,error_code=? WHERE node_id=?",
      )
        .bind(status, code, f.node)
        .run();
  await thinNode(f, { status: "ready", code: null });
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toBeUndefined();
  await set("blocked", "thin_storage_report_unqualified");
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(hook.events[0]!.event).toMatchObject({
    kind: "thin_storage_blocked",
    thin_storage: [
      { node_id: f.node, error_code: "thin_storage_report_unqualified" },
    ],
    action: INFRA_ALERT_ACTIONS.thin_storage_blocked,
  });
  await set("qualifying", null);
  await runInfrastructureHealthAlerts(hook.env, now + 2000, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: true,
  });
  await set("ready", null);
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: false,
  });
  // Only headroom blocks writes: no error code.
  await set("blocked", null);
  await runInfrastructureHealthAlerts(hook.env, now + 4000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  expect(hook.events[1]!.event.thin_storage).toEqual([
    { node_id: f.node, error_code: null },
  ]);
});

it("still judges nodes when the database reads fail and keeps the unread kinds as they were", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(ago(now, 10 * 60_000), f.node)
    .run();
  await database(
    f,
    "archive",
    awake(now, {
      archiving_health: "failing",
      archiving_health_since: ago(now, HOUR),
    }),
  );
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "regional_node_stale")).toMatchObject({
    active: true,
  });
  expect(await status(f, "database_archive_failing")).toMatchObject({
    active: true,
  });
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(ago(now, 1000), f.node)
    .run();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.startsWith("WITH p AS (SELECT ? region"))
            throw new Error("injected_read_failure");
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    runInfrastructureHealthAlerts(
      { ...hook.env, DB: broken },
      now + 1000,
      hook.fetcher,
    ),
  ).rejects.toThrow("injected_read_failure");
  // The node kind was judged and cleared; the unread database kind is unknown, so it stays.
  expect(await status(f, "regional_node_stale")).toMatchObject({
    active: false,
  });
  expect(await status(f, "database_archive_failing")).toMatchObject({
    active: true,
  });
  expect(logged).toHaveBeenCalled();
});

it("still judges every region's nodes and databases when the backup health read fails", async () => {
  const f = await fixture(),
    now = Date.now(),
    hook = receiver();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(ago(now, 10 * 60_000), f.node)
    .run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "regional_node_stale")).toMatchObject({
    active: true,
  });
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(ago(now, 1000), f.node)
    .run();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (
            sql.startsWith(
              "SELECT id FROM regions WHERE bootstrap_material_revision>0",
            )
          )
            throw new Error("injected_backup_health_failure");
          return target.prepare(sql);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    runInfrastructureHealthAlerts(
      { ...hook.env, DB: broken },
      now + 1000,
      hook.fetcher,
    ),
  ).rejects.toThrow("injected_backup_health_failure");
  expect(await status(f, "regional_node_stale")).toMatchObject({
    active: false,
  });
});

it("logs a refused delivery with its status and nothing of the destination", async () => {
  const f = await fixture(),
    now = Date.now(),
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await database(
    f,
    "archive",
    awake(now, {
      archiving_health: "failing",
      archiving_health_since: ago(now, HOUR),
    }),
  );
  const refused: typeof fetch = async () => new Response(null, { status: 403 });
  await runInfrastructureHealthAlerts(
    {
      ...env,
      INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
      INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
    },
    now,
    refused,
  );
  const lines = logged.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes("infrastructure_alert_delivery_failed"));
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({
    event: "infrastructure_alert_delivery_failed",
    region_id: f.region,
    kind: "database_archive_failing",
    status: 403,
  });
  expect(lines[0]).not.toContain("test-alert-receiver-token");
  expect(await status(f, "database_archive_failing")).toMatchObject({
    active: true,
    delivered_at: null,
  });
});
