// SPDX-License-Identifier: Apache-2.0
//! Cloudflare-signed, finite pool qualification measurements. These grants never start PostgreSQL.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../contracts/native/qualification.generated.json"
    ))
    .expect("generated PostgreSQL pool qualification contracts")
});
pub fn validate(name: &str, value: &Value) -> bool {
    let Some(schema) = CONTRACT["schemas"].get(name) else {
        return false;
    };
    if !crate::pool::validate_generated_schema(schema, value) {
        return false;
    }
    match name {
        "PostgresPoolQualificationScope" => scope_valid(value),
        "PoolQualificationClaims" => scope_valid(&value["scope"]),
        "PostgresPoolQualificationReport" | "PostgresPoolQualificationProgressReport" => {
            value["observed_at"]
                .as_u64()
                .zip(value["started_at"].as_u64())
                .is_some_and(|(observed, started)| observed >= started)
        }
        _ => true,
    }
}
/// Link the authenticated CF pending pieces to the digest in its pq1 permission.
pub fn progress_hash(progress: &Value) -> Option<String> {
    let entries = progress.as_array()?;
    if entries.len() > 7
        || entries
            .iter()
            .any(|entry| !validate("PostgresPoolQualificationProgressEvidence", entry))
    {
        return None;
    }
    Some(
        Sha256::digest(serde_json::to_vec(progress).ok()?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
fn scope_valid(value: &Value) -> bool {
    let storage = &value["storage"];
    storage["profile_sha256"]
        .as_str()
        .is_some_and(|hash| storage["storage_class"] == format!("pgcf-lvm-thin-v1-{}", &hash[..16]))
        && storage["volume_attributes_class"] == storage["storage_class"]
        && value["storage"]["node_uid"] == value["node_uid"]
        && value["volume"]["node_uid"] == value["node_uid"]
        && value["storage"]["volume_group_uuid"] == value["volume"]["volume_group_uuid"]
        && value["storage"]["pool_uuid"] == value["volume"]["pool_uuid"]
        && value["volume"]["pvc_uid"]
            .as_str()
            .is_some_and(|uid| value["volume"]["volume_handle"] == format!("pvc-{uid}"))
}
pub fn scope_hash(scope: &Value) -> Option<String> {
    if !validate("PostgresPoolQualificationScope", scope) {
        return None;
    }
    Some(
        Sha256::digest(serde_json::to_vec(scope).ok()?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
#[cfg(not(target_arch = "wasm32"))]
fn valid_at(claims: &Value, now: u64) -> Option<()> {
    let issued = claims["iat"].as_u64()?;
    let expiry = claims["exp"].as_u64()?;
    let scope = &claims["scope"];
    let challenge = &claims["challenge"];
    let execution = &claims["execution"];
    let maximum = CONTRACT["constants"]["maximum_milliseconds"].as_u64()?;
    let skew = CONTRACT["constants"]["clock_skew_ms"].as_u64()?;
    if now > 9_007_199_254_740_991
        || issued > now.checked_add(skew)?
        || expiry <= now
        || expiry <= issued
        || expiry > issued.checked_add(maximum)?
        || expiry > challenge["expires_at"].as_u64()?
        || challenge["issued_at"].as_u64()? > issued
        || challenge["run_id"] != scope["run_id"]
        || challenge["scope_sha256"] != claims["scope_sha256"]
        || execution["node_uid"] != scope["node_uid"]
    {
        return None;
    }
    if challenge["gate"] != "cleanup"
        && (execution["boot_id"] != scope["boot_id"]
            || execution["candidate_release_id"] != scope["candidate_release_id"]
            || execution["candidate_spec_sha256"] != scope["candidate_spec_sha256"]
            || execution["driver_image"] != scope["software"]["driver_image"]
            || execution["driver_sha256"] != scope["software"]["driver_sha256"]
            || execution["host_extension_image"] != scope["software"]["host_extension_image"]
            || execution["host_controller_sha256"] != scope["software"]["host_controller_sha256"]
            || execution["kernel_version"] != scope["software"]["kernel_version"])
    {
        return None;
    }
    Some(())
}
#[cfg(not(target_arch = "wasm32"))]
/// `keys` comes from the current deployment's pinned Cloudflare verifier material,
/// never the challenge, signal or sender. A verified pq1 token grants no tenant write/start.
pub fn verify_qualification_permission(
    token: &str,
    keys: &std::collections::HashMap<String, Vec<u8>>,
    now: u64,
) -> Option<Value> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    if token.len() > CONTRACT["constants"]["maximum_length"].as_u64()? as usize {
        return None;
    }
    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != CONTRACT["constants"]["prefix"].as_str()? {
        return None;
    }
    let body = crate::route::decode(parts[1])?;
    let signature = crate::route::decode(parts[2])?;
    if signature.len() != 64
        || URL_SAFE_NO_PAD.encode(&body) != parts[1]
        || URL_SAFE_NO_PAD.encode(&signature) != parts[2]
    {
        return None;
    }
    let claims: Value = serde_json::from_slice(&body).ok()?;
    if !validate("PoolQualificationClaims", &claims)
        || scope_hash(&claims["scope"]).as_deref() != claims["scope_sha256"].as_str()
    {
        return None;
    }
    valid_at(&claims, now)?;
    let key = keys.get(claims["kid"].as_str()?)?;
    if key.len() != 32 {
        return None;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(
            format!("{}{}", CONTRACT["constants"]["domain"].as_str()?, parts[1]).as_bytes(),
            &signature,
        )
        .ok()?;
    Some(claims)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::Value;
    use std::collections::HashMap;

    fn claims() -> Value {
        serde_json::from_str::<Value>(include_str!(
            "../../contracts/native/qualification.generated.json"
        ))
        .unwrap()["fixture"]["claims"]
            .clone()
    }
    fn signed(claims: &Value) -> (String, HashMap<String, Vec<u8>>) {
        // Public deterministic test seed; actual Ed25519 executes for every proof.
        let key = Ed25519KeyPair::from_seed_unchecked(&[42; 32]).unwrap();
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
        let signature = key.sign(format!("pgcf-pool-qualification/v1\n{payload}").as_bytes());
        (
            format!(
                "pq1.{payload}.{}",
                URL_SAFE_NO_PAD.encode(signature.as_ref())
            ),
            HashMap::from([("native-test".into(), key.public_key().as_ref().to_vec())]),
        )
    }
    #[test]
    fn actual_signature_and_finite_preparation_boundaries() {
        let mut c = claims();
        assert_eq!(
            progress_hash(&serde_json::json!([])).as_deref(),
            c["progress_sha256"].as_str()
        );
        let (token, keys) = signed(&c);
        assert_eq!(
            verify_qualification_permission(&token, &keys, 1000),
            Some(c.clone())
        );
        assert!(verify_qualification_permission(&token, &keys, 31000).is_none());
        c["preparation_sha256"] = Value::from("a".repeat(64));
        let (prepared, keys) = signed(&c);
        assert_eq!(
            verify_qualification_permission(&prepared, &keys, 1000),
            Some(c.clone())
        );
        let wrong = HashMap::from([("native-test".into(), vec![0; 32])]);
        assert!(verify_qualification_permission(&prepared, &wrong, 1000).is_none());
        let mut parts = prepared.split('.').map(str::to_string).collect::<Vec<_>>();
        c["preparation_sha256"] = Value::from("b".repeat(64));
        parts[1] = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap());
        assert!(verify_qualification_permission(&parts.join("."), &keys, 1000).is_none());
    }
    #[test]
    fn nonempty_typescript_progress_hash_binds_every_recorded_field() {
        let progress = &CONTRACT["fixture"]["progress"];
        assert!(
            !progress
                .as_array()
                .expect("nonempty TS progress vector")
                .is_empty()
        );
        assert_eq!(
            progress_hash(progress).as_deref(),
            CONTRACT["fixture"]["progress_sha256"].as_str()
        );
        let mut changed = progress.clone();
        changed[0]["received_at"] = Value::from(1005);
        assert_ne!(progress_hash(&changed), progress_hash(progress));
        changed[0]["progress"]["passed"] = Value::from(true);
        assert!(progress_hash(&changed).is_none());
    }
    #[test]
    fn re_signed_scope_drift_and_overlong_expiry_are_refused() {
        let original = claims();
        for (pointer, changed) in [
            ("/scope/thin_id", Value::from(1 << 24)),
            (
                "/execution/node_uid",
                Value::from("00000000-0000-4000-8000-000000000098"),
            ),
            (
                "/execution/boot_id",
                Value::from("00000000-0000-4000-8000-000000000098"),
            ),
            ("/execution/driver_sha256", Value::from("f".repeat(64))),
            (
                "/execution/host_controller_sha256",
                Value::from("f".repeat(64)),
            ),
            ("/challenge/nonce", Value::from("nonce-is-not-hex")),
            ("/challenge/scope_sha256", Value::from("f".repeat(64))),
            ("/exp", Value::from(31001)),
            ("/iat", Value::from(6001)),
        ] {
            let mut c = original.clone();
            *c.pointer_mut(pointer).unwrap() = changed;
            let (token, keys) = signed(&c);
            assert!(
                verify_qualification_permission(&token, &keys, 1000).is_none(),
                "{pointer}"
            );
        }
    }
    #[test]
    fn current_cleanup_identity_does_not_become_a_new_measurement_grant() {
        let mut c = claims();
        c["execution"]["boot_id"] = Value::from("00000000-0000-4000-8000-000000000098");
        let (token, keys) = signed(&c);
        assert!(verify_qualification_permission(&token, &keys, 1000).is_none());
        c["challenge"]["gate"] = Value::from("cleanup");
        let (token, keys) = signed(&c);
        assert_eq!(
            verify_qualification_permission(&token, &keys, 1000),
            Some(c)
        );
    }
    #[test]
    fn unknown_fields_and_noncanonical_encoding_are_refused() {
        let mut c = claims();
        c["passed"] = Value::Bool(true);
        let (token, keys) = signed(&c);
        assert!(verify_qualification_permission(&token, &keys, 1000).is_none());
        let (token, keys) = signed(&claims());
        let mut parts = token.split('.').map(str::to_string).collect::<Vec<_>>();
        parts[1].push('=');
        assert!(verify_qualification_permission(&parts.join("."), &keys, 1000).is_none());
        assert!(verify_qualification_permission(&"x".repeat(16385), &keys, 1000).is_none());
    }
}
