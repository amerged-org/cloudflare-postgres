// SPDX-License-Identifier: Apache-2.0
//! HTTP SQL: `POST /sql`, the HTTP query mode of the Neon serverless driver (`neon()`). The Edge
//! admits each request as it admits a WebSocket connection and forwards it with a route token;
//! the gateway answers it on a pooled PostgreSQL session of the route's database and role, in the
//! driver's wire format (raw text values, rows as arrays).
//!
//! The gateway authenticates that session with SCRAM-SHA-256 using the client's password. The
//! password is held in memory only for the request, wiped after use, and never logged or stored;
//! a pooled session keeps only its SCRAM verifier (salt, iterations, StoredKey) and is reused for
//! a request only when the request's password derives the same StoredKey. A pooled session
//! carries no session state between requests (`DISCARD ALL`), waits at most [`IDLE`] for its next
//! request and is retired [`LIFETIME`] after it authenticated, which bounds how long a rotated
//! password is still accepted. It counts as an idle gateway session, so a sleeping database
//! closes it like any other idle connection.
//!
//! Statement bytes that reached PostgreSQL are never sent again: a session lost before
//! PostgreSQL's answer answers SQLSTATE 08007 (outcome unknown) and is closed.
use crate::{
    budget::{Lease, WireBudget},
    control::{self, HttpHead},
    sessions::Action,
    targets::TargetIdentity,
    transport::{self, Gateway, SessionLease, WakeState},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use pgcf_native_protocol::{
    route::{RouteClaims, verify},
    wake::{self, Outcome, WakeClaims},
};
use ring::{hmac, pbkdf2, rand::SecureRandom};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    num::NonZeroU32,
    sync::{Arc, Mutex, atomic::Ordering},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::{OwnedSemaphorePermit, oneshot, watch},
    time::timeout,
};
use tokio_rustls::client::TlsStream;
type Failure = Box<dyn std::error::Error + Send + Sync>;
pub const PATH: &str = "/sql";
/// The largest request body; the Edge refuses a larger one first.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
/// The largest answer, counted as PostgreSQL's row bytes.
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
/// The most SCRAM iterations the gateway computes for PostgreSQL's verifier.
const MAX_ITERATIONS: u32 = 1_000_000;

/// Bytes wiped when dropped: the password and every buffer that held it.
struct Secret(Vec<u8>);
impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}
fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(bytes);
}

