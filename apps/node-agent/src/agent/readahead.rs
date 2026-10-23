// SPDX-License-Identifier: Apache-2.0
//! What the agent reads ahead for a wake (plan 11.2, package F; `prefetch.rs` and `program.rs` do
//! the reading).
//!
//! A database that slept for hours has had its pages evicted, and so has the program of its
//! PostgreSQL when the node has run no database for a while. The start of PostgreSQL, its login and
//! its first statements read them from the disk one random read at a time. The agent knows the
//! files before the request does, and asks the kernel to read them ahead. Three hooks, and a
//! variant says which of them a build runs (a constant of the build, not a policy of the node: what
//! is measured decides it, and the node's page does not carry it):
//!
//! - **The program, from the pool's refill.** The binary of PostgreSQL, the libraries it links, its
//!   preloaded extension and the few system files its postmaster opens are kept in the page cache
//!   (`program`): one pass at the first refill after the agent starts and then one every
//!   `Timing::program_every`. The cache keeps recently used pages and drops the others; a pass
//!   counts the pages of each 128 KiB piece (about 300 `cachestat` calls and 40 opens for 37 MB)
//!   and advises only a piece it has lost, so it reads nothing when nothing was lost and reads
//!   back exactly what was. It never runs while a start is in flight or waits, and a start that
//!   begins ends the pass that is running. EU1, 2026-10-23, 24 h stratum: PostgreSQL's exec to its
//!   'starting' line took 144 / 407 ms at p50 / p95 after the pool had built the sandbox, and the
//!   lab put its program's share of that at 21 to 35 ms warm.
//! - **The start set and the catalogs at the bind.** What PostgreSQL reads between its exec and its
//!   ready (the configuration, `pg_control`, the WAL at the checkpoint and the redo point, the SLRU
//!   segments, `global/`; about 1 MB) and the ~5 MB the login reads (the catalog set) are read ahead
//!   from the moment the start has its permit, in a blocking task that the order does not wait
//!   for. The reads are queued while the slot is bound (13 / 84 ms at p50 / p95 on EU1), before
//!   PostgreSQL's own `fsync`s begin, once, and the reading ends at `BIND_BUDGET` or with the start
//!   (the lab of 2026-10-20: prefetch of 100 MB and more that overlapped those `fsync`s made the
//!   WAKE 230 to 600 ms slower on EU1's disk, whose scheduler is `none`; the catalogs alone, 5 MB
//!   from the fork, cost nothing and cut the login from 73 / 269 to 23 / 44 ms). The variant
//!   `Start::Alternate` is the A/B: every second start reads the sets, the first does, and every
//!   start says which it was (`prefetch_arm`).
//! - **The hot list from ready.** Once the wake has released the database, the blocks of
//!   `autoprewarm.blocks` are read ahead for at most `HOT_LIST_BUDGET`. It overlaps the first
//!   request and PostgreSQL's own autoprewarm, and nothing of the wake waits for it. Measured in
//!   the prefetch lab of 2026-10-20 (arm I): the statements took about 10 ms less at p50.
//!
//! **The switch.** `PREFETCH` below is the one line that says what a build runs; the A/B is a
//! release that changes it, and the node's page carries no setting for it. The program and the hot
//! list are on, and the release ships `Start::Alternate` for the sets at the bind: it is the live
//! interleaved A/B on the pooled path (at least 18 starts per arm, on the 24 h and 1 h strata), and
//! the decision after it is a release with `Start::On` or `Start::Off`.
//!
//! Every reading says what it did in an event (`prefetch`, `program_warm`): its set and hook, why
//! it ended, and the counts and times of `prefetch::Report`; a list that is not there or not
//! readable says so (`prefetch_unavailable`).
use super::Core;
use crate::{
    machine::Machine,
    prefetch::{self, Limits, Plan, Report},
    program::Program,
    settings::PRELOAD_LIBRARIES,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// What a build reads ahead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prefetch {
    /// The program of PostgreSQL, kept in the page cache by the pool's refill.
    pub program: bool,
    /// The start set and the catalogs, at the bind.
    pub start: Start,
    /// The hot list, from ready.
    pub hot_list: bool,
}

/// Which starts read the start set and the catalogs at the bind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Start {
    Off,
    On,
    /// The first start, the third and every other after, and not the second, the fourth and so on:
    /// the arms of one A/B on the same databases in the same hours.
    Alternate,
}

