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
import {
  configureInfrastructureBackups,
  readInfrastructureBackupConfig,
} from "../../src/domain/infrastructure-backups.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

afterEach(async () => {
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=NULL,notification_recipients='[]',notification_sender=NULL WHERE singleton=1",
  ).run();
  await cleanupFixtures();
});

it("delivers each email and the webhook independently and retries only the failed destination", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=?,notification_recipients=?,notification_sender=? WHERE singleton=1",
  )
    .bind(
      "first@example.test",
      JSON.stringify(["first@example.test", "second@example.test"]),
      "alerts@example.test",
    )
    .run();
  const calls: { destination: string; key: string }[] = [];
  let failSecond = true;
  const fetcher: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options!.body));
    const destination = String(url).includes("resend")
      ? (body.to[0] as string)
      : "webhook";
    calls.push({
      destination,
      key: new Headers(options!.headers).get("Idempotency-Key")!,
    });
    return new Response(null, {
      status: destination === "second@example.test" && failSecond ? 503 : 204,
    });
  };
  const configuredEnv = { ...configured(), RESEND_API_KEY: "test-resend" };
  await Promise.all([
    runInfrastructureAlerts(configuredEnv, f.region, at, fetcher),
    runInfrastructureAlerts(configuredEnv, f.region, at, fetcher),
  ]);
  expect(calls.map((c) => c.destination).sort()).toEqual([
    "first@example.test",
    "second@example.test",
    "webhook",
  ]);
  expect(new Set(calls.map((c) => c.key)).size).toBe(3);
  const [status] = await infrastructureAlertStatus(env.DB, f.region);
  expect(status).toMatchObject({ delivered_at: null });
  expect(status!.deliveries).toHaveLength(3);
  expect(
    status!.deliveries.filter((d) => d.delivered_at !== null),
  ).toHaveLength(2);
  await runInfrastructureAlerts(configuredEnv, f.region, at + 59_000, fetcher);
  expect(calls).toHaveLength(3);
  failSecond = false;
  expect(
    await runInfrastructureAlerts(
      configuredEnv,
      f.region,
      at + 60_000,
      fetcher,
    ),
  ).toEqual({ delivered: 1, pending: 0 });
  expect(calls).toHaveLength(4);
  expect(calls[3]).toEqual(
    calls.find((c) => c.destination === "second@example.test"),
  );
  await runInfrastructureAlerts(configuredEnv, f.region, at + 120_000, fetcher);
  expect(calls).toHaveLength(4);
});

it("preserves the legacy webhook receipt while adding independent recipients to an existing episode", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
  await runInfrastructureAlerts(env, f.region, at);
  await env.DB.prepare(
    "UPDATE infrastructure_alerts SET delivered_at=?,last_attempt_at=? WHERE region_id=?",
  )
    .bind(new Date(at).toISOString(), new Date(at).toISOString(), f.region)
    .run();
  const config = await readInfrastructureBackupConfig(env.DB);
  const update = {
    enabled: config.enabled,
    d1_account_id: config.d1_account_id,
    d1_database_id: config.d1_database_id,
    d1_region_id: config.d1_region_id,
    notification_recipient: "first@example.test",
    notification_sender: "alerts@example.test",
  };
  await configureInfrastructureBackups(env, {
    ...update,
    notification_recipients: ["second@example.test"],
  });
  // An older client that only knows the original six fields cannot remove the additional list.
  await configureInfrastructureBackups(env, update);
  expect(await readInfrastructureBackupConfig(env.DB)).toMatchObject({
    ...update,
    notification_recipients: ["second@example.test"],
  });
  const sent: string[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    expect(String(url)).toBe("https://api.resend.com/emails");
    sent.push(JSON.parse(String(options!.body)).to[0]);
    return new Response(null, { status: 204 });
  };
  await runInfrastructureAlerts(
    { ...configured(), RESEND_API_KEY: "test-resend" },
    f.region,
    at + 1,
    fetcher,
  );
  expect(sent.sort()).toEqual(["first@example.test", "second@example.test"]);
  const [status] = await infrastructureAlertStatus(env.DB, f.region);
  expect(
    status!.deliveries.find((delivery) => delivery.channel === "webhook"),
  ).toMatchObject({ delivered_at: new Date(at).toISOString(), attempts: 0 });
  expect(
    status!.deliveries.every((delivery) => delivery.delivered_at !== null),
  ).toBe(true);
});

