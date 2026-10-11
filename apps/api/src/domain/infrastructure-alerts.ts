// SPDX-License-Identifier: Apache-2.0
import {
  InfraAlert,
  InfraAlertStatus,
  type InfraAlertKind,
} from "@pgcf/contracts";
import {
  infrastructureBackupHealth,
  readInfrastructureBackupConfig,
} from "./infrastructure-backups.ts";
import { heartbeatHealth } from "./operational-health.ts";
import type { Env } from "../env.ts";
import {
  MEMORY_SAMPLE_MAX_AGE_MS,
  regionalRamWindowSql,
} from "./memory-capacity.ts";
import { regionalNodeCountSql } from "./node-capacity-count.ts";
import { NODE_STORAGE_SAMPLE_MAX_AGE_MS } from "./node-storage.ts";

interface AlertRow {
  kind: InfraAlertKind;
  active: number;
  event_id: string;
  payload: string;
  delivered_at: string | null;
  last_attempt_at: string | null;
}
interface AlertCondition {
  kind: InfraAlertKind;
  active: boolean | null;
  snapshot: { sql: string; bindings: (string | number | null)[] };
  /** Lets arming replace a still active episode, evaluated against the stored row. */
  takeover?: { sql: string; bindings: (string | number | null)[] };
  /** Payload fields that replace the regional RAM and cap values. */
  detail?: Pick<
    InfraAlert,
    | "regional_ram_utilization_ppm"
    | "node_ids"
    | "threshold_ppm"
    | "utilization_ppm"
  >;
}
const retryMs = 60_000;

/** floor(used * 1000000 / total) in SQLite int64 for byte counts up to Number.MAX_SAFE_INTEGER. */
function ppmSql(used: string, total: string): string {
  return `((${used})*1000/(${total}))*1000+((((${used})*1000)%(${total}))*1000)/(${total})`;
}
const physical = (path: string) => `json_extract(o.physical_json,'$.${path}')`;
/**
 * Each node's latest fresh utilization in parts per million; a node without one is unknown and absent.
 * Ingest rejects future-dated samples, so only age bounds freshness and a delayed run still sees newer data.
 */
const nodeUtilization = {
  // The node's own ten-minute window maintained at ingest, including nodes closed to placement.
  regional_node_ram_warning: {
    column: "node_ram_warning_threshold_ppm",
    maxAgeMs: MEMORY_SAMPLE_MAX_AGE_MS,
    sql: `SELECT n.id,n.memory_utilization_ppm utilization_ppm FROM nodes n
      WHERE n.region_id=? AND n.node_uid IS NOT NULL AND n.lost_at IS NULL AND n.memory_window_valid=1
        AND n.memory_utilization_ppm IS NOT NULL AND julianday(n.memory_window_observed_at)>=julianday(?)`,
  },
  // The same ten consecutive minutes as RAM; every sample needs CPU data and one unchanged capacity.
  regional_node_cpu_warning: {
    column: "node_cpu_warning_threshold_ppm",
    maxAgeMs: MEMORY_SAMPLE_MAX_AGE_MS,
    sql: `SELECT n.id,MIN(1000000,SUM(m.cpu_usage_nano_cores)/(10*MAX(m.capacity_cpu_millicores))) utilization_ppm
      FROM nodes n JOIN node_memory_samples latest ON latest.node_id=n.id AND latest.node_uid=n.node_uid
        AND latest.minute=(SELECT MAX(minute) FROM node_memory_samples WHERE node_id=n.id AND node_uid=n.node_uid)
      JOIN node_memory_samples m ON m.node_id=n.id AND m.node_uid=n.node_uid
        AND m.minute BETWEEN latest.minute-9 AND latest.minute
      WHERE n.region_id=? AND n.lost_at IS NULL AND julianday(latest.observed_at)>=julianday(?)
      GROUP BY n.id HAVING COUNT(*)=10 AND COUNT(m.cpu_usage_nano_cores)=10
        AND MIN(m.capacity_cpu_millicores)=MAX(m.capacity_cpu_millicores)`,
  },
  // A thin pool consumes its volume group by design, so pool data or metadata fill governs it.
  regional_node_storage_warning: {
    column: "node_storage_warning_threshold_ppm",
    maxAgeMs: NODE_STORAGE_SAMPLE_MAX_AGE_MS,
    sql: `SELECT n.id,CASE WHEN json_type(o.physical_json,'$.thin_pool')='object' THEN MAX(
          ${ppmSql(physical("thin_pool.data_used_bytes_upper_bound"), physical("thin_pool.data_total_bytes"))},
          ${ppmSql(physical("thin_pool.metadata_used_bytes_upper_bound"), physical("thin_pool.metadata_total_bytes"))})
        ELSE ${ppmSql(`${physical("total_bytes")}-${physical("free_bytes")}`, physical("total_bytes"))} END utilization_ppm
      FROM node_storage_observations o JOIN nodes n ON n.id=o.node_id AND n.node_uid=o.node_uid
      WHERE n.region_id=? AND n.ready=1 AND n.lost_at IS NULL AND o.physical_json IS NOT NULL
        AND julianday(o.observed_at)>=julianday(?)`,
  },
} as const;
type NodeWarningKind = keyof typeof nodeUtilization;

