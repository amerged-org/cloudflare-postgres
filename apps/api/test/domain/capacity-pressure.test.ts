// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { CapacityAlertPolicy } from "@pgcf/contracts/nodes";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  infrastructureAlertStatus,
  runInfrastructureAlerts,
} from "../../src/domain/infrastructure-alerts.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import {
  forgetSamples,
  GIB,
  OPEN_POOL,
  seedSamples,
  steady,
} from "./node-samples.ts";

afterEach(cleanupFixtures);
const minute = 60_000;
async function setup() {
  const f = await fixture(0);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    capacity_alert_policy: {},
  });
  return f;
}
it("warns from a new node's latest sample and clears current pressure without waiting for an average", async () => {
  const f = await setup(),
    at = Date.now();
  await seedSamples(f.node, [{ at, ramPpm: 900_000, cpuPpm: 900_000 }]);
  await runInfrastructureAlerts(env, f.region, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_capacity_warning", active: true },
  ]);
  // Stale readings do not prove recovery.
  await runInfrastructureAlerts(env, f.region, at + 4 * minute);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]!.active).toBe(
    true,
  );
  // Even with high history, the latest fresh current readings govern the warning hysteresis.
  await seedSamples(
    f.node,
    steady(at + 35 * minute, 30, { ramPpm: 900_000, cpuPpm: 900_000 }),
  );
  await seedSamples(f.node, [
    { at: at + 36 * minute, ramPpm: 640_000, cpuPpm: 640_000 },
  ]);
  await runInfrastructureAlerts(env, f.region, at + 36 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => !row.active,
    ),
  ).toBe(true);
  // Low historical averages must not hide a new spike either.
  await forgetSamples(f.node);
  await seedSamples(
    f.node,
    steady(at + 70 * minute, 30, { ramPpm: 100_000, cpuPpm: 100_000 }),
  );
  await seedSamples(f.node, [{ at: at + 71 * minute, cpuPpm: 800_000 }]);
  await runInfrastructureAlerts(env, f.region, at + 71 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).find(
      (row) => row.kind === "regional_node_capacity_warning",
    )!.active,
  ).toBe(true);
});
it("warns at 70%, requires 30 measured minutes at 75%, and clears below 65% without ordering or moving", async () => {
  const f = await setup(),
    at = Date.now();
  await seedSamples(f.node, steady(at, 10, { ramPpm: 700_000 }));
  await runInfrastructureAlerts(env, f.region, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_capacity_warning", active: true },
  ]);
  await forgetSamples(f.node);
  await seedSamples(f.node, steady(at + 30 * minute, 29, { ramPpm: 750_000 }));
  await runInfrastructureAlerts(env, f.region, at + 30 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).find(
      (row) => row.kind === "regional_node_capacity_action",
    ),
  ).toBeUndefined();
  await seedSamples(f.node, [{ at: at + 31 * minute, ramPpm: 750_000 }]);
  await runInfrastructureAlerts(env, f.region, at + 31 * minute);
  const armed = await infrastructureAlertStatus(env.DB, f.region);
  expect(armed).toHaveLength(2);
  expect(armed.every((row) => row.active)).toBe(true);
  await forgetSamples(f.node);
  await seedSamples(f.node, steady(at + 62 * minute, 30, { ramPpm: 660_000 }));
  await runInfrastructureAlerts(env, f.region, at + 62 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => row.active,
    ),
  ).toBe(true);
  await runInfrastructureAlerts(env, f.region, at + 66 * minute); // stale, not recovered
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => row.active,
    ),
  ).toBe(true);
  await forgetSamples(f.node);
  await seedSamples(f.node, steady(at + 100 * minute, 30, { ramPpm: 640_000 }));
  await runInfrastructureAlerts(env, f.region, at + 100 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => !row.active,
    ),
  ).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM database_moves WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
});
it("does not use old placement peaks or gaps as current sustained pressure", async () => {
  const f = await setup(),
    at = Date.now();
  await seedSamples(
    f.node,
    steady(at - 86_400_000, 30, { ramPpm: 950_000, cpuPpm: 950_000 }),
  );
  await seedSamples(
    f.node,
    steady(at, 30, { ramPpm: 100_000, cpuPpm: 100_000 }),
  );
  await runInfrastructureAlerts(env, f.region, at);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  await forgetSamples(f.node);
  const gap = steady(at + 60 * minute, 30, { cpuPpm: 800_000 }).filter(
    (_, index) => index !== 15,
  );
  await seedSamples(f.node, gap);
  await runInfrastructureAlerts(env, f.region, at + 60 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).map((row) => row.kind),
  ).toEqual(["regional_node_capacity_warning"]);
});

it("clears a sustained action from the latest sample even while its minute average is still high", async () => {
  const f = await setup(),
    at = Math.floor(Date.now() / minute) * minute;
  await seedSamples(
    f.node,
    steady(at, 30, { ramPpm: 900_000, cpuPpm: 900_000 }),
  );
  await runInfrastructureAlerts(env, f.region, at);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).filter(
      (row) => row.active,
    ),
  ).toHaveLength(2);
  await seedSamples(f.node, [
    { at: at + 30_000, ramPpm: 640_000, cpuPpm: 640_000 },
  ]);
  await runInfrastructureAlerts(env, f.region, at + 30_000);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => !row.active,
    ),
  ).toBe(true);
});
it("tracks metadata at 40/45/35 separately from data and respects disabling and threshold validation", async () => {
  const f = await setup(),
    at = Date.now();
  await seedSamples(
    f.node,
    steady(at, 30, {
      pool: { ...OPEN_POOL, metadataUsed: Math.ceil(GIB * 0.46) },
    }),
  );
  await runInfrastructureAlerts(env, f.region, at);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => row.active,
    ),
  ).toBe(true);
  const payload = JSON.parse(
    (await env.DB.prepare(
      "SELECT payload FROM infrastructure_alerts WHERE region_id=? AND kind='regional_node_capacity_action'",
    )
      .bind(f.region)
      .first<string>("payload"))!,
  );
  expect(payload.capacity).toMatchObject([
    { resource: "metadata", threshold_ppm: 450_000 },
  ]);
  await forgetSamples(f.node);
  await seedSamples(
    f.node,
    steady(at + 31 * minute, 30, {
      pool: { ...OPEN_POOL, metadataUsed: Math.floor(GIB * 0.34) },
    }),
  );
  await runInfrastructureAlerts(env, f.region, at + 31 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => !row.active,
    ),
  ).toBe(true);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    capacity_alert_policy: null,
  });
  await seedSamples(f.node, steady(at + 62 * minute, 30, { ramPpm: 950_000 }));
  await runInfrastructureAlerts(env, f.region, at + 62 * minute);
  expect(
    (await infrastructureAlertStatus(env.DB, f.region)).every(
      (row) => !row.active,
    ),
  ).toBe(true);
  expect(
    CapacityAlertPolicy.safeParse({ clear_threshold_ppm: 800_000 }).success,
  ).toBe(false);
});
