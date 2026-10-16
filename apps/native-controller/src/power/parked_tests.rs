// SPDX-License-Identifier: Apache-2.0
//! The parked sleep tier against the in-process Kubernetes, gateway and PostgreSQL doubles:
//! the controller's real code runs, only the cluster around it is simulated.
use super::{SYSTEM, parked::effective_requests, *};
use crate::{
    contracts::schema_valid,
    manifests,
    test_server::{path, uid},
    test_world::*,
};

fn cluster_path(w: &World) -> String {
    path("Cluster", Some(&w.ns), "database")
}
fn fence_path(w: &World) -> String {
    path(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
    )
}
fn pod_path(w: &World) -> String {
    path("Pod", Some(&w.ns), "database-1")
}
fn resize_path(w: &World) -> String {
    format!("{}/resize", pod_path(w))
}
async fn sleep_pass(w: &World) -> Option<Value> {
    w.sleep_pass().await
}
fn progress(w: &World) -> Value {
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .expect("gateway fence");
    serde_json::from_str(text(&map["data"], "power.json")).unwrap()
}
fn intent(w: &World) -> Value {
    let map = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .expect("gateway fence");
    serde_json::from_str(text(&map["data"], "intent.json")).unwrap()
}
fn annotations(w: &World) -> Value {
    w.server.get("Cluster", Some(&w.ns), "database").unwrap()["metadata"]["annotations"].clone()
}
/// Bodies of every PATCH to `path`, in order.
fn patches(w: &World, path: &str) -> Vec<Value> {
    w.server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .filter(|(method, at, _)| method == "PATCH" && at == path)
        .map(|(_, _, body)| body.clone())
        .collect()
}
/// Position in the write log of the first PATCH to `path` whose body satisfies `wanted`.
fn position(w: &World, path: &str, wanted: impl Fn(&Value) -> bool) -> Option<usize> {
    w.server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .position(|(method, at, body)| method == "PATCH" && at == path && wanted(body))
}
fn fence_value(w: &World) -> Value {
    annotations(w)[FENCE].clone()
}
/// What the first pass of a demotion under the parked intent observes: the Pod is still held,
/// and the fast wake is no longer promised.
fn withdrawn(observed: Option<Value>) -> Value {
    let observed = observed.expect("the first pass of a demotion observes the Pod once more");
    assert_eq!(observed["state"], "hibernated");
    assert_eq!(observed["power"]["parked"]["pod_uid"], pod_uid());
    assert!(
        observed["power"]["parked"].get("wake").is_none(),
        "{observed}"
    );
    assert!(schema_valid("DatabaseObservation", &observed), "{observed}");
    observed
}
fn now() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap()
}
fn quick(w: &mut World) {
    w.quick();
}
fn stopped(w: &World) {
    w.stopped();
}
async fn parked() -> World {
    let w = World::parked().await;
    assert_eq!(progress(&w)["phase"], "parked");
    w
}
/// The inputs a wake judges the retained Pod by, owned so a test can change them.
struct Inputs {
    manifests: Vec<Value>,
    runtime_class: String,
}
impl Inputs {
    async fn of(w: &World) -> Self {
        let context = w
            .reconciler
            .context(&w.db, &w.snapshot, false)
            .await
            .unwrap();
        Self {
            manifests: manifests::build(&w.db, &context).unwrap(),
            runtime_class: String::new(),
        }
    }
}
async fn wake_pass(w: &World, inputs: &Inputs) -> PrepareRunning {
    w.reconciler
        .power
        .prepare_running(
            &w.db,
            &Basis {
                node: &w.node,
                release: &w.snapshot.fleet_release,
                manifests: Some(&inputs.manifests),
                runtime_class: &inputs.runtime_class,
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn an_idle_sleep_parks_only_after_the_recorded_segment_is_archived() {
    let mut w = World::awake().await;
    quick(&mut w);
    w.sql.lock().unwrap().archived = false;
    // The closed segment is recorded, but its `.done` is absent: nothing may be fenced.
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "archive");
    assert_eq!(progress(&w)["segment"], "0000000100000000000000A7");
    assert!(annotations(&w)[FENCE].is_null());
    assert!(patches(&w, &cluster_path(&w)).is_empty());
    w.sql.lock().unwrap().archived = true;
    assert!(sleep_pass(&w).await.is_none());
    // `Parking` is persisted before the fence patch, the fence is exactly `["*"]`, and the
    // hibernation annotation is never touched.
    let record = progress(&w);
    assert_eq!(record["phase"], "parking");
    assert_eq!(record["park"]["podUid"], pod_uid());
    assert_eq!(record["park"]["podName"], "database-1");
    assert_eq!(record["park"]["postgresContainerId"], POSTGRES_CONTAINER);
    assert_eq!(record["park"]["sidecarContainerId"], SIDECAR_CONTAINER);
    assert_eq!(record["park"]["nodeBootId"], BOOT_ID);
    assert_eq!(record["park"]["releaseId"], "r1");
    assert_eq!(record["park"]["specSha256"], "b".repeat(64));
    assert_eq!(record["park"]["assignmentRevision"], 3);
    assert_eq!(
        record["park"]["requestsBefore"],
        json!({"postgres":{"cpu":"25m","memory":"128Mi"},"sidecar":{"cpu":"100m","memory":"128Mi"}})
    );
    assert_eq!(fence_value(&w), "[\"*\"]");
    let notes = annotations(&w);
    assert!(notes[HIBERNATION].is_null());
    assert_eq!(notes[POWER_REVISION], "2");
    assert_eq!(notes[POWER_OPERATION], text(&w.db["power"], "operation"));
    let parking = position(&w, &fence_path(&w), |b| {
        b["data"]["power.json"]
            .as_str()
            .is_some_and(|raw| raw.contains("\"phase\":\"parking\""))
    })
    .expect("Parking persisted");
    let fenced = position(&w, &cluster_path(&w), |b| {
        b["metadata"]["annotations"][FENCE].is_string()
    })
    .expect("fence patch");
    assert!(
        parking < fenced,
        "intent is persisted before the Cluster write"
    );
    assert_eq!(patches(&w, &cluster_path(&w)).len(), 1);
    // The idle intent of the sleep is the gateway's fence intent throughout.
    assert_eq!(intent(&w)["mode"], "quiesce");
}

#[tokio::test]
async fn a_busy_or_unproved_sleep_never_fences() {
    for (busy, prepared) in [(1, 0), (0, 1)] {
        let mut w = World::awake().await;
        quick(&mut w);
        {
            let mut sql = w.sql.lock().unwrap();
            sql.busy = busy;
            sql.prepared = prepared;
        }
        let refused = sleep_pass(&w).await.expect("a refusal");
        assert_eq!(refused["state"], "error");
        assert_eq!(refused["power"]["refusal"], "busy");
        assert_eq!(progress(&w)["phase"], "refused");
        assert!(annotations(&w)[FENCE].is_null());
        assert!(annotations(&w)[HIBERNATION].is_null());
        assert!(patches(&w, &cluster_path(&w)).is_empty());
    }
}

#[tokio::test]
async fn park_requires_a_stopped_postmaster_and_fence_gauge() {
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // Fenced by annotation alone proves nothing: the exporter still says not fenced.
    w.stop_postgres();
    w.pod(false);
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // The gauge alone proves nothing while a postmaster still answers the port.
    w.gateway.fenced(true);
    w.start_postgres().await;
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // Both together, bound to the recorded Pod, park the database.
    w.stop_postgres();
    let observed = sleep_pass(&w).await.expect("parked");
    assert_eq!(progress(&w)["phase"], "parked");
    assert_eq!(observed["state"], "hibernated");
    assert_eq!(observed["power"]["state"], "hibernated");
    assert_eq!(observed["power"]["parked"]["pod_uid"], pod_uid());
    assert!(schema_valid("DatabaseObservation", &observed), "{observed}");
}

#[tokio::test]
async fn parking_never_confirms_a_replaced_pod() {
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    stopped(&w);
    // CNPG replaced the Pod before the stop was confirmed: the recorded identity is gone, so the
    // sleep completes as the hibernation it would have been, with the fence left in place.
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["metadata"]["uid"] = uid(77).into();
    });
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert_eq!(fence_value(&w), "[\"*\"]");
}

