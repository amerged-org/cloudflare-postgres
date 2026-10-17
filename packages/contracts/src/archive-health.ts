// SPDX-License-Identifier: Apache-2.0
export const ARCHIVE_FAILURE_MS = 10 * 60_000;
export const WAL_BACKLOG_LIMIT = 32;
// `only_stats` holds while the role is a member of nothing beyond the two roles it is granted:
// pg_read_all_stats for this sample and pg_signal_backend, which ends the sessions of a role
// awaiting removal (see MAINTENANCE_ROLE in maintenance.ts).
export const ARCHIVE_IDENTITY_QUERY = `SELECT pg_catalog.current_database() AS database,pg_catalog.current_setting('session_authorization') AS role,
 pg_catalog.pg_is_in_recovery() AS recovery,pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address,
 (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS tls,
 r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid WHERE m.member=r.oid AND granted.rolname NOT IN ('pg_read_all_stats','pg_signal_backend')) AS only_stats,
 pg_catalog.pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats,
 pg_catalog.has_function_privilege(r.oid,'pg_catalog.pg_ls_archive_statusdir()','EXECUTE') AS archive_listing
 FROM pg_catalog.pg_roles r WHERE r.rolname=$1 AND r.rolname=pg_catalog.current_setting('session_authorization')`;
export const ARCHIVE_QUERY = `SELECT (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_ls_archive_statusdir() WHERE name LIKE '%.ready') AS ready_wal_files,
 archived_count::text,COALESCE(EXTRACT(EPOCH FROM last_archived_time)::text,'-1') AS last_archived_time,failed_count::text
 FROM pg_catalog.pg_stat_archiver`;
