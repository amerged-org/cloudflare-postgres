// SPDX-License-Identifier: Apache-2.0
//! The barman-cloud jobs of a database (plan 7.4-7.8): each runs as the database's own Linux user
//! in `pgcf-backup.slice`, as a transient unit the agent starts with `systemd-run`. The unit has
//! network access and a memory limit of its own; it sees its database's volume and nothing else of
//! the node's state, and it holds the one credential scoped to its database's archive prefix.
use crate::credentials::{Access, Credential, Scope};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::Semaphore,
    time::Instant,
};

/// The slice of all backup jobs (`infra/node-image`): CPU and IO weight 20, `MemoryMax=512M`.
pub const BACKUP_SLICE: &str = "pgcf-backup.slice";
/// Barman's server name for every database; the archive prefix already makes it unique.
pub const SERVER_NAME: &str = "database";
/// What the agent hides from a job: every other database's volume and the agent's own state.
pub const STATE_DIRECTORY: &str = "/var/lib/pgcf";
pub const AGENT_RUN_DIRECTORY: &str = "/run/pgcf/agent";
/// Barman's temporary files go to the node's disk, not to a tmpfs.
pub const TEMPORARY_DIRECTORY: &str = "/var/tmp";
/// The role of a base backup (plan 7.6) and the database it connects to. barman 3.20 refuses the
/// backup unless the role has `pg_checkpoint`, `pg_monitor` and `EXECUTE` on `pg_backup_start`,
/// `pg_backup_stop`, `pg_switch_wal` and `pg_create_restore_point` (the lab's `roles.sql`); the
/// last two are not in the role list of plan 7.6.
pub const BACKUP_ROLE: &str = "pgcf_backup";
pub const BACKUP_DATABASE: &str = "postgres";

// The limits below are plan defaults from the Stage 1 lab on EU1 (plan 7.5, 4.5). The node policy
// of the desired page sets them in operation (`Limits::from_policy`); all of them sit here.

/// Uploads and fetches of WAL that run at once. Plan 4.5 gives the backup jobs 512 MiB: two WAL
/// calls and one base backup or restore.
pub const WAL_JOBS: usize = 2;
/// Base backups, restores and backup listings that run at once.
pub const BIG_JOBS: usize = 1;
/// Lab, one `barman-cloud-wal-archive` call: 0.45-1.04 CPU-s and about 75 MiB cgroup peak (110
/// calls: RSS 61-73 MiB, cgroup peak 46-76 MiB). 128 MiB leaves the margin of a Python/boto3
/// process; page cache beyond it is reclaimed by the kernel.
pub const WAL_UPLOAD_MEMORY_MIB: u64 = 128;
/// Lab, `barman-cloud-wal-restore -p 4`: RSS 59-65 MiB, cgroup peak 45-118 MiB (98 calls).
pub const WAL_FETCH_MEMORY_MIB: u64 = 128;
/// Lab, `barman-cloud-backup -J 2` and `barman-cloud-restore`: about 72 MiB RSS (63 MiB for the
/// restore). The cgroup peak of a 557 MB cluster grew to the limit of 400 MiB through page cache
/// and the job still succeeded, so the limit is not the working set. 128 + 128 + 256 fills the
/// slice's 512 MiB exactly.
pub const BASE_BACKUP_MEMORY_MIB: u64 = 256;
/// Parallel workers of a base backup (`-J`); the lab used 2 for every measurement above.
pub const BACKUP_WORKERS: u32 = 2;
/// WAL files `barman-cloud-wal-restore` fetches ahead into the operation's spool (`-p`, plan 7.8).
pub const WAL_PREFETCH: u32 = 4;
/// A base backup, restore or listing may run this long. The lab moved 557 MB in 65 s (about
/// 8.5 MB/s); this bound is that rate over 180 GB. Stage 5 measures a large database.
pub const BIG_JOB_BOUND: Duration = Duration::from_secs(6 * 3600);
/// How long a job that outlived its `RuntimeMaxSec` may take to be reported before the agent
/// kills its `systemd-run` client.
const KILL_GRACE: Duration = Duration::from_secs(10);
/// What the agent keeps of a job's output.
const STDOUT_LIMIT: usize = 4 << 20;
const STDERR_TAIL: usize = 4 << 10;

