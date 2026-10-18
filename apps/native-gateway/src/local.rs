// SPDX-License-Identifier: Apache-2.0
//! The gateway on a node beside the node agent (plan 5.7). Its writers are the agent's table,
//! which the agent sends over the local channel (`pgcf_native_protocol::agent`):
//! each database's PostgreSQL unit with its Unix socket, uid, main PID and invocation ID, the
//! generation and route revision the gateway admits routes of, and what the database's
//! PostgreSQL does (running, quiescing, sleeping or retired). A connection is dialled on the
//! database's socket and kept only when the kernel's peer credentials are the unit's uid and main
//! PID. The wakes of held connections go to the agent on the same channel, and the agent's
//! release is the table entry that shows the woken unit at the ticket's generation.
use crate::{sessions::Action, transport::Gateway};
use pgcf_native_protocol::{
    agent::{
        self, ActivityReport, ControlAction, Database, FromGateway, MAX_LINE_BYTES, Mode,
        SessionStatus, ToGateway, Writer,
    },
    wake::POLL_HOLD_MS,
};
use serde_json::json;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixStream, unix::OwnedReadHalf},
    sync::{Notify, RwLock, mpsc, watch},
    task::JoinSet,
    time::timeout,
};
type Failure = Box<dyn std::error::Error + Send + Sync>;

/// How long the gateway waits before it connects to the agent again.
const RECONNECT: Duration = Duration::from_millis(200);
/// How long one message to the agent may take to write.
const WRITE_BOUND: Duration = Duration::from_secs(10);
/// How long a quiesce or close waits for the sessions to reach the state it asks for.
const SETTLE_BOUND: Duration = Duration::from_secs(1);

/// The agent's table, as the gateway last received it.
#[derive(Default)]
pub struct LocalTable {
    /// The channel is up and its table arrived. Without it nothing new is admitted; established
    /// sessions keep their writer, which only the agent can stop.
    synchronized: bool,
    epoch: u64,
    records: HashMap<String, Database>,
    database_epochs: HashMap<String, u64>,
    next_database_epoch: u64,
    /// Signalled after every change of the table and every loss of the channel: a held wake
    /// connection waits on it for its release.
    pub changed: Arc<Notify>,
}
impl LocalTable {
    pub fn synchronized(&self) -> bool {
        self.synchronized
    }
    /// The table epoch and the database's own epoch: a session admitted at another epoch writes
    /// nothing before it is admitted again.
    pub fn bound_epoch(&self, database: &str) -> (u64, u64) {
        (
            self.epoch,
            self.database_epochs.get(database).copied().unwrap_or(0),
        )
    }
    pub fn record(&self, database: &str) -> Option<&Database> {
        self.records.get(database)
    }
    /// New work is admitted: the table is current and the database's PostgreSQL runs.
    pub fn admits(&self, database: &str) -> bool {
        self.synchronized
            && self
                .records
                .get(database)
                .is_some_and(|record| record.mode == Mode::Running && record.writer.is_some())
    }
    /// `writer` still serves the database.
    pub fn permits(&self, database: &str, writer: &Writer) -> bool {
        self.records
            .get(database)
            .is_some_and(|record| record.writer.as_ref() == Some(writer))
    }
    pub fn mode(&self, database: &str) -> Option<Mode> {
        self.records.get(database).map(|record| record.mode)
    }
    /// Replaces the whole table; the answer is what the sessions of each changed database are
    /// told.
    pub fn replace(&mut self, databases: Vec<Database>) -> Vec<(String, Action)> {
        let mut records: HashMap<String, Database> = databases
            .into_iter()
            .map(|record| (record.database.clone(), record))
            .collect();
        let mut actions: Vec<(String, Action)> = self
            .records
            .keys()
            .filter(|database| !records.contains_key(*database))
            .map(|database| (database.clone(), Action::Retire))
            .collect();
        for (database, record) in &records {
            if self.records.get(database) != Some(record) {
                self.next_database_epoch += 1;
                self.database_epochs
                    .insert(database.clone(), self.next_database_epoch);
                actions.push((database.clone(), action(record.mode)));
            }
        }
        self.database_epochs
            .retain(|database, _| records.contains_key(database));
        if !self.synchronized {
            self.epoch += 1;
        }
        std::mem::swap(&mut self.records, &mut records);
        self.synchronized = true;
        self.changed.notify_waiters();
        actions
    }
    /// One database's new entry.
    pub fn update(&mut self, record: Database) -> Option<(String, Action)> {
        if self.records.get(&record.database) == Some(&record) {
            return None;
        }
        self.next_database_epoch += 1;
        self.database_epochs
            .insert(record.database.clone(), self.next_database_epoch);
        let changed = (record.database.clone(), action(record.mode));
        self.records.insert(record.database.clone(), record);
        self.changed.notify_waiters();
        Some(changed)
    }
    pub fn remove(&mut self, database: &str) -> Option<(String, Action)> {
        self.records.remove(database)?;
        self.database_epochs.remove(database);
        self.changed.notify_waiters();
        Some((database.into(), Action::Retire))
    }
    /// The channel is gone: nothing new is admitted until the agent's next table.
    pub fn disconnect(&mut self) {
        if self.synchronized {
            self.synchronized = false;
            self.epoch += 1;
            self.changed.notify_waiters();
        }
    }
}
fn action(mode: Mode) -> Action {
    match mode {
        Mode::Running => Action::Running,
        Mode::Quiesce => Action::Quiesce,
        Mode::Sleeping | Mode::Retired => Action::Retire,
    }
}

