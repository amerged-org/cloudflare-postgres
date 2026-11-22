// SPDX-License-Identifier: Apache-2.0
// The Edge loads this module, so it imports no zod. Cause, fix and retry advice of each reason are
// in `error-guide.ts`, which the Edge does not load.

/**
 * Why the Edge refuses a connection or an HTTP query before it reaches PostgreSQL. A SQLSTATE
 * alone names one of several causes; the closed reason is appended to the message, as
 * `... (pgcf: rate_limited)`, so a client that shows only the message still learns the cause.
 * An unknown or deleted database, an unknown role and a wrong password are one refusal by design
 * (28P01 `password authentication failed`) and carry no reason.
 */
export const CONNECTION_REFUSALS = {
  rate_limited: {
    sqlstate: "53300",
    message: "connection rate limit exceeded",
  },
  database_rate_limited: {
    sqlstate: "53300",
    message: "database connection rate limit exceeded",
  },
  admission_unavailable: {
    sqlstate: "53300",
    message: "connection admission unavailable",
  },
  wake_deadline: { sqlstate: "57P03", message: "database is not ready yet" },
  database_not_accepting: {
    sqlstate: "57P03",
    message: "database is not accepting connections",
  },
  gateway_unavailable: {
    sqlstate: "08006",
    message: "gateway connection failed",
  },
  admission_interrupted: {
    sqlstate: "08006",
    message: "connection admission interrupted",
  },
  duplicate_hint: {
    sqlstate: "08P01",
    message: "duplicate connection admission hint",
  },
  method_not_allowed: { sqlstate: "08P01", message: "HTTP SQL requires POST" },
  invalid_database_id: {
    sqlstate: "3D000",
    message: "database does not exist",
  },
  invalid_role_name: { sqlstate: "28P01", message: "authentication failed" },
} as const satisfies Record<string, { sqlstate: string; message: string }>;

export type ConnectionRefusalReason = keyof typeof CONNECTION_REFUSALS;

/** The message of a refusal: the PostgreSQL-style text and the closed reason. */
export function refusalMessage(reason: ConnectionRefusalReason): string {
  return `${CONNECTION_REFUSALS[reason].message} (pgcf: ${reason})`;
}
