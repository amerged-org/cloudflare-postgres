// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ReplayCache,
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_MAX_LENGTH,
  ROUTE_TOKEN_NODE_KEY_DOMAIN,
  ROUTE_TOKEN_NODE_PREFIX,
  ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN,
  ROUTE_TOKEN_WAKE_PREFIX,
  ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN,
  deriveNodeKey,
  deriveNodeKeyring,
  parseRouteKeyring,
  roleRevisionHash,
  serializeRouteKeyring,
  signNodeRouteToken,
  signWakeRouteToken,
  verifyRouteToken,
  type RouteKeyring,
} from "../src/route-token.ts";
import conformance from "../native/conformance.generated.json" with { type: "json" };

const region = "eu-1";
const user = "app";
const db = "a1b2c3d4e5f6g7h8i9j0";
const cid = "0f8b5c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const now = Date.UTC(2026, 9, 2, 12, 0, 0);
const nowSec = now / 1000;
const node = "nod_" + "a1b2c3d4e5f6g7h8i9j0";
const other = "nod_" + "z9y8x7w6v5u4t3s2r1q0";
const instance = "7d1f4a52-9b0e-4c6d-8a3f-5e2b1c0d9f8e";
const target = { revision: 7, route_revision: 19, instance };
/** The claims a v6 route of `target` carries besides the connection's. */
const route = { rev: 7, route_revision: 19, node, inst: instance };

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
const input = { keyring: master, region, node, db, user, cid, target, now };

/** The keys the gateway of `id` verifies with. */
async function nodeKeys(id = node) {
  return (await deriveNodeKeyring(master, id)).keys;
}

function signPayload(payloadJson: string, key: Uint8Array, version = "v6") {
  const payload = b64u(Buffer.from(payloadJson));
  const sig = createHmac("sha256", key)
    .update(`pgcf-route/${version}\n` + payload)
    .digest();
  return `${version}.${payload}.${b64u(sig)}`;
}

function resign(payloadJson: object, key: Uint8Array, version = "v6") {
  return signPayload(JSON.stringify(payloadJson), key, version);
}

function claimsOf(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
}

const base = {
  v: 6,
  db,
  user,
  cid,
  rg: region,
  kid: "k2",
  iat: nowSec,
  exp: nowSec + 30,
  ...route,
};

