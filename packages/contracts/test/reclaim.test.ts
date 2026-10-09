// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { base64urlToBytes } from "../src/encoding.ts";
import {
  ReclaimClaims,
  reclaimClaimsValidAt,
  verifyReclaimIntent,
  signReclaimIntent,
} from "../src/reclaim.ts";
const vector = JSON.parse(
  readFileSync(
    new URL("../native/reclaim-vectors.generated.json", import.meta.url),
    "utf8",
  ),
);
it("CF signatures bind PostgreSQL identity, revocation and short expiry", async () => {
  const publicKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(base64urlToBytes(vector.keyset["cf-unit"])!),
    "Ed25519",
    false,
    ["verify"],
  );
  const keys = new Map([["cf-unit", publicKey]]);
  expect(await verifyReclaimIntent(vector.token, keys, 1000)).toEqual(
    vector.claims,
  );
  expect(await verifyReclaimIntent(vector.token, keys, 6000)).toBeNull();
  expect(
    await verifyReclaimIntent(vector.malformedToken, keys, 1000),
  ).toBeNull();
  expect(await verifyReclaimIntent(vector.revokedToken, keys, 1000)).toEqual(
    vector.revoked,
  );
});
it("arbitrary paths, credentials, unbounded leases and equal request/limit cannot authorize reclaim", () => {
  expect(
    ReclaimClaims.safeParse({ ...vector.claims, cgroup_path: "/system.slice" })
      .success,
  ).toBe(false);
  expect(
    ReclaimClaims.safeParse({ ...vector.claims, password: "forbidden" })
      .success,
  ).toBe(false);
  expect(
    reclaimClaimsValidAt({ ...vector.claims, expires_at: 6001 }, 1000),
  ).toBe(false);
  expect(
    reclaimClaimsValidAt(
      {
        ...vector.claims,
        memory_request_bytes: vector.claims.memory_limit_bytes,
      },
      1000,
    ),
  ).toBe(false);
  expect(
    reclaimClaimsValidAt({ ...vector.revoked, budget_bytes: 1 }, 1000),
  ).toBe(false);
});
it("a real unrelated signer cannot forge an authorization", async () => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw Error("key pair missing");
  const token = await signReclaimIntent(vector.claims, pair.privateKey, 1000);
  const original = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(base64urlToBytes(vector.keyset["cf-unit"])!),
    "Ed25519",
    false,
    ["verify"],
  );
  expect(
    await verifyReclaimIntent(token, new Map([["cf-unit", original]]), 1000),
  ).toBeNull();
});
