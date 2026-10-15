// SPDX-License-Identifier: Apache-2.0
//! A complete in-process world around one database on a thick volume for the parked sleep tier's
//! tests: its Kubernetes objects in the API double, a gateway control and exporter endpoint, and
//! a PostgreSQL socket. The controller's real code runs against it; nothing here is product code.
use crate::{
    api::DesiredSnapshot,
    contracts::{namespace, text},
    manifests,
    reconcile::Reconciler,
    test_postgres::{Answer, Authority, Cell, Handler, Postgres},
    test_server::{Server, uid},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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
pub const POSTGRES_CONTAINER: &str = "containerd://postgres-container-0001";
pub const SIDECAR_CONTAINER: &str = "containerd://sidecar-container-0001";
pub const BOOT_ID: &str = "01234567-89ab-4def-8123-0000000000b1";
pub const HANDLE: &str = "pvc-01234567-89ab-4def-8123-000000000006";

/// The gateway Pod's control endpoint and the instance Pod's exporter, behind an HTTP proxy.
pub struct Gateway {
    pub client: reqwest::Client,
    /// The text `GET /metrics` answers.
    pub metrics: Arc<Mutex<String>>,
    /// The UID of the gateway Pod the control endpoint answers for.
    pub pod: Arc<Mutex<String>>,
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
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (served, log, current) = (served.clone(), log.clone(), current.clone());
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

/// What the PostgreSQL double answers; tests change it between passes.
#[derive(Clone)]
pub struct Sql {
    pub busy: i32,
    pub prepared: i32,
    /// The closed segment `pg_switch_wal()` reports and whether its `.done` exists.
    pub segment: String,
    pub archived: bool,
    pub postmaster_age_ms: i64,
    pub recovery: bool,
}
impl Default for Sql {
    fn default() -> Self {
        Self {
            busy: 0,
            prepared: 0,
            segment: "000000010000000000000007".into(),
            archived: true,
            postmaster_age_ms: 5,
            recovery: false,
        }
    }
}
/// PostgreSQL answers only while its instance is unfenced: CNPG's instance manager does not
/// start it before the fence annotation is gone.
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
        let kind = if sql.contains("pg_postmaster_start_time") {
            "accepting".to_string()
        } else if sql.contains("current_setting('server_version')") {
            "role login".to_string()
        } else if sql.contains("pg_stat_archiver") {
            "archive".to_string()
        } else {
            sql.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
        };
        log.lock().unwrap().push(format!("SQL {user} {kind}"));
        let text = |v: &str| Cell::Text(v.to_string());
        let one = |row: Vec<(&'static str, Cell)>| Answer::Rows(vec![row]);
        let size = &db["size"];
        let memory = crate::contracts::number(size, "memory_mib");
        let request = crate::contracts::optional_number(size, "memory_request_mib", memory);
        if sql.contains("pg_stat_clear_snapshot") {
            one(vec![("pg_stat_clear_snapshot", text(""))])
        } else if sql.contains("pg_prepared_xacts") {
            one(vec![
                ("busy", Cell::Int4(s.busy)),
                ("prepared", Cell::Int4(s.prepared)),
            ])
        } else if sql.contains("pg_switch_wal") {
            one(vec![
                ("lsn", text("0/7000000")),
                ("segment", text(&s.segment)),
            ])
        } else if sql.contains("pg_ls_archive_statusdir() WHERE name=$1") {
            let _ = parameters;
            one(vec![("done", Cell::Bool(s.archived))])
        } else if sql.contains("pg_postmaster_start_time") {
            one(vec![
                ("database", text(crate::contracts::text(&db, "id"))),
                ("recovery", Cell::Bool(s.recovery)),
                ("tls", Cell::Bool(true)),
                ("server_address", text(POD_IP)),
                ("postmaster_age_ms", Cell::Int8(s.postmaster_age_ms)),
            ])
        } else if sql.contains("server_address") {
            one(vec![
                ("database", text(crate::contracts::text(&db, "id"))),
                ("role", text(user)),
                ("recovery", Cell::Bool(s.recovery)),
                ("server_address", text(POD_IP)),
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
            one(vec![
                ("ready_wal_files", text("0")),
                ("archived_count", text("5")),
                ("last_archived_time", text(&(now_ms() / 1000).to_string())),
                ("failed_count", text("0")),
            ])
        } else if sql.contains("current_setting('server_version')") {
            one(vec![
                ("current_user", text(user)),
                ("server_version", text("18.1")),
                ("server_version_num", Cell::Int4(180001)),
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
                ("current_database", text(crate::contracts::text(&db, "id"))),
                ("inet_server_addr", text(POD_IP)),
                ("pg_is_in_recovery", Cell::Bool(s.recovery)),
            ])
        } else if sql.contains("FROM pg_roles WHERE rolname=current_user") {
            one(vec![
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                ("rolbypassrls", Cell::Bool(false)),
                ("rolcanlogin", Cell::Bool(true)),
            ])
        } else if sql.contains("pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats") {
            one(vec![
                ("database", text(crate::contracts::text(&db, "id"))),
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
        let postgres = Postgres::start(
            &self.authority,
            &format!("database-rw.{}.svc", self.ns),
            address,
            answers(self.db.clone(), self.sql.clone(), fenced, self.log.clone()),
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
