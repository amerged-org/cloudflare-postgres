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
//!    source's last segment, `End`).
//! 4. Start it and wait for it to promote; check that it is the backup's database on a later
//!    timeline (and the source's, for a move).
//! 5. Remove the recovery settings and the spool, and take the first base backup of the new
//!    timeline into the database's own archive; it counts only when the listing shows it DONE.
//!
//! The caller creates the new database's user and its volume (at least as large as the source's)
//! first, and resets the roles of the page once the database is ready (plan 7.8 step 5): the
//! backup role of the restored cluster is the source's, and the first backup uses it as it is.
//! A step that fails fails the operation with the node contract's error, and the database is
//! abandoned (`Host::abandon`: stopped, its volume and user deleted).
use super::{
    facts::{self, Backup},
    job::{Database, Job, Jobs, Outcome, Store},
    recovery::{self, Restored},
    server::{Recovery, Registration, Table, log_failed_job, unix_seconds},
    upload_log::UploadLog,
};
use crate::credentials::Credentials;
use std::future::Future;

/// What a step of the host did not do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failed;

/// What the executor needs from the modules that own the database's unit and connection.
pub trait Host {
    /// Starts the database's unit, through admission, and returns once PostgreSQL accepts
    /// connections. `Failed` when the unit did not come up, which includes a recovery that died
    /// before PostgreSQL accepted connections.
    fn start(&self) -> impl Future<Output = Result<(), Failed>> + Send;
    /// Waits until the database has left recovery, and says who it is. `Failed` when its unit
    /// stopped first, or the wait ran out: the recovery did not reach its end.
    fn promoted(&self) -> impl Future<Output = Result<Restored, Failed>> + Send;
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
            self.table.remove(order.uid);
            host.abandon().await;
        }
        result
    }

    async fn build<H: Host>(&self, order: &Order<'_>, host: &H) -> Result<Backup, &'static str> {
        let database = order.database;
        // An order the settings cannot be made from fails before anything is fetched.
        let settings =
            recovery::settings(self.fetch_command, order.target_time).ok_or("build_failed")?;

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

        // 2. Its files, into the new database's data directory.
        let restore = Job::restore(order.source, order.backup_id, &database.data_directory());
        self.barman(order, order.source, restore, "restore")
            .await
            .map_err(|_| "archive_unusable")?;

        // 3. The recovery settings, and the database known to the archive socket as recovering.
        recovery::prepare(&database.data_directory(), &settings, order.uid, order.gid)
            .map_err(|_| "build_failed")?;
        let spool = recovery::spool_directory(&database.volume, order.operation);
        let registration = |recovery| Registration {
            database: database.clone(),
            uid: order.uid,
            store: order.store.clone(),
            recovery,
            upload_log: order.upload_log.clone(),
        };
        self.table.set(registration(Some(Recovery {
            source: order.source.clone(),
            spool: spool.clone(),
            required_through: order.end.map(|end| end.last_segment.clone()),
            segment_bytes,
        })));

        // 4. Recovery to the end of the archive or the target, and the check of who promoted.
        host.start().await.map_err(|_| "start_failed")?;
        let restored = host.promoted().await.map_err(|_| "no_recovery_point")?;
        let end = order
            .end
            .map(|end| (end.system_identifier.as_str(), end.timeline));
        recovery::verify_restored(backup, end, &restored)?;

        // 5. Recovery is over. The settings and the spool go before the backup, which would
        // otherwise carry them; the database now archives to its own store.
        self.table.set(registration(None));
        recovery::finish(&database.data_directory(), &spool).map_err(|_| "build_failed")?;
        let first = Job::base_backup(order.store, database);
        self.barman(order, order.store, first, "backup")
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
            .map_err(|_| "build_failed")?;
        // Only a DONE backup of the new timeline counts.
        facts::parse_backup_list(&listing.stdout)
            .ok()
            .and_then(|backups| {
                facts::newest_done(&backups)
                    .filter(|backup| backup.timeline == restored.timeline)
                    .cloned()
            })
            .ok_or("build_failed")
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
            uid: owner.uid(),
            gid: owner.gid(),
            source: &source,
            backup_id,
            target_time,
            end: None,
            store: &new_store,
            upload_log: &log,
            operation: "op_dddddddddddddddddddd",
        };
        let host = Unreached::default();
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

    #[tokio::test]
    async fn a_database_that_does_not_start_is_abandoned_with_its_files_prepared() {
        let node = Node::start("restore-start", AGENT_BOUND).await;
        let files = directory("restore-start-files");
        std::fs::write(files.join("PG_VERSION"), "18\n").unwrap();
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
        assert!(
            std::fs::read_to_string(volume.join("data").join(recovery::SETTINGS_FILE))
                .unwrap()
                .contains("restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'")
        );
        assert!(volume.join("data").join(recovery::SIGNAL_FILE).exists());
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
