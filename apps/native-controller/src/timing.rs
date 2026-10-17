// SPDX-License-Identifier: Apache-2.0
//! Timing events of a wake, one JSON line each on the controller's log. They take the shape of
//! the TypeScript agent's `wake_phase` event and add the wall clock and the power operation,
//! which correlate them with the Cloudflare API's and the Edge's events of the same wake.
use serde_json::{Value, json};
use std::{cell::Cell, time::Instant};

tokio::task_local! {
    /// Kubernetes calls of the reconcile pass running in this task.
    static CALLS: Cell<u64>;
    /// Reads of the pass running in this task that the watch answered, without a call.
    static HITS: Cell<u64>;
}
/// Counts one Kubernetes API call for the pass running in the current task, if any.
pub(crate) fn count_call() {
    let _ = CALLS.try_with(|calls| calls.set(calls.get() + 1));
}
/// Counts one read answered from what the watch proves, for the pass running in the current task.
pub(crate) fn count_hit() {
    let _ = HITS.try_with(|hits| hits.set(hits.get() + 1));
}
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
    #[cfg(test)]
    EMITTED.with(|emitted| emitted.borrow_mut().push(value.clone()));
    eprintln!("{value}");
}
#[cfg(test)]
thread_local! {
    /// The events this test's thread emitted.
    static EMITTED: std::cell::RefCell<Vec<Value>> = const { std::cell::RefCell::new(Vec::new()) };
}
/// The events this test's thread emitted since the last call.
#[cfg(test)]
pub(crate) fn take_emitted() -> Vec<Value> {
    EMITTED.with(|emitted| std::mem::take(&mut *emitted.borrow_mut()))
}
/// Writes one event line to the controller's log.
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
/// Runs `work`, counting the Kubernetes calls it makes, and returns its output with the
/// summary event of a waking database.
async fn counted<F: std::future::Future>(db: &Value, work: F) -> (F::Output, Option<Value>) {
    let started = Instant::now();
    HITS.scope(
        Cell::new(0),
        CALLS.scope(Cell::new(0), async {
            let output = work.await;
            let summary = waking(db).then(|| {
                let calls = CALLS.try_with(Cell::get).unwrap_or(0);
                let hits = HITS.try_with(Cell::get).unwrap_or(0);
                json!({"event":"reconcile_summary","database_id":db["id"],"operation":db["power"]["operation"],"calls":calls,"memo_hits":hits,"elapsedMs":elapsed_ms(started),"at_ms":wall_clock_ms()})
            });
            (output, summary)
        }),
    )
    .await
}
/// Runs one reconcile pass of `db`, counting its Kubernetes calls, and reports them with its
/// duration when the database is waking.
pub async fn summarized<F: std::future::Future>(db: &Value, work: F) -> F::Output {
    let (output, summary) = counted(db, work).await;
    if let Some(summary) = summary {
        emit(summary);
    }
    output
}
/// One decision of the pool about a wake (`wake_path`): its path, the reason of a miss or a
/// refusal, the node and slot, and the milliseconds of each step reached.
pub struct WakePath<'a> {
    pub database: &'a str,
    pub operation: &'a str,
    pub generation: u64,
    /// `gateway` or `desired`.
    pub trigger: &'static str,
    /// `pool_hit`, `pool_miss` or `refused`.
    pub path: &'static str,
    pub reason: Option<&'a str>,
    pub node: &'a str,
    pub slot: Option<&'a str>,
    pub ms: &'a std::collections::BTreeMap<String, u64>,
    pub agent_us: &'a std::collections::BTreeMap<String, u64>,
}
pub fn wake_path_event(path: &WakePath) -> Value {
    json!({"event":"wake_path","database_id":path.database,"operation":path.operation,"generation":path.generation,"trigger":path.trigger,"path":path.path,"reason":path.reason,"node":path.node,"slot":path.slot,"ms":path.ms,"agent_us":path.agent_us,"at_ms":wall_clock_ms()})
}
/// How a released pool hit's ticket ended: `confirmed`, `refuted` or `expired`.
pub fn wake_ticket_event(
    database: &str,
    operation: &str,
    generation: u64,
    outcome: &str,
    after_ms: u64,
) -> Value {
    json!({"event":"wake_ticket","database_id":database,"operation":operation,"generation":generation,"outcome":outcome,"after_ms":after_ms,"at_ms":wall_clock_ms()})
}
/// A slot changed state: `creating`, `free`, `claimed` or `discarded`.
pub fn pool_slot_event(
    slot: &str,
    node: &str,
    state: &str,
    reason: Option<&str>,
    ms: Option<u64>,
) -> Value {
    json!({"event":"pool_slot","slot":slot,"node":node,"state":state,"reason":reason,"ms":ms,"at_ms":wall_clock_ms()})
}
/// A pass that was to report `db` ready ended without a report: `reason` says why, and `detail`
/// names the fault where one ended it.
pub fn ready_withheld_event(db: &Value, reason: &str, detail: Option<&str>) -> Value {
    json!({"event":"ready_withheld","database_id":db["id"],"generation":db["generation"],"reason":reason,"detail":detail,"at_ms":wall_clock_ms()})
}
/// Writes `ready_withheld_event` to the controller's log.
pub(crate) fn ready_withheld(db: &Value, reason: &str, detail: Option<&str>) {
    emit(ready_withheld_event(db, reason, detail));
}
/// A retirement of a slot that serves `database` waits at `step` (`postgres_stop`,
/// `holder_release`), or went on without having seen PostgreSQL shut down
/// (`postgres_stop_unseen`); `detail` is what the node agent answered last.
pub fn slot_retire_waiting_event(database: &str, slot: &str, step: &str, detail: &str) -> Value {
    json!({"event":"slot_retire_waiting","database_id":database,"slot":slot,"step":step,"detail":detail,"at_ms":wall_clock_ms()})
}
/// The pool of one node.
pub fn pool_state_event(node: &str, free: usize, creating: usize, serving: usize) -> Value {
    json!({"event":"pool_state","node":node,"free":free,"creating":creating,"serving":serving,"at_ms":wall_clock_ms()})
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
    #[test]
    fn pool_events_name_their_path_ticket_slot_and_state() {
        let ms = std::collections::BTreeMap::from([
            ("attach".to_string(), 25_u64),
            ("total".to_string(), 300),
        ]);
        let agent = std::collections::BTreeMap::from([("fsmount".to_string(), 900_u64)]);
        let hit = wake_path_event(&WakePath {
            database: "dbbbbbbbbbbbbbbbbbbb",
            operation: "op_wwwwwwwwwwwwwwwwwwww",
            generation: 5,
            trigger: "gateway",
            path: "pool_hit",
            reason: None,
            node: "n1",
            slot: Some("0a1b2c3d"),
            ms: &ms,
            agent_us: &agent,
        });
        let at = hit["at_ms"].as_u64().unwrap();
        assert!(at > 1_700_000_000_000);
        assert_eq!(
            hit,
            json!({"event":"wake_path","database_id":"dbbbbbbbbbbbbbbbbbbb","operation":"op_wwwwwwwwwwwwwwwwwwww","generation":5,"trigger":"gateway","path":"pool_hit","reason":null,"node":"n1","slot":"0a1b2c3d","ms":{"attach":25,"total":300},"agent_us":{"fsmount":900},"at_ms":at})
        );
        let miss = wake_path_event(&WakePath {
            path: "pool_miss",
            reason: Some("no_free_slot"),
            slot: None,
            trigger: "desired",
            ..WakePath {
                ..hit_fields(&ms, &agent)
            }
        });
        assert_eq!(miss["reason"], "no_free_slot");
        assert_eq!(miss["slot"], Value::Null);
        assert_eq!(miss["trigger"], "desired");
        let ticket = wake_ticket_event(
            "dbbbbbbbbbbbbbbbbbbb",
            "op_wwwwwwwwwwwwwwwwwwww",
            5,
            "expired",
            10_001,
        );
        assert_eq!(ticket["event"], "wake_ticket");
        assert_eq!(ticket["database_id"], "dbbbbbbbbbbbbbbbbbbb");
        assert_eq!(ticket["outcome"], "expired");
        assert_eq!(ticket["after_ms"], 10_001);
        assert!(ticket["at_ms"].as_u64().is_some());
        let slot = pool_slot_event("0a1b2c3d", "n1", "discarded", Some("replaced"), Some(12));
        assert_eq!(
            [
                &slot["event"],
                &slot["slot"],
                &slot["node"],
                &slot["state"],
                &slot["reason"],
                &slot["ms"]
            ],
            [
                &json!("pool_slot"),
                &json!("0a1b2c3d"),
                &json!("n1"),
                &json!("discarded"),
                &json!("replaced"),
                &json!(12)
            ]
        );
        let state = pool_state_event("n1", 3, 1, 2);
        assert_eq!(
            [
                &state["event"],
                &state["node"],
                &state["free"],
                &state["creating"],
                &state["serving"]
            ],
            [
                &json!("pool_state"),
                &json!("n1"),
                &json!(3),
                &json!(1),
                &json!(2)
            ]
        );
    }
    fn hit_fields<'a>(
        ms: &'a std::collections::BTreeMap<String, u64>,
        agent: &'a std::collections::BTreeMap<String, u64>,
    ) -> WakePath<'a> {
        WakePath {
            database: "dbbbbbbbbbbbbbbbbbbb",
            operation: "op_wwwwwwwwwwwwwwwwwwww",
            generation: 5,
            trigger: "gateway",
            path: "pool_hit",
            reason: None,
            node: "n1",
            slot: Some("0a1b2c3d"),
            ms,
            agent_us: agent,
        }
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
    #[tokio::test]
    async fn a_pass_reports_the_kubernetes_calls_it_made() {
        let (value, summary) = counted(&waking_database(), async {
            count_call();
            count_call();
            count_call();
            7
        })
        .await;
        assert_eq!(value, 7);
        let summary = summary.expect("a waking database reports its pass");
        assert_eq!(summary["event"], "reconcile_summary");
        assert_eq!(summary["calls"], 3);
        assert_eq!(summary["database_id"], "dbbbbbbbbbbbbbbbbbbb");
        assert!(summary["elapsedMs"].as_f64().is_some());
        // A call outside any pass counts nowhere, and a database that sleeps reports nothing.
        count_call();
        let mut sleeping = waking_database();
        sleeping["desired_state"] = "suspended".into();
        assert!(counted(&sleeping, async {}).await.1.is_none());
    }
}
