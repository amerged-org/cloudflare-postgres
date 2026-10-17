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
    server::{Recovery, Registration},
    test_support::{ARCHIVE, Node, database, store},
    upload_log::UploadLog,
};
use crate::credentials::Access;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
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

/// Restores the base backup `base` into a new volume of the node and brings it up as the
/// database that recovers from `ARCHIVE`: the agent's restore, with the barman copy done by the
/// test. Returns the new cluster, or the log of its failed start.
fn recover(
    node: &Node,
    bin: &Path,
    fetch_client: &Path,
    base: &Path,
    name: &str,
    target_time: Option<&str>,
    required_through: Option<&str>,
) -> (Postgres, Result<(), String>) {
    let volume = node.root.join(name);
    fs::create_dir_all(&volume).unwrap();
    // A clone where the file system has them (APFS): copying the cluster is most of the time.
    let clone = if cfg!(target_os = "macos") {
        "-Rc"
    } else {
        "-R"
    };
    run(
        Path::new("cp"),
        &[
            clone,
            base.to_str().unwrap(),
            volume.join("data").to_str().unwrap(),
        ],
    );
    fs::set_permissions(volume.join("data"), fs::Permissions::from_mode(0o700)).unwrap();
    let pg = Postgres {
        bin: bin.into(),
        volume: volume.clone(),
    };
    // The configuration of the new database: no archiving here, and the recovery settings
    // included from the file the agent writes and later removes.
    fs::write(
        pg.data().join("postgresql.conf"),
        pg.settings("include_if_exists = 'pgcf-recovery.conf'\n"),
    )
    .unwrap();
    let owner = fs::metadata(&volume).unwrap();
    recovery::prepare(
        &pg.data(),
        &recovery::settings(fetch_client.to_str().unwrap(), target_time).unwrap(),
        owner.uid(),
        owner.gid(),
    )
    .unwrap();
    let spool = recovery::spool_directory(&volume, "op_dddddddddddddddddddd");
    node.table.set(Registration {
        database: database(&volume),
        uid: node.uid,
        store: store(ARCHIVE, Access::ReadWrite),
        recovery: Some(Recovery {
            source: store(ARCHIVE, Access::ReadOnly),
            spool,
            required_through: required_through.map(Into::into),
        }),
        upload_log: UploadLog::new(volume.join("uploads")),
    });
    let started = pg.start();
    (pg, started)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_base_backup_of_a_real_cluster_recovers_through_the_socket_to_a_point_in_time_or_to_the_end()
 {
    let Some(bin) = bin_directory() else { return };
    let node = Node::start("pitr", AGENT_BOUND).await;
    let (archive_client, fetch_client) = clients(&node.root, &node.socket);
    let source = Postgres {
        bin: bin.clone(),
        volume: node.volume(),
    };
    let _ = fs::remove_dir_all(source.data());
    source.init(&archiving(&archive_client));
    source.start().unwrap();
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
    let timeline = source
        .sql("SELECT timeline_id FROM pg_control_checkpoint()")
        .parse()
        .unwrap();
    source.sql("INSERT INTO t SELECT g, 'A' FROM generate_series(1, 1000) g");
    std::thread::sleep(Duration::from_millis(300));
    let target =
        source.sql("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')");
    std::thread::sleep(Duration::from_millis(300));
    source.sql("INSERT INTO t SELECT g, 'B' FROM generate_series(1001, 2000) g");
    let last = source.sql("SELECT pg_walfile_name(pg_switch_wal())");
    wait_until("the last segment to be archived", || {
        node.log().contains(&last).unwrap()
    });
    source.stop();
    let backup = Backup {
        backup_id: "20261017T225342".into(),
        status: "DONE".into(),
        timeline,
        system_identifier: system_identifier.clone(),
        end_wal: None,
        completed_at_ms: Some(1),
    };
    let rows = |pg: &Postgres| pg.sql("SELECT count(*) FROM t");
    let promoted = |pg: &Postgres| {
        wait_until("the recovery to end", || {
            pg.sql("SELECT pg_is_in_recovery()") == "f"
        });
        pg.sql("CHECKPOINT");
        Restored {
            in_recovery: false,
            system_identifier: pg.sql("SELECT system_identifier FROM pg_control_system()"),
            timeline: pg
                .sql("SELECT timeline_id FROM pg_control_checkpoint()")
                .parse()
                .unwrap(),
        }
    };

    // A point in time: batch A only; the same database, promoted onto timeline 2.
    let (pitr, started) = recover(&node, &bin, &fetch_client, &base, "r1", Some(&target), None);
    started.unwrap();
    let restored = promoted(&pitr);
    assert_eq!(rows(&pitr), "1000");
    assert_eq!(pitr.sql("SELECT count(*) FROM t WHERE batch = 'B'"), "0");
    assert_eq!(recovery::verify_restored(&backup, None, &restored), Ok(()));
    assert!(restored.timeline > timeline);
    recovery::finish(
        &pitr.data(),
        &recovery::spool_directory(&pitr.volume, "op_dddddddddddddddddddd"),
    )
    .unwrap();
    assert!(!pitr.data().join(recovery::SETTINGS_FILE).exists());
    pitr.stop();

    // To the end of the archive, as a move target that must reach the source's last segment: all
    // of batch B, and the archive's end is told to PostgreSQL only after that segment.
    let (end, started) = recover(&node, &bin, &fetch_client, &base, "r2", None, Some(&last));
    started.unwrap();
    let restored = promoted(&end);
    assert_eq!(rows(&end), "2000");
    assert_eq!(
        recovery::verify_restored(&backup, Some((&system_identifier, timeline)), &restored),
        Ok(())
    );
    end.stop();

    // A move target whose archive lacks a segment of the source's record is not promoted: the
    // recovery fails instead of ending early, and the database never opens for writes.
    let next = format!(
        "{}{:08X}",
        &last[..16],
        u32::from_str_radix(&last[16..], 16).unwrap() + 1
    );
    let (short, _) = recover(&node, &bin, &fetch_client, &base, "r3", None, Some(&next));
    wait_until("the recovery to fail", || short.sql_fails());
    let log = short.log();
    assert!(log.contains("could not restore file"), "{log}");
    assert!(!log.contains("archive recovery complete"), "{log}");
}

impl Postgres {
    fn sql_fails(&self) -> bool {
        Command::new(self.bin.join("psql"))
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
                "SELECT 1",
            ])
            .output()
            .map_or(true, |output| !output.status.success())
    }
}
