// SPDX-License-Identifier: Apache-2.0
import {
  body,
  error,
  fields,
  installation,
  json,
  object,
  sha256,
  timestamp,
  uuid,
} from "./accounting";

type TokenEnv = Cloudflare.Env & { ROLE_CREDENTIAL_KEYS?: string };
const permittedScopes = [
  "operations:read",
  "projects:read",
  "projects:write",
] as const;
const tokenDomain = "cloudflare-postgres/organization-api-token/v1";
const cursorDomain = "cloudflare-postgres/organization-api-token-cursor/v1";
interface TokenRow {
  id: string;
  organization_id: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  revoked_at: string | null;
}
interface Ring {
  active: string;
  keys: Record<string, string>;
}
interface Cursor {
  domain: typeof cursorDomain;
  organizationId: string;
  limit: number;
  createdAt: string;
  id: string;
}
function canonicalScopes(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= permittedScopes.length &&
    new Set(value).size === value.length &&
    value.every(
      (scope) =>
        typeof scope === "string" &&
        (permittedScopes as readonly string[]).includes(scope),
    )
    ? [...value].sort()
    : null;
}
function base64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("token_key_unavailable");
  const decoded = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  if (base64(decoded) !== value) throw new Error("token_key_unavailable");
  return decoded;
}
function keyring(env: TokenEnv): Ring {
  try {
    const value: unknown = JSON.parse(env.ROLE_CREDENTIAL_KEYS ?? "null");
    if (
      !fields(value, ["active", "keys"]) ||
      typeof value.active !== "string" ||
      !object(value.keys) ||
      !Object.hasOwn(value.keys, value.active) ||
      Object.keys(value.keys).length < 1 ||
      Object.keys(value.keys).length > 8 ||
      !Object.keys(value.keys).every((id) =>
        /^[A-Za-z0-9_.-]{1,32}$/.test(id),
      ) ||
      !Object.values(value.keys).every(
        (key) =>
          typeof key === "string" &&
          key.length === 43 &&
          bytes(key).byteLength === 32,
      )
    )
      throw new Error();
    return value as unknown as Ring;
  } catch {
    throw new Error("token_key_unavailable");
  }
}
async function signingKey(
  material: Uint8Array<ArrayBuffer>,
  domain: string,
  keyId: string,
): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey("raw", material, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(JSON.stringify({ domain, keyId })),
    },
    master,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}
