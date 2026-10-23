// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  DatabaseWithOperation,
  InfraAlert,
  type InfraAlertKind,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  infrastructureAlertStatus,
  runInfrastructureAlerts,
  runInfrastructureHealthAlerts,
} from "../../src/domain/infrastructure-alerts.ts";
import {
  configureNodeRegionPolicy,
  markNodeLost,
} from "../../src/domain/node-state.ts";
import { addNode, cleanupFixtures, fixture } from "./fixtures.ts";
import {
  forgetSamples,
  GIB,
  OPEN_POOL,
  seedSamples,
  steady,
  type SampleSeed,
} from "./node-samples.ts";

afterEach(async () => {
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=NULL,notification_sender=NULL WHERE singleton=1",
  ).run();
  await cleanupFixtures();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const MINUTE = 60_000;
const WEBHOOK = {
  INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
  INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
};
/** The webhook receiver of the alert tests: records each event and acknowledges it. */
function receiver() {
  const events: InfraAlert[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    events.push(InfraAlert.parse(JSON.parse(init!.body as string)));
    return new Response(null, { status: 204 });
  };
  return { events, fetcher, env: { ...env, ...WEBHOOK } };
}
const status = async (f: Fixture, kind: InfraAlertKind) =>
  (await infrastructureAlertStatus(env.DB, f.region)).find(
    (value) => value.kind === kind,
  );
/** A region without a node that has reported: the tests bring the samples they want. */
async function setup(
  warnings: {
    node_ram_warning_threshold_ppm?: number | null;
    node_cpu_warning_threshold_ppm?: number | null;
    node_storage_warning_threshold_ppm?: number | null;
  } = {},
) {
  const f = await fixture(0);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: false,
    order: null,
    ...warnings,
  });
  return f;
}
/** Pauses a run after its node read until `meanwhile` has finished, then lets it complete. */
async function stalled(
  run: (db: D1Database) => Promise<unknown>,
  meanwhile: () => Promise<void>,
) {
  let captured!: () => void, resume!: () => void;
  const read = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const paused = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT id,utilization_ppm FROM"))
            return statement;
          return {
            bind: (...values: unknown[]) => ({
              all: async () => {
                const value = await statement.bind(...values).all();
                captured();
                await release;
                return value;
              },
            }),
          } as unknown as D1PreparedStatement;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const older = run(paused);
  await read;
  try {
    await meanwhile();
  } finally {
    resume();
    await older;
  }
}

const pool = (overrides: Partial<typeof OPEN_POOL>) => ({
  ...OPEN_POOL,
  ...overrides,
});

it("warns when a node's 30-minute RAM average reaches the threshold, closed to placement or not, and clears when it is disabled", async () => {
  const f = await setup({ node_ram_warning_threshold_ppm: 750_000 }),
    hook = receiver(),
    at = Date.now();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
  )
    .bind(f.node)
    .run();
  // Ten minutes of 74.9 %: below.
  await seedSamples(f.node, steady(at, 10, { ramPpm: 749_999 }));
  await runInfrastructureAlerts(hook.env, f.region, at, hook.fetcher);
  expect(hook.events).toEqual([]);
  // The same node a minute later at 75.0 % for the whole window: the average reaches the threshold.
  await forgetSamples(f.node);
  await seedSamples(f.node, steady(at, 10, { ramPpm: 750_000 }));
  await runInfrastructureAlerts(hook.env, f.region, at, hook.fetcher);
  expect(hook.events).toMatchObject([
    {
      kind: "regional_node_ram_warning",
      node_ids: [f.node],
      threshold_ppm: 750_000,
      utilization_ppm: 750_000,
    },
  ]);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    node_ram_warning_threshold_ppm: null,
  });
  await runInfrastructureAlerts(hook.env, f.region, at, hook.fetcher);
  expect(await status(f, "regional_node_ram_warning")).toMatchObject({
    active: false,
  });
});