it("durably delivers recovery to three destinations and retries a failed recovery after recurrence", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=?,notification_recipients=?,notification_sender=? WHERE singleton=1",
  )
    .bind(
      "first@example.test",
      '["second@example.test"]',
      "alerts@example.test",
    )
    .run();
  const calls: {
    destination: string;
    state: string;
    key: string;
    body: string;
  }[] = [];
  let failRecovery = true;
  const fetcher: typeof fetch = async (url, options) => {
    const envelope = JSON.parse(String(options!.body));
    const destination = String(url).includes("resend")
      ? envelope.to[0]
      : "webhook";
    const body =
      destination === "webhook" ? String(options!.body) : envelope.text;
    const event = JSON.parse(body);
    calls.push({
      destination,
      state: event.state ?? "active",
      key: new Headers(options!.headers).get("Idempotency-Key")!,
      body,
    });
    return new Response(null, {
      status:
        event.state === "resolved" &&
        destination === "second@example.test" &&
        failRecovery
          ? 503
          : 204,
    });
  };
  const configuredEnv = { ...configured(), RESEND_API_KEY: "test-resend" };
  await runInfrastructureAlerts(configuredEnv, f.region, at, fetcher);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
  });
  await Promise.all([
    runInfrastructureAlerts(configuredEnv, f.region, at + 1_000, fetcher),
    runInfrastructureAlerts(configuredEnv, f.region, at + 1_000, fetcher),
  ]);
  expect(
    calls
      .filter((c) => c.state === "resolved")
      .map((c) => c.destination)
      .sort(),
  ).toEqual(["first@example.test", "second@example.test", "webhook"]);
  expect(new Set(calls.map((c) => c.key)).size).toBe(6);
  // A fresh episode cannot replace the failed recovery's durable payload or receipt.
  await reachCap(f);
  await runInfrastructureAlerts(configuredEnv, f.region, at + 2_000, fetcher);
  failRecovery = false;
  await runInfrastructureAlerts(configuredEnv, f.region, at + 61_000, fetcher);
  const recoveries = calls.filter((c) => c.state === "resolved");
  expect(recoveries).toHaveLength(4);
  expect(recoveries[3]).toEqual(
    recoveries.find((c) => c.destination === "second@example.test"),
  );
  await runInfrastructureAlerts(configuredEnv, f.region, at + 121_000, fetcher);
  expect(calls.filter((c) => c.state === "resolved")).toHaveLength(4);
  const [status] = await infrastructureAlertStatus(env.DB, f.region);
  expect(status!.recoveries[0]!.deliveries).toHaveLength(3);
  expect(
    status!.recoveries[0]!.deliveries.every((d) => d.delivered_at !== null),
  ).toBe(true);
});

it("keeps a recovery when the warning receipt arrives after the condition cleared", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: InfraAlert[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    const event = InfraAlert.parse(JSON.parse(String(options!.body)));
    events.push(event);
    if (event.state !== "resolved") {
      started();
      await held;
    }
    return new Response(null, { status: 204 });
  };
  const sending = runInfrastructureAlerts(configured(), f.region, at, fetcher);
  await entered;
  try {
    await configureNodeRegionPolicy(env.DB, {
      region_id: f.region,
      max_nodes: 3,
    });
    await runInfrastructureAlerts(configured(), f.region, at + 1_000, fetcher);
    expect(events).toHaveLength(1);
  } finally {
    release();
    await sending;
  }
  await runInfrastructureAlerts(configured(), f.region, at + 2_000, fetcher);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    state: "resolved",
    episode_started_at: events[0]!.occurred_at,
  });
});
async function setup(
  warnings: {
    node_ram_warning_threshold_ppm?: number | null;
    node_cpu_warning_threshold_ppm?: number | null;
    node_storage_warning_threshold_ppm?: number | null;
    cap_warning_enabled?: boolean;
  } = { cap_warning_enabled: true },
) {
  const f = await fixture(8192, 40),
    provider = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  await env.DB.prepare("UPDATE nodes SET provider_instance_id=? WHERE id=?")
    .bind(provider, f.node)
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
    maximum_database_memory_mib: 4096,
    ...warnings,
  });
  return { ...f, provider, order };
}
/** The region's one provider-assigned node reaches the cap of 1 (the notice is on by default). */
const reachCap = (f: Awaited<ReturnType<typeof setup>>) =>
  configureNodeRegionPolicy(env.DB, { region_id: f.region, max_nodes: 1 });
