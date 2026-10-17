// SPDX-License-Identifier: Apache-2.0
//! A wake end to end, without a live system: a client holding a route v5 ticket connects to the
//! real gateway (`pgcf-native-gateway`), the controller's intake takes the wake from the
//! gateway's long-poll, the pool decides it against the Kubernetes API double, the node agent
//! double and the PostgreSQL doubles of the world, and the gateway releases the held client by
//! the fence the controller writes. The gateway reads the cluster through what its watches would
//! deliver: the objects of the API double, with the EndpointSlice Kubernetes keeps for each CNPG
//! instance Pod.
use crate::{test_server::State, test_world::*};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    kubernetes::parse_snapshot,
    transport::{self, Config, DatabaseTarget, Gateway, PostgresDial},
};
use pgcf_native_protocol::{
    route::Keyring,
    wake::{self, WakeClaims, WakeRequest},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, copy_bidirectional},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

type Failure = Box<dyn std::error::Error + Send + Sync>;
type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;
/// The world's regional route key: the gateway verifies route v5 and the controller's `gc1` and
/// `gw1` tokens with it.
const KEY: [u8; 32] = [7; 32];
const KID: &str = "local";
const REGION: &str = "eu-test";
/// The world's gateway Pod.
const GATEWAY_IP: &str = "10.0.0.1";

fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap()
}
fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Dials what the gateway routes to: the PostgreSQL double that answers for the target's TLS
/// name, verified against the CA the controller published in `ca-<db>` (as the gateway's own
/// dial reads it), which must be the CA the admission target pins.
struct WorldDial {
    objects: Arc<Mutex<State>>,
    routes: Arc<Mutex<HashMap<String, SocketAddr>>>,
    dialled: Arc<Mutex<Vec<DatabaseTarget>>>,
}
impl PostgresDial for WorldDial {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<tokio_rustls::client::TlsStream<TcpStream>, Failure>> {
        Box::pin(async move {
            self.dialled.lock().unwrap().push(target.clone());
            let published = crate::test_server::path(
                "ConfigMap",
                Some(SYSTEM),
                &format!("ca-{}", target.database),
            );
            let ca = self
                .objects
                .lock()
                .unwrap()
                .objects
                .get(&published)
                .and_then(|map| map["data"]["ca.crt"].as_str().map(str::to_string))
                .ok_or("published CA missing")?;
            if target
                .ca_sha256
                .as_ref()
                .is_some_and(|pinned| *pinned != sha256_hex(ca.as_bytes()))
            {
                return Err("published CA is not the admitted one".into());
            }
            let address = *self
                .routes
                .lock()
                .unwrap()
                .get(&target.host)
                .ok_or("no PostgreSQL answers for this name")?;
            transport::negotiate_tls(
                TcpStream::connect(address).await?,
                &target.host,
                ca.as_bytes(),
            )
            .await
        })
    }
}

/// The EndpointSlice Kubernetes keeps for the `database-rw` Service of a CNPG instance Pod: the
/// Pod's address, ready as the kubelet reports it.
fn endpoint_slice(pod: &Value) -> Option<Value> {
    let ns = pod["metadata"]["namespace"].as_str()?;
    let ip = pod["status"]["podIP"].as_str()?;
    let ready = pod["status"]["conditions"].as_array().is_some_and(|all| {
        all.iter()
            .any(|c| c["type"] == "Ready" && c["status"] == "True")
    });
    Some(
        json!({"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice","metadata":{"name":"database-rw-x","namespace":ns,"uid":pod["metadata"]["uid"],"labels":{"kubernetes.io/service-name":"database-rw"}},"addressType":"IPv4","ports":[{"port":5432,"protocol":"TCP"}],"endpoints":[{"addresses":[ip],"conditions":{"ready":ready,"serving":ready,"terminating":false},"targetRef":{"kind":"Pod","namespace":ns,"uid":pod["metadata"]["uid"]},"nodeName":pod["spec"]["nodeName"]}]}),
    )
}

