// SPDX-License-Identifier: Apache-2.0
//! Starting and stopping PostgreSQL (plan 4.6, 4.7, 5.9, 7.9, 7.10): a wake, the sleep with its
//! proof, the recovery of a database that stopped without one, and the watches that start them.
use super::{
    Claim, Core, Db, Desired, Entry, Phase, View,
    build::{Backup, put_off_for_the_longest},
    now_ms,
    report::uuid,
};
use crate::{
    Error,
    admission::{AdmitError, EarlySleep, Request},
    archive::server::{Registration, Table},
    layout::Layout,
    machine::{CpuTimes, Machine, Throttle},
    proof::{self, Outcome, Proof, Steps, WakeRefusal},
    sleep::Refusal,
    state::{DatabaseState, ProvenSleepRecord},
    storage::VolumeId,
    units::{
        self, Started, Timeline,
        slots::{Bind, Report},
    },
};
use pgcf_native_protocol::{
    agent::{ControlAction, SessionStatus, Writer},
    wake::{Outcome as WakeOutcome, WakeRequest, WakeResult},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    io,
    num::NonZeroU32,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

/// What a start is for, in the admission event and the wake's phases.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StartAs<'a> {
    /// One of `ADMISSION_STARTS`.
    pub kind: &'static str,
    pub generation: u64,
    /// The operation that asked; `None` for a start the node took alone.
    pub operation: Option<&'a str>,
}

/// Why a start did not give a database that accepts connections.
#[derive(Debug)]
pub(crate) enum StartFailure {
    Refused(crate::admission::Refused),
    /// The unit did not come up.
    Failed,
    /// It has not yet; the start goes on and the agent waits for it.
    Timeout,
}
impl StartFailure {
    /// The reason a wake names for it.
    fn wake_reason(&self) -> (&'static str, Option<u32>) {
        match self {
            Self::Refused(refused) => (refused.reason.reason(), refused.retry_after_seconds),
            Self::Failed => ("release_failed", None),
            Self::Timeout => ("start_timeout", None),
        }
    }
}

/// A start that failed, with one event that names the class of the error. No caller kept the
/// error, and a start that failed after its unit was up left nothing to say why (EU1, 2026-10-20).
fn failed(db: &Db, start: StartAs<'_>, class: &str) -> StartFailure {
    crate::timing::emit_event(json!({
        "event": "unit_start_failed", "database_id": db.id, "kind": start.kind, "class": class,
    }));
    StartFailure::Failed
}

/// How a wake ticket does not match the entry of the page the node holds: the reason behind a
/// `desired_stale` refusal, named in the wake event's `stale` (`WAKE_STALE` of the contract).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stale {
    /// The node holds no entry for the database.
    NoEntry,
    /// The ticket's generation is neither the next one, nor the entry's, nor a claim's; or it is
    /// above the entry of a suspended database, which is a page that has not caught up.
    Generation,
    /// The ticket's generation is the entry's, with another operation.
    Operation,
    /// The route revision changed since the Edge signed the ticket, other than by the claim of
    /// the ticket's own wake.
    Route,
    /// The roles changed since the Edge signed the ticket.
    Role,
}
impl Stale {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::NoEntry => "no_entry",
            Self::Generation => "generation",
            Self::Operation => "operation",
            Self::Route => "route",
            Self::Role => "role",
        }
    }
}

/// Whether the entry of the page still stands for a wake ticket. The ticket is of the next
/// generation (the claim is not in the page yet), or it is the entry's own wake (the claim is in
/// the page), or the node released it before the page named it (`claimed`). Its roles are the
/// entry's, and so is its route revision, with one exception: the entry's own wake. The Actor
/// signs the revision from before its claim, and every attempt of the claim raises it
/// (`withAdmissionMutation` commits its epoch row also when the business write lost its
/// compare-and-set and the claim is made again, up to three times), as does any other mutation of
/// the database between the ticket and its claim. The page that carries the claim therefore holds
/// the ticket's revision or a later one, and the gateway's `wake_state` takes the same. That is
/// safe, because `same` proves this ticket's own claim committed (its operation is inserted only
/// at the generation after the one it read, and the page names the newest operation at or below
/// the generation); a move, a suspend, a resume or a change of roles advances the generation or
/// the roles, and those stay checked. A ticket above the entry's revision is stale.
fn ticket_matches(request: &WakeRequest, entry: &Entry, claimed: bool) -> Result<(), Stale> {
    let next = request.generation == entry.generation + 1;
    let same = request.generation == entry.generation && request.operation == entry.operation;
    if !(next || same || claimed) {
        return Err(if request.generation == entry.generation {
            Stale::Operation
        } else {
            Stale::Generation
        });
    }
    let route = if same {
        request.route_revision <= entry.route_revision
    } else {
        request.route_revision == entry.route_revision
    };
    if !route {
        return Err(Stale::Route);
    }
    if request.role_revision_hash != entry.role_hash() {
        return Err(Stale::Role);
    }
    Ok(())
}

/// Whole milliseconds, rounded up: a step of 1 took at most a millisecond.
fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros().div_ceil(1000))
        .unwrap_or(u64::MAX)
        .min(600_000)
}

/// The log line of a wake (plan 9.9): its outcome and reason, the milliseconds of every step and
/// of the whole wake. The observation report carries it to Cloudflare, where a cold wake's time
/// is broken down by node.
fn wake_line(result: &WakeResult, stale: Option<Stale>, total_ms: u64) -> serde_json::Value {
    let mut line = json!({
        "event": "wake", "database_id": result.database, "outcome": result.outcome,
        "total_ms": total_ms,
    });
    if let Some(reason) = &result.reason {
        line["reason"] = reason.clone().into();
    }
    if let Some(stale) = stale {
        line["stale"] = stale.name().into();
    }
    for (step, ms) in &result.steps_ms {
        line[format!("step_{step}")] = (*ms).into();
    }
    line
}

/// How much a unit's quota throttled it between two readings. `None` where either is missing, or
/// the counters went back: the unit started again, with a cgroup of its own.
fn throttle_since(before: Option<Throttle>, after: Option<Throttle>) -> Option<Throttle> {
    let (before, after) = (before?, after?);
    Some(Throttle {
        nr_throttled: after.nr_throttled.checked_sub(before.nr_throttled)?,
        throttled_usec: after.throttled_usec.checked_sub(before.throttled_usec)?,
    })
}

/// The CPU times of the machine and the moment they were read: where a steal window starts.
pub(crate) type CpuMark = (Instant, Option<CpuTimes>);

/// The milliseconds of CPU time the hypervisor took from the machine, summed over its cores, since
/// `from` was read, and the milliseconds that passed: `(steal_ms, window_ms)`.
fn steal_since(from: CpuMark, now: Option<CpuTimes>) -> Option<(u64, u64)> {
    let (before, after) = (from.1?, now?);
    let ticks = after.steal.checked_sub(before.steal)?;
    Some((
        ticks.checked_mul(1000)? / after.ticks_per_second.max(1),
        millis(from.0.elapsed()),
    ))
}

/// The log line of a started wake's detail (plan 11.1): numbers only, and none for what could not
/// be read. `slot` is what the slot path took: where the slot came from (`slot_from`, `pool` or
/// `demand`), and the time to take or build it, to bind the database to it and to give the order
/// (`slot_wait_us`, `bind_us`, `order_us`); a slot built on demand also has the fork of its
/// supervisor and the executor's setup of its sandbox in `timeline`. `throttle` is the throttling
/// since the release, `steal` the stolen CPU time and the window it was counted over.
fn detail_line(
    database: &str,
    timeline: &Timeline,
    throttle: Option<Throttle>,
    steal: Option<(u64, u64)>,
    slot: Option<Report>,
) -> serde_json::Value {
    let mut line = json!({"event": "wake_detail", "database_id": database});
    if let Some(slot) = slot {
        line["slot_from"] = slot.from.word().into();
        line["slot_wait_us"] = slot.wait_us.into();
        line["bind_us"] = slot.bind_us.into();
        line["order_us"] = slot.order_us.into();
    }
    let startup = timeline.startup.as_ref();
    for (name, value) in [
        ("job_to_fork_us", timeline.job_to_fork_us),
        ("fork_to_handoff_us", timeline.fork_to_handoff_us),
        (
            "order_to_starting_us",
            startup.map(|s| s.order_to_starting_us),
        ),
        (
            "starting_to_shut_down_us",
            startup.map(|s| s.starting_to_shut_down_us),
        ),
        (
            "shut_down_to_ready_us",
            startup.map(|s| s.shut_down_to_ready_us),
        ),
        ("nr_throttled", throttle.map(|t| t.nr_throttled)),
        ("throttled_usec", throttle.map(|t| t.throttled_usec)),
        ("steal_ms", steal.map(|(steal_ms, _)| steal_ms)),
        ("steal_window_ms", steal.map(|(_, window_ms)| window_ms)),
    ] {
        if let Some(value) = value {
            line[name] = value.into();
        }
    }
    line
}

impl<M: Machine> Core<M> {
    /// Changes the database's state file, and the view's copy of it: on disk before it returns.
    pub(crate) fn save_state(
        &self,
        db: &Db,
        change: impl FnOnce(&mut DatabaseState),
    ) -> io::Result<()> {
        let mut state = db
            .view()
            .state
            .clone()
            .ok_or_else(|| io::Error::other("the database has no state"))?;
        change(&mut state);
        self.files(&db.id).save(&state)?;
        self.set(db, |view| view.state = Some(state));
        Ok(())
    }

    /// The database's volume, of the storage generation the page serves.
    pub(crate) fn volume_id(entry: &Entry) -> Option<VolumeId> {
        VolumeId::new(&entry.id, entry.storage_generation).ok()
    }

    /// Starts PostgreSQL for `entry` through admission and waits for it to accept connections, up
    /// to `deadline`: the start itself goes on after it. The admission decision is an event. It
    /// gives the start, how long admission made it wait, and the CPU times read just before the
    /// start began.
    ///
    /// Every start takes one path: the permit, then a slot (an idle one, or one built inside the
    /// permit), the database bound to it, the order, and the wait for ready. The steps run in a
    /// task of their own, so that a deadline that passes leaves the slot as the start has it and
    /// never between two steps: the late waiter below takes the task's result.
    pub(crate) async fn start_unit(
        self: &Arc<Self>,
        db: &Db,
        entry: &Entry,
        start: StartAs<'_>,
        deadline: Option<Duration>,
    ) -> Result<(Started, Duration, CpuMark), StartFailure> {
        let request = Request {
            database: db.id.clone(),
            memory_mib: entry.memory_mib,
            always_warm: entry.sleep_after_seconds.is_none(),
        };
        let event = |decision: &str, waited: Duration, refusal: Option<(&str, Option<u32>)>| {
            let mut event = json!({
                "type": "admission", "id": uuid(), "at": crate::archive::facts::timestamp(now_ms()),
                "database": db.id, "generation": start.generation,
                "operation": start.operation, "start": start.kind,
                "decision": decision, "waited_ms": millis(waited), "memory_mib": entry.memory_mib,
            });
            if let Some((reason, retry)) = refusal {
                event["reason"] = reason.into();
                if let Some(retry) = retry {
                    event["retry_after_seconds"] = retry.into();
                }
            }
            event
        };
        let permit = match self.admission.admit(request).await {
            Ok(permit) => permit,
            Err(AdmitError::Refused(refused)) => {
                self.event(event(
                    "refused",
                    refused.waited,
                    Some((refused.reason.reason(), refused.retry_after_seconds)),
                ));
                return Err(StartFailure::Refused(refused));
            }
            // The database is awake, starting or already waiting: it is admitted. A start that is
            // under way is waited for; one whose unit is gone is made.
            Err(AdmitError::Duplicate) => {
                let mark = (Instant::now(), self.machine.cpu());
                let started = if self.unit_awake(&db.id, true).await {
                    self.machine.wait_started(&db.id).await
                } else {
                    match self.bind_of(entry) {
                        Some(bind) => {
                            let (core, id) = (self.clone(), db.id.clone());
                            tokio::spawn(async move { core.start_in_slot(&id, &bind).await })
                                .await
                                .unwrap_or(Err(units::Error::NotReady("start_task_ended")))
                        }
                        None => Err(units::Error::NotReady("no_bind")),
                    }
                }
                .map_err(|error| {
                    failed(db, start, &crate::diagnostics::error_code(&error.into()))
                })?;
                return Ok((started, Duration::ZERO, mark));
            }
            Err(AdmitError::Stopped) => return Err(failed(db, start, "admission_stopped")),
        };
        let waited = permit.waited;
        self.event(event("admitted", waited, None));
        let mark = (Instant::now(), self.machine.cpu());
        // Where the variant says so, the catalogs are read ahead while the slot is bound.
        let _catalogs = self.readahead_catalogs(&db.id);
        let Some(bind) = self.bind_of(entry) else {
            permit.failed();
            return Err(failed(db, start, "no_bind"));
        };
        let mut running = {
            let (core, id) = (self.clone(), db.id.clone());
            tokio::spawn(async move { core.start_in_slot(&id, &bind).await })
        };
        let outcome = match deadline {
            Some(deadline) => tokio::time::timeout(deadline, &mut running).await,
            None => Ok((&mut running).await),
        };
        match outcome {
            Ok(Ok(Ok(started))) => {
                permit.ready();
                self.refill.notify_one();
                Ok((started, waited, mark))
            }
            Ok(ended) => {
                let class = match ended {
                    Ok(Err(error)) => crate::diagnostics::error_code(&error.into()),
                    _ => "start_task_ended".to_string(),
                };
                // A unit that is awake still holds its memory: the permit stays counted until its
                // unit is reported stopped. One that is not awake never started.
                let awake = self.unit_awake(&db.id, true).await;
                if !awake {
                    permit.failed();
                }
                self.refill.notify_one();
                Err(failed(db, start, &class))
            }
            Err(_) => {
                // The start goes on: the agent waits for its result, and a database that comes up
                // late is an awake database with nobody asking (it sleeps at its idle time).
                let (core, id) = (self.clone(), db.id.clone());
                tokio::spawn(async move {
                    match running.await {
                        Ok(Ok(started)) => {
                            permit.ready();
                            if let Some(db) = core.find(&id) {
                                core.late_start(&db, started).await;
                            }
                        }
                        _ => {
                            let awake = core.unit_awake(&id, true).await;
                            if !awake {
                                permit.failed();
                            }
                            if let Some(db) = core.find(&id) {
                                core.late_failure(&db).await;
                            }
                        }
                    }
                    core.refill.notify_one();
                });
                Err(StartFailure::Timeout)
            }
        }
    }

    /// What the slot of a start binds to the database: its volume of the storage generation the
    /// page serves, its user, the volume's device and data directory, and the limits of its size.
    fn bind_of(&self, entry: &Entry) -> Option<Bind> {
        let volume = Self::volume_id(entry)?;
        let account = self.machine.account(&entry.id)?;
        Some(Bind {
            device: self.machine.device(&volume).into(),
            data: self.layout().data(&entry.id),
            properties: self.limits(entry, &volume).properties(),
            volume,
            account,
        })
    }

    /// The path of every start, in one task: the slot and the database's bind to it, then the
    /// order and the wait for PostgreSQL. A slot that fails in either is stopped by the pool, and
    /// the database holds nothing.
    async fn start_in_slot(
        self: &Arc<Self>,
        database: &str,
        bind: &Bind,
    ) -> Result<Started, units::Error> {
        let bound = self.machine.bind(database, bind).await?;
        self.machine.exec(&bound).await
    }

    /// One pass of the pool's refill (`slots`): while the node takes no start and waits for none,
    /// one idle slot at a time up to `start_concurrency`, and then the users of the numbers that
    /// have none, one at a time, to the end of the pool's range, so that a storm of wakes never
    /// finds a number without its user (a wake makes none). A fenced node and one in maintenance
    /// have no idle slots.
    pub async fn refill_pass(self: &Arc<Self>) {
        loop {
            if self.fences.fenced() || self.maintenance.load(Ordering::Relaxed) {
                self.machine.drain_idle_slots().await;
                return;
            }
            // The build costs the node about 80 ms of CPU, which a wake must not wait for: it is
            // made only when no start is in flight or waits. So is a user, which locks the node's
            // account files for about 75 ms.
            if !self.admission.quiet().await {
                return;
            }
            let target = self.policy().admission.admission.start_concurrency;
            // A build that fails ends no pass: the user of the next number is still to be made,
            // which is what lets the next build leave the number that failed.
            if let Ok(Some(_)) = self.machine.refill_slot(target).await {
                continue;
            }
            match self.machine.make_slot_user().await {
                Ok(Some(_)) => {}
                _ => return,
            }
        }
    }