/// A refusal in the driver's error format, answered with HTTP 400, and its log outcome.
struct Refused {
    outcome: &'static str,
    body: Value,
}
fn refused(outcome: &'static str, code: &str, message: &str) -> Refused {
    Refused {
        outcome,
        body: json!({"message":message,"code":code,"severity":"ERROR"}),
    }
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
    password: Secret,
    statements: Vec<Statement>,
    transaction: Option<Transaction>,
}
fn parse(body: &[u8]) -> Result<Request, Refused> {
    let parsed: Body = serde_json::from_slice(body).map_err(|_| invalid("invalid request"))?;
    let password = Secret(
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
    if password.0.is_empty() || password.0.contains(&0) {
        return Err(authentication_failed());
    }
    Ok(Request {
        password,
        statements: parsed.queries,
        transaction: parsed.transaction,
    })
}
fn authentication_failed() -> Refused {
    Refused {
        outcome: "authentication_failed",
        body: json!({"message":"password authentication failed","code":"28P01","severity":"FATAL"}),
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
    /// `warm`, or `pool_hit`/`pool_miss` for a request that waited for its database's wake.
    wake_path: &'static str,
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

/// SCRAM-SHA-256 (RFC 5802, RFC 7677) without channel binding: TLS to PostgreSQL is verified
/// against the database's own authority before the first byte.
mod scram {
    use super::*;
    /// What a session authenticated with: enough to recognise its password, not to recover it.
    #[derive(Clone, PartialEq, Eq)]
    pub(super) struct Verifier {
        pub salt: Vec<u8>,
        pub iterations: u32,
        pub stored_key: [u8; 32],
    }
    pub(super) fn salted(password: &[u8], salt: &[u8], iterations: u32) -> Secret {
        let mut out = Secret(vec![0; 32]);
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            NonZeroU32::new(iterations).expect("positive iterations"),
            salt,
            password,
            &mut out.0,
        );
        out
    }
    pub(super) fn mac(key: &[u8], data: &[u8]) -> [u8; 32] {
        let tag = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), data);
        tag.as_ref().try_into().expect("SHA-256 tag")
    }
    impl Verifier {
        pub fn of(password: &[u8], salt: Vec<u8>, iterations: u32) -> Self {
            let salted = salted(password, &salt, iterations);
            let mut client_key = mac(&salted.0, b"Client Key");
            let stored_key = Sha256::digest(client_key).into();
            wipe(&mut client_key);
            Self {
                salt,
                iterations,
                stored_key,
            }
        }
        /// A verifier of its own for a session PostgreSQL did not challenge with SCRAM.
        pub fn local(password: &[u8]) -> Result<Self, Refused> {
            let mut salt = vec![0; 16];
            ring::rand::SystemRandom::new()
                .fill(&mut salt)
                .map_err(|_| connection_failed("random_unavailable"))?;
            Ok(Self::of(password, salt, 4096))
        }
        /// Whether `stored_key` was derived from the same password, compared in constant time.
        pub fn same(&self, stored_key: &[u8; 32]) -> bool {
            self.stored_key
                .iter()
                .zip(stored_key)
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0
        }
    }
    /// The client's first message and its bare part, for a fresh random nonce.
    pub(super) fn client_first(user: &str) -> Result<(String, String), Refused> {
        let mut nonce = [0; 18];
        ring::rand::SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| connection_failed("random_unavailable"))?;
        Ok(first_with_nonce(user, &STANDARD.encode(nonce)))
    }
    pub(super) fn first_with_nonce(user: &str, nonce: &str) -> (String, String) {
        let bare = format!("n={user},r={nonce}");
        (format!("n,,{bare}"), bare)
    }
    /// The client's final message, the server signature PostgreSQL must prove, and the verifier.
    pub(super) fn client_final(
        password: &[u8],
        first_bare: &str,
        server_first: &str,
    ) -> Result<(String, [u8; 32], Verifier), Refused> {
        let protocol = || connection_failed("authentication_protocol");
        let client_nonce = first_bare
            .split(',')
            .find_map(|part| part.strip_prefix("r="))
            .ok_or_else(protocol)?;
        let mut nonce = None;
        let mut salt = None;
        let mut iterations = None;
        for part in server_first.split(',') {
            match part.split_at_checked(2) {
                Some(("r=", value)) => nonce = Some(value),
                Some(("s=", value)) => salt = STANDARD.decode(value).ok(),
                Some(("i=", value)) => iterations = value.parse::<u32>().ok(),
                _ => return Err(protocol()),
            }
        }
        let (Some(nonce), Some(salt), Some(iterations)) = (nonce, salt, iterations) else {
            return Err(protocol());
        };
        if !nonce.starts_with(client_nonce)
            || nonce.len() == client_nonce.len()
            || salt.is_empty()
            || iterations == 0
            || iterations > MAX_ITERATIONS
        {
            return Err(protocol());
        }
        let without_proof = format!("c=biws,r={nonce}");
        let message = format!("{first_bare},{server_first},{without_proof}");
        let salted = salted(password, &salt, iterations);
        let mut client_key = mac(&salted.0, b"Client Key");
        let stored_key: [u8; 32] = Sha256::digest(client_key).into();
        let signature = mac(&stored_key, message.as_bytes());
        let mut proof = [0u8; 32];
        for (index, byte) in proof.iter_mut().enumerate() {
            *byte = client_key[index] ^ signature[index];
        }
        wipe(&mut client_key);
        let server = mac(&mac(&salted.0, b"Server Key"), message.as_bytes());
        Ok((
            format!("{without_proof},p={}", STANDARD.encode(proof)),
            server,
            Verifier {
                salt,
                iterations,
                stored_key,
            },
        ))
    }
    /// Whether PostgreSQL's final message proves the server signature.
    pub(super) fn server_proved(server_final: &str, expected: &[u8; 32]) -> bool {
        server_final
            .strip_prefix("v=")
            .and_then(|value| STANDARD.decode(value).ok())
            .is_some_and(|value| value == expected)
    }
}
use scram::Verifier;

