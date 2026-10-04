// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from "node:crypto";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import {
  DatabaseId,
  OperationId,
  gatewayControlReportSchema,
  gatewayPodUidSchema,
} from "@pgcf/contracts";

export const MAINTENANCE_ROLE = "pgcf_maintenance";
export const SLEEP_BOOTSTRAP_GRANTS = Object.freeze([
  "CREATE ROLE pgcf_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
  "GRANT pg_read_all_stats TO pgcf_maintenance",
  "GRANT EXECUTE ON FUNCTION pg_catalog.pg_switch_wal() TO pgcf_maintenance",
  "GRANT EXECUTE ON FUNCTION pg_catalog.pg_ls_archive_statusdir() TO pgcf_maintenance",
]);

export interface SleepProbeOptions {
  databaseId: string;
  namespace: string;
  credentials: { user: string; password: string };
  ca: string;
  signal: AbortSignal;
  deadline: number;
  quiescence: {
    operation: string;
    revision: number;
    gatewayPods: readonly string[];
  };
  verifyQuiescence(signal: AbortSignal): Promise<unknown>;
  onClosedSegment?(segment: string): Promise<void>;
}
export type SleepRefusal =
  | "invalid_input"
  | "not_quiescent"
  | "sql_busy"
  | "prepared_work"
  | "sql_unknown"
  | "probe_unavailable"
  | "switch_unknown"
  | "archive_timeout"
  | "aborted";
export type SleepSafetyResult =
  | { safe: true; segment: string }
  | { safe: false; reason: SleepRefusal; segment?: string };
export type SleepClientFactory = (config: ClientConfig) => Client;
const SEGMENT = /^[0-9A-F]{24}$/;
const MAX_STEP_MS = 600_000;
const CLEAR = "SELECT pg_catalog.pg_stat_clear_snapshot()";
const GUARD = `SELECT
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_stat_activity
    WHERE datid IS NOT NULL AND pid <> pg_catalog.pg_backend_pid()
      AND (state IS DISTINCT FROM 'idle' OR xact_start IS NOT NULL)) AS busy,
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_prepared_xacts) AS prepared`;
const IDENTITY = `SELECT pg_catalog.current_database() AS database,
  pg_catalog.pg_is_in_recovery() AS recovery,
  (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS tls,
  r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
  pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats
  FROM pg_catalog.pg_roles r WHERE r.rolname=$1
    AND r.rolname=pg_catalog.current_setting('session_authorization')`;
const SWITCH = `WITH switched AS MATERIALIZED (SELECT pg_catalog.pg_switch_wal() AS lsn)
  SELECT lsn::pg_catalog.text AS lsn,pg_catalog.pg_walfile_name(lsn-1) AS segment FROM switched`;
