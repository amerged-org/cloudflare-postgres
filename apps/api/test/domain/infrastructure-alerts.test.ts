// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  InfraAlert,
  newNodeId,
  type InfraAlertKind,
  type NodePhysicalStorage,
} from "@pgcf/contracts";
import { afterEach, expect, it } from "vitest";
import {
  allocatedRegionalNodes,
  infrastructureAlertStatus,
  runInfrastructureAlerts,
} from "../../src/domain/infrastructure-alerts.ts";
import { configureInfrastructureBackups } from "../../src/domain/infrastructure-backups.ts";
import {
  configureNodeRegionPolicy,
  markNodeLost,
  reserveNodeAddition,
} from "../../src/domain/node-state.ts";
import { recordNodeMemoryObservation } from "../../src/domain/memory-capacity.ts";
import { recordNodeStorageObservation } from "../../src/domain/node-storage.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";

const capacity = 8 * 1024 ** 3,
  terabyte = 1_000_000_000_000,
  core = 1_000_000_000;
afterEach(async () => {
  await env.DB.prepare(
    "UPDATE infrastructure_backup_config SET notification_recipient=NULL,notification_sender=NULL WHERE singleton=1",
  ).run();
  await cleanupFixtures();
});
async function setup(
  warnings: {
    ram_warning_threshold_ppm?: number | null;
    node_ram_warning_threshold_ppm?: number | null;
    node_cpu_warning_threshold_ppm?: number | null;
    node_storage_warning_threshold_ppm?: number | null;
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
/** Ten minute samples, oldest first; `cpu` holds nanocores on 2000 millicores, null as an older reporter. */
async function sample(
  f: Awaited<ReturnType<typeof setup>>,
  percent: number,
  at = Date.now(),
  cpu?: (number | null)[],
) {
  for (let i = 9; i >= 0; i--) {
    const time = at - i * 60000,
      observed_at = new Date(time).toISOString(),
      usage = cpu?.[9 - i] ?? null;
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
            ...(usage === null
              ? {}
              : { cpu_usage_nano_cores: usage, capacity_cpu_millicores: 2000 }),
          },
        },
        observed_at,
        time,
      ),
    ).toBe(true);
  }
}
type Member = { node: string; uid: string; provider: string; name: string };
function member(f: Awaited<ReturnType<typeof setup>>): Member {
  return { node: f.node, uid: f.uid, provider: f.provider, name: f.nodeName };
}
async function addMember(f: Awaited<ReturnType<typeof setup>>) {
  const now = new Date().toISOString(),
    added: Member = {
      node: newNodeId(),
      uid: crypto.randomUUID(),
      provider: String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!),
      name: `${f.nodeName}-second`,
    };
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,provider_instance_id) VALUES(?,?,?,1,8192,2000,40,128,100,?,?,?,?,?)",
  )
    .bind(
      added.node,
      f.region,
      added.name,
      now,
      now,
      now,
      added.uid,
      added.provider,
    )
    .run();
  return added;
}
function volumeGroup(used: number): NodePhysicalStorage {
  return {
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    total_bytes: terabyte,
    free_bytes: terabyte - used,
    thick_allocated_bytes: used,
    thin_pool: null,
  };
}
async function storage(
  f: Awaited<ReturnType<typeof setup>>,
  node: Member,
  physical: NodePhysicalStorage | null,
  at: number,
) {
  const observed_at = new Date(at).toISOString();
  expect(
    await recordNodeStorageObservation(
      env.DB,
      f.region,
      {
        node_id: node.node,
        node_uid: node.uid,
        provider_instance_id: node.provider,
        name: node.name,
        ready: true,
        allocatable_memory_mib: 8192,
        allocatable_cpu_millicores: 2000,
        storage_gib_total: 40,
        platform_reserved_memory_mib: 128,
      },
      { node_uid: node.uid, observed_at, physical },
      at,
    ),
  ).toBe(true);
}
async function payload(
  f: Awaited<ReturnType<typeof setup>>,
  kind: InfraAlertKind,
) {
  const stored = await env.DB.prepare(
    "SELECT payload FROM infrastructure_alerts WHERE region_id=? AND kind=?",
  )
    .bind(f.region, kind)
    .first<string>("payload");
  return InfraAlert.parse(JSON.parse(stored!));
}
function configured() {
  return {
    ...env,
    INFRASTRUCTURE_ALERT_WEBHOOK_URL: "https://receiver.invalid/events",
    INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN: "test-alert-receiver-token",
  };
}
/** Pauses a run after its node read until `meanwhile` has finished, then lets it complete. */
async function stalled(
  run: (db: D1Database) => Promise<unknown>,
  meanwhile: () => Promise<void>,
) {
  let captured!: () => void, resume!: () => void;
  const read = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const paused = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT id,utilization_ppm FROM"))
            return statement;
          return {
            bind: (...values: unknown[]) => ({
              all: async () => {
                const value = await statement.bind(...values).all();
                captured();
                await release;
                return value;
              },
            }),
          } as unknown as D1PreparedStatement;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const older = run(paused);
  await read;
  try {
    await meanwhile();
  } finally {
    resume();
    await older;
  }
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

it("emails one node storage warning at the exact configured boundary under concurrent runs", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 850000 }),
    at = Date.now(),
    mail = { ...env, RESEND_API_KEY: "test-private-resend-key" };
  await configureInfrastructureBackups(env, {
    enabled: false,
    d1_account_id: null,
    d1_database_id: null,
    d1_region_id: null,
    notification_recipient: "operator@example.com",
    notification_sender: "alerts@example.com",
  });
  const sent: {
    url: string;
    key: string | null;
    body: { from: string; to: string[]; subject: string; text: string };
  }[] = [];
  const resend: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      key: new Headers(init?.headers).get("Idempotency-Key"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status: 200 });
  };
  await storage(f, member(f), volumeGroup(850_000_000_000 - 1), at);
  expect(await runInfrastructureAlerts(mail, f.region, at, resend)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await storage(f, member(f), volumeGroup(850_000_000_000), at + 1);
  await Promise.all([
    runInfrastructureAlerts(mail, f.region, at + 1, resend),
    runInfrastructureAlerts(mail, f.region, at + 1, resend),
  ]);
  await runInfrastructureAlerts(mail, f.region, at + 2, resend);
  expect(sent).toHaveLength(1);
  const event = InfraAlert.parse(JSON.parse(sent[0]!.body.text));
  expect(sent[0]).toMatchObject({
    url: "https://api.resend.com/emails",
    key: event.event_id,
    body: {
      from: "alerts@example.com",
      to: ["operator@example.com"],
      subject: `PGCF infrastructure: regional_node_storage_warning (${f.region})`,
    },
  });
  expect(event).toMatchObject({
    kind: "regional_node_storage_warning",
    region_id: f.region,
    regional_ram_utilization_ppm: null,
    node_ids: [f.node],
    threshold_ppm: 850000,
    utilization_ppm: 850000,
  });
});

