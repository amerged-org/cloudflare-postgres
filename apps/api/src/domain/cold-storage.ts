// SPDX-License-Identifier: Apache-2.0
/** R2-only residency. D1 owns every transition; nodes only execute and attest exact generations. */
import {
  COLD_STORAGE_SLEEP_SECONDS,
  ArchiveVerificationCancellation,
  ArchiveVerificationRequest,
  ArchiveVerificationResult,
  ProvenSleepRecord,
  bytesToHex,
  newOperationId,
  archiveDestinationPath,
  parseArchivePath,
  type NodeObservationReport,
} from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { ApiError } from "../api-error.ts";
import {
  withAdmissionMutation,
  type LocalAdmissionActor,
} from "./admission-mutations.ts";
import type { IdempotencyLease } from "../middleware/idempotency.ts";
import { archiveBucket } from "./archive-bucket.ts";
import { validatedArchivePrefix } from "./archive.ts";
import { sourceArchiveHolds, type MoveTarget } from "./database-moves.ts";
import {
  ensureArchiveCredential,
  archiveCredentialStatement,
  newArchiveCredentialId,
} from "./archive-credentials.ts";
import { coldStorageNativeGuard } from "./native-capabilities.ts";
import {
  choosePlacement,
  placementNodes,
  placementGuard,
} from "./placement.ts";
import { hintNode } from "./node-hints.ts";
import { emitColdStorageMetrics } from "./cold-storage-metrics.ts";

export const COLD_STORAGE_SLEEP_MS = COLD_STORAGE_SLEEP_SECONDS * 1000;
export const COLD_STORAGE_RETRY_MS = 6 * 3_600_000;
const iso = (now: number) => new Date(now).toISOString();
const activePhases = "'verifying','retiring','waiting_capacity','restoring'";
type Residency = "local" | "archiving" | "archived" | "restoring";
interface ColdDatabase {
  id: string;
  project_id: string;
  region_id: string;
  node_id: string | null;
  generation: number;
  storage_generation: number;
  archive_path: string;
  desired_state: string;
  suspension_reason: string | null;
  observed_state: string;
  observed_power: string;
  observed_generation: number;
  deleted_at: string | null;
  storage_residency: Residency;
  storage_operation_id: string | null;
  sleep_since: string | null;
  proven_sleep_json: string | null;
  memory_mib: number;
  cpu_millicores: number;
  storage_mib: number;
  max_connections: number;
  archive_timeout_seconds: number;
  backup_json: string | null;
}
export interface ColdStorageRow {
  operation: string;
  kind: "archive" | "rehydrate";
  database_id: string;
  project_id: string;
  region_id: string;
  source_operation: string | null;
  phase: string;
  source_node_id: string;
  source_generation: number;
  source_storage_generation: number;
  source_archive_path: string;
  source_backup_id: string;
  proven_sleep_json: string;
  inventory_sha256: string | null;
  inventory_json: string | null;
  verification_node_id: string | null;
  verification_receipt_json: string | null;
  verification_dispatched_at: string | null;
  target_started_at: string | null;
  retirement_operation: string | null;
  source_removed_at: string | null;
  target_node_id: string | null;
  target_generation: number | null;
  target_storage_generation: number | null;
  target_archive_path: string | null;
  wake_requested: number;
  manual_resume_requested: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  failure: string | null;
}
const coldSelect = "SELECT * FROM database_cold_storage";
const databaseSelect = `SELECT d.*,r.memory_mib,r.cpu_millicores,r.storage_mib,s.max_connections,s.archive_timeout_seconds,p.backup_json
 FROM databases d JOIN projects j ON j.id=d.project_id AND j.deleted_at IS NULL
 JOIN database_resources r ON r.database_id=d.id JOIN size_classes s ON s.id=d.size_class_id
 LEFT JOIN database_recovery_points p ON p.database_id=d.id AND p.node_id=d.node_id AND p.storage_generation=d.storage_generation AND p.generation=d.generation AND p.state='asleep' AND p.proven_sleep_json=d.proven_sleep_json
 WHERE d.id=?`;
const readDatabase = (env: Env, id: string) =>
  env.DB.prepare(databaseSelect).bind(id).first<ColdDatabase>();
const readOperation = (env: Env, operation: string) =>
  env.DB.prepare(`${coldSelect} WHERE operation=?`)
    .bind(operation)
    .first<ColdStorageRow>();
const conflict = () =>
  new ApiError("conflict", "Database changed; retry the request", {
    reason: "generation_changed",
  });
const noMutation = { sql: "1=1", bindings: [] as (string | number | null)[] };

/** A complete bounded inventory is bound into the verifier receipt and re-read before retirement. */
async function archiveInventory(
  env: Env,
  archivePath: string,
  backupId: string,
) {
  const { bucket, bucketName } = archiveBucket(env);
  const parsed = parseArchivePath(archivePath);
  if (!parsed) throw new Error("invalid_archive_path");
  const prefix = validatedArchivePrefix(
    {
      id: parsed.database,
      region_id: parsed.region,
      storage_generation: parsed.generation,
      archive_path: archivePath,
    },
    bucketName,
  );
  const objects: {
    key: string;
    etag: string;
    version: string;
    size: number;
  }[] = [];
  for (const selected of [`${prefix}base/${backupId}/`, `${prefix}wals/`]) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({
        prefix: selected,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const object of page.objects) {
        objects.push({
          key: object.key,
          etag: object.etag,
          version: object.version,
          size: object.size,
        });
        if (objects.length > 8000)
          throw new Error("archive_inventory_too_large");
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  objects.sort((a, b) => a.key.localeCompare(b.key));
  const json = JSON.stringify(objects);
  if (new TextEncoder().encode(json).length > 1_000_000)
    throw new Error("archive_inventory_too_large");
  return {
    json,
    sha256: bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
      ),
    ),
  };
}

