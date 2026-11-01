// SPDX-License-Identifier: Apache-2.0
// Data events leave with their database: a database.deleted purges the pending data deliveries of
// the database's actor, keeps everything else, and only when a data subscription reaches it. A
// full storage cap refuses a data batch with 503 while platform events still go in. D1 and the
// Durable Objects are real; only the receiver is replaced, by a spy on fetch.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { NodeDataEventReport } from "@pgcf/contracts";
import { WebhookCreated } from "@pgcf/contracts/webhooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  derivedId,
  runWebhookEvents,
} from "../../src/domain/webhook-events.ts";
import type { IngestedEvent } from "../../src/trigger-actor.ts";
import {
  cleanupFixtures,
  fixture,
  nodeRequest,
  request,
  served,
} from "./fixtures.ts";

const RECEIVER = "https://hooks.example.com/pgcf";
let receiver: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  receiver = vi.spyOn(globalThis, "fetch");
  receiver.mockImplementation(async () => new Response(null, { status: 204 }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare(
    "UPDATE webhook_cursors SET cursor=(SELECT CAST(COALESCE(MAX(id),0) AS TEXT) FROM lifecycle_events) WHERE name='lifecycle'",
  ).run();
  await cleanupFixtures();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

const actor = (databaseId: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(databaseId));
const subscribe = (
  f: Fixture,
  body: Record<string, unknown>,
  key = f.integrator,
) => request("/v1/webhooks", key, "POST", { url: RECEIVER, ...body });
const created = async (response: Response) =>
  WebhookCreated.parse(await response.json());
const lifecycle = (databaseId: string, kind: string) =>
  env.DB.prepare(
    "INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at) SELECT id,?,node_id,size_class_id,generation,? FROM databases WHERE id=?",
  )
    .bind(kind, new Date().toISOString(), databaseId)
    .run();
const dataEvent = (
  databaseId: string,
  projectId: string,
  seq: number,
): IngestedEvent => ({
  id: `${databaseId}:1:${seq}`,
  type: "data.orders",
  occurred_at: new Date().toISOString(),
  project_id: projectId,
  database_id: databaseId,
  data: { order: seq },
});
const platformEvent = (
  databaseId: string,
  projectId: string,
): IngestedEvent => ({
  id: "evt_" + "7".repeat(20),
  type: "database.ready",
  occurred_at: new Date().toISOString(),
  project_id: projectId,
  database_id: databaseId,
  data: {},
});
const deliveryId = (event: IngestedEvent, webhookId: string) =>
  derivedId("dlv", `${event.id}|${webhookId}`);
const ingestData = async (
  databaseId: string,
  event: IngestedEvent,
  webhookId: string,
) => {
  const items = [
    {
      event,
      webhookIds: [webhookId],
      deliveryIds: [await deliveryId(event, webhookId)],
    },
  ];
  return runInDurableObject(actor(databaseId), (instance) =>
    instance.ingestBatch(items),
  );
};
const deliveryState = (databaseId: string, id: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    state.storage.sql
      .exec<{ state: string; last_error: string | null }>(
        "SELECT state, last_error FROM deliveries WHERE id=?",
        id,
      )
      .one(),
  );
const deliveryTimes = (databaseId: string, id: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    state.storage.sql
      .exec<{ dead_ms: number | null; next_attempt_ms: number | null }>(
        "SELECT dead_ms, next_attempt_ms FROM deliveries WHERE id=?",
        id,
      )
      .one(),
  );
const counter = (databaseId: string, metric: string) =>
  runInDurableObject(
    actor(databaseId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ value: number }>(
          "SELECT COALESCE(SUM(value),0) AS value FROM counters WHERE metric=?",
          metric,
        )
        .one().value,
  );
const storedEvents = (databaseId: string, eventId: string) =>
  runInDurableObject(
    actor(databaseId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM events WHERE id=?",
          eventId,
        )
        .one().n,
  );
const sentTypes = () =>
  receiver.mock.calls
    .filter(([url]) => String(url) === RECEIVER)
    .map(
      ([, init]) => (JSON.parse(init!.body as string) as { type: string }).type,
    );

it("purges pending data deliveries, keeps a pending platform delivery, and purges only once", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const dataWebhook = await created(
    await subscribe(f, { event_types: ["data.*"] }),
  );
  const platformWebhook = await created(
    await subscribe(f, { event_types: ["database.*"] }),
  );
  const event = dataEvent(id, f.project, 1);
  expect(await ingestData(id, event, dataWebhook.id)).toEqual({
    ok: true,
    created: 1,
  });
  const platform = platformEvent(id, f.project);
  const platformDelivery = await deliveryId(platform, platformWebhook.id);
  await runInDurableObject(actor(id), (instance) =>
    instance.ingest(platform, [platformWebhook.id], [platformDelivery]),
  );

  const dataDelivery = await deliveryId(event, dataWebhook.id);
  const t0 = Date.now();
  expect(
    await runInDurableObject(actor(id), (instance) => instance.purgeData()),
  ).toBe(1);
  const t1 = Date.now();
  expect(await deliveryState(id, dataDelivery)).toEqual({
    state: "dead_lettered",
    last_error: "expired",
  });
  // Dead-lettered now, so the 7-day replay retention counts from the purge and no retry is due.
  const purged = await deliveryTimes(id, dataDelivery);
  expect(purged.dead_ms).toBeGreaterThanOrEqual(t0);
  expect(purged.dead_ms).toBeLessThanOrEqual(t1);
  expect(purged.next_attempt_ms).toBeNull();
  expect(await counter(id, "webhook_deliveries_dead_lettered")).toBe(1);
  // The event rows and the counters of their emission stay: they describe what the database did.
  expect(await storedEvents(id, event.id)).toBe(1);
  expect(await counter(id, "events_emitted")).toBe(2);
  expect((await deliveryState(id, platformDelivery)).state).toBe("pending");

  await runDurableObjectAlarm(actor(id));
  expect(sentTypes()).toEqual(["database.ready"]);
  expect((await deliveryState(id, platformDelivery)).state).toBe("delivered");

  // A second purge finds nothing left to dead-letter and counts nothing twice.
  expect(
    await runInDurableObject(actor(id), (instance) => instance.purgeData()),
  ).toBe(0);
  expect(await counter(id, "webhook_deliveries_dead_lettered")).toBe(1);
});

it("replays a purged data delivery, which is then delivered", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(
    await subscribe(f, { event_types: ["data.*"] }),
  );
  const event = dataEvent(id, f.project, 2);
  await ingestData(id, event, webhook.id);
  await runInDurableObject(actor(id), (instance) => instance.purgeData());

  const delivery = await deliveryId(event, webhook.id);
  expect(
    await runInDurableObject(actor(id), (instance) =>
      instance.replay(delivery),
    ),
  ).toBe("replayed");
  await runDurableObjectAlarm(actor(id));
  expect(sentTypes()).toEqual(["data.orders"]);
  expect((await deliveryState(id, delivery)).state).toBe("delivered");
});

