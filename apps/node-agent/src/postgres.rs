// SPDX-License-Identifier: Apache-2.0
//! The agent's sessions with a database's PostgreSQL, and the statements it keeps (plan 5.5, 7.9).
//!
//! The agent reaches a database only over the Unix socket of its socket directory, as the cluster's
//! superuser `postgres`, by peer authentication: the node's root maps to that role in
//! `pg_ident.conf` (`settings`). No password and no address is involved, and nothing outside the
//! database's unit and the agent can use the role.
use crate::{Error, layout::PORT};
use std::{path::Path, time::Duration};
use tokio_postgres::{Client, Row, types::ToSql};

/// How long one statement may take: the proof of a sleep and a role change are short.
const STATEMENT: Duration = Duration::from_secs(5);
/// A statement that makes a database (`CREATE DATABASE` copies a template).
const LONG_STATEMENT: Duration = Duration::from_secs(60);

pub struct Session {
    pub client: Client,
    task: tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>,
}
impl Drop for Session {
    fn drop(&mut self) {
        // The client drops next, so its connection sends Terminate. A connection still open 500 ms
        // later, e.g. awaiting a reply, is aborted. Outside a runtime nothing can bound that
        // close, so the connection is aborted at once.
        let task = self.task.abort_handle();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    task.abort();
                });
            }
            Err(_) => task.abort(),
        }
    }
}
impl Session {
    pub async fn query(&self, sql: &str, args: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error> {
        Ok(tokio::time::timeout(STATEMENT, self.client.query(sql, args)).await??)
    }
    /// Runs statements that take no parameters, one after the other.
    pub async fn batch(&self, sql: &str) -> Result<(), Error> {
        Ok(tokio::time::timeout(STATEMENT, self.client.batch_execute(sql)).await??)
    }
    /// Like `batch`, for a statement that copies a template database or runs a checkpoint.
    pub async fn batch_long(&self, sql: &str) -> Result<(), Error> {
        Ok(tokio::time::timeout(LONG_STATEMENT, self.client.batch_execute(sql)).await??)
    }
}

/// A session as `role` on `database`, through the socket in `socket_directory`.
pub async fn connect(
    socket_directory: &Path,
    role: &str,
    database: &str,
) -> Result<Session, Error> {
    let mut config = tokio_postgres::Config::new();
    config
        .host_path(socket_directory)
        .port(PORT)
        .user(role)
        .dbname(database)
        .application_name("pgcf-agent")
        .options("-c statement_timeout=60000")
        .connect_timeout(Duration::from_secs(5));
    let (client, connection) = tokio::time::timeout(
        Duration::from_secs(5),
        config.connect(tokio_postgres::NoTls),
    )
    .await??;
    let task = tokio::spawn(connection);
    Ok(Session { client, task })
}

/// The agent's own session: the cluster's superuser on its maintenance database.
pub async fn agent(socket_directory: &Path) -> Result<Session, Error> {
    connect(socket_directory, crate::settings::AGENT_ROLE, "postgres").await
}

/// The row of a role in the catalog by name, columns by position. `rolvaliduntil` is a
/// `timestamptz`, NULL for no expiry and possibly `infinity`; `rolconnlimit` is -1 for no limit.
/// No row is a role PostgreSQL does not have.
pub(crate) const ROLE_CATALOG_QUERY: &str = "SELECT rolname, rolcanlogin, rolvaliduntil, rolconnlimit, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1";
/// The roles a role is a member of, one row each.
pub(crate) const MEMBERSHIP_QUERY: &str = "SELECT granted.rolname FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid JOIN pg_catalog.pg_roles member ON member.oid = m.member WHERE member.rolname = $1";
/// The objects and privileges in any database that depend on a role: what makes `DROP ROLE` fail.
pub(crate) const DEPENDENCIES_QUERY: &str = "SELECT count(*) FROM pg_catalog.pg_shdepend d JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND r.rolname = $1";
/// Ends the sessions of a role; the role is bound, never part of the text.
pub(crate) const TERMINATE_QUERY: &str = "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()";
/// The sessions of a role that are still there.
pub(crate) const SESSIONS_QUERY: &str = "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()";
/// The data directory a postmaster runs on: the system identifier of its `pg_control` (fixed by
/// `initdb`, the same for a clone of the cluster) and the timeline of its latest checkpoint. Both
/// functions answer any role.
pub const SERVER_IDENTITY_QUERY: &str = "SELECT (SELECT system_identifier FROM pg_catalog.pg_control_system())::pg_catalog.text AS system_identifier,
 (SELECT timeline_id FROM pg_catalog.pg_control_checkpoint())::pg_catalog.int4 AS timeline";
#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpg::Cluster;

    #[tokio::test]
    async fn the_agent_reaches_a_database_by_peer_over_its_socket() {
        let Some(cluster) = Cluster::create("session") else {
            return;
        };
        cluster.start();
        let session = agent(&cluster.socket_directory()).await.unwrap();
        let rows = session
            .query("SELECT current_user::pg_catalog.text", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, String>(0), "postgres");
        let rows = session.query(SERVER_IDENTITY_QUERY, &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i32>("timeline"), 1);
    }
}
