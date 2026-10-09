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
