// SPDX-License-Identifier: Apache-2.0
//! The usage meter (plan 3.4, 5.6 job 9): what each database used, as rows of `NodeUsageRow`. A row
//! is one database over one interval inside one UTC hour: the milliseconds it was awake, and how
//! much the gateway's counters grew. A value the node cannot know is null and never zero.
//!
//! Awake time is exact: the core tells the meter when a database starts and stops being served, and
//! every tick checks the meter against what the core says now. The traffic is the difference of two
//! readings of the gateway's counters one tick apart, as `measurementDifferences` states it: only
//! within one counter run, never backwards, and over a tick that touches two UTC hours it is split
//! between them pro rata by elapsed time.
//!
//! The meter keeps its place in `usage.json`, so a restart of the agent continues the intervals of
//! the databases that ran on. What was awake and ended between the last tick and a crash is not in
//! any row; a tick is the most it can be.
use crate::{Error, archive::facts::timestamp, gateway::Activity, link::file};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    sync::{Mutex, PoisonError},
};

const HOUR_MS: i64 = 3_600_000;

/// The gateway's counters of one database at one moment, when they have a history the meter can
/// difference.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counters {
    /// The counter run: a different one means the gateway counted anew.
    run: String,
    since: String,
    ingress_bytes: u64,
    egress_bytes: u64,
    connections: u64,
    connection_ms: u64,
}
impl Counters {
    /// `None` for a report without a usable history: the gateway has not counted since the start of
    /// its run, or has counted only part of it (`history()` of `measurements.ts`).
    pub fn of(activity: &Activity) -> Option<Self> {
        let history = activity.counters_since.is_some()
            && (activity.history == "current_process_absence"
                || (activity.history == "complete" && activity.last_activity_ms.is_some()));
        if !history {
            return None;
        }
        Some(Self {
            run: activity.epoch.clone(),
            since: activity.counters_since.clone()?,
            ingress_bytes: activity.ingress_bytes?,
            egress_bytes: activity.egress_bytes?,
            connections: activity.total_connections?,
            connection_ms: activity.connection_milliseconds?,
        })
    }

