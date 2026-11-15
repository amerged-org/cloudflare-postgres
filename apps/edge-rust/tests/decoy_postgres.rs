// SPDX-License-Identifier: Apache-2.0
//! The unknown-route decoy answers a client as PostgreSQL does on a Unix socket: the same SASL
//! offer bytes, and the same refusal of a mechanism that is not offered.
use pgcf_edge_rust::{decoy::Decoy, policy::Hints};
use pgcf_test_postgres::Cluster;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::Duration,
};

const ROLE: &str = "postgres";
const SALT: &str = "c2FsdHNhbHRzYWx0c2FsdA==";

fn startup() -> Vec<u8> {
    let body = format!("user\0{ROLE}\0database\0{ROLE}\0\0");
    let mut bytes = ((8 + body.len()) as u32).to_be_bytes().to_vec();
    bytes.extend_from_slice(&196608u32.to_be_bytes());
    bytes.extend_from_slice(body.as_bytes());
    bytes
}
fn sasl_initial(mechanism: &[u8]) -> Vec<u8> {
    let first = b"n,,n=,r=nonce";
    let mut body = mechanism.to_vec();
    body.push(0);
    body.extend_from_slice(&(first.len() as i32).to_be_bytes());
    body.extend_from_slice(first);
    let mut bytes = vec![b'p'];
    bytes.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
    bytes.extend_from_slice(&body);
    bytes
}
/// One whole backend message, tag and length included.
fn read_message(stream: &mut UnixStream) -> Vec<u8> {
    let mut head = [0; 5];
    stream.read_exact(&mut head).unwrap();
    let length = u32::from_be_bytes(head[1..].try_into().unwrap()) as usize;
    let mut bytes = head.to_vec();
    bytes.resize(length + 1, 0);
    stream.read_exact(&mut bytes[5..]).unwrap();
    bytes
}
/// The fields a client compares: severity, SQLSTATE and message.
fn error_fields(frame: &[u8]) -> Vec<(u8, Vec<u8>)> {
    assert_eq!(frame[0], b'E');
    let mut fields = Vec::new();
    let mut at = 5;
    while frame[at] != 0 {
        let end = at + 1 + frame[at + 1..].iter().position(|b| *b == 0).unwrap();
        fields.push((frame[at], frame[at + 1..end].to_vec()));
        at = end + 1;
    }
    fields.retain(|(kind, _)| b"SVCM".contains(kind));
    fields
}
#[test]
fn the_decoy_answers_like_postgres_18_on_a_unix_socket() {
    let Some(bin) = pgcf_test_postgres::binaries() else {
        return;
    };
    let mut cluster = Cluster::init(&bin, "", "local all all scram-sha-256\n");
    cluster.start(&[]);
    let mut stream = UnixStream::connect(cluster.socket()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .unwrap();
    stream.write_all(&startup()).unwrap();
    let offer = read_message(&mut stream);
    let plus = sasl_initial(b"SCRAM-SHA-256-PLUS");
    stream.write_all(&plus).unwrap();
    let refusal = read_message(&mut stream);
    assert!(error_fields(&refusal).contains(&(b'C', b"08P01".to_vec())));

    let mut decoy = Decoy::new(
        Hints {
            database: ROLE.into(),
            user: ROLE.into(),
        },
        Some(SALT.into()),
        [0; 18],
    );
    let started = decoy.push(&startup());
    assert_eq!(started.frames, vec![offer]);
    let refused = decoy.push(&plus);
    assert!(refused.close);
    assert_eq!(refused.frames.len(), 1);
    assert_eq!(error_fields(&refused.frames[0]), error_fields(&refusal));
}
