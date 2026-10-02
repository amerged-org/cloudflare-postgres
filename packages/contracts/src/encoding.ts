// SPDX-License-Identifier: Apache-2.0

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Strict unpadded base64url decoder; returns null for any malformed input. */
export function base64urlToBytes(value: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (stray bits in the last character).
  if (bytesToBase64url(bytes) !== value) return null;
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** 32 random bytes as 43 base64url characters. */
export function newSecret(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}