    /// What grew from `earlier` to `self`, or `None` when the two cannot be compared.
    fn since(&self, earlier: &Self) -> Option<[u64; 4]> {
        (self.run == earlier.run && self.since == earlier.since).then_some(())?;
        Some([
            self.ingress_bytes.checked_sub(earlier.ingress_bytes)?,
            self.egress_bytes.checked_sub(earlier.egress_bytes)?,
            self.connections.checked_sub(earlier.connections)?,
            self.connection_ms.checked_sub(earlier.connection_ms)?,
        ])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    /// Where the next row starts.
    from_ms: i64,
    /// Since when the database has been awake, if it is.
    awake_since: Option<i64>,
    /// The gateway's counters at `from_ms`.
    counters: Option<Counters>,
    /// Awake spans that ended since `from_ms`.
    #[serde(skip)]
    ended: Vec<(i64, i64)>,
}
impl Entry {
    fn new(from_ms: i64) -> Self {
        Self {
            from_ms,
            awake_since: None,
            counters: None,
            ended: Vec::new(),
        }
    }
    fn set_awake(&mut self, on: bool, at: i64) {
        match (on, self.awake_since) {
            (true, None) => self.awake_since = Some(at),
            (false, Some(since)) => {
                self.ended.push((since, at.max(since)));
                self.awake_since = None;
            }
            _ => {}
        }
    }
    /// The milliseconds of `[from, to)` the database was awake.
    fn awake_ms(&self, from: i64, to: i64, now: i64) -> i64 {
        let open = self.awake_since.map(|since| (since, now));
        self.ended
            .iter()
            .copied()
            .chain(open)
            .map(|(start, end)| (end.min(to) - start.max(from)).max(0))
            .sum()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    version: u8,
    databases: BTreeMap<String, Entry>,
}

pub struct Meter {
    path: PathBuf,
    databases: Mutex<BTreeMap<String, Entry>>,
}

/// The hours `[from, to)` touches, as intervals.
fn fragments(from: i64, to: i64) -> Vec<(i64, i64)> {
    let mut parts = Vec::new();
    let mut start = from;
    while start < to {
        let end = ((start.div_euclid(HOUR_MS) + 1) * HOUR_MS).min(to);
        parts.push((start, end));
        start = end;
    }
    parts
}

/// The share of `amount` that falls to the first of two fragments: its elapsed time over the
/// whole, rounded down. The second takes the rest, so the two add up to `amount`.
fn first_share(amount: u64, first: (i64, i64), second: (i64, i64)) -> u64 {
    let (head, whole) = (first.1 - first.0, second.1 - first.0);
    u64::try_from(u128::from(amount) * head as u128 / whole as u128).unwrap_or(amount)
}

impl Meter {
    /// The meter that keeps its place in `path`. A file that cannot be read starts it anew.
    pub fn load(path: PathBuf) -> Self {
        let stored = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
            .filter(|stored| stored.version == 1);
        if stored.is_none() && path.exists() {
            crate::timing::emit_event(json!({"event": "usage_state_unreadable"}));
        }
        Self {
            path,
            databases: Mutex::new(stored.map(|stored| stored.databases).unwrap_or_default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Entry>> {
        self.databases
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The database starts (`on`) or stops being served at `at`.
    pub fn awake(&self, database: &str, on: bool, at: i64) {
        self.lock()
            .entry(database.to_string())
            .or_insert_with(|| Entry::new(at))
            .set_awake(on, at);
    }

    /// Every database the meter keeps a place for.
    pub fn databases(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }

    /// Closes the interval of every database at `now` and hands its rows to `deliver`; only when
    /// that succeeds do the intervals move on, so that a row the outbox refused is made again
    /// longer. `served` are the databases the core serves now, and `readings` are the gateway's
    /// counters now (`None`: it has none to give). A database that is neither served nor in `known`
    /// is gone, and its place goes with this tick.
    pub fn tick(
        &self,
        now: i64,
        served: &HashSet<String>,
        known: &HashSet<String>,
        readings: &BTreeMap<String, Option<Counters>>,
        deliver: impl FnOnce(&[Value]) -> Result<(), Error>,
    ) -> Result<usize, Error> {
        let mut databases = self.lock();
        let mut next = databases.clone();
        // Every database the core knows is read from now on, asleep or not: the reading before a
        // wake is what the traffic of the wake is counted from.
        for database in served.iter().chain(known) {
            next.entry(database.clone())
                .or_insert_with(|| Entry::new(now));
        }
        let mut rows = Vec::new();
        for (database, entry) in &mut next {
            // The core is the truth, whatever it told in between.
            entry.set_awake(served.contains(database), now);
            let reading = readings.get(database).cloned().flatten();
            rows.extend(entry.rows(database, now, reading.as_ref()));
            entry.from_ms = now.max(entry.from_ms);
            entry.counters = reading;
            entry.ended.clear();
        }
        next.retain(|database, entry| {
            served.contains(database) || known.contains(database) || entry.awake_since.is_some()
        });
        if !rows.is_empty() {
            deliver(&rows)?;
        }
        *databases = next;
        if let Err(error) = self.persist(&databases) {
            crate::timing::emit_event(json!({
                "event": "usage_state_not_saved", "class": crate::diagnostics::error_code(&error),
            }));
        }
        Ok(rows.len())
    }

    fn persist(&self, databases: &BTreeMap<String, Entry>) -> Result<(), Error> {
        file::create_private_directory(self.path.parent().ok_or("usage file has no directory")?)?;
        let bytes = serde_json::to_vec(&json!({"version": 1, "databases": databases}))?;
        file::write_private(&self.path, &bytes)?;
        Ok(())
    }
}

impl Entry {
    /// The rows of `[from_ms, now)`: one for each UTC hour it touches in which the database was
    /// awake or its counters grew.
    fn rows(&self, database: &str, now: i64, reading: Option<&Counters>) -> Vec<Value> {
        if self.from_ms >= now {
            return Vec::new();
        }
        let parts = fragments(self.from_ms, now);
        // Over more than two hours a counter has no fragment to share between, and is unknown.
        let growth = match (reading, self.counters.as_ref()) {
            (Some(now), Some(before)) if parts.len() <= 2 => now.since(before),
            _ => None,
        };
        let growth = |part: usize, index: usize| {
            growth.map(|growth| match parts.as_slice() {
                [_] => growth[index],
                [first, second] => {
                    let head = first_share(growth[index], *first, *second);
                    if part == 0 {
                        head
                    } else {
                        growth[index] - head
                    }
                }
                _ => unreachable!("growth is unknown over more than two hours"),
            })
        };
        parts
            .iter()
            .enumerate()
            .filter_map(|(part, (start, end))| {
                let awake = self.awake_ms(*start, *end, now);
                let counters: Vec<Option<u64>> = (0..4).map(|index| growth(part, index)).collect();
                let grew = counters.iter().flatten().any(|value| *value > 0);
                (awake > 0 || grew).then(|| {
                    json!({
                        "database": database,
                        "interval_start": timestamp(*start),
                        "interval_end": timestamp(*end),
                        "awake_ms": awake,
                        "ingress_bytes": counters[0],
                        "egress_bytes": counters[1],
                        "connections": counters[2],
                        "connection_ms": counters[3],
                    })
                })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::test_server::tempdir;

    const HOUR: i64 = HOUR_MS;
    /// 2026-10-18T10:00:00Z.
    const T0: i64 = 1_792_317_600_000;

    fn counters(run: &str, ingress: u64, connection_ms: u64) -> Counters {
        Counters {
            run: run.into(),
            since: "2026-10-18T09:00:00.000Z".into(),
            ingress_bytes: ingress,
            egress_bytes: ingress * 2,
            connections: ingress / 10,
            connection_ms,
        }
    }
    fn ids(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }
    fn readings(entries: &[(&str, Option<Counters>)]) -> BTreeMap<String, Option<Counters>> {
        entries
            .iter()
            .map(|(id, c)| (id.to_string(), c.clone()))
            .collect()
    }
    const DB: &str = "aaaaaaaaaaaaaaaaaaaa";

    /// One tick whose rows are kept.
    fn tick(meter: &Meter, now: i64, served: &[&str], reading: Option<Counters>) -> Vec<Value> {
        let mut kept = Vec::new();
        meter
            .tick(
                now,
                &ids(served),
                &ids(&[DB]),
                &readings(&[(DB, reading)]),
                |rows| {
                    kept = rows.to_vec();
                    Ok(())
                },
            )
            .unwrap();
        kept
    }
    fn meter() -> (Meter, crate::link::test_server::TempDir) {
        let directory = tempdir();
        (Meter::load(directory.join("usage.json")), directory)
    }

    #[test]
    fn awake_time_is_exact_to_the_millisecond_and_a_sleeping_database_has_no_row() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], Some(counters("r", 0, 0)));
        meter.awake(DB, true, T0 + 10_000);
        meter.awake(DB, false, T0 + 25_250);
        let rows = tick(&meter, T0 + 60_000, &[], Some(counters("r", 0, 0)));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["awake_ms"], 15_250);
        assert_eq!(rows[0]["interval_start"], timestamp(T0));
        assert_eq!(rows[0]["interval_end"], timestamp(T0 + 60_000));
        // Nothing awake and nothing counted: nothing to say.
        assert!(tick(&meter, T0 + 120_000, &[], Some(counters("r", 0, 0))).is_empty());
    }

    #[test]
    fn a_database_that_runs_across_ticks_is_awake_for_the_whole_of_each() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], None);
        meter.awake(DB, true, T0 + 1_000);
        let first = tick(&meter, T0 + 60_000, &[DB], None);
        let second = tick(&meter, T0 + 120_000, &[DB], None);
        assert_eq!(first[0]["awake_ms"], 59_000);
        assert_eq!(second[0]["awake_ms"], 60_000);
        assert_eq!(second[0]["interval_start"], first[0]["interval_end"]);
    }