/** Claims a sleeper without changing its original power intent, proof or generation. */
export async function startColdStorageArchive(
  env: Env,
  databaseId: string,
  now = Date.now(),
): Promise<string | null> {
  if (env.COLD_STORAGE_ARCHIVAL_ENABLED !== "true") return null;
  const d = await readDatabase(env, databaseId);
  if (
    !d ||
    d.deleted_at ||
    d.storage_residency !== "local" ||
    !d.node_id ||
    !d.sleep_since ||
    now - Date.parse(d.sleep_since) <= COLD_STORAGE_SLEEP_MS ||
    d.desired_state !== "suspended" ||
    d.observed_power !== "hibernated" ||
    d.observed_generation !== d.generation ||
    !d.proven_sleep_json ||
    !d.backup_json
  )
    return null;
  const proof = ProvenSleepRecord.parse(JSON.parse(d.proven_sleep_json));
  const backup = JSON.parse(d.backup_json) as {
    backup_id: string;
    timeline: number;
    completed_at: string;
  };
  if (
    Date.parse(proof.proven_at) > now ||
    !(await sourceArchiveHolds(env, d, {
      id: d.id,
      generation: d.generation,
      operation: newOperationId(),
      storage_generation: d.storage_generation,
      state: "asleep",
      proven_sleep: proof,
      backup,
      archive: { last_segment: null, ready_files: 0, failing_since: null },
    }))
  )
    return null;
  if (
    await env.DB.prepare(
      `SELECT 1 FROM database_cold_storage WHERE database_id=? AND kind='archive' AND phase='failed'
    AND source_storage_generation=? AND proven_sleep_json=? AND source_backup_id=? AND completed_at>?`,
    )
      .bind(
        d.id,
        d.storage_generation,
        d.proven_sleep_json,
        backup.backup_id,
        iso(now - COLD_STORAGE_RETRY_MS),
      )
      .first()
  )
    return null;
  const capability = coldStorageNativeGuard(env, { nodeId: d.node_id }, now);
  if (
    !(await env.DB.prepare(`SELECT 1 WHERE ${capability.sql}`)
      .bind(...capability.bindings)
      .first())
  )
    return null;
  // Verification uses physical headroom for an extra full-sized scratch volume and runtime.
  const nodes = await placementNodes(env.DB, d.region_id, now);
  const eligible = [];
  for (const n of nodes) {
    const guard = coldStorageNativeGuard(env, { nodeId: n.id }, now);
    if (
      await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`)
        .bind(...guard.bindings)
        .first()
    )
      eligible.push(n);
  }
  const verifier = choosePlacement(eligible, d, now);
  if (!verifier) return null;
  const inventory = await archiveInventory(
    env,
    d.archive_path,
    backup.backup_id,
  );
  const operation = newOperationId(),
    at = iso(now);
  const placement = placementGuard("n", {
    nodeId: verifier.id,
    pendingMemoryMib: verifier.pending_memory_mib,
    pendingStorageMib: verifier.pending_storage_mib,
    now,
  });
  await withAdmissionMutation(env, [d.id], async (mutation) => {
    const authority = mutation.guard(d.id);
    const guard = `d.id=? AND d.generation=? AND d.storage_generation=? AND d.node_id=? AND d.archive_path=? AND d.proven_sleep_json=?
      AND d.storage_residency='local' AND d.deleted_at IS NULL AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.observed_generation=d.generation
      AND EXISTS(SELECT 1 FROM database_recovery_points rp WHERE rp.database_id=d.id AND rp.node_id=d.node_id AND rp.storage_generation=d.storage_generation AND rp.generation=d.generation AND rp.state='asleep' AND rp.proven_sleep_json=d.proven_sleep_json AND json_extract(rp.backup_json,'$.backup_id')=?)
      AND d.sleep_since=? AND d.sleep_since<? AND EXISTS(SELECT 1 FROM projects p WHERE p.id=d.project_id AND p.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.region_id=d.region_id AND (c.phase='verifying' OR (c.kind='archive' AND c.phase IN('cancelled','failed') AND c.verification_dispatched_at IS NOT NULL AND EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.operation=c.operation AND pin.released_at IS NULL))))
      AND NOT EXISTS(SELECT 1 FROM database_cold_storage cf WHERE cf.database_id=d.id AND cf.kind='archive' AND cf.phase='failed' AND cf.source_storage_generation=d.storage_generation AND cf.proven_sleep_json=d.proven_sleep_json AND cf.source_backup_id=? AND cf.completed_at>?)
      AND NOT EXISTS(SELECT 1 FROM database_moves m WHERE m.database_id=d.id AND m.status IN('proving','restoring'))
      AND NOT EXISTS(SELECT 1 FROM database_replacements p WHERE p.database_id=d.id AND p.phase IN('proving','restoring','rolling_back'))
      AND NOT EXISTS(SELECT 1 FROM archive_retention_claims c WHERE c.archive_path=d.archive_path)
      AND EXISTS(SELECT 1 FROM nodes n WHERE ${placement.sql}) AND (${capability.sql}) AND (${authority.sql})`;
    const binds = [
      d.id,
      d.generation,
      d.storage_generation,
      d.node_id,
      d.archive_path,
      d.proven_sleep_json,
      backup.backup_id,
      d.sleep_since,
      iso(now - COLD_STORAGE_SLEEP_MS),
      backup.backup_id,
      iso(now - COLD_STORAGE_RETRY_MS),
      ...placement.bindings,
      ...capability.bindings,
      ...authority.bindings,
    ];
    return mutation.batch([
      env.DB.prepare(
        `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at)
        SELECT ?,'database.archive','running',d.project_id,d.id,d.generation,?,? FROM databases d WHERE ${guard}`,
      ).bind(operation, at, at, ...binds),
      env.DB.prepare(
        `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,phase,source_node_id,source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,inventory_sha256,inventory_json,verification_node_id,created_at,updated_at)
        SELECT ?,'archive',d.id,d.project_id,d.region_id,'verifying',d.node_id,d.generation,d.storage_generation,d.archive_path,?,?,?,?,?,?,? FROM databases d
        WHERE d.id=? AND EXISTS(SELECT 1 FROM cold_storage_operations WHERE id=?)`,
      ).bind(
        operation,
        backup.backup_id,
        d.proven_sleep_json,
        inventory.sha256,
        inventory.json,
        verifier.id,
        at,
        at,
        d.id,
        operation,
      ),
      env.DB.prepare(
        `INSERT INTO archive_pins(operation,archive_path,database_id,created_at)
        SELECT operation,source_archive_path,database_id,? FROM database_cold_storage WHERE operation=?`,
      ).bind(at, operation),
      env.DB.prepare(
        `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
        SELECT operation,source_node_id,'move',database_id,source_storage_generation,0,? FROM database_cold_storage WHERE operation=?`,
      ).bind(at, operation),
      env.DB.prepare(
        `UPDATE databases SET storage_residency='archiving',storage_operation_id=?,updated_at=? WHERE id=?
        AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=?)`,
      ).bind(operation, at, d.id, operation),
    ]);
  });
  if (!(await readOperation(env, operation))) return null;
  await hintNode(env, d.node_id).catch(() => 0);
  return operation;
}

/** No source task is delivered until its node positively acknowledged the wake hold. */
export async function coldStorageVerifications(
  env: Env,
  nodeId: string,
  now = Date.now(),
): Promise<ArchiveVerificationRequest[]> {
  const capable = coldStorageNativeGuard(env, { nodeId }, now, true);
  if (
    !(await env.DB.prepare(`SELECT 1 WHERE ${capable.sql}`)
      .bind(...capable.bindings)
      .first())
  )
    return [];
  const rows = (
    await env.DB.prepare(
      `${coldSelect} c WHERE c.phase='verifying' AND c.verification_node_id=?
    AND EXISTS(SELECT 1 FROM lifecycle_orders l WHERE l.operation=c.operation AND l.result_status='done' AND l.closed_at IS NULL)
    AND EXISTS(SELECT 1 FROM databases d WHERE d.id=c.database_id AND d.storage_operation_id=c.operation AND d.storage_residency='archiving'
      AND d.node_id=c.source_node_id AND d.generation=c.source_generation AND d.storage_generation=c.source_storage_generation
      AND d.proven_sleep_json=c.proven_sleep_json AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.observed_generation=d.generation)
    ORDER BY c.created_at LIMIT 1`,
    )
      .bind(nodeId)
      .all<ColdStorageRow>()
  ).results;
  const result: ArchiveVerificationRequest[] = [];
  for (const row of rows) {
    const d = (await readDatabase(env, row.database_id))!;
    const dispatched = await env.DB.prepare(
      "UPDATE database_cold_storage SET verification_dispatched_at=COALESCE(verification_dispatched_at,?),updated_at=? WHERE operation=? AND phase='verifying'",
    )
      .bind(iso(now), iso(now), row.operation)
      .run();
    if (dispatched.meta.changes !== 1) continue;
    result.push(
      ArchiveVerificationRequest.parse({
        operation: row.operation,
        database_id: row.database_id,
        source_node_id: row.source_node_id,
        source_generation: row.source_generation,
        source_storage_generation: row.source_storage_generation,
        source: {
          database_id: row.database_id,
          path: row.source_archive_path,
          backup_id: row.source_backup_id,
          end: JSON.parse(row.proven_sleep_json),
          credential: await ensureArchiveCredential(
            env.DB,
            {
              nodeId,
              archivePath: row.source_archive_path,
              access: "read_only",
            },
            now,
          ),
        },
        inventory_sha256: row.inventory_sha256,
        resources: {
          memory_mib: d.memory_mib,
          cpu_millicores: d.cpu_millicores,
          storage_mib: d.storage_mib,
        },
        settings: {
          max_connections: d.max_connections,
          archive_timeout_seconds: d.archive_timeout_seconds,
        },
      }),
    );
  }
  return result;
}

/** Cleanup stays deliverable even when the original verification response was lost. */
export async function coldStorageVerificationCancellations(
  env: Env,
  nodeId: string,
): Promise<ArchiveVerificationCancellation[]> {
  const rows = (
    await env.DB.prepare(
      `${coldSelect} c WHERE c.verification_node_id=? AND c.kind='archive' AND c.phase IN('cancelled','failed')
    AND c.verification_dispatched_at IS NOT NULL AND EXISTS(SELECT 1 FROM archive_pins p WHERE p.operation=c.operation AND p.released_at IS NULL)
    ORDER BY c.created_at,c.operation LIMIT 1`,
    )
      .bind(nodeId)
      .all<ColdStorageRow>()
  ).results;
  return rows.map((c) =>
    ArchiveVerificationCancellation.parse({
      operation: c.operation,
      database_id: c.database_id,
      source_generation: c.source_generation,
      source_storage_generation: c.source_storage_generation,
      inventory_sha256: c.inventory_sha256,
    }),
  );
}

/** A lost target is safe to replace only after its Tunnel and provider power fences are positive. */
const fencedNodeSql = (node: string) =>
  `EXISTS(SELECT 1 FROM node_losses loss WHERE loss.node_id=${node} AND loss.tunnel_deleted_at IS NOT NULL AND loss.powered_off_at IS NOT NULL)`;
const retiredTargetSql = (
  c: string,
) => `(${c}.target_node_id IS NULL OR EXISTS(SELECT 1 FROM lifecycle_orders l WHERE l.node_id=${c}.target_node_id AND l.database_id=${c}.database_id
  AND l.storage_generation=${c}.target_storage_generation AND l.type='superseded' AND l.remove_volume=1 AND (l.result_status='done' OR ${fencedNodeSql(`${c}.target_node_id`)})))`;

export interface ColdWakeOptions {
  role?: string;
  manualResume?: boolean;
  now?: number;
  localActor?: LocalAdmissionActor;
  idempotency?: IdempotencyLease;
  expectedGeneration?: number;
  /** Only durable previously admitted wake intent may bypass a fresh role hint. */
  internalWake?: boolean;
}
export interface ColdWakeResult {
  handled: boolean;
  operationId?: string;
  waiting: boolean;
  cancelledArchive?: boolean;
}

/** An admitted connection and management resume share one durable restore claim. */
export async function requestColdStorageWake(
  env: Env,
  databaseId: string,
  options: ColdWakeOptions = {},
): Promise<ColdWakeResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestColdStorageWakeOnce(env, databaseId, options);
    } catch (error) {
      if (
        attempt >= 19 ||
        !(error instanceof ApiError) ||
        error.code !== "conflict" ||
        !["mutation_in_progress", "generation_changed"].includes(
          String(error.details?.reason),
        )
      )
        throw error;
      // A competing wake or publication owns the brief mutation boundary. Re-read its committed
      // operation instead of creating a second restore or returning a false cancellation.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(25 * (attempt + 1), 100)),
      );
    }
  }
}

async function requestColdStorageWakeOnce(
  env: Env,
  databaseId: string,
  options: ColdWakeOptions = {},
): Promise<ColdWakeResult> {
  const now = options.now ?? Date.now(),
    at = iso(now),
    d = await readDatabase(env, databaseId);
  if (!d || d.storage_residency === "local")
    return { handled: false, waiting: false };
  if (d.deleted_at || d.desired_state === "deleted")
    return { handled: true, waiting: false };
  if (
    options.expectedGeneration !== undefined &&
    options.expectedGeneration !== d.generation
  )
    throw conflict();
  if (d.suspension_reason === "manual" && !options.manualResume)
    return { handled: true, waiting: false };
  if (
    !options.manualResume &&
    !options.internalWake &&
    (!options.role ||
      !(await env.DB.prepare(
        `SELECT 1 FROM roles WHERE database_id=? AND name=? AND deleted_at IS NULL AND (valid_until IS NULL OR substr(valid_until,1,19)>substr(?,1,19))`,
      )
        .bind(d.id, options.role, at)
        .first()))
  )
    return { handled: true, waiting: false };
  const prior = d.storage_operation_id
    ? await readOperation(env, d.storage_operation_id)
    : null;
  if (!prior) return { handled: true, waiting: false };
  const roleGuard =
    options.manualResume || options.internalWake
      ? noMutation
      : {
          sql: "EXISTS(SELECT 1 FROM roles WHERE database_id=? AND name=? AND deleted_at IS NULL AND (valid_until IS NULL OR substr(valid_until,1,19)>substr(?,1,19)))",
          bindings: [d.id, options.role!, at],
        };
  const lease = options.idempotency?.guard ?? noMutation;
  const completion = (
    op: string,
    sql: string,
    bindings: (string | number | null)[],
  ) =>
    options.idempotency
      ? [options.idempotency.completeStatement(op, 202, { sql, bindings })]
      : [];
  if (prior.phase === "verifying") {
    await withAdmissionMutation(
      env,
      [d.id],
      async (mutation) => {
        const g = mutation.guard(d.id);
        return mutation.batch([
          env.DB.prepare(
            `UPDATE database_cold_storage SET phase='cancelled',failure='wake_requested',completed_at=?,updated_at=? WHERE operation=? AND phase='verifying'
          AND EXISTS(SELECT 1 FROM databases WHERE id=? AND generation=? AND storage_operation_id=?) AND (${g.sql}) AND (${roleGuard.sql}) AND (${lease.sql})`,
          ).bind(
            at,
            at,
            prior.operation,
            d.id,
            d.generation,
            prior.operation,
            ...g.bindings,
            ...roleGuard.bindings,
            ...lease.bindings,
          ),
          env.DB.prepare(
            `UPDATE databases SET storage_residency='local',storage_operation_id=NULL,updated_at=? WHERE id=? AND storage_operation_id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelled')`,
          ).bind(at, d.id, prior.operation, prior.operation),
          env.DB.prepare(
            `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelled')`,
          ).bind(at, prior.operation, prior.operation),
          env.DB.prepare(
            `UPDATE archive_pins SET released_at=? WHERE operation=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelled' AND verification_dispatched_at IS NULL)`,
          ).bind(at, prior.operation, prior.operation),
          env.DB.prepare(
            `UPDATE cold_storage_operations SET status='failed',error_code='cancelled',error_message='Archival cancelled by a wake',updated_at=?,completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='cancelled')`,
          ).bind(at, at, prior.operation, prior.operation),
        ]);
      },
      undefined,
      options.localActor,
    );
    const cancelled = await readOperation(env, prior.operation);
    const current = await readDatabase(env, d.id);
    if (
      cancelled?.phase !== "cancelled" ||
      current?.storage_residency !== "local"
    )
      throw conflict();
    await hintNode(env, prior.source_node_id).catch(() => 0);
    return { handled: false, waiting: false, cancelledArchive: true };
  }
  if (
    prior.phase === "retiring" ||
    prior.phase === "waiting_capacity" ||
    prior.phase === "restoring"
  ) {
    const current = `EXISTS(SELECT 1 FROM databases WHERE id=? AND generation=? AND storage_operation_id=? AND deleted_at IS NULL AND (suspension_reason IS NOT 'manual' OR ?=1)) AND (${roleGuard.sql}) AND (${lease.sql})`;
    const binds = [
      d.id,
      d.generation,
      prior.operation,
      Number(options.manualResume ?? false),
      ...roleGuard.bindings,
      ...lease.bindings,
    ];
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE database_cold_storage SET wake_requested=1,manual_resume_requested=MAX(manual_resume_requested,?),updated_at=? WHERE operation=? AND phase IN('retiring','waiting_capacity','restoring') AND ${current}`,
      ).bind(
        Number(options.manualResume ?? false),
        at,
        prior.operation,
        ...binds,
      ),
      ...completion(prior.operation, current, binds),
    ]);
    if (results[0]!.meta.changes !== 1) throw conflict();
    return { handled: true, waiting: true, operationId: prior.operation };
  }
  if (d.storage_residency !== "archived")
    return { handled: true, waiting: false };
  const source =
    prior.kind === "archive"
      ? prior
      : prior.source_operation
        ? await readOperation(env, prior.source_operation)
        : null;
  if (!source || source.phase !== "archived" || !source.source_removed_at)
    return { handled: true, waiting: false };
  // An earlier failed target must have acknowledged its retirement before a new target can start.
  if (
    prior.kind === "rehydrate" &&
    prior.target_node_id &&
    !(await env.DB.prepare(
      `SELECT 1 FROM database_cold_storage c WHERE c.operation=? AND ${retiredTargetSql("c")}`,
    )
      .bind(prior.operation)
      .first())
  )
    return { handled: true, waiting: false, operationId: prior.operation };
  const op = newOperationId();
  await withAdmissionMutation(
    env,
    [d.id],
    async (mutation) => {
      const g = mutation.guard(d.id);
      const guard = `d.id=? AND d.generation=? AND d.storage_operation_id=? AND d.storage_residency='archived' AND d.deleted_at IS NULL AND (d.suspension_reason IS NOT 'manual' OR ?=1)
      AND EXISTS(SELECT 1 FROM projects p WHERE p.id=d.project_id AND p.deleted_at IS NULL) AND (${g.sql}) AND (${roleGuard.sql}) AND (${lease.sql})`;
      const binds = [
        d.id,
        d.generation,
        prior.operation,
        Number(options.manualResume ?? false),
        ...g.bindings,
        ...roleGuard.bindings,
        ...lease.bindings,
      ];
      const accepted = {
        sql: "EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='waiting_capacity')",
        bindings: [op],
      };
      return mutation.batch([
        env.DB.prepare(
          `INSERT INTO cold_storage_operations(id,kind,status,project_id,database_id,generation,created_at,updated_at) SELECT ?,'database.rehydrate','pending',d.project_id,d.id,d.generation+1,?,? FROM databases d WHERE ${guard}`,
        ).bind(op, at, at, ...binds),
        env.DB.prepare(
          `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,source_operation,phase,source_node_id,source_generation,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,inventory_sha256,inventory_json,wake_requested,manual_resume_requested,created_at,updated_at)
        SELECT ?,'rehydrate',database_id,project_id,region_id,operation,'waiting_capacity',source_node_id,?,source_storage_generation,source_archive_path,source_backup_id,proven_sleep_json,inventory_sha256,inventory_json,1,?,?,? FROM database_cold_storage WHERE operation=? AND phase='archived' AND EXISTS(SELECT 1 FROM cold_storage_operations WHERE id=?)`,
        ).bind(
          op,
          d.generation,
          Number(options.manualResume ?? false),
          at,
          at,
          source.operation,
          op,
        ),
        env.DB.prepare(
          `INSERT INTO archive_pins(operation,archive_path,database_id,created_at) SELECT operation,source_archive_path,database_id,? FROM database_cold_storage WHERE operation=?`,
        ).bind(at, op),
        env.DB.prepare(
          `UPDATE databases SET storage_residency='restoring',storage_operation_id=?,desired_state='running',suspension_reason=NULL,status_message='Restoring from R2',updated_at=? WHERE id=? AND ${accepted.sql}`,
        ).bind(op, at, d.id, ...accepted.bindings),
        ...completion(op, accepted.sql, accepted.bindings),
      ]);
    },
    undefined,
    options.localActor,
  );
  if (!(await readOperation(env, op))) throw conflict();
  // The durable cron places the job too; a disconnected caller cannot cancel it.
  await placeColdStorageRestore(env, op, now);
  return { handled: true, waiting: true, operationId: op };
}

export async function readColdStorageWake(
  env: Env,
  id: string,
  operationId: string,
): Promise<"pending" | "ready" | "failed"> {
  const d = await readDatabase(env, id);
  if (!d || d.deleted_at || d.suspension_reason === "manual") return "failed";
  const initial = await readOperation(env, operationId);
  if (!initial || initial.database_id !== id) return "failed";
  const current = d.storage_operation_id
    ? await readOperation(env, d.storage_operation_id)
    : null;
  const descendant =
    current?.operation === operationId ||
    current?.source_operation === operationId;
  if (!current || !descendant) return "failed";
  if (current.phase === "failed" || current.phase === "cancelled")
    return "failed";
  if (
    current.phase === "succeeded" &&
    d.storage_residency === "local" &&
    d.desired_state === "running" &&
    d.observed_state === "ready" &&
    d.observed_power === "awake" &&
    d.observed_generation === d.generation
  )
    return "ready";
  return "pending";
}

/** Pending resource accounting includes the staged target before any serving assignment changes. */
export async function placeColdStorageRestore(
  env: Env,
  operation: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await readOperation(env, operation);
  if (!row || row.phase !== "waiting_capacity") return false;
  const d = await readDatabase(env, row.database_id);
  if (
    !d ||
    d.deleted_at ||
    d.storage_operation_id !== operation ||
    d.desired_state !== "running"
  )
    return false;
  const candidates = await placementNodes(env.DB, row.region_id, now),
    eligible = [];
  for (const n of candidates) {
    const capable = coldStorageNativeGuard(env, { nodeId: n.id }, now);
    if (
      await env.DB.prepare(`SELECT 1 WHERE ${capable.sql}`)
        .bind(...capable.bindings)
        .first()
    )
      eligible.push(n);
  }
  const node = choosePlacement(eligible, d, now);
  if (!node) return false;
  const highest = await env.DB.prepare(
    `SELECT MAX(n) n FROM (
    SELECT storage_generation n FROM databases WHERE id=? UNION ALL SELECT target_storage_generation FROM database_cold_storage WHERE database_id=?
    UNION ALL SELECT target_storage_generation FROM database_moves WHERE database_id=? UNION ALL SELECT target_storage_generation FROM database_replacements WHERE database_id=?
    UNION ALL SELECT rollback_storage_generation FROM database_replacements WHERE database_id=?)`,
  )
    .bind(d.id, d.id, d.id, d.id, d.id)
    .first<number>("n");
  const storage = (highest ?? d.storage_generation) + 1,
    generation = d.generation + 1,
    at = iso(now);
  const path = archiveDestinationPath(
    archiveBucket(env).bucketName,
    d.region_id,
    d.id,
    storage,
    operation,
  );
  const load = placementGuard("n", {
    nodeId: node.id,
    pendingMemoryMib: node.pending_memory_mib,
    pendingStorageMib: node.pending_storage_mib,
    now,
  });
  const capable = coldStorageNativeGuard(env, { nodeId: node.id }, now);
  const result = await env.DB.batch([
    env.DB.prepare(
      `UPDATE database_cold_storage SET phase='restoring',target_node_id=?,target_generation=?,target_storage_generation=?,target_archive_path=?,target_started_at=?,updated_at=?
      WHERE operation=? AND phase='waiting_capacity' AND EXISTS(SELECT 1 FROM databases d WHERE d.id=? AND d.generation=? AND d.storage_operation_id=? AND d.storage_residency='restoring' AND d.desired_state='running' AND d.deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM nodes n WHERE n.region_id=? AND ${load.sql}) AND (${capable.sql})`,
    ).bind(
      node.id,
      generation,
      storage,
      path,
      at,
      at,
      operation,
      d.id,
      d.generation,
      operation,
      d.region_id,
      ...load.bindings,
      ...capable.bindings,
    ),
    env.DB.prepare(
      `UPDATE cold_storage_operations SET status='running',generation=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='restoring' AND target_storage_generation=?)`,
    ).bind(generation, at, operation, operation, storage),
    archiveCredentialStatement(
      env.DB,
      { nodeId: node.id, archivePath: path, access: "read_write" },
      newArchiveCredentialId(),
      now,
    ),
    archiveCredentialStatement(
      env.DB,
      {
        nodeId: node.id,
        archivePath: row.source_archive_path,
        access: "read_only",
      },
      newArchiveCredentialId(),
      now,
    ),
  ]);
  if (result[0]!.meta.changes !== 1) return false;
  await hintNode(env, node.id).catch(() => 0);
  return true;
}

export async function coldStorageTargets(
  env: Env,
  nodeId: string,
  now = Date.now(),
): Promise<Map<string, MoveTarget>> {
  const result = new Map<string, MoveTarget>();
  const rows = (
    await env.DB.prepare(
      `${coldSelect} c WHERE c.target_node_id=? AND c.phase='restoring'
    AND EXISTS(SELECT 1 FROM databases d WHERE d.id=c.database_id AND d.storage_operation_id=c.operation AND d.desired_state='running' AND d.deleted_at IS NULL AND d.generation=c.source_generation)`,
    )
      .bind(nodeId)
      .all<ColdStorageRow>()
  ).results;
  for (const row of rows)
    result.set(row.database_id, {
      operation: row.operation,
      generation: row.target_generation!,
      storage_generation: row.target_storage_generation!,
      archive: {
        path: row.target_archive_path!,
        credential: await ensureArchiveCredential(
          env.DB,
          {
            nodeId,
            archivePath: row.target_archive_path!,
            access: "read_write",
          },
          now,
        ),
      },
      origin: {
        kind: "rehydrate",
        source: {
          database_id: row.database_id,
          path: row.source_archive_path,
          backup_id: row.source_backup_id,
          end: ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json)),
          credential: await ensureArchiveCredential(
            env.DB,
            {
              nodeId,
              archivePath: row.source_archive_path,
              access: "read_only",
            },
            now,
          ),
        },
      },
    });
  return result;
}

async function failColdStorage(
  env: Env,
  row: ColdStorageRow,
  reason: string,
  now: number,
  cleanedUp = false,
) {
  const at = iso(now),
    retirement = newOperationId();
  await withAdmissionMutation(env, [row.database_id], async (mutation) => {
    const guard = mutation.guard(row.database_id);
    return mutation.batch([
      env.DB.prepare(
        `UPDATE database_cold_storage SET phase='failed',failure=?,completed_at=?,updated_at=? WHERE operation=? AND phase IN('verifying','waiting_capacity','restoring') AND (${guard.sql})`,
      ).bind(reason, at, at, row.operation, ...guard.bindings),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET status='failed',error_code=?,error_message='Cold storage operation failed; recovery source preserved',updated_at=?,completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='failed')`,
      ).bind(reason, at, at, row.operation, row.operation),
      env.DB.prepare(
        `UPDATE databases SET storage_residency=?,storage_operation_id=?,status_message='Cold storage operation failed; recovery source preserved',updated_at=? WHERE id=? AND storage_operation_id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='failed')`,
      ).bind(
        row.kind === "archive" ? "local" : "archived",
        row.kind === "archive" ? null : row.operation,
        at,
        row.database_id,
        row.operation,
        row.operation,
      ),
      env.DB.prepare(
        `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='failed')`,
      ).bind(at, row.operation, row.operation),
      ...(row.kind === "rehydrate" && row.source_operation
        ? [
            env.DB.prepare(
              `UPDATE cold_storage_operations SET status='failed',error_code=?,error_message='Cold restore failed; recovery source preserved',updated_at=?,completed_at=? WHERE id=? AND status='running' AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='failed')`,
            ).bind(reason, at, at, row.source_operation, row.operation),
          ]
        : []),
      ...(row.target_node_id && row.target_storage_generation
        ? [
            env.DB.prepare(
              `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
        SELECT ?,target_node_id,'superseded',database_id,target_storage_generation,1,? FROM database_cold_storage WHERE operation=? AND phase='failed'
          AND NOT EXISTS(SELECT 1 FROM lifecycle_orders l WHERE l.node_id=target_node_id AND l.database_id=database_cold_storage.database_id AND l.storage_generation=target_storage_generation AND l.type='superseded' AND l.remove_volume=1)`,
            ).bind(retirement, at, row.operation),
          ]
        : []),
      ...(row.kind === "archive"
        ? [
            env.DB.prepare(
              `UPDATE archive_pins SET released_at=? WHERE operation=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='failed' AND (?=1 OR verification_dispatched_at IS NULL))`,
            ).bind(at, row.operation, row.operation, Number(cleanedUp)),
          ]
        : []),
    ]);
  });
  await Promise.allSettled(
    [
      ...new Set(
        [
          row.source_node_id,
          row.target_node_id,
          row.verification_node_id,
        ].filter((v): v is string => v !== null),
      ),
    ].map((n) => hintNode(env, n)),
  );
}