/// The kinds of job and their limits, as the node policy sets them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub wal_jobs: usize,
    pub big_jobs: usize,
    pub wal_upload_mib: u64,
    pub wal_fetch_mib: u64,
    pub base_backup_mib: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            wal_jobs: WAL_JOBS,
            big_jobs: BIG_JOBS,
            wal_upload_mib: WAL_UPLOAD_MEMORY_MIB,
            wal_fetch_mib: WAL_FETCH_MEMORY_MIB,
            base_backup_mib: BASE_BACKUP_MEMORY_MIB,
        }
    }
}
impl Limits {
    /// The limits of `NodePolicy.backup` in the node contract.
    pub fn from_policy(backup: &Value) -> Option<Self> {
        let positive = |value: &Value| value.as_u64().filter(|value| *value > 0);
        let memory = &backup["memory_mib"];
        Some(Self {
            wal_jobs: usize::try_from(positive(&backup["wal_uploads"])?).ok()?,
            big_jobs: usize::try_from(positive(&backup["base_backups"])?).ok()?,
            wal_upload_mib: positive(&memory["wal_upload"])?,
            wal_fetch_mib: positive(&memory["wal_fetch"])?,
            base_backup_mib: positive(&memory["base_backup"])?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    WalArchive,
    WalFetch,
    BaseBackup,
    Restore,
    BackupList,
}
impl Kind {
    fn label(self) -> &'static str {
        match self {
            Self::WalArchive => "wal-archive",
            Self::WalFetch => "wal-fetch",
            Self::BaseBackup => "backup",
            Self::Restore => "restore",
            Self::BackupList => "backup-list",
        }
    }
    fn wal(self) -> bool {
        matches!(self, Self::WalArchive | Self::WalFetch)
    }
    pub fn memory_mib(self, limits: &Limits) -> u64 {
        match self {
            Self::WalArchive => limits.wal_upload_mib,
            Self::WalFetch => limits.wal_fetch_mib,
            Self::BaseBackup | Self::Restore | Self::BackupList => limits.base_backup_mib,
        }
    }
}

/// The database a job serves: its Linux user (and group of the same name), its volume and the
/// directory of its PostgreSQL socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Database {
    pub id: String,
    pub user: String,
    pub volume: PathBuf,
    pub socket_directory: PathBuf,
}
impl Database {
    pub fn data_directory(&self) -> PathBuf {
        self.volume.join("data")
    }
}

/// One archive path in R2 and the credential scope that reaches it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Store {
    /// `s3://<bucket>/<region>/<database>/g<generation>-<operation>`.
    pub destination: String,
    pub endpoint_url: String,
    pub scope: Scope,
}
impl Store {
    pub fn new(archive_path: &str, endpoint_url: &str, access: Access) -> Option<Self> {
        Some(Self {
            scope: Scope::for_archive(archive_path, access)?,
            destination: archive_path.into(),
            endpoint_url: endpoint_url.into(),
        })
    }
}

/// A barman-cloud command line and how long it may run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub kind: Kind,
    pub program: &'static str,
    pub arguments: Vec<String>,
    pub timeout: Duration,
    /// Whether the job writes into its database's volume (a restore, a fetch).
    pub writable: bool,
}
fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
impl Job {
    /// Uploads `pg_wal/<name>` of the database, gzip-compressed; barman answers 0 once R2 holds
    /// the object.
    pub fn wal_archive(store: &Store, db: &Database, name: &str, timeout: Duration) -> Self {
        Self {
            kind: Kind::WalArchive,
            program: "barman-cloud-wal-archive",
            arguments: [
                "--gzip",
                "--endpoint-url",
                &store.endpoint_url,
                &store.destination,
                SERVER_NAME,
                &text(&db.data_directory().join("pg_wal").join(name)),
            ]
            .map(String::from)
            .into(),
            timeout,
            writable: false,
        }
    }
    /// Fetches `name` to `destination`, with the files after it prefetched into `spool`, a
    /// directory of this operation alone.
    pub fn wal_fetch(
        store: &Store,
        spool: &Path,
        name: &str,
        destination: &Path,
        timeout: Duration,
    ) -> Self {
        Self {
            kind: Kind::WalFetch,
            program: "barman-cloud-wal-restore",
            arguments: [
                "-p",
                &WAL_PREFETCH.to_string(),
                "--spool-dir",
                &text(spool),
                "--endpoint-url",
                &store.endpoint_url,
                &store.destination,
                SERVER_NAME,
                name,
                &text(destination),
            ]
            .map(String::from)
            .into(),
            timeout,
            writable: true,
        }
    }
    /// A gzip base backup over the database's socket as the backup role (plan 7.6).
    pub fn base_backup(store: &Store, db: &Database) -> Self {
        Self {
            kind: Kind::BaseBackup,
            program: "barman-cloud-backup",
            arguments: [
                "--gzip",
                "--immediate-checkpoint",
                "-J",
                &BACKUP_WORKERS.to_string(),
                "--host",
                &text(&db.socket_directory),
                "-U",
                BACKUP_ROLE,
                "-d",
                BACKUP_DATABASE,
                "--endpoint-url",
                &store.endpoint_url,
                &store.destination,
                SERVER_NAME,
            ]
            .map(String::from)
            .into(),
            timeout: BIG_JOB_BOUND,
            writable: false,
        }
    }
    /// Restores `backup_id` into the empty `destination`.
    pub fn restore(store: &Store, backup_id: &str, destination: &Path) -> Self {
        Self {
            kind: Kind::Restore,
            program: "barman-cloud-restore",
            arguments: [
                "--endpoint-url",
                &store.endpoint_url,
                &store.destination,
                SERVER_NAME,
                backup_id,
                &text(destination),
            ]
            .map(String::from)
            .into(),
            timeout: BIG_JOB_BOUND,
            writable: true,
        }
    }
    /// Lists the backups of the archive as JSON.
    pub fn backup_list(store: &Store) -> Self {
        Self {
            kind: Kind::BackupList,
            program: "barman-cloud-backup-list",
            arguments: [
                "--format",
                "json",
                "--endpoint-url",
                &store.endpoint_url,
                &store.destination,
                SERVER_NAME,
            ]
            .map(String::from)
            .into(),
            timeout: BIG_JOB_BOUND,
            writable: false,
        }
    }
}

