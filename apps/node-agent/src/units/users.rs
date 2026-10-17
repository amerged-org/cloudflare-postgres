// SPDX-License-Identifier: Apache-2.0
//! The Linux user of each database (plan 5.4, 5.5, Appendix C): a fixed uid per database from a
//! node-local range, never systemd's dynamic range (61184-65519), which recycles uids.
//!
//! The uid a database prefers is a function of its ID alone. The agent persists what it handed
//! out, so a preferred uid that another database holds moves a later database to the next free
//! one, and a database keeps its uid for as long as it exists. The agent releases the uid only
//! when the database is gone from the node, volume included (plan 5.10), so no file of a former
//! owner outlives the uid's reuse.
use pgcf_native_protocol::valid_pattern;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
};

/// The first uid of the agent's range: above the 65536 of 16-bit uids and Debian's `subuid`
/// start, below systemd's container range at 524288.
pub const FIRST_UID: u32 = 200_000;
/// The number of uids in the range.
pub const UID_COUNT: u32 = 100_000;
const STATE_VERSION: u8 = 1;

// The range stays clear of what systemd reserves: the 16-bit uids with nobody (65534), its dynamic
// users (61184-65519) and its container uids from 524288.
const _: () = {
    const DYNAMIC_FIRST: u32 = 61_184;
    const DYNAMIC_LAST: u32 = 65_519;
    let last = FIRST_UID + UID_COUNT - 1;
    assert!(FIRST_UID > 65_535);
    assert!(last < 524_288);
    assert!(last < DYNAMIC_FIRST || FIRST_UID > DYNAMIC_LAST);
};

/// The Linux user name of a database.
pub fn account_name(database: &str) -> String {
    format!("pgcf-{database}")
}

/// The uid `database` prefers: its ID's SHA-256 modulo the range. A change of this function would
/// move databases, so a test pins a vector.
pub fn preferred_uid(database: &str) -> u32 {
    let digest = Sha256::digest(database.as_bytes());
    let mut head = [0u8; 8];
    head.copy_from_slice(&digest[..8]);
    // The remainder is below UID_COUNT, which fits in a u32.
    FIRST_UID + (u64::from_be_bytes(head) % u64::from(UID_COUNT)) as u32
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u8,
    uids: BTreeMap<String, u32>,
}