async function acceptVerification(
  env: Env,
  nodeId: string,
  result: ArchiveVerificationResult,
  now: number,
) {
  const row = await readOperation(env, result.operation);
  if (
    !row ||
    row.kind !== "archive" ||
    row.verification_node_id !== nodeId ||
    row.database_id !== result.database_id ||
    row.source_generation !== result.source_generation ||
    row.source_storage_generation !== result.source_storage_generation ||
    row.inventory_sha256 !== result.inventory_sha256
  )
    return;
  const at = iso(now);
  if (row.phase === "cancelled" || row.phase === "failed") {
    if (result.cleaned_up)
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE database_cold_storage SET verification_receipt_json=?,updated_at=? WHERE operation=? AND phase IN('cancelled','failed')`,
        ).bind(JSON.stringify(result), at, row.operation),
        env.DB.prepare(
          `UPDATE archive_pins SET released_at=? WHERE operation=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase IN('cancelled','failed'))`,
        ).bind(at, row.operation, row.operation),
      ]);
    return;
  }
  if (row.phase !== "verifying") return;
  if (result.status === "failed") {
    // Cleanup failures are retried by the node; the source and its pin remain held.
    if (result.cleaned_up)
      await failColdStorage(env, row, result.reason, now, true);
    return;
  }
  const proof = ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json));
  if (
    result.backup_id !== row.source_backup_id ||
    JSON.stringify(result.end) !== JSON.stringify(proof) ||
    result.system_identifier !== proof.system_identifier ||
    result.timeline <= proof.timeline ||
    Date.parse(result.observed_at) < Date.parse(row.created_at) ||
    Date.parse(result.observed_at) > now + 15_000
  )
    return;
  const inventory = await archiveInventory(
    env,
    row.source_archive_path,
    row.source_backup_id,
  );
  if (inventory.sha256 !== row.inventory_sha256) {
    await failColdStorage(env, row, "archive_changed", now, true);
    return;
  }
  const d = await readDatabase(env, row.database_id);
  if (
    !d ||
    d.deleted_at ||
    d.node_id !== row.source_node_id ||
    d.generation !== row.source_generation ||
    d.storage_generation !== row.source_storage_generation ||
    d.proven_sleep_json !== row.proven_sleep_json ||
    d.desired_state !== "suspended" ||
    d.observed_power !== "hibernated"
  ) {
    await failColdStorage(env, row, "database_changed", now, true);
    return;
  }
  const retired = newOperationId();
  await withAdmissionMutation(env, [d.id], async (mutation) => {
    const g = mutation.guard(d.id);
    const accepted = `EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='retiring')`;
    return mutation.batch([
      env.DB.prepare(
        `INSERT INTO lifecycle_orders(operation,node_id,type,database_id,storage_generation,remove_volume,created_at)
        SELECT ?,c.source_node_id,'superseded',c.database_id,c.source_storage_generation,1,? FROM database_cold_storage c JOIN databases d ON d.id=c.database_id
        WHERE c.operation=? AND c.phase='verifying' AND d.storage_operation_id=c.operation AND d.storage_residency='archiving'
          AND d.generation=c.source_generation AND d.storage_generation=c.source_storage_generation AND d.node_id=c.source_node_id
          AND d.proven_sleep_json=c.proven_sleep_json AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.observed_generation=d.generation AND d.deleted_at IS NULL
          AND EXISTS(SELECT 1 FROM lifecycle_orders l WHERE l.operation=c.operation AND l.result_status='done' AND l.closed_at IS NULL)
          AND EXISTS(SELECT 1 FROM archive_pins p WHERE p.operation=c.operation AND p.archive_path=c.source_archive_path AND p.released_at IS NULL)
          AND NOT EXISTS(SELECT 1 FROM archive_retention_claims r WHERE r.archive_path=c.source_archive_path)
          AND (${g.sql})`,
      ).bind(retired, at, row.operation, ...g.bindings),
      env.DB.prepare(
        `UPDATE database_cold_storage SET phase='retiring',verification_receipt_json=?,retirement_operation=?,updated_at=? WHERE operation=? AND phase='verifying' AND EXISTS(SELECT 1 FROM lifecycle_orders WHERE operation=?)`,
      ).bind(JSON.stringify(result), retired, at, row.operation, retired),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET updated_at=? WHERE id=? AND ${accepted}`,
      ).bind(at, row.operation, row.operation),
    ]);
  });
  await hintNode(env, row.source_node_id).catch(() => 0);
}