/// The `systemd-run` arguments (without the program) of `job` as the unit `unit`.
pub fn systemd_run_arguments(
    unit: &str,
    db: &Database,
    job: &Job,
    memory_mib: u64,
    environment_file: &Path,
    barman: &Path,
) -> Vec<String> {
    let volume = text(&db.volume);
    let property = |value: String| ["-p".to_string(), value];
    let mut arguments: Vec<String> = [
        "--wait",
        "--pipe",
        "--collect",
        &format!("--unit={unit}"),
        &format!("--uid={}", db.user),
        &format!("--gid={}", db.user),
        &format!("--slice={BACKUP_SLICE}"),
    ]
    .map(String::from)
    .into();
    // The unit ends itself at the bound, so that no job outlives the answer the agent gave.
    let seconds = job.timeout.as_secs() + u64::from(job.timeout.subsec_nanos() > 0);
    let mut properties = vec![
        format!("MemoryMax={memory_mib}M"),
        "MemorySwapMax=0".into(),
        format!("RuntimeMaxSec={seconds}"),
        "TimeoutStopSec=5".into(),
        format!("EnvironmentFile={}", text(environment_file)),
        "ProtectSystem=strict".into(),
        "ProtectHome=yes".into(),
        "PrivateTmp=yes".into(),
        "NoNewPrivileges=yes".into(),
        "UMask=0077".into(),
        // Every other database and the agent's state vanish; the job's own volume stays.
        format!("TemporaryFileSystem={STATE_DIRECTORY}:ro"),
        format!("InaccessiblePaths=-{AGENT_RUN_DIRECTORY}"),
    ];
    if job.writable {
        properties.push(format!("BindPaths={volume}"));
        properties.push(format!("ReadWritePaths={volume}"));
    } else {
        properties.push(format!("BindReadOnlyPaths={volume}"));
    }
    arguments.extend(properties.into_iter().flat_map(property));
    arguments.push("--".into());
    arguments.push(text(&barman.join(job.program)));
    arguments.extend(job.arguments.iter().cloned());
    arguments
}
/// The environment file of a job: the credential and the temporary directory.
pub fn environment_file(credential: &Credential) -> String {
    credential
        .environment()
        .iter()
        .map(|(name, value)| format!("{name}={value}\n"))
        .chain([format!("TMPDIR={TEMPORARY_DIRECTORY}\n")])
        .collect()
}

/// How a job ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// The command's own exit status (`systemd-run --wait` passes it on).
    Code(i32),
    /// The job outlived its bound.
    TimedOut,
    /// The client was killed from outside.
    Signal,
    /// The agent could not start it.
    Unstartable,
}
#[derive(Clone, Debug)]
pub struct Outcome {
    pub exit: Exit,
    pub stdout: String,
    /// The last of what the command wrote to stderr.
    pub stderr: String,
    pub elapsed: Duration,
}
impl Outcome {
    pub fn succeeded(&self) -> bool {
        self.exit == Exit::Code(0)
    }
}

/// Starts the units of the jobs.
pub struct Runner {
    systemd_run: PathBuf,
    barman: PathBuf,
    scratch: PathBuf,
    grace: Duration,
    sequence: AtomicU64,
}
impl Runner {
    /// `systemd_run` is the program, `barman` the directory of the barman-cloud commands and
    /// `scratch` a directory only the agent reads, where each job's environment file lives while
    /// it runs.
    pub fn new(
        systemd_run: impl Into<PathBuf>,
        barman: impl Into<PathBuf>,
        scratch: impl Into<PathBuf>,
    ) -> Self {
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        Self {
            systemd_run: systemd_run.into(),
            barman: barman.into(),
            scratch: scratch.into(),
            grace: KILL_GRACE,
            // Unit names stay unique across agent restarts.
            sequence: AtomicU64::new(start),
        }
    }
    /// How long after a job's bound the agent kills its client.
    pub fn with_grace(self, grace: Duration) -> Self {
        Self { grace, ..self }
    }
    /// Runs `job` as the database with `credential`, and returns when the unit has ended.
    pub async fn run(
        &self,
        db: &Database,
        job: &Job,
        memory_mib: u64,
        credential: &Credential,
    ) -> Outcome {
        let started = std::time::Instant::now();
        let unit = format!(
            "pgcf-job-{}-{}-{}",
            job.kind.label(),
            db.id,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let directory = self.scratch.join(&unit);
        let environment = directory.join("environment");
        let (exit, stdout, stderr) =
            match write_private(&directory, &environment, &environment_file(credential)) {
                Ok(()) => {
                    let arguments = systemd_run_arguments(
                        &unit,
                        db,
                        job,
                        memory_mib,
                        &environment,
                        &self.barman,
                    );
                    self.start(arguments, job.timeout).await
                }
                Err(error) => (Exit::Unstartable, String::new(), error.to_string()),
            };
        let _ = std::fs::remove_dir_all(&directory);
        Outcome {
            exit,
            stdout,
            stderr,
            elapsed: started.elapsed(),
        }
    }
    async fn start(&self, arguments: Vec<String>, timeout: Duration) -> (Exit, String, String) {
        let mut child = match tokio::process::Command::new(&self.systemd_run)
            .args(arguments)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(error) => return (Exit::Unstartable, String::new(), error.to_string()),
        };
        let stdout = tokio::spawn(capture(
            child.stdout.take().expect("piped"),
            STDOUT_LIMIT,
            false,
        ));
        let stderr = tokio::spawn(capture(
            child.stderr.take().expect("piped"),
            STDERR_TAIL,
            true,
        ));
        // The unit ends itself at its bound (`RuntimeMaxSec`) and the client reports it; a client
        // that does not is killed, with the unit it left to that timer.
        let waited = match tokio::time::timeout(timeout + self.grace, child.wait()).await {
            Ok(waited) => waited,
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                stdout.abort();
                stderr.abort();
                return (Exit::TimedOut, String::new(), String::new());
            }
        };
        let text = |bytes: Result<Vec<u8>, tokio::task::JoinError>| {
            String::from_utf8_lossy(&bytes.unwrap_or_default()).into_owned()
        };
        // A command that left a process holding its pipes does not hold the agent too.
        let end = Duration::from_secs(2);
        let stdout = text(
            tokio::time::timeout(end, stdout)
                .await
                .unwrap_or(Ok(Vec::new())),
        );
        let stderr = text(
            tokio::time::timeout(end, stderr)
                .await
                .unwrap_or(Ok(Vec::new())),
        );
        let (stderr, result) = unit_report(&stderr);
        let exit = match waited {
            // The client's status is the command's, except that a unit the bound ended is
            // status 1 like a command that failed with 1.
            Ok(status) => match status.code() {
                Some(code) if code != 0 && result == Some(TIMEOUT_RESULT) => Exit::TimedOut,
                Some(code) => Exit::Code(code),
                None => Exit::Signal,
            },
            Err(_) => Exit::Unstartable,
        };
        (exit, stdout, stderr.to_string())
    }
}

