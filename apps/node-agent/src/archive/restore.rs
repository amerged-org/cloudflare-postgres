// SPDX-License-Identifier: Apache-2.0
//! The archive side of building a database from R2: a restore, a point-in-time restore and a move
//! target (plan 7.8 steps 2-6, 9.5 steps 3-4). The executor runs the steps in their order over the
//! pieces of this module, and asks the modules that own units and database connections for what
//! only they can do (`Host`).
//!
//! 1. List the source archive and take the order's backup; it must be DONE.
//! 2. `barman-cloud-restore` it into the new database's data directory, as the new database's user.
//! 3. Write the recovery settings and register the database with its `Recovery`, so that its
//!    `restore_command` is answered from the source archive (a move target must reach the
//!    source's last segment, `End`). The recovery runs with the larger of the backup's own
//!    `max_connections`, process, sender, prepared transaction and lock settings (its control
//!    file) and the class's, which PostgreSQL requires of a recovery with hot standby; the class
//!    must have the memory for them.
//! 4. Start it and wait for it to promote; check that it is the backup's database on a later
//!    timeline (and the source's, for a move).
//! 5. Remove the recovery settings and the spool; if the recovery ran with more than the class
//!    has, restart the database onto the class's own settings. Then take the first base backup
//!    of the new timeline into the database's own archive; it counts only when the listing shows
//!    it DONE.
//!
//! The caller creates the new database's user and its volume (at least as large as the source's)
//! first, and resets the roles of the page once the database is ready (plan 7.8 step 5): the
//! backup role of the restored cluster is the source's, and the first backup uses it as it is.
//! A step that fails fails the operation with the node contract's error, and the database is
//! abandoned (`Host::abandon`: stopped, its volume and user deleted).
//!
//! A build that an agent restart cut off is begun again (`Order::resumed`). If the earlier run had
//! not taken its first base backup, its files go and steps 2 to 5 run over an empty directory. If
//! the first backup is DONE in the database's own archive and is the one of the cluster on the
//! volume, the build only starts the promoted database again, checks who it is and takes the
//! backup for the one it has (`Restorer::begin_again`).
use super::{
    facts::{self, Backup},
    job::{Database, Job, Jobs, Kind, Outcome, Store},
    recovery::{self, Restored},
    server::{
        FetchFailure, FetchStatus, Recovery, Registration, Table, log_failed_job, unix_seconds,
    },
    upload_log::UploadLog,
};
use crate::{credentials::Credentials, pg_control, proof, settings::Capacity};
use serde_json::json;
use std::{future::Future, time::Instant};

/// What a step of the host did not do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failed;

/// Internal, never reported as an API error. The controller gives a timed-out recovery fetch
/// one further attempt before reporting `archive_unusable`.
pub(crate) const RECOVERY_FETCH_TIMEOUT: &str = "recovery_fetch_timeout";

fn recovery_error(fetch: &FetchStatus, fallback: &'static str) -> &'static str {
    match fetch.failure() {
        Some(FetchFailure::TimedOut) => RECOVERY_FETCH_TIMEOUT,
        Some(FetchFailure::Unavailable) => "archive_unusable",
        None => fallback,
    }
}

/// What the executor needs from the modules that own the database's unit and connection.
pub trait Host {
    /// Starts the database's unit, through admission, and returns once PostgreSQL accepts
    /// connections. `Failed` when the unit did not come up, which includes a recovery that died
    /// before PostgreSQL accepted connections.
    fn start(&self) -> impl Future<Output = Result<(), Failed>> + Send;
    /// Waits until the database has left recovery, and says who it is. `Failed` when its unit
    /// stopped first, the wait ran out, or PostgreSQL paused the recovery (its postmaster stays
    /// up, and nothing resumes it): the recovery did not reach its end.
    fn promoted(&self) -> impl Future<Output = Result<Restored, Failed>> + Send;
    /// Stops the promoted database and starts it again, still admitted, on the configuration the
    /// agent wrote (the recovery's settings are gone): the settings that a larger source made the
    /// recovery run with are the class's own again. `Failed` when the unit did not come up.
    fn restart(&self) -> impl Future<Output = Result<(), Failed>> + Send;
    /// Stops the unit and deletes the volume and the user of a build that failed.
    fn abandon(&self) -> impl Future<Output = ()> + Send;
}

/// The proven-sleep record of a move's source (`MoveSource.end` of the node contract): where the
/// committed WAL ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct End {
    pub system_identifier: String,
    pub timeline: u32,
    pub last_segment: String,
}

