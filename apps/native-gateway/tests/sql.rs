// SPDX-License-Identifier: Apache-2.0
//! HTTP SQL over real loopback TCP against a PostgreSQL double on a Unix socket, which the test
//! process serves as the database's unit. The double speaks the frontend/backend protocol with
//! real SCRAM-SHA-256 arithmetic; this is protocol conformance, not SQL acceptance.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    http,
    sessions::Action,
    transport::{self, Config, Gateway},
};
use pgcf_native_protocol::{
    agent::{Database, Mode, Writer},
    route::Keyring,
    wake::{self, Outcome, WakeResult},
    wire,
};
use pgcf_test_postgres::Directory;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    os::unix::fs::MetadataExt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UnixListener, UnixStream},
    sync::{Semaphore, watch},
    task::JoinHandle,
    time::timeout,
};
type Failure = Box<dyn std::error::Error + Send + Sync>;
const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
const REGION: &str = "eu-test";
/// The node the gateway serves, which every route names.
const NODE: &str = "nod_aaaaaaaaaaaaaaaaaaaa";
/// The unit's invocation ID, which the routes name.
const INSTANCE: &str = "01234567-89ab-4def-8123-0123456789ab";
const ROUTE_REVISION: u64 = 19;
const PASSWORD: &str = "correct horse battery";
/// The role's password after a reset.
const ROTATED: &str = "staple correct horse";
const SALT: &[u8] = b"pgcf-test-salt";
fn cid(id: usize) -> String {
    format!("01234567-89ab-4def-8123-{id:012x}")
}
fn mac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn token(prefix: &str, purpose: &str, claims: Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let signature = mac(&[7; 32], format!("{purpose}{payload}").as_bytes());
    format!("{prefix}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature))
}
/// The admission route Cloudflare signs for the fixture's running generation and unit.
fn route(id: usize) -> String {
    route_at(id, 1, ROUTE_REVISION)
}
/// The admission route for the database at `generation` and `route_revision`.
fn route_at(id: usize, generation: u64, route_revision: u64) -> String {
    let now = http::now() / 1000;
    token(
        wire("nodeRouteTokenPrefix"),
        wire("nodeRouteSignatureDomain"),
        json!({"v":6,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":generation,"route_revision":route_revision,"node":NODE,"inst":INSTANCE}),
    )
}
fn wake_operation() -> String {
    format!("op_{}", "w".repeat(20))
}
/// The wake ticket the Edge signs for a database whose Actor snapshot sits at `generation - 1`.
fn wake_token(id: usize, generation: u64) -> String {
    let now = http::now() / 1000;
    token(
        wake::ROUTE_PREFIX,
        wake::ROUTE_DOMAIN,
        json!({"v":5,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"op":wake_operation(),"gen":generation,"route_revision":ROUTE_REVISION,"rh":"c0".repeat(32)}),
    )
}
/// The agent's entry for the database: `mode` at `generation`, on `unit` while PostgreSQL runs.
fn entry(mode: Mode, generation: u64, operation: &str, unit: &Writer) -> Database {
    Database {
        database: DATABASE.into(),
        generation,
        operation: operation.into(),
        mode,
        route_revision: ROUTE_REVISION,
        writer: matches!(mode, Mode::Running | Mode::Quiesce).then(|| unit.clone()),
    }
}
fn operation() -> String {
    format!("op_{}", "b".repeat(20))
}

/// What the PostgreSQL double saw, in order: startups, authentication results, every extended
/// query message, simple queries and session ends. It never records the password.
#[derive(Clone, Default)]
struct Journal(Arc<Mutex<Vec<String>>>);
impl Journal {
    fn push(&self, entry: String) {
        self.0.lock().unwrap().push(entry);
    }
    fn entries(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
    fn count(&self, entry: &str) -> usize {
        self.entries().iter().filter(|e| *e == entry).count()
    }
}
fn pbkdf2(password: &[u8], salt: &[u8], iterations: u32) -> Vec<u8> {
    let mut block = salt.to_vec();
    block.extend_from_slice(&1u32.to_be_bytes());
    let mut u = mac(password, &block);
    let mut result = u.clone();
    for _ in 1..iterations {
        u = mac(password, &u);
        for (r, v) in result.iter_mut().zip(&u) {
            *r ^= v;
        }
    }
    result
}
async fn send(stream: &mut UnixStream, tag: u8, body: &[u8]) -> std::io::Result<()> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    stream.write_all(&bytes).await
}
async fn receive(stream: &mut UnixStream) -> std::io::Result<(u8, Vec<u8>)> {
    let tag = stream.read_u8().await?;
    let length = stream.read_u32().await? as usize;
    let mut body = vec![0; length - 4];
    stream.read_exact(&mut body).await?;
    Ok((tag, body))
}
fn error(severity: &str, code: &str, message: &str, extra: &[(u8, &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (field, value) in [
        (b'S', severity),
        (b'V', severity),
        (b'C', code),
        (b'M', message),
    ]
    .into_iter()
    .chain(extra.iter().copied())
    {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    body
}
fn complete(tag: &str) -> Vec<u8> {
    let mut body = tag.as_bytes().to_vec();
    body.push(0);
    body
}
fn row_description(columns: &[(&str, u32, i16)]) -> Vec<u8> {
    let mut body = (columns.len() as i16).to_be_bytes().to_vec();
    for (name, oid, size) in columns {
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(&0u32.to_be_bytes());
        body.extend_from_slice(&0i16.to_be_bytes());
        body.extend_from_slice(&oid.to_be_bytes());
        body.extend_from_slice(&size.to_be_bytes());
        body.extend_from_slice(&(-1i32).to_be_bytes());
        body.extend_from_slice(&0i16.to_be_bytes());
    }
    body
}
fn data_row(values: &[Option<&[u8]>]) -> Vec<u8> {
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
fn strings(body: &[u8]) -> Vec<String> {
    body.split(|b| *b == 0)
        .map(|part| String::from_utf8(part.to_vec()).unwrap())
        .collect()
}
/// The server side of SCRAM-SHA-256 for `password`; true when the client proved it.
async fn scram(stream: &mut UnixStream, password: &str) -> Result<bool, Failure> {
    let mut mechanisms = 10u32.to_be_bytes().to_vec();
    mechanisms.extend_from_slice(b"SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0");
    send(stream, b'R', &mechanisms).await?;
    let (tag, initial) = receive(stream).await?;
    assert_eq!(tag, b'p');
    let nul = initial.iter().position(|b| *b == 0).unwrap();
    assert_eq!(&initial[..nul], b"SCRAM-SHA-256");
    let first = std::str::from_utf8(&initial[nul + 5..])?.to_string();
    let bare = first.strip_prefix("n,,").expect("no channel binding");
    let client_nonce = bare
        .strip_prefix("n=,r=")
        .expect("client-first-message-bare");
    let nonce = format!("{client_nonce}server");
    let server_first = format!("r={nonce},s={},i=4096", STANDARD.encode(SALT));
    let mut continuing = 11u32.to_be_bytes().to_vec();
    continuing.extend_from_slice(server_first.as_bytes());
    send(stream, b'R', &continuing).await?;
    let (tag, last) = receive(stream).await?;
    assert_eq!(tag, b'p');
    let last = String::from_utf8(last)?;
    let (without_proof, proof) = last.rsplit_once(",p=").unwrap();
    assert_eq!(without_proof, format!("c=biws,r={nonce}"));
    let salted = pbkdf2(password.as_bytes(), SALT, 4096);
    let stored = Sha256::digest(mac(&salted, b"Client Key")).to_vec();
    let message = format!("{bare},{server_first},{without_proof}");
    let signature = mac(&stored, message.as_bytes());
    let recovered: Vec<u8> = STANDARD
        .decode(proof)?
        .iter()
        .zip(&signature)
        .map(|(a, b)| a ^ b)
        .collect();
    if Sha256::digest(&recovered).to_vec() != stored {
        return Ok(false);
    }
    let mut done = 12u32.to_be_bytes().to_vec();
    done.extend_from_slice(
        format!(
            "v={}",
            STANDARD.encode(mac(&mac(&salted, b"Server Key"), message.as_bytes()))
        )
        .as_bytes(),
    );
    send(stream, b'R', &done).await?;
    Ok(true)
}
/// How the double authenticates a session.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Authentication {
    /// SCRAM-SHA-256 for `PASSWORD`.
    Scram,
    /// SCRAM-SHA-256 for `ROTATED`: the role's password was reset.
    Rotated,
    /// AuthenticationCleartextPassword; what the gateway answers is journaled.
    Cleartext,
    /// No password: AuthenticationOk at once.
    Trust,
}
/// One PostgreSQL session of the double. It authenticates as `authentication` says. Queries are
/// a small fixed language: `select ...` returns its parameters as one row of text columns (or
/// `1` without parameters), `insert` inserts one row, `fail` raises 42P01 when executed, `copy`
/// starts COPY FROM STDIN, `hang` drops the connection once executed, `big` returns 12 MiB of
/// rows, `nulls` returns 1,700,000 rows of one NULL (6 bytes each on the wire).
async fn postgres_session(
    mut stream: UnixStream,
    journal: Journal,
    authentication: Authentication,
    mut gate: watch::Receiver<bool>,
) -> Result<(), Failure> {
    let length = stream.read_u32().await? as usize;
    let mut startup = vec![0; length - 4];
    stream.read_exact(&mut startup).await?;
    assert_eq!(&startup[..4], &196608u32.to_be_bytes());
    let parameters = strings(&startup[4..]);
    let pairs: Vec<String> = parameters
        .chunks(2)
        .filter(|pair| pair.len() == 2 && !pair[0].is_empty())
        .map(|pair| format!("{}={}", pair[0], pair[1]))
        .collect();
    journal.push(format!("startup:{}", pairs.join(" ")));
    // A PostgreSQL that is slow to log in: the test closes the gate and opens it when it wants
    // the login to go on.
    gate.wait_for(|open| *open).await?;
    let accepted = match authentication {
        Authentication::Scram => scram(&mut stream, PASSWORD).await?,
        Authentication::Rotated => scram(&mut stream, ROTATED).await?,
        Authentication::Cleartext => {
            send(&mut stream, b'R', &3u32.to_be_bytes()).await?;
            let answer = receive(&mut stream).await.map(|(tag, _)| tag as char);
            journal.push(format!("cleartext:{}", answer.unwrap_or('-')));
            return Ok(());
        }
        Authentication::Trust => true,
    };
    if !accepted {
        journal.push("auth:failed".into());
        let body = error(
            "FATAL",
            "28P01",
            "password authentication failed for user \"app\"",
            &[],
        );
        send(&mut stream, b'E', &body).await?;
        return Ok(());
    }
    journal.push("auth:ok".into());
    send(&mut stream, b'R', &0u32.to_be_bytes()).await?;
    send(&mut stream, b'S', b"server_version\x0017.6\0").await?;
    send(&mut stream, b'K', &[0, 0, 0, 1, 0, 0, 0, 2]).await?;
    send(&mut stream, b'Z', b"I").await?;
    let (mut block, mut failed, mut skipping) = (false, false, false);
    let mut query = String::new();
    let mut params: Vec<Option<String>> = Vec::new();
    loop {
        let Ok((tag, body)) = receive(&mut stream).await else {
            journal.push("closed".into());
            return Ok(());
        };
        if tag == b'X' {
            journal.push("terminate".into());
            return Ok(());
        }
        if tag == b'S' {
            skipping = false;
            let status = match (block, failed) {
                (true, true) => b'E',
                (true, false) => b'T',
                _ => {
                    failed = false;
                    b'I'
                }
            };
            send(&mut stream, b'Z', &[status]).await?;
            continue;
        }
        if tag == b'Q' {
            let text = strings(&body).remove(0);
            journal.push(format!("query:{text}"));
            match text.as_str() {
                "ROLLBACK" => {
                    (block, failed) = (false, false);
                    send(&mut stream, b'C', &complete("ROLLBACK")).await?;
                }
                "DISCARD ALL" if !block => {
                    send(&mut stream, b'C', &complete("DISCARD ALL")).await?
                }
                _ => panic!("unexpected simple query"),
            }
            send(&mut stream, b'Z', if block { b"T" } else { b"I" }).await?;
            continue;
        }
        if skipping {
            continue;
        }
        match tag {
            b'P' => {
                let parts = strings(&body);
                assert_eq!(parts[0], "", "unnamed statement");
                query = parts[1].clone();
                journal.push(format!("parse:{query}"));
                send(&mut stream, b'1', &[]).await?;
            }
            b'B' => {
                assert_eq!(&body[..2], &[0, 0], "unnamed portal and statement");
                assert_eq!(&body[2..4], &[0, 0], "all parameters in text");
                let count = i16::from_be_bytes([body[4], body[5]]) as usize;
                let mut offset = 6;
                params.clear();
                for _ in 0..count {
                    let length = i32::from_be_bytes(body[offset..offset + 4].try_into().unwrap());
                    offset += 4;
                    if length < 0 {
                        params.push(None);
                    } else {
                        let value = &body[offset..offset + length as usize];
                        params.push(Some(String::from_utf8(value.to_vec()).unwrap()));
                        offset += length as usize;
                    }
                }
                assert_eq!(&body[offset..], &[0, 0], "all results in text");
                journal.push(format!("bind:{}", json!(params)));
                send(&mut stream, b'2', &[]).await?;
            }
            b'D' => {
                assert_eq!(body, b"P\0");
                if query.starts_with("select") {
                    let columns: Vec<(String, u32, i16)> = if params.is_empty() {
                        vec![("?column?".into(), 23, 4)]
                    } else {
                        (1..=params.len())
                            .map(|n| (format!("c{n}"), 25, -1))
                            .collect()
                    };
                    let columns: Vec<(&str, u32, i16)> = columns
                        .iter()
                        .map(|(n, o, s)| (n.as_str(), *o, *s))
                        .collect();
                    send(&mut stream, b'T', &row_description(&columns)).await?;
                } else if query == "big" || query == "nulls" {
                    send(&mut stream, b'T', &row_description(&[("x", 25, -1)])).await?;
                } else {
                    send(&mut stream, b'n', &[]).await?;
                }
            }
            b'E' => {
                journal.push(format!("execute:{query}"));
                match query.as_str() {
                    q if q.starts_with("BEGIN") => {
                        block = true;
                        send(&mut stream, b'C', &complete("BEGIN")).await?;
                    }
                    "COMMIT" => {
                        block = false;
                        send(&mut stream, b'C', &complete("COMMIT")).await?;
                    }
                    q if q.starts_with("select") => {
                        let values: Vec<Option<&[u8]>> = if params.is_empty() {
                            vec![Some(b"1")]
                        } else {
                            params
                                .iter()
                                .map(|v| v.as_ref().map(|v| v.as_bytes()))
                                .collect()
                        };
                        send(&mut stream, b'D', &data_row(&values)).await?;
                        send(&mut stream, b'C', &complete("SELECT 1")).await?;
                    }
                    "insert" => send(&mut stream, b'C', &complete("INSERT 0 1")).await?,
                    "fail" => {
                        let body = error(
                            "ERROR",
                            "42P01",
                            "relation \"missing\" does not exist",
                            &[
                                (b'P', "15"),
                                (b'F', "parse_relation.c"),
                                (b'R', "parserOpenTable"),
                            ],
                        );
                        send(&mut stream, b'E', &body).await?;
                        (failed, skipping) = (true, true);
                    }
                    "copy" => send(&mut stream, b'G', &[0, 0, 0]).await?,
                    "hang" => return Ok(()),
                    "big" => {
                        let value = vec![b'x'; 1024 * 1024];
                        for _ in 0..12 {
                            send(&mut stream, b'D', &data_row(&[Some(&value)])).await?;
                        }
                        send(&mut stream, b'C', &complete("SELECT 12")).await?;
                    }
                    "nulls" => {
                        let mut rows = Vec::new();
                        for _ in 0..1_700_000 {
                            rows.push(b'D');
                            rows.extend_from_slice(&10u32.to_be_bytes());
                            rows.extend_from_slice(&data_row(&[None]));
                        }
                        stream.write_all(&rows).await?;
                        send(&mut stream, b'C', &complete("SELECT 1700000")).await?;
                    }
                    _ => panic!("unexpected query"),
                }
            }
            _ => panic!("unexpected frontend message {tag}"),
        }
    }
}

struct Fixture {
    gateway: Arc<Gateway>,
    port: u16,
    /// The unit the double serves: its socket, this process's uid and PID.
    unit: Writer,
    /// PostgreSQL connections the gateway dialled.
    calls: Arc<AtomicUsize>,
    journal: Journal,
    /// How the double authenticates the sessions it accepts next.
    authentication: Arc<Mutex<Authentication>>,
    /// While it is closed, the double does not answer a StartupMessage.
    gate: watch::Sender<bool>,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    _directory: Directory,
}
impl Fixture {
    async fn new() -> Self {
        Self::with(Mode::Running).await
    }
    /// The database `mode` at generation 1; a sleeping one has no unit.
    async fn with(mode: Mode) -> Self {
        let directory = Directory::new("sql");
        let socket = directory.path().join(".s.PGSQL.5432");
        let upstream = UnixListener::bind(&socket).unwrap();
        let unit = Writer {
            socket: socket.display().to_string(),
            uid: std::fs::metadata(directory.path()).unwrap().uid(),
            pid: std::process::id(),
            instance: INSTANCE.into(),
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let gateway = Gateway::new(Arc::new(Config {
            region: REGION.into(),
            node: NODE.into(),
            keyring: Keyring {
                active: "test".into(),
                keys: HashMap::from([("test".into(), vec![7; 32])]),
            },
            maximum_memory: 192 * 1024 * 1024,
            database_memory: 96 * 1024 * 1024,
        }));
        gateway
            .table
            .write()
            .await
            .replace(vec![entry(mode, 1, &operation(), &unit)]);
        let journal = Journal::default();
        let (stop, receiver) = watch::channel(false);
        let recorder = journal.clone();
        let counted = calls.clone();
        let authentication = Arc::new(Mutex::new(Authentication::Scram));
        let asks = authentication.clone();
        let (gate, open) = watch::channel(true);
        let mut shutdown = receiver.clone();
        let upstream_task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = upstream.accept() => {
                        let (stream, _) = accepted.unwrap();
                        counted.fetch_add(1, Ordering::SeqCst);
                        let (journal, authentication, open) = (recorder.clone(), *asks.lock().unwrap(), open.clone());
                        tasks.spawn(async move { let _ = postgres_session(stream, journal, authentication, open).await; });
                    }
                }
            }
            tasks.abort_all();
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let run = gateway.clone();
        let mut shutdown = receiver.clone();
        let gateway_task = tokio::spawn(async move {
            let pending = Arc::new(Semaphore::new(128));
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let (gateway, receiver, permit) = (run.clone(), shutdown.clone(), pending.clone().acquire_owned().await.unwrap());
                        tasks.spawn(async move { let _ = transport::serve_socket(socket, gateway, receiver, permit).await; });
                    }
                }
            }
            tasks.abort_all();
        });
        Self {
            gateway,
            port,
            unit,
            calls,
            journal,
            authentication,
            gate,
            stop,
            tasks: vec![upstream_task, gateway_task],
            _directory: directory,
        }
    }
    async fn sql(&self, route: &str, body: &Value) -> (u16, Value) {
        post(self.port, route, body.to_string().as_bytes()).await
    }
    /// Waits until the database has `connections` gateway sessions, none of them busy: the
    /// pooled ones wait idle for their next request.
    async fn idle(&self, connections: usize) {
        timeout(Duration::from_secs(5), async {
            loop {
                let counts = self.gateway.sessions.lock().unwrap().counts(DATABASE);
                if counts.connections == connections && counts.busy == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("sessions did not settle");
    }
    async fn stop(self) {
        let _ = self.stop.send(true);
        for task in self.tasks {
            task.await.unwrap();
        }
    }
}
/// One `POST /sql` as the Edge sends it: the route header and a sized JSON body.
async fn post(port: u16, route: &str, body: &[u8]) -> (u16, Value) {
    let (status, body) = post_bytes(port, route, body).await;
    (status, serde_json::from_slice(&body).unwrap())
}
async fn post_bytes(port: u16, route: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let mut request = format!(
        "POST /sql HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-PGCF-Route: {route}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    request.extend_from_slice(body);
    exchange_bytes(port, &request).await
}
async fn exchange(port: u16, request: &[u8]) -> (u16, Value) {
    let (status, body) = exchange_bytes(port, request).await;
    (status, serde_json::from_slice(&body).unwrap())
}
async fn exchange_bytes(port: u16, request: &[u8]) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(20), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    let header = std::str::from_utf8(&bytes[..split]).unwrap();
    assert!(header.contains("Content-Type: application/json"));
    let status = header.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, bytes[split..].to_vec())
}
fn body(password: &str, queries: &[(&str, Value)], transaction: Option<Value>) -> Value {
    json!({
        "password": URL_SAFE_NO_PAD.encode(password),
        "queries": queries.iter().map(|(query, params)| json!({"query":query,"params":params})).collect::<Vec<_>>(),
        "transaction": transaction,
    })
}
fn text_field(name: &str) -> Value {
    json!({"name":name,"dataTypeID":25,"tableID":0,"columnID":0,"dataTypeSize":-1,"dataTypeModifier":-1,"format":"text"})
}

#[tokio::test]
async fn a_single_query_answers_in_the_neon_http_format_after_scram() {
    let fixture = Fixture::new().await;
    let (status, answer) = fixture
        .sql(
            &route(1),
            &body(PASSWORD, &[("select $1, $2", json!(["x", null]))], None),
        )
        .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer,
        json!({"fields":[text_field("c1"),text_field("c2")],"command":"SELECT","rowCount":1,"rows":[["x",null]],"rowAsArray":true})
    );
    fixture.idle(1).await;
    let journal = fixture.journal.entries();
    assert_eq!(
        journal[..6],
        [
            format!("startup:user=app database={DATABASE} client_encoding=UTF8"),
            "auth:ok".into(),
            "parse:select $1, $2".into(),
            "bind:[\"x\",null]".into(),
            "execute:select $1, $2".into(),
            "query:DISCARD ALL".into(),
        ]
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_batch_runs_in_one_transaction_with_the_requested_characteristics() {
    let fixture = Fixture::new().await;
    let (status, answer) = fixture
        .sql(
            &route(2),
            &body(
                PASSWORD,
                &[("insert", json!([])), ("select", json!([]))],
                Some(json!({"isolation":"Serializable","read_only":true,"deferrable":true})),
            ),
        )
        .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        answer,
        json!({"results":[
            {"fields":[],"command":"INSERT","rowCount":1,"rows":[],"rowAsArray":true},
            {"fields":[{"name":"?column?","dataTypeID":23,"tableID":0,"columnID":0,"dataTypeSize":4,"dataTypeModifier":-1,"format":"text"}],"command":"SELECT","rowCount":1,"rows":[["1"]],"rowAsArray":true},
        ]})
    );
    let executed: Vec<String> = fixture
        .journal
        .entries()
        .into_iter()
        .filter(|e| e.starts_with("execute:"))
        .collect();
    assert_eq!(
        executed,
        [
            "execute:BEGIN ISOLATION LEVEL SERIALIZABLE, READ ONLY, DEFERRABLE",
            "execute:insert",
            "execute:select",
            "execute:COMMIT"
        ]
    );
    // Without characteristics the batch is a plain transaction.
    fixture.idle(1).await;
    let (status, _) = fixture
        .sql(
            &route(3),
            &body(PASSWORD, &[("insert", json!([]))], Some(json!({}))),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(fixture.journal.count("execute:BEGIN"), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_wrong_password_is_refused_as_28p01_and_no_session_is_kept() {
    let fixture = Fixture::new().await;
    // Byte for byte the Edge decoy's answer (apps/edge/test/sql.test.ts): a refused password and
    // an unknown database or role cannot be told apart.
    let decoy =
        br#"{"message":"password authentication failed","code":"28P01","severity":"FATAL"}"#;
    let request = body("wrong", &[("select", json!([]))], None).to_string();
    let (status, answer) = post_bytes(fixture.port, &route(4), request.as_bytes()).await;
    assert_eq!((status, answer.as_slice()), (400, decoy.as_slice()));
    assert_eq!(fixture.journal.count("auth:failed"), 1);
    fixture.idle(0).await;
    // A password the gateway refuses before PostgreSQL answers the same bytes.
    let request = json!({"password":URL_SAFE_NO_PAD.encode("a\0b"),"queries":[{"query":"select","params":[]}]}).to_string();
    let (status, answer) = post_bytes(fixture.port, &route(25), request.as_bytes()).await;
    assert_eq!((status, answer.as_slice()), (400, decoy.as_slice()));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_pooled_session_is_reused_only_for_its_password_and_closes_when_the_database_sleeps() {
    let fixture = Fixture::new().await;
    let request = body(PASSWORD, &[("select", json!([]))], None);
    assert_eq!(fixture.sql(&route(5), &request).await.0, 200);
    fixture.idle(1).await;
    assert_eq!(fixture.sql(&route(6), &request).await.0, 200);
    fixture.idle(1).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.journal.count("auth:ok"), 1);
    assert_eq!(fixture.journal.count("query:DISCARD ALL"), 2);
    // Another password never takes the pooled session: PostgreSQL decides on a new one.
    let (status, answer) = fixture
        .sql(&route(7), &body("guess", &[("select", json!([]))], None))
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("28P01")));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.idle(1).await;
    assert_eq!(fixture.sql(&route(8), &request).await.0, 200);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.idle(1).await;
    // The agent closes idle sessions when it puts the database to sleep.
    fixture
        .gateway
        .sessions
        .lock()
        .unwrap()
        .signal(DATABASE, Action::CloseIdle);
    fixture.idle(0).await;
    timeout(Duration::from_secs(5), async {
        while fixture.journal.count("terminate") != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_pooled_session_is_reused_across_a_route_revision_but_not_across_a_generation() {
    // The page that carries Cloudflare's claim of a wake moves the route revision of the entry
    // and nothing else: the pooled session goes on. A role change (resetPassword) moves the
    // generation on the unit that runs, and the agent publishes it on the same writer without
    // ending the sessions of the role: PostgreSQL has a new verifier, the pooled session proved
    // the old one and is never asked again. A request at the new generation logs in itself, and
    // PostgreSQL refuses the password that was reset.
    let fixture = Fixture::new().await;
    let request = body(PASSWORD, &[("select", json!([]))], None);
    assert_eq!(fixture.sql(&route(30), &request).await.0, 200);
    fixture.idle(1).await;
    fixture.gateway.table.write().await.update(Database {
        route_revision: ROUTE_REVISION + 1,
        ..entry(Mode::Running, 1, &operation(), &fixture.unit)
    });
    assert_eq!(
        fixture
            .sql(&route_at(31, 1, ROUTE_REVISION + 1), &request)
            .await
            .0,
        200
    );
    fixture.idle(1).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.journal.count("auth:ok"), 1);
    // The role's password is reset: the generation moves, and the unit is the same.
    *fixture.authentication.lock().unwrap() = Authentication::Rotated;
    fixture.gateway.table.write().await.update(Database {
        route_revision: ROUTE_REVISION + 1,
        ..entry(Mode::Running, 2, &operation(), &fixture.unit)
    });
    let (status, answer) = fixture
        .sql(&route_at(32, 2, ROUTE_REVISION + 1), &request)
        .await;
    assert_eq!(
        (status, &answer["code"]),
        (400, &json!("28P01")),
        "{answer}"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.idle(0).await;
    // The new password logs in once and is pooled at the new generation.
    let rotated = body(ROTATED, &[("select", json!([]))], None);
    assert_eq!(
        fixture
            .sql(&route_at(33, 2, ROUTE_REVISION + 1), &rotated)
            .await
            .0,
        200
    );
    fixture.idle(1).await;
    assert_eq!(
        fixture
            .sql(&route_at(34, 2, ROUTE_REVISION + 1), &rotated)
            .await
            .0,
        200
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.journal.count("auth:ok"), 2);
    fixture.stop().await;
}
#[tokio::test]
async fn a_postgres_error_answers_with_its_fields_and_a_failed_batch_rolls_back() {
    let fixture = Fixture::new().await;
    let (status, answer) = fixture
        .sql(&route(9), &body(PASSWORD, &[("fail", json!([]))], None))
        .await;
    assert_eq!(status, 400);
    assert_eq!(
        answer,
        json!({"message":"relation \"missing\" does not exist","code":"42P01","severity":"ERROR","position":"15","file":"parse_relation.c","routine":"parserOpenTable"})
    );
    fixture.idle(1).await;
    let (status, answer) = fixture
        .sql(
            &route(10),
            &body(
                PASSWORD,
                &[
                    ("insert", json!([])),
                    ("fail", json!([])),
                    ("select", json!([])),
                ],
                Some(json!({})),
            ),
        )
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("42P01")));
    fixture.idle(1).await;
    let journal = fixture.journal.entries();
    let tail: Vec<&str> = journal
        .iter()
        .rev()
        .take(2)
        .rev()
        .map(String::as_str)
        .collect();
    assert_eq!(tail, ["query:ROLLBACK", "query:DISCARD ALL"]);
    assert_eq!(fixture.journal.count("execute:select"), 0);
    // The session stays usable.
    let (status, _) = fixture
        .sql(&route(11), &body(PASSWORD, &[("select", json!([]))], None))
        .await;
    assert_eq!(status, 200);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_connection_lost_after_the_statement_was_sent_is_unknown_and_never_retried() {
    let fixture = Fixture::new().await;
    let (status, answer) = fixture
        .sql(&route(12), &body(PASSWORD, &[("hang", json!([]))], None))
        .await;
    assert_eq!(status, 400);
    assert_eq!(answer["code"], "08007");
    assert_eq!(fixture.journal.count("execute:hang"), 1);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.idle(0).await;
    fixture.stop().await;
}
#[tokio::test]
async fn copy_and_an_oversized_result_close_the_session() {
    let fixture = Fixture::new().await;
    let (status, answer) = fixture
        .sql(&route(13), &body(PASSWORD, &[("copy", json!([]))], None))
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("0A000")));
    fixture.idle(0).await;
    let (status, answer) = fixture
        .sql(&route(14), &body(PASSWORD, &[("big", json!([]))], None))
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("54000")));
    fixture.idle(0).await;
    // Under 10 MiB of PostgreSQL's row bytes, but over 10 MiB as the answer: what is counted is
    // what the gateway holds, not what PostgreSQL sent.
    let (status, answer) = fixture
        .sql(&route(26), &body(PASSWORD, &[("nulls", json!([]))], None))
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("54000")));
    fixture.idle(0).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_request_without_a_valid_route_or_body_reaches_no_postgres() {
    let fixture = Fixture::new().await;
    let request = body(PASSWORD, &[("select", json!([]))], None);
    let (status, answer) = fixture.sql("not-a-route", &request).await;
    assert_eq!((status, &answer["code"]), (400, &json!("08006")));
    // A route is used once.
    assert_eq!(fixture.sql(&route(15), &request).await.0, 200);
    let (status, answer) = fixture.sql(&route(15), &request).await;
    assert_eq!((status, &answer["code"]), (400, &json!("08006")));
    for invalid in [
        json!({"password":"","queries":[{"query":"select","params":[]}]}),
        json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":[]}),
        json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":[{"query":"select","params":[]},{"query":"select","params":[]}]}),
        json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":[{"query":"select","params":[1]}]}),
        json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":[{"query":"select","params":[]}],"user":"other"}),
    ]
    .into_iter()
    .enumerate()
    {
        let (status, answer) = fixture.sql(&route(100 + invalid.0), &invalid.1).await;
        let invalid = invalid.1;
        assert_eq!(status, 400, "{invalid}");
        assert!(["08P01", "28P01"].contains(&answer["code"].as_str().unwrap()), "{answer}");
    }
    let nul = body(PASSWORD, &[("select\0", json!([]))], None);
    let (status, answer) = fixture.sql(&route(17), &nul).await;
    assert_eq!((status, &answer["code"]), (400, &json!("22021")));
    let (status, answer) = exchange(
        fixture.port,
        format!(
            "GET /sql HTTP/1.1\r\nHost: gateway\r\nX-PGCF-Route: {}\r\n\r\n",
            route(18)
        )
        .as_bytes(),
    )
    .await;
    assert_eq!((status, &answer["code"]), (400, &json!("08P01")));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_chunked_body_is_read_in_full() {
    let fixture = Fixture::new().await;
    let json = body(PASSWORD, &[("select $1", json!(["chunked"]))], None).to_string();
    let (first, second) = json.split_at(json.len() / 2);
    let request = format!(
        "POST /sql HTTP/1.1\r\nHost: gateway\r\nTransfer-Encoding: chunked\r\nX-PGCF-Route: {}\r\n\r\n{:x}\r\n{first}\r\n{:x};ext=1\r\n{second}\r\n0\r\n\r\n",
        route(19),
        first.len(),
        second.len()
    );
    let (status, answer) = exchange(fixture.port, request.as_bytes()).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["rows"], json!([["chunked"]]));
    fixture.stop().await;
}
#[tokio::test]
async fn a_quiesced_database_refuses_before_any_dial() {
    let fixture = Fixture::with(Mode::Quiesce).await;
    let (status, answer) = fixture
        .sql(&route(20), &body(PASSWORD, &[("select", json!([]))], None))
        .await;
    assert_eq!((status, &answer["code"]), (400, &json!("57P03")));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}

/// What the agent publishes when it released a wake: the unit running at the claimed generation
/// and operation.
async fn release(fixture: &Fixture, generation: u64) {
    fixture.gateway.table.write().await.update(entry(
        Mode::Running,
        generation,
        &wake_operation(),
        &fixture.unit,
    ));
}
#[tokio::test]
async fn a_wake_ticket_is_held_without_a_dial_until_the_table_releases_the_unit() {
    let fixture = Fixture::with(Mode::Sleeping).await;
    let port = fixture.port;
    let request = body(PASSWORD, &[("select $1", json!(["woken"]))], None);
    let answer = tokio::spawn(async move {
        post(port, &wake_token(21, 2), request.to_string().as_bytes()).await
    });
    timeout(Duration::from_secs(5), async {
        while fixture.gateway.wakes.held(DATABASE) != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    release(&fixture, 2).await;
    let (status, answer) = answer.await.unwrap();
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["rows"], json!([["woken"]]));
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 0);
    fixture.stop().await;
}
/// Waits until the gateway has admitted a request on the unit and written its StartupMessage to
/// PostgreSQL, which holds the login at its closed gate.
async fn logging_in(fixture: &Fixture) {
    timeout(Duration::from_secs(5), async {
        while fixture
            .journal
            .count("startup:user=app database=aaaaaaaaaaaaaaaaaaaa client_encoding=UTF8")
            != 1
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the request reached PostgreSQL");
}
#[tokio::test]
async fn a_cold_request_goes_on_when_the_claim_of_its_wake_reaches_the_table_during_its_login() {
    // The agent releases the wake under the route revision it knows. Cloudflare's claim of the
    // wake runs beside the request and commits a later revision, and the page that carries it
    // reaches the agent while PostgreSQL is still logging the request in. The unit, its
    // generation and its operation are the same: the entry the agent publishes names nothing
    // the request was admitted on differently.
    let fixture = Fixture::with(Mode::Sleeping).await;
    let port = fixture.port;
    let request = body(PASSWORD, &[("select $1", json!(["woken"]))], None);
    let answer = tokio::spawn(async move {
        post(port, &wake_token(26, 2), request.to_string().as_bytes()).await
    });
    timeout(Duration::from_secs(5), async {
        while fixture.gateway.wakes.held(DATABASE) != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    fixture.gate.send(false).unwrap();
    release(&fixture, 2).await;
    logging_in(&fixture).await;
    fixture.gateway.table.write().await.update(Database {
        route_revision: ROUTE_REVISION + 1,
        ..entry(Mode::Running, 2, &wake_operation(), &fixture.unit)
    });
    fixture.gate.send(true).unwrap();
    let (status, answer) = answer.await.unwrap();
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["rows"], json!([["woken"]]));
    fixture.stop().await;
}
#[tokio::test]
async fn a_request_whose_database_stops_admitting_during_its_login_writes_no_statement() {
    // The sleep proof begins between the request's admission and its first statement: the
    // statement waits for nothing and never reaches PostgreSQL.
    let fixture = Fixture::new().await;
    fixture.gate.send(false).unwrap();
    let port = fixture.port;
    let request = body(PASSWORD, &[("select $1", json!(["late"]))], None);
    let answer =
        tokio::spawn(async move { post(port, &route(27), request.to_string().as_bytes()).await });
    logging_in(&fixture).await;
    fixture.gateway.table.write().await.update(entry(
        Mode::Quiesce,
        1,
        &operation(),
        &fixture.unit,
    ));
    fixture.gate.send(true).unwrap();
    let (status, answer) = answer.await.unwrap();
    assert_eq!(
        (status, &answer["code"]),
        (400, &json!("57P03")),
        "{answer}"
    );
    fixture.idle(0).await;
    assert!(
        fixture
            .journal
            .entries()
            .iter()
            .all(|entry| !entry.starts_with("parse:") && !entry.starts_with("bind:")),
        "{:?}",
        fixture.journal.entries()
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_refused_wake_answers_with_the_detail_and_hint_of_the_contract() {
    let fixture = Fixture::with(Mode::Sleeping).await;
    let port = fixture.port;
    let request = body(PASSWORD, &[("select $1", json!(["woken"]))], None);
    let answer = tokio::spawn(async move {
        post(port, &wake_token(25, 2), request.to_string().as_bytes()).await
    });
    timeout(Duration::from_secs(5), async {
        while fixture.gateway.wakes.held(DATABASE) != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(fixture.gateway.wakes.result(&WakeResult {
        database: DATABASE.into(),
        operation: wake_operation(),
        generation: 2,
        outcome: Outcome::Refused,
        reason: Some("no_headroom".into()),
        retry_after_seconds: Some(5),
        steps_ms: Default::default(),
    }));
    let (status, answer) = answer.await.unwrap();
    assert_eq!(
        (status, &answer["code"], &answer["detail"], &answer["hint"]),
        (
            400,
            &json!("57P03"),
            &json!("node at awake capacity"),
            &json!("retry after 5 s")
        ),
        "{answer}"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}
#[tokio::test]
async fn a_cleartext_challenge_gets_no_password_and_a_trusting_session_is_not_pooled() {
    let fixture = Fixture::new().await;
    // As the WebSocket login: PostgreSQL proves the password's verifier with SCRAM or asks for
    // none; a cleartext challenge never receives the password.
    *fixture.authentication.lock().unwrap() = Authentication::Cleartext;
    let request = body(PASSWORD, &[("select", json!([]))], None);
    let (status, answer) = fixture.sql(&route(22), &request).await;
    assert_eq!((status, &answer["code"]), (400, &json!("08006")));
    timeout(Duration::from_secs(5), async {
        while fixture.journal.count("cleartext:X") != 1 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    fixture.idle(0).await;
    // A session that asked for no password has no verifier to match a later request against.
    *fixture.authentication.lock().unwrap() = Authentication::Trust;
    assert_eq!(fixture.sql(&route(23), &request).await.0, 200);
    fixture.idle(0).await;
    assert_eq!(fixture.sql(&route(24), &request).await.0, 200);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 3);
    fixture.stop().await;
}
