// SPDX-License-Identifier: Apache-2.0
//! Starting and stopping PostgreSQL (plan 4.6, 4.7, 5.9, 7.9, 7.10): a wake, the sleep with its
//! proof, the recovery of a database that stopped without one, and the watches that start them.
use super::{Claim, Core, Db, Desired, Entry, Phase, View, now_ms, report::uuid};
use crate::{
    Error,
    admission::{AdmitError, EarlySleep, Request},
    archive::server::{Registration, Table},
    layout::Layout,
    machine::Machine,
    proof::{self, Outcome, Proof, Steps, WakeRefusal},
    sleep::Refusal,
    state::{DatabaseState, ProvenSleepRecord},
    storage::VolumeId,
    units::Started,
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

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros().div_ceil(1000))
        .unwrap_or(u64::MAX)
        .min(600_000)
}

/// The log line of a wake (plan 9.9): its outcome and reason, the milliseconds of every step and
/// of the whole wake. The observation report carries it to Cloudflare, where a cold wake's time
/// is broken down by node.
fn wake_line(result: &WakeResult, total_ms: u64) -> serde_json::Value {
    let mut line = json!({
        "event": "wake", "database_id": result.database, "outcome": result.outcome,
        "total_ms": total_ms,
    });
    if let Some(reason) = &result.reason {
        line["reason"] = reason.clone().into();
    }
    for (step, ms) in &result.steps_ms {
        line[format!("step_{step}")] = (*ms).into();
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
    /// an event.
    pub(crate) async fn start_unit(
        self: &Arc<Self>,
        db: &Db,
        entry: &Entry,
        start: StartAs<'_>,
        deadline: Option<Duration>,
    ) -> Result<(Started, Duration), StartFailure> {
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
                let started = self
                    .machine
                    .start(&db.id)
                    .await
                    .map_err(|_| StartFailure::Failed)?;
                return Ok((started, Duration::ZERO));
            }
            Err(AdmitError::Stopped) => return Err(StartFailure::Failed),
        };
        let waited = permit.waited;
        self.event(event("admitted", waited, None));
        let running = self.machine.start(&db.id);
        let outcome = match deadline {
            Some(deadline) => tokio::time::timeout(deadline, running).await,
            None => Ok(running.await),
        };
        match outcome {
            Ok(Ok(started)) => {
                permit.ready();
                Ok((started, waited))
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
        let outcome = self.try_wake(request, &mut steps).await;
        steps.insert("release".to_string(), 0);
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
        self.event(event);
        crate::timing::emit_event(wake_line(&result, millis(begun.elapsed())));
        result
    }

    async fn try_wake(
        self: &Arc<Self>,
        request: &WakeRequest,
        steps: &mut BTreeMap<String, u64>,
    ) -> Result<(), (&'static str, Option<u32>)> {
        let checking = Instant::now();
        let refuse = |reason: &'static str| Err((reason, None));
        if self.fences.fenced() {
            return refuse("fenced");
        }
        let Some(db) = self.find(&request.database) else {
            return refuse("desired_stale");
        };
        // The ticket is checked against the page's entry before anything waits for the database.
        let ticket = |view: &View| -> Result<(), &'static str> {
            let entry = view.entry.as_ref().ok_or("desired_stale")?;
            if self.fences.blocks(&db.id, entry.storage_generation) {
                return Err("superseded");
            }
            match entry.desired {
                Desired::Deleted => return Err("deleted"),
                Desired::Suspended => return Err("suspended"),
                Desired::Running => {}
            }
            if view.moving.is_some() {
                return Err("moving");
            }
            if self.maintenance.load(Ordering::Relaxed) {
                return Err("maintenance");
            }
            let claimed = view.claim.as_ref().is_some_and(|claim| {
                claim.generation == request.generation && claim.operation == request.operation
            });
            let next = request.generation == entry.generation + 1;
            let same =
                request.generation == entry.generation && request.operation == entry.operation;
            if request.route_revision != entry.route_revision
                || request.role_revision_hash != entry.role_hash()
                || !(next || same || claimed)
            {
                return Err("desired_stale");
            }
            Ok(())
        };
        {
            let view = db.view();
            if let Err(reason) = ticket(&view) {
                return refuse(reason);
            }
            // The node has not looked at the database in this run: the gateway asks again.
            if !view.adopted {
                return refuse("wake_in_progress");
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
            if let Err(reason) = ticket(&view) {
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
        match self.machine.has_volume(&volume).await {
            Ok(true) => {}
            _ => return refuse("volume_missing"),
        }
        match self.machine.needs_repair(&volume).await {
            Ok(false) => {}
            Ok(true) => {
                // The volume may have lost writes while the pool took none: recovery repairs it.
                self.go_unproven(&db);
                return refuse("volume_suspended");
            }
            Err(_) => return refuse("volume_missing"),
        }
        if !mounted(&self.layout().volume(&db.id)) {
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
        if let Err(error) = self.refresh_configuration(&db, &entry).await {
            crate::timing::emit_event(json!({
                "event": "configuration_failed", "database_id": db.id,
                "class": crate::diagnostics::error_code(&error),
            }));
            return refuse("release_failed");
        }
        self.ensure_archive(&db, &entry);
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
        let (started, waited) = match started {
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
        if let Err(reason) = self.refresh_roles(&db, &entry).await {
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
        self.after_ready(&db).await;
        Ok(())
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
        if !mounted(&self.layout().volume(&db.id))
            && self
                .machine
                .mount_volumes(std::slice::from_ref(&volume))
                .await
                .is_err()
        {
            return Recovered::Retry;
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
            &self.job_database(&db.id, &account.name),
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

/// Whether `path` is the root of a filesystem of its own: a mounted volume.
pub(crate) fn mounted(path: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let (Ok(dir), Some(Ok(parent))) = (
        std::fs::metadata(path),
        path.parent().map(std::fs::metadata),
    ) else {
        return false;
    };
    dir.dev() != parent.dev()
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
    use crate::{
        agent::testing::{Rig, eventually},
        node_link::contract_valid,
        postgres,
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
                .chain([("mount", 31), ("start", 61), ("release", 0)])
                .map(|(step, ms)| (step.to_string(), ms))
                .collect(),
        };
        let line = wake_line(&result, 230);
        assert_eq!(
            line,
            json!({
                "event": "wake", "database_id": "abcdefghijklmnopqrst", "outcome": "started",
                "total_ms": 230, "step_admission": 3, "step_queue_wait": 120,
                "step_pg_control": 4, "step_mount": 31, "step_start": 61, "step_release": 0,
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
        let refused = wake_line(&result, 9);
        assert_eq!(refused["outcome"], "refused");
        assert_eq!(refused["reason"], "no_headroom");
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
        for step in ["pg_control", "start", "admission"] {
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
        // A frees its memory: the wake that waited is admitted.
        rig.machine.set_available_bytes(8 << 30);
        let result = waiting.await.unwrap();
        assert_eq!(result.outcome, WakeOutcome::Started, "{result:?}");
        assert!(result.steps_ms.get("queue_wait").is_some_and(|ms| *ms > 0));
        assert_eq!(b_db.phase(), Phase::Ready);
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