    /// Whether the database's unit holds memory; `unknown` is the answer when it cannot be read.
    /// A unit that may be awake counts as awake: its memory is not given back on a guess.
    pub(crate) async fn unit_awake(&self, database: &str, unknown: bool) -> bool {
        match self.machine.unit(database).await {
            Ok(unit) => unit.active.awake(),
            Err(_) => unknown,
        }
    }

    /// A start that outlasted its wake: PostgreSQL accepts connections now, and the database is
    /// released as an awake database.
    async fn late_start(self: &Arc<Self>, db: &Arc<Db>, started: Started) {
        let _flow = db.lock.lock().await;
        if db.phase() != Phase::Starting {
            return;
        }
        // The roles are the page's before anyone logs in, as at a wake that did not outlast its
        // deadline.
        let entry = db.view().entry.clone();
        if let Some(entry) = entry
            && self.refresh_roles(db, &entry).await.is_err()
        {
            self.stop_unproven(db).await;
            return;
        }
        let Some(writer) = writer_of(&started) else {
            self.stop_unproven(db).await;
            return;
        };
        self.set(db, |view| {
            view.phase = Phase::Ready;
            view.writer = Some(writer);
            view.awake_since_ms = Some(now_ms());
        });
        self.after_wake(db).await;
    }

    /// A start that outlasted its wake and gave no database that accepts connections: see
    /// `after_failed_start`.
    async fn late_failure(self: &Arc<Self>, db: &Arc<Db>) {
        let _flow = db.lock.lock().await;
        if db.phase() == Phase::Starting {
            self.after_failed_start(db).await;
        }
    }

    /// A unit that runs but cannot be released: stopped without a proof, so recovery proves it.
    async fn stop_unproven(self: &Arc<Self>, db: &Arc<Db>) {
        let _ = self.machine.stop(&db.id).await;
        self.admission.stopped(&db.id);
        self.go_unproven(db);
    }

    /// The CPU quota of the database's size, applied now (plan 4.4): a build's, a restart's, and a
    /// wake's once its burst is over. The entry counts as it is at this time, so a resize in
    /// between is the quota that follows.
    pub(crate) async fn after_ready(&self, db: &Db) {
        let millicores = db
            .view()
            .entry
            .as_ref()
            .and_then(|entry| NonZeroU32::new(entry.cpu_millicores));
        let _ = self.machine.set_cpu_quota(&db.id, millicores).await;
    }

    /// Once a wake has released PostgreSQL: its CPU quota follows after the policy's
    /// `cpu_boost_ms`, and at once if that is 0. The start-up, the first request and the reading
    /// of the buffer list of the last stop (`autoprewarm`) share the quota's 0.5 or 0.25 CPU when
    /// it comes with the release, and that was throttled in 19 of about 25 periods (EU1,
    /// 2026-10-20). The unit keeps its weight and its memory, IO and task limits meanwhile: the
    /// burst lifts the cap of the quota and nothing else, so the weights still divide contested
    /// CPU (plan 4.4 states the bound).
    ///
    /// One task per wake waits out the burst and ends with it; `Db::end_boost` ends it earlier,
    /// when the database leaves service (`Core::set`) or a base backup begins (`end_burst`). It
    /// applies the quota under the database's flow, so that it cannot meet the stop of a sleep,
    /// which lifts the quota, half way.
    pub(crate) async fn after_wake(self: &Arc<Self>, db: &Arc<Db>) {
        let boost = Duration::from_millis(self.policy().admission.admission.cpu_boost_ms);
        if boost.is_zero() {
            self.after_ready(db).await;
            return;
        }
        let (core, database) = (self.clone(), db.clone());
        let task = tokio::spawn(async move {
            tokio::time::sleep(boost).await;
            let _flow = database.lock.lock().await;
            if database.claim_boost() {
                core.after_ready(&database).await;
            }
        });
        db.begin_boost(task.abort_handle());
    }

    /// A flow that holds the database's flow for as long as its data is large while the database
    /// stays served (a base backup) cannot let the burst wait behind it: the timer would apply the
    /// quota only when the flow ends. The burst ends now, with the quota applied under the flow
    /// the caller holds. Without a burst that is still to end, nothing happens.
    pub(crate) async fn end_burst(&self, db: &Db) {
        if db.end_boost() {
            self.after_ready(db).await;
        }
    }

    // ---- wake

    /// The gateway's wake (plan 5.9): checks the ticket against what the node knows, the volume
    /// against the proven-sleep record, and starts PostgreSQL through admission. The answer is the
    /// gateway's to release or refuse its held connections with.
    pub async fn wake(self: &Arc<Self>, request: &WakeRequest) -> WakeResult {
        self.wake_within(request, self.timing.wake_start).await
    }

    /// A wake that waits `budget` for PostgreSQL to accept connections (`Timing::wake_start`
    /// for every wake of the agent). A test that needs one wake to give up early passes a short
    /// one for it, and every other wake of its node keeps the normal budget.
    async fn wake_within(self: &Arc<Self>, request: &WakeRequest, budget: Duration) -> WakeResult {
        let begun = Instant::now();
        let mut steps = BTreeMap::new();
        let mut stale = None;
        let outcome = self.try_wake(request, budget, &mut steps, &mut stale).await;
        let (outcome, reason, retry_after_seconds) = match &outcome {
            Ok(()) => (WakeOutcome::Started, None, None),
            Err((reason, retry)) => (WakeOutcome::Refused, Some((*reason).to_string()), *retry),
        };
        steps.retain(|_, value| *value > 0 || outcome == WakeOutcome::Started);
        let result = WakeResult {
            database: request.database.clone(),
            operation: request.operation.clone(),
            generation: request.generation,
            outcome,
            reason: reason.clone(),
            retry_after_seconds,
            steps_ms: steps.clone(),
        };
        let mut event = json!({
            "type": "wake", "id": uuid(), "at": crate::archive::facts::timestamp(now_ms()),
            "database": request.database, "generation": request.generation,
            "operation": request.operation,
            "outcome": if outcome == WakeOutcome::Started { "started" } else { "refused" },
            "phases_ms": steps,
        });
        if let Some(reason) = reason {
            event["reason"] = reason.into();
        }
        if let Some(stale) = stale {
            event["stale"] = stale.name().into();
        }
        self.event(event);
        crate::timing::emit_event(wake_line(&result, stale, millis(begun.elapsed())));
        result
    }

    async fn try_wake(
        self: &Arc<Self>,
        request: &WakeRequest,
        budget: Duration,
        steps: &mut BTreeMap<String, u64>,
        stale: &mut Option<Stale>,
    ) -> Result<(), (&'static str, Option<u32>)> {
        let checking = Instant::now();
        let refuse = |reason: &'static str| Err((reason, None));
        if self.fences.fenced() {
            return refuse("fenced");
        }
        let Some(db) = self.find(&request.database) else {
            *stale = Some(Stale::NoEntry);
            return refuse("desired_stale");
        };
        // The ticket is checked against the page's entry before anything waits for the database.
        // A refusal is a reason of `WAKE_REASONS`, and for `desired_stale` how the ticket is stale.
        let ticket = |view: &View| -> Result<(), (&'static str, Option<Stale>)> {
            let entry = view
                .entry
                .as_ref()
                .ok_or(("desired_stale", Some(Stale::NoEntry)))?;
            if self.fences.blocks(&db.id, entry.storage_generation) {
                return Err(("superseded", None));
            }
            match entry.desired {
                Desired::Deleted => return Err(("deleted", None)),
                // The entry is a manual suspension. A connection of its generation, or an older
                // one, is a connection to a suspended database. A request of a later generation
                // is not: D1 moved on (a resume, for one) and the page the node holds has not
                // caught up, so the entry says nothing of what D1 wants now. That is stale, which
                // `obey_wake` waits out, and never final; nothing starts from an entry that is
                // behind.
                Desired::Suspended if request.generation > entry.generation => {
                    return Err(("desired_stale", Some(Stale::Generation)));
                }
                Desired::Suspended => return Err(("suspended", None)),
                Desired::Running => {}
            }
            if view.moving.is_some() {
                return Err(("moving", None));
            }
            if self.maintenance.load(Ordering::Relaxed) {
                return Err(("maintenance", None));
            }
            let claimed = view.claim.as_ref().is_some_and(|claim| {
                claim.generation == request.generation && claim.operation == request.operation
            });
            ticket_matches(request, entry, claimed).map_err(|why| ("desired_stale", Some(why)))
        };
        // The node has not looked at the database in this run (it restarted, and a start that
        // reads LVM and systemd for every database at once may not have got to this one): its
        // decision runs now, ahead of the retry's wait, and the wake waits for it. If the wait ends
        // first the gateway holds the connections and asks again (`wake_in_progress`).
        if !db.view().adopted {
            if let Err((reason, why)) = ticket(&db.view()) {
                *stale = why;
                return refuse(reason);
            }
            self.schedule(&db);
            if !self.adopted(&db, self.timing.adopt_wait).await {
                return refuse("wake_in_progress");
            }
        }
        {
            let view = db.view();
            if let Err((reason, why)) = ticket(&view) {
                *stale = why;
                return refuse(reason);
            }
            match view.phase {
                Phase::Ready if view.writer.is_some() => {
                    drop(view);
                    self.release_running(&db, request);
                    return Ok(());
                }
                // A sleep is being proven: the wake waits for it below, and starts the database
                // again if it sleeps.
                Phase::Ready | Phase::Quiesce => {}
                Phase::Building | Phase::Starting => return refuse("wake_in_progress"),
                Phase::Unproven => return refuse("unproven"),
                Phase::Error => {
                    return refuse(match view.error {
                        Some("storage_full") => "storage_full",
                        Some("volume_missing") => "volume_missing",
                        _ => "unproven",
                    });
                }
                Phase::Deleted => return refuse("deleted"),
                Phase::Retired => return refuse("superseded"),
                Phase::Asleep => {}
            }
        }
        let _flow = db.lock.lock().await;
        // What happened while this wake waited for the database's flow.
        let (entry, record, phase) = {
            let view = db.view();
            if let Err((reason, why)) = ticket(&view) {
                *stale = why;
                return refuse(reason);
            }
            (
                view.entry.clone().ok_or(("desired_stale", None))?,
                view.state.as_ref().and_then(|state| state.record.clone()),
                view.phase,
            )
        };
        match phase {
            Phase::Ready => {
                self.release_running(&db, request);
                return Ok(());
            }
            Phase::Asleep => {}
            Phase::Unproven => return refuse("unproven"),
            _ => return refuse("wake_in_progress"),
        }
        let volume = Self::volume_id(&entry).ok_or(("volume_missing", None))?;
        let began = Instant::now();
        let exists = self.machine.has_volume(&volume).await;
        steps.insert("volume_check".into(), millis(began.elapsed()));
        if !matches!(exists, Ok(true)) {
            return refuse("volume_missing");
        }
        let began = Instant::now();
        let repair = self.machine.needs_repair(&volume).await;
        steps.insert("repair_check".into(), millis(began.elapsed()));
        match repair {
            Ok(false) => {}
            Ok(true) => {
                // The volume may have lost writes while the pool took none: recovery repairs it.
                self.go_unproven(&db);
                return refuse("volume_suspended");
            }
            Err(_) => return refuse("volume_missing"),
        }
        // The agent's link says it has the volume: mounted, not suspect, and the unit may start.
        if !self.machine.attached(&volume) {
            let began = Instant::now();
            match self
                .machine
                .mount_volumes(std::slice::from_ref(&volume))
                .await
            {
                Ok(failures) if failures.is_empty() => {}
                _ => return refuse("mount_failed"),
            }
            steps.insert("mount".into(), millis(began.elapsed()));
        }
        let began = Instant::now();
        if let Err(refusal) = proof::wake_check(record.as_ref(), &self.layout().volume(&db.id)) {
            steps.insert("pg_control".into(), millis(began.elapsed()));
            if refusal == WakeRefusal::Unproven {
                self.go_unproven(&db);
            }
            return refuse(refusal.reason());
        }
        steps.insert("pg_control".into(), millis(began.elapsed()));
        // The configuration of a database whose size or settings changed is written while its
        // unit is stopped, which is the only time the agent may write below its mount point.
        let began = Instant::now();
        let refreshed = self.refresh_configuration(&db, &entry).await;
        steps.insert("config".into(), millis(began.elapsed()));
        if let Err(error) = refreshed {
            crate::timing::emit_event(json!({
                "event": "configuration_failed", "database_id": db.id,
                "class": crate::diagnostics::error_code(&error),
            }));
            return refuse("release_failed");
        }
        let began = Instant::now();
        self.ensure_archive(&db, &entry);
        steps.insert("archive".into(), millis(began.elapsed()));
        steps.insert("admission".into(), millis(checking.elapsed()));
        self.set(&db, |view| {
            view.phase = Phase::Starting;
            view.claim = (request.generation != entry.generation
                || request.operation != entry.operation)
                .then(|| Claim {
                    generation: request.generation,
                    operation: request.operation.clone(),
                });
        });
        let began = Instant::now();
        let started = self
            .start_unit(
                &db,
                &entry,
                StartAs {
                    kind: "wake",
                    generation: request.generation,
                    operation: Some(&request.operation),
                },
                Some(budget),
            )
            .await;
        let (started, waited, steal) = match started {
            Ok(started) => started,
            Err(failure) => {
                match &failure {
                    // The unit was never asked to start.
                    StartFailure::Refused(refused) => {
                        steps.insert("queue_wait".into(), millis(refused.waited));
                        self.set(&db, |view| view.phase = Phase::Asleep);
                    }
                    StartFailure::Failed => self.after_failed_start(&db).await,
                    // The start goes on, and its task ends the phase (`late_start`, `late_failure`).
                    StartFailure::Timeout => {}
                }
                return Err(failure.wake_reason());
            }
        };
        steps.insert("queue_wait".into(), millis(waited));
        match started.slot {
            // The slot path: the slot, the bind (limits, mounts and the order), and PostgreSQL's
            // own start from the order to ready.
            Some(slot) => {
                let micros = Duration::from_micros;
                steps.insert("slot".into(), millis(micros(slot.wait_us)));
                steps.insert(
                    "bind".into(),
                    millis(micros(slot.bind_us.saturating_add(slot.order_us))),
                );
                steps.insert("start".into(), millis(micros(slot.start_us)));
            }
            None => {
                steps.insert(
                    "start".into(),
                    millis(began.elapsed().saturating_sub(waited)),
                );
            }
        }
        // Roles the page changed while the database slept are written before anyone logs in.
        let releasing = Instant::now();
        let began = Instant::now();
        let roles = self.refresh_roles(&db, &entry).await;
        steps.insert("roles".into(), millis(began.elapsed()));
        if let Err(reason) = roles {
            self.stop_unproven(&db).await;
            return refuse(reason);
        }
        let Some(writer) = writer_of(&started) else {
            self.stop_unproven(&db).await;
            return refuse("release_failed");
        };
        self.set(&db, |view| {
            view.phase = Phase::Ready;
            view.writer = Some(writer);
            view.awake_since_ms = Some(now_ms());
            view.refusal = None;
        });
        steps.insert("release".into(), millis(releasing.elapsed()));
        self.readahead_hot_list(&db.id);
        self.detail_later(&db, started, steal);
        self.after_wake(&db).await;
        Ok(())
    }

    /// Off the path of a wake, once its writer is released: one `wake_detail` event, read
    /// `Timing::detail` later, when the login and the first statements are over. The throttling
    /// since the release is in the event: that of the quota where it came with the release
    /// (`cpu_boost_ms` 0) or before the event is read, and none inside a burst.
    fn detail_later(self: &Arc<Self>, db: &Db, started: Started, steal: CpuMark) {
        let (core, database) = (self.clone(), db.id.clone());
        tokio::spawn(async move {
            let throttle = core.machine.throttle(&database);
            tokio::time::sleep(core.timing.detail).await;
            let line = core.wake_detail(&database, &started, steal, throttle).await;
            crate::timing::emit_event(line);
        });
    }

