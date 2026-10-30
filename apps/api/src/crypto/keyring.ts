// SPDX-License-Identifier: Apache-2.0
import {
  base64urlToBytes,
  bytesToBase64url,
  DatabaseId,
  RoleName,
  RolePassword,
} from "@pgcf/contracts";
import { z } from "zod";

const KeyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const KeyringConfig = z.strictObject({
  active: KeyId,
  keys: z.record(KeyId, z.string()),
});
export interface EncryptedPassword {
  ciphertext: string;
  iv: string;
  kid: string;
}
export interface CredentialKeyring {
  active: string;
  encrypt(
    databaseId: string,
    role: string,
    password: string,
  ): Promise<EncryptedPassword>;
  decrypt(
    databaseId: string,
    role: string,
    encrypted: EncryptedPassword,
  ): Promise<string>;
}
const encoder = new TextEncoder();
function aad(databaseId: string, role: string, kid: string): Uint8Array {
  if (
    !DatabaseId.safeParse(databaseId).success ||
    !RoleName.safeParse(role).success ||
    !KeyId.safeParse(kid).success
  )
    throw new TypeError("Invalid credential identity");
  return encoder.encode(`${databaseId}|${role}|${kid}`);
}

function loadKeys(secret: string) {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error("Invalid credential keyring configuration");
  }
  const config = KeyringConfig.safeParse(json);
  if (!config.success)
    throw new Error("Invalid credential keyring configuration");
  const keys = new Map<string, Uint8Array>();
  for (const [kid, encoded] of Object.entries(config.data.keys)) {
    const bytes = base64urlToBytes(encoded);
    if (bytes?.length !== 32)
      throw new Error(
        "Credential keys must be canonical base64url of 32 bytes",
      );
    keys.set(kid, bytes);
  }
  if (!keys.has(config.data.active))
    throw new Error("Active credential key is missing");
  const get = async (
    kid: string,
    usage: "encrypt" | "decrypt",
  ): Promise<CryptoKey> => {
    const bytes = keys.get(kid);
    if (!bytes) throw new Error("Credential key version is unavailable");
    return crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes),
      "AES-GCM",
      false,
      [usage],
    );
  };
  return { active: config.data.active, get };
}

export function keyring(secret: string): CredentialKeyring {
  const { active, get } = loadKeys(secret);
  return {
    active,
    async encrypt(databaseId, role, password) {
      if (!RolePassword.safeParse(password).success)
        throw new TypeError("Invalid role password");
      const kid = active;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: Uint8Array.from(aad(databaseId, role, kid)),
          tagLength: 128,
        },
        await get(kid, "encrypt"),
        encoder.encode(password),
      );
      return {
        ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
        iv: bytesToBase64url(iv),
        kid,
      };
    },
    async decrypt(databaseId, role, encrypted) {
      const iv = base64urlToBytes(encrypted.iv);
      const ciphertext = base64urlToBytes(encrypted.ciphertext);
      if (
        !iv ||
        iv.length !== 12 ||
        !ciphertext ||
        ciphertext.length > 512 ||
        ciphertext.length < 16
      )
        throw new Error("Invalid encrypted credential");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(iv),
          additionalData: Uint8Array.from(aad(databaseId, role, encrypted.kid)),
          tagLength: 128,
        },
        await get(encrypted.kid, "decrypt"),
        Uint8Array.from(ciphertext),
      );
      const password = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(plaintext);
      if (!RolePassword.safeParse(password).success)
        throw new Error("Invalid decrypted credential");
      return password;
    },
  };
}

const SEAL_CONTEXT = /^[A-Za-z0-9._|-]{1,128}$/;
const SEAL_MAX_BYTES = 16 * 1024;

/**
 * Seals short texts that are not role passwords (a webhook's signing secret and its static
 * headers) with the same keys. `context` names what the text belongs to and is authenticated with
 * it, so a sealed text cannot be moved to another row.
 */
export interface TextSealer {
  seal(context: string, text: string): Promise<EncryptedPassword>;
  open(context: string, sealed: EncryptedPassword): Promise<string>;
}

export function sealer(secret: string): TextSealer {
  const { active, get } = loadKeys(secret);
  const sealedAad = (context: string, kid: string): Uint8Array => {
    if (!SEAL_CONTEXT.test(context) || !KeyId.safeParse(kid).success)
      throw new TypeError("Invalid seal identity");
    return encoder.encode(`seal|${context}|${kid}`);
  };
  return {
    async seal(context, text) {
      const plaintext = encoder.encode(text);
      if (plaintext.length === 0 || plaintext.length > SEAL_MAX_BYTES)
        throw new RangeError("Sealed text must be 1 to 16384 bytes");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: Uint8Array.from(sealedAad(context, active)),
          tagLength: 128,
        },
        await get(active, "encrypt"),
        plaintext,
      );
      return {
        ciphertext: bytesToBase64url(new Uint8Array(ciphertext)),
        iv: bytesToBase64url(iv),
        kid: active,
      };
    },
    async open(context, sealed) {
      const iv = base64urlToBytes(sealed.iv);
      const ciphertext = base64urlToBytes(sealed.ciphertext);
      if (
        !iv ||
        iv.length !== 12 ||
        !ciphertext ||
        ciphertext.length < 17 ||
        ciphertext.length > SEAL_MAX_BYTES + 16
      )
        throw new Error("Invalid sealed text");
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(iv),
          additionalData: Uint8Array.from(sealedAad(context, sealed.kid)),
          tagLength: 128,
        },
        await get(sealed.kid, "decrypt"),
        Uint8Array.from(ciphertext),
      );
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(plaintext);
    },
  };
}