/** Native deletion acknowledgment is the only transition that releases the serving assignment. */
async function finishRetirement(env: Env, row: ColdStorageRow, now: number) {
  if (row.phase !== "retiring" || !row.retirement_operation) return;
  const acknowledged = await env.DB.prepare(
    `SELECT 1 FROM lifecycle_orders WHERE operation=? AND node_id=? AND database_id=? AND storage_generation=? AND type='superseded' AND remove_volume=1 AND result_status='done'`,
  )
    .bind(
      row.retirement_operation,
      row.source_node_id,
      row.database_id,
      row.source_storage_generation,
    )
    .first();
  if (!acknowledged) {
    if (
      await env.DB.prepare("SELECT 1 FROM node_losses WHERE node_id=?")
        .bind(row.source_node_id)
        .first()
    ) {
      const changed = await env.DB.prepare(
        `UPDATE databases SET status_message='Source retirement unconfirmed; recovery point retained' WHERE id=? AND storage_operation_id=? AND status_message IS NOT 'Source retirement unconfirmed; recovery point retained'`,
      )
        .bind(row.database_id, row.operation)
        .run();
      if (changed.meta.changes)
        console.warn(
          JSON.stringify({
            event: "cold_storage_source_retirement_unconfirmed",
            database_id: row.database_id,
            operation_id: row.operation,
            node_id: row.source_node_id,
          }),
        );
    }
    return;
  }
  const at = iso(now);
  await withAdmissionMutation(env, [row.database_id], async (mutation) => {
    const g = mutation.guard(row.database_id);
    return mutation.batch([
      env.DB.prepare(
        `UPDATE database_cold_storage SET phase='archived',source_removed_at=?,completed_at=?,updated_at=? WHERE operation=? AND phase='retiring'
        AND EXISTS(SELECT 1 FROM databases d WHERE d.id=database_id AND d.storage_operation_id=? AND d.storage_residency='archiving' AND d.node_id=? AND d.storage_generation=? AND d.deleted_at IS NULL) AND (${g.sql})`,
      ).bind(
        at,
        at,
        at,
        row.operation,
        row.operation,
        row.source_node_id,
        row.source_storage_generation,
        ...g.bindings,
      ),
      env.DB.prepare(
        `UPDATE databases SET storage_residency='archived',node_id=NULL,runtime_json=NULL,status_message=NULL,updated_at=? WHERE id=? AND storage_operation_id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='archived')`,
      ).bind(at, row.database_id, row.operation, row.operation),
      env.DB.prepare(
        `UPDATE lifecycle_orders SET closed_at=? WHERE operation=? AND type='move' AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='archived')`,
      ).bind(at, row.operation, row.operation),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET status=CASE WHEN (SELECT wake_requested FROM database_cold_storage WHERE operation=id)=1 THEN 'running' ELSE 'succeeded' END,updated_at=?,completed_at=CASE WHEN (SELECT wake_requested FROM database_cold_storage WHERE operation=id)=1 THEN NULL ELSE ? END WHERE id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='archived')`,
      ).bind(at, at, row.operation, row.operation),
    ]);
  });
  const current = await readOperation(env, row.operation);
  if (current?.phase === "archived" && current.wake_requested)
    await requestColdStorageWake(env, row.database_id, {
      manualResume: !!current.manual_resume_requested,
      now,
      internalWake: true,
    });
}

async function finishRestore(
  env: Env,
  row: ColdStorageRow,
  report: NodeObservationReport,
  now: number,
) {
  const observed = report.databases.find((d) => d.id === row.database_id);
  if (
    !observed ||
    observed.generation !== row.target_generation ||
    observed.storage_generation !== row.target_storage_generation ||
    observed.operation !== row.operation
  )
    return;
  if (observed.state === "building") {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE database_cold_storage SET updated_at=? WHERE operation=? AND phase='restoring'`,
      ).bind(iso(now), row.operation),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET updated_at=? WHERE id=? AND status='running'`,
      ).bind(iso(now), row.operation),
    ]);
    return;
  }
  if (observed.state === "error") {
    await failColdStorage(env, row, observed.error ?? "build_failed", now);
    return;
  }
  const proof = ProvenSleepRecord.parse(JSON.parse(row.proven_sleep_json));
  const promoted =
    observed.backup !== null &&
    observed.backup.timeline > proof.timeline &&
    (observed.state === "ready" ||
      (observed.state === "asleep" &&
        observed.proven_sleep !== null &&
        observed.proven_sleep.timeline > proof.timeline &&
        observed.proven_sleep.system_identifier === proof.system_identifier));
  if (!promoted) return;
  const d = await readDatabase(env, row.database_id);
  if (
    !d ||
    d.deleted_at ||
    d.generation !== row.source_generation ||
    d.storage_operation_id !== row.operation ||
    d.desired_state !== "running"
  ) {
    await failColdStorage(env, row, "database_changed", now);
    return;
  }
  const capable = coldStorageNativeGuard(
      env,
      { nodeId: row.target_node_id! },
      now,
    ),
    at = iso(now);
  await withAdmissionMutation(env, [d.id], async (mutation) => {
    const g = mutation.guard(d.id);
    return mutation.batch([
      env.DB.prepare(
        `UPDATE databases SET node_id=?,generation=?,storage_generation=?,archive_path=?,storage_residency='local',sleep_since=NULL,
        observed_state='provisioning',observed_power='hibernated',runtime_json=NULL,status_message=NULL,placed_at=?,updated_at=?
        WHERE id=? AND generation=? AND storage_operation_id=? AND storage_residency='restoring' AND desired_state='running' AND deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM projects p WHERE p.id=databases.project_id AND p.deleted_at IS NULL)
        AND (${capable.sql}) AND (${g.sql})`,
      ).bind(
        row.target_node_id,
        row.target_generation,
        row.target_storage_generation,
        row.target_archive_path,
        at,
        at,
        d.id,
        row.source_generation,
        row.operation,
        ...capable.bindings,
        ...g.bindings,
      ),
      env.DB.prepare(
        `UPDATE database_cold_storage SET phase='succeeded',completed_at=?,updated_at=? WHERE operation=? AND phase='restoring' AND changes()=1`,
      ).bind(at, at, row.operation),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET status='succeeded',updated_at=?,completed_at=? WHERE id=? AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='succeeded')`,
      ).bind(at, at, row.operation, row.operation),
      env.DB.prepare(
        `UPDATE cold_storage_operations SET status='succeeded',updated_at=?,completed_at=? WHERE id=? AND status='running'
        AND EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.operation=? AND c.phase='succeeded' AND c.source_operation=cold_storage_operations.id)`,
      ).bind(at, at, row.source_operation, row.operation),
      env.DB.prepare(
        `UPDATE archive_pins SET released_at=? WHERE database_id=? AND archive_path=? AND released_at IS NULL
        AND operation IN(?,?)
        AND EXISTS(SELECT 1 FROM database_cold_storage WHERE operation=? AND phase='succeeded')`,
      ).bind(
        at,
        d.id,
        row.source_archive_path,
        row.operation,
        row.source_operation,
        row.operation,
      ),
    ]);
  });
  await hintNode(env, row.target_node_id!).catch(() => 0);
}

