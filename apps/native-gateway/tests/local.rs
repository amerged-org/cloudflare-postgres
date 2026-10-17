// SPDX-License-Identifier: Apache-2.0
//! The gateway against a real PostgreSQL 18. The test plays the node agent on its channel: it
//! sends the table, starts and stops the database's PostgreSQL as the agent starts and stops its
//! unit, and answers the gateway's wakes. Clients connect through the gateway's WebSocket and
//! HTTP SQL ports as the Edge does.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    http, local,
    transport::{self, Config, Gateway},
};
use pgcf_native_protocol::{
    agent::{self, ControlAction, Database, FromGateway, Mode, SessionStatus, ToGateway, Writer},
    route::Keyring,
    wake::{self, MAX_HELD_PER_DATABASE, Outcome, WakeClaims, WakeResult},
    wire,
};
use pgcf_test_postgres::{Cluster, Directory, binaries};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::HashMap, os::unix::fs::MetadataExt, path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixListener},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
const REGION: &str = "eu-test";
const PASSWORD: &str = "local mode secret";
/// The unit's invocation ID, as the agent reports it.
const INSTANCE: &str = "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c";
const ROUTE_REVISION: u64 = 19;

fn operation(letter: char) -> String {
    format!("op_{}", letter.to_string().repeat(20))
}
fn cid(id: usize) -> String {
    format!("01234567-89ab-4def-8123-{id:012x}")
}
fn token(prefix: &str, domain: &str, claims: Value) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let mut mac = Hmac::<Sha256>::new_from_slice(&[7; 32]).unwrap();
    mac.update(format!("{domain}{payload}").as_bytes());
    let signature = mac.finalize().into_bytes();
    format!("{prefix}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature))
}
/// The admission route Cloudflare signs for a running database: its generation, the unit and the
/// route revision.
fn route(id: usize, generation: u64, instance: &str) -> String {
    route_at(id, generation, instance, ROUTE_REVISION)
}
fn route_at(id: usize, generation: u64, instance: &str, route_revision: u64) -> String {
    let now = http::now() / 1000;
    token(
        wire("admissionRouteTokenPrefix"),
        wire("admissionRouteSignatureDomain"),
        json!({"v":4,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":generation,"pod":instance,"route_revision":route_revision}),
    )
}
/// The wake ticket Cloudflare signs for a sleeping database.
fn ticket(id: usize, generation: u64, operation: &str) -> String {
    ticket_at(id, generation, operation, ROUTE_REVISION)
}
fn ticket_at(id: usize, generation: u64, operation: &str, route_revision: u64) -> String {
    let now = http::now() / 1000;
    token(
        "v5",
        "pgcf-route/v5\n",
        json!({"v":5,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"op":operation,"gen":generation,"route_revision":route_revision,"rh":"c".repeat(64)}),
    )
}

/// The claims of a wake ticket, as the gateway verifies them.
fn claims(gateway: &Gateway, id: usize, generation: u64, operation: &str) -> WakeClaims {
    wake::verify_wake(
        Some(&ticket(id, generation, operation)),
        &gateway.config.keyring.keys,
        REGION,
        http::now(),
    )
    .unwrap()
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
/// The unit as the agent reports it.
fn unit(cluster: &Cluster) -> Writer {
    Writer {
        socket: cluster.socket().display().to_string(),
        uid: std::fs::metadata(&cluster.data).unwrap().uid(),
        pid: cluster.pid(),
        instance: INSTANCE.into(),
    }
}
fn entry(generation: u64, operation: &str, mode: Mode, writer: Option<Writer>) -> Database {
    Database {
        database: DATABASE.into(),
        generation,
        operation: operation.into(),
        mode,
        route_revision: ROUTE_REVISION,
        writer,
    }
}

enum Command {
    Send(ToGateway),
    Disconnect,
}
/// A gateway on loopback, and the test's end of its agent channel.
struct Node {
    gateway: Arc<Gateway>,
    port: u16,
    connections: mpsc::UnboundedReceiver<()>,
    messages: mpsc::UnboundedReceiver<FromGateway>,
    commands: mpsc::UnboundedSender<Command>,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    _directory: Directory,
}
impl Node {
    async fn start() -> Self {
        let directory = Directory::new("gw");
        let socket = directory.path().join("agent.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let (connected, connections) = mpsc::unbounded_channel();
        let (received, messages) = mpsc::unbounded_channel();
        let (commands, mut queue) = mpsc::unbounded_channel::<Command>();
        let agent = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let _ = connected.send(());
                let (reader, mut writer) = stream.into_split();
                let mut lines = BufReader::new(reader).lines();
                loop {
                    tokio::select! {
                        line = lines.next_line() => match line {
                            Ok(Some(line)) => {
                                let _ = received.send(agent::decode_from_gateway(line.as_bytes()).unwrap());
                            }
                            _ => break,
                        },
                        command = queue.recv() => match command {
                            Some(Command::Send(message)) => writer.write_all(&agent::encode(&message)).await.unwrap(),
                            Some(Command::Disconnect) => break,
                            None => return,
                        },
                    }
                }
            }
        });
        let gateway = Gateway::new(Arc::new(Config {
            region: REGION.into(),
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
            socket,
            receiver.clone(),
        ));
        let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = tcp.local_addr().unwrap().port();
        let serving = gateway.clone();
        let server = tokio::spawn(async move {
            let pending = Arc::new(Semaphore::new(128));
            let mut shutdown = receiver.clone();
            let mut sessions = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = tcp.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let (gateway, receiver) = (serving.clone(), receiver.clone());
                        let permit = pending.clone().acquire_owned().await.unwrap();
                        sessions.spawn(async move {
                            let _ = transport::serve_socket(socket, gateway, receiver, permit).await;
                        });
                    }
                }
            }
            sessions.abort_all();
        });
        let mut node = Self {
            gateway,
            port,
            connections,
            messages,
            commands,
            stop,
            tasks: vec![agent, channel, server],
            _directory: directory,
        };
        node.connected().await;
        node
    }
    async fn connected(&mut self) {
        timeout(Duration::from_secs(10), self.connections.recv())
            .await
            .expect("the gateway connects to the agent")
            .unwrap();
    }
    fn send(&self, message: ToGateway) {
        let _ = self.commands.send(Command::Send(message));
    }
    /// Sends the table and waits until the gateway applied it.
    async fn table(&self, databases: Vec<Database>) {
        self.send(ToGateway::Table { databases });
        self.until(|table| table.synchronized()).await;
    }
    /// Sends one entry and waits until the gateway applied it.
    async fn update(&self, database: Database) {
        let expected = database.clone();
        self.send(ToGateway::Database { database });
        self.until(|table| table.record(DATABASE) == Some(&expected))
            .await;
    }
    async fn until(&self, done: impl Fn(&local::LocalTable) -> bool) {
        let table = &self.gateway.table;
        timeout(Duration::from_secs(10), async {
            while !done(&*table.read().await) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the gateway applies the agent's message");
    }
    /// The next message of the gateway that `pick` takes; others are skipped.
    async fn receive(&mut self, pick: impl Fn(&FromGateway) -> bool) -> FromGateway {
        timeout(Duration::from_secs(20), async {
            loop {
                let message = self.messages.recv().await.unwrap();
                if pick(&message) {
                    return message;
                }
            }
        })
        .await
        .expect("the gateway answers the agent")
    }
    async fn control(&mut self, id: u64, action: ControlAction, generation: u64) -> FromGateway {
        self.send(ToGateway::Control {
            id,
            action,
            database: DATABASE.into(),
            generation,
        });
        self.receive(|message| matches!(message, FromGateway::Status { id: answered, .. } if *answered == id))
            .await
    }
    async fn upgrade(&self, route: &str) -> Result<Client, u16> {
        let mut request = format!("ws://127.0.0.1:{}/pg", self.port)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("x-pgcf-route", route.parse().unwrap());
        match timeout(Duration::from_secs(10), connect_async(request))
            .await
            .unwrap()
        {
            Ok((socket, _)) => Ok(Client {
                socket,
                buffer: Vec::new(),
            }),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                Err(response.status().as_u16())
            }
            Err(error) => panic!("{error}"),
        }
    }
    /// One `POST /sql` as the Edge sends it.
    async fn sql(&self, route: &str, query: &str) -> (u16, Value) {
        Self::sql_on(self.port, route, query).await
    }
    async fn sql_on(port: u16, route: &str, query: &str) -> (u16, Value) {
        let body = json!({"password":URL_SAFE_NO_PAD.encode(PASSWORD),"queries":[{"query":query,"params":[]}]}).to_string();
        let request = format!(
            "POST /sql HTTP/1.1\r\nHost: gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-PGCF-Route: {route}\r\n\r\n{body}",
            body.len()
        );
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(30), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
        let status = std::str::from_utf8(&bytes[..split])
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        (status, serde_json::from_slice(&bytes[split..]).unwrap())
    }
    async fn finish(self) {
        let _ = self.stop.send(true);
        for task in self.tasks {
            task.abort();
            let _ = task.await;
        }
    }
}

