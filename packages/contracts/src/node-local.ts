// SPDX-License-Identifier: Apache-2.0
/**
 * The node agent's two local Unix sockets (ULTRA plan 5.7, 5.9, 7.5, 7.8). The Rust gateway and
 * the archive clients implement them (`pgcf_native_protocol::agent`, `apps/pgcf-archive`); the
 * conformance vectors in `native/node-local.generated.json` hold both to this file.
 *
 * The gateway channel is one stream of JSON lines. The agent sends its whole table first and then
 * every change of it, the results of the wakes the gateway queued, and its quiesce, close, status
 * and activity requests; the gateway sends the wakes of held connections, its answers and the
 * stage marks of the connections that were held. A database's writer is its PostgreSQL unit: the
 * socket it listens on, the database's own uid and the unit's main PID, which the gateway compares
 * with the kernel's peer credentials of every connection, and the unit's invocation ID, which the
 * route names.
 *
 * The archive socket serves `pgcf-archive %p` (archive_command) and `pgcf-wal-fetch %f %p`
 * (restore_command): one request line and one answer line. The agent knows the database by the
 * uid of the connection. `ok` to an archive request means that the segment is durable in R2 and
 * in the agent's upload log; only then does PostgreSQL mark it done.
 */
import { z } from "zod";
import { Timestamp } from "./api.ts";
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
 * connections. `refused`: the held connections answer 57P03 and the result names the reason,
 * except for `WAKE_AGAIN_REASON`.
 */
export const WAKE_OUTCOMES = ["started", "refused"] as const;
export type WakeOutcome = (typeof WAKE_OUTCOMES)[number];
/**
 * Every reason a wake result, a failed wake order and a wake event may name. `no_room` (the room
 * rule, 57P03 "storage") and `no_headroom` (the wait for awake capacity expired) are the
 * admission refusals of plan 4.6. The holds and states that refuse a wake follow: `deleted`;
 * `suspended` (a manual suspend never wakes on connect); `moving` (the hold of a move source);
 * `maintenance`; `fenced`; `superseded` (a retired storage generation); `unproven` (recovery
 * pending or running, plan 7.10); `storage_full` (the volume cannot start). Then the checks of
 * the wake itself: `desired_stale` (the ticket names another generation than the agent's),
 * `wake_in_progress`, `identity_mismatch` and `control_version` (`pg_control` against the
 * proven-sleep record), the mount (`volume_missing`, `volume_suspended`, `mount_failed`),
 * `start_timeout` and `release_failed`.
 */
export const WAKE_REASONS = [
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
  "volume_suspended",
  "mount_failed",
  "start_timeout",
  "release_failed",
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];
/**
 * The one reason that is not an answer: the agent already serves this wake (or has not yet looked
 * at the database in this run), so the held connections keep waiting for the answer of the first
 * delivery and the gateway delivers the ticket again after `WAKE_REDELIVER_MS`.
 */
export const WAKE_AGAIN_REASON = "wake_in_progress" satisfies WakeReason;

/** The refusals of the admission loop (plan 4.6). */
export const ADMISSION_REFUSALS = ["no_room", "no_headroom"] as const;
/**
 * The DETAIL of the 57P03 that answers each admission refusal. The gateway sends it with every
 * refused held connection; the other reasons of `WAKE_REASONS` have no detail.
 */
export const ADMISSION_REFUSAL_DETAILS = {
  no_room: "storage",
  no_headroom: "node at awake capacity",
} as const satisfies Record<(typeof ADMISSION_REFUSALS)[number], string>;
/**
 * Only the wait for awake capacity has a retry hint (policy `retry_after_seconds`): the gateway
 * sends it as the HINT `retry after <n> s`. `no_room` and every other reason carry none, because
 * waiting does not make room.
 */
export const refusalRetryHint = (reason: WakeReason): boolean =>
  reason === "no_headroom";

/**
 * What the gateway sends with the 57P03 of a refused wake besides its message: the DETAIL of an
 * admission refusal and, with a retry hint, the HINT `retry after <n> s`. Every other reason
 * answers the 57P03 alone.
 */
