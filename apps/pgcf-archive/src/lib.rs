// SPDX-License-Identifier: Apache-2.0
//! The node agent's archive socket (plan 7.5 and 7.8). PostgreSQL runs `pgcf-archive %p` as its
//! `archive_command` and `pgcf-wal-fetch %f %p` as its `restore_command`; both connect to the
//! agent's socket from inside the database's sandbox, send one request line and wait for one
//! answer line. The agent knows the database by the uid the kernel reports for the connection,
//! and it reads and writes the WAL itself, as the database's user, in that database's own data
//! directory: a request names only a WAL file and, for a fetch, where in `pg_wal` it goes.
//!
//! `ok` to an archive request means that the agent has the segment durable in R2 and in its
//! upload log; only then does PostgreSQL mark the segment done. Anything else, including no
//! answer within [`CLIENT_BOUND`], is a failure that PostgreSQL retries.
//!
//! The protocol is plain text so that both clients stay small static binaries without
//! dependencies:
//!
//! ```text
//! pgcf-archive/1 archive 000000010000000000000003
//! pgcf-archive/1 fetch 000000010000000000000003 pg_wal/RECOVERYXLOG
//! ok | missing | failed [reason]
//! ```
use std::{
    fmt,
    io::{Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// Where the agent serves the archive socket.
pub const SOCKET: &str = "/run/pgcf/agent/archive.sock";
/// Names another socket, for tests and for a unit that places it elsewhere.
pub const SOCKET_ENVIRONMENT: &str = "PGCF_AGENT_ARCHIVE_SOCKET";
/// The first word of every request.
pub const PROTOCOL: &str = "pgcf-archive/1";
/// The longest request or answer line, newline included.
pub const MAX_LINE_BYTES: usize = 256;
/// How long the agent gives one upload or fetch before it answers `failed`.
pub const AGENT_BOUND: Duration = Duration::from_secs(60);
/// How long a client waits for the answer: the agent's bound and the time its answer takes.
pub const CLIENT_BOUND: Duration = Duration::from_secs(70);
/// How long writing the request may take.
const WRITE_BOUND: Duration = Duration::from_secs(10);

/// The archive socket this process uses.
pub fn socket() -> PathBuf {
    std::env::var_os(SOCKET_ENVIRONMENT)
        .map(PathBuf::from)
        .unwrap_or_else(|| SOCKET.into())
}

fn upper_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
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
    upper_hex(name, 24)
}
/// Where in the data directory a restored file goes: one file directly in `pg_wal`, as
/// PostgreSQL names it (`pg_wal/RECOVERYXLOG`, `pg_wal/RECOVERYHISTORY`).
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

/// One request to the agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    /// Upload `pg_wal/<name>` of the caller's database.
    Archive { name: String },
    /// Restore `name` from the caller's database's archive to `destination` in its data
    /// directory.
    Fetch { name: String, destination: String },
}
impl Request {
    pub fn valid(&self) -> bool {
        match self {
            Self::Archive { name } => valid_name(name),
            Self::Fetch { name, destination } => valid_name(name) && valid_destination(destination),
        }
    }
    /// The request line, newline included.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Archive { name } => format!("{PROTOCOL} archive {name}\n"),
            Self::Fetch { name, destination } => {
                format!("{PROTOCOL} fetch {name} {destination}\n")
            }
        }
        .into_bytes()
    }
    /// A request line without its newline, as the agent reads it.
    pub fn decode(line: &[u8]) -> Result<Self, ProtocolError> {
        let line = std::str::from_utf8(line).map_err(|_| ProtocolError)?;
        if line.len() >= MAX_LINE_BYTES {
            return Err(ProtocolError);
        }
        let request = match line.split(' ').collect::<Vec<_>>()[..] {
            [PROTOCOL, "archive", name] => Self::Archive { name: name.into() },
            [PROTOCOL, "fetch", name, destination] => Self::Fetch {
                name: name.into(),
                destination: destination.into(),
            },
            _ => return Err(ProtocolError),
        };
        request.valid().then_some(request).ok_or(ProtocolError)
    }
}

