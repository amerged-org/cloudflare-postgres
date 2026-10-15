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

#[tokio::test]
async fn a_parked_wake_unfences_resizes_and_publishes_after_sql_identity() {
    let mut w = World::parked().await;
    w.wake(3);
    w.start_postgres().await;
    w.log.lock().unwrap().clear();
    let _kubelet = w.kubelet_ready_after_unfence();
    let observed = reconcile(&w).await;
    // One pass: the retained Pod's identity and PostgreSQL's own answer prove the wake, and the
    // kubelet's Ready is awaited inside it because the gateway routes only to a Ready endpoint.
    assert_eq!(observed["state"], "ready", "{observed}");
    assert_eq!(observed["power"]["state"], "awake");
    assert_eq!(
        observed["runtime_attestation"]["pod_uid"],
        pod_uid(),
        "{observed}"
    );
    // Order: progress `Wake`, one patch lifting the fence and releasing hibernation, the Pod's
    // requests returning, PostgreSQL's fresh postmaster, the kubelet's Ready, every role and the
    // archive through the Pod, and only then the gateway release that admits clients.
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
    let ready = at(&w, &["KUBELET ready"]);
    assert!(
        wake < unfence,
        "intent is persisted before the Cluster write"
    );
    assert!(unfence < accepting && resize < release);
    assert!(ready < roles && ready < release, "{:#?}", log(&w));
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
async fn a_resumed_pod_is_published_only_once_the_kubelet_reports_it_ready() {
    // Until the gateway can route to an attested Pod before its Ready condition, an attested
    // `ready` before the kubelet's Ready would send the waking connection to no endpoint.
    let mut w = World::parked().await;
    w.quick();
    w.wake(3);
    w.start_postgres().await;
    let first = reconcile(&w).await;
    assert_eq!(first["state"], "provisioning", "{first}");
    assert_eq!(intent_mode(&w), "quiesce");
    assert!(log(&w).iter().all(|line| !line.contains("GATEWAY release")));
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
        w.quick();
        w.wake(3);
        w.start_postgres().await;
        let _kubelet = w.kubelet_ready_after_unfence();
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
    // Later passes continue on the same Pod under the kubelet's readiness, which is not yet there.
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

#[test]
fn a_resumed_pod_is_current_only_while_it_is_the_same_running_pod() {
    let db = json!({"node":"native-test-node"});
    let context = json!({"computePool":null});
    let cluster =
        json!({"apiVersion":"postgresql.cnpg.io/v1","metadata":{"uid":crate::test_server::uid(3)}});
    let wake = ParkedWake {
        pod_name: "database-1".into(),
        pod_uid: crate::test_server::uid(9),
        postgres_container_id: "containerd://a".into(),
        sidecar_container_id: "containerd://b".into(),
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
    };
    let pod = json!({"metadata":{"uid":crate::test_server::uid(9),"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":crate::test_server::uid(3)}]},
        "spec":{"nodeName":"native-test-node"},
        "status":{"phase":"Running","containerStatuses":[{"name":"postgres","containerID":"containerd://a"}],"initContainerStatuses":[{"name":"plugin-barman-cloud","containerID":"containerd://b"}]}});
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
    // The Ready bit is not read.
    let mut ready = pod.clone();
    ready["status"]["conditions"] = json!([{"type":"Ready","status":"False"}]);
    assert!(resumed_current(&ready, &cluster, &db, &context, &wake));
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
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    let target: Value = serde_json::from_str(text(&map["data"], "admission_target")).unwrap();
    assert_eq!(target["pod_uid"], crate::test_server::uid(77));
    assert_eq!(target["generation"], 3);
}
