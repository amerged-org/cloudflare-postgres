// SPDX-License-Identifier: Apache-2.0
//! The node agent's local channel to the gateway (plan 5.7): one Unix stream socket that the agent
//! serves and the gateway connects to. Each message is one line of JSON.
//!
//! The agent sends the whole writer table first and then every change of it, the results of the
//! wakes the gateway queued, and its quiesce, close, status and activity requests. The gateway
//! sends the wakes of held connections (route v5), its answers and the stage marks of the
//! connections that were held. A connection that ends, or a message that is not valid, ends the
//! channel; the gateway then admits nothing new until the agent's next table, and the established
//! sessions keep their writer.
//!
//! A database's writer is its PostgreSQL unit: the Unix socket it listens on, the database's own
//! uid and the unit's main PID, which the gateway compares with the kernel's peer credentials of
//! every connection it dials, and the unit's invocation ID, which the route names.
use crate::{
    valid_pattern,
    wake::{REASONS, WakeRequest, WakeResult},
};
use serde::{Deserialize, Deserializer, Serialize};

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
    /// The result of a wake the gateway queued: started, or the refusal of its connections.
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

/// How much of its counters' history the gateway can vouch for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum History {
    /// Counted from the start of the counter run.
    Complete,
    /// Counted from `counters_since` only.
    Partial,
    /// This process has seen no activity of the database since it counted: all zero.
    CurrentProcessAbsence,
    /// The gateway cannot say; it has no counters.
    Unavailable,
}

/// A field that must be present, and may be `null`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(deserializer)
}

/// A field that may be absent and is never `null`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// The counters and session counts of one database as the gateway reports them
/// (`GatewayLocalActivityReport` of the contract): cumulative since `countersSince` within one
/// counter run, which `processEpoch` and `epoch` name. A counter the gateway cannot know is null,
/// never zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityReport {
    pub process_epoch: String,
    pub epoch: String,
    pub started_at: String,
    pub counter_started_at: String,
    pub observed_at: String,
    pub history: History,
    #[serde(deserialize_with = "nullable")]
    pub counters_since: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub ingress_bytes: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub egress_bytes: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub total_connections: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub connection_milliseconds: Option<u64>,
    pub connections: u64,
    pub authenticated_connections: u64,
    pub busy_connections: u64,
    pub pending_dials: u64,
    #[serde(deserialize_with = "nullable")]
    pub last_activity_at: Option<String>,
}
/// A contract timestamp (`Date#toISOString`: `2026-10-17T12:00:00.000Z`) as Unix milliseconds.
pub fn timestamp_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() != 24 || bytes[10] != b'T' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return None;
    }
    let at =
        time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).ok()
}
impl ActivityReport {
    /// The rules that no JSON Schema states (`refineGatewayActivity` of the contract).
    pub fn valid(&self) -> bool {
        let count = |value: u64| value <= MAX_SAFE;
        let optional = |value: Option<u64>| value.is_none_or(count);
        let (Some(started), Some(counter), Some(observed)) = (
            timestamp_ms(&self.started_at),
            timestamp_ms(&self.counter_started_at),
            timestamp_ms(&self.observed_at),
        ) else {
            return false;
        };
        let since = self.counters_since.as_deref().map(timestamp_ms);
        let activity = self.last_activity_at.as_deref().map(timestamp_ms);
        let metrics = [
            self.ingress_bytes,
            self.egress_bytes,
            self.total_connections,
            self.connection_milliseconds,
        ];
        let within = |at: Option<Option<i64>>| match at {
            None => true,
            Some(None) => false,
            Some(Some(at)) => (counter..=observed).contains(&at),
        };
        valid_pattern("uuid", &self.process_epoch)
            && valid_pattern("uuid", &self.epoch)
            && counter >= started
            && observed >= counter
            && within(since)
            && within(activity)
            && metrics.into_iter().all(optional)
            && [
                self.connections,
                self.authenticated_connections,
                self.busy_connections,
                self.pending_dials,
            ]
            .into_iter()
            .all(count)
            && self.authenticated_connections <= self.connections
            && self.busy_connections <= self.authenticated_connections
            && self.pending_dials <= self.connections
            // Unknown history is distinct from measured counters.
            && if self.history == History::Unavailable {
                self.counters_since.is_none() && metrics.iter().all(Option::is_none)
            } else {
                self.counters_since.is_some() && metrics.iter().all(Option::is_some)
            }
            // Complete history begins at the actual counter initialization.
            && (!matches!(
                self.history,
                History::Complete | History::CurrentProcessAbsence
            ) || self.counters_since.as_deref() == Some(self.counter_started_at.as_str()))
            // A process that saw nothing cannot conceal activity.
            && (self.history != History::CurrentProcessAbsence
                || (self.last_activity_at.is_none()
                    && metrics.iter().all(|value| *value == Some(0))
                    && self.authenticated_connections == 0
                    && self.busy_connections == 0))
    }
}

/// The stage marks of one connection that waited for its database's wake (`conn_stages` of the
/// gateway's log), in milliseconds. A mark the connection did not reach is absent. It holds
/// numbers and fixed tokens only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnStages {
    pub database: String,
    /// How the connection ended: a fixed class of the gateway's log.
    pub outcome: String,
    /// How the wait for the wake ended: `released`, `refused`, `client_closed` and the like.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub held_outcome: Option<String>,
    /// The reason of the agent's refusal, when it refused the wake.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub wake_reason: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub upgrade_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub startup_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub dial_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub first_backend_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub wake_wait_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub session_ms: Option<u64>,
}
/// `^[a-z0-9_]{1,48}$`.
fn stage_token(text: &str) -> bool {
    (1..=48).contains(&text.len())
        && text
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}
impl ConnStages {
    pub fn valid(&self) -> bool {
        valid_pattern("database", &self.database)
            && stage_token(&self.outcome)
            && self.held_outcome.as_deref().is_none_or(stage_token)
            && self
                .wake_reason
                .as_deref()
                .is_none_or(|reason| REASONS.contains(&reason))
            && [
                self.upgrade_ms,
                self.startup_ms,
                self.dial_ms,
                self.first_backend_ms,
                self.wake_wait_ms,
                self.session_ms,
            ]
            .into_iter()
            .all(|mark| mark.is_none_or(|ms| ms <= MAX_SAFE))
    }
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
        report: Box<ActivityReport>,
    },
    /// The stage marks of a connection that was held for a wake, sent when it ends. No answer.
    ConnStages(ConnStages),
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
        FromGateway::Status { id, database, .. } => {
            *id <= MAX_SAFE && valid_pattern("database", database)
        }
        FromGateway::Activity {
            id,
            database,
            report,
        } => *id <= MAX_SAFE && valid_pattern("database", database) && report.valid(),
        FromGateway::ConnStages(stages) => stages.valid(),
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
                retry_after_seconds: Some(5),
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