/// What the gateway's watches deliver, from the objects of the API double: the fences, the
/// CNPG instance Pods with their EndpointSlices, and the database ConfigMaps of `pgcf-system`.
/// A fence the gateway refuses is recorded: it stops admitting every database.
async fn deliver(gateway: &Gateway, objects: &Arc<Mutex<State>>, refused: &Mutex<Vec<String>>) {
    let all: Vec<Value> = objects.lock().unwrap().objects.values().cloned().collect();
    let in_system = |o: &&Value| o["kind"] == "ConfigMap" && o["metadata"]["namespace"] == SYSTEM;
    let fences: Vec<Value> = all
        .iter()
        .filter(in_system)
        .filter(|o| o["metadata"]["labels"]["pgcf.io/gateway-fence"] == "true")
        .cloned()
        .collect();
    let maps: Vec<Value> = all
        .iter()
        .filter(in_system)
        .filter(|o| o["metadata"]["labels"]["pgcf.io/database-id"].is_string())
        .cloned()
        .collect();
    let pods: Vec<Value> = all
        .iter()
        .filter(|o| o["kind"] == "Pod" && o["metadata"]["labels"]["cnpg.io/cluster"] == "database")
        .cloned()
        .collect();
    let slices: Vec<Value> = pods.iter().filter_map(endpoint_slice).collect();
    let list = json!({"apiVersion":"v1","kind":"ConfigMapList","metadata":{"resourceVersion":"1"},"items":fences});
    let applied = match parse_snapshot(&list) {
        Ok(records) => gateway.fences.write().await.replace(records),
        Err(reason) => Err(reason),
    };
    if let Err(reason) = applied {
        refused.lock().unwrap().push(format!("fences: {reason}"));
    }
    let mut targets = gateway.targets.write().await;
    for (kind, items) in [
        ("endpointslices", slices),
        ("pods", pods),
        ("configmaps", maps),
    ] {
        if let Err(reason) = targets.replace(kind, &items) {
            refused.lock().unwrap().push(format!("{kind}: {reason}"));
        }
    }
}

/// The real gateway of the world's region, serving on a loopback port, and the HTTP proxy that
/// sends the controller's requests for the gateway Pod's control port to it (every other node
/// request goes on to the world's doubles).
struct RealGateway {
    gateway: Arc<Gateway>,
    port: u16,
    routes: Arc<Mutex<HashMap<String, SocketAddr>>>,
    dialled: Arc<Mutex<Vec<DatabaseTarget>>>,
    refused: Arc<Mutex<Vec<String>>>,
    exchanges: Exchanges,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}
