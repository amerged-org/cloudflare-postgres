// SPDX-License-Identifier: Apache-2.0
//! Whether a database's PostgreSQL accepts connections, read from its `postmaster.pid` (plan 5.9
//! step 5). The unit is `Type=notify`, so systemd completes the start job at the postmaster's
//! `READY=1` and nothing polls, neither `pg_ctl` nor this. The postmaster writes its status line
//! just before it sends `READY=1`, so a finished job leaves exactly one file read to do: it names
//! the postmaster that is ready and the socket it listens on, which the gateway dials.
use std::path::{Path, PathBuf};

/// The data directory's lock file, below the volume's mount point.
pub const PID_FILE: &str = "data/postmaster.pid";

/// The status line of `postmaster.pid`, the eighth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Starting,
    Ready,
    Stopping,
    Standby,
}

/// The lines of `postmaster.pid` the agent uses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Postmaster {
    pub pid: u32,
    pub port: u16,
    /// The first Unix socket directory.
    pub socket_dir: PathBuf,
    pub status: Status,
}
impl Postmaster {
    /// The socket file clients dial.
    pub fn socket(&self) -> PathBuf {
        self.socket_dir.join(format!(".s.PGSQL.{}", self.port))
    }
}

/// Parses a PostgreSQL 18 `postmaster.pid`: pid, data directory, start time, port, socket
/// directory, listen address, shared memory key and status, one per line.
pub fn parse(text: &str) -> Result<Postmaster, &'static str> {
    const UNREADABLE: &str = "postmaster_pid_unreadable";
    let lines: Vec<&str> = text.split('\n').collect();
    // Eight lines, the last with its terminator.
    if lines.len() < 9 {
        return Err(UNREADABLE);
    }
    let pid: u32 = lines[0].parse().map_err(|_| UNREADABLE)?;
    let port: u16 = lines[3].parse().map_err(|_| UNREADABLE)?;
    let status = match lines[7].trim_end() {
        "starting" => Status::Starting,
        "ready" => Status::Ready,
        "stopping" => Status::Stopping,
        "standby" => Status::Standby,
        _ => return Err(UNREADABLE),
    };
    if pid == 0 || lines[4].is_empty() {
        return Err(UNREADABLE);
    }
    Ok(Postmaster {
        pid,
        port,
        socket_dir: PathBuf::from(lines[4]),
        status,
    })
}

