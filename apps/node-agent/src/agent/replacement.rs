// SPDX-License-Identifier: Apache-2.0
//! In-place PITR retains its stopped source and connection identity while building a newer
//! generation. Its dedicated journal survives failures, restarts and forward rollback attempts.
use super::{Core, Db, Desired, Entry, Origin, Source};
use crate::{
    machine::Machine,
    node_link::archive_path,
    proof,
    state::{
        DatabaseState, ProvenSleepRecord,
        replacement::{Attempt, Replacement},
    },
    storage::VolumeId,
};

pub(super) const CLEANUP_PENDING: &str = "replacement_cleanup_pending";

fn attempt(entry: &Entry, rollback: bool) -> Attempt {
    Attempt {
        generation: entry.storage_generation,
        operation: entry.operation.clone(),
        archive_path: entry.archive_path.clone(),
        rollback,
        failed: false,
    }
}

/// Also applied before adopting an already-built target: its volume alone does not prove which
/// operation, source or requested point it was built for.
fn matches_journal(entry: &Entry, journal: &Replacement) -> bool {
    let (source, previous, end) = match &entry.origin {
        Some(Origin::Replace(source, previous, end)) => {
            if journal.target_generation != entry.storage_generation
                || source.backup_id != journal.backup_id
                || source.target_time != journal.target_time
                || journal.attempt != attempt(entry, false)
            {
                return false;
            }
            (source, previous, end)
        }
        Some(Origin::ReplaceRollback(source, previous, end, replacement)) => {
            if *replacement != journal.target_generation
                || source.target_time.is_some()
                || source.backup_id
                    != journal
                        .source
                        .backup
                        .as_ref()
                        .map(|b| b.backup_id.as_str())
                        .unwrap_or("")
                || entry.storage_generation <= *replacement
                || entry.storage_generation < journal.attempt.generation
                || (entry.storage_generation == journal.attempt.generation
                    && journal.attempt != attempt(entry, true))
            {
                return false;
            }
            (source, previous, end)
        }
        _ => return false,
    };
    entry.operation == journal.operation
        && source.database_id == entry.id
        && source.path == journal.source_path
        && *previous == journal.source.storage_generation
        && journal.source.record.as_ref() == Some(end)
}

impl<M: Machine> Core<M> {
    /// A durable generation floor and exact origin identity apply on every adoption, not just a
    /// build. Ordinary origin-less lifecycle pages after cutover may use the promoted generation.
    pub(super) fn replacement_blocks(&self, db: &Db, entry: &Entry) -> bool {
        if entry.desired == Desired::Deleted {
            return false;
        }
        let explicit = entry.replaces_storage();
        let built = db
            .view()
            .state
            .as_ref()
            .is_some_and(|s| s.built && s.storage_generation == entry.storage_generation);
        let journal = match self.files(&db.id).load_replacement() {
            Ok(None) => return explicit && built,
            Ok(Some(journal)) => journal,
            Err(_) => return true,
        };
        if self.prior_replacement_cleanup_pending(entry, &journal) {
            return false;
        }
        if entry.storage_generation < journal.attempt.generation
            || (entry.storage_generation == journal.attempt.generation && journal.attempt.failed)
        {
            return true;
        }
        if explicit {
            !matches_journal(entry, &journal)
                || (built && entry.storage_generation != journal.attempt.generation)
        } else {
            entry.storage_generation != journal.attempt.generation
        }
    }

    /// A new operation may arrive with the previous operation's source cleanup still pending.
    /// Its source must be exactly that operation's backed-up promoted generation and proven
    /// sleep. Keep the old journal until its own cleanup runs; this is no failed new restore.
    fn prior_replacement_cleanup_pending(&self, entry: &Entry, journal: &Replacement) -> bool {
        let (source, previous, end) = match &entry.origin {
            Some(
                Origin::Replace(source, previous, end)
                | Origin::ReplaceRollback(source, previous, end, _),
            ) => (source, previous, end),
            _ => return false,
        };
        entry.operation != journal.operation
            && !journal.attempt.failed
            && *previous == journal.attempt.generation
            && source.database_id == entry.id
            && source.path == journal.attempt.archive_path
            && self
                .files(&entry.id)
                .load()
                .ok()
                .flatten()
                .is_some_and(|state| {
                    state.built
                        && state.backup.is_some()
                        && state.storage_generation == *previous
                        && state.record.as_ref() == Some(end)
                })
    }