/// One restore, point-in-time restore or move to build.
pub struct Order<'a> {
    /// The new database: its user, its volume, the directory of its socket.
    pub database: &'a Database,
    /// The class it runs in: its memory (`memory.max`) and `max_connections`.
    pub memory_mib: u64,
    pub max_connections: u32,
    /// The user and group of the database, who own what the agent writes into its volume.
    pub uid: u32,
    pub gid: u32,
    /// The archive restored from (read-only), and the backup of it.
    pub source: &'a Store,
    pub backup_id: &'a str,
    /// A point-in-time restore: the contract timestamp to stop at.
    pub target_time: Option<&'a str>,
    /// A move: the source's proven-sleep record.
    pub end: Option<&'a End>,
    /// The database's own archive (a fresh path, read-write), and its upload log.
    pub store: &'a Store,
    pub upload_log: &'a UploadLog,
    /// The operation's id: it names the spool.
    pub operation: &'a str,
    /// The build was begun before and cut off by a restart of the agent: what the earlier run
    /// left is not trusted (`Restorer::begin_again`).
    pub resumed: bool,
}

/// What a build that is begun again goes on with (`Restorer::begin_again`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Resume {
    /// The earlier run's files are gone: the backup is fetched and recovered as for a new build.
    Afresh,
    /// The earlier run's database is promoted and its first base backup is DONE: both stay.
    Finish,
}

/// The node's table, jobs and credentials, which the executor works with.
pub struct Restorer<'a> {
    pub table: &'a Table,
    pub jobs: &'a Jobs,
    pub credentials: &'a Credentials,
    /// The `restore_command` client the node image installs (`recovery::WAL_FETCH_COMMAND`).
    pub fetch_command: &'a str,
}