export function refusalFields(
  reason: WakeReason,
  retryAfterSeconds?: number,
): { detail?: string; hint?: string } {
  const detail = (
    ADMISSION_REFUSAL_DETAILS as Partial<Record<WakeReason, string>>
  )[reason];
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(refusalRetryHint(reason) && retryAfterSeconds !== undefined
      ? { hint: `retry after ${retryAfterSeconds} s` }
      : {}),
  };
}

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
    /** The HINT of the 57P03, exactly with `no_headroom` (`refusalRetryHint`). */
    retry_after_seconds: z.number().int().min(1).max(300).optional(),
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
  )
  .refine(
    (result) =>
      (result.retry_after_seconds !== undefined) ===
      (result.reason !== undefined && refusalRetryHint(result.reason)),
    {
      path: ["retry_after_seconds"],
      message: "Exactly the refusal of awake capacity carries a retry hint",
    },
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

/** `complete`, `partial` and `current_process_absence` have counters; `unavailable` has none. */
export const GATEWAY_ACTIVITY_HISTORIES = [
  "complete",
  "partial",
  "current_process_absence",
  "unavailable",
] as const;
/**
 * The counters and session counts of one database, as the gateway reports them (apps/native-gateway
 * telemetry): cumulative since `countersSince` within one counter run, which `processEpoch` and
 * `epoch` name. A counter the gateway cannot know is null, never zero.
 */
export const GATEWAY_ACTIVITY_FIELDS = {
  processEpoch: z.uuid(),
  epoch: z.uuid(),
  startedAt: Timestamp,
  counterStartedAt: Timestamp,
  observedAt: Timestamp,
  history: z.enum(GATEWAY_ACTIVITY_HISTORIES),
  countersSince: Timestamp.nullable(),
  ingressBytes: Count.nullable(),
  egressBytes: Count.nullable(),
  totalConnections: Count.nullable(),
  connectionMilliseconds: Count.nullable(),
  connections: Count,
  authenticatedConnections: Count,
  busyConnections: Count,
  pendingDials: Count,
  lastActivityAt: Timestamp.nullable(),
};
const ActivityFields = z.strictObject(GATEWAY_ACTIVITY_FIELDS);
/** The rules of an activity report that no JSON Schema states. */
export function refineGatewayActivity(
  report: z.infer<typeof ActivityFields>,
  context: z.RefinementCtx,
): void {
  const start = Date.parse(report.startedAt),
    counter = Date.parse(report.counterStartedAt),
    observed = Date.parse(report.observedAt);
  const since =
    report.countersSince === null ? null : Date.parse(report.countersSince);
  const activity =
    report.lastActivityAt === null ? null : Date.parse(report.lastActivityAt);
  const metrics = [
    report.ingressBytes,
    report.egressBytes,
    report.totalConnections,
    report.connectionMilliseconds,
  ];
  if (
    counter < start ||
    observed < counter ||
    (since !== null && (since < counter || since > observed)) ||
    (activity !== null && (activity < counter || activity > observed))
  )
    context.addIssue({
      code: "custom",
      message: "Activity timestamps do not describe the current counter window",
    });
  if (
    report.authenticatedConnections > report.connections ||
    report.busyConnections > report.authenticatedConnections ||
    report.pendingDials > report.connections
  )
    context.addIssue({
      code: "custom",
      message: "Activity session counts exceed actual connections",
    });
  if (
    report.history === "unavailable"
      ? since !== null || metrics.some((value) => value !== null)
      : since === null || metrics.some((value) => value === null)
  )
    context.addIssue({
      code: "custom",
      message: "Unknown history must remain distinct from measured counters",
    });
  if (
    (report.history === "complete" ||
      report.history === "current_process_absence") &&
    report.countersSince !== report.counterStartedAt
  )
    context.addIssue({
      code: "custom",
      message: "Complete history must begin at actual counter initialization",
    });
  if (
    report.history === "current_process_absence" &&
    (activity !== null ||
      metrics.some((value) => value !== 0) ||
      report.authenticatedConnections !== 0 ||
      report.busyConnections !== 0)
  )
    context.addIssue({
      code: "custom",
      message: "Current process absence cannot conceal activity",
    });
}
export const GatewayLocalActivityReport = ActivityFields.superRefine(
  refineGatewayActivity,
);
export type GatewayLocalActivityReport = z.infer<
  typeof GatewayLocalActivityReport
>;

/** A fixed class of the gateway's log: lowercase words, no text. */
const StageToken = z.string().regex(/^[a-z0-9_]{1,48}$/);

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
  /**
   * The gateway's measurements of the database. The agent decides idle sleep from `lastActivityAt`
   * and the session counts, and turns the counters into the usage rows of its usage report.
   */
  z.strictObject({
    type: z.literal("activity"),
    id: Count,
    database: DatabaseId,
    report: GatewayLocalActivityReport,
  }),
  /**
   * The stage marks of one connection that waited for its database's wake: the gateway's
   * `conn_stages` line, sent when the connection ends, for the connections held for a wake only.
   * The agent logs it as the event `conn_stages` (plan 9.9), so the wait a client sees for a cold
   * wake (`wake_wait_ms`, then `dial_ms` and `first_backend_ms`) reaches Cloudflare beside the
   * agent's own steps. It holds numbers and fixed tokens, never text, an address or a role. A mark
   * the connection did not reach is absent.
   */
  z.strictObject({
    type: z.literal("conn_stages"),
    database: DatabaseId,
    /** How the connection ended: a fixed class of the gateway's log. */
    outcome: StageToken,
    /** How the wait for the wake ended: `released`, `refused`, `client_closed` and the like. */
    held_outcome: StageToken.optional(),
    /** The reason of the agent's refusal, when it refused the wake. */
    wake_reason: z.enum(WAKE_REASONS).optional(),
    upgrade_ms: Count.optional(),
    startup_ms: Count.optional(),
    dial_ms: Count.optional(),
    first_backend_ms: Count.optional(),
    wake_wait_ms: Count.optional(),
    session_ms: Count.optional(),
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
/**
 * `missing` tells PostgreSQL where the archived WAL ends, so recovery stops there and promotes:
 * the agent answers it only when R2 reports the object absent (barman-cloud-wal-restore "not
 * found"). Every other outcome is `failed` and aborts the recovery: an R2 or barman error, an
 * expired credential, a timeout. A transient error must never end a recovery early. For a move
 * target (`DatabaseOrigin`) an absent segment up to `origin.source.end.last_archived_segment` is
 * `failed` as well, because the archive must hold every segment through it.
 */
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
