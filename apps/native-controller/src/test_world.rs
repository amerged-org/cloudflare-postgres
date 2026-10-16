// SPDX-License-Identifier: Apache-2.0
//! A complete in-process world around one database on a thick volume for the parked sleep tier's
//! tests: its Kubernetes objects in the API double, a gateway control and exporter endpoint, and
//! a PostgreSQL socket. The controller's real code runs against it; nothing here is product code.
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
    /// The text `GET /metrics` answers.
    pub metrics: Arc<Mutex<String>>,
    /// The UID of the gateway Pod the control endpoint answers for.
    pub pod: Arc<Mutex<String>>,
    /// How many releases the endpoint still refuses with 409 `control_intent_mismatch`, as a
    /// gateway does until its watch has seen the intent the controller wrote.
    pub refuse_releases: Arc<Mutex<u32>>,
    task: tokio::task::JoinHandle<()>,
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
    async fn start(log: Arc<Mutex<Vec<String>>>) -> Self {
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
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (served, log, current, refusing) = (
                    served.clone(),
                    log.clone(),
                    current.clone(),
                    refusing.clone(),
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
                    let action = header
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .rsplit('/')
                        .next()
                        .unwrap()
                        .to_string();
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
            metrics,
            pod,
            refuse_releases,
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
            .push(format!("SQL {user} {kind}").trim_end().to_string());
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
                ("server_address", server_address(sql, POD_IP)),
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
                ("server_address", server_address(sql, POD_IP)),
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
                (column, server_address(sql, POD_IP)),
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
}

fn owned_by_cluster() -> Value {
    json!([{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":cluster_uid(),"controller":true}])
}
/// The default parked sleep tier policy of a region.
pub fn parking() -> Value {
    json!({"enabled":true,"ttl_seconds":600,"max_per_node":8,"postgres_cpu_millicores":10,"postgres_memory_mib":96,"sidecar_cpu_millicores":5,"sidecar_memory_mib":64})
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
            region: json!({"id":"eu-test","backup":{"bucket":"native-controller-test","endpoint_url":"https://backup.example.invalid","region":"auto"},"scheduling":{"placement_mode":"actual_ram","maximum_database_memory_mib":256,"postgres_memory_request_mib":128},"parking":parking()}),
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
        let mut world = Self {
            log,
            server,
            reconciler,
            db,
            snapshot,
            node,
            authority,
            gateway: Gateway::start(log_for_gateway).await,
            postgres: None,
            sql: Arc::new(Mutex::new(Sql::default())),
            ns,
            id,
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
    /// How many requests the Kubernetes double has received so far: where `made` starts from.
    pub fn mark(&self) -> usize {
        self.server.state.lock().unwrap().requests.len()
    }
    /// Every request the Kubernetes double received since `from`, as (method, path, query).
    pub fn made(&self, from: usize) -> Vec<(String, String, String)> {
        let state = self.server.state.lock().unwrap();
        state.requests[from..]
            .iter()
            .zip(&state.queries[from..])
            .map(|((method, path), query)| (method.clone(), path.clone(), query.clone()))
            .collect()
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
            answers(self.db.clone(), self.sql.clone(), fenced, self.log.clone()),
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
    /// One pass of the sleep step, the retained Pod judged against what a reconcile would apply.
    pub async fn sleep_pass(&self) -> Option<Value> {
        let cluster = self.server.get("Cluster", Some(&self.ns), "database");
        let retained = self
            .reconciler
            .retained_manifests(&self.db, &self.snapshot, cluster.as_ref(), false)
            .await;
        self.sleep_with(retained.manifests.as_deref(), retained.runtime_class)
            .await
    }
    /// One pass of the sleep step against the given manifests (`None`: they cannot be built).
    pub async fn sleep_with(
        &self,
        manifests: Option<&[Value]>,
        runtime_class: &str,
    ) -> Option<Value> {
        self.reconciler
            .power
            .suspend(
                &self.db,
                &crate::power::Sleep {
                    parking: &self.snapshot.region["parking"],
                    basis: crate::power::Basis {
                        node: &self.node,
                        release: &self.snapshot.fleet_release,
                        manifests,
                        runtime_class,
                    },
                },
            )
            .await
            .unwrap()
    }
    /// What the kubelet does to the instance Pod and CNPG to its Cluster once PostgreSQL runs: the
    /// Pod and its `postgres` container report Ready, and the Cluster status is written again.
    /// Each is a new version of the object, as every write is.
    pub fn kubelet_ready_now(&self) -> Arc<dyn Fn() + Send + Sync> {
        let state = self.server.state.clone();
        let pod = crate::test_server::path("Pod", Some(&self.ns), "database-1");
        let cluster = crate::test_server::path("Cluster", Some(&self.ns), "database");
        let log = self.log.clone();
        Arc::new(move || {
            let mut state = state.lock().unwrap();
            let bump = |value: &mut Value| {
                let version: u64 = value["metadata"]["resourceVersion"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                value["metadata"]["resourceVersion"] = (version + 1).to_string().into();
            };
            if let Some(pod) = state.objects.get_mut(&pod) {
                pod["status"]["conditions"] = json!([{"type":"Ready","status":"True"}]);
                pod["status"]["containerStatuses"][0]["ready"] = true.into();
                bump(pod);
            }
            if let Some(cluster) = state.objects.get_mut(&cluster) {
                bump(cluster);
            }
            state.sync();
            log.lock().unwrap().push("KUBELET ready".into());
        })
    }
    /// The watch events of every write the cluster committed since the last call, delivered to
    /// the controller's watch as the API server sends them, and the databases they hint for
    /// reconciliation. Afterwards the watch's picture of the objects is the current one again, as
    /// a watch without lag has it.
    pub fn watch_delivers(&self) -> Vec<String> {
        let events = std::mem::take(&mut self.server.state.lock().unwrap().events);
        let hints = events
            .iter()
            .filter(|(kind, _)| crate::kubernetes::RUNTIME_WATCH_KINDS.contains(&kind.as_str()))
            .filter_map(|(kind, event)| {
                self.reconciler
                    .k8s
                    .watch_event(kind, event)
                    .unwrap()
                    .1
                    .map(|candidate| candidate.trigger.database)
            })
            .collect();
        self.server.state.lock().unwrap().sync();
        hints
    }
    /// Changes the instance Pod the way `change` says, as a new version of it.
    pub fn change_pod(
        &self,
        change: impl Fn(&mut Value) + Send + Sync + 'static,
    ) -> Arc<dyn Fn() + Send + Sync> {
        let state = self.server.state.clone();
        let pod = crate::test_server::path("Pod", Some(&self.ns), "database-1");
        Arc::new(move || {
            let mut state = state.lock().unwrap();
            if let Some(pod) = state.objects.get_mut(&pod) {
                change(pod);
                let version: u64 = pod["metadata"]["resourceVersion"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                pod["metadata"]["resourceVersion"] = (version + 1).to_string().into();
            }
            state.sync();
        })
    }
    /// A rolling update replaced the gateway Pod: same name, new identity.
    pub fn replace_gateway(&self) {
        let next = uid(21_000 + self.log.lock().unwrap().len() as u64);
        *self.gateway.pod.lock().unwrap() = next.clone();
        self.server.edit("Pod", Some(SYSTEM), "gateway-0", |pod| {
            pod["metadata"]["uid"] = next.clone().into();
        });
    }
    /// Short confirmation windows keep negative cases fast.
    pub fn quick(&mut self) {
        self.reconciler.power.stop_budget = std::time::Duration::from_millis(300);
        self.reconciler.accept_budget = std::time::Duration::from_millis(600);
    }
    /// PostgreSQL stops the way CNPG's fence stops it: the socket refuses, the exporter says
    /// fenced, and the Pod is not ready.
    pub fn stopped(&self) {
        self.stop_postgres();
        self.gateway.fenced(true);
        self.pod(false);
    }
    /// A database that went through a complete idle sleep into the parked tier.
    pub async fn parked() -> Self {
        let mut w = Self::awake().await;
        w.quick();
        assert!(w.sleep_pass().await.is_none(), "the first pass fences");
        w.stopped();
        let observed = w.sleep_pass().await.expect("a parked observation");
        assert_eq!(
            observed["power"]["parked"]["pod_uid"],
            pod_uid(),
            "{observed}"
        );
        w
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
