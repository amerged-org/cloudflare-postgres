// SPDX-License-Identifier: Apache-2.0
//! A real PostgreSQL 18 for the agent's tests. Every database behaviour the agent decides on is
//! exercised against the real server, started as the image's unit starts it (`postgres -D <data>
//! -c listen_addresses= -c unix_socket_directories=<run>/<id>`) on a cluster that the agent's own
//! `settings` configured. Only systemd's part of starting and stopping is the test's: it spawns
//! and signals the postmaster itself. Point `PGCF_TEST_POSTGRES_BINDIR` at the `bin` of a
//! PostgreSQL 18 (Homebrew's and Debian's paths are tried); without one the tests are skipped.
use crate::{
    layout::Layout,
    settings::{self, Settings},
    units::ready,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The `bin` directory of a PostgreSQL 18, if this machine has one.
pub fn bin_directory() -> Option<PathBuf> {
    let found = [
        std::env::var_os("PGCF_TEST_POSTGRES_BINDIR").map(PathBuf::from),
        Some("/opt/homebrew/opt/postgresql@18/bin".into()),
        Some("/usr/lib/postgresql/18/bin".into()),
    ]
    .into_iter()
    .flatten()
    .find(|bin| bin.join("initdb").exists());
    if found.is_none() {
        eprintln!("skipped: no PostgreSQL 18 (PGCF_TEST_POSTGRES_BINDIR)");
    }
    found
}

/// The name of the user the tests run as: the node's root of the tests, who is the agent.
pub fn current_user() -> String {
    let output = Command::new("id").arg("-un").output().expect("id");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A short, fresh directory for a test: a Unix socket path must fit in `sun_path`.
pub fn directory(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "pgcf-t-{}-{}-{label}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

/// A role password of the contract's shape (43 characters of the base64url alphabet), built at run
/// time: a literal of this shape is what the secret scanner looks for.
pub fn password(seed: u8) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    (0..43u8)
        .map(|i| char::from(ALPHABET[usize::from(i.wrapping_mul(7).wrapping_add(seed) % 64)]))
        .collect()
}

/// A database ID for a test: 20 characters.
pub fn database_id() -> String {
    format!("t{:019}", SEQUENCE.fetch_add(1, Ordering::Relaxed))
}

/// One cluster in the layout of a node: `<root>/s/db/<id>/data`, its socket in `<root>/r/<id>`.
pub struct Cluster {
    pub id: String,
    pub root: PathBuf,
    pub layout: Layout,
    child: Mutex<Option<Child>>,
}
impl Cluster {
    /// A cluster that archives to `archive_command` (`None` archives nothing), initialized and
    /// configured the way the agent does, not yet started.
    pub fn with_archive(label: &str, archive_command: Option<&Path>) -> Option<Self> {
        let bin = bin_directory()?;
        let root = directory(label);
        let layout = Layout {
            state: root.join("s"),
            run: root.join("r"),
            postgres_bin: bin,
            ..Layout::default()
        };
        let id = database_id();
        fs::create_dir_all(layout.volume(&id)).unwrap();
        fs::create_dir_all(layout.socket_directory(&id)).unwrap();
        let init = Command::new(layout.postgres_bin.join("initdb"))
            .args(["-D"])
            .arg(layout.data(&id))
            .args([
                "-U",
                settings::AGENT_ROLE,
                "-A",
                "trust",
                "--no-sync",
                "--no-locale",
                "-E",
                "UTF8",
            ])
            .stdout(Stdio::null())
            .output()
            .unwrap();
        assert!(
            init.status.success(),
            "initdb: {}",
            String::from_utf8_lossy(&init.stderr)
        );
        let cluster = Self {
            id,
            root,
            layout,
            child: Mutex::new(None),
        };
        cluster.configure(256, archive_command.and_then(Path::to_str));
        Some(cluster)
    }
    pub fn create(label: &str) -> Option<Self> {
        Self::with_archive(label, None)
    }
    /// Writes the agent's three files for a database of `memory_mib`.
    pub fn configure(&self, memory_mib: u64, archive_command: Option<&str>) {
        let socket = self.socket_directory();
        let conf = settings::postgresql_conf(&Settings {
            socket_directory: &socket,
            memory_mib,
            volume_bytes: 1 << 30,
            max_connections: 25,
            archive_timeout_seconds: 60,
            archive_command,
        })
        .expect("settings");
        let data = self.layout.data(&self.id);
        fs::write(data.join("postgresql.conf"), conf).unwrap();
        fs::write(data.join("pg_hba.conf"), settings::PG_HBA).unwrap();
        let user = current_user();
        fs::write(
            data.join("pg_ident.conf"),
            settings::pg_ident(&user, &user).unwrap(),
        )
        .unwrap();
    }
    /// Adds settings to `postgresql.conf` for the next start.
    pub fn append_conf(&self, text: &str) {
        use std::io::Write;
        let mut conf = fs::OpenOptions::new()
            .append(true)
            .open(self.data().join("postgresql.conf"))
            .unwrap();
        conf.write_all(text.as_bytes()).unwrap();
    }
    pub fn data(&self) -> PathBuf {
        self.layout.data(&self.id)
    }
    pub fn volume(&self) -> PathBuf {
        self.layout.volume(&self.id)
    }
    pub fn socket_directory(&self) -> PathBuf {
        self.layout.socket_directory(&self.id)
    }
    /// Starts the postmaster as the unit does and returns when it is ready (`READY=1`, which the
    /// postmaster's status line precedes).
    pub fn start(&self) {
        let child = Command::new(self.layout.postgres_bin.join("postgres"))
            .arg("-D")
            .arg(self.data())
            .arg("-c")
            .arg("listen_addresses=")
            .arg("-c")
            .arg(format!(
                "unix_socket_directories={}",
                self.socket_directory().display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(self.volume().join("postgres.log")).unwrap())
            .spawn()
            .unwrap();
        let pid = child.id();
        *self.child.lock().unwrap() = Some(child);
        let started = Instant::now();
        loop {
            if ready::ready_socket(&self.volume(), pid).is_ok() {
                return;
            }
            if let Some(status) = self
                .child
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .try_wait()
                .unwrap()
            {
                panic!("the postmaster ended with {status}:\n{}", self.log());
            }
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "the postmaster is not ready:\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    /// Stops the postmaster with SIGINT, a fast shutdown, as the unit's `KillSignal` does.
    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let signalled = Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status()
                .unwrap();
            assert!(signalled.success());
            child.wait().unwrap();
        }
    }
    /// SIGKILL: a crash that leaves the data directory as it was. The postmaster's System V
    /// segment is removed, which a crash would leave for the next start to find; a laptop has 32.
    pub fn kill(&self) {
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut child) = child {
            // A postmaster that ended already has nothing left to kill.
            let _ = child.kill();
            let _ = child.wait();
            self.release_shared_memory();
        }
    }
    /// Removes the System V segment that `postmaster.pid` names (key and id on its seventh line).
    fn release_shared_memory(&self) {
        let pid_file = fs::read_to_string(self.data().join("postmaster.pid")).unwrap_or_default();
        if let Some(id) = pid_file
            .lines()
            .nth(6)
            .and_then(|line| line.split_whitespace().nth(1))
        {
            let _ = Command::new("ipcrm").args(["-m", id]).output();
        }
    }
    pub fn log(&self) -> String {
        fs::read_to_string(self.volume().join("postgres.log")).unwrap_or_default()
    }
    /// The agent's session.
    pub async fn agent(&self) -> crate::postgres::Session {
        crate::postgres::agent(&self.socket_directory())
            .await
            .unwrap()
    }
}
impl Drop for Cluster {
    fn drop(&mut self) {
        // A fast shutdown removes the segment itself.
        let child = self.child.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(mut child) = child {
            let signalled = Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status()
                .is_ok_and(|status| status.success());
            let started = Instant::now();
            while signalled && started.elapsed() < Duration::from_secs(10) {
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
            self.release_shared_memory();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_cluster_that_was_killed_recovers_and_keeps_what_it_committed() {
        let Some(cluster) = Cluster::create("killed") else {
            return;
        };
        cluster.start();
        let agent = cluster.agent().await;
        agent
            .batch("CREATE TABLE t AS SELECT generate_series(1, 100) AS a")
            .await
            .unwrap();
        drop(agent);
        cluster.kill();
        cluster.start();
        assert!(
            cluster
                .log()
                .contains("database system was not properly shut down")
        );
        let agent = cluster.agent().await;
        let rows = agent.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 100);
    }
}