it("measures a thin node by pool fill instead of its intentionally allocated volume group", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 900000 }),
    at = Date.now();
  const thin = (dataUsed: number): NodePhysicalStorage => ({
    ...volumeGroup(980_000_000_000),
    thick_allocated_bytes: 70_000_000_000,
    thin_pool: {
      name: "pgcf_thinpool",
      data_total_bytes: 900_000_000_000,
      data_used_bytes_upper_bound: dataUsed,
      metadata_total_bytes: 10_000_000_000,
      metadata_used_bytes_upper_bound: 1_000_000_000,
    },
  });
  await storage(f, member(f), thin(90_000_000_000), at);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await storage(f, member(f), thin(810_000_000_000), at + 1);
  const events: unknown[] = [];
  await runInfrastructureAlerts(
    configured(),
    f.region,
    at + 1,
    async (_input, init) => {
      events.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  );
  expect(events).toMatchObject([
    {
      kind: "regional_node_storage_warning",
      node_ids: [f.node],
      utilization_ppm: 900000,
    },
  ]);
});

it("keeps a node warning while a named node is unknown and clears once every named node is known below or lost", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800000 }),
    first = member(f),
    second = await addMember(f),
    at = Date.now(),
    later = at + 121_000,
    events: InfraAlert[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    events.push(InfraAlert.parse(JSON.parse(String(init?.body))));
    return new Response(null, { status: 204 });
  };
  const episode = async () =>
    (await infrastructureAlertStatus(env.DB, f.region))[0]!;
  await storage(f, first, volumeGroup(900_000_000_000), at);
  await storage(f, second, volumeGroup(100_000_000_000), at);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 1,
  });
  const armed = await episode();
  expect(await payload(f, "regional_node_storage_warning")).toMatchObject({
    node_ids: [first.node],
    utilization_ppm: 900000,
  });
  // The named node's sample expires while the other node stays fresh and below.
  await storage(f, second, volumeGroup(100_000_000_000), later);
  expect(
    await runInfrastructureAlerts(configured(), f.region, later, receiver),
  ).toEqual({ delivered: 0, pending: 1 });
  expect(await episode()).toEqual(armed);
  await storage(f, first, volumeGroup(800_000_000_000 - 1), later + 1);
  await runInfrastructureAlerts(configured(), f.region, later + 1, receiver);
  expect(await episode()).toMatchObject({ active: false });
  await storage(f, second, volumeGroup(800_000_000_000), later + 2);
  await runInfrastructureAlerts(configured(), f.region, later + 2, receiver);
  expect(events).toMatchObject([
    { node_ids: [second.node], utilization_ppm: 800000 },
  ]);
  expect(events[0]!.event_id).not.toBe(armed.event_id);
  await markNodeLost(env.DB, second.node, {
    expected_node_uid: second.uid,
    reason: "confirmed provider loss",
  });
  await runInfrastructureAlerts(configured(), f.region, later + 3, receiver);
  expect(await episode()).toMatchObject({ active: false });
});

