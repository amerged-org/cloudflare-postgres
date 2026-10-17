// SPDX-License-Identifier: Apache-2.0
/**
 * The node agent's two local Unix sockets (ULTRA plan 5.7, 5.9, 7.5, 7.8). The Rust gateway and
 * the archive clients implement them (`pgcf_native_protocol::agent`, `apps/pgcf-archive`); the
 * conformance vectors in `native/node-local.generated.json` hold both to this file.
 *
 * The gateway channel is one stream of JSON lines. The agent sends its whole table first and then
 * every change of it, the results of the wakes the gateway queued, and its quiesce, close, status
 * and activity requests; the gateway sends the wakes of held connections and its answers. A
 * database's writer is its PostgreSQL unit: the socket it listens on, the database's own uid and
 * the unit's main PID, which the gateway compares with the kernel's peer credentials of every
 * connection, and the unit's invocation ID, which the route names.
 *
 * The archive socket serves `pgcf-archive %p` (archive_command) and `pgcf-wal-fetch %f %p`
 * (restore_command): one request line and one answer line. The agent knows the database by the
 * uid of the connection. `ok` to an archive request means that the segment is durable in R2 and
 * in the agent's upload log; only then does PostgreSQL mark it done.
 */
import { z } from "zod";
import { DatabaseId, OperationId } from "./ids.ts";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const Positive = z.number().int().min(1).max(MAX_SAFE);
const Count = z.number().int().nonnegative().max(MAX_SAFE);

// ---------- Gateway channel ----------

/** Where the agent serves the gateway channel; only the gateway's user may connect. */
export const AGENT_GATEWAY_SOCKET = "/run/pgcf/agent/gateway.sock";
/** The longest line either side sends: a table of many databases. */
export const AGENT_CHANNEL_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** The most databases one table names. */
export const AGENT_CHANNEL_MAX_DATABASES = 10_000;
/** Below the 104 bytes of `sun_path` on every supported system. */
export const UNIX_SOCKET_PATH_MAX_BYTES = 100;
/** A delivered wake without a result is delivered again after this long. */
export const WAKE_REDELIVER_MS = 3_000;

/** Phases of a wake on the node, in order; wake results and wake events time them in ms. */
export const WAKE_PHASES = [
  "admission",
  "queue_wait",
  "pg_control",
  "mount",
  "start",
  "release",
] as const;
export type WakePhase = (typeof WAKE_PHASES)[number];
/**
 * `started`: the agent started the database's unit, and its table entry releases the held
 * connections. `refused`: the held connections answer 57P03 and the result names the reason.
 */
export const WAKE_OUTCOMES = ["started", "refused"] as const;
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number];
/**
 * Every reason a wake result may name; the node runtime uses `no_room` (storage), `no_headroom`
 * (awake capacity), `deleted`, `mount_failed`, `start_timeout`, `release_failed` and
 * `identity_mismatch`. The others are the Kubernetes mode's until the gateway drops it.
 */
