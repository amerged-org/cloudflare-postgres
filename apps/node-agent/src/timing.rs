// SPDX-License-Identifier: Apache-2.0
//! Timing events of a wake, one JSON line each on the agent's log. They take the shape of
//! the TypeScript agent's `wake_phase` event and add the wall clock and the power operation,
//! which correlate them with the Cloudflare API's and the Edge's events of the same wake.
use serde_json::{Value, json};
use std::time::Instant;

fn wall_clock_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}
fn elapsed_ms(started: Instant) -> f64 {
    ((started.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0).min(600_000.0)
}
/// Whether `db` is being woken: the TypeScript agent measures wake phases only then.
pub fn waking(db: &Value) -> bool {
    db["desired_state"] == "running" && db["power"]["mode"] == "running"
}
pub(crate) fn emit(value: Value) {
    eprintln!("{value}");
}
/// Writes one event line to the agent's log.
pub fn emit_event(value: Value) {
    emit(value);
}
fn point_event(phase: &str, database_id: &str) -> Value {
    json!({"event":"wake_phase","phase":phase,"elapsedMs":0,"outcome":"completed","database_id":database_id,"at_ms":wall_clock_ms()})
}
/// A single point-in-time event of a wake, such as a hint arriving.
pub fn point(phase: &str, database_id: &str) {
    emit(point_event(phase, database_id));
}
fn pulled_event(ids: &[String], started: Instant, ok: bool) -> Value {
    let mut event = json!({"event":"wake_phase","phase":"desired_pull","elapsedMs":elapsed_ms(started),"outcome":if ok{"completed"}else{"failed"},"at_ms":wall_clock_ms()});
    match ids {
        [id] => event["database_id"] = id.as_str().into(),
        _ => event["count"] = ids.len().into(),
    }
    event
}
/// A finished targeted pull of the desired state of `ids`.
pub fn pulled(ids: &[String], started: Instant, ok: bool) {
    emit(pulled_event(ids, started, ok));
}
/// One measured phase. It reports `failed` if it ends without an outcome, like a `finally`.
pub struct Phase {
    event: Option<Value>,
    started: Instant,
    extra: serde_json::Map<String, Value>,
}
impl Phase {
    /// Starts `phase` of the wake of `db`; nothing is emitted for a database that is not waking.
    pub fn begin(db: &Value, phase: &'static str) -> Self {
        Self::begin_at(db, phase, Instant::now())
    }
    /// Like `begin` for a phase that is counted from `started`.
    pub fn begin_at(db: &Value, phase: &'static str, started: Instant) -> Self {
        Self {
            event: waking(db).then(|| {
                json!({"event":"wake_phase","phase":phase,"database_id":db["id"],"operation":db["power"]["operation"]})
            }),
            started,
            extra: serde_json::Map::new(),
        }
    }
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.into(), value.into());
        self
    }
    pub fn note(&mut self, key: &str, value: impl Into<Value>) {
        self.extra.insert(key.into(), value.into());
    }
    /// The event of this phase ending with `outcome`, once; `None` for a database not waking.
    pub(crate) fn finish(&mut self, outcome: &str) -> Option<Value> {
        let mut event = self.event.take()?;
        event["elapsedMs"] = elapsed_ms(self.started).into();
        event["outcome"] = outcome.into();
        event["at_ms"] = wall_clock_ms().into();
        for (key, value) in std::mem::take(&mut self.extra) {
            event[key] = value;
        }
        Some(event)
    }
    fn end(&mut self, outcome: &str) {
        if let Some(event) = self.finish(outcome) {
            emit(event);
        }
    }
    pub fn completed(mut self) {
        self.end("completed");
    }
    pub fn pending(mut self) {
        self.end("pending");
    }
    pub fn failed(mut self) {
        self.end("failed");
    }
}
impl Drop for Phase {
    fn drop(&mut self) {
        self.end("failed");
    }
}
/// A pass that was to report `db` ready ended without a report: `reason` says why, and `detail`
/// names the fault where one ended it.
pub fn ready_withheld_event(db: &Value, reason: &str, detail: Option<&str>) -> Value {
    json!({"event":"ready_withheld","database_id":db["id"],"generation":db["generation"],"reason":reason,"detail":detail,"at_ms":wall_clock_ms()})
}
/// A sleep refused by the safety check: its reason and the sessions that were busy
/// (`role/application/state/backend type`, comma-separated), when they could be read.
pub fn sleep_refused_event(db: &Value, reason: &str, sessions: Option<&str>) -> Value {
    json!({"event":"sleep_refused","database_id":db["id"],"generation":db["generation"],"reason":reason,"sessions":sessions,"at_ms":wall_clock_ms()})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_withheld_ready_report_names_the_database_its_generation_and_why() {
        let db = json!({"id":"dbbbbbbbbbbbbbbbbbbb","generation":5});
        let event =
            ready_withheld_event(&db, "ready_release_unavailable", Some("stale power intent"));
        let at = event["at_ms"].as_u64().unwrap();
        assert_eq!(
            event,
            json!({"event":"ready_withheld","database_id":"dbbbbbbbbbbbbbbbbbbb","generation":5,"reason":"ready_release_unavailable","detail":"stale power intent","at_ms":at})
        );
        assert_eq!(
            ready_withheld_event(&db, "wake_ticket_pending", None)["detail"],
            Value::Null
        );
    }
    fn waking_database() -> Value {
        json!({"id":"dbbbbbbbbbbbbbbbbbbb","desired_state":"running","power":{"operation":format!("op_{}","w".repeat(20)),"revision":3,"mode":"running","reason":null}})
    }
    #[test]
    fn a_wake_phase_names_its_database_operation_outcome_and_times() {
        let mut phase = Phase::begin(&waking_database(), "pg_accepting").with("polls", 3);
        phase.note("reason", "none");
        let event = phase
            .finish("completed")
            .expect("a waking database reports");
        assert_eq!(event["event"], "wake_phase");
        assert_eq!(event["phase"], "pg_accepting");
        assert_eq!(event["database_id"], "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(event["operation"], format!("op_{}", "w".repeat(20)));
        assert_eq!(event["outcome"], "completed");
        assert_eq!(event["polls"], 3);
        assert_eq!(event["reason"], "none");
        assert!(event["elapsedMs"].as_f64().is_some_and(|ms| ms >= 0.0));
        assert!(
            event["at_ms"]
                .as_u64()
                .is_some_and(|ms| ms > 1_700_000_000_000)
        );
        // Reported once.
        assert!(phase.finish("failed").is_none());
    }
    #[test]
    fn a_hint_and_a_pull_name_what_they_were_for() {
        let hint = point_event("wake_hint_received", "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(hint["event"], "wake_phase");
        assert_eq!(hint["phase"], "wake_hint_received");
        assert_eq!(hint["database_id"], "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(hint["outcome"], "completed");
        assert!(hint["at_ms"].as_u64().is_some());
        let one = pulled_event(&["dbbbbbbbbbbbbbbbbbbb".into()], Instant::now(), true);
        assert_eq!(one["phase"], "desired_pull");
        assert_eq!(one["database_id"], "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(one["outcome"], "completed");
        let many = pulled_event(&["a".into(), "b".into()], Instant::now(), false);
        assert_eq!(many["count"], 2);
        assert!(many.get("database_id").is_none());
        assert_eq!(many["outcome"], "failed");
    }
    #[test]
    fn only_a_waking_database_reports_phases() {
        let mut sleeping = waking_database();
        sleeping["desired_state"] = "suspended".into();
        sleeping["power"]["mode"] = "quiesce".into();
        assert!(
            Phase::begin(&sleeping, "wake_prepare")
                .finish("completed")
                .is_none()
        );
        assert!(!waking(&json!({"id":"d"})));
    }
}
