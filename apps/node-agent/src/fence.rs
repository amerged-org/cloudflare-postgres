// SPDX-License-Identifier: Apache-2.0
//! Fencing and superseded generations (plan 7.11, 9.4; `NodeOrder`). The orders that outlive their
//! result are kept on the node's disk and written, and fsynced, before the agent acts on them: it
//! never lifts one because it left the page or because its result was reported. A fence ends only
//! with a reinstall (a new install with a new key), and a superseded generation never ends.
use crate::link::file::{create_private_directory, write_private};
use pgcf_native_protocol::valid_pattern;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
};

const VERSION: u8 = 1;

/// A `superseded` order: this storage generation and every older one is never started or
/// archived again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Superseded {
    pub operation: String,
    pub storage_generation: u64,
    pub remove_volume: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    v: u8,
    /// The operation of the `fence` order.
    fence: Option<String>,
    superseded: BTreeMap<String, Vec<Superseded>>,
}
impl Stored {
    fn valid(&self) -> bool {
        let operation = |op: &str| valid_pattern("operation", op);
        self.v == VERSION
            && self.fence.as_deref().is_none_or(operation)
            && self.superseded.iter().all(|(database, orders)| {
                valid_pattern("database", database)
                    && orders.iter().all(|order| {
                        operation(&order.operation)
                            && (1..=9_007_199_254_740_991).contains(&order.storage_generation)
                    })
            })
    }
}

