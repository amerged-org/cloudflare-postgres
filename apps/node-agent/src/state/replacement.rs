// SPDX-License-Identifier: Apache-2.0
//! The local recovery record of one in-place restore. It precedes replacing `state.json`, and
//! outlives a failed target and every agent restart. Only an explicit cleanup of the retained
//! source, after a newer generation has its first DONE backup, removes it.
use super::{
    DatabaseState, Files, STATE_FILE, create_private_directory, sync_directory, write_private,
};
use crate::{node_link::archive_path, roles::timestamp};
use serde::{Deserialize, Serialize};
use std::io;

const FILE: &str = "replacement.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Attempt {
    pub generation: u64,
    pub operation: String,
    pub archive_path: String,
    pub rollback: bool,
    /// Durable: a failed generation cannot begin again after the API has seen its failure.
    pub failed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Replacement {
    pub operation: String,
    pub target_generation: u64,
    pub source_path: String,
    pub backup_id: String,
    /// Absent only when rollback recreates a journal whose initial write failed.
    pub target_time: Option<String>,
    /// The original built generation and its exact proven sleep, never replaced by a rollback.
    pub source: DatabaseState,
    /// The highest generation begun by this operation. A rollback always moves this forward.
    pub attempt: Attempt,
    /// A journal-owned, unpublished target to remove before allocating the forward rollback.
    #[serde(default)]
    pub retiring_generation: Option<u64>,
}

fn operation(id: &str) -> bool {
    id.len() == 23
        && id.starts_with("op_")
        && id[3..]
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}
impl Replacement {
    fn valid(&self) -> bool {
        let Some(source) = archive_path(&self.source_path) else {
            return false;
        };
        let Some(target) = archive_path(&self.attempt.archive_path) else {
            return false;
        };
        self.source.valid()
            && self.source.built
            && self.source.record.is_some()
            && self.source.backup.is_some()
            && source.generation == self.source.storage_generation
            && target.database == source.database
            && target.region == source.region
            && target.generation == self.attempt.generation
            && target.operation == self.attempt.operation
            && self.target_generation > self.source.storage_generation
            && self.attempt.generation >= self.target_generation
            && self.attempt.generation <= 9_007_199_254_740_991
            && self.retiring_generation.is_none_or(|generation| {
                self.attempt.rollback
                    && generation >= self.target_generation
                    && generation > self.source.storage_generation
                    && generation < self.attempt.generation
            })
            && operation(&self.operation)
            && operation(&self.attempt.operation)
            && if self.attempt.rollback {
                self.attempt.generation > self.target_generation
            } else {
                self.attempt.generation == self.target_generation
                    && self.attempt.operation == self.operation
                    && self.target_time.is_some()
            }
            && self.backup_id.len() == 15
            && self.backup_id.bytes().enumerate().all(|(i, b)| {
                if i == 8 {
                    b == b'T'
                } else {
                    b.is_ascii_digit()
                }
            })
            && self.target_time.as_deref().is_none_or(timestamp)
    }
}

impl Files {
    pub(crate) fn load_replacement(&self) -> io::Result<Option<Replacement>> {
        let bytes = match std::fs::read(self.directory.join(FILE)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let journal: Replacement = serde_json::from_slice(&bytes).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid replacement journal")
        })?;
        if !journal.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid replacement journal",
            ));
        }
        Ok(Some(journal))
    }

    pub(crate) fn save_replacement(&self, journal: &Replacement) -> io::Result<()> {
        if !journal.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid replacement journal",
            ));
        }
        create_private_directory(&self.directory)?;
        write_private(&self.directory.join(FILE), &serde_json::to_vec(journal)?)
    }

    /// Discards only a failed generation's state and upload log. In particular, neither the
    /// retained source's uploads nor its replacement journal are collateral of a failed build.
    pub(crate) fn forget_generation(&self, generation: u64) -> io::Result<()> {
        if self
            .load()?
            .is_some_and(|state| state.storage_generation == generation)
        {
            std::fs::remove_file(self.directory.join(STATE_FILE))?;
        }
        match std::fs::remove_file(self.upload_log(generation).path()) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        if self.directory.exists() {
            sync_directory(&self.directory)?;
        }
        Ok(())
    }

    pub(crate) fn remove_replacement(&self) -> io::Result<()> {
        match std::fs::remove_file(self.directory.join(FILE)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        sync_directory(&self.directory)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{Backup, ProvenSleepRecord};

    fn journal() -> Replacement {
        let mut source = DatabaseState::new(1);
        source.built = true;
        source.record = Some(ProvenSleepRecord {
            system_identifier: "7431215993172011234".into(),
            timeline: 1,
            checkpoint_lsn: "0/1A2B3C48".into(),
            last_archived_segment: "000000010000000000000003".into(),
            proven_at: "2026-10-18T10:11:12.345Z".into(),
        });
        source.backup = Some(Backup {
            backup_id: "20261017T225342".into(),
            timeline: 1,
            completed_at: "2026-10-17T22:53:45.000Z".into(),
        });
        Replacement {
            operation: "op_bbbbbbbbbbbbbbbbbbbb".into(),
            target_generation: 2,
            source_path: "s3://pgcf-eu/eu-dev/dbbbbbbbbbbbbbbbbbbb/g1-op_aaaaaaaaaaaaaaaaaaaa"
                .into(),
            backup_id: "20261017T225342".into(),
            target_time: Some("2026-10-17T23:00:00.000Z".into()),
            source,
            attempt: Attempt {
                generation: 2,
                operation: "op_bbbbbbbbbbbbbbbbbbbb".into(),
                archive_path: "s3://pgcf-eu/eu-dev/dbbbbbbbbbbbbbbbbbbb/g2-op_bbbbbbbbbbbbbbbbbbbb"
                    .into(),
                rollback: false,
                failed: false,
            },
            retiring_generation: None,
        }
    }

    #[test]
    fn a_failed_target_discards_only_its_own_state_and_keeps_the_source_journal_and_uploads() {
        let files = Files::new(crate::testpg::directory("replacement-state"));
        let original = journal();
        files.save(&original.source).unwrap();
        files.save_replacement(&original).unwrap();
        std::fs::write(files.upload_log(1).path(), b"source uploads").unwrap();
        files.save(&DatabaseState::new(2)).unwrap();
        std::fs::write(files.upload_log(2).path(), b"failed uploads").unwrap();
        files.forget_generation(2).unwrap();
        let reopened = Files::new(files.directory());
        assert_eq!(reopened.load().unwrap(), None);
        assert_eq!(reopened.load_replacement().unwrap(), Some(original));
        assert_eq!(
            std::fs::read(files.upload_log(1).path()).unwrap(),
            b"source uploads"
        );
        assert!(!files.upload_log(2).path().exists());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(files.directory.join(FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        files.remove().unwrap();
    }

    #[test]
    fn a_corrupt_journal_or_a_rollback_that_lowers_generation_is_never_an_absent_journal() {
        let files = Files::new(crate::testpg::directory("replacement-invalid"));
        let mut record = journal();
        files.save_replacement(&record).unwrap();
        record.attempt.rollback = true;
        assert!(files.save_replacement(&record).is_err());
        std::fs::write(files.directory.join(FILE), b"{incomplete").unwrap();
        assert_eq!(
            files.load_replacement().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        files.remove().unwrap();
    }
}
