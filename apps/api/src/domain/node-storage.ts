// SPDX-License-Identifier: Apache-2.0
import { NodeStorageSample, type NodeObservation } from "@pgcf/contracts";

const freshnessMs = 120_000;
/** Fresh physical measurements never authorize thin provisioning or remove thick reservations. */
export async function recordNodeStorageObservation(
  db: D1Database,
  regionId: string,
  node: NodeObservation,
  raw: NodeStorageSample,
  receivedAt = Date.now(),
): Promise<boolean> {
  const parsed = NodeStorageSample.safeParse(raw);
  if (
    !parsed.success ||
    !node.node_id ||
    !node.node_uid ||
    !node.provider_instance_id ||
    parsed.data.node_uid !== node.node_uid ||
    !node.ready
  )
    return false;
  const sample = parsed.data,
    at = Date.parse(sample.observed_at);
  if (
    !Number.isSafeInteger(receivedAt) ||
    at < receivedAt - freshnessMs ||
    at > receivedAt + 5000
  )
    return false;
  const result = await db
    .prepare(
      `INSERT INTO node_storage_observations(node_id,node_uid,observed_at,received_at,physical_json)
    SELECT id,node_uid,?,?,? FROM nodes WHERE id=? AND region_id=? AND k8s_node_name=? AND provider_instance_id=? AND node_uid=? AND lost_at IS NULL AND ready=1
    ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,observed_at=excluded.observed_at,received_at=excluded.received_at,physical_json=excluded.physical_json
    WHERE excluded.observed_at>node_storage_observations.observed_at OR excluded.node_uid<>node_storage_observations.node_uid`,
    )
    .bind(
      sample.observed_at,
      new Date(receivedAt).toISOString(),
      sample.physical === null ? null : JSON.stringify(sample.physical),
      node.node_id,
      regionId,
      node.name,
      node.provider_instance_id,
      node.node_uid,
    )
    .run();
  return result.meta.changes === 1;
}

export async function readNodeStorageObservation(
  db: D1Database,
  regionId: string,
  nodeId: string,
  now = Date.now(),
): Promise<NodeStorageSample | null> {
  const row = await db
    .prepare(
      `SELECT o.node_uid,o.observed_at,o.physical_json FROM node_storage_observations o JOIN nodes n ON n.id=o.node_id AND n.node_uid=o.node_uid
    WHERE n.id=? AND n.region_id=? AND n.ready=1 AND n.lost_at IS NULL AND o.observed_at>=? AND o.observed_at<=?`,
    )
    .bind(
      nodeId,
      regionId,
      new Date(now - freshnessMs).toISOString(),
      new Date(now + 5000).toISOString(),
    )
    .first<{
      node_uid: string;
      observed_at: string;
      physical_json: string | null;
    }>();
  if (!row) return null;
  const parsed = NodeStorageSample.safeParse({
    node_uid: row.node_uid,
    observed_at: row.observed_at,
    physical: row.physical_json === null ? null : JSON.parse(row.physical_json),
  });
  return parsed.success ? parsed.data : null;
}
