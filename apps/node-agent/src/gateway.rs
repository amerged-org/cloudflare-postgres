// SPDX-License-Identifier: Apache-2.0
//! The agent's side of the gateway channel (plan 5.7, 5.9; `pgcf_native_protocol::agent`): one Unix
//! stream socket that the agent serves and the gateway connects to, one JSON line per message.
//!
//! The agent sends the whole writer table first and then every change of it, the results of the
//! wakes the gateway queued, and its quiesce, close, status and activity requests. A connection
//! that ends, or a line that is not valid, ends the channel; the gateway then admits nothing new
//! until it connects again and receives the table, and the sessions it has keep their writer.
//! There is one gateway, and one connection at a time: the gateway that restarts connects again
//! once its old connection has closed.
use crate::Error;
use pgcf_native_protocol::{
    agent::{
        ActivityReport, ControlAction, Database, FromGateway, MAX_LINE_BYTES, SessionStatus,
        ToGateway, decode_from_gateway, encode, timestamp_ms,
    },
    wake::{WakeRequest, WakeResult},
};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
    sync::{
        Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{broadcast, mpsc, oneshot},
    time::timeout,
};

/// How long the gateway may take to answer a request of the agent.
const ANSWER: Duration = Duration::from_secs(5);
/// Messages a slow gateway may fall behind by before it is given the whole table again.
const BACKLOG: usize = 1024;

/// What the gateway says of the sessions of a database, for a `Control` request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sessions {
    pub status: SessionStatus,
    pub connections: usize,
    pub busy_connections: usize,
    pub pending_dials: usize,
}

/// What an `Activity` request of the agent is answered with: the gateway's report of the database.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activity {
    /// When a client last used the database (Unix milliseconds); `None` when none did since the
    /// gateway counted.
    pub last_activity_ms: Option<i64>,
    pub connections: u64,
    pub busy_connections: u64,
    pub pending_dials: u64,
    pub ingress_bytes: Option<u64>,
    pub egress_bytes: Option<u64>,
    pub total_connections: Option<u64>,
    pub connection_milliseconds: Option<u64>,
    /// The counters' run: a different value means the gateway restarted and counted anew.
    pub epoch: String,
    pub counters_since: Option<String>,
    pub history: String,
}
impl Activity {
    /// From the `report` of `FromGateway::Activity`.
    pub fn of(report: &ActivityReport) -> Option<Self> {
        let last = match report.last_activity_at.as_deref() {
            None => None,
            Some(text) => Some(timestamp_ms(text)?),
        };
        Some(Self {
            last_activity_ms: last,
            connections: report.connections,
            busy_connections: report.busy_connections,
            pending_dials: report.pending_dials,
            ingress_bytes: report.ingress_bytes,
            egress_bytes: report.egress_bytes,
            total_connections: report.total_connections,
            connection_milliseconds: report.connection_milliseconds,
            epoch: format!("{}/{}", report.process_epoch, report.epoch),
            counters_since: report.counters_since.clone(),
            history: serde_json::to_value(report.history)
                .ok()?
                .as_str()?
                .to_string(),
        })
    }
}

/// The table of writers and the channel that carries it.
pub struct Feed {
    table: Mutex<BTreeMap<String, Database>>,
    out: broadcast::Sender<ToGateway>,
    next_request: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<FromGateway>>>,
}

impl Default for Feed {
    fn default() -> Self {
        Self::new()
    }
}

