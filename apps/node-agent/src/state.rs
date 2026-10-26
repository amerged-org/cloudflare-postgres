// SPDX-License-Identifier: Apache-2.0
//! What the agent keeps of each database on the node's own disk, where the database's user cannot
//! reach it (plan 7.9 step 9, 7.10): the proven-sleep record, the roles applied, the newest base
//! backup and whether the storage generation was built. One file per database, replaced whole.
use crate::{
    archive::upload_log::UploadLog,
    link::file::{create_private_directory, sync_directory, write_private},
    pg_control::Lsn,
    roles::timestamp,
    sleep::is_segment,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
};

pub(crate) mod replacement;

const VERSION: u8 = 1;
const STATE_FILE: &str = "state.json";

/// The record of a proven sleep (`ProvenSleepRecord` of the node contract): a database is cold and
/// safe only with a record that its `pg_control` matches.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProvenSleepRecord {
    pub system_identifier: String,
    pub timeline: u32,
    pub checkpoint_lsn: String,
    /// The segment the switch closed, which holds every record written before the stop.
    pub last_archived_segment: String,
    pub proven_at: String,
}
impl ProvenSleepRecord {
    pub fn valid(&self) -> bool {
        let identifier = &self.system_identifier;
        (1..=20).contains(&identifier.len())
            && !identifier.starts_with('0')
            && identifier.bytes().all(|b| b.is_ascii_digit())
            && identifier.parse::<u64>().is_ok()
            && self.timeline >= 1
            && Lsn::parse(&self.checkpoint_lsn).is_some()
            && is_segment(&self.last_archived_segment)
            && timestamp(&self.proven_at)
    }
    /// `NodeDatabaseObservation.proven_sleep`.
    pub fn observation(&self) -> Value {
        serde_json::to_value(self).expect("a record serializes")
    }
}

/// The size the node last set a database to: its unit's limits and its volume.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ResourceFields", into = "ResourceFields")]
pub struct Resources {
    pub memory_mib: u64,
    pub cpu_millicores: u32,
    pub storage_mib: u64,
}

/// Read existing state and desired resources without rounding their nominal volume size. The
/// strict alternatives reject ambiguous fields (including nulls), rather than picking a unit.
#[derive(Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum ResourceFields {
    Gib {
        memory_mib: u64,
        cpu_millicores: u32,
        storage_gib: u64,
    },
    Mib {
        memory_mib: u64,
        cpu_millicores: u32,
        storage_mib: u64,
    },
}

impl Resources {
    fn valid(&self) -> bool {
        (4..=67_108_864).contains(&self.storage_mib) && self.storage_mib.is_multiple_of(4)
    }
}

impl TryFrom<ResourceFields> for Resources {
    type Error = &'static str;

    fn try_from(fields: ResourceFields) -> Result<Self, Self::Error> {
        let resources = match fields {
            ResourceFields::Gib {
                memory_mib,
                cpu_millicores,
                storage_gib,
            } => Self {
                memory_mib,
                cpu_millicores,
                storage_mib: storage_gib.checked_mul(1024).ok_or("storage overflow")?,
            },
            ResourceFields::Mib {
                memory_mib,
                cpu_millicores,
                storage_mib,
            } => Self {
                memory_mib,
                cpu_millicores,
                storage_mib,
            },
        };
        resources
            .valid()
            .then_some(resources)
            .ok_or("storage must be a positive 4 MiB multiple at most 64 TiB")
    }
}

impl From<Resources> for ResourceFields {
    fn from(resources: Resources) -> Self {
        let Resources {
            memory_mib,
            cpu_millicores,
            storage_mib,
        } = resources;
        // Keep existing whole-GiB state readable by older agents. A genuinely sub-GiB size is
        // deliberately unreadable to one that cannot represent it.
        if storage_mib.is_multiple_of(1024) {
            Self::Gib {
                memory_mib,
                cpu_millicores,
                storage_gib: storage_mib / 1024,
            }
        } else {
            Self::Mib {
                memory_mib,
                cpu_millicores,
                storage_mib,
            }
        }
    }
}

