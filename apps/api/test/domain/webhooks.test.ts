// SPDX-License-Identifier: Apache-2.0
// Webhooks end to end in the Workers runtime: the routes, the sealed secret, the producer that
// reads the lifecycle log and the finished operations, and the TriggerActor that delivers from its
// alarm. D1 and the Durable Objects are real; only the receiver is replaced, by a spy on fetch.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  WebhookCreated,
  WebhookDelivery,
  WebhookEnvelope,
  WebhookTestResult,
} from "@pgcf/contracts/webhooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWebhookEvents } from "../../src/domain/webhook-events.ts";
import { verifyWebhookSignature } from "../../src/domain/webhook-signing.ts";
import {
  cleanupFixtures,
  fixture,
  refusal,
  request,
  served,
} from "./fixtures.ts";

const RECEIVER = "https://hooks.example.com/pgcf";
type Fixture = Awaited<ReturnType<typeof fixture>>;
let receiver: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;
const answer = (status: number, headers?: HeadersInit) =>
  receiver.mockImplementation(
    async () => new Response(null, { status, headers }),
  );

beforeEach(() => {
  receiver = vi.spyOn(globalThis, "fetch");
  answer(204);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare(
    "UPDATE webhook_cursors SET cursor=(SELECT CAST(COALESCE(MAX(id),0) AS TEXT) FROM lifecycle_events) WHERE name='lifecycle'",
  ).run();
  await cleanupFixtures();
});

const subscribe = (
  f: Fixture,
  body: Record<string, unknown> = {},
  key = f.integrator,
  idempotency?: string,
) =>
  request(
    "/v1/webhooks",
    key,
    "POST",
    { url: RECEIVER, event_types: ["database.*", "operation.*"], ...body },
    idempotency,
  );
const created = async (response: Response) =>
  WebhookCreated.parse(await response.json());
const sentTo = (url: string) =>
  receiver.mock.calls
    .filter(([target]) => String(target) === url)
    .map(([, init]) => ({
      init: init!,
      body: JSON.parse(init!.body as string) as Record<string, unknown>,
      headers: new Headers(init!.headers),
    }));
const lifecycle = (databaseId: string, kind: string) =>
  env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,?,node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(kind, new Date().toISOString(), databaseId)
    .run();
const unthrottle = (webhookId: string) =>
  env.DB.prepare(
    "UPDATE webhook_subscriptions SET last_tested_at = NULL WHERE id = ?",
  )
    .bind(webhookId)
    .run();
const actor = (databaseId: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(databaseId));
const deliveries = async (f: Fixture, databaseId: string) =>
  (
    (await (
      await request(
        `/v1/databases/${databaseId}/webhook-deliveries?limit=100`,
        f.integrator,
      )
    ).json()) as { data: unknown[] }
  ).data.map((row) => WebhookDelivery.parse(row));