/// The agent's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    /// Archived durably, or restored to the destination.
    Ok,
    /// Not in the archive: only an answer to a fetch.
    Missing,
    /// Not done; the reason is a short lowercase class for PostgreSQL's log.
    Failed(Option<String>),
}
fn valid_reason(reason: &str) -> bool {
    !reason.is_empty()
        && reason.len() <= 64
        && reason
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
impl Reply {
    /// The answer line, newline included.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Ok => "ok\n".into(),
            Self::Missing => "missing\n".into(),
            Self::Failed(Some(reason)) if valid_reason(reason) => format!("failed {reason}\n"),
            Self::Failed(_) => "failed\n".into(),
        }
        .into_bytes()
    }
    /// An answer line without its newline.
    pub fn decode(line: &[u8]) -> Result<Self, ProtocolError> {
        match std::str::from_utf8(line).map_err(|_| ProtocolError)? {
            "ok" => Ok(Self::Ok),
            "missing" => Ok(Self::Missing),
            "failed" => Ok(Self::Failed(None)),
            other => other
                .strip_prefix("failed ")
                .filter(|reason| valid_reason(reason))
                .map(|reason| Self::Failed(Some(reason.into())))
                .ok_or(ProtocolError),
        }
    }
}

/// A line that is not a request or an answer of this protocol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProtocolError;
impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("invalid archive protocol line")
    }
}

/// Why a client has no answer of the agent. None of them means success.
#[derive(Debug)]
pub enum Failure {
    Unreachable(std::io::Error),
    Io(std::io::Error),
    Closed,
    Timeout,
    Protocol,
}
impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(error) => write!(formatter, "the node agent is unreachable: {error}"),
            Self::Io(error) => write!(formatter, "the node agent connection failed: {error}"),
            Self::Closed => formatter.write_str("the node agent closed the connection unanswered"),
            Self::Timeout => formatter.write_str("the node agent did not answer in time"),
            Self::Protocol => formatter.write_str("the node agent's answer is not valid"),
        }
    }
}

