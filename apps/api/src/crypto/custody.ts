// SPDX-License-Identifier: Apache-2.0
import { base64urlToBytes, bytesToBase64url } from "@pgcf/contracts";
import { z } from "zod";

export const CUSTODY_PLAINTEXT_MAX_BYTES = 256 * 1024;
const CIPHERTEXT_MAX_CHARS = 349547;
const KeyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const Config = z.strictObject({
  active: KeyId,
  keys: z.record(KeyId, z.string().length(43)),
});
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
class CustodyError extends Error {
  constructor(
    code: "invalid" | "keyring_invalid" | "key_unavailable" | "unavailable",
  ) {
    super(`custody_document_${code}`);
  }
}
function utf8(value: string, maximum: number): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new CustodyError("invalid");
  const bytes = encoder.encode(value);
  if (bytes.byteLength > maximum || decoder.decode(bytes) !== value)
    throw new CustodyError("invalid");
  return bytes;
}
function keys(secret: string): {
  active: string;
  keys: Map<string, Uint8Array>;
} {
  try {
    if (typeof secret !== "string" || secret.length > 16384)
      throw new CustodyError("keyring_invalid");
    const parsed = Config.safeParse(JSON.parse(secret));
    if (!parsed.success) throw new CustodyError("keyring_invalid");
    const entries = Object.entries(parsed.data.keys);
    if (!entries.length || entries.length > 16)
      throw new CustodyError("keyring_invalid");
    const values = new Map<string, Uint8Array>();
    for (const [kid, text] of entries) {
      const bytes = base64urlToBytes(text);
      if (!bytes || bytes.length !== 32)
        throw new CustodyError("keyring_invalid");
      values.set(kid, bytes);
    }
    if (!values.has(parsed.data.active))
      throw new CustodyError("keyring_invalid");
    return { active: parsed.data.active, keys: values };
  } catch {
    throw new CustodyError("keyring_invalid");
  }
}
export interface EncryptedCustodyDocument {
  kid: string;
  iv: string;
  ciphertext: string;
}
function documentIdentity(
  scope: readonly (string | number)[],
  kid: string,
): Uint8Array {
  if (
    !scope.length ||
    scope.length > 8 ||
    scope.some((value) =>
      typeof value === "string"
        ? !value || value.length > 512
        : !Number.isSafeInteger(value),
    )
  )
    throw new CustodyError("invalid");
  return encoder.encode(
    JSON.stringify(["pgcf-custody-document/v1", ...scope, kid]),
  );
}
/** Seals with the active CREDENTIAL_KEYS version; the caller binds the complete domain identity. */
export async function encryptCustodyDocument(
  secret: string,
  scope: readonly (string | number)[],
  plaintext: string,
): Promise<EncryptedCustodyDocument> {
  const ring = keys(secret),
    kid = ring.active,
    identity = documentIdentity(scope, kid),
    iv = crypto.getRandomValues(new Uint8Array(12)),
    value = utf8(plaintext, CUSTODY_PLAINTEXT_MAX_BYTES);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(ring.keys.get(kid)!),
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: Uint8Array.from(identity),
        tagLength: 128,
      },
      key,
      Uint8Array.from(value),
    );
    return {
      kid,
      iv: bytesToBase64url(iv),
      ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
    };
  } catch {
    throw new CustodyError("unavailable");
  }
}
/** Opens with any retained keyring version; a different identity or a changed byte fails. */
export async function decryptCustodyDocument(
  secret: string,
  scope: readonly (string | number)[],
  encrypted: EncryptedCustodyDocument,
): Promise<string> {
  const parsed = z
    .strictObject({
      kid: KeyId,
      iv: z.string().max(16),
      ciphertext: z.string().max(CIPHERTEXT_MAX_CHARS),
    })
    .safeParse(encrypted);
  if (!parsed.success) throw new CustodyError("invalid");
  const identity = documentIdentity(scope, encrypted.kid),
    iv = base64urlToBytes(encrypted.iv),
    ciphertext = base64urlToBytes(encrypted.ciphertext);
  if (
    !iv ||
    iv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < 16 ||
    ciphertext.length > CUSTODY_PLAINTEXT_MAX_BYTES + 16
  )
    throw new CustodyError("invalid");
  const bytes = keys(secret).keys.get(encrypted.kid);
  if (!bytes) throw new CustodyError("key_unavailable");
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(iv),
        additionalData: Uint8Array.from(identity),
        tagLength: 128,
      },
      key,
      Uint8Array.from(ciphertext),
    );
    const text = decoder.decode(plaintext);
    utf8(text, CUSTODY_PLAINTEXT_MAX_BYTES);
    return text;
  } catch {
    throw new CustodyError("invalid");
  }
}
