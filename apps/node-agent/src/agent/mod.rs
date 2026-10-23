// SPDX-License-Identifier: Apache-2.0
//! The node agent's core (plan 5.6 jobs 5, 7, 8): what happens to the databases of the node. It
//! takes the desired page, the orders and the wakes of the gateway in, and puts out the state of
//! its databases for the gateway, the observations and events for Cloudflare, and the sleep and
//! wake of PostgreSQL itself.
//!
//! One database has one flow at a time (`Db::lock`): a create, a wake, a sleep, a recovery or a
//! delete finishes before the next begins. What the others read, the gateway's table and the
//! observation, is the database's `View`, which every flow updates in small steps and never
//! across an `await`. Every start of PostgreSQL goes through `Admission`.
mod apply;
mod build;
pub mod check;
mod entry;
mod metering;
mod power;
mod readahead;
#[cfg(test)]
mod real_gateway;
pub(crate) mod report;
#[cfg(test)]
pub(crate) mod testing;

pub use entry::{Desired, Entry, Origin, Policy, Source};
pub use readahead::{PREFETCH, Prefetch, Start};

use crate::{
    admission::{Admission, Admitter, Facts, Permit, Running},
    archive::{
        job::{Database as JobDatabase, Jobs, Store},
        server::Table,
    },
    credentials::{Access, Credentials},
    fence::Fences,
    gateway::Feed,
    layout::Layout,
    machine::Machine,
    state::{DatabaseState, Files},
    storage::VolumeId,
    usage::Meter,
};
use pgcf_native_protocol::agent as protocol;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, atomic::AtomicBool},
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore},
    task::AbortHandle,
};

/// How many databases the node decides on at once when it starts (`Core::apply` of the first
/// page): each decision reads LVM, systemd and the disk, and mounts the database's volume.
pub(crate) const FIRST_PASS_AT_ONCE: usize = 16;

/// The waits and bounds of the agent. The defaults are the product's; tests shorten them.
#[derive(Clone, Debug)]
pub struct Timing {
    /// How long the archive may take to hold the segment a sleep closed (plan 7.9 step 5).
    pub archive_wait: Duration,
    /// How long a wake waits for PostgreSQL to accept connections before it is refused with
    /// `start_timeout`: under the gateway's 25 s bound. The start goes on.
    pub wake_start: Duration,
    /// How often the agent asks the gateway whether an awake database is idle.
    pub idle_poll: Duration,
    /// How often it reads the units to find those that ended without being asked.
    pub watch: Duration,
    /// The wait before the first retry of a recovery, of a decision on a database that could not
    /// read its facts, or of the wake of a resume order that the node could not decide yet, and
    /// the longest wait.
    pub recovery_retry: Duration,
    pub recovery_retry_maximum: Duration,
    /// How long a wake waits for the node's decision on a database it has not looked at in this
    /// run, before it is refused with `wake_in_progress` and the gateway delivers it again (after
    /// `REDELIVER_MS`, 3 s): shorter, so that a wait never overlaps its own redelivery.
    pub adopt_wait: Duration,
    /// The wait before the first repeat of the boot report that Cloudflare could not take, and the
    /// longest wait.
    pub report_retry: Duration,
    pub report_retry_maximum: Duration,
    /// The wait before the first repeat of what a release's host files left for systemd (a reload,
    /// a run of a tool, a restart) after it failed, and the longest wait.
    pub host_files_retry: Duration,
    pub host_files_retry_maximum: Duration,
    /// How long a starting agent waits for its decisions on the databases that run, of the first
    /// page, before it serves the gateway, whose sessions end on a database the table does not
    /// show running. The databases that sleep are not waited for (`Core::settled`).
    pub settle: Duration,
    /// How long after a wake's release its `wake_detail` is read: past the login and the first
    /// statements. The CPU quota comes with the wake's release at a `cpu_boost_ms` of 0 and after
    /// that time otherwise, so with the default boost of 5 s the event is read inside the burst and
    /// counts no throttling, and at 0 it counts the quota's.
    pub detail: Duration,
    /// How often the agent keeps PostgreSQL's program in the page cache (`readahead`): a pass
    /// that finds nothing lost counts the pages of 37 MB and reads nothing, and the pages the
    /// kernel drops under memory pressure are read back within this time.
    pub program_every: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            archive_wait: Duration::from_secs(600),
            wake_start: Duration::from_secs(20),
            idle_poll: Duration::from_secs(5),
            watch: Duration::from_secs(1),
            recovery_retry: Duration::from_secs(1),
            recovery_retry_maximum: Duration::from_secs(30),
            adopt_wait: Duration::from_secs(2),
            report_retry: Duration::from_secs(2),
            report_retry_maximum: Duration::from_secs(60),
            host_files_retry: Duration::from_secs(5),
            host_files_retry_maximum: Duration::from_secs(300),
            settle: Duration::from_secs(10),
            detail: Duration::from_secs(2),
            program_every: Duration::from_secs(60),
        }
    }
}

