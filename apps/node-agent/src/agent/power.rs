// SPDX-License-Identifier: Apache-2.0
//! Starting and stopping PostgreSQL (plan 4.6, 4.7, 5.9, 7.9, 7.10): a wake, the sleep with its
//! proof, the recovery of a database that stopped without one, and the watches that start them.
use super::{Claim, Core, Db, Desired, Entry, Phase, View, now_ms, report::uuid};
use crate::{
    Error,
    admission::{AdmitError, EarlySleep, Request},
    archive::server::{Registration, Table},
    cache::Residency,
    layout::Layout,
    machine::{CpuTimes, Machine, Throttle},
    proof::{self, Outcome, Proof, Steps, WakeRefusal},
    sleep::Refusal,
    state::{DatabaseState, ProvenSleepRecord},
    storage::VolumeId,
    units::{Started, Timeline},
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

/// How long the `wake_detail` waits for the reading of the page cache, which began with the wake,
/// seconds before: one that is not done by then is stuck on a slow disk, and the event goes
/// without its numbers.
const CACHE_WAIT: Duration = Duration::from_millis(50);

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

/// How a wake ticket does not match the entry of the page the node holds: the reason behind a
/// `desired_stale` refusal, named in the wake event's `stale` (`WAKE_STALE` of the contract).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stale {
    /// The node holds no entry for the database.
    NoEntry,
    /// The ticket's generation is neither the next one, nor the entry's, nor a claim's.
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
/// be read. `throttle` is the throttling since the release, `steal` the stolen CPU time and the
/// window it was counted over, `cache` what the page cache held of the database's files before
/// its unit started.
fn detail_line(
    database: &str,
    timeline: &Timeline,
    throttle: Option<Throttle>,
    steal: Option<(u64, u64)>,
    cache: Option<Residency>,
) -> serde_json::Value {
    let mut line = json!({"event": "wake_detail", "database_id": database});
    let startup = timeline.startup.as_ref();
    for (name, value) in [
        ("job_to_fork_us", timeline.job_to_fork_us),
        ("fork_to_handoff_us", timeline.fork_to_handoff_us),
        (
            "handoff_to_starting_us",
            startup.map(|s| s.handoff_to_starting_us),
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
        ("cache_files", cache.map(|c| c.files)),
        ("cache_pages", cache.map(|c| c.pages)),
        ("cache_resident", cache.map(|c| c.cached.resident)),
        ("cache_dirty", cache.map(|c| c.cached.dirty)),
        ("cache_evicted", cache.map(|c| c.cached.evicted)),
        (
            "cache_recently_evicted",
            cache.map(|c| c.cached.recently_evicted),
        ),
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

    /// Starts the unit of `entry` through admission and waits for PostgreSQL to accept
    /// connections, up to `deadline`: the start itself goes on after it. The admission decision is
    /// an event. It gives the unit, how long admission made the start wait, and the CPU times read
    /// just before the unit was asked to start.
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
            // The database is awake, starting or already waiting: it is admitted.
            Err(AdmitError::Duplicate) => {
                let mark = (Instant::now(), self.machine.cpu());
                let started = self
                    .machine
                    .start(&db.id)
                    .await
                    .map_err(|_| StartFailure::Failed)?;
                return Ok((started, Duration::ZERO, mark));
            }
            Err(AdmitError::Stopped) => return Err(StartFailure::Failed),
        };
        let waited = permit.waited;
        self.event(event("admitted", waited, None));
        let mark = (Instant::now(), self.machine.cpu());
        let running = self.machine.start(&db.id);
        let outcome = match deadline {
            Some(deadline) => tokio::time::timeout(deadline, running).await,
            None => Ok(running.await),
        };
        match outcome {
            Ok(Ok(started)) => {
                permit.ready();
                Ok((started, waited, mark))
            }
            Ok(Err(_)) => {
                // A unit that is awake still holds its memory: the permit stays counted until its
                // unit is reported stopped. One that is not awake never started.
                let awake = self.unit_awake(&db.id, true).await;
                if !awake {
                    permit.failed();
                }
                Err(StartFailure::Failed)
            }
            Err(_) => {
                // The start goes on: the agent waits for it, and a database that comes up late is
                // an awake database with nobody asking (it sleeps at its idle time).
                let (core, id) = (self.clone(), db.id.clone());
                tokio::spawn(async move {
                    match core.machine.wait_started(&id).await {
                        Ok(started) => {
                            permit.ready();
                            if let Some(db) = core.find(&id) {
                                core.late_start(&db, started).await;
                            }
                        }
                        Err(_) => {
                            let awake = core.unit_awake(&id, true).await;
                            if !awake {
                                permit.failed();
                            }
                            if let Some(db) = core.find(&id) {
                                core.late_failure(&db).await;
                            }
                        }
                    }
                });
                Err(StartFailure::Timeout)
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
        self.after_ready(db).await;
    }

    /// A start that outlasted its wake and gave no database that accepts connections: a unit that
    /// is down leaves the database as the wake found it, one that runs anyway is stopped.
    async fn late_failure(self: &Arc<Self>, db: &Arc<Db>) {
        let _flow = db.lock.lock().await;
        if db.phase() != Phase::Starting {
            return;
        }
        if self.unit_awake(&db.id, true).await {
            self.stop_unproven(db).await;
        } else {
            self.set(db, |view| view.phase = Phase::Asleep);
        }
    }

    /// A unit that runs but cannot be released: stopped without a proof, so recovery proves it.
    async fn stop_unproven(self: &Arc<Self>, db: &Arc<Db>) {
        let _ = self.machine.stop(&db.id).await;
        self.admission.stopped(&db.id);
        self.go_unproven(db);
    }

    /// Off the path of a wake, once PostgreSQL is released: the CPU quota of the database's size.
    pub(crate) async fn after_ready(&self, db: &Db) {
        let millicores = db
            .view()
            .entry
            .as_ref()
            .and_then(|entry| NonZeroU32::new(entry.cpu_millicores));
        let _ = self.machine.set_cpu_quota(&db.id, millicores).await;
    }

    // ---- wake

    /// The gateway's wake (plan 5.9): checks the ticket against what the node knows, the volume
    /// against the proven-sleep record, and starts PostgreSQL through admission. The answer is the
    /// gateway's to release or refuse its held connections with.
    pub async fn wake(self: &Arc<Self>, request: &WakeRequest) -> WakeResult {
        let begun = Instant::now();
        let mut steps = BTreeMap::new();
        let mut stale = None;
        let outcome = self.try_wake(request, &mut steps, &mut stale).await;
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
        // What the page cache holds of the database's files is read before the unit starts, in a
        // task the wake does not wait for; its numbers join the detail event (`detail_later`).
        let cache = self.read_cache(&db.id);
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
                Some(self.timing.wake_start),
            )
            .await;
        let (started, waited, steal) = match started {
            Ok(started) => started,
            Err(failure) => {
                if !matches!(failure, StartFailure::Timeout) {
                    self.after_failed_start(&db).await;
                }
                if let StartFailure::Refused(refused) = &failure {
                    steps.insert("queue_wait".into(), millis(refused.waited));
                    self.set(&db, |view| view.phase = Phase::Asleep);
                }
                return Err(failure.wake_reason());
            }
        };
        steps.insert("queue_wait".into(), millis(waited));
        steps.insert(
            "start".into(),
            millis(began.elapsed().saturating_sub(waited)),
        );
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
        self.detail_later(&db, started, steal, cache);
        self.after_ready(&db).await;
        Ok(())
    }

    /// Reads what the page cache holds of the database's files in a task of its own, which holds
    /// no lock of the wake and which the wake never waits for.
    fn read_cache(&self, database: &str) -> tokio::task::JoinHandle<Option<Residency>> {
        let (machine, database) = (self.machine.clone(), database.to_string());
        tokio::task::spawn_blocking(move || machine.cache_residency(&database))
    }

    /// Off the path of a wake, once its writer is released: one `wake_detail` event, read
    /// `Timing::detail` later, when the login and the first statements are over. The CPU quota is
    /// applied right after the release, so its throttling in between is in the event. `cache` is
    /// the reading of the page cache that began before the start; it is joined here, for at most
    /// `CACHE_WAIT`.
    fn detail_later(
        self: &Arc<Self>,
        db: &Db,
        started: Started,
        steal: CpuMark,
        cache: tokio::task::JoinHandle<Option<Residency>>,
    ) {
        let (core, database) = (self.clone(), db.id.clone());
        tokio::spawn(async move {
            let throttle = core.machine.throttle(&database);
            tokio::time::sleep(core.timing.detail).await;
            let cache = tokio::time::timeout(CACHE_WAIT, cache)
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
            let line = core
                .wake_detail(&database, &started, steal, throttle, cache)
                .await;
            crate::timing::emit_event(line);
        });
    }

    /// What the unit, the journal and the kernel say of a start that was released: the time to
    /// the fork, to the handoff and to the three messages of PostgreSQL's start, the CPU quota's
    /// throttling since the release, the steal time since the unit was asked to start, and the
    /// page cache's share of the database's files before the start. `steal`, `throttle` and
    /// `cache` are the readings from then.
    async fn wake_detail(
        &self,
        database: &str,
        started: &Started,
        steal: CpuMark,
        throttle: Option<Throttle>,
        cache: Option<Residency>,
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
            cache,
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

    /// A start that failed: the database is not awake. What it was before is what it is now.
    async fn after_failed_start(&self, db: &Db) {
        if self.unit_awake(&db.id, false).await {
            return;
        }
        // A start that fails for a unit that crashed in recovery leaves the data directory as it
        // was: the next wake finds it unproven by `pg_control`.
        self.set(db, |view| view.phase = Phase::Asleep);
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
        // is never woken for one.
        if matches!(why, Why::Idle)
            && let Err(error) = self.backup_if_due(db, &entry).await
        {
            crate::timing::emit_event(json!({
                "event": "backup_failed", "database_id": db.id, "error": error,
            }));
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
        let Some(store) = self.store(&entry.archive_path, crate::credentials::Access::ReadWrite)
        else {
            return false;
        };
        let upload_log = self.files(&db.id).upload_log(entry.storage_generation);
        if self.table.archives(account.uid, &store, &upload_log) {
            return true;
        }
        register(
            &self.table,
            self.layout(),
            &self.job_database(&volume, &account.name),
            account.uid,
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
            let (entry, since, backup) = {
                let view = db.view();
                if view.phase != Phase::Ready {
                    continue;
                }
                (
                    view.entry.clone(),
                    view.awake_since_ms,
                    view.state.as_ref().and_then(|state| state.backup.clone()),
                )
            };
            let Some(entry) = entry else { continue };
            if entry.sleep_after_seconds.is_none()
                && super::build::backup_due(backup.as_ref(), None, now_ms())
            {
                self.spawn_daily_backup(&db);
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

    /// The daily base backup of an always-warm database (plan 7.6), off the idle pass. A flow
    /// that runs on the database now, a backup among them, puts it off to the next pass.
    fn spawn_daily_backup(self: &Arc<Self>, db: &Arc<Db>) {
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
    uid: u32,
    store: crate::archive::job::Store,
    upload_log: crate::archive::upload_log::UploadLog,
) {
    table.set(Registration {
        database: database.clone(),
        uid,
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
    use crate::cache::Pages;
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
                handoff_to_starting_us: 12_840,
                starting_to_shut_down_us: 1_605,
                shut_down_to_ready_us: 1_522,
            }),
        };
        // The quota throttled the unit twice since the release; 3 ticks of 10 ms were stolen.
        let throttled = throttle_since(throttle(0, 0), throttle(2, 7_500));
        let stolen = steal_since((Instant::now(), cpu(10)), cpu(13));
        assert_eq!(throttled, throttle(2, 7_500));
        let (steal_ms, _window) = stolen.unwrap();
        assert_eq!(steal_ms, 30);
        // Before the start 10,240 of the 16,384 pages of 41 files were in the page cache.
        let cached = Some(Residency {
            files: 41,
            pages: 16_384,
            cached: Pages {
                resident: 10_240,
                dirty: 7,
                evicted: 5_900,
                recently_evicted: 310,
            },
        });
        let line = detail_line("abcdefghijklmnopqrst", &timeline, throttled, stolen, cached);
        assert_eq!(
            line,
            json!({
                "event": "wake_detail", "database_id": "abcdefghijklmnopqrst",
                "job_to_fork_us": 2_300, "fork_to_handoff_us": 33_886,
                "handoff_to_starting_us": 12_840, "starting_to_shut_down_us": 1_605,
                "shut_down_to_ready_us": 1_522,
                "nr_throttled": 2, "throttled_usec": 7_500, "steal_ms": 30,
                "steal_window_ms": line["steal_window_ms"],
                "cache_files": 41, "cache_pages": 16_384, "cache_resident": 10_240,
                "cache_dirty": 7, "cache_evicted": 5_900, "cache_recently_evicted": 310,
            })
        );
        // What the node sends of it is what Cloudflare accepts: 15 of the 16 fields.
        let at = "2026-10-18T10:11:12.345Z";
        let event = crate::events::sanitize(&line, at).unwrap();
        assert_eq!(event["fields"].as_object().unwrap().len(), 15);
        assert!(contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": at, "databases": [], "orders": [], "events": [event]})
        ));

        // A journal that could not be read, a unit that is gone, a machine without a clock and a
        // page cache that was not read leave their numbers out; the counters that went back are
        // no reading.
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

        // This machine has no journal and no cgroup: the steal time of the window and the six
        // numbers of the page cache are all it reads. The cache numbers are those of the files of
        // the cluster the test made, counted before its start: the database was proven asleep
        // just before, so its files are in memory, written back and none evicted.
        eventually(10, "the detail", || !details().is_empty()).await;
        let detail = details().remove(0);
        let fields = detail["fields"].as_object().unwrap();
        assert!(fields["steal_ms"].is_u64() && fields["steal_window_ms"].as_u64() >= Some(1));
        let (files, pages) = (
            fields["cache_files"].as_u64(),
            fields["cache_pages"].as_u64(),
        );
        let resident = fields["cache_resident"].as_u64();
        assert!(
            files >= Some(3) && pages >= resident && resident >= Some(1),
            "{detail}"
        );
        for field in ["cache_dirty", "cache_evicted", "cache_recently_evicted"] {
            assert_eq!(fields[field], 0, "{field}");
        }
        assert_eq!(fields.len(), 8, "{detail}");

        // The same wake again finds the database released: no start, no detail.
        assert_eq!(rig.core.wake(&ticket).await.outcome, WakeOutcome::Started);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(details().len(), 1);
    }

    /// The reading of the page cache is not on the path of a wake and is not waited for: a disk
    /// that is slow to list its files delays neither the release nor the event, which then goes
    /// without the numbers of the cache.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_slow_reading_of_the_page_cache_holds_neither_the_wake_nor_its_detail() {
        let timing = crate::agent::Timing {
            detail: Duration::from_millis(600),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("wake-detail-slow-cache", timing).await else {
            return;
        };
        let (entry, db) = rig.create().await;
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.slow_cache(Duration::from_secs(6));

        let began = Instant::now();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert!(
            began.elapsed() < Duration::from_secs(5),
            "{:?}",
            began.elapsed()
        );
        let details = || -> Vec<Value> {
            crate::events::seen()
                .into_iter()
                .filter(|e| e["event"] == "wake_detail" && e["database_id"] == entry.id.as_str())
                .collect()
        };
        eventually(10, "the detail", || !details().is_empty()).await;
        let detail = details().remove(0);
        let fields = detail["fields"].as_object().unwrap();
        assert!(fields["steal_ms"].is_u64());
        assert!(
            fields.keys().all(|name| !name.starts_with("cache_")),
            "{detail}"
        );
        assert_eq!(fields.len(), 2, "{detail}");
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
        for (desired, wanted) in [
            (Desired::Suspended, "suspended"),
            (Desired::Deleted, "deleted"),
        ] {
            with(&|view| view.entry.as_mut().unwrap().desired = desired);
            assert_eq!(refused(rig.core.wake(&ticket).await), reason(wanted));
        }
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
    async fn a_start_that_outlasts_its_wake_and_then_fails_leaves_the_database_wakeable() {
        let timing = crate::agent::Timing {
            wake_start: Duration::from_millis(300),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("late-failure", timing).await else {
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
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (WakeOutcome::Refused, Some("start_timeout"))
        );

        // The start failed: the database is asleep as it was, not starting for ever, and the
        // next wake starts it once it can start.
        eventually(30, "the failed start to end", || {
            db.phase() == Phase::Asleep
        })
        .await;
        assert!(!rig.machine.running(&entry.id));
        std::fs::write(&auto, original).unwrap();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert_eq!(db.phase(), Phase::Ready);
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

        // A day later the database is woken and written to; its idle sleep takes a backup first.
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        age_backup(&rig, &db);
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
}
