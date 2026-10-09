// SPDX-License-Identifier: Apache-2.0
pub type Error = Box<dyn std::error::Error + Send + Sync>;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::LazyLock};
pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../contracts/native/reclaim.generated.json"
    ))
    .expect("generated reclaim contract")
});
pub fn limit(name: &str) -> u64 {
    CONTRACT["constants"]["RECLAIM_LIMITS"][name]
        .as_u64()
        .expect("generated reclaim limit")
}
pub fn file(name: &str) -> &'static str {
    CONTRACT["constants"]["RECLAIM_FILES"][name]
        .as_str()
        .expect("fixed reclaim file")
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn unsigned(v: &Value, key: &str) -> Result<u64, Error> {
    v[key]
        .as_u64()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .or_else(|| {
            v[key]
                .as_f64()
                .filter(|v| {
                    v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= 9_007_199_254_740_991.0
                })
                .map(|v| v as u64)
        })
        .ok_or_else(|| "unknown unsigned reclaim field".into())
}
pub fn schema(name: &str, value: &Value) -> bool {
    name == "ReclaimClaims" && crate::valid_schema("reclaimClaims", value)
}
pub fn valid_at(v: &Value, now: u64) -> bool {
    let parsed = (|| {
        let issued = unsigned(v, "issued_at")?;
        let expires = unsigned(v, "expires_at")?;
        let budget = unsigned(v, "budget_bytes")?;
        let step = unsigned(v, "step_bytes")?;
        Ok::<_, Error>(
            issued <= now.saturating_add(limit("clock_skew_ms"))
                && expires > now
                && expires > issued
                && expires <= issued.saturating_add(limit("lease_ms"))
                && unsigned(v, "memory_request_bytes")? < unsigned(v, "memory_limit_bytes")?
                && if v["mode"] == "revoked" {
                    budget == 0 && step == 0
                } else {
                    budget > 0 && step > 0 && step <= budget
                },
        )
    })();
    schema("ReclaimClaims", v) && parsed.unwrap_or(false)
}
fn decode(s: &str) -> Result<Vec<u8>, Error> {
    let bytes = URL_SAFE_NO_PAD.decode(s)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != s {
        return Err("noncanonical reclaim authority".into());
    }
    Ok(bytes)
}
pub struct Trust {
    keys: BTreeMap<String, Vec<u8>>,
}
#[derive(Clone)]
pub struct Verified {
    value: Value,
}
impl Verified {
    pub fn claims(&self) -> &Value {
        &self.value
    }
}
impl Trust {
    pub fn new(raw: &str, pin: &str) -> Result<Self, Error> {
        if raw.len() > 16384 {
            return Err("reclaim keyset exceeds bound".into());
        }
        let encoded: BTreeMap<String, String> = serde_json::from_str(raw)?;
        if encoded.is_empty() || encoded.len() > 8 {
            return Err("reclaim keyset invalid".into());
        }
        let actual = Sha256::digest(serde_json::to_vec(&encoded)?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if actual != pin {
            return Err("reclaim keyset pin changed".into());
        }
        let mut keys = BTreeMap::new();
        for (kid, key) in encoded {
            if !crate::valid_pattern("storageAuthorityKid", &kid) {
                return Err("reclaim signer ID invalid".into());
            }
            let bytes = decode(&key)?;
            if bytes.len() != 32 {
                return Err("reclaim public key invalid".into());
            }
            keys.insert(kid, bytes);
        }
        Ok(Self { keys })
    }
    pub fn verify(&self, token: &str, now: u64) -> Result<Verified, Error> {
        if token.len() > limit("max_token_bytes") as usize {
            return Err("reclaim token exceeds bound".into());
        }
        let parts: Vec<_> = token.split('.').collect();
        if parts.len() != 3
            || parts[0]
                != CONTRACT["constants"]["RECLAIM_PREFIX"]
                    .as_str()
                    .ok_or("reclaim prefix missing")?
        {
            return Err("reclaim token malformed".into());
        }
        let body = decode(parts[1])?;
        let signature = decode(parts[2])?;
        let mut value: Value = serde_json::from_slice(&body)?;
        if signature.len() != 64 || !valid_at(&value, now) {
            return Err("reclaim scope or clock invalid".into());
        }
        let key = self
            .keys
            .get(text(&value, "kid"))
            .ok_or("reclaim signer untrusted")?;
        let message = format!(
            "{}{}",
            CONTRACT["constants"]["RECLAIM_DOMAIN"]
                .as_str()
                .ok_or("reclaim domain missing")?,
            parts[1]
        );
        UnparsedPublicKey::new(&ED25519, key)
            .verify(message.as_bytes(), &signature)
            .map_err(|_| "reclaim signature invalid")?;
        // Zod accepts integral JSON floats. Normalize them once before semantic equality/CAS.
        for key in [
            "v",
            "intent_revision",
            "generation",
            "storage_generation",
            "budget_bytes",
            "step_bytes",
            "memory_request_bytes",
            "memory_limit_bytes",
            "issued_at",
            "expires_at",
        ] {
            value[key] = unsigned(&value, key)?.into();
        }
        Ok(Verified { value })
    }
}
pub fn fingerprint(claims: &Value) -> Result<String, Error> {
    let mut semantic = claims.clone();
    let object = semantic
        .as_object_mut()
        .ok_or("reclaim authority is not an object")?;
    object.remove("issued_at");
    object.remove("expires_at");
    object.remove("intent_revision");
    Ok(Sha256::digest(serde_json::to_vec(&semantic)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub fn binding_fingerprint(claims: &Value) -> Result<String, Error> {
    let mut value = claims.clone();
    let object = value.as_object_mut().ok_or("reclaim binding invalid")?;
    for key in ["kid", "mode", "budget_bytes", "step_bytes"] {
        object.remove(key);
    }
    fingerprint(&value)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../contracts/native/reclaim-vectors.generated.json"
        ))
        .unwrap()
    }
    #[test]
    fn actual_cf_signatures_and_exact_expiry_match_zod() {
        let v = fixture();
        let trust = Trust::new(&v["keyset"].to_string(), text(&v, "pin")).unwrap();
        assert_eq!(
            trust.verify(text(&v, "token"), 1000).unwrap().claims(),
            &v["claims"]
        );
        assert!(trust.verify(text(&v, "token"), 6000).is_err());
        assert!(trust.verify(text(&v, "malformedToken"), 1000).is_err());
        assert!(Trust::new(&v["keyset"].to_string(), &"0".repeat(64)).is_err());
        assert_eq!(
            trust
                .verify(text(&v, "revokedToken"), 1000)
                .unwrap()
                .claims()["mode"],
            "revoked"
        );
    }
}
