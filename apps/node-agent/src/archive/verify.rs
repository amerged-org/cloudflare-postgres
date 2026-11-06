// SPDX-License-Identifier: Apache-2.0
//! A non-serving recovery of a pinned archive before its sole local copy may be removed.
//!
//! The caller owns an isolated scratch account, volume, private socket and unit, and keeps the
//! source generation stopped and fenced. This executor only lists/fetches the read-only archive,
//! recovers through its proven committed WAL and verifies PostgreSQL's identity. It never applies
//! tenant roles, installs the event schema, drains an outbox, publishes a route or takes a backup.
//! The caller persists the result and proves scratch cleanup before reporting verification done.
use super::{
    facts,
    job::{Database, Job, Jobs, Outcome, Store},
    protocol::is_segment,
    recovery::{self, Restored},
    restore::{End, Failed, recovery_error},
    server::{FetchStatus, Recovery, Registration, Table, log_failed_job, unix_seconds},
    upload_log::UploadLog,
};
use crate::{
    credentials::{Access, Credentials},
    pg_control, proof,
    settings::Capacity,
};
use std::{future::Future, sync::Arc};

/// The isolated scratch host, never the source database's serving host. `start` must use an
/// agent-owned configuration and private socket; no file supplied by the backup may override it.
/// `promoted` only waits for recovery and reads identity; it must not apply roles or events.
pub trait Host {
    fn start(&self) -> impl Future<Output = Result<(), Failed>> + Send;
    fn promoted(&self) -> impl Future<Output = Result<Restored, Failed>> + Send;
}

/// One scratch verification. All paths, accounts and identifiers belong to this operation; the
/// scratch database ID is deliberately different from the retained source database's ID.
pub struct Order<'a> {
    pub database: &'a Database,
    pub memory_mib: u64,
    pub max_connections: u32,
    pub uid: u32,
    pub gid: u32,
    pub source: &'a Store,
    pub backup_id: &'a str,
    pub end: &'a End,
    pub operation: &'a str,
}

pub struct Verifier<'a> {
    pub table: &'a Table,
    pub jobs: &'a Jobs,
    pub credentials: &'a Credentials,
    pub fetch_command: &'a str,
}

/// Dropping a cancelled verification removes only its own registration, not a later replacement.
struct Registered<'a> {
    table: &'a Table,
    database: &'a str,
    status: Arc<FetchStatus>,
}
impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.table.remove_if_current(self.database, &self.status);
    }
}

