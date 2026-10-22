// SPDX-License-Identifier: Apache-2.0
// Portable Edge limits and refusal key derivation; no Workers host types. The Edge loads this
// module, so it imports no zod: `route-token-core.ts`, not `route-token.ts`.
import { parseRouteKeyring } from "./route-token-core.ts";

/**
 * How long a connect to a sleeping database may wait to be admitted, at the Edge and in the Actor.
 * A cold Thin wake takes 22 s when the identity turn is free and about 40 s when one is in flight,
 * which the 30 s of the first deadline cut off (measured 2026-10-16).
 */
export const ADMISSION_DEADLINE_MS = 60_000;

export const DECOY_DEADLINE_MS = 10_000;
export const DECOY_MAX_BYTES = 64 * 1024;
export const DECOY_MAX_FRAMES = 128;
export const DECOY_AUTH_MAX_BYTES = 4096;
export const DECOY_SCRAM_ITERATIONS = 4096;
export const DECOY_SALT_DOMAIN = "pgcf.edge.decoy-scram-salt/v1\n";

/** The most of a gateway's refusal the Edge reads: its error code is short. */
export const REFUSAL_BYTES = 512;

/**
 * The request headers of a Cloudflare Access service token, which the Edge presents to a gateway
 * on the public network.
 */
export const ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";
/** The `config_error` an Edge logs when it has one of the token's two secrets and not the other. */
export const ACCESS_SECRETS_INCOMPLETE = "access_secrets_incomplete";

/**
 * What an Edge does with its two Access secrets: `send` both when both are set, `none` when
 * neither is (an installation without Access), and `incomplete` for one alone, which is a
 * configuration error that refuses the connection. An empty value is not set.
 */
export function accessTokenState(
  id: unknown,
  secret: unknown,
): "send" | "none" | "incomplete" {
  const set = (value: unknown) => typeof value === "string" && value !== "";
  if (set(id) && set(secret)) return "send";
  return set(id) || set(secret) ? "incomplete" : "none";
}

/**
 * The error code of a gateway's refusal, `{"error": "<snake_case>"}`; nothing else of its answer
 * is kept, so no free text reaches a log. A body that is not exactly that has no code.
 */
export function refusalCode(text: string): string | undefined {
  try {
    const answer: unknown = JSON.parse(text);
    if (typeof answer !== "object" || answer === null) return undefined;
    const code = (answer as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

export async function decoySalt(
  secret: string,
  database: string,
  user: string,
): Promise<string> {
  const ring = parseRouteKeyring(secret),
    master = ring.keys.get(ring.active)!;
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      DECOY_SALT_DOMAIN + JSON.stringify([database, user]),
    ),
  );
  return btoa(String.fromCharCode(...new Uint8Array(derived).subarray(0, 16)));
}
