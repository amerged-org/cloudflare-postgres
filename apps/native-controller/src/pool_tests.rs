// SPDX-License-Identifier: Apache-2.0
//! The pool's decisions as pure functions, and the pool against the in-process doubles.
use super::*;
use crate::attach_protocol;
use pgcf_native_protocol::wake::{WakeRequest, role_revision_hash};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

const IMAGE: &str = "registry.test/postgres@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const LV: &str = "iLeDnR-3bK4-F2Sh-j05A-x0NW-MCcd-TfCn8O";
const VG: &str = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
const HANDLE: &str = "pvc-01234567-89ab-4def-8123-000000000006";

fn thin_database() -> Value {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/native/power-vectors.generated.json"
    ))
    .unwrap();
    let mut db = vectors["intents"][0]["db"].clone();
    db["storage"] = json!({"backend":"lvm-thin-v1","storage_class":"pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa","volume_attributes_class":"pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa","profile_revision":1,"profile_sha256":"a".repeat(64),"node_uid":"01234567-89ab-4def-8123-000000000005","volume_group_uuid":VG,"pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","startup_reserve_bytes":1048576,"write_bytes_per_second":1048576,"write_iops_per_second":10,"guard_seconds":10,"drain_seconds":1});
    db["admission"] = json!({"v":1,"admission_epoch":1,"route_revision":3});
    db["generation"] = 4.into();
    db["desired_state"] = "suspended".into();
    db["power"] = json!({"operation":format!("op_{}","s".repeat(20)),"revision":4,"mode":"quiesce","reason":"idle"});
    db["size"]
        .as_object_mut()
        .unwrap()
        .remove("memory_request_mib");
    db
}
fn request(db: &Value) -> WakeRequest {
    WakeRequest {
        database: db["id"].as_str().unwrap().into(),
        operation: format!("op_{}", "w".repeat(20)),
        generation: db["generation"].as_u64().unwrap() + 1,
        route_revision: 3,
        role_revision_hash: role_revision_hash(
            crate::contracts::present_roles(db)
                .map(|r| (r["name"].as_str().unwrap(), r["revision"].as_u64().unwrap())),
        ),
        queued_at_ms: 1,
    }
}
fn record(db: &Value) -> SleepRecord {
    SleepRecord {
        v: 1,
        system_identifier: "7430000000000000001".into(),
        timeline: 1,
        configuration_sha256: sleep_fingerprint(db, IMAGE).unwrap(),
        image: IMAGE.into(),
        written_at_ms: 1,
        via: Via::Cnpg,
    }
}
fn free_slot(hex: &str, cpu: u64, memory: u64, image: &str) -> Slot {
    Slot {
        hex: hex.into(),
        node: "native-test-node".into(),
        state: SlotState::Free,
        image: image.into(),
        cpu_millicores: cpu,
        memory_mib: memory,
        pod: None,
        created: Instant::now(),
    }
}

#[test]
fn each_decision_row_returns_its_reason_in_table_order() {
    let db = thin_database();
    let wake = request(&db);
    let identity = json!({"claimUid":"c","volumeUid":"v","handle":HANDLE,"lvUuid":LV});
    let sleep = record(&db);
    let fingerprint = sleep_fingerprint(&db, IMAGE).unwrap();
    let small = free_slot("0000000a", 100, 256, IMAGE);
    let fits = free_slot("0000000b", 500, 512, IMAGE);
    let base = || Facts {
        trigger: Trigger::Gateway(&wake),
        cell: Some(&db),
        protection: None,
        asleep: true,
        busy: false,
        identity: Some(&identity),
        power_record: true,
        record: Some(&sleep),
        image: IMAGE,
        fingerprint: &fingerprint,
        authority: true,
        gateways_ready: true,
        slots: vec![&small, &fits],
        headroom: true,
    };
    // Every row passes: a hit on the smallest free slot that fits the class.
    let choice = decide(&base()).unwrap();
    assert_eq!(choice.slot, "0000000b");
    assert_eq!(
        choice.volume,
        Volume {
            lv_name: HANDLE.into(),
            lv_uuid: LV.into(),
            vg_uuid: VG.into()
        }
    );
    let deleted = {
        let mut v = db.clone();
        v["desired_state"] = "deleted".into();
        v
    };
    let manual = {
        let mut v = db.clone();
        v["power"]["reason"] = "manual".into();
        v
    };
    let stale = WakeRequest {
        route_revision: 2,
        ..wake.clone()
    };
    let thick = {
        let mut v = db.clone();
        v["storage"] = Value::Null;
        v
    };
    let no_lv = json!({"claimUid":"c","volumeUid":"v","handle":HANDLE});
    let other_image = SleepRecord {
        image: "registry.test/postgres@sha256:".to_string() + &"f".repeat(64),
        ..sleep.clone()
    };
    let other = free_slot("0000000c", 500, 512, "registry.test/other@sha256:00");
    let stale_trigger = Trigger::Gateway(&stale);
    // One case per row, in the table's order: each breaks its own row and every row after it,
    // so the reason is the first failing row's. The later rows are broken first, so that a field
    // two rows break holds the earlier row's break.
    type Breaks<'a> = Box<dyn Fn(&mut Facts<'a>) + 'a>;
    let rows: Vec<(&str, Outcome, Breaks)> = vec![
        ("no_desired_row", Outcome::Miss, Box::new(|f| f.cell = None)),
        (
            "deleted",
            Outcome::Refused,
            Box::new(|f| f.cell = Some(&deleted)),
        ),
        (
            "protected",
            Outcome::Refused,
            Box::new(|f| f.protection = Some(4)),
        ),
        (
            "not_sleeping",
            Outcome::Miss,
            Box::new(|f| f.cell = Some(&manual)),
        ),
        (
            "wake_in_progress",
            Outcome::Miss,
            Box::new(|f| f.busy = true),
        ),
        (
            "desired_stale",
            Outcome::Miss,
            Box::new(|f| f.trigger = stale_trigger),
        ),
        (
            "thick_storage",
            Outcome::Miss,
            Box::new(|f| f.cell = Some(&thick)),
        ),
        (
            "volume_identity_missing",
            Outcome::Miss,
            Box::new(|f| f.identity = Some(&no_lv)),
        ),
        (
            "no_power_record",
            Outcome::Miss,
            Box::new(|f| f.power_record = false),
        ),
        (
            "no_sleep_record",
            Outcome::Miss,
            Box::new(|f| f.record = None),
        ),
        (
            "image_changed",
            Outcome::Miss,
            Box::new(|f| f.record = Some(&other_image)),
        ),
        (
            "configuration_changed",
            Outcome::Miss,
            Box::new(|f| f.fingerprint = "0"),
        ),
        (
            "write_authority",
            Outcome::Miss,
            Box::new(|f| f.authority = false),
        ),
        (
            "gateways_not_ready",
            Outcome::Miss,
            Box::new(|f| f.gateways_ready = false),
        ),
        (
            "no_free_slot",
            Outcome::Miss,
            Box::new(|f| f.slots = vec![&small, &other]),
        ),
        (
            "no_headroom",
            Outcome::Miss,
            Box::new(|f| f.headroom = false),
        ),
    ];
    for (index, (reason, outcome, _)) in rows.iter().enumerate() {
        let mut facts = base();
        for (_, _, breaks) in rows[index..].iter().rev() {
            breaks(&mut facts);
        }
        let decided = decide(&facts)
            .err()
            .unwrap_or_else(|| panic!("{reason} is a hit"));
        assert_eq!(decided, (*outcome, *reason), "row {}", index + 1);
        // Broken alone, the row is the reason as well.
        let mut alone = base();
        rows[index].2(&mut alone);
        assert_eq!(decide(&alone).err(), Some((*outcome, *reason)));
    }
    // An older protection marker is the CNPG path's to clear: a miss, not a refusal.
    let mut older = base();
    older.protection = Some(3);
    assert_eq!(decide(&older).err(), Some((Outcome::Miss, "protected")));
    // A ticket of another generation than the sleeping row's next is stale.
    let ahead = WakeRequest {
        generation: 7,
        ..wake.clone()
    };
    let mut facts = base();
    facts.trigger = Trigger::Gateway(&ahead);
    assert_eq!(decide(&facts).err(), Some((Outcome::Miss, "desired_stale")));
    // The D1 claim that landed first: the row runs at the ticket's generation and operation.
    let mut claimed = db.clone();
    claimed["generation"] = wake.generation.into();
    claimed["desired_state"] = "running".into();
    claimed["power"] = json!({"operation":wake.operation,"revision":wake.generation,"mode":"running","reason":null});
    claimed["size"]["memory_request_mib"] = 128.into();
    let mut facts = base();
    facts.cell = Some(&claimed);
    assert!(decide(&facts).is_ok());
    // The desired trigger: a running wake row of a database that sleeps.
    let mut facts = base();
    facts.trigger = Trigger::Desired;
    facts.cell = Some(&claimed);
    assert!(decide(&facts).is_ok());
    facts.asleep = false;
    assert_eq!(decide(&facts).err(), Some((Outcome::Miss, "not_sleeping")));
}

