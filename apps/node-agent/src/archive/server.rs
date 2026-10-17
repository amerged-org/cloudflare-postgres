// SPDX-License-Identifier: Apache-2.0
//! The archive socket (plan 7.5, 7.8). PostgreSQL's `archive_command` and `restore_command` reach
//! it from inside the database's sandbox. The agent knows the caller by the uid the kernel reports
//! for the connection, runs barman-cloud as that database's user, and answers `ok` to an archive
//! request only when the object is durably in R2 and the segment is in the fsynced upload log.
//! Anything else is `failed`, and PostgreSQL retries. The agent never deletes in R2.
use super::{
    job::{Busy, Database, Exit, Job, Jobs, Outcome, Store},
    protocol::{AGENT_BOUND, MAX_LINE_BYTES, Reply, Request},
    upload_log::UploadLog,
};
use crate::credentials::{Credential, Credentials};
use serde_json::json;
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    time::Instant,
};

/// How long a client may take to send its line.
const READ_BOUND: Duration = Duration::from_secs(10);
/// How much of a failed job's stderr goes to the log.
const LOGGED_STDERR: usize = 400;

/// Where a recovering database's `restore_command` reads from.
#[derive(Clone, Debug)]
pub struct Recovery {
    /// The archive the recovery replays, read-only.
    pub source: Store,
    /// The operation's own spool directory (`recovery::spool_directory`).
    pub spool: PathBuf,
    /// A move target: the last segment of the source's proven-sleep record. The archive must
    /// hold every segment of its timeline through this one, so none of them is ever `missing`:
    /// a recovery that stopped short of it would lose committed transactions.
    pub required_through: Option<String>,
}
impl Recovery {
    fn requires(&self, name: &str) -> bool {
        self.required_through.as_deref().is_some_and(|last| {
            name.len() == 24
                && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'F'))
                && name[..8] == last[..8]
                && name <= last
        })
    }
}

/// What the agent knows of one database for its archive calls.
#[derive(Clone, Debug)]
pub struct Registration {
    pub database: Database,
    /// The uid the kernel reports for the database's processes.
    pub uid: u32,
    /// The database's own archive.
    pub store: Store,
    pub recovery: Option<Recovery>,
    pub upload_log: UploadLog,
}

struct Entry {
    registration: Registration,
    /// When the current run of failed archive calls began (Unix milliseconds).
    failing_since_ms: Mutex<Option<i64>>,
}
/// The registered databases by uid; the agent keeps it as the desired page says.
#[derive(Default)]
pub struct Table {
    entries: RwLock<HashMap<u32, Arc<Entry>>>,
}
impl Table {
    /// Registers a database, replacing an earlier registration of the same uid.
    pub fn set(&self, registration: Registration) {
        let entry = Arc::new(Entry {
            registration,
            failing_since_ms: Mutex::new(None),
        });
        self.entries
            .write()
            .expect("table lock")
            .insert(entry.registration.uid, entry);
    }
    pub fn remove(&self, uid: u32) {
        self.entries.write().expect("table lock").remove(&uid);
    }
    fn get(&self, uid: u32) -> Option<Arc<Entry>> {
        self.entries.read().expect("table lock").get(&uid).cloned()
    }
    /// Since when the archive calls of `database` fail, if they do.
    pub fn failing_since_ms(&self, database: &str) -> Option<i64> {
        self.entries
            .read()
            .expect("table lock")
            .values()
            .find(|entry| entry.registration.database.id == database)
            .and_then(|entry| *entry.failing_since_ms.lock().expect("failure lock"))
    }
}

pub struct Server {
    table: Arc<Table>,
    jobs: Arc<Jobs>,
    credentials: Arc<Credentials>,
    bound: Duration,
}

/// Binds the archive socket, replacing the socket of an agent that is gone. Any local user may
/// connect: the kernel's report of the caller's uid decides what a connection may do.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_socket() => std::fs::remove_file(path)?,
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "the archive socket path holds a file that is no socket",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    Ok(listener)
}