/**
 * Any fresh node at or above the threshold keeps one regional episode until none of its listed
 * nodes still exceeds; snapshots re-evaluate current D1 state.
 */
async function nodeWarning(
  db: D1Database,
  regionId: string,
  kind: NodeWarningKind,
  thresholds: Record<
    (typeof nodeUtilization)[NodeWarningKind]["column"],
    number | null
  >,
  now: number,
): Promise<AlertCondition> {
  const measured = nodeUtilization[kind],
    threshold = thresholds[measured.column],
    policy = {
      sql: `EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=? AND p.${measured.column} IS ?)`,
      bindings: [regionId, threshold],
    };
  if (threshold === null) return { kind, active: false, snapshot: policy };
  const fresh = [regionId, new Date(now - measured.maxAgeMs).toISOString()],
    exceeded = `EXISTS(SELECT 1 FROM (${measured.sql}) measured WHERE measured.utilization_ppm>=?)`;
  const exceeding = await db
    .prepare(
      `SELECT id,utilization_ppm FROM (${measured.sql}) measured WHERE utilization_ppm>=?
      ORDER BY utilization_ppm DESC,id LIMIT 64`,
    )
    .bind(...fresh, threshold)
    .all<{ id: string; utilization_ppm: number }>();
  if (exceeding.results.length)
    return {
      kind,
      active: true,
      // Arm and claim only while this read's highest node still exceeds, never from a superseded read.
      snapshot: {
        sql: `${policy.sql} AND EXISTS(SELECT 1 FROM (${measured.sql}) measured WHERE measured.id=? AND measured.utilization_ppm>=?)`,
        bindings: [
          ...policy.bindings,
          ...fresh,
          exceeding.results[0]!.id,
          threshold,
        ],
      },
      // A listed node that is unknown or below cannot mute another node's crossing.
      takeover: {
        sql: `NOT EXISTS(SELECT 1 FROM (${measured.sql}) measured WHERE measured.utilization_ppm>=?
          AND measured.id IN(SELECT value FROM json_each(infrastructure_alerts.payload,'$.node_ids')))`,
        bindings: [...fresh, threshold],
      },
      detail: {
        regional_ram_utilization_ppm: null,
        node_ids: exceeding.results.map((node) => node.id),
        threshold_ppm: threshold,
        utilization_ppm: exceeding.results[0]!.utilization_ppm,
      },
    };
  // Only the clearing update uses this snapshot: every node the episode names must be fresh and
  // below the threshold, or lost; otherwise the episode is retained as unknown.
  return {
    kind,
    active: false,
    snapshot: {
      sql: `${policy.sql} AND NOT ${exceeded} AND NOT EXISTS(SELECT 1 FROM json_each(infrastructure_alerts.payload,'$.node_ids') named
        JOIN nodes named_node ON named_node.id=named.value AND named_node.lost_at IS NULL
        WHERE named.value NOT IN(SELECT id FROM (${measured.sql})))`,
      bindings: [...policy.bindings, ...fresh, threshold, ...fresh],
    },
  };
}

/** Known provider assignments, including the control role; reserved unpaid intents are not allocations. */
export async function allocatedRegionalNodes(
  db: D1Database,
  regionId: string,
): Promise<number> {
  const count = await db
    .prepare(`SELECT ${regionalNodeCountSql("?", true)} allocated`)
    .bind(regionId, regionId)
    .first<number>("allocated");
  return count ?? 0;
}

