// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { newDatabaseId, newProjectId } from "../src/ids.ts";
import { SLEEP_REFUSALS, SLEEP_SQL } from "../src/sleep.ts";
import {
  EVENT_PATTERN,
  EventId,
  WebhookDelivery,
  WebhookEnvelope,
  WebhookEventType,
  dataEventId,
  parseDataEventId,
} from "../src/webhooks.ts";

const DB = "abcdefghij0123456789";

describe("EventId", () => {
  it("accepts platform and data ids", () => {
    expect(EventId.safeParse("evt_0123456789abcdef0123").success).toBe(true);
    expect(EventId.safeParse(`${DB}:2:15`).success).toBe(true);
    expect(
      EventId.safeParse(`${DB}:9007199254740991:9007199254740991`).success,
    ).toBe(true);
    for (const id of [
      `${DB}:0:1`,
      `${DB}:1:0`,
      `${DB}:01:1`,
      "x:1:1",
      `${DB}:1:1:1`,
      "Abcdefghij0123456789:1:1",
      "Zabcdefghij0123456789:1:1",
      "1bcdefghij0123456789:1:1",
      "xevt_0123456789abcdef0123",
      "evt_0123456789abcdef012",
      "abcdefghij012345678:1:1",
      "abcdefghij01234567890:1:1",
      `${DB}:10000000000000000:1`,
      `${DB}:1:10000000000000000`,
    ]) {
      expect(EventId.safeParse(id).success, id).toBe(false);
    }
  });
});

describe("dataEventId and parseDataEventId", () => {
  it("builds and parses data event ids", () => {
    expect(dataEventId(DB, 2, 15)).toBe(`${DB}:2:15`);
    for (const [epoch, seq] of [
      [2, 15],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ] as const) {
      const id = dataEventId(DB, epoch, seq);
      expect(EventId.safeParse(id).success).toBe(true);
      expect(parseDataEventId(id)).toEqual({ database_id: DB, epoch, seq });
    }
    expect(parseDataEventId("evt_0123456789abcdef0123")).toBeNull();
    expect(parseDataEventId("")).toBeNull();
    expect(parseDataEventId("abc")).toBeNull();
    expect(parseDataEventId(`${DB}:0:1`)).toBeNull();
    expect(parseDataEventId(`${DB}:9999999999999999:1`)).toBeNull();
    expect(parseDataEventId(`${DB}:1:9999999999999999`)).toBeNull();
  });
});

describe("WebhookEventType", () => {
  it("accepts platform and data event types", () => {
    for (const type of [
      "database.created",
      "webhook.test",
      "data.orders",
      "data.orders2",
      "data.a_b",
      `data.${"a".repeat(48)}`,
    ]) {
      expect(WebhookEventType.safeParse(type).success, type).toBe(true);
    }
    for (const type of [
      "data.",
      "data.Orders",
      "data.2x",
      "data.or-ders",
      "xdata.orders",
      "databases.created",
      "data.orders.x",
      `data.${"a".repeat(49)}`,
      "",
    ]) {
      expect(WebhookEventType.safeParse(type).success, type).toBe(false);
    }
  });
});

describe("EVENT_PATTERN", () => {
  it("matches subscriptions to platform groups, exact types and data topics", () => {
    for (const pattern of [
      "*",
      "database.*",
      "database.ready",
      "data.*",
      "data.orders2",
    ]) {
      expect(EVENT_PATTERN.test(pattern), pattern).toBe(true);
    }
    for (const pattern of [
      "data.2x",
      "database2.ready",
      "a.1b",
      "a.b.c",
      "*.ready",
      "a.*.b",
      "data.",
      "",
    ]) {
      expect(EVENT_PATTERN.test(pattern), pattern).toBe(false);
    }
  });
});

describe("WebhookEnvelope", () => {
  it("carries epoch and seq on data events only", () => {
    const data = WebhookEnvelope.parse({
      id: dataEventId(DB, 2, 15),
      type: "data.orders",
      occurred_at: "2026-10-31T12:00:00.000Z",
      project_id: newProjectId(),
      database_id: DB,
      epoch: 2,
      seq: 15,
      data: { n: 1 },
    });
    expect(data.epoch).toBe(2);
    expect(data.seq).toBe(15);

    const platform = WebhookEnvelope.parse({
      id: "evt_0123456789abcdef0123",
      type: "database.ready",
      occurred_at: "2026-10-31T12:00:00.000Z",
      project_id: newProjectId(),
      database_id: newDatabaseId(),
      data: {},
    });
    expect(platform).not.toHaveProperty("epoch");
    expect(platform).not.toHaveProperty("seq");

    const envelope = {
      id: dataEventId(DB, 2, 15),
      type: "data.orders",
      occurred_at: "2026-10-31T12:00:00.000Z",
      project_id: newProjectId(),
      database_id: DB,
      data: {},
    };
    for (const extra of [
      { epoch: 0, seq: 1 },
      { epoch: 1, seq: 0 },
      { epoch: 1.5, seq: 1 },
      { epoch: 1, seq: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(WebhookEnvelope.safeParse({ ...envelope, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      WebhookEnvelope.safeParse({ ...envelope, epoch: 1, seq: 1, extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("WebhookDelivery", () => {
  const delivery = {
    id: "dlv_0123456789abcdef0123",
    event_id: dataEventId(DB, 2, 15),
    event_type: "data.orders",
    webhook_id: "whk_abcdefghij0123456789",
    state: "pending",
    attempts: 0,
    created_at: "2026-10-31T12:00:00.000Z",
    next_attempt_at: null,
    delivered_at: null,
    last_status: null,
    last_error: null,
  };

  it("accepts a data event delivery", () => {
    expect(WebhookDelivery.safeParse(delivery).success).toBe(true);
    expect(
      WebhookDelivery.safeParse({ ...delivery, event_type: "data." }).success,
    ).toBe(false);
  });
});

describe("sleep proof contract", () => {
  const guard = SLEEP_SQL.GUARD;

  it("excludes only the agent events session from the busy count", () => {
    const segment =
      "AND NOT (usename = 'postgres' AND application_name = 'pgcf-agent-events')";
    expect(guard).toContain(segment);
    expect(guard.indexOf(segment)).toBeLessThan(guard.indexOf("AS busy"));
    expect(guard).toContain("AS busy");
    expect(guard).toContain("AS prepared");
    expect(guard).not.toContain(";");
  });

  it("refuses sleep with outbox_pending once", () => {
    expect(SLEEP_REFUSALS).toContain("outbox_pending");
    expect(new Set(SLEEP_REFUSALS).size).toBe(SLEEP_REFUSALS.length);
  });
});
