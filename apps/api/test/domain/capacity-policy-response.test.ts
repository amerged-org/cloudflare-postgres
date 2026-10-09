// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { NodeCapacityPolicy } from "../../src/platform/nodes.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

it("requires an effective RAM threshold for automatic paid orders while preserving adoption and manual orders", async () => {
  const f = await fixture();
  const order = {
    product_id: "operator-product",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1,
    location: "Test",
  };
  const policy = { region_id: f.region, order, purchases_enabled: true };
  await expect(
    configureNodeRegionPolicy(env.DB, { ...policy, autoscale_enabled: true }),
  ).rejects.toMatchObject({ code: "configuration_required" });
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    autoscale_enabled: false,
  });
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    purchases_enabled: false,
    autoscale_enabled: true,
    adopt_instance_ids: ["123"],
  });
  await expect(configureNodeRegionPolicy(env.DB, policy)).rejects.toMatchObject(
    {
      code: "configuration_required",
    },
  );
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    ram_expansion_threshold_ppm: 830001,
  });
  await configureNodeRegionPolicy(env.DB, policy);
  const path = `/v1/regions/${f.region}/capacity-policy`;
  expect(await (await request(path, f.admin)).json()).toMatchObject({
    purchases_enabled: true,
    autoscale_enabled: true,
    ram_expansion_threshold_ppm: 830001,
  });
  await expect(
    configureNodeRegionPolicy(env.DB, {
      ...policy,
      ram_expansion_threshold_ppm: null,
    }),
  ).rejects.toMatchObject({ code: "configuration_required" });
  const manual = await request(path, f.admin, "PUT", {
    ...policy,
    ram_expansion_threshold_ppm: null,
  });
  expect(manual.status).toBe(200);
  expect(await manual.json()).toMatchObject({
    purchases_enabled: true,
    autoscale_enabled: false,
    ram_expansion_threshold_ppm: null,
  });
});

it("fences omitted autoscale state so concurrent settings cannot enable thresholdless paid orders", async () => {
  const f = await fixture();
  const order = {
    product_id: "operator-product",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1,
    location: "Test",
  };
  await configureNodeRegionPolicy(env.DB, { region_id: f.region, order });
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT ram_expansion_threshold_ppm"))
            return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first() {
                  const result = await bound.first();
                  await configureNodeRegionPolicy(env.DB, {
                    region_id: f.region,
                    order,
                    autoscale_enabled: true,
                    purchases_enabled: false,
                  });
                  return result;
                },
              };
            },
          } as D1PreparedStatement;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    configureNodeRegionPolicy(database, {
      region_id: f.region,
      order,
      purchases_enabled: true,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    await env.DB.prepare(
      "SELECT purchases_enabled,autoscale_enabled,ram_expansion_threshold_ppm FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    purchases_enabled: 0,
    autoscale_enabled: 1,
    ram_expansion_threshold_ppm: null,
  });
});

it("keeps fresh purchasing and warnings off and preserves omitted optional capacity settings", async () => {
  const f = await fixture();
  const path = `/v1/regions/${f.region}/capacity-policy`;
  const created = await request(path, f.admin, "PUT", { region_id: f.region });
  expect(created.status).toBe(200);
  expect(await created.json()).toMatchObject({
    max_nodes: null,
    purchases_enabled: false,
    autoscale_enabled: false,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 4,
    ram_expansion_threshold_ppm: 830001,
    ram_warning_threshold_ppm: 790001,
    cap_warning_enabled: true,
  });
  await configureNodeRegionPolicy(env.DB, { region_id: f.region });
  expect(await (await request(path, f.admin)).json()).toMatchObject({
    max_nodes: 4,
    ram_expansion_threshold_ppm: 830001,
    ram_warning_threshold_ppm: 790001,
    cap_warning_enabled: true,
  });
  const removed = await request(path, f.admin, "PUT", {
    region_id: f.region,
    max_nodes: null,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({
    max_nodes: null,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
});

it("returns the exact public capacity policy from PUT and GET after persisting installation settings", async () => {
  const f = await fixture();
  const policy = {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "reserved",
    maximum_database_memory_mib: null,
    postgres_memory_request_mib: null,
    standing_cost_profile: null,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
    autoscale_enabled: false,
    adopt_instance_ids: [
      String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
    ],
  };
  const path = `/v1/regions/${f.region}/capacity-policy`;
  const put = await request(path, f.admin, "PUT", policy);
  const get = await request(path, f.admin);
  expect({ put: put.status, get: get.status }).toEqual({ put: 200, get: 200 });
  expect(NodeCapacityPolicy.parse(await put.json())).toEqual(policy);
  expect(NodeCapacityPolicy.parse(await get.json())).toEqual(policy);
  expect(
    await env.DB.prepare(
      "SELECT purchases_enabled,order_config,autoscale_enabled,adopt_instance_ids FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    purchases_enabled: 0,
    order_config: null,
    autoscale_enabled: 0,
    adopt_instance_ids: JSON.stringify(policy.adopt_instance_ids),
  });
});

it("preserves execution settings for legacy policy callers and applies explicit changes together", async () => {
  const f = await fixture();
  const policy = {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  };
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    autoscale_enabled: true,
    adopt_instance_ids: ["123"],
  });
  await configureNodeRegionPolicy(env.DB, { ...policy, max_nodes: 3 });
  expect(
    await env.DB.prepare(
      "SELECT max_nodes,autoscale_enabled,adopt_instance_ids FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({
    max_nodes: 3,
    autoscale_enabled: 1,
    adopt_instance_ids: '["123"]',
  });
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    max_nodes: 4,
    autoscale_enabled: false,
    adopt_instance_ids: [],
  });
  expect(
    await env.DB.prepare(
      "SELECT max_nodes,autoscale_enabled,adopt_instance_ids FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first(),
  ).toEqual({ max_nodes: 4, autoscale_enabled: 0, adopt_instance_ids: "[]" });
});

it("maps stored order JSON and enabled booleans without exposing persistence columns", async () => {
  const f = await fixture();
  const order = {
    product_id: crypto.randomUUID(),
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "fixture location",
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: true,
    order,
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  const response = await request(
    `/v1/regions/${f.region}/capacity-policy`,
    f.admin,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: true,
    order,
    autoscale_enabled: true,
    adopt_instance_ids: [],
    placement_mode: "reserved",
    maximum_database_memory_mib: null,
    postgres_memory_request_mib: null,
    standing_cost_profile: null,
    ram_expansion_threshold_ppm: null,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
});
