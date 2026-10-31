// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealer } from "../../src/crypto/keyring.ts";

const config = (kid: string, ...others: string[]) =>
  JSON.stringify({
    active: kid,
    keys: Object.fromEntries(
      [kid, ...others].map((id) => [id, randomBytes(32).toString("base64url")]),
    ),
  });

describe("text sealer", () => {
  it("opens what it sealed, with a fresh nonce each time", async () => {
    const seal = sealer(config("v1"));
    const first = await seal.seal("whk_a|secret", "whsec_abc");
    const second = await seal.seal("whk_a|secret", "whsec_abc");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.kid).toBe("v1");
    expect(await seal.open("whk_a|secret", first)).toBe("whsec_abc");
  });

  it("refuses a sealed text moved to another context or altered", async () => {
    const seal = sealer(config("v1"));
    const sealed = await seal.seal("whk_a|secret", "whsec_abc");
    await expect(seal.open("whk_b|secret", sealed)).rejects.toThrow();
    const flipped = sealed.ciphertext.replace(/^./, (c) =>
      c === "A" ? "B" : "A",
    );
    await expect(
      seal.open("whk_a|secret", { ...sealed, ciphertext: flipped }),
    ).rejects.toThrow();
  });

  it("opens with the key it was sealed with after the active key moved on", async () => {
    const keys = {
      v1: randomBytes(32).toString("base64url"),
      v2: randomBytes(32).toString("base64url"),
    };
    const before = sealer(JSON.stringify({ active: "v1", keys }));
    const sealed = await before.seal("ctx", "text");
    const after = sealer(JSON.stringify({ active: "v2", keys }));
    expect(await after.open("ctx", sealed)).toBe("text");
    expect((await after.seal("ctx", "text")).kid).toBe("v2");
  });

  it("rejects an empty text, an oversized text and a malformed context", async () => {
    const seal = sealer(config("v1"));
    await expect(seal.seal("ctx", "")).rejects.toThrow(RangeError);
    await expect(seal.seal("ctx", "x".repeat(16 * 1024 + 1))).rejects.toThrow(
      RangeError,
    );
    await expect(seal.seal("bad context!", "text")).rejects.toThrow(TypeError);
  });
});
