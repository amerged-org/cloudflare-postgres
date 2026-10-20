// SPDX-License-Identifier: Apache-2.0
//! HTTP SQL: `POST /sql`, the HTTP query mode of the Neon serverless driver (`neon()`). The Edge
//! admits each request as it admits a WebSocket connection and forwards it with a route token;
//! the gateway answers it on a pooled PostgreSQL session of the route's database and role, in the
//! driver's wire format (raw text values, rows as arrays).
//!
//! The gateway authenticates that session with the client's password through the SCRAM client
//! of the WebSocket login ([`auth::login`]). The password is held in memory only for the request,
//! zeroized after use, and never logged or stored; a pooled session keeps only its SCRAM verifier
//! (salt, iterations, StoredKey) and is reused for a request only when the request's password
//! derives the same StoredKey. A session PostgreSQL did not challenge is not pooled. A pooled session
//! carries no session state between requests (`DISCARD ALL`), waits at most [`IDLE`] for its next
//! request and is retired [`LIFETIME`] after it authenticated, which bounds how long a rotated
//! password is still accepted. It counts as an idle gateway session, so a sleeping database
//! closes it like any other idle connection.
//!
//! Statement bytes that reached PostgreSQL are never sent again: a session lost before
//! PostgreSQL's answer answers SQLSTATE 08007 (outcome unknown) and is closed.
//!
//! The answer is serialized as PostgreSQL's messages arrive, into one buffer whose capacity is
//! leased from the database's memory budget: what is counted is what the gateway holds.
use crate::{
    auth::{self, Login, Password, Salted, Verifier},
    budget::{Lease, WireBudget},
    http::{self, HttpHead},
    local,
    sessions::{self, Action},
    transport::{self, Blocked, Gateway, SessionLease, WakeState},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::{
    agent::Writer,
    route::{Route, verify},
    wake::{self, Outcome, WakeClaims},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixStream},
    sync::{OwnedSemaphorePermit, oneshot, watch},
    time::timeout,
};
use zeroize::Zeroizing;
type Failure = Box<dyn std::error::Error + Send + Sync>;
pub const PATH: &str = "/sql";
/// The largest request body; the Edge refuses a larger one first.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// The largest answer, counted as its JSON bytes.
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
/// The most statements of one batch.
pub const MAX_STATEMENTS: usize = 256;
/// How long a pooled session waits for its next request.
pub const IDLE: Duration = Duration::from_secs(10);
/// How long after its authentication a session is still pooled.
pub const LIFETIME: Duration = Duration::from_secs(60);
/// The most idle sessions of one database and role.
const POOLED_PER_ROLE: usize = 4;
/// The time a request has to send its body.
const BODY_BOUND: Duration = Duration::from_secs(10);

/// A refusal in the driver's error format, answered with HTTP 400, and its log outcome.
#[derive(Debug)]
struct Refused {
    outcome: &'static str,
    body: Vec<u8>,
}
/// The gateway's own error, with its fields in the order the Edge writes them, so a refusal of
/// both has the same bytes.
#[derive(Serialize)]
struct ErrorBody<'a> {
    message: &'a str,
    code: &'a str,
    severity: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
}
fn error_body(
    message: &str,
    code: &str,
    severity: &str,
    detail: Option<&str>,
    hint: Option<&str>,
) -> Vec<u8> {
    serde_json::to_vec(&ErrorBody {
        message,
        code,
        severity,
        detail,
        hint,
    })
    .expect("strings serialize")
}
fn refused(outcome: &'static str, code: &str, message: &str) -> Refused {
    Refused {
        outcome,
        body: error_body(message, code, "ERROR", None, None),
    }
}
fn too_large() -> Refused {
    refused(
        "response_too_large",
        "54000",
        "result is too large for HTTP SQL; the connection was closed and the request's outcome is unknown",
    )
}
fn invalid(message: &str) -> Refused {
    refused("invalid_request", "08P01", message)
}
fn not_accepting(outcome: &'static str) -> Refused {
    refused(outcome, "57P03", "database is not accepting connections")
}
fn connection_failed(outcome: &'static str) -> Refused {
    refused(outcome, "08006", "database connection failed")
}
/// After the statement bytes were written: PostgreSQL may have committed them.
fn unknown(outcome: &'static str) -> Refused {
    refused(
        outcome,
        "08007",
        "connection to the database ended during the request; its outcome is unknown and it was not retried",
    )
}

/// What the Edge forwards: the role's password (base64url of its bytes, so the JSON string has no
/// escape and is read in place), the statements, and for a batch its transaction.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body<'a> {
    #[serde(borrow)]
    password: &'a str,
    queries: Vec<Statement>,
    transaction: Option<Transaction>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Statement {
    query: String,
    params: Vec<Option<String>>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Transaction {
    isolation: Option<Isolation>,
    read_only: Option<bool>,
    deferrable: Option<bool>,
}
#[derive(Deserialize, Clone, Copy)]
enum Isolation {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}
struct Request {
    password: Password,
    statements: Vec<Statement>,
    transaction: Option<Transaction>,
}
fn parse(body: &[u8]) -> Result<Request, Refused> {
    let parsed: Body = serde_json::from_slice(body).map_err(|_| invalid("invalid request"))?;
    let password = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(parsed.password)
            .map_err(|_| invalid("invalid request"))?,
    );
    if parsed.queries.is_empty()
        || parsed.queries.len() > MAX_STATEMENTS
        || (parsed.transaction.is_none() && parsed.queries.len() != 1)
        || parsed.queries.iter().any(|s| s.params.len() > 65_535)
    {
        return Err(invalid("invalid request"));
    }
    if parsed
        .queries
        .iter()
        .any(|s| s.query.contains('\0') || s.params.iter().flatten().any(|v| v.contains('\0')))
    {
        return Err(refused(
            "invalid_request",
            "22021",
            "invalid byte sequence for encoding \"UTF8\": 0x00",
        ));
    }
    // PostgreSQL never accepts an empty password, and one with a NUL cannot be sent.
    let password = Password::new(password).ok_or_else(authentication_failed)?;
    Ok(Request {
        password,
        statements: parsed.queries,
        transaction: parsed.transaction,
    })
}
fn authentication_failed() -> Refused {
    Refused {
        outcome: "authentication_failed",
        body: error_body(
            "password authentication failed",
            "28P01",
            "FATAL",
            None,
            None,
        ),
    }
}
fn begin(transaction: &Transaction) -> String {
    let mut modes = Vec::new();
    if let Some(isolation) = transaction.isolation {
        modes.push(match isolation {
            Isolation::ReadUncommitted => "ISOLATION LEVEL READ UNCOMMITTED",
            Isolation::ReadCommitted => "ISOLATION LEVEL READ COMMITTED",
            Isolation::RepeatableRead => "ISOLATION LEVEL REPEATABLE READ",
            Isolation::Serializable => "ISOLATION LEVEL SERIALIZABLE",
        });
    }
    match transaction.read_only {
        Some(true) => modes.push("READ ONLY"),
        Some(false) => modes.push("READ WRITE"),
        None => {}
    }
    match transaction.deferrable {
        Some(true) => modes.push("DEFERRABLE"),
        Some(false) => modes.push("NOT DEFERRABLE"),
        None => {}
    }
    if modes.is_empty() {
        "BEGIN".into()
    } else {
        format!("BEGIN {}", modes.join(", "))
    }
}

