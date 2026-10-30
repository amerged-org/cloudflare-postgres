// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  EVENT_PATTERN_MAX_LENGTH,
  eventTypeMatches,
  isValidEventPattern,
  subscriptionWants,
} from "../../src/domain/event-match.ts";

describe("isValidEventPattern", () => {
  it("accepts the wildcard, a segment wildcard and an exact two-segment type", () => {
    expect(isValidEventPattern("*")).toBe(true);
    expect(isValidEventPattern("database.*")).toBe(true);
    expect(isValidEventPattern("database.ready")).toBe(true);
    expect(isValidEventPattern("database_archive.failed_now")).toBe(true);
  });

  it("rejects empty, uppercase, digit, three-segment and whitespace patterns", () => {
    expect(isValidEventPattern("")).toBe(false);
    expect(isValidEventPattern("Database.ready")).toBe(false);
    expect(isValidEventPattern("database2.ready")).toBe(false);
    expect(isValidEventPattern("a.b.c")).toBe(false);
    expect(isValidEventPattern("*.ready")).toBe(false);
    expect(isValidEventPattern("a.*.b")).toBe(false);
    expect(isValidEventPattern("database. ready")).toBe(false);
  });

  it("rejects segments that do not start with a letter or are empty", () => {
    for (const pattern of [
      "_a.b",
      "a._b",
      ".b",
      "a.",
      "a-b.c",
      "1a.b",
      "a.1b",
    ]) {
      expect(isValidEventPattern(pattern)).toBe(false);
    }
  });

  it("enforces a maximum pattern length of 64 characters", () => {
    expect(EVENT_PATTERN_MAX_LENGTH).toBe(64);
    expect(isValidEventPattern("a".repeat(62) + ".*")).toBe(true);
    expect(isValidEventPattern("a".repeat(63) + ".*")).toBe(false);
  });
});

describe("eventTypeMatches", () => {
  it("matches every type with the wildcard", () => {
    expect(eventTypeMatches("*", "database.ready")).toBe(true);
    expect(eventTypeMatches("*", "anything")).toBe(true);
  });

  it("matches only the types one segment below a segment wildcard", () => {
    expect(eventTypeMatches("database.*", "database.ready")).toBe(true);
    expect(eventTypeMatches("database.*", "databases.ready")).toBe(false);
    expect(eventTypeMatches("database.*", "database.ready.now")).toBe(false);
    expect(eventTypeMatches("database.*", "database.")).toBe(false);
    expect(eventTypeMatches("database.*", "database")).toBe(false);
  });

  it("matches an exact two-segment pattern only against itself", () => {
    expect(eventTypeMatches("database.ready", "database.ready")).toBe(true);
    expect(eventTypeMatches("database.ready", "database.suspended")).toBe(
      false,
    );
    for (const type of [
      "database.ready_now",
      "database.ready.now",
      "x.database.ready",
      "other.ready",
      "Database.Ready",
    ]) {
      expect(eventTypeMatches("database.ready", type)).toBe(false);
    }
  });

  it("never matches with an invalid pattern", () => {
    expect(eventTypeMatches("Database.ready", "Database.ready")).toBe(false);
    expect(eventTypeMatches("a.*.b", "a.x.b")).toBe(false);
  });
});

describe("subscriptionWants", () => {
  const event = { type: "database.ready", database_id: "db_one" };

  it("wants an event when a type pattern matches and the database list is unrestricted", () => {
    expect(
      subscriptionWants(
        { event_types: ["database.*"], database_ids: null },
        event,
      ),
    ).toBe(true);
    expect(
      subscriptionWants(
        { event_types: ["x.y", "*"], database_ids: null },
        event,
      ),
    ).toBe(true);
  });

  it("wants nothing when no type pattern matches", () => {
    expect(
      subscriptionWants(
        { event_types: ["database.suspended"], database_ids: null },
        event,
      ),
    ).toBe(false);
  });

  it("treats null and an empty database list differently", () => {
    expect(
      subscriptionWants({ event_types: ["*"], database_ids: null }, event),
    ).toBe(true);
    expect(
      subscriptionWants({ event_types: ["*"], database_ids: [] }, event),
    ).toBe(false);
    expect(
      subscriptionWants(
        { event_types: ["*"], database_ids: ["db_one"] },
        event,
      ),
    ).toBe(true);
    expect(
      subscriptionWants(
        { event_types: ["*"], database_ids: ["db_two"] },
        event,
      ),
    ).toBe(false);
  });

  it("wants nothing when the event types list is empty", () => {
    expect(
      subscriptionWants({ event_types: [], database_ids: null }, event),
    ).toBe(false);
  });
});
