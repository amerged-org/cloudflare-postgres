// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  formatApiKey,
  hashApiKey,
  newAgentKey,
  newApiKey,
  newRolePassword,
  newSecret,
  parseAgentKey,
  parseApiKey,
  timingSafeEqual,
} from "../src/index.ts";

describe("API keys", () => {
  it("round-trips the key format", () => {
    const { lookupId, key } = newApiKey();
    expect(key).toMatch(/^pgcf_sk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(key);
    expect(parsed?.lookupId).toBe(lookupId);
    expect(parsed && formatApiKey(parsed.lookupId, parsed.secret)).toBe(key);
  });

  it("parses secrets that contain underscores", () => {
    const secret = "_".repeat(43);
    const key = formatApiKey("abcdefghijkl", secret);
    expect(parseApiKey(key)).toEqual({ lookupId: "abcdefghijkl", secret });
  });

  it("rejects malformed keys", () => {
    const secret = newSecret();
    expect(parseApiKey(`pgcf_sk_abc_${secret}`)).toBeNull();
    expect(parseApiKey(`pgcf_ak_abcdefghijkl_${secret}`)).toBeNull();
    expect(parseApiKey(`pgcf_sk_abcdefghijkl_${secret}x`)).toBeNull();
    expect(parseApiKey(`pgcf_sk_ABCDEFGHIJKL_${secret}`)).toBeNull();
    expect(() => formatApiKey("short", secret)).toThrow();
  });

  it("round-trips agent keys and binds them to a region", () => {
    const key = newAgentKey("eu-1");
    expect(key.startsWith("pgcf_ak_eu-1_")).toBe(true);
    expect(parseAgentKey(key)?.regionId).toBe("eu-1");
    expect(parseAgentKey(key.replace("eu-1", "eu_1"))).toBeNull();
    expect(parseApiKey(key)).toBeNull();
  });

  it("hashes deterministically with the pepper", async () => {
    const pepper = newSecret();
    const { key } = newApiKey();
    const first = await hashApiKey(pepper, key);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiKey(pepper, key)).toBe(first);
    expect(await hashApiKey(newSecret(), key)).not.toBe(first);
    expect(await hashApiKey(pepper, newApiKey().key)).not.toBe(first);
    await expect(hashApiKey("", key)).rejects.toThrow();
  });

  it("matches the HMAC-SHA256 reference vector", async () => {
    // RFC 4231 test case 2.
    expect(await hashApiKey("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("compares in constant time", () => {
    const a = "0123456789abcdef".repeat(4);
    expect(timingSafeEqual(a, a)).toBe(true);
    expect(timingSafeEqual(a, a.slice(0, -1) + "0")).toBe(false);
    expect(timingSafeEqual(a, a.slice(0, -1))).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("a\u0000", "a")).toBe(false);
  });

  it("generates URI-safe role passwords", () => {
    const passwords = new Set(Array.from({ length: 100 }, newRolePassword));
    expect(passwords.size).toBe(100);
    for (const password of passwords)
      expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