it("averages the window and needs ten minutes of samples before it judges", async () => {
  const f = await setup({ node_ram_warning_threshold_ppm: 500_000 }),
    at = Date.now();
  // One sample at 90 %: no history to average, so nothing is known.
  await seedSamples(f.node, [{ at, ramPpm: 900_000 }]);
  await runInfrastructureAlerts(env, f.region, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  // 20 minutes of 20 % and the last 10 minutes of 100 %: 31 samples, 11 of them at 100 %.
  await forgetSamples(f.node);
  const samples: SampleSeed[] = steady(at, 30, { ramPpm: 200_000 }).map(
    (sample, i) => (i >= 20 ? { ...sample, ramPpm: 1_000_000 } : sample),
  );
  await seedSamples(f.node, samples);
  await runInfrastructureAlerts(env, f.region, at);
  expect(await status(f, "regional_node_ram_warning")).toBeUndefined();
  // Eleven of 31 samples at 100 % average to 48 %; with a twelfth the average is 51 %.
  await seedSamples(f.node, [{ at: at + MINUTE, ramPpm: 1_000_000 }]);
  await runInfrastructureAlerts(env, f.region, at + MINUTE);
  expect(await status(f, "regional_node_ram_warning")).toMatchObject({
    active: true,
  });
});

it("warns from the CPU load of a node, busy time over all its cores", async () => {
  const f = await setup({ node_cpu_warning_threshold_ppm: 900_000 }),
    at = Date.now();
  await seedSamples(f.node, steady(at, 10, { cpuPpm: 899_999 }));
  await runInfrastructureAlerts(env, f.region, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  await seedSamples(f.node, steady(at + 11 * MINUTE, 10, { cpuPpm: 950_000 }));
  await runInfrastructureAlerts(env, f.region, at + 11 * MINUTE);
  expect(await status(f, "regional_node_cpu_warning")).toMatchObject({
    active: true,
  });
});

it("warns when a thin pool reaches the storage threshold, by the fuller of data and metadata, once under concurrent runs", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 500_000 }),
    hook = receiver(),
    at = Date.now();
  // Data at 40 %, metadata at 49.9 %: below.
  await seedSamples(f.node, [
    {
      at,
      pool: pool({
        dataUsed: 40 * GIB,
        metadataUsed: Math.floor(GIB * 0.4999),
      }),
    },
  ]);
  await runInfrastructureAlerts(hook.env, f.region, at, hook.fetcher);
  expect(hook.events).toEqual([]);
  // Metadata at exactly 50 %.
  await seedSamples(f.node, [
    { at: at + 1, pool: pool({ dataUsed: 40 * GIB, metadataUsed: GIB / 2 }) },
  ]);
  await Promise.all([
    runInfrastructureAlerts(hook.env, f.region, at + 1, hook.fetcher),
    runInfrastructureAlerts(hook.env, f.region, at + 1, hook.fetcher),
  ]);
  await runInfrastructureAlerts(hook.env, f.region, at + 2, hook.fetcher);
  expect(hook.events).toMatchObject([
    {
      kind: "regional_node_storage_warning",
      node_ids: [f.node],
      threshold_ppm: 500_000,
      utilization_ppm: 500_000,
    },
  ]);
});

it("keeps a node warning while a named node is unknown and clears once every named node is known below or lost", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800_000 }),
    second = await addNode(f.region, 0),
    hook = receiver(),
    at = Date.now(),
    later = at + 4 * MINUTE;
  const full = pool({ dataUsed: 90 * GIB }),
    quiet = pool({ dataUsed: 10 * GIB });
  await seedSamples(f.node, [{ at, pool: full }]);
  await seedSamples(second, [{ at, pool: quiet }]);
  await runInfrastructureAlerts(hook.env, f.region, at, hook.fetcher);
  expect(hook.events).toMatchObject([{ node_ids: [f.node] }]);
  const armed = await status(f, "regional_node_storage_warning");
  // The named node stops reporting while the other stays fresh and below: unknown, so kept.
  await seedSamples(second, [{ at: later, pool: quiet }]);
  await runInfrastructureAlerts(hook.env, f.region, later, hook.fetcher);
  expect(await status(f, "regional_node_storage_warning")).toEqual(armed);
  // It reports again, below: cleared.
  await seedSamples(f.node, [{ at: later + 1, pool: quiet }]);
  await runInfrastructureAlerts(hook.env, f.region, later + 1, hook.fetcher);
  expect(await status(f, "regional_node_storage_warning")).toMatchObject({
    active: false,
  });
  // The other node crosses; a lost node clears its own episode.
  await seedSamples(second, [{ at: later + 2, pool: full }]);
  await runInfrastructureAlerts(hook.env, f.region, later + 2, hook.fetcher);
  expect(hook.events).toMatchObject([
    { node_ids: [f.node] },
    { node_ids: [second], utilization_ppm: 900_000 },
  ]);
  const uid = await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
    .bind(second)
    .first<string>("node_uid");
  await markNodeLost(env.DB, second, {
    expected_node_uid: uid!,
    reason: "confirmed provider loss",
  });
  await runInfrastructureAlerts(hook.env, f.region, later + 3, hook.fetcher);
  expect(await status(f, "regional_node_storage_warning")).toMatchObject({
    active: false,
  });
});

