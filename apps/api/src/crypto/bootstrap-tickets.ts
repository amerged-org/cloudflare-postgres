// SPDX-License-Identifier: Apache-2.0
import {
  base64urlToBytes,
  bytesToBase64url,
  bytesToHex,
  OperationId,
} from "@pgcf/contracts";
import {
  NodeBootstrapInput,
  type NodePlatformConfiguration,
} from "@pgcf/contracts/node-bootstrap";
import { z } from "zod";

const KeyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const Config = z.strictObject({
  active: KeyId,
  keys: z.record(KeyId, z.string()),
});
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export interface BootstrapTicket {
  operation_id: string;
  input_hash: string;
  revision: number;
  ciphertext: string;
  iv: string;
  kid: string;
}
const encoder = new TextEncoder();
function aad(
  ticket: Pick<
    BootstrapTicket,
    "operation_id" | "input_hash" | "revision" | "kid"
  >,
) {
  OperationId.parse(ticket.operation_id);
  Hash.parse(ticket.input_hash);
  KeyId.parse(ticket.kid);
  if (!Number.isSafeInteger(ticket.revision) || ticket.revision < 1)
    throw new Error("bootstrap_ticket_revision_invalid");
  return encoder.encode(
    `pgcf-node-bootstrap-input/v1\n${ticket.operation_id}\n${ticket.input_hash}\n${ticket.revision}\n${ticket.kid}`,
  );
}
async function key(secret: string, kid: string, usage: "encrypt" | "decrypt") {
  const config = Config.parse(JSON.parse(secret));
  const bytes = base64urlToBytes(config.keys[kid] ?? "");
  if (!bytes || bytes.length !== 32)
    throw new Error("bootstrap_ticket_key_unavailable");
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(bytes),
    "AES-GCM",
    false,
    [usage],
  );
}
async function canonicalHash(value: unknown): Promise<string> {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${canonical(object[name])}`)
      .join(",")}}`;
  };
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonical(value))),
    ),
  );
}
export async function bootstrapSpecHash(
  spec: NodeBootstrapInput["spec"],
): Promise<string> {
  return canonicalHash(spec);
}
export async function bootstrapPlatformHash(
  platform: NodePlatformConfiguration,
): Promise<string> {
  return canonicalHash(platform);
}
async function verifyPlatformBinding(input: NodeBootstrapInput): Promise<void> {
  if (
    input.platform &&
    (!input.spec.platform || input.spec.role !== "controlplane")
  )
    throw new Error("bootstrap_platform_binding_invalid");
  if (
    input.spec.platform &&
    (!input.platform ||
      input.platform.region_id !== input.spec.region_id ||
      (await bootstrapPlatformHash(input.platform)) !==
        input.spec.platform.configuration_sha256)
  )
    throw new Error("bootstrap_platform_binding_invalid");
}
export async function sealBootstrapInput(
  secret: string,
  input: NodeBootstrapInput,
  revision = 1,
): Promise<BootstrapTicket> {
  const parsed = NodeBootstrapInput.parse(input);
  await verifyPlatformBinding(parsed);
  if (
    parsed.rescue.ssh_host_fingerprint !== parsed.spec.rescue_host_fingerprint
  )
    throw new Error("bootstrap_rescue_host_binding_invalid");
  if ((await bootstrapSpecHash(parsed.spec)) !== parsed.input_hash)
    throw new Error("bootstrap_input_hash_mismatch");
  const kid = Config.parse(JSON.parse(secret)).active;
  const ticket = {
    operation_id: parsed.spec.operation_id,
    input_hash: parsed.input_hash,
    revision,
    kid,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(ticket), tagLength: 128 },
    await key(secret, kid, "encrypt"),
    encoder.encode(JSON.stringify(parsed)),
  );
  return {
    ...ticket,
    iv: bytesToBase64url(iv),
    ciphertext: bytesToBase64url(new Uint8Array(encrypted)),
  };
}
export async function openBootstrapInput(
  secret: string,
  ticket: BootstrapTicket,
): Promise<NodeBootstrapInput> {
  const iv = base64urlToBytes(ticket.iv),
    ciphertext = base64urlToBytes(ticket.ciphertext);
  if (
    !iv ||
    iv.length !== 12 ||
    !ciphertext ||
    ciphertext.length < 16 ||
    ciphertext.length > 768 * 1024
  )
    throw new Error("bootstrap_ticket_invalid");
  const bytes = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(iv),
      additionalData: aad(ticket),
      tagLength: 128,
    },
    await key(secret, ticket.kid, "decrypt"),
    Uint8Array.from(ciphertext),
  );
  const input = NodeBootstrapInput.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ),
  );
  await verifyPlatformBinding(input);
  if (
    input.rescue.ssh_host_fingerprint !== input.spec.rescue_host_fingerprint ||
    input.spec.operation_id !== ticket.operation_id ||
    input.input_hash !== ticket.input_hash ||
    (await bootstrapSpecHash(input.spec)) !== ticket.input_hash
  )
    throw new Error("bootstrap_ticket_identity_mismatch");
  return input;
}
