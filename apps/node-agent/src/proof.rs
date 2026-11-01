// SPDX-License-Identifier: Apache-2.0
//! The sleep proof (plan 7.9) and the check a wake makes against it (plan 5.9 step 3, 7.10).
//!
//! The proof stops a database in the one way that leaves nothing uncertain: the sessions are quiet,
//! a checkpoint and a WAL switch put every committed transaction into a closed segment, the
//! archive holds that segment and every one before it, and only then does the postmaster stop. Its
//! shutdown checkpoint lands in the next segment, which holds no client commit, because clients
//! were locked out. What `pg_control` says afterwards is compared with what the running server
//! said, and the record of the proof is what a later wake compares the data directory with.
//!
//! A refused proof leaves the database running and wakeable. A stop that did not end in a proof
//! leaves it unproven: the agent recovers it (`recover`).
use crate::{
    Error,
    archive::{facts, upload_log::UploadLog},
    pg_control::{CONTROL_FILE, ControlFile, Lsn, parse_control_file},
    postgres,
    sleep::{self, Refusal, Switched, SystemIdentity, is_segment},
    state::ProvenSleepRecord,
};
use std::{
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// How often the proof looks at the upload log while the archive drains.
const ARCHIVE_POLL: Duration = Duration::from_millis(100);
/// How often the proof looks at the outbox while a sleep waits for it to empty.
const OUTBOX_CHECK: Duration = Duration::from_millis(100);
/// `pg_control` is one 8 KiB block; the agent reads that much and no more of a file the
/// database's user can replace.
const CONTROL_READ: u64 = 8192;

/// The database a proof concerns.
#[derive(Clone, Debug)]
pub struct Proof {
    /// `/run/pgcf/<id>`.
    pub socket_directory: PathBuf,
    /// The mount point of the volume: the data directory is `data` below it.
    pub volume: PathBuf,
    /// The upload log of the database's storage generation.
    pub upload_log: UploadLog,
    /// How long the archive may take to hold the closed segment: 600 s (plan 7.9 step 5).
    pub archive_wait: Duration,
    /// The database whose outbox of data events the proof concerns.
    pub database: String,
    /// How long pending data events may keep the database awake: `None` ignores the outbox, and
    /// `Some(wait)` refuses the sleep unless the outbox is empty within `wait`.
    pub outbox: Option<Duration>,
}
impl Proof {
    fn data(&self) -> PathBuf {
        self.volume.join("data")
    }
}

/// What the agent does around the proof, which only it can: the gateway and the unit.
pub trait Steps {
    /// Step 1: the gateway stops new work. `Refusal::Busy` when a session is busy.
    fn quiesce(&self) -> impl Future<Output = Result<(), Refusal>> + Send;
    /// A refused proof leaves the database as it was: new work is admitted again.
    fn resume(&self) -> impl Future<Output = ()> + Send;
    /// Idle sessions close (WebSocket code 1000, "database sleeping"), or one turned busy.
    fn close_sessions(&self) -> impl Future<Output = Result<(), Refusal>> + Send;
    /// Step 7: a fast shutdown, returning when the unit is stopped.
    fn stop(&self) -> impl Future<Output = Result<(), Error>> + Send;
}

/// How a proof ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Stopped and proven; the record is to be written and fsynced, then reported.
    Proven(ProvenSleepRecord),
    /// Refused before anything stopped: the database runs and is wakeable.
    Refused(Refusal),
    /// The unit did not stop. The agent reads what it is.
    StopFailed,
    /// Stopped, but `pg_control` or the archive does not show a proof: the database is unproven.
    Unproven(&'static str),
}

/// What the running server said before the stop.
struct Running {
    system: SystemIdentity,
    switched: Switched,
    segment_bytes: u64,
}

/// Waits until the outbox of the proof's database holds no row, for at most `wait`: a sleep does
/// not stop a database with data events it has not delivered. A database without the platform's
/// schema has none. A database whose outbox cannot be read is unknown, never empty.
async fn wait_empty(proof: &Proof, wait: Duration) -> Result<(), Refusal> {
    let session = crate::pgcf::connect(&proof.socket_directory, &proof.database, None)
        .await
        .map_err(|_| Refusal::Unknown)?;
    let started = tokio::time::Instant::now();
    loop {
        if !crate::pgcf::outbox_pending(&session)
            .await
            .map_err(|_| Refusal::Unknown)?
        {
            return Ok(());
        }
        if started.elapsed() >= wait {
            return Err(Refusal::Outbox);
        }
        tokio::time::sleep(OUTBOX_CHECK).await;
    }
}

/// Steps 2 to 6: the guard, a checkpoint, the switch, and the wait for the archive.
async fn prepare(proof: &Proof) -> Result<Running, Refusal> {
    let session = postgres::agent(&proof.socket_directory)
        .await
        .map_err(|_| Refusal::Unknown)?;
    if let Some(refusal) = sleep::guard(&session).await.map_err(|_| Refusal::Unknown)? {
        return Err(refusal);
    }
    if let Some(wait) = proof.outbox {
        wait_empty(proof, wait).await?;
    }
    let system = sleep::system(&session).await.ok_or(Refusal::Unknown)?;
    let segment_bytes = sleep::wal_segment_bytes(&session)
        .await
        .ok_or(Refusal::Unknown)?;
    session
        .batch_long("CHECKPOINT")
        .await
        .map_err(|_| Refusal::Unknown)?;
    let switched = sleep::switch(&session).await?;
    let started = tokio::time::Instant::now();
    loop {
        // A dead postmaster cannot clear archive_status. Release the proof so recovery can
        // restart it, instead of holding its flow lock for the whole archive deadline.
        if session.client.is_closed() {
            return Err(Refusal::Unknown);
        }
        let archived = proof
            .upload_log
            .contains(&switched.segment)
            .unwrap_or(false);
        let waiting = facts::ready_files(&proof.data()).map_err(|_| Refusal::Unknown)?;
        if archived && waiting.is_empty() {
            break;
        }
        if started.elapsed() >= proof.archive_wait {
            return Err(Refusal::ArchiveTimeout);
        }
        tokio::time::sleep(ARCHIVE_POLL).await;
    }
    // Work that began while the archive drained is work.
    if let Some(refusal) = sleep::guard(&session).await.map_err(|_| Refusal::Unknown)? {
        return Err(refusal);
    }
    if proof.outbox.is_some() {
        wait_empty(proof, Duration::ZERO).await?;
    }
    Ok(Running {
        system,
        switched,
        segment_bytes,
    })
}

/// Runs the proof of a sleep: steps 1 to 9 of plan 7.9. Step 9, writing the record, is the
/// caller's.
pub async fn run<S: Steps>(proof: &Proof, steps: &S) -> Outcome {
    if let Err(refusal) = steps.quiesce().await {
        return Outcome::Refused(refusal);
    }
    let running = match prepare(proof).await {
        Ok(running) => running,
        Err(refusal) => {
            steps.resume().await;
            return Outcome::Refused(refusal);
        }
    };
    if let Err(refusal) = steps.close_sessions().await {
        steps.resume().await;
        return Outcome::Refused(refusal);
    }
    if steps.stop().await.is_err() {
        return Outcome::StopFailed;
    }
    match verify_stopped(proof, &running) {
        Ok(record) => Outcome::Proven(record),
        Err(reason) => Outcome::Unproven(reason),
    }
}

/// `pg_control` of a database whose volume is mounted at `volume`. The database's user can
/// replace what is below its mount point, and the agent reads as root: a component that is a link
/// is refused, and no more than the block is read.
pub fn read_control(volume: &Path) -> std::io::Result<Vec<u8>> {
    let refuse = |path: &Path| -> std::io::Result<()> {
        if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "a link where the data directory has a file",
            ));
        }
        Ok(())
    };
    let data = volume.join("data");
    refuse(&data)?;
    refuse(&data.join("global"))?;
    let file = volume.join(CONTROL_FILE);
    refuse(&file)?;
    let mut bytes = Vec::new();
    std::fs::File::open(file)?
        .take(CONTROL_READ)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// Step 8 and the record of step 9, from what the stopped data directory and the archive show.