    /// Only a currently retained, built source whose exact full proof matches the instruction
    /// can seed a journal. This also permits rollback after the first journal write failed.
    async fn capture_replacement_source(
        &self,
        entry: &Entry,
        source: &Source,
        previous: u64,
        end: &ProvenSleepRecord,
    ) -> Result<DatabaseState, &'static str> {
        let held = self
            .files(&entry.id)
            .load()
            .map_err(|_| "build_failed")?
            .ok_or("build_failed")?;
        let path = archive_path(&source.path).ok_or("build_failed")?;
        if source.database_id != entry.id
            || path.database != entry.id
            || path.generation != previous
            || previous >= entry.storage_generation
            || !held.built
            || held.storage_generation != previous
            || held.record.as_ref() != Some(end)
            || held.backup.is_none()
            || self
                .machine
                .unit(&entry.id)
                .await
                .map_err(|_| "build_failed")?
                .active
                .awake()
        {
            return Err("build_failed");
        }
        let volume = VolumeId::new(&entry.id, previous).map_err(|_| "build_failed")?;
        if !self
            .machine
            .has_volume(&volume)
            .await
            .map_err(|_| "build_failed")?
        {
            return Err("volume_missing");
        }
        if !self.machine.attached(&volume)
            && !self
                .machine
                .mount_volumes(std::slice::from_ref(&volume))
                .await
                .map_err(|_| "build_failed")?
                .is_empty()
        {
            return Err("build_failed");
        }
        proof::wake_check(Some(end), &self.layout().volume(&entry.id))
            .map_err(|_| "build_failed")?;
        Ok(held)
    }

    /// Persisted before target state or storage is changed, including when credentials have not
    /// arrived. Each rollback is explicit and uses the same operation at a higher generation.
    pub(super) async fn prepare_replacement(&self, entry: &Entry) -> Result<(), &'static str> {
        let files = self.files(&entry.id);
        if let Some(mut journal) = files.load_replacement().map_err(|_| "build_failed")? {
            if self.prior_replacement_cleanup_pending(entry, &journal) {
                return Err(CLEANUP_PENDING);
            }
            if !matches_journal(entry, &journal) {
                return Err("build_failed");
            }
            self.check_replacement_writer(entry, &journal).await?;
            if self.replacement_rollback(entry) {
                let next = attempt(entry, true);
                if journal.attempt != next {
                    self.finish_staged_cleanup(entry, &mut journal).await?;
                    journal.retiring_generation = Some(journal.attempt.generation);
                    journal.attempt = next;
                    files
                        .save_replacement(&journal)
                        .map_err(|_| "build_failed")?;
                }
                self.finish_staged_cleanup(entry, &mut journal).await?;
            }
            return Ok(());
        }
        let (source, previous, end, target_generation, rollback) = match &entry.origin {
            Some(Origin::Replace(source, previous, end)) => {
                (source, *previous, end, entry.storage_generation, false)
            }
            Some(Origin::ReplaceRollback(source, previous, end, target)) => {
                if *previous >= *target
                    || *target >= entry.storage_generation
                    || source.target_time.is_some()
                {
                    return Err("build_failed");
                }
                (source, *previous, end, *target, true)
            }
            _ => return Ok(()),
        };
        let held = self
            .capture_replacement_source(entry, source, previous, end)
            .await?;
        if rollback && source.backup_id != held.backup.as_ref().ok_or("build_failed")?.backup_id {
            return Err("build_failed");
        }
        let journal = Replacement {
            operation: entry.operation.clone(),
            target_generation,
            source_path: source.path.clone(),
            backup_id: source.backup_id.clone(),
            target_time: source.target_time.clone(),
            source: held,
            attempt: attempt(entry, rollback),
            retiring_generation: None,
        };
        files.save_replacement(&journal).map_err(|_| "build_failed")
    }

    /// Reject any writer whose actual mounted generation the journal does not own. The original
    /// source is never stopped to manufacture a missing proof.
    async fn check_replacement_writer(
        &self,
        entry: &Entry,
        journal: &Replacement,
    ) -> Result<(), &'static str> {
        let source = VolumeId::new(&entry.id, journal.source.storage_generation)
            .map_err(|_| "build_failed")?;
        if !self
            .machine
            .has_volume(&source)
            .await
            .map_err(|_| "build_failed")?
        {
            return Err("volume_missing");
        }
        let held = self
            .machine
            .unit_volume(&entry.id)
            .await
            .map_err(|_| "build_failed")?;
        match held {
            Some(held) if held.generation() == journal.source.storage_generation => {
                if self
                    .machine
                    .unit(&entry.id)
                    .await
                    .map_err(|_| "build_failed")?
                    .active
                    .awake()
                {
                    return Err("build_failed");
                }
            }
            Some(held)
                if held.generation() == journal.attempt.generation
                    || Some(held.generation()) == journal.retiring_generation => {}
            Some(_) => return Err("build_failed"),
            None => {
                if self
                    .machine
                    .unit(&entry.id)
                    .await
                    .map_err(|_| "build_failed")?
                    .active
                    .awake()
                {
                    return Err("build_failed");
                }
            }
        }
        Ok(())
    }

    /// Explicit rollback authorizes discarding this operation's unpublished target, never its
    /// original source. The durable intent precedes stopping or deleting anything, so restart
    /// can finish the same cleanup without requiring room for three database generations.
    async fn finish_staged_cleanup(
        &self,
        entry: &Entry,
        journal: &mut Replacement,
    ) -> Result<(), &'static str> {
        let Some(generation) = journal.retiring_generation else {
            return Ok(());
        };
        let staged = VolumeId::new(&entry.id, generation).map_err(|_| "build_failed")?;
        if self
            .machine
            .unit_volume(&entry.id)
            .await
            .map_err(|_| "build_failed")?
            .as_ref()
            == Some(&staged)
        {
            // A full failed target may fail its shutdown checkpoint. Only this journal-owned
            // target may be killed; the source-generation guard above remains authoritative.
            let ended = super::remove::end_unit(&*self.machine, &entry.id).await;
            self.admission.stopped(&entry.id);
            self.table.remove(&entry.id);
            ended.map_err(|_| "build_failed")?;
        }
        // The source is proven asleep, and the per-database flow prevents new jobs. Jobs left
        // by the interrupted target may still hold its volume in their own mount namespaces.
        use crate::archive::job::Kind;
        for kind in [
            Kind::Restore,
            Kind::BaseBackup,
            Kind::WalFetch,
            Kind::WalArchive,
            Kind::BackupList,
        ] {
            self.jobs
                .stop_earlier(&entry.id, kind)
                .await
                .map_err(|_| "build_failed")?;
        }
        if self
            .machine
            .has_volume(&staged)
            .await
            .map_err(|_| "build_failed")?
        {
            self.machine
                .unmount_volume(&staged)
                .await
                .map_err(|_| "build_failed")?;
            self.machine
                .remove_volume(
                    &staged,
                    crate::storage::Removal::Superseded {
                        storage_generation: generation,
                        remove_volume: true,
                    },
                )
                .await
                .map_err(|_| "build_failed")?;
        }
        let files = self.files(&entry.id);
        files
            .forget_generation(generation)
            .map_err(|_| "build_failed")?;
        journal.retiring_generation = None;
        files.save_replacement(journal).map_err(|_| "build_failed")
    }

    pub(super) fn fail_replacement(&self, entry: &Entry) -> Result<(), &'static str> {
        let files = self.files(&entry.id);
        if let Some(mut journal) = files.load_replacement().map_err(|_| "build_failed")? {
            if journal.attempt.generation != entry.storage_generation
                || journal.attempt.operation != entry.operation
            {
                return Err("build_failed");
            }
            journal.attempt.failed = !journal.attempt.rollback;
            files
                .save_replacement(&journal)
                .map_err(|_| "build_failed")?;
        }
        Ok(())
    }

    /// Explicit even when a failed local journal write left no record. An R2 outage must never
    /// turn rollback into an abandoned ordinary move.
    pub(super) fn replacement_rollback(&self, entry: &Entry) -> bool {
        matches!(entry.origin, Some(Origin::ReplaceRollback(..)))
    }

    pub(super) fn replacement_cleanup_ready(&self, database: &str, through: u64) -> bool {
        let files = self.files(database);
        let journal = match files.load_replacement() {
            Ok(None) => return true,
            Ok(Some(journal)) => journal,
            Err(_) => return false,
        };
        if through < journal.source.storage_generation {
            return true;
        }
        files.load().ok().flatten().is_some_and(|state| {
            state.built
                && state.backup.is_some()
                && state.storage_generation == journal.attempt.generation
                && state.storage_generation > through
                && !journal.attempt.failed
                && journal.retiring_generation.is_none()
        })
    }

    pub(super) async fn finish_replacement_cleanup(
        &self,
        database: &str,
        through: u64,
    ) -> Result<(), &'static str> {
        let files = self.files(database);
        if let Some(journal) = files.load_replacement().map_err(|_| "volume_not_removed")? {
            if through < journal.source.storage_generation {
                return Ok(());
            }
            let source = VolumeId::new(database, journal.source.storage_generation)
                .map_err(|_| "volume_not_removed")?;
            if self
                .machine
                .has_volume(&source)
                .await
                .map_err(|_| "volume_not_removed")?
            {
                return Err("volume_not_removed");
            }
            files
                .forget_generation(journal.source.storage_generation)
                .map_err(|_| "volume_not_removed")?;
            if through >= journal.target_generation
                && journal.target_generation < journal.attempt.generation
            {
                files
                    .forget_generation(journal.target_generation)
                    .map_err(|_| "volume_not_removed")?;
            }
            files
                .remove_replacement()
                .map_err(|_| "volume_not_removed")?;
        }
        Ok(())
    }
}
