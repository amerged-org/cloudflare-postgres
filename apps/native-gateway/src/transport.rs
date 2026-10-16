// SPDX-License-Identifier: Apache-2.0
use crate::{
    budget::{BudgetedStream, Lease, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, MemoryBudget, WireBudget},
    control::{self, Control, HttpHead},
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
type Failure = Box<dyn std::error::Error + Send + Sync>;
type WebSocket = WebSocketStream<BudgetedStream>;
pub const SESSION_MEMORY_BYTES: usize = 2 * MAX_FRAME_BYTES + 16 * 1024;
/// The time a connection has to send its StartupMessage and have its writer dialled.
pub const STARTUP_BOUND: Duration = Duration::from_secs(10);
pub struct Config {
    pub region: String,
    pub keyring: Keyring,
    pub maximum_memory: usize,
    pub database_memory: usize,
}
struct Admission {
    replay: ReplayCache,
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
pub struct DatabaseTarget {
    pub database: String,
    pub host: String,
    pub port: u16,
    pub address: std::net::IpAddr,
    pub pod_uid: String,
    pub ca_sha256: Option<String>,
}
pub trait PostgresDial: Send + Sync {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>>;
}
pub struct ClusterPostgresDial(pub Arc<Kubernetes>);
impl PostgresDial for ClusterPostgresDial {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>> {
        Box::pin(async move {
            for attempt in 0..2 {
                let ca = self.0.database_ca(&target.database, attempt == 1).await?;
                if target.ca_sha256.as_ref().is_some_and(|expected| {
                    Sha256::digest(&ca)
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                        != *expected
                }) {
                    if attempt == 0 {
                        continue;
                    }
                    return Err("admitted TLS authority changed".into());
                }
                match dial_postgres(target.address, &target.host, target.port, &ca).await {
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
pub struct Gateway {
    pub config: Arc<Config>,
    pub dial: Arc<dyn PostgresDial>,
    pub fences: Arc<RwLock<FenceState>>,
    pub targets: Arc<RwLock<Targets>>,
    pub sessions: SharedSessions,
    pub measurements: Arc<Mutex<GatewayMeasurements>>,
    pub control: Control,
    pub draining: AtomicBool,
    admission: Mutex<Admission>,
    memory: Arc<MemoryBudget>,
}
impl Gateway {
    pub fn new(config: Arc<Config>, pod: String, dial: Arc<dyn PostgresDial>) -> Arc<Self> {
        let fences = Arc::new(RwLock::new(FenceState::default()));
        let sessions = Arc::new(Mutex::new(Sessions::default()));
        let measurements = Arc::new(Mutex::new(GatewayMeasurements::new()));
        let targets = Arc::new(RwLock::new(Targets::default()));
        let control = Control::new(
            config.clone(),
            pod,
            fences.clone(),
            targets.clone(),
            sessions.clone(),
            measurements.clone(),
        );
        Arc::new(Self {
            memory: MemoryBudget::new(config.maximum_memory, config.database_memory),
            config,
            dial,
            fences,
            targets,
            sessions,
            measurements,
            control,
            draining: AtomicBool::new(false),
            admission: Mutex::new(Admission::default()),
        })
    }
    fn reserve(
        self: &Arc<Self>,
        claims: &RouteClaims,
        wire: WireBudget,
        target: &TargetIdentity,
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
        admission
            .replay
            .use_token(claims, control::now())
            .map_err(|reason| if reason == "replayed" { 403u16 } else { 429u16 })?;
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
struct SessionLease {
    gateway: Arc<Gateway>,
    database: String,
    id: String,
    target: TargetIdentity,
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
/// Monotonic stage marks of one routed connection, logged once as `conn_stages` when it is
/// dropped. The outcome is a fixed class; roles, addresses, tokens and payloads are never logged.
struct Stages {
    database: String,
    outcome: &'static str,
    target_reason: Option<TargetUnavailable>,
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
        let mut observation = serde_json::json!({"event":"conn_stages","database":self.database,"outcome":self.outcome,"upgrade_ms":between(Some(self.received),self.accepted),"startup_ms":between(self.accepted,self.startup),"dial_ms":self.dial.map(ms),"first_backend_ms":between(self.written,self.first_backend),"session_ms":ms(self.received.elapsed())});
        if let Some(reason) = self.target_reason {
            observation["target_reason"] = reason.code().into();
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
    let head = match timeout(Duration::from_secs(10), control::read_head(&mut socket)).await {
        Ok(Ok(head)) => head,
        _ => return control::reply_text(&mut socket, 400, "Bad Request\n").await,
    };
    if let Some((status, body)) = gateway.control.handle(&head).await {
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
    if !upgrade(&head) {
        return control::reply(
            &mut socket,
            if path == "/pg" { 400 } else { 404 },
            serde_json::json!({"error":"websocket_upgrade_required"}),
        )
        .await;
    }
    let claims = match verify(
        head.one("x-pgcf-route"),
        &gateway.config.keyring.keys,
        &gateway.config.region,
        control::now() as f64,
    ) {
        Ok(claims) => claims,
        Err(reason) => {
            return control::reply(
                &mut socket,
                if reason == "wrong_region" { 403 } else { 401 },
                serde_json::json!({"error":"route_denied"}),
            )
            .await;
        }
    };
    // Declared before the lease and both streams, so it is dropped and logged after them.
    let mut stages = Stages::new(&claims.db, received);
    let state = gateway.fences.read().await;
    let epoch = state.bound_epoch(&claims.db);
    if gateway.draining.load(Ordering::Acquire) || !state.admits(&claims.db) {
        drop(state);
        stages.outcome = "fenced";
        return control::reply(&mut socket, 503, serde_json::json!({"error":"fenced"})).await;
    }
    let revision_current = route_revision_current(&state, &claims);
    drop(state);
    let target = match gateway
        .targets
        .read()
        .await
        .target(&claims.db, control::now())
    {
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
    if !revision_current
        || !route_target_current(&claims, &target)
        || !admitted_runtime_current(&*gateway.fences.read().await, &claims, &target)
    {
        stages.outcome = "route_stale";
        return control::reply(&mut socket, 503, serde_json::json!({"error":"route_stale"})).await;
    }
    let mut base = gateway.memory.lease(&claims.db);
    if !base.grow(SESSION_MEMORY_BYTES) {
        stages.outcome = "memory_capacity";
        return control::reply(
            &mut socket,
            if gateway.memory.database_used(&claims.db) + SESSION_MEMORY_BYTES
                > gateway.config.database_memory
            {
                429
            } else {
                503
            },
            serde_json::json!({"error":"memory_capacity"}),
        )
        .await;
    }
    let wire = WireBudget::new(gateway.memory.lease(&claims.db));
    let (lease, mut actions) = match gateway.reserve(&claims, wire.clone(), &target) {
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
    let id = lease.id.clone();
    let session = lease;
    let stream = BudgetedStream::new(socket, head.prefix, head.end, wire.clone(), base);
    let config = WebSocketConfig::default()
        .read_buffer_size(4096)
        .write_buffer_size(4096)
        .max_write_buffer_size(MAX_FRAME_BYTES * 2)
        .max_frame_size(Some(MAX_PAYLOAD_BYTES))
        .max_message_size(Some(MAX_PAYLOAD_BYTES));
    let accepted = timeout(
        Duration::from_secs(10),
        accept_async_with_config(stream, Some(config)),
    )
    .await;
    if !matches!(accepted, Ok(Ok(_))) {
        stages.outcome = "upgrade_failed";
    }
    let mut websocket = accepted??;
    stages.accepted = Some(Instant::now());
    drop(handshake_permit);
    let result = tokio::select! {
        result=timeout(STARTUP_BOUND,startup(&mut websocket,&claims,&session,epoch,&mut stages))=>result.unwrap_or_else(|_|{stages.outcome="startup_timeout";Err("startup timeout".into())}),
        _=stop.changed()=>{stages.outcome="gateway_draining";Err("gateway draining".into())},
        _=actions.changed()=>{stages.outcome="fenced";Err("startup fenced".into())},
    };
    let (mut postgres, initial, initial_leases, rest) = match result {
        Ok(value) => value,
        Err(_) => {
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    let result = async {
        let mut activity = PostgresActivity::new();
        activity.observe_frontend(&rest);
        update(&gateway, &id, &activity, true, false);
        let state = gateway.fences.read().await;
        if state.bound_epoch(&claims.db) != epoch
            || !state.admits(&claims.db)
            || !target_revision_matches(&state, &claims.db, &target)
        {
            stages.outcome = "fenced";
            return Err("startup fenced before first upstream write".into());
        }
        let physical = gateway.targets.read().await;
        if !physical.permits(&claims.db, &target, control::now()) {
            stages.outcome = "target_changed";
            return Err("storage or target changed before first upstream write".into());
        }
        let budget = physical.write_budget(&claims.db, control::now());
        if budget.is_zero() {
            stages.outcome = "write_authority_expired";
            return Err("physical write authority expired before startup enqueue".into());
        }
        let written = timeout(budget, write_upstream(&mut postgres, &initial)).await;
        if !matches!(written, Ok(Ok(()))) {
            stages.outcome = "postgres_error";
        }
        written??;
        stages.written = Some(Instant::now());
        drop(physical);
        drop(state);
        drop(initial_leases);
        wire.allow_relay();
        relay(
            &mut websocket,
            &mut postgres,
            &session,
            &mut activity,
            &mut actions,
            &mut stop,
            &mut stages,
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
async fn write_upstream(postgres: &mut TlsStream<TcpStream>, bytes: &[u8]) -> std::io::Result<()> {
    postgres.write_all(bytes).await?;
    postgres.flush().await
}
/// Ends a failed PostgreSQL session with close_notify and FIN within 500 ms, so PostgreSQL
/// sees a clean end of stream instead of an unexpected EOF. A stream with queued TLS records is
/// only dropped: its close_notify would first deliver bytes whose write authority may have ended.
async fn close_upstream(postgres: &mut TlsStream<TcpStream>) {
    if !postgres.get_ref().1.wants_write() {
        let _ = timeout(Duration::from_millis(500), postgres.shutdown()).await;
    }
}
async fn startup(
    socket: &mut WebSocket,
    claims: &RouteClaims,
    session: &SessionLease,
    epoch: (u64, u64),
    stages: &mut Stages,
) -> Result<(TlsStream<TcpStream>, Vec<u8>, Vec<Lease>, Vec<u8>), Failure> {
    let gateway = &*session.gateway;
    let id = &session.id;
    let wire = &session.wire;
    let bound = &session.target;
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
                    mut raw,
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
                    let state = gateway.fences.read().await;
                    if state.bound_epoch(&database) != epoch
                        || !state.admits(&database)
                        || !target_revision_matches(&state, &database, bound)
                    {
                        stages.outcome = "fenced";
                        return Err("fence changed during startup".into());
                    }
                    if !admitted_runtime_current(&state, claims, bound) {
                        return Err("admitted runtime changed before dial".into());
                    }
                    let admitted = if claims.v == 4 {
                        state
                            .records
                            .get(&database)
                            .and_then(|fence| fence.admission_target.clone())
                    } else {
                        None
                    };
                    drop(state);
                    // The route was checked against this writer; a replacement is never dialled.
                    if !gateway
                        .targets
                        .read()
                        .await
                        .permits(&database, bound, control::now())
                    {
                        stages.outcome = "target_changed";
                        return Err("writer changed before dial".into());
                    }
                    gateway
                        .sessions
                        .lock()
                        .unwrap()
                        .update(id, false, true, true);
                    let target = DatabaseTarget {
                        host: admitted
                            .as_ref()
                            .map(|target| target.tls_server_name.clone())
                            .unwrap_or_else(|| format!("database-rw.pgcf-db-{database}.svc")),
                        ca_sha256: admitted.map(|target| target.ca_sha256),
                        database: database.clone(),
                        port: 5432,
                        address: bound.address,
                        pod_uid: bound.pod_uid.clone(),
                    };
                    let dialing = Instant::now();
                    let dialed = gateway.dial.dial(&target).await;
                    stages.dial = Some(dialing.elapsed());
                    let mut postgres =
                        dialed.inspect_err(|_| stages.outcome = "postgres_connect_error")?;
                    let state = gateway.fences.read().await;
                    if state.bound_epoch(&database) != epoch
                        || !state.admits(&database)
                        || !target_revision_matches(&state, &database, bound)
                    {
                        drop(state);
                        stages.outcome = "fenced";
                        close_upstream(&mut postgres).await;
                        return Err("fence changed during TLS negotiation".into());
                    }
                    raw.extend_from_slice(&rest);
                    return Ok((postgres, raw, leases, rest));
                }
            }
        }
    }
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
async fn relay(
    websocket: &mut WebSocket,
    postgres: &mut TlsStream<TcpStream>,
    session: &SessionLease,
    activity: &mut PostgresActivity,
    actions: &mut watch::Receiver<Action>,
    stop: &mut watch::Receiver<bool>,
    stages: &mut Stages,
) -> Result<(), Failure> {
    let gateway = &*session.gateway;
    let id = &session.id;
    let target = &session.target;
    let wire = &session.wire;
    let mut read = vec![0u8; MAX_FRAME_BYTES];
    let mut held: Option<(Vec<u8>, Lease)> = None;
    let mut alive = true;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut drain_at = None;
    let mut physical_timer = tokio::time::interval(Duration::from_millis(100));
    let database = id.split_once('/').expect("bound session identity").0;
    update(gateway, id, activity, false, false);
    loop {
        if !gateway
            .targets
            .read()
            .await
            .permits(database, target, control::now())
        {
            stages.outcome = "target_changed";
            close(
                websocket,
                CloseCode::Restart,
                "physical write authority or writer changed",
            )
            .await;
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
                        else{held=Some((bytes.to_vec(),lease));}
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
fn route_revision_current(state: &FenceState, claims: &RouteClaims) -> bool {
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
fn admitted_runtime_current(
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
                    && target.pool.as_ref().is_none_or(|pool| {
                        admitted.generation == pool.generation
                            && admitted.admission_epoch >= pool.admission_epoch
                            && admitted.route_revision >= pool.route_revision
                    })
                    && target.ca.as_ref().is_some_and(|ca| {
                        ca.ca_secret_uid == admitted.ca_secret_uid
                            && ca.ca_secret_resource_version == admitted.ca_secret_resource_version
                            && ca.ca_sha256 == admitted.ca_sha256
                    })
            })
}

/// A v3 route names the verified primary Pod; the cached writer and any storage binding must
/// be that Pod at that revision. The dial still uses the writer's address and service TLS name.
fn route_target_current(claims: &RouteClaims, target: &TargetIdentity) -> bool {
    match (&target.pool, claims.kind.as_deref()) {
        (Some(pool), Some("pool")) => {
            return claims.v == 4
                && claims.rev == Some(pool.generation)
                && claims.pod.as_deref() == Some(target.pod_uid.as_str())
                && claims.binding_id.as_deref() == Some(pool.binding_id.as_str())
                && claims.node_uid.as_deref() == Some(pool.node_uid.as_str())
                && claims
                    .pod_ip
                    .as_ref()
                    .and_then(|value| value.parse::<std::net::IpAddr>().ok())
                    == Some(target.address)
                && claims.storage_generation == Some(pool.storage_generation)
                && claims.scope_sha256.as_deref() == Some(pool.scope_sha256.as_str());
        }
        (None, None) => {}
        _ => return false,
    }
    match (claims.rev, claims.pod.as_deref()) {
        (Some(revision), Some(pod)) => {
            target.pod_uid == pod
                && target
                    .storage
                    .as_ref()
                    .is_none_or(|binding| binding.pod_uid == pod && binding.generation == revision)
        }
        (None, None) => true,
        _ => false,
    }
}
fn target_revision_matches(state: &FenceState, database: &str, target: &TargetIdentity) -> bool {
    target.pool.as_ref().is_none_or(|pool| {
        state
            .records
            .get(database)
            .is_some_and(|fence| fence.intent.revision == pool.generation)
    }) && target.storage.as_ref().is_none_or(|binding| {
        state
            .records
            .get(database)
            .is_some_and(|fence| fence.intent.revision == binding.generation)
    })
}
async fn current_mode(gateway: &Gateway, database: &str, requested: Action) -> Action {
    let state = gateway.fences.read().await;
    let intent = state
        .records
        .get(database)
        .map(|fence| fence.intent.clone());
    drop(state);
    match intent.as_ref().map(|intent| intent.mode.as_str()) {
        Some("retired") => Action::Retire,
        Some("quiesce") => {
            if matches!(requested, Action::CloseIdle | Action::CloseAuthentication) {
                requested
            } else {
                Action::Quiesce
            }
        }
        Some("running")
            if requested == Action::CloseIdle
                && gateway.targets.read().await.running_pool_close_permitted(
                    database,
                    &intent.as_ref().unwrap().operation,
                    intent.as_ref().unwrap().revision,
                    control::now(),
                ) =>
        {
            Action::CloseIdle
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
    if !physical.permits(database, target, control::now()) {
        stages.outcome = "target_changed";
        return Err("physical write authority or writer changed".into());
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
    if physical
        .storage_generation(database)
        .is_some_and(|generation| {
            state
                .records
                .get(database)
                .is_none_or(|fence| fence.intent.revision != generation)
        })
    {
        stages.outcome = "target_changed";
        return Err("storage generation changed".into());
    }
    // The bounded enqueue and fence publication share this read/write boundary.
    // Bytes already being written stay busy; new bytes cannot cross a published fence.
    let budget = physical.write_budget(database, control::now());
    if budget.is_zero() {
        stages.outcome = "write_authority_expired";
        return Err("physical write authority expired before frontend enqueue".into());
    }
    let written = timeout(budget, write_upstream(postgres, bytes)).await;
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
    mut stream: TcpStream,
    hostname: &str,
    ca: &[u8],
) -> Result<TlsStream<TcpStream>, Failure> {
    let mut roots = RootCertStore::empty();
    let certificates = CertificateDer::pem_slice_iter(ca).collect::<Result<Vec<_>, _>>()?;
    if certificates.is_empty() {
        return Err("database CA unavailable".into());
    }
    for certificate in certificates {
        roots.add(certificate)?;
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let mut request = Vec::new();
    request.extend_from_slice(&8u32.to_be_bytes());
    request.extend_from_slice(&(constant("SSL_REQUEST_CODE") as u32).to_be_bytes());
    stream.write_all(&request).await?;
    let mut response = [0];
    stream.read_exact(&mut response).await?;
    if response[0] != b'S' {
        return Err("PostgreSQL refused TLS".into());
    }
    Ok(TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from(hostname.to_string())?, stream)
        .await?)
}
async fn dial_postgres(
    address: std::net::IpAddr,
    host: &str,
    port: u16,
    ca: &[u8],
) -> Result<TlsStream<TcpStream>, Failure> {
    let stream = TcpStream::connect((address, port)).await?;
    stream.set_nodelay(true)?;
    negotiate_tls(stream, host, ca).await
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
            storage: None,
            container_id: None,
            ca: None,
            pool: None,
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
    #[test]
    fn pool_route_binds_scope_and_the_fresh_admission_revision_after_ca_refresh() {
        let pod = "01234567-89ab-4def-8123-0123456789ab";
        let database = "a".repeat(20);
        let mut claims:RouteClaims=serde_json::from_value(serde_json::json!({"v":4,"db":database,"user":"app","cid":pod,"rg":"eu-test","kid":"test","iat":1,"exp":31,"rev":7,"pod":pod,"route_revision":19,"kind":"pool","binding_id":pod,"node_uid":pod,"pod_ip":"10.0.0.7","storage_generation":1,"scope_sha256":"c".repeat(64)})).unwrap();
        let target = TargetIdentity {
            address: "10.0.0.7".parse().unwrap(),
            pod_uid: pod.into(),
            node: "pool-node".into(),
            storage: None,
            container_id: Some("a".repeat(64)),
            ca: Some(crate::targets::CaIdentity {
                ca_secret_uid: pod.into(),
                ca_secret_resource_version: "81".into(),
                ca_sha256: "b".repeat(64),
            }),
            pool: Some(crate::targets::PoolIdentity {
                binding_id: pod.into(),
                node_uid: pod.into(),
                boot_id: pod.into(),
                scope_sha256: "c".repeat(64),
                storage_generation: 1,
                generation: 7,
                admission_epoch: 11,
                route_revision: 19,
            }),
            unready: false,
        };
        let mut state = FenceState::default();
        let admitted=serde_json::from_value(serde_json::json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":pod,"container_id":"a".repeat(64),"ca_secret_uid":pod,"ca_secret_resource_version":"81","ca_sha256":"b".repeat(64),"tls_server_name":format!("database-rw.pgcf-db-{database}.svc")})).unwrap();
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
                admission_target: Some(admitted),
            },
        );
        assert!(
            route_target_current(&claims, &target)
                && admitted_runtime_current(&state, &claims, &target)
        );
        // A same-binding CA refresh advances current routing; the original immutable holder stays19.
        let admitted = state
            .records
            .get_mut(&database)
            .unwrap()
            .admission_target
            .as_mut()
            .unwrap();
        admitted.route_revision = 20;
        admitted.admission_epoch = 12;
        admitted.ca_secret_resource_version = "82".into();
        admitted.ca_sha256 = "d".repeat(64);
        assert!(!admitted_runtime_current(&state, &claims, &target));
        claims.route_revision = Some(20);
        let mut fresh = target.clone();
        fresh.ca.as_mut().unwrap().ca_secret_resource_version = "82".into();
        fresh.ca.as_mut().unwrap().ca_sha256 = "d".repeat(64);
        assert!(
            route_target_current(&claims, &fresh)
                && admitted_runtime_current(&state, &claims, &fresh)
        );
        claims.binding_id = Some("11111111-1111-4111-8111-111111111111".into());
        assert!(!route_target_current(&claims, &fresh));
        claims.binding_id = Some(pod.into());
        claims.kind = None;
        assert!(!route_target_current(&claims, &fresh));
        claims.kind = Some("pool".into());
        let mut cnpg = fresh.clone();
        cnpg.pool = None;
        assert!(!route_target_current(&claims, &cnpg));
        state
            .records
            .get_mut(&database)
            .unwrap()
            .admission_target
            .as_mut()
            .unwrap()
            .admission_epoch = 10;
        assert!(!admitted_runtime_current(&state, &claims, &fresh));
    }
}
