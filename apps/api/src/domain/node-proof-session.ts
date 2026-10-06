// SPDX-License-Identifier: Apache-2.0
import { base64urlToBytes, bytesToBase64url } from "@pgcf/contracts";
import {
  NodeProofClaims,
  NodeProofControl,
  NODE_PROOF_CONTROL_DOMAIN,
  NODE_PROOF_SESSION_DOMAIN,
  canonicalNodeProof,
  type NodeProofMode,
} from "@pgcf/contracts/node-proof";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { bearer } from "../middleware/auth.ts";
import { bootstrapTransportSigningKey } from "./bootstrap-relay.ts";
import { readNodeInstallationBinding } from "./node-installation.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";

const encoder = new TextEncoder();
const unavailable = (): never => {
  throw new ApiError(
    "forbidden",
    "Network proof authority is unavailable or changed",
  );
};
const unauthorized = (): never => {
  throw new ApiError("unauthorized", "Invalid network proof authority");
};
async function signer(env: Env) {
  const key = await bootstrapTransportSigningKey(
    env.BOOTSTRAP_RELAY_SIGNING_KEYS,
  );
  const publicKeys = JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS) as Record<
    string,
    string
  >;
  const publicKey = (await importBootstrapVerificationKeys(publicKeys)).get(
    key.kid,
  );
  if (!publicKey)
    throw new ApiError(
      "conflict",
      "Automation signing key is absent from trusted verifier configuration",
    );
  const challenge = encoder.encode(
    NODE_PROOF_SESSION_DOMAIN + crypto.randomUUID(),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    challenge,
  );
  if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)))
    throw new ApiError(
      "conflict",
      "Automation signing key does not match its trusted verifier",
    );
  const raw = base64urlToBytes(publicKeys[key.kid]!)!;
  const spki = new Uint8Array(44);
  spki.set([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  spki.set(raw, 12);
  return { ...key, publicKeys: { [key.kid]: bytesToBase64url(spki) } };
}
async function current(env: Env, operationId: string) {
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  const binding = await readNodeInstallationBinding(env.DB, operationId);
  const plan = await env.DB.prepare(
    "SELECT plan_sha256,readback_at,status FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      plan_sha256: string;
      readback_at: string | null;
      status: string;
    }>();
  const job = await env.DB.prepare(
    "SELECT input_hash,authorized,admitted,cancelled FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      input_hash: string;
      authorized: number;
      admitted: number;
      cancelled: number;
    }>();
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status) ||
    !binding ||
    binding.node_id !== addition.intent.node_id ||
    binding.provider_instance_id !== addition.provider_instance_id ||
    !plan?.readback_at ||
    plan.status === "blocked" ||
    (job && (!job.authorized || job.admitted || job.cancelled))
  )
    return unavailable();
  return { addition, binding, plan, job };
}
export async function issueNodeProofSession(
  env: Env,
  operationId: string,
  mode: NodeProofMode,
  now = Date.now(),
) {
  const state = await current(env, operationId),
    key = await signer(env);
  if (
    mode === "postjoin" &&
    (!state.job || state.addition.checkpoint?.stage !== "joined")
  )
    return unavailable();
  const claims = NodeProofClaims.parse({
    version: 1,
    kid: key.kid,
    mode,
    session_id: crypto.randomUUID(),
    operation_id: operationId,
    node_id: state.binding.node_id,
    region_id: state.binding.region_id,
    provider_instance_id: state.binding.provider_instance_id,
    binding_sha256: state.binding.binding_sha256,
    inspection_generation: state.binding.inspection_generation,
    plan_sha256: state.plan.plan_sha256,
    input_hash: state.job?.input_hash ?? null,
    checkpoint_reference:
      mode === "postjoin" ? state.addition.checkpoint!.reference : null,
    origin: new URL(env.NODE_BOOTSTRAP_CALLBACK_URL).origin,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 540000).toISOString(),
  });
  const payload = bytesToBase64url(encoder.encode(canonicalNodeProof(claims)));
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    encoder.encode(NODE_PROOF_SESSION_DOMAIN + payload),
  );
  return {
    claims,
    bearer: `np1.${payload}.${bytesToBase64url(new Uint8Array(signature))}`,
    control_keys: key.publicKeys,
  };
}
export async function authenticateNodeProofSession(
  env: Env,
  token: string,
  operationId?: string,
): Promise<NodeProofClaims> {
  if (
    token.length > 4096 ||
    !/^np1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    return unauthorized();
  const parts = token.split("."),
    payload = base64urlToBytes(parts[1]!),
    signature = base64urlToBytes(parts[2]!);
  if (!payload || !signature || signature.length !== 64) return unauthorized();
  let claims: NodeProofClaims;
  try {
    claims = NodeProofClaims.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          payload,
        ),
      ),
    );
  } catch {
    return unauthorized();
  }
  if (
    bytesToBase64url(encoder.encode(canonicalNodeProof(claims))) !== parts[1] ||
    (operationId && claims.operation_id !== operationId)
  )
    return unauthorized();
  const key = (
    await importBootstrapVerificationKeys(
      JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
    )
  ).get(claims.kid);
  if (
    !key ||
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      encoder.encode(NODE_PROOF_SESSION_DOMAIN + parts[1]),
    ))
  )
    return unauthorized();
  const now = Date.now(),
    issued = Date.parse(claims.issued_at),
    expires = Date.parse(claims.expires_at);
  if (
    issued > now + 5000 ||
    expires <= now ||
    expires <= issued ||
    expires - issued > 600000 ||
    claims.origin !== new URL(env.NODE_BOOTSTRAP_CALLBACK_URL).origin
  )
    return unauthorized();
  const state = await current(env, claims.operation_id);
  if (
    claims.node_id !== state.binding.node_id ||
    claims.region_id !== state.binding.region_id ||
    claims.provider_instance_id !== state.binding.provider_instance_id ||
    claims.binding_sha256 !== state.binding.binding_sha256 ||
    claims.inspection_generation !== state.binding.inspection_generation ||
    claims.plan_sha256 !== state.plan.plan_sha256 ||
    claims.input_hash !== (state.job?.input_hash ?? null) ||
    (claims.mode === "postjoin" &&
      (state.addition.checkpoint?.stage !== "joined" ||
        state.addition.checkpoint.reference !== claims.checkpoint_reference))
  )
    return unavailable();
  return claims;
}
export async function authenticateNodeProofRequest(
  c: ApiContext,
  operationId?: string,
) {
  return authenticateNodeProofSession(c.env, bearer(c), operationId);
}
export async function signNodeProofDocument<T>(
  env: Env,
  domain: string,
  payload: T,
  canonicalize: (value: T) => string = canonicalNodeProof,
) {
  const key = await signer(env);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    key.privateKey,
    encoder.encode(domain + canonicalize(payload)),
  );
  return {
    kid: key.kid,
    payload,
    signature: bytesToBase64url(new Uint8Array(signature)),
  };
}
export async function nodeProofSourceControl(c: ApiContext, nonce: string) {
  const claims = await authenticateNodeProofRequest(c);
  const source = c.req.header("CF-Connecting-IP");
  const parsed = NodeProofControl.safeParse({
    nonce,
    source,
    origin: claims.origin,
    observed_at: new Date().toISOString(),
  });
  if (!parsed.success)
    throw new ApiError(
      "conflict",
      "Actual source control address is unavailable",
    );
  return c.json(
    await signNodeProofDocument(c.env, NODE_PROOF_CONTROL_DOMAIN, parsed.data),
  );
}
