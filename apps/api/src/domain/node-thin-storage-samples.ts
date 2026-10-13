// SPDX-License-Identifier: Apache-2.0
// Fast headroom samples renew thin write authority (docs/architecture/thin-authority-renewal.md,
// sections 4.3 and 4.4). Cloudflare alone decides; the controller only supplies the reading.
import {
  NodeId,
  NodePhysicalStorage,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  thinStorageInventory,
  thinStorageSamplePeriodMilliseconds,
} from "@pgcf/contracts";
import {
  NodeStorageHeadroomResponse,
  NodeStorageHeadroomSample,
  ThinStorageSampleTarget,
} from "@pgcf/contracts/node-thin-storage";
import {
  THIN_QUALIFICATION_SAMPLE_WINDOWS,
  ThinQualificationSetup,
} from "@pgcf/contracts/thin-qualification";
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
import {
  thinStorageSamplingCapable,
  thinStorageSamplingSql,
} from "./fleet-releases.ts";

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

/** Selected thin nodes that are not blocked by an identity or qualification failure, and the
 * nodes of scratch qualification runs between their setup and their cleanup. A node never has
 * both: a selection and a running qualification exclude each other. */
export async function desiredRegionStorageSamples(
  env: Pick<Env, "DB">,
  regionId: string,
): Promise<ThinStorageSampleTarget[]> {
  if (!(await thinStorageSamplingCapable(env.DB, regionId))) return [];
  const rows = await env.DB.prepare(
    `SELECT t.node_id,n.k8s_node_name name,t.node_uid,json_extract(t.profile_json,'$.guard_seconds') guard_seconds,NULL qualification_run
    FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id AND n.node_uid=t.node_uid
    WHERE n.region_id=? AND n.ready=1 AND n.lost_at IS NULL AND t.error_code IS NULL AND t.status IN('ready','blocked')
    UNION ALL
    SELECT q.node_id,n.k8s_node_name name,q.node_uid,json_extract(q.profile_json,'$.guard_seconds') guard_seconds,q.id qualification_run
    FROM thin_storage_qualification_runs q JOIN nodes n ON n.id=q.node_id AND n.node_uid=q.node_uid AND n.region_id=q.region_id
    WHERE q.region_id=? AND q.status='running' AND q.setup_json IS NOT NULL AND q.step NOT IN('cleanup','complete') AND n.ready=1 AND n.lost_at IS NULL
    ORDER BY 1`,
  )
    .bind(regionId, regionId)
    .all<{
      node_id: string;
      name: string;
      node_uid: string;
      guard_seconds: number;
      qualification_run: string | null;
    }>();
  return rows.results.map((row) =>
    ThinStorageSampleTarget.parse({
      node_id: row.node_id,
      name: row.name,
      node_uid: row.node_uid,
      period_milliseconds: thinStorageSamplePeriodMilliseconds(
        row.guard_seconds,
      ),
      qualification_run: row.qualification_run,
    }),
  );
}

interface QualificationSampleRun {
  id: string;
  node_uid: string;
  profile_json: string;
  setup_json: string | null;
  step: string;
  sample_nonce: string | null;
  sample_nonce_issued_at: string | null;
}
/** Sampling remains bound to the run's current node/release and the confirmed regional controller. */
const qualificationSampleAuthoritySql = `EXISTS(SELECT 1 FROM nodes qn JOIN regions qr ON qr.id=qn.region_id
  JOIN fleet_node_releases qa ON qa.node_id=qn.id AND qa.node_uid=qn.node_uid
  JOIN fleet_region_releases qf ON qf.region_id=qn.region_id JOIN fleet_releases qs ON qs.id=qf.release_id
  WHERE qn.id=q.node_id AND qn.node_uid=q.node_uid AND qn.region_id=q.region_id AND qn.ready=1 AND qn.lost_at IS NULL
    AND qa.release_id=q.release_id AND qa.revision=q.assignment_revision AND qf.release_id=q.release_id
    AND qf.revision=q.region_revision AND qs.spec_sha256=q.spec_sha256 AND qr.bootstrap_material_revision=q.material_revision
    AND ${thinStorageSamplingSql("qr")})`;
const qualificationSampleWindows = Object.entries(
  THIN_QUALIFICATION_SAMPLE_WINDOWS,
);
const qualificationSampleWindowSql = qualificationSampleWindows
  .map(
    () => `(q.step=?
  AND EXISTS(SELECT 1 FROM json_each(q.journal_json,'$.entries') edge
    WHERE json_extract(edge.value,'$.key')=? AND json_extract(edge.value,'$.state')='confirmed'
      AND julianday(json_extract(edge.value,'$.received_at'))<=julianday(?))
  AND NOT EXISTS(SELECT 1 FROM json_each(q.journal_json,'$.entries') edge
    WHERE json_extract(edge.value,'$.key')=? AND json_extract(edge.value,'$.state')='confirmed'
      AND julianday(json_extract(edge.value,'$.received_at'))<julianday(?)))`,
  )
  .join(" OR ");
