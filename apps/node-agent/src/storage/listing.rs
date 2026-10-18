// SPDX-License-Identifier: Apache-2.0
//! The volume list lvm2 reported last, kept so that a wake can ask its two questions of a volume
//! (does it exist, must it be repaired) without running `lvs`, which reads every volume. The list
//! answers only while it is young and while no lvm2 command that may change a volume or a tag has
//! ended since it was read; whatever else is asked is read from lvm2 again.
use super::lvm::LogicalVolume;
use std::{
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

#[derive(Default)]
struct Kept {
    /// Counts the lvm2 commands that ended and may have changed a volume or a tag.
    changes: u64,
    last: Option<(Instant, Arc<Vec<LogicalVolume>>)>,
}

pub struct Listing {
    max_age: Duration,
    kept: Mutex<Kept>,
}

/// What was true when a read of the list began.
#[derive(Clone, Copy)]
pub struct Read {
    began: Instant,
    changes: u64,
}

impl Listing {
    pub fn new(max_age: Duration) -> Self {
        Self {
            max_age,
            kept: Mutex::default(),
        }
    }
    fn kept(&self) -> std::sync::MutexGuard<'_, Kept> {
        // Nothing here is left half-updated by a panic.
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Call before reading the list from lvm2.
    pub fn begin(&self) -> Read {
        Read {
            began: Instant::now(),
            changes: self.kept().changes,
        }
    }
    /// Keeps what a read returned, unless a command that may change a volume ended while it ran:
    /// the list may not show that change. Its age counts from when it began.
    pub fn keep(&self, read: Read, lvs: &Arc<Vec<LogicalVolume>>) {
        let mut kept = self.kept();
        if kept.changes == read.changes {
            kept.last = Some((read.began, lvs.clone()));
        }
    }
    /// Call when a command that may change a volume or a tag has ended, whatever it answered.
    pub fn changed(&self) {
        let mut kept = self.kept();
        kept.changes += 1;
        kept.last = None;
    }
    /// The list, if it is younger than the bound and nothing has changed since it was read.
    pub fn recent(&self) -> Option<Arc<Vec<LogicalVolume>>> {
        let kept = self.kept();
        let (began, lvs) = kept.last.as_ref()?;
        (began.elapsed() < self.max_age).then(|| lvs.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(names: &[&str]) -> Arc<Vec<LogicalVolume>> {
        Arc::new(
            names
                .iter()
                .map(|name| LogicalVolume {
                    name: name.to_string(),
                    size_bytes: 1 << 30,
                    attr: "Vwi-a-tz--".into(),
                    pool: "pgcf_thinpool".into(),
                    chunk_bytes: 0,
                    metadata_bytes: 0,
                    when_full: String::new(),
                    zero: "zero".into(),
                    tags: vec![],
                })
                .collect(),
        )
    }

    #[test]
    fn a_list_answers_while_it_is_young_and_nothing_changed() {
        let listing = Listing::new(Duration::from_secs(20));
        assert!(listing.recent().is_none());
        let kept = list(&["db_a"]);
        listing.keep(listing.begin(), &kept);
        assert!(Arc::ptr_eq(&listing.recent().unwrap(), &kept));
        // A newer read replaces it.
        let newer = list(&["db_a", "db_b"]);
        listing.keep(listing.begin(), &newer);
        assert!(Arc::ptr_eq(&listing.recent().unwrap(), &newer));
    }

    #[test]
    fn a_list_at_its_bound_is_read_again() {
        let listing = Listing::new(Duration::ZERO);
        listing.keep(listing.begin(), &list(&["db_a"]));
        assert!(listing.recent().is_none());
    }

    #[test]
    fn a_command_that_changed_a_volume_drops_the_list() {
        let listing = Listing::new(Duration::from_secs(20));
        listing.keep(listing.begin(), &list(&["db_a"]));
        listing.changed();
        assert!(listing.recent().is_none());
    }

    /// The read began before the change and ended after it: it may show the volumes as they were.
    #[test]
    fn a_read_that_a_change_overtook_is_not_kept() {
        let listing = Listing::new(Duration::from_secs(20));
        let read = listing.begin();
        listing.changed();
        listing.keep(read, &list(&["db_a"]));
        assert!(listing.recent().is_none());
        // A read that began after the change is kept.
        listing.keep(listing.begin(), &list(&["db_b"]));
        assert!(listing.recent().is_some());
    }

    /// Its age counts from the start of the read, not from its end.
    #[test]
    fn a_list_is_as_old_as_the_start_of_its_read() {
        let listing = Listing::new(Duration::from_millis(50));
        let read = listing.begin();
        std::thread::sleep(Duration::from_millis(60));
        listing.keep(read, &list(&["db_a"]));
        assert!(listing.recent().is_none());
    }
}
