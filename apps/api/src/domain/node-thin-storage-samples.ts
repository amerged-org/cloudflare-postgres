// SPDX-License-Identifier: Apache-2.0
// Fast headroom samples renew thin write authority (docs/architecture/thin-authority-renewal.md,
// sections 4.3 and 4.4). Cloudflare alone decides; the controller only supplies the reading.
import {
  NodeId,
  NodeThinStorageAuthority,
  thinStorageInventory,
  thinStorageSamplePeriodMilliseconds,
} from "@pgcf/contracts";
import {
  NodeStorageHeadroomResponse,
  NodeStorageHeadroomSample,
  ThinStorageSampleTarget,
} from "@pgcf/contracts/node-thin-storage";
import { ApiError } from "../app.ts";
import type { ApiContext, Env } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import {
  qualifiedThinStorageSql,
  readCurrentNodeThinStorage,
  storageWriteAuthorityForDatabase,
} from "./node-thin-storage.ts";
import {
  composeThinStorageAuthority,
  minimumHeadroom,
  nextThinStartupBytes,
  requestThinStorageTurn,
  storageHoldSnapshotSql,
  storageHolds,
  thinPoolDataGrowthNeeded,
  thinStorageAuthoritySql,
  thinStorageWriteAllowed,
} from "./node-thin-storage-execution.ts";
import type { DatabaseRow } from "./rows.ts";

const iso = (ms: number) => new Date(ms).toISOString();
/** 128 random bits; Cloudflare's issue time is the earliest start of the scrape that answers it. */
function sampleNonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const unsampled = (): never => {
  throw new ApiError("not_found", "No thin storage is sampled on this node");
};

/** Selected thin nodes that are not blocked by an identity or qualification failure. */
export async function desiredRegionStorageSamples(
  env: Pick<Env, "DB">,
  regionId: string,
): Promise<ThinStorageSampleTarget[]> {
  const rows = await env.DB.prepare(
    `SELECT t.node_id,n.k8s_node_name name,t.node_uid,json_extract(t.profile_json,'$.guard_seconds') guard_seconds
    FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id AND n.node_uid=t.node_uid
    WHERE n.region_id=? AND n.ready=1 AND n.lost_at IS NULL AND t.error_code IS NULL AND t.status IN('ready','blocked')
    ORDER BY t.node_id`,
  )
    .bind(regionId)
    .all<{
      node_id: string;
      name: string;
      node_uid: string;
      guard_seconds: number;
    }>();
  return rows.results.map((row) =>
    ThinStorageSampleTarget.parse({
      node_id: row.node_id,
      name: row.name,
      node_uid: row.node_uid,
      period_milliseconds: thinStorageSamplePeriodMilliseconds(
        row.guard_seconds,
      ),
      qualification_run: null,
    }),
  );
}

/** Every refusal renews nothing and hands out a fresh nonce. Except for a stale nonce, it also asks
 * for an identity turn at once, since only a new identity proof can resolve it. */
async function refuseSample(
  env: Env,
  nodeId: string,
  nodeUid: string,
  period: number,
  reason: string,
  turn: boolean,
): Promise<NodeStorageHeadroomResponse> {
  const nonce = sampleNonce();
  await env.DB.prepare(
    "UPDATE node_thin_storage SET sample_nonce=?,sample_nonce_issued_at=? WHERE node_id=? AND node_uid=?",
  )
    .bind(nonce, iso(Date.now()), nodeId, nodeUid)
    .run();
  if (turn) {
    console.warn(
      JSON.stringify({
        event: "thin_storage_sample_refused",
        node_id: nodeId,
        reason,
      }),
    );
    await requestThinStorageTurn(env, nodeId).catch(() => undefined);
  }
  return {
    accepted: false,
    reason,
    nonce,
    period_milliseconds: period,
    authority: null,
    tokens: [],
  };
}