#[tokio::test]
async fn an_uncertain_fence_patch_is_read_before_continuing() {
    let mut w = World::awake().await;
    quick(&mut w);
    // The first fence patch commits and its reply is lost.
    w.server.state.lock().unwrap().lose = Some(Box::new(|path, body| {
        path.ends_with("/clusters/database") && body["metadata"]["annotations"][FENCE].is_string()
    }));
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(fence_value(&w), "[\"*\"]");
    assert_eq!(
        progress(&w)["phase"],
        "parking",
        "an unknown write is not a refusal"
    );
    // The next pass reads the committed fence and never writes it again.
    stopped(&w);
    let observed = sleep_pass(&w).await.expect("parked");
    assert_eq!(observed["power"]["parked"]["pod_uid"], pod_uid());
    assert_eq!(
        patches(&w, &cluster_path(&w))
            .iter()
            .filter(|body| body["metadata"]["annotations"][FENCE].is_string())
            .count(),
        1
    );
}

#[tokio::test]
async fn resize_down_uses_strategic_merge_on_the_resize_subresource_and_never_changes_limits() {
    let w = parked().await;
    let state = w.server.state.lock().unwrap();
    let sent: Vec<_> = state
        .writes
        .iter()
        .filter(|(_, at, _)| *at == resize_path(&w))
        .collect();
    assert_eq!(sent.len(), 1);
    let body = &sent[0].2;
    assert_eq!(body["metadata"], json!({"uid":pod_uid()}));
    assert_eq!(
        body["spec"],
        json!({"containers":[{"name":"postgres","resources":{"requests":{"cpu":"10m","memory":"96Mi"}}}],
               "initContainers":[{"name":"plugin-barman-cloud","resources":{"requests":{"cpu":"5m","memory":"64Mi"}}}]})
    );
    assert!(state.patch_types.iter().any(
        |(at, kind)| *at == resize_path(&w) && kind == "application/strategic-merge-patch+json"
    ));
    drop(state);
    // Limits and the other init container are untouched; only the two requests changed.
    let pod = w.server.get("Pod", Some(&w.ns), "database-1").unwrap();
    assert_eq!(
        pod["spec"]["containers"][0]["resources"]["limits"],
        json!({"cpu":"250m","memory":"256Mi"})
    );
    assert_eq!(
        pod["spec"]["initContainers"][1]["resources"]["limits"],
        json!({"cpu":"500m","memory":"512Mi"})
    );
    assert_eq!(
        pod["spec"]["initContainers"][0]["resources"]["requests"],
        json!({"cpu":"25m","memory":"128Mi"})
    );
    assert_eq!(
        progress(&w)["park"]["requestsParked"],
        json!({"postgres":{"cpu":"10m","memory":"96Mi"},"sidecar":{"cpu":"5m","memory":"64Mi"}})
    );
}

#[tokio::test]
async fn the_parked_request_is_what_kubernetes_sums_for_the_pod() {
    // The `bootstrap-controller` init container keeps the Cluster's requests, so the Pod's
    // effective request never falls below it, whatever the two resized containers request.
    let w = parked().await;
    let observed = sleep_pass(&w).await.expect("still parked");
    assert_eq!(observed["power"]["parked"]["cpu_millicores"], 25);
    assert_eq!(observed["power"]["parked"]["memory_mib"], 160);
}

#[tokio::test]
async fn a_rejected_resize_parks_with_full_requests_recorded() {
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    stopped(&w);
    w.server.state.lock().unwrap().refuse =
        Some(Box::new(|path, _| path.ends_with("/resize").then_some(422)));
    let observed = sleep_pass(&w).await.expect("parked anyway");
    assert_eq!(progress(&w)["phase"], "parked");
    assert_eq!(
        progress(&w)["park"]["requestsParked"],
        progress(&w)["park"]["requestsBefore"]
    );
    // The Pod keeps its awake requests, and so does what the observation reports.
    assert_eq!(observed["power"]["parked"]["cpu_millicores"], 125);
    assert_eq!(observed["power"]["parked"]["memory_mib"], 256);
}

#[test]
fn the_effective_request_follows_kubernetes_init_container_and_sidecar_rules() {
    let pod = |containers: Value, init: Value, status: Value, overhead: Value| json!({"spec":{"containers":containers,"initContainers":init,"overhead":overhead},"status":status});
    let request =
        |cpu: &str, memory: &str| json!({"resources":{"requests":{"cpu":cpu,"memory":memory}}});
    let with = |name: &str, base: Value| {
        let mut base = base;
        base["name"] = name.into();
        base
    };
    let sidecar = |cpu: &str, memory: &str| {
        let mut container = with("plugin-barman-cloud", request(cpu, memory));
        container["restartPolicy"] = "Always".into();
        container
    };
    // Containers plus restartable init containers, against the largest regular init container.
    let value = pod(
        json!([with("postgres", request("100m", "256Mi"))]),
        json!([
            with("bootstrap-controller", request("100m", "256Mi")),
            sidecar("100m", "128Mi")
        ]),
        json!({}),
        Value::Null,
    );
    assert_eq!(effective_requests(&value), Some((200, 384)));
    // After the resize the regular init container is the floor.
    let value = pod(
        json!([with("postgres", request("10m", "96Mi"))]),
        json!([
            with("bootstrap-controller", request("100m", "256Mi")),
            sidecar("5m", "64Mi")
        ]),
        json!({}),
        Value::Null,
    );
    assert_eq!(effective_requests(&value), Some((100, 256)));
    // The overhead of the RuntimeClass is added.
    let value = pod(
        json!([with("postgres", request("10m", "96Mi"))]),
        json!([]),
        json!({}),
        json!({"cpu":"50m","memory":"64Mi"}),
    );
    assert_eq!(effective_requests(&value), Some((60, 160)));
    // A shrink the kubelet has not actuated yet still counts at the larger status value, and a
    // fractional millicore or MiB is rounded up.
    let value = pod(
        json!([with("postgres", request("10m", "96Mi"))]),
        json!([]),
        json!({"containerStatuses":[{"name":"postgres","resources":{"requests":{"cpu":"100m","memory":"100Mi"}}}]}),
        Value::Null,
    );
    assert_eq!(effective_requests(&value), Some((100, 100)));
    let value = pod(
        json!([with("postgres", request("1500u", "1500Ki"))]),
        json!([]),
        json!({}),
        Value::Null,
    );
    assert_eq!(effective_requests(&value), Some((2, 2)));
}

#[tokio::test]
async fn a_disabled_or_absent_parking_policy_hibernates_exactly_as_before() {
    for policy in [
        Value::Null,
        json!({"enabled":false,"ttl_seconds":600,"max_per_node":8,"postgres_cpu_millicores":10,"postgres_memory_mib":96,"sidecar_cpu_millicores":5,"sidecar_memory_mib":64}),
        json!({"enabled":true,"ttl_seconds":600,"max_per_node":0,"postgres_cpu_millicores":10,"postgres_memory_mib":96,"sidecar_cpu_millicores":5,"sidecar_memory_mib":64}),
    ] {
        let mut w = World::awake().await;
        quick(&mut w);
        w.snapshot.region["parking"] = policy;
        assert!(sleep_pass(&w).await.is_none());
        assert_eq!(progress(&w)["phase"], "hibernating");
        assert!(progress(&w)["park"].is_null());
        assert_eq!(annotations(&w)[HIBERNATION], "on");
        assert!(annotations(&w)[FENCE].is_null());
        for body in patches(&w, &cluster_path(&w)) {
            assert!(body["metadata"]["annotations"].get(FENCE).is_none());
        }
        assert!(
            w.server
                .state
                .lock()
                .unwrap()
                .writes
                .iter()
                .all(|(_, at, _)| *at != resize_path(&w))
        );
    }
}

