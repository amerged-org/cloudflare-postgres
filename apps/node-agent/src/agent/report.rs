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
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::PoisonError};

/// The most databases one report carries; the contract allows 200 (`NODE_DESIRED_PAGE_LIMIT_MAX`).
/// The API takes 8 databases at a time (`OBSERVATION_CONCURRENCY`) and one costs it at most about
/// 1.1 s (D1 about 45 ms and the Actor's publish, which it waits for no longer than 1 s: measured
/// on EU1 with 235 databases), so a batch of 64 needs at most 64 / 8 x 1.1 s = 8.8 s. That is inside
/// the API's 12 s budget and less than half of the 20 s a request may take (`REQUEST_TIMEOUT`).
/// Taken one by one, 200 databases needed 59 to 209 s. 64 is a power of two: six halvings reach 1.
const DATABASES_PER_REPORT: usize = 64;
/// The most orders one report carries (`NODE_ORDER_LIMIT`).
const ORDERS_PER_REPORT: usize = 1000;

pub(crate) struct Reports {
    /// The newest observation of each database that changed since the last post.
    observations: BTreeMap<String, Value>,
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
            orders: BTreeMap::new(),
            events: Vec::new(),
            limit: DATABASES_PER_REPORT,
        }
    }
}
impl Reports {
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

    /// Queues the database's observation for Cloudflare.
    pub(crate) fn report(&self, db: &Db) {
        let observation = self.observe(db, &db.view());
        if let Some(observation) = observation {
            self.reports
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .observations
                .insert(db.id.clone(), observation);
            self.changed.notify_one();
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
    /// The report was accepted: the next one carries a whole batch.
    pub(crate) fn report_posted(&self) {
        self.reports
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .posted();
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
    /// about the same database or order was queued since.
    pub(crate) fn unsent(&self, events: &Events, report: &Value) {
        events.give_back(report);
        let mut reports = self.reports.lock().unwrap_or_else(PoisonError::into_inner);
        for observation in report["databases"].as_array().into_iter().flatten() {
            if let Some(id) = observation["id"].as_str() {
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
    use crate::{agent::testing::Rig, node_link::contract_valid};
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
        rig.core.report_posted();
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
}
