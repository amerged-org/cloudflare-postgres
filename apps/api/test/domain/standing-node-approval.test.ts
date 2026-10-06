// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  approveStandingNodePurchase,
  claimNodeDispatch,
  configureNodeRegionPolicy,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";

afterEach(cleanupFixtures);
async function setup() {
  const f = await fixture();
  const order = {
    product_id: crypto.randomUUID(),
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "fixture location",
  };
  const profile = {
    id: crypto.randomUUID(),
    order,
    owner_reference: "owner-approved-profile",
    approved_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    currency: "EUR",
    monthly_amount: "1.0000",
    setup_amount: "0.0000",
    max_orders: 3,
    max_total_monthly_amount: "1.0000",
    max_total_setup_amount: "0.0000",
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: true,
    order,
    standing_cost_profile: profile,
  });
  const reserve = () =>
    reserveNodeAddition(env.DB, {
      request_key: crypto.randomUUID(),
      request: { region_id: f.region, mode: "order", order },
    });
  return { ...f, profile, reserve };
}
it("atomically derives one fresh exact-intent approval within owner monetary caps and never dispatches twice", async () => {
  const f = await setup(),
    additions = await Promise.all([f.reserve(), f.reserve()]);
  const results = await Promise.allSettled(
    additions.map((a) =>
      approveStandingNodePurchase(env.DB, a.intent.operation_id),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const approved = results.find((r) => r.status === "fulfilled");
  if (!approved || approved.status !== "fulfilled")
    throw new Error("approval missing");
  const a = approved.value;
  expect(a.approval).toMatchObject({
    intent_hash: a.intent_hash,
    standing_profile_id: f.profile.id,
    owner_reference: f.profile.owner_reference,
    monthly_amount: "1.0000",
    setup_amount: "0.0000",
    currency: "EUR",
  });
  expect(
    Date.parse(a.approval!.expires_at) - Date.parse(a.approval!.approved_at),
  ).toBeLessThanOrEqual(600_000);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM node_standing_approvals WHERE region_id=?",
    )
      .bind(f.region)
      .first("count(*)"),
  ).toBe(1);
  const claims = await Promise.all([
    claimNodeDispatch(env.DB, a.intent.operation_id, a.revision),
    claimNodeDispatch(env.DB, a.intent.operation_id, a.revision),
  ]);
  expect(claims.filter((c) => c.claimed)).toHaveLength(1);
});
it("refuses a revoked or changed standing profile at irreversible dispatch", async () => {
  const f = await setup(),
    a = await approveStandingNodePurchase(
      env.DB,
      (await f.reserve()).intent.operation_id,
    );
  await env.DB.prepare(
    "UPDATE node_region_policies SET standing_cost_profile_hash=? WHERE region_id=?",
  )
    .bind("0".repeat(64), f.region)
    .run();
  await expect(
    claimNodeDispatch(env.DB, a.intent.operation_id, a.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  expect(
    await env.DB.prepare(
      "SELECT dispatch_request_id FROM node_additions WHERE operation_id=?",
    )
      .bind(a.intent.operation_id)
      .first("dispatch_request_id"),
  ).toBeNull();
});
it("requires finite profile expiry and exact SKU/location/term binding", async () => {
  const f = await setup();
  await expect(
    configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 5,
      purchases_enabled: true,
      order: f.profile.order,
      standing_cost_profile: {
        ...f.profile,
        order: { ...f.profile.order, product_id: "another-sku" },
      },
    }),
  ).rejects.toThrow();
  const expired = {
    ...f.profile,
    approved_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: true,
    order: f.profile.order,
    standing_cost_profile: expired,
  });
  await expect(
    approveStandingNodePurchase(
      env.DB,
      (await f.reserve()).intent.operation_id,
    ),
  ).rejects.toMatchObject({ code: "approval_required" });
});
it("refreshes an undispatched expired derivative from the same active owner profile without consuming its caps twice", async () => {
  const f = await setup();
  const a = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  const expired = {
    ...a.approval!,
    approved_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };
  await env.DB.prepare(
    "UPDATE node_additions SET approval_json=json_set(approval_json,'$.approved_at',?,'$.expires_at',?) WHERE operation_id=?",
  )
    .bind(expired.approved_at, expired.expires_at, a.intent.operation_id)
    .run();
  const refreshed = await approveStandingNodePurchase(
    env.DB,
    a.intent.operation_id,
  );
  expect(Date.parse(refreshed.approval!.expires_at)).toBeGreaterThan(
    Date.now(),
  );
  expect(refreshed.revision).toBe(a.revision + 1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) FROM node_standing_approvals WHERE region_id=?",
    )
      .bind(f.region)
      .first("count(*)"),
  ).toBe(1);
});
it("keeps an owner profile's order count across profile updates", async () => {
  const f = await setup();
  await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 5,
    purchases_enabled: true,
    order: f.profile.order,
    standing_cost_profile: {
      ...f.profile,
      max_orders: 1,
      max_total_monthly_amount: "10.0000",
      expires_at: new Date(Date.now() + 7_200_000).toISOString(),
    },
  });
  await expect(
    approveStandingNodePurchase(
      env.DB,
      (await f.reserve()).intent.operation_id,
    ),
  ).rejects.toMatchObject({ code: "approval_required" });
});
