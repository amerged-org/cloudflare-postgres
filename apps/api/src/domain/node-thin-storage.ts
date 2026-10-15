// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseRuntimeAttestation,
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  signStorageWriteAuthority,
  thinStorageAuthorityMatches,
  thinStorageInventory,
  thinStorageVolumeReclaimed,
  type StorageWriteClaims,
} from "@pgcf/contracts";
import type { Env } from "../env.ts";
import type { DatabaseRow } from "./rows.ts";
import { nodeProofSigningKey } from "./node-proof-session.ts";
import {
  thinStorageSamplingCapable,
  postgresPoolCapable,
  postgresPoolSql,
  postgresPoolQualificationCapable,
} from "./fleet-releases.ts";
import { parkedRecordFresh, readParkedRecord } from "./parked-tier.ts";
import {
  PoolBinding,
  PoolHostCustody,
  poolBindingScopeHash,
  POSTGRES_POOL,
} from "@pgcf/contracts/postgres-pool";
import {
  currentStorageStopSql,
  storageDrainReservationStatement,
  nodeThinStorageHeadroomSql,
  knownStorageHoldVolume,
} from "./storage-capacity.ts";

export interface NodeThinStorageRow {
  node_id: string;
  node_uid: string;
  cluster_uid: string;
  address: string;
  volume_group_uuid: string;
  profile_revision: number;
  profile_sha256: string;
  profile_json: string;
  allow_new_databases: number;
  authority_revision: number;
  authority_json: string | null;
  authority_received_at: string | null;
  inventory_physical_json: string | null;
  lease_id: string | null;
  lease_revision: number;
  lease_expires_at: string | null;
  material_revision: number;
  action_json: string | null;
  qualified_driver_image: string | null;
  qualification_json: string | null;
  status: "selected" | "qualifying" | "ready" | "blocked";
  error_code: string | null;
  sample_nonce: string | null;
  sample_nonce_issued_at: string | null;
  sample_observed_at: string | null;
  sample_data_used_bytes: number | null;
  lease_sample_observed_at: string | null;
  lease_sample_data_used_bytes: number | null;
  created_at: string;
  /** Also the current slow lease's issue; fast samples never write it. */
  updated_at: string;
}

/** One current release/material/host/boot predicate shared by reads and atomic capacity admission. */
export function qualifiedThinStorageSql(alias = "t") {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_thin_authority_alias");
  return `EXISTS(SELECT 1 FROM nodes qn JOIN regions qr ON qr.id=qn.region_id JOIN fleet_node_releases qa ON qa.node_id=qn.id JOIN fleet_region_releases qf ON qf.region_id=qn.region_id JOIN fleet_releases qs ON qs.id=qa.release_id JOIN node_host_configurations qh ON qh.node_id=qn.id AND qh.node_uid=qn.node_uid JOIN fleet_node_release_observations qo ON qo.node_id=qn.id AND qo.node_uid=qn.node_uid AND qo.assignment_revision=qa.revision AND qo.agent_key_hash=qr.agent_key_hash JOIN fleet_patch_operations qp ON qp.node_id=qn.id JOIN json_each(qs.spec_json,'$.components') qverifier ON json_extract(qverifier.value,'$.name')='native-gateway' AND json_extract(qverifier.value,'$.kind')='image' JOIN json_each(qs.spec_json,'$.roles.'||qa.role||'.components') qgatewayrole ON qgatewayrole.value='native-gateway'
    WHERE (
      (((qn.id=${alias}.node_id AND qn.node_uid=${alias}.node_uid) AND (qn.ready=1 AND qn.lost_at IS NULL))
        AND (qa.node_uid=qn.node_uid AND (qa.release_id=qf.release_id AND qr.bootstrap_material_revision=${alias}.material_revision)))
      AND ((length(json_extract(qs.spec_json,'$.storage_authority_keys_sha256'))=64 AND json_extract(qs.spec_json,'$.storage_authority_keys_sha256') NOT GLOB '*[^0-9a-f]*')
        AND ((qh.release_id=qs.id AND qh.cluster_uid=${alias}.cluster_uid) AND (qh.material_revision=${alias}.material_revision AND json_extract(qo.facts_json,'$.boot_id')=json_extract(${alias}.qualification_json,'$.boot_id'))))
    ) AND (
      (((julianday(qo.observed_at)>=julianday('now','-180 seconds') AND julianday(qo.observed_at)<=julianday('now','+5 seconds')) AND (julianday(qo.received_at)>=julianday('now','-180 seconds') AND julianday(qo.received_at)<=julianday('now','+5 seconds')))
        AND ((json_extract(${alias}.qualification_json,'$.profile_revision')=${alias}.profile_revision AND json_extract(${alias}.qualification_json,'$.profile_sha256')=json_extract(qs.spec_json,'$.thin_storage_qualification.profile_sha256')) AND (json_extract(${alias}.qualification_json,'$.release_id')=qs.id AND json_extract(${alias}.qualification_json,'$.spec_sha256')=qs.spec_sha256)))
      AND ((json_extract(${alias}.qualification_json,'$.assignment_revision')=qa.revision AND (json_extract(${alias}.qualification_json,'$.region_revision')=qf.revision AND json_extract(qs.spec_json,'$.thin_storage_qualification.driver_image')=${alias}.qualified_driver_image))
        AND (json_extract(qs.spec_json,'$.thin_storage_qualification.host_extension_image')=json_extract(${alias}.qualification_json,'$.software.host_extension_image') AND (json_extract(qs.spec_json,'$.thin_storage_qualification.kernel_version')=json_extract(${alias}.qualification_json,'$.software.kernel_version') AND json_extract(${alias}.qualification_json,'$.software.host_configuration_sha256')=qh.sha256)))
    ) AND (
      (((qp.node_id=qn.id AND qp.node_uid=qn.node_uid) AND (qp.cluster_uid=${alias}.cluster_uid AND qp.release_id=qs.id))
        AND ((qp.spec_sha256=qs.spec_sha256 AND qp.assignment_revision=qa.revision) AND (qp.region_revision=qf.revision AND qp.material_revision=${alias}.material_revision)))
      AND (((qp.stage='complete' AND qp.state='confirmed') AND (qp.error_code IS NULL AND (qp.host_configuration_revision=qh.revision AND qp.host_configuration_sha256=qh.sha256)))
        AND ((json_extract(qp.observed_json,'$.host_configuration_sha256')=qh.sha256 AND json_extract(qp.observed_json,'$.runtime_admission_sha256')=qh.profile_sha256) AND (json_extract(qp.observed_json,'$.node_ready')=1 AND json_extract(qp.observed_json,'$.boot_id')=json_extract(${alias}.qualification_json,'$.boot_id'))))
    ))`;
}

