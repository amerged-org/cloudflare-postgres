// SPDX-License-Identifier: Apache-2.0
// The Edge loads no zod (apps/edge/test/bundle.node-test.ts), so it checks IDs, route claims and
// the keyring with the zod-free cores. The zod schemas stay authoritative: every vector here goes
// through a schema and through its core, and the two must answer alike.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ApiKeyId,
  DatabaseId,
  NodeId,
  OperationId,
  ProjectId,
  RegionId,
  RoleName,
  SizeClassId,
} from "../src/ids.ts";
import {
  isApiKeyId,
  isDatabaseId,
  isNodeId,
  isOperationId,
  isProjectId,
  isRegionId,
  isRoleName,
  isSizeClassId,
} from "../src/ids-core.ts";
import {
  nodeRouteTokenClaimsSchema,
  routeKeyringJsonSchema,
  wakeRouteTokenClaimsSchema,
} from "../src/route-token.ts";
import {
  isNodeRouteTokenClaims,
  isWakeRouteTokenClaims,
  parseRouteKeyring,
  type NodeRouteTokenClaims,
  type WakeRouteTokenClaims,
} from "../src/route-token-core.ts";
import conformance from "../native/conformance.generated.json" with { type: "json" };

/** The claims of a vector's token, whatever its signature or lifetime. */
function claimsOf(token: string | null): unknown[] {
  if (token === null) return [];
  const payload = token.split(".")[1];
  if (payload === undefined) return [];
  try {
    return [JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))];
  } catch {
    return [];
  }
}

const vectorTokens = [...conformance.wakeRoutes, ...conformance.nodeRoutes].map(
  (row) => row.token,
);
vectorTokens.push(conformance.wakeSigned.token, conformance.nodeSigned.token);
for (const row of conformance.edge.signing) vectorTokens.push(row.expected);
const vectorClaims = vectorTokens.flatMap(claimsOf);

// Both directions: a core that is stricter than its schema refuses what the API accepts.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const claimTypesAgree: [
  Mutual<z.infer<typeof nodeRouteTokenClaimsSchema>, NodeRouteTokenClaims>,
  Mutual<z.infer<typeof wakeRouteTokenClaimsSchema>, WakeRouteTokenClaims>,
] = [true, true];

describe("the zod-free IDs", () => {
  const checks: [string, z.ZodType, (value: unknown) => boolean][] = [
    ["project", ProjectId, isProjectId],
    ["operation", OperationId, isOperationId],
    ["api key", ApiKeyId, isApiKeyId],
    ["node", NodeId, isNodeId],
    ["database", DatabaseId, isDatabaseId],
    ["region", RegionId, isRegionId],
    ["size class", SizeClassId, isSizeClassId],
    ["role", RoleName, isRoleName],
  ];
  const twenty = "a1b2c3d4e5f6g7h8i9j0";
  const samples = [
    twenty,
    `prj_${twenty}`,
    `op_${twenty}`,
    `key_${twenty}`,
    `nod_${twenty}`,
    "eu-1",
    "eu-test",
    "sm",
    "app",
    "reader",
    "postgres",
    "streaming_replica",
    "pg_monitor",
    "pg_",
    "cnpg_pooler",
    "postgres2",
  ];
  // Near misses of every sample, and the values the shared vectors put in a claim.
  const strings = new Set<string>(samples);
  for (const sample of samples) {
    strings.add(sample + "\n");
    strings.add("\n" + sample);
    strings.add(" " + sample);
    strings.add(sample.toUpperCase());
    strings.add(sample.slice(1));
    strings.add(sample.slice(0, -1));
    strings.add(sample + "a");
    strings.add("1" + sample);
    strings.add("_" + sample);
    strings.add("-" + sample);
    strings.add(sample.slice(0, -1) + "-");
    strings.add(sample.slice(0, -1) + "_");
    strings.add(sample.slice(0, -1) + "٣");
    strings.add(sample.slice(0, -1) + "\u0000");
  }
  for (const claims of vectorClaims)
    for (const value of Object.values(claims as Record<string, unknown>))
      if (typeof value === "string") strings.add(value);
  strings.add("");
  strings.add("a".repeat(63));
  strings.add("a".repeat(64));
  strings.add("a".repeat(31));
  strings.add("a".repeat(32));
  const values: unknown[] = [
    ...strings,
    undefined,
    null,
    0,
    1,
    true,
    [],
    {},
    ["app"],
  ];

  it.each(checks)(
    "%s answers as its schema does, for every vector",
    (_name, schema, check) => {
      let accepted = 0;
      for (const value of values) {
        const expected = schema.safeParse(value).success;
        expect(check(value), inspect(value)).toBe(expected);
        if (expected) accepted += 1;
      }
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(values.length);
    },
  );
});

