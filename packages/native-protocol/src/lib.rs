// SPDX-License-Identifier: Apache-2.0
//! Portable protocol validation. Generated source contracts remain authoritative.
pub mod activity;
#[path = "constants.generated.rs"]
pub mod generated;
pub mod route;
pub mod scoped_tokens;
pub mod startup;
pub mod wake;

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../contracts/native/protocol.generated.json"
    ))
    .expect("generated contract is valid JSON")
});

pub fn constant(name: &str) -> u64 {
    CONTRACT["constants"][name]
        .as_u64()
        .expect("generated constant")
}
pub fn wire(name: &str) -> &'static str {
    CONTRACT["wire"][name]
        .as_str()
        .expect("generated wire constant")
}
static PATTERNS: LazyLock<HashMap<String, Regex>> = LazyLock::new(|| {
    CONTRACT["patterns"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| {
            (
                name.clone(),
                Regex::new(value.as_str().unwrap()).expect("generated regex"),
            )
        })
        .collect()
});
static CLAIM_PATTERNS: LazyLock<HashMap<String, Regex>> = LazyLock::new(|| {
    let mut result = HashMap::new();
    for name in [
        "routeClaims",
        "admissionRouteClaims",
        "gatewayAdmissionTarget",
        "legacyRouteClaims",
        "controlClaims",
        "activityClaims",
        "intent",
    ] {
        for (field, value) in CONTRACT[name]["properties"].as_object().unwrap() {
            if let Some(pattern) = value["pattern"].as_str() {
                result.insert(
                    format!("{name}/{field}"),
                    Regex::new(pattern).expect("generated regex"),
                );
            }
        }
    }
    result
});

pub fn valid_pattern(name: &str, value: &str) -> bool {
    PATTERNS
        .get(name)
        .expect("generated pattern")
        .is_match(value)
}

pub fn valid_role(value: &str) -> bool {
    valid_pattern("role", value)
        && !CONTRACT["reservedRoles"]
            .as_array()
            .expect("generated roles")
            .iter()
            .any(|v| v.as_str() == Some(value))
        && !CONTRACT["reservedRolePrefixes"]
            .as_array()
            .expect("generated prefixes")
            .iter()
            .any(|v| value.starts_with(v.as_str().expect("generated prefix")))
}

/// The generated route schema uses this bounded JSON Schema subset. Unknown keywords
/// never influence authorization; the generator rejects unhandled structural changes.
pub fn valid_claims(value: &Value) -> bool {
    valid_schema("routeClaims", value) && value["user"].as_str().is_some_and(valid_role)
}
/// Temporary rollout compatibility: v2 claims without a route revision or target.
pub fn valid_legacy_claims(value: &Value) -> bool {
    valid_schema("legacyRouteClaims", value) && value["user"].as_str().is_some_and(valid_role)
}
pub fn valid_schema(name: &str, value: &Value) -> bool {
    let schema = &CONTRACT[name];
    let Some(object) = value.as_object() else {
        return false;
    };
    let properties = schema["properties"]
        .as_object()
        .expect("generated properties");
    if object.len() != properties.len() {
        return false;
    }
    for (key, field) in properties {
        let Some(value) = object.get(key) else {
            return false;
        };
        if let Some(expected) = field.get("const")
            && value != expected
        {
            return false;
        }
        match field["type"].as_str() {
            Some("string") => {
                let Some(text) = value.as_str() else {
                    return false;
                };
                if let Some(pattern) = CLAIM_PATTERNS.get(&format!("{name}/{key}"))
                    && !pattern.is_match(text)
                {
                    return false;
                }
                if field["minLength"]
                    .as_u64()
                    .is_some_and(|n| text.encode_utf16().count() < n as usize)
                    || field["maxLength"]
                        .as_u64()
                        .is_some_and(|n| text.encode_utf16().count() > n as usize)
                {
                    return false;
                }
                if let Some(choices) = field["enum"].as_array()
                    && !choices.contains(value)
                {
                    return false;
                }
            }
            Some("integer") => {
                let Some(number) = value.as_u64() else {
                    return false;
                };
                if number < field["minimum"].as_u64().unwrap_or(0)
                    || number > field["maximum"].as_u64().unwrap_or(u64::MAX)
                    || field["exclusiveMinimum"]
                        .as_u64()
                        .is_some_and(|v| number <= v)
                {
                    return false;
                }
            }
            Some("boolean") => {
                if !value.is_boolean() {
                    return false;
                }
            }
            Some("number") => {
                if value.as_u64().is_none() {
                    return false;
                }
            }
            _ => return false,
        }
    }
    true
}
