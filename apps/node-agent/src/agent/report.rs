// SPDX-License-Identifier: Apache-2.0
//! What the core tells Cloudflare (`NodeObservationReport`, `NodeEvent`; plan 4.9, 9.9): the state
//! of each database it changed, how the orders ended, and the decisions the node took.
use super::{Core, Db, Phase, View};
use crate::{
    archive::facts::{self, ArchiveState},
    events::Events,
    machine::Machine,
};
use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::PoisonError};

/// The most databases and orders one report carries (`NODE_DESIRED_PAGE_LIMIT_MAX`,
/// `NODE_ORDER_LIMIT`).
const DATABASES_PER_REPORT: usize = 200;
const ORDERS_PER_REPORT: usize = 1000;

#[derive(Default)]
pub(crate) struct Reports {
    /// The newest observation of each database that changed since the last post.
    observations: BTreeMap<String, Value>,
    /// How the orders ended, until Cloudflare answered.
    orders: BTreeMap<String, Value>,
    /// Events not yet queued for delivery.
    events: Vec<Value>,
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
        let databases: Vec<String> = reports
            .observations
            .keys()
            .take(DATABASES_PER_REPORT)
            .cloned()
            .collect();
        let orders: Vec<String> = reports
            .orders
            .keys()
            .take(ORDERS_PER_REPORT)
            .cloned()
            .collect();
        let mut report = json!({
            "observed_at": facts::timestamp(super::now_ms()),
            "databases": databases
                .iter()
                .filter_map(|id| reports.observations.remove(id))
                .collect::<Vec<_>>(),
            "orders": orders
                .iter()
                .filter_map(|operation| reports.orders.remove(operation))
                .collect::<Vec<_>>(),
        });
        // The agent's own log lines ride along, or leave alone.
        events.attach(&mut report, alone);
        (!alone || report.get("events").is_some()).then_some(report)
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