/// One authenticated PostgreSQL session of a database and role, reserved as a gateway session.
struct Backend {
    lease: SessionLease,
    actions: watch::Receiver<Action>,
    postgres: TlsStream<TcpStream>,
    database: String,
    user: String,
    /// The fence epoch the session was admitted at.
    epoch: (u64, u64),
    verifier: Verifier,
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
        wake_path: "warm",
        statements: 0,
        received,
        dial: None,
        authentication: None,
        query: None,
    };
    let (answer, backend) = handle(&mut socket, head, &gateway, &stop, permit, &mut stages).await;
    let (status, body) = match answer {
        Ok(body) => {
            stages.outcome = "ok";
            (200, body)
        }
        Err(refusal) => {
            stages.outcome = refusal.outcome;
            (400, refusal.body)
        }
    };
    let bytes = serde_json::to_vec(&body)?;
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
type Answer = (Result<Value, Refused>, Option<(Backend, u8)>);
async fn handle(
    socket: &mut TcpStream,
    head: HttpHead,
    gateway: &Arc<Gateway>,
    stop: &watch::Receiver<bool>,
    permit: OwnedSemaphorePermit,
    stages: &mut Stages,
) -> Answer {
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
    let request = attempt!(parse(&body.0));
    let request_bytes = body.0.len();
    drop(body);
    stages.statements = request.statements.len();
    let (claims, released) = match route {
        Route::Admitted(claims) => (claims, None),
        Route::Wake(ticket) => {
            let (claims, pod) = attempt!(wake(gateway, &ticket, stop, stages).await);
            (claims, Some(pod))
        }
    };
    let (target, epoch) = attempt!(current(gateway, &claims, released.as_deref()).await);
    let mut backend = match checkout(gateway, &claims, &target, epoch, &request.password.0).await {
        Some(backend) => {
            stages.pooled = true;
            backend
        }
        None => attempt!(
            open(
                gateway,
                &claims,
                &target,
                epoch,
                &request.password.0,
                stages
            )
            .await
        ),
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
        Ok((Ok(mut results), status)) if results.len() == statements.len() => {
            // A single statement answers its result; a transaction the list of them.
            let answer = if transaction.is_some() {
                json!({ "results": results })
            } else {
                results.swap_remove(0)
            };
            (Ok(answer), Some((backend, status)))
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

enum Route {
    Admitted(RouteClaims),
    Wake(WakeClaims),
}
impl Route {
    fn database(&self) -> &str {
        match self {
            Route::Admitted(claims) => &claims.db,
            Route::Wake(ticket) => &ticket.db,
        }
    }
}
/// The route the Edge signed, used once.
fn admitted_route(head: &HttpHead, gateway: &Gateway) -> Result<Route, Refused> {
    let denied = || refused("route_denied", "08006", "gateway connection failed");
    if head.count("x-pgcf-route") > 1 {
        return Err(denied());
    }
    let token = head.one("x-pgcf-route");
    let keys = &gateway.config.keyring.keys;
    let region = &gateway.config.region;
    let (route, claims) = if token
        .is_some_and(|token| token.starts_with(&format!("{}.", wake::ROUTE_PREFIX)))
    {
        let ticket =
            wake::verify_wake(token, keys, region, control::now()).map_err(|_| denied())?;
        let claims = ticket.admitted(None);
        (Route::Wake(ticket), claims)
    } else {
        let claims = verify(token, keys, region, control::now() as f64).map_err(|_| denied())?;
        (Route::Admitted(claims.clone()), claims)
    };
    gateway
        .admission
        .lock()
        .unwrap()
        .replay
        .use_token(&claims, control::now())
        .map_err(|_| denied())?;
    Ok(route)
}
/// The request body, by Content-Length or chunked. Every buffer that held it is wiped.
async fn read_body(socket: &mut TcpStream, head: HttpHead) -> Result<Secret, Refused> {
    let HttpHead {
        headers,
        prefix,
        end,
        ..
    } = head;
    let prefix = Secret(prefix);
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
        let mut raw = Secret(Vec::with_capacity(MAX_REQUEST_BYTES + 64 * 1024));
        raw.0.extend_from_slice(&prefix.0[end..]);
        let mut body = Secret(Vec::with_capacity(MAX_REQUEST_BYTES));
        let mut offset = 0;
        let deadline = tokio::time::Instant::now() + BODY_BOUND;
        loop {
            // Parses what has arrived; reads more only when a chunk is incomplete.
            match httparse::parse_chunk_size(&raw.0[offset..]) {
                Ok(httparse::Status::Complete((consumed, 0))) => {
                    // The last chunk; trailers are not accepted.
                    while raw.0.len() < offset + consumed + 2 {
                        read_more(socket, &mut raw, deadline).await?;
                    }
                    if &raw.0[offset + consumed..offset + consumed + 2] != b"\r\n" {
                        return Err(invalid("invalid request"));
                    }
                    return Ok(body);
                }
                Ok(httparse::Status::Complete((consumed, size))) => {
                    let size = usize::try_from(size).map_err(|_| too_large())?;
                    if size > MAX_REQUEST_BYTES - body.0.len() {
                        return Err(too_large());
                    }
                    let start = offset + consumed;
                    while raw.0.len() < start + size + 2 {
                        read_more(socket, &mut raw, deadline).await?;
                    }
                    if &raw.0[start + size..start + size + 2] != b"\r\n" {
                        return Err(invalid("invalid request"));
                    }
                    body.0.extend_from_slice(&raw.0[start..start + size]);
                    offset = start + size + 2;
                }
                Ok(httparse::Status::Partial) => {
                    if raw.0.len() - offset > 1024 {
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
    if prefix.0.len() - end > length {
        return Err(invalid("invalid request"));
    }
    // Sized once: a reallocation would leave an unwiped copy behind.
    let mut body = Secret(Vec::with_capacity(length));
    body.0.extend_from_slice(&prefix.0[end..]);
    let filled = body.0.len();
    body.0.resize(length, 0);
    match timeout(BODY_BOUND, socket.read_exact(&mut body.0[filled..])).await {
        Ok(Ok(_)) => Ok(body),
        _ => Err(invalid("incomplete request")),
    }
}
async fn read_more(
    socket: &mut TcpStream,
    raw: &mut Secret,
    deadline: tokio::time::Instant,
) -> Result<(), Refused> {
    if raw.0.len() >= raw.0.capacity() {
        return Err(refused(
            "request_too_large",
            "54000",
            "request is too large",
        ));
    }
    let mut chunk = Secret(vec![0; (raw.0.capacity() - raw.0.len()).min(64 * 1024)]);
    match tokio::time::timeout_at(deadline, socket.read(&mut chunk.0)).await {
        Ok(Ok(length)) if length > 0 => {
            raw.0.extend_from_slice(&chunk.0[..length]);
            Ok(())
        }
        _ => Err(invalid("incomplete request")),
    }
}

/// Waits, as a held WebSocket connection does, until the fence releases the ticket's wake; the
/// answer is the route the request is admitted under and the released Pod.
async fn wake(
    gateway: &Arc<Gateway>,
    ticket: &WakeClaims,
    stop: &watch::Receiver<bool>,
    stages: &mut Stages,
) -> Result<(RouteClaims, String), Refused> {
    let released = |pod: String, slot: bool, route_revision: u64, stages: &mut Stages| {
        if slot {
            stages.wake_path = "pool_hit";
        }
        let claims = transport::admitted_wake(ticket, &pod, route_revision);
        (claims, pod)
    };
    // Released at its generation already: routed at once, as a running database is.
    match transport::wake_state(gateway, ticket).await {
        WakeState::Released {
            pod,
            route_revision,
            ..
        } => return Ok(released(pod, false, route_revision, stages)),
        WakeState::Stale => return Err(not_accepting("route_stale")),
        WakeState::Waiting => {}
    }
    stages.wake_path = "pool_miss";
    let deadline = tokio::time::Instant::from_std(stages.received + transport::WAKE_BOUND);
    let mut held = gateway
        .wakes
        .hold(ticket, control::now(), Instant::now())
        .map_err(|_| not_accepting("wake_capacity"))?;
    let mut stop = stop.clone();
    loop {
        // Armed before the fence is read, so a change between the read and the wait wakes it.
        let fences_changed = gateway.fences.read().await.changed.clone();
        let targets_changed = gateway.targets.read().await.changed.clone();
        let fences = fences_changed.notified();
        let targets = targets_changed.notified();
        tokio::pin!(fences, targets);
        fences.as_mut().enable();
        targets.as_mut().enable();
        if gateway.draining.load(Ordering::Acquire) || *stop.borrow() {
            return Err(refused("gateway_draining", "08006", "gateway restarting"));
        }
        if held
            .verdict()
            .is_some_and(|result| result.outcome == Outcome::Refused)
        {
            return Err(not_accepting("wake_refused"));
        }
        match transport::wake_state(gateway, ticket).await {
            WakeState::Released {
                pod,
                slot,
                route_revision,
            } => {
                let _ = held.release();
                return Ok(released(pod, slot, route_revision, stages));
            }
            WakeState::Stale => return Err(not_accepting("route_stale")),
            WakeState::Waiting => {}
        }
        tokio::select! {
            _ = fences.as_mut() => {},
            _ = targets.as_mut() => {},
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
/// The writer the route was admitted on, if the fence and the watches still show it, and the
/// fence epoch it is admitted at.
async fn current(
    gateway: &Gateway,
    claims: &RouteClaims,
    released: Option<&str>,
) -> Result<(TargetIdentity, (u64, u64)), Refused> {
    let state = gateway.fences.read().await;
    let epoch = state.bound_epoch(&claims.db);
    if gateway.draining.load(Ordering::Acquire) || !state.admits(&claims.db) {
        return Err(not_accepting("fenced"));
    }
    let revision_current = transport::route_revision_current(&state, claims);
    drop(state);
    let target = gateway
        .targets
        .read()
        .await
        .target(&claims.db)
        .map_err(|_| not_accepting("target_unavailable"))?;
    if !revision_current
        || released.is_some_and(|pod| target.pod_uid != pod)
        || !transport::route_target_current(claims, &target)
        || !transport::admitted_runtime_current(&*gateway.fences.read().await, claims, &target)
    {
        return Err(not_accepting("route_stale"));
    }
    Ok((target, epoch))
}

/// An idle session of the route's database and role on the same writer and fence epoch whose
/// verifier the password matches. Only the newest session's verifier is derived: the sessions of
/// one role share it unless its password was rotated.
async fn checkout(
    gateway: &Gateway,
    claims: &RouteClaims,
    target: &TargetIdentity,
    epoch: (u64, u64),
    password: &[u8],
) -> Option<Backend> {
    let key = (claims.db.clone(), claims.user.clone());
    let newest = {
        let mut parked = gateway.sql.parked.lock().unwrap();
        let sessions = parked.get_mut(&key)?;
        sessions.retain(|session| !session.take.is_closed());
        sessions.last()?.verifier.clone()
    };
    let derived = Verifier::of(password, newest.salt.clone(), newest.iterations);
    loop {
        let parked = {
            let mut parked = gateway.sql.parked.lock().unwrap();
            let sessions = parked.get_mut(&key)?;
            let index = sessions.iter().rposition(|session| {
                session.verifier.salt == derived.salt
                    && session.verifier.iterations == derived.iterations
                    && session.verifier.same(&derived.stored_key)
            })?;
            sessions.remove(index)
        };
        let (reply, taken) = oneshot::channel();
        if parked.take.send(reply).is_err() {
            continue;
        }
        let Ok(backend) = taken.await else {
            continue;
        };
        if backend.epoch == epoch
            && backend.lease.target.pod_uid == target.pod_uid
            && backend.authenticated.elapsed() < LIFETIME
            && gateway
                .targets
                .read()
                .await
                .permits(&claims.db, &backend.lease.target)
        {
            return Some(backend);
        }
        terminate(backend).await;
    }
}
/// Dials the admitted writer and authenticates a new session with the request's password.
async fn open(
    gateway: &Arc<Gateway>,
    claims: &RouteClaims,
    target: &TargetIdentity,
    epoch: (u64, u64),
    password: &[u8],
    stages: &mut Stages,
) -> Result<Backend, Refused> {
    let database = &claims.db;
    let capacity = || refused("admission_denied", "53300", "too many connections");
    let memory = transport::session_memory(gateway, database).ok_or_else(capacity)?;
    let wire = WireBudget::new(gateway.memory.lease(database));
    let (lease, actions) = gateway
        .reserve(claims, wire, target, false)
        .map_err(|_| capacity())?;
    let admitted = {
        let state = gateway.fences.read().await;
        if state.bound_epoch(database) != epoch
            || !state.admits(database)
            || !transport::admitted_runtime_current(&state, claims, target)
        {
            return Err(not_accepting("fenced"));
        }
        (claims.v == 4)
            .then(|| {
                state
                    .records
                    .get(database)
                    .and_then(|fence| fence.admission_target.clone())
            })
            .flatten()
    };
    // The route was checked against this writer; a replacement is never dialled.
    if !gateway.targets.read().await.permits(database, target) {
        return Err(not_accepting("target_changed"));
    }
    gateway
        .sessions
        .lock()
        .unwrap()
        .update(&lease.id, false, true, true);
    let dialing = Instant::now();
    let dialed = timeout(
        transport::STARTUP_BOUND,
        gateway
            .dial
            .dial(&transport::database_target(database, target, admitted)),
    )
    .await;
    stages.dial = Some(dialing.elapsed());
    let Ok(Ok(postgres)) = dialed else {
        return Err(connection_failed("postgres_connect_error"));
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
        epoch,
        verifier: Verifier {
            salt: Vec::new(),
            iterations: 0,
            stored_key: [0; 32],
        },
        authenticated: Instant::now(),
        _memory: memory,
    };
    let authenticating = Instant::now();
    let authenticated = timeout(
        transport::STARTUP_BOUND,
        authenticate(gateway, &mut backend, password),
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
/// A frontend message whose body holds the password; the buffer is wiped when dropped.
fn password_message(body: &[u8]) -> Secret {
    let mut out = Secret(Vec::with_capacity(body.len() + 5));
    message(&mut out.0, b'p', body);
    out
}
async fn authenticate(
    gateway: &Gateway,
    backend: &mut Backend,
    password: &[u8],
) -> Result<Verifier, Refused> {
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
    write_guarded(gateway, backend, &bytes)
        .await
        .map_err(|_| failed())?;
    let mut first: Option<String> = None;
    let mut expected: Option<[u8; 32]> = None;
    let mut verifier: Option<Verifier> = None;
    let mut authenticated = false;
    loop {
        let (tag, body) = read_message(&mut backend.postgres)
            .await
            .map_err(|_| failed())?;
        match tag {
            b'R' if body.len() >= 4 => {
                let data = &body[4..];
                match u32::from_be_bytes(body[..4].try_into().unwrap()) {
                    0 => {
                        if expected.is_some() {
                            return Err(protocol());
                        }
                        authenticated = true;
                    }
                    3 => {
                        let mut secret = Secret(password.to_vec());
                        secret.0.push(0);
                        let reply = password_message(&secret.0);
                        write_guarded(gateway, backend, &reply.0)
                            .await
                            .map_err(|_| failed())?;
                        verifier = Some(Verifier::local(password)?);
                    }
                    10 => {
                        if !data
                            .split(|b| *b == 0)
                            .any(|mechanism| mechanism == b"SCRAM-SHA-256")
                        {
                            return Err(protocol());
                        }
                        let (client_first, bare) = scram::client_first("")?;
                        let mut initial = b"SCRAM-SHA-256\0".to_vec();
                        initial.extend_from_slice(&(client_first.len() as u32).to_be_bytes());
                        initial.extend_from_slice(client_first.as_bytes());
                        let mut reply = Vec::new();
                        message(&mut reply, b'p', &initial);
                        write_guarded(gateway, backend, &reply)
                            .await
                            .map_err(|_| failed())?;
                        first = Some(bare);
                    }
                    11 => {
                        let bare = first.take().ok_or_else(protocol)?;
                        let server_first = std::str::from_utf8(data).map_err(|_| protocol())?;
                        let (last, server, derived) =
                            scram::client_final(password, &bare, server_first)?;
                        let reply = password_message(last.as_bytes());
                        write_guarded(gateway, backend, &reply.0)
                            .await
                            .map_err(|_| failed())?;
                        expected = Some(server);
                        verifier = Some(derived);
                    }
                    12 => {
                        let server_final = std::str::from_utf8(data).map_err(|_| protocol())?;
                        if !expected
                            .take()
                            .is_some_and(|expected| scram::server_proved(server_final, &expected))
                        {
                            return Err(protocol());
                        }
                    }
                    _ => {
                        return Err(refused(
                            "authentication_method",
                            "08006",
                            "unsupported authentication method",
                        ));
                    }
                }
            }
            b'E' => {
                let error = error_fields(&body);
                return Err(if error["code"] == "28P01" {
                    authentication_failed()
                } else {
                    Refused {
                        outcome: "postgres_startup_error",
                        body: error,
                    }
                });
            }
            b'S' | b'K' | b'N' => {}
            b'Z' if authenticated => {
                // A server that asked for no password is recognised by a verifier of its own.
                return match verifier {
                    Some(verifier) => Ok(verifier),
                    None => Verifier::local(password),
                };
            }
            _ => return Err(protocol()),
        }
    }
}
/// Writes to PostgreSQL only while the fence still admits the session's database at the epoch it
/// was admitted at and the watches still show its writer, holding both for the bounded write.
async fn write_guarded(
    gateway: &Gateway,
    backend: &mut Backend,
    bytes: &[u8],
) -> Result<(), Guard> {
    let state = gateway.fences.read().await;
    let physical = gateway.targets.read().await;
    if !physical.permits(&backend.database, &backend.lease.target)
        || state.bound_epoch(&backend.database) != backend.epoch
        || !state.admits(&backend.database)
    {
        return Err(Guard::Fenced);
    }
    let written = timeout(
        transport::WRITE_BOUND,
        transport::write_upstream(&mut backend.postgres, bytes),
    )
    .await;
    drop(physical);
    drop(state);
    match written {
        Ok(Ok(())) => Ok(()),
        _ => Err(Guard::Lost),
    }
}
enum Guard {
    /// Nothing was written.
    Fenced,
    /// The write failed: its bytes may have reached PostgreSQL.
    Lost,
}
async fn read_message(postgres: &mut TlsStream<TcpStream>) -> std::io::Result<(u8, Vec<u8>)> {
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
fn data_row(body: &[u8]) -> Option<Value> {
    let count = i16::from_be_bytes(body.get(..2)?.try_into().ok()?);
    let mut rest = &body[2..];
    let mut values = Vec::new();
    for _ in 0..count {
        let length = i32::from_be_bytes(rest.get(..4)?.try_into().ok()?);
        rest = &rest[4..];
        if length < 0 {
            values.push(Value::Null);
        } else {
            let value = rest.get(..length as usize)?;
            values.push(String::from_utf8_lossy(value).into());
            rest = &rest[length as usize..];
        }
    }
    Some(Value::Array(values))
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
) -> Result<(Result<Vec<Value>, Value>, u8), Refused> {
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
    let mut memory = gateway.memory.lease(&backend.database);
    let Backend {
        postgres, actions, ..
    } = backend;
    tokio::select! {
        result = results(postgres, &mut memory) => result,
        _ = retired(actions) => Err(unknown("database_retired")),
    }
}
async fn retired(actions: &mut watch::Receiver<Action>) {
    loop {
        if *actions.borrow_and_update() == Action::Retire {
            return;
        }
        if actions.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
async fn results(
    postgres: &mut TlsStream<TcpStream>,
    memory: &mut Lease,
) -> Result<(Result<Vec<Value>, Value>, u8), Refused> {
    let mut results = Vec::new();
    let mut error = None;
    let mut current: Option<(Vec<Value>, Vec<Value>)> = None;
    let mut size = 0usize;
    let protocol = || unknown("postgres_protocol");
    loop {
        let (tag, body) = read_message(postgres)
            .await
            .map_err(|_| unknown("postgres_error"))?;
        match tag {
            b'1' | b'2' | b'3' | b'N' | b'S' | b'A' => {}
            b'T' => current = Some((row_description(&body).ok_or_else(protocol)?, Vec::new())),
            b'n' => current = Some((Vec::new(), Vec::new())),
            b'D' => {
                size += body.len();
                if size > MAX_RESPONSE_BYTES || !memory.grow(body.len()) {
                    return Err(refused(
                        "response_too_large",
                        "54000",
                        "result is too large for HTTP SQL; the connection was closed and the request's outcome is unknown",
                    ));
                }
                let row = data_row(&body).ok_or_else(protocol)?;
                current.as_mut().ok_or_else(protocol)?.1.push(row);
            }
            b'C' | b'I' => {
                // BEGIN and COMMIT are not described, so they leave no result.
                if let Some((fields, rows)) = current.take() {
                    let (command, count) = if tag == b'C' {
                        command(cstring(&body).ok_or_else(protocol)?.0)
                    } else {
                        (Value::Null, Value::Null)
                    };
                    results.push(json!({"fields":fields,"command":command,"rowCount":count,"rows":rows,"rowAsArray":true}));
                }
            }
            b'E' => {
                error.get_or_insert_with(|| error_fields(&body));
                current = None;
            }
            b'Z' => {
                let status = *body.first().ok_or_else(protocol)?;
                return Ok((error.map_or(Ok(results), Err), status));
            }
            b'G' | b'H' | b'W' => {
                return Err(refused(
                    "copy_unsupported",
                    "0A000",
                    "COPY is not supported over HTTP",
                ));
            }
            _ => return Err(protocol()),
        }
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
/// end of its lifetime, a fence action, the gateway's drain, or PostgreSQL ending it.
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
        sessions.push(Parked {
            verifier: backend.verifier.clone(),
            take,
        });
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
/// Ends a session with Terminate, close_notify and FIN; dropping it releases its reservation.
async fn terminate(mut backend: Backend) {
    let _ = timeout(
        Duration::from_millis(500),
        transport::write_upstream(&mut backend.postgres, &[b'X', 0, 0, 0, 4]),
    )
    .await;
    transport::close_upstream(&mut backend.postgres).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scram_matches_the_rfc_7677_example() {
        let (first, bare) = scram::first_with_nonce("user", "rOprNGfwEbeRWgbNEkqO");
        assert_eq!(first, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
        let server_first = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
        let (last, server, verifier) =
            scram::client_final(b"pencil", &bare, server_first).unwrap_or_else(|_| panic!());
        assert_eq!(
            last,
            "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ="
        );
        assert!(scram::server_proved(
            "v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
            &server
        ));
        assert!(!scram::server_proved("v=AAAA", &server));
        let again = Verifier::of(b"pencil", verifier.salt.clone(), 4096);
        assert!(verifier.same(&again.stored_key));
        let other = Verifier::of(b"pencil2", verifier.salt.clone(), 4096);
        assert!(!verifier.same(&other.stored_key));
    }
    #[test]
    fn scram_refuses_a_server_nonce_that_does_not_extend_the_client_nonce() {
        let (_, bare) = scram::first_with_nonce("", "abc");
        for server_first in [
            "r=xyz,s=c2FsdA==,i=4096",
            "r=abc,s=c2FsdA==,i=4096",
            "r=abcd,s=,i=4096",
            "r=abcd,s=c2FsdA==,i=0",
            "r=abcd,s=c2FsdA==,i=2000000",
            "r=abcd,s=c2FsdA==",
        ] {
            assert!(scram::client_final(b"pw", &bare, server_first).is_err());
        }
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
