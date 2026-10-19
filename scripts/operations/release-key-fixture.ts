// SPDX-License-Identifier: Apache-2.0
// Throwaway release keys for tests: a key pair made the way `provision` makes it, and a signature
// made with its secret as the signer Worker would make it. No key of any use is in the repository.
import { createPrivateKey, sign } from "node:crypto";
import { generateReleaseKey } from "./release-signing.ts";

/** A key pair: the secret as the signer reads it (PKCS#8 in base64) and the public key in hex. */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { secret, publicKey } = generateReleaseKey();
  return { privateKey: secret, publicKey };
}

/** The Ed25519 signature of `text` (128 hex digits) by the secret `privateKey`. */
export function signText(privateKey: string, text: string): string {
  return sign(
    null,
    Buffer.from(text),
    createPrivateKey({
      key: Buffer.from(privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    }),
  ).toString("hex");
}