impl Feed {
    pub fn new() -> Self {
        Self {
            table: Mutex::new(BTreeMap::new()),
            out: broadcast::channel(BACKLOG).0,
            next_request: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        }
    }
    fn table(&self) -> MutexGuard<'_, BTreeMap<String, Database>> {
        self.table.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Whether a gateway is connected.
    pub fn connected(&self) -> bool {
        self.out.receiver_count() > 0
    }
    /// One database's entry, as the gateway has it or will get it.
    pub fn get(&self, database: &str) -> Option<Database> {
        self.table().get(database).cloned()
    }
    /// Sets a database's entry and sends it to the gateway. An entry the protocol would refuse is
    /// an error and changes nothing: the gateway would end the channel over it.
    pub fn set(&self, entry: Database) -> Result<(), Error> {
        if !entry.valid() {
            return Err("gateway table entry invalid".into());
        }
        let mut table = self.table();
        if table.get(&entry.database) == Some(&entry) {
            return Ok(());
        }
        table.insert(entry.database.clone(), entry.clone());
        // Sent under the lock, so that the order of the changes is the order of the table.
        let _ = self.out.send(ToGateway::Database { database: entry });
        Ok(())
    }
    /// Takes a database off the table: the gateway has no writer for it any more.
    pub fn remove(&self, database: &str) {
        let mut table = self.table();
        if table.remove(database).is_some() {
            let _ = self.out.send(ToGateway::Removed {
                database: database.to_string(),
            });
        }
    }
    /// Tells the gateway how a wake it queued ended.
    pub fn wake_result(&self, result: WakeResult) {
        let _ = self.out.send(ToGateway::WakeResult { result });
    }

    /// Asks the gateway something and waits for the answer with the id the request carries.
    async fn ask(&self, request: impl FnOnce(u64) -> ToGateway) -> Option<FromGateway> {
        if !self.connected() {
            return None;
        }
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (reply, answer) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, reply);
        let sent = self.out.send(request(id)).is_ok();
        let answer = if sent {
            timeout(ANSWER, answer).await.ok().and_then(Result::ok)
        } else {
            None
        };
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        answer
    }
    /// A quiesce, close or status request for the sessions of `database` at `generation`.
    /// `None` when no gateway answers.
    pub async fn control(
        &self,
        database: &str,
        generation: u64,
        action: ControlAction,
    ) -> Option<Sessions> {
        let request = |id| ToGateway::Control {
            id,
            action,
            database: database.to_string(),
            generation,
        };
        match self.ask(request).await? {
            FromGateway::Status {
                status,
                connections,
                busy_connections,
                pending_dials,
                ..
            } => Some(Sessions {
                status,
                connections,
                busy_connections,
                pending_dials,
            }),
            FromGateway::Wake { .. } | FromGateway::Activity { .. } => None,
        }
    }
    /// The gateway's measurements of `database`. `None` when no gateway answers.
    pub async fn activity(&self, database: &str) -> Option<Activity> {
        let request = |id| ToGateway::Activity {
            id,
            database: database.to_string(),
        };
        match self.ask(request).await? {
            FromGateway::Activity { report, .. } => Activity::of(&report),
            FromGateway::Wake { .. } | FromGateway::Status { .. } => None,
        }
    }

    fn answered(&self, id: u64, message: FromGateway) {
        let reply = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
        if let Some(reply) = reply {
            let _ = reply.send(message);
        }
    }

    /// Serves the channel for ever: every wake the gateway queues goes to `wakes`. Only a
    /// connection of `allowed_uid` is served, when one is given.
    pub async fn serve(
        &self,
        listener: UnixListener,
        wakes: mpsc::UnboundedSender<WakeRequest>,
        allowed_uid: Option<u32>,
    ) -> std::convert::Infallible {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let allowed = match (allowed_uid, stream.peer_cred()) {
                        (None, _) => true,
                        (Some(uid), Ok(peer)) => peer.uid() == uid,
                        (Some(_), Err(_)) => false,
                    };
                    if allowed {
                        self.connection(stream, &wakes).await;
                    }
                }
                // A full descriptor table or an aborted connection passes.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }

    /// One connection, until it ends. A new connection is accepted only after this one ended, so
    /// that the gateway that restarts while its old socket lingers waits for the old one to close.
    async fn connection(&self, stream: UnixStream, wakes: &mpsc::UnboundedSender<WakeRequest>) {
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read);
        // The table and the receiver are taken together, under the lock that orders the changes.
        let (snapshot, mut changes) = {
            let table = self.table();
            (
                table.values().cloned().collect::<Vec<_>>(),
                self.out.subscribe(),
            )
        };
        let first = ToGateway::Table {
            databases: snapshot,
        };
        if write.write_all(&encode(&first)).await.is_err() {
            return;
        }
        let mut line = Vec::new();
        loop {
            tokio::select! {
                read = read_line(&mut lines, &mut line) => {
                    let Some(()) = read else { return };
                    let Ok(message) = decode_from_gateway(&line) else { return };
                    match message {
                        FromGateway::Wake { wake } => {
                            if wakes.send(wake).is_err() {
                                return;
                            }
                        }
                        FromGateway::Status { id, .. } | FromGateway::Activity { id, .. } => {
                            self.answered(id, message);
                        }
                    }
                }
                change = changes.recv() => match change {
                    Ok(message) => {
                        if write.write_all(&encode(&message)).await.is_err() {
                            return;
                        }
                    }
                    // The gateway fell behind: it is given the whole table again.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let table = ToGateway::Table { databases: self.table().values().cloned().collect() };
                        if write.write_all(&encode(&table)).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
            }
        }
    }
}

