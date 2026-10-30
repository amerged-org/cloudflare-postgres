// SPDX-License-Identifier: Apache-2.0
import { base64urlToBytes } from "@pgcf/contracts";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  newWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from "../../src/domain/webhook-signing.ts";

const SECRET = "whsec_fixture_not_a_secret";
const TIMESTAMP = 1700000000;
const BODY = '{"event":"database.ready","id":"fake-1"}';
const MAC = createHmac("sha256", SECRET)
  .update(`${TIMESTAMP}.${BODY}`)
  .digest("hex");
const HEADER = `t=${TIMESTAMP},v1=${MAC}`;

describe("webhook signing", () => {
  it("signs with HMAC-SHA256 over the timestamp, a dot and the body", async () => {
    // The expected MAC comes from node:crypto, independent of the implementation.
    expect(await signWebhook(SECRET, TIMESTAMP, BODY)).toBe(HEADER);
  });

  it("refuses to sign with an invalid timestamp or an empty secret", async () => {
    await expect(signWebhook(SECRET, -1, BODY)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(signWebhook(SECRET, 1.5, BODY)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(signWebhook("", TIMESTAMP, BODY)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("accepts a signature it produced within the tolerance", async () => {
    expect(await verifyWebhookSignature(SECRET, HEADER, BODY, TIMESTAMP)).toBe(
      true,
    );
    const edges = [
      TIMESTAMP - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      TIMESTAMP + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
    ];
    for (const now of edges) {
      expect(await verifyWebhookSignature(SECRET, HEADER, BODY, now)).toBe(
        true,
      );
    }
  });

  it("rejects a tampered body and a wrong secret", async () => {
    expect(
      await verifyWebhookSignature(SECRET, HEADER, `${BODY} `, TIMESTAMP),
    ).toBe(false);
    expect(
      await verifyWebhookSignature(
        "whsec_other_fixture",
        HEADER,
        BODY,
        TIMESTAMP,
      ),
    ).toBe(false);
  });

  it("rejects a timestamp outside the tolerance in both directions", async () => {
    const past = TIMESTAMP + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1;
    const future = TIMESTAMP - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1;
    expect(await verifyWebhookSignature(SECRET, HEADER, BODY, past)).toBe(
      false,
    );
    expect(await verifyWebhookSignature(SECRET, HEADER, BODY, future)).toBe(
      false,
    );
  });

  it("rejects malformed headers without throwing", async () => {
    const malformed = [
      `t=${TIMESTAMP}`,
      `t=${TIMESTAMP},v1=${MAC.toUpperCase()}`,
      `${HEADER},v0=${MAC}`,
      `t=${TIMESTAMP}, v1=${MAC}`,
      `t=${TIMESTAMP},v1=${MAC.slice(0, 63)}`,
    ];
    for (const header of malformed) {
      expect(
        await verifyWebhookSignature(SECRET, header, BODY, TIMESTAMP),
      ).toBe(false);
    }
  });

  it("generates a whsec_ secret of 32 random bytes that differs between calls", () => {
    const first = newWebhookSecret();
    const second = newWebhookSecret();
    expect(first.startsWith("whsec_")).toBe(true);
    expect(base64urlToBytes(first.slice("whsec_".length))?.length).toBe(32);
    expect(first).not.toBe(second);
  });
});
