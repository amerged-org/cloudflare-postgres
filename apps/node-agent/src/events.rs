// SPDX-License-Identifier: Apache-2.0
//! The agent's log lines that travel to Cloudflare (`NodeReportEvent`, ULTRA plan 9.9). A node has
//! no shell and no journal over the link, so `timing::emit_event` also keeps each line in a bounded
//! ring, reduced to what the contract allows: the event's name, its database, and fields that are
//! numbers or short tokens. Error text, paths, dotted-quad and colon address forms and anything
//! else the contract refuses is dropped; what the contract accepts is the call sites' to keep
//! clean (class codes, IDs, numbers). The next observation report carries the ring, and a report
//! that was not accepted gives its events back. A node whose databases do not change has no
//! observation to carry them: the ring wakes the report loop, which posts the events alone, but
//! not more often than `ALONE_EVERY`.
use crate::{archive::facts, node_link::constant};
use serde_json::{Map, Value, json};
use std::{
    collections::VecDeque,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

/// A report of events alone goes out at most this often. Events that wait for the window leave
/// with it, or with the next observation report if that comes first.
pub(crate) const ALONE_EVERY: Duration = Duration::from_secs(1);

/// The events waiting for the next report, oldest first. A full ring drops its oldest event: a
/// node that cannot report keeps its newest.
pub(crate) struct Ring {
    events: VecDeque<Value>,
    /// When a report of events alone last took events.
    alone_at: Option<Instant>,
}
impl Ring {
    pub(crate) const fn new() -> Self {
        Self {
            events: VecDeque::new(),
            alone_at: None,
        }
    }

    /// What one report carries (`NODE_REPORT_EVENTS_MAX`).
    fn capacity() -> usize {
        constant("NODE_REPORT_EVENTS_MAX")
            .as_u64()
            .expect("generated bound") as usize
    }

    fn trim(&mut self) {
        let excess = self.events.len().saturating_sub(Self::capacity());
        self.events.drain(..excess);
    }

    pub(crate) fn push(&mut self, event: Value) {
        self.events.push_back(event);
        self.trim();
    }

    /// How long until the events may leave in a report of their own: `None` while there are
    /// none, zero when they may go now.
    fn alone_in(&self, now: Instant, every: Duration) -> Option<Duration> {
        (!self.events.is_empty()).then(|| {
            self.alone_at.map_or(Duration::ZERO, |at| {
                (at + every).saturating_duration_since(now)
            })
        })
    }

    /// Whether the events may leave in a report of their own now; if so, the window starts.
    fn allow_alone(&mut self, now: Instant, every: Duration) -> bool {
        let due = self.alone_in(now, every) == Some(Duration::ZERO);
        if due {
            self.alone_at = Some(now);
        }
        due
    }

    /// Moves the ring's events into the report, if there are any.
    pub(crate) fn attach(&mut self, report: &mut Value) {
        if !self.events.is_empty() {
            report["events"] = Value::Array(self.events.drain(..).collect());
        }
    }

    /// Puts the events of a report that was not accepted back in front of the newer ones.
    pub(crate) fn give_back(&mut self, report: &Value) {
        let returned = report["events"].as_array().into_iter().flatten().cloned();
        self.events = returned.chain(self.events.drain(..)).collect();
        self.trim();
    }
}

/// The ring, and what wakes the report loop when an event enters it.
pub(crate) struct Events {
    ring: Mutex<Ring>,
    arrived: Notify,
    /// How often a report of events alone may go.
    every: Duration,
}
impl Events {
    pub(crate) const fn new(every: Duration) -> Self {
        Self {
            ring: Mutex::new(Ring::new()),
            arrived: Notify::const_new(),
            every,
        }
    }
    fn ring(&self) -> MutexGuard<'_, Ring> {
        self.ring.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keeps `line`, a line of the agent's log, for the next report, as far as the contract
    /// allows.
    pub(crate) fn record(&self, line: &Value) {
        let at = facts::timestamp(crate::agent::now_ms());
        if let Some(event) = sanitize(line, &at) {
            self.ring().push(event);
            self.arrived.notify_one();
        }
    }

    /// Adds the waiting events to a report that is about to be posted. A report of events alone
    /// (`alone`) takes them only when its window is open; otherwise it is left without events.
    pub(crate) fn attach(&self, report: &mut Value, alone: bool) {
        let mut ring = self.ring();
        if alone && !ring.allow_alone(Instant::now(), self.every) {
            return;
        }
        ring.attach(report);
    }

    /// Returns the events of a report whose post failed.
    pub(crate) fn give_back(&self, report: &Value) {
        self.ring().give_back(report);
    }

    /// Resolves when events wait that a report of their own may carry now.
    pub(crate) async fn due(&self) {
        loop {
            // `notify_one` keeps its permit when nobody waits, so an event that enters between the
            // read and the wait ends the wait at once.
            let left = self.ring().alone_in(Instant::now(), self.every);
            match left {
                Some(Duration::ZERO) => return,
                Some(left) => tokio::time::sleep(left).await,
                None => self.arrived.notified().await,
            }
        }
    }
}

static EVENTS: Events = Events::new(ALONE_EVERY);
/// The agent's own ring, which `timing::emit_event` fills.
pub(crate) fn global() -> &'static Events {
    &EVENTS
}

