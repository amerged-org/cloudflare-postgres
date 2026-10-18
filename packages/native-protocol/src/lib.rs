// SPDX-License-Identifier: Apache-2.0
//! Portable protocol validation. Generated source contracts remain authoritative.
pub mod activity;
#[cfg(not(target_arch = "wasm32"))]
pub mod agent;
#[path = "constants.generated.rs"]
pub mod generated;
pub mod route;
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