describe("route token v6", () => {
  it("names the header and the wire constants", () => {
    expect(ROUTE_TOKEN_HEADER).toBe("X-PGCF-Route");
    expect(ROUTE_TOKEN_NODE_PREFIX).toBe("v6");
    expect(ROUTE_TOKEN_NODE_SIGNATURE_DOMAIN).toBe("pgcf-route/v6\n");
  });

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

  it("names the generation, the route revision, the node and the unit's instance, signed independently", async () => {
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
    expect(claimsOf(token)).toEqual(base);
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_MAX_LENGTH);
    const keys = await nodeKeys();
    expect(await verifyRouteToken(token, { keys, region, now })).toEqual({
      ok: true,
      claims: base,
    });
    expect(await verifyRouteToken(token, { keys, region, node, now })).toEqual({
      ok: true,
      claims: base,
    });
  });

  it("accepts the bounded maximum wire identities", async () => {
    const kid = "k".repeat(32);
    const keyring = { active: kid, keys: new Map([[kid, keyBytes(1)]]) };
    const wideRegion = "r".repeat(32);
    const maxUser = "r" + "a".repeat(62);
    const token = await signNodeRouteToken({
      ...input,
      keyring,
      region: wideRegion,
      user: maxUser,
      target: {
        revision: Number.MAX_SAFE_INTEGER,
        route_revision: Number.MAX_SAFE_INTEGER,
        instance,
      },
    });
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_MAX_LENGTH);
    expect(
      await verifyRouteToken(token, {
        keys: (await deriveNodeKeyring(keyring, node)).keys,
        region: wideRegion,
        node,
        now,
      }),
    ).toMatchObject({
      ok: true,
      claims: {
        v: 6,
        user: maxUser,
        rev: Number.MAX_SAFE_INTEGER,
        route_revision: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  it("requires a signed nonreserved PostgreSQL user and rejects tampering", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const token = await signNodeRouteToken(input);
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const claims = claimsOf(token);
    const changed = b64u(
      Buffer.from(JSON.stringify({ ...claims, user: "reader" })),
    );
    expect(
      await verifyRouteToken(`${prefix}.${changed}.${signature}`, {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    const { user: omitted, ...missingUser } = claims;
    expect(omitted).toBe(user);
    expect(
      await verifyRouteToken(resign(missingUser, key), { keys, region, now }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(payload).not.toBe("");
    await expect(
      signNodeRouteToken({ ...input, user: undefined } as never),
    ).rejects.toThrow(RangeError);
    for (const invalidUser of [
      "",
      "Reader",
      "a".repeat(64),
      "a-b",
      "a\0b",
      "postgres",
      "pg_read_all_data",
      1,
      null,
    ]) {
      expect(
        await verifyRouteToken(resign({ ...claims, user: invalidUser }, key), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_claims" });
      await expect(
        signNodeRouteToken({ ...input, user: invalidUser } as never),
      ).rejects.toThrow(RangeError);
    }
  });

  it("binds the generation, the route revision, the node and the unit; a token missing any is refused", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const claims = claimsOf(await signNodeRouteToken(input));
    expect(claims).toMatchObject(route);
    for (const field of ["rev", "route_revision", "node", "inst"]) {
      const { [field]: omitted, ...missing } = claims;
      expect(omitted).toBeDefined();
      expect(
        await verifyRouteToken(resign(missing, key), { keys, region, now }),
      ).toEqual({ ok: false, reason: "invalid_claims" });
    }
    for (const invalid of [
      { rev: 0 },
      { rev: 1.5 },
      { rev: Number.MAX_SAFE_INTEGER + 1 },
      { route_revision: 0 },
      { inst: "not-a-unit" },
      { inst: instance.toUpperCase() },
      { inst: null },
      { node: "nod_short" },
      { pod: instance },
      { v: 5 },
    ])
      expect(
        await verifyRouteToken(resign({ ...claims, ...invalid }, key), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_claims" });
    for (const invalidTarget of [
      { ...target, revision: 0 },
      { ...target, route_revision: 0 },
      { ...target, instance: "not-a-unit" },
    ])
      await expect(
        signNodeRouteToken({ ...input, target: invalidTarget }),
      ).rejects.toThrow(RangeError);
    await expect(
      signNodeRouteToken({ ...input, target: undefined } as never),
    ).rejects.toThrow(RangeError);
    await expect(
      signNodeRouteToken({ ...input, node: "nod_short" }),
    ).rejects.toThrow(RangeError);
  });

  it("is the only route of an awake database: v1 to v4, old claims and old signature domains are refused without fallback", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const token = await signNodeRouteToken(input);
    const [, payload] = token.split(".") as [string, string, string];
    const claims = claimsOf(token);
    for (const prefix of ["v1", "v2", "v3", "v4"])
      expect(
        await verifyRouteToken(resign(claims, key, prefix), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "malformed" });
    for (const domain of ["v1", "v2", "v3", "v4", "v5"]) {
      const signature = createHmac("sha256", key)
        .update(`pgcf-route/${domain}\n` + payload)
        .digest("base64url");
      expect(
        await verifyRouteToken(`v6.${payload}.${signature}`, {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "bad_signature" });
    }
    // The pod of the Kubernetes era is no instance.
    const { inst: unit, ...withoutUnit } = claims;
    expect(unit).toBe(instance);
    expect(
      await verifyRouteToken(resign({ ...withoutUnit, pod: unit }, key), {
        keys,
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "invalid_claims" });
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
    // A verifier that knows its node refuses a route signed with its key for another node.
    const key = (await nodeKeys()).get("k2")!;
    const forged = resign({ ...claimsOf(token), node: other }, key);
    expect(
      await verifyRouteToken(forged, {
        keys: await nodeKeys(),
        region,
        node,
        now,
      }),
    ).toEqual({ ok: false, reason: "wrong_node" });
  });

  it("rejects a tampered payload and a tampered signature", async () => {
    const token = await signNodeRouteToken(input);
    const [prefix, payload, sig] = token.split(".") as [string, string, string];
    const otherPayload = b64u(
      Buffer.from(
        JSON.stringify({ ...claimsOf(token), db: "zzzzzzzzzzzzzzzzzzzz" }),
      ),
    );
    const keys = await nodeKeys();
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

  it("rejects a token for another region even when its node's key signed it", async () => {
    const token = await signNodeRouteToken({ ...input, region: "eu-2" });
    expect(
      await verifyRouteToken(token, { keys: await nodeKeys(), region, now }),
    ).toEqual({ ok: false, reason: "wrong_region" });
  });

  it("rejects an unknown kid and accepts a retired but still listed one", async () => {
    const token = await signNodeRouteToken(input);
    const onlyK1 = new Map([["k1", (await nodeKeys()).get("k1")!]]);
    expect(
      await verifyRouteToken(token, { keys: onlyK1, region, now }),
    ).toEqual({ ok: false, reason: "unknown_kid" });
    const oldToken = await signNodeRouteToken({
      ...input,
      keyring: { ...master, active: "k1" },
    });
    expect(
      (await verifyRouteToken(oldToken, { keys: onlyK1, region, now })).ok,
    ).toBe(true);
  });

  it("enforces expiry, not-before and the 5 s skew boundary", async () => {
    const token = await signNodeRouteToken(input);
    const keys = await nodeKeys();
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
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    expect(
      (
        await verifyRouteToken(resign({ ...base, exp: nowSec + 30 }, key), {
          keys,
          region,
          now,
        })
      ).ok,
    ).toBe(true);
    for (const exp of [nowSec + 31, nowSec]) {
      expect(
        await verifyRouteToken(resign({ ...base, exp }, key), {
          keys,
          region,
          now,
        }),
      ).toEqual({ ok: false, reason: "invalid_lifetime" });
    }
    await expect(
      signNodeRouteToken({ ...input, ttlSeconds: 31 }),
    ).rejects.toThrow(RangeError);
  });

  it("fails closed for nonfinite verification clocks", async () => {
    const token = await signNodeRouteToken(input);
    const keys = await nodeKeys();
    for (const time of [NaN, Infinity, -Infinity])
      expect(
        (await verifyRouteToken(token, { keys, region, now: time })).ok,
      ).toBe(false);
  });

  it("rejects oversize and structurally invalid tokens without throwing", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const valid = await signNodeRouteToken(input);
    const [, payload, sig] = valid.split(".") as [string, string, string];
    const cases: [unknown, string][] = [
      [undefined, "missing"],
      [null, "missing"],
      ["", "missing"],
      ["v6." + "A".repeat(ROUTE_TOKEN_MAX_LENGTH) + "." + sig, "too_long"],
      [valid.replace(/^v6/, "v4"), "malformed"],
      [`v6.${payload}`, "malformed"],
      [`v6.${payload}.${sig}.x`, "malformed"],
      [`v6.${payload}=.${sig}`, "malformed"],
      [`v6.${payload}.${sig}=`, "malformed"],
      [`v6.${payload}.${sig.slice(0, -1)}`, "malformed"],
      [`v6.${payload}.${sig.slice(0, -1)}B`, "malformed"],
      [`v6.${payload}+.${sig}`, "malformed"],
      [`v6..${sig}`, "malformed"],
      [`v6.${b64u(Buffer.from("not json"))}.${sig}`, "malformed"],
      [`v6.${b64u(Buffer.from("[1]"))}.${sig}`, "malformed"],
      [`v6.${b64u(Buffer.from([0xff, 0xfe]))}.${sig}`, "malformed"],
      [`v6.${b64u(Buffer.from('{"kid":1}'))}.${sig}`, "malformed"],
      [
        `v6.${b64u(Buffer.from('{"kid":"constructor"}'))}.${sig}`,
        "unknown_kid",
      ],
      [resign({ ...base, extra: 1 }, key), "invalid_claims"],
      [resign({ ...base, db: "UPPER" }, key), "invalid_claims"],
      [resign({ ...base, iat: nowSec + 0.5 }, key), "invalid_claims"],
    ];
    for (const [token, reason] of cases) {
      expect(
        await verifyRouteToken(token as string, { keys, region, now }),
        String(token),
      ).toEqual({ ok: false, reason });
    }
  });

  it("enforces the exact token length limit", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const claims = JSON.stringify(base);
    // A padded payload of 924 bytes is 1232 characters: 3 + 1232 + 1 + 43 = 1279.
    const allowed = signPayload(claims.padEnd(924, " "), key);
    expect(allowed.length).toBe(ROUTE_TOKEN_MAX_LENGTH - 1);
    expect((await verifyRouteToken(allowed, { keys, region, now })).ok).toBe(
      true,
    );
    // Fixed 43-character signatures make a token of exactly the cap carry a noncanonical
    // base64url payload; it must reach structure validation, not the cap.
    const atLimit = allowed.replace("v6.", "v6.A");
    expect(atLimit.length).toBe(ROUTE_TOKEN_MAX_LENGTH);
    expect(await verifyRouteToken(atLimit, { keys, region, now })).toEqual({
      ok: false,
      reason: "malformed",
    });
    const oversize = signPayload(claims.padEnd(925, " "), key);
    expect(oversize.length).toBe(ROUTE_TOKEN_MAX_LENGTH + 1);
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

  it("preserves longer master keys while deriving 32-byte node keys", async () => {
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
    const derived = await deriveNodeKeyring(parsed, node);
    expect(derived.keys.get("k1")?.length).toBe(32);
    expect(Buffer.from(derived.keys.get("k1")!)).toEqual(
      createHmac("sha256", masterBytes)
        .update("pgcf-route-key/v2\n" + node)
        .digest(),
    );
    const token = await signNodeRouteToken({ ...input, keyring: parsed });
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
  const wakeInput = { keyring: master, region, node, db, user, cid, wake, now };

  it("a v5 wake route signs with the node's key and verifies with op, gen, route_revision and rh", async () => {
    expect(ROUTE_TOKEN_WAKE_PREFIX).toBe("v5");
    expect(ROUTE_TOKEN_WAKE_SIGNATURE_DOMAIN).toBe("pgcf-route/v5\n");
    const token = await signWakeRouteToken(wakeInput);
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    expect(prefix).toBe("v5");
    expect(
      createHmac("sha256", (await nodeKeys()).get("k2")!)
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
    expect(claimsOf(token)).toEqual(claims);
    expect(
      await verifyRouteToken(token, { keys: await nodeKeys(), region, now }),
    ).toEqual({ ok: true, claims });
    // Another node's key does not verify it, and a ticket is signed for a node.
    expect(
      await verifyRouteToken(token, {
        keys: await nodeKeys(other),
        region,
        now,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    await expect(
      signWakeRouteToken({ ...wakeInput, node: undefined } as never),
    ).rejects.toThrow(RangeError);
  });

  it("v5 refuses the v6 domain, a changed gen, a missing rh and an over-long token", async () => {
    const keys = await nodeKeys();
    const key = keys.get("k2")!;
    const token = await signWakeRouteToken(wakeInput);
    const claims = claimsOf(token);
    const verify = (value: string) =>
      verifyRouteToken(value, { keys, region, now });
    // The same claims under the v6 domain, and v5 claims sealed as v6.
    const underV6Domain = signPayload(JSON.stringify(claims), key, "v6");
    expect(await verify(`v5.${underV6Domain.slice(3)}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verify(underV6Domain)).toEqual({
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
      await verify(signPayload(JSON.stringify(withoutRh), key, "v5")),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verify(
        signPayload(
          JSON.stringify({ ...claims, rh: "A".repeat(64) }),
          key,
          "v5",
        ),
      ),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(
      await verify(signPayload(JSON.stringify({ ...claims, v: 6 }), key, "v5")),
    ).toEqual({ ok: false, reason: "invalid_claims" });
    expect(token.length).toBeLessThanOrEqual(ROUTE_TOKEN_MAX_LENGTH);
    expect(await verify(`v5.${"A".repeat(ROUTE_TOKEN_MAX_LENGTH)}.x`)).toEqual({
      ok: false,
      reason: "too_long",
    });
    await expect(
      signWakeRouteToken({ ...wakeInput, wake: { ...wake, generation: 0 } }),
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