async function credential(
  ring: Ring,
  keyId: string,
  organizationId: string,
  id: string,
  scopes: string[],
): Promise<string> {
  const key = await signingKey(bytes(ring.keys[keyId]!), tokenDomain, keyId);
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      JSON.stringify({ domain: tokenDomain, organizationId, id, scopes }),
    ),
  );
  return "cporg_" + base64(new Uint8Array(signed));
}
function metadata(row: TokenRow) {
  const scopes = canonicalScopes(row.scopes.split(" "));
  if (
    !uuid.test(row.id) ||
    !uuid.test(row.organization_id) ||
    !scopes ||
    timestamp(row.created_at) === null ||
    (row.revoked_at !== null && timestamp(row.revoked_at) === null)
  )
    throw new Error("token_state_invalid");
  return {
    id: row.id,
    organizationId: row.organization_id,
    scopes,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}
function readToken(env: TokenEnv, id: string) {
  // Direct D1 binding reads the primary on every call, including the final
  // check after cryptography and a lost insert/revocation response.
  return env.DB.prepare("SELECT * FROM api_tokens WHERE id=?")
    .bind(id)
    .first<TokenRow>();
}
async function reveal(
  env: TokenEnv,
  row: TokenRow,
  scopes: string[],
  status: number,
): Promise<Response> {
  if (row.revoked_at !== null) return error(409, "token_revoked");
  if (canonicalScopes(row.scopes.split(" "))?.join(" ") !== scopes.join(" "))
    return error(409, "idempotency_conflict");
  let ring: Ring;
  try {
    ring = keyring(env);
  } catch {
    return error(503, "token_key_unavailable");
  }
  let secret: string | null = null;
  for (const keyId of Object.keys(ring.keys)) {
    const candidate = await credential(
      ring,
      keyId,
      row.organization_id,
      row.id,
      scopes,
    );
    if ((await sha256(candidate)) === row.token_hash) {
      secret = candidate;
      break;
    }
  }
  if (secret === null) return error(409, "token_replay_unavailable");
  const current = await readToken(env, row.id);
  if (!current || current.organization_id !== row.organization_id)
    return error(404, "not_found");
  if (current.revoked_at !== null) return error(409, "token_revoked");
  if (
    current.scopes !== row.scopes ||
    current.token_hash !== row.token_hash ||
    current.created_at !== row.created_at
  )
    return error(409, "idempotency_conflict");
  return json({ token: metadata(current), apiToken: secret }, status);
}
async function issue(
  request: Request,
  env: TokenEnv,
  organizationId: string,
): Promise<Response> {
  const input = await body(request, 4096);
  if (
    !fields(input, ["id", "scopes"]) ||
    typeof input.id !== "string" ||
    !uuid.test(input.id)
  )
    return error(400, "invalid_request");
  const scopes = canonicalScopes(input.scopes);
  if (!scopes) return error(400, "invalid_request");
  const previous = await readToken(env, input.id);
  if (previous)
    return previous.organization_id === organizationId
      ? reveal(env, previous, scopes, 200)
      : error(404, "not_found");
  const parent = await env.DB.prepare("SELECT id FROM organizations WHERE id=?")
    .bind(organizationId)
    .first();
  if (!parent) return error(404, "not_found");
  let secret: string;
  try {
    const ring = keyring(env);
    secret = await credential(
      ring,
      ring.active,
      organizationId,
      input.id,
      scopes,
    );
  } catch {
    return error(503, "token_key_unavailable");
  }
  const hash = await sha256(secret);
  let inserted = false;
  try {
    const result = await env.DB.prepare(
      "INSERT INTO api_tokens (id,organization_id,token_hash,scopes,created_at) SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM organizations WHERE id=?)",
    )
      .bind(
        input.id,
        organizationId,
        hash,
        scopes.join(" "),
        new Date().toISOString(),
        organizationId,
      )
      .run();
    inserted = result.meta.changes === 1;
  } catch {
    // The unique ID is the stable issuance identity. A committed winner is
    // recovered below; no uncertain insert is repeated or digest rewritten.
  }
  const winner = await readToken(env, input.id);
  if (!winner) {
    const currentParent = await env.DB.prepare(
      "SELECT id FROM organizations WHERE id=?",
    )
      .bind(organizationId)
      .first();
    return currentParent
      ? error(500, "token_write_failed")
      : error(404, "not_found");
  }
  if (winner.organization_id !== organizationId) return error(404, "not_found");
  // An uncertain committed insert returns the same creation response. The
  // retained hash selects its historical master even if active keys changed.
  return reveal(
    env,
    winner,
    scopes,
    inserted || winner.token_hash === hash ? 201 : 200,
  );
}
async function cursorKey(env: TokenEnv): Promise<CryptoKey> {
  return signingKey(
    new Uint8Array(new TextEncoder().encode(env.INSTALLATION_BOOTSTRAP_TOKEN!)),
    cursorDomain,
    "installation",
  );
}
async function encodeCursor(env: TokenEnv, cursor: Cursor): Promise<string> {
  const payload = base64(new TextEncoder().encode(JSON.stringify(cursor)));
  const signature = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await cursorKey(env),
        new TextEncoder().encode(payload),
      ),
    ),
  );
  return base64(
    new TextEncoder().encode(JSON.stringify({ payload, signature })),
  );
}
async function decodeCursor(
  env: TokenEnv,
  encoded: string,
  organizationId: string,
  limit: number,
): Promise<Cursor | null> {
  if (encoded.length > 1024) return null;
  try {
    const envelope: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes(encoded),
      ),
    );
    if (
      !fields(envelope, ["payload", "signature"]) ||
      typeof envelope.payload !== "string" ||
      typeof envelope.signature !== "string" ||
      bytes(envelope.signature).byteLength !== 32
    )
      return null;
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await cursorKey(env),
        bytes(envelope.signature),
        new TextEncoder().encode(envelope.payload),
      ))
    )
      return null;
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes(envelope.payload),
      ),
    );
    if (
      !fields(value, [
        "domain",
        "organizationId",
        "limit",
        "createdAt",
        "id",
      ]) ||
      value.domain !== cursorDomain ||
      value.organizationId !== organizationId ||
      value.limit !== limit ||
      timestamp(value.createdAt) === null ||
      typeof value.id !== "string" ||
      !uuid.test(value.id)
    )
      return null;
    return value as unknown as Cursor;
  } catch {
    return null;
  }
}
async function list(
  request: Request,
  env: TokenEnv,
  organizationId: string,
): Promise<Response> {
  const parameters = new URL(request.url).searchParams;
  if (
    [...parameters.keys()].some(
      (name) =>
        !["limit", "cursor"].includes(name) ||
        parameters.getAll(name).length !== 1,
    )
  )
    return error(400, "invalid_request");
  const limitText = parameters.get("limit") ?? "50";
  if (!/^[1-9][0-9]{0,3}$/.test(limitText) || Number(limitText) > 1000)
    return error(400, "invalid_request");
  const limit = Number(limitText);
  const encoded = parameters.get("cursor");
  const cursor =
    encoded === null
      ? null
      : await decodeCursor(env, encoded, organizationId, limit);
  if (encoded !== null && cursor === null) return error(400, "invalid_request");
  const parent = await env.DB.prepare("SELECT id FROM organizations WHERE id=?")
    .bind(organizationId)
    .first();
  if (!parent) return error(404, "not_found");
  const result = await (
    cursor
      ? env.DB.prepare(
          "SELECT * FROM api_tokens WHERE organization_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?",
        ).bind(
          organizationId,
          cursor.createdAt,
          cursor.createdAt,
          cursor.id,
          limit + 1,
        )
      : env.DB.prepare(
          "SELECT * FROM api_tokens WHERE organization_id=? ORDER BY created_at DESC,id DESC LIMIT ?",
        ).bind(organizationId, limit + 1)
  ).all<TokenRow>();
  const page = result.results.slice(0, limit);
  const last = page[page.length - 1];
  return json({
    tokens: page.map(metadata),
    nextCursor:
      result.results.length > limit && last
        ? await encodeCursor(env, {
            domain: cursorDomain,
            organizationId,
            limit,
            createdAt: last.created_at,
            id: last.id,
          })
        : null,
  });
}
async function item(
  request: Request,
  env: TokenEnv,
  organizationId: string,
  id: string,
): Promise<Response> {
  if (new URL(request.url).search || request.body)
    return error(400, "invalid_request");
  const original = await readToken(env, id);
  if (!original || original.organization_id !== organizationId)
    return error(404, "not_found");
  if (request.method === "GET" || original.revoked_at !== null)
    return json({ token: metadata(original) });
  try {
    await env.DB.prepare(
      "UPDATE api_tokens SET revoked_at=? WHERE id=? AND organization_id=? AND revoked_at IS NULL",
    )
      .bind(new Date().toISOString(), id, organizationId)
      .run();
  } catch {
    // Read the durable outcome once after a lost response. An unchanged active
    // row is uncertainty, never successful revocation or a second write.
  }
  const current = await readToken(env, id);
  if (!current || current.organization_id !== organizationId)
    return error(404, "not_found");
  return current.revoked_at === null
    ? error(500, "token_write_failed")
    : json({ token: metadata(current) });
}

export async function organizationTokenRoutes(
  request: Request,
  env: TokenEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const matched =
    /^\/v1\/organizations\/([^/]+)\/tokens(?:\/([0-9a-f-]{36}))?$/.exec(path);
  if (
    !matched ||
    !(matched[2] ? ["GET", "DELETE"] : ["GET", "POST"]).includes(request.method)
  )
    return null;
  if (!env.INSTALLATION_BOOTSTRAP_TOKEN)
    return error(503, "bootstrap_unconfigured");
  if (!(await installation(request, env))) return error(401, "unauthorized");
  const organizationId = matched[1]!;
  if (!uuid.test(organizationId) || (matched[2] && !uuid.test(matched[2])))
    return error(400, "invalid_request");
  if (request.method === "POST" && new URL(request.url).search)
    return error(400, "invalid_request");
  try {
    if (matched[2]) return await item(request, env, organizationId, matched[2]);
    return request.method === "GET"
      ? await list(request, env, organizationId)
      : await issue(request, env, organizationId);
  } catch {
    return error(500, "organization_tokens_unavailable");
  }
}