#[tokio::test]
async fn an_explicit_suspend_is_a_real_hibernation() {
    let mut w = World::awake().await;
    quick(&mut w);
    w.db["power"]["reason"] = "manual".into();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert!(annotations(&w)[FENCE].is_null());
}

#[tokio::test]
async fn a_pod_that_is_not_the_single_running_instance_is_never_parked() {
    let mut w = World::awake().await;
    quick(&mut w);
    // A second non-terminal instance Pod: nothing identifies which one to retain.
    w.server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-2","namespace":w.ns,"uid":uid(78),"labels":{"cnpg.io/cluster":"database"},"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":cluster_uid(),"controller":true}]},"spec":{"nodeName":NODE},"status":{"phase":"Running"}}));
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(annotations(&w)[FENCE].is_null());
}

#[tokio::test]
async fn the_node_cap_is_a_precondition_of_parking() {
    // One other database holds a parked Pod on this node and the policy allows two: this one parks.
    let mut w = World::awake().await;
    quick(&mut w);
    seed_other(&w, "aaaaaaaaaaaaaaaaaaaa", "parked", now() - 1000, NODE);
    w.snapshot.region["parking"]["max_per_node"] = 2.into();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // A database whose demotion has not removed its Pod yet still holds its slot; an ordinary
    // hibernation in progress holds none.
    for (park, parks) in [(true, false), (false, true)] {
        let mut w = World::awake().await;
        quick(&mut w);
        let mut record = json!({"phase":"hibernating","anchor":{"node":NODE}});
        if park {
            record["park"] = json!({"parkedAt":now() - 1000});
        }
        seed_record(&w, "aaaaaaaaaaaaaaaaaaaa", record);
        w.snapshot.region["parking"]["max_per_node"] = 1.into();
        assert!(sleep_pass(&w).await.is_none());
        assert_eq!(
            progress(&w)["phase"] == "parking",
            parks,
            "a demoting record holds a slot: {park}"
        );
    }
    // With a second one the node is full and the sleep is a real hibernation.
    let mut w = World::awake().await;
    quick(&mut w);
    for (index, id) in ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb"]
        .iter()
        .enumerate()
    {
        seed_other(&w, id, "parked", now() - 1000 * (index as u64 + 1), NODE);
    }
    w.snapshot.region["parking"]["max_per_node"] = 2.into();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(annotations(&w)[FENCE].is_null());
}

/// The fence ConfigMap of another database whose progress is in `phase` on `node`.
fn seed_other(w: &World, id: &str, phase: &str, parked_at: u64, node: &str) {
    seed_record(
        w,
        id,
        json!({"phase":phase,"anchor":{"node":node},"park":{"parkedAt":parked_at}}),
    );
}
/// The fence ConfigMap of another database with the progress `record`.
fn seed_record(w: &World, id: &str, record: Value) {
    w.server.put(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{id}"),"namespace":SYSTEM,"uid":uid(500),"labels":{"pgcf.io/database-id":id,wire("fenceLabel"):"true"}},"data":{"power.json":record.to_string()}}));
}

#[tokio::test]
async fn a_parked_observation_claims_a_fast_wake_only_while_the_pod_is_eligible() {
    // The observation that ends the sleep already carries the claim, ...
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    stopped(&w);
    let first = sleep_pass(&w).await.expect("parked");
    assert_eq!(first["power"]["parked"]["wake"], "fast", "{first}");
    assert!(schema_valid("DatabaseObservation", &first), "{first}");
    // ... and so does every later one while nothing the Pod was parked under has changed.
    let again = sleep_pass(&w).await.expect("still parked");
    assert_eq!(again["power"]["parked"]["wake"], "fast", "{again}");
    assert_eq!(progress(&w)["phase"], "parked");
}

#[tokio::test]
async fn drift_while_parked_demotes_the_pod_before_any_wake_can_meet_it() {
    type Change = Box<dyn Fn(&mut World)>;
    let rotated = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "rotated");
    // The Pod that was parked is still the one that is held, except where the drift is that Pod
    // being another one: then there is nothing left to observe as parked.
    let changes: Vec<(&str, bool, Change)> = vec![
        (
            "role password",
            true,
            Box::new(|w| w.db["roles"][0]["password"] = "z".repeat(43).into()),
        ),
        (
            "size",
            true,
            Box::new(|w| w.db["size"]["memory_mib"] = 512.into()),
        ),
        (
            "desired image",
            true,
            Box::new(|w| {
                w.db["postgres"] = json!({"release_id":"pg-2","image":format!("registry.test/postgres@sha256:{}","f".repeat(64)),"version":"18.2","configuration_schema_revision":1});
            }),
        ),
        (
            "backup credentials of the region",
            true,
            Box::new(move |w| {
                let rotated = rotated.clone();
                w.server
                    .edit("Secret", Some(SYSTEM), "pgcf-backup-s3", |secret| {
                        secret["data"]["AWS_ACCESS_KEY_ID"] = rotated.into();
                    });
            }),
        ),
        (
            "image of the Pod",
            true,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["spec"]["containers"][0]["image"] =
                        format!("registry.test/postgres@sha256:{}", "e".repeat(64)).into();
                });
            }),
        ),
        (
            "runtime of the Pod",
            true,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["spec"]["runtimeClassName"] = "pgcf-prestarted".into();
                });
            }),
        ),
        (
            "container of the Pod",
            false,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["status"]["containerStatuses"][0]["containerID"] =
                        "containerd://other".into();
                });
            }),
        ),
        (
            "boot of the node",
            true,
            Box::new(|w| {
                w.node["status"]["nodeInfo"]["bootID"] =
                    "01234567-89ab-4def-8123-0000000000b2".into();
            }),
        ),
        (
            "fleet release",
            true,
            Box::new(|w| {
                w.snapshot.fleet_release["release"]["spec_sha256"] = "c".repeat(64).into()
            }),
        ),
    ];
    for (name, held, change) in changes {
        let mut w = parked().await;
        change(&mut w);
        // The pass that finds the drift starts the demotion and withdraws the claim; the Pod is
        // never resumed and PostgreSQL never starts for it.
        let first = sleep_pass(&w).await;
        if held {
            withdrawn(first);
        } else {
            assert!(first.is_none(), "{name}");
        }
        assert_eq!(progress(&w)["phase"], "hibernating", "{name}");
        assert_eq!(annotations(&w)[HIBERNATION], "on", "{name}");
        assert_eq!(fence_value(&w), "[\"*\"]", "{name}");
        assert_eq!(
            patches(&w, &resize_path(&w)).len(),
            1,
            "{name}: no resize up"
        );
        // It ends as the plain hibernated observation, which clears the parked record.
        hibernated(&w);
        let done = sleep_pass(&w).await.expect(name);
        assert_eq!(done["state"], "hibernated", "{name}");
        assert!(done["power"]["parked"].is_null(), "{name}");
        assert_eq!(progress(&w)["phase"], "hibernated", "{name}");
        assert!(annotations(&w)[FENCE].is_null(), "{name}");
    }
}