#[test]
fn a_ticket_is_confirmed_by_its_generation_and_operation_refuted_by_another_and_expires_after_10_s()
{
    let now = Instant::now();
    let ticket = Ticket::new(
        "dbbbbbbbbbbbbbbbbbbb",
        &format!("op_{}", "w".repeat(20)),
        5,
        now,
    );
    let row = |generation: u64, state: &str, operation: &str| json!({"id":"dbbbbbbbbbbbbbbbbbbb","generation":generation,"desired_state":state,"power":{"operation":operation,"revision":generation,"mode":if state=="running"{"running"}else{"quiesce"},"reason":null}});
    let op = format!("op_{}", "w".repeat(20));
    let other = format!("op_{}", "x".repeat(20));
    // Not yet: the row still sleeps at the generation before.
    assert_eq!(
        ticket.outcome(Some(&row(4, "suspended", &other)), now),
        None
    );
    assert_eq!(ticket.outcome(None, now), None);
    assert_eq!(
        ticket.outcome(Some(&row(5, "running", &op)), now),
        Some(TicketOutcome::Confirmed)
    );
    // Another operation at the generation, or a later generation, refutes it.
    assert_eq!(
        ticket.outcome(Some(&row(5, "running", &other)), now),
        Some(TicketOutcome::Refuted)
    );
    assert_eq!(
        ticket.outcome(Some(&row(6, "suspended", &op)), now),
        Some(TicketOutcome::Refuted)
    );
    // Ten seconds without a confirmation.
    let lease = Duration::from_millis(pgcf_native_protocol::wake::TICKET_LEASE_MS);
    assert_eq!(
        ticket.outcome(Some(&row(4, "suspended", &other)), now + lease),
        None
    );
    assert_eq!(
        ticket.outcome(
            Some(&row(4, "suspended", &other)),
            now + lease + Duration::from_millis(1)
        ),
        Some(TicketOutcome::Expired)
    );
    // A confirmation is a confirmation even when it is read late.
    assert_eq!(
        ticket.outcome(Some(&row(5, "running", &op)), now + lease * 2),
        Some(TicketOutcome::Confirmed)
    );
}

#[test]
fn slot_shape_is_the_largest_thin_class_on_the_node_and_none_without_thin_databases() {
    let mut small = thin_database();
    small["node"] = "a".into();
    let mut large = thin_database();
    large["node"] = "a".into();
    large["size"]["cpu_millicores"] = 1000.into();
    large["size"]["max_connections"] = 50.into();
    let mut wide = thin_database();
    wide["node"] = "a".into();
    wide["size"]["memory_mib"] = 1024.into();
    wide["size"]["archive_timeout_seconds"] = 90.into();
    let mut thick = thin_database();
    thick["node"] = "a".into();
    thick["storage"] = Value::Null;
    thick["size"]["memory_mib"] = 4096.into();
    let mut elsewhere = thin_database();
    elsewhere["node"] = "b".into();
    elsewhere["size"]["memory_mib"] = 8192.into();
    let all = [small, large, wide, thick, elsewhere];
    assert_eq!(
        slot_shape("a", &all),
        Some(Shape {
            cpu_millicores: 1000,
            memory_mib: 1024,
            max_connections: 50,
            archive_timeout_seconds: 90
        })
    );
    assert_eq!(slot_shape("b", &all).unwrap().memory_mib, 8192);
    assert_eq!(slot_shape("c", &all), None);
    assert_eq!(slot_shape("a", &all[3..4]), None);
}

#[test]
fn memory_headroom_counts_requests_of_non_terminal_pods_and_sidecars_on_the_node_only() {
    let node = json!({"metadata":{"name":"a"},"status":{"allocatable":{"memory":"2Gi"}}});
    let pod = |node: &str, phase: &str, memory: &str, sidecar: Option<&str>| {
        let mut pod = json!({"spec":{"nodeName":node,"containers":[{"name":"main","resources":{"requests":{"memory":memory}}}],"initContainers":[{"name":"once","resources":{"requests":{"memory":"1Gi"}}}]},"status":{"phase":phase}});
        if let Some(sidecar) = sidecar {
            pod["spec"]["initContainers"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":"side","restartPolicy":"Always","resources":{"requests":{"memory":sidecar}}}));
        }
        pod
    };
    // 2 GiB allocatable: 512 Mi of a running Pod and 256 Mi of its sidecar are taken; a run-once
    // init container, a finished Pod and a Pod of another node take nothing.
    let pods = vec![
        pod("a", "Running", "512Mi", Some("256Mi")),
        pod("a", "Succeeded", "1Gi", None),
        pod("b", "Running", "1Gi", None),
    ];
    assert!(memory_headroom(&node, &pods, 1280));
    assert!(!memory_headroom(&node, &pods, 1281));
    // The need is the class request above what the slot already requests.
    let mut db = thin_database();
    db["size"]["memory_request_mib"] = 384.into();
    assert_eq!(headroom_need(&db), 256);
    db["size"]
        .as_object_mut()
        .unwrap()
        .remove("memory_request_mib");
    assert_eq!(headroom_need(&db), 256 - 128);
    // A node without an allocatable memory has no headroom.
    assert!(!memory_headroom(&json!({"status":{}}), &[], 0));
}

#[test]
fn sleep_fingerprint_ignores_request_fields_that_depend_on_the_desired_state() {
    let db = thin_database();
    let sleeping = sleep_fingerprint(&db, IMAGE).unwrap();
    let mut awake = db.clone();
    awake["desired_state"] = "running".into();
    awake["generation"] = 5.into();
    awake["size"]["memory_request_mib"] = 128.into();
    awake["size"]["cpu_request_millicores"] = 25.into();
    assert_eq!(sleep_fingerprint(&awake, IMAGE).unwrap(), sleeping);
    // A role, the class, the image and the storage do count.
    let mut role = db.clone();
    role["roles"][1]["revision"] = 3.into();
    assert_ne!(sleep_fingerprint(&role, IMAGE).unwrap(), sleeping);
    let mut class = db.clone();
    class["size"]["memory_mib"] = 512.into();
    assert_ne!(sleep_fingerprint(&class, IMAGE).unwrap(), sleeping);
    assert_ne!(
        sleep_fingerprint(&db, &format!("registry.test/x@sha256:{}", "1".repeat(64))).unwrap(),
        sleeping
    );
    let mut storage = db.clone();
    storage["storage"]["guard_seconds"] = 20.into();
    assert_ne!(sleep_fingerprint(&storage, IMAGE).unwrap(), sleeping);
    // The role-only fingerprint of the slot's serve pass sets the roles apart.
    assert_eq!(
        structure_fingerprint(&role, IMAGE).unwrap(),
        structure_fingerprint(&db, IMAGE).unwrap()
    );
    assert_ne!(
        structure_fingerprint(&class, IMAGE).unwrap(),
        structure_fingerprint(&db, IMAGE).unwrap()
    );
}

#[test]
fn the_sleep_record_roundtrips_and_refuses_unknown_fields() {
    let record = record(&thin_database());
    let text = record.encode();
    assert_eq!(SleepRecord::parse(&text), Some(record.clone()));
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["via"], "cnpg");
    assert_eq!(value["timeline"], 1);
    let mut extra = value.clone();
    extra["slot"] = "x".into();
    assert_eq!(SleepRecord::parse(&extra.to_string()), None);
    for (key, bad) in [
        ("v", json!(2)),
        ("system_identifier", json!("12a")),
        ("timeline", json!(0)),
        ("configuration_sha256", json!("A".repeat(64))),
        ("image", json!("registry.test/postgres:18")),
        ("via", json!("parked")),
    ] {
        let mut wrong = value.clone();
        wrong[key] = bad;
        assert_eq!(SleepRecord::parse(&wrong.to_string()), None, "{key}");
    }
    assert_eq!(SleepRecord::parse("{"), None);
    // The record says whether a pg_control is the one it was written from.
    let control = attach_protocol::Control {
        state: 1,
        system_identifier: "7430000000000000001".into(),
        timeline: 1,
    };
    assert!(record.matches(&control));
    assert!(!record.matches(&attach_protocol::Control {
        timeline: 2,
        ..control.clone()
    }));
    assert!(!record.matches(&attach_protocol::Control {
        system_identifier: "7430000000000000002".into(),
        ..control
    }));
}