/** Section 10: a running qualification records its node's accepted samples as run evidence. The
 * witnesses must be the run's setup identity; nothing is renewed and no token is signed. */
async function qualificationSample(
  env: Env,
  run: QualificationSampleRun,
  nodeUid: string | null,
  body: NodeStorageHeadroomSample,
): Promise<NodeStorageHeadroomResponse> {
  const now = Date.now(),
    guard = ThinStorageProfile.parse(
      JSON.parse(run.profile_json),
    ).guard_seconds,
    period = thinStorageSamplePeriodMilliseconds(guard);
  const answer = (nonce: string, reason: string | null) => ({
    accepted: reason === null,
    reason,
    nonce,
    period_milliseconds: period,
    authority: null,
    tokens: [],
  });
  const refuse = async (reason: string) => {
    const nonce = sampleNonce();
    const result = await env.DB.prepare(
      `UPDATE thin_storage_qualification_runs AS q SET sample_nonce=?,sample_nonce_issued_at=? WHERE id=? AND status='running' AND ${qualificationSampleAuthoritySql}`,
    )
      .bind(nonce, iso(Date.now()), run.id)
      .run();
    if (result.meta.changes !== 1) return unsampled();
    return answer(nonce, reason);
  };
  const issued =
    run.sample_nonce_issued_at === null
      ? Number.NaN
      : Date.parse(run.sample_nonce_issued_at);
  if (
    body.nonce === null ||
    body.nonce !== run.sample_nonce ||
    !(now - issued <= guard * 500)
  )
    return refuse("thin_storage_sample_nonce_invalid");
  if (!run.setup_json || run.step === "cleanup" || run.step === "complete")
    return refuse("thin_storage_sample_qualification_inactive");
  const identity = ThinQualificationSetup.parse(
      JSON.parse(run.setup_json),
    ).identity,
    witnesses = body.witnesses;
  if (
    body.node_uid !== run.node_uid ||
    nodeUid !== run.node_uid ||
    witnesses.cluster_uid !== identity.cluster_uid ||
    witnesses.boot_id !== identity.boot_id ||
    witnesses.volume_group_uuid !== identity.volume_group_uuid ||
    witnesses.driver_pod_uid !== identity.driver_pod_uid ||
    witnesses.driver_image !== identity.driver_image
  )
    return refuse("thin_storage_sample_witness_changed");
  const nonce = sampleNonce();
  // Nonces keep rotating between gates, but only a bounded active measurement window retains
  // evidence. An abandoned Workflow's open window stops accumulating when its existing lease ends.
  const [, rotated] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO thin_storage_qualification_samples(run_id,nonce,observed_at,received_at,scrape_milliseconds)
      SELECT ?,?,?,?,? FROM thin_storage_qualification_runs q WHERE q.id=? AND q.status='running' AND q.sample_nonce=?
        AND ${qualificationSampleAuthoritySql} AND q.lease_id IS NOT NULL AND julianday(q.lease_expires_at)>julianday('now')
        AND (${qualificationSampleWindowSql})`,
    ).bind(
      run.id,
      body.nonce,
      iso(issued),
      iso(now),
      body.scrape_milliseconds,
      run.id,
      body.nonce,
      ...qualificationSampleWindows.flatMap(([step, [first, last]]) => [
        step,
        first,
        iso(issued),
        last,
        iso(now),
      ]),
    ),
    env.DB.prepare(
      `UPDATE thin_storage_qualification_runs AS q SET sample_nonce=?,sample_nonce_issued_at=? WHERE id=? AND status='running' AND sample_nonce=? AND ${qualificationSampleAuthoritySql}`,
    ).bind(nonce, iso(Date.now()), run.id, body.nonce),
  ]);
  if (rotated!.meta.changes !== 1)
    return refuse("thin_storage_sample_nonce_invalid");
  return answer(nonce, null);
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
    known = row.inventory_physical_json
      ? NodePhysicalStorage.parse(JSON.parse(row.inventory_physical_json))
          .thin_pool
      : identity?.physical.thin_pool;
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
    pool.metadata_total_bytes !== known.metadata_total_bytes ||
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
      AND ${thinStorageAuthoritySql} AND ${qualifiedThinStorageSql("node_thin_storage")} AND ${storageHoldSnapshotSql}
      AND EXISTS(SELECT 1 FROM nodes sg JOIN regions sr ON sr.id=sg.region_id WHERE sg.id=node_thin_storage.node_id AND ${thinStorageSamplingSql("sr")})`,
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
  if (!(await thinStorageSamplingCapable(c.env.DB, region.id)))
    return unsampled();
  const run = await c.env.DB.prepare(
    "SELECT id,node_uid,profile_json,setup_json,step,sample_nonce,sample_nonce_issued_at FROM thin_storage_qualification_runs WHERE node_id=? AND region_id=? AND status='running'",
  )
    .bind(nodeId, region.id)
    .first<QualificationSampleRun>();
  if (run)
    return c.json(
      NodeStorageHeadroomResponse.parse(
        await qualificationSample(c.env, run, node.node_uid, body),
      ),
      200,
    );
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