    /// What the unit, the journal and the kernel say of a start that was released: the time to
    /// the fork, to the handoff and to the three messages of PostgreSQL's start, the CPU quota's
    /// throttling since the release, and the steal time since the unit was asked to start.
    /// `steal` and `throttle` are the readings from then.
    async fn wake_detail(
        &self,
        database: &str,
        started: &Started,
        steal: CpuMark,
        throttle: Option<Throttle>,
    ) -> serde_json::Value {
        let timeline = self
            .machine
            .start_timeline(database, started)
            .await
            .unwrap_or_default();
        detail_line(
            database,
            &timeline,
            throttle_since(throttle, self.machine.throttle(database)),
            steal_since(steal, self.machine.cpu()),
            started.slot,
        )
    }

    /// A wake of a database that runs: it is released to the ticket. The gateway releases a held
    /// connection on the table entry of the ticket's generation, so a ticket of the next generation
    /// is the database's claim, as at a start.
    fn release_running(&self, db: &Db, request: &WakeRequest) {
        self.set(db, |view| {
            let next = view
                .entry
                .as_ref()
                .is_some_and(|entry| request.generation == entry.generation + 1);
            if next && view.claim.is_none() {
                view.claim = Some(Claim {
                    generation: request.generation,
                    operation: request.operation.clone(),
                });
            }
        });
    }

    /// A start that failed. A unit that is awake, or that cannot be read, may run a PostgreSQL
    /// that nobody released (the start failed after the unit was up): it is stopped without a
    /// proof, so that recovery proves the sleep. One that is stopped leaves the database as it was
    /// before the start; a start that fails for a unit that crashed in recovery leaves the data
    /// directory as it was, and the next wake finds it unproven by `pg_control`.
    async fn after_failed_start(self: &Arc<Self>, db: &Arc<Db>) {
        if self.unit_awake(&db.id, true).await {
            self.stop_unproven(db).await;
        } else {
            self.set(db, |view| view.phase = Phase::Asleep);
        }
    }

    // ---- sleep

    /// Puts a running database to sleep with the proof of plan 7.9. `why` says who asked.
    pub(crate) async fn sleep(self: &Arc<Self>, db: &Arc<Db>, why: Why) -> Slept {
        let _flow = db.lock.lock().await;
        self.sleep_locked(db, why).await
    }

    pub(crate) async fn sleep_locked(self: &Arc<Self>, db: &Arc<Db>, why: Why) -> Slept {
        let (entry, generation) = {
            let view = db.view();
            if view.phase != Phase::Ready {
                return Slept::NotRunning;
            }
            let Some(entry) = view.entry.clone() else {
                return Slept::NotRunning;
            };
            let generation = view
                .claim
                .as_ref()
                .map_or(entry.generation, |c| c.generation);
            (entry, generation)
        };
        // The idle time is when a due base backup is taken, while the database still runs: it
        // is never woken for one. One that is put off for a wake keeps the database up, since
        // nothing would ask for the backup before its next idle sleep; the next idle pass asks
        // again, and an early sleep, which takes none, can still reclaim the database.
        if matches!(why, Why::Idle) {
            match self.backup_if_due(db, &entry).await {
                Ok(Backup::PutOff) => return Slept::BackupPutOff,
                Ok(Backup::Taken | Backup::NotTaken) => {}
                Err(error) => crate::timing::emit_event(json!({
                    "event": "backup_failed", "database_id": db.id, "error": error,
                })),
            }
        }
        let proof = self.proof(&entry);
        let steps = Quiet {
            core: self.clone(),
            db: db.clone(),
            generation,
        };
        let outcome = proof::run(&proof, &steps).await;
        match outcome {
            Outcome::Proven(record) => {
                if self.record_sleep(db, record).is_err() {
                    // The unit is stopped without a durable record: unproven.
                    self.admission.stopped(&db.id);
                    self.go_unproven(db);
                    return Slept::Unproven("record_unwritable");
                }
                self.after_sleep(db, &entry).await;
                if let Why::Early { for_database } = &why {
                    self.event(json!({
                        "type": "early_sleep", "id": uuid(),
                        "at": crate::archive::facts::timestamp(now_ms()),
                        "database": db.id, "generation": generation,
                        "for_database": for_database,
                    }));
                }
                Slept::Proven
            }
            Outcome::Refused(refusal) => {
                self.set(db, |view| {
                    view.phase = Phase::Ready;
                    if matches!(why, Why::Order) {
                        view.refusal = Some(refusal.observation());
                    }
                });
                if matches!(why, Why::Early { .. }) {
                    self.admission.early_sleep_refused(&db.id);
                }
                crate::timing::emit_event(json!({
                    "event": "sleep_refused", "database_id": db.id,
                    "reason": refusal.reason(),
                }));
                Slept::Refused(refusal)
            }
            Outcome::StopFailed => {
                let awake = self.unit_awake(&db.id, true).await;
                if awake {
                    self.set(db, |view| view.phase = Phase::Ready);
                    Slept::Refused(Refusal::Busy)
                } else {
                    self.admission.stopped(&db.id);
                    self.go_unproven(db);
                    Slept::Unproven("stop_failed")
                }
            }
            Outcome::Unproven(reason) => {
                self.admission.stopped(&db.id);
                self.go_unproven(db);
                Slept::Unproven(reason)
            }
        }
    }

    /// Step 9 of plan 7.9: the record is on disk, fsynced, before the sleep is reported.
    fn record_sleep(&self, db: &Db, record: ProvenSleepRecord) -> io::Result<()> {
        self.save_state(db, |state| state.record = Some(record))
    }

    /// A proven sleep: the database is cold and safe. The volume is trimmed off the path.
    async fn after_sleep(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) {
        self.set(db, |view| {
            view.phase = Phase::Asleep;
            view.writer = None;
            view.awake_since_ms = None;
            view.backup_put_off_ms = None;
            view.refusal = None;
        });
        if let Some(volume) = Self::volume_id(entry) {
            let core = self.clone();
            tokio::spawn(async move {
                let _ = core.machine.trim_volume(&volume).await;
            });
        }
    }

    pub(crate) fn proof(&self, entry: &Entry) -> Proof {
        Proof {
            socket_directory: self.layout().socket_directory(&entry.id),
            volume: self.layout().volume(&entry.id),
            upload_log: self.files(&entry.id).upload_log(entry.storage_generation),
            archive_wait: self.timing.archive_wait,
        }
    }

    // ---- unproven databases (plan 7.10)

    /// The database stopped without a proof: nobody may start it until recovery has archived and
    /// proven it.
    pub(crate) fn go_unproven(self: &Arc<Self>, db: &Arc<Db>) {
        self.set(db, |view| {
            view.phase = Phase::Unproven;
            view.writer = None;
            view.awake_since_ms = None;
        });
        self.spawn_recovery(db);
    }

    /// Recovers an unproven database, and again after a wait until it is proven.
    pub(crate) fn spawn_recovery(self: &Arc<Self>, db: &Arc<Db>) {
        {
            let mut view = db.view();
            if view.recovering {
                return;
            }
            view.recovering = true;
        }
        let (core, db) = (self.clone(), db.clone());
        tokio::spawn(async move {
            let mut wait = core.timing.recovery_retry;
            loop {
                match core.recover_once(&db).await {
                    Recovered::Done => break,
                    Recovered::Retry => {
                        tokio::time::sleep(wait).await;
                        wait = (wait * 2).min(core.timing.recovery_retry_maximum);
                    }
                }
            }
            db.view().recovering = false;
        });
    }

    /// One attempt to prove an unproven database: repair its volume if it needs it, start it
    /// through admission (it counts as awake), let it archive, and run the sleep proof at once.
    /// No client is involved (plan 7.10).
    pub(crate) async fn recover_once(self: &Arc<Self>, db: &Arc<Db>) -> Recovered {
        let _flow = db.lock.lock().await;
        let entry = {
            let view = db.view();
            if view.phase != Phase::Unproven {
                return Recovered::Done;
            }
            match view.entry.clone() {
                Some(entry) => entry,
                None => return Recovered::Retry,
            }
        };
        if self.fences.fenced() || self.fences.blocks(&db.id, entry.storage_generation) {
            // Never started or archived again.
            return Recovered::Done;
        }
        if entry.desired == Desired::Deleted {
            return Recovered::Done;
        }
        let Some(volume) = Self::volume_id(&entry) else {
            return Recovered::Done;
        };
        match self.machine.has_volume(&volume).await {
            Ok(true) => {}
            Ok(false) => {
                self.set(db, |view| {
                    view.phase = Phase::Error;
                    view.error = Some("volume_missing");
                });
                return Recovered::Done;
            }
            Err(_) => return Recovered::Retry,
        }
        if !self.ensure_archive(db, &entry) {
            return Recovered::Retry;
        }
        if matches!(self.machine.needs_repair(&volume).await, Ok(true)) {
            let _ = self.machine.stop(&db.id).await;
            self.admission.stopped(&db.id);
            if self
                .machine
                .recover_volume(&volume, &self.policy().storage)
                .await
                .is_err()
            {
                return Recovered::Retry;
            }
        }
        if !self.machine.attached(&volume) {
            match self
                .machine
                .mount_volumes(std::slice::from_ref(&volume))
                .await
            {
                Ok(failures) if failures.is_empty() => {}
                _ => return Recovered::Retry,
            }
        }
        if self.refresh_configuration(db, &entry).await.is_err() {
            return Recovered::Retry;
        }
        let started = self
            .start_unit(
                db,
                &entry,
                StartAs {
                    kind: "recovery",
                    generation: entry.generation,
                    operation: None,
                },
                None,
            )
            .await;
        if started.is_err() {
            return Recovered::Retry;
        }
        // The roles are the page's before anything else touches the database.
        if self.refresh_roles(db, &entry).await.is_err() {
            return Recovered::Retry;
        }
        let proof = self.proof(&entry);
        match proof::run(
            &proof,
            &Alone {
                core: self.clone(),
                id: db.id.clone(),
            },
        )
        .await
        {
            Outcome::Proven(record) => {
                if self.record_sleep(db, record).is_err() {
                    return Recovered::Retry;
                }
                self.after_sleep(db, &entry).await;
                Recovered::Done
            }
            // The database stays awake until the archive drains, and is tried again.
            Outcome::Refused(_) | Outcome::StopFailed | Outcome::Unproven(_) => Recovered::Retry,
        }
    }

    /// The archive socket knows the database: registered with its store, so that PostgreSQL's
    /// archiver reaches R2. Every unit the agent starts or finds running is; the table is the
    /// agent's memory, so a restarted agent registers again what it finds. `false` before its
    /// credential was delivered.
    pub(crate) fn ensure_archive(&self, db: &Db, entry: &Entry) -> bool {
        let Some(account) = self.machine.account(&entry.id) else {
            return false;
        };
        let Some(volume) = Self::volume_id(entry) else {
            return false;
        };
        let store = || self.store(&entry.archive_path, crate::credentials::Access::ReadWrite);
        let Some(store) = store().or_else(|| {
            // The credential has not arrived (the first page is applied before the credentials
            // are read): `deliver` registers the database when it does. The second look closes the
            // gap between the first and the entry in the set.
            self.archive_waiting
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(db.id.clone());
            store()
        }) else {
            return false;
        };
        let upload_log = self.files(&db.id).upload_log(entry.storage_generation);
        if self.table.archives(&db.id, &store, &upload_log) {
            return true;
        }
        register(
            &self.table,
            self.layout(),
            &self.job_database(&volume, &account.name),
            store,
            upload_log,
        );
        true
    }

    // ---- the watches

    /// Finds the units that ended without being asked to: a crash, an out-of-memory kill of the
    /// postmaster, a stop from outside. The database is unproven (plan 7.10).
    pub async fn watch_pass(self: &Arc<Self>) {
        for db in self.all() {
            if db.phase() != Phase::Ready {
                continue;
            }
            // A flow that runs on the database stops it on purpose, or is about to.
            let Ok(_flow) = db.lock.try_lock() else {
                continue;
            };
            if db.phase() != Phase::Ready {
                continue;
            }
            let awake = match self.machine.unit(&db.id).await {
                Ok(unit) => unit.active.awake(),
                Err(_) => continue,
            };
            if !awake {
                self.admission.stopped(&db.id);
                self.go_unproven(&db);
            }
        }
    }

    /// Puts to sleep the awake databases that nobody used for their idle time (plan 3.2), and
    /// tells admission when each was last used, which early sleep picks from.
    pub async fn idle_pass(self: &Arc<Self>) {
        for db in self.all() {
            let (entry, since, backup, put_off) = {
                let view = db.view();
                if view.phase != Phase::Ready {
                    continue;
                }
                (
                    view.entry.clone(),
                    view.awake_since_ms,
                    view.state.as_ref().and_then(|state| state.backup.clone()),
                    view.backup_put_off_ms,
                )
            };
            let Some(entry) = entry else { continue };
            // An always-warm database takes its backup while it serves. So does one that was put
            // off for the longest: the idle sleep that would take it does not come while the
            // database is used.
            if (entry.sleep_after_seconds.is_none() || put_off_for_the_longest(put_off, now_ms()))
                && super::build::backup_due(backup.as_ref(), None, now_ms())
            {
                self.spawn_served_backup(&db);
            }
            // Without the gateway there is no way to know that nobody uses the database.
            let Some(activity) = self.gateway.activity(&db.id).await else {
                continue;
            };
            let now = now_ms();
            let last = activity
                .last_activity_ms
                .unwrap_or(0)
                .max(since.unwrap_or(now))
                .min(now);
            let age = Duration::from_millis(u64::try_from(now - last).unwrap_or(0));
            self.admission
                .activity(&db.id, tokio::time::Instant::now() - age);
            let Some(idle) = entry.sleep_after_seconds else {
                continue;
            };
            let busy = activity.busy_connections > 0 || activity.pending_dials > 0;
            if !busy && age >= Duration::from_secs(idle) && entry.desired == Desired::Running {
                self.sleep(&db, Why::Idle).await;
            }
        }
    }

    /// The base backup of a database that stays up and serves (plan 7.6): the daily one of an
    /// always-warm database, and the one of a database that was put off the longest, off the
    /// idle pass. A flow that runs on the database now, a backup among them, puts it off to the
    /// next pass.
    fn spawn_served_backup(self: &Arc<Self>, db: &Arc<Db>) {
        let (core, db) = (self.clone(), db.clone());
        tokio::spawn(async move {
            let Ok(_flow) = db.lock.try_lock() else {
                return;
            };
            let entry = db.view().entry.clone();
            let Some(entry) = entry.filter(|_| db.phase() == Phase::Ready) else {
                return;
            };
            if let Err(error) = core.backup_if_due(&db, &entry).await {
                crate::timing::emit_event(json!({
                    "event": "backup_failed", "database_id": db.id, "error": error,
                }));
            }
        });
    }

    /// Puts a database to sleep early for a wake that waits (plan 4.7).
    pub async fn early_sleep(self: &Arc<Self>, order: EarlySleep) {
        let Some(db) = self.find(&order.database) else {
            self.admission.early_sleep_refused(&order.database);
            return;
        };
        self.sleep(
            &db,
            Why::Early {
                for_database: order.for_database,
            },
        )
        .await;
    }
}

/// Who asked for a sleep.
#[derive(Clone, Debug)]
pub(crate) enum Why {
    /// The idle time passed.
    Idle,
    /// A wake waits for room (plan 4.7).
    Early { for_database: String },
    /// An order or the desired state: suspend, move or maintenance.
    Order,
}

/// How a sleep ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Slept {
    Proven,
    /// Refused: the database runs and is wakeable.
    Refused(Refusal),
    Unproven(&'static str),
    /// An idle sleep that was not taken: the base backup that is due waits for a wake
    /// (`Core::backup_if_due`), and the database runs until the next idle pass asks again.
    BackupPutOff,
    /// There was nothing to put to sleep.
    NotRunning,
}

/// How a recovery attempt ended.
pub(crate) enum Recovered {
    Done,
    Retry,
}

/// The gateway's table entry of a started unit.
pub(crate) fn writer_of(started: &Started) -> Option<Writer> {
    let writer = Writer {
        socket: started.socket.to_str()?.to_string(),
        uid: started.uid,
        pid: started.main_pid,
        instance: started.invocation_id.clone(),
    };
    writer.valid().then_some(writer)
}

