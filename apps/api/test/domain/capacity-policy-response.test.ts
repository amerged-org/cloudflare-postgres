// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { NodeCapacityPolicy } from "../../src/platform/nodes.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

it("accepts automatic paid orders with no RAM threshold and refuses the removed fields", async () => {
  const f = await fixture();
  const order = {
    product_id: "operator-product",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1,
    location: "Test",
  };
  const policy = { region_id: f.region, order, purchases_enabled: true };
  // Neither autoscale nor purchases need a threshold: the capacity cron decides from placement.
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    autoscale_enabled: true,
  });
  const path = `/v1/regions/${f.region}/capacity-policy`;
  expect(await (await request(path, f.admin)).json()).toMatchObject({
    purchases_enabled: true,
    autoscale_enabled: true,
  });
  const manual = await request(path, f.admin, "PUT", {
    ...policy,
    autoscale_enabled: false,
  });
  expect(manual.status).toBe(200);
  expect(await manual.json()).toMatchObject({
    purchases_enabled: true,
    autoscale_enabled: false,
  });
  for (const removed of [
    { ram_expansion_threshold_ppm: 760000 },
    { ram_warning_threshold_ppm: 800000 },
    { placement_mode: "reserved" },
    { postgres_memory_request_mib: 128 },
  ]) {
    const refused = await request(path, f.admin, "PUT", {
      ...policy,
      ...removed,
    });
    expect(refused.status, JSON.stringify(removed)).toBe(400);
  }
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
    node_ram_warning_threshold_ppm: null,
    node_cpu_warning_threshold_ppm: null,
    node_storage_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 4,
    node_ram_warning_threshold_ppm: 900001,
    node_cpu_warning_threshold_ppm: 850001,
    node_storage_warning_threshold_ppm: 800001,
    cap_warning_enabled: true,
  });
  await configureNodeRegionPolicy(env.DB, { region_id: f.region });
  expect(await (await request(path, f.admin)).json()).toMatchObject({
    max_nodes: 4,
    node_ram_warning_threshold_ppm: 900001,
    node_cpu_warning_threshold_ppm: 850001,
    node_storage_warning_threshold_ppm: 800001,
    cap_warning_enabled: true,
  });
  const removed = await request(path, f.admin, "PUT", {
    region_id: f.region,
    max_nodes: null,
    node_ram_warning_threshold_ppm: null,
    node_cpu_warning_threshold_ppm: null,
    node_storage_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
  expect(removed.status).toBe(200);
  expect(await removed.json()).toMatchObject({
    max_nodes: null,
    node_ram_warning_threshold_ppm: null,
    node_cpu_warning_threshold_ppm: null,
    node_storage_warning_threshold_ppm: null,
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
    maximum_database_memory_mib: null,
    standing_cost_profile: null,
    node_ram_warning_threshold_ppm: 900000,
    node_cpu_warning_threshold_ppm: 850000,
    node_storage_warning_threshold_ppm: 800000,
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
    maximum_database_memory_mib: null,
    standing_cost_profile: null,
    node_ram_warning_threshold_ppm: null,
    node_cpu_warning_threshold_ppm: null,
    node_storage_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
});
