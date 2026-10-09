// SPDX-License-Identifier: Apache-2.0
import { canonicalStorageAuthorityKeys, bytesToHex } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";

/** The existing CF-only signer challenges its configured public anchor before it is exposed. */
export async function storageAuthorityPublicKeys(
  env: Env,
): Promise<{ keys: Record<string, string>; sha256: string }> {
  await nodeProofSigningKey(env);
  const keys = JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS) as Record<
    string,
    string
  >;
  const canonical = canonicalStorageAuthorityKeys(keys);
  return {
    keys: JSON.parse(canonical) as Record<string, string>,
    sha256: bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonical),
        ),
      ),
    ),
  };
}
