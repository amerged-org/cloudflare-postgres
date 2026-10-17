// SPDX-License-Identifier: Apache-2.0
use crate::{
    auth::{self, Login, Pipelined},
    budget::{BudgetedStream, Lease, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, MemoryBudget, WireBudget},
    control::{self, Control, HttpHead},
    hold::{Held, Verdict, WakeQueue},
    kubernetes::{FenceState, Kubernetes},
    sessions::{Action, Sessions, SharedSessions},
    targets::{TargetIdentity, TargetUnavailable, Targets},
    telemetry::GatewayMeasurements,
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use pgcf_native_protocol::{
    activity::PostgresActivity,
    constant,
    route::{Keyring, ReplayCache, RouteClaims, valid_websocket_key, verify},
    startup::{Event, StartupReader, error_response},
    wake::{self, Outcome, WakeClaims},
};
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use rustls_pki_types::{CertificateDer, pem::PemObject};
use sha2::{Digest, Sha256};
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
    net::TcpStream,
    sync::{OwnedSemaphorePermit, RwLock, watch},
    time::timeout,
};
use tokio_rustls::{TlsConnector, client::TlsStream};
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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatabaseTarget {
    pub database: String,
    pub host: String,
    pub port: u16,
    pub address: std::net::IpAddr,
    pub pod_uid: String,
    pub ca_sha256: Option<String>,
    /// The database's TLS authority as the watch showed it when the target was chosen: never
    /// one other than the admitted `ca_sha256`.
    pub ca: Option<Arc<[u8]>>,
}
pub trait PostgresDial: Send + Sync {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>>;
}
/// Dials PostgreSQL with the TLS authority the watch showed (or, without one, the API server's),
/// verified with a configuration built once per database and authority.
pub struct ClusterPostgresDial {
    api: Arc<Kubernetes>,
    configs: TlsConfigs,
}
impl ClusterPostgresDial {
    pub fn new(api: Arc<Kubernetes>) -> Self {
        Self {
            api,
            configs: TlsConfigs::default(),
        }
    }
}
impl PostgresDial for ClusterPostgresDial {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>> {
        Box::pin(async move {
            for attempt in 0..2 {
                let ca = match (&target.ca, attempt) {
                    (Some(ca), 0) => ca.to_vec(),
                    _ => self.api.database_ca(&target.database, attempt == 1).await?,
                };
                if target
                    .ca_sha256
                    .as_ref()
                    .is_some_and(|expected| sha256_hex(&ca) != *expected)
                {
                    if attempt == 0 {
                        continue;
                    }
                    return Err("admitted TLS authority changed".into());
                }
                let config = self.configs.get(&target.database, &ca)?;
                match dial_postgres(target.address, &target.host, target.port, config).await {
                    Ok(postgres) => return Ok(postgres),
                    Err(error) => {
                        if attempt == 1 || !certificate_error(error.as_ref()) {
                            return Err(error);
                        }
                    }
                }
            }
            Err("TLS connection unavailable".into())
        })
    }
}
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// The rustls client configuration of each database's TLS authority, built once: a dial after a
/// wake verifies without parsing the authority again.
#[derive(Default)]
pub struct TlsConfigs(Mutex<HashMap<String, (String, Arc<ClientConfig>)>>);
impl TlsConfigs {
    const MAXIMUM: usize = 2000;
    pub fn get(&self, database: &str, ca: &[u8]) -> Result<Arc<ClientConfig>, Failure> {
        let digest = sha256_hex(ca);
        if let Some((cached, config)) = self.0.lock().unwrap().get(database)
            && *cached == digest
        {
            return Ok(config.clone());
        }
        let config = client_config(ca)?;
        let mut configs = self.0.lock().unwrap();
        if configs.len() >= Self::MAXIMUM && !configs.contains_key(database) {
            configs.clear();
        }
        configs.insert(database.into(), (digest, config.clone()));
        Ok(config)
    }
    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}