pub(crate) fn register(
    table: &Table,
    _layout: &Layout,
    database: &crate::archive::job::Database,
    store: crate::archive::job::Store,
    upload_log: crate::archive::upload_log::UploadLog,
) {
    table.set(Registration {
        database: database.clone(),
        store,
        recovery: None,
        upload_log,
    });
}

/// What the proof needs of the gateway and the unit while a database sleeps.
struct Quiet<M: Machine> {
    core: Arc<Core<M>>,
    db: Arc<Db>,
    generation: u64,
}
impl<M: Machine> Steps for Quiet<M> {
    async fn quiesce(&self) -> Result<(), Refusal> {
        // The gateway admits nothing new from here, and its sessions say whether any is busy.
        self.core.set(&self.db, |view| view.phase = Phase::Quiesce);
        let begun = self
            .core
            .gateway
            .control(&self.db.id, self.generation, ControlAction::Begin)
            .await;
        let busy = begun.is_some_and(|sessions| {
            sessions.busy_connections > 0
                || sessions.pending_dials > 0
                || matches!(
                    sessions.status,
                    SessionStatus::Busy | SessionStatus::Mismatch
                )
        });
        if busy {
            self.core.set(&self.db, |view| view.phase = Phase::Ready);
            return Err(Refusal::Busy);
        }
        Ok(())
    }
    async fn resume(&self) {
        self.core.set(&self.db, |view| view.phase = Phase::Ready);
    }
    async fn close_sessions(&self) -> Result<(), Refusal> {
        let closed = self
            .core
            .gateway
            .control(&self.db.id, self.generation, ControlAction::Close)
            .await;
        let busy = closed.is_some_and(|sessions| {
            sessions.busy_connections > 0 || sessions.status == SessionStatus::Busy
        });
        if busy {
            self.core.set(&self.db, |view| view.phase = Phase::Ready);
            return Err(Refusal::Busy);
        }
        Ok(())
    }
    async fn stop(&self) -> Result<(), Error> {
        self.core.machine.stop(&self.db.id).await?;
        self.core.admission.stopped(&self.db.id);
        Ok(())
    }
}

