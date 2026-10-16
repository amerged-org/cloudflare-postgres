// SPDX-License-Identifier: Apache-2.0
//! The attach protocol (I-2) as the controller and the node agent use it.
use pgcf_native_controller::attach_protocol::{
    Action, Holder, Keys, MAX_LIFETIME_SECONDS, Volume, nonce, parse_control, sign, verify,
};
use std::collections::HashMap;

const NODE: &str = "eu1-node-1";
const LV: &str = "aB3dE9-x1y2-Z3w4-v5u6-t7s8-r9q0-P1o2N3";
const NOW: u64 = 1_790_000_000_000;

fn keys() -> Keys {
    let route = HashMap::from([
        ("k1".to_string(), vec![7u8; 32]),
        ("k2".to_string(), vec![9u8; 48]),
    ]);
    Keys::derive("eu-dev", "k1", &route).unwrap()
}

#[test]
fn a_signed_attach_token_verifies_only_for_its_node_action_region_and_lifetime() {
    let keys = keys();
    let id = nonce().unwrap();
    let token = sign(&keys, NODE, Action::Attach, LV, &id, NOW).unwrap();
    assert!(token.starts_with("pa1."));
    let claims = verify(&token, &keys, NODE, Action::Attach, NOW).unwrap();
    assert_eq!(
        (claims.lv_uuid.as_str(), claims.nonce.as_str()),
        (LV, id.as_str())
    );
    assert_eq!(
        verify(&token, &keys, "eu1-node-2", Action::Attach, NOW),
        Err("denied")
    );
    assert_eq!(
        verify(&token, &keys, NODE, Action::Release, NOW),
        Err("denied")
    );
    let mut other_region = keys.clone();
    other_region.region = "eu-other".into();
    assert_eq!(
        verify(&token, &other_region, NODE, Action::Attach, NOW),
        Err("denied")
    );
    let after = NOW + MAX_LIFETIME_SECONDS * 1000 + 1000;
    assert_eq!(
        verify(&token, &keys, NODE, Action::Attach, after),
        Err("denied")
    );
    assert_eq!(
        verify(&token, &keys, NODE, Action::Attach, NOW - 6_000),
        Err("denied")
    );
    // `holders` carries no volume; every other action names a valid LV UUID.
    assert!(sign(&keys, NODE, Action::Holders, "", &id, NOW).is_ok());
    assert!(sign(&keys, NODE, Action::Holders, LV, &id, NOW).is_err());
    assert!(sign(&keys, NODE, Action::Attach, "", &id, NOW).is_err());
}

#[test]
fn a_token_with_a_changed_payload_or_unknown_kid_is_denied() {
    let keys = keys();
    let token = sign(&keys, NODE, Action::Hold, LV, &nonce().unwrap(), NOW).unwrap();
    let parts: Vec<&str> = token.split('.').collect();
    let other = sign(
        &keys,
        "eu1-node-2",
        Action::Hold,
        LV,
        &nonce().unwrap(),
        NOW,
    )
    .unwrap();
    let swapped = format!(
        "{}.{}.{}",
        parts[0],
        other.split('.').nth(1).unwrap(),
        parts[2]
    );
    assert_eq!(
        verify(&swapped, &keys, "eu1-node-2", Action::Hold, NOW),
        Err("denied")
    );
    let mut unknown = keys.clone();
    unknown.keys.remove("k1");
    assert_eq!(
        verify(&token, &unknown, NODE, Action::Hold, NOW),
        Err("denied")
    );
    assert_eq!(
        verify(
            &format!("pa2{}", &token[3..]),
            &keys,
            NODE,
            Action::Hold,
            NOW
        ),
        Err("denied")
    );
}

#[test]
fn the_attach_keyring_derives_one_key_per_kid_and_roundtrips_through_the_secret_field() {
    let keys = keys();
    assert_eq!(keys.keys.len(), 2);
    assert!(keys.keys.values().all(|key| key.len() == 32));
    assert_ne!(keys.keys["k1"], vec![7u8; 32]);
    assert_eq!(Keys::decode(&keys.encode()).unwrap(), keys);
    assert!(Keys::decode("{}").is_err());
    let short = HashMap::from([("k1".to_string(), vec![7u8; 16])]);
    assert!(Keys::derive("eu-dev", "k1", &short).is_err());
    let route = HashMap::from([("k1".to_string(), vec![7u8; 32])]);
    assert!(Keys::derive("eu-dev", "k2", &route).is_err());
}

