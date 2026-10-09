// SPDX-License-Identifier: Apache-2.0
//! CF-only physical write authority. This never mutates logical power generations.
use crate::{constant, valid_pattern, valid_schema, wire};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct StorageTrust {
    keys: BTreeMap<String, Vec<u8>>,
}

#[derive(Clone, Debug)]
pub struct VerifiedStorageAuthority(StorageWriteClaims);
impl VerifiedStorageAuthority {
    pub fn claims(&self) -> &StorageWriteClaims {
        &self.0
    }
    pub fn permits(&self, binding: &StorageBinding, now: u64) -> bool {
        self.0.permits(binding, now)
    }
}

fn decode(encoded: &str) -> Result<Vec<u8>, &'static str> {
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "storage authority encoding invalid")?;
    if URL_SAFE_NO_PAD.encode(&bytes) != encoded {
        return Err("storage authority encoding is not canonical");
    }
    Ok(bytes)
}

impl StorageTrust {
    /// Only Deployment-pinned trust material enters here; a ledger cannot supply its own keys/hash.
    pub fn parse(raw: &str, pinned_sha256: &str) -> Result<Self, &'static str> {
        if raw.len() > 16_384
            || pinned_sha256.len() != 64
            || !pinned_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("storage authority trust pin invalid");
        }
        let encoded: BTreeMap<String, String> =
            serde_json::from_str(raw).map_err(|_| "storage authority keys invalid")?;
        if encoded.is_empty() || encoded.len() > 8 {
            return Err("storage authority keys invalid");
        }
        let canonical =
            serde_json::to_vec(&encoded).map_err(|_| "storage authority keys invalid")?;
        let actual = Sha256::digest(&canonical)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != pinned_sha256 {
            return Err("storage authority trust pin mismatch");
        }
        let mut keys = BTreeMap::new();
        for (kid, value) in encoded {
            if !valid_pattern("storageAuthorityKid", &kid) {
                return Err("storage authority key identifier invalid");
            }
            let public = decode(&value)?;
            if public.len() != 32 {
                return Err("storage authority public key invalid");
            }
            keys.insert(kid, public);
        }
        Ok(Self { keys })
    }

    /// A historical signed capability can identify only an existing volume for protection.
    /// It never permits a write/start; those callers still use verify(token,current_time).
    pub fn verify_for_protection(
        &self,
        token: &str,
    ) -> Result<VerifiedStorageAuthority, &'static str> {
        if token.len() > constant("STORAGE_AUTHORITY_MAX_LENGTH") as usize {
            return Err("storage authority too large");
        }
        let parts = token.split('.').collect::<Vec<_>>();
        if parts.len() != 3 {
            return Err("storage authority malformed");
        }
        let claims: StorageWriteClaims = serde_json::from_slice(&decode(parts[1])?)
            .map_err(|_| "storage authority claims invalid")?;
        self.verify(token, claims.iat)
    }

    pub fn verify(&self, token: &str, now: u64) -> Result<VerifiedStorageAuthority, &'static str> {
        if token.len() > constant("STORAGE_AUTHORITY_MAX_LENGTH") as usize {
            return Err("storage authority too large");
        }
        let parts = token.split('.').collect::<Vec<_>>();
        if parts.len() != 3 || parts[0] != wire("storageAuthorityPrefix") {
            return Err("storage authority malformed");
        }
        let body = decode(parts[1])?;
        let signature = decode(parts[2])?;
        if signature.len() != 64 {
            return Err("storage authority signature invalid");
        }
        let claims: StorageWriteClaims =
            serde_json::from_slice(&body).map_err(|_| "storage authority claims invalid")?;
        if !valid_schema(
            "storageWriteClaims",
            &serde_json::to_value(&claims).map_err(|_| "storage authority claims invalid")?,
        ) || !claims.valid_at(now)
        {
            return Err("storage authority claims invalid");
        }
        let key = self
            .keys
            .get(&claims.kid)
            .ok_or("storage authority signer untrusted")?;
        let message = format!("{}{}", wire("storageAuthorityDomain"), parts[1]);
        UnparsedPublicKey::new(&ED25519, key)
            .verify(message.as_bytes(), &signature)
            .map_err(|_| "storage authority signature invalid")?;
        Ok(VerifiedStorageAuthority(claims))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StorageWriteClaims {
    #[serde(deserialize_with = "safe_unsigned")]
    pub v: u64,
    pub kid: String,
    pub database_id: String,
    #[serde(deserialize_with = "safe_unsigned")]
    pub generation: u64,
    #[serde(deserialize_with = "safe_unsigned")]
    pub authority_revision: u64,
    pub storage_uid: String,
    pub node_uid: String,
    pub volume_group_uuid: String,
    pub pool_uuid: String,
    pub profile_sha256: String,
    pub volume_handle: String,
    pub lv_uuid: String,
    pub pvc_uid: String,
    pub pv_uid: String,
    pub pod_uid: String,
    #[serde(deserialize_with = "safe_unsigned")]
    pub observed_at: u64,
    #[serde(deserialize_with = "safe_unsigned")]
    pub iat: u64,
    #[serde(deserialize_with = "safe_unsigned")]
    pub exp: u64,
    #[serde(deserialize_with = "safe_unsigned")]
    pub guard_seconds: u64,
    #[serde(deserialize_with = "safe_unsigned")]
    pub drain_seconds: u64,
    pub write_allowed: bool,
}

