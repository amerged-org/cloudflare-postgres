// SPDX-License-Identifier: Apache-2.0
//! The archive socket under a real PostgreSQL 18: its archiver and its recovery are the clients,
//! the agent's server is the server, and a base backup of the real cluster is restored by point in
//! time. Only R2 and `systemd-run` are stood in for (see `test_support`). Point
//! `PGCF_TEST_POSTGRES_BINDIR` at the `bin` of a PostgreSQL 18 (Homebrew's and Debian's paths are
//! tried); without one, or without `nc`, the tests are skipped.
use super::{
    facts::{self, Backup},
    protocol::AGENT_BOUND,
    recovery::{self, Restored},
    restore::{End, Failed, Host, Order, Restorer},
    test_support::{ARCHIVE, CREDENTIAL_CHECK, Node, credential, database, store},
    upload_log::UploadLog,
};
use crate::{credentials::Access, settings::Capacity};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

fn bin_directory() -> Option<PathBuf> {
    let found = [
        std::env::var_os("PGCF_TEST_POSTGRES_BINDIR").map(PathBuf::from),
        Some("/opt/homebrew/opt/postgresql@18/bin".into()),
        Some("/usr/lib/postgresql/18/bin".into()),
    ]
    .into_iter()
    .flatten()
    .find(|bin| bin.join("initdb").exists());
    let nc = Command::new("nc").arg("-h").output().is_ok();
    if found.is_none() || !nc {
        eprintln!("skipped: no PostgreSQL 18 (PGCF_TEST_POSTGRES_BINDIR) or no nc");
        return None;
    }
    found
}