export async function acknowledgeColdStorageCleanup(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now = Date.now(),
) {
  for (const result of report.archive_verifications ?? []) {
    const row = await readOperation(env, result.operation);
    if (row && (row.phase === "cancelled" || row.phase === "failed"))
      await acceptVerification(env, nodeId, result, now);
  }
}

export async function progressColdStorage(
  env: Env,
  nodeId: string,
  report: NodeObservationReport,
  now = Date.now(),
) {
  for (const raw of report.archive_verifications ?? [])
    await acceptVerification(
      env,
      nodeId,
      ArchiveVerificationResult.parse(raw),
      now,
    );
  const rows = (
    await env.DB.prepare(
      `${coldSelect} WHERE (phase='retiring' AND source_node_id=?) OR (phase='restoring' AND target_node_id=?) OR (phase='verifying' AND source_node_id=?)`,
    )
      .bind(nodeId, nodeId, nodeId)
      .all<ColdStorageRow>()
  ).results;
  for (const row of rows) {
    if (row.phase === "retiring") await finishRetirement(env, row, now);
    else if (row.phase === "restoring")
      await finishRestore(env, row, report, now);
    else {
      const hold = await env.DB.prepare(
        "SELECT result_status status,result_reason reason FROM lifecycle_orders WHERE operation=? AND node_id=?",
      )
        .bind(row.operation, nodeId)
        .first<{ status: string | null; reason: string | null }>();
      if (hold?.status === "failed")
        await failColdStorage(
          env,
          row,
          hold.reason ?? "sleep_refused",
          now,
          true,
        );
      else if (hold?.status === "done" && row.verification_node_id)
        await hintNode(env, row.verification_node_id).catch(() => 0);
    }
  }
}

