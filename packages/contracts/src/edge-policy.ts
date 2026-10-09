// SPDX-License-Identifier: Apache-2.0
// Portable Edge limits and refusal key derivation; no Workers host types.
import { parseRouteKeyring } from "./route-token.ts";

export const DECOY_DEADLINE_MS = 10_000;
export const DECOY_MAX_BYTES = 64 * 1024;
export const DECOY_MAX_FRAMES = 128;
export const DECOY_AUTH_MAX_BYTES = 4096;
export const DECOY_SCRAM_ITERATIONS = 4096;
export const DECOY_SALT_DOMAIN = "pgcf.edge.decoy-scram-salt/v1\n";

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