fn verify_stopped(proof: &Proof, running: &Running) -> Result<ProvenSleepRecord, &'static str> {
    if proof.data().join("postmaster.pid").exists() {
        return Err("postmaster_pid");
    }
    let bytes = read_control(&proof.volume).map_err(|_| "control_unreadable")?;
    let file = parse_control_file(&bytes)?;
    if !file.control.shut_down() {
        return Err("not_shut_down");
    }
    let timeline = i32::try_from(file.control.timeline).map_err(|_| "control_unreadable")?;
    if file.control.system_identifier != running.system.identifier
        || timeline != running.system.timeline
    {
        return Err("identity_changed");
    }
    let checkpoint = Lsn(file.checkpoint);
    if checkpoint < running.switched.lsn {
        return Err("checkpoint_before_switch");
    }
    let logged = proof
        .upload_log
        .entries()
        .map_err(|_| "upload_log_unreadable")?;
    if !logged.contains(&running.switched.segment) {
        return Err("segment_not_archived");
    }
    // Every complete segment of the timeline before the checkpoint's own is in the log.
    let current = format!("{:08X}", file.control.timeline);
    let checkpoint_segment = checkpoint.segment(file.control.timeline, running.segment_bytes);
    let entries =
        std::fs::read_dir(proof.data().join("pg_wal")).map_err(|_| "pg_wal_unreadable")?;
    for entry in entries {
        let entry = entry.map_err(|_| "pg_wal_unreadable")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if is_segment(name)
            && name[..8] == current
            && name < checkpoint_segment.as_str()
            && !logged.iter().any(|logged| logged == name)
        {
            return Err("segment_not_archived");
        }
    }
    if !facts::ready_files(&proof.data())
        .map_err(|_| "archive_status_unreadable")?
        .is_empty()
    {
        return Err("segment_waiting");
    }
    let last = logged
        .iter()
        .filter(|name| is_segment(name) && name[..8] == current)
        .max()
        .cloned()
        .unwrap_or_else(|| running.switched.segment.clone());
    Ok(ProvenSleepRecord {
        system_identifier: file.control.system_identifier,
        timeline: file.control.timeline,
        checkpoint_lsn: checkpoint.to_string(),
        last_archived_segment: last,
        proven_at: facts::timestamp(now_ms()),
    })
}

