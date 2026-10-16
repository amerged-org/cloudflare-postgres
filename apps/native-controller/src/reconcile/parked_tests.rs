// SPDX-License-Identifier: Apache-2.0
//! The reconciliation of a database that holds a retained instance Pod, against the in-process
//! doubles.
use super::{SYSTEM, *};
use crate::{
    test_server::{Gate, path},
    test_world::*,
};

const FENCE: &str = "cnpg.io/fencedInstances";
const HIBERNATION: &str = "cnpg.io/hibernation";

async fn reconcile_pass(w: &World) -> Option<Value> {
    w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap()
}
async fn reconcile(w: &World) -> Value {
    reconcile_pass(w).await.expect("an observation")
}
fn cluster_path(w: &World) -> String {
    path("Cluster", Some(&w.ns), "database")
}
fn annotations(w: &World) -> Value {
    w.server.get("Cluster", Some(&w.ns), "database").unwrap()["metadata"]["annotations"].clone()
}
fn log(w: &World) -> Vec<String> {
    w.log.lock().unwrap().clone()
}
/// The position of the first log line containing every needle.
fn at(w: &World, needles: &[&str]) -> usize {
    log(w)
        .iter()
        .position(|line| needles.iter().all(|needle| line.contains(needle)))
        .unwrap_or_else(|| panic!("no log line with {needles:?} in {:#?}", log(w)))
}

#[tokio::test]
async fn an_idle_sleep_through_the_reconciler_parks_and_claims_the_fast_wake() {
    // The whole path a sleeping database takes: the desired record of the API, a suspended
    // database without a scheduling request, judged against what its wake would apply.
    let mut w = World::awake().await;
    w.quick();
    assert!(reconcile_pass(&w).await.is_none(), "the first pass fences");
    assert_eq!(annotations(&w)[FENCE], "[\"*\"]");
    w.stopped();
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "hibernated", "{observed}");
    assert_eq!(observed["power"]["parked"]["pod_uid"], pod_uid());
    assert_eq!(observed["power"]["parked"]["wake"], "fast", "{observed}");
    // A role password rotates while the Pod is parked: the next pass demotes it.
    w.db["roles"][0]["password"] = "z".repeat(43).into();
    let withdrawn = reconcile(&w).await;
    assert_eq!(withdrawn["power"]["parked"]["pod_uid"], pod_uid());
    assert!(withdrawn["power"]["parked"].get("wake").is_none());
    assert_eq!(annotations(&w)[HIBERNATION], "on");
}

/// The attested target the gateway routes to a Pod by, as the controller persisted it in the fence.
fn admission_target(w: &World) -> Value {
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    serde_json::from_str(text(&map["data"], "admission_target")).expect("a persisted target")
}
fn pod_ready(w: &World) -> bool {
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    pod["status"]["conditions"].as_array().is_some_and(|all| {
        all.iter()
            .any(|c| c["type"] == "Ready" && c["status"] == "True")
    })
}
fn released(w: &World) -> bool {
    log(w).iter().any(|line| line.contains("GATEWAY release"))
}

#[tokio::test]
async fn a_parked_wake_unfences_resizes_and_publishes_after_sql_identity() {
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    w.log.lock().unwrap().clear();
    let observed = reconcile(&w).await;
    // One pass: the retained Pod's identity and PostgreSQL's own answer prove the wake; the
    // kubelet is not asked for its Ready bit.
    assert_eq!(observed["state"], "ready", "{observed}");
    assert_eq!(observed["power"]["state"], "awake");
    assert_eq!(
        observed["runtime_attestation"]["pod_uid"],
        pod_uid(),
        "{observed}"
    );
    // Order: progress `Wake`, one patch lifting the fence and releasing hibernation and the Pod's
    // requests returning (one wave of three writes), PostgreSQL's fresh postmaster, every role
    // and the archive through the Pod, and only then the gateway release that admits clients.
    let wake = at(&w, &["PATCH", "gateway-fence-", r#"\"phase\":\"wake\""#]);
    let unfence = at(
        &w,
        &[
            "PATCH",
            "/clusters/database",
            r#""cnpg.io/fencedInstances":null"#,
            r#""cnpg.io/hibernation":"off""#,
        ],
    );
    let resize = at(&w, &["PATCH", "/pods/database-1/resize"]);
    let accepting = at(&w, &["SQL pgcf_maintenance accepting"]);
    let roles = at(&w, &["SQL app role login"]);
    let archive = at(&w, &["SQL pgcf_maintenance archive"]);
    let release = at(&w, &["GATEWAY release"]);
    assert!(
        wake < accepting && unfence < accepting && resize < release,
        "the first wave is written before PostgreSQL answers"
    );
    assert!(
        accepting < roles && roles < archive && archive < release,
        "{:#?}",
        log(&w)
            .iter()
            .map(|line| line.chars().take(110).collect::<String>())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        log(&w)
            .iter()
            .filter(|line| line.contains("GATEWAY release"))
            .count(),
        1
    );
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "off");
}

#[tokio::test]
async fn a_resumed_pod_is_attested_and_published_while_the_kubelet_reports_it_not_ready() {
    // The gateway routes to the attested Pod before its Ready condition, so the controller does
    // not wait for it: PostgreSQL's answer on the Pod's own address, the Pod's UID and container
    // and the CA are the proof.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert!(!pod_ready(&w), "the kubelet never reported the Pod Ready");
    assert_eq!(intent_mode(&w), "running");
    let proof = &observed["runtime_attestation"];
    assert_eq!(proof["v"], 2, "{observed}");
    assert_eq!(proof["pod_uid"], pod_uid());
    assert_eq!(proof["pod_ip"], POD_IP);
    let container = POSTGRES_CONTAINER.strip_prefix("containerd://").unwrap();
    assert_eq!(proof["container_id"], container);
    // What the gateway checks the watched Pod and CA against.
    let target = admission_target(&w);
    assert_eq!(target["generation"], 3);
    assert_eq!(target["pod_uid"], pod_uid());
    assert_eq!(target["container_id"], container);
    assert_eq!(target["ca_secret_uid"], proof["ca_secret_uid"]);
    assert_eq!(target["ca_sha256"], proof["ca_sha256"]);
    assert_eq!(
        target["tls_server_name"],
        format!("database-rw.{}.svc", w.ns)
    );
}

#[tokio::test]
async fn a_kubelet_that_reports_ready_while_the_chain_runs_does_not_cost_the_attestation() {
    // With the Ready bit not awaited it arrives at any point of the chain, and CNPG writes the
    // Cluster status after it: the attestation is read back against what the probe read last.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let ready = w.kubelet_ready_now();
    w.sql.lock().unwrap().during.insert("archive", ready);
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert!(pod_ready(&w));
    assert!(at(&w, &["KUBELET ready"]) < at(&w, &["GATEWAY release"]));
    let proof = &observed["runtime_attestation"];
    assert_eq!(proof["v"], 2, "{observed}");
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    assert_eq!(
        proof["observation"]["resource_versions"]["pod"],
        pod["metadata"]["resourceVersion"]
    );
    assert_eq!(admission_target(&w)["pod_uid"], pod_uid());
}

#[tokio::test]
async fn a_resumed_pod_that_cannot_be_attested_is_published_once_the_kubelet_reports_it_ready() {
    // Without a v2 attestation the gateway cannot route to a Pod that is not Ready: publishing it
    // would send the waking connection to no endpoint.
    let mut w = World::parked().await;
    w.quick();
    w.wake(3);
    w.start_postgres().await;
    let first = reconcile(&w).await;
    assert_eq!(first["state"], "provisioning", "{first}");
    assert_eq!(intent_mode(&w), "quiesce");
    assert!(!released(&w));
    assert!(
        annotations(&w)[FENCE].is_null(),
        "the unfence is not undone"
    );
    // The kubelet reports the Pod ready: the next pass publishes it.
    w.pod(true);
    let ready = reconcile(&w).await;
    assert_eq!(ready["state"], "ready", "{ready}");
    assert_eq!(intent_mode(&w), "running");
}

/// A woken, admitted database whose Pod the kubelet does not report Ready, PostgreSQL answering:
/// the world each case below breaks one fact of.
async fn woken() -> World {
    let mut w = World::parked().await;
    w.admitted();
    w.quick();
    w.wake(3);
    w.start_postgres().await;
    w
}
/// Nothing was published: no attestation, no gateway release, no target, the sleep's intent.
fn unpublished(w: &World, observed: &Value, why: &str) {
    assert_eq!(observed["state"], "provisioning", "{why}: {observed}");
    assert!(observed["runtime_attestation"].is_null(), "{why}");
    assert_eq!(intent_mode(w), "quiesce", "{why}");
    assert!(!released(w), "{why}");
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    assert!(map["data"]["admission_target"].is_null(), "{why}");
}

#[tokio::test]
async fn a_resumed_pod_whose_container_does_not_run_is_not_published() {
    let w = woken().await;
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["status"]["containerStatuses"][0]["state"] =
            json!({"waiting":{"reason":"CrashLoopBackOff"}});
    });
    let observed = reconcile(&w).await;
    unpublished(&w, &observed, "container waiting");
}

