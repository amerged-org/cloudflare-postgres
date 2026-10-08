// SPDX-License-Identifier: Apache-2.0
import {
  ArchiveReadCredentials,
  RecoverySourceCredentialsMap,
  RegionArchiveSource,
  type RegionArchiveSourceUpdate,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import {
  decryptCustodyDocument,
  encryptCustodyDocument,
} from "../crypto/bootstrap-credentials.ts";

interface SourceRow {
  target_region_id: string;
  source_region_id: string;
  revision: number;
  bucket: string;
  endpoint_url: string;
  kid: string;
  iv: string;
  ciphertext: string;
  updated_at: string;
}
const scope = (target: string, source: string, revision: number) =>
  ["region-archive-source", target, source, revision] as const;
const view = (row: SourceRow, matches: boolean) =>
  RegionArchiveSource.parse({
    target_region_id: row.target_region_id,
    source_region_id: row.source_region_id,
    revision: row.revision,
    bucket: row.bucket,
    endpoint_url: row.endpoint_url,
    required_permission: "object-read-only",
    source_matches_configuration: matches,
    updated_at: row.updated_at,
  });
async function read(c: ApiContext, target: string, source: string) {
  const row = await c.env.DB.prepare(
    "SELECT * FROM region_archive_sources WHERE target_region_id=? AND source_region_id=?",
  )
    .bind(target, source)
    .first<SourceRow>();
  if (!row)
    throw new ApiError("not_found", "Region archive source not configured");
  return row;
}
export async function getRegionArchiveSource(
  c: ApiContext,
  target: string,
  source: string,
) {
  await requireScope(c, "admin");
  const row = await read(c, target, source);
  const registered = await c.env.DB.prepare(
    "SELECT backup_bucket,backup_endpoint_url FROM regions WHERE id=?",
  )
    .bind(source)
    .first<{ backup_bucket: string; backup_endpoint_url: string }>();
  return c.json(
    view(
      row,
      registered?.backup_bucket === row.bucket &&
        registered.backup_endpoint_url === row.endpoint_url,
    ),
  );
}
export async function updateRegionArchiveSource(
  c: ApiContext,
  target: string,
  source: string,
  body: RegionArchiveSourceUpdate,
) {
  await requireScope(c, "admin");
  if (target === source)
    throw new ApiError(
      "invalid_request",
      "Same-region recovery uses its own regional archive credentials",
    );
  return withIdempotency(c, {
    replay: () => getRegionArchiveSource(c, target, source),
    execute: async (lease) => {
      const registered = await c.env.DB.prepare(
        `SELECT s.backup_bucket,s.backup_endpoint_url FROM regions s
        JOIN regions t ON t.id=? WHERE s.id=?`,
      )
        .bind(target, source)
        .first<{ backup_bucket: string; backup_endpoint_url: string }>();
      if (!registered)
        throw new ApiError("not_found", "Source or target region not found");
      if (
        registered.backup_bucket !== body.bucket ||
        registered.backup_endpoint_url !== body.endpoint_url
      )
        throw new ApiError("conflict", "Source archive configuration changed");
      const next = body.expected_revision + 1,
        now = new Date().toISOString();
      const envelope = await encryptCustodyDocument(
        c.env.CREDENTIAL_KEYS,
        scope(target, source, next),
        JSON.stringify(body.credentials),
      );
      const result = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO region_archive_sources(target_region_id,source_region_id,revision,bucket,endpoint_url,kid,iv,ciphertext,updated_at)
          SELECT ?,?,?,?,?,?,?,?,? FROM regions s JOIN regions t ON t.id=? WHERE s.id=?
          AND s.backup_bucket=? AND s.backup_endpoint_url=?
          AND (?=0 OR EXISTS(SELECT 1 FROM region_archive_sources a WHERE a.target_region_id=? AND a.source_region_id=? AND a.revision=?))
          AND NOT EXISTS(SELECT 1 FROM database_restores x JOIN databases d ON d.id=x.target_database_id
            JOIN operations o ON o.id=x.operation_id JOIN databases src ON src.id=x.source_database_id
            WHERE d.region_id=? AND src.region_id=? AND d.deleted_at IS NULL AND o.status<>'succeeded')
          ON CONFLICT(target_region_id,source_region_id) DO UPDATE SET revision=excluded.revision,bucket=excluded.bucket,
            endpoint_url=excluded.endpoint_url,kid=excluded.kid,iv=excluded.iv,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at
          WHERE region_archive_sources.revision=?`,
        ).bind(
          target,
          source,
          next,
          body.bucket,
          body.endpoint_url,
          envelope.kid,
          envelope.iv,
          envelope.ciphertext,
          now,
          target,
          source,
          body.bucket,
          body.endpoint_url,
          body.expected_revision,
          target,
          source,
          body.expected_revision,
          target,
          source,
          body.expected_revision,
        ),
        lease.completeStatement(`${target}/${source}`, 200, {
          sql: "changes()=1",
          bindings: [],
        }),
        c.env.DB.prepare(
          `UPDATE databases SET generation=generation+1,observed_state='provisioning',status_message=NULL,updated_at=?
          WHERE changes()=1 AND region_id=? AND deleted_at IS NULL AND desired_state IN('running','suspended')
          AND id IN(SELECT x.target_database_id FROM database_restores x JOIN databases src ON src.id=x.source_database_id
            WHERE src.region_id=?)`,
        ).bind(now, target, source),
      ]);
      if (result[0]!.meta.changes !== 1)
        throw new ApiError(
          "conflict",
          "Archive source revision changed or a referencing restore is unfinished",
        );
      return getRegionArchiveSource(c, target, source);
    },
  });
}
/** Only the authenticated target agent receives its explicitly assigned source-read keys. */
export async function desiredRegionArchiveSources(
  env: Env,
  target: string,
): Promise<RecoverySourceCredentialsMap | undefined> {
  const rows = await env.DB.prepare(
    "SELECT * FROM region_archive_sources WHERE target_region_id=? ORDER BY source_region_id",
  )
    .bind(target)
    .all<SourceRow>();
  if (!rows.results.length) return undefined;
  const sources: RecoverySourceCredentialsMap = {};
  for (const row of rows.results) {
    const registered = await env.DB.prepare(
      "SELECT backup_bucket,backup_endpoint_url FROM regions WHERE id=?",
    )
      .bind(row.source_region_id)
      .first<{ backup_bucket: string; backup_endpoint_url: string }>();
    // A drifted source is absent from the authoritative map, never replaced with a legacy/write key.
    if (
      registered?.backup_bucket !== row.bucket ||
      registered.backup_endpoint_url !== row.endpoint_url
    )
      continue;
    const credentials = ArchiveReadCredentials.parse(
      JSON.parse(
        await decryptCustodyDocument(
          env.CREDENTIAL_KEYS,
          scope(target, row.source_region_id, row.revision),
          { kid: row.kid, iv: row.iv, ciphertext: row.ciphertext },
        ),
      ),
    );
    sources[row.source_region_id] = {
      bucket: row.bucket,
      endpoint_url: row.endpoint_url,
      ...credentials,
    };
  }
  return RecoverySourceCredentialsMap.parse(sources);
}