impl Server {
    pub fn new(table: Arc<Table>, jobs: Arc<Jobs>, credentials: Arc<Credentials>) -> Self {
        Self {
            table,
            jobs,
            credentials,
            bound: AGENT_BOUND,
        }
    }
    /// How long one call may take before the agent answers `failed`.
    pub fn with_bound(self, bound: Duration) -> Self {
        Self { bound, ..self }
    }
    /// Serves connections for ever.
    pub async fn serve(self: Arc<Self>, listener: UnixListener) -> std::convert::Infallible {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let server = self.clone();
                    tokio::spawn(async move { server.handle(stream).await });
                }
                // A full descriptor table or an aborted connection passes.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    async fn handle(&self, mut stream: UnixStream) {
        let reply = match (stream.peer_cred(), read_line(&mut stream).await) {
            (Ok(peer), Some(line)) => self.answer(peer.uid(), &line).await,
            (Err(_), _) => Reply::Failed(Some("peer_unknown")),
            (_, None) => Reply::Failed(Some("bad_request")),
        };
        let _ = tokio::time::timeout(READ_BOUND, async {
            stream.write_all(&reply.encode()).await?;
            stream.shutdown().await
        })
        .await;
    }
    async fn answer(&self, uid: u32, line: &[u8]) -> Reply {
        let deadline = Instant::now() + self.bound;
        let Some(entry) = self.table.get(uid) else {
            return Reply::Failed(Some("unknown_database"));
        };
        match Request::decode(line) {
            Ok(Request::Archive { name }) => self.archive(&entry, &name, deadline).await,
            Ok(Request::Fetch { name, destination }) => {
                self.fetch(&entry, &name, &destination, deadline).await
            }
            Err(_) => Reply::Failed(Some("bad_request")),
        }
    }
    /// `ok` once barman has exited 0, which is after R2 holds the object, and the upload log holds
    /// the segment on disk.
    async fn archive(&self, entry: &Entry, name: &str, deadline: Instant) -> Reply {
        let registration = &entry.registration;
        let credential = match self
            .credentials
            .get(&registration.store.scope, unix_seconds())
        {
            Ok(credential) => credential,
            Err(reason) => return entry.failed(reason),
        };
        let job = Job::wal_archive(
            &registration.store,
            &registration.database,
            name,
            self.bound,
        );
        let outcome = match self
            .jobs
            .run(&registration.database, &job, &credential, Some(deadline))
            .await
        {
            Ok(outcome) => outcome,
            // Waiting for a slot is no fault of R2.
            Err(Busy) => return Reply::Failed(Some("agent_busy")),
        };
        if !outcome.succeeded() {
            log("archive_failed", registration, name, &outcome, &credential);
            return entry.failed(if outcome.exit == Exit::TimedOut {
                "upload_timeout"
            } else {
                "upload_failed"
            });
        }
        if registration.upload_log.append(name).await.is_err() {
            log(
                "archive_log_failed",
                registration,
                name,
                &outcome,
                &credential,
            );
            return entry.failed("upload_log_failed");
        }
        *entry.failing_since_ms.lock().expect("failure lock") = None;
        Reply::Ok
    }
    /// `ok` once the file is at `destination`; `missing` only when barman says the object is not
    /// in the archive, and no segment the recovery requires is absent.
    async fn fetch(
        &self,
        entry: &Entry,
        name: &str,
        destination: &str,
        deadline: Instant,
    ) -> Reply {
        let registration = &entry.registration;
        let Some(recovery) = &registration.recovery else {
            return Reply::Failed(Some("not_recovering"));
        };
        let credential = match self.credentials.get(&recovery.source.scope, unix_seconds()) {
            Ok(credential) => credential,
            Err(reason) => return Reply::Failed(Some(reason)),
        };
        let target = registration.database.data_directory().join(destination);
        let job = Job::wal_fetch(&recovery.source, &recovery.spool, name, &target, self.bound);
        let outcome = match self
            .jobs
            .run(&registration.database, &job, &credential, Some(deadline))
            .await
        {
            Ok(outcome) => outcome,
            Err(Busy) => return Reply::Failed(Some("agent_busy")),
        };
        if outcome.succeeded() && target.is_file() {
            return Reply::Ok;
        }
        // barman 3.20 exits 1 with "does not exist" for an object R2 reports absent; every other
        // failure (an expired credential, a refused or lost connection) has another status.
        if outcome.exit == Exit::Code(1) && outcome.stderr.contains("does not exist") {
            return if recovery.requires(name) {
                Reply::Failed(Some("segment_missing"))
            } else {
                Reply::Missing
            };
        }
        log("fetch_failed", registration, name, &outcome, &credential);
        Reply::Failed(Some(if outcome.exit == Exit::TimedOut {
            "fetch_timeout"
        } else {
            "fetch_failed"
        }))
    }
}