/** The cron always repairs/restarts recovery, even while new automatic archival is disabled. */
export async function runColdStorageCron(
  env: Env,
  now = Date.now(),
): Promise<{ claimed: number; pending: number }> {
  await env.DB.prepare(
    `UPDATE archive_pins SET released_at=? WHERE released_at IS NULL AND EXISTS(
    SELECT 1 FROM database_cold_storage c WHERE c.operation=archive_pins.operation AND c.kind='rehydrate' AND c.phase='failed' AND ${retiredTargetSql("c")})`,
  )
    .bind(iso(now))
    .run();
  await env.DB.prepare(
    `UPDATE archive_pins SET released_at=? WHERE released_at IS NULL AND EXISTS(
    SELECT 1 FROM database_cold_storage c WHERE c.operation=archive_pins.operation AND c.kind='archive' AND c.phase IN('failed','cancelled')
      AND (c.verification_dispatched_at IS NULL OR ${fencedNodeSql("c.verification_node_id")}))`,
  )
    .bind(iso(now))
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO cold_storage_cursors(name,cursor) VALUES('cold_storage_operations',NULL)",
  ).run();
  const cursor = await env.DB.prepare(
    "SELECT cursor FROM cold_storage_cursors WHERE name='cold_storage_operations'",
  ).first<string | null>("cursor");
  const rows = (
    await env.DB.prepare(
      `${coldSelect} c WHERE (phase IN(${activePhases}) OR (phase='archived' AND wake_requested=1 AND EXISTS(SELECT 1 FROM databases d WHERE d.id=c.database_id AND d.storage_operation_id=c.operation AND d.storage_residency='archived' AND d.deleted_at IS NULL))) AND operation>? ORDER BY operation LIMIT 50`,
    )
      .bind(cursor ?? "")
      .all<ColdStorageRow>()
  ).results;
  for (const row of rows) {
    const lost = await env.DB.prepare(
      `SELECT 1 FROM node_losses WHERE node_id IN (?,?)`,
    )
      .bind(
        row.phase === "verifying" ? row.source_node_id : row.target_node_id,
        row.phase === "verifying" ? row.verification_node_id : null,
      )
      .first();
    if (lost && (row.phase === "verifying" || row.phase === "restoring")) {
      await failColdStorage(env, row, "node_lost", now);
      continue;
    }

    if (row.phase === "archived")
      await requestColdStorageWake(env, row.database_id, {
        manualResume: !!row.manual_resume_requested,
        internalWake: true,
        now,
      });
    else if (row.phase === "waiting_capacity")
      await placeColdStorageRestore(env, row.operation, now);
    else if (row.phase === "retiring") await finishRetirement(env, row, now);
    else if (
      row.phase === "restoring" &&
      (now - Date.parse(row.updated_at) > 20 * 60_000 ||
        now - Date.parse(row.target_started_at ?? row.created_at) >
          24 * 3_600_000)
    )
      await failColdStorage(env, row, "operation_timeout", now);
    else if (row.phase === "verifying") {
      if (
        now - Date.parse(row.updated_at) > 20 * 60_000 ||
        now - Date.parse(row.created_at) > 24 * 3_600_000
      ) {
        await failColdStorage(env, row, "operation_timeout", now);
        continue;
      }
      const d = await readDatabase(env, row.database_id);
      if (
        !d ||
        d.deleted_at ||
        d.generation !== row.source_generation ||
        d.storage_generation !== row.source_storage_generation ||
        d.desired_state !== "suspended" ||
        d.proven_sleep_json !== row.proven_sleep_json
      )
        await failColdStorage(env, row, "database_changed", now);
      else
        await Promise.allSettled(
          [
            ...new Set(
              [row.source_node_id, row.verification_node_id].filter(
                (n): n is string => n !== null,
              ),
            ),
          ].map((n) => hintNode(env, n)),
        );
    }
  }
  await env.DB.prepare(
    "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_operations' AND cursor IS ?",
  )
    .bind(rows.length === 50 ? rows.at(-1)!.operation : null, cursor)
    .run();
  let claimed = 0;
  if (env.COLD_STORAGE_ARCHIVAL_ENABLED === "true") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO cold_storage_cursors(name,cursor) VALUES('cold_storage_due',NULL)",
    ).run();
    const dueCursor = await env.DB.prepare(
      "SELECT cursor FROM cold_storage_cursors WHERE name='cold_storage_due'",
    ).first<string | null>("cursor");
    const due = (
      await env.DB.prepare(
        `SELECT d.id FROM databases d WHERE d.id>? AND d.storage_residency='local' AND d.sleep_since<? AND d.deleted_at IS NULL
      AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.observed_generation=d.generation
      AND NOT EXISTS(SELECT 1 FROM database_cold_storage c WHERE c.region_id=d.region_id AND (c.phase='verifying' OR (c.kind='archive' AND c.phase IN('cancelled','failed') AND c.verification_dispatched_at IS NOT NULL AND EXISTS(SELECT 1 FROM archive_pins pin WHERE pin.operation=c.operation AND pin.released_at IS NULL)))) ORDER BY d.id LIMIT 20`,
      )
        .bind(dueCursor ?? "", iso(now - COLD_STORAGE_SLEEP_MS))
        .all<{ id: string }>()
    ).results;
    for (const d of due) {
      try {
        if (await startColdStorageArchive(env, d.id, now)) claimed++;
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "cold_storage_archive_deferred",
            database_id: d.id,
            error_code:
              error instanceof ApiError ? error.code : "archive_unavailable",
          }),
        );
      }
    }
    await env.DB.prepare(
      "UPDATE cold_storage_cursors SET cursor=? WHERE name='cold_storage_due' AND cursor IS ?",
    )
      .bind(due.length === 20 ? due.at(-1)!.id : null, dueCursor)
      .run();
  }
  try {
    await emitColdStorageMetrics(env, now);
  } catch {
    console.warn(JSON.stringify({ event: "cold_storage_metrics_unavailable" }));
  }
  console.log(
    JSON.stringify({
      event: "cold_storage_cron",
      claimed,
      processed: rows.length,
    }),
  );
  return { claimed, pending: rows.length };
}