/// Why a database's socket was not dialled into a session.
#[derive(Debug)]
pub enum DialFailure {
    Connect(std::io::Error),
    /// The process behind the socket is not the unit's: another uid or another PID.
    Peer,
}
impl DialFailure {
    /// The `conn_stages` outcome of the failure.
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::Connect(_) => "postgres_connect_error",
            Self::Peer => "peer_mismatch",
        }
    }
}
impl std::fmt::Display for DialFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(error) => write!(formatter, "database socket unavailable: {error}"),
            Self::Peer => formatter.write_str("database socket peer is not the unit"),
        }
    }
}
impl std::error::Error for DialFailure {}

/// Connects to the writer's socket and keeps the connection only when the kernel reports the
/// peer as the unit: the database's uid and the unit's main PID, the postmaster that listens.
pub async fn dial(writer: &Writer) -> Result<UnixStream, DialFailure> {
    let stream = UnixStream::connect(&writer.socket)
        .await
        .map_err(DialFailure::Connect)?;
    let peer = stream.peer_cred().map_err(DialFailure::Connect)?;
    if peer.uid() != writer.uid
        || peer.pid().and_then(|pid| u32::try_from(pid).ok()) != Some(writer.pid)
    {
        return Err(DialFailure::Peer);
    }
    Ok(stream)
}

/// Keeps the channel to the agent at `socket`: connects, applies the agent's table and its
/// changes, delivers the queued wakes and answers the agent's requests, and connects again after
/// a loss.
pub async fn synchronize(gateway: Arc<Gateway>, socket: PathBuf, mut stop: watch::Receiver<bool>) {
    let table = gateway.table.clone();
    loop {
        if *stop.borrow() {
            break;
        }
        if let Ok(stream) = UnixStream::connect(&socket).await {
            let _ = serve(&gateway, &table, stream, &mut stop).await;
        }
        table.write().await.disconnect();
        tokio::select! {
            _ = tokio::time::sleep(RECONNECT) => {},
            _ = stop.changed() => break,
        }
    }
    table.write().await.disconnect();
}