/// What this build runs: the program kept warm, the sets at the bind on every second start (the
/// live A/B), the hot list. The decision after the A/B is a release with `start: Start::On` or
/// `Start::Off`.
pub const PREFETCH: Prefetch = Prefetch {
    program: true,
    start: Start::Alternate,
    hot_list: true,
};

/// How long the hot list may take to plan, and how long its pieces may be issued: the request it
/// overlaps is over in a few hundred milliseconds, and what is advised later helps the next.
const HOT_LIST_PLAN: Duration = Duration::from_millis(50);
pub const HOT_LIST_BUDGET: Duration = Duration::from_millis(150);
/// The bytes of the hot list advised at most. A list names the shared buffers, 25 % of the
/// database's memory at most, so this binds on no database.
const HOT_LIST_BYTES: u64 = 1 << 30;
/// What the reading at the bind may take, planning and issuing of both sets together, from the
/// start's permit: the bind is 13 / 84 ms at p50 / p95 and the lab's catalog set took 15 / 227 ms,
/// so the reading ends about when PostgreSQL's own start-up begins and a slow disk cuts it short
/// rather than lets it queue behind PostgreSQL's `fsync`s.
const BIND_BUDGET: Duration = Duration::from_millis(50);
/// The bytes of the start set (about 1 MB) and of the catalogs (5.2 MB on a gate database).
const START_BYTES: u64 = 4 << 20;
const CATALOG_BYTES: u64 = 8 << 20;
/// A pass over the program: the program is 37 MB, and the pass is bounded in time and bytes as the
/// other readings are.
const PROGRAM_BUDGET: Duration = Duration::from_millis(500);
const PROGRAM_BYTES: u64 = 128 << 20;

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
        "advised": report.advised, "issued_bytes": report.issued_bytes,
        "plan_us": report.plan_us, "issue_us": report.issue_us,
    });
    if let Some(resident) = report.resident_bytes {
        line["resident_bytes"] = resident.into();
    }
    line
}

/// The log line of a pass over the program: the pass counts from 1 at the agent's start, the files
/// the closure could not find are in `missing` with the plan's, and `data_files` are the files left
/// out because they are data.
fn program_line(pass: u64, program: &Program, report: &Report) -> Value {
    let mut line = json!({
        "event": "program_warm", "pass": pass, "stop": report.stop.name(),
        "files": report.files, "planned_bytes": report.planned_bytes,
        "missing": report.missing + program.unresolved(), "data_files": program.data_files(),
        "skipped": report.skipped, "pieces": report.pieces, "advised": report.advised,
        "issued_bytes": report.issued_bytes, "plan_us": report.plan_us,
        "issue_us": report.issue_us,
    });
    if let Some(resident) = report.resident_bytes {
        line["resident_bytes"] = resident.into();
    }
    line
}

