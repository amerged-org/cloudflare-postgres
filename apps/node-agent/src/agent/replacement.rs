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
            if !matches_journal(entry, &journal) {
                return Err("build_failed");
            }
            self.release_staged_writer(entry, &journal).await?;
            if self.replacement_rollback(entry) {
                let next = attempt(entry, true);
                if journal.attempt != next {
                    journal.attempt = next;
                    files
                        .save_replacement(&journal)
                        .map_err(|_| "build_failed")?;
                }
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
        };
        files.save_replacement(&journal).map_err(|_| "build_failed")
    }

    /// A crash may interrupt failure cleanup with the target still running. Only a writer whose
    /// actual mounted generation is the journal's staged target may be stopped here. `stop_unit`
    /// waits for its slot/cgroup to be over; unmount then independently refuses remaining holders.
    async fn release_staged_writer(
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
            Some(held) if held.generation() == journal.attempt.generation => {
                if entry.storage_generation > held.generation() && !self.stop_unit(&entry.id).await
                {
                    return Err("build_failed");
                }
            }
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
