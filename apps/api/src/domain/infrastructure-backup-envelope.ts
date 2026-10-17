// SPDX-License-Identifier: Apache-2.0
import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  type DecipherGCM,
} from "node:crypto";

/**
 * The PGCFINF1 envelope: eight-byte magic, four-byte big-endian AAD length, the UTF-8 JSON AAD,
 * a 12-byte nonce, the AES-256-GCM ciphertext and its 16-byte tag. The AAD binds the run, the
 * artifact, its source, the key version and the plaintext hash and length, so the plaintext is
 * read twice: once to measure it, once to encrypt it.
 */
const MAGIC = Buffer.from("PGCFINF1"),
  MAX_AAD = 16 * 1024,
  TAG_BYTES = 16;
export const INFRASTRUCTURE_BACKUP_SOURCE_MAX_BYTES = 1024 * 1024 * 1024;
export interface EnvelopeIdentity {
  run_id: string;
  id: string;
  kind: string;
  day: string;
  region_id: string;
  source_id: string;
  kid: string;
  plaintext_sha256: string;
  plaintext_bytes: number;
}
export interface EnvelopeReceipt {
  plaintext_sha256: string;
  plaintext_bytes: number;
  encrypted_sha256: string;
  encrypted_bytes: number;
}
function fail(code: string): never {
  throw new Error(`infrastructure_backup_${code}`);
}
export function envelopeKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value)
    fail("key_invalid");
  return key;
}
function aad(identity: EnvelopeIdentity): Buffer {
  // The node and cluster fields named the etcd sources of earlier runs. They stay null so that the
  // AAD keeps the layout every existing archive was written with.
  return Buffer.from(
    JSON.stringify({
      version: 1,
      run_id: identity.run_id,
      artifact_id: identity.id,
      kind: identity.kind,
      day: identity.day,
      region_id: identity.region_id,
      source_id: identity.source_id,
      node_id: null,
      node_uid: null,
      cluster_uid: null,
      material_revision: null,
      kid: identity.kid,
      plaintext_sha256: identity.plaintext_sha256,
      plaintext_bytes: identity.plaintext_bytes,
    }),
  );
}

/** Hashes and counts a source without keeping it; more than `limit` bytes or none fails. */
export async function measureSource(
  source: ReadableStream<Uint8Array>,
  limit = INFRASTRUCTURE_BACKUP_SOURCE_MAX_BYTES,
): Promise<{ plaintext_sha256: string; plaintext_bytes: number }> {
  const checksum = createHash("sha256"),
    reader = source.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) fail("source_limit");
      checksum.update(next.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (bytes === 0) fail("source_empty");
  return { plaintext_sha256: checksum.digest("hex"), plaintext_bytes: bytes };
}

/**
 * Encrypts a second read of the measured source. The stream errors at its end, before it closes,
 * when that read differs from the measured one, so an uploader never completes such an object.
 * `receipt` resolves once the stream has closed.
 */
export function encryptSource(
  source: ReadableStream<Uint8Array>,
  keyValue: string,
  identity: EnvelopeIdentity,
): { stream: ReadableStream<Uint8Array>; receipt: Promise<EnvelopeReceipt> } {
  const authenticated = aad(identity),
    nonce = crypto.getRandomValues(new Uint8Array(12)),
    prefix = Buffer.alloc(12);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(authenticated.length, 8);
  const header = Buffer.concat([prefix, authenticated, nonce]),
    cipher = createCipheriv("aes-256-gcm", envelopeKey(keyValue), nonce),
    plaintext = createHash("sha256"),
    encrypted = createHash("sha256");
  cipher.setAAD(authenticated);
  let plaintextBytes = 0,
    encryptedBytes = 0,
    settle: (value: EnvelopeReceipt) => void = () => {},
    reject: (error: unknown) => void = () => {};
  const receipt = new Promise<EnvelopeReceipt>((resolve, refuse) => {
    settle = resolve;
    reject = refuse;
  });
  receipt.catch(() => {});
  const emit = (
    controller: TransformStreamDefaultController<Uint8Array>,
    bytes: Uint8Array,
  ) => {
    if (!bytes.byteLength) return;
    encryptedBytes += bytes.byteLength;
    encrypted.update(bytes);
    controller.enqueue(bytes);
  };
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        emit(controller, header);
      },
      transform(chunk, controller) {
        plaintextBytes += chunk.byteLength;
        if (plaintextBytes > identity.plaintext_bytes) {
          const error = new Error("infrastructure_backup_source_changed");
          reject(error);
          throw error;
        }
        plaintext.update(chunk);
        emit(controller, cipher.update(chunk));
      },
      flush(controller) {
        emit(controller, cipher.final());
        if (
          plaintextBytes !== identity.plaintext_bytes ||
          plaintext.digest("hex") !== identity.plaintext_sha256
        ) {
          const error = new Error("infrastructure_backup_source_changed");
          reject(error);
          throw error;
        }
        emit(controller, cipher.getAuthTag());
        settle({
          plaintext_sha256: identity.plaintext_sha256,
          plaintext_bytes: plaintextBytes,
          encrypted_sha256: encrypted.digest("hex"),
          encrypted_bytes: encryptedBytes,
        });
      },
    }),
  );
  return { stream, receipt };
}