it("warns about another node's crossing once no listed node still exceeds, even while a listed node is unknown", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 850000 }),
    first = member(f),
    second = await addMember(f),
    at = Date.now(),
    events: InfraAlert[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    events.push(InfraAlert.parse(JSON.parse(String(init?.body))));
    return new Response(null, { status: 204 });
  };
  await storage(f, first, volumeGroup(900_000_000_000), at);
  await storage(f, second, volumeGroup(100_000_000_000), at);
  await runInfrastructureAlerts(configured(), f.region, at, receiver);
  // The listed node keeps reporting without a measurement: it is neither stale nor lost.
  await storage(f, first, null, at + 1);
  await storage(f, second, volumeGroup(990_000_000_000), at + 1);
  await runInfrastructureAlerts(configured(), f.region, at + 1, receiver);
  expect(events).toMatchObject([
    { node_ids: [first.node], utilization_ppm: 900000 },
    { node_ids: [second.node], utilization_ppm: 990000 },
  ]);
  expect(events[1]!.event_id).not.toBe(events[0]!.event_id);
  // While a listed node still exceeds, another node crossing sends nothing new.
  await storage(f, first, volumeGroup(950_000_000_000), at + 2);
  await runInfrastructureAlerts(configured(), f.region, at + 2, receiver);
  expect(events).toHaveLength(2);
});

it("cannot arm or clear a node warning from a superseded concurrent read", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800000 }),
    at = Date.now();
  // The older run pauses after its node read while a newer measurement is recorded and evaluated.
  const race = async (older: number, newer: number, offset: number) => {
    await storage(f, member(f), volumeGroup(older), at + offset);
    await stalled(
      (db) =>
        runInfrastructureAlerts({ ...env, DB: db }, f.region, at + offset),
      async () => {
        await storage(f, member(f), volumeGroup(newer), at + offset + 1);
        await runInfrastructureAlerts(env, f.region, at + offset + 1);
      },
    );
  };
  await race(900_000_000_000, 700_000_000_000, 0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toEqual([]);
  await race(700_000_000_000, 900_000_000_000, 2);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_storage_warning", active: true },
  ]);
});

