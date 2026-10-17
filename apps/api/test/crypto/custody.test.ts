// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { base64urlToBytes, bytesToBase64url } from "@pgcf/contracts";
import {
  decryptCustodyDocument,
  encryptCustodyDocument,
} from "../../src/crypto/custody.ts";

function config() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return {
    raw,
    secret: JSON.stringify({
      active: "old",
      keys: { old: bytesToBase64url(raw) },
    }),
  };
}
const scope = ["region-archive-source", "eu", "us", 1] as const;
it("uses real AES-GCM round trips with random twelve-byte IVs bound to the document identity", async () => {
  const { secret } = config(),
    text = `secret-${crypto.randomUUID()}`;
  const first = await encryptCustodyDocument(secret, scope, text),
    second = await encryptCustodyDocument(secret, scope, text);
  expect(first.iv).not.toBe(second.iv);
  expect(base64urlToBytes(first.iv)!.length).toBe(12);
  expect(base64urlToBytes(first.ciphertext)!.length).toBe(
    new TextEncoder().encode(text).length + 16,
  );
  expect(JSON.stringify(first)).not.toContain(text);
  expect(await decryptCustodyDocument(secret, scope, first)).toBe(text);
  await expect(
    decryptCustodyDocument(
      secret,
      ["region-archive-source", "eu", "us", 2],
      first,
    ),
  ).rejects.toThrow("custody_document_invalid");
});
it("retains old kid custody across active-key changes and fails closed when the old kid is missing", async () => {
  const { secret, raw } = config(),
    encrypted = await encryptCustodyDocument(secret, scope, "document");
  const rotated = JSON.stringify({
    active: "new",
    keys: {
      old: bytesToBase64url(raw),
      new: bytesToBase64url(crypto.getRandomValues(new Uint8Array(32))),
    },
  });
  expect(encrypted.kid).toBe("old");
  expect(await decryptCustodyDocument(rotated, scope, encrypted)).toBe(
    "document",
  );
  expect((await encryptCustodyDocument(rotated, scope, "next")).kid).toBe(
    "new",
  );
  await expect(
    decryptCustodyDocument(
      JSON.stringify({ active: "new", keys: { new: bytesToBase64url(raw) } }),
      scope,
      encrypted,
    ),
  ).rejects.toThrow("custody_document_key_unavailable");
});
it("refuses tampering, malformed encodings and noncanonical keys with bounded nonsecret errors", async () => {
  const { secret, raw } = config(),
    encrypted = await encryptCustodyDocument(secret, scope, "document");
  const bytes = base64urlToBytes(encrypted.ciphertext)!;
  bytes[0] = bytes[0]! ^ 1;
  await expect(
    decryptCustodyDocument(secret, scope, {
      ...encrypted,
      ciphertext: bytesToBase64url(bytes),
    }),
  ).rejects.toThrow("custody_document_invalid");
  await expect(
    decryptCustodyDocument(secret, scope, {
      ...encrypted,
      iv: bytesToBase64url(new Uint8Array(11)),
    }),
  ).rejects.toThrow("custody_document_invalid");
  await expect(
    decryptCustodyDocument(secret, scope, {
      ...encrypted,
      ciphertext: encrypted.ciphertext + "=",
    }),
  ).rejects.toThrow("custody_document_invalid");
  const twoKids = JSON.stringify({
    active: "old",
    keys: { old: bytesToBase64url(raw), alternate: bytesToBase64url(raw) },
  });
  await expect(
    decryptCustodyDocument(twoKids, scope, { ...encrypted, kid: "alternate" }),
  ).rejects.toThrow("custody_document_invalid");
  const padded = JSON.stringify({
    active: "old",
    keys: { old: bytesToBase64url(raw) + "=" },
  });
  await expect(
    encryptCustodyDocument(padded, scope, "document"),
  ).rejects.toThrow("custody_document_keyring_invalid");
  await expect(
    encryptCustodyDocument(secret, scope, String.fromCharCode(0xd800)),
  ).rejects.toThrow("custody_document_invalid");
});
