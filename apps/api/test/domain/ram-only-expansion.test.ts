// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { runNodeCapacity } from "../../src/domain/node-capacity.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);

it("keeps CPU-unplaceable demand waiting below the RAM threshold even with a finite active purchase policy", async () => {
  const f = await fixture(8192, 40);
  const uid = crypto.randomUUID();
  const provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  const capacity = 8 * 1024 ** 3;
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=?,allocatable_cpu_millicores=200 WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  const geometry = {
    region_id: f.region,
    max_nodes: 2,
    placement_mode: "actual_ram" as const,
    ram_expansion_threshold_ppm: 800_000,
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  };
  await configureNodeRegionPolicy(env.DB, {
    ...geometry,
    purchases_enabled: false,
    order: null,
  });
  const now = Date.now();
  for (let minute = 9; minute >= 0; minute--) {
    const time = now - minute * 60_000;
    const observed_at = new Date(time).toISOString();
    expect(
      await recordNodeMemoryObservation(
        env.DB,
        f.region,
        {
          node_id: f.node,
          node_uid: uid,
          provider_instance_id: provider,
          memory: {
            node_uid: uid,
            observed_at,
            capacity_memory_bytes: capacity,
            working_set_bytes: capacity * 0.75,
            available_bytes: capacity * 0.25,
            memory_pressure: false,
          },
        },
        observed_at,
        time,
      ),
    ).toBe(true);
  }
  const pending = DatabaseWithOperation.parse(
    await (await f.create("cpu-pending")).json(),
  );
  expect(
    await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
      .bind(pending.database.id)
      .first("node_id"),
  ).toBeNull();
  const order = {
    product_id: "V159",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "Local D1 test fixture",
  };
  await configureNodeRegionPolicy(env.DB, {
    ...geometry,
    purchases_enabled: true,
    order,
    standing_cost_profile: {
      id: crypto.randomUUID(),
      order,
      owner_reference: "local-test-only-finite-approval",
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      currency: "EUR",
      monthly_amount: "1.0000",
      setup_amount: "0.0000",
      max_orders: 1,
      max_total_monthly_amount: "1.0000",
      max_total_setup_amount: "0.0000",
    },
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  expect(
    await env.DB.prepare(
      "SELECT memory_window_valid,memory_utilization_ppm,memory_expansion_triggered_at FROM nodes WHERE id=?",
    )
      .bind(f.node)
      .first(),
  ).toEqual({
    memory_window_valid: 1,
    memory_utilization_ppm: 750000,
    memory_expansion_triggered_at: null,
  });
  // The dry check first reproduces a hidden purchase path without starting a Workflow.
  expect(await runNodeCapacity(env, f.region, true)).toMatchObject({
    action: "capacity_wait",
    operation_id: null,
  });
  expect(await runNodeCapacity(env, f.region)).toMatchObject({
    action: "capacity_wait",
    operation_id: null,
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_standing_approvals WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_provider_mutations WHERE operation_id IN(SELECT operation_id FROM node_additions WHERE region_id=?)",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
});