it("alarms a thin pool without room and clears it once the node has room", async () => {
  const f = await fixture(0),
    hook = receiver(),
    now = Date.now();
  const failing = () => hook.events.at(-1)!.thin_storage;
  await seedSamples(f.node, [{ at: now - 3000 }]);
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toBeUndefined();
  // The node's room rule fails: nothing starts, is created or is restored there.
  await seedSamples(f.node, [{ at: now - 2000, room: false }]);
  await runInfrastructureHealthAlerts(hook.env, now - 1000, hook.fetcher);
  expect(hook.events).toHaveLength(1);
  expect(failing()).toEqual([
    { node_id: f.node, error_code: "thin_pool_no_room" },
  ]);
  await seedSamples(f.node, [{ at: now }]);
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: false,
  });
});

it("alarms a pool that placement has closed, by its data, its metadata or the logical cap, and clears it once the pool opens", async () => {
  const f = await fixture(0),
    hook = receiver(),
    now = Date.now();
  // A pool of 100 GiB: closed from 80 GiB of data, 0.5 GiB of metadata, or 400 GiB sold.
  const closures: Partial<typeof OPEN_POOL>[] = [
    { dataUsed: 80 * GIB },
    { metadataUsed: GIB / 2 },
    { nominal: 400 * GIB },
  ];
  let at = now;
  await seedSamples(f.node, [{ at, pool: pool({}) }]);
  await runInfrastructureHealthAlerts(hook.env, at, hook.fetcher);
  expect(await status(f, "regional_node_pool_closed")).toBeUndefined();
  for (const [index, closure] of closures.entries()) {
    at += MINUTE;
    await seedSamples(f.node, [{ at, pool: pool(closure) }]);
    await runInfrastructureHealthAlerts(hook.env, at, hook.fetcher);
    const raised = hook.events.filter(
      (event) => event.kind === "regional_node_pool_closed",
    );
    expect(raised, JSON.stringify(closure)).toHaveLength(index + 1);
    expect(raised.at(-1)).toMatchObject({ node_ids: [f.node] });
    expect(await status(f, "regional_node_pool_closed")).toMatchObject({
      active: true,
    });
    at += MINUTE;
    await seedSamples(f.node, [{ at, pool: pool({}) }]);
    await runInfrastructureHealthAlerts(hook.env, at, hook.fetcher);
    expect(await status(f, "regional_node_pool_closed")).toMatchObject({
      active: false,
    });
  }
});

it("counts the storage a node has not finished against the logical cap of the alarm", async () => {
  const f = await fixture(0),
    hook = receiver(),
    now = Date.now();
  await seedSamples(f.node, [{ at: now, pool: pool({ nominal: 395 * GIB }) }]);
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "regional_node_pool_closed")).toBeUndefined();
  // A database of 5 GiB whose create the node has not finished: 400 GiB are sold, the cap.
  const created = DatabaseWithOperation.parse(
    await (await f.create("unfinished")).json(),
  );
  expect(created.database.node_id).toBe(f.node);
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(await status(f, "regional_node_pool_closed")).toMatchObject({
    active: true,
  });
});

it("alarms a node that holds databases while it reports no pool, and nothing for an empty node", async () => {
  const f = await fixture(0),
    hook = receiver(),
    now = Date.now();
  await seedSamples(f.node, [{ at: now - 5 * MINUTE }]);
  // No sample for three minutes on a node without a database: nothing to watch.
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toBeUndefined();
  await env.DB.prepare(
    `INSERT INTO databases(id,project_id,region_id,node_id,name,size_class_id,desired_state,observed_state,generation,archive_path,created_at,updated_at)
    VALUES(?,?,?,?,'holder',?,'running','ready',1,'s3://b/x',?,?)`,
  )
    .bind(
      "d" + crypto.randomUUID().replaceAll("-", "").slice(0, 19),
      f.project,
      f.region,
      f.node,
      f.size,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events.at(-1)!.thin_storage).toEqual([
    { node_id: f.node, error_code: "thin_pool_unobserved" },
  ]);
  // The node reports, but its pool could not be read.
  await seedSamples(f.node, [{ at: now + 2000, pool: null }]);
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: true,
  });
  await seedSamples(f.node, [{ at: now + 4000 }]);
  await runInfrastructureHealthAlerts(hook.env, now + 5000, hook.fetcher);
  expect(await status(f, "thin_storage_blocked")).toMatchObject({
    active: false,
  });
});

