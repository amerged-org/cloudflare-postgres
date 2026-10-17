// SPDX-License-Identifier: Apache-2.0
//! A complete in-process world around one database for the power, pool and reconcile tests: its
//! Kubernetes objects in the API double, a gateway control and exporter endpoint, and a
//! PostgreSQL socket. The controller's real code runs against it; nothing here is product code.
use crate::{
    api::DesiredSnapshot,
    contracts::{namespace, present_roles, text},
    manifests,
    reconcile::Reconciler,
    test_postgres::{Answer, Authority, Cell, Handler, Instant, Login, Postgres},
    test_server::{Server, uid},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

pub const NODE: &str = "native-test-node";
pub const SYSTEM: &str = "pgcf-system";
pub const IMAGE: &str = "registry.test/postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
pub const POD_IP: &str = "10.0.0.7";
/// The Pod UID of the instance Pod and the UIDs of the objects around it.
pub fn kube_system() -> String {
    uid(1)
}
pub fn namespace_uid() -> String {
    uid(2)
}
pub fn cluster_uid() -> String {
    uid(3)
}
pub fn storage_uid() -> String {
    uid(4)
}
pub fn node_uid() -> String {
    uid(5)
}
pub fn claim_uid() -> String {
    uid(6)
}
pub fn volume_uid() -> String {
    uid(7)
}
pub fn lvm_uid() -> String {
    uid(8)
}
pub fn pod_uid() -> String {
    uid(9)
}
pub fn gateway_uid() -> String {
    uid(20)
}
pub const POSTGRES_CONTAINER: &str =
    "containerd://1111111111111111111111111111111111111111111111111111111111111111";
pub const SIDECAR_CONTAINER: &str =
    "containerd://2222222222222222222222222222222222222222222222222222222222222222";
pub const BOOT_ID: &str = "01234567-89ab-4def-8123-0000000000b1";
pub const HANDLE: &str = "pvc-01234567-89ab-4def-8123-000000000006";

/// The gateway Pod's control endpoint and the instance Pod's exporter, behind an HTTP proxy.
pub struct Gateway {
    pub client: reqwest::Client,
    /// The proxy every node and gateway request of `client` goes to.
    pub address: std::net::SocketAddr,
    /// The text `GET /metrics` answers.
    pub metrics: Arc<Mutex<String>>,
    /// The UID of the gateway Pod the control endpoint answers for.
    pub pod: Arc<Mutex<String>>,
    /// How many releases the endpoint still refuses with 409 `control_intent_mismatch`, as a
    /// gateway does until its watch has seen the intent the controller wrote.
    pub refuse_releases: Arc<Mutex<u32>>,
    /// The wake long-poll and the wake results of the gateways (pool design 2026-10-16).
    pub wake: Arc<Mutex<WakeDouble>>,
    /// The node agent `pgcf-attach` of the world's node.
    pub agent: Arc<Mutex<AgentDouble>>,
    task: tokio::task::JoinHandle<()>,
}
/// One device-mapper device of the agent double.
#[derive(Clone, Debug)]
pub struct Device {
    pub dm_uuid: String,
    /// Opens other than the slot mounts the agent made: a database's own Pod.
    pub opens: u32,
    pub suspended: bool,
    /// What its `pg_control` says while no PostgreSQL runs on it.
    pub control: crate::attach_protocol::Control,
    /// The slot namespace and the containers the volume was moved into.
    pub attached: Option<(String, Vec<String>)>,
}
/// The node agent double: device-mapper devices by LV UUID and the holder files, enforcing the
/// single-writer rule as the agent does. A slot mount counts as an open while the slot's
/// namespace exists in the API double.
#[derive(Default)]
pub struct AgentDouble {
    pub devices: HashMap<String, Device>,
    pub holders: BTreeMap<String, String>,
    pub boot_id: String,
    /// Every request, as `<action> <answer>`.
    pub calls: Vec<String>,
    /// How many releases answer `release_timeout` first, as while a slot Pod's teardown takes
    /// longer than the release waits.
    pub release_timeouts: u32,
    /// What happens to the API objects right after a successful attach (once).
    pub after_attach: Option<AfterAttach>,
}
pub type AfterAttach = Box<dyn FnOnce(&mut crate::test_server::State) + Send>;
fn agent_answer(
    agent: &Arc<Mutex<AgentDouble>>,
    objects: &Arc<Mutex<crate::test_server::State>>,
    action: &str,
    token: Option<&str>,
    body: &[u8],
) -> (u16, Value) {
    use crate::attach_protocol::{self as attach, Action};
    let refuse = |code: &str| {
        let status = match code {
            "invalid" => 400,
            "denied" => 401,
            "busy" | "keys_unavailable" | "unsupported_platform" => 503,
            _ => 409,
        };
        (status, json!({"error":code}))
    };
    let Some(action) = Action::from_path(&format!("/v1/{action}")) else {
        return refuse("invalid");
    };
    let keys = attach::Keys::derive(
        "eu-test",
        "local",
        &HashMap::from([("local".to_string(), vec![7_u8; 32])]),
    )
    .unwrap();
    if token
        .map(|token| attach::verify(token, &keys, NODE, action, now_ms()))
        .is_none_or(|claims| claims.is_err())
    {
        return refuse("denied");
    }
    let state = objects.lock().unwrap();
    let exists = |kind: &str, ns: Option<&str>, name: &str| {
        state
            .objects
            .contains_key(&crate::test_server::path(kind, ns, name))
    };
    let fenced = |ns: &str| {
        state
            .objects
            .get(&crate::test_server::path("Cluster", Some(ns), "database"))
            .is_some_and(crate::power::fenced)
    };
    let live = |container: &str| {
        state.objects.values().any(|object| {
            object["kind"] == "Pod"
                && object["metadata"]["deletionTimestamp"].is_null()
                && ["containerStatuses", "initContainerStatuses"]
                    .iter()
                    .any(|key| {
                        object["status"][*key].as_array().is_some_and(|all| {
                            all.iter().any(|c| {
                                text(c, "containerID") == format!("containerd://{container}")
                            })
                        })
                    })
        })
    };
    let mut agent = agent.lock().unwrap();
    let open_count = |device: &Device| {
        device.opens
            + u32::from(
                device
                    .attached
                    .as_ref()
                    .is_some_and(|(ns, _)| exists("Namespace", None, ns)),
            )
    };
    let boot = agent.boot_id.clone();
    match action {
        Action::Attach => {
            let Ok(request) = serde_json::from_slice::<attach::AttachRequest>(body) else {
                return refuse("invalid");
            };
            if !request.valid() {
                return refuse("invalid");
            }
            let lv = request.volume.lv_uuid.clone();
            let Some(device) = agent.devices.get(&lv).cloned() else {
                return refuse("volume_missing");
            };
            if device.dm_uuid != request.volume.dm_uuid() {
                return refuse("uuid_mismatch");
            }
            if device.suspended {
                return refuse("volume_suspended");
            }
            if open_count(&device) != 0 {
                return refuse("volume_open");
            }
            if agent.holders.contains_key(&lv) {
                return refuse("holder_busy");
            }
            let holder = format!("slot:{}:{boot}", request.pod_uid);
            agent.holders.insert(lv.clone(), holder.clone());
            if !device.control.shut_down() {
                agent.holders.remove(&lv);
                return refuse("unclean");
            }
            if !request.containers.iter().all(|c| live(c)) {
                agent.holders.remove(&lv);
                return refuse("container_missing");
            }
            let ns = state
                .objects
                .values()
                .find(|object| object["metadata"]["uid"] == request.pod_uid.as_str())
                .and_then(|pod| pod["metadata"]["namespace"].as_str())
                .unwrap_or("")
                .to_string();
            agent.devices.get_mut(&lv).unwrap().attached = Some((ns, request.containers.clone()));
            (
                200,
                serde_json::to_value(attach::AttachResponse {
                    holder,
                    control: device.control.clone(),
                    attached: request.containers,
                    steps_us: BTreeMap::from([("total".to_string(), 900)]),
                })
                .unwrap(),
            )
        }
        Action::Hold => {
            let Ok(request) = serde_json::from_slice::<attach::HoldRequest>(body) else {
                return refuse("invalid");
            };
            let lv = request.volume.lv_uuid.clone();
            let record = request.holder.record(&boot);
            if agent.holders.get(&lv) == Some(&record) {
                return (200, json!({"holder":record,"created":false}));
            }
            if agent.holders.contains_key(&lv) {
                return refuse("holder_busy");
            }
            let Some(device) = agent.devices.get(&lv) else {
                return refuse("volume_missing");
            };
            if device.dm_uuid != request.volume.dm_uuid() {
                return refuse("uuid_mismatch");
            }
            if device.suspended {
                return refuse("volume_suspended");
            }
            if open_count(device) != 0 {
                return refuse("volume_open");
            }
            agent.holders.insert(lv, record.clone());
            (200, json!({"holder":record,"created":true}))
        }
        Action::Release => {
            let Ok(request) = serde_json::from_slice::<attach::ReleaseRequest>(body) else {
                return refuse("invalid");
            };
            let lv = request.volume.lv_uuid.clone();
            let Some(held) = agent.holders.get(&lv).cloned() else {
                return (200, json!({"released":false,"waited_ms":0}));
            };
            if held != request.holder.record(&boot) {
                return refuse("holder_mismatch");
            }
            if agent.release_timeouts > 0 {
                agent.release_timeouts -= 1;
                return refuse("release_timeout");
            }
            if agent.devices.get(&lv).is_some_and(|d| open_count(d) != 0) {
                return refuse("release_timeout");
            }
            agent.holders.remove(&lv);
            if let Some(device) = agent.devices.get_mut(&lv) {
                device.attached = None;
            }
            (200, json!({"released":true,"waited_ms":0}))
        }
        Action::Inspect => {
            let Ok(request) = serde_json::from_slice::<attach::InspectRequest>(body) else {
                return refuse("invalid");
            };
            // The agent refuses a container ID that is not 64 lowercase hexadecimal digits.
            if request.postgres_container.as_deref().is_some_and(|id| {
                id.len() != 64
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) {
                return refuse("invalid");
            }
            let lv = request.volume.lv_uuid.clone();
            let Some(device) = agent.devices.get(&lv) else {
                return (
                    200,
                    json!({"exists":false,"open_count":0,"suspended":false,"holder":null,"control":null,"postmaster_running":null}),
                );
            };
            let (mut control, mut running) = (Value::Null, Value::Null);
            if let Some(container) = &request.postgres_container {
                let Some((ns, _)) = device
                    .attached
                    .as_ref()
                    .filter(|(ns, ids)| ids.contains(container) && exists("Namespace", None, ns))
                    .filter(|_| live(container))
                else {
                    return refuse("container_missing");
                };
                let stopped = fenced(ns);
                let mut seen = device.control.clone();
                if !stopped {
                    seen.state = 6;
                }
                control = serde_json::to_value(seen).unwrap();
                running = (!stopped).into();
            }
            (
                200,
                json!({"exists":true,"open_count":open_count(device),"suspended":device.suspended,"holder":agent.holders.get(&lv),"control":control,"postmaster_running":running}),
            )
        }
        Action::Holders => (
            200,
            json!({"boot_id":boot,"holders":agent.holders.iter().map(|(lv,holder)|json!({"lv_uuid":lv,"holder":holder})).collect::<Vec<_>>()}),
        ),
    }
}
/// What the gateways' wake endpoints hold and received.
#[derive(Default)]
pub struct WakeDouble {
    /// The gateway Pod UID by address; an address not here answers for `Gateway::pod`.
    pub pods: HashMap<String, String>,
    /// Wakes queued per gateway address, delivered by its next poll.
    pub queued: HashMap<String, Vec<pgcf_native_protocol::wake::WakeRequest>>,
    /// Addresses whose gateway predates the wake poll: it answers 404.
    pub old: std::collections::HashSet<String>,
    /// Every accepted poll, as (address, gateway Pod UID).
    pub polls: Vec<(String, String)>,
    /// Every wake result, as (address, body).
    pub results: Vec<(String, Value)>,
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap()
}
impl Gateway {
    async fn start(
        log: Arc<Mutex<Vec<String>>>,
        objects: Arc<Mutex<crate::test_server::State>>,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .retry(reqwest::retry::never())
            .build()
            .unwrap();
        let metrics: Arc<Mutex<String>> = Arc::default();
        let served = metrics.clone();
        let pod = Arc::new(Mutex::new(gateway_uid()));
        let current = pod.clone();
        let refuse_releases: Arc<Mutex<u32>> = Arc::default();
        let refusing = refuse_releases.clone();
        let wake: Arc<Mutex<WakeDouble>> = Arc::default();
        let waking = wake.clone();
        let agent: Arc<Mutex<AgentDouble>> = Arc::new(Mutex::new(AgentDouble {
            boot_id: BOOT_ID.into(),
            ..AgentDouble::default()
        }));
        let attaching = agent.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (served, log, current, refusing, waking, attaching, objects) = (
                    served.clone(),
                    log.clone(),
                    current.clone(),
                    refusing.clone(),
                    waking.clone(),
                    attaching.clone(),
                    objects.clone(),
                );
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let mut byte = [0];
                    while !bytes.ends_with(b"\r\n\r\n") {
                        if socket.read_exact(&mut byte).await.is_err() {
                            return;
                        }
                        bytes.push(byte[0]);
                    }
                    let header = String::from_utf8(bytes).unwrap();
                    let target = header
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_string();
                    let action = target.rsplit('/').next().unwrap().to_string();
                    // The proxy request names the address it is for: `http://<ip>:<port>/<path>`.
                    let address = target
                        .strip_prefix("http://")
                        .and_then(|rest| rest.rsplit_once(':').map(|(host, _)| host))
                        .unwrap_or("")
                        .trim_matches(|c| c == '[' || c == ']')
                        .to_string();
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .map(|(_, value)| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    let mut body = vec![0; length];
                    if socket.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let reply = |status: u16, body: String| {
                        format!(
                            "HTTP/1.1 {status} X\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        )
                    };
                    if target.contains(":8081/v1/") {
                        let token = header.lines().find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| {
                                    name.eq_ignore_ascii_case(crate::attach_protocol::HEADER)
                                })
                                .map(|(_, value)| value.trim().to_string())
                        });
                        let (status, answer) =
                            agent_answer(&attaching, &objects, &action, token.as_deref(), &body);
                        if action == "attach" && status == 200 {
                            let after = attaching.lock().unwrap().after_attach.take();
                            if let Some(after) = after {
                                after(&mut objects.lock().unwrap());
                            }
                        }
                        let line = format!(
                            "AGENT {action} {}",
                            answer["error"].as_str().unwrap_or("ok")
                        );
                        attaching.lock().unwrap().calls.push(line.clone());
                        log.lock().unwrap().push(line);
                        let _ = socket
                            .write_all(reply(status, answer.to_string()).as_bytes())
                            .await;
                        return;
                    }
                    if action == "wakes" || action == "wake-result" {
                        let (pod, old) = {
                            let state = waking.lock().unwrap();
                            (
                                state
                                    .pods
                                    .get(&address)
                                    .cloned()
                                    .unwrap_or_else(|| current.lock().unwrap().clone()),
                                state.old.contains(&address),
                            )
                        };
                        if old {
                            let _ = socket
                                .write_all(
                                    reply(404, "{\"error\":\"unknown_action\"}".into()).as_bytes(),
                                )
                                .await;
                            return;
                        }
                        let token = header.lines().find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| {
                                    name.eq_ignore_ascii_case(
                                        pgcf_native_protocol::wake::POLL_HEADER,
                                    )
                                })
                                .map(|(_, value)| value.trim().to_string())
                        });
                        let keys = HashMap::from([("local".to_string(), vec![7_u8; 32])]);
                        if pgcf_native_protocol::wake::verify_poll(
                            token.as_deref(),
                            &keys,
                            "eu-test",
                            &pod,
                            &action,
                            now_ms(),
                        )
                        .is_none()
                        {
                            let _ = socket
                                .write_all(
                                    reply(401, "{\"error\":\"wake_denied\"}".into()).as_bytes(),
                                )
                                .await;
                            return;
                        }
                        if action == "wake-result" {
                            let result: Value = serde_json::from_slice(&body).unwrap();
                            log.lock().unwrap().push(
                                format!(
                                    "GATEWAY wake-result {} {}",
                                    result["outcome"].as_str().unwrap_or(""),
                                    result["reason"].as_str().unwrap_or("")
                                )
                                .trim_end()
                                .to_string(),
                            );
                            waking.lock().unwrap().results.push((address, result));
                            let _ = socket.write_all(reply(200, "{}".into()).as_bytes()).await;
                            return;
                        }
                        assert!(body.is_empty(), "a wake poll has no body");
                        // An empty poll is held a moment, as the gateway holds it until a wake.
                        let mut held = 0;
                        waking
                            .lock()
                            .unwrap()
                            .polls
                            .push((address.clone(), pod.clone()));
                        let wakes = loop {
                            let wakes = waking
                                .lock()
                                .unwrap()
                                .queued
                                .remove(&address)
                                .unwrap_or_default();
                            if !wakes.is_empty() || held >= 5 {
                                break wakes;
                            }
                            held += 1;
                            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        };
                        let answer = pgcf_native_protocol::wake::WakePoll { pod, wakes };
                        let _ = socket
                            .write_all(
                                reply(200, serde_json::to_string(&answer).unwrap()).as_bytes(),
                            )
                            .await;
                        return;
                    }
                    if action == "metrics" {
                        let body = served.lock().unwrap().clone();
                        let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                        let _ = socket.shutdown().await;
                        return;
                    }
                    let token = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| {
                                    name.eq_ignore_ascii_case(pgcf_native_protocol::wire(
                                        "controlHeader",
                                    ))
                                })
                                .map(|(_, value)| value.trim().to_string())
                        })
                        .unwrap();
                    let keys = HashMap::from([("local".to_string(), vec![7_u8; 32])]);
                    let pod = current.lock().unwrap().clone();
                    let claims = pgcf_native_protocol::scoped_tokens::control(
                        &token,
                        &keys,
                        "eu-test",
                        &pod,
                        &action,
                        now_ms(),
                    )
                    .unwrap();
                    if action == "release" && {
                        let mut left = refusing.lock().unwrap();
                        let refuse = *left > 0;
                        *left = left.saturating_sub(1);
                        refuse
                    } {
                        log.lock()
                            .unwrap()
                            .push("GATEWAY release refused".to_string());
                        let body = r#"{"error":"control_intent_mismatch"}"#;
                        let _ = socket.write_all(format!("HTTP/1.1 409 Conflict\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                        let _ = socket.shutdown().await;
                        return;
                    }
                    log.lock().unwrap().push(format!("GATEWAY {action}"));
                    let (mode, status) = if action == "release" {
                        ("running", "running")
                    } else {
                        ("quiesce", "closed")
                    };
                    let body=json!({"database":claims["database"],"operation":claims["operation"],"revision":claims["revision"],"mode":mode,"pod":pod,"status":status,"connections":0,"busyConnections":0,"pendingDials":0}).to_string();
                    let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self {
            client,
            address,
            metrics,
            pod,
            refuse_releases,
            wake,
            agent,
            task,
        }
    }
    pub fn fenced(&self, on: bool) {
        *self.metrics.lock().unwrap() = format!(
            "# HELP cnpg_collector_fencing_on 1 if the instance is fenced, 0 otherwise\n# TYPE cnpg_collector_fencing_on gauge\ncnpg_collector_fencing_on {}\n",
            u8::from(on)
        );
    }
}