/// Stage marks of one request, logged once as `sql_stages` when it is dropped. Roles, addresses,
/// tokens, statements and passwords are never logged.
struct Stages {
    database: Option<String>,
    outcome: &'static str,
    pooled: bool,
    /// `warm` for a request admitted on a running unit when it arrived, `cold` for one that
    /// waited for its database's wake; none for one refused before either.
    wake_path: Option<&'static str>,
    statements: usize,
    received: Instant,
    dial: Option<Duration>,
    authentication: Option<Duration>,
    query: Option<Duration>,
}
impl Drop for Stages {
    fn drop(&mut self) {
        let ms = |duration: Option<Duration>| duration.map(|d| d.as_millis() as u64);
        println!(
            "{}",
            json!({"event":"sql_stages","database":self.database,"outcome":self.outcome,"pooled":self.pooled,"wake_path":self.wake_path,"statements":self.statements,"dial_ms":ms(self.dial),"auth_ms":ms(self.authentication),"query_ms":ms(self.query),"request_ms":ms(Some(self.received.elapsed()))})
        );
    }
}

/// One authenticated PostgreSQL session of a database and role, reserved as a gateway session.
struct Backend {
    lease: SessionLease,
    actions: watch::Receiver<Action>,
    postgres: UnixStream,
    database: String,
    user: String,
    /// The generation of the database the session was admitted at. A role change moves it on the
    /// unit that runs, and the session proved a password PostgreSQL may no longer accept.
    generation: u64,
    /// What PostgreSQL proved; none when it asked for no password, and then it is not pooled.
    verifier: Option<Verifier>,
    authenticated: Instant,
    /// The memory the session holds while it exists.
    _memory: Lease,
}

/// The idle sessions, per database and role. Each waits in its own task; a request takes one by
/// sending it a reply channel.
#[derive(Default)]
pub struct Pool {
    parked: Mutex<HashMap<(String, String), Vec<Parked>>>,
}
struct Parked {
    verifier: Verifier,
    take: oneshot::Sender<oneshot::Sender<Backend>>,
}

/// Answers one `POST /sql`; the route token is checked before the body is read.
pub async fn serve(
    mut socket: TcpStream,
    head: HttpHead,
    gateway: Arc<Gateway>,
    stop: watch::Receiver<bool>,
    permit: OwnedSemaphorePermit,
    received: Instant,
) -> Result<(), Failure> {
    let mut stages = Stages {
        database: None,
        // Kept only when the task is cancelled before it records an end.
        outcome: "aborted",
        pooled: false,
        wake_path: None,
        statements: 0,
        received,
        dial: None,
        authentication: None,
        query: None,
    };
    let (answer, backend) = handle(&mut socket, head, &gateway, &stop, permit, &mut stages).await;
    // The answer's memory stays leased until it was sent.
    let (status, bytes, _memory) = match answer {
        Ok(answer) => {
            stages.outcome = "ok";
            (200, answer.bytes, Some(answer.memory))
        }
        Err(refusal) => {
            stages.outcome = refusal.outcome;
            (400, refusal.body, None)
        }
    };
    if let Some((backend, _)) = &backend {
        gateway
            .measurements
            .lock()
            .unwrap()
            .egress(&backend.lease.id, bytes.len());
    }
    let sent = respond(&mut socket, status, &bytes).await;
    // The answer goes first; the session is cleaned for its next request after it.
    if let Some((backend, status)) = backend {
        tokio::spawn(recycle(gateway, backend, status, stop));
    }
    sent
}
async fn respond(socket: &mut TcpStream, status: u16, body: &[u8]) -> Result<(), Failure> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    timeout(Duration::from_secs(30), async {
        socket.write_all(header.as_bytes()).await?;
        socket.write_all(body).await?;
        socket.shutdown().await
    })
    .await??;
    Ok(())
}
type Handled = (Result<Answer, Refused>, Option<(Backend, u8)>);
async fn handle(
    socket: &mut TcpStream,
    head: HttpHead,
    gateway: &Arc<Gateway>,
    stop: &watch::Receiver<bool>,
    permit: OwnedSemaphorePermit,
    stages: &mut Stages,
) -> Handled {
    macro_rules! attempt {
        ($value:expr) => {
            match $value {
                Ok(value) => value,
                Err(refusal) => return (Err(refusal), None),
            }
        };
    }
    if head.method != "POST" {
        return (Err(invalid("HTTP SQL requires POST")), None);
    }
    let route = attempt!(admitted_route(&head, gateway));
    stages.database = Some(route.database().to_string());
    let body = attempt!(read_body(socket, head).await);
    drop(permit);
    let request = attempt!(parse(&body));
    let request_bytes = body.len();
    drop(body);
    stages.statements = request.statements.len();
    let (claims, target) = match route {
        Presented::Admitted(claims) => {
            let target = attempt!(gateway.admit(&claims).await.map_err(not_accepting));
            (claims, target)
        }
        Presented::Wake(ticket) => attempt!(wake(gateway, &ticket, stop, stages).await),
    };
    // Admitted without a hold: the database was running when the request arrived.
    stages.wake_path.get_or_insert("warm");
    let mut backend = match checkout(gateway, &claims, &target, &request.password).await {
        Checkout::Taken(backend) => {
            stages.pooled = true;
            *backend
        }
        Checkout::Missed(known) => {
            attempt!(open(gateway, &claims, &target, &request.password, known, stages).await)
        }
    };
    {
        let id = &backend.lease.id;
        gateway
            .sessions
            .lock()
            .unwrap()
            .update(id, true, true, false);
        let mut metrics = gateway.measurements.lock().unwrap();
        metrics.ingress(id, request_bytes);
        metrics.client_activity(id);
    }
    let Request {
        password,
        statements,
        transaction,
    } = request;
    drop(password);
    let started = Instant::now();
    let executed = execute(gateway, &mut backend, &statements, transaction.as_ref()).await;
    stages.query = Some(started.elapsed());
    match executed {
        Ok((Ok(answer), status)) if answer.results == statements.len() => {
            (Ok(answer.finish()), Some((backend, status)))
        }
        Ok((Ok(_), _)) => {
            terminate(backend).await;
            (Err(unknown("postgres_protocol")), None)
        }
        Ok((Err(error), status)) => (
            Err(Refused {
                outcome: "postgres_error",
                body: error,
            }),
            Some((backend, status)),
        ),
        Err(refusal) => {
            terminate(backend).await;
            (Err(refusal), None)
        }
    }
}