/// One line of at most `MAX_LINE_BYTES`, without its newline; `None` when the stream ended or the
/// line is longer.
async fn read_line<R: AsyncBufReadExt + Unpin>(reader: &mut R, line: &mut Vec<u8>) -> Option<()> {
    line.clear();
    loop {
        let available = reader.fill_buf().await.ok()?;
        if available.is_empty() {
            return None;
        }
        match available.iter().position(|b| *b == b'\n') {
            Some(end) => {
                line.extend_from_slice(&available[..end]);
                reader.consume(end + 1);
                return Some(());
            }
            None => {
                let length = available.len();
                line.extend_from_slice(available);
                reader.consume(length);
            }
        }
        if line.len() > MAX_LINE_BYTES {
            return None;
        }
    }
}

/// Binds the channel's socket, replacing the socket of an agent that is gone, with the mode and
/// owner given: only the gateway's user may connect.
pub fn bind(path: &Path, mode: u32, owner: Option<(u32, u32)>) -> std::io::Result<UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)?,
        Ok(_) => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "the gateway socket path holds a file that is no socket",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(path)?;
    if let Some((uid, gid)) = owner {
        std::os::unix::fs::chown(path, Some(uid), Some(gid))?;
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpg;
    use pgcf_native_protocol::agent::{Mode, Writer, decode_to_gateway};
    use pgcf_native_protocol::wake::Outcome;
    use serde_json::Value;
    use std::sync::Arc;
    use tokio::io::AsyncReadExt;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-local.generated.json"
        ))
        .unwrap()
    }

    /// The contract's lines hold for the protocol crate the agent speaks: every valid line of the
    /// agent's side decodes, every invalid one is refused, and the same for the gateway's side,
    /// the activity report included.
    #[test]
    fn the_contracts_vectors_hold_for_the_protocol_the_agent_speaks() {
        let vectors = vectors();
        let channel = &vectors["gateway_channel"];
        let mut wrong = Vec::new();
        for vector in channel["agent"].as_array().unwrap() {
            let line = vector["line"].as_str().unwrap().as_bytes();
            if decode_to_gateway(line).is_ok() != (vector["valid"] == true) {
                wrong.push(format!("agent {}", vector["name"]));
            }
        }
        for vector in channel["gateway"].as_array().unwrap() {
            let line = vector["line"].as_str().unwrap().as_bytes();
            if decode_from_gateway(line).is_ok() != (vector["valid"] == true) {
                wrong.push(format!("gateway {}", vector["name"]));
            }
        }
        assert_eq!(wrong, Vec::<String>::new());
    }

    fn entry(database: &str, mode: Mode, generation: u64) -> Database {
        Database {
            database: database.into(),
            generation,
            operation: format!("op_{}", "c".repeat(20)),
            mode,
            route_revision: 2,
            writer: matches!(mode, Mode::Running | Mode::Quiesce).then(|| Writer {
                socket: format!("/run/pgcf/{database}/.s.PGSQL.5432"),
                uid: 61_001,
                pid: 4242,
                instance: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c".into(),
            }),
        }
    }
    const A: &str = "aaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbb";

    /// A gateway that connects, and what it receives.
    struct Gateway {
        reader: BufReader<tokio::net::unix::OwnedReadHalf>,
        writer: tokio::net::unix::OwnedWriteHalf,
    }
    impl Gateway {
        async fn connect(socket: &Path) -> Self {
            let stream = UnixStream::connect(socket).await.unwrap();
            let (read, writer) = stream.into_split();
            Self {
                reader: BufReader::new(read),
                writer,
            }
        }
        async fn next(&mut self) -> ToGateway {
            let mut line = String::new();
            timeout(Duration::from_secs(5), self.reader.read_line(&mut line))
                .await
                .expect("the agent sent nothing")
                .unwrap();
            decode_to_gateway(line.trim_end().as_bytes()).unwrap()
        }
        async fn send(&mut self, line: &str) {
            self.writer
                .write_all(format!("{line}\n").as_bytes())
                .await
                .unwrap();
        }
    }
    struct Rig {
        feed: Arc<Feed>,
        socket: std::path::PathBuf,
        wakes: mpsc::UnboundedReceiver<WakeRequest>,
        _directory: std::path::PathBuf,
    }
    fn rig(allowed_uid: Option<u32>) -> Rig {
        let directory = testpg::directory("gateway");
        let socket = directory.join("g.sock");
        let listener = bind(&socket, 0o600, None).unwrap();
        let feed = Arc::new(Feed::new());
        let (sender, wakes) = mpsc::unbounded_channel();
        let serving = feed.clone();
        tokio::spawn(async move { serving.serve(listener, sender, allowed_uid).await });
        Rig {
            feed,
            socket,
            wakes,
            _directory: directory,
        }
    }

    #[tokio::test]
    async fn the_gateway_gets_the_table_then_every_change_in_order_and_the_whole_table_again() {
        let rig = rig(None);
        rig.feed.set(entry(A, Mode::Sleeping, 3)).unwrap();
        let mut gateway = Gateway::connect(&rig.socket).await;
        assert_eq!(
            gateway.next().await,
            ToGateway::Table {
                databases: vec![entry(A, Mode::Sleeping, 3)]
            }
        );
        assert!(rig.feed.connected());
        rig.feed.set(entry(B, Mode::Running, 1)).unwrap();
        rig.feed.set(entry(A, Mode::Running, 4)).unwrap();
        rig.feed.remove(B);
        for expected in [
            ToGateway::Database {
                database: entry(B, Mode::Running, 1),
            },
            ToGateway::Database {
                database: entry(A, Mode::Running, 4),
            },
            ToGateway::Removed { database: B.into() },
        ] {
            assert_eq!(gateway.next().await, expected);
        }
        // An entry that did not change is not sent again.
        rig.feed.set(entry(A, Mode::Running, 4)).unwrap();
        rig.feed.set(entry(A, Mode::Quiesce, 4)).unwrap();
        assert_eq!(
            gateway.next().await,
            ToGateway::Database {
                database: entry(A, Mode::Quiesce, 4)
            }
        );
        // A gateway that comes back has the table as it is.
        drop(gateway);
        let mut again = Gateway::connect(&rig.socket).await;
        assert_eq!(
            again.next().await,
            ToGateway::Table {
                databases: vec![entry(A, Mode::Quiesce, 4)]
            }
        );
        // An entry the protocol refuses is not put on the table.
        let mut broken = entry(A, Mode::Running, 5);
        broken.writer.as_mut().unwrap().uid = 0;
        assert!(rig.feed.set(broken).is_err());
        assert_eq!(rig.feed.get(A), Some(entry(A, Mode::Quiesce, 4)));
    }

    #[tokio::test]
    async fn the_wakes_of_the_gateway_come_in_and_their_results_go_back() {
        let mut rig = rig(None);
        let mut gateway = Gateway::connect(&rig.socket).await;
        gateway.next().await;
        let wake = WakeRequest {
            database: A.into(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: 5,
            route_revision: 2,
            role_revision_hash: "a".repeat(64),
            queued_at_ms: 1_700_000_000_000,
        };
        gateway
            .send(&serde_json::to_string(&FromGateway::Wake { wake: wake.clone() }).unwrap())
            .await;
        assert_eq!(rig.wakes.recv().await.unwrap(), wake);
        let result = WakeResult {
            database: A.into(),
            operation: wake.operation,
            generation: 5,
            outcome: Outcome::Refused,
            reason: Some("no_headroom".into()),
            retry_after_seconds: Some(5),
            steps_ms: [("admission".to_string(), 12)].into(),
        };
        rig.feed.wake_result(result.clone());
        assert_eq!(gateway.next().await, ToGateway::WakeResult { result });
    }

    #[tokio::test]
    async fn requests_are_answered_by_their_number_and_end_when_nobody_answers() {
        let rig = rig(None);
        // Nobody listens: no answer at once.
        assert_eq!(rig.feed.control(A, 3, ControlAction::Status).await, None);
        let mut gateway = Gateway::connect(&rig.socket).await;
        gateway.next().await;
        let feed = rig.feed.clone();
        let asked = tokio::spawn(async move { feed.control(A, 3, ControlAction::Begin).await });
        let ToGateway::Control {
            id,
            action,
            database,
            generation,
        } = gateway.next().await
        else {
            panic!("a control request");
        };
        assert_eq!(
            (action, database.as_str(), generation),
            (ControlAction::Begin, A, 3)
        );
        // An answer to another number is nobody's.
        gateway
            .send(&format!(
                r#"{{"type":"status","id":{},"database":"{A}","status":"idle","connections":9,"busy_connections":0,"pending_dials":0}}"#,
                id + 100
            ))
            .await;
        gateway
            .send(&format!(
                r#"{{"type":"status","id":{id},"database":"{A}","status":"busy","connections":2,"busy_connections":1,"pending_dials":0}}"#
            ))
            .await;
        assert_eq!(
            asked.await.unwrap(),
            Some(Sessions {
                status: SessionStatus::Busy,
                connections: 2,
                busy_connections: 1,
                pending_dials: 0
            })
        );
        // The activity of a database is read field by field from the gateway's report.
        let feed = rig.feed.clone();
        let asked = tokio::spawn(async move { feed.activity(A).await });
        let ToGateway::Activity { id, database } = gateway.next().await else {
            panic!("an activity request");
        };
        assert_eq!(database, A);
        // The contract's own example of a report, answered under our number.
        let example: Value = serde_json::from_str(
            vectors()["gateway_channel"]["gateway"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == "activity")
                .unwrap()["line"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let line = example;
        gateway
            .send(
                &serde_json::json!({
                    "type": "activity", "id": id, "database": A, "report": line["report"]
                })
                .to_string(),
            )
            .await;
        let activity = asked.await.unwrap().unwrap();
        assert_eq!(activity.connections, line["report"]["connections"]);
        assert!(activity.last_activity_ms.is_some());
        // A gateway that never answers ends the wait.
        let silent = tokio::time::timeout(
            ANSWER + Duration::from_secs(1),
            rig.feed.control(A, 3, ControlAction::Status),
        )
        .await
        .unwrap();
        assert_eq!(silent, None);
    }

    #[tokio::test]
    async fn a_line_the_protocol_refuses_ends_the_channel() {
        let rig = rig(None);
        let mut gateway = Gateway::connect(&rig.socket).await;
        gateway.next().await;
        assert!(rig.feed.connected());
        gateway
            .send(r#"{"type":"wake","wake":{"database":"x"}}"#)
            .await;
        let mut rest = String::new();
        timeout(
            Duration::from_secs(5),
            gateway.reader.read_to_string(&mut rest),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(rest, "");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!rig.feed.connected());
        // A gateway may connect again.
        let mut again = Gateway::connect(&rig.socket).await;
        assert!(matches!(again.next().await, ToGateway::Table { .. }));
    }

    #[tokio::test]
    async fn only_the_gateways_user_is_served() {
        let me = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(std::env::temp_dir()).unwrap().uid()
        };
        // Another uid than the caller's: the connection is closed without the table.
        let rig_other = rig(Some(me.wrapping_add(1)));
        let mut stranger = Gateway::connect(&rig_other.socket).await;
        let mut rest = String::new();
        timeout(
            Duration::from_secs(5),
            stranger.reader.read_to_string(&mut rest),
        )
        .await
        .unwrap()
        .unwrap_or_default();
        assert_eq!(rest, "");
        assert!(!rig_other.feed.connected());
    }
}