#[tokio::test]
async fn a_wake_that_cannot_be_proved_is_not_claimed_and_is_not_given_up() {
    let w = parked().await;
    // The manifests cannot be built: nothing is claimed, and the Pod is not demoted for it.
    let observed = w.sleep_with(None, "").await.expect("still parked");
    assert_eq!(observed["power"]["parked"]["pod_uid"], pod_uid());
    assert!(observed["power"]["parked"].get("wake").is_none());
    assert_eq!(progress(&w)["phase"], "parked");
    assert!(annotations(&w)[HIBERNATION].is_null());
    // A manifest that cannot be read this pass is no more a drift than one that cannot be built.
    w.server.state.lock().unwrap().refuse_read = Some(Box::new(|path| {
        path.contains("/networkpolicies/").then_some(500)
    }));
    let observed = sleep_pass(&w).await.expect("still parked");
    assert!(observed["power"]["parked"].get("wake").is_none());
    assert_eq!(progress(&w)["phase"], "parked");
    assert!(annotations(&w)[HIBERNATION].is_null());
    // The claim returns with the first pass that proves the wake again.
    w.server.state.lock().unwrap().refuse_read = None;
    let observed = sleep_pass(&w).await.expect("still parked");
    assert_eq!(observed["power"]["parked"]["wake"], "fast");
}

#[tokio::test]
async fn a_pod_the_desired_state_would_change_is_never_parked() {
    // The desired state already differs from what the Pod was created from when the sleep is
    // proved: retaining it would only delay the wake, so the sleep is a real hibernation.
    let mut w = World::awake().await;
    quick(&mut w);
    w.db["roles"][0]["password"] = "z".repeat(43).into();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(progress(&w)["park"].is_null());
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    // So is one whose desired manifests cannot be built.
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(w.sleep_with(None, "").await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(annotations(&w)[FENCE].is_null());
}

#[tokio::test]
async fn a_pod_that_drifts_while_it_is_parked_is_demoted_instead_of_parked() {
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // The desired state changes between the fence and the confirmation of the stop.
    w.db["roles"][0]["password"] = "z".repeat(43).into();
    stopped(&w);
    withdrawn(sleep_pass(&w).await);
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(progress(&w)["park"]["stopped"], true);
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert_eq!(fence_value(&w), "[\"*\"]");
}

#[tokio::test]
async fn the_manifests_judged_while_asleep_are_those_the_wake_applies() {
    let mut w = World::awake().await;
    let cluster = w.server.get("Cluster", Some(&w.ns), "database");
    let asleep = w
        .reconciler
        .retained_manifests(&w.db, &w.snapshot, cluster.as_ref(), false)
        .await;
    assert_eq!(asleep.runtime_class, "");
    // The API omits a suspended database's scheduling request, which a running one carries.
    assert!(w.db["size"].get("memory_request_mib").is_none());
    w.wake(3);
    let waking = Inputs::of(&w).await.manifests;
    assert_eq!(asleep.manifests.expect("built while asleep"), waking);
}

#[tokio::test]
async fn only_a_database_that_may_hold_a_pod_has_its_manifests_built_while_asleep() {
    type Change = Box<dyn Fn(&mut World)>;
    let cases: Vec<(&str, Change)> = vec![
        (
            "explicit suspend",
            Box::new(|w| w.db["power"]["reason"] = "manual".into()),
        ),
        (
            "no parking policy",
            Box::new(|w| w.snapshot.region["parking"] = Value::Null),
        ),
        (
            "disabled parking policy",
            Box::new(|w| w.snapshot.region["parking"]["enabled"] = false.into()),
        ),
        (
            "hibernated cluster",
            Box::new(|w| {
                w.server
                    .edit("Cluster", Some(&w.ns), "database", |cluster| {
                        cluster["metadata"]["annotations"][HIBERNATION] = "on".into();
                    });
            }),
        ),
    ];
    for (name, change) in cases {
        let mut w = World::awake().await;
        change(&mut w);
        let cluster = w.server.get("Cluster", Some(&w.ns), "database");
        let retained = w
            .reconciler
            .retained_manifests(&w.db, &w.snapshot, cluster.as_ref(), false)
            .await;
        assert!(retained.manifests.is_none(), "{name}");
    }
}

#[tokio::test]
async fn a_parked_wake_unfences_resizes_and_resumes_the_same_pod() {
    let mut w = parked().await;
    w.wake(3);
    w.start_postgres().await;
    let inputs = Inputs::of(&w).await;
    let started = std::time::Instant::now();
    let PrepareRunning::Parked(resumed) = wake_pass(&w, &inputs).await else {
        panic!("a parked database with unchanged desired state wakes fast");
    };
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(resumed.pod_uid, pod_uid());
    assert_eq!(resumed.pod_name, "database-1");
    // Progress `Wake` is written with the single Cluster patch, which removes the fence and
    // sets hibernation off together, and with the resize up: one wave of three writes.
    assert_eq!(progress(&w)["phase"], "wake");
    assert!(
        position(&w, &fence_path(&w), |b| {
            b["data"]["power.json"]
                .as_str()
                .is_some_and(|raw| raw.contains("\"phase\":\"wake\""))
        })
        .is_some(),
        "the record of the wake was written"
    );
    assert!(
        position(&w, &cluster_path(&w), |b| {
            b["metadata"]["annotations"][FENCE].is_null()
                && b["metadata"]["annotations"].get(FENCE).is_some()
                && b["metadata"]["annotations"][HIBERNATION] == "off"
        })
        .is_some(),
        "one patch removes the fence and sets hibernation off"
    );
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "off");
    let resized = patches(&w, &resize_path(&w));
    assert_eq!(resized.len(), 2, "down at the sleep, up at the wake");
    assert_eq!(
        resized[1]["spec"]["containers"],
        json!([{"name":"postgres","resources":{"requests":{"cpu":"25m","memory":"128Mi"}}}])
    );
    assert_eq!(
        resized[1]["spec"]["initContainers"],
        json!([{"name":"plugin-barman-cloud","resources":{"requests":{"cpu":"100m","memory":"128Mi"}}}])
    );
    // No client was admitted: the gateway fence intent is still the sleep's.
    assert_eq!(intent(&w)["mode"], "quiesce");
}

#[tokio::test]
async fn any_manifest_content_change_takes_the_slow_path() {
    type Change = Box<dyn Fn(&mut Value)>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "role password",
            Box::new(|db| db["roles"][0]["password"] = "z".repeat(43).into()),
        ),
        ("size", Box::new(|db| db["size"]["memory_mib"] = 512.into())),
        (
            "image",
            Box::new(|db| {
                db["postgres"] = json!({"release_id":"pg-2","image":format!("registry.test/postgres@sha256:{}","f".repeat(64)),"version":"18.2","configuration_schema_revision":1});
            }),
        ),
        (
            "plugin",
            Box::new(|db| db["size"]["backup_retention_days"] = 30.into()),
        ),
    ];
    for (name, change) in changes {
        let mut w = parked().await;
        w.wake(3);
        change(&mut w.db);
        let inputs = Inputs::of(&w).await;
        let outcome = wake_pass(&w, &inputs).await;
        assert!(
            matches!(outcome, PrepareRunning::Pending),
            "{name}: a changed manifest demotes first"
        );
        // Demotion A: hibernation on with the fence left in place, and nothing resumed.
        assert_eq!(annotations(&w)[HIBERNATION], "on", "{name}");
        assert_eq!(fence_value(&w), "[\"*\"]", "{name}");
        assert_eq!(progress(&w)["phase"], "hibernating", "{name}");
        assert_eq!(
            patches(&w, &resize_path(&w)).len(),
            1,
            "{name}: no resize up"
        );
    }
}

#[tokio::test]
async fn a_wake_that_cannot_build_the_manifests_takes_the_slow_path() {
    let mut w = parked().await;
    w.wake(3);
    let outcome = w
        .reconciler
        .power
        .prepare_running(
            &w.db,
            &Basis {
                node: &w.node,
                release: &w.snapshot.fleet_release,
                manifests: None,
                runtime_class: "",
            },
        )
        .await
        .unwrap();
    assert!(matches!(outcome, PrepareRunning::Pending));
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert_eq!(fence_value(&w), "[\"*\"]");
    assert_eq!(patches(&w, &resize_path(&w)).len(), 1, "no resize up");
}

