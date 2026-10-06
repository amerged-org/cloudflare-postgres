// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { bytesToBase64url, base64urlToBytes } from "@pgcf/contracts";
import {
  NODE_PROOF_CONTROL_DOMAIN,
  canonicalNodeProof,
} from "@pgcf/contracts/node-proof";
import { createApp } from "../../src/app.ts";
import {
  authenticateNodeProofSession,
  issueNodeProofSession,
  signNodeProofDocument,
} from "../../src/domain/node-proof-session.ts";
import { bootstrapTransportSigningKey } from "../../src/domain/bootstrap-relay.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";
const regions: string[] = [];
afterEach(async () => {
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});
async function fixture() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_keypair_invalid");
  const secret = await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(secret instanceof ArrayBuffer) || !(publicKey instanceof ArrayBuffer))
    throw new Error("fixture_keypair_invalid");
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "automation",
    keys: { automation: bytesToBase64url(new Uint8Array(secret)) },
  });
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    automation: bytesToBase64url(new Uint8Array(publicKey)),
  });
  return { ...f, pair };
}
it("authenticates source-control before parsing any malformed private body", async () => {
  const f = await fixture(),
    ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request("https://api.invalid/source-control", {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid",
        "Content-Type": "application/json",
      },
      body: "{",
    }),
    f.bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(401);
});
it("signs only the actual source observation under a current operation-bound session", async () => {
  const f = await fixture(),
    id = f.addition.intent.operation_id,
    session = await issueNodeProofSession(f.bindings, id, "preparation");
  const ctx = createExecutionContext(),
    nonce = "a".repeat(64);
  const response = await createApp().fetch(
    new Request("https://api.invalid/source-control", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.bearer}`,
        "Content-Type": "application/json",
        "CF-Connecting-IP": "2001:db8:7::9",
      },
      body: JSON.stringify({ nonce }),
    }),
    f.bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(200);
  const doc = (await response.json()) as {
    kid: string;
    payload: {
      nonce: string;
      source: string;
      origin: string;
      observed_at: string;
    };
    signature: string;
  };
  expect(doc.payload).toMatchObject({
    nonce,
    source: "2001:db8:7::9",
    origin: "https://api.invalid",
  });
  const signature = Uint8Array.from(
    atob(doc.signature.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      f.pair.publicKey,
      signature,
      new TextEncoder().encode(
        NODE_PROOF_CONTROL_DOMAIN + canonicalNodeProof(doc.payload),
      ),
    ),
  ).toBe(true);
  await env.DB.prepare(
    "UPDATE node_installation_bindings SET inspection_generation=inspection_generation+1 WHERE operation_id=?",
  )
    .bind(id)
    .run();
  await expect(
    authenticateNodeProofSession(f.bindings, session.bearer, id),
  ).rejects.toMatchObject({ code: "forbidden" });
});
it("refuses an absent verifier key before dispatch and closes expired or foreign sessions", async () => {
  const f = await fixture(),
    id = f.addition.intent.operation_id;
  const expired = await issueNodeProofSession(
    f.bindings,
    id,
    "preparation",
    Date.now() - 600000,
  );
  await expect(
    authenticateNodeProofSession(f.bindings, expired.bearer, id),
  ).rejects.toMatchObject({ code: "unauthorized" });
  const session = await issueNodeProofSession(f.bindings, id, "preparation");
  await expect(
    authenticateNodeProofSession(
      f.bindings,
      session.bearer,
      "op_" + "b".repeat(20),
    ),
  ).rejects.toMatchObject({ code: "unauthorized" });
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    old: JSON.parse(f.bindings.BOOTSTRAP_VERIFIER_KEYS).automation,
  });
  await expect(
    issueNodeProofSession(f.bindings, id, "preparation"),
  ).rejects.toMatchObject({ code: "conflict" });
});
async function unrelatedPublicKey() {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("publicKey" in pair)) throw new Error("fixture_keypair_invalid");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("fixture_keypair_invalid");
  return bytesToBase64url(new Uint8Array(raw));
}
it("preserves a colliding legacy verifier and signs proofs under a separately trusted alias", async () => {
  const f = await fixture(),
    id = f.addition.intent.operation_id;
  const alias = "node-automation-v1",
    originalSigning = f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS;
  const relayPublic = JSON.parse(f.bindings.BOOTSTRAP_VERIFIER_KEYS)
    .automation as string;
  const trust = {
    automation: await unrelatedPublicKey(),
    [alias]: relayPublic,
  };
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify(trust);
  await expect(
    issueNodeProofSession(f.bindings, id, "preparation"),
  ).rejects.toMatchObject({ code: "conflict" });
  Object.assign(f.bindings, { NODE_PROOF_SIGNING_KEY_ID: alias });
  const session = await issueNodeProofSession(f.bindings, id, "preparation");
  expect(session.claims.kid).toBe(alias);
  expect(Object.keys(session.control_keys)).toEqual([alias]);
  expect(
    await authenticateNodeProofSession(f.bindings, session.bearer, id),
  ).toEqual(session.claims);
  const spki = await crypto.subtle.importKey(
    "spki",
    Uint8Array.from(base64urlToBytes(session.control_keys[alias]!)!),
    "Ed25519",
    false,
    ["verify"],
  );
  const payload = {
    nonce: "a".repeat(64),
    origin: "https://api.invalid",
    source: "2001:db8:7::9",
    observed_at: new Date().toISOString(),
  };
  const document = await signNodeProofDocument(
    f.bindings,
    NODE_PROOF_CONTROL_DOMAIN,
    payload,
  );
  expect(document.kid).toBe(alias);
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      spki,
      Uint8Array.from(base64urlToBytes(document.signature)!),
      new TextEncoder().encode(
        NODE_PROOF_CONTROL_DOMAIN + canonicalNodeProof(payload),
      ),
    ),
  ).toBe(true);
  expect(f.bindings.BOOTSTRAP_VERIFIER_KEYS).toBe(JSON.stringify(trust));
  expect(f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS).toBe(originalSigning);
  expect((await bootstrapTransportSigningKey(originalSigning)).kid).toBe(
    "automation",
  );
});
it("refuses unknown, mismatched and malformed proof aliases before signing", async () => {
  const f = await fixture(),
    id = f.addition.intent.operation_id;
  Object.assign(f.bindings, { NODE_PROOF_SIGNING_KEY_ID: "untrusted-alias" });
  await expect(
    issueNodeProofSession(f.bindings, id, "preparation"),
  ).rejects.toMatchObject({ code: "conflict" });
  const trust = JSON.parse(f.bindings.BOOTSTRAP_VERIFIER_KEYS) as Record<
    string,
    string
  >;
  trust["untrusted-alias"] = await unrelatedPublicKey();
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify(trust);
  await expect(
    issueNodeProofSession(f.bindings, id, "preparation"),
  ).rejects.toMatchObject({ code: "conflict" });
  Object.assign(f.bindings, { NODE_PROOF_SIGNING_KEY_ID: "" });
  await expect(
    issueNodeProofSession(f.bindings, id, "preparation"),
  ).rejects.toMatchObject({ code: "conflict" });
});
