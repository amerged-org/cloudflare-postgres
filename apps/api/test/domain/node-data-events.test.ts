// SPDX-License-Identifier: Apache-2.0
// `POST /node/v1/data-events`: a node's outbox batch becomes the deliveries of the subscriptions of
// the database's project that want it, all or nothing. The project, the ownership and the
// subscriptions come from D1 and the signed node only. D1 and the Durable Objects are real; only
// the receiver is replaced, by a spy on fetch.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import {
  NODE_FENCED_ERROR,
  NodeFencedResponse,
  newDatabaseId,
} from "@pgcf/contracts";
import {
  newWebhookId,
  WebhookCreated,
  WebhookEnvelope,
} from "@pgcf/contracts/webhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRIGGER_MAX_PENDING_DATA } from "../../src/trigger-actor.ts";
import {
  addNode,
  cleanupFixtures,
  fixture,
  nodeKeyPair,
  nodeRequest,
  request,
  served,
} from "./fixtures.ts";

const RECEIVER = "https://hooks.example.com/pgcf";
const PATH = "/node/v1/data-events";
const PAST = new Date(Date.now() - 60_000).toISOString();
const PAYLOAD_MARKER = "marker-7f3a9c";

let receiver: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  receiver = vi.spyOn(globalThis, "fetch");
  receiver.mockImplementation(async () => new Response(null, { status: 204 }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});

type F = Awaited<ReturnType<typeof fixture>>;
type Event = {
  epoch: number;
  seq: number;
  at: string;
  topic: string;
  payload: Record<string, unknown>;
};

const actor = (databaseId: string) =>
  env.TRIGGER_ACTOR.get(env.TRIGGER_ACTOR.idFromName(databaseId));
const event = (
  seq: number,
  topic = "orders",
  payload: Record<string, unknown> = { order: seq },
  extra: Partial<Event> = {},
): Event => ({ epoch: 3, seq, at: PAST, topic, payload, ...extra });
const report = (database: string, events: Event[]) => ({ database, events });
const post = (
  f: F,
  body: unknown,
  init: Parameters<typeof nodeRequest>[2] = {},
) => nodeRequest(f, PATH, { method: "POST", body, ...init });
const subscribe = (f: F, body: Record<string, unknown>, key = f.integrator) =>
  request("/v1/webhooks", key, "POST", { url: RECEIVER, ...body });
