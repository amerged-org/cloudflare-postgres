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
import { newNodeId } from "@pgcf/contracts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { runNodeCapacityCron } from "../../src/domain/node-capacity.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

async function ramAuthority(percent = 80, trigger = "ram_76_percent") {
  const f = await fixture(8192, 60),
    uid = crypto.randomUUID(),
    provider = String(
      100_000_000 + crypto.getRandomValues(new Uint32Array(1))[0]!,
    );
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
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
    owner_reference: "owner-regional-76-percent-no-ceilings",
    approved_at: new Date().toISOString(),
    expires_at: null,
    currency: null,
    monthly_amount: null,
    setup_amount: null,
    max_orders: null,
    max_total_monthly_amount: null,
    max_total_setup_amount: null,
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: null,
    purchases_enabled: true,
    order,
    placement_mode: "actual_ram",
    ram_expansion_threshold_ppm: 760_000,
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    standing_cost_profile: profile,
  });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=1 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  const at = Math.floor(Date.now() / 60_000) * 60_000,
    capacity = 8192 * 2 ** 20;
  for (let i = 9; i >= 0; i--) {
    const time = at - i * 60_000,
      observed_at = new Date(time).toISOString();
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
            working_set_bytes: Math.ceil((capacity * percent) / 100),
            available_bytes: capacity - Math.ceil((capacity * percent) / 100),
            memory_pressure: false,
          },
        },
        observed_at,
        time,
      ),
    ).toBe(true);
  }
  return {
    ...f,
    uid,
    provider,
    order,
    profile,
    minute: Math.floor(at / 60_000),
    reserve: () =>
      reserveNodeAddition(env.DB, {
        request_key: `capacity-ram-${Math.floor(at / 60_000)}`,
        request: { region_id: f.region, mode: "order", order },
        exclusive_region_addition: true,
      }),
  };
}

it("derives exact RAM-trigger authority without invented price, expiry or node ceilings and never dispatches twice", async () => {
  const f = await ramAuthority();
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

it("does not convert uncapped RAM authority into an order below the regional threshold", async () => {
  const f = await ramAuthority(75);
  await expect(f.reserve()).rejects.toMatchObject({
    code: "capacity_unavailable",
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_additions WHERE region_id=?",
    )
      .bind(f.region)
      .first("count"),
  ).toBe(0);
});

it("rechecks fresh regional membership before the first purchase and resumes the same undispatched intent after recovery", async () => {
  const f = await ramAuthority();
  const reserved = await f.reserve(),
    approved = await approveStandingNodePurchase(
      env.DB,
      reserved.intent.operation_id,
    );
  const spare = newNodeId();
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid) SELECT ?,region_id,?,1,1,8192,4000,60,128,100,last_observed_at,created_at,updated_at,? FROM nodes WHERE id=?",
  )
    .bind(spare, `spare-${crypto.randomUUID()}`, crypto.randomUUID(), f.node)
    .run();
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  expect(
    await env.DB.prepare(
      "SELECT status,dispatch_request_id FROM node_additions WHERE operation_id=?",
    )
      .bind(approved.intent.operation_id)
      .first(),
  ).toEqual({ status: "reserved", dispatch_request_id: null });
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(spare).run();
  await env.DB.prepare(
    "UPDATE node_additions SET approval_json=json_set(approval_json,'$.approved_at',?,'$.expires_at',?) WHERE operation_id=?",
  )
    .bind(
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      approved.intent.operation_id,
    )
    .run();
  const refreshed = await approveStandingNodePurchase(
    env.DB,
    approved.intent.operation_id,
  );
  expect(refreshed.intent.operation_id).toBe(approved.intent.operation_id);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_standing_approvals WHERE operation_id=?",
    )
      .bind(approved.intent.operation_id)
      .first("count"),
  ).toBe(1);
  expect(
    (
      await claimNodeDispatch(
        env.DB,
        refreshed.intent.operation_id,
        refreshed.revision,
      )
    ).claimed,
  ).toBe(true);
});