export async function readCurrentNodeThinStorage(
  env: Pick<Env, "DB">,
  nodeId: string,
  now = Date.now(),
) {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.k8s_node_name,n.node_uid current_node_uid,n.ready,n.lost_at,CASE WHEN ${qualifiedThinStorageSql()} THEN 1 ELSE 0 END current_qualified FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE t.node_id=?`,
  )
    .bind(nodeId)
    .first<
      NodeThinStorageRow & {
        region_id: string;
        k8s_node_name: string;
        current_node_uid: string | null;
        ready: number;
        lost_at: string | null;
        current_qualified: number;
      }
    >();
  if (!row) return null;
  const profile = ThinStorageProfile.parse(JSON.parse(row.profile_json));
  const parsed = NodeThinStorageAuthority.safeParse(
    row.authority_json ? JSON.parse(row.authority_json) : null,
  );
  let authority: NodeThinStorageAuthority | null = null;
  let reclamation: NodeThinStorageAuthority | null = null;
  if (parsed.success) {
    const value = parsed.data;
    if (
      row.ready === 1 &&
      row.lost_at === null &&
      row.current_node_uid === row.node_uid &&
      value.node_id === row.node_id &&
      value.name === row.k8s_node_name &&
      value.node_uid === row.node_uid &&
      value.cluster_uid === row.cluster_uid &&
      value.volume_group_uuid === row.volume_group_uuid &&
      value.profile_revision === row.profile_revision &&
      value.profile_sha256 === row.profile_sha256 &&
      value.revision === row.authority_revision &&
      value.driver_image === row.qualified_driver_image &&
      value.driver_image === profile.driver_image &&
      row.authority_received_at !== null &&
      Date.parse(row.authority_received_at) >= now - 120000 &&
      Date.parse(row.authority_received_at) <= now + 5000 &&
      Date.parse(value.observed_at) >= now - 120000 &&
      Date.parse(value.observed_at) <= now + 5000 &&
      Date.parse(value.expires_at) <=
        Date.parse(value.observed_at) + profile.guard_seconds * 1000
    ) {
      if (Date.parse(value.expires_at) > now)
        authority = {
          ...value,
          write_allowed:
            value.write_allowed &&
            row.status === "ready" &&
            row.current_qualified === 1,
        };
      // A slow identity read can outlive its short write lease. In particular, an absent
      // pool cannot produce fast headroom renewals, but its fresh identity still proves
      // deletion. Preserve its original expiry and explicitly deny all write authority.
      const inventory = thinStorageInventory(value);
      if (
        row.error_code === null &&
        row.current_qualified === 1 &&
        value.data_accounting_complete &&
        inventory.observed_at >= now - 120000 &&
        inventory.observed_at <= now + 5000 &&
        inventory.expires_at > now
      )
        reclamation = { ...value, write_allowed: false };
    }
  }
  return { row, profile, authority, reclamation };
}

/**
 * Every thin node of a region at one instant: the authority each hands out, and the reading it came
 * from, which a database of that node's page entry is judged by without reading the node again.
 * No native proof means no authority; ordinary regional physical metrics cannot fill this gap.
 */
export async function readRegionThinStorage(
  env: Pick<Env, "DB">,
  regionId: string,
  now = Date.now(),
) {
  const [samplingCapable, rows] = await Promise.all([
    thinStorageSamplingCapable(env.DB, regionId),
    env.DB.prepare(
      "SELECT t.node_id FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE n.region_id=? ORDER BY n.id",
    )
      .bind(regionId)
      .all<{ node_id: string }>(),
  ]);
  const readings = await Promise.all(
    rows.results.map((row) =>
      readCurrentNodeThinStorage(env, row.node_id, now),
    ),
  );
  const nodes: NodeThinStorageAuthority[] = [],
    snapshots = new Map<string, (typeof readings)[number]>();
  rows.results.forEach((row, index) => {
    const current = readings[index];
    snapshots.set(row.node_id, current);
    const proof = current?.authority ?? current?.reclamation;
    if (proof && (samplingCapable || proof.inventory_observed_at === undefined))
      nodes.push(proof);
  });
  return { nodes, snapshots };
}
export async function desiredRegionStorageNodes(
  env: Pick<Env, "DB">,
  regionId: string,
  now = Date.now(),
): Promise<NodeThinStorageAuthority[]> {
  return (await readRegionThinStorage(env, regionId, now)).nodes;
}

/** A protective stop is released only by an authorized newer generation, never by a renewal. */
function storageWriterProtected(
  database: DatabaseRow,
  authority: NodeThinStorageAuthority | null | undefined,
) {
  return Boolean(
    (database.storage_protected_at != null &&
      database.storage_protected_generation === database.generation) ||
    authority?.volumes.some(
      (volume) =>
        volume.database_id === database.id &&
        volume.generation === database.generation &&
        volume.storage_generation === (database.storage_generation ?? 1) &&
        volume.quiesced === true,
    ),
  );
}

/** A new writer without IO evidence yet (section 8 of thin-authority-renewal.md): its current
 * startup hold of this generation debits at least the LV's virtual size until a later identity
 * proof shows the Pod's io.max, and the controller's runtime attestation of this generation names
 * the Pod together with the receipt's identities, the cluster and the identity proof's boot. */
async function heldWriterPod(
  env: Pick<Env, "DB">,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  qualification: string | null,
  reading = authority.volumes.find(
    (value) =>
      value.database_id === database.id &&
      value.generation === database.generation &&
      value.storage_generation === receipt.storage_generation,
  ),
): Promise<string | undefined> {
  const lv = authority.physical_lvs.find(
      (value) => value.lv_uuid === receipt.lv_uuid && value.segtype === "thin",
    ),
    attestation = DatabaseRuntimeAttestation.safeParse(
      database.runtime_attestation_json
        ? JSON.parse(database.runtime_attestation_json)
        : null,
    ),
    boot = qualification
      ? (JSON.parse(qualification) as { boot_id?: unknown }).boot_id
      : undefined;
  if (!lv || !attestation.success) return undefined;
  const runtime = attestation.data;
  if (
    database.observed_generation !== database.generation ||
    runtime.database_id !== database.id ||
    runtime.generation !== database.generation ||
    runtime.storage_generation !== receipt.storage_generation ||
    runtime.node_uid !== storage.node_uid ||
    runtime.boot_id !== boot ||
    runtime.cluster_uid !== authority.cluster_uid ||
    runtime.namespace_uid !== receipt.namespace_uid ||
    runtime.cnpg_cluster_uid !== receipt.cluster_uid ||
    runtime.storage_uid !== receipt.storage_uid ||
    runtime.pvc_uid !== receipt.pvc_uid ||
    runtime.pv_uid !== receipt.pv_uid
  )
    return undefined;
  const volume = reading;
  const hold = await env.DB.prepare(
    "SELECT h.ready_at,CASE WHEN o.status='succeeded' THEN o.completed_at ELSE NULL END completed_at FROM database_start_admissions h JOIN operations o ON o.id=h.operation_id WHERE h.database_id=? AND h.generation=? AND h.node_id=? AND h.node_uid=? AND h.budget_bytes>0 AND h.storage_budget_bytes>=?",
  )
    .bind(
      database.id,
      database.generation,
      database.node_id,
      storage.node_uid,
      lv.size_bytes,
    )
    .first<{ ready_at: string | null; completed_at: string | null }>();
  if (!hold) return undefined;
  const readyAt = Math.min(
    runtime.observed_at,
    hold.ready_at ? Date.parse(hold.ready_at) : Infinity,
    hold.completed_at ? Date.parse(hold.completed_at) : Infinity,
  );
  // The startup hold covers the interval before the first post-Ready IO readback only.
  // Fast headroom renewals must not turn old inventory into that post-Ready proof.
  // Completed startup time remains stable when the controller refreshes its attestation.
  if (
    volume &&
    !volume.quiesced &&
    volume.io.length === 0 &&
    authority.active_lv_uuids.includes(receipt.lv_uuid) &&
    thinStorageInventory(authority).observed_at > readyAt + 5000
  )
    return undefined;
  return runtime.pod_uid;
}

/** What every writer token of a retained thin volume stands on: the receipt, the profile and a
 * current, write-allowed physical reading of the node that has this very volume. */
async function currentWriterContext(
  env: Env,
  database: DatabaseRow,
  now: number,
  snapshot?: Awaited<ReturnType<typeof readCurrentNodeThinStorage>>,
) {
  if (
    !database.node_id ||
    !database.storage_profile_json ||
    !database.storage_volume_json ||
    database.deleted_at
  )
    return undefined;
  const storage = DesiredDatabaseStorage.parse(
    JSON.parse(database.storage_profile_json),
  );
  const receipt = DatabaseStorageVolumeReceipt.parse(
    JSON.parse(database.storage_volume_json),
  );
  const current =
    snapshot === undefined
      ? await readCurrentNodeThinStorage(env, database.node_id, now)
      : snapshot;
  const authority = current?.authority;
  if (
    !thinStorageAuthorityMatches(storage, authority, undefined, now) ||
    !authority ||
    storageWriterProtected(database, authority) ||
    current?.row.node_id !== database.node_id ||
    receipt.storage_generation !== (database.storage_generation ?? 1) ||
    receipt.node_uid !== storage.node_uid ||
    receipt.volume_group_uuid !== storage.volume_group_uuid ||
    receipt.pool_uuid !== storage.pool_uuid ||
    !authority.physical_lvs.some(
      (lv) => lv.lv_uuid === receipt.lv_uuid && lv.segtype === "thin",
    )
  )
    return undefined;
  return { storage, receipt, authority, current };
}

/** The measured volume is this database's volume, in the profile's classes. */
function volumeMatchesReceipt(
  volume: NodeThinStorageAuthority["volumes"][number],
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
) {
  return (
    volume.storage_uid === receipt.storage_uid &&
    volume.namespace_uid === receipt.namespace_uid &&
    volume.cluster_uid === receipt.cluster_uid &&
    volume.lv_uuid === receipt.lv_uuid &&
    volume.volume_handle === receipt.volume_handle &&
    volume.pvc_uid === receipt.pvc_uid &&
    volume.pv_uid === receipt.pv_uid &&
    volume.storage_class === storage.storage_class &&
    volume.volume_attributes_class === storage.volume_attributes_class
  );
}

/** Cloudflare's signature over one named writer. Stable within one accepted physical revision:
 * polling never extends a stale read's deadline. */
async function signStorageWriter(
  env: Env,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  pod: string,
  now: number,
) {
  const key = await nodeProofSigningKey(env);
  const claims: StorageWriteClaims = {
    v: 1,
    kid: key.kid,
    database_id: database.id,
    generation: database.generation,
    authority_revision: authority.revision,
    storage_uid: receipt.storage_uid,
    node_uid: storage.node_uid,
    volume_group_uuid: storage.volume_group_uuid,
    pool_uuid: storage.pool_uuid,
    profile_sha256: storage.profile_sha256,
    volume_handle: receipt.volume_handle,
    lv_uuid: receipt.lv_uuid,
    pvc_uid: receipt.pvc_uid,
    pv_uid: receipt.pv_uid,
    pod_uid: pod,
    observed_at: Date.parse(authority.observed_at),
    iat: Date.parse(authority.observed_at),
    exp: Date.parse(authority.expires_at),
    guard_seconds: storage.guard_seconds,
    drain_seconds: storage.drain_seconds,
    write_allowed: true,
  };
  return signStorageWriteAuthority(claims, key.privateKey, now);
}

/**
 * The one instance Pod the node's own latest reading evidences on this volume: exactly one Pod
 * with io.max inside the profile's limits, on the receipt's volume, not frozen, read at a
 * generation no newer than the row's (a sleep or a D1-only resize bumps the row first). The proof
 * counts every non-terminal instance Pod as a writer, whatever its desired state.
 */
function evidencedWriter(
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
): string | undefined {
  const volumes = authority.volumes.filter(
    (volume) =>
      volume.database_id === database.id &&
      volume.storage_generation === receipt.storage_generation &&
      volume.generation <= database.generation,
  );
  const volume = volumes.length === 1 ? volumes[0] : undefined;
  const io = volume?.io[0];
  if (
    !volume ||
    volume.quiesced ||
    !volumeMatchesReceipt(volume, storage, receipt) ||
    volume.io.length !== 1 ||
    !io ||
    io.write_bytes_per_second > storage.write_bytes_per_second ||
    io.write_iops_per_second > storage.write_iops_per_second
  )
    return undefined;
  return io.pod_uid;
}

/**
 * The Pod a parked database still holds, when the controller's word and the node's own reading
 * agree: the controller's fresh report names it and the node evidences exactly that one Pod. No
 * other source names a Pod for a parked database, so no token can exist for a Pod that was not both
 * attested and evidenced.
 * It serves two moments: while the database sleeps parked, and while a fast wake of the very next
 * generation reuses the Pod.
 */
async function parkedHolder(
  env: Pick<Env, "DB">,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  now: number,
): Promise<string | undefined> {
  const parked = readParkedRecord(database.parked_json);
  if (
    !parked ||
    database.observed_power !== "hibernated" ||
    database.deleted_at !== null ||
    !parkedRecordFresh(parked, now)
  )
    return undefined;
  if (database.desired_state === "suspended") {
    // Parked steady state: only an idle sleep is parked; an explicit suspension is a real stop.
    if (database.suspension_reason !== "idle") return undefined;
  } else if (database.desired_state === "running") {
    // Waking from parked. Once the guard accepted a token for this Pod at the wake's generation it
    // holds the Pod as that generation's writer and refuses a replacement Pod until a newer one.
    // So the token only goes with the controller's claim that every predicate of the fast wake
    // holds, for the wake that directly follows the reported sleep. Any other wake is ordinary: no
    // token for the parked Pod, the guard retires it with the startup and the controller demotes.
    if (
      parked.wake !== "fast" ||
      database.generation !== parked.generation + 1 ||
      !(await env.DB.prepare(
        "SELECT 1 FROM operations o WHERE o.id=? AND o.database_id=? AND o.project_id=? AND o.generation=? AND o.kind IN('database.wake','database.resume') AND o.status IN('pending','running')",
      )
        .bind(
          database.power_operation ?? "",
          database.id,
          database.project_id,
          database.generation,
        )
        .first())
    )
      return undefined;
  } else return undefined;
  return evidencedWriter(database, storage, receipt, authority) ===
    parked.pod_uid
    ? parked.pod_uid
    : undefined;
}

export async function storageWriteAuthorityForDatabase(
  env: Env,
  database: DatabaseRow,
  now = Date.now(),
  snapshot?: Awaited<ReturnType<typeof readCurrentNodeThinStorage>>,
): Promise<string | undefined> {
  const { readPostgresPoolBindingForDatabase, hasNonterminalPoolHolderSql } =
    await import("./postgres-pool.ts");
  const pool = await readPostgresPoolBindingForDatabase(env, database.id);
  if (pool && !["released", "refused"].includes(pool.state))
    return issuePostgresPoolStorageAuthority(env, pool, now, snapshot);
  if (
    await env.DB.prepare(
      `SELECT 1 FROM databases d WHERE d.id=? AND ${hasNonterminalPoolHolderSql("d")}`,
    )
      .bind(database.id)
      .first()
  )
    return undefined;
  if (database.desired_state !== "running") return undefined;
  const context = await currentWriterContext(env, database, now, snapshot);
  if (!context) return undefined;
  const { storage, receipt, authority, current } = context;
  const volume = authority.volumes.find(
    (volume) =>
      volume.database_id === database.id &&
      volume.generation === database.generation &&
      volume.storage_generation === receipt.storage_generation,
  );
  if (
    volume &&
    (!volumeMatchesReceipt(volume, storage, receipt) || volume.io.length > 1)
  )
    return undefined;
  const io = volume?.io[0];
  if (
    io &&
    (io.write_bytes_per_second > storage.write_bytes_per_second ||
      io.write_iops_per_second > storage.write_iops_per_second)
  )
    return undefined;
  // Measured IO limits name the writer; until the identity proof has them, only a held writer,
  // or the parked Pod that a wake of this very generation reuses.
  const pod =
    io?.pod_uid ??
    (await heldWriterPod(
      env,
      database,
      storage,
      receipt,
      authority,
      current!.row.qualification_json,
    )) ??
    (await parkedHolder(env, database, storage, receipt, authority, now));
  if (!pod) return undefined;
  return signStorageWriter(
    env,
    database,
    storage,
    receipt,
    authority,
    pod,
    now,
  );
}

/**
 * The writer a sleep's window continues: the running authority's own sources at the generation the
 * Pod was started for (the sleep bumped the row's generation from it). The node's single measured
 * Pod, or while no reading has measured one yet, the held writer: the startup hold plus the
 * controller's attestation of that start. Both have to name the same Pod, and a frozen volume or a
 * second measured Pod names none.
 */
async function stoppingWriter(
  env: Pick<Env, "DB">,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  qualification: string | null,
): Promise<string | undefined> {
  const volumes = authority.volumes.filter(
    (volume) =>
      volume.database_id === database.id &&
      volume.storage_generation === receipt.storage_generation &&
      volume.generation <= database.generation,
  );
  if (volumes.length > 1) return undefined;
  const volume = volumes[0];
  if (
    volume &&
    (volume.quiesced ||
      !volumeMatchesReceipt(volume, storage, receipt) ||
      volume.io.length > 1)
  )
    return undefined;
  const io = volume?.io[0];
  if (
    io &&
    (io.write_bytes_per_second > storage.write_bytes_per_second ||
      io.write_iops_per_second > storage.write_iops_per_second)
  )
    return undefined;
  const held =
    database.observed_generation === database.generation - 1
      ? await heldWriterPod(
          env,
          { ...database, generation: database.observed_generation },
          storage,
          receipt,
          authority,
          qualification,
          volume,
        )
      : undefined;
  if (io && held && io.pod_uid !== held) return undefined;
  return io?.pod_uid ?? held;
}

/**
 * For the host lease only: the writer token of a database whose sleep is being carried out. The
 * desired state is already "suspended" while the controller still has to stop PostgreSQL
 * gracefully in the instance Pod (its sleep proof, then the stop). The guard freezes the volume and
 * kills the tasks of a Pod without a running entry and a token naming it, which would cut that stop
 * short, so until the stop operation of this generation leaves pending or running the Pod the node
 * evidences stays the running writer. The caller has checked the operation and excluded every
 * unresolved pool holder.
 */
async function stoppingStorageWriteAuthority(
  env: Env,
  database: DatabaseRow,
  now: number,
  snapshot: Awaited<ReturnType<typeof readCurrentNodeThinStorage>>,
): Promise<string | undefined> {
  if (database.desired_state !== "suspended") return undefined;
  const context = await currentWriterContext(env, database, now, snapshot);
  if (!context) return undefined;
  const { storage, receipt, authority, current } = context;
  const pod = await stoppingWriter(
    env,
    database,
    storage,
    receipt,
    authority,
    current!.row.qualification_json,
  );
  if (!pod) return undefined;
  return signStorageWriter(
    env,
    database,
    storage,
    receipt,
    authority,
    pod,
    now,
  );
}

/**
 * For the host lease only: the writer token of a database that sleeps parked. The guard freezes
 * the volume and stops the tasks of any Pod whose entry is not a running one with a valid token
 * naming it, so a parked Pod has to be presented as the running writer it physically is.
 * Never used for desired state or headroom responses: nothing else may hold a token for it.
 * The caller has excluded every unresolved pool holder.
 */
async function parkedStorageWriteAuthority(
  env: Env,
  database: DatabaseRow,
  now: number,
  snapshot: Awaited<ReturnType<typeof readCurrentNodeThinStorage>>,
): Promise<string | undefined> {
  if (database.desired_state !== "suspended" || !database.parked_json)
    return undefined;
  const context = await currentWriterContext(env, database, now, snapshot);
  if (!context) return undefined;
  const { storage, receipt, authority } = context;
  const pod = await parkedHolder(
    env,
    database,
    storage,
    receipt,
    authority,
    now,
  );
  if (!pod) return undefined;
  return signStorageWriter(
    env,
    database,
    storage,
    receipt,
    authority,
    pod,
    now,
  );
}

/** Real pre-grant cgroup/device custody can precede the mount. It is not PG readiness.
 * Only CF combines that reading with current physical headroom and a bounded startup hold. */
export async function issuePostgresPoolStorageAuthority(
  env: Env,
  value: PoolBinding,
  now = Date.now(),
  snapshot?: Awaited<ReturnType<typeof readCurrentNodeThinStorage>>,
): Promise<string | undefined> {
  const binding = PoolBinding.parse(value),
    scope = binding.scope;
  if (
    scope.storage.backend !== "lvm-thin-v1" ||
    !["claimed", "mounted", "serving", "detaching"].includes(binding.state) ||
    (await poolBindingScopeHash(scope)) !== binding.scope_sha256
  )
    return undefined;
  if (
    await env.DB.prepare(
      "SELECT 1 FROM pool_cleanup_grants WHERE binding_id=? AND state<>'completed'",
    )
      .bind(scope.binding_id)
      .first()
  )
    return undefined;
  const normal = await postgresPoolCapable(env.DB, scope.region_id);
  const qualification = normal
    ? undefined
    : await (
        await import("./postgres-pool.ts")
      ).readPostgresPoolQualificationAuthority(
        env,
        scope.database_id,
        scope.generation,
        now,
      );
  if (
    !normal &&
    (!qualification ||
      qualification.scope.node_id !== scope.node_id ||
      qualification.scope.node_uid !== scope.node_uid ||
      qualification.scope.boot_id !== scope.boot_id ||
      qualification.scope.database_generation !== scope.generation ||
      qualification.scope.thin_id !== scope.storage.thin_id ||
      JSON.stringify(qualification.scope.storage) !==
        JSON.stringify(scope.storage.profile) ||
      qualification.scope.configuration_fingerprint !==
        scope.configuration_fingerprint ||
      qualification.scope.software.driver_image !== scope.driver_image ||
      qualification.scope.software.driver_sha256 !== scope.driver_sha256 ||
      qualification.scope.software.supervisor_sha256 !==
        scope.supervisor_sha256 ||
      JSON.stringify(qualification.policy.class) !==
        JSON.stringify(scope.class))
  )
    return undefined;
  const capability = qualification?.fence ?? {
    sql: postgresPoolSql("r"),
    bindings: [],
  };
  const storage = scope.storage,
    profile = storage.profile;
  const row = await env.DB.prepare(
    `SELECT d.*,e.admission_revision,e.route_revision,e.mutation_id,b.state binding_state,b.scope_sha256,b.scope_json,b.detaching_at,b.node_report_json,
    h.state holder_state,h.revision holder_revision,s.storage_gib,
    (SELECT MIN(q.drain_deadline) FROM pool_role_mutations q WHERE q.binding_id=b.id AND q.status='pending') role_deadline
    FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id AND h.database_id=b.database_id AND h.kind='pool'
    JOIN databases d ON d.id=b.database_id JOIN projects p ON p.id=d.project_id AND p.deleted_at IS NULL
    JOIN database_admission_epochs e ON e.database_id=d.id JOIN size_classes s ON s.id=d.size_class_id WHERE b.id=?`,
  )
    .bind(scope.binding_id)
    .first<
      DatabaseRow & {
        admission_revision: number;
        route_revision: number;
        mutation_id: string | null;
        binding_state: string;
        scope_sha256: string;
        scope_json: string;
        detaching_at: number | null;
        node_report_json: string | null;
        holder_state: string;
        holder_revision: number;
        storage_gib: number;
        role_deadline: number | null;
      }
    >();
  if (
    !row ||
    row.id !== scope.database_id ||
    row.node_id !== scope.node_id ||
    row.region_id !== scope.region_id ||
    row.binding_state !== binding.state ||
    row.holder_state !== binding.state ||
    row.holder_revision !== binding.holder_revision ||
    row.scope_sha256 !== binding.scope_sha256 ||
    row.mutation_id !== null ||
    row.admission_revision < scope.admission_epoch ||
    row.route_revision < scope.route_revision ||
    (binding.state !== "detaching" &&
      (row.generation !== scope.generation ||
        row.desired_state !== "running" ||
        row.deleted_at !== null)) ||
    (["claimed", "mounted"].includes(binding.state) &&
      (row.admission_revision !== scope.admission_epoch ||
        row.route_revision !== scope.route_revision ||
        now >= binding.created_at + POSTGRES_POOL.permission_ms)) ||
    (row.storage_protected_at != null &&
      (row.storage_protected_generation ?? 0) >= scope.generation)
  )
    return undefined;
  const receipt = DatabaseStorageVolumeReceipt.safeParse(
      row.storage_volume_json ? JSON.parse(row.storage_volume_json) : null,
    ),
    currentProfile = DesiredDatabaseStorage.safeParse(
      row.storage_profile_json ? JSON.parse(row.storage_profile_json) : null,
    );
  if (
    !receipt.success ||
    !currentProfile.success ||
    JSON.stringify(currentProfile.data) !== JSON.stringify(profile) ||
    receipt.data.storage_generation !== storage.storage_generation ||
    (row.storage_generation ?? 1) !== storage.storage_generation ||
    receipt.data.storage_uid !== storage.storage_uid ||
    receipt.data.node_uid !== scope.node_uid ||
    receipt.data.namespace_uid !== storage.namespace_uid ||
    receipt.data.cluster_uid !== storage.cnpg_cluster_uid ||
    receipt.data.volume_group_uuid !== storage.volume_group_uuid ||
    receipt.data.pool_uuid !== profile.pool_uuid ||
    receipt.data.volume_handle !== storage.volume_handle ||
    receipt.data.lv_uuid !== storage.lv_uuid ||
    receipt.data.pvc_uid !== storage.pvc_uid ||
    receipt.data.pv_uid !== storage.pv_uid
  )
    return undefined;
  const current =
      snapshot === undefined
        ? await readCurrentNodeThinStorage(env, scope.node_id, now)
        : snapshot,
    authority = current?.authority;
  if (
    !authority ||
    !current ||
    !thinStorageAuthorityMatches(profile, authority, undefined, now) ||
    current.row.current_qualified !== 1 ||
    current.row.node_uid !== scope.node_uid ||
    current.row.region_id !== scope.region_id ||
    (
      JSON.parse(current.row.qualification_json ?? "null") as {
        boot_id?: unknown;
      } | null
    )?.boot_id !== scope.boot_id ||
    thinStorageInventory(authority).expires_at <= now ||
    storageWriterProtected({ ...row, generation: scope.generation }, authority)
  )
    return undefined;
  const lv = authority.physical_lvs.find(
    (lv) =>
      lv.lv_uuid === storage.lv_uuid &&
      lv.name === storage.volume_handle &&
      lv.segtype === "thin",
  );
  const volume = authority.volumes.find(
    (v) =>
      v.database_id === scope.database_id &&
      v.storage_generation === storage.storage_generation,
  );
  if (
    !lv ||
    !volume ||
    volume.storage_uid !== storage.storage_uid ||
    volume.namespace_uid !== storage.namespace_uid ||
    volume.cluster_uid !== storage.cnpg_cluster_uid ||
    volume.lv_uuid !== storage.lv_uuid ||
    volume.volume_handle !== storage.volume_handle ||
    volume.pvc_uid !== storage.pvc_uid ||
    volume.pv_uid !== storage.pv_uid ||
    volume.storage_class !== profile.storage_class ||
    volume.volume_attributes_class !== profile.volume_attributes_class
  )
    return undefined;
  if (["claimed", "mounted"].includes(binding.state)) {
    const held = await env.DB.prepare(
      "SELECT 1 FROM database_start_admissions a JOIN operations o ON o.id=a.operation_id WHERE a.database_id=? AND a.generation=? AND a.node_id=? AND a.node_uid=? AND a.budget_bytes>0 AND a.storage_budget_bytes>=? AND a.ready_at IS NULL AND o.status IN('pending','running') AND o.generation=a.generation",
    )
      .bind(
        scope.database_id,
        scope.generation,
        scope.node_id,
        scope.node_uid,
        Math.max(
          lv.size_bytes,
          profile.startup_reserve_bytes,
          row.storage_gib * 1024 ** 3,
        ),
      )
      .first();
    if (!held) return undefined;
  }
  const { readPostgresPoolIoAttestation } = await import("./postgres-pool.ts"),
    io = await readPostgresPoolIoAttestation(env, binding, now);
  if (!io) return undefined;
  let expires = Math.min(
    Date.parse(authority.expires_at),
    io.observed_at + POSTGRES_POOL.observation_max_age_ms,
  );
  if (qualification) expires = Math.min(expires, qualification.expires_at);
  if (binding.state === "detaching") {
    // A retained mount proves an existing holder. Detaching never grants a late new PG start.
    const { PoolNodeReport } = await import("@pgcf/contracts/postgres-pool");
    const mounted = PoolNodeReport.safeParse(
      row.node_report_json ? JSON.parse(row.node_report_json) : null,
    );
    if (
      !mounted.success ||
      mounted.data.state !== "mounted" ||
      mounted.data.pool_pod_uid !== scope.pool_pod_uid ||
      mounted.data.scope_sha256 !== binding.scope_sha256
    )
      return undefined;
    expires = Math.min(
      expires,
      row.role_deadline ??
        (row.detaching_at === null
          ? 0
          : row.detaching_at + profile.drain_seconds * 1000),
    );
  }
  if (expires <= now) return undefined;
  // Bind the last read to the exact authority, holder, IO receipt and current epochs before signing.
  const eligible = await env.DB.prepare(
    `SELECT 1 FROM pool_bindings b JOIN database_runtime_holders h ON h.binding_id=b.id JOIN databases d ON d.id=b.database_id
    JOIN database_admission_epochs e ON e.database_id=d.id JOIN nodes n ON n.id=d.node_id JOIN regions r ON r.id=d.region_id JOIN node_thin_storage t ON t.node_id=n.id
    JOIN pool_io_attestations i ON i.binding_id=b.id WHERE b.id=? AND b.scope_sha256=? AND b.state=? AND h.state=b.state AND h.revision=?
    AND d.generation=? AND d.storage_profile_json=? AND d.storage_volume_json=? AND d.storage_protected_at IS ? AND d.storage_protected_generation IS ?
    AND e.admission_revision=? AND e.route_revision=? AND e.mutation_id IS NULL AND i.attestation_json=? AND t.authority_revision=? AND t.authority_json=? AND t.status='ready'
    AND n.node_uid=? AND n.ready=1 AND n.lost_at IS NULL AND NOT EXISTS(SELECT 1 FROM pool_cleanup_grants cleanup WHERE cleanup.binding_id=b.id AND cleanup.state<>'completed') AND ${qualifiedThinStorageSql("t")} AND (${capability.sql})`,
  )
    .bind(
      scope.binding_id,
      binding.scope_sha256,
      binding.state,
      binding.holder_revision,
      row.generation,
      row.storage_profile_json,
      row.storage_volume_json,
      row.storage_protected_at ?? null,
      row.storage_protected_generation ?? null,
      row.admission_revision,
      row.route_revision,
      JSON.stringify(io),
      authority.revision,
      current.row.authority_json,
      scope.node_uid,
      ...capability.bindings,
    )
    .first();
  if (!eligible) return undefined;
  const key = await nodeProofSigningKey(env),
    observed = Date.parse(authority.observed_at);
  return signStorageWriteAuthority(
    {
      v: 1,
      kid: key.kid,
      database_id: scope.database_id,
      generation: scope.generation,
      authority_revision: authority.revision,
      storage_uid: storage.storage_uid,
      node_uid: scope.node_uid,
      volume_group_uuid: storage.volume_group_uuid,
      pool_uuid: profile.pool_uuid,
      profile_sha256: profile.profile_sha256,
      volume_handle: storage.volume_handle,
      lv_uuid: storage.lv_uuid,
      pvc_uid: storage.pvc_uid,
      pv_uid: storage.pv_uid,
      pod_uid: scope.pool_pod_uid,
      observed_at: observed,
      iat: observed,
      exp: expires,
      guard_seconds: profile.guard_seconds,
      drain_seconds: profile.drain_seconds,
      write_allowed: true,
    },
    key.privateKey,
    now,
  );
}

/** The protected host reads this over strict CF HTTPS; regional inputs never issue startup grants. */
/** Metadata custody only. Native independently measures all original writer leaves and their shared ancestor. */
export async function poolHostCustodyForDatabase(
  env: Env,
  id: string,
  capable: boolean,
  now = Date.now(),
  issueCleanup = false,
): Promise<PoolHostCustody | undefined> {
  if (!capable) return undefined;
  const { readPostgresPoolBindingForDatabase, readPostgresPoolIoAttestation } =
    await import("./postgres-pool.ts");
  const binding = await readPostgresPoolBindingForDatabase(env, id);
  if (!binding) return undefined;
  const io = await readPostgresPoolIoAttestation(env, binding, now);
  const cleanupModule = await import("./postgres-pool-cleanup-authority.ts"),
    intent = await cleanupModule.readPostgresPoolCleanupIntent(env, binding);
  const cleanup = issueCleanup
    ? await cleanupModule.issuePostgresPoolCleanupAuthority(env, binding, now)
    : undefined;
  const { readPostgresPoolCleanupGrant, readPostgresPoolCleanupIoAttestation } =
    await import("./postgres-pool.ts");
  const grant = cleanup
    ? await readPostgresPoolCleanupGrant(env, binding.scope.binding_id)
    : undefined;
  const cleanupIo = grant
    ? await readPostgresPoolCleanupIoAttestation(
        env,
        binding,
        grant.claims.operation_id,
        now,
      )
    : undefined;
  return PoolHostCustody.parse({
    v: 1,
    binding_id: binding.scope.binding_id,
    scope_sha256: binding.scope_sha256,
    holder_revision: binding.holder_revision,
    holder_generation: binding.scope.generation,
    holder_boot_id: binding.scope.boot_id,
    state: binding.state,
    pool_namespace: binding.scope.pool_namespace,
    pool_namespace_uid: binding.scope.pool_namespace_uid,
    pool_pod_uid: binding.scope.pool_pod_uid,
    container_ids: binding.scope.container_ids,
    device: cleanupIo?.device ?? io?.device ?? null,
    cleanup_authority: cleanup ?? null,
    ...(intent ? { cleanup_intent: intent } : {}),
  });
}
export async function hostStorageLease(
  c: import("../env.ts").ApiContext,
  id: string,
) {
  const { agentRegion } = await import("./agent-auth.ts");
  const { HostStorageLease } =
    await import("@pgcf/contracts/node-thin-storage");
  const { ApiError } = await import("../app.ts");
  const region = await agentRegion(c),
    now = Date.now();
  const node = await c.env.DB.prepare(
    `SELECT n.node_uid,r.bootstrap_material_revision FROM nodes n JOIN regions r ON r.id=n.region_id WHERE n.id=? AND n.region_id=? AND n.node_uid IS NOT NULL AND n.ready=1 AND n.lost_at IS NULL`,
  )
    .bind(id, region.id)
    .first<{ node_uid: string; bootstrap_material_revision: number }>();
  if (!node)
    throw new ApiError(
      "not_found",
      "Current physical storage host unavailable",
    );
  const current = await readCurrentNodeThinStorage(c.env, id, now);
  const rows = await c.env.DB.prepare(
    `SELECT d.*,COUNT(*) OVER() host_snapshot_count,s.storage_gib,a.node_uid startup_node_uid,a.storage_budget_bytes,a.operation_id startup_operation,
 (SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation,'status',stop.status) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation
 FROM databases d JOIN size_classes s ON s.id=d.size_class_id LEFT JOIN database_start_admissions a ON a.database_id=d.id AND a.generation=d.generation AND a.node_uid=? AND a.storage_budget_bytes>0 AND a.budget_bytes>0 AND a.ready_at IS NULL AND (d.storage_protected_at IS NULL OR d.storage_protected_generation<d.generation) WHERE d.node_id=? AND d.region_id=? AND (d.deleted_at IS NULL OR d.storage_profile_json IS NOT NULL) ORDER BY d.id`,
  )
    .bind(node.node_uid, id, region.id)
    .all<
      DatabaseRow & {
        storage_gib: number;
        stop_operation: string | null;
        host_snapshot_count: number;
        startup_node_uid: string | null;
        storage_budget_bytes: number | null;
        startup_operation: string | null;
      }
    >();
  if (
    rows.results.some((row) => row.host_snapshot_count !== rows.results.length)
  )
    throw new ApiError(
      "conflict",
      "Physical host database snapshot is incomplete",
    );
  const boot = current?.row.qualification_json
    ? (JSON.parse(current.row.qualification_json) as { boot_id?: string })
        .boot_id
    : undefined;
  const bootId =
    boot ??
    (await c.env.DB.prepare(
      "SELECT json_extract(p.observed_json,'$.boot_id') boot FROM fleet_patch_operations p WHERE p.node_id=? AND p.node_uid=? AND p.stage='complete' AND p.state='confirmed' AND p.error_code IS NULL ORDER BY p.updated_at DESC LIMIT 1",
    )
      .bind(id, node.node_uid)
      .first<string>("boot"));
  const poolCapable =
    (await postgresPoolCapable(c.env.DB, region.id)) ||
    (await postgresPoolQualificationCapable(c.env.DB, region.id));
  const preparations = poolCapable
    ? await (
        await import("./postgres-pool-preparation.ts")
      ).readPostgresPoolPreparationContexts(c.env, id, now)
    : [];
  if (!bootId && rows.results.some((row) => row.storage_profile_json))
    throw new ApiError(
      "conflict",
      "Current qualified physical boot unavailable",
    );
  const databases = [];
  const legacy = [];
  for (const row of rows.results) {
    if (!row.storage_profile_json) {
      legacy.push({
        database_id: row.id,
        generation: row.generation,
        namespace: `pgcf-db-${row.id}`,
      });
      continue;
    }
    const storage = DesiredDatabaseStorage.parse(
      JSON.parse(row.storage_profile_json),
    );
    const authority = current?.authority;
    const receipt = row.storage_volume_json
      ? DatabaseStorageVolumeReceipt.parse(JSON.parse(row.storage_volume_json))
      : null;
    // Tombstones are explicit: only completed deletion and a later complete Native absence
    // read can declare no volume. Missing/paginated rows never authorize protective-scope GC.
    // The absence read stays usable while its inventory is fresh, also once its short write
    // authority lapsed: after the last thin LV CSI removes the pool, and nothing samples it.
    const reclaimed = Boolean(
      row.deleted_at &&
      row.desired_state === "deleted" &&
      row.observed_state === "deleted" &&
      row.observed_generation === row.generation &&
      receipt &&
      thinStorageVolumeReclaimed(
        storage,
        authority ?? current?.reclamation,
        receipt.lv_uuid,
        Date.parse(row.deleted_at),
        now,
      ),
    );
    const writerProtected = storageWriterProtected(row, authority);
    const { readPostgresPoolBindingForDatabase, hasNonterminalPoolHolderSql } =
      await import("./postgres-pool.ts");
    const heldPool = await readPostgresPoolBindingForDatabase(c.env, row.id);
    const unresolvedPool =
      heldPool !== undefined ||
      Boolean(
        await c.env.DB.prepare(
          `SELECT 1 FROM databases d WHERE d.id=? AND ${hasNonterminalPoolHolderSql("d")}`,
        )
          .bind(row.id)
          .first(),
      );
    const pool = await poolHostCustodyForDatabase(
      c.env,
      row.id,
      poolCapable,
      now,
      true,
    );
    const poolMayWrite =
      !unresolvedPool ||
      (pool !== undefined &&
        pool.device !== null &&
        pool.holder_boot_id === bootId);
    // A parked database (D1: suspended, idle, hibernated) still holds its own Pod with PostgreSQL
    // stopped. The host guard stops the tasks and freezes the volume of any Pod whose entry is not
    // running with a valid token naming it, and it retires the previous holder when the next
    // generation starts without one. So the lease says "running" for this suspended database: no
    // write can happen (no postmaster, the gateway refuses), and the token exists only while the
    // controller's report is fresh and the node's own reading evidences exactly that Pod.
    const parkedAuthority =
      poolMayWrite &&
      !unresolvedPool &&
      row.desired_state === "suspended" &&
      row.parked_json
        ? await parkedStorageWriteAuthority(c.env, row, now, current)
        : undefined;
    const stop = row.stop_operation
      ? (JSON.parse(row.stop_operation) as {
          operation_id: string;
          kind: "database.suspend" | "database.hibernate" | "database.delete";
          generation: number;
          status: string;
        })
      : undefined;
    // The same holds while a sleep is being carried out: until its stop operation of this
    // generation is no longer pending or running, the Pod stopping PostgreSQL is the writer.
    const stoppingAuthority =
      parkedAuthority === undefined &&
      poolMayWrite &&
      !unresolvedPool &&
      stop !== undefined &&
      stop.kind !== "database.delete" &&
      stop.generation === row.generation &&
      (stop.status === "pending" || stop.status === "running")
        ? await stoppingStorageWriteAuthority(c.env, row, now, current)
        : undefined;
    const presentedRunning = parkedAuthority ?? stoppingAuthority;
    const runtimeAuthority =
      presentedRunning ??
      (poolMayWrite
        ? await storageWriteAuthorityForDatabase(c.env, row, now, current)
        : undefined);
    // Startup authority cannot substitute forever for missing IO evidence of a Ready writer.
    const readyWithoutWriter =
      row.desired_state === "running" &&
      row.observed_state === "ready" &&
      row.observed_generation === row.generation &&
      runtimeAuthority === undefined;
    const admitted =
      row.desired_state === "running" &&
      poolMayWrite &&
      (!unresolvedPool ||
        (["claimed", "mounted"].includes(pool!.state) &&
          runtimeAuthority !== undefined)) &&
      !writerProtected &&
      !readyWithoutWriter &&
      row.startup_operation !== null &&
      row.startup_node_uid === storage.node_uid &&
      row.storage_budget_bytes !== null &&
      row.storage_budget_bytes >=
        Math.max(storage.startup_reserve_bytes, row.storage_gib * 1024 ** 3) &&
      thinStorageAuthorityMatches(storage, authority, undefined, now);
    let drain:
      import("@pgcf/contracts/node-thin-storage").HostStorageDrain | null =
      null;
    // A sleep needs no drain: its Pod keeps writing under the token above until the stop ends.
    if (
      stop?.kind === "database.delete" &&
      !unresolvedPool &&
      receipt &&
      current?.row.current_qualified === 1 &&
      authority
    ) {
      await storageDrainReservationStatement(c.env.DB, {
        databaseId: row.id,
        operationId: stop.operation_id,
        generation: row.generation,
        nodeId: id,
        now: new Date(now).toISOString(),
      }).run();
      const hold = await c.env.DB.prepare(
        `SELECT h.storage_budget_bytes,h.storage_volume_json FROM database_start_admissions h JOIN databases d ON d.id=h.database_id JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id JOIN operations stop ON stop.id=h.operation_id WHERE h.operation_id=? AND h.budget_bytes=0 AND h.generation=d.generation AND h.node_id=n.id AND h.node_uid=n.node_uid AND ${currentStorageStopSql()} AND ${nodeThinStorageHeadroomSql("n", "s", "d")}`,
      )
        .bind(stop.operation_id)
        .first<{
          storage_budget_bytes: number;
          storage_volume_json: string | null;
        }>();
      if (
        hold &&
        knownStorageHoldVolume({
          binding: hold.storage_volume_json,
          current: row.storage_volume_json ?? null,
          profile: row.storage_profile_json,
          storageGeneration: row.storage_generation ?? 1,
          databaseId: row.id,
          authority,
          now,
        }) !== null
      ) {
        drain = {
          operation_id: stop.operation_id,
          kind: stop.kind,
          generation: stop.generation,
          authority_revision: authority.revision,
          expires_at: Math.min(
            Date.parse(authority.expires_at),
            now + current.profile.drain_seconds * 1000,
          ),
          budget_bytes: hold.storage_budget_bytes,
        };
      }
    }
    databases.push({
      database_id: row.id,
      generation: row.generation,
      authority_revision: current?.row.authority_revision ?? 0,
      write_blocked:
        drain !== null
          ? true
          : row.desired_state === "deleted"
            ? !reclaimed
            : writerProtected ||
              (unresolvedPool && runtimeAuthority === undefined) ||
              readyWithoutWriter ||
              !current ||
              current.row.error_code !== null ||
              current.row.status === "blocked",
      desired_state: presentedRunning ? "running" : row.desired_state,
      node_uid: storage.node_uid,
      volume_group_uuid: storage.volume_group_uuid,
      pool_uuid: storage.pool_uuid,
      profile_sha256: storage.profile_sha256,
      startup_expires_at:
        admitted && authority ? Date.parse(authority.expires_at) : null,
      startup_operation_id: admitted ? row.startup_operation : null,
      volume: reclaimed ? null : receipt,
      runtime_authority: runtimeAuthority ?? null,
      drain,
      ...(pool ? { pool } : {}),
    });
  }
  return c.json(
    HostStorageLease.parse({
      purpose: "pgcf-storage-host/v1",
      node_uid: node.node_uid,
      boot_id: bootId ?? null,
      material_revision: node.bootstrap_material_revision,
      issued_at: now,
      expires_at: now + 120000,
      legacy,
      databases,
      ...(preparations.length > 0 ? { preparations } : {}),
    }),
    200,
  );
}
