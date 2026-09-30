// SPDX-License-Identifier: Apache-2.0
import {
  bearer,
  body,
  error,
  fields,
  installation,
  json,
  sha256,
  uuid,
} from "./accounting";
import {
  MAX_CHUNK_BYTES,
  MAX_RECORD_BYTES,
  decryptChunk,
  decryptPrepared,
  decryptRecord,
  descriptorIdentity,
  encryptChunk,
  encryptPrepared,
  encryptRecord,
  flattened,
  hashBytes,
  serialized,
  validateDescriptor,
  validateReceipt,
  type ArchiveDescriptor,
  type ArchiveIdentity,
  type ArchiveReceipt,
  type ArchiveScope,
  type Prepared,
} from "./usage-archive-crypto";

export type UsageArchiveEnv = Cloudflare.Env & {
  USAGE_ARCHIVE_KEYS?: string;
  USAGE_ARCHIVES?: R2Bucket;
};
interface Meter extends ArchiveIdentity {
  id: string;
  tokenHash: string;
}
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const refuse = (status: number, code: string): never => {
  throw new Refusal(status, code);
};
const hash = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const sourcePrefix = (scope: ArchiveIdentity) =>
  `usage-archives/v1/${scope.regionId}/${scope.sourceId}/${scope.sourceEpoch}`;
const artifactPrefix = (scope: ArchiveScope) =>
  `${sourcePrefix(scope)}/${scope.descriptorId}`;
const receiptKey = (scope: ArchiveScope) =>
  `${sourcePrefix(scope)}/receipts/${scope.descriptorId}`;
