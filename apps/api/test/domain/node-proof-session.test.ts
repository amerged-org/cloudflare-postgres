// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { bytesToBase64url } from "@pgcf/contracts";
import {
  NODE_PROOF_CONTROL_DOMAIN,
  canonicalNodeProof,
} from "@pgcf/contracts/node-proof";
import { createApp } from "../../src/app.ts";
import {
  authenticateNodeProofSession,
  issueNodeProofSession,
} from "../../src/domain/node-proof-session.ts";
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