/// Why a wake does not start a database from its volume.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeRefusal {
    /// The data directory is not the one the last proof left: no record, a crash, a stop nobody
    /// proved, or a segment still waiting for the archive. Recovery is pending (plan 7.10).
    Unproven,
    /// Another cluster's system identifier, or another timeline.
    IdentityMismatch,
    /// `pg_control` is of another PostgreSQL version.
    ControlVersion,
}
impl WakeRefusal {
    /// The reason in the contract's `WAKE_REASONS`.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Unproven => "unproven",
            Self::IdentityMismatch => "identity_mismatch",
            Self::ControlVersion => "control_version",
        }
    }
}

/// Plan 5.9 step 3: the volume's `pg_control` against the proven-sleep record. The state must be
/// "shut down", the identity and the latest checkpoint must be the record's, and no segment may
/// wait for the archive.
pub fn wake_check(record: Option<&ProvenSleepRecord>, volume: &Path) -> Result<(), WakeRefusal> {
    let record = record.ok_or(WakeRefusal::Unproven)?;
    let bytes = read_control(volume).map_err(|_| WakeRefusal::Unproven)?;
    let ControlFile {
        control,
        checkpoint,
        ..
    } = parse_control_file(&bytes).map_err(|error| match error {
        "control_version" => WakeRefusal::ControlVersion,
        _ => WakeRefusal::Unproven,
    })?;
    if control.system_identifier != record.system_identifier || control.timeline != record.timeline
    {
        return Err(WakeRefusal::IdentityMismatch);
    }
    if !control.shut_down() || Lsn(checkpoint).to_string() != record.checkpoint_lsn {
        return Err(WakeRefusal::Unproven);
    }
    match facts::ready_files(&volume.join("data")) {
        Ok(waiting) if waiting.is_empty() => Ok(()),
        _ => Err(WakeRefusal::Unproven),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        archive::upload_log::UploadLog,
        pg_control::{Lsn, parse_control_file},
        postgres::Session,
        state::ProvenSleepRecord,
        testpg::{self, Cluster},
    };
    use std::{process::Command, sync::Mutex, time::Duration};

    /// What the agent does around the proof, recorded; the stop is the test's own, of a real
    /// postmaster.
    struct Recording<'a> {
        cluster: &'a Cluster,
        calls: Mutex<Vec<&'static str>>,
        quiesce_refusal: Option<Refusal>,
        kill_instead: bool,
    }
    impl<'a> Recording<'a> {
        fn new(cluster: &'a Cluster) -> Self {
            Self {
                cluster,
                calls: Mutex::new(Vec::new()),
                quiesce_refusal: None,
                kill_instead: false,
            }
        }
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }
    impl Steps for Recording<'_> {
        async fn quiesce(&self) -> Result<(), Refusal> {
            self.calls.lock().unwrap().push("quiesce");
            self.quiesce_refusal.map_or(Ok(()), Err)
        }
        async fn resume(&self) {
            self.calls.lock().unwrap().push("resume");
        }
        async fn close_sessions(&self) -> Result<(), Refusal> {
            self.calls.lock().unwrap().push("close");
            Ok(())
        }
        async fn stop(&self) -> Result<(), crate::Error> {
            self.calls.lock().unwrap().push("stop");
            if self.kill_instead {
                self.cluster.kill();
            } else {
                self.cluster.stop();
            }
            Ok(())
        }
    }

    struct Rig {
        cluster: Cluster,
        log: UploadLog,
        directory: std::path::PathBuf,
    }
    impl Rig {
        fn new(label: &str) -> Option<Self> {
            let directory = testpg::directory(label);
            let log_path = directory.join("uploads.log");
            let script = testpg::archive_script(&directory, &log_path);
            let cluster = Cluster::with_archive(label, Some(&script))?;
            Some(Self {
                cluster,
                log: UploadLog::new(log_path),
                directory,
            })
        }
        fn proof(&self) -> Proof {
            Proof {
                socket_directory: self.cluster.socket_directory(),
                volume: self.cluster.volume(),
                upload_log: self.log.clone(),
                archive_wait: Duration::from_secs(20),
                database: "postgres".into(),
                outbox: None,
            }
        }
        async fn write(&self, agent: &Session) {
            agent
                .batch("CREATE TABLE IF NOT EXISTS t (a int); INSERT INTO t SELECT generate_series(1, 5000)")
                .await
                .unwrap();
        }
        fn controldata(&self, field: &str) -> String {
            let output = Command::new(self.cluster.layout.postgres_bin.join("pg_controldata"))
                .arg(self.cluster.data())
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| line.strip_prefix(field))
                .unwrap()
                .trim_start_matches(':')
                .trim()
                .to_string()
        }
    }
    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    #[tokio::test]
    async fn a_quiet_database_is_stopped_and_proven_and_wakes_only_against_its_record() {
        let Some(rig) = Rig::new("proof") else {
            return;
        };
        rig.cluster.start();
        let agent = rig.cluster.agent().await;
        rig.write(&agent).await;
        drop(agent);
        let steps = Recording::new(&rig.cluster);
        let Outcome::Proven(record) = run(&rig.proof(), &steps).await else {
            panic!("the proof ended otherwise");
        };
        assert_eq!(steps.calls(), ["quiesce", "close", "stop"]);
        assert!(record.valid());
        // The record says what PostgreSQL's own tool says of the stopped cluster.
        assert_eq!(
            record.system_identifier,
            rig.controldata("Database system identifier")
        );
        assert_eq!(
            record.checkpoint_lsn,
            rig.controldata("Latest checkpoint location")
        );
        assert_eq!(record.timeline, 1);
        assert!(rig.log.contains(&record.last_archived_segment).unwrap());
        // The shutdown checkpoint lies after the segment the switch closed.
        let bytes = read_control(&rig.cluster.volume()).unwrap();
        let checkpoint = Lsn(parse_control_file(&bytes).unwrap().checkpoint);
        assert!(checkpoint.segment(1, 16 << 20) > record.last_archived_segment);

        // The wake finds the volume as the sleep left it.
        assert_eq!(wake_check(Some(&record), &rig.cluster.volume()), Ok(()));
        // Without a record, or with the record of another cluster, it does not start it.
        assert_eq!(
            wake_check(None, &rig.cluster.volume()),
            Err(WakeRefusal::Unproven)
        );
        let mut other = record.clone();
        other.system_identifier = "1234".into();
        assert_eq!(
            wake_check(Some(&other), &rig.cluster.volume()),
            Err(WakeRefusal::IdentityMismatch)
        );
        let mut other = record.clone();
        other.timeline = 2;
        assert_eq!(
            wake_check(Some(&other), &rig.cluster.volume()),
            Err(WakeRefusal::IdentityMismatch)
        );

        // After the wake the record is of a past sleep: a crash, and a clean stop that nobody
        // proved, both leave a data directory the record does not describe.
        rig.cluster.start();
        assert_eq!(
            wake_check(Some(&record), &rig.cluster.volume()),
            Err(WakeRefusal::Unproven)
        );
        rig.cluster.stop();
        assert_eq!(
            wake_check(Some(&record), &rig.cluster.volume()),
            Err(WakeRefusal::Unproven)
        );
    }

    #[tokio::test]
    async fn a_busy_database_is_refused_and_nothing_stops() {
        let Some(rig) = Rig::new("busy") else {
            return;
        };
        rig.cluster.start();
        let client = rig.cluster.agent().await;
        client.batch("BEGIN").await.unwrap();
        let steps = Recording::new(&rig.cluster);
        assert_eq!(
            run(&rig.proof(), &steps).await,
            Outcome::Refused(Refusal::Busy)
        );
        assert_eq!(steps.calls(), ["quiesce", "resume"]);
        // The database is awake and wakeable: it runs and answers.
        client.batch("COMMIT").await.unwrap();
        // The gateway's own refusal, before PostgreSQL is asked.
        let mut steps = Recording::new(&rig.cluster);
        steps.quiesce_refusal = Some(Refusal::Busy);
        assert_eq!(
            run(&rig.proof(), &steps).await,
            Outcome::Refused(Refusal::Busy)
        );
        assert_eq!(steps.calls(), ["quiesce"]);
        assert!(matches!(
            run(&rig.proof(), &Recording::new(&rig.cluster)).await,
            Outcome::Proven(_)
        ));
    }

    #[tokio::test]
    async fn an_archive_that_does_not_drain_refuses_the_sleep_and_the_database_stays_awake() {
        let Some(rig) = Rig::new("archive-down") else {
            return;
        };
        rig.cluster.start();
        let agent = rig.cluster.agent().await;
        rig.write(&agent).await;
        std::fs::write(rig.directory.join("fail"), "").unwrap();
        let steps = Recording::new(&rig.cluster);
        let mut proof = rig.proof();
        proof.archive_wait = Duration::from_millis(1500);
        assert_eq!(
            run(&proof, &steps).await,
            Outcome::Refused(Refusal::ArchiveTimeout)
        );
        assert_eq!(steps.calls(), ["quiesce", "resume"]);
        // Still running, with its data.
        let rows = agent.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 5000);
        // The archive is back: the next proof succeeds.
        std::fs::remove_file(rig.directory.join("fail")).unwrap();
        drop(agent);
        assert!(matches!(
            run(&rig.proof(), &Recording::new(&rig.cluster)).await,
            Outcome::Proven(_)
        ));
    }

    #[tokio::test]
    async fn a_postmaster_killed_while_its_archive_is_pending_releases_the_proof_for_recovery() {
        let Some(rig) = Rig::new("archive-wait-crash") else {
            return;
        };
        rig.cluster.start();
        let agent = rig.cluster.agent().await;
        rig.write(&agent).await;
        // Drain earlier work so the next .ready file belongs to this proof's switch.
        let switched = sleep::switch(&agent).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !rig.log.contains(&switched.segment).unwrap()
                || !facts::ready_files(&rig.cluster.data()).unwrap().is_empty()
            {
                tokio::time::sleep(ARCHIVE_POLL).await;
            }
        })
        .await
        .expect("the initial archive drained");
        std::fs::write(rig.directory.join("fail"), "").unwrap();
        let steps = Recording::new(&rig.cluster);
        let mut proof = rig.proof();
        proof.archive_wait = Duration::from_secs(30);
        let proving = run(&proof, &steps);
        tokio::pin!(proving);
        let waiting = async {
            loop {
                if !facts::ready_files(&rig.cluster.data()).unwrap().is_empty() {
                    let rows = agent
                        .query(
                            "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE pid <> pg_catalog.pg_backend_pid() AND state = 'idle' AND query = $1",
                            &[&sleep::sql("SWITCH")],
                        )
                        .await
                        .unwrap();
                    if rows[0].get::<_, i64>(0) == 1 {
                        return;
                    }
                }
                tokio::time::sleep(ARCHIVE_POLL).await;
            }
        };
        tokio::select! {
            outcome = &mut proving => panic!("proof ended before its archive wait: {outcome:?}"),
            result = tokio::time::timeout(Duration::from_secs(10), waiting) => result.expect("proof switched WAL and is idle waiting for the archive"),
        }
        // Drive the switch reply into the proof before killing its postmaster.
        tokio::select! {
            biased;
            outcome = &mut proving => panic!("a pending archive cannot prove sleep: {outcome:?}"),
            () = tokio::time::sleep(ARCHIVE_POLL * 2) => {},
        }
        rig.cluster.kill();
        let outcome = tokio::time::timeout(Duration::from_secs(5), &mut proving)
            .await
            .expect("a dead PostgreSQL session must not hold recovery for the archive deadline");
        assert_eq!(outcome, Outcome::Refused(Refusal::Unknown));
        assert_eq!(steps.calls(), ["quiesce", "resume"]);
        assert!(!facts::ready_files(&rig.cluster.data()).unwrap().is_empty());
        drop(agent);

        // Normal PostgreSQL crash recovery preserves every committed row; the next proof works.
        std::fs::remove_file(rig.directory.join("fail")).unwrap();
        rig.cluster.start();
        let recovered = rig.cluster.agent().await;
        let rows = recovered
            .query("SELECT count(*), min(a), max(a), sum(a) FROM t", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 5000);
        assert_eq!(rows[0].get::<_, i32>(1), 1);
        assert_eq!(rows[0].get::<_, i32>(2), 5000);
        assert_eq!(rows[0].get::<_, i64>(3), 12_502_500);
        drop(recovered);
        assert!(matches!(
            run(&rig.proof(), &Recording::new(&rig.cluster)).await,
            Outcome::Proven(_)
        ));
    }

    #[tokio::test]
    async fn a_stop_that_was_a_crash_is_not_a_proof() {
        let Some(rig) = Rig::new("crash") else {
            return;
        };
        rig.cluster.start();
        let agent = rig.cluster.agent().await;
        rig.write(&agent).await;
        drop(agent);
        let mut steps = Recording::new(&rig.cluster);
        steps.kill_instead = true;
        let outcome = run(&rig.proof(), &steps).await;
        // A killed postmaster leaves its pid file.
        assert_eq!(outcome, Outcome::Unproven("postmaster_pid"));
        assert_eq!(steps.calls(), ["quiesce", "close", "stop"]);
    }

    /// The outbox of a database: a pending data event refuses the sleep, unless the proof waits
    /// for it or ignores the outbox. Real clusters, with the platform schema of a tenant.
    mod outbox {
        use super::*;
        use crate::pgcf::{self, Installed, Settings};

        const SETTINGS: Settings = Settings {
            epoch: 1,
            max_payload_bytes: 54_000,
            max_outbox_rows: 1_000,
        };

        /// A tenant database owned by `app`, with the platform schema, and one event emitted in
        /// it as the superuser.
        async fn tenant_with_event(rig: &Rig) {
            let agent = rig.cluster.agent().await;
            agent.batch("CREATE ROLE app").await.unwrap();
            agent
                .batch_long("CREATE DATABASE tenant OWNER app")
                .await
                .unwrap();
            drop(agent);
            let session = pgcf::connect(&rig.cluster.socket_directory(), "tenant", None)
                .await
                .unwrap();
            let installed = pgcf::install(&session, &SETTINGS, false).await.unwrap();
            assert_eq!(installed, Installed::Done);
            session
                .batch("SELECT pgcf.emit('orders', '{\"x\": 1}')")
                .await
                .unwrap();
        }
        fn tenant(rig: &Rig, outbox: Option<Duration>) -> Proof {
            Proof {
                database: "tenant".into(),
                outbox,
                ..rig.proof()
            }
        }

        #[tokio::test]
        async fn a_pending_event_refuses_the_sleep_and_the_database_stays_awake() {
            let Some(rig) = Rig::new("outbox-pending") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let steps = Recording::new(&rig.cluster);
            let proof = tenant(&rig, Some(Duration::from_millis(300)));
            assert_eq!(run(&proof, &steps).await, Outcome::Refused(Refusal::Outbox));
            assert_eq!(steps.calls(), ["quiesce", "resume"]);
            // Still running, with its data.
            let agent = rig.cluster.agent().await;
            agent.query("SELECT 1", &[]).await.unwrap();
            // Once the event is gone the next proof stops the database.
            let session = pgcf::connect(&rig.cluster.socket_directory(), "tenant", None)
                .await
                .unwrap();
            session.batch("DELETE FROM pgcf.outbox").await.unwrap();
            drop(session);
            drop(agent);
            assert!(matches!(
                run(&proof, &Recording::new(&rig.cluster)).await,
                Outcome::Proven(_)
            ));
        }

        #[tokio::test]
        async fn a_proof_that_ignores_the_outbox_stops_with_a_pending_event() {
            let Some(rig) = Rig::new("outbox-ignored") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let steps = Recording::new(&rig.cluster);
            assert!(matches!(
                run(&tenant(&rig, None), &steps).await,
                Outcome::Proven(_)
            ));
            assert_eq!(steps.calls(), ["quiesce", "close", "stop"]);
        }

        #[tokio::test]
        async fn an_event_delivered_while_the_sleep_waits_lets_it_prove() {
            let Some(rig) = Rig::new("outbox-delivered") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let socket = rig.cluster.socket_directory();
            let delivery = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let session = pgcf::connect(&socket, "tenant", None).await.unwrap();
                session.batch("DELETE FROM pgcf.outbox").await.unwrap();
            });
            let proof = tenant(&rig, Some(Duration::from_secs(2)));
            assert!(matches!(
                run(&proof, &Recording::new(&rig.cluster)).await,
                Outcome::Proven(_)
            ));
            delivery.await.unwrap();
        }

        #[tokio::test]
        async fn without_a_wait_a_pending_event_refuses_at_once_and_an_unreadable_outbox_is_unknown()
         {
            let Some(rig) = Rig::new("outbox-no-wait") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let steps = Recording::new(&rig.cluster);
            assert_eq!(
                run(&tenant(&rig, Some(Duration::ZERO)), &steps).await,
                Outcome::Refused(Refusal::Outbox)
            );
            assert_eq!(steps.calls(), ["quiesce", "resume"]);
            // A database that does not exist cannot say whether its outbox is empty.
            let mut missing = tenant(&rig, Some(Duration::ZERO));
            missing.database = "missing".into();
            assert_eq!(
                run(&missing, &Recording::new(&rig.cluster)).await,
                Outcome::Refused(Refusal::Unknown)
            );
        }

        #[tokio::test]
        async fn a_database_without_the_platform_schema_has_an_empty_outbox() {
            let Some(rig) = Rig::new("outbox-bare") else {
                return;
            };
            rig.cluster.start();
            let proof = Proof {
                outbox: Some(Duration::ZERO),
                ..rig.proof()
            };
            assert!(matches!(
                run(&proof, &Recording::new(&rig.cluster)).await,
                Outcome::Proven(_)
            ));
        }

        #[tokio::test]
        async fn a_row_emitted_while_the_archive_drains_refuses_the_sleep() {
            let Some(rig) = Rig::new("outbox-late") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let session = pgcf::connect(&rig.cluster.socket_directory(), "tenant", None)
                .await
                .unwrap();
            session.batch("DELETE FROM pgcf.outbox").await.unwrap();
            // The archive fails until the file is removed, so the proof waits for it.
            std::fs::write(rig.directory.join("fail"), "").unwrap();
            let directory = rig.directory.clone();
            let emitter = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(400)).await;
                session
                    .batch("SELECT pgcf.emit('orders', '{\"late\": 1}')")
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(400)).await;
                std::fs::remove_file(directory.join("fail")).unwrap();
            });
            let steps = Recording::new(&rig.cluster);
            let proof = tenant(&rig, Some(Duration::from_millis(100)));
            assert_eq!(run(&proof, &steps).await, Outcome::Refused(Refusal::Outbox));
            assert_eq!(steps.calls(), ["quiesce", "resume"]);
            emitter.await.unwrap();
        }

        #[tokio::test]
        async fn an_outbox_that_cannot_be_read_is_unknown_never_empty() {
            let Some(rig) = Rig::new("outbox-locked") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            // The lock holder is an events session, which the guard does not count as busy.
            let locker =
                crate::postgres::connect_events(&rig.cluster.socket_directory(), "tenant", None)
                    .await
                    .unwrap();
            locker
                .batch("BEGIN; LOCK TABLE pgcf.outbox IN ACCESS EXCLUSIVE MODE")
                .await
                .unwrap();
            let steps = Recording::new(&rig.cluster);
            assert_eq!(
                run(&tenant(&rig, Some(Duration::ZERO)), &steps).await,
                Outcome::Refused(Refusal::Unknown)
            );
            assert_eq!(steps.calls(), ["quiesce", "resume"]);
        }

        #[tokio::test]
        async fn the_wait_for_the_outbox_is_bounded_by_its_argument() {
            let Some(rig) = Rig::new("outbox-bounded") else {
                return;
            };
            rig.cluster.start();
            tenant_with_event(&rig).await;
            let began = std::time::Instant::now();
            assert_eq!(
                run(
                    &tenant(&rig, Some(Duration::from_secs(1))),
                    &Recording::new(&rig.cluster)
                )
                .await,
                Outcome::Refused(Refusal::Outbox)
            );
            let took = began.elapsed();
            assert!(took >= Duration::from_secs(1), "{took:?}");
            assert!(took < Duration::from_millis(2500), "{took:?}");
        }
    }

    /// A volume as a stopped database leaves it, for the checks that read files: `pg_control`, the
    /// segments in `pg_wal`, the files waiting for the archive and the upload log.
    mod stopped {
        use super::*;

        const IDENTIFIER: u64 = 7_431_215_993_172_011_234;
        const SEGMENT_BYTES: u64 = 16 << 20;

        fn control(state: u32, timeline: u32, checkpoint: Lsn) -> Vec<u8> {
            let mut bytes = vec![0u8; 296];
            bytes[..8].copy_from_slice(&IDENTIFIER.to_le_bytes());
            bytes[8..12].copy_from_slice(&1800u32.to_le_bytes());
            bytes[16..20].copy_from_slice(&state.to_le_bytes());
            bytes[32..40].copy_from_slice(&checkpoint.0.to_le_bytes());
            bytes[48..52].copy_from_slice(&timeline.to_le_bytes());
            bytes
        }
        struct Volume {
            root: std::path::PathBuf,
            proof: Proof,
        }
        impl Volume {
            /// Segments 1 and 2 are closed, the switch closed 2, the shutdown checkpoint is in 3.
            fn new(label: &str) -> Self {
                let root = testpg::directory(label);
                for dir in ["data/global", "data/pg_wal/archive_status"] {
                    std::fs::create_dir_all(root.join(dir)).unwrap();
                }
                Self {
                    proof: Proof {
                        socket_directory: root.join("socket"),
                        volume: root.clone(),
                        upload_log: UploadLog::new(root.join("uploads.log")),
                        archive_wait: Duration::from_secs(1),
                        database: "postgres".into(),
                        outbox: None,
                    },
                    root,
                }
            }
            fn control(&self, state: u32, timeline: u32, checkpoint: &str) {
                std::fs::write(
                    self.root.join("data/global/pg_control"),
                    control(state, timeline, Lsn::parse(checkpoint).unwrap()),
                )
                .unwrap();
            }
            fn segments(&self, names: &[&str]) {
                for name in names {
                    std::fs::write(self.root.join("data/pg_wal").join(name), b"").unwrap();
                }
            }
            fn logged(&self, names: &[&str]) {
                let text: String = names.iter().map(|name| format!("{name}\n")).collect();
                std::fs::write(self.root.join("uploads.log"), text).unwrap();
            }
        }
        fn running() -> Running {
            Running {
                system: SystemIdentity {
                    identifier: IDENTIFIER.to_string(),
                    timeline: 1,
                },
                // The switch returned the first byte of segment 3.
                switched: Switched {
                    lsn: Lsn::parse("0/3000000").unwrap(),
                    segment: "000000010000000000000002".into(),
                },
                segment_bytes: SEGMENT_BYTES,
            }
        }
        const S1: &str = "000000010000000000000001";
        const S2: &str = "000000010000000000000002";
        const S3: &str = "000000010000000000000003";

        #[test]
        fn a_stopped_database_whose_archive_holds_every_closed_segment_is_proven() {
            let volume = Volume::new("stopped-ok");
            volume.control(1, 1, "0/3000028");
            volume.segments(&[S1, S2, S3]);
            volume.logged(&[S1, S2]);
            let record = verify_stopped(&volume.proof, &running()).unwrap();
            assert_eq!(record.last_archived_segment, S2);
            assert_eq!(record.checkpoint_lsn, "0/3000028");
            assert_eq!(record.system_identifier, IDENTIFIER.to_string());
            assert!(record.valid());
        }

        #[test]
        fn what_a_proof_needs_and_the_disk_does_not_show_leaves_the_database_unproven() {
            let volume = Volume::new("stopped-bad");
            volume.segments(&[S1, S2, S3]);
            volume.logged(&[S1, S2]);
            let check =
                || verify_stopped(&volume.proof, &running()).map(|record| record.checkpoint_lsn);
            // Not shut down: PostgreSQL's state "in production".
            volume.control(6, 1, "0/3000028");
            assert_eq!(check(), Err("not_shut_down"));
            // Another cluster, or another timeline, answers at this directory.
            volume.control(1, 2, "0/3000028");
            assert_eq!(check(), Err("identity_changed"));
            // The shutdown checkpoint should lie after the switch.
            volume.control(1, 1, "0/2FFFFF0");
            assert_eq!(check(), Err("checkpoint_before_switch"));
            // The closed segment that the switch returned is not in the log.
            volume.control(1, 1, "0/3000028");
            volume.logged(&[S1]);
            assert_eq!(check(), Err("segment_not_archived"));
            // A complete segment before the checkpoint's is missing from the log.
            volume.logged(&[S2]);
            assert_eq!(check(), Err("segment_not_archived"));
            volume.logged(&[S1, S2]);
            assert_eq!(check().as_deref(), Ok("0/3000028"));
            // A segment still waits for the archive.
            std::fs::write(
                volume
                    .root
                    .join(format!("data/pg_wal/archive_status/{S2}.ready")),
                "",
            )
            .unwrap();
            assert_eq!(check(), Err("segment_waiting"));
            std::fs::remove_file(
                volume
                    .root
                    .join(format!("data/pg_wal/archive_status/{S2}.ready")),
            )
            .unwrap();
            // The postmaster's pid file is still there.
            std::fs::write(volume.root.join("data/postmaster.pid"), "1\n").unwrap();
            assert_eq!(check(), Err("postmaster_pid"));
        }

        #[test]
        fn the_segments_of_an_older_timeline_are_not_this_archives_to_hold() {
            // A restored database: segments of timeline 1 came with the backup and are in the
            // source's archive; the database's own archive starts on timeline 2.
            let volume = Volume::new("stopped-restored");
            let t2 = |n: u8| format!("0000000200000000000000{n:02X}");
            volume.control(1, 2, "0/5000028");
            volume.segments(&[S1, S2, S3, &t2(4), &t2(5)]);
            volume.logged(&[&t2(4)]);
            let mut running = running();
            running.system.timeline = 2;
            running.switched = Switched {
                lsn: Lsn::parse("0/5000000").unwrap(),
                segment: t2(4),
            };
            let record = verify_stopped(&volume.proof, &running).unwrap();
            assert_eq!(record.last_archived_segment, t2(4));
            assert_eq!(record.timeline, 2);
        }

        #[test]
        fn a_control_file_the_user_replaced_by_a_link_is_not_read() {
            let volume = Volume::new("stopped-link");
            let elsewhere = volume.root.join("elsewhere");
            std::fs::write(&elsewhere, control(1, 1, Lsn(1))).unwrap();
            std::os::unix::fs::symlink(&elsewhere, volume.root.join("data/global/pg_control"))
                .unwrap();
            assert!(read_control(&volume.root).is_err());
            assert_eq!(
                wake_check(
                    Some(&ProvenSleepRecord {
                        system_identifier: IDENTIFIER.to_string(),
                        timeline: 1,
                        checkpoint_lsn: "0/1".into(),
                        last_archived_segment: S1.into(),
                        proven_at: "2026-10-18T10:11:12.345Z".into(),
                    }),
                    &volume.root
                ),
                Err(WakeRefusal::Unproven)
            );
            // A directory above it as a link.
            let volume = Volume::new("stopped-link-dir");
            let data = volume.root.join("data");
            std::fs::rename(&data, volume.root.join("moved")).unwrap();
            std::os::unix::fs::symlink(volume.root.join("moved"), &data).unwrap();
            assert!(read_control(&volume.root).is_err());
        }

        #[test]
        fn a_control_file_of_another_version_is_named_as_such() {
            let volume = Volume::new("stopped-version");
            let mut bytes = control(1, 1, Lsn(0x3000028));
            bytes[8..12].copy_from_slice(&1700u32.to_le_bytes());
            std::fs::write(volume.root.join("data/global/pg_control"), bytes).unwrap();
            let record = ProvenSleepRecord {
                system_identifier: IDENTIFIER.to_string(),
                timeline: 1,
                checkpoint_lsn: "0/3000028".into(),
                last_archived_segment: S2.into(),
                proven_at: "2026-10-18T10:11:12.345Z".into(),
            };
            assert_eq!(
                wake_check(Some(&record), &volume.root),
                Err(WakeRefusal::ControlVersion)
            );
        }
    }
}
