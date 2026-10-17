// SPDX-License-Identifier: Apache-2.0
import {
  newNodeId,
  ObservationReport,
  SIDECAR,
  postgresImageIdMatches,
  type DatabaseObservation,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { databaseActor } from "./database-actor-sync.ts";
import { agentRegion } from "./agent-auth.ts";
import { recoverQuiescence } from "./lifecycle.ts";
import { hint } from "./databases.ts";
import type { DatabaseRow } from "./rows.ts";
import { recordNodeMemoryObservation } from "./memory-capacity.ts";
import { recordNodeStorageObservation } from "./node-storage.ts";
import {
  recordStartupObservationStatement,
  rememberStartAttestationStatement,
  databaseCpuChargeSql,
  computePoolOverheadSql,
} from "./startup-admission.ts";

import { DatabaseRuntimeAttestation } from "@pgcf/contracts/reclaim";
import { thinStorageDeletionConfirmedSql } from "./storage-capacity.ts";
import { requestThinStorageTurn } from "./node-thin-storage-execution.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
} from "./admission-mutations.ts";
import {
  publishDatabaseAdmission,
  type PublishSteps,
} from "./database-admission-snapshot.ts";
import { admissionSnapshotCapable } from "./fleet-releases.ts";

/** How long a controller report waits for its admission publish (about 0.1 s) before it is answered. */
const ADMISSION_PUBLISH_ANSWER_MS = 1000;