/// What the catalogs of the PostgreSQL double hold of one role.
#[derive(Clone, Debug)]
pub struct RoleRow {
    /// `rolcanlogin`.
    pub login: bool,
    /// `rolvaliduntil`: `None` is NULL.
    pub valid_until: Option<Instant>,
    /// `rolconnlimit`: `-1` is no limit.
    pub connection_limit: i32,
    /// `rolbypassrls`.
    pub bypass_rls: bool,
    /// The names of the roles it is a member of.
    pub member_of: Vec<String>,
    /// The `pg_shdepend` rows that depend on it.
    pub dependencies: i64,
    /// Its client backends in `pg_stat_activity`.
    pub sessions: i64,
}
impl Default for RoleRow {
    /// A plain role: it logs in, never expires, has no limit, no membership and no object.
    fn default() -> Self {
        Self {
            login: true,
            valid_until: None,
            connection_limit: -1,
            bypass_rls: false,
            member_of: vec![],
            dependencies: 0,
            sessions: 0,
        }
    }
}
/// What the PostgreSQL double answers; tests change it between passes.
#[derive(Clone)]
pub struct Sql {
    pub busy: i32,
    pub prepared: i32,
    /// The closed segment `pg_switch_wal()` reports and whether its `.done` exists. WAL file names
    /// are upper-case hexadecimal, so a name without a letter would hide a validator that rejects
    /// them.
    pub segment: String,
    pub archived: bool,
    pub postmaster_age_ms: i64,
    /// `pg_control_system().system_identifier` of the data directory the postmaster runs on.
    pub system_identifier: String,
    /// `pg_control_checkpoint().timeline_id`.
    pub timeline: i32,
    pub recovery: bool,
    /// What happens in the cluster while PostgreSQL answers a statement, by the statement's name in
    /// the log (`accepting`, `role login`, `archive`): the change lands before the answer does, so
    /// the controller's next read sees it.
    pub during: HashMap<&'static str, Arc<dyn Fn() + Send + Sync>>,
    /// The roles of the database by name, as `pg_roles` and its neighbours hold them. A role that
    /// is not here does not exist in PostgreSQL.
    pub roles: BTreeMap<String, RoleRow>,
    /// Roles whose startup PostgreSQL refuses, with the SQLSTATE and message of the FATAL.
    pub refused: BTreeMap<String, (&'static str, &'static str)>,
    /// The maintenance role does not hold `pg_signal_backend`: ending a session is refused.
    pub signal_denied: bool,
    /// An ended backend takes its time to leave `pg_stat_activity`.
    pub sessions_linger: bool,
}
impl Default for Sql {
    fn default() -> Self {
        Self {
            busy: 0,
            prepared: 0,
            segment: "0000000100000000000000A7".into(),
            archived: true,
            postmaster_age_ms: 5,
            system_identifier: "7430000000000000001".into(),
            timeline: 1,
            recovery: false,
            during: HashMap::new(),
            roles: BTreeMap::new(),
            refused: BTreeMap::new(),
            signal_denied: false,
            sessions_linger: false,
        }
    }
}
/// The LSN `pg_switch_wal()` returns when it closed `segment`: the first byte after it, in
/// PostgreSQL's `pg_lsn` text form (`<log>/<offset>`, upper-case hexadecimal).
fn lsn_after(segment: &str) -> String {
    let log = u64::from_str_radix(&segment[8..16], 16).unwrap();
    let number = u64::from_str_radix(&segment[16..24], 16).unwrap();
    format!("{log:X}/{:X}", (number + 1) * 0x100_0000)
}
/// The server address column of a statement, as PostgreSQL returns the select-list expression
/// the statement holds: `host()` prints the address alone, a cast to `text` keeps the netmask the
/// `inet` carries (`10.0.0.7/32`), and the bare `inet` is a binary value no text decode accepts.
fn server_address(sql: &str, ip: &str) -> Cell {
    let plain = sql.replace("pg_catalog.", "");
    if plain.contains("host(inet_server_addr())") {
        Cell::Text(ip.into())
    } else if plain.contains("inet_server_addr()::text") {
        Cell::Text(format!("{ip}/32"))
    } else {
        Cell::Inet(ip.into())
    }
}
/// PostgreSQL answers only while its instance is unfenced: CNPG's instance manager does not
/// start it before the fence annotation is gone. Every cell has the type and the text form the
/// real server gives the statement's expression (see `test_postgres`).
fn answers(
    db: Value,
    state: Arc<Mutex<Sql>>,
    fenced: Arc<dyn Fn() -> bool + Send + Sync>,
    log: Arc<Mutex<Vec<String>>>,
    (who, ip): (&'static str, &'static str),
) -> Handler {
    Arc::new(move |sql: &str, parameters: &[String], user: &str| {
        let s = state.lock().unwrap().clone();
        if fenced() {
            return Answer::Error("57P03", "the database system is starting up");
        }
        // The role a role statement is bound to; a statement being described has no parameter.
        let role = parameters.first().map(String::as_str);
        let kind = if sql.contains("pg_postmaster_start_time") {
            "accepting".to_string()
        } else if sql.contains("pg_control_system") {
            "server identity".to_string()
        } else if sql.contains("current_setting('server_version')") {
            "role login".to_string()
        } else if sql.contains("pg_stat_archiver") {
            "archive".to_string()
        } else if sql.contains("pg_terminate_backend") {
            format!("role terminate {}", role.unwrap_or(""))
        } else if sql.contains("rolvaliduntil") {
            format!("role attributes {}", role.unwrap_or(""))
        } else if sql.contains("WHERE member.rolname = $1") {
            format!("role memberships {}", role.unwrap_or(""))
        } else if sql.contains("pg_shdepend") {
            format!("role dependencies {}", role.unwrap_or(""))
        } else if sql.contains("FROM pg_catalog.pg_stat_activity WHERE usename = $1") {
            format!("role sessions {}", role.unwrap_or(""))
        } else {
            sql.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
        };
        log.lock()
            .unwrap()
            .push(format!("{who} {user} {kind}").trim_end().to_string());
        if let Some(during) = s.during.get(kind.as_str()) {
            during();
        }
        let text = |v: &str| Cell::Text(v.to_string());
        let name = |v: &str| Cell::Name(v.to_string());
        let one = |row: Vec<(&'static str, Cell)>| Answer::Rows(vec![row]);
        let id = crate::contracts::text(&db, "id");
        let size = &db["size"];
        let memory = crate::contracts::number(size, "memory_mib");
        let request = crate::contracts::optional_number(size, "memory_request_mib", memory);
        if sql.contains("rolvaliduntil") {
            // A role's row by name: no row for a role PostgreSQL does not have. A statement being
            // described has no parameter and answers with a row for its layout.
            let row = |at: &str, held: &RoleRow| {
                vec![
                    ("rolname", name(at)),
                    ("rolcanlogin", Cell::Bool(held.login)),
                    (
                        "rolvaliduntil",
                        held.valid_until
                            .map_or(Cell::Null(Cell::TIMESTAMPTZ), Cell::Timestamptz),
                    ),
                    ("rolconnlimit", Cell::Int4(held.connection_limit)),
                    ("rolbypassrls", Cell::Bool(held.bypass_rls)),
                ]
            };
            match role {
                None => one(row("described", &RoleRow::default())),
                Some(at) => Answer::Rows(
                    s.roles
                        .get(at)
                        .map(|held| vec![row(at, held)])
                        .unwrap_or_default(),
                ),
            }
        } else if sql.contains("WHERE member.rolname = $1") {
            // One `name` per role it is a member of.
            match role {
                None => one(vec![("rolname", name("described"))]),
                Some(at) => Answer::Rows(
                    s.roles
                        .get(at)
                        .map(|held| {
                            held.member_of
                                .iter()
                                .map(|granted| vec![("rolname", name(granted))])
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
            }
        } else if sql.contains("pg_shdepend") {
            let count = role
                .and_then(|at| s.roles.get(at))
                .map_or(0, |held| held.dependencies);
            one(vec![("count", Cell::Int8(count))])
        } else if sql.contains("pg_terminate_backend") {
            match role {
                None => one(vec![("pg_terminate_backend", Cell::Bool(true))]),
                Some(at) => {
                    let sessions = s.roles.get(at).map_or(0, |held| held.sessions);
                    if sessions > 0 && s.signal_denied {
                        // Only a backend that is there to be ended raises it.
                        return Answer::Error("42501", "permission denied to terminate process");
                    }
                    if !s.sessions_linger
                        && let Some(held) = state.lock().unwrap().roles.get_mut(at)
                    {
                        held.sessions = 0;
                    }
                    Answer::Rows(
                        (0..sessions)
                            .map(|_| vec![("pg_terminate_backend", Cell::Bool(true))])
                            .collect(),
                    )
                }
            }
        } else if sql.contains("FROM pg_catalog.pg_stat_activity WHERE usename = $1") {
            let count = role
                .and_then(|at| s.roles.get(at))
                .map_or(0, |held| held.sessions);
            one(vec![("count", Cell::Int8(count))])
        } else if sql.contains("pg_stat_clear_snapshot") {
            one(vec![("pg_stat_clear_snapshot", Cell::Void)])
        } else if sql.contains("pg_prepared_xacts") {
            one(vec![
                ("busy", Cell::Int4(s.busy)),
                ("prepared", Cell::Int4(s.prepared)),
            ])
        } else if sql.contains("pg_switch_wal") {
            one(vec![
                ("lsn", text(&lsn_after(&s.segment))),
                ("segment", text(&s.segment)),
            ])
        } else if sql.contains("pg_ls_archive_statusdir() WHERE name=$1") {
            let _ = parameters;
            one(vec![("done", Cell::Bool(s.archived))])
        } else if sql.contains("pg_postmaster_start_time") {
            one(vec![
                ("database", name(id)),
                ("recovery", Cell::Bool(s.recovery)),
                ("tls", Cell::Bool(true)),
                ("server_address", server_address(sql, ip)),
                ("postmaster_age_ms", Cell::Int8(s.postmaster_age_ms)),
                ("system_identifier", text(&s.system_identifier)),
                ("timeline", Cell::Int4(s.timeline)),
            ])
        } else if sql.contains("pg_control_system") {
            one(vec![
                ("system_identifier", text(&s.system_identifier)),
                ("timeline", Cell::Int4(s.timeline)),
            ])
        } else if sql.contains("AS server_address") {
            one(vec![
                ("database", name(id)),
                ("role", text(user)),
                ("recovery", Cell::Bool(s.recovery)),
                ("server_address", server_address(sql, ip)),
                ("tls", Cell::Bool(true)),
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                ("rolbypassrls", Cell::Bool(false)),
                ("only_stats", Cell::Bool(true)),
                ("stats", Cell::Bool(true)),
                ("archive_listing", Cell::Bool(true)),
            ])
        } else if sql.contains("pg_stat_archiver") {
            // `EXTRACT(EPOCH ...)` is a numeric with six decimals; never archived is `-1`. The
            // last archive was a moment ago, never after the statement is asked.
            let at = now_ms().saturating_sub(1000);
            one(vec![
                ("ready_wal_files", text("0")),
                ("archived_count", text("5")),
                (
                    "last_archived_time",
                    text(&format!("{}.{:06}", at / 1000, (at % 1000) * 1000)),
                ),
                ("failed_count", text("0")),
            ])
        } else if sql.contains("current_setting('server_version')") {
            let column = if sql
                .replace("pg_catalog.", "")
                .contains("host(inet_server_addr())")
            {
                "host"
            } else {
                "inet_server_addr"
            };
            one(vec![
                ("current_user", text(user)),
                ("server_version", text("18.6 (Debian 18.6-1.pgdg13+2)")),
                ("server_version_num", Cell::Int4(180006)),
                ("max_connections", Cell::Int4(20)),
                (
                    "shared_buffers",
                    text(&((request / 4).max(1) * 1024 * 1024).to_string()),
                ),
                (
                    "effective_cache_size",
                    text(&((memory / 2) * 1024 * 1024).to_string()),
                ),
                ("archive_timeout", Cell::Int4(60)),
                ("current_database", text(id)),
                (column, server_address(sql, ip)),
                ("pg_is_in_recovery", Cell::Bool(s.recovery)),
            ])
        } else if sql.contains("FROM pg_roles WHERE rolname=current_user") {
            // The role's own privileges: BYPASSRLS is the one attribute a role can be given.
            one(vec![
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                (
                    "rolbypassrls",
                    Cell::Bool(s.roles.get(user).is_some_and(|held| held.bypass_rls)),
                ),
                ("rolcanlogin", Cell::Bool(true)),
            ])
        } else if sql.contains("pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats") {
            one(vec![
                ("database", name(id)),
                ("recovery", Cell::Bool(s.recovery)),
                ("tls", Cell::Bool(true)),
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                ("rolbypassrls", Cell::Bool(false)),
                ("stats", Cell::Bool(true)),
            ])
        } else {
            Answer::Error("0A000", "statement not served by the test double")
        }
    })
}

pub struct World {
    /// Every committed write of the cluster, every gateway control and every statement of
    /// PostgreSQL, in the order they happened.
    pub log: Arc<Mutex<Vec<String>>>,
    pub server: Server,
    pub reconciler: Reconciler,
    /// The desired record the next pass sees.
    pub db: Value,
    pub snapshot: DesiredSnapshot,
    pub node: Value,
    pub authority: Authority,
    pub gateway: Gateway,
    pub postgres: Option<Postgres>,
    pub sql: Arc<Mutex<Sql>>,
    pub ns: String,
    pub id: String,
    /// The CA of the pool slot's instance, and the PostgreSQL of the slot.
    pub slot_authority: Authority,
    pub slot_postgres: Option<Postgres>,
}

fn owned_by_cluster() -> Value {
    json!([{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":cluster_uid(),"controller":true}])
}
impl World {
    /// An idle database about to sleep: PostgreSQL runs and answers, its Pod is ready, and the
    /// desired record asks for an idle sleep at generation 2.
    pub async fn awake() -> Self {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let mut db = vectors["intents"][0]["db"].clone();
        let id = text(&db, "id").to_string();
        db["creation"]["ever_ready"] = true.into();
        db["creation"]["status"] = "succeeded".into();
        // The running record the cluster was last applied from, one generation back.
        let mut running = db.clone();
        running["generation"] = 1.into();
        let ns = namespace(&db);
        let snapshot = DesiredSnapshot {
            region: json!({"id":"eu-test","backup":{"bucket":"native-controller-test","endpoint_url":"https://backup.example.invalid","region":"auto"},"scheduling":{"placement_mode":"actual_ram","maximum_database_memory_mib":256,"postgres_memory_request_mib":128}}),
            fleet_release: json!({"region_id":"eu-test","region_revision":1,"release":{"id":"r1","spec_sha256":"b".repeat(64),"approved_at":"2026-10-15T00:00:00.000Z","spec":{}},"nodes":[{"node_id":"nod_aaaaaaaaaaaaaaaaaaaa","node_uid":node_uid(),"k8s_node_name":NODE,"role":"customer","revision":3}]}),
            databases: vec![],
        };
        let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":NODE,"uid":node_uid(),"labels":{}},"status":{"nodeInfo":{"bootID":BOOT_ID}}});
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let log_clone = log.clone();
        let server = Server::start().await;
        server.state.lock().unwrap().log = Some(log.clone());
        let reconciler = Reconciler::new(
            server.k8s.clone(),
            kube_system(),
            IMAGE.into(),
            "eu-test".into(),
            1,
        )
        .unwrap();
        for object in [
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"kube-system","uid":kube_system()}}),
            node.clone(),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"pgcf-backup-s3","namespace":SYSTEM,"uid":uid(40)},"data":{"AWS_ACCESS_KEY_ID":STANDARD.encode("unit-access"),"AWS_SECRET_ACCESS_KEY":STANDARD.encode("unit-secret")}}),
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"uid":namespace_uid(),"labels":{"pgcf.io/database-id":id,"pgcf.io/compute-runtime":"standard"},"annotations":{"pgcf.io/generation":"1","pgcf.io/accepted-generation":"1"}}}),
        ] {
            server.put(object);
        }
        let context = reconciler
            .context(&running, &snapshot, false)
            .await
            .unwrap();
        let mut applied = manifests::build(&running, &context).unwrap();
        applied.remove(0);
        for mut manifest in applied {
            manifest["metadata"]["uid"] =
                uid(100 + server.state.lock().unwrap().objects.len() as u64).into();
            manifest["metadata"]["annotations"] =
                json!({"pgcf.io/generation":"1","pgcf.io/accepted-generation":"1"});
            if manifest["kind"] == "Cluster" {
                manifest["metadata"]["uid"] = cluster_uid().into();
                manifest["status"] = json!({"phase":"Cluster in healthy state","currentPrimary":"database-1","targetPrimary":"database-1","readyInstances":1,"certificates":{"serverCASecret":"database-ca","serverTLSSecret":"database-server","clientCASecret":"database-ca"},"secretsResourceVersion":{"applicationSecretVersion":"1"},"managedRolesStatus":{"byStatus":{"reconciled":["reader_query","pgcf_maintenance"]},"passwordStatus":{"reader_query":{"resourceVersion":"1"},"pgcf_maintenance":{"resourceVersion":"1"}}},"conditions":[{"type":"Ready","status":"True"}]});
            }
            server.put(manifest);
        }
        let authority = Authority::new();
        let log_for_gateway = log_clone.clone();
        for object in [
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{id}"),"namespace":SYSTEM,"uid":storage_uid(),"labels":{"pgcf.io/database-id":id},"annotations":{"pgcf.io/generation":"1","pgcf.io/volume-identity":json!({"claimUid":claim_uid(),"volumeUid":volume_uid(),"handle":HANDLE}).to_string()}},"data":{"state":json!({"namespaceUid":namespace_uid(),"clusterUid":cluster_uid(),"node":NODE,"archivePath":db["archive"]["destination_path"]}).to_string()}}),
            json!({"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":HANDLE,"uid":volume_uid()},"spec":{"claimRef":{"name":"database-1","namespace":ns,"uid":claim_uid()},"csi":{"driver":"local.csi.openebs.io","volumeHandle":HANDLE},"storageClassName":"pgcf-lvm","capacity":{"storage":"5Gi"},"nodeAffinity":{"required":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":[NODE]}]}]}}},"status":{"phase":"Bound"}}),
            json!({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":"database-1","namespace":ns,"uid":claim_uid(),"labels":{"cnpg.io/cluster":"database"},"ownerReferences":owned_by_cluster()},"spec":{"volumeName":HANDLE,"storageClassName":"pgcf-lvm","resources":{"requests":{"storage":"5Gi"}}},"status":{"phase":"Bound","capacity":{"storage":"5Gi"}}}),
            json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMVolume","metadata":{"name":HANDLE,"namespace":"openebs","uid":lvm_uid()},"spec":{"ownerNodeID":NODE},"status":{"state":"Ready"}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"database-ca","namespace":ns,"uid":uid(41),"ownerReferences":owned_by_cluster()},"data":{"ca.crt":STANDARD.encode(&authority.pem)}}),
            json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"gateway-0","namespace":SYSTEM,"uid":gateway_uid(),"labels":{"app.kubernetes.io/name":"pgcf-gateway"}},"spec":{"serviceAccountName":"pgcf-gateway"},"status":{"podIP":"10.0.0.1","containerStatuses":[{"name":"gateway","restartCount":0}]}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"pgcf-gateway","namespace":SYSTEM,"uid":uid(21)},"data":{"PGCF_ROUTE_KEY":STANDARD.encode(json!({"active":"local","keys":{"local":URL_SAFE_NO_PAD.encode([7_u8;32])}}).to_string())}}),
        ] {
            server.put(object);
        }
        let objects = server.state.clone();
        let mut world = Self {
            log,
            server,
            reconciler,
            db,
            snapshot,
            node,
            authority,
            gateway: Gateway::start(log_for_gateway, objects).await,
            postgres: None,
            sql: Arc::new(Mutex::new(Sql::default())),
            ns,
            id,
            slot_authority: Authority::new(),
            slot_postgres: None,
        };
        world.gateway.fenced(false);
        world.reconciler.power.http = world.gateway.client.clone();
        world.reconciler.http = world.gateway.client.clone();
        world.pod(true);
        world.maintenance_credentials();
        world.start_postgres().await;
        world.suspend_idle();
        world
    }
    /// The instance Pod as CNPG leaves it: ready with PostgreSQL running, or fenced and not ready.
    pub fn pod(&self, ready: bool) {
        let requests = json!({"cpu":"25m","memory":"128Mi"});
        let limits = json!({"cpu":"250m","memory":"256Mi"});
        let side = json!({"cpu":"100m","memory":"128Mi"});
        let side_limits = json!({"cpu":"500m","memory":"512Mi"});
        self.server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":self.ns,"uid":pod_uid(),"labels":{"cnpg.io/cluster":"database","pgcf.io/database-id":self.id},"ownerReferences":owned_by_cluster()},
            "spec":{"nodeName":NODE,"containers":[{"name":"postgres","image":IMAGE,"resources":{"requests":requests,"limits":limits}}],
                    "initContainers":[{"name":"bootstrap-controller","resources":{"requests":requests,"limits":limits}},{"name":"plugin-barman-cloud","restartPolicy":"Always","resources":{"requests":side,"limits":side_limits}}],
                    "volumes":[{"name":"pgdata","persistentVolumeClaim":{"claimName":"database-1"}}]},
            "status":{"phase":"Running","podIP":POD_IP,"conditions":[{"type":"Ready","status":if ready{"True"}else{"False"}}],
                      "containerStatuses":[{"name":"postgres","ready":ready,"containerID":POSTGRES_CONTAINER,"imageID":IMAGE,"state":{"running":{"startedAt":"2026-10-15T00:00:00Z"}},"restartCount":0,"resources":{"requests":requests}}],
                      "initContainerStatuses":[{"name":"plugin-barman-cloud","ready":true,"containerID":SIDECAR_CONTAINER,"state":{"running":{"startedAt":"2026-10-15T00:00:00Z"}},"restartCount":0,"resources":{"requests":side}}]}}));
    }
    /// A database Cloudflare admitted: its running proof is the v2 attestation the gateway routes
    /// by, which needs the controller's watch to cover every object the proof names.
    pub fn admitted(&mut self) {
        self.db["admission"] = json!({"v":1,"admission_epoch":1,"route_revision":1});
        // The CA publication of an admitted database names the Secret it was published from.
        let secret = self
            .server
            .get("Secret", Some(&self.ns), "database-ca")
            .unwrap();
        self.server.edit(
            "ConfigMap",
            Some(SYSTEM),
            &format!("ca-{}", self.id),
            |map| {
                let annotations = &mut map["metadata"]["annotations"];
                annotations["pgcf.io/source-ca-secret-uid"] = secret["metadata"]["uid"].clone();
                annotations["pgcf.io/source-ca-secret-resource-version"] =
                    secret["metadata"]["resourceVersion"].clone();
            },
        );
        self.server.watch();
    }
    /// The CA ConfigMap the agent publishes for the gateway; the maintenance Secret is among the
    /// applied manifests already.
    pub fn maintenance_credentials(&self) {
        self.server.put(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{}",self.id),"namespace":SYSTEM,"uid":uid(43),"labels":{"pgcf.io/database-id":self.id},"annotations":{"pgcf.io/generation":"1"}},"data":{"ca.crt":self.authority.pem}}));
    }
    /// Starts the PostgreSQL socket (a fresh one after `stop_postgres`, on the same port).
    pub async fn start_postgres(&mut self) {
        let address = self.postgres.as_ref().map(|p| p.address);
        let previous = self.postgres.take();
        drop(previous);
        let state = self.server.state.clone();
        let cluster = crate::test_server::path("Cluster", Some(&self.ns), "database");
        let fenced: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            state
                .lock()
                .unwrap()
                .objects
                .get(&cluster)
                .is_some_and(|c| {
                    c["metadata"]["annotations"]["cnpg.io/fencedInstances"].is_string()
                })
        });
        let sql = self.sql.clone();
        let log = self.log.clone();
        // Every login is a line of the log, in the order of the statements and the writes.
        let login: Login = Arc::new(move |user: &str| {
            log.lock().unwrap().push(format!("LOGIN {user}"));
            sql.lock().unwrap().refused.get(user).copied()
        });
        let postgres = Postgres::start_with(
            &self.authority,
            &format!("database-rw.{}.svc", self.ns),
            address,
            answers(
                self.db.clone(),
                self.sql.clone(),
                fenced,
                self.log.clone(),
                ("SQL", POD_IP),
            ),
            login,
        )
        .await;
        self.reconciler.power.postgres = Some(postgres.address);
        self.postgres = Some(postgres);
    }
    /// PostgreSQL stops: the socket refuses connections.
    pub fn stop_postgres(&self) {
        if let Some(postgres) = &self.postgres {
            postgres.stop();
        }
    }
    /// The desired record of an idle sleep at generation 2, as the API states it: the scheduling
    /// request is left out of a suspended database's size.
    pub fn suspend_idle(&mut self) {
        self.db["generation"] = 2.into();
        self.db["desired_state"] = "suspended".into();
        self.db["power"] = json!({"operation":format!("op_{}","d".repeat(20)),"revision":2,"mode":"quiesce","reason":"idle"});
        self.db["size"]
            .as_object_mut()
            .unwrap()
            .remove("memory_request_mib");
    }
    /// The desired record of a wake at `generation`, as the API states it.
    pub fn wake(&mut self, generation: u64) {
        self.db["generation"] = generation.into();
        self.db["desired_state"] = "running".into();
        self.db["power"] = json!({"operation":format!("op_{}","w".repeat(20)),"revision":generation,"mode":"running","reason":null});
        self.db["size"]["memory_request_mib"] = 128.into();
    }
    /// A running database in the ordinary CNPG runtime, at generation 2 and without a power
    /// intent: CNPG reconciled its Cluster, its Pod is ready and PostgreSQL answers, so one pass
    /// of the reconciler finds it ready. The catalogs of PostgreSQL hold its roles as the record
    /// states them.
    pub async fn running() -> Self {
        let mut w = Self::awake().await;
        w.db["generation"] = 2.into();
        w.db["desired_state"] = "running".into();
        w.db.as_object_mut().unwrap().remove("power");
        w.db["size"]["memory_request_mib"] = 128.into();
        w.catalog_follows_desired();
        w
    }
    /// PostgreSQL's catalogs hold every present role of the record other than the owner as the
    /// record states it: it logs in, expires, is limited, is a member and bypasses row security
    /// exactly as asked. A role the catalogs hold already keeps its sessions and objects.
    pub fn catalog_follows_desired(&self) {
        let mut sql = self.sql.lock().unwrap();
        for role in present_roles(&self.db).filter(|role| role["owner"] != true) {
            let name = text(role, "name");
            let held = sql.roles.entry(name.to_string()).or_default();
            held.login = true;
            held.valid_until = role["valid_until"].as_str().map(|until| {
                let at = time::OffsetDateTime::parse(
                    until,
                    &time::format_description::well_known::Rfc3339,
                )
                .unwrap();
                Instant::At(at.unix_timestamp(), 0)
            });
            held.connection_limit = role["connection_limit"]
                .as_i64()
                .map_or(-1, |limit| i32::try_from(limit).unwrap());
            held.bypass_rls = role["bypass_rls"] == true;
            held.member_of = role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|target| target.as_str().map(str::to_string))
                .collect();
        }
    }
    /// CNPG has reconciled every present role of the record: the Cluster's status names it
    /// reconciled with the version of the Secret it applied (a Secret the controller creates
    /// starts at version 1).
    pub fn cnpg_reconciles(&self) {
        let mut names: Vec<String> = present_roles(&self.db)
            .filter(|role| role["owner"] != true)
            .map(|role| text(role, "name").to_string())
            .collect();
        names.push(text(&self.db["maintenance"], "role").to_string());
        let mut passwords = json!({});
        for name in &names {
            let secret = if *name == text(&self.db["maintenance"], "role") {
                "maintenance-credentials".to_string()
            } else {
                manifests::role_secret(name)
            };
            let version = self
                .server
                .get("Secret", Some(&self.ns), &secret)
                .map_or("1".to_string(), |s| {
                    text(&s["metadata"], "resourceVersion").to_string()
                });
            passwords[name] = json!({"resourceVersion": version});
        }
        self.server
            .edit("Cluster", Some(&self.ns), "database", |cluster| {
                cluster["status"]["managedRolesStatus"] =
                    json!({"byStatus":{"reconciled":names},"passwordStatus":passwords});
            });
    }
    /// The Cluster's entry for the managed role `name`, as the controller applied it.
    pub fn managed_role(&self, name: &str) -> Option<Value> {
        self.server.get("Cluster", Some(&self.ns), "database")?["spec"]["managed"]["roles"]
            .as_array()?
            .iter()
            .find(|role| role["name"] == name)
            .cloned()
    }
    /// The record states a new role at the next generation, which CNPG then reconciles.
    pub fn add_role(&mut self, role: Value) {
        self.db["roles"].as_array_mut().unwrap().push(role);
        self.db["generation"] = (self.db["generation"].as_u64().unwrap() + 1).into();
        self.cnpg_reconciles();
        self.catalog_follows_desired();
    }
    /// The API deleted `name`: at the next generation the record holds a removal entry for it,
    /// which is all that is left of the role in the record.
    pub fn delete_role(&mut self, name: &str) {
        for role in self.db["roles"].as_array_mut().unwrap() {
            if role["name"] == name {
                *role = json!({"name":name,"state":"absent"});
            }
        }
        self.db["generation"] = (self.db["generation"].as_u64().unwrap() + 1).into();
    }
    /// One pass of the sleep step of the database's own Cluster.
    pub async fn sleep_pass(&self) -> Option<Value> {
        self.reconciler.power.suspend(&self.db, None).await.unwrap()
    }
}

