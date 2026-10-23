// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  INFRA_ALERT_ACTIONS,
  InfraAlert,
  InfraAlertStatus,
  NODE_DATABASE_STALE_MS,
  type InfraAlertKind,
} from "@pgcf/contracts";
import {
  infrastructureBackupHealth,
  readInfrastructureBackupConfig,
} from "./infrastructure-backups.ts";
import {
  BASE_BACKUP_MAX_AGE_MS,
  heartbeatHealth,
} from "./operational-health.ts";
import {
  AVERAGE_MINIMUM_SPAN_SECONDS,
  AVERAGE_WINDOW_SECONDS,
  closedPools,
  LATEST_SAMPLES_SQL,
  minuteOf,
  NODE_OBSERVATION_MAX_AGE_MS,
} from "./placement.ts";
import {
  CRON_STEP_FAILURE_RUNS,
  cronErrorCode,
  readCronHealth,
} from "./cron-health.ts";
import { purgeNodeDiagnostics } from "./node-diagnostics.ts";
import type { Env } from "../env.ts";
import { regionalNodeCountSql } from "./node-capacity-count.ts";

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
  /** Payload fields of a per-node warning. */
  detail?: Pick<InfraAlert, "node_ids" | "threshold_ppm" | "utilization_ppm">;
}
const retryMs = 60_000;

/**
 * The identifier of an error, so that the same error always has the same one: a UUID of version 8
 * (RFC 9562; a name-based UUID from SHA-256 is no version 5, which is SHA-1) and the RFC 4122
 * variant, made from the first 16 bytes of the SHA-256 of a fixed domain string, the region, the
 * kind and the sorted subjects, one per line. The subjects are what tells two errors of one kind
 * apart: the nodes or databases the event lists, or for `control_cron_step_failing` the failing
 * steps. The same region, kind and subjects give the same ID again after the error cleared and
 * came back, another set of subjects is another error with its own ID, and a kind without
 * subjects is told apart by region and kind alone. The ID names the error, not the episode: with
 * `occurred_at`, the start of the episode, it names one notification.
 */
export async function alertEventId(
  regionId: string,
  kind: InfraAlertKind,
  subjects: readonly string[] = [],
): Promise<string> {
  const input = [
    "pgcf.infrastructure-alert.v1",
    regionId,
    kind,
    ...[...new Set(subjects)].sort(),
  ].join("\n");
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  ).subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** floor(used * 1000000 / total) in SQLite int64 for byte counts up to Number.MAX_SAFE_INTEGER. */
function ppmSql(used: string, total: string): string {
  return `((${used})*1000/(${total}))*1000+((((${used})*1000)%(${total}))*1000)/(${total})`;
}
/**
 * A node's load over the 30 minutes up to its newest sample, from rollups that span at least ten
 * of them: `ratio` is the parts per million of one minute `m`, summed over its samples. A node
 * without that history is unknown.
 */
const averagedLoad = (ratio: string) =>
  `SELECT n.id,(SELECT SUM(${ratio})/SUM(m.samples) FROM node_minutes m WHERE m.node_id=n.id AND m.samples>0
        AND m.minute>=latest.minute-${AVERAGE_WINDOW_SECONDS / 60} AND m.minute<=latest.minute) utilization_ppm
      FROM nodes n JOIN (SELECT node_id,observed_at,CAST(strftime('%s',observed_at) AS INTEGER)/60 minute FROM (${LATEST_SAMPLES_SQL})) latest ON latest.node_id=n.id
      WHERE n.region_id=? AND n.lost_at IS NULL AND julianday(latest.observed_at)>=julianday(?)
        AND EXISTS(SELECT 1 FROM node_minutes m WHERE m.node_id=n.id AND m.samples>0
          AND m.minute>=latest.minute-${AVERAGE_WINDOW_SECONDS / 60}
          AND m.minute<=latest.minute-${AVERAGE_MINIMUM_SPAN_SECONDS / 60})`;
/**
 * Each node's latest fresh utilization in parts per million; a node without one is unknown and absent.
 * The link rejects future-dated samples, so only age bounds freshness and a delayed run still sees newer data.
 */
