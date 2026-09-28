// SPDX-License-Identifier: Apache-2.0
export type AccountingEnv = Cloudflare.Env & {
  ALLOWANCE_FENCE_KEYS?: string;
};
export type AccountingDb = D1DatabaseSession;
export type JsonObject = Record<string, unknown>;
export const meters = [
  "cpu_millicore_ms",
  "memory_byte_ms",
  "data_storage_byte_ms",
  "backup_storage_byte_ms",
  "wal_storage_byte_ms",
  "transfer_in_bytes",
  "transfer_out_bytes",
] as const;
export type Meter = (typeof meters)[number];
export type UnitVector = Partial<Record<Meter, string>>;
export const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
export function error(status: number, code: string): Response {
  return json({ error: { code } }, status);
}
export function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is JsonObject {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key))
  );
}
export function unsigned(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})$/.test(value);
}
export function vector(value: unknown): UnitVector | null {
  if (!object(value) || Object.keys(value).length === 0) return null;
  if (
    !Object.entries(value).every(
      ([key, quantity]) =>
        (meters as readonly string[]).includes(key) && unsigned(quantity),
    )
  )
    return null;
  return Object.fromEntries(
    meters
      .filter((meter) => Object.hasOwn(value, meter))
      .map((meter) => [meter, value[meter]]),
  ) as UnitVector;
}
export function timestamp(
  value: unknown,
  minuteAligned = false,
): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) &&
    new Date(parsed).toISOString() === value &&
    (!minuteAligned || parsed % 60_000 === 0)
    ? parsed
    : null;
}
export async function body(request: Request, maximum = 8192): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    ) ||
    !request.body
  )
    return null;
  if (Number(request.headers.get("content-length")) > maximum) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let content = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(content + decoder.decode()) as unknown;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        return null;
      }
      content += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
export function bearer(request: Request): string | null {
  return (
    /^Bearer ([^\s]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1] ?? null
  );
}
export async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function token(prefix: "cpmtr" | "cpbgt" | "cprsv"): string {
  return prefix + "_" + base64(crypto.getRandomValues(new Uint8Array(32)));
}
export async function installation(
  request: Request,
  env: AccountingEnv,
): Promise<boolean> {
  const actual = bearer(request);
  if (!actual || !env.INSTALLATION_BOOTSTRAP_TOKEN) return false;
  const [left, right] = await Promise.all([
    sha256(actual),
    sha256(env.INSTALLATION_BOOTSTRAP_TOKEN),
  ]);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1)
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export async function organizationRead(
  request: Request,
  db: AccountingDb,
  organizationId: string,
  resource: "usage" | "budget" = "budget",
): Promise<Response | null> {
  const supplied = bearer(request);
  if (!supplied) return error(401, "unauthorized");
  const table = supplied.startsWith("cporg_")
    ? "api_tokens"
    : supplied.startsWith("cpbgt_")
      ? "budget_tokens"
      : null;
  if (!table) return error(401, "unauthorized");
  const row = await db
    .prepare(
      `SELECT organization_id, scopes FROM ${table} WHERE token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(await sha256(supplied))
    .first<{ organization_id: string; scopes: string }>();
  const required =
    table === "api_tokens"
      ? "projects:read"
      : resource === "usage"
        ? "usage:read"
        : "budgets:read";
  if (!row || !row.scopes.split(" ").includes(required))
    return error(401, "unauthorized");
  return row.organization_id === organizationId
    ? null
    : error(404, "not_found");
}
export function assertion(
  db: AccountingDb,
  predicate: string,
  bindings: Array<string | number | null> = [],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounting_assertions (id, ok) SELECT ?, CASE WHEN (${predicate}) THEN 1 ELSE 0 END`,
    )
    .bind(crypto.randomUUID(), ...bindings);
}
export async function projectFence(
  db: AccountingDb,
  projectId: string,
): Promise<{
  previous: string;
  next: string;
  statements: D1PreparedStatement[];
}> {
  // Acquire this snapshot BEFORE reading mutable accounts/facts. Every writer
  // must include these statements first in the same business transaction.
  await db
    .prepare(
      "INSERT OR IGNORE INTO accounting_fences (project_id, version_token) VALUES (?, ?)",
    )
    .bind(projectId, crypto.randomUUID())
    .run();
  const row = await db
    .prepare("SELECT version_token FROM accounting_fences WHERE project_id = ?")
    .bind(projectId)
    .first<{ version_token: string }>();
  if (!row) throw new Error("accounting_fence_unavailable");
  const next = crypto.randomUUID();
  return {
    previous: row.version_token,
    next,
    statements: [
      assertion(
        db,
        "EXISTS (SELECT 1 FROM accounting_fences WHERE project_id = ? AND version_token = ?)",
        [projectId, row.version_token],
      ),
      db
        .prepare(
          "UPDATE accounting_fences SET version_token = ? WHERE project_id = ? AND version_token = ?",
        )
        .bind(next, projectId, row.version_token),
    ],
  };
}

export interface FenceContext {
  reservationId: string;
  environmentId: string;
  regionId: string;
  specHash: string;
}
export interface ProtectedFence {
  keyVersion: string;
  iv: string;
  ciphertext: string;
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (byte) => byte.charCodeAt(0),
  );
}
function keys(env: AccountingEnv): {
  active: string;
  keys: Record<string, string>;
} {
  try {
    const parsed: unknown = JSON.parse(env.ALLOWANCE_FENCE_KEYS ?? "null");
    if (
      !fields(parsed, ["active", "keys"]) ||
      typeof parsed.active !== "string" ||
      !object(parsed.keys) ||
      !Object.hasOwn(parsed.keys, parsed.active) ||
      Object.keys(parsed.keys).length > 8 ||
      !Object.keys(parsed.keys).every((key) =>
        /^[A-Za-z0-9_.-]{1,32}$/.test(key),
      ) ||
      !Object.values(parsed.keys).every(
        (key) => typeof key === "string" && unbase64(key).byteLength === 32,
      )
    )
      throw new Error();
    return parsed as { active: string; keys: Record<string, string> };
  } catch {
    throw new Error("fence_key_unavailable");
  }
}
function contextBytes(context: FenceContext): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      version: "allowance-fence/v1",
      reservationId: context.reservationId,
      environmentId: context.environmentId,
      regionId: context.regionId,
      specHash: context.specHash,
    }),
  );
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return bytes;
}
export async function protectFence(
  env: AccountingEnv,
  secret: string,
  context: FenceContext,
): Promise<ProtectedFence> {
  const ring = keys(env);
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(ring.keys[ring.active]!),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: contextBytes(context) },
    key,
    new TextEncoder().encode(secret),
  );
  return {
    keyVersion: ring.active,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}
export async function unprotectFence(
  env: AccountingEnv,
  protectedFence: ProtectedFence,
  context: FenceContext,
): Promise<string> {
  const ring = keys(env);
  if (!Object.hasOwn(ring.keys, protectedFence.keyVersion))
    throw new Error("fence_key_unavailable");
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(ring.keys[protectedFence.keyVersion]!),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unbase64(protectedFence.iv),
      additionalData: contextBytes(context),
    },
    key,
    unbase64(protectedFence.ciphertext),
  );
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    clear,
  );
}