/// The pool slot of the pooled world: its hex, address and containers.
pub const SLOT_HEX: &str = "0a1b2c3d";
pub const SLOT_IP: &str = "10.0.0.9";
pub const SLOT_POSTGRES: &str = "3333333333333333333333333333333333333333333333333333333333333333";
pub const SLOT_SIDECAR: &str = "4444444444444444444444444444444444444444444444444444444444444444";
/// The thin LV of the pooled world's database and its volume group.
pub const LV_UUID: &str = "iLeDnR-3bK4-F2Sh-j05A-x0NW-MCcd-TfCn8O";
pub const VG_UUID: &str = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
pub const AGENT_IP: &str = "10.0.0.8";
pub fn slot_ns() -> String {
    format!("pgcf-slot-{SLOT_HEX}")
}
pub fn slot_pod_uid() -> String {
    uid(60)
}
pub fn slot_cluster_uid() -> String {
    uid(62)
}
fn iso_ms(ms: u64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000).unwrap();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}
impl World {
    /// A thin database that slept cleanly through its own Cluster, on a node with a node agent
    /// and one free pool slot: what a pool wake starts from. The sleep is at generation 2.
    pub async fn pooled() -> Self {
        let mut w = Self::awake().await;
        w.reconciler.pool.start_budget = std::time::Duration::from_secs(2);
        w.reconciler.power.attach.client =
            crate::attach_protocol::Client::new(w.gateway.client.clone());
        w.reconciler.pool.intake.http = w.gateway.client.clone();
        w.thin();
        w.admitted();
        // The sleep of its own Cluster: proved, hibernated by CNPG, recorded.
        assert!(
            w.sleep_pass().await.is_none(),
            "the first pass proves the sleep"
        );
        w.hibernated_by_cnpg();
        let observed = w.sleep_pass().await.expect("a hibernated observation");
        assert_eq!(observed["state"], "hibernated", "{observed}");
        w.free_slot().await;
        w
    }
    /// The database's storage is a thin LV on the world's node, whose thin pool has room, and the
    /// node agent knows its device (open by the database's own Pod).
    pub fn thin(&mut self) {
        let class = "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa";
        self.db["storage"] = json!({"backend":"lvm-thin-v1","storage_class":class,"volume_attributes_class":class,"profile_revision":1,"profile_sha256":"a".repeat(64),"node_uid":node_uid(),"volume_group_uuid":VG_UUID,"pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","startup_reserve_bytes":1048576,"write_bytes_per_second":1048576,"write_iops_per_second":10,"guard_seconds":10,"drain_seconds":1});
        let storage = self.db["storage"].clone();
        let archive = self.db["archive"]["destination_path"].clone();
        self.server.edit(
            "ConfigMap",
            Some(SYSTEM),
            &format!("storage-{}", self.id),
            |map| {
                map["data"]["state"] = json!({"namespaceUid":namespace_uid(),"clusterUid":cluster_uid(),"node":NODE,"archivePath":archive,"storage":storage}).to_string().into();
                map["metadata"]["annotations"]["pgcf.io/volume-identity"] = json!({"claimUid":claim_uid(),"volumeUid":volume_uid(),"handle":HANDLE,"lvUuid":LV_UUID}).to_string().into();
            },
        );
        self.server.edit("PersistentVolume", None, HANDLE, |pv| {
            pv["spec"]["storageClassName"] = class.into();
        });
        self.server.edit(
            "PersistentVolumeClaim",
            Some(&self.ns),
            "database-1",
            |claim| {
                claim["spec"]["storageClassName"] = class.into();
            },
        );
        self.node_storage(true);
        self.server.edit("Node", None, NODE, |node| {
            node["status"]["allocatable"] = json!({"memory":"8Gi","cpu":"4"});
        });
        self.node = self.server.get("Node", None, NODE).unwrap();
        self.gateway.agent.lock().unwrap().devices.insert(
            LV_UUID.into(),
            Device {
                dm_uuid: crate::attach_protocol::Volume {
                    lv_name: HANDLE.into(),
                    lv_uuid: LV_UUID.into(),
                    vg_uuid: VG_UUID.into(),
                }
                .dm_uuid(),
                opens: 1,
                suspended: false,
                control: crate::attach_protocol::Control {
                    state: 1,
                    system_identifier: Sql::default().system_identifier,
                    timeline: 1,
                },
                attached: None,
            },
        );
        self.server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"pgcf-attach-x","namespace":"pgcf-attach","uid":uid(50),"labels":{"app.kubernetes.io/name":"pgcf-attach"}},"spec":{"nodeName":NODE},"status":{"phase":"Running","podIP":AGENT_IP,"conditions":[{"type":"Ready","status":"True"}]}}));
    }
    /// The node's storage row as Cloudflare serves it now: whether its thin pool has room.
    pub fn node_storage(&mut self, room: bool) {
        let now = now_ms();
        let storage = &self.db["storage"];
        self.snapshot.region["storage_nodes"] = json!([{"name":NODE,"node_uid":node_uid(),"cluster_uid":kube_system(),"volume_group_uuid":storage["volume_group_uuid"],"pool_uuid":storage["pool_uuid"],"profile_sha256":storage["profile_sha256"],"profile_revision":1,"storage_class":storage["storage_class"],"write_allowed":room,"observed_at":iso_ms(now),"expires_at":iso_ms(now + 9_000)}]);
    }
    /// CNPG hibernated the database's Cluster: its Pod is gone and the volume closed.
    pub fn hibernated_by_cnpg(&mut self) {
        self.stop_postgres();
        self.server
            .state
            .lock()
            .unwrap()
            .objects
            .remove(&crate::test_server::path(
                "Pod",
                Some(&self.ns),
                "database-1",
            ));
        self.server
            .edit("Cluster", Some(&self.ns), "database", |cluster| {
                cluster["status"]["conditions"] =
                    json!([{"type":"cnpg.io/hibernation","status":"True","reason":"Hibernated"}]);
            });
        if let Some(device) = self.gateway.agent.lock().unwrap().devices.get_mut(LV_UUID) {
            device.opens = 0;
        }
    }
    /// One free pool slot on the world's node, as CNPG runs it: fenced, its Pod up with both
    /// containers, its CA made; and the PostgreSQL its instance starts once the fence is lifted.
    pub async fn free_slot(&mut self) {
        let ns = slot_ns();
        let labels = json!({"pgcf.io/slot":SLOT_HEX});
        let owner = json!([{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":slot_cluster_uid(),"controller":true}]);
        let requests = json!({"cpu":"100m","memory":"128Mi"});
        let limits = json!({"cpu":"500m","memory":"512Mi"});
        let placeholder = STANDARD.encode("pgcf-slot-placeholder");
        for object in [
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":ns,"uid":uid(61),"labels":{"pgcf.io/slot":SLOT_HEX,"pgcf.io/slot-node":NODE,"pgcf.io/compute-runtime":"standard"}}}),
            json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"database","namespace":ns,"uid":slot_cluster_uid(),"labels":labels,"annotations":{"cnpg.io/fencedInstances":"[\"*\"]"}},"spec":{"instances":1,"imageName":IMAGE,"resources":{"requests":requests,"limits":limits},"postgresql":{"parameters":{"max_connections":"20"}},"managed":{"roles":[]}},"status":{"phase":"Cluster in healthy state","certificates":{"serverCASecret":"database-ca"}}}),
            json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":ns,"uid":slot_pod_uid(),"labels":{"cnpg.io/cluster":"database","pgcf.io/slot":SLOT_HEX},"ownerReferences":owner},
                "spec":{"nodeName":NODE,"containers":[{"name":"postgres","image":IMAGE,"resources":{"requests":requests,"limits":limits}}],"initContainers":[{"name":"plugin-barman-cloud","restartPolicy":"Always","resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"512Mi"}}}],"volumes":[{"name":"pgdata","persistentVolumeClaim":{"claimName":"database-1"}}]},
                "status":{"phase":"Running","podIP":SLOT_IP,"conditions":[{"type":"Ready","status":"False"}],
                    "containerStatuses":[{"name":"postgres","ready":false,"containerID":format!("containerd://{SLOT_POSTGRES}"),"imageID":IMAGE,"state":{"running":{"startedAt":"2026-10-16T00:00:00Z"}},"restartCount":0,"resources":{"requests":requests}}],
                    "initContainerStatuses":[{"name":"plugin-barman-cloud","ready":true,"containerID":format!("containerd://{SLOT_SIDECAR}"),"state":{"running":{"startedAt":"2026-10-16T00:00:00Z"}},"restartCount":0}]}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"database-ca","namespace":ns,"uid":uid(63),"labels":labels,"ownerReferences":owner},"data":{"ca.crt":STANDARD.encode(&self.slot_authority.pem)}}),
            json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"archive-credentials","namespace":ns,"uid":uid(64),"labels":labels},"type":"Opaque","data":{"AWS_ACCESS_KEY_ID":placeholder,"AWS_SECRET_ACCESS_KEY":placeholder}}),
            json!({"apiVersion":"barmancloud.cnpg.io/v1","kind":"ObjectStore","metadata":{"name":"archive","namespace":ns,"uid":uid(65),"labels":labels},"spec":{"configuration":{"destinationPath":format!("s3://native-controller-test/slots/{SLOT_HEX}/")},"retentionPolicy":"1d"}}),
        ] {
            self.server.put(object);
        }
        self.start_slot_postgres().await;
        self.reconciler
            .pool
            .rediscover(&self.reconciler)
            .await
            .unwrap();
        self.gateways_polled().await;
    }
    /// The slot's PostgreSQL: it answers once the slot's fence is lifted, on whatever data the
    /// instance runs on (the world's `Sql`), under the slot's own service name.
    pub async fn start_slot_postgres(&mut self) {
        let state = self.server.state.clone();
        let cluster = crate::test_server::path("Cluster", Some(&slot_ns()), "database");
        let fenced: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            state
                .lock()
                .unwrap()
                .objects
                .get(&cluster)
                .is_none_or(crate::power::fenced)
        });
        let log = self.log.clone();
        let login: Login = Arc::new(move |user: &str| {
            log.lock().unwrap().push(format!("SLOT LOGIN {user}"));
            None
        });
        let postgres = Postgres::start_with(
            &self.slot_authority,
            &format!("database-rw.{}.svc", slot_ns()),
            None,
            answers(
                self.db.clone(),
                self.sql.clone(),
                fenced,
                self.log.clone(),
                ("SLOT SQL", SLOT_IP),
            ),
            login,
        )
        .await;
        self.reconciler.pool.postgres = Some(postgres.address);
        self.slot_postgres = Some(postgres);
    }
    /// Every gateway Pod answered a wake poll.
    pub async fn gateways_polled(&self) {
        let (sender, _receiver) = tokio::sync::mpsc::channel(16);
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(150),
            self.reconciler
                .pool
                .intake
                .run(&self.reconciler.power, sender),
        )
        .await;
        let pods = self.reconciler.power.gateway_pods().await.unwrap();
        assert!(self.reconciler.pool.intake.ready(&pods));
    }
    /// The gateway Pod of the world.
    pub fn gateway_pod(&self) -> crate::power::GatewayPod {
        crate::power::GatewayPod {
            name: "gateway-0".into(),
            uid: self.gateway.pod.lock().unwrap().clone(),
            ip: "10.0.0.1".into(),
            restarts: 0,
        }
    }
    /// The wake the Edge's ticket names for the sleeping row: the next generation.
    pub fn wake_request(&self) -> pgcf_native_protocol::wake::WakeRequest {
        pgcf_native_protocol::wake::WakeRequest {
            database: self.id.clone(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: self.db["generation"].as_u64().unwrap() + 1,
            route_revision: self.db["admission"]["route_revision"].as_u64().unwrap(),
            role_revision_hash: pgcf_native_protocol::wake::role_revision_hash(
                present_roles(&self.db)
                    .map(|r| (r["name"].as_str().unwrap(), r["revision"].as_u64().unwrap())),
            ),
            queued_at_ms: now_ms(),
        }
    }
    /// Cloudflare committed the wake of `wake`: the desired row runs at its generation, under
    /// its operation.
    pub fn claimed(&mut self, wake: &pgcf_native_protocol::wake::WakeRequest) {
        self.db["generation"] = wake.generation.into();
        self.db["desired_state"] = "running".into();
        self.db["power"] = json!({"operation":wake.operation,"revision":wake.generation,"mode":"running","reason":null});
        self.db["size"]["memory_request_mib"] = 128.into();
    }
    /// The lines of the log since `from`.
    pub fn since(&self, from: usize) -> Vec<String> {
        self.log.lock().unwrap()[from..].to_vec()
    }
    pub fn log_len(&self) -> usize {
        self.log.lock().unwrap().len()
    }
}