/// Keeps `line`, a line of the agent's log, for the next report, as far as the contract allows.
pub(crate) fn record(line: &Value) {
    EVENTS.record(line);
}

/// The event of a log line, or `None` for a line without a valid name. Its fields are those of
/// the line whose names and values the contract allows, at most `NODE_REPORT_EVENT_FIELDS_MAX`.
pub(crate) fn sanitize(line: &Value, at: &str) -> Option<Value> {
    let line = line.as_object()?;
    let name = line.get("event")?.as_str().filter(|n| snake(n, 48))?;
    let fields_max = constant("NODE_REPORT_EVENT_FIELDS_MAX")
        .as_u64()
        .expect("generated bound") as usize;
    let mut event = json!({"at": at, "event": name});
    let mut fields = Map::new();
    for (key, value) in line {
        if key == "event" {
            continue;
        }
        if key == "database_id" {
            if let Some(id) = value
                .as_str()
                .filter(|id| pgcf_native_protocol::valid_pattern("database", id))
            {
                event["database_id"] = id.into();
            }
        } else if fields.len() < fields_max && snake(key, 32) && allowed(value) {
            fields.insert(key.clone(), value.clone());
        }
    }
    event["fields"] = fields.into();
    Some(event)
}

/// `^[a-z0-9_]{1,max}$`.
fn snake(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len())
        && text
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// A field value the contract takes: a number, or `^[a-z0-9_.:-]{1,64}$` that is no address. The
/// pattern lets both kinds of IP address through, so they are refused here.
fn allowed(value: &Value) -> bool {
    match value {
        Value::Number(_) => true,
        Value::String(text) => {
            (1..=64).contains(&text.len())
                && text
                    .bytes()
                    .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b':' | b'-'))
                && !address(text)
        }
        _ => false,
    }
}

