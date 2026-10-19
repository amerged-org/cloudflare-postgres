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
#[cfg(test)]
mod real_gateway;
mod report;
#[cfg(test)]
pub(crate) mod testing;

pub use entry::{Desired, Entry, Origin, Policy, Source};

use crate::{
    admission::{Admission, Admitter, Facts, Running},
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
    usage::Meter,
};
use pgcf_native_protocol::agent as protocol;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock, atomic::AtomicBool},
    time::Duration,
};
use tokio::sync::Notify;

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
    /// The wait before the first retry of a recovery, and the longest wait.
    pub recovery_retry: Duration,
    pub recovery_retry_maximum: Duration,
    /// The wait before the first repeat of the boot report that Cloudflare could not take, and the
    /// longest wait.
    pub report_retry: Duration,
    pub report_retry_maximum: Duration,
    /// How long a starting agent waits for its decisions on the databases of the first page before
    /// it serves the gateway, whose sessions end on a database the table does not show running.
    pub settle: Duration,
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
            report_retry: Duration::from_secs(2),
            report_retry_maximum: Duration::from_secs(60),
            settle: Duration::from_secs(10),
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
    /// Since when the unit runs, for the usage meter.
    pub awake_since_ms: Option<i64>,
    /// When the last base backup that was due failed (`backup_if_due`).
    pub backup_failed_ms: Option<i64>,
    /// The node has decided on this database in this run.
    pub adopted: bool,
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
            adopted: false,
            reconcile: Reconcile::Idle,
        }
    }
}

pub(crate) struct Db {
    pub id: String,
    /// One flow of the database at a time.
    pub lock: tokio::sync::Mutex<()>,
    view: Mutex<View>,
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
    pub(crate) policy: Arc<RwLock<Policy>>,
    /// A maintenance order is open: new wakes are held with 57P03 (plan 9.3).
    pub(crate) maintenance: AtomicBool,
    /// The orders the node took up: each runs once, however often the page lists it.
    taken: Mutex<std::collections::HashSet<String>>,
    /// The R2 endpoint each archive path was delivered with.
    endpoints: Mutex<HashMap<String, String>>,
    dbs: Mutex<HashMap<String, Arc<Db>>>,
    reports: Mutex<report::Reports>,
    /// What each database used (`usage.rs`).
    meter: Meter,
    /// Something in `reports` changed.
    pub(crate) changed: Notify,
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
        Vec<crate::admission::Permit>,
    ) {
        let layout = parts.machine.layout().clone();
        let policy = Arc::new(RwLock::new(parts.policy.clone()));
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
            policy,
            maintenance: AtomicBool::new(false),
            taken: Mutex::new(std::collections::HashSet::new()),
            endpoints: Mutex::new(HashMap::new()),
            dbs: Mutex::new(HashMap::new()),
            reports: Mutex::new(report::Reports::default()),
            meter: Meter::load(layout.agent().join("usage.json")),
            changed: Notify::new(),
            slept: Mutex::new(Vec::new()),
            slept_signal: Notify::new(),
        });
        (core, early, resumed)
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
    /// Waits until the node has decided on every database it knows, for at most `bound`.
    pub async fn settled(&self, bound: Duration) {
        let deadline = tokio::time::Instant::now() + bound;
        while !self.all().iter().all(|db| db.view().adopted)
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

    /// The agent's files of a database.
    pub(crate) fn files(&self, id: &str) -> Files {
        Files::new(self.layout().database_files(id))
    }
    /// The database as the barman jobs know it.
    pub(crate) fn job_database(&self, id: &str, user: &str) -> JobDatabase {
        JobDatabase {
            id: id.to_string(),
            user: user.to_string(),
            volume: self.layout().volume(id),
            socket_directory: self.layout().socket_directory(id),
        }
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
