// SPDX-License-Identifier: Apache-2.0
use pgcf_native_gateway::kubernetes::{FenceState, parse_snapshot};
use serde_json::{Value, json};
fn snapshot() -> Value {
    let database = "a".repeat(20);
    json!({"apiVersion":"v1","kind":"ConfigMapList","metadata":{"resourceVersion":"7"},"items":[{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{database}"),"namespace":"pgcf-system","uid":"01234567-89ab-4def-8123-0123456789ab","resourceVersion":"5","labels":{"pgcf.io/gateway-fence":"true","pgcf.io/database-id":database}},"data":{"intent.json":json!({"database":database,"operation":format!("op_{}","b".repeat(20)),"revision":1,"mode":"running"}).to_string()}}]})
}
#[test]
fn persisted_fence_identity_and_history_fail_closed() {
    let mut state = FenceState::default();
    assert!(!state.admits(&"a".repeat(20)));
    let records = parse_snapshot(&snapshot()).unwrap();
    state.replace(records.clone()).unwrap();
    assert!(state.admits(&"a".repeat(20)));
    let mut replaced = records.clone();
    replaced.values_mut().next().unwrap().uid = "01234567-89ab-4def-8123-0123456789ac".into();
    assert!(state.replace(replaced).is_err());
    assert!(!state.admits(&"a".repeat(20)));
    state.replace(records.clone()).unwrap();
    assert!(state.replace(Default::default()).is_err());
    assert!(!state.admits(&"a".repeat(20)));
    let mut quiesce = records;
    let intent = &mut quiesce.values_mut().next().unwrap().intent;
    intent.mode = "quiesce".into();
    intent.revision = 2;
    state.replace(quiesce.clone()).unwrap();
    assert!(!state.admits(&"a".repeat(20)));
    quiesce.values_mut().next().unwrap().intent.revision = 1;
    assert!(state.replace(quiesce).is_err());
}
#[test]
fn foreign_namespace_labels_deletion_or_duplicate_map_are_rejected() {
    for field in ["namespace", "uid", "name", "resourceVersion"] {
        let mut value = snapshot();
        value["items"][0]["metadata"][field] = json!("");
        assert!(parse_snapshot(&value).is_err(), "{field}");
    }
    let mut value = snapshot();
    value["items"][0]["metadata"]["deletionTimestamp"] = json!("2026-10-09T00:00:00Z");
    assert!(parse_snapshot(&value).is_err());
    let mut value = snapshot();
    let duplicate = value["items"][0].clone();
    value["items"].as_array_mut().unwrap().push(duplicate);
    assert!(parse_snapshot(&value).is_err());
    let mut value = snapshot();
    value["items"][0]["metadata"]["labels"]["pgcf.io/database-id"] = json!("b".repeat(20));
    assert!(parse_snapshot(&value).is_err());
}
#[test]
fn an_admitted_target_is_bound_to_the_fence_that_carries_it() {
    let database = "a".repeat(20);
    let pod = "01234567-89ab-4def-8123-0123456789ab";
    let target = json!({"v":1,"generation":1,"route_revision":2,"admission_epoch":3,"pod_uid":pod,"container_id":"a".repeat(64),"ca_secret_uid":pod,"ca_secret_resource_version":"4","ca_sha256":"b".repeat(64),"tls_server_name":format!("database-rw.pgcf-db-{database}.svc")});
    let with = |target: &Value| {
        let mut value = snapshot();
        value["items"][0]["data"]["admission_target"] = target.to_string().into();
        value
    };
    let records = parse_snapshot(&with(&target)).unwrap();
    assert_eq!(
        records[&database]
            .admission_target
            .as_ref()
            .unwrap()
            .pod_uid,
        pod
    );
    // Ahead of the revision of its own fence, or naming another database's TLS authority.
    let mut ahead = target.clone();
    ahead["generation"] = json!(2);
    assert!(parse_snapshot(&with(&ahead)).is_err());
    let mut foreign = target.clone();
    foreign["tls_server_name"] = json!(format!("database-rw.pgcf-db-{}.svc", "b".repeat(20)));
    assert!(parse_snapshot(&with(&foreign)).is_err());
}
#[tokio::test]
async fn every_applied_fence_change_wakes_the_connections_waiting_on_it() {
    // A held wake connection is released by the fence the controller writes; it waits on this
    // signal instead of polling the fence.
    let mut state = FenceState::default();
    let changed = state.changed.clone();
    let notified = changed.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    state.replace(parse_snapshot(&snapshot()).unwrap()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(1), notified)
        .await
        .unwrap();
}
