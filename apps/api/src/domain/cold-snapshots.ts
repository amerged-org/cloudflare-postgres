// SPDX-License-Identifier: Apache-2.0
/** Source-declared clean-stop snapshots. Only signed node API requests can reach this R2 namespace. */
import {
  COLD_SNAPSHOT_CHUNK_BYTES,
  COLD_SNAPSHOT_CHUNKS_MAX,
  COLD_SNAPSHOT_MANIFEST_MAX_BYTES,
  ColdSnapshotManifest,
  ColdSnapshotSha256,
  OperationId,
  ProvenSleepRecord,
  bytesToHex,
  coldSnapshotPrefix,
} from "@pgcf/contracts";
import { ApiError } from "../api-error.ts";
import type { Env } from "../env.ts";
import type { NodeCaller } from "./node-auth.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { hintNode } from "./node-hints.ts";

export interface SnapshotRow {
  operation: string;
  kind: string;
  database_id: string;
  project_id: string;
  region_id: string;
  phase: string;
  source_node_id: string;
  source_generation: number;
  source_storage_generation: number;
  proven_sleep_json: string;
  verification_node_id: string | null;
  snapshot_prefix: string;
  snapshot_manifest_sha256: string | null;
  snapshot_manifest_bytes: number | null;
  snapshot_total_bytes: number | null;
  snapshot_file_count: number | null;
  snapshot_chunk_count: number | null;
  snapshot_manifest_declared_at: string | null;
  snapshot_sealed_at: string | null;
  snapshot_seal_checked_chunks: number;
  cleanup_fenced_at: string | null;
  snapshot_payload_retired_at: string | null;
}
interface ChunkRow {
  operation: string;
  chunk_index: number;
  size_bytes: number;
  sha256: string;
  state: string;
  r2_version: string | null;
}
const refused = () => new ApiError("not_found", "Cold snapshot is unavailable");
const conflict = (message: string) =>
  new ApiError("conflict", message, { reason: "not_ready" });
const invalid = () =>
  new ApiError("invalid_request", "Invalid cold snapshot payload");
const iso = () => new Date().toISOString();
const snapshotSelect =
  "SELECT c.* FROM database_cold_storage c WHERE c.operation=? AND c.kind='archive'";
const sourceAuthority = `EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
  JOIN nodes n ON n.id=c.source_node_id WHERE d.id=c.database_id AND d.storage_operation_id=c.operation AND d.storage_residency='archiving'
    AND d.node_id=c.source_node_id AND d.generation=c.source_generation AND d.storage_generation=c.source_storage_generation
    AND d.desired_state='suspended' AND d.observed_state='provisioning' AND d.observed_power='hibernated' AND d.observed_generation=d.generation
    AND d.proven_sleep_json=c.proven_sleep_json AND d.deleted_at IS NULL
    AND n.id=? AND n.node_uid=? AND n.region_id=c.region_id AND n.lost_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id)
    AND EXISTS(SELECT 1 FROM lifecycle_orders o WHERE o.operation=c.operation AND o.node_id=c.source_node_id AND o.type='move' AND o.result_status='done' AND o.closed_at IS NULL))`;
const writable = `c.phase='capturing' AND c.capture_dispatched_at IS NOT NULL AND c.cleanup_fenced_at IS NULL AND c.snapshot_payload_retired_at IS NULL`;