impl Drop for RealGateway {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        for task in &self.tasks {
            task.abort();
        }
    }
}
impl RealGateway {
    async fn start(w: &mut World) -> Self {
        let objects = w.server.state.clone();
        let routes: Arc<Mutex<HashMap<String, SocketAddr>>> = Arc::default();
        let dialled: Arc<Mutex<Vec<DatabaseTarget>>> = Arc::default();
        let gateway = Gateway::new(
            Arc::new(Config {
                region: REGION.into(),
                keyring: Keyring {
                    active: KID.into(),
                    keys: HashMap::from([(KID.to_string(), KEY.to_vec())]),
                },
                maximum_memory: 192 * 1024 * 1024,
                database_memory: 96 * 1024 * 1024,
            }),
            w.gateway.pod.lock().unwrap().clone(),
            Arc::new(WorldDial {
                objects: objects.clone(),
                routes: routes.clone(),
                dialled: dialled.clone(),
            }),
        );
        let refused: Arc<Mutex<Vec<String>>> = Arc::default();
        deliver(&gateway, &objects, &refused).await;
        let (stop, stopped) = watch::channel(false);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let serving = gateway.clone();
        let mut shutdown = stopped.clone();
        let serve = tokio::spawn(async move {
            let permits = Arc::new(Semaphore::new(128));
            loop {
                tokio::select! {
                    _ = shutdown.changed() => return,
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { return };
                        let (gateway, stop) = (serving.clone(), stopped.clone());
                        let permit = permits.clone().acquire_owned().await.unwrap();
                        tokio::spawn(async move {
                            let _ = transport::serve_socket(socket, gateway, stop, permit).await;
                        });
                    }
                }
            }
        });
        let watched = gateway.clone();
        let refusing = refused.clone();
        let watches = tokio::spawn(async move {
            loop {
                deliver(&watched, &objects, &refusing).await;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let exchanges: Exchanges = Arc::default();
        let (client, proxy) = proxy(port, w.gateway.address, exchanges.clone()).await;
        w.reconciler.power.http = client.clone();
        w.reconciler.pool.intake.http = client;
        Self {
            gateway,
            port,
            routes,
            dialled,
            refused,
            exchanges,
            stop,
            tasks: vec![serve, watches, proxy],
        }
    }
    /// The wake results the gateway accepted.
    fn results(&self) -> Vec<Value> {
        self.exchanges
            .lock()
            .unwrap()
            .iter()
            .filter(|(path, _, status)| path == wake::RESULT_PATH && *status == 200)
            .map(|(_, body, _)| body.clone())
            .collect()
    }
    /// The client's WebSocket to the gateway under `route`: answered at once, or with its status.
    async fn connect(&self, route: &str) -> Result<Client, u16> {
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
}

/// One request of the controller to the gateway's control port: its path, its body and the
/// status the gateway answered.
type Exchanges = Arc<Mutex<Vec<(String, Value, u16)>>>;
/// An HTTP proxy for the controller's node clients: a request for the gateway Pod's control port
/// goes to the real gateway and is recorded, every other one goes on to the world's doubles.
async fn proxy(
    gateway_port: u16,
    doubles: SocketAddr,
    exchanges: Exchanges,
) -> (reqwest::Client, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let exchanges = exchanges.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0];
                while !head.ends_with(b"\r\n\r\n") {
                    if socket.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    head.push(byte[0]);
                }
                let text = String::from_utf8_lossy(&head).into_owned();
                let (line, rest) = text.split_once("\r\n").unwrap();
                let mut parts = line.split_whitespace();
                let (method, target) = (parts.next().unwrap(), parts.next().unwrap());
                let origin = format!("http://{GATEWAY_IP}:8080");
                let Some(path) = target
                    .strip_prefix(&origin)
                    .filter(|path| path.starts_with("/_pgcf/gateway/"))
                else {
                    let Ok(mut upstream) = TcpStream::connect(doubles).await else {
                        return;
                    };
                    if upstream.write_all(&head).await.is_ok() {
                        let _ = copy_bidirectional(&mut socket, &mut upstream).await;
                    }
                    return;
                };
                let length = rest
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                if socket.read_exact(&mut body).await.is_err() {
                    return;
                }
                let Ok(mut upstream) =
                    TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], gateway_port))).await
                else {
                    return;
                };
                let mut request = format!("{method} {path} HTTP/1.1\r\n{rest}").into_bytes();
                request.extend_from_slice(&body);
                let mut answer = Vec::new();
                if upstream.write_all(&request).await.is_err()
                    || upstream.read_to_end(&mut answer).await.is_err()
                {
                    return;
                }
                let status = String::from_utf8_lossy(&answer)
                    .split_whitespace()
                    .nth(1)
                    .and_then(|status| status.parse().ok())
                    .unwrap_or(0);
                exchanges.lock().unwrap().push((
                    path.to_string(),
                    serde_json::from_slice(&body).unwrap_or(Value::Null),
                    status,
                ));
                let _ = socket.write_all(&answer).await;
            });
        }
    });
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
        .retry(reqwest::retry::never())
        .build()
        .unwrap();
    (client, task)
}