/// What the core is made of: the machine and the node's long-lived pieces.
pub struct Parts<M: Machine> {
    pub machine: Arc<M>,
    pub jobs: Arc<Jobs>,
    pub table: Arc<Table>,
    pub credentials: Arc<Credentials>,
    pub gateway: Arc<Feed>,
    pub fences: Fences,
    /// The policy of the first page.
    pub policy: Policy,
    pub timing: Timing,
    /// What the agent reads ahead for a wake: the variant of the build (`PREFETCH`).
    pub prefetch: Prefetch,
}

/// Where a database stands on the node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Phase {
    /// A create, restore or move runs.
    Building,
    /// Stopped with a proven sleep that its volume matches.
    Asleep,
    /// A wake or a recovery starts the unit.
    Starting,
    /// PostgreSQL runs and is released to the gateway.
    Ready,
    /// A sleep is being proven: nothing new is admitted.
    Quiesce,
    /// Stopped without a proof; recovery is pending or running (plan 7.10).
    Unproven,
    /// See `View::error`.
    Error,
    /// The volume is gone.
    Deleted,
    /// A superseded generation or a fenced node: never started again.
    Retired,
}

/// A wake the node released before the page names it (`observationVerdict`): the actor's claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Claim {
    pub generation: u64,
    pub operation: String,
}

