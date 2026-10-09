// SPDX-License-Identifier: Apache-2.0
use pgcf_edge_rust::{
    decoy::{Decoy, derive_salt},
    policy::{GatewayRegion, actor_failure, connection_rate_key, routing_hints},
};
use pgcf_native_protocol::{
    constant,
    route::{self, Keyring},
};
use serde_json::Value;
use std::collections::HashMap;
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/conformance.generated.json"
    ))
    .unwrap()
}
#[test]
fn authoritative_typescript_ip_and_signing_vectors() {
    let edge = &vectors()["edge"];
    for row in edge["ips"].as_array().unwrap() {
        assert_eq!(
            serde_json::to_value(connection_rate_key(row["ip"].as_str())).unwrap(),
            row["expected"],
            "{row}"
        );
    }
    for row in edge["signing"].as_array().unwrap() {
        let key = row["key"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let active = row["active"].as_str().unwrap().to_string();
        let ring = Keyring {
            active: active.clone(),
            keys: HashMap::from([(active, key)]),
        };
        assert_eq!(
            route::sign(
                &ring,
                row["region"].as_str().unwrap(),
                row["db"].as_str().unwrap(),
                row["user"].as_str().unwrap(),
                row["cid"].as_str().unwrap(),
                row["now"].as_u64().unwrap(),
                row["ttlSeconds"].as_u64().unwrap()
            )
            .unwrap(),
            row["expected"].as_str().unwrap()
        );
    }
    for row in edge["salts"].as_array().unwrap() {
        let key = row["key"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let active = row["active"].as_str().unwrap().to_string();
        let ring = Keyring {
            active: active.clone(),
            keys: HashMap::from([(active, key)]),
        };
        let hints = pgcf_edge_rust::policy::Hints {
            database: row["database"].as_str().unwrap().into(),
            user: row["user"].as_str().unwrap().into(),
        };
        assert_eq!(
            derive_salt(&ring, &hints).unwrap(),
            row["expected"].as_str().unwrap()
        );
    }
}
#[test]
fn hints_are_scoped_before_actor_or_gateway_and_duplicate_errors_take_precedence() {
    let db = "a".repeat(20);
    assert!(routing_hints(&format!("database={db}&user=app&unused=private-canary")).is_ok());
    assert_eq!(
        routing_hints(&format!("database=wrong&database={db}&user=app"))
            .unwrap_err()
            .sqlstate,
        "08P01"
    );
    assert_eq!(
        routing_hints(&format!("database={db}&user=pg_admin"))
            .unwrap_err()
            .sqlstate,
        "28P01"
    );
    assert_eq!(routing_hints("user=app").unwrap_err().sqlstate, "3D000");
    assert!(actor_failure("3D000").decoy);
    assert!(actor_failure("28P01").decoy);
    assert!(!actor_failure("57P03").decoy);
}
#[test]
fn public_gateway_is_https_and_explicit_service_http_has_no_fallback() {
    let mut region = GatewayRegion {
        id: "eu-test".into(),
        gateway_url: "http://gateway.invalid/pg".into(),
        gateway_binding: None,
    };
    assert!(region.transport_url().is_err());
    region.gateway_binding = Some("GATEWAY".into());
    assert!(region.transport_url().is_ok());
    region.gateway_url = "https://user:password@gateway.invalid/pg".into();
    assert!(region.transport_url().is_err());
}
fn packet(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut v = vec![tag];
    v.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    v.extend_from_slice(body);
    v
}
fn startup(database: &str, user: &str) -> Vec<u8> {
    let body = format!("user\0{user}\0database\0{database}\0\0");
    let mut v = ((8 + body.len()) as u32).to_be_bytes().to_vec();
    v.extend_from_slice(&196608u32.to_be_bytes());
    v.extend_from_slice(body.as_bytes());
    v
}
#[test]
fn decoy_parses_fragmented_startup_and_scram_but_cannot_authenticate() {
    let hints = routing_hints(&format!("database={}&user=app", "a".repeat(20))).unwrap();
    let ring = Keyring {
        active: "test".into(),
        keys: HashMap::from([("test".into(), vec![7; 32])]),
    };
    let salt = derive_salt(&ring, &hints).unwrap();
    let mut decoy = Decoy::new(hints.clone(), Some(salt.clone()), [0; 18]);
    let mut replies = Vec::new();
    for byte in startup(&hints.database, &hints.user) {
        replies.extend(decoy.push(&[byte]).frames);
    }
    assert_eq!(replies.len(), 1);
    assert_eq!(&replies[0][5..9], &10u32.to_be_bytes());
    let first = b"n,,n=app,r=client";
    let mut sasl = b"SCRAM-SHA-256\0".to_vec();
    sasl.extend_from_slice(&(first.len() as i32).to_be_bytes());
    sasl.extend_from_slice(first);
    let reply = decoy.push(&packet(b'p', &sasl));
    assert_eq!(reply.frames.len(), 1);
    assert_eq!(&reply.frames[0][5..9], &11u32.to_be_bytes());
    let challenge = std::str::from_utf8(&reply.frames[0][9..]).unwrap();
    assert_eq!(
        challenge,
        format!(
            "r=client{},s={salt},i={}",
            "A".repeat(24),
            constant("DECOY_SCRAM_ITERATIONS")
        )
    );
    let final_message = format!(
        "c=biws,r=client{},p={}={}",
        "A".repeat(24),
        "A".repeat(43),
        ""
    );
    let failure = decoy.push(&packet(b'p', final_message.as_bytes()));
    assert!(failure.close);
    assert_eq!(failure.frames.len(), 1);
    assert_eq!(failure.frames[0][0], b'E');
    assert!(decoy.closed());
    assert_eq!(decoy.retained_bytes(), 0);
}
#[test]
fn decoy_limits_frames_and_declared_bytes_and_cancel_is_silent() {
    let hints = routing_hints(&format!("database={}&user=app", "a".repeat(20))).unwrap();
    let mut decoy = Decoy::new(hints.clone(), None, [0; 18]);
    for _ in 0..constant("DECOY_MAX_FRAMES") {
        assert!(!decoy.push(&[]).close);
    }
    assert!(decoy.push(&[]).close);
    assert_eq!(decoy.retained_bytes(), 0);
    let mut cancel = Decoy::new(hints, None, [0; 18]);
    let mut bytes = 16u32.to_be_bytes().to_vec();
    bytes.extend_from_slice(&80877102u32.to_be_bytes());
    bytes.extend_from_slice(&[0; 8]);
    let out = cancel.push(&bytes);
    assert!(out.close);
    assert!(out.frames.is_empty());
}

fn fresh_decoy() -> (pgcf_edge_rust::policy::Hints, Decoy) {
    let hints = pgcf_edge_rust::policy::Hints {
        database: "a".repeat(20),
        user: "app".into(),
    };
    (
        hints.clone(),
        Decoy::new(hints, Some("c2FsdA==".into()), [1; 18]),
    )
}
fn first_frame(first: &[u8], mechanism: &[u8]) -> Vec<u8> {
    let mut body = mechanism.to_vec();
    body.push(0);
    body.extend_from_slice(&(first.len() as u32).to_be_bytes());
    body.extend_from_slice(first);
    packet(b'p', &body)
}
#[test]
fn decoy_handles_coalesced_encryption_preludes_and_fragmented_authentication() {
    let (hints, mut decoy) = fresh_decoy();
    let mut input = 8u32.to_be_bytes().to_vec();
    input.extend_from_slice(&80877103u32.to_be_bytes());
    input.extend_from_slice(&8u32.to_be_bytes());
    input.extend_from_slice(&80877104u32.to_be_bytes());
    input.extend_from_slice(&startup(&hints.database, &hints.user));
    let reply = decoy.push(&input);
    assert_eq!(reply.frames.len(), 3);
    assert_eq!(reply.frames[0], vec![b'N']);
    assert_eq!(reply.frames[1], vec![b'N']);
    assert_eq!(&reply.frames[2][5..9], &10u32.to_be_bytes());
    let mut frames = Vec::new();
    for byte in first_frame(b"y,,n=app,r=nonce", b"SCRAM-SHA-256") {
        frames.extend(decoy.push(&[byte]).frames);
    }
    assert_eq!(frames.len(), 1);
    assert_eq!(&frames[0][5..9], &11u32.to_be_bytes());
}
#[test]
fn decoy_rejects_startup_hint_mismatch_before_authentication() {
    let (_, mut decoy) = fresh_decoy();
    let output = decoy.push(&startup(&"b".repeat(20), "app"));
    assert!(output.close);
    assert_eq!(output.frames.len(), 1);
    assert!(output.frames[0].windows(6).any(|v| v == b"C28000"));
    assert_eq!(decoy.retained_bytes(), 0);
}
#[test]
fn decoy_rejects_non_password_and_oversized_declared_auth_without_retention() {
    let (hints, mut decoy) = fresh_decoy();
    decoy.push(&startup(&hints.database, &hints.user));
    let mut bytes = vec![b'p'];
    bytes.extend_from_slice(&(constant("DECOY_AUTH_MAX_BYTES") as u32 + 1).to_be_bytes());
    let output = decoy.push(&bytes);
    assert!(output.close);
    assert_eq!(decoy.retained_bytes(), 0);
    let (hints, mut decoy) = fresh_decoy();
    decoy.push(&startup(&hints.database, &hints.user));
    assert!(decoy.push(&packet(b'Q', b"password-canary\0")).close);
    assert_eq!(decoy.retained_bytes(), 0);
}
#[test]
fn decoy_refuses_plus_and_invalid_utf8_instead_of_authenticating() {
    let (hints, mut decoy) = fresh_decoy();
    decoy.push(&startup(&hints.database, &hints.user));
    let output = decoy.push(&first_frame(
        b"p=tls-server-end-point,,n=,r=nonce",
        b"SCRAM-SHA-256-PLUS",
    ));
    assert!(output.close);
    assert_eq!(output.frames[0][0], b'E');
    let (hints, mut decoy) = fresh_decoy();
    decoy.push(&startup(&hints.database, &hints.user));
    assert!(decoy.push(&first_frame(&[0xff], b"SCRAM-SHA-256")).close);
    assert_eq!(decoy.retained_bytes(), 0);
}
#[test]
fn deadline_and_disconnect_clear_partial_startup_and_auth_buffers() {
    let (_, mut partial) = fresh_decoy();
    partial.push(&[0, 0, 0]);
    assert_eq!(partial.retained_bytes(), 3);
    let out = partial.abort();
    assert!(out.close);
    assert!(out.frames.is_empty());
    assert_eq!(partial.retained_bytes(), 0);
    let (hints, mut decoy) = fresh_decoy();
    decoy.push(&startup(&hints.database, &hints.user));
    decoy.push(&[b'p', 0, 0]);
    let out = decoy.deadline();
    assert!(out.close);
    assert_eq!(out.frames[0][0], b'E');
    assert_eq!(decoy.retained_bytes(), 0);
    assert_eq!(decoy.push(&[1, 2, 3]), Default::default());
}
#[test]
fn unknown_route_salt_is_identity_scoped_and_missing_signing_material_never_authenticates() {
    let (hints, _) = fresh_decoy();
    let ring = Keyring {
        active: "test".into(),
        keys: HashMap::from([("test".into(), vec![7; 32])]),
    };
    let first = derive_salt(&ring, &hints).unwrap();
    let mut other = hints.clone();
    other.user = "other".into();
    assert_ne!(first, derive_salt(&ring, &other).unwrap());
    other = hints.clone();
    other.database = "b".repeat(20);
    assert_ne!(first, derive_salt(&ring, &other).unwrap());
    let mut decoy = Decoy::new(hints.clone(), None, [0; 18]);
    let first = decoy.push(&startup(&hints.database, &hints.user));
    assert_eq!(&first.frames[0][5..9], &10u32.to_be_bytes());
    let output = decoy.push(&first_frame(b"n,,n=,r=nonce", b"SCRAM-SHA-256"));
    assert!(output.close);
    assert_eq!(output.frames.len(), 1);
    assert_eq!(output.frames[0][0], b'E');
    assert_eq!(decoy.retained_bytes(), 0);
}
