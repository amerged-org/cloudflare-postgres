// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseRuntimeAttestation,
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  base64urlToBytes,
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
  currentStartHoldSql,
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
    const current = readings[index] ?? null;
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

/** A start admission's hold on a database's volume, as `heldWriterPod` reads it. */
interface StartHold {
  node_id: string;
  node_uid: string;
  storage_budget_bytes: number;
  ready_at: string | null;
  completed_at: string | null;
  /** The runtime attestation of the controller's last accepted ready report for this start. */
  attested_json: string | null;
}

/**
 * Everything a writer decision reads besides the database's own row and the node's reading, for
 * every database one scope selects. One statement per kind serves a whole node, so what a lease or
 * a sample costs does not depend on how many databases the node has held.
 */
export interface WriterInputs {
  /** The non-terminal pool binding whose holder row agrees (readPostgresPoolBindingForDatabase). */
  bindings: ReadonlyMap<string, PoolBinding>;
  /** Databases with a pool binding or holder that is not terminal (hasNonterminalPoolHolderSql). */
  unresolved: ReadonlySet<string>;
  /** The startup holds that still debit storage, by `${database_id}:${generation}`. */
  holds: ReadonlyMap<string, StartHold>;
  /** The newest generation each database has a startup hold of: the start of its running Pod. */
  started: ReadonlyMap<string, number>;
  /** The pending or running wake and resume operations, by operation id. */
  wakes: ReadonlyMap<
    string,
    { database_id: string; project_id: string; generation: number }
  >;
}

/** A predicate over `databases d` and the values it binds. */
export interface DatabaseScope {
  sql: string;
  bindings: unknown[];
}

/**
 * The inputs of every database `scope` selects, read in one D1 batch. `rows`, when given, rides in
 * the same batch and its result is returned beside them.
 */
async function readWriterInputs<Row = never>(
  env: Pick<Env, "DB">,
  scope: DatabaseScope,
  rows?: D1PreparedStatement,
): Promise<{ rows: Row[]; inputs: WriterInputs }> {
  const { postgresPoolHoldersStatement, readPostgresPoolHolders } =
    await import("./postgres-pool.ts");
  const results = await env.DB.batch([
    ...(rows ? [rows] : []),
    postgresPoolHoldersStatement(env.DB, scope),
    env.DB.prepare(
      `SELECT h.database_id,h.generation,h.node_id,h.node_uid,h.storage_budget_bytes,h.ready_at,h.attested_json,CASE WHEN o.status='succeeded' THEN o.completed_at ELSE NULL END completed_at
      FROM databases d JOIN database_start_admissions h ON h.database_id=d.id JOIN operations o ON o.id=h.operation_id
      WHERE (${scope.sql}) AND h.budget_bytes>0 AND h.storage_budget_bytes>0`,
    ).bind(...scope.bindings),
    env.DB.prepare(
      `SELECT o.id,o.database_id,o.project_id,o.generation FROM databases d JOIN operations o ON o.id=d.power_operation
      WHERE (${scope.sql}) AND o.kind IN('database.wake','database.resume') AND o.status IN('pending','running')`,
    ).bind(...scope.bindings),
  ]);
  const [selected, holders, holds, wakes] = (
    rows ? results : [undefined, ...results]
  ) as [
    D1Result<Row> | undefined,
    D1Result<Record<string, unknown>>,
    D1Result<StartHold & { database_id: string; generation: number }>,
    D1Result<{
      id: string;
      database_id: string;
      project_id: string;
      generation: number;
    }>,
  ];
  const started = new Map<string, number>();
  for (const hold of holds.results)
    started.set(
      hold.database_id,
      Math.max(started.get(hold.database_id) ?? 0, hold.generation),
    );
  return {
    rows: selected?.results ?? [],
    inputs: {
      ...(await readPostgresPoolHolders(holders.results)),
      holds: new Map(
        holds.results.map((hold) => [
          `${hold.database_id}:${hold.generation}`,
          hold,
        ]),
      ),
      started,
      wakes: new Map(wakes.results.map((wake) => [wake.id, wake])),
    },
  };
}

