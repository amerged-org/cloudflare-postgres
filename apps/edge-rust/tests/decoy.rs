// SPDX-License-Identifier: Apache-2.0
//! The decoy's answer to a password pipelined behind the startup, byte for byte the gateway's.
use pgcf_edge_rust::{decoy::Decoy, policy::Hints};
use pgcf_native_protocol::startup::error_response;

/// AuthenticationCleartextPassword.
const CLEARTEXT_REQUEST: [u8; 9] = [b'R', 0, 0, 0, 8, 0, 0, 0, 3];
fn hints() -> Hints {
    Hints {
        database: "a".repeat(20),
        user: "app".into(),
    }
}
fn decoy() -> Decoy {
    Decoy::new(hints(), Some("c2FsdHNhbHRzYWx0c2FsdA==".into()), [0; 18])
}
fn packet(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut bytes = vec![tag];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(body);
    bytes
}
fn startup() -> Vec<u8> {
    let body = format!("user\0app\0database\0{}\0\0", "a".repeat(20));
    let mut bytes = ((8 + body.len()) as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(&196608u32.to_be_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes
}
fn refusal() -> Vec<Vec<u8>> {
    vec![
        CLEARTEXT_REQUEST.to_vec(),
        error_response("28P01", "password authentication failed"),
    ]
}
#[test]
fn a_password_pipelined_behind_the_startup_is_asked_for_and_refused_as_the_gateway_refuses_it() {
    for password in [b"secret\0".as_slice(), b"\0"] {
        let mut decoy = decoy();
        let out = decoy.push(
            &[
                startup(),
                packet(b'p', password),
                packet(b'Q', b"select 1\0"),
            ]
            .concat(),
        );
        assert_eq!(out.frames, refusal());
        assert!(out.close);
        assert_eq!(decoy.retained_bytes(), 0);
    }
}
#[test]
fn a_pipelined_password_split_across_messages_is_asked_for_once_it_is_whole() {
    let mut decoy = decoy();
    let password = packet(b'p', b"secret\0");
    let out = decoy.push(&[startup(), password[..3].to_vec()].concat());
    assert!(out.frames.is_empty());
    assert!(!out.close);
    let out = decoy.push(&password[3..]);
    assert_eq!(out.frames, refusal());
    assert!(out.close);
}
#[test]
fn an_oversized_pipelined_password_is_refused_after_the_cleartext_request() {
    let mut decoy = decoy();
    let mut oversized = packet(b'p', &[b'x'; 4097]);
    oversized.truncate(64);
    let out = decoy.push(&[startup(), oversized].concat());
    assert_eq!(out.frames, refusal());
    assert!(out.close);
}
#[test]
fn a_pipelined_message_that_is_not_a_password_gets_the_scram_offer() {
    let mut decoy = decoy();
    let out = decoy.push(&[startup(), packet(b'p', b"a\0b\0")].concat());
    assert_eq!(&out.frames[0][5..9], &10u32.to_be_bytes());
}