#[tokio::test]
async fn a_wake_of_a_pod_cnpg_replaced_continues_on_the_replacement_without_a_demotion() {
    // Only the Pod is another one (or the same one with new containers, or one on a rebooted
    // node), and nothing the wake applies changed: the instance CNPG keeps resumes through the
    // ordinary wake, whatever its phase, instead of being hibernated and created once more.
    type Change = Box<dyn Fn(&mut World)>;
    let changes: Vec<(&str, bool, Change)> = vec![
        (
            "pod uid",
            false,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["metadata"]["uid"] = uid(77).into();
                });
            }),
        ),
        (
            "postgres container",
            true,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["status"]["containerStatuses"][0]["containerID"] =
                        "containerd://other".into();
                });
            }),
        ),
        (
            "sidecar container",
            true,
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["status"]["initContainerStatuses"][0]["containerID"] =
                        "containerd://other".into();
                });
            }),
        ),
        (
            "boot id",
            true,
            Box::new(|w| {
                w.node["status"]["nodeInfo"]["bootID"] =
                    "01234567-89ab-4def-8123-0000000000b2".into();
            }),
        ),
    ];
    for phase_stuck in [false, true] {
        for (name, same_pod, change) in &changes {
            let mut w = parked().await;
            w.wake(3);
            change(&mut w);
            if phase_stuck {
                stuck(&w);
            }
            let inputs = Inputs::of(&w).await;
            assert!(
                matches!(wake_pass(&w, &inputs).await, PrepareRunning::Proceed),
                "{name}: the ordinary wake continues"
            );
            assert!(annotations(&w)[FENCE].is_null(), "{name}");
            assert_eq!(annotations(&w)[HIBERNATION], "off", "{name}");
            assert_eq!(progress(&w)["phase"], "wake", "{name}");
            assert!(
                patches(&w, &cluster_path(&w))
                    .iter()
                    .all(|b| b["metadata"]["annotations"][HIBERNATION] != "on"),
                "{name}: no demotion"
            );
            // The Pod that is still the parked object gets its requests back; a replacement was
            // created with them.
            let up = usize::from(*same_pod);
            assert_eq!(
                patches(&w, &resize_path(&w)).len(),
                1 + up,
                "{name}: resize up only for the same Pod"
            );
        }
    }
}

#[tokio::test]
async fn a_changed_release_or_runtime_takes_the_slow_path() {
    // An operator or runtime upgrade would roll the Pod right after the unfence: it is hibernated
    // first and created once more by the ordinary wake.
    type Change = Box<dyn Fn(&mut World)>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "release id",
            Box::new(|w| w.snapshot.fleet_release["release"]["id"] = "r2".into()),
        ),
        (
            "release spec",
            Box::new(|w| {
                w.snapshot.fleet_release["release"]["spec_sha256"] = "c".repeat(64).into()
            }),
        ),
        (
            "node assignment",
            Box::new(|w| w.snapshot.fleet_release["nodes"][0]["revision"] = 4.into()),
        ),
        (
            "runtime class",
            Box::new(|w| {
                w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                    pod["spec"]["runtimeClassName"] = "pgcf-prestarted".into();
                });
            }),
        ),
    ];
    for (name, change) in changes {
        let mut w = parked().await;
        w.wake(3);
        change(&mut w);
        let inputs = Inputs::of(&w).await;
        assert!(
            matches!(wake_pass(&w, &inputs).await, PrepareRunning::Pending),
            "{name}: demoted first"
        );
        assert_eq!(fence_value(&w), "[\"*\"]", "{name}: no unfence");
        assert_eq!(annotations(&w)[HIBERNATION], "on", "{name}");
    }
}

#[tokio::test]
async fn a_drifted_wake_with_a_stuck_phase_lifts_the_fence_together_with_hibernation() {
    // A slow path that meets a phase below healthy cannot hibernate a fenced instance: one patch
    // lifts the fence and sets hibernation on, and CNPG hibernates once the instance is healthy.
    let mut w = parked().await;
    w.wake(3);
    w.db["roles"][0]["password"] = "z".repeat(43).into();
    stuck(&w);
    let inputs = Inputs::of(&w).await;
    assert!(matches!(
        wake_pass(&w, &inputs).await,
        PrepareRunning::Pending
    ));
    assert_eq!(fence_lifted_with_hibernation(&w), 1);
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert_eq!(intent(&w)["mode"], "quiesce", "the gateway stays closed");
    // Once CNPG has hibernated it, the ordinary wake releases hibernation.
    hibernated(&w);
    assert!(matches!(
        wake_pass(&w, &inputs).await,
        PrepareRunning::Proceed
    ));
    assert_eq!(annotations(&w)[HIBERNATION], "off");
}

/// Simulates CNPG finishing a hibernation: the condition is reached and the Pod is terminal.
fn hibernated(w: &World) {
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["phase"] = "Cluster in healthy state".into();
            cluster["status"]["conditions"] =
                json!([{"type":HIBERNATION,"status":"True","reason":"Hibernated"}]);
        });
    w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
        pod["status"]["phase"] = "Failed".into();
    });
}
fn expire(w: &World) {
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut record: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
            record["park"]["parkedAt"] = (now() - 601_000).into();
            map["data"]["power.json"] = record.to_string().into();
        },
    );
}

#[tokio::test]
async fn ttl_demotes_a_parked_database_without_starting_postgres_when_phase_is_healthy() {
    let mut w = parked().await;
    quick(&mut w);
    // Unexpired: the periodic pass only re-observes the parked Pod.
    let again = sleep_pass(&w).await.expect("still parked");
    assert_eq!(again["power"]["parked"]["pod_uid"], pod_uid());
    assert_eq!(progress(&w)["phase"], "parked");
    expire(&w);
    withdrawn(sleep_pass(&w).await);
    assert!(
        sleep_pass(&w).await.is_none(),
        "the demotion says nothing more until it has completed"
    );
    assert_eq!(progress(&w)["phase"], "hibernating");
    // Algorithm A: hibernation on with the fence left in place, so PostgreSQL never starts.
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert_eq!(fence_value(&w), "[\"*\"]");
    for body in patches(&w, &cluster_path(&w)) {
        assert!(
            body["metadata"]["annotations"][FENCE].is_string()
                || body["metadata"]["annotations"].get(FENCE).is_none(),
            "no patch removed the fence before hibernation completed"
        );
    }
    hibernated(&w);
    let done = sleep_pass(&w).await.expect("hibernated");
    assert_eq!(done["state"], "hibernated");
    assert!(done["power"]["parked"].is_null());
    assert!(
        annotations(&w)[FENCE].is_null(),
        "the fence goes with the demotion"
    );
    assert_eq!(progress(&w)["phase"], "hibernated");
    assert!(progress(&w)["park"].is_null());
}

/// CNPG's phase while an instance it recreated stays fenced: never healthy again by itself.
fn stuck(w: &World) {
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["phase"] = "Waiting for the instances to become active".into();
        });
}
/// Cluster patches that lift the fence and set hibernation on in the same write.
fn fence_lifted_with_hibernation(w: &World) -> usize {
    patches(w, &cluster_path(w))
        .iter()
        .filter(|b| {
            b["metadata"]["annotations"].get(FENCE) == Some(&Value::Null)
                && b["metadata"]["annotations"][HIBERNATION] == "on"
        })
        .count()
}

