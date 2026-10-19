// SPDX-License-Identifier: Apache-2.0
//! What the core tells Cloudflare (`NodeObservationReport`, `NodeEvent`; plan 4.9, 9.9): the state
//! of each database it changed, how the orders ended, and the decisions the node took.
use super::{Core, Db, Phase, View};
use crate::{
    Error,
    api::Refusal,
    archive::facts::{self, ArchiveState},
    events::Events,
    machine::Machine,
    node_link::constant,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::PoisonError,
};

/// The most databases one report carries; the contract allows 200 (`NODE_DESIRED_PAGE_LIMIT_MAX`).
/// The API takes 8 at a time (`OBSERVATION_CONCURRENCY`). A database usually costs it 0.25 to 1.1 s
/// (D1 about 45 ms and the Actor's publish, which it waits for 1 s at most: measured on EU1 with
/// 235 databases). That is the typical cost, not a bound: a change of the runtime, an idle sleep
/// and a refused sleep wait for their publish with no limit of 1 s. At the typical cost a batch of
/// 64 needs 64 / 8 x 1.1 s = 8.8 s, inside the API's 12 s budget and less than half of the 20 s a
/// request may take (`REQUEST_TIMEOUT`). A batch that takes longer is refused (503) or times out,
/// and the next one is half as large (`too_big`). Taken one by one, 200 databases needed 59 to
/// 209 s. 64 is a power of two: six halvings reach 1.
pub(crate) const DATABASES_PER_REPORT: usize = 64;
/// The most orders one report carries (`NODE_ORDER_LIMIT`).
const ORDERS_PER_REPORT: usize = 1000;
/// The most databases the anti-entropy queues in one minute: one report. A node whose databases do
/// not fit its period at this rate says them again later, the one longest unsaid first, never
/// faster than the period; at 15 minutes it holds 960 databases.
const RESENT_PER_MINUTE: usize = DATABASES_PER_REPORT;

/// What the API stores of an observation (`applyObservation`, `archiveHealth`), which is all that
/// Cloudflare can learn from it: the archive's last segment and the number of its files waiting
/// are not stored, only whether the files are known and since when the archive fails. Two
/// observations of the same stored form say the same to Cloudflare.
fn stored(observation: &Value) -> Value {
    let archive = &observation["archive"];
    let mut stored = observation.clone();
    stored["archive"] = json!({
        "failing_since": archive["failing_since"],
        "ready_files_known": !archive["ready_files"].is_null(),
    });
    stored
}

/// What the API holds of a database: the stored form of the observation it last accepted (a 200
/// answer with the verdict `accept` for that database), and when it accepted it.
struct Held {
    stored: Value,
    at_ms: i64,
}

/// Where in the anti-entropy period the identifier of a database fixes its turn, in milliseconds.
/// The databases of a node are spread over the period by their identifiers, so that they never
/// come in one minute, whatever moment the node began to say them.
fn turn(database: &str, period_ms: i64) -> i64 {
    let digest = Sha256::digest(database.as_bytes());
    let hash = u64::from_be_bytes(digest[..8].try_into().expect("eight bytes"));
    i64::try_from(hash % u64::try_from(period_ms).expect("a positive period")).expect("a period")
}
/// The period `at_ms` falls in, counted from the turn of the database.
fn period_of(database: &str, at_ms: i64, period_ms: i64) -> i64 {
    (at_ms - turn(database, period_ms)).div_euclid(period_ms)
}
/// The anti-entropy period (`NODE_OBSERVATION_RESEND_MS`).
fn resend_period_ms() -> i64 {
    constant("NODE_OBSERVATION_RESEND_MS")
        .as_i64()
        .expect("generated period")
}