/// What the gateway's table and the observation are made from.
#[derive(Clone, Debug)]
pub(crate) struct View {
    /// The newest entry of the page the node accepted.
    pub entry: Option<Entry>,
    pub phase: Phase,
    pub writer: Option<protocol::Writer>,
    /// The error of `Phase::Error` (`NODE_DATABASE_ERRORS`).
    pub error: Option<&'static str>,
    /// A sleep the page asked for was refused (`power_busy`, `power_archive`).
    pub refusal: Option<&'static str>,
    pub claim: Option<Claim>,
    /// The operation of the open move order, which holds the wakes.
    pub moving: Option<String>,
    /// What `state.json` says.
    pub state: Option<DatabaseState>,
    /// The roles the API deleted: gone, and refused.
    pub roles_removed: Vec<String>,
    pub roles_blocked: Vec<String>,
    /// A recovery runs or waits for its retry.
    pub recovering: bool,
    /// Since when the unit runs: the usage meter's, and the first minute after which a due base
    /// backup on the node may start (`Core::newest_ready_ms`).
    pub awake_since_ms: Option<i64>,
    /// When the last base backup that was due failed (`backup_if_due`).
    pub backup_failed_ms: Option<i64>,
    /// When the base backup that is due was first put off for a wake in this awake session
    /// (`backup_if_due`): the start of the longest wait it may have. A sleep forgets it.
    pub backup_put_off_ms: Option<i64>,
    /// The node has decided on this database in this run.
    pub adopted: bool,
    /// A task runs the decision again, with growing waits, until the node has made it
    /// (`retry_until_adopted`).
    pub retrying: bool,
    /// The decision waits for its turn among the first (`Core::schedule_page`).
    pub queued: bool,
    /// The reconciliation of the entry: one runs, and runs again when the entry changed meanwhile.
    pub reconcile: Reconcile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reconcile {
    Idle,
    Running,
    /// The entry changed while a reconciliation ran.
    Again,
}
impl View {
    fn new() -> Self {
        Self {
            entry: None,
            phase: Phase::Asleep,
            writer: None,
            error: None,
            refusal: None,
            claim: None,
            moving: None,
            state: None,
            roles_removed: Vec::new(),
            roles_blocked: Vec::new(),
            recovering: false,
            awake_since_ms: None,
            backup_failed_ms: None,
            backup_put_off_ms: None,
            adopted: false,
            retrying: false,
            queued: false,
            reconcile: Reconcile::Idle,
        }
    }
}

pub(crate) struct Db {
    pub id: String,
    /// One flow of the database at a time.
    pub lock: tokio::sync::Mutex<()>,
    view: Mutex<View>,
    boost: Mutex<Boost>,
}

/// The CPU burst of a database's last wake (`Core::after_wake`), which ends when its quota is
/// applied.
#[derive(Default)]
struct Boost {
    /// The task of the wake that applies the quota once the window is over: one at a time, and
    /// gone when the database leaves service.
    timer: Option<AbortHandle>,
    /// Whether the quota is still to come. Whoever applies it takes this first, under the
    /// database's flow, so that it is applied once whichever of them is first.
    pending: bool,
}
impl Db {
    /// The view, locked: never held across an `await`, and never while taking it again (the lock is
    /// not reentrant, so two guards in one expression are a deadlock).
    pub fn view(&self) -> MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(PoisonError::into_inner)
    }
    pub fn phase(&self) -> Phase {
        self.view().phase
    }
    #[cfg(test)]
    pub fn state(&self) -> Option<DatabaseState> {
        self.view().state.clone()
    }
    /// A wake's burst begins: the task that ends it is kept, and the task of an earlier wake, if
    /// one is left, ends.
    pub fn begin_boost(&self, timer: AbortHandle) {
        let earlier = {
            let mut boost = self.boost.lock().unwrap_or_else(PoisonError::into_inner);
            boost.pending = true;
            boost.timer.replace(timer)
        };
        if let Some(earlier) = earlier {
            earlier.abort();
        }
    }
    /// The burst is over: its quota is to be applied now, once. `false` when something else
    /// applied it, or the database left service. Called under the database's flow.
    pub fn claim_boost(&self) -> bool {
        let mut boost = self.boost.lock().unwrap_or_else(PoisonError::into_inner);
        std::mem::take(&mut boost.pending)
    }
    /// The burst ends before its window does: the task that waits is gone. `true` when the quota
    /// was still to come, which the caller that holds the database's flow applies (a stopped unit
    /// has none: a stop lifts it, and a quota set on a stopped unit would throttle its next start).
    pub fn end_boost(&self) -> bool {
        let (timer, pending) = {
            let mut boost = self.boost.lock().unwrap_or_else(PoisonError::into_inner);
            (boost.timer.take(), std::mem::take(&mut boost.pending))
        };
        if let Some(timer) = timer {
            timer.abort();
        }
        pending
    }
    /// Whether the quota of a wake is still to come.
    #[cfg(test)]
    pub fn boosting(&self) -> bool {
        self.boost
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pending
    }
}

/// The database as the barman jobs know it: its user, its directory (one for every generation),
/// the device `device` of the storage generation `volume` that the job reads or writes (a restore
/// writes the one it builds, whichever the database's link names), and its socket directory.
pub(crate) fn job_database(
    layout: &Layout,
    device: &str,
    volume: &VolumeId,
    user: &str,
) -> JobDatabase {
    let id = volume.database();
    JobDatabase {
        id: id.to_string(),
        user: user.to_string(),
        volume: layout.volume(id),
        device: device.into(),
        socket_directory: layout.socket_directory(id),
    }
}

