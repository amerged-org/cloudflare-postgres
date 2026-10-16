// SPDX-License-Identifier: Apache-2.0
// Why a wake's power transition was refused while the database row did not move, and whether
// waiting can change it. The transition's start predicates stay the only authority: this module
// reads them again, part by part, only after a refusal, and sorts the failing parts into those a
// periodic report will end (the report is late) and those it will not (the node has no room).
import { SIDECAR } from "@pgcf/contracts";
import { qualifiedThinStorageSql } from "./node-thin-storage.ts";
import {
  computePoolOverheadSql,
  nodeCpuHeadroomSql,
  startupHeadroomSql,
} from "./startup-admission.ts";
import {
  boundStorageVolumeSql,
  databaseStorageStartupSql,
  storageProtectionCurrentSql,
} from "./storage-capacity.ts";

// The freshness windows of the start predicates, as their own SQL has them. They only sort a
// refusal: the guard decides, and a window that drifted from its SQL costs a wait that was not
// needed or an immediate refusal that could have waited, never a wake the guard did not grant.
/** nodeCpuHeadroomSql: `nodes.last_observed_at`. */
const NODE_OBSERVATION_MS = 180_000;
/** startupHeadroomSql: the newest `node_memory_samples.observed_at`. */
const MEMORY_SAMPLE_MS = 90_000;
/** nodeThinStorageHeadroomSql and storageProtectionCurrentSql: the thin authority and its proof. */
const THIN_AUTHORITY_MS = 120_000;
/** qualifiedThinStorageSql: the node's release observation. */
const QUALIFICATION_MS = 180_000;
/** Every window also refuses a reading from further ahead than this. */
const SKEW_MS = 5_000;

const mib = 1024 * 1024;
const age = (value: string) =>
  `CAST(ROUND((julianday('now')-julianday(${value}))*86400000) AS INTEGER)`;
const remaining = (value: string) =>
  `CAST(ROUND((julianday(${value})-julianday('now'))*86400000) AS INTEGER)`;
const authority = (path: string) =>
  `json_extract(ts.authority_json,'$.${path}')`;
/** A part of the start predicates, in the context the guard gives it: the database's node and size. */
const onNode = (part: string) =>
  `EXISTS(SELECT 1 FROM nodes n JOIN size_classes s ON s.id=d.size_class_id WHERE n.id=d.node_id AND n.region_id=d.region_id AND ${part})`;
const inventoryObserved = `COALESCE(${authority("inventory_observed_at")},${authority("observed_at")})`;
const inventoryExpires = `COALESCE(${authority("inventory_expires_at")},${authority("expires_at")})`;

/**
 * One read of everything the wake transition checks beside the row's own version: the parts the
 * guard is made of, each as the guard evaluates it, and the ages of the facts they judge. The
 * transition's three start predicates and its protection predicate are the builders' own SQL, so a
 * part is false exactly when the guard's part is.
 */