it("cannot arm or deliver a stalled read naming a node that no longer exceeds", async () => {
  const f = await setup({ node_storage_warning_threshold_ppm: 800000 }),
    first = member(f),
    second = await addMember(f),
    at = Date.now(),
    events: InfraAlert[] = [];
  const receiver: typeof fetch = async (_input, init) => {
    events.push(InfraAlert.parse(JSON.parse(String(init?.body))));
    return new Response(null, { status: 204 });
  };
  await storage(f, first, volumeGroup(900_000_000_000), at);
  await storage(f, second, volumeGroup(100_000_000_000), at);
  // Later runs warn about the second node and clear its episode while the stalled run holds its read.
  await stalled(
    (db) =>
      runInfrastructureAlerts(
        { ...configured(), DB: db },
        f.region,
        at,
        receiver,
      ),
    async () => {
      await storage(f, first, volumeGroup(500_000_000_000), at + 1);
      await storage(f, second, volumeGroup(950_000_000_000), at + 1);
      await runInfrastructureAlerts(configured(), f.region, at + 1, receiver);
      await storage(f, second, volumeGroup(100_000_000_000), at + 2);
      await runInfrastructureAlerts(configured(), f.region, at + 2, receiver);
      await storage(f, second, volumeGroup(950_000_000_000), at + 3);
    },
  );
  expect(events).toMatchObject([{ node_ids: [second.node] }]);
  await runInfrastructureAlerts(configured(), f.region, at + 3, receiver);
  expect(events).toMatchObject([
    { node_ids: [second.node] },
    { node_ids: [second.node], occurred_at: new Date(at + 3).toISOString() },
  ]);
});

it("warns from each node's own RAM window, including a node closed to placement, until disabled", async () => {
  const f = await setup({ node_ram_warning_threshold_ppm: 750000 }),
    at = Date.now();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0 WHERE id=?",
  )
    .bind(f.node)
    .run();
  await sample(f, 74, at);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await sample(f, 75, at + 1);
  expect(await runInfrastructureAlerts(env, f.region, at + 1)).toEqual({
    delivered: 0,
    pending: 1,
  });
  expect(await payload(f, "regional_node_ram_warning")).toMatchObject({
    node_ids: [f.node],
    threshold_ppm: 750000,
    utilization_ppm: 750000,
  });
  const observedAt = new Date(at + 2).toISOString();
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
    at + 2,
  );
  await runInfrastructureAlerts(env, f.region, at + 2);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_ram_warning", active: true },
  ]);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    node_ram_warning_threshold_ppm: null,
  });
  let sent = 0;
  expect(
    await runInfrastructureAlerts(configured(), f.region, at + 2, async () => {
      sent++;
      return new Response(null, { status: 204 });
    }),
  ).toEqual({ delivered: 0, pending: 0 });
  expect(sent).toBe(0);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    {
      kind: "regional_node_ram_warning",
      active: false,
      delivered_at: null,
      last_attempt_at: null,
    },
  ]);
});

it("warns from a complete ten-minute CPU window and treats missing CPU data as unknown", async () => {
  const f = await setup({ node_cpu_warning_threshold_ppm: 500000 }),
    at = Date.now(),
    idle = Array<number>(9).fill(0),
    half = Array<number>(9).fill(core);
  await sample(f, 50, at, [2 * core, 2 * core, null, ...half.slice(2)]);
  expect(await runInfrastructureAlerts(env, f.region, at)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await sample(f, 50, at + 1, [...half, core - 10]);
  expect(await runInfrastructureAlerts(env, f.region, at + 1)).toEqual({
    delivered: 0,
    pending: 0,
  });
  await sample(f, 50, at + 2, [...half, core]);
  expect(await runInfrastructureAlerts(env, f.region, at + 2)).toEqual({
    delivered: 0,
    pending: 1,
  });
  expect(await payload(f, "regional_node_cpu_warning")).toMatchObject({
    node_ids: [f.node],
    threshold_ppm: 500000,
    utilization_ppm: 500000,
  });
  await sample(f, 50, at + 3, [...idle, null]);
  await runInfrastructureAlerts(env, f.region, at + 3);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_cpu_warning", active: true },
  ]);
  await sample(f, 50, at + 4, [...idle, 0]);
  await runInfrastructureAlerts(env, f.region, at + 4);
  expect(await infrastructureAlertStatus(env.DB, f.region)).toMatchObject([
    { kind: "regional_node_cpu_warning", active: false },
  ]);
});
