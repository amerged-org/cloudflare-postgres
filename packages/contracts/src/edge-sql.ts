// SPDX-License-Identifier: Apache-2.0
// Portable HTTP SQL request reading (`POST /sql`, the Neon serverless driver's HTTP query mode);
// no Workers host types. The TypeScript Edge (`apps/edge/src/sql.ts`) serves it and the Rust Edge
// (`apps/edge-rust/src/sql.rs`) is held to it by the vectors of `native/generate-edge.ts`.
import { isDatabaseId, isRoleName } from "./ids.ts";

/** The largest body the gateway accepts (`MAX_REQUEST_BYTES` in the gateway's sql.rs). */
export const MAX_SQL_REQUEST_BYTES = 4 * 1024 * 1024;
/** The most statements of one transaction (`MAX_STATEMENTS` in the gateway's sql.rs). */
export const MAX_SQL_STATEMENTS = 256;
const ISOLATION_LEVELS = new Set([
  "ReadUncommitted",
  "ReadCommitted",
  "RepeatableRead",
  "Serializable",
]);

export class SqlFailure extends Error {
  readonly code: string;
  readonly severity: string;
  constructor(code: string, message: string, severity = "ERROR") {
    super(message);
    this.code = code;
    this.severity = severity;
  }
}
export const invalid = () =>
  new SqlFailure("08P01", "invalid HTTP SQL request");
export const authenticationFailed = () =>
  new SqlFailure("28P01", "password authentication failed", "FATAL");
export const unknownOutcome = () =>
  new SqlFailure(
    "08007",
    "the gateway's answer was lost; the request's outcome is unknown and it was not retried",
  );

export interface Connection {
  readonly database: string;
  readonly user: string;
  readonly password: string;
}
export interface Statement {
  readonly query: string;
  readonly params: (string | null)[];
}
export interface Transaction {
  isolation?: string;
  read_only?: boolean;
  deferrable?: boolean;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The database, role and password of `Neon-Connection-String`; its host and options are not used. */
export function connection(headers: Headers): Connection {
  let url: URL;
  try {
    url = new URL(headers.get("Neon-Connection-String") ?? "");
  } catch {
    throw invalid();
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw invalid();
  let database: string, user: string, password: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw invalid();
  }
  if (!isDatabaseId(database))
    throw new SqlFailure("3D000", "database does not exist");
  if (!isRoleName(user)) throw new SqlFailure("28P01", "authentication failed");
  if (password === "") throw authenticationFailed();
  return { database, user, password };
}

/** What the driver always sends, and a batch's transaction characteristics. */
export function transaction(headers: Headers): Transaction {
  if (
    headers.get("Neon-Raw-Text-Output")?.toLowerCase() !== "true" ||
    headers.get("Neon-Array-Mode")?.toLowerCase() !== "true"
  )
    throw new SqlFailure(
      "0A000",
      "only raw text results in array mode are supported",
    );
  if (headers.has("Authorization"))
    throw new SqlFailure("0A000", "authorization tokens are not supported");
  const characteristics: Transaction = {};
  const isolation = headers.get("Neon-Batch-Isolation-Level");
  if (isolation !== null) {
    if (!ISOLATION_LEVELS.has(isolation)) throw invalid();
    characteristics.isolation = isolation;
  }
  for (const [header, key] of [
    ["Neon-Batch-Read-Only", "read_only"],
    ["Neon-Batch-Deferrable", "deferrable"],
  ] as const) {
    const value = headers.get(header);
    if (value === null) continue;
    if (value !== "true" && value !== "false") throw invalid();
    characteristics[key] = value === "true";
  }
  return characteristics;
}

/** The body as text: UTF-8 without a byte order mark, or an invalid request. */
export function decodeBody(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    throw invalid();
  }
}

function statement(value: unknown): Statement {
  if (
    !isObject(value) ||
    typeof value.query !== "string" ||
    !Object.keys(value).every((key) => key === "query" || key === "params")
  )
    throw invalid();
  const params = value.params ?? [];
  if (!Array.isArray(params)) throw invalid();
  return {
    query: value.query,
    // The driver sends text or null; other JSON scalars are sent as their text.
    params: params.map((param: unknown) => {
      if (param === null || typeof param === "string") return param;
      if (typeof param === "number" || typeof param === "boolean")
        return String(param);
      throw invalid();
    }),
  };
}

/** One statement (`{query, params}`) or a transaction (`{queries}`). */
export function statements(text: string): {
  queries: Statement[];
  batch: boolean;
} {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!isObject(body)) throw invalid();
  if (!("queries" in body)) return { queries: [statement(body)], batch: false };
  if (
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.queries) ||
    body.queries.length > MAX_SQL_STATEMENTS
  )
    throw invalid();
  return { queries: body.queries.map(statement), batch: true };
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The request the gateway receives: the password as base64url, the statements, and a transaction's characteristics. */
export function forwardBody(
  password: string,
  { queries, batch }: { queries: Statement[]; batch: boolean },
  characteristics: Transaction,
): string {
  const body = JSON.stringify({
    password: base64url(password),
    queries,
    ...(batch ? { transaction: characteristics } : {}),
  });
  if (new TextEncoder().encode(body).byteLength > MAX_SQL_REQUEST_BYTES)
    throw new SqlFailure("54000", "request is too large");
  return body;
}
