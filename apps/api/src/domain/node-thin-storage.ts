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
import { allOf } from "./sql-conjunction.ts";
import { thinStorageSamplingProtocolCapable } from "./fleet-releases.ts";
import { hotLogDue } from "./log-sampling.ts";
import { parkedRecordFresh, readParkedRecord } from "./parked-tier.ts";
import {
  currentStorageStopSql,
  storageDrainReservationStatement,
  nodeThinStorageHeadroomSql,
  knownStorageHoldVolume,
} from "./storage-capacity.ts";

/** How tightly a node's authority is bound to the assigned release: see qualifiedThinStorageSql. */
export type ThinQualification = "strict" | "continuing";

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

/**
 * Whether a node's authority names the release, host custody and boot it was proven with.
 *
 * `strict` binds the proof, the controller's observation and the node's own completed patch to the
 * assigned release by label: its id, spec hash, assignment revision and region revision. Placement,
 * wake, hold release, deletion proofs and qualification admit new Pods or confirm absences, and
 * stay behind it.
 *
 * `continuing` keeps every fact the labels stood for (the receipt's facts, the authority keys, the
 * host custody, the boot, the node, the cluster and the material) and drops the labels. It asks
 * three things of releases instead: the node's completed patch and the release its proof was read
 * under pin the same thin facts as the assigned release (`fleet_releases.thin_continuity`), and
 * no later patch of the node, in any state, pins others. A rollout that changes a pinned fact is
 * strict from its assignment, and so is a rollback after one: the node runs the other facts until
 * its own patch completed and a proof read it. `continuing` renews and delivers the authority of
 * a writer that already runs, and is implied by `strict`.
 */