/** One evaluation of a product sample; "conflict" when a concurrent write won the compare-and-set. */
async function productSample(
  env: Env,
  nodeId: string,
  body: NodeStorageHeadroomSample,
): Promise<NodeStorageHeadroomResponse | "conflict"> {
  const now = Date.now(),
    current = await readCurrentNodeThinStorage(env, nodeId, now);
  if (!current) return unsampled();
  const { row, profile } = current,
    guard = profile.guard_seconds,
    period = thinStorageSamplePeriodMilliseconds(guard),
    refuse = (reason: string, turn = true) =>
      refuseSample(env, nodeId, row.node_uid, period, reason, turn);
  const issued =
    row.sample_nonce_issued_at === null
      ? Number.NaN
      : Date.parse(row.sample_nonce_issued_at);
  // Used once, bound to this node and UID, and no older than guard/2 at receipt.
  if (
    body.nonce === null ||
    body.nonce !== row.sample_nonce ||
    !(now - issued <= guard * 500)
  )
    return refuse("thin_storage_sample_nonce_invalid", false);
  if (
    row.ready !== 1 ||
    row.lost_at !== null ||
    row.current_node_uid !== row.node_uid ||
    row.error_code !== null ||
    (row.status !== "ready" && row.status !== "blocked") ||
    row.current_qualified !== 1
  )
    return refuse("thin_storage_sample_node_unqualified");
  const parsed = NodeThinStorageAuthority.safeParse(
    row.authority_json ? JSON.parse(row.authority_json) : null,
  );
  const identity = parsed.success ? parsed.data : null,
    inventory = identity ? thinStorageInventory(identity) : null,
    known = identity?.physical.thin_pool;
  if (
    !identity ||
    !inventory ||
    !known ||
    identity.pool_uuid === null ||
    identity.revision !== row.authority_revision ||
    identity.node_id !== nodeId ||
    identity.name !== row.k8s_node_name ||
    identity.node_uid !== row.node_uid ||
    identity.cluster_uid !== row.cluster_uid ||
    identity.volume_group_uuid !== row.volume_group_uuid ||
    identity.profile_revision !== row.profile_revision ||
    identity.profile_sha256 !== row.profile_sha256 ||
    identity.driver_image !== row.qualified_driver_image ||
    identity.driver_image !== profile.driver_image ||
    inventory.expires_at <= now
  )
    return refuse("thin_storage_sample_identity_unavailable");
  const boot = row.qualification_json
      ? (JSON.parse(row.qualification_json) as { boot_id?: unknown }).boot_id
      : undefined,
    witnesses = body.witnesses;
  if (
    body.node_uid !== identity.node_uid ||
    witnesses.cluster_uid !== identity.cluster_uid ||
    witnesses.boot_id !== boot ||
    witnesses.volume_group_uuid !== identity.volume_group_uuid ||
    witnesses.driver_pod_uid !== identity.driver_pod_uid ||
    witnesses.driver_image !== identity.driver_image
  )
    return refuse("thin_storage_sample_witness_changed");
  // A smaller or missing pool is an identity change; only the slow proof confirms a growth.
  const pool = body.physical.thin_pool;
  if (
    !pool ||
    pool.metadata_total_bytes !== profile.metadata_bytes ||
    pool.data_total_bytes < known.data_total_bytes ||
    pool.data_total_bytes > profile.maximum_data_bytes
  )
    return refuse("thin_storage_sample_pool_changed");
  // Every other LV is one the identity proof read; new thin LVs only for unbound startup holds.
  const holds = await storageHolds(env, nodeId, row.node_uid, identity),
    read = new Map(identity.physical_lvs.map((lv) => [lv.name, lv.segtype]));
  let thin = 0,
    unbound = 0;
  for (const lv of body.lvs) {
    if (lv.segtype !== "thin") {
      if (read.get(lv.name) !== lv.segtype)
        return refuse("thin_storage_sample_volumes_changed");
      continue;
    }
    thin++;
    if (read.get(lv.name) !== "thin") unbound++;
  }
  if (unbound > holds.newVolumes || thin > profile.maximum_volumes)
    return refuse("thin_storage_sample_volumes_changed");
  // The fresher of this sample and the reading the current authority holds.
  const held = Date.parse(identity.observed_at),
    reading =
      issued > held
        ? {
            observed_at: issued,
            captured_at: body.captured_at,
            physical: body.physical,
          }
        : {
            observed_at: held,
            captured_at: identity.captured_at,
            physical: identity.physical,
          };
  const headroom = minimumHeadroom(profile, identity, holds),
    writeAllowed = thinStorageWriteAllowed(
      profile,
      identity,
      reading.physical,
      headroom,
    ),
    authority = composeThinStorageAuthority({
      identity,
      inventory,
      reading,
      revision: row.authority_revision + 1,
      guardSeconds: guard,
      writeAllowed,
    }),
    nonce = sampleNonce();
  // Consumes the nonce in the same compare-and-set that writes the authority. The slow lease's
  // issue is updated_at, so a sample never writes it.
  const result = await env.DB.prepare(
    `UPDATE node_thin_storage SET authority_revision=?,authority_json=?,authority_received_at=?,status=?,sample_nonce=?,sample_nonce_issued_at=?,sample_observed_at=?,sample_data_used_bytes=?
    WHERE node_id=? AND node_uid=? AND profile_revision=? AND authority_revision=? AND sample_nonce=? AND error_code IS NULL AND status IN('ready','blocked')
      AND ${thinStorageAuthoritySql} AND ${qualifiedThinStorageSql("node_thin_storage")} AND ${storageHoldSnapshotSql}`,
  )
    .bind(
      authority.revision,
      JSON.stringify(authority),
      iso(now),
      writeAllowed ? "ready" : "blocked",
      nonce,
      iso(Date.now()),
      iso(issued),
      pool.data_used_bytes_upper_bound,
      nodeId,
      row.node_uid,
      row.profile_revision,
      row.authority_revision,
      body.nonce,
      JSON.stringify(holds.operations),
    )
    .run();
  if (result.meta.changes !== 1) return "conflict";
  const databases = await env.DB.prepare(
    "SELECT * FROM databases WHERE node_id=? AND region_id=? AND storage_profile_json IS NOT NULL AND storage_volume_json IS NOT NULL AND desired_state='running' AND deleted_at IS NULL ORDER BY id",
  )
    .bind(nodeId, row.region_id)
    .all<DatabaseRow>();
  const tokens: NodeStorageHeadroomResponse["tokens"] = [];
  for (const database of databases.results) {
    const token = await storageWriteAuthorityForDatabase(env, database, now);
    if (token) tokens.push({ database_id: database.id, token });
  }
  if (
    thinPoolDataGrowthNeeded(
      profile,
      reading.physical.thin_pool!,
      headroom,
      await nextThinStartupBytes(
        env,
        nodeId,
        row.region_id,
        profile,
        row.allow_new_databases,
      ),
    )
  )
    await requestThinStorageTurn(env, nodeId).catch(() => undefined);
  return {
    accepted: true,
    reason: null,
    nonce,
    period_milliseconds: period,
    authority,
    tokens,
  };
}

/** POST /agent/v1/nodes/{id}/storage-headroom with the region agent key. */
export async function recordStorageHeadroomSample(
  c: ApiContext,
  nodeId: string,
  raw: NodeStorageHeadroomSample,
) {
  NodeId.parse(nodeId);
  const body = NodeStorageHeadroomSample.parse(raw),
    region = await agentRegion(c);
  const node = await c.env.DB.prepare(
    "SELECT node_uid FROM nodes WHERE id=? AND region_id=?",
  )
    .bind(nodeId, region.id)
    .first<{ node_uid: string | null }>();
  if (!node) return unsampled();
  // A concurrent renewal or identity proof can win the compare-and-set; evaluate again a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await productSample(c.env, nodeId, body);
    if (result !== "conflict")
      return c.json(NodeStorageHeadroomResponse.parse(result), 200);
  }
  const current = await readCurrentNodeThinStorage(c.env, nodeId);
  if (!current) return unsampled();
  return c.json(
    NodeStorageHeadroomResponse.parse(
      await refuseSample(
        c.env,
        nodeId,
        current.row.node_uid,
        thinStorageSamplePeriodMilliseconds(current.profile.guard_seconds),
        "thin_storage_sample_conflict",
        false,
      ),
    ),
    200,
  );
}