const nodeUtilization = {
  // Active RAM, as placement reads it, including nodes closed to placement.
  regional_node_ram_warning: {
    column: "node_ram_warning_threshold_ppm",
    maxAgeMs: NODE_OBSERVATION_MAX_AGE_MS,
    sql: averagedLoad("m.memory_used_bytes_sum*1000000/m.memory_total_bytes"),
  },
  // CPU load: busy time over all cores.
  regional_node_cpu_warning: {
    column: "node_cpu_warning_threshold_ppm",
    maxAgeMs: NODE_OBSERVATION_MAX_AGE_MS,
    sql: averagedLoad("m.cpu_busy_millicores_sum*1000/m.cpu_cores"),
  },
  // A thin pool consumes its volume group by design, so pool data or metadata fill governs it.
  regional_node_storage_warning: {
    column: "node_storage_warning_threshold_ppm",
    maxAgeMs: NODE_OBSERVATION_MAX_AGE_MS,
    sql: `SELECT n.id,MAX(
          ${ppmSql("latest.pool_data_used_bytes", "latest.pool_data_total_bytes")},
          ${ppmSql("latest.pool_metadata_used_bytes", "latest.pool_metadata_total_bytes")}) utilization_ppm
      FROM nodes n JOIN (${LATEST_SAMPLES_SQL}) latest ON latest.node_id=n.id
      WHERE n.region_id=? AND n.lost_at IS NULL AND latest.pool_data_total_bytes IS NOT NULL
        AND julianday(latest.observed_at)>=julianday(?)`,
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
  deadline?: number,
): Promise<{ delivered: number; pending: number }> {
  const policy = await env.DB.prepare(
    "SELECT max_nodes,cap_warning_enabled,node_ram_warning_threshold_ppm,node_cpu_warning_threshold_ppm,node_storage_warning_threshold_ppm FROM node_region_policies WHERE region_id=?",
  )
    .bind(regionId)
    .first<{
      max_nodes: number | null;
      cap_warning_enabled: number;
      node_ram_warning_threshold_ppm: number | null;
      node_cpu_warning_threshold_ppm: number | null;
      node_storage_warning_threshold_ppm: number | null;
    }>();
  if (!policy) return { delivered: 0, pending: 0 };
  const allocated = await allocatedRegionalNodes(env.DB, regionId);
  const timestamp = new Date(now).toISOString();
  const capConfigured =
    policy.cap_warning_enabled === 1 && policy.max_nodes !== null;
  const conditions: AlertCondition[] = [
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
      event_id: await alertEventId(regionId, kind, detail?.node_ids),
      kind,
      region_id: regionId,
      occurred_at: timestamp,
      regional_ram_utilization_ppm: null,
      allocated_nodes: allocated,
      max_nodes: policy.max_nodes,
      action: INFRA_ALERT_ACTIONS[kind],
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
    deadline,
  );
}

/**
 * Sends each row once with a 5 s deadline. A caller that must not be held back passes `deadline`
 * (epoch milliseconds): once it has passed, the remaining rows are left unclaimed, so the next
 * run retries them at once instead of after the retry interval.
 */
export async function deliverAlertRows(
  env: Env,
  regionId: string,
  rows: AlertRow[],
  now: number,
  fetcher: typeof fetch,
  conditions?: AlertCondition[],
  deadline?: number,
) {
  if (rows.length === 0) return { delivered: 0, pending: 0 };
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
  for (const [index, row] of rows.entries()) {
    if (deadline !== undefined && Date.now() >= deadline) {
      console.error(
        JSON.stringify({
          event: "infrastructure_alert_deferred",
          region_id: regionId,
          deferred: rows.length - index,
        }),
      );
      break;
    }
    const condition = conditions?.find((value) => value.kind === row.kind);
    if (conditions && condition?.active !== true) continue;
    const claim = await env.DB.prepare(
      `UPDATE infrastructure_alerts SET last_attempt_at=? WHERE region_id=? AND kind=? AND event_id=? AND payload=? AND active=1 AND delivered_at IS NULL AND (last_attempt_at IS NULL OR last_attempt_at<=?)${condition ? " AND " + condition.snapshot.sql : ""}`,
    )
      .bind(
        timestamp,
        regionId,
        row.kind,
        row.event_id,
        row.payload,
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
          "Idempotency-Key": `${row.event_id}:${InfraAlert.parse(JSON.parse(row.payload)).occurred_at}`,
          "User-Agent": "pgcf-infrastructure-alerts",
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
      if (!response.ok) {
        // Status only: the body and the destination's details stay out of the log.
        console.error(
          JSON.stringify({
            event: "infrastructure_alert_delivery_failed",
            region_id: regionId,
            kind: row.kind,
            event_id: row.event_id,
            status: response.status,
          }),
        );
        continue;
      }
      const ack = await env.DB.prepare(
        "UPDATE infrastructure_alerts SET delivered_at=? WHERE region_id=? AND kind=? AND event_id=? AND active=1 AND delivered_at IS NULL AND last_attempt_at=?",
      )
        .bind(timestamp, regionId, row.kind, row.event_id, timestamp)
        .run();
      delivered += ack.meta.changes;
    } catch (error) {
      /* Same event ID and payload on retry; recipients must deduplicate callbacks, Resend uses its idempotency key. */
      console.error(
        JSON.stringify({
          event: "infrastructure_alert_delivery_failed",
          region_id: regionId,
          kind: row.kind,
          event_id: row.event_id,
          reason:
            error instanceof Error &&
            error.message === "infrastructure_alert_timeout"
              ? "timeout"
              : "transport",
        }),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { delivered, pending: rows.length - delivered };
}

type EventDetail = Partial<
  Pick<
    InfraAlert,
    "node_ids" | "backup_artifacts" | "database_ids" | "thin_storage" | "cron"
  >
>;
/**
 * What one evaluation says about a kind: its condition holds (`active`, naming the subjects that
 * fail when it has any), is known to be over (`resolved`), or cannot be judged (`retain`: an
 * unknown measurement neither starts nor clears an episode).
 */
type Observation =
  | {
      state: "active";
      detail: EventDetail;
      subjects?: string[];
      /** Besides `subjects`, what makes this error another of its kind in `alertEventId`; it never re-announces an active episode. */
      identity?: string[];
    }
  | { state: "resolved" }
  | { state: "retain" };

/** The databases or nodes a stored episode names. */
function listedSubjects(payload: string): Set<string> {
  const ids = new Set<string>();
  try {
    const event = JSON.parse(payload) as {
      database_ids?: unknown;
      node_ids?: unknown;
      thin_storage?: unknown;
    };
    for (const list of [event.database_ids, event.node_ids])
      if (Array.isArray(list))
        for (const id of list) if (typeof id === "string") ids.add(id);
    if (Array.isArray(event.thin_storage))
      for (const entry of event.thin_storage) {
        const id = (entry as { node_id?: unknown } | null)?.node_id;
        if (typeof id === "string") ids.add(id);
      }
  } catch {
    /* An unreadable payload names nobody; the next failing subject replaces the episode. */
  }
  return ids;
}

/**
 * Moves one episode to what the evaluation observed and reports whether it wrote. A new episode
 * gets a new event; a continuing one keeps its event ID and payload so retries stay identical. An
 * active episode that fails a subject it does not list is replaced by a new event that lists the
 * current subjects, so a later failure is announced instead of hiding behind the first one; a
 * listed subject that recovers and fails again adds nothing.
 */
async function reconcileEpisode(
  env: Env,
  regionId: string,
  kind: InfraAlertKind,
  observation: Observation,
  current: AlertRow | undefined,
  now: number,
  allocated: () => Promise<number>,
): Promise<boolean> {
  if (observation.state === "retain") return false;
  const active = current?.active === 1;
  if (observation.state === "resolved") {
    if (!active) return false;
    await env.DB.prepare(
      "UPDATE infrastructure_alerts SET active=0 WHERE region_id=? AND kind=? AND event_id=? AND payload=?",
    )
      .bind(regionId, kind, current!.event_id, current!.payload)
      .run();
    return true;
  }
  if (active) {
    const named = observation.subjects;
    if (!named?.length) return false;
    const listed = listedSubjects(current!.payload);
    if (named.every((id) => listed.has(id))) return false;
  }
  const event = InfraAlert.parse({
    version: 1,
    event_id: await alertEventId(regionId, kind, [
      ...(observation.subjects ?? []),
      ...(observation.identity ?? []),
    ]),
    kind,
    region_id: regionId,
    occurred_at: new Date(now).toISOString(),
    regional_ram_utilization_ppm: null,
    allocated_nodes: await allocated(),
    max_nodes: null,
    action: INFRA_ALERT_ACTIONS[kind],
    ...observation.detail,
  });
  // Arms a cleared episode, or replaces exactly the one this evaluation read.
  await env.DB.prepare(
    `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload) VALUES(?,?,1,?,?) ON CONFLICT(region_id,kind) DO UPDATE SET active=1,event_id=excluded.event_id,payload=excluded.payload,delivered_at=NULL,last_attempt_at=NULL WHERE infrastructure_alerts.active=0 OR (infrastructure_alerts.event_id=? AND infrastructure_alerts.payload=?)`,
  )
    .bind(
      regionId,
      kind,
      event.event_id,
      JSON.stringify(event),
      current?.event_id ?? null,
      current?.payload ?? null,
    )
    .run();
  return true;
}

const storedEpisodes = async (db: D1Database, regionId: string) =>
  new Map(
    (
      await db
        .prepare("SELECT * FROM infrastructure_alerts WHERE region_id=?")
        .bind(regionId)
        .all<AlertRow>()
    ).results.map((row) => [row.kind, row] as const),
  );
const lazyAllocated = (db: D1Database, regionId: string) => {
  let value: Promise<number> | undefined;
  return () => (value ??= allocatedRegionalNodes(db, regionId));
};

/**
 * The latest of a database's last completed base backup, its placement and its last wake: a
 * database hibernated through its daily 03:00 backup skips it, so its 36 h count from waking. A
 * `ready` event is deliberately not a wake: every generation bump (a role, a resize) writes one.
 */
const backupBaselineSql = (database: string) =>
  `MAX(COALESCE(${database}.backup_last_completed_at,''),COALESCE((SELECT MAX(e.occurred_at) FROM lifecycle_events e WHERE e.database_id=${database}.id AND e.kind IN('created','woke')),''),${database}.created_at)`;

interface Subject {
  id: string;
  detail: string | null;
}
interface SubjectRow {
  kind: InfraAlertKind;
  state: "failing" | "unresolved";
  subject: string;
  detail: string | null;
}
type RegionSubjects = Map<
  InfraAlertKind,
  { failing: Subject[]; unresolved: number }
>;
/**
 * One statement reads every database and Thin storage condition of a region. `failing` rows are
 * the subjects that hold the condition now; `unresolved` rows are the subjects a still active
 * episode names that are not yet known to be fine, so an unknown measurement keeps the episode.
 */
async function readRegionSubjects(
  db: D1Database,
  regionId: string,
  now: number,
): Promise<RegionSubjects> {
  // D1 admits at most five terms in a compound SELECT, so each kind is one term that returns its
  // failing subjects together with the subjects its active episode still names.
  const baseline = backupBaselineSql("d"),
    backupFailing = `(d.observed_state='ready' AND d.backup_observed_at IS NOT NULL AND d.backup_observed_at>=p.fresh
      AND (d.backup_health='failing' OR (d.backup_health='ok' AND d.backup_last_completed_at IS NOT NULL))
      AND ${baseline}<p.backup_before)`,
    backupGood = `(d.backup_health='ok' AND d.backup_observed_at IS NOT NULL AND d.backup_observed_at>=p.fresh
      AND ${baseline}>=p.backup_before)`;
  const result = await db
    .prepare(
      `WITH p AS (SELECT ? region,? fresh,? backup_before)
      SELECT * FROM (SELECT 'database_archive_failing' kind,
          CASE WHEN d.observed_state='ready' AND d.observed_power='awake' AND d.archiving_health='failing' THEN 'failing' ELSE 'unresolved' END state,
          d.id subject,NULL detail
        FROM databases d,p WHERE d.region_id=p.region AND d.deleted_at IS NULL AND d.desired_state='running'
          AND d.archiving_health<>'ok'
          AND ((d.observed_state='ready' AND d.observed_power='awake' AND d.archiving_health='failing')
            OR d.id IN(SELECT n.value FROM infrastructure_alerts a,json_each(a.payload,'$.database_ids') n
              WHERE a.region_id=d.region_id AND a.kind='database_archive_failing' AND a.active=1))
        ORDER BY state,d.archiving_health_since,d.id LIMIT 64)
      UNION ALL SELECT * FROM (SELECT 'database_base_backup_stale',
          CASE WHEN ${backupFailing} THEN 'failing' ELSE 'unresolved' END state,d.id,NULL
        FROM databases d,p WHERE d.region_id=p.region AND d.deleted_at IS NULL AND d.desired_state='running'
          AND d.observed_power='awake'
          AND (${backupFailing}
            OR (d.id IN(SELECT n.value FROM infrastructure_alerts a,json_each(a.payload,'$.database_ids') n
              WHERE a.region_id=d.region_id AND a.kind='database_base_backup_stale' AND a.active=1)
              AND NOT ${backupGood}))
        ORDER BY state,${baseline},d.id LIMIT 64)`,
    )
    .bind(
      regionId,
      // The backup observation of a database that did not change is repeated once in each
      // anti-entropy period, not once in each minute.
      new Date(now - NODE_DATABASE_STALE_MS).toISOString(),
      new Date(now - BASE_BACKUP_MAX_AGE_MS).toISOString(),
    )
    .all<SubjectRow>();
  return collectSubjects(result.results);
}

function collectSubjects(rows: readonly SubjectRow[]): RegionSubjects {
  const subjects: RegionSubjects = new Map();
  for (const row of rows) {
    const entry = subjects.get(row.kind) ?? { failing: [], unresolved: 0 };
    if (row.state === "failing")
      entry.failing.push({ id: row.subject, detail: row.detail });
    else entry.unresolved++;
    subjects.set(row.kind, entry);
  }
  return subjects;
}

/**
 * A node refusing this many wakes for awake capacity or for a full start queue within the window
 * is an alert.
 */
const CAPACITY_REFUSAL_COUNT = 5;
const CAPACITY_REFUSAL_WINDOW_MS = 600_000;
/** The share of a volume's space or inodes from which the database is warned, and warned loudly. */
const VOLUME_WARNING_PERCENT = 80;
const VOLUME_CRITICAL_PERCENT = 90;

/**
 * What the node samples and volume reports say of a region (plan 4.10): thin pools without room,
 * nodes that refuse wakes, and volumes that fill. As in `readRegionSubjects`, `unresolved` rows are
 * the subjects an active episode names that are not yet known to be fine.
 */
async function readNodeSubjects(
  db: D1Database,
  regionId: string,
  now: number,
): Promise<RegionSubjects> {
  const measured =
      "(v.observed_at>=p.fresh AND v.filesystem_used_bytes IS NOT NULL)",
    reached = (percent: number) =>
      `(v.filesystem_used_bytes*100>=${percent}*v.filesystem_total_bytes OR v.inodes_used*100>=${percent}*v.inodes_total)`,
    named = (kind: string) =>
      `d.id IN(SELECT n.value FROM infrastructure_alerts a,json_each(a.payload,'$.database_ids') n
        WHERE a.region_id=d.region_id AND a.kind='${kind}' AND a.active=1)`,
    volume = (kind: string, failing: string) =>
      `SELECT * FROM (SELECT '${kind}' kind,CASE WHEN ${failing} THEN 'failing' ELSE 'unresolved' END state,d.id subject,NULL detail
        FROM node_volumes v JOIN databases d ON d.id=v.database_id AND d.node_id=v.node_id
          AND d.storage_generation=v.storage_generation AND d.deleted_at IS NULL,p
        WHERE d.region_id=p.region AND (${failing} OR (${named(kind)} AND NOT ${measured}))
        ORDER BY state,d.id LIMIT 64)`;
  const result = await db
    .prepare(
      `WITH p AS (SELECT ? region,? fresh,? refused_since),
      latest AS (SELECT s.* FROM p,(${LATEST_SAMPLES_SQL}) s WHERE s.region_id=p.region)
      SELECT * FROM (SELECT 'thin_storage_blocked' kind,'failing' state,n.id subject,
          CASE WHEN l.observed_at IS NULL OR l.observed_at<p.fresh OR l.pool_data_total_bytes IS NULL
            THEN 'thin_pool_unobserved' ELSE 'thin_pool_no_room' END detail
        FROM nodes n,p LEFT JOIN latest l ON l.node_id=n.id
        WHERE n.region_id=p.region AND n.lost_at IS NULL
          AND CASE WHEN l.observed_at IS NULL OR l.observed_at<p.fresh OR l.pool_data_total_bytes IS NULL
            THEN EXISTS(SELECT 1 FROM databases h WHERE h.node_id=n.id AND NOT(h.desired_state='deleted' AND h.observed_state='deleted'))
            ELSE l.room=0 END
        ORDER BY n.id LIMIT 16)
      UNION ALL SELECT * FROM (SELECT 'regional_node_capacity_refusals','failing',n.id,NULL
        FROM nodes n,p WHERE n.region_id=p.region AND n.lost_at IS NULL
          AND (SELECT COALESCE(SUM(refused_no_headroom+refused_start_queue),0) FROM node_minutes WHERE node_id=n.id AND minute>p.refused_since)>=${CAPACITY_REFUSAL_COUNT}
        ORDER BY n.id LIMIT 64)
      UNION ALL ${volume("database_volume_warning", `(${measured} AND ${reached(VOLUME_WARNING_PERCENT)} AND NOT ${reached(VOLUME_CRITICAL_PERCENT)})`)}
      UNION ALL ${volume("database_volume_critical", `(${measured} AND ${reached(VOLUME_CRITICAL_PERCENT)})`)}`,
    )
    .bind(
      regionId,
      new Date(now - NODE_OBSERVATION_MAX_AGE_MS).toISOString(),
      minuteOf(now - CAPACITY_REFUSAL_WINDOW_MS),
    )
    .all<SubjectRow>();
  return collectSubjects(result.results);
}

const subjectObservation = (
  entry: { failing: Subject[]; unresolved: number } | undefined,
  detail: (failing: Subject[]) => EventDetail,
): Observation =>
  entry?.failing.length
    ? {
        state: "active",
        detail: detail(entry.failing),
        subjects: entry.failing.map((subject) => subject.id),
      }
    : entry?.unresolved
      ? { state: "retain" }
      : { state: "resolved" };

/** A refused enrollment keeps its episode this long after the last refusal (plan 8). */
const ENROLLMENT_REFUSAL_ALERT_MS = 24 * 3_600_000;
/** An unexpected reboot keeps its episode this long after the node's report (SEC-05). */
const UNEXPECTED_REBOOT_ALERT_MS = 24 * 3_600_000;
const HEALTH_KINDS = [
  "regional_node_stale",
  "node_enrollment_refused",
  "node_unexpected_reboot",
  "infrastructure_backup_failed",
  "infrastructure_backup_stale",
  "database_archive_failing",
  "database_base_backup_stale",
  "thin_storage_blocked",
  "regional_node_capacity_refusals",
  "regional_node_pool_closed",
  "database_volume_warning",
  "database_volume_critical",
] as const satisfies readonly InfraAlertKind[];
const pendingOf = (
  episodes: Iterable<AlertRow>,
  kinds: readonly InfraAlertKind[],
) =>
  [...episodes]
    .filter(
      (row) =>
        row.active === 1 &&
        row.delivered_at === null &&
        kinds.includes(row.kind),
    )
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));

async function regionHealthAlerts(
  env: Env,
  regionId: string,
  /** Null when the backup health could not be read: the backup kinds are then unknown. */
  health: Awaited<ReturnType<typeof infrastructureBackupHealth>> | null,
  now: number,
  fetcher: typeof fetch,
  deadline: number | undefined,
) {
  const nodes = await env.DB.prepare(
    `SELECT id,last_observed_at,lost_at,
      EXISTS(SELECT 1 FROM databases d WHERE d.node_id=nodes.id AND d.deleted_at IS NULL) holds_databases
     FROM nodes WHERE region_id=? AND node_uid IS NOT NULL AND (last_observed_at IS NOT NULL OR lost_at IS NOT NULL) ORDER BY id`,
  )
    .bind(regionId)
    .all<{
      id: string;
      last_observed_at: string | null;
      lost_at: string | null;
      holds_databases: number;
    }>();
  // A node the operator marked lost is announced while databases are still placed on it; once it
  // holds none, it is a record and nobody has anything to do.
  const failedNodes = nodes.results
    .filter((node) => {
      const status = heartbeatHealth(
        node.last_observed_at,
        node.lost_at,
        now,
      ).status;
      return status === "stale" || (status === "lost" && node.holds_databases);
    })
    .slice(0, 64);
  // The nodes whose enrollment token was presented in vain, newest first.
  const refused = await env.DB.prepare(
    `SELECT i.node_id FROM node_installs i JOIN node_additions a ON a.node_id=i.node_id
     WHERE a.region_id=? AND i.refused_at>=? ORDER BY i.refused_at DESC,i.node_id LIMIT 64`,
  )
    .bind(regionId, new Date(now - ENROLLMENT_REFUSAL_ALERT_MS).toISOString())
    .all<{ node_id: string }>();
  // The nodes that rebooted although no maintenance order asked for it, newest report first.
  const rebooted = await env.DB.prepare(
    `SELECT d.node_id FROM node_diagnostics d JOIN nodes n ON n.id=d.node_id
     WHERE n.region_id=? AND d.kind='boot' AND d.expected_reboot=0 AND d.received_at>=?
     GROUP BY d.node_id ORDER BY MAX(d.received_at) DESC,d.node_id LIMIT 64`,
  )
    .bind(regionId, new Date(now - UNEXPECTED_REBOOT_ALERT_MS).toISOString())
    .all<{ node_id: string }>();
  const backups = (health ?? []).filter(
      (value) => value.region_id === regionId,
    ),
    backupObservation = (status: "failing" | "stale"): Observation => {
      if (health === null) return { state: "retain" };
      const artifacts = backups.filter((value) => value.status === status);
      if (artifacts.length)
        return {
          state: "active",
          detail: {
            backup_artifacts: artifacts.map((value) => ({
              kind: value.kind,
              status,
              last_completed_at: value.last_completed_at,
              error_code: value.error_code,
            })),
          },
        };
      // An artifact whose health is unknown (its custody could not be read, or nothing has failed
      // or completed yet) keeps an active episode: clearing it would send it again next minute.
      return backups.some((value) => value.status === "unknown")
        ? { state: "retain" }
        : { state: "resolved" };
    };
  const current = await storedEpisodes(env.DB, regionId);
  // The database and node reads fail on their own: the node and backup kinds above still
  // evaluate, and the unread kinds are unknown (retained) for this minute.
  let subjects: RegionSubjects | undefined,
    closed: string[] | undefined,
    readFailure: { error: unknown } | undefined;
  try {
    subjects = new Map([
      ...(await readRegionSubjects(env.DB, regionId, now)),
      ...(await readNodeSubjects(env.DB, regionId, now)),
    ]);
    closed = await closedPools(env.DB, regionId);
  } catch (error) {
    readFailure = { error };
  }
  const subjectOf = (
    kind: InfraAlertKind,
    detail: (failing: Subject[]) => EventDetail,
  ): Observation =>
    subjects
      ? subjectObservation(subjects.get(kind), detail)
      : { state: "retain" };
  const observations: [InfraAlertKind, Observation][] = [
    [
      "regional_node_stale",
      failedNodes.length
        ? {
            state: "active",
            detail: { node_ids: failedNodes.map((node) => node.id) },
            subjects: failedNodes.map((node) => node.id),
          }
        : { state: "resolved" },
    ],
    [
      "node_enrollment_refused",
      refused.results.length
        ? {
            state: "active",
            detail: { node_ids: refused.results.map((node) => node.node_id) },
            subjects: refused.results.map((node) => node.node_id),
          }
        : { state: "resolved" },
    ],
    [
      "node_unexpected_reboot",
      rebooted.results.length
        ? {
            state: "active",
            detail: { node_ids: rebooted.results.map((node) => node.node_id) },
            subjects: rebooted.results.map((node) => node.node_id),
          }
        : { state: "resolved" },
    ],
    ["infrastructure_backup_failed", backupObservation("failing")],
    ["infrastructure_backup_stale", backupObservation("stale")],
    [
      "database_archive_failing",
      subjectOf("database_archive_failing", (failing) => ({
        database_ids: failing.map((subject) => subject.id),
      })),
    ],
    [
      "database_base_backup_stale",
      subjectOf("database_base_backup_stale", (failing) => ({
        database_ids: failing.map((subject) => subject.id),
      })),
    ],
    [
      "thin_storage_blocked",
      subjectOf("thin_storage_blocked", (failing) => ({
        thin_storage: failing.map((subject) => ({
          node_id: subject.id,
          error_code: subject.detail,
        })),
      })),
    ],
    [
      "regional_node_capacity_refusals",
      subjectOf("regional_node_capacity_refusals", (failing) => ({
        node_ids: failing.map((subject) => subject.id),
      })),
    ],
    [
      "regional_node_pool_closed",
      closed === undefined
        ? { state: "retain" }
        : closed.length
          ? {
              state: "active",
              detail: { node_ids: closed.slice(0, 64) },
              subjects: closed.slice(0, 64),
            }
          : { state: "resolved" },
    ],
    [
      "database_volume_warning",
      subjectOf("database_volume_warning", (failing) => ({
        database_ids: failing.map((subject) => subject.id),
      })),
    ],
    [
      "database_volume_critical",
      subjectOf("database_volume_critical", (failing) => ({
        database_ids: failing.map((subject) => subject.id),
      })),
    ],
  ];
  await reconcileAndDeliver(
    env,
    regionId,
    observations,
    current,
    HEALTH_KINDS,
    now,
    fetcher,
    deadline,
    readFailure,
  );
}

/**
 * Reconciles every kind of a region, delivers what is pending, then rethrows the first failure: a
 * kind that fails to evaluate or write never keeps the others from being judged or sent.
 */
async function reconcileAndDeliver(
  env: Env,
  regionId: string,
  observations: [InfraAlertKind, Observation][],
  current: Map<InfraAlertKind, AlertRow>,
  kinds: readonly InfraAlertKind[],
  now: number,
  fetcher: typeof fetch,
  deadline: number | undefined,
  earlier?: { error: unknown },
) {
  const allocated = lazyAllocated(env.DB, regionId);
  let written = false,
    failure = earlier;
  for (const [kind, observation] of observations)
    try {
      written =
        (await reconcileEpisode(
          env,
          regionId,
          kind,
          observation,
          current.get(kind),
          now,
          allocated,
        )) || written;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "infrastructure_alert_episode_failed",
          region_id: regionId,
          kind,
          error_code: cronErrorCode(error),
        }),
      );
      failure ??= { error };
    }
  const rows = written
    ? pendingOf((await storedEpisodes(env.DB, regionId)).values(), kinds)
    : pendingOf(current.values(), kinds);
  await deliverAlertRows(
    env,
    regionId,
    rows,
    now,
    fetcher,
    undefined,
    deadline,
  );
  if (failure) throw failure.error;
}

