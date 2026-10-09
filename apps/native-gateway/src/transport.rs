// SPDX-License-Identifier: Apache-2.0
use crate::{
    budget::{BudgetedStream, Lease, MAX_FRAME_BYTES, MAX_PAYLOAD_BYTES, MemoryBudget, WireBudget},
    control::{self, Control, HttpHead},
    kubernetes::{FenceState, Kubernetes},
    sessions::{Action, Sessions, SharedSessions},
    targets::{TargetIdentity, Targets},
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
        let control = Control::new(
            config.clone(),
            pod,
            fences.clone(),
            sessions.clone(),
            measurements.clone(),
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
        let actions = self
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), claims.db.clone(), wire);
        admission.total += 1;
        *admission.counts.entry(claims.db.clone()).or_default() += 1;
        Ok((
            SessionLease {
                gateway: self.clone(),
                database: claims.db.clone(),
                id,
                target: target.clone(),
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
    let head = match timeout(Duration::from_secs(10), control::read_head(&mut socket)).await {
        Ok(Ok(head)) => head,
        _ => return control::reply_text(&mut socket, 400, "Bad Request\n").await,
    };
    if let Some((status, body)) = gateway.control.handle(&head).await {
        return control::reply(&mut socket, status, body).await;
    }
    let path = head.path.split('?').next().unwrap_or("");
    if head.method == "GET" && (path == "/healthz" || path == "/readyz") {
        let ready = gateway.fences.read().await.synchronized()
            && gateway.targets.read().await.synchronized()
            && !gateway.draining.load(Ordering::Acquire);
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
    let state = gateway.fences.read().await;
    let epoch = state.bound_epoch(&claims.db);
    if gateway.draining.load(Ordering::Acquire) || !state.admits(&claims.db) {
        drop(state);
        return control::reply(&mut socket, 503, serde_json::json!({"error":"fenced"})).await;
    }
    drop(state);
    let target = match gateway
        .targets
        .read()
        .await
        .target(&claims.db, control::now())
    {
        Ok(target) => target,
        Err(_) => {
            return control::reply(
                &mut socket,
                503,
                serde_json::json!({"error":"target_unavailable"}),
            )
            .await;
        }
    };
    let mut base = gateway.memory.lease(&claims.db);
    if !base.grow(SESSION_MEMORY_BYTES) {
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
    let mut websocket = timeout(
        Duration::from_secs(10),
        accept_async_with_config(stream, Some(config)),
    )
    .await??;
    drop(handshake_permit);
    let result = tokio::select! {
        result=timeout(Duration::from_secs(10),startup(&mut websocket,&claims,&gateway,&id,&wire,epoch,&target))=>result.map_err(|_|"startup timeout".into()).and_then(|v|v),
        _=stop.changed()=>Err("gateway draining".into()),
        _=actions.changed()=>Err("startup fenced".into()),
    };
    let (mut postgres, initial, initial_leases, rest) = match result {
        Ok(value) => value,
        Err(_) => {
            let _ = send_error(&mut websocket, "08006", "database connection failed").await;
            return Ok(());
        }
    };
    let mut activity = PostgresActivity::new();
    activity.observe_frontend(&rest);
    update(&gateway, &id, &activity, true, false);
    let state = gateway.fences.read().await;
    if state.bound_epoch(&claims.db) != epoch
        || !state.admits(&claims.db)
        || !target_revision_matches(&state, &claims.db, &target)
    {
        return Err("startup fenced before first upstream write".into());
    }
    let physical = gateway.targets.read().await;
    if !physical.permits(&claims.db, &target, control::now()) {
        return Err("storage or target changed before first upstream write".into());
    }
    let budget = physical.write_budget(&claims.db, control::now());
    if budget.is_zero() {
        return Err("physical write authority expired before startup enqueue".into());
    }
    timeout(budget, postgres.write_all(&initial)).await??;
    drop(physical);
    drop(state);
    drop(initial_leases);
    wire.allow_relay();
    relay(
        &mut websocket,
        &mut postgres,
        &session,
        &wire,
        &mut activity,
        &mut actions,
        &mut stop,
    )
    .await
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
async fn startup(
    socket: &mut WebSocket,
    claims: &RouteClaims,
    gateway: &Gateway,
    id: &str,
    wire: &WireBudget,
    epoch: (u64, u64),
    bound: &TargetIdentity,
) -> Result<(TlsStream<TcpStream>, Vec<u8>, Vec<Lease>, Vec<u8>), Failure> {
    let mut reader = StartupReader::default();
    let mut leases = Vec::new();
    loop {
        let bytes = match socket.next().await {
            Some(Ok(Message::Binary(bytes))) => {
                leases.push(wire.take_message()?);
                bytes
            }
            Some(Ok(Message::Ping(value))) => {
                socket.send(Message::Pong(value)).await?;
                continue;
            }
            Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Text(_))) => {
                let _ = wire.take_message()?;
                close(socket, CloseCode::Unsupported, "binary frames required").await;
                return Err("text startup".into());
            }
            _ => return Err("startup closed".into()),
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
                    socket.send(Message::Binary(vec![b'N'].into())).await?;
                    gateway.measurements.lock().unwrap().egress(id, 1);
                    event = reader.push(&[]);
                }
                Event::Cancel => {
                    close(socket, CloseCode::Normal, "cancel unsupported").await;
                    return Err("cancel unsupported".into());
                }
                Event::Error { sqlstate, message } => {
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
                    if database != claims.db || user != claims.user {
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
                        return Err("fence changed during startup".into());
                    }
                    drop(state);
                    gateway
                        .sessions
                        .lock()
                        .unwrap()
                        .update(id, false, true, true);
                    let target = DatabaseTarget {
                        host: format!("database-rw.pgcf-db-{database}.svc"),
                        database: database.clone(),
                        port: 5432,
                        address: bound.address,
                        pod_uid: bound.pod_uid.clone(),
                    };
                    let postgres = gateway.dial.dial(&target).await?;
                    let state = gateway.fences.read().await;
                    if state.bound_epoch(&database) != epoch
                        || !state.admits(&database)
                        || !target_revision_matches(&state, &database, bound)
                    {
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
    wire: &WireBudget,
    activity: &mut PostgresActivity,
    actions: &mut watch::Receiver<Action>,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), Failure> {
    let gateway = &*session.gateway;
    let id = &session.id;
    let target = &session.target;
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
            if forward_if_running(gateway, database, target, postgres, &bytes).await? {
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
            close(websocket, CloseCode::Restart, "authentication interrupted").await;
            break;
        }
        if mode == Action::CloseIdle {
            if !activity.busy() && !wire.busy() && held.is_none() {
                close(websocket, CloseCode::Normal, "database sleeping").await;
                break;
            }
            mode = Action::Quiesce;
        }
        let deadline =
            drain_at.unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 3600));
        tokio::select! {
            _=stop.changed()=>{if *stop.borrow(){drain_at=Some(Instant::now()+Duration::from_secs(29));}},
            _=tokio::time::sleep_until(tokio::time::Instant::from_std(deadline))=>{close(websocket,CloseCode::Restart,"gateway restarting").await;break;},
            _=actions.changed()=>{},
            _=physical_timer.tick()=>{},
            _=heartbeat.tick(),if mode==Action::Running=>{if !alive{break;}alive=false;timeout(Duration::from_secs(10),websocket.send(Message::Ping(Vec::new().into()))).await??;},
            message=websocket.next(),if held.is_none()||mode==Action::Retire=>{
                match message{
                    Some(Ok(Message::Binary(bytes)))=>{
                        let lease=wire.take_message()?;{let mut metrics=gateway.measurements.lock().unwrap();metrics.ingress(id,bytes.len());if !bytes.is_empty(){metrics.client_activity(id);}}
                        activity.observe_frontend(&bytes);update(gateway,id,activity,true,false);
                        if held.is_some(){close(websocket,CloseCode::Restart,"database retired").await;break;}
                        if forward_if_running(gateway,database,target,postgres,&bytes).await?{drop(lease);}
                        else{held=Some((bytes.to_vec(),lease));}
                    },
                    Some(Ok(Message::Pong(_)))=>alive=true,
                    Some(Ok(Message::Ping(value)))=>{timeout(Duration::from_secs(10),websocket.send(Message::Pong(value))).await??;},
                    Some(Ok(Message::Text(_)))=>{let _=wire.take_message()?;close(websocket,CloseCode::Unsupported,"binary frames required").await;break;},
                    Some(Ok(Message::Close(_)))|None=>break,
                    Some(Err(_))=>{close(websocket,CloseCode::Again,"relay buffer or connection failed").await;break;},
                    _=>{},
                }
            },
            result=postgres.read(&mut read)=>{
                let length=result?;if length==0{break;}activity.observe_backend(&read[..length]);
                {let mut metrics=gateway.measurements.lock().unwrap();if activity.authenticated(){metrics.authenticate(id);}metrics.egress(id,length);}
                update(gateway,id,activity,true,false);timeout(Duration::from_secs(10),websocket.send(Message::Binary(read[..length].to_vec().into()))).await??;
            }
        }
    }
    let _ = timeout(Duration::from_millis(500), websocket.close(None)).await;
    let _ = timeout(Duration::from_millis(500), postgres.shutdown()).await;
    Ok(())
}
fn target_revision_matches(state: &FenceState, database: &str, target: &TargetIdentity) -> bool {
    target.storage.as_ref().is_none_or(|binding| {
        state
            .records
            .get(database)
            .is_some_and(|fence| fence.intent.revision == binding.generation)
    })
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
) -> Result<bool, Failure> {
    let physical = gateway.targets.read().await;
    if !physical.permits(database, target, control::now()) {
        return Err("physical write authority or writer changed".into());
    }
    let state = gateway.fences.read().await;
    if !state.synchronized() {
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
        return Err("storage generation changed".into());
    }
    // The bounded enqueue and fence publication share this read/write boundary.
    // Bytes already being written stay busy; new bytes cannot cross a published fence.
    let budget = physical.write_budget(database, control::now());
    if budget.is_zero() {
        return Err("physical write authority expired before frontend enqueue".into());
    }
    timeout(budget, postgres.write_all(bytes)).await??;
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