/// A PostgreSQL client over the gateway's WebSocket.
struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    buffer: Vec<u8>,
}
fn startup() -> Vec<u8> {
    let body = format!("user\0app\0database\0{DATABASE}\0\0");
    let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(&196_608u32.to_be_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes
}
fn frame(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
fn query(sql: &str) -> Vec<u8> {
    frame(b'Q', format!("{sql}\0").as_bytes())
}
fn sqlstate(body: &[u8]) -> String {
    body.split(|byte| *byte == 0)
        .find_map(|field| field.strip_prefix(b"C"))
        .map(|code| String::from_utf8_lossy(code).into_owned())
        .unwrap_or_default()
}
impl Client {
    async fn send(&mut self, bytes: Vec<u8>) {
        self.socket
            .send(Message::Binary(bytes.into()))
            .await
            .unwrap();
    }
    /// The next PostgreSQL message, or none once the gateway closed the connection.
    async fn message(&mut self) -> Option<(u8, Vec<u8>)> {
        loop {
            if self.buffer.len() >= 5 {
                let length = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;
                if self.buffer.len() > length {
                    let message: Vec<u8> = self.buffer.drain(..=length).collect();
                    return Some((message[0], message[5..].to_vec()));
                }
            }
            match timeout(Duration::from_secs(30), self.socket.next())
                .await
                .expect("the gateway answers")
            {
                Some(Ok(Message::Binary(bytes))) => self.buffer.extend_from_slice(&bytes),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                _ => return None,
            }
        }
    }
    /// The messages through ReadyForQuery.
    async fn until_ready(&mut self) -> Vec<(u8, Vec<u8>)> {
        let mut messages = Vec::new();
        loop {
            let message = self.message().await.expect("PostgreSQL answers");
            let ready = message.0 == b'Z';
            messages.push(message);
            if ready {
                return messages;
            }
        }
    }
    /// The StartupMessage with the password pipelined behind it, as the Edge's clients send it:
    /// the gateway asks for it in clear text and logs in to PostgreSQL with SCRAM itself.
    async fn login(&mut self) {
        let mut bytes = startup();
        bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
        self.send(bytes).await;
        assert_eq!(self.message().await, Some((b'R', vec![0, 0, 0, 3])));
        let answer = self.until_ready().await;
        assert_eq!(answer[0], (b'R', vec![0, 0, 0, 0]), "{answer:?}");
        assert!(answer.iter().all(|(tag, _)| *tag != b'E'));
    }
    /// The first column of the first row of a simple query.
    async fn value(&mut self, sql: &str) -> String {
        self.send(query(sql)).await;
        let answer = self.until_ready().await;
        let row = answer
            .iter()
            .find(|(tag, _)| *tag == b'D')
            .unwrap_or_else(|| panic!("no row: {answer:?}"));
        let length = i32::from_be_bytes(row.1[2..6].try_into().unwrap()) as usize;
        String::from_utf8(row.1[6..6 + length].to_vec()).unwrap()
    }
    /// The SQLSTATE of the error the gateway ended the connection with.
    async fn refused(&mut self) -> String {
        loop {
            match self.message().await {
                Some((b'E', body)) => return sqlstate(&body),
                Some(_) => {}
                None => panic!("closed without an error"),
            }
        }
    }
    /// Nothing reaches the client within `bound`.
    async fn silent(&mut self, bound: Duration) {
        assert!(self.buffer.is_empty(), "{:?}", self.buffer);
        if let Ok(message) = timeout(bound, self.socket.next()).await {
            panic!("the client received {message:?}");
        }
    }
    /// The close frame the gateway ended the connection with.
    async fn closed(&mut self) -> Option<(u16, String)> {
        loop {
            match timeout(Duration::from_secs(30), self.socket.next())
                .await
                .expect("the gateway closes")
            {
                Some(Ok(Message::Close(frame))) => {
                    return frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
                }
                Some(Ok(_)) => {}
                _ => return None,
            }
        }
    }
}
fn blocking<T>(work: impl FnOnce() -> T) -> T {
    tokio::task::block_in_place(work)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_route_reaches_the_running_unit_only_through_its_own_socket() {
    let Some(bin) = binaries() else { return };
    let cluster = blocking(|| database_cluster(&bin));
    let node = Node::start().await;
    let running = entry(1, &operation('a'), Mode::Running, Some(unit(&cluster)));
    node.table(vec![running.clone()]).await;

    let mut client = node.upgrade(&route(1, 1, INSTANCE)).await.unwrap();
    client.login().await;
    assert_eq!(client.value("select 41 + 1").await, "42");
    assert_eq!(client.value("select current_user").await, "app");

    // A route of another unit, generation or route revision is stale.
    let other = "1f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c";
    assert_eq!(node.upgrade(&route(2, 1, other)).await.err(), Some(503));
    assert_eq!(node.upgrade(&route(3, 2, INSTANCE)).await.err(), Some(503));
    for revision in [ROUTE_REVISION - 1, ROUTE_REVISION + 1] {
        assert_eq!(
            node.upgrade(&route_at(10 + revision as usize, 1, INSTANCE, revision))
                .await
                .err(),
            Some(503)
        );
    }
    // The token is used once.
    assert_eq!(node.upgrade(&route(1, 1, INSTANCE)).await.err(), Some(403));

    // A socket served by another process than the unit's main PID is never written to.
    let impostor_path = cluster.root().join("impostor.sock");
    let impostor = UnixListener::bind(&impostor_path).unwrap();
    let mut forged = unit(&cluster);
    forged.socket = impostor_path.display().to_string();
    node.update(entry(1, &operation('a'), Mode::Running, Some(forged)))
        .await;
    let mut client_two = node.upgrade(&route(4, 1, INSTANCE)).await.unwrap();
    let mut bytes = startup();
    bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
    client_two.send(bytes).await;
    assert_eq!(client_two.refused().await, "08006");
    let (mut stream, _) = timeout(Duration::from_secs(5), impostor.accept())
        .await
        .unwrap()
        .unwrap();
    let mut received = Vec::new();
    timeout(Duration::from_secs(5), stream.read_to_end(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert!(received.is_empty(), "the impostor received {received:?}");
    // The established session's writer changed: it is closed.
    assert_eq!(client.closed().await.map(|frame| frame.0), Some(1012));

    // The unit's socket under another uid is refused as well.
    let mut other_user = unit(&cluster);
    other_user.uid += 1;
    node.update(entry(1, &operation('a'), Mode::Running, Some(other_user)))
        .await;
    let mut client_three = node.upgrade(&route(5, 1, INSTANCE)).await.unwrap();
    let mut bytes = startup();
    bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
    client_three.send(bytes).await;
    assert_eq!(client_three.refused().await, "08006");

    // Back on the unit, HTTP SQL runs there too.
    node.update(running).await;
    let (status, answer) = node
        .sql(&route(6, 1, INSTANCE), "select 6 * 7 as answer")
        .await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["rows"], json!([["42"]]));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_held_wake_reaches_the_unit_the_agent_started_for_it() {
    let Some(bin) = binaries() else { return };
    let mut cluster = blocking(|| database_cluster(&bin));
    blocking(|| cluster.stop());
    let mut node = Node::start().await;
    node.table(vec![entry(1, &operation('a'), Mode::Sleeping, None)])
        .await;
    // Without a wake ticket a sleeping database admits nothing.
    assert_eq!(node.upgrade(&route(1, 1, INSTANCE)).await.err(), Some(503));

    let wake = operation('w');
    let mut client = node.upgrade(&ticket(2, 2, &wake)).await.unwrap();
    let mut bytes = startup();
    bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
    client.send(bytes).await;
    // The wake reaches the agent while the connection is held.
    let FromGateway::Wake { wake: request } = node
        .receive(|message| matches!(message, FromGateway::Wake { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(
        (
            request.database.as_str(),
            request.generation,
            &request.operation
        ),
        (DATABASE, 2, &wake)
    );
    // The agent admits the wake, starts the unit and releases it.
    blocking(|| cluster.start(&[]));
    node.send(ToGateway::Database {
        database: entry(2, &wake, Mode::Running, Some(unit(&cluster))),
    });
    node.send(ToGateway::WakeResult {
        result: WakeResult {
            database: DATABASE.into(),
            operation: wake.clone(),
            generation: 2,
            outcome: Outcome::Started,
            reason: None,
            steps_ms: Default::default(),
        },
    });
    assert_eq!(client.message().await, Some((b'R', vec![0, 0, 0, 3])));
    let answer = client.until_ready().await;
    assert_eq!(answer[0], (b'R', vec![0, 0, 0, 0]), "{answer:?}");
    assert_eq!(client.value("select 'awake'").await, "awake");
    // A later connection of the same wake is routed at once, over WebSocket and HTTP SQL.
    let mut second = node.upgrade(&ticket(3, 2, &wake)).await.unwrap();
    second.login().await;
    let (status, answer) = node.sql(&ticket(4, 2, &wake), "select 'also awake'").await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["rows"], json!([["also awake"]]));
    // A ticket of an older generation is stale, and so is one of the wake's generation and
    // operation whose route revision the agent's entry has not reached.
    assert_eq!(
        node.upgrade(&ticket(5, 1, &operation('s'))).await.err(),
        Some(503)
    );
    assert_eq!(
        node.upgrade(&ticket_at(6, 2, &wake, ROUTE_REVISION + 1))
            .await
            .err(),
        Some(503)
    );
    // Cloudflare's claim of the wake moved the route revision past an earlier ticket's: it is
    // routed under the entry's revision.
    let mut earlier = node
        .upgrade(&ticket_at(7, 2, &wake, ROUTE_REVISION - 1))
        .await
        .unwrap();
    earlier.login().await;
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_wake_ends_its_held_connections_with_57p03() {
    let Some(_bin) = binaries() else { return };
    let mut node = Node::start().await;
    node.table(vec![entry(1, &operation('a'), Mode::Sleeping, None)])
        .await;
    let wake = operation('w');
    let mut client = node.upgrade(&ticket(1, 2, &wake)).await.unwrap();
    client.send(startup()).await;
    node.receive(|message| matches!(message, FromGateway::Wake { .. }))
        .await;
    node.send(ToGateway::WakeResult {
        result: WakeResult {
            database: DATABASE.into(),
            operation: wake,
            generation: 2,
            outcome: Outcome::Refused,
            reason: Some("no_headroom".into()),
            steps_ms: Default::default(),
        },
    });
    assert_eq!(client.refused().await, "57P03");
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sleep_quiesces_holds_and_closes_the_sessions_the_agent_asks_for() {
    let Some(bin) = binaries() else { return };
    let mut cluster = blocking(|| database_cluster(&bin));
    let mut node = Node::start().await;
    let generation = 1;
    let running = entry(
        generation,
        &operation('a'),
        Mode::Running,
        Some(unit(&cluster)),
    );
    let quiescing = Database {
        mode: Mode::Quiesce,
        ..running.clone()
    };
    node.table(vec![running.clone()]).await;
    let mut idle = node.upgrade(&route(1, 1, INSTANCE)).await.unwrap();
    idle.login().await;
    let mut busy = node.upgrade(&route(2, 1, INSTANCE)).await.unwrap();
    busy.login().await;
    busy.send(query("begin")).await;
    busy.until_ready().await;

    // The agent quiesces: a session in a transaction is busy, so the sleep is refused, and what
    // a client sends meanwhile waits.
    node.update(quiescing.clone()).await;
    assert!(matches!(
        node.control(1, ControlAction::Begin, generation).await,
        FromGateway::Status {
            status: SessionStatus::Busy,
            connections: 2,
            ..
        }
    ));
    assert_eq!(node.upgrade(&route(3, 1, INSTANCE)).await.err(), Some(503));
    idle.send(query("select 'held'")).await;
    // Not a byte of it reaches PostgreSQL while the database quiesces: the guard and the
    // checkpoint of the sleep proof rely on it. No answer comes, and PostgreSQL never ran it.
    idle.silent(Duration::from_millis(300)).await;
    assert_eq!(
        blocking(|| cluster.psql(
            "postgres",
            "select count(*) from pg_stat_activity where query = 'select ''held'''"
        )),
        "0"
    );
    assert!(matches!(
        node.control(2, ControlAction::Close, generation).await,
        FromGateway::Status {
            status: SessionStatus::Busy,
            ..
        }
    ));
    // The agent gives up the sleep: the held bytes run.
    node.update(running.clone()).await;
    let answer = idle.until_ready().await;
    assert!(
        answer
            .iter()
            .any(|(tag, body)| *tag == b'D' && body.ends_with(b"held"))
    );
    busy.send(query("commit")).await;
    busy.until_ready().await;

    // The next sleep finds both idle: they close as a sleeping database closes them.
    node.update(quiescing).await;
    assert!(matches!(
        node.control(3, ControlAction::Begin, generation).await,
        FromGateway::Status {
            status: SessionStatus::Idle,
            connections: 2,
            ..
        }
    ));
    assert!(matches!(
        node.control(4, ControlAction::Close, generation).await,
        FromGateway::Status {
            status: SessionStatus::Closed,
            connections: 0,
            ..
        }
    ));
    for client in [&mut idle, &mut busy] {
        assert_eq!(
            client.closed().await,
            Some((1000, "database sleeping".into()))
        );
    }
    // A request for another generation does not apply.
    assert!(matches!(
        node.control(5, ControlAction::Status, generation + 1).await,
        FromGateway::Status {
            status: SessionStatus::Mismatch,
            ..
        }
    ));
    blocking(|| cluster.stop());
    node.update(entry(generation, &operation('a'), Mode::Sleeping, None))
        .await;
    assert_eq!(node.upgrade(&route(4, 1, INSTANCE)).await.err(), Some(503));
    node.finish().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_outlive_the_agent_channel_and_new_routes_wait_for_its_table() {
    let Some(bin) = binaries() else { return };
    let cluster = blocking(|| database_cluster(&bin));
    let mut node = Node::start().await;
    let running = entry(1, &operation('a'), Mode::Running, Some(unit(&cluster)));
    node.table(vec![running.clone()]).await;
    let mut client = node.upgrade(&route(1, 1, INSTANCE)).await.unwrap();
    client.login().await;
    node.send(ToGateway::Activity {
        id: 7,
        database: DATABASE.into(),
    });
    let FromGateway::Activity { report, .. } = node
        .receive(|message| matches!(message, FromGateway::Activity { id: 7, .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(report["connections"], 1);
    assert_eq!(report["authenticatedConnections"], 1);

    // The agent restarts: the gateway admits nothing new, and the session keeps its unit.
    let _ = node.commands.send(Command::Disconnect);
    node.until(|table| !table.synchronized()).await;
    assert_eq!(node.upgrade(&route(2, 1, INSTANCE)).await.err(), Some(503));
    assert_eq!(client.value("select 'still here'").await, "still here");
    // The agent's first message on the new channel must be its table.
    node.connected().await;
    node.send(ToGateway::Removed {
        database: DATABASE.into(),
    });
    node.connected().await;
    node.table(vec![running]).await;
    let mut again = node.upgrade(&route(3, 1, INSTANCE)).await.unwrap();
    again.login().await;
    assert_eq!(client.value("select 'and here'").await, "and here");
    // A database the agent removes closes its sessions.
    node.send(ToGateway::Removed {
        database: DATABASE.into(),
    });
    assert!(client.closed().await.is_some());
    node.finish().await;
}

/// The `conn_stages` and `sql_stages` lines a child test process logged.
fn logged_stages(test: &str) -> Vec<Value> {
    // The gateway logs to stdout, so a child test process runs the connections.
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env("PGCF_STAGES_CHILD", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| serde_json::from_str(&line[line.find('{')?..]).ok())
        .filter(|line: &Value| line["event"] == "conn_stages" || line["event"] == "sql_stages")
        .collect()
}
fn started(generation: u64, operation: &str) -> ToGateway {
    ToGateway::WakeResult {
        result: WakeResult {
            database: DATABASE.into(),
            operation: operation.into(),
            generation,
            outcome: Outcome::Started,
            reason: None,
            steps_ms: [("start".to_string(), 80)].into(),
        },
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_connection_is_labelled_warm_or_cold() {
    let Some(bin) = binaries() else { return };
    if std::env::var_os("PGCF_STAGES_CHILD").is_none() {
        let lines = logged_stages("every_connection_is_labelled_warm_or_cold");
        let of = |event: &str, path: &str| {
            lines
                .iter()
                .filter(|line| line["event"] == event && line["wake_path"] == path)
                .collect::<Vec<_>>()
        };
        // A connection to a running database is warm, also one whose wake ticket arrives after
        // the wake.
        let warm = of("conn_stages", "warm");
        assert_eq!(warm.len(), 2, "{lines:?}");
        for line in &warm {
            assert!(line.get("held_outcome").is_none(), "{line}");
            assert!(line.get("wake_wait_ms").is_none(), "{line}");
        }
        // A connection that waited for its database's wake is cold, released or refused.
        let cold = of("conn_stages", "cold");
        assert_eq!(cold.len(), 2, "{lines:?}");
        let released = cold
            .iter()
            .find(|line| line["held_outcome"] == "released")
            .unwrap();
        assert!(released["wake_wait_ms"].is_u64(), "{released}");
        assert_eq!(released["agent_ms"], json!({"start":80}));
        assert!(released.get("wake_reason").is_none(), "{released}");
        let refused = cold
            .iter()
            .find(|line| line["held_outcome"] == "refused")
            .unwrap();
        assert_eq!(refused["wake_reason"], "no_headroom");
        assert!(refused["dial_ms"].is_null());
        // HTTP SQL the same way.
        assert_eq!(of("sql_stages", "warm").len(), 1, "{lines:?}");
        assert_eq!(of("sql_stages", "cold").len(), 1, "{lines:?}");
        // A connection or request refused before admission or hold is neither: the database was
        // not running, so `warm` would be false, and nothing waited for a wake. That includes a
        // ticket refused for want of a hold, which `cold` must not be set before.
        for event in ["conn_stages", "sql_stages"] {
            let mut outcomes = lines
                .iter()
                .filter(|line| line["event"] == event && line["wake_path"].is_null())
                .map(|line| line["outcome"].as_str().unwrap())
                .collect::<Vec<_>>();
            outcomes.sort_unstable();
            assert_eq!(
                outcomes,
                ["fenced", "route_stale", "wake_capacity"],
                "{event} {lines:?}"
            );
        }
        assert_eq!(lines.len(), 12, "{lines:?}");
        return;
    }
    let mut cluster = blocking(|| database_cluster(&bin));
    let mut node = Node::start().await;
    node.table(vec![entry(
        1,
        &operation('a'),
        Mode::Running,
        Some(unit(&cluster)),
    )])
    .await;
    let mut client = node.upgrade(&route(1, 1, INSTANCE)).await.unwrap();
    client.login().await;
    drop(client);
    assert_eq!(node.sql(&route(2, 1, INSTANCE), "select 1").await.0, 200);

    // A held wake the agent starts the unit for.
    blocking(|| cluster.stop());
    node.update(entry(1, &operation('a'), Mode::Sleeping, None))
        .await;
    let woken = operation('w');
    let mut held = node.upgrade(&ticket(3, 2, &woken)).await.unwrap();
    let mut bytes = startup();
    bytes.extend_from_slice(&frame(b'p', format!("{PASSWORD}\0").as_bytes()));
    held.send(bytes).await;
    node.receive(|message| matches!(message, FromGateway::Wake { .. }))
        .await;
    blocking(|| cluster.start(&[]));
    node.send(ToGateway::Database {
        database: entry(2, &woken, Mode::Running, Some(unit(&cluster))),
    });
    node.send(started(2, &woken));
    assert_eq!(held.message().await, Some((b'R', vec![0, 0, 0, 3])));
    held.until_ready().await;
    // A ticket of that wake after it.
    let mut later = node.upgrade(&ticket(4, 2, &woken)).await.unwrap();
    later.login().await;
    drop((held, later));

    // A held HTTP SQL request.
    blocking(|| cluster.stop());
    node.update(entry(2, &woken, Mode::Sleeping, None)).await;
    let again = operation('v');
    let (gateway, request) = (node.port, ticket(5, 3, &again));
    let answer = tokio::spawn(async move { Node::sql_on(gateway, &request, "select 1").await });
    node.receive(|message| matches!(message, FromGateway::Wake { .. }))
        .await;
    blocking(|| cluster.start(&[]));
    node.send(ToGateway::Database {
        database: entry(3, &again, Mode::Running, Some(unit(&cluster))),
    });
    node.send(started(3, &again));
    assert_eq!(answer.await.unwrap().0, 200);

    // A held wake the agent refuses.
    blocking(|| cluster.stop());
    node.update(entry(3, &again, Mode::Sleeping, None)).await;
    let refused = operation('r');
    let mut client = node.upgrade(&ticket(6, 4, &refused)).await.unwrap();
    client.send(startup()).await;
    node.receive(|message| matches!(message, FromGateway::Wake { .. }))
        .await;
    node.send(ToGateway::WakeResult {
        result: WakeResult {
            database: DATABASE.into(),
            operation: refused,
            generation: 4,
            outcome: Outcome::Refused,
            reason: Some("no_headroom".into()),
            steps_ms: Default::default(),
        },
    });
    assert_eq!(client.refused().await, "57P03");
    drop(client);

    // The database is sleeping: its admission route is refused, and a ticket of an earlier
    // generation is stale, on a connection and as a request.
    assert_eq!(node.upgrade(&route(7, 3, INSTANCE)).await.err(), Some(503));
    assert_eq!(
        node.upgrade(&ticket(8, 2, &operation('s'))).await.err(),
        Some(503)
    );
    assert_eq!(node.sql(&route(9, 3, INSTANCE), "select 1").await.0, 400);
    assert_eq!(
        node.sql(&ticket(10, 2, &operation('t')), "select 1")
            .await
            .0,
        400
    );

    // The database's holds are all taken: a ticket that would wait is refused before its hold,
    // as a connection and as a request.
    let full = operation('f');
    let holds = (100..100 + MAX_HELD_PER_DATABASE)
        .map(|id| {
            node.gateway
                .wakes
                .hold(
                    &claims(&node.gateway, id, 5, &full),
                    http::now(),
                    std::time::Instant::now(),
                )
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(node.upgrade(&ticket(11, 5, &full)).await.err(), Some(429));
    assert_eq!(node.sql(&ticket(12, 5, &full), "select 1").await.0, 400);
    drop(holds);
    // Every line is logged before the child ends.
    timeout(Duration::from_secs(10), async {
        while node
            .gateway
            .sessions
            .lock()
            .unwrap()
            .counts(DATABASE)
            .connections
            > 0
            || node.gateway.wakes.held(DATABASE) > 0
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    node.finish().await;
}