/**
 * Evaluates, for every region, the alarms that need no policy threshold: node heartbeats, daily
 * backup health and the database and Thin storage conditions. One durable episode per region and
 * kind; a region's failure is logged and does not skip the others, and an unreadable backup health
 * leaves only the backup kinds unknown. It also deletes the node diagnostics that are older than
 * 30 days: the reboot alert reads the last day of them.
 */
export async function runInfrastructureHealthAlerts(
  env: Env,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
  deadline?: number,
) {
  let failure: { error: unknown } | undefined,
    health: Awaited<ReturnType<typeof infrastructureBackupHealth>> | null =
      null;
  try {
    health = await infrastructureBackupHealth(env, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "infrastructure_backup_health_failed",
        error_code: cronErrorCode(error),
      }),
    );
    failure = { error };
  }
  try {
    await purgeNodeDiagnostics(env.DB, now);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "node_diagnostics_purge_failed",
        error_code: cronErrorCode(error),
      }),
    );
    failure ??= { error };
  }
  const regions = await env.DB.prepare(
    "SELECT id FROM regions ORDER BY id",
  ).all<{
    id: string;
  }>();
  for (const region of regions.results)
    try {
      await regionHealthAlerts(env, region.id, health, now, fetcher, deadline);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "infrastructure_health_alert_failed",
          region_id: region.id,
          error_code: cronErrorCode(error),
        }),
      );
      failure ??= { error };
    }
  if (failure) throw failure.error;
}