export function qualifiedThinStorageSql(
  alias = "t",
  mode: ThinQualification = "strict",
) {
  if (!/^[a-z][a-z0-9_]*$/.test(alias))
    throw new Error("invalid_thin_authority_alias");
  const strict = mode === "strict",
    // The controller observes a new assignment up to two periods after it is made.
    seconds = strict ? 180 : 300,
    proof = (field: string) =>
      `json_extract(${alias}.qualification_json,'$.${field}')`,
    receipt = (field: string) =>
      `json_extract(qs.spec_json,'$.thin_storage_qualification.${field}')`,
    keys = "json_extract(qs.spec_json,'$.storage_authority_keys_sha256')";
  const conjuncts = [
    // The tables are one row each: the node, its assignment, the custody and the controller's view.
    "qr.id=qn.region_id",
    "qa.node_id=qn.id",
    "qf.region_id=qn.region_id",
    "qs.id=qa.release_id",
    "qh.node_id=qn.id",
    "qh.node_uid=qn.node_uid",
    "qo.node_id=qn.id",
    "qo.node_uid=qn.node_uid",
    ...(strict ? ["qo.assignment_revision=qa.revision"] : []),
    "qo.agent_key_hash=qr.agent_key_hash",
    ...(strict
      ? []
      : ["qps.id=qp.release_id", `qrp.id=${proof("release_id")}`]),
    "json_extract(qverifier.value,'$.name')='native-gateway'",
    "json_extract(qverifier.value,'$.kind')='image'",
    "qgatewayrole.value='native-gateway'",
    // The node, its assignment and the material it was proven under.
    `qn.id=${alias}.node_id`,
    `qn.node_uid=${alias}.node_uid`,
    "qn.ready=1",
    "qn.lost_at IS NULL",
    "qa.node_uid=qn.node_uid",
    "qa.release_id=qf.release_id",
    `qr.bootstrap_material_revision=${alias}.material_revision`,
    `length(${keys})=64`,
    `${keys} NOT GLOB '*[^0-9a-f]*'`,
    // The host custody and the boot the controller sees.
    ...(strict ? ["qh.release_id=qs.id"] : []),
    `qh.cluster_uid=${alias}.cluster_uid`,
    `qh.material_revision=${alias}.material_revision`,
    `json_extract(qo.facts_json,'$.boot_id')=${proof("boot_id")}`,
    `julianday(qo.observed_at)>=julianday('now','-${seconds} seconds')`,
    "julianday(qo.observed_at)<=julianday('now','+5 seconds')",
    `julianday(qo.received_at)>=julianday('now','-${seconds} seconds')`,
    "julianday(qo.received_at)<=julianday('now','+5 seconds')",
    // The proof names the profile and the receipt's software.
    `${proof("profile_revision")}=${alias}.profile_revision`,
    `${proof("profile_sha256")}=${receipt("profile_sha256")}`,
    ...(strict
      ? [
          `${proof("release_id")}=qs.id`,
          `${proof("spec_sha256")}=qs.spec_sha256`,
          `${proof("assignment_revision")}=qa.revision`,
          `${proof("region_revision")}=qf.revision`,
        ]
      : []),
    `${receipt("driver_image")}=${alias}.qualified_driver_image`,
    `${receipt("host_extension_image")}=${proof("software.host_extension_image")}`,
    `${receipt("kernel_version")}=${proof("software.kernel_version")}`,
    `${proof("software.host_configuration_sha256")}=qh.sha256`,
    // The node's own completed patch, at the assigned release or at one that pins the same facts.
    "qp.node_id=qn.id",
    "qp.node_uid=qn.node_uid",
    `qp.cluster_uid=${alias}.cluster_uid`,
    `qp.material_revision=${alias}.material_revision`,
    ...(strict
      ? [
          "qp.release_id=qs.id",
          "qp.spec_sha256=qs.spec_sha256",
          "qp.assignment_revision=qa.revision",
          "qp.region_revision=qf.revision",
          "qp.host_configuration_revision=qh.revision",
        ]
      : []),
    "qp.stage='complete'",
    "qp.state='confirmed'",
    "qp.error_code IS NULL",
    "qp.host_configuration_sha256=qh.sha256",
    "json_extract(qp.observed_json,'$.host_configuration_sha256')=qh.sha256",
    ...(strict
      ? [
          "json_extract(qp.observed_json,'$.runtime_admission_sha256')=qh.profile_sha256",
        ]
      : []),
    "json_extract(qp.observed_json,'$.node_ready')=1",
    `json_extract(qp.observed_json,'$.boot_id')=${proof("boot_id")}`,
    ...(strict
      ? []
      : [
          // The proof and the patch are of releases that pin the assigned release's facts.
          "qrp.thin_continuity=qs.thin_continuity",
          "qps.thin_continuity=qs.thin_continuity",
          // And no later patch of the node pins others: the node would run them.
          `NOT EXISTS(SELECT 1 FROM fleet_patch_operations qx,fleet_releases qxs WHERE ${allOf(
            "qxs.id=qx.release_id",
            "qx.node_id=qn.id",
            "qx.node_uid=qn.node_uid",
            "qx.rowid>qp.rowid",
            "qxs.thin_continuity IS NOT qs.thin_continuity",
          )})`,
        ]),
  ];
  // Inner joins only. Their terms sit in the one balanced tree below: SQLite chains the terms of
  // a join list into one left-deep expression, and this predicate is embedded in statements that
  // already nest deeply.
  return `EXISTS(SELECT 1 FROM nodes qn,regions qr,fleet_node_releases qa,fleet_region_releases qf,fleet_releases qs,node_host_configurations qh,fleet_node_release_observations qo,fleet_patch_operations qp${strict ? "" : ",fleet_releases qps,fleet_releases qrp"},json_each(qs.spec_json,'$.components') qverifier,json_each(qs.spec_json,'$.roles.'||qa.role||'.components') qgatewayrole
    WHERE ${allOf(...conjuncts)})`;
}

/** A node's thin storage row as one read returns it, with what the node itself says about it. */
export type CurrentNodeThinStorageRow = NodeThinStorageRow & {
  region_id: string;
  k8s_node_name: string;
  current_node_uid: string | null;
  ready: number;
  lost_at: string | null;
  current_qualified: number;
};

/**
 * The node as it is now. `continuing` is for the callers that renew or deliver the authority of a
 * writer that already runs; the default, `strict`, is for every caller that admits a Pod or reads
 * the node as fully qualified for its assignment.
 */
