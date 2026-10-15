// SPDX-License-Identifier: Apache-2.0
use pgcf_native_protocol::pool;
#[test]
fn authoritative_pool_scope_and_refinement_conformance() {
    let document = &*pool::CONTRACT;
    assert_eq!(
        pool::scope_hash(&document["scope"]).as_deref(),
        document["scope_sha256"].as_str()
    );
    assert_eq!(
        pool::preparation_hash(&document["preparation"]).as_deref(),
        document["preparation_sha256"].as_str()
    );
    for case in document["vectors"].as_array().unwrap() {
        assert_eq!(
            pool::validate(case["schema"].as_str().unwrap(), &case["value"]),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn cleanup_grant_uses_distinct_signature_domain_and_finite_profile_bounds() {
    let document = &*pool::CONTRACT;
    let keys = std::collections::HashMap::from([(
        document["cleanup"]["kid"].as_str().unwrap().to_owned(),
        document["cleanup"]["public_key"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_u64().unwrap() as u8)
            .collect(),
    )]);
    let token = document["cleanup"]["token"].as_str().unwrap();
    assert_eq!(
        pool::verify_cleanup_authority(token, &keys, 1000),
        Some(document["cleanup"]["claims"].clone())
    );
    assert!(pool::verify_cleanup_authority(token, &keys, 11000).is_none());
    assert!(pool::verify_permission(token, &keys, 1000).is_none());
    assert!(
        pool::verify_cleanup_authority(&token.replacen("pc1.", "pb1.", 1), &keys, 1000).is_none()
    );
}

#[test]
fn initial_thin_writer_requires_exact_storage_authority_for_the_immutable_pool_pod() {
    let document = &*pool::CONTRACT;
    let trust = pgcf_native_protocol::storage::StorageTrust::parse(
        document["storage"]["keys_json"].as_str().unwrap(),
        document["storage"]["trust_sha256"].as_str().unwrap(),
    )
    .unwrap();
    let token = document["storage"]["token"].as_str().unwrap();
    let scope = &document["thin_scope"];
    assert!(pool::verify_pool_storage_authority(&trust, token, scope, 1000).is_some());
    let mut other = scope.clone();
    other["generation"] = serde_json::json!(8);
    assert!(pool::verify_pool_storage_authority(&trust, token, &other, 1000).is_none());
    other = scope.clone();
    other["pool_pod_uid"] = serde_json::json!("11111111-1111-4111-8111-111111111111");
    assert!(pool::verify_pool_storage_authority(&trust, token, &other, 1000).is_none());
    assert!(pool::verify_pool_storage_authority(&trust, token, scope, 11000).is_none());
}
