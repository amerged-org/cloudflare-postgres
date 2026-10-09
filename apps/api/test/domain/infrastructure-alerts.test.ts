// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { InfraAlert, newNodeId } from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  allocatedRegionalNodes,
  infrastructureAlertStatus,
  runInfrastructureAlerts,
} from "../../src/domain/infrastructure-alerts.ts";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const capacity = 8 * 1024 ** 3;
afterEach(cleanupFixtures);
async function setup(
  warnings: {
    ram_warning_threshold_ppm?: number | null;
    cap_warning_enabled?: boolean;
  } = { ram_warning_threshold_ppm: 750000, cap_warning_enabled: true },
) {
  const f = await fixture(8192, 40),
    uid = crypto.randomUUID(),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare(
    "UPDATE nodes SET node_uid=?,provider_instance_id=? WHERE id=?",
  )
    .bind(uid, provider, f.node)
    .run();
  const order = {
    product_id: "V159",
    provider_region: "test",
    image_id: crypto.randomUUID(),
    term_months: 1 as const,
    location: "Test fixture",
  };
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
    purchases_enabled: false,
    order,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
    ...warnings,
  });
  return { ...f, uid, provider, order };
}
async function sample(
  f: Awaited<ReturnType<typeof setup>>,
  percent: number,
  at = Date.now(),
) {
  for (let i = 9; i >= 0; i--) {
    const time = at - i * 60000,
      observed_at = new Date(time).toISOString();
    expect(
      await recordNodeMemoryObservation(
        env.DB,
        f.region,
        {
          node_id: f.node,
          node_uid: f.uid,
          provider_instance_id: f.provider,
          memory: {
            node_uid: f.uid,
            observed_at,
            capacity_memory_bytes: capacity,
            working_set_bytes: Math.floor((capacity * percent) / 100),
            available_bytes: capacity - Math.floor((capacity * percent) / 100),
            memory_pressure: false,
          },
        },
        observed_at,
        time,
      ),
    ).toBe(true);
  }
}
function configured() {
  return {
    ...env,
    INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
    INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
  };
}

it("creates no warning by default even with configured delivery and a reached finite cap", async () => {
  const f = await setup({});
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
  });
  await sample(f, 90);
  let sent = 0;
  const receiver: typeof fetch = async () => {
    sent++;
    return new Response(null, { status: 204 });
  };
  expect(
    await runInfrastructureAlerts(configured(), f.region, Date.now(), receiver),
  ).toEqual({ delivered: 0, pending: 0 });
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
});

it("uses the configured RAM warning threshold", async () => {
  const f = await setup({ ram_warning_threshold_ppm: 830001 }),
    at = Date.now();
  await sample(f, 83, at);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await sample(f, 84, at + 1);
  expect(await runInfrastructureAlerts(env, f.region, at + 1)).toEqual({
    delivered: 0,
    pending: 1,
  });
});

it("deactivates pending warnings when disabled even when current RAM is unknown", async () => {
  const f = await setup(),
    at = Date.now();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
  });
  await sample(f, 75, at);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 2,
  });
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    ram_warning_threshold_ppm: null,
    cap_warning_enabled: false,
  });
  const observedAt = new Date(at + 1).toISOString();
  await recordNodeMemoryObservation(
    env.DB,
    f.region,
    {
      node_id: f.node,
      node_uid: f.uid,
      provider_instance_id: f.provider,
      memory: null,
    },
    observedAt,
    at + 1,
  );
  let sent = 0;
  const receiver: typeof fetch = async () => {
    sent++;
    return new Response(null, { status: 204 });
  };
  expect(
    await runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
  ).toEqual({ delivered: 0, pending: 0 });
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { active: false, delivered_at: null, last_attempt_at: null },
    { active: false, delivered_at: null, last_attempt_at: null },
  ]);
});

it("rechecks warning policy after reading pending delivery", async () => {
  const f = await setup(),
    at = Date.now();
  await sample(f, 75, at);
  await runInfrastructureAlerts(env, f.region, at);
  let captured!: () => void, resume!: () => void;
  const read = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "all")
          return async () => {
            const value = await target.all();
            captured();
            await release;
            return value;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const paused = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          sql.startsWith(
            "SELECT * FROM infrastructure_alerts WHERE region_id=? AND active=1",
          )
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let sent = 0;
  const receiver: typeof fetch = async () => {
    sent++;
    return new Response(null, { status: 204 });
  };
  const delivery = runInfrastructureAlerts(
    { ...configured(), DB: paused },
    f.region,
    at,
    receiver,
  );
  await read;
  try {
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      ram_warning_threshold_ppm: 900000,
    });
  } finally {
    resume();
    await delivery;
  }
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { delivered_at: null, last_attempt_at: null },
  ]);
});