/// What `systemd-run --wait` reports on stderr unless it is `--quiet`: a line `Running as unit:`
/// first and, after the command's own output, `Finished with result: <result>` and the unit's
/// accounting (systemd 257 on Debian 13). The result is `success`, `exit-code`, `signal`,
/// `oom-kill` or, for a unit `RuntimeMaxSec` ended, `timeout`.
const REPORT_RESULT: &str = "Finished with result: ";
const TIMEOUT_RESULT: &str = "timeout";
/// The command's stderr without the report, and the result the report names. The report is the
/// last thing on stderr, so the last such line is systemd's and not the command's.
fn unit_report(stderr: &str) -> (&str, Option<&str>) {
    let stderr = match stderr.strip_prefix("Running as unit: ") {
        Some(rest) => rest.split_once('\n').map_or("", |(_, rest)| rest),
        None => stderr,
    };
    let at = stderr
        .rfind(REPORT_RESULT)
        .filter(|at| *at == 0 || stderr.as_bytes()[*at - 1] == b'\n');
    match at {
        Some(at) => (
            &stderr[..at],
            stderr[at + REPORT_RESULT.len()..]
                .lines()
                .next()
                .map(str::trim),
        ),
        None => (stderr, None),
    }
}

/// A private directory with one file in it: the directory 0700, the file 0600.
fn write_private(directory: &Path, file: &Path, content: &str) -> std::io::Result<()> {
    use std::{
        io::Write,
        os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    };
    if let Some(parent) = directory.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    std::fs::DirBuilder::new().mode(0o700).create(directory)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(file)?
        .write_all(content.as_bytes())
}
/// Reads a pipe to its end and keeps its first or last `limit` bytes.
async fn capture(mut reader: impl AsyncRead + Unpin, limit: usize, tail: bool) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(read @ 1..) = reader.read(&mut chunk).await {
        if tail {
            kept.extend_from_slice(&chunk[..read]);
            if kept.len() > limit {
                kept.drain(..kept.len() - limit);
            }
        } else if kept.len() < limit {
            kept.extend_from_slice(&chunk[..read.min(limit - kept.len())]);
        }
    }
    kept
}

/// No slot for the job before its deadline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Busy;