    #[test]
    fn a_tick_checks_the_meter_against_the_core() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], None);
        // The core never told the meter that the database woke; the tick sees it served.
        let woke = tick(&meter, T0 + 60_000, &[DB], None);
        assert!(woke.is_empty(), "from the tick on, never before: {woke:?}");
        let ran = tick(&meter, T0 + 120_000, &[DB], None);
        assert_eq!(ran[0]["awake_ms"], 60_000);
        // And the core says it sleeps although the meter was never told.
        let slept = tick(&meter, T0 + 180_000, &[], None);
        assert_eq!(slept[0]["awake_ms"], 60_000);
        assert!(tick(&meter, T0 + 240_000, &[], None).is_empty());
    }

    #[test]
    fn traffic_is_the_growth_of_the_gateways_counters() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], Some(counters("r", 100, 1_000)));
        let rows = tick(&meter, T0 + 60_000, &[], Some(counters("r", 250, 4_000)));
        assert_eq!(rows.len(), 1, "traffic of a database nobody wakes counts");
        assert_eq!(rows[0]["awake_ms"], 0);
        assert_eq!(rows[0]["ingress_bytes"], 150);
        assert_eq!(rows[0]["egress_bytes"], 300);
        assert_eq!(rows[0]["connections"], 15);
        assert_eq!(rows[0]["connection_ms"], 3_000);
    }

    #[test]
    fn counters_that_cannot_be_compared_are_null_and_never_zero() {
        let (meter, _directory) = meter();
        meter.awake(DB, true, T0);
        // No reading before: the first interval has awake time and no traffic figure.
        let first = tick(&meter, T0 + 60_000, &[DB], Some(counters("r", 100, 10)));
        assert_eq!(first[0]["awake_ms"], 60_000);
        for key in [
            "ingress_bytes",
            "egress_bytes",
            "connections",
            "connection_ms",
        ] {
            assert!(first[0][key].is_null(), "{key}");
        }
        // The gateway restarted: another run.
        let restarted = tick(&meter, T0 + 120_000, &[DB], Some(counters("other", 5, 1)));
        assert!(restarted[0]["ingress_bytes"].is_null());
        // A counter that went back.
        let back = tick(&meter, T0 + 180_000, &[DB], Some(counters("other", 1, 1)));
        for key in [
            "ingress_bytes",
            "egress_bytes",
            "connections",
            "connection_ms",
        ] {
            assert!(back[0][key].is_null(), "{key}");
        }
        // The gateway did not answer.
        let silent = tick(&meter, T0 + 240_000, &[DB], None);
        assert!(silent[0]["ingress_bytes"].is_null());
        // And the next interval has no reading to start from either.
        let after = tick(&meter, T0 + 300_000, &[DB], Some(counters("other", 50, 5)));
        assert!(after[0]["ingress_bytes"].is_null());
        // The one after is known again.
        let known = tick(&meter, T0 + 360_000, &[DB], Some(counters("other", 60, 6)));
        assert_eq!(known[0]["ingress_bytes"], 10);
    }

    #[test]
    fn a_tick_over_an_hour_boundary_is_two_rows_that_add_up() {
        let (meter, _directory) = meter();
        let before = T0 + HOUR - 20_000;
        tick(&meter, before, &[], Some(counters("r", 0, 0)));
        meter.awake(DB, true, T0 + HOUR - 5_000);
        let rows = tick(&meter, before + 60_000, &[DB], Some(counters("r", 101, 41)));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["interval_end"], timestamp(T0 + HOUR));
        assert_eq!(rows[1]["interval_start"], timestamp(T0 + HOUR));
        assert_eq!(rows[0]["awake_ms"], 5_000);
        assert_eq!(rows[1]["awake_ms"], 40_000);
        // 20 s of the 60 s fell in the first hour: a third, rounded down, and the rest.
        for (key, total) in [("ingress_bytes", 101u64), ("connection_ms", 41)] {
            let (a, b) = (
                rows[0][key].as_u64().unwrap(),
                rows[1][key].as_u64().unwrap(),
            );
            assert_eq!(a + b, total, "{key}");
            assert_eq!(a, total / 3, "{key}");
        }
        for row in &rows {
            assert!(
                crate::node_link::schema_valid("NodeUsageReport", &json!({"rows": [row]})),
                "{row}"
            );
        }
    }

    #[test]
    fn a_gap_of_more_than_two_hours_has_exact_awake_time_and_unknown_traffic() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], Some(counters("r", 0, 0)));
        meter.awake(DB, true, T0);
        let rows = tick(
            &meter,
            T0 + 2 * HOUR + 30 * 60_000,
            &[DB],
            Some(counters("r", 9, 9)),
        );
        assert_eq!(rows.len(), 3);
        let awake: Vec<i64> = rows
            .iter()
            .map(|r| r["awake_ms"].as_i64().unwrap())
            .collect();
        assert_eq!(awake, [HOUR, HOUR, 30 * 60_000]);
        assert!(rows.iter().all(|row| row["ingress_bytes"].is_null()));
    }

    #[test]
    fn rows_the_outbox_refused_are_made_again_longer() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], None);
        meter.awake(DB, true, T0);
        let refused = meter.tick(
            T0 + 60_000,
            &ids(&[DB]),
            &ids(&[DB]),
            &readings(&[(DB, None)]),
            |_| Err("usage outbox full".into()),
        );
        assert!(refused.is_err());
        let rows = tick(&meter, T0 + 120_000, &[DB], None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["interval_start"], timestamp(T0));
        assert_eq!(rows[0]["awake_ms"], 120_000);
    }

    #[test]
    fn a_restart_of_the_agent_continues_the_intervals_of_a_database_that_ran_on() {
        let directory = tempdir();
        let path = directory.join("usage.json");
        let meter = Meter::load(path.clone());
        tick(&meter, T0, &[], Some(counters("r", 0, 0)));
        meter.awake(DB, true, T0 + 5_000);
        tick(&meter, T0 + 60_000, &[DB], Some(counters("r", 10, 10)));
        drop(meter);

        let meter = Meter::load(path);
        // The agent was away for a minute; the database ran on, and the traffic is known.
        let rows = tick(&meter, T0 + 120_000, &[DB], Some(counters("r", 30, 20)));
        assert_eq!(rows[0]["interval_start"], timestamp(T0 + 60_000));
        assert_eq!(rows[0]["awake_ms"], 60_000);
        assert_eq!(rows[0]["ingress_bytes"], 20);
    }

    #[test]
    fn a_database_that_is_gone_leaves_its_last_interval_and_then_its_place() {
        let (meter, _directory) = meter();
        tick(&meter, T0, &[], None);
        meter.awake(DB, true, T0);
        meter.awake(DB, false, T0 + 30_000);
        let mut kept = Vec::new();
        meter
            .tick(T0 + 60_000, &ids(&[]), &ids(&[]), &readings(&[]), |rows| {
                kept = rows.to_vec();
                Ok(())
            })
            .unwrap();
        assert_eq!(kept[0]["awake_ms"], 30_000);
        assert!(meter.databases().is_empty());
    }

    #[test]
    fn a_report_of_the_gateway_is_counters_only_when_it_has_a_history() {
        let activity = |history: &str, last: Option<i64>, since: Option<&str>| Activity {
            last_activity_ms: last,
            connections: 0,
            busy_connections: 0,
            pending_dials: 0,
            ingress_bytes: Some(1),
            egress_bytes: Some(2),
            total_connections: Some(3),
            connection_milliseconds: Some(4),
            epoch: "run".into(),
            counters_since: since.map(String::from),
            history: history.into(),
        };
        let since = Some("2026-10-18T09:00:00.000Z");
        assert!(Counters::of(&activity("complete", Some(5), since)).is_some());
        assert!(Counters::of(&activity("current_process_absence", None, since)).is_some());
        assert!(Counters::of(&activity("complete", None, since)).is_none());
        assert!(Counters::of(&activity("partial", Some(5), since)).is_none());
        assert!(Counters::of(&activity("unavailable", None, None)).is_none());
        assert!(Counters::of(&activity("complete", Some(5), None)).is_none());
    }
}