/// A reading that began at the bind and ends with the start: dropped, it asks the reading to stop.
pub(crate) struct AtBind(Arc<AtomicBool>);
impl Drop for AtBind {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// What the agent remembers of its readings.
pub(crate) struct Readahead {
    /// The starts that asked whether to read at the bind (`Start::Alternate` counts them).
    starts: AtomicU64,
    /// Raised by every start, lowered before a pass over the program: a pass ends when a start begins.
    start_began: Arc<AtomicBool>,
    program: Mutex<ProgramPasses>,
}
#[derive(Default)]
struct ProgramPasses {
    /// The program, found at the first pass.
    found: Option<Arc<Program>>,
    last: Option<Instant>,
    passes: u64,
}
impl Readahead {
    pub(crate) fn new() -> Self {
        Self {
            starts: AtomicU64::new(0),
            start_began: Arc::new(AtomicBool::new(false)),
            program: Mutex::new(ProgramPasses::default()),
        }
    }
    fn passes(&self) -> MutexGuard<'_, ProgramPasses> {
        self.program.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// A start begins: a pass over the program that is running ends.
    pub(crate) fn start_began(&self) {
        self.start_began.store(true, Ordering::Relaxed);
    }
    /// The passes over the program the agent has made, for a test of the loop that makes them.
    #[cfg(test)]
    pub(crate) fn program_passes(&self) -> u64 {
        self.passes().passes
    }
    /// Whether this start reads at the bind.
    fn at_bind(&self, start: Start) -> bool {
        match start {
            Start::Off => false,
            Start::On => true,
            Start::Alternate => self
                .starts
                .fetch_add(1, Ordering::Relaxed)
                .is_multiple_of(2),
        }
    }
}

/// One set of the bind: its plan (blocking), then its issuing, as one event.
fn read_set(
    database: &str,
    set: &str,
    began: Instant,
    bytes: u64,
    cancel: &AtomicBool,
    plan: impl FnOnce(Duration, &AtomicBool) -> Plan,
) -> Report {
    let left = BIND_BUDGET.saturating_sub(began.elapsed());
    let report = plan(left, cancel).issue(
        Limits {
            budget: BIND_BUDGET.saturating_sub(began.elapsed()),
            max_bytes: bytes,
        },
        cancel,
    );
    crate::timing::emit_event(line(database, set, Hook::Bind, &report));
    report
}

impl<M: Machine> Core<M> {
    /// The start set and the catalogs of `database`, read ahead while the start binds its slot
    /// (when the variant says so for this start). The reading runs in a blocking task of its own
    /// that the start does not wait for, and ends at its budget or when the returned guard is
    /// dropped, which is when the start ends.
    pub(crate) fn readahead_at_bind(&self, database: &str) -> Option<AtBind> {
        let start = self.prefetch.start;
        let on = self.readahead.at_bind(start);
        if start == Start::Alternate {
            crate::timing::emit_event(json!({
                "event": "prefetch_arm", "database_id": database,
                "arm": if on { "start" } else { "none" },
            }));
        }
        if !on {
            return None;
        }
        let (data, id) = (self.layout().data(database), database.to_string());
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = cancel.clone();
        tokio::task::spawn_blocking(move || {
            let began = Instant::now();
            let report = read_set(&id, "start", began, START_BYTES, &stop, |budget, cancel| {
                prefetch::start(&data, budget, cancel)
            });
            // The catalogs follow a start set that was read, not one that was cut off.
            if !matches!(
                report.stop,
                prefetch::Stop::Cancelled | prefetch::Stop::Failed
            ) {
                read_set(
                    &id,
                    "catalog",
                    began,
                    CATALOG_BYTES,
                    &stop,
                    |budget, cancel| prefetch::catalog(&data, budget, cancel),
                );
            }
        });
        Some(AtBind(cancel))
    }

