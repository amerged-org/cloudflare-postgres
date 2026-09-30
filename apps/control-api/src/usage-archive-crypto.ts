// SPDX-License-Identifier: Apache-2.0
const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_RECORD_BYTES = 128 * 1024;
export interface ArchiveIdentity {
  regionId: string;
  sourceId: string;
  sourceEpoch: number;
}
export interface ArchiveChunk {
  bytes: number;
  sha256: string;
}
export interface ArchiveFile {
  kind: "journal" | "manifest" | "accepted";
  id: string;
  bytes: number;
  sha256: string;
  chunks: ArchiveChunk[];
}
export interface ArchiveDescriptor {
  version: 1;
  identity: ArchiveIdentity;
  sessionId: string;
  capturedAt: string;
  files: ArchiveFile[];
}
export interface ArchiveScope extends ArchiveIdentity {
  descriptorId: string;
}
export interface Prepared {
  descriptor: ArchiveDescriptor;
  dek: Uint8Array<ArrayBuffer>;
  keyId: string;
}
export interface ArchiveReceipt {
  version: 1;
  descriptorId: string;
  descriptorSha256: string;
  identity: ArchiveIdentity;
  sessionId: string;
  capturedAt: string;
  files: Omit<ArchiveFile, "chunks">[];
  chunkCount: number;
  keyId: string;
  completedAt: string;
}
const invalid = () => new Error("usage_archive_invalid");
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const serialized = (value: unknown) => JSON.stringify(canonical(value));
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
function fields(
  value: unknown,
  names: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}
function integer(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= max
  );
}
export function validIdentity(value: unknown): value is ArchiveIdentity {
  return (
    fields(value, ["regionId", "sourceId", "sourceEpoch"]) &&
    typeof value.regionId === "string" &&
    uuid.test(value.regionId) &&
    typeof value.sourceId === "string" &&
    uuid.test(value.sourceId) &&
    integer(value.sourceEpoch, Number.MAX_SAFE_INTEGER)
  );
}
export function validInstant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  return (
    Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value
  );
}
export function validateDescriptor(value: unknown): ArchiveDescriptor | null {
  if (
    !fields(value, [
      "version",
      "identity",
      "sessionId",
      "capturedAt",
      "files",
    ]) ||
    value.version !== 1 ||
    !validIdentity(value.identity) ||
    typeof value.sessionId !== "string" ||
    !uuid.test(value.sessionId) ||
    !validInstant(value.capturedAt) ||
    !Array.isArray(value.files) ||
    value.files.length < 2 ||
    value.files.length > 66
  )
    return null;
  let total = 0,
    count = 0;
  const ids = new Set<string>();
  for (let index = 0; index < value.files.length; index++) {
    const file = value.files[index];
    if (
      !fields(file, ["kind", "id", "bytes", "sha256", "chunks"]) ||
      typeof file.id !== "string" ||
      typeof file.sha256 !== "string" ||
      !hashPattern.test(file.sha256) ||
      !Array.isArray(file.chunks) ||
      !file.chunks.length
    )
      return null;
    const max =
      index === 0
        ? 64 * 1024 * 1024
        : index === 1
          ? 16 * 1024
          : 8 * 1024 * 1024;
    if (
      !integer(file.bytes, max) ||
      (index === 0
        ? file.kind !== "journal" || file.id !== "journal"
        : index === 1
          ? file.kind !== "manifest" || file.id !== "manifest"
          : file.kind !== "accepted" || file.id !== file.sha256) ||
      ids.has(file.id)
    )
      return null;
    ids.add(file.id);
    let bytes = 0;
    for (const chunk of file.chunks) {
      if (
        !fields(chunk, ["bytes", "sha256"]) ||
        !integer(chunk.bytes, MAX_CHUNK_BYTES) ||
        typeof chunk.sha256 !== "string" ||
        !hashPattern.test(chunk.sha256)
      )
        return null;
      bytes += chunk.bytes;
      count++;
      if (count > 256) return null;
    }
    if (bytes !== file.bytes) return null;
    total += bytes;
    if (total > 256 * 1024 * 1024) return null;
  }
  return value as unknown as ArchiveDescriptor;
}
export async function descriptorIdentity(
  descriptor: ArchiveDescriptor,
): Promise<{ descriptorId: string; descriptorSha256: string }> {
  const raw = serialized(descriptor);
  return {
    descriptorId: await hashBytes(
      encoder.encode(
        "cloudflare-postgres/usage-archive/descriptor/v1\x00" + raw,
      ),
    ),
    descriptorSha256: await hashBytes(encoder.encode(raw)),
  };
}
function b64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: unknown, max: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== "string" ||
    value.length > max * 2 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw invalid();
  const result = Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (result.byteLength > max || b64(result) !== value) throw invalid();
  return result;
}
function ring(encoded: string): {
  active: string;
  keys: Record<string, string>;
} {
  const value: unknown = JSON.parse(encoded);
  if (
    !fields(value, ["active", "keys"]) ||
    typeof value.active !== "string" ||
    !value.keys ||
    typeof value.keys !== "object" ||
    Array.isArray(value.keys)
  )
    throw invalid();
  const keys = value.keys as Record<string, string>;
  if (
    !Object.hasOwn(keys, value.active) ||
    Object.keys(keys).length < 1 ||
    Object.keys(keys).length > 8 ||
    Object.entries(keys).some(
      ([id, key]) =>
        !/^[A-Za-z0-9_.-]{1,32}$/.test(id) || decode(key, 32).length !== 32,
    )
  )
    throw invalid();
  return { active: value.active, keys };
}
async function aes(bytes: Uint8Array, usage: "encrypt" | "decrypt") {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    "AES-GCM",
    false,
    [usage],
  );
}
const recordAAD = (scope: ArchiveScope, kind: string) =>
  encoder.encode(
    serialized({
      domain: "cloudflare-postgres/usage-archive-record/v1",
      scope,
      kind,
    }),
  );
