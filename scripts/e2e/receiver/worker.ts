// SPDX-License-Identifier: Apache-2.0
/**
 * The scratch receiver of the data-events acceptance (`scripts/e2e/src/data-events.ts`): an HTTPS
 * endpoint on workers.dev that checks the signature of each PGCF delivery and records it in one
 * SQLite Durable Object, then answers as the mode set through the admin route says (`ok`, `500`,
 * `503` with `Retry-After`, or `410`). It is a fixture of one run and is deleted afterwards. It
 * never logs a body; the signing secret and the admin token are Worker secrets.
 */

const encoder = new TextEncoder();
const SIGNATURE = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
const TOLERANCE_SECONDS = 300;
const MODES = ["ok", "500", "503", "410"] as const;
type Mode = (typeof MODES)[number];

interface SqlCursor {
  toArray(): Record<string, unknown>[];
}
interface SqlStorage {
  exec(query: string, ...bindings: (string | number | null)[]): SqlCursor;
}
interface ReceiverState {
  readonly storage: { readonly sql: SqlStorage };
}
interface ReceiverStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
export interface Env {
  READ_TOKEN: string;
  WEBHOOK_SECRET: string;
  RECEIVER: {
    idFromName(name: string): unknown;
    get(id: unknown): ReceiverStub;
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares without stopping at the first difference, so the time does not show how much matched. */
function equalText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/**
 * Checks `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` with the secret and a clock tolerance of five
 * minutes either way. Written from the delivery format, not from PGCF's signer.
 */
export async function verifySignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
): Promise<boolean> {
  const match = SIGNATURE.exec(header);
  if (match === null || typeof secret !== "string" || secret === "")
    return false;
  const timestamp = Number(match[1]);
  if (!(Math.abs(nowSeconds - timestamp) <= TOLERANCE_SECONDS)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  return equalText(hex(new Uint8Array(mac)), match[2]!);
}

async function sha256Hex(text: string): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** False when the token is unset, so an unset READ_TOKEN never matches `Bearer undefined`. */
function bearerMatches(request: Request, token: string | undefined): boolean {
  return (
    typeof token === "string" &&
    token !== "" &&
    equalText(request.headers.get("Authorization") ?? "", `Bearer ${token}`)
  );
}

/** The status the receiver answers a delivery with: 401 for a bad signature, else the mode's. */
function answerFor(verified: boolean, mode: Mode): number {
  if (!verified) return 401;
  switch (mode) {
    case "ok":
      return 200;
    case "500":
      return 500;
    case "503":
      return 503;
    case "410":
      return 410;
  }
}

/** One Durable Object holds the receipts and the mode, so every request sees the same state. */
export class Receiver {
  readonly #sql: SqlStorage;

  constructor(state: ReceiverState) {
    this.#sql = state.storage.sql;
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      body_sha256 TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      verified INTEGER NOT NULL,
      status INTEGER NOT NULL
    )`);
    this.#sql.exec(`CREATE TABLE IF NOT EXISTS mode (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL,
      retry_after_s INTEGER NOT NULL
    )`);
    this.#sql.exec(
      "INSERT OR IGNORE INTO mode (singleton, mode, retry_after_s) VALUES (1, 'ok', 1)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/record" && request.method === "POST") {
      const record = (await request.json()) as {
        event_id: string;
        delivery_id: string;
        body_sha256: string;
        verified: boolean;
        received_at: number;
      };
      const [prior] = this.#sql
        .exec(
          "SELECT COUNT(*) AS n FROM receipts WHERE delivery_id = ?",
          record.delivery_id,
        )
        .toArray() as { n: number }[];
      const [current] = this.#sql
        .exec("SELECT mode, retry_after_s FROM mode WHERE singleton = 1")
        .toArray() as { mode: Mode; retry_after_s: number }[];
      const status = answerFor(record.verified, current!.mode);
      this.#sql.exec(
        "INSERT INTO receipts (event_id, delivery_id, attempt, body_sha256, received_at, verified, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        record.event_id,
        record.delivery_id,
        (prior?.n ?? 0) + 1,
        record.body_sha256,
        record.received_at,
        record.verified ? 1 : 0,
        status,
      );
      return json({ status, retry_after_s: current!.retry_after_s });
    }
    if (path === "/mode" && request.method === "PUT") {
      const input = (await request.json()) as {
        mode?: unknown;
        retry_after_s?: unknown;
      };
      const mode = MODES.find((candidate) => candidate === input.mode);
      const retryAfter = input.retry_after_s ?? 1;
      if (
        mode === undefined ||
        typeof retryAfter !== "number" ||
        !Number.isInteger(retryAfter) ||
        retryAfter < 0 ||
        retryAfter > 3600
      )
        return json({ code: "invalid_request" }, 400);
      this.#sql.exec(
        "UPDATE mode SET mode = ?, retry_after_s = ? WHERE singleton = 1",
        mode,
        retryAfter,
      );
      return json({ mode, retry_after_s: retryAfter });
    }
    if (path === "/receipts" && request.method === "GET") {
      const rows = this.#sql
        .exec(
          "SELECT event_id, delivery_id, attempt, body_sha256, received_at, verified, status FROM receipts ORDER BY id",
        )
        .toArray();
      return json({
        receipts: rows.map((row) => ({ ...row, verified: row.verified === 1 })),
      });
    }
    return json({ code: "not_found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const receiver = () =>
      env.RECEIVER.get(env.RECEIVER.idFromName("receiver"));
    if (url.pathname.startsWith("/admin/")) {
      if (!bearerMatches(request, env.READ_TOKEN))
        return json({ code: "unauthorized" }, 401);
      if (url.pathname === "/admin/mode" && request.method === "PUT")
        return receiver().fetch("https://receiver/mode", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: await request.text(),
        });
      if (url.pathname === "/admin/receipts" && request.method === "GET")
        return receiver().fetch("https://receiver/receipts");
      return json({ code: "not_found" }, 404);
    }
    if (url.pathname !== "/hook" || request.method !== "POST")
      return json({ code: "not_found" }, 404);
    const body = await request.text();
    const verified = await verifySignature(
      env.WEBHOOK_SECRET,
      request.headers.get("PGCF-Signature") ?? "",
      body,
      Math.floor(Date.now() / 1000),
    );
    const recorded = await receiver().fetch("https://receiver/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: request.headers.get("PGCF-Event-Id") ?? "",
        delivery_id: request.headers.get("PGCF-Delivery-Id") ?? "",
        body_sha256: await sha256Hex(body),
        verified,
        received_at: Date.now(),
      }),
    });
    const { status, retry_after_s } = (await recorded.json()) as {
      status: number;
      retry_after_s: number;
    };
    return new Response(null, {
      status,
      headers: status === 503 ? { "Retry-After": String(retry_after_s) } : {},
    });
  },
};
