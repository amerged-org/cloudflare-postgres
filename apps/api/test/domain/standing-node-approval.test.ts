// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  approveStandingNodePurchase,
  claimNodeDispatch,
  configureNodeRegionPolicy,
  reserveNodeAddition,
  markNodeDispatchUnknown,
  recordNodeReceipt,
  approveNodePurchase,
} from "../../src/domain/node-state.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { runNodeCapacityCron } from "../../src/domain/node-capacity.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

/**
 * A region whose standing profile carries a trigger: it approves only the orders the capacity cron
 * reserves (`capacity-headroom-`) while autoscale is on, at no stated price or ceiling.
 */
async function autoAuthority(trigger = "ram_76_percent") {
  const f = await fixture(8192, 60);
  const order = {
    product_id: "V159",
    provider_region: "EU",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "European Union",
  };
  const profile = {
    id: crypto.randomUUID(),
    trigger,
    order,
    owner_reference: "owner-automatic-orders-no-ceilings",
    approved_at: new Date().toISOString(),
    expires_at: null,
    currency: null,
    monthly_amount: null,
    setup_amount: null,
    max_orders: null,
    max_total_monthly_amount: null,
    max_total_setup_amount: null,
  };
  const policy = {
    region_id: f.region,
    max_nodes: null,
    purchases_enabled: true,
    autoscale_enabled: true,
    order,
    maximum_database_memory_mib: 4096,
    standing_cost_profile: profile,
  };
  await configureNodeRegionPolicy(env.DB, policy);
  let hour = 0;
  return {
    ...f,
    order,
    profile,
    policy,
    reserve: (exclusive = true) =>
      reserveNodeAddition(env.DB, {
        request_key: `capacity-headroom-${f.region}-${++hour}`,
        request: { region_id: f.region, mode: "order", order },
        ...(exclusive ? { exclusive_region_addition: true } : {}),
      }),
  };
}

it("derives exact trigger authority without invented price, expiry or node ceilings and never dispatches twice", async () => {
  const f = await autoAuthority();
  const reserved = await f.reserve();
  const approved = await approveStandingNodePurchase(
    env.DB,
    reserved.intent.operation_id,
  );
  expect(approved.approval).toMatchObject({
    trigger: "ram_76_percent",
    monthly_amount: null,
    setup_amount: null,
    currency: null,
    standing_profile_id: f.profile.id,
  });
  expect(
    await env.DB.prepare(
      "SELECT max_nodes FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first("max_nodes"),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT monthly_units,setup_units FROM node_standing_approvals WHERE operation_id=?",
    )
      .bind(reserved.intent.operation_id)
      .first(),
  ).toEqual({ monthly_units: null, setup_units: null });
  const results = await Promise.all([
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ]);
  expect(results.filter((row) => row.claimed)).toHaveLength(1);
});

it("resolves an uncertain order after the purchase switches change without a second purchase", async () => {
  const f = await autoAuthority();
  const reserved = await f.reserve();
  const dispatch = await claimNodeDispatch(
    env.DB,
    reserved.intent.operation_id,
    reserved.revision,
  );
  if (!dispatch.claimed) throw new Error("dispatch missing");
  const unknown = await markNodeDispatchUnknown(
    env.DB,
    reserved.intent.operation_id,
    dispatch.addition.revision,
  );
  await configureNodeRegionPolicy(env.DB, {
    ...f.policy,
    purchases_enabled: false,
    autoscale_enabled: false,
  });
  expect(
    await claimNodeDispatch(
      env.DB,
      unknown.intent.operation_id,
      unknown.revision,
    ),
  ).toMatchObject({
    claimed: false,
    addition: { status: "unknown", dispatch_request_id: dispatch.request_id },
  });
  const resolved = await recordNodeReceipt(
    env.DB,
    unknown.intent.operation_id,
    unknown.revision,
    {
      provider_instance_id: String(
        100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]!,
      ),
      request_id: dispatch.request_id,
      reference: "provider-status-resolution",
      received_at: new Date().toISOString(),
    },
  );
  expect(resolved.status).toBe("provider_bound");
  expect(resolved.dispatch_request_id).toBe(dispatch.request_id);
});

