// SPDX-License-Identifier: Apache-2.0
//! What the agent reads ahead for a wake (plan 11.2, package F; `prefetch.rs` does the reading).
//!
//! A database that slept for hours has had its pages evicted, and its login and first statements
//! read them from the disk one random read at a time. The agent knows the files they read before
//! the request does, and asks the kernel to read them ahead. Two hooks, and a variant says which
//! of them a build runs (a constant of the build, not a policy of the node: what is measured
//! decides it, and the node's page does not carry it):
//!
//! - **The hot list from ready.** Once the wake has released the database, the blocks of
//!   `autoprewarm.blocks` are read ahead for at most `HOT_LIST_BUDGET`. It overlaps the first
//!   request and PostgreSQL's own autoprewarm, and nothing of the wake waits for it. Measured in
//!   the prefetch lab of 2026-10-20 (arm I): the statements took about 10 ms less at p50.
//! - **The catalogs at the bind.** The ~5 MB the login reads (the catalog set) are read ahead while
//!   the database's slot is bound, and stopped when the start ends. The lab's arm that helped (H,
//!   login 73 to 23 ms at p50) overlapped the executor's ~130 ms; at the bind the reads overlap
//!   PostgreSQL's own fsyncs, which arms E and G showed to be slower on the `none` scheduler. It
//!   is not run until an interleaved A/B on the pooled path (at least 18 wakes an arm, one hour
//!   asleep, `via=public`) shows that the wake does not grow by more than 10 ms at p50 and the
//!   login takes 35 ms or less at p50.
//!
//! Every reading says what it did in an event (`prefetch`): its set and hook, why it ended, and the
//! counts and times of `prefetch::Report`; a list that is not there or not readable says so
//! (`prefetch_unavailable`).
use super::Core;
use crate::{
    machine::Machine,
    prefetch::{self, Limits, Report},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// Which hooks run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefetch {
    /// Nothing is read ahead.
    Off,
    /// The hot list from ready.
    HotList,
    /// The catalogs at the bind, and the hot list from ready.
    CatalogsAndHotList,
}

/// The variant this build runs: the one measured to be safe. The catalogs at the bind wait for the
/// A/B above, and this is the line that the A/B changes.
pub const PREFETCH: Prefetch = Prefetch::HotList;

impl Prefetch {
    pub fn catalogs_at_bind(self) -> bool {
        self == Self::CatalogsAndHotList
    }
    pub fn hot_list_at_ready(self) -> bool {
        matches!(self, Self::HotList | Self::CatalogsAndHotList)
    }
}

/// How long the hot list may take to plan, and how long its pieces may be issued: the request it
/// overlaps is over in a few hundred milliseconds, and what is advised later helps the next.
const HOT_LIST_PLAN: Duration = Duration::from_millis(50);
pub const HOT_LIST_BUDGET: Duration = Duration::from_millis(150);
/// The catalogs are about 5 MB: their planning and issuing are bounded by the start itself.
const CATALOG_BUDGET: Duration = Duration::from_millis(100);
/// The bytes of the hot list advised at most. A list names the shared buffers, 25 % of the
/// database's memory at most, so this binds on no database.
const HOT_LIST_BYTES: u64 = 1 << 30;
const CATALOG_BYTES: u64 = 64 << 20;

/// Where in a wake a reading began.
#[derive(Clone, Copy, Debug)]
enum Hook {
    Bind,
    Ready,
}
impl Hook {
    fn name(self) -> &'static str {
        match self {
            Self::Bind => "bind",
            Self::Ready => "ready",
        }
    }
}

/// The log line of a reading: numbers and short words only.
fn line(database: &str, set: &str, hook: Hook, report: &Report) -> Value {
    let mut line = json!({
        "event": "prefetch", "database_id": database, "set": set, "hook": hook.name(),
        "stop": report.stop.name(), "files": report.files, "planned_bytes": report.planned_bytes,
        "missing": report.missing, "skipped": report.skipped, "pieces": report.pieces,
        "issued_bytes": report.issued_bytes, "plan_us": report.plan_us,
        "issue_us": report.issue_us,
    });
    if let Some(resident) = report.resident_bytes {
        line["resident_bytes"] = resident.into();
    }
    line
}