export const WAKE_REASONS = [
  "no_desired_row",
  "not_sleeping",
  "wake_in_progress",
  "desired_stale",
  "no_room",
  "thick_storage",
  "volume_identity_missing",
  "no_power_record",
  "no_sleep_record",
  "image_changed",
  "configuration_changed",
  "no_free_slot",
  "no_headroom",
  "gateways_not_ready",
  "agent_unavailable",
  "holder_busy",
  "volume_open",
  "volume_suspended",
  "volume_missing",
  "uuid_mismatch",
  "unclean",
  "control_version",
  "identity_mismatch",
  "container_missing",
  "mount_failed",
  "audit_failed",
  "bind_failed",
  "start_timeout",
  "sql_identity_mismatch",
  "release_failed",
  "deleted",
  "not_in_region",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

const utf8 = new TextEncoder();
export const UnixSocketPath = z
  .string()
  .startsWith("/")
  .refine(
    (path) =>
      utf8.encode(path).length <= UNIX_SOCKET_PATH_MAX_BYTES &&
      !path.includes("\0") &&
      !path.split("/").includes(".."),
    { message: "A socket path is absolute, short and has no parent step" },
  );

/** The PostgreSQL unit that serves a database. */
export const UnitWriter = z.strictObject({
  socket: UnixSocketPath,
  /** The database's own Linux user; never root. */
  uid: z.number().int().min(1).max(0xffff_ffff),
  /** The unit's main PID, the postmaster; never PID 1. */
  pid: z.number().int().min(2).max(0xffff_ffff),
  /** The unit's systemd invocation ID as a UUID; the route names it. */
  instance: z.uuid(),
});
export type UnitWriter = z.infer<typeof UnitWriter>;

/**
 * What the database's PostgreSQL does for its clients: `running` at its generation, `quiesce`
 * while a sleep is proven (nothing new is admitted), `sleeping` after a proven sleep (a wake
 * ticket of the next generation wakes it), `retired` when deleted, moved or superseded.
 */
export const GatewayMode = z.enum([
  "running",
  "quiesce",
  "sleeping",
  "retired",
]);
export type GatewayMode = z.infer<typeof GatewayMode>;

export const GatewayTableEntry = z
  .strictObject({
    database: DatabaseId,
    /** The generation D1 names for the database on this node. */
    generation: Positive,
    /** The operation of that generation. */
    operation: OperationId,
    mode: GatewayMode,
    /** The admission route revision the gateway admits routes of. */
    route_revision: Positive,
    /** The unit, exactly while it runs or quiesces. */
    writer: UnitWriter.optional(),
  })
  .refine(
    (entry) =>
      (entry.mode === "running" || entry.mode === "quiesce") ===
      (entry.writer !== undefined),
    {
      path: ["writer"],
      message: "A writer is named exactly while PostgreSQL runs",
    },
  );
export type GatewayTableEntry = z.infer<typeof GatewayTableEntry>;

/** A held connection's wake (route v5), as the gateway queues it. */
export const WakeRequest = z.strictObject({
  database: DatabaseId,
  operation: OperationId,
  generation: Positive,
  route_revision: Positive,
  role_revision_hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Gateway wall clock when the first connection of this wake was queued. */
  queued_at_ms: Count,
});
export type WakeRequest = z.infer<typeof WakeRequest>;

export const WakeResult = z
  .strictObject({
    database: DatabaseId,
    operation: OperationId,
    generation: Positive,
    outcome: z.enum(WAKE_OUTCOMES),
    reason: z.enum(WAKE_REASONS).optional(),
    /** Measured steps; the agent names the phases of `WAKE_PHASES`. */
    steps_ms: z
      .record(
        z.string().regex(/^[a-z_]{1,32}$/),
        z.number().int().min(0).max(600_000),
      )
      .refine((steps) => Object.keys(steps).length <= 16, {
        message: "At most 16 steps",
      })
      .optional(),
  })
  .refine(
    (result) =>
      (result.outcome === "refused") === (result.reason !== undefined),
    { path: ["reason"], message: "Exactly a refusal names its reason" },
  );
export type WakeResult = z.infer<typeof WakeResult>;

/** What the agent asks of the sessions of one database. */
export const ControlAction = z.enum(["begin", "close", "status"]);
export type ControlAction = z.infer<typeof ControlAction>;

/** From the agent to the gateway. */
export const AgentMessage = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("table"),
      databases: z.array(GatewayTableEntry).max(AGENT_CHANNEL_MAX_DATABASES),
    })
    .refine(
      (table) =>
        new Set(table.databases.map((entry) => entry.database)).size ===
        table.databases.length,
      { path: ["databases"], message: "A table names each database once" },
    ),
  z.strictObject({ type: z.literal("database"), database: GatewayTableEntry }),
  z.strictObject({ type: z.literal("removed"), database: DatabaseId }),
  z.strictObject({ type: z.literal("wake_result"), result: WakeResult }),
  z.strictObject({
    type: z.literal("control"),
    id: Count,
    action: ControlAction,
    database: DatabaseId,
    generation: Positive,
  }),
  z.strictObject({
    type: z.literal("activity"),
    id: Count,
    database: DatabaseId,
  }),
]);
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Where the sessions of a database stand; `mismatch` names another generation or mode. */
export const SessionStatus = z.enum([
  "mismatch",
  "running",
  "retired",
  "closed",
  "idle",
  "busy",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** From the gateway to the agent. */
export const GatewayMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("wake"), wake: WakeRequest }),
  z.strictObject({
    type: z.literal("status"),
    id: Count,
    database: DatabaseId,
    status: SessionStatus,
    connections: Count,
    busy_connections: Count,
    pending_dials: Count,
  }),
  /** The gateway's measurements of the database, as its activity report shows them. */
  z.strictObject({
    type: z.literal("activity"),
    id: Count,
    database: DatabaseId,
    report: z.record(z.string(), z.json()),
  }),
]);
export type GatewayMessage = z.infer<typeof GatewayMessage>;

