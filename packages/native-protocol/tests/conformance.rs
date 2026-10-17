// SPDX-License-Identifier: Apache-2.0
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::{
    route::{self, Connection, Keyring, ReplayCache},
    startup::{Event, StartupReader},
    wake::{self, Ticket},
};
use serde_json::{Value, json};
use std::collections::HashMap;
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../contracts/native/conformance.generated.json"
    ))
    .unwrap()
}
#[test]
fn authoritative_typescript_route_vectors() {
    let vectors = vectors();
    let key = vectors["key"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    let keys = HashMap::from([("test".into(), key)]);
    for case in vectors["routes"].as_array().unwrap() {
        let got = route::verify(
            case["token"].as_str(),
            &keys,
            case["region"].as_str().unwrap(),
            case["now"].as_f64().unwrap(),
        );
        let result = match got {
            Ok(claims) => json!({ "ok":true,"claims":claims }),
            Err(reason) => json!({ "ok":false,"reason":reason }),
        };
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
}
#[test]
fn authoritative_typescript_startup_vectors() {
    for case in vectors()["startups"].as_array().unwrap() {
        let mut reader = StartupReader::default();
        let mut events = Vec::new();
        for chunk in case["chunks"].as_array().unwrap() {
            let bytes = URL_SAFE_NO_PAD.decode(chunk.as_str().unwrap()).unwrap();
            let mut event = reader.push(&bytes);
            loop {
                let prelude = matches!(event, Event::Ssl | Event::Gss);
                events.push(serde_json::to_value(event).unwrap());
                if !prelude {
                    break;
                }
                event = reader.push(&[]);
            }
        }
        assert_eq!(json!(events), case["events"], "{}", case["name"]);
    }
}
#[test]
fn replay_has_independent_database_capacity_and_expiry() {
    let vectors = vectors();
    let key = vectors["key"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    let mut claims = route::verify(
        vectors["routes"][0]["token"].as_str(),
        &HashMap::from([("test".into(), key)]),
        "eu-test",
        1_000_000.0,
    )
    .unwrap();
    let mut cache = ReplayCache::new(1);
    assert_eq!(cache.use_token(&claims, 1_000_000), Ok(()));
    assert_eq!(cache.use_token(&claims, 1_000_000), Err("replayed"));
    claims.cid = "00000000-0000-0000-0000-000000000002".into();
    assert_eq!(cache.use_token(&claims, 1_000_000), Err("full"));
    claims.db = "b".repeat(20);
    assert_eq!(cache.use_token(&claims, 1_000_000), Ok(()));
    assert_eq!(cache.use_token(&claims, 1_035_001), Err("full"));
    claims.iat = 1036;
    claims.exp = 1066;
    assert_eq!(cache.use_token(&claims, 1_036_000), Ok(()));
}
#[test]
fn arbitrary_startup_chunks_remain_bounded_and_never_panic() {
    let mut seed = 13u64;
    for length in 0..1000 {
        let mut reader = StartupReader::default();
        let bytes: Vec<u8> = (0..length)
            .map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                (seed >> 32) as u8
            })
            .collect();
        for part in bytes.chunks(7) {
            let _ = reader.push(part);
        }
    }
}
#[test]
fn authoritative_typescript_wake_route_vectors() {
    let vectors = vectors();
    let key: Vec<u8> = vectors["key"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    let keys = HashMap::from([("test".into(), key.clone())]);
    let cases = vectors["wakeRoutes"].as_array().unwrap();
    assert!(cases.len() > 10);
    for case in cases {
        let got = wake::verify_wake(
            case["token"].as_str(),
            &keys,
            case["region"].as_str().unwrap(),
            case["now"].as_u64().unwrap(),
        );
        let result = match got {
            Ok(claims) => json!({ "ok":true,"claims":claims }),
            Err(reason) => json!({ "ok":false,"reason":reason }),
        };
        assert_eq!(result, case["expected"], "{}", case["name"]);
    }
    // The Rust signer produces the TypeScript signer's exact token.
    let signed = &vectors["wakeSigned"];
    let input = &signed["input"];
    let ticket = &input["wake"];
    let token = wake::sign_wake(
        &Keyring {
            active: "test".into(),
            keys: HashMap::from([("test".into(), key)]),
        },
        &Connection {
            region: input["region"].as_str().unwrap(),
            database: input["db"].as_str().unwrap(),
            user: input["user"].as_str().unwrap(),
            cid: input["cid"].as_str().unwrap(),
            now_ms: input["now"].as_u64().unwrap(),
            ttl_seconds: input["ttlSeconds"].as_u64().unwrap(),
        },
        &Ticket {
            operation: ticket["operation"].as_str().unwrap(),
            generation: ticket["generation"].as_u64().unwrap(),
            route_revision: ticket["route_revision"].as_u64().unwrap(),
            role_revision_hash: ticket["role_revision_hash"].as_str().unwrap(),
        },
    )
    .unwrap();
    assert_eq!(token, signed["token"].as_str().unwrap());
}
#[test]
fn role_revision_hash_matches_typescript() {
    let vectors = vectors();
    let cases = vectors["roleRevisionHashes"].as_array().unwrap();
    assert!(cases.len() > 1);
    for case in cases {
        let roles: Vec<(&str, u64)> = case["roles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|role| {
                (
                    role["name"].as_str().unwrap(),
                    role["revision"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            wake::role_revision_hash(roles),
            case["hash"].as_str().unwrap()
        );
    }
}
#[test]
fn wake_wire_constants_match_the_generated_contract() {
    assert_eq!(
        wake::ROUTE_PREFIX,
        pgcf_native_protocol::wire("wakeRouteTokenPrefix")
    );
    assert_eq!(
        wake::ROUTE_DOMAIN,
        pgcf_native_protocol::wire("wakeRouteSignatureDomain")
    );
    assert_eq!(
        u64::from(wake::ROUTE_VERSION),
        pgcf_native_protocol::CONTRACT["wakeRouteClaims"]["properties"]["v"]["const"]
            .as_u64()
            .unwrap()
    );
}