#[tokio::test]
async fn a_resumed_pod_whose_container_changed_while_postgres_answered_is_not_published() {
    type Change = fn(&mut Value);
    let changes: [(&str, Change); 3] = [
        ("container id", |pod| {
            pod["status"]["containerStatuses"][0]["containerID"] =
                "containerd://3333333333333333333333333333333333333333333333333333333333333333"
                    .into();
        }),
        ("restart count", |pod| {
            pod["status"]["containerStatuses"][0]["restartCount"] = 1.into();
        }),
        ("terminated", |pod| {
            pod["status"]["containerStatuses"][0]["state"] = json!({"terminated":{"exitCode":137}});
        }),
    ];
    for (name, change) in changes {
        let w = woken().await;
        let changed = w.change_pod(change);
        w.sql.lock().unwrap().during.insert("accepting", changed);
        let observed = reconcile(&w).await;
        unpublished(&w, &observed, name);
    }
}

#[tokio::test]
async fn a_resumed_pod_is_not_published_on_an_answer_that_is_not_its_own() {
    // PostgreSQL answers as a standby, or from another address than the Pod's.
    let w = woken().await;
    w.sql.lock().unwrap().recovery = true;
    let observed = reconcile(&w).await;
    unpublished(&w, &observed, "recovery");
    let w = woken().await;
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["status"]["podIP"] = "10.0.0.9".into();
    });
    let observed = reconcile(&w).await;
    unpublished(&w, &observed, "address");
}

#[tokio::test]
async fn a_resumed_pod_whose_postgres_does_not_answer_is_not_published() {
    let w = woken().await;
    w.stop_postgres();
    let observed = reconcile(&w).await;
    unpublished(&w, &observed, "no answer");
    assert!(
        annotations(&w)[FENCE].is_null(),
        "the unfence is not undone"
    );
}

#[tokio::test]
async fn a_pod_cnpg_replaced_is_published_by_the_ordinary_chain_once_it_is_ready() {
    // The retained Pod is another one: the fast wake's proof says nothing about it, and the
    // ordinary wake of a running instance, which waits for the kubelet, applies. Its pass is the
    // first of generation 3 to reach the end, and publishes the proof in that pass.
    let w = woken().await;
    w.pod(false);
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["metadata"]["uid"] = crate::test_server::uid(77).into();
    });
    let observed = reconcile(&w).await;
    unpublished(&w, &observed, "replaced");
    let ready = w.kubelet_ready_now();
    ready();
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let proof = &observed["runtime_attestation"];
    assert_eq!(proof["v"], 2, "{observed}");
    assert_eq!(proof["pod_uid"], crate::test_server::uid(77));
    assert_eq!(admission_target(&w)["pod_uid"], crate::test_server::uid(77));
    // The completed generation is a write of the controller to the namespace the proof names: it
    // is written before the proof, not after, or the first pass of every generation ends in an
    // error and the next pass repeats the chain.
    let namespace = w.server.get("Namespace", None, &w.ns).unwrap();
    assert_eq!(
        namespace["metadata"]["annotations"]["pgcf.io/generation"],
        "3"
    );
    assert_eq!(
        proof["observation"]["resource_versions"]["namespace"],
        namespace["metadata"]["resourceVersion"]
    );
}

#[tokio::test]
async fn the_kubelet_ready_bit_a_wake_did_not_wait_for_is_measured_when_it_arrives() {
    let w = woken().await;
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let power = &w.reconciler.power;
    let pod = || w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    assert!(
        power.kubelet_ready(&w.db, &pod()).is_none(),
        "the bit is not set"
    );
    let ready = w.kubelet_ready_now();
    ready();
    let event = power
        .kubelet_ready(&w.db, &pod())
        .expect("the bit arrived after the wake");
    assert_eq!(event["event"], "wake_phase");
    assert_eq!(event["phase"], "kubelet_ready_observed");
    assert_eq!(event["outcome"], "completed");
    assert_eq!(event["database_id"], w.id);
    assert_eq!(event["operation"], w.db["power"]["operation"]);
    assert!(event["elapsedMs"].as_f64().is_some_and(|ms| ms > 0.0));
    assert!(
        power.kubelet_ready(&w.db, &pod()).is_none(),
        "measured once"
    );
}

/// Moves the start of the wake in flight back by `ms`.
fn wake_started_before(w: &World, ms: u64) {
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut record: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
            assert_eq!(record["phase"], "wake");
            let at = record["startedAt"].as_u64().unwrap();
            record["startedAt"] = at.saturating_sub(ms).into();
            map["data"]["power.json"] = record.to_string().into();
        },
    );
}

