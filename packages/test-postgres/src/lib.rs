// SPDX-License-Identifier: Apache-2.0
//! A real PostgreSQL for tests, started from the binaries `PGCF_TEST_POSTGRES_BINDIR` names (CI
//! installs the pinned PostgreSQL 18 there). It listens only on a Unix socket in its own
//! temporary directory, as a database on a node does, and is stopped and removed with the value.
use std::{
    ffi::OsStr,
    fs,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

/// The environment variable that names the PostgreSQL binaries.
pub const BINDIR: &str = "PGCF_TEST_POSTGRES_BINDIR";
/// The port of every cluster; each has its own socket directory.
pub const PORT: u16 = 5432;

/// The PostgreSQL binaries to test with, or none, and the caller skips. In CI they are required:
/// a missing directory fails the test instead of skipping it.
pub fn binaries() -> Option<PathBuf> {
    match std::env::var_os(BINDIR) {
        Some(directory) => {
            let directory = PathBuf::from(directory);
            assert!(
                directory.join("postgres").is_file(),
                "{BINDIR} names no PostgreSQL binaries"
            );
            Some(directory)
        }
        None if std::env::var_os("CI").is_some() => {
            panic!("{BINDIR} must name the PostgreSQL 18 binaries in CI")
        }
        None => {
            eprintln!("skipped: {BINDIR} names no PostgreSQL 18 binaries");
            None
        }
    }
}

/// A private temporary directory (mode 0700), removed with the value. Its path stays short: a
/// Unix socket path must fit in `sun_path`.
pub struct Directory(PathBuf);
impl Directory {
    pub fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "pgcf-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .expect("temporary directory");
        Self(path)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// One PostgreSQL cluster: a data directory, a socket directory and its server log.
pub struct Cluster {
    bin: PathBuf,
    pub data: PathBuf,
    pub sockets: PathBuf,
    log: PathBuf,
    process: Option<Child>,
    // Last: the directory goes after the server stopped.
    root: Directory,
}
impl Cluster {
    /// A new cluster whose superuser `postgres` is trusted. `configuration` is appended to
    /// `postgresql.conf`; `hba` replaces `pg_hba.conf`.
    pub fn init(bin: &Path, configuration: &str, hba: &str) -> Self {
        let root = Directory::new("pg");
        let data = root.path().join("data");
        let output = Command::new(bin.join("initdb"))
            .arg("--pgdata")
            .arg(&data)
            .args([
                "--username=postgres",
                "--auth=trust",
                "--no-locale",
                "--encoding=UTF8",
                "--no-instructions",
                "--no-sync",
            ])
            .output()
            .expect("initdb runs");
        assert!(
            output.status.success(),
            "initdb failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cluster = Self::adopt(bin, root, data);
        cluster.configure(configuration, hba);
        cluster
    }
    /// A cluster of the data directory `data` under `root`, such as a restored backup.
    pub fn adopt(bin: &Path, root: Directory, data: PathBuf) -> Self {
        let sockets = root.path().join("s");
        if !sockets.exists() {
            fs::DirBuilder::new()
                .mode(0o700)
                .create(&sockets)
                .expect("socket directory");
        }
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).expect("data mode");
        Self {
            bin: bin.into(),
            log: root.path().join("server.log"),
            data,
            sockets,
            process: None,
            root,
        }
    }
    /// Appends `configuration` to `postgresql.conf` and replaces `pg_hba.conf` with `hba`.
    pub fn configure(&self, configuration: &str, hba: &str) {
        let mut settings = fs::read_to_string(self.data.join("postgresql.conf")).unwrap();
        settings.push('\n');
        settings.push_str(configuration);
        settings.push('\n');
        fs::write(self.data.join("postgresql.conf"), settings).unwrap();
        fs::write(self.data.join("pg_hba.conf"), hba).unwrap();
    }
    pub fn root(&self) -> &Path {
        self.root.path()
    }
    /// Starts the postmaster with `environment` added to its own and waits until it accepts
    /// connections.
    pub fn start(&mut self, environment: &[(&str, &OsStr)]) {
        self.spawn(environment);
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if fs::read_to_string(self.data.join("postmaster.pid"))
                .is_ok_and(|pid| pid.lines().nth(7).is_some_and(|v| v.trim() == "ready"))
            {
                return;
            }
            if let Some(status) = self.process.as_mut().unwrap().try_wait().unwrap() {
                panic!("PostgreSQL exited with {status}:\n{}", self.log());
            }
            assert!(
                Instant::now() < deadline,
                "PostgreSQL did not start:\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    /// Starts the postmaster without waiting for it.
    pub fn spawn(&mut self, environment: &[(&str, &OsStr)]) {
        assert!(self.process.is_none(), "PostgreSQL already runs");
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .unwrap();
        let process = Command::new(self.bin.join("postgres"))
            .arg("-D")
            .arg(&self.data)
            .arg("-c")
            .arg("listen_addresses=")
            .arg("-c")
            .arg(format!(
                "unix_socket_directories={}",
                self.sockets.display()
            ))
            .arg("-c")
            .arg(format!("port={PORT}"))
            .envs(environment.iter().copied())
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .expect("postgres runs");
        self.process = Some(process);
    }
    /// The postmaster's PID.
    pub fn pid(&self) -> u32 {
        self.process.as_ref().expect("PostgreSQL runs").id()
    }
    /// The socket PostgreSQL listens on.
    pub fn socket(&self) -> PathBuf {
        self.sockets.join(format!(".s.PGSQL.{PORT}"))
    }
    /// Waits up to `bound` for the postmaster to exit by itself.
    pub fn wait_exit(&mut self, bound: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + bound;
        while Instant::now() < deadline {
            if let Some(status) = self.process.as_mut()?.try_wait().unwrap() {
                self.process = None;
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
    /// Stops PostgreSQL with a fast shutdown.
    pub fn stop(&mut self) {
        self.shutdown("fast");
    }
    fn shutdown(&mut self, mode: &str) {
        let Some(mut process) = self.process.take() else {
            return;
        };
        if process.try_wait().unwrap().is_none() {
            let _ = Command::new(self.bin.join("pg_ctl"))
                .arg("stop")
                .arg("-D")
                .arg(&self.data)
                .args(["-m", mode, "-w", "-t", "60"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        if process.try_wait().unwrap().is_none() {
            let _ = process.kill();
        }
        let _ = process.wait();
    }
    /// The answer of `sql` as `psql -At` prints it, without the final newline.
    pub fn psql(&self, user: &str, sql: &str) -> String {
        self.try_psql(user, sql)
            .unwrap_or_else(|error| panic!("psql failed: {error}"))
    }
    pub fn try_psql(&self, user: &str, sql: &str) -> Result<String, String> {
        let output = Command::new(self.bin.join("psql"))
            .args(["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-h"])
            .arg(&self.sockets)
            .args([
                "-p",
                &PORT.to_string(),
                "-U",
                user,
                "-d",
                "postgres",
                "-c",
                sql,
            ])
            .env_remove("PGPASSWORD")
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout)
                .trim_end_matches('\n')
                .to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).into_owned())
        }
    }
    /// Runs one of the cluster's client programs, such as `pg_basebackup`, against it.
    pub fn client(&self, program: &str) -> Command {
        let mut command = Command::new(self.bin.join(program));
        command
            .arg("-h")
            .arg(&self.sockets)
            .args(["-p", &PORT.to_string()]);
        command
    }
    /// The server log so far.
    pub fn log(&self) -> String {
        fs::read_to_string(&self.log).unwrap_or_default()
    }
}
impl Drop for Cluster {
    fn drop(&mut self) {
        self.shutdown("immediate");
    }
}