describe("the zod-free route claims", () => {
  const node = conformance.nodeRoutes
    .filter((row) => row.name === "valid")
    .flatMap((row) => claimsOf(row.token))[0] as Record<string, unknown>;
  const wake = conformance.wakeRoutes
    .filter((row) => row.name === "valid")
    .flatMap((row) => claimsOf(row.token))[0] as Record<string, unknown>;
  const claimChecks: [
    string,
    z.ZodType,
    (value: unknown) => boolean,
    Record<string, unknown>,
  ][] = [
    ["node", nodeRouteTokenClaimsSchema, isNodeRouteTokenClaims, node],
    ["wake", wakeRouteTokenClaimsSchema, isWakeRouteTokenClaims, wake],
  ];
  const bad: unknown[] = [
    undefined,
    null,
    "",
    " ",
    "x",
    "1",
    "A".repeat(20),
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    -0,
    2 ** 53,
    Number.MAX_SAFE_INTEGER,
    1n,
    true,
    [],
    {},
  ];

  it("the types of the cores are the types of the schemas", () => {
    expect(claimTypesAgree).toEqual([true, true]);
  });

  it.each(claimChecks)(
    "%s claims answer as their schema does, for every vector",
    (_name, schema, check, valid) => {
      // The claims of every token in the shared vectors, valid or broken, of either kind.
      const claims: unknown[] = [
        ...vectorClaims,
        valid,
        null,
        undefined,
        "claims",
        1,
        [],
        [valid],
        { ...valid, extra: 1 },
        { ...valid, v: 4, pod: "x" },
      ];
      // Every claim removed, and replaced by every kind of wrong value.
      for (const key of Object.keys(valid)) {
        claims.push(
          Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key)),
        );
        for (const value of bad) claims.push({ ...valid, [key]: value });
        for (const [other, replacement] of Object.entries(
          valid === node ? wake : node,
        ))
          claims.push({ ...valid, [other]: replacement });
      }
      let accepted = 0;
      for (const value of claims) {
        const expected = schema.safeParse(value).success;
        expect(check(value), inspect(value)).toBe(expected);
        if (expected) accepted += 1;
      }
      expect(accepted).toBeGreaterThan(0);
      expect(accepted).toBeLessThan(claims.length);
    },
  );
});

describe("the zod-free keyring", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const keyring = (value: unknown) => JSON.stringify(value);
  const two = keyring({ active: "k2", keys: { k1: key, k2: key } });
  const short = keyring({ active: "k1", keys: { k1: key.slice(0, 20) } });
  const unlisted = keyring({ active: "k2", keys: { k1: key } });
  const texts = [
    keyring({ active: "k1", keys: { k1: key } }),
    two,
    keyring({ active: "k1", keys: { k1: key, retired: key } }),
    keyring({ active: "1", keys: { "1": key } }),
    keyring({ active: "k1", keys: { k1: key }, extra: 1 }),
    keyring({ active: "k1" }),
    keyring({ keys: { k1: key } }),
    keyring({ active: "k1", keys: {} }),
    keyring({ active: "k1", keys: { k1: 1 } }),
    keyring({ active: "k1", keys: { k1: null } }),
    keyring({ active: "k1", keys: { k1: "A".repeat(1024) } }),
    keyring({ active: "k1", keys: { k1: "A".repeat(1025) } }),
    keyring({ active: "k1", keys: [key] }),
    keyring({ active: "k1", keys: null }),
    keyring({ active: 1, keys: { k1: key } }),
    keyring({ active: "", keys: { k1: key } }),
    keyring({ active: "-k1", keys: { "-k1": key } }),
    keyring({ active: "k".repeat(32), keys: { ["k".repeat(32)]: key } }),
    keyring({ active: "k".repeat(33), keys: { ["k".repeat(33)]: key } }),
    keyring({ active: "k1", keys: { k1: key, "bad kid": key } }),
    keyring({ active: "k1", keys: { k1: key, "": key } }),
    short,
    keyring({ active: "k1", keys: { k1: key + "=" } }),
    keyring({ active: "k1", keys: { k1: "!!!!" } }),
    unlisted,
    keyring([]),
    keyring(null),
    keyring("k1"),
    keyring(1),
    '{"active":"k1","keys":{"k1":"' + key + '"},}',
    '{"active":"__proto__","keys":{"__proto__":"' + key + '"}}',
    "",
    "{",
    "k1",
  ];
  const message = (text: string): string | null => {
    try {
      parseRouteKeyring(text);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("refuses a wrong shape exactly as the schema does", () => {
    let wrong = 0;
    for (const text of texts) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        expect(message(text), text).toBe("invalid route keyring: not JSON");
        continue;
      }
      const shaped = routeKeyringJsonSchema.safeParse(value).success;
      const reason = message(text);
      expect(reason === "invalid route keyring: wrong shape", text).toBe(
        !shaped,
      );
      if (!shaped) wrong += 1;
    }
    expect(wrong).toBeGreaterThan(0);
    expect(wrong).toBeLessThan(texts.length);
  });

  it("parses the keys of a valid keyring and refuses a weak or an unlisted one", () => {
    const ring = parseRouteKeyring(two);
    expect(ring.active).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k1", "k2"]);
    expect(Buffer.from(ring.keys.get("k2")!)).toEqual(Buffer.alloc(32, 7));
    expect(message(short)).toMatch(/at least 32 bytes/);
    expect(message(unlisted)).toBe("invalid route keyring: active key missing");
  });
});