it("retains an enabled pending RAM warning without delivering until measurements are current", async () => {
  const f = await setup(),
    at = Date.now();
  await sample(f, 75, at);
  await runInfrastructureAlerts(env, f.region, at);
  const before = (await infrastructureAlertStatus(env.DB, f.region))[0]!;
  const observedAt = new Date(at + 1).toISOString();
  await recordNodeMemoryObservation(
    env.DB,
    f.region,
    {
      node_id: f.node,
      node_uid: f.uid,
      provider_instance_id: f.provider,
      memory: null,
    },
    observedAt,
    at + 1,
  );
  const received: unknown[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    received.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  };
  expect(
    await runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
  ).toEqual({ delivered: 0, pending: 1 });
  expect(received).toEqual([]);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toEqual(
    before,
  );
  await sample(f, 75, at + 2);
  expect(
    await runInfrastructureAlerts(configured(), f.region, at + 2, receiver),
  ).toEqual({ delivered: 1, pending: 0 });
  expect(received).toMatchObject([{ event_id: before.event_id }]);
});

it("durably warns once at the configured ten-minute boundary and exposes callback status through admin health", async () => {
  const f = await setup(),
    at = Date.now();
  const delivered: {
    body: string;
    key: string | null;
    authorization: string | null;
  }[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    delivered.push({
      body: String(init?.body),
      key: headers.get("Idempotency-Key"),
      authorization: headers.get("Authorization"),
    });
    return new Response(null, { status: 204 });
  };
  await sample(f, 74, at);
  expect(
    await runInfrastructureAlerts(configured(), f.region, at, receiver),
  ).toEqual({ delivered: 0, pending: 0 });
  await sample(f, 75, at + 1);
  await Promise.all([
    runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
    runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
  ]);
  expect(delivered).toHaveLength(1);
  const event = InfraAlert.parse(JSON.parse(delivered[0]!.body));
  expect(event).toMatchObject({
    kind: "regional_ram_warning",
    region_id: f.region,
    regional_ram_utilization_ppm: 750000,
    allocated_nodes: 1,
    max_nodes: 3,
  });
  expect(delivered[0]!.key).toBe(event.event_id);
  expect(delivered[0]!.authorization).toBe("Bearer test-alert-receiver-token");
  await runInfrastructureAlerts(configured(), f.region, at + 2, receiver);
  expect(delivered).toHaveLength(1);
  const health = await request("/v1/operational-health?scope=regions", f.admin);
  expect(health.status).toBe(200);
  const page = await health.json<{
    data: {
      id: string;
      infrastructure_alerts?: {
        event_id: string;
        delivered_at: string | null;
      }[];
    }[];
  }>();
  expect(
    page.data.find((r) => r.id === f.region)?.infrastructure_alerts,
  ).toMatchObject([
    { event_id: event.event_id, delivered_at: new Date(at + 1).toISOString() },
  ]);
});

it("retries an unknown callback with its identical durable event and never rearms from unknown RAM", async () => {
  const f = await setup(),
    at = Date.now();
  await sample(f, 75, at);
  const bodies: string[] = [];
  const uncertain: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    throw new Error("lost response");
  };
  expect(
    await runInfrastructureAlerts(configured(), f.region, at, uncertain),
  ).toEqual({ delivered: 0, pending: 1 });
  await runInfrastructureAlerts(configured(), f.region, at + 1, uncertain);
  expect(bodies).toHaveLength(1);
  await env.DB.prepare(
    "UPDATE infrastructure_alerts SET last_attempt_at=? WHERE region_id=?",
  )
    .bind(new Date(at - 60001).toISOString(), f.region)
    .run();
  const receiver: typeof fetch = async (_input, init) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 204 });
  };
  expect(
    await runInfrastructureAlerts(configured(), f.region, at + 2, receiver),
  ).toEqual({ delivered: 1, pending: 0 });
  expect(bodies[1]).toBe(bodies[0]);
  const unknownAt = new Date(at + 3).toISOString();
  await recordNodeMemoryObservation(
    env.DB,
    f.region,
    {
      node_id: f.node,
      node_uid: f.uid,
      provider_instance_id: f.provider,
      memory: null,
    },
    unknownAt,
    at + 3,
  );
  await runInfrastructureAlerts(configured(), f.region, at + 3, receiver);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: true,
  });
  await sample(f, 74, at + 4);
  await runInfrastructureAlerts(configured(), f.region, at + 4, receiver);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: false,
  });
  await sample(f, 75, at + 5);
  await runInfrastructureAlerts(configured(), f.region, at + 5, receiver);
  expect(bodies).toHaveLength(3);
  expect(InfraAlert.parse(JSON.parse(bodies[2]!)).event_id).not.toBe(
    InfraAlert.parse(JSON.parse(bodies[0]!)).event_id,
  );
});