/** The capacity policy's thresholds for the first four regions with a policy, in region ID order. */
export async function runCapacityAlertsCron(
  env: Env,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
  deadline?: number,
) {
  const policies = await env.DB.prepare(
    "SELECT region_id FROM node_region_policies ORDER BY region_id LIMIT 4",
  ).all<{ region_id: string }>();
  let failure: { error: unknown } | undefined;
  for (const row of policies.results)
    try {
      await runInfrastructureAlerts(env, row.region_id, now, fetcher, deadline);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "infrastructure_alert_check_failed",
          region_id: row.region_id,
          error_code: cronErrorCode(error),
        }),
      );
      failure ??= { error };
    }
  if (failure) throw failure.error;
}

const CRON_KINDS = [
  "control_cron_stalled",
  "control_cron_step_failing",
] as const satisfies readonly InfraAlertKind[];

/**
 * Judges the minute cron's heartbeat and raises its alarms in every region. It never runs inside
 * the cron: the CronWatchdog Durable Object alarm calls it, so a cron that is stopped, hanging or
 * failing is reported by a clock the cron does not own.
 */
export async function runCronWatchdog(
  env: Env,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const health = await readCronHealth(env.DB, now);
  // Until the cron has recorded a run there is nothing to judge.
  if (health.status === "unknown") return;
  await env.DB.prepare(
    "UPDATE cron_heartbeat SET watchdog_checked_at=? WHERE singleton=1",
  )
    .bind(new Date(now).toISOString())
    .run();
  const detail: EventDetail = {
    cron: {
      last_started_at: health.last_started_at,
      last_completed_at: health.last_completed_at,
      failing_steps: health.failing_steps,
    },
  };
  const observations: [InfraAlertKind, Observation][] = [
    [
      "control_cron_stalled",
      health.status === "stalled"
        ? { state: "active", detail }
        : { state: "resolved" },
    ],
    [
      "control_cron_step_failing",
      // A stalled cron's step counters are those of its last completed run: not a fresh measurement.
      health.status === "stalled"
        ? { state: "retain" }
        : health.status === "failing"
          ? {
              state: "active",
              detail,
              // The steps that make it an error, not one that failed only once.
              identity: health.failing_steps
                .filter(
                  (value) =>
                    value.consecutive_failures >= CRON_STEP_FAILURE_RUNS,
                )
                .map((value) => value.step),
            }
          : { state: "resolved" },
    ],
  ];
  const regions = await env.DB.prepare(
    "SELECT id FROM regions ORDER BY id",
  ).all<{ id: string }>();
  let failure: { error: unknown } | undefined;
  for (const region of regions.results)
    try {
      await reconcileAndDeliver(
        env,
        region.id,
        observations,
        await storedEpisodes(env.DB, region.id),
        CRON_KINDS,
        now,
        fetcher,
        undefined,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "cron_watchdog_region_failed",
          region_id: region.id,
          error_code: cronErrorCode(error),
        }),
      );
      failure ??= { error };
    }
  if (failure) throw failure.error;
}