pub(crate) struct Reports {
    /// The newest observation of each database that is not what the API holds: the ones that
    /// changed, the ones it did not accept, and the ones the anti-entropy asks for.
    observations: BTreeMap<String, Value>,
    /// What the API accepted of each database since the agent started. Nothing is held at the
    /// start, so the first pull says every database once.
    held: HashMap<String, Held>,
    /// How the orders ended, until Cloudflare answered.
    orders: BTreeMap<String, Value>,
    /// Events not yet queued for delivery.
    events: Vec<Value>,
    /// How many databases the next report carries: `DATABASES_PER_REPORT`, halved by each post that
    /// was too big, until one goes through.
    limit: usize,
}
impl Default for Reports {
    fn default() -> Self {
        Self {
            observations: BTreeMap::new(),
            held: HashMap::new(),
            orders: BTreeMap::new(),
            events: Vec::new(),
            limit: DATABASES_PER_REPORT,
        }
    }
}
impl Reports {
    /// Drops the observations of what the API holds: one of the stored form of the last that it
    /// accepted says nothing new.
    fn forget_held(&mut self) {
        let held = &self.held;
        self.observations.retain(|id, observation| {
            held.get(id)
                .is_none_or(|held| held.stored != stored(observation))
        });
    }
    /// The API accepted these databases of `report`: it holds them from `at_ms`.
    fn accepted(&mut self, report: &Value, accepted: &[String], at_ms: i64) {
        let accepted: HashSet<&str> = accepted.iter().map(String::as_str).collect();
        for observation in report["databases"].as_array().into_iter().flatten() {
            if let Some(id) = observation["id"].as_str()
                && accepted.contains(id)
            {
                self.held.insert(
                    id.to_string(),
                    Held {
                        stored: stored(observation),
                        at_ms,
                    },
                );
            }
        }
    }
    /// The databases whose turn in the anti-entropy period has come since the API accepted them,
    /// at most `RESENT_PER_MINUTE`, the one it accepted longest ago first. The first turn of a
    /// database after the agent started is within one period; the next is one period later.
    fn due(&self, now_ms: i64, period_ms: i64) -> Vec<String> {
        let mut due: Vec<(&String, i64)> = self
            .held
            .iter()
            .filter(|(id, held)| {
                period_of(id, now_ms, period_ms) != period_of(id, held.at_ms, period_ms)
            })
            .map(|(id, held)| (id, held.at_ms))
            .collect();
        due.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
        due.into_iter()
            .take(RESENT_PER_MINUTE)
            .map(|(id, _)| id.clone())
            .collect()
    }
    /// The next batch of observations, at most `limit` of them: what is not asleep goes first (a
    /// database that became ready, failed or was deleted is what Cloudflare waits for), then the
    /// asleep ones, each group in the order of the database IDs.
    fn take_databases(&mut self) -> Vec<Value> {
        let mut ids: Vec<&String> = self.observations.keys().collect();
        // The sort is stable and the keys come in order, so each group keeps the order of its keys.
        ids.sort_by_key(|id| self.observations[*id]["state"] == "asleep");
        let ids: Vec<String> = ids.into_iter().take(self.limit).cloned().collect();
        ids.iter()
            .filter_map(|id| self.observations.remove(id))
            .collect()
    }
    /// A post carried its batch: the next one is whole again.
    fn posted(&mut self) {
        self.limit = DATABASES_PER_REPORT;
    }
    /// A post was too big for Cloudflare: the next batch is half as large, down to one database.
    fn too_big(&mut self) {
        self.limit = (self.limit / 2).max(1);
    }
}

/// Whether a failed post says its batch did not fit Cloudflare's time: the request timed out, or
/// the API answered with a server error (it answers 503 when the report outlasted its budget).
pub(crate) fn too_big(error: &Error) -> bool {
    crate::diagnostics::error_code(error) == "http_timeout"
        || error
            .downcast_ref::<Refusal>()
            .is_some_and(|refusal| refusal.status >= 500)
}

