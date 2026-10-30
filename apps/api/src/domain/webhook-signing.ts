// SPDX-License-Identifier: Apache-2.0
import { bytesToBase64url, bytesToHex, timingSafeEqual } from "@pgcf/contracts";

export const WEBHOOK_SIGNATURE_HEADER = "PGCF-Signature";
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

const SIGNATURE_PATTERN = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;
const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(mac));
}

export async function signWebhook(
  secret: string,
  timestampSeconds: number,
  body: string,
): Promise<string> {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new RangeError(
      "timestampSeconds must be a non-negative safe integer",
    );
  }
  if (secret === "") throw new TypeError("webhook secret must not be empty");
  const mac = await hmacSha256Hex(secret, `${timestampSeconds}.${body}`);
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Accepts only the exact header grammar. The NaN-safe comparison matters: a NaN clock or tolerance
 * must reject the signature rather than pass the age check.
 */
export async function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
): Promise<boolean> {
  const match = SIGNATURE_PATTERN.exec(header);
  if (match === null || secret === "") return false;
  const timestampSeconds = Number(match[1]);
  if (!(Math.abs(nowSeconds - timestampSeconds) <= toleranceSeconds)) {
    return false;
  }
  const expected = await hmacSha256Hex(secret, `${timestampSeconds}.${body}`);
  return timingSafeEqual(expected, match[2] ?? "");
}

export function newWebhookSecret(): string {
  return `whsec_${bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}
