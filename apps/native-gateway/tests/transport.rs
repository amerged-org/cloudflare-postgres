// SPDX-License-Identifier: Apache-2.0
//! Real loopback WebSocket and TLS sockets; this is protocol conformance, not Dev SQL acceptance.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    control,
    kubernetes::{Fence, Intent},
    sessions::Action,
    transport::{self, Config, DatabaseTarget, Gateway, PostgresDial},
};
use pgcf_native_protocol::{route::Keyring, wire};
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
    net::{TcpListener, TcpStream},
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
fn route_token(id: usize) -> String {
    let now = control::now() / 1000;
    token(
        wire("routeTokenPrefix"),
        wire("routeSignatureDomain"),
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
fn writer(pod: &str) -> Value {
    json!({"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice","metadata":{"name":"database-rw-a","namespace":format!("pgcf-db-{DATABASE}"),"uid":cid(201),"labels":{"kubernetes.io/service-name":"database-rw"}},"addressType":"IPv4","ports":[{"port":5432,"protocol":"TCP"}],"endpoints":[{"addresses":["10.0.0.7"],"conditions":{"ready":true},"targetRef":{"kind":"Pod","namespace":format!("pgcf-db-{DATABASE}"),"uid":pod},"nodeName":"customer-us1"}]})
}
fn legacy_identity() -> Value {
    json!({"handle":format!("pvc-{}",cid(205)),"claimUid":cid(205),"volumeUid":cid(206)})
}
fn legacy_bindings() -> String {
    json!([{"database_id":DATABASE,"storage_uid":cid(202),"namespace_uid":cid(207),"cluster_uid":cid(208),"physical_generation":1,"volume_identity":legacy_identity()}]).to_string()
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
}
impl PostgresDial for TestDial {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Failure>> {
        Box::pin(async move {
            assert_eq!(target.database, DATABASE);
            assert_eq!(target.host, format!("database-rw.pgcf-db-{DATABASE}.svc"));
            assert_eq!(target.port, 5432);
            assert_eq!(target.address.to_string(), "10.0.0.7");
            assert_eq!(target.pod_uid, cid(200));
            self.calls.fetch_add(1, Ordering::SeqCst);
            transport::negotiate_tls(
                TcpStream::connect(self.address).await?,
                &target.host,
                &self.ca,
            )
            .await
        })
    }
}
struct Fixture {
    gateway: Arc<Gateway>,
    port: u16,
    calls: Arc<AtomicUsize>,
    upstream: mpsc::Receiver<Vec<u8>>,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let identity =
            generate_simple_self_signed(vec![format!("database-rw.pgcf-db-{DATABASE}.svc")])
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
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = upstream.local_addr().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
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
            }),
        );
        gateway
            .fences
            .write()
            .await
            .replace(HashMap::from([(DATABASE.into(), fence("running", 1))]))
            .unwrap();
        {
            let mut targets = gateway.targets.write().await;
            *targets =
                pgcf_native_gateway::targets::Targets::with_legacy(&legacy_bindings()).unwrap();
            targets
                .replace("endpointslices", &[writer(&cid(200))], None)
                .unwrap();
            targets
                .replace("configmaps", &storage_maps(), None)
                .unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (stop, receiver) = watch::channel(false);
        let (send, received) = mpsc::channel(16);
        let mut shutdown = receiver.clone();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let upstream_task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {_=shutdown.changed()=>break,accepted=upstream.accept()=>{let(mut tcp,_)=accepted.unwrap();let(acceptor,send)=(acceptor.clone(),send.clone());tasks.spawn(async move{
                        let mut request=[0;8];tcp.read_exact(&mut request).await.unwrap();assert_eq!(request,[0,0,0,8,4,210,22,47]);tcp.write_all(b"S").await.unwrap();let mut tls=acceptor.accept(tcp).await.unwrap();
                        let length=tls.read_u32().await.unwrap()as usize;let mut raw=vec![0;length-4];tls.read_exact(&mut raw).await.unwrap();let mut startup_bytes=(length as u32).to_be_bytes().to_vec();startup_bytes.extend(raw);send.send(startup_bytes).await.unwrap();
                        tls.write_all(&[b'R',0,0,0,8,0,0,0,10]).await.unwrap();let mut password=[0;11];tls.read_exact(&mut password).await.unwrap();assert_eq!(&password,b"p\0\0\0\x0aopaque");
                        tls.write_all(&[b'R',0,0,0,8,0,0,0,0,b'Z',0,0,0,5,b'I']).await.unwrap();
                        loop{let mut header=[0;5];if tls.read_exact(&mut header).await.is_err(){break;}let length=u32::from_be_bytes(header[1..].try_into().unwrap())as usize;let mut body=vec![0;length-4];if tls.read_exact(&mut body).await.is_err(){break;}let mut bytes=header.to_vec();bytes.extend(body);if send.send(bytes).await.is_err(){break;}
                if tls.write_all(&[b'Z',0,0,0,5,b'I']).await.is_err(){break;}}
                    });}}
            }
            tasks.abort_all();
        });
        let run = gateway.clone();
        let mut shutdown = receiver.clone();
        let gateway_task = tokio::spawn(async move {
            let pending = Arc::new(Semaphore::new(128));
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {_=shutdown.changed()=>break,accepted=listener.accept()=>{let(socket,_)=accepted.unwrap();let(gateway,receiver,permit)=(run.clone(),shutdown.clone(),pending.clone().acquire_owned().await.unwrap());tasks.spawn(async move{let _=transport::serve_socket(socket,gateway,receiver,permit).await;});}}
            }
            tasks.abort_all();
        });
        Self {
            gateway,
            port,
            calls,
            upstream: received,
            stop,
            tasks: vec![upstream_task, gateway_task],
        }
    }
    async fn connect(&self, id: usize) -> Client {
        let mut request = format!("ws://127.0.0.1:{}/pg", self.port)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("x-pgcf-route", route_token(id).parse().unwrap());
        timeout(Duration::from_secs(10), connect_async(request))
            .await
            .unwrap()
            .unwrap()
            .0
    }
    async fn authenticate(&mut self, id: usize) -> Client {
        let mut client = self.connect(id).await;
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
        client
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
async fn startup_binding_is_checked_before_the_real_tls_dial() {
    let fixture = Fixture::new().await;
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
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
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
    let mut bytes = vec![b'x'; 1024 * 1024];
    bytes[0] = b'Q';
    let length = (bytes.len() - 1) as u32;
    bytes[1..5].copy_from_slice(&length.to_be_bytes());
    *bytes.last_mut().unwrap() = 0;
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
        .replace("endpointslices", &[writer(&cid(299))], None)
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

struct StorageIssuer {
    pair: ring::signature::Ed25519KeyPair,
    trust: pgcf_native_gateway::storage::StorageTrust,
}
impl StorageIssuer {
    fn new() -> Self {
        use ring::signature::KeyPair;
        let key = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
        let public = serde_json::to_string(&std::collections::BTreeMap::from([(
            "cf",
            URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        )]))
        .unwrap();
        use sha2::Digest;
        let pin = Sha256::digest(public.as_bytes())
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<String>();
        let trust = pgcf_native_gateway::storage::StorageTrust::parse(&public, &pin).unwrap();
        Self { pair, trust }
    }
    fn maps(&self, observed: u64, expires: u64, revision: u64) -> Vec<Value> {
        let profile = json!({"backend":"lvm-thin-v1","storage_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16)),"profile_sha256":"a".repeat(64),"node_uid":cid(204),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg"});
        let identity = json!({"handle":format!("pvc-{}",cid(205)),"lvUuid":"cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh","claimUid":cid(205),"volumeUid":cid(206)});
        let state = json!({"node":"customer-us1","storage":profile});
        let claims = json!({"v":1,"kid":"cf","database_id":DATABASE,"generation":1,"authority_revision":revision,"storage_uid":cid(202),"node_uid":profile["node_uid"],"volume_group_uuid":profile["volume_group_uuid"],"pool_uuid":profile["pool_uuid"],"profile_sha256":profile["profile_sha256"],"volume_handle":identity["handle"],"lv_uuid":identity["lvUuid"],"pvc_uid":cid(205),"pv_uid":cid(206),"pod_uid":cid(200),"observed_at":observed,"iat":observed,"exp":expires,"guard_seconds":120,"drain_seconds":1,"write_allowed":true});
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signed = self
            .pair
            .sign(format!("{}{body}", wire("storageAuthorityDomain")).as_bytes());
        let token = format!(
            "{}.{body}.{}",
            wire("storageAuthorityPrefix"),
            URL_SAFE_NO_PAD.encode(signed.as_ref())
        );
        let mut maps = storage_maps();
        maps[0]["data"]["state"] = state.to_string().into();
        maps[0]["metadata"]["annotations"] = json!({"pgcf.io/gateway-fence-uid":cid(100),"pgcf.io/volume-identity":identity.to_string()});
        maps[0]["data"][wire("storageAuthorityLedgerKey")] = token.into();
        maps[1]["data"] = json!({"intent.json":json!({"database":DATABASE,"operation":operation(),"revision":1,"mode":"running"}).to_string(),"power.json":json!({"anchor":{"storageUid":cid(202),"storageState":state.to_string(),"volumeIdentity":identity.to_string(),"storage":profile}}).to_string()});
        maps
    }
}
#[tokio::test]
async fn signed_storage_expiry_closes_quiet_tls_and_blocks_racing_frontend_write() {
    let mut fixture = Fixture::new().await;
    let issuer = StorageIssuer::new();
    let now = control::now();
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace(
            "configmaps",
            &issuer.maps(now, now + 60000, 1),
            Some(&issuer.trust),
        )
        .unwrap();
    let mut quiet = fixture.authenticate(810).await;
    let mut racing = fixture.authenticate(811).await;
    let expiry = control::now();
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace(
            "configmaps",
            &issuer.maps(expiry, expiry + 250, 2),
            Some(&issuer.trust),
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(260)).await;
    let _ = racing.send(Message::Binary(query().into())).await;
    for client in [&mut quiet, &mut racing] {
        let next = timeout(Duration::from_secs(1), client.next())
            .await
            .unwrap();
        assert!(
            matches!(next, Some(Ok(Message::Close(_))) | Some(Err(_)) | None),
            "expired signed authority retained a session: {next:?}"
        );
    }
    assert!(
        timeout(Duration::from_millis(150), fixture.upstream.recv())
            .await
            .is_err(),
        "frontend crossed signed expiry"
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn same_generation_writer_restart_cannot_reuse_old_signed_io_authority() {
    let mut fixture = Fixture::new().await;
    let issuer = StorageIssuer::new();
    let now = control::now();
    let maps = issuer.maps(now, now + 60000, 1);
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("configmaps", &maps, Some(&issuer.trust))
        .unwrap();
    let mut client = fixture.authenticate(820).await;
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("endpointslices", &[writer(&cid(299))], Some(&issuer.trust))
        .unwrap();
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace("configmaps", &maps, Some(&issuer.trust))
        .unwrap();
    let _ = client.send(Message::Binary(query().into())).await;
    assert!(
        fixture
            .gateway
            .targets
            .read()
            .await
            .target(DATABASE, control::now())
            .is_err()
    );
    let mut request = format!("ws://127.0.0.1:{}/pg", fixture.port)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("x-pgcf-route", route_token(821).parse().unwrap());
    let error = connect_async(request).await.unwrap_err();
    assert!(
        matches!(error,tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==503)
    );
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
#[tokio::test]
async fn healthy_signed_renewal_preserves_tls_session_and_power_epoch() {
    let mut fixture = Fixture::new().await;
    let issuer = StorageIssuer::new();
    let now = control::now();
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace(
            "configmaps",
            &issuer.maps(now, now + 60000, 1),
            Some(&issuer.trust),
        )
        .unwrap();
    let epoch = fixture.gateway.fences.read().await.bound_epoch(DATABASE);
    let mut client = fixture.authenticate(830).await;
    fixture
        .gateway
        .targets
        .write()
        .await
        .replace(
            "configmaps",
            &issuer.maps(now + 1, now + 60001, 2),
            Some(&issuer.trust),
        )
        .unwrap();
    client.send(Message::Binary(query().into())).await.unwrap();
    assert_eq!(
        timeout(Duration::from_secs(1), fixture.upstream.recv())
            .await
            .unwrap()
            .unwrap(),
        query()
    );
    assert_eq!(
        fixture.gateway.fences.read().await.bound_epoch(DATABASE),
        epoch
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
#[tokio::test]
async fn missing_immutable_legacy_cohort_cannot_be_replaced_by_regional_ledgers() {
    let fixture = Fixture::new().await;
    {
        let mut targets = fixture.gateway.targets.write().await;
        *targets = pgcf_native_gateway::targets::Targets::default();
        targets
            .replace("endpointslices", &[writer(&cid(200))], None)
            .unwrap();
        targets
            .replace("configmaps", &storage_maps(), None)
            .unwrap();
    }
    let mut request = format!("ws://127.0.0.1:{}/pg", fixture.port)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("x-pgcf-route", route_token(850).parse().unwrap());
    let error = connect_async(request).await.unwrap_err();
    assert!(
        matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status()==503)
    );
    assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
}