impl Entry {
    fn failed(&self, reason: &'static str) -> Reply {
        self.failing_since_ms
            .lock()
            .expect("failure lock")
            .get_or_insert_with(|| unix_seconds() as i64 * 1000);
        Reply::Failed(Some(reason))
    }
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// One request line, without its newline; `None` for a client that is too slow, closes early or
/// sends more than a request can be.
async fn read_line(stream: &mut UnixStream) -> Option<Vec<u8>> {
    let read = async {
        let mut line = Vec::new();
        let mut chunk = [0u8; 64];
        loop {
            let read = stream
                .read(&mut chunk)
                .await
                .ok()
                .filter(|read| *read > 0)?;
            line.extend_from_slice(&chunk[..read]);
            if let Some(end) = line.iter().position(|byte| *byte == b'\n') {
                line.truncate(end);
                return Some(line);
            }
            if line.len() >= MAX_LINE_BYTES {
                // Read what is already sent, so that the answer is not lost to a reset.
                while stream.try_read(&mut chunk).is_ok_and(|read| read > 0) {}
                return None;
            }
        }
    };
    tokio::time::timeout(READ_BOUND, read).await.ok().flatten()
}

/// A line of the agent's log about a failed job. The command's stderr is cut short and holds no
/// part of the credential.
fn log(
    event: &str,
    registration: &Registration,
    name: &str,
    outcome: &Outcome,
    credential: &Credential,
) {
    let stderr = credential.scrub(&outcome.stderr);
    let start = stderr.len().saturating_sub(LOGGED_STDERR);
    let start = (start..=stderr.len())
        .find(|at| stderr.is_char_boundary(*at))
        .unwrap_or(stderr.len());
    crate::timing::emit_event(json!({
        "event": event,
        "database_id": registration.database.id,
        "file": name,
        "exit": format!("{:?}", outcome.exit),
        "elapsed_ms": outcome.elapsed.as_millis() as u64,
        "stderr": &stderr[start..],
        "at_ms": unix_seconds() * 1000,
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        archive::test_support::{
            ARCHIVE, Node, SEGMENT, SOURCE, credential, directory, now, store,
        },
        credentials::{Access, Credential},
    };

    #[tokio::test]
    async fn ok_comes_only_after_the_object_is_in_the_bucket_and_the_segment_in_the_log() {
        let node = Node::start("durable", AGENT_BOUND).await;
        node.fixture.set("delay", "0.4");
        let object = node.fixture.object(ARCHIVE, SEGMENT);
        // While the upload runs, nothing is answered, and nothing is in the log.
        let asking = node.archive(SEGMENT);
        let watching = async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            (object.exists(), node.log().contains(SEGMENT).unwrap())
        };
        let started = std::time::Instant::now();
        let (answer, during) = tokio::join!(asking, watching);
        assert_eq!(answer, "ok\n");
        assert_eq!(during, (false, false));
        assert!(started.elapsed() >= Duration::from_millis(400));
        // At the answer, both are there: the object whole, the log entry fsynced.
        assert!(std::fs::metadata(&object).unwrap().len() > 0);
        assert_eq!(node.log().entries().unwrap(), [SEGMENT]);
        assert_eq!(node.fixture.key_id().as_deref(), Some("fixturekeyid"));
        assert_eq!(node.table.failing_since_ms("abcdefghijklmnopqrst"), None);
    }

    #[tokio::test]
    async fn a_failed_upload_is_failed_leaves_no_log_entry_and_is_remembered_until_it_works() {
        let node = Node::start("failed", AGENT_BOUND).await;
        node.fixture.set("fail", "");
        assert_eq!(node.archive(SEGMENT).await, "failed upload_failed\n");
        assert!(node.log().entries().unwrap().is_empty());
        assert!(!node.fixture.object(ARCHIVE, SEGMENT).exists());
        let since = node.table.failing_since_ms("abcdefghijklmnopqrst").unwrap();
        assert!((since - now() as i64 * 1000).abs() < 5_000);
        // The second failure does not move the start of the run.
        assert_eq!(node.archive(SEGMENT).await, "failed upload_failed\n");
        assert_eq!(
            node.table.failing_since_ms("abcdefghijklmnopqrst"),
            Some(since)
        );
        node.fixture.clear("fail");
        assert_eq!(node.archive(SEGMENT).await, "ok\n");
        assert_eq!(node.table.failing_since_ms("abcdefghijklmnopqrst"), None);
        assert_eq!(node.log().entries().unwrap(), [SEGMENT]);
    }

    #[tokio::test]
    async fn an_upload_over_the_bound_is_failed_and_never_logged() {
        let node = Node::start("bound", Duration::from_millis(300)).await;
        node.fixture.set("delay", "1");
        assert_eq!(node.archive(SEGMENT).await, "failed upload_timeout\n");
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert!(!node.fixture.object(ARCHIVE, SEGMENT).exists());
        assert!(node.log().entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn more_uploads_than_slots_that_cannot_finish_in_time_are_all_failed_and_none_logged() {
        let node = Node::start("busy", Duration::from_millis(300)).await;
        node.fixture.set("delay", "0.8");
        // Two uploads fill the WAL slots and run out of time; the third waits and does too.
        let calls = futures_util::future::join_all((0..3).map(|_| node.archive(SEGMENT))).await;
        for answer in &calls {
            assert!(
                answer == "failed upload_timeout\n" || answer == "failed agent_busy\n",
                "{answer:?}"
            );
        }
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert!(node.log().entries().unwrap().is_empty());
        assert!(!node.fixture.object(ARCHIVE, SEGMENT).exists());
    }

    #[tokio::test]
    async fn callers_the_agent_does_not_know_and_lines_it_does_not_understand_get_failed() {
        let node = Node::start("callers", AGENT_BOUND).await;
        assert_eq!(
            node.ask("pgcf-archive/1 delete 000000010000000000000001\n")
                .await,
            "failed bad_request\n"
        );
        assert_eq!(
            node.ask("pgcf-archive/1 archive ../../etc/passwd\n").await,
            "failed bad_request\n"
        );
        let long = format!("pgcf-archive/1 archive {}\n", "0".repeat(300));
        assert_eq!(node.ask(&long).await, "failed bad_request\n");
        node.table.remove(node.uid);
        assert_eq!(node.archive(SEGMENT).await, "failed unknown_database\n");
        assert_eq!(node.fixture.key_id(), None);
    }

    #[tokio::test]
    async fn an_expired_credential_fails_at_once_and_starts_no_job() {
        let node = Node::start("expired", AGENT_BOUND).await;
        let expired =
            Credential::delivered("fixturekeyid", "fixturesecret", "fixturetoken", 1, 2).unwrap();
        node.credentials
            .hold(store(ARCHIVE, Access::ReadWrite).scope, expired);
        assert_eq!(node.archive(SEGMENT).await, "failed credential_expired\n");
        assert_eq!(node.fixture.key_id(), None);
        assert!(
            node.table
                .failing_since_ms("abcdefghijklmnopqrst")
                .is_some()
        );
        // Renewal repairs it without a restart.
        node.credentials
            .hold(store(ARCHIVE, Access::ReadWrite).scope, credential());
        assert_eq!(node.archive(SEGMENT).await, "ok\n");
    }

    #[tokio::test]
    async fn a_fetch_places_the_file_where_postgresql_asked_and_says_missing_only_for_an_absent_object()
     {
        let node = Node::start("fetch", AGENT_BOUND).await;
        // A database that is not recovering has no archive to read from.
        assert_eq!(node.fetch(SEGMENT).await, "failed not_recovering\n");
        node.register(Some(node.recovery(None)));
        node.fixture
            .put_object(SOURCE, SEGMENT, b"wal bytes of the source");
        assert_eq!(node.fetch(SEGMENT).await, "ok\n");
        assert_eq!(
            std::fs::read(node.volume().join("data/pg_wal/RECOVERYXLOG")).unwrap(),
            b"wal bytes of the source"
        );
        // The fetch reads the source with its own spool, in this operation's directory.
        assert_eq!(
            node.fixture.spool_directories(),
            [node
                .volume()
                .join("spool-op_cccccccccccccccccccc")
                .display()
                .to_string()]
        );
        assert_eq!(node.fetch("000000010000000000000002").await, "missing\n");
        // A broken archive is no end of WAL: the recovery must fail, not stop early.
        node.fixture.set("fetch-fail", "");
        assert_eq!(node.fetch(SEGMENT).await, "failed fetch_failed\n");
        assert_eq!(
            node.fetch("000000010000000000000002").await,
            "failed fetch_failed\n"
        );
    }

    #[tokio::test]
    async fn a_move_target_is_never_told_the_archive_ends_before_the_sources_last_segment() {
        let node = Node::start("move", AGENT_BOUND).await;
        node.register(Some(node.recovery(Some("000000020000000000000005"))));
        // Absent segments of the source's last timeline, up to its last archived segment.
        for name in ["000000020000000000000003", "000000020000000000000005"] {
            assert_eq!(node.fetch(name).await, "failed segment_missing\n", "{name}");
        }
        // Beyond it, and in other files, absence is where the archive ends.
        for name in [
            "000000020000000000000006",
            "000000020000000000000005.partial",
            "00000003.history",
            "000000030000000000000001",
        ] {
            assert_eq!(node.fetch(name).await, "missing\n", "{name}");
        }
    }

    #[test]
    fn the_required_segments_are_those_of_the_last_timeline_through_the_last_archived() {
        let node_recovery = |through: Option<&str>| Recovery {
            source: store(SOURCE, Access::ReadOnly),
            spool: PathBuf::from("/spool"),
            required_through: through.map(Into::into),
        };
        let recovery = node_recovery(Some("000000020000000000000005"));
        assert!(recovery.requires("000000020000000000000001"));
        assert!(recovery.requires("000000020000000000000005"));
        assert!(!recovery.requires("000000020000000000000006"));
        assert!(!recovery.requires("000000010000000000000009"));
        assert!(!recovery.requires("000000020000000000000005.partial"));
        assert!(!recovery.requires("00000002.history"));
        assert!(!node_recovery(None).requires("000000020000000000000001"));
    }

    #[test]
    fn the_socket_is_replaced_on_start_and_open_to_every_local_user() {
        use std::os::unix::fs::PermissionsExt;
        let directory = directory("bind");
        let path = directory.join("agent/archive.sock");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _guard = runtime.enter();
        let first = bind(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o666
        );
        drop(first);
        // The file of a gone agent is replaced.
        let _second = bind(&path).unwrap();
        // A file that is no socket is not.
        let regular = directory.join("regular");
        std::fs::write(&regular, b"x").unwrap();
        assert!(bind(&regular).is_err());
    }
}