fn safe_unsigned<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    let value = f64::deserialize(deserializer)?;
    let maximum = crate::CONTRACT["storageWriteClaims"]["properties"]["generation"]["maximum"]
        .as_f64()
        .expect("generated safe integer bound");
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > maximum {
        return Err(serde::de::Error::custom(
            "storage authority integer invalid",
        ));
    }
    Ok(value as u64)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageBinding {
    pub database_id: String,
    pub generation: u64,
    pub storage_uid: String,
    pub node_uid: String,
    pub volume_group_uuid: String,
    pub pool_uuid: String,
    pub profile_sha256: String,
    pub volume_handle: String,
    pub lv_uuid: String,
    pub pvc_uid: String,
    pub pv_uid: String,
    pub pod_uid: String,
}

impl StorageWriteClaims {
    pub fn valid_at(&self, now: u64) -> bool {
        let skew = constant("STORAGE_AUTHORITY_SKEW_MS");
        self.iat <= now.saturating_add(skew)
            && self.observed_at <= now.saturating_add(skew)
            && self.observed_at
                >= now.saturating_sub(constant("STORAGE_AUTHORITY_MAX_SECONDS") * 1000)
            && self.iat >= self.observed_at.saturating_sub(skew)
            && self.exp > now
            && self.exp > self.iat
            && self
                .guard_seconds
                .checked_mul(1000)
                .and_then(|ttl| self.observed_at.checked_add(ttl))
                .is_some_and(|end| self.exp <= end)
    }

    pub fn matches(&self, expected: &StorageBinding) -> bool {
        self.database_id == expected.database_id
            && self.generation == expected.generation
            && self.storage_uid == expected.storage_uid
            && self.node_uid == expected.node_uid
            && self.volume_group_uuid == expected.volume_group_uuid
            && self.pool_uuid == expected.pool_uuid
            && self.profile_sha256 == expected.profile_sha256
            && self.volume_handle == expected.volume_handle
            && self.lv_uuid == expected.lv_uuid
            && self.pvc_uid == expected.pvc_uid
            && self.pv_uid == expected.pv_uid
            && self.pod_uid == expected.pod_uid
    }

    pub fn permits(&self, expected: &StorageBinding, now: u64) -> bool {
        self.write_allowed && self.valid_at(now) && self.matches(expected)
    }
}