#[test]
fn volume_dm_name_doubles_dashes_and_dm_uuid_is_lvm_vg_then_lv_without_dashes() {
    let volume = Volume {
        lv_name: "pvc-0b1c2d3e-4f50-4617-8899-aabbccddeeff".into(),
        lv_uuid: LV.into(),
        vg_uuid: "Vg0001-a1b2-c3d4-e5f6-g7h8-i9j0-k1l2m3".into(),
    };
    assert!(volume.valid());
    assert_eq!(
        volume.dm_name(),
        "pgcf-pvc--0b1c2d3e--4f50--4617--8899--aabbccddeeff"
    );
    assert_eq!(
        volume.dm_uuid(),
        "LVM-Vg0001a1b2c3d4e5f6g7h8i9j0k1l2m3aB3dE9x1y2Z3w4v5u6t7s8r9q0P1o2N3"
    );
    let mut invalid = volume.clone();
    invalid.lv_name = "pvc-x".into();
    assert!(!invalid.valid());
}

fn control(version: u32, state: i32, timeline: u32, length: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; length];
    let identifier = 7_431_215_993_172_011_234u64.to_le_bytes();
    let mut put = |offset: usize, value: &[u8]| {
        if offset + value.len() <= length {
            bytes[offset..offset + value.len()].copy_from_slice(value);
        }
    };
    put(0, &identifier);
    put(8, &version.to_le_bytes());
    put(16, &state.to_le_bytes());
    put(48, &timeline.to_le_bytes());
    bytes
}

#[test]
fn pg_control_bytes_yield_identifier_state_and_timeline_and_refuse_other_versions() {
    let clean = parse_control(&control(1800, 1, 1, 296)).unwrap();
    assert_eq!(clean.system_identifier, "7431215993172011234");
    assert_eq!((clean.state, clean.timeline), (1, 1));
    assert!(clean.shut_down());
    let running = parse_control(&control(1800, 6, 3, 296)).unwrap();
    assert_eq!((running.state, running.timeline), (6, 3));
    assert!(!running.shut_down());
    assert_eq!(
        parse_control(&control(1700, 1, 1, 296)),
        Err("control_version")
    );
    assert_eq!(
        parse_control(&control(1800, 1, 1, 40)),
        Err("control_unreadable")
    );
}

#[test]
fn holder_records_name_the_slot_pod_and_boot_or_the_database() {
    let pod = "0f1e2d3c-4b5a-4968-8776-655443322110";
    let slot = Holder::Slot {
        pod_uid: pod.into(),
    };
    assert!(slot.valid());
    assert_eq!(slot.record("boot-1"), format!("slot:{pod}:boot-1"));
    let cnpg = Holder::Cnpg {
        database: "d0123456789abcdef012".into(),
    };
    assert_eq!(cnpg.record("boot-1"), "cnpg:d0123456789abcdef012");
    assert!(
        !Holder::Slot {
            pod_uid: "not-a-uid".into()
        }
        .valid()
    );
    assert_eq!(
        serde_json::to_value(&slot).unwrap(),
        serde_json::json!({"kind": "slot", "pod_uid": pod})
    );
}

#[test]
fn agent_of_accepts_only_a_ready_running_private_pgcf_attach_pod() {
    use pgcf_native_controller::attach_protocol::agent_of;
    let pod = serde_json::json!({
        "metadata": {"namespace": "pgcf-attach", "labels": {"app.kubernetes.io/name": "pgcf-attach"}},
        "spec": {"nodeName": NODE},
        "status": {"phase": "Running", "podIP": "10.244.1.7",
                   "conditions": [{"type": "Ready", "status": "True"}]},
    });
    let agent = agent_of(&pod).unwrap();
    assert_eq!(
        (agent.node.as_str(), agent.address.to_string()),
        (NODE, "10.244.1.7".to_string())
    );
    let changed = |pointer: &str, value: serde_json::Value| {
        let mut pod = pod.clone();
        *pod.pointer_mut(pointer).unwrap() = value;
        agent_of(&pod)
    };
    assert_eq!(changed("/metadata/namespace", "pgcf-system".into()), None);
    assert_eq!(
        changed(
            "/metadata/labels/app.kubernetes.io~1name",
            "pgcf-agent".into()
        ),
        None
    );
    assert_eq!(changed("/status/phase", "Pending".into()), None);
    assert_eq!(changed("/status/conditions/0/status", "False".into()), None);
    assert_eq!(changed("/status/podIP", "203.0.113.9".into()), None);
    let mut deleting = pod.clone();
    deleting["metadata"]["deletionTimestamp"] = "2026-10-16T00:00:00Z".into();
    assert_eq!(agent_of(&deleting), None);
}
