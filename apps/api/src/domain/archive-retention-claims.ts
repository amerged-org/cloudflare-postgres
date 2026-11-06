// SPDX-License-Identifier: Apache-2.0
import type { Env } from "../env.ts";

interface Claim {
  claim: string;
  keys_json: string | null;
}

/** A pin and a delete claim are mutually exclusive in D1. A claim never expires: an
 * interrupted deletion resumes its exact persisted key list, never a newly selected batch.
 * This also makes a late concurrent deleter harmless after the claim has been released. */
export async function deleteUnpinnedArchiveKeys<T>(
  env: Pick<Env, "DB">,
  bucket: R2Bucket,
  archivePath: string,
  prefix: string,
  select: () => Promise<{ keys: string[]; value: T }>,
  now: number,
): Promise<{ keys: string[]; value: T | null } | null> {
  const token = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO archive_retention_claims(archive_path,claim,keys_json,created_at)
     SELECT ?,?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM archive_pins WHERE archive_path=? AND released_at IS NULL)
     AND NOT EXISTS(SELECT 1 FROM database_restores reader JOIN operations op ON op.id=reader.operation_id
       WHERE reader.source_archive_path=? AND reader.verified_at IS NULL AND op.status IN('pending','running'))
     AND NOT EXISTS(SELECT 1 FROM database_replacements reader WHERE reader.source_archive_path=? AND reader.phase IN('proving','restoring','rolling_back'))
     AND NOT EXISTS(SELECT 1 FROM database_moves reader WHERE reader.source_archive_path=? AND reader.status IN('proving','restoring'))
     AND NOT EXISTS(SELECT 1 FROM database_cold_storage reader WHERE reader.source_archive_path=? AND reader.kind='rehydrate' AND reader.phase IN('waiting_capacity','restoring','activating'))
     ON CONFLICT(archive_path) DO NOTHING`,
  )
    .bind(
      archivePath,
      token,
      new Date(now).toISOString(),
      archivePath,
      archivePath,
      archivePath,
      archivePath,
      archivePath,
    )
    .run();
  let claim = await env.DB.prepare(
    "SELECT claim,keys_json FROM archive_retention_claims WHERE archive_path=?",
  )
    .bind(archivePath)
    .first<Claim>();
  if (!claim) return null;
  let value: T | null = null;
  if (claim.keys_json === null) {
    let selected: { keys: string[]; value: T };
    try {
      selected = await select();
    } catch (error) {
      // No delete intent was persisted. Only remove the still-unprepared claim: a concurrent
      // selector may already have persisted its own batch, which this invocation must retain.
      await env.DB.prepare(
        "DELETE FROM archive_retention_claims WHERE archive_path=? AND claim=? AND keys_json IS NULL",
      )
        .bind(archivePath, claim.claim)
        .run();
      throw error;
    }
    if (
      selected.keys.some((key) => !key.startsWith(prefix)) ||
      new Set(selected.keys).size !== selected.keys.length
    )
      throw new Error("archive_cleanup_listing_invalid");
    const persisted = await env.DB.prepare(
      `UPDATE archive_retention_claims SET keys_json=? WHERE archive_path=? AND claim=? AND keys_json IS NULL
       AND NOT EXISTS(SELECT 1 FROM archive_pins WHERE archive_path=? AND released_at IS NULL)`,
    )
      .bind(
        JSON.stringify(selected.keys),
        archivePath,
        claim.claim,
        archivePath,
      )
      .run();
    if (persisted.meta.changes === 1) value = selected.value;
    const current = await env.DB.prepare(
      "SELECT claim,keys_json FROM archive_retention_claims WHERE archive_path=? AND claim=?",
    )
      .bind(archivePath, claim.claim)
      .first<Claim>();
    if (!current || current.keys_json === null) return null;
    claim = current;
  }
  const keys: unknown = JSON.parse(claim.keys_json!);
  if (
    !Array.isArray(keys) ||
    keys.some((key) => typeof key !== "string" || !key.startsWith(prefix)) ||
    new Set(keys).size !== keys.length
  )
    throw new Error("archive_retention_claim_invalid");
  // Keep caller order: backup descriptors must disappear before their data. R2's successful
  // delete acknowledgment confirms completion; a thrown/unknown call leaves the durable intent.
  for (const batch of [
    (keys as string[]).filter((key) => key.endsWith("/backup.info")),
    (keys as string[]).filter((key) => !key.endsWith("/backup.info")),
  ])
    for (let i = 0; i < batch.length; i += 1000)
      await bucket.delete(batch.slice(i, i + 1000));
  await env.DB.prepare(
    "DELETE FROM archive_retention_claims WHERE archive_path=? AND claim=? AND keys_json=?",
  )
    .bind(archivePath, claim.claim, claim.keys_json)
    .run();
  return { keys: keys as string[], value };
}
