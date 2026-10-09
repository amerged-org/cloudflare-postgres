// SPDX-License-Identifier: Apache-2.0
use crate::{constant, route::decode, valid_schema, wire};
use hmac::{Hmac, KeyInit, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::collections::HashMap;
fn mac(key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let mut hmac = Hmac::<Sha256>::new_from_slice(key).ok()?;
    hmac.update(data);
    Some(hmac.finalize().into_bytes().to_vec())
}
fn verify(
    token: &str,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    pod: &str,
    now_ms: u64,
    activity: bool,
    action: Option<&str>,
) -> Option<Value> {
    let (schema, prefix, length, lifetime, key_purpose, signing_purpose) = if activity {
        (
            "activityClaims",
            "activityTokenPrefix",
            "GATEWAY_ACTIVITY_MAX_LENGTH",
            "GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS",
            "activityKeyPurpose",
            "activitySigningPurpose",
        )
    } else {
        (
            "controlClaims",
            "controlTokenPrefix",
            "GATEWAY_CONTROL_MAX_LENGTH",
            "GATEWAY_CONTROL_MAX_LIFETIME_SECONDS",
            "controlKeyPurpose",
            "controlSigningPurpose",
        )
    };
    if token.len() > constant(length) as usize {
        return None;
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != wire(prefix) {
        return None;
    }
    let payload = decode(parts[1])?;
    let signature = decode(parts[2])?;
    if signature.len() != 32 {
        return None;
    }
    let text = std::str::from_utf8(&payload).ok()?;
    let mut claims: Value =
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()?;
    if let Some(object) = claims.as_object_mut() {
        for field in object.values_mut() {
            if let Some(number) = field.as_f64()
                && number >= 0.0
                && number.fract() == 0.0
                && number <= 9_007_199_254_740_991.0
            {
                *field = Value::from(number as u64);
            }
        }
    }
    if !valid_schema(schema, &claims) {
        return None;
    }
    let key = keys.get(claims["kid"].as_str()?)?;
    if key.len() < constant("ROUTE_KEY_MIN_BYTES") as usize {
        return None;
    }
    let derived = mac(key, wire(key_purpose).as_bytes())?;
    let mut verifier = Hmac::<Sha256>::new_from_slice(&derived).ok()?;
    verifier.update(wire(signing_purpose).as_bytes());
    verifier.update(parts[1].as_bytes());
    verifier.verify_slice(&signature).ok()?;
    let issued = claims["iat"].as_u64()?;
    let expiry = claims["exp"].as_u64()?;
    if expiry <= issued
        || expiry - issued > constant(lifetime)
        || now_ms < issued * 1000
        || (if activity {
            now_ms >= expiry * 1000
        } else {
            now_ms > expiry * 1000
        })
        || claims["region"] != region
        || claims["pod"] != pod
        || action.is_some_and(|a| claims["action"] != a)
    {
        return None;
    }
    Some(claims)
}
pub fn control(
    token: &str,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    pod: &str,
    action: &str,
    now_ms: u64,
) -> Option<Value> {
    verify(token, keys, region, pod, now_ms, false, Some(action))
}
pub fn activity(
    token: &str,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    pod: &str,
    now_ms: u64,
) -> Option<Value> {
    verify(token, keys, region, pod, now_ms, true, None)
}