pub struct Gateway {
    pub config: Arc<Config>,
    pub dial: Arc<dyn PostgresDial>,
    pub fences: Arc<RwLock<FenceState>>,
    pub targets: Arc<RwLock<Targets>>,
    pub sessions: SharedSessions,
    pub measurements: Arc<Mutex<GatewayMeasurements>>,
    pub control: Control,
    pub draining: AtomicBool,
    /// The held connections of sleeping databases and their wake tickets.
    pub wakes: Arc<WakeQueue>,
    /// The idle sessions of HTTP SQL.
    pub sql: crate::sql::Pool,
    pub(crate) admission: Mutex<Admission>,
    pub(crate) memory: Arc<MemoryBudget>,
}
impl Gateway {
    pub fn new(config: Arc<Config>, pod: String, dial: Arc<dyn PostgresDial>) -> Arc<Self> {
        let fences = Arc::new(RwLock::new(FenceState::default()));
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let measurements = Arc::new(Mutex::new(GatewayMeasurements::new()));
        let wakes = WakeQueue::new();
        let control = Control::new(
            config.clone(),
            pod,
            fences.clone(),
            sessions.clone(),
            measurements.clone(),
            wakes.clone(),
        );
        Arc::new(Self {
            memory: MemoryBudget::new(config.maximum_memory, config.database_memory),
            config,
            dial,
            fences,
            targets: Arc::new(RwLock::new(Targets::default())),
            sessions,
            measurements,
            control,
            draining: AtomicBool::new(false),
            wakes,
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
        target: &TargetIdentity,
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
                .use_token(claims, control::now())
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
}
pub(crate) struct SessionLease {
    gateway: Arc<Gateway>,
    database: String,
    pub(crate) id: String,
    pub(crate) target: TargetIdentity,
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
/// dropped. The outcome and the route are fixed classes; roles, addresses, tokens and payloads
/// are never logged.
struct Stages {
    database: String,
    outcome: &'static str,
    target_reason: Option<TargetUnavailable>,
    /// The class of the writer the connection was admitted on, once one was chosen.
    route: Option<&'static str>,
    /// `warm` for a route to a running database, `pool_hit` for a held wake released to a pool
    /// slot, `pool_miss` for any other held wake.
    wake_path: &'static str,
    /// How a held wake connection's wait ended; none for any other connection.
    held_outcome: Option<&'static str>,
    /// From the upgrade of a held wake connection to its release.
    wake_wait: Option<Duration>,
    /// The controller's result for the wake, as it arrives, read when the line is logged.
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
            target_reason: None,
            route: None,
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
        let mut observation = serde_json::json!({"event":"conn_stages","database":self.database,"outcome":self.outcome,"upgrade_ms":between(Some(self.received),self.accepted),"startup_ms":between(self.accepted,self.startup),"dial_ms":self.dial.map(ms),"first_backend_ms":between(self.written,self.first_backend),"route":self.route,"wake_path":self.wake_path,"session_ms":ms(self.received.elapsed())});
        if let Some(reason) = self.target_reason {
            observation["target_reason"] = reason.code().into();
        }
        if let Some(held) = self.held_outcome {
            observation["held_outcome"] = held.into();
            if let Some(wait) = self.wake_wait {
                observation["wake_wait_ms"] = ms(wait).into();
            }
            if let Some(result) = self.verdict.as_ref().and_then(Verdict::get) {
                if let Some(reason) = result.reason {
                    observation["miss_reason"] = reason.into();
                }
                if !result.steps_ms.is_empty() {
                    observation["controller_ms"] = serde_json::json!(result.steps_ms);
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
    let head = match timeout(Duration::from_secs(10), control::read_head(&mut socket)).await {
        Ok(Ok(head)) => head,
        _ => return control::reply_text(&mut socket, 400, "Bad Request\n").await,
    };
    if let Some((status, body)) = gateway.control.handle(&head, &mut socket).await {
        return control::reply(&mut socket, status, body).await;
    }
    let path = head.path.split('?').next().unwrap_or("");
    if head.method == "GET" && (path == "/healthz" || path == "/readyz") {
        let ready = {
            // Global order whenever both are held: fences, then targets.
            let state = gateway.fences.read().await;
            let physical = gateway.targets.read().await;
            state.synchronized()
                && physical.synchronized()
                // A writer the kubelet has not reported Ready is recognized only by the Pod
                // watch, and a woken database is published on the attestation alone.
                && physical.pods_synchronized()
                && !gateway.draining.load(Ordering::Acquire)
        };
        return control::reply_text(
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
        return control::reply(
            &mut socket,
            if path == "/pg" { 400 } else { 404 },
            serde_json::json!({"error":"websocket_upgrade_required"}),
        )
        .await;
    }
    let route = head.one("x-pgcf-route");
    // Declared before the lease and both streams, so it is dropped and logged after them.
    let (claims, mut stages) =
        if route.is_some_and(|route| route.starts_with(&format!("{}.", wake::ROUTE_PREFIX))) {
            let ticket = match wake::verify_wake(
                route,
                &gateway.config.keyring.keys,
                &gateway.config.region,
                control::now(),
            ) {
                Ok(ticket) => ticket,
                Err(reason) => return route_denied(&mut socket, reason).await,
            };
            let mut stages = Stages::new(&ticket.db, received);
            match wake_state(&gateway, &ticket).await {
                // Released at its generation already: routed at once, as a running database is.
                WakeState::Released {
                    pod,
                    route_revision,
                    ..
                } => (admitted_wake(&ticket, &pod, route_revision), stages),
                WakeState::Stale => {
                    stages.outcome = "route_stale";
                    return control::reply(
                        &mut socket,
                        503,
                        serde_json::json!({"error":"route_stale"}),
                    )
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
                control::now() as f64,
            ) {
                Ok(claims) => claims,
                Err(reason) => return route_denied(&mut socket, reason).await,
            };
            let stages = Stages::new(&claims.db, received);
            (claims, stages)
        };
    let state = gateway.fences.read().await;
    let epoch = state.bound_epoch(&claims.db);
    if gateway.draining.load(Ordering::Acquire) || !state.admits(&claims.db) {
        drop(state);
        stages.outcome = "fenced";
        return control::reply(&mut socket, 503, serde_json::json!({"error":"fenced"})).await;
    }
    let revision_current = route_revision_current(&state, &claims);
    drop(state);
    let target = match gateway.targets.read().await.target(&claims.db) {
        Ok(target) => target,
        Err(reason) => {
            stages.outcome = "target_unavailable";
            stages.target_reason = Some(reason);
            return control::reply(
                &mut socket,
                503,
                serde_json::json!({"error":"target_unavailable"}),
            )
            .await;
        }
    };
    stages.route = Some(if target.unready { "attested" } else { "ready" });
    if !revision_current
        || !route_target_current(&claims, &target)
        || !admitted_runtime_current(&*gateway.fences.read().await, &claims, &target)
    {
        stages.outcome = "route_stale";
        return control::reply(&mut socket, 503, serde_json::json!({"error":"route_stale"})).await;
    }
    let Some(base) = session_memory(&gateway, &claims.db) else {
        stages.outcome = "memory_capacity";
        return memory_refused(&mut socket, &gateway, &claims.db).await;
    };
    let wire = WireBudget::new(gateway.memory.lease(&claims.db));
    let (session, mut actions) = match gateway.reserve(&claims, wire.clone(), &target, true) {
        Ok(value) => value,
        Err(status) => {
            stages.outcome = "admission_denied";
            return control::reply(
                &mut socket,
                status,
                serde_json::json!({"error":"admission_denied"}),
            )
            .await;
        }
    };
    // The route names the database, the user and the Pod, so nothing the StartupMessage says
    // changes where PostgreSQL is dialled: the dial overlaps the client's own round trips to it
    // (the upgrade, the answer to SSLRequest, the StartupMessage). Not a byte is sent before the
    // StartupMessage has been checked against the route and the fence.
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
    control::reply(
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
    control::reply(
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
/// What the fence shows of a wake ticket.
pub(crate) enum WakeState {
    /// Running at the ticket's generation and operation, with an admission target of that
    /// generation whose Pod is the writer the watches show. Its route revision is the ticket's or
    /// a later one: Cloudflare's own claim of the wake moves the revision on.
    Released {
        pod: String,
        slot: bool,
        route_revision: u64,
    },
    Waiting,
    /// The fence moved past the ticket: another generation or operation, or retirement.
    Stale,
}
pub(crate) async fn wake_state(gateway: &Gateway, ticket: &WakeClaims) -> WakeState {
    // Global order whenever both are held: fences, then targets.
    let state = gateway.fences.read().await;
    let Some(fence) = state.records.get(&ticket.db) else {
        return WakeState::Waiting;
    };
    let intent = &fence.intent;
    let target = fence
        .admission_target
        .as_ref()
        .filter(|target| target.generation == ticket.generation);
    if intent.mode == "retired"
        || intent.revision > ticket.generation
        || (intent.revision == ticket.generation && intent.operation != ticket.op)
        || target.is_some_and(|target| target.route_revision < ticket.route_revision)
    {
        return WakeState::Stale;
    }
    let Some(target) = target.filter(|_| {
        state.synchronized() && intent.mode == "running" && intent.revision == ticket.generation
    }) else {
        return WakeState::Waiting;
    };
    let writer = gateway.targets.read().await.target(&ticket.db);
    match writer {
        Ok(writer) if writer.pod_uid == target.pod_uid => WakeState::Released {
            pod: target.pod_uid.clone(),
            slot: wake::slot_namespace_of_tls_name(&target.tls_server_name).is_some(),
            route_revision: target.route_revision,
        },
        _ => WakeState::Waiting,
    }
}
/// The route a released wake is admitted under: the ticket's connection at its generation, the
/// released Pod, and the route revision of the admission target that released it.
pub(crate) fn admitted_wake(ticket: &WakeClaims, pod: &str, route_revision: u64) -> RouteClaims {
    let mut claims = ticket.admitted(Some(pod));
    claims.route_revision = Some(route_revision);
    claims
}
/// Where a held wake connection stands: released to a writer, ended, or (none) still waiting.
async fn held_state(
    gateway: &Gateway,
    ticket: &WakeClaims,
    held: &Held,
    stop: &watch::Receiver<bool>,
) -> Option<Result<(String, bool, u64), HeldEnd>> {
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
            pod,
            slot,
            route_revision,
        } => Some(Ok((pod, slot, route_revision))),
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
/// A wake ticket (route v5) of a database the fence has not released: the connection is upgraded
/// at once, its StartupMessage is read and held, and its wake is queued for the controller. It is
/// released by the fence that shows the woken writer and then routed as an admitted route; until
/// then not a byte reaches PostgreSQL and nothing is dialled.
async fn serve_held(
    mut socket: TcpStream,
    head: HttpHead,
    gateway: Arc<Gateway>,
    mut stop: watch::Receiver<bool>,
    handshake_permit: OwnedSemaphorePermit,
    ticket: WakeClaims,
    mut stages: Stages,
) -> Result<(), Failure> {
    stages.wake_path = "pool_miss";
    let database = ticket.db.clone();
    if gateway.draining.load(Ordering::Acquire) {
        stages.outcome = "fenced";
        return control::reply(&mut socket, 503, serde_json::json!({"error":"fenced"})).await;
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
        .use_token(&ticket.admitted(None), control::now());
    if let Err(reason) = replay {
        stages.outcome = "admission_denied";
        return control::reply(
            &mut socket,
            replay_status(reason),
            serde_json::json!({"error":"admission_denied"}),
        )
        .await;
    }
    let mut held = match gateway
        .wakes
        .hold(&ticket, control::now(), std::time::Instant::now())
    {
        Ok(held) => held,
        Err(status) => {
            stages.outcome = "wake_capacity";
            return control::reply(
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
    // Until the StartupMessage is read, the read itself is what the wait polls besides the fence
    // and the controller's result: a refusal, the bound or the fence moving on end it as well.
    let read = {
        let read = read_startup(&mut websocket, &route, &gateway, &id, &wire, &mut stages);
        tokio::pin!(read);
        loop {
            let fences_changed = gateway.fences.read().await.changed.clone();
            let fences = fences_changed.notified();
            tokio::pin!(fences);
            fences.as_mut().enable();
            if let Some(Err(end)) = held_state(&gateway, &ticket, &held, &stop).await {
                break Err(Some(end));
            }
            tokio::select! {
                read = read.as_mut() => break read.map_err(|_| None),
                _ = fences.as_mut() => {},
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
        // Armed before the fence is read, so a change between the read and the wait wakes it.
        let fences_changed = gateway.fences.read().await.changed.clone();
        let targets_changed = gateway.targets.read().await.changed.clone();
        let fences = fences_changed.notified();
        let targets = targets_changed.notified();
        tokio::pin!(fences, targets);
        fences.as_mut().enable();
        targets.as_mut().enable();
        if let Some(state) = held_state(&gateway, &ticket, &held, &stop).await {
            break state;
        }
        tokio::select! {
            _ = fences.as_mut() => {},
            _ = targets.as_mut() => {},
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
    let (pod, slot, route_revision) = match released {
        Ok(released) => released,
        Err(end) => {
            end_held(&mut websocket, &mut stages, end).await;
            return Ok(());
        }
    };
    stages.held_outcome = Some("released");
    stages.wake_wait = Some(upgraded.elapsed());
    if slot {
        stages.wake_path = "pool_hit";
    }
    // From here the connection is the admitted route of the woken writer.
    let claims = admitted_wake(&ticket, &pod, route_revision);
    let state = gateway.fences.read().await;
    let epoch = state.bound_epoch(&database);
    let revision_current = state.admits(&database) && route_revision_current(&state, &claims);
    drop(state);
    let target = match gateway.targets.read().await.target(&database) {
        Ok(target) => target,
        Err(reason) => {
            stages.outcome = "target_unavailable";
            stages.target_reason = Some(reason);
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    stages.route = Some(if target.unready { "attested" } else { "ready" });
    if !revision_current
        || target.pod_uid != pod
        || !route_target_current(&claims, &target)
        || !admitted_runtime_current(&*gateway.fences.read().await, &claims, &target)
    {
        stages.outcome = "route_stale";
        let _ = send_error(&mut websocket, "08006", "database connection failed").await;
        return Ok(());
    }
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
/// A route admitted on a writer, with its reserved session and the fence epoch it was admitted at.
struct Admitted<'a> {
    claims: &'a RouteClaims,
    session: &'a SessionLease,
    epoch: (u64, u64),
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
/// Writes the checked StartupMessage to the dialled writer while the fence and the writer still
/// admit it, then relays the session.
async fn run_session(
    websocket: &mut WebSocket,
    mut postgres: TlsStream<TcpStream>,
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
        let state = gateway.fences.read().await;
        if state.bound_epoch(&claims.db) != epoch || !state.admits(&claims.db) {
            stages.outcome = "fenced";
            return Err("startup fenced before first upstream write".into());
        }
        let physical = gateway.targets.read().await;
        if !physical.permits(&claims.db, target) {
            stages.outcome = "target_changed";
            return Err("writer changed before first upstream write".into());
        }
        let written = timeout(WRITE_BOUND, write_upstream(&mut postgres, &initial)).await;
        if !matches!(written, Ok(Ok(()))) {
            stages.outcome = "postgres_error";
        }
        written??;
        stages.written = Some(Instant::now());
        drop(physical);
        drop(state);
        let mut held = None;
        if let Some(password) = password {
            let login = tokio::select! {
                login=timeout(STARTUP_BOUND,auth::login(&mut postgres,&password))=>login.map_err(|_|"startup_timeout").and_then(|login|login.map_err(|_|"postgres_error")),
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
                Ok(Login::Authenticated(answer)) => answer,
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
    // The relay ends PostgreSQL TLS itself only when it returns normally.
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
/// A write is done only when its TLS records reached the socket. Under backpressure tokio-rustls
/// returns from `write_all` with records still queued, which only a later write would send,
/// while the client already waits for PostgreSQL's reply; callers bound both steps together.
pub(crate) async fn write_upstream(
    postgres: &mut TlsStream<TcpStream>,
    bytes: &[u8],
) -> std::io::Result<()> {
    postgres.write_all(bytes).await?;
    postgres.flush().await
}
/// Ends a failed PostgreSQL session with close_notify and FIN within 500 ms, so PostgreSQL
/// sees a clean end of stream instead of an unexpected EOF. A stream with queued TLS records is
/// only dropped: its close_notify would first deliver bytes to a writer that may have changed.
pub(crate) async fn close_upstream(postgres: &mut TlsStream<TcpStream>) {
    if !postgres.get_ref().1.wants_write() {
        let _ = timeout(Duration::from_millis(500), postgres.shutdown()).await;
    }
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
/// once the checked StartupMessage is there, while the fence and the writer still admit it.
async fn dial_started(
    claims: &RouteClaims,
    session: &SessionLease,
    epoch: (u64, u64),
    stages: &mut Stages,
    early: &mut Option<EarlyDial>,
) -> Result<TlsStream<TcpStream>, Failure> {
    let gateway = &*session.gateway;
    let id = &session.id;
    let bound = &session.target;
    let database = &claims.db;
    let state = gateway.fences.read().await;
    if state.bound_epoch(database) != epoch || !state.admits(database) {
        stages.outcome = "fenced";
        return Err("fence changed during startup".into());
    }
    if !admitted_runtime_current(&state, claims, bound) {
        return Err("admitted runtime changed before dial".into());
    }
    let admitted = if claims.v == 4 {
        state
            .records
            .get(database)
            .and_then(|fence| fence.admission_target.clone())
    } else {
        None
    };
    drop(state);
    // The route was checked against this writer; a replacement is never dialled.
    let watched = {
        let physical = gateway.targets.read().await;
        if !physical.permits(database, bound) {
            stages.outcome = "target_changed";
            return Err("writer changed before dial".into());
        }
        physical.ca_material(database)
    };
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(id, false, true, true);
    let target = database_target(database, bound, admitted, watched);
    // The dial that began with the admission is this one if it was for this target; a target that
    // changed since is dialled anew, and the old connection is dropped unused.
    let (dialed, took) = match early.take() {
        Some(early) if early.target == target => early.finish().await,
        other => {
            drop(other);
            let dialing = Instant::now();
            let dialed = gateway.dial.dial(&target).await;
            (dialed, dialing.elapsed())
        }
    };
    stages.dial = Some(took);
    let mut postgres = dialed.inspect_err(|_| stages.outcome = "postgres_connect_error")?;
    let state = gateway.fences.read().await;
    if state.bound_epoch(database) != epoch || !state.admits(database) {
        drop(state);
        stages.outcome = "fenced";
        close_upstream(&mut postgres).await;
        return Err("fence changed during TLS negotiation".into());
    }
    Ok(postgres)
}
/// The StartupMessage, checked against the route, and the writer dialled for it.
async fn startup(
    socket: &mut WebSocket,
    claims: &RouteClaims,
    session: &SessionLease,
    epoch: (u64, u64),
    stages: &mut Stages,
    early: &mut Option<EarlyDial>,
) -> Result<(TlsStream<TcpStream>, Started), Failure> {
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
/// The PostgreSQL a route is dialled at: the Pod it names, under the TLS name and authority the
/// fence admitted for it (a v4 route), or the database's Service name. The watched authority
/// `watched` is dialled with only when it is the admitted one.
pub(crate) fn database_target(
    database: &str,
    bound: &TargetIdentity,
    admitted: Option<crate::kubernetes::AdmissionTarget>,
    watched: Option<Vec<u8>>,
) -> DatabaseTarget {
    let ca = watched
        .filter(|ca| {
            admitted
                .as_ref()
                .is_none_or(|target| sha256_hex(ca) == target.ca_sha256)
        })
        .map(Arc::from);
    DatabaseTarget {
        ca,
        host: admitted
            .as_ref()
            .map(|target| target.tls_server_name.clone())
            .unwrap_or_else(|| format!("database-rw.pgcf-db-{database}.svc")),
        ca_sha256: admitted.map(|target| target.ca_sha256),
        database: database.into(),
        port: 5432,
        address: bound.address,
        pod_uid: bound.pod_uid.clone(),
    }
}
/// A dial of PostgreSQL that began when the route was admitted: the connection is TLS-verified and
/// has had no byte of the client written to it.
struct EarlyDial {
    target: DatabaseTarget,
    task: tokio::task::JoinHandle<(Result<TlsStream<TcpStream>, Failure>, Duration)>,
}
impl EarlyDial {
    /// The connection, or why there is none, and how long the dial itself took.
    async fn finish(mut self) -> (Result<TlsStream<TcpStream>, Failure>, Duration) {
        match (&mut self.task).await {
            Ok(dialed) => dialed,
            Err(_) => (Err("PostgreSQL dial ended".into()), Duration::ZERO),
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
async fn early_dial(
    gateway: &Arc<Gateway>,
    claims: &RouteClaims,
    bound: &TargetIdentity,
) -> Option<EarlyDial> {
    let admitted = if claims.v == 4 {
        gateway
            .fences
            .read()
            .await
            .records
            .get(&claims.db)
            .and_then(|fence| fence.admission_target.clone())
    } else {
        None
    };
    // The route was checked against this writer; a replacement is never dialled.
    let watched = {
        let physical = gateway.targets.read().await;
        if !physical.permits(&claims.db, bound) {
            return None;
        }
        physical.ca_material(&claims.db)
    };
    let target = database_target(&claims.db, bound, admitted, watched);
    let (dialer, wanted) = (gateway.clone(), target.clone());
    Some(EarlyDial {
        target,
        task: tokio::spawn(async move {
            let began = Instant::now();
            let dialed = dialer.dial.dial(&wanted).await;
            (dialed, began.elapsed())
        }),
    })
}
fn certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if matches!(
            error.downcast_ref::<rustls::Error>(),
            Some(rustls::Error::InvalidCertificate(_))
        ) {
            return true;
        }
        current = error.source();
    }
    false
}
/// `held` is what the client sent that waits for the session to run: the bytes it pipelined
/// behind a password the gateway logged in with.
#[allow(clippy::too_many_arguments)]
async fn relay(
    websocket: &mut WebSocket,
    postgres: &mut TlsStream<TcpStream>,
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
        if !gateway.targets.read().await.permits(database, target) {
            stages.outcome = "target_changed";
            close(websocket, CloseCode::Restart, "writer changed").await;
            break;
        }
        let requested = *actions.borrow_and_update();
        let mut mode = current_mode(gateway, database, requested).await;
        if mode == Action::Running
            && let Some((bytes, lease)) = held.take()
        {
            update(gateway, id, activity, true, false);
            if forward_if_running(gateway, database, target, postgres, &bytes, stages).await? {
                drop(lease);
            } else {
                held = Some((bytes, lease));
                mode = current_mode(gateway, database, requested).await;
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
/// A v3 route names the revision Cloudflare admitted; the running fence must still be it.
/// Temporary rollout compatibility: a v2 route names no revision and keeps the fence checks.
pub(crate) fn route_revision_current(state: &FenceState, claims: &RouteClaims) -> bool {
    if claims.v == 4 {
        return claims
            .rev
            .zip(claims.route_revision)
            .is_some_and(|(generation, revision)| {
                state.records.get(&claims.db).is_some_and(|fence| {
                    fence.intent.mode == "running"
                        && fence.intent.revision == generation
                        && fence.admission_target.as_ref().is_some_and(|target| {
                            target.generation == generation
                                && target.route_revision == revision
                                && claims.pod.as_ref() == Some(&target.pod_uid)
                        })
                })
            });
    }
    claims.rev.is_none_or(|revision| {
        state.records.get(&claims.db).is_some_and(|fence| {
            fence.intent.mode == "running" && fence.intent.revision == revision
        })
    })
}
pub(crate) fn admitted_runtime_current(
    state: &FenceState,
    claims: &RouteClaims,
    target: &TargetIdentity,
) -> bool {
    if claims.v != 4 {
        // A legacy route names no admitted runtime, so it cannot vouch for a writer that only the
        // controller's attestation, not the kubelet, has shown to be running.
        return !target.unready;
    }
    route_revision_current(state, claims)
        && state
            .records
            .get(&claims.db)
            .and_then(|fence| fence.admission_target.as_ref())
            .is_some_and(|admitted| {
                target.container_id.as_ref() == Some(&admitted.container_id)
                    && target.ca.as_ref().is_some_and(|ca| {
                        ca.ca_secret_uid == admitted.ca_secret_uid
                            && ca.ca_secret_resource_version == admitted.ca_secret_resource_version
                            && ca.ca_sha256 == admitted.ca_sha256
                    })
            })
}

/// A v3 route names the verified primary Pod; the cached writer must be that Pod. The dial still
/// uses the writer's address and service TLS name.
pub(crate) fn route_target_current(claims: &RouteClaims, target: &TargetIdentity) -> bool {
    match (claims.rev, claims.pod.as_deref()) {
        (Some(_), Some(pod)) => target.pod_uid == pod,
        (None, None) => true,
        _ => false,
    }
}
async fn current_mode(gateway: &Gateway, database: &str, requested: Action) -> Action {
    let state = gateway.fences.read().await;
    match state
        .records
        .get(database)
        .map(|fence| fence.intent.mode.as_str())
    {
        Some("retired") => Action::Retire,
        Some("quiesce") => {
            if matches!(requested, Action::CloseIdle | Action::CloseAuthentication) {
                requested
            } else {
                Action::Quiesce
            }
        }
        _ => Action::Running,
    }
}
async fn forward_if_running(
    gateway: &Gateway,
    database: &str,
    target: &TargetIdentity,
    postgres: &mut TlsStream<TcpStream>,
    bytes: &[u8],
    stages: &mut Stages,
) -> Result<bool, Failure> {
    // Match startup/health ordering while retaining both guards through the bounded write.
    let state = gateway.fences.read().await;
    let physical = gateway.targets.read().await;
    if !physical.permits(database, target) {
        stages.outcome = "target_changed";
        return Err("writer changed".into());
    }
    if !state.synchronized() {
        stages.outcome = "fenced";
        return Err("power authority unavailable".into());
    }
    if state
        .records
        .get(database)
        .is_some_and(|fence| fence.intent.mode != "running")
    {
        return Ok(false);
    }
    // The bounded enqueue and fence publication share this read/write boundary.
    // Bytes already being written stay busy; new bytes cannot cross a published fence.
    let written = timeout(WRITE_BOUND, write_upstream(postgres, bytes)).await;
    if !matches!(written, Ok(Ok(()))) {
        stages.outcome = "postgres_error";
    }
    written??;
    drop(physical);
    drop(state);
    Ok(true)
}
/// TLS verification finishes before the first PostgreSQL StartupMessage,
/// credential or query byte. Unknown writes are never redialed or replayed.
pub async fn negotiate_tls(
    stream: TcpStream,
    hostname: &str,
    ca: &[u8],
) -> Result<TlsStream<TcpStream>, Failure> {
    negotiate(stream, hostname, client_config(ca)?).await
}
/// A client configuration that trusts only the database's TLS authority.
fn client_config(ca: &[u8]) -> Result<Arc<ClientConfig>, Failure> {
    let mut roots = RootCertStore::empty();
    let certificates = CertificateDer::pem_slice_iter(ca).collect::<Result<Vec<_>, _>>()?;
    if certificates.is_empty() {
        return Err("database CA unavailable".into());
    }
    for certificate in certificates {
        roots.add(certificate)?;
    }
    Ok(Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}
async fn negotiate(
    mut stream: TcpStream,
    hostname: &str,
    config: Arc<ClientConfig>,
) -> Result<TlsStream<TcpStream>, Failure> {
    let mut request = Vec::new();
    request.extend_from_slice(&8u32.to_be_bytes());
    request.extend_from_slice(&(constant("SSL_REQUEST_CODE") as u32).to_be_bytes());
    stream.write_all(&request).await?;
    let mut response = [0];
    stream.read_exact(&mut response).await?;
    if response[0] != b'S' {
        return Err("PostgreSQL refused TLS".into());
    }
    Ok(TlsConnector::from(config)
        .connect(ServerName::try_from(hostname.to_string())?, stream)
        .await?)
}
async fn dial_postgres(
    address: std::net::IpAddr,
    host: &str,
    port: u16,
    config: Arc<ClientConfig>,
) -> Result<TlsStream<TcpStream>, Failure> {
    let stream = TcpStream::connect((address, port)).await?;
    stream.set_nodelay(true)?;
    negotiate(stream, host, config).await
}

#[cfg(test)]
mod admission_revision_tests {
    use super::*;
    use crate::kubernetes::{Fence, Intent};
    #[test]
    fn v4_requires_a_persisted_independent_route_revision_at_the_existing_generation() {
        let database = "a".repeat(20);
        let pod = "01234567-89ab-4def-8123-0123456789ab";
        let claims:RouteClaims=serde_json::from_value(serde_json::json!({"v":4,"db":database,"user":"app","cid":pod,"rg":"eu-test","kid":"test","iat":1,"exp":31,"rev":7,"pod":pod,"route_revision":19})).unwrap();
        let mut state = FenceState::default();
        state.records.insert(
            database.clone(),
            Fence {
                uid: pod.into(),
                intent: Intent {
                    database: database.clone(),
                    operation: format!("op_{}", "a".repeat(20)),
                    revision: 7,
                    mode: "running".into(),
                },
                retired_at: None,
                deleting: false,
                admission_target: None,
            },
        );
        assert!(!route_revision_current(&state, &claims));
        let target = serde_json::json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":pod,"container_id":"a".repeat(64),"ca_secret_uid":pod,"ca_secret_resource_version":"81","ca_sha256":"b".repeat(64),"tls_server_name":format!("database-rw.pgcf-db-{database}.svc")});
        state.records.get_mut(&database).unwrap().admission_target =
            Some(serde_json::from_value(target).unwrap());
        assert!(route_revision_current(&state, &claims));
        state
            .records
            .get_mut(&database)
            .unwrap()
            .admission_target
            .as_mut()
            .unwrap()
            .route_revision = 20;
        assert!(!route_revision_current(&state, &claims));
        state
            .records
            .get_mut(&database)
            .unwrap()
            .admission_target
            .as_mut()
            .unwrap()
            .route_revision = 19;
        let mut actual = TargetIdentity {
            address: "10.0.0.7".parse().unwrap(),
            pod_uid: pod.into(),
            node: "customer-us1".into(),
            container_id: None,
            ca: None,
            unready: false,
        };
        assert!(!admitted_runtime_current(&state, &claims, &actual));
        actual.container_id = Some("a".repeat(64));
        actual.ca = Some(crate::targets::CaIdentity {
            ca_secret_uid: pod.into(),
            ca_secret_resource_version: "81".into(),
            ca_sha256: "b".repeat(64),
        });
        assert!(admitted_runtime_current(&state, &claims, &actual));
        actual.ca.as_mut().unwrap().ca_secret_resource_version = "82".into();
        assert!(!admitted_runtime_current(&state, &claims, &actual));
        actual.ca.as_mut().unwrap().ca_secret_resource_version = "81".into();
        actual.container_id = Some("c".repeat(64));
        assert!(!admitted_runtime_current(&state, &claims, &actual));
    }
}

#[cfg(test)]
mod dial_tests {
    use super::*;
    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    fn bound() -> TargetIdentity {
        TargetIdentity {
            address: "10.0.0.7".parse().unwrap(),
            pod_uid: "01234567-89ab-4def-8123-0123456789ab".into(),
            node: "customer-eu1".into(),
            container_id: None,
            ca: None,
            unready: false,
        }
    }
    fn admitted(ca: &[u8]) -> crate::kubernetes::AdmissionTarget {
        let pod = bound().pod_uid;
        serde_json::from_value(serde_json::json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":pod,"container_id":"a".repeat(64),"ca_secret_uid":pod,"ca_secret_resource_version":"81","ca_sha256":sha256_hex(ca),"tls_server_name":"pgcf-slot-0a1b2c3d.svc"})).unwrap()
    }
    #[test]
    fn a_dial_takes_the_watched_ca_only_when_it_is_the_admitted_one() {
        let database = "a".repeat(20);
        let target = database_target(
            &database,
            &bound(),
            Some(admitted(b"ca one")),
            Some(b"ca one".to_vec()),
        );
        assert_eq!(target.ca.as_deref(), Some(b"ca one".as_slice()));
        assert_eq!(target.ca_sha256, Some(sha256_hex(b"ca one")));
        // A watch that moved on never stands in for the admitted authority.
        let target = database_target(
            &database,
            &bound(),
            Some(admitted(b"ca one")),
            Some(b"ca two".to_vec()),
        );
        assert_eq!(target.ca, None);
        assert_eq!(target.ca_sha256, Some(sha256_hex(b"ca one")));
        // A route without an admitted authority dials with the database's watched one.
        let target = database_target(&database, &bound(), None, Some(b"ca two".to_vec()));
        assert_eq!(target.ca.as_deref(), Some(b"ca two".as_slice()));
        assert_eq!(target.ca_sha256, None);
    }
    #[test]
    fn a_tls_configuration_is_built_once_per_database_and_authority() {
        let pem = |name: &str| {
            rcgen::generate_simple_self_signed(vec![name.into()])
                .unwrap()
                .cert
                .pem()
                .into_bytes()
        };
        let (one, two) = (pem("one.svc"), pem("two.svc"));
        let configs = TlsConfigs::default();
        let first = configs.get("a", &one).unwrap();
        assert!(Arc::ptr_eq(&first, &configs.get("a", &one).unwrap()));
        let other = configs.get("b", &one).unwrap();
        assert!(!Arc::ptr_eq(&first, &other));
        // A database's new authority replaces its old configuration.
        let renewed = configs.get("a", &two).unwrap();
        assert!(!Arc::ptr_eq(&first, &renewed));
        assert_eq!(configs.len(), 2);
        assert!(configs.get("a", b"no certificate").is_err());
    }
}