it("holds one active automatic expansion per region even when a direct caller omits exclusive selection", async () => {
  const f = await autoAuthority();
  await f.reserve();
  await expect(f.reserve(false)).rejects.toMatchObject({
    code: "capacity_unavailable",
  });
});

it("refuses to reserve an automatic purchase while purchases are off, though autoscale is on", async () => {
  const f = await autoAuthority();
  await env.DB.prepare(
    "UPDATE node_region_policies SET purchases_enabled=0 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  // The switches are read at the reservation itself, so a purchase turned off after the capacity
  // cron read the policy still reserves nothing that purchases would dispatch when turned on again.
  await expect(f.reserve()).rejects.toMatchObject({
    code: "capacity_unavailable",
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("n"),
  ).toBe(0);
});

it("revokes an undispatched automatic purchase when automatic expansion is disabled", async () => {
  const f = await autoAuthority();
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=0 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  expect(
    await env.DB.prepare(
      "SELECT dispatch_request_id FROM node_additions WHERE operation_id=?",
    )
      .bind(approved.intent.operation_id)
      .first("dispatch_request_id"),
  ).toBeNull();
});

it("atomically updates automatic expansion with owner policy so a queued order cannot dispatch between policy writes", async () => {
  const f = await autoAuthority();
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  const prepare = env.DB.prepare.bind(env.DB);
  let interleavedClaim: boolean | undefined;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith("UPDATE node_region_policies SET autoscale_enabled="))
      return statement;
    return {
      bind: (...bindings: unknown[]) => ({
        run: async () => {
          interleavedClaim = (
            await claimNodeDispatch(
              env.DB,
              approved.intent.operation_id,
              approved.revision,
            )
          ).claimed;
          return statement.bind(...bindings).run();
        },
      }),
    } as D1PreparedStatement;
  });
  const result = await request(
    `/v1/regions/${f.region}/capacity-policy`,
    f.admin,
    "PUT",
    { ...f.policy, autoscale_enabled: false, adopt_instance_ids: [] },
  );
  expect(result.status).toBe(200);
  expect(interleavedClaim ?? false).toBe(false);
  expect(
    await env.DB.prepare(
      "SELECT autoscale_enabled FROM node_region_policies WHERE region_id=?",
    )
      .bind(f.region)
      .first("autoscale_enabled"),
  ).toBe(0);
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
});

it("preserves individually cost-approved manual bootstrap without granting it trigger authority", async () => {
  const f = await autoAuthority();
  const initial = await reserveNodeAddition(env.DB, {
    request_key: "owner-initial-bootstrap",
    request: { region_id: f.region, mode: "order", order: f.order },
  });
  await expect(
    approveStandingNodePurchase(env.DB, initial.intent.operation_id),
  ).rejects.toMatchObject({ code: "approval_required" });
  const manual = await approveNodePurchase(
    env.DB,
    initial.intent.operation_id,
    initial.revision,
    {
      intent_hash: initial.intent_hash,
      owner_reference: "explicit-fixture-cost-approval",
      approved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      monthly_amount: "1.0000",
      setup_amount: "0.0000",
      currency: "EUR",
      term_months: 1,
      location: f.order.location,
    },
  );
  expect(
    (
      await claimNodeDispatch(
        env.DB,
        manual.intent.operation_id,
        manual.revision,
      )
    ).claimed,
  ).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_standing_approvals WHERE operation_id=?",
    )
      .bind(manual.intent.operation_id)
      .first("count"),
  ).toBe(0);
});
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

