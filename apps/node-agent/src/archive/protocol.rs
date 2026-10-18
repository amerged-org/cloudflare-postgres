// SPDX-License-Identifier: Apache-2.0
//! The agent's side of the archive socket protocol (`packages/contracts/src/node-local.ts`): the
//! clients `pgcf-archive %p` and `pgcf-wal-fetch %f %p` send one request line from inside the
//! database's sandbox and wait for one answer line. The clients (`apps/pgcf-archive`) own the
//! other side; the generated vectors of the contract decide both.
//!
//! ```text
//! pgcf-archive/1 archive 000000010000000000000003
//! pgcf-archive/1 fetch 000000010000000000000003 pg_wal/RECOVERYXLOG
//! ok | missing | failed [reason]
//! ```
use std::time::Duration;

/// Where the agent serves the archive socket.
pub const SOCKET: &str = "/run/pgcf/agent/archive.sock";
/// The first word of every request.
pub const PROTOCOL: &str = "pgcf-archive/1";
/// The longest request or answer line, newline included.
pub const MAX_LINE_BYTES: usize = 256;
/// How long the agent gives one upload or fetch before it answers `failed`; the clients wait
/// 70 s.
pub const AGENT_BOUND: Duration = Duration::from_secs(60);

fn upper_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F'))
}
/// A whole WAL segment: the only file whose size is the cluster's segment size.
pub fn is_segment(name: &str) -> bool {
    upper_hex(name, 24)
}
/// A file PostgreSQL archives or restores: a WAL segment, a timeline history file, a partial
/// segment or a backup history file.
pub fn valid_name(name: &str) -> bool {
    if let Some(timeline) = name.strip_suffix(".history") {
        return upper_hex(timeline, 8);
    }
    if let Some(segment) = name.strip_suffix(".partial") {
        return upper_hex(segment, 24);
    }
    if let Some(backup) = name.strip_suffix(".backup") {
        return backup
            .split_once('.')
            .is_some_and(|(segment, offset)| upper_hex(segment, 24) && upper_hex(offset, 8));
    }
    is_segment(name)
}
/// Where in the data directory a restored file goes: one file directly in `pg_wal`.
pub fn valid_destination(destination: &str) -> bool {
    destination.strip_prefix("pg_wal/").is_some_and(|file| {
        !file.is_empty()
            && file.len() <= 64
            && !file.starts_with('.')
            && file
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// Upload `pg_wal/<name>` of the caller's database.
    Archive { name: String },
    /// Restore `name` from the archive the caller recovers from to `destination` (below the
    /// data directory).
    Fetch { name: String, destination: String },
}
/// A line that is no request of this protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolError;
impl Request {
    /// A request line without its newline.
    pub fn decode(line: &[u8]) -> Result<Self, ProtocolError> {
        let line = std::str::from_utf8(line).map_err(|_| ProtocolError)?;
        if line.len() >= MAX_LINE_BYTES {
            return Err(ProtocolError);
        }
        match line.split(' ').collect::<Vec<_>>()[..] {
            [PROTOCOL, "archive", name] if valid_name(name) => {
                Ok(Self::Archive { name: name.into() })
            }
            [PROTOCOL, "fetch", name, destination]
                if valid_name(name) && valid_destination(destination) =>
            {
                Ok(Self::Fetch {
                    name: name.into(),
                    destination: destination.into(),
                })
            }
            _ => Err(ProtocolError),
        }
    }
}

/// The agent's answer. A reason is a short lowercase class for PostgreSQL's log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reply {
    /// Archived durably, or restored to the destination.
    Ok,
    /// Not in the archive: only an answer to a fetch, and only when R2 says the object is absent.
    Missing,
    Failed(Option<&'static str>),
}
impl Reply {
    /// The answer line, newline included; a reason outside its class is left out.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Ok => "ok\n".into(),
            Self::Missing => "missing\n".into(),
            Self::Failed(Some(reason))
                if !reason.is_empty()
                    && reason.len() <= 64
                    && reason
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') =>
            {
                format!("failed {reason}\n")
            }
            Self::Failed(_) => "failed\n".into(),
        }
        .into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn contract() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/native/node-local.generated.json"
        ))
        .unwrap()
    }

    #[test]
    fn the_constants_are_the_contracts() {
        let constants = &contract()["constants"];
        assert_eq!(constants["AGENT_ARCHIVE_SOCKET"], SOCKET);
        assert_eq!(constants["ARCHIVE_PROTOCOL"], PROTOCOL);
        assert_eq!(constants["ARCHIVE_MAX_LINE_BYTES"], MAX_LINE_BYTES);
        assert_eq!(
            constants["ARCHIVE_AGENT_BOUND_MS"].as_u64().unwrap(),
            AGENT_BOUND.as_millis() as u64
        );
    }

    #[test]
    fn requests_decode_as_the_contract_vectors_say() {
        let contract = contract();
        for vector in contract["archive"]["requests"].as_array().unwrap() {
            let line = vector["line"].as_str().unwrap();
            let decoded = Request::decode(line.as_bytes());
            if vector["valid"] == true {
                let expected = &vector["request"];
                let name = expected["name"].as_str().unwrap().to_string();
                assert_eq!(
                    decoded,
                    Ok(match expected["type"].as_str().unwrap() {
                        "archive" => Request::Archive { name },
                        _ => Request::Fetch {
                            name,
                            destination: expected["destination"].as_str().unwrap().into()
                        },
                    }),
                    "{line:?}"
                );
            } else {
                assert_eq!(decoded, Err(ProtocolError), "{line:?}");
            }
        }
    }

    #[test]
    fn a_line_of_the_maximum_length_or_with_odd_bytes_is_no_request() {
        let long = format!(
            "{PROTOCOL} fetch 000000010000000000000003 pg_wal/{}",
            "a".repeat(MAX_LINE_BYTES)
        );
        assert_eq!(Request::decode(long.as_bytes()), Err(ProtocolError));
        assert_eq!(
            Request::decode(b"pgcf-archive/1 archive \xff"),
            Err(ProtocolError)
        );
        assert_eq!(
            Request::decode(b"pgcf-archive/1 archive 000000010000000000000003\r"),
            Err(ProtocolError)
        );
    }

    #[test]
    fn replies_encode_as_the_contract_vectors_say() {
        let contract = contract();
        for vector in contract["archive"]["replies"].as_array().unwrap() {
            if vector["valid"] != true {
                continue;
            }
            let line = vector["line"].as_str().unwrap();
            let reply = match (
                vector["reply"]["type"].as_str().unwrap(),
                vector["reply"]["reason"].as_str(),
            ) {
                ("ok", _) => Reply::Ok,
                ("missing", _) => Reply::Missing,
                ("failed", None) => Reply::Failed(None),
                ("failed", Some("upload_timeout")) => Reply::Failed(Some("upload_timeout")),
                other => panic!("{other:?}"),
            };
            assert_eq!(reply.encode(), format!("{line}\n").into_bytes());
        }
        // A reason outside its class is never sent.
        assert_eq!(Reply::Failed(Some("Access Denied\n")).encode(), b"failed\n");
        assert_eq!(Reply::Failed(Some("")).encode(), b"failed\n");
        let format = &contract["archive"]["formats"][2];
        assert_eq!(format["line"], "failed\n");
    }
}
