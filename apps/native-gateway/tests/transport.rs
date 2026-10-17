// SPDX-License-Identifier: Apache-2.0
//! Real loopback WebSocket sockets and a PostgreSQL double on a Unix socket, which the test
//! process serves as the database's unit; this is protocol conformance, not SQL acceptance.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{SinkExt, StreamExt};
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
use sha2::Sha256;
use std::{
    collections::HashMap,
    os::unix::fs::MetadataExt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UnixListener, UnixStream},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;
const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
const REGION: &str = "eu-test";
/// The unit's invocation ID, which the routes name.
const INSTANCE: &str = "01234567-89ab-4def-8123-0123456789ab";
const ROUTE_REVISION: u64 = 19;
fn operation() -> String {
    format!("op_{}", "b".repeat(20))
}
fn cid(id: usize) -> String {
    format!("01234567-89ab-4def-8123-{id:012x}")
}
fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn token(prefix: &str, purpose: &str, claims: Value, key: &[u8]) -> String {
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let signature = hmac(key, format!("{purpose}{payload}").as_bytes());
    format!("{prefix}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature))
}
/// The route Cloudflare admits for the fixture's running generation and unit.
fn route_token(id: usize) -> String {
    admitted(id, 1, INSTANCE, ROUTE_REVISION)
}
/// A v4 route: the generation, the unit and the route revision Cloudflare admitted.
fn admitted(id: usize, generation: u64, instance: &str, route_revision: u64) -> String {
    let now = http::now() / 1000;
    token(
        wire("admissionRouteTokenPrefix"),
        wire("admissionRouteSignatureDomain"),
        json!({"v":4,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":generation,"pod":instance,"route_revision":route_revision}),
        &[7; 32],
    )
}
/// A v3 route names no route revision.
fn routed(id: usize, generation: u64, instance: &str) -> String {
    let now = http::now() / 1000;
    token(
        wire("routeTokenPrefix"),
        wire("routeSignatureDomain"),
        json!({"v":3,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":generation,"pod":instance}),
        &[7; 32],
    )
}
/// A v2 route names neither a generation nor a unit.
fn legacy_route_token(id: usize) -> String {
    let now = http::now() / 1000;
    token(
        wire("legacyRouteTokenPrefix"),
        wire("legacyRouteSignatureDomain"),
        json!({"v":2,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30}),
        &[7; 32],
    )
}
fn startup(user: &str) -> Vec<u8> {
    let body = format!("user\0{user}\0database\0{DATABASE}\0options\0-c search_path=public\0\0");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    bytes.extend_from_slice(&196610u32.to_be_bytes());
    bytes.extend(body.as_bytes());
    bytes
}
fn query() -> Vec<u8> {
    vec![b'Q', 0, 0, 0, 6, b'x', 0]
}
/// One 1 MiB Query message.
fn large_query() -> Vec<u8> {
    let mut bytes = vec![b'x'; 1024 * 1024];
    bytes[0] = b'Q';
    let length = (bytes.len() - 1) as u32;
    bytes[1..5].copy_from_slice(&length.to_be_bytes());
    *bytes.last_mut().unwrap() = 0;
    bytes
}
/// The agent's entry for the database.
fn entry(mode: Mode, generation: u64, operation: &str, writer: Option<&Writer>) -> Database {
    Database {
        database: DATABASE.into(),
        generation,
        operation: operation.into(),
        mode,
        route_revision: ROUTE_REVISION,
        writer: matches!(mode, Mode::Running | Mode::Quiesce).then(|| writer.unwrap().clone()),
    }
}
/// How the PostgreSQL double authenticates `app` after the StartupMessage.
#[derive(Clone)]
enum Double {
    /// A stand-in exchange the client completes itself: an `R 10` and an opaque `p` message.
    Opaque,
    /// SCRAM-SHA-256 for this password, as PostgreSQL runs it.
    Scram(&'static str),
    /// SCRAM-SHA-256 for this password, with a server signature that is not the verifier's.
    Forged(&'static str),
}
const SALT: &[u8] = b"pgcf test salt";
fn backend(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
/// AuthenticationOk through ReadyForQuery, as PostgreSQL sends it after a login.
fn authenticated() -> Vec<u8> {
    let mut bytes = backend(b'R', &[0, 0, 0, 0]);
    bytes.extend(backend(b'S', b"server_version\x0017.6\0"));
    bytes.extend(backend(b'K', &[0, 0, 0, 7, 1, 2, 3, 4]));
    bytes.extend(backend(b'Z', b"I"));
    bytes
}
/// PostgreSQL's own answer to a password it does not accept.
fn postgres_refusal() -> Vec<u8> {
    backend(
        b'E',
        b"SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed for user \"app\"\0Fauth.c\0L323\0Rauth_failed\0\0",
    )
}
fn pbkdf2(password: &[u8], salt: &[u8], iterations: u32) -> Vec<u8> {
    let mut block = hmac(password, &[salt, &1u32.to_be_bytes()].concat());
    let mut result = block.clone();
    for _ in 1..iterations {
        block = hmac(password, &block);
        result.iter_mut().zip(&block).for_each(|(a, b)| *a ^= b);
    }
    result
}
async fn frontend(stream: &mut UnixStream) -> Vec<u8> {
    assert_eq!(stream.read_u8().await.unwrap(), b'p');
    let length = stream.read_u32().await.unwrap() as usize;
    let mut body = vec![0; length - 4];
    stream.read_exact(&mut body).await.unwrap();
    body
}
impl Double {
    /// Runs the exchange; false when the double refused the client and closed.
    async fn authenticate(&self, stream: &mut UnixStream) -> bool {
        use sha2::Digest;
        let password = match self {
            Double::Opaque => {
                stream
                    .write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 10])
                    .await
                    .unwrap();
                let mut password = [0; 11];
                stream.read_exact(&mut password).await.unwrap();
                assert_eq!(&password, b"p\0\0\0\x0aopaque");
                stream
                    .write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I'])
                    .await
                    .unwrap();
                return true;
            }
            Double::Scram(password) | Double::Forged(password) => *password,
        };
        stream
            .write_all(&backend(
                b'R',
                b"\0\0\0\x0aSCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0",
            ))
            .await
            .unwrap();
        let initial = frontend(stream).await;
        let end = initial.iter().position(|v| *v == 0).unwrap();
        assert_eq!(&initial[..end], b"SCRAM-SHA-256");
        let first = std::str::from_utf8(&initial[end + 5..]).unwrap();
        let bare = first.strip_prefix("n,,").unwrap();
        let client_nonce = bare.strip_prefix("n=,r=").unwrap();
        let nonce = format!("{client_nonce}server");
        let server_first = format!("r={nonce},s={},i=4096", STANDARD.encode(SALT));
        stream
            .write_all(&backend(
                b'R',
                &[&11u32.to_be_bytes()[..], server_first.as_bytes()].concat(),
            ))
            .await
            .unwrap();
        let client_final = String::from_utf8(frontend(stream).await).unwrap();
        let (without_proof, proof) = client_final.rsplit_once(",p=").unwrap();
        assert_eq!(without_proof, format!("c=biws,r={nonce}"));
        let salted = pbkdf2(password.as_bytes(), SALT, 4096);
        let client_key = hmac(&salted, b"Client Key");
        let stored = Sha256::digest(&client_key);
        let message = format!("{bare},{server_first},{without_proof}");
        let signature = hmac(&stored, message.as_bytes());
        let proof = STANDARD.decode(proof).unwrap();
        let recovered: Vec<u8> = proof.iter().zip(&signature).map(|(a, b)| a ^ b).collect();
        if proof.len() != 32 || Sha256::digest(&recovered)[..] != stored[..] {
            stream.write_all(&postgres_refusal()).await.unwrap();
            let _ = stream.shutdown().await;
            return false;
        }
        let mut verifier = hmac(&hmac(&salted, b"Server Key"), message.as_bytes());
        if matches!(self, Double::Forged(_)) {
            verifier[0] ^= 1;
        }
        let mut answer = backend(
            b'R',
            &[
                &12u32.to_be_bytes()[..],
                format!("v={}", STANDARD.encode(verifier)).as_bytes(),
            ]
            .concat(),
        );
        answer.extend(authenticated());
        stream.write_all(&answer).await.unwrap();
        true
    }
}
/// One session of the double: the StartupMessage, the login, then a ReadyForQuery for every
/// message until Terminate or the end of the stream. `slow` reads each message only after 200 ms.
async fn postgres_session(
    mut stream: UnixStream,
    double: Double,
    slow: bool,
    send: mpsc::Sender<Vec<u8>>,
    ended: mpsc::Sender<()>,
) {
    // A dial whose client never sent its StartupMessage ends here.
    let Ok(length) = stream.read_u32().await else {
        return;
    };
    let mut raw = vec![0; length as usize - 4];
    stream.read_exact(&mut raw).await.unwrap();
    let mut startup_bytes = length.to_be_bytes().to_vec();
    startup_bytes.extend(raw);
    send.send(startup_bytes).await.unwrap();
    if !double.authenticate(&mut stream).await {
        return;
    }
    loop {
        if slow {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let mut header = [0; 5];
        match stream.read(&mut header[..1]).await {
            Ok(1) => {}
            _ => {
                let _ = ended.try_send(());
                break;
            }
        }
        if stream.read_exact(&mut header[1..]).await.is_err() {
            break;
        }
        let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
        let mut body = vec![0; length - 4];
        if stream.read_exact(&mut body).await.is_err() {
            break;
        }
        let mut bytes = header.to_vec();
        bytes.extend(body);
        if send.send(bytes).await.is_err() {
            break;
        }
        // After a Terminate the double keeps reading to observe how the gateway ends the stream.
        if header[0] != b'X' && stream.write_all(&[b'Z', 0, 0, 0, 5, b'I']).await.is_err() {
            break;
        }
    }
}
struct Fixture {
    gateway: Arc<Gateway>,
    port: u16,
    /// The unit the double serves: its socket, this process's uid and PID.
    unit: Writer,
    /// Connections the gateway dialled to the unit.
    calls: Arc<AtomicUsize>,
    /// A second handle on every socket the gateway accepts once `observe` is set, to read what it
    /// set on them. A second handle keeps the connection open after the gateway closes its own,
    /// so it is held only by a test that asks for it.
    accepted: Arc<std::sync::Mutex<Vec<std::net::TcpStream>>>,
    observe: Arc<std::sync::atomic::AtomicBool>,
    upstream: mpsc::Receiver<Vec<u8>>,
    /// One per upstream session whose stream the gateway ended.
    ends: mpsc::Receiver<()>,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    _directory: Directory,
}
impl Fixture {
    async fn new() -> Self {
        Self::build(
            |unit| vec![entry(Mode::Running, 1, &operation(), Some(unit))],
            false,
            Double::Opaque,
        )
        .await
    }
    /// The database asleep, after its first generation.
    async fn sleeping() -> Self {
        Self::build(
            |_| vec![entry(Mode::Sleeping, 1, &operation(), None)],
            false,
            Double::Opaque,
        )
        .await
    }
    /// Backpressure towards the double: after authentication it reads each message only after
    /// 200 ms.
    async fn congested() -> Self {
        Self::build(
            |unit| vec![entry(Mode::Running, 1, &operation(), Some(unit))],
            true,
            Double::Opaque,
        )
        .await
    }
    /// A PostgreSQL that authenticates `app` with SCRAM-SHA-256 for this password.
    async fn scram(running: bool, double: Double) -> Self {
        Self::build(
            |unit| {
                vec![if running {
                    entry(Mode::Running, 1, &operation(), Some(unit))
                } else {
                    entry(Mode::Sleeping, 1, &operation(), None)
                }]
            },
            false,
            double,
        )
        .await
    }
    async fn build(
        table: impl FnOnce(&Writer) -> Vec<Database>,
        slow: bool,
        double: Double,
    ) -> Self {
        let directory = Directory::new("tx");
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
            keyring: Keyring {
                active: "test".into(),
                keys: HashMap::from([("test".into(), vec![7; 32])]),
            },
            maximum_memory: 192 * 1024 * 1024,
            database_memory: 96 * 1024 * 1024,
        }));
        gateway.table.write().await.replace(table(&unit));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, receiver) = watch::channel(false);
        let (send, received) = mpsc::channel(16);
        let (ended, ends) = mpsc::channel(16);
        let mut shutdown = receiver.clone();
        let counted = calls.clone();
        let upstream_task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = upstream.accept() => {
                        let (stream, _) = accepted.unwrap();
                        counted.fetch_add(1, Ordering::SeqCst);
                        tasks.spawn(postgres_session(stream, double.clone(), slow, send.clone(), ended.clone()));
                    }
                }
            }
            tasks.abort_all();
        });
        let run = gateway.clone();
        let mut shutdown = receiver.clone();
        let accepted: Arc<std::sync::Mutex<Vec<std::net::TcpStream>>> = Arc::default();
        let observers = accepted.clone();
        let observe: Arc<std::sync::atomic::AtomicBool> = Arc::default();
        let observing = observe.clone();
        let gateway_task = tokio::spawn(async move {
            let pending = Arc::new(Semaphore::new(128));
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    _ = shutdown.changed() => break,
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        let socket = if observing.load(Ordering::SeqCst) {
                            let std = socket.into_std().unwrap();
                            observers.lock().unwrap().push(std.try_clone().unwrap());
                            TcpStream::from_std(std).unwrap()
                        } else {
                            socket
                        };
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
            accepted,
            observe,
            upstream: received,
            ends,
            stop,
            tasks: vec![upstream_task, gateway_task],
            _directory: directory,
        }
    }
    async fn connect(&self, id: usize) -> Client {
        self.upgrade(&route_token(id)).await.unwrap()
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
            Ok((client, _)) => Ok(client),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                Err(response.status().as_u16())
            }
            Err(error) => panic!("{error}"),
        }
    }
    async fn authenticate(&mut self, id: usize) -> Client {
        let mut client = self.connect(id).await;
        self.login(&mut client).await;
        client
    }
    /// Sends the StartupMessage and completes the double's password exchange.
    async fn login(&mut self, client: &mut Client) {
        client
            .send(Message::Binary(startup("app").into()))
            .await
            .unwrap();
        self.login_sent(client).await;
    }
    /// Completes the double's password exchange for a client whose StartupMessage was already
    /// sent (a held wake connection).
    async fn login_sent(&mut self, client: &mut Client) {
        assert_eq!(
            timeout(Duration::from_secs(10), self.upstream.recv())
                .await
                .unwrap()
                .unwrap(),
            startup("app")
        );
        let challenge = timeout(Duration::from_secs(10), client.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_data();
        assert_eq!(&challenge[..], [b'R', 0, 0, 0, 8, 0, 0, 0, 10]);
        client
            .send(Message::Binary(b"p\0\0\0\x0aopaque".to_vec().into()))
            .await
            .unwrap();
        let mut received = Vec::new();
        while received.len() < 15 {
            received.extend(
                timeout(Duration::from_secs(10), client.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap()
                    .into_data(),
            );
        }
        assert_eq!(
            received,
            [b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I']
        );
    }
    /// Waits until the gateway has released every session of the database.
    async fn ended(&self) {
        timeout(Duration::from_secs(5), async {
            while self
                .gateway
                .sessions
                .lock()
                .unwrap()
                .counts(DATABASE)
                .connections
                > 0
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
    /// The agent's entry for the database: `mode` at `generation` on the fixture's unit. With
    /// `signal`, the sessions are told as the channel tells them.
    async fn set(&self, mode: Mode, generation: u64, signal: bool) {
        self.gateway.table.write().await.update(entry(
            mode,
            generation,
            &operation(),
            Some(&self.unit),
        ));
        if signal {
            self.gateway.sessions.lock().unwrap().signal(
                DATABASE,
                match mode {
                    Mode::Quiesce => Action::Quiesce,
                    Mode::Running => Action::Running,
                    Mode::Sleeping | Mode::Retired => Action::Retire,
                },
            );
        }
    }
    /// The agent's entry for another unit of the database: a restarted PostgreSQL.
    async fn restart(&self) {
        let mut restarted = self.unit.clone();
        restarted.pid += 1;
        self.gateway.table.write().await.update(entry(
            Mode::Running,
            1,
            &operation(),
            Some(&restarted),
        ));
    }
    /// The release of a held wake: the unit running at the claimed generation and operation,
    /// under `route_revision`.
    async fn release_at(&self, generation: u64, route_revision: u64) {
        self.gateway.table.write().await.update(Database {
            route_revision,
            ..entry(
                Mode::Running,
                generation,
                &wake_operation(),
                Some(&self.unit),
            )
        });
    }
    async fn release(&self, generation: u64) {
        self.release_at(generation, ROUTE_REVISION).await;
    }
    async fn stop(self) {
        let _ = self.stop.send(true);
        for task in self.tasks {
            task.await.unwrap();
        }
    }
}
#[tokio::test]
async fn a_published_quiesce_blocks_frontend_bytes_even_when_the_sessions_are_not_yet_told() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(1).await;
    // The table has moved on, but the session still holds Running from before. Its bytes wait
    // until the database runs again.
    fixture.set(Mode::Quiesce, 1, false).await;
    client.send(Message::Binary(query().into())).await.unwrap();
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend bytes crossed a published quiesce"
    );
    fixture.set(Mode::Running, 1, true).await;
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    assert!(
        timeout(Duration::from_millis(100), fixture.upstream.recv())
            .await
            .is_err(),
        "held write was repeated"
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn every_socket_cloudflared_opened_sends_without_waiting_for_an_acknowledgement() {
    // The gateway answers a client in several small writes (the answer to SSLRequest, a pong, the
    // pieces of a result), and a write that waits for the acknowledgement of the one before it
    // meets the peer's delayed acknowledgement: a stall of about 40 ms on Linux.
    let fixture = Fixture::new().await;
    fixture.observe.store(true, Ordering::SeqCst);
    let _client = fixture.connect(2).await;
    {
        let accepted = fixture.accepted.lock().unwrap();
        assert_eq!(accepted.len(), 1);
        assert!(
            accepted[0].nodelay().unwrap(),
            "TCP_NODELAY is not set on the accepted socket"
        );
    }
    fixture.stop().await;
}
#[tokio::test]
async fn postgres_is_dialled_when_the_route_is_admitted_and_not_when_the_startup_message_arrives() {
    // The route names the database, the user and the unit, so nothing the StartupMessage says
    // changes where PostgreSQL is dialled: the dial overlaps the client's own round trips to it.
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(3).await;
    timeout(Duration::from_secs(5), async {
        while fixture.calls.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the dial begins with the admission");
    // Dialled, and not a byte sent: PostgreSQL has heard nothing of the client yet.
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err()
    );
    // The StartupMessage then goes to the connection that is there: no second dial.
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn what_postgresql_answers_in_one_piece_reaches_the_client_as_one_message() {
    // The greeting (authentication ok, then ReadyForQuery) is one burst of the server, and each
    // WebSocket message is flushed on its own: a burst split into messages would cost the client
    // a read per piece, and one flush per piece.
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(3).await;
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    fixture.upstream.recv().await.unwrap();
    timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    client
        .send(Message::Binary(b"p\0\0\0\x0aopaque".to_vec().into()))
        .await
        .unwrap();
    let greeting = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert_eq!(
        &greeting[..],
        [b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I']
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_startup_that_is_not_the_route_s_reaches_postgres_as_not_one_byte() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(3).await;
    client
        .send(Message::Binary(startup("wrong_role").into()))
        .await
        .unwrap();
    let error = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert!(String::from_utf8_lossy(&error).contains("28000"));
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "bytes of a client whose startup is not its route's reached PostgreSQL"
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_quiescing_database_whose_sleep_ends_retired_refuses_further_frontend_data() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(4).await;
    // The agent quiesces the database: what the client sends waits.
    fixture.set(Mode::Quiesce, 1, true).await;
    client.send(Message::Binary(query().into())).await.unwrap();
    client.send(Message::Binary(query().into())).await.unwrap();
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err()
    );
    // The database is retired on this node: the session closes and its held bytes are dropped.
    fixture
        .gateway
        .table
        .write()
        .await
        .update(entry(Mode::Retired, 1, &operation(), None));
    fixture
        .gateway
        .sessions
        .lock()
        .unwrap()
        .signal(DATABASE, Action::Retire);
    let message = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(message,Message::Close(Some(frame))if frame.code==tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Restart)
    );
    assert!(
        timeout(Duration::from_millis(100), fixture.upstream.recv())
            .await
            .is_err()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn large_frontend_frame_streams_once_after_small_startup_limit_is_released() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(5).await;
    let bytes = large_query();
    client
        .send(Message::Binary(bytes.clone().into()))
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        bytes
    );
    let response = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert_eq!(&response[..], [b'Z', 0, 0, 0, 5, b'I']);
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn partial_websocket_message_blocks_idle_close_until_released() {
    use tokio_tungstenite::tungstenite::protocol::frame::{
        Frame,
        coding::{Data, OpCode},
    };
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(6).await;
    let query = query();
    client
        .send(Message::Frame(Frame::message(
            query[..3].to_vec(),
            OpCode::Data(Data::Binary),
            false,
        )))
        .await
        .unwrap();
    timeout(Duration::from_secs(1), async {
        loop {
            if fixture
                .gateway
                .sessions
                .lock()
                .unwrap()
                .counts(DATABASE)
                .busy
                > 0
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // The agent's close finds the session busy: it stays.
    fixture.set(Mode::Quiesce, 1, true).await;
    fixture
        .gateway
        .sessions
        .lock()
        .unwrap()
        .signal(DATABASE, Action::CloseIdle);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let counts = fixture.gateway.sessions.lock().unwrap().counts(DATABASE);
    assert_eq!((counts.connections, counts.busy), (1, 1));
    fixture.set(Mode::Running, 1, true).await;
    client
        .send(Message::Frame(Frame::message(
            query[3..].to_vec(),
            OpCode::Data(Data::Continue),
            true,
        )))
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_restarted_unit_closes_the_authenticated_session_and_ends_its_stream_without_new_bytes() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(800).await;
    fixture.restart().await;
    client.send(Message::Binary(query().into())).await.unwrap();
    let next = timeout(Duration::from_secs(1), client.next())
        .await
        .unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | Some(Err(_)) | None),
        "old unit remained active: {next:?}"
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend crossed a changed unit"
    );
    timeout(Duration::from_secs(2), fixture.ends.recv())
        .await
        .expect("the gateway ends the old unit's stream")
        .unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_route_reaches_only_its_admitted_generation_unit_and_route_revision() {
    let mut fixture = Fixture::new().await;
    let client = fixture.authenticate(900).await;
    drop(client);
    for route in [
        admitted(901, 2, INSTANCE, ROUTE_REVISION),
        admitted(902, 1, &cid(299), ROUTE_REVISION),
        admitted(903, 1, INSTANCE, ROUTE_REVISION + 1),
        // Only an admission route names the route revision.
        routed(904, 1, INSTANCE),
        legacy_route_token(905),
    ] {
        assert_eq!(fixture.upgrade(&route).await.err(), Some(503));
    }
    fixture.set(Mode::Running, 2, true).await;
    assert_eq!(fixture.upgrade(&route_token(906)).await.err(), Some(503));
    let admitted = fixture
        .upgrade(&admitted(907, 2, INSTANCE, ROUTE_REVISION))
        .await
        .unwrap();
    // One dial for each route that was admitted, none for the routes that were refused.
    timeout(Duration::from_secs(5), async {
        while fixture.calls.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    drop(admitted);
    fixture.stop().await;
}
#[tokio::test]
async fn a_unit_replaced_after_admission_is_never_written_to() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(910).await;
    fixture.restart().await;
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    let error = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert!(String::from_utf8_lossy(&error).contains("08006"));
    // The unit admitted was dialled when it was admitted, and no replacement was: nothing
    // reached either of them.
    assert!(fixture.calls.load(Ordering::SeqCst) <= 1);
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err()
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_route_waits_for_the_agent_s_table() {
    let mut fixture = Fixture::new().await;
    fixture.gateway.table.write().await.disconnect();
    assert_eq!(fixture.upgrade(&route_token(940)).await.err(), Some(503));
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    // The agent's next table admits and dials the same route.
    let unit = fixture.unit.clone();
    fixture.gateway.table.write().await.replace(vec![entry(
        Mode::Running,
        1,
        &operation(),
        Some(&unit),
    )]);
    let client = fixture.authenticate(941).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    drop(client);
    fixture.stop().await;
}
#[tokio::test]
async fn a_client_terminate_reaches_postgres_before_the_end_of_its_stream() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(950).await;
    client
        .send(Message::Binary(vec![b'X', 0, 0, 0, 4].into()))
        .await
        .unwrap();
    client.close(None).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        [b'X', 0, 0, 0, 4]
    );
    timeout(Duration::from_secs(2), fixture.ends.recv())
        .await
        .expect("the gateway ends PostgreSQL's stream")
        .unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn every_routed_connection_logs_one_ordered_stage_line() {
    if std::env::var_os("PGCF_CONN_STAGES_CHILD").is_none() {
        // The gateway logs to stdout, so a child test process runs the connections below.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "every_routed_connection_logs_one_ordered_stage_line",
                "--nocapture",
            ])
            .env("PGCF_CONN_STAGES_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let lines: Vec<Value> = stdout
            .lines()
            .filter_map(|line| serde_json::from_str(&line[line.find('{')?..]).ok())
            .filter(|line: &Value| line["event"] == "conn_stages")
            .collect();
        assert_eq!(lines.len(), 3, "{stdout}");
        for line in &lines {
            // Only these fields: no role, address, token or payload byte.
            assert_eq!(
                line.as_object().unwrap().keys().collect::<Vec<_>>(),
                [
                    "database",
                    "dial_ms",
                    "event",
                    "first_backend_ms",
                    "outcome",
                    "session_ms",
                    "startup_ms",
                    "upgrade_ms",
                    "wake_path",
                ]
            );
            assert_eq!(line["database"], DATABASE);
            assert_eq!(line["wake_path"], "warm");
        }
        let complete = |name: &str| lines[0][name].as_u64().unwrap();
        assert_eq!(lines[0]["outcome"], "client_closed");
        // The client waited 40 ms before its StartupMessage and 40 ms before closing.
        assert!(complete("startup_ms") >= 40, "{}", lines[0]);
        assert!(
            complete("upgrade_ms")
                + complete("startup_ms")
                + complete("dial_ms")
                + complete("first_backend_ms")
                + 40
                <= complete("session_ms"),
            "{}",
            lines[0]
        );
        assert_eq!(lines[1]["outcome"], "startup_route_mismatch");
        for reached in ["upgrade_ms", "startup_ms", "session_ms"] {
            assert!(lines[1][reached].is_u64(), "{}", lines[1]);
        }
        assert!(lines[1]["dial_ms"].is_null() && lines[1]["first_backend_ms"].is_null());
        assert_eq!(lines[2]["outcome"], "target_unavailable");
        for unreached in ["upgrade_ms", "startup_ms", "dial_ms", "first_backend_ms"] {
            assert!(lines[2][unreached].is_null());
        }
        return;
    }
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(960).await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    fixture.login(&mut client).await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    client.close(None).await.unwrap();
    fixture.ended().await;
    let mut client = fixture.connect(961).await;
    client
        .send(Message::Binary(startup("wrong_role").into()))
        .await
        .unwrap();
    let error = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert!(String::from_utf8_lossy(&error).contains("28000"));
    fixture.ended().await;
    // The agent's table names no such database: the connection is refused before its upgrade.
    fixture.gateway.table.write().await.replace(Vec::new());
    assert_eq!(fixture.upgrade(&route_token(962)).await.err(), Some(503));
    tokio::time::sleep(Duration::from_millis(100)).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_large_frontend_write_reaches_a_slowly_reading_postgres_in_full() {
    let mut fixture = Fixture::congested().await;
    let mut client = fixture.authenticate(970).await;
    let bytes = large_query();
    client
        .send(Message::Binary(bytes.clone().into()))
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        bytes
    );
    let reply = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert_eq!(&reply[..], [b'Z', 0, 0, 0, 5, b'I']);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
/// One plain HTTP request to the gateway: the status and the body.
async fn get(fixture: &Fixture, path: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port))
        .await
        .unwrap();
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let status = text.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}
#[tokio::test]
async fn readyz_requires_the_agent_s_table() {
    let fixture = Fixture::new().await;
    assert_eq!(get(&fixture, "/readyz").await, (200, "ok\n".into()));
    // The channel is lost: the gateway is not ready, and stays alive.
    fixture.gateway.table.write().await.disconnect();
    assert_eq!(get(&fixture, "/healthz").await.0, 200);
    let (status, body) = get(&fixture, "/readyz").await;
    assert_eq!((status, body.as_str()), (503, "unsynchronized\n"));
    fixture.gateway.table.write().await.replace(Vec::new());
    assert_eq!(get(&fixture, "/readyz").await.0, 200);
    fixture.stop().await;
}

// Wake (route token v5): the gateway holds a sleeping database's connection, queues its wake for
// the node agent and releases it when the agent's table shows the woken unit.
const ROLE_HASH: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
fn wake_operation() -> String {
    format!("op_{}", "w".repeat(20))
}
/// The wake ticket the Edge signs for a database whose Actor snapshot sits at `generation - 1`.
fn wake_token(id: usize, generation: u64) -> String {
    wake_ticket(id, generation, &wake_operation(), REGION)
}
fn wake_ticket(id: usize, generation: u64, operation: &str, region: &str) -> String {
    let now = http::now() / 1000;
    token(
        wake::ROUTE_PREFIX,
        wake::ROUTE_DOMAIN,
        json!({"v":5,"db":DATABASE,"user":"app","cid":cid(id),"rg":region,"kid":"test","iat":now,"exp":now+30,"op":operation,"gen":generation,"route_revision":ROUTE_REVISION,"rh":ROLE_HASH}),
        &[7; 32],
    )
}
/// The agent's result for the wake of `generation`.
fn wake_result(generation: u64, outcome: Outcome) -> WakeResult {
    WakeResult {
        database: DATABASE.into(),
        operation: wake_operation(),
        generation,
        outcome,
        reason: (outcome == Outcome::Refused).then(|| "deleted".into()),
        steps_ms: Default::default(),
    }
}
/// The FATAL ErrorResponse a held connection ends with, and then the end of the socket.
async fn fatal(client: &mut Client, wait: Duration) -> String {
    let message = timeout(wait, client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert_eq!(message[0], b'E', "not an ErrorResponse: {message:?}");
    String::from_utf8_lossy(&message).into_owned()
}
/// Nothing reached PostgreSQL and nothing was dialled.
async fn untouched(fixture: &mut Fixture) {
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "bytes of a held connection reached PostgreSQL"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
}
async fn held_count(fixture: &Fixture, expected: usize) {
    timeout(Duration::from_secs(5), async {
        while fixture.gateway.wakes.held(DATABASE) != expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn a_v5_ticket_is_upgraded_at_once_and_its_startup_is_held_until_the_table_releases_it() {
    let mut fixture = Fixture::sleeping().await;
    let started = std::time::Instant::now();
    let mut client = fixture.upgrade(&wake_token(1000, 2)).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 1);
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    fixture.release(2).await;
    fixture.login_sent(&mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    held_count(&fixture, 0).await;
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn the_held_startup_reaches_postgres_unchanged_after_release_and_never_before() {
    let mut fixture = Fixture::sleeping().await;
    let mut client = fixture.upgrade(&wake_token(1001, 2)).await.unwrap();
    // An SSLRequest is answered while held, then the StartupMessage and a pipelined password.
    client
        .send(Message::Binary(vec![0, 0, 0, 8, 4, 210, 22, 47].into()))
        .await
        .unwrap();
    let answer = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data();
    assert_eq!(&answer[..], b"N");
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    client
        .send(Message::Binary(b"p\0\0\0\x0aopaque".to_vec().into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    fixture.release(2).await;
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    // The double reads the pipelined password before it answers: the client's bytes arrived in
    // order and in full.
    let mut received = Vec::new();
    while received.len() < 24 {
        received.extend(
            timeout(Duration::from_secs(10), client.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .into_data(),
        );
    }
    assert_eq!(
        received,
        [
            b'R', 0, 0, 0, 8, 0, 0, 0, 10, b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I'
        ]
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_wake_released_under_the_route_revision_cloudflare_s_claim_moved_to_is_routed() {
    // The ticket names route revision 19; Cloudflare's claim of the wake commits 20, and the
    // agent releases the unit under it.
    let mut fixture = Fixture::sleeping().await;
    let mut client = fixture.upgrade(&wake_token(1080, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    fixture.release_at(2, ROUTE_REVISION + 1).await;
    fixture.login_sent(&mut client).await;
    held_count(&fixture, 0).await;
    client.close(None).await.unwrap();
    // A ticket signed before the claim is routed at once, as warm.
    let mut warm = fixture.upgrade(&wake_token(1081, 2)).await.unwrap();
    fixture.login(&mut warm).await;
    warm.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_wake_released_under_an_older_route_revision_than_its_ticket_is_stale() {
    let mut fixture = Fixture::sleeping().await;
    let mut client = fixture.upgrade(&wake_token(1082, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    fixture.release_at(2, ROUTE_REVISION - 1).await;
    assert!(
        fatal(&mut client, Duration::from_secs(10))
            .await
            .contains("57P03")
    );
    untouched(&mut fixture).await;
    fixture.stop().await;
}
#[tokio::test]
async fn one_wake_per_database_is_queued_and_a_second_connection_coalesces() {
    let mut fixture = Fixture::sleeping().await;
    let mut first = fixture.upgrade(&wake_token(1010, 2)).await.unwrap();
    let mut second = fixture.upgrade(&wake_token(1011, 2)).await.unwrap();
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 2);
    let wakes = fixture.gateway.wakes.poll(Duration::from_secs(1)).await;
    assert_eq!(wakes.len(), 1, "{wakes:?}");
    assert_eq!(wakes[0].database, DATABASE);
    assert_eq!(wakes[0].operation, wake_operation());
    assert_eq!(wakes[0].generation, 2);
    assert_eq!(wakes[0].route_revision, ROUTE_REVISION);
    assert_eq!(wakes[0].role_revision_hash, ROLE_HASH);
    assert!(wakes[0].queued_at_ms > 0);
    for client in [&mut first, &mut second] {
        client
            .send(Message::Binary(startup("app").into()))
            .await
            .unwrap();
    }
    fixture.release(2).await;
    for client in [&mut first, &mut second] {
        fixture.login_sent(client).await;
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.stop().await;
}
#[tokio::test]
async fn a_queued_wake_is_delivered_at_once_and_again_only_after_3_s_without_a_result() {
    let fixture = Fixture::sleeping().await;
    let _client = fixture.upgrade(&wake_token(1020, 2)).await.unwrap();
    let started = std::time::Instant::now();
    let first = fixture.gateway.wakes.poll(Duration::from_secs(10)).await;
    assert_eq!(first.len(), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
    let started = std::time::Instant::now();
    let again = fixture.gateway.wakes.poll(Duration::from_secs(10)).await;
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(wake::REDELIVER_MS - 100),
        "{waited:?}"
    );
    assert!(waited < Duration::from_secs(5), "{waited:?}");
    assert_eq!(first, again);
    // The agent answered: the ticket is not delivered again.
    assert!(
        fixture
            .gateway
            .wakes
            .result(&wake_result(2, Outcome::Started))
    );
    assert!(
        fixture
            .gateway
            .wakes
            .poll(Duration::from_millis(wake::REDELIVER_MS + 500))
            .await
            .is_empty()
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_refused_result_answers_57p03_to_every_held_connection_of_that_ticket() {
    let mut fixture = Fixture::sleeping().await;
    let mut first = fixture.upgrade(&wake_token(1040, 2)).await.unwrap();
    let mut second = fixture.upgrade(&wake_token(1041, 2)).await.unwrap();
    first
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    fixture.gateway.wakes.poll(Duration::from_secs(1)).await;
    assert!(
        fixture
            .gateway
            .wakes
            .result(&wake_result(2, Outcome::Refused))
    );
    for client in [&mut first, &mut second] {
        assert!(
            fatal(client, Duration::from_secs(5))
                .await
                .contains("57P03")
        );
    }
    untouched(&mut fixture).await;
    held_count(&fixture, 0).await;
    // A result for a ticket the gateway does not hold is unknown.
    assert!(
        !fixture
            .gateway
            .wakes
            .result(&wake_result(3, Outcome::Started))
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_held_connection_past_25_s_answers_57p03_and_leaves_the_queue() {
    let mut fixture = Fixture::sleeping().await;
    let started = std::time::Instant::now();
    let mut client = fixture.upgrade(&wake_token(1050, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    assert!(
        fatal(&mut client, Duration::from_secs(30))
            .await
            .contains("57P03")
    );
    assert!(started.elapsed() >= Duration::from_millis(wake::WAKE_BOUND_MS - 100));
    held_count(&fixture, 0).await;
    assert!(fixture.gateway.wakes.ticket(DATABASE).is_none());
    untouched(&mut fixture).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_table_that_moves_past_the_ticket_generation_answers_57p03() {
    let mut fixture = Fixture::sleeping().await;
    let mut client = fixture.upgrade(&wake_token(1060, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    fixture
        .gateway
        .table
        .write()
        .await
        .update(entry(Mode::Sleeping, 3, &operation(), None));
    assert!(
        fatal(&mut client, Duration::from_secs(5))
            .await
            .contains("57P03")
    );
    untouched(&mut fixture).await;
    // A ticket the table has already moved past is not held at all.
    assert_eq!(fixture.upgrade(&wake_token(1061, 2)).await.err(), Some(503));
    held_count(&fixture, 0).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_v5_ticket_already_released_at_its_generation_is_routed_at_once_as_warm() {
    let mut fixture = Fixture::sleeping().await;
    fixture.release(2).await;
    let mut client = fixture.upgrade(&wake_token(1070, 2)).await.unwrap();
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 0);
    assert!(fixture.gateway.wakes.ticket(DATABASE).is_none());
    fixture.login(&mut client).await;
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn held_connections_beyond_32_per_database_are_refused_before_the_upgrade() {
    let fixture = Fixture::sleeping().await;
    let mut held = Vec::new();
    for id in 0..wake::MAX_HELD_PER_DATABASE {
        held.push(fixture.upgrade(&wake_token(1100 + id, 2)).await.unwrap());
    }
    assert_eq!(
        fixture
            .upgrade(&wake_token(1100 + wake::MAX_HELD_PER_DATABASE, 2))
            .await
            .err(),
        Some(429)
    );
    assert_eq!(
        fixture.gateway.wakes.held(DATABASE),
        wake::MAX_HELD_PER_DATABASE
    );
    drop(held);
    held_count(&fixture, 0).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_replayed_v5_cid_is_refused() {
    let fixture = Fixture::sleeping().await;
    let ticket = wake_token(1200, 2);
    let _client = fixture.upgrade(&ticket).await.unwrap();
    assert_eq!(fixture.upgrade(&ticket).await.err(), Some(403));
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 1);
    // A ticket for another region is not this gateway's.
    assert_eq!(
        fixture
            .upgrade(&wake_ticket(1201, 2, &wake_operation(), "eu-other"))
            .await
            .err(),
        Some(403)
    );
    fixture.stop().await;
}
const PASSWORD: &str = "zN4kQ8-cleartext-canary-7rT2";
/// What a client that pipelines its password writes behind its StartupMessage.
fn password_message(password: &[u8]) -> Vec<u8> {
    let mut bytes = vec![b'p'];
    bytes.extend_from_slice(&((password.len() + 5) as u32).to_be_bytes());
    bytes.extend_from_slice(password);
    bytes.push(0);
    bytes
}
/// AuthenticationCleartextPassword.
const CLEARTEXT_REQUEST: [u8; 9] = [b'R', 0, 0, 0, 8, 0, 0, 0, 3];
async fn next_message(client: &mut Client) -> Vec<u8> {
    timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .to_vec()
}
/// The decoys' refusal: what an unknown route answers to any password.
async fn refused_as_the_decoys_refuse(client: &mut Client) {
    assert_eq!(
        next_message(client).await,
        pgcf_native_protocol::startup::error_response("28P01", "password authentication failed")
    );
    match timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
    {
        Some(Ok(Message::Close(Some(frame)))) => {
            assert_eq!(u16::from(frame.code), 1000);
            assert_eq!(frame.reason.as_str(), "connection refused");
        }
        other => panic!("not the decoys' close: {other:?}"),
    }
}
#[tokio::test]
async fn a_password_pipelined_behind_the_startup_is_asked_for_and_proven_to_postgres_with_scram() {
    let mut fixture = Fixture::scram(true, Double::Scram(PASSWORD)).await;
    let mut client = fixture.connect(1500).await;
    client
        .send(Message::Binary(
            [
                startup("app"),
                password_message(PASSWORD.as_bytes()),
                query(),
            ]
            .concat()
            .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
    // PostgreSQL hears the StartupMessage alone: the password stays with the gateway.
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    // AuthenticationOk through ReadyForQuery arrive as one message.
    assert_eq!(next_message(&mut client).await, authenticated());
    // The pipelined query reaches PostgreSQL after the login and is answered.
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    assert_eq!(next_message(&mut client).await, [b'Z', 0, 0, 0, 5, b'I']);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_pipelined_password_split_across_messages_is_completed_before_postgres_hears_it() {
    let mut fixture = Fixture::scram(true, Double::Scram(PASSWORD)).await;
    let mut client = fixture.connect(1501).await;
    let password = password_message(PASSWORD.as_bytes());
    client
        .send(Message::Binary(
            [startup("app"), password[..3].to_vec()].concat().into(),
        ))
        .await
        .unwrap();
    // Whether it is a password shows only once the message is whole.
    assert!(
        timeout(Duration::from_millis(150), client.next())
            .await
            .is_err()
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "PostgreSQL heard of a password not yet complete"
    );
    client
        .send(Message::Binary(password[3..].to_vec().into()))
        .await
        .unwrap();
    assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    assert_eq!(next_message(&mut client).await, authenticated());
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_wrong_pipelined_password_is_refused_as_the_decoys_refuse_it() {
    let fixture = Fixture::scram(true, Double::Scram(PASSWORD)).await;
    let mut client = fixture.connect(1502).await;
    client
        .send(Message::Binary(
            [startup("app"), password_message(b"wrong")].concat().into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
    refused_as_the_decoys_refuse(&mut client).await;
    fixture.stop().await;
}
#[tokio::test]
async fn an_empty_or_oversized_pipelined_password_never_reaches_postgres() {
    let mut fixture = Fixture::scram(true, Double::Scram(PASSWORD)).await;
    let mut oversized = password_message(&vec![b'x'; 4096]);
    oversized.truncate(64);
    for (id, password) in [(1503, password_message(b"")), (1505, oversized)] {
        let mut client = fixture.connect(id).await;
        client
            .send(Message::Binary([startup("app"), password].concat().into()))
            .await
            .unwrap();
        assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
        refused_as_the_decoys_refuse(&mut client).await;
    }
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "a refused password's StartupMessage reached PostgreSQL"
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_postgres_that_cannot_prove_the_verifier_is_never_trusted_with_the_session() {
    let mut fixture = Fixture::scram(true, Double::Forged(PASSWORD)).await;
    let mut client = fixture.connect(1506).await;
    client
        .send(Message::Binary(
            [
                startup("app"),
                password_message(PASSWORD.as_bytes()),
                query(),
            ]
            .concat()
            .into(),
        ))
        .await
        .unwrap();
    assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
    let failure = next_message(&mut client).await;
    assert_eq!(failure[0], b'E');
    assert!(String::from_utf8_lossy(&failure).contains("C08006"));
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "the pipelined query reached an unproven PostgreSQL"
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_held_wake_asks_for_the_pipelined_password_at_once_and_logs_in_after_release() {
    let mut fixture = Fixture::scram(false, Double::Scram(PASSWORD)).await;
    let mut client = fixture.upgrade(&wake_token(1507, 2)).await.unwrap();
    client
        .send(Message::Binary(
            [
                startup("app"),
                password_message(PASSWORD.as_bytes()),
                query(),
            ]
            .concat()
            .into(),
        ))
        .await
        .unwrap();
    // Asked for while held: only the query's round trip remains after the release.
    assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
    untouched(&mut fixture).await;
    fixture.release(2).await;
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    assert_eq!(next_message(&mut client).await, authenticated());
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_cleartext_password_never_reaches_a_log_line() {
    if std::env::var_os("PGCF_CLEARTEXT_LOG_CHILD").is_none() {
        // The gateway logs to stdout, so a child test process runs the connections below.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "a_cleartext_password_never_reaches_a_log_line",
                "--nocapture",
            ])
            .env("PGCF_CLEARTEXT_LOG_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("conn_stages"));
        assert!(!stdout.contains(PASSWORD));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(PASSWORD));
        return;
    }
    let fixture = Fixture::scram(true, Double::Scram(PASSWORD)).await;
    for (id, password) in [(1508, PASSWORD), (1509, "zN4kQ8-cleartext-canary-7rT2x")] {
        let mut client = fixture.connect(id).await;
        client
            .send(Message::Binary(
                [startup("app"), password_message(password.as_bytes())]
                    .concat()
                    .into(),
            ))
            .await
            .unwrap();
        assert_eq!(next_message(&mut client).await, CLEARTEXT_REQUEST);
        let _ = next_message(&mut client).await;
        let _ = client.close(None).await;
    }
    fixture.ended().await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_pipelined_message_that_is_not_a_password_keeps_scram_end_to_end() {
    // A SASLInitialResponse holds a NUL inside; the double's stand-in holds none at its end.
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(1510).await;
    client
        .send(Message::Binary(
            [startup("app"), b"p\0\0\0\x0aopaque".to_vec()]
                .concat()
                .into(),
        ))
        .await
        .unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        startup("app")
    );
    let mut received = Vec::new();
    while received.len() < 24 {
        received.extend(next_message(&mut client).await);
    }
    assert_eq!(
        received,
        [
            b'R', 0, 0, 0, 8, 0, 0, 0, 10, b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I'
        ]
    );
    client.close(None).await.unwrap();
    fixture.stop().await;
}