#[tokio::test]
async fn a_resize_up_the_kubelet_cannot_allocate_holds_the_wake_and_then_demotes() {
    for reason in ["Deferred", "Infeasible"] {
        let mut w = World::parked().await;
        w.admitted();
        w.quick();
        w.wake(3);
        w.start_postgres().await;
        w.server.state.lock().unwrap().resize_pending = Some(reason.into());
        // The Pod runs PostgreSQL under the requests it was parked with: it is not published.
        let first = reconcile(&w).await;
        assert_eq!(first["state"], "provisioning", "{reason}: {first}");
        assert!(
            log(&w).iter().all(|line| !line.contains("GATEWAY release")),
            "{reason}"
        );
        if reason == "Deferred" {
            // The kubelet may still find the room: the wake waits for it within its budget.
            let waiting = reconcile(&w).await;
            assert_eq!(waiting["state"], "provisioning", "{waiting}");
            assert_ne!(annotations(&w)[HIBERNATION], "on");
            wake_started_before(&w, 11_000);
        }
        // An infeasible resize, or one deferred past the budget, gives the Pod up: it is
        // hibernated and the ordinary wake creates it with the requests it needs.
        let demoted = reconcile(&w).await;
        assert_eq!(demoted["state"], "provisioning", "{reason}: {demoted}");
        assert_eq!(annotations(&w)[HIBERNATION], "on", "{reason}");
        assert_eq!(intent_mode(&w), "quiesce", "{reason}");
    }
}

#[tokio::test]
async fn a_wake_whose_unfence_landed_before_its_record_continues_on_the_same_pod() {
    // The first wave is three writes at once, so a crash can leave the Cluster written and the
    // record of the wake not: the fence is lifted under a record that still says `Parked`. The
    // next pass finds the fence gone, records the wake, and continues on the Pod it retained.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["metadata"]["annotations"][FENCE] = Value::Null;
            cluster["metadata"]["annotations"][HIBERNATION] = "off".into();
            cluster["metadata"]["annotations"]["pgcf.io/power-revision"] = "3".into();
            cluster["metadata"]["annotations"]["pgcf.io/power-operation"] =
                w.db["power"]["operation"].clone();
            cluster["metadata"]["annotations"]
                .as_object_mut()
                .unwrap()
                .remove(FENCE);
        });
    let progress = |w: &World| -> Value {
        let map = w
            .server
            .get(
                "ConfigMap",
                Some(SYSTEM),
                &format!("gateway-fence-{}", w.id),
            )
            .unwrap();
        serde_json::from_str(text(&map["data"], "power.json")).unwrap()
    };
    assert_eq!(progress(&w)["phase"], "parked");
    // PostgreSQL started when the unfence landed, and the kubelet has not reported the Pod ready
    // (it is not published before it is: this pass is not the fast one).
    let first = reconcile(&w).await;
    assert_eq!(first["state"], "provisioning", "{first}");
    assert_eq!(progress(&w)["phase"], "wake");
    assert!(annotations(&w)[FENCE].is_null());
    w.pod(true);
    let ready = reconcile(&w).await;
    assert_eq!(ready["state"], "ready", "{ready}");
    let hibernations = w
        .server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .filter(|(_, path, body)| {
            *path == cluster_path(&w) && body["metadata"]["annotations"][HIBERNATION] == "on"
        })
        .count();
    assert_eq!(
        hibernations, 0,
        "the Pod that was parked is the one that woke"
    );
}

#[tokio::test]
async fn a_wake_whose_record_landed_before_its_unfence_unfences_in_the_next_pass() {
    // The other half of the window: the record of `Wake` is written and the Cluster write was
    // refused. The fence is still in place, no postmaster runs, and the next pass begins the wake
    // again over the same record.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let cluster = cluster_path(&w);
    w.server.state.lock().unwrap().refuse =
        Some(Box::new(move |at, _| (at == cluster).then_some(500)));
    let first = reconcile_pass(&w).await;
    assert!(
        first.as_ref().is_none_or(|value| value["state"] != "ready"),
        "{first:?}"
    );
    assert_eq!(
        annotations(&w)[FENCE],
        "[\"*\"]",
        "the Cluster write was refused: the fence stands"
    );
    let record = |w: &World| -> Value {
        let map = w
            .server
            .get(
                "ConfigMap",
                Some(SYSTEM),
                &format!("gateway-fence-{}", w.id),
            )
            .unwrap();
        serde_json::from_str(text(&map["data"], "power.json")).unwrap()
    };
    let begun = record(&w);
    assert_eq!(begun["phase"], "wake");
    w.server.state.lock().unwrap().refuse = None;
    let ready = reconcile(&w).await;
    assert_eq!(ready["state"], "ready", "{ready}");
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(
        record(&w)["phase"],
        "awake",
        "the wake that began over the record completed"
    );
}

