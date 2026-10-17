// SPDX-License-Identifier: Apache-2.0
//! `pgcf-archive` as the `archive_command` of a real PostgreSQL 18. The test plays the node agent
//! on the archive socket: it answers the requests it is given and, for `ok`, keeps a durable copy
//! of the segment, as the agent keeps it in R2.
use pgcf_archive::{Reply, Request};
use pgcf_test_postgres::{Cluster, Directory, binaries};
use std::{
    ffi::OsStr,
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How the test agent answers its n-th request.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Answer {
    Failed,
    Unanswered,
    Archived,
}

/// Serves the archive socket at `socket`: the first answers are `script`, every later one
/// archives. Returns the requests with their answers.
fn agent(
    socket: PathBuf,
    data: PathBuf,
    archive: PathBuf,
    script: Vec<Answer>,
) -> Arc<Mutex<Vec<(Request, Answer)>>> {
    let listener = UnixListener::bind(&socket).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for (index, stream) in listener.incoming().enumerate() {
            let Ok(mut stream) = stream else { return };
            let mut line = Vec::new();
            if BufReader::new(&stream)
                .read_until(b'\n', &mut line)
                .is_err()
            {
                continue;
            }
            let request = Request::decode(line.strip_suffix(b"\n").unwrap()).unwrap();
            let answer = script.get(index).copied().unwrap_or(Answer::Archived);
            let Request::Archive { name } = &request else {
                panic!("archive_command sent {request:?}");
            };
            match answer {
                Answer::Failed => {
                    stream
                        .write_all(&Reply::Failed(Some("upload_failed".into())).encode())
                        .unwrap();
                }
                Answer::Unanswered => drop(stream),
                Answer::Archived => {
                    let copy = archive.join(name);
                    fs::copy(data.join("pg_wal").join(name), &copy).unwrap();
                    fs::File::open(&copy).unwrap().sync_all().unwrap();
                    stream.write_all(&Reply::Ok.encode()).unwrap();
                }
            }
            log.lock().unwrap().push((request, answer));
        }
    });
    seen
}

fn wait_until(what: &str, cluster: &Cluster, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}:\n{}",
            cluster.log()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Writes a little and switches to a new segment; the answer is the segment it closed.
fn switch(cluster: &Cluster) -> String {
    cluster.psql(
        "postgres",
        "insert into archived select generate_series(1, 100)",
    );
    cluster.psql("postgres", "select pg_walfile_name(pg_switch_wal())")
}

fn archiver(cluster: &Cluster) -> (u64, u64, String) {
    let row = cluster.psql(
        "postgres",
        "select archived_count, failed_count, coalesce(last_archived_wal, '') from pg_stat_archiver",
    );
    let fields: Vec<&str> = row.split('|').collect();
    (
        fields[0].parse().unwrap(),
        fields[1].parse().unwrap(),
        fields[2].into(),
    )
}

fn quoted(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[test]
fn postgresql_marks_a_segment_archived_only_after_the_agent_confirmed_it() {
    let Some(bin) = binaries() else { return };
    let sockets = Directory::new("agent");
    let socket = sockets.path().join("archive.sock");
    let archive = Directory::new("archive");
    let command = format!(
        "{} %p",
        quoted(Path::new(env!("CARGO_BIN_EXE_pgcf-archive")))
    );
    let mut cluster = Cluster::init(
        &bin,
        &format!(
            "archive_mode = on\narchive_command = '{}'\n",
            command.replace('\'', "''")
        ),
        "local all all trust\n",
    );
    cluster.start(&[(
        pgcf_archive::SOCKET_ENVIRONMENT,
        OsStr::new(socket.as_os_str()),
    )]);
    cluster.psql("postgres", "create table archived (value integer)");

    // No agent: the archiver fails and keeps the segment.
    let first = switch(&cluster);
    wait_until("a failed archive attempt", &cluster, || {
        archiver(&cluster).1 >= 1
    });
    assert_eq!(archiver(&cluster).2, "");
    let ready = cluster
        .data
        .join("pg_wal/archive_status")
        .join(format!("{first}.ready"));
    assert!(ready.exists());

    // The agent refuses once and then drops a request unanswered: neither is success.
    let seen = agent(
        socket,
        cluster.data.clone(),
        archive.path().into(),
        vec![Answer::Failed, Answer::Unanswered],
    );
    let second = switch(&cluster);
    wait_until("both segments archived", &cluster, || {
        archiver(&cluster).2 == second
    });
    let seen = seen.lock().unwrap().clone();
    let name = |request: &Request| match request {
        Request::Archive { name } => name.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(
        seen.iter()
            .map(|(request, answer)| (name(request), *answer))
            .collect::<Vec<_>>()[..4],
        [
            (first.clone(), Answer::Failed),
            (first.clone(), Answer::Unanswered),
            (first.clone(), Answer::Archived),
            (second.clone(), Answer::Archived),
        ]
    );
    let (archived, failed, _) = archiver(&cluster);
    assert!(archived >= 2 && failed >= 3, "{archived} {failed}");
    assert!(!ready.exists());
    for segment in [&first, &second] {
        assert_eq!(
            fs::metadata(archive.path().join(segment)).unwrap().len(),
            16 * 1024 * 1024
        );
    }
    cluster.stop();
}

#[test]
fn a_request_postgresql_cannot_have_made_is_refused_before_the_agent() {
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_pgcf-archive"))
        .arg("base/1/1259")
        .env(
            pgcf_archive::SOCKET_ENVIRONMENT,
            "/nonexistent/archive.sock",
        )
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_pgcf-archive"))
        .arg("pg_wal/000000010000000000000001")
        .env(
            pgcf_archive::SOCKET_ENVIRONMENT,
            "/nonexistent/archive.sock",
        )
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
}
