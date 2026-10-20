// SPDX-License-Identifier: Apache-2.0
//! What a release swap does to the gateway's clients (ULTRA plan 9.3): the gateway against a real
//! PostgreSQL 18, driven by its own serve loop (`transport::serve`) as `main` drives it. The test
//! plays the node agent on its channel. A transaction in flight commits, or ends with a defined
//! SQLSTATE; an established WebSocket closes with Restart within the drain; new work gets a
//! defined refusal; `/healthz` says `draining`. The swap tests run the real binary twice, one
//! after the other, with the listening socket passed to each as systemd passes it, and measure
//! the gap for new connections.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    http, local,
    transport::{self, Config, Gateway},
};
use pgcf_native_protocol::{
    agent::{self, Database, Mode, ToGateway, Writer},
    route::Keyring,
    wire,
};
use pgcf_test_postgres::{Cluster, Directory, binaries};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::HashMap,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixListener},
    sync::{oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
const REGION: &str = "eu-test";
const NODE: &str = "nod_aaaaaaaaaaaaaaaaaaaa";
const PASSWORD: &str = "drain test secret";
const INSTANCE: &str = "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c";
const ROUTE_REVISION: u64 = 19;

fn cid(id: usize) -> String {
    format!("01234567-89ab-4def-8123-{id:012x}")
}
/// The admission route Cloudflare signs for the running unit.
fn route(id: usize) -> String {
    let now = http::now() / 1000;
    let claims = json!({"v":6,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":1,"route_revision":ROUTE_REVISION,"node":NODE,"inst":INSTANCE});
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let mut mac = Hmac::<Sha256>::new_from_slice(&[7; 32]).unwrap();
    mac.update(format!("{}{payload}", wire("nodeRouteSignatureDomain")).as_bytes());
    format!(
        "{}.{payload}.{}",
        wire("nodeRouteTokenPrefix"),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// The database's PostgreSQL, with the tenant role `app` that logs in with SCRAM-SHA-256.
fn database_cluster(bin: &Path) -> Cluster {
    let mut cluster = Cluster::init(
        bin,
        "",
        "local all app scram-sha-256\nlocal all all trust\n",
    );
    cluster.start(&[]);
    cluster.psql(
        "postgres",
        &format!("create role app login password '{PASSWORD}'"),
    );
    cluster.psql("postgres", &format!("create database {DATABASE} owner app"));
    cluster
}
/// `sql` as the superuser in the tenant's database, `psql -At`.
fn tenant_sql(cluster: &Cluster, sql: &str) -> String {
    let output = cluster
        .client("psql")
        .args([
            "-X", "-A", "-t", "-q", "-U", "postgres", "-d", DATABASE, "-c", sql,
        ])
        .output()
        .expect("psql runs");
    assert!(
        output.status.success(),
        "psql: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(work)
}

/// The database's PostgreSQL and the node agent's end of the channel, which sends the gateway its
/// table and then only listens.
struct Unit {
    cluster: Cluster,
    agent_socket: PathBuf,
    agent: JoinHandle<()>,
    _directory: Directory,
}
impl Unit {
    async fn start(bin: &Path) -> Self {
        Self::start_after(bin, Duration::ZERO).await
    }
    /// The agent sends its table `table_after` after the gateway has connected.
    async fn start_after(bin: &Path, table_after: Duration) -> Self {
        let cluster = blocking(|| database_cluster(bin));
        tenant_sql(
            &cluster,
            "create table ledger (n int); grant all on ledger to app",
        );
        let directory = Directory::new("dr");
        let agent_socket = directory.path().join("agent.sock");
        let listener = UnixListener::bind(&agent_socket).unwrap();
        let table = vec![Database {
            database: DATABASE.into(),
            generation: 1,
            operation: format!("op_{}", "a".repeat(20)),
            mode: Mode::Running,
            route_revision: ROUTE_REVISION,
            writer: Some(Writer {
                socket: cluster.socket().display().to_string(),
                uid: std::fs::metadata(&cluster.data).unwrap().uid(),
                pid: cluster.pid(),
                instance: INSTANCE.into(),
            }),
        }];
        let agent = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (reader, mut writer) = stream.into_split();
                let databases = table.clone();
                tokio::time::sleep(table_after).await;
                writer
                    .write_all(&agent::encode(&ToGateway::Table { databases }))
                    .await
                    .unwrap();
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(_)) = lines.next_line().await {}
            }
        });
        Self {
            cluster,
            agent_socket,
            agent,
            _directory: directory,
        }
    }
    /// A statement of the tenant's database, as the superuser.
    fn tenant(&self, sql: &str) -> String {
        blocking(|| tenant_sql(&self.cluster, sql))
    }
    /// Waits until a statement that contains `text` runs in PostgreSQL.
    async fn running(&self, text: &str) {
        timeout(Duration::from_secs(10), async {
            loop {
                let count = self.tenant(&format!(
                    "select count(*) from pg_stat_activity where state = 'active' and query like '%{text}%' and pid <> pg_backend_pid()"
                ));
                if count != "0" {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the statement runs");
    }
}

/// A gateway on loopback served by `transport::serve`, in this process.
struct Node {
    gateway: Arc<Gateway>,
    port: u16,
    unit: Unit,
    /// Completes the serve loop's shutdown: the drain begins.
    shutdown: Option<oneshot::Sender<()>>,
    server: JoinHandle<std::io::Result<()>>,
    channel: JoinHandle<()>,
}
impl Node {
    /// A node whose drain gives a busy session `bound`, once it has the agent's table.
    async fn start(bin: &Path, bound: Duration) -> Self {
        let node = Self::spawn(bin, bound, Duration::ZERO, transport::FIRST_TABLE_BOUND).await;
        timeout(Duration::from_secs(10), async {
            while !node.gateway.table.read().await.synchronized() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the gateway has the agent's table");
        node
    }
    /// A node that serves at once: the agent sends its table `table_after` after the gateway
    /// connects, and the gateway waits for it at most `first_table`.
    async fn spawn(
        bin: &Path,
        bound: Duration,
        table_after: Duration,
        first_table: Duration,
    ) -> Self {
        let unit = Unit::start_after(bin, table_after).await;
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
        let (stop, receiver) = watch::channel(false);
        let channel = tokio::spawn(local::synchronize(
            gateway.clone(),
            unit.agent_socket.clone(),
            receiver,
        ));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (shutdown, begin) = oneshot::channel();
        let server = tokio::spawn(transport::serve(
            listener,
            gateway.clone(),
            stop,
            async move {
                let _ = begin.await;
            },
            bound,
            first_table,
        ));
        Self {
            gateway,
            port,
            unit,
            shutdown: Some(shutdown),
            server,
            channel,
        }
    }
    /// The signal of the swap: the serve loop stops accepting and the drain begins.
    fn begin_drain(&mut self) {
        let _ = self.shutdown.take().unwrap().send(());
    }
    async fn draining(&self) {
        timeout(Duration::from_secs(5), async {
            while !self.gateway.draining() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the gateway drains");
    }
    /// How long the serve loop takes to return, from now.
    async fn returned(&mut self) -> Duration {
        let began = Instant::now();
        timeout(Duration::from_secs(10), &mut self.server)
            .await
            .expect("the serve loop returns")
            .unwrap()
            .unwrap();
        began.elapsed()
    }
    async fn connect(&self, id: usize) -> Client {
        connect(self.port, id).await
    }
    async fn upgrade(&self, route: &str) -> Result<Client, (u16, String)> {
        upgrade(self.port, route).await
    }
    async fn get(&self, path: &str) -> (u16, String) {
        let request = format!("GET {path} HTTP/1.1\r\nHost: gateway\r\n\r\n");
        let (status, body) = exchange(self.port, request.as_bytes()).await;
        (status, String::from_utf8(body).unwrap())
    }
    fn tenant(&self, sql: &str) -> String {
        self.unit.tenant(sql)
    }
    async fn running(&self, text: &str) {
        self.unit.running(text).await
    }
    async fn finish(self) {
        self.channel.abort();
        self.unit.agent.abort();
    }
}

async fn connect(port: u16, id: usize) -> Client {
    let mut client = upgrade(port, &route(id)).await.unwrap();
    client.login().await;
    client
}
fn upgrade_request(port: u16, route: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
    let mut request = format!("ws://127.0.0.1:{port}/pg")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("x-pgcf-route", route.parse().unwrap());
    request
}
/// What the gateway answered an upgrade with: the client, or the status and body of its refusal
/// (status 0 for a connection that failed before any answer).
fn answered(
    result: Result<
        (
            WebSocketStream<MaybeTlsStream<TcpStream>>,
            tokio_tungstenite::tungstenite::handshake::client::Response,
        ),
        tokio_tungstenite::tungstenite::Error,
    >,
) -> Result<Client, (u16, String)> {
    match result {
        Ok((socket, _)) => Ok(Client {
            socket,
            buffer: Vec::new(),
        }),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => Err((
            response.status().as_u16(),
            String::from_utf8_lossy(response.body().as_deref().unwrap_or_default()).into_owned(),
        )),
        Err(error) => Err((0, error.to_string())),
    }
}
async fn upgrade(port: u16, route: &str) -> Result<Client, (u16, String)> {
    answered(
        timeout(
            Duration::from_secs(10),
            connect_async(upgrade_request(port, route)),
        )
        .await
        .unwrap(),
    )
}
/// One `POST /sql` as the Edge sends it: the statements in one transaction.
async fn sql(port: u16, route: String, statements: Vec<&'static str>) -> (u16, Value) {
    let queries: Vec<Value> = statements
        .iter()
        .map(|query| json!({"query": query, "params": []}))
        .collect();
    let body =
        json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":queries,"transaction":{}})
            .to_string();
    let request = format!(
        "POST /sql HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-PGCF-Route: {route}\r\n\r\n{body}",
        body.len()
    );
    let (status, body) = exchange(port, request.as_bytes()).await;
    (status, serde_json::from_slice(&body).unwrap())
}
async fn exchange(port: u16, request: &[u8]) -> (u16, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(30), stream.read_to_end(&mut bytes))
        .await
        .expect("the gateway answers")
        .unwrap();
    let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    let status = std::str::from_utf8(&bytes[..split])
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    (status, bytes[split..].to_vec())
}

/// A PostgreSQL client over the gateway's WebSocket.
struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    buffer: Vec<u8>,
}
/// What reaches a client.
#[derive(Debug, PartialEq)]
enum Event {
    Message(u8, Vec<u8>),
    /// The connection ended, with the close code if there was a close frame.
    Closed(Option<u16>),
}
fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
fn sqlstate(body: &[u8]) -> String {
    body.split(|byte| *byte == 0)
        .find_map(|field| field.strip_prefix(b"C"))
        .map(|value| String::from_utf8_lossy(value).into_owned())
        .unwrap_or_default()
}
impl Client {
    async fn send(&mut self, bytes: Vec<u8>) {
        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .unwrap();
    }
    /// The next PostgreSQL message or the end of the connection; none within `bound`.
    async fn next(&mut self, bound: Duration) -> Option<Event> {
        let deadline = tokio::time::Instant::now() + bound;
        loop {
            if self.buffer.len() >= 5 {
                let length = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;
                if self.buffer.len() > length {
                    let message: Vec<u8> = self.buffer.drain(..=length).collect();
                    return Some(Event::Message(message[0], message[5..].to_vec()));
                }
            }
            match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return None,
                Ok(Some(Ok(Message::Binary(bytes)))) => self.buffer.extend_from_slice(&bytes),
                Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => {}
                Ok(Some(Ok(Message::Close(frame)))) => {
                    return Some(Event::Closed(frame.map(|frame| u16::from(frame.code))));
                }
                Ok(_) => return Some(Event::Closed(None)),
            }
        }
    }
    /// The messages of a simple query through ReadyForQuery.
    async fn run(&mut self, sql: &str) -> Vec<(u8, Vec<u8>)> {
        self.send(frame(b'Q', format!("{sql}\0").as_bytes())).await;
        self.until_ready().await
    }
    async fn until_ready(&mut self) -> Vec<(u8, Vec<u8>)> {
        let mut messages = Vec::new();
        loop {
            let Some(Event::Message(tag, body)) = self.next(Duration::from_secs(10)).await else {
                panic!("PostgreSQL answers: {messages:?}");
            };
            messages.push((tag, body));
            if tag == b'Z' {
                return messages;
            }
        }
    }
    /// The StartupMessage with the password pipelined behind it, as the Edge's clients send it.
    async fn login(&mut self) {
        let body = format!("user\0app\0database\0{DATABASE}\0\0");
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(&196_608u32.to_be_bytes());
        bytes.extend_from_slice(body.as_bytes());
        bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
        self.send(bytes).await;
        assert_eq!(
            self.next(Duration::from_secs(10)).await,
            Some(Event::Message(b'R', vec![0, 0, 0, 3]))
        );
        let answer = self.until_ready().await;
        assert_eq!(answer[0], (b'R', vec![0, 0, 0, 0]), "{answer:?}");
    }
    /// Reads until the connection ends; the SQLSTATEs of the errors on the way and the close code.
    async fn ends(&mut self, bound: Duration) -> (Vec<String>, Option<Option<u16>>) {
        let deadline = tokio::time::Instant::now() + bound;
        let mut errors = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next(left).await {
                None => return (errors, None),
                Some(Event::Message(b'E', body)) => errors.push(sqlstate(&body)),
                Some(Event::Message(..)) => {}
                Some(Event::Closed(code)) => return (errors, Some(code)),
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transaction_in_flight_when_the_drain_starts_commits_and_the_session_then_closes_with_restart()
 {
    let Some(bin) = binaries() else { return };
    let mut node = Node::start(&bin, Duration::from_secs(30)).await;
    let mut client = node.connect(1).await;
    client.run("begin").await;
    client.run("insert into ledger values (1)").await;

    node.begin_drain();
    node.draining().await;
    // A session in a transaction is not cut: it is given the time to end it.
    assert_eq!(client.next(Duration::from_millis(400)).await, None);
    let committed = client.run("commit").await;
    assert_eq!(
        committed.last(),
        Some(&(b'Z', b"I".to_vec())),
        "{committed:?}"
    );
    // And once it is idle it is closed at once, not at the end of the drain.
    assert_eq!(
        client.ends(Duration::from_secs(2)).await,
        (vec![], Some(Some(1012)))
    );
    assert_eq!(node.tenant("select count(*) from ledger"), "1");
    assert!(node.returned().await < Duration::from_secs(2));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_idle_websocket_closes_with_restart_as_the_drain_starts() {
    let Some(bin) = binaries() else { return };
    let mut node = Node::start(&bin, Duration::from_secs(30)).await;
    let mut client = node.connect(1).await;
    assert_eq!(
        client.run("select 1").await.last(),
        Some(&(b'Z', b"I".to_vec()))
    );
    node.begin_drain();
    assert_eq!(
        client.ends(Duration::from_secs(2)).await,
        (vec![], Some(Some(1012)))
    );
    assert!(node.returned().await < Duration::from_secs(2));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transaction_still_open_when_the_drain_ends_is_ended_with_57p01_and_rolled_back() {
    let Some(bin) = binaries() else { return };
    let mut node = Node::start(&bin, Duration::from_secs(1)).await;
    let mut client = node.connect(1).await;
    client.run("begin").await;
    client.run("insert into ledger values (1)").await;
    node.begin_drain();
    // After the bound the session is told why before it is closed, and the transaction is gone.
    assert_eq!(
        client.ends(Duration::from_secs(5)).await,
        (vec!["57P01".to_string()], Some(Some(1012)))
    );
    assert_eq!(node.tenant("select count(*) from ledger"), "0");
    assert!(node.returned().await < Duration::from_secs(3));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_transaction_in_flight_when_the_drain_starts_commits_and_is_answered() {
    let Some(bin) = binaries() else { return };
    let mut node = Node::start(&bin, Duration::from_secs(30)).await;
    let request = tokio::spawn(sql(
        node.port,
        route(1),
        vec!["insert into ledger values (1)", "select pg_sleep(1.5)"],
    ));
    node.running("pg_sleep").await;
    node.begin_drain();
    let (status, answer) = request.await.unwrap();
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["results"].as_array().map(Vec::len), Some(2));
    assert_eq!(node.tenant("select count(*) from ledger"), "1");
    assert!(node.returned().await < Duration::from_secs(2));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn an_http_transaction_still_running_when_the_drain_ends_is_answered_08007_and_rolled_back() {
    let Some(bin) = binaries() else { return };
    let mut node = Node::start(&bin, Duration::from_secs(1)).await;
    let request = tokio::spawn(sql(
        node.port,
        route(1),
        vec!["insert into ledger values (1)", "select pg_sleep(30)"],
    ));
    node.running("pg_sleep").await;
    let began = Instant::now();
    node.begin_drain();
    // The outcome is unknown to the client, which is not told to retry: 08007, never 08006.
    let (status, answer) = timeout(Duration::from_secs(5), request)
        .await
        .expect("the request is answered at the end of the drain")
        .unwrap();
    assert_eq!(
        (status, answer["code"].as_str()),
        (400, Some("08007")),
        "{answer}"
    );
    assert!(began.elapsed() < Duration::from_secs(4));
    assert_eq!(node.tenant("select count(*) from ledger"), "0");
    assert!(node.returned().await < Duration::from_secs(3));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn new_work_gets_08006_gateway_draining_and_the_probes_say_draining() {
    let Some(bin) = binaries() else { return };
    let node = Node::start(&bin, Duration::from_secs(30)).await;
    assert_eq!(node.get("/healthz").await, (200, "ok\n".into()));
    // A connection accepted just before the drain is read after it began.
    node.gateway.drain(Duration::from_secs(30));
    assert_eq!(node.get("/healthz").await, (200, "draining\n".into()));
    assert_eq!(node.get("/readyz").await, (503, "draining\n".into()));
    let (status, answer) = sql(node.port, route(1), vec!["select 1"]).await;
    assert_eq!(
        (status, answer["code"].as_str(), answer["message"].as_str()),
        (400, Some("08006"), Some("gateway restarting")),
        "{answer}"
    );
    let Err((status, body)) = node.upgrade(&route(2)).await else {
        panic!("a draining gateway upgrades nothing");
    };
    assert_eq!(status, 503);
    assert!(body.contains("gateway_draining"), "{body}");
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_arrives_before_the_agents_table_waits_for_it_and_is_admitted() {
    let Some(bin) = binaries() else { return };
    // The new gateway of a swap has connected to the agent and has no table yet: the connections
    // that waited in the socket are not accepted into a refusal.
    let node = Node::spawn(
        &bin,
        Duration::from_secs(30),
        Duration::from_millis(900),
        transport::FIRST_TABLE_BOUND,
    )
    .await;
    let began = Instant::now();
    let upgraded = node.upgrade(&route(1)).await;
    assert!(upgraded.is_ok(), "{:?}", upgraded.err());
    assert!(began.elapsed() >= Duration::from_millis(700));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_waits_for_a_table_that_does_not_come_is_refused_fenced_at_the_bound() {
    let Some(bin) = binaries() else { return };
    let node = Node::spawn(
        &bin,
        Duration::from_secs(30),
        Duration::from_secs(60),
        Duration::from_millis(600),
    )
    .await;
    let began = Instant::now();
    let Err((status, body)) = node.upgrade(&route(1)).await else {
        panic!("a gateway without the agent's table upgrades nothing");
    };
    assert_eq!(status, 503);
    assert!(body.contains("fenced"), "{body}");
    let waited = began.elapsed();
    assert!(
        waited >= Duration::from_millis(500) && waited < Duration::from_secs(3),
        "{waited:?}"
    );
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_while_the_gateway_waits_for_the_table_ends_the_serve_loop_at_once() {
    let Some(bin) = binaries() else { return };
    let mut node = Node::spawn(
        &bin,
        Duration::from_secs(30),
        Duration::from_secs(60),
        Duration::from_secs(60),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    node.begin_drain();
    assert!(node.returned().await < Duration::from_secs(2));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connections_beyond_the_handshake_limit_wait_in_the_socket_and_are_not_reset() {
    // After a swap the new gateway meets every connection that waited in the socket at once. The
    // ones beyond the limit of simultaneous handshakes wait for their turn; they are not reset.
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
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, _) = watch::channel(false);
    let (shutdown, begin) = oneshot::channel::<()>();
    let server = tokio::spawn(transport::serve(
        listener,
        gateway,
        stop,
        async move {
            let _ = begin.await;
        },
        Duration::from_secs(1),
        Duration::ZERO,
    ));
    // Every handshake slot is taken by a client that has not sent its request yet.
    let mut slow = Vec::new();
    for _ in 0..transport::HANDSHAKES {
        slow.push(TcpStream::connect(("127.0.0.1", port)).await.unwrap());
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut waiting = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    waiting
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: gateway\r\n\r\n")
        .await
        .unwrap();
    let mut answer = Vec::new();
    // It is not answered and not reset while the slots are taken ...
    assert!(
        timeout(Duration::from_millis(500), waiting.read_to_end(&mut answer))
            .await
            .is_err(),
        "answered or reset while every slot was taken: {:?}",
        String::from_utf8_lossy(&answer)
    );
    // ... and it is served when they are free.
    drop(slow);
    timeout(Duration::from_secs(5), waiting.read_to_end(&mut answer))
        .await
        .expect("served once a slot is free")
        .expect("not reset");
    assert!(
        answer.starts_with(b"HTTP/1.1 200"),
        "{:?}",
        String::from_utf8_lossy(&answer)
    );
    let _ = shutdown.send(());
    server.await.unwrap().unwrap();
}

/// The longest an integrator keeps retrying a connection that failed (1, 2, 4 and 8 s).
const RETRY_BUDGET: Duration = Duration::from_secs(15);
/// How long after the old gateway has exited the test starts the new one. A restart of the
/// service takes a few milliseconds, too short for more than a few connections to arrive in it,
/// so the gap is made one in which many do.
const RESTART_GAP: Duration = Duration::from_millis(300);

/// A gateway process the way systemd runs it, with the socket unit's listening socket passed as
/// descriptor 3 (`LISTEN_PID`, `LISTEN_FDS`).
struct Process(std::process::Child);
impl Process {
    fn terminate(&self) -> Instant {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success());
        Instant::now()
    }
    /// The exit status once the process has ended, waiting at most `bound`.
    async fn exited(&mut self, bound: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + bound;
        while Instant::now() < deadline {
            if let Some(status) = self.0.try_wait().unwrap() {
                return Some(status);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        None
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// The service manager's part: it holds the listening socket for as long as the test runs, across
/// the gateway processes.
struct Manager {
    socket: std::net::TcpListener,
    port: u16,
}
impl Manager {
    fn new() -> Self {
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        Self { socket, port }
    }
    fn start(&self, agent_socket: &Path) -> Process {
        let keyring = json!({"active":"test","keys":{"test":URL_SAFE_NO_PAD.encode([7; 32])}});
        // The shell moves the socket (its standard input) to descriptor 3 and execs the gateway,
        // which keeps the shell's process ID, the one LISTEN_PID names.
        let child = std::process::Command::new("sh")
            .args([
                "-c",
                r#"exec 3<&0 0</dev/null; LISTEN_PID=$$ LISTEN_FDS=1; export LISTEN_PID LISTEN_FDS; exec "$0""#,
                env!("CARGO_BIN_EXE_pgcf-native-gateway"),
            ])
            .stdin(Stdio::from(std::os::fd::OwnedFd::from(
                self.socket.try_clone().unwrap(),
            )))
            .stdout(Stdio::null())
            .env("PGCF_REGION_ID", REGION)
            .env("PGCF_NODE_ID", NODE)
            .env("PGCF_ROUTE_KEY", keyring.to_string())
            .env("PGCF_AGENT_SOCKET", agent_socket)
            .spawn()
            .unwrap();
        Process(child)
    }
    /// Waits until the gateway behind the socket has the agent's table.
    async fn ready(&self) {
        timeout(Duration::from_secs(15), async {
            loop {
                let request = b"GET /readyz HTTP/1.1\r\nHost: gateway\r\n\r\n";
                if let Ok(Ok((200, _))) =
                    timeout(Duration::from_secs(2), probe(self.port, request)).await
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the gateway is ready");
    }
}
async fn probe(port: u16, request: &[u8]) -> std::io::Result<(u16, Vec<u8>)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(request).await?;
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).await?;
    let status = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| text.split_whitespace().nth(1))
        .and_then(|status| status.parse().ok())
        .ok_or_else(|| std::io::Error::other("no HTTP answer"))?;
    Ok((status, bytes))
}
/// One probe: a new connection and how long it waited for its answer, with whether the gateway had
/// been told to stop when it was made.
type Probe = (bool, Result<Duration, String>);
/// New WebSocket upgrades, as the Edge makes them, one every `interval`, each in a task of its
/// own, as clients arrive: a probe passes only if the gateway admits the route, which it does
/// only with the agent's table. None is made while `quiet` is set. The loop ends when `done` is
/// set and the answer is every probe.
fn probes(
    port: u16,
    interval: Duration,
    done: Arc<AtomicBool>,
    terminated: Arc<AtomicBool>,
    quiet: Arc<AtomicBool>,
) -> JoinHandle<Vec<Probe>> {
    tokio::spawn(async move {
        let mut probes = tokio::task::JoinSet::new();
        // The sessions of the test use the low ids; every route's connection ID is used once.
        let mut id = 1_000;
        while !done.load(Ordering::SeqCst) {
            if !quiet.load(Ordering::SeqCst) {
                let (after, route) = (terminated.load(Ordering::SeqCst), route(id));
                id += 1;
                probes.spawn(async move {
                    let began = Instant::now();
                    let outcome = match timeout(
                        Duration::from_secs(25),
                        connect_async(upgrade_request(port, &route)),
                    )
                    .await
                    {
                        Ok(result) => match answered(result) {
                            Ok(_) => Ok(began.elapsed()),
                            Err((status, body)) => Err(format!("status {status}: {body}")),
                        },
                        Err(_) => Err("no answer in 25 s".into()),
                    };
                    (after, outcome)
                });
            }
            tokio::time::sleep(interval).await;
        }
        let mut all = Vec::new();
        while let Some(probe) = probes.join_next().await {
            all.push(probe.unwrap());
        }
        all
    })
}
/// Replaces the gateway the way `systemctl restart` does: the old process gets SIGTERM and must
/// exit before the new one starts. New connections arrive throughout; the answer is how long the
/// longest of them waited, after it is shown that every one of them was upgraded, which the new
/// gateway can do only with the agent's table.
///
/// No connection is made in the few milliseconds around the signal: a connection that the old
/// gateway had accepted and not yet read when the signal arrived gets the defined refusal of a
/// draining gateway (`new_work_gets_08006_gateway_draining...`), which is a retry and not a swap's gap.
async fn swap(
    manager: &Manager,
    agent_socket: &Path,
    old: &mut Process,
    exits_within: Duration,
    interval: Duration,
) -> (Process, Duration) {
    let (done, terminated, quiet) = (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    );
    let probing = probes(
        manager.port,
        interval,
        done.clone(),
        terminated.clone(),
        quiet.clone(),
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    quiet.store(true, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(5)).await;
    terminated.store(true, Ordering::SeqCst);
    old.terminate();
    tokio::time::sleep(Duration::from_millis(10)).await;
    quiet.store(false, Ordering::SeqCst);
    let status = old
        .exited(exits_within)
        .await
        .expect("the old gateway exits when its drain is over");
    assert!(status.success(), "{status}");
    tokio::time::sleep(RESTART_GAP).await;
    let new = manager.start(agent_socket);
    manager.ready().await;
    done.store(true, Ordering::SeqCst);
    let probes = probing.await.unwrap();
    let (probes_made, probes_during) = (
        probes.len(),
        probes.iter().filter(|(after, _)| *after).count(),
    );
    assert!(
        probes_during >= 10,
        "connections arrived during the swap: {probes_made}"
    );
    let mut longest = Duration::ZERO;
    for (_, outcome) in probes {
        longest =
            longest.max(outcome.expect("a new connection was refused or lost during the swap"));
    }
    eprintln!(
        "swap: {} connections, {} of them during the swap, the longest waited {longest:?}",
        probes_made, probes_during,
    );
    (new, longest)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_swap_with_an_idle_session_open_refuses_no_connection_and_the_gap_is_the_restart() {
    let Some(bin) = binaries() else { return };
    let unit = Unit::start(&bin).await;
    let manager = Manager::new();
    let mut old = manager.start(&unit.agent_socket);
    manager.ready().await;
    let mut idle = connect(manager.port, 1).await;
    assert_eq!(
        idle.run("select 1").await.last(),
        Some(&(b'Z', b"I".to_vec()))
    );

    let (new, longest) = swap(
        &manager,
        &unit.agent_socket,
        &mut old,
        Duration::from_secs(3),
        Duration::from_millis(5),
    )
    .await;
    // The established session was closed with Restart within the drain, not at its end.
    assert_eq!(
        idle.ends(Duration::from_secs(2)).await,
        (vec![], Some(Some(1012)))
    );
    // Every connection that arrived meanwhile waited in the socket and was upgraded by the new
    // gateway: the gap is the restart (here the test's 300 ms and the start), far inside the retry
    // budget.
    assert!(longest < Duration::from_secs(3), "{longest:?}");
    // And the new gateway serves a session.
    let mut again = connect(manager.port, 2).await;
    assert_eq!(
        again.run("select 1").await.last(),
        Some(&(b'Z', b"I".to_vec()))
    );
    drop(new);
    unit.agent.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_swap_with_a_transaction_open_waits_the_drain_out_inside_the_retry_budget() {
    let Some(bin) = binaries() else { return };
    let unit = Unit::start(&bin).await;
    let manager = Manager::new();
    let mut old = manager.start(&unit.agent_socket);
    manager.ready().await;
    let mut busy = connect(manager.port, 1).await;
    busy.run("begin").await;
    busy.run("insert into ledger values (1)").await;

    let (new, longest) = swap(
        &manager,
        &unit.agent_socket,
        &mut old,
        transport::DRAIN_BOUND + Duration::from_secs(3),
        Duration::from_millis(50),
    )
    .await;
    // The transaction was given the drain and then ended with 57P01, and it was rolled back.
    assert_eq!(
        busy.ends(Duration::from_secs(2)).await,
        (vec!["57P01".to_string()], Some(Some(1012)))
    );
    assert_eq!(unit.tenant("select count(*) from ledger"), "0");
    // New connections waited for the new gateway, never longer than an integrator retries.
    assert!(longest < RETRY_BUDGET, "{longest:?}");
    drop(new);
    unit.agent.abort();
}