/// What a request presents: a v6 route that names the unit it runs on, or a v5 wake ticket that
/// waits for the agent's release.
enum Presented {
    Admitted(Route),
    Wake(WakeClaims),
}
impl Presented {
    fn database(&self) -> &str {
        match self {
            Presented::Admitted(claims) => &claims.db,
            Presented::Wake(ticket) => &ticket.db,
        }
    }
}
/// The route the Edge signed, used once.
fn admitted_route(head: &HttpHead, gateway: &Gateway) -> Result<Presented, Refused> {
    let denied = || refused("route_denied", "08006", "gateway connection failed");
    if head.count("x-pgcf-route") > 1 {
        return Err(denied());
    }
    let token = head.one("x-pgcf-route");
    let config = &gateway.config;
    let presented = if token
        .is_some_and(|token| token.starts_with(&format!("{}.", wake::ROUTE_PREFIX)))
    {
        let ticket = wake::verify_wake(token, &config.keyring.keys, &config.region, http::now())
            .map_err(|_| denied())?;
        Presented::Wake(ticket)
    } else {
        let claims = verify(
            token,
            &config.keyring.keys,
            &config.region,
            &config.node,
            http::now(),
        )
        .map_err(|_| denied())?;
        Presented::Admitted(Route::from(&claims))
    };
    let (database, cid, exp) = match &presented {
        Presented::Admitted(route) => (&route.db, &route.cid, route.exp),
        Presented::Wake(ticket) => (&ticket.db, &ticket.cid, ticket.exp),
    };
    gateway
        .admission
        .lock()
        .unwrap()
        .replay
        .use_token(database, cid, exp, http::now())
        .map_err(|_| denied())?;
    Ok(presented)
}
/// The request body, by Content-Length or chunked. Every buffer that held it is zeroized.
async fn read_body(socket: &mut TcpStream, head: HttpHead) -> Result<Zeroizing<Vec<u8>>, Refused> {
    let HttpHead {
        headers,
        prefix,
        end,
        ..
    } = head;
    let prefix = Zeroizing::new(prefix);
    let one = |name: &str| {
        let mut values = headers.iter().filter(|(key, _)| key == name);
        let value = values.next().map(|(_, value)| value.as_str());
        if values.next().is_some() { None } else { value }
    };
    let too_large = || refused("request_too_large", "54000", "request is too large");
    let chunked = headers.iter().any(|(key, _)| key == "transfer-encoding");
    if chunked {
        if one("transfer-encoding").is_none_or(|v| !v.eq_ignore_ascii_case("chunked"))
            || headers.iter().any(|(key, _)| key == "content-length")
        {
            return Err(invalid("invalid request"));
        }
        let mut raw = Zeroizing::new(Vec::with_capacity(MAX_REQUEST_BYTES + 64 * 1024));
        raw.extend_from_slice(&prefix[end..]);
        let mut body = Zeroizing::new(Vec::with_capacity(MAX_REQUEST_BYTES));
        let mut offset = 0;
        let deadline = tokio::time::Instant::now() + BODY_BOUND;
        loop {
            // Parses what has arrived; reads more only when a chunk is incomplete.
            match httparse::parse_chunk_size(&raw[offset..]) {
                Ok(httparse::Status::Complete((consumed, 0))) => {
                    // The last chunk; trailers are not accepted.
                    while raw.len() < offset + consumed + 2 {
                        read_more(socket, &mut raw, deadline).await?;
                    }
                    if &raw[offset + consumed..offset + consumed + 2] != b"\r\n" {
                        return Err(invalid("invalid request"));
                    }
                    return Ok(body);
                }
                Ok(httparse::Status::Complete((consumed, size))) => {
                    let size = usize::try_from(size).map_err(|_| too_large())?;
                    if size > MAX_REQUEST_BYTES - body.len() {
                        return Err(too_large());
                    }
                    let start = offset + consumed;
                    while raw.len() < start + size + 2 {
                        read_more(socket, &mut raw, deadline).await?;
                    }
                    if &raw[start + size..start + size + 2] != b"\r\n" {
                        return Err(invalid("invalid request"));
                    }
                    body.extend_from_slice(&raw[start..start + size]);
                    offset = start + size + 2;
                }
                Ok(httparse::Status::Partial) => {
                    if raw.len() - offset > 1024 {
                        return Err(invalid("invalid request"));
                    }
                    read_more(socket, &mut raw, deadline).await?;
                }
                Err(_) => return Err(invalid("invalid request")),
            }
        }
    }
    let length: usize = one("content-length")
        .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| invalid("invalid request"))?;
    if length > MAX_REQUEST_BYTES {
        return Err(too_large());
    }
    if prefix.len() - end > length {
        return Err(invalid("invalid request"));
    }
    // Sized once: a reallocation would leave an unwiped copy behind.
    let mut body = Zeroizing::new(Vec::with_capacity(length));
    body.extend_from_slice(&prefix[end..]);
    let filled = body.len();
    body.resize(length, 0);
    match timeout(BODY_BOUND, socket.read_exact(&mut body[filled..])).await {
        Ok(Ok(_)) => Ok(body),
        _ => Err(invalid("incomplete request")),
    }
}
async fn read_more(
    socket: &mut TcpStream,
    raw: &mut Zeroizing<Vec<u8>>,
    deadline: tokio::time::Instant,
) -> Result<(), Refused> {
    if raw.len() >= raw.capacity() {
        return Err(refused(
            "request_too_large",
            "54000",
            "request is too large",
        ));
    }
    let mut chunk = Zeroizing::new(vec![0; (raw.capacity() - raw.len()).min(64 * 1024)]);
    match tokio::time::timeout_at(deadline, socket.read(&mut chunk)).await {
        Ok(Ok(length)) if length > 0 => {
            raw.extend_from_slice(&chunk[..length]);
            Ok(())
        }
        _ => Err(invalid("incomplete request")),
    }
}