it("alarms a node that refused five wakes for awake capacity within ten minutes", async () => {
  // The refusals are summed by minute: in the middle of one, the samples a second later stay in
  // its minute, as the window's edge is a whole minute.
  const f = await fixture(0),
    hook = receiver(),
    now = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000;
  await seedSamples(f.node, [
    ...steady(now - 11 * MINUTE, 0, { refusals: 50 }),
    { at: now - 9 * MINUTE, refusals: 2 },
    { at: now - 5 * MINUTE, refusals: 2 },
    { at: now, refusals: 0 },
  ]);
  // Four inside the window; the 50 before it do not count.
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "regional_node_capacity_refusals")).toBeUndefined();
  await seedSamples(f.node, [{ at: now + 1000, refusals: 1 }]);
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toMatchObject([
    { kind: "regional_node_capacity_refusals", node_ids: [f.node] },
  ]);
  // The window moves on: ten minutes later only the last refusal is in it.
  await seedSamples(f.node, [{ at: now + 11 * MINUTE }]);
  await runInfrastructureHealthAlerts(
    hook.env,
    now + 11 * MINUTE,
    hook.fetcher,
  );
  expect(await status(f, "regional_node_capacity_refusals")).toMatchObject({
    active: false,
  });
});

it("counts the wakes a full start queue refused with those awake capacity refused", async () => {
  // A node that cannot start databases fast enough refuses wakes for capacity as one that has no
  // memory does: 2 + 3 within the window make five.
  const f = await fixture(0),
    hook = receiver(),
    now = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000;
  await seedSamples(f.node, [
    { at: now - 9 * MINUTE, refusals: 2 },
    { at: now - 5 * MINUTE, startQueueRefusals: 2 },
    { at: now, startQueueRefusals: 0 },
  ]);
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(await status(f, "regional_node_capacity_refusals")).toBeUndefined();
  await seedSamples(f.node, [{ at: now + 1000, startQueueRefusals: 1 }]);
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toMatchObject([
    { kind: "regional_node_capacity_refusals", node_ids: [f.node] },
  ]);
});

