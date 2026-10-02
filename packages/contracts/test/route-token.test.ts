// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  deriveRegionKey,
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
  signRouteToken,
  verifyRouteToken,
  type RouteKeyring,
} from "../src/route-token.ts";

const region = "eu-1";
const db = "a1b2c3d4e5f6g7h8i9j0";
const cid = "0f8b5c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const now = Date.UTC(2026, 9, 2, 12, 0, 0);
const nowSec = now / 1000;

function keyBytes(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7) & 0xff);
}

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

const master: RouteKeyring = {
  active: "k2",
  keys: new Map([
    ["k1", keyBytes(1)],
    ["k2", keyBytes(2)],
  ]),
};

async function regionKeys(regionId = region) {
  return (await deriveRegionKeyring(master, regionId)).keys;
}

function resign(payloadJson: object, regionKey: Uint8Array): string {
  return signPayload(JSON.stringify(payloadJson), regionKey);
}

function signPayload(payloadJson: string, regionKey: Uint8Array): string {
  const payload = b64u(Buffer.from(payloadJson));
  const sig = createHmac("sha256", regionKey)
    .update("pgcf-route/v1\n" + payload)
    .digest();
  return `v1.${payload}.${b64u(sig)}`;
}

describe("route token", () => {
  it("names the header", () => {
    expect(ROUTE_TOKEN_HEADER).toBe("X-PGCF-Route");
  });

  it("derives region keys like an independent HMAC implementation", async () => {
    for (const [seed, regionId] of [
      [1, "eu-1"],
      [2, "us-east-2"],
    ] as const) {
      const expected = createHmac("sha256", keyBytes(seed))
        .update("pgcf-route-key/v1\n" + regionId)
        .digest();
      expect(
        Buffer.from(await deriveRegionKey(keyBytes(seed), regionId)),
      ).toEqual(expected);
    }
    expect(Buffer.from(await deriveRegionKey(keyBytes(1), "eu-1"))).not.toEqual(
      Buffer.from(await deriveRegionKey(keyBytes(1), "eu-2")),
    );
  });

  it("round-trips sign and verify with a signature computed independently", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      cid,
      now,
    });
    expect(token.length).toBeLessThanOrEqual(512);
    const result = await verifyRouteToken(token, {
      keys: await regionKeys(),
      region,
      now,
    });
    expect(result).toEqual({
      ok: true,
      claims: {
        v: 1,
        db,
        cid,
        rg: region,
        kid: "k2",
        iat: nowSec,
        exp: nowSec + 30,
      },
    });
    const [, payload, sig] = token.split(".");
    const regionKey = createHmac("sha256", keyBytes(2))
      .update("pgcf-route-key/v1\n" + region)
      .digest();
    expect(sig).toBe(
      createHmac("sha256", regionKey)
        .update("pgcf-route/v1\n" + payload)
        .digest("base64url"),
    );
  });

  it("rejects a tampered payload and a tampered signature", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      cid,
      now,
    });
    const [prefix, payload, sig] = token.split(".") as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const otherPayload = b64u(
      Buffer.from(JSON.stringify({ ...claims, db: "zzzzzzzzzzzzzzzzzzzz" })),
    );
    const keys = await regionKeys();
    expect(
      await verifyRouteToken(`${prefix}.${otherPayload}.${sig}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const flipped = Buffer.from(sig, "base64url");
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(
      await verifyRouteToken(`${prefix}.${payload}.${b64u(flipped)}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a token for another region even when signed for it", async () => {
    const token = await signRouteToken({
      keyring: master,
      region: "eu-2",
      db,
      cid,
      now,
    });
    expect(
      await verifyRouteToken(token, { keys: await regionKeys(), region, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    // A gateway holding the eu-2 key must still refuse a claim of another rg.
    const eu2 = await regionKeys("eu-2");
    expect(await verifyRouteToken(token, { keys: eu2, region, now })).toEqual({
      ok: false,
      reason: "wrong_region",
    });
  });

  it("rejects an unknown kid and accepts a retired but still listed one", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      cid,
      now,
    });
    const onlyK1 = new Map([["k1", (await regionKeys()).get("k1")!]]);
    expect(
      await verifyRouteToken(token, { keys: onlyK1, region, now }),
    ).toEqual({ ok: false, reason: "unknown_kid" });
    const oldToken = await signRouteToken({
      keyring: { ...master, active: "k1" },
      region,
      db,
      cid,
      now,
    });
    expect(
      (await verifyRouteToken(oldToken, { keys: onlyK1, region, now })).ok,
    ).toBe(true);
  });

  it("enforces expiry, not-before and the 5 s skew boundary", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      cid,
      now,
    });
    const keys = await regionKeys();
    const at = (ms: number) =>
      verifyRouteToken(token, { keys, region, now: ms });
    expect((await at(now + 35_000)).ok).toBe(true);
    expect(await at(now + 35_001)).toEqual({ ok: false, reason: "expired" });
    expect((await at(now - 5_000)).ok).toBe(true);
    expect(await at(now - 5_001)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
  });

  it("rejects lifetimes over 60 s and non-positive lifetimes", async () => {
    const regionKey = (await regionKeys()).get("k2")!;
    const base = { v: 1, db, cid, rg: region, kid: "k2", iat: nowSec };
    const keys = await regionKeys();
    expect(
      (
        await verifyRouteToken(
          resign({ ...base, exp: nowSec + 60 }, regionKey),
          {
            keys,
            region,
            now,
          },
        )
      ).ok,
    ).toBe(true);
    for (const exp of [nowSec + 61, nowSec]) {
      expect(
        await verifyRouteToken(resign({ ...base, exp }, regionKey), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_lifetime" });
    }
    await expect(
      signRouteToken({ keyring: master, region, db, cid, now, ttlSeconds: 31 }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects oversize and structurally invalid tokens without throwing", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const valid = await signRouteToken({
      keyring: master,
      region,
      db,
      cid,
      now,
    });
    const [, payload, sig] = valid.split(".") as [string, string, string];
    const cases: [unknown, string][] = [
      [undefined, "missing"],
      [null, "missing"],
      ["", "missing"],
      ["v1." + "A".repeat(600) + "." + sig, "too_long"],
      [valid.replace(/^v1/, "v2"), "malformed"],
      [`v1.${payload}`, "malformed"],
      [`v1.${payload}.${sig}.x`, "malformed"],
      [`v1.${payload}=.${sig}`, "malformed"],
      [`v1.${payload}.${sig}=`, "malformed"],
      [`v1.${payload}.${sig.slice(0, -1)}`, "malformed"],
      [`v1.${payload}.${sig.slice(0, -1)}B`, "malformed"],
      [`v1.${payload}+.${sig}`, "malformed"],
      [`v1..${sig}`, "malformed"],
      [`v1.${b64u(Buffer.from("not json"))}.${sig}`, "malformed"],
      [`v1.${b64u(Buffer.from("[1]"))}.${sig}`, "malformed"],
      [`v1.${b64u(Buffer.from([0xff, 0xfe]))}.${sig}`, "malformed"],
      [`v1.${b64u(Buffer.from('{"kid":1}'))}.${sig}`, "malformed"],
      [
        `v1.${b64u(Buffer.from('{"kid":"constructor"}'))}.${sig}`,
        "unknown_kid",
      ],
      [
        resign(
          {
            v: 1,
            db,
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec,
            exp: nowSec + 30,
            extra: 1,
          },
          regionKey,
        ),
        "invalid_claims",
      ],
      [
        resign(
          {
            v: 1,
            db: "UPPER",
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec,
            exp: nowSec + 30,
          },
          regionKey,
        ),
        "invalid_claims",
      ],
      [
        resign(
          {
            v: 1,
            db,
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec + 0.5,
            exp: nowSec + 30,
          },
          regionKey,
        ),
        "invalid_claims",
      ],
    ];
    for (const [token, reason] of cases) {
      expect(
        await verifyRouteToken(token as string, { keys, region, now }),
        String(token),
      ).toEqual({ ok: false, reason });
    }
  });

  it("enforces the exact 512 and 513 character limit", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const claims = JSON.stringify({
      v: 1,
      db,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
      exp: nowSec + 30,
    });
    const allowed = signPayload(claims.padEnd(348, " "), regionKey);
    expect(allowed.length).toBe(511);
    expect((await verifyRouteToken(allowed, { keys, region, now })).ok).toBe(
      true,
    );
    // Fixed 43-character signatures make a 512-character token's payload
    // noncanonical base64url; it must reach structure validation, not the cap.
    const atLimit = allowed.replace("v1.", "v1.A");
    expect(atLimit.length).toBe(512);
    expect(await verifyRouteToken(atLimit, { keys, region, now })).toEqual({
      ok: false,
      reason: "malformed",
    });
    const oversize = signPayload(claims.padEnd(349, " "), regionKey);
    expect(oversize.length).toBe(513);
    expect(await verifyRouteToken(oversize, { keys, region, now })).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("parses and serializes keyrings and refuses weak or inconsistent ones", () => {
    const json = serializeRouteKeyring(master);
    const parsed = parseRouteKeyring(json);
    expect(parsed.active).toBe("k2");
    expect([...parsed.keys]).toEqual([...master.keys]);
    const short = JSON.stringify({
      active: "k1",
      keys: { k1: b64u(new Uint8Array(16)) },
    });
    const missingActive = JSON.stringify({
      active: "k9",
      keys: { k1: b64u(keyBytes(1)) },
    });
    for (const bad of ["{", "[]", short, missingActive]) {
      expect(() => parseRouteKeyring(bad)).toThrow(/invalid route keyring/);
    }
    expect(() => parseRouteKeyring(short)).not.toThrow(
      b64u(new Uint8Array(16)),
    );
  });

  it("preserves longer master keys while deriving 32-byte region keys", async () => {
    const masterBytes = Uint8Array.from(
      { length: 64 },
      (_, i) => (i * 7 + 31) & 0xff,
    );
    const keyring: RouteKeyring = {
      active: "k1",
      keys: new Map([["k1", masterBytes]]),
    };
    const parsed = parseRouteKeyring(serializeRouteKeyring(keyring));
    expect(parsed.keys.get("k1")).toEqual(masterBytes);
    const derived = await deriveRegionKeyring(parsed, region);
    expect(derived.keys.get("k1")?.length).toBe(32);
    expect(Buffer.from(derived.keys.get("k1")!)).toEqual(
      createHmac("sha256", masterBytes)
        .update("pgcf-route-key/v1\n" + region)
        .digest(),
    );
    const token = await signRouteToken({
      keyring: parsed,
      region,
      db,
      cid,
      now,
    });
    expect(
      (await verifyRouteToken(token, { keys: derived.keys, region, now })).ok,
    ).toBe(true);
  });
});

describe("ReplayCache", () => {
  it("accepts a cid once and rejects the second use", () => {
    const cache = new ReplayCache();
    expect(cache.use(cid, nowSec + 30, now)).toBe("fresh");
    expect(cache.use(cid, nowSec + 30, now + 1000)).toBe("replayed");
  });

  it("keeps a cid until its token can no longer verify, then evicts it", () => {
    const cache = new ReplayCache();
    cache.use(cid, nowSec + 30, now);
    expect(cache.use(cid, nowSec + 30, now + 35_000)).toBe("replayed");
    cache.use(
      "11111111-1111-4111-8111-111111111111",
      nowSec + 60,
      now + 35_001,
    );
    expect(cache.size).toBe(1);
  });

  it("fails closed when full of live entries and recovers after expiry", () => {
    const cache = new ReplayCache(2);
    expect(cache.use("a", nowSec + 30, now)).toBe("fresh");
    expect(cache.use("b", nowSec + 60, now)).toBe("fresh");
    expect(cache.use("c", nowSec + 30, now)).toBe("full");
    expect(cache.size).toBe(2);
    // An expired entry behind a longer-lived one is found by the full sweep.
    const swept = new ReplayCache(2);
    swept.use("long", nowSec + 60, now);
    swept.use("short", nowSec + 10, now);
    expect(swept.use("next", nowSec + 60, now + 20_000)).toBe("fresh");
    expect(swept.use("short", nowSec + 10, now + 20_000)).toBe("full");
  });
});