/// The proof of a database that nobody uses and the gateway does not serve: recovery.
struct Alone<M: Machine> {
    core: Arc<Core<M>>,
    id: String,
}
impl<M: Machine> Steps for Alone<M> {
    async fn quiesce(&self) -> Result<(), Refusal> {
        Ok(())
    }
    async fn resume(&self) {}
    async fn close_sessions(&self) -> Result<(), Refusal> {
        Ok(())
    }
    async fn stop(&self) -> Result<(), Error> {
        self.core.machine.stop(&self.id).await?;
        self.core.admission.stopped(&self.id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::build::{BACKUP_AFTER_WAKE_MS, BACKUP_PUT_OFF_MAX_MS};
    use crate::{
        agent::testing::{Rig, eventually},
        node_link::contract_valid,
        postgres, testpg,
    };
    use pgcf_native_protocol::agent::{Mode, ToGateway};
    use serde_json::Value;

    async fn tenant(rig: &Rig, id: &str) -> postgres::Session {
        postgres::connect(&rig.machine.layout().socket_directory(id), "postgres", id)
            .await
            .unwrap()
    }
    fn report(observation: Value) -> Value {
        json!({"observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []})
    }

    #[test]
    fn a_wake_line_carries_its_outcome_every_step_and_its_total() {
        let mut result = WakeResult {
            database: "abcdefghijklmnopqrst".into(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: 5,
            outcome: WakeOutcome::Started,
            reason: None,
            retry_after_seconds: None,
            steps_ms: [("admission", 3), ("queue_wait", 120), ("pg_control", 4)]
                .into_iter()
                .chain([("mount", 31), ("start", 61), ("roles", 0), ("release", 1)])
                .map(|(step, ms)| (step.to_string(), ms))
                .collect(),
        };
        let line = wake_line(&result, None, 230);
        assert_eq!(
            line,
            json!({
                "event": "wake", "database_id": "abcdefghijklmnopqrst", "outcome": "started",
                "total_ms": 230, "step_admission": 3, "step_queue_wait": 120,
                "step_pg_control": 4, "step_mount": 31, "step_start": 61, "step_roles": 0,
                "step_release": 1,
            })
        );
        // What a node sends of it is what Cloudflare accepts.
        let at = "2026-10-18T10:11:12.345Z";
        let event = crate::events::sanitize(&line, at).unwrap();
        assert_eq!(event["fields"]["step_queue_wait"], 120);
        assert!(contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));
        // A refusal names its reason.
        result.outcome = WakeOutcome::Refused;
        result.reason = Some("no_headroom".into());
        let refused = wake_line(&result, None, 9);
        assert_eq!(refused["outcome"], "refused");
        assert_eq!(refused["reason"], "no_headroom");
        assert!(refused.get("stale").is_none());
        // A stale ticket names how.
        result.reason = Some("desired_stale".into());
        let stale = wake_line(&result, Some(Stale::Route), 9);
        assert_eq!(stale["reason"], "desired_stale");
        assert_eq!(stale["stale"], "route");
        let at = "2026-10-18T10:11:12.345Z";
        assert_eq!(
            crate::events::sanitize(&stale, at).unwrap()["fields"]["stale"],
            "route"
        );
    }

    /// The ticket the Edge signs for `entry`'s next generation, as `Rig::ticket` does, at the
    /// route revision the Actor's snapshot had when the claim was issued.
    fn ticket_for(entry: &Entry, generation: u64, operation: &str, route: u64) -> WakeRequest {
        WakeRequest {
            database: entry.id.clone(),
            operation: operation.into(),
            generation,
            route_revision: route,
            role_revision_hash: entry.role_hash(),
            queued_at_ms: 0,
        }
    }

    #[test]
    fn the_ways_a_ticket_is_stale_are_the_contracts() {
        let local: Value = serde_json::from_str(include_str!(
            "../../../../packages/contracts/native/node-local.generated.json"
        ))
        .unwrap();
        let ours = [
            Stale::NoEntry,
            Stale::Generation,
            Stale::Operation,
            Stale::Route,
            Stale::Role,
        ]
        .map(Stale::name);
        assert_eq!(
            local["constants"]["WAKE_STALE"],
            serde_json::to_value(ours).unwrap()
        );
    }

    #[test]
    fn a_ticket_matches_the_entry_it_was_signed_for_and_the_entry_its_own_claim_made() {
        let mut before = Entry::parse(&crate::agent::testing::new_entry_json()).unwrap();
        before.route_revision = 5;
        let (g, r, wake) = (
            before.generation,
            before.route_revision,
            "op_wwwwwwwwwwwwwwwwwwww",
        );
        // The claim commits the ticket's generation and operation and raises the route revision by
        // one (`withAdmissionMutation`): the page the hint pulls.
        let after = Entry {
            generation: g + 1,
            operation: wake.into(),
            route_revision: r + 1,
            ..before.clone()
        };
        let mut other_roles = before.clone();
        other_roles.roles.pop();
        let moved = Entry {
            route_revision: r + 1,
            ..before.clone()
        };
        let another = Entry {
            operation: "op_aaaaaaaaaaaaaaaaaaaa".into(),
            ..after.clone()
        };
        // Every attempt of the claim raises the revision, also one that lost its compare-and-set
        // and is made again, and so does any other mutation of the database in between.
        let lagging = Entry {
            route_revision: r + 3,
            ..after.clone()
        };
        let signed =
            |entry: &Entry, generation: u64, route: u64| ticket_for(entry, generation, wake, route);
        type Row<'a> = (&'a str, &'a Entry, WakeRequest, bool, Result<(), Stale>);
        let rows: Vec<Row> = vec![
            (
                "before the claim: the next generation at the entry's route",
                &before,
                signed(&before, g + 1, r),
                false,
                Ok(()),
            ),
            (
                "the node released it before the page names it",
                &before,
                signed(&before, g + 1, r),
                true,
                Ok(()),
            ),
            (
                "after the claim: its own wake at the entry's route",
                &after,
                signed(&after, g + 1, r + 1),
                false,
                Ok(()),
            ),
            (
                "after the claim: its own wake, the route one revision above the ticket's",
                &after,
                signed(&after, g + 1, r),
                false,
                Ok(()),
            ),
            (
                "after the claim: the route two revisions above the ticket's",
                &after,
                signed(&after, g + 1, r - 1),
                false,
                Ok(()),
            ),
            (
                "after the claim and two claim attempts that lost their compare-and-set: three above",
                &lagging,
                signed(&lagging, g + 1, r),
                false,
                Ok(()),
            ),
            (
                "after the claim: a ticket above the entry's route",
                &after,
                signed(&after, g + 1, r + 2),
                false,
                Err(Stale::Route),
            ),
            (
                "before the claim: a ticket above the entry's route",
                &before,
                signed(&before, g + 1, r + 1),
                false,
                Err(Stale::Route),
            ),
            (
                "before the claim: a ticket below the entry's route",
                &before,
                signed(&before, g + 1, r - 1),
                false,
                Err(Stale::Route),
            ),
            (
                "a move changed the route after the ticket, and no claim is in the page",
                &moved,
                signed(&moved, g + 1, r),
                false,
                Err(Stale::Route),
            ),
            (
                "the entry's wake is another operation",
                &another,
                signed(&another, g + 1, r),
                false,
                Err(Stale::Operation),
            ),
            (
                "a ticket of a generation the entry has passed",
                &after,
                signed(&after, g, r + 1),
                false,
                Err(Stale::Generation),
            ),
            (
                "a ticket of a later generation than the next",
                &before,
                signed(&before, g + 2, r),
                false,
                Err(Stale::Generation),
            ),
            (
                "the roles changed before the claim",
                &other_roles,
                signed(&before, g + 1, r),
                false,
                Err(Stale::Role),
            ),
        ];
        for (what, entry, request, claimed, wanted) in rows {
            assert_eq!(ticket_matches(&request, entry, claimed), wanted, "{what}");
        }
        // The role hash stays checked for the entry's own wake with the route one above.
        let mut changed = after.clone();
        changed.roles.pop();
        assert_eq!(
            ticket_matches(&signed(&after, g + 1, r), &changed, false),
            Err(Stale::Role)
        );
    }

    fn throttle(nr_throttled: u64, throttled_usec: u64) -> Option<Throttle> {
        Some(Throttle {
            nr_throttled,
            throttled_usec,
        })
    }
    fn cpu(steal: u64) -> Option<CpuTimes> {
        Some(CpuTimes {
            busy: 0,
            total: 0,
            steal,
            cores: 4,
            ticks_per_second: 100,
        })
    }

    #[test]
    fn a_wake_detail_is_numbers_for_what_was_read_and_nothing_for_what_was_not() {
        let timeline = Timeline {
            job_to_fork_us: Some(2_300),
            fork_to_handoff_us: Some(33_886),
            startup: Some(crate::units::journal::Startup {
                order_to_starting_us: 12_840,
                starting_to_shut_down_us: 1_605,
                shut_down_to_ready_us: 1_522,
            }),
        };
        // A slot built on demand: the wake waited for it, bound the database to it and ordered.
        let slot = Report {
            slot: 7,
            from: crate::units::slots::SlotFrom::Demand,
            wait_us: 131_000,
            bind_us: 2_800,
            order_us: 1_500,
            start_us: 115_000,
        };
        // The quota throttled the unit twice since the release; 3 ticks of 10 ms were stolen.
        let throttled = throttle_since(throttle(0, 0), throttle(2, 7_500));
        let stolen = steal_since((Instant::now(), cpu(10)), cpu(13));
        assert_eq!(throttled, throttle(2, 7_500));
        let (steal_ms, _window) = stolen.unwrap();
        assert_eq!(steal_ms, 30);
        let line = detail_line(
            "abcdefghijklmnopqrst",
            &timeline,
            throttled,
            stolen,
            Some(slot),
        );
        assert_eq!(
            line,
            json!({
                "event": "wake_detail", "database_id": "abcdefghijklmnopqrst",
                "slot_from": "demand", "slot_wait_us": 131_000, "bind_us": 2_800,
                "order_us": 1_500,
                "job_to_fork_us": 2_300, "fork_to_handoff_us": 33_886,
                "order_to_starting_us": 12_840, "starting_to_shut_down_us": 1_605,
                "shut_down_to_ready_us": 1_522,
                "nr_throttled": 2, "throttled_usec": 7_500, "steal_ms": 30,
                "steal_window_ms": line["steal_window_ms"],
            })
        );
        // What the node sends of it is what Cloudflare accepts: all 13 of its fields, within the
        // bound the contract gives an event.
        let at = "2026-10-18T10:11:12.345Z";
        let event = crate::events::sanitize(&line, at).unwrap();
        assert_eq!(event["fields"].as_object().unwrap().len(), 13);
        assert!(contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));

        // A journal that could not be read, a unit that is gone and a machine without a clock
        // leave their numbers out; the counters that went back are no reading.
        let bare = detail_line(
            "abcdefghijklmnopqrst",
            &Timeline::default(),
            None,
            None,
            None,
        );
        assert_eq!(
            bare,
            json!({"event": "wake_detail", "database_id": "abcdefghijklmnopqrst"})
        );
        assert_eq!(throttle_since(None, throttle(1, 1)), None);
        assert_eq!(throttle_since(throttle(5, 100), throttle(0, 0)), None);
        assert_eq!(steal_since((Instant::now(), None), cpu(1)), None);
        assert_eq!(steal_since((Instant::now(), cpu(9)), cpu(1)), None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_started_wake_emits_one_detail_after_its_release_and_not_on_its_path() {
        let timing = crate::agent::Timing {
            detail: Duration::from_millis(600),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("wake-detail", timing).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let details = || -> Vec<Value> {
            crate::events::seen()
                .into_iter()
                .filter(|e| e["event"] == "wake_detail" && e["database_id"] == entry.id.as_str())
                .collect()
        };

        // The wake returns released and the detail is not there yet.
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(db.phase(), Phase::Ready);
        assert!(details().is_empty());

        // This machine has no journal and no cgroup: the steal time of the window and what the slot
        // path took are all it reads. The pool was empty, so the wake built its slot.
        eventually(10, "the detail", || !details().is_empty()).await;
        let detail = details().remove(0);
        let fields = detail["fields"].as_object().unwrap();
        assert!(fields["steal_ms"].is_u64() && fields["steal_window_ms"].as_u64() >= Some(1));
        assert_eq!(fields["slot_from"], "demand", "{detail}");
        for name in ["slot_wait_us", "bind_us", "order_us"] {
            assert!(fields[name].is_u64(), "{name}: {detail}");
        }
        assert_eq!(fields.len(), 6, "{detail}");

        // The same wake again finds the database released: no start, no detail.
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(details().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_sleeps_with_a_proof_and_wakes_through_admission_against_its_record() {
        let Some(rig) = Rig::new("sleep-wake").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (entry, db) = rig.create().await;
        let data = tenant(&rig, &entry.id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 2000) AS a")
            .await
            .unwrap();
        drop(data);
        rig.machine.clear_calls();

        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);

        // Stopped, recorded, off the gateway's writers and out of admission's awake set.
        assert!(!rig.machine.running(&entry.id));
        // The proof's clean stop was also autoprewarm's: the list of the shared buffers is in the
        // data directory for the next start, and the proof did not mind the file.
        assert!(
            rig.core
                .layout()
                .data(&entry.id)
                .join("autoprewarm.blocks")
                .exists()
        );
        let state = db.state().unwrap();
        let record = state.record.clone().unwrap();
        assert!(record.valid());
        assert_eq!(rig.core.files(&entry.id).load().unwrap(), Some(state));
        assert!(
            rig.core
                .files(&entry.id)
                .upload_log(1)
                .contains(&record.last_archived_segment)
                .unwrap()
        );
        assert_eq!(rig.gateway.get(&entry.id).unwrap().mode, Mode::Sleeping);
        assert!(
            rig.core
                .admission
                .snapshot()
                .await
                .unwrap()
                .awake
                .is_empty()
        );
        eventually(5, "the trim", || {
            rig.machine.calls().contains(&format!("trim {}", entry.id))
        })
        .await;
        let observation = rig.observation(&entry.id);
        assert!(contract_valid(
            "NodeObservationReport",
            &report(observation.clone())
        ));
        assert_eq!(observation["state"], "asleep");
        assert_eq!(
            observation["proven_sleep"]["checkpoint_lsn"],
            record.checkpoint_lsn.as_str()
        );
        // The gateway was told before the unit stopped: quiesce, then the sleeping table entry.
        let modes: Vec<Mode> = gateway
            .received()
            .iter()
            .filter_map(|message| match message {
                ToGateway::Database { database } => Some(database.mode),
                _ => None,
            })
            .collect();
        // From the entry the page made (a database that is built is not served), through ready and
        // the quiesce of the sleep, to the sleeping entry.
        assert_eq!(
            modes,
            [Mode::Sleeping, Mode::Running, Mode::Quiesce, Mode::Sleeping]
        );

        // A wake of the next generation starts it again, after the volume was checked.
        rig.core.take_events();
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(result.reason, None);
        for step in [
            "volume_check",
            "repair_check",
            "pg_control",
            "config",
            "archive",
            "start",
            "admission",
        ] {
            assert!(
                result.steps_ms.contains_key(step),
                "{step}: {:?}",
                result.steps_ms
            );
        }
        assert!(rig.machine.running(&entry.id));
        let table = rig.gateway.get(&entry.id).unwrap();
        assert_eq!(
            (table.mode, table.generation),
            (Mode::Running, entry.generation + 1)
        );
        assert_eq!(table.operation, ticket.operation);
        assert_eq!(rig.machine.quota(&entry.id), Some(NonZeroU32::new(250)));
        let observation = rig.observation(&entry.id);
        assert_eq!(observation["state"], "ready");
        assert_eq!(observation["generation"], entry.generation + 1);
        let data = tenant(&rig, &entry.id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 2000);
        // What the node decided is told: the admission, and the wake with its phases.
        let events = rig.core.take_events();
        assert!(contract_valid(
            "NodeEventReport",
            &json!({"events": events})
        ));
        assert!(events.iter().any(|e| e["type"] == "admission"
            && e["start"] == "wake"
            && e["decision"] == "admitted"));
        assert!(events.iter().any(|e| e["type"] == "wake"
            && e["outcome"] == "started"
            && e["phases_ms"]["start"].is_u64()));
        // The same wake again, from a second connection, is the same start.
        let again = rig.core.wake(&ticket).await;
        assert_eq!(again.outcome, WakeOutcome::Started);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_times_the_roles_it_applies_and_the_release_that_holds_them() {
        let Some(rig) = Rig::new("wake-roles").await else {
            return;
        };
        let mut db = rig.entry_json();
        let (entry, handle) = rig.create_from(&db).await;
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);

        // Nothing changed while it slept: the roles are applied already, and the wake still times
        // the release.
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert!(result.steps_ms.contains_key("release"), "{result:?}");
        assert!(result.steps_ms.contains_key("roles"), "{result:?}");
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);

        // While it sleeps the page changes a password: the wake writes it before the release.
        db.as_object_mut().unwrap().remove("origin");
        db["generation"] = json!(entry.generation + 1);
        db["operation"] = json!(format!("op_{:0>20}", "roles"));
        db["roles"] = json!([
            {"name": "app", "owner": true, "password": testpg::password(5), "revision": 5},
            {"name": "reader", "owner": false, "password": testpg::password(2), "revision": 2}
        ]);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(10, "the entry", || {
            handle
                .view()
                .entry
                .as_ref()
                .is_some_and(|e| e.generation == entry.generation + 1)
        })
        .await;
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        let (roles, release) = (result.steps_ms["roles"], result.steps_ms["release"]);
        assert!(roles > 0, "{result:?}");
        // The release is timed from the end of the start, so it holds the roles written after it.
        // The publish of the writer is real here, and too fast to tell whether the timer stops
        // after it; the writer being in the table is all this shows of it.
        assert!(release >= roles, "{result:?}");
        assert_eq!(rig.gateway.get(&entry.id).unwrap().mode, Mode::Running);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_the_node_cannot_serve_is_refused_with_the_reason_the_gateway_answers() {
        let Some(rig) = Rig::new("wake-refused").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let refused =
            |result: WakeResult| (result.outcome, result.reason, result.retry_after_seconds);
        let reason = |reason: &str| (WakeOutcome::Refused, Some(reason.to_string()), None);

        // A ticket of another generation, route or roles is stale.
        let mut stale = Rig::ticket(&entry);
        stale.generation = entry.generation + 2;
        assert_eq!(
            refused(rig.core.wake(&stale).await),
            reason("desired_stale")
        );
        let mut stale = Rig::ticket(&entry);
        stale.route_revision += 1;
        assert_eq!(
            refused(rig.core.wake(&stale).await),
            reason("desired_stale")
        );
        let mut stale = Rig::ticket(&entry);
        stale.role_revision_hash = "0".repeat(64);
        assert_eq!(
            refused(rig.core.wake(&stale).await),
            reason("desired_stale")
        );
        let mut unknown = Rig::ticket(&entry);
        unknown.database = "zzzzzzzzzzzzzzzzzzzz".into();
        assert_eq!(
            refused(rig.core.wake(&unknown).await),
            reason("desired_stale")
        );
        assert!(!rig.machine.running(&entry.id));

        // The states and holds that refuse a wake.
        let ticket = Rig::ticket(&entry);
        let with = |change: &dyn Fn(&mut View)| rig.core.set(&db, |view| change(view));
        with(&|view| view.moving = Some("op_vvvvvvvvvvvvvvvvvvvv".into()));
        assert_eq!(refused(rig.core.wake(&ticket).await), reason("moving"));
        with(&|view| view.moving = None);
        rig.core.maintenance.store(true, Ordering::Relaxed);
        assert_eq!(refused(rig.core.wake(&ticket).await), reason("maintenance"));
        rig.core.maintenance.store(false, Ordering::Relaxed);
        // A connection of the generation of a manual suspension, or of an older one, is a
        // connection to a suspended database. A request of a later generation is not: D1 moved on
        // (a resume, say) and the page the node holds has not caught up, so it says nothing of
        // what D1 wants now and is stale, never `suspended`.
        with(&|view| view.entry.as_mut().unwrap().desired = Desired::Suspended);
        let mut current = ticket.clone();
        current.generation = entry.generation;
        assert_eq!(refused(rig.core.wake(&current).await), reason("suspended"));
        let mut older = ticket.clone();
        older.generation = entry.generation - 1;
        assert_eq!(refused(rig.core.wake(&older).await), reason("suspended"));
        assert_eq!(
            refused(rig.core.wake(&ticket).await),
            reason("desired_stale")
        );
        with(&|view| view.entry.as_mut().unwrap().desired = Desired::Deleted);
        assert_eq!(refused(rig.core.wake(&ticket).await), reason("deleted"));
        with(&|view| view.entry.as_mut().unwrap().desired = Desired::Running);
        rig.core
            .fences
            .supersede(&entry.id, 1, false, "op_ssssssssssssssssssss")
            .unwrap();
        assert_eq!(refused(rig.core.wake(&ticket).await), reason("superseded"));
        assert!(!rig.machine.running(&entry.id));
        let rig2 = Rig::new("wake-refused-2").await.unwrap();
        let (entry2, db2) = rig2.create().await;
        assert_eq!(rig2.core.sleep(&db2, Why::Idle).await, Slept::Proven);
        rig2.core.fences.fence("op_ffffffffffffffffffff").unwrap();
        assert_eq!(
            refused(rig2.core.wake(&Rig::ticket(&entry2)).await),
            reason("fenced")
        );
        assert!(!rig2.machine.running(&entry2.id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_delivered_again_after_its_claim_reached_the_page_is_still_that_wake() {
        let Some(rig) = Rig::new("wake-claimed-page").await else {
            return;
        };
        let mut json = rig.entry_json();
        let (entry, db) = rig.create_from(&json).await;
        json.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        // The Edge signed the ticket at the entry's route revision. The start takes a while, and
        // the gateway delivers the ticket again before it is over.
        let ticket = Rig::ticket(&entry);
        rig.machine.delay_next_start(Duration::from_secs(2));
        let first = {
            let (core, ticket) = (rig.core.clone(), ticket.clone());
            tokio::spawn(async move { core.wake(&ticket).await })
        };
        eventually(10, "the start to begin", || db.phase() == Phase::Starting).await;
        // D1 committed the claim and the hint brought the page of the ticket's generation and
        // operation. The claim took three attempts, two of which lost their compare-and-set to a
        // periodic report, and each raised the route revision.
        json["generation"] = ticket.generation.into();
        json["operation"] = ticket.operation.clone().into();
        json["route_revision"] = (entry.route_revision + 3).into();
        rig.core.apply(&Rig::page(vec![json], vec![])).await;
        let again = rig.core.wake(&ticket).await;
        assert_eq!(
            (again.outcome, again.reason.as_deref()),
            (WakeOutcome::Refused, Some("wake_in_progress")),
            "{again:?}"
        );
        assert_eq!(first.await.unwrap().outcome, WakeOutcome::Started);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_refused_for_a_stale_ticket_names_in_its_event_how_it_is_stale() {
        let Some(rig) = Rig::new("wake-stale-event").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let ticket = || Rig::ticket(&entry);
        let mut generation = ticket();
        generation.generation = entry.generation + 2;
        let mut operation = ticket();
        operation.generation = entry.generation;
        let mut route = ticket();
        route.route_revision += 1;
        let mut role = ticket();
        role.role_revision_hash = "0".repeat(64);
        let mut unknown = ticket();
        unknown.database = "zzzzzzzzzzzzzzzzzzzz".into();
        rig.core.take_events();
        for (stale, request) in [
            ("generation", generation),
            ("operation", operation),
            ("route", route),
            ("role", role),
            ("no_entry", unknown),
        ] {
            let result = rig.core.wake(&request).await;
            assert_eq!(result.reason.as_deref(), Some("desired_stale"), "{stale}");
            let events = rig.core.take_events();
            assert!(contract_valid(
                "NodeEventReport",
                &json!({"events": events})
            ));
            let wake = events.iter().find(|e| e["type"] == "wake").unwrap();
            assert_eq!(wake["reason"], "desired_stale");
            assert_eq!(wake["stale"], stale);
        }
        // A ticket that is ahead of the entry of a suspended database is stale by its generation.
        rig.core.set(&db, |view| {
            view.entry.as_mut().unwrap().desired = Desired::Suspended
        });
        let result = rig.core.wake(&ticket()).await;
        assert_eq!(result.reason.as_deref(), Some("desired_stale"));
        let events = rig.core.take_events();
        let wake = events.iter().find(|e| e["type"] == "wake").unwrap();
        assert_eq!(wake["stale"], "generation");
        rig.core.set(&db, |view| {
            view.entry.as_mut().unwrap().desired = Desired::Running
        });
        // A refusal for another reason names no way of being stale.
        rig.core.maintenance.store(true, Ordering::Relaxed);
        assert_eq!(
            rig.core.wake(&ticket()).await.reason.as_deref(),
            Some("maintenance")
        );
        let events = rig.core.take_events();
        let wake = events.iter().find(|e| e["type"] == "wake").unwrap();
        assert_eq!(wake["reason"], "maintenance");
        assert!(wake.get("stale").is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_is_refused_at_the_check_of_a_volume_that_is_gone_or_damaged() {
        let Some(rig) = Rig::new("wake-volume").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        // A refused wake names the steps it took, and none after the check that refused it.
        let took = |result: &WakeResult, steps: &[&str]| {
            steps.iter().any(|step| result.steps_ms.contains_key(*step))
        };

        // LVM does not answer: the volume is not known to be there.
        rig.machine.set_volumes_unreadable(true);
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("volume_missing"))
        );
        let after_volume_check = [
            "repair_check",
            "pg_control",
            "config",
            "archive",
            "admission",
        ];
        assert!(!took(&result, &after_volume_check));
        assert_eq!(db.phase(), Phase::Asleep);
        rig.machine.set_volumes_unreadable(false);

        // The volume may have lost writes: the wake does not start it, and recovery repairs it.
        rig.machine.set_needs_repair(true);
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("volume_suspended"))
        );
        assert!(!took(&result, &after_volume_check[1..]));
        assert!(!rig.machine.running(&entry.id));
        assert_eq!(db.phase(), Phase::Unproven);
    }

    /// The repair detaches the volume first, which a job that holds it refuses: the recovery
    /// waits and tries again, starts nothing meanwhile, and goes on once the job has ended.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_recovery_that_meets_a_volume_a_job_holds_tries_again_until_it_is_let_go() {
        let Some(rig) = Rig::new("recover-held").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let volume = crate::storage::VolumeId::new(&entry.id, 1).unwrap();
        rig.machine.hold_volume(&volume);
        rig.machine.set_needs_repair(true);
        rig.machine.clear_calls();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.reason.as_deref(), Some("volume_suspended"));
        let recoveries = |machine: &crate::machine::local::Local| {
            machine
                .calls()
                .iter()
                .filter(|call| call.starts_with("recover "))
                .count()
        };
        eventually(10, "the recovery to meet the job again", || {
            recoveries(&rig.machine) >= 3
        })
        .await;
        assert_eq!(db.phase(), Phase::Unproven);
        assert!(
            !rig.machine.running(&entry.id),
            "nothing is started meanwhile"
        );

        rig.machine.release_volume(&volume);
        eventually(60, "the recovery to prove the database", || {
            db.phase() == Phase::Asleep
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_comes_while_the_database_goes_to_sleep_starts_it_again() {
        let Some(rig) = Rig::new("wake-quiesce").await else {
            return;
        };
        let _gateway = rig.connect_gateway().await;
        let (entry, db) = rig.create().await;
        // The archive is slow: the sleep holds the database quiet while its segment uploads.
        rig.fixture.set("delay", "2");
        let sleeping = {
            let (core, db) = (rig.core.clone(), db.clone());
            tokio::spawn(async move { core.sleep(&db, Why::Idle).await })
        };
        eventually(10, "the sleep to quiesce", || db.phase() == Phase::Quiesce).await;
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(sleeping.await.unwrap(), Slept::Proven);
        // The wake was answered once the database ran again for it: the gateway releases the held
        // connection on the table entry of the ticket's generation.
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert!(rig.machine.running(&entry.id));
        let table = rig.gateway.get(&entry.id).unwrap();
        assert_eq!(
            (table.mode, table.generation, table.operation.as_str()),
            (Mode::Running, ticket.generation, ticket.operation.as_str())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_of_a_database_that_runs_is_released_at_the_tickets_generation() {
        let Some(rig) = Rig::new("wake-running").await else {
            return;
        };
        let (entry, _db) = rig.create().await;
        // The Edge took the database for asleep: its ticket is of the next generation.
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        let table = rig.gateway.get(&entry.id).unwrap();
        assert_eq!(
            (table.mode, table.generation, table.operation.as_str()),
            (Mode::Running, ticket.generation, ticket.operation.as_str())
        );
        assert_eq!(rig.observation(&entry.id)["generation"], ticket.generation);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_page_with_the_claim_of_a_released_wake_moves_only_the_route_revision_of_its_entry()
    {
        let Some(rig) = Rig::new("wake-claim-entry").await else {
            return;
        };
        let mut json = rig.entry_json();
        let (entry, db) = rig.create_from(&json).await;
        json.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let ticket = Rig::ticket(&entry);
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        // The node released the wake before the page named it: the claimed generation and
        // operation on the entry's route revision.
        let released = rig.gateway.get(&entry.id).unwrap();
        assert_eq!(
            (
                released.mode,
                released.generation,
                released.operation.as_str(),
                released.route_revision
            ),
            (
                Mode::Running,
                ticket.generation,
                ticket.operation.as_str(),
                entry.route_revision
            )
        );
        // D1 commits the claim beside the request and hints the node, which pulls the page: the
        // same generation and operation under the revision the claim committed. The gateway's
        // entry changes in the route revision and nowhere else, so that a request admitted on the
        // released unit is still on the unit the table names.
        json["generation"] = ticket.generation.into();
        json["operation"] = ticket.operation.clone().into();
        json["route_revision"] = (entry.route_revision + 1).into();
        rig.core.apply(&Rig::page(vec![json], vec![])).await;
        assert_eq!(
            rig.gateway.get(&entry.id).unwrap(),
            pgcf_native_protocol::agent::Database {
                route_revision: entry.route_revision + 1,
                ..released
            }
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_that_outlasts_its_wake_and_then_fails_leaves_the_database_wakeable() {
        let Some(rig) = Rig::new("late-failure").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);

        // The next postmaster ends with a FATAL, after the wake stopped waiting for it.
        let auto = rig
            .machine
            .layout()
            .data(&entry.id)
            .join("postgresql.auto.conf");
        let original = std::fs::read_to_string(&auto).unwrap();
        std::fs::write(&auto, format!("{original}shared_buffers = 'none'\n")).unwrap();
        rig.machine.delay_next_start(Duration::from_millis(1500));
        let result = rig
            .core
            .wake_within(&Rig::ticket(&entry), Duration::from_millis(300))
            .await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("start_timeout"))
        );

        // The start failed: the database is asleep as it was, not starting for ever, and the
        // next wake starts it once it can start, with the budget every wake has.
        eventually(30, "the failed start to end", || {
            db.phase() == Phase::Asleep
        })
        .await;
        assert!(!rig.machine.running(&entry.id));
        std::fs::write(&auto, original).unwrap();
        // The next start is slower than the first wake's budget, as a real one is on a loaded
        // host (CI, 2026-10-22: 302 ms): the budget belongs to the wake, not to the node.
        rig.machine.delay_next_start(Duration::from_millis(600));
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(db.phase(), Phase::Ready);
    }

    /// A wake whose start returns an error after its unit is up, so the node never sees PostgreSQL
    /// released (EU1, 2026-10-20: a resume answered `release_failed` while its PostgreSQL ran for
    /// 83 s). The node may neither take the database for asleep nor leave it starting for ever:
    /// the unit is stopped without a proof, and recovery proves the sleep before the next wake.
    /// `units_readable` says whether the node can read the unit's state after the failure.
    async fn a_start_fails_after_its_unit_is_up(label: &str, units_readable: bool) {
        let Some(rig) = Rig::new(label).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let data = tenant(&rig, &entry.id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 3000) AS a")
            .await
            .unwrap();
        drop(data);
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.core.take_events();

        rig.machine.fail_next_start_after_up();
        rig.machine.set_units_unreadable(!units_readable);
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("release_failed")),
            "{result:?}"
        );
        // Starting for ever is the phase of a unit that is awake and read; asleep with PostgreSQL
        // running, that of a unit that could not be read.
        assert_ne!(db.phase(), Phase::Starting);
        eventually(10, "the unit to be stopped and its sleep proven", || {
            db.phase() == Phase::Asleep && !rig.machine.running(&entry.id)
        })
        .await;
        assert!(
            rig.core
                .take_events()
                .iter()
                .any(|e| e["type"] == "admission" && e["start"] == "recovery"),
            "recovery proved the sleep"
        );
        // The memory of the unit that ran was given back.
        let waited = std::time::Instant::now();
        while !rig
            .core
            .admission
            .snapshot()
            .await
            .unwrap()
            .awake
            .is_empty()
        {
            assert!(
                waited.elapsed() < Duration::from_secs(5),
                "timed out: the memory to be given back"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // The failure left a line with the class of the error, which no caller keeps.
        let failures: Vec<Value> = crate::events::seen()
            .into_iter()
            .filter(|e| e["event"] == "unit_start_failed" && e["database_id"] == entry.id.as_str())
            .collect();
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(
            (
                failures[0]["fields"]["kind"].as_str(),
                failures[0]["fields"]["class"].as_str()
            ),
            (Some("wake"), Some("bus_limits_exceeded"))
        );

        // Nothing acknowledged was lost: the next wake finds the proven database and its rows.
        let woke = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(woke.outcome, WakeOutcome::Started, "{woke:?}");
        let data = tenant(&rig, &entry.id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 3000);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_that_fails_after_its_unit_is_up_and_is_read_awake_is_proven_asleep() {
        a_start_fails_after_its_unit_is_up("start-fails-awake", true).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_that_fails_after_its_unit_is_up_and_cannot_be_read_is_proven_asleep() {
        a_start_fails_after_its_unit_is_up("start-fails-unread", false).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_finds_no_room_or_no_headroom_is_refused_and_leaves_the_database_asleep() {
        let Some(rig) = Rig::new("wake-capacity").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        // The pool is at its reserve: refused at once, with no hint, because waiting makes no room.
        rig.machine.set_no_room(true);
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (
                result.outcome,
                result.reason.as_deref(),
                result.retry_after_seconds
            ),
            (WakeOutcome::Refused, Some("no_room"), None)
        );
        rig.machine.set_no_room(false);
        // No memory for it: it waits for the queue time, then is refused with the policy's hint.
        rig.machine.set_available_bytes(0);
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (
                result.outcome,
                result.reason.as_deref(),
                result.retry_after_seconds
            ),
            (WakeOutcome::Refused, Some("no_headroom"), Some(5))
        );
        assert!(
            result
                .steps_ms
                .get("queue_wait")
                .is_some_and(|ms| *ms >= 300)
        );
        assert!(!rig.machine.running(&entry.id));
        assert_eq!(db.phase(), Phase::Asleep);
        let events = rig.core.take_events();
        assert!(events.iter().any(|e| e["type"] == "admission"
            && e["decision"] == "refused"
            && e["reason"] == "no_headroom"
            && e["retry_after_seconds"] == 5));
        assert!(contract_valid(
            "NodeEventReport",
            &json!({"events": events})
        ));
        // Room again: the same database wakes.
        rig.machine.set_available_bytes(8 << 30);
        assert_eq!(
            rig.core.wake(&Rig::ticket(&entry)).await.outcome,
            WakeOutcome::Started
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_recovery_that_cannot_read_lvm_waits_and_does_not_give_the_database_up() {
        let Some(rig) = Rig::new("recovery-unreadable").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        rig.machine.set_volumes_unreadable(true);
        rig.machine.crash(&entry.id);
        rig.core.watch_pass().await;
        assert_eq!(db.phase(), Phase::Unproven);
        // A volume that cannot be looked up is not missing: recovery tries again.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(db.phase(), Phase::Unproven, "{:?}", db.view().error);
        rig.machine.set_volumes_unreadable(false);
        eventually(30, "the recovery to prove the sleep", || {
            db.phase() == Phase::Asleep && db.state().as_ref().is_some_and(|s| s.record.is_some())
        })
        .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_that_stopped_without_a_proof_is_never_woken_and_is_recovered_and_proven() {
        let Some(rig) = Rig::new("unproven").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let data = tenant(&rig, &entry.id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 3000) AS a")
            .await
            .unwrap();
        drop(data);
        // The postmaster is killed: no stop, no proof, no record of a sleep.
        rig.machine.crash(&entry.id);
        rig.core.watch_pass().await;
        assert_eq!(db.phase(), Phase::Unproven);
        assert_eq!(rig.gateway.get(&entry.id).unwrap().mode, Mode::Sleeping);
        // While recovery is pending a wake is refused as unproven.
        let first = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (first.outcome, first.reason.as_deref()),
            (WakeOutcome::Refused, Some("unproven"))
        );
        assert_eq!(rig.observation(&entry.id)["state"], "unproven");
        // Recovery starts it through admission, lets it archive and proves the sleep.
        eventually(30, "the recovery to prove the sleep", || {
            db.phase() == Phase::Asleep && db.state().as_ref().is_some_and(|s| s.record.is_some())
        })
        .await;
        assert!(!rig.machine.running(&entry.id));
        // The crashed unit's memory and the recovery's own were given back.
        let waited = std::time::Instant::now();
        while !rig
            .core
            .admission
            .snapshot()
            .await
            .unwrap()
            .awake
            .is_empty()
        {
            assert!(
                waited.elapsed() < Duration::from_secs(5),
                "timed out: the memory to be given back"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(rig.observation(&entry.id)["state"], "asleep");
        let events = rig.core.take_events();
        assert!(events.iter().any(|e| e["type"] == "admission"
            && e["start"] == "recovery"
            && e["operation"].is_null()));
        // Nothing acknowledged was lost: the data is there at the next wake.
        let woke = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(woke.outcome, WakeOutcome::Started, "{woke:?}");
        let data = tenant(&rig, &entry.id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 3000);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sleep_that_is_refused_leaves_the_database_awake_and_the_order_refused_only_once() {
        let Some(rig) = Rig::new("sleep-busy").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let session = tenant(&rig, &entry.id).await;
        session.batch("BEGIN").await.unwrap();
        // An idle sleep is refused and asked again later; nothing is told.
        assert_eq!(
            rig.core.sleep(&db, Why::Idle).await,
            Slept::Refused(Refusal::Busy)
        );
        assert_eq!(db.phase(), Phase::Ready);
        assert_eq!(db.view().refusal, None);
        assert!(rig.machine.running(&entry.id));
        // A sleep that the page asked for is refused for that generation, and the observation says so.
        assert_eq!(
            rig.core.sleep(&db, Why::Order).await,
            Slept::Refused(Refusal::Busy)
        );
        let observation = rig.observation(&entry.id);
        assert_eq!(
            (
                observation["state"].as_str(),
                observation["refusal"].as_str()
            ),
            (Some("ready"), Some("power_busy"))
        );
        assert!(contract_valid(
            "NodeObservationReport",
            &report(observation)
        ));
        // Still wakeable: a wake of a database that runs is answered with its writer.
        assert_eq!(
            rig.core.wake(&Rig::ticket(&entry)).await.outcome,
            WakeOutcome::Started
        );
        session.batch("COMMIT").await.unwrap();
        drop(session);
        assert_eq!(rig.core.sleep(&db, Why::Order).await, Slept::Proven);
        assert_eq!(db.view().refusal, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_gateways_busy_sessions_refuse_a_sleep_and_its_quiet_sessions_let_it_pass() {
        let Some(rig) = Rig::new("sleep-gateway").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (entry, db) = rig.create().await;
        {
            let mut sessions = gateway.sessions.lock().unwrap();
            sessions.status = SessionStatus::Busy;
            sessions.busy_connections = 2;
            sessions.connections = 3;
        }
        assert_eq!(
            rig.core.sleep(&db, Why::Idle).await,
            Slept::Refused(Refusal::Busy)
        );
        // The table entry went back to running: the gateway admits work again.
        assert_eq!(rig.gateway.get(&entry.id).unwrap().mode, Mode::Running);
        {
            let mut sessions = gateway.sessions.lock().unwrap();
            sessions.status = SessionStatus::Idle;
            sessions.busy_connections = 0;
        }
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
    }

    /// What a wake and a recovery ask of a volume is whether the agent has it attached (its link
    /// for the unit), not whether its directory is a mount: a volume can be mounted without its
    /// link (the rename after the mount failed), and then every start fails its assertion for
    /// good. The mount is asked for only when it is needed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_and_a_recovery_attach_a_volume_that_is_not_attached_and_ask_nothing_of_one_that_is()
     {
        let Some(rig) = Rig::new("attach").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let volume = Core::<crate::machine::local::Local>::volume_id(&entry).unwrap();
        let mounts = |rig: &Rig| {
            rig.machine
                .calls()
                .iter()
                .filter(|call| *call == &format!("mount {}", entry.id))
                .count()
        };
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.clear_calls();
        let woken = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(woken.outcome, WakeOutcome::Started, "{woken:?}");
        assert_eq!(mounts(&rig), 0, "attached: nothing to mount");

        // The volume is mounted and its link is gone: the wake attaches it again, and starts.
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.lose_link(&volume);
        rig.machine.clear_calls();
        let woken = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(woken.outcome, WakeOutcome::Started, "{woken:?}");
        assert_eq!(mounts(&rig), 1);
        assert!(rig.machine.running(&entry.id));

        // A crash, and the link lost: the recovery attaches the volume and starts the unit; one
        // whose volume is attached asks for no mount.
        rig.machine.crash(&entry.id);
        rig.machine.lose_link(&volume);
        rig.machine.clear_calls();
        rig.core.watch_pass().await;
        assert!(matches!(rig.core.recover_once(&db).await, Recovered::Done));
        assert_eq!(mounts(&rig), 1);
        assert_eq!(db.phase(), Phase::Asleep, "the recovery proved its sleep");
        rig.machine.clear_calls();
        rig.machine.crash(&entry.id);
        rig.core.watch_pass().await;
        assert!(matches!(rig.core.recover_once(&db).await, Recovered::Done));
        assert_eq!(mounts(&rig), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_idle_database_sleeps_at_its_idle_time_and_a_used_one_does_not() {
        let Some(rig) = Rig::new("idle").await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let (entry, db) = rig.create().await;
        // Used a moment ago: the idle time of 60 s has not passed.
        gateway.sessions.lock().unwrap().last_activity_ms = Some(now_ms() - 1000);
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        // Last used longer ago than the idle time: asleep.
        gateway.sessions.lock().unwrap().last_activity_ms = Some(now_ms() - 61_000);
        db.view().awake_since_ms = Some(now_ms() - 120_000);
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Asleep);
        assert!(!rig.machine.running(&entry.id));
    }

    /// Makes the newest base backup of a database a day and an hour old.
    fn age_backup(rig: &Rig, db: &Db) {
        rig.core
            .save_state(db, |state| {
                state.backup.as_mut().unwrap().completed_at =
                    crate::archive::facts::timestamp(now_ms() - 25 * 3_600_000);
            })
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_idle_sleep_takes_the_base_backup_that_is_due_before_it_stops_the_database() {
        let Some(rig) = Rig::new("backup-due").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let first = db.state().unwrap().backup.unwrap();
        // The newest backup is of today: an idle sleep takes none.
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        assert_eq!(db.state().unwrap().backup, Some(first.clone()));

        // A day later the database is woken and written to; its idle sleep, after its first
        // minute, takes a backup first.
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        age_backup(&rig, &db);
        db.view().awake_since_ms = Some(now_ms() - 2 * BACKUP_AFTER_WAKE_MS);
        let data = tenant(&rig, &entry.id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 100) AS a")
            .await
            .unwrap();
        drop(data);
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let second = db.state().unwrap().backup.unwrap();
        assert_ne!(second.backup_id, first.backup_id);
        assert_eq!(second.timeline, first.timeline);
        assert_eq!(
            rig.observation(&entry.id)["backup"]["backup_id"],
            second.backup_id.as_str()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_always_warm_database_takes_a_base_backup_once_a_day_and_stays_awake() {
        let Some(rig) = Rig::new("backup-warm").await else {
            return;
        };
        let mut json = rig.entry_json();
        json["sleep_after_seconds"] = Value::Null;
        let entry = rig.entry_for(&json);
        let db = rig.core.db(&entry.id);
        assert!(rig.core.accept(&db, entry.clone()));
        {
            let _flow = db.lock.lock().await;
            rig.core.build(&db, &entry).await.unwrap();
        }
        let first = db.state().unwrap().backup.unwrap();
        db.view().awake_since_ms = Some(now_ms() - 2 * BACKUP_AFTER_WAKE_MS);
        // Of today: nothing to do.
        rig.core.idle_pass().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(db.state().unwrap().backup, Some(first.clone()));
        // A day old, and R2 refuses the backup: it is tried again only after a while.
        age_backup(&rig, &db);
        rig.fixture.set("backup-fail", "");
        rig.core.idle_pass().await;
        eventually(30, "the failed backup", || {
            db.view().backup_failed_ms.is_some()
        })
        .await;
        let failed = db.view().backup_failed_ms;
        rig.core.idle_pass().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(db.view().backup_failed_ms, failed);
        assert_eq!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        // Once the while has passed, it is taken, and the database runs on.
        rig.fixture.clear("backup-fail");
        db.view().backup_failed_ms = Some(now_ms() - crate::agent::build::BACKUP_RETRY_MS);
        rig.core.idle_pass().await;
        eventually(30, "the daily backup", || {
            db.state()
                .and_then(|state| state.backup)
                .is_some_and(|backup| backup.backup_id != first.backup_id)
        })
        .await;
        assert_eq!(db.phase(), Phase::Ready);
        assert!(rig.machine.running(&entry.id));
    }

    /// A start in flight on the node for another database, which the test ends when it likes: what
    /// a wake looks like to the scheduler of the base backups.
    async fn wake_on_the_node(rig: &Rig) -> crate::admission::Permit {
        rig.machine.set_available_bytes(8 << 30);
        rig.core
            .admission
            .admit(crate::admission::Request {
                database: "another-database".into(),
                memory_mib: 64,
                always_warm: false,
            })
            .await
            .expect("the start of another database is admitted")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_daily_backup_waits_for_a_wake_on_the_node_and_for_the_first_minute_after_one() {
        let Some(rig) = Rig::new("backup-quiet").await else {
            return;
        };
        let mut json = rig.entry_json();
        json["sleep_after_seconds"] = Value::Null;
        let entry = rig.entry_for(&json);
        let db = rig.core.db(&entry.id);
        assert!(rig.core.accept(&db, entry.clone()));
        {
            let _flow = db.lock.lock().await;
            rig.core.build(&db, &entry).await.unwrap();
        }
        let newest = || db.state().unwrap().backup.unwrap().backup_id;
        let first = newest();
        age_backup(&rig, &db);
        db.view().awake_since_ms = Some(now_ms() - 3_600_000);

        // A wake is in flight on the node: the backup that is due is put off, and the database
        // runs on.
        let wake = wake_on_the_node(&rig).await;
        rig.core.idle_pass().await;
        eventually(30, "the backup put off", || {
            db.view().backup_put_off_ms.is_some()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(newest(), first);
        assert_eq!(db.phase(), Phase::Ready);

        // The wake is over: the next pass takes it, and the wait is forgotten.
        wake.failed();
        rig.core.idle_pass().await;
        eventually(30, "the daily backup", || newest() != first).await;
        eventually(5, "the wait forgotten", || {
            db.view().backup_put_off_ms.is_none()
        })
        .await;

        // The database itself woke ten seconds ago: the minute after a wake is not over.
        let second = newest();
        age_backup(&rig, &db);
        db.view().awake_since_ms = Some(now_ms() - 10_000);
        rig.core.idle_pass().await;
        eventually(30, "the backup put off", || {
            db.view().backup_put_off_ms.is_some()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(newest(), second);
        db.view().awake_since_ms = Some(now_ms() - BACKUP_AFTER_WAKE_MS - 1_000);
        rig.core.idle_pass().await;
        eventually(30, "the daily backup", || newest() != second).await;
    }

    /// A start that waits for room on the node, because there is none: what a queued wake looks
    /// like to the scheduler of the base backups. It leaves the queue when its task ends.
    async fn queued_wake_on_the_node(rig: &Rig) -> tokio::task::JoinHandle<()> {
        let mut policy = rig.core.policy();
        policy.admission.admission.queue_wait_ms = 60_000;
        rig.core.set_policy(policy);
        rig.machine.set_available_bytes(0);
        let admission = rig.core.admission.clone();
        let waiting = {
            let admission = admission.clone();
            tokio::spawn(async move {
                let _ = admission
                    .admit(crate::admission::Request {
                        database: "another-database".into(),
                        memory_mib: 64,
                        always_warm: false,
                    })
                    .await;
            })
        };
        let started = std::time::Instant::now();
        loop {
            let node = admission.snapshot().await.expect("the admission loop runs");
            if node.queued == 1 {
                assert_eq!(node.starting, 0, "the wake is queued, none is in flight");
                return waiting;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timed out: the start that waits for room"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A database that nobody uses for longer than its idle time, with a base backup due.
    async fn idle_with_a_backup_due(
        rig: &Rig,
    ) -> (Entry, Arc<Db>, crate::agent::testing::FakeGateway) {
        let gateway = rig.connect_gateway().await;
        let (entry, db) = rig.create().await;
        age_backup(rig, &db);
        db.view().awake_since_ms = Some(now_ms() - 2 * BACKUP_AFTER_WAKE_MS);
        gateway.sessions.lock().unwrap().last_activity_ms = Some(now_ms() - 61_000);
        (entry, db, gateway)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_idle_database_stays_awake_while_a_wake_runs_and_its_backup_is_taken_at_the_next_pass_after_it()
     {
        let Some(rig) = Rig::new("backup-idle-wake").await else {
            return;
        };
        let (entry, db, _gateway) = idle_with_a_backup_due(&rig).await;
        let first = db.state().unwrap().backup.unwrap();

        // Another database is waking: the backup that is due waits and the database is not put to
        // sleep without it (it would not be woken for it later), but stays up for the next pass.
        let wake = wake_on_the_node(&rig).await;
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        assert!(rig.machine.running(&entry.id));
        assert_eq!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        let put_off = db.view().backup_put_off_ms.expect("the backup is put off");

        // It is asked again, and the longest wait stays counted from the first time.
        tokio::time::sleep(Duration::from_millis(50)).await;
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        assert_eq!(db.view().backup_put_off_ms, Some(put_off));

        // The wake is over: the next pass takes the backup, then puts the database to sleep.
        wake.failed();
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Asleep);
        assert_ne!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        assert_eq!(db.view().backup_put_off_ms, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_waits_for_room_puts_off_the_backup_of_an_idle_database_too() {
        let Some(rig) = Rig::new("backup-idle-queued").await else {
            return;
        };
        let (entry, db, _gateway) = idle_with_a_backup_due(&rig).await;
        let first = db.state().unwrap().backup.unwrap();

        let waiting = queued_wake_on_the_node(&rig).await;
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        assert!(rig.machine.running(&entry.id));
        assert!(db.view().backup_put_off_ms.is_some());
        assert_eq!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );

        // The wake leaves the queue: the next pass takes the backup.
        waiting.abort();
        let _ = waiting.await;
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Asleep);
        assert_ne!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_idle_sleep_takes_the_backup_whatever_the_node_does_once_it_was_put_off_the_longest()
    {
        let Some(rig) = Rig::new("backup-idle-longest").await else {
            return;
        };
        let (_entry, db, _gateway) = idle_with_a_backup_due(&rig).await;
        let first = db.state().unwrap().backup.unwrap();

        let wake = wake_on_the_node(&rig).await;
        // A moment short of the longest wait: still put off.
        db.view().backup_put_off_ms = Some(now_ms() - BACKUP_PUT_OFF_MAX_MS + 30_000);
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        // The longest wait has passed, and a wake is in flight still: the backup is taken.
        db.view().backup_put_off_ms = Some(now_ms() - BACKUP_PUT_OFF_MAX_MS);
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Asleep);
        assert_ne!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        assert_eq!(db.view().backup_put_off_ms, None);
        wake.failed();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_backup_of_an_idle_database_waits_for_the_first_minute_after_a_wake_of_another() {
        let Some(rig) = Rig::new("backup-after-another-wake").await else {
            return;
        };
        // A: asleep, then woken just now, with an idle time that this test does not outlast. Its
        // start is over, so no start is queued or in flight on the node, and its first statements
        // are what the backup of B must not share the disk with.
        let mut json = rig.entry_json();
        json["sleep_after_seconds"] = json!(3600);
        let (a_entry, a) = rig.create_from(&json).await;
        assert_eq!(rig.core.sleep(&a, Why::Idle).await, Slept::Proven);
        let woken = rig.core.wake(&Rig::ticket(&a_entry)).await;
        assert_eq!(woken.outcome, WakeOutcome::Started, "{woken:?}");
        // B: idle for its idle time, a base backup due, its own wake long ago. It comes up after A
        // because both run as the test's user and the agent's archive table, which names a
        // database by its user, then names the one that came up last: B's WAL is archived as B's.
        let (_, b, _gateway) = idle_with_a_backup_due(&rig).await;
        let first = b.state().unwrap().backup.unwrap();
        let node = rig.core.admission.snapshot().await.unwrap();
        assert_eq!((node.starting, node.queued), (0, 0));

        rig.core.idle_pass().await;
        assert_eq!(b.phase(), Phase::Ready);
        assert!(rig.machine.running(&b.id));
        assert!(b.view().backup_put_off_ms.is_some());
        assert_eq!(
            b.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        assert_eq!(a.phase(), Phase::Ready);

        // A's minute is over: the next pass takes the backup of B, then puts it to sleep.
        a.view().awake_since_ms = Some(now_ms() - BACKUP_AFTER_WAKE_MS);
        rig.core.idle_pass().await;
        assert_eq!(b.phase(), Phase::Asleep);
        assert_ne!(
            b.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );
        assert_eq!(b.view().backup_put_off_ms, None);
        assert_eq!(a.phase(), Phase::Ready);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_that_is_used_takes_the_backup_it_was_put_off_for_while_it_serves_once_the_wait_is_over()
     {
        let Some(rig) = Rig::new("backup-put-off-used").await else {
            return;
        };
        let (entry, db, gateway) = idle_with_a_backup_due(&rig).await;
        let first = db.state().unwrap().backup.unwrap();
        let newest = || db.state().unwrap().backup.unwrap().backup_id;

        // Put off for a wake on the node, and then a client comes back: busy, the database is
        // never idle, so no idle sleep comes to take the backup.
        let wake = wake_on_the_node(&rig).await;
        rig.core.idle_pass().await;
        assert!(db.view().backup_put_off_ms.is_some());
        {
            let mut sessions = gateway.sessions.lock().unwrap();
            sessions.connections = 1;
            sessions.busy_connections = 1;
        }

        // A moment short of the longest wait: still put off, and the database keeps serving.
        db.view().backup_put_off_ms = Some(now_ms() - BACKUP_PUT_OFF_MAX_MS + 30_000);
        rig.core.idle_pass().await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(newest(), first.backup_id);

        // The longest wait has passed and a wake is in flight still: the backup is taken while
        // the database stays up and in use.
        db.view().backup_put_off_ms = Some(now_ms() - BACKUP_PUT_OFF_MAX_MS);
        rig.core.idle_pass().await;
        eventually(30, "the backup of a database that is used", || {
            newest() != first.backup_id
        })
        .await;
        eventually(5, "the wait forgotten", || {
            db.view().backup_put_off_ms.is_none()
        })
        .await;
        assert_eq!(db.phase(), Phase::Ready);
        assert!(rig.machine.running(&entry.id));
        wake.failed();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_that_sleeps_without_its_backup_waits_anew_at_its_next_wake() {
        let Some(rig) = Rig::new("backup-put-off-forgotten").await else {
            return;
        };
        let (entry, db, _gateway) = idle_with_a_backup_due(&rig).await;
        let first = db.state().unwrap().backup.unwrap();

        // Put off, and reclaimed for a wake that waits for room after the longest wait: asleep
        // without its backup.
        let wake = wake_on_the_node(&rig).await;
        rig.core.idle_pass().await;
        assert!(db.view().backup_put_off_ms.is_some());
        db.view().backup_put_off_ms = Some(now_ms() - 2 * BACKUP_PUT_OFF_MAX_MS);
        let early = Why::Early {
            for_database: "another-database".into(),
        };
        assert_eq!(rig.core.sleep(&db, early).await, Slept::Proven);
        assert_eq!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id
        );

        // What it waited in that session is not counted in the next: put off again, though a
        // wake is in flight and the old wait is over.
        let woken = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(woken.outcome, WakeOutcome::Started, "{woken:?}");
        db.view().awake_since_ms = Some(now_ms() - 2 * BACKUP_AFTER_WAKE_MS);
        rig.core.idle_pass().await;
        assert_eq!(db.phase(), Phase::Ready);
        assert!(
            db.view()
                .backup_put_off_ms
                .is_some_and(|since| { now_ms() - since < BACKUP_PUT_OFF_MAX_MS })
        );
        wake.failed();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_waits_for_memory_puts_the_database_that_nobody_uses_to_sleep_early() {
        let Some(mut rig) = Rig::new("early-sleep").await else {
            return;
        };
        rig.machine.direct_archive();
        // The wake waits up to 20 s for room; early sleep is on, and any database that nobody
        // uses at the moment may be chosen.
        let mut page = crate::link::test_server::vector("NodeDesiredPage", "full-page");
        page["policy"]["admission"]["queue_wait_ms"] = json!(20_000);
        page["policy"]["early_sleep"]["min_idle_seconds"] = json!(0);
        rig.core
            .set_policy(super::super::Policy::parse(&page["policy"]).unwrap());
        let (a, a_db) = rig.create().await;
        let (b, b_db) = rig.create().await;
        assert_eq!(rig.core.sleep(&b_db, Why::Idle).await, Slept::Proven);
        // No memory for a second database.
        rig.machine.set_available_bytes(300 << 20);
        let core = rig.core.clone();
        let ticket = Rig::ticket(&b);
        let waiting = tokio::spawn(async move { core.wake(&ticket).await });
        let order = tokio::time::timeout(Duration::from_secs(10), rig.early.recv())
            .await
            .expect("an early sleep for the waiting wake")
            .unwrap();
        assert_eq!(
            (order.database.as_str(), order.for_database.as_str()),
            (a.id.as_str(), b.id.as_str())
        );
        rig.core.early_sleep(order).await;
        assert_eq!(a_db.phase(), Phase::Asleep);
        // A frees its memory, a while later: the wake that waited is admitted.
        tokio::time::sleep(Duration::from_secs(2)).await;
        rig.machine.set_available_bytes(8 << 30);
        let result = waiting.await.unwrap();
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        let queued = result.steps_ms.get("queue_wait").copied().unwrap_or(0);
        assert!(queued >= 2_000, "{result:?}");
        assert_eq!(b_db.phase(), Phase::Ready);
        // The steal window of its detail starts when the start is asked for, after the wait.
        let detail_of_b = || {
            crate::events::seen()
                .into_iter()
                .find(|e| e["event"] == "wake_detail" && e["database_id"] == b.id.as_str())
        };
        eventually(10, "the detail", || detail_of_b().is_some()).await;
        let window = detail_of_b().unwrap()["fields"]["steal_window_ms"]
            .as_u64()
            .unwrap();
        assert!(
            window < queued,
            "window {window} ms, queue_wait {queued} ms"
        );
        let events = rig.core.take_events();
        assert!(events.iter().any(|e| e["type"] == "early_sleep"
            && e["database"] == a.id.as_str()
            && e["for_database"] == b.id.as_str()));
        assert!(contract_valid(
            "NodeEventReport",
            &json!({"events": events})
        ));
    }

    // ---- the CPU burst after a wake (policy.admission.cpu_boost_ms)

    /// The rig's agent applies the CPU quota `window` after a wake.
    fn boost(rig: &Rig, window: Duration) {
        let mut policy = rig.core.policy();
        policy.admission.admission.cpu_boost_ms = u64::try_from(window.as_millis()).unwrap();
        rig.core.set_policy(policy);
    }

    /// Found live on EU1 (2026-10-20, 59 sm-class databases woken after an hour): the quota applied
    /// at the release throttled the first request, the start-up and the reading of the buffer list
    /// in 19 of about 25 periods, and the whole request took 2.0 s at p50 against 0.3 s awake.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_woken_database_gets_its_quota_once_after_the_boost_and_with_the_wake_at_zero() {
        let Some(rig) = Rig::new("cpu-boost").await else {
            return;
        };
        let window = Duration::from_millis(1500);
        boost(&rig, window);
        let (entry, db) = rig.create().await;
        let quota = NonZeroU32::new(250);
        // A build is no wake: its quota comes with ready, whatever the policy says.
        assert_eq!(rig.machine.quota(&entry.id), Some(quota));
        assert!(!db.boosting());
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        assert_eq!(rig.machine.quota(&entry.id), Some(None), "a stop lifts it");

        let began = Instant::now();
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert!(rig.machine.running(&entry.id));
        assert_eq!(
            rig.machine.quota(&entry.id),
            Some(None),
            "released, no quota"
        );
        assert!(db.boosting());
        tokio::time::sleep(window / 2).await;
        assert_eq!(
            rig.machine.quota(&entry.id),
            Some(None),
            "inside the window"
        );
        eventually(10, "the quota after the boost", || {
            rig.machine.quota(&entry.id) == Some(quota)
        })
        .await;
        assert!(began.elapsed() >= window, "{:?}", began.elapsed());
        // Not twice: nothing else sets it while the database runs on.
        tokio::time::sleep(window).await;
        assert_eq!(rig.machine.quota_calls(&entry.id), [quota, quota]);

        // At zero the quota comes with the wake, as before the burst existed.
        boost(&rig, Duration::ZERO);
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(rig.machine.quota(&entry.id), Some(quota));
        assert!(!db.boosting());
        assert_eq!(rig.machine.quota_calls(&entry.id), [quota, quota, quota]);
    }

    /// The timer is one bounded task of the wake, and a stop ends it: a quota set on a stopped
    /// unit would outlive the stop and throttle the next start. A later wake has a window of its
    /// own, which the earlier wake's timer does not cut short.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_sleep_ends_the_boost_and_the_next_wake_has_a_boost_of_its_own() {
        let Some(rig) = Rig::new("cpu-boost-sleep").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let quota = NonZeroU32::new(250);
        let window = Duration::from_millis(4000);
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        boost(&rig, window);
        let ticket = Rig::ticket(&entry);

        let first = Instant::now();
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        assert!(db.boosting());
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let second = Instant::now();
        assert!(
            second.duration_since(first) < window / 2,
            "the sleep was slow"
        );
        assert!(!db.boosting(), "the sleep ended the timer");
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        assert!(db.boosting());
        assert!(second.duration_since(first) > Duration::from_millis(100));

        // Past the end of the first wake's window the unit still has no quota.
        tokio::time::sleep_until((first + window + Duration::from_millis(100)).into()).await;
        assert_eq!(rig.machine.quota(&entry.id), Some(None));
        assert_eq!(
            rig.machine.quota_calls(&entry.id),
            [quota],
            "the build's only"
        );
        eventually(10, "the quota after the second window", || {
            rig.machine.quota(&entry.id) == Some(quota)
        })
        .await;
        assert!(second.elapsed() >= window, "{:?}", second.elapsed());
        assert_eq!(rig.machine.quota_calls(&entry.id), [quota, quota]);
    }

    /// A resize inside the window changes the quota that follows it: the entry at the time counts.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_quota_after_the_boost_is_the_class_the_database_has_by_then() {
        let Some(rig) = Rig::new("cpu-boost-resize").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        boost(&rig, Duration::from_millis(1500));
        let ticket = Rig::ticket(&entry);
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        assert_eq!(rig.machine.quota(&entry.id), Some(None));
        // The page catches up with the wake and names a bigger class.
        let bigger = Entry {
            generation: ticket.generation,
            operation: ticket.operation.clone(),
            cpu_millicores: 500,
            ..entry.clone()
        };
        assert!(rig.core.accept(&db, bigger));
        eventually(10, "the quota of the new class", || {
            rig.machine.quota(&entry.id) == Some(NonZeroU32::new(500))
        })
        .await;
    }

    /// An agent that restarts inside a window has lost its timer: it applies the quota at once to
    /// what it finds running, whatever the policy says.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_applies_the_quota_to_a_unit_it_finds_inside_a_boost() {
        let Some(rig) = Rig::new("cpu-boost-restart").await else {
            return;
        };
        rig.machine.direct_archive();
        let mut json = rig.entry_json();
        let id = json["id"].as_str().unwrap().to_string();
        let page = |json: &Value| {
            let mut page = Rig::page(vec![json.clone()], vec![]);
            page.policy["admission"]["cpu_boost_ms"] = json!(60_000);
            page
        };
        rig.core.apply(&page(&json)).await;
        let db = rig.core.db(&id);
        eventually(90, "ready", || db.phase() == Phase::Ready).await;
        json.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let ticket = Rig::ticket(&rig.entry_for(&json));
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        assert_eq!(
            rig.machine.quota(&id),
            Some(None),
            "inside a window of a minute"
        );

        let rig = rig.restart().await;
        rig.deliver(json["archive"]["path"].as_str().unwrap(), "read_write");
        rig.core.apply(&page(&json)).await;
        let found = rig.core.db(&id);
        eventually(20, "the unit and its quota", || {
            found.phase() == Phase::Ready && rig.machine.quota(&id) == Some(NonZeroU32::new(250))
        })
        .await;
        assert!(!found.boosting());
    }

    /// Found by review: the timer waits for the database's flow lock, and the daily base backup of
    /// an always-warm database holds it for as long as it takes (minutes for 10 GiB), so the burst
    /// outlasted its window by that time. Such a database is woken after a long suspend or a node
    /// reboot, which is when its backup is due. The backup ends the burst before it begins.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_base_backup_that_begins_inside_a_boost_ends_it_before_it_takes_the_flow() {
        let Some(rig) = Rig::new("cpu-boost-backup").await else {
            return;
        };
        let mut json = rig.entry_json();
        json["sleep_after_seconds"] = Value::Null;
        let entry = rig.entry_for(&json);
        let db = rig.core.db(&entry.id);
        assert!(rig.core.accept(&db, entry.clone()));
        {
            let _flow = db.lock.lock().await;
            rig.core.build(&db, &entry).await.unwrap();
        }
        let first = db.state().unwrap().backup.unwrap();
        let quota = NonZeroU32::new(250);
        assert_eq!(rig.core.sleep(&db, Why::Order).await, Slept::Proven);
        // A day later it is woken, and its backup is due. The base backup takes 6 s.
        age_backup(&rig, &db);
        rig.fixture.set("backup-delay", "6");
        boost(&rig, Duration::from_secs(1));
        let ticket = Rig::ticket(&entry);
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        assert_eq!(rig.machine.quota(&entry.id), Some(None));
        assert!(db.boosting());

        // The contract's longest burst is as long as the first minute that a backup waits for, so
        // a backup begins inside a burst only at that edge: this burst is made to outlast it.
        db.view().awake_since_ms = Some(now_ms() - 2 * BACKUP_AFTER_WAKE_MS);
        // The idle pass starts the backup, which holds the flow of the database.
        rig.core.idle_pass().await;
        eventually(4, "the quota before the base backup is over", || {
            rig.machine.quota(&entry.id) == Some(quota)
        })
        .await;
        assert!(db.lock.try_lock().is_err(), "the backup holds the flow");
        assert_eq!(
            db.state().unwrap().backup.unwrap().backup_id,
            first.backup_id,
            "the base backup is not over"
        );
        assert!(!db.boosting());

        // The backup ends, and nothing applies the quota again.
        eventually(30, "the daily backup", || {
            db.state()
                .and_then(|state| state.backup)
                .is_some_and(|backup| backup.backup_id != first.backup_id)
        })
        .await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(rig.machine.quota_calls(&entry.id), [quota, quota]);
        assert_eq!(db.phase(), Phase::Ready);
    }

    // ---- the slots (package P-e)

    /// The wake log lines of `database` this process kept, oldest first.
    fn wake_events(database: &str) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| event["event"] == "wake" && event["database_id"] == database)
            .collect()
    }
    fn detail_events(database: &str) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| event["event"] == "wake_detail" && event["database_id"] == database)
            .collect()
    }

    /// A wake takes one path whether the pool had a slot or not. The phases of the wake and its
    /// detail say which: a slot built before the wake costs the wake the bind alone, and one built
    /// inside it also the sandbox.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_from_the_pool_and_a_wake_on_demand_take_the_same_path_and_the_phases_say_which()
    {
        let timing = crate::agent::Timing {
            detail: Duration::from_millis(200),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("pool-or-demand", timing).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        // Nothing builds slots here but the refill, which a test asks for.
        rig.machine.drain_idle_slots().await;
        assert_eq!(rig.machine.slots().idle, 0);

        // A miss: the wake builds its slot inside its admission.
        let ticket = Rig::ticket(&entry);
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        let phases = wake_events(&entry.id).pop().unwrap()["fields"].clone();
        for phase in ["admission", "slot", "bind", "start", "roles", "release"] {
            assert!(
                phases.get(format!("step_{phase}")).is_some(),
                "{phase}: {phases}"
            );
        }
        eventually(10, "the detail of the miss", || {
            !detail_events(&entry.id).is_empty()
        })
        .await;
        assert_eq!(detail_events(&entry.id)[0]["fields"]["slot_from"], "demand");

        // A hit: the refill built the pool before the wake.
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.core.refill_pass().await;
        assert_eq!(
            rig.machine.slots().idle,
            4,
            "start_concurrency of the policy"
        );
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(rig.machine.slots().idle, 3);
        eventually(10, "the detail of the hit", || {
            detail_events(&db.id).len() == 2
        })
        .await;
        let hit = detail_events(&db.id).pop().unwrap();
        assert_eq!(hit["fields"]["slot_from"], "pool");
        // No sandbox was built inside the wake: the supervisor's fork and handoff are no part
        // of a hit's detail.
        assert!(hit["fields"].get("job_to_fork_us").is_none(), "{hit}");
    }

    /// A start that finds no idle slot builds it inside its permit, so the starts at once bound
    /// the builds at once: with one start at a time, a second wake does not build while the first
    /// start is in flight.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pool_miss_builds_inside_the_permit_so_start_concurrency_bounds_the_builds() {
        let Some(rig) = Rig::new("miss-in-permit").await else {
            return;
        };
        rig.core
            .set_policy(crate::agent::testing::policy_with_start_concurrency(Some(
                1,
            )));
        // One database awake at a time while they are made: the test machine tells the callers
        // of the archive socket apart only when a single database holds a slot.
        let (first, first_db) = rig.create().await;
        assert_eq!(rig.core.sleep(&first_db, Why::Idle).await, Slept::Proven);
        let (second, second_db) = rig.create().await;
        assert_eq!(rig.core.sleep(&second_db, Why::Idle).await, Slept::Proven);
        rig.machine.drain_idle_slots().await;

        // The first start is in flight for a while: its slot is the only one the node has built.
        rig.machine.delay_next_start(Duration::from_millis(1200));
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&first));
        let waking = tokio::spawn(async move { core.wake(&ticket).await });
        eventually(10, "the first start to be ordered", || {
            rig.machine.running(&first.id)
        })
        .await;
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&second));
        let queued = tokio::spawn(async move { core.wake(&ticket).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            rig.machine.slots(),
            crate::units::slots::Snapshot {
                idle: 0,
                spawning: 0,
                held: 1
            },
            "the waiting wake has built nothing"
        );
        assert_eq!(waking.await.unwrap().outcome, WakeOutcome::Started);
        assert_eq!(queued.await.unwrap().outcome, WakeOutcome::Started);
        assert_eq!(rig.machine.slots().held, 2);
        let second_detail = |event: &Value| event["fields"]["slot_from"] == "demand";
        eventually(10, "both details", || {
            detail_events(&second.id).iter().any(second_detail)
        })
        .await;
    }

    /// The refill builds nothing while a start is in flight or waits, nor on a node that is fenced
    /// or in maintenance, and builds one slot at a time up to `start_concurrency` when the node is
    /// quiet.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_refill_pauses_while_a_start_is_in_flight_and_while_the_node_is_fenced_or_in_maintenance()
     {
        let Some(rig) = Rig::new("refill-pause").await else {
            return;
        };
        rig.core
            .set_policy(crate::agent::testing::policy_with_start_concurrency(Some(
                2,
            )));
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.drain_idle_slots().await;

        rig.machine.delay_next_start(Duration::from_millis(1200));
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&entry));
        let waking = tokio::spawn(async move { core.wake(&ticket).await });
        eventually(10, "the start to be ordered", || {
            rig.machine.running(&entry.id)
        })
        .await;
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 0, "a start is in flight");
        assert_eq!(waking.await.unwrap().outcome, WakeOutcome::Started);

        // Quiet: two idle slots, as many as the starts at once.
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 2);
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 2, "no more than the target");

        // In maintenance the idle slots stop and none is built.
        rig.core.maintenance.store(true, Ordering::Relaxed);
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 0);
        rig.core.maintenance.store(false, Ordering::Relaxed);
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 2);
        // A fence stops them too, and the node builds none while it stands.
        rig.core.fences.fence("op_ffffffffffffffffffff").unwrap();
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 0);
    }

    /// The refill makes the users of the whole range once the idle slots are in place, one at a
    /// time and only while the node is quiet: a start in flight makes none, and then a storm of
    /// wakes cannot run out of numbers with a user, which a wake never makes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_refill_makes_the_users_of_the_whole_range_while_the_node_is_quiet() {
        let Some(rig) = Rig::new("refill-users").await else {
            return;
        };
        rig.core
            .set_policy(crate::agent::testing::policy_with_start_concurrency(Some(
                2,
            )));
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.drain_idle_slots().await;
        // A node just installed: the users of the first four numbers exist.
        rig.machine.limit_slot_users(4).await;
        assert_eq!(rig.machine.slot_users(), 4);

        // A start is in flight: the refill makes no slot and no user.
        rig.machine.delay_next_start(Duration::from_millis(1200));
        let (core, ticket) = (rig.core.clone(), Rig::ticket(&entry));
        let waking = tokio::spawn(async move { core.wake(&ticket).await });
        eventually(10, "the start to be ordered", || {
            rig.machine.running(&entry.id)
        })
        .await;
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slot_users(), 4, "a start is in flight");
        assert_eq!(waking.await.unwrap().outcome, WakeOutcome::Started);

        // Quiet: the idle slots first, then every number of the range has its user.
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 2);
        assert_eq!(
            rig.machine.slot_users(),
            crate::units::slots::POOL.len(),
            "the users of the whole range, and none for the health check's slot"
        );
    }

    /// A build that fails does not end the refill's pass before the next user is made: on a node
    /// that has only the user of a number whose unit refuses to start, the pass makes the next
    /// user and builds the idle slot there, and the number that failed stays out of it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_failed_build_does_not_end_the_refill_before_it_makes_the_next_user() {
        let Some(rig) = Rig::new("refill-failed-build").await else {
            return;
        };
        rig.core
            .set_policy(crate::agent::testing::policy_with_start_concurrency(Some(
                1,
            )));
        rig.machine.drain_idle_slots().await;
        // A node just installed: only the user of number 0 exists, and its unit holds a process.
        rig.machine.limit_slot_users(1).await;
        rig.machine.stray_slot(0);

        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 1, "built on the next number");
        assert_eq!(
            rig.machine.slot_users(),
            crate::units::slots::POOL.len(),
            "and the quiet pass went on to the users of the whole range"
        );
    }

    /// A bind that cannot move the mounts in leaves the database asleep with its proof: the order
    /// is not sent, no PostgreSQL ran, and the next wake works.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_bind_that_fails_leaves_the_database_asleep_with_its_proof_and_starts_nothing() {
        let Some(rig) = Rig::new("bind-fails").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        let record = db.state().unwrap().record.clone();
        assert!(record.is_some());
        rig.machine.clear_calls();

        rig.machine.fail_next_handoff();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("release_failed"))
        );
        assert!(
            !rig.machine
                .calls()
                .iter()
                .any(|call| call.starts_with("start")),
            "{:?}",
            rig.machine.calls()
        );
        assert!(!rig.machine.running(&entry.id));
        assert_eq!(db.phase(), Phase::Asleep);
        assert_eq!(db.state().unwrap().record, record, "the proof stands");
        assert_eq!(
            rig.machine.slots().held,
            0,
            "the slot is gone with the database"
        );
        let failed = crate::events::seen().into_iter().find(|event| {
            event["event"] == "unit_start_failed" && event["database_id"] == entry.id.as_str()
        });
        assert_eq!(
            failed.expect("a failed start is an event")["fields"]["class"],
            "job_assert"
        );

        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
    }

    /// The agent holds the data directory's lock while it writes the configuration of a database
    /// that sleeps, and a process that holds it keeps the write, and the wake, from happening:
    /// the configuration file is not rewritten, and the bind takes no slot.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_whose_data_directory_is_locked_is_neither_configured_nor_woken() {
        let Some(rig) = Rig::new("locked-data").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        // An idle slot, which a wake that is not refused takes.
        rig.core.refill_pass().await;
        let idle = rig.machine.slots().idle;
        assert!(idle > 0);
        let conf = rig.machine.layout().data(&entry.id).join("postgresql.conf");
        let before = std::fs::read(&conf).unwrap();
        // A process of the earlier postmaster still holds the data directory.
        let held = std::fs::File::open(rig.machine.layout().data(&entry.id)).unwrap();
        held.lock().unwrap();

        // The data directory is locked and the size does not change: the bind is refused by its
        // own try-lock, before it takes a slot.
        let ticket = Rig::ticket(&entry);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("release_failed")),
            "{result:?}"
        );
        assert_eq!(rig.machine.slots().idle, idle, "no slot was taken");
        assert_eq!(rig.machine.slots().held, 0);

        // A change of the size changes what the configuration says, so the next wake writes it:
        // the write is refused by the lock, and the file is the one it was.
        let mut changed = entry.clone();
        changed.max_connections += 1;
        assert!(rig.core.accept(&db, changed));
        let ticket = Rig::ticket(&rig.core.db(&entry.id).view().entry.clone().unwrap());
        let result = rig.core.wake(&ticket).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("release_failed")),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read(&conf).unwrap(),
            before,
            "postgresql.conf was not rewritten under a lock"
        );
        assert_eq!(rig.machine.slots().idle, idle, "no slot was taken");
        assert!(!rig.machine.running(&entry.id));

        // Without the lock the same wake writes the new configuration and starts.
        drop(held);
        let result = rig.core.wake(&ticket).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_ne!(
            std::fs::read(&conf).unwrap(),
            before,
            "the new size is written"
        );
    }
}
