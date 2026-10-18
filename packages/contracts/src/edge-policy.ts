// SPDX-License-Identifier: Apache-2.0
// Portable Edge limits and refusal key derivation; no Workers host types.
import { parseRouteKeyring } from "./route-token.ts";

export const DECOY_DEADLINE_MS = 10_000;
export const DECOY_MAX_BYTES = 64 * 1024;
export const DECOY_MAX_FRAMES = 128;
export const DECOY_AUTH_MAX_BYTES = 4096;
export const DECOY_SCRAM_ITERATIONS = 4096;
export const DECOY_SALT_DOMAIN = "pgcf.edge.decoy-scram-salt/v1\n";

/** The most of a gateway's refusal the Edge reads: its error code is short. */
export const REFUSAL_BYTES = 512;

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