/// A reading that began at the bind and ends with the start: dropped, it asks the reading to stop.
pub(crate) struct Catalogs(Arc<AtomicBool>);
impl Drop for Catalogs {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl<M: Machine> Core<M> {
    /// The catalogs of `database`, read ahead while the start binds its slot (when the variant
    /// says so). The reading runs in a blocking task of its own that the start does not wait for.
    pub(crate) fn readahead_catalogs(&self, database: &str) -> Option<Catalogs> {
        if !self.prefetch.catalogs_at_bind() {
            return None;
        }
        let (data, id) = (self.layout().data(database), database.to_string());
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let plan = prefetch::catalog(&data, CATALOG_BUDGET, &stop);
            let report = plan.issue(
                Limits {
                    budget: CATALOG_BUDGET,
                    max_bytes: CATALOG_BYTES,
                },
                &stop,
            );
            crate::timing::emit_event(line(&id, "catalog", Hook::Bind, &report));
        });
        Some(Catalogs(cancel))
    }

    /// The hot list of `database`, read ahead from the moment the wake has released it (when the
    /// variant says so), in a blocking task of its own: the wake is over before it ends.
    pub(crate) fn readahead_hot_list(&self, database: &str) {
        if !self.prefetch.hot_list_at_ready() {
            return;
        }
        let (data, id) = (self.layout().data(database), database.to_string());
        tokio::task::spawn_blocking(move || {
            let never = AtomicBool::new(false);
            match prefetch::list(&data, HOT_LIST_PLAN, &never) {
                Ok(plan) => {
                    let report = plan.issue(
                        Limits {
                            budget: HOT_LIST_BUDGET,
                            max_bytes: HOT_LIST_BYTES,
                        },
                        &never,
                    );
                    crate::timing::emit_event(line(&id, "list", Hook::Ready, &report));
                }
                Err(unavailable) => crate::timing::emit_event(json!({
                    "event": "prefetch_unavailable", "database_id": id, "set": "list",
                    "reason": unavailable.reason(),
                })),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        Phase,
        power::{Slept, Why},
        testing::{Rig, eventually, timing},
    };
    use pgcf_native_protocol::wake::Outcome;

    fn events(database: &str, name: &str) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| event["event"] == name && event["database_id"] == database)
            .collect()
    }

    /// The variant of a build names the hooks it runs, and the build ships the measured one: the
    /// hot list from ready. The catalogs at the bind are code that a variant turns on, after the
    /// interleaved A/B of the module's documentation.
    #[test]
    fn a_variant_names_the_hooks_it_runs_and_the_build_ships_the_hot_list_alone() {
        for (variant, catalogs, list) in [
            (Prefetch::Off, false, false),
            (Prefetch::HotList, false, true),
            (Prefetch::CatalogsAndHotList, true, true),
        ] {
            assert_eq!(variant.catalogs_at_bind(), catalogs, "{variant:?}");
            assert_eq!(variant.hot_list_at_ready(), list, "{variant:?}");
        }
        assert_eq!(PREFETCH, Prefetch::HotList);
        assert_eq!(HOT_LIST_BUDGET, Duration::from_millis(150));
    }

    /// What a reading says travels to Cloudflare: its fields are numbers and short words, within
    /// the bound an event has.
    #[test]
    fn a_reading_logs_numbers_and_short_words_the_contract_accepts() {
        let report = Report {
            stop: prefetch::Stop::Budget,
            files: 41,
            planned_bytes: 5_242_880,
            missing: 2,
            skipped: 1,
            pieces: 40,
            issued_bytes: 4_000_000,
            resident_bytes: Some(1_000_000),
            plan_us: 1_800,
            issue_us: 150_000,
        };
        let line = line("abcdefghijklmnopqrst", "list", Hook::Ready, &report);
        let at = "2026-10-18T10:11:12.345Z";
        let event = crate::events::sanitize(&line, at).unwrap();
        let fields = event["fields"].as_object().unwrap();
        assert_eq!(fields.len(), 12, "{event}");
        assert_eq!(fields["stop"], "budget");
        assert_eq!((fields["set"].as_str(), fields["hook"].as_str()), (Some("list"), Some("ready")));
        assert!(crate::node_link::contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));
        // A kernel that cannot say what the cache held leaves the number out.
        let unknown = Report {
            resident_bytes: None,
            ..report
        };
        assert!(line_without_resident(&unknown));
    }
    fn line_without_resident(report: &Report) -> bool {
        line("abcdefghijklmnopqrst", "catalog", Hook::Bind, report)
            .get("resident_bytes")
            .is_none()
    }

    /// A wake reads the hot list ahead from the moment it has released the database, off its path,
    /// and says what it did; the catalogs are not read at the bind in the variant a build ships.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_reads_the_hot_list_ahead_from_ready_and_the_catalogs_only_when_the_variant_says_so()
    {
        let Some(rig) = Rig::with_timing("readahead-default", timing()).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        assert!(
            rig.core
                .layout()
                .data(&entry.id)
                .join("autoprewarm.blocks")
                .exists(),
            "the clean stop wrote the list"
        );
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        eventually(10, "the hot list's reading", || {
            !events(&entry.id, "prefetch").is_empty()
        })
        .await;
        let reading = events(&entry.id, "prefetch").remove(0);
        assert_eq!(reading["fields"]["set"], "list", "{reading}");
        assert_eq!(reading["fields"]["hook"], "ready");
        assert!(reading["fields"]["files"].as_u64() >= Some(1), "{reading}");
        assert!(
            events(&entry.id, "prefetch")
                .iter()
                .all(|event| event["fields"]["set"] != "catalog"),
            "no catalog at the bind in this variant"
        );
        assert_eq!(db.phase(), Phase::Ready);
    }

    /// The variant that reads the catalogs at the bind does, before the database is ready and
    /// whatever the list says; the variant that reads nothing reads nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_catalogs_are_read_at_the_bind_in_their_variant_and_nothing_in_the_variant_off() {
        for (variant, label, sets) in [
            (Prefetch::CatalogsAndHotList, "readahead-both", vec!["catalog", "list"]),
            (Prefetch::Off, "readahead-off", vec![]),
        ] {
            let Some(rig) = Rig::with_prefetch(label, variant).await else {
                return;
            };
            let (entry, db) = rig.create().await;
            assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
            let before = events(&entry.id, "prefetch").len();
            let result = rig.core.wake(&Rig::ticket(&entry)).await;
            assert_eq!(result.outcome, Outcome::Started, "{result:?}");
            if sets.is_empty() {
                tokio::time::sleep(Duration::from_millis(500)).await;
            } else {
                eventually(10, "the readings", || {
                    events(&entry.id, "prefetch").len() >= before + sets.len()
                })
                .await;
            }
            let mut found: Vec<String> = events(&entry.id, "prefetch")
                .iter()
                .skip(before)
                .map(|event| event["fields"]["set"].as_str().unwrap().to_string())
                .collect();
            found.sort();
            assert_eq!(found, sets, "{variant:?}");
            if sets.contains(&"catalog") {
                let catalog = events(&entry.id, "prefetch")
                    .into_iter()
                    .find(|event| event["fields"]["set"] == "catalog")
                    .unwrap();
                assert_eq!(catalog["fields"]["hook"], "bind");
                assert!(catalog["fields"]["files"].as_u64() >= Some(3), "{catalog}");
            }
        }
    }

    /// A database that never stopped cleanly has no list, and the agent says so instead of
    /// reading what is not there.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_without_a_list_says_so_and_wakes_all_the_same() {
        let Some(rig) = Rig::with_timing("readahead-no-list", timing()).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        std::fs::remove_file(rig.core.layout().data(&entry.id).join("autoprewarm.blocks")).unwrap();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        eventually(10, "the report of the missing list", || {
            !events(&entry.id, "prefetch_unavailable").is_empty()
        })
        .await;
        assert_eq!(
            events(&entry.id, "prefetch_unavailable")[0]["fields"]["reason"],
            "list_missing"
        );
    }
}