/// The double against what PostgreSQL 18.6 of the product image describes for every statement the
/// controller sends to a database. The column types are the `\gdesc` output of the real server and
/// the value shapes its text output; a statement that changes, or a double that answers it with a
/// shape the server does not produce, fails here instead of in a live wake.
#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::{contracts::constant, postgres, power::sql};
    use tokio_postgres::types::Type;

    type Case<'a> = (&'a str, Option<&'a str>, Vec<(&'a str, Type)>);
    /// Every statement the controller sends to a database with the columns PostgreSQL 18.6 of the
    /// product image describes for it (`""` matches any name). `role` is the bound parameter of
    /// the two identity statements.
    fn pinned(role: &str) -> Vec<Case<'_>> {
        let bools = |names: &[&'static str]| -> Vec<(&'static str, Type)> {
            names.iter().map(|n| (*n, Type::BOOL)).collect()
        };
        let archive_identity = constant("ARCHIVE_IDENTITY_QUERY").as_str().unwrap();
        let archive = constant("ARCHIVE_QUERY").as_str().unwrap();
        vec![
            (
                sql("CLEAR"),
                None,
                vec![("pg_stat_clear_snapshot", Type::VOID)],
            ),
            (
                sql("GUARD"),
                None,
                vec![("busy", Type::INT4), ("prepared", Type::INT4)],
            ),
            (
                sql("IDENTITY"),
                Some(role),
                [
                    vec![("database", Type::NAME)],
                    bools(&[
                        "recovery",
                        "tls",
                        "rolsuper",
                        "rolcreatedb",
                        "rolcreaterole",
                        "rolreplication",
                        "rolbypassrls",
                        "stats",
                    ]),
                ]
                .concat(),
            ),
            (
                sql("SWITCH"),
                None,
                vec![("lsn", Type::TEXT), ("segment", Type::TEXT)],
            ),
            (
                sql("ARCHIVE_STATUS"),
                Some("0000000100000000000000A7.done"),
                vec![("done", Type::BOOL)],
            ),
            (
                archive_identity,
                Some(role),
                [
                    vec![
                        ("database", Type::NAME),
                        ("role", Type::TEXT),
                        ("recovery", Type::BOOL),
                        ("server_address", Type::TEXT),
                    ],
                    bools(&[
                        "tls",
                        "rolsuper",
                        "rolcreatedb",
                        "rolcreaterole",
                        "rolreplication",
                        "rolbypassrls",
                        "only_stats",
                        "stats",
                        "archive_listing",
                    ]),
                ]
                .concat(),
            ),
            (
                archive,
                None,
                vec![
                    ("ready_wal_files", Type::TEXT),
                    ("archived_count", Type::TEXT),
                    ("last_archived_time", Type::TEXT),
                    ("failed_count", Type::TEXT),
                ],
            ),
            (
                postgres::ROLE_QUERY,
                None,
                vec![
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::INT4),
                    ("", Type::INT4),
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::INT4),
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::BOOL),
                ],
            ),
            (
                postgres::PRIVILEGES_QUERY,
                None,
                bools(&[
                    "rolsuper",
                    "rolcreatedb",
                    "rolcreaterole",
                    "rolreplication",
                    "rolbypassrls",
                    "rolcanlogin",
                ]),
            ),
            (
                postgres::ACCEPTING_QUERY,
                None,
                vec![
                    ("database", Type::NAME),
                    ("recovery", Type::BOOL),
                    ("tls", Type::BOOL),
                    ("server_address", Type::TEXT),
                    ("postmaster_age_ms", Type::INT8),
                    ("system_identifier", Type::TEXT),
                    ("timeline", Type::INT4),
                ],
            ),
            (
                postgres::SERVER_IDENTITY_QUERY,
                None,
                vec![("system_identifier", Type::TEXT), ("timeline", Type::INT4)],
            ),
            // The role lifecycle: a role's row by name (NULL expiry for none), and the counts
            // that decide whether it can be dropped and whether sessions remain.
            (
                postgres::ROLE_CATALOG_QUERY,
                Some(role),
                vec![
                    ("rolname", Type::NAME),
                    ("rolcanlogin", Type::BOOL),
                    ("rolvaliduntil", Type::TIMESTAMPTZ),
                    ("rolconnlimit", Type::INT4),
                    ("rolbypassrls", Type::BOOL),
                ],
            ),
            (
                postgres::DEPENDENCIES_QUERY,
                Some(role),
                vec![("count", Type::INT8)],
            ),
            (
                postgres::SESSIONS_QUERY,
                Some(role),
                vec![("count", Type::INT8)],
            ),
        ]
    }
    /// The role statements that answer a row per match, which may be none: their columns, read
    /// from the statement the server describes.
    async fn describes(client: &tokio_postgres::Client) {
        for (statement, expected) in [
            (postgres::MEMBERSHIP_QUERY, vec![("rolname", Type::NAME)]),
            (
                postgres::TERMINATE_QUERY,
                vec![("pg_terminate_backend", Type::BOOL)],
            ),
        ] {
            let prepared = client
                .prepare(statement)
                .await
                .unwrap_or_else(|error| panic!("{statement}: {error}"));
            assert_eq!(prepared.params().len(), 1, "{statement}");
            let columns: Vec<_> = prepared
                .columns()
                .iter()
                .map(|column| (column.name().to_string(), column.type_().clone()))
                .collect();
            let expected: Vec<_> = expected
                .into_iter()
                .map(|(name, kind)| (name.to_string(), kind))
                .collect();
            assert_eq!(columns, expected, "{statement}");
        }
    }
    fn text_of(row: &tokio_postgres::Row, column: &str) -> String {
        row.try_get::<_, String>(column).unwrap()
    }
    /// Runs every pinned statement over `client` and checks what comes back against the forms of a
    /// PostgreSQL text output: the columns' types and names, the shape of an LSN, a WAL file name,
    /// an epoch, a server version and a server address. Every cell is what the real server gives.
    async fn conforms(client: &tokio_postgres::Client, role: &str) {
        describes(client).await;
        for (statement, parameter, expected) in pinned(role) {
            let rows = match parameter {
                Some(value) => client.query(statement, &[&value]).await,
                None => client.query(statement, &[]).await,
            }
            .unwrap_or_else(|error| panic!("{statement}: {error}"));
            assert_eq!(rows.len(), 1, "{statement}");
            let columns = rows[0].columns();
            assert_eq!(columns.len(), expected.len(), "{statement}");
            for (column, (name, kind)) in columns.iter().zip(&expected) {
                assert_eq!(column.type_(), kind, "{statement}: {}", column.name());
                if !name.is_empty() {
                    assert_eq!(column.name(), *name, "{statement}");
                }
            }
        }
        let upper_hex = |v: &str| {
            !v.is_empty()
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        };
        let switched = client.query(sql("SWITCH"), &[]).await.unwrap();
        let (lsn, segment) = (
            text_of(&switched[0], "lsn"),
            text_of(&switched[0], "segment"),
        );
        let (log, offset) = lsn.split_once('/').unwrap();
        assert!(upper_hex(log) && upper_hex(offset), "{lsn}");
        assert!(segment.len() == 24 && upper_hex(&segment), "{segment}");
        // `EXTRACT(EPOCH ...)` is a numeric printed with six decimals; never archived is `-1`.
        let archive = constant("ARCHIVE_QUERY").as_str().unwrap();
        let time = text_of(
            &client.query(archive, &[]).await.unwrap()[0],
            "last_archived_time",
        );
        assert!(
            time == "-1"
                || time.split_once('.').is_some_and(|(whole, fraction)| {
                    !whole.is_empty()
                        && whole.bytes().all(|b| b.is_ascii_digit())
                        && fraction.len() == 6
                        && fraction.bytes().all(|b| b.is_ascii_digit())
                }),
            "{time}"
        );
        // The server's own version string and numeric version.
        let settings = &client.query(postgres::ROLE_QUERY, &[]).await.unwrap()[0];
        let version = settings.try_get::<_, String>(1).unwrap();
        let number = version.split_whitespace().next().unwrap();
        assert!(
            number.split('.').count() == 2
                && number
                    .split('.')
                    .all(|part| part.bytes().all(|b| b.is_ascii_digit())),
            "{version}"
        );
        assert!(settings.try_get::<_, i32>(2).unwrap() >= 180_000);
        // Every address a statement returns as text is an address and carries no netmask.
        let address = |text: String| {
            assert!(!text.contains('/'), "{text}");
            text.parse::<std::net::IpAddr>()
                .unwrap_or_else(|_| panic!("{text} is an address"));
            text
        };
        let role_address = address(settings.try_get::<_, String>(8).unwrap());
        let accepting = &client.query(postgres::ACCEPTING_QUERY, &[]).await.unwrap()[0];
        assert_eq!(text_of(accepting, "server_address"), role_address);
        let identity = &client
            .query(
                constant("ARCHIVE_IDENTITY_QUERY").as_str().unwrap(),
                &[&role],
            )
            .await
            .unwrap()[0];
        assert_eq!(text_of(identity, "server_address"), role_address);
    }
    /// The table above against a real PostgreSQL: set `PGCF_TEST_POSTGRES_ADDR` to `host:port` of
    /// a server that trusts `postgres` (the product image started with `initdb -A trust` does).
    /// The statements are read only apart from the WAL switch of the sleep proof. Without the
    /// variable the test is skipped.
    #[tokio::test]
    async fn the_pinned_forms_are_what_a_real_postgresql_gives() {
        let Ok(address) = std::env::var("PGCF_TEST_POSTGRES_ADDR") else {
            eprintln!("skipped: PGCF_TEST_POSTGRES_ADDR names no PostgreSQL");
            return;
        };
        let (host, port) = address.rsplit_once(':').expect("host:port");
        let (client, connection) = tokio_postgres::Config::new()
            .host(host)
            .port(port.parse().unwrap())
            .user("postgres")
            .dbname("postgres")
            .connect(tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(connection);
        conforms(&client, "postgres").await;
    }
    /// The double answers the same statements with the same types and forms, and the three ways
    /// an `inet` reaches a column.
    #[tokio::test]
    async fn the_double_gives_every_statement_the_types_and_forms_postgresql_does() {
        let w = World::awake().await;
        let role = crate::contracts::text(&w.db["maintenance"], "role");
        // The role the statements are bound to exists in the catalogs of the double.
        w.sql
            .lock()
            .unwrap()
            .roles
            .insert(role.to_string(), RoleRow::default());
        let session = postgres::connect_via(
            &w.db,
            w.authority.pem.as_bytes(),
            role,
            crate::contracts::text(&w.db["maintenance"], "password"),
            crate::contracts::text(&w.db, "id"),
            w.reconciler.power.postgres,
        )
        .await
        .unwrap();
        conforms(&session.client, role).await;
        let settings = &session.query(postgres::ROLE_QUERY, &[]).await.unwrap()[0];
        assert_eq!(settings.try_get::<_, String>(8).unwrap(), POD_IP);
        assert_eq!(
            settings.try_get::<_, String>(1).unwrap(),
            "18.6 (Debian 18.6-1.pgdg13+2)"
        );
        // The three forms of the same value: `host()` is the address alone, the cast to `text`
        // keeps the netmask (the form that blocked every wake of r2.12), and the bare `inet` is a
        // binary value that no string decode accepts.
        let wanted = "pg_catalog.host(pg_catalog.inet_server_addr())";
        assert!(postgres::ROLE_QUERY.contains(wanted));
        let cast = postgres::ROLE_QUERY.replace(wanted, "inet_server_addr()::text");
        let row = &session.query(cast.as_str(), &[]).await.unwrap()[0];
        assert_eq!(row.try_get::<_, String>(8).unwrap(), format!("{POD_IP}/32"));
        let bare = postgres::ROLE_QUERY.replace(wanted, "inet_server_addr()");
        let row = &session.query(bare.as_str(), &[]).await.unwrap()[0];
        assert_eq!(row.columns()[8].type_(), &Type::INET);
        assert!(row.try_get::<_, String>(8).is_err());
        // A WAL file name of the double carries a letter, as about half of PostgreSQL's do.
        let segment = text_of(
            &session.query(sql("SWITCH"), &[]).await.unwrap()[0],
            "segment",
        );
        assert!(segment.bytes().any(|b| b.is_ascii_uppercase()), "{segment}");
    }
}
