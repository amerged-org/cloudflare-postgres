// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { coldSnapshotPrefix } from "@pgcf/contracts";
import { PROOF } from "./lifecycle-fixture.ts";

/** Valid durable snapshot metadata for control-plane retention/metrics tests. These tests do
 * not substitute for native clean-shutdown capture, byte verification or live recovery. */
export async function insertSnapshotArchive(input: {
  operation: string;
  id: string;
  project: string;
  region: string;
  node: string;
  path: string;
  at: string;
  phase?: "capturing" | "verifying" | "archived" | "failed" | "cancelled";
  sealed?: boolean;
  totalBytes?: number;
  manifestBytes?: number;
  chunkCount?: number;
}) {
  const phase = input.phase ?? "archived",
    sealed = input.sealed ?? ["verifying", "archived"].includes(phase);
  const prefix = coldSnapshotPrefix(input.region, input.id, 1, input.operation);
  await env.DB.prepare(
    `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,phase,source_node_id,
    source_generation,source_storage_generation,source_archive_path,proven_sleep_json,snapshot_prefix,
    snapshot_manifest_sha256,snapshot_manifest_bytes,snapshot_total_bytes,snapshot_file_count,snapshot_chunk_count,
    snapshot_manifest_declared_at,snapshot_sealed_at,snapshot_seal_checked_chunks,verification_receipt_json,source_removed_at,created_at,updated_at,completed_at)
    VALUES(?,'archive',?,?,?,?,?,1,1,?,?,?, ?,?,?,2,?, ?,?,?, ?,?,?,?,?)`,
  )
    .bind(
      input.operation,
      input.id,
      input.project,
      input.region,
      phase,
      input.node,
      input.path,
      JSON.stringify(PROOF),
      prefix,
      "a".repeat(64),
      input.manifestBytes ?? 17,
      input.totalBytes ?? 9,
      input.chunkCount ?? 1,
      input.at,
      sealed ? input.at : null,
      sealed ? (input.chunkCount ?? 1) : 0,
      phase === "archived" ? "{}" : null,
      phase === "archived" ? input.at : null,
      input.at,
      input.at,
      ["archived", "failed", "cancelled"].includes(phase) ? input.at : null,
    )
    .run();
  return prefix;
}

export async function insertSnapshotRehydrate(input: {
  operation: string;
  source: string;
  node: string;
  target: string;
  at: string;
  phase:
    "waiting_capacity" | "restoring" | "activating" | "succeeded" | "failed";
}) {
  await env.DB.prepare(
    `INSERT INTO database_cold_storage(operation,kind,database_id,project_id,region_id,source_operation,phase,
    source_node_id,source_generation,source_storage_generation,source_archive_path,proven_sleep_json,snapshot_prefix,
    snapshot_manifest_sha256,snapshot_manifest_bytes,snapshot_total_bytes,snapshot_file_count,snapshot_chunk_count,
    snapshot_manifest_declared_at,snapshot_sealed_at,snapshot_seal_checked_chunks,
    target_node_id,target_generation,target_serving_generation,target_storage_generation,target_archive_path,failure,created_at,updated_at,completed_at)
    SELECT ?,'rehydrate',database_id,project_id,region_id,operation,?,source_node_id,source_generation,source_storage_generation,
      source_archive_path,proven_sleep_json,snapshot_prefix,snapshot_manifest_sha256,snapshot_manifest_bytes,snapshot_total_bytes,
      snapshot_file_count,snapshot_chunk_count,snapshot_manifest_declared_at,snapshot_sealed_at,snapshot_seal_checked_chunks,
      ?,2,?,2,?,?, ?,?,? FROM database_cold_storage WHERE operation=?`,
  )
    .bind(
      input.operation,
      input.phase,
      input.node,
      ["activating", "succeeded"].includes(input.phase) ? 3 : null,
      input.target,
      input.phase === "failed" ? "build_failed" : null,
      input.at,
      input.at,
      ["succeeded", "failed"].includes(input.phase) ? input.at : null,
      input.source,
    )
    .run();
}