#[tokio::test]
async fn a_parked_pod_that_cnpg_recreated_is_demoted_while_asleep() {
    // A node reboot, an eviction or a deleted Pod: CNPG recreates the instance still fenced, so
    // its phase never becomes healthy again and a hibernation alone would wait for ever. The same
    // holds for any demotion that meets such a phase, here one the TTL starts.
    for recreated in [true, false] {
        let mut w = parked().await;
        quick(&mut w);
        if recreated {
            w.server.edit("Pod", Some(&w.ns), "database-1", |pod| {
                pod["metadata"]["uid"] = uid(77).into();
            });
        } else {
            expire(&w);
        }
        stuck(&w);
        // One patch lifts the fence and sets hibernation on: the instance starts PostgreSQL
        // behind the closed gateway, CNPG reaches a healthy phase and then hibernates it.
        let first = sleep_pass(&w).await;
        if recreated {
            assert!(
                first.is_none(),
                "the recorded Pod is gone: nothing is parked"
            );
        } else {
            withdrawn(first);
        }
        assert_eq!(progress(&w)["phase"], "hibernating");
        assert_eq!(fence_lifted_with_hibernation(&w), 1);
        assert!(annotations(&w)[FENCE].is_null());
        assert_eq!(annotations(&w)[HIBERNATION], "on");
        assert_eq!(intent(&w)["mode"], "quiesce", "the gateway stays closed");
        assert!(sleep_pass(&w).await.is_none(), "still waiting for CNPG");
        // CNPG hibernates the instance; the demotion ends as the plain hibernated observation.
        hibernated(&w);
        let done = sleep_pass(&w).await.expect("hibernated");
        assert_eq!(done["state"], "hibernated");
        assert!(done["power"]["parked"].is_null());
        assert_eq!(progress(&w)["phase"], "hibernated");
        assert!(progress(&w)["park"].is_null());
    }
}

#[tokio::test]
async fn a_cluster_below_its_healthy_phase_is_never_parked() {
    // Only a healthy Cluster can hibernate the Pod a demotion would give up, so only a healthy
    // one parks; any other sleep is the ordinary hibernation.
    let mut w = World::awake().await;
    quick(&mut w);
    stuck(&w);
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(progress(&w)["park"].is_null());
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "on");
}

#[tokio::test]
async fn a_stop_that_is_never_confirmed_falls_back_to_hibernation() {
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // PostgreSQL never stops behind the fence: within the sleep's budget the pass keeps waiting.
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
    // Past it, the sleep becomes the ordinary hibernation. Nothing was parked, so nothing is
    // observed as parked.
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut record: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
            record["startedAt"] = (now() - 601_000).into();
            map["data"]["power.json"] = record.to_string().into();
        },
    );
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    hibernated(&w);
    let done = sleep_pass(&w).await.expect("hibernated");
    assert_eq!(done["state"], "hibernated");
    assert!(done["power"]["parked"].is_null());
}

#[tokio::test]
async fn the_oldest_parked_databases_demote_themselves_when_the_cap_is_exceeded() {
    let mut w = parked().await;
    quick(&mut w);
    // Two younger parked databases on this node; the policy now allows two of three. A
    // database on another node does not count.
    seed_other(&w, "aaaaaaaaaaaaaaaaaaaa", "parked", now() - 10_000, NODE);
    seed_other(&w, "bbbbbbbbbbbbbbbbbbbb", "parked", now() - 20_000, NODE);
    seed_other(
        &w,
        "cccccccccccccccccccc",
        "parked",
        now() - 90_000,
        "another-node",
    );
    w.snapshot.region["parking"]["max_per_node"] = 2.into();
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut record: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
            record["park"]["parkedAt"] = (now() - 30_000).into();
            map["data"]["power.json"] = record.to_string().into();
        },
    );
    withdrawn(sleep_pass(&w).await);
    assert_eq!(
        progress(&w)["phase"],
        "hibernating",
        "the oldest demotes itself"
    );
    // Within the cap nothing demotes.
    let mut w = parked().await;
    quick(&mut w);
    seed_other(&w, "aaaaaaaaaaaaaaaaaaaa", "parked", now() - 10_000, NODE);
    w.snapshot.region["parking"]["max_per_node"] = 2.into();
    assert!(sleep_pass(&w).await.is_some());
    assert_eq!(progress(&w)["phase"], "parked");
    // A database already demoting still holds its slot and leaves first: its Pod is going, so the
    // excess it causes demotes nobody else, however young it is.
    let mut w = parked().await;
    quick(&mut w);
    seed_other(&w, "aaaaaaaaaaaaaaaaaaaa", "parked", now() - 10_000, NODE);
    seed_other(
        &w,
        "dddddddddddddddddddd",
        "hibernating",
        now() - 1_000,
        NODE,
    );
    w.snapshot.region["parking"]["max_per_node"] = 2.into();
    let again = sleep_pass(&w).await.expect("still parked");
    assert_eq!(again["power"]["parked"]["wake"], "fast");
    assert_eq!(progress(&w)["phase"], "parked");
}

#[tokio::test]
async fn a_gateway_replaced_while_parked_does_not_stall_the_demotion() {
    // A rolling update replaces the gateway Pod during the parked period. PostgreSQL was seen
    // stopped, so the demotion needs the current gateway to report the fence closed, not the
    // one the proof closed.
    let mut w = parked().await;
    quick(&mut w);
    w.replace_gateway();
    let again = sleep_pass(&w).await.expect("still parked");
    assert_eq!(again["power"]["parked"]["pod_uid"], pod_uid());
    expire(&w);
    withdrawn(sleep_pass(&w).await);
    assert_eq!(progress(&w)["phase"], "hibernating");
    hibernated(&w);
    let done = sleep_pass(&w).await.expect("hibernated");
    assert_eq!(done["state"], "hibernated");
    assert!(done["power"]["parked"].is_null());
    assert_eq!(progress(&w)["phase"], "hibernated");
}

#[tokio::test]
async fn parking_waits_for_the_gateways_the_proof_closed() {
    // Before PostgreSQL is seen stopped, a gateway that appeared since the proof may have
    // admitted a client: the sleep is not confirmed over it.
    let mut w = World::awake().await;
    quick(&mut w);
    assert!(sleep_pass(&w).await.is_none());
    stopped(&w);
    w.replace_gateway();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "parking");
}

#[tokio::test]
async fn disabling_the_policy_demotes_a_parked_database_at_once() {
    let mut w = parked().await;
    quick(&mut w);
    w.snapshot.region["parking"] = Value::Null;
    withdrawn(sleep_pass(&w).await);
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(annotations(&w)[HIBERNATION], "on");
}

#[tokio::test]
async fn manual_suspend_of_a_parked_database_hibernates_and_observes_the_new_operation() {
    let mut w = parked().await;
    quick(&mut w);
    w.db["generation"] = 3.into();
    w.db["power"] = json!({"operation":format!("op_{}","m".repeat(20)),"revision":3,"mode":"quiesce","reason":"manual"});
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert_eq!(
        intent(&w)["revision"],
        3,
        "the fence intent follows the new operation"
    );
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    hibernated(&w);
    let done = sleep_pass(&w).await.expect("hibernated");
    assert_eq!(done["power"]["operation"], format!("op_{}", "m".repeat(20)));
    assert_eq!(done["power"]["revision"], 3);
    assert!(done["power"]["parked"].is_null());
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(progress(&w)["phase"], "hibernated");
}

