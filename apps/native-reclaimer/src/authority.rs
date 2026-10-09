// SPDX-License-Identifier: Apache-2.0
pub use pgcf_native_protocol::reclaim::{
    CONTRACT, Trust, Verified, binding_fingerprint, file, fingerprint, limit, text, unsigned,
    valid_at,
};
use serde_json::Value;
pub fn schema(name: &str, value: &Value) -> bool {
    jsonschema::validator_for(&CONTRACT["schemas"][name])
        .is_ok_and(|validator| validator.is_valid(value))
}
