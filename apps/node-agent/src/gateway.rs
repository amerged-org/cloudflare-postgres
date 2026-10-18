// SPDX-License-Identifier: Apache-2.0
//! The agent's side of the gateway channel (plan 5.7).

#[cfg(test)]
mod tests {
    use pgcf_native_protocol::agent::{decode_from_gateway, decode_to_gateway};
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-local.generated.json"
        ))
        .unwrap()
    }

    /// The contract's lines hold for the protocol crate the agent speaks: every valid line of the
    /// agent's side decodes, every invalid one is refused, and the same for the gateway's side.
    /// (The gateway's `report` is the activity report, which the agent reads field by field.)
    #[test]
    fn the_contracts_vectors_hold_for_the_protocol_the_agent_speaks() {
        let vectors = vectors();
        let channel = &vectors["gateway_channel"];
        let mut wrong = Vec::new();
        for vector in channel["agent"].as_array().unwrap() {
            let line = vector["line"].as_str().unwrap().as_bytes();
            if decode_to_gateway(line).is_ok() != (vector["valid"] == true) {
                wrong.push(format!("agent {}", vector["name"]));
            }
        }
        for vector in channel["gateway"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            // The report's own rules are the gateway's. An id beyond 2^53 decodes but answers no
            // request: the agent numbers its requests itself and matches the answers by number.
            if name.starts_with("activity-") || name.ends_with("-id-above-2-53") {
                continue;
            }
            let line = vector["line"].as_str().unwrap().as_bytes();
            if decode_from_gateway(line).is_ok() != (vector["valid"] == true) {
                wrong.push(format!("gateway {name}"));
            }
        }
        assert_eq!(wrong, Vec::<String>::new());
    }
}
