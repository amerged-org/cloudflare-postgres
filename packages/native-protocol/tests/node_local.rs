// SPDX-License-Identifier: Apache-2.0
//! The agent's gateway channel against the vectors of its TypeScript contract
//! (`packages/contracts/src/node-local.ts`): the constants are the contract's, every valid line
//! decodes and encodes again to the very bytes the contract wrote, and every invalid line is
//! refused. The gateway and the agent speak this crate, so the vectors hold both of them.
use pgcf_native_protocol::{agent, wake};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../contracts/native/node-local.generated.json"
    ))
    .unwrap()
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn the_constants_are_the_contracts() {
    let vectors = vectors();
    let constants = &vectors["constants"];
    assert_eq!(constants["AGENT_GATEWAY_SOCKET"], agent::GATEWAY_SOCKET);
    assert_eq!(
        constants["AGENT_CHANNEL_MAX_LINE_BYTES"],
        agent::MAX_LINE_BYTES
    );
    assert_eq!(
        constants["AGENT_CHANNEL_MAX_DATABASES"],
        agent::MAX_DATABASES
    );
    assert_eq!(
        constants["UNIX_SOCKET_PATH_MAX_BYTES"],
        agent::MAX_SOCKET_PATH_BYTES
    );
    assert_eq!(constants["WAKE_REDELIVER_MS"], wake::REDELIVER_MS);
    assert_eq!(strings(&constants["WAKE_REASONS"]), wake::REASONS);
    assert_eq!(
        serde_json::to_value([wake::Outcome::Started, wake::Outcome::Refused]).unwrap(),
        constants["WAKE_OUTCOMES"]
    );
}

#[test]
fn every_line_of_the_channel_is_decided_as_the_contract_decides_it() {
    let vectors = vectors();
    let channel = &vectors["gateway_channel"];
    type Decode = fn(&[u8]) -> Result<Vec<u8>, &'static str>;
    let sides: [(&str, Decode); 2] = [
        ("agent", |line| {
            agent::decode_to_gateway(line).map(|m| agent::encode(&m))
        }),
        ("gateway", |line| {
            agent::decode_from_gateway(line).map(|m| agent::encode(&m))
        }),
    ];
    for (side, decode) in sides {
        let lines = channel[side].as_array().unwrap();
        assert!(!lines.is_empty());
        for vector in lines {
            let (name, line) = (&vector["name"], vector["line"].as_str().unwrap());
            let decoded = decode(line.as_bytes());
            assert_eq!(
                decoded.is_ok(),
                vector["valid"] == true,
                "{side} {name}: {:?}",
                decoded.as_ref().err()
            );
            if let Ok(encoded) = decoded {
                // The encoder writes the line the contract wrote, byte for byte.
                assert_eq!(
                    String::from_utf8(encoded).unwrap().trim_end(),
                    line,
                    "{side} {name} encodes again"
                );
            }
        }
    }
}

#[test]
fn a_refused_wake_is_answered_with_the_detail_and_hint_of_the_contract() {
    let vectors = vectors();
    let constants = &vectors["constants"];
    let admission = strings(&constants["ADMISSION_REFUSALS"]);
    let refusals = vectors["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), wake::REASONS.len());
    for vector in refusals {
        let reason = vector["reason"].as_str().unwrap();
        let seconds = vector["retry_after_seconds"].as_u64().map(|s| s as u32);
        assert_eq!(
            seconds.is_some(),
            reason == wake::RETRY_REASON,
            "{reason} carries the retry hint exactly when it is the one waiting can undo"
        );
        assert_eq!(
            wake::refusal_detail(reason),
            vector["detail"].as_str(),
            "{reason} detail"
        );
        assert_eq!(
            wake::refusal_hint(reason, seconds).as_deref(),
            vector["hint"].as_str(),
            "{reason} hint"
        );
        // Every detail the contract names is one of the admission refusals'.
        assert_eq!(
            vector.get("detail").is_some(),
            admission.contains(&reason),
            "{reason}"
        );
    }
}
