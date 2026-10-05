// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { newNodeId, newOperationId } from "../src/ids.ts";
import { base64urlToBytes, bytesToBase64url } from "../src/encoding.ts";
import {
  bootstrapRelayClaimsSchema,
  importBootstrapVerificationKeys,
  signBootstrapRelay,
  verifyBootstrapRelay,
  type BootstrapCryptoKey,
} from "../src/bootstrap-relay.ts";

type KeyPair = {
  privateKey: BootstrapCryptoKey;
  publicKey: BootstrapCryptoKey;
};
async function fixture() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as KeyPair;
  const keys = await importBootstrapVerificationKeys({
    current: bytesToBase64url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
  });
  const input = {
    privateKey: pair.privateKey,
    kid: "current",
    operation: newOperationId(),
    node: newNodeId(),
    region: "eu-test",
    issuer_region: "eu-control",
    relay_epoch: randomUUID(),
    revision: 1,
    capability: "rescue_ssh" as const,
    address: [192, 0, 2, 10].join("."),
    now: Date.now(),
  };
  return {
    pair,
    input,
    expected: {
      keys,
      region: input.region,
      issuer_region: input.issuer_region,
      relay_epoch: input.relay_epoch,
      now: input.now,
    },
  };
}
function claims(token: string) {
  return JSON.parse(
    new TextDecoder().decode(base64urlToBytes(token.split(".")[1]!)!),
  );
}
async function raw(
  pair: KeyPair,
  value: unknown,
  prefix = "pgcf-bootstrap-relay/v1\n",
) {
  const payload = bytesToBase64url(
    new TextEncoder().encode(JSON.stringify(value)),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    new TextEncoder().encode(prefix + payload),
  );
  return `br1.${payload}.${bytesToBase64url(new Uint8Array(signature))}`;
}

test("a purpose-bound Ed25519 token verifies with public-only keys and fresh random nonces", async () => {
  const f = await fixture(),
    a = await signBootstrapRelay(f.input),
    b = await signBootstrapRelay(f.input);
  const checked = await verifyBootstrapRelay(a, f.expected);
  assert.equal(checked.ok, true);
  assert.notEqual(claims(a).nonce, claims(b).nonce);
  assert.equal(claims(a).target.port, 22);
  assert.equal(claims(a).purpose, "bootstrap");
  for (const key of f.expected.keys.values()) {
    assert.equal(key.type, "public");
    assert.deepEqual(key.usages, ["verify"]);
  }
});
test("Talos and Kubernetes capabilities bind their exact ports rather than granting arbitrary egress", async () => {
  const f = await fixture();
  const talos = await signBootstrapRelay({
    ...f.input,
    capability: "talos_api",
  });
  const kube = await signBootstrapRelay({
    ...f.input,
    capability: "kubernetes_api",
  });
  assert.equal(claims(talos).target.port, 50000);
  assert.equal(claims(kube).target.port, 6443);
  assert.equal((await verifyBootstrapRelay(talos, f.expected)).ok, true);
  assert.equal((await verifyBootstrapRelay(kube, f.expected)).ok, true);
  const wrong = claims(talos);
  wrong.target.port = 22;
  assert.equal(
    (await verifyBootstrapRelay(await raw(f.pair, wrong), f.expected)).ok,
    false,
  );
  wrong.target.port = 5432;
  assert.equal(
    (await verifyBootstrapRelay(await raw(f.pair, wrong), f.expected)).ok,
    false,
  );
});
test("a valid signature cannot authorize another purpose or signing protocol", async () => {
  const f = await fixture(),
    value = claims(await signBootstrapRelay(f.input));
  value.purpose = "route";
  assert.equal(
    (await verifyBootstrapRelay(await raw(f.pair, value), f.expected)).ok,
    false,
  );
  value.purpose = "bootstrap";
  assert.equal(
    (
      await verifyBootstrapRelay(
        await raw(f.pair, value, "pgcf-route/v1\n"),
        f.expected,
      )
    ).ok,
    false,
  );
});
test("another key, issuer, region or process epoch cannot authorize a token", async () => {
  const f = await fixture(),
    token = await signBootstrapRelay(f.input),
    other = await fixture();
  assert.equal(
    (
      await verifyBootstrapRelay(token, {
        ...f.expected,
        keys: other.expected.keys,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await verifyBootstrapRelay(token, {
        ...f.expected,
        issuer_region: "us-control",
      })
    ).ok,
    false,
  );
  assert.equal(
    (await verifyBootstrapRelay(token, { ...f.expected, region: "us-test" }))
      .ok,
    false,
  );
  assert.equal(
    (
      await verifyBootstrapRelay(token, {
        ...f.expected,
        relay_epoch: randomUUID(),
      })
    ).ok,
    false,
  );
});
test("expired, future and excessive lifetimes fail closed with invalid clocks", async () => {
  const f = await fixture(),
    token = await signBootstrapRelay(f.input),
    value = claims(token);
  assert.equal(
    (
      await verifyBootstrapRelay(token, {
        ...f.expected,
        now: value.exp * 1000,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await verifyBootstrapRelay(token, {
        ...f.expected,
        now: value.iat * 1000 - 1,
      })
    ).ok,
    false,
  );
  assert.equal(
    (await verifyBootstrapRelay(token, { ...f.expected, now: NaN })).ok,
    false,
  );
  await assert.rejects(signBootstrapRelay({ ...f.input, ttlSeconds: 61 }));
  value.exp = value.iat + 61;
  assert.equal(
    (await verifyBootstrapRelay(await raw(f.pair, value), f.expected)).ok,
    false,
  );
});
test("literal targets reject DNS, URL, CIDR and zone syntax; unsafe revision and extra claims are rejected", async () => {
  const f = await fixture(),
    value = claims(await signBootstrapRelay(f.input));
  value.target.address = ["target", "invalid"].join(".");
  assert.equal(bootstrapRelayClaimsSchema.safeParse(value).success, false);
  value.target.address = `https://${f.input.address}`;
  assert.equal(bootstrapRelayClaimsSchema.safeParse(value).success, false);
  value.target.address = f.input.address + "/32";
  assert.equal(bootstrapRelayClaimsSchema.safeParse(value).success, false);
  value.target.address = f.input.address;
  value.revision = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(bootstrapRelayClaimsSchema.safeParse(value).success, false);
  value.revision = 1;
  value.command = crypto.randomUUID();
  assert.equal(
    (await verifyBootstrapRelay(await raw(f.pair, value), f.expected)).ok,
    false,
  );
});
test("verification refuses damaged, oversized and noncanonical encodings without returning token data", async () => {
  const f = await fixture(),
    token = await signBootstrapRelay(f.input);
  assert.deepEqual(await verifyBootstrapRelay(token + "=", f.expected), {
    ok: false,
  });
  assert.deepEqual(await verifyBootstrapRelay("x".repeat(2049), f.expected), {
    ok: false,
  });
  const [prefix, payload, signature] = token.split(".");
  assert.deepEqual(
    await verifyBootstrapRelay(
      `${prefix}.${payload}.${signature!.slice(0, -1)}!`,
      f.expected,
    ),
    { ok: false },
  );
});
test("verification-key import refuses empty, oversized, private-key-shaped and unknown configurations", async () => {
  await assert.rejects(importBootstrapVerificationKeys({}));
  await assert.rejects(
    importBootstrapVerificationKeys({ current: randomUUID() }),
  );
  await assert.rejects(
    importBootstrapVerificationKeys({
      privateKey: await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ]),
    }),
  );
});