fn run(program: &Path, arguments: &[&str]) -> String {
    let output = Command::new(program).args(arguments).output().unwrap();
    assert!(
        output.status.success(),
        "{} {arguments:?}: {}",
        program.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}
fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let started = Instant::now();
    while !done() {
        assert!(
            started.elapsed() < Duration::from_secs(60),
            "timed out: {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// One PostgreSQL 18 cluster in `volume/data`, reachable on a socket in `volume/socket`.
struct Postgres {
    bin: PathBuf,
    volume: PathBuf,
}
impl Postgres {
    fn data(&self) -> PathBuf {
        self.volume.join("data")
    }
    fn socket(&self) -> PathBuf {
        self.volume.join("socket")
    }
    fn settings(&self, extra: &str) -> String {
        let socket = self.socket();
        fs::create_dir_all(&socket).unwrap();
        assert!(
            socket.join(".s.PGSQL.5432").as_os_str().len() < 100,
            "the temporary directory is too deep for a Unix socket"
        );
        format!(
            "listen_addresses = ''\nunix_socket_directories = '{}'\nwal_level = replica\nfsync = off\nshared_buffers = 16MB\n{extra}",
            socket.display()
        )
    }
    fn init(&self, extra: &str) {
        run(
            &self.bin.join("initdb"),
            &[
                "-D",
                self.data().to_str().unwrap(),
                "-U",
                "postgres",
                "-A",
                "trust",
                "--wal-segsize=1",
                "--no-sync",
                "--no-locale",
                "-E",
                "UTF8",
            ],
        );
        let conf = self.data().join("postgresql.conf");
        let mut text = fs::read_to_string(&conf).unwrap();
        text.push_str(&self.settings(extra));
        fs::write(conf, text).unwrap();
    }
    fn start(&self) -> Result<(), String> {
        let output = Command::new(self.bin.join("pg_ctl"))
            .args(["-D", self.data().to_str().unwrap(), "-w", "-t", "20", "-l"])
            .arg(self.volume.join("postgres.log"))
            .arg("start")
            .output()
            .unwrap();
        if output.status.success() {
            Ok(())
        } else {
            Err(self.log())
        }
    }
    fn stop(&self) {
        let _ = Command::new(self.bin.join("pg_ctl"))
            .args([
                "-D",
                self.data().to_str().unwrap(),
                "-m",
                "fast",
                "-w",
                "stop",
            ])
            .output();
    }
    /// The answer of `sql`, or `None` when the server does not answer.
    fn try_sql(&self, sql: &str) -> Option<String> {
        let output = Command::new(self.bin.join("psql"))
            .args([
                "-X",
                "-At",
                "-h",
                self.socket().to_str().unwrap(),
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-c",
                sql,
            ])
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().into())
    }
    fn sql(&self, sql: &str) -> String {
        run(
            &self.bin.join("psql"),
            &[
                "-X",
                "-At",
                "-h",
                self.socket().to_str().unwrap(),
                "-U",
                "postgres",
                "-d",
                "postgres",
                "-c",
                sql,
            ],
        )
    }
    fn log(&self) -> String {
        fs::read_to_string(self.volume.join("postgres.log")).unwrap_or_default()
    }
}
impl Drop for Postgres {
    fn drop(&mut self) {
        let _ = Command::new(self.bin.join("pg_ctl"))
            .args([
                "-D",
                self.data().to_str().unwrap(),
                "-m",
                "immediate",
                "stop",
            ])
            .output();
    }
}

fn executable(path: &Path, text: String) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}
/// What `pgcf-archive` and `pgcf-wal-fetch` are, in shell: one line to the socket, one answer
/// back, and the exit status the clients document (0 ok, 1 missing, anything else a failure).
fn clients(directory: &Path, socket: &Path) -> (PathBuf, PathBuf) {
    let archive = directory.join("archive-client");
    let fetch = directory.join("fetch-client");
    executable(
        &archive,
        format!(
            "#!/bin/sh\nreply=$(printf 'pgcf-archive/1 archive %s\\n' \"$1\" | nc -U -w 70 '{}')\n[ \"$reply\" = ok ]\n",
            socket.display()
        ),
    );
    executable(
        &fetch,
        format!(
            "#!/bin/sh\nreply=$(printf 'pgcf-archive/1 fetch %s %s\\n' \"$1\" \"$2\" | nc -U -w 70 '{}')\ncase \"$reply\" in ok) exit 0 ;; missing) exit 1 ;; *) exit 255 ;; esac\n",
            socket.display()
        ),
    );
    (archive, fetch)
}
fn archiving(archive_client: &Path) -> String {
    format!(
        "archive_mode = on\narchive_command = '{} %f'\narchive_timeout = 0\n",
        archive_client.display()
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgresql_marks_a_segment_archived_only_after_the_agent_has_it_in_r2_and_its_log() {
    let Some(bin) = bin_directory() else { return };
    let node = Node::start("pg", AGENT_BOUND).await;
    let (archive_client, _) = clients(&node.root, &node.socket);
    let pg = Postgres {
        bin,
        volume: node.volume(),
    };
    let _ = fs::remove_dir_all(pg.data());
    pg.init(&archiving(&archive_client));
    node.fixture.set("fail", "");
    pg.start().unwrap();
    pg.sql("CREATE TABLE t AS SELECT g FROM generate_series(1, 20000) g");
    let segment = pg.sql("SELECT pg_walfile_name(pg_switch_wal())");
    let status = pg.data().join("pg_wal/archive_status");
    // While R2 fails, the archiver fails with it: the segment waits, nothing counts as archived.
    wait_until("a failed archive call", || {
        pg.sql("SELECT failed_count FROM pg_stat_archiver") != "0"
    });
    assert!(status.join(format!("{segment}.ready")).exists());
    assert!(!status.join(format!("{segment}.done")).exists());
    assert!(node.log().entries().unwrap().is_empty());
    assert!(!node.fixture.object(ARCHIVE, &segment).exists());
    let waiting = facts::ready_files(&pg.data()).unwrap();
    assert!(waiting.iter().any(|file| file.name == segment));
    let since = node.table.failing_since_ms("abcdefghijklmnopqrst").unwrap();
    let facts = facts::archive_facts(&facts::ArchiveState {
        now_ms: since + 5_000,
        last_segment: None,
        ready: Some(&waiting),
        failing_since_ms: Some(since),
    });
    assert!(facts.ready_files.unwrap() >= 1 && facts.failing_since.is_some());
    // R2 is back: the archiver's next try is answered ok. PostgreSQL's `.done` is the evidence
    // that the agent answered, and then the object and the log entry are both there.
    node.fixture.clear("fail");
    wait_until("the segment to be archived", || {
        status.join(format!("{segment}.done")).exists()
    });
    assert!(node.fixture.object(ARCHIVE, &segment).exists());
    assert!(node.log().contains(&segment).unwrap());
    assert_eq!(
        pg.sql("SELECT last_archived_wal FROM pg_stat_archiver"),
        segment
    );
    assert_eq!(node.table.failing_since_ms("abcdefghijklmnopqrst"), None);
    let unfailing = facts::ready_files(&pg.data()).unwrap();
    assert!(unfailing.iter().all(|file| file.name != segment));
}

/// The database a restore builds, as the modules that own units and connections do for it, here
/// with `pg_ctl` and `psql`.
struct ClusterHost<'a> {
    pg: &'a Postgres,
    /// The settings of the class it runs in, which its configuration has before the recovery's.
    class: Capacity,
    abandoned: AtomicBool,
    restarts: AtomicUsize,
}
impl ClusterHost<'_> {
    fn class_settings(&self) -> String {
        format!(
            "max_connections = {}\nmax_worker_processes = {}\nmax_wal_senders = {}\nmax_prepared_transactions = {}\nmax_locks_per_transaction = {}\n",
            self.class.max_connections,
            self.class.max_worker_processes,
            self.class.max_wal_senders,
            self.class.max_prepared_transactions,
            self.class.max_locks_per_transaction,
        )
    }
}
impl Host for ClusterHost<'_> {
    async fn start(&self) -> Result<(), Failed> {
        // The configuration of the new database: no archiving here, and the recovery settings
        // included from the file the agent writes and later removes.
        fs::write(
            self.pg.data().join("postgresql.conf"),
            self.pg.settings(&format!(
                "{}include_if_exists = 'pgcf-recovery.conf'\n",
                self.class_settings()
            )),
        )
        .unwrap();
        self.pg.start().map_err(|_| Failed)
    }
    async fn promoted(&self) -> Result<Restored, Failed> {
        let started = Instant::now();
        loop {
            match self.pg.try_sql("SELECT pg_is_in_recovery()").as_deref() {
                // The server is gone: the recovery died.
                None => return Err(Failed),
                Some("f") => break,
                Some(_) if started.elapsed() > Duration::from_secs(60) => return Err(Failed),
                Some(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        self.pg.sql("CHECKPOINT");
        Ok(Restored {
            in_recovery: false,
            system_identifier: self
                .pg
                .sql("SELECT system_identifier FROM pg_control_system()"),
            timeline: self
                .pg
                .sql("SELECT timeline_id FROM pg_control_checkpoint()")
                .parse()
                .unwrap(),
        })
    }
    async fn restart(&self) -> Result<(), Failed> {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        self.pg.stop();
        self.pg.start().map_err(|_| Failed)
    }
    async fn abandon(&self) {
        self.pg.stop();
        self.abandoned.store(true, Ordering::SeqCst);
    }
}

const BACKUP: &str = "20261017T225342";
const OPERATION: &str = "op_dddddddddddddddddddd";

/// A new database in the volume `name` of the node: nothing in it yet.
fn new_database(node: &Node, bin: &Path, name: &str) -> Postgres {
    let volume = node.root.join(name);
    fs::create_dir_all(&volume).unwrap();
    // What barman leaves behind when it prefetches.
    let spool = recovery::spool_directory(&volume, OPERATION);
    fs::create_dir_all(&spool).unwrap();
    fs::write(spool.join("000000010000000000000099"), b"prefetched").unwrap();
    Postgres {
        bin: bin.into(),
        volume,
    }
}
/// The class of a database: its memory in MiB and its `max_connections`.
type Class = (u64, u32);
/// PostgreSQL's own defaults, which the clusters of these tests run with: a restore of one into
/// another needs no restart.
const DEFAULTS: Class = (1024, 100);
/// The catalog's xs.
const XS: Class = (256, 20);

/// A restore of `BACKUP` of `ARCHIVE` into `pg` by the executor, with the database's own archive
/// at generation `generation`; whether the database was abandoned and how often it was restarted
/// come with the result.
async fn restore(
    node: &Node,
    pg: &Postgres,
    class: Class,
    fetch_client: &Path,
    generation: u32,
    target_time: Option<&str>,
    end: Option<&End>,
) -> (Result<Backup, &'static str>, bool, usize) {
    let own = store(
        &format!("s3://pgcf-eu/eu-dev/zyxwvutsrqponmlkjihg/g{generation}-{OPERATION}"),
        Access::ReadWrite,
    );
    node.credentials.hold(own.scope.clone(), credential());
    let source = store(ARCHIVE, Access::ReadOnly);
    let log = UploadLog::new(pg.volume.join("uploads"));
    let owner = fs::metadata(&pg.volume).unwrap();
    let database = database(&pg.volume);
    let order = Order {
        database: &database,
        memory_mib: class.0,
        max_connections: class.1,
        uid: owner.uid(),
        gid: owner.gid(),
        source: &source,
        backup_id: BACKUP,
        target_time,
        end,
        store: &own,
        upload_log: &log,
        operation: OPERATION,
    };
    let host = ClusterHost {
        pg,
        class: Capacity::of_class(class.0, class.1),
        abandoned: AtomicBool::new(false),
        restarts: AtomicUsize::new(0),
    };
    let restorer = Restorer {
        table: &node.table,
        jobs: &node.jobs,
        credentials: &node.credentials,
        fetch_command: fetch_client.to_str().unwrap(),
    };
    let result = restorer.run(&order, &host).await;
    (
        result,
        host.abandoned.load(Ordering::SeqCst),
        host.restarts.load(Ordering::SeqCst),
    )
}

/// What a source cluster left in the node's archive: its base backup (as barman lists it), the
/// WAL after it, a point in time between two batches of rows, and the digests of its rows then
/// and at the end.
struct Archived {
    fetch_client: PathBuf,
    system_identifier: String,
    timeline: u32,
    /// Between batch A and batch B, as a contract timestamp.
    target: String,
    /// The last segment of the source's archive.
    last: String,
    /// The digest of batch A, and of both batches.
    digest_a: String,
    digest: String,
}
/// The digest of the rows of `t`, the same for equal rows.
const DIGEST: &str = "SELECT md5(string_agg(id::text || batch, ',' ORDER BY id)) FROM t";

/// A source cluster with `settings` besides the archiving, whose base backup of batch-less `t`
/// and archive of batches A and B the node holds, as the backup `BACKUP` of `ARCHIVE`. It also
/// installs the barman that takes the first backup of a new timeline: it connects as the backup
/// role to the socket it was given and lists what it saw there.
async fn archived_source(node: &Node, bin: &Path, settings: &str) -> Archived {
    let (archive_client, fetch_client) = clients(&node.root, &node.socket);
    let source = Postgres {
        bin: bin.into(),
        volume: node.volume(),
    };
    let _ = fs::remove_dir_all(source.data());
    source.init(&format!("{}{settings}", archiving(&archive_client)));
    source.start().unwrap();
    source.sql("CREATE ROLE pgcf_backup LOGIN");
    source.sql("CREATE TABLE t(id int PRIMARY KEY, batch text)");
    // The base backup: files of the real cluster, with the WAL it needs left to the archive.
    let base = node.root.join("base");
    run(
        &bin.join("pg_basebackup"),
        &[
            "-h",
            source.socket().to_str().unwrap(),
            "-U",
            "postgres",
            "-D",
            base.to_str().unwrap(),
            "-X",
            "none",
            "-c",
            "fast",
        ],
    );
    let system_identifier = source.sql("SELECT system_identifier FROM pg_control_system()");
    let timeline: u32 = source
        .sql("SELECT timeline_id FROM pg_control_checkpoint()")
        .parse()
        .unwrap();
    source.sql("INSERT INTO t SELECT g, 'A' FROM generate_series(1, 1000) g");
    let digest_a = source.sql(DIGEST);
    std::thread::sleep(Duration::from_millis(300));
    let target =
        source.sql("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')");
    std::thread::sleep(Duration::from_millis(300));
    source.sql("INSERT INTO t SELECT g, 'B' FROM generate_series(1001, 2000) g");
    let digest = source.sql(DIGEST);
    let last = source.sql("SELECT pg_walfile_name(pg_switch_wal())");
    wait_until("the last segment to be archived", || {
        node.log().contains(&last).unwrap()
    });
    source.stop();
    // The archive as barman lists it, with the base backup in it.
    node.fixture.put_backup(
        ARCHIVE,
        BACKUP,
        &format!(
            r#"{{"backup_id":"{BACKUP}","status":"DONE","timeline":{timeline},"systemid":"{system_identifier}","end_wal":null,"end_time_iso":"2026-10-17T22:53:45+00:00","xlog_segment_size":1048576}}"#
        ),
        Some(&base),
    );
    node.fixture.install(
        "barman-cloud-backup",
        format!(
            r#"#!/bin/sh
STORE='{store}'
{CREDENTIAL_CHECK}
while [ $# -gt 0 ]; do case "$1" in --gzip|--immediate-checkpoint) ;; -J|--endpoint-url) shift ;; --host) host=$2; shift ;; -U) user=$2; shift ;; -d) db=$2; shift ;; *) break ;; esac; shift; done
dest=$1; server=$2
psql='{psql}'
sys=$("$psql" -X -At -h "$host" -U "$user" -d "$db" -c 'SELECT system_identifier FROM pg_control_system()') || exit 3
tl=$("$psql" -X -At -h "$host" -U "$user" -d "$db" -c 'SELECT timeline_id FROM pg_control_checkpoint()') || exit 3
id=$(date -u +%Y%m%dT%H%M%S)
dir="$STORE/objects/${{dest#s3://}}/$server/base/$id"
mkdir -p "$dir"
status=DONE; [ -f "$STORE/backup-failed" ] && status=FAILED
printf '{{"backup_id":"%s","status":"%s","timeline":%s,"systemid":"%s","end_wal":null,"end_time_iso":"%s","xlog_segment_size":1048576}}' "$id" "$status" "$tl" "$sys" "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$dir/backup.json"
"#,
            store = node.fixture.store_directory().display(),
            psql = bin.join("psql").display(),
            CREDENTIAL_CHECK = CREDENTIAL_CHECK,
        ),
    );
    Archived {
        fetch_client,
        system_identifier,
        timeline,
        target,
        last,
        digest_a,
        digest,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_of_a_real_cluster_recovers_to_a_point_in_time_or_to_the_end_and_takes_its_first_backup()
 {
    let Some(bin) = bin_directory() else { return };
    let node = Node::start("pitr", AGENT_BOUND).await;
    let Archived {
        fetch_client,
        system_identifier,
        timeline,
        target,
        last,
        ..
    } = archived_source(&node, &bin, "").await;
    let end = |last_segment: &str, system_identifier: &str| End {
        system_identifier: system_identifier.into(),
        timeline,
        last_segment: last_segment.into(),
    };
    let spool = |pg: &Postgres| recovery::spool_directory(&pg.volume, OPERATION);

    // A point in time: batch A only; the same database, promoted onto timeline 2, and its first
    // base backup on that timeline in its own archive.
    let pitr = new_database(&node, &bin, "r1");
    let (result, abandoned, restarts) = restore(
        &node,
        &pitr,
        DEFAULTS,
        &fetch_client,
        2,
        Some(&target),
        None,
    )
    .await;
    let backup = result.unwrap();
    assert!(!abandoned);
    // The recovery ran with the class's own settings: no restart.
    assert_eq!(restarts, 0);
    assert_eq!(pitr.sql("SELECT count(*) FROM t"), "1000");
    assert_eq!(pitr.sql("SELECT count(*) FROM t WHERE batch = 'B'"), "0");
    assert_eq!(
        (
            backup.status.as_str(),
            backup.timeline,
            &backup.system_identifier
        ),
        ("DONE", timeline + 1, &system_identifier)
    );
    // The recovery's files and spool are gone, and the database archives rather than recovers.
    assert!(!pitr.data().join(recovery::SETTINGS_FILE).exists());
    assert!(!pitr.data().join(recovery::SIGNAL_FILE).exists());
    assert!(!spool(&pitr).exists());
    assert_eq!(
        node.fetch("000000010000000000000001").await,
        "failed not_recovering\n"
    );
    pitr.stop();

    // To the end of the archive, as a move target that must reach the source's last segment: all
    // of batch B, and the archive's end is told to PostgreSQL only after that segment.
    let moved = new_database(&node, &bin, "r2");
    let (result, abandoned, _) = restore(
        &node,
        &moved,
        DEFAULTS,
        &fetch_client,
        3,
        None,
        Some(&end(&last, &system_identifier)),
    )
    .await;
    let backup = result.unwrap();
    assert!(!abandoned);
    assert_eq!(moved.sql("SELECT count(*) FROM t"), "2000");
    assert_eq!(backup.timeline, timeline + 1);
    moved.stop();

    // A move target whose archive lacks a segment of the source's record is not promoted: the
    // recovery fails instead of ending early, the database never opens for writes, and it is
    // abandoned with its registration.
    let next = format!(
        "{}{:08X}",
        &last[..16],
        u32::from_str_radix(&last[16..], 16).unwrap() + 1
    );
    let short = new_database(&node, &bin, "r3");
    let (result, abandoned, _) = restore(
        &node,
        &short,
        DEFAULTS,
        &fetch_client,
        4,
        None,
        Some(&end(&next, &system_identifier)),
    )
    .await;
    // PostgreSQL is consistent early in the recovery and dies at the missing segment: whether it
    // dies before or after `pg_ctl` saw it accept connections decides which step reports it, and
    // either way the recovery point was not reached.
    let error = result.unwrap_err();
    assert!(
        matches!(error, "no_recovery_point" | "start_failed"),
        "{error}"
    );
    assert!(abandoned);
    let log = short.log();
    assert!(log.contains("could not restore file"), "{log}");
    assert!(!log.contains("archive recovery complete"), "{log}");
    assert_eq!(
        node.archive("000000010000000000000001").await,
        "failed unknown_database\n"
    );

    // A record of another database: this one recovered to the end of the archive, and is not it.
    let other = new_database(&node, &bin, "r4");
    let (result, abandoned, _) = restore(
        &node,
        &other,
        DEFAULTS,
        &fetch_client,
        5,
        None,
        Some(&end(&last, "7697773764701949975")),
    )
    .await;
    assert_eq!(result.unwrap_err(), "identity_mismatch");
    assert!(abandoned);

    // The first backup counts when the listing shows it DONE, whatever barman's exit status was.
    node.fixture.set("backup-failed", "");
    let unbacked = new_database(&node, &bin, "r5");
    let (result, abandoned, _) =
        restore(&node, &unbacked, DEFAULTS, &fetch_client, 6, None, None).await;
    assert_eq!(result.unwrap_err(), "build_failed");
    assert!(abandoned);
}

/// The settings of a source of the larger class: the catalog's md has 200 connections, and this
/// one more of everything else than xs (4 workers, no sender, no prepared transaction, 64 locks).
const LARGER_CLASS: &str = "max_connections = 200\nmax_worker_processes = 10\nmax_wal_senders = 12\nmax_prepared_transactions = 4\nmax_locks_per_transaction = 128\n";

/// PostgreSQL aborts an archive recovery with hot standby whose `max_connections`, process,
/// sender, prepared transaction or lock settings are below its source's ("recovery aborted
/// because of insufficient parameter settings"). A restore and a point in time restore of a
/// larger class's backup into a smaller class promote all the same, hold the source's rows, and
/// run on the smaller class's settings before they count as built.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_and_a_pitr_of_a_larger_classs_backup_promote_in_a_smaller_class() {
    let Some(bin) = bin_directory() else { return };
    let node = Node::start("smaller-class", AGENT_BOUND).await;
    let source = archived_source(&node, &bin, LARGER_CLASS).await;

    let pitr = new_database(&node, &bin, "s1");
    let (result, abandoned, restarts) = restore(
        &node,
        &pitr,
        XS,
        &source.fetch_client,
        2,
        Some(&source.target),
        None,
    )
    .await;
    assert_eq!(
        result.map(|backup| backup.timeline),
        Ok(source.timeline + 1),
        "{}",
        pitr.log()
    );
    assert!(!abandoned);
    assert_eq!(pitr.sql(DIGEST), source.digest_a);
    // It restarted once, and already runs on the class's settings, not on the recovery's.
    assert_eq!(restarts, 1);
    assert_eq!(pitr.sql("SHOW max_connections"), "20");
    assert_eq!(pitr.sql("SHOW max_worker_processes"), "4");
    assert_eq!(pitr.sql("SHOW max_wal_senders"), "0");
    pitr.stop();

    let full = new_database(&node, &bin, "s2");
    let (result, abandoned, restarts) =
        restore(&node, &full, XS, &source.fetch_client, 3, None, None).await;
    assert_eq!(
        result.map(|backup| backup.timeline),
        Ok(source.timeline + 1),
        "{}",
        full.log()
    );
    assert!(!abandoned);
    assert_eq!(full.sql(DIGEST), source.digest);
    assert_eq!(restarts, 1);
    assert_eq!(full.sql("SHOW max_connections"), "20");
    assert_eq!(full.sql("SHOW max_prepared_transactions"), "0");
    assert_eq!(full.sql("SHOW max_locks_per_transaction"), "64");
}