it("creates a webhook, shows the secret once and never again", async () => {
  const f = await fixture();
  const response = await subscribe(f, {
    headers: { Authorization: "Bearer receiver-token" },
  });
  expect(response.status).toBe(201);
  const webhook = await created(response);
  expect(webhook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  expect(webhook.project_id).toBe(f.project);
  expect(webhook.header_names).toEqual(["Authorization"]);
  expect(response.headers.get("Location")).toBe(`/v1/webhooks/${webhook.id}`);

  const read = await request(`/v1/webhooks/${webhook.id}`, f.integrator);
  const text = await read.text();
  expect(read.status).toBe(200);
  expect(text).not.toContain("whsec_");
  expect(text).not.toContain("receiver-token");
  const stored = await env.DB.prepare(
    "SELECT secret_ciphertext, headers_ciphertext FROM webhook_subscriptions WHERE id=?",
  )
    .bind(webhook.id)
    .first<{ secret_ciphertext: string; headers_ciphertext: string }>();
  expect(stored?.secret_ciphertext).not.toContain(webhook.secret);
  expect(stored?.headers_ciphertext).not.toContain("receiver-token");
});

it("replays an idempotent creation with the same webhook and secret", async () => {
  const f = await fixture();
  const first = await created(await subscribe(f, {}, f.integrator, "create-1"));
  const again = await created(await subscribe(f, {}, f.integrator, "create-1"));
  expect(again).toEqual(first);
  const other = await subscribe(
    f,
    { event_types: ["*"] },
    f.integrator,
    "create-1",
  );
  expect(await refusal(other)).toMatchObject({
    status: 409,
    code: "idempotency_conflict",
  });
});

it("keeps webhooks inside their project and asks an administrator for the project", async () => {
  const f = await fixture();
  const webhook = await created(await subscribe(f));
  expect((await request(`/v1/webhooks/${webhook.id}`, f.otherKey)).status).toBe(
    404,
  );
  expect(
    (await request(`/v1/webhooks/${webhook.id}`, f.otherKey, "DELETE")).status,
  ).toBe(404);
  const foreign = (await (
    await request("/v1/webhooks", f.otherKey)
  ).json()) as { data: unknown[] };
  expect(foreign.data).toEqual([]);

  expect((await subscribe(f, {}, f.admin)).status).toBe(400);
  const byAdmin = await created(
    await subscribe(f, { project_id: f.project }, f.admin),
  );
  expect(byAdmin.project_id).toBe(f.project);
  const listed = (await (
    await request(`/v1/webhooks?project_id=${f.project}`, f.admin)
  ).json()) as {
    data: { id: string }[];
  };
  expect(listed.data.map((row) => row.id).sort()).toEqual(
    [webhook.id, byAdmin.id].sort(),
  );

  expect(
    (await request(`/v1/webhooks/${webhook.id}`, f.integrator, "DELETE"))
      .status,
  ).toBe(204);
  expect(
    (await request(`/v1/webhooks/${webhook.id}`, f.integrator)).status,
  ).toBe(404);
});

it("refuses targets and settings that would be unsafe or unusable", async () => {
  const f = await fixture();
  for (const url of [
    "http://hooks.example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://user:pw@hooks.example.com/x",
  ])
    expect((await subscribe(f, { url })).status, url).toBe(400);
  expect(
    (await subscribe(f, { headers: { "PGCF-Signature": "x" } })).status,
  ).toBe(400);
  expect(
    (await subscribe(f, { headers: { Host: "evil.example.com" } })).status,
  ).toBe(400);
  expect((await subscribe(f, { event_types: ["database"] })).status).toBe(400);
  expect(
    (await subscribe(f, { database_ids: ["abcdefghijklmnopqrst"] })).status,
  ).toBe(400);
});

it("sends a signed test event with the static headers and reports the receiver's answer", async () => {
  const f = await fixture();
  const webhook = await created(
    await subscribe(f, { headers: { "X-Api-Key": "k-123" } }),
  );
  const result = WebhookTestResult.parse(
    await (
      await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST")
    ).json(),
  );
  expect(result).toMatchObject({ delivered: true, status: 204, error: null });
  const [call] = sentTo(RECEIVER);
  const signature = call!.headers.get("PGCF-Signature")!;
  const raw = call!.init.body as string;
  expect(
    await verifyWebhookSignature(
      webhook.secret,
      signature,
      raw,
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  expect(call!.init.redirect).toBe("manual");
  expect(call!.headers.get("X-Api-Key")).toBe("k-123");
  expect(call!.headers.get("Content-Type")).toBe("application/json");
  expect(WebhookEnvelope.parse(call!.body)).toMatchObject({
    type: "webhook.test",
    database_id: null,
  });

  await unthrottle(webhook.id);
  answer(500);
  const failed = WebhookTestResult.parse(
    await (
      await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST")
    ).json(),
  );
  expect(failed).toMatchObject({
    delivered: false,
    status: 500,
    error: "http",
  });
  await unthrottle(webhook.id);
  receiver.mockRejectedValue(
    Object.assign(new Error("x"), { name: "TimeoutError" }),
  );
  const slow = WebhookTestResult.parse(
    await (
      await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST")
    ).json(),
  );
  expect(slow).toMatchObject({
    delivered: false,
    status: null,
    error: "timeout",
  });
});

it("turns lifecycle rows into signed deliveries exactly once", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(await subscribe(f));
  await lifecycle(id, "ready");
  expect((await runWebhookEvents(env)).delivered_to_actors).toBeGreaterThan(0);
  // The same rows read again give the same events, not more.
  const before = (await deliveries(f, id)).length;
  await env.DB.prepare(
    "UPDATE webhook_cursors SET cursor='0' WHERE name='lifecycle'",
  ).run();
  await runWebhookEvents(env);
  expect((await deliveries(f, id)).length).toBe(before);

  const ready = (await deliveries(f, id)).find(
    (row) => row.event_type === "database.ready",
  )!;
  expect(ready).toMatchObject({
    state: "pending",
    attempts: 0,
    webhook_id: webhook.id,
  });
  await runDurableObjectAlarm(actor(id));

  const [call] = sentTo(RECEIVER).filter(
    (sent) => sent.body["type"] === "database.ready",
  );
  const envelope = WebhookEnvelope.parse(call!.body);
  expect(envelope).toMatchObject({
    id: ready.event_id,
    database_id: id,
    project_id: f.project,
  });
  expect(call!.headers.get("PGCF-Event-Id")).toBe(ready.event_id);
  expect(call!.headers.get("PGCF-Delivery-Id")).toBe(ready.id);
  expect(
    await verifyWebhookSignature(
      webhook.secret,
      call!.headers.get("PGCF-Signature")!,
      call!.init.body as string,
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  const after = (await deliveries(f, id)).find((row) => row.id === ready.id)!;
  expect(after).toMatchObject({
    state: "delivered",
    attempts: 1,
    last_status: 204,
    next_attempt_at: null,
  });
});

it("announces finished operations but not the operations PGCF starts for itself", async () => {
  const f = await fixture();
  const { id, operation } = await served(f);
  await created(await subscribe(f, { event_types: ["operation.*"] }));
  // The producer reads operations a little after they finished (a row can commit late), and a new
  // installation starts its cursor at the present: put it before this operation.
  await env.DB.prepare(
    "UPDATE webhook_cursors SET cursor=? WHERE name='operations'",
  )
    .bind(`${new Date(Date.now() - 600_000).toISOString()}|`)
    .run();
  const now = new Date(Date.now() - 120_000).toISOString();
  await env.DB.prepare(
    "UPDATE operations SET status='succeeded', completed_at=?, updated_at=? WHERE id=?",
  )
    .bind(now, now, operation)
    .run();
  await runWebhookEvents(env);
  const rows = await deliveries(f, id);
  expect(rows.map((row) => row.event_type)).toEqual(["operation.succeeded"]);
  await runDurableObjectAlarm(actor(id));
  const [call] = sentTo(RECEIVER);
  expect(call!.body["data"]).toMatchObject({
    operation_id: operation,
    kind: "database.create",
    error_code: null,
  });
});

it("sends an event only to the subscriptions that want it", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const wide = await created(
    await subscribe(f, { event_types: ["database.slept"] }),
  );
  await created(
    await subscribe(f, {
      url: "https://narrow.example.com/h",
      event_types: ["database.ready"],
    }),
  );
  await created(
    await subscribe(f, {
      url: "https://elsewhere.example.com/h",
      event_types: ["*"],
      database_ids: [id],
    }),
  );
  await lifecycle(id, "hibernated");
  await runWebhookEvents(env);
  await runDurableObjectAlarm(actor(id));
  expect(sentTo(RECEIVER).map((sent) => sent.body["type"])).toEqual([
    "database.slept",
  ]);
  expect(sentTo("https://narrow.example.com/h")).toEqual([]);
  expect(
    sentTo("https://elsewhere.example.com/h").map((sent) => sent.body["type"]),
  ).toContain("database.slept");
  expect(wide.event_types).toEqual(["database.slept"]);
});

it("retries a failing receiver on the schedule, dead-letters a rejection and replays on request", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await created(await subscribe(f, { event_types: ["database.*"] }));
  await lifecycle(id, "woke");
  await runWebhookEvents(env);

  answer(503, { "Retry-After": "120" });
  const began = Date.now();
  await runDurableObjectAlarm(actor(id));
  const retrying = (await deliveries(f, id)).find(
    (row) => row.event_type === "database.woke",
  )!;
  expect(retrying).toMatchObject({
    state: "pending",
    attempts: 1,
    last_status: 503,
    last_error: "http",
  });
  const wait = Date.parse(retrying.next_attempt_at!) - began;
  expect(wait).toBeGreaterThan(110_000);
  expect(wait).toBeLessThan(130_000);
  const refused = await request(
    `/v1/databases/${id}/webhook-deliveries/${retrying.id}/replay`,
    f.integrator,
    "POST",
  );
  expect(await refusal(refused)).toMatchObject({
    status: 409,
    code: "conflict",
  });

  // A receiver that rejects the request for good ends the retries at once.
  await lifecycle(id, "suspended");
  await runWebhookEvents(env);
  answer(404);
  await runDurableObjectAlarm(actor(id));
  const dead = (await deliveries(f, id)).find(
    (row) => row.event_type === "database.suspended",
  )!;
  expect(dead).toMatchObject({
    state: "dead_lettered",
    last_status: 404,
    last_error: "permanent",
  });

  const replayed = await request(
    `/v1/databases/${id}/webhook-deliveries/${dead.id}/replay`,
    f.integrator,
    "POST",
  );
  expect(replayed.status).toBe(202);
  answer(200);
  await runDurableObjectAlarm(actor(id));
  const again = (await deliveries(f, id)).find((row) => row.id === dead.id)!;
  expect(again).toMatchObject({
    state: "delivered",
    attempts: 1,
    last_status: 200,
    last_error: null,
  });
});

it("dead-letters a delivery whose subscription is gone", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(
    await subscribe(f, { event_types: ["database.*"] }),
  );
  await lifecycle(id, "ready");
  await runWebhookEvents(env);
  expect(
    (await request(`/v1/webhooks/${webhook.id}`, f.integrator, "DELETE"))
      .status,
  ).toBe(204);
  await runDurableObjectAlarm(actor(id));
  const row = (await deliveries(f, id)).find(
    (entry) => entry.event_type === "database.ready",
  )!;
  expect(row).toMatchObject({
    state: "dead_lettered",
    last_error: "permanent",
  });
  expect(sentTo(RECEIVER)).toEqual([]);
});

it("does not show another project's deliveries", async () => {
  const f = await fixture();
  const { id } = await served(f);
  expect(
    (await request(`/v1/databases/${id}/webhook-deliveries`, f.otherKey))
      .status,
  ).toBe(404);
});

it("lets a delivery that cannot be prepared follow the retry schedule, uncounted, until it expires", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(
    await subscribe(f, { event_types: ["database.*"] }),
  );
  await env.DB.prepare(
    "UPDATE webhook_subscriptions SET secret_ciphertext='AAAA' WHERE id=?",
  )
    .bind(webhook.id)
    .run();
  await lifecycle(id, "ready");
  await runWebhookEvents(env);
  const began = Date.now();
  await runDurableObjectAlarm(actor(id));
  const row = (await deliveries(f, id)).find(
    (entry) => entry.event_type === "database.ready",
  )!;
  expect(row.state).toBe("pending");
  const wait = Date.parse(row.next_attempt_at!) - began;
  expect(wait).toBeGreaterThan(55_000);
  expect(wait).toBeLessThan(65_000);
  expect(receiver).not.toHaveBeenCalled();
  const counted = await runInDurableObject(
    actor(id),
    (_i, state) =>
      state.storage.sql
        .exec<{ value: number }>(
          "SELECT COALESCE(SUM(value),0) AS value FROM counters WHERE metric='webhook_attempts'",
        )
        .one().value,
  );
  expect(counted).toBe(0);

  // Out of its 24 hours, it is dead-lettered like any other delivery.
  await runInDurableObject(actor(id), (_i, state) => {
    state.storage.sql.exec(
      "UPDATE deliveries SET window_start_ms = window_start_ms - 90000000, next_attempt_ms = ?",
      Date.now() - 1,
    );
  });
  await runDurableObjectAlarm(actor(id));
  expect(
    (await deliveries(f, id)).find(
      (entry) => entry.event_type === "database.ready",
    ),
  ).toMatchObject({
    state: "dead_lettered",
    last_error: "expired",
  });
});