/// The orders of this node that do not end, on its disk.
pub struct Fences {
    path: PathBuf,
    stored: Mutex<Stored>,
}
impl Fences {
    /// Reads the file at `path`; a missing file is no order. A file that cannot be trusted is an
    /// error and never an empty set: the agent would start what it was told never to start.
    pub fn load(path: impl Into<PathBuf>) -> io::Result<Self> {
        let path = path.into();
        let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_string());
        let stored = match std::fs::read_to_string(&path) {
            Ok(text) => {
                let stored: Stored =
                    serde_json::from_str(&text).map_err(|error| invalid(&error.to_string()))?;
                if !stored.valid() {
                    return Err(invalid("fences that break the contract"));
                }
                stored
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Stored {
                v: VERSION,
                ..Stored::default()
            },
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            stored: Mutex::new(stored),
        })
    }
    fn stored(&self) -> MutexGuard<'_, Stored> {
        self.stored.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Writes `next` and, once it is on disk, keeps it.
    fn keep(&self, stored: &mut Stored, next: Stored) -> io::Result<()> {
        create_private_directory(self.path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        write_private(&self.path, &serde_json::to_vec(&next)?)?;
        *stored = next;
        Ok(())
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// The node was declared lost.
    pub fn fenced(&self) -> bool {
        self.stored().fence.is_some()
    }
    /// Fences the node: on disk before it returns. `true` when this order is news.
    pub fn fence(&self, operation: &str) -> io::Result<bool> {
        let mut stored = self.stored();
        if stored.fence.is_some() {
            return Ok(false);
        }
        let mut next = stored.clone();
        next.fence = Some(operation.to_string());
        self.keep(&mut stored, next)?;
        Ok(true)
    }
    /// Retires `storage_generation` of `database` and every older one: on disk before it returns.
    /// `true` when this order is news.
    pub fn supersede(
        &self,
        database: &str,
        storage_generation: u64,
        remove_volume: bool,
        operation: &str,
    ) -> io::Result<bool> {
        let mut stored = self.stored();
        let orders = stored.superseded.get(database);
        if orders.is_some_and(|orders| orders.iter().any(|order| order.operation == operation)) {
            return Ok(false);
        }
        let mut next = stored.clone();
        next.superseded
            .entry(database.to_string())
            .or_default()
            .push(Superseded {
                operation: operation.to_string(),
                storage_generation,
                remove_volume,
            });
        self.keep(&mut stored, next)?;
        Ok(true)
    }
    /// Whether the storage generation is retired: it is never started or archived again.
    pub fn blocks(&self, database: &str, storage_generation: u64) -> bool {
        self.stored()
            .superseded
            .get(database)
            .is_some_and(|orders| {
                orders
                    .iter()
                    .any(|order| order.storage_generation >= storage_generation)
            })
    }
    /// The order that lets the volume of a retired generation go, if there is one.
    pub fn removal(&self, database: &str, storage_generation: u64) -> Option<Superseded> {
        self.stored()
            .superseded
            .get(database)?
            .iter()
            .find(|order| order.remove_volume && order.storage_generation >= storage_generation)
            .cloned()
    }
    /// Whether an order lets the volume of this generation go.
    pub fn removable(&self, database: &str, storage_generation: u64) -> bool {
        self.removal(database, storage_generation).is_some()
    }
    /// The databases with a retired generation.
    pub fn databases(&self) -> Vec<String> {
        self.stored().superseded.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(label: &str) -> std::path::PathBuf {
        crate::testpg::directory(label).join("agent/fences.json")
    }

    #[test]
    fn a_node_is_fenced_once_and_stays_fenced_after_a_restart() {
        let path = path("fence");
        let fences = Fences::load(&path).unwrap();
        assert!(!fences.fenced());
        assert!(fences.fence("op_aaaaaaaaaaaaaaaaaaaa").unwrap());
        assert!(fences.fenced());
        // The same order again is not news.
        assert!(!fences.fence("op_aaaaaaaaaaaaaaaaaaaa").unwrap());
        assert!(Fences::load(&path).unwrap().fenced());
    }

    #[test]
    fn a_superseded_generation_and_every_older_one_is_never_served_again() {
        let path = path("superseded");
        let fences = Fences::load(&path).unwrap();
        let db = "abcdefghij0123456789";
        assert!(!fences.blocks(db, 1));
        assert!(
            fences
                .supersede(db, 2, false, "op_bbbbbbbbbbbbbbbbbbbb")
                .unwrap()
        );
        assert!(fences.blocks(db, 1) && fences.blocks(db, 2));
        assert!(
            !fences.blocks(db, 3),
            "the next generation is another storage"
        );
        assert!(
            !fences.blocks("zbcdefghij0123456789", 1),
            "another database"
        );
        // The volume goes only with `remove_volume`, and only the volumes the order covers.
        assert!(!fences.removable(db, 2));
        assert!(
            fences
                .supersede(db, 3, true, "op_cccccccccccccccccccc")
                .unwrap()
        );
        assert!(fences.removable(db, 3) && fences.removable(db, 1));
        assert!(!fences.removable(db, 4));
        // An order that was reported and left the page is still in force after a restart; a repeat
        // is not news.
        assert!(
            !fences
                .supersede(db, 3, true, "op_cccccccccccccccccccc")
                .unwrap()
        );
        let reopened = Fences::load(&path).unwrap();
        assert!(reopened.blocks(db, 3) && reopened.removable(db, 3));
        // A lower generation never lowers what is superseded.
        reopened
            .supersede(db, 1, false, "op_dddddddddddddddddddd")
            .unwrap();
        assert!(reopened.blocks(db, 3));
    }

    #[test]
    fn a_file_that_cannot_be_trusted_is_an_error_and_never_an_empty_set_of_fences() {
        let path = path("fences-bad");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for text in [
            "{",
            r#"{"v":2,"fence":null,"superseded":{}}"#,
            r#"{"v":1,"fence":"x","superseded":{}}"#,
            r#"{"v":1,"fence":null,"superseded":{"short":[]}}"#,
            r#"{"v":1,"fence":null,"superseded":{"abcdefghij0123456789":[{"operation":"op_aaaaaaaaaaaaaaaaaaaa","storage_generation":0,"remove_volume":false}]}}"#,
        ] {
            std::fs::write(&path, text).unwrap();
            assert!(Fences::load(&path).is_err(), "{text}");
        }
        std::fs::remove_file(&path).unwrap();
        assert!(!Fences::load(&path).unwrap().fenced());
    }
}
