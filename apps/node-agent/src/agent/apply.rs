// SPDX-License-Identifier: Apache-2.0
//! The desired page and its orders become action (plan 5.2, 5.6 jobs 5, 7, 8, 9.4, 9.5): for each
//! database the node decides from the entry and from what it finds on its disk and in its units
//! what is to be done, and does it under the database's own flow. Only an explicit order or a
//! desired state stops or removes what runs (plan 3.3, invariant 7): a page that does not name a
//! database never does.
use super::{
    Core, Db, Desired, Entry, Phase, Policy, Reconcile, now_ms,
    power::{Slept, Why, writer_of},
};
use crate::{
    link::{Desired as Page, Order},
    machine::Machine,
    proof::{self, WakeRefusal},
    state::{DatabaseState, Resources},
    storage::Removal,
};
use pgcf_native_protocol::wake::{Outcome, WakeRequest};
use serde_json::json;
use std::sync::{Arc, PoisonError, atomic::Ordering};

/// What the node finds of a database when it decides on its entry.
pub(crate) struct Facts<'a> {
    pub entry: &'a Entry,
    /// Where the database stands in this run; `None` before the node has decided on it.
    pub phase: Option<Phase>,
    pub state: Option<&'a DatabaseState>,
    /// The volume of the entry's storage generation exists.
    pub volume: bool,
    pub unit_awake: bool,
    pub fenced: bool,
    /// An order retired the entry's storage generation.
    pub superseded: bool,
    /// A sleep the page asked for was refused for this generation.
    pub refused: bool,
    /// The build the entry names failed in this run and was abandoned (`View::abandoned_build`).
    pub abandoned: bool,
}

/// What is to be done with an entry.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Nothing,
    /// Build the storage generation the entry's origin names.
    Build,
    Delete,
    /// The page suspends a database that runs.
    Suspend,
    /// The unit runs, as the agent found it at its start: release it.
    AdoptRunning,
    /// The unit is stopped: asleep if its volume matches the record, otherwise unproven.
    AdoptAsleep,
    /// The database cannot be served (`NODE_DATABASE_ERRORS`).
    Fail(&'static str),
    /// Never started or archived again.
    Retire,
}

/// The decision, from the facts alone.
pub(crate) fn plan(f: &Facts) -> Step {
    let entry = f.entry;
    if f.fenced || f.superseded {
        return if f.phase == Some(Phase::Retired) {
            Step::Nothing
        } else {
            Step::Retire
        };
    }
    if entry.desired == Desired::Deleted {
        return if f.phase == Some(Phase::Deleted) {
            Step::Nothing
        } else {
            Step::Delete
        };
    }
    // The generation of the entry was built, with its first backup: from here a missing volume is
    // an error and never a fresh build.
    let built = f
        .state
        .is_some_and(|state| state.built && state.storage_generation == entry.storage_generation);
    let build = !built && entry.origin.is_some();
    match f.phase {
        // A flow runs; it finishes before the next decision.
        Some(Phase::Building | Phase::Starting | Phase::Quiesce) => Step::Nothing,
        None if build => Step::Build,
        None if !built => Step::Fail("volume_missing"),
        None if !f.volume => Step::Fail("volume_missing"),
        None if f.unit_awake => Step::AdoptRunning,
        None => Step::AdoptAsleep,
        // A build that failed is not begun again, whatever the page still says of it.
        Some(_) if build && f.abandoned => Step::Nothing,
        Some(_) if build => Step::Build,
        Some(Phase::Ready) if entry.desired == Desired::Suspended && !f.refused => Step::Suspend,
        Some(_) => Step::Nothing,
    }
}

impl<M: Machine> Core<M> {
    /// Applies a pull of the desired page: the orders that outlive their result first, then the
    /// entries, then the orders that act.
    pub async fn apply(self: &Arc<Self>, page: &Page) {
        // An order runs once in this process: the page lists it until the API has its result, and
        // the pulls in between do not run it again.
        let take_up = |operation: &str| {
            self.taken
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(operation.to_string())
        };
        for order in &page.orders {
            // A fence and a superseded generation are on the disk before the agent acts. Once there
            // they are acted on again by every process that reads them from the page, since the
            // agent may have gone down before it stopped anything.
            match order.clone() {
                Order::Fence { operation } => {
                    if self.persist_fence(&operation) && take_up(&operation) {
                        let core = self.clone();
                        tokio::spawn(async move { core.enforce_fence(&operation).await });
                    }
                }
                Order::Superseded {
                    operation,
                    database,
                    storage_generation,
                    remove_volume,
                } if self.persist_superseded(
                    &operation,
                    &database,
                    storage_generation,
                    remove_volume,
                ) && take_up(&operation) =>
                {
                    let core = self.clone();
                    tokio::spawn(async move {
                        core.enforce_superseded(
                            &operation,
                            &database,
                            storage_generation,
                            remove_volume,
                        )
                        .await
                    });
                }
                _ => {}
            }
        }
        if let Some(policy) = Policy::parse(&page.policy) {
            self.set_policy(policy);
        }
        // The databases that run come first: the gateway's first table waits for them.
        let mut entries: Vec<Entry> = page
            .databases
            .iter()
            .filter_map(|value| {
                let entry = Entry::parse(value);
                if entry.is_none() {
                    crate::timing::emit_event(
                        json!({"event": "desired_entry_refused", "database_id": value["id"]}),
                    );
                }
                entry
            })
            .collect();
        entries.sort_by_key(|entry| !self.awake_at_start.contains(&entry.id));
        for entry in entries {
            let db = self.db(&entry.id);
            if self.accept(&db, entry) {
                self.schedule_page(&db);
            }
        }
        if page.complete {
            let open = page
                .orders
                .iter()
                .any(|order| matches!(order, Order::Maintenance { .. }));
            self.maintenance.store(open, Ordering::Relaxed);
            // A move ends when the API has its result: the hold on the wakes ends with its order.
            for db in self.all() {
                let held = db.view().moving.clone();
                let replacing = db
                    .view()
                    .entry
                    .as_ref()
                    .is_some_and(Entry::replaces_storage);
                if let Some(operation) = held
                    && !replacing
                    && !page
                        .orders
                        .iter()
                        .any(|order| order.operation() == operation)
                {
                    self.set(&db, |view| view.moving = None);
                }
            }
        }
        for order in &page.orders {
            if matches!(order, Order::Fence { .. } | Order::Superseded { .. })
                || !take_up(order.operation())
            {
                continue;
            }
            let core = self.clone();
            match order.clone() {
                Order::Wake {
                    operation,
                    database,
                    generation,
                } => {
                    tokio::spawn(
                        async move { core.obey_wake(&operation, &database, generation).await },
                    );
                }
                Order::Move {
                    operation,
                    database,
                    storage_generation,
                } => {
                    tokio::spawn(async move {
                        core.obey_move(&operation, &database, storage_generation)
                            .await
                    });
                }
                Order::Maintenance { operation } => {
                    tokio::spawn(async move { core.obey_maintenance(&operation).await });
                }
                Order::Fence { .. } | Order::Superseded { .. } => {}
            }
        }
    }

    /// Runs the reconciliation of a database, and again if its entry changes while it runs.
    pub(crate) fn schedule(self: &Arc<Self>, db: &Arc<Db>) {
        self.schedule_with(db, None);
    }

    /// The reconciliation that a page asks for. A database the node has not decided on yet waits
    /// for its turn among `FIRST_PASS_AT_ONCE`, which it keeps until it is decided on: a node has
    /// hundreds of them when it starts, and each reads LVM, systemd and the disk and mounts a
    /// volume. A wake does not wait for a turn (`try_wake`), and neither does a database that is
    /// decided on already. What the decision then does (a build, a delete, a sleep) is no part of
    /// the turn.
    fn schedule_page(self: &Arc<Self>, db: &Arc<Db>) {
        {
            let mut view = db.view();
            if view.adopted {
                drop(view);
                return self.schedule(db);
            }
            if view.queued {
                return;
            }
            view.queued = true;
        }
        let (core, db) = (self.clone(), db.clone());
        tokio::spawn(async move {
            let turn = core.first_pass.clone().acquire_owned().await.ok();
            let adopted = {
                let mut view = db.view();
                view.queued = false;
                view.adopted
            };
            // A wake decided on it while it waited.
            if !adopted {
                core.schedule_with(&db, turn);
            }
        });
    }

    fn schedule_with(
        self: &Arc<Self>,
        db: &Arc<Db>,
        turn: Option<tokio::sync::OwnedSemaphorePermit>,
    ) {
        {
            let mut view = db.view();
            match view.reconcile {
                Reconcile::Idle => view.reconcile = Reconcile::Running,
                Reconcile::Running | Reconcile::Again => {
                    view.reconcile = Reconcile::Again;
                    return;
                }
            }
        }
        let (core, db) = (self.clone(), db.clone());
        tokio::spawn(async move {
            let mut turn = turn;
            loop {
                core.reconcile(&db, &mut turn).await;
                let mut view = db.view();
                if view.reconcile == Reconcile::Again {
                    view.reconcile = Reconcile::Running;
                } else {
                    view.reconcile = Reconcile::Idle;
                    break;
                }
            }
            drop(turn);
            core.retry_until_adopted(&db);
        });
    }

    /// A reconciliation that could not read what it decides from (LVM, systemd, the state file)
    /// decided nothing, and nothing may be started on a database the node has not decided on. The
    /// entry does not change meanwhile and a pull may be a minute away, so the decision is run
    /// again here, after `Timing::recovery_retry` and then after twice as long, to
    /// `recovery_retry_maximum`, until the node has made it. One task does this for a database.
    /// The agent never drops an entry, so a database that left the page is decided on from its
    /// last entry (it is retired or deleted, or it sleeps) and the task ends with that.
    fn retry_until_adopted(self: &Arc<Self>, db: &Arc<Db>) {
        {
            let mut view = db.view();
            if view.adopted || view.retrying {
                return;
            }
            view.retrying = true;
        }
        let (core, db) = (self.clone(), db.clone());
        tokio::spawn(async move {
            let mut wait = core.timing.recovery_retry;
            loop {
                tokio::time::sleep(wait).await;
                {
                    let mut view = db.view();
                    if view.adopted {
                        view.retrying = false;
                        break;
                    }
                }
                core.schedule(&db);
                wait = (wait * 2).min(core.timing.recovery_retry_maximum);
            }
        });
    }

    /// A decision that could not read one of its facts says which and why, until the node has
    /// decided on the database: nothing else shows that it waits for its retry. Once it has, the
    /// pulls that decide again and cannot read keep silent, since a full pull decides on every
    /// database and the ring of events holds 64.
    fn unread(db: &Db, fact: &'static str, error: crate::Error) {
        if db.view().adopted {
            return;
        }
        crate::timing::emit_event(json!({
            "event": "reconcile_unread", "database_id": db.id, "fact": fact,
            "class": crate::diagnostics::error_code(&error),
        }));
    }