it("holds a project to twenty webhooks even when creates race", async () => {
  const f = await fixture();
  for (let i = 0; i < 19; i += 1)
    expect(
      (await subscribe(f, { url: `https://hooks.example.com/${i}` })).status,
    ).toBe(201);
  const results = await Promise.all(
    [0, 1, 2].map((i) =>
      subscribe(f, { url: `https://race.example.com/${i}` }),
    ),
  );
  expect(results.map((response) => response.status).sort()).toEqual([
    201, 409, 409,
  ]);
  const listed = (await (
    await request("/v1/webhooks?limit=100", f.integrator)
  ).json()) as { data: unknown[] };
  expect(listed.data).toHaveLength(20);
});

it("tests a webhook at most once every five seconds", async () => {
  const f = await fixture();
  const webhook = await created(await subscribe(f));
  expect(
    (await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST"))
      .status,
  ).toBe(200);
  expect(
    await refusal(
      await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST"),
    ),
  ).toMatchObject({
    status: 429,
    code: "rate_limited",
  });
  expect(sentTo(RECEIVER)).toHaveLength(1);
  await env.DB.prepare(
    "UPDATE webhook_subscriptions SET last_tested_at = ? WHERE id = ?",
  )
    .bind(new Date(Date.now() - 6_000).toISOString(), webhook.id)
    .run();
  expect(
    (await request(`/v1/webhooks/${webhook.id}/test`, f.integrator, "POST"))
      .status,
  ).toBe(200);
});
