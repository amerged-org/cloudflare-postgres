// SPDX-License-Identifier: Apache-2.0
//! Real loopback WebSocket and TLS sockets; this is protocol conformance, not Dev SQL acceptance.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    control,
    kubernetes::{Fence, Intent},
    sessions::Action,
    transport::{self, Config, DatabaseTarget, Gateway, PostgresDial},
};
use pgcf_native_protocol::{route::Keyring, wake, wire};
use rcgen::generate_simple_self_signed;
use rustls::{
    ServerConfig,
    pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_rustls::{TlsAcceptor, client::TlsStream};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
type Failure = Box<dyn std::error::Error + Send + Sync>;
type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;
const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
const REGION: &str = "eu-test";
const POD: &str = "01234567-89ab-4def-8123-0123456789ab";
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
/// The route Cloudflare admits for the fixture's running revision and published writer.
fn route_token(id: usize) -> String {
    routed(id, 1, &cid(200))
}
fn routed(id: usize, revision: u64, pod: &str) -> String {
    let now = control::now() / 1000;
    token(
        wire("routeTokenPrefix"),
        wire("routeSignatureDomain"),
        json!({"v":3,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":revision,"pod":pod}),
        &[7; 32],
    )
}
/// Temporary rollout compatibility: a v2 route names no revision or target.
fn legacy_route_token(id: usize) -> String {
    let now = control::now() / 1000;
    token(
        wire("legacyRouteTokenPrefix"),
        wire("legacyRouteSignatureDomain"),
        json!({"v":2,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30}),
        &[7; 32],
    )
}
fn control_token(action: &str, revision: u64) -> String {
    let now = control::now() / 1000;
    let key = hmac(&[7; 32], wire("controlKeyPurpose").as_bytes());
    token(
        wire("controlTokenPrefix"),
        wire("controlSigningPurpose"),
        json!({"v":1,"region":REGION,"database":DATABASE,"operation":operation(),"revision":revision,"pod":POD,"action":action,"kid":"test","iat":now,"exp":now+30}),
        &key,
    )
}
fn activity_token(nonce: usize, revision: u64) -> String {
    let now = control::now() / 1000;
    let key = hmac(&[7; 32], wire("activityKeyPurpose").as_bytes());
    token(
        wire("activityTokenPrefix"),
        wire("activitySigningPurpose"),
        json!({"v":1,"region":REGION,"database":DATABASE,"revision":revision,"pod":POD,"nonce":cid(nonce),"kid":"test","iat":now,"exp":now+30}),
        &key,
    )
}
fn fence(mode: &str, revision: u64) -> Fence {
    Fence {
        admission_target: None,
        uid: cid(100),
        intent: Intent {
            database: DATABASE.into(),
            operation: operation(),
            revision,
            mode: mode.into(),
        },
        retired_at: None,
        deleting: false,
    }
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
fn writer(pod: &str) -> Value {
    json!({"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice","metadata":{"name":"database-rw-a","namespace":format!("pgcf-db-{DATABASE}"),"uid":cid(201),"labels":{"kubernetes.io/service-name":"database-rw"}},"addressType":"IPv4","ports":[{"port":5432,"protocol":"TCP"}],"endpoints":[{"addresses":["10.0.0.7"],"conditions":{"ready":true},"targetRef":{"kind":"Pod","namespace":format!("pgcf-db-{DATABASE}"),"uid":pod},"nodeName":"customer-us1"}]})
}
fn legacy_identity() -> Value {
    json!({"handle":format!("pvc-{}",cid(205)),"claimUid":cid(205),"volumeUid":cid(206)})
}
fn storage_maps() -> Vec<Value> {
    let labels = json!({"pgcf.io/database-id":DATABASE});
    let state = json!({"node":"customer-us1","namespaceUid":cid(207),"clusterUid":cid(208)});
    let identity = legacy_identity();
    vec![
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{DATABASE}"),"namespace":"pgcf-system","uid":cid(202),"labels":labels,"annotations":{"pgcf.io/volume-identity":identity.to_string()}},"data":{"state":state.to_string()}}),
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{DATABASE}"),"namespace":"pgcf-system","uid":cid(100),"labels":labels},"data":{"power.json":json!({"anchor":{"storageUid":cid(202),"storageState":state.to_string(),"volumeIdentity":identity.to_string(),"physicalGeneration":1}}).to_string()}}),
    ]
}
struct TestDial {
    address: std::net::SocketAddr,
    ca: Vec<u8>,
    calls: Arc<AtomicUsize>,
    dialled: Arc<std::sync::Mutex<Vec<DatabaseTarget>>>,
    send_buffer: Option<u32>,
}
impl PostgresDial for TestDial {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>> {
        Box::pin(async move {
            assert_eq!(target.database, DATABASE);
            // The database's own writer, or the pool slot a wake was released to.
            if target.host == wake::slot_tls_name(SLOT) {
                assert_eq!(target.pod_uid, cid(300));
            } else {
                assert_eq!(target.host, format!("database-rw.pgcf-db-{DATABASE}.svc"));
                assert_eq!(target.pod_uid, cid(200));
            }
            assert_eq!(target.port, 5432);
            assert_eq!(target.address.to_string(), "10.0.0.7");
            self.dialled.lock().unwrap().push(target.clone());
            self.calls.fetch_add(1, Ordering::SeqCst);
            let socket = TcpSocket::new_v4()?;
            if let Some(size) = self.send_buffer {
                socket.set_send_buffer_size(size)?;
            }
            transport::negotiate_tls(socket.connect(self.address).await?, &target.host, &self.ca)
                .await
        })
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
async fn frontend(tls: &mut tokio_rustls::server::TlsStream<TcpStream>) -> Vec<u8> {
    assert_eq!(tls.read_u8().await.unwrap(), b'p');
    let length = tls.read_u32().await.unwrap() as usize;
    let mut body = vec![0; length - 4];
    tls.read_exact(&mut body).await.unwrap();
    body
}
impl Double {
    /// Runs the exchange; false when the double refused the client and closed.
    async fn authenticate(&self, tls: &mut tokio_rustls::server::TlsStream<TcpStream>) -> bool {
        use sha2::Digest;
        let password = match self {
            Double::Opaque => {
                tls.write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 10])
                    .await
                    .unwrap();
                let mut password = [0; 11];
                tls.read_exact(&mut password).await.unwrap();
                assert_eq!(&password, b"p\0\0\0\x0aopaque");
                tls.write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I'])
                    .await
                    .unwrap();
                return true;
            }
            Double::Scram(password) | Double::Forged(password) => *password,
        };
        tls.write_all(&backend(
            b'R',
            b"\0\0\0\x0aSCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0",
        ))
        .await
        .unwrap();
        let initial = frontend(tls).await;
        let end = initial.iter().position(|v| *v == 0).unwrap();
        assert_eq!(&initial[..end], b"SCRAM-SHA-256");
        let first = std::str::from_utf8(&initial[end + 5..]).unwrap();
        let bare = first.strip_prefix("n,,").unwrap();
        let client_nonce = bare.strip_prefix("n=,r=").unwrap();
        let nonce = format!("{client_nonce}server");
        let server_first = format!("r={nonce},s={},i=4096", STANDARD.encode(SALT));
        tls.write_all(&backend(
            b'R',
            &[&11u32.to_be_bytes()[..], server_first.as_bytes()].concat(),
        ))
        .await
        .unwrap();
        let client_final = String::from_utf8(frontend(tls).await).unwrap();
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
            tls.write_all(&postgres_refusal()).await.unwrap();
            let _ = tls.shutdown().await;
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
        tls.write_all(&answer).await.unwrap();
        true
    }
}
struct Fixture {
    gateway: Arc<Gateway>,
    port: u16,
    calls: Arc<AtomicUsize>,
    /// Every target the gateway dialled, in order.
    dialled: Arc<std::sync::Mutex<Vec<DatabaseTarget>>>,
    /// A second handle on every socket the gateway accepts once `observe` is set, to read what it
    /// set on them. A second handle keeps the connection open after the gateway closes its own,
    /// so it is held only by a test that asks for it.
    accepted: Arc<std::sync::Mutex<Vec<std::net::TcpStream>>>,
    observe: Arc<std::sync::atomic::AtomicBool>,
    upstream: mpsc::Receiver<Vec<u8>>,
    /// Per ended upstream session: true when the gateway ended TLS with close_notify.
    closes: mpsc::Receiver<bool>,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_fences(HashMap::from([(DATABASE.into(), fence("running", 1))])).await
    }
    /// Backpressure towards the double: both ends of its TLS path keep small socket buffers,
    /// and after authentication it reads each message only after 200 ms.
    async fn congested() -> Self {
        Self::build(
            HashMap::from([(DATABASE.into(), fence("running", 1))]),
            true,
            Double::Opaque,
        )
        .await
    }
    async fn with_fences(fences: HashMap<String, Fence>) -> Self {
        Self::build(fences, false, Double::Opaque).await
    }
    /// A PostgreSQL that authenticates `app` with SCRAM-SHA-256 for this password.
    async fn scram(fences: HashMap<String, Fence>, double: Double) -> Self {
        Self::build(fences, false, double).await
    }
    async fn build(fences: HashMap<String, Fence>, congested: bool, double: Double) -> Self {
        let identity = generate_simple_self_signed(vec![
            format!("database-rw.pgcf-db-{DATABASE}.svc"),
            wake::slot_tls_name(SLOT),
        ])
        .unwrap();
        let ca = identity.cert.pem().into_bytes();
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![identity.cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                    identity.signing_key.serialize_der(),
                )),
            )
            .unwrap();
        // Accepted sockets inherit the listener's receive buffer.
        let upstream = TcpSocket::new_v4().unwrap();
        if congested {
            upstream.set_recv_buffer_size(4096).unwrap();
        }
        upstream.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let upstream = upstream.listen(128).unwrap();
        let address = upstream.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let dialled = Arc::default();
        let gateway = Gateway::new(
            Arc::new(Config {
                region: REGION.into(),
                keyring: Keyring {
                    active: "test".into(),
                    keys: HashMap::from([("test".into(), vec![7; 32])]),
                },
                maximum_memory: 192 * 1024 * 1024,
                database_memory: 96 * 1024 * 1024,
            }),
            POD.into(),
            Arc::new(TestDial {
                address,
                ca,
                calls: calls.clone(),
                dialled: Arc::clone(&dialled),
                send_buffer: congested.then_some(4096),
            }),
        );
        gateway.fences.write().await.replace(fences).unwrap();
        {
            let mut targets = gateway.targets.write().await;
            targets
                .replace("endpointslices", &[writer(&cid(200))])
                .unwrap();
            targets.replace("configmaps", &storage_maps()).unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, receiver) = watch::channel(false);
        let (send, received) = mpsc::channel(16);
        let (closed, closes) = mpsc::channel(16);
        let mut shutdown = receiver.clone();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let upstream_task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {_=shutdown.changed()=>break,accepted=upstream.accept()=>{let(mut tcp,_)=accepted.unwrap();let(acceptor,send,closed,double)=(acceptor.clone(),send.clone(),closed.clone(),double.clone());tasks.spawn(async move{
                        let mut request=[0;8];tcp.read_exact(&mut request).await.unwrap();assert_eq!(request,[0,0,0,8,4,210,22,47]);tcp.write_all(b"S").await.unwrap();let mut tls=acceptor.accept(tcp).await.unwrap();
                        let length=tls.read_u32().await.unwrap()as usize;let mut raw=vec![0;length-4];tls.read_exact(&mut raw).await.unwrap();let mut startup_bytes=(length as u32).to_be_bytes().to_vec();startup_bytes.extend(raw);send.send(startup_bytes).await.unwrap();
                        if !double.authenticate(&mut tls).await{return;}
                        // Before each message: close_notify reads as end of stream, a bare TCP close as an error.
                        loop{if congested{tokio::time::sleep(Duration::from_millis(200)).await;}let mut header=[0;5];match tls.read(&mut header[..1]).await{Ok(1)=>{},end=>{let _=closed.try_send(matches!(end,Ok(0)));break;}}if tls.read_exact(&mut header[1..]).await.is_err(){break;}let length=u32::from_be_bytes(header[1..].try_into().unwrap())as usize;let mut body=vec![0;length-4];if tls.read_exact(&mut body).await.is_err(){break;}let mut bytes=header.to_vec();bytes.extend(body);if send.send(bytes).await.is_err(){break;}
                // After a Terminate the double keeps reading to observe how the gateway ends TLS.
                if header[0]!=b'X'&&tls.write_all(&[b'Z',0,0,0,5,b'I']).await.is_err(){break;}}
                    });}}
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
                tokio::select! {_=shutdown.changed()=>break,accepted=listener.accept()=>{let(socket,_)=accepted.unwrap();
                let socket=if observing.load(Ordering::SeqCst){let std=socket.into_std().unwrap();observers.lock().unwrap().push(std.try_clone().unwrap());TcpStream::from_std(std).unwrap()}else{socket};
                let(gateway,receiver,permit)=(run.clone(),shutdown.clone(),pending.clone().acquire_owned().await.unwrap());tasks.spawn(async move{let _=transport::serve_socket(socket,gateway,receiver,permit).await;});}}
            }
            tasks.abort_all();
        });
        Self {
            gateway,
            port,
            calls,
            dialled,
            accepted,
            observe,
            upstream: received,
            closes,
            stop,
            tasks: vec![upstream_task, gateway_task],
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
    async fn intent(&self, mode: &str, revision: u64, signal: bool) {
        self.gateway
            .fences
            .write()
            .await
            .replace(HashMap::from([(DATABASE.into(), fence(mode, revision))]))
            .unwrap();
        if signal {
            self.gateway.sessions.lock().unwrap().signal(
                DATABASE,
                match mode {
                    "quiesce" => Action::Quiesce,
                    "retired" => Action::Retire,
                    _ => Action::Running,
                },
            );
        }
    }
    async fn http(&self, path: &str, header: &str, value: &str) -> (u16, Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        stream.write_all(format!("POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n{header}: {value}\r\n\r\n").as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
        let header = std::str::from_utf8(&bytes[..split]).unwrap();
        let status = header.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_slice(&bytes[split..]).unwrap())
    }
    async fn stop(self) {
        let _ = self.stop.send(true);
        for task in self.tasks {
            task.await.unwrap();
        }
    }
}
#[tokio::test]
async fn persisted_fence_blocks_frontend_even_when_action_hint_is_delayed() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(1).await;
    // Authoritative snapshot has advanced, but a pending transport still holds
    // Running from the earlier watch hint. Data must be retained until release.
    fixture.intent("quiesce", 2, false).await;
    client.send(Message::Binary(query().into())).await.unwrap();
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend bytes crossed the persisted fence"
    );
    fixture.intent("running", 3, true).await;
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
async fn native_http_activity_and_quiescence_match_authorized_pod_revision_and_idle_closure() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(2).await;
    let activity = activity_token(10, 1);
    let (status, report) = fixture
        .http(wire("activityPath"), wire("activityHeader"), &activity)
        .await;
    assert_eq!(status, 200);
    assert_eq!(report["authenticatedConnections"], 1);
    assert_eq!(report["busyConnections"], 0);
    assert_eq!(report["totalConnections"], 1);
    assert!(report["ingressBytes"].as_u64().unwrap() > 0);
    assert_eq!(
        fixture
            .http(wire("activityPath"), wire("activityHeader"), &activity)
            .await
            .0,
        401
    );
    fixture.intent("quiesce", 2, true).await;
    let begin = control_token("begin", 2);
    let (status, report) = fixture
        .http(
            &format!("{}begin", wire("controlPathPrefix")),
            wire("controlHeader"),
            &begin,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(report["status"], "idle");
    let (status, report) = fixture
        .http(
            &format!("{}close", wire("controlPathPrefix")),
            wire("controlHeader"),
            &control_token("close", 2),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(report["status"], "closed");
    assert_eq!(report["connections"], 0);
    let message = timeout(Duration::from_secs(10), client.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(message, Message::Close(_)));
    assert_eq!(
        fixture
            .http(
                &format!("{}status", wire("controlPathPrefix")),
                wire("controlHeader"),
                &control_token("status", 1)
            )
            .await
            .0,
        409
    );
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
    // The route names the database, the user and the Pod, so nothing the StartupMessage says
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
async fn terminal_retirement_refuses_additional_frontend_data_explicitly() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(4).await;
    fixture.intent("retired", 2, true).await;
    client.send(Message::Binary(query().into())).await.unwrap();
    client.send(Message::Binary(query().into())).await.unwrap();
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
    fixture.intent("quiesce", 2, true).await;
    let (status, report) = fixture
        .http(
            &format!("{}close", wire("controlPathPrefix")),
            wire("controlHeader"),
            &control_token("close", 2),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(report["status"], "busy");
    assert_eq!(report["connections"], 1);
    fixture.intent("running", 3, true).await;
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
async fn writer_restart_closes_authenticated_tls_session_without_forwarding_new_bytes() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(800).await;
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("endpointslices", &[writer(&cid(299))])
        .unwrap();
    client.send(Message::Binary(query().into())).await.unwrap();
    let next = timeout(Duration::from_secs(1), client.next())
        .await
        .unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | Some(Err(_)) | None),
        "old target remained active: {next:?}"
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend crossed changed Pod identity"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn broken_power_watch_never_forwards_new_authenticated_frontend_bytes() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(840).await;
    fixture.gateway.fences.write().await.disconnect();
    let _ = client.send(Message::Binary(query().into())).await;
    let next = timeout(Duration::from_secs(1), client.next())
        .await
        .unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | Some(Err(_)) | None),
        "watch disconnect returned {next:?}"
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
}
/// A thin database's maps as the controller publishes them: its thin storage profile and LV
/// identity, and no storage ledger entry.
fn thin_maps() -> Vec<Value> {
    let profile = json!({"backend":"lvm-thin-v1","storage_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16)),"profile_sha256":"a".repeat(64),"node_uid":cid(204),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg"});
    let identity = json!({"handle":format!("pvc-{}",cid(205)),"lvUuid":"cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh","claimUid":cid(205),"volumeUid":cid(206)});
    let state = json!({"node":"customer-us1","storage":profile});
    let mut maps = storage_maps();
    maps[0]["data"]["state"] = state.to_string().into();
    maps[0]["metadata"]["annotations"] = json!({"pgcf.io/gateway-fence-uid":cid(100),"pgcf.io/volume-identity":identity.to_string()});
    maps[1]["data"] = json!({"intent.json":json!({"database":DATABASE,"operation":operation(),"revision":1,"mode":"running"}).to_string(),"power.json":json!({"anchor":{"storageUid":cid(202),"storageState":state.to_string(),"volumeIdentity":identity.to_string(),"storage":profile}}).to_string()});
    maps
}
#[tokio::test]
async fn a_thin_database_is_routed_and_written_without_a_storage_ledger_token() {
    let mut fixture = Fixture::new().await;
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("configmaps", &thin_maps())
        .unwrap();
    let mut client = fixture.authenticate(850).await;
    client.send(Message::Binary(query().into())).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_database_without_thin_storage_is_routed_without_a_configured_cohort() {
    let mut fixture = Fixture::new().await;
    {
        let mut targets = fixture.gateway.targets.write().await;
        *targets = pgcf_native_gateway::targets::Targets::default();
        targets
            .replace("endpointslices", &[writer(&cid(200))])
            .unwrap();
        targets.replace("configmaps", &storage_maps()).unwrap();
    }
    let client = fixture.authenticate(851).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    drop(client);
    fixture.stop().await;
}
#[tokio::test]
async fn a_route_dials_only_its_admitted_revision_and_verified_pod() {
    let mut fixture = Fixture::new().await;
    // TestDial asserts the Pod address and the independent service TLS name of this route.
    let client = fixture.authenticate(900).await;
    drop(client);
    for route in [routed(901, 2, &cid(200)), routed(902, 1, &cid(299))] {
        assert_eq!(fixture.upgrade(&route).await.err(), Some(503));
    }
    fixture.intent("running", 2, true).await;
    assert_eq!(fixture.upgrade(&route_token(903)).await.err(), Some(503));
    let admitted = fixture.upgrade(&routed(904, 2, &cid(200))).await.unwrap();
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
async fn a_writer_replaced_after_admission_is_never_dialled() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.connect(910).await;
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("endpointslices", &[writer(&cid(299))])
        .unwrap();
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
    // The writer admitted was dialled when it was admitted, and no replacement was: nothing
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
async fn a_v3_route_needs_the_running_fence_of_its_revision() {
    // Without the controller's running fence the gateway cannot check the admitted revision.
    let mut fixture = Fixture::with_fences(HashMap::new()).await;
    assert_eq!(
        fixture.upgrade(&routed(940, 1, &cid(200))).await.err(),
        Some(503)
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    // Its running fence of that revision admits and dials the same route.
    fixture.intent("running", 1, true).await;
    let client = fixture.authenticate(941).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    drop(client);
    fixture.stop().await;
}
#[tokio::test]
async fn a_legacy_v2_route_keeps_the_rollout_compatibility_path() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.upgrade(&legacy_route_token(920)).await.unwrap();
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
async fn a_client_terminate_reaches_postgres_before_close_notify() {
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
    assert_eq!(
        timeout(Duration::from_secs(2), fixture.closes.recv())
            .await
            .unwrap(),
        Some(true),
        "PostgreSQL TLS ended without close_notify"
    );
    fixture.stop().await;
}
#[tokio::test]
async fn a_relay_that_refuses_frontend_bytes_still_ends_postgres_tls_with_close_notify() {
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(951).await;
    fixture.gateway.fences.write().await.disconnect();
    let _ = client.send(Message::Binary(query().into())).await;
    assert_eq!(
        timeout(Duration::from_secs(2), fixture.closes.recv())
            .await
            .unwrap(),
        Some(true),
        "PostgreSQL TLS ended without close_notify"
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "refused frontend bytes reached PostgreSQL"
    );
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
        assert_eq!(lines.len(), 4, "{stdout}");
        for line in &lines {
            // Only these fields: no role, address, token or payload byte.
            let mut keys = vec![
                "database",
                "dial_ms",
                "event",
                "first_backend_ms",
                "outcome",
                "route",
                "session_ms",
                "startup_ms",
                "upgrade_ms",
                "wake_path",
            ];
            if line["outcome"] == "target_unavailable" {
                keys.push("target_reason");
                keys.sort();
            }
            assert_eq!(line.as_object().unwrap().keys().collect::<Vec<_>>(), keys);
            assert_eq!(line["database"], DATABASE);
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
        assert_eq!(lines[2]["target_reason"], "writer_identity_unavailable");
        for unreached in ["upgrade_ms", "startup_ms", "dial_ms", "first_backend_ms"] {
            assert!(lines[2][unreached].is_null());
        }
        // The class of the writer the connection was admitted on, once a writer was chosen: a
        // Ready endpoint, or the controller's attested Pod before the kubelet reports it.
        assert_eq!(lines[0]["route"], "ready");
        assert_eq!(lines[1]["route"], "ready");
        assert!(lines[2]["route"].is_null());
        assert_eq!(lines[3]["route"], "attested");
        assert_eq!(lines[3]["outcome"], "client_closed");
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
    // No writer: the connection is refused before its upgrade.
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("endpointslices", &[])
        .unwrap();
    assert_eq!(fixture.upgrade(&route_token(962)).await.err(), Some(503));
    // The cluster right after a fast wake: the writer is the attested Pod before its Ready.
    fixture
        .gateway
        .fences
        .write()
        .await
        .replace(attested_fence())
        .unwrap();
    unready_wake(&fixture, true).await;
    let mut client = fixture
        .upgrade(&admitted(963, 1, &cid(200), 19))
        .await
        .unwrap();
    fixture.login(&mut client).await;
    client.close(None).await.unwrap();
    fixture.ended().await;
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
    // A tail still queued in TLS would never reach the double, so it would never reply.
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

const CA_MATERIAL: &str = "public test certificate material";
/// A v4 route: the revision, the verified Pod and the independent route revision Cloudflare admitted.
fn admitted(id: usize, revision: u64, pod: &str, route_revision: u64) -> String {
    let now = control::now() / 1000;
    token(
        wire("admissionRouteTokenPrefix"),
        wire("admissionRouteSignatureDomain"),
        json!({"v":4,"db":DATABASE,"user":"app","cid":cid(id),"rg":REGION,"kid":"test","iat":now,"exp":now+30,"rev":revision,"pod":pod,"route_revision":route_revision}),
        &[7; 32],
    )
}
/// What the controller attested after a fast wake: the Pod's container and the TLS authority it
/// verified together with PostgreSQL itself.
fn attested_target() -> Value {
    use sha2::Digest;
    let ca = Sha256::digest(CA_MATERIAL.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    json!({"v":1,"generation":1,"route_revision":19,"admission_epoch":11,"pod_uid":cid(200),"container_id":"a".repeat(64),"ca_secret_uid":cid(210),"ca_secret_resource_version":"81","ca_sha256":ca,"tls_server_name":format!("database-rw.pgcf-db-{DATABASE}.svc")})
}
fn attested_fence() -> HashMap<String, Fence> {
    HashMap::from([(
        DATABASE.into(),
        Fence {
            admission_target: Some(serde_json::from_value(attested_target()).unwrap()),
            ..fence("running", 1)
        },
    )])
}
fn ca_map() -> Value {
    json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{DATABASE}"),"namespace":"pgcf-system","uid":cid(209),"labels":{"pgcf.io/database-id":DATABASE},"annotations":{"pgcf.io/source-ca-secret-uid":cid(210),"pgcf.io/source-ca-secret-resource-version":"81"}},"data":{"ca.crt":CA_MATERIAL}})
}
fn running_pod(ready: bool) -> Value {
    json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":format!("pgcf-db-{DATABASE}"),"uid":cid(200),"resourceVersion":"1","labels":{"cnpg.io/cluster":"database"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.7","containerStatuses":[{"name":"postgres","ready":ready,"containerID":format!("containerd://{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-15T10:00:00Z"}}}]}})
}
/// The cluster right after a fast wake in place: the kubelet has reported neither the
/// endpoint nor the container Ready. `attested` says whether the writer cache sees the target.
async fn unready_wake(fixture: &Fixture, attested: bool) {
    let mut writer = writer(&cid(200));
    writer["endpoints"][0]["conditions"] =
        json!({"ready":false,"serving":false,"terminating":false});
    let mut maps = storage_maps();
    if attested {
        maps[1]["data"]["intent.json"] =
            json!({"database":DATABASE,"operation":operation(),"revision":1,"mode":"running"})
                .to_string()
                .into();
        maps[1]["data"]["admission_target"] = attested_target().to_string().into();
    }
    maps.push(ca_map());
    let mut targets = fixture.gateway.targets.write().await;
    targets.replace("endpointslices", &[writer]).unwrap();
    targets.replace("pods", &[running_pod(false)]).unwrap();
    targets.replace("configmaps", &maps).unwrap();
}
#[tokio::test]
async fn a_v4_route_reaches_the_attested_pod_before_its_ready_condition() {
    let mut fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    let mut client = fixture
        .upgrade(&admitted(980, 1, &cid(200), 19))
        .await
        .unwrap();
    fixture.login(&mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.send(Message::Binary(query().into())).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    // The kubelet's reflection arrives while the session runs; it is the same writer.
    {
        let mut targets = fixture.gateway.targets.write().await;
        targets
            .replace("endpointslices", &[writer(&cid(200))])
            .unwrap();
        targets.replace("pods", &[running_pod(true)]).unwrap();
    }
    client.send(Message::Binary(query().into())).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(10), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_legacy_route_cannot_vouch_for_a_pod_the_kubelet_has_not_reported_ready() {
    let fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    // The route Cloudflare signs for the same revision and Pod without an admitted runtime.
    for route in [routed(984, 1, &cid(200)), legacy_route_token(985)] {
        assert_eq!(fixture.upgrade(&route).await.err(), Some(503));
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}
#[tokio::test]
async fn an_unready_pod_the_writer_cache_holds_no_attestation_for_is_not_dialled() {
    let fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, false).await;
    assert_eq!(
        fixture
            .upgrade(&admitted(981, 1, &cid(200), 19))
            .await
            .err(),
        Some(503)
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    fixture.stop().await;
}
#[tokio::test]
async fn an_attested_unready_pod_of_a_thin_database_is_routed() {
    let mut fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    let mut thin = thin_maps();
    thin[1]["data"]["admission_target"] = attested_target().to_string().into();
    thin.push(ca_map());
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("configmaps", &thin)
        .unwrap();
    let mut client = fixture
        .upgrade(&admitted(983, 1, &cid(200), 19))
        .await
        .unwrap();
    fixture.login(&mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    client.close(None).await.unwrap();
    fixture.stop().await;
}

/// The fence as its watch delivers it when the fence leaves `running`: the power state and the
/// writer cache both carry the controller's attestation unchanged beside the new intent.
async fn fence_quiesces(fixture: &Fixture, revision: u64) {
    let mut maps = storage_maps();
    maps[1]["data"]["intent.json"] =
        json!({"database":DATABASE,"operation":operation(),"revision":revision,"mode":"quiesce"})
            .to_string()
            .into();
    maps[1]["data"]["admission_target"] = attested_target().to_string().into();
    maps.push(ca_map());
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("configmaps", &maps)
        .unwrap();
    fixture
        .gateway
        .fences
        .write()
        .await
        .replace(HashMap::from([(
            DATABASE.into(),
            Fence {
                admission_target: Some(serde_json::from_value(attested_target()).unwrap()),
                ..fence("quiesce", revision)
            },
        )]))
        .unwrap();
    fixture
        .gateway
        .sessions
        .lock()
        .unwrap()
        .signal(DATABASE, Action::Quiesce);
}
/// The session ends and not one frontend byte reaches PostgreSQL.
async fn ends_without_forwarding(fixture: &mut Fixture, client: &mut Client) {
    let _ = client.send(Message::Binary(query().into())).await;
    let next = timeout(Duration::from_secs(1), client.next())
        .await
        .unwrap();
    assert!(
        matches!(next, Some(Ok(Message::Close(_))) | Some(Err(_)) | None),
        "the session stayed open: {next:?}"
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend bytes crossed the withdrawn writer"
    );
}
#[tokio::test]
async fn a_v4_route_naming_another_pod_generation_or_route_revision_is_refused_while_the_pod_is_unready()
 {
    let fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    for route in [
        admitted(990, 1, &cid(299), 19),
        admitted(991, 2, &cid(200), 19),
        admitted(992, 1, &cid(200), 20),
    ] {
        assert_eq!(fixture.upgrade(&route).await.err(), Some(503));
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    // The same state admits the route that names exactly what the controller attested.
    let client = fixture
        .upgrade(&admitted(993, 1, &cid(200), 19))
        .await
        .unwrap();
    drop(client);
    fixture.stop().await;
}
#[tokio::test]
async fn an_established_session_on_an_unready_writer_closes_when_the_fence_leaves_running_or_the_container_restarts()
 {
    // The attestation holds only at the running revision it was made for, so the evidence a
    // session was admitted on ends with it: the session is closed rather than drained.
    let mut fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    let mut client = fixture
        .upgrade(&admitted(994, 1, &cid(200), 19))
        .await
        .unwrap();
    fixture.login(&mut client).await;
    fence_quiesces(&fixture, 2).await;
    ends_without_forwarding(&mut fixture, &mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
    // A container restarted under another ID is not the one the controller attested.
    let mut fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    let mut client = fixture
        .upgrade(&admitted(995, 1, &cid(200), 19))
        .await
        .unwrap();
    fixture.login(&mut client).await;
    let mut restarted = running_pod(false);
    restarted["status"]["containerStatuses"][0]["containerID"] =
        format!("containerd://{}", "b".repeat(64)).into();
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("pods", &[restarted])
        .unwrap();
    ends_without_forwarding(&mut fixture, &mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn a_writer_replaced_between_admission_and_dial_is_not_dialled_on_the_unready_path() {
    let mut fixture = Fixture::with_fences(attested_fence()).await;
    unready_wake(&fixture, true).await;
    let mut client = fixture
        .upgrade(&admitted(996, 1, &cid(200), 19))
        .await
        .unwrap();
    // Another Pod became the Service's Ready writer before the StartupMessage was dialled.
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("endpointslices", &[writer(&cid(299))])
        .unwrap();
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
    // The writer admitted was dialled when it was admitted, and no replacement was: nothing of the
    // client reached either of them.
    assert!(fixture.calls.load(Ordering::SeqCst) <= 1);
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err()
    );
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
async fn readyz_requires_the_pod_watch() {
    // A writer the kubelet has not reported Ready is recognized only by the Pod watch, and the
    // controller publishes a woken database on its attestation: a replica without the watch
    // would answer that wake with a refusal the Edge does not retry.
    let fixture = Fixture::new().await;
    assert_eq!(get(&fixture, "/healthz").await.0, 200);
    let (status, body) = get(&fixture, "/readyz").await;
    assert_eq!((status, body.as_str()), (503, "unsynchronized\n"));
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("pods", &[])
        .unwrap();
    assert_eq!(get(&fixture, "/readyz").await, (200, "ok\n".into()));
    // The watch is lost: the replica leaves the Service again, and stays alive.
    fixture.gateway.targets.write().await.disconnect("pods");
    assert_eq!(get(&fixture, "/readyz").await.0, 503);
    assert_eq!(get(&fixture, "/healthz").await.0, 200);
    fixture.stop().await;
}

// Pool wake (route token v5): the gateway holds a sleeping database's connection, queues its wake
// for the controller's long-poll and releases it when the fence shows the woken writer.
const SLOT: &str = "pgcf-slot-0a1b2c3d";
const ROLE_HASH: &str = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
fn wake_operation() -> String {
    format!("op_{}", "w".repeat(20))
}
/// The wake ticket the Edge signs for a database whose Actor snapshot sits at `generation - 1`.
fn wake_token(id: usize, generation: u64) -> String {
    wake_ticket(id, generation, &wake_operation(), REGION)
}
fn wake_ticket(id: usize, generation: u64, operation: &str, region: &str) -> String {
    let now = control::now() / 1000;
    token(
        wake::ROUTE_PREFIX,
        wake::ROUTE_DOMAIN,
        json!({"v":5,"db":DATABASE,"user":"app","cid":cid(id),"rg":region,"kid":"test","iat":now,"exp":now+30,"op":operation,"gen":generation,"route_revision":19,"rh":ROLE_HASH}),
        &[7; 32],
    )
}
/// The controller's `gw1` token for this gateway Pod's wake long-poll or wake result.
fn poll_token(action: &str, pod: &str, region: &str) -> String {
    let now = control::now() / 1000;
    let key = hmac(&[7; 32], wake::POLL_KEY_PURPOSE.as_bytes());
    token(
        wake::POLL_PREFIX,
        wake::POLL_SIGNING_PURPOSE,
        json!({"v":1,"region":region,"pod":pod,"action":action,"kid":"test","iat":now,"exp":now+30}),
        &key,
    )
}
/// The database asleep: its fence quiesced at the revision of the sleep.
fn sleeping() -> HashMap<String, Fence> {
    HashMap::from([(DATABASE.into(), fence("quiesce", 1))])
}
fn wake_target(generation: u64, slot: bool) -> Value {
    use sha2::Digest;
    let ca = Sha256::digest(CA_MATERIAL.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let (pod, name) = if slot {
        (cid(300), wake::slot_tls_name(SLOT))
    } else {
        (cid(200), format!("database-rw.pgcf-db-{DATABASE}.svc"))
    };
    json!({"v":1,"generation":generation,"route_revision":19,"admission_epoch":11,"pod_uid":pod,"container_id":"a".repeat(64),"ca_secret_uid":cid(210),"ca_secret_resource_version":"81","ca_sha256":ca,"tls_server_name":name})
}
/// What the controller publishes when it releases a wake: the fence running at the claimed
/// generation and operation with its admission target (a pool slot or the database's own Pod),
/// and the writer as the watches show it before the kubelet reports it Ready.
async fn release(fixture: &Fixture, generation: u64, slot: bool) {
    release_at(fixture, generation, slot, 19).await;
}
/// `release` with the admission target at `route_revision`: Cloudflare's claim of the wake moves
/// the route revision past the one the ticket was signed with.
async fn release_at(fixture: &Fixture, generation: u64, slot: bool, route_revision: u64) {
    let mut target = wake_target(generation, slot);
    target["route_revision"] = route_revision.into();
    let intent = json!({"database":DATABASE,"operation":wake_operation(),"revision":generation,"mode":"running"});
    let namespace = if slot {
        SLOT.to_string()
    } else {
        format!("pgcf-db-{DATABASE}")
    };
    let pod_uid = if slot { cid(300) } else { cid(200) };
    let mut slice = writer(&pod_uid);
    slice["metadata"]["namespace"] = namespace.clone().into();
    slice["endpoints"][0]["targetRef"]["namespace"] = namespace.clone().into();
    slice["endpoints"][0]["conditions"] =
        json!({"ready":false,"serving":false,"terminating":false});
    let mut pod = running_pod(false);
    pod["metadata"]["namespace"] = namespace.into();
    pod["metadata"]["uid"] = pod_uid.into();
    let mut maps = storage_maps();
    maps[1]["data"]["intent.json"] = intent.to_string().into();
    maps[1]["data"]["admission_target"] = target.to_string().into();
    maps.push(ca_map());
    {
        let mut targets = fixture.gateway.targets.write().await;
        targets.replace("endpointslices", &[slice]).unwrap();
        targets.replace("pods", &[pod]).unwrap();
        targets.replace("configmaps", &maps).unwrap();
    }
    fixture
        .gateway
        .fences
        .write()
        .await
        .replace(HashMap::from([(
            DATABASE.into(),
            Fence {
                admission_target: Some(serde_json::from_value(target).unwrap()),
                intent: Intent {
                    database: DATABASE.into(),
                    operation: wake_operation(),
                    revision: generation,
                    mode: "running".into(),
                },
                ..fence("running", generation)
            },
        )]))
        .unwrap();
}
/// One request to the control port with a body, waiting up to `wait` for the answer.
async fn post(
    fixture: &Fixture,
    path: &str,
    token: &str,
    body: &str,
    wait: Duration,
) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port))
        .await
        .unwrap();
    stream
        .write_all(
            format!(
                "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n{}: {token}\r\n\r\n{body}",
                body.len(),
                wake::POLL_HEADER
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    timeout(wait, stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let split = bytes.windows(4).position(|v| v == b"\r\n\r\n").unwrap() + 4;
    let header = std::str::from_utf8(&bytes[..split]).unwrap();
    let status = header.split_whitespace().nth(1).unwrap().parse().unwrap();
    (status, serde_json::from_slice(&bytes[split..]).unwrap())
}
/// The controller's long-poll of this gateway.
async fn poll(fixture: &Fixture, wait: Duration) -> (u16, Value) {
    post(
        fixture,
        wake::POLL_PATH,
        &poll_token(wake::POLL_ACTION, POD, REGION),
        "",
        wait,
    )
    .await
}
async fn wake_result(fixture: &Fixture, result: Value) -> (u16, Value) {
    post(
        fixture,
        wake::RESULT_PATH,
        &poll_token(wake::RESULT_ACTION, POD, REGION),
        &result.to_string(),
        Duration::from_secs(10),
    )
    .await
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
async fn a_v5_ticket_is_upgraded_at_once_and_its_startup_is_held_until_the_fence_releases_it() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let started = std::time::Instant::now();
    let mut client = fixture.upgrade(&wake_token(1000, 2)).await.unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 1);
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    release(&fixture, 2, false).await;
    fixture.login_sent(&mut client).await;
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 1);
    held_count(&fixture, 0).await;
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn the_held_startup_reaches_postgres_unchanged_after_release_and_never_before() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
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
    release(&fixture, 2, false).await;
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
    // controller publishes the target under it (the miss path, or a confirmed hit).
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut client = fixture.upgrade(&wake_token(1080, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    release_at(&fixture, 2, false, 20).await;
    fixture.login_sent(&mut client).await;
    held_count(&fixture, 0).await;
    client.close(None).await.unwrap();
    // A ticket signed after the claim is routed at once, as warm.
    let mut warm = fixture.upgrade(&wake_token(1081, 2)).await.unwrap();
    fixture.login(&mut warm).await;
    warm.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_wake_released_under_an_older_route_revision_than_its_ticket_is_stale() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut client = fixture.upgrade(&wake_token(1082, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    release_at(&fixture, 2, false, 18).await;
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
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut first = fixture.upgrade(&wake_token(1010, 2)).await.unwrap();
    let mut second = fixture.upgrade(&wake_token(1011, 2)).await.unwrap();
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 2);
    let (status, answer) = poll(&fixture, Duration::from_secs(2)).await;
    assert_eq!(status, 200);
    assert_eq!(answer["pod"], POD);
    let wakes = answer["wakes"].as_array().unwrap();
    assert_eq!(wakes.len(), 1, "{answer}");
    assert_eq!(wakes[0]["database"], DATABASE);
    assert_eq!(wakes[0]["operation"], wake_operation());
    assert_eq!(wakes[0]["generation"], 2);
    assert_eq!(wakes[0]["route_revision"], 19);
    assert_eq!(wakes[0]["role_revision_hash"], ROLE_HASH);
    assert!(wakes[0]["queued_at_ms"].as_u64().unwrap() > 0);
    for client in [&mut first, &mut second] {
        client
            .send(Message::Binary(startup("app").into()))
            .await
            .unwrap();
    }
    release(&fixture, 2, false).await;
    for client in [&mut first, &mut second] {
        fixture.login_sent(client).await;
    }
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
    fixture.stop().await;
}
#[tokio::test]
async fn the_wakes_poll_answers_queued_wakes_at_once_and_an_empty_list_after_the_hold() {
    let fixture = Fixture::with_fences(sleeping()).await;
    let _client = fixture.upgrade(&wake_token(1020, 2)).await.unwrap();
    let started = std::time::Instant::now();
    let (status, answer) = poll(&fixture, Duration::from_secs(2)).await;
    assert_eq!(status, 200);
    assert_eq!(answer["wakes"].as_array().unwrap().len(), 1);
    assert!(started.elapsed() < Duration::from_secs(1));
    // The controller answered: the ticket is not delivered again.
    let (status, answer) = wake_result(
        &fixture,
        json!({"database":DATABASE,"operation":wake_operation(),"generation":2,"outcome":"miss","reason":"no_free_slot"}),
    )
    .await;
    assert_eq!((status, answer), (200, json!({})));
    let started = std::time::Instant::now();
    let (status, answer) = poll(&fixture, Duration::from_secs(30)).await;
    assert_eq!((status, answer), (200, json!({"pod":POD,"wakes":[]})));
    assert!(started.elapsed() >= Duration::from_millis(wake::POLL_HOLD_MS - 100));
    fixture.stop().await;
}
#[tokio::test]
async fn a_wake_without_result_is_delivered_again_after_3_s() {
    let fixture = Fixture::with_fences(sleeping()).await;
    let _client = fixture.upgrade(&wake_token(1030, 2)).await.unwrap();
    let (_, first) = poll(&fixture, Duration::from_secs(2)).await;
    let started = std::time::Instant::now();
    let (status, again) = poll(&fixture, Duration::from_secs(10)).await;
    assert_eq!(status, 200);
    let waited = started.elapsed();
    assert!(
        waited >= Duration::from_millis(wake::REDELIVER_MS - 100),
        "{waited:?}"
    );
    assert!(waited < Duration::from_secs(5), "{waited:?}");
    assert_eq!(first["wakes"], again["wakes"]);
    fixture.stop().await;
}
#[tokio::test]
async fn a_refused_result_answers_57p03_to_every_held_connection_of_that_ticket() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut first = fixture.upgrade(&wake_token(1040, 2)).await.unwrap();
    let mut second = fixture.upgrade(&wake_token(1041, 2)).await.unwrap();
    first
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    poll(&fixture, Duration::from_secs(2)).await;
    let (status, _) = wake_result(
        &fixture,
        json!({"database":DATABASE,"operation":wake_operation(),"generation":2,"outcome":"refused","reason":"deleted"}),
    )
    .await;
    assert_eq!(status, 200);
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
    let (status, answer) = wake_result(
        &fixture,
        json!({"database":DATABASE,"operation":wake_operation(),"generation":3,"outcome":"hit"}),
    )
    .await;
    assert_eq!((status, answer), (404, json!({"error":"wake_unknown"})));
    fixture.stop().await;
}
#[tokio::test]
async fn a_held_connection_past_25_s_answers_57p03_and_leaves_the_queue() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
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
async fn a_fence_that_moves_past_the_ticket_generation_answers_57p03() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut client = fixture.upgrade(&wake_token(1060, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    fixture.intent("quiesce", 3, false).await;
    assert!(
        fatal(&mut client, Duration::from_secs(5))
            .await
            .contains("57P03")
    );
    untouched(&mut fixture).await;
    // A ticket the fence has already moved past is not held at all.
    assert_eq!(fixture.upgrade(&wake_token(1061, 2)).await.err(), Some(503));
    held_count(&fixture, 0).await;
    fixture.stop().await;
}
#[tokio::test]
async fn a_v5_ticket_already_released_at_its_generation_is_routed_at_once_as_warm() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    release(&fixture, 2, false).await;
    let mut client = fixture.upgrade(&wake_token(1070, 2)).await.unwrap();
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 0);
    assert!(fixture.gateway.wakes.ticket(DATABASE).is_none());
    fixture.login(&mut client).await;
    client.close(None).await.unwrap();
    fixture.stop().await;
}
#[tokio::test]
async fn a_released_slot_target_is_dialled_with_the_slot_tls_name_and_pinned_ca() {
    let mut fixture = Fixture::with_fences(sleeping()).await;
    let mut client = fixture.upgrade(&wake_token(1080, 2)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    untouched(&mut fixture).await;
    release(&fixture, 2, true).await;
    fixture.login_sent(&mut client).await;
    let dialled = fixture.dialled.lock().unwrap().clone();
    assert_eq!(dialled.len(), 1);
    assert_eq!(dialled[0].host, wake::slot_tls_name(SLOT));
    assert_eq!(dialled[0].pod_uid, cid(300));
    assert_eq!(
        dialled[0].ca_sha256.as_deref(),
        wake_target(2, true)["ca_sha256"].as_str()
    );
    // The authority comes from the watch, not from a request to the API server.
    assert_eq!(dialled[0].ca.as_deref(), Some(CA_MATERIAL.as_bytes()));
    // The session keeps running on the slot.
    client.send(Message::Binary(query().into())).await.unwrap();
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
async fn held_connections_beyond_32_per_database_are_refused_before_the_upgrade() {
    let fixture = Fixture::with_fences(sleeping()).await;
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
    let fixture = Fixture::with_fences(sleeping()).await;
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
#[tokio::test]
async fn wakes_and_wake_result_refuse_a_token_for_another_pod_action_or_region() {
    let fixture = Fixture::with_fences(sleeping()).await;
    let _client = fixture.upgrade(&wake_token(1300, 2)).await.unwrap();
    let result = json!({"database":DATABASE,"operation":wake_operation(),"generation":2,"outcome":"refused","reason":"deleted"}).to_string();
    let other_pod = cid(301);
    for (path, token) in [
        (
            wake::POLL_PATH,
            poll_token(wake::POLL_ACTION, &other_pod, REGION),
        ),
        (
            wake::POLL_PATH,
            poll_token(wake::RESULT_ACTION, POD, REGION),
        ),
        (
            wake::POLL_PATH,
            poll_token(wake::POLL_ACTION, POD, "eu-other"),
        ),
        (
            wake::RESULT_PATH,
            poll_token(wake::RESULT_ACTION, &other_pod, REGION),
        ),
        (
            wake::RESULT_PATH,
            poll_token(wake::POLL_ACTION, POD, REGION),
        ),
        (
            wake::RESULT_PATH,
            poll_token(wake::RESULT_ACTION, POD, "eu-other"),
        ),
        (wake::RESULT_PATH, control_token("release", 1)),
    ] {
        let body = if path == wake::RESULT_PATH {
            result.as_str()
        } else {
            ""
        };
        assert_eq!(
            post(&fixture, path, &token, body, Duration::from_secs(5)).await,
            (401, json!({"error":"wake_denied"})),
            "{path}"
        );
    }
    // Nothing was delivered or answered by the refused requests.
    let (_, answer) = poll(&fixture, Duration::from_secs(2)).await;
    assert_eq!(answer["wakes"].as_array().unwrap().len(), 1);
    assert_eq!(fixture.gateway.wakes.held(DATABASE), 1);
    fixture.stop().await;
}
#[tokio::test]
async fn conn_stages_names_warm_pool_hit_and_pool_miss_with_wait_and_reason() {
    if std::env::var_os("PGCF_WAKE_STAGES_CHILD").is_none() {
        // The gateway logs to stdout, so a child test process runs the connections below.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "conn_stages_names_warm_pool_hit_and_pool_miss_with_wait_and_reason",
                "--nocapture",
            ])
            .env("PGCF_WAKE_STAGES_CHILD", "1")
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
        assert_eq!(lines.len(), 4, "{stdout}");
        // A route Cloudflare admitted at a running revision.
        assert_eq!(lines[0]["wake_path"], "warm");
        assert!(lines[0].get("held_outcome").is_none(), "{}", lines[0]);
        assert!(lines[0].get("wake_wait_ms").is_none(), "{}", lines[0]);
        // Held, the controller missed the pool, the database's own Pod was released.
        assert_eq!(lines[1]["wake_path"], "pool_miss", "{}", lines[1]);
        assert_eq!(lines[1]["held_outcome"], "released");
        assert_eq!(lines[1]["miss_reason"], "no_free_slot");
        assert_eq!(lines[1]["controller_ms"], json!({"decide":3}));
        assert!(
            lines[1]["wake_wait_ms"].as_u64().unwrap() >= 40,
            "{}",
            lines[1]
        );
        assert_eq!(lines[1]["outcome"], "client_closed");
        // Held and released to a pool slot; the controller's hit came after the release.
        assert_eq!(lines[2]["wake_path"], "pool_hit", "{}", lines[2]);
        assert_eq!(lines[2]["held_outcome"], "released");
        assert!(lines[2].get("miss_reason").is_none(), "{}", lines[2]);
        assert_eq!(lines[2]["controller_ms"], json!({"attach":5,"total":40}));
        assert!(lines[2]["wake_wait_ms"].is_u64());
        // Held and refused.
        assert_eq!(lines[3]["wake_path"], "pool_miss", "{}", lines[3]);
        assert_eq!(lines[3]["held_outcome"], "refused");
        assert_eq!(lines[3]["miss_reason"], "deleted");
        assert!(lines[3]["dial_ms"].is_null());
        for line in &lines {
            assert_eq!(line["database"], DATABASE);
            for key in line.as_object().unwrap().keys() {
                assert!(
                    [
                        "controller_ms",
                        "database",
                        "dial_ms",
                        "event",
                        "first_backend_ms",
                        "held_outcome",
                        "miss_reason",
                        "outcome",
                        "route",
                        "session_ms",
                        "startup_ms",
                        "upgrade_ms",
                        "wake_path",
                        "wake_wait_ms",
                    ]
                    .contains(&key.as_str()),
                    "{key}"
                );
            }
        }
        return;
    }
    let mut fixture = Fixture::new().await;
    let mut client = fixture.authenticate(1400).await;
    client.close(None).await.unwrap();
    fixture.ended().await;
    // The database sleeps at revision 2; the pool has no free slot, so the CNPG path wakes it.
    fixture.intent("quiesce", 2, false).await;
    let mut client = fixture.upgrade(&wake_token(1401, 3)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    poll(&fixture, Duration::from_secs(2)).await;
    let miss = json!({"database":DATABASE,"operation":wake_operation(),"generation":3,"outcome":"miss","reason":"no_free_slot","steps_ms":{"decide":3}});
    assert_eq!(wake_result(&fixture, miss).await.0, 200);
    tokio::time::sleep(Duration::from_millis(40)).await;
    release(&fixture, 3, false).await;
    fixture.login_sent(&mut client).await;
    client.close(None).await.unwrap();
    fixture.ended().await;
    // It sleeps again at revision 4 and the next wake is a pool hit. The fence keeps the target
    // it last published beside the new intent.
    fixture
        .gateway
        .fences
        .write()
        .await
        .replace(HashMap::from([(
            DATABASE.into(),
            Fence {
                admission_target: Some(serde_json::from_value(wake_target(3, false)).unwrap()),
                ..fence("quiesce", 4)
            },
        )]))
        .unwrap();
    let mut client = fixture.upgrade(&wake_token(1402, 5)).await.unwrap();
    client
        .send(Message::Binary(startup("app").into()))
        .await
        .unwrap();
    poll(&fixture, Duration::from_secs(2)).await;
    release(&fixture, 5, true).await;
    fixture.login_sent(&mut client).await;
    let hit = json!({"database":DATABASE,"operation":wake_operation(),"generation":5,"outcome":"hit","steps_ms":{"attach":5,"total":40}});
    assert_eq!(wake_result(&fixture, hit).await.0, 200);
    client.close(None).await.unwrap();
    fixture.ended().await;
    // A wake the controller refuses.
    let mut client = fixture.upgrade(&wake_token(1403, 7)).await.unwrap();
    poll(&fixture, Duration::from_secs(2)).await;
    let refused = json!({"database":DATABASE,"operation":wake_operation(),"generation":7,"outcome":"refused","reason":"deleted"});
    assert_eq!(wake_result(&fixture, refused).await.0, 200);
    assert!(
        fatal(&mut client, Duration::from_secs(5))
            .await
            .contains("57P03")
    );
    held_count(&fixture, 0).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
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
fn running() -> HashMap<String, Fence> {
    HashMap::from([(DATABASE.into(), fence("running", 1))])
}
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
    let mut fixture = Fixture::scram(running(), Double::Scram(PASSWORD)).await;
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
    let mut fixture = Fixture::scram(running(), Double::Scram(PASSWORD)).await;
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
    let fixture = Fixture::scram(running(), Double::Scram(PASSWORD)).await;
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
    let mut fixture = Fixture::scram(running(), Double::Scram(PASSWORD)).await;
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
    let mut fixture = Fixture::scram(running(), Double::Forged(PASSWORD)).await;
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
    let mut fixture = Fixture::scram(sleeping(), Double::Scram(PASSWORD)).await;
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
    release(&fixture, 2, true).await;
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
    let fixture = Fixture::scram(running(), Double::Scram(PASSWORD)).await;
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
