// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import { NodeCapacityPolicy } from "../../src/platform/nodes.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(cleanupFixtures);

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
  });
});