export async function encryptRecord(
  encoded: string,
  scope: ArchiveScope,
  kind: string,
  value: unknown,
  selected?: string,
): Promise<string> {
  const keys = ring(encoded),
    keyId = selected ?? keys.active;
  if (!Object.hasOwn(keys.keys, keyId)) throw invalid();
  const raw = encoder.encode(serialized(value));
  if (raw.length > MAX_RECORD_BYTES) throw invalid();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: recordAAD(scope, kind) },
    await aes(decode(keys.keys[keyId], 32), "encrypt"),
    raw,
  );
  return JSON.stringify({
    version: 1,
    keyId,
    iv: b64(iv),
    ciphertext: b64(new Uint8Array(ciphertext)),
  });
}
export async function decryptRecord(
  encoded: string,
  scope: ArchiveScope,
  kind: string,
  encrypted: string,
): Promise<{ value: unknown; keyId: string }> {
  if (encrypted.length > MAX_RECORD_BYTES * 2) throw invalid();
  const keys = ring(encoded),
    value: unknown = JSON.parse(encrypted);
  if (
    !fields(value, ["version", "keyId", "iv", "ciphertext"]) ||
    value.version !== 1 ||
    typeof value.keyId !== "string" ||
    !Object.hasOwn(keys.keys, value.keyId)
  )
    throw invalid();
  const iv = decode(value.iv, 12);
  if (iv.length !== 12) throw invalid();
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: recordAAD(scope, kind) },
    await aes(decode(keys.keys[value.keyId], 32), "decrypt"),
    decode(value.ciphertext, MAX_RECORD_BYTES + 16),
  );
  return {
    value: JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw),
    ),
    keyId: value.keyId,
  };
}
export async function encryptPrepared(
  encoded: string,
  scope: ArchiveScope,
  descriptor: ArchiveDescriptor,
): Promise<string> {
  return encryptRecord(encoded, scope, "prepared", {
    version: 1,
    descriptor,
    dek: b64(crypto.getRandomValues(new Uint8Array(32))),
  });
}
export async function decryptPrepared(
  encoded: string,
  scope: ArchiveScope,
  encrypted: string,
): Promise<Prepared> {
  const opened = await decryptRecord(encoded, scope, "prepared", encrypted);
  if (
    !fields(opened.value, ["version", "descriptor", "dek"]) ||
    opened.value.version !== 1
  )
    throw invalid();
  const descriptor = validateDescriptor(opened.value.descriptor);
  if (
    !descriptor ||
    serialized(descriptor.identity) !==
      serialized({
        regionId: scope.regionId,
        sourceId: scope.sourceId,
        sourceEpoch: scope.sourceEpoch,
      }) ||
    (await descriptorIdentity(descriptor)).descriptorId !== scope.descriptorId
  )
    throw invalid();
  const dek = decode(opened.value.dek, 32);
  if (dek.length !== 32) throw invalid();
  return { descriptor, dek, keyId: opened.keyId };
}
export function flattened(descriptor: ArchiveDescriptor): Array<{
  file: ArchiveFile;
  chunk: ArchiveChunk;
  fileIndex: number;
  chunkIndex: number;
}> {
  return descriptor.files.flatMap((file, fileIndex) =>
    file.chunks.map((chunk, chunkIndex) => ({
      file,
      chunk,
      fileIndex,
      chunkIndex,
    })),
  );
}
const chunkAAD = (prepared: Prepared, id: string, ordinal: number) => {
  const plan = flattened(prepared.descriptor)[ordinal];
  if (!plan) throw invalid();
  return encoder.encode(
    serialized({
      domain: "cloudflare-postgres/usage-archive-chunk/v1",
      identity: prepared.descriptor.identity,
      sessionId: prepared.descriptor.sessionId,
      descriptorId: id,
      ordinal,
      fileIndex: plan.fileIndex,
      chunkIndex: plan.chunkIndex,
      ...plan.chunk,
    }),
  );
};
export async function encryptChunk(
  prepared: Prepared,
  id: string,
  ordinal: number,
  plain: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const plan = flattened(prepared.descriptor)[ordinal];
  if (
    !plan ||
    plain.length !== plan.chunk.bytes ||
    (await hashBytes(plain)) !== plan.chunk.sha256
  )
    throw invalid();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: chunkAAD(prepared, id, ordinal) },
    await aes(prepared.dek, "encrypt"),
    new Uint8Array(plain),
  );
  const result = new Uint8Array(16 + cipher.byteLength);
  result.set([80, 71, 67, 49]);
  result.set(iv, 4);
  result.set(new Uint8Array(cipher), 16);
  return result;
}
export async function decryptChunk(
  prepared: Prepared,
  id: string,
  ordinal: number,
  cipher: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const plan = flattened(prepared.descriptor)[ordinal];
  if (
    !plan ||
    cipher.length !== plan.chunk.bytes + 32 ||
    cipher[0] !== 80 ||
    cipher[1] !== 71 ||
    cipher[2] !== 67 ||
    cipher[3] !== 49
  )
    throw invalid();
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(cipher.subarray(4, 16)),
        additionalData: chunkAAD(prepared, id, ordinal),
      },
      await aes(prepared.dek, "decrypt"),
      new Uint8Array(cipher.subarray(16)),
    ),
  );
  if (
    plain.length !== plan.chunk.bytes ||
    (await hashBytes(plain)) !== plan.chunk.sha256
  )
    throw invalid();
  return plain;
}
export function validateReceipt(
  value: unknown,
  descriptor: ArchiveDescriptor,
  id: string,
  sha: string,
  keyId: string,
): value is ArchiveReceipt {
  return (
    fields(value, [
      "version",
      "descriptorId",
      "descriptorSha256",
      "identity",
      "sessionId",
      "capturedAt",
      "files",
      "chunkCount",
      "keyId",
      "completedAt",
    ]) &&
    value.version === 1 &&
    value.descriptorId === id &&
    value.descriptorSha256 === sha &&
    serialized(value.identity) === serialized(descriptor.identity) &&
    value.sessionId === descriptor.sessionId &&
    value.capturedAt === descriptor.capturedAt &&
    serialized(value.files) ===
      serialized(
        descriptor.files.map(({ kind, id, bytes, sha256 }) => ({
          kind,
          id,
          bytes,
          sha256,
        })),
      ) &&
    value.chunkCount === flattened(descriptor).length &&
    value.keyId === keyId &&
    validInstant(value.completedAt)
  );
}