export async function infrastructureAlertStatus(
  db: D1Database,
  regionId: string,
) {
  const rows = await db
    .prepare(
      "SELECT * FROM infrastructure_alerts WHERE region_id=? ORDER BY kind",
    )
    .bind(regionId)
    .all<AlertRow>();
  return rows.results.map((row) =>
    InfraAlertStatus.parse({
      kind: row.kind,
      active: row.active === 1,
      event_id: row.event_id,
      occurred_at: InfraAlert.parse(JSON.parse(row.payload)).occurred_at,
      delivered_at: row.delivered_at,
      last_attempt_at: row.last_attempt_at,
    }),
  );
}

function callback(
  env: Env,
): { url: string; token: string; service?: Fetcher } | null {
  if (
    (!env.INFRASTRUCTURE_ALERT_WEBHOOK &&
      !env.INFRASTRUCTURE_ALERT_WEBHOOK_URL) ||
    !env.INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN
  )
    return null;
  try {
    const url = new URL(
      env.INFRASTRUCTURE_ALERT_WEBHOOK_URL ??
        "https://infrastructure-alert.invalid/",
    );
    const token = env.INFRASTRUCTURE_ALERT_WEBHOOK_TOKEN;
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href.length > 2048 ||
      !/^[A-Za-z0-9._~-]{16,512}$/.test(token)
    )
      return null;
    return {
      url: url.href,
      token,
      ...(env.INFRASTRUCTURE_ALERT_WEBHOOK
        ? { service: env.INFRASTRUCTURE_ALERT_WEBHOOK }
        : {}),
    };
  } catch {
    return null;
  }
}