async fn serve(
    gateway: &Arc<Gateway>,
    table: &Arc<RwLock<LocalTable>>,
    stream: UnixStream,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), Failure> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let (outgoing, mut queue) = mpsc::channel::<Vec<u8>>(256);
    let mut tasks = JoinSet::new();
    tasks.spawn(async move {
        while let Some(line) = queue.recv().await {
            if !matches!(
                timeout(WRITE_BOUND, writer.write_all(&line)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    });
    {
        let (gateway, outgoing) = (gateway.clone(), outgoing.clone());
        tasks.spawn(async move {
            loop {
                let wakes = gateway
                    .wakes
                    .poll(Duration::from_millis(POLL_HOLD_MS))
                    .await;
                for wake in wakes {
                    if outgoing
                        .send(agent::encode(&FromGateway::Wake { wake }))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        });
    }
    let mut line = Vec::new();
    loop {
        tokio::select! {
            read = read_line(&mut reader, &mut line) => read?,
            // The writer ended: the channel is gone.
            _ = tasks.join_next() => return Err("agent channel write failed".into()),
            _ = stop.changed() => return Ok(()),
        }
        let message = agent::decode_to_gateway(&line)?;
        line.clear();
        if !table.read().await.synchronized() && !matches!(message, ToGateway::Table { .. }) {
            return Err("the agent's first message is its table".into());
        }
        apply(gateway, table, message, &outgoing).await;
    }
}

/// Reads the next line, without its newline, into the empty `line`. Cancel safe: what was read
/// stays in `line` for the next call.
async fn read_line(
    reader: &mut BufReader<OwnedReadHalf>,
    line: &mut Vec<u8>,
) -> Result<(), Failure> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Err("agent closed the channel".into());
        }
        let (taken, complete) = match available.iter().position(|byte| *byte == b'\n') {
            Some(end) => (end, true),
            None => (available.len(), false),
        };
        if line.len() + taken > MAX_LINE_BYTES {
            return Err("agent message too large".into());
        }
        line.extend_from_slice(&available[..taken]);
        reader.consume(taken + complete as usize);
        if complete {
            return Ok(());
        }
    }
}

async fn apply(
    gateway: &Arc<Gateway>,
    table: &Arc<RwLock<LocalTable>>,
    message: ToGateway,
    outgoing: &mpsc::Sender<Vec<u8>>,
) {
    let actions = match message {
        ToGateway::Table { databases } => table.write().await.replace(databases),
        ToGateway::Database { database } => {
            table.write().await.update(database).into_iter().collect()
        }
        ToGateway::Removed { database } => {
            table.write().await.remove(&database).into_iter().collect()
        }
        ToGateway::WakeResult { result } => {
            // A result for a ticket no connection holds any more labels nothing.
            gateway.wakes.result(&result);
            Vec::new()
        }
        ToGateway::Control {
            id,
            action,
            database,
            generation,
        } => {
            let (gateway, table, outgoing) = (gateway.clone(), table.clone(), outgoing.clone());
            // A quiesce or close waits for the sessions while the channel goes on.
            tokio::spawn(async move {
                let status = control(&gateway, &table, id, action, database, generation).await;
                let _ = outgoing.send(agent::encode(&status)).await;
            });
            Vec::new()
        }
        ToGateway::Activity { id, database } => {
            if let Some(report) = activity(gateway, &database) {
                let _ = outgoing
                    .send(agent::encode(&FromGateway::Activity {
                        id,
                        database,
                        report: Box::new(report),
                    }))
                    .await;
            }
            Vec::new()
        }
    };
    let sessions = gateway.sessions.lock().unwrap();
    for (database, action) in actions {
        sessions.signal(&database, action);
    }
}

/// The agent's quiesce, close or status request for the sessions of one database at its
/// generation.
async fn control(
    gateway: &Gateway,
    table: &RwLock<LocalTable>,
    id: u64,
    action: ControlAction,
    database: String,
    generation: u64,
) -> FromGateway {
    let answer = |status: SessionStatus, gateway: &Gateway, database: String| {
        let counts = gateway.sessions.lock().unwrap().counts(&database);
        FromGateway::Status {
            id,
            database,
            status,
            connections: counts.connections,
            busy_connections: counts.busy,
            pending_dials: counts.pending_dials,
        }
    };
    let applies = |record: Option<&Database>| {
        record
            .filter(|record| {
                record.generation == generation
                    && (action == ControlAction::Status || record.mode == Mode::Quiesce)
            })
            .map(|record| record.mode)
    };
    let Some(mode) = applies(table.read().await.record(&database)) else {
        return answer(SessionStatus::Mismatch, gateway, database);
    };
    match action {
        ControlAction::Begin => gateway
            .sessions
            .lock()
            .unwrap()
            .signal(&database, Action::Quiesce),
        ControlAction::Close => {
            let sessions = gateway.sessions.lock().unwrap();
            if sessions.counts(&database).busy == 0 {
                sessions.signal(&database, Action::CloseIdle);
            }
        }
        ControlAction::Status => {}
    }
    if action != ControlAction::Status {
        // Each session rechecks its own protocol and frame state before it closes; a busy or
        // uncertain session is never closed by force.
        let deadline = Instant::now() + SETTLE_BOUND;
        while Instant::now() < deadline {
            let counts = gateway.sessions.lock().unwrap().counts(&database);
            if (action == ControlAction::Begin && counts.connections == counts.authenticated)
                || (action == ControlAction::Close && (counts.connections == 0 || counts.busy > 0))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    if applies(table.read().await.record(&database)) != Some(mode) {
        return answer(SessionStatus::Mismatch, gateway, database);
    }
    let counts = gateway.sessions.lock().unwrap().counts(&database);
    let status = match mode {
        Mode::Retired => SessionStatus::Retired,
        Mode::Running => SessionStatus::Running,
        _ if action == ControlAction::Close && counts.connections == 0 => SessionStatus::Closed,
        _ if counts.busy == 0 => SessionStatus::Idle,
        _ => SessionStatus::Busy,
    };
    answer(status, gateway, database)
}

/// The gateway's measurements of a database, for the agent's idle decision. A report that breaks
/// the contract's rules is no answer: the agent then knows nothing of the database's use and
/// never sleeps it for idleness.
fn activity(gateway: &Gateway, database: &str) -> Option<ActivityReport> {
    let counts = gateway.sessions.lock().unwrap().counts(database);
    let mut report = gateway.measurements.lock().unwrap().read(database);
    let output = report.as_object_mut().expect("measurement object");
    for (key, value) in [
        ("connections", json!(counts.connections)),
        ("authenticatedConnections", json!(counts.authenticated)),
        ("busyConnections", json!(counts.authenticated_busy)),
        ("pendingDials", json!(counts.pending_dials)),
    ] {
        output.insert(key.into(), value);
    }
    serde_json::from_value::<ActivityReport>(report)
        .ok()
        .filter(ActivityReport::valid)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn writer(pid: u32) -> Writer {
        Writer {
            socket: "/run/pgcf/aaaaaaaaaaaaaaaaaaaa/.s.PGSQL.5432".into(),
            uid: 61_001,
            pid,
            instance: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c".into(),
        }
    }
    fn record(database: &str, mode: Mode, generation: u64, pid: u32) -> Database {
        Database {
            database: database.into(),
            generation,
            operation: format!("op_{}", "b".repeat(20)),
            mode,
            route_revision: 7,
            writer: matches!(mode, Mode::Running | Mode::Quiesce).then(|| writer(pid)),
        }
    }
    #[test]
    fn the_table_admits_running_units_and_moves_the_epochs_of_what_changed() {
        let (a, b) = ("a".repeat(20), "b".repeat(20));
        let mut table = LocalTable::default();
        assert!(!table.admits(&a));
        let actions = table.replace(vec![
            record(&a, Mode::Running, 3, 100),
            record(&b, Mode::Sleeping, 2, 0),
        ]);
        assert_eq!(actions.len(), 2);
        assert!(table.admits(&a) && !table.admits(&b));
        assert!(table.permits(&a, &writer(100)) && !table.permits(&a, &writer(101)));
        let (epoch_a, epoch_b) = (table.bound_epoch(&a), table.bound_epoch(&b));
        // The same table again changes nothing.
        assert!(
            table
                .replace(vec![
                    record(&a, Mode::Running, 3, 100),
                    record(&b, Mode::Sleeping, 2, 0),
                ])
                .is_empty()
        );
        assert_eq!(table.bound_epoch(&a), epoch_a);
        // A quiescing database admits nothing new; its sessions keep the writer.
        assert_eq!(
            table.update(record(&a, Mode::Quiesce, 3, 100)),
            Some((a.clone(), Action::Quiesce))
        );
        assert!(!table.admits(&a) && table.permits(&a, &writer(100)));
        assert_ne!(table.bound_epoch(&a), epoch_a);
        assert_eq!(table.bound_epoch(&b), epoch_b);
        // Losing the channel admits nothing new, keeps the writers and moves every epoch.
        table.update(record(&a, Mode::Running, 3, 100));
        table.disconnect();
        assert!(!table.admits(&a) && table.permits(&a, &writer(100)));
        assert_ne!(table.bound_epoch(&b), epoch_b);
        // A database the next table leaves out is retired.
        let actions = table.replace(vec![record(&a, Mode::Running, 3, 100)]);
        assert!(actions.contains(&(b.clone(), Action::Retire)));
        assert!(table.record(&b).is_none() && table.admits(&a));
        assert_eq!(table.remove(&a), Some((a.clone(), Action::Retire)));
        assert!(!table.permits(&a, &writer(100)));
    }
}
