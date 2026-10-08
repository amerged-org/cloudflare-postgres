use pgcf_node_runtime::protocol::{self, Assignment, NamespaceIdentity, ProtocolError};

fn assignment() -> Assignment<'static> {
    Assignment {
        slot_id: [7; 16],
        network: NamespaceIdentity {
            device: 4,
            inode: 123,
        },
        hostname: "pgcf-postgres-1",
    }
}

#[test]
fn binds_message_to_slot_and_actual_namespace_identity() {
    let a = assignment();
    assert_eq!(
        protocol::decode(&protocol::encode(&a).unwrap(), &a.slot_id).unwrap(),
        a
    );
    assert_eq!(
        protocol::decode(&protocol::encode(&a).unwrap(), &[8; 16]),
        Err(ProtocolError::Slot)
    );
}

#[test]
fn rejects_unknown_version_and_trailing_or_truncated_bytes() {
    let a = assignment();
    let wire = protocol::encode(&a).unwrap();
    for end in 0..wire.len() {
        assert!(protocol::decode(&wire[..end], &a.slot_id).is_err());
    }
    let mut extra = wire.clone();
    extra.push(0);
    assert_eq!(
        protocol::decode(&extra, &a.slot_id),
        Err(ProtocolError::Length)
    );
    let mut future = wire;
    future[9] = 2;
    assert_eq!(
        protocol::decode(&future, &a.slot_id),
        Err(ProtocolError::Version)
    );
}

#[test]
fn rejects_hostnames_that_could_select_paths_or_commands() {
    for hostname in [
        "",
        "-db",
        "db-",
        "DB",
        "db.example",
        "/proc/1/ns/net",
        "db\n",
        "db;id",
        "é",
    ] {
        let a = Assignment {
            hostname,
            ..assignment()
        };
        assert!(protocol::encode(&a).is_err(), "{hostname:?}");
    }
    let long = "a".repeat(64);
    assert!(
        protocol::encode(&Assignment {
            hostname: &long,
            ..assignment()
        })
        .is_err()
    );
}

#[test]
fn rejects_null_namespace_or_slot() {
    assert_eq!(
        protocol::encode(&Assignment {
            network: NamespaceIdentity {
                device: 4,
                inode: 0
            },
            ..assignment()
        }),
        Err(ProtocolError::Namespace)
    );
    assert_eq!(
        protocol::encode(&Assignment {
            slot_id: [0; 16],
            ..assignment()
        }),
        Err(ProtocolError::Slot)
    );
}

#[test]
fn parses_complete_nonzero_slot_identifier() {
    assert_eq!(
        protocol::parse_slot_id("07070707070707070707070707070707").unwrap(),
        [7; 16]
    );
    for bad in [
        "",
        "7",
        "00000000000000000000000000000000",
        "gg07070707070707070707070707070707",
        "é07070707070707070707070707070707",
    ] {
        assert!(protocol::parse_slot_id(bad).is_err());
    }
}

#[test]
fn signed_integer_components_are_not_hex_slot_identifiers() {
    assert_eq!(
        protocol::parse_slot_id(&"+f".repeat(16)),
        Err(ProtocolError::Slot)
    );
}
