// SPDX-License-Identifier: Apache-2.0
//! The agent's log: one JSON line per event on stderr, which journald collects. An event names a
//! class of what happened and never the text of an error, which can carry an address or a path.
//! The next observation report carries the line, reduced to what the contract allows (`events`).
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

/// Writes one event line to the agent's log.
pub fn emit_event(value: Value) {
    eprintln!("{value}");
    crate::events::record(&value);
}

/// The clock of the agent's start: when it began, when the last phase ended, and the phases that
/// are said once.
struct Start {
    began: Instant,
    last: Instant,
    said: HashSet<&'static str>,
}
static START: Mutex<Option<Start>> = Mutex::new(None);

fn start() -> std::sync::MutexGuard<'static, Option<Start>> {
    START.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One `agent_start_phase` event. `ms` counts from the end of the previous phase of the row, and
/// `row` says whether this phase is the next of the row.
fn say(name: &'static str, fields: &[(&'static str, u64)], row: bool, once: bool) {
    let (ms, at_ms) = {
        let mut guard = start();
        let now = Instant::now();
        let clock = guard.get_or_insert(Start {
            began: now,
            last: now,
            said: HashSet::new(),
        });
        if once && !clock.said.insert(name) {
            return;
        }
        let ms = now.duration_since(clock.last);
        if row {
            clock.last = now;
        }
        (ms, now.duration_since(clock.began))
    };
    let millis =
        |elapsed: std::time::Duration| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
    let (ms, at_ms) = (millis(ms), millis(at_ms));
    let mut event = json!({"event": "agent_start_phase", "phase": name, "ms": ms, "at_ms": at_ms});
    for (key, value) in fields {
        event[*key] = (*value).into();
    }
    emit_event(event);
}

/// The end of a phase of the agent's start (`agent_start_phase`), so that the next restart of a
/// node says where its time went. `ms` is the time since the previous phase of the row ended and
/// `at_ms` the time since the first phase. `fields` are numbers the phase adds.
pub fn phase_with(name: &'static str, fields: &[(&'static str, u64)]) {
    say(name, fields, true, false);
}

pub fn phase(name: &'static str) {
    phase_with(name, &[]);
}

/// A phase that happens beside the row and is said once: the link's welcome, the first wake the
/// agent answered. It is read by `at_ms`.
pub fn phase_once(name: &'static str) {
    say(name, &[], false, true);
}

/// What the agent spent on one of the things that grow with the number of databases: how often it
/// was done and the time of all the callers added up, which is more than the wall time where
/// they ran at once. `phase_with` is told these at the end of the first pass.
pub struct Spent {
    runs: AtomicU64,
    micros: AtomicU64,
}
impl Spent {
    const fn new() -> Self {
        Self {
            runs: AtomicU64::new(0),
            micros: AtomicU64::new(0),
        }
    }
    pub fn add(&self, elapsed: Duration) {
        self.runs.fetch_add(1, Ordering::Relaxed);
        self.micros.fetch_add(
            u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX),
            Ordering::Relaxed,
        );
    }
    pub fn runs(&self) -> u64 {
        self.runs.load(Ordering::Relaxed)
    }
    pub fn ms(&self) -> u64 {
        self.micros.load(Ordering::Relaxed) / 1000
    }
}
/// The runs of `lvs`.
pub static LVS: Spent = Spent::new();
/// The mounts of a volume.
pub static MOUNT: Spent = Spent::new();
/// The reads of a database's unit.
pub static UNIT_READ: Spent = Spent::new();

#[cfg(test)]
mod tests {
    use super::*;

    fn said(phase: &str) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| {
                event["event"] == "agent_start_phase" && event["fields"]["phase"] == phase
            })
            .collect()
    }

    /// A phase is an event with the time since the previous phase and since the first, and the
    /// numbers it adds; a phase said once is said once, and does not move the row.
    #[test]
    fn a_phase_says_its_times_and_a_phase_said_once_is_said_once() {
        phase_with("test_row_first", &[("databases", 3)]);
        std::thread::sleep(Duration::from_millis(20));
        phase_once("test_beside");
        phase_once("test_beside");
        phase("test_row_second");
        let first = said("test_row_first");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["fields"]["databases"], 3);
        assert_eq!(said("test_beside").len(), 1);
        // The second phase of the row counts from the first: the phase beside it did not move the
        // row, and the 20 ms are in it.
        let second = &said("test_row_second")[0]["fields"];
        assert!(second["ms"].as_u64().unwrap() >= 20, "{second}");
        assert!(second["at_ms"].as_u64() >= second["ms"].as_u64());
    }

    #[test]
    fn the_time_spent_adds_up_with_the_number_of_times() {
        let spent = Spent::new();
        spent.add(Duration::from_millis(1500));
        spent.add(Duration::from_millis(500));
        assert_eq!((spent.runs(), spent.ms()), (2, 2000));
    }
}