/// Whether `text` holds an IPv4 address (four dotted numbers, with a port or not) or an IPv6
/// one (two colons).
fn address(text: &str) -> bool {
    text.matches(':').count() >= 2
        || text
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .any(|run| run.split('.').filter(|number| !number.is_empty()).count() >= 4)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node_link::contract_valid;
    use std::sync::Arc;

    const AT: &str = "2026-10-18T10:11:12.345Z";
    const DATABASE: &str = "abcdefghijklmnopqrst";

    fn event(name: &str, n: u64) -> Value {
        json!({"at": AT, "event": name, "fields": {"n": n}})
    }
    /// A report as Cloudflare would see it.
    fn report_of(events: Vec<Value>) -> Value {
        let mut report = json!({"observed_at": AT, "databases": [], "orders": []});
        report["events"] = events.into();
        report
    }
    fn names(report: &Value) -> Vec<(String, u64)> {
        report["events"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| {
                (
                    e["event"].as_str().unwrap().to_string(),
                    e["fields"]["n"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn a_full_ring_drops_its_oldest_event_and_keeps_the_order() {
        let max = Ring::capacity() as u64;
        let mut ring = Ring::new();
        for n in 0..max + 6 {
            ring.push(event("tick", n));
        }
        let mut report = json!({});
        ring.attach(&mut report);
        let seen: Vec<u64> = names(&report).iter().map(|(_, n)| *n).collect();
        assert_eq!(seen, (6..max + 6).collect::<Vec<_>>());
        // Attached events are gone from the ring, and an empty ring adds no key.
        let mut again = json!({});
        ring.attach(&mut again);
        assert!(again.get("events").is_none());
    }

    #[test]
    fn events_of_a_report_that_was_not_accepted_return_in_front_of_newer_ones_within_the_bound() {
        let max = Ring::capacity() as u64;
        let mut ring = Ring::new();
        ring.push(event("a", 1));
        ring.push(event("b", 2));
        let mut report = json!({});
        ring.attach(&mut report);
        ring.push(event("c", 3));
        ring.give_back(&report);
        let mut next = json!({});
        ring.attach(&mut next);
        assert_eq!(
            names(&next),
            [("a".into(), 1), ("b".into(), 2), ("c".into(), 3)]
        );
        // Returned events never lift the ring over its bound: the oldest go first.
        ring.give_back(&next);
        for n in 10..10 + max {
            ring.push(event("d", n));
        }
        let mut full = json!({});
        ring.attach(&mut full);
        assert_eq!(names(&full).len() as u64, max);
        assert_eq!(names(&full).first(), Some(&("d".into(), 10)));
    }

    #[test]
    fn events_alone_go_once_per_window_and_the_next_ones_wait_for_it() {
        let every = Duration::from_secs(1);
        let start = Instant::now();
        let mut ring = Ring::new();
        // Nothing waits: nothing is due and nothing goes.
        assert_eq!(ring.alone_in(start, every), None);
        assert!(!ring.allow_alone(start, every));
        ring.push(event("a", 1));
        assert_eq!(ring.alone_in(start, every), Some(Duration::ZERO));
        assert!(ring.allow_alone(start, every));
        // Events after that wait out the window since the report that took the first.
        ring.push(event("b", 2));
        let early = start + Duration::from_millis(400);
        assert_eq!(
            ring.alone_in(early, every),
            Some(Duration::from_millis(600))
        );
        assert!(!ring.allow_alone(early, every));
        assert!(ring.allow_alone(start + every, every));
    }

    #[tokio::test(start_paused = true)]
    async fn an_event_wakes_the_loop_that_waits_for_events_and_a_window_holds_the_next_ones() {
        let events = Arc::new(Events::new(Duration::from_secs(1)));
        let line = |n: u64| json!({"event": "tick", "n": n});
        // Nothing waits: the loop sleeps for good.
        assert!(
            tokio::time::timeout(Duration::from_secs(60), events.due())
                .await
                .is_err()
        );
        // The first event wakes a loop that is asleep.
        let waiting = tokio::spawn({
            let events = events.clone();
            async move { events.due().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        events.record(&line(1));
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("the event wakes the loop")
            .unwrap();
        // The report that takes it opens the window: the next event wakes nothing before it ends.
        let mut report = json!({});
        events.attach(&mut report, true);
        assert_eq!(names(&report).len(), 1);
        events.record(&line(2));
        assert!(
            tokio::time::timeout(Duration::from_millis(900), events.due())
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_millis(200), events.due())
            .await
            .expect("the window ended");
    }

    #[test]
    fn a_log_line_keeps_its_name_database_numbers_and_short_tokens() {
        let line = json!({
            "event": "mount_failed", "database_id": DATABASE, "class": "io_not_found",
            "elapsed_ms": 61, "ratio": 0.5, "release": "rel_2026-10-18.1",
        });
        let event = sanitize(&line, AT).unwrap();
        assert_eq!(
            event,
            json!({
                "at": AT, "event": "mount_failed", "database_id": DATABASE,
                "fields": {
                    "class": "io_not_found", "elapsed_ms": 61, "ratio": 0.5,
                    "release": "rel_2026-10-18.1",
                },
            })
        );
        assert!(contract_valid(
            "NodeObservationReport",
            &report_of(vec![event])
        ));
        // A line with no database has none in its event, and no fields is an empty record.
        let bare = sanitize(&json!({"event": "agent_restarting"}), AT).unwrap();
        assert_eq!(
            bare,
            json!({"at": AT, "event": "agent_restarting", "fields": {}})
        );
    }

    #[test]
    fn what_could_carry_text_a_path_or_an_address_is_dropped() {
        let line = json!({
            "event": "build_failed", "database_id": DATABASE, "class": "build_failed",
            "error": "connection to 10.0.0.12:5432 refused",
            "stderr": "ERROR: role \"app\" does not exist",
            "file": "/var/lib/pgcf/data/000000010000000000000002",
            "peer": "10.0.0.12", "peer_port": "10.0.0.12:5432", "v6": "fe80::1", "loopback": "::1",
            "exit": "Exited(1)", "Upper": "x", "empty": "", "long": "a".repeat(65),
            "nested": {"a": 1}, "list": [1], "flag": true, "nothing": null,
            "version": "1.2.3", "host": "pgcf-eu1.example",
        });
        let event = sanitize(&line, AT).unwrap();
        assert_eq!(
            event["fields"],
            json!({"class": "build_failed", "version": "1.2.3", "host": "pgcf-eu1.example"})
        );
        assert_eq!(event["database_id"], DATABASE);
        assert!(contract_valid(
            "NodeObservationReport",
            &report_of(vec![event])
        ));
        // A database that is no database ID is not named.
        let unnamed = sanitize(&json!({"event": "x", "database_id": "not an id"}), AT).unwrap();
        assert!(unnamed.get("database_id").is_none());
    }

    #[test]
    fn a_line_without_a_valid_event_name_is_dropped_and_the_fields_stay_within_their_bound() {
        for line in [
            json!({"class": "x"}),
            json!({"event": 1}),
            json!({"event": "Wake"}),
            json!({"event": "has space"}),
            json!({"event": "a".repeat(49)}),
            json!("event"),
        ] {
            assert_eq!(sanitize(&line, AT), None, "{line}");
        }
        let mut many = json!({"event": "many"});
        for n in 0..40 {
            many[format!("f{n}")] = n.into();
        }
        let event = sanitize(&many, AT).unwrap();
        assert_eq!(event["fields"].as_object().unwrap().len(), 16);
        assert!(contract_valid(
            "NodeObservationReport",
            &report_of(vec![event])
        ));
    }
}