/// The uids handed out on this node, persisted in one file that is replaced atomically.
pub struct Users {
    path: PathBuf,
    uids: BTreeMap<String, u32>,
}
impl Users {
    /// Reads the file at `path`; a missing file is an empty table. A file that cannot be trusted is
    /// an error and never an empty table: the agent would hand out uids that are in use.
    pub fn load(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(Self {
                    path,
                    uids: BTreeMap::new(),
                });
            }
            Err(error) => return Err(error),
        };
        let state: State = serde_json::from_str(&text).map_err(|e| invalid(e.to_string()))?;
        if state.version != STATE_VERSION {
            return Err(invalid("unknown uid table version"));
        }
        let mut held = HashSet::new();
        for (database, uid) in &state.uids {
            if !valid_pattern("database", database) {
                return Err(invalid("a uid is held by no database ID"));
            }
            if !(FIRST_UID..FIRST_UID + UID_COUNT).contains(uid) {
                return Err(invalid("a uid is outside the agent's range"));
            }
            if !held.insert(*uid) {
                return Err(invalid("a uid is held by two databases"));
            }
        }
        Ok(Self {
            path,
            uids: state.uids,
        })
    }

    /// Replaces the file with `uids`: written and synced beside it, renamed over it, and the
    /// directory synced, so a crash leaves the old table or the new one.
    fn persist(&self, uids: &BTreeMap<String, u32>) -> io::Result<()> {
        let text = serde_json::to_vec(&State {
            version: STATE_VERSION,
            uids: uids.clone(),
        })
        .map_err(|e| invalid(e.to_string()))?;
        let temporary = self.path.with_extension("tmp");
        match fs::remove_file(&temporary) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&text)?;
        file.sync_all()?;
        fs::rename(&temporary, &self.path)?;
        match self.path.parent() {
            Some(directory) if !directory.as_os_str().is_empty() => {
                File::open(directory)?.sync_all()
            }
            _ => File::open(".")?.sync_all(),
        }
    }
    /// The uid of `database`, if it has one.
    pub fn get(&self, database: &str) -> Option<u32> {
        self.uids.get(database).copied()
    }
    /// The uid of `database`: the one it holds, or a new one, persisted before it is returned.
    pub fn allocate(&mut self, database: &str) -> io::Result<u32> {
        if !valid_pattern("database", database) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "not a database ID",
            ));
        }
        if let Some(uid) = self.get(database) {
            return Ok(uid);
        }
        let held: HashSet<u32> = self.uids.values().copied().collect();
        let mut uid = preferred_uid(database);
        for _ in 0..UID_COUNT {
            if !held.contains(&uid) {
                let mut next = self.uids.clone();
                next.insert(database.to_string(), uid);
                self.persist(&next)?;
                self.uids = next;
                return Ok(uid);
            }
            uid = FIRST_UID + (uid - FIRST_UID + 1) % UID_COUNT;
        }
        Err(io::Error::new(
            io::ErrorKind::StorageFull,
            "every uid of the agent's range is in use",
        ))
    }
    /// Gives `database`'s uid back, persisted before it returns. A database without one is fine.
    pub fn release(&mut self, database: &str) -> io::Result<()> {
        if !self.uids.contains_key(database) {
            return Ok(());
        }
        let mut next = self.uids.clone();
        next.remove(database);
        self.persist(&next)?;
        self.uids = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const DYNAMIC_RANGE: std::ops::RangeInclusive<u32> = 61_184..=65_519;

    fn id(n: u64) -> String {
        format!("d{n:019}")
    }

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let path = crate::units::test_dir("users");
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join("uids.json")
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Two IDs that prefer the same uid, found by search: the range has 100,000 uids.
    fn colliding_pair() -> (String, String) {
        let mut seen = BTreeMap::new();
        for n in 0.. {
            let database = id(n);
            if let Some(first) = seen.insert(preferred_uid(&database), database.clone()) {
                return (first, database);
            }
        }
        unreachable!()
    }

    #[test]
    fn the_preferred_uid_is_a_pure_function_of_the_id_and_stays_in_range() {
        // Pinned: a release that changed the function would move every database on its node.
        assert_eq!(preferred_uid("aaaaaaaaaaaaaaaaaaaa"), 258_282);
        assert_eq!(preferred_uid("aaaaaaaaaaaaaaaaaaaa"), 258_282);
        assert_eq!(preferred_uid("zzzzzzzzzzzzzzzzzzzz"), 270_600);
        let mut distinct = HashSet::new();
        for n in 0..20_000 {
            let uid = preferred_uid(&id(n));
            assert!((FIRST_UID..FIRST_UID + UID_COUNT).contains(&uid), "{uid}");
            assert!(!DYNAMIC_RANGE.contains(&uid));
            distinct.insert(uid);
        }
        // 20,000 draws from 100,000 uids collide about 2,000 times; a bad hash collides far more.
        assert!(distinct.len() > 17_000, "{}", distinct.len());
    }

    #[test]
    fn the_account_is_named_after_the_database() {
        assert_eq!(
            account_name("abcdefghij0123456789"),
            "pgcf-abcdefghij0123456789"
        );
    }

    #[test]
    fn a_new_database_gets_its_preferred_uid_and_keeps_it() {
        let dir = Dir::new();
        let mut users = Users::load(dir.file()).unwrap();
        let database = id(1);
        assert_eq!(users.get(&database), None);
        let uid = users.allocate(&database).unwrap();
        assert_eq!(uid, preferred_uid(&database));
        assert_eq!(users.allocate(&database).unwrap(), uid);
        assert_eq!(users.get(&database), Some(uid));
    }

    #[test]
    fn a_collision_moves_the_later_database_to_the_next_free_uid() {
        let dir = Dir::new();
        let mut users = Users::load(dir.file()).unwrap();
        let (first, second) = colliding_pair();
        let preferred = preferred_uid(&first);
        assert_eq!(users.allocate(&first).unwrap(), preferred);
        assert_eq!(users.allocate(&second).unwrap(), preferred + 1);
        // The next free uid may be taken as well.
        let third = (0u64..)
            .map(id)
            .find(|candidate| preferred_uid(candidate) == preferred + 1)
            .unwrap();
        assert_eq!(users.allocate(&third).unwrap(), preferred + 2);
    }

    #[test]
    fn the_search_wraps_at_the_end_of_the_range() {
        let dir = Dir::new();
        let mut users = Users::load(dir.file()).unwrap();
        let last = FIRST_UID + UID_COUNT - 1;
        let first_at_end = (0u64..).map(id).find(|d| preferred_uid(d) == last).unwrap();
        let second_at_end = (0u64..)
            .map(id)
            .find(|d| preferred_uid(d) == last && *d != first_at_end)
            .unwrap();
        assert_eq!(users.allocate(&first_at_end).unwrap(), last);
        assert_eq!(users.allocate(&second_at_end).unwrap(), FIRST_UID);
    }

    #[test]
    fn a_released_uid_is_free_again_and_a_full_range_is_an_error() {
        let dir = Dir::new();
        let mut users = Users::load(dir.file()).unwrap();
        let (first, second) = colliding_pair();
        let uid = users.allocate(&first).unwrap();
        users.release(&first).unwrap();
        assert_eq!(users.get(&first), None);
        assert_eq!(users.allocate(&second).unwrap(), uid);
        users.release("neverallocated0000000").unwrap();
        // Fill the range: every uid is in use and the next database finds none.
        let mut full = Users::load(dir.0.join("full.json")).unwrap();
        full.uids = (0..UID_COUNT)
            .map(|n| (id(u64::from(n)), FIRST_UID + n))
            .collect();
        let error = full.allocate(&id(u64::from(UID_COUNT))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::StorageFull);
    }

    #[test]
    fn what_was_allocated_survives_a_restart_and_the_file_is_private() {
        let dir = Dir::new();
        let (first, second) = colliding_pair();
        let (uid_first, uid_second) = {
            let mut users = Users::load(dir.file()).unwrap();
            (
                users.allocate(&first).unwrap(),
                users.allocate(&second).unwrap(),
            )
        };
        let mut users = Users::load(dir.file()).unwrap();
        assert_eq!(users.get(&first), Some(uid_first));
        assert_eq!(users.get(&second), Some(uid_second));
        // The restarted table still knows the first database holds the preferred uid.
        let third = (0u64..)
            .map(id)
            .find(|d| preferred_uid(d) == uid_second && *d != second)
            .unwrap();
        assert_ne!(users.allocate(&third).unwrap(), uid_second);
        let mode = fs::metadata(dir.file()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let leftovers: Vec<_> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(leftovers, ["uids.json"], "no temporary file stays");
        users.release(&first).unwrap();
        assert_eq!(Users::load(dir.file()).unwrap().get(&first), None);
    }

    #[test]
    fn a_file_that_cannot_be_trusted_is_an_error_never_an_empty_table() {
        let dir = Dir::new();
        let write = |text: &str| fs::write(dir.file(), text).unwrap();
        let bad = |text: &str| {
            write(text);
            Users::load(dir.file()).err().map(|e| e.kind())
        };
        let invalid = Some(io::ErrorKind::InvalidData);
        assert_eq!(bad("not json"), invalid);
        assert_eq!(bad(""), invalid);
        assert_eq!(bad(r#"{"version":2,"uids":{}}"#), invalid);
        assert_eq!(bad(r#"{"version":1,"uids":{},"extra":1}"#), invalid);
        assert_eq!(
            bad(r#"{"version":1,"uids":{"NOT-AN-ID":200001}}"#),
            invalid,
            "an ID that is no database ID"
        );
        assert_eq!(
            bad(r#"{"version":1,"uids":{"aaaaaaaaaaaaaaaaaaaa":61200}}"#),
            invalid,
            "a uid outside the range"
        );
        assert_eq!(
            bad(
                r#"{"version":1,"uids":{"aaaaaaaaaaaaaaaaaaaa":200001,"bbbbbbbbbbbbbbbbbbbb":200001}}"#
            ),
            invalid,
            "one uid for two databases"
        );
        write(r#"{"version":1,"uids":{"aaaaaaaaaaaaaaaaaaaa":200001}}"#);
        assert_eq!(
            Users::load(dir.file()).unwrap().get("aaaaaaaaaaaaaaaaaaaa"),
            Some(200_001)
        );
    }

    #[test]
    fn a_database_that_is_no_database_id_gets_no_uid() {
        let dir = Dir::new();
        let mut users = Users::load(dir.file()).unwrap();
        for bad in ["", "root", "../etc", "ABCDEFGHIJ0123456789", "abc"] {
            assert_eq!(
                users.allocate(bad).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{bad}"
            );
        }
        assert!(!dir.file().exists());
    }
}
