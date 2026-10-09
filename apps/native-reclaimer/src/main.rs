// SPDX-License-Identifier: Apache-2.0
use pgcf_native_controller::kubernetes::Kubernetes;
use pgcf_native_reclaimer::{
    Error,
    authority::{Trust, Verified, file, limit, text, unsigned, valid_at},
    state::State,
    target::{Target, bounded_json, encrypted_swap, kube_binding},
    worker::{Outcome, Worker},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    node_uid: String,
    node_name: String,
    boot_id: String,
    cluster_uid: String,
    material_revision: u64,
    public_keys: BTreeMap<String, String>,
    public_keys_sha256: String,
    encrypted_swap_dm_uuids: Vec<String>,
}
fn now() -> Result<u64, Error> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
async fn run() -> Result<(), Error> {
    if std::env::args().any(|a| a == "--help") {
        println!(
            "PGCF native reclaimer: fixed /etc/pgcf-reclaimer/settings.json; no control-plane write credentials or CRI socket"
        );
        return Ok(());
    }
    if std::env::args().any(|a| a == "--version") {
        println!(
            "{}",
            json!({"program":"pgcf-native-reclaimer","version":env!("CARGO_PKG_VERSION"),"sourceRevision":option_env!("PGCF_SOURCE_REVISION"),"rustVersion":option_env!("PGCF_RUST_VERSION"),"versionsLockSha256":option_env!("PGCF_VERSIONS_LOCK_SHA256"),"cargoLockSha256":option_env!("PGCF_CARGO_LOCK_SHA256"),"protocolSha256":option_env!("PGCF_PROTOCOL_SHA256"),"reclaimContractSha256":option_env!("PGCF_RECLAIM_CONTRACT_SHA256")})
        );
        return Ok(());
    }
    if unsafe { libc::geteuid() } != 65532 || unsafe { libc::getegid() } != 65532 {
        return Err("reclaimer requires dedicated unprivileged UID/GID65532".into());
    }
    let settings: Settings = serde_json::from_value(bounded_json(
        Path::new("/etc/pgcf-reclaimer/settings.json"),
        16384,
    )?)?;
    for uid in [&settings.node_uid, &settings.boot_id, &settings.cluster_uid] {
        if !pgcf_native_protocol::valid_pattern("uuid", uid) {
            return Err("reclaimer pinned node identity invalid".into());
        }
    }
    let trust = Trust::new(
        &serde_json::to_string(&settings.public_keys)?,
        &settings.public_keys_sha256,
    )?;
    let kube = Kubernetes::in_cluster().await?;
    let mut state = State::load(
        Path::new(file("state")),
        &settings.node_uid,
        &settings.boot_id,
    )?;
    let mut active: Option<(Worker, Value, Target, Value, Instant)> = None;
    let mut accepted: BTreeMap<String, (Verified, Instant, Duration)> = BTreeMap::new();
    let mut reports: BTreeMap<String, Value> = BTreeMap::new();
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {_=tokio::signal::ctrl_c()=>break,_=interval.tick()=>{}}
        let clock = now()?;
        let intents = bounded_json(
            Path::new(file("intents")),
            limit("max_envelope_bytes") as usize,
        );
        let mut deliveries = BTreeMap::new();
        let mut delivery_expiry = clock;
        if let Ok(envelope) = intents {
            if !pgcf_native_reclaimer::authority::schema("ReclaimIntentSnapshot", &envelope)
                || envelope["material_revision"] != settings.material_revision
                || unsigned(&envelope, "issued_at")
                    .map_or(true, |issued| issued > clock.saturating_add(1000))
                || unsigned(&envelope, "expires_at").map_or(true, |expires| {
                    unsigned(&envelope, "issued_at")
                        .map_or(true, |issued| expires > issued.saturating_add(2000))
                })
                || envelope["node_uid"] != settings.node_uid
                || envelope["boot_id"] != settings.boot_id
                || unsigned(&envelope, "expires_at").map_or(true, |expiry| expiry <= clock)
            {
                accepted.clear();
            } else if let Some(tokens) = envelope["tokens"]
                .as_array()
                .filter(|tokens| tokens.len() <= 4096)
            {
                delivery_expiry = unsigned(&envelope, "expires_at")?;
                for token in tokens {
                    let Some(token) = token.as_str() else {
                        continue;
                    };
                    let Ok(authority) = trust.verify(token, clock) else {
                        continue;
                    };
                    if authority.claims()["cluster_uid"] != settings.cluster_uid {
                        continue;
                    }
                    let id = text(authority.claims(), "database_id").to_owned();
                    if deliveries.contains_key(&id) {
                        deliveries.clear();
                        accepted.clear();
                        break;
                    }
                    deliveries.insert(id, authority);
                }
            }
        } else {
            accepted.clear();
        }
        accepted.retain(|id, _| deliveries.contains_key(id));
        for (id, authority) in deliveries {
            let prior = state.entries.get(&id).cloned();
            if state.accept(&authority, clock).is_err() {
                accepted.remove(&id);
                continue;
            }
            if state.entries.get(&id) != prior.as_ref() {
                state.save(Path::new(file("state")))?;
            }
            let remaining = Duration::from_millis(
                unsigned(authority.claims(), "expires_at")?
                    .min(delivery_expiry)
                    .saturating_sub(clock),
            );
            let old = accepted.get(&id);
            let remaining = if let Some((old, received, left)) = old {
                if old.claims()["operation_id"] == authority.claims()["operation_id"]
                    && old.claims()["intent_revision"] == authority.claims()["intent_revision"]
                    && old.claims()["issued_at"] == authority.claims()["issued_at"]
                {
                    remaining.min(left.saturating_sub(received.elapsed()))
                } else {
                    remaining
                }
            } else {
                remaining
            };
            accepted.insert(id, (authority, Instant::now(), remaining));
        }
        accepted.retain(|_, (authority, received, left)| {
            received.elapsed() < *left && valid_at(authority.claims(), clock)
        });
        if let Some((worker, claims, target, before, started)) = &mut active
            && let Some(outcome) = worker.poll()?
        {
            let after = target.metrics().ok();
            let report = json!({"database_id":claims["database_id"],"generation":claims["generation"],"storage_generation":claims["storage_generation"],"pod_uid":claims["pod_uid"],"container_id":claims["container_id"],"operation_id":claims["operation_id"],"intent_revision":claims["intent_revision"],"observed_at":clock,"elapsed_ms":started.elapsed().as_millis()as u64,"requested_total_bytes":state.entries.get(text(claims,"database_id")).map(|v|v.spent),"outcome":match outcome{Outcome::Requested=>"requested",Outcome::Partial=>"partial",Outcome::Unknown=>"unknown"},"before":before,"after":after,"reclaimed_bytes":null,"in_flight":false});
            reports.insert(text(claims, "database_id").to_owned(), report);
            active = None;
        }
        // Revocation is acknowledged even while a prior bounded syscall may finish. No further call is scheduled.
        for (authority, _, _) in accepted.values() {
            let claims = authority.claims();
            if claims["mode"] == "revoked" {
                let report = json!({"database_id":claims["database_id"],"generation":claims["generation"],"storage_generation":claims["storage_generation"],"pod_uid":claims["pod_uid"],"container_id":claims["container_id"],"operation_id":claims["operation_id"],"intent_revision":claims["intent_revision"],"observed_at":clock,"outcome":"revoked","in_flight":active.as_ref().is_some_and(|(_,old,_,_,_)|old["database_id"]==claims["database_id"])});
                reports.insert(text(claims, "database_id").to_owned(), report);
            }
        }
        reports.retain(|id, _| accepted.contains_key(id));
        let envelope = json!({"purpose":"pgcf-reclaim-observations/v1","node_uid":settings.node_uid,"boot_id":settings.boot_id,"material_revision":settings.material_revision,"observed_at":clock,"results":reports.values().collect::<Vec<_>>()});
        pgcf_native_reclaimer::state::atomic(
            Path::new(file("report")),
            &serde_json::to_vec(&envelope)?,
            0o644,
        )?;
        if active.is_some() {
            continue;
        }
        let snapshot = match bounded_json(
            Path::new(file("tasks")),
            limit("max_envelope_bytes") as usize,
        ) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if encrypted_swap(&settings.encrypted_swap_dm_uuids).is_err() {
            continue;
        }
        for (authority, received, left) in accepted.values() {
            let claims = authority.claims();
            if claims["mode"] != "reclaim" || received.elapsed() >= *left {
                continue;
            }
            if tokio::time::timeout(
                Duration::from_secs(2),
                kube_binding(&kube, &settings.node_name, claims),
            )
            .await
            .map_or(true, |result| result.is_err())
            {
                continue;
            }
            let clock = now()?;
            if received.elapsed() >= *left || !valid_at(claims, clock) {
                continue;
            }
            let target = match Target::open(&snapshot, claims, clock) {
                Ok(target) => target,
                Err(_) => continue,
            };
            let before = target.metrics()?;
            if unsigned(&before, "memory_current_bytes")?
                <= unsigned(claims, "memory_request_bytes")?
            {
                continue;
            }
            let fd = target.reclaim_fd()?;
            let amount = match state.reserve(claims, clock) {
                Ok(value) => value,
                Err(_) => continue,
            };
            state.save(Path::new(file("state")))?;
            active = Some((
                Worker::start(fd, amount)?,
                claims.clone(),
                target,
                before,
                Instant::now(),
            ));
            break;
        }
    }
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    if run().await.is_err() {
        eprintln!("{{\"event\":\"reclaimer_stopped\"}}");
        std::process::exit(1);
    }
}