pub struct Core<M: Machine> {
    pub(crate) machine: Arc<M>,
    pub(crate) admission: Admission,
    pub(crate) table: Arc<Table>,
    pub(crate) jobs: Arc<Jobs>,
    pub(crate) credentials: Arc<Credentials>,
    pub(crate) gateway: Arc<Feed>,
    pub(crate) fences: Fences,
    pub(crate) timing: Timing,
    pub(crate) prefetch: Prefetch,
    /// What the readings remember: the program found, the passes, the starts counted for the A/B.
    pub(crate) readahead: readahead::Readahead,
    pub(crate) policy: Arc<RwLock<Policy>>,
    /// A maintenance order is open: new wakes are held with 57P03 (plan 9.3).
    pub(crate) maintenance: AtomicBool,
    /// The orders the node took up: each runs once, however often the page lists it.
    taken: Mutex<std::collections::HashSet<String>>,
    /// The R2 endpoint each archive path was delivered with.
    endpoints: Mutex<HashMap<String, String>>,
    dbs: Mutex<HashMap<String, Arc<Db>>>,
    /// The databases whose unit was awake when the agent started: the gateway's first table must
    /// show them running (`settled`).
    awake_at_start: HashSet<String>,
    /// The permits of the starts that were in flight when the agent began, by database: a start
    /// ends with the decision on its database (`Core::end_resumed`), which reads the database's
    /// files through the agent's own mount of its volume, and the agent mounts that when it
    /// decides.
    resumed: Mutex<HashMap<String, Permit>>,
    /// The turns of the first decisions on the page's databases (`schedule_page`).
    first_pass: Arc<Semaphore>,
    reports: Mutex<report::Reports>,
    /// What each database used (`usage.rs`).
    meter: Meter,
    /// Something in `reports` changed.
    pub(crate) changed: Notify,
    /// A start took a slot or ended: the pool may want another idle one (`refill_pass`).
    pub(crate) refill: Notify,
    /// The maintenance orders whose databases all sleep with their proofs: the packages and the
    /// check follow, which the service does, since it reaches the files.
    slept: Mutex<Vec<String>>,
    pub(crate) slept_signal: Notify,
}

impl<M: Machine> Core<M> {
    /// The core of a node whose units are `running`, as the units say at the agent's start.
    /// The second value delivers the databases to put to sleep early.
    pub fn new(
        parts: Parts<M>,
        running: impl IntoIterator<Item = Running>,
    ) -> (
        Arc<Self>,
        tokio::sync::mpsc::UnboundedReceiver<crate::admission::EarlySleep>,
    ) {
        let layout = parts.machine.layout().clone();
        let policy = Arc::new(RwLock::new(parts.policy.clone()));
        let running: Vec<Running> = running.into_iter().collect();
        let awake_at_start = running.iter().map(|r| r.database.clone()).collect();
        let admitter = Admitter::rebuild(
            parts.policy.admission.clone(),
            running,
            tokio::time::Instant::now(),
        );
        let facts = {
            let (machine, policy) = (parts.machine.clone(), policy.clone());
            move || Facts {
                mem_available_bytes: machine.memory().map_or(0, |memory| memory.available_bytes),
                room: machine
                    .room(
                        &policy
                            .read()
                            .unwrap_or_else(PoisonError::into_inner)
                            .storage,
                    )
                    .is_ok(),
            }
        };
        let (admission, early, resumed) = Admission::spawn(admitter, facts);
        let core = Arc::new(Self {
            machine: parts.machine,
            admission,
            table: parts.table,
            jobs: parts.jobs,
            credentials: parts.credentials,
            gateway: parts.gateway,
            fences: parts.fences,
            timing: parts.timing,
            prefetch: parts.prefetch,
            readahead: readahead::Readahead::new(),
            policy,
            maintenance: AtomicBool::new(false),
            taken: Mutex::new(std::collections::HashSet::new()),
            endpoints: Mutex::new(HashMap::new()),
            dbs: Mutex::new(HashMap::new()),
            awake_at_start,
            resumed: Mutex::new(
                resumed
                    .into_iter()
                    .map(|permit| (permit.database().to_string(), permit))
                    .collect(),
            ),
            first_pass: Arc::new(Semaphore::new(FIRST_PASS_AT_ONCE)),
            reports: Mutex::new(report::Reports::default()),
            meter: Meter::load(layout.agent().join("usage.json")),
            changed: Notify::new(),
            refill: Notify::new(),
            slept: Mutex::new(Vec::new()),
            slept_signal: Notify::new(),
        });
        (core, early)
    }

