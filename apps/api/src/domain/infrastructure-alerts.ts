// SPDX-License-Identifier: Apache-2.0
import {
  InfraAlert,
  InfraAlertStatus,
  type InfraAlertKind,
} from "@pgcf/contracts";
import type { Env } from "../env.ts";
import { regionalRamWindowSql } from "./memory-capacity.ts";
import { regionalNodeCountSql } from "./node-capacity-count.ts";

interface AlertRow {
  kind: InfraAlertKind;
  active: number;
  event_id: string;
  payload: string;
  delivered_at: string | null;
  last_attempt_at: string | null;
}
const retryMs = 60_000;

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
    "SELECT max_nodes FROM node_region_policies WHERE region_id=?",
  )
    .bind(regionId)
    .first<{ max_nodes: number | null }>();
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
  const conditions: [InfraAlertKind, boolean | null][] = [
    [
      "regional_ram_warning",
      window === null
        ? null
        : BigInt(window.working_set_bytes) * 100n >=
          BigInt(window.capacity_memory_bytes) * 75n,
    ],
    [
      "regional_node_cap_reached",
      policy.max_nodes !== null && allocated >= policy.max_nodes,
    ],
  ];
  for (const [kind, active] of conditions) {
    // Unknown RAM never clears an existing episode or creates a new measured warning.
    if (active === null) continue;
    const snapshot =
      kind === "regional_ram_warning"
        ? {
            sql: `EXISTS(SELECT 1 FROM (${regionalRamWindowSql("?")}) measured
          WHERE measured.minute=? AND measured.working_set_bytes=? AND measured.capacity_memory_bytes=?)`,
            bindings: [
              regionId,
              window!.minute,
              window!.working_set_bytes,
              window!.capacity_memory_bytes,
            ],
          }
        : {
            sql: `EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=? AND p.max_nodes IS ?
          AND ${regionalNodeCountSql("p.region_id", true)}=?)`,
            bindings: [regionId, policy.max_nodes, allocated],
          };
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
    });
    await env.DB.prepare(
      `INSERT INTO infrastructure_alerts(region_id,kind,active,event_id,payload)
      SELECT ?,?,1,?,? WHERE ${snapshot.sql} ON CONFLICT(region_id,kind) DO UPDATE SET active=1,event_id=excluded.event_id,
        payload=excluded.payload,delivered_at=NULL,last_attempt_at=NULL WHERE infrastructure_alerts.active=0`,
    )
      .bind(
        regionId,
        kind,
        event.event_id,
        JSON.stringify(event),
        ...snapshot.bindings,
      )
      .run();
  }
  const pending = await env.DB.prepare(
    "SELECT * FROM infrastructure_alerts WHERE region_id=? AND active=1 AND delivered_at IS NULL ORDER BY kind",
  )
    .bind(regionId)
    .all<AlertRow>();
  const destination = callback(env);
  if (!destination) return { delivered: 0, pending: pending.results.length };
  let delivered = 0;
  for (const row of pending.results) {
    const claim = await env.DB.prepare(
      `UPDATE infrastructure_alerts SET last_attempt_at=?
      WHERE region_id=? AND kind=? AND event_id=? AND active=1 AND delivered_at IS NULL
        AND (last_attempt_at IS NULL OR last_attempt_at<=?)`,
    )
      .bind(
        timestamp,
        regionId,
        row.kind,
        row.event_id,
        new Date(now - retryMs).toISOString(),
      )
      .run();
    if (claim.meta.changes !== 1) continue;
    const abort = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const options: RequestInit = {
        method: "POST",
        redirect: "manual",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${destination.token}`,
          "Idempotency-Key": row.event_id,
        },
        body: row.payload,
      };
      const delivery = (
        destination.service
          ? destination.service.fetch(new Request(destination.url, options))
          : fetcher(destination.url, options)
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
      const acknowledged = await env.DB.prepare(
        `UPDATE infrastructure_alerts SET delivered_at=?
        WHERE region_id=? AND kind=? AND event_id=? AND active=1 AND delivered_at IS NULL AND last_attempt_at=?`,
      )
        .bind(timestamp, regionId, row.kind, row.event_id, timestamp)
        .run();
      delivered += acknowledged.meta.changes;
    } catch {
      // A lost response retains the same durable ID/payload and retries through receiver deduplication.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return { delivered, pending: pending.results.length - delivered };
}
