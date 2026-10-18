// SPDX-License-Identifier: Apache-2.0
//! The archive socket (plan 7.5, 7.8). PostgreSQL's `archive_command` and `restore_command` reach
//! it from inside the database's sandbox. The agent knows the caller by the uid the kernel reports
//! for the connection, runs barman-cloud as that database's user, and answers `ok` to an archive
//! request only when the object is durably in R2 and the segment is in the fsynced upload log.
//! Anything else is `failed`, and PostgreSQL retries. The agent never deletes in R2.
use super::{
    job::{Busy, Database, Exit, Job, Jobs, Outcome, Store, WAL_PREFETCH},
    protocol::{AGENT_BOUND, MAX_LINE_BYTES, Reply, Request, is_segment},
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
    /// The size of a WAL segment of the archive's cluster (`xlog_segment_size` of the backup).
    /// barman's prefetch threads swallow their failures and leave a cut-off file in the spool,
    /// which a later call delivers with exit 0: a segment of another size is never answered `ok`,
    /// since PostgreSQL stops with FATAL on it.
    pub segment_bytes: u64,
}
impl Recovery {
    fn requires(&self, name: &str) -> bool {
        self.required_through
            .as_deref()
            .is_some_and(|last| is_segment(name) && name[..8] == last[..8] && name <= last)
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
    /// Held for the length of a call: a database has one at a time (plan 7.5 step 6). PostgreSQL's
    /// archiver and recovery ask one after the other, so a second call is a client that gave up
    /// on the first, or a process of the database's uid that wants the node's slots.
    serial: tokio::sync::Mutex<()>,
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
            serial: tokio::sync::Mutex::new(()),
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
        let Ok(request) = Request::decode(line) else {
            return Reply::Failed(Some("bad_request"));
        };
        // Not waited for: a waiting call would hold a connection for as long, and PostgreSQL asks
        // again.
        let Ok(_call) = entry.serial.try_lock() else {
            return Reply::Failed(Some("agent_busy"));
        };
        match request {
            Request::Archive { name } => self.archive(&entry, &name, deadline).await,
            Request::Fetch { name, destination } => {
                self.fetch(&entry, &name, &destination, deadline).await
            }
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
            log_failed_job(
                "archive_failed",
                &registration.database.id,
                name,
                &outcome,
                &credential,
            );
            return entry.failed(if outcome.exit == Exit::TimedOut {
                "upload_timeout"
            } else {
                "upload_failed"
            });
        }
        if registration.upload_log.append(name).await.is_err() {
            log_failed_job(
                "archive_log_failed",
                &registration.database.id,
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
        // A segment of the wrong size came out of the spool, where a prefetch that failed left it
        // (see `Recovery::segment_bytes`): it is fetched once more, without prefetch, and barman
        // replaces what it delivered.
        for prefetch in [WAL_PREFETCH, 0] {
            let job = Job::wal_fetch(
                &recovery.source,
                &recovery.spool,
                name,
                &target,
                prefetch,
                self.bound,
            );
            let outcome = match self
                .jobs
                .run(&registration.database, &job, &credential, Some(deadline))
                .await
            {
                Ok(outcome) => outcome,
                Err(Busy) => return Reply::Failed(Some("agent_busy")),
            };
            if !(outcome.succeeded() && target.is_file()) {
                return fetch_failed(recovery, registration, name, &outcome, &credential);
            }
            let whole = !is_segment(name)
                || std::fs::metadata(&target)
                    .is_ok_and(|file| file.len() == recovery.segment_bytes);
            if whole {
                return Reply::Ok;
            }
            // The second fetch replaces the file: the agent runs as root and deletes nothing in
            // a directory its database's user can rearrange.
        }
        Reply::Failed(Some("fetch_wrong_size"))
    }
}

/// The answer to a fetch that did not deliver the file.
fn fetch_failed(
    recovery: &Recovery,
    registration: &Registration,
    name: &str,
    outcome: &Outcome,
    credential: &Credential,
) -> Reply {
    // barman 3.20 exits 1 with "does not exist" for an object R2 reports absent; every other
    // failure (an expired credential, a refused or lost connection) has another status.
    if outcome.exit == Exit::Code(1) && outcome.stderr.contains("does not exist") {
        return if recovery.requires(name) {
            Reply::Failed(Some("segment_missing"))
        } else {
            Reply::Missing
        };
    }
    log_failed_job(
        "fetch_failed",
        &registration.database.id,
        name,
        outcome,
        credential,
    );
    Reply::Failed(Some(if outcome.exit == Exit::TimedOut {
        "fetch_timeout"
    } else {
        "fetch_failed"
    }))
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

pub(crate) fn unix_seconds() -> u64 {
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
pub(crate) fn log_failed_job(
    event: &str,
    database_id: &str,
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
        "database_id": database_id,
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
            ARCHIVE, Node, SEGMENT, SEGMENT_BYTES, SOURCE, credential, directory, now, store,
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
        // The unit's own bound is whole seconds, so it ends at one second, before the upload.
        node.fixture.set("delay", "1.5");
        assert_eq!(node.archive(SEGMENT).await, "failed upload_timeout\n");
        tokio::time::sleep(Duration::from_millis(1700)).await;
        assert!(!node.fixture.object(ARCHIVE, SEGMENT).exists());
        assert!(node.log().entries().unwrap().is_empty());
    }

    #[tokio::test]
    async fn calls_that_cannot_finish_in_time_are_all_failed_and_none_logged() {
        let node = Node::start("busy", Duration::from_millis(300)).await;
        node.fixture.set("delay", "1.5");
        // One call runs out of time; the database's other calls are refused while it runs.
        let calls = futures_util::future::join_all((0..3).map(|_| node.archive(SEGMENT))).await;
        for answer in &calls {
            assert!(
                answer == "failed upload_timeout\n" || answer == "failed agent_busy\n",
                "{answer:?}"
            );
        }
        tokio::time::sleep(Duration::from_millis(1700)).await;
        assert!(node.log().entries().unwrap().is_empty());
        assert!(!node.fixture.object(ARCHIVE, SEGMENT).exists());
    }

    #[tokio::test]
    async fn a_database_has_one_call_at_a_time_and_cannot_take_the_slots_of_the_others() {
        use crate::archive::job::{Database, Jobs, Limits};
        let node = Node::start("serial", AGENT_BOUND).await;
        // A second database of the node, with its own user, volume and archive.
        let neighbour_archive =
            "s3://pgcf-eu/eu-dev/zyxwvutsrqponmlkjihg/g1-op_eeeeeeeeeeeeeeeeeeee";
        let neighbour_volume = directory("neighbour");
        std::fs::create_dir_all(neighbour_volume.join("data/pg_wal")).unwrap();
        std::fs::write(
            neighbour_volume.join("data/pg_wal").join(SEGMENT),
            vec![5u8; 2048],
        )
        .unwrap();
        let neighbour_store = store(neighbour_archive, Access::ReadWrite);
        node.credentials
            .hold(neighbour_store.scope.clone(), credential());
        let neighbour_uid = node.uid + 1;
        node.table.set(Registration {
            database: Database {
                id: "zyxwvutsrqponmlkjihg".into(),
                user: "pgcf-zyxwvutsrqponmlkjihg".into(),
                volume: neighbour_volume.clone(),
                socket_directory: neighbour_volume.join("socket"),
            },
            uid: neighbour_uid,
            store: neighbour_store,
            recovery: None,
            upload_log: UploadLog::new(neighbour_volume.join("uploads")),
        });
        std::fs::write(
            node.volume().join("data/pg_wal/000000010000000000000002"),
            vec![6u8; 2048],
        )
        .unwrap();
        let jobs = Arc::new(Jobs::new(
            node.fixture.runner().with_grace(Duration::ZERO),
            Limits::default(),
        ));
        let server = Server::new(node.table.clone(), jobs, node.credentials.clone());
        node.fixture.set("delay", "1");
        let archive = async |uid: u32, name: String| {
            server
                .answer(uid, format!("pgcf-archive/1 archive {name}").as_bytes())
                .await
        };
        let first = archive(node.uid, SEGMENT.into());
        let others = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            let started = std::time::Instant::now();
            // More calls of the same database, from any connection, are refused at once ...
            let again = futures_util::future::join_all(
                (2..5).map(|n| archive(node.uid, format!("00000001000000000000000{n}"))),
            )
            .await;
            let refused_in = started.elapsed();
            // ... and take no slot from the database next to it.
            let neighbour = archive(neighbour_uid, SEGMENT.into()).await;
            (again, refused_in, neighbour)
        };
        let (first, (again, refused_in, neighbour)) = tokio::join!(first, others);
        assert_eq!(first, Reply::Ok);
        assert_eq!(again, [Reply::Failed(Some("agent_busy")); 3]);
        assert!(refused_in < Duration::from_millis(150), "{refused_in:?}");
        assert_eq!(neighbour, Reply::Ok);
        // Two uploads ran, side by side: the first and the neighbour's. Nothing else ran.
        let seen = node.fixture.concurrency();
        assert_eq!((seen.len(), seen.into_iter().max()), (2, Some(2)));
        assert_eq!(node.log().entries().unwrap(), [SEGMENT]);
        // Once the call is over the database can ask again.
        assert_eq!(
            archive(node.uid, "000000010000000000000002".into()).await,
            Reply::Ok
        );
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
            Credential::delivered("fixturekeyid", "fixturesecret", "fixturetoken", 2).unwrap();
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
        let segment = vec![3u8; SEGMENT_BYTES as usize];
        node.fixture.put_object(SOURCE, SEGMENT, &segment);
        assert_eq!(node.fetch(SEGMENT).await, "ok\n");
        assert!(std::fs::read(node.volume().join("data/pg_wal/RECOVERYXLOG")).unwrap() == segment);
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
    async fn the_end_of_the_archive_is_missing_even_when_barman_says_so_near_the_bound() {
        // A call that waited for its slot is left little time to run in; barman's answer for an
        // absent object comes late in it, and is no timeout.
        let node = Node::start("late", Duration::from_secs(4)).await;
        node.register(Some(node.recovery(None)));
        node.fixture.set("delay", "3");
        let started = std::time::Instant::now();
        assert_eq!(node.fetch("000000010000000000000002").await, "missing\n");
        assert!(started.elapsed() >= Duration::from_secs(3));
    }

    #[tokio::test]
    async fn a_cut_off_prefetch_is_fetched_again_and_a_cut_off_archive_is_a_failure() {
        let node = Node::start("short", AGENT_BOUND).await;
        node.register(Some(node.recovery(None)));
        let whole = vec![4u8; SEGMENT_BYTES as usize];
        node.fixture.put_object(SOURCE, SEGMENT, &whole);
        // The prefetch of an earlier call was cut off by an R2 error, and barman exited 0 all
        // the same; the next call delivers what is in the spool.
        let spool = node.volume().join("spool-op_cccccccccccccccccccc");
        std::fs::create_dir_all(&spool).unwrap();
        std::fs::write(spool.join(SEGMENT), &whole[..700]).unwrap();
        let destination = node.volume().join("data/pg_wal/RECOVERYXLOG");
        assert_eq!(node.fetch(SEGMENT).await, "ok\n");
        assert!(std::fs::read(&destination).unwrap() == whole);
        assert!(!spool.join(SEGMENT).exists());
        // The second try asked for no prefetch, so that nothing can cut it off again.
        assert_eq!(node.fixture.prefetches(), [4, 0]);
        // An archive whose object itself is cut off cannot be answered ok.
        let second = "000000010000000000000002";
        node.fixture.put_object(SOURCE, second, &whole[..100]);
        assert_eq!(node.fetch(second).await, "failed fetch_wrong_size\n");
        // Only a segment has the size of one: a history file, a partial or backup history file
        // are as long as they are.
        node.fixture
            .put_object(SOURCE, "00000002.history", b"1\t0/3000000\tx\n");
        assert_eq!(node.fetch("00000002.history").await, "ok\n");
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
            segment_bytes: SEGMENT_BYTES,
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
