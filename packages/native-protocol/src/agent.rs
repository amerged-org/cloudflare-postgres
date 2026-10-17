// SPDX-License-Identifier: Apache-2.0
//! The node agent's local channel to the gateway (plan 5.7): one Unix stream socket that the agent
//! serves and the gateway connects to. Each message is one line of JSON.
//!
//! The agent sends the whole writer table first and then every change of it, the results of the
//! wakes the gateway queued, and its quiesce, close, status and activity requests. The gateway
//! sends the wakes of held connections (route v5) and its answers. A connection that ends, or a
//! message that is not valid, ends the channel; the gateway then admits nothing new until the
//! agent's next table, and the established sessions keep their writer.
//!
//! A database's writer is its PostgreSQL unit: the Unix socket it listens on, the database's own
//! uid and the unit's main PID, which the gateway compares with the kernel's peer credentials of
//! every connection it dials, and the unit's invocation ID, which the route names.
use crate::{
    valid_pattern,
    wake::{WakeRequest, WakeResult},
};
use serde::{Deserialize, Serialize};

/// Where the agent serves the channel.
pub const GATEWAY_SOCKET: &str = "/run/pgcf/agent/gateway.sock";
/// The longest line either side sends: a table of many databases.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// The most databases one table names.
pub const MAX_DATABASES: usize = 10_000;
/// The longest socket path: below the 104 bytes of `sun_path` on every supported system.
pub const MAX_SOCKET_PATH_BYTES: usize = 100;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// What the database's PostgreSQL does for its clients.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Running at its generation: routes are admitted and sessions forwarded.
    Running,
    /// A sleep is being proven: nothing new is admitted and the bytes of sessions wait.
    Quiesce,
    /// Stopped with a proven sleep; a wake ticket of the next generation wakes it.
    Sleeping,
    /// Deleted, moved or superseded on this node: its sessions are closed.
    Retired,
}

/// The PostgreSQL unit that serves a database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Writer {
    /// The Unix socket PostgreSQL listens on.
    pub socket: String,
    /// The database's own Linux user.
    pub uid: u32,
    /// The unit's main PID: the postmaster.
    pub pid: u32,
    /// The unit's invocation ID, as a UUID; the route names it.
    pub instance: String,
}
impl Writer {
    pub fn valid(&self) -> bool {
        self.socket.starts_with('/')
            && self.socket.len() <= MAX_SOCKET_PATH_BYTES
            && !self.socket.contains('\0')
            && !self.socket.split('/').any(|part| part == "..")
            // The root user is never a database's user, and PID 1 is never a database's unit.
            && self.uid != 0
            && self.pid > 1
            && valid_pattern("uuid", &self.instance)
    }
}

/// One database of the agent's table.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Database {
    pub database: String,
    /// The generation D1 names for the database on this node.
    pub generation: u64,
    /// The operation of that generation.
    pub operation: String,
    pub mode: Mode,
    /// The admission route revision the gateway admits routes of.
    pub route_revision: u64,
    /// The unit while PostgreSQL runs: present exactly when running or quiescing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer: Option<Writer>,
}
impl Database {
    pub fn valid(&self) -> bool {
        valid_pattern("database", &self.database)
            && valid_pattern("operation", &self.operation)
            && (1..=MAX_SAFE).contains(&self.generation)
            && (1..=MAX_SAFE).contains(&self.route_revision)
            && match (&self.mode, &self.writer) {
                (Mode::Running | Mode::Quiesce, Some(writer)) => writer.valid(),
                (Mode::Sleeping | Mode::Retired, None) => true,
                _ => false,
            }
    }
}

/// What the agent asks of the sessions of one database.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    /// The database is quiescing: unauthenticated sessions close, the others hold their bytes.
    Begin,
    /// Idle sessions close with WebSocket code 1000, "database sleeping", when none is busy.
    Close,
    /// Only the counts.
    Status,
}

/// From the agent to the gateway.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ToGateway {
    /// The whole table; a database it does not name has no writer on this node.
    Table { databases: Vec<Database> },
    /// One database's new entry.
    Database { database: Database },
    /// A database without any entry any more.
    Removed { database: String },
    /// The result of a wake the gateway queued: a label, or the refusal of its connections.
    WakeResult { result: WakeResult },
    /// A request the gateway answers with `FromGateway::Status`.
    Control {
        id: u64,
        action: ControlAction,
        database: String,
        generation: u64,
    },
    /// A request the gateway answers with `FromGateway::Activity`.
    Activity { id: u64, database: String },
}
impl ToGateway {
    pub fn valid(&self) -> bool {
        match self {
            Self::Table { databases } => {
                databases.len() <= MAX_DATABASES && databases.iter().all(Database::valid) && {
                    let mut names: Vec<&str> =
                        databases.iter().map(|d| d.database.as_str()).collect();
                    names.sort_unstable();
                    names.windows(2).all(|pair| pair[0] != pair[1])
                }
            }
            Self::Database { database } => database.valid(),
            Self::Removed { database } => valid_pattern("database", database),
            Self::WakeResult { result } => result.valid(),
            Self::Control {
                id,
                database,
                generation,
                ..
            } => {
                *id <= MAX_SAFE
                    && valid_pattern("database", database)
                    && (1..=MAX_SAFE).contains(generation)
            }
            Self::Activity { id, database } => {
                *id <= MAX_SAFE && valid_pattern("database", database)
            }
        }
    }
}