it("revalidates a changed profile on the same undispatched intent without a second ledger charge", async () => {
  const f = await autoAuthority();
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  const operationId = approved.intent.operation_id;
  await configureNodeRegionPolicy(env.DB, {
    ...f.policy,
    autoscale_enabled: false,
  });
  await expect(
    claimNodeDispatch(env.DB, operationId, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  // The owner states the profile again under another reference: its hash changes with it.
  await configureNodeRegionPolicy(env.DB, {
    ...f.policy,
    standing_cost_profile: {
      ...f.profile,
      owner_reference: "owner-automatic-orders-restated",
    },
  });
  const dispatched = await claimNodeDispatch(
    env.DB,
    operationId,
    approved.revision,
  );
  expect(dispatched.claimed).toBe(true);
  expect(dispatched.addition.intent).toEqual(approved.intent);
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM node_standing_approvals WHERE operation_id=?",
    )
      .bind(operationId)
      .first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT a.profile_hash=p.standing_cost_profile_hash current FROM node_standing_approvals a JOIN node_region_policies p ON p.region_id=a.region_id WHERE a.operation_id=?",
    )
      .bind(operationId)
      .first("current"),
  ).toBe(1);
});

it("approves the second trigger name the same way and refuses it once autoscale is off", async () => {
  const f = await autoAuthority("regional_actual_ram");
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  expect(approved.approval?.trigger).toBe("regional_actual_ram");
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=0 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
});

it("keeps an intent whose standing authority is gone waiting and completes capacity checks for other regions", async () => {
  const f = await autoAuthority();
  const other = await fixture();
  await configureNodeRegionPolicy(env.DB, { region_id: other.region });
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  await configureNodeRegionPolicy(env.DB, {
    ...f.policy,
    autoscale_enabled: false,
    standing_cost_profile: {
      ...f.profile,
      owner_reference: "owner-automatic-orders-restated",
    },
  });
  const start = vi
    .spyOn(env.ADD_NODE, "create")
    .mockResolvedValue({} as Awaited<ReturnType<typeof env.ADD_NODE.create>>);
  const decisions = await runNodeCapacityCron(env);
  expect(decisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        region_id: f.region,
        action: "waiting_for_approval",
        operation_id: approved.intent.operation_id,
      }),
      expect.objectContaining({ region_id: other.region }),
    ]),
  );
  expect(start).not.toHaveBeenCalled();
});

/** The same digest, built apart from the code under test: SHA-256 of the key-sorted JSON. */
async function profileDigest(value: unknown): Promise<string> {
  const canonical = (v: unknown): string =>
    v === null || typeof v !== "object"
      ? JSON.stringify(v)
      : Array.isArray(v)
        ? `[${v.map(canonical).join(",")}]`
        : `{${Object.keys(v)
            .sort()
            .map(
              (key) =>
                `${JSON.stringify(key)}:${canonical((v as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical(value)),
    ),
  );
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

it("keeps the hash an earlier release stored for a profile at the 76 % threshold: the digest of the profile alone", async () => {
  const f = await autoAuthority();
  const stored = await env.DB.prepare(
    "SELECT standing_cost_profile_hash h FROM node_region_policies WHERE region_id=?",
  )
    .bind(f.region)
    .first<{ h: string }>();
  expect(stored!.h).toBe(await profileDigest(f.profile));
  // Migration 0082 leaves this hash as it is, so an order is approved without a new policy write.
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  expect(approved.approval).toMatchObject({
    standing_profile_id: f.profile.id,
  });
});

it("approves an order after the capacity policy is stored again over a hash that migration 0082 cleared", async () => {
  const f = await autoAuthority();
  // 0082 clears the hash of a policy whose old hash folded in another RAM threshold.
  await env.DB.prepare(
    "UPDATE node_region_policies SET standing_cost_profile_hash=NULL WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  const reserved = await f.reserve();
  await expect(
    approveStandingNodePurchase(env.DB, reserved.intent.operation_id),
  ).rejects.toMatchObject({ code: "approval_required" });
  const put = await request(
    `/v1/regions/${f.region}/capacity-policy`,
    f.admin,
    "PUT",
    { ...f.policy, adopt_instance_ids: [] },
  );
  expect(put.status).toBe(200);
  const approved = await approveStandingNodePurchase(
    env.DB,
    reserved.intent.operation_id,
  );
  expect(approved.approval).toMatchObject({
    standing_profile_id: f.profile.id,
    trigger: "ram_76_percent",
  });
  expect(
    (
      await claimNodeDispatch(
        env.DB,
        approved.intent.operation_id,
        approved.revision,
      )
    ).claimed,
  ).toBe(true);
});
