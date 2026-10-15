// SPDX-License-Identifier: Apache-2.0
//! The reconciliation of a database that holds a retained instance Pod, against the in-process
//! doubles.
use super::{SYSTEM, *};
use crate::{test_server::path, test_world::*};

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
    // Order: progress `Wake`, one patch lifting the fence and releasing hibernation, the Pod's
    // requests returning, PostgreSQL's fresh postmaster, every role and the archive through the
    // Pod, and only then the gateway release that admits clients.
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
        wake < unfence,
        "intent is persisted before the Cluster write"
    );
    assert!(unfence < accepting && resize < release);
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
    assert_eq!(requests_since(&w, at), (103, 19), "the wake");
    let _ = w.watch_delivers();
    w.kubelet_ready_now()();
    let at = w.server.state.lock().unwrap().requests.len();
    let again = reconcile(&w).await;
    assert_eq!(again["state"], "ready", "{again}");
    assert_eq!(requests_since(&w, at), (86, 0), "the pass after it");
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
