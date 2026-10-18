// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  ADMISSION_REFUSALS,
  ADMISSION_REFUSAL_DETAILS,
  ARCHIVE_MAX_LINE_BYTES,
  AgentMessage,
  GatewayMessage,
  GatewayLocalActivityReport,
  WAKE_AGAIN_REASON,
  WAKE_OUTCOMES,
  WAKE_REASONS,
  refusalFields,
  refusalRetryHint,
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
        result: {
          ...result,
          outcome: "refused",
          reason: "no_headroom",
          retry_after_seconds: 5,
        },
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

  it("names the reasons of the node runtime, those of every hold the contract defines, and none of the Kubernetes mode", () => {
    // Orders hold or refuse wakes (move, maintenance, fence, superseded, suspended), recovery
    // holds an unproven database, and the mount and pg_control steps have their own failures.
    for (const reason of [
      "no_room",
      "no_headroom",
      "deleted",
      "suspended",
      "moving",
      "maintenance",
      "fenced",
      "superseded",
      "unproven",
      "storage_full",
      "desired_stale",
      "wake_in_progress",
      "identity_mismatch",
      "control_version",
      "volume_missing",
      "uuid_mismatch",
      "volume_suspended",
      "volume_open",
      "holder_busy",
      "mount_failed",
      "start_timeout",
      "release_failed",
    ])
      expect(WAKE_REASONS).toContain(reason);
    for (const reason of [
      "no_desired_row",
      "not_sleeping",
      "thick_storage",
      "volume_identity_missing",
      "no_power_record",
      "no_sleep_record",
      "image_changed",
      "configuration_changed",
      "no_free_slot",
      "gateways_not_ready",
      "agent_unavailable",
      "unclean",
      "container_missing",
      "audit_failed",
      "bind_failed",
      "sql_identity_mismatch",
      "not_in_region",
    ])
      expect(WAKE_REASONS).not.toContain(reason);
    expect(new Set(WAKE_REASONS).size).toBe(WAKE_REASONS.length);
    // The one reason that is not an answer: the gateway asks again.
    expect(WAKE_REASONS).toContain(WAKE_AGAIN_REASON);
    expect(refusalFields(WAKE_AGAIN_REASON)).toEqual({});
  });

  it("sends the DETAIL of an admission refusal and the HINT of its retry hint with the 57P03", () => {
    expect(refusalFields("no_headroom", 5)).toEqual({
      detail: "node at awake capacity",
      hint: "retry after 5 s",
    });
    expect(refusalFields("no_room")).toEqual({ detail: "storage" });
    // The other reasons answer the 57P03 alone.
    for (const reason of WAKE_REASONS)
      if (!ADMISSION_REFUSALS.some((refusal) => refusal === reason))
        expect(refusalFields(reason)).toEqual({});
  });

  it("gives the retry hint of the 57P03 to exactly the refusal of awake capacity", () => {
    const result = { database, operation, generation: 4, outcome: "refused" };
    expect(refusalRetryHint("no_headroom")).toBe(true);
    expect(refusalRetryHint("no_room")).toBe(false);
    expect(
      ADMISSION_REFUSALS.map((reason) => ADMISSION_REFUSAL_DETAILS[reason]),
    ).toEqual(["storage", "node at awake capacity"]);
    for (const [fields, valid] of [
      [{ reason: "no_headroom", retry_after_seconds: 5 }, true],
      [{ reason: "no_room" }, true],
      [{ reason: "moving" }, true],
      [{ reason: "no_headroom" }, false],
      [{ reason: "no_room", retry_after_seconds: 5 }, false],
      [{ reason: "no_headroom", retry_after_seconds: 0 }, false],
      [{ reason: "no_headroom", retry_after_seconds: 301 }, false],
      [{ outcome: "started", retry_after_seconds: 5 }, false],
    ] as const)
      expect(
        AgentMessage.safeParse({
          type: "wake_result",
          result: { ...result, ...fields },
        }).success,
      ).toBe(valid);
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

describe("the gateway's activity report", () => {
  const at = "2026-10-17T12:00:00.000Z",
    since = "2026-10-17T11:00:00.000Z";
  const report = {
    processEpoch: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
    epoch: "1a6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
    startedAt: since,
    counterStartedAt: since,
    observedAt: at,
    history: "complete",
    countersSince: since,
    ingressBytes: 10,
    egressBytes: 20,
    totalConnections: 3,
    connectionMilliseconds: 4000,
    connections: 2,
    authenticatedConnections: 1,
    busyConnections: 1,
    pendingDials: 1,
    lastActivityAt: "2026-10-17T11:59:00.000Z",
  };
  const unavailable = {
    ...report,
    history: "unavailable",
    countersSince: null,
    ingressBytes: null,
    egressBytes: null,
    totalConnections: null,
    connectionMilliseconds: null,
    lastActivityAt: null,
  };
  const absent = {
    ...report,
    history: "current_process_absence",
    ingressBytes: 0,
    egressBytes: 0,
    totalConnections: 0,
    connectionMilliseconds: 0,
    authenticatedConnections: 0,
    busyConnections: 0,
    lastActivityAt: null,
  };
  const message = (value: unknown) =>
    GatewayMessage.safeParse({
      type: "activity",
      id: 10,
      database,
      report: value,
    }).success;

  it("is exactly the report the gateway sends: its counters and its session counts, no identity", () => {
    expect(message(report)).toBe(true);
    expect(message(unavailable)).toBe(true);
    expect(message(absent)).toBe(true);
    expect(GatewayLocalActivityReport.safeParse(report).success).toBe(true);
    // The old per-pod report named region, database, revision and pod; the local channel names
    // the database in the message and has one gateway.
    for (const extra of [
      { region: "eu-dev" },
      { database },
      { revision: 3 },
      { pod: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c" },
      { busy_connections: 0 },
    ])
      expect(message({ ...report, ...extra })).toBe(false);
    for (const missing of Object.keys(report))
      expect(message({ ...report, [missing]: undefined })).toBe(false);
    // The old untyped blob.
    expect(
      message({ busyConnections: 0, connections: 1, lastActivityAt: at }),
    ).toBe(false);
    for (const value of [null, [1], "report", 1])
      expect(message(value)).toBe(false);
  });

  it("keeps unknown history distinct from measured counters, and activity inside the counter window", () => {
    for (const broken of [
      { counterStartedAt: "2026-10-17T10:00:00.000Z" },
      { observedAt: "2026-10-17T10:30:00.000Z" },
      { countersSince: "2026-10-17T12:30:00.000Z" },
      { lastActivityAt: "2026-10-17T10:59:00.000Z" },
      { lastActivityAt: "2026-10-17T12:00:00.001Z" },
      { authenticatedConnections: 3 },
      { busyConnections: 2 },
      { pendingDials: 3 },
      { ingressBytes: null },
      { countersSince: null },
      { countersSince: "2026-10-17T11:30:00.000Z" },
    ])
      expect(message({ ...report, ...broken })).toBe(false);
    // A partial history may start later than the counters; it still has every counter.
    expect(
      message({
        ...report,
        history: "partial",
        countersSince: "2026-10-17T11:30:00.000Z",
      }),
    ).toBe(true);
    for (const broken of [{ ingressBytes: 0 }, { countersSince: since }])
      expect(message({ ...unavailable, ...broken })).toBe(false);
    // Absence of a record in the running process cannot conceal activity.
    for (const broken of [
      { lastActivityAt: at },
      { ingressBytes: 1 },
      { busyConnections: 1, authenticatedConnections: 1 },
    ])
      expect(message({ ...absent, ...broken })).toBe(false);
  });

  it("numbers requests below 2^53", () => {
    for (const id of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5])
      expect(
        GatewayMessage.safeParse({ type: "activity", id, database, report })
          .success,
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
