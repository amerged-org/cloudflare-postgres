// SPDX-License-Identifier: Apache-2.0
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{SinkExt, StreamExt};
use pgcf_native_controller::{
    Error,
    api::{ControlApi, DesiredSnapshot},
    contracts::{constant, number, schema_valid, text},
    kubernetes::Kubernetes,
    measurements::Measurements,
    reconcile::Reconciler,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::{AbortHandle, JoinSet},
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

enum Hint {
    Pull(Option<Vec<String>>),
    Kube(String),
}
struct Cell {
    db: Value,
    snapshot: Arc<DesiredSnapshot>,
    fingerprint: Vec<u8>,
    due: Instant,
    hints: u64,
    ready: bool,
    renew: bool,
    attempt: u32,
    authority_at: Instant,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Reconcile,
    Renew,
    Protect,
}
type PullResult = (Option<Vec<String>>, Instant, Result<DesiredSnapshot, Error>);
type JobResult = (
    String,
    u64,
    u64,
    Instant,
    JobKind,
    Result<Option<Value>, Error>,
);
struct Active {
    task: tokio::task::Id,
    abort: AbortHandle,
    kind: JobKind,
}
fn fingerprint(db: &Value, snapshot: &DesiredSnapshot) -> Result<Vec<u8>, Error> {
    let mut db = db.clone();
    db.as_object_mut()
        .ok_or("desired item invalid")?
        .remove("storage_authority");
    Ok(Sha256::digest(serde_json::to_vec(&json!({"database":db,"backup":snapshot.region["backup"],"recovery_sources":snapshot.region["recovery_sources"],"fleet":snapshot.fleet_release,"compute_pool":snapshot.region["compute_pool"]}))?).to_vec())
}
fn apply_snapshot(
    cells: &mut HashMap<String, Cell>,
    active: &HashMap<String, Active>,
    snapshot: DesiredSnapshot,
    requested: Option<&[String]>,
    pulled_at: Instant,
) -> Result<(), Error> {
    let snapshot = Arc::new(snapshot);
    let ids: HashSet<_> = snapshot
        .databases
        .iter()
        .map(|db| text(db, "id").to_string())
        .collect();
    let absent: Vec<_> = cells
        .iter()
        .filter(|(id, cell)| {
            cell.authority_at <= pulled_at
                && !ids.contains(*id)
                && requested.is_none_or(|requested| requested.contains(*id))
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in absent {
        if let Some(job) = active.get(&id) {
            job.abort.abort();
        }
        cells.remove(&id);
    }
    for db in &snapshot.databases {
        let id = text(db, "id").to_string();
        let hash = fingerprint(db, &snapshot)?;
        let due = Instant::now();
        if let Some(cell) = cells.get_mut(&id) {
            if number(db, "generation") < number(&cell.db, "generation")
                || pulled_at < cell.authority_at
            {
                continue;
            }
            cell.authority_at = pulled_at;
            let changed = cell.fingerprint != hash;
            let host_changed =
                host_write_state(&cell.db, &cell.snapshot) != host_write_state(db, &snapshot);
            if changed || host_changed {
                if let Some(job) = active.get(&id) {
                    job.abort.abort();
                }
                cell.ready = false;
                cell.renew = false;
                cell.attempt = 0;
                cell.due = due;
                cell.hints = cell.hints.wrapping_add(1);
            } else if cell.ready && db["storage_authority"] != cell.db["storage_authority"] {
                cell.renew = true;
                cell.due = due;
                cell.hints = cell.hints.wrapping_add(1);
            }
            cell.db = db.clone();
            cell.snapshot = snapshot.clone();
            cell.fingerprint = hash;
        } else {
            cells.insert(
                id,
                Cell {
                    db: db.clone(),
                    snapshot: snapshot.clone(),
                    fingerprint: hash,
                    due,
                    hints: 0,
                    ready: false,
                    renew: false,
                    attempt: 0,
                    authority_at: pulled_at,
                },
            );
        }
    }
    Ok(())
}
fn host_write_state(db: &Value, snapshot: &DesiredSnapshot) -> Value {
    if db["storage"].is_null() {
        return Value::Null;
    }
    let authority = snapshot.region["storage_nodes"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["node_uid"] == db["storage"]["node_uid"])
        });
    authority.map_or(Value::Null,|a|json!({"node_uid":a["node_uid"],"profile_sha256":a["profile_sha256"],"volume_group_uuid":a["volume_group_uuid"],"pool_uuid":a["pool_uuid"],"write_allowed":a["write_allowed"]}))
}
fn storage_protection_due(db: &Value, snapshot: &DesiredSnapshot, clock: i128) -> bool {
    if db["storage"].is_null() || text(db, "desired_state") != "running" {
        return false;
    }
    let parse = |v: &Value| {
        v.as_str()
            .and_then(|s| {
                time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
            })
            .map(|t| t.unix_timestamp_nanos() / 1_000_000)
    };
    let authority = snapshot.region["storage_nodes"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| row["node_uid"] == db["storage"]["node_uid"])
        });
    let Some(authority) = authority else {
        return true;
    };
    if authority["write_allowed"] != true
        || parse(&authority["expires_at"]).is_none_or(|expiry| expiry <= clock)
    {
        return true;
    }
    let token = db["storage_authority"].as_str();
    if token.is_none() {
        return db["storage_startup"]["generation"] != db["generation"]
            || db["storage_startup"]["node_uid"] != db["storage"]["node_uid"]
            || parse(&db["storage_startup"]["expires_at"]).is_none_or(|expiry| expiry <= clock);
    }
    // This only chooses an earlier protective stop. It never authorizes a write:
    // the gateway independently verifies the deployment-pinned CF signature.
    let parts: Vec<_> = token.unwrap_or("").split('.').collect();
    if parts.len() != 3 || parts[0] != "sa1" {
        return true;
    }
    let claims = URL_SAFE_NO_PAD
        .decode(parts[1])
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    claims.is_none_or(|claims| {
        !pgcf_native_protocol::valid_schema("storageWriteClaims", &claims)
            || claims["database_id"] != db["id"]
            || claims["generation"] != db["generation"]
            || claims["node_uid"] != db["storage"]["node_uid"]
            || claims["write_allowed"] != true
            || pgcf_native_controller::contracts::integer(&claims, "exp")
                .map_or(true, |expiry| i128::from(expiry) <= clock)
    })
}
fn clock_ms() -> i128 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}
fn manifest() -> Result<Value, Error> {
    let source = option_env!("PGCF_SOURCE_REVISION").ok_or("unqualified controller build")?;
    let rust = option_env!("PGCF_RUST_VERSION").ok_or("unqualified compiler")?;
    let versions = option_env!("PGCF_VERSIONS_LOCK_SHA256").ok_or("unqualified release lock")?;
    let cargo = option_env!("PGCF_CARGO_LOCK_SHA256").ok_or("unqualified dependency lock")?;
    if source.len() != 40
        || !source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("unqualified controller source".into());
    }
    Ok(
        json!({"program":"pgcf-native-controller","version":env!("CARGO_PKG_VERSION"),"sourceRevision":source,"rustVersion":rust,"versionsLockSha256":versions,"cargoLockSha256":cargo,"protocolSha256":option_env!("PGCF_PROTOCOL_SHA256").ok_or("unqualified protocol contract")?,"controllerContractSha256":option_env!("PGCF_CONTROLLER_CONTRACT_SHA256").ok_or("unqualified controller contract")?,"configurationSchemaRevision":constant("CONFIGURATION_SCHEMA_REVISION")}),
    )
}
async fn link(api: ControlApi, hints: mpsc::Sender<Hint>) {
    loop {
        let result = async {
            let mut url = api.origin.join("/agent/v1/link")?;
            url.set_scheme("wss").map_err(|_| "invalid regional link scheme")?;
            let mut request = url.as_str().into_client_request()?;
            request.headers_mut().insert("Authorization",format!("Bearer {}",api.key().await?).parse()?);
            let config=WebSocketConfig::default().max_message_size(Some(64*1024)).max_frame_size(Some(64*1024));
            let (socket,_) = tokio::time::timeout(Duration::from_secs(20),connect_async_with_config(request,Some(config),false)).await??;
            let (mut send,mut receive)=socket.split();
            let instance=format!("{}-{}",std::process::id(),time::OffsetDateTime::now_utc().unix_timestamp_nanos());
            send.send(Message::Text(json!({"type":"hello","protocol":constant("AGENT_PROTOCOL_VERSION"),"agent_version":"native-0.1.0","instance_id":instance}).to_string().into())).await?;
            let mut welcome=false;
            let welcome_deadline=Instant::now()+Duration::from_secs(20);
            let mut pong=true;
            let mut heartbeat=tokio::time::interval_at(Instant::now()+Duration::from_secs(30),Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(welcome_deadline), if !welcome => return Err::<(),Error>("regional link welcome deadline exceeded".into()),
                    event = receive.next() => {
                        match event.ok_or("regional link closed")?? {
                            Message::Text(bytes) => {
                                let value:Value=serde_json::from_str(&bytes)?;
                                if !schema_valid("ServerLinkMessage",&value){return Err("regional link message invalid".into());}
                                match text(&value,"type") {
                                    "welcome" if !welcome => { welcome=true;hints.send(Hint::Pull(None)).await.map_err(|_|"controller queue closed")?; },
                                    "desired" if welcome => { let ids=value["ids"].as_array().map(|ids|ids.iter().filter_map(Value::as_str).map(str::to_string).collect());hints.send(Hint::Pull(ids)).await.map_err(|_|"controller queue closed")?; },
                                    _ => return Err("regional link message order invalid".into())
                                }
                            },
                            Message::Ping(bytes) => send.send(Message::Pong(bytes)).await?,
                            Message::Pong(_) => pong=true,
                            Message::Close(_) => return Ok(()),
                            _ => return Err("regional link frame invalid".into())
                        }
                    },
                    _ = heartbeat.tick() => {
                        if !pong{return Err("regional link heartbeat lost".into());}
                        pong=false;send.send(Message::Ping(Vec::new().into())).await?;
                    }
                }
            }
        }.await;
        if result.is_err() {
            eprintln!("{{\"event\":\"regional_link_reconnecting\"}}");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}};
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
async fn run() -> Result<(), Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if std::env::args().any(|a| a == "--help") {
        println!(
            "PGCF native controller: PGCF_REGION_ID PGCF_API_URL PGCF_AGENT_KEY_FILE PGCF_CLUSTER_UID PGCF_POSTGRES_IMAGE PGCF_GATEWAY_REPLICAS"
        );
        return Ok(());
    }
    let qualified = manifest()?;
    if std::env::args().any(|a| a == "--inspect-manifest" || a == "--version") {
        println!("{qualified}");
        return Ok(());
    }
    let api = ControlApi::from_env().await?;
    let kube = Kubernetes::in_cluster().await?;
    let cluster = std::env::var("PGCF_CLUSTER_UID")?;
    let image = std::env::var("PGCF_POSTGRES_IMAGE")?;
    let replicas: usize = std::env::var("PGCF_GATEWAY_REPLICAS")?.parse()?;
    let controller = Arc::new(Reconciler::new(
        kube.clone(),
        cluster,
        image,
        api.region.clone(),
        replicas,
    )?);
    let measurements = Arc::new(Measurements::new(
        kube.clone(),
        api.clone(),
        controller.clone(),
    )?);
    let (hints, mut incoming) = mpsc::channel(512);
    tokio::task::spawn_local(link(api.clone(), hints.clone()));
    for kind in ["Pod", "Cluster", "PersistentVolumeClaim"] {
        let kube = kube.clone();
        let hints = hints.clone();
        tokio::task::spawn_local(async move {
            loop {
                let (events, mut receive) = mpsc::channel(512);
                let task = tokio::task::spawn_local({
                    let kube = kube.clone();
                    async move { kube.watch_database_ids(kind, events).await }
                });
                while let Some(id) = receive.recv().await {
                    if hints.send(Hint::Kube(id)).await.is_err() {
                        task.abort();
                        return;
                    }
                }
                let _ = task.await;
                let _ = hints.send(Hint::Pull(None)).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }
    let mut cells: HashMap<String, Cell> = HashMap::new();
    let mut active: HashMap<String, Active> = HashMap::new();
    let mut jobs: JoinSet<JobResult> = JoinSet::new();
    let mut pulls: JoinSet<PullResult> = JoinSet::new();
    let mut pull_full = false;
    let mut control_healthy = false;
    let mut have_full_snapshot = false;
    let mut latest_snapshot: Option<(Instant, Arc<DesiredSnapshot>)> = None;
    let mut inventories: JoinSet<Result<(), Error>> = JoinSet::new();
    let mut metering: JoinSet<Result<(), Error>> = JoinSet::new();
    let mut meter_interval = tokio::time::interval(Duration::from_millis(250));
    let mut node_interval = tokio::time::interval(Duration::from_secs(60));
    let mut pull_ids = HashSet::new();
    let mut full = tokio::time::interval(Duration::from_secs(60));
    let mut cadence = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            _ = shutdown() => break,
            _ = meter_interval.tick() => {
                if control_healthy && have_full_snapshot && metering.is_empty() {
                    let measurements=measurements.clone();
                    let databases:Vec<_>=cells.values().filter(|cell|Instant::now().duration_since(cell.authority_at)<=Duration::from_secs(90)).map(|cell|cell.db.clone()).collect();
                    metering.spawn_local(async move {measurements.cycle(&databases).await});
                }
            },
            result=metering.join_next(), if !metering.is_empty() => {
                if !matches!(result,Some(Ok(Ok(())))) {eprintln!("{{\"event\":\"measurement_cycle_unknown\"}}");}
            },
            _ = node_interval.tick() => {
                if control_healthy && have_full_snapshot && inventories.is_empty() {
                    let kube = kube.clone();
                    let api = api.clone();
                    let ids = cells.keys().cloned().collect();
                    let controller = controller.clone();
                    let fleet=latest_snapshot.as_ref().map(|(_,snapshot)|snapshot.fleet_release.clone()).unwrap_or(Value::Null);
                    let databases: Vec<_> = cells.values()
                        .filter(|cell| text(&cell.db, "desired_state") != "deleted")
                        .map(|cell| cell.db.clone()).collect();
                    inventories.spawn_local(async move {
                        kube.assert_cluster(&controller.cluster_uid).await?;
                        tokio::time::timeout(Duration::from_secs(45), async {
                            pgcf_native_controller::inventory::collect(&kube, &api, &ids).await?;
                            let mut work = futures_util::stream::iter(databases.iter()
                                .map(|db| controller.health.refresh(&kube, db))).buffer_unordered(4);
                            while let Some(result) = work.next().await { result?; }
                            pgcf_native_controller::fleet::collect(&kube,&api,&fleet).await?;
                            Ok::<(), Error>(())
                        }).await.map_err(|_| "node collection deadline exceeded")?
                    });
                }
            },
            result = inventories.join_next(), if !inventories.is_empty() => {
                if !matches!(result, Some(Ok(Ok(())))) {
                    eprintln!("{{\"event\":\"node_inventory_unknown\"}}");
                }
            },
            _ = full.tick() => {
                if !pull_full {
                    pull_full = true;
                    let api = api.clone();
                    pulls.spawn_local(async move { (None, Instant::now(), api.desired(None).await) });
                }
            },
            hint = incoming.recv() => {
                match hint {
                    Some(Hint::Pull(None)) => {
                        if !pull_full {
                            pull_full = true;
                            let api = api.clone();
                            pulls.spawn_local(async move { (None, Instant::now(), api.desired(None).await) });
                        }
                    },
                    Some(Hint::Pull(Some(ids))) => pull_ids.extend(ids),
                    Some(Hint::Kube(id)) => {
                        if let Some(cell) = cells.get_mut(&id) {
                            cell.due = Instant::now();
                            cell.hints = cell.hints.wrapping_add(1);
                        } else { pull_ids.insert(id); }
                    },
                    None => break
                }
            },
            result = pulls.join_next(), if !pulls.is_empty() => {
                if let Some(Ok((requested, pulled_at, result))) = result {
                    let is_full = requested.is_none();
                    if is_full { pull_full = false; }
                    match result {
                        Ok(snapshot) => {
                            if is_full { control_healthy = true; have_full_snapshot = true; }
                            if latest_snapshot.as_ref().is_none_or(|(at,_)|pulled_at>=*at) {latest_snapshot=Some((pulled_at,Arc::new(snapshot.clone())));}
                            apply_snapshot(&mut cells, &active, snapshot, requested.as_deref(), pulled_at)?;
                        },
                        Err(_) => {
                            control_healthy = false;
                            eprintln!("{{\"event\":\"desired_pull_failed\"}}");
                        }
                    }
                } else {
                    pull_full = false;
                    control_healthy = false;
                }
            },
            result = jobs.join_next_with_id(), if !jobs.is_empty() => {
                match result {
                    Some(Ok((task, (id, generation, marker, started, kind, result)))) => {
                        if active.get(&id).is_some_and(|job| job.task == task) { active.remove(&id); }
                        if let Some(cell) = cells.get_mut(&id) {
                            if number(&cell.db, "generation") != generation {
                                cell.due = Instant::now();
                                continue;
                            }
                            if kind == JobKind::Renew {
                                if result.is_ok() && cell.hints == marker {
                                    cell.renew = false;
                                    cell.due = started + Duration::from_secs(60);
                                } else { cell.due = Instant::now() + Duration::from_secs(1); }
                                continue;
                            }
                            match result {
                                Ok(Some(observed)) => {
                                    let ready = matches!(text(&observed, "state"), "ready" | "deleted" | "hibernated");
                                    cell.ready = ready;
                                    cell.attempt = 0;
                                    cell.due = started + Duration::from_secs(if ready { 60 } else { 1 });
                                },
                                Ok(None) => cell.due = started + Duration::from_secs(1),
                                Err(_) => {
                                    pull_ids.insert(id.clone());
                                    cell.attempt = cell.attempt.saturating_add(1);
                                    cell.due = Instant::now() + Duration::from_secs((1_u64 << cell.attempt.min(8)).min(300));
                                    eprintln!("{}", json!({"event":"database_reconcile_failed", "database_id":id, "generation":generation}));
                                }
                            }
                            if cell.hints != marker { cell.due = Instant::now(); }
                        }
                    },
                    Some(Err(error)) => {
                        if let Some(id) = active.iter().find(|(_, job)| job.task == error.id()).map(|(id, _)| id.clone()) {
                            active.remove(&id);
                            if let Some(cell) = cells.get_mut(&id) { cell.due = Instant::now(); }
                        }
                    },
                    None => {}
                }
            },
            _ = cadence.tick() => {}
        }

        if !pull_ids.is_empty() && pulls.len() < 4 {
            let ids: Vec<_> = pull_ids.iter().take(200).cloned().collect();
            for id in &ids {
                pull_ids.remove(id);
            }
            let api = api.clone();
            pulls.spawn_local(async move {
                let started = Instant::now();
                let result = api.desired(Some(&ids)).await;
                (Some(ids), started, result)
            });
        }
        for (id, job) in &active {
            if job.kind != JobKind::Protect
                && cells.get(id).is_some_and(|cell| {
                    storage_protection_due(&cell.db, &cell.snapshot, clock_ms())
                })
            {
                job.abort.abort();
            }
        }
        if active.len() < 4 {
            let mut candidates: Vec<_> = cells
                .iter()
                .filter(|(id, cell)| {
                    let protect = storage_protection_due(&cell.db, &cell.snapshot, clock_ms());
                    (cell.due <= Instant::now() || (cell.ready && protect))
                        && (protect
                            || (control_healthy
                                && Instant::now().duration_since(cell.authority_at)
                                    <= Duration::from_secs(90)))
                        && !active.contains_key(*id)
                })
                .map(|(id, cell)| {
                    (
                        !storage_protection_due(&cell.db, &cell.snapshot, clock_ms()),
                        cell.due,
                        id.clone(),
                    )
                })
                .collect();
            // Pending databases rotate by oldest due time; a slow first cohort cannot
            // monopolize all four bounded reconciliation slots.
            candidates.sort();
            let candidates: Vec<_> = candidates
                .into_iter()
                .take(4 - active.len())
                .map(|(_, _, id)| id)
                .collect();
            for id in candidates {
                let cell = &cells[&id];
                let db = cell.db.clone();
                let snapshot = cell.snapshot.clone();
                let generation = number(&db, "generation");
                let marker = cell.hints;
                let controller = controller.clone();
                let api = api.clone();
                let kind = if storage_protection_due(&db, &snapshot, clock_ms()) {
                    JobKind::Protect
                } else if cell.renew && cell.ready {
                    JobKind::Renew
                } else {
                    JobKind::Reconcile
                };
                let job_id = id.clone();
                let started = Instant::now();
                let abort = jobs.spawn_local(async move {
                    let result = async {
                        if kind == JobKind::Protect {
                            return controller.power.protect_storage(&db).await;
                        }
                        if kind == JobKind::Renew {
                            controller.renew_storage_authority(&db).await?;
                            return Ok::<_, Error>(None);
                        }
                        let observed = tokio::time::timeout(
                            Duration::from_secs(30),
                            controller.reconcile(&db, &snapshot),
                        )
                        .await
                        .map_err(|_| "database reconcile deadline exceeded")??;
                        if let Some(observation) = &observed
                            && (db["power"].is_null()
                                || !observation["power"].is_null()
                                || matches!(
                                    text(observation, "state"),
                                    "ready" | "deleted" | "hibernated"
                                ))
                        {
                            api.observation(observation.clone()).await?;
                        }
                        Ok(observed)
                    }
                    .await;
                    (job_id, generation, marker, started, kind, result)
                });
                active.insert(
                    id,
                    Active {
                        task: abort.id(),
                        abort,
                        kind,
                    },
                );
            }
        }
    }
    inventories.abort_all();
    metering.abort_all();
    pulls.abort_all();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let local = tokio::task::LocalSet::new();
    if local.run_until(run()).await.is_err() {
        eprintln!("{{\"event\":\"native_controller_failed\"}}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(rows: Vec<Value>) -> DesiredSnapshot {
        DesiredSnapshot {
            region: json!({"backup":{}}),
            fleet_release: Value::Null,
            databases: rows,
        }
    }
    #[test]
    fn delayed_target_pulls_never_downgrade_or_remove_newer_rows() {
        let mut cells = HashMap::new();
        let active = HashMap::new();
        let started = Instant::now();
        apply_snapshot(
            &mut cells,
            &active,
            snapshot(vec![
                json!({"id":"a","generation":2}),
                json!({"id":"b","generation":1}),
            ]),
            None,
            started + Duration::from_secs(1),
        )
        .unwrap();
        apply_snapshot(
            &mut cells,
            &active,
            snapshot(vec![json!({"id":"a","generation":1})]),
            Some(&["a".into()]),
            started,
        )
        .unwrap();
        assert_eq!(cells["a"].db["generation"], 2);
        apply_snapshot(&mut cells, &active, snapshot(vec![]), None, started).unwrap();
        assert_eq!(cells.len(), 2);
        apply_snapshot(
            &mut cells,
            &active,
            snapshot(vec![]),
            Some(&["a".into()]),
            started + Duration::from_secs(2),
        )
        .unwrap();
        assert!(!cells.contains_key("a"));
        assert!(cells.contains_key("b"));
    }
    #[test]
    fn expired_cached_storage_authority_requires_local_stop_without_cf_pull() {
        let db = json!({"id":"a","generation":1,"desired_state":"running","storage":{"node_uid":"same"},"storage_startup":{"generation":1,"node_uid":"same","expires_at":"1970-01-01T00:00:02.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":"same","write_allowed":true,"expires_at":"1970-01-01T00:00:03.000Z"}]});
        assert!(!storage_protection_due(&db, &state, 1000));
        assert!(storage_protection_due(&db, &state, 2000));
        assert!(storage_protection_due(&db, &state, 3000));
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert!(storage_protection_due(&db, &state, 1000));
    }
    #[test]
    fn runtime_lease_rotation_is_not_a_configuration_change() {
        let db = json!({"id":"a","generation":1,"storage_authority":"old"});
        let mut new = db.clone();
        new["storage_authority"] = "renewed".into();
        assert_eq!(
            fingerprint(&db, &snapshot(vec![])).unwrap(),
            fingerprint(&new, &snapshot(vec![])).unwrap()
        );
    }
}