// ---------- Archive socket ----------

/** Where the agent serves the archive socket to the databases' units. */
export const AGENT_ARCHIVE_SOCKET = "/run/pgcf/agent/archive.sock";
/** Names another archive socket in PostgreSQL's environment. */
export const ARCHIVE_SOCKET_ENVIRONMENT = "PGCF_AGENT_ARCHIVE_SOCKET";
/** The first word of every request. */
export const ARCHIVE_PROTOCOL = "pgcf-archive/1";
/** The longest request or answer line, newline included. */
export const ARCHIVE_MAX_LINE_BYTES = 256;
/** How long the agent gives one upload or fetch before it answers `failed`. */
export const ARCHIVE_AGENT_BOUND_MS = 60_000;
/** How long a client waits for the answer: the agent's bound and the time its answer takes. */
export const ARCHIVE_CLIENT_BOUND_MS = 70_000;

const SEGMENT = "[0-9A-F]{24}";
/** A WAL segment, a timeline history file, a partial segment or a backup history file. */
export const WAL_FILE_NAME_PATTERN = new RegExp(
  `^(?:[0-9A-F]{8}\\.history|${SEGMENT}(?:\\.partial|\\.[0-9A-F]{8}\\.backup)?)$`,
);
/** One file directly in `pg_wal`, as PostgreSQL names a restore target. */
export const WAL_DESTINATION_PATTERN = /^pg_wal\/(?!\.)[A-Za-z0-9._-]{1,64}$/;
/** A failure's short lowercase class for PostgreSQL's log. */
export const ARCHIVE_REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

export const validWalFileName = (name: string): boolean =>
  WAL_FILE_NAME_PATTERN.test(name);
export const validWalDestination = (destination: string): boolean =>
  WAL_DESTINATION_PATTERN.test(destination);

export type ArchiveRequest =
  | { type: "archive"; name: string }
  | { type: "fetch"; name: string; destination: string };
export type ArchiveReply =
  { type: "ok" } | { type: "missing" } | { type: "failed"; reason?: string };

/** The request line, newline included. */
export function formatArchiveRequest(request: ArchiveRequest): string {
  if (
    !validWalFileName(request.name) ||
    (request.type === "fetch" && !validWalDestination(request.destination))
  )
    throw new TypeError("invalid archive request");
  return request.type === "archive"
    ? `${ARCHIVE_PROTOCOL} archive ${request.name}\n`
    : `${ARCHIVE_PROTOCOL} fetch ${request.name} ${request.destination}\n`;
}

/** A request line without its newline, as the agent reads it; null when it is none. */
export function parseArchiveRequest(line: string): ArchiveRequest | null {
  if (utf8.encode(line).length >= ARCHIVE_MAX_LINE_BYTES) return null;
  const words = line.split(" ");
  if (words[0] !== ARCHIVE_PROTOCOL) return null;
  if (
    words.length === 3 &&
    words[1] === "archive" &&
    validWalFileName(words[2]!)
  )
    return { type: "archive", name: words[2]! };
  if (
    words.length === 4 &&
    words[1] === "fetch" &&
    validWalFileName(words[2]!) &&
    validWalDestination(words[3]!)
  )
    return { type: "fetch", name: words[2]!, destination: words[3]! };
  return null;
}

/** The answer line, newline included; a reason outside its class is left out. */
export function formatArchiveReply(reply: ArchiveReply): string {
  if (reply.type !== "failed") return `${reply.type}\n`;
  return reply.reason !== undefined && ARCHIVE_REASON_PATTERN.test(reply.reason)
    ? `failed ${reply.reason}\n`
    : "failed\n";
}

/** An answer line without its newline; null when it is none. */
export function parseArchiveReply(line: string): ArchiveReply | null {
  if (line === "ok" || line === "missing" || line === "failed")
    return { type: line };
  const reason = line.startsWith("failed ") ? line.slice(7) : null;
  return reason !== null && ARCHIVE_REASON_PATTERN.test(reason)
    ? { type: "failed", reason }
    : null;
}