it("creates no actor for a deleted database of a project without data subscriptions", async () => {
  const f = await fixture();
  const { id } = await served(f);
  await subscribe(f, { event_types: ["database.ready"] });
  const idFromName = vi.spyOn(env.TRIGGER_ACTOR, "idFromName");
  await lifecycle(id, "deleted");

  await runWebhookEvents(env);
  expect(idFromName).not.toHaveBeenCalledWith(id);
});

it("purges a deleted database's pending data deliveries when only a data subscription exists", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(
    await subscribe(f, { event_types: ["data.*"] }),
  );
  const event = dataEvent(id, f.project, 3);
  await ingestData(id, event, webhook.id);

  await lifecycle(id, "deleted");
  await runWebhookEvents(env);
  expect(await deliveryState(id, await deliveryId(event, webhook.id))).toEqual({
    state: "dead_lettered",
    last_error: "expired",
  });
});

it("leaves the pending data deliveries of a database that a data subscription does not name", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const other = (await served(f, "other")).id;
  const webhook = await created(
    await subscribe(f, { event_types: ["data.*"], database_ids: [other] }),
  );
  const event = dataEvent(id, f.project, 4);
  await ingestData(id, event, webhook.id);

  await lifecycle(id, "deleted");
  await runWebhookEvents(env);
  expect(
    (await deliveryState(id, await deliveryId(event, webhook.id))).state,
  ).toBe("pending");
});

it("refuses a data batch past the storage cap with 503 while platform events still go in", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const dataWebhook = await created(
    await subscribe(f, { event_types: ["data.*"] }),
  );
  const platformWebhook = await created(
    await subscribe(f, { event_types: ["database.*"] }),
  );
  await runInDurableObject(actor(id), (instance) => {
    instance.storageCap = 0;
  });

  const event = dataEvent(id, f.project, 5);
  expect(await ingestData(id, event, dataWebhook.id)).toEqual({
    ok: false,
    reason: "buffer_full",
  });
  expect(await storedEvents(id, event.id)).toBe(0);
  expect(await counter(id, "events_emitted")).toBe(0);

  const report = NodeDataEventReport.parse({
    database: id,
    events: [
      {
        epoch: 1,
        seq: 6,
        at: new Date().toISOString(),
        topic: "orders",
        payload: { order: 6 },
      },
    ],
  });
  const refused = await nodeRequest(f, "/node/v1/data-events", {
    method: "POST",
    body: report,
  });
  expect(refused.status).toBe(503);
  expect(refused.headers.get("Retry-After")).toBe("30");
  expect(await refused.json()).toMatchObject({
    error: { code: "capacity_exhausted", details: { buffer: "events" } },
  });

  const platform = platformEvent(id, f.project);
  const platformDelivery = await deliveryId(platform, platformWebhook.id);
  expect(
    await runInDurableObject(actor(id), (instance) =>
      instance.ingest(platform, [platformWebhook.id], [platformDelivery]),
    ),
  ).toBe(1);
  expect((await deliveryState(id, platformDelivery)).state).toBe("pending");
});
