// SPDX-License-Identifier: Apache-2.0
import { NodeThinStorageAuthority, thinStorageClass } from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  loadCurrentRegionMaterialReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import { loadNodeHostConfiguration } from "./node-host-configuration.ts";
import {
  readCurrentNodeThinStorage,
  type NodeThinStorageRow,
} from "./node-thin-storage.ts";
import { prepareThinStorageLease } from "./node-thin-storage-execution.ts";
const failed = (): never => {
  throw new ApiError(
    "conflict",
    "Existing physical storage material refresh changed authority",
  );
};
/** Existing selection only; preserves counters, actions, class, UUIDs and every database binding. */
export async function refreshNodeThinStorageMaterial(
  env: Env,
  nodeId: string,
): Promise<{ selected: boolean; qualified: boolean }> {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.node_uid actual_uid,n.ready,n.lost_at,a.release_id FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id JOIN fleet_node_releases a ON a.node_id=n.id AND a.node_uid=n.node_uid JOIN fleet_region_releases f ON f.region_id=n.region_id AND f.release_id=a.release_id WHERE t.node_id=?`,
  )
    .bind(nodeId)
    .first<
      NodeThinStorageRow & {
        region_id: string;
        actual_uid: string;
        ready: number;
        lost_at: string | null;
        release_id: string;
      }
    >();
  if (!row) return { selected: false, qualified: false };
  if (
    row.node_uid !== row.actual_uid ||
    row.ready !== 1 ||
    row.lost_at !== null ||
    row.error_code
  )
    return failed();
  // A finite ordinary old read is allowed to finish/expire. Current material already stops renewal.
  if (row.action_json) return { selected: true, qualified: false };
  const retained = NodeThinStorageAuthority.safeParse(
    row.authority_json ? JSON.parse(row.authority_json) : null,
  );
  if (
    !retained.success ||
    retained.data.node_uid !== row.node_uid ||
    retained.data.cluster_uid !== row.cluster_uid ||
    retained.data.volume_group_uuid !== row.volume_group_uuid ||
    retained.data.storage_class !== thinStorageClass(row.profile_sha256)
  )
    return { selected: true, qualified: false };
  const ref = await loadCurrentRegionMaterialReference(
      env.DB,
      row.region_id,
      "join_bundle",
    ),
    bundle = await loadRegionJoinBundle(env.DB, env.CREDENTIAL_KEYS, ref);
  if (
    ref.revision < row.material_revision ||
    bundle.kube_system_uid !== row.cluster_uid
  )
    return failed();
  const host = await env.DB.prepare(
    `SELECT h.revision,h.sha256 FROM node_host_configurations h JOIN fleet_patch_operations p ON p.node_id=h.node_id AND p.node_uid=h.node_uid WHERE h.node_id=? AND h.node_uid=? AND h.cluster_uid=? AND h.material_revision=? AND h.release_id=? AND p.release_id=h.release_id AND p.cluster_uid=h.cluster_uid AND p.material_revision=h.material_revision AND p.host_configuration_revision=h.revision AND p.host_configuration_sha256=h.sha256 AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL ORDER BY p.updated_at DESC LIMIT 1`,
  )
    .bind(nodeId, row.node_uid, row.cluster_uid, ref.revision, row.release_id)
    .first<{ revision: number; sha256: string }>();
  if (!host) return { selected: true, qualified: false };
  await loadNodeHostConfiguration(env, {
    node_id: nodeId,
    node_uid: row.node_uid,
    cluster_uid: row.cluster_uid,
    material_revision: ref.revision,
    revision: host.revision,
    sha256: host.sha256,
  });
  const admitted = await readCurrentNodeThinStorage(env, nodeId);
  if (
    ref.revision === row.material_revision &&
    admitted?.row.status === "ready" &&
    admitted.authority?.write_allowed
  )
    return { selected: true, qualified: true };
  if (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now())
    return { selected: true, qualified: false };
  if (ref.revision !== row.material_revision) {
    const updated = await env.DB.prepare(
      `UPDATE node_thin_storage SET material_revision=?,status='qualifying' WHERE (node_id=? AND node_uid=? AND volume_group_uuid=? AND profile_revision=? AND profile_sha256=? AND material_revision=? AND lease_revision=?) AND action_json IS NULL AND (lease_expires_at IS NULL OR julianday(lease_expires_at)<=julianday('now')) AND EXISTS(SELECT 1 FROM regions r JOIN nodes n ON n.region_id=r.id WHERE n.id=node_thin_storage.node_id AND n.node_uid=node_thin_storage.node_uid AND n.lost_at IS NULL AND r.bootstrap_material_revision=?)`,
    )
      .bind(
        ref.revision,
        nodeId,
        row.node_uid,
        row.volume_group_uuid,
        row.profile_revision,
        row.profile_sha256,
        row.material_revision,
        row.lease_revision,
        ref.revision,
      )
      .run();
    if (updated.meta.changes !== 1) return failed();
  }
  let current = await readCurrentNodeThinStorage(env, nodeId);
  if (current?.authority?.write_allowed && current.row.status === "ready")
    return { selected: true, qualified: true };
  const input = await prepareThinStorageLease(env, nodeId, false);
  if (input)
    await env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-storage:${nodeId}`),
    ).thinStorage(nodeId);
  current = await readCurrentNodeThinStorage(env, nodeId);
  return {
    selected: true,
    qualified: Boolean(
      current?.row.material_revision === ref.revision &&
      current.row.status === "ready" &&
      current.authority?.write_allowed &&
      current.authority.data_accounting_complete,
    ),
  };
}
