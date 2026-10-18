// SPDX-License-Identifier: Apache-2.0
//! The archive socket's lines against the vectors of its TypeScript contract
//! (`packages/contracts/src/node-local.ts`): the constants are the contract's, every request and
//! answer line is decided as the contract decides it, and the lines the clients write are the
//! contract's bytes. The agent's side is held to the same vectors in `apps/node-agent`.
use pgcf_archive::{
    AGENT_BOUND, CLIENT_BOUND, MAX_LINE_BYTES, PROTOCOL, Reply, Request, SOCKET,
    SOCKET_ENVIRONMENT, valid_destination, valid_name,
};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/node-local.generated.json"
    ))
    .unwrap()
}

#[test]
fn the_constants_are_the_contracts() {
    let vectors = vectors();
    let constants = &vectors["constants"];
    assert_eq!(constants["AGENT_ARCHIVE_SOCKET"], SOCKET);
    assert_eq!(constants["ARCHIVE_SOCKET_ENVIRONMENT"], SOCKET_ENVIRONMENT);
    assert_eq!(constants["ARCHIVE_PROTOCOL"], PROTOCOL);
    assert_eq!(constants["ARCHIVE_MAX_LINE_BYTES"], MAX_LINE_BYTES);
    assert_eq!(
        constants["ARCHIVE_AGENT_BOUND_MS"],
        AGENT_BOUND.as_millis() as u64
    );
    assert_eq!(
        constants["ARCHIVE_CLIENT_BOUND_MS"],
        CLIENT_BOUND.as_millis() as u64
    );
}

#[test]
fn every_request_line_is_decided_as_the_contract_decides_it() {
    let vectors = vectors();
    let requests = vectors["archive"]["requests"].as_array().unwrap();
    assert!(!requests.is_empty());
    for vector in requests {
        let line = vector["line"].as_str().unwrap();
        let decoded = Request::decode(line.as_bytes());
        assert_eq!(decoded.is_ok(), vector["valid"] == true, "{line:?}");
        let Ok(request) = decoded else { continue };
        let expected = &vector["request"];
        match &request {
            Request::Archive { name } => {
                assert_eq!(expected["type"], "archive", "{line:?}");
                assert_eq!(expected["name"], name.as_str(), "{line:?}");
                assert!(valid_name(name));
            }
            Request::Fetch { name, destination } => {
                assert_eq!(expected["type"], "fetch", "{line:?}");
                assert_eq!(expected["name"], name.as_str(), "{line:?}");
                assert_eq!(expected["destination"], destination.as_str(), "{line:?}");
                assert!(valid_name(name) && valid_destination(destination));
            }
        }
        // The client writes the very line the contract formats.
        assert_eq!(
            String::from_utf8(request.encode()).unwrap(),
            format!("{line}\n")
        );
    }
}

#[test]
fn every_answer_line_is_decided_and_formatted_as_the_contract_does() {
    let vectors = vectors();
    let replies = vectors["archive"]["replies"].as_array().unwrap();
    assert!(!replies.is_empty());
    for vector in replies {
        let line = vector["line"].as_str().unwrap();
        let decoded = Reply::decode(line.as_bytes());
        assert_eq!(decoded.is_ok(), vector["valid"] == true, "{line:?}");
        let Ok(reply) = decoded else { continue };
        let expected = &vector["reply"];
        match reply {
            Reply::Ok => assert_eq!(expected["type"], "ok"),
            Reply::Missing => assert_eq!(expected["type"], "missing"),
            Reply::Failed(reason) => {
                assert_eq!(expected["type"], "failed");
                assert_eq!(
                    expected.get("reason").and_then(Value::as_str),
                    reason.as_deref()
                );
            }
        }
    }
    let formats = vectors["archive"]["formats"].as_array().unwrap();
    assert!(!formats.is_empty());
    for vector in formats {
        let reply = &vector["reply"];
        let built = match reply["type"].as_str().unwrap() {
            "ok" => Reply::Ok,
            "missing" => Reply::Missing,
            _ => Reply::Failed(
                reply
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(String::from),
            ),
        };
        assert_eq!(
            String::from_utf8(built.encode()).unwrap(),
            vector["line"].as_str().unwrap(),
            "{reply}"
        );
    }
}
