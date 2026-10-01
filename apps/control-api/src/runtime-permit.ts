// SPDX-License-Identifier: Apache-2.0
import {
  body,
  error,
  fields,
  json,
  sha256,
  uuid,
  type AccountingDb,
  type AccountingEnv,
} from "./accounting";
import { lease } from "./execution-auth";
import { readRuntimePermitFunding } from "./budgets";

const domain = "cloudflare-postgres/execution-permit/v2\u0000";
const scope = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const keyName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const hash = /^[a-f0-9]{64}$/;
const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const encoder = new TextEncoder();
const ISSUANCE_RESERVE_MS = 1000;
type SigningEnv = AccountingEnv & { RUNTIME_PERMIT_SIGNING_KEYS?: string };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: unknown, limit: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.length > limit * 2
  )
    throw new Error();
  const result = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (result.length > limit || encode(result) !== value) throw new Error();
  return result;
}
function signingConfiguration(env: SigningEnv): {
  installationId: string;
  keyId: string;
  privateKey: Uint8Array<ArrayBuffer>;
} {
  const value: unknown = JSON.parse(env.RUNTIME_PERMIT_SIGNING_KEYS ?? "null");
  if (
    !fields(value, ["version", "installationId", "active", "keys"]) ||
    value.version !== 1 ||
    typeof value.installationId !== "string" ||
    !scope.test(value.installationId) ||
    typeof value.active !== "string" ||
    !keyName.test(value.active) ||
    value.keys === null ||
    typeof value.keys !== "object" ||
    Array.isArray(value.keys)
  )
    throw new Error();
  const keys = value.keys as Record<string, unknown>;
  if (
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 8 ||
    !Object.keys(keys).every((key) => keyName.test(key)) ||
    !Object.hasOwn(keys, value.active)
  )
    throw new Error();
  return {
    installationId: value.installationId,
    keyId: value.active,
    privateKey: decode(keys[value.active], 256),
  };
}
function validChallenge(value: unknown): value is {
  version: 2;
  nonce: string;
  binding: {
    installationId: string;
    namespaceUid: string;
    podUid: string;
    containerName: string;
    nodeName: string;
    nodeUid: string;
    bootId: string;
    imageHash: string;
    commandHash: string;
  };
} {
  if (
    !fields(value, ["version", "nonce", "binding"]) ||
    value.version !== 2 ||
    !fields(value.binding, [
      "installationId",
      "namespaceUid",
      "podUid",
      "containerName",
      "nodeName",
      "nodeUid",
      "bootId",
      "imageHash",
      "commandHash",
    ])
  )
    return false;
  try {
    if (decode(value.nonce, 32).length !== 32) return false;
  } catch {
    return false;
  }
  const b = value.binding;
  return (
    typeof b.installationId === "string" &&
    scope.test(b.installationId) &&
    [b.namespaceUid, b.podUid, b.nodeUid, b.bootId].every(
      (id) => typeof id === "string" && uuid.test(id),
    ) &&
    b.containerName === "postgres" &&
    typeof b.nodeName === "string" &&
    b.nodeName.length <= 253 &&
    b.nodeName.split(".").every((part) => label.test(part)) &&
    typeof b.imageHash === "string" &&
    hash.test(b.imageHash) &&
    typeof b.commandHash === "string" &&
    hash.test(b.commandHash)
  );
}

export async function issueRuntimePermit(
  request: Request,
  env: SigningEnv,
  db: AccountingDb,
  regionId: string,
  operationId: string,
): Promise<Response> {
  if (
    !uuid.test(regionId) ||
    !uuid.test(operationId) ||
    new URL(request.url).searchParams.size
  )
    return error(400, "invalid_request");
  const input = await body(request, 8192);
  if (
    !fields(input, [
      "leaseToken",
      "leaseEpoch",
      "reservationId",
      "challenge",
    ]) ||
    !lease(input) ||
    typeof input.reservationId !== "string" ||
    !uuid.test(input.reservationId) ||
    !validChallenge(input.challenge)
  )
    return error(400, "invalid_request");
  const proof = await readRuntimePermitFunding(
    request,
    db,
    regionId,
    operationId,
    {
      leaseToken: input.leaseToken,
      leaseEpoch: input.leaseEpoch,
      reservationId: input.reservationId,
    },
  );
  if (proof instanceof Response) return proof;
  if (proof.binding.runEpoch !== "1" || proof.binding.specRevision !== 1)
    return error(409, "runtime_permit_unavailable");
  let configuration: ReturnType<typeof signingConfiguration>;
  try {
    configuration = signingConfiguration(env);
  } catch {
    return error(503, "runtime_permit_signing_unavailable");
  }
  if (
    input.challenge.binding.installationId !== configuration.installationId ||
    input.challenge.binding.imageHash !== proof.binding.imageHash
  )
    return error(409, "runtime_permit_unavailable");
  const issuedAtMs = Date.parse(proof.serverNow);
  const durationMs =
    Math.min(15_000, proof.deadline - issuedAtMs) - ISSUANCE_RESERVE_MS;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0)
    return error(409, "runtime_permit_unavailable");
  const validUntil = new Date(issuedAtMs + durationMs).toISOString();
  let signature: ArrayBuffer;
  let payload: string;
  try {
    const binding = {
      ...input.challenge.binding,
      ...proof.binding,
      resourceEnvelopeHash: await sha256(
        JSON.stringify(canonical(proof.envelope)),
      ),
    };
    const raw = JSON.stringify(
      canonical({
        version: 2,
        nonce: input.challenge.nonce,
        binding,
        durationNs: (BigInt(durationMs) * 1_000_000n).toString(),
        issuedAt: new Date(issuedAtMs).toISOString(),
        validUntil,
      }),
    );
    payload = encode(encoder.encode(raw));
    const key = await crypto.subtle.importKey(
      "pkcs8",
      configuration.privateKey,
      "Ed25519",
      false,
      ["sign"],
    );
    signature = await crypto.subtle.sign(
      "Ed25519",
      key,
      encoder.encode(domain + configuration.keyId + "\u0000" + raw),
    );
  } catch {
    return error(503, "runtime_permit_signing_unavailable");
  }
  const finalProof = await readRuntimePermitFunding(
    request,
    db,
    regionId,
    operationId,
    {
      leaseToken: input.leaseToken,
      leaseEpoch: input.leaseEpoch,
      reservationId: input.reservationId,
    },
  );
  if (
    finalProof instanceof Response ||
    JSON.stringify(finalProof.binding) !== JSON.stringify(proof.binding) ||
    issuedAtMs + durationMs > Math.min(proof.deadline, finalProof.deadline)
  )
    return error(409, "runtime_permit_unavailable");
  const finalObservation = await proof.recheck(validUntil);
  if (finalObservation instanceof Response)
    return error(409, "runtime_permit_unavailable");
  const completedAt = Date.parse(finalObservation.serverNow);
  if (
    issuedAtMs + durationMs > finalObservation.deadline ||
    completedAt < issuedAtMs ||
    completedAt - issuedAtMs > ISSUANCE_RESERVE_MS ||
    completedAt >= issuedAtMs + durationMs
  )
    return error(409, "runtime_permit_unavailable");
  return json(
    {
      permit: {
        version: 2,
        keyId: configuration.keyId,
        payload,
        signature: encode(new Uint8Array(signature)),
      },
      runtimeEnforced: false,
      enforcementStatus: "pending_runtime",
    },
    201,
  );
}
