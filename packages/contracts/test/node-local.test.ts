// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_MAX_LINE_BYTES,
  AgentMessage,
  GatewayMessage,
  WAKE_OUTCOMES,
  WAKE_REASONS,
  formatArchiveReply,
  formatArchiveRequest,
  parseArchiveReply,
  parseArchiveRequest,
  validWalDestination,
  validWalFileName,
} from "../src/node-local.ts";

const database = "a".repeat(20),
  operation = `op_${"b".repeat(20)}`;
const writer = {
  socket: `/run/pgcf/${database}/.s.PGSQL.5432`,
  uid: 61_001,
  pid: 4242,
  instance: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
};
const entry = (mode: string, unit?: object) => ({
  database,
  generation: 3,
  operation,
  mode,
  route_revision: 7,
  ...(unit ? { writer: unit } : {}),
});

describe("the agent's gateway channel", () => {
  it("names a writer exactly while PostgreSQL runs", () => {
    for (const [mode, unit, valid] of [
      ["running", writer, true],
      ["quiesce", writer, true],
      ["sleeping", undefined, true],
      ["retired", undefined, true],
      ["running", undefined, false],
      ["sleeping", writer, false],
    ] as const)
      expect(
        AgentMessage.safeParse({
          type: "database",
          database: entry(mode, unit),
        }).success,
      ).toBe(valid);
  });

  it("refuses a writer the gateway cannot check against the kernel", () => {
    for (const broken of [
      { socket: "relative/.s.PGSQL.5432" },
      { socket: `/${"a".repeat(100)}` },
      { socket: "/run/pgcf/../etc/.s.PGSQL.5432" },
      { socket: "/run/pgcf/a\0/.s.PGSQL.5432" },
      { uid: 0 },
      { pid: 1 },
      { instance: "0f6c2d8e5b7a4c1e9a3b2d4e6f8a0b1c" },
    ])
      expect(
        AgentMessage.safeParse({
          type: "database",
          database: entry("running", { ...writer, ...broken }),
        }).success,
      ).toBe(false);
  });

  it("names each database once in a table and nothing unknown", () => {
    expect(
      AgentMessage.safeParse({
        type: "table",
        databases: [entry("running", writer), entry("sleeping")],
      }).success,
    ).toBe(false);
    expect(
      AgentMessage.safeParse({ type: "removed", database, extra: 1 }).success,
    ).toBe(false);
    expect(
      AgentMessage.safeParse({ type: "removed", database: "A".repeat(20) })
        .success,
    ).toBe(false);
  });

  it("refuses a wake only with a reason and starts it without one", () => {
    const result = { database, operation, generation: 4 };
    expect(
      AgentMessage.safeParse({
        type: "wake_result",
        result: { ...result, outcome: "refused", reason: "no_headroom" },
      }).success,
    ).toBe(true);
    expect(
      AgentMessage.safeParse({
        type: "wake_result",
        result: { ...result, outcome: "started", steps_ms: { start: 61 } },
      }).success,
    ).toBe(true);
    for (const broken of [
      { outcome: "refused" },
      { outcome: "refused", reason: "busy" },
      { outcome: "started", reason: "no_room" },
      { outcome: "started", steps_ms: { Start: 1 } },
      { outcome: "started", steps_ms: { start: 600_001 } },
      { outcome: "hit" },
      { outcome: "miss", reason: "no_room" },
    ])
      expect(
        AgentMessage.safeParse({
          type: "wake_result",
          result: { ...result, ...broken },
        }).success,
      ).toBe(false);
    expect(WAKE_OUTCOMES).toEqual(["started", "refused"]);
    expect(WAKE_REASONS).toContain("no_room");
  });

  it("carries the gateway's held wakes and its answers", () => {
    expect(
      GatewayMessage.safeParse({
        type: "wake",
        wake: {
          database,
          operation,
          generation: 4,
          route_revision: 7,
          role_revision_hash: "c".repeat(64),
          queued_at_ms: 1_760_000_000_000,
        },
      }).success,
    ).toBe(true);
    expect(
      GatewayMessage.safeParse({
        type: "status",
        id: 9,
        database,
        status: "idle",
        connections: 2,
        busy_connections: 0,
        pending_dials: 0,
      }).success,
    ).toBe(true);
    expect(
      GatewayMessage.safeParse({
        type: "wake",
        wake: {
          database,
          operation,
          generation: 4,
          route_revision: 7,
          role_revision_hash: "C".repeat(64),
          queued_at_ms: 1,
        },
      }).success,
    ).toBe(false);
  });
});

describe("the agent's archive socket", () => {
  it("accepts exactly the WAL files PostgreSQL archives", () => {
    for (const name of [
      "000000010000000000000003",
      "0000000A00000001000000FF",
      "00000002.history",
      "000000010000000000000003.partial",
      "000000010000000000000003.00000028.backup",
    ])
      expect(validWalFileName(name)).toBe(true);
    for (const name of [
      "",
      "00000001000000000000000",
      "0000000a0000000000000003",
      "000000010000000000000003.backup",
      "../00000002.history",
      "00000002.history.partial",
      "RECOVERYXLOG",
    ])
      expect(validWalFileName(name)).toBe(false);
    expect(validWalDestination("pg_wal/RECOVERYXLOG")).toBe(true);
    for (const destination of [
      "pg_wal/",
      "pg_wal/../postgresql.conf",
      "pg_wal/a/b",
      "pg_wal/.hidden",
      "/pg_wal/RECOVERYXLOG",
      "pg_wal/RECOVERY XLOG",
    ])
      expect(validWalDestination(destination)).toBe(false);
  });

  it("speaks one request line and one answer line", () => {
    const fetch = {
      type: "fetch" as const,
      name: "00000002.history",
      destination: "pg_wal/RECOVERYHISTORY",
    };
    expect(formatArchiveRequest(fetch)).toBe(
      "pgcf-archive/1 fetch 00000002.history pg_wal/RECOVERYHISTORY\n",
    );
    expect(
      parseArchiveRequest("pgcf-archive/1 archive 000000010000000000000003"),
    ).toEqual({ type: "archive", name: "000000010000000000000003" });
    for (const line of [
      "pgcf-archive/1 archive 000000010000000000000003 extra",
      "pgcf-archive/2 archive 000000010000000000000003",
      "pgcf-archive/1 archive  000000010000000000000003",
      "pgcf-archive/1 fetch 000000010000000000000003 base/1",
      "pgcf-archive/1 delete 000000010000000000000003",
      `pgcf-archive/1 fetch 000000010000000000000003 pg_wal/${"a".repeat(ARCHIVE_MAX_LINE_BYTES)}`,
    ])
      expect(parseArchiveRequest(line)).toBeNull();
    expect(parseArchiveReply("failed upload_timeout")).toEqual({
      type: "failed",
      reason: "upload_timeout",
    });
    for (const line of ["OK", "failed ", "ok ", "failed Access Denied"])
      expect(parseArchiveReply(line)).toBeNull();
    // A reason outside its class is never sent.
    expect(
      formatArchiveReply({ type: "failed", reason: "Access Denied\n" }),
    ).toBe("failed\n");
    expect(formatArchiveReply({ type: "ok" })).toBe("ok\n");
  });
});