async function placed(f: Fixture, name: string) {
  const created = DatabaseWithOperation.parse(
    await (await f.create(name)).json(),
  );
  return created.database.id;
}
function volume(
  f: Fixture,
  id: string,
  at: number,
  figures: {
    used?: number;
    inodes?: number;
    unmounted?: boolean;
    generation?: number;
  } = {},
) {
  const total = 10 * GIB,
    inodesTotal = 1_000_000;
  return env.DB.prepare(
    `INSERT OR REPLACE INTO node_volumes(node_id,database_id,storage_generation,mounted,size_bytes,pool_used_bytes,
      filesystem_total_bytes,filesystem_used_bytes,inodes_total,inodes_used,observed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    f.node,
    id,
    figures.generation ?? 1,
    figures.unmounted ? 0 : 1,
    total,
    0,
    figures.unmounted ? null : total,
    figures.unmounted ? null : (figures.used ?? 0),
    figures.unmounted ? null : inodesTotal,
    figures.unmounted ? null : (figures.inodes ?? 0),
    new Date(at).toISOString(),
  );
}

it("warns at 80 % and 90 % of a volume's space or inodes, once for each level", async () => {
  const f = await fixture(),
    hook = receiver(),
    id = await placed(f, "filling"),
    now = Date.now();
  await volume(f, id, now, { used: 8 * GIB - 1, inodes: 799_999 }).run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(hook.events).toEqual([]);
  // Exactly 80 % of the space.
  await volume(f, id, now + 1000, { used: 8 * GIB }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toMatchObject([
    { kind: "database_volume_warning", database_ids: [id] },
  ]);
  // The inodes alone reach 90 %: the loud kind starts and the quiet one ends.
  await volume(f, id, now + 2000, { used: 5 * GIB, inodes: 900_000 }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 2000, hook.fetcher);
  expect(hook.events).toMatchObject([
    { kind: "database_volume_warning" },
    { kind: "database_volume_critical", database_ids: [id] },
  ]);
  expect(await status(f, "database_volume_warning")).toMatchObject({
    active: false,
  });
  // Nothing new while it stays there.
  await runInfrastructureHealthAlerts(hook.env, now + 3000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  await volume(f, id, now + 4000, { used: GIB }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 4000, hook.fetcher);
  expect(await status(f, "database_volume_critical")).toMatchObject({
    active: false,
  });
});

it("keeps a volume episode while its report is stale or its volume unmounted, and ignores old generations and deleted databases", async () => {
  const f = await fixture(),
    hook = receiver(),
    id = await placed(f, "unknown"),
    now = Date.now();
  await volume(f, id, now, { used: 9 * GIB + 1 }).run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  expect(hook.events).toMatchObject([{ kind: "database_volume_critical" }]);
  // Stale report (older than 180 s): unknown, kept.
  await runInfrastructureHealthAlerts(hook.env, now + 4 * MINUTE, hook.fetcher);
  expect(await status(f, "database_volume_critical")).toMatchObject({
    active: true,
  });
  // The volume is not mounted: no filesystem figures, kept.
  await volume(f, id, now + 4 * MINUTE, { unmounted: true }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 4 * MINUTE, hook.fetcher);
  expect(await status(f, "database_volume_critical")).toMatchObject({
    active: true,
  });
  // A volume of an older storage generation says nothing of the database.
  const other = await placed(f, "old-generation");
  await volume(f, other, now + 4 * MINUTE, {
    used: 10 * GIB,
    generation: 2,
  }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 4 * MINUTE, hook.fetcher);
  expect(
    hook.events.filter((event) => event.kind.startsWith("database_volume")),
  ).toHaveLength(1);
  // The database is deleted: its episode ends.
  await env.DB.prepare(
    "UPDATE databases SET desired_state='deleted',deleted_at=?,observed_state='deleted' WHERE id=?",
  )
    .bind(new Date(now).toISOString(), id)
    .run();
  await runInfrastructureHealthAlerts(hook.env, now + 4 * MINUTE, hook.fetcher);
  expect(await status(f, "database_volume_critical")).toMatchObject({
    active: false,
  });
});

it("announces a volume that fails after another one did", async () => {
  const f = await fixture(),
    hook = receiver(),
    first = await placed(f, "first"),
    second = await placed(f, "second"),
    now = Date.now();
  await volume(f, first, now, { used: 9 * GIB }).run();
  await volume(f, second, now, { used: GIB }).run();
  await runInfrastructureHealthAlerts(hook.env, now, hook.fetcher);
  await volume(f, second, now + 1000, { used: 10 * GIB }).run();
  await runInfrastructureHealthAlerts(hook.env, now + 1000, hook.fetcher);
  expect(hook.events).toHaveLength(2);
  expect(new Set(hook.events[1]!.database_ids)).toEqual(
    new Set([first, second]),
  );
});

it("cannot arm or clear a node warning from a superseded concurrent read", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800_000 }),
    at = Date.now();
  const fill = (percent: number) =>
    pool({ dataUsed: Math.floor((OPEN_POOL.dataTotal * percent) / 100) });
  // The older run pauses after its node read while a newer sample is recorded and evaluated.
  const race = async (older: number, newer: number, offset: number) => {
    await seedSamples(f.node, [{ at: at + offset, pool: fill(older) }]);
    await stalled(
      (db) =>
        runInfrastructureAlerts({ ...env, DB: db }, f.region, at + offset),
      async () => {
        await seedSamples(f.node, [{ at: at + offset + 1, pool: fill(newer) }]);
        await runInfrastructureAlerts(env, f.region, at + offset + 1);
      },
    );
  };
  await race(90, 70, 0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  await race(70, 90, 2);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_storage_warning", active: true },
  ]);
});

it("cannot arm or deliver a stalled read naming a node that no longer exceeds", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800_000 }),
    second = await addNode(f.region, 0),
    hook = receiver(),
    at = Date.now();
  const full = pool({ dataUsed: 95 * GIB }),
    quiet = pool({ dataUsed: 10 * GIB });
  await seedSamples(f.node, [{ at, pool: pool({ dataUsed: 90 * GIB }) }]);
  await seedSamples(second, [{ at, pool: quiet }]);
  // Later runs warn about the second node and clear its episode while the stalled run holds its read.
  await stalled(
    (db) =>
      runInfrastructureAlerts(
        { ...hook.env, DB: db },
        f.region,
        at,
        hook.fetcher,
      ),
    async () => {
      await seedSamples(f.node, [{ at: at + 1, pool: quiet }]);
      await seedSamples(second, [{ at: at + 1, pool: full }]);
      await runInfrastructureAlerts(hook.env, f.region, at + 1, hook.fetcher);
      await seedSamples(second, [{ at: at + 2, pool: quiet }]);
      await runInfrastructureAlerts(hook.env, f.region, at + 2, hook.fetcher);
      await seedSamples(second, [{ at: at + 3, pool: full }]);
    },
  );
  expect(hook.events).toMatchObject([{ node_ids: [second] }]);
  await runInfrastructureAlerts(hook.env, f.region, at + 3, hook.fetcher);
  expect(hook.events).toMatchObject([
    { node_ids: [second] },
    { node_ids: [second], occurred_at: new Date(at + 3).toISOString() },
  ]);
});