it("counts control and provider-assigned VPS for the cap notice, excluding an unpaid reservation and duplicate associations", async () => {
  const f = await setup(),
    now = new Date().toISOString(),
    controlProvider = String(
      1 + crypto.getRandomValues(new Uint32Array(1))[0]!,
    );
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,database_placement_enabled,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,provider_instance_id) VALUES(?,?,?,1,1,0,8192,2000,40,128,100,?,?,?,?)",
  )
    .bind(
      newNodeId(),
      f.region,
      "control-fixture",
      now,
      now,
      now,
      controlProvider,
    )
    .run();
  const addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: { region_id: f.region, mode: "order", order: f.order },
  });
  expect(await allocatedRegionalNodes(env.DB, f.region)).toBe(2);
  await runInfrastructureAlerts(env, f.region);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  await env.DB.prepare(
    "UPDATE node_additions SET provider_instance_id=?,status='provider_bound' WHERE operation_id=?",
  )
    .bind(
      String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
      addition.intent.operation_id,
    )
    .run();
  const events: unknown[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    events.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  };
  await runInfrastructureAlerts(configured(), f.region, Date.now(), receiver);
  expect(events).toMatchObject([
    {
      kind: "regional_node_cap_reached",
      allocated_nodes: 3,
      max_nodes: 3,
      regional_ram_utilization_ppm: null,
    },
  ]);
  await runInfrastructureAlerts(configured(), f.region, Date.now(), receiver);
  expect(events).toHaveLength(1);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: null,
  });
  await runInfrastructureAlerts(configured(), f.region, Date.now(), receiver);
  expect(events).toHaveLength(1);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_cap_reached", active: false },
  ]);
});

it("supports an authenticated generic service binding without resolving an external URL", async () => {
  const f = await setup();
  await sample(f, 75);
  const events: {
    url: string;
    authorization: string | null;
    idempotency: string | null;
    event: unknown;
  }[] = [];
  const bound = {
    fetch: async (input: RequestInfo | URL) => {
      const request = new Request(input);
      const event = await request.json();
      events.push({
        url: request.url,
        authorization: request.headers.get("Authorization"),
        idempotency: request.headers.get("Idempotency-Key"),
        event,
      });
      return new Response(null, { status: 204 });
    },
  } as unknown as Fetcher;
  const fallback: typeof fetch = async () => {
    throw new Error("external fetch forbidden");
  };
  const result = await runInfrastructureAlerts(
    {
      ...env,
      INFRASTRUCTURE_ALERT_WEBHOOK: bound,
      INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
    },
    f.region,
    Date.now(),
    fallback,
  );
  expect(events).toHaveLength(1);
  expect(result).toEqual({ delivered: 1, pending: 0 });
  const event = InfraAlert.parse(events[0]!.event);
  expect(events[0]).toMatchObject({
    url: "https://infrastructure-alert.invalid/",
    authorization: "Bearer test-alert-receiver-token",
    idempotency: event.event_id,
  });
});

it("cannot clear a newer warning with an older concurrent below-threshold observation", async () => {
  const f = await setup(),
    at = Date.now();
  await sample(f, 74, at);
  let captured!: () => void, resume!: () => void;
  const read = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let intercepted = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first")
          return async () => {
            const value = await target.first();
            if (!intercepted) {
              intercepted = true;
              captured();
              await release;
            }
            return value;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const paused = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          sql.startsWith("WITH members AS")
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const older = runInfrastructureAlerts({ ...env, DB: paused }, f.region, at);
  await read;
  try {
    await sample(f, 75, at + 1);
    await runInfrastructureAlerts(env, f.region, at + 1);
  } finally {
    resume();
    await older;
  }
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: true,
  });
});

it("does not wait for a streaming receiver body's unbounded cancellation", async () => {
  const f = await setup();
  await sample(f, 75);
  const receiver: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        cancel: () => new Promise<void>(() => {}),
      }),
      { status: 202 },
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(
      await Promise.race([
        runInfrastructureAlerts(configured(), f.region, Date.now(), receiver),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("response_cancel_stalled")),
            250,
          );
        }),
      ]),
    ).toEqual({ delivered: 1, pending: 0 });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
});