function configured() {
  return {
    ...env,
    INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
    INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
  };
}
it("creates no warning by default even with configured delivery and a reached finite cap", async () => {
  const f = await setup({});
  await reachCap(f);
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

it("deactivates a pending cap notice when it is disabled", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 1,
  });
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    cap_warning_enabled: false,
  });
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
  ]);
});

it("rechecks warning policy after reading pending delivery", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
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
      cap_warning_enabled: false,
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

it("durably warns once when the cap is reached and exposes callback status through admin health", async () => {
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
  expect(
    await runInfrastructureAlerts(configured(), f.region, at, receiver),
  ).toEqual({ delivered: 0, pending: 0 });
  await reachCap(f);
  await Promise.all([
    runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
    runInfrastructureAlerts(configured(), f.region, at + 1, receiver),
  ]);
  expect(delivered).toHaveLength(1);
  const event = InfraAlert.parse(JSON.parse(delivered[0]!.body));
  expect(event).toMatchObject({
    kind: "regional_node_cap_reached",
    region_id: f.region,
    regional_ram_utilization_ppm: null,
    allocated_nodes: 1,
    max_nodes: 1,
  });
  expect(delivered[0]!.key).toBe(`${event.event_id}:${event.occurred_at}`);
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

it("retries an unknown callback with its identical durable event and re-announces the same error after it cleared", async () => {
  const f = await setup(),
    at = Date.now();
  await reachCap(f);
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
    "UPDATE infrastructure_alert_deliveries SET last_attempt_at=? WHERE region_id=?",
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
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 3,
  });
  await runInfrastructureAlerts(configured(), f.region, at + 3, receiver);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: false,
  });
  await reachCap(f);
  await runInfrastructureAlerts(configured(), f.region, at + 4, receiver);
  expect(bodies).toHaveLength(4);
  expect(JSON.parse(bodies[2]!)).toMatchObject({ state: "resolved" });
  // The notice that comes back is the same error: the same id, and a new start to tell it apart.
  const [first, again] = [bodies[0]!, bodies[3]!].map((body) =>
    InfraAlert.parse(JSON.parse(body)),
  );
  expect(again!.event_id).toBe(first!.event_id);
  expect(again!.occurred_at).not.toBe(first!.occurred_at);
});

it("counts control and provider-assigned VPS for the cap notice, excluding an unpaid reservation and duplicate associations", async () => {
  const f = await setup(),
    now = new Date().toISOString(),
    controlProvider = String(
      1 + crypto.getRandomValues(new Uint32Array(1))[0]!,
    );
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,hostname,ready,schedulable,database_placement_enabled,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,provider_instance_id) VALUES(?,?,?,1,1,0,8192,2000,40,128,100,?,?,?,?)",
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
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({ state: "resolved" });
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_cap_reached", active: false },
  ]);
});

it("supports an authenticated generic service binding without resolving an external URL", async () => {
  const f = await setup();
  await reachCap(f);
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
    idempotency: `${event.event_id}:${event.occurred_at}`,
  });
});

it("cannot clear a newer cap notice with an older concurrent below-cap observation", async () => {
  const f = await setup({ cap_warning_enabled: true }),
    at = Date.now(),
    now = new Date(at).toISOString();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
  });
  const second = newNodeId();
  const addSecond = () =>
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,hostname,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,created_at,updated_at,provider_instance_id) VALUES(?,?,?,1,1,8192,2000,128,?,?,?)",
    )
      .bind(
        second,
        f.region,
        "second-fixture",
        now,
        now,
        String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
      )
      .run();
  await addSecond();
  await runInfrastructureAlerts(env, f.region, at);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: true,
  });
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(second).run();
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
          return async (column: string) => {
            const value = await target.first(column);
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
          sql.includes("allocated") && sql.startsWith("SELECT (WITH registered")
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The older run counts one node, below the cap of 2, and is held before it clears the notice.
  const older = runInfrastructureAlerts(
    { ...env, DB: paused },
    f.region,
    at + 1,
  );
  await read;
  try {
    await addSecond();
    await runInfrastructureAlerts(env, f.region, at + 2);
  } finally {
    resume();
    await older;
  }
  expect(intercepted).toBe(true);
  expect((await infrastructureAlertStatus(env.DB, f.region))[0]).toMatchObject({
    active: true,
  });
});

it("does not wait for a streaming receiver body's unbounded cancellation", async () => {
  const f = await setup();
  await reachCap(f);
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