/** At-least-once authenticated callback: the receiver must durably deduplicate event_id and payload. */
export async function runInfrastructureAlerts(
  env: Env,
  regionId: string,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<{ delivered: number; pending: number }> {
  const policy = await env.DB.prepare(
    "SELECT max_nodes,ram_warning_threshold_ppm,cap_warning_enabled,node_ram_warning_threshold_ppm,node_cpu_warning_threshold_ppm,node_storage_warning_threshold_ppm FROM node_region_policies WHERE region_id=?",
  )
    .bind(regionId)
    .first<{
      max_nodes: number | null;
      ram_warning_threshold_ppm: number | null;
      cap_warning_enabled: number;
      node_ram_warning_threshold_ppm: number | null;
      node_cpu_warning_threshold_ppm: number | null;
      node_storage_warning_threshold_ppm: number | null;
    }>();
  if (!policy) return { delivered: 0, pending: 0 };
  const window = await env.DB.prepare(regionalRamWindowSql("?"))
    .bind(regionId)
    .first<{
      minute: number;
      working_set_bytes: number;
      capacity_memory_bytes: number;
    }>();
  const allocated = await allocatedRegionalNodes(env.DB, regionId);
  const utilization =
    window === null
      ? null
      : Number(
          (BigInt(window.working_set_bytes) * 1_000_000n) /
            BigInt(window.capacity_memory_bytes),
        );
  const timestamp = new Date(now).toISOString();
  const capConfigured =
    policy.cap_warning_enabled === 1 && policy.max_nodes !== null;
  const ramSnapshot: AlertCondition["snapshot"] = {
    sql: "EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=? AND p.ram_warning_threshold_ppm IS ?)",
    bindings: [regionId, policy.ram_warning_threshold_ppm],
  };
  if (policy.ram_warning_threshold_ppm !== null && window !== null) {
    ramSnapshot.sql += ` AND EXISTS(SELECT 1 FROM (${regionalRamWindowSql("?")}) measured
      WHERE measured.minute=? AND measured.working_set_bytes=? AND measured.capacity_memory_bytes=?)`;
    ramSnapshot.bindings.push(
      regionId,
      window.minute,
      window.working_set_bytes,
      window.capacity_memory_bytes,
    );
  }
  const conditions: AlertCondition[] = [
    {
      kind: "regional_ram_warning",
      active:
        policy.ram_warning_threshold_ppm === null
          ? false
          : window === null
            ? null
            : BigInt(window.working_set_bytes) * 1_000_000n >=
              BigInt(window.capacity_memory_bytes) *
                BigInt(policy.ram_warning_threshold_ppm),
      snapshot: ramSnapshot,
    },
    {
      kind: "regional_node_cap_reached",
      active:
        policy.cap_warning_enabled === 1 &&
        policy.max_nodes !== null &&
        allocated >= policy.max_nodes,
      snapshot: {
        sql: `EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=?
          AND p.cap_warning_enabled=? AND p.max_nodes IS ?${
            capConfigured
              ? ` AND ${regionalNodeCountSql("p.region_id", true)}=?`
              : ""
          })`,
        bindings: [
          regionId,
          policy.cap_warning_enabled,
          policy.max_nodes,
          ...(capConfigured ? [allocated] : []),
        ],
      },
    },
  ];
  for (const kind of Object.keys(nodeUtilization) as NodeWarningKind[])
    conditions.push(await nodeWarning(env.DB, regionId, kind, policy, now));
  for (const { kind, active, snapshot, takeover, detail } of conditions) {
    // Unknown measurements retain an enabled episode; explicitly disabling its policy clears it.
    if (active === null) continue;
    if (!active) {
      await env.DB.prepare(
        `UPDATE infrastructure_alerts SET active=0 WHERE region_id=? AND kind=? AND active=1 AND ${snapshot.sql}`,
      )
        .bind(regionId, kind, ...snapshot.bindings)
        .run();
      continue;
    }
    const event = InfraAlert.parse({
      version: 1,
      event_id: crypto.randomUUID(),
      kind,
      region_id: regionId,
      occurred_at: timestamp,
      regional_ram_utilization_ppm: utilization,
      allocated_nodes: allocated,
      max_nodes: policy.max_nodes,
      ...detail,
    });
    await env.DB.prepare(
      `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
      SELECT ?,?,1,?,? WHERE ${snapshot.sql} ON CONFLICT(region_id,kind) DO UPDATE SET active=1,event_id=excluded.event_id,
        payload=excluded.payload,delivered_at=NULL,last_attempt_at=NULL WHERE infrastructure_alerts.active=0${
          takeover ? ` OR ${takeover.sql}` : ""
        }`,
    )
      .bind(
        regionId,
        kind,
        event.event_id,
        JSON.stringify(event),
        ...snapshot.bindings,
        ...(takeover?.bindings ?? []),
      )
      .run();
  }
  const pending = await env.DB.prepare(
    "SELECT * FROM infrastructure_alerts WHERE region_id=? AND active=1 AND delivered_at IS NULL ORDER BY kind",
  )
    .bind(regionId)
    .all<AlertRow>();
  return deliverAlertRows(
    env,
    regionId,
    pending.results,
    now,
    fetcher,
    conditions,
  );
}

async function deliverAlertRows(
  env: Env,
  regionId: string,
  rows: AlertRow[],
  now: number,
  fetcher: typeof fetch,
  conditions?: AlertCondition[],
) {
  const webhook = callback(env),
    config = await readInfrastructureBackupConfig(env.DB);
  const email =
    !webhook &&
    env.RESEND_API_KEY &&
    config.notification_recipient &&
    config.notification_sender
      ? {
          token: env.RESEND_API_KEY,
          recipient: config.notification_recipient,
          sender: config.notification_sender,
        }
      : null;
  if (!webhook && !email) return { delivered: 0, pending: rows.length };
  const timestamp = new Date(now).toISOString();
  let delivered = 0;
  for (const row of rows) {
    const condition = conditions?.find((value) => value.kind === row.kind);
    if (conditions && condition?.active !== true) continue;
    const claim = await env.DB.prepare(
      `UPDATE infrastructure_alerts SET last_attempt_at=? WHERE region_id=? AND kind=? AND event_id=? AND active=1 AND delivered_at IS NULL AND (last_attempt_at IS NULL OR last_attempt_at<=?)${condition ? " AND " + condition.snapshot.sql : ""}`,
    )
      .bind(
        timestamp,
        regionId,
        row.kind,
        row.event_id,
        new Date(now - retryMs).toISOString(),
        ...(condition?.snapshot.bindings ?? []),
      )
      .run();
    if (claim.meta.changes !== 1) continue;
    const abort = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = webhook?.url ?? "https://api.resend.com/emails";
      const body = webhook
        ? row.payload
        : JSON.stringify({
            from: email!.sender,
            to: [email!.recipient],
            subject: `PGCF infrastructure: ${row.kind} (${regionId})`,
            text: JSON.stringify(JSON.parse(row.payload), null, 2),
          });
      const options: RequestInit = {
        method: "POST",
        redirect: "manual",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${webhook?.token ?? email!.token}`,
          "Idempotency-Key": row.event_id,
        },
        body,
      };
      const delivery = (
        webhook?.service
          ? webhook.service.fetch(new Request(url, options))
          : fetcher(url, options)
      ).then((response) => {
        if (expired) {
          void response.body?.cancel().catch(() => {});
          throw new Error("infrastructure_alert_timeout");
        }
        return response;
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          abort.abort();
          reject(new Error("infrastructure_alert_timeout"));
        }, 5000);
      });
      const response = await Promise.race([delivery, deadline]);
      void response.body?.cancel().catch(() => {});
      if (!response.ok) continue;
      const ack = await env.DB.prepare(
        "UPDATE infrastructure_alerts SET delivered_at=? WHERE region_id=? AND kind=? AND event_id=? AND active=1 AND delivered_at IS NULL AND last_attempt_at=?",
      )
        .bind(timestamp, regionId, row.kind, row.event_id, timestamp)
        .run();
      delivered += ack.meta.changes;
    } catch {
      /* Same event ID and payload on retry; recipients must deduplicate callbacks, Resend uses its idempotency key. */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { delivered, pending: rows.length - delivered };
}

/** Reuse existing heartbeat and daily backup health; one durable alarm episode per region and kind. */
export async function runInfrastructureHealthAlerts(
  env: Env,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
) {
  const health = await infrastructureBackupHealth(env, now),
    regions = await env.DB.prepare("SELECT id FROM regions ORDER BY id").all<{
      id: string;
    }>();
  for (const region of regions.results) {
    const nodes = await env.DB.prepare(
      "SELECT id,last_observed_at,lost_at FROM nodes WHERE region_id=? AND node_uid IS NOT NULL AND (last_observed_at IS NOT NULL OR lost_at IS NOT NULL) ORDER BY id",
    )
      .bind(region.id)
      .all<{
        id: string;
        last_observed_at: string | null;
        lost_at: string | null;
      }>();
    const failedNodes = nodes.results
      .filter((node) =>
        ["stale", "lost"].includes(
          heartbeatHealth(node.last_observed_at, node.lost_at, now).status,
        ),
      )
      .slice(0, 64);
    const backups = health.filter((value) => value.region_id === region.id),
      allocated = await allocatedRegionalNodes(env.DB, region.id);
    const episodes = [
      {
        kind: "regional_node_stale" as const,
        active: failedNodes.length > 0,
        node_ids: failedNodes.map((node) => node.id),
      },
      {
        kind: "infrastructure_backup_failed" as const,
        active: backups.some((value) => value.status === "failing"),
        backup_artifacts: backups
          .filter((value) => value.status === "failing")
          .map((value) => ({
            kind: value.kind,
            status: "failing" as const,
            last_completed_at: value.last_completed_at,
            error_code: value.error_code,
          })),
      },
      {
        kind: "infrastructure_backup_stale" as const,
        active: backups.some((value) => value.status === "stale"),
        backup_artifacts: backups
          .filter((value) => value.status === "stale")
          .map((value) => ({
            kind: value.kind,
            status: "stale" as const,
            last_completed_at: value.last_completed_at,
            error_code: value.error_code,
          })),
      },
    ];
    for (const { active, ...detail } of episodes) {
      if (!active) {
        await env.DB.prepare(
          "UPDATE infrastructure_alerts SET active=0 WHERE region_id=? AND kind=?",
        )
          .bind(region.id, detail.kind)
          .run();
        continue;
      }
      const event = InfraAlert.parse({
        version: 1,
        event_id: crypto.randomUUID(),
        region_id: region.id,
        occurred_at: new Date(now).toISOString(),
        regional_ram_utilization_ppm: null,
        allocated_nodes: allocated,
        max_nodes: null,
        ...detail,
      });
      await env.DB.prepare(
        `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload) VALUES(?,?,1,?,?) ON CONFLICT(region_id,kind) DO UPDATE SET active=1,event_id=excluded.event_id,payload=excluded.payload,delivered_at=NULL,last_attempt_at=NULL WHERE infrastructure_alerts.active=0`,
      )
        .bind(region.id, event.kind, event.event_id, JSON.stringify(event))
        .run();
    }
    const rows = await env.DB.prepare(
      "SELECT * FROM infrastructure_alerts WHERE region_id=? AND active=1 AND delivered_at IS NULL AND kind IN('regional_node_stale','infrastructure_backup_failed','infrastructure_backup_stale') ORDER BY kind",
    )
      .bind(region.id)
      .all<AlertRow>();
    await deliverAlertRows(env, region.id, rows.results, now, fetcher);
  }
}