/// Healthy refreshes change only authority freshness; they never change power/configuration epochs.
#[derive(Default)]
pub struct StorageGate {
    current: Option<StorageWriteClaims>,
    highest: Option<StorageWriteClaims>,
}
impl StorageGate {
    pub fn update(
        &mut self,
        verified: VerifiedStorageAuthority,
        expected: &StorageBinding,
        now: u64,
    ) -> Result<(), &'static str> {
        let claims = verified.0;
        if !claims.matches(expected) || !claims.valid_at(now) {
            self.current = None;
            return Err("storage authority identity or freshness changed");
        }
        if let Some(previous) = &self.highest
            && (claims.authority_revision < previous.authority_revision
                || (claims.authority_revision == previous.authority_revision
                    && claims != *previous))
        {
            self.current = None;
            return Err("storage authority regressed or conflicted");
        }
        self.highest = Some(claims.clone());
        self.current = Some(claims);
        Ok(())
    }
    pub fn permits(&self, expected: &StorageBinding, now: u64) -> bool {
        self.current
            .as_ref()
            .is_some_and(|claims| claims.permits(expected, now))
    }
    pub fn deadline(&self) -> Option<u64> {
        self.current.as_ref().map(|claims| claims.exp)
    }
    pub fn disconnect(&mut self) {
        self.current = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    struct Issuer {
        pair: Ed25519KeyPair,
        trust: StorageTrust,
    }
    impl Issuer {
        fn new() -> Self {
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
            let raw = serde_json::to_string(&BTreeMap::from([(
                "cf".to_string(),
                URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            )]))
            .unwrap();
            let pin = Sha256::digest(raw.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let trust = StorageTrust::parse(&raw, &pin).unwrap();
            Self { pair, trust }
        }
        fn token(&self, claims: &StorageWriteClaims) -> String {
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap());
            let signature = self
                .pair
                .sign(format!("{}{}", wire("storageAuthorityDomain"), body).as_bytes());
            format!(
                "{}.{}.{}",
                wire("storageAuthorityPrefix"),
                body,
                URL_SAFE_NO_PAD.encode(signature.as_ref())
            )
        }
    }
    fn claims() -> StorageWriteClaims {
        StorageWriteClaims {
            v: 1,
            kid: "cf".into(),
            database_id: "abcdefghijklmnopqrst".into(),
            generation: 1,
            authority_revision: 1,
            storage_uid: "11111111-1111-4111-8111-111111111111".into(),
            node_uid: "22222222-2222-4222-8222-222222222222".into(),
            volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef".into(),
            pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg".into(),
            profile_sha256: "a".repeat(64),
            volume_handle: "pvc-33333333-3333-4333-8333-333333333333".into(),
            lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh".into(),
            pvc_uid: "33333333-3333-4333-8333-333333333333".into(),
            pv_uid: "44444444-4444-4444-8444-444444444444".into(),
            pod_uid: "55555555-5555-4555-8555-555555555555".into(),
            observed_at: 1000,
            iat: 1000,
            exp: 11000,
            guard_seconds: 10,
            drain_seconds: 10,
            write_allowed: true,
        }
    }
    fn binding(c: &StorageWriteClaims) -> StorageBinding {
        StorageBinding {
            database_id: c.database_id.clone(),
            generation: c.generation,
            storage_uid: c.storage_uid.clone(),
            node_uid: c.node_uid.clone(),
            volume_group_uuid: c.volume_group_uuid.clone(),
            pool_uuid: c.pool_uuid.clone(),
            profile_sha256: c.profile_sha256.clone(),
            volume_handle: c.volume_handle.clone(),
            lv_uuid: c.lv_uuid.clone(),
            pvc_uid: c.pvc_uid.clone(),
            pv_uid: c.pv_uid.clone(),
            pod_uid: c.pod_uid.clone(),
        }
    }
    #[test]
    fn actual_signature_expiry_and_immutable_binding_are_required() {
        let issuer = Issuer::new();
        let c = claims();
        let expected = binding(&c);
        let token = issuer.token(&c);
        let verified = issuer.trust.verify(&token, 1000).unwrap();
        assert!(verified.permits(&expected, 1000));
        assert!(issuer.trust.verify(&token, 11000).is_err());
        let mut replacement = expected.clone();
        replacement.pool_uuid = "defghi-defg-defg-defg-defg-defg-defghi".into();
        assert!(!verified.permits(&replacement, 1000));
        assert!(Issuer::new().trust.verify(&token, 1000).is_err());
    }
    #[test]
    fn expired_authority_is_only_a_verified_protective_identity() {
        let issuer = Issuer::new();
        let c = claims();
        let token = issuer.token(&c);
        assert!(issuer.trust.verify(&token, c.exp).is_err());
        let historical = issuer.trust.verify_for_protection(&token).unwrap();
        assert_eq!(historical.claims().lv_uuid, c.lv_uuid);
        assert!(!historical.permits(&binding(&c), c.exp));
        assert!(Issuer::new().trust.verify_for_protection(&token).is_err());
    }
    #[test]
    fn a_pinned_keyset_cannot_be_replaced_by_ledger_supplied_keys() {
        assert!(StorageTrust::parse("{}", &"0".repeat(64)).is_err());
        let issuer = Issuer::new();
        let encoded = serde_json::to_string(&BTreeMap::from([(
            "cf".to_string(),
            URL_SAFE_NO_PAD.encode(issuer.pair.public_key().as_ref()),
        )]))
        .unwrap();
        assert!(StorageTrust::parse(&encoded, &"0".repeat(64)).is_err());
    }
    #[test]
    fn blocked_authority_cannot_be_replayed_after_a_watch_gap() {
        let issuer = Issuer::new();
        let old = claims();
        let expected = binding(&old);
        let mut blocked = old.clone();
        blocked.authority_revision = 2;
        blocked.write_allowed = false;
        let mut gate = StorageGate::default();
        gate.update(
            issuer.trust.verify(&issuer.token(&blocked), 1000).unwrap(),
            &expected,
            1000,
        )
        .unwrap();
        assert!(!gate.permits(&expected, 1000));
        gate.disconnect();
        assert!(
            gate.update(
                issuer.trust.verify(&issuer.token(&old), 1000).unwrap(),
                &expected,
                1000
            )
            .is_err()
        );
    }
    #[test]
    fn signed_integral_json_numbers_match_the_authoritative_zod_semantics() {
        let issuer = Issuer::new();
        let c = claims();
        let body = URL_SAFE_NO_PAD.encode(
            serde_json::to_string(&c)
                .unwrap()
                .replace("\"generation\":1,", "\"generation\":1.0,"),
        );
        let signature = issuer
            .pair
            .sign(format!("{}{}", wire("storageAuthorityDomain"), body).as_bytes());
        let token = format!(
            "{}.{}.{}",
            wire("storageAuthorityPrefix"),
            body,
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );
        assert!(
            issuer
                .trust
                .verify(&token, 1000)
                .unwrap()
                .permits(&binding(&c), 1000)
        );
    }
}