const WAKE_GUARD_SQL = `SELECT d.generation,d.desired_state,d.suspension_reason,
  (d.deleted_at IS NULL AND EXISTS(SELECT 1 FROM projects p WHERE p.id=d.project_id AND p.deleted_at IS NULL)) live,
  EXISTS(SELECT 1 FROM roles r WHERE r.database_id=d.id AND r.name=? AND r.deleted_at IS NULL) role,
  dn.id IS NOT NULL node_found,COALESCE(dn.ready=1,0) node_ready,COALESCE(dn.schedulable=1,0) node_schedulable,
  COALESCE(dn.lost_at IS NOT NULL,0) node_lost,${age("dn.last_observed_at")} node_observed_age_ms,
  ${onNode(nodeCpuHeadroomSql("n", "s", "d"))} cpu,
  COALESCE((SELECT placement_mode FROM node_region_policies WHERE region_id=d.region_id),'reserved') placement,
  ${onNode(startupHeadroomSql("n", "s"))} memory,
  ${age("(SELECT MAX(m.observed_at) FROM node_memory_samples m WHERE m.node_id=dn.id AND m.node_uid=dn.node_uid)")} memory_sample_age_ms,
  (SELECT m.memory_pressure FROM node_memory_samples m WHERE m.node_id=dn.id AND m.node_uid=dn.node_uid ORDER BY m.observed_at DESC LIMIT 1) memory_pressure,
  (SELECT m.available_bytes FROM node_memory_samples m WHERE m.node_id=dn.id AND m.node_uid=dn.node_uid ORDER BY m.observed_at DESC LIMIT 1) memory_available_bytes,
  (ds.memory_mib+${SIDECAR.limitMemoryMib}+${computePoolOverheadSql("dn", "memory_mib")})*${mib}
    +COALESCE((SELECT SUM(a.budget_bytes) FROM database_start_admissions a WHERE a.node_id=dn.id AND a.node_uid=dn.node_uid),0) memory_required_bytes,
  d.storage_profile_json IS NOT NULL thin,ts.status thin_status,ts.error_code thin_error,
  ${onNode(databaseStorageStartupSql("d"))} storage,
  ${age(authority("observed_at"))} authority_age_ms,${age("ts.authority_received_at")} authority_received_age_ms,
  ${remaining(authority("expires_at"))} authority_expires_in_ms,
  ${age(inventoryObserved)} inventory_age_ms,${remaining(inventoryExpires)} inventory_expires_in_ms,
  COALESCE(${authority("write_allowed")}=1 AND ${authority("data_accounting_complete")}=1 AND ts.status='ready',0) authority_write_allowed,
  COALESCE(${qualifiedThinStorageSql("ts")},0) qualified,
  (SELECT MAX(${age("o.observed_at")},${age("o.received_at")}) FROM fleet_node_release_observations o WHERE o.node_id=dn.id AND o.node_uid=dn.node_uid) qualification_age_ms,
  COALESCE((${boundStorageVolumeSql("d", "ts", false)}),0) volume_bound,
  COALESCE((${boundStorageVolumeSql("d", "ts", true)}),0) volume_current,
  d.storage_protected_at IS NOT NULL protected,
  (d.storage_protected_at IS NULL OR ${storageProtectionCurrentSql("d")}) protection,
  EXISTS(SELECT 1 FROM database_admission_epochs e WHERE e.database_id=d.id AND e.mutation_id IS NOT NULL) admission_pending
FROM databases d LEFT JOIN nodes dn ON dn.id=d.node_id AND dn.region_id=d.region_id
LEFT JOIN size_classes ds ON ds.id=d.size_class_id
LEFT JOIN node_thin_storage ts ON ts.node_id=dn.id AND ts.node_uid=dn.node_uid
WHERE d.id=?`;

/** The start predicates of a wake as one read found them; ages are milliseconds before the read. */
export interface WakeGuardReading {
  generation: number;
  desired_state: string;
  suspension_reason: string | null;
  /** The database and its project exist. */
  live: boolean;
  /** The role the connect named is a live role of the database. */
  role: boolean;
  node_found: boolean;
  node_ready: boolean;
  node_schedulable: boolean;
  node_lost: boolean;
  node_observed_age_ms: number | null;
  /** The node's CPU headroom for the start, including its own observation's freshness. */
  cpu: boolean;
  placement: string;
  /** The node's RAM headroom for the start; always true in `reserved` placement. */
  memory: boolean;
  memory_sample_age_ms: number | null;
  memory_pressure: number | null;
  memory_available_bytes: number | null;
  memory_required_bytes: number | null;
  /** The database has a thin volume; a thick one needs no storage headroom to wake. */
  thin: boolean;
  thin_status: string | null;
  thin_error: string | null;
  /** The thin node's headroom for the start: authority, identity, qualification and pool. */
  storage: boolean;
  authority_age_ms: number | null;
  authority_received_age_ms: number | null;
  authority_expires_in_ms: number | null;
  inventory_age_ms: number | null;
  inventory_expires_in_ms: number | null;
  authority_write_allowed: boolean;
  qualified: boolean;
  qualification_age_ms: number | null;
  /** The accepted identity proof lists this database's volume, at any generation. */
  volume_bound: boolean;
  /** ... and at the database's current generation. */
  volume_current: boolean;
  protected: boolean;
  /** A protective stop is none, or still proved by the current report. */
  protection: boolean;
  /** Another admission mutation of this database is in flight. */
  admission_pending: boolean;
}

const FLAGS = [
  "live",
  "role",
  "node_found",
  "node_ready",
  "node_schedulable",
  "node_lost",
  "cpu",
  "memory",
  "thin",
  "storage",
  "authority_write_allowed",
  "qualified",
  "volume_bound",
  "volume_current",
  "protected",
  "protection",
  "admission_pending",
] as const;

/** Null when the database is gone. A failed read is the caller's to handle. */
export async function readWakeGuard(
  db: D1Database,
  databaseId: string,
  role: string,
): Promise<WakeGuardReading | null> {
  const row = await db
    .prepare(WAKE_GUARD_SQL)
    .bind(role, databaseId)
    .first<Record<string, number | string | null>>();
  if (!row) return null;
  const reading = { ...row } as Record<string, unknown>;
  for (const flag of FLAGS) reading[flag] = row[flag] === 1;
  return reading as unknown as WakeGuardReading;
}