function validateIdentity(row: SnapshotRow): void {
  if (
    row.snapshot_prefix !==
    coldSnapshotPrefix(
      row.region_id,
      row.database_id,
      row.source_storage_generation,
      row.operation,
    )
  )
    throw refused();
}
async function writeRow(
  env: Env,
  caller: NodeCaller,
  operation: string,
  allowSealed = false,
): Promise<SnapshotRow> {
  OperationId.parse(operation);
  if (caller.fenced) throw refused();
  const row = await env.DB.prepare(
    `${snapshotSelect} AND c.region_id=? AND (${allowSealed ? "c.phase IN('capturing','verifying')" : "c.phase='capturing'"})
    AND c.cleanup_fenced_at IS NULL AND c.snapshot_payload_retired_at IS NULL AND ${sourceAuthority}`,
  )
    .bind(operation, caller.region_id, caller.id, caller.uid)
    .first<SnapshotRow>();
  if (!row) throw refused();
  validateIdentity(row);
  return row;
}
async function readerRow(
  env: Env,
  caller: NodeCaller,
  operation: string,
): Promise<SnapshotRow> {
  OperationId.parse(operation);
  if (caller.fenced) throw refused();
  const row = await env.DB.prepare(
    `${snapshotSelect} AND c.region_id=? AND c.snapshot_sealed_at IS NOT NULL
    AND c.cleanup_fenced_at IS NULL AND c.snapshot_payload_retired_at IS NULL
    AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=? AND n.node_uid=? AND n.region_id=c.region_id AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM node_losses l WHERE l.node_id=n.id))
    AND EXISTS(SELECT 1 FROM databases d JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL WHERE d.id=c.database_id AND d.deleted_at IS NULL
      AND ((c.phase='verifying' AND c.verification_node_id=? AND d.storage_operation_id=c.operation)
        OR EXISTS(SELECT 1 FROM database_cold_storage r WHERE r.source_operation=c.operation AND r.kind='rehydrate' AND r.phase IN('restoring','activating') AND r.target_node_id=? AND d.storage_operation_id=r.operation)))`,
  )
    .bind(
      operation,
      caller.region_id,
      caller.id,
      caller.uid,
      caller.id,
      caller.id,
    )
    .first<SnapshotRow>();
  if (!row) throw refused();
  validateIdentity(row);
  return row;
}
export const coldSnapshotChunkKey = (prefix: string, index: number) => {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= COLD_SNAPSHOT_CHUNKS_MAX
  )
    throw invalid();
  return `${prefix}chunks/${index.toString().padStart(8, "0")}`;
};
const digest = async (bytes: Uint8Array) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
    ),
  );
function matches(
  object: R2Object | null,
  size: number,
  sha256: string,
): object is R2Object {
  return (
    object !== null &&
    object.size === size &&
    object.customMetadata?.retired === undefined &&
    object.checksums.sha256 !== undefined &&
    bytesToHex(new Uint8Array(object.checksums.sha256)) === sha256
  );
}
async function immutablePut(
  env: Env,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  operation: string,
): Promise<R2Object> {
  const bucket = archiveBucket(env).bucket;
  const result = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256,
    customMetadata: { snapshot_operation: operation },
  });
  const stored = result ?? (await bucket.head(key));
  if (!matches(stored, bytes.byteLength, sha256))
    throw conflict("Cold snapshot key is immutable or retired");
  return stored;
}