#[test]
fn the_claim_patch_lifts_the_fence_labels_the_database_and_sets_its_parameters_only() {
    let mut db = thin_database();
    db["desired_state"] = "running".into();
    db["size"]["memory_request_mib"] = 128.into();
    let claim = Claim {
        v: 1,
        database: "dbbbbbbbbbbbbbbbbbbb".into(),
        operation: format!("op_{}", "w".repeat(20)),
        generation: 5,
        claimed_at_ms: 1_700_000_000_000,
    };
    let patch = claim_patch(&db, &claim);
    assert_eq!(
        patch,
        json!({"metadata":{"labels":{"pgcf.io/database-id":"dbbbbbbbbbbbbbbbbbbb"},"annotations":{"pgcf.io/claim":serde_json::to_string(&claim).unwrap(),"cnpg.io/fencedInstances":null}},"spec":{"postgresql":{"parameters":crate::manifests::parameters(&db)}}})
    );
    // Never the resources: a patch of them would roll the slot's Pod.
    assert!(patch["spec"].get("resources").is_none());
    assert_eq!(
        serde_json::from_str::<Value>(patch["metadata"]["annotations"][CLAIM].as_str().unwrap())
            .unwrap(),
        json!({"v":1,"database":"dbbbbbbbbbbbbbbbbbbb","operation":claim.operation,"generation":5,"claimed_at_ms":1_700_000_000_000_u64})
    );
}

#[test]
fn refill_creates_one_slot_per_node_at_a_time_up_to_four_and_only_after_every_gateway_polled() {
    let now = Instant::now();
    let shape = Shape {
        cpu_millicores: 500,
        memory_mib: 512,
        max_connections: 20,
        archive_timeout_seconds: 60,
    };
    let shapes = BTreeMap::from([("a".to_string(), shape.clone()), ("b".to_string(), shape)]);
    let none: HashMap<String, Instant> = HashMap::new();
    let on = |node: &str, hex: &str, state: SlotState| Slot {
        node: node.into(),
        state,
        ..free_slot(hex, 500, 512, IMAGE)
    };
    // No gateway has answered a wake poll yet: an old gateway breaks on slot Pods.
    assert_eq!(refill(&[], &shapes, IMAGE, false, &none, now), vec![]);
    // One creation per node.
    assert_eq!(
        refill(&[], &shapes, IMAGE, true, &none, now),
        vec![Refill::Create("a".into()), Refill::Create("b".into())]
    );
    // One at a time: a node with a slot being created waits for it.
    let creating = on("a", "00000001", SlotState::Creating { since: now });
    assert_eq!(
        refill(&[&creating], &shapes, IMAGE, true, &none, now),
        vec![Refill::Create("b".into())]
    );
    // Up to four free (or being created); claimed slots are no longer the pool's.
    let free: Vec<Slot> = (0..3)
        .map(|n| on("a", &format!("0000001{n}"), SlotState::Free))
        .collect();
    let claimed = on("a", "00000020", SlotState::Claimed("db".into()));
    let mut held: Vec<&Slot> = free.iter().collect();
    held.push(&claimed);
    assert_eq!(
        refill(&held, &shapes, IMAGE, true, &none, now),
        vec![Refill::Create("a".into()), Refill::Create("b".into())]
    );
    let fourth = on("a", "00000013", SlotState::Free);
    held.push(&fourth);
    assert_eq!(
        refill(&held, &shapes, IMAGE, true, &none, now),
        vec![Refill::Create("b".into())]
    );
    // A slot not free within 120 s is deleted, and its node waits 30 s before the next.
    let late = now + SLOT_READY_BOUND + Duration::from_millis(1);
    assert_eq!(
        refill(&[&creating], &shapes, IMAGE, true, &none, late),
        vec![
            Refill::Discard("00000001".into(), "not_free_in_time"),
            Refill::Create("b".into())
        ]
    );
    let waiting = HashMap::from([("a".to_string(), late + SLOT_RETRY_AFTER)]);
    assert_eq!(
        refill(&[], &shapes, IMAGE, true, &waiting, late),
        vec![Refill::Create("b".into())]
    );
    assert_eq!(
        refill(&[], &shapes, IMAGE, true, &waiting, late + SLOT_RETRY_AFTER),
        vec![Refill::Create("a".into()), Refill::Create("b".into())]
    );
    // A node without a thin database gets no slot.
    assert_eq!(
        refill(&[], &BTreeMap::new(), IMAGE, true, &none, now),
        vec![]
    );
}

#[test]
fn free_slots_of_another_image_or_smaller_shape_are_replaced() {
    let now = Instant::now();
    let shapes = BTreeMap::from([(
        "native-test-node".to_string(),
        Shape {
            cpu_millicores: 500,
            memory_mib: 512,
            max_connections: 20,
            archive_timeout_seconds: 60,
        },
    )]);
    let current = free_slot("00000001", 500, 512, IMAGE);
    let old_image = free_slot("00000002", 500, 512, "registry.test/old@sha256:00");
    let narrow = free_slot("00000003", 250, 512, IMAGE);
    let short = free_slot("00000004", 500, 256, IMAGE);
    let wide = free_slot("00000005", 1000, 1024, IMAGE);
    let mut claimed_old = free_slot("00000006", 100, 256, "registry.test/old@sha256:00");
    claimed_old.state = SlotState::Claimed("db".into());
    let none = HashMap::new();
    assert_eq!(
        refill(
            &[&current, &old_image, &narrow, &short, &wide, &claimed_old],
            &shapes,
            IMAGE,
            true,
            &none,
            now
        ),
        vec![
            Refill::Discard("00000002".into(), "replaced"),
            Refill::Discard("00000003".into(), "replaced"),
            Refill::Discard("00000004".into(), "replaced"),
            Refill::Create("native-test-node".into()),
        ]
    );
}