impl Restorer<'_> {
    /// Builds the database of `order`. The newest base backup of its new timeline on success; on
    /// failure the node contract's error (`archive_unusable`, `build_failed`, `start_failed`,
    /// `no_recovery_point`, `identity_mismatch`) after the database was abandoned.
    pub async fn run<H: Host>(&self, order: &Order<'_>, host: &H) -> Result<Backup, &'static str> {
        let result = self.build(order, host).await;
        if result.is_err() {
            self.table.remove(&order.database.id);
            host.abandon().await;
        }
        result
    }

    async fn build<H: Host>(&self, order: &Order<'_>, host: &H) -> Result<Backup, &'static str> {
        let database = order.database;
        let class = Capacity::of_class(order.memory_mib, order.max_connections);
        // An order the settings cannot be made from fails before anything is fetched (they are
        // written below, with the settings the backup needs).
        recovery::settings(self.fetch_command, order.target_time, &class).ok_or("build_failed")?;

        let mut lap = Instant::now();
        // 1. The source's backup, DONE and with the size of its WAL segments.
        let listing = self
            .barman(
                order,
                order.source,
                Job::backup_list(order.source),
                "backup-list",
            )
            .await
            .map_err(|_| "archive_unusable")?;
        let backups = facts::parse_backup_list(&listing.stdout).map_err(|_| "archive_unusable")?;
        let backup = backups
            .iter()
            .find(|backup| backup.backup_id == order.backup_id && backup.status == "DONE")
            .ok_or("archive_unusable")?;
        let segment_bytes = backup.segment_bytes.ok_or("archive_unusable")?;
        phase(order, "listed", &mut lap);

        // 2. Its files, into the new database's data directory, unless the earlier run of this
        // build got further than that.
        let finishing = order.resumed && self.begin_again(order).await? == Resume::Finish;
        let spool = recovery::spool_directory(&database.volume, order.operation);
        let registration = |recovery| Registration {
            database: database.clone(),
            store: order.store.clone(),
            recovery,
            upload_log: order.upload_log.clone(),
        };
        let (capacity, fetch_status) = if finishing {
            // The database is the promoted one of the earlier run, with its first backup DONE.
            // It archives to its own store, and the host starts it on its class's own settings.
            recovery::finish(&database.data_directory(), &spool).map_err(|_| "build_failed")?;
            (class, self.table.set(registration(None)))
        } else {
            let restore = Job::restore(order.source, order.backup_id, &database.data_directory());
            self.barman(order, order.source, restore, "restore")
                .await
                .map_err(|_| "archive_unusable")?;
            phase(order, "base_fetched", &mut lap);

            // 3. The recovery settings, and the database known to the archive socket as
            // recovering. The backup's control file has the settings of the database it came
            // from.
            let source = proof::read_control(&database.volume)
                .ok()
                .and_then(|bytes| pg_control::parse_capacity(&bytes).ok())
                .ok_or("archive_unusable")?;
            let capacity = class.at_least(source);
            if !capacity.fits(order.memory_mib) {
                crate::timing::emit_event(json!({
                    "event": "restore_capacity_refused", "database_id": database.id,
                    "memory_mib": order.memory_mib,
                    "max_connections": capacity.max_connections,
                    "max_worker_processes": capacity.max_worker_processes,
                    "max_wal_senders": capacity.max_wal_senders,
                    "max_prepared_transactions": capacity.max_prepared_transactions,
                    "max_locks_per_transaction": capacity.max_locks_per_transaction,
                }));
                return Err("build_failed");
            }
            let settings = recovery::settings(self.fetch_command, order.target_time, &capacity)
                .ok_or("build_failed")?;
            recovery::prepare(&database.data_directory(), &settings, order.uid, order.gid)
                .map_err(|_| "build_failed")?;
            let status = self.table.set(registration(Some(Recovery {
                source: order.source.clone(),
                spool: spool.clone(),
                required_through: order.end.map(|end| end.last_segment.clone()),
                segment_bytes,
            })));
            (capacity, status)
        };

        // 4. Recovery to the end of the archive or the target, and the check of who promoted.
        host.start()
            .await
            .map_err(|_| recovery_error(&fetch_status, "start_failed"))?;
        phase(order, "recovery_started", &mut lap);
        let restored = host
            .promoted()
            .await
            .map_err(|_| recovery_error(&fetch_status, "no_recovery_point"))?;
        phase(order, "promoted", &mut lap);
        let end = order
            .end
            .map(|end| (end.system_identifier.as_str(), end.timeline));
        recovery::verify_restored(backup, end, &restored)?;

        // 5. Recovery is over. The settings and the spool go before the backup, which would
        // otherwise carry them; the database now archives to its own store. The first base
        // backup of a build that finishes is the earlier run's.
        if !finishing {
            self.table.set(registration(None));
            recovery::finish(&database.data_directory(), &spool).map_err(|_| "build_failed")?;
            // The database runs on the settings its recovery needed. It runs on its class's
            // before it counts as ready, and its first base backup records those.
            if capacity != class {
                host.restart().await.map_err(|_| "start_failed")?;
                phase(order, "restarted", &mut lap);
            }
            let first = Job::base_backup(order.store, database);
            self.barman(order, order.store, first, "backup")
                .await
                .map_err(|_| "build_failed")?;
        }
        let listing = self
            .barman(
                order,
                order.store,
                Job::backup_list(order.store),
                "backup-list",
            )
            .await
            .map_err(|_| "build_failed")?;
        // Only a DONE backup of the new timeline counts.
        let newest = facts::parse_backup_list(&listing.stdout)
            .ok()
            .and_then(|backups| {
                facts::newest_done(&backups)
                    .filter(|backup| backup.timeline == restored.timeline)
                    .cloned()
            })
            .ok_or("build_failed")?;
        phase(order, "first_backup", &mut lap);
        Ok(newest)
    }

    /// What a build that is begun again does before it fetches. The agent that began it went
    /// away (a release restarts it), and what it started stays: the unit of its fetch, which
    /// `barman-cloud-restore` would share the destination with and which refuses a destination
    /// that holds anything, and the files it wrote. The generation is the build's own and no
    /// client has been near it, so the fetch is stopped and the data directory and the spool go,
    /// as `build_create` makes a half made cluster again.
    ///
    /// Nothing is touched when the database's own archive already holds a DONE backup: the earlier
    /// run got that far, and the WAL this run archives next would replace the earlier run's under
    /// it. If that backup is of the cluster on the volume (its system identifier and its timeline
    /// are the control file's), the cluster is the promoted database of the earlier run and the
    /// build finishes over both (`Resume::Finish`), as `build_create` goes on over its own
    /// backup; the backup would otherwise be a long stretch of a batch, since its listing waits
    /// for the node's one big-job slot behind the other restores, and a rollout in it would fail
    /// the restore. Any other DONE backup refuses the build with `prefix_not_empty`. A backup the
    /// earlier run began and did not finish (barman uploads its `backup.info` as `STARTED` when it
    /// begins) is no backup of anything and stays where it is.
    async fn begin_again(&self, order: &Order<'_>) -> Result<Resume, &'static str> {
        let database = order.database;
        self.jobs
            .stop_earlier(&database.id, Kind::Restore)
            .await
            .map_err(|_| "build_failed")?;
        let listing = self
            .barman(
                order,
                order.store,
                Job::backup_list(order.store),
                "backup-list",
            )
            .await
            .map_err(|_| "archive_unusable")?;
        let backups = facts::parse_backup_list(&listing.stdout).map_err(|_| "archive_unusable")?;
        if backups.iter().any(|backup| backup.status == "DONE") {
            let cluster = proof::read_control(&database.volume)
                .ok()
                .and_then(|bytes| pg_control::parse_control(&bytes).ok());
            let ours = cluster.is_some_and(|cluster| {
                facts::newest_done(&backups).is_some_and(|backup| {
                    backup.system_identifier == cluster.system_identifier
                        && backup.timeline == cluster.timeline
                })
            });
            return if ours {
                Ok(Resume::Finish)
            } else {
                Err("prefix_not_empty")
            };
        }
        for directory in [
            database.data_directory(),
            recovery::spool_directory(&database.volume, order.operation),
        ] {
            match std::fs::remove_dir_all(directory) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                    return Err("build_failed");
                }
                _ => {}
            }
        }
        Ok(Resume::Afresh)
    }

    /// Runs a barman job of the new database against `store`, to its end; `Failed` for any reason
    /// (the caller names the error of its step).
    async fn barman(
        &self,
        order: &Order<'_>,
        store: &Store,
        job: Job,
        step: &str,
    ) -> Result<Outcome, Failed> {
        let credential = self
            .credentials
            .get(&store.scope, unix_seconds())
            .map_err(|_| Failed)?;
        let outcome = self
            .jobs
            .run(order.database, &job, &credential, None)
            .await
            .map_err(|_| Failed)?;
        if !outcome.succeeded() {
            log_failed_job(
                "restore_step_failed",
                &order.database.id,
                step,
                &outcome,
                &credential,
            );
            return Err(Failed);
        }
        Ok(outcome)
    }
}

