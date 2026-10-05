// SPDX-License-Identifier: Apache-2.0
import {
  newNodeId,
  ObservationRequest,
  SIDECAR,
  type DatabaseObservation,
} from "@pgcf/contracts";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { agentRegion } from "./agent-auth.ts";
import { recoverQuiescence } from "./lifecycle.ts";
import { hint } from "./databases.ts";
import type { DatabaseRow } from "./rows.ts";

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
  const parsed = ObservationRequest.safeParse(raw);
  if (!parsed.success)
    throw new ApiError("invalid_request", "Invalid observations");
  const body = parsed.data,
    receivedAt = Date.now(),
    now = new Date(receivedAt).toISOString();
  if (Date.parse(body.observed_at) > receivedAt + 300_000)
    throw new ApiError("invalid_request", "Observation time is in the future");
  if(body.databases.some(d=>d.backup && (d.backup.observed_at>body.observed_at || (d.backup.last_completed_at!==null && d.backup.last_completed_at>d.backup.observed_at) || (d.backup.last_failed_at!==null && d.backup.last_failed_at>d.backup.observed_at)))) throw new ApiError("invalid_request","Backup observation time is inconsistent");
  const names = new Set<string>(),
    ids = new Set<string>();
  if (
    body.nodes.some((n) => names.has(n.name) || (names.add(n.name), false)) ||
    body.databases.some((d) => ids.has(d.id) || (ids.add(d.id), false))
  )
    throw new ApiError("invalid_request", "Duplicate observation subject");
  for (const node of body.nodes) {
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
    await c.env.DB.prepare(
      `INSERT INTO nodes (id,region_id,k8s_node_name,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,schedulable,provider_instance_id,node_uid)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(region_id,k8s_node_name) DO UPDATE SET ready=CASE WHEN nodes.node_uid IS NOT NULL AND excluded.node_uid IS NOT NULL AND nodes.node_uid<>excluded.node_uid THEN 0 ELSE excluded.ready END,
      schedulable=CASE WHEN nodes.node_uid IS NOT NULL AND excluded.node_uid IS NOT NULL AND nodes.node_uid<>excluded.node_uid THEN 0 ELSE nodes.schedulable END,
      allocatable_memory_mib=excluded.allocatable_memory_mib,
      allocatable_cpu_millicores=excluded.allocatable_cpu_millicores,storage_gib_total=excluded.storage_gib_total,platform_reserved_memory_mib=excluded.platform_reserved_memory_mib,
      platform_reserved_cpu_millicores=excluded.platform_reserved_cpu_millicores,
      provider_instance_id=CASE WHEN nodes.schedulable=0 AND nodes.id=excluded.id AND excluded.provider_instance_id IS NOT NULL THEN excluded.provider_instance_id ELSE nodes.provider_instance_id END,
      node_uid=CASE WHEN nodes.node_uid IS NULL AND excluded.node_uid IS NOT NULL AND nodes.id=excluded.id THEN excluded.node_uid ELSE nodes.node_uid END,
      last_observed_at=excluded.last_observed_at,updated_at=excluded.updated_at WHERE excluded.updated_at>=nodes.updated_at AND nodes.lost_at IS NULL
      AND (excluded.node_uid IS NULL OR (nodes.id=excluded.id AND (nodes.provider_instance_id IS NULL OR nodes.provider_instance_id=excluded.provider_instance_id)))`,
    )
      .bind(
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
      )
      .run();
  }
  let accepted = 0;
  for (const observation of body.databases) {
    const row = await c.env.DB.prepare(
      "SELECT d.* FROM databases d JOIN nodes n ON n.id=d.node_id AND n.region_id=d.region_id WHERE d.id=? AND d.region_id=? AND n.lost_at IS NULL",
    )
      .bind(observation.id, region.id)
      .first<DatabaseRow>();
    if (!row || !observationApplies(row, region.id, observation, now)) continue;
    const restoration=await c.env.DB.prepare("SELECT x.operation_id,o.status FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.target_database_id=? AND o.kind='database.restore'").bind(row.id).first<{operation_id:string;status:string}>();
    if(observation.state==="ready" && restoration && (restoration.status==="failed" || observation.recovery?.operation_id!==restoration.operation_id || observation.recovery.storage_generation!==(row.storage_generation??1) || !observation.recovery.verified)) continue;
    if (row.desired_state === "suspended" && observation.power?.refusal) {
      const recovered = await recoverQuiescence(
        c.env.DB,
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
    const statements = [
      c.env.DB.prepare(
        `UPDATE databases SET observed_state=?,observed_power=?,observed_generation=CASE WHEN ? THEN ? ELSE observed_generation END,status_message=?,
      archiving_health_since=CASE WHEN archiving_health<>(${archiveHealth}) THEN ? ELSE archiving_health_since END,archiving_health=(${archiveHealth}),updated_at=?
      WHERE id=? AND region_id=? AND generation=? AND observed_generation<=? AND updated_at=? AND desired_state=? AND observed_state=?
      AND EXISTS(SELECT 1 FROM nodes n WHERE n.id=databases.node_id AND n.region_id=databases.region_id AND n.lost_at IS NULL)
      AND (?<>'ready' OR NOT EXISTS(SELECT 1 FROM database_restores x WHERE x.target_database_id=databases.id)
        OR EXISTS(SELECT 1 FROM database_restores x JOIN operations o ON o.id=x.operation_id WHERE x.target_database_id=databases.id AND x.operation_id=? AND o.status IN('pending','running','succeeded') AND ?=databases.storage_generation))`,
      ).bind(
        observation.state === "hibernated" ? "provisioning" : observation.state,
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
        now,
        row.id,
        region.id,
        observation.generation,
        observation.generation,
        row.updated_at,
        row.desired_state,
        row.observed_state,
        observation.state,observation.recovery?.operation_id ?? null,observation.recovery?.storage_generation ?? null,
      ),
    ];
    if (event)
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
      SELECT d.id,?,d.node_id,d.size_class_id,d.generation,?,
        json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,
          'reserved_memory_mib',s.memory_mib+?,'reserved_cpu_millicores',s.cpu_millicores+?,
          'storage_allocated_bytes',s.storage_gib*1073741824)
      FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE changes()=1 AND d.id=? AND d.region_id=?
      AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=? AND kind=? AND generation=?)`,
        ).bind(
          event,
          body.observed_at,
          SIDECAR.requestMemoryMib,
          SIDECAR.requestCpuMillicores,
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
          observation.state === "ready" ? restoration ? "database.restore" : "database.create" : "database.delete",
          region.id,
          observation.generation,
          observation.generation,
          observation.state,
          now,
        ),
      );
    if(observation.state==="ready" && restoration) statements.push(c.env.DB.prepare("UPDATE database_restores SET verified_at=COALESCE(verified_at,?) WHERE target_database_id=? AND operation_id=? AND EXISTS(SELECT 1 FROM databases d WHERE d.id=database_restores.target_database_id AND d.observed_state='ready' AND d.observed_generation=d.generation AND d.updated_at=?)").bind(now,row.id,restoration.operation_id,now));
    if (applied && row.power_operation && observation.state !== "deleted") {
      if (observation.state === "ready")
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
        SELECT d.id,'woke',d.node_id,d.size_class_id,d.generation,?,json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,'reserved_memory_mib',s.memory_mib+?,'reserved_cpu_millicores',s.cpu_millicores+?,'storage_allocated_bytes',s.storage_gib*1073741824)
        FROM databases d JOIN size_classes s ON s.id=d.size_class_id JOIN operations o ON o.id=d.power_operation AND o.database_id=d.id AND o.generation=d.generation AND o.kind IN('database.resume','database.wake')
        WHERE d.id=? AND d.generation=? AND d.observed_generation=d.generation AND d.observed_state='ready' AND d.observed_power='awake' AND d.updated_at=?
        AND NOT EXISTS(SELECT 1 FROM lifecycle_events WHERE database_id=d.id AND kind='woke' AND generation=d.generation)`,
          ).bind(
            body.observed_at,
            SIDECAR.requestMemoryMib,
            SIDECAR.requestCpuMillicores,
            row.id,
            row.generation,
            now,
          ),
        );
      statements.push(
        c.env.DB.prepare(
          `UPDATE operations SET status='succeeded',updated_at=?,completed_at=? WHERE id=? AND database_id=? AND generation=? AND status IN('pending','running') AND kind IN('database.suspend','database.hibernate','database.resume','database.wake')
        AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.power_operation=operations.id AND d.generation=operations.generation AND d.observed_generation=d.generation AND d.updated_at=? AND d.desired_state=? AND d.observed_power=?)`,
        ).bind(
          now,
          now,
          row.power_operation,
          row.id,
          row.generation,
          now,
          row.desired_state,
          observation.state === "hibernated" ? "hibernated" : "awake",
        ),
      );
    }
    if (
      observation.state === "ready" &&
      row.observed_generation < observation.generation
    ) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO lifecycle_events(database_id,kind,node_id,size_class_id,generation,occurred_at,resource_snapshot)
          SELECT d.id,'resized',d.node_id,d.size_class_id,d.generation,?,json_object('memory_mib',s.memory_mib,'cpu_millicores',s.cpu_millicores,
            'reserved_memory_mib',s.memory_mib+?,'reserved_cpu_millicores',s.cpu_millicores+?,'storage_allocated_bytes',s.storage_gib*1073741824)
          FROM databases d JOIN size_classes s ON s.id=d.size_class_id WHERE d.id=? AND d.region_id=? AND d.generation=?
            AND d.observed_generation=? AND d.observed_state='ready' AND d.updated_at=?
            AND EXISTS(SELECT 1 FROM operations o WHERE o.database_id=d.id AND o.project_id=d.project_id AND o.kind='database.resize' AND o.generation=d.generation)
            AND NOT EXISTS(SELECT 1 FROM lifecycle_events e WHERE e.database_id=d.id AND e.kind='resized' AND e.generation=d.generation)`,
        ).bind(
          body.observed_at,
          SIDECAR.requestMemoryMib,
          SIDECAR.requestCpuMillicores,
          row.id,
          region.id,
          observation.generation,
          observation.generation,
          now,
        ),
        c.env.DB.prepare(
          `UPDATE operations SET status='succeeded',updated_at=?,completed_at=?
          WHERE database_id=? AND project_id=? AND kind='database.resize' AND generation=? AND status IN('pending','running')
            AND EXISTS(SELECT 1 FROM databases d WHERE d.id=operations.database_id AND d.project_id=operations.project_id AND d.region_id=?
              AND d.generation=operations.generation AND d.observed_generation=operations.generation AND d.observed_state='ready' AND d.updated_at=?)`,
        ).bind(
          now,
          now,
          row.id,
          row.project_id,
          observation.generation,
          region.id,
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
    const result = await c.env.DB.batch(statements);
    accepted += result[0]!.meta.changes;
  }
  await c.env.REGION_LINK.get(
    c.env.REGION_LINK.idFromName(region.id),
  ).reportOrphans(body.observed_at, body.orphans);
  await c.env.DB.prepare("UPDATE regions SET agent_last_seen_at=? WHERE id=?")
    .bind(now, region.id)
    .run();
  return c.json({ accepted });
}