#[tokio::test]
async fn a_release_a_gateway_has_not_yet_seen_the_intent_for_is_asked_again_within_the_pass() {
    // The gateway answers 409 until its own watch has delivered the intent the controller wrote
    // just before. The pass used to end there, and the wake waited the second of its retry.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    *w.gateway.refuse_releases.lock().unwrap() = 3;
    w.log.lock().unwrap().clear();
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let lines = log(&w);
    let count = |wanted: &str| lines.iter().filter(|line| *line == wanted).count();
    assert_eq!(count("GATEWAY release refused"), 3, "{lines:#?}");
    assert_eq!(count("GATEWAY release"), 1);
    // The intent precedes every attempt, the acknowledgement precedes the target, and the target
    // is written once.
    let intent = at(&w, &["PATCH", "gateway-fence-", r#"\"mode\":\"running\""#]);
    let first = at(&w, &["GATEWAY release refused"]);
    let acknowledged = lines
        .iter()
        .position(|line| line == "GATEWAY release")
        .unwrap();
    let target = at(&w, &["PATCH", "gateway-fence-", "admission_target"]);
    assert!(intent < first && first < acknowledged && acknowledged < target);
    assert_eq!(admission_target(&w)["generation"], 3);
}

#[tokio::test]
async fn a_release_that_is_never_acknowledged_ends_the_pass_after_its_window_and_writes_no_target()
{
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    *w.gateway.refuse_releases.lock().unwrap() = u32::MAX;
    w.log.lock().unwrap().clear();
    let started = std::time::Instant::now();
    let observed = reconcile_pass(&w).await;
    assert!(
        observed
            .as_ref()
            .is_none_or(|value| value["state"] != "ready"),
        "{observed:?}"
    );
    let lines = log(&w);
    let refused = lines
        .iter()
        .filter(|line| *line == "GATEWAY release refused")
        .count();
    assert!(
        (5..=40).contains(&refused),
        "{refused} attempts in about 150 ms, 5 ms apart"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!lines.iter().any(|line| line == "GATEWAY release"));
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    assert!(
        map["data"]["admission_target"].is_null(),
        "no target is written before every gateway acknowledged the release"
    );
}

#[tokio::test]
async fn a_resumed_pod_whose_requests_the_kubelet_is_still_actuating_is_published_without_waiting()
{
    // The resize changes requests only: no limit, no cgroup limit, no memory the Pod may not use.
    // The wake used to poll the Pod every 25 ms until the kubelet reported them actuated, which
    // the first query of the client did not need.
    let mut w = World::parked().await;
    w.admitted();
    w.quick();
    w.wake(3);
    w.start_postgres().await;
    w.server.state.lock().unwrap().resize_in_progress = true;
    let at = w.mark();
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    assert_eq!(
        pod["spec"]["containers"][0]["resources"]["requests"],
        json!({"cpu":"25m","memory":"128Mi"}),
        "the Pod was asked for its requests"
    );
    assert_eq!(
        pod["status"]["containerStatuses"][0]["resources"]["requests"],
        json!({"cpu":"10m","memory":"96Mi"}),
        "and the kubelet still reports the requests it parked the Pod under"
    );
    assert_eq!(intent_mode(&w), "running");
    // The wake reads the Pod where its chain does (seven times), not once every 25 ms until the
    // kubelet is done.
    let reads = w
        .made(at)
        .into_iter()
        .filter(|(method, path, _)| *method == "GET" && *path == primary(&w))
        .count();
    assert!(reads <= 10, "{reads} reads of the Pod");
}

fn intent_mode(w: &World) -> String {
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    let intent: Value = serde_json::from_str(text(&map["data"], "intent.json")).unwrap();
    text(&intent, "mode").to_string()
}

#[tokio::test]
async fn a_postmaster_older_than_the_unfence_is_not_proof_and_the_wake_continues_on_the_same_pod() {
    let mut w = World::parked().await;
    w.admitted();
    w.quick();
    w.wake(3);
    w.start_postgres().await;
    // A postmaster that started long before the unfence was sent did not start for it.
    w.sql.lock().unwrap().postmaster_age_ms = 3_600_000;
    let first = reconcile(&w).await;
    assert_eq!(first["state"], "provisioning", "{first}");
    assert_eq!(
        intent_mode(&w),
        "quiesce",
        "no client is admitted on a stale answer"
    );
    assert!(
        w.log
            .lock()
            .unwrap()
            .iter()
            .all(|line| !line.contains("GATEWAY release"))
    );
    assert!(
        annotations(&w)[FENCE].is_null(),
        "the unfence is committed and is not undone"
    );
    assert_eq!(annotations(&w)[HIBERNATION], "off");
    // Later passes continue on the same Pod under the ordinary chain, which waits for the
    // kubelet's readiness, which is not yet there.
    w.sql.lock().unwrap().postmaster_age_ms = 5;
    let waiting = reconcile(&w).await;
    assert_eq!(waiting["state"], "provisioning", "{waiting}");
    assert_eq!(intent_mode(&w), "quiesce");
    w.pod(true);
    let ready = reconcile(&w).await;
    assert_eq!(ready["state"], "ready", "{ready}");
    assert_eq!(intent_mode(&w), "running");
    let hibernated = w
        .server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .filter(|(_, path, body)| {
            *path == cluster_path(&w) && body["metadata"]["annotations"][HIBERNATION] == "on"
        })
        .count();
    assert_eq!(
        hibernated, 0,
        "no demotion: the Pod that was parked is the one that woke"
    );
}

/// The wake of the Pod `resumed_current` is judged against.
fn resumed(restarts: Option<u64>) -> ParkedWake {
    ParkedWake {
        pod_name: "database-1".into(),
        pod_uid: crate::test_server::uid(9),
        postgres_container_id: "containerd://a".into(),
        sidecar_container_id: "containerd://b".into(),
        postgres_restarts: restarts,
        pod_ip: None,
        requests_before: crate::power::Requests {
            postgres: crate::power::ContainerRequests {
                cpu: "25m".into(),
                memory: "128Mi".into(),
            },
            sidecar: crate::power::ContainerRequests {
                cpu: "100m".into(),
                memory: "128Mi".into(),
            },
        },
        started: std::time::Instant::now(),
    }
}

#[test]
fn a_resumed_pod_is_current_only_while_it_is_the_same_running_pod() {
    let db = json!({"node":"native-test-node"});
    let context = json!({"computePool":null});
    let cluster =
        json!({"apiVersion":"postgresql.cnpg.io/v1","metadata":{"uid":crate::test_server::uid(3)}});
    let wake = resumed(Some(0));
    let pod = json!({"metadata":{"uid":crate::test_server::uid(9),"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":crate::test_server::uid(3)}]},
        "spec":{"nodeName":"native-test-node"},
        "status":{"phase":"Running","containerStatuses":[{"name":"postgres","containerID":"containerd://a","restartCount":0,"state":{"running":{"startedAt":"2026-10-15T00:00:00Z"}}}],"initContainerStatuses":[{"name":"plugin-barman-cloud","containerID":"containerd://b"}]}});
    assert!(resumed_current(&pod, &cluster, &db, &context, &wake));
    let broken = |change: &dyn Fn(&mut Value)| {
        let mut changed = pod.clone();
        change(&mut changed);
        !resumed_current(&changed, &cluster, &db, &context, &wake)
    };
    assert!(broken(
        &|p| p["metadata"]["uid"] = crate::test_server::uid(10).into()
    ));
    assert!(broken(
        &|p| p["status"]["containerStatuses"][0]["containerID"] = "containerd://z".into()
    ));
    assert!(broken(
        &|p| p["status"]["initContainerStatuses"][0]["containerID"] = "containerd://z".into()
    ));
    assert!(broken(&|p| p["status"]["phase"] = "Pending".into()));
    assert!(broken(&|p| p["spec"]["nodeName"] = "another-node".into()));
    assert!(broken(
        &|p| p["spec"]["runtimeClassName"] = "pgcf-prestarted".into()
    ));
    assert!(broken(
        &|p| p["metadata"]["deletionTimestamp"] = "2026-10-15T00:00:00Z".into()
    ));
    // The container runs, and has not restarted since the fence was lifted.
    assert!(broken(&|p| {
        p["status"]["containerStatuses"][0]["state"] =
            json!({"waiting":{"reason":"CrashLoopBackOff"}});
    }));
    assert!(broken(&|p| {
        p["status"]["containerStatuses"][0]["state"] = json!({"terminated":{"exitCode":137}});
    }));
    assert!(broken(
        &|p| p["status"]["containerStatuses"][0]["restartCount"] = 1.into()
    ));
    // A count that could not be read then is never equal to one read now.
    assert!(!resumed_current(
        &pod,
        &cluster,
        &db,
        &context,
        &resumed(None)
    ));
    // The Ready bit is not read.
    let mut unready = pod.clone();
    unready["status"]["conditions"] = json!([{"type":"Ready","status":"False"}]);
    unready["status"]["containerStatuses"][0]["ready"] = false.into();
    assert!(resumed_current(&unready, &cluster, &db, &context, &wake));
}

#[tokio::test]
async fn a_new_generation_is_published_with_its_proof_in_one_pass() {
    // The completed generation is a write of the controller to the namespace the runtime proof
    // names: written before the proof, the first pass of the generation publishes it; written
    // after, that pass changed the namespace under its own proof and ended in an error, after the
    // gateway fence was released, and the next pass repeated the whole chain.
    let mut w = World::parked().await;
    w.admitted();
    w.quick();
    w.wake(3);
    // CNPG replaced the retained Pod: the ordinary wake of a running instance applies.
    w.pod(true);
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["metadata"]["uid"] = crate::test_server::uid(77).into();
    });
    w.start_postgres().await;
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let proof = &observed["runtime_attestation"];
    assert_eq!(proof["v"], 2, "{observed}");
    assert_eq!(proof["pod_uid"], crate::test_server::uid(77));
    let namespace = w.server.get("Namespace", None, &w.ns).unwrap();
    assert_eq!(
        namespace["metadata"]["annotations"]["pgcf.io/generation"],
        "3"
    );
    assert_eq!(
        proof["observation"]["resource_versions"]["namespace"],
        namespace["metadata"]["resourceVersion"]
    );
    assert_eq!(admission_target(&w)["pod_uid"], crate::test_server::uid(77));
    assert_eq!(admission_target(&w)["generation"], 3);
}

