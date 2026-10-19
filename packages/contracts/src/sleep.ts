// SPDX-License-Identifier: Apache-2.0
export const SLEEP_REFUSALS = [
  "invalid_input",
  "not_quiescent",
  "sql_busy",
  "prepared_work",
  "sql_unknown",
  "probe_unavailable",
  "switch_unknown",
  "archive_timeout",
  "aborted",
] as const;
export type SleepRefusal = (typeof SLEEP_REFUSALS)[number];
const CLEAR = "SELECT pg_catalog.pg_stat_clear_snapshot()";
// The autoprewarm worker reads blocks into the shared buffers after every start, connected to a
// database and with no state: it is not a session, and a database woken and put to sleep at once
// must not be refused for it. Other background workers still count: an autovacuum worker that
// runs keeps the database awake until it ends.
const GUARD = `SELECT
  (SELECT pg_catalog.count(*)::pg_catalog.int4 FROM pg_catalog.pg_stat_activity
    WHERE datid IS NOT NULL AND pid <> pg_catalog.pg_backend_pid()
      AND backend_type <> 'autoprewarm worker'
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
/** Authoritative statements of the sleep proof. */
export const SLEEP_SQL = Object.freeze({
  CLEAR,
  GUARD,
  IDENTITY,
  SWITCH,
  ARCHIVE_STATUS,
});