/// Sends `request` to the agent at `socket` and reads its one answer, within `bound`.
pub fn exchange(socket: &Path, request: &Request, bound: Duration) -> Result<Reply, Failure> {
    let deadline = Instant::now() + bound;
    let mut stream = UnixStream::connect(socket).map_err(Failure::Unreachable)?;
    stream
        .set_write_timeout(Some(WRITE_BOUND.min(bound)))
        .map_err(Failure::Io)?;
    stream.set_read_timeout(Some(bound)).map_err(Failure::Io)?;
    stream.write_all(&request.encode()).map_err(Failure::Io)?;
    let mut line = Vec::with_capacity(MAX_LINE_BYTES);
    let mut buffer = [0u8; MAX_LINE_BYTES];
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or(Failure::Timeout)?;
        // Some systems refuse the option once the agent closed its end; the bound set before
        // the request then still applies, and the read returns at once.
        let _ = stream.set_read_timeout(Some(remaining));
        let read = match stream.read(&mut buffer) {
            Ok(0) => return Err(Failure::Closed),
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(Failure::Timeout);
            }
            Err(error) => return Err(Failure::Io(error)),
        };
        line.extend_from_slice(&buffer[..read]);
        if let Some(end) = line.iter().position(|byte| *byte == b'\n') {
            return Reply::decode(&line[..end]).map_err(|_| Failure::Protocol);
        }
        if line.len() >= MAX_LINE_BYTES {
            return Err(Failure::Protocol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    #[test]
    fn names_are_the_wal_files_postgresql_archives_and_nothing_else() {
        for name in [
            "000000010000000000000003",
            "0000000A00000001000000FF",
            "00000002.history",
            "000000010000000000000003.partial",
            "000000010000000000000003.00000028.backup",
        ] {
            assert!(valid_name(name), "{name}");
        }
        for name in [
            "",
            "00000001000000000000000",
            "0000000100000000000000033",
            "000000010000000000000003a",
            "000000010000000000000003.backup",
            "0000000a0000000000000003",
            "../00000002.history",
            "00000002.history.partial",
            "RECOVERYXLOG",
        ] {
            assert!(!valid_name(name), "{name}");
        }
        assert!(valid_destination("pg_wal/RECOVERYXLOG"));
        assert!(valid_destination("pg_wal/RECOVERYHISTORY"));
        for destination in [
            "pg_wal/",
            "pg_wal/../postgresql.conf",
            "pg_wal/a/b",
            "pg_wal/.hidden",
            "/pg_wal/RECOVERYXLOG",
            "base/1/1259",
            "pg_wal/RECOVERY XLOG",
        ] {
            assert!(!valid_destination(destination), "{destination}");
        }
    }
    #[test]
    fn requests_and_answers_are_single_lines() {
        let archive = Request::Archive {
            name: "000000010000000000000003".into(),
        };
        assert_eq!(
            archive.encode(),
            b"pgcf-archive/1 archive 000000010000000000000003\n"
        );
        let fetch = Request::Fetch {
            name: "00000002.history".into(),
            destination: "pg_wal/RECOVERYHISTORY".into(),
        };
        for request in [&archive, &fetch] {
            let line = request.encode();
            assert_eq!(&Request::decode(&line[..line.len() - 1]).unwrap(), request);
        }
        for line in [
            b"pgcf-archive/1 archive 000000010000000000000003 extra".as_slice(),
            b"pgcf-archive/2 archive 000000010000000000000003",
            b"pgcf-archive/1 archive  000000010000000000000003",
            b"pgcf-archive/1 fetch 000000010000000000000003 base/1",
            b"pgcf-archive/1 delete 000000010000000000000003",
        ] {
            assert_eq!(Request::decode(line), Err(ProtocolError));
        }
        for reply in [
            Reply::Ok,
            Reply::Missing,
            Reply::Failed(None),
            Reply::Failed(Some("upload_timeout".into())),
        ] {
            let line = reply.encode();
            assert_eq!(Reply::decode(&line[..line.len() - 1]).unwrap(), reply);
        }
        // A reason outside its class is never sent.
        assert_eq!(
            Reply::Failed(Some("Access Denied\n".into())).encode(),
            b"failed\n"
        );
        assert!(Reply::decode(b"OK").is_err());
        assert!(Reply::decode(b"failed ").is_err());
    }
    #[test]
    fn only_a_complete_answer_of_the_agent_counts() {
        let directory =
            std::env::temp_dir().join(format!("pgcf-archive-unit-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let socket = directory.join("a.sock");
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        let request = Request::Archive {
            name: "000000010000000000000003".into(),
        };
        let answers: [&[u8]; 5] = [b"ok\n", b"ok", b"", b"OK\n", b"failed upload\n"];
        let server = std::thread::spawn(move || {
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = [0u8; 48];
                stream.read_exact(&mut line).unwrap();
                assert_eq!(&line, b"pgcf-archive/1 archive 000000010000000000000003\n");
                stream.write_all(answer).unwrap();
            }
            // The last client waits for an answer that never comes.
            let (stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(500));
            drop(stream);
        });
        let bound = Duration::from_secs(10);
        assert_eq!(exchange(&socket, &request, bound).unwrap(), Reply::Ok);
        assert!(matches!(
            exchange(&socket, &request, bound),
            Err(Failure::Closed)
        ));
        assert!(matches!(
            exchange(&socket, &request, bound),
            Err(Failure::Closed)
        ));
        assert!(matches!(
            exchange(&socket, &request, bound),
            Err(Failure::Protocol)
        ));
        assert_eq!(
            exchange(&socket, &request, bound).unwrap(),
            Reply::Failed(Some("upload".into()))
        );
        assert!(matches!(
            exchange(&socket, &request, Duration::from_millis(100)),
            Err(Failure::Timeout)
        ));
        server.join().unwrap();
        std::fs::remove_dir_all(&directory).unwrap();
        assert!(matches!(
            exchange(&socket, &request, bound),
            Err(Failure::Unreachable(_))
        ));
    }
}