export async function readCurrentNodeThinStorage(
  env: Pick<Env, "DB">,
  nodeId: string,
  now = Date.now(),
  mode: ThinQualification = "strict",
) {
  const row = await env.DB.prepare(
    `SELECT t.*,n.region_id,n.k8s_node_name,n.node_uid current_node_uid,n.ready,n.lost_at,CASE WHEN ${qualifiedThinStorageSql("t", mode)} THEN 1 ELSE 0 END current_qualified FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE t.node_id=?`,
  )
    .bind(nodeId)
    .first<CurrentNodeThinStorageRow>();
  return row ? nodeReading(row, now) : null;
}

/**
 * What a row says at `now`: its profile, the authority it hands out and the one that still proves
 * an absence. A pure function of the row, so a row the caller has just written itself reads the
 * same as the same row read back.
 */
export function nodeReading(row: CurrentNodeThinStorageRow, now: number) {
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
    thinStorageSamplingProtocolCapable(env.DB, regionId),
    env.DB.prepare(
      "SELECT t.node_id FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE n.region_id=? ORDER BY n.id",
    )
      .bind(regionId)
      .all<{ node_id: string }>(),
  ]);
  const readings = await Promise.all(
    rows.results.map((row) =>
      readCurrentNodeThinStorage(env, row.node_id, now, "continuing"),
    ),
  );
  const nodes: NodeThinStorageAuthority[] = [],
    snapshots = new Map<string, (typeof readings)[number]>();
  rows.results.forEach((row, index) => {
    const current = readings[index] ?? null;
    snapshots.set(row.node_id, current);
    const proof = current?.authority ?? current?.reclamation;
    if (proof && samplingCapable) nodes.push(proof);
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
  const results = await env.DB.batch([
    ...(rows ? [rows] : []),
    env.DB.prepare(
      `SELECT h.*,CASE WHEN o.status='succeeded' THEN o.completed_at ELSE NULL END completed_at
      FROM databases d JOIN database_start_admissions h ON h.database_id=d.id JOIN operations o ON o.id=h.operation_id
      WHERE (${scope.sql}) AND h.budget_bytes>0 AND h.storage_budget_bytes>0`,
    ).bind(...scope.bindings),
    env.DB.prepare(
      `SELECT o.id,o.database_id,o.project_id,o.generation FROM databases d JOIN operations o ON o.id=d.power_operation
      WHERE (${scope.sql}) AND o.kind IN('database.wake','database.resume') AND o.status IN('pending','running')`,
    ).bind(...scope.bindings),
  ]);
  const [selected, holds, wakes] = (
    rows ? results : [undefined, ...results]
  ) as [
    D1Result<Row> | undefined,
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
        read = readCurrentNodeThinStorage(env, nodeId, now, "continuing");
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
    // The reading of an earlier generation, when none is of this one.
    const earlier = volume
        ? undefined
        : authority.volumes.find(
            (value) =>
              value.database_id === database.id &&
              value.storage_generation === receipt.storage_generation,
          ),
      // A protective stop is released by a start of its own, never by a generation that started
      // nothing: while its marker stands or the volume was read frozen, no writer is carried.
      marked =
        database.storage_protected_at != null || earlier?.quiesced === true,
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
 * The writer token of every running thin database of a node: one reading of the node and one read
 * per kind of input, whatever the number of databases. It is the fast sample's token loop.
 * `reading` is the node's reading when the caller holds it already; the fast sample does, from the
 * row its own compare-and-set has just written.
 */
export async function runningWriterTokens(
  env: Env,
  nodeId: string,
  regionId: string,
  now: number,
  reading?: NodeReading,
): Promise<{ database_id: string; token: string }[]> {
  const scope: DatabaseScope = {
    sql: "d.node_id=? AND d.region_id=? AND d.storage_profile_json IS NOT NULL AND d.storage_volume_json IS NOT NULL AND d.desired_state='running' AND d.deleted_at IS NULL",
    bindings: [nodeId, regionId],
  };
  const [current, read] = await Promise.all([
    reading === undefined
      ? readCurrentNodeThinStorage(env, nodeId, now, "continuing")
      : reading,
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
  host_snapshot_count: number;
  stop_operation: string | null;
};
/** The operation that created a database's archive: one stable id per database, whatever its
 * generation, so the guard's startup-bound resume of a retained scope happens once. */
function creationOperation(archivePath: string) {
  return /-(op_[a-z0-9]{20})$/.exec(archivePath)?.[1] ?? null;
}

/**
 * The host guard's lease (GET /agent/v1/nodes/:id/storage-guard). Exactly one writer per volume is
 * the holder rule of the attach agent, never this lease, and no running writer is stopped for
 * storage. So every live thin database of the node is permitted through its startup window, and
 * one generation past D1's: the guard resumes a scope it retained once and carries no stale token
 * forward. Neither the node's reading, its write permission nor the database's sleep enters it.
 * Deleted databases keep their tombstone and delete drain until the guard retires them.
 */
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
    now = Date.now(),
    expiresAt = now + 120000;
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
  const scope = hostLeaseScope(id, region.id, now);
  const [current, read] = await Promise.all([
    readCurrentNodeThinStorage(c.env, id, now, "continuing"),
    c.env.DB.prepare(
      `SELECT d.*,COUNT(*) OVER() host_snapshot_count,
 (SELECT json_object('operation_id',stop.id,'kind',stop.kind,'generation',stop.generation,'status',stop.status) FROM operations stop WHERE ${currentStorageStopSql()} ORDER BY stop.created_at DESC LIMIT 1) stop_operation
 FROM databases d WHERE ${scope.sql} ORDER BY d.id`,
    )
      .bind(...scope.bindings)
      .all<LeaseRow>(),
  ]);
  const rows = read.results;
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
  if (!bootId && rows.some((row) => row.storage_profile_json))
    throw new ApiError(
      "conflict",
      "Current qualified physical boot unavailable",
    );
  const authority = current?.authority;
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
    // A volume bound on another node identity was never this host's.
    if (storage.node_uid !== node.node_uid) continue;
    const receipt = row.storage_volume_json
      ? DatabaseStorageVolumeReceipt.parse(JSON.parse(row.storage_volume_json))
      : null;
    const identity = {
      database_id: row.id,
      authority_revision: current?.row.authority_revision ?? 0,
      node_uid: storage.node_uid,
      volume_group_uuid: storage.volume_group_uuid,
      pool_uuid: storage.pool_uuid,
      profile_sha256: storage.profile_sha256,
      runtime_authority: null,
    };
    if (row.desired_state !== "deleted") {
      const startup = creationOperation(row.archive_path);
      databases.push({
        ...identity,
        generation: row.generation + 1,
        write_blocked: false,
        desired_state: "running" as const,
        startup_expires_at: startup ? expiresAt : null,
        startup_operation_id: startup,
        volume: receipt,
        drain: null,
      });
      continue;
    }
    // Tombstones are explicit: only completed deletion and a later complete Native absence
    // read can declare no volume. Missing/paginated rows never authorize protective-scope GC.
    // The absence read stays usable while its inventory is fresh, also once its short write
    // authority lapsed: after the last thin LV CSI removes the pool, and nothing samples it.
    const reclaimed = Boolean(
      row.deleted_at &&
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
    const stop = row.stop_operation
      ? (JSON.parse(row.stop_operation) as {
          operation_id: string;
          kind: "database.suspend" | "database.hibernate" | "database.delete";
          generation: number;
          status: string;
        })
      : undefined;
    let drain:
      import("@pgcf/contracts/node-thin-storage").HostStorageDrain | null =
      null;
    if (
      stop?.kind === "database.delete" &&
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
      ...identity,
      generation: row.generation,
      write_blocked: drain !== null || !reclaimed,
      desired_state: row.desired_state,
      startup_expires_at: null,
      startup_operation_id: null,
      volume: reclaimed ? null : receipt,
      drain,
    });
  }
  const lease = HostStorageLease.parse({
    purpose: "pgcf-storage-host/v1",
    node_uid: node.node_uid,
    boot_id: bootId ?? null,
    material_revision: node.bootstrap_material_revision,
    issued_at: now,
    expires_at: expiresAt,
    legacy,
    databases,
  });
  const served = Date.now();
  if (hotLogDue("storage_guard_served", id, served)) {
    const live = lease.databases.filter(
      (entry) => entry.desired_state !== "deleted",
    );
    console.log(
      JSON.stringify({
        event: "storage_guard_served",
        node_id: id,
        entries: lease.databases.length,
        tombstones: lease.databases.length - live.length,
        unbound: live.filter((entry) => entry.volume === null).length,
        elapsed_ms: served - started,
      }),
    );
  }
  return c.json(lease, 200);
}
