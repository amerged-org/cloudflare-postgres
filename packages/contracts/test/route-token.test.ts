// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_MAX_LENGTH,
  deriveRegionKey,
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
  signLegacyRouteToken,
  signRouteToken,
  verifyRouteToken,
  type RouteKeyring,
  type SignRouteTokenInput,
} from "../src/route-token.ts";

const region = "eu-1";
const user = "app";
const db = "a1b2c3d4e5f6g7h8i9j0";
const cid = "0f8b5c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const now = Date.UTC(2026, 9, 2, 12, 0, 0);
const nowSec = now / 1000;
const target = { revision: 7, pod_uid: "4f2c1b0e-8d9a-4c3b-9e2f-1a0b2c3d4e5f" };
const route = { rev: target.revision, pod: target.pod_uid };

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

function signPayload(
  payloadJson: string,
  regionKey: Uint8Array,
  version = "v3",
): string {
  const payload = b64u(Buffer.from(payloadJson));
  const sig = createHmac("sha256", regionKey)
    .update(`pgcf-route/${version}\n` + payload)
    .digest();
  return `${version}.${payload}.${b64u(sig)}`;
}

describe("route token", () => {
  it("v4 accepts the bounded maximum wire identities", async () => {
    const keyring = {
      active: "k".repeat(32),
      keys: new Map([["k".repeat(32), keyBytes(1)]]),
    };
    const wideRegion = "r".repeat(32);
    const token = await signRouteToken({
      keyring,
      region: wideRegion,
      db,
      user: "u".repeat(63),
      cid,
      now,
      target: {
        ...target,
        revision: Number.MAX_SAFE_INTEGER,
        route_revision: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(
      await verifyRouteToken(token, {
        keys: (await deriveRegionKeyring(keyring, wideRegion)).keys,
        region: wideRegion,
        now,
      }),
    ).toMatchObject({ ok: true });
  });
  it("v4 signs a separate route revision without changing the existing generation", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      now,
      target: { ...target, route_revision: 19 },
    });
    expect(token.startsWith("v4.")).toBe(true);
    expect(
      await verifyRouteToken(token, { keys: await regionKeys(), region, now }),
    ).toEqual({
      ok: true,
      claims: {
        v: 4,
        db,
        user,
        cid,
        rg: region,
        kid: "k2",
        iat: nowSec,
        exp: nowSec + 30,
        ...route,
        route_revision: 19,
      },
    });
    const [, payload, signature] = token.split(".");
    expect(signature).toBe(
      createHmac("sha256", (await regionKeys()).get("k2")!)
        .update("pgcf-route/v4\n" + payload)
        .digest("base64url"),
    );
  });
  it("v4 refuses a missing revision and cannot be verified under the v3 signature domain", async () => {
    const key = (await regionKeys()).get("k2")!;
    const claims = {
      v: 4,
      db,
      user,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
      exp: nowSec + 30,
      ...route,
    };
    expect(
      await verifyRouteToken(signPayload(JSON.stringify(claims), key, "v4"), {
        keys: await regionKeys(),
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    const complete = { ...claims, route_revision: 19 };
    expect(
      await verifyRouteToken(signPayload(JSON.stringify(complete), key, "v3"), {
        keys: await regionKeys(),
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
  });
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
      user,
      cid,
      target,
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
        v: 3,
        db,
        user,
        cid,
        rg: region,
        kid: "k2",
        iat: nowSec,
        exp: nowSec + 30,
        ...route,
      },
    });
    const [, payload, sig] = token.split(".");
    const regionKey = createHmac("sha256", keyBytes(2))
      .update("pgcf-route-key/v1\n" + region)
      .digest();
    expect(sig).toBe(
      createHmac("sha256", regionKey)
        .update("pgcf-route/v3\n" + payload)
        .digest("base64url"),
    );
  });

  it("requires a signed nonreserved PostgreSQL user and rejects tampering", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
      now,
    });
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe("v3");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const changedPayload = b64u(
      Buffer.from(JSON.stringify({ ...claims, user: "reader" })),
    );
    expect(
      await verifyRouteToken(`${prefix}.${changedPayload}.${signature}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const { user: omitted, ...missingUser } = claims;
    expect(omitted).toBe(user);
    expect(
      await verifyRouteToken(resign(missingUser, regionKey), {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    await expect(
      signRouteToken({
        keyring: master,
        region,
        db,
        cid,
        target,
        now,
      } as SignRouteTokenInput),
    ).rejects.toThrow(RangeError);
    for (const invalidUser of [
      "",
      "Reader",
      "a".repeat(64),
      "a-b",
      "a\0b",
      "postgres",
      "streaming_replica",
      "pg_read_all_data",
      "cnpg_pooler_pgbouncer",
      1,
      null,
    ]) {
      expect(
        await verifyRouteToken(
          resign({ ...claims, user: invalidUser }, regionKey),
          { keys, region, now },
        ),
      ).toEqual({ ok: false, reason: "invalid_claims" });
      await expect(
        signRouteToken({
          keyring: master,
          region,
          db,
          user: invalidUser,
          cid,
          target,
          now,
        } as SignRouteTokenInput),
      ).rejects.toThrow(RangeError);
    }
  });

  it("rejects v1 tokens, v1 claims and old signature domains without fallback", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
      now,
    });
    const [, payload] = token.split(".") as [string, string, string];
    const oldSignature = createHmac("sha256", regionKey)
      .update("pgcf-route/v1\n" + payload)
      .digest("base64url");
    expect(
      await verifyRouteToken(`v1.${payload}.${oldSignature}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    for (const domain of ["v1", "v2"]) {
      const signature = createHmac("sha256", regionKey)
        .update(`pgcf-route/${domain}\n` + payload)
        .digest("base64url");
      expect(
        await verifyRouteToken(`v3.${payload}.${signature}`, {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "bad_signature" });
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(
      await verifyRouteToken(resign({ ...claims, v: 1 }, regionKey), {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
  });

  it("binds the admitted route revision and verified Pod; a v3 token missing either is refused", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
      now,
    });
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    expect(claims).toMatchObject(route);
    for (const field of ["rev", "pod"]) {
      const { [field]: omitted, ...missing } = claims;
      expect(omitted).toBeDefined();
      expect(
        await verifyRouteToken(resign(missing, regionKey), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_claims" });
    }
    for (const invalid of [
      { rev: 0 },
      { rev: 1.5 },
      { rev: Number.MAX_SAFE_INTEGER + 1 },
      { pod: "not-a-pod-uid" },
      { pod: null },
    ])
      expect(
        await verifyRouteToken(resign({ ...claims, ...invalid }, regionKey), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_claims" });
    for (const invalidTarget of [
      { revision: 0, pod_uid: target.pod_uid },
      { revision: 7, pod_uid: "not-a-pod-uid" },
    ])
      await expect(
        signRouteToken({
          keyring: master,
          region,
          db,
          user,
          cid,
          target: invalidTarget,
          now,
        }),
      ).rejects.toThrow(RangeError);
    await expect(
      signRouteToken({
        keyring: master,
        region,
        db,
        user,
        cid,
        now,
      } as SignRouteTokenInput),
    ).rejects.toThrow(RangeError);
  });

  it("keeps v2 rollout compatibility explicit: own prefix, domain and claims, never a route", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const legacy = await signLegacyRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      now,
    });
    const [prefix, payload, signature] = legacy.split(".") as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe("v2");
    expect(signature).toBe(
      createHmac("sha256", regionKey)
        .update("pgcf-route/v2\n" + payload)
        .digest("base64url"),
    );
    expect(await verifyRouteToken(legacy, { keys, region, now })).toEqual({
      ok: true,
      claims: {
        v: 2,
        db,
        user,
        cid,
        rg: region,
        kid: "k2",
        iat: nowSec,
        exp: nowSec + 30,
      },
    });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(
      await verifyRouteToken(
        signPayload(JSON.stringify({ ...claims, ...route }), regionKey, "v2"),
        { keys, region, now },
      ),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verifyRouteToken(signPayload(JSON.stringify(claims), regionKey), {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verifyRouteToken(`v3.${payload}.${signature}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("fits all maximum-length role, region and key identifiers within the token cap", async () => {
    const maxUser = "r" + "a".repeat(62);
    const maxRegion = "r" + "a".repeat(31);
    const maxKid = "k".repeat(32);
    const keyring = { active: maxKid, keys: new Map([[maxKid, keyBytes(1)]]) };
    const token = await signRouteToken({
      keyring,
      region: maxRegion,
      db,
      user: maxUser,
      cid,
      target: { ...target, revision: Number.MAX_SAFE_INTEGER },
      now,
    });
    expect(maxUser.length).toBe(63);
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_MAX_LENGTH);
    expect(
      await verifyRouteToken(token, {
        keys: (await deriveRegionKeyring(keyring, maxRegion)).keys,
        region: maxRegion,
        now,
      }),
    ).toMatchObject({
      ok: true,
      claims: { v: 3, user: maxUser, rev: Number.MAX_SAFE_INTEGER },
    });
  });

  it("rejects a tampered payload and a tampered signature", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
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
      user,
      cid,
      target,
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
      user,
      cid,
      target,
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
      user,
      cid,
      target,
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
      user,
      cid,
      target,
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

  it("rejects lifetimes over 30 s and non-positive lifetimes", async () => {
    const regionKey = (await regionKeys()).get("k2")!;
    const base = {
      v: 3,
      db,
      user,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
    };
    const keys = await regionKeys();
    expect(
      (
        await verifyRouteToken(
          resign({ ...base, exp: nowSec + 30, ...route }, regionKey),
          {
            keys,
            region,
            now,
          },
        )
      ).ok,
    ).toBe(true);
    for (const exp of [nowSec + 31, nowSec]) {
      expect(
        await verifyRouteToken(resign({ ...base, exp, ...route }, regionKey), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_lifetime" });
    }
    await expect(
      signRouteToken({
        keyring: master,
        region,
        db,
        user,
        cid,
        target,
        now,
        ttlSeconds: 31,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("fails closed for nonfinite verification clocks", async () => {
    const token = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
      now,
    });
    const keys = await regionKeys();
    for (const time of [NaN, Infinity, -Infinity])
      expect(
        (await verifyRouteToken(token, { keys, region, now: time })).ok,
      ).toBe(false);
  });

  it("rejects oversize and structurally invalid tokens without throwing", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const valid = await signRouteToken({
      keyring: master,
      region,
      db,
      user,
      cid,
      target,
      now,
    });
    const [, payload, sig] = valid.split(".") as [string, string, string];
    const cases: [unknown, string][] = [
      [undefined, "missing"],
      [null, "missing"],
      ["", "missing"],
      ["v3." + "A".repeat(600) + "." + sig, "too_long"],
      [valid.replace(/^v3/, "v4"), "bad_signature"],
      [`v3.${payload}`, "malformed"],
      [`v3.${payload}.${sig}.x`, "malformed"],
      [`v3.${payload}=.${sig}`, "malformed"],
      [`v3.${payload}.${sig}=`, "malformed"],
      [`v3.${payload}.${sig.slice(0, -1)}`, "malformed"],
      [`v3.${payload}.${sig.slice(0, -1)}B`, "malformed"],
      [`v3.${payload}+.${sig}`, "malformed"],
      [`v3..${sig}`, "malformed"],
      [`v3.${b64u(Buffer.from("not json"))}.${sig}`, "malformed"],
      [`v3.${b64u(Buffer.from("[1]"))}.${sig}`, "malformed"],
      [`v3.${b64u(Buffer.from([0xff, 0xfe]))}.${sig}`, "malformed"],
      [`v3.${b64u(Buffer.from('{"kid":1}'))}.${sig}`, "malformed"],
      [
        `v3.${b64u(Buffer.from('{"kid":"constructor"}'))}.${sig}`,
        "unknown_kid",
      ],
      [
        resign(
          {
            v: 3,
            db,
            user,
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec,
            exp: nowSec + 30,
            ...route,
            extra: 1,
          },
          regionKey,
        ),
        "invalid_claims",
      ],
      [
        resign(
          {
            v: 3,
            db: "UPPER",
            user,
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec,
            exp: nowSec + 30,
            ...route,
          },
          regionKey,
        ),
        "invalid_claims",
      ],
      [
        resign(
          {
            v: 3,
            db,
            user,
            cid,
            rg: region,
            kid: "k2",
            iat: nowSec + 0.5,
            exp: nowSec + 30,
            ...route,
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
      v: 3,
      db,
      user,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
      exp: nowSec + 30,
      ...route,
    });
    const allowed = signPayload(claims.padEnd(348, " "), regionKey);
    expect(allowed.length).toBe(511);
    expect((await verifyRouteToken(allowed, { keys, region, now })).ok).toBe(
      true,
    );
    // Fixed 43-character signatures make a 512-character token's payload
    // noncanonical base64url; it must reach structure validation, not the cap.
    const atLimit = allowed.replace("v3.", "v3.A");
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
      user,
      cid,
      target,
      now,
    });
    expect(
      (await verifyRouteToken(token, { keys: derived.keys, region, now })).ok,
    ).toBe(true);
  });
});

describe("ReplayCache", () => {
  it("isolates replay capacity and identical connection IDs by verified database", () => {
    const cache = new ReplayCache(1);
    const other = "b".repeat(20);
    expect(cache.use(db, cid, nowSec + 30, now)).toBe("fresh");
    expect(cache.use(db, "next", nowSec + 30, now)).toBe("full");
    expect(cache.use(other, cid, nowSec + 30, now)).toBe("fresh");
    expect(cache.use(other, cid, nowSec + 30, now)).toBe("replayed");
    expect(cache.size).toBe(2);
    expect(cache.use("c".repeat(20), cid, nowSec + 30, now + 35_001)).toBe(
      "full",
    );
    expect(cache.size).toBe(0);
  });

  it("rejects invalid clocks and expiration beyond a verified token's maximum remaining lifetime", () => {
    const cache = new ReplayCache();
    expect(cache.use(db, cid, nowSec + 1000, now)).toBe("full");
    expect(cache.use(db, cid, nowSec + 30, NaN)).toBe("full");
    expect(cache.use(db, cid, Infinity, now)).toBe("full");
    expect(cache.size).toBe(0);
  });

  it("accepts a cid once and rejects the second use", () => {
    const cache = new ReplayCache();
    expect(cache.use(db, cid, nowSec + 30, now)).toBe("fresh");
    expect(cache.use(db, cid, nowSec + 30, now + 1000)).toBe("replayed");
  });

  it("keeps a cid until its token can no longer verify, then evicts it", () => {
    const cache = new ReplayCache();
    cache.use(db, cid, nowSec + 30, now);
    expect(cache.use(db, cid, nowSec + 30, now + 35_000)).toBe("replayed");
    cache.use(
      db,
      "11111111-1111-4111-8111-111111111111",
      nowSec + 60,
      now + 35_001,
    );
    expect(cache.size).toBe(1);
  });

  it("fails closed when full of live entries and recovers after expiry", () => {
    const cache = new ReplayCache(2);
    expect(cache.use(db, "a", nowSec + 30, now)).toBe("fresh");
    expect(cache.use(db, "b", nowSec + 30, now)).toBe("fresh");
    expect(cache.use(db, "c", nowSec + 30, now)).toBe("full");
    expect(cache.size).toBe(2);
    // An expired entry behind a longer-lived one is found by the full sweep.
    const swept = new ReplayCache(2);
    swept.use(db, "long", nowSec + 30, now);
    swept.use(db, "short", nowSec + 10, now);
    expect(swept.use(db, "next", nowSec + 30, now + 20_000)).toBe("fresh");
    expect(swept.size).toBe(2);
  });
});
