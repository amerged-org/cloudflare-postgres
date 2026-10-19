// SPDX-License-Identifier: Apache-2.0
//! The desired page and its orders become action (plan 5.2, 5.6 jobs 5, 7, 8, 9.4, 9.5): for each
//! database the node decides from the entry and from what it finds on its disk and in its units
//! what is to be done, and does it under the database's own flow. Only an explicit order or a
//! desired state stops or removes what runs (plan 3.3, invariant 7): a page that does not name a
//! database never does.
use super::{
    Core, Db, Desired, Entry, Phase, Policy, Reconcile,
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
        for value in &page.databases {
            let Some(entry) = Entry::parse(value) else {
                crate::timing::emit_event(
                    json!({"event": "desired_entry_refused", "database_id": value["id"]}),
                );
                continue;
            };
            let db = self.db(&entry.id);
            if self.accept(&db, entry) {
                self.schedule(&db);
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
                if let Some(operation) = held
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
            loop {
                core.reconcile(&db).await;
                let mut view = db.view();
                if view.reconcile == Reconcile::Again {
                    view.reconcile = Reconcile::Running;
                } else {
                    view.reconcile = Reconcile::Idle;
                    break;
                }
            }
        });
    }

    /// Decides on a database's entry and does what that needs.
    pub(crate) async fn reconcile(self: &Arc<Self>, db: &Arc<Db>) {
        let _flow = db.lock.lock().await;
        let Some(entry) = db.view().entry.clone() else {
            return;
        };
        if db.view().state.is_none() {
            match self.files(&db.id).load() {
                Ok(state) => self.set(db, |view| view.state = state),
                // A state that cannot be trusted is not taken for a new database.
                Err(_) => {
                    self.set(db, |view| {
                        view.adopted = true;
                        view.phase = Phase::Error;
                        view.error = Some("volume_missing");
                    });
                    return;
                }
            }
        }
        // What cannot be read is not known: nothing is decided on a guess, and the next pull
        // decides. A volume taken for missing would fail the database; a unit taken for stopped
        // would put a database that runs through recovery.
        let has_volume = match Self::volume_id(&entry) {
            Some(volume) => match self.machine.has_volume(&volume).await {
                Ok(found) => found,
                Err(_) => return,
            },
            None => false,
        };
        let Ok(unit) = self.machine.unit(&db.id).await else {
            return;
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
            })
        };
        match step {
            Step::Nothing => {}
            Step::Build => {
                self.release_previous_generation(&entry).await;
                let _ = self.build(db, &entry).await;
            }
            Step::Delete => self.delete(db, &entry).await,
            Step::Suspend => {
                self.sleep_locked(db, Why::Order).await;
            }
            Step::AdoptRunning => self.adopt_running(db, &entry).await,
            Step::AdoptAsleep => self.adopt_asleep(db).await,
            Step::Fail(error) => self.set(db, |view| {
                view.phase = Phase::Error;
                view.error = Some(error);
            }),
            Step::Retire => {
                self.retire(db).await;
            }
        }
        self.set(db, |view| view.adopted = true);
        if matches!(db.phase(), Phase::Ready | Phase::Asleep) {
            self.resize(db, &entry).await;
        }
        if db.phase() == Phase::Ready {
            self.sync(db, &entry).await;
        }
    }

    /// The unit runs, as the agent found it at its start: it is released to the gateway as ready,
    /// and its archiver reaches the archive socket again.
    async fn adopt_running(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) {
        self.ensure_archive(db, entry);
        match self.machine.wait_started(&db.id).await {
            Ok(started) => match writer_of(&started) {
                Some(writer) => self.set(db, |view| {
                    view.phase = Phase::Ready;
                    view.writer = Some(writer);
                    view.awake_since_ms = Some(super::now_ms());
                    view.error = None;
                }),
                None => self.go_unproven(db),
            },
            // A unit that cannot be read as ready is not served; recovery takes it.
            Err(_) => self.go_unproven(db),
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
    /// written at the next start.
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
        if held.as_ref() != Some(&current) {
            let mut applied = self.apply_limits(entry).await.is_ok();
            if let (Some(held), Some(volume)) = (&held, Self::volume_id(entry))
                && held.storage_gib < current.storage_gib
                && let Err(error) = self
                    .machine
                    .grow_volume(&volume, entry.volume_bytes())
                    .await
            {
                applied = false;
                crate::timing::emit_event(json!({
                    "event": "resize_refused", "database_id": db.id,
                    "class": crate::diagnostics::error_code(&error.into()),
                }));
            }
            if applied {
                let _ = self.save_state(db, |state| state.resources = Some(current.clone()));
            }
            self.admission.resized(&db.id, entry.memory_mib);
            self.set(db, |_| {});
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
    async fn release_previous_generation(&self, entry: &Entry) {
        let held = self.files(&entry.id).load().ok().flatten();
        let Some(held) = held.filter(|state| state.storage_generation < entry.storage_generation)
        else {
            return;
        };
        if let Ok(previous) = crate::storage::VolumeId::new(&entry.id, held.storage_generation) {
            let _ = self.machine.unmount_volume(&previous).await;
        }
    }

    /// The desired state is `deleted` (plan 5.10): the unit stops, the volume and the user go, and
    /// the node keeps nothing of the database. The R2 archive is the Worker's to expire.
    pub(crate) async fn delete(self: &Arc<Self>, db: &Arc<Db>, entry: &Entry) {
        self.set(db, |view| {
            view.phase = Phase::Retired;
            view.writer = None;
        });
        let _ = self.machine.stop(&db.id).await;
        self.admission.stopped(&db.id);
        if let Some(account) = self.machine.account(&db.id) {
            self.table.remove(account.uid);
        }
        let generation = entry.storage_generation;
        let mut volumes = vec![];
        if let Ok(inventory) = self.machine.inventory().await {
            volumes = inventory
                .volumes
                .into_iter()
                .filter(|volume| {
                    volume.id.database() == db.id && volume.id.generation() <= generation
                })
                .map(|volume| volume.id)
                .collect();
        }
        if volumes.is_empty()
            && let Some(volume) = Self::volume_id(entry)
        {
            volumes.push(volume);
        }
        for volume in volumes {
            let _ = self
                .machine
                .remove_volume(
                    &volume,
                    Removal::DatabaseDeleted {
                        storage_generation: generation,
                    },
                )
                .await;
        }
        let _ = std::fs::remove_dir_all(self.layout().socket_directory(&db.id));
        let _ = self.machine.remove_account(&db.id).await;
        let _ = self.files(&db.id).remove();
        self.set(db, |view| {
            view.phase = Phase::Deleted;
            view.state = None;
            view.error = None;
        });
    }

    /// Stops the unit of a database by its name, out of admission's awake set and off the archive
    /// socket's table; the node needs no record of the database for it. `false` when the unit may
    /// still run.
    async fn stop_unit(&self, database: &str) -> bool {
        let stopped = self.machine.stop(database).await.is_ok();
        self.admission.stopped(database);
        if let Some(account) = self.machine.account(database) {
            self.table.remove(account.uid);
        }
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
        // A node that restarted has no record of a unit that runs on: it serves the generation that
        // is mounted.
        let retired = match entry {
            Some(entry) => Some(entry.storage_generation <= storage_generation),
            None => self.machine.inventory().await.ok().map(|inventory| {
                inventory.volumes.iter().any(|volume| {
                    volume.id.database() == database
                        && volume.mounted()
                        && volume.id.generation() <= storage_generation
                })
            }),
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
        self.report_order(operation, outcome);
    }

    /// `wake` (resume): the database starts through admission as a connection's wake would.
    async fn obey_wake(self: &Arc<Self>, operation: &str, database: &str, generation: u64) {
        let Some(db) = self.find(database) else {
            self.report_order(operation, Err("desired_stale"));
            return;
        };
        let request = {
            let view = db.view();
            let Some(entry) = &view.entry else {
                drop(view);
                self.report_order(operation, Err("desired_stale"));
                return;
            };
            WakeRequest {
                database: database.to_string(),
                operation: operation.to_string(),
                generation,
                route_revision: entry.route_revision,
                role_revision_hash: entry.role_hash(),
                queued_at_ms: u64::try_from(super::now_ms()).unwrap_or(0),
            }
        };
        let result = self.wake(&request).await;
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
        agent::testing::{Rig, eventually},
        link::Order,
        node_link::contract_valid,
        postgres, testpg,
    };
    use pgcf_native_protocol::agent::Mode;
    use serde_json::{Value, json};

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
                refused: true
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
        assert_eq!(rig.observation(&id)["state"], "ready");

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
        let observation = rig.observation(&id);
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
        ticket.generation = 6;
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

        // The page resizes the sleeping database: its unit and its volume take the new size
        // before anything starts it, so that it never runs its new settings in its old limits.
        next(&mut db, 6);
        db["resources"] = json!({"memory_mib": 512, "cpu_millicores": 500, "storage_gib": 2});
        rig.core.apply(&Rig::page(vec![db.clone()], vec![])).await;
        eventually(30, "the limits of the new size", || {
            rig.machine
                .limits(&id)
                .is_some_and(|limits| limits.memory_mib == 512 && limits.cpu_millicores == 500)
        })
        .await;
        assert_eq!(rig.machine.volumes()[0].1, 2 << 30);
        assert_eq!(handle.phase(), Phase::Asleep);
        let result = rig.core.wake(&Rig::ticket(&rig.entry_for(&db))).await;
        assert_eq!(result.outcome, Outcome::Started, "{:?}", result.reason);
        assert_eq!(rig.machine.limits(&id).unwrap().memory_mib, 512);
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
        let mut db = rig.entry_json();
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
    /// A restore writes the generation it builds, and a move's target is the next generation of a
    /// database whose source generation is still in the way: the jobs of a generation mount the
    /// device of that generation, whichever generation the database's link names.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_jobs_of_a_generation_mount_the_device_of_that_generation() {
        let Some(rig) = Rig::new("job-device").await else {
            return;
        };
        let id = id_of(&rig.entry_json());
        let layout = rig.core.layout().clone();
        for generation in [1, 7] {
            let volume = crate::storage::VolumeId::new(&id, generation).unwrap();
            let database = rig.core.job_database(&volume, "pgcf-user");
            assert_eq!(
                database.device,
                std::path::PathBuf::from(format!("/dev/mapper/pgcf-db_{id}_g{generation}"))
            );
            // One directory for every generation: the job mounts the device at the database's path.
            assert_eq!(database.volume, layout.volume(&id));
            assert_eq!(database.id, id);
        }
    }
}