/// The newest DONE base backup of the storage generation (`NodeDatabaseObservation.backup`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Backup {
    pub backup_id: String,
    pub timeline: u32,
    pub completed_at: String,
}
impl Backup {
    fn valid(&self) -> bool {
        self.backup_id.len() == 15
            && self.backup_id.bytes().enumerate().all(|(i, b)| match i {
                8 => b == b'T',
                _ => b.is_ascii_digit(),
            })
            && self.timeline >= 1
            && timestamp(&self.completed_at)
    }
    pub fn observation(&self) -> Value {
        json!({"backup_id": self.backup_id, "timeline": self.timeline, "completed_at": self.completed_at})
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseState {
    v: u8,
    pub storage_generation: u64,
    /// The generation was built, its first base backup is DONE: a missing volume is an error from
    /// here on and never a fresh build (`DatabaseOrigin`).
    pub built: bool,
    /// The revision of every role PostgreSQL holds as the page stated it.
    pub roles: BTreeMap<String, u64>,
    pub record: Option<ProvenSleepRecord>,
    pub backup: Option<Backup>,
    /// The SHA-256 of the configuration files the agent last wrote, so that it writes them again
    /// only when the database's size or settings changed.
    #[serde(default)]
    pub config: Option<String>,
    /// What the unit's limits and the volume were last set to.
    #[serde(default)]
    pub resources: Option<Resources>,
}
impl DatabaseState {
    pub fn new(storage_generation: u64) -> Self {
        Self {
            v: VERSION,
            storage_generation,
            built: false,
            roles: BTreeMap::new(),
            record: None,
            backup: None,
            config: None,
            resources: None,
        }
    }
    fn valid(&self) -> bool {
        self.v == VERSION
            && (1..=9_007_199_254_740_991).contains(&self.storage_generation)
            && self.record.as_ref().is_none_or(ProvenSleepRecord::valid)
            && self.backup.as_ref().is_none_or(Backup::valid)
            && self.resources.as_ref().is_none_or(Resources::valid)
            && self.config.as_ref().is_none_or(|sha| {
                sha.len() == 64
                    && sha
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    }
}

/// One database's files on the node's disk.
#[derive(Clone, Debug)]
pub struct Files {
    directory: PathBuf,
}
impl Files {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    /// The state, or `None` for a database the node has no state of. A file that cannot be
    /// trusted is an error: the agent would take a database for a new one.
    pub fn load(&self) -> io::Result<Option<DatabaseState>> {
        let text = match std::fs::read_to_string(self.directory.join(STATE_FILE)) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_string());
        let state: DatabaseState =
            serde_json::from_str(&text).map_err(|error| invalid(&error.to_string()))?;
        if !state.valid() {
            return Err(invalid("a database state that breaks the contract"));
        }
        Ok(Some(state))
    }
    /// Replaces the state in one step that survives a crash.
    pub fn save(&self, state: &DatabaseState) -> io::Result<()> {
        debug_assert!(state.valid());
        create_private_directory(&self.directory)?;
        write_private(
            &self.directory.join(STATE_FILE),
            &serde_json::to_vec(state)?,
        )
    }
    /// The upload log of a storage generation, which the sleep proof reads.
    pub fn upload_log(&self, storage_generation: u64) -> UploadLog {
        UploadLog::new(
            self.directory
                .join(format!("uploads-g{storage_generation}.log")),
        )
    }
    /// Removes everything the node keeps of the database.
    pub fn remove(&self) -> io::Result<()> {
        match std::fs::remove_dir_all(&self.directory) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        match self.directory.parent() {
            Some(parent) if parent.exists() => sync_directory(parent),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::file::create_private_directory;

    fn directory(label: &str) -> std::path::PathBuf {
        crate::testpg::directory(label)
    }
    fn record() -> ProvenSleepRecord {
        ProvenSleepRecord {
            system_identifier: "7431215993172011234".into(),
            timeline: 1,
            checkpoint_lsn: "0/1A2B3C48".into(),
            last_archived_segment: "000000010000000000000003".into(),
            proven_at: "2026-10-18T10:11:12.345Z".into(),
        }
    }

    #[test]
    fn resources_read_both_storage_units_and_keep_whole_gib_state_compatible() {
        let legacy = json!({"memory_mib":256,"cpu_millicores":250,"storage_gib":2});
        let resources: Resources = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(resources.storage_mib, 2048);
        assert_eq!(serde_json::to_value(resources).unwrap(), legacy);

        let small = json!({"memory_mib":256,"cpu_millicores":250,"storage_mib":500});
        let resources: Resources = serde_json::from_value(small.clone()).unwrap();
        assert_eq!(resources.storage_mib, 500);
        assert_eq!(serde_json::to_value(resources).unwrap(), small);

        let whole = json!({"memory_mib":256,"cpu_millicores":250,"storage_mib":2048});
        let resources: Resources = serde_json::from_value(whole).unwrap();
        assert_eq!(serde_json::to_value(resources).unwrap(), legacy);

        for (storage, expected) in [
            (json!({"storage_mib":4}), 4),
            (json!({"storage_mib":67_108_864}), 67_108_864),
            (json!({"storage_gib":65_536}), 67_108_864),
        ] {
            let mut value = json!({"memory_mib":256,"cpu_millicores":250});
            value
                .as_object_mut()
                .unwrap()
                .extend(storage.as_object().unwrap().clone());
            assert_eq!(
                serde_json::from_value::<Resources>(value)
                    .unwrap()
                    .storage_mib,
                expected
            );
        }
    }

    #[test]
    fn storage_resources_refuse_ambiguous_unaligned_and_out_of_range_sizes() {
        for storage in [
            json!({}),
            json!({"storage_gib":1,"storage_mib":1024}),
            json!({"storage_gib":null,"storage_mib":500}),
            json!({"storage_gib":1,"storage_mib":null}),
            json!({"storage_mib":null}),
            json!({"storage_mib":500.5}),
            json!({"storage_mib":502}),
            json!({"storage_mib":0}),
            json!({"storage_mib":67_108_868}),
            json!({"storage_gib":0}),
            json!({"storage_gib":65_537}),
            json!({"storage_gib":u64::MAX}),
            json!({"storage_mib":500,"unexpected":true}),
        ] {
            let mut value = json!({"memory_mib":256,"cpu_millicores":250});
            value
                .as_object_mut()
                .unwrap()
                .extend(storage.as_object().unwrap().clone());
            assert!(
                serde_json::from_value::<Resources>(value).is_err(),
                "{storage}"
            );
        }
    }

    #[test]
    fn a_proven_sleep_record_is_what_the_contract_states_and_nothing_else() {
        assert!(record().valid());
        let json = serde_json::to_value(record()).unwrap();
        assert_eq!(json["checkpoint_lsn"], "0/1A2B3C48");
        for (field, bad) in [
            ("system_identifier", "0123"),
            ("system_identifier", "12a"),
            ("system_identifier", "123456789012345678901"),
            ("checkpoint_lsn", "0/1a2b"),
            ("checkpoint_lsn", "0"),
            ("last_archived_segment", "00000001000000000000000"),
            ("last_archived_segment", "00000001000000000000000a"),
            ("proven_at", "2026-10-18 10:11:12"),
        ] {
            let mut wrong = record();
            match field {
                "system_identifier" => wrong.system_identifier = bad.into(),
                "checkpoint_lsn" => wrong.checkpoint_lsn = bad.into(),
                "last_archived_segment" => wrong.last_archived_segment = bad.into(),
                _ => wrong.proven_at = bad.into(),
            }
            assert!(!wrong.valid(), "{field} {bad}");
        }
        let mut zero = record();
        zero.timeline = 0;
        assert!(!zero.valid());
    }

    #[test]
    fn a_database_state_survives_a_restart_and_a_missing_file_is_no_state() {
        let base = directory("state");
        let files = Files::new(base.join("databases/abcdefghij0123456789"));
        assert_eq!(files.load().unwrap(), None);
        let mut state = DatabaseState::new(3);
        state.built = true;
        state.roles.insert("app".into(), 4);
        state.record = Some(record());
        state.config = Some("a".repeat(64));
        state.resources = Some(Resources {
            memory_mib: 256,
            cpu_millicores: 250,
            storage_mib: 500,
        });
        state.backup = Some(Backup {
            backup_id: "20261018T101112".into(),
            timeline: 1,
            completed_at: "2026-10-18T10:11:12.000Z".into(),
        });
        files.save(&state).unwrap();
        let reopened = Files::new(base.join("databases/abcdefghij0123456789"));
        assert_eq!(reopened.load().unwrap(), Some(state));
        // The directory and the file are the agent's alone.
        use std::os::unix::fs::PermissionsExt;
        let mode =
            |p: std::path::PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(files.directory().to_path_buf()), 0o700);
        assert_eq!(mode(files.directory().join("state.json")), 0o600);
        files.remove().unwrap();
        assert_eq!(files.load().unwrap(), None);
        // Removing what is gone is done.
        files.remove().unwrap();
    }

    #[test]
    fn a_state_that_cannot_be_trusted_is_an_error_and_never_an_empty_state() {
        let base = directory("state-bad");
        let files = Files::new(base.join("d"));
        create_private_directory(files.directory()).unwrap();
        for text in [
            "{",
            r#"{"v":2,"storage_generation":1,"built":true,"roles":{},"record":null,"backup":null}"#,
            r#"{"v":1,"storage_generation":0,"built":true,"roles":{},"record":null,"backup":null}"#,
            r#"{"v":1,"storage_generation":1,"built":true,"roles":{},"record":{"system_identifier":"x"},"backup":null}"#,
            r#"{"v":1,"storage_generation":1,"built":true,"roles":{},"record":null,"backup":null,"more":1}"#,
        ] {
            std::fs::write(files.directory().join("state.json"), text).unwrap();
            assert!(files.load().is_err(), "{text}");
        }
    }

    #[test]
    fn the_upload_log_of_a_generation_is_a_file_of_its_own() {
        let files = Files::new("/var/lib/pgcf/agent/databases/abcdefghij0123456789");
        assert_eq!(
            files.upload_log(3).path(),
            std::path::Path::new(
                "/var/lib/pgcf/agent/databases/abcdefghij0123456789/uploads-g3.log"
            )
        );
        assert_ne!(files.upload_log(3).path(), files.upload_log(4).path());
    }
}