impl Verifier<'_> {
    /// Returns only after full archive recovery and identity verification. Neither success nor
    /// failure deletes scratch files: the orchestration journal owns their durable cleanup.
    pub async fn run<H: Host>(
        &self,
        order: &Order<'_>,
        host: &H,
    ) -> Result<Restored, &'static str> {
        let source =
            crate::node_link::archive_path(&order.source.destination).ok_or("archive_unusable")?;
        if order.source.scope.access != Access::ReadOnly
            || Store::new(
                &order.source.destination,
                &order.source.endpoint_url,
                Access::ReadOnly,
            )
            .as_ref()
                != Some(order.source)
            || order.database.id == source.database
            || !is_segment(&order.end.last_segment)
            || u32::from_str_radix(&order.end.last_segment[..8], 16).ok()
                != Some(order.end.timeline)
        {
            return Err("identity_mismatch");
        }
        // Validate the native command path before invoking any external tool.
        let class = Capacity::of_class(order.memory_mib, order.max_connections);
        recovery::settings(self.fetch_command, None, &class).ok_or("build_failed")?;

        let listing = self
            .barman(order, Job::backup_list(order.source), "backup-list")
            .await?;
        let backups = facts::parse_backup_list(&listing.stdout).map_err(|_| "archive_unusable")?;
        let backup = backups
            .iter()
            .find(|backup| backup.backup_id == order.backup_id && backup.status == "DONE")
            .ok_or("archive_unusable")?;
        if backup.system_identifier != order.end.system_identifier
            || backup.timeline == 0
            || backup.timeline > order.end.timeline
            || backup
                .end_wal
                .as_ref()
                .is_some_and(|last| !is_segment(last) || last > &order.end.last_segment)
        {
            return Err("identity_mismatch");
        }
        let segment_bytes = backup.segment_bytes.ok_or("archive_unusable")?;
        if !(1024 * 1024..=1024 * 1024 * 1024).contains(&segment_bytes)
            || !segment_bytes.is_power_of_two()
        {
            return Err("archive_unusable");
        }

        // Claim the private registration before touching scratch files. An ID collision must
        // never replace a serving registration or write into its volume.
        let status = self
            .table
            .set_if_absent(Registration {
                database: order.database.clone(),
                // Read-only scope also makes the archive server refuse PUT attempts locally.
                store: order.source.clone(),
                recovery: Some(Recovery {
                    source: order.source.clone(),
                    spool: recovery::spool_directory(&order.database.volume, order.operation),
                    required_through: Some(order.end.last_segment.clone()),
                    segment_bytes,
                }),
                upload_log: UploadLog::new(order.database.volume.join("verification-uploads")),
            })
            .ok_or("identity_mismatch")?;
        let registered = Registered {
            table: self.table,
            database: &order.database.id,
            status,
        };

        self.barman(
            order,
            Job::restore(
                order.source,
                order.backup_id,
                &order.database.data_directory(),
            ),
            "restore",
        )
        .await?;

        let source_capacity = proof::read_control(&order.database.volume)
            .ok()
            .and_then(|bytes| pg_control::parse_capacity(&bytes).ok())
            .ok_or("archive_unusable")?;
        let capacity = class.at_least(source_capacity);
        if !capacity.fits(order.memory_mib) {
            return Err("build_failed");
        }
        let mut settings =
            recovery::settings(self.fetch_command, None, &capacity).ok_or("build_failed")?;
        // Defense in depth alongside the host's controlled base configuration: the promoted
        // verifier cannot archive, expose TCP, or load extension workers from the source.
        settings.push_str(
            "archive_mode = off\narchive_command = ''\nlisten_addresses = ''\n\
             shared_preload_libraries = ''\nsession_preload_libraries = ''\n\
             local_preload_libraries = ''\nautovacuum = off\n",
        );
        recovery::prepare(
            &order.database.data_directory(),
            &settings,
            order.uid,
            order.gid,
        )
        .map_err(|_| "build_failed")?;
        host.start()
            .await
            .map_err(|_| recovery_error(&registered.status, "start_failed"))?;
        let restored = host
            .promoted()
            .await
            .map_err(|_| recovery_error(&registered.status, "no_recovery_point"))?;
        recovery::verify_restored(
            backup,
            Some((&order.end.system_identifier, order.end.timeline)),
            &restored,
        )?;
        Ok(restored)
    }

    async fn barman(
        &self,
        order: &Order<'_>,
        job: Job,
        step: &str,
    ) -> Result<Outcome, &'static str> {
        let credential = self
            .credentials
            .get(&order.source.scope, unix_seconds())
            .map_err(|_| "archive_unusable")?;
        let outcome = self
            .jobs
            .run(order.database, &job, &credential, None)
            .await
            .map_err(|_| "archive_unusable")?;
        if !outcome.succeeded() {
            log_failed_job(
                "archive_verification_step_failed",
                &order.database.id,
                step,
                &outcome,
                &credential,
            );
            return Err("archive_unusable");
        }
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive::{
        protocol::AGENT_BOUND,
        test_support::{ARCHIVE, Node, database, store},
    };
    use std::{
        os::unix::fs::MetadataExt,
        sync::atomic::{AtomicBool, Ordering},
    };

    #[derive(Default)]
    struct Unreached(AtomicBool);
    impl Host for Unreached {
        async fn start(&self) -> Result<(), Failed> {
            self.0.store(true, Ordering::SeqCst);
            Err(Failed)
        }
        async fn promoted(&self) -> Result<Restored, Failed> {
            self.0.store(true, Ordering::SeqCst);
            Err(Failed)
        }
    }

    #[tokio::test]
    async fn verification_refuses_source_identity_and_write_credentials_before_fetching() {
        let node = Node::start("verify-identity", AGENT_BOUND).await;
        let owner = std::fs::metadata(&node.root).unwrap();
        let source = store(ARCHIVE, Access::ReadOnly);
        let end = End {
            system_identifier: "7697773764701949975".into(),
            timeline: 1,
            last_segment: "000000010000000000000003".into(),
        };
        let verifier = Verifier {
            table: &node.table,
            jobs: &node.jobs,
            credentials: &node.credentials,
            fetch_command: recovery::WAL_FETCH_COMMAND,
        };
        let host = Unreached::default();
        let scratch = database(&node.root.join("scratch"));
        let mut order = Order {
            database: &scratch,
            memory_mib: 256,
            max_connections: 20,
            uid: owner.uid(),
            gid: owner.gid(),
            source: &source,
            backup_id: "20261017T225342",
            end: &end,
            operation: "op_dddddddddddddddddddd",
        };
        // The ordinary logical database ID cannot be used for verification.
        assert_eq!(verifier.run(&order, &host).await, Err("identity_mismatch"));
        let mut isolated = scratch.clone();
        isolated.id = "cccccccccccccccccccc".into();
        let writable = store(ARCHIVE, Access::ReadWrite);
        order.database = &isolated;
        order.source = &writable;
        assert_eq!(verifier.run(&order, &host).await, Err("identity_mismatch"));
        assert!(!host.0.load(Ordering::SeqCst));
        assert!(!scratch.data_directory().exists());
        assert!(!node.fixture.store_directory().join("key-id").exists());
        assert!(
            node.table
                .archives("abcdefghijklmnopqrst", &writable, &node.log(),)
        );
    }

    #[tokio::test]
    async fn a_missing_backup_never_starts_the_verifier_or_replaces_the_source_registration() {
        let node = Node::start("verify-missing", AGENT_BOUND).await;
        let owner = std::fs::metadata(&node.root).unwrap();
        let mut scratch = database(&node.root.join("scratch"));
        scratch.id = "cccccccccccccccccccc".into();
        let source = store(ARCHIVE, Access::ReadOnly);
        let end = End {
            system_identifier: "7697773764701949975".into(),
            timeline: 1,
            last_segment: "000000010000000000000003".into(),
        };
        let verifier = Verifier {
            table: &node.table,
            jobs: &node.jobs,
            credentials: &node.credentials,
            fetch_command: recovery::WAL_FETCH_COMMAND,
        };
        let host = Unreached::default();
        assert_eq!(
            verifier
                .run(
                    &Order {
                        database: &scratch,
                        memory_mib: 256,
                        max_connections: 20,
                        uid: owner.uid(),
                        gid: owner.gid(),
                        source: &source,
                        backup_id: "20261017T225342",
                        end: &end,
                        operation: "op_dddddddddddddddddddd",
                    },
                    &host
                )
                .await,
            Err("archive_unusable")
        );
        assert!(!host.0.load(Ordering::SeqCst));
        assert!(!scratch.data_directory().exists());
        assert!(node.table.archives(
            "abcdefghijklmnopqrst",
            &store(ARCHIVE, Access::ReadWrite),
            &node.log(),
        ));
    }
}
