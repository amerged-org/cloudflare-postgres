// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_MAX_LENGTH,
  deriveNodeKey,
  deriveNodeKeyring,
  deriveRegionKey,
  deriveRegionKeyring,
  parseRouteKeyring,
  serializeRouteKeyring,
  signLegacyRouteToken,
  signNodeRouteToken,
  signRouteToken,
  signWakeRouteToken,
  roleRevisionHash,
  ROUTE_TOKEN_WAKE_PREFIX,
  ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_ADMISSION_MAX_LENGTH,
  ROUTE_TOKEN_NODE_KEY_DOMAIN,
  ROUTE_TOKEN_NODE_PREFIX,
  ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
  verifyRouteToken,
  type RouteKeyring,
  type SignRouteTokenInput,
} from "../src/route-token.ts";
import conformance from "../native/conformance.generated.json" with { type: "json" };

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

describe("wake route token v5", () => {
  const wake = {
    operation: `op_${"c".repeat(20)}`,
    generation: 8,
    route_revision: 19,
    role_revision_hash: "a".repeat(64),
  };
  const input = { keyring: master, region, db, user, cid, wake, now };

  it("a v5 wake route signs and verifies with op, gen, route_revision and rh", async () => {
    expect(ROUTE_TOKEN_WAKE_PREFIX).toBe("v5");
    expect(ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN).toBe("pgcf-route/v5\n");
    const token = await signWakeRouteToken(input);
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe("v5");
    const regionKey = (await regionKeys()).get("k2")!;
    expect(
      createHmac("sha256", regionKey)
        .update("pgcf-route/v5\n" + payload)
        .digest("base64url"),
    ).toBe(signature);
    const claims = {
      v: 5,
      db,
      user,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
      exp: nowSec + 30,
      op: wake.operation,
      gen: 8,
      route_revision: 19,
      rh: wake.role_revision_hash,
    };
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual(
      claims,
    );
    expect(
      await verifyRouteToken(token, { keys: await regionKeys(), region, now }),
    ).toEqual({ ok: true, claims });
  });

  it("v5 refuses the v4 domain, a changed gen, a missing rh and an over-long token", async () => {
    const keys = await regionKeys();
    const regionKey = keys.get("k2")!;
    const token = await signWakeRouteToken(input);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    const verify = (value: string) =>
      verifyRouteToken(value, { keys, region, now });
    // The same claims under the v4 domain, and v5 claims sealed as v4.
    const underV4Domain = signPayload(JSON.stringify(claims), regionKey, "v4");
    expect(await verify(`v5.${underV4Domain.slice(3)}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verify(underV4Domain)).toEqual({
      ok: false,
      reason: "invalid_claims",
    });
    const [, , signature] = token.split(".");
    const changed = b64u(Buffer.from(JSON.stringify({ ...claims, gen: 9 })));
    expect(await verify(`v5.${changed}.${signature}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const withoutRh = { ...claims, rh: undefined };
    expect(
      await verify(signPayload(JSON.stringify(withoutRh), regionKey, "v5")),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verify(
        signPayload(
          JSON.stringify({ ...claims, rh: "A".repeat(64) }),
          regionKey,
          "v5",
        ),
      ),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verify(
        signPayload(JSON.stringify({ ...claims, v: 4 }), regionKey, "v5"),
      ),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    // v5 shares the v4 admission length limit.
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_ADMISSION_MAX_LENGTH);
    expect(
      await verify(`v5.${"A".repeat(ROUTE_TOKEN_ADMISSION_MAX_LENGTH)}.x`),
    ).toEqual({ ok: false, reason: "too_long" });
    await expect(
      signWakeRouteToken({ ...input, wake: { ...wake, generation: 0 } }),
    ).rejects.toThrow(RangeError);
  });

  it("roleRevisionHash is order independent and equals the generated vector", async () => {
    const roles = [
      { name: "app", revision: 3 },
      { name: "reader", revision: 12 },
      { name: "admin", revision: 1 },
    ];
    const expected = createHash("sha256")
      .update("admin\t1\napp\t3\nreader\t12\n")
      .digest("hex");
    expect(await roleRevisionHash(roles)).toBe(expected);
    expect(await roleRevisionHash([...roles].reverse())).toBe(expected);
    expect(await roleRevisionHash([])).toBe(
      createHash("sha256").update("").digest("hex"),
    );
    const vectors = conformance.roleRevisionHashes;
    expect(vectors.length).toBeGreaterThan(1);
    for (const vector of vectors)
      expect(await roleRevisionHash(vector.roles)).toBe(vector.hash);
  });
});

describe("node route token v6", () => {
  const node = "nod_" + "a1b2c3d4e5f6g7h8i9j0";
  const other = "nod_" + "z9y8x7w6v5u4t3s2r1q0";
  const instance = "7d1f4a52-9b0e-4c6d-8a3f-5e2b1c0d9f8e";
  const target = { revision: 7, route_revision: 19, instance };
  const input = { keyring: master, region, node, db, user, cid, target, now };
  const nodeKeys = async (id = node) =>
    (await deriveNodeKeyring(master, id)).keys;

  it("derives a node key like an independent HMAC and keeps nodes apart", async () => {
    expect(ROUTE_TOKEN_NODE_KEY_DOMAIN).toBe("pgcf-route-key/v2\n");
    const expected = createHmac("sha256", keyBytes(2))
      .update("pgcf-route-key/v2\n" + node)
      .digest();
    expect(Buffer.from(await deriveNodeKey(keyBytes(2), node))).toEqual(
      expected,
    );
    expect(await deriveNodeKey(keyBytes(2), other)).not.toEqual(
      await deriveNodeKey(keyBytes(2), node),
    );
    // Neither a region key nor another kid's key is a node key.
    expect(await deriveNodeKey(keyBytes(2), node)).not.toEqual(
      await deriveRegionKey(keyBytes(2), region),
    );
    const ring = await deriveNodeKeyring(master, node);
    expect(ring.active).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k1", "k2"]);
    await expect(deriveNodeKey(keyBytes(2), "nod_short")).rejects.toThrow(
      RangeError,
    );
    await expect(deriveNodeKey(new Uint8Array(31), node)).rejects.toThrow(
      RangeError,
    );
  });

  it("a v6 route names the generation, the route revision, the node and the unit's instance", async () => {
    expect(ROUTE_TOKEN_NODE_PREFIX).toBe("v6");
    expect(ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN).toBe("pgcf-route/v6\n");
    const token = await signNodeRouteToken(input);
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe("v6");
    expect(
      createHmac("sha256", (await nodeKeys()).get("k2")!)
        .update("pgcf-route/v6\n" + payload)
        .digest("base64url"),
    ).toBe(signature);
    const claims = {
      v: 6,
      db,
      user,
      cid,
      rg: region,
      kid: "k2",
      iat: nowSec,
      exp: nowSec + 30,
      rev: 7,
      route_revision: 19,
      node,
      inst: instance,
    };
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual(
      claims,
    );
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_ADMISSION_MAX_LENGTH);
    expect(
      await verifyRouteToken(token, { keys: await nodeKeys(), region, now }),
    ).toEqual({ ok: true, claims });
    expect(
      await verifyRouteToken(token, {
        keys: await nodeKeys(),
        region,
        node,
        now,
      }),
    ).toEqual({ ok: true, claims });
  });

  it("a node verifies only its own tokens", async () => {
    const token = await signNodeRouteToken(input);
    expect(
      await verifyRouteToken(token, {
        keys: await nodeKeys(other),
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    // Not even the region's key verifies a node route.
    expect(
      await verifyRouteToken(token, { keys: await regionKeys(), region, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    // A verifier that knows its node refuses a route signed with its key for another node.
    const key = (await nodeKeys()).get("k2")!;
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    const forged = signPayload(
      JSON.stringify({ ...claims, node: other }),
      key,
      "v6",
    );
    expect(
      await verifyRouteToken(forged, {
        keys: await nodeKeys(),
        region,
        node,
        now,
      }),
    ).toEqual({ ok: false, reason: "wrong_node" });
  });

  it("v6 refuses a missing or malformed claim, the v4 domain and a tampered payload", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const token = await signNodeRouteToken(input);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    );
    const verify = (value: string) =>
      verifyRouteToken(value, { keys, region, now });
    const sign = (value: object) =>
      signPayload(JSON.stringify(value), key, "v6");
    for (const changed of [
      { inst: undefined },
      { inst: "not-a-uuid" },
      { inst: instance.toUpperCase() },
      { node: undefined },
      { node: "nod_short" },
      { route_revision: undefined },
      { route_revision: 0 },
      { rev: undefined },
      { rev: 0 },
      { rev: 7.5 },
      { pod: instance },
      { v: 5 },
    ])
      expect(await verify(sign({ ...claims, ...changed }))).toEqual({
        ok: false,
        reason: "invalid_claims",
      });
    // v6 claims sealed under the v4 domain, and v4 claims under v6.
    expect(
      await verify(
        `v6.${signPayload(JSON.stringify(claims), key, "v4").slice(3)}`,
      ),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const [, , signature] = token.split(".");
    const changed = b64u(Buffer.from(JSON.stringify({ ...claims, rev: 8 })));
    expect(await verify(`v6.${changed}.${signature}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(
      await verify(`v6.${"A".repeat(ROUTE_TOKEN_ADMISSION_MAX_LENGTH)}.x`),
    ).toEqual({ ok: false, reason: "too_long" });
    await expect(
      signNodeRouteToken({
        ...input,
        target: { ...target, instance: "not-a-uuid" },
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      signNodeRouteToken({ ...input, node: "nod_short" }),
    ).rejects.toThrow(RangeError);
  });

  it("signs a wake ticket with the node's key when it names the node", async () => {
    const wake = {
      operation: `op_${"c".repeat(20)}`,
      generation: 8,
      route_revision: 19,
      role_revision_hash: "a".repeat(64),
    };
    const token = await signWakeRouteToken({
      keyring: master,
      region,
      node,
      db,
      user,
      cid,
      wake,
      now,
    });
    expect(
      await verifyRouteToken(token, { keys: await nodeKeys(), region, now }),
    ).toMatchObject({ ok: true });
    expect(
      await verifyRouteToken(token, { keys: await regionKeys(), region, now }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      await verifyRouteToken(token, {
        keys: await nodeKeys(other),
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
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