/// Logs how long the phase that ends now took (plan 9.9: where the time of a restore goes), and
/// starts the clock of the next. `recovery_started` ends when PostgreSQL accepts connections
/// while it recovers, and `promoted` when the recovery reached the end of the archive or the
/// target and the roles and the checkpoint of the promoted database are done.
fn phase(order: &Order<'_>, name: &str, since: &mut Instant) {
    crate::timing::emit_event(json!({
        "event": "restore_phase", "database_id": order.database.id, "phase": name,
        "ms": u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX),
    }));
    *since = Instant::now();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        archive::{
            protocol::AGENT_BOUND,
            test_support::{Node, SEGMENT_BYTES, SOURCE, credential, database, directory, store},
        },
        credentials::Access,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    const BACKUP: &str = "20261017T225342";

    /// A host that is not to be reached: it records that it was, and that it abandoned.
    #[derive(Default)]
    struct Unreached {
        started: AtomicBool,
        abandoned: AtomicBool,
    }
    impl Host for Unreached {
        async fn start(&self) -> Result<(), Failed> {
            self.started.store(true, Ordering::SeqCst);
            Err(Failed)
        }
        async fn promoted(&self) -> Result<Restored, Failed> {
            self.started.store(true, Ordering::SeqCst);
            Err(Failed)
        }
        async fn restart(&self) -> Result<(), Failed> {
            self.started.store(true, Ordering::SeqCst);
            Err(Failed)
        }
        async fn abandon(&self) {
            self.abandoned.store(true, Ordering::SeqCst);
        }
    }

    /// A host whose database has been promoted already, as the one of a build that is begun again
    /// after the earlier run took its first base backup: it records what was asked of it.
    struct Promoted {
        system_identifier: &'static str,
        timeline: u32,
        started: AtomicBool,
        restarted: AtomicBool,
        abandoned: AtomicBool,
    }
    impl Promoted {
        fn on(system_identifier: &'static str, timeline: u32) -> Self {
            Self {
                system_identifier,
                timeline,
                started: AtomicBool::new(false),
                restarted: AtomicBool::new(false),
                abandoned: AtomicBool::new(false),
            }
        }
    }
    impl Host for Promoted {
        async fn start(&self) -> Result<(), Failed> {
            self.started.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn promoted(&self) -> Result<Restored, Failed> {
            Ok(Restored {
                in_recovery: false,
                system_identifier: self.system_identifier.into(),
                timeline: self.timeline,
            })
        }
        async fn restart(&self) -> Result<(), Failed> {
            self.restarted.store(true, Ordering::SeqCst);
            Ok(())
        }
        async fn abandon(&self) {
            self.abandoned.store(true, Ordering::SeqCst);
        }
    }

    fn entry(status: &str, segment_size: Option<u64>) -> String {
        let size = segment_size.map_or(String::new(), |size| {
            format!(r#","xlog_segment_size":{size}"#)
        });
        format!(
            r#"{{"backup_id":"{BACKUP}","status":"{status}","timeline":1,"systemid":"7697773764701949975","end_wal":"000000010000000000000003","end_time_iso":"2026-10-17T22:53:45+00:00"{size}}}"#
        )
    }

    /// A restore of `backup_id` from the node's `SOURCE` archive into a new volume. The caller
    /// brings the results.
    async fn restore_into(
        node: &Node,
        name: &str,
        backup_id: &str,
        target_time: Option<&str>,
    ) -> (Result<Backup, &'static str>, Unreached, std::path::PathBuf) {
        restore_again(node, name, backup_id, target_time, false).await
    }

    /// The same, of a build that was begun before (`resumed`) or not.
    async fn restore_again(
        node: &Node,
        name: &str,
        backup_id: &str,
        target_time: Option<&str>,
        resumed: bool,
    ) -> (Result<Backup, &'static str>, Unreached, std::path::PathBuf) {
        restore_with(
            node,
            name,
            backup_id,
            target_time,
            resumed,
            Unreached::default(),
        )
        .await
    }

    /// The same, over a host of the test's own.
    async fn restore_with<H: Host>(
        node: &Node,
        name: &str,
        backup_id: &str,
        target_time: Option<&str>,
        resumed: bool,
        host: H,
    ) -> (Result<Backup, &'static str>, H, std::path::PathBuf) {
        use std::os::unix::fs::MetadataExt;
        let volume = node.root.join(name);
        // The user and group the agent hands the recovery files to: the test's own.
        let owner = std::fs::metadata(&node.root).unwrap();
        let database = database(&volume);
        let new_archive = "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g2-op_dddddddddddddddddddd";
        let new_store = store(new_archive, Access::ReadWrite);
        node.credentials.hold(new_store.scope.clone(), credential());
        let source = store(SOURCE, Access::ReadOnly);
        let log = UploadLog::new(volume.join("uploads"));
        let order = Order {
            database: &database,
            // The smallest class of the catalog.
            memory_mib: 256,
            max_connections: 20,
            uid: owner.uid(),
            gid: owner.gid(),
            source: &source,
            backup_id,
            target_time,
            end: None,
            store: &new_store,
            upload_log: &log,
            operation: "op_dddddddddddddddddddd",
            resumed,
        };
        let restorer = Restorer {
            table: &node.table,
            jobs: &node.jobs,
            credentials: &node.credentials,
            fetch_command: recovery::WAL_FETCH_COMMAND,
        };
        let result = restorer.run(&order, &host).await;
        (result, host, volume)
    }

    #[tokio::test]
    async fn a_backup_the_source_does_not_offer_fails_the_operation_before_anything_is_written() {
        let node = Node::start("restore-unusable", AGENT_BOUND).await;
        let segment = Some(SEGMENT_BYTES);
        node.fixture
            .put_backup(SOURCE, "20261017T225300", &entry("FAILED", segment), None);
        node.fixture
            .put_backup(SOURCE, "20261017T225301", &entry("DONE", None), None);
        node.fixture
            .put_backup(SOURCE, BACKUP, &entry("DONE", segment), None);
        // Not in the listing, not DONE, not sized, not a base backup the restore can read.
        for (id, why) in [
            ("20261017T000000", "absent"),
            ("20261017T225300", "failed"),
            ("20261017T225301", "no segment size"),
        ] {
            let (result, host, volume) = restore_into(&node, "unusable", id, None).await;
            assert_eq!(result.unwrap_err(), "archive_unusable", "{why}");
            assert!(host.abandoned.load(Ordering::SeqCst), "{why}");
            assert!(!host.started.load(Ordering::SeqCst), "{why}");
            assert!(!volume.join("data").exists(), "{why}");
        }
        // The listing itself failing is no listing.
        node.fixture.set("list-fail", "");
        let (result, host, _) = restore_into(&node, "unusable", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "archive_unusable");
        assert!(host.abandoned.load(Ordering::SeqCst));
        node.fixture.clear("list-fail");
        // The backup listed, its files not readable: barman fails, nothing starts.
        node.fixture.set("restore-fail", "");
        let (result, host, _) = restore_into(&node, "unusable", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "archive_unusable");
        assert!(host.abandoned.load(Ordering::SeqCst));
        assert!(!host.started.load(Ordering::SeqCst));
        // A build that failed before the first backup wrote nothing to the database's own archive.
        assert!(
            !node
                .fixture
                .store_directory()
                .join("objects/pgcf-eu/eu-dev/abcdefghijklmnopqrst/g2-op_dddddddddddddddddddd")
                .exists()
        );
    }

    /// The agent that began the build went away with the unit of its fetch still running (a unit
    /// outlives the agent, and every rollout restarts the agent) and part of the destination
    /// written. barman refuses a destination that holds anything, so the build that is begun
    /// again must stop the earlier fetch and empty the directory of the generation it builds,
    /// which no client has seen, before it fetches.
    #[tokio::test]
    async fn a_restore_begun_again_stops_the_fetch_of_the_earlier_run_and_fetches_into_an_empty_directory()
     {
        let node = Node::start("restore-again", AGENT_BOUND).await;
        let files = backup_files("restore-again-files", Some(&Capacity::of_class(256, 20)));
        node.fixture.put_backup(
            SOURCE,
            BACKUP,
            &entry("DONE", Some(SEGMENT_BYTES)),
            Some(&files),
        );
        // The earlier run: a fetch that wrote part of the data directory and is still under way.
        let volume = node.root.join("again");
        let earlier = database(&volume);
        node.fixture.set("restore-slow", "30");
        let run = tokio::spawn({
            let (jobs, credentials) = (node.jobs.clone(), node.credentials.clone());
            let earlier = earlier.clone();
            async move {
                let source = store(SOURCE, Access::ReadOnly);
                let credential = credentials.get(&source.scope, unix_seconds()).unwrap();
                let job = Job::restore(&source, BACKUP, &earlier.data_directory());
                jobs.run(&earlier, &job, &credential, None).await
            }
        });
        for _ in 0..200 {
            if volume.join("data/PARTIAL").exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(volume.join("data/PARTIAL").exists());
        // The agent went away: its client dies, and the unit goes on.
        run.abort();
        let _ = run.await;
        assert_eq!(node.fixture.running_units().len(), 1);
        node.fixture.clear("restore-slow");

        let (result, host, volume) = restore_again(&node, "again", BACKUP, None, true).await;
        // The fetch ran to its end and the build went on to the start of the database, which the
        // host here does not give.
        assert_eq!(result.unwrap_err(), "start_failed");
        assert!(host.started.load(Ordering::SeqCst));
        assert!(node.fixture.running_units().is_empty());
        assert!(!volume.join("data/PARTIAL").exists());
        assert_eq!(
            std::fs::read_to_string(volume.join("data/PG_VERSION")).unwrap(),
            "18\n"
        );
    }

    /// A build that is begun again may not go on over a first base backup that the earlier run
    /// finished in the database's own archive: the WAL it archives next replaces the earlier
    /// run's, and the backup would not fit it. One the earlier run did not finish is no reason.
    #[tokio::test]
    async fn a_restore_begun_again_is_refused_when_its_own_archive_holds_a_finished_backup() {
        let node = Node::start("restore-again-archive", AGENT_BOUND).await;
        let files = backup_files(
            "restore-again-archive-files",
            Some(&Capacity::of_class(256, 20)),
        );
        node.fixture.put_backup(
            SOURCE,
            BACKUP,
            &entry("DONE", Some(SEGMENT_BYTES)),
            Some(&files),
        );
        let own = "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g2-op_dddddddddddddddddddd";
        // The earlier run began a first backup and did not finish it: the build goes on.
        node.fixture.put_backup(
            own,
            "20261017T225900",
            &entry("STARTED", Some(SEGMENT_BYTES)),
            None,
        );
        let (result, host, _) = restore_again(&node, "again-started", BACKUP, None, true).await;
        assert_eq!(result.unwrap_err(), "start_failed");
        assert!(host.started.load(Ordering::SeqCst));
        // One it finished: the build is refused.
        node.fixture.put_backup(
            own,
            "20261017T230000",
            &entry("DONE", Some(SEGMENT_BYTES)),
            None,
        );
        let (result, host, volume) =
            restore_again(&node, "again-archive", BACKUP, None, true).await;
        assert_eq!(result.unwrap_err(), "prefix_not_empty");
        assert!(!host.started.load(Ordering::SeqCst));
        assert!(host.abandoned.load(Ordering::SeqCst));
        // Nothing was fetched.
        assert!(!volume.join("data").exists());
    }

    /// The agent restarts after the first base backup of a restore is DONE in the database's own
    /// archive and before the build is recorded as built: in a batch that is a long stretch, since
    /// the listing that follows the backup waits for the node's one big-job slot behind the other
    /// restores. The database is the promoted one on the volume and its backup is DONE: the build
    /// that is begun again finishes over them. It does not fetch again (barman refuses a directory
    /// that holds anything), take another backup (the WAL it would archive replaces the earlier
    /// run's under the first) or fail the operation.
    #[tokio::test]
    async fn a_restore_begun_again_after_its_first_backup_was_done_finishes_over_that_backup() {
        const SYSTEM: &str = "7431215993172011234";
        let node = Node::start("restore-finish", AGENT_BOUND).await;
        let class = Capacity::of_class(256, 20);
        let files = backup_files("restore-finish-files", Some(&class));
        let listed = |id: &str, timeline: u32| {
            format!(
                r#"{{"backup_id":"{id}","status":"DONE","timeline":{timeline},"systemid":"{SYSTEM}","end_wal":"000000010000000000000003","end_time_iso":"2026-10-17T22:53:45+00:00","xlog_segment_size":{SEGMENT_BYTES}}}"#
            )
        };
        node.fixture
            .put_backup(SOURCE, BACKUP, &listed(BACKUP, 1), Some(&files));
        let own = "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g2-op_dddddddddddddddddddd";
        node.fixture
            .put_backup(own, "20261017T230000", &listed("20261017T230000", 2), None);
        // What the earlier run left on the volume: the promoted database, on timeline 2.
        let data = node.root.join("finish/data");
        std::fs::create_dir_all(data.join("global")).unwrap();
        let mut control = crate::pg_control::control_file(&class);
        control[48..52].copy_from_slice(&2u32.to_le_bytes());
        std::fs::write(data.join("global/pg_control"), control).unwrap();
        std::fs::write(data.join("PG_VERSION"), "18\n").unwrap();
        std::fs::write(data.join("rows"), "the earlier run's data").unwrap();
        // Another base backup or another fetch would fail and leave a note.
        let noted = node.root.join("noted");
        for command in ["barman-cloud-backup", "barman-cloud-restore"] {
            node.fixture.install(
                command,
                format!(
                    "#!/bin/sh\necho {command} >> '{}'\nexit 1\n",
                    noted.display()
                ),
            );
        }

        let (result, host, _) =
            restore_with(&node, "finish", BACKUP, None, true, Promoted::on(SYSTEM, 2)).await;
        let backup = result.unwrap();
        assert_eq!(
            (backup.backup_id.as_str(), backup.timeline),
            ("20261017T230000", 2)
        );
        assert!(host.started.load(Ordering::SeqCst));
        assert!(!host.restarted.load(Ordering::SeqCst));
        assert!(!host.abandoned.load(Ordering::SeqCst));
        assert!(!noted.exists(), "{:?}", std::fs::read_to_string(&noted));
        assert_eq!(
            std::fs::read_to_string(data.join("rows")).unwrap(),
            "the earlier run's data"
        );
    }

    /// The files of a backup of a cluster that ran with `capacity`: no more than what a restore
    /// reads of it.
    fn backup_files(name: &str, capacity: Option<&Capacity>) -> std::path::PathBuf {
        let files = directory(name);
        std::fs::write(files.join("PG_VERSION"), "18\n").unwrap();
        if let Some(capacity) = capacity {
            std::fs::create_dir_all(files.join("global")).unwrap();
            std::fs::write(
                files.join("global/pg_control"),
                crate::pg_control::control_file(capacity),
            )
            .unwrap();
        }
        files
    }

    #[tokio::test]
    async fn a_database_that_does_not_start_is_abandoned_with_its_files_prepared() {
        let node = Node::start("restore-start", AGENT_BOUND).await;
        // The backup of a database of the catalog's md class, restored into xs.
        let files = backup_files("restore-start-files", Some(&Capacity::of_class(1024, 200)));
        node.fixture.put_backup(
            SOURCE,
            BACKUP,
            &entry("DONE", Some(SEGMENT_BYTES)),
            Some(&files),
        );
        let (result, host, volume) = restore_into(&node, "start", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "start_failed");
        assert!(host.started.load(Ordering::SeqCst));
        assert!(host.abandoned.load(Ordering::SeqCst));
        // The backup's files were restored, and the recovery settings written next to them for
        // the database's user (here the test's); the volume itself is the host's to delete.
        assert_eq!(
            std::fs::read_to_string(volume.join("data/PG_VERSION")).unwrap(),
            "18\n"
        );
        let settings =
            std::fs::read_to_string(volume.join("data").join(recovery::SETTINGS_FILE)).unwrap();
        assert!(settings.contains("restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'"));
        // The recovery runs with the larger of each setting: md's connections (200), workers (8)
        // and senders (10); the locks and prepared transactions are the same in both classes.
        for line in [
            "max_connections = 200",
            "max_worker_processes = 8",
            "max_wal_senders = 10",
            "max_prepared_transactions = 0",
            "max_locks_per_transaction = 64",
        ] {
            assert!(settings.lines().any(|l| l == line), "{line}\n{settings}");
        }
        assert!(volume.join("data").join(recovery::SIGNAL_FILE).exists());
    }

    #[tokio::test]
    async fn a_backup_without_a_readable_control_file_is_unusable_and_nothing_is_written() {
        let node = Node::start("restore-control", AGENT_BOUND).await;
        let segment = Some(SEGMENT_BYTES);
        let no_control = backup_files("restore-no-control", None);
        node.fixture
            .put_backup(SOURCE, BACKUP, &entry("DONE", segment), Some(&no_control));
        let (result, host, volume) = restore_into(&node, "no-control", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "archive_unusable");
        assert!(host.abandoned.load(Ordering::SeqCst));
        assert!(!host.started.load(Ordering::SeqCst));
        assert!(!volume.join("data").join(recovery::SETTINGS_FILE).exists());

        // The control file of another release is as good as none.
        let other = backup_files("restore-other-release", Some(&Capacity::of_class(256, 20)));
        let mut bytes = std::fs::read(other.join("global/pg_control")).unwrap();
        bytes[8..12].copy_from_slice(&1700u32.to_le_bytes());
        std::fs::write(other.join("global/pg_control"), bytes).unwrap();
        node.fixture
            .put_backup(SOURCE, BACKUP, &entry("DONE", segment), Some(&other));
        let (result, host, _) = restore_into(&node, "other-release", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "archive_unusable");
        assert!(!host.started.load(Ordering::SeqCst));
    }

    /// The class's memory limit is the unit's: a recovery whose settings need more shared memory
    /// than half of it is refused before the database starts, with the settings in the log, and
    /// does not run into the kernel's out-of-memory kill.
    #[tokio::test]
    async fn a_source_whose_settings_the_class_has_no_memory_for_is_refused_before_it_starts() {
        let node = Node::start("restore-memory", AGENT_BOUND).await;
        let files = backup_files(
            "restore-memory-files",
            Some(&Capacity::of_class(4096, 10_000)),
        );
        node.fixture.put_backup(
            SOURCE,
            BACKUP,
            &entry("DONE", Some(SEGMENT_BYTES)),
            Some(&files),
        );
        let (result, host, volume) = restore_into(&node, "memory", BACKUP, None).await;
        assert_eq!(result.unwrap_err(), "build_failed");
        assert!(host.abandoned.load(Ordering::SeqCst));
        assert!(!host.started.load(Ordering::SeqCst));
        assert!(!volume.join("data").join(recovery::SETTINGS_FILE).exists());
    }

    #[tokio::test]
    async fn a_target_time_that_is_no_contract_timestamp_fails_before_the_restore_runs() {
        let node = Node::start("restore-time", AGENT_BOUND).await;
        let files = directory("restore-files");
        std::fs::write(files.join("PG_VERSION"), "18\n").unwrap();
        node.fixture.put_backup(
            SOURCE,
            BACKUP,
            &entry("DONE", Some(SEGMENT_BYTES)),
            Some(&files),
        );
        let (result, host, volume) =
            restore_into(&node, "time", BACKUP, Some("2026-10-17 22:53:45")).await;
        assert_eq!(result.unwrap_err(), "build_failed");
        assert!(host.abandoned.load(Ordering::SeqCst));
        assert!(!volume.join("data").exists());
    }
}
