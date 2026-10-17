// SPDX-License-Identifier: Apache-2.0
//! The node's archive side (ULTRA plan 7.4-7.8): the archive socket that PostgreSQL's
//! `archive_command` and `restore_command` reach, and the barman-cloud jobs the agent runs as
//! each database's own user.
//!
//! - `server`: the socket. A `Table` of registered databases, keyed by the uid the kernel reports
//!   for a connection, tells it whose archive a request concerns. `ok` to an archive request
//!   follows the object in R2 and the entry in the upload log; the agent never deletes in R2.
//! - `job`: the barman-cloud command lines, the transient `systemd-run` unit around each (the
//!   database's user, `pgcf-backup.slice`, its volume alone, one credential), and the limits.
//! - `recovery`: the settings and files that make a restored volume recover through the socket.
//! - `facts`: what the agent reports about the archive; `upload_log`: the fsynced log the sleep
//!   proof reads; `protocol`: the lines of the socket, which `apps/pgcf-archive` speaks as the
//!   client (the contract's vectors decide both).
//!
//! The agent that owns the page keeps the table, the credentials and the `Jobs` of the node: it
//! registers a database when its page entry says it runs, and gives a restore or move target a
//! `Recovery` (with `required_through` from the move's proven-sleep record) until the recovery
//! has ended. A database's `postgresql.conf` includes `pgcf-recovery.conf` if it exists.
pub mod facts;
pub mod job;
#[cfg(test)]
mod postgres_tests;
pub mod protocol;
pub mod recovery;
pub mod server;
#[cfg(test)]
mod test_support;
pub mod upload_log;
