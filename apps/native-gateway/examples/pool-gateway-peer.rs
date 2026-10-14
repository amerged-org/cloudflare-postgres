// SPDX-License-Identifier: Apache-2.0
//! Actual PG/TLS protocol proof. Generated CF/Kube metadata is conformance custody, not node acceptance.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt, future::BoxFuture};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_gateway::{
    control,
    kubernetes::{Fence, Intent},
    targets::Targets,
    transport::{self, Config, DatabaseTarget, Gateway, PostgresDial},
};
use pgcf_native_protocol::{pool, route::Keyring, storage::StorageTrust, wire};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Semaphore, watch},
    time::timeout,
};
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};
type Error = Box<dyn std::error::Error + Send + Sync>;
static PEER_STAGE: AtomicU8 = AtomicU8::new(0);
fn stage_code() -> &'static str {
    match PEER_STAGE.load(Ordering::Relaxed) {
        0 => "inputs",
        1 => "initial_target",
        2 => "initial_connect",
        3 => "create_table",
        4 => "expiry_transaction",
        5 => "renewed_target",
        6 => "renewed_connect",
        7 => "rollback_readback",
        8 => "busy_transaction",
        9 => "busy_close",
        10 => "commit",
        11 => "idle_close",
        _ => "cleanup",
    }
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
fn read(path: &Path) -> Result<Vec<u8>, Error> {
    let meta = fs::symlink_metadata(path)?;
    let parent = path.parent().ok_or("peer parent missing")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.permissions().mode() & 0o777 != 0o600
        || fs::symlink_metadata(parent)?.file_type().is_symlink()
        || fs::metadata(parent)?.permissions().mode() & 0o777 != 0o700
        || meta.len() > 256 * 1024
    {
        return Err("peer custody refused".into());
    }
    Ok(fs::read(path)?)
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn uuid() -> Result<String, Error> {
    let mut b = [0u8; 16];
    SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| "peer randomness failed")?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let h = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
fn mac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}
fn signed(prefix: &str, domain: &str, claims: &Value, key: &[u8]) -> String {
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
    format!(
        "{prefix}.{body}.{}",
        URL_SAFE_NO_PAD.encode(mac(key, format!("{domain}{body}").as_bytes()))
    )
}
struct ActualPostgres {
    ca: Vec<u8>,
}
impl PostgresDial for ActualPostgres {
    fn dial<'a>(
        &'a self,
        target: &'a DatabaseTarget,
    ) -> BoxFuture<'a, Result<TlsStream<TcpStream>, Error>> {
        Box::pin(async move {
            if target.ca_sha256.as_deref() != Some(sha(&self.ca).as_str()) {
                return Err("actual PG CA pin changed".into());
            }
            transport::negotiate_tls(
                TcpStream::connect((target.address, target.port)).await?,
                &target.host,
                &self.ca,
            )
            .await
        })
    }
}
struct Issuer {
    pair: Ed25519KeyPair,
    scope: Value,
}
impl Issuer {
    fn token(&self, revision: u64, expires: u64) -> String {
        let now = control::now();
        let s = &self.scope;
        let p = &s["storage"];
        let f = &p["profile"];
        let claims = json!({"v":1,"kid":"fixture","database_id":s["database_id"],"generation":s["generation"],"authority_revision":revision,"storage_uid":p["storage_uid"],"node_uid":s["node_uid"],"volume_group_uuid":p["volume_group_uuid"],"pool_uuid":f["pool_uuid"],"profile_sha256":f["profile_sha256"],"volume_handle":p["volume_handle"],"lv_uuid":p["lv_uuid"],"pvc_uid":p["pvc_uid"],"pv_uid":p["pv_uid"],"pod_uid":s["pool_pod_uid"],"observed_at":now,"iat":now,"exp":expires,"guard_seconds":f["guard_seconds"],"drain_seconds":f["drain_seconds"],"write_allowed":true});
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signature = self
            .pair
            .sign(format!("{}{body}", wire("storageAuthorityDomain")).as_bytes());
        format!(
            "{}.{body}.{}",
            wire("storageAuthorityPrefix"),
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }
}
struct Client {
    socket: Socket,
    pending: Vec<u8>,
}
impl Client {
    async fn ready(&mut self, expected: u8) -> Result<Vec<String>, Error> {
        timeout(Duration::from_secs(5), async {
            let mut rows = Vec::new();
            loop {
                while self.pending.len() >= 5 {
                    let length =
                        u32::from_be_bytes(self.pending[1..5].try_into().unwrap()) as usize;
                    if !(4..=1024 * 1024).contains(&length) {
                        return Err::<Vec<String>, Error>("PG frame refused".into());
                    }
                    if self.pending.len() < length + 1 {
                        break;
                    }
                    let kind = self.pending[0];
                    let body = self.pending[5..length + 1].to_vec();
                    self.pending.drain(..length + 1);
                    match kind {
                        b'E' => return Err("actual PG query refused".into()),
                        b'R' if body != [0, 0, 0, 0] => {
                            return Err("fixture authentication changed".into());
                        }
                        b'Z' => {
                            if body != [expected] {
                                return Err("actual PG transaction state changed".into());
                            }
                            return Ok(rows);
                        }
                        b'D' => {
                            if body.len() < 6 || body[..2] != [0, 1] {
                                return Err("actual PG row shape changed".into());
                            }
                            let n = i32::from_be_bytes(body[2..6].try_into().unwrap());
                            if n < 0 || usize::try_from(n).ok() != Some(body.len() - 6) {
                                return Err("actual PG row refused".into());
                            }
                            rows.push(String::from_utf8(body[6..].to_vec())?);
                        }
                        _ => {}
                    }
                }
                match self.socket.next().await {
                    Some(Ok(Message::Binary(bytes))) => self.pending.extend(bytes),
                    Some(Ok(Message::Ping(bytes))) => {
                        self.socket.send(Message::Pong(bytes)).await?
                    }
                    _ => return Err("actual PG connection closed".into()),
                }
            }
        })
        .await?
    }
    async fn query(&mut self, sql: &str, state: u8) -> Result<Vec<String>, Error> {
        let mut bytes = vec![b'Q'];
        bytes.extend(u32::try_from(sql.len() + 5)?.to_be_bytes());
        bytes.extend(sql.as_bytes());
        bytes.push(0);
        self.socket.send(Message::Binary(bytes.into())).await?;
        self.ready(state).await
    }
    async fn closed(&mut self) -> Result<(), Error> {
        timeout(Duration::from_secs(5), async {
            loop {
                match self.socket.next().await {
                    None | Some(Ok(Message::Close(_))) | Some(Err(_)) => return Ok::<(), Error>(()),
                    Some(Ok(Message::Ping(bytes))) => {
                        self.socket.send(Message::Pong(bytes)).await?
                    }
                    _ => {}
                }
            }
        })
        .await?
    }
}
async fn connect(port: u16, scope: &Value, role: &str, key: &[u8]) -> Result<Client, Error> {
    let now = control::now() / 1000;
    let claims = json!({"v":4,"db":scope["database_id"],"user":role,"cid":uuid()?,"rg":scope["region_id"],"kid":"fixture","iat":now,"exp":now+30,"rev":scope["generation"],"pod":scope["pool_pod_uid"],"route_revision":scope["route_revision"],"kind":"pool","binding_id":scope["binding_id"],"node_uid":scope["node_uid"],"pod_ip":scope["pool_pod_ip"],"storage_generation":scope["storage"]["storage_generation"],"scope_sha256":pool::scope_hash(scope).ok_or("peer scope invalid")?});
    let route = signed(
        wire("admissionRouteTokenPrefix"),
        wire("admissionRouteSignatureDomain"),
        &claims,
        key,
    );
    let mut request = format!("ws://127.0.0.1:{port}/pg").into_client_request()?;
    request
        .headers_mut()
        .insert(wire("routeHeader"), route.parse()?);
    let (socket, _) = connect_async(request).await?;
    let mut client = Client {
        socket,
        pending: Vec::new(),
    };
    let data = format!(
        "user\0{role}\0database\0{}\0\0",
        scope["database_id"]
            .as_str()
            .ok_or("peer database absent")?
    );
    let mut bytes = u32::try_from(data.len() + 8)?.to_be_bytes().to_vec();
    bytes.extend(196610u32.to_be_bytes());
    bytes.extend(data.as_bytes());
    client.socket.send(Message::Binary(bytes.into())).await?;
    client.ready(b'I').await?;
    Ok(client)
}
async fn close_control(
    port: u16,
    scope: &Value,
    operation: &str,
    gateway_pod: &str,
    key: &[u8],
) -> Result<(u16, Value), Error> {
    let now = control::now() / 1000;
    let claims = json!({"v":1,"region":scope["region_id"],"database":scope["database_id"],"operation":operation,"revision":scope["generation"],"pod":gateway_pod,"action":"close","kid":"fixture","iat":now,"exp":now+30});
    let derived = mac(key, wire("controlKeyPurpose").as_bytes());
    let token = signed(
        wire("controlTokenPrefix"),
        wire("controlSigningPurpose"),
        &claims,
        &derived,
    );
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(format!("POST {}close HTTP/1.1\r\nHost: localhost\r\n{}: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",wire("controlPathPrefix"),wire("controlHeader")).as_bytes()).await?;
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes)).await??;
    if bytes.len() > 16 * 1024 {
        return Err("peer control response exceeds bound".into());
    }
    let at = bytes
        .windows(4)
        .position(|b| b == b"\r\n\r\n")
        .ok_or("peer control response absent")?;
    let status = std::str::from_utf8(&bytes[..at])?
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or("peer control status absent")?
        .parse()?;
    Ok((status, serde_json::from_slice(&bytes[at + 4..])?))
}
async fn run() -> Result<Value, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 7
        || args[1] != "--binding-file"
        || args[3] != "--ca-file"
        || args[5] != "--role-file"
    {
        return Err("peer filename flags required".into());
    }
    let mut binding: Value = serde_json::from_slice(&read(Path::new(&args[2]))?)?;
    let ca = read(Path::new(&args[4]))?;
    let role = String::from_utf8(read(Path::new(&args[6]))?)?
        .trim()
        .to_string();
    if !pgcf_native_protocol::valid_role(&role)
        || !pool::binding_valid(&binding)
        || binding["state"] != "serving"
    {
        return Err("peer initial inputs refused".into());
    }
    // The existing fixture has a Docker data volume: these thin fields test signature/expiry wiring only.
    // They are not a LVM/kernel mount claim and never leave this local conformance process.
    let mut thin = pool::CONTRACT["thin_scope"]["storage"].clone();
    let physical = binding["scope"]["storage"].clone();
    for (field, value) in physical.as_object().ok_or("peer storage invalid")? {
        if field != "backend" {
            thin[field] = value.clone();
        }
    }
    thin["volume_handle"] =
        format!("pvc-{}", thin["pvc_uid"].as_str().ok_or("peer PVC absent")?).into();
    thin["profile"]["node_uid"] = binding["scope"]["node_uid"].clone();
    thin["profile"]["volume_group_uuid"] = thin["volume_group_uuid"].clone();
    binding["scope"]["storage"] = thin;
    binding["scope_sha256"] = pool::scope_hash(&binding["scope"])
        .ok_or("peer scope invalid")?
        .into();
    let scope = binding["scope"].clone();
    let database = scope["database_id"]
        .as_str()
        .ok_or("peer database invalid")?
        .to_string();
    let mut route_key = [0u8; 32];
    SystemRandom::new()
        .fill(&mut route_key)
        .map_err(|_| "peer route randomness failed")?;
    let keyring = Keyring::parse(
        &json!({"active":"fixture","keys":{"fixture":URL_SAFE_NO_PAD.encode(route_key)}})
            .to_string(),
    )?;
    let pair = Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "peer authority randomness failed")?
            .as_ref(),
    )
    .map_err(|_| "peer authority key failed")?;
    let keys = json!({"fixture":URL_SAFE_NO_PAD.encode(pair.public_key().as_ref())}).to_string();
    let trust = StorageTrust::parse(&keys, &sha(keys.as_bytes()))?;
    let issuer = Issuer {
        pair,
        scope: scope.clone(),
    };
    let operation = format!(
        "op_{}",
        &scope["binding_id"]
            .as_str()
            .ok_or("peer binding absent")?
            .replace('-', "")[..20]
    );
    let gateway_pod = uuid()?;
    let node_name = "peer-pool-node";
    let labels = json!({"pgcf.io/database-id":database});
    let p = &scope["storage"];
    let volume = json!({"handle":p["volume_handle"],"claimUid":p["pvc_uid"],"volumeUid":p["pv_uid"],"lvUuid":p["lv_uuid"]});
    let storage = json!({"node":node_name,"namespaceUid":p["namespace_uid"],"clusterUid":p["cnpg_cluster_uid"],"storage":p["profile"]});
    let fence_uid = uuid()?;
    let ca_uid = uuid()?;
    let ca_hash = sha(&ca);
    let target = json!({"v":1,"generation":scope["generation"],"route_revision":scope["route_revision"],"admission_epoch":scope["admission_epoch"],"pod_uid":scope["pool_pod_uid"],"container_id":scope["container_id"],"ca_secret_uid":ca_uid,"ca_secret_resource_version":"1","ca_sha256":ca_hash,"tls_server_name":format!("database-rw.pgcf-db-{database}.svc")});
    let mut maps = vec![
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{database}"),"namespace":"pgcf-system","uid":p["storage_uid"],"labels":labels,"annotations":{"pgcf.io/volume-identity":volume.to_string(),"pgcf.io/gateway-fence-uid":fence_uid}},"data":{"state":storage.to_string(),wire("storageAuthorityLedgerKey"):issuer.token(1,control::now()+1500)}}),
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{database}"),"namespace":"pgcf-system","uid":fence_uid,"labels":labels},"data":{"power.json":json!({"anchor":{"storageUid":p["storage_uid"],"storageState":storage.to_string(),"volumeIdentity":volume.to_string(),"physicalGeneration":p["storage_generation"],"storage":p["profile"]}}).to_string(),"intent.json":json!({"database":database,"operation":operation,"revision":scope["generation"],"mode":"running"}).to_string(),"pool-binding.json":binding.to_string()}}),
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{database}"),"namespace":"pgcf-system","uid":uuid()?,"labels":labels,"annotations":{"pgcf.io/source-ca-secret-uid":ca_uid,"pgcf.io/source-ca-secret-resource-version":"1"}},"data":{"ca.crt":String::from_utf8(ca.clone())?}}),
    ];
    let ids = scope["container_ids"]
        .as_array()
        .ok_or("peer writer IDs absent")?;
    let statuses=ids.iter().map(|id|json!({"name":if id==&scope["container_id"]{"postgres"}else{"archiver"},"ready":true,"containerID":format!("containerd://{}",id.as_str().unwrap()),"imageID":format!("fixture/postgres@sha256:{}",scope["class"]["postgres_image_sha256"].as_str().unwrap()),"state":{"running":{"startedAt":"2026-10-14T00:00:00Z"}}})).collect::<Vec<_>>();
    let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":"pgcf-pool","name":scope["pool_pod_name"],"uid":scope["pool_pod_uid"],"resourceVersion":"1","labels":{"app.kubernetes.io/name":"pgcf-pool"}},"spec":{"nodeName":node_name},"status":{"podIP":scope["pool_pod_ip"],"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":statuses}});
    let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":node_name,"uid":scope["node_uid"],"resourceVersion":"1"},"status":{"nodeInfo":{"bootID":scope["boot_id"]},"conditions":[{"type":"Ready","status":"True"}]}});
    let gateway = Gateway::new(
        Arc::new(Config {
            region: scope["region_id"].as_str().unwrap().into(),
            keyring,
            maximum_memory: 128 * 1024 * 1024,
            database_memory: 96 * 1024 * 1024,
        }),
        gateway_pod.clone(),
        Arc::new(ActualPostgres { ca }),
    );
    gateway
        .fences
        .write()
        .await
        .replace(std::collections::HashMap::from([(
            database.clone(),
            Fence {
                uid: fence_uid,
                intent: Intent {
                    database: database.clone(),
                    operation: operation.clone(),
                    revision: scope["generation"].as_u64().unwrap(),
                    mode: "running".into(),
                },
                retired_at: None,
                deleting: false,
                admission_target: Some(serde_json::from_value(target)?),
            },
        )]))
        .unwrap();
    {
        let mut targets = gateway.targets.write().await;
        *targets = Targets::default();
        targets.enable_pool(true);
        targets.replace("endpointslices", &[], Some(&trust))?;
        targets.replace("poolnodes", &[node], Some(&trust))?;
        targets.replace("poolpods", &[pod], Some(&trust))?;
        targets.replace("configmaps", &maps, Some(&trust))?;
        PEER_STAGE.store(1, Ordering::Relaxed);
        targets
            .target(&database, control::now())
            .map_err(|reason| format!("target_refused:{}", reason.code()))?;
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let (stop, mut shutdown) = watch::channel(false);
    let server = tokio::spawn({
        let gateway = gateway.clone();
        async move {
            let permits = Arc::new(Semaphore::new(8));
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                tokio::select! {_=shutdown.changed()=>break,accepted=listener.accept()=>{let(socket,_)=accepted.unwrap();let gateway=gateway.clone();let signal=shutdown.clone();let permit=permits.clone().acquire_owned().await.unwrap();tasks.spawn(async move{let _=transport::serve_socket(socket,gateway,signal,permit).await;});}}
            }
            tasks.abort_all();
        }
    });
    PEER_STAGE.store(2, Ordering::Relaxed);
    let mut client = connect(port, &scope, &role, &route_key).await?;
    PEER_STAGE.store(3, Ordering::Relaxed);
    client
        .query("CREATE TABLE peer_commit(value integer)", b'I')
        .await?;
    PEER_STAGE.store(4, Ordering::Relaxed);
    client.query("BEGIN", b'T').await?;
    client
        .query("INSERT INTO peer_commit VALUES(1)", b'T')
        .await?;
    client.closed().await?;
    PEER_STAGE.store(5, Ordering::Relaxed);
    maps[0]["data"][wire("storageAuthorityLedgerKey")] = issuer
        .token(
            2,
            control::now()
                + scope["storage"]["profile"]["guard_seconds"]
                    .as_u64()
                    .ok_or("peer guard absent")?
                    * 1000,
        )
        .into();
    gateway
        .targets
        .write()
        .await
        .replace("configmaps", &maps, Some(&trust))?;
    PEER_STAGE.store(6, Ordering::Relaxed);
    let mut client = connect(port, &scope, &role, &route_key).await?;
    PEER_STAGE.store(7, Ordering::Relaxed);
    if client
        .query("SELECT count(*)::text FROM peer_commit", b'I')
        .await?
        != ["0"]
    {
        return Err("uncommitted expired transaction was replayed".into());
    }
    client.query("BEGIN", b'T').await?;
    client
        .query("INSERT INTO peer_commit VALUES(7)", b'T')
        .await?;
    PEER_STAGE.store(8, Ordering::Relaxed);
    binding["state"] = "detaching".into();
    binding["holder_revision"] = 2.into();
    binding["updated_at"] = control::now().into();
    maps[1]["data"]["pool-binding.json"] = binding.to_string().into();
    gateway
        .targets
        .write()
        .await
        .replace("configmaps", &maps, Some(&trust))?;
    PEER_STAGE.store(9, Ordering::Relaxed);
    let (status, busy) = close_control(port, &scope, &operation, &gateway_pod, &route_key).await?;
    if status != 200 || busy["busyConnections"] != 1 || busy["mode"] != "running" {
        return Err("running pool busy close refused or forced".into());
    }
    PEER_STAGE.store(10, Ordering::Relaxed);
    client.query("COMMIT", b'I').await?;
    if client
        .query("SELECT count(*)::text FROM peer_commit WHERE value=7", b'I')
        .await?
        != ["1"]
    {
        return Err("actual committed row readback failed".into());
    }
    PEER_STAGE.store(11, Ordering::Relaxed);
    let (status, idle) = close_control(port, &scope, &operation, &gateway_pod, &route_key).await?;
    if status != 200 || idle["busyConnections"] != 0 || idle["connections"] != 0 {
        return Err("running pool idle close refused".into());
    }
    client.closed().await?;
    let _ = stop.send(true);
    server.await?;
    Ok(
        json!({"gateway_pool_expiry_disconnect":"passed","expired_transaction_replay":"absent","busy_detach_commit":"passed","committed_row_readback":"passed","idle_close":"passed","kernel_mount_acceptance":false,"cloudflare_first_sql_acceptance":false}),
    )
}
#[tokio::main]
async fn main() {
    match run().await {
        Ok(value) => println!("{value}"),
        Err(error) => {
            let selected = error.to_string();
            let code = if matches!(
                selected.as_str(),
                "running pool busy close refused or forced"
                    | "running pool idle close refused"
                    | "actual committed row readback failed"
                    | "uncommitted expired transaction was replayed"
                    | "target_refused:discovery_unavailable"
                    | "target_refused:writer_identity_unavailable"
                    | "target_refused:storage_authority_missing"
                    | "target_refused:storage_authority_invalid"
                    | "target_refused:storage_authority_scope_or_freshness_changed"
                    | "target_refused:storage_authority_regressed_or_conflicted"
                    | "target_refused:storage_authority_expired"
                    | "target_refused:storage_authority_refused"
            ) {
                selected.as_str()
            } else {
                "peer_refused"
            };
            eprintln!(
                "{}",
                json!({"gateway_pool_peer":"failed","code":code,"stage":stage_code()})
            );
            std::process::exit(1);
        }
    }
}