    /// The hot list of `database`, read ahead from the moment the wake has released it (when the
    /// variant says so), in a blocking task of its own: the wake is over before it ends.
    pub(crate) fn readahead_hot_list(&self, database: &str) {
        if !self.prefetch.hot_list {
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

    /// One pass over the program of PostgreSQL, if the build keeps it and it is time: the first
    /// pass of the agent, then one every `Timing::program_every`. It does nothing while a start is
    /// in flight or waits, on a node that is fenced or in maintenance, and a start that begins
    /// ends the pass at its next file or piece. The event says what the pass found lost and read
    /// back; a pass that read nothing is silent after the first. Returns what the pass did, or
    /// `None` when none was made.
    pub(crate) async fn warm_program(&self) -> Option<Report> {
        if !self.prefetch.program {
            return None;
        }
        let due = self
            .readahead
            .passes()
            .last
            .is_none_or(|at| at.elapsed() >= self.timing.program_every);
        if !due {
            return None;
        }
        // Lowered before the node is asked whether it is quiet: a start that gets its permit after
        // the answer raises it again, and one that got it before is not quiet.
        self.readahead.start_began.store(false, Ordering::Relaxed);
        if self.fences.fenced() || self.maintenance.load(Ordering::Relaxed) {
            return None;
        }
        if !self.admission.quiet().await {
            return None;
        }
        let known = self.readahead.passes().found.clone();
        let program = match known {
            Some(program) => program,
            None => {
                let layout = self.layout().clone();
                let Ok(found) = tokio::task::spawn_blocking(move || {
                    Program::find(
                        &layout.postgres_bin.join("postgres"),
                        &layout.postgres_lib,
                        PRELOAD_LIBRARIES,
                    )
                })
                .await
                else {
                    return None;
                };
                let found = Arc::new(found);
                self.readahead.passes().found = Some(found.clone());
                found
            }
        };
        let cancel = self.readahead.start_began.clone();
        let running = program.clone();
        let Ok(report) = tokio::task::spawn_blocking(move || {
            running.plan(PROGRAM_BUDGET, &cancel).issue(
                Limits {
                    budget: PROGRAM_BUDGET,
                    max_bytes: PROGRAM_BYTES,
                },
                &cancel,
            )
        })
        .await
        else {
            return None;
        };
        let pass = {
            let mut passes = self.readahead.passes();
            passes.passes += 1;
            // A pass that a start ended early is made again at the next refill.
            if report.stop != prefetch::Stop::Cancelled {
                passes.last = Some(Instant::now());
            }
            passes.passes
        };
        if pass == 1 || report.advised > 0 {
            crate::timing::emit_event(program_line(pass, &program, &report));
        }
        Some(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        Phase, Timing,
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
    /// The `program_warm` events (they have no database), after the first `after` of them.
    fn passes(after: usize) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| event["event"] == "program_warm")
            .skip(after)
            .collect()
    }

    /// The variant of a build names the hooks it runs, and the build ships the measured ones, the
    /// program kept warm and the hot list from ready, and the sets at the bind for every second
    /// start: the live A/B of the module's documentation.
    #[test]
    fn the_build_ships_the_program_and_the_hot_list_and_alternates_the_sets_at_the_bind() {
        assert_eq!(
            PREFETCH,
            Prefetch {
                program: true,
                start: Start::Alternate,
                hot_list: true
            }
        );
        assert_eq!(HOT_LIST_BUDGET, Duration::from_millis(150));
        // The arms of the A/B: nothing, every start, and every second start beginning with the
        // first.
        let readahead = Readahead::new();
        let arms = |start| (0..5).map(|_| readahead.at_bind(start)).collect::<Vec<_>>();
        assert_eq!(arms(Start::Off), [false; 5]);
        assert_eq!(arms(Start::On), [true; 5]);
        assert_eq!(
            arms(Start::Alternate),
            [true, false, true, false, true],
            "the starts of the other variants do not count"
        );
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
            advised: 12,
            issued_bytes: 4_000_000,
            resident_bytes: Some(1_000_000),
            plan_us: 1_800,
            issue_us: 150_000,
        };
        let at = "2026-10-18T10:11:12.345Z";
        let line = line("abcdefghijklmnopqrst", "list", Hook::Ready, &report);
        let event = crate::events::sanitize(&line, at).unwrap();
        let fields = event["fields"].as_object().unwrap();
        assert_eq!(fields.len(), 13, "{event}");
        assert_eq!(fields["stop"], "budget");
        assert_eq!(fields["advised"], 12);
        assert_eq!(
            (fields["set"].as_str(), fields["hook"].as_str()),
            (Some("list"), Some("ready"))
        );
        assert!(crate::node_link::contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));
        // A kernel that cannot say what the cache held leaves the number out.
        let unknown = Report {
            resident_bytes: None,
            ..report
        };
        assert!(
            line_without_resident(&unknown)
                && program_line(1, &Program::default(), &unknown)
                    .get("resident_bytes")
                    .is_none()
        );
        // A pass over the program has no database, adds the closure's gaps to the plan's, and
        // fits the bound of an event as well.
        let program = program_line(3, &Program::default(), &report);
        let event = crate::events::sanitize(&program, at).unwrap();
        let fields = event["fields"].as_object().unwrap();
        assert_eq!(fields.len(), 13, "{event}");
        assert_eq!(
            (fields["pass"].as_u64(), fields["missing"].as_u64()),
            (Some(3), Some(2))
        );
        assert!(event.get("database_id").is_none());
        assert!(crate::node_link::contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));
    }
    fn line_without_resident(report: &Report) -> bool {
        line("abcdefghijklmnopqrst", "catalog", Hook::Bind, report)
            .get("resident_bytes")
            .is_none()
    }

    /// A reading that is dropped asks the reading to stop; the end of a start drops it.
    #[test]
    fn the_guard_of_a_reading_at_the_bind_stops_the_reading_when_it_is_dropped() {
        let flag = Arc::new(AtomicBool::new(false));
        let guard = AtBind(flag.clone());
        assert!(!flag.load(Ordering::Relaxed));
        drop(guard);
        assert!(flag.load(Ordering::Relaxed));
    }