/// The jobs of a node, within the limits of its policy.
pub struct Jobs {
    runner: Runner,
    limits: Limits,
    wal: Semaphore,
    big: Semaphore,
}
impl Jobs {
    pub fn new(runner: Runner, limits: Limits) -> Self {
        Self {
            wal: Semaphore::new(limits.wal_jobs),
            big: Semaphore::new(limits.big_jobs),
            runner,
            limits,
        }
    }
    /// Waits for a slot of the job's kind, then runs it. Both the wait and the run end at
    /// `deadline`, when there is one.
    pub async fn run(
        &self,
        db: &Database,
        job: &Job,
        credential: &Credential,
        deadline: Option<Instant>,
    ) -> Result<Outcome, Busy> {
        let slots = if job.kind.wal() { &self.wal } else { &self.big };
        let permit = match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, slots.acquire())
                .await
                .map_err(|_| Busy)?,
            None => slots.acquire().await,
        }
        .map_err(|_| Busy)?;
        let mut job = job.clone();
        if let Some(deadline) = deadline {
            let left = deadline
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .ok_or(Busy)?;
            job.timeout = job.timeout.min(left);
        }
        let memory = job.kind.memory_mib(&self.limits);
        let outcome = self.runner.run(db, &job, memory, credential).await;
        drop(permit);
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{archive::protocol::AGENT_BOUND, credentials::Credential};

    fn database() -> Database {
        Database {
            id: "abcdefghijklmnopqrst".into(),
            user: "pgcf-abcdefghijklmnopqrst".into(),
            volume: "/var/lib/pgcf/db/abcdefghijklmnopqrst".into(),
            socket_directory: "/run/pgcf/abcdefghijklmnopqrst".into(),
        }
    }
    fn store(operation: char) -> Store {
        Store::new(
            &format!(
                "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g1-op_{}",
                operation.to_string().repeat(20)
            ),
            "https://account.r2.cloudflarestorage.com",
            Access::ReadWrite,
        )
        .unwrap()
    }
    fn args(job: &Job) -> Vec<&str> {
        job.arguments.iter().map(String::as_str).collect()
    }
    const DEST: &str = "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g1-op_aaaaaaaaaaaaaaaaaaaa";
    const ENDPOINT: &str = "https://account.r2.cloudflarestorage.com";

    #[test]
    fn the_limits_fill_the_backup_budget_of_the_plan_and_no_more() {
        let limits = Limits::default();
        assert_eq!((limits.wal_jobs, limits.big_jobs), (2, 1));
        // Plan 4.5: two WAL calls and one base backup or restore in 512 MiB.
        let busiest = limits.wal_jobs as u64 * limits.wal_upload_mib.max(limits.wal_fetch_mib)
            + limits.big_jobs as u64 * limits.base_backup_mib;
        assert_eq!(busiest, 512);
        assert_eq!(Kind::WalArchive.memory_mib(&limits), 128);
        assert_eq!(Kind::WalFetch.memory_mib(&limits), 128);
        for kind in [Kind::BaseBackup, Kind::Restore, Kind::BackupList] {
            assert_eq!(kind.memory_mib(&limits), 256);
        }
    }

    #[test]
    fn the_node_policy_sets_the_limits() {
        let policy = serde_json::json!({
            "wal_uploads": 3, "base_backups": 2,
            "memory_mib": {"wal_upload": 96, "wal_fetch": 160, "base_backup": 300}
        });
        assert_eq!(
            Limits::from_policy(&policy),
            Some(Limits {
                wal_jobs: 3,
                big_jobs: 2,
                wal_upload_mib: 96,
                wal_fetch_mib: 160,
                base_backup_mib: 300
            })
        );
        for broken in [
            serde_json::json!({}),
            serde_json::json!({"wal_uploads": 0, "base_backups": 1, "memory_mib": {"wal_upload": 1, "wal_fetch": 1, "base_backup": 1}}),
            serde_json::json!({"wal_uploads": 1, "base_backups": 1, "memory_mib": {"wal_upload": 96}}),
        ] {
            assert_eq!(Limits::from_policy(&broken), None);
        }
    }

    #[test]
    fn the_barman_commands_are_the_ones_the_lab_ran() {
        let db = database();
        let store = store('a');
        let wal = Job::wal_archive(&store, &db, "000000010000000000000003", AGENT_BOUND);
        assert_eq!(wal.program, "barman-cloud-wal-archive");
        assert_eq!(
            args(&wal),
            [
                "--gzip",
                "--endpoint-url",
                ENDPOINT,
                DEST,
                "database",
                "/var/lib/pgcf/db/abcdefghijklmnopqrst/data/pg_wal/000000010000000000000003"
            ]
        );
        assert!(!wal.writable);
        let fetch = Job::wal_fetch(
            &store,
            Path::new("/var/lib/pgcf/db/abcdefghijklmnopqrst/spool-op_bbbbbbbbbbbbbbbbbbbb"),
            "00000002.history",
            Path::new("/var/lib/pgcf/db/abcdefghijklmnopqrst/data/pg_wal/RECOVERYHISTORY"),
            AGENT_BOUND,
        );
        assert_eq!(fetch.program, "barman-cloud-wal-restore");
        assert_eq!(
            args(&fetch),
            [
                "-p",
                "4",
                "--spool-dir",
                "/var/lib/pgcf/db/abcdefghijklmnopqrst/spool-op_bbbbbbbbbbbbbbbbbbbb",
                "--endpoint-url",
                ENDPOINT,
                DEST,
                "database",
                "00000002.history",
                "/var/lib/pgcf/db/abcdefghijklmnopqrst/data/pg_wal/RECOVERYHISTORY"
            ]
        );
        assert!(fetch.writable);
        let backup = Job::base_backup(&store, &db);
        assert_eq!(backup.program, "barman-cloud-backup");
        assert_eq!(
            args(&backup),
            [
                "--gzip",
                "--immediate-checkpoint",
                "-J",
                "2",
                "--host",
                "/run/pgcf/abcdefghijklmnopqrst",
                "-U",
                "pgcf_backup",
                "-d",
                "postgres",
                "--endpoint-url",
                ENDPOINT,
                DEST,
                "database"
            ]
        );
        assert!(!backup.writable);
        let restore = Job::restore(
            &store,
            "20261017T225342",
            Path::new("/var/lib/pgcf/db/abcdefghijklmnopqrst/data"),
        );
        assert_eq!(restore.program, "barman-cloud-restore");
        assert_eq!(
            args(&restore),
            [
                "--endpoint-url",
                ENDPOINT,
                DEST,
                "database",
                "20261017T225342",
                "/var/lib/pgcf/db/abcdefghijklmnopqrst/data"
            ]
        );
        assert!(restore.writable);
        let list = Job::backup_list(&store);
        assert_eq!(list.program, "barman-cloud-backup-list");
        assert_eq!(
            args(&list),
            [
                "--format",
                "json",
                "--endpoint-url",
                ENDPOINT,
                DEST,
                "database"
            ]
        );
        // The agent never deletes in R2: no job is a delete command.
        for job in [&wal, &fetch, &backup, &restore, &list] {
            assert!(!job.program.contains("delete") && !job.program.contains("keep"));
        }
        // The long jobs have a bound of their own; the WAL jobs the protocol's.
        assert_eq!(wal.timeout, AGENT_BOUND);
        assert_eq!(backup.timeout, BIG_JOB_BOUND);
        assert_eq!(restore.timeout, BIG_JOB_BOUND);
        assert_eq!(list.timeout, BIG_JOB_BOUND);
    }

    #[test]
    fn a_unit_runs_as_the_database_in_the_backup_slice_and_sees_only_its_volume() {
        let db = database();
        let store = store('a');
        let wal = Job::wal_archive(
            &store,
            &db,
            "000000010000000000000003",
            Duration::from_secs(60),
        );
        let arguments = systemd_run_arguments(
            "pgcf-job-wal-archive-abcdefghijklmnopqrst-7",
            &db,
            &wal,
            128,
            Path::new("/run/pgcf/agent/jobs/7/environment"),
            Path::new("/usr/bin"),
        );
        let expected: Vec<String> = [
            "--wait",
            "--pipe",
            "--collect",
            "--unit=pgcf-job-wal-archive-abcdefghijklmnopqrst-7",
            "--uid=pgcf-abcdefghijklmnopqrst",
            "--gid=pgcf-abcdefghijklmnopqrst",
            "--slice=pgcf-backup.slice",
            "-p",
            "MemoryMax=128M",
            "-p",
            "MemorySwapMax=0",
            "-p",
            "RuntimeMaxSec=60",
            "-p",
            "TimeoutStopSec=5",
            "-p",
            "EnvironmentFile=/run/pgcf/agent/jobs/7/environment",
            "-p",
            "ProtectSystem=strict",
            "-p",
            "ProtectHome=yes",
            "-p",
            "PrivateTmp=yes",
            "-p",
            "NoNewPrivileges=yes",
            "-p",
            "UMask=0077",
            "-p",
            "TemporaryFileSystem=/var/lib/pgcf:ro",
            "-p",
            "InaccessiblePaths=-/run/pgcf/agent",
            "-p",
            "BindReadOnlyPaths=/var/lib/pgcf/db/abcdefghijklmnopqrst",
            "--",
            "/usr/bin/barman-cloud-wal-archive",
        ]
        .iter()
        .map(|argument| argument.to_string())
        .chain(wal.arguments.iter().cloned())
        .collect();
        assert_eq!(arguments, expected);
        // A job that writes gets its volume read-write and nothing else.
        let restore = Job::restore(&store, "20261017T225342", &db.data_directory());
        let writing = systemd_run_arguments(
            "unit",
            &db,
            &restore,
            256,
            Path::new("/e"),
            Path::new("/usr/bin"),
        );
        assert!(writing.contains(&"MemoryMax=256M".to_string()));
        assert!(writing.contains(&"BindPaths=/var/lib/pgcf/db/abcdefghijklmnopqrst".to_string()));
        assert!(
            writing.contains(&"ReadWritePaths=/var/lib/pgcf/db/abcdefghijklmnopqrst".to_string())
        );
        assert!(!writing.iter().any(|a| a.starts_with("BindReadOnlyPaths")));
        // A bound is whole seconds, rounded up.
        let short = Job {
            timeout: Duration::from_millis(1500),
            ..wal
        };
        let bound = systemd_run_arguments(
            "u",
            &db,
            &short,
            128,
            Path::new("/e"),
            Path::new("/usr/bin"),
        );
        assert!(bound.contains(&"RuntimeMaxSec=2".to_string()));
    }

    #[test]
    fn the_report_of_systemd_run_is_cut_off_and_the_result_it_names_is_read() {
        // As systemd 257 printed it for a unit that `RuntimeMaxSec` ended.
        let report = "Finished with result: timeout\nMain processes terminated with: code=killed, status=15/TERM\nService runtime: 2.233s\nCPU time consumed: 7ms\nMemory peak: 1.7M (swap: 0B)\n";
        let stderr = format!(
            "Running as unit: pgcf-job-backup-x-7.service; invocation ID: ab\ncommand said this\n{report}"
        );
        assert_eq!(
            unit_report(&stderr),
            ("command said this\n", Some("timeout"))
        );
        // The end of a long stderr: the first line is cut, the report is whole.
        assert_eq!(
            unit_report(&format!("ng said this\n{report}")),
            ("ng said this\n", Some("timeout"))
        );
        assert_eq!(
            unit_report("Finished with result: exit-code\nService runtime: 1s\n"),
            ("", Some("exit-code"))
        );
        // No report: a command alone, or a client that never got to print one.
        assert_eq!(
            unit_report("only the command\n"),
            ("only the command\n", None)
        );
        assert_eq!(unit_report(""), ("", None));
        // A command's line is not the report, wherever it stands, since the report comes last.
        let forged = "Finished with result: timeout\n";
        assert_eq!(
            unit_report(&format!(
                "{forged}x {forged}Finished with result: exit-code\nService runtime: 1s\n"
            )),
            (format!("{forged}x {forged}").as_str(), Some("exit-code"))
        );
        assert_eq!(unit_report("x Finished with result: timeout\n").1, None);
    }

    #[test]
    fn the_credential_travels_in_the_environment_file_and_never_in_an_argument() {
        let credential =
            Credential::delivered("keyid", "secret/value+1=", "token.part-2_~", 9).unwrap();
        assert_eq!(
            environment_file(&credential),
            "AWS_ACCESS_KEY_ID=keyid\nAWS_SECRET_ACCESS_KEY=secret/value+1=\nAWS_SESSION_TOKEN=token.part-2_~\nAWS_DEFAULT_REGION=auto\nTMPDIR=/var/tmp\n"
        );
        let db = database();
        let job = Job::wal_archive(&store('a'), &db, "000000010000000000000003", AGENT_BOUND);
        let arguments =
            systemd_run_arguments("u", &db, &job, 128, Path::new("/e"), Path::new("/usr/bin"));
        let all = arguments.join(" ");
        for secret in ["secret/value+1=", "token.part-2_~"] {
            assert!(!all.contains(secret));
        }
    }

    mod running {
        use super::*;
        use crate::archive::test_support::{Fixture, database as database_in, directory};
        use std::os::unix::fs::PermissionsExt;

        fn credential() -> Credential {
            Credential::delivered("fixturekeyid", "fixturesecret", "fixturetoken", 1 << 40).unwrap()
        }
        fn wal_job(volume: &Path, timeout: Duration) -> (Database, Job) {
            let db = database_in(volume);
            let job = Job::wal_archive(&store('a'), &db, "000000010000000000000001", timeout);
            (db, job)
        }
        /// A volume with the segment `000000010000000000000001` in its `pg_wal`.
        fn volume() -> PathBuf {
            let volume = directory("volume");
            std::fs::create_dir_all(volume.join("data/pg_wal")).unwrap();
            std::fs::write(
                volume.join("data/pg_wal/000000010000000000000001"),
                vec![7u8; 4096],
            )
            .unwrap();
            volume
        }

        #[tokio::test]
        async fn a_job_runs_with_the_credential_in_a_private_file_that_is_gone_afterwards() {
            let fixture = Fixture::new("runs");
            let runner = fixture.runner();
            let volume = volume();
            let (db, job) = wal_job(&volume, Duration::from_secs(30));
            fixture.set("delay", "0.5");
            let run = tokio::spawn({
                let (db, job) = (db.clone(), job.clone());
                async move { runner.run(&db, &job, 128, &credential()).await }
            });
            // While the job runs, its credential is a 0600 file in a 0700 directory of the agent.
            let mut seen = None;
            for _ in 0..100 {
                if let Some(unit) = std::fs::read_dir(fixture.jobs_directory()).unwrap().next() {
                    let unit = unit.unwrap().path();
                    if unit.join("environment").exists() {
                        seen = Some((
                            std::fs::metadata(&unit).unwrap().permissions().mode() & 0o777,
                            std::fs::metadata(unit.join("environment"))
                                .unwrap()
                                .permissions()
                                .mode()
                                & 0o777,
                            std::fs::read_to_string(unit.join("environment")).unwrap(),
                        ));
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let (directory_mode, file_mode, content) =
                seen.expect("an environment file while the job runs");
            assert_eq!((directory_mode, file_mode), (0o700, 0o600));
            assert!(content.starts_with("AWS_ACCESS_KEY_ID=fixturekeyid\n"));
            let outcome = run.await.unwrap();
            assert!(outcome.succeeded(), "{outcome:?}");
            assert_eq!(fixture.key_id().as_deref(), Some("fixturekeyid"));
            assert_eq!(
                std::fs::read_dir(fixture.jobs_directory()).unwrap().count(),
                0
            );
            assert!(
                fixture
                    .object(&job.arguments[3], "000000010000000000000001")
                    .exists()
            );
        }

        #[tokio::test]
        async fn a_failed_job_reports_its_exit_status_and_the_end_of_its_stderr() {
            let fixture = Fixture::new("fails");
            let volume = volume();
            let (db, job) = wal_job(&volume, Duration::from_secs(30));
            fixture.set("fail", "");
            let outcome = fixture.runner().run(&db, &job, 128, &credential()).await;
            assert_eq!(outcome.exit, Exit::Code(4));
            assert!(outcome.stderr.contains("simulated R2 outage"));
            assert!(
                !fixture
                    .object(&job.arguments[3], "000000010000000000000001")
                    .exists()
            );
            // A command that does not exist is not started.
            let missing = Runner::new(
                fixture.jobs_directory().join("no-such-systemd-run"),
                fixture.jobs_directory(),
                fixture.jobs_directory(),
            );
            assert_eq!(
                missing.run(&db, &job, 128, &credential()).await.exit,
                Exit::Unstartable
            );
        }

        /// systemd-run reports a unit that `RuntimeMaxSec` ended and a command that failed with
        /// the same exit status 1 (measured on systemd 257), so the status cannot tell them
        /// apart, and the time a job took can only guess.
        #[tokio::test]
        async fn a_unit_the_bound_ended_timed_out_and_a_command_that_failed_near_it_did_not() {
            let fixture = Fixture::new("near-bound");
            let volume = volume();
            let runner = fixture.runner();
            // The first start of a new executable can take longer than the bounds below.
            let (db, warmup) = wal_job(&volume, Duration::from_secs(30));
            assert!(
                runner
                    .run(&db, &warmup, 128, &credential())
                    .await
                    .succeeded()
            );
            // A unit still running at its bound is ended by systemd.
            let (db, job) = wal_job(&volume, Duration::from_secs(1));
            fixture.set("delay", "3");
            let started = std::time::Instant::now();
            let outcome = runner.run(&db, &job, 128, &credential()).await;
            assert_eq!(outcome.exit, Exit::TimedOut, "{outcome:?}");
            assert!(started.elapsed() < Duration::from_secs(3));
            // A command that fails in the last seconds of its bound failed.
            let (db, job) = wal_job(&volume, Duration::from_secs(4));
            fixture.set("fail", "");
            let outcome = runner.run(&db, &job, 128, &credential()).await;
            assert_eq!(outcome.exit, Exit::Code(4), "{outcome:?}");
            assert!(outcome.stderr.contains("simulated R2 outage"));
        }

        #[tokio::test]
        async fn what_systemd_run_says_of_the_unit_stays_out_of_the_commands_stderr() {
            let fixture = Fixture::new("report");
            let volume = volume();
            let (db, job) = wal_job(&volume, Duration::from_secs(30));
            fixture.set("fail", "");
            let outcome = fixture.runner().run(&db, &job, 128, &credential()).await;
            assert_eq!(outcome.stderr, "simulated R2 outage\n");
        }

        #[tokio::test]
        async fn a_job_over_its_bound_is_killed_and_does_not_finish() {
            let fixture = Fixture::new("bound");
            let volume = volume();
            let (db, job) = wal_job(&volume, Duration::from_millis(200));
            // The unit's own bound is whole seconds: it ends at one second, before the upload.
            fixture.set("delay", "1.5");
            let started = std::time::Instant::now();
            let runner = fixture.runner().with_grace(Duration::ZERO);
            let outcome = runner.run(&db, &job, 128, &credential()).await;
            assert_eq!(outcome.exit, Exit::TimedOut);
            assert!(
                started.elapsed() < Duration::from_millis(900),
                "{:?}",
                started.elapsed()
            );
            tokio::time::sleep(Duration::from_millis(1700)).await;
            assert!(!fixture.finished(), "the killed upload went on");
            assert_eq!(
                std::fs::read_dir(fixture.jobs_directory()).unwrap().count(),
                0
            );
        }

        #[tokio::test]
        async fn jobs_of_a_kind_run_within_their_slots_and_a_late_one_is_busy() {
            let fixture = Fixture::new("slots");
            let volume = volume();
            let jobs = Jobs::new(fixture.runner(), Limits::default());
            let (db, job) = wal_job(&volume, Duration::from_secs(30));
            fixture.set("delay", "0.3");
            let credential = credential();
            // Five different segments, so that no two uploads write the same object.
            let segments: Vec<Job> = (2..7)
                .map(|n| {
                    let name = format!("00000001000000000000000{n}");
                    std::fs::write(volume.join("data/pg_wal").join(&name), vec![n as u8; 512])
                        .unwrap();
                    Job::wal_archive(&store('a'), &db, &name, Duration::from_secs(30))
                })
                .collect();
            let outcomes = futures_util::future::join_all(
                segments
                    .iter()
                    .map(|job| jobs.run(&db, job, &credential, None)),
            )
            .await;
            assert!(
                outcomes
                    .iter()
                    .all(|outcome| outcome.as_ref().unwrap().succeeded())
            );
            // Never more than the two WAL slots, and both used.
            assert_eq!(fixture.concurrency().into_iter().max(), Some(2));
            assert_eq!(fixture.concurrency().len(), 5);

            let one = Jobs::new(
                fixture.runner(),
                Limits {
                    wal_jobs: 1,
                    ..Limits::default()
                },
            );
            fixture.set("delay", "1");
            let running = one.run(&db, &job, &credential, None);
            let late = async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                one.run(
                    &db,
                    &job,
                    &credential,
                    Some(Instant::now() + Duration::from_millis(200)),
                )
                .await
            };
            let (running, late) = tokio::join!(running, late);
            assert!(running.unwrap().succeeded());
            assert_eq!(late.unwrap_err(), Busy);
        }

        #[tokio::test]
        async fn the_deadline_bounds_the_run_after_the_wait() {
            let fixture = Fixture::new("deadline");
            let volume = volume();
            let jobs = Jobs::new(
                fixture.runner().with_grace(Duration::ZERO),
                Limits::default(),
            );
            let (db, job) = wal_job(&volume, Duration::from_secs(30));
            fixture.set("delay", "2");
            let started = std::time::Instant::now();
            let outcome = jobs
                .run(
                    &db,
                    &job,
                    &credential(),
                    Some(Instant::now() + Duration::from_millis(300)),
                )
                .await
                .unwrap();
            assert_eq!(outcome.exit, Exit::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
}
