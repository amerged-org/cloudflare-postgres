// SPDX-License-Identifier: Apache-2.0
// Data events in the TriggerActor, in the Workers runtime: a batch from the node is stored whole or
// refused whole, its counters move with its rows, the alarm delivers each event signed with its
// epoch and sequence, and a delivery never reaches a subscription of another project. D1 and the
// Durable Objects are real; only the receiver is replaced, by a spy on fetch.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { WebhookCreated, WebhookEnvelope } from "@pgcf/contracts/webhooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { derivedId } from "../../src/domain/webhook-events.ts";
import {
  type IngestedEvent,
  TRIGGER_MAX_PENDING,
  TRIGGER_MAX_PENDING_DATA,
} from "../../src/trigger-actor.ts";
import { cleanupFixtures, fixture, request, served } from "./fixtures.ts";

const RECEIVER = "https://hooks.example.com/pgcf";
let receiver: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  receiver = vi.spyOn(globalThis, "fetch");
  receiver.mockImplementation(async () => new Response(null, { status: 204 }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Item = {
  event: IngestedEvent;
  webhookIds: string[];
  deliveryIds: string[];
};

const actor = (databaseId: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(databaseId));
const subscribe = (
  f: Fixture,
  body: Record<string, unknown> = {},
  key = f.integrator,
) =>
  request("/v1/webhooks", key, "POST", {
    url: RECEIVER,
    event_types: ["data.*"],
    ...body,
  });
const created = async (response: Response) =>
  WebhookCreated.parse(await response.json());
const dataEvent = (
  databaseId: string,
  projectId: string,
  epoch: number,
  seq: number,
  topic: string,
  payload: Record<string, unknown>,
): IngestedEvent => ({
  id: `${databaseId}:${epoch}:${seq}`,
  type: `data.${topic}`,
  occurred_at: new Date().toISOString(),
  project_id: projectId,
  database_id: databaseId,
  data: payload,
});
/** One item for each event: its delivery id is the one the producer derives, once per webhook. */
const itemFor = async (
  event: IngestedEvent,
  webhookIds: string[],
): Promise<Item> => ({
  event,
  webhookIds,
  deliveryIds: await Promise.all(
    webhookIds.map((webhookId) => derivedId("dlv", `${event.id}|${webhookId}`)),
  ),
});
const ingestBatch = (databaseId: string, items: Item[]) =>
  runInDurableObject(actor(databaseId), (instance) =>
    instance.ingestBatch(items),
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
const pendingCount = (databaseId: string) =>
  runInDurableObject(
    actor(databaseId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT count(*) AS n FROM deliveries WHERE state='pending'",
        )
        .one().n,
  );
const remembered = (databaseId: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    Object.fromEntries(
      state.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM meta WHERE key IN ('database_id','project_id')",
        )
        .toArray()
        .map((row) => [row.key, row.value]),
    ),
  );
const deliveryState = (databaseId: string, deliveryId: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    state.storage.sql
      .exec<{ state: string; last_error: string | null }>(
        "SELECT state, last_error FROM deliveries WHERE id=?",
        deliveryId,
      )
      .one(),
  );
/** Stores pending deliveries that will not be due for a long time, so the alarm leaves them. */
const fillPending = (databaseId: string, count: number, prefix: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO events(id,type,occurred_at,project_id,database_id,data) VALUES('filler','data.filler','1970-01-01T00:00:00.000Z','filler','filler','{}')",
    );
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?1)
       INSERT INTO deliveries(id,event_id,webhook_id,state,attempts,created_ms,window_start_ms,next_attempt_ms,dead_ms,last_error)
       SELECT ?3 || i, 'filler', 'whk_filler', 'pending', 0, 0, 0, ?2, NULL, NULL FROM n`,
      count,
      Date.now() + 86_400_000,
      prefix,
    );
  });
const sentTo = () =>
  receiver.mock.calls
    .filter(([url]) => String(url) === RECEIVER)
    .map(([, init]) => init!);

it("stores a data batch once and delivers each event with its epoch and sequence", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const webhook = await created(await subscribe(f));
  const event = dataEvent(id, f.project, 3, 7, "orders", {
    order: 42,
    status: "paid",
  });
  const batch = [await itemFor(event, [webhook.id])];

  expect(await ingestBatch(id, batch)).toEqual({ ok: true, created: 1 });
  // The same batch handed over again stores nothing and counts nothing twice.
  expect(await ingestBatch(id, batch)).toEqual({ ok: true, created: 0 });
  expect(await counter(id, "events_emitted")).toBe(1);
  expect(await counter(id, "event_bytes")).toBe(
    new TextEncoder().encode(JSON.stringify(event.data)).length,
  );

  await runDurableObjectAlarm(actor(id));
  const [call] = sentTo();
  expect(sentTo()).toHaveLength(1);
  expect(WebhookEnvelope.parse(JSON.parse(call!.body as string))).toEqual({
    id: event.id,
    type: "data.orders",
    occurred_at: event.occurred_at,
    project_id: f.project,
    database_id: id,
    epoch: 3,
    seq: 7,
    data: event.data,
  });
  expect(new Headers(call!.headers).get("PGCF-Event-Id")).toBe(event.id);
});

it("refuses a batch whole when it would take the pending buffer past its limit", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const first = await created(await subscribe(f));
  const second = await created(await subscribe(f));
  await fillPending(id, TRIGGER_MAX_PENDING_DATA - 1, "near");

  const event = dataEvent(id, f.project, 1, 1, "orders", { order: 1 });
  const refused = await ingestBatch(id, [
    await itemFor(event, [first.id, second.id]),
  ]);
  expect(refused).toEqual({ ok: false, reason: "buffer_full" });
  expect(await storedEvents(id, event.id)).toBe(0);
  expect(await counter(id, "events_emitted")).toBe(0);
  expect(await pendingCount(id)).toBe(TRIGGER_MAX_PENDING_DATA - 1);

  // A platform event still waits as pending until the platform limit, which is higher.
  const platform = {
    id: "evt_" + "0".repeat(20),
    type: "database.ready",
    occurred_at: new Date().toISOString(),
    project_id: f.project,
    database_id: id,
    data: {},
  };
  const platformDelivery = await derivedId("dlv", `${platform.id}|${first.id}`);
  await runInDurableObject(actor(id), (instance) =>
    instance.ingest(platform, [first.id], [platformDelivery]),
  );
  expect((await deliveryState(id, platformDelivery)).state).toBe("pending");

  await fillPending(id, TRIGGER_MAX_PENDING - TRIGGER_MAX_PENDING_DATA, "rest");
  const overflowing = {
    ...platform,
    id: "evt_" + "1".repeat(20),
  };
  const overflowDelivery = await derivedId(
    "dlv",
    `${overflowing.id}|${first.id}`,
  );
  await runInDurableObject(actor(id), (instance) =>
    instance.ingest(overflowing, [first.id], [overflowDelivery]),
  );
  expect(await deliveryState(id, overflowDelivery)).toEqual({
    state: "dead_lettered",
    last_error: "expired",
  });
});

it("accepts a batch that lands exactly on the pending limit and refuses one delivery more", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const first = await created(await subscribe(f));
  const second = await created(await subscribe(f));
  await fillPending(id, TRIGGER_MAX_PENDING_DATA - 2, "edge");

  const event = dataEvent(id, f.project, 1, 1, "orders", { order: 2 });
  expect(
    await ingestBatch(id, [await itemFor(event, [first.id, second.id])]),
  ).toEqual({ ok: true, created: 2 });
  expect(await pendingCount(id)).toBe(TRIGGER_MAX_PENDING_DATA);
  // The actor records its database and project, so that its counters can be flushed to D1.
  expect(await remembered(id)).toEqual({
    database_id: id,
    project_id: f.project,
  });

  const extra = dataEvent(id, f.project, 1, 2, "orders", { order: 3 });
  expect(await ingestBatch(id, [await itemFor(extra, [first.id])])).toEqual({
    ok: false,
    reason: "buffer_full",
  });
  expect(await pendingCount(id)).toBe(TRIGGER_MAX_PENDING_DATA);
  expect(await storedEvents(id, extra.id)).toBe(0);
});

it("never delivers a data event to a subscription of another project", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const foreign = await created(
    await subscribe(f, { project_id: f.other }, f.admin),
  );
  const event = dataEvent(id, f.project, 1, 1, "orders", { order: 9 });
  const item = await itemFor(event, [foreign.id]);
  expect(await ingestBatch(id, [item])).toEqual({ ok: true, created: 1 });

  await runDurableObjectAlarm(actor(id));
  expect(sentTo()).toEqual([]);
  expect(await deliveryState(id, item.deliveryIds[0]!)).toEqual({
    state: "dead_lettered",
    last_error: "permanent",
  });
});

it("refuses an item whose delivery ids do not pair with its webhooks", async () => {
  const f = await fixture();
  const { id } = await served(f);
  const event = dataEvent(id, f.project, 1, 1, "orders", {});
  await expect(
    ingestBatch(id, [{ event, webhookIds: [], deliveryIds: [] }]),
  ).rejects.toThrow(RangeError);
  await expect(
    ingestBatch(id, [{ event, webhookIds: ["whk_x"], deliveryIds: [] }]),
  ).rejects.toThrow(RangeError);
});
