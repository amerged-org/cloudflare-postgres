// SPDX-License-Identifier: Apache-2.0
import {
  DatabaseStorageVolumeReceipt,
  DesiredDatabaseStorage,
  NodeThinStorageAuthority,
  ThinStorageProfile,
  thinStorageInventory,
  thinStorageVolumeReclaimed,
} from "@pgcf/contracts";
import type { Env } from "../env.ts";
import type { DatabaseRow } from "./rows.ts";
import { allOf } from "./sql-conjunction.ts";
import { hotLogDue } from "./log-sampling.ts";
import {
  currentStorageStopSql,
  storageDrainReservationStatement,
  thinPoolRoomSql,
  thinPoolNodeRoomSql,
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
 * Every thin node of a region with a current identity proof, as the desired page serves it: the
 * proof's identities and inventory, which bind and confirm volumes, and the node's room. No native
 * proof means no entry; ordinary regional physical metrics cannot fill this gap.
 */
export async function desiredRegionStorageNodes(
  env: Pick<Env, "DB">,
  regionId: string,
  now = Date.now(),
): Promise<NodeThinStorageAuthority[]> {
  const rows = await env.DB.prepare(
    `SELECT t.node_id,EXISTS(SELECT 1 FROM node_storage_observations o WHERE o.node_id=t.node_id AND o.node_uid=t.node_uid AND ${thinPoolNodeRoomSql()}) room
      FROM node_thin_storage t JOIN nodes n ON n.id=t.node_id WHERE n.region_id=? ORDER BY n.id`,
  )
    .bind(regionId)
    .all<{ node_id: string; room: number }>();
  const readings = await Promise.all(
    rows.results.map((row) =>
      readCurrentNodeThinStorage(env, row.node_id, now, "continuing"),
    ),
  );
  return rows.results.flatMap((row, index) => {
    const proof = readings[index]?.authority ?? readings[index]?.reclamation;
    return proof ? [{ ...proof, room: row.room === 1 }] : [];
  });
}

/** A predicate over `databases d` and the values it binds. */
interface DatabaseScope {
  sql: string;
  bindings: unknown[];
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
        `SELECT h.storage_budget_bytes,h.storage_volume_json FROM database_start_admissions h JOIN databases d ON d.id=h.database_id JOIN nodes n ON n.id=d.node_id JOIN size_classes s ON s.id=d.size_class_id JOIN operations stop ON stop.id=h.operation_id WHERE h.operation_id=? AND h.budget_bytes=0 AND h.generation=d.generation AND h.node_id=n.id AND h.node_uid=n.node_uid AND ${currentStorageStopSql()} AND ${thinPoolRoomSql("n", "s", "d")}`,
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
