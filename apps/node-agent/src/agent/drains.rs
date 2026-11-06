// SPDX-License-Identifier: Apache-2.0
//! The outbox drains of the node (plan database-events-and-schedules 4.5): one task per served
//! database, which moves the database's data events to Cloudflare (`drain.rs`). A drain runs while
//! the database is served (`metering::is_served`, and a sleep that is being proven keeps it) and its
//! platform schema is one the agent made. It ends when the database leaves service, when the node
//! is fenced, and when the schema turns out to be a tenant's.
use super::{Core, Db, Desired, Entry, Retry, build::Refresh, entry::EventLimits, metering};
use crate::{
    drain::{self, State, Tuning},
    machine::Machine,
    pgcf::EventsRecord,
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::task::JoinHandle;

/// How many databases a drain pass looks at once. A database whose platform schema waits for a
/// lock holds up its own pass only, and the others get their drains while it waits.
const DATABASES_AT_ONCE: usize = 16;

/// The drains of the node's databases, one task for each, and the waits of the databases whose
/// platform schema could not be made.
#[derive(Default)]
pub(crate) struct Drains {
    tasks: Mutex<HashMap<String, Attached>>,
    /// The wait before the next try to make the platform schema of a database, after one failed.
    retries: Mutex<HashMap<String, Retry>>,
}

/// A database's drain and what the hub knows of it.
struct Attached {
    handle: JoinHandle<()>,
    state: Arc<State>,
    tuning: Arc<Tuning>,
    /// The record of the platform schema the drain runs against (`refresh_events`).
    applied: EventsRecord,
}

impl Drains {
    fn tasks(&self) -> MutexGuard<'_, HashMap<String, Attached>> {
        self.tasks.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn retries(&self) -> MutexGuard<'_, HashMap<String, Retry>> {
        self.retries.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Ends the drain of `id`, if it has one, and forgets its failed tries.
    fn stop(&self, id: &str) {
        self.settled(id);
        if let Some(attached) = self.tasks().remove(id) {
            attached.handle.abort();
        }
    }
    /// Ends every drain: a fenced node moves no events.
    fn stop_all(&self) {
        self.retries().clear();
        for (_, attached) in self.tasks().drain() {
            attached.handle.abort();
        }
    }
    /// Whether the last try to make the platform schema of `id` failed and its wait has not passed.
    fn waiting(&self, id: &str) -> bool {
        self.retries().get(id).is_some_and(|retry| !retry.due())
    }
    /// Records a failed try to make the platform schema of `id`.
    fn failed(&self, id: &str, first: Duration, longest: Duration) {
        self.retries()
            .entry(id.to_string())
            .or_default()
            .failed(first, longest);
    }
    /// Forgets the failed tries of `id`: its schema is made, or its conflict is recorded.
    fn settled(&self, id: &str) {
        self.retries().remove(id);
    }
    /// Whether a drain of `id` runs. A task that has ended is forgotten, so that the next pass
    /// starts the drain again.
    fn running(&self, id: &str) -> bool {
        let mut tasks = self.tasks();
        let Some(attached) = tasks.get(id) else {
            return false;
        };
        if attached.handle.is_finished() {
            tasks.remove(id);
            return false;
        }
        true
    }
    /// Reads or changes the drain of `id`, if it runs.
    fn with<R>(&self, id: &str, change: impl FnOnce(&mut Attached) -> R) -> Option<R> {
        self.tasks().get_mut(id).map(change)
    }
}

impl Drop for Drains {
    /// The drains end with the core that started them.
    fn drop(&mut self) {
        self.stop_all();
    }
}

impl<M: Machine> Core<M> {
    /// One pass of the drain hub (`Service::drains`). A fenced node runs no drain. A served database
    /// gets one, or keeps the one it has at the node's limits; a database that leaves service loses
    /// its drain.
    pub async fn drain_pass(&self) {
        if self.fences.fenced() {
            self.drains.stop_all();
            return;
        }
        let events = self.policy().events;
        futures_util::stream::iter(self.all())
            .for_each_concurrent(DATABASES_AT_ONCE, |db| self.drain_database(db, events))
            .await;
    }

    /// The drain of one database in a pass: attached when it is served, detached when it is not.
    async fn drain_database(&self, db: Arc<Db>, events: EventLimits) {
        let Some(entry) = served_entry(&db) else {
            self.drains.stop(&db.id);
            return;
        };
        if self.drains.running(&db.id) {
            self.retune(&db, &entry, events).await;
        } else {
            self.start_drain(&db, events).await;
        }
    }

    /// Whether the outbox of `id` holds rows that the drain has read and not yet delivered
    /// (`State::pending`). False without a drain.
    pub(crate) fn outbox_backlog(&self, id: &str) -> bool {
        self.drains
            .with(id, |attached| {
                attached.state.pending.load(Ordering::Relaxed)
            })
            .unwrap_or(false)
    }

    /// Starts the drain of `db` once its platform schema is the agent's. A short unit watch must
    /// give this pass a fair turn even when both loops' ticks line up. Waiting at most one watch
    /// period leaves the hub bounded when a lifecycle flow or a backup holds the database longer.
    async fn start_drain(&self, db: &Db, events: EventLimits) {
        let Ok(_flow) = tokio::time::timeout(self.timing.watch, db.lock.lock()).await else {
            return;
        };
        // A node can be fenced while this pass waits for the database's flow.
        if self.fences.fenced() {
            self.drains.stop_all();
            return;
        }
        // The database may have left service while the flow was taken.
        let Some(entry) = served_entry(db) else {
            return;
        };
        // Taken before the refresh: a policy change during the install is then seen by the next pass.
        let applied = EventsRecord::of(&self.event_settings(&entry), false);
        if !matches!(
            self.refresh_for_drain(db, &entry).await,
            Some(Refresh::Unchanged | Refresh::Installed)
        ) {
            return;
        }
        let state = Arc::new(State {
            pending: AtomicBool::new(false),
        });
        let tuning = Arc::new(Tuning {
            rate: AtomicU32::new(events.emits_per_second),
            max_payload_bytes: AtomicU64::new(events.max_payload_bytes),
        });
        let handle = tokio::spawn(drain::run(
            self.layout().socket_directory(&db.id),
            db.id.clone(),
            self.data_events.clone(),
            tuning.clone(),
            drain::Settings {
                poll: self.timing.outbox_poll,
                gap: self.timing.outbox_gap,
                retry: self.timing.data_retry,
                retry_maximum: self.timing.data_retry_maximum,
            },
            state.clone(),
        ));
        self.drains.tasks().insert(
            db.id.clone(),
            Attached {
                handle,
                state,
                tuning,
                applied,
            },
        );
    }

    /// Keeps the running drain of `db` at the node's limits. The pacing and the batch size follow the
    /// policy at once; the platform schema is changed when its limits or its storage generation
    /// differ from the ones the drain applied, and a conflict ends the drain.
    async fn retune(&self, db: &Db, entry: &Entry, events: EventLimits) {
        self.drains.with(&db.id, |attached| {
            attached
                .tuning
                .rate
                .store(events.emits_per_second, Ordering::Relaxed);
            attached
                .tuning
                .max_payload_bytes
                .store(events.max_payload_bytes, Ordering::Relaxed);
        });
        let wanted = EventsRecord::of(&self.event_settings(entry), false);
        let applied = self
            .drains
            .with(&db.id, |attached| attached.applied.clone());
        if applied.as_ref() == Some(&wanted) {
            return;
        }
        let Ok(_flow) = db.lock.try_lock() else {
            return;
        };
        match self.refresh_for_drain(db, entry).await {
            Some(Refresh::Unchanged | Refresh::Installed) => {
                self.drains
                    .with(&db.id, |attached| attached.applied = wanted);
            }
            Some(Refresh::Conflict) => self.drains.stop(&db.id),
            Some(Refresh::Failed) | None => {}
        }
    }

    /// `refresh_events` for a drain. A try that fails waits before the next one, as the timing says
    /// (`data_retry`, doubling up to `data_retry_maximum`): a schema that cannot be made costs one
    /// attempt and one node event per wait, not one per pass. None while that wait lasts.
    async fn refresh_for_drain(&self, db: &Db, entry: &Entry) -> Option<Refresh> {
        if self.drains.waiting(&db.id) {
            return None;
        }
        let refresh = self.refresh_events(db, entry, false).await;
        if refresh == Refresh::Failed {
            self.drains.failed(
                &db.id,
                self.timing.data_retry,
                self.timing.data_retry_maximum,
            );
        } else {
            self.drains.settled(&db.id);
        }
        Some(refresh)
    }
}

/// The entry of a database that is served and not deleted: the databases a drain runs for.
fn served_entry(db: &Db) -> Option<Entry> {
    let view = db.view();
    if !metering::is_served(view.phase) {
        return None;
    }
    let entry = view.entry.clone();
    entry.filter(|entry| entry.desired != Desired::Deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            Timing,
            power::{Slept, Why},
            testing::{Rig, eventually, policy, timing, within},
        },
        node_link::contract_valid,
        postgres,
    };
    use pgcf_native_protocol::wake::Outcome;
    use serde_json::{Value, json};
    use std::{sync::atomic::Ordering, time::Duration};

    /// A session as the cluster's superuser on the tenant database, which emits the events.
    async fn tenant(rig: &Rig, id: &str) -> postgres::Session {
        postgres::connect(&rig.machine.layout().socket_directory(id), "postgres", id)
            .await
            .unwrap()
    }
    async fn outbox(rig: &Rig, id: &str) -> i64 {
        tenant(rig, id)
            .await
            .query("SELECT count(*) FROM pgcf.outbox", &[])
            .await
            .unwrap()[0]
            .get(0)
    }
    /// Waits until the drain has emptied the outbox of `id`.
    async fn drained(rig: &Rig, id: &str) {
        within(10, "the outbox to be drained", async {
            while outbox(rig, id).await > 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
    }
    /// The events the sink accepted, in the order of their bodies.
    fn accepted(rig: &Rig) -> Vec<Value> {
        rig.sink
            .posted
            .lock()
            .unwrap()
            .iter()
            .flat_map(|body| body["events"].as_array().cloned().unwrap_or_default())
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_ready_database_gets_a_drain_after_one_pass_and_emitted_rows_reach_the_sink_and_are_deleted()
     {
        let Some(rig) = Rig::new("drain-ready").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        tenant(&rig, &entry.id)
            .await
            .batch("SELECT pgcf.emit('orders', '{\"n\": 1}'); SELECT pgcf.emit('orders', '{\"n\": 2}')")
            .await
            .unwrap();
        drained(&rig, &entry.id).await;
        let events = accepted(&rig);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["topic"], "orders");
        assert_eq!(events[0]["payload"], json!({"n": 1}));
        assert_eq!(events[0]["epoch"], json!(entry.storage_generation));
        assert_eq!(events[1]["payload"], json!({"n": 2}));
        let bodies = rig.sink.posted.lock().unwrap().clone();
        assert!(
            bodies
                .iter()
                .all(|body| body["database"] == entry.id.as_str()
                    && contract_valid("NodeDataEventReport", body))
        );
    }

    /// The service runs both the unit watcher and this hub once per `Timing::watch`. A brief
    /// systemd read must not indefinitely prevent attachment just because their ticks line up.
    /// PostgreSQL and its events connection are real; the existing machine gate stands in only
    /// for a bounded unit read, and releases the flow for most of every interval.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn repeated_brief_unit_reads_do_not_starve_a_ready_databases_drain() {
        let Some(rig) = Rig::with_timing("drain-watch-phase", Timing::default()).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let baseline = rig
            .machine
            .unit_reads_by_database()
            .get(&entry.id)
            .copied()
            .unwrap_or(0);
        let period = Timing::default().watch;
        let start = tokio::time::Instant::now() + Duration::from_millis(20);
        rig.machine.hold_unit_reads([entry.id.clone()]);
        let (watch_entered, mut watch_read) = tokio::sync::mpsc::unbounded_channel();
        let (hub_polled, mut hub_started) = tokio::sync::mpsc::unbounded_channel();

        let watcher = {
            let core = rig.core.clone();
            tokio::spawn(async move {
                let mut ticks = tokio::time::interval_at(start, period);
                for _ in 0..3 {
                    ticks.tick().await;
                    core.watch_pass().await;
                }
            })
        };
        let hub = {
            let core = rig.core.clone();
            tokio::spawn(async move {
                let mut ticks = tokio::time::interval_at(start + Duration::from_millis(20), period);
                for _ in 0..3 {
                    ticks.tick().await;
                    watch_read.recv().await.unwrap();
                    let pass = core.drain_pass();
                    tokio::pin!(pass);
                    let first = futures_util::poll!(&mut pass);
                    hub_polled.send(()).unwrap();
                    if first.is_pending() {
                        pass.await;
                    }
                }
            })
        };

        for turn in 0..3 {
            within(2, "the unit watcher to enter its read", async {
                loop {
                    let reads = rig
                        .machine
                        .unit_reads_by_database()
                        .get(&entry.id)
                        .copied()
                        .unwrap_or(0);
                    if reads > baseline + turn {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await;
            watch_entered.send(()).unwrap();
            within(
                2,
                "the drain hub to poll while the watch holds the flow",
                async {
                    hub_started.recv().await.unwrap();
                },
            )
            .await;
            tokio::time::sleep(Duration::from_millis(60)).await;
            rig.machine.release_unit_reads();
            if turn < 2 {
                tokio::time::sleep_until(start + period * turn as u32 + period * 9 / 10).await;
                rig.machine.hold_unit_reads([entry.id.clone()]);
            }
        }
        watcher.await.unwrap();
        hub.await.unwrap();

        assert_eq!(db.phase(), super::super::Phase::Ready);
        let attached = rig.core.drains.running(&entry.id);
        assert!(
            attached,
            "the default-period drain hub never attached, despite the bounded watch releasing the flow between ticks"
        );
        let rows = tenant(&rig, &entry.id)
            .await
            .query(
                "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND application_name=$1",
                &[&postgres::EVENTS_APPLICATION],
            )
            .await
            .unwrap();
        assert_eq!(
            rows[0].get::<_, i64>(0),
            1,
            "the real events connection exists"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_long_flow_wait_is_bounded_and_another_database_attaches_while_it_waits() {
        let Some(rig) = Rig::with_timing("drain-flow-bound", Timing::default()).await else {
            return;
        };
        let (blocked, blocked_db) = rig.create().await;
        let (free, _free_db) = rig.create().await;
        let flow = blocked_db.lock.lock().await;
        let core = rig.core.clone();
        let mut pass = tokio::spawn(async move { core.drain_pass().await });
        eventually(
            1,
            "the other database to attach without the held flow",
            || rig.core.drains.running(&free.id),
        )
        .await;
        let bounded = tokio::time::timeout(
            Timing::default().watch + Duration::from_millis(500),
            &mut pass,
        )
        .await;
        if bounded.is_err() {
            pass.abort();
        }
        let blocked_attached = rig.core.drains.running(&blocked.id);
        drop(flow);
        bounded
            .expect("the hub must finish even while the lifecycle flow stays held")
            .unwrap();
        assert!(!blocked_attached);
        assert!(rig.core.drains.running(&free.id));

        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&blocked.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_node_fenced_during_the_flow_wait_attaches_nothing() {
        let Some(rig) = Rig::with_timing("drain-flow-fence", Timing::default()).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let flow = db.lock.lock().await;
        let pass = rig.core.drain_pass();
        tokio::pin!(pass);
        assert!(
            futures_util::poll!(&mut pass).is_pending(),
            "the pass is waiting behind the held flow"
        );
        rig.core
            .fences
            .fence("op_fenced_during_drain_wait")
            .unwrap();
        drop(flow);
        tokio::time::timeout(Timing::default().watch, pass)
            .await
            .expect("a fenced pass must finish");
        assert!(!rig.core.drains.running(&entry.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_refusing_sink_keeps_the_rows_and_backlog_is_true_until_it_accepts() {
        let Some(rig) = Rig::new("drain-refused").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.sink.refuse.store(true, Ordering::SeqCst);
        rig.core.drain_pass().await;
        tenant(&rig, &entry.id)
            .await
            .batch("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        eventually(10, "the drain to read the row", || {
            rig.core.outbox_backlog(&entry.id)
        })
        .await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(accepted(&rig).is_empty());
        assert_eq!(outbox(&rig, &entry.id).await, 1);
        assert!(rig.core.outbox_backlog(&entry.id));
        rig.sink.refuse.store(false, Ordering::SeqCst);
        drained(&rig, &entry.id).await;
        assert_eq!(accepted(&rig).len(), 1);
        eventually(10, "the backlog to clear", || {
            !rig.core.outbox_backlog(&entry.id)
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_drain_is_detached_when_the_database_sleeps_and_attached_again_after_a_wake() {
        let Some(rig) = Rig::new("drain-sleep").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        assert_eq!(rig.core.sleep(&db, Why::Order).await, Slept::Proven);
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
        assert_eq!(
            rig.core.wake(&Rig::ticket(&entry)).await.outcome,
            Outcome::Started
        );
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        tenant(&rig, &entry.id)
            .await
            .batch("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        drained(&rig, &entry.id).await;
        assert_eq!(accepted(&rig).len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_fenced_core_attaches_nothing() {
        let Some(rig) = Rig::new("drain-fenced").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        rig.core.fences.fence("op_fenced_for_drains").unwrap();
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
        tenant(&rig, &entry.id)
            .await
            .batch("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        rig.core.drain_pass().await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!rig.core.drains.running(&entry.id));
        assert_eq!(outbox(&rig, &entry.id).await, 1);
        assert!(accepted(&rig).is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_changed_policy_limit_reaches_a_running_database() {
        let Some(rig) = Rig::new("drain-limits").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.core.drain_pass().await;
        // Refused posts keep the rows, so that the outbox can fill up.
        rig.sink.refuse.store(true, Ordering::SeqCst);
        let mut limits = policy();
        limits.events.max_outbox_rows = 100;
        limits.events.emits_per_second = 7;
        limits.events.max_payload_bytes = 2048;
        rig.core.set_policy(limits);
        rig.core.drain_pass().await;
        let tuned = rig.core.drains.with(&entry.id, |attached| {
            (
                attached.tuning.rate.load(Ordering::Relaxed),
                attached.tuning.max_payload_bytes.load(Ordering::Relaxed),
            )
        });
        assert_eq!(tuned, Some((7, 2048)));
        let data = tenant(&rig, &entry.id).await;
        let rows: i64 = data
            .query("SELECT max_outbox_rows FROM pgcf.settings", &[])
            .await
            .unwrap()[0]
            .get(0);
        assert_eq!(rows, 100);
        let record = rig.core.files(&entry.id).load_events().unwrap().unwrap();
        assert_eq!(record.max_outbox_rows, 100);
        data.batch("SELECT pgcf.emit('orders', '{}') FROM generate_series(1, 100)")
            .await
            .unwrap();
        let error = data
            .batch("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap_err();
        let code = error
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(|error| error.code())
            .map(|code| code.code().to_string());
        assert_eq!(code.as_deref(), Some("53400"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_conflicting_database_gets_no_drain_and_no_repeated_session() {
        let Some(rig) = Rig::new("drain-conflict").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        // A schema named pgcf that a tenant role owns takes the platform's place.
        tenant(&rig, &entry.id)
            .await
            .batch("DROP SCHEMA pgcf CASCADE; CREATE SCHEMA pgcf AUTHORIZATION app")
            .await
            .unwrap();
        let files = rig.core.files(&entry.id);
        std::fs::remove_file(files.directory().join("events.json")).unwrap();
        rig.core.drain_pass().await;
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
        assert!(files.load_events().unwrap().unwrap().conflict);
        assert!(accepted(&rig).is_empty());
        // The schema is gone now, but the recorded conflict answers without a session: a pass
        // that asked the schema again would install the platform's and start a drain.
        tenant(&rig, &entry.id)
            .await
            .batch("DROP SCHEMA pgcf CASCADE")
            .await
            .unwrap();
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_deleted_database_loses_its_drain() {
        let Some(rig) = Rig::new("drain-deleted").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        rig.core.set(&db, |view| {
            view.entry.as_mut().unwrap().desired = Desired::Deleted;
        });
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_running_drain_ends_when_its_schema_turns_into_a_tenants() {
        let Some(rig) = Rig::new("drain-turned").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
        tenant(&rig, &entry.id)
            .await
            .batch("DROP SCHEMA pgcf CASCADE; CREATE SCHEMA pgcf AUTHORIZATION app")
            .await
            .unwrap();
        let mut limits = policy();
        limits.events.max_outbox_rows = 100;
        rig.core.set_policy(limits);
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
        assert!(
            rig.core
                .files(&entry.id)
                .load_events()
                .unwrap()
                .unwrap()
                .conflict
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_drain_that_has_ended_is_started_again_by_the_next_pass() {
        let Some(rig) = Rig::new("drain-ended").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        rig.core.drain_pass().await;
        rig.core
            .drains
            .with(&entry.id, |attached| attached.handle.abort());
        eventually(10, "the drain to end", || {
            rig.core
                .drains
                .with(&entry.id, |attached| attached.handle.is_finished())
                == Some(true)
        })
        .await;
        rig.core.drain_pass().await;
        assert_eq!(
            rig.core
                .drains
                .with(&entry.id, |attached| attached.handle.is_finished()),
            Some(false)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_schema_is_tried_again_only_after_its_wait() {
        let Some(rig) = Rig::with_timing(
            "drain-backoff",
            Timing {
                data_retry: Duration::from_millis(1500),
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        let (entry, _db) = rig.create().await;
        // The platform schema is gone and its record too, and a tenant's open transaction holds
        // the name: each install waits for the lock until its timeout and fails.
        tenant(&rig, &entry.id)
            .await
            .batch("DROP SCHEMA pgcf CASCADE")
            .await
            .unwrap();
        let files = rig.core.files(&entry.id);
        std::fs::remove_file(files.directory().join("events.json")).unwrap();
        let blocker = tenant(&rig, &entry.id).await;
        blocker.batch("BEGIN; CREATE SCHEMA pgcf").await.unwrap();
        rig.core.drain_pass().await;
        assert!(!rig.core.drains.running(&entry.id));
        // Inside the wait a pass makes no attempt, and so does not wait for the lock again.
        let began = std::time::Instant::now();
        rig.core.drain_pass().await;
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(!rig.core.drains.running(&entry.id));
        blocker.batch("ROLLBACK").await.unwrap();
        tokio::time::sleep(Duration::from_millis(1600)).await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&entry.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failing_schema_waits_alone_and_does_not_hold_back_the_other_databases() {
        let Some(rig) = Rig::with_timing(
            "drain-backoff-two",
            Timing {
                data_retry: Duration::from_millis(1500),
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        let (blocked, _db) = rig.create().await;
        let (free, _db) = rig.create().await;
        for id in [&blocked.id, &free.id] {
            tenant(&rig, id)
                .await
                .batch("DROP SCHEMA pgcf CASCADE")
                .await
                .unwrap();
            std::fs::remove_file(rig.core.files(id).directory().join("events.json")).unwrap();
        }
        let blocker = tenant(&rig, &blocked.id).await;
        blocker.batch("BEGIN; CREATE SCHEMA pgcf").await.unwrap();
        // The pass waits for the blocked install (its lock timeout is 2 s); the other database
        // gets its drain while it waits.
        let core = rig.core.clone();
        let pass = tokio::spawn(async move { core.drain_pass().await });
        eventually(1, "the other database to get its drain", || {
            rig.core.drains.running(&free.id)
        })
        .await;
        pass.await.unwrap();
        assert!(!rig.core.drains.running(&blocked.id));
        // Inside the wait a pass makes no attempt, so it does not wait for the lock again.
        let began = std::time::Instant::now();
        rig.core.drain_pass().await;
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(!rig.core.drains.running(&blocked.id));
        assert!(rig.core.drains.running(&free.id));
        blocker.batch("ROLLBACK").await.unwrap();
        tokio::time::sleep(Duration::from_millis(1600)).await;
        rig.core.drain_pass().await;
        assert!(rig.core.drains.running(&blocked.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_policy_change_during_the_install_is_applied_by_the_next_pass() {
        let Some(rig) = Rig::with_timing("drain-policy-install", timing()).await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        tenant(&rig, &entry.id)
            .await
            .batch("DROP SCHEMA pgcf CASCADE")
            .await
            .unwrap();
        std::fs::remove_file(rig.core.files(&entry.id).directory().join("events.json")).unwrap();
        // A tenant's open transaction holds the name, so the install waits for the lock.
        let blocker = tenant(&rig, &entry.id).await;
        blocker.batch("BEGIN; CREATE SCHEMA pgcf").await.unwrap();
        let core = rig.core.clone();
        let pass = tokio::spawn(async move { core.drain_pass().await });
        tokio::time::sleep(Duration::from_millis(700)).await;
        let mut limits = policy();
        limits.events.max_outbox_rows = 100;
        rig.core.set_policy(limits);
        blocker.batch("ROLLBACK").await.unwrap();
        pass.await.unwrap();
        assert!(rig.core.drains.running(&entry.id));
        rig.core.drain_pass().await;
        let rows: i64 = tenant(&rig, &entry.id)
            .await
            .query("SELECT max_outbox_rows FROM pgcf.settings", &[])
            .await
            .unwrap()[0]
            .get(0);
        assert_eq!(rows, 100);
    }
}