type NodeReading = Awaited<ReturnType<typeof readCurrentNodeThinStorage>>;
/** What one pass over a node's databases shares: the instant, the inputs, the node's reading and
 * the signing key, each obtained once. */
interface WriterContext {
  env: Env;
  now: number;
  inputs: WriterInputs;
  /** The reading the caller supplied; absent, it is read when a decision first needs it. */
  snapshot: NodeReading | undefined;
  node(nodeId: string): Promise<NodeReading>;
  key(): ReturnType<typeof nodeProofSigningKey>;
}
/** `reading` is the node's reading when the caller has one (also an absent one: null). */
function writerContext(
  env: Env,
  now: number,
  inputs: WriterInputs,
  reading?: NodeReading,
): WriterContext {
  const readings = new Map<string, Promise<NodeReading>>();
  let key: ReturnType<typeof nodeProofSigningKey> | undefined;
  return {
    env,
    now,
    inputs,
    snapshot: reading,
    node(nodeId) {
      if (reading !== undefined) return Promise.resolve(reading);
      let read = readings.get(nodeId);
      if (!read) {
        read = readCurrentNodeThinStorage(env, nodeId, now);
        readings.set(nodeId, read);
      }
      return read;
    },
    key: () => (key ??= nodeProofSigningKey(env)),
  };
}

/**
 * The controller's attestation of a database's Pod: its latest word, `databases.runtime_attestation_json`,
 * and only when that is absent (a ready report without one clears it) the one the start's hold
 * remembers from its last accepted ready report.
 */
function attestationOf(database: DatabaseRow, hold: StartHold | undefined) {
  const raw = database.runtime_attestation_json ?? hold?.attested_json;
  return DatabaseRuntimeAttestation.safeParse(raw ? JSON.parse(raw) : null);
}

/** A new writer without IO evidence yet (section 8 of thin-authority-renewal.md): its current
 * startup hold debits at least the LV's virtual size until a later identity proof shows the Pod's
 * io.max, and the controller's runtime attestation names the Pod together with the receipt's
 * identities, the cluster and the identity proof's boot.
 *
 * `since` is the generation the hold and the Pod were started for. The row's generation may have
 * advanced past it without any start (a role change or a password reset): the attestation of that
 * start or of a later generation, and the hold of that start, then still name the writer. At the
 * row's own generation, the default, it is a start of this very generation. */
