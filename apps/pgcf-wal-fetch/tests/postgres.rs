// SPDX-License-Identifier: Apache-2.0
//! `pgcf-wal-fetch` as the `restore_command` of a real PostgreSQL 18 recovering a base backup.
//! The test plays the node agent on the archive socket and restores from a WAL archive the source
//! cluster wrote with `cp`, as the agent restores from R2.
use pgcf_archive::{Reply, Request};
use pgcf_test_postgres::{Cluster, Directory, binaries};
use std::{
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
fn setting(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// A source cluster with 200 rows, a base backup of it taken after the first 100, and its WAL
/// archive.
struct Source {
    restore: Directory,
    data: PathBuf,
    archive: Directory,
}
fn source(bin: &Path) -> Source {
    let archive = Directory::new("wal");
    let mut cluster = Cluster::init(
        bin,
        &format!(
            "archive_mode = on\narchive_command = {}\n",
            setting(&format!(
                "test ! -f {dir}/%f && cp %p {dir}/%f",
                dir = quoted(archive.path())
            ))
        ),
        "local all all trust\nlocal replication all trust\n",
    );
    cluster.start(&[]);
    cluster.psql(
        "postgres",
        "create table restored (value integer); insert into restored select generate_series(1, 100)",
    );
    let restore = Directory::new("restore");
    let data = restore.path().join("data");
    let output = cluster
        .client("pg_basebackup")
        .args([
            "-U",
            "postgres",
            "--wal-method=none",
            "--checkpoint=fast",
            "-D",
        ])
        .arg(&data)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    cluster.psql(
        "postgres",
        "insert into restored select generate_series(101, 200)",
    );
    let last = cluster.psql("postgres", "select pg_walfile_name(pg_switch_wal())");
    let deadline = Instant::now() + Duration::from_secs(30);
    while cluster.psql(
        "postgres",
        "select coalesce(last_archived_wal, '') from pg_stat_archiver",
    ) < last
    {
        assert!(Instant::now() < deadline, "{}", cluster.log());
        std::thread::sleep(Duration::from_millis(50));
    }
    cluster.stop();
    Source {
        restore,
        data,
        archive,
    }
}

/// The files the agent was asked for, and whether the archive held each; none for a failure.
type Fetches = Arc<Mutex<Vec<(String, Option<bool>)>>>;
/// Serves fetches from `archive` into `data`, answering `failed` while `failing` holds. Returns
/// the requests with whether the file was there.
fn agent(socket: PathBuf, data: PathBuf, archive: PathBuf, failing: Arc<AtomicBool>) -> Fetches {
    let listener = UnixListener::bind(&socket).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut line = Vec::new();
            if BufReader::new(&stream)
                .read_until(b'\n', &mut line)
                .is_err()
            {
                continue;
            }
            let request = Request::decode(line.strip_suffix(b"\n").unwrap()).unwrap();
            let Request::Fetch { name, destination } = request else {
                panic!("restore_command sent {request:?}");
            };
            let (reply, found) = if failing.load(Ordering::SeqCst) {
                (Reply::Failed(Some("download_failed".into())), None)
            } else if archive.join(&name).exists() {
                let target = data.join(&destination);
                fs::copy(archive.join(&name), &target).unwrap();
                fs::File::open(&target).unwrap().sync_all().unwrap();
                (Reply::Ok, Some(true))
            } else {
                (Reply::Missing, Some(false))
            };
            let _ = stream.write_all(&reply.encode());
            log.lock().unwrap().push((name, found));
        }
    });
    seen
}

/// The backup set up to recover through `pgcf-wal-fetch`, and the socket its agent serves.
fn recover(bin: &Path, restore: Directory, data: PathBuf) -> (Cluster, PathBuf, Directory) {
    let command = format!(
        "{} %f %p",
        quoted(Path::new(env!("CARGO_BIN_EXE_pgcf-wal-fetch")))
    );
    let cluster = Cluster::adopt(bin, restore, data);
    cluster.configure(
        &format!(
            "archive_mode = off\nrestore_command = {}\nrecovery_target_action = 'promote'\n",
            setting(&command)
        ),
        "local all all trust\n",
    );
    fs::write(cluster.data.join("recovery.signal"), "").unwrap();
    let sockets = Directory::new("agent");
    (cluster, sockets.path().join("archive.sock"), sockets)
}

#[test]
fn recovery_replays_the_archive_through_the_agent_and_ends_where_it_ends() {
    let Some(bin) = binaries() else { return };
    let Source {
        restore,
        data,
        archive,
    } = source(&bin);
    let (mut cluster, socket, _sockets) = recover(&bin, restore, data);
    let seen = agent(
        socket.clone(),
        cluster.data.clone(),
        archive.path().into(),
        Arc::default(),
    );
    cluster.start(&[(pgcf_archive::SOCKET_ENVIRONMENT, socket.as_os_str())]);
    let deadline = Instant::now() + Duration::from_secs(30);
    while cluster.psql("postgres", "select pg_is_in_recovery()") != "f" {
        assert!(Instant::now() < deadline, "{}", cluster.log());
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        cluster.psql("postgres", "select count(*) from restored"),
        "200"
    );
    assert_eq!(
        cluster.psql(
            "postgres",
            "select substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8)"
        ),
        "00000002"
    );
    let seen = seen.lock().unwrap().clone();
    // Segments came through the agent, and the archive's end was a missing file, not a failure.
    assert!(
        seen.iter()
            .filter(|(name, found)| name.len() == 24 && *found == Some(true))
            .count()
            >= 2,
        "{seen:?}"
    );
    assert!(seen.iter().any(|(_, found)| *found == Some(false)));
    assert!(!cluster.data.join("recovery.signal").exists());
    cluster.stop();
}

#[test]
fn a_failed_fetch_aborts_the_recovery_instead_of_ending_it() {
    let Some(bin) = binaries() else { return };
    let Source {
        restore,
        data,
        archive,
    } = source(&bin);
    let (mut cluster, socket, _sockets) = recover(&bin, restore, data);
    let failing = Arc::new(AtomicBool::new(true));
    let seen = agent(
        socket.clone(),
        cluster.data.clone(),
        archive.path().into(),
        failing.clone(),
    );
    cluster.spawn(&[(pgcf_archive::SOCKET_ENVIRONMENT, OsStr::new(&socket))]);
    let status = cluster
        .wait_exit(Duration::from_secs(30))
        .unwrap_or_else(|| panic!("PostgreSQL kept running:\n{}", cluster.log()));
    assert!(!status.success());
    assert!(!seen.lock().unwrap().is_empty());
    // Still a recovery to finish: it was never promoted at the last file it had.
    assert!(cluster.data.join("recovery.signal").exists());
    let log = cluster.log();
    assert!(
        log.contains("FATAL:  could not restore file") && !log.contains("selected new timeline"),
        "{log}"
    );
    // Once the agent can fetch again, the same recovery completes.
    failing.store(false, Ordering::SeqCst);
    cluster.start(&[(pgcf_archive::SOCKET_ENVIRONMENT, OsStr::new(&socket))]);
    let deadline = Instant::now() + Duration::from_secs(30);
    while cluster.psql("postgres", "select pg_is_in_recovery()") != "f" {
        assert!(Instant::now() < deadline, "{}", cluster.log());
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(
        cluster.psql("postgres", "select count(*) from restored"),
        "200"
    );
    cluster.stop();
}