    pub(crate) fn layout(&self) -> &Layout {
        self.machine.layout()
    }
    /// The maintenance orders waiting for their packages and their check.
    pub fn take_slept(&self) -> Vec<String> {
        std::mem::take(&mut *self.slept.lock().unwrap_or_else(PoisonError::into_inner))
    }
    pub(crate) fn policy(&self) -> Policy {
        self.policy
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
    /// New rules from the page: for the decisions to come.
    pub fn set_policy(&self, policy: Policy) {
        self.admission.set_policy(policy.admission.clone());
        *self.policy.write().unwrap_or_else(PoisonError::into_inner) = policy;
    }

    /// The database's slot, made when the node first hears of it.
    pub(crate) fn db(&self, id: &str) -> Arc<Db> {
        self.dbs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(id.to_string())
            .or_insert_with(|| {
                Arc::new(Db {
                    id: id.to_string(),
                    lock: tokio::sync::Mutex::new(()),
                    view: Mutex::new(View::new()),
                    boost: Mutex::new(Boost::default()),
                })
            })
            .clone()
    }
    pub(crate) fn find(&self, id: &str) -> Option<Arc<Db>> {
        self.dbs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
    }
    /// Waits until the node has decided on every database it knows whose unit was awake when the
    /// agent started, for at most `bound`. The table the gateway gets first must show them running
    /// or the gateway ends their sessions; a database that sleeps is right in the table before the
    /// node has looked at it, and a wake for one that it has not looked at has it decided on at once
    /// (`try_wake`).
    pub async fn settled(&self, bound: Duration) {
        let decided = || {
            self.awake_at_start
                .iter()
                .filter_map(|id| self.find(id))
                .all(|db| db.view().adopted)
        };
        Self::wait_for(bound, Duration::from_millis(10), decided).await;
    }
    /// Waits until the node has decided on every database it knows, for at most `bound`.
    pub async fn decided(&self, bound: Duration) {
        let decided = || self.all().iter().all(|db| db.view().adopted);
        Self::wait_for(bound, Duration::from_millis(100), decided).await;
    }
    async fn wait_for(bound: Duration, every: Duration, done: impl Fn() -> bool) {
        let deadline = tokio::time::Instant::now() + bound;
        while !done() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(every).await;
        }
    }
    /// Waits until the node has decided on the database, for at most `bound`; whether it has.
    pub(crate) async fn adopted(&self, db: &Db, bound: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + bound;
        while !db.view().adopted {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        true
    }
    /// Waits until the page's entry of the database is of `generation` or a later one, for at
    /// most `bound`. The entry only moves forward (`accept`), and a pull brings it.
    pub(crate) async fn page_reaches(&self, db: &Db, generation: u64, bound: Duration) {
        let deadline = tokio::time::Instant::now() + bound;
        while db
            .view()
            .entry
            .as_ref()
            .is_none_or(|entry| entry.generation < generation)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    pub(crate) fn all(&self) -> Vec<Arc<Db>> {
        let mut dbs: Vec<_> = self
            .dbs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .cloned()
            .collect();
        dbs.sort_by(|a, b| a.id.cmp(&b.id));
        dbs
    }

    /// When the newest awake database on the node became ready (`View::awake_since_ms`): a wake, a
    /// build, or the adoption of a unit that runs. A database that sleeps has none.
    pub(crate) fn newest_ready_ms(&self) -> Option<i64> {
        self.all()
            .iter()
            .filter_map(|db| db.view().awake_since_ms)
            .max()
    }

    /// The agent's files of a database.
    pub(crate) fn files(&self, id: &str) -> Files {
        Files::new(self.layout().database_files(id))
    }
    /// The database as the barman jobs know it, with the device of the storage generation
    /// `volume` that they mount, which is the generation the job reads or writes.
    pub(crate) fn job_database(&self, volume: &VolumeId, user: &str) -> JobDatabase {
        job_database(self.layout(), &self.machine.device(volume), volume, user)
    }

    /// A credential Cloudflare delivered (`ArchiveCredential`): kept for the jobs and the archive
    /// socket, with the R2 endpoint of its archive path.
    pub fn deliver(&self, credential: &serde_json::Value) -> Result<(), crate::Error> {
        let text = |key: &str| credential[key].as_str().ok_or("credential field missing");
        let access = match text("access")? {
            "read_write" => Access::ReadWrite,
            "read_only" => Access::ReadOnly,
            _ => return Err("credential access unknown".into()),
        };
        let path = text("path")?;
        let store =
            Store::new(path, text("endpoint_url")?, access).ok_or("credential path invalid")?;
        let expires = time::OffsetDateTime::parse(
            text("expires_at")?,
            &time::format_description::well_known::Rfc3339,
        )?
        .unix_timestamp();
        let delivered = crate::credentials::Credential::delivered(
            text("access_key_id")?,
            text("secret_access_key")?,
            text("session_token")?,
            u64::try_from(expires).unwrap_or(0),
        )
        .ok_or("credential cannot travel in an environment file")?;
        self.credentials.hold(store.scope, delivered);
        self.endpoints
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(path.to_string(), text("endpoint_url")?.to_string());
        Ok(())
    }
    /// The store of an archive path the node holds a credential for; `None` before it was delivered.
    pub(crate) fn store(&self, path: &str, access: Access) -> Option<Store> {
        let endpoint = self
            .endpoints
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(path)
            .cloned()?;
        Store::new(path, &endpoint, access)
    }
}

/// The gateway's entry for a database: where its PostgreSQL stands for the clients.
fn table_entry(id: &str, view: &View) -> Option<protocol::Database> {
    let entry = view.entry.as_ref()?;
    let (generation, operation) = match &view.claim {
        Some(claim) => (claim.generation, claim.operation.clone()),
        None => (entry.generation, entry.operation.clone()),
    };
    let (mode, writer) = match (view.phase, &view.writer) {
        (Phase::Ready, Some(writer)) => (protocol::Mode::Running, Some(writer.clone())),
        (Phase::Quiesce, Some(writer)) => (protocol::Mode::Quiesce, Some(writer.clone())),
        (Phase::Deleted | Phase::Retired, _) => (protocol::Mode::Retired, None),
        _ => (protocol::Mode::Sleeping, None),
    };
    Some(protocol::Database {
        database: id.to_string(),
        generation,
        operation,
        mode,
        route_revision: entry.route_revision,
        writer,
    })
}

impl<M: Machine> Core<M> {
    /// Changes a database's view. Its entry on the gateway's table and its observation follow.
    pub(crate) fn set(&self, db: &Db, change: impl FnOnce(&mut View)) {
        let (entry, served) = {
            let mut view = db.view();
            let before = metering::is_served(view.phase);
            change(&mut view);
            let after = metering::is_served(view.phase);
            (
                table_entry(&db.id, &view),
                (before != after).then_some(after),
            )
        };
        if let Some(served) = served {
            self.meter.awake(&db.id, served, now_ms());
            if !served {
                db.end_boost();
            }
        }
        match entry {
            Some(entry) => {
                if let Err(error) = self.gateway.set(entry) {
                    crate::timing::emit_event(serde_json::json!({
                        "event": "gateway_entry_refused",
                        "database_id": db.id,
                        "class": crate::diagnostics::error_code(&error),
                    }));
                }
            }
            None => self.gateway.remove(&db.id),
        }
        self.report(db);
    }

    /// Takes in an entry of the desired page. The agent never lowers the generation of a database
    /// it knows: an entry below it is stale and `false`; one at it with another operation wins;
    /// a wake claim the page has caught up with is done.
    pub(crate) fn accept(&self, db: &Db, entry: Entry) -> bool {
        let known = db
            .view()
            .entry
            .as_ref()
            .map(|known| (known.generation, known.operation.clone()));
        if known
            .as_ref()
            .is_some_and(|(generation, _)| entry.generation < *generation)
        {
            return false;
        }
        let changed = known.as_ref() != Some(&(entry.generation, entry.operation.clone()));
        self.set(db, |view| {
            if let Some(claim) = &view.claim
                && (entry.generation > claim.generation
                    || (entry.generation == claim.generation && entry.operation == claim.operation))
            {
                view.claim = None;
            }
            if changed {
                view.refusal = None;
            }
            view.entry = Some(entry);
        });
        true
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
