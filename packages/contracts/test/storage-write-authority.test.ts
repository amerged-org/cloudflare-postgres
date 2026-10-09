// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { bytesToBase64url } from "../src/encoding.ts";
import {
  canonicalStorageAuthorityKeys,
  signStorageWriteAuthority,
  verifyStorageWriteAuthority,
  STORAGE_AUTHORITY_DOMAIN,
  type StorageWriteClaims,
} from "../src/storage-write-authority.ts";

function claims(): StorageWriteClaims {
  return {
    v: 1,
    kid: "cf",
    database_id: "abcdefghijklmnopqrst",
    generation: 1,
    authority_revision: 1,
    storage_uid: "11111111-1111-4111-8111-111111111111",
    node_uid: "22222222-2222-4222-8222-222222222222",
    volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
    pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg",
    profile_sha256: "a".repeat(64),
    volume_handle: "pvc-33333333-3333-4333-8333-333333333333",
    lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh",
    pvc_uid: "33333333-3333-4333-8333-333333333333",
    pv_uid: "44444444-4444-4444-8444-444444444444",
    pod_uid: "55555555-5555-4555-8555-555555555555",
    observed_at: 1000,
    iat: 1000,
    exp: 11000,
    guard_seconds: 10,
    drain_seconds: 10,
    write_allowed: true,
  };
}
async function issuer() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair))
    throw new Error("Expected real Ed25519 key pair");
  return pair;
}

it("actual CF-only signatures bind current physical authority and expiry", async () => {
  const pair = await issuer(),
    value = claims(),
    trust = new Map([["cf", pair.publicKey]]);
  const token = await signStorageWriteAuthority(value, pair.privateKey, 1000);
  expect(await verifyStorageWriteAuthority(token, trust, 1000)).toEqual(value);
  expect(await verifyStorageWriteAuthority(token, trust, 11000)).toBeNull();
  expect(
    await verifyStorageWriteAuthority(
      token,
      new Map([["cf", (await issuer()).publicKey]]),
      1000,
    ),
  ).toBeNull();
  const parts = token.split(".");
  parts[1] = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify({ ...value, generation: 2 })),
  );
  expect(
    await verifyStorageWriteAuthority(parts.join("."), trust, 1000),
  ).toBeNull();
  const blocked = { ...value, authority_revision: 2, write_allowed: false };
  expect(
    await verifyStorageWriteAuthority(
      await signStorageWriteAuthority(blocked, pair.privateKey, 1000),
      trust,
      1000,
    ),
  ).toEqual(blocked);
});

it("signed integral numeric forms retain Zod semantics and unbounded authority is refused", async () => {
  const pair = await issuer(),
    value = claims(),
    body = bytesToBase64url(
      new TextEncoder().encode(
        JSON.stringify(value).replace('"generation":1,', '"generation":1.0,'),
      ),
    );
  const signature = bytesToBase64url(
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(STORAGE_AUTHORITY_DOMAIN + body),
      ),
    ),
  );
  expect(
    await verifyStorageWriteAuthority(
      `sa1.${body}.${signature}`,
      new Map([["cf", pair.publicKey]]),
      1000,
    ),
  ).toEqual(value);
  await expect(
    signStorageWriteAuthority(
      { ...value, exp: 121001, guard_seconds: 120 },
      pair.privateKey,
      1000,
    ),
  ).rejects.toThrow();
});

it("trust material is canonical public32 data, independent of ledger-provided JSON", async () => {
  const pair = await issuer(),
    raw = bytesToBase64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    );
  expect(canonicalStorageAuthorityKeys({ z: raw, a: raw })).toBe(
    JSON.stringify({ a: raw, z: raw }),
  );
  expect(() => canonicalStorageAuthorityKeys({ cf: "untrusted" })).toThrow();
  expect(() => canonicalStorageAuthorityKeys({})).toThrow();
});