/// The writes the cluster has committed so far, as (method, object name, what was written).
fn committed(w: &World) -> Vec<(String, String, Value)> {
    w.server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .map(|(method, path, body)| {
            (
                method.clone(),
                path.rsplit('/').next().unwrap().to_string(),
                body.clone(),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_completed_wake_leaves_the_cluster_quiet_until_something_else_changes() {
    // After a wake the database stays awake and is looked at again every minute, and whenever
    // something changes. Neither may change anything itself: a pass that writes makes the
    // watch deliver its write, which makes the database due again, which writes.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    // The watch has delivered the writes of the sleep.
    assert!(w.watch_delivers().is_empty());
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    // The watch delivers every write of the wake: not one is a change someone else made.
    let hinted = w.watch_delivers();
    assert!(
        hinted.is_empty(),
        "the controller's own writes mark the database due: {hinted:?}"
    );
    // The kubelet reports the Pod Ready some time later; the passes that follow are the ordinary
    // chain over the same facts.
    w.kubelet_ready_now()();
    for operation_in_record in [true, false] {
        if !operation_in_record {
            // The operation is complete: the desired record no longer carries it.
            w.db.as_object_mut().unwrap().remove("power");
        }
        for _ in 0..2 {
            let before = committed(&w).len();
            let again = reconcile(&w).await;
            assert_eq!(again["state"], "ready", "{again}");
            let wrote: Vec<_> = committed(&w).split_off(before);
            assert!(
                wrote.is_empty(),
                "a pass over unchanged facts wrote (operation in the record: {operation_in_record}): {:?}",
                wrote
                    .iter()
                    .map(|(method, name, _)| format!("{method} {name}"))
                    .collect::<Vec<_>>()
            );
        }
        assert!(w.watch_delivers().is_empty());
    }
}

/// The requests the controller made since `from`, as (reads, writes).
fn requests_since(w: &World, from: usize) -> (usize, usize) {
    let state = w.server.state.lock().unwrap();
    let all = &state.requests[from..];
    let reads = all.iter().filter(|(method, _)| method == "GET").count();
    (reads, all.len() - reads)
}

#[tokio::test]
async fn a_parked_wake_and_the_pass_after_it_make_this_many_requests() {
    // The requests of the wake that parked databases wait for, and of the pass that looks at the
    // awake database again once the kubelet reports its Pod ready, as (reads, writes). Every
    // request is a round trip of the wake or a charge on the API server of a database that only
    // sits there: a change that adds one changes these numbers.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let at = w.server.state.lock().unwrap().requests.len();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    assert_eq!(requests_since(&w, at), (100, 19), "the wake");
    let _ = w.watch_delivers();
    w.kubelet_ready_now()();
    let at = w.server.state.lock().unwrap().requests.len();
    let again = reconcile(&w).await;
    assert_eq!(again["state"], "ready", "{again}");
    assert_eq!(requests_since(&w, at), (83, 0), "the pass after it");
}

/// The sequential rounds of Kubernetes requests the controller made since the double's counter
/// was last cleared, with every request answered after the same delay.
fn rounds_of(w: &World) -> u64 {
    w.server.state.lock().unwrap().rounds
}

#[tokio::test]
async fn a_parked_wake_makes_this_many_requests_in_this_many_rounds() {
    // The model of the wake: every request of the in-process cluster is answered after the same
    // time, so that the requests of one wave are one round and the rest follow one another. Its
    // numbers are the ones the plan records for the controller's share of a wake; the time of a
    // round is the unknown of a live run.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    {
        let mut state = w.server.state.lock().unwrap();
        state.latency = Some(Duration::from_millis(100));
        state.rounds = 0;
    }
    w.reconciler.accept_budget = Duration::from_secs(60);
    let at = w.mark();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let (reads, writes) = requests_since(&w, at);
    let rounds = rounds_of(&w);
    eprintln!("a parked wake: {reads} reads, {writes} writes, {rounds} sequential rounds");
    assert_eq!(
        (reads, writes, rounds),
        (100, 19, 41),
        "reads, writes, rounds"
    );
}

#[tokio::test]
async fn the_volume_is_read_by_the_handle_its_receipt_recorded_and_never_listed() {
    // Every pass proves the storage anchor, which used to list every PersistentVolume and every
    // LVMVolume of the cluster to find its own two.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let at = w.server.state.lock().unwrap().requests.len();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let requests = w.server.state.lock().unwrap().requests.clone();
    let paths: Vec<&str> = requests[at..]
        .iter()
        .map(|(_, path)| path.as_str())
        .collect();
    for collection in [
        "/api/v1/persistentvolumes",
        "/apis/local.openebs.io/v1alpha1/lvmvolumes",
    ] {
        assert!(!paths.contains(&collection), "{collection} was listed");
    }
    let volume = format!("/api/v1/persistentvolumes/{HANDLE}");
    let lvm = format!("/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmvolumes/{HANDLE}");
    assert!(paths.contains(&volume.as_str()), "{paths:?}");
    assert!(paths.contains(&lvm.as_str()), "{paths:?}");
}

#[tokio::test]
async fn a_volume_that_is_not_the_recorded_one_still_ends_the_pass_in_recovery() {
    type Break = fn(&World);
    let cases: [(&str, &str, Break); 4] = [
        (
            "the PersistentVolume was replaced by another object of its name",
            "persistent_volume_missing_or_replaced",
            |w| {
                w.server.edit("PersistentVolume", None, HANDLE, |pv| {
                    pv["metadata"]["uid"] = crate::test_server::uid(900).into();
                });
            },
        ),
        (
            "the PersistentVolume is gone",
            "persistent_volume_missing_or_replaced",
            |w| {
                let key = path("PersistentVolume", None, HANDLE);
                w.server.state.lock().unwrap().objects.remove(&key);
            },
        ),
        (
            "the LVMVolume is gone",
            "lvm_volume_missing_or_replaced",
            |w| {
                let key = path("LVMVolume", Some("openebs"), HANDLE);
                w.server.state.lock().unwrap().objects.remove(&key);
            },
        ),
        (
            "the LVMVolume is being deleted",
            "lvm_volume_missing_or_replaced",
            |w| {
                w.server.edit("LVMVolume", Some("openebs"), HANDLE, |lvm| {
                    lvm["metadata"]["deletionTimestamp"] = "2026-10-15T00:00:00Z".into();
                });
            },
        ),
    ];
    for (what, code, break_it) in cases {
        let w = World::awake().await;
        break_it(&w);
        let observed = reconcile(&w).await;
        assert_eq!(observed["state"], "error", "{what}: {observed}");
        assert_eq!(
            observed["message"],
            format!("{code}; recovery required"),
            "{what}"
        );
    }
}

/// How often the controller read `path` since `from`.
fn reads_of(w: &World, from: usize, path: &str) -> usize {
    w.server.state.lock().unwrap().requests[from..]
        .iter()
        .filter(|(method, at)| method == "GET" && at == path)
        .count()
}

#[tokio::test]
async fn the_cluster_is_asserted_once_per_pass() {
    // The identity of the cluster, the UID of kube-system, is read once by a pass, whatever the
    // pass goes on to do.
    let cluster = path("Namespace", None, "kube-system");
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let at = w.server.state.lock().unwrap().requests.len();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    assert_eq!(reads_of(&w, at, &cluster), 1, "the wake");
    let _ = w.watch_delivers();
    w.kubelet_ready_now()();
    let at = w.server.state.lock().unwrap().requests.len();
    let again = reconcile(&w).await;
    assert_eq!(again["state"], "ready", "{again}");
    assert_eq!(reads_of(&w, at, &cluster), 1, "the pass after it");
}

/// Every request the controller made since `from`, as "METHOD path".
fn made_since(w: &World, from: usize) -> Vec<String> {
    w.server.state.lock().unwrap().requests[from..]
        .iter()
        .map(|(method, path)| format!("{method} {path}"))
        .collect()
}

#[tokio::test]
async fn a_generation_is_applied_by_reading_its_objects_together_and_writing_what_binds_the_pod_first()
 {
    // A pass that brings a new generation to the cluster reads the objects it is about to write
    // before it writes the first, a few at a time. What binds the Pod the Cluster creates (the
    // quota, the limits, the policies, the archive) is written together, and all of it before the
    // Cluster is, which follows alone with the scheduled backup after it. The Cluster is read
    // when its turn comes, because CNPG writes its status continually and a patch over a version
    // read ahead of the others' writes would conflict.
    let w = World::running().await;
    let names = [
        ("ResourceQuota", "database-resources"),
        ("LimitRange", "container-defaults"),
        ("NetworkPolicy", "default-deny"),
        ("NetworkPolicy", "gateway-ingress"),
        ("NetworkPolicy", "agent-management-ingress"),
        ("CiliumNetworkPolicy", "database-boundaries"),
        ("ObjectStore", "archive"),
        ("ScheduledBackup", "daily-backup"),
    ];
    let objects: Vec<String> = names
        .iter()
        .map(|(kind, name)| path(kind, Some(&w.ns), name))
        .collect();
    // Only the apply pass and the check that the applied objects stayed as applied read these:
    // each is a group of eight read together, which two groups of four fill, and the pass
    // that read them one after another would fill none.
    let matching = objects.clone();
    w.server.state.lock().unwrap().gate = Some(Gate::new(4, move |method, at| {
        method == "GET" && matching.iter().any(|object| object == at)
    }));
    let at = w.server.state.lock().unwrap().requests.len();
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let gate = w.server.state.lock().unwrap().gate.take().unwrap();
    assert_eq!(
        (gate.rounds, gate.gave_up),
        (4, 0),
        "the objects were not read together, by the apply pass and by the check after it"
    );
    let made = made_since(&w, at);
    let cluster = path("Cluster", Some(&w.ns), "database");
    let backup = path("ScheduledBackup", Some(&w.ns), "daily-backup");
    let patched: Vec<&str> = made
        .iter()
        .filter_map(|request| request.strip_prefix("PATCH "))
        .filter(|at| objects.iter().any(|object| object == at) || *at == cluster)
        .collect();
    // Seven objects in any order, then the Cluster, then the scheduled backup.
    assert_eq!(patched.len(), 9, "{patched:?}");
    let mut binding: Vec<&str> = patched[..7].to_vec();
    binding.sort_unstable();
    let mut wanted: Vec<&str> = objects[..7].iter().map(String::as_str).collect();
    wanted.sort_unstable();
    assert_eq!(binding, wanted);
    assert_eq!(patched[7], cluster);
    assert_eq!(patched[8], backup);
    // The Cluster is read right before it is written, after everything that binds its Pod.
    let position = made
        .iter()
        .position(|request| *request == format!("PATCH {cluster}"))
        .unwrap();
    assert_eq!(made[position - 1], format!("GET {cluster}"));
    assert!(made[position - 2].starts_with("PATCH "));
}

#[tokio::test]
async fn what_binds_the_pod_is_written_together_when_it_all_exists() {
    let w = World::running().await;
    let binding: Vec<String> = [
        ("ResourceQuota", "database-resources"),
        ("LimitRange", "container-defaults"),
        ("NetworkPolicy", "default-deny"),
        ("NetworkPolicy", "gateway-ingress"),
        ("NetworkPolicy", "agent-management-ingress"),
        ("CiliumNetworkPolicy", "database-boundaries"),
        ("ObjectStore", "archive"),
    ]
    .iter()
    .map(|(kind, name)| path(kind, Some(&w.ns), name))
    .collect();
    // All seven patches are in flight at once, or none is held.
    w.server.state.lock().unwrap().gate = Some(
        Gate::new(7, move |method, at| {
            method == "PATCH" && binding.iter().any(|object| object == at)
        })
        .once(),
    );
    let observed = reconcile(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    let gate = w.server.state.lock().unwrap().gate.take().unwrap();
    assert_eq!((gate.rounds, gate.gave_up), (1, 0));
}

#[tokio::test]
async fn a_missing_object_is_created_after_the_ones_before_it_as_always() {
    // Nothing exists yet but the namespace: the objects are created one after another in the
    // order of the manifests, the policies before the Cluster.
    let w = World::running().await;
    let quota = path("ResourceQuota", Some(&w.ns), "database-resources");
    w.server.state.lock().unwrap().objects.remove(&quota);
    let at = w.server.state.lock().unwrap().requests.len();
    let _ = reconcile(&w).await;
    let made = made_since(&w, at);
    let created = made
        .iter()
        .position(|request| request.starts_with("POST ") && request.ends_with("/resourcequotas"))
        .expect("the quota is created");
    let cluster_patch = made
        .iter()
        .position(|request| {
            *request == format!("PATCH {}", path("Cluster", Some(&w.ns), "database"))
        })
        .expect("the Cluster is patched");
    let limits = made
        .iter()
        .position(|request| request.starts_with("PATCH ") && request.contains("/limitranges/"))
        .expect("the limits are patched");
    assert!(created < limits, "the quota is first, as in the manifests");
    assert!(limits < cluster_patch);
}

#[tokio::test]
async fn the_proof_reads_the_resources_it_names_back_together() {
    let mut w = World::running().await;
    w.admitted();
    let start = w.reconciler.k8s.runtime_continuity().expect("a watch");
    let get = |kind: &str, namespace: Option<&str>, name: &str| {
        w.server.get(kind, namespace, name).expect(name)
    };
    let namespace = get("Namespace", None, &w.ns);
    let cluster = get("Cluster", Some(&w.ns), "database");
    let pod = get("Pod", Some(&w.ns), "database-1");
    let ca = get("Secret", Some(&w.ns), "database-ca");
    let node = get("Node", None, NODE);
    let volume = json!({"claimUid":claim_uid(),"volumeUid":volume_uid(),"handle":HANDLE});
    // Eleven reads: the claim, the volume and the receipt, and each of the eight resources of
    // the proof again. Read one after another, no group of three is ever together.
    w.server.state.lock().unwrap().gate = Some(Gate::new(3, |method, _| method == "GET"));
    let continuity = w
        .reconciler
        .runtime_readback(
            &w.db,
            &start,
            &RuntimeResources {
                namespace: &namespace,
                cluster: &cluster,
                pod: &pod,
                ca: &ca,
                node: &node,
            },
            &volume,
        )
        .await
        .unwrap()
        .expect("the resources are as they were read");
    let gate = w.server.state.lock().unwrap().gate.take().unwrap();
    assert!(
        gate.rounds >= 3,
        "{} groups together, {} reads alone",
        gate.rounds,
        gate.gave_up
    );
    assert_eq!(continuity["coverage"], "complete");
    assert_eq!(
        continuity["resource_versions"].as_object().unwrap().len(),
        8
    );
}

#[tokio::test]
async fn a_parked_wake_logs_the_maintenance_role_in_once() {
    // The login that proves PostgreSQL accepts on the resumed Pod is the session the archive
    // sample then asks its questions in; every role proves its own credential, together.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    w.log.lock().unwrap().clear();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let logins: Vec<String> = log(&w)
        .into_iter()
        .filter_map(|line| line.strip_prefix("LOGIN ").map(str::to_string))
        .collect();
    let count = |user: &str| logins.iter().filter(|login| *login == user).count();
    assert_eq!(count("pgcf_maintenance"), 1, "{logins:?}");
    assert_eq!(count("app"), 1, "{logins:?}");
    assert_eq!(count("reader_query"), 1, "{logins:?}");
    assert_eq!(logins.len(), 3, "{logins:?}");
}

#[tokio::test]
async fn the_target_is_published_after_every_gateway_acknowledged_and_with_the_read_back() {
    // The gateway routes a resumed Pod by the target the controller writes into the fence. It is
    // written once every gateway has acknowledged the release, and not before; what follows the
    // acknowledgements, the read-back of the gateways and of the fence, and the write of the
    // target, needs nothing of the other and is issued together.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let fence = path(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
    );
    let storage = path("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id));
    let gateways = format!("/api/v1/namespaces/{SYSTEM}/pods");
    let released = w.log.clone();
    let after_release = move |method: &str, at: &str| {
        released
            .lock()
            .unwrap()
            .iter()
            .any(|line| line == "GATEWAY release")
            && ((method == "GET" && (at == storage || at == gateways)) || at == fence)
    };
    w.server.state.lock().unwrap().gate = Some(Gate::new(4, after_release));
    w.log.lock().unwrap().clear();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let gate = w.server.state.lock().unwrap().gate.take().unwrap();
    assert_eq!(
        (gate.rounds, gate.gave_up),
        (1, 0),
        "the read-back and the target were not issued together"
    );
    let release = at(&w, &["GATEWAY release"]);
    let target = at(&w, &["PATCH", "gateway-fence-", "admission_target"]);
    assert!(release < target, "the target precedes the release");
    assert_eq!(admission_target(&w)["generation"], 3);
}

#[tokio::test]
async fn a_database_without_an_origin_operation_still_has_its_new_target_published() {
    // A record without a creation or a recovery operation has no running intent to publish, and
    // its target is still the one the gateway routes by: Cloudflare admitting it again under
    // another epoch changes it.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    assert_eq!(admission_target(&w)["admission_epoch"], 1);
    w.kubelet_ready_now()();
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["conditions"] = json!([
                {"type":"Ready","status":"True"},
                {"type":"ContinuousArchiving","status":"True"}
            ]);
        });
    w.db["creation"] = Value::Null;
    w.db.as_object_mut().unwrap().remove("power");
    w.db["admission"]["admission_epoch"] = 2.into();
    let again = reconcile(&w).await;
    assert_eq!(again["state"], "ready", "{again}");
    assert_eq!(again["runtime_attestation"]["admission_epoch"], 2);
    assert_eq!(admission_target(&w)["admission_epoch"], 2);
}

/// A database that completed its wake: its fence is running, its target published, its proof the
/// watch holds. The observation of that pass comes with it.
async fn completed() -> (World, Value) {
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let _ = w.watch_delivers();
    (w, woken)
}
/// Holds the requests `gate` matches until a group of them is issued together, and says how many
/// groups it let go and how many requests gave up waiting for one.
fn hold(w: &World, gate: Gate) {
    w.server.state.lock().unwrap().gate = Some(gate);
}
fn held(w: &World) -> (usize, usize) {
    let gate = w.server.state.lock().unwrap().gate.take().unwrap();
    (gate.rounds, gate.gave_up)
}
fn primary(w: &World) -> String {
    path("Pod", Some(&w.ns), "database-1")
}
fn fence_path(w: &World) -> String {
    path(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
    )
}
fn storage_path(w: &World) -> String {
    path("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id))
}
fn cluster_object(w: &World) -> String {
    path("Cluster", Some(&w.ns), "database")
}

#[tokio::test]
async fn a_pass_reads_what_it_needs_of_the_database_together_before_it_judges_any() {
    // The Node, the marker of a deletion, the namespace, the receipt and the Cluster of the
    // database: none depends on another, and the pass judges them in the order it always did.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let wanted = [
        path("Node", None, NODE),
        path("ConfigMap", Some(SYSTEM), &format!("delete-{}", w.id)),
        path("Namespace", None, &w.ns),
        storage_path(&w),
        cluster_object(&w),
    ];
    hold(
        &w,
        Gate::new(5, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_release_proves_the_anchor_and_reads_the_fence_together() {
    let (w, woken) = completed().await;
    let intent = serde_json::to_value(desired_power(&w.db).unwrap().unwrap()).unwrap();
    // The anchor (namespace, Cluster, receipt) and the fence with its receipt: five reads.
    let wanted = [
        path("Namespace", None, &w.ns),
        cluster_object(&w),
        storage_path(&w),
        fence_path(&w),
    ];
    hold(
        &w,
        Gate::new(5, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let released = w
        .reconciler
        .power
        .finish_running(&w.db, woken, Some(&intent))
        .await
        .unwrap()
        .expect("released");
    assert_eq!(released["state"], "ready");
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_release_binds_the_fence_while_it_reads_the_gateways() {
    let (w, woken) = completed().await;
    let intent = serde_json::to_value(desired_power(&w.db).unwrap().unwrap()).unwrap();
    // The anchor and the fence read the receipt twice; then the receipt, the gateway Pods and the
    // keyring are read for the binding and the snapshot.
    let wanted = [
        storage_path(&w),
        format!("/api/v1/namespaces/{SYSTEM}/pods"),
        path("Secret", Some(SYSTEM), "pgcf-gateway"),
    ];
    hold(
        &w,
        Gate::new(3, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .after(2)
        .once(),
    );
    let released = w
        .reconciler
        .power
        .finish_running(&w.db, woken, Some(&intent))
        .await
        .unwrap()
        .expect("released");
    assert_eq!(released["state"], "ready");
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_archive_probe_reads_the_bindings_it_checks_together() {
    let (w, _) = completed().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database").unwrap();
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    // The credential is read first and again after the questions, with the Cluster, the Pod and
    // the receipt the health of the archive is recorded in.
    let wanted = [
        path("Secret", Some(&w.ns), "maintenance-credentials"),
        cluster_object(&w),
        primary(&w),
        storage_path(&w),
    ];
    hold(
        &w,
        Gate::new(4, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .after(1)
        .once(),
    );
    let probed = w
        .reconciler
        .archive(
            &w.db,
            &cluster,
            &pod,
            w.authority.pem.as_bytes(),
            true,
            None,
        )
        .await
        .unwrap();
    assert_eq!(probed.pod["metadata"]["uid"], pod["metadata"]["uid"]);
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_volume_is_bound_while_the_receipt_is_read() {
    let (w, _) = completed().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database").unwrap();
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    let receipt = w
        .server
        .get("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id))
        .unwrap();
    let stored = state(&receipt).unwrap();
    let wanted = [
        path("PersistentVolumeClaim", Some(&w.ns), "database-1"),
        storage_path(&w),
    ];
    hold(
        &w,
        Gate::new(2, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let identity = w
        .reconciler
        .bind_volume(&w.db, &cluster, &pod, &Value::Null, &stored)
        .await
        .unwrap();
    assert!(identity.is_some());
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_runtime_label_is_checked_while_the_primary_is_read() {
    let (w, _) = completed().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database").unwrap();
    let context = w
        .reconciler
        .context(&w.db, &w.snapshot, false)
        .await
        .unwrap();
    let wanted = [path("Namespace", None, &w.ns), primary(&w)];
    hold(
        &w,
        Gate::new(2, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let selected = w
        .reconciler
        .runtime_selected(&w.db, &context, &json!(namespace_uid()), &cluster)
        .await
        .unwrap();
    assert!(selected);
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_authority_is_read_while_its_published_copy_is() {
    let (w, _) = completed().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database").unwrap();
    let wanted = [
        path("Secret", Some(&w.ns), "database-ca"),
        path("ConfigMap", Some(SYSTEM), &format!("ca-{}", w.id)),
    ];
    hold(
        &w,
        Gate::new(2, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let authority = w.reconciler.ca(&w.db, &cluster).await.unwrap();
    assert!(authority.is_some());
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_record_of_the_wake_the_unfence_and_the_resize_are_issued_together() {
    // The three writes of the wake's first wave touch three objects and depend on nothing the
    // others return: the record of the wake in the fence (a crash after the Cluster write is
    // met by the pass that finds the fence lifted under a record that says Parked), the Cluster
    // under its resourceVersion, and the Pod's requests. The Pod's restarts are the ones the
    // inspection read.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let fence = fence_path(&w);
    let cluster = cluster_object(&w);
    let resize = format!("{}/resize", primary(&w));
    hold(
        &w,
        Gate::new(3, move |method, at| {
            method == "PATCH" && (at == fence || at == cluster || at == resize)
        })
        .once(),
    );
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn postgresql_is_asked_from_the_unfence_on_and_not_after_the_apply_pass() {
    // The apply pass is seven rounds of requests, and PostgreSQL starts a tenth of a second after
    // the unfence. The first login of the poll is made while the apply pass runs, not after its
    // last write.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    w.log.lock().unwrap().clear();
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let login = at(&w, &["LOGIN pgcf_maintenance"]);
    let last_write_of_the_apply_pass = at(&w, &["PATCH", "/scheduledbackups/daily-backup"]);
    assert!(
        login < last_write_of_the_apply_pass,
        "{:#?}",
        log(&w)
            .iter()
            .map(|line| line.chars().take(90).collect::<String>())
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn the_wake_reads_the_anchor_with_the_fence_it_looks_at() {
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database");
    let mut context = w
        .reconciler
        .context(&w.db, &w.snapshot, false)
        .await
        .unwrap();
    context["droppingRoles"] = removal::cluster_drops(&w.db, cluster.as_ref());
    let built = manifests::build(&w.db, &context);
    let basis = Basis {
        node: &w.node,
        release: &w.snapshot.fleet_release,
        manifests: built.as_ref().ok().map(Vec::as_slice),
        runtime_class: runtime_class(&context),
    };
    // The fence, and the namespace, the Cluster and the receipt the anchor is made of.
    let wanted = [
        fence_path(&w),
        path("Namespace", None, &w.ns),
        cluster_object(&w),
        storage_path(&w),
    ];
    hold(
        &w,
        Gate::new(4, move |method, at| {
            method == "GET" && wanted.iter().any(|object| object == at)
        })
        .once(),
    );
    let prepared = w
        .reconciler
        .power
        .prepare_running(&w.db, &basis)
        .await
        .unwrap();
    assert!(matches!(prepared, PrepareRunning::Parked(_)));
    assert_eq!(held(&w), (1, 0));
}

#[tokio::test]
async fn the_identity_of_the_cluster_and_the_shared_credential_come_from_the_watch_cache() {
    // The UID of kube-system and the backup credential of the region are written by no pass: any
    // version of them says what the newest does.
    let w = World::awake().await;
    let at = w.mark();
    w.reconciler
        .k8s
        .assert_cluster(&kube_system())
        .await
        .unwrap();
    w.reconciler
        .context(&w.db, &w.snapshot, false)
        .await
        .unwrap();
    let made = w.made(at);
    assert_eq!(made.len(), 2, "{made:?}");
    assert!(
        made.iter()
            .all(|(_, _, query)| query == "resourceVersion=0")
    );
}

#[tokio::test]
async fn the_reads_after_postgresql_answered_are_the_newest_versions() {
    // What a wake judges after PostgreSQL answered is judged as the barrier of its publication:
    // the Pod that answered and the Cluster as they are now, not as a cache last saw them.
    let mut w = World::parked().await;
    w.admitted();
    w.wake(3);
    w.start_postgres().await;
    let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX));
    let (state, marker) = (w.server.state.clone(), accepted.clone());
    w.sql.lock().unwrap().during.insert(
        "accepting",
        std::sync::Arc::new(move || {
            marker.store(
                state.lock().unwrap().requests.len(),
                std::sync::atomic::Ordering::SeqCst,
            );
        }),
    );
    let woken = reconcile(&w).await;
    assert_eq!(woken["state"], "ready", "{woken}");
    let from = accepted.load(std::sync::atomic::Ordering::SeqCst);
    assert_ne!(from, usize::MAX, "PostgreSQL answered");
    let after = w.made(from);
    let first = |wanted: &str| {
        after
            .iter()
            .find(|(method, at, _)| method == "GET" && at == wanted)
            .unwrap_or_else(|| panic!("{wanted} was read after PostgreSQL answered"))
    };
    for barrier in [
        path("Pod", Some(&w.ns), "database-1"),
        path("Cluster", Some(&w.ns), "database"),
    ] {
        assert_eq!(first(&barrier).2, "", "{barrier}");
    }
}
