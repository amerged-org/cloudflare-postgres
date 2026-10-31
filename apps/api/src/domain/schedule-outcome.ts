// SPDX-License-Identifier: Apache-2.0
import { isObject } from "@pgcf/contracts/edge-sql";

export type JobOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "outcome_unknown"
  | "capacity_refused"
  | "rejected";

export interface JobClassification {
  outcome: JobOutcome;
  sqlstate: string | null;
  retryAfterSeconds: number | null;
}

/** Nothing ran: the database or the node has no room now, so a later retry is safe. */
const CAPACITY_SQLSTATES: ReadonlySet<string> = new Set([
  "57P03",
  "08006",
  "53300",
]);
/** Configuration: retrying the same request cannot succeed. */
const REJECTED_SQLSTATES: ReadonlySet<string> = new Set([
  "28P01",
  "28000",
  "3D000",
  "0A000",
  "08P01",
]);

/**
 * Classifies one answer of the Edge's `POST /sql`. A request that reached the Edge may have been
 * forwarded, so any answer that is neither a clear result nor a clear refusal is an unknown outcome.
 */
export function classifyJobResponse(input: {
  status: number | null;
  body: unknown;
  retryAfterSeconds: number | null;
}): JobClassification {
  const { status, body, retryAfterSeconds } = input;
  if (status === null) return classified("outcome_unknown", null, null);
  if (status === 200) return classified("succeeded", null, null);
  if (status === 400 && isObject(body) && typeof body.code === "string") {
    const sqlstate = body.code;
    if (sqlstate === "57014") return classified("timed_out", sqlstate, null);
    if (sqlstate === "08007")
      return classified("outcome_unknown", sqlstate, null);
    if (CAPACITY_SQLSTATES.has(sqlstate))
      return classified("capacity_refused", sqlstate, retryAfterSeconds);
    if (REJECTED_SQLSTATES.has(sqlstate))
      return classified("rejected", sqlstate, null);
    return classified("failed", sqlstate, null);
  }
  if (status === 429)
    return classified("capacity_refused", null, retryAfterSeconds);
  if (status === 401 || status === 403 || status === 404)
    return classified("rejected", null, null);
  if (status === 400) return classified("rejected", null, null);
  return classified("outcome_unknown", null, null);
}

function classified(
  outcome: JobOutcome,
  sqlstate: string | null,
  retryAfterSeconds: number | null,
): JobClassification {
  return {
    outcome,
    sqlstate,
    retryAfterSeconds:
      outcome === "capacity_refused" ? retryAfterSeconds : null,
  };
}

/**
 * The request for one job: the statements run as one transaction that starts with a
 * `SET LOCAL statement_timeout`, in the format the Edge parses for the Neon driver's `transaction()`.
 * The connection string carries the password and goes into a header only.
 */
export function buildJobRequest(input: {
  connectionString: string;
  statements: readonly string[];
  timeoutMs: number;
}): { headers: Record<string, string>; body: string } {
  const { connectionString, statements, timeoutMs } = input;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000)
    throw new RangeError("timeoutMs must be an integer from 1000 to 900000");
  // `Array.from` turns holes into undefined, which the typeof check then rejects; `.some` would skip them.
  if (
    statements.length < 1 ||
    statements.length > 255 ||
    Array.from(statements).some(
      (statement) =>
        typeof statement !== "string" || statement.trim().length === 0,
    )
  )
    throw new RangeError("statements must hold 1 to 255 non-empty strings");
  const queries = [
    `SET LOCAL statement_timeout = ${timeoutMs}`,
    ...statements,
  ].map((query) => ({ query, params: [] }));
  return {
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connectionString,
      "Neon-Raw-Text-Output": "true",
      "Neon-Array-Mode": "true",
    },
    body: JSON.stringify({ queries }),
  };
}