    /// Decides on a database's entry and does what that needs. The decision's turn among the first
    /// (`schedule_page`) ends with it: for a database that runs or sleeps when it is decided on,
    /// for any other when the step is known.
    pub(crate) async fn reconcile(
        self: &Arc<Self>,
        db: &Arc<Db>,
        turn: &mut Option<tokio::sync::OwnedSemaphorePermit>,
    ) {
        let _flow = db.lock.lock().await;
        let Some(entry) = db.view().entry.clone() else {
            return;
        };
        // Deletion is authorized by the page and volume identity, not by a local sleep proof.
        // A damaged state file must block starts, but must not strand an explicitly deleted DB.
        if entry.desired != Desired::Deleted && db.view().state.is_none() {
            match self.files(&db.id).load() {
                Ok(state) => self.set(db, |view| view.state = state),
                // A state that was read and cannot be trusted is not taken for a new database.
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    self.set(db, |view| {
                        view.adopted = true;
                        view.phase = Phase::Error;
                        view.error = Some("volume_missing");
                    });
                    return;
                }
                // A file that could not be read (no descriptor left, a failing disk) says nothing
                // about the database: like LVM and systemd, it is read again.
                Err(error) => return Self::unread(db, "state", error.into()),
            }
        }
        if self.replacement_blocks(db, &entry) {
            self.set(db, |view| {
                view.adopted = true;
                view.phase = Phase::Error;
                view.error = Some("build_failed");
                view.writer = None;
            });
            return;
        }
        // What cannot be read is not known: nothing is decided on a guess, and the decision is
        // tried again (`retry_until_adopted`). A volume taken for missing would fail the database;
        // a unit taken for stopped would put a database that runs through recovery.
        let has_volume = match Self::volume_id(&entry) {
            Some(volume) => match self.machine.has_volume(&volume).await {
                Ok(found) => found,
                Err(error) => return Self::unread(db, "volume", error.into()),
            },
            None => false,
        };
        let unit = match self.machine.unit(&db.id).await {
            Ok(unit) => unit,
            Err(error) => return Self::unread(db, "unit", error.into()),
        };
        let unit_awake = unit.active.awake();
        let step = {
            let view = db.view();
            plan(&Facts {
                entry: &entry,
                phase: view.adopted.then_some(view.phase),
                state: view.state.as_ref(),
                volume: has_volume,
                unit_awake,
                fenced: self.fences.fenced(),
                superseded: self.fences.blocks(&db.id, entry.storage_generation),
                refused: view.refusal.is_some(),
                abandoned: view.abandoned_build.as_deref() == Some(entry.archive_path.as_str()),
            })
        };
        if !matches!(step, Step::AdoptRunning | Step::AdoptAsleep) {
            turn.take();
        }
        match step {
            Step::Nothing => {}
            Step::Build => {
                if self.build(db, &entry).await.is_err() && self.replacement_rollback(&entry) {
                    self.set(db, |view| view.adopted = false);
                    return;
                }
            }
            Step::Delete => {
                // What is left is decided again after the backoff; the database is not reported
                // deleted, and the node does not call it decided on.
                if !self.delete(db, &entry).await {
                    return;
                }
            }
            Step::Suspend => {
                self.sleep_locked(db, Why::Order).await;
            }
            // The database is decided on from its volume: the agent's mounts ended with the agent
            // before, and the volume is attached before anything reads it.
            Step::AdoptRunning => {
                if !self.attach(db, &entry).await || !self.adopt_running(db, &entry).await {
                    return;
                }
            }
            Step::AdoptAsleep => {
                // The unit that was starting when the agent began is not awake: its start failed,
                // and holds nothing.
                self.end_resumed(&db.id, false);
                if !self.attach(db, &entry).await {
                    return;
                }
                self.adopt_asleep(db).await;
            }
            Step::Fail(error) => self.set(db, |view| {
                view.phase = Phase::Error;
                view.error = Some(error);
            }),
            Step::Retire => {
                self.retire(db).await;
            }
        }
        self.set(db, |view| view.adopted = true);
        turn.take();
        if matches!(db.phase(), Phase::Ready | Phase::Asleep) {
            self.resize(db, &entry).await;
        }
        if db.phase() == Phase::Ready {
            self.sync(db, &entry).await;
        }
    }

    /// Attaches the database's volume if the agent has not: its mounts end with the agent, and a
    /// database is decided on from the files below its mount point. A volume that cannot be
    /// attached is a fact to decide on (a volume that needs a repair has no `pg_control` to
    /// show); a volume list that cannot be read is not, and `false` says that nothing is decided.
    ///
    /// The size of the volume's filesystem is read here (`read_filesystem`), once for every
    /// database that the agent decides on after it began: what the observation of a ready or
    /// sleeping database tells (`View::storage_bytes`) is known before the first one is queued, so
    /// that the resize that is open in Cloudflare is never ended by an observation that says
    /// nothing of the filesystem. A filesystem that cannot be read is not a fact either.
    async fn attach(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) -> bool {
        let Some(volume) = Self::volume_id(entry) else {
            return true;
        };
        if !self.machine.attached(&volume) {
            match self
                .machine
                .mount_volumes(std::slice::from_ref(&volume))
                .await
            {
                Ok(failures) => {
                    for (volume, error) in failures {
                        crate::timing::emit_event(json!({
                            "event": "mount_failed", "database_id": volume.database(),
                            "class": crate::diagnostics::error_code(&error.into()),
                        }));
                    }
                }
                Err(error) => {
                    Self::unread(db, "volume", error.into());
                    return false;
                }
            }
        }
        match self.read_filesystem(db, &volume).await {
            Ok(()) => true,
            Err(error) => {
                Self::unread(db, "filesystem", error.into());
                false
            }
        }
    }

    /// Reads the size of the volume's filesystem from its superblock into the view, where the
    /// observation takes it from. A change of it is a change of the observation.
    pub(crate) async fn read_filesystem(
        &self,
        db: &Db,
        volume: &crate::storage::VolumeId,
    ) -> Result<(), crate::storage::Error> {
        let bytes = self.machine.filesystem_bytes(volume).await?;
        if db.view().storage_bytes != Some(bytes) {
            self.set(db, |view| view.storage_bytes = Some(bytes));
        }
        Ok(())
    }

    /// The unit runs, as the agent found it at its start: it is released to the gateway as ready,
    /// and its archiver reaches the archive socket again. `false` when the bus would not say
    /// whether the unit is ready: nothing is known of it, the decision is for the retry, and the
    /// database is neither served nor recovered (recovery would stop it). The volume is attached
    /// (`attach`): the unit's answer is read from its files.
    ///
    /// A start that was in flight when the agent began ends here, with what the unit answers:
    /// ready when the database is released, failed when the unit is not active, and not at all
    /// when the unit runs and is not served, or when the bus would not answer (it holds its
    /// memory until its unit is reported stopped).
    ///
    /// The timer that was to apply its CPU quota after a burst died with the agent that held it,
    /// and the agent cannot tell how much of the burst is left: the quota is applied at once,
    /// which is the same one the unit holds if its burst was over. That is one property call on
    /// the bus, which takes a place among the unit calls like a read does (`units::Calls`), so
    /// the databases that run at the agent's start cannot flood the bus with them.
    async fn adopt_running(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) -> bool {
        self.ensure_archive(db, entry);
        match self.machine.wait_started(&db.id).await {
            Ok(started) => match writer_of(&started) {
                Some(writer) => {
                    self.set(db, |view| {
                        view.phase = Phase::Ready;
                        view.writer = Some(writer);
                        view.awake_since_ms = Some(super::now_ms());
                        view.error = None;
                    });
                    self.end_resumed(&db.id, true);
                    self.after_ready(db).await;
                }
                None => self.go_unproven(db),
            },
            // A unit that stopped, or whose start failed, holds nothing; recovery takes the
            // database.
            Err(
                crate::units::Error::NotReady("unit_not_active") | crate::units::Error::Job { .. },
            ) => {
                self.end_resumed(&db.id, false);
                self.go_unproven(db);
            }
            // A unit that is not ready is not served; recovery takes it, and stops it.
            Err(crate::units::Error::NotReady(_)) => self.go_unproven(db),
            Err(error) => {
                Self::unread(db, "unit", error.into());
                return false;
            }
        }
        true
    }

    /// The start that was in flight when the agent began ends: the permit it was resumed with
    /// reports it ready or failed. Nothing happens for a database that had none, or whose start
    /// ended already.
    fn end_resumed(&self, database: &str, ready: bool) {
        let permit = self
            .resumed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(database);
        match permit {
            Some(permit) if ready => permit.ready(),
            Some(permit) => permit.failed(),
            None => {}
        }
    }

    /// The unit is stopped: the volume against the record decides whether it sleeps provenly.
    async fn adopt_asleep(self: &Arc<Self>, db: &Arc<Db>) {
        let record = db
            .view()
            .state
            .as_ref()
            .and_then(|state| state.record.clone());
        match proof::wake_check(record.as_ref(), &self.layout().volume(&db.id)) {
            Ok(()) => self.set(db, |view| {
                view.phase = Phase::Asleep;
                view.writer = None;
                view.error = None;
            }),
            Err(WakeRefusal::Unproven) => self.go_unproven(db),
            Err(_) => self.set(db, |view| {
                view.phase = Phase::Error;
                view.error = Some("identity_mismatch");
            }),
        }
    }

    /// The database sizes of the entry are the unit's limits and the volume's: set again when
    /// they changed, running or asleep, and the admission knows it. A change of the settings is
    /// written at the next start. The observation carries the size that the filesystem has
    /// (`View::storage_bytes`), read after the growth: Cloudflare ends a resize when the filesystem
    /// has the size and not when the volume has, so a growth that failed (the kernel's -28, a pool
    /// that took no writes) leaves the resize open, and it is tried again with every decision of
    /// the database.
    pub(crate) async fn resize(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) {
        let current = Resources {
            memory_mib: entry.memory_mib,
            cpu_millicores: entry.cpu_millicores,
            storage_gib: entry.storage_gib,
        };
        let held = db
            .view()
            .state
            .as_ref()
            .and_then(|state| state.resources.clone());
        let changed = held.as_ref() != Some(&current);
        let growing = db.view().storage_bytes.is_some_and(|bytes| {
            bytes
                < entry
                    .volume_bytes()
                    .saturating_sub(crate::storage::FS_END_GAP_BYTES)
        });
        if changed || growing {
            let mut applied = self.apply_limits(entry).await.is_ok();
            if let Some(volume) = Self::volume_id(entry)
                && (growing
                    || held
                        .as_ref()
                        .is_some_and(|held| held.storage_gib < current.storage_gib))
            {
                let mut result = self
                    .machine
                    .grow_volume(&volume, entry.volume_bytes())
                    .await;
                if matches!(result, Err(crate::storage::Error::OfflineGrowRequired))
                    && db.phase() == Phase::Ready
                    && self.sleep_locked(db, Why::Order).await == Slept::Proven
                {
                    // Only the established quiesce/archive/stop proof may stop a warm writer.
                    // A busy writer or archive leaves the operation pending for a later pass.
                    result = self
                        .machine
                        .grow_volume(&volume, entry.volume_bytes())
                        .await;
                }
                if let Err(error) = result {
                    applied = false;
                    crate::timing::emit_event(json!({
                        "event": "resize_refused", "database_id": db.id,
                        "class": crate::diagnostics::error_code(&error.into()),
                    }));
                }
            }
            if applied {
                let _ = self.save_state(db, |state| state.resources = Some(current.clone()));
            }
            self.admission.resized(&db.id, entry.memory_mib);
        }
        if let Some(volume) = Self::volume_id(entry) {
            // The size it has now; one that cannot be read leaves the size as it was (the volume
            // is the same), and the next decision reads it again.
            let _ = self.read_filesystem(db, &volume).await;
        }
    }

    /// What the entry asks of a database that runs: the roles, and an archiver that reaches R2
    /// once the credential has arrived after the start.
    pub(crate) async fn sync(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) {
        self.ensure_archive(db, entry);
        self.admission
            .set_always_warm(&db.id, entry.sleep_after_seconds.is_none());
        if let Err(reason) = self.refresh_roles(db, entry).await {
            crate::timing::emit_event(
                json!({"event": "roles_failed", "database_id": db.id, "reason": reason}),
            );
        }
    }

    /// A database of a new storage generation on the node that holds the old one: the old
    /// generation's unit is stopped (it sleeps, or the move would not have begun) and its volume
    /// is unmounted, as a database has one directory. The volume stays until its removal is
    /// ordered.
    ///
    /// `false` when the old generation is still held: the unmount asks the kernel, so a unit or a
    /// job that has the old volume in a namespace of its own, and an agent that restarted since
    /// and has no mount of it, are `Busy`. The next generation is not built then, and nothing
    /// else is touched: the record of the old generation stays as it is, so that the next try
    /// releases it again, and the build goes on once nothing holds it. A unit that runs is not
    /// stopped here: only an order stops what runs.
    pub(super) async fn release_previous_generation(&self, entry: &Entry) -> bool {
        let held = self.files(&entry.id).load().ok().flatten();
        let Some(held) = held.filter(|state| state.storage_generation < entry.storage_generation)
        else {
            return true;
        };
        let Ok(previous) = crate::storage::VolumeId::new(&entry.id, held.storage_generation) else {
            return true;
        };
        match self.machine.unmount_volume(&previous).await {
            Ok(()) => true,
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "generation_not_released", "database_id": entry.id,
                    "class": crate::diagnostics::error_code(&error.into()),
                }));
                false
            }
        }
    }

    /// The desired state is `deleted` (plan 5.10): the unit ends, the volumes and the user go, and
    /// the node keeps nothing of the database. The R2 archive is the Worker's to expire.
    ///
    /// The database is deleted when all of that is gone, and not before: the node reports it
    /// `deleted` only then, and Cloudflare stops asking for it only when it has reported it and
    /// no volume of it is reported any more. A step that fails is said (`delete_incomplete`, with
    /// the step, its class and the seconds the delete has been failing) and the delete is decided
    /// again after the recovery backoff (`retry_until_adopted`) up to its longest wait, for as
    /// long as it takes, so that a volume on a full filesystem, a unit that no signal ends in
    /// time or a user the system cannot lock never stays behind unseen. `true` when it is
    /// deleted.
    pub(crate) async fn delete(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) -> bool {
        self.set(db, |view| {
            view.phase = Phase::Retired;
            view.writer = None;
        });
        match self.remove_all(db, entry).await {
            Ok(()) => {
                self.set(db, |view| {
                    view.phase = Phase::Deleted;
                    view.state = None;
                    view.error = None;
                    view.delete_failing_since_ms = None;
                });
                true
            }
            Err((step, class)) => {
                let now = now_ms();
                let mut view = db.view();
                let since = *view.delete_failing_since_ms.get_or_insert(now);
                // The node has not made its decision on the database yet, which is what the
                // retry waits for.
                view.adopted = false;
                drop(view);
                crate::timing::emit_event(json!({
                    "event": "delete_incomplete", "database_id": db.id, "step": step,
                    "class": class, "seconds": (now - since).max(0) / 1000,
                }));
                false
            }
        }
    }

    /// Every step of a delete, each of which finds what is gone gone: the first one that fails
    /// ends the attempt with its name and class, since the next depends on it (a volume is not
    /// removed while PostgreSQL may run on it, the user not while its files remain).
    async fn remove_all(&self, db: &Db, entry: &Entry) -> Result<(), (&'static str, String)> {
        let failed = |step, error: crate::Error| (step, crate::diagnostics::error_code(&error));
        let id = &db.id;
        let ended = super::remove::end_unit(&*self.machine, id).await;
        self.admission.stopped(id);
        self.table.remove(id);
        ended.map_err(|error| failed("unit", error.into()))?;
        let others = super::remove::remove_volumes(
            &*self.machine,
            id,
            entry.storage_generation,
            Self::volume_id(entry),
        )
        .await?;
        // The socket directory, the user (with the database's last volume: a volume of a later
        // generation that an order of its own removes keeps its owner) and the node's files.
        match std::fs::remove_dir_all(self.layout().socket_directory(id)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(failed("socket_directory", error.into()));
            }
            _ => {}
        }
        if !others && let Err(error) = self.machine.remove_account(id).await {
            return Err(failed("account", error.into()));
        }
        self.files(id)
            .remove()
            .map_err(|error| failed("state", error.into()))
    }

    /// Stops the unit of a database by its name, out of admission's awake set and off the archive
    /// socket's table; the node needs no record of the database for it. `false` when the unit may
    /// still run.
    pub(super) async fn stop_unit(&self, database: &str) -> bool {
        let stopped = self.machine.stop(database).await.is_ok();
        self.admission.stopped(database);
        self.table.remove(database);
        stopped
    }

    /// A fenced node or a retired generation: never started or archived again. A unit that runs
    /// is stopped, since the order says so.
    async fn retire(self: &Arc<Self>, db: &Arc<Db>) -> bool {
        let stopped = self.stop_unit(&db.id).await;
        self.set(db, |view| {
            view.phase = Phase::Retired;
            view.writer = None;
            view.awake_since_ms = None;
        });
        stopped
    }

    // ---- the orders

    /// `fence` (plan 9.4): the order is on disk before the agent acts on it. `false` when it is
    /// not on disk.
    fn persist_fence(&self, operation: &str) -> bool {
        match self.fences.fence(operation) {
            Ok(_) => true,
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "fence_unwritten", "class": crate::diagnostics::error_code(&error.into()),
                }));
                false
            }
        }
    }

    /// Nothing is started or archived again; what runs is stopped, since the order says so. That
    /// includes the units the page never named: an agent that restarted while it was cut off finds
    /// its units running and a first page that holds the fence and no database.
    async fn enforce_fence(self: &Arc<Self>, operation: &str) {
        let mut stopped = true;
        // The idle slots hold no database, but they are part of what runs.
        self.machine.drain_idle_slots().await;
        for db in self.all() {
            let _flow = db.lock.lock().await;
            let named = db.view().entry.is_some();
            if named {
                stopped &= self.retire(&db).await;
            }
        }
        match self.machine.units().await {
            Ok(units) => {
                for unit in units {
                    let named = self
                        .find(&unit.database)
                        .is_some_and(|db| db.view().entry.is_some());
                    if !named {
                        stopped &= self.stop_unit(&unit.database).await;
                    }
                }
            }
            Err(_) => stopped = false,
        }
        self.report_order(
            operation,
            if stopped {
                Ok(())
            } else {
                Err("unit_not_stopped")
            },
        );
    }

    /// `superseded`: this storage generation and every older one is never started or archived
    /// again. The order is on disk first. `false` when it is not on disk.
    fn persist_superseded(
        &self,
        operation: &str,
        database: &str,
        storage_generation: u64,
        remove_volume: bool,
    ) -> bool {
        match self
            .fences
            .supersede(database, storage_generation, remove_volume, operation)
        {
            Ok(_) => true,
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "superseded_unwritten", "class": crate::diagnostics::error_code(&error.into()),
                }));
                false
            }
        }
    }

    /// A unit of a retired generation stops; its volume goes only with `remove_volume`.
    async fn enforce_superseded(
        self: &Arc<Self>,
        operation: &str,
        database: &str,
        storage_generation: u64,
        remove_volume: bool,
    ) {
        let mut outcome = Ok(());
        let db = self.find(database);
        let _flow = match &db {
            Some(db) => Some(db.lock.lock().await),
            None => None,
        };
        let entry = db.as_ref().and_then(|db| db.view().entry.clone());
        // A node that restarted has no record of a unit that runs on: it serves the volume the
        // unit itself has mounted, which the agent's own mounts (made again for the page's
        // databases only, after a restart) do not tell.
        let retired = match entry {
            Some(entry) => Some(entry.storage_generation <= storage_generation),
            None => match self.machine.unit_volume(database).await {
                Ok(Some(volume)) => Some(volume.generation() <= storage_generation),
                Ok(None) => Some(false),
                Err(_) => None,
            },
        };
        match (retired, &db) {
            (Some(true), Some(db)) => {
                if !self.retire(db).await {
                    outcome = Err("unit_not_stopped");
                }
            }
            (Some(true), None) => {
                if !self.stop_unit(database).await {
                    outcome = Err("unit_not_stopped");
                }
            }
            (None, _) => outcome = Err("unit_not_stopped"),
            (Some(false), _) => {}
        }
        if remove_volume && !self.replacement_cleanup_ready(database, storage_generation) {
            self.report_order(operation, Err("volume_not_removed"));
            return;
        }
        if remove_volume && let Ok(inventory) = self.machine.inventory().await {
            for volume in inventory.volumes.into_iter().filter(|volume| {
                volume.id.database() == database && volume.id.generation() <= storage_generation
            }) {
                let removal = Removal::Superseded {
                    storage_generation,
                    remove_volume,
                };
                if let Err(error) = self.machine.remove_volume(&volume.id, removal).await {
                    crate::timing::emit_event(json!({
                        "event": "volume_not_removed", "database_id": database,
                        "class": crate::diagnostics::error_code(&error.into()),
                    }));
                    outcome = Err("volume_not_removed");
                }
            }
        }
        if remove_volume && outcome.is_ok() {
            outcome = self
                .finish_replacement_cleanup(database, storage_generation)
                .await;
        }
        self.report_order(operation, outcome);
    }

    /// `wake` (resume): the database starts through admission as a connection's wake would. A wake
    /// the node cannot decide yet (`again`: it has not decided on the database in this run, or a
    /// start is running) is made again after the recovery backoff, and is no result: the API fails
    /// the resume for any reason, and an order is run once in this process. So is a wake refused
    /// as `desired_stale` while the page's entry of the database is below the order's generation:
    /// a pull brought the order with an entry that says what the database was before the resume.
    /// Every pull carries every open order of the node whatever it asks for, and the entries only
    /// of what it names: a pull of named databases (the hint every resume, suspend and wake makes)
    /// that reads the orders after another database's resume commits hands the node that order
    /// and not its entry; a full pull does the same across its pages (orders on each page,
    /// entries in pages of 200). The node waits for the page that names the order instead of
    /// ending it on that. The request is made from the entry each time, which a pull may have
    /// moved on.
    async fn obey_wake(self: &Arc<Self>, operation: &str, database: &str, generation: u64) {
        let Some(db) = self.find(database) else {
            self.report_order(operation, Err("desired_stale"));
            return;
        };
        let mut wait = self.timing.recovery_retry;
        let result = loop {
            let (request, page_behind) = {
                let view = db.view();
                let Some(entry) = &view.entry else {
                    drop(view);
                    self.report_order(operation, Err("desired_stale"));
                    return;
                };
                (
                    WakeRequest {
                        database: database.to_string(),
                        operation: operation.to_string(),
                        generation,
                        route_revision: entry.route_revision,
                        role_revision_hash: entry.role_hash(),
                        queued_at_ms: u64::try_from(super::now_ms()).unwrap_or(0),
                    },
                    entry.generation < generation,
                )
            };
            let result = self.wake(&request).await;
            let stale = page_behind
                && result.outcome == Outcome::Refused
                && result.reason.as_deref() == Some("desired_stale");
            if stale {
                self.page_reaches(&db, generation, wait).await;
            } else if result.again() {
                tokio::time::sleep(wait).await;
            } else {
                break result;
            }
            wait = (wait * 2).min(self.timing.recovery_retry_maximum);
        };
        match (result.outcome, result.reason.as_deref()) {
            (Outcome::Started, _) => self.report_order(operation, Ok(())),
            (_, Some(reason)) => self.report_order(operation, Err(reason)),
            _ => self.report_order(operation, Err("release_failed")),
        }
    }

    /// `move` (plan 9.5): the source proves the sleep of its storage generation and holds its
    /// wakes until the order ends. The result is reported once the database sleeps provenly.
    async fn obey_move(self: &Arc<Self>, operation: &str, database: &str, storage_generation: u64) {
        let Some(db) = self.find(database) else {
            self.report_order(operation, Err("desired_stale"));
            return;
        };
        let _flow = db.lock.lock().await;
        let serves = db
            .view()
            .entry
            .as_ref()
            .is_some_and(|entry| entry.storage_generation == storage_generation);
        if !serves {
            self.report_order(operation, Err("desired_stale"));
            return;
        }
        self.set(&db, |view| view.moving = Some(operation.to_string()));
        let ended = if db.phase() == Phase::Ready {
            match self.sleep_locked(&db, Why::Order).await {
                Slept::Proven => Ok(()),
                Slept::Refused(refusal) => Err(refusal.observation()),
                // Only an idle sleep waits for a base backup; an order never does.
                Slept::BackupPutOff => Err("power_busy"),
                Slept::Unproven(_) => Err("power_archive"),
                Slept::NotRunning => Ok(()),
            }
        } else if db.phase() == Phase::Asleep {
            Ok(())
        } else {
            Err("unproven")
        };
        if ended.is_err() {
            self.set(&db, |view| view.moving = None);
        }
        self.report_order(operation, ended);
    }

    /// `maintenance` (plan 9.3): new wakes are held, and every database that runs sleeps with the
    /// proof. A database that does not sleep fails the order. Otherwise the cycle goes on with the
    /// release's packages, the reboot and the check, which the service takes over (`take_slept`),
    /// and the order is answered when they are done.
    async fn obey_maintenance(self: &Arc<Self>, operation: &str) {
        self.maintenance.store(true, Ordering::Relaxed);
        let mut failed = None;
        for db in self.all() {
            if db.phase() == Phase::Ready
                && let Slept::Refused(refusal) = self.sleep(&db, Why::Order).await
            {
                failed = Some(refusal.observation());
            }
        }
        match failed {
            Some(reason) => self.report_order(operation, Err(reason)),
            None => {
                self.slept
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push(operation.to_string());
                self.slept_signal.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::{
            Timing,
            testing::{Rig, eventually, new_entry_json, timing},
        },
        credentials::Access,
        link::Order,
        node_link::contract_valid,
        postgres,
        storage::VolumeId,
        testpg,
    };
    use pgcf_native_protocol::agent::Mode;
    use serde_json::{Value, json};
    use std::time::Duration;

    fn entry(change: impl FnOnce(&mut Value)) -> Entry {
        let mut db = crate::link::test_server::database("dbbbbbbbbbbbbbbbbbbb");
        change(&mut db);
        Entry::parse(&db).unwrap()
    }
    fn state(built: bool, generation: u64) -> DatabaseState {
        let mut state = DatabaseState::new(generation);
        state.built = built;
        state
    }
    fn decide(
        entry: &Entry,
        phase: Option<Phase>,
        state: Option<&DatabaseState>,
        volume: bool,
        unit_awake: bool,
    ) -> Step {
        plan(&Facts {
            entry,
            phase,
            state,
            volume,
            unit_awake,
            fenced: false,
            superseded: false,
            refused: false,
            abandoned: false,
        })
    }

    #[test]
    fn the_plan_builds_what_the_page_says_to_build_and_never_a_database_that_was_ready() {
        let create = entry(|db| db["origin"] = json!({"kind": "create"}));
        let plain = entry(|_| {});
        // A new database is built; a built one with a missing volume is an error and not a fresh build.
        assert_eq!(decide(&create, None, None, false, false), Step::Build);
        assert_eq!(
            decide(&plain, None, None, false, false),
            Step::Fail("volume_missing")
        );
        let built = state(true, 1);
        assert_eq!(
            decide(&plain, None, Some(&built), false, false),
            Step::Fail("volume_missing")
        );
        assert_eq!(
            decide(&create, None, Some(&built), false, false),
            Step::Fail("volume_missing")
        );
        // A build a crash stopped is built again; a built generation that the page still names an
        // origin for is not.
        assert_eq!(
            decide(&create, None, Some(&state(false, 1)), true, false),
            Step::Build
        );
        assert_eq!(
            decide(
                &create,
                Some(Phase::Error),
                Some(&state(false, 1)),
                true,
                false
            ),
            Step::Build
        );
        // A build that failed and was abandoned is not begun again, however often the page names
        // it; the same entry is built if it was not abandoned (a refused release), and a
        // generation that is built needs none either way.
        let abandoned = |entry: &Entry, phase, state: Option<&DatabaseState>| {
            plan(&Facts {
                entry,
                phase,
                state,
                volume: false,
                unit_awake: false,
                fenced: false,
                superseded: false,
                refused: false,
                abandoned: true,
            })
        };
        assert_eq!(abandoned(&create, Some(Phase::Error), None), Step::Nothing);
        assert_eq!(
            abandoned(&create, Some(Phase::Error), Some(&state(false, 1))),
            Step::Nothing
        );
        assert_eq!(
            decide(&create, Some(Phase::Asleep), Some(&built), true, false),
            Step::Nothing
        );
        // The node found a unit that runs, or one that sleeps.
        assert_eq!(
            decide(&plain, None, Some(&built), true, true),
            Step::AdoptRunning
        );
        assert_eq!(
            decide(&plain, None, Some(&built), true, false),
            Step::AdoptAsleep
        );
        // A new storage generation is built, whether the node knows the database or not.
        let moved = entry(|db| {
            db["storage_generation"] = json!(2);
            db["archive"]["path"] =
                json!("s3://pgcf-eu/eu-dev/dbbbbbbbbbbbbbbbbbbb/g2-op_cccccccccccccccccccc");
            db["origin"] = json!({"kind": "create"});
        });
        assert_eq!(
            decide(&moved, Some(Phase::Asleep), Some(&built), true, false),
            Step::Build
        );
        // Nothing steps in while a flow of the database runs.
        for phase in [Phase::Building, Phase::Starting, Phase::Quiesce] {
            assert_eq!(
                decide(&create, Some(phase), Some(&state(false, 1)), true, false),
                Step::Nothing
            );
        }
    }

    #[test]
    fn the_plan_suspends_deletes_and_retires_only_as_the_page_or_an_order_says() {
        let suspended = entry(|db| db["desired_state"] = json!("suspended"));
        let deleted = entry(|db| db["desired_state"] = json!("deleted"));
        let built = state(true, 1);
        assert_eq!(
            decide(&suspended, Some(Phase::Ready), Some(&built), true, true),
            Step::Suspend
        );
        // A sleep the page asked for and was refused is not asked again for that generation.
        assert_eq!(
            plan(&Facts {
                entry: &suspended,
                phase: Some(Phase::Ready),
                state: Some(&built),
                volume: true,
                unit_awake: true,
                fenced: false,
                superseded: false,
                refused: true,
                abandoned: false,
            }),
            Step::Nothing
        );
        assert_eq!(
            decide(&suspended, Some(Phase::Asleep), Some(&built), true, false),
            Step::Nothing
        );
        assert_eq!(
            decide(&deleted, Some(Phase::Ready), Some(&built), true, true),
            Step::Delete
        );
        assert_eq!(decide(&deleted, None, None, false, false), Step::Delete);
        assert_eq!(
            decide(&deleted, Some(Phase::Deleted), None, false, false),
            Step::Nothing
        );
        let plain = entry(|_| {});
        for (fenced, superseded) in [(true, false), (false, true)] {
            let facts = |phase| Facts {
                entry: &plain,
                phase,
                state: Some(&built),
                volume: true,
                unit_awake: true,
                fenced,
                superseded,
                refused: false,
                abandoned: false,
            };
            assert_eq!(plan(&facts(Some(Phase::Ready))), Step::Retire);
            assert_eq!(plan(&facts(Some(Phase::Retired))), Step::Nothing);
        }
    }

    fn id_of(db: &Value) -> String {
        db["id"].as_str().unwrap().to_string()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_page_creates_suspends_wakes_resizes_and_deletes_a_database() {
        let Some(rig) = Rig::new("lifecycle").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        // Created from the page.
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the database to be ready", || {
            handle.phase() == Phase::Ready
        })
        .await;
        assert_eq!(rig.observed(&id, "ready").await["state"], "ready");

        // The generation was ready: the page no longer names how to build it. It suspends it.
        db.as_object_mut().unwrap().remove("origin");
        db["desired_state"] = json!("suspended");
        db["generation"] = json!(5);
        db["operation"] = json!("op_dddddddddddddddddddd");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the suspend to be proven", || {
            handle.phase() == Phase::Asleep
        })
        .await;
        let observation = rig.observed(&id, "asleep").await;
        assert_eq!(
            (
                observation["state"].as_str(),
                observation["generation"].as_u64()
            ),
            (Some("asleep"), Some(5))
        );
        assert!(!rig.machine.running(&id));
        // A suspended database does not wake on a connection.
        let mut ticket = Rig::ticket(&rig.entry_for(&db));
        ticket.generation = 5;
        assert_eq!(
            rig.core.wake(&ticket).await.reason.as_deref(),
            Some("suspended")
        );

        // Resumed by an order: running at generation 6, woken at 7.
        db["desired_state"] = json!("running");
        db["generation"] = json!(6);
        db["operation"] = json!("op_eeeeeeeeeeeeeeeeeeee");
        let resume = Order::Wake {
            operation: "op_wwwwwwwwwwwwwwwwwwww".into(),
            database: id.clone(),
            generation: 7,
        };
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![resume.clone()]))
            .await;
        eventually(60, "the resume", || {
            rig.core.pending_order("op_wwwwwwwwwwwwwwwwwwww").is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order("op_wwwwwwwwwwwwwwwwwwww").unwrap()["status"],
            "done"
        );
        assert_eq!(handle.phase(), Phase::Ready);
        assert_eq!(rig.observation(&id)["generation"], 7);
        // The page lists the order until the API has the result: the node does not run it again.
        rig.machine.clear_calls();
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![resume]))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(rig.machine.calls().is_empty(), "{:?}", rig.machine.calls());

        // Resized: the limits, the volume, the admission and, at the next start, the settings.
        db["resources"] = json!({"memory_mib": 512, "cpu_millicores": 500, "storage_gib": 2});
        db["generation"] = json!(8);
        db["operation"] = json!("op_ffffffffffffffffffff");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the resize", || {
            rig.machine.limits(&id).is_some_and(|l| l.memory_mib == 512)
        })
        .await;
        eventually(30, "the resize to be kept", || {
            handle
                .view()
                .state
                .as_ref()
                .and_then(|s| s.resources.clone())
                .is_some_and(|r| r.storage_gib == 2)
        })
        .await;
        assert_eq!(rig.machine.limits(&id).unwrap().cpu_millicores, 500);
        assert_eq!(rig.machine.volumes()[0].1, 2 << 30);
        // The admission learns of the resize after the state is kept, through its own channel.
        let started = std::time::Instant::now();
        let awake_memory_mib = loop {
            let awake = rig
                .core
                .admission
                .snapshot()
                .await
                .unwrap()
                .awake_memory_mib;
            if awake == 512 || started.elapsed() > std::time::Duration::from_secs(30) {
                break awake;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        };
        assert_eq!(awake_memory_mib, 512);
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let mut ticket = Rig::ticket(&rig.entry_for(&db));
        ticket.operation = "op_xxxxxxxxxxxxxxxxxxxx".into();
        assert_eq!(rig.core.wake(&ticket).await.outcome, Outcome::Started);
        let conf =
            std::fs::read_to_string(rig.core.layout().data(&id).join("postgresql.conf")).unwrap();
        assert!(
            conf.contains("shared_buffers = 64MB") && conf.contains("max_wal_size = 512MB"),
            "{conf}"
        );

        // Deleted: the unit, the volume, the user and the node's files are gone.
        db["desired_state"] = json!("deleted");
        db["generation"] = json!(10);
        db["operation"] = json!("op_gggggggggggggggggggg");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the delete", || handle.phase() == Phase::Deleted).await;
        assert!(!rig.machine.running(&id));
        assert!(rig.machine.volumes().is_empty());
        assert!(!rig.machine.has_account(&id));
        assert_eq!(rig.core.files(&id).load().unwrap(), None);
        assert!(!rig.core.layout().socket_directory(&id).exists());
        assert_eq!(rig.gateway.get(&id).unwrap().mode, Mode::Retired);
        let observation = rig.observation(&id);
        assert_eq!(observation["state"], "deleted");
        assert!(contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []})
        ));
        assert!(
            rig.core
                .admission
                .snapshot()
                .await
                .unwrap()
                .awake
                .is_empty()
        );
        let _ = postgres::agent;
    }

    const RESUME: &str = "op_rrrrrrrrrrrrrrrrrrrr";

    /// The page the node holds when the suspension is its newest entry for the database.
    fn suspension(db: &Value, generation: u64) -> Value {
        let mut page = db.clone();
        page.as_object_mut().unwrap().remove("origin");
        page["desired_state"] = json!("suspended");
        page["generation"] = json!(generation);
        page["operation"] = json!(format!("op_{:0>20}", format!("s{generation}")));
        page
    }
    /// The page that names the resume: the entry and the order of the same generation and operation.
    fn resumption(db: &Value, generation: u64, operation: &str) -> (Value, Order) {
        let mut page = db.clone();
        page.as_object_mut().unwrap().remove("origin");
        page["desired_state"] = json!("running");
        page["generation"] = json!(generation);
        page["operation"] = json!(operation);
        let order = Order::Wake {
            operation: operation.into(),
            database: id_of(db),
            generation,
        };
        (page, order)
    }

    /// A pull that carries the order of a resume and not its entry (a pull of named databases
    /// reads every open order of the node and the entries only of what it names; a full pull
    /// reads the entries of an early page before the resume and the orders of a later page after
    /// it) hands the node the order while the entry of the database is still the manual
    /// suspension. The order is no failure and no refusal of its own: it waits for the page, and
    /// ends done once the page has caught up, and the connection that follows it is the same
    /// start, released at once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_order_that_comes_before_its_page_entry_waits_for_the_page_and_ends_done() {
        let Some(rig) = Rig::new("resume-ahead").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the database to be ready", || {
            handle.phase() == Phase::Ready
        })
        .await;
        let generation = db["generation"].as_u64().unwrap() + 1;
        let suspended = suspension(&db, generation);
        rig.core
            .apply(&Rig::page(vec![suspended.clone()], vec![]))
            .await;
        eventually(60, "the suspension to be proven", || {
            handle.phase() == Phase::Asleep
        })
        .await;

        let (resumed, order) = resumption(&db, generation + 1, RESUME);
        // The order, and the suspension still the entry: the node meets it more than once while it
        // waits, and says nothing of it to Cloudflare.
        rig.core
            .apply(&Rig::page(vec![suspended], vec![order.clone()]))
            .await;
        tokio::time::sleep(std::time::Duration::from_millis(900)).await;
        assert_eq!(rig.core.pending_order(RESUME), None);
        assert!(!rig.machine.running(&id));
        assert_eq!(handle.phase(), Phase::Asleep);

        // The next pull has the entry of the resume.
        rig.core
            .apply(&Rig::page(vec![resumed.clone()], vec![order]))
            .await;
        eventually(60, "the resume to end", || {
            rig.core.pending_order(RESUME).is_some()
        })
        .await;
        assert_eq!(rig.core.pending_order(RESUME).unwrap()["status"], "done");
        assert_eq!(handle.phase(), Phase::Ready);
        assert!(rig.machine.running(&id));
        assert_eq!(rig.observation(&id)["generation"], generation + 1);
        // The connection that follows the resume is the same start, released at once.
        let mut ticket = Rig::ticket(&rig.entry_for(&resumed));
        ticket.generation = generation + 1;
        ticket.operation = RESUME.to_string();
        let woke = rig.core.wake(&ticket).await;
        assert_eq!(woke.outcome, Outcome::Started, "{woke:?}");
    }

    /// An order of a generation the page has already passed (the suspension that superseded the
    /// resume is the entry) is not behind the page: it ends at once with the entry's own refusal,
    /// and the node does not wait for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_order_the_page_has_passed_ends_at_once_and_is_not_waited_for() {
        let Some(rig) = Rig::new("resume-passed").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the database to be ready", || {
            handle.phase() == Phase::Ready
        })
        .await;
        let generation = db["generation"].as_u64().unwrap() + 1;
        rig.core
            .apply(&Rig::page(vec![suspension(&db, generation + 1)], vec![]))
            .await;
        eventually(60, "the suspension to be proven", || {
            handle.phase() == Phase::Asleep
        })
        .await;
        // The resume of the generation before the suspension was superseded by it.
        let (_, order) = resumption(&db, generation, RESUME);
        rig.core
            .apply(&Rig::page(
                vec![suspension(&db, generation + 1)],
                vec![order],
            ))
            .await;
        eventually(10, "the stale order to end", || {
            rig.core.pending_order(RESUME).is_some()
        })
        .await;
        let result = rig.core.pending_order(RESUME).unwrap();
        assert_eq!(
            (result["status"].as_str(), result["reason"].as_str()),
            (Some("failed"), Some("suspended"))
        );
        assert!(!rig.machine.running(&id));
    }

    async fn login(
        rig: &Rig,
        id: &str,
        role: &str,
        password: &str,
    ) -> Result<(), tokio_postgres::Error> {
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(rig.machine.layout().socket_directory(id))
            .port(crate::layout::PORT)
            .user(role)
            .password(password)
            .dbname(id);
        let (client, connection) = config.connect(tokio_postgres::NoTls).await?;
        tokio::spawn(connection);
        client.simple_query("SELECT 1").await.map(|_| ())
    }
    async fn tenant(rig: &Rig, id: &str) -> postgres::Session {
        postgres::connect(&rig.machine.layout().socket_directory(id), "postgres", id)
            .await
            .unwrap()
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_resized_while_it_sleeps_wakes_within_its_new_limits() {
        let Some(rig) = Rig::new("resize-asleep").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);

        // The page resizes the sleeping database: its volume takes the new size before anything
        // starts it, and the slot it then binds takes the limits of the new size from its entry,
        // so that it never runs its new settings in its old limits.
        next(&mut db, 6);
        db["resources"] = json!({"memory_mib": 512, "cpu_millicores": 500, "storage_gib": 2});
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the new size to be kept", || {
            handle
                .state()
                .as_ref()
                .and_then(|state| state.resources.clone())
                .is_some_and(|resources| resources.memory_mib == 512)
        })
        .await;
        assert_eq!(rig.machine.volumes()[0].1, 2 << 30);
        assert_eq!(handle.phase(), Phase::Asleep);
        assert_eq!(
            rig.machine.limits(&id),
            None,
            "a sleeping database holds no slot"
        );
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(result.outcome, Outcome::Started, "{:?}", result.reason);
        let limits = rig.machine.limits(&id).unwrap();
        assert_eq!((limits.memory_mib, limits.cpu_millicores), (512, 500));
    }

    /// A resize ends in Cloudflare when the filesystem has the size, so the observation of a
    /// ready or sleeping database tells the size the filesystem has (its superblock's), also
    /// after a growth, and a growth that the kernel refused leaves the old size in it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_observation_tells_the_size_of_the_filesystem_and_a_refused_growth_leaves_it_as_it_is()
     {
        let Some(rig) = Rig::new("resize-fs").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        let (volume, created) = rig.machine.volumes()[0].clone();
        let gap = crate::storage::FS_END_GAP_BYTES;
        eventually(30, "the observation to tell the filesystem", || {
            handle.view().storage_bytes == Some(created - gap)
        })
        .await;
        assert_eq!(rig.observation(&id)["storage_bytes"], created - gap);

        // The kernel refuses the growth: the volume has the size and the filesystem keeps its
        // own, the page's size is not kept as applied, and the observation says so.
        rig.machine.set_growth_refused(true);
        next(&mut db, 6);
        db["resources"] = json!({"memory_mib": 512, "cpu_millicores": 500, "storage_gib": 2});
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the volume to be grown", || {
            rig.machine.volumes()[0].1 == 2 << 30
        })
        .await;
        eventually(30, "the observation of the new generation", || {
            rig.core
                .pending_observation(&id)
                .is_some_and(|observation| observation["generation"] == 6)
        })
        .await;
        assert_eq!(rig.observation(&id)["storage_bytes"], created - gap);
        assert_eq!(rig.machine.filesystem(&volume), Some(created - gap));
        assert_ne!(
            handle
                .state()
                .and_then(|state| state.resources)
                .map(|resources| resources.storage_gib),
            Some(2),
            "a growth that failed is not kept as done"
        );

        // The next decision tries again, and the observation follows the filesystem.
        rig.machine.set_growth_refused(false);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the filesystem to grow", || {
            handle.view().storage_bytes == Some((2 << 30) - gap)
        })
        .await;
        assert_eq!(rig.observation(&id)["storage_bytes"], (2u64 << 30) - gap);
        assert_eq!(rig.machine.filesystem(&volume), Some((2 << 30) - gap));
    }

    /// The agent restarts while a growth is open: the size that the filesystem has is the first
    /// thing it says of the database that it decides on, also of the one that sleeps (its state
    /// file holds a proof, and says `asleep` before anything is decided), and also while the
    /// volume is attached: a ready or sleeping database that tells no size is read by Cloudflare
    /// as one of an agent that never tells it, and the resize that is open ends with the state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_agent_that_restarts_during_a_growth_says_the_size_of_the_filesystem_first() {
        let Some(rig) = Rig::new("resize-restart").await else {
            return;
        };
        let (rig, mut db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        let (volume, created) = rig.machine.volumes()[0].clone();
        let old = created - crate::storage::FS_END_GAP_BYTES;
        // The page grows the sleeping database, the kernel refuses the growth, and the agent
        // cannot attach the volume yet.
        rig.machine.set_growth_refused(true);
        rig.machine.hold_mounts();
        next(&mut db, 6);
        db["resources"] = json!({"memory_mib": 256, "cpu_millicores": 250, "storage_gib": 2});
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the state file to be read", || {
            handle.view().state.is_some()
        })
        .await;
        // The state file has a proof and the entry is the page's, so the database would say
        // `asleep`: without a size it says nothing.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(handle.view().storage_bytes, None);
        assert!(
            rig.core
                .pending_observation(&id)
                .is_none_or(|observation| observation["state"] == "unproven"
                    || observation.get("storage_bytes").is_some()),
            "{:?}",
            rig.core.pending_observation(&id)
        );
        rig.machine.release_mounts();
        eventually(
            30,
            "the database to be decided on and the growth refused",
            || handle.view().adopted && rig.machine.volumes()[0].1 == 2 << 30,
        )
        .await;
        let observation = rig.observed(&id, "asleep").await;
        assert_eq!(observation["generation"], 6);
        assert_eq!(observation["storage_bytes"], old);
        assert_eq!(rig.machine.filesystem(&volume), Some(old));
    }

    /// A database that crashed, an agent that restarted, the recovery that proved its sleep and the
    /// wake after it: every ready and asleep it says has the size the filesystem has, the one a
    /// growth that failed left (the API ends a resize by it), and not one without.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_crash_a_restart_the_recovery_and_a_wake_never_say_ready_or_asleep_without_the_size()
    {
        let Some(rig) = Rig::new("resize-crash").await else {
            return;
        };
        let mut db = rig.entry_json();
        let (id, path) = (
            id_of(&db),
            db["archive"]["path"].as_str().unwrap().to_string(),
        );
        let _ = rig.create_from(&db).await;
        db.as_object_mut().unwrap().remove("origin");
        let (volume, created) = rig.machine.volumes()[0].clone();
        let old = created - crate::storage::FS_END_GAP_BYTES;

        // A growth the kernel refused, at generation 6, and then the crash of the database.
        rig.machine.set_growth_refused(true);
        next(&mut db, 6);
        db["resources"] = json!({"memory_mib": 256, "cpu_millicores": 250, "storage_gib": 2});
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the volume to be grown", || {
            rig.machine.volumes()[0].1 == 2 << 30
        })
        .await;
        rig.machine.crash(&id);
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        // Whatever the agent queues for the database while this goes on.
        let seen = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let watch = tokio::spawn({
            let (core, id, seen) = (rig.core.clone(), id.clone(), seen.clone());
            async move {
                loop {
                    if let Some(observation) = core.pending_observation(&id)
                        && matches!(observation["state"].as_str(), Some("ready" | "asleep"))
                        && observation.get("storage_bytes").is_none()
                    {
                        seen.lock().unwrap().push(observation);
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        });
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(60, "the recovery to prove the sleep", || {
            handle.phase() == Phase::Asleep
                && handle.state().as_ref().is_some_and(|s| s.record.is_some())
        })
        .await;
        let asleep = rig.observed(&id, "asleep").await;
        assert_eq!(asleep["generation"], 6);
        assert_eq!(asleep["storage_bytes"], old);
        let mut ticket = Rig::ticket(&rig.entry_for(&db));
        ticket.operation = "op_rrrrrrrrrrrrrrrrrrrr".into();
        assert_eq!(rig.core.wake(&ticket).await.outcome, Outcome::Started);
        let ready = rig.observed(&id, "ready").await;
        assert_eq!(ready["storage_bytes"], old);
        assert_eq!(rig.machine.filesystem(&volume), Some(old));
        watch.abort();
        // Never one without, at any moment the watch looked.
        assert!(
            seen.lock().unwrap().is_empty(),
            "{:?}",
            seen.lock().unwrap()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn legacy_growth_stops_a_warm_database_only_with_its_sleep_proof() {
        let Some(rig) = Rig::new("resize-legacy").await else {
            return;
        };
        let mut entry = rig.entry_json();
        let (_, db) = rig.create_from(&entry).await;
        let id = id_of(&entry);
        rig.machine.set_offline_growth(true);
        next(&mut entry, 6);
        entry["resources"]["storage_gib"] = 2.into();
        rig.core.apply(&Rig::page(vec![entry], vec![])).await;
        eventually(60, "legacy filesystem to grow", || {
            db.view().storage_bytes == Some((2 << 30) - crate::storage::FS_END_GAP_BYTES)
        })
        .await;
        assert_eq!(db.phase(), Phase::Asleep);
        assert!(db.state().unwrap().record.is_some());
        let calls = rig.machine.calls();
        let stop = calls.iter().rposition(|call| call == &format!("stop {id}"));
        let grow = calls.iter().rposition(|call| call == &format!("grow {id}"));
        assert!(stop.is_some() && stop < grow, "{calls:?}");
    }

    /// A grow requested after a crash must happen before PostgreSQL recovery; otherwise a full
    /// filesystem cannot run recovery to reach the phase in which resize used to be applied.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_requested_grow_precedes_recovery_of_an_unproven_database() {
        let Some(rig) = Rig::new("resize-unproven").await else {
            return;
        };
        let mut entry = rig.entry_json();
        let _ = rig.create_from(&entry).await;
        let id = id_of(&entry);
        let path = entry["archive"]["path"].as_str().unwrap().to_string();
        rig.machine.crash(&id);
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        let calls_before = rig.machine.calls().len();
        next(&mut entry, 6);
        entry["resources"]["storage_gib"] = 2.into();
        rig.core.apply(&Rig::page(vec![entry], vec![])).await;
        let db = rig.core.db(&id);
        eventually(60, "recovery to prove sleep", || {
            db.phase() == Phase::Asleep && db.state().is_some_and(|state| state.record.is_some())
        })
        .await;
        let calls = rig.machine.calls();
        let calls = &calls[calls_before..];
        let grow = calls.iter().position(|call| call == &format!("grow {id}"));
        let start = calls.iter().position(|call| call == &format!("start {id}"));
        assert!(grow.is_some() && grow < start, "{calls:?}");
        assert_eq!(
            db.view().storage_bytes,
            Some((2 << 30) - crate::storage::FS_END_GAP_BYTES)
        );
    }

    /// The next generation of a page entry: the same database, moved on by the API.
    fn next(db: &mut Value, generation: u64) {
        db.as_object_mut().unwrap().remove("origin");
        db["generation"] = json!(generation);
        db["operation"] = json!(format!("op_{:0>20}", format!("g{generation}")));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_roles_of_the_page_are_applied_when_they_change_and_a_deleted_role_is_removed() {
        let Some(rig) = Rig::new("roles-page").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        db["roles"].as_array_mut().unwrap().push(
            json!({"name": "temp", "owner": false, "password": testpg::password(3), "revision": 3}),
        );
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        login(&rig, &id, "reader", &testpg::password(2))
            .await
            .unwrap();
        login(&rig, &id, "temp", &testpg::password(3))
            .await
            .unwrap();

        next(&mut db, 5);
        db["roles"] = json!([
            {"name": "app", "owner": true, "password": testpg::password(1), "revision": 1},
            {"name": "reader", "owner": false, "password": testpg::password(4), "revision": 4},
            {"name": "temp", "state": "absent"}
        ]);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the roles", || {
            handle
                .state()
                .as_ref()
                .is_some_and(|s| s.roles.get("reader") == Some(&4))
                && !handle.view().roles_removed.is_empty()
        })
        .await;
        assert!(
            login(&rig, &id, "reader", &testpg::password(2))
                .await
                .is_err()
        );
        login(&rig, &id, "reader", &testpg::password(4))
            .await
            .unwrap();
        assert!(
            login(&rig, &id, "temp", &testpg::password(3))
                .await
                .is_err()
        );
        let observation = rig.observation(&id);
        assert_eq!(
            observation["roles"],
            json!({"removed": ["temp"], "blocked": []})
        );
        let state = handle.state().unwrap();
        assert_eq!(
            state.roles,
            [("app".to_string(), 1), ("reader".to_string(), 4)].into()
        );
        assert!(contract_valid(
            "NodeObservationReport",
            &json!({"observed_at": "2026-10-18T10:11:12.345Z", "databases": [observation], "orders": []})
        ));

        // While the database sleeps the page changes the roles again: they are the page's before
        // the first login of the next wake.
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        next(&mut db, 6);
        db["roles"] = json!([
            {"name": "app", "owner": true, "password": testpg::password(5), "revision": 5},
            {"name": "reader", "owner": false, "password": testpg::password(4), "revision": 4}
        ]);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(10, "the entry", || {
            handle
                .view()
                .entry
                .as_ref()
                .is_some_and(|e| e.generation == 6)
        })
        .await;
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        login(&rig, &id, "app", &testpg::password(5)).await.unwrap();
        assert!(login(&rig, &id, "app", &testpg::password(1)).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_outlasts_its_deadline_is_refused_and_its_late_start_still_applies_the_roles()
     {
        let timing = crate::agent::Timing {
            wake_start: std::time::Duration::from_millis(300),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("late-roles", timing).await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);

        // While it sleeps the page changes a password.
        next(&mut db, 6);
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
                .is_some_and(|e| e.generation == 6)
        })
        .await;

        // The start takes longer than the wake may: the gateway is told to ask again.
        rig.machine
            .delay_next_start(std::time::Duration::from_millis(1500));
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (Outcome::Refused, Some("start_timeout"))
        );
        // The start goes on, and the database is released only with the page's roles.
        eventually(30, "the late start to release the database", || {
            handle.phase() == Phase::Ready
        })
        .await;
        login(&rig, &id, "app", &testpg::password(5)).await.unwrap();
        assert!(login(&rig, &id, "app", &testpg::password(1)).await.is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_orders_move_maintenance_fence_and_superseded_do_what_they_say_and_no_more() {
        let Some(rig) = Rig::new("orders").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");

        // A move: the source proves its sleep, holds its wakes, and reports when it sleeps.
        let hold = Order::Move {
            operation: "op_vvvvvvvvvvvvvvvvvvvv".into(),
            database: id.clone(),
            storage_generation: 1,
        };
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![hold]))
            .await;
        eventually(60, "the move order", || {
            rig.core.pending_order("op_vvvvvvvvvvvvvvvvvvvv").is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order("op_vvvvvvvvvvvvvvvvvvvv").unwrap()["status"],
            "done"
        );
        assert_eq!(handle.phase(), Phase::Asleep);
        assert_eq!(rig.observation(&id)["state"], "asleep");
        let entry = rig.entry_for(&db);
        assert_eq!(
            rig.core.wake(&Rig::ticket(&entry)).await.reason.as_deref(),
            Some("moving")
        );
        // The API has the result: the order leaves the page, and the hold with it.
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        assert_eq!(handle.view().moving, None);
        assert_eq!(
            rig.core.wake(&Rig::ticket(&entry)).await.outcome,
            Outcome::Started
        );

        // Maintenance: every database sleeps with its proof, and new wakes are held.
        let maintenance = Order::Maintenance {
            operation: "op_tttttttttttttttttttt".into(),
        };
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![maintenance]))
            .await;
        // The databases sleep with their proofs; the packages and the check are the service's, and
        // the order is answered when they are done.
        let mut slept = Vec::new();
        eventually(60, "the maintenance order", || {
            slept.extend(rig.core.take_slept());
            !slept.is_empty()
        })
        .await;
        assert_eq!(slept, ["op_tttttttttttttttttttt"]);
        assert!(rig.core.pending_order("op_tttttttttttttttttttt").is_none());
        assert_eq!(handle.phase(), Phase::Asleep);
        let mut ticket = Rig::ticket(&entry);
        ticket.generation = entry.generation + 1;
        ticket.operation = "op_mmmmmmmmmmmmmmmmmmmm".into();
        assert_eq!(
            rig.core.wake(&ticket).await.reason.as_deref(),
            Some("maintenance")
        );
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        assert_eq!(rig.core.wake(&ticket).await.outcome, Outcome::Started);

        // Superseded: the generation is never started again and its volume goes with the order.
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let order = Order::Superseded {
            operation: "op_ssssssssssssssssssss".into(),
            database: id.clone(),
            storage_generation: 1,
            remove_volume: true,
        };
        rig.core
            .apply(&Rig::page(vec![], vec![order.clone()]))
            .await;
        eventually(30, "the superseded order", || {
            rig.core.pending_order("op_ssssssssssssssssssss").is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order("op_ssssssssssssssssssss").unwrap()["status"],
            "done"
        );
        assert!(rig.machine.volumes().is_empty());
        assert_eq!(handle.phase(), Phase::Retired);
        assert_eq!(rig.gateway.get(&id).unwrap().mode, Mode::Retired);
        ticket.generation += 1;
        assert_eq!(
            rig.core.wake(&ticket).await.reason.as_deref(),
            Some("superseded")
        );
        // The order stays after the node restarted, on its disk, whatever the page lists.
        let rig = rig.restart().await;
        assert!(rig.core.fences.blocks(&id, 1));
        assert!(rig.core.fences.removable(&id, 1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_fenced_node_starts_nothing_and_stays_fenced_after_a_restart() {
        let Some(rig) = Rig::new("fence").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");
        // The pool holds idle slots when the order comes: they belong to what runs.
        rig.core.refill_pass().await;
        assert!(rig.machine.slots().idle > 0);
        let fence = Order::Fence {
            operation: "op_ffffffffffffffffffff".into(),
        };
        rig.core.apply(&Rig::page(vec![], vec![fence])).await;
        eventually(30, "the fence", || {
            rig.core.pending_order("op_ffffffffffffffffffff").is_some()
        })
        .await;
        assert!(
            !rig.machine.running(&id),
            "what runs is stopped by the order"
        );
        assert_eq!(
            rig.machine.slots(),
            crate::units::slots::Snapshot::default(),
            "the idle slots are stopped too, and the slot of the database is free"
        );
        rig.core.refill_pass().await;
        assert_eq!(rig.machine.slots().idle, 0, "a fenced node builds none");
        assert_eq!(handle.phase(), Phase::Retired);
        assert_eq!(rig.gateway.get(&id).unwrap().mode, Mode::Retired);
        assert_eq!(
            rig.core
                .wake(&Rig::ticket(&rig.entry_for(&db)))
                .await
                .reason
                .as_deref(),
            Some("fenced")
        );
        let rig = rig.restart().await;
        assert!(rig.core.fences.fenced());
        // A page the node is given later does not start anything on a fenced node.
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(!rig.machine.running(&id));
        assert_eq!(rig.core.db(&id).view().phase, Phase::Retired);
    }

    /// A database that runs in a unit of its own, as an agent of an earlier release started it, is
    /// found, released and put to sleep as it was, and its next wake takes a slot. While the unit
    /// runs no slot is bound for the database: a second PostgreSQL is what that keeps.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_unit_of_its_own_that_runs_is_adopted_and_put_to_sleep_and_the_next_wake_takes_a_slot()
     {
        let Some(rig) = Rig::new("legacy-unit").await else {
            return;
        };
        rig.machine.direct_archive();
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let (entry, handle) = rig.create_from(&db).await;
        db.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        rig.machine.start_legacy(&id).await.unwrap();

        let rig = rig.restart().await;
        rig.deliver(db["archive"]["path"].as_str().unwrap(), "read_write");
        let unit = rig.machine.unit(&id).await.unwrap();
        assert!(unit.active.awake() && unit.slot.is_none(), "{unit:?}");
        // The unit of its own holds the database: no slot is bound for it meanwhile.
        let volume = crate::storage::VolumeId::new(&id, 1).unwrap();
        let mounted = rig
            .machine
            .mount_volumes(std::slice::from_ref(&volume))
            .await;
        assert!(mounted.unwrap().is_empty());
        assert!(matches!(
            rig.machine.start(&id).await,
            Err(crate::units::Error::Held)
        ));
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(60, "the unit to be released", || {
            handle.phase() == Phase::Ready && handle.view().writer.is_some()
        })
        .await;
        assert_eq!(rig.machine.slots().held, 0, "it runs in no slot");

        // It sleeps with its proof as it always did, and wakes in a slot.
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        assert!(!rig.machine.running(&id));
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, Outcome::Started, "{:?}", result.reason);
        assert!(rig.machine.running(&id));
        assert_eq!(rig.machine.slots().held, 1);
        assert!(rig.machine.unit(&id).await.unwrap().slot.is_some());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_that_is_fenced_stops_every_unit_it_finds_before_it_says_so() {
        let Some(rig) = Rig::new("fence-restart").await else {
            return;
        };
        let (db, other) = (rig.entry_json(), rig.entry_json());
        let ids = [id_of(&db), id_of(&other)];
        rig.core
            .apply(&Rig::page(vec![db.clone(), other], vec![]))
            .await;
        for id in &ids {
            let handle = rig.core.db(id);
            eventually(90, "ready", || handle.phase() == Phase::Ready).await;
        }
        // The fence reached the disk and the agent went down before it acted: it comes back with
        // units that run and a first page that holds the fence and no database.
        rig.core.fences.fence("op_ffffffffffffffffffff").unwrap();
        let rig = rig.restart().await;
        assert!(ids.iter().all(|id| rig.machine.running(id)));
        let fence = Order::Fence {
            operation: "op_ffffffffffffffffffff".into(),
        };
        rig.core.apply(&Rig::page(vec![], vec![fence])).await;
        eventually(30, "the fence", || {
            rig.core.pending_order("op_ffffffffffffffffffff").is_some()
        })
        .await;
        assert!(
            ids.iter().all(|id| !rig.machine.running(id)),
            "what runs is stopped by the order, whether or not the page names it"
        );
        assert_eq!(
            rig.core.pending_order("op_ffffffffffffffffffff").unwrap()["status"],
            "done"
        );
        assert!(
            rig.core
                .admission
                .snapshot()
                .await
                .unwrap()
                .awake
                .is_empty()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_stops_the_unit_of_a_superseded_generation_it_has_no_record_of() {
        let Some(rig) = Rig::new("superseded-restart").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        let rig = rig.restart().await;
        assert!(rig.machine.running(&id));
        let order = Order::Superseded {
            operation: "op_ssssssssssssssssssss".into(),
            database: id.clone(),
            storage_generation: 1,
            remove_volume: false,
        };
        rig.core.apply(&Rig::page(vec![], vec![order])).await;
        eventually(30, "the superseded order", || {
            rig.core.pending_order("op_ssssssssssssssssssss").is_some()
        })
        .await;
        assert!(!rig.machine.running(&id));
        assert_eq!(
            rig.core.pending_order("op_ssssssssssssssssssss").unwrap()["status"],
            "done"
        );
    }

    /// The unit's own mount says which generation it serves: an order for the generation before
    /// it takes that generation's volume and leaves the unit of the next one running, though the
    /// agent that restarted has neither a record of the database nor a mount of its volume.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_leaves_the_unit_of_a_later_generation_than_a_superseded_order_names()
    {
        let Some(rig) = Rig::new("superseded-later").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        // The database moved here from itself: the unit runs on generation 2 (the volume of
        // generation 1 stays until the order releases it).
        let (first, second) = (
            crate::storage::VolumeId::new(&id, 1).unwrap(),
            crate::storage::VolumeId::new(&id, 2).unwrap(),
        );
        rig.machine.stop(&id).await.unwrap();
        rig.machine.unmount_volume(&first).await.unwrap();
        let account = rig.machine.account(&id).unwrap();
        let storage = rig.core.policy().storage.clone();
        rig.machine
            .create_volume(&second, 1 << 30, &account, &storage)
            .await
            .unwrap();
        // A move restored the database's files into it: here, the first generation's directory
        // that the double set aside stands for them.
        let layout = rig.core.layout().clone();
        std::fs::remove_dir_all(layout.volume(&id)).unwrap();
        std::fs::rename(layout.volume(&format!("{id}.g1")), layout.volume(&id)).unwrap();
        rig.machine.start(&id).await.unwrap();
        let rig = rig.restart().await;
        assert!(rig.machine.running(&id));
        assert_eq!(rig.machine.unit_volume(&id).await.unwrap(), Some(second));
        let order = Order::Superseded {
            operation: "op_ssssssssssssssssssss".into(),
            database: id.clone(),
            storage_generation: 1,
            remove_volume: true,
        };
        rig.core.apply(&Rig::page(vec![], vec![order])).await;
        eventually(30, "the superseded order", || {
            rig.core.pending_order("op_ssssssssssssssssssss").is_some()
        })
        .await;
        assert!(rig.machine.running(&id), "the unit serves generation 2");
        assert_eq!(
            rig.core.pending_order("op_ssssssssssssssssssss").unwrap()["status"],
            "done"
        );
        assert_eq!(
            rig.machine
                .volumes()
                .iter()
                .map(|(volume, _)| volume.generation())
                .collect::<Vec<_>>(),
            [2]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_finds_what_runs_what_sleeps_and_what_crashed() {
        let Some(rig) = Rig::new("restart").await else {
            return;
        };
        rig.machine.direct_archive();
        let (mut running, mut sleeping, mut crashed) =
            (rig.entry_json(), rig.entry_json(), rig.entry_json());
        let ids = [id_of(&running), id_of(&sleeping), id_of(&crashed)];
        rig.core
            .apply(&Rig::page(
                vec![running.clone(), sleeping.clone(), crashed.clone()],
                vec![],
            ))
            .await;
        for id in &ids {
            let handle = rig.core.db(id);
            eventually(90, "ready", || handle.phase() == Phase::Ready).await;
        }
        for json in [&mut running, &mut sleeping, &mut crashed] {
            json.as_object_mut().unwrap().remove("origin");
        }
        assert_eq!(
            rig.core.sleep(&rig.core.db(&ids[1]), Why::Idle).await,
            Slept::Proven
        );
        let data = tenant(&rig, &ids[2]).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 777) AS a")
            .await
            .unwrap();
        drop(data);
        rig.machine.crash(&ids[2]);

        // The agent restarts. Its units run on; the crashed one does not.
        let rig = rig.restart().await;
        for json in [&running, &sleeping, &crashed] {
            rig.deliver(json["archive"]["path"].as_str().unwrap(), "read_write");
        }
        rig.core
            .apply(&Rig::page(
                vec![running.clone(), sleeping.clone(), crashed.clone()],
                vec![],
            ))
            .await;
        let (a, b, c) = (
            rig.core.db(&ids[0]),
            rig.core.db(&ids[1]),
            rig.core.db(&ids[2]),
        );
        eventually(60, "the units to be found", || {
            a.phase() == Phase::Ready && b.phase() == Phase::Asleep
        })
        .await;
        // What ran is admitted as awake from the units; it is released again without a start.
        assert_eq!(
            rig.core.admission.snapshot().await.unwrap().awake.first(),
            Some(&ids[0])
        );
        assert_eq!(rig.gateway.get(&ids[0]).unwrap().mode, Mode::Running);
        assert_eq!(rig.gateway.get(&ids[1]).unwrap().mode, Mode::Sleeping);
        // What crashed is recovered through admission and proven.
        eventually(60, "the recovery", || {
            c.phase() == Phase::Asleep && c.state().as_ref().is_some_and(|s| s.record.is_some())
        })
        .await;
        let ticket = |json: &Value| {
            let mut ticket = Rig::ticket(&rig.entry_for(json));
            ticket.operation = "op_rrrrrrrrrrrrrrrrrrrr".into();
            ticket
        };
        assert_eq!(
            rig.core.wake(&ticket(&crashed)).await.outcome,
            Outcome::Started
        );
        let data = tenant(&rig, &ids[2]).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 777);
        assert_eq!(
            rig.core.wake(&ticket(&sleeping)).await.outcome,
            Outcome::Started
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_that_cannot_read_lvm_or_systemd_decides_nothing_until_it_can() {
        let Some(rig) = Rig::new("unreadable").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");
        let page = Rig::page(vec![db.clone()], vec![]);
        let pid = rig.machine.unit(&id).await.unwrap().main_pid;

        let mut rig = rig;
        for unreadable in ["volumes", "units"] {
            // The agent restarts and cannot read what it would decide from: what it does not
            // know is neither a missing volume nor a stopped unit.
            rig = rig.restart().await;
            rig.deliver(&path, "read_write");
            match unreadable {
                "volumes" => rig.machine.set_volumes_unreadable(true),
                _ => rig.machine.set_units_unreadable(true),
            }
            rig.core.apply(&page).await;
            let handle = rig.core.db(&id);
            eventually(10, "the decision to be tried", || {
                handle.view().reconcile == super::super::Reconcile::Idle
            })
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            assert!(
                !matches!(handle.phase(), Phase::Error | Phase::Unproven),
                "{unreadable}: {:?} {:?}",
                handle.phase(),
                handle.view().error
            );
            assert!(rig.machine.running(&id));
            // The next pull reads them, and finds the database running as it was.
            rig.machine.set_volumes_unreadable(false);
            rig.machine.set_units_unreadable(false);
            rig.core.apply(&page).await;
            eventually(30, "the running database to be found", || {
                handle.phase() == Phase::Ready
            })
            .await;
            assert_eq!(rig.machine.unit(&id).await.unwrap().main_pid, pid);
        }
    }

    /// A bus that refuses the call that waits for a running database's unit says nothing of the
    /// unit: the database is neither served nor recovered on it, and recovery would stop it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_running_database_that_the_bus_will_not_tell_about_is_not_recovered() {
        let Some(rig) = Rig::new("restart-bus").await else {
            return;
        };
        let mut db = rig.entry_json();
        let (id, path) = (
            id_of(&db),
            db["archive"]["path"].as_str().unwrap().to_string(),
        );
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");
        let pid = rig.machine.unit(&id).await.unwrap().main_pid;

        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        rig.machine.clear_calls();
        rig.machine.fail_next_waits(1);
        let page = Rig::page(vec![db.clone()], vec![]);
        rig.core.apply(&page).await;
        let handle = rig.core.db(&id);
        eventually(30, "the running database to be found", || {
            handle.phase() == Phase::Ready
        })
        .await;
        assert_eq!(rig.machine.unit(&id).await.unwrap().main_pid, pid);
        let calls = rig.machine.calls();
        assert!(
            !calls
                .iter()
                .any(|call| call.starts_with("start") || call.starts_with("stop")),
            "{calls:?}"
        );
    }

    /// The agent's mounts end with it. It attaches a database's volume when it decides on the
    /// database, which reads `pg_control` through the mount, and asks nothing of a volume that is
    /// attached.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_attaches_the_volume_of_a_database_when_it_decides_on_it() {
        let Some(rig) = Rig::new("restart-attach").await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        let volume = VolumeId::new(&id, 1).unwrap();
        assert!(!rig.machine.attached(&volume));
        rig.machine.clear_calls();
        let page = Rig::page(vec![db.clone()], vec![]);
        rig.core.apply(&page).await;
        let handle = rig.core.db(&id);
        eventually(30, "the database to be adopted", || handle.view().adopted).await;
        assert!(rig.machine.attached(&volume));
        assert_eq!(handle.phase(), Phase::Asleep);
        let mounts = |machine: &crate::machine::local::Local| {
            machine
                .calls()
                .into_iter()
                .filter(|call| call.starts_with("mount"))
                .count()
        };
        assert_eq!(mounts(&rig.machine), 1);
        rig.core.apply(&page).await;
        eventually(10, "the pull to be decided on", || {
            handle.view().reconcile == super::super::Reconcile::Idle
        })
        .await;
        assert_eq!(mounts(&rig.machine), 1);
    }

    /// A database that sleeps provenly, as the page names it once it was built, and an agent that
    /// restarted while it slept: nothing is decided on it yet. Its entry and its archive path.
    async fn restarted_sleeper(rig: Rig) -> (Rig, Value, String) {
        let mut db = rig.entry_json();
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        let (_, handle) = rig.create_from(&db).await;
        db.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        (rig, db, path)
    }

    /// A start was in flight when the agent began. The bus refuses the call that waits for its
    /// unit when the agent decides on the database, which says nothing of the unit: the start
    /// stays counted, as it holds its memory, and ends ready with the decision that the retry
    /// makes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_in_flight_when_the_agent_began_stays_counted_when_the_bus_will_not_answer() {
        let Some(rig) = Rig::new("resumed-bus").await else {
            return;
        };
        let mut db = rig.entry_json();
        let (id, path) = (
            id_of(&db),
            db["archive"]["path"].as_str().unwrap().to_string(),
        );
        let (_, handle) = rig.create_from(&db).await;
        db.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        // A start of it is in flight when the agent restarts: its unit is activating.
        rig.machine
            .delay_next_start(std::time::Duration::from_millis(1500));
        tokio::spawn({
            let (machine, id) = (rig.machine.clone(), id.clone());
            async move { machine.start(&id).await }
        });
        eventually(10, "the unit to be activating", || {
            rig.machine.running(&id)
                && rig.machine.active_state(&id) == crate::units::ActiveState::Activating
        })
        .await;
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        let snapshot = rig.core.admission.snapshot().await.unwrap();
        assert_eq!((snapshot.awake, snapshot.starting), (vec![id.clone()], 1));
        rig.machine.fail_next_waits(1);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the database to be released", || {
            handle.phase() == Phase::Ready
        })
        .await;
        let snapshot = rig.core.admission.snapshot().await.unwrap();
        assert_eq!(
            (snapshot.awake, snapshot.starting),
            (vec![id.clone()], 0),
            "a bus that would not answer did not fail the start"
        );
        // The wake's burst was the old agent's, and its timer died with it: the quota of the
        // class comes at once, with the decision that ends the start (`cpu_boost_ms`).
        assert_eq!(rig.machine.quota(&id), Some(std::num::NonZeroU32::new(250)));
    }

    /// A start was in flight when the agent read its units, and its unit is not awake when the
    /// agent decides on the database (the start failed): it holds nothing, and the database is
    /// not counted as awake.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_start_in_flight_when_the_agent_began_that_failed_is_not_counted() {
        let Some(rig) = Rig::new("resumed-failed").await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let (_, handle) = rig.create_from(&db).await;
        db.as_object_mut().unwrap().remove("origin");
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let rig = rig
            .restart_with(vec![crate::admission::Running {
                database: id.clone(),
                memory_mib: 256,
                starting: true,
                always_warm: false,
            }])
            .await;
        let snapshot = rig.core.admission.snapshot().await.unwrap();
        assert_eq!((snapshot.awake, snapshot.starting), (vec![id.clone()], 1));
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the database to be decided on", || {
            let view = handle.view();
            view.adopted && view.phase == Phase::Asleep
        })
        .await;
        let snapshot = rig.core.admission.snapshot().await.unwrap();
        assert!(
            snapshot.awake.is_empty(),
            "a start whose unit is not awake is not counted: {snapshot:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_decision_that_could_not_read_its_facts_is_tried_again_until_the_database_is_adopted()
    {
        let Some(rig) = Rig::new("reconcile-retry").await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        // LVM and systemd answer the first questions with errors, as they do under the load of an
        // agent's start: three of LVM, then two of systemd.
        rig.machine.fail_next_volume_reads(3);
        rig.machine.fail_next_unit_reads(2);
        let before = rig.machine.reads();
        // One pull, and no other: the page does not change, and nothing pulls again.
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(
            30,
            "the database to be adopted without another pull",
            || handle.view().adopted,
        )
        .await;
        assert_eq!(handle.phase(), Phase::Asleep);
        // The retries are the failures and the round that read both; they end with the adoption.
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let after = rig.machine.reads();
        assert_eq!((after.0 - before.0, after.1 - before.1), (6, 3));
        assert_eq!(handle.view().reconcile, super::super::Reconcile::Idle);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_before_the_node_has_decided_on_the_database_has_it_decided_and_starts_it() {
        // The retry would come in half a minute: only the wake brings the decision sooner.
        let timing = crate::agent::Timing {
            recovery_retry: std::time::Duration::from_secs(30),
            recovery_retry_maximum: std::time::Duration::from_secs(30),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("wake-adopts", timing).await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        rig.machine.set_volumes_unreadable(true);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(10, "the decision to be tried", || {
            handle.view().reconcile == super::super::Reconcile::Idle
        })
        .await;
        assert!(!handle.view().adopted);
        // LVM answers again, and the Edge's wake arrives before anything decided.
        rig.machine.set_volumes_unreadable(false);
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        assert!(handle.view().adopted);
        assert!(rig.machine.running(&id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_waits_for_the_decision_only_as_long_as_the_gateway_holds_it_for_the_answer() {
        let timing = crate::agent::Timing {
            recovery_retry: std::time::Duration::from_secs(30),
            recovery_retry_maximum: std::time::Duration::from_secs(30),
            adopt_wait: std::time::Duration::from_millis(300),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("wake-adopt-bound", timing).await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        rig.machine.set_volumes_unreadable(true);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let ticket = Rig::ticket(&rig.entry_for(&db));
        // LVM does not answer: the wake is refused as `wake_in_progress`, which the gateway does
        // not answer its connections with, once the wait is over, and nothing was started.
        let began = std::time::Instant::now();
        let result = rig.core.wake(&ticket).await;
        assert_eq!(
            (result.outcome, result.reason.as_deref()),
            (Outcome::Refused, Some("wake_in_progress"))
        );
        assert!(began.elapsed() >= std::time::Duration::from_millis(300));
        assert!(began.elapsed() < std::time::Duration::from_secs(3));
        assert!(!rig.core.db(&id).view().adopted);
        assert!(!rig.machine.running(&id));
        // The gateway delivers the ticket again; LVM answers by then.
        rig.machine.set_volumes_unreadable(false);
        let again = rig.core.wake(&ticket).await;
        assert_eq!(again.outcome, Outcome::Started, "{again:?}");
        assert!(rig.machine.running(&id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_resume_order_at_the_start_of_the_agent_waits_for_the_decision_and_ends_done() {
        // The wait of one wake is short here: the order must outlast it, as the order of a node
        // whose LVM answers late outlasts the gateway's 2 s.
        let timing = crate::agent::Timing {
            adopt_wait: std::time::Duration::from_millis(300),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("resume-after-restart", timing).await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        let operation = db["operation"].as_str().unwrap().to_string();
        let resume = Order::Wake {
            operation: operation.clone(),
            database: id.clone(),
            generation: db["generation"].as_u64().unwrap(),
        };
        rig.machine.set_volumes_unreadable(true);
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![resume]))
            .await;
        // LVM does not answer for several waits of a wake. The order has no result meanwhile: the
        // API would fail the resume with it, and nothing starts the database again.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        assert_eq!(rig.core.pending_order(&operation), None);
        assert!(!rig.machine.running(&id));
        rig.machine.set_volumes_unreadable(false);
        eventually(30, "the resume to end", || {
            rig.core.pending_order(&operation).is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order(&operation).unwrap()["status"],
            "done"
        );
        assert!(rig.machine.running(&id));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_state_that_cannot_be_read_is_tried_again_and_only_one_that_cannot_be_trusted_fails()
    {
        let Some(rig) = Rig::new("state-unread").await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        let file = rig.core.files(&id).directory().join("state.json");
        let kept = file.with_extension("kept");
        // A file that cannot be read is no statement about the database: a directory stands in for
        // it, which fails with `EISDIR` for any user.
        std::fs::rename(&file, &kept).unwrap();
        std::fs::create_dir(&file).unwrap();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(10, "the decision to be tried again", || {
            let view = handle.view();
            view.adopted || view.retrying
        })
        .await;
        assert!(!handle.view().adopted);
        assert_ne!(handle.phase(), Phase::Error);
        // It reads again, and the node decides.
        std::fs::remove_dir(&file).unwrap();
        std::fs::rename(&kept, &file).unwrap();
        eventually(30, "the database to be adopted", || handle.view().adopted).await;
        assert_eq!(handle.phase(), Phase::Asleep);

        // A state that is read and cannot be trusted stays an error, not a new database.
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        std::fs::write(
            rig.core.files(&id).directory().join("state.json"),
            "{not a state",
        )
        .unwrap();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(10, "the state to be refused", || handle.view().adopted).await;
        assert_eq!(handle.phase(), Phase::Error);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_decision_that_could_not_read_says_so_only_until_the_database_is_adopted() {
        let Some(rig) = Rig::new("reconcile-unread").await else {
            return;
        };
        let (rig, db, _) = restarted_sleeper(rig).await;
        let id = id_of(&db);
        let unread = |id: &str| -> Vec<Value> {
            crate::events::seen()
                .into_iter()
                .filter(|e| e["event"] == "reconcile_unread" && e["database_id"] == id)
                .collect()
        };
        rig.machine.fail_next_volume_reads(1);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the database to be adopted", || handle.view().adopted).await;
        // The first reading failed: the event names what could not be read and how.
        let events = unread(&id);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0]["fields"]["fact"], "volume");
        assert_eq!(events[0]["fields"]["class"], "storage_unexpected");
        // Adopted, the pulls decide again and may fail to read, silently: the node already has
        // its decision, and the ring of events holds only 64.
        rig.machine.fail_next_unit_reads(2);
        for _ in 0..2 {
            rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
            eventually(10, "the pull to be decided on", || {
                handle.view().reconcile == super::super::Reconcile::Idle
            })
            .await;
        }
        assert_eq!(unread(&id).len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_archives_what_it_found_running_and_what_it_wakes() {
        // One database, archived through the agent's own socket as on a node.
        let timing = crate::agent::Timing {
            archive_wait: std::time::Duration::from_secs(5),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("restart-archive", timing).await else {
            return;
        };
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");

        // The agent restarts while the database runs: what it writes reaches the archive, and it
        // sleeps with its proof.
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the running unit to be found", || {
            handle.phase() == Phase::Ready
        })
        .await;
        let data = tenant(&rig, &id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 100) AS a")
            .await
            .unwrap();
        drop(data);
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);

        // The agent restarts while it sleeps: the wake's writes reach the archive too.
        let rig = rig.restart().await;
        rig.deliver(&path, "read_write");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the sleeping database to be found", || {
            let view = handle.view();
            view.phase == Phase::Asleep && view.adopted
        })
        .await;
        let woken = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(woken.outcome, Outcome::Started, "{:?}", woken.reason);
        let data = tenant(&rig, &id).await;
        data.batch("INSERT INTO t SELECT generate_series(101, 200)")
            .await
            .unwrap();
        drop(data);
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
    }

    /// A database that exists, with a table of 4000 rows, asleep with its proof.
    async fn source(rig: &Rig) -> (Value, String, crate::state::DatabaseState) {
        source_in_class(rig, 256, 25).await
    }

    /// The same, of a class of `memory_mib` and `max_connections`.
    async fn source_in_class(
        rig: &Rig,
        memory_mib: u64,
        max_connections: u64,
    ) -> (Value, String, crate::state::DatabaseState) {
        let mut db = rig.entry_json();
        db["resources"]["memory_mib"] = json!(memory_mib);
        db["settings"]["max_connections"] = json!(max_connections);
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the source", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");
        let data = tenant(rig, &id).await;
        data.batch("CREATE TABLE t AS SELECT generate_series(1, 4000) AS a")
            .await
            .unwrap();
        drop(data);
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let state = handle.state().unwrap();
        (db, id, state)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_is_a_new_database_with_the_sources_data_and_the_pages_roles() {
        let Some(rig) = Rig::new("restore").await else {
            return;
        };
        let (source_json, source_id, source_state) = source(&rig).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = source_json["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        restored["roles"][0]["password"] = json!(testpg::password(9));
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);
        // The data of the source, in a database of the new name, under the page's roles.
        let data = tenant(&rig, &id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 4000);
        login(&rig, &id, "app", &testpg::password(9)).await.unwrap();
        assert!(login(&rig, &id, "app", &testpg::password(1)).await.is_err());
        // Its own first base backup is DONE, on the timeline the promotion made.
        let state = handle.state().unwrap();
        assert!(state.built && state.record.is_none());
        let own = state.backup.unwrap();
        assert_eq!(own.timeline, 2);
        assert_ne!(own.backup_id, backup.backup_id);
        // The source is untouched, asleep with its proof, and wakes.
        let source_handle = rig.core.db(&source_id);
        assert_eq!(source_handle.phase(), Phase::Asleep);
        let events = rig.core.take_events();
        assert!(
            events
                .iter()
                .any(|e| e["type"] == "admission" && e["start"] == "restore")
        );
        assert_eq!(rig.observation(&id)["state"], "ready");
    }

    /// A restore into a class smaller than its source's recovers on the source's settings, which
    /// PostgreSQL requires of a recovery with hot standby, and is restarted onto the class's own
    /// before it is ready: what the agent builds, with the real unit start, is ready only then.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_into_a_smaller_class_restarts_onto_the_classs_settings_before_it_is_ready() {
        let Some(rig) = Rig::new("restore-smaller").await else {
            return;
        };
        // The source is of a 1 GiB class with 200 connections; the restore is of the 256 MiB
        // class with 20.
        let (source_json, source_id, source_state) = source_in_class(&rig, 1024, 200).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = source_json["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        restored["settings"]["max_connections"] = json!(20);
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);

        let data = tenant(&rig, &id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 4000);
        for (name, value) in [
            ("max_connections", "20"),
            ("max_worker_processes", "4"),
            ("max_wal_senders", "0"),
        ] {
            let rows = data.query(&format!("SHOW {name}"), &[]).await.unwrap();
            assert_eq!(rows[0].get::<_, String>(0), value, "{name}");
        }
        // The route names the postmaster that serves: the one after the restart.
        let writer = handle.view().writer.clone().unwrap();
        let pid_file =
            std::fs::read_to_string(rig.core.layout().data(&id).join("postmaster.pid")).unwrap();
        assert_eq!(
            pid_file.lines().next().map(str::to_string),
            Some(writer.pid.to_string())
        );
        // Its own first base backup is DONE, from the class's settings.
        let own = handle.state().unwrap().backup.unwrap();
        assert_eq!(own.timeline, 2);
    }

    /// The pulls that still list a build that failed do not begin it again: the API's page names
    /// the build until it has ended the operation, and an agent that has just reported the failure
    /// pulls before it knows that. The database stays in its error with nothing of it on the node.
    async fn pulled_again_stays_failed(rig: &Rig, id: &str, entry: &Value, error: &'static str) {
        let handle = rig.core.db(id);
        let starts = || {
            rig.machine
                .calls()
                .iter()
                .filter(|call| **call == format!("start {id}"))
                .count()
        };
        let before = starts();
        for _ in 0..3 {
            rig.core
                .apply(&Rig::page(vec![entry.clone()], vec![]))
                .await;
            for _ in 0..15 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                assert_eq!(
                    handle.phase(),
                    Phase::Error,
                    "a build that failed is not begun again"
                );
            }
        }
        assert_eq!(starts(), before);
        assert_eq!(handle.view().error, Some(error));
        let observation = rig.observation(id);
        assert_eq!(
            (&observation["state"], &observation["error"]),
            (&json!("error"), &json!(error))
        );
        // Abandoned: the unit is stopped, the volume and the user are gone, and so is the state.
        assert!(!rig.machine.running(id));
        assert!(!rig.machine.has_account(id));
        assert!(
            rig.machine
                .volumes()
                .iter()
                .all(|(volume, _)| volume.database() != id)
        );
        assert_eq!(rig.core.files(id).load().unwrap(), None);
    }

    /// A restore that failed on a transient error of the archive: the node rebuilt it on the next
    /// pull, the build succeeded, and the API (which had failed the operation) never took the
    /// database as ready (found live, 2026-10-23, `tar` ending early).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_that_failed_is_not_rebuilt_by_the_pull_that_still_lists_it() {
        let Some(rig) = Rig::new("restore-failed").await else {
            return;
        };
        let (source_json, source_id, source_state) = source(&rig).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = source_json["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let handle = rig.core.db(&id);
        rig.fixture.set("restore-fail", "");
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(60, "the restore to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("archive_unusable"));
        // The archive answers again: the pull that lists the restore still does not build it.
        rig.fixture.clear("restore-fail");
        pulled_again_stays_failed(&rig, &id, &restored, "archive_unusable").await;
    }

    /// Every release restarts the agent, and the units of the databases and of the jobs run on.
    /// A restore that the agent was building is begun again by the one that comes after, with
    /// its state file, the data directory of the generation it was building and the PostgreSQL
    /// of the first run still there: it is built again, to the end, over an emptied directory
    /// and not over the postmaster that held the old one (found by review: barman refuses a
    /// destination that holds anything, and the restore failed with `archive_unusable`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_the_agent_was_building_when_it_restarted_is_built_again_to_the_end() {
        let Some(rig) = Rig::new("restore-restart").await else {
            return;
        };
        let (source_json, source_id, source_state) = source(&rig).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = source_json["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        let own_path = restored["archive"]["path"].as_str().unwrap().to_string();
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let entry = rig.entry_for(&restored);
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);
        let first = handle.view().writer.clone().unwrap().pid;
        // The agent went away before the first base backup, and PostgreSQL of the first run goes
        // on: the state says what it said after the build began, and the database's own archive
        // holds no backup.
        rig.core
            .files(&id)
            .save(&crate::state::DatabaseState::new(entry.storage_generation))
            .unwrap();
        std::fs::remove_dir_all(rig.fixture.store_directory().join(format!(
            "objects/{}/database/base",
            own_path.strip_prefix("s3://").unwrap()
        )))
        .unwrap();
        let rig = rig.restart().await;
        rig.deliver(&source_path, "read_only");
        rig.deliver(&own_path, "read_write");
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore, begun again", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);

        // The source's data, under a postmaster of the second run.
        let data = tenant(&rig, &id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 4000);
        assert_ne!(handle.view().writer.clone().unwrap().pid, first);
        let state = handle.state().unwrap();
        assert!(state.built && state.record.is_none());
        assert_eq!(state.backup.unwrap().timeline, 2);
        assert_eq!(rig.observation(&id)["state"], "ready");
    }

    /// The agent restarts after the first base backup of a restore is DONE in the database's own
    /// archive and before the state says built (in a batch the listing that follows the backup
    /// waits for the node's one big-job slot behind the other restores, so a rollout often finds
    /// a restore there). The build that is begun again finishes over that backup: no second fetch
    /// into a directory barman refuses, no second backup, no failed operation (found by review,
    /// the restore was refused `prefix_not_empty`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_the_agent_restarted_after_its_first_base_backup_is_finished_over_that_backup()
     {
        let Some(rig) = Rig::new("restore-restart-backup").await else {
            return;
        };
        let (source_json, source_id, source_state) = source(&rig).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = source_json["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        let own_path = restored["archive"]["path"].as_str().unwrap().to_string();
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let entry = rig.entry_for(&restored);
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);
        let first = handle.view().writer.clone().unwrap().pid;
        let own = handle.state().unwrap().backup.unwrap();
        // The agent went away with the first base backup DONE and the state not yet saying built.
        rig.core
            .files(&id)
            .save(&crate::state::DatabaseState::new(entry.storage_generation))
            .unwrap();
        let rig = rig.restart().await;
        rig.deliver(&source_path, "read_only");
        rig.deliver(&own_path, "read_write");
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(120, "the restore, begun again", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);

        // The database of the first run, under a postmaster of the second, and its first backup.
        let data = tenant(&rig, &id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 4000);
        assert_ne!(handle.view().writer.clone().unwrap().pid, first);
        let state = handle.state().unwrap();
        assert!(state.built && state.record.is_none());
        let kept = state.backup.unwrap();
        assert_eq!(
            (kept.backup_id.as_str(), kept.timeline),
            (own.backup_id.as_str(), 2)
        );
        let backups = std::fs::read_dir(rig.fixture.store_directory().join(format!(
            "objects/{}/database/base",
            own_path.strip_prefix("s3://").unwrap()
        )))
        .unwrap()
        .count();
        assert_eq!(backups, 1, "no second base backup");
        assert_eq!(rig.observation(&id)["state"], "ready");
    }

    /// The first pull of an agent that has just started reads the archive credentials and resumes
    /// every create and restore the last agent left, and a credential whose read failed once is
    /// read again by the next pull (found live: `credential_not_delivered` on the first attempt
    /// after a deploy). A build that never began for want of it says nothing and is begun by the
    /// pull that brings the credential, and not failed for good by the one that did not.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_build_without_its_archive_credential_says_nothing_and_begins_when_it_arrives() {
        let Some(rig) = Rig::new("credential-late").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the create", || handle.phase() == Phase::Ready).await;
        // The agent restarts while the create is not built: a state file that says so, a cluster
        // on the volume, and no credential yet.
        rig.machine.stop(&id).await.unwrap();
        rig.core
            .files(&id)
            .save(&crate::state::DatabaseState::new(1))
            .unwrap();
        let rig = rig.restart().await;
        let handle = rig.core.db(&id);
        let starts = || {
            rig.machine
                .calls()
                .iter()
                .filter(|call| **call == format!("start {id}"))
                .count()
        };
        let before = starts();
        for _ in 0..3 {
            rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
            eventually(30, "the decision", || {
                let view = handle.view();
                view.adopted && view.reconcile == crate::agent::Reconcile::Idle
            })
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // Nothing is reported and nothing is begun or abandoned.
            assert_eq!(rig.core.pending_observation(&id), None);
            assert_ne!(handle.phase(), Phase::Error);
            assert_eq!(handle.view().abandoned_build, None);
            assert_eq!(starts(), before);
        }
        // The pull that brings the credential begins it.
        rig.deliver(&path, "read_write");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the create", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Ready, "{:?}", handle.view().error);
        assert_eq!(rig.observation(&id)["state"], "ready");
    }

    /// A credential that does not come is not waited for for ever: a restore whose source's
    /// credential is missing fails with `archive_unusable` at the first pull after the wait, as it
    /// did at the first, and is abandoned.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_build_whose_credential_never_arrives_fails_after_the_wait() {
        let timing = crate::agent::Timing {
            credential_wait: std::time::Duration::from_millis(600),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("credential-never", timing).await else {
            return;
        };
        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": "zyxwvutsrqponmlkjihg",
            "path": "s3://pgcf-eu/eu-dev/zyxwvutsrqponmlkjihg/g1-op_bbbbbbbbbbbbbbbbbbbb",
            "backup_id": "20261017T225342",
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let handle = rig.core.db(&id);
        let page = || Rig::page(vec![restored.clone()], vec![]);
        rig.core.apply(&page()).await;
        eventually(30, "the decision", || {
            let view = handle.view();
            view.adopted && view.reconcile == crate::agent::Reconcile::Idle
        })
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(rig.core.pending_observation(&id), None);
        assert_ne!(handle.phase(), Phase::Error);
        // The pull after the wait gives up.
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        rig.core.apply(&page()).await;
        eventually(30, "the build to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("archive_unusable"));
        assert_eq!(rig.observation(&id)["error"], "archive_unusable");
        assert!(rig.machine.volumes().is_empty());
        assert!(!rig.machine.has_account(&id));
    }

    /// A create that failed after its unit was up (the first base backup): the unit is stopped and
    /// the volume goes, and the pulls that still list the create do not begin it again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_create_that_failed_is_abandoned_and_not_begun_again() {
        let Some(rig) = Rig::new("create-failed").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.fixture.set("backup-fail", "");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the create to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("build_failed"));
        rig.fixture.clear("backup-fail");
        pulled_again_stays_failed(&rig, &id, &db, "build_failed").await;
    }

    /// The agent restarts after a create failed. The page the API sends now keeps the database and
    /// names no origin (it stopped asking for a create whose operation failed): the agent has
    /// nothing of it, reports `volume_missing` and starts nothing. Found by review: the page named
    /// the create until the database was ready, and every restart (every rollout of the fleet
    /// restarts the agent) built the failed create again, to a ready under the failed operation.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_create_that_failed_is_not_built_by_the_agent_that_restarted() {
        let Some(rig) = Rig::new("create-failed-restart").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.fixture.set("backup-fail", "");
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the create to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("build_failed"));
        rig.fixture.clear("backup-fail");

        let rig = rig.restart().await;
        let starts = || {
            rig.machine
                .calls()
                .iter()
                .filter(|call| **call == format!("start {id}"))
                .count()
        };
        let before = starts();
        let mut kept = db.clone();
        kept.as_object_mut().unwrap().remove("origin");
        rig.deliver(db["archive"]["path"].as_str().unwrap(), "read_write");
        rig.core.apply(&Rig::page(vec![kept], vec![])).await;
        let handle = rig.core.db(&id);
        eventually(30, "the decision", || handle.view().adopted).await;
        for _ in 0..15 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            assert_eq!(handle.phase(), Phase::Error);
        }
        assert_eq!(handle.view().error, Some("volume_missing"));
        assert_eq!(starts(), before, "nothing is started");
        let observation = rig.observation(&id);
        assert_eq!(
            (&observation["state"], &observation["error"]),
            (&json!("error"), &json!("volume_missing"))
        );
        assert!(!rig.machine.running(&id));
        assert!(rig.machine.volumes().is_empty());
    }

    /// A source that was resized up after its backup and down again before the restore has a
    /// parameter change in its WAL above both the backup's settings and the class's. PostgreSQL
    /// pauses that recovery ("recovery has paused") and its postmaster still reports ready, so
    /// the restore's start returns: the restore must see the pause and fail, with the database
    /// abandoned, instead of waiting for a promotion that never comes.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restore_that_postgresql_pauses_fails_instead_of_waiting_without_end() {
        let Some(rig) = Rig::new("restore-paused").await else {
            return;
        };
        let (mut db, source_id, source_state) = source(&rig).await;
        let backup = source_state.backup.clone().unwrap();
        let source_path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&source_path, "read_only");

        // The source runs with 200 connections for a while, and with 25 again: its WAL records
        // both changes, and the backup holds the first 25.
        let source_handle = rig.core.db(&source_id);
        for (generation, memory_mib, max_connections) in [(6, 1024, 200), (8, 256, 25)] {
            next(&mut db, generation);
            db["resources"]["memory_mib"] = json!(memory_mib);
            db["settings"]["max_connections"] = json!(max_connections);
            rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
            // A sleeping database holds no slot: the page's size is kept in its state, and the
            // slot the wake binds takes the limits of that size.
            eventually(30, "the new size to be kept", || {
                source_handle
                    .state()
                    .as_ref()
                    .and_then(|state| state.resources.clone())
                    .is_some_and(|resources| resources.memory_mib == memory_mib)
            })
            .await;
            let mut ticket = Rig::ticket(&rig.entry_for(&db));
            ticket.operation = format!("op_{:0>20}", format!("w{generation}"));
            let woken = rig.core.wake(&ticket).await;
            assert_eq!(woken.outcome, Outcome::Started, "{:?}", woken.reason);
            assert_eq!(
                rig.machine
                    .limits(&source_id)
                    .map(|limits| limits.memory_mib),
                Some(memory_mib),
                "the slot has the limits of the new size"
            );
            assert_eq!(
                rig.core.sleep(&source_handle, Why::Idle).await,
                Slept::Proven
            );
        }

        // The restore is of the class the source began in.
        let mut restored = rig.entry_json();
        let id = id_of(&restored);
        restored["resources"]["memory_mib"] = json!(256);
        restored["settings"]["max_connections"] = json!(25);
        restored["origin"] = json!({"kind": "restore", "source": {
            "database_id": source_id, "path": source_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"}}});
        let handle = rig.core.db(&id);
        rig.core
            .apply(&Rig::page(vec![restored.clone()], vec![]))
            .await;
        eventually(60, "the paused restore to fail", || {
            matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(handle.phase(), Phase::Error);
        assert_eq!(handle.view().error, Some("no_recovery_point"));
        // Abandoned: the unit is stopped, and the volume is gone.
        assert!(!rig.machine.running(&id));
        assert!(
            rig.machine
                .volumes()
                .iter()
                .all(|(volume, _)| volume.database() != id)
        );
        // And it stays so: the node rebuilt this restore 11 times in 5 minutes, one on each pull
        // that still listed it (found live, 2026-10-23).
        pulled_again_stays_failed(&rig, &id, &restored, "no_recovery_point").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_order_that_runs_is_not_run_again_by_the_pulls_that_still_list_it() {
        use pgcf_native_protocol::agent::{ControlAction, ToGateway};
        let timing = crate::agent::Timing {
            archive_wait: std::time::Duration::from_secs(2),
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("order-once", timing).await else {
            return;
        };
        let gateway = rig.connect_gateway().await;
        let mut db = rig.entry_json();
        let id = id_of(&db);
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "ready", || handle.phase() == Phase::Ready).await;
        db.as_object_mut().unwrap().remove("origin");

        // R2 fails: the source's sleep waits for its archive, and two pulls list the move
        // meanwhile.
        rig.fixture.set("fail", "");
        let operation = "op_vvvvvvvvvvvvvvvvvvvv";
        let page = Rig::page(
            vec![db.clone()],
            vec![Order::Move {
                operation: operation.into(),
                database: id.clone(),
                storage_generation: 1,
            }],
        );
        rig.core.apply(&page).await;
        rig.core.apply(&page).await;
        eventually(30, "the move to end", || {
            rig.core.pending_order(operation).is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order(operation).unwrap()["reason"],
            "power_archive"
        );
        // The move ran once: one sleep began, and its result stands.
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        let begun = gateway
            .received()
            .iter()
            .filter(|message| {
                matches!(message, ToGateway::Control { action: ControlAction::Begin, database, .. } if database == &id)
            })
            .count();
        assert_eq!(begun, 1);
        assert_eq!(
            rig.core.pending_order(operation).unwrap()["reason"],
            "power_archive"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_move_that_fails_on_the_sources_node_keeps_the_sources_user_and_volume() {
        let Some(rig) = Rig::new("move-fail").await else {
            return;
        };
        let (mut db, id, source_state) = source(&rig).await;
        let old_path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&old_path, "read_only");
        let new_path = format!("s3://pgcf-eu/eu-dev/{id}/g2-op_hhhhhhhhhhhhhhhhhhhh");
        rig.deliver(&new_path, "read_write");

        // The move names a backup the source's archive does not hold: the target is abandoned.
        db["storage_generation"] = json!(2);
        db["generation"] = json!(7);
        db["operation"] = json!("op_hhhhhhhhhhhhhhhhhhhh");
        db["archive"]["path"] = json!(new_path);
        db["origin"] = json!({"kind": "move", "source": {
            "database_id": id, "path": old_path, "backup_id": "20200101T000000",
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"},
            "end": source_state.record.clone().unwrap()}});
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the move to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("archive_unusable"));
        // The source's volume stays, and so does the user whose uid owns its files: a uid given
        // back would pass them to the next database that is given it.
        assert!(
            rig.machine
                .volumes()
                .iter()
                .any(|(volume, _)| volume.generation() == 1)
        );
        assert!(rig.machine.has_account(&id), "{:?}", rig.machine.calls());
    }

    /// A move target on the node of its source whose build fails before it writes anything of its
    /// own (the credential of its archive has not arrived, so there is no store): the state and the
    /// upload log on the disk are the source's generation's, and stay, with the source's user and
    /// volume. They are what an agent that restarts decides on (adopted asleep from the proof);
    /// the abandoned build must not take them with it. The build fails once the wait for the
    /// credential (`Timing::credential_wait`) is over, here none.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_move_target_that_fails_before_it_begins_leaves_the_state_of_the_source() {
        let timing = crate::agent::Timing {
            credential_wait: std::time::Duration::ZERO,
            ..crate::agent::testing::timing()
        };
        let Some(rig) = Rig::with_timing("move-unbegun", timing).await else {
            return;
        };
        let (mut db, id, source_state) = source(&rig).await;
        let old_path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&old_path, "read_only");
        // The credential of the target's archive path is not delivered.
        let new_path = format!("s3://pgcf-eu/eu-dev/{id}/g2-op_hhhhhhhhhhhhhhhhhhhh");
        db["storage_generation"] = json!(2);
        db["generation"] = json!(7);
        db["operation"] = json!("op_hhhhhhhhhhhhhhhhhhhh");
        db["archive"]["path"] = json!(new_path);
        db["origin"] = json!({"kind": "move", "source": {
            "database_id": id, "path": old_path, "backup_id": source_state.backup.clone().unwrap().backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"},
            "end": source_state.record.clone().unwrap()}});
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db], vec![])).await;
        eventually(60, "the build to fail", || handle.phase() == Phase::Error).await;
        assert_eq!(handle.view().error, Some("archive_unusable"));

        let files = rig.core.files(&id);
        assert_eq!(files.load().unwrap(), Some(source_state.clone()));
        assert!(files.directory().join("uploads-g1.log").exists());
        assert_eq!(handle.state(), Some(source_state));
        assert!(rig.machine.has_account(&id));
        assert!(
            rig.machine
                .volumes()
                .iter()
                .any(|(volume, _)| volume.generation() == 1)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_move_target_replays_the_sources_wal_through_its_proven_sleep_and_keeps_the_id() {
        let Some(rig) = Rig::new("move").await else {
            return;
        };
        let (mut db, id, source_state) = source(&rig).await;
        let record = source_state.record.clone().unwrap();
        let backup = source_state.backup.clone().unwrap();
        let old_path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.deliver(&old_path, "read_only");
        let new_path = format!("s3://pgcf-eu/eu-dev/{id}/g2-op_hhhhhhhhhhhhhhhhhhhh");
        rig.deliver(&new_path, "read_write");

        // The API moves the database to storage generation 2.
        db["storage_generation"] = json!(2);
        db["generation"] = json!(7);
        db["operation"] = json!("op_hhhhhhhhhhhhhhhhhhhh");
        db["archive"]["path"] = json!(new_path);
        db["origin"] = json!({"kind": "move", "source": {
            "database_id": id, "path": old_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"},
            "end": record}});
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(120, "the move", || {
            handle
                .state()
                .as_ref()
                .is_some_and(|s| s.storage_generation == 2)
                && matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(
            handle.phase(),
            Phase::Ready,
            "{:?} {:?}",
            handle.view().error,
            rig.machine.calls()
        );
        let data = tenant(&rig, &id).await;
        let rows = data.query("SELECT count(*) FROM t", &[]).await.unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 4000);
        // The same database name and roles; the new generation has its own backup and archive.
        let state = handle.state().unwrap();
        assert_eq!(state.backup.unwrap().timeline, 2);
        assert_eq!(rig.observation(&id)["storage_generation"], 2);
        assert!(
            rig.machine
                .calls()
                .iter()
                .any(|call| call == &format!("unmount {id}"))
        );
        // The source's volume stays until the order lets it go.
        assert_eq!(rig.machine.volumes().len(), 2);
        let order = Order::Superseded {
            operation: "op_ssssssssssssssssssss".into(),
            database: id.clone(),
            storage_generation: 1,
            remove_volume: true,
        };
        rig.core
            .apply(&Rig::page(vec![db.clone()], vec![order]))
            .await;
        eventually(30, "the old generation to go", || {
            rig.machine.volumes().len() == 1
        })
        .await;
        assert_eq!(rig.machine.volumes()[0].0.generation(), 2);
        assert_eq!(
            handle.phase(),
            Phase::Ready,
            "the generation the page serves is not retired"
        );
    }

    /// The agent restarted while the unit of the source generation runs (the move protocol proves
    /// its sleep first, so this is the defense behind it): the unit has the volume in a namespace
    /// of its own, the agent has no mount of it, and its mount table says the directory is free.
    /// The kernel says it is not: the target generation is not built, the unit and its volume are
    /// left as they are, the record of the generation they serve stays, and the build goes on at
    /// the next pull once the unit has stopped.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_move_target_is_not_built_while_the_unit_of_the_source_runs_after_an_agent_restart() {
        let Some(rig) = Rig::new("move-held").await else {
            return;
        };
        let (mut db, id, source_state) = source(&rig).await;
        let record = source_state.record.clone().unwrap();
        let backup = source_state.backup.clone().unwrap();
        let old_path = db["archive"]["path"].as_str().unwrap().to_string();
        let new_path = format!("s3://pgcf-eu/eu-dev/{id}/g2-op_hhhhhhhhhhhhhhhhhhhh");
        // The unit of the source runs, and the agent that has the volume restarts.
        rig.machine.start(&id).await.unwrap();
        let rig = rig.restart().await;
        assert!(rig.machine.running(&id));
        assert!(
            !rig.machine
                .attached(&crate::storage::VolumeId::new(&id, 1).unwrap())
        );
        rig.deliver(&old_path, "read_only");
        rig.deliver(&new_path, "read_write");

        db["storage_generation"] = json!(2);
        db["generation"] = json!(7);
        db["operation"] = json!("op_hhhhhhhhhhhhhhhhhhhh");
        db["archive"]["path"] = json!(new_path);
        db["origin"] = json!({"kind": "move", "source": {
            "database_id": id, "path": old_path, "backup_id": backup.backup_id,
            "credential": {"id": "crd_rrrrrrrrrrrrrrrrrrrr", "expires_at": "2099-01-01T00:00:00.000Z"},
            "end": record}});
        let handle = rig.core.db(&id);
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the build to be refused", || {
            handle.phase() == Phase::Error
        })
        .await;
        assert_eq!(handle.view().error, Some("build_failed"));
        assert!(rig.machine.running(&id), "the unit is not touched");
        assert_eq!(
            rig.machine
                .volumes()
                .iter()
                .map(|(volume, _)| volume.generation())
                .collect::<Vec<_>>(),
            [1]
        );
        assert_eq!(
            rig.core
                .files(&id)
                .load()
                .unwrap()
                .unwrap()
                .storage_generation,
            1,
            "the record still names the generation that is to be released"
        );

        // The unit sleeps: the next pull releases the old generation and builds the new one.
        rig.machine.stop(&id).await.unwrap();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(120, "the move", || {
            handle
                .state()
                .as_ref()
                .is_some_and(|state| state.storage_generation == 2)
                && matches!(handle.phase(), Phase::Ready | Phase::Error)
        })
        .await;
        assert_eq!(
            handle.phase(),
            Phase::Ready,
            "{:?} {:?}",
            handle.view().error,
            rig.machine.calls()
        );
        assert_eq!(rig.machine.volumes().len(), 2);
    }

    /// A job that holds the volume of a superseded generation keeps the volume: the order ends
    /// `volume_not_removed` (the API sends it again), and one that comes after the job removes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_superseded_volume_that_a_job_holds_is_kept_and_reported_and_goes_with_a_later_order()
    {
        let Some(rig) = Rig::new("superseded-held").await else {
            return;
        };
        let (_, handle) = rig.create().await;
        let id = handle.id.clone();
        assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
        let volume = crate::storage::VolumeId::new(&id, 1).unwrap();
        rig.machine.hold_volume(&volume);
        let order = |operation: &str| Order::Superseded {
            operation: operation.into(),
            database: id.clone(),
            storage_generation: 1,
            remove_volume: true,
        };
        rig.core
            .apply(&Rig::page(vec![], vec![order("op_ssssssssssssssssssss")]))
            .await;
        eventually(30, "the first order", || {
            rig.core.pending_order("op_ssssssssssssssssssss").is_some()
        })
        .await;
        let first = rig.core.pending_order("op_ssssssssssssssssssss").unwrap();
        assert_eq!(first["reason"], "volume_not_removed", "{first}");
        assert_eq!(rig.machine.volumes().len(), 1);

        rig.machine.release_volume(&volume);
        rig.core
            .apply(&Rig::page(vec![], vec![order("op_tttttttttttttttttttt")]))
            .await;
        eventually(30, "the volume to go", || rig.machine.volumes().is_empty()).await;
        eventually(30, "the second order", || {
            rig.core.pending_order("op_tttttttttttttttttttt").is_some()
        })
        .await;
        assert_eq!(
            rig.core.pending_order("op_tttttttttttttttttttt").unwrap()["status"],
            "done"
        );
    }

    /// The page of a database that is deleted.
    fn deletion(db: &Value, generation: u64) -> Value {
        let mut page = db.clone();
        page.as_object_mut().unwrap().remove("origin");
        page["desired_state"] = json!("deleted");
        page["generation"] = json!(generation);
        page["operation"] = json!(format!("op_{:0>20}", format!("d{generation}")));
        page
    }
    /// The node has decided on the database, as it has for any database of the page that is up:
    /// the delete that follows meets a database it knows.
    async fn decided_on(rig: &Rig, db: &Value, handle: &Db) {
        let mut page = db.clone();
        page.as_object_mut().unwrap().remove("origin");
        rig.core.apply(&Rig::page(vec![page], vec![])).await;
        eventually(30, "the node to decide on the database", || {
            handle.view().adopted
        })
        .await;
    }
    /// The events of a database that the node kept for Cloudflare.
    fn events_of(id: &str, name: &str) -> Vec<Value> {
        crate::events::seen()
            .into_iter()
            .filter(|e| e["event"] == name && e["database_id"] == id)
            .collect()
    }

    /// The finding of the live run (US1, 2026-10-23): a delete that left the volume, the user
    /// and a failed slot behind reported the database deleted, logged nothing, and never tried
    /// again, so the volumes stayed (53 GB of the pool) for two databases the API called deleted.
    /// Now nothing is reported until all of it is gone; each failed step is said, and the delete
    /// is decided again until it is done.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_delete_that_leaves_a_volume_or_a_user_is_not_reported_and_goes_on_until_all_is_gone()
    {
        let Some(rig) = Rig::new("delete-left").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let (_, handle) = rig.create_from(&db).await;
        decided_on(&rig, &db, &handle).await;
        // The volume is in use for as long as the test says, and the user cannot be locked once.
        rig.machine.fail_volume_removals(u32::MAX);
        rig.core
            .apply(&Rig::page(vec![deletion(&db, 10)], vec![]))
            .await;
        eventually(30, "the delete to fail on the volume", || {
            events_of(&id, "delete_incomplete").len() >= 2
        })
        .await;
        let failures = events_of(&id, "delete_incomplete");
        assert_eq!(failures[0]["fields"]["step"], "volume");
        assert_eq!(failures[0]["fields"]["class"], "storage_busy");
        // The unit is ended, the volume and the user are there, and nothing says deleted: the
        // observation is the one a database being removed has, none.
        assert!(!rig.machine.running(&id));
        assert_eq!(rig.machine.volumes().len(), 1);
        assert!(rig.machine.has_account(&id));
        assert_ne!(handle.phase(), Phase::Deleted);
        assert!(
            rig.core
                .pending_observation(&id)
                .is_none_or(|observation| observation["state"] != "deleted"),
            "{:?}",
            rig.core.pending_observation(&id)
        );
        assert!(
            rig.machine
                .calls()
                .iter()
                .filter(|call| **call == format!("remove {id}"))
                .count()
                >= 2,
            "the removal is tried again: {:?}",
            rig.machine.calls()
        );
        // The volume lets go; the user cannot be locked once; then it is all gone.
        rig.machine.fail_volume_removals(0);
        rig.machine.fail_account_removals(1);
        eventually(30, "the delete to finish", || {
            handle.phase() == Phase::Deleted
        })
        .await;
        assert!(
            events_of(&id, "delete_incomplete")
                .iter()
                .any(|event| event["fields"]["step"] == "account"),
            "{:?}",
            events_of(&id, "delete_incomplete")
        );
        assert!(rig.machine.volumes().is_empty());
        assert!(!rig.machine.has_account(&id));
        assert_eq!(rig.core.files(&id).load().unwrap(), None);
        assert_eq!(rig.observation(&id)["state"], "deleted");
    }

    /// Deletion is authorized by the desired page and the volume's identity. A broken sleep
    /// proof must refuse a wake, but cannot prevent the owner from deleting the database.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_authorized_delete_cleans_up_after_a_restart_with_corrupt_local_state() {
        let Some(rig) = Rig::new("delete-corrupt").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        rig.create_from(&db).await;
        let rig = rig.restart().await;
        std::fs::write(
            rig.core.files(&id).directory().join("state.json"),
            "{not a state",
        )
        .unwrap();
        let deleted = deletion(&db, 2);
        let handle = rig.core.db(&id);
        handle.view().entry = Some(rig.entry_for(&deleted));
        rig.core.reconcile(&handle, &mut None).await;
        assert_eq!(handle.phase(), Phase::Deleted);
        assert!(!rig.machine.running(&id));
        assert!(rig.machine.volumes().is_empty());
        assert!(!rig.machine.has_account(&id));
        assert_eq!(rig.core.files(&id).load().unwrap(), None);
        assert_eq!(rig.observation(&id)["state"], "deleted");
    }

    /// A clean stop that fails (a PANIC at the shutdown checkpoint of a full filesystem, a stop
    /// job that does not end) is followed by the kill, and the volume is removed only once no
    /// process of the unit is left: while PostgreSQL may still run, nothing is taken from under it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_delete_ends_a_unit_that_does_not_stop_by_force_and_removes_nothing_under_a_unit_that_runs()
     {
        let Some(rig) = Rig::new("delete-kill").await else {
            return;
        };
        let db = rig.entry_json();
        let id = id_of(&db);
        let (_, handle) = rig.create_from(&db).await;
        decided_on(&rig, &db, &handle).await;
        assert!(rig.machine.running(&id));
        // The stop fails once, and the kill ends the unit.
        rig.machine.fail_stops(1);
        rig.core
            .apply(&Rig::page(vec![deletion(&db, 10)], vec![]))
            .await;
        eventually(60, "the delete to finish", || {
            handle.phase() == Phase::Deleted
        })
        .await;
        assert!(!rig.machine.running(&id));
        let calls = rig.machine.calls();
        let at = |call: String| calls.iter().position(|c| *c == call);
        assert!(
            at(format!("stop {id}")) < at(format!("kill {id}"))
                && at(format!("kill {id}")) < at(format!("remove {id}")),
            "stop, then kill, then remove: {calls:?}"
        );
        assert_eq!(events_of(&id, "delete_unit_killed").len(), 1);
        assert!(rig.machine.volumes().is_empty());

        // A unit that nothing ends keeps its volume: the delete says which step and goes on.
        let other = rig.entry_json();
        let other_id = id_of(&other);
        let (_, other_handle) = rig.create_from(&other).await;
        decided_on(&rig, &other, &other_handle).await;
        rig.machine.fail_stops(u32::MAX);
        rig.core
            .apply(&Rig::page(vec![deletion(&other, 10)], vec![]))
            .await;
        eventually(30, "the delete to fail on the unit", || {
            events_of(&other_id, "delete_incomplete").len() >= 2
        })
        .await;
        assert_eq!(
            events_of(&other_id, "delete_incomplete")[0]["fields"]["step"],
            "unit"
        );
        assert!(
            !rig.machine.calls().contains(&format!("remove {other_id}")),
            "the volume stays under a unit that may run"
        );
        assert_ne!(other_handle.phase(), Phase::Deleted);
        rig.machine.fail_stops(0);
        eventually(60, "the delete to finish", || {
            other_handle.phase() == Phase::Deleted
        })
        .await;
        assert!(rig.machine.volumes().is_empty());
    }

    /// The two databases of the live run: the API called them deleted, the node had no record
    /// of them any more, and their volumes and users stayed. An agent that starts finds them
    /// from the page, which now names a deleted database while the volume is reported, and
    /// removes them. A volume of a database that exists, or of none the page names, is not
    /// touched.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_removes_the_volume_and_the_user_a_deleted_database_left_and_nothing_else()
     {
        let Some(rig) = Rig::new("delete-leaked").await else {
            return;
        };
        let (leaked, kept) = (rig.entry_json(), rig.entry_json());
        let (leaked_id, kept_id) = (id_of(&leaked), id_of(&kept));
        let (_, leaked_handle) = rig.create_from(&leaked).await;
        let (_, kept_handle) = rig.create_from(&kept).await;
        assert_eq!(
            rig.core.sleep(&leaked_handle, Why::Idle).await,
            Slept::Proven
        );
        assert_eq!(rig.core.sleep(&kept_handle, Why::Idle).await, Slept::Proven);
        // What the live delete left: the volume and the user, and no file of the node's.
        rig.core.files(&leaked_id).remove().unwrap();
        let rig = rig.restart().await;
        for entry in [&leaked, &kept] {
            rig.deliver(entry["archive"]["path"].as_str().unwrap(), "read_write");
        }
        assert_eq!(rig.machine.volumes().len(), 2);
        let mut kept_page = kept.clone();
        kept_page.as_object_mut().unwrap().remove("origin");
        rig.core
            .apply(&Rig::page(
                vec![deletion(&leaked, 10), kept_page.clone()],
                vec![],
            ))
            .await;
        let handle = rig.core.db(&leaked_id);
        eventually(60, "the leaked volume to be removed", || {
            handle.phase() == Phase::Deleted
        })
        .await;
        assert_eq!(
            rig.machine
                .volumes()
                .iter()
                .map(|(volume, _)| volume.database().to_string())
                .collect::<Vec<_>>(),
            vec![kept_id.clone()]
        );
        assert!(!rig.machine.has_account(&leaked_id));
        assert!(rig.machine.has_account(&kept_id));
        assert_eq!(rig.observation(&leaked_id)["state"], "deleted");
        // A page that does not name a database, and one that names it running, remove nothing.
        rig.core.apply(&Rig::page(vec![kept_page], vec![])).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert_eq!(rig.machine.volumes().len(), 1);
    }

    /// The first page is applied before the archive credentials are read (the gateway is served
    /// without them), so a database that runs finds its credential missing when the agent decides
    /// on it. It is registered with the archive socket when the credential arrives, not at its
    /// next change: PostgreSQL's archiver would otherwise sit out its retry interval.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_database_found_running_before_its_credential_arrives_archives_when_it_does() {
        let Some(rig) = Rig::new("late-credential").await else {
            return;
        };
        rig.machine.direct_archive();
        let db = rig.entry_json();
        let id = id_of(&db);
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(90, "ready", || rig.core.db(&id).phase() == Phase::Ready).await;
        let mut db = db;
        db.as_object_mut().unwrap().remove("origin");
        // The agent restarts: the unit runs on, and no credential has been read yet.
        let rig = rig.restart().await;
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(60, "the decision on the unit that runs", || {
            rig.core.db(&id).phase() == Phase::Ready
        })
        .await;
        let entry = rig.entry_for(&db);
        let upload_log = rig.core.files(&id).upload_log(entry.storage_generation);
        assert!(
            rig.core.store(&path, Access::ReadWrite).is_none(),
            "no credential has arrived"
        );
        rig.deliver(&path, "read_write");
        let store = rig.core.store(&path, Access::ReadWrite).unwrap();
        eventually(5, "the archive socket to know the database", || {
            rig.table.archives(&id, &store, &upload_log)
        })
        .await;
    }

    /// The first page is applied before the credentials are read, so a database that is built
    /// finds its credential missing: the build waits and reports nothing, and begins when the
    /// credential arrives (`Core::deliver`), not at the next pull. One whose credential never
    /// comes fails with `archive_unusable` at the first pull after the wait.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_build_begins_when_its_credential_arrives_and_fails_when_it_never_does() {
        let Some(rig) = Rig::with_timing(
            "build-waits",
            Timing {
                credential_wait: Duration::from_secs(3),
                ..timing()
            },
        )
        .await
        else {
            return;
        };
        let (waits, gives_up) = (new_entry_json(), new_entry_json());
        let (waiting, giving_up) = (id_of(&waits), id_of(&gives_up));
        let page = || Rig::page(vec![waits.clone(), gives_up.clone()], vec![]);
        rig.core.apply(&page()).await;
        tokio::time::sleep(Duration::from_millis(600)).await;
        for id in [&waiting, &giving_up] {
            assert_ne!(rig.core.db(id).phase(), Phase::Error, "the build waits");
            assert_ne!(rig.core.db(id).phase(), Phase::Ready);
        }
        // No pull follows: the arrival of the credential begins the build.
        rig.deliver(waits["archive"]["path"].as_str().unwrap(), "read_write");
        eventually(90, "the build that was waiting", || {
            rig.core.db(&waiting).phase() == Phase::Ready
        })
        .await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_ne!(rig.core.db(&giving_up).phase(), Phase::Ready);
        rig.core.apply(&page()).await;
        eventually(10, "the build that was not given a credential", || {
            rig.core.db(&giving_up).phase() == Phase::Error
        })
        .await;
        assert_eq!(
            rig.core.db(&giving_up).view().error,
            Some("archive_unusable")
        );
    }

    /// A restore writes the generation it builds, and a move's target is the next generation of a
    /// database whose source generation is still in the way: the jobs of a generation mount the
    /// device of that generation, whichever generation the database's link names. No node, no
    /// PostgreSQL: a plain test.
    #[test]
    fn the_jobs_of_a_generation_mount_the_device_of_that_generation() {
        let layout = crate::layout::Layout::default();
        let id = "a1b2c3d4e5f6g7h8i9j0";
        for generation in [1, 7] {
            let volume = crate::storage::VolumeId::new(id, generation).unwrap();
            let device = format!("/dev/mapper/pgcf-db_{id}_g{generation}");
            let database = crate::agent::job_database(&layout, &device, &volume, "pgcf-user");
            assert_eq!(database.device, std::path::PathBuf::from(&device));
            // One directory for every generation: the job mounts the device at the database's path.
            assert_eq!(database.volume, layout.volume(id));
            assert_eq!(database.id, id);
            assert_eq!(database.user, "pgcf-user");
            assert_eq!(database.socket_directory, layout.socket_directory(id));
        }
    }
}
