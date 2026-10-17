// SPDX-License-Identifier: Apache-2.0
//
// What a node reports about itself, stored the way placement and the capacity alerts read it
// (ULTRA plan 4.8-4.10): its samples, from which the 30-minute averages are taken, and the newest
// report of its thin volumes.
import {
  NodeSample,
  NodeVolumeReport,
  type NodeSample as NodeSampleReport,
  type NodeVolumeReport as NodeVolumeReportBody,
} from "@pgcf/contracts";
import { AVERAGE_WINDOW_SECONDS, PEAK_WINDOW_MS } from "./placement.ts";

/** A report may be dated this far ahead of Cloudflare's clock. */
const CLOCK_SKEW_MS = 5000;
/** Volumes stored in one statement. */
const VOLUME_CHUNK = 200;

/**
 * Stores a node's sample, replacing one of the same instant, and keeps the history the peak needs:
 * seven days and the 30 minutes before them. `capacityRefusals` is the number of wakes the node
 * refused for awake capacity since its previous row. A sample of a node that is lost, unknown or
 * dated ahead of the clock is not stored (false). It also moves the node's last observation, which
 * the stale-node alert and the operator view read.
 */
export async function recordNodeSample(
  db: D1Database,
  nodeId: string,
  report: NodeSampleReport,
  capacityRefusals = 0,
  now = Date.now(),
): Promise<boolean> {
  const sample = NodeSample.parse(report);
  if (Date.parse(sample.observed_at) > now + CLOCK_SKEW_MS) return false;
  const pool = sample.pool;
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR REPLACE INTO node_samples(node_id,observed_at,memory_total_bytes,memory_available_bytes,cpu_cores,cpu_busy_millicores,
        pool_data_total_bytes,pool_data_used_bytes,pool_metadata_total_bytes,pool_metadata_used_bytes,pool_nominal_bytes,room,capacity_refusals)
      SELECT id,?,?,?,?,?,?,?,?,?,?,?,? FROM nodes WHERE id=? AND lost_at IS NULL`,
      )
      .bind(
        sample.observed_at,
        sample.memory.total_bytes,
        sample.memory.available_bytes,
        sample.cpu.cores,
        sample.cpu.busy_millicores,
        pool?.data_total_bytes ?? null,
        pool?.data_used_bytes ?? null,
        pool?.metadata_total_bytes ?? null,
        pool?.metadata_used_bytes ?? null,
        pool?.nominal_bytes ?? null,
        Number(sample.room),
        capacityRefusals,
        nodeId,
      ),
    db
      .prepare(
        "DELETE FROM node_samples WHERE node_id=? AND observed_at<? AND EXISTS(SELECT 1 FROM nodes WHERE id=? AND lost_at IS NULL)",
      )
      .bind(
        nodeId,
        new Date(
          now - PEAK_WINDOW_MS - AVERAGE_WINDOW_SECONDS * 1000,
        ).toISOString(),
        nodeId,
      ),
    db
      .prepare(
        "UPDATE nodes SET last_observed_at=? WHERE id=? AND lost_at IS NULL AND (last_observed_at IS NULL OR last_observed_at<?)",
      )
      .bind(sample.observed_at, nodeId, sample.observed_at),
  ]);
  return results[0]!.meta.changes === 1;
}

/**
 * Replaces the volumes of a node with its newest report, the filesystem figures staying empty
 * while a volume is not mounted. A report older than what is stored, dated ahead of the clock, or
 * of a node that is lost or unknown changes nothing (false).
 */
export async function recordNodeVolumes(
  db: D1Database,
  nodeId: string,
  input: NodeVolumeReportBody,
  now = Date.now(),
): Promise<boolean> {
  const report = NodeVolumeReport.parse(input);
  if (Date.parse(report.observed_at) > now + CLOCK_SKEW_MS) return false;
  const known = await db
    .prepare(
      `SELECT (SELECT MAX(observed_at) FROM node_volumes WHERE node_id=n.id) newest FROM nodes n
      WHERE n.id=? AND n.lost_at IS NULL`,
    )
    .bind(nodeId)
    .first<{ newest: string | null }>();
  if (!known || (known.newest !== null && known.newest > report.observed_at))
    return false;
  const statements = [
    db
      .prepare(
        "DELETE FROM node_volumes WHERE node_id=? AND NOT EXISTS(SELECT 1 FROM node_volumes WHERE node_id=? AND observed_at>?)",
      )
      .bind(nodeId, nodeId, report.observed_at),
  ];
  for (let i = 0; i < report.volumes.length; i += VOLUME_CHUNK)
    statements.push(
      db
        .prepare(
          `INSERT INTO node_volumes(node_id,database_id,storage_generation,observed_at,fs_total_bytes,fs_used_bytes,inodes_total,inodes_used)
        SELECT n.id,json_extract(v.value,'$.database'),json_extract(v.value,'$.storage_generation'),?,
          json_extract(v.value,'$.filesystem.total_bytes'),json_extract(v.value,'$.filesystem.used_bytes'),
          json_extract(v.value,'$.filesystem.inodes_total'),json_extract(v.value,'$.filesystem.inodes_used')
        FROM nodes n,json_each(?) v WHERE n.id=? AND n.lost_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM node_volumes WHERE node_id=n.id AND observed_at>?)`,
        )
        .bind(
          report.observed_at,
          JSON.stringify(report.volumes.slice(i, i + VOLUME_CHUNK)),
          nodeId,
          report.observed_at,
        ),
    );
  await db.batch(statements);
  return true;
}