    /// A wake reads the hot list ahead from the moment it has released the database, off its path,
    /// and says what it did; nothing is read at the bind in a variant without the sets (the build
    /// ships `Start::Alternate`, tested below).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_reads_the_hot_list_ahead_from_ready_and_the_sets_only_when_the_variant_says_so()
    {
        let variant = Prefetch {
            start: Start::Off,
            ..PREFETCH
        };
        let Some(rig) = Rig::with_prefetch("readahead-default", variant).await else {
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
                .all(|event| event["fields"]["hook"] == "ready"),
            "nothing at the bind in this variant"
        );
        assert!(events(&entry.id, "prefetch_arm").is_empty());
        assert_eq!(db.phase(), Phase::Ready);
    }

    /// A wake in `variant` reads ahead exactly the `sets`, in this order of names. One rig, one
    /// test: a second rig in the same test ends the first one's machine on a worker of the
    /// runtime, which waits for its PostgreSQL to stop and starves the second rig's jobs.
    async fn wake_in(variant: Prefetch, label: &str, sets: &[&str]) {
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
        for set in ["start", "catalog"]
            .into_iter()
            .filter(|s| sets.contains(s))
        {
            let reading = events(&entry.id, "prefetch")
                .into_iter()
                .skip(before)
                .find(|event| event["fields"]["set"] == set)
                .unwrap();
            assert_eq!(reading["fields"]["hook"], "bind");
            // `start` has `pg_control` and the configuration, `catalog` the maps of a database.
            assert!(reading["fields"]["files"].as_u64() >= Some(3), "{reading}");
        }
    }

