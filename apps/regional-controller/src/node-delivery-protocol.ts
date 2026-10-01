// SPDX-License-Identifier: Apache-2.0
import { createHash, createPublicKey, verify } from "node:crypto";
import type {
  ExecutionPermitChallenge,
  SignedExecutionPermit,
} from "./execution-permit-types.ts";
import type {
  NodeDeliveryInitialization,
  NodeDeliverySelf,
} from "./node-delivery.ts";
export const MAX_FRAME = 16_384;
export const unknown = () => new Error("node_execution_delivery_unknown");
export const uncertain = () =>
  new Error("node_execution_publication_uncertain");
export const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const fields = (
  v: unknown,
  names: string[],
): v is Record<string, unknown> =>
  object(v) &&
  Object.keys(v).length === names.length &&
  names.every((k) => Object.hasOwn(v, k));
export const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v))
    return Object.fromEntries(
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}
export const encoded = (v: unknown) => JSON.stringify(canonical(v));
export function binary(
  v: unknown,
  length?: number,
  max = MAX_FRAME,
): v is string {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(v) ||
    v.length > max * 2
  )
    return false;
  const bytes = Buffer.from(v, "base64url");
  return (
    bytes.length <= max &&
    (length === undefined || bytes.length === length) &&
    bytes.toString("base64url") === v
  );
}
export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME) throw unknown();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export function challengeFor(
  init: NodeDeliveryInitialization,
): ExecutionPermitChallenge {
  const b = init.expected.binding;
  return {
    version: 2,
    nonce: init.nonce,
    binding: {
      installationId: b.installationId,
      namespaceUid: b.namespaceUid,
      podUid: b.podUid,
      containerName: b.containerName,
      nodeName: b.nodeName,
      nodeUid: b.nodeUid,
      bootId: b.bootId,
      imageHash: b.imageHash,
      commandHash: b.commandHash,
    },
  };
}
export function permitDuration(
  permit: SignedExecutionPermit,
  init: NodeDeliveryInitialization,
): bigint {
  if (
    !fields(permit, ["version", "keyId", "payload", "signature"]) ||
    permit.version !== 2 ||
    permit.keyId !== init.publicKeyPin.keyId ||
    !binary(permit.payload) ||
    !binary(permit.signature, 64) ||
    !binary(init.publicKeyPin.publicKey, 32)
  )
    throw unknown();
  const raw = Buffer.from(permit.payload, "base64url"),
    key = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(init.publicKeyPin.publicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
  if (
    !verify(
      null,
      Buffer.concat([
        Buffer.from(
          `cloudflare-postgres/execution-permit/v2\0${permit.keyId}\0`,
        ),
        raw,
      ]),
      key,
      Buffer.from(permit.signature, "base64url"),
    )
  )
    throw unknown();
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  );
  if (
    !fields(payload, [
      "version",
      "nonce",
      "binding",
      "durationNs",
      "issuedAt",
      "validUntil",
    ]) ||
    payload.version !== 2 ||
    payload.nonce !== init.nonce ||
    encoded(payload.binding) !== encoded(init.expected.binding) ||
    encoded(payload) !== raw.toString("utf8") ||
    typeof payload.durationNs !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(payload.durationNs)
  )
    throw unknown();
  const duration = BigInt(payload.durationNs);
  if (
    duration > 15_000_000_000n ||
    typeof payload.issuedAt !== "string" ||
    typeof payload.validUntil !== "string" ||
    !Number.isFinite(Date.parse(payload.issuedAt)) ||
    !Number.isFinite(Date.parse(payload.validUntil)) ||
    new Date(payload.issuedAt).toISOString() !== payload.issuedAt ||
    new Date(payload.validUntil).toISOString() !== payload.validUntil ||
    BigInt(Date.parse(payload.validUntil) - Date.parse(payload.issuedAt)) *
      1_000_000n !==
      duration
  )
    throw unknown();
  return duration > 10_000_000_000n ? 10_000_000_000n : duration;
}

// Known Go producers emit a sorted outer map, a typed Self, and a typed exact
// challenge. Reconstructing those bytes rejects duplicate keys and alternatives.
export function decodeAgentFrame(
  raw: Buffer,
  self: NodeDeliverySelf,
): Record<string, unknown> {
  const value = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(raw),
  );
  if (
    !object(value) ||
    value.version !== 1 ||
    encoded(value.self) !== encoded(self) ||
    !["challenge", "receipt"].includes(String(value.type))
  )
    throw unknown();
  const keys =
    value.type === "challenge"
      ? [
          "version",
          "type",
          "requestId",
          "self",
          "challenge",
          "challengeHash",
          "anchorBootNs",
        ]
      : [
          "version",
          "type",
          "requestId",
          "self",
          "challengeHash",
          "permitHash",
          "state",
          "deadlineBootNs",
        ];
  if (!fields(value, keys)) throw unknown();
  const expected: Record<string, unknown> = { ...value, self };
  if (value.type === "challenge") {
    const c = value.challenge;
    if (
      !fields(c, ["version", "nonce", "binding"]) ||
      !fields(c.binding, [
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
      throw unknown();
    const b = c.binding;
    expected.challenge = {
      version: c.version,
      nonce: c.nonce,
      binding: {
        installationId: b.installationId,
        namespaceUid: b.namespaceUid,
        podUid: b.podUid,
        containerName: b.containerName,
        nodeName: b.nodeName,
        nodeUid: b.nodeUid,
        bootId: b.bootId,
        imageHash: b.imageHash,
        commandHash: b.commandHash,
      },
    };
  }
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  );
  if (serialized !== raw.toString("utf8")) throw unknown();
  return value;
}