/** The full source manifest is fixed before any chunk can acquire a write intent. */
export async function declareColdSnapshot(
  env: Env,
  caller: NodeCaller,
  operation: string,
  body: Uint8Array,
): Promise<Response> {
  if (
    body.byteLength === 0 ||
    body.byteLength > COLD_SNAPSHOT_MANIFEST_MAX_BYTES
  )
    throw invalid();
  const row = await writeRow(env, caller, operation);
  let manifest: ColdSnapshotManifest;
  try {
    manifest = ColdSnapshotManifest.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
      ),
    );
  } catch {
    throw invalid();
  }
  if (
    manifest.operation !== operation ||
    manifest.database_id !== row.database_id ||
    manifest.source_generation !== row.source_generation ||
    manifest.source_storage_generation !== row.source_storage_generation ||
    JSON.stringify(manifest.end) !==
      JSON.stringify(ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json)))
  )
    throw invalid();
  const hash = await digest(body),
    at = iso();
  if (
    row.snapshot_manifest_sha256 !== null &&
    row.snapshot_manifest_sha256 !== hash
  )
    throw conflict("Cold snapshot declaration is immutable");
  const claimed = await env.DB.prepare(
    `UPDATE database_cold_storage AS c SET snapshot_manifest_sha256=?,snapshot_manifest_bytes=?,snapshot_total_bytes=?,snapshot_file_count=?,snapshot_chunk_count=?,updated_at=?
    WHERE c.operation=? AND ${writable} AND (c.snapshot_manifest_sha256 IS NULL OR c.snapshot_manifest_sha256=?) AND ${sourceAuthority}`,
  )
    .bind(
      hash,
      body.byteLength,
      manifest.total_bytes,
      manifest.files.length,
      manifest.chunks.length,
      at,
      operation,
      hash,
      caller.id,
      caller.uid,
    )
    .run();
  if (claimed.meta.changes !== 1) throw refused();
  // The declaration above is the durable manifest-PUT intent. Cleanup fences/tombstones its fixed key.
  await immutablePut(
    env,
    `${row.snapshot_prefix}manifest.json`,
    body,
    hash,
    operation,
  );
  for (let offset = 0; offset < manifest.chunks.length; offset += 512) {
    const chunks = manifest.chunks.slice(offset, offset + 512);
    await env.DB.prepare(
      `INSERT INTO cold_snapshot_chunks(operation,chunk_index,size_bytes,sha256,created_at,updated_at)
      SELECT c.operation,json_extract(j.value,'$.index'),json_extract(j.value,'$.size_bytes'),json_extract(j.value,'$.sha256'),?,?
      FROM database_cold_storage c,json_each(?) j WHERE c.operation=? AND ${writable} AND c.snapshot_manifest_sha256=? AND ${sourceAuthority}
      ON CONFLICT(operation,chunk_index) DO NOTHING`,
    )
      .bind(
        at,
        at,
        JSON.stringify(chunks),
        operation,
        hash,
        caller.id,
        caller.uid,
      )
      .run();
  }
  const completed = await env.DB.prepare(
    `UPDATE database_cold_storage AS c SET snapshot_manifest_declared_at=COALESCE(snapshot_manifest_declared_at,?),updated_at=?
    WHERE c.operation=? AND ${writable} AND c.snapshot_manifest_sha256=? AND ${sourceAuthority}
    AND (SELECT COUNT(*) FROM cold_snapshot_chunks q WHERE q.operation=c.operation)=c.snapshot_chunk_count`,
  )
    .bind(at, at, operation, hash, caller.id, caller.uid)
    .run();
  if (completed.meta.changes !== 1) throw refused();
  return Response.json({
    declared: true,
    manifest_sha256: hash,
    total_chunks: manifest.chunks.length,
  });
}