const scopeIdentity = (scope: ArchiveScope): ArchiveIdentity => ({
  regionId: scope.regionId,
  sourceId: scope.sourceId,
  sourceEpoch: scope.sourceEpoch,
});
async function meter(
  request: Request,
  env: UsageArchiveEnv,
  identity?: ArchiveIdentity,
): Promise<Meter> {
  const token = bearer(request);
  if (!token?.startsWith("cpmtr_")) return refuse(401, "unauthorized");
  const tokenHash = await sha256(token);
  const row = await env.DB.withSession("first-primary")
    .prepare(
      `SELECT t.id,t.region_id AS regionId,t.source_id AS sourceId,t.source_epoch AS sourceEpoch
    FROM usage_meter_tokens t JOIN regions r ON r.id=t.region_id JOIN usage_sources s
    ON s.source_id=t.source_id AND s.region_id=t.region_id AND s.source_epoch=t.source_epoch
    WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.scopes='usage:write' AND r.status<>'disabled'`,
    )
    .bind(tokenHash)
    .first<Omit<Meter, "tokenHash">>();
  if (!row) return refuse(401, "unauthorized");
  if (
    identity &&
    serialized({
      regionId: row.regionId,
      sourceId: row.sourceId,
      sourceEpoch: row.sourceEpoch,
    }) !== serialized(identity)
  )
    return refuse(404, "not_found");
  return { ...row, tokenHash };
}
async function currentMeter(
  request: Request,
  env: UsageArchiveEnv,
  actor: Meter,
): Promise<void> {
  try {
    const current = await meter(request, env, {
      regionId: actor.regionId,
      sourceId: actor.sourceId,
      sourceEpoch: actor.sourceEpoch,
    });
    if (current.id !== actor.id || current.tokenHash !== actor.tokenHash)
      return refuse(409, "usage_archive_authority_changed");
  } catch {
    return refuse(409, "usage_archive_authority_changed");
  }
}
async function recoveryAuthority(
  request: Request,
  env: UsageArchiveEnv,
  regionId: string,
): Promise<void> {
  if (!(await installation(request, env))) return refuse(401, "unauthorized");
  if (
    !(await env.DB.withSession("first-primary")
      .prepare("SELECT 1 FROM regions WHERE id=?")
      .bind(regionId)
      .first())
  )
    return refuse(404, "not_found");
}
function configured(env: UsageArchiveEnv): { bucket: R2Bucket; keys: string } {
  if (!env.USAGE_ARCHIVES || !env.USAGE_ARCHIVE_KEYS)
    return refuse(503, "usage_archive_unconfigured");
  return { bucket: env.USAGE_ARCHIVES, keys: env.USAGE_ARCHIVE_KEYS };
}
async function objectBytes(
  bucket: R2Bucket,
  key: string,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size < 1 || object.size > max)
    return refuse(409, "usage_archive_conflict");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size)
    return refuse(409, "usage_archive_conflict");
  return bytes;
}
async function recordText(
  bucket: R2Bucket,
  key: string,
): Promise<string | null> {
  const bytes = await objectBytes(bucket, key, MAX_RECORD_BYTES * 2);
  return bytes
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    : null;
}
async function prepared(
  env: UsageArchiveEnv,
  scope: ArchiveScope,
): Promise<Prepared> {
  const { bucket, keys } = configured(env),
    text = await recordText(bucket, `${artifactPrefix(scope)}/prepared`);
  if (text === null) return refuse(404, "not_found");
  return decryptPrepared(keys, scope, text);
}
async function receipt(
  env: UsageArchiveEnv,
  scope: ArchiveScope,
  plan: Prepared,
): Promise<{ receipt: ArchiveReceipt; receiptSha256: string } | null> {
  const { bucket, keys } = configured(env),
    text = await recordText(bucket, receiptKey(scope));
  if (text === null) return null;
  const opened = await decryptRecord(keys, scope, "receipt", text),
    identity = await descriptorIdentity(plan.descriptor);
  if (
    !validateReceipt(
      opened.value,
      plan.descriptor,
      scope.descriptorId,
      identity.descriptorSha256,
      plan.keyId,
    )
  )
    return refuse(409, "usage_archive_conflict");
  return {
    receipt: opened.value,
    receiptSha256: await hashBytes(encoder.encode(serialized(opened.value))),
  };
}
async function immutablePut(
  bucket: R2Bucket,
  key: string,
  value: string | Uint8Array,
): Promise<void> {
  await bucket.put(key, value, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: "application/octet-stream",
      cacheControl: "no-store",
    },
  });
}
async function boundedBody(
  request: Request,
  expected: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !request.body ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/octet-stream" ||
    expected > MAX_CHUNK_BYTES
  )
    return refuse(400, "invalid_request");
  const supplied = request.headers.get("content-length");
  if (supplied !== null && Number(supplied) !== expected)
    return refuse(400, "invalid_request");
  const reader = request.body.getReader(),
    result = new Uint8Array(expected);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (request.signal.aborted || offset + next.value.length > expected)
        return refuse(400, "invalid_request");
      result.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== expected) return refuse(400, "invalid_request");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function prepare(
  request: Request,
  env: UsageArchiveEnv,
  regionId: string,
): Promise<Response> {
  const actor = await meter(request, env);
  if (actor.regionId !== regionId) return refuse(404, "not_found");
  const descriptor = validateDescriptor(await body(request, MAX_RECORD_BYTES));
  if (!descriptor) return refuse(400, "invalid_request");
  if (
    serialized(descriptor.identity) !==
    serialized(scopeIdentity({ ...actor, descriptorId: "" }))
  )
    return refuse(404, "not_found");
  const identity = await descriptorIdentity(descriptor),
    scope = { ...descriptor.identity, descriptorId: identity.descriptorId };
  const { bucket, keys } = configured(env);
  const key = `${artifactPrefix(scope)}/prepared`,
    before = await recordText(bucket, key);
  if (before === null) {
    const encrypted = await encryptPrepared(keys, scope, descriptor);
    await currentMeter(request, env, actor);
    await immutablePut(bucket, key, encrypted);
  }
  const stored = await prepared(env, scope);
  if (serialized(stored.descriptor) !== serialized(descriptor))
    return refuse(409, "usage_archive_conflict");
  await currentMeter(request, env, actor);
  return json(
    { ...identity, descriptor: stored.descriptor },
    before === null ? 201 : 200,
  );
}
async function putChunk(
  request: Request,
  env: UsageArchiveEnv,
  scope: ArchiveScope,
  ordinal: number,
): Promise<Response> {
  const actor = await meter(request, env, scopeIdentity(scope)),
    plan = await prepared(env, scope),
    entry = flattened(plan.descriptor)[ordinal];
  if (!entry) return refuse(400, "invalid_request");
  const plain = await boundedBody(request, entry.chunk.bytes);
  if ((await hashBytes(plain)) !== entry.chunk.sha256)
    return refuse(409, "usage_archive_chunk_conflict");
  const { bucket } = configured(env),
    key = `${artifactPrefix(scope)}/chunks/${ordinal}`,
    before = await objectBytes(bucket, key, MAX_CHUNK_BYTES + 32);
  if (before === null) {
    const encrypted = await encryptChunk(
      plan,
      scope.descriptorId,
      ordinal,
      plain,
    );
    await currentMeter(request, env, actor);
    await immutablePut(bucket, key, encrypted);
  }
  const stored = await objectBytes(bucket, key, MAX_CHUNK_BYTES + 32);
  if (!stored) return refuse(409, "usage_archive_incomplete");
  await decryptChunk(plan, scope.descriptorId, ordinal, stored);
  await currentMeter(request, env, actor);
  return json({
    descriptorId: scope.descriptorId,
    ordinal,
    bytes: entry.chunk.bytes,
    sha256: entry.chunk.sha256,
  });
}
function originalManifest(
  bytes: Uint8Array,
  descriptor: ArchiveDescriptor,
): boolean {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  return (
    fields(value, [
      "schemaVersion",
      "identity",
      "sha256",
      "bytes",
      "pendingFacts",
      "activationSupported",
    ]) &&
    value.schemaVersion === 2 &&
    serialized(value.identity) === serialized(descriptor.identity) &&
    value.sha256 === descriptor.files[0]!.sha256 &&
    value.bytes === descriptor.files[0]!.bytes &&
    typeof value.pendingFacts === "number" &&
    Number.isSafeInteger(value.pendingFacts) &&
    value.pendingFacts >= 0 &&
    value.activationSupported === false
  );
}
async function finalize(
  request: Request,
  env: UsageArchiveEnv,
  scope: ArchiveScope,
): Promise<Response> {
  const started = performance.now();
  const checkpoint = () => {
    const elapsed = performance.now() - started;
    if (
      request.signal.aborted ||
      !Number.isFinite(elapsed) ||
      elapsed < 0 ||
      elapsed > 240_000
    )
      return refuse(503, "usage_archive_deferred");
  };
  const actor = await meter(request, env, scopeIdentity(scope));
  if (!fields(await body(request), [])) return refuse(400, "invalid_request");
  const plan = await prepared(env, scope),
    existing = await receipt(env, scope, plan);
  checkpoint();
  if (existing) {
    await currentMeter(request, env, actor);
    checkpoint();
    return json(existing);
  }
  const { bucket, keys } = configured(env);
  let ordinal = 0;
  for (const file of plan.descriptor.files) {
    const digest = new crypto.DigestStream("SHA-256"),
      writer = digest.getWriter();
    void digest.digest.catch(() => {});
    const manifest =
      file.kind === "manifest" ? new Uint8Array(file.bytes) : null;
    let offset = 0;
    try {
      for (const chunk of file.chunks) {
        checkpoint();
        const ciphertext = await objectBytes(
          bucket,
          `${artifactPrefix(scope)}/chunks/${ordinal}`,
          chunk.bytes + 32,
        );
        checkpoint();
        if (!ciphertext) return refuse(409, "usage_archive_incomplete");
        const plain = await decryptChunk(
          plan,
          scope.descriptorId,
          ordinal,
          ciphertext,
        );
        checkpoint();
        await writer.write(plain);
        checkpoint();
        manifest?.set(plain, offset);
        offset += plain.length;
        ordinal++;
      }
      await writer.close();
      checkpoint();
      const observed = Array.from(new Uint8Array(await digest.digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (offset !== file.bytes || observed !== file.sha256)
        return refuse(409, "usage_archive_chunk_conflict");
      if (manifest && !originalManifest(manifest, plan.descriptor))
        return refuse(409, "usage_archive_manifest_conflict");
    } catch (failure) {
      await writer.abort().catch(() => {});
      throw failure;
    } finally {
      writer.releaseLock();
    }
  }
  const identity = await descriptorIdentity(plan.descriptor);
  const value: ArchiveReceipt = {
    version: 1,
    ...identity,
    identity: plan.descriptor.identity,
    sessionId: plan.descriptor.sessionId,
    capturedAt: plan.descriptor.capturedAt,
    files: plan.descriptor.files.map(({ kind, id, bytes, sha256 }) => ({
      kind,
      id,
      bytes,
      sha256,
    })),
    chunkCount: ordinal,
    keyId: plan.keyId,
    completedAt: new Date().toISOString(),
  };
  const encrypted = await encryptRecord(
    keys,
    scope,
    "receipt",
    value,
    plan.keyId,
  );
  await currentMeter(request, env, actor);
  checkpoint();
  await immutablePut(bucket, receiptKey(scope), encrypted);
  checkpoint();
  const stored = await receipt(env, scope, plan);
  if (!stored) return refuse(409, "usage_archive_incomplete");
  await currentMeter(request, env, actor);
  checkpoint();
  return json(stored);
}
async function verifiedReceipt(
  env: UsageArchiveEnv,
  scope: ArchiveScope,
  expected: string,
): Promise<{ plan: Prepared; receipt: ArchiveReceipt; receiptSha256: string }> {
  const plan = await prepared(env, scope),
    stored = await receipt(env, scope, plan);
  if (!stored) return refuse(404, "not_found");
  if (stored.receiptSha256 !== expected)
    return refuse(409, "usage_archive_receipt_conflict");
  return { plan, ...stored };
}
async function recover(
  request: Request,
  env: UsageArchiveEnv,
  scope: ArchiveScope,
): Promise<Response> {
  await recoveryAuthority(request, env, scope.regionId);
  const input = await body(request);
  if (
    !fields(input, ["expectedReceiptSha256"]) ||
    typeof input.expectedReceiptSha256 !== "string" ||
    !hash.test(input.expectedReceiptSha256)
  )
    return refuse(400, "invalid_request");
  const result = await verifiedReceipt(env, scope, input.expectedReceiptSha256);
  await recoveryAuthority(request, env, scope.regionId);
  return json({
    descriptor: result.plan.descriptor,
    receipt: result.receipt,
    receiptSha256: result.receiptSha256,
  });
}
async function getChunk(
  request: Request,
  env: UsageArchiveEnv,
  scope: ArchiveScope,
  ordinal: number,
  expected: string,
): Promise<Response> {
  await recoveryAuthority(request, env, scope.regionId);
  const { plan } = await verifiedReceipt(env, scope, expected),
    entry = flattened(plan.descriptor)[ordinal];
  if (!entry) return refuse(400, "invalid_request");
  const bytes = await objectBytes(
    configured(env).bucket,
    `${artifactPrefix(scope)}/chunks/${ordinal}`,
    entry.chunk.bytes + 32,
  );
  if (!bytes) return refuse(409, "usage_archive_incomplete");
  const plain = await decryptChunk(plan, scope.descriptorId, ordinal, bytes);
  await recoveryAuthority(request, env, scope.regionId);
  return new Response(plain, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(plain.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
async function list(
  request: Request,
  env: UsageArchiveEnv,
  identity: ArchiveIdentity,
): Promise<Response> {
  await recoveryAuthority(request, env, identity.regionId);
  const url = new URL(request.url),
    limit = Number(url.searchParams.get("limit") ?? "25"),
    cursor = url.searchParams.get("cursor");
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== null && (!cursor.length || cursor.length > 2048))
  )
    return refuse(400, "invalid_request");
  const { bucket } = configured(env),
    prefix = `${sourcePrefix(identity)}/receipts/`,
    page = await bucket.list({ prefix, limit, ...(cursor ? { cursor } : {}) });
  const receipts = [];
  for (const object of page.objects) {
    const descriptorId = object.key.slice(prefix.length);
    if (!hash.test(descriptorId)) return refuse(409, "usage_archive_conflict");
    const scope = { ...identity, descriptorId },
      plan = await prepared(env, scope),
      stored = await receipt(env, scope, plan);
    if (!stored) return refuse(409, "usage_archive_incomplete");
    receipts.push(stored);
  }
  await recoveryAuthority(request, env, identity.regionId);
  return json({ receipts, nextCursor: page.truncated ? page.cursor : null });
}
export async function usageArchiveRoutes(
  request: Request,
  env: UsageArchiveEnv,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = /^\/v1\/regions\/([^/]+)\/usage-archives(?:\/(.*))?$/.exec(
      url.pathname,
    );
  if (!match) return null;
  try {
    const regionId = match[1]!,
      parts = (match[2] ?? "").split("/");
    if (!uuid.test(regionId)) return refuse(400, "invalid_request");
    if (parts[0] === "prepare" && parts.length === 1) {
      if (url.searchParams.size) return refuse(400, "invalid_request");
      return request.method === "POST"
        ? await prepare(request, env, regionId)
        : refuse(405, "method_not_allowed");
    }
    if (
      parts.length < 2 ||
      !uuid.test(parts[0]!) ||
      !/^[1-9][0-9]{0,15}$/.test(parts[1]!)
    )
      return refuse(400, "invalid_request");
    const sourceEpoch = Number(parts[1]);
    if (!Number.isSafeInteger(sourceEpoch))
      return refuse(400, "invalid_request");
    const identity = { regionId, sourceId: parts[0]!, sourceEpoch };
    if (parts.length === 2) {
      if (
        Array.from(url.searchParams.keys()).some(
          (key) => !["limit", "cursor"].includes(key),
        )
      )
        return refuse(400, "invalid_request");
      return request.method === "GET"
        ? await list(request, env, identity)
        : refuse(405, "method_not_allowed");
    }
    if (!hash.test(parts[2]!)) return refuse(400, "invalid_request");
    const scope = { ...identity, descriptorId: parts[2]! };
    if (parts.length === 4 && ["finalize", "recovery"].includes(parts[3]!)) {
      if (url.searchParams.size) return refuse(400, "invalid_request");
      if (request.method !== "POST") return refuse(405, "method_not_allowed");
      return parts[3] === "finalize"
        ? await finalize(request, env, scope)
        : await recover(request, env, scope);
    }
    if (
      parts.length === 5 &&
      parts[3] === "chunks" &&
      /^(?:0|[1-9][0-9]{0,2})$/.test(parts[4]!)
    ) {
      const ordinal = Number(parts[4]);
      if (ordinal > 255) return refuse(400, "invalid_request");
      if (request.method === "PUT" && !url.searchParams.size)
        return await putChunk(request, env, scope, ordinal);
      if (
        request.method === "GET" &&
        url.searchParams.size === 1 &&
        url.searchParams.has("receiptSha256") &&
        hash.test(url.searchParams.get("receiptSha256")!)
      )
        return await getChunk(
          request,
          env,
          scope,
          ordinal,
          url.searchParams.get("receiptSha256")!,
        );
      return refuse(405, "method_not_allowed");
    }
    return refuse(404, "not_found");
  } catch (failure) {
    return failure instanceof Refusal
      ? error(failure.status, failure.code)
      : error(503, "usage_archive_unavailable");
  }
}