it("resolves an uncertain order after threshold and switch changes without a second purchase", async () => {
  const f = await ramAuthority();
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
    region_id: f.region,
    purchases_enabled: false,
    autoscale_enabled: false,
    order: f.order,
    placement_mode: "actual_ram",
    ram_expansion_threshold_ppm: 920_001,
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    standing_cost_profile: f.profile,
  });
  await env.DB.prepare("DELETE FROM node_memory_samples WHERE node_id=?")
    .bind(f.node)
    .run();
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

it("holds one active RAM expansion per region even when a direct caller omits exclusive selection", async () => {
  const f = await ramAuthority();
  await f.reserve();
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: `capacity-ram-${f.minute - 1}`,
      request: { region_id: f.region, mode: "order", order: f.order },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
});

it("revokes an undispatched automatic purchase when automatic expansion is disabled", async () => {
  const f = await ramAuthority();
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
  const f = await ramAuthority();
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
    {
      region_id: f.region,
      max_nodes: null,
      purchases_enabled: true,
      autoscale_enabled: false,
      adopt_instance_ids: [],
      order: f.order,
      placement_mode: "actual_ram",
      ram_expansion_threshold_ppm: 760_000,
      maximum_database_memory_mib: 4096,
      postgres_memory_request_mib: 128,
      standing_cost_profile: f.profile,
    },
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

it("preserves individually cost-approved manual bootstrap without granting it RAM-trigger authority", async () => {
  const f = await ramAuthority(75);
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

it("revalidates a changed threshold on the same undispatched intent without a second ledger charge", async () => {
  const f = await ramAuthority(80);
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  const operationId = approved.intent.operation_id;
  const policy = {
    region_id: f.region,
    purchases_enabled: true,
    autoscale_enabled: true,
    order: f.order,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    standing_cost_profile: f.profile,
  };
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    ram_expansion_threshold_ppm: 850_000,
  });
  await expect(
    claimNodeDispatch(env.DB, operationId, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
  await configureNodeRegionPolicy(env.DB, {
    ...policy,
    ram_expansion_threshold_ppm: 790_001,
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

it("enforces current RAM and one regional addition for generic standing authority", async () => {
  const f = await ramAuthority(80, "regional_actual_ram");
  const reserved = await f.reserve();
  const approved = await approveStandingNodePurchase(
    env.DB,
    reserved.intent.operation_id,
  );
  expect(approved.approval?.trigger).toBe("regional_actual_ram");
  await expect(
    reserveNodeAddition(env.DB, {
      request_key: `capacity-ram-${f.minute - 1}`,
      request: { region_id: f.region, mode: "order", order: f.order },
    }),
  ).rejects.toMatchObject({ code: "capacity_unavailable" });
  await env.DB.prepare(
    "UPDATE node_region_policies SET autoscale_enabled=0 WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  await expect(
    claimNodeDispatch(env.DB, approved.intent.operation_id, approved.revision),
  ).rejects.toMatchObject({ code: "approval_required" });
});

it("keeps a threshold-blocked reserved intent waiting and completes capacity checks for other regions", async () => {
  const f = await ramAuthority(80);
  const other = await fixture();
  await configureNodeRegionPolicy(env.DB, { region_id: other.region });
  const approved = await approveStandingNodePurchase(
    env.DB,
    (await f.reserve()).intent.operation_id,
  );
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    purchases_enabled: true,
    autoscale_enabled: true,
    order: f.order,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    standing_cost_profile: f.profile,
    ram_expansion_threshold_ppm: 850_000,
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

it("rechecks RAM for an old automatic headroom key before its first provider write", async () => {
  const f = await ramAuthority(80);
  const reserved = await reserveNodeAddition(env.DB, {
    request_key: `capacity-headroom-${f.region}-1`,
    request: { region_id: f.region, mode: "order", order: f.order },
  });
  const approved = await approveStandingNodePurchase(
    env.DB,
    reserved.intent.operation_id,
  );
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    purchases_enabled: true,
    autoscale_enabled: true,
    order: f.order,
    placement_mode: "reserved",
    standing_cost_profile: f.profile,
    ram_expansion_threshold_ppm: 850_000,
  });
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
