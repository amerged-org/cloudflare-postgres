// SPDX-License-Identifier: Apache-2.0
use crate::{
    auth::{self, Login, Pipelined},
    budget::{BudgetedStream, Lease, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, MemoryBudget, WireBudget},
    hold::{Held, Verdict, WakeQueue},
    http::{self, HttpHead},
    local::{self, LocalTable},
    sessions::{Action, Sessions, SharedSessions},
    telemetry::GatewayMeasurements,
};
use futures_util::{SinkExt, StreamExt};
use pgcf_native_protocol::{
    activity::PostgresActivity,
    agent::{Mode, Writer},
    constant,
    route::{Keyring, ReplayCache, RouteClaims, valid_websocket_key, verify},
    startup::{Event, StartupReader, error_response},
    wake::{self, Outcome, WakeClaims},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixStream},
    sync::{Notify, OwnedSemaphorePermit, RwLock, watch},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_async_with_config,
    tungstenite::{
        Message,
        protocol::{CloseFrame, WebSocketConfig, frame::coding::CloseCode},
    },
};
use zeroize::Zeroizing;
type Failure = Box<dyn std::error::Error + Send + Sync>;
type WebSocket = WebSocketStream<BudgetedStream>;
pub const SESSION_MEMORY_BYTES: usize = 2 * MAX_FRAME_BYTES + 16 * 1024;
/// The time a connection has to send its StartupMessage and have its writer dialled.
pub const STARTUP_BOUND: Duration = Duration::from_secs(10);
/// How long a held wake connection waits for its release, counted from its upgrade.
pub const WAKE_BOUND: Duration = Duration::from_millis(wake::WAKE_BOUND_MS);
/// The time one write of frontend bytes to PostgreSQL may take.
pub(crate) const WRITE_BOUND: Duration = Duration::from_secs(10);
pub struct Config {
    pub region: String,
    pub keyring: Keyring,
    pub maximum_memory: usize,
    pub database_memory: usize,
}
pub(crate) struct Admission {
    pub(crate) replay: ReplayCache,
    counts: HashMap<String, usize>,
    total: usize,
}
impl Default for Admission {
    fn default() -> Self {
        Self {
            replay: ReplayCache::new(50_000),
            counts: HashMap::new(),
            total: 0,
        }
    }
}
pub(crate) type Epoch = (u64, u64);
/// Why bytes were not written to a session's writer.
pub(crate) enum Blocked {
    /// The table moved past the session's admission: nothing was written.
    Fenced,
    /// The session's writer is not the database's any more: nothing was written.
    TargetChanged,
    /// The write failed or timed out: its bytes may have reached PostgreSQL.
    Lost,
}
pub struct Gateway {
    pub config: Arc<Config>,
    /// The node agent's table of the databases' writers.
    pub table: Arc<RwLock<LocalTable>>,
    pub sessions: SharedSessions,
    pub measurements: Arc<Mutex<GatewayMeasurements>>,
    pub draining: AtomicBool,
    /// The held connections of sleeping databases and their wake tickets.
    pub wakes: Arc<WakeQueue>,
    /// The idle sessions of HTTP SQL.
    pub sql: crate::sql::Pool,
    pub(crate) admission: Mutex<Admission>,
    pub(crate) memory: Arc<MemoryBudget>,
}
impl Gateway {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            memory: MemoryBudget::new(config.maximum_memory, config.database_memory),
            config,
            table: Arc::default(),
            sessions: Arc::new(Mutex::new(Sessions::default())),
            measurements: Arc::new(Mutex::new(GatewayMeasurements::new())),
            draining: AtomicBool::new(false),
            wakes: WakeQueue::new(),
            sql: crate::sql::Pool::default(),
            admission: Mutex::new(Admission::default()),
        })
    }
    /// Reserves the session of an admitted route. `replay` is false only for a held wake
    /// connection, whose route was checked against the replay cache when it was held.
    pub(crate) fn reserve(
        self: &Arc<Self>,
        claims: &RouteClaims,
        wire: WireBudget,
        target: &Writer,
        replay: bool,
    ) -> Result<(SessionLease, watch::Receiver<Action>), u16> {
        let mut admission = self.admission.lock().unwrap();
        if admission.counts.get(&claims.db).copied().unwrap_or(0)
            >= constant("DEFAULT_DATABASE_CONNECTION_LIMIT") as usize
        {
            return Err(429);
        }
        if admission.total >= constant("DEFAULT_TOTAL_CONNECTION_LIMIT") as usize {
            return Err(503);
        }
        let id = format!("{}/{}", claims.db, claims.cid);
        if self.sessions.lock().unwrap().contains(&id) {
            return Err(403);
        }
        if replay {
            admission
                .replay
                .use_token(claims, http::now())
                .map_err(replay_status)?;
        }
        if !self.measurements.lock().unwrap().begin(&claims.db, &id) {
            return Err(503);
        }
        let actions =
            self.sessions
                .lock()
                .unwrap()
                .insert(id.clone(), claims.db.clone(), wire.clone());
        admission.total += 1;
        *admission.counts.entry(claims.db.clone()).or_default() += 1;
        Ok((
            SessionLease {
                gateway: self.clone(),
                database: claims.db.clone(),
                id,
                target: target.clone(),
                wire,
            },
            actions,
        ))
    }
    /// Whether the gateway admits new work: the agent's table is current and it is not draining.
    pub(crate) async fn ready(&self) -> bool {
        self.table.read().await.synchronized() && !self.draining.load(Ordering::Acquire)
    }
    /// The writer a route is admitted on and the epoch it is admitted at, or the `conn_stages`
    /// outcome it is refused with. `released` is the unit a held wake was released to.
    pub(crate) async fn admit(
        &self,
        claims: &RouteClaims,
        released: Option<&str>,
    ) -> Result<(Writer, Epoch), &'static str> {
        let table = self.table.read().await;
        let epoch = table.bound_epoch(&claims.db);
        if self.draining.load(Ordering::Acquire) || !table.synchronized() {
            return Err("fenced");
        }
        let Some(record) = table.record(&claims.db) else {
            return Err("target_unavailable");
        };
        let (Mode::Running, Some(unit)) = (record.mode, &record.writer) else {
            return Err("fenced");
        };
        // Only an admission route names the unit and the route revision it was admitted for.
        if claims.v != 4
            || claims.rev != Some(record.generation)
            || claims.route_revision != Some(record.route_revision)
            || claims.pod.as_deref() != Some(unit.instance.as_str())
            || released.is_some_and(|instance| instance != unit.instance)
        {
            return Err("route_stale");
        }
        Ok((unit.clone(), epoch))
    }
    /// What signals a change of the table, which a held wake waits on.
    pub(crate) async fn changed(&self) -> Arc<Notify> {
        self.table.read().await.changed.clone()
    }
    /// Whether `writer` is still the database's writer.
    pub(crate) async fn permits(&self, database: &str, writer: &Writer) -> bool {
        self.table.read().await.permits(database, writer)
    }
    /// Whether the database is still admitted at `epoch`.
    async fn admitted_at(&self, database: &str, epoch: Epoch) -> bool {
        let table = self.table.read().await;
        table.bound_epoch(database) == epoch && table.admits(database)
    }
    /// Writes `bytes` to a session's writer while the database is admitted at `epoch` and
    /// `writer` is its writer, holding the table for the bounded write: a change that would stop
    /// the write waits for it.
    pub(crate) async fn write_admitted(
        &self,
        database: &str,
        epoch: Epoch,
        writer: &Writer,
        postgres: &mut UnixStream,
        bytes: &[u8],
    ) -> Result<(), Blocked> {
        let table = self.table.read().await;
        if table.bound_epoch(database) != epoch || !table.admits(database) {
            return Err(Blocked::Fenced);
        }
        if !table.permits(database, writer) {
            return Err(Blocked::TargetChanged);
        }
        bounded_write(postgres, bytes).await
    }
    /// Writes `bytes` of a running session while its database runs on `writer`; false, with
    /// nothing written, while the database is quiescing or retired. The table is held through
    /// the bounded write, so new bytes never cross a published change. Without the channel the
    /// last table stands: only the agent stops a database, and it does so over the channel or by
    /// stopping the unit, which ends the session.
    pub(crate) async fn write_running(
        &self,
        database: &str,
        writer: &Writer,
        postgres: &mut UnixStream,
        bytes: &[u8],
    ) -> Result<bool, Blocked> {
        let table = self.table.read().await;
        if !table.permits(database, writer) {
            return Err(Blocked::TargetChanged);
        }
        if table.mode(database) != Some(Mode::Running) {
            return Ok(false);
        }
        bounded_write(postgres, bytes).await.map(|()| true)
    }
    /// What a session of the database does now, given what it was last asked: run, hold its
    /// bytes while the database quiesces, or close.
    async fn mode(&self, database: &str, requested: Action) -> Action {
        match self
            .table
            .read()
            .await
            .mode(database)
            .unwrap_or(Mode::Running)
        {
            Mode::Retired | Mode::Sleeping => Action::Retire,
            Mode::Quiesce => {
                if matches!(requested, Action::CloseIdle | Action::CloseAuthentication) {
                    requested
                } else {
                    Action::Quiesce
                }
            }
            Mode::Running => Action::Running,
        }
    }
    /// Whether a dial of `writer` for the database may begin: it is the database's writer and,
    /// with `epoch`, the database is still admitted at that epoch; or the outcome that stops it.
    pub(crate) async fn dialable(
        &self,
        database: &str,
        epoch: Option<Epoch>,
        writer: &Writer,
    ) -> Result<(), &'static str> {
        let table = self.table.read().await;
        if epoch
            .is_some_and(|epoch| table.bound_epoch(database) != epoch || !table.admits(database))
        {
            return Err("fenced");
        }
        if !table.permits(database, writer) {
            return Err("target_changed");
        }
        Ok(())
    }
}
async fn bounded_write(postgres: &mut UnixStream, bytes: &[u8]) -> Result<(), Blocked> {
    match timeout(WRITE_BOUND, postgres.write_all(bytes)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(Blocked::Lost),
    }
}
pub(crate) struct SessionLease {
    gateway: Arc<Gateway>,
    database: String,
    pub(crate) id: String,
    pub(crate) target: Writer,
    wire: WireBudget,
}
impl Drop for SessionLease {
    fn drop(&mut self) {
        self.gateway.sessions.lock().unwrap().remove(&self.id);
        self.gateway.measurements.lock().unwrap().close(&self.id);
        let mut admission = self.gateway.admission.lock().unwrap();
        admission.total -= 1;
        let count = admission.counts.get_mut(&self.database).unwrap();
        *count -= 1;
        if *count == 0 {
            admission.counts.remove(&self.database);
        }
    }
}
fn replay_status(reason: &str) -> u16 {
    if reason == "replayed" { 403 } else { 429 }
}
/// Monotonic stage marks of one routed connection, logged once as `conn_stages` when it is
/// dropped. The outcome is a fixed class; roles, addresses, tokens and payloads are never
/// logged.
struct Stages {
    database: String,
    outcome: &'static str,
    /// `warm` for a connection whose database was running when it arrived, `cold` for one held
    /// for its database's wake (plan 5.7).
    wake_path: &'static str,
    /// How a held wake connection's wait ended; none for any other connection.
    held_outcome: Option<&'static str>,
    /// From the upgrade of a held wake connection to its release.
    wake_wait: Option<Duration>,
    /// The agent's result for the wake, as it arrives, read when the line is logged.
    verdict: Option<Verdict>,
    received: Instant,
    accepted: Option<Instant>,
    startup: Option<Instant>,
    dial: Option<Duration>,
    written: Option<Instant>,
    first_backend: Option<Instant>,
}
impl Stages {
    fn new(database: &str, received: Instant) -> Self {
        Self {
            database: database.into(),
            // Kept only when the task is cancelled before it records an end.
            outcome: "aborted",
            wake_path: "warm",
            held_outcome: None,
            wake_wait: None,
            verdict: None,
            received,
            accepted: None,
            startup: None,
            dial: None,
            written: None,
            first_backend: None,
        }
    }
}
impl Drop for Stages {
    fn drop(&mut self) {
        let ms = |duration: Duration| duration.as_millis() as u64;
        let between = |from: Option<Instant>, to: Option<Instant>| {
            from.zip(to).map(|(from, to)| ms(to.duration_since(from)))
        };
        let mut observation = serde_json::json!({"event":"conn_stages","database":self.database,"outcome":self.outcome,"upgrade_ms":between(Some(self.received),self.accepted),"startup_ms":between(self.accepted,self.startup),"dial_ms":self.dial.map(ms),"first_backend_ms":between(self.written,self.first_backend),"wake_path":self.wake_path,"session_ms":ms(self.received.elapsed())});
        if let Some(held) = self.held_outcome {
            observation["held_outcome"] = held.into();
            if let Some(wait) = self.wake_wait {
                observation["wake_wait_ms"] = ms(wait).into();
            }
            if let Some(result) = self.verdict.as_ref().and_then(Verdict::get) {
                if let Some(reason) = result.reason {
                    observation["wake_reason"] = reason.into();
                }
                if !result.steps_ms.is_empty() {
                    observation["agent_ms"] = serde_json::json!(result.steps_ms);
                }
            }
        }
        println!("{observation}");
    }
}
fn upgrade(head: &HttpHead) -> bool {
    head.method == "GET"
        && head.path.split('?').next() == Some("/pg")
        && head
            .one("upgrade")
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
        && head.one("connection").is_some_and(|v| {
            v.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        })
        && head.one("sec-websocket-version") == Some("13")
        && !head.has("sec-websocket-protocol")
        && head
            .one("sec-websocket-key")
            .is_some_and(valid_websocket_key)
        && head.count("x-pgcf-route") <= 1
}
pub async fn serve_socket(
    mut socket: TcpStream,
    gateway: Arc<Gateway>,
    mut stop: watch::Receiver<bool>,
    handshake_permit: OwnedSemaphorePermit,
) -> Result<(), Failure> {
    let received = Instant::now();
    // The gateway answers a client in several small writes: the answer to SSLRequest, a pong, the
    // pieces of a result. A write that waits for the acknowledgement of the one before it meets
    // the peer's delayed acknowledgement, a stall of about 40 ms.
    let _ = socket.set_nodelay(true);
    let head = match timeout(Duration::from_secs(10), http::read_head(&mut socket)).await {
        Ok(Ok(head)) => head,
        _ => return http::reply_text(&mut socket, 400, "Bad Request\n").await,
    };
    let path = head.path.split('?').next().unwrap_or("");
    if head.method == "GET" && (path == "/healthz" || path == "/readyz") {
        let ready = gateway.ready().await;
        return http::reply_text(
            &mut socket,
            if path == "/readyz" && !ready {
                503
            } else {
                200
            },
            if path == "/healthz" || ready {
                "ok\n"
            } else if gateway.draining.load(Ordering::Acquire) {
                "draining\n"
            } else {
                "unsynchronized\n"
            },
        )
        .await;
    }
    if path == crate::sql::PATH {
        return crate::sql::serve(socket, head, gateway, stop, handshake_permit, received).await;
    }
    if !upgrade(&head) {
        return http::reply(
            &mut socket,
            if path == "/pg" { 400 } else { 404 },
            serde_json::json!({"error":"websocket_upgrade_required"}),
        )
        .await;
    }
    let route = head.one("x-pgcf-route");
    // Declared before the lease and both streams, so it is dropped and logged after them.
    let (claims, mut stages) = if route
        .is_some_and(|route| route.starts_with(&format!("{}.", wake::ROUTE_PREFIX)))
    {
        let ticket = match wake::verify_wake(
            route,
            &gateway.config.keyring.keys,
            &gateway.config.region,
            http::now(),
        ) {
            Ok(ticket) => ticket,
            Err(reason) => return route_denied(&mut socket, reason).await,
        };
        let mut stages = Stages::new(&ticket.db, received);
        match wake_state(&gateway, &ticket).await {
            // Released at its generation already: routed at once, as a running database is.
            WakeState::Released {
                writer,
                route_revision,
            } => (admitted_wake(&ticket, &writer, route_revision), stages),
            WakeState::Stale => {
                stages.outcome = "route_stale";
                return http::reply(&mut socket, 503, serde_json::json!({"error":"route_stale"}))
                    .await;
            }
            WakeState::Waiting => {
                return serve_held(
                    socket,
                    head,
                    gateway,
                    stop,
                    handshake_permit,
                    ticket,
                    stages,
                )
                .await;
            }
        }
    } else {
        let claims = match verify(
            route,
            &gateway.config.keyring.keys,
            &gateway.config.region,
            http::now() as f64,
        ) {
            Ok(claims) => claims,
            Err(reason) => return route_denied(&mut socket, reason).await,
        };
        let stages = Stages::new(&claims.db, received);
        (claims, stages)
    };
    let (target, epoch) = match gateway.admit(&claims, None).await {
        Ok(admitted) => admitted,
        Err(refused) => {
            stages.outcome = refused;
            return http::reply(&mut socket, 503, serde_json::json!({ "error": refused })).await;
        }
    };
    let Some(base) = session_memory(&gateway, &claims.db) else {
        stages.outcome = "memory_capacity";
        return memory_refused(&mut socket, &gateway, &claims.db).await;
    };
    let wire = WireBudget::new(gateway.memory.lease(&claims.db));
    let (session, mut actions) = match gateway.reserve(&claims, wire.clone(), &target, true) {
        Ok(value) => value,
        Err(status) => {
            stages.outcome = "admission_denied";
            return http::reply(
                &mut socket,
                status,
                serde_json::json!({"error":"admission_denied"}),
            )
            .await;
        }
    };
    // The route names the database, the user and the unit, so nothing the StartupMessage says
    // changes where PostgreSQL is dialled: the dial overlaps the client's own round trips to it
    // (the upgrade, the answer to SSLRequest, the StartupMessage). Not a byte is sent before the
    // StartupMessage has been checked against the route and the table.
    let mut early = early_dial(&gateway, &claims, &target).await;
    let stream = BudgetedStream::new(socket, head.prefix, head.end, wire.clone(), base);
    let accepted = timeout(
        Duration::from_secs(10),
        accept_async_with_config(stream, Some(websocket_config())),
    )
    .await;
    if !matches!(accepted, Ok(Ok(_))) {
        stages.outcome = "upgrade_failed";
    }
    let mut websocket = accepted??;
    stages.accepted = Some(Instant::now());
    drop(handshake_permit);
    let result = tokio::select! {
        result=timeout(STARTUP_BOUND,startup(&mut websocket,&claims,&session,epoch,&mut stages,&mut early))=>result.unwrap_or_else(|_|{stages.outcome="startup_timeout";Err("startup timeout".into())}),
        _=stop.changed()=>{stages.outcome="gateway_draining";Err("gateway draining".into())},
        _=actions.changed()=>{stages.outcome="fenced";Err("startup fenced".into())},
    };
    let (postgres, started) = match result {
        Ok(value) => value,
        Err(_) => {
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    let admitted = Admitted {
        claims: &claims,
        session: &session,
        epoch,
    };
    run_session(
        &mut websocket,
        postgres,
        started,
        admitted,
        &mut actions,
        &mut stop,
        &mut stages,
    )
    .await
}
async fn route_denied(socket: &mut TcpStream, reason: &str) -> Result<(), Failure> {
    http::reply(
        socket,
        if reason == "wrong_region" { 403 } else { 401 },
        serde_json::json!({"error":"route_denied"}),
    )
    .await
}
fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .read_buffer_size(4096)
        .write_buffer_size(4096)
        .max_write_buffer_size(MAX_FRAME_BYTES * 2)
        .max_frame_size(Some(MAX_PAYLOAD_BYTES))
        .max_message_size(Some(MAX_PAYLOAD_BYTES))
}
/// The memory one session holds before its first frame, or none within the gateway's bounds.
pub(crate) fn session_memory(gateway: &Arc<Gateway>, database: &str) -> Option<Lease> {
    let mut base = gateway.memory.lease(database);
    base.grow(SESSION_MEMORY_BYTES).then_some(base)
}
async fn memory_refused(
    socket: &mut TcpStream,
    gateway: &Gateway,
    database: &str,
) -> Result<(), Failure> {
    http::reply(
        socket,
        if gateway.memory.database_used(database) + SESSION_MEMORY_BYTES
            > gateway.config.database_memory
        {
            429
        } else {
            503
        },
        serde_json::json!({"error":"memory_capacity"}),
    )
    .await
}
/// What the agent's table shows of a wake ticket.
pub(crate) enum WakeState {
    /// Running at the ticket's generation and operation on the unit the agent released, named by
    /// its invocation ID. Its route revision is the ticket's or a later one: Cloudflare's own
    /// claim of the wake moves the revision on.
    Released {
        writer: String,
        route_revision: u64,
    },
    Waiting,
    /// The table moved past the ticket: another generation or operation, an earlier route
    /// revision, or retirement.
    Stale,
}
pub(crate) async fn wake_state(gateway: &Gateway, ticket: &WakeClaims) -> WakeState {
    let table = gateway.table.read().await;
    let Some(record) = table.record(&ticket.db) else {
        return WakeState::Waiting;
    };
    if record.mode == Mode::Retired
        || record.generation > ticket.generation
        || (record.generation == ticket.generation
            && (record.operation != ticket.op || record.route_revision < ticket.route_revision))
    {
        return WakeState::Stale;
    }
    match (&record.mode, &record.writer) {
        (Mode::Running, Some(unit))
            if table.synchronized() && record.generation == ticket.generation =>
        {
            WakeState::Released {
                writer: unit.instance.clone(),
                route_revision: record.route_revision,
            }
        }
        _ => WakeState::Waiting,
    }
}
/// The route a released wake is admitted under: the ticket's connection at its generation, the
/// released unit's invocation ID, and the route revision that released it.
pub(crate) fn admitted_wake(ticket: &WakeClaims, writer: &str, route_revision: u64) -> RouteClaims {
    let mut claims = ticket.admitted(Some(writer));
    claims.route_revision = Some(route_revision);
    claims
}
/// Where a held wake connection stands: released to a writer, ended, or (none) still waiting.
async fn held_state(
    gateway: &Gateway,
    ticket: &WakeClaims,
    held: &Held,
    stop: &watch::Receiver<bool>,
) -> Option<Result<(String, u64), HeldEnd>> {
    if gateway.draining.load(Ordering::Acquire) || *stop.borrow() {
        return Some(Err(HeldEnd::Draining));
    }
    if held
        .verdict()
        .is_some_and(|result| result.outcome == Outcome::Refused)
    {
        return Some(Err(HeldEnd::Refused));
    }
    match wake_state(gateway, ticket).await {
        WakeState::Released {
            writer,
            route_revision,
        } => Some(Ok((writer, route_revision))),
        WakeState::Stale => Some(Err(HeldEnd::Stale)),
        WakeState::Waiting => None,
    }
}
/// How a held wake connection ended without its release.
enum HeldEnd {
    Refused,
    Bound,
    Stale,
    Draining,
    ClientClosed,
}
/// Answers a held connection that is not released with its FATAL ErrorResponse.
async fn end_held(websocket: &mut WebSocket, stages: &mut Stages, end: HeldEnd) {
    let (held, outcome, state, message) = match end {
        HeldEnd::Refused => (
            "refused",
            "wake_refused",
            "57P03",
            "database is not accepting connections",
        ),
        HeldEnd::Bound => (
            "bound",
            "wake_timeout",
            "57P03",
            "database did not wake in time",
        ),
        HeldEnd::Stale => (
            "stale",
            "route_stale",
            "57P03",
            "database is not accepting connections",
        ),
        HeldEnd::Draining => (
            "draining",
            "gateway_draining",
            "08006",
            "gateway restarting",
        ),
        HeldEnd::ClientClosed => {
            stages.held_outcome = Some("client_closed");
            stages.outcome = "client_closed";
            return;
        }
    };
    stages.held_outcome = Some(held);
    stages.outcome = outcome;
    let _ = send_error(websocket, state, message).await;
}
/// A wake ticket (route v5) of a database the agent's table has not released: the connection is
/// upgraded at once, its StartupMessage is read and held, and its wake is queued for the agent. It
/// is released by the table entry that shows the woken unit and then routed as an admitted route;
/// until then not a byte reaches PostgreSQL and nothing is dialled.
async fn serve_held(
    mut socket: TcpStream,
    head: HttpHead,
    gateway: Arc<Gateway>,
    mut stop: watch::Receiver<bool>,
    handshake_permit: OwnedSemaphorePermit,
    ticket: WakeClaims,
    mut stages: Stages,
) -> Result<(), Failure> {
    stages.wake_path = "cold";
    let database = ticket.db.clone();
    if gateway.draining.load(Ordering::Acquire) {
        stages.outcome = "fenced";
        return http::reply(&mut socket, 503, serde_json::json!({"error":"fenced"})).await;
    }
    let Some(base) = session_memory(&gateway, &database) else {
        stages.outcome = "memory_capacity";
        return memory_refused(&mut socket, &gateway, &database).await;
    };
    // The replay of the route the connection is admitted under is checked now, once.
    let replay = gateway
        .admission
        .lock()
        .unwrap()
        .replay
        .use_token(&ticket.admitted(None), http::now());
    if let Err(reason) = replay {
        stages.outcome = "admission_denied";
        return http::reply(
            &mut socket,
            replay_status(reason),
            serde_json::json!({"error":"admission_denied"}),
        )
        .await;
    }
    let mut held = match gateway
        .wakes
        .hold(&ticket, http::now(), std::time::Instant::now())
    {
        Ok(held) => held,
        Err(status) => {
            stages.outcome = "wake_capacity";
            return http::reply(
                &mut socket,
                status,
                serde_json::json!({"error":"wake_capacity"}),
            )
            .await;
        }
    };
    let wire = WireBudget::new(gateway.memory.lease(&database));
    let stream = BudgetedStream::new(socket, head.prefix, head.end, wire.clone(), base);
    let accepted = timeout(
        Duration::from_secs(10),
        accept_async_with_config(stream, Some(websocket_config())),
    )
    .await;
    if !matches!(accepted, Ok(Ok(_))) {
        stages.outcome = "upgrade_failed";
    }
    let mut websocket = accepted??;
    let upgraded = Instant::now();
    stages.accepted = Some(upgraded);
    drop(handshake_permit);
    let deadline = tokio::time::Instant::from_std(upgraded + WAKE_BOUND);
    let id = format!("{database}/{}", ticket.cid);
    let route = ticket.admitted(None);
    // Until the StartupMessage is read, the read itself is what the wait polls besides the table
    // and the agent's result: a refusal, the bound or the table moving on end it as well.
    let read = {
        let read = read_startup(&mut websocket, &route, &gateway, &id, &wire, &mut stages);
        tokio::pin!(read);
        loop {
            let table = gateway.changed().await;
            let changed = table.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(Err(end)) = held_state(&gateway, &ticket, &held, &stop).await {
                break Err(Some(end));
            }
            tokio::select! {
                read = read.as_mut() => break read.map_err(|_| None),
                _ = changed.as_mut() => {},
                _ = held.answered() => {},
                _ = tokio::time::sleep_until(deadline) => break Err(Some(HeldEnd::Bound)),
                changed = stop.changed() => if changed.is_err() { break Err(Some(HeldEnd::Draining)) },
            }
        }
    };
    let mut started = match read {
        Ok(started) => started,
        Err(end) => {
            stages.verdict = Some(held.release());
            match end {
                Some(end) => end_held(&mut websocket, &mut stages, end).await,
                // The client ended or broke its startup; a refused one was already answered.
                None if stages.outcome == "client_closed" => {
                    stages.held_outcome = Some("client_closed");
                }
                None => {}
            }
            return Ok(());
        }
    };
    let released = loop {
        // Armed before the table is read, so a change between the read and the wait wakes it.
        let table = gateway.changed().await;
        let changed = table.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if let Some(state) = held_state(&gateway, &ticket, &held, &stop).await {
            break state;
        }
        tokio::select! {
            _ = changed.as_mut() => {},
            _ = held.answered() => {},
            _ = tokio::time::sleep_until(deadline) => break Err(HeldEnd::Bound),
            changed = stop.changed() => if changed.is_err() { break Err(HeldEnd::Draining) },
            // What the client sends after its StartupMessage (a pipelined password) is held with
            // it, within the connection's memory.
            message = websocket.next() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    started.leases.push(wire.take_message().inspect_err(|_| stages.outcome = "websocket_error")?);
                    started.rest.extend_from_slice(&bytes);
                }
                Some(Ok(Message::Ping(value))) => send_client(&mut websocket, Message::Pong(value), &mut stages).await?,
                Some(Ok(Message::Pong(_))) => {},
                Some(Ok(Message::Text(_))) => {
                    stages.outcome = "text_frame";
                    let _ = wire.take_message()?;
                    close(&mut websocket, CloseCode::Unsupported, "binary frames required").await;
                    return Ok(());
                }
                _ => break Err(HeldEnd::ClientClosed),
            },
        }
    };
    stages.verdict = Some(held.release());
    let (writer, route_revision) = match released {
        Ok(released) => released,
        Err(end) => {
            end_held(&mut websocket, &mut stages, end).await;
            return Ok(());
        }
    };
    stages.held_outcome = Some("released");
    stages.wake_wait = Some(upgraded.elapsed());
    // From here the connection is the admitted route of the woken unit.
    let claims = admitted_wake(&ticket, &writer, route_revision);
    let (target, epoch) = match gateway.admit(&claims, Some(&writer)).await {
        Ok(admitted) => admitted,
        Err(refused) => {
            stages.outcome = refused;
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    let (session, mut actions) = match gateway.reserve(&claims, wire.clone(), &target, false) {
        Ok(value) => value,
        Err(_) => {
            stages.outcome = "admission_denied";
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    {
        // The session is measured from its reservation; what the client sent while held is its.
        let mut metrics = gateway.measurements.lock().unwrap();
        metrics.ingress(&session.id, started.startup.len() + started.rest.len());
        metrics.client_activity(&session.id);
    }
    let mut early = None;
    let dialed = tokio::select! {
        result=timeout(STARTUP_BOUND,async{take_password(&mut websocket,&mut started,&session,&mut stages).await?;dial_started(&claims,&session,epoch,&mut stages,&mut early).await})=>result.unwrap_or_else(|_|{stages.outcome="startup_timeout";Err("startup timeout".into())}),
        _=stop.changed()=>{stages.outcome="gateway_draining";Err("gateway draining".into())},
        _=actions.changed()=>{stages.outcome="fenced";Err("startup fenced".into())},
    };
    let Ok(postgres) = dialed else {
        // A refused password was answered and its socket closed: this send then fails unseen.
        let _ = send_error(&mut websocket, "08006", "database connection failed").await;
        return Ok(());
    };
    let admitted = Admitted {
        claims: &claims,
        session: &session,
        epoch,
    };
    run_session(
        &mut websocket,
        postgres,
        started,
        admitted,
        &mut actions,
        &mut stop,
        &mut stages,
    )
    .await
}
/// A route admitted on a writer, with its reserved session and the table epoch it was admitted at.
struct Admitted<'a> {
    claims: &'a RouteClaims,
    session: &'a SessionLease,
    epoch: Epoch,
}
/// The client's StartupMessage, with what it sent behind it, checked against the route.
struct Started {
    /// The StartupMessage, written to PostgreSQL first.
    startup: Vec<u8>,
    leases: Vec<Lease>,
    /// The bytes behind the StartupMessage; once a pipelined password is taken, those behind it.
    rest: Zeroizing<Vec<u8>>,
    /// Whether the client pipelined its password in the message of its StartupMessage, so the
    /// gateway asked for it with AuthenticationCleartextPassword and logs in to PostgreSQL itself;
    /// none while the PasswordMessage that began there is incomplete.
    cleartext: Option<bool>,
    password: Option<auth::Password>,
}
/// Writes the checked StartupMessage to the dialled writer while the table still admits it on
/// that writer, then relays the session.
async fn run_session(
    websocket: &mut WebSocket,
    mut postgres: UnixStream,
    started: Started,
    admitted: Admitted<'_>,
    actions: &mut watch::Receiver<Action>,
    stop: &mut watch::Receiver<bool>,
    stages: &mut Stages,
) -> Result<(), Failure> {
    let Admitted {
        claims,
        session,
        epoch,
    } = admitted;
    let gateway = &session.gateway;
    let id = &session.id;
    let wire = &session.wire;
    let target = &session.target;
    let Started {
        startup,
        leases: initial_leases,
        rest,
        password,
        ..
    } = started;
    let result = async {
        let mut activity = PostgresActivity::new();
        activity.observe_frontend(&rest);
        // A client that logs in itself sends what it pipelined with its StartupMessage; for one
        // the gateway logs in for, those bytes wait for the login.
        let mut initial = startup;
        if password.is_none() {
            initial.extend_from_slice(&rest);
        }
        update(gateway, id, &activity, true, false);
        match gateway
            .write_admitted(&claims.db, epoch, target, &mut postgres, &initial)
            .await
        {
            Ok(()) => {}
            Err(Blocked::Fenced) => {
                stages.outcome = "fenced";
                return Err("startup fenced before first upstream write".into());
            }
            Err(Blocked::TargetChanged) => {
                stages.outcome = "target_changed";
                return Err("writer changed before first upstream write".into());
            }
            Err(Blocked::Lost) => {
                stages.outcome = "postgres_error";
                return Err("first upstream write failed".into());
            }
        }
        stages.written = Some(Instant::now());
        let mut held = None;
        if let Some(password) = password {
            let login = tokio::select! {
                login=timeout(STARTUP_BOUND,auth::login(&mut postgres,&password,None))=>login.map_err(|_|"startup_timeout").and_then(|login|login.map_err(|_|"postgres_error")),
                _=stop.changed()=>Err("gateway_draining"),
                _=actions.changed()=>Err("fenced"),
            };
            drop(password);
            let answer = match login {
                Err(outcome) => {
                    stages.outcome = outcome;
                    let _ = send_error(websocket, "08006", "database connection failed").await;
                    return Err("login failed".into());
                }
                Ok(Login::Authenticated(answer, _)) => answer,
                Ok(Login::Refused) => {
                    stages.outcome = "authentication_failed";
                    refuse(websocket).await;
                    return Err("password refused".into());
                }
                Ok(Login::Failed(answer)) => {
                    stages.outcome = "postgres_refused";
                    let _ = send_client(websocket, Message::Binary(answer.into()), stages).await;
                    let _ = timeout(Duration::from_millis(500), websocket.close(None)).await;
                    return Err("login refused".into());
                }
            };
            activity.observe_backend(&answer);
            {
                let mut metrics = gateway.measurements.lock().unwrap();
                if activity.authenticated() {
                    metrics.authenticate(id);
                }
                metrics.egress(id, answer.len());
            }
            update(gateway, id, &activity, true, false);
            send_client(websocket, Message::Binary(answer.into()), stages).await?;
            stages.first_backend = Some(Instant::now());
            if !rest.is_empty() {
                held = Some((rest.to_vec(), initial_leases));
            }
        } else {
            drop(initial_leases);
        }
        wire.allow_relay();
        relay(
            websocket,
            &mut postgres,
            session,
            &mut activity,
            held,
            actions,
            stop,
            stages,
        )
        .await
    }
    .await;
    // The relay ends the PostgreSQL stream itself only when it returns normally.
    if result.is_err() {
        close_upstream(&mut postgres).await;
    }
    result
}
fn update(
    gateway: &Gateway,
    id: &str,
    activity: &PostgresActivity,
    extra_busy: bool,
    pending: bool,
) {
    gateway.sessions.lock().unwrap().update(
        id,
        activity.authenticated(),
        activity.busy() || extra_busy,
        pending,
    );
}
async fn send_error(socket: &mut WebSocket, state: &str, message: &str) -> Result<(), Failure> {
    timeout(
        Duration::from_millis(500),
        socket.send(Message::Binary(error_response(state, message).into())),
    )
    .await??;
    let _ = timeout(Duration::from_millis(500), socket.close(None)).await;
    Ok(())
}
async fn close(socket: &mut WebSocket, code: CloseCode, reason: &str) {
    let _ = timeout(
        Duration::from_millis(500),
        socket.close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })),
    )
    .await;
}
/// Refuses a password as the decoys refuse it: their 28P01 and their close.
async fn refuse(socket: &mut WebSocket) {
    let _ = timeout(
        Duration::from_millis(500),
        socket.send(Message::Binary(auth::refusal().into())),
    )
    .await;
    close(socket, CloseCode::Normal, "connection refused").await;
}
/// AuthenticationCleartextPassword, for a client that pipelined its password.
async fn ask_password(
    socket: &mut WebSocket,
    gateway: &Gateway,
    id: &str,
    stages: &mut Stages,
) -> Result<(), Failure> {
    socket
        .send(Message::Binary(auth::CLEARTEXT_REQUEST.to_vec().into()))
        .await
        .inspect_err(|_| stages.outcome = "websocket_error")?;
    gateway
        .measurements
        .lock()
        .unwrap()
        .egress(id, auth::CLEARTEXT_REQUEST.len());
    Ok(())
}
/// Completes a password the client began to pipeline behind its StartupMessage and takes it out
/// of the bytes for PostgreSQL. One the gateway cannot accept is refused as the decoys refuse it,
/// before PostgreSQL hears of the connection.
async fn take_password(
    socket: &mut WebSocket,
    started: &mut Started,
    session: &SessionLease,
    stages: &mut Stages,
) -> Result<(), Failure> {
    if started.cleartext == Some(false) || started.password.is_some() {
        return Ok(());
    }
    loop {
        let taken = auth::take_password(&mut started.rest);
        if started.cleartext.is_none() && !matches!(taken, Pipelined::Incomplete) {
            let asked = !matches!(taken, Pipelined::Absent | Pipelined::Sasl);
            if asked {
                ask_password(socket, &session.gateway, &session.id, stages).await?;
            }
            started.cleartext = Some(asked);
        }
        match taken {
            Pipelined::Absent | Pipelined::Sasl => return Ok(()),
            Pipelined::Password(password) => {
                started.password = Some(password);
                return Ok(());
            }
            Pipelined::Refused => {
                stages.outcome = "authentication_failed";
                refuse(socket).await;
                return Err("password refused".into());
            }
            Pipelined::Incomplete => {}
        }
        match socket.next().await {
            Some(Ok(Message::Binary(bytes))) => {
                started.leases.push(
                    session
                        .wire
                        .take_message()
                        .inspect_err(|_| stages.outcome = "websocket_error")?,
                );
                {
                    let mut metrics = session.gateway.measurements.lock().unwrap();
                    metrics.ingress(&session.id, bytes.len());
                    metrics.client_activity(&session.id);
                }
                started.rest.extend_from_slice(&bytes);
            }
            Some(Ok(Message::Ping(value))) => {
                send_client(socket, Message::Pong(value), stages).await?
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Text(_))) => {
                stages.outcome = "text_frame";
                let _ = session.wire.take_message()?;
                close(socket, CloseCode::Unsupported, "binary frames required").await;
                return Err("text password".into());
            }
            Some(Err(_)) => {
                stages.outcome = "websocket_error";
                return Err("password failed".into());
            }
            _ => {
                stages.outcome = "client_closed";
                return Err("password closed".into());
            }
        }
    }
}
/// Sends one message to the client within 10 s; a failure ends the connection.
async fn send_client(
    socket: &mut WebSocket,
    message: Message,
    stages: &mut Stages,
) -> Result<(), Failure> {
    let sent = timeout(Duration::from_secs(10), socket.send(message)).await;
    if !matches!(sent, Ok(Ok(()))) {
        stages.outcome = "websocket_error";
    }
    Ok(sent??)
}
/// Ends a failed PostgreSQL session with the end of its stream within 500 ms, so PostgreSQL sees
/// a clean end instead of a broken connection.
pub(crate) async fn close_upstream(postgres: &mut UnixStream) {
    let _ = timeout(Duration::from_millis(500), postgres.shutdown()).await;
}
/// Reads the client's StartupMessage, answering SSLRequest and GSSENCRequest with `N`. A
/// StartupMessage for another database or user than the route's is refused with 28000; no byte of
/// the client reaches PostgreSQL here.
async fn read_startup(
    socket: &mut WebSocket,
    claims: &RouteClaims,
    gateway: &Gateway,
    id: &str,
    wire: &WireBudget,
    stages: &mut Stages,
) -> Result<Started, Failure> {
    let mut reader = StartupReader::default();
    let mut leases = Vec::new();
    loop {
        let bytes = match socket.next().await {
            Some(Ok(Message::Binary(bytes))) => {
                leases.push(
                    wire.take_message()
                        .inspect_err(|_| stages.outcome = "websocket_error")?,
                );
                bytes
            }
            Some(Ok(Message::Ping(value))) => {
                socket
                    .send(Message::Pong(value))
                    .await
                    .inspect_err(|_| stages.outcome = "websocket_error")?;
                continue;
            }
            Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Text(_))) => {
                stages.outcome = "text_frame";
                let _ = wire.take_message()?;
                close(socket, CloseCode::Unsupported, "binary frames required").await;
                return Err("text startup".into());
            }
            Some(Err(_)) => {
                stages.outcome = "websocket_error";
                return Err("startup failed".into());
            }
            _ => {
                stages.outcome = "client_closed";
                return Err("startup closed".into());
            }
        };
        {
            let mut metrics = gateway.measurements.lock().unwrap();
            metrics.ingress(id, bytes.len());
            if !bytes.is_empty() {
                metrics.client_activity(id);
            }
        }
        let mut event = reader.push(&bytes);
        loop {
            match event {
                Event::NeedMore => break,
                Event::Ssl | Event::Gss => {
                    socket
                        .send(Message::Binary(vec![b'N'].into()))
                        .await
                        .inspect_err(|_| stages.outcome = "websocket_error")?;
                    gateway.measurements.lock().unwrap().egress(id, 1);
                    event = reader.push(&[]);
                }
                Event::Cancel => {
                    stages.outcome = "cancel";
                    close(socket, CloseCode::Normal, "cancel unsupported").await;
                    return Err("cancel unsupported".into());
                }
                Event::Error { sqlstate, message } => {
                    stages.outcome = "startup_error";
                    send_error(socket, &sqlstate, &message).await?;
                    return Err("startup refused".into());
                }
                Event::Startup {
                    database,
                    user,
                    raw,
                    rest,
                    ..
                } => {
                    stages.startup = Some(Instant::now());
                    if database != claims.db || user != claims.user {
                        stages.outcome = "startup_route_mismatch";
                        send_error(
                            socket,
                            "28000",
                            "startup does not match the authorized route",
                        )
                        .await?;
                        return Err("startup route mismatch".into());
                    }
                    let cleartext = auth::asks_password(&rest);
                    if cleartext == Some(true) {
                        ask_password(socket, gateway, id, stages).await?;
                    }
                    return Ok(Started {
                        startup: raw,
                        leases,
                        rest: Zeroizing::new(rest),
                        cleartext,
                        password: None,
                    });
                }
            }
        }
    }
}
/// Dials the writer the route was admitted on (or takes the dial that began with the admission)
/// once the checked StartupMessage is there, while the table still admits it on that writer.
async fn dial_started(
    claims: &RouteClaims,
    session: &SessionLease,
    epoch: Epoch,
    stages: &mut Stages,
    early: &mut Option<EarlyDial>,
) -> Result<UnixStream, Failure> {
    let gateway = &*session.gateway;
    let database = &claims.db;
    gateway
        .dialable(database, Some(epoch), &session.target)
        .await
        .map_err(|outcome| {
            stages.outcome = outcome;
            "writer not admitted before dial"
        })?;
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(&session.id, false, true, true);
    // The dial that began with the admission is this one if it was for this writer; a writer
    // that changed since is never dialled, as `dialable` refused it.
    let (dialed, took) = match early.take() {
        Some(early) if early.writer == session.target => early.finish().await,
        other => {
            drop(other);
            let dialing = Instant::now();
            let dialed = local::dial(&session.target).await;
            (dialed, dialing.elapsed())
        }
    };
    stages.dial = Some(took);
    let mut postgres = dialed.map_err(|error| {
        stages.outcome = error.outcome();
        "PostgreSQL dial failed"
    })?;
    if !gateway.admitted_at(database, epoch).await {
        stages.outcome = "fenced";
        close_upstream(&mut postgres).await;
        return Err("table changed during the dial".into());
    }
    Ok(postgres)
}
/// The StartupMessage, checked against the route, and the writer dialled for it.
async fn startup(
    socket: &mut WebSocket,
    claims: &RouteClaims,
    session: &SessionLease,
    epoch: Epoch,
    stages: &mut Stages,
    early: &mut Option<EarlyDial>,
) -> Result<(UnixStream, Started), Failure> {
    let mut started = read_startup(
        socket,
        claims,
        &session.gateway,
        &session.id,
        &session.wire,
        stages,
    )
    .await?;
    take_password(socket, &mut started, session, stages).await?;
    let postgres = dial_started(claims, session, epoch, stages, early).await?;
    Ok((postgres, started))
}
/// A dial of PostgreSQL that began when the route was admitted: its peer is the unit, and it has
/// had no byte of the client written to it.
struct EarlyDial {
    writer: Writer,
    task: tokio::task::JoinHandle<(Result<UnixStream, local::DialFailure>, Duration)>,
}
impl EarlyDial {
    /// The connection, or why there is none, and how long the dial itself took.
    async fn finish(mut self) -> (Result<UnixStream, local::DialFailure>, Duration) {
        match (&mut self.task).await {
            Ok(dialed) => dialed,
            Err(error) => (
                Err(local::DialFailure::Connect(std::io::Error::other(error))),
                Duration::ZERO,
            ),
        }
    }
}
impl Drop for EarlyDial {
    /// A connection that ends before its StartupMessage takes the dial with it.
    fn drop(&mut self) {
        self.task.abort();
    }
}
/// Starts the dial of the writer a route was admitted for, if it is still the writer.
async fn early_dial(gateway: &Gateway, claims: &RouteClaims, bound: &Writer) -> Option<EarlyDial> {
    gateway.dialable(&claims.db, None, bound).await.ok()?;
    let writer = bound.clone();
    let wanted = writer.clone();
    Some(EarlyDial {
        writer,
        task: tokio::spawn(async move {
            let began = Instant::now();
            let dialed = local::dial(&wanted).await;
            (dialed, began.elapsed())
        }),
    })
}
/// `held` is what the client sent that waits for the session to run: the bytes it pipelined
/// behind a password the gateway logged in with.
#[allow(clippy::too_many_arguments)]
async fn relay(
    websocket: &mut WebSocket,
    postgres: &mut UnixStream,
    session: &SessionLease,
    activity: &mut PostgresActivity,
    mut held: Option<(Vec<u8>, Vec<Lease>)>,
    actions: &mut watch::Receiver<Action>,
    stop: &mut watch::Receiver<bool>,
    stages: &mut Stages,
) -> Result<(), Failure> {
    let gateway = &*session.gateway;
    let id = &session.id;
    let target = &session.target;
    let wire = &session.wire;
    let mut read = vec![0u8; MAX_FRAME_BYTES];
    let mut alive = true;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut drain_at = None;
    let mut physical_timer = tokio::time::interval(Duration::from_millis(100));
    let database = id.split_once('/').expect("bound session identity").0;
    update(gateway, id, activity, false, false);
    loop {
        if !gateway.permits(database, target).await {
            stages.outcome = "target_changed";
            close(websocket, CloseCode::Restart, "writer changed").await;
            break;
        }
        let requested = *actions.borrow_and_update();
        let mut mode = gateway.mode(database, requested).await;
        if mode == Action::Running
            && let Some((bytes, lease)) = held.take()
        {
            update(gateway, id, activity, true, false);
            if forward_if_running(gateway, database, target, postgres, &bytes, stages).await? {
                drop(lease);
            } else {
                held = Some((bytes, lease));
                mode = gateway.mode(database, requested).await;
            }
        }
        update(gateway, id, activity, held.is_some(), false);
        if mode == Action::CloseAuthentication
            || (mode == Action::Quiesce && !activity.authenticated())
        {
            stages.outcome = "authentication_interrupted";
            close(websocket, CloseCode::Restart, "authentication interrupted").await;
            break;
        }
        if mode == Action::CloseIdle {
            if !activity.busy() && !wire.busy() && held.is_none() {
                stages.outcome = "database_sleeping";
                close(websocket, CloseCode::Normal, "database sleeping").await;
                break;
            }
            mode = Action::Quiesce;
        }
        let deadline =
            drain_at.unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 3600));
        tokio::select! {
            _=stop.changed()=>{if *stop.borrow(){drain_at=Some(Instant::now()+Duration::from_secs(29));}},
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>{stages.outcome="gateway_draining";close(websocket,CloseCode::Restart,"gateway restarting").await;break;},
            _=actions.changed()=>{},
            _=physical_timer.tick()=>{},
            _=heartbeat.tick(),if mode==Action::Running=>{if !alive{stages.outcome="heartbeat_timeout";break;}alive=false;send_client(websocket,Message::Ping(Vec::new().into()),stages).await?;},
            message=websocket.next(),if held.is_none()||mode==Action::Retire=>{
                match message{
                    Some(Ok(Message::Binary(bytes)))=>{
                        let lease=wire.take_message().inspect_err(|_|stages.outcome="websocket_error")?;{let mut metrics=gateway.measurements.lock().unwrap();metrics.ingress(id,bytes.len());if !bytes.is_empty(){metrics.client_activity(id);}}
                        activity.observe_frontend(&bytes);update(gateway,id,activity,true,false);
                        if held.is_some(){stages.outcome="database_retired";close(websocket,CloseCode::Restart,"database retired").await;break;}
                        if forward_if_running(gateway,database,target,postgres,&bytes,stages).await?{drop(lease);}
                        else{held=Some((bytes.to_vec(),vec![lease]));}
                    },
                    Some(Ok(Message::Pong(_)))=>alive=true,
                    Some(Ok(Message::Ping(value)))=>send_client(websocket,Message::Pong(value),stages).await?,
                    Some(Ok(Message::Text(_)))=>{stages.outcome="text_frame";let _=wire.take_message()?;close(websocket,CloseCode::Unsupported,"binary frames required").await;break;},
                    Some(Ok(Message::Close(_)))|None=>{stages.outcome="client_closed";break;},
                    Some(Err(_))=>{stages.outcome="websocket_error";close(websocket,CloseCode::Again,"relay buffer or connection failed").await;break;},
                    _=>{},
                }
            },
            result=postgres.read(&mut read)=>{
                let length=result.inspect_err(|_|stages.outcome="postgres_error")?;if length==0{stages.outcome="postgres_closed";break;}activity.observe_backend(&read[..length]);
                {let mut metrics=gateway.measurements.lock().unwrap();if activity.authenticated(){metrics.authenticate(id);}metrics.egress(id,length);}
                update(gateway,id,activity,true,false);send_client(websocket,Message::Binary(read[..length].to_vec().into()),stages).await?;
                stages.first_backend.get_or_insert_with(Instant::now);
            }
        }
    }
    let _ = timeout(Duration::from_millis(500), websocket.close(None)).await;
    let _ = timeout(Duration::from_millis(500), postgres.shutdown()).await;
    Ok(())
}
/// Forwards client bytes while the database runs on the session's writer; false while they wait.
async fn forward_if_running(
    gateway: &Gateway,
    database: &str,
    target: &Writer,
    postgres: &mut UnixStream,
    bytes: &[u8],
    stages: &mut Stages,
) -> Result<bool, Failure> {
    // The bounded enqueue and the table's changes share this read/write boundary.
    // Bytes already being written stay busy; new bytes cannot cross a published change.
    match gateway
        .write_running(database, target, postgres, bytes)
        .await
    {
        Ok(written) => Ok(written),
        Err(Blocked::TargetChanged) => {
            stages.outcome = "target_changed";
            Err("writer changed".into())
        }
        Err(Blocked::Fenced) => {
            stages.outcome = "fenced";
            Err("database fenced".into())
        }
        Err(Blocked::Lost) => {
            stages.outcome = "postgres_error";
            Err("PostgreSQL write failed".into())
        }
    }
}