const created = async (response: Response) => {
  expect(response.status).toBe(201);
  return WebhookCreated.parse(await response.json());
};
const sentTo = () =>
  receiver.mock.calls
    .filter(([url]) => String(url) === RECEIVER)
    .map(([, init]) => init!);
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
const storedEvents = (databaseId: string) =>
  runInDurableObject(
    actor(databaseId),
    (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM events")
        .one().n,
  );
const storedEventIds = (databaseId: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>("SELECT id FROM events")
      .toArray()
      .map((row) => row.id),
  );
const deliveryWebhooks = (databaseId: string) =>
  runInDurableObject(actor(databaseId), (_instance, state) =>
    state.storage.sql
      .exec<{ webhook_id: string }>("SELECT webhook_id FROM deliveries")
      .toArray()
      .map((row) => row.webhook_id),
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
/** Stores pending deliveries that will not be due for a long time, so the alarm leaves them. */
const fillPending = (databaseId: string, count: number) =>
  runInDurableObject(actor(databaseId), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT OR IGNORE INTO events(id,type,occurred_at,project_id,database_id,data) VALUES('filler','data.filler','1970-01-01T00:00:00.000Z','filler','filler','{}')",
    );
    sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?1)
       INSERT INTO deliveries(id,event_id,webhook_id,state,attempts,created_ms,window_start_ms,next_attempt_ms,dead_ms,last_error)
       SELECT 'filler' || i, 'filler', 'whk_filler', 'pending', 0, 0, 0, ?2, NULL, NULL FROM n`,
      count,
      Date.now() + 86_400_000,
    );
  });
async function servedDatabase(f: F): Promise<string> {
  const { id } = await served(f);
  const row = await env.DB.prepare("SELECT node_id FROM databases WHERE id=?")
    .bind(id)
    .first<{ node_id: string }>();
  expect(row?.node_id).toBe(f.node);
  return id;
}
/** A node of the region that holds its own key, and so serves none of the fixture's databases. */
async function neighbour(f: F) {
  const key = await nodeKeyPair(),
    node = await addNode(f.region),
    nodeUid = crypto.randomUUID();
  await env.DB.prepare("UPDATE nodes SET node_uid=?, public_key=? WHERE id=?")
    .bind(nodeUid, key.publicKey, node)
    .run();
  return { node, nodeUid, nodeKey: key.privateKey };
}

describe("a batch of a node's data events", () => {
  it("is one delivery to a data.orders subscription, signed with its id, epoch and sequence", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    const webhook = await created(
      await subscribe(f, { event_types: ["data.orders"] }),
    );
    const payload = { order: 42, status: "paid" };
    const response = await post(f, report(id, [event(7, "orders", payload)]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stored: 1, ignored: 0 });
    expect(await deliveryWebhooks(id)).toEqual([webhook.id]);

    await runDurableObjectAlarm(actor(id));
    expect(sentTo()).toHaveLength(1);
    const [call] = sentTo();
    expect(WebhookEnvelope.parse(JSON.parse(call!.body as string))).toEqual({
      id: `${id}:3:7`,
      type: "data.orders",
      occurred_at: PAST,
      project_id: f.project,
      database_id: id,
      epoch: 3,
      seq: 7,
      data: payload,
    });
    expect(new Headers(call!.headers).get("PGCF-Event-Id")).toBe(`${id}:3:7`);
  });

  it("stored once: a batch handed over again changes nothing and counts once", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.orders"] }));
    const body = report(id, [event(1)]);
    expect(await (await post(f, body)).json()).toEqual({
      stored: 1,
      ignored: 0,
    });
    expect(await (await post(f, body)).json()).toEqual({
      stored: 1,
      ignored: 0,
    });
    expect(await storedEvents(id)).toBe(1);
    expect(await deliveryWebhooks(id)).toHaveLength(1);
    expect(await counter(id, "events_emitted")).toBe(1);
  });

  it("matches data.* and an exact data.<topic> but never the platform's '*'", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    const wildcard = await created(await subscribe(f, { event_types: ["*"] }));
    const group = await created(
      await subscribe(f, { event_types: ["data.*"] }),
    );
    const exact = await created(
      await subscribe(f, { event_types: ["data.orders"] }),
    );
    const response = await post(f, report(id, [event(1, "orders")]));
    expect(await response.json()).toEqual({ stored: 1, ignored: 0 });
    expect((await deliveryWebhooks(id)).sort()).toEqual(
      [group.id, exact.id].sort(),
    );
    expect(wildcard.id).not.toBe(group.id);
  });

  it("never reaches a subscription of another project that names this database", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    // The other project's subscription wants every data event, so only its project keeps it out.
    await created(await subscribe(f, { event_types: ["data.*"] }, f.otherKey));
    expect(await (await post(f, report(id, [event(1)]))).json()).toEqual({
      stored: 0,
      ignored: 1,
    });
    expect(await storedEvents(id)).toBe(0);
    expect(await deliveryWebhooks(id)).toEqual([]);
  });

  it("never reaches a subscription of another project that names this database in its row", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    // A row the API would refuse: the other project's subscription, written to D1 directly.
    await env.DB.prepare(
      "INSERT INTO webhook_subscriptions(id,project_id,url,event_types,database_ids,secret_ciphertext,secret_iv,secret_kid,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        newWebhookId(),
        f.other,
        RECEIVER,
        JSON.stringify(["data.*"]),
        JSON.stringify([id]),
        "ciphertext",
        "iv",
        "kid",
        new Date().toISOString(),
      )
      .run();
    expect(await (await post(f, report(id, [event(1)]))).json()).toEqual({
      stored: 0,
      ignored: 1,
    });
    expect(await storedEvents(id)).toBe(0);
    expect(await deliveryWebhooks(id)).toEqual([]);
  });

  it("delivers to a data.* subscription only for the databases it names", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    const { id: second } = await served(f, "second");
    const named = await created(
      await subscribe(f, { event_types: ["data.*"], database_ids: [id] }),
    );
    await created(
      await subscribe(f, { event_types: ["data.*"], database_ids: [second] }),
    );
    expect(await (await post(f, report(id, [event(1)]))).json()).toEqual({
      stored: 1,
      ignored: 0,
    });
    expect(await deliveryWebhooks(id)).toEqual([named.id]);
  });

  it("splits one batch: the wanted event is stored, the unwanted one is ignored", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    const orders = await created(
      await subscribe(f, { event_types: ["data.orders"] }),
    );
    const response = await post(
      f,
      report(id, [event(1, "invoices"), event(2, "orders")]),
    );
    expect(await response.json()).toEqual({ stored: 1, ignored: 1 });
    expect(await storedEventIds(id)).toEqual([`${id}:3:2`]);
    expect(await deliveryWebhooks(id)).toEqual([orders.id]);
    expect(await counter(id, "events_emitted")).toBe(1);
  });

  it("is ignored, with nothing stored, when no subscription of the project wants it", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.invoices"] }));
    expect(
      await (await post(f, report(id, [event(1), event(2)]))).json(),
    ).toEqual({ stored: 0, ignored: 2 });
    expect(await storedEvents(id)).toBe(0);
    expect(await deliveryWebhooks(id)).toEqual([]);
  });

  it("is refused with 409 for a database another node serves, a deleted one or an unknown one", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    const other = await neighbour(f);
    const refused = async (
      signer: Parameters<typeof nodeRequest>[0],
      database: string,
    ) => {
      const response = await nodeRequest(signer, PATH, {
        method: "POST",
        body: report(database, [event(1)]),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: "conflict",
          message: "The database is not served by this node",
          request_id: expect.any(String),
          details: { reason: "generation_changed" },
        },
      });
    };
    await refused(other, id);
    await refused(f, newDatabaseId());
    await env.DB.prepare(
      "UPDATE databases SET desired_state='deleted',deleted_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), id)
      .run();
    await refused(f, id);
    expect(await storedEvents(id)).toBe(0);
    expect(await deliveryWebhooks(id)).toEqual([]);
  });

  it("is refused with 403 node_fenced for a node declared lost", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    await env.DB.prepare(
      "UPDATE nodes SET lost_at=?,lost_reason='test',ready=0,schedulable=0 WHERE id=?",
    )
      .bind(new Date().toISOString(), f.node)
      .run();
    const response = await post(f, report(id, [event(1)]));
    expect(response.status).toBe(403);
    expect(NodeFencedResponse.parse(await response.json())).toEqual({
      error: NODE_FENCED_ERROR,
    });
    expect(await storedEvents(id)).toBe(0);
  });

  it("refuses a malformed, unsorted, empty or oversized batch with 400 and stores nothing", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    const many = Array.from({ length: 101 }, (_, i) => event(i + 1));
    for (const body of [
      { database: id, events: "nope" },
      { database: "not-a-database", events: [event(1)] },
      report(id, []),
      report(id, [event(2), event(1)]),
      report(id, many),
      report(id, [event(1, "Orders")]),
    ]) {
      const response = await post(f, body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    expect(await storedEvents(id)).toBe(0);
  });

  it("clamps an event from the future to now instead of refusing it", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const before = Date.now();
    const response = await post(
      f,
      report(id, [event(1, "orders", {}, { at: future })]),
    );
    expect(await response.json()).toEqual({ stored: 1, ignored: 0 });
    await runDurableObjectAlarm(actor(id));
    const [call] = sentTo();
    const envelope = WebhookEnvelope.parse(JSON.parse(call!.body as string));
    expect(Date.parse(envelope.occurred_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(envelope.occurred_at)).toBeGreaterThanOrEqual(before - 1);
  });

  it("answers 503 capacity_exhausted with nothing stored when the pending buffer would overflow", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    await created(await subscribe(f, { event_types: ["data.orders"] }));
    await fillPending(id, TRIGGER_MAX_PENDING_DATA - 1);
    const response = await post(f, report(id, [event(1)]));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toMatchObject({
      error: { code: "capacity_exhausted", details: { buffer: "events" } },
    });
    // Only the filler row of fillPending is stored; the batch is not.
    expect(await storedEvents(id)).toBe(1);
    expect(await pendingCount(id)).toBe(TRIGGER_MAX_PENDING_DATA - 1);
    expect(await counter(id, "events_emitted")).toBe(0);
  });

  it("logs the count of a batch and never its topic or payload", async () => {
    const f = await fixture();
    const id = await servedDatabase(f);
    await created(await subscribe(f, { event_types: ["data.*"] }));
    const logged = [
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const response = await post(
      f,
      report(id, [event(1, "ledgerrows", { note: PAYLOAD_MARKER })]),
    );
    expect(await response.json()).toEqual({ stored: 1, ignored: 0 });
    const lines = logged.flatMap((spy) =>
      spy.mock.calls.map((args) => args.map(String).join(" ")),
    );
    expect(lines.join("\n")).not.toContain(PAYLOAD_MARKER);
    expect(lines.join("\n")).not.toContain("ledgerrows");
    const ingested = lines.find((line) =>
      line.includes("data_events_ingested"),
    );
    expect(JSON.parse(ingested!)).toEqual({
      event: "data_events_ingested",
      database_id: id,
      stored: 1,
      ignored: 0,
    });
  });
});