/// The route v5 the Edge signs for `wake`, as the Actor's ticket names it.
fn ticket(wake: &WakeRequest, user: &str, cid: &str) -> String {
    let iat = now_ms() / 1000;
    let claims = WakeClaims {
        v: wake::ROUTE_VERSION,
        db: wake.database.clone(),
        user: user.into(),
        cid: cid.into(),
        rg: REGION.into(),
        kid: KID.into(),
        iat,
        exp: iat + 30,
        op: wake.operation.clone(),
        generation: wake.generation,
        route_revision: wake.route_revision,
        rh: wake.role_revision_hash.clone(),
    };
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
    let mut mac = Hmac::<Sha256>::new_from_slice(&KEY).unwrap();
    mac.update(wake::ROUTE_DOMAIN.as_bytes());
    mac.update(payload.as_bytes());
    format!(
        "{}.{payload}.{}",
        wake::ROUTE_PREFIX,
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}
fn message(kind: Option<u8>, body: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = kind.into_iter().collect();
    out.extend_from_slice(&u32::try_from(body.len() + 4).unwrap().to_be_bytes());
    out.extend_from_slice(body);
    out
}
fn startup(user: &str, database: &str) -> Vec<u8> {
    let mut body = 196_608_u32.to_be_bytes().to_vec();
    for (name, value) in [("user", user), ("database", database)] {
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    message(None, &body)
}
/// One statement in the extended protocol: Parse, Bind, Execute, Sync.
fn statement(sql: &str) -> Vec<u8> {
    let mut parse = vec![0];
    parse.extend_from_slice(sql.as_bytes());
    parse.extend_from_slice(&[0, 0, 0]);
    let mut out = message(Some(b'P'), &parse);
    out.extend(message(Some(b'B'), &[0, 0, 0, 0, 0, 0, 0, 0]));
    out.extend(message(Some(b'E'), &[0, 0, 0, 0, 0]));
    out.extend(message(Some(b'S'), &[]));
    out
}
/// The backend messages the client receives up to and including ReadyForQuery.
async fn until_ready(client: &mut Client) -> Vec<(u8, Vec<u8>)> {
    let mut bytes = Vec::new();
    let mut messages = Vec::new();
    loop {
        while bytes.len() >= 5 {
            let length = u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize;
            if bytes.len() < length + 1 {
                break;
            }
            let rest = bytes.split_off(length + 1);
            let kind = bytes[0];
            messages.push((kind, bytes[5..].to_vec()));
            bytes = rest;
            if kind == b'Z' {
                return messages;
            }
            assert_ne!(kind, b'E', "an ErrorResponse: {messages:?}");
        }
        let next = timeout(Duration::from_secs(15), client.next())
            .await
            .expect("the backend answers within the wake bound")
            .expect("the socket stays open")
            .unwrap();
        match next {
            Message::Binary(data) => bytes.extend_from_slice(&data),
            Message::Close(frame) => panic!("closed: {frame:?}"),
            _ => {}
        }
    }
}
/// The first column of the first DataRow.
fn first_cell(messages: &[(u8, Vec<u8>)]) -> String {
    let (_, row) = messages
        .iter()
        .find(|(kind, _)| *kind == b'D')
        .expect("a DataRow");
    let length = i32::from_be_bytes(row[2..6].try_into().unwrap()) as usize;
    String::from_utf8(row[6..6 + length].to_vec()).unwrap()
}
/// Takes the next wake the controller's intake receives from the real gateway's long-poll.
async fn intake(w: &World) -> (crate::power::GatewayPod, WakeRequest) {
    let (sender, mut wakes) = mpsc::channel(16);
    let polls = w.reconciler.pool.intake.run(&w.reconciler.power, sender);
    tokio::pin!(polls);
    tokio::select! {
        _ = &mut polls => panic!("the intake ended"),
        delivered = timeout(Duration::from_secs(10), wakes.recv()) => {
            delivered.expect("the gateway hands the wake over").unwrap()
        }
    }
}
async fn eventually(what: &str, check: impl Fn() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never: {what}");
}

#[tokio::test]
async fn a_held_client_is_answered_by_the_slot_its_wake_was_attached_to() {
    let mut w = World::pooled().await;
    let gateway = RealGateway::start(&mut w).await;
    gateway.routes.lock().unwrap().insert(
        wake::slot_tls_name(&slot_ns()),
        w.slot_postgres.as_ref().unwrap().address,
    );
    w.node_storage(true);
    // The Edge's ticket for the sleeping database: the gateway answers 101 at once and holds the
    // StartupMessage.
    let expected = w.wake_request();
    let mut client = gateway
        .connect(&ticket(&expected, "app", &crate::test_server::uid(900)))
        .await
        .expect("a v5 ticket is upgraded at once");
    client
        .send(Message::Binary(startup("app", &w.id).into()))
        .await
        .unwrap();
    // The controller's long-poll takes the wake the gateway queued, and the pool decides it as
    // the controller's loop does.
    let (pod, delivered) = intake(&w).await;
    assert_eq!(pod.uid, gateway_uid());
    assert_eq!(
        WakeRequest {
            queued_at_ms: 0,
            ..delivered.clone()
        },
        WakeRequest {
            queued_at_ms: 0,
            ..expected
        }
    );
    let from = w.log_len();
    w.reconciler.pool.delivered(&pod, &delivered);
    w.reconciler
        .pool
        .wake(&w.reconciler, Some((&w.db, &w.snapshot)), &delivered, false)
        .await
        .unwrap();
    let serving = w.reconciler.pool.serving(&w.id).expect("a pool hit");
    assert_eq!(serving.slot, SLOT_HEX);
    // Released by the fence, the held StartupMessage reaches the slot's PostgreSQL, which runs on
    // the database's volume, and the client's first statement is answered there.
    let authenticated = until_ready(&mut client).await;
    assert_eq!(authenticated[0], (b'R', 0_u32.to_be_bytes().to_vec()));
    client
        .send(Message::Binary(
            statement(crate::postgres::SERVER_IDENTITY_QUERY).into(),
        ))
        .await
        .unwrap();
    let answered = until_ready(&mut client).await;
    assert_eq!(
        first_cell(&answered),
        w.sql.lock().unwrap().system_identifier
    );
    let lines = w.since(from);
    let position = |needle: &str| {
        lines
            .iter()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("no {needle:?} in {lines:#?}"))
    };
    // Attached, unfenced and proved before the client's own statement reached the slot.
    assert!(position("AGENT attach ok") < position("SLOT SQL pgcf_maintenance server identity"));
    assert!(
        position("SLOT SQL pgcf_maintenance server identity")
            < position("SLOT SQL app server identity")
    );
    let dialled = gateway.dialled.lock().unwrap().clone();
    assert_eq!(dialled.len(), 1, "{dialled:?}");
    assert_eq!(dialled[0].host, wake::slot_tls_name(&slot_ns()));
    assert_eq!(dialled[0].pod_uid, slot_pod_uid());
    assert_eq!(dialled[0].address.to_string(), SLOT_IP);
    assert_eq!(gateway.gateway.wakes.held(&w.id), 0);
    assert!(
        gateway.refused.lock().unwrap().is_empty(),
        "{:?}",
        gateway.refused.lock().unwrap()
    );
    eventually("the gateway accepted the hit", || {
        gateway.results().iter().any(|result| {
            result["outcome"] == "hit" && result["generation"] == delivered.generation
        })
    })
    .await;
}

#[tokio::test]
async fn a_pool_miss_holds_the_client_until_the_database_s_own_cluster_is_released() {
    // A database without thin storage slept through its own Cluster: a pool miss.
    let mut w = World::awake().await;
    w.admitted();
    assert!(
        w.sleep_pass().await.is_none(),
        "the first pass proves the sleep"
    );
    w.hibernated_by_cnpg();
    let observed = w.sleep_pass().await.expect("a hibernated observation");
    assert_eq!(observed["state"], "hibernated", "{observed}");
    let gateway = RealGateway::start(&mut w).await;
    gateway.routes.lock().unwrap().insert(
        format!("database-rw.{}.svc", w.ns),
        w.postgres.as_ref().unwrap().address,
    );
    let expected = w.wake_request();
    let mut client = gateway
        .connect(&ticket(&expected, "app", &crate::test_server::uid(901)))
        .await
        .expect("a v5 ticket is upgraded at once");
    client
        .send(Message::Binary(startup("app", &w.id).into()))
        .await
        .unwrap();
    let (pod, delivered) = intake(&w).await;
    w.reconciler.pool.delivered(&pod, &delivered);
    w.reconciler
        .pool
        .wake(&w.reconciler, Some((&w.db, &w.snapshot)), &delivered, false)
        .await
        .unwrap();
    assert!(!w.reconciler.pool.serves(&w.id));
    // The miss is a label: the gateway keeps the client held.
    eventually("the gateway accepted the miss", || {
        gateway
            .results()
            .iter()
            .any(|result| result["outcome"] == "miss" && result["reason"] == "thick_storage")
    })
    .await;
    assert_eq!(gateway.gateway.wakes.held(&w.id), 1);
    // Cloudflare's claim of the ticket commits its generation and operation, which moves the
    // route revision on; today's path wakes the database's own Cluster.
    w.claimed(&delivered);
    w.db["admission"]["route_revision"] = (delivered.route_revision + 1).into();
    let from = w.log_len();
    let first = w
        .reconciler
        .reconcile(&w.db, &w.snapshot)
        .await
        .unwrap()
        .expect("an observation");
    assert_eq!(first["state"], "provisioning", "{first}");
    assert!(
        w.since(from)
            .iter()
            .any(|line| line.contains("\"cnpg.io/hibernation\":\"off\"")),
        "{:#?}",
        w.since(from)
    );
    assert_eq!(gateway.gateway.wakes.held(&w.id), 1, "held until released");
    // CNPG starts the instance: its Pod runs and reports Ready, PostgreSQL answers.
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["conditions"] = json!([{"type":"Ready","status":"True"}]);
        });
    w.pod(true);
    w.start_postgres().await;
    w.cnpg_reconciles();
    let mut ready = None;
    for _ in 0..10 {
        w.node_storage(true);
        let observed = w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
        if let Some(observed) = observed.filter(|o| o["state"] == "ready") {
            ready = Some(observed);
            break;
        }
    }
    let ready = ready.expect("today's path reports the database ready");
    assert_eq!(ready["power"]["operation"], delivered.operation.as_str());
    // Released by the fence at the claim's route revision, the held StartupMessage reaches the
    // database's own PostgreSQL and the first statement is answered there.
    let authenticated = until_ready(&mut client).await;
    assert_eq!(authenticated[0], (b'R', 0_u32.to_be_bytes().to_vec()));
    client
        .send(Message::Binary(
            statement(crate::postgres::SERVER_IDENTITY_QUERY).into(),
        ))
        .await
        .unwrap();
    let answered = until_ready(&mut client).await;
    assert_eq!(
        first_cell(&answered),
        w.sql.lock().unwrap().system_identifier
    );
    let dialled = gateway.dialled.lock().unwrap().clone();
    assert_eq!(dialled.len(), 1, "{dialled:?}");
    assert_eq!(dialled[0].host, format!("database-rw.{}.svc", w.ns));
    assert_eq!(dialled[0].pod_uid, pod_uid());
    assert!(
        gateway.refused.lock().unwrap().is_empty(),
        "{:?}",
        gateway.refused.lock().unwrap()
    );
}

