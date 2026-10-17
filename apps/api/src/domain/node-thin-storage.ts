// SPDX-License-Identifier: Apache-2.0
import { NodeThinStorageAuthority, ThinStorageProfile } from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { thinPoolNodeRoomSql } from "./storage-capacity.ts";

export interface NodeThinStorageRow {
  node_id: string;
  node_uid: string;
  volume_group_uuid: string;
  profile_revision: number;
  profile_sha256: string;
  profile_json: string;
  allow_new_databases: number;
  authority_revision: number;
  authority_json: string | null;
  authority_received_at: string | null;
  status: "selected" | "ready";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A node release's thin storage gate: whether the node has thin storage selected, and whether that
 * storage is observed, with no error and a physical sample of the node at most 120 s old.
 */
export async function thinStorageObservation(
  db: D1Database,
  nodeId: string,
): Promise<{ selected: boolean; observed: boolean }> {
  const row = await db
    .prepare(
      `SELECT t.error_code IS NULL AND EXISTS(SELECT 1 FROM node_storage_observations o WHERE o.node_id=t.node_id AND o.node_uid=t.node_uid
        AND julianday(o.observed_at)>=julianday('now','-120 seconds') AND julianday(o.observed_at)<=julianday('now','+5 seconds')) observed
      FROM node_thin_storage t WHERE t.node_id=?`,
    )
    .bind(nodeId)
    .first<{ observed: number }>();
  return { selected: row !== null, observed: row?.observed === 1 };
}

/**
 * Every thin node of a region with an identity proof, as the desired page serves it: the last
 * accepted proof of the node and its current profile, however old, and the node's room now as its
 * `write_allowed`. The controller needs the identities to bind volumes and to judge a start;
 * whatever needs a recent read (a volume's absence, a binding) checks the proof's own times. Room
 * comes only from the node's minute physical sample (`thinPoolNodeRoomSql`). A node without an
 * accepted proof has no entry.
 */
export async function desiredRegionStorageNodes(
  env: Pick<Env, "DB">,
  regionId: string,
): Promise<NodeThinStorageAuthority[]> {
  const rows = await env.DB.prepare(
    `SELECT t.*,n.k8s_node_name,n.node_uid current_node_uid,n.ready,n.lost_at,
      EXISTS(SELECT 1 FROM node_storage_observations o WHERE o.node_id=t.node_id AND o.node_uid=t.node_uid AND ${thinPoolNodeRoomSql()}) room
      FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE n.region_id=? ORDER BY n.id`,
  )
    .bind(regionId)
    .all<
      NodeThinStorageRow & {
        k8s_node_name: string;
        current_node_uid: string | null;
        ready: number;
        lost_at: string | null;
        room: number;
      }
    >();
  return rows.results.flatMap((row) => {
    const profile = ThinStorageProfile.parse(JSON.parse(row.profile_json)),
      proof = NodeThinStorageAuthority.safeParse(
        row.authority_json ? JSON.parse(row.authority_json) : null,
      );
    return proof.success &&
      row.ready === 1 &&
      row.lost_at === null &&
      row.current_node_uid === row.node_uid &&
      proof.data.node_id === row.node_id &&
      proof.data.name === row.k8s_node_name &&
      proof.data.node_uid === row.node_uid &&
      proof.data.volume_group_uuid === row.volume_group_uuid &&
      proof.data.profile_revision === row.profile_revision &&
      proof.data.profile_sha256 === row.profile_sha256 &&
      proof.data.revision === row.authority_revision &&
      proof.data.driver_image === profile.driver_image
      ? [{ ...proof.data, write_allowed: row.room === 1 }]
      : [];
  });
}