/** Chunk writes are conditional-create-only, after a durable intent matching the source declaration. */
export async function uploadColdSnapshotChunk(
  env: Env,
  caller: NodeCaller,
  operation: string,
  index: number,
  body: Uint8Array,
): Promise<Response> {
  if (body.byteLength === 0 || body.byteLength > COLD_SNAPSHOT_CHUNK_BYTES)
    throw invalid();
  const row = await writeRow(env, caller, operation),
    key = coldSnapshotChunkKey(row.snapshot_prefix, index);
  if (row.snapshot_manifest_declared_at === null)
    throw conflict("Cold snapshot manifest must be declared first");
  const chunk = await env.DB.prepare(
    "SELECT * FROM cold_snapshot_chunks WHERE operation=? AND chunk_index=?",
  )
    .bind(operation, index)
    .first<ChunkRow>();
  if (
    !chunk ||
    chunk.size_bytes !== body.byteLength ||
    chunk.state === "retired"
  )
    throw invalid();
  const hash = await digest(body);
  if (hash !== chunk.sha256) throw invalid();
  const at = iso();
  const intent = await env.DB.prepare(
    `UPDATE cold_snapshot_chunks SET state=CASE WHEN state='expected' THEN 'uploading' ELSE state END,updated_at=?
    WHERE operation=? AND chunk_index=? AND sha256=? AND size_bytes=? AND state IN('expected','uploading','committed')
    AND EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.operation=cold_snapshot_chunks.operation AND ${writable} AND c.snapshot_manifest_declared_at IS NOT NULL AND ${sourceAuthority})`,
  )
    .bind(at, operation, index, hash, body.byteLength, caller.id, caller.uid)
    .run();
  if (intent.meta.changes !== 1) throw refused();
  const object = await immutablePut(env, key, body, hash, operation);
  const committed = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cold_snapshot_chunks SET state='committed',r2_version=?,committed_at=COALESCE(committed_at,?),updated_at=? WHERE operation=? AND chunk_index=? AND state IN('uploading','committed')
      AND EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.operation=cold_snapshot_chunks.operation AND ${writable} AND ${sourceAuthority})`,
    ).bind(object.version, at, at, operation, index, caller.id, caller.uid),
    env.DB.prepare(
      `UPDATE database_cold_storage SET updated_at=? WHERE operation=? AND phase='capturing' AND cleanup_fenced_at IS NULL AND changes()=1`,
    ).bind(at, operation),
  ]);
  if (committed[0]!.meta.changes !== 1) throw refused();
  return Response.json({ index, size_bytes: body.byteLength, sha256: hash });
}

/** Each call verifies at most 32 immutable R2 objects; a native caller continues until sealed. */
export async function sealColdSnapshot(
  env: Env,
  caller: NodeCaller,
  operation: string,
  manifestSha256: string,
): Promise<Response> {
  if (!ColdSnapshotSha256.safeParse(manifestSha256).success) throw invalid();
  const row = await writeRow(env, caller, operation, true);
  if (
    row.snapshot_manifest_sha256 !== manifestSha256 ||
    row.snapshot_manifest_declared_at === null ||
    row.snapshot_chunk_count === null
  )
    throw conflict("Cold snapshot declaration is incomplete");
  if (row.snapshot_sealed_at !== null)
    return Response.json({
      sealed: true,
      manifest_sha256: manifestSha256,
      checked_chunks: row.snapshot_chunk_count,
      total_chunks: row.snapshot_chunk_count,
    });
  const bucket = archiveBucket(env).bucket;
  if (
    !matches(
      await bucket.head(`${row.snapshot_prefix}manifest.json`),
      row.snapshot_manifest_bytes!,
      manifestSha256,
    )
  )
    throw conflict("Cold snapshot manifest is missing or changed");
  const chunks = (
    await env.DB.prepare(
      "SELECT * FROM cold_snapshot_chunks WHERE operation=? AND chunk_index>=? ORDER BY chunk_index LIMIT 32",
    )
      .bind(operation, row.snapshot_seal_checked_chunks)
      .all<ChunkRow>()
  ).results;
  const expected = Math.min(
    32,
    row.snapshot_chunk_count - row.snapshot_seal_checked_chunks,
  );
  if (chunks.length !== expected)
    throw conflict("Cold snapshot is missing declared chunks");
  for (let offset = 0; offset < chunks.length; offset++) {
    const chunk = chunks[offset]!;
    if (
      chunk.chunk_index !== row.snapshot_seal_checked_chunks + offset ||
      chunk.state !== "committed" ||
      !matches(
        await bucket.head(
          coldSnapshotChunkKey(row.snapshot_prefix, chunk.chunk_index),
        ),
        chunk.size_bytes,
        chunk.sha256,
      )
    )
      throw conflict("Cold snapshot chunk is missing or changed");
  }
  const checked = row.snapshot_seal_checked_chunks + chunks.length,
    sealed = checked === row.snapshot_chunk_count,
    at = iso();
  const advanced = await env.DB.prepare(
    `UPDATE database_cold_storage AS c SET snapshot_seal_checked_chunks=?,snapshot_sealed_at=CASE WHEN ?=1 THEN ? ELSE NULL END,
      phase=CASE WHEN ?=1 THEN 'verifying' ELSE phase END,updated_at=? WHERE c.operation=? AND ${writable}
      AND c.snapshot_manifest_sha256=? AND c.snapshot_seal_checked_chunks=? AND ${sourceAuthority}`,
  )
    .bind(
      checked,
      Number(sealed),
      at,
      Number(sealed),
      at,
      operation,
      manifestSha256,
      row.snapshot_seal_checked_chunks,
      caller.id,
      caller.uid,
    )
    .run();
  if (advanced.meta.changes !== 1)
    throw conflict("Cold snapshot changed during sealing; retry");
  if (sealed && row.verification_node_id)
    await hintNode(env, row.verification_node_id).catch(() => 0);
  return Response.json({
    sealed,
    manifest_sha256: manifestSha256,
    checked_chunks: checked,
    total_chunks: row.snapshot_chunk_count,
  });
}

async function verifiedBody(
  env: Env,
  key: string,
  size: number,
  hash: string,
): Promise<Uint8Array> {
  const object = await archiveBucket(env).bucket.get(key);
  if (!matches(object, size, hash))
    throw conflict("Cold snapshot payload is missing or changed");
  const body = new Uint8Array(await object!.arrayBuffer());
  if (body.byteLength !== size || (await digest(body)) !== hash)
    throw conflict("Cold snapshot payload checksum mismatch");
  return body;
}
export async function readColdSnapshotManifest(
  env: Env,
  caller: NodeCaller,
  operation: string,
): Promise<Response> {
  const row = await readerRow(env, caller, operation);
  const body = await verifiedBody(
    env,
    `${row.snapshot_prefix}manifest.json`,
    row.snapshot_manifest_bytes!,
    row.snapshot_manifest_sha256!,
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-PGCF-SHA256": row.snapshot_manifest_sha256!,
    },
  });
}
export async function readColdSnapshotChunk(
  env: Env,
  caller: NodeCaller,
  operation: string,
  index: number,
): Promise<Response> {
  const row = await readerRow(env, caller, operation),
    key = coldSnapshotChunkKey(row.snapshot_prefix, index);
  const chunk = await env.DB.prepare(
    "SELECT * FROM cold_snapshot_chunks WHERE operation=? AND chunk_index=? AND state='committed'",
  )
    .bind(operation, index)
    .first<ChunkRow>();
  if (!chunk) throw refused();
  const body = await verifiedBody(env, key, chunk.size_bytes, chunk.sha256);
  return new Response(body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-PGCF-SHA256": chunk.sha256,
    },
  });
}

/** The controller rechecks the immutable manifest before authorizing local source retirement. */
export async function assertColdSnapshotManifest(
  env: Env,
  row: Pick<
    SnapshotRow,
    | "operation"
    | "database_id"
    | "source_generation"
    | "source_storage_generation"
    | "proven_sleep_json"
    | "snapshot_prefix"
    | "snapshot_manifest_sha256"
    | "snapshot_manifest_bytes"
    | "snapshot_sealed_at"
    | "cleanup_fenced_at"
    | "snapshot_payload_retired_at"
  >,
): Promise<void> {
  if (
    !row.snapshot_sealed_at ||
    !row.snapshot_manifest_sha256 ||
    !row.snapshot_manifest_bytes ||
    row.cleanup_fenced_at ||
    row.snapshot_payload_retired_at
  )
    throw refused();
  const bytes = await verifiedBody(
    env,
    `${row.snapshot_prefix}manifest.json`,
    row.snapshot_manifest_bytes,
    row.snapshot_manifest_sha256,
  );
  const manifest = ColdSnapshotManifest.parse(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ),
  );
  if (
    manifest.operation !== row.operation ||
    manifest.database_id !== row.database_id ||
    manifest.source_generation !== row.source_generation ||
    manifest.source_storage_generation !== row.source_storage_generation ||
    JSON.stringify(manifest.end) !==
      JSON.stringify(ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json)))
  )
    throw conflict("Cold snapshot identity changed");
}