function heldWriterPod(
  inputs: WriterInputs,
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
  since = database.generation,
): string | undefined {
  const lv = authority.physical_lvs.find(
      (value) => value.lv_uuid === receipt.lv_uuid && value.segtype === "thin",
    ),
    hold = inputs.holds.get(`${database.id}:${since}`),
    attestation = attestationOf(database, hold),
    boot = qualification
      ? (JSON.parse(qualification) as { boot_id?: unknown }).boot_id
      : undefined;
  if (!lv || !attestation.success) return undefined;
  const runtime = attestation.data;
  if (
    runtime.generation < since ||
    runtime.generation > database.generation ||
    database.observed_generation < runtime.generation ||
    runtime.database_id !== database.id ||
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
  if (
    !hold ||
    hold.node_id !== database.node_id ||
    hold.node_uid !== storage.node_uid ||
    hold.storage_budget_bytes < lv.size_bytes
  )
    return undefined;
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
async function currentWriterContext(c: WriterContext, database: DatabaseRow) {
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
  const current = await c.node(database.node_id);
  const authority = current?.authority;
  if (
    !thinStorageAuthorityMatches(storage, authority, undefined, c.now) ||
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
  c: WriterContext,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  pod: string,
) {
  const key = await c.key();
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
  return signStorageWriteAuthority(claims, key.privateKey, c.now);
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
function parkedHolder(
  c: WriterContext,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
): string | undefined {
  const parked = readParkedRecord(database.parked_json);
  if (
    !parked ||
    database.observed_power !== "hibernated" ||
    database.deleted_at !== null ||
    !parkedRecordFresh(parked, c.now)
  )
    return undefined;
  if (database.desired_state === "suspended") {
    // Parked steady state: only an idle sleep is parked; an explicit suspension is a real stop.
    if (database.suspension_reason !== "idle") return undefined;
  } else if (database.desired_state === "running") {
    // Waking from parked. Once the guard accepted a token for this Pod at the wake's generation it
    // holds the Pod as that generation's writer and refuses a replacement Pod until a newer one.
    // So the token only goes with the controller's claim that every predicate of the fast wake
    // holds, for the wake that directly follows the reported sleep (its operation is of the
    // generation after the parked one; the row may be ahead of it by role changes, which start
    // nothing). Any other wake is ordinary: no token for the parked Pod, the guard retires it
    // with the startup and the controller demotes.
    const wake = c.inputs.wakes.get(database.power_operation ?? "");
    if (
      parked.wake !== "fast" ||
      !wake ||
      wake.database_id !== database.id ||
      wake.project_id !== database.project_id ||
      wake.generation !== parked.generation + 1 ||
      wake.generation > database.generation
    )
      return undefined;
  } else return undefined;
  return evidencedWriter(database, storage, receipt, authority) ===
    parked.pod_uid
    ? parked.pod_uid
    : undefined;
}

/**
 * The writer of a generation that started nothing, by the node's reading of an earlier generation.
 * A role change, a password reset or a role removal advances the row's generation while the Pod
 * keeps running, and the node's identity proof names the database at the generation it was
 * prepared for, up to a minute and a half later: the token of the new generation would otherwise be
 * missing, the guard stops the Pod that holds the previous one, and the controller cannot ready the
 * database without it.
 *
 * Every start of a Pod has a startup hold of its generation, so while no hold is newer than the
 * node's reading, that reading still names the one Pod on the volume.
 */
function continuedWriter(
  c: WriterContext,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  reading: NodeThinStorageAuthority["volumes"][number] | undefined,
): string | undefined {
  if (!reading || reading.generation >= database.generation) return undefined;
  const started = c.inputs.started.get(database.id);
  if (started !== undefined && started > reading.generation) return undefined;
  return evidencedWriter(database, storage, receipt, authority);
}

/**
 * The signed writer token of a database that is meant to be running, from the node's reading and
 * the inputs of `c`. One computation serves the host lease, the fast sample's tokens and the
 * desired page.
 */
async function runningWriterAuthority(
  c: WriterContext,
  database: DatabaseRow,
): Promise<string | undefined> {
  const pool = c.inputs.bindings.get(database.id);
  if (pool && !["released", "refused"].includes(pool.state))
    return issuePostgresPoolStorageAuthority(c.env, pool, c.now, c.snapshot);
  if (c.inputs.unresolved.has(database.id)) return undefined;
  if (database.desired_state !== "running") return undefined;
  const context = await currentWriterContext(c, database);
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
  // or the parked Pod that a wake of this very generation reuses. A generation that started
  // nothing (a role change, a password reset) continues the writer of the start before it, as
  // the node's earlier reading and the controller's attestation of that start name it. When the
  // two name different Pods, nothing is the writer.
  const started = c.inputs.started.get(database.id);
  let pod = io?.pod_uid;
  if (pod === undefined) {
    // A protective stop is released by a start of its own, never by a generation that started
    // nothing: while its marker stands, no writer is carried across one.
    const marked = database.storage_protected_at != null;
    // The reading of an earlier generation, when none is of this one.
    const earlier = volume
        ? undefined
        : authority.volumes.find(
            (value) =>
              value.database_id === database.id &&
              value.storage_generation === receipt.storage_generation,
          ),
      held =
        marked && (started ?? database.generation) < database.generation
          ? undefined
          : heldWriterPod(
              c.inputs,
              database,
              storage,
              receipt,
              authority,
              current!.row.qualification_json,
              volume ?? earlier,
              started ?? database.generation,
            ),
      continued = marked
        ? undefined
        : continuedWriter(c, database, storage, receipt, authority, earlier);
    if (held !== undefined && continued !== undefined && held !== continued)
      return undefined;
    const attested = attestationOf(
      database,
      started === undefined
        ? undefined
        : c.inputs.holds.get(`${database.id}:${started}`),
    );
    pod =
      held ??
      parkedHolder(c, database, storage, receipt, authority) ??
      (attested.success &&
      continued !== undefined &&
      attested.data.pod_uid !== continued
        ? undefined
        : continued);
  }
  if (!pod) return undefined;
  return signStorageWriter(c, database, storage, receipt, authority, pod);
}

/** The signed writer of one database, read for it alone: the desired page and single decisions.
 * `snapshot` is the node's reading when the caller has one. */
export async function storageWriteAuthorityForDatabase(
  env: Env,
  database: DatabaseRow,
  now = Date.now(),
  snapshot?: NodeReading,
): Promise<string | undefined> {
  const { inputs } = await readWriterInputs(env, {
    sql: "d.id=?",
    bindings: [database.id],
  });
  return runningWriterAuthority(
    writerContext(env, now, inputs, snapshot),
    database,
  );
}

/**
 * The writer a sleep's window continues: the running authority's own sources at the generation the
 * Pod was started for (the sleep bumped the row's generation from it). The node's single measured
 * Pod, or while no reading has measured one yet, the held writer: the startup hold plus the
 * controller's attestation of that start. Both have to name the same Pod, and a frozen volume or a
 * second measured Pod names none.
 */
function stoppingWriter(
  inputs: WriterInputs,
  database: DatabaseRow,
  storage: DesiredDatabaseStorage,
  receipt: DatabaseStorageVolumeReceipt,
  authority: NodeThinStorageAuthority,
  qualification: string | null,
): string | undefined {
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
  const started = inputs.started.get(database.id);
  const held =
    started === undefined
      ? undefined
      : heldWriterPod(
          inputs,
          database,
          storage,
          receipt,
          authority,
          qualification,
          volume,
          started,
        );
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
  c: WriterContext,
  database: DatabaseRow,
): Promise<string | undefined> {
  if (database.desired_state !== "suspended") return undefined;
  const context = await currentWriterContext(c, database);
  if (!context) return undefined;
  const { storage, receipt, authority, current } = context;
  const pod = stoppingWriter(
    c.inputs,
    database,
    storage,
    receipt,
    authority,
    current!.row.qualification_json,
  );
  if (!pod) return undefined;
  return signStorageWriter(c, database, storage, receipt, authority, pod);
}

/**
 * For the host lease only: the writer token of a database that sleeps parked. The guard freezes
 * the volume and stops the tasks of any Pod whose entry is not a running one with a valid token
 * naming it, so a parked Pod has to be presented as the running writer it physically is.
 * Never used for desired state or headroom responses: nothing else may hold a token for it.
 * The caller has excluded every unresolved pool holder.
 */
async function parkedStorageWriteAuthority(
  c: WriterContext,
  database: DatabaseRow,
): Promise<string | undefined> {
  if (database.desired_state !== "suspended" || !database.parked_json)
    return undefined;
  const context = await currentWriterContext(c, database);
  if (!context) return undefined;
  const { storage, receipt, authority } = context;
  const pod = parkedHolder(c, database, storage, receipt, authority);
  if (!pod) return undefined;
  return signStorageWriter(c, database, storage, receipt, authority, pod);
}

/**
 * The writer token of every running thin database of a node: one reading of the node and one read
 * per kind of input, whatever the number of databases. It is the fast sample's token loop.
 */
export async function runningWriterTokens(
  env: Env,
  nodeId: string,
  regionId: string,
  now: number,
): Promise<{ database_id: string; token: string }[]> {
  const scope: DatabaseScope = {
    sql: "d.node_id=? AND d.region_id=? AND d.storage_profile_json IS NOT NULL AND d.storage_volume_json IS NOT NULL AND d.desired_state='running' AND d.deleted_at IS NULL",
    bindings: [nodeId, regionId],
  };
  const [current, read] = await Promise.all([
    readCurrentNodeThinStorage(env, nodeId, now),
    readWriterInputs<DatabaseRow>(
      env,
      scope,
      env.DB.prepare(
        `SELECT d.* FROM databases d WHERE ${scope.sql} ORDER BY d.id`,
      ).bind(...scope.bindings),
    ),
  ]);
  const writers = writerContext(env, now, read.inputs, current),
    tokens: { database_id: string; token: string }[] = [];
  for (const database of read.rows) {
    const token = await runningWriterAuthority(writers, database);
    if (token) tokens.push({ database_id: database.id, token });
  }
  return tokens;
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
  const { readPostgresPoolBindingForDatabase } =
    await import("./postgres-pool.ts");
  const binding = await readPostgresPoolBindingForDatabase(env, id);
  return binding ? poolHostCustody(env, binding, now, issueCleanup) : undefined;
}
/** The custody of a database's non-terminal pool holder, whose binding the caller has read. */
async function poolHostCustody(
  env: Env,
  binding: PoolBinding,
  now: number,
  issueCleanup: boolean,
): Promise<PoolHostCustody> {
  const { readPostgresPoolIoAttestation } = await import("./postgres-pool.ts");
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
/**
 * How long a confirmed deletion stays in the lease, counted from the row's last change, which is
 * the confirmation: the controller's deleted report is accepted only against a fresh absence read.
 *
 * The guard forgets a retained signed scope only from an accepted lease that names the database
 * deleted, writable and without a volume (`retirement_scope`, sandbox-controller storage.rs:500-529)
 * and acts on it in its next 100 ms supervise tick (storage.rs:878), once the Pod's tasks are
 * recorded stopped, which `stop_pod_tasks` bounds to well under a second (controller.rs:1025-1080).
 * It fetches the lease once per cycle of at most the client's 5 s timeout (policy.rs:487) plus a 1 s
 * sleep (storage.rs:633), and keeps a lease for at most 120 s (storage.rs:196). A guard that is
 * connected therefore retires on the first lease that says so, within seven seconds, and one that
 * was cut off for up to a lease's life needs one fetch after it. A longer cut-off has stopped every
 * Pod already, and when it ends the guard still needs the entry: Cloudflare cannot see the
 * retirement, so the entry is served for an hour, long enough for a node reboot of a fleet patch and
 * the confirmation of its new boot, and bounded by the deletions of that hour.
 */
export const HOST_LEASE_TOMBSTONE_RETENTION_MS = 60 * 60_000;

/**
 * The databases of a node the host guard is told about: every live one, and each deleted one a
 * signed scope of the guard may still exist for. A scope exists only for a database a token was
 * signed for, which needs a bound volume receipt (`currentWriterContext`), and it ends with the
 * guard's retirement, which the retention above covers. A deleted database's entry also stays
 * while its deletion is unconfirmed: it blocks writes and carries the delete drain.
 */
function hostLeaseScope(
  nodeId: string,
  regionId: string,
  now: number,
): DatabaseScope {
  return {
    sql: `d.node_id=? AND d.region_id=? AND (d.deleted_at IS NULL OR (d.storage_profile_json IS NOT NULL AND d.storage_volume_json IS NOT NULL
      AND NOT (d.observed_state='deleted' AND d.observed_generation=d.generation AND julianday(d.updated_at)<julianday(?))))`,
    bindings: [
      nodeId,
      regionId,
      new Date(now - HOST_LEASE_TOMBSTONE_RETENTION_MS).toISOString(),
    ],
  };
}
type LeaseRow = DatabaseRow & {
  storage_gib: number;
  stop_operation: string | null;
  host_snapshot_count: number;
  startup_node_uid: string | null;
  storage_budget_bytes: number | null;
  startup_operation: string | null;
};
/** The seconds a signed writer token is still valid, to a tenth; null when it cannot be read. */
function tokenLifeSeconds(token: string | null, now: number): number | null {
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(base64urlToBytes(token!.split(".")[1]!)!),
    ) as { exp?: unknown };
    return typeof claims.exp === "number"
      ? Math.round((claims.exp - now) / 100) / 10
      : null;
  } catch {
    return null;
  }
}
/** What `storage_guard_served` tells about each live entry, so a persisted log can be lined up
 * with the guard's actions second by second. No token or other secret is part of it. */
const LEASE_LOG_LIVE_ENTRIES = 20;

export async function hostStorageLease(
  c: import("../env.ts").ApiContext,
  id: string,
) {
  const started = Date.now();
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
  // Every read the lease needs is independent of the others, and none is made per database: the
  // node's reading, one batch for its databases and their inputs, and the pool capability.
  const scope = hostLeaseScope(id, region.id, now);
  const [current, read, poolCapable] = await Promise.all([
    readCurrentNodeThinStorage(c.env, id, now),
    readWriterInputs<LeaseRow>(
      c.env,
      scope,
      c.env.DB.prepare(
        `SELECT d.*,COUNT(*) OVER() host_snapshot_count,s.storage_gib,a.node_uid startup_node_uid,a.storage_budget_bytes,a.operation_id startup_operation,
 (SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation,'status',stop.status) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation
 FROM databases d JOIN size_classes s ON s.id=d.size_class_id LEFT JOIN database_start_admissions a ON ${currentStartHoldSql()} AND a.node_uid=? WHERE ${scope.sql} ORDER BY d.id`,
      ).bind(node.node_uid, ...scope.bindings),
    ),
    Promise.all([
      postgresPoolCapable(c.env.DB, region.id),
      postgresPoolQualificationCapable(c.env.DB, region.id),
    ]).then(([normal, qualification]) => normal || qualification),
  ]);
  const rows = read.rows;
  if (rows.some((row) => row.host_snapshot_count !== rows.length))
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
  const preparations = poolCapable
    ? await (
        await import("./postgres-pool-preparation.ts")
      ).readPostgresPoolPreparationContexts(c.env, id, now)
    : [];
  if (!bootId && rows.some((row) => row.storage_profile_json))
    throw new ApiError(
      "conflict",
      "Current qualified physical boot unavailable",
    );
  const writers = writerContext(c.env, now, read.inputs, current);
  const databases = [];
  const legacy = [];
  for (const row of rows) {
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
    const heldPool = read.inputs.bindings.get(row.id);
    const unresolvedPool = read.inputs.unresolved.has(row.id);
    const pool =
      poolCapable && heldPool
        ? await poolHostCustody(c.env, heldPool, now, true)
        : undefined;
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
        ? await parkedStorageWriteAuthority(writers, row)
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
        ? await stoppingStorageWriteAuthority(writers, row)
        : undefined;
    const presentedRunning = parkedAuthority ?? stoppingAuthority;
    const runtimeAuthority =
      presentedRunning ??
      (poolMayWrite ? await runningWriterAuthority(writers, row) : undefined);
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
  const lease = HostStorageLease.parse({
    purpose: "pgcf-storage-host/v1",
    node_uid: node.node_uid,
    boot_id: bootId ?? null,
    material_revision: node.bootstrap_material_revision,
    issued_at: now,
    expires_at: now + 120000,
    legacy,
    databases,
    ...(preparations.length > 0 ? { preparations } : {}),
  });
  const served = Date.now();
  const parked = new Set(
    rows.filter((row) => row.parked_json).map((row) => row.id),
  );
  const live = lease.databases.filter(
    (entry) => entry.desired_state !== "deleted",
  );
  console.log(
    JSON.stringify({
      event: "storage_guard_served",
      node_id: id,
      entries: lease.databases.length,
      tombstones: lease.databases.length - live.length,
      elapsed_ms: served - started,
      live: live.slice(0, LEASE_LOG_LIVE_ENTRIES).map((entry) => ({
        id: entry.database_id.slice(0, 6),
        generation: entry.generation,
        write_blocked: entry.write_blocked,
        token: entry.runtime_authority !== null,
        token_life_s: tokenLifeSeconds(entry.runtime_authority, served),
        startup_valid:
          entry.startup_expires_at !== null &&
          entry.startup_expires_at > served,
        parked: parked.has(entry.database_id),
      })),
    }),
  );
  return c.json(lease, 200);
}