#[test]
fn a_free_slot_runs_its_fenced_pod_with_both_containers_unrestarted_and_its_ca() {
    let ns = json!({"metadata":{"name":"pgcf-slot-0a1b2c3d","uid":"n","labels":{"pgcf.io/slot":"0a1b2c3d"}}});
    let cluster = json!({"metadata":{"name":"database","uid":"c","annotations":{"cnpg.io/fencedInstances":"[\"*\"]"}},"spec":{"imageName":IMAGE}});
    let pod = json!({"metadata":{"name":"database-1","uid":"p"},"spec":{"containers":[{"name":"postgres","image":IMAGE}]},"status":{"phase":"Running","podIP":"10.0.0.9",
        "containerStatuses":[{"name":"postgres","restartCount":0,"state":{"running":{}},"containerID":format!("containerd://{}","1".repeat(64))}],
        "initContainerStatuses":[{"name":"plugin-barman-cloud","restartCount":0,"state":{"running":{}},"containerID":format!("containerd://{}","2".repeat(64))}]}});
    let ca = json!({"metadata":{"name":"database-ca","uid":"s","resourceVersion":"1"},"data":{"ca.crt":"x"}});
    assert!(slot_free(&ns, &cluster, &pod, Some(&ca), IMAGE));
    assert!(!slot_free(&ns, &cluster, &pod, None, IMAGE));
    assert!(!slot_free(
        &ns,
        &cluster,
        &pod,
        Some(&ca),
        "registry.test/x@sha256:00"
    ));
    let mut unfenced = cluster.clone();
    unfenced["metadata"]["annotations"] = json!({});
    assert!(!slot_free(&ns, &unfenced, &pod, Some(&ca), IMAGE));
    for change in [
        json!({"status":{"phase":"Pending"}}),
        json!({"metadata":{"deletionTimestamp":"2026-10-16T00:00:00Z"}}),
        json!({"status":{"podIP":"203.0.113.9"}}),
        json!({"status":{"containerStatuses":[{"name":"postgres","restartCount":1,"state":{"running":{}},"containerID":format!("containerd://{}","1".repeat(64))}]}}),
        json!({"status":{"initContainerStatuses":[{"name":"plugin-barman-cloud","restartCount":0,"state":{"waiting":{}},"containerID":format!("containerd://{}","2".repeat(64))}]}}),
    ] {
        let mut changed = pod.clone();
        merge(&mut changed, &change);
        assert!(
            !slot_free(&ns, &cluster, &changed, Some(&ca), IMAGE),
            "{change}"
        );
    }
    let pod_of = slot_pod(&pod).unwrap();
    assert_eq!(pod_of.postgres, "1".repeat(64));
    assert_eq!(pod_of.sidecar, "2".repeat(64));
    assert_eq!(pod_of.ip, "10.0.0.9");
}
fn merge(value: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (value.as_object_mut(), patch.as_object()) {
        for (key, new) in patch {
            match target.get_mut(key) {
                Some(old) if old.is_object() && new.is_object() => merge(old, new),
                _ => {
                    target.insert(key.clone(), new.clone());
                }
            }
        }
    }
}

/// The pool against the in-process doubles: the Kubernetes API, the gateway, the node agent and
/// the PostgreSQL of the database and of the slot.
mod world {
    use super::*;
    use crate::test_server::uid;
    use crate::test_world::*;
    use crate::test_world::{IMAGE, SYSTEM};