/** Renewal timestamps/RVs outside the admitted identity do not create new configuration epochs. */
function admissionRuntimeIdentity(raw: unknown) {
  const parsed = DatabaseRuntimeAttestation.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return [
    p.v,
    p.database_id,
    p.generation,
    p.storage_generation,
    p.node_uid,
    p.boot_id,
    p.cluster_uid,
    p.namespace_uid,
    p.cnpg_cluster_uid,
    p.storage_uid,
    p.pvc_uid,
    p.pv_uid,
    p.pod_uid,
    p.container_id,
    p.postgres_image_sha256,
    p.memory_request_bytes,
    p.memory_limit_bytes,
    p.configuration_fingerprint,
    ...(p.v === 2
      ? [
          p.tls_server_name,
          p.ca_secret_uid,
          p.ca_secret_resource_version,
          p.ca_sha256,
          p.pod_ip,
          p.postgres_port,
          p.observation.controller_epoch,
          p.observation.watch_epoch,
        ]
      : []),
  ];
}
export function truncateAgentText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return bytes.length <= 4096
    ? value
    : new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
        bytes.subarray(0, 4096),
        { stream: true },
      );
}
export function observationApplies(
  row: DatabaseRow,
  regionId: string,
  observation: DatabaseObservation,
  receivedAt: string,
): boolean {
  if (
    row.node_id === null ||
    row.region_id !== regionId ||
    observation.generation !== row.generation ||
    observation.generation < row.observed_generation ||
    receivedAt < row.updated_at
  )
    return false;
  if (
    observation.state === "ready" &&
    row.desired_postgres_image &&
    (observation.postgres?.image !== row.desired_postgres_image ||
      !postgresImageIdMatches(
        row.desired_postgres_image,
        observation.postgres?.image_id ?? "",
      ))
  )
    return false;
  if (
    row.desired_state !== "deleted" &&
    row.power_operation &&
    (!observation.power ||
      observation.power.operation !== row.power_operation ||
      observation.power.revision !== row.generation)
  )
    return false;
  if (row.desired_state === "suspended")
    return ["provisioning", "error", "hibernated"].includes(observation.state);
  if (observation.state === "hibernated" || observation.power?.refusal)
    return false;
  if (row.desired_state === "deleted")
    return (
      ["deleting", "deleted", "error"].includes(observation.state) &&
      (row.observed_state !== "deleted" || observation.state === "deleted")
    );
  if (
    row.desired_state !== "running" ||
    ["deleting", "deleted"].includes(observation.state)
  )
    return false;
  if (row.observed_state === "ready" && observation.state === "provisioning")
    return false;
  return true;
}
export async function observations(
  c: ApiContext,
  raw: unknown,
): Promise<Response> {
  const region = await agentRegion(c);
  if (
    raw &&
    typeof raw === "object" &&
    "databases" in raw &&
    Array.isArray(raw.databases)
  ) {
    for (const db of raw.databases)
      if (
        db &&
        typeof db === "object" &&
        "message" in db &&
        typeof db.message === "string"
      )
        db.message = truncateAgentText(db.message);
  }
  const parsed = ObservationReport.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid observations");
  const body = parsed.data,
    receivedAt = Date.now(),
    now = new Date(receivedAt).toISOString();
  // A report replaces only what its coverage names; everything it omits stays unchanged.
  const nodes = "nodes" in body ? body.nodes : [],
    databases = "databases" in body ? body.databases : [],
    memorySamples =
      "node_memory_samples" in body ? (body.node_memory_samples ?? []) : [],
    orphans =
      "coverage" in body
        ? body.coverage === "inventory"
          ? body.orphans
          : undefined
        : body.orphans !== undefined &&
            (body.node_memory_samples === undefined ||
              body.nodes.length ||
              body.databases.length ||
              body.orphans.length)
          ? body.orphans
          : undefined;
  if (Date.parse(body.observed_at) > receivedAt + 300_000)
    throw new ApiError("invalid_request", "Observation time is in the future");
  if (
    databases.some(
      (d) =>
        d.backup &&
        (d.backup.observed_at > body.observed_at ||
          (d.backup.last_completed_at !== null &&
            d.backup.last_completed_at > d.backup.observed_at) ||
          (d.backup.last_failed_at !== null &&
            d.backup.last_failed_at > d.backup.observed_at)),
    )
  )
    throw new ApiError(
      "invalid_request",
      "Backup observation time is inconsistent",
    );
  const names = new Set<string>(),
    ids = new Set<string>();
  if (
    nodes.some((n) => names.has(n.name) || (names.add(n.name), false)) ||
    databases.some((d) => ids.has(d.id) || (ids.add(d.id), false))
  )
    throw new ApiError("invalid_request", "Duplicate observation subject");
  for (const node of nodes) {
    const reserved = await c.env.DB.prepare(
      `SELECT node_id,provider_instance_id FROM node_additions WHERE region_id=? AND json_extract(intent_json,'$.requested_hostname')=? AND slot_held=1`,
    )
      .bind(region.id, node.name)
      .first<{ node_id: string; provider_instance_id: string | null }>();
    const existing = await c.env.DB.prepare(
      "SELECT id,provider_instance_id FROM nodes WHERE id=? AND region_id=? AND k8s_node_name=?",
    )
      .bind(node.node_id ?? "", region.id, node.name)
      .first<{ id: string; provider_instance_id: string | null }>();
    const verifiedIdentity =
      node.node_uid !== undefined &&
      ((reserved !== null &&
        node.node_id === reserved.node_id &&
        node.provider_instance_id === reserved.provider_instance_id) ||
        (existing !== null &&
          existing.provider_instance_id !== null &&
          node.node_id === existing.id &&
          node.provider_instance_id === existing.provider_instance_id));
    if (
      reserved === null &&
      !verifiedIdentity &&
      (node.node_id !== undefined ||
        node.provider_instance_id !== undefined ||
        node.node_uid !== undefined)
    )
      continue;
    const before = await c.env.DB.prepare(
      "SELECT id,node_uid,ready,updated_at FROM nodes WHERE region_id=? AND k8s_node_name=?",
    )
      .bind(region.id, node.name)
      .first<{
        id: string;
        node_uid: string | null;
        ready: number;
        updated_at: string;
      }>();
    const physicalJoin =
      !before || (verifiedIdentity && before.node_uid === null);
    const invalidatesNode =
      before &&
      before.ready === 1 &&
      (!node.ready || (verifiedIdentity && before.node_uid !== node.node_uid));
    const executeNode = async (mutation?: AdmissionMutation) => {
      const guard = mutation?.scopeGuard();
      const statement = c.env.DB.prepare(
        `INSERT INTO nodes (id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,schedulable,provider_instance_id,node_uid,database_placement_enabled)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,? WHERE (${guard?.sql ?? "1=1"}) ON CONFLICT(region_id,k8s_node_name) DO UPDATE SET ready=CASE WHEN nodes.node_uid IS NOT NULL AND excluded.node_uid IS NOT NULL AND nodes.node_uid<>excluded.node_uid THEN 0 ELSE excluded.ready END,
      database_placement_enabled=CASE WHEN excluded.database_placement_enabled=0 THEN 0 ELSE nodes.database_placement_enabled END,
      schedulable=CASE WHEN nodes.node_uid IS NOT NULL AND excluded.node_uid IS NOT NULL AND nodes.node_uid<>excluded.node_uid THEN 0 ELSE nodes.schedulable END,
      allocatable_memory_mib=excluded.allocatable_memory_mib,
      allocatable_cpu_millicores=excluded.allocatable_cpu_millicores,storage_gib_total=excluded.storage_gib_total,platform_reserved_memory_mib=excluded.platform_reserved_memory_mib,
      platform_reserved_cpu_millicores=excluded.platform_reserved_cpu_millicores,
      provider_instance_id=CASE WHEN nodes.schedulable=0 AND nodes.id=excluded.id AND excluded.provider_instance_id IS NOT NULL THEN excluded.provider_instance_id ELSE nodes.provider_instance_id END,
      node_uid=CASE WHEN nodes.node_uid IS NULL AND excluded.node_uid IS NOT NULL AND nodes.id=excluded.id THEN excluded.node_uid ELSE nodes.node_uid END,
      last_observed_at=excluded.last_observed_at,updated_at=excluded.updated_at WHERE excluded.updated_at>=nodes.updated_at AND nodes.lost_at IS NULL
      AND (nodes.node_uid IS NULL OR excluded.node_uid IS NOT NULL)
      AND (excluded.node_uid IS NULL OR (nodes.id=excluded.id AND (nodes.provider_instance_id IS NULL OR nodes.provider_instance_id=excluded.provider_instance_id)))
      AND nodes.updated_at IS ? AND (${guard?.sql ?? "1=1"})`,
      ).bind(
        reserved?.node_id ?? node.node_id ?? newNodeId(),
        region.id,
        node.name,
        Number(node.ready && (reserved === null || verifiedIdentity)),
        node.allocatable_memory_mib,
        node.allocatable_cpu_millicores,
        node.storage_gib_total,
        node.platform_reserved_memory_mib,
        node.platform_reserved_cpu_millicores ?? null,
        body.observed_at,
        now,
        now,
        verifiedIdentity ? node.provider_instance_id! : null,
        verifiedIdentity ? node.node_uid! : null,
        Number(node.database_placement_enabled !== false),
        ...(guard?.bindings ?? []),
        before?.updated_at ?? null,
        ...(guard?.bindings ?? []),
      );
      if (mutation) await mutation.batch([statement]);
      else await statement.run();
    };
    if (physicalJoin)
      await withAdmissionMutation(c.env, [], executeNode, {
        kind: "region",
        id: region.id,
      });
    else if (invalidatesNode)
      await withAdmissionMutation(c.env, [], executeNode, {
        kind: "node",
        id: before.id,
      });
    else await executeNode();
    if (
      node.storage &&
      Date.parse(node.storage.observed_at) <= Date.parse(body.observed_at)
    )
      await recordNodeStorageObservation(
        c.env.DB,
        region.id,
        node,
        node.storage,
        receivedAt,
      );
  }
  for (const sample of memorySamples) {
    try {
      await recordNodeMemoryObservation(
        c.env.DB,
        region.id,
        sample,
        body.observed_at,
        receivedAt,
      );
    } catch {
      throw new ApiError(
        "invalid_request",
        "Node memory identity, measurements or time are inconsistent",
      );
    }
  }
  let accepted = 0;
  const cachedAdmission = await admissionSnapshotCapable(c.env.DB, region.id);
  for (const observation of databases) {
    const row = await c.env.DB.prepare(
      "SELECT d.*,COALESCE(ae.admission_revision,1) admission_revision,COALESCE(ae.route_revision,1) route_revision FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id LEFT JOIN database_admission_epochs ae ON ae.database_id=d.id WHERE d.id=? AND d.region_id=? AND (d.desired_state='deleted' OR n.lost_at IS NULL)",
    )
      .bind(observation.id, region.id)
      .first<
        DatabaseRow & { admission_revision: number; route_revision: number }
      >();
    if (!row || !observationApplies(row, region.id, observation, now)) continue;
    const restoration = await c.env.DB.prepare(
      "SELECT x.operation_id,o.status FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.target_database_id=? AND o.kind='database.restore'",
    )
      .bind(row.id)
      .first<{ operation_id: string; status: string }>();
    if (
      observation.state === "ready" &&
      restoration &&
      (restoration.status === "failed" ||
        observation.recovery?.operation_id !== restoration.operation_id ||
        observation.recovery.storage_generation !==
          (row.storage_generation ?? 1) ||
        !observation.recovery.verified)
    )
      continue;
    if (row.desired_state === "suspended" && observation.power?.refusal) {
      const recovered = await recoverQuiescence(
        c.env,
        {
          databaseId: row.id,
          operation: row.power_operation!,
          revision: row.generation,
        },
        observation.power.refusal,
        now,
      );
      if (recovered) {
        accepted++;
        hint(c, recovered.regionId, [row.id]);
      }
      continue;
    }
    const health =
      observation.archive.health ??
      (observation.archive.continuous
        ? observation.archive.ready_wal_files === null
          ? "unknown"
          : "ok"
        : "failing");
    const inactive =
      row.desired_state === "suspended" &&
      observation.state === "hibernated" &&
      observation.power?.state === "hibernated" &&
      observation.power.operation === row.power_operation &&
      observation.power.revision === row.generation &&
      !observation.power.refusal &&
      (observation.archive.ready_wal_files === null ||
        observation.archive.ready_wal_files === 0);
    // Check operation authority in the update itself so a concurrent failure cannot clear an alarm.
    const archiveHealth = `CASE WHEN ?=1 AND EXISTS(SELECT 1 FROM operations o WHERE o.id=databases.power_operation
      AND o.database_id=databases.id AND o.project_id=databases.project_id AND o.generation<=databases.generation
      AND o.status IN('pending','running','succeeded') AND ((databases.suspension_reason='idle' AND o.kind='database.hibernate')
        OR (databases.suspension_reason='manual' AND o.kind='database.suspend'))) THEN 'unknown' ELSE ? END`;
    const applied =
      observation.state === "ready" ||
      observation.state === "deleted" ||
      observation.state === "hibernated";
    const event =
      observation.state === "hibernated"
        ? row.suspension_reason === "idle"
          ? "hibernated"
          : "suspended"
        : observation.state === "ready"
          ? "ready"
          : observation.state === "deleted"
            ? "deleted"
            : null;
    const backup = observation.backup;
    const backupAt = backup?.observed_at ?? null;
    const backupFields = [
      "backup_observed_at",
      "backup_health",
      "backup_last_completed_at",
      "backup_last_failed_at",
    ];
    const backupUpdate = backupFields
      .map(
        (column) =>
          `${column}=CASE WHEN ? IS NOT NULL AND (backup_observed_at IS NULL OR ?>backup_observed_at) THEN ? ELSE ${column} END`,
      )
      .join(",");
    const backupBindings = [
      backupAt,
      backup?.health ?? null,
      backup?.last_completed_at ?? null,
      backup?.last_failed_at ?? null,
    ].flatMap((value) => [backupAt, backupAt, value]);
    const runtime = observation.runtime_attestation;
    if (
      runtime &&
      (runtime.database_id !== row.id ||
        runtime.generation !== row.generation ||
        runtime.storage_generation !== (row.storage_generation ?? 1) ||
        runtime.observed_at < receivedAt - 30000 ||
        runtime.observed_at > receivedAt + 1000)
    )
      continue;
    let previousRuntime: unknown = null;
    try {
      previousRuntime = row.runtime_attestation_json
        ? JSON.parse(row.runtime_attestation_json)
        : null;
    } catch {
      /* Invalid old proof never becomes an authority. */
    }
    const oldProof = DatabaseRuntimeAttestation.safeParse(previousRuntime);
    const admittedProof =
      !cachedAdmission ||
      (oldProof.success &&
        oldProof.data.v === 2 &&
        oldProof.data.admission_epoch === row.admission_revision &&
        oldProof.data.route_revision === row.route_revision &&
        oldProof.data.observation.expires_at > Date.now());
    const wasReady =
      admittedProof &&
      row.observed_state === "ready" &&
      row.observed_power === "awake" &&
      row.observed_generation === row.generation;
    const invalidates =
      wasReady &&
      (observation.state !== "ready" ||
        JSON.stringify(admissionRuntimeIdentity(previousRuntime)) !==
          JSON.stringify(admissionRuntimeIdentity(runtime)));
    const execute = async (mutation?: AdmissionMutation) => {
      const guard = mutation?.guard(row.id),
        statements = [
          c.env.DB.prepare(
            `UPDATE databases SET runtime_attestation_json=?,observed_postgres_image=CASE WHEN ?='ready' THEN ? ELSE observed_postgres_image END,observed_postgres_image_id=CASE WHEN ?='ready' THEN ? ELSE observed_postgres_image_id END,
        observed_state=?,observed_power=?,observed_generation=CASE WHEN ? THEN ? ELSE observed_generation END,status_message=?,
      archiving_health_since=CASE WHEN archiving_health<>(${archiveHealth}) THEN ? ELSE archiving_health_since END,archiving_health=(${archiveHealth}),${backupUpdate},updated_at=?
      WHERE id=? AND region_id=? AND generation=? AND observed_generation<=? AND updated_at=? AND desired_state=? AND observed_state=?
      AND ${runtime ? "EXISTS(SELECT 1 FROM nodes rn WHERE rn.id=databases.node_id AND rn.node_uid=?)" : "1=1"}
      AND runtime_attestation_json IS ? AND ${observation.state === "deleted" ? thinStorageDeletionConfirmedSql() : "1=1"}
      AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=databases.node_id AND n.region_id=databases.region_id AND (databases.desired_state='deleted' OR n.lost_at IS NULL))
      AND (?<>'ready' OR NOT EXISTS(SELECT 1 FROM database_restores x WHERE x.target_database_id=databases.id)
        OR EXISTS(SELECT 1 FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.target_database_id=databases.id AND x.operation_id=? AND o.status IN('pending','running','succeeded') AND ?=databases.storage_generation)) AND (${guard?.sql ?? "1=1"})`,
          ).bind(
            observation.state === "ready" && runtime
              ? JSON.stringify(DatabaseRuntimeAttestation.parse(runtime))
              : null,
            observation.state,
            observation.postgres?.image ?? null,
            observation.state,
            observation.postgres?.image_id ?? null,
            observation.state === "hibernated"
              ? "provisioning"
              : observation.state,
            observation.state === "hibernated"
              ? "hibernated"
              : observation.state === "ready" || observation.state === "deleted"
                ? "awake"
                : row.observed_power,
            Number(applied),
            observation.generation,
            observation.message === undefined
              ? null
              : truncateAgentText(observation.message),
            Number(inactive),
            health,
            body.observed_at,
            Number(inactive),
            health,
            ...backupBindings,
            now,
            row.id,
            region.id,
            observation.generation,
            observation.generation,
            row.updated_at,
            row.desired_state,
            row.observed_state,
            ...(runtime ? [runtime.node_uid] : []),
            row.runtime_attestation_json,
            observation.state,
            observation.recovery?.operation_id ?? null,
            observation.recovery?.storage_generation ?? null,
            ...(guard?.bindings ?? []),
          ),
        ];
      if (event)
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
      SELECT d.id,?,d.node_id,d.size_class_id,d.generation,?,
        json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,
          'reserved_memory_mib',s.memory_mib+?+CASE WHEN ${databaseCpuChargeSql("d", "s", true)}=0 THEN 0 ELSE ${computePoolOverheadSql("d", "memory_mib")} END,'reserved_cpu_millicores',${databaseCpuChargeSql("d", "s", true)},
          'storage_allocated_bytes',CASE WHEN d.storage_profile_json IS NULL THEN s.storage_gib*1073741824 ELSE NULL END)
      FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE changes()=1 AND d.id=? AND d.region_id=?
      AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=? AND kind=? AND generation=?)`,
          ).bind(
            event,
            body.observed_at,
            SIDECAR.requestMemoryMib,
            row.id,
            region.id,
            row.id,
            event,
            observation.generation,
          ),
        );
      if (observation.state === "ready" || observation.state === "deleted")
        statements.push(
          c.env.DB.prepare(
            `UPDATE operations SET status='succeeded',updated_at=?,completed_at=? WHERE database_id=? AND project_id=? AND generation<=? AND status IN('pending','running') AND kind=?
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id AND d.region_id=? AND d.generation=? AND d.observed_generation=? AND d.observed_state=? AND d.updated_at=?)`,
          ).bind(
            now,
            now,
            row.id,
            row.project_id,
            observation.generation,
            observation.state === "ready"
              ? restoration
                ? "database.restore"
                : "database.create"
              : "database.delete",
            region.id,
            observation.generation,
            observation.generation,
            observation.state,
            now,
          ),
        );
      if (observation.state === "ready" && restoration)
        statements.push(
          c.env.DB.prepare(
            "UPDATE database_restores SET verified_at=COALESCE(verified_at,?) WHERE target_database_id=? AND operation_id=? AND EXISTS(SELECT 1 FROM databases d WHERE d.id=database_restores.target_database_id AND d.observed_state='ready' AND d.observed_generation=d.generation AND d.updated_at=?)",
          ).bind(now, row.id, restoration.operation_id, now),
        );
      // The region's account of the roles it was asked to remove. It binds to the generation
      // that asked, so a removal started after the region read its desired state cannot be
      // completed by a report that predates it.
      const removed = observation.roles?.removed ?? [],
        blocked = observation.roles?.blocked ?? [];
      if (observation.state === "ready" && (removed.length || blocked.length)) {
        const current = `EXISTS(SELECT 1 FROM databases d WHERE d.id=? AND d.region_id=? AND d.generation=? AND d.observed_generation=? AND d.observed_state='ready' AND d.updated_at=?)`;
        const currentBindings = [
          row.id,
          region.id,
          observation.generation,
          observation.generation,
          now,
        ];
        if (removed.length)
          statements.push(
            c.env.DB.prepare(
              `UPDATE role_deletions SET status='succeeded',updated_at=?,completed_at=?
              WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=? AND role_name IN(SELECT value FROM json_each(?)) AND ${current}`,
            ).bind(
              now,
              now,
              row.id,
              row.project_id,
              observation.generation,
              JSON.stringify(removed),
              ...currentBindings,
            ),
            // The role is gone from PostgreSQL: its tombstone, with the credential it held, and
            // its name are free.
            c.env.DB.prepare(
              `DELETE FROM roles WHERE database_id=? AND deleted_at IS NOT NULL AND name IN(SELECT value FROM json_each(?)) AND ${current}`,
            ).bind(row.id, JSON.stringify(removed), ...currentBindings),
          );
        if (blocked.length)
          statements.push(
            c.env.DB.prepare(
              `UPDATE role_deletions SET status='failed',error_code='role_not_droppable',error_message=?,updated_at=?,completed_at=?
              WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=? AND role_name IN(SELECT value FROM json_each(?)) AND ${current}`,
            ).bind(
              "The role owns objects or holds privileges and cannot be dropped; it stays unable to log in until they are removed",
              now,
              now,
              row.id,
              row.project_id,
              observation.generation,
              JSON.stringify(blocked),
              ...currentBindings,
            ),
          );
      }
      if (applied && row.power_operation && observation.state !== "deleted") {
        if (observation.state === "ready")
          statements.push(
            c.env.DB.prepare(
              `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
        SELECT d.id,'woke',d.node_id,d.size_class_id,d.generation,?,json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,'reserved_memory_mib',s.memory_mib+?+CASE WHEN ${databaseCpuChargeSql("d", "s", true)}=0 THEN 0 ELSE ${computePoolOverheadSql("d", "memory_mib")} END,'reserved_cpu_millicores',${databaseCpuChargeSql()},'storage_allocated_bytes',CASE WHEN d.storage_profile_json IS NULL THEN s.storage_gib*1073741824 ELSE NULL END)
        FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.generation=d.generation AND o.kind IN('database.resume','database.wake')
        WHERE d.id=? AND d.generation=? AND d.observed_generation=d.generation AND d.observed_state='ready' AND d.observed_power='awake' AND d.updated_at=?
        AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=d.id AND kind='woke' AND generation=d.generation)`,
            ).bind(
              body.observed_at,
              SIDECAR.requestMemoryMib,
              row.id,
              row.generation,
              now,
            ),
          );
        statements.push(
          c.env.DB.prepare(
            `UPDATE operations SET status='succeeded',updated_at=?,completed_at=? WHERE id=? AND database_id=? AND generation<=? AND status IN('pending','running') AND kind IN('database.suspend','database.hibernate','database.resume','database.wake')
        AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id AND d.power_operation=operations.id
          AND d.generation=? AND operations.generation<=d.generation AND d.observed_generation=d.generation AND d.updated_at=? AND d.desired_state=? AND d.observed_power=?)`,
          ).bind(
            now,
            now,
            row.power_operation,
            row.id,
            row.generation,
            row.generation,
            now,
            row.desired_state,
            observation.state === "hibernated" ? "hibernated" : "awake",
          ),
        );
      }
      // A removal still waiting when the database went to sleep ends as it would have for a
      // sleeping database: the role is unroutable, and the region drops it at the next wake.
      if (observation.state === "hibernated")
        statements.push(
          c.env.DB.prepare(
            `UPDATE role_deletions SET status='succeeded',updated_at=?,completed_at=?
         WHERE database_id=? AND project_id=? AND status IN('pending','running') AND generation<=?
           AND EXISTS(SELECT 1 FROM databases d WHERE d.id=role_deletions.database_id AND d.region_id=? AND d.generation=?
             AND d.observed_generation=d.generation AND d.desired_state='suspended' AND d.observed_power='hibernated' AND d.updated_at=?)`,
          ).bind(
            now,
            now,
            row.id,
            row.project_id,
            observation.generation,
            region.id,
            observation.generation,
            now,
          ),
        );
      if (observation.state === "hibernated")
        statements.push(
          c.env.DB.prepare(
            `UPDATE operations SET status='succeeded',updated_at=?,completed_at=?
         WHERE database_id=? AND project_id=? AND kind='database.resize' AND generation<=? AND status IN('pending','running')
           AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id
             AND d.region_id=? AND d.generation=? AND d.observed_generation=d.generation
             AND d.desired_state='suspended' AND d.observed_state='provisioning' AND d.observed_power='hibernated'
             AND d.updated_at=? AND EXISTS(SELECT 1 FROM operations stopped WHERE stopped.id=d.power_operation
               AND stopped.database_id=d.id AND stopped.project_id=d.project_id AND stopped.generation<=d.generation
               AND stopped.kind IN('database.suspend','database.hibernate') AND stopped.status='succeeded'))
         AND NOT EXISTS(SELECT 1 FROM operations newer WHERE newer.database_id=operations.database_id AND newer.kind='database.resize' AND newer.generation>operations.generation)`,
          ).bind(
            now,
            now,
            row.id,
            row.project_id,
            observation.generation,
            region.id,
            observation.generation,
            now,
          ),
        );
      if (
        observation.state === "ready" &&
        row.observed_generation < observation.generation
      ) {
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
          SELECT d.id,'resized',d.node_id,d.size_class_id,d.generation,?,json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,
            'reserved_memory_mib',s.memory_mib+?+CASE WHEN ${databaseCpuChargeSql("d", "s", true)}=0 THEN 0 ELSE ${computePoolOverheadSql("d", "memory_mib")} END,'reserved_cpu_millicores',${databaseCpuChargeSql()},'storage_allocated_bytes',CASE WHEN d.storage_profile_json IS NULL THEN s.storage_gib*1073741824 ELSE NULL END)
          FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND d.region_id=? AND d.generation=?
            AND d.observed_generation=? AND d.observed_state='ready' AND d.updated_at=?
            AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.project_id=d.project_id AND o.kind='database.resize' AND o.generation<=d.generation AND o.status IN('pending','running')
              AND NOT EXISTS(SELECT 1 FROM operations newer WHERE newer.database_id=o.database_id AND newer.kind='database.resize' AND newer.generation>o.generation))
            AND NOT EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='resized' AND e.generation=d.generation)`,
          ).bind(
            body.observed_at,
            SIDECAR.requestMemoryMib,
            row.id,
            region.id,
            observation.generation,
            observation.generation,
            now,
          ),
          c.env.DB.prepare(
            `UPDATE operations SET status='succeeded',updated_at=?,completed_at=?
          WHERE database_id=? AND project_id=? AND kind='database.resize' AND generation<=? AND status IN('pending','running')
            AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id AND d.region_id=?
              AND d.generation=? AND d.observed_generation=d.generation AND d.observed_state='ready' AND d.updated_at=?)
            AND NOT EXISTS(SELECT 1 FROM operations newer WHERE newer.database_id=operations.database_id AND newer.kind='database.resize' AND newer.generation>operations.generation)`,
          ).bind(
            now,
            now,
            row.id,
            row.project_id,
            observation.generation,
            region.id,
            observation.generation,
            now,
          ),
        );
      }
      if (!applied)
        statements.push(
          c.env.DB.prepare(
            `UPDATE operations SET status='running',updated_at=? WHERE database_id=? AND project_id=? AND generation<=? AND status='pending' AND kind NOT IN('database.suspend','database.resume','database.hibernate','database.wake')
      AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.region_id=? AND d.generation=? AND d.observed_state=? AND d.updated_at=?)`,
          ).bind(
            now,
            row.id,
            row.project_id,
            observation.generation,
            region.id,
            observation.generation,
            observation.state,
            now,
          ),
        );
      if (!applied && row.power_operation)
        statements.push(
          c.env.DB.prepare(
            `UPDATE operations SET status='running',updated_at=? WHERE id=? AND database_id=? AND generation=? AND status='pending' AND EXISTS(SELECT 1 FROM databases WHERE id=? AND generation=? AND power_operation=? AND updated_at=?)`,
          ).bind(
            now,
            row.power_operation,
            row.id,
            row.generation,
            row.id,
            row.generation,
            row.power_operation,
            now,
          ),
        );
      if (
        observation.state === "ready" ||
        observation.state === "hibernated" ||
        observation.state === "deleted"
      )
        statements.push(
          recordStartupObservationStatement(c.env.DB, {
            databaseId: row.id,
            generation: observation.generation,
            observedAt: now,
            state: observation.state,
          }),
        );
      if (observation.state === "ready")
        statements.push(
          rememberStartAttestationStatement(c.env.DB, {
            databaseId: row.id,
            generation: observation.generation,
            observedAt: now,
          }),
        );
      return mutation ? mutation.batch(statements) : c.env.DB.batch(statements);
    };
    const committing = Date.now();
    const result = await (invalidates
      ? withAdmissionMutation(c.env, [row.id], execute)
      : execute());
    const committed = Date.now();
    const changed = result[0]!.meta.changes === 1;
    accepted += result[0]!.meta.changes;
    const becameReady =
      observation.state === "ready" &&
      !(
        row.observed_state === "ready" &&
        row.observed_power === "awake" &&
        row.observed_generation === observation.generation
      );
    // A waiting connection needs only the committed ready state: push it now, ahead of and
    // independent of the publish, whatever that takes. The Actor's bounded fallback read recovers
    // a lost push.
    const pushStarted = Date.now();
    let pushMilliseconds: number | null = null;
    const pushing =
      changed && becameReady
        ? databaseActor(c.env, row.id)
            .observedReady(
              row.id,
              observation.generation,
              row.power_operation ?? null,
            )
            .catch(() => false)
            .then(() => {
              pushMilliseconds = Date.now() - pushStarted;
            })
        : undefined;
    const steps: PublishSteps = {};
    let publishedAt: number | null = null;
    const publishing =
      changed && !invalidates
        ? publishDatabaseAdmission(c.env, row.id, undefined, steps).then(
            (value) => {
              publishedAt = Date.now();
              return value;
            },
          )
        : undefined;
    if (publishing) {
      // A publish is a few Actor RPCs and D1 reads. A failure within the bound still fails this
      // report, so the controller sends it again; a publish still running after it finishes in
      // the background and no longer holds the controller's report or its next pass.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        publishing.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ADMISSION_PUBLISH_ANSWER_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!settled)
        c.executionCtx.waitUntil(
          publishing.then(
            () => undefined,
            (error) =>
              console.error(
                JSON.stringify({
                  event: "admission_publish_failed",
                  database_id: row.id,
                  error: error instanceof Error ? error.name : "error",
                }),
              ),
          ),
        );
    }
    // Where a wake's time goes after the controller's report: the commit, the snapshot publish
    // (with its steps) and the push that releases the Actor's waiters. Only a transition is a
    // measurement; it is logged when both have finished.
    if (
      changed &&
      (becameReady ||
        (observation.state === "hibernated" &&
          row.observed_power !== "hibernated"))
    )
      c.executionCtx.waitUntil(
        Promise.all([pushing, publishing?.catch(() => undefined)]).then(() =>
          console.log(
            JSON.stringify({
              event: "observation_commit",
              database_id: row.id,
              operation: row.power_operation ?? null,
              generation: observation.generation,
              state: observation.state,
              at_ms: Date.now(),
              d1_ms: committed - committing,
              publish_ms: publishedAt === null ? null : publishedAt - committed,
              push_ms: pushMilliseconds,
              publish_steps: steps,
            }),
          ),
        ),
      );
    // Only an identity proof reads a new thin volume's LV into its receipt; start one now.
    if (
      result[0]!.meta.changes === 1 &&
      observation.state === "ready" &&
      row.node_id &&
      row.storage_profile_json &&
      !row.storage_volume_json
    )
      c.executionCtx.waitUntil(
        requestThinStorageTurn(c.env, row.node_id).catch(() => undefined),
      );
  }
  if (orphans !== undefined)
    await c.env.REGION_LINK.get(
      c.env.REGION_LINK.idFromName(region.id),
    ).reportOrphans(body.observed_at, orphans);
  await c.env.DB.prepare("UPDATE regions SET agent_last_seen_at=? WHERE id=?")
    .bind(now, region.id)
    .run();
  return c.json({ accepted });
}