/// Waits, as a held WebSocket connection does, until the agent's table releases the ticket's
/// wake; the answer is the route the request is admitted under and the released unit.
async fn wake(
    gateway: &Arc<Gateway>,
    ticket: &WakeClaims,
    stop: &watch::Receiver<bool>,
    stages: &mut Stages,
) -> Result<(Route, Writer), Refused> {
    // Released at its generation already: routed at once, as a running database is.
    match transport::wake_state(gateway, ticket).await {
        WakeState::Released {
            writer,
            route_revision,
        } => {
            return gateway
                .admit_wake(ticket, &writer, route_revision)
                .await
                .map_err(not_accepting);
        }
        WakeState::Stale => return Err(not_accepting("route_stale")),
        WakeState::Waiting => {}
    }
    let deadline = tokio::time::Instant::from_std(stages.received + transport::WAKE_BOUND);
    let mut held = gateway
        .wakes
        .hold(ticket, http::now(), Instant::now())
        .map_err(|_| not_accepting("wake_capacity"))?;
    stages.wake_path = Some("cold");
    let mut stop = stop.clone();
    loop {
        // Armed before the table is read, so a change between the read and the wait wakes it.
        let table = gateway.changed().await;
        let changed = table.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if gateway.draining.load(Ordering::Acquire) || *stop.borrow() {
            return Err(refused("gateway_draining", "08006", "gateway restarting"));
        }
        if let Some(result) = held
            .verdict()
            .filter(|result| result.outcome == Outcome::Refused)
        {
            // The contract's detail and hint travel with the 57P03, as on a WebSocket.
            let (detail, hint) = result.refusal_fields();
            return Err(Refused {
                outcome: "wake_refused",
                body: error_body(
                    "database is not accepting connections",
                    "57P03",
                    "ERROR",
                    detail,
                    hint.as_deref(),
                ),
            });
        }
        match transport::wake_state(gateway, ticket).await {
            WakeState::Released {
                writer,
                route_revision,
            } => {
                let _ = held.release();
                return gateway
                    .admit_wake(ticket, &writer, route_revision)
                    .await
                    .map_err(not_accepting);
            }
            WakeState::Stale => return Err(not_accepting("route_stale")),
            WakeState::Waiting => {}
        }
        tokio::select! {
            _ = changed.as_mut() => {},
            _ = held.answered() => {},
            _ = tokio::time::sleep_until(deadline) => {
                return Err(refused("wake_timeout", "57P03", "database did not wake in time"));
            }
            changed = stop.changed() => if changed.is_err() {
                return Err(refused("gateway_draining", "08006", "gateway restarting"));
            },
        }
    }
}
/// What the pool had for a request.
enum Checkout {
    Taken(Box<Backend>),
    /// No session matched; the SaltedPassword derived for the newest one, which a new session's
    /// login uses when PostgreSQL asks for the same salt and iterations.
    Missed(Option<Salted>),
}
/// An idle session of the route's database and role on the same writer and at the route's
/// generation whose verifier the password matches. A session of another generation proved its
/// password before a role change and is ended; the route's revision does not matter, since the
/// page that carries the claim of a wake moves only that. Only the newest session's verifier is
/// derived, once: the sessions of one role share it unless its password was rotated.
async fn checkout(
    gateway: &Gateway,
    claims: &Route,
    target: &Writer,
    password: &Password,
) -> Checkout {
    let key = (claims.db.clone(), claims.user.clone());
    let newest = {
        let mut parked = gateway.sql.parked.lock().unwrap();
        let Some(sessions) = parked.get_mut(&key) else {
            return Checkout::Missed(None);
        };
        sessions.retain(|session| !session.take.is_closed());
        match sessions.last() {
            Some(session) => session.verifier.clone(),
            None => return Checkout::Missed(None),
        }
    };
    let Ok(salted) = Salted::derive(password, newest.salt, newest.iterations).await else {
        return Checkout::Missed(None);
    };
    let derived = salted.verifier();
    loop {
        let parked = {
            let mut parked = gateway.sql.parked.lock().unwrap();
            let Some(sessions) = parked.get_mut(&key) else {
                break;
            };
            let Some(index) = sessions
                .iter()
                .rposition(|session| session.verifier.same(&derived))
            else {
                break;
            };
            sessions.remove(index)
        };
        let (reply, taken) = oneshot::channel();
        if parked.take.send(reply).is_err() {
            continue;
        }
        let Ok(backend) = taken.await else {
            continue;
        };
        if backend.generation == claims.generation
            && backend.lease.target == *target
            && backend.authenticated.elapsed() < LIFETIME
            && gateway.permits(&claims.db, &backend.lease.target).await
        {
            return Checkout::Taken(Box::new(backend));
        }
        terminate(backend).await;
    }
    Checkout::Missed(Some(salted))
}
/// Dials the admitted writer and authenticates a new session with the request's password.
async fn open(
    gateway: &Arc<Gateway>,
    claims: &Route,
    target: &Writer,
    password: &Password,
    known: Option<Salted>,
    stages: &mut Stages,
) -> Result<Backend, Refused> {
    let database = &claims.db;
    let capacity = || refused("admission_denied", "53300", "too many connections");
    let memory = transport::session_memory(gateway, database).ok_or_else(capacity)?;
    let wire = WireBudget::new(gateway.memory.lease(database));
    let (lease, actions) = gateway
        .reserve(claims, wire, target, false)
        .map_err(|_| capacity())?;
    // The route was checked against this writer; a replacement is never dialled.
    gateway
        .dialable(database, target, true)
        .await
        .map_err(not_accepting)?;
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(&lease.id, false, true, true);
    let dialing = Instant::now();
    let dialed = timeout(transport::STARTUP_BOUND, local::dial(target)).await;
    stages.dial = Some(dialing.elapsed());
    let postgres = match dialed {
        Ok(Ok(postgres)) => postgres,
        Ok(Err(error)) => return Err(connection_failed(error.outcome())),
        Err(_) => return Err(connection_failed("postgres_connect_error")),
    };
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(&lease.id, false, true, false);
    let mut backend = Backend {
        lease,
        actions,
        postgres,
        database: database.clone(),
        user: claims.user.clone(),
        generation: claims.generation,
        verifier: None,
        authenticated: Instant::now(),
        _memory: memory,
    };
    let authenticating = Instant::now();
    let authenticated = timeout(
        transport::STARTUP_BOUND,
        authenticate(gateway, &mut backend, password, known),
    )
    .await
    .unwrap_or_else(|_| Err(connection_failed("startup_timeout")));
    stages.authentication = Some(authenticating.elapsed());
    match authenticated {
        Ok(verifier) => {
            backend.verifier = verifier;
            backend.authenticated = Instant::now();
            gateway
                .measurements
                .lock()
                .unwrap()
                .authenticate(&backend.lease.id);
            Ok(backend)
        }
        Err(refusal) => {
            terminate(backend).await;
            Err(refusal)
        }
    }
}
fn message(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
    out.push(tag);
    out.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    out.extend_from_slice(body);
}
/// Writes the StartupMessage and logs in with the request's password; the answer is the verifier
/// PostgreSQL proved, if it asked for a password.
async fn authenticate(
    gateway: &Gateway,
    backend: &mut Backend,
    password: &Password,
    known: Option<Salted>,
) -> Result<Option<Verifier>, Refused> {
    let failed = || connection_failed("postgres_error");
    let protocol = || connection_failed("authentication_protocol");
    let mut startup = 196_608u32.to_be_bytes().to_vec();
    for (key, value) in [
        ("user", backend.user.as_str()),
        ("database", backend.database.as_str()),
        ("client_encoding", "UTF8"),
    ] {
        startup.extend_from_slice(key.as_bytes());
        startup.push(0);
        startup.extend_from_slice(value.as_bytes());
        startup.push(0);
    }
    startup.push(0);
    let mut bytes = ((startup.len() + 4) as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(&startup);
    // A database that stopped admitting before the guarded write got nothing: it is refused as
    // any request that finds the database not accepting, which an integrator retries by its code.
    write_guarded(gateway, backend, &bytes)
        .await
        .map_err(|guard| match guard {
            Guard::Fenced => not_accepting("fenced"),
            Guard::Lost => failed(),
        })?;
    let login = auth::login(&mut backend.postgres, password, known)
        .await
        .map_err(|_| failed())?;
    let startup_error = |body: &[u8]| Refused {
        outcome: "postgres_startup_error",
        body: serde_json::to_vec(&error_fields(body)).expect("fields serialize"),
    };
    let (messages, verifier) = match login {
        Login::Refused => return Err(authentication_failed()),
        Login::Failed(message) => return Err(startup_error(message.get(5..).unwrap_or_default())),
        Login::Authenticated(messages, verifier) => (messages, verifier),
    };
    // AuthenticationOk through ReadyForQuery, and nothing behind it.
    let mut rest = messages.as_slice();
    while let Some((&tag, tail)) = rest.split_first() {
        let length = tail
            .get(..4)
            .map(|length| u32::from_be_bytes(length.try_into().unwrap()) as usize)
            .filter(|length| *length >= 4 && *length <= tail.len())
            .ok_or_else(protocol)?;
        let body = &tail[4..length];
        rest = &tail[length..];
        match tag {
            b'E' => return Err(startup_error(body)),
            b'Z' if rest.is_empty() => return Ok(verifier),
            b'R' | b'S' | b'K' | b'N' => {}
            _ => return Err(protocol()),
        }
    }
    Err(protocol())
}
/// Writes to PostgreSQL only while the agent's table still admits new work for the session's
/// database on its writer, holding the table for the bounded write.
async fn write_guarded(
    gateway: &Gateway,
    backend: &mut Backend,
    bytes: &[u8],
) -> Result<(), Guard> {
    let Backend {
        lease,
        postgres,
        database,
        ..
    } = backend;
    gateway
        .write_admitted(database, &lease.target, postgres, bytes)
        .await
        .map_err(|blocked| match blocked {
            Blocked::Fenced | Blocked::TargetChanged => Guard::Fenced,
            Blocked::Lost => Guard::Lost,
        })
}
enum Guard {
    /// Nothing was written.
    Fenced,
    /// The write failed: its bytes may have reached PostgreSQL.
    Lost,
}
async fn read_message(postgres: &mut UnixStream) -> std::io::Result<(u8, Vec<u8>)> {
    let mut header = [0; 5];
    postgres.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if !(4..=MAX_RESPONSE_BYTES + 4).contains(&length) {
        return Err(std::io::Error::other("PostgreSQL message too large"));
    }
    let mut body = vec![0; length - 4];
    postgres.read_exact(&mut body).await?;
    Ok((header[0], body))
}
fn cstring(bytes: &[u8]) -> Option<(&str, &[u8])> {
    let end = bytes.iter().position(|b| *b == 0)?;
    Some((std::str::from_utf8(&bytes[..end]).ok()?, &bytes[end + 1..]))
}
/// An ErrorResponse in the driver's error format.
fn error_fields(body: &[u8]) -> Value {
    let mut fields = Map::new();
    let mut rest = body;
    while let Some((&code, tail)) = rest.split_first() {
        if code == 0 {
            break;
        }
        let Some((value, tail)) = cstring(tail) else {
            break;
        };
        rest = tail;
        let name = match code {
            b'M' => "message",
            b'C' => "code",
            b'S' => "severity",
            b'D' => "detail",
            b'H' => "hint",
            b'P' => "position",
            b'p' => "internalPosition",
            b'q' => "internalQuery",
            b'W' => "where",
            b's' => "schema",
            b't' => "table",
            b'c' => "column",
            b'd' => "dataType",
            b'n' => "constraint",
            b'F' => "file",
            b'L' => "line",
            b'R' => "routine",
            _ => continue,
        };
        fields.insert(name.into(), value.into());
    }
    Value::Object(fields)
}
fn row_description(body: &[u8]) -> Option<Vec<Value>> {
    let count = i16::from_be_bytes(body.get(..2)?.try_into().ok()?);
    let mut rest = &body[2..];
    let mut fields = Vec::new();
    for _ in 0..count {
        let (name, tail) = cstring(rest)?;
        let numbers = tail.get(..18)?;
        let table = u32::from_be_bytes(numbers[..4].try_into().ok()?);
        let column = i16::from_be_bytes(numbers[4..6].try_into().ok()?);
        let oid = u32::from_be_bytes(numbers[6..10].try_into().ok()?);
        let size = i16::from_be_bytes(numbers[10..12].try_into().ok()?);
        let modifier = i32::from_be_bytes(numbers[12..16].try_into().ok()?);
        fields.push(json!({"name":name,"dataTypeID":oid,"tableID":table,"columnID":column,"dataTypeSize":size,"dataTypeModifier":modifier,"format":"text"}));
        rest = &tail[18..];
    }
    Some(fields)
}
/// The length of a string serialized as JSON, as serde_json escapes it.
fn json_string_length(value: &str) -> usize {
    2 + value
        .bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
            0..=0x1f => 6,
            _ => 1,
        })
        .sum::<usize>()
}
/// The answer in the driver's format, serialized as PostgreSQL's messages arrive: one result
/// object per described statement, in `{"results":[...]}` for a transaction. The whole capacity
/// of its buffer is leased from the database's memory budget.
struct Answer {
    bytes: Vec<u8>,
    memory: Lease,
    transaction: bool,
    /// The results completed.
    results: usize,
    /// The rows of the result being written, if one is.
    rows: Option<usize>,
}
impl Answer {
    fn new(memory: Lease, transaction: bool) -> Result<Self, Refused> {
        let mut answer = Self {
            bytes: Vec::new(),
            memory,
            transaction,
            results: 0,
            rows: None,
        };
        if transaction {
            answer.push(b"{\"results\":[")?;
        }
        Ok(answer)
    }
    /// Room for `additional` more bytes and the transaction's closing ones, within
    /// [`MAX_RESPONSE_BYTES`] and the budget.
    fn reserve(&mut self, additional: usize) -> Result<(), Refused> {
        let needed = self.bytes.len() + additional + 2;
        if needed > MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
        let capacity = self.bytes.capacity();
        if needed > capacity {
            let grown = needed.max(capacity * 2).min(MAX_RESPONSE_BYTES);
            if !self.memory.grow(grown - capacity) {
                return Err(too_large());
            }
            self.bytes.reserve_exact(grown - self.bytes.len());
        }
        Ok(())
    }
    fn push(&mut self, bytes: &[u8]) -> Result<(), Refused> {
        self.reserve(bytes.len())?;
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    /// A RowDescription or NoData: the result of the next statement begins.
    fn begin(&mut self, fields: &[Value]) -> Result<(), Refused> {
        if self.results > 0 {
            self.push(b",")?;
        }
        self.push(b"{\"fields\":")?;
        self.push(&serde_json::to_vec(fields).expect("fields serialize"))?;
        self.push(b",\"rowAsArray\":true,\"rows\":[")?;
        self.rows = Some(0);
        Ok(())
    }
    /// A DataRow, as an array of raw text values.
    fn row(&mut self, body: &[u8]) -> Result<(), Refused> {
        let protocol = || unknown("postgres_protocol");
        let rows = self.rows.as_mut().ok_or_else(protocol)?;
        let first = *rows == 0;
        *rows += 1;
        if !first {
            self.push(b",")?;
        }
        let count = i16::from_be_bytes(body.get(..2).ok_or_else(protocol)?.try_into().unwrap());
        let mut rest = &body[2..];
        self.push(b"[")?;
        for index in 0..count {
            if index > 0 {
                self.push(b",")?;
            }
            let length =
                i32::from_be_bytes(rest.get(..4).ok_or_else(protocol)?.try_into().unwrap());
            rest = &rest[4..];
            if length < 0 {
                self.push(b"null")?;
            } else {
                let value = rest.get(..length as usize).ok_or_else(protocol)?;
                rest = &rest[length as usize..];
                let text = String::from_utf8_lossy(value);
                self.reserve(json_string_length(&text))?;
                serde_json::to_writer(&mut self.bytes, &*text).expect("strings serialize");
            }
        }
        self.push(b"]")
    }
    /// A CommandComplete (or EmptyQueryResponse) of a described statement.
    fn end(&mut self, command: Value, count: Value) -> Result<(), Refused> {
        self.rows = None;
        self.results += 1;
        self.push(format!("],\"command\":{command},\"rowCount\":{count}}}").as_bytes())
    }
    fn finish(mut self) -> Self {
        if self.transaction {
            // Reserved by every write.
            self.bytes.extend_from_slice(b"]}");
        }
        self
    }
}
/// The command and row count of a CommandComplete tag, as node-postgres reads them.
fn command(tag: &str) -> (Value, Value) {
    let mut words = tag.split(' ');
    let command = words.next().unwrap_or_default();
    let numbers: Vec<u64> = words
        .take(2)
        .map_while(|word| word.parse::<u64>().ok())
        .collect();
    (command.into(), numbers.last().copied().into())
}
/// The extended-protocol messages of one statement: parameters and results in text.
fn statement(out: &mut Vec<u8>, query: &str, params: &[Option<String>], describe: bool) {
    let mut parse = vec![0];
    parse.extend_from_slice(query.as_bytes());
    parse.extend_from_slice(&[0, 0, 0]);
    message(out, b'P', &parse);
    let mut bind = vec![0, 0, 0, 0];
    bind.extend_from_slice(&(params.len() as u16).to_be_bytes());
    for param in params {
        match param {
            Some(value) => {
                bind.extend_from_slice(&(value.len() as i32).to_be_bytes());
                bind.extend_from_slice(value.as_bytes());
            }
            None => bind.extend_from_slice(&(-1i32).to_be_bytes()),
        }
    }
    bind.extend_from_slice(&[0, 0]);
    message(out, b'B', &bind);
    if describe {
        message(out, b'D', b"P\0");
    }
    message(out, b'E', &[0, 0, 0, 0, 0]);
}
/// Runs the request as one pipeline ending in one Sync: a batch between BEGIN and COMMIT. The
/// answer is the results or PostgreSQL's error, with the transaction status after the Sync; a
/// refusal means the session cannot be used again.
async fn execute(
    gateway: &Gateway,
    backend: &mut Backend,
    statements: &[Statement],
    transaction: Option<&Transaction>,
) -> Result<(Result<Answer, Vec<u8>>, u8), Refused> {
    let mut pipeline = Vec::new();
    if let Some(transaction) = transaction {
        statement(&mut pipeline, &begin(transaction), &[], false);
    }
    for each in statements {
        statement(&mut pipeline, &each.query, &each.params, true);
    }
    if transaction.is_some() {
        statement(&mut pipeline, "COMMIT", &[], false);
    }
    message(&mut pipeline, b'S', &[]);
    match write_guarded(gateway, backend, &pipeline).await {
        Ok(()) => {}
        Err(Guard::Fenced) => return Err(not_accepting("fenced")),
        Err(Guard::Lost) => return Err(unknown("postgres_error")),
    }
    let answer = Answer::new(
        gateway.memory.lease(&backend.database),
        transaction.is_some(),
    )?;
    let Backend {
        postgres, actions, ..
    } = backend;
    tokio::select! {
        result = results(postgres, answer) => result,
        _ = retired(actions) => Err(unknown("database_retired")),
    }
}
async fn retired(actions: &mut watch::Receiver<Action>) {
    sessions::until(actions, |action| action == Action::Retire).await;
}
async fn results(
    postgres: &mut UnixStream,
    mut answer: Answer,
) -> Result<(Result<Answer, Vec<u8>>, u8), Refused> {
    let mut error = None;
    let protocol = || unknown("postgres_protocol");
    loop {
        let (tag, body) = read_message(postgres)
            .await
            .map_err(|_| unknown("postgres_error"))?;
        // Each message is leased while it is held.
        let held = body.len();
        if !answer.memory.grow(held) {
            return Err(too_large());
        }
        let step = match tag {
            b'1' | b'2' | b'3' | b'N' | b'S' | b'A' => Ok(()),
            b'T' => row_description(&body)
                .ok_or_else(protocol)
                .and_then(|fields| answer.begin(&fields)),
            b'n' => answer.begin(&[]),
            b'D' => answer.row(&body),
            // BEGIN and COMMIT are not described, so they leave no result.
            b'C' | b'I' if answer.rows.is_none() => Ok(()),
            b'C' => cstring(&body).ok_or_else(protocol).and_then(|(tag, _)| {
                let (command, count) = command(tag);
                answer.end(command, count)
            }),
            b'I' => answer.end(Value::Null, Value::Null),
            b'E' => {
                error.get_or_insert_with(|| error_fields(&body));
                answer.rows = None;
                Ok(())
            }
            b'Z' => {
                let status = *body.first().ok_or_else(protocol)?;
                answer.memory.shrink(held);
                let error =
                    error.map(|error| serde_json::to_vec(&error).expect("fields serialize"));
                return Ok((error.map_or(Ok(answer), Err), status));
            }
            b'G' | b'H' | b'W' => Err(refused(
                "copy_unsupported",
                "0A000",
                "COPY is not supported over HTTP",
            )),
            _ => Err(protocol()),
        };
        answer.memory.shrink(held);
        step?;
    }
}
/// After the answer: a session goes back to the pool only as it was opened, with no transaction
/// and no session state.
async fn recycle(
    gateway: Arc<Gateway>,
    mut backend: Backend,
    status: u8,
    stop: watch::Receiver<bool>,
) {
    let mut cleanup = Vec::new();
    let mut expected = 1;
    if status != b'I' {
        message(&mut cleanup, b'Q', b"ROLLBACK\0");
        expected += 1;
    }
    message(&mut cleanup, b'Q', b"DISCARD ALL\0");
    let clean = backend.authenticated.elapsed() < LIFETIME
        && !*stop.borrow()
        && write_guarded(&gateway, &mut backend, &cleanup)
            .await
            .is_ok()
        && timeout(Duration::from_secs(5), async {
            let mut ready = 0;
            while ready < expected {
                match read_message(&mut backend.postgres).await {
                    Ok((b'Z', body)) => {
                        ready += 1;
                        if ready == expected && body != b"I" {
                            return false;
                        }
                    }
                    Ok((b'E', _)) | Err(_) => return false,
                    Ok(_) => {}
                }
            }
            true
        })
        .await
        .unwrap_or(false);
    if clean {
        park(gateway, backend, stop);
    } else {
        terminate(backend).await;
    }
}
/// Puts an idle session in the pool. It waits in its own task for a request, its idle bound, the
/// end of its lifetime, an action of the agent's table, the gateway's drain, or PostgreSQL ending
/// it.
fn park(gateway: Arc<Gateway>, mut backend: Backend, mut stop: watch::Receiver<bool>) {
    let key = (backend.database.clone(), backend.user.clone());
    let (take, mut request) = oneshot::channel::<oneshot::Sender<Backend>>();
    {
        let mut parked = gateway.sql.parked.lock().unwrap();
        let sessions = parked.entry(key.clone()).or_default();
        sessions.retain(|session| !session.take.is_closed());
        if sessions.len() >= POOLED_PER_ROLE {
            drop(parked);
            tokio::spawn(terminate(backend));
            return;
        }
        // A session PostgreSQL did not challenge has nothing to match a request against.
        let Some(verifier) = backend.verifier.clone() else {
            drop(parked);
            tokio::spawn(terminate(backend));
            return;
        };
        sessions.push(Parked { verifier, take });
    }
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(&backend.lease.id, true, false, false);
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::from_std(
            (Instant::now() + IDLE).min(backend.authenticated + LIFETIME),
        );
        let mut byte = [0u8; 1];
        let taken = loop {
            tokio::select! {
                reply = &mut request => break reply.ok(),
                _ = tokio::time::sleep_until(deadline) => break None,
                changed = backend.actions.changed() => if changed.is_err() || *backend.actions.borrow() != Action::Running { break None },
                changed = stop.changed() => if changed.is_err() || *stop.borrow() { break None },
                // An idle session receives nothing: a byte is PostgreSQL ending it.
                _ = backend.postgres.read(&mut byte) => break None,
            }
        };
        drop(request);
        match taken {
            Some(reply) => {
                if let Err(backend) = reply.send(backend) {
                    terminate(backend).await;
                }
            }
            None => {
                {
                    let mut parked = gateway.sql.parked.lock().unwrap();
                    if let Some(sessions) = parked.get_mut(&key) {
                        sessions.retain(|session| !session.take.is_closed());
                        if sessions.is_empty() {
                            parked.remove(&key);
                        }
                    }
                }
                terminate(backend).await;
            }
        }
    });
}
/// Ends a session with Terminate and the end of its stream; dropping it releases its
/// reservation.
async fn terminate(mut backend: Backend) {
    let _ = timeout(
        Duration::from_millis(500),
        backend.postgres.write_all(&[b'X', 0, 0, 0, 4]),
    )
    .await;
    transport::close_upstream(&mut backend.postgres).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_json_string_is_as_long_as_its_length_says() {
        let mut text: String = (0u8..0x80).map(char::from).collect();
        text.push_str("ünïcode \u{2028} \u{1F600}");
        assert_eq!(
            json_string_length(&text),
            serde_json::to_string(&text).unwrap().len()
        );
    }
    fn row(values: &[Option<&[u8]>]) -> Vec<u8> {
        let mut body = (values.len() as i16).to_be_bytes().to_vec();
        for value in values {
            match value {
                Some(value) => {
                    body.extend_from_slice(&(value.len() as i32).to_be_bytes());
                    body.extend_from_slice(value);
                }
                None => body.extend_from_slice(&(-1i32).to_be_bytes()),
            }
        }
        body
    }
    #[test]
    fn the_answer_leases_what_it_holds_and_refuses_beyond_its_bound() {
        let budget = crate::budget::MemoryBudget::new(64 * 1024 * 1024, 32 * 1024 * 1024);
        let mut answer = Answer::new(budget.lease("db"), true).unwrap();
        answer.begin(&[json!({"name":"x"})]).unwrap();
        answer.row(&row(&[None, Some(b"a\"b\n")])).unwrap();
        answer.row(&row(&[Some(b"")])).unwrap();
        answer.end(json!("SELECT"), json!(2)).unwrap();
        answer.begin(&[]).unwrap();
        answer.end(json!("INSERT"), json!(1)).unwrap();
        let answer = answer.finish();
        assert_eq!(answer.results, 2);
        assert_eq!(
            serde_json::from_slice::<Value>(&answer.bytes).unwrap(),
            json!({"results":[
                {"fields":[{"name":"x"}],"rowAsArray":true,"rows":[[null,"a\"b\n"],[""]],"command":"SELECT","rowCount":2},
                {"fields":[],"rowAsArray":true,"rows":[],"command":"INSERT","rowCount":1},
            ]})
        );
        assert!(budget.database_used("db") >= answer.bytes.capacity());
        drop(answer);
        assert_eq!(budget.database_used("db"), 0);
        // NULLs are 6 bytes on the wire and 5 as JSON: 2,000,000 of them stay within 10 MiB of
        // PostgreSQL's bytes, and are refused as an answer over 10 MiB.
        let mut answer = Answer::new(budget.lease("db"), false).unwrap();
        answer.begin(&[]).unwrap();
        let null = row(&[None]);
        let refused = (0..2_000_000).find_map(|_| answer.row(&null).err());
        assert_eq!(
            refused.map(|refusal| refusal.outcome),
            Some("response_too_large")
        );
        assert!(answer.bytes.len() <= MAX_RESPONSE_BYTES);
        assert_eq!(budget.database_used("db"), answer.bytes.capacity());
        // The budget refuses before the bound does.
        let small = crate::budget::MemoryBudget::new(1024 * 1024, 1024 * 1024);
        let mut answer = Answer::new(small.lease("db"), false).unwrap();
        answer.begin(&[]).unwrap();
        let refused = (0..1_000_000).find_map(|_| answer.row(&null).err());
        assert_eq!(
            refused.map(|refusal| refusal.outcome),
            Some("response_too_large")
        );
        assert!(answer.bytes.capacity() <= 1024 * 1024);
    }
    #[test]
    fn command_tags_read_as_node_postgres_reads_them() {
        assert_eq!(command("INSERT 0 5"), (json!("INSERT"), json!(5)));
        assert_eq!(command("SELECT 3"), (json!("SELECT"), json!(3)));
        assert_eq!(command("CREATE TABLE"), (json!("CREATE"), Value::Null));
        assert_eq!(command("BEGIN"), (json!("BEGIN"), Value::Null));
    }
    #[test]
    fn a_batch_begins_with_the_requested_characteristics() {
        assert_eq!(begin(&Transaction::default()), "BEGIN");
        assert_eq!(
            begin(&Transaction {
                isolation: Some(Isolation::RepeatableRead),
                read_only: Some(false),
                deferrable: Some(false),
            }),
            "BEGIN ISOLATION LEVEL REPEATABLE READ, READ WRITE, NOT DEFERRABLE"
        );
    }
    #[test]
    fn an_error_response_keeps_the_fields_the_driver_reads() {
        let mut body = Vec::new();
        for (code, value) in [
            (b'S', "ERROR"),
            (b'V', "ERROR"),
            (b'C', "23505"),
            (b'M', "duplicate key"),
            (b'D', "Key (id)=(1) already exists."),
            (b'n', "items_pkey"),
        ] {
            body.push(code);
            body.extend_from_slice(value.as_bytes());
            body.push(0);
        }
        body.push(0);
        assert_eq!(
            error_fields(&body),
            json!({"severity":"ERROR","code":"23505","message":"duplicate key","detail":"Key (id)=(1) already exists.","constraint":"items_pkey"})
        );
    }
}
