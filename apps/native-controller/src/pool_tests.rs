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