/** A failing part of the guard, and whether a report that is merely late would end it. */
export interface WakeGuardBlock {
  reason: string;
  waits: boolean;
}

const within = (ms: number | null, window: number) =>
  ms !== null && ms <= window && ms >= -SKEW_MS;

/** The freshness of each report the guard judges, as the guard's own windows see it. */
export function wakeGuardFacts(g: WakeGuardReading) {
  return {
    node_observation_fresh: within(g.node_observed_age_ms, NODE_OBSERVATION_MS),
    memory_sample_fresh: within(g.memory_sample_age_ms, MEMORY_SAMPLE_MS),
    qualification_fresh: within(g.qualification_age_ms, QUALIFICATION_MS),
    /** The fast reading: observed, received and not yet expired. */
    authority_fresh:
      within(g.authority_age_ms, THIN_AUTHORITY_MS) &&
      within(g.authority_received_age_ms, THIN_AUTHORITY_MS) &&
      (g.authority_expires_in_ms ?? 0) > 0,
    /** The identity proof behind it: read before now and still valid. */
    inventory_valid:
      (g.inventory_age_ms ?? Number.NEGATIVE_INFINITY) >= -SKEW_MS &&
      (g.inventory_expires_in_ms ?? 0) > 0,
    /** What a protective stop needs: a report and a proof read within the last two minutes. */
    protection_proved:
      within(g.authority_received_age_ms, THIN_AUTHORITY_MS) &&
      within(g.inventory_age_ms, THIN_AUTHORITY_MS) &&
      (g.inventory_expires_in_ms ?? 0) > 0,
  };
}

/**
 * The parts of the guard that are false, in the order the transition names them. A fact judged on
 * a stale report is not judged: the part is blocked by the report being late, which a later
 * report ends, and only a part that fails on current facts is a refusal that stays.
 */
export function wakeGuardBlocks(g: WakeGuardReading): WakeGuardBlock[] {
  const blocks: WakeGuardBlock[] = [];
  const stays = (reason: string) => blocks.push({ reason, waits: false });
  const late = (reason: string) => blocks.push({ reason, waits: true });
  const fresh = wakeGuardFacts(g);
  if (!g.live) stays("database_deleted");
  if (!g.role) stays("role_deleted");
  if (!g.node_found || !g.node_ready || !g.node_schedulable || g.node_lost)
    // Not a report that is late: the other parts of this node cannot be judged either.
    stays(
      !g.node_found
        ? "node_missing"
        : g.node_lost
          ? "node_lost"
          : !g.node_ready
            ? "node_not_ready"
            : "node_unschedulable",
    );
  else {
    if (!g.cpu)
      if (fresh.node_observation_fresh) stays("cpu_capacity");
      else late("node_observation_stale");
    if (!g.memory)
      if (fresh.memory_sample_fresh) stays("memory_capacity");
      else late("memory_sample_stale");
    if (!g.storage)
      if (g.thin_error !== null) stays("thin_blocked");
      else if (g.authority_age_ms === null) stays("thin_authority_missing");
      else if (!g.qualified)
        if (fresh.qualification_fresh) stays("thin_unqualified");
        else late("thin_qualification_stale");
      else if (!fresh.authority_fresh || !fresh.inventory_valid)
        late("thin_authority_stale");
      else if (!g.volume_current)
        // Only an identity proof reads a volume at its generation.
        if (g.volume_bound) late("thin_identity_behind");
        else stays("thin_identity_mismatch");
      else if (!g.authority_write_allowed) stays("thin_write_denied");
      else stays("thin_capacity");
  }
  if (!g.protection)
    if (fresh.protection_proved) stays("protection_not_proved");
    else late("protection_proof_stale");
  return blocks;
}

/**
 * What the reading means for a wake of an idle sleeper.
 * - `moved`: the database is no longer an idle sleeper; whoever claims decides.
 * - `holds`: every part holds; a claim may be made now.
 * - `waits`: only late reports refuse it; a later report will end that.
 * - `refused`: a part fails on current facts, or the database or role is gone.
 */
export type WakeGuardVerdict = "moved" | "holds" | "waits" | "refused";

export function wakeGuardVerdict(
  reading: WakeGuardReading | null,
  blocks = reading ? wakeGuardBlocks(reading) : [],
): WakeGuardVerdict {
  if (
    !reading ||
    reading.desired_state !== "suspended" ||
    reading.suspension_reason !== "idle"
  )
    return "moved";
  if (blocks.length === 0) return "holds";
  return blocks.every((block) => block.waits) ? "waits" : "refused";
}