/// The socket of the postmaster that is ready and is the unit's main process. `directory` is the
/// database's mount point, `main_pid` the unit's `MainPID`.
pub fn ready_socket(directory: &Path, main_pid: u32) -> Result<PathBuf, &'static str> {
    let text = std::fs::read_to_string(directory.join(PID_FILE)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "postmaster_pid_missing"
        } else {
            "postmaster_pid_unreadable"
        }
    })?;
    let postmaster = parse(&text)?;
    if postmaster.pid != main_pid {
        return Err("postmaster_pid_mismatch");
    }
    if postmaster.status != Status::Ready {
        return Err("postmaster_not_ready");
    }
    Ok(postmaster.socket())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `postmaster.pid` as PostgreSQL 18.6 wrote it (`cat -vet`: no trailing blank after the
    /// status other than the padding to eight characters).
    const READY: &str = "14405\n/tmp/pgcfprobe.X1N4/data\n1792277707\n5432\n/tmp/pgcfprobe.X1N4/s\n\n303966935 611581964\nready   \n";

    fn with_status(status: &str) -> String {
        READY.replace("ready   ", status)
    }

    #[test]
    fn a_real_postmaster_pid_yields_pid_port_socket_and_status() {
        let postmaster = parse(READY).unwrap();
        assert_eq!(postmaster.pid, 14405);
        assert_eq!(postmaster.port, 5432);
        assert_eq!(
            postmaster.socket_dir,
            PathBuf::from("/tmp/pgcfprobe.X1N4/s")
        );
        assert_eq!(postmaster.status, Status::Ready);
        assert_eq!(
            postmaster.socket(),
            PathBuf::from("/tmp/pgcfprobe.X1N4/s/.s.PGSQL.5432")
        );
    }

    #[test]
    fn the_four_statuses_are_read_with_their_padding() {
        for (text, status) in [
            ("starting", Status::Starting),
            ("ready   ", Status::Ready),
            ("stopping", Status::Stopping),
            ("standby ", Status::Standby),
        ] {
            assert_eq!(parse(&with_status(text)).unwrap().status, status, "{text}");
        }
    }

    #[test]
    fn anything_else_is_refused_not_guessed() {
        // PostgreSQL before 10 wrote no status line: the agent runs PostgreSQL 18 only.
        let short = "14405\n/data\n1792277707\n5432\n/s\n\n303966935 611581964\n";
        assert_eq!(parse(short), Err("postmaster_pid_unreadable"));
        assert_eq!(parse(""), Err("postmaster_pid_unreadable"));
        assert_eq!(
            parse(&with_status("running ")),
            Err("postmaster_pid_unreadable")
        );
        assert_eq!(
            parse(&READY.replace("14405", "abc")),
            Err("postmaster_pid_unreadable")
        );
        assert_eq!(
            parse(&READY.replace("\n5432\n", "\n99999\n")),
            Err("postmaster_pid_unreadable"),
            "a port above 65535"
        );
        assert_eq!(
            parse(&READY.replace("\n/tmp/pgcfprobe.X1N4/s\n", "\n\n")),
            Err("postmaster_pid_unreadable"),
            "PostgreSQL with no Unix socket directory serves the gateway nothing"
        );
        assert_eq!(
            parse(&READY.replace("14405", "0")),
            Err("postmaster_pid_unreadable"),
            "pid 0 is no process"
        );
    }

    /// A directory with `data/postmaster.pid` holding `text`.
    struct Volume(PathBuf);
    impl Volume {
        fn with(text: &str) -> Self {
            let path = crate::units::test_dir("ready");
            std::fs::create_dir_all(path.join("data")).unwrap();
            std::fs::write(path.join(PID_FILE), text).unwrap();
            Self(path)
        }
    }
    impl Drop for Volume {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ready_socket_needs_the_main_process_to_be_the_ready_postmaster() {
        let volume = Volume::with(READY);
        assert_eq!(
            ready_socket(&volume.0, 14405),
            Ok(PathBuf::from("/tmp/pgcfprobe.X1N4/s/.s.PGSQL.5432"))
        );
        assert_eq!(
            ready_socket(&volume.0, 14406),
            Err("postmaster_pid_mismatch"),
            "another process wrote the file"
        );
        let starting = Volume::with(&with_status("starting"));
        assert_eq!(
            ready_socket(&starting.0, 14405),
            Err("postmaster_not_ready")
        );
        let stopping = Volume::with(&with_status("stopping"));
        assert_eq!(
            ready_socket(&stopping.0, 14405),
            Err("postmaster_not_ready")
        );
        let standby = Volume::with(&with_status("standby "));
        assert_eq!(
            ready_socket(&standby.0, 14405),
            Err("postmaster_not_ready"),
            "a standby is not a database a tenant can write to"
        );
    }

    #[test]
    fn ready_socket_names_a_missing_or_unreadable_file() {
        let volume = Volume::with("");
        std::fs::remove_file(volume.0.join(PID_FILE)).unwrap();
        assert_eq!(ready_socket(&volume.0, 1), Err("postmaster_pid_missing"));
        let garbage = Volume::with("\u{0}\u{1}not a pid file");
        assert_eq!(
            ready_socket(&garbage.0, 1),
            Err("postmaster_pid_unreadable")
        );
    }

    /// The PostgreSQL 18 binaries to test with: `PGCF_TEST_POSTGRES_BINDIR` (CI), or an installed
    /// PostgreSQL 18 (Homebrew, PGDG).
    fn postgres_bin() -> Option<PathBuf> {
        std::env::var_os("PGCF_TEST_POSTGRES_BINDIR")
            .map(PathBuf::from)
            .into_iter()
            .chain(
                [
                    "/opt/homebrew/opt/postgresql@18/bin",
                    "/usr/lib/postgresql/18/bin",
                ]
                .map(PathBuf::from),
            )
            .find(|dir| dir.join("postgres").is_file())
    }

    /// A running postmaster, interrupted (fast shutdown, as the unit's `KillSignal=SIGINT`) and
    /// removed with the value.
    struct Server {
        root: PathBuf,
        child: std::process::Child,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = std::process::Command::new("kill")
                .args(["-INT", &self.child.id().to_string()])
                .status();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn a_real_postgresql_18_writes_the_pid_file_this_reads() {
        use std::process::{Command, Stdio};
        let Some(bin) = postgres_bin() else {
            eprintln!("skipped: no PostgreSQL 18 binaries (set PGCF_TEST_POSTGRES_BINDIR)");
            return;
        };
        let root = crate::units::test_dir("live");
        std::fs::create_dir_all(root.join("sockets")).unwrap();
        // PostgreSQL refuses to run as root.
        if std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&root).unwrap()) == 0 {
            eprintln!("skipped: PostgreSQL does not run as root");
            std::fs::remove_dir_all(&root).unwrap();
            return;
        }
        let initdb = Command::new(bin.join("initdb"))
            .args(["-D"])
            .arg(root.join("data"))
            .args(["-A", "trust", "-U", "postgres", "--no-sync", "--locale=C"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(initdb.success());
        // As the unit starts it: postgres itself, no pg_ctl, no TCP, the socket directory given.
        let child = Command::new(bin.join("postgres"))
            .arg("-D")
            .arg(root.join("data"))
            .args(["-c", "listen_addresses="])
            .arg("-c")
            .arg(format!(
                "unix_socket_directories={}",
                root.join("sockets").display()
            ))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let server = Server { root, child };
        // The test has no systemd to complete a start job, so it waits for the status line.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let socket = loop {
            match ready_socket(&server.root, pid) {
                Ok(socket) => break socket,
                Err(reason) => {
                    assert!(std::time::Instant::now() < deadline, "not ready: {reason}");
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        };
        assert_eq!(socket, server.root.join("sockets").join(".s.PGSQL.5432"));
        assert!(
            std::os::unix::net::UnixStream::connect(&socket).is_ok(),
            "a postmaster that reports ready accepts on the socket"
        );
        let postmaster =
            parse(&std::fs::read_to_string(server.root.join(PID_FILE)).unwrap()).unwrap();
        assert_eq!((postmaster.pid, postmaster.status), (pid, Status::Ready));
    }
}