#[tokio::test]
async fn the_fence_is_removed_when_hibernation_completes_and_on_every_wake() {
    // A wake that finds a demotion complete lifts the fence before releasing hibernation, so
    // CNPG can never create a fenced replacement Pod.
    let mut w = parked().await;
    quick(&mut w);
    expire(&w);
    withdrawn(sleep_pass(&w).await);
    assert_eq!(
        fence_value(&w),
        "[\"*\"]",
        "the demotion leaves the fence while it runs"
    );
    hibernated(&w);
    w.wake(3);
    let inputs = Inputs::of(&w).await;
    assert!(matches!(
        wake_pass(&w, &inputs).await,
        PrepareRunning::Proceed
    ));
    assert!(annotations(&w)[FENCE].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "off");
    assert_eq!(progress(&w)["phase"], "wake");
    assert!(progress(&w)["park"].is_null());
    let lifted = position(&w, &cluster_path(&w), |b| {
        b["metadata"]["annotations"].get(FENCE) == Some(&Value::Null)
            && b["metadata"]["annotations"].get(HIBERNATION).is_none()
    })
    .expect("the demotion's completion removes the fence");
    let released = position(&w, &cluster_path(&w), |b| {
        b["metadata"]["annotations"][HIBERNATION] == "off"
    })
    .expect("hibernation is released");
    assert!(lifted < released);
    // Every wake's patch names the fence for removal, whether or not the Cluster carries one.
    let mut plain = World::awake().await;
    plain
        .server
        .edit("Cluster", Some(&plain.ns), "database", |cluster| {
            cluster["metadata"]["annotations"][HIBERNATION] = "on".into();
        });
    plain.wake(3);
    let inputs = Inputs::of(&plain).await;
    assert!(matches!(
        wake_pass(&plain, &inputs).await,
        PrepareRunning::Proceed
    ));
    assert!(
        patches(&plain, &cluster_path(&plain))
            .iter()
            .any(|b| b["metadata"]["annotations"].get(FENCE) == Some(&Value::Null))
    );
}

#[test]
fn a_parked_pods_identity_gap_names_its_first_cause() {
    // A parked Pod that was demoted for its identity gave no hint which of its facts failed: the
    // Pod, the node's boot, the release, the assignment or the fence.
    let park: Park = serde_json::from_value(json!({"podName":"database-1","podUid":uid(9),"postgresContainerId":"containerd://a","sidecarContainerId":"containerd://b","nodeBootId":"boot","releaseId":"r1","specSha256":"b".repeat(64),"assignmentRevision":3,
        "requestsBefore":{"postgres":{"cpu":"25m","memory":"128Mi"},"sidecar":{"cpu":"100m","memory":"128Mi"}},
        "requestsParked":{"postgres":{"cpu":"10m","memory":"96Mi"},"sidecar":{"cpu":"5m","memory":"64Mi"}},"parkedAt":90_000,"stopped":true})).unwrap();
    let pod = json!({"metadata":{"uid":uid(9),"ownerReferences":[{"uid":"cluster","kind":"Cluster","name":"database","apiVersion":"postgresql.cnpg.io/v1"}]},
        "spec":{"nodeName":"n1"},
        "status":{"phase":"Running","containerStatuses":[{"name":"postgres","containerID":"containerd://a"}],"initContainerStatuses":[{"name":"plugin-barman-cloud","containerID":"containerd://b"}]}});
    let cluster = json!({"apiVersion":"postgresql.cnpg.io/v1","metadata":{"uid":"cluster","annotations":{FENCE:"[\"*\"]"}}});
    let db = json!({"node":"n1"});
    let node = json!({"status":{"nodeInfo":{"bootID":"boot"}}});
    let release = json!({"release":{"id":"r1","spec_sha256":"b".repeat(64)},"nodes":[{"k8s_node_name":"n1","revision":3}]});
    let gap = |pod: Option<&Value>, cluster: &Value, node: &Value, release: &Value| {
        let sleep = Sleep {
            parking: &NOTHING,
            basis: Basis {
                node,
                release,
                manifests: None,
                runtime_class: "",
            },
            slot: None,
        };
        parked::identity_gap(pod, &park, cluster, &db, &sleep)
    };
    assert_eq!(gap(Some(&pod), &cluster, &node, &release), None);
    assert_eq!(gap(None, &cluster, &node, &release), Some("pod_absent"));
    let mut replaced = pod.clone();
    replaced["metadata"]["uid"] = uid(8).into();
    assert_eq!(
        gap(Some(&replaced), &cluster, &node, &release),
        Some("pod_changed")
    );
    let mut rebooted = node.clone();
    rebooted["status"]["nodeInfo"]["bootID"] = "other".into();
    assert_eq!(
        gap(Some(&pod), &cluster, &rebooted, &release),
        Some("boot_id")
    );
    let mut moved = release.clone();
    moved["nodes"][0]["revision"] = 4.into();
    assert_eq!(gap(Some(&pod), &cluster, &node, &moved), Some("assignment"));
    let mut unfenced = cluster.clone();
    unfenced["metadata"]["annotations"] = json!({});
    assert_eq!(
        gap(Some(&pod), &unfenced, &node, &release),
        Some("not_fenced")
    );
}

#[test]
fn parked_progress_roundtrips_and_an_unknown_phase_is_a_recovery_error() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/native/power-vectors.generated.json"
    ))
    .unwrap();
    let mut record = vectors["progress"][4]["progress"].clone();
    assert_eq!(record["phase"], "hibernated");
    record["phase"] = "parked".into();
    record["park"] = json!({"podName":"database-1","podUid":uid(9),"postgresContainerId":"containerd://a","sidecarContainerId":"containerd://b","nodeBootId":"boot","releaseId":"r1","specSha256":"b".repeat(64),"assignmentRevision":3,
        "requestsBefore":{"postgres":{"cpu":"25m","memory":"128Mi"},"sidecar":{"cpu":"100m","memory":"128Mi"}},
        "requestsParked":{"postgres":{"cpu":"10m","memory":"96Mi"},"sidecar":{"cpu":"5m","memory":"64Mi"}},"parkedAt":90_000,"stopped":true});
    let map = json!({"data":{"power.json":record.to_string()}});
    let parsed = progress_from(&map, 100_000).unwrap().unwrap();
    assert_eq!(parsed.phase, Phase::Parked);
    assert_eq!(serde_json::to_value(&parsed).unwrap(), record);
    // A park recorded a moment ahead of this clock is a clock difference, not a forgery; one far
    // ahead is refused.
    let mut ahead = record.clone();
    ahead["park"]["parkedAt"] = 104_000.into();
    assert_eq!(
        progress_from(&json!({"data":{"power.json":ahead.to_string()}}), 100_000)
            .unwrap()
            .unwrap()
            .phase,
        Phase::Parked
    );
    ahead["park"]["parkedAt"] = 106_000.into();
    assert!(matches!(
        progress_from(&json!({"data":{"power.json":ahead.to_string()}}), 100_000),
        Err(Fault::Recovery("power_park_invalid"))
    ));
    // `Parking` is the same record with the stop still unconfirmed.
    record["phase"] = "parking".into();
    let map = json!({"data":{"power.json":record.to_string()}});
    assert_eq!(
        progress_from(&map, 100_000).unwrap().unwrap().phase,
        Phase::Parking
    );
    // A parked phase without its record, and a record in a phase that cannot hold a Pod, are
    // refused rather than guessed.
    let mut missing = record.clone();
    missing.as_object_mut().unwrap().remove("park");
    assert!(matches!(
        progress_from(&json!({"data":{"power.json":missing.to_string()}}), 100_000),
        Err(Fault::Recovery("power_park_missing"))
    ));
    let mut stray = vectors["progress"][4]["progress"].clone();
    stray["phase"] = "awake".into();
    stray["park"] = record["park"].clone();
    assert!(progress_from(&json!({"data":{"power.json":stray.to_string()}}), 100_000).is_err());
    // A phase that is none of ours is unreadable progress, never a guess.
    let mut future = record.clone();
    future["phase"] = "frozen".into();
    assert!(matches!(
        progress_from(&json!({"data":{"power.json":future.to_string()}}), 100_000),
        Err(Fault::Recovery("power_progress_invalid"))
    ));
}