/**
 * Authenticates a complete read of an envelope and hashes its plaintext, which it never emits.
 * The runtime's GCM decipher takes the tag before the ciphertext, so the caller reads the last 16
 * bytes first; the complete read must end with exactly them.
 */
export async function verifyEnvelope(
  source: ReadableStream<Uint8Array>,
  keyValue: string,
  expected: EnvelopeIdentity & EnvelopeReceipt,
  tag: Uint8Array,
): Promise<EnvelopeReceipt> {
  const key = envelopeKey(keyValue),
    expectedAAD = aad(expected),
    encryptedHash = createHash("sha256"),
    plaintextHash = createHash("sha256"),
    reader = source.getReader();
  let encryptedBytes = 0,
    plaintextBytes = 0,
    header = Buffer.alloc(0),
    headerLength = 12,
    tail = Buffer.alloc(0),
    decipher: DecipherGCM | undefined;
  const plain = (bytes: Buffer) => {
    plaintextBytes += bytes.length;
    if (plaintextBytes > expected.plaintext_bytes) fail("readback_failed");
    plaintextHash.update(bytes);
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const incoming = next.value;
      encryptedBytes += incoming.byteLength;
      encryptedHash.update(incoming);
      if (encryptedBytes > expected.encrypted_bytes) fail("readback_failed");
      let chunk = Buffer.from(
        incoming.buffer,
        incoming.byteOffset,
        incoming.byteLength,
      );
      while (!decipher && chunk.length) {
        const take = Math.min(headerLength - header.length, chunk.length);
        header = Buffer.concat([header, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
        if (header.length !== headerLength) continue;
        if (headerLength === 12) {
          if (!header.subarray(0, 8).equals(MAGIC)) fail("readback_failed");
          const length = header.readUInt32BE(8);
          if (length < 2 || length > MAX_AAD) fail("readback_failed");
          headerLength = 12 + length + 12;
        } else {
          const authenticated = header.subarray(12, -12);
          if (!authenticated.equals(expectedAAD)) fail("identity_mismatch");
          if (tag.byteLength !== TAG_BYTES) fail("readback_failed");
          decipher = createDecipheriv("aes-256-gcm", key, header.subarray(-12));
          decipher.setAAD(authenticated);
          decipher.setAuthTag(tag);
        }
      }
      if (!decipher || chunk.length === 0) continue;
      // The last 16 bytes are the tag, so they are held back until the next chunk or the end.
      const pending = Buffer.concat([tail, chunk]);
      if (pending.length > TAG_BYTES)
        plain(decipher.update(pending.subarray(0, -TAG_BYTES)));
      tail = Buffer.from(pending.subarray(-TAG_BYTES));
    }
    if (
      !decipher ||
      !tail.equals(tag) ||
      encryptedBytes !== expected.encrypted_bytes
    )
      fail("readback_failed");
    const encryptedSHA = encryptedHash.digest("hex");
    if (encryptedSHA !== expected.encrypted_sha256) fail("readback_failed");
    plain(decipher.final());
    const plaintextSHA = plaintextHash.digest("hex");
    if (
      plaintextSHA !== expected.plaintext_sha256 ||
      plaintextBytes !== expected.plaintext_bytes
    )
      fail("readback_failed");
    return {
      plaintext_sha256: plaintextSHA,
      plaintext_bytes: plaintextBytes,
      encrypted_sha256: encryptedSHA,
      encrypted_bytes: encryptedBytes,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "infrastructure_backup_identity_mismatch"
    )
      throw error;
    fail("readback_failed");
  } finally {
    key.fill(0);
    void reader.cancel().catch(() => {});
  }
}