/// Where the sessions of a database stand.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// The request names another generation, or a mode it does not apply to.
    Mismatch,
    Running,
    Retired,
    /// No session is left.
    Closed,
    Idle,
    Busy,
}

/// From the gateway to the agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum FromGateway {
    /// A held connection's wake, delivered again after `wake::REDELIVER_MS` without a result.
    Wake { wake: WakeRequest },
    Status {
        id: u64,
        database: String,
        status: SessionStatus,
        connections: usize,
        busy_connections: usize,
        pending_dials: usize,
    },
    /// The gateway's measurements of the database, as its activity report shows them.
    Activity {
        id: u64,
        database: String,
        report: serde_json::Value,
    },
}

/// One message as a line.
pub fn encode<T: Serialize>(message: &T) -> Vec<u8> {
    let mut line = serde_json::to_vec(message).expect("protocol messages serialize");
    line.push(b'\n');
    line
}
/// One line, without its newline, as an agent message, or why it is none.
pub fn decode_to_gateway(line: &[u8]) -> Result<ToGateway, &'static str> {
    if line.len() > MAX_LINE_BYTES {
        return Err("agent message too large");
    }
    let message: ToGateway = serde_json::from_slice(line).map_err(|_| "invalid agent message")?;
    if !message.valid() {
        return Err("invalid agent message");
    }
    Ok(message)
}
/// One line, without its newline, as a gateway message.
pub fn decode_from_gateway(line: &[u8]) -> Result<FromGateway, &'static str> {
    if line.len() > MAX_LINE_BYTES {
        return Err("gateway message too large");
    }
    let message: FromGateway =
        serde_json::from_slice(line).map_err(|_| "invalid gateway message")?;
    let valid = match &message {
        FromGateway::Wake { wake } => wake.valid(),
        FromGateway::Status { database, .. } | FromGateway::Activity { database, .. } => {
            valid_pattern("database", database)
        }
    };
    if !valid {
        return Err("invalid gateway message");
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wake::Outcome;
    fn writer() -> Writer {
        Writer {
            socket: format!("/run/pgcf/{}/.s.PGSQL.5432", "a".repeat(20)),
            uid: 61_001,
            pid: 4242,
            instance: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c".into(),
        }
    }
    fn database(mode: Mode, writer: Option<Writer>) -> Database {
        Database {
            database: "a".repeat(20),
            generation: 3,
            operation: format!("op_{}", "b".repeat(20)),
            mode,
            route_revision: 7,
            writer,
        }
    }
    #[test]
    fn a_writer_is_named_exactly_when_postgresql_runs() {
        assert!(database(Mode::Running, Some(writer())).valid());
        assert!(database(Mode::Quiesce, Some(writer())).valid());
        assert!(database(Mode::Sleeping, None).valid());
        assert!(database(Mode::Retired, None).valid());
        assert!(!database(Mode::Running, None).valid());
        assert!(!database(Mode::Sleeping, Some(writer())).valid());
        for broken in [
            Writer {
                socket: "relative/.s.PGSQL.5432".into(),
                ..writer()
            },
            Writer {
                socket: format!("/{}", "a".repeat(MAX_SOCKET_PATH_BYTES)),
                ..writer()
            },
            Writer {
                socket: "/run/pgcf/../etc/.s.PGSQL.5432".into(),
                ..writer()
            },
            Writer { uid: 0, ..writer() },
            Writer { pid: 1, ..writer() },
            Writer {
                instance: "0f6c2d8e5b7a4c1e9a3b2d4e6f8a0b1c".into(),
                ..writer()
            },
        ] {
            assert!(!database(Mode::Running, Some(broken)).valid());
        }
    }
    #[test]
    fn messages_are_lines_of_json_and_refused_when_invalid() {
        let table = ToGateway::Table {
            databases: vec![database(Mode::Running, Some(writer()))],
        };
        let line = encode(&table);
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(
            decode_to_gateway(&line[..line.len() - 1]).unwrap(),
            table.clone()
        );
        let text = String::from_utf8(line).unwrap();
        assert!(text.starts_with(r#"{"type":"table","databases":[{"database":"#));
        // One table names each database once.
        let twice = ToGateway::Table {
            databases: vec![
                database(Mode::Running, Some(writer())),
                database(Mode::Sleeping, None),
            ],
        };
        assert!(decode_to_gateway(&encode(&twice)[..]).is_err());
        assert!(decode_to_gateway(br#"{"type":"removed","database":"A"}"#).is_err());
        assert!(
            decode_to_gateway(br#"{"type":"removed","database":"aaaaaaaaaaaaaaaaaaaa","x":1}"#)
                .is_err()
        );
        let result = ToGateway::WakeResult {
            result: WakeResult {
                database: "a".repeat(20),
                operation: format!("op_{}", "b".repeat(20)),
                generation: 4,
                outcome: Outcome::Refused,
                reason: Some("no_headroom".into()),
                steps_ms: Default::default(),
            },
        };
        let line = encode(&result);
        assert_eq!(decode_to_gateway(&line[..line.len() - 1]).unwrap(), result);
        let status = FromGateway::Status {
            id: 9,
            database: "a".repeat(20),
            status: SessionStatus::Idle,
            connections: 2,
            busy_connections: 0,
            pending_dials: 0,
        };
        let line = encode(&status);
        assert_eq!(
            decode_from_gateway(&line[..line.len() - 1]).unwrap(),
            status
        );
    }
}