const ARCHIVE_STATUS = `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_ls_archive_statusdir() WHERE name=$1) AS done`;
class Refusal extends Error {
  readonly reason: SleepRefusal;
  constructor(reason: SleepRefusal) {
    super(reason);
    this.reason = reason;
  }
}
function refuse(reason: SleepRefusal): never {
  throw new Refusal(reason);
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Refusal("aborted"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Refusal("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function valid(options: SleepProbeOptions): string {
  if (
    !DatabaseId.safeParse(options.databaseId).success ||
    options.namespace !== `pgcf-db-${options.databaseId}` ||
    options.credentials?.user !== MAINTENANCE_ROLE ||
    typeof options.credentials.password !== "string" ||
    options.credentials.password.length < 1 ||
    options.credentials.password.length > 4096 ||
    options.credentials.password.includes("\0") ||
    typeof options.ca !== "string" ||
    options.ca.length > 128 * 1024 ||
    !(options.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(options.deadline) ||
    options.deadline <= Date.now() ||
    options.deadline - Date.now() > MAX_STEP_MS ||
    typeof options.verifyQuiescence !== "function" ||
    !OperationId.safeParse(options.quiescence?.operation).success ||
    !Number.isSafeInteger(options.quiescence.revision) ||
    options.quiescence.revision < 1 ||
    !Array.isArray(options.quiescence.gatewayPods) ||
    options.quiescence.gatewayPods.length < 1 ||
    options.quiescence.gatewayPods.length > 64 ||
    new Set(options.quiescence.gatewayPods).size !==
      options.quiescence.gatewayPods.length ||
    options.quiescence.gatewayPods.some(
      (pod) => !gatewayPodUidSchema.safeParse(pod).success,
    )
  )
    refuse("invalid_input");
  try {
    if (!new X509Certificate(options.ca).ca) refuse("invalid_input");
  } catch {
    refuse("invalid_input");
  }
  return `database-rw.${options.namespace}.svc`;
}
async function quiescent(
  options: SleepProbeOptions,
  signal: AbortSignal,
): Promise<void> {
  const raw = await bounded(
    Promise.resolve().then(() => options.verifyQuiescence(signal)),
    signal,
  );
  if (
    !Array.isArray(raw) ||
    raw.length !== options.quiescence.gatewayPods.length
  )
    refuse("not_quiescent");
  const pods = new Set<string>();
  for (const value of raw) {
    const parsed = gatewayControlReportSchema.safeParse(value);
    if (!parsed.success) refuse("not_quiescent");
    const report = parsed.data;
    if (
      report.database !== options.databaseId ||
      report.operation !== options.quiescence.operation ||
      report.revision !== options.quiescence.revision ||
      report.mode !== "quiesce" ||
      !["idle", "closed"].includes(report.status) ||
      report.busyConnections !== 0 ||
      report.pendingDials !== 0 ||
      !options.quiescence.gatewayPods.includes(report.pod) ||
      pods.has(report.pod)
    )
      refuse("not_quiescent");
    pods.add(report.pod);
  }
}
async function safety(client: Client, signal: AbortSignal): Promise<void> {
  await bounded(client.query(CLEAR), signal);
  const result = await bounded(
    client.query<{ busy: number; prepared: number }>(GUARD),
    signal,
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    !row ||
    !Number.isSafeInteger(row.busy) ||
    row.busy < 0 ||
    !Number.isSafeInteger(row.prepared) ||
    row.prepared < 0
  )
    refuse("sql_unknown");
  if (row.prepared > 0) refuse("prepared_work");
  if (row.busy > 0) refuse("sql_busy");
}
async function pause(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, 250);
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}
async function close(client: Client): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      client.connection.stream.destroy();
      resolve();
    }, 1000);
    client.end().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        client.connection.stream.destroy();
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
async function run(
  options: SleepProbeOptions,
  knownSegment: string | undefined,
  createClient: SleepClientFactory,
): Promise<SleepSafetyResult> {
  let client: Client | undefined;
  let signal: AbortSignal | undefined;
  let abort: (() => void) | undefined;
  let segment: string | undefined;
  try {
    const host = valid(options);
    // Keep all three observations bound to the caller's initial operation and pod inventory.
    options = {
      ...options,
      credentials: { ...options.credentials },
      quiescence: {
        ...options.quiescence,
        gatewayPods: [...options.quiescence.gatewayPods],
      },
    };
    if (knownSegment !== undefined && !SEGMENT.test(knownSegment))
      refuse("invalid_input");
    segment = knownSegment;
    signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.deadline - Date.now()),
    ]);
    await quiescent(options, signal);
    client = createClient({
      host,
      port: 5432,
      database: options.databaseId,
      user: options.credentials.user,
      password: options.credentials.password,
      application_name: "pgcf-sleep-probe",
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
      options: "-c search_path=pg_catalog",
      ssl: { ca: options.ca, servername: host, rejectUnauthorized: true },
    });
    client.on("error", () => {});
    abort = () => client?.connection.stream.destroy();
    signal.addEventListener("abort", abort, { once: true });
    await bounded(client.connect(), signal);
    const identity = await bounded(
      client.query(IDENTITY, [MAINTENANCE_ROLE]),
      signal,
    );
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1 ||
      !row ||
      row.database !== options.databaseId ||
      row.recovery !== false ||
      row.tls !== true ||
      row.stats !== true ||
      [
        "rolsuper",
        "rolcreatedb",
        "rolcreaterole",
        "rolreplication",
        "rolbypassrls",
      ].some((key) => row[key] !== false)
    )
      refuse("probe_unavailable");
    await safety(client, signal);
    await quiescent(options, signal);
    if (segment === undefined) {
      if (signal.aborted) refuse("aborted");
      try {
        const result = await bounded(
          client.query<{ lsn: string; segment: string }>(SWITCH),
          signal,
        );
        const switched = result.rows[0];
        if (
          result.rows.length !== 1 ||
          !switched ||
          !/^[0-9A-F]+\/[0-9A-F]+$/.test(switched.lsn) ||
          switched.lsn === "0/0" ||
          !SEGMENT.test(switched.segment)
        )
          refuse("switch_unknown");
        segment = switched.segment;
      } catch {
        refuse("switch_unknown");
      }
      if (options.onClosedSegment)
        await bounded(
          Promise.resolve().then(() => options.onClosedSegment!(segment!)),
          signal,
        );
    }
    for (;;) {
      if (signal.aborted)
        refuse(options.signal.aborted ? "aborted" : "archive_timeout");
      const archived = await bounded(
        client.query<{ done: boolean }>(ARCHIVE_STATUS, [`${segment}.done`]),
        signal,
      );
      if (
        archived.rows.length !== 1 ||
        typeof archived.rows[0]?.done !== "boolean"
      )
        refuse("sql_unknown");
      if (archived.rows[0].done) break;
      await pause(signal);
    }
    await safety(client, signal);
    await quiescent(options, signal);
    if (signal.aborted || Date.now() >= options.deadline)
      refuse(options.signal.aborted ? "aborted" : "archive_timeout");
    return { safe: true, segment: segment! };
  } catch (error) {
    const reason =
      error instanceof Refusal
        ? error.reason === "aborted" && !options.signal.aborted && segment
          ? "archive_timeout"
          : error.reason
        : "probe_unavailable";
    return { safe: false, reason, ...(segment ? { segment } : {}) };
  } finally {
    if (client) await close(client);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

export function probeSleepSafety(
  options: SleepProbeOptions,
  createClient: SleepClientFactory = (config) => new Client(config),
): Promise<SleepSafetyResult> {
  return run(options, undefined, createClient);
}
/** Resume only an already recorded closed segment; this path never invokes pg_switch_wal. */
export function resumeSleepSafety(
  options: SleepProbeOptions,
  segment: string,
  createClient: SleepClientFactory = (config) => new Client(config),
): Promise<SleepSafetyResult> {
  return run(options, segment, createClient);
}