#[test]
fn a_parked_observation_validates_against_the_generated_schema() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../packages/contracts/native/power-vectors.generated.json"
    ))
    .unwrap();
    let db = vectors["progress"][4]["db"].clone();
    let intent = desired_power(&db).unwrap().unwrap();
    let observed = parked_observation(&db, &intent, &uid(9), 100, 256, false);
    assert!(schema_valid("DatabaseObservation", &observed), "{observed}");
    assert_eq!(
        observed["power"]["parked"],
        json!({"pod_uid":uid(9),"cpu_millicores":100,"memory_mib":256})
    );
    // The fast wake claim is the literal `fast`, and only a claim that was made is there.
    let fast = parked_observation(&db, &intent, &uid(9), 100, 256, true);
    assert!(schema_valid("DatabaseObservation", &fast), "{fast}");
    assert_eq!(
        fast["power"]["parked"],
        json!({"pod_uid":uid(9),"cpu_millicores":100,"memory_mib":256,"wake":"fast"})
    );
    assert_eq!(observed["state"], "hibernated");
    assert_eq!(observed["power"]["state"], "hibernated");
    // The envelope Cloudflare receives carries it unchanged.
    let update =
        crate::api::database_update(observed.clone(), "2026-10-15T00:00:00.000Z".into()).unwrap();
    assert_eq!(
        update["databases"][0]["power"]["parked"],
        observed["power"]["parked"]
    );
}

/// The path and query of every GET the controller made since `from`.
fn reads(w: &World, from: usize) -> Vec<(String, String)> {
    w.made(from)
        .into_iter()
        .filter(|(method, ..)| method == "GET")
        .map(|(_, path, query)| (path, query))
        .collect()
}
/// Whether a request asked the API server's watch cache for any version of the object.
fn cached(query: &str) -> bool {
    query.split('&').any(|part| part == "resourceVersion=0")
}
/// How many of the reads of `path` asked for the watch cache, and how many did not.
fn split_of(made: &[(String, String)], path: &str) -> (usize, usize) {
    let all = made.iter().filter(|(at, _)| at == path);
    (
        all.clone().filter(|(_, query)| cached(query)).count(),
        all.filter(|(_, query)| !cached(query)).count(),
    )
}

#[tokio::test]
async fn the_gateway_pods_are_listed_from_the_watch_cache() {
    // Every list that is not served from the cache waits for the API server's etcd to report its
    // progress, up to a tenth of a second each, and the release lists the gateways twice.
    let w = World::awake().await;
    let at = w.mark();
    w.reconciler.power.gateways().await.unwrap();
    let made = reads(&w, at);
    assert_eq!(made.len(), 1, "{made:?}");
    assert_eq!(made[0].0, format!("/api/v1/namespaces/{SYSTEM}/pods"));
    assert!(cached(&made[0].1), "{made:?}");
    assert!(made[0].1.contains("labelSelector="), "{made:?}");
}

#[tokio::test]
async fn the_anchor_compares_the_volume_objects_from_the_watch_cache_and_reads_its_own_fresh() {
    let w = World::awake().await;
    let at = w.mark();
    w.reconciler.power.anchor(&w.db).await.unwrap();
    let made = reads(&w, at);
    // The namespace, the Cluster and the receipt are the objects a pass goes on to patch under
    // their resourceVersion: a version that trails would make that patch conflict.
    for fresh in [
        path("Namespace", None, &w.ns),
        cluster_path(&w),
        path("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id)),
    ] {
        assert_eq!(split_of(&made, &fresh), (0, 1), "{fresh}: {made:?}");
    }
    // The volume, its claim and its LVMVolume are only compared with the identity recorded.
    for compared in [
        path("PersistentVolume", None, HANDLE),
        path("PersistentVolumeClaim", Some(&w.ns), "database-1"),
        path("LVMVolume", Some("openebs"), HANDLE),
    ] {
        assert_eq!(split_of(&made, &compared), (1, 0), "{compared}: {made:?}");
    }
}

#[tokio::test]
async fn a_wake_judges_the_retained_pod_by_reads_from_the_watch_cache() {
    let mut w = parked().await;
    w.wake(3);
    w.start_postgres().await;
    let inputs = Inputs::of(&w).await;
    let at = w.mark();
    let PrepareRunning::Parked(_) = wake_pass(&w, &inputs).await else {
        panic!("a parked database with unchanged desired state wakes fast");
    };
    let made = reads(&w, at);
    // Nothing the inspection reads is patched by it: the Pod and the thirteen manifests.
    for manifest in &inputs.manifests {
        if text(manifest, "kind") == "Namespace" {
            continue;
        }
        let at = path(
            text(manifest, "kind"),
            manifest["metadata"]["namespace"].as_str(),
            text(&manifest["metadata"], "name"),
        );
        // The Cluster is also what the anchor reads, and the unfence patches it.
        let anchored = usize::from(text(manifest, "kind") == "Cluster");
        assert_eq!(split_of(&made, &at), (1, anchored), "{at}");
    }
    // The fence is the object the wake writes next, under its resourceVersion.
    assert_eq!(split_of(&made, &fence_path(&w)).0, 0, "{made:?}");
}

#[tokio::test]
async fn the_data_directory_the_sleep_proved_is_recorded_with_the_parked_pod() {
    // The sleep's own maintenance session asks which data directory the postmaster runs on, while
    // the postmaster still runs: `system_identifier` and the timeline of `pg_control`. The wake
    // compares them with what the postmaster that starts answers.
    let w = parked().await;
    let park = progress(&w)["park"].clone();
    assert_eq!(park["systemIdentifier"], "7430000000000000001", "{park}");
    assert_eq!(park["timeline"], 1);
}

#[tokio::test]
async fn a_pod_parked_without_the_identity_of_its_data_directory_is_demoted_not_claimed() {
    // A record of a controller that did not take the identity cannot be compared with anything
    // a wake finds: the fast wake is not claimed, and the Pod is demoted while it sleeps.
    let mut w = parked().await;
    quick(&mut w);
    w.server.edit(
        "ConfigMap",
        Some(SYSTEM),
        &format!("gateway-fence-{}", w.id),
        |map| {
            let mut record: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
            record["park"]
                .as_object_mut()
                .unwrap()
                .remove("systemIdentifier");
            record["park"].as_object_mut().unwrap().remove("timeline");
            map["data"]["power.json"] = record.to_string().into();
        },
    );
    let observed = sleep_pass(&w).await;
    assert!(
        observed.is_none_or(|value| value["power"]["parked"]["wake"].is_null()),
        "the fast wake is not claimed"
    );
    assert_eq!(annotations(&w)[HIBERNATION], "on", "the Pod is demoted");
}

#[tokio::test]
async fn a_sleep_that_cannot_read_the_data_directory_hibernates_instead_of_parking() {
    // A Pod nothing could be compared against at its wake is not worth keeping.
    let mut w = World::awake().await;
    quick(&mut w);
    w.sql.lock().unwrap().system_identifier = String::new();
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "hibernating");
    assert!(progress(&w)["park"].is_null());
    assert_eq!(annotations(&w)[HIBERNATION], "on");
    assert!(annotations(&w)[FENCE].is_null());
}

#[tokio::test]
async fn a_sleep_whose_second_proof_finds_another_data_directory_is_refused() {
    // The identity is recorded with the closed segment. A proof that resumes after it must find
    // the same data directory under the same postmaster, or the sleep is not proved.
    let mut w = World::awake().await;
    quick(&mut w);
    w.sql.lock().unwrap().archived = false;
    assert!(sleep_pass(&w).await.is_none());
    assert_eq!(progress(&w)["phase"], "archive");
    assert_eq!(progress(&w)["system"]["identifier"], "7430000000000000001");
    {
        let mut sql = w.sql.lock().unwrap();
        sql.archived = true;
        sql.system_identifier = "7999999999999999999".into();
    }
    let refused = sleep_pass(&w).await.expect("a refusal");
    assert_eq!(refused["state"], "error");
    assert_eq!(progress(&w)["phase"], "refused");
    assert!(annotations(&w)[FENCE].is_null());
    assert!(annotations(&w)[HIBERNATION].is_null());
}