    fn at(lines: &[String], needle: &str) -> usize {
        lines
            .iter()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("no line with {needle:?} in {lines:#?}"))
    }
    fn has(lines: &[String], needle: &str) -> bool {
        lines.iter().any(|line| line.contains(needle))
    }
    fn fence(w: &World) -> Value {
        w.server
            .get(
                "ConfigMap",
                Some(SYSTEM),
                &format!("gateway-fence-{}", w.id),
            )
            .unwrap()
    }
    fn record(w: &World) -> Option<SleepRecord> {
        w.server
            .get("ConfigMap", Some(SYSTEM), &format!("storage-{}", w.id))
            .unwrap()["metadata"]["annotations"][SLEEP_RECORD]
            .as_str()
            .and_then(SleepRecord::parse)
    }
    fn holder(w: &World) -> Option<String> {
        w.gateway
            .agent
            .lock()
            .unwrap()
            .holders
            .get(LV_UUID)
            .cloned()
    }
    async fn eventually(what: &str, check: impl Fn() -> bool) {
        for _ in 0..200 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("never: {what}");
    }
    /// The gateway delivers the wake of the Edge's ticket and the pool decides it.
    async fn delivered_wake(w: &mut World) -> WakeRequest {
        w.fresh_authority();
        let wake = w.wake_request();
        w.reconciler.pool.delivered(&w.gateway_pod(), &wake);
        w.reconciler
            .pool
            .wake(&w.reconciler, Some((&w.db, &w.snapshot)), &wake, false)
            .await
            .unwrap();
        wake
    }

    #[tokio::test]
    async fn a_pool_hit_releases_the_gateway_with_the_slot_target_before_any_api_write() {
        let mut w = World::pooled().await;
        let record = record(&w).expect("the sleep of the database's own Cluster is recorded");
        assert_eq!(record.via, Via::Cnpg);
        assert_eq!(holder(&w), None, "the sleep released the volume");
        let from = w.log_len();
        let wake = delivered_wake(&mut w).await;
        let lines = w.since(from);
        // The volume is attached, the slot bound and started, its identity checked, and only
        // then the gateway released.
        let attach = at(&lines, "AGENT attach ok");
        let lift = at(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                slot_ns()
            ),
        );
        let accepting = at(&lines, "SLOT SQL pgcf_maintenance accepting");
        let identity = at(&lines, "SLOT SQL pgcf_maintenance server identity");
        let released = at(&lines, "GATEWAY release");
        assert!(attach < lift && lift < accepting && accepting < identity && identity < released);
        // The release is the fence: running at the ticket's generation and operation, with the
        // slot's attested target; the power record is still the sleep's.
        let map = fence(&w);
        let intent: Value =
            serde_json::from_str(map["data"]["intent.json"].as_str().unwrap()).unwrap();
        assert_eq!(
            intent,
            json!({"database":w.id,"operation":wake.operation,"revision":wake.generation,"mode":"running"})
        );
        let target: Value =
            serde_json::from_str(map["data"]["admission_target"].as_str().unwrap()).unwrap();
        assert_eq!(target["pod_uid"], slot_pod_uid());
        assert_eq!(target["container_id"], SLOT_POSTGRES);
        assert_eq!(
            target["tls_server_name"],
            format!("database-rw.{}.svc", slot_ns())
        );
        assert_eq!(target["generation"], wake.generation);
        assert_eq!(target["route_revision"], wake.route_revision);
        assert!(pgcf_native_protocol::valid_schema(
            "gatewayAdmissionTarget",
            &target
        ));
        assert!(crate::power::sleep_completed(&map, now_ms()));
        // The slot is the database's until it sleeps, with a ticket Cloudflare has to confirm.
        let serving = w.reconciler.pool.serving(&w.id).expect("served");
        assert_eq!(serving.slot, SLOT_HEX);
        assert!(serving.ticket.is_some());
        assert_eq!(
            holder(&w),
            Some(format!("slot:{}:{BOOT_ID}", slot_pod_uid()))
        );
        // The gateway that delivered the wake hears the hit; the slot's postgres container gets
        // the class's requests and the database its daily backup, all after the release.
        eventually("the hit result", || {
            w.gateway
                .wake
                .lock()
                .unwrap()
                .results
                .iter()
                .any(|(address, result)| {
                    address == "10.0.0.1"
                        && result["outcome"] == "hit"
                        && result["generation"] == wake.generation
                })
        })
        .await;
        eventually("the backup", || {
            w.server
                .get("ScheduledBackup", Some(&slot_ns()), "daily-backup")
                .is_some()
        })
        .await;
        let lines = w.since(from);
        let resized = at(
            &lines,
            &format!(
                "PATCH /api/v1/namespaces/{}/pods/database-1/resize",
                slot_ns()
            ),
        );
        assert!(at(&lines, "GATEWAY release") < resized);
        assert!(at(&lines, "GATEWAY release") < at(&lines, "GATEWAY wake-result hit"));
        // Nothing reached Cloudflare: the claim is the Actor's, and the observation the next
        // pass's once the claim is confirmed.
        assert!(!has(&lines, "observation"));
    }

    fn cluster(w: &World, ns: &str) -> Value {
        w.server.get("Cluster", Some(ns), "database").unwrap()
    }
    fn result_of(w: &World, outcome: &str) -> Option<Value> {
        w.gateway
            .wake
            .lock()
            .unwrap()
            .results
            .iter()
            .find(|(_, result)| result["outcome"] == outcome)
            .map(|(_, result)| result.clone())
    }
    /// A hit Cloudflare confirmed: the desired row runs at the ticket's generation and the pass
    /// after the confirmation published the slot's attestation.
    async fn confirmed(w: &mut World) -> (WakeRequest, Value) {
        let wake = delivered_wake(w).await;
        assert!(w.reconciler.pool.serves(&w.id), "a hit");
        w.claimed(&wake);
        let db = w.db.clone();
        let decided = w
            .reconciler
            .pool
            .confirm_tickets(|id| (id == db["id"]).then_some(&db), Instant::now());
        assert_eq!(decided, vec![(w.id.clone(), TicketOutcome::Confirmed)]);
        w.fresh_authority();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .expect("an observation");
        (wake, observed)
    }

    #[tokio::test]
    async fn the_claim_wave_writes_secret_objectstore_and_ca_before_the_cluster_patch_that_lifts_the_fence()
     {
        let mut w = World::pooled().await;
        let before = cluster(&w, &slot_ns());
        let from = w.log_len();
        delivered_wake(&mut w).await;
        let lines = w.since(from);
        let ns = slot_ns();
        let lift = at(
            &lines,
            &format!("PATCH /apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database"),
        );
        for write in [
            format!("PATCH /api/v1/namespaces/{ns}/secrets/archive-credentials"),
            format!("PATCH /apis/barmancloud.cnpg.io/v1/namespaces/{ns}/objectstores/archive"),
            format!("PATCH /api/v1/namespaces/{SYSTEM}/configmaps/ca-{}", w.id),
        ] {
            assert!(at(&lines, &write) < lift, "{write}");
        }
        // The regional archive credentials, the tenant's archive path and retention.
        let secret = w
            .server
            .get("Secret", Some(&ns), "archive-credentials")
            .unwrap();
        assert_eq!(
            secret["data"]["AWS_ACCESS_KEY_ID"],
            STANDARD.encode("unit-access")
        );
        assert_eq!(
            secret["data"]["AWS_SECRET_ACCESS_KEY"],
            STANDARD.encode("unit-secret")
        );
        let store = w.server.get("ObjectStore", Some(&ns), "archive").unwrap();
        assert_eq!(
            store["spec"]["configuration"]["destinationPath"],
            w.db["archive"]["destination_path"]
        );
        assert_eq!(store["spec"]["retentionPolicy"], "7d");
        // The slot's CA, published for the database with the Secret it came from.
        let published = w
            .server
            .get("ConfigMap", Some(SYSTEM), &format!("ca-{}", w.id))
            .unwrap();
        assert_eq!(published["data"]["ca.crt"], w.slot_authority.pem.as_str());
        let source = w.server.get("Secret", Some(&ns), "database-ca").unwrap();
        assert_eq!(
            published["metadata"]["annotations"]["pgcf.io/source-ca-secret-uid"],
            source["metadata"]["uid"]
        );
        // One Cluster patch: the fence lifted, the database named and its parameters set, the
        // resources as they were so that the Pod does not roll.
        let after = cluster(&w, &ns);
        assert!(after["metadata"]["annotations"]["cnpg.io/fencedInstances"].is_null());
        assert_eq!(
            after["metadata"]["labels"]["pgcf.io/database-id"],
            w.id.as_str()
        );
        let claim: Claim =
            serde_json::from_str(after["metadata"]["annotations"][CLAIM].as_str().unwrap())
                .unwrap();
        assert_eq!(
            (claim.database.as_str(), claim.generation),
            (w.id.as_str(), 3)
        );
        // The parameters of the running row the slot serves.
        let mut running = w.db.clone();
        running["size"]["memory_request_mib"] = 128.into();
        assert_eq!(
            after["spec"]["postgresql"]["parameters"],
            crate::manifests::parameters(&running)
        );
        assert_eq!(after["spec"]["resources"], before["spec"]["resources"]);
        let cluster_writes = lines
            .iter()
            .filter(|line| {
                line.starts_with(&format!(
                    "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database"
                ))
            })
            .count();
        assert_eq!(cluster_writes, 1);
    }

    #[tokio::test]
    async fn a_pg_control_identity_unlike_the_sleep_record_undoes_the_attach_and_never_lifts_the_fence()
     {
        let mut w = World::pooled().await;
        // The volume was used after the recorded sleep: its checkpoint is on another timeline.
        w.gateway
            .agent
            .lock()
            .unwrap()
            .devices
            .get_mut(LV_UUID)
            .unwrap()
            .control
            .timeline = 2;
        let record_before = record(&w);
        let from = w.log_len();
        delivered_wake(&mut w).await;
        let lines = w.since(from);
        assert!(has(&lines, "AGENT attach ok"));
        assert!(!has(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                slot_ns()
            )
        ));
        assert!(!has(&lines, "GATEWAY release"));
        assert!(!has(&lines, "SLOT SQL"));
        // The slot is gone, its holder released, the record untouched.
        assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
        assert_eq!(holder(&w), None);
        assert_eq!(record(&w), record_before);
        assert!(!w.reconciler.pool.serves(&w.id));
        eventually("the miss", || {
            result_of(&w, "miss").is_some_and(|r| r["reason"] == "identity_mismatch")
        })
        .await;
    }

    #[tokio::test]
    async fn a_sql_identity_unlike_the_sleep_record_unwinds_and_never_releases() {
        let mut w = World::pooled().await;
        let record_before = record(&w);
        // PostgreSQL of the slot starts on data with another identity than the volume's.
        w.sql.lock().unwrap().system_identifier = "7430000000000000009".into();
        let from = w.log_len();
        delivered_wake(&mut w).await;
        let lines = w.since(from);
        assert!(has(&lines, "SLOT SQL pgcf_maintenance server identity"));
        assert!(!has(&lines, "GATEWAY release"));
        assert!(!has(&lines, "admission_target"));
        // Fenced again before the slot was deleted, and the volume released.
        let fenced = lines
            .iter()
            .rposition(|line| {
                line.contains(&format!(
                    "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                    slot_ns()
                )) && line.contains("fencedInstances")
            })
            .expect("fenced again");
        assert!(fenced < at(&lines, &format!("DELETE /api/v1/namespaces/{}", slot_ns())));
        assert_eq!(holder(&w), None);
        assert_eq!(record(&w), record_before);
        eventually("the miss", || {
            result_of(&w, "miss").is_some_and(|r| r["reason"] == "sql_identity_mismatch")
        })
        .await;
    }

    #[tokio::test]
    async fn an_unconfirmed_ticket_is_unwound_after_10_s_and_the_slot_namespace_deleted() {
        let mut w = World::pooled().await;
        let fence_before = fence(&w);
        let wake = delivered_wake(&mut w).await;
        assert!(w.reconciler.pool.serves(&w.id));
        // Cloudflare's row still sleeps: nothing is decided before the lease runs out.
        let db = w.db.clone();
        let cell = |id: &str| (id == db["id"]).then_some(&db);
        assert!(
            w.reconciler
                .pool
                .confirm_tickets(cell, Instant::now())
                .is_empty()
        );
        let late =
            Instant::now() + Duration::from_millis(pgcf_native_protocol::wake::TICKET_LEASE_MS + 1);
        assert_eq!(
            w.reconciler.pool.confirm_tickets(cell, late),
            vec![(w.id.clone(), TicketOutcome::Expired)]
        );
        assert_eq!(w.reconciler.pool.retiring(), vec![w.id.clone()]);
        let from = w.log_len();
        assert!(
            w.reconciler
                .pool
                .retire_serving(&w.reconciler, &w.id, Some(&w.db))
                .await
                .unwrap()
        );
        let lines = w.since(from);
        // The release is undone first, then the slot fenced, recorded from its shut-down data
        // directory, deleted and its volume released.
        let restored = at(
            &lines,
            &format!(
                "PATCH /api/v1/namespaces/{SYSTEM}/configmaps/gateway-fence-{}",
                w.id
            ),
        );
        let fenced = at(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                slot_ns()
            ),
        );
        let recorded = at(
            &lines,
            &format!(
                "PATCH /api/v1/namespaces/{SYSTEM}/configmaps/storage-{}",
                w.id
            ),
        );
        let deleted = at(&lines, &format!("DELETE /api/v1/namespaces/{}", slot_ns()));
        let released = at(&lines, "AGENT release ok");
        assert!(restored < fenced && fenced < recorded && recorded < deleted && deleted < released);
        let map = fence(&w);
        assert_eq!(
            map["data"]["intent.json"],
            fence_before["data"]["intent.json"]
        );
        assert_eq!(
            map["data"]["admission_target"],
            fence_before["data"]["admission_target"]
        );
        assert!(crate::power::sleep_completed(&map, now_ms()));
        let slept = record(&w).unwrap();
        assert_eq!(slept.via, Via::Slot);
        assert_eq!(
            slept.configuration_sha256,
            sleep_fingerprint(&w.db, IMAGE).unwrap()
        );
        assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
        assert_eq!(holder(&w), None);
        assert!(!w.reconciler.pool.serves(&w.id));
        let _ = wake;
    }

    #[tokio::test]
    async fn a_confirmed_ticket_s_next_pass_posts_ready_with_an_attestation_of_the_slot_pod() {
        let mut w = World::pooled().await;
        let (wake, observed) = confirmed(&mut w).await;
        assert_eq!(observed["state"], "ready", "{observed}");
        assert_eq!(observed["power"]["state"], "awake");
        assert_eq!(observed["power"]["operation"], wake.operation.as_str());
        let proof = &observed["runtime_attestation"];
        assert_eq!(proof["v"], 2, "{observed}");
        assert_eq!(proof["pod_uid"], slot_pod_uid());
        assert_eq!(proof["container_id"], SLOT_POSTGRES);
        assert_eq!(
            proof["tls_server_name"],
            format!("database-rw.{}.svc", slot_ns())
        );
        assert_eq!(proof["cnpg_cluster_uid"], slot_cluster_uid());
        assert_eq!(proof["pod_ip"], SLOT_IP);
        assert_eq!(proof["pvc_uid"], claim_uid());
        assert!(crate::contracts::schema_valid(
            "DatabaseRuntimeAttestation",
            proof
        ));
        // The power record is the wake's now, and the target the slot's.
        let map = fence(&w);
        let intent: crate::power::PowerIntent =
            serde_json::from_str(map["data"]["intent.json"].as_str().unwrap()).unwrap();
        assert!(crate::power::woke_under(&map, &intent, now_ms()));
        let target: Value =
            serde_json::from_str(map["data"]["admission_target"].as_str().unwrap()).unwrap();
        assert_eq!(target["pod_uid"], slot_pod_uid());
        assert!(w.reconciler.pool.serving(&w.id).unwrap().ticket.is_none());
    }

    #[tokio::test]
    async fn a_slot_served_sleep_proves_the_archived_segment_fences_records_deletes_and_releases() {
        let mut w = World::pooled().await;
        confirmed(&mut w).await;
        // The database goes idle again.
        w.db["generation"] = 4.into();
        w.db["desired_state"] = "suspended".into();
        w.db["power"] = json!({"operation":format!("op_{}","e".repeat(20)),"revision":4,"mode":"quiesce","reason":"idle"});
        w.db["size"]
            .as_object_mut()
            .unwrap()
            .remove("memory_request_mib");
        w.sql.lock().unwrap().timeline = 1;
        let from = w.log_len();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .expect("the sleep completes in one pass");
        assert_eq!(observed["state"], "hibernated", "{observed}");
        let lines = w.since(from);
        // The proof is made on the slot: the closed segment's .done before the slot is fenced.
        let switched = at(&lines, "SLOT SQL pgcf_maintenance WITH switched AS");
        let archived = lines
            .iter()
            .rposition(|line| line.starts_with("SLOT SQL") && line.contains("SELECT EXISTS(SELECT"))
            .expect("the archive status");
        let fenced = at(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                slot_ns()
            ),
        );
        let recorded = at(
            &lines,
            &format!(
                "PATCH /api/v1/namespaces/{SYSTEM}/configmaps/storage-{}",
                w.id
            ),
        );
        let deleted = at(&lines, &format!("DELETE /api/v1/namespaces/{}", slot_ns()));
        let released = at(&lines, "AGENT release ok");
        assert!(switched < archived && archived < fenced, "{lines:#?}");
        assert!(fenced < recorded && recorded < deleted && deleted < released);
        // The tenant's own Cluster was never started.
        assert!(!has(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                w.ns
            )
        ));
        let slept = record(&w).unwrap();
        assert_eq!((slept.via, slept.timeline), (Via::Slot, 1));
        assert_eq!(
            slept.configuration_sha256,
            sleep_fingerprint(&w.db, IMAGE).unwrap()
        );
        assert_eq!(holder(&w), None);
        assert!(!w.reconciler.pool.serves(&w.id));
        assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
    }

    #[tokio::test]
    async fn a_desired_trigger_wake_hits_inside_the_reconcile_pass_and_a_miss_continues_unchanged()
    {
        let mut w = World::pooled().await;
        let wake = w.wake_request();
        w.claimed(&wake);
        w.fresh_authority();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .expect("an observation");
        assert_eq!(observed["state"], "ready", "{observed}");
        assert_eq!(observed["runtime_attestation"]["pod_uid"], slot_pod_uid());
        let serving = w.reconciler.pool.serving(&w.id).unwrap();
        assert!(
            serving.ticket.is_none(),
            "Cloudflare committed this wake already"
        );
        // Without a free slot, the same pass takes the database's own Cluster, as before.
        let mut w = World::pooled().await;
        w.reconciler.pool.discard(SLOT_HEX).await.unwrap();
        let wake = w.wake_request();
        w.claimed(&wake);
        w.fresh_authority();
        let from = w.log_len();
        w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
        let lines = w.since(from);
        let hold = at(&lines, "AGENT hold ok");
        let lifted = lines
            .iter()
            .position(|line| {
                line.contains(&format!(
                    "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                    w.ns
                )) && line.contains("\"cnpg.io/hibernation\":\"off\"")
            })
            .unwrap_or_else(|| panic!("hibernation lifted in {lines:#?}"));
        assert!(hold < lifted);
        assert!(!w.reconciler.pool.serves(&w.id));
        assert_eq!(holder(&w), Some(format!("cnpg:{}", w.id)));
    }

    #[tokio::test]
    async fn the_miss_path_takes_the_cnpg_holder_before_hibernation_is_lifted_and_waits_when_busy()
    {
        let mut w = World::pooled().await;
        w.reconciler.pool.discard(SLOT_HEX).await.unwrap();
        let wake = w.wake_request();
        w.claimed(&wake);
        // Another holder has the volume: nothing starts on it.
        w.gateway
            .agent
            .lock()
            .unwrap()
            .holders
            .insert(LV_UUID.into(), format!("slot:{}:{BOOT_ID}", uid(77)));
        w.fresh_authority();
        let from = w.log_len();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed["state"], "provisioning", "{observed}");
        let lines = w.since(from);
        assert!(has(&lines, "AGENT hold holder_busy"));
        assert!(
            !lines
                .iter()
                .any(|line| line.contains("\"cnpg.io/hibernation\":\"off\""))
        );
        // Once the holder is gone the next pass takes it, then lifts hibernation.
        w.gateway.agent.lock().unwrap().holders.clear();
        let from = w.log_len();
        w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
        let lines = w.since(from);
        let hold = at(&lines, "AGENT hold ok");
        let lifted = lines
            .iter()
            .position(|line| line.contains("\"cnpg.io/hibernation\":\"off\""))
            .expect("hibernation lifted");
        assert!(hold < lifted);
    }

    #[tokio::test]
    async fn the_cnpg_sleep_writes_the_sleep_record_and_releases_the_holder_after_the_pod_is_gone()
    {
        let mut w = World::awake().await;
        w.quick();
        w.reconciler.power.attach.client =
            crate::attach_protocol::Client::new(w.gateway.client.clone());
        w.thin();
        w.snapshot.region["parking"] = Value::Null;
        w.gateway
            .agent
            .lock()
            .unwrap()
            .holders
            .insert(LV_UUID.into(), format!("cnpg:{}", w.id));
        assert!(w.sleep_pass().await.is_none());
        // CNPG has not removed the Pod yet: nothing is recorded or released.
        assert!(w.sleep_pass().await.is_none());
        assert_eq!(record(&w), None);
        assert_eq!(holder(&w), Some(format!("cnpg:{}", w.id)));
        w.hibernated_by_cnpg();
        let from = w.log_len();
        let observed = w.sleep_pass().await.unwrap();
        assert_eq!(observed["state"], "hibernated");
        let lines = w.since(from);
        let recorded = at(
            &lines,
            &format!(
                "PATCH /api/v1/namespaces/{SYSTEM}/configmaps/storage-{}",
                w.id
            ),
        );
        let released = at(&lines, "AGENT release ok");
        let hibernated = lines
            .iter()
            .position(|line| {
                line.contains(&format!("configmaps/gateway-fence-{}", w.id))
                    && line.contains("hibernated")
            })
            .expect("the hibernated record");
        assert!(recorded < released && released < hibernated);
        let slept = record(&w).unwrap();
        assert_eq!(slept.via, Via::Cnpg);
        assert_eq!(slept.system_identifier, Sql::default().system_identifier);
        assert_eq!(slept.image, IMAGE);
        assert_eq!(
            slept.configuration_sha256,
            sleep_fingerprint(&w.db, IMAGE).unwrap()
        );
        assert_eq!(holder(&w), None);
        // Another pass over the hibernated database writes nothing again.
        let from = w.log_len();
        w.sleep_pass().await.unwrap();
        assert!(!has(&w.since(from), "AGENT release"));
    }

    #[tokio::test]
    async fn a_role_only_change_is_applied_in_the_slot_and_any_other_change_hands_over_to_cnpg() {
        let mut w = World::pooled().await;
        confirmed(&mut w).await;
        // A role's password rotates at the next generation.
        w.db["generation"] = 4.into();
        w.db["power"]["revision"] = 4.into();
        w.db["storage_startup"]["generation"] = 4.into();
        w.db["roles"][1]["password"] = "z".repeat(43).into();
        w.db["roles"][1]["revision"] = 3.into();
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            observed["state"], "provisioning",
            "the roles wait for CNPG: {observed}"
        );
        let ns = slot_ns();
        let secret = w
            .server
            .get(
                "Secret",
                Some(&ns),
                &crate::manifests::role_secret("reader_query"),
            )
            .expect("the role's Secret in the slot");
        assert_eq!(secret["data"]["password"], STANDARD.encode("z".repeat(43)));
        assert!(
            w.server
                .get("Secret", Some(&ns), "maintenance-credentials")
                .is_some()
        );
        let managed = &cluster(&w, &ns)["spec"]["managed"]["roles"];
        assert!(
            managed
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["name"] == "reader_query"),
            "{managed}"
        );
        // CNPG reconciles them: the next pass is ready, still in the slot.
        let versions: Value = ["reader_query", "pgcf_maintenance"].iter().map(|name| {
            let secret = if *name == "pgcf_maintenance" { "maintenance-credentials".to_string() } else { crate::manifests::role_secret(name) };
            (name.to_string(), json!({"resourceVersion":w.server.get("Secret", Some(&ns), &secret).unwrap()["metadata"]["resourceVersion"]}))
        }).collect::<serde_json::Map<String, Value>>().into();
        w.server.edit("Cluster", Some(&ns), "database", |cluster| {
            cluster["status"]["managedRolesStatus"] = json!({"byStatus":{"reconciled":["reader_query","pgcf_maintenance"]},"passwordStatus":versions});
        });
        let observed = w
            .reconciler
            .reconcile(&w.db, &w.snapshot)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(observed["state"], "ready", "{observed}");
        assert_eq!(observed["runtime_attestation"]["pod_uid"], slot_pod_uid());
        // The class changes: the slot is retired, and the same pass starts the own Cluster.
        w.db["generation"] = 5.into();
        w.db["power"]["revision"] = 5.into();
        w.db["storage_startup"]["generation"] = 5.into();
        w.db["size"]["max_connections"] = 30.into();
        w.fresh_authority();
        let from = w.log_len();
        w.reconciler.reconcile(&w.db, &w.snapshot).await.unwrap();
        let lines = w.since(from);
        let deleted = at(&lines, &format!("DELETE /api/v1/namespaces/{ns}"));
        let released = at(&lines, "AGENT release ok");
        let hold = at(&lines, "AGENT hold ok");
        assert!(deleted < released && released < hold);
        assert!(!w.reconciler.pool.serves(&w.id));
        assert_eq!(record(&w).unwrap().via, Via::Slot);
    }

    #[tokio::test]
    async fn a_container_restart_in_a_claimed_slot_fences_and_discards_it() {
        let mut w = World::pooled().await;
        confirmed(&mut w).await;
        // The postgres container restarts: a new container in a new mount namespace, without
        // the database's volume.
        w.server.edit("Pod", Some(&slot_ns()), "database-1", |pod| {
            pod["status"]["containerStatuses"][0]["restartCount"] = 1.into();
            pod["status"]["containerStatuses"][0]["containerID"] =
                format!("containerd://{}", "5".repeat(64)).into();
        });
        let retired = w.reconciler.pool.observe(SLOT_HEX).await.unwrap();
        assert_eq!(retired.as_deref(), Some(w.id.as_str()));
        assert_eq!(w.reconciler.pool.retiring(), vec![w.id.clone()]);
        let from = w.log_len();
        assert!(
            w.reconciler
                .pool
                .retire_serving(&w.reconciler, &w.id, Some(&w.db))
                .await
                .unwrap()
        );
        let lines = w.since(from);
        let fenced = at(
            &lines,
            &format!(
                "PATCH /apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                slot_ns()
            ),
        );
        assert!(fenced < at(&lines, &format!("DELETE /api/v1/namespaces/{}", slot_ns())));
        assert!(
            cluster(&w, &slot_ns())["metadata"]["annotations"]["cnpg.io/fencedInstances"]
                .is_string()
        );
        // What the data directory holds is unknown: no record, so the next wake is the own
        // Cluster's crash recovery.
        assert_eq!(record(&w), None);
        assert_eq!(holder(&w), None);
        assert!(!w.reconciler.pool.serves(&w.id));
    }

    #[tokio::test]
    async fn protecting_a_served_database_retires_its_slot() {
        let mut w = World::pooled().await;
        confirmed(&mut w).await;
        let observed = w.reconciler.protect_storage(&w.db).await.unwrap();
        assert_eq!(observed.unwrap()["state"], "provisioning");
        assert!(!w.reconciler.pool.serves(&w.id));
        assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
        assert_eq!(holder(&w), None);
    }

    fn fresh_reconciler(w: &World) -> crate::reconcile::Reconciler {
        let mut rec = crate::reconcile::Reconciler::new(
            w.server.k8s.clone(),
            kube_system(),
            IMAGE.into(),
            "eu-test".into(),
            1,
        )
        .unwrap();
        rec.power.attach.client = crate::attach_protocol::Client::new(w.gateway.client.clone());
        rec.power.http = w.gateway.client.clone();
        rec.pool.intake.http = w.gateway.client.clone();
        rec
    }

    #[tokio::test]
    async fn restart_rediscovers_free_and_serving_slots_and_unwinds_unconfirmed_claims() {
        let mut w = World::pooled().await;
        // A free slot is found free.
        let free = fresh_reconciler(&w);
        free.pool.rediscover(&free).await.unwrap();
        assert_eq!(free.pool.states().get(NODE), Some(&(1, 0, 0)));
        // A released claim Cloudflare has not confirmed: served, with a ticket of its own.
        delivered_wake(&mut w).await;
        let restarted = fresh_reconciler(&w);
        assert!(
            restarted
                .pool
                .rediscover(&restarted)
                .await
                .unwrap()
                .is_empty()
        );
        let serving = restarted.pool.serving(&w.id).expect("served");
        assert_eq!(serving.slot, SLOT_HEX);
        assert!(serving.ticket.is_some());
        assert_eq!(serving.pod.uid, slot_pod_uid());
        // Confirmed and published before the restart: served without a ticket.
        let mut w2 = World::pooled().await;
        confirmed(&mut w2).await;
        let restarted = fresh_reconciler(&w2);
        assert!(
            restarted
                .pool
                .rediscover(&restarted)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(restarted.pool.serving(&w2.id).unwrap().ticket.is_none());
        // A claim whose release never was: retired.
        w2.server
            .edit("Cluster", Some(&slot_ns()), "database", |cluster| {
                let mut claim: Value = serde_json::from_str(
                    cluster["metadata"]["annotations"][CLAIM].as_str().unwrap(),
                )
                .unwrap();
                claim["generation"] = 9.into();
                cluster["metadata"]["annotations"][CLAIM] = claim.to_string().into();
            });
        let restarted = fresh_reconciler(&w2);
        assert_eq!(
            restarted.pool.rediscover(&restarted).await.unwrap(),
            vec![w2.id.clone()]
        );
        assert!(
            restarted
                .pool
                .retire_serving(&restarted, &w2.id, None)
                .await
                .unwrap()
        );
        assert!(w2.server.get("Namespace", None, &slot_ns()).is_none());
        assert_eq!(holder(&w2), None);
    }

    #[tokio::test]
    async fn stale_slot_holders_of_missing_pods_are_released_at_start() {
        let w = World::pooled().await;
        // A slot Pod that is gone left its holder; a holder of the existing slot Pod stays.
        w.gateway
            .agent
            .lock()
            .unwrap()
            .holders
            .insert(LV_UUID.into(), format!("slot:{}:{BOOT_ID}", uid(77)));
        let restarted = fresh_reconciler(&w);
        restarted.pool.rediscover(&restarted).await.unwrap();
        assert_eq!(holder(&w), None);
        w.gateway
            .agent
            .lock()
            .unwrap()
            .holders
            .insert(LV_UUID.into(), format!("slot:{}:{BOOT_ID}", slot_pod_uid()));
        restarted.pool.rediscover(&restarted).await.unwrap();
        assert_eq!(
            holder(&w),
            Some(format!("slot:{}:{BOOT_ID}", slot_pod_uid()))
        );
    }

    #[tokio::test]
    async fn the_attach_keyring_secret_is_written_once_and_rewritten_only_on_change() {
        let w = World::pooled().await;
        let pool = &w.reconciler.pool;
        assert!(pool.publish_keys(&w.reconciler).await.unwrap());
        assert!(!pool.publish_keys(&w.reconciler).await.unwrap());
        let secret = w
            .server
            .get("Secret", Some("pgcf-attach"), "pgcf-attach-key")
            .unwrap();
        let encoded = String::from_utf8(
            STANDARD
                .decode(secret["data"]["PGCF_ATTACH_KEYS"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        let keys = attach_protocol::Keys::decode(&encoded).unwrap();
        assert_eq!(keys.region, "eu-test");
        assert_eq!(keys.active, "local");
        // The regional keyring rotates: the agent keyring follows, once.
        let rotated = json!({"active":"next","keys":{"local":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7_u8;32]),"next":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([8_u8;32])}});
        w.server
            .edit("Secret", Some(SYSTEM), "pgcf-gateway", |secret| {
                secret["data"]["PGCF_ROUTE_KEY"] = STANDARD.encode(rotated.to_string()).into();
            });
        assert!(pool.publish_keys(&w.reconciler).await.unwrap());
        assert!(!pool.publish_keys(&w.reconciler).await.unwrap());
        let secret = w
            .server
            .get("Secret", Some("pgcf-attach"), "pgcf-attach-key")
            .unwrap();
        let encoded = String::from_utf8(
            STANDARD
                .decode(secret["data"]["PGCF_ATTACH_KEYS"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            attach_protocol::Keys::decode(&encoded).unwrap().active,
            "next"
        );
        let writes = w
            .server
            .state
            .lock()
            .unwrap()
            .writes
            .iter()
            .filter(|(_, path, _)| {
                path.contains("pgcf-attach-key")
                    || path.ends_with("/namespaces/pgcf-attach/secrets")
            })
            .count();
        assert_eq!(writes, 2);
    }

    #[tokio::test]
    async fn a_created_slot_is_free_once_cnpg_runs_its_fenced_pod() {
        let w = World::pooled().await;
        let pool = &w.reconciler.pool;
        let work = pool.refill_work([&w.db], true, Instant::now());
        let [PoolWork::Create(spec)] = work.as_slice() else {
            panic!("one creation: {work:?}");
        };
        assert_eq!(
            (spec.node.as_str(), spec.cpu_millicores, spec.memory_mib),
            (NODE, 250, 256)
        );
        // Registered at once: the next plan creates no second one on the node.
        assert_eq!(pool.refill_work([&w.db], true, Instant::now()), vec![]);
        let from = w.server.state.lock().unwrap().writes.len();
        pool.create_slot(&w.reconciler, &w.snapshot, spec)
            .await
            .unwrap();
        let ns = format!("pgcf-slot-{}", spec.hex);
        let created: Vec<String> = w.server.state.lock().unwrap().writes[from..]
            .iter()
            .map(|(method, path, _)| format!("{method} {path}"))
            .collect();
        assert_eq!(
            created[0],
            format!("POST /api/v1/namespaces/{ns}"),
            "{created:#?}"
        );
        assert_eq!(
            created.last().unwrap(),
            &format!("POST /apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database")
        );
        assert_eq!(created.len(), 10);
        assert!(w.server.get("Cluster", Some(&ns), "database").is_some());
        assert_eq!(pool.states().get(NODE), Some(&(1, 1, 0)));
        // CNPG runs its fenced instance and makes its CA.
        let owner = json!([{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":w.server.get("Cluster", Some(&ns), "database").unwrap()["metadata"]["uid"],"controller":true}]);
        w.server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":ns,"uid":uid(70),"ownerReferences":owner},"spec":{"nodeName":NODE,"containers":[{"name":"postgres","image":IMAGE}]},"status":{"phase":"Running","podIP":"10.0.0.10",
            "containerStatuses":[{"name":"postgres","containerID":format!("containerd://{}","6".repeat(64)),"state":{"running":{}},"restartCount":0}],
            "initContainerStatuses":[{"name":"plugin-barman-cloud","containerID":format!("containerd://{}","7".repeat(64)),"state":{"running":{}},"restartCount":0}]}}));
        assert_eq!(pool.observe(&spec.hex).await.unwrap(), None);
        assert_eq!(pool.states().get(NODE), Some(&(1, 1, 0)), "no CA yet");
        w.server.put(json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"database-ca","namespace":ns,"uid":uid(71),"ownerReferences":owner},"data":{"ca.crt":STANDARD.encode(&w.slot_authority.pem)}}));
        pool.observe(&spec.hex).await.unwrap();
        assert_eq!(pool.states().get(NODE), Some(&(2, 0, 0)));
        // A free slot that changes (its postgres container restarted) is deleted.
        w.server.edit("Pod", Some(&ns), "database-1", |pod| {
            pod["status"]["containerStatuses"][0]["restartCount"] = 1.into();
        });
        pool.observe(&spec.hex).await.unwrap();
        assert!(w.server.get("Namespace", None, &ns).is_none());
        assert_eq!(pool.states().get(NODE), Some(&(1, 0, 0)));
    }

    #[tokio::test]
    async fn a_hit_cut_off_before_it_serves_leaves_its_slot_to_be_retired() {
        let mut w = World::pooled().await;
        // PostgreSQL of the slot does not come up, and the pass is cut off meanwhile.
        w.slot_postgres.as_ref().unwrap().stop();
        w.fresh_authority();
        let wake = w.wake_request();
        let cut = tokio::time::timeout(
            Duration::from_millis(400),
            w.reconciler
                .pool
                .wake(&w.reconciler, Some((&w.db, &w.snapshot)), &wake, false),
        )
        .await;
        assert!(cut.is_err(), "cut off");
        assert_eq!(
            holder(&w),
            Some(format!("slot:{}:{BOOT_ID}", slot_pod_uid()))
        );
        assert_eq!(w.reconciler.pool.retiring(), vec![w.id.clone()]);
        assert!(
            w.reconciler
                .pool
                .retire_serving(&w.reconciler, &w.id, Some(&w.db))
                .await
                .unwrap()
        );
        assert_eq!(holder(&w), None);
        assert!(w.server.get("Namespace", None, &slot_ns()).is_none());
        assert!(!w.reconciler.pool.serves(&w.id));
        // The fence never named the slot.
        assert!(crate::power::sleep_completed(&fence(&w), now_ms()));
    }
}