/// The end of Cloudflare's claim of `wake`: the claim's admission mutation moves the admission
/// epoch and the route revision on.
fn claim(w: &mut World, wake: &WakeRequest) {
    w.db["admission"]["admission_epoch"] =
        (w.db["admission"]["admission_epoch"].as_u64().unwrap() + 1).into();
    w.db["admission"]["route_revision"] = (wake.route_revision + 1).into();
}
/// What the kubelet and CNPG write once the slot's instance runs: the Pod and its `postgres`
/// container ready, the Cluster's primary.
fn slot_runs(w: &World) {
    w.server.edit("Pod", Some(&slot_ns()), "database-1", |pod| {
        pod["status"]["conditions"] = json!([{"type":"Ready","status":"True"}]);
        pod["status"]["containerStatuses"][0]["ready"] = true.into();
    });
    w.server
        .edit("Cluster", Some(&slot_ns()), "database", |cluster| {
            cluster["status"]["currentPrimary"] = "database-1".into();
            cluster["status"]["readyInstances"] = 1.into();
            cluster["status"]["conditions"] = json!([{"type":"Ready","status":"True"}]);
        });
}
/// A wake through the real gateway: the held client, the controller's intake and the pool. It
/// returns the client, connected to whatever the wake released it to, and the wake.
async fn held_wake(w: &World, gateway: &RealGateway, cid: u64) -> (Client, WakeRequest) {
    let expected = w.wake_request();
    let mut client = gateway
        .connect(&ticket(&expected, "app", &crate::test_server::uid(cid)))
        .await
        .expect("a v5 ticket is upgraded at once");
    client
        .send(Message::Binary(startup("app", &w.id).into()))
        .await
        .unwrap();
    let (pod, delivered) = intake(w).await;
    w.reconciler.pool.delivered(&pod, &delivered);
    w.reconciler
        .pool
        .wake(&w.reconciler, Some((&w.db, &w.snapshot)), &delivered, false)
        .await
        .unwrap();
    (client, delivered)
}