/// A random UUID (version 4), the identifier of an event.
pub(crate) fn uuid() -> String {
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system's random source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

impl<M: Machine> Core<M> {
    /// The observation of a database as its view and its disk say it, or `None` while it has none
    /// to give: the page has not named it, a wake is under way, or the unit of a ready database is
    /// not known.
    fn observe(&self, db: &Db, view: &View) -> Option<Value> {
        let entry = view.entry.as_ref()?;
        let (state, error) = match view.phase {
            Phase::Building => ("building", None),
            Phase::Ready | Phase::Quiesce => ("ready", None),
            Phase::Asleep if view.state.as_ref()?.record.is_some() => ("asleep", None),
            Phase::Asleep | Phase::Unproven => ("unproven", None),
            Phase::Error => ("error", Some(view.error.unwrap_or("build_failed"))),
            Phase::Deleted => ("deleted", None),
            // A wake under way and a retired generation have nothing to report.
            Phase::Starting | Phase::Retired => return None,
        };
        let stored = view.state.as_ref();
        let storage_generation = stored.map_or(entry.storage_generation, |s| s.storage_generation);
        let (generation, operation) = match &view.claim {
            Some(claim) => (claim.generation, claim.operation.clone()),
            None => (entry.generation, entry.operation.clone()),
        };
        let files = self.files(&db.id);
        let upload_log = files.upload_log(storage_generation);
        let data = self.layout().data(&db.id);
        let ready = facts::ready_files(&data).ok();
        let archive = facts::archive_facts(&ArchiveState {
            now_ms: super::now_ms(),
            last_segment: upload_log.last_segment().ok().flatten().as_deref(),
            ready: ready.as_deref(),
            failing_since_ms: self.table.failing_since_ms(&db.id),
        });
        let mut observation = json!({
            "id": db.id,
            "generation": generation,
            "operation": operation,
            "storage_generation": storage_generation,
            "state": state,
            "proven_sleep": match (state, stored.and_then(|s| s.record.as_ref())) {
                ("asleep", Some(record)) => record.observation(),
                _ => Value::Null,
            },
            "backup": stored.and_then(|s| s.backup.as_ref()).map_or(Value::Null, |b| b.observation()),
            "archive": archive.observation(),
        });
        if let Some(error) = error {
            observation["error"] = error.into();
        }
        if state == "ready" {
            // The route names the unit (`UnitWriter.instance`), so Cloudflare learns it here. A ready
            // database whose unit the node does not know has nothing to report.
            observation["instance"] = view.writer.as_ref()?.instance.clone().into();
            if let Some(refusal) = view.refusal {
                observation["refusal"] = refusal.into();
            }
        }
        if state == "ready" && !(view.roles_removed.is_empty() && view.roles_blocked.is_empty()) {
            observation["roles"] =
                json!({"removed": view.roles_removed, "blocked": view.roles_blocked});
        }
        Some(observation)
    }

    /// `NodeSample.archive`: the WAL files waiting for archive on the node, and the age of the
    /// oldest. Unknown if the files of any database that holds volume cannot be read.
    pub fn archive_summary(&self) -> Value {
        let now_ms = super::now_ms();
        let facts: Vec<facts::ArchiveFacts> = self
            .all()
            .iter()
            .filter_map(|db| {
                let view = db.view();
                if !matches!(
                    view.phase,
                    Phase::Ready
                        | Phase::Quiesce
                        | Phase::Asleep
                        | Phase::Unproven
                        | Phase::Starting
                ) {
                    return None;
                }
                let generation = view.state.as_ref()?.storage_generation;
                drop(view);
                let log = self.files(&db.id).upload_log(generation);
                let ready = facts::ready_files(&self.layout().data(&db.id)).ok();
                Some(facts::archive_facts(&ArchiveState {
                    now_ms,
                    last_segment: log.last_segment().ok().flatten().as_deref(),
                    ready: ready.as_deref(),
                    failing_since_ms: self.table.failing_since_ms(&db.id),
                }))
            })
            .collect();
        facts::node_archive(&facts)
    }

    /// Queues the database's observation for Cloudflare. What the API holds of it is not sent
    /// again (`take_report`), except while Cloudflare waits for the database: an entry with an
    /// origin (a build, a restore or a move target) or a move order that holds it. The API's
    /// create, restore and move steps wait for the next report that names such a database, so
    /// every pull says it, as it did before the anti-entropy.
    pub(crate) fn report(&self, db: &Db) {
        let (observation, awaited) = {
            let view = db.view();
            let awaited = view.moving.is_some()
                || view
                    .entry
                    .as_ref()
                    .is_some_and(|entry| entry.origin.is_some());
            (self.observe(db, &view), awaited)
        };
        if let Some(observation) = observation {
            let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
            if awaited {
                reports.held.remove(&db.id);
            }
            reports.observations.insert(db.id.clone(), observation);
            drop(reports);
            self.changed.notify_one();
        }
    }

    /// The anti-entropy (`NODE_OBSERVATION_RESEND_MS`): queues the observation of each database
    /// whose turn in the period has come since the API accepted one, at most one report of them
    /// in a minute. Called each minute; a database goes again at its own point of the period,
    /// whatever the moment the agent started at.
    pub(crate) fn resend_due(&self, now_ms: i64) {
        let due = {
            let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
            let due = reports.due(now_ms, resend_period_ms());
            for id in &due {
                reports.held.remove(id);
            }
            due
        };
        for id in due {
            if let Some(db) = self.find(&id) {
                self.report(&db);
            }
        }
    }

    /// Queues how an order ended: `done`, or `failed` with the reason (a lowercase class, and for a
    /// wake the contract's `WAKE_REASONS`).
    pub(crate) fn report_order(&self, operation: &str, result: Result<(), &str>) {
        let result = match result {
            Ok(()) => json!({"operation": operation, "status": "done"}),
            Err(reason) => json!({"operation": operation, "status": "failed", "reason": reason}),
        };
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .orders
            .insert(operation.to_string(), result);
        self.changed.notify_one();
    }

    /// Queues an event (`NodeEvent`) for delivery.
    pub(crate) fn event(&self, event: Value) {
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .events
            .push(event);
        self.changed.notify_one();
    }

    /// The reports waiting to be posted, at most what one request carries, with the events of
    /// `events`; `None` when nothing waits. Events alone are a report of their own (no database,
    /// no order) when their window is open. A report that was not accepted is given back with
    /// `unsent`.
    pub(crate) fn take_report(&self, events: &Events) -> Option<Value> {
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        reports.forget_held();
        let alone = reports.observations.is_empty() && reports.orders.is_empty();
        let databases = reports.take_databases();
        let orders: Vec<String> = reports
            .orders
            .keys()
            .take(ORDERS_PER_REPORT)
            .cloned()
            .collect();
        let mut report = json!({
            "observed_at": facts::timestamp(super::now_ms()),
            "databases": databases,
            "orders": orders
                .iter()
                .filter_map(|operation| reports.orders.remove(operation))
                .collect::<Vec<_>>(),
        });
        // The agent's own log lines ride along, or leave alone.
        events.attach(&mut report, alone);
        (!alone || report.get("events").is_some()).then_some(report)
    }
    /// Cloudflare answered the report: the next one carries a whole batch, and the databases
    /// whose observation it accepted are held (`accepted`, the identifiers of the answer). The
    /// others, `stale` or in `conflict`, are not: the page decides, and the node reports them
    /// again from the next pull of it.
    pub(crate) fn report_posted(&self, report: &Value, accepted: &[String]) {
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        reports.posted();
        reports.accepted(report, accepted, super::now_ms());
    }
    /// The post of a report failed with `error`: if for want of time (`too_big`), the next report
    /// is half as large.
    pub(crate) fn report_failed(&self, error: &Error) {
        if too_big(error) {
            self.reports
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .too_big();
        }
    }
    /// A report that was not accepted: what it holds is posted again, unless something newer
    /// about the same database or order was queued since. Whether Cloudflare applied it is not
    /// known (the answer may be what was lost), so it holds none of its databases: the newest
    /// observation of each is posted.
    pub(crate) fn unsent(&self, events: &Events, report: &Value) {
        events.give_back(report);
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        for observation in report["databases"].as_array().into_iter().flatten() {
            if let Some(id) = observation["id"].as_str() {
                reports.held.remove(id);
                reports
                    .observations
                    .entry(id.to_string())
                    .or_insert_with(|| observation.clone());
            }
        }
        for result in report["orders"].as_array().into_iter().flatten() {
            if let Some(operation) = result["operation"].as_str() {
                reports
                    .orders
                    .entry(operation.to_string())
                    .or_insert_with(|| result.clone());
            }
        }
        drop(reports);
        self.changed.notify_one();
    }
    /// The events queued so far.
    pub fn take_events(&self) -> Vec<Value> {
        std::mem::take(
            &mut self
                .reports
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .events,
        )
    }
    /// The newest observation of a database that has not been posted yet; for tests.
    #[cfg(test)]
    pub(crate) fn pending_observation(&self, id: &str) -> Option<Value> {
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .observations
            .get(id)
            .cloned()
    }
    /// Queues an observation as `report` does, for a test that has no database to observe.
    #[cfg(test)]
    pub(crate) fn queue_observation(&self, observation: Value) {
        let id = observation["id"].as_str().expect("an id").to_string();
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .observations
            .insert(id, observation);
        self.changed.notify_one();
    }
    #[cfg(test)]
    pub(crate) fn pending_order(&self, operation: &str) -> Option<Value> {
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .orders
            .get(operation)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            Reconcile,
            testing::{Rig, eventually},
        },
        node_link::contract_valid,
    };
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_ready_database_names_the_unit_it_runs_and_the_report_is_what_cloudflare_accepts() {
        let Some(rig) = Rig::new("observe-ready").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let instance = db.view().writer.as_ref().unwrap().instance.clone();
        let observation = rig.observation(&entry.id);
        assert_eq!(observation["state"], "ready");
        assert_eq!(observation["instance"], instance);
        let report = json!({
            "observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []
        });
        assert!(contract_valid("NodeObservationReport", &report));
        // The same report without the instance is the one Cloudflare refuses.
        let mut without = report;
        without["databases"][0]
            .as_object_mut()
            .unwrap()
            .remove("instance");
        assert!(!contract_valid("NodeObservationReport", &without));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn events_alone_are_a_report_once_per_window_and_otherwise_ride_with_what_goes() {
        let Some(rig) = Rig::new("report-events").await else {
            return;
        };
        let window = Duration::from_millis(300);
        let events = Events::new(window);
        let line = |name: &str| json!({"event": name, "uptime_s": 12});
        // Nothing to say: no report.
        assert!(rig.core.take_report(&events).is_none());
        // An event alone is a report with no database and no order, which Cloudflare takes.
        events.record(&line("agent_started"));
        let alone = rig.core.take_report(&events).unwrap();
        assert_eq!(alone["databases"], json!([]));
        assert_eq!(alone["orders"], json!([]));
        assert_eq!(alone["events"][0]["event"], "agent_started");
        assert!(contract_valid("NodeObservationReport", &alone));
        // The next one waits for the window, and a report that goes meanwhile takes it along.
        events.record(&line("tick"));
        assert!(rig.core.take_report(&events).is_none());
        rig.core.report_order("op_aaaaaaaaaaaaaaaaaaaa", Ok(()));
        let with_order = rig.core.take_report(&events).unwrap();
        assert_eq!(with_order["orders"].as_array().unwrap().len(), 1);
        assert_eq!(with_order["events"][0]["event"], "tick");
        // A report that was not accepted gives its events back, and they go alone after the window.
        rig.core.unsent(&events, &alone);
        assert!(rig.core.take_report(&events).is_none());
        tokio::time::sleep(window).await;
        let again = rig.core.take_report(&events).unwrap();
        assert_eq!(again["events"], alone["events"]);
        assert_eq!(again["orders"], json!([]));
    }

    fn queued(reports: &mut Reports, id: &str, state: &str) {
        reports
            .observations
            .insert(id.into(), json!({"id": id, "state": state}));
    }
    fn ids(batch: &[Value]) -> Vec<&str> {
        batch.iter().map(|o| o["id"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_report_carries_what_is_not_asleep_first_and_each_group_in_key_order() {
        let mut reports = Reports::default();
        // Asleep databases whose ids sort before the others, and the states that matter more.
        for n in 0..100 {
            queued(&mut reports, &format!("a{n:03}"), "asleep");
        }
        for (id, state) in [
            ("z3", "ready"),
            ("z1", "error"),
            ("z5", "deleted"),
            ("z2", "building"),
            ("z4", "unproven"),
        ] {
            queued(&mut reports, id, state);
        }
        let batch = reports.take_databases();
        assert_eq!(batch.len(), DATABASES_PER_REPORT);
        let ids = ids(&batch);
        assert_eq!(ids[..5], ["z1", "z2", "z3", "z4", "z5"]);
        // The asleep ones follow in key order, as many as fit.
        let rest: Vec<String> = (0..DATABASES_PER_REPORT - 5)
            .map(|n| format!("a{n:03}"))
            .collect();
        assert_eq!(
            ids[5..],
            rest.iter().map(String::as_str).collect::<Vec<_>>()
        );
        // What did not fit waits, and goes next in the same order.
        assert_eq!(reports.observations.len(), 105 - DATABASES_PER_REPORT);
        let next = reports.take_databases();
        assert_eq!(
            ids_of(&next)[0],
            format!("a{:03}", DATABASES_PER_REPORT - 5)
        );
    }
    fn ids_of(batch: &[Value]) -> Vec<String> {
        ids(batch).into_iter().map(str::to_string).collect()
    }

    #[test]
    fn the_batch_halves_after_a_post_that_was_too_big_and_is_whole_again_after_one_that_went() {
        let mut reports = Reports::default();
        for n in 0..1000 {
            queued(&mut reports, &format!("d{n:04}"), "asleep");
        }
        let mut sizes = Vec::new();
        for _ in 0..8 {
            sizes.push(reports.take_databases().len());
            reports.too_big();
        }
        // Down to one and no further.
        assert_eq!(
            sizes,
            [DATABASES_PER_REPORT, 32, 16, 8, 4, 2, 1, 1],
            "the first batch is whole, every later one half of the one before"
        );
        // A post that went brings the whole batch back at once.
        reports.posted();
        assert_eq!(reports.take_databases().len(), DATABASES_PER_REPORT);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_report_that_was_too_big_goes_back_whole_and_the_next_is_half_as_large() {
        let Some(rig) = Rig::new("report-batches").await else {
            return;
        };
        let events = Events::new(Duration::from_secs(60));
        {
            let mut reports = rig.core.reports.lock().unwrap();
            for n in 0..150 {
                queued(&mut reports, &format!("d{n:03}"), "asleep");
            }
            queued(&mut reports, "e000", "ready");
        }
        let first = rig.core.take_report(&events).unwrap();
        let sent = |report: &Value| report["databases"].as_array().unwrap().clone();
        assert_eq!(sent(&first).len(), DATABASES_PER_REPORT);
        assert_eq!(sent(&first)[0]["id"], "e000", "what is not asleep leads");
        // The API ran out of time on it: it is queued again, and the next report is half of it.
        rig.core.unsent(&events, &first);
        let refusal: Error = Box::new(Refusal {
            status: 503,
            code: Some("capacity_exhausted".into()),
        });
        rig.core.report_failed(&refusal);
        let second = rig.core.take_report(&events).unwrap();
        assert_eq!(sent(&second), sent(&first)[..DATABASES_PER_REPORT / 2]);
        // A failure that is no matter of size leaves the size alone; a success restores it.
        rig.core.unsent(&events, &second);
        let unauthorized: Error = Box::new(Refusal {
            status: 401,
            code: None,
        });
        rig.core.report_failed(&unauthorized);
        assert_eq!(
            sent(&rig.core.take_report(&events).unwrap()).len(),
            DATABASES_PER_REPORT / 2
        );
        rig.core.report_posted(&second, &[]);
        assert_eq!(
            sent(&rig.core.take_report(&events).unwrap()).len(),
            DATABASES_PER_REPORT
        );
    }

    #[tokio::test]
    async fn a_timeout_or_a_server_error_is_too_big_and_other_failures_are_not() {
        let refusal = |status| -> crate::Error { Box::new(Refusal { status, code: None }) };
        assert!(too_big(&refusal(503)));
        assert!(too_big(&refusal(500)));
        assert!(!too_big(&refusal(401)));
        assert!(!too_big(&refusal(409)));
        assert!(!too_big(&"node request exceeds bound".into()));
        // A real timeout: a server that accepts the connection and never answers.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let timed_out = reqwest::Client::builder()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap()
            .post(url)
            .send()
            .await
            .unwrap_err();
        assert!(too_big(&timed_out.into()));
        // A refused connection is no size problem.
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", closed.local_addr().unwrap());
        drop(closed);
        let refused = reqwest::Client::new().post(url).send().await.unwrap_err();
        assert!(!too_big(&refused.into()));
    }

    #[test]
    fn an_event_identifier_is_a_version_4_uuid_and_never_repeats() {
        let a = uuid();
        assert!(crate::node_link::schema_valid(
            "NodeEventReport",
            &json!({"events": [{
                "type": "early_sleep", "id": a, "at": "2026-10-18T10:11:12.345Z",
                "database": "aaaaaaaaaaaaaaaaaaaa", "generation": 1,
                "for_database": "bbbbbbbbbbbbbbbbbbbb"}]})
        ));
        assert_eq!(a.as_bytes()[14], b'4');
        assert!(matches!(a.as_bytes()[19], b'8' | b'9' | b'a' | b'b'));
        assert_ne!(a, uuid());
    }

    // ---- what the API holds, and the anti-entropy

    const PERIOD: i64 = 15 * 60_000;
    fn held_at(at_ms: i64) -> Held {
        Held {
            stored: json!({}),
            at_ms,
        }
    }

    #[test]
    fn the_period_is_the_contracts_and_a_database_has_one_turn_in_it_that_its_identifier_fixes() {
        assert_eq!(resend_period_ms(), PERIOD);
        let id = crate::link::test_server::database_id(7);
        assert_eq!(turn(&id, PERIOD), turn(&id, PERIOD));
        assert!((0..PERIOD).contains(&turn(&id, PERIOD)));
        // One period holds one turn: the period of a moment is the one number of the turn's count.
        let at = 1_800_000_000_000;
        assert_eq!(
            period_of(&id, at + PERIOD, PERIOD),
            period_of(&id, at, PERIOD) + 1
        );
        // The databases are spread over the period, not stacked on one point of it.
        let turns: HashSet<i64> = (0..300)
            .map(|n| turn(&crate::link::test_server::database_id(n), PERIOD) / 60_000)
            .collect();
        assert!(turns.len() >= 13, "{} of 15 minutes used", turns.len());
    }

    #[test]
    fn the_anti_entropy_says_each_database_once_in_each_period_at_its_own_turn_and_never_more_than_a_report_in_a_minute()
     {
        let ids: Vec<String> = (0..300)
            .map(crate::link::test_server::database_id)
            .collect();
        let mut reports = Reports::default();
        // The agent starts and the API accepts every database at one moment.
        let start = 1_800_000_000_000;
        for id in &ids {
            reports.held.insert(id.clone(), held_at(start));
        }
        let mut says: HashMap<String, Vec<i64>> = HashMap::new();
        let mut busiest = 0;
        // Each minute for two periods: the databases whose turn has come.
        for minute in 1..=2 * 15 {
            let now = start + minute * 60_000;
            let due = reports.due(now, PERIOD);
            busiest = busiest.max(due.len());
            for id in due {
                reports.held.get_mut(&id).unwrap().at_ms = now;
                says.entry(id).or_default().push(now);
            }
        }
        // Every database was said twice, a whole period apart, and never faster.
        assert_eq!(says.len(), 300);
        for (id, times) in &says {
            assert_eq!(times.len(), 2, "{id}: {times:?}");
            assert_eq!(times[1] - times[0], PERIOD, "{id}");
            assert!(
                times[0] - start <= PERIOD,
                "{id}: the first turn is within a period"
            );
        }
        // They did not come in one minute: the mean is 20 a minute, and no minute had twice that.
        assert!(busiest <= 40, "{busiest} in one minute");
        assert!(busiest <= RESENT_PER_MINUTE);
        // Nothing is due where nothing was accepted: the first pull says every database once.
        assert!(
            Reports::default()
                .due(start + 100 * PERIOD, PERIOD)
                .is_empty()
        );
    }

    #[test]
    fn a_node_with_more_databases_than_its_period_holds_says_a_report_of_them_in_a_minute_the_longest_unsaid_first()
     {
        let mut reports = Reports::default();
        let start = 1_800_000_000_000;
        for n in 0..2000usize {
            reports.held.insert(
                crate::link::test_server::database_id(n),
                held_at(start + i64::try_from(n).unwrap()),
            );
        }
        // A day later every database's turn has come: the 64 accepted longest ago are queued.
        let due = reports.due(start + 24 * 3_600_000, PERIOD);
        assert_eq!(
            due,
            (0..RESENT_PER_MINUTE)
                .map(crate::link::test_server::database_id)
                .collect::<Vec<_>>()
        );
    }

    /// The contract's asleep observation of database `id`.
    fn asleep(id: &str) -> Value {
        let mut observation =
            crate::link::test_server::vector("NodeObservationReport", "asleep")["databases"][0]
                .clone();
        observation["id"] = id.into();
        observation
    }
    fn failing(observation: &Value, since: &str) -> Value {
        let mut changed = observation.clone();
        changed["archive"]["failing_since"] = since.into();
        changed
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn what_the_api_took_is_not_said_again_but_a_report_whose_answer_was_lost_holds_nothing()
    {
        let Some(rig) = Rig::new("report-held").await else {
            return;
        };
        let events = Events::new(Duration::from_secs(60));
        let id = crate::link::test_server::database_id(1);
        let ids = [id.clone()];
        let a = asleep(&id);
        let b = failing(&a, "2026-10-19T10:00:00.000Z");
        // The API takes a; a is not said again, b is.
        rig.core.queue_observation(a.clone());
        let first = rig.core.take_report(&events).unwrap();
        rig.core.report_posted(&first, &ids);
        rig.core.queue_observation(a.clone());
        assert!(rig.core.take_report(&events).is_none());
        rig.core.queue_observation(b.clone());
        let second = rig.core.take_report(&events).unwrap();
        assert_eq!(second["databases"], json!([b]));
        // A report the API answered with `stale` or `conflict` holds nothing: b is said again.
        rig.core.report_posted(&second, &[]);
        rig.core.queue_observation(b.clone());
        let third = rig.core.take_report(&events).unwrap();
        // The answer to the third was lost; the API may hold b. The observation is back to a, the
        // one the node last knew the API took, and it is said all the same.
        rig.core.unsent(&events, &third);
        rig.core.queue_observation(a.clone());
        assert_eq!(
            rig.core.take_report(&events).unwrap()["databases"],
            json!([a])
        );
        // The same answer for a report that went: it holds what it took.
        let again = rig.core.take_report(&events);
        assert!(again.is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pull_of_what_the_api_holds_says_nothing_what_changed_goes_at_once_and_a_restart_says_everything_once()
     {
        let Some(rig) = Rig::new("report-pulls").await else {
            return;
        };
        let events = Events::new(Duration::from_secs(60));
        let mut json = rig.entry_json();
        let id = json["id"].as_str().unwrap().to_string();
        let path = json["archive"]["path"].as_str().unwrap().to_string();
        let page = |json: &Value| Rig::page(vec![json.clone()], vec![]);
        let quiet = || tokio::time::sleep(Duration::from_millis(300));
        rig.core.apply(&page(&json)).await;
        let db = rig.core.db(&id);
        eventually(90, "the report of the build", || {
            rig.core
                .pending_observation(&id)
                .is_some_and(|observation| observation["state"] == "ready")
        })
        .await;
        // What the decision on a pull queues, it queues within this time.
        let settled = || async {
            eventually(30, "the decision on the entry", || {
                db.view().reconcile == Reconcile::Idle
            })
            .await;
            tokio::time::sleep(Duration::from_millis(300)).await;
        };
        // Cloudflare waits for the build: every pull says the database, however often the API took it.
        let built = rig.core.take_report(&events).unwrap();
        assert_eq!(built["databases"][0]["state"], "ready");
        rig.core.report_posted(&built, std::slice::from_ref(&id));
        for _ in 0..2 {
            rig.core.apply(&page(&json)).await;
            settled().await;
            let again = rig.core.take_report(&events).unwrap();
            assert_eq!(again["databases"][0]["id"], id.as_str());
            rig.core.report_posted(&again, std::slice::from_ref(&id));
        }
        // The page drops the origin once the API took the build: a pull of it says nothing.
        json.as_object_mut().unwrap().remove("origin");
        for _ in 0..3 {
            rig.core.apply(&page(&json)).await;
            settled().await;
            let unexpected = rig.core.take_report(&events);
            assert!(unexpected.is_none(), "{unexpected:?}");
        }
        // A move order holds the database: it is said with every pull until the order ends.
        rig.core.set(&db, |view| {
            view.moving = Some("op_mmmmmmmmmmmmmmmmmmmm".into())
        });
        let held = rig.core.take_report(&events).unwrap();
        rig.core.report_posted(&held, std::slice::from_ref(&id));
        rig.core.apply(&page(&json)).await;
        settled().await;
        let held = rig.core.take_report(&events).unwrap();
        rig.core.report_posted(&held, std::slice::from_ref(&id));
        rig.core.set(&db, |view| view.moving = None);
        settled().await;
        assert!(rig.core.take_report(&events).is_none());
        // A change goes at once: the page moves the generation on.
        json["generation"] = 5.into();
        let operation = format!("op_{}", "d".repeat(20));
        json["operation"] = operation.clone().into();
        rig.core.apply(&page(&json)).await;
        let changed = rig.core.take_report(&events).unwrap();
        assert_eq!(changed["databases"][0]["generation"], 5);
        assert_eq!(changed["databases"][0]["operation"], operation.as_str());
        rig.core.report_posted(&changed, std::slice::from_ref(&id));

        // The anti-entropy: its turn has not come, and it comes within a period.
        let at = rig.core.reports.lock().unwrap().held[&id].at_ms;
        rig.core.resend_due(at);
        assert!(rig.core.take_report(&events).is_none());
        rig.core.resend_due(at + 2 * PERIOD);
        let resent = rig.core.take_report(&events).unwrap();
        assert_eq!(resent["databases"][0]["id"], id.as_str());
        assert_eq!(resent["databases"][0]["generation"], 5);

        // The agent restarts and holds nothing: its first pull says every database once.
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        rig.core.apply(&page(&json)).await;
        let db = rig.core.db(&id);
        eventually(60, "the database to be found", || {
            db.phase() == Phase::Ready
        })
        .await;
        let first = rig
            .core
            .take_report(&events)
            .expect("a restarted agent says it");
        assert_eq!(first["databases"][0]["id"], id.as_str());
        assert_eq!(first["databases"][0]["state"], "ready");
        rig.core.report_posted(&first, std::slice::from_ref(&id));
        rig.core.apply(&page(&json)).await;
        quiet().await;
        assert!(rig.core.take_report(&events).is_none());
    }
}