    /// The variant that reads the sets at the bind does, before the database is ready and
    /// whatever the list says: the start set, the catalogs and the list.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_start_set_and_the_catalogs_are_read_at_the_bind_in_their_variant() {
        let variant = Prefetch {
            start: Start::On,
            ..PREFETCH
        };
        wake_in(variant, "readahead-both", &["catalog", "list", "start"]).await;
    }

    /// The variant that reads nothing reads nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn nothing_is_read_ahead_in_the_variant_off() {
        let variant = Prefetch {
            program: false,
            start: Start::Off,
            hot_list: false,
        };
        wake_in(variant, "readahead-off", &[]).await;
    }

    /// The A/B variant: the first start reads the sets, the second does not, and each says which
    /// it was, with the database, so that the wakes can be joined to their arm.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_alternating_variant_reads_at_every_second_start_and_says_which() {
        let variant = Prefetch {
            start: Start::Alternate,
            hot_list: false,
            ..PREFETCH
        };
        let Some(rig) = Rig::with_prefetch("readahead-alternate", variant).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        // The create is a start too: it took the first arm.
        let arm = |n: usize| events(&entry.id, "prefetch_arm")[n]["fields"]["arm"].clone();
        assert_eq!(arm(0), "start");
        for expected in ["none", "start"] {
            assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
            let result = rig.core.wake(&Rig::ticket(&entry)).await;
            assert_eq!(result.outcome, Outcome::Started, "{result:?}");
            let seen = events(&entry.id, "prefetch_arm");
            assert_eq!(seen.last().unwrap()["fields"]["arm"], expected, "{seen:?}");
        }
        // The two starts that read have their sets (the create's and the last wake's), and the one
        // that did not has none.
        eventually(10, "the readings of the starts", || {
            events(&entry.id, "prefetch")
                .iter()
                .filter(|event| event["fields"]["set"] == "start")
                .count()
                >= 2
        })
        .await;
        assert_eq!(events(&entry.id, "prefetch_arm").len(), 3);
    }

    /// A database without a list says so, and the agent wakes it all the same.
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

    /// The program is passed over at the first refill, silently at the next ones that find the
    /// cache whole, and again once the interval has passed; never while a start is in flight, on a
    /// fenced node or in maintenance; and a start ends the pass that runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_program_is_passed_over_at_the_first_refill_and_then_at_its_interval() {
        let Some(rig) = Rig::with_timing(
            "readahead-program",
            Timing {
                program_every: Duration::from_millis(400),
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        let seen = passes(0).len();
        rig.core.warm_program().await;
        let first = passes(seen);
        assert_eq!(first.len(), 1, "the first pass is always reported");
        let fields = &first[0]["fields"];
        assert_eq!(fields["pass"], 1);
        // The binary, its libraries and the preloaded extension.
        assert!(fields["files"].as_u64() >= Some(3), "{first:?}");
        assert!(
            fields["planned_bytes"].as_u64() >= Some(1 << 20),
            "{first:?}"
        );

        // Not due: nothing runs, whatever the cache holds.
        rig.core.warm_program().await;
        assert_eq!(passes(seen).len(), 1);
        assert_eq!(rig.core.readahead.passes().passes, 1);

        // A maintenance order holds the pass back without using up its turn.
        tokio::time::sleep(Duration::from_millis(450)).await;
        rig.core.maintenance.store(true, Ordering::Relaxed);
        rig.core.warm_program().await;
        assert_eq!(rig.core.readahead.passes().passes, 1, "in maintenance");
        rig.core.maintenance.store(false, Ordering::Relaxed);

        // Due and quiet: the second pass runs. It is reported only if it read something back.
        rig.core.warm_program().await;
        assert_eq!(rig.core.readahead.passes().passes, 2);
        for event in passes(seen).iter().skip(1) {
            assert!(event["fields"]["advised"].as_u64() > Some(0), "{event}");
        }

        // So does a fence, which is the node's whole stop.
        tokio::time::sleep(Duration::from_millis(450)).await;
        rig.core.fences.fence("op_ffffffffffffffffffff").unwrap();
        rig.core.warm_program().await;
        assert_eq!(rig.core.readahead.passes().passes, 2, "fenced");
    }

    /// A pass that finds the program whole reads nothing and is silent, except the first of the
    /// agent, which says what it found: a node whose program is never lost does not fill the
    /// events with passes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pass_that_finds_the_program_whole_is_silent_after_the_first() {
        let Some(rig) = Rig::with_timing(
            "readahead-silent",
            Timing {
                program_every: Duration::ZERO,
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        // Files of a size, written and read: in the cache wherever the kernel can count it.
        let dir = crate::testpg::directory("readahead-silent");
        let files: Vec<_> = ["libone.so", "libtwo.so"]
            .iter()
            .map(|name| {
                std::fs::write(dir.join(name), vec![7u8; 300_000]).unwrap();
                std::fs::read(dir.join(name)).unwrap();
                dir.join(name)
            })
            .collect();
        rig.core.readahead.passes().found = Some(Arc::new(Program::from_files(files)));
        let seen = passes(0).len();
        rig.core.warm_program().await;
        let first = passes(seen);
        assert_eq!(first.len(), 1, "the first pass is always reported");
        let fields = &first[0]["fields"];
        if fields["advised"].as_u64() != Some(0) {
            eprintln!("skipped: this file system does not report the pages of its files");
            return;
        }
        assert_eq!(
            fields["resident_bytes"], fields["issued_bytes"],
            "{first:?}"
        );
        assert_eq!(
            (fields["pass"].as_u64(), fields["files"].as_u64()),
            (Some(1), Some(2))
        );
        for _ in 0..3 {
            rig.core.warm_program().await;
        }
        assert_eq!(rig.core.readahead.passes().passes, 4);
        assert_eq!(
            passes(seen).len(),
            1,
            "a whole program is not reported again"
        );
    }

    /// The pass is not made while a start is in flight, and is made once the node is quiet: a
    /// pass reads from the disk a start is waiting for.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_program_is_not_passed_over_while_a_start_is_in_flight() {
        let Some(rig) = Rig::new("readahead-program-busy").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.delay_next_start(Duration::from_millis(1200));
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&entry));
        let waking = tokio::spawn(async move { core.wake(&ticket).await });
        eventually(10, "the start to be ordered", || {
            rig.machine.running(&entry.id)
        })
        .await;
        rig.core.warm_program().await;
        assert_eq!(
            rig.core.readahead.passes().passes,
            0,
            "a start is in flight"
        );
        assert_eq!(waking.await.unwrap().outcome, Outcome::Started);
        rig.core.warm_program().await;
        assert_eq!(rig.core.readahead.passes().passes, 1);
    }

    /// The build without the program does not look for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_build_without_the_program_makes_no_pass() {
        let variant = Prefetch {
            program: false,
            ..PREFETCH
        };
        let Some(rig) = Rig::with_prefetch("readahead-no-program", variant).await else {
            return;
        };
        rig.core.warm_program().await;
        let passes = rig.core.readahead.passes();
        assert!(passes.found.is_none() && passes.passes == 0);
    }

    /// A start raises the flag that ends a pass when it has its permit, before its unit is ordered
    /// and for as long as it is in flight, and a pass lowers it first. That the pass obeys the flag
    /// is the next test's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_raises_the_flag_that_ends_a_pass_and_a_pass_lowers_it() {
        let Some(rig) = Rig::with_timing("readahead-start-ends-pass", timing()).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert!(
            rig.core.readahead.start_began.load(Ordering::Relaxed),
            "the create took a permit"
        );
        // A pass lowers it before it asks whether the node is quiet.
        rig.core.warm_program().await;
        assert!(!rig.core.readahead.start_began.load(Ordering::Relaxed));
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        assert!(
            !rig.core.readahead.start_began.load(Ordering::Relaxed),
            "a sleep is not a start"
        );
        // The wake is held in flight: its postmaster is up and the start has not ended. The flag
        // is up already, and not only once the start has succeeded, for a pass that began in
        // between would read from the disk the start is waiting for.
        rig.machine.delay_next_start(Duration::from_millis(1200));
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&entry));
        let waking = tokio::spawn(async move { core.wake(&ticket).await });
        eventually(10, "the start to be ordered", || {
            rig.machine.running(&entry.id)
        })
        .await;
        assert!(
            rig.core.readahead.start_began.load(Ordering::Relaxed),
            "a start in flight has raised the flag"
        );
        assert!(!waking.is_finished(), "the start is still in flight");
        let result = waking.await.unwrap();
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        assert!(rig.core.readahead.start_began.load(Ordering::Relaxed));
    }

    /// A start that begins while a pass runs ends it at its next file or piece, and the pass is
    /// made again at the next refill, not at the interval. The program has 2000 files, so no pass
    /// over it is over within the 2 ms after which the start is raised.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_that_begins_during_a_pass_ends_it_and_the_pass_is_made_again() {
        let Some(rig) = Rig::with_timing(
            "readahead-pass-ended",
            Timing {
                program_every: Duration::from_secs(3600),
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        let dir = crate::testpg::directory("readahead-pass-ended");
        let files: Vec<_> = (0..2000)
            .map(|n| {
                let path = dir.join(format!("lib{n}.so"));
                std::fs::write(&path, [7u8; 4096]).unwrap();
                path
            })
            .collect();
        rig.core.readahead.passes().found = Some(Arc::new(Program::from_files(files)));

        // A start has begun already, as the create of a database has: the pass lowers the flag
        // as it begins, and this thread, which sees it lowered, raises it again 2 ms into the pass.
        rig.core.readahead.start_began();
        let core = rig.core.clone();
        let start = std::thread::spawn(move || {
            let waiting = Instant::now();
            while core.readahead.start_began.load(Ordering::Relaxed) {
                assert!(
                    waiting.elapsed() < Duration::from_secs(30),
                    "the pass never began"
                );
                std::thread::sleep(Duration::from_micros(50));
            }
            std::thread::sleep(Duration::from_millis(2));
            core.readahead.start_began();
        });
        let ended = rig.core.warm_program().await.expect("a pass was made");
        start.join().unwrap();
        assert_eq!(ended.stop, prefetch::Stop::Cancelled, "{ended:?}");
        assert!(ended.files < 2000, "the planning stopped: {ended:?}");
        assert_eq!(ended.pieces, 0, "the issuing stopped: {ended:?}");
        assert_eq!(rig.core.readahead.passes().passes, 1);
        assert!(
            rig.core.readahead.passes().last.is_none(),
            "a pass that a start ended does not use up the interval"
        );

        // The next refill, long before the interval of an hour: the pass is made whole.
        let whole = rig
            .core
            .warm_program()
            .await
            .expect("the pass was made again");
        assert_ne!(whole.stop, prefetch::Stop::Cancelled, "{whole:?}");
        assert!(whole.pieces > ended.pieces, "{whole:?}");
        assert_eq!(rig.core.readahead.passes().passes, 2);
        assert!(rig.core.readahead.passes().last.is_some());
        assert!(
            rig.core.warm_program().await.is_none(),
            "a pass that ran to its end waits for the interval"
        );
    }
}