#[tokio::test]
async fn a_pool_hit_is_reported_ready_sleeps_through_its_slot_and_wakes_by_a_pool_hit_again() {
    let mut w = World::pooled().await;
    let gateway = RealGateway::start(&mut w).await;
    gateway.routes.lock().unwrap().insert(
        wake::slot_tls_name(&slot_ns()),
        w.slot_postgres.as_ref().unwrap().address,
    );
    w.node_storage(true);
    let (mut client, delivered) = held_wake(&w, &gateway, 910).await;
    assert!(w.reconciler.pool.serves(&w.id), "a pool hit");
    until_ready(&mut client).await;
    // Unfenced, the slot's instance runs: the kubelet reports its Pod ready and CNPG writes the
    // Cluster's status.
    slot_runs(&w);
    // Cloudflare commits the ticket; the controller's loop confirms it from the desired row the
    // Actor's hint carries, which is read ahead of the snapshot publish that closes the claim's
    // admission mutation: the admission is still the one before the claim.
    w.claimed(&delivered);
    let db = w.db.clone();
    assert_eq!(
        w.reconciler.pool.confirm_tickets(
            |id| (id == db["id"]).then_some(&db),
            std::time::Instant::now()
        ),
        vec![(w.id.clone(), crate::pool::TicketOutcome::Confirmed)]
    );
    // (1) The passes that follow report the database as an awake one: ready at the claim's
    // generation, awake under its operation, attested at the slot's Pod under the admission the
    // claim committed.
    w.node_storage(true);
    let first = w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
    assert_eq!(
        first.as_ref().map(|o| o["state"].clone()),
        Some("ready".into()),
        "{first:?}"
    );
    // The admission mutation completes: the next pull has the claim's admission.
    claim(&mut w, &delivered);
    let mut ready = None;
    for _ in 0..5 {
        w.node_storage(true);
        if let Some(observed) = w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap()
            && observed["state"] == "ready"
        {
            ready = Some(observed);
            break;
        }
    }
    let ready = ready.expect("a ready observation of the slot-served database");
    assert_eq!(ready["generation"], delivered.generation, "{ready}");
    assert_eq!(ready["power"]["state"], "awake", "{ready}");
    assert_eq!(ready["power"]["operation"], delivered.operation.as_str());
    assert_eq!(ready["power"]["revision"], delivered.generation);
    let proof = &ready["runtime_attestation"];
    assert_eq!(proof["pod_uid"], slot_pod_uid(), "{ready}");
    assert_eq!(proof["generation"], delivered.generation);
    assert_eq!(proof["route_revision"], w.db["admission"]["route_revision"]);
    assert_eq!(
        proof["admission_epoch"],
        w.db["admission"]["admission_epoch"]
    );
    // (2) Converged: the API took the ready report, which ends the claim's start hold, and the
    // next passes report the same database ready without writing anything.
    w.db.as_object_mut().unwrap().remove("storage_startup");
    for _ in 0..3 {
        w.node_storage(true);
        let from = w.log_len();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .expect("a converged pass reports the database");
        assert_eq!(observed["state"], "ready", "{observed}");
        assert_eq!(observed["power"]["state"], "awake", "{observed}");
        let writes: Vec<_> = w
            .since(from)
            .into_iter()
            .filter(|line| {
                ["PATCH ", "POST ", "PUT ", "DELETE "]
                    .iter()
                    .any(|verb| line.starts_with(verb))
            })
            .collect();
        assert!(writes.is_empty(), "{writes:#?}");
    }
    assert!(w.reconciler.pool.serves(&w.id));
    drop(client);
    // (3) Idle: Cloudflare asks for the sleep. The slot proves it, the sleep record is written,
    // the slot's namespace deleted and its holder released.
    w.db["generation"] = (delivered.generation + 1).into();
    w.db["desired_state"] = "suspended".into();
    w.db["power"] = json!({"operation":format!("op_{}","i".repeat(20)),"revision":delivered.generation + 1,"mode":"quiesce","reason":"idle"});
    w.db["size"]
        .as_object_mut()
        .unwrap()
        .remove("memory_request_mib");
    w.db["admission"]["admission_epoch"] =
        (w.db["admission"]["admission_epoch"].as_u64().unwrap() + 1).into();
    w.db["admission"]["route_revision"] =
        (w.db["admission"]["route_revision"].as_u64().unwrap() + 1).into();
    let mut slept = None;
    for _ in 0..5 {
        w.node_storage(true);
        if let Some(observed) = w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap()
            && observed["state"] == "hibernated"
        {
            slept = Some(observed);
            break;
        }
    }
    let slept = slept.expect("the slot-served database sleeps");
    assert_eq!(slept["generation"], delivered.generation + 1, "{slept}");
    assert!(!w.reconciler.pool.serves(&w.id));
    assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
    let storage = w
        .server
        .get("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id))
        .unwrap();
    let record: crate::pool::SleepRecord = serde_json::from_str(
        storage["metadata"]["annotations"][crate::pool::SLEEP_RECORD]
            .as_str()
            .expect("a sleep record"),
    )
    .unwrap();
    assert_eq!(record.via, crate::pool::Via::Slot);
    // (4) The refill gives the node a free slot again, and the next wake is a pool hit.
    w.free_slot().await;
    gateway.routes.lock().unwrap().insert(
        wake::slot_tls_name(&slot_ns()),
        w.slot_postgres.as_ref().unwrap().address,
    );
    let (mut client, again) = held_wake(&w, &gateway, 911).await;
    assert_eq!(again.generation, delivered.generation + 2);
    assert!(
        w.reconciler.pool.serves(&w.id),
        "the second wake is a pool hit"
    );
    until_ready(&mut client).await;
    eventually("the gateway accepted the second hit", || {
        gateway
            .results()
            .iter()
            .any(|result| result["outcome"] == "hit" && result["generation"] == again.generation)
    })
    .await;
}

/// The reasons the events of this test's thread give for passes that withheld `id`'s ready
/// report.
fn withheld(id: &str) -> Vec<String> {
    crate::timing::take_emitted()
        .into_iter()
        .filter(|event| event["event"] == "ready_withheld" && event["database_id"] == id)
        .map(|event| event["reason"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn a_pass_that_withholds_a_slot_served_database_s_ready_report_says_why() {
    let mut w = World::pooled().await;
    let gateway = RealGateway::start(&mut w).await;
    gateway.routes.lock().unwrap().insert(
        wake::slot_tls_name(&slot_ns()),
        w.slot_postgres.as_ref().unwrap().address,
    );
    w.node_storage(true);
    let (mut client, delivered) = held_wake(&w, &gateway, 912).await;
    until_ready(&mut client).await;
    slot_runs(&w);
    // Cloudflare has not committed the ticket yet: the pass reports nothing, and says so.
    w.claimed(&delivered);
    crate::timing::take_emitted();
    assert_eq!(
        w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap(),
        None
    );
    assert_eq!(withheld(&w.id), ["wake_ticket_pending"]);
    let db = w.db.clone();
    w.reconciler.pool.confirm_tickets(
        |id| (id == db["id"]).then_some(&db),
        std::time::Instant::now(),
    );
    // The fence the ready report is released under asks for a sleep meanwhile.
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut intent: Value =
                serde_json::from_str(map["data"]["intent.json"].as_str().unwrap()).unwrap();
            intent["mode"] = "quiesce".into();
            map["data"]["intent.json"] = intent.to_string().into();
        },
    );
    w.node_storage(true);
    crate::timing::take_emitted();
    assert_eq!(
        w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap(),
        None
    );
    assert_eq!(withheld(&w.id), ["ready_fence_quiesced"]);
}

#[tokio::test]
async fn a_slot_served_database_whose_postgres_does_not_accept_is_not_reported_ready() {
    let mut w = World::pooled().await;
    let gateway = RealGateway::start(&mut w).await;
    gateway.routes.lock().unwrap().insert(
        wake::slot_tls_name(&slot_ns()),
        w.slot_postgres.as_ref().unwrap().address,
    );
    w.node_storage(true);
    let (mut client, delivered) = held_wake(&w, &gateway, 913).await;
    until_ready(&mut client).await;
    slot_runs(&w);
    w.claimed(&delivered);
    let db = w.db.clone();
    w.reconciler.pool.confirm_tickets(
        |id| (id == db["id"]).then_some(&db),
        std::time::Instant::now(),
    );
    claim(&mut w, &delivered);
    let mut ready = false;
    for _ in 0..5 {
        w.node_storage(true);
        if w.reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .is_some_and(|observed| observed["state"] == "ready")
        {
            ready = true;
            break;
        }
    }
    assert!(ready, "the slot-served database is reported ready");
    // PostgreSQL in the slot goes down inside the same container: the Pod, its container and the
    // volume's single opener stay what they were.
    w.slot_postgres.as_ref().unwrap().stop();
    w.node_storage(true);
    crate::timing::take_emitted();
    let observed = w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
    assert_eq!(withheld(&w.id), ["slot_postgres_not_accepting"]);
    assert_ne!(
        observed.as_ref().map(|o| o["state"].clone()),
        Some("ready".into()),
        "{observed:?}"
    );
    assert!(w.reconciler.pool.serves(&w.id));
}
