// SPDX-License-Identifier: Apache-2.0
//! The pool of slots (plan 3.1, 5.5, 5.6, 5.9): the sandboxes PostgreSQL runs in, built before a
//! wake for no database. A slot is the unit `pgcf-slot@<n>.service` with its own user, running
//! the supervisor (`pgcf-archive slot <n>`), which waits for one order from the agent. This
//! module is the agent's whole logic about them; the systemd and kernel calls it needs are the
//! [`Host`], which `system` implements for a node and the tests' machine for a laptop.
//!
//! **One path for every start.** PostgreSQL comes up in a slot, whether it is a wake, a create,
//! a restore, a move target, a recovery or the health check: the caller has its admission permit,
//! and then
//!
//! 1. [`Pool::bind`] takes an idle slot or builds one on the spot (a pool miss, inside the
//!    caller's permit, so `start_concurrency` bounds the builds too), and binds the database to
//!    it: its limits as runtime properties and its two mounts, in parallel. A wake makes no slot
//!    user: a miss takes only a number that has one, and the refill makes the users ahead of it;
//! 2. the caller binds the archive socket's caller to the slot (the pool's table answers it:
//!    [`Pool::holder`]);
//! 3. [`Pool::exec`] sends the one order and waits for PostgreSQL to be ready, by an inotify watch
//!    on `postmaster.pid` and the slot's pidfd, never by a poll.
//!
//! The order is sent only after the properties and the mounts have all succeeded: an idle slot's
//! memory ceiling is below `shared_buffers`, and a PostgreSQL that comes up under it can be killed
//! by the OOM killer. A failure before the order stops the slot and leaves the database asleep
//! with its proof; no PostgreSQL ran.
//!
//! **One writer.** systemd gave a unit name per database; a slot's name says nothing of the
//! database, so the pool enforces it, in layers: the agent's per-database flow lock; the pool's
//! table, which refuses a bind while any slot holds the database in any state (a slot being built
//! for a start holds it from the first moment), whichever generation of its volume it has, until
//! the slot has reached `inactive`, and which looks again in the very step that claims a slot; and,
//! in the kernel, the supervisor's `flock` of the data directory (a lock belongs to one inode, so
//! two generations need the table). The agent also tries the lock before every bind
//! ([`data_lock_free`]). A database's unit of its own (`pgcf-pg@`) never took that lock: it holds
//! the database while it is awake and after it ended with a process left in its cgroup.
//! PostgreSQL's own guard cannot be the only one once two slots with two users see the directory
//! as their own: `miscinit.c` takes `EPERM` of `kill(pid, 0)` on the `postmaster.pid` for a stale
//! file, and `sysv_shmem.c` takes `EACCES` on the old segment for a foreign one.
//!
//! **A restart of the agent loses nothing.** The table is never written to disk. [`Pool::adopt`]
//! reads it back from kernel facts only: the unit list, each unit's main process, its
//! `/proc/<pid>/exe`, its mount table and `/proc/locks`. A mount at a database's directory that
//! cannot be named as a volume of that database counts as held: unknown means tainted.
use super::{ActiveState, Error, Started, UnitState, limits::Property, ready};
use crate::{machine::Account, storage::VolumeId};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    ops::Range,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// The prefix of a slot's unit; the instance is the slot number.
pub const SLOT_PREFIX: &str = "pgcf-slot@";
const SLOT_SUFFIX: &str = ".service";
/// Slot numbers are 0 to this, exclusive (`SLOT_COUNT` of the supervisor).
pub const SLOT_COUNT: u32 = 1024;
/// The first slot's uid and gid. Slot `n` is `SLOT_FIRST_UID + n`.
pub const SLOT_FIRST_UID: u32 = 300_000;
/// The slot of the health check (`pgcf-agent check`). The agent's pool never uses it, so the
/// check never takes a slot of the pool and never adopts one.
pub const CHECK_SLOT: u32 = SLOT_COUNT - 1;
/// The numbers of the agent's pool.
pub const POOL: Range<u32> = 0..CHECK_SLOT;
/// The PostgreSQL major the image carries (the supervisor's `MAJOR`).
pub const MAJOR: u32 = 18;

// The slots' ids stay clear of the databases' (200000-299999), of systemd's dynamic users
// (61184-65519) and of its container range from 524288.
const _: () = {
    assert!(SLOT_FIRST_UID >= super::users::FIRST_UID + super::users::UID_COUNT);
    assert!(SLOT_FIRST_UID + SLOT_COUNT <= 524_288);
};

/// The unit of slot `slot`.
pub fn slot_unit(slot: u32) -> String {
    format!("{SLOT_PREFIX}{slot}{SLOT_SUFFIX}")
}
/// The number of a slot's unit; `None` for any other unit, a number with a leading zero and a
/// number past the last slot.
pub fn slot_of(unit: &str) -> Option<u32> {
    let number = unit.strip_prefix(SLOT_PREFIX)?.strip_suffix(SLOT_SUFFIX)?;
    let slot: u32 = number.parse().ok()?;
    (slot < SLOT_COUNT && slot.to_string() == number).then_some(slot)
}
/// The uid and gid of slot `slot`'s user.
pub fn slot_uid(slot: u32) -> u32 {
    SLOT_FIRST_UID + slot
}
/// The slot a uid belongs to, if it is one of the slots'.
pub fn slot_of_uid(uid: u32) -> Option<u32> {
    uid.checked_sub(SLOT_FIRST_UID)
        .filter(|slot| *slot < SLOT_COUNT)
}
/// The name of slot `slot`'s user and group.
pub fn slot_account(slot: u32) -> String {
    format!("pgcf-slot-{slot}")
}
/// The cgroup of slot `slot`'s unit, as `/proc/<pid>/cgroup` of its processes names it.
pub fn slot_cgroup(slot: u32) -> String {
    format!("/pgcf.slice/{}", slot_unit(slot))
}

/// How long the agent waits for a slot that is stopping, when it starts.
const ADOPT_STOP_BOUND: Duration = Duration::from_secs(60);

/// Where a start's slot came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotFrom {
    /// An idle slot, built before the wake.
    Pool,
    /// A pool miss: built inside the wake.
    Demand,
}
impl SlotFrom {
    /// The word of the wake's detail (`slot_from`).
    pub fn word(self) -> &'static str {
        match self {
            Self::Pool => "pool",
            Self::Demand => "demand",
        }
    }
}

/// What a slot cost a start, in microseconds. `Started::slot` carries it to the wake's phases
/// (`slot`, `bind`, `start`) and its detail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    pub slot: u32,
    pub from: SlotFrom,
    /// Taking an idle slot, or building one.
    pub wait_us: u64,
    /// The limits and the two mounts, in parallel.
    pub bind_us: u64,
    /// The order to execute PostgreSQL, to the supervisor's answer.
    pub order_us: u64,
    /// The answer to ready: PostgreSQL's own start.
    pub start_us: u64,
}

/// What the agent hands a bind.
#[derive(Clone, Debug)]
pub struct Bind {
    /// The storage generation the database runs on: the agent's own mount of it is cloned.
    pub volume: VolumeId,
    /// The database's user on disk.
    pub account: Account,
    /// The device node of the volume, whose number the clone is checked against.
    pub device: PathBuf,
    /// The data directory below the agent's mount, which the agent try-locks before the bind.
    pub data: PathBuf,
    /// The database's size limits, set on the slot as runtime properties.
    pub properties: Vec<Property>,
}

/// A slot that holds a database: its limits are set and its mounts are in, and the order is not
/// sent. The caller binds the archive socket's caller (the pool's own table answers), then calls
/// [`Pool::exec`].
#[derive(Clone, Debug)]
pub struct Bound {
    pub slot: u32,
    pub database: String,
    /// The slot's uid, which PostgreSQL runs as.
    pub uid: u32,
    pub invocation_id: String,
    pub from: SlotFrom,
    /// Taking or building the slot, and the properties and mounts.
    wait: Duration,
    bind: Duration,
}

/// Who holds a slot, for the archive socket: the database whose processes run in it, and the
/// cgroup and invocation they must be in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Holder {
    pub database: String,
    pub cgroup: String,
    pub invocation_id: String,
}

/// Whether a caller of the archive socket is in the holder's slot, from what the kernel says of
/// its process: `cgroup` is the path in its `/proc/<pid>/cgroup`, `invocation` the invocation ID
/// systemd keeps on the unit's cgroup. Both must be the holder's. A cgroup alone would let a
/// process of an earlier incarnation of the unit, if one could remain, speak for the next one.
pub fn is_holder(holder: &Holder, cgroup: Option<&str>, invocation: Option<&str>) -> bool {
    cgroup == Some(holder.cgroup.as_str()) && invocation == Some(holder.invocation_id.as_str())
}

/// What the pool counts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub idle: usize,
    /// Idle slots being built by the refill.
    pub spawning: usize,
    /// Slots that hold a database, from the moment a start takes or builds one to the end of its
    /// stop.
    pub held: usize,
}

/// systemd's account of a slot unit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotUnit {
    pub slot: u32,
    pub active: ActiveState,
    pub main_pid: Option<u32>,
    pub invocation_id: Option<String>,
    pub memory_max_bytes: Option<u64>,
}
impl SlotUnit {
    /// The unit has no process of its own and holds nothing: it is over.
    fn ended(&self) -> bool {
        matches!(self.active, ActiveState::Inactive | ActiveState::Failed)
    }
}

/// The program a slot's process runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exe {
    /// `pgcf-archive slot <n>`: waiting for its order.
    Supervisor,
    /// PostgreSQL.
    Postgres,
    /// Anything else.
    Other,
}

/// What the kernel says of a slot's process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    pub pid: u32,
    pub exe: Exe,
    /// The databases with a mount at their directory in the process's mount namespace, with the
    /// volume it is. `None` is a mount the agent cannot name as a volume of that database: it is
    /// held all the same, and a slot that holds one is never idle (D13: unknown means tainted).
    pub databases: Vec<(String, Option<VolumeId>)>,
    /// `/proc/locks` shows a lock of the process on the data directory of the one database.
    pub locked: bool,
    /// The status in `postmaster.pid` as the process sees it, if it is PostgreSQL's.
    pub postmaster: Option<ready::Status>,
}

/// A slot that was started.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spawned {
    pub main_pid: u32,
    pub invocation_id: String,
    pub requested_us: Option<u64>,
}

/// The supervisor's answer to an order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ordered {
    /// The slot's main process once the order is carried out: the supervisor's own, which
    /// replaced itself with PostgreSQL.
    pub main_pid: u32,
    /// When the agent sent the order (`CLOCK_MONOTONIC`).
    pub sent_us: Option<u64>,
    pub took: Duration,
}

/// What the pool needs of systemd and the kernel. `system::System` is the node's; a test machine
/// stands in for both.
pub trait Host: Send + Sync + 'static {
    /// systemd's account of one slot unit; a unit that is not loaded is inactive.
    fn unit(&self, slot: u32) -> impl Future<Output = Result<SlotUnit, Error>> + Send;
    /// Every loaded slot unit.
    fn units(&self) -> impl Future<Output = Result<Vec<SlotUnit>, Error>> + Send;
    /// The slot numbers that have a user.
    fn users(&self) -> BTreeSet<u32>;
    /// Makes the slot's user and group.
    fn ensure_user(&self, slot: u32) -> impl Future<Output = Result<(), Error>> + Send;
    /// Sets runtime properties on the slot's unit.
    fn set(
        &self,
        slot: u32,
        properties: &[Property],
    ) -> impl Future<Output = Result<(), Error>> + Send;
    /// Starts the unit and waits for its job: the supervisor is idle when this returns.
    fn start(&self, slot: u32) -> impl Future<Output = Result<Spawned, Error>> + Send;
    /// Stops the unit and waits for its job.
    fn stop(&self, slot: u32) -> impl Future<Output = Result<(), Error>> + Send;
    /// Asks the supervisor whether it is idle and speaks this protocol.
    fn ping(&self, slot: u32) -> impl Future<Output = Result<(), Error>> + Send;
    /// Whether the slot's main process still lives (its pidfd is not readable).
    fn alive(&self, slot: u32) -> bool;
    /// The uid the slot's process runs as: the slot user's, which PostgreSQL then runs as.
    fn uid(&self, slot: u32) -> u32;
    /// Moves the database's volume and socket directory into the slot's mount namespace.
    fn mount(&self, slot: u32, bind: &Bind) -> impl Future<Output = Result<(), Error>> + Send;
    /// Sends `exec <database> <major>` and waits for the answer.
    fn order(
        &self,
        slot: u32,
        database: &str,
    ) -> impl Future<Output = Result<Ordered, Error>> + Send;
    /// Waits until `postmaster.pid` of the database says `ready` for `main_pid`, and returns the
    /// socket it names, or until the process ends (`NotReady`).
    fn ready(
        &self,
        slot: u32,
        database: &str,
        main_pid: u32,
    ) -> impl Future<Output = Result<PathBuf, Error>> + Send;
    /// What the kernel says of the slot's process (the unit's first process when `pid` is `None`);
    /// `None` when the unit has none.
    fn facts(&self, slot: u32, pid: Option<u32>) -> Result<Option<Facts>, Error>;
    /// Whether the database's unit of its own (`pgcf-pg@`) holds the database: it is awake, or it
    /// ended with a process of it left in its cgroup. That unit never took the supervisor's lock,
    /// and PostgreSQL's own guard is blind across users and IPC namespaces.
    fn legacy_holds(&self, database: &str) -> impl Future<Output = Result<bool, Error>> + Send;
    /// The fork of the unit's main process and the handoff to the supervisor, in microseconds of
    /// `CLOCK_MONOTONIC`: what systemd-executor spent on the sandbox. `None` where it has none.
    fn timestamps(
        &self,
        slot: u32,
    ) -> impl Future<Output = Result<Option<(u64, u64)>, Error>> + Send;
}

/// Tries the `flock` the supervisor takes on a data directory, and gives it back at once. The
/// agent does this before every bind, and holds it while it writes a sleeping database's
/// configuration (`DataLock`).
pub fn data_lock_free(data: &Path) -> Result<(), Error> {
    DataLock::try_new(data).map(drop)
}

/// The agent's own `flock` of a data directory, held while it writes the files of a database that
/// sleeps. A slot's supervisor takes the same lock before it executes PostgreSQL, and the agent
/// binds none while this is held.
#[derive(Debug)]
pub struct DataLock {
    _file: std::fs::File,
}
impl DataLock {
    /// `Held` when a postmaster (or a supervisor about to execute one) holds the lock.
    pub fn try_new(data: &Path) -> Result<Self, Error> {
        let file = open_directory(data)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(std::fs::TryLockError::WouldBlock) => Err(Error::Held),
            Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
        }
    }
}

fn open_directory(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::File::options()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum State {
    /// Being built: for no database (the refill), or for the one a start is waiting for (a pool
    /// miss), which holds it from the first moment.
    Spawning(Option<String>),
    /// Running the supervisor, with no database.
    Idle,
    /// Chosen for a database: its limits and mounts are going in.
    Taken(String),
    /// The order was acknowledged: PostgreSQL comes up.
    Starting(String),
    /// PostgreSQL is ready and released.
    Serving(String),
    /// The unit is being stopped; the database, if the slot held one, is held until it is over.
    Stopping(Option<String>),
}
impl State {
    fn database(&self) -> Option<&str> {
        match self {
            Self::Taken(database) | Self::Starting(database) | Self::Serving(database) => {
                Some(database)
            }
            Self::Spawning(database) | Self::Stopping(database) => database.as_deref(),
            Self::Idle => None,
        }
    }
}

#[derive(Clone, Debug)]
struct Slot {
    state: State,
    main_pid: Option<u32>,
    invocation_id: Option<String>,
    /// When the agent asked systemd to start the unit.
    requested_us: Option<u64>,
    volume: Option<VolumeId>,
}

#[derive(Default)]
struct Table {
    slots: BTreeMap<u32, Slot>,
    /// The numbers whose user exists. Only the refill makes users.
    users: BTreeSet<u32>,
    /// The numbers whose last build failed. A build takes another number while one is free: a unit
    /// that failed with a process left in its cgroup refuses every start until the process ends,
    /// and a number whose user cannot be made fails the same way every time.
    failed: BTreeSet<u32>,
}
impl Table {
    fn holding(&self, database: &str) -> Vec<u32> {
        self.slots
            .iter()
            .filter(|(_, slot)| slot.state.database() == Some(database))
            .map(|(number, _)| *number)
            .collect()
    }
    /// The number a build takes: the lowest of `range` that is free and has a user, one that
    /// failed last. A number without a user is never taken, since a user is made by the refill
    /// and not by a wake.
    fn free_number(&self, range: &Range<u32>) -> Option<u32> {
        let mut free = range
            .clone()
            .filter(|slot| self.users.contains(slot) && !self.slots.contains_key(slot));
        let first = free.clone().find(|slot| !self.failed.contains(slot));
        first.or_else(|| free.next())
    }
    /// Enters a slot that is being built, for the database a start waits for or for none.
    fn reserve(&mut self, range: &Range<u32>, database: Option<&str>) -> Result<u32, Error> {
        let slot = self.free_number(range).ok_or(Error::NoSlot)?;
        self.slots.insert(
            slot,
            Slot {
                state: State::Spawning(database.map(str::to_string)),
                main_pid: None,
                invocation_id: None,
                requested_us: None,
                volume: None,
            },
        );
        Ok(slot)
    }
}

/// The pool of one range of slot numbers.
pub struct Pool<H: Host> {
    host: H,
    range: Range<u32>,
    table: Mutex<Table>,
}

impl<H: Host> Pool<H> {
    /// A pool of the slot numbers in `range`.
    pub fn new(host: H, range: Range<u32>) -> Self {
        let table = Table {
            users: host.users(),
            ..Table::default()
        };
        Self {
            host,
            range,
            table: Mutex::new(table),
        }
    }
    pub fn host(&self) -> &H {
        &self.host
    }
    /// The slot numbers this pool uses.
    pub fn range(&self) -> Range<u32> {
        self.range.clone()
    }
    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ---- what the pool knows

    /// What the pool holds.
    pub fn snapshot(&self) -> Snapshot {
        let table = self.table();
        let count = |wanted: fn(&State) -> bool| {
            table
                .slots
                .values()
                .filter(|slot| wanted(&slot.state))
                .count()
        };
        Snapshot {
            idle: count(|state| *state == State::Idle),
            spawning: count(|state| *state == State::Spawning(None)),
            held: count(|state| state.database().is_some()),
        }
    }

    /// Every database a slot holds.
    pub fn databases(&self) -> Vec<String> {
        self.table()
            .slots
            .values()
            .filter_map(|held| held.state.database().map(str::to_string))
            .collect()
    }

    /// How the agent reads the database's unit when its slot's unit is `active`: `None` when no
    /// slot holds it. A slot is `active` as soon as its supervisor is idle, so the unit of a
    /// database that is not ready is `activating`.
    pub fn view_of(&self, database: &str, active: ActiveState) -> Option<ActiveState> {
        Some(view(&self.held(database)?.1.state, active))
    }

    /// The slot that holds the database, in any state.
    pub fn slot_of(&self, database: &str) -> Option<u32> {
        self.table().holding(database).first().copied()
    }

    /// The volume the database's slot has mounted.
    pub fn volume_of(&self, database: &str) -> Option<VolumeId> {
        let table = self.table();
        let slot = table.holding(database).first().copied()?;
        table.slots.get(&slot)?.volume.clone()
    }

    /// Who the slot of uid `uid` runs a database for: from the bind to the end of the stop, since
    /// the archiver of a stopping PostgreSQL still calls the archive socket.
    pub fn holder(&self, uid: u32) -> Option<Holder> {
        let slot = slot_of_uid(uid)?;
        let table = self.table();
        let held = table.slots.get(&slot)?;
        Some(Holder {
            database: held.state.database()?.to_string(),
            cgroup: slot_cgroup(slot),
            invocation_id: held.invocation_id.clone()?,
        })
    }

    // ---- the path of a start

    /// Takes an idle slot or builds one, and binds the database to it. See the module.
    ///
    /// The slot is the database's from the take: the properties and the mounts go in, in
    /// parallel, and the check of the database's unit of its own with them. Nothing is sent to the
    /// supervisor. On any failure the slot is stopped, and the database holds nothing.
    pub async fn bind(&self, database: &str, bind: &Bind) -> Result<Bound, Error> {
        self.release_ended(database).await?;
        let data = bind.data.clone();
        tokio::task::spawn_blocking(move || data_lock_free(&data))
            .await
            .map_err(|_| Error::Unexpected("the lock check panicked"))??;
        let taking = Instant::now();
        let (slot, from) = self.take(database, &bind.volume).await?;
        let wait = taking.elapsed();
        let binding = Instant::now();
        let (set, mounted, legacy) = tokio::join!(
            self.host.set(slot, &bind.properties),
            self.host.mount(slot, bind),
            self.host.legacy_holds(database),
        );
        let failed = set.err().or(mounted.err()).or(match legacy {
            Ok(false) => None,
            Ok(true) => Some(Error::Held),
            Err(error) => Some(error),
        });
        if let Some(error) = failed {
            self.abort(slot).await;
            return Err(error);
        }
        let invocation_id = self
            .table()
            .slots
            .get(&slot)
            .and_then(|held| held.invocation_id.clone())
            .ok_or(Error::Unexpected("a slot without an invocation"))?;
        crate::timing::log_line(json!({
            "event": "slot_bound", "database_id": database, "slot": slot,
            "invocation": invocation_id, "slot_from": from.word(),
        }));
        Ok(Bound {
            slot,
            database: database.to_string(),
            uid: self.host.uid(slot),
            invocation_id,
            from,
            wait,
            bind: binding.elapsed(),
        })
    }

    /// Sends the order and waits for PostgreSQL to be ready.
    ///
    /// The caller has bound the archive socket's caller by now (the table answers
    /// [`Pool::holder`] from the take): PostgreSQL may call it before it is ready, when it replays
    /// WAL. A refusal of the supervisor, or a PostgreSQL that ends before it is ready, stops the
    /// slot; the database is then decided by its control file.
    pub async fn exec(&self, bound: &Bound) -> Result<Started, Error> {
        {
            let table = self.table();
            table
                .slots
                .get(&bound.slot)
                .filter(|held| {
                    held.state == State::Taken(bound.database.clone())
                        && held.invocation_id.as_deref() == Some(bound.invocation_id.as_str())
                })
                .ok_or(Error::Unexpected("the slot is not bound to this start"))?;
        }
        let ordered = match self.host.order(bound.slot, &bound.database).await {
            Ok(ordered) => ordered,
            Err(error) => {
                if let Error::Refused(word) = &error {
                    crate::timing::emit_event(json!({
                        "event": "slot_refused", "database_id": bound.database,
                        "slot": bound.slot, "reason": word,
                    }));
                }
                self.abort(bound.slot).await;
                return Err(error);
            }
        };
        let pid = ordered.main_pid;
        if let Some(held) = self.table().slots.get_mut(&bound.slot) {
            held.state = State::Starting(bound.database.clone());
            held.main_pid = Some(pid);
        }
        let starting = Instant::now();
        let socket = match self.host.ready(bound.slot, &bound.database, pid).await {
            Ok(socket) => socket,
            Err(error) => {
                // PostgreSQL that ended is over, and its slot with it. What could not be observed
                // is no evidence that PostgreSQL failed: it runs on, and the agent that asked
                // learns of it from the unit.
                if matches!(error, Error::NotReady("exited")) {
                    self.abort(bound.slot).await;
                }
                return Err(error);
            }
        };
        self.set_state_from(
            bound.slot,
            &State::Starting(bound.database.clone()),
            State::Serving(bound.database.clone()),
        );
        let micros = |duration: Duration| u64::try_from(duration.as_micros()).unwrap_or(u64::MAX);
        Ok(Started {
            main_pid: pid,
            invocation_id: bound.invocation_id.clone(),
            uid: bound.uid,
            socket,
            requested_us: ordered.sent_us,
            slot: Some(Report {
                slot: bound.slot,
                from: bound.from,
                wait_us: micros(bound.wait),
                bind_us: micros(bound.bind),
                order_us: micros(ordered.took),
                start_us: micros(starting.elapsed()),
            }),
        })
    }

    /// Waits for the database's PostgreSQL, which `exec` (or an earlier agent) began, to be ready.
    pub async fn wait_started(&self, database: &str) -> Result<Started, Error> {
        let (slot, held) = self
            .held(database)
            .ok_or(Error::NotReady("unit_not_active"))?;
        match held.state {
            State::Starting(_) | State::Serving(_) => {}
            // The supervisor has not been ordered: there is no PostgreSQL to wait for.
            State::Taken(_) => return Err(Error::NotReady("slot_not_ordered")),
            _ => return Err(Error::NotReady("unit_not_active")),
        }
        let pid = held.main_pid.ok_or(Error::NotReady("no_main_pid"))?;
        let socket = self.host.ready(slot, database, pid).await?;
        if matches!(held.state, State::Starting(_)) {
            self.set_state_from(slot, &held.state, State::Serving(database.to_string()));
        }
        Ok(Started {
            main_pid: pid,
            invocation_id: held
                .invocation_id
                .ok_or(Error::NotReady("no_invocation_id"))?,
            uid: self.host.uid(slot),
            socket,
            requested_us: None,
            slot: None,
        })
    }

    /// Stops the slot that holds the database and waits until its unit is over. `false` when no
    /// slot holds it.
    pub async fn stop(&self, database: &str) -> Result<bool, Error> {
        let Some((slot, _)) = self.held(database) else {
            return Ok(false);
        };
        self.set_state(slot, State::Stopping(Some(database.to_string())));
        self.host.stop(slot).await?;
        let unit = self.host.unit(slot).await?;
        if self.over(slot, &unit) {
            self.forget(slot, database, "stopped");
            Ok(true)
        } else {
            Err(Error::Held)
        }
    }

    /// The database's unit as the agent reads it, if a slot holds it.
    pub async fn state(&self, database: &str) -> Result<Option<UnitState>, Error> {
        let Some((slot, held)) = self.held(database) else {
            return Ok(None);
        };
        let unit = self.host.unit(slot).await?;
        Ok(Some(unit_state(
            database,
            slot,
            self.host.uid(slot),
            &held,
            &unit,
        )))
    }

    /// The units of every database that a slot holds.
    pub async fn states(&self) -> Result<Vec<UnitState>, Error> {
        let held: Vec<(String, u32, Slot)> = self
            .table()
            .slots
            .iter()
            .filter_map(|(slot, held)| {
                Some((held.state.database()?.to_string(), *slot, held.clone()))
            })
            .collect();
        futures_util::future::try_join_all(held.iter().map(|(database, slot, held)| async move {
            let unit = self.host.unit(*slot).await?;
            Ok::<_, Error>(unit_state(
                database,
                *slot,
                self.host.uid(*slot),
                held,
                &unit,
            ))
        }))
        .await
    }

    /// Sets runtime properties on the slot that holds the database; `false` when none does.
    pub async fn set(&self, database: &str, properties: &[Property]) -> Result<bool, Error> {
        let Some((slot, held)) = self.held(database) else {
            return Ok(false);
        };
        if matches!(held.state, State::Stopping(_)) {
            return Ok(false);
        }
        self.host.set(slot, properties).await?;
        Ok(true)
    }

    /// What systemd and the journal recorded of the start that gave `started`. The fork and the
    /// handoff of the supervisor are the start of a slot built on demand, which the wake waited
    /// for; the three messages of PostgreSQL's start are counted from the order. Empty where the
    /// slot started again since.
    pub async fn timeline(
        &self,
        database: &str,
        started: &Started,
    ) -> Result<super::Timeline, Error> {
        let Some((slot, held)) = self.held(database) else {
            return Ok(super::Timeline::default());
        };
        let report = started.slot;
        if held.invocation_id.as_deref() != Some(started.invocation_id.as_str()) {
            return Ok(super::Timeline::default());
        }
        let mut timeline = super::Timeline::default();
        if report.is_some_and(|report| report.from == SlotFrom::Demand)
            && let Some((fork_us, handoff_us)) = self.host.timestamps(slot).await?
        {
            timeline.job_to_fork_us = held
                .requested_us
                .and_then(|requested| fork_us.checked_sub(requested));
            timeline.fork_to_handoff_us = handoff_us.checked_sub(fork_us);
        }
        if let (Some(order_us), Ok(journal)) = (
            started.requested_us,
            super::journal::read(&started.invocation_id).await,
        ) {
            timeline.startup = super::journal::startup(&journal, order_us);
        }
        Ok(timeline)
    }

    // ---- the pool itself

    /// Builds one idle slot if fewer than `target` are idle or being built; the number of the
    /// slot it built. The caller decides when: the build costs the node about 80 ms of CPU, and it
    /// must not take it from a wake. The refill also makes the slot users a wake may need ahead of
    /// it ([`Pool::make_users`]), because a wake never makes one.
    pub async fn refill(&self, target: usize) -> Result<Option<u32>, Error> {
        self.sweep().await;
        self.make_users(target).await?;
        let counted = self.snapshot();
        if counted.idle + counted.spawning >= target {
            return Ok(None);
        }
        let slot = self.table().reserve(&self.range, None)?;
        let spawned = self.build(slot, None).await?;
        self.set_state(slot, State::Idle);
        let mut event = json!({
            "event": "slot_spawned", "slot": slot, "invocation": spawned.invocation_id,
            "cause": "refill",
        });
        if let Ok(Some((fork_us, handoff_us))) = self.host.timestamps(slot).await {
            if let Some(requested) = spawned.requested_us {
                event["job_to_fork_us"] = fork_us.saturating_sub(requested).into();
            }
            event["fork_to_handoff_us"] = handoff_us.saturating_sub(fork_us).into();
        }
        crate::timing::emit_event(event);
        Ok(Some(slot))
    }

    /// Makes the users a start may need, ahead of it: every number below the highest in use plus
    /// twice `target`, lowest first, so that the numbers a wake takes first have theirs first.
    /// `groupadd` and `useradd` take node-wide locks on `/etc/passwd` and `/etc/group` and cost
    /// about 75 ms each (lab, Debian 13), so a wake never makes a user: one that finds no free
    /// number with a user fails with `NoSlot`, and the refill that its failure asks for makes the
    /// users. A user that cannot be made keeps its number out of every later build, and ends this
    /// pass with the error.
    async fn make_users(&self, target: usize) -> Result<(), Error> {
        let end = {
            let table = self.table();
            let highest = table
                .slots
                .keys()
                .next_back()
                .map_or(self.range.start, |slot| slot + 1);
            let ahead = u32::try_from(target.saturating_mul(2)).unwrap_or(u32::MAX);
            highest.saturating_add(ahead).min(self.range.end)
        };
        for slot in self.range.start..end {
            {
                let table = self.table();
                if table.users.contains(&slot) || table.failed.contains(&slot) {
                    continue;
                }
            }
            match self.host.ensure_user(slot).await {
                Ok(()) => {
                    self.table().users.insert(slot);
                }
                Err(error) => {
                    self.table().failed.insert(slot);
                    build_failed(slot, "user", None, &error);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    /// Stops every idle slot, and the ones that were left behind by a stop that failed.
    pub async fn drain_idle(&self) -> usize {
        let idle: Vec<u32> = {
            let mut table = self.table();
            let idle: Vec<u32> = table
                .slots
                .iter()
                .filter(|(_, held)| held.state == State::Idle)
                .map(|(slot, _)| *slot)
                .collect();
            for slot in &idle {
                if let Some(held) = table.slots.get_mut(slot) {
                    held.state = State::Stopping(None);
                }
            }
            idle
        };
        futures_util::future::join_all(idle.iter().map(|slot| self.finish_stop(*slot)))
            .await
            .into_iter()
            .filter(|ended| *ended)
            .count()
    }

    /// Reads the table back from the kernel when the agent starts, before anything is admitted.
    ///
    /// A slot that is idle stays; one that holds a database it was never ordered to run, or that
    /// does not hold the data directory's lock, is stopped and its database stays asleep with its
    /// proof; one whose PostgreSQL runs is kept, ready or starting; one that is stopping is
    /// waited for. The agent decides on each database afterwards, from its volume, and the units
    /// it reads (`state`) are the slots' own.
    pub async fn adopt(&self) -> Result<Adopted, Error> {
        // An agent that starts remembers nothing: what it finds is what the kernel says.
        {
            let mut table = self.table();
            table.slots.clear();
            table.failed.clear();
            table.users = self.host.users();
        }
        let units: Vec<SlotUnit> = self
            .host
            .units()
            .await?
            .into_iter()
            .filter(|unit| self.range.contains(&unit.slot))
            .collect();
        let mut adopted = Adopted::default();
        let mut stopping = Vec::new();
        for unit in units.into_iter().filter(|unit| !self.over(unit.slot, unit)) {
            let class = self.classify(&unit).await?;
            let slot = unit.slot;
            let kept = |state: State, volume: Option<VolumeId>| Slot {
                state,
                main_pid: unit.main_pid,
                invocation_id: unit.invocation_id.clone(),
                requested_us: None,
                volume,
            };
            match class {
                Class::Idle => {
                    // Whatever the last agent set before it died, the idle limits go on again.
                    self.host.set(slot, &super::limits::idle()).await?;
                    self.table().slots.insert(slot, kept(State::Idle, None));
                    adopted.idle.push(slot);
                }
                Class::Starting(database, volume) => {
                    self.table()
                        .slots
                        .insert(slot, kept(State::Starting(database.clone()), Some(volume)));
                    adopted.starting.push(database);
                }
                Class::Serving(database, volume) => {
                    self.table()
                        .slots
                        .insert(slot, kept(State::Serving(database.clone()), Some(volume)));
                    adopted.serving.push(database);
                }
                Class::Stop { database, tainted } => {
                    if let (true, Some(database)) = (tainted, &database) {
                        crate::timing::emit_event(json!({
                            "event": "slot_tainted_stopped", "database_id": database,
                            "slot": slot,
                        }));
                        adopted.tainted.push((slot, database.clone()));
                    }
                    self.table()
                        .slots
                        .insert(slot, kept(State::Stopping(database), None));
                    stopping.push(slot);
                }
            }
        }
        // The stops run together, each as long as the unit's own stop timeout allows.
        let waiting = futures_util::future::join_all(stopping.iter().map(|slot| async {
            tokio::time::timeout(ADOPT_STOP_BOUND, self.finish_stop(*slot))
                .await
                .unwrap_or(false)
        }));
        waiting.await;
        Ok(adopted)
    }

    // ---- inside

    fn held(&self, database: &str) -> Option<(u32, Slot)> {
        let table = self.table();
        let slot = table.holding(database).first().copied()?;
        Some((slot, table.slots.get(&slot)?.clone()))
    }

    fn set_state(&self, slot: u32, state: State) {
        if let Some(held) = self.table().slots.get_mut(&slot) {
            held.state = state;
        }
    }

    /// Changes the state only if it is still `from`: what a late waiter may not undo.
    fn set_state_from(&self, slot: u32, from: &State, state: State) {
        if let Some(held) = self.table().slots.get_mut(&slot)
            && held.state == *from
        {
            held.state = state;
        }
    }

    /// Whether the slot's unit is over. A unit that ended `failed` (its postmaster crashed, its
    /// supervisor refused an order, or a process outlived the final SIGKILL) keeps its number out
    /// of the next builds: the start of a unit with a process left in its cgroup is refused, and a
    /// wake must not be the one that finds out.
    fn over(&self, slot: u32, unit: &SlotUnit) -> bool {
        if !unit.ended() {
            return false;
        }
        if unit.active == ActiveState::Failed {
            self.table().failed.insert(slot);
        }
        true
    }

    /// Removes a slot's entry for good, as its unit is over.
    fn forget(&self, slot: u32, database: &str, reason: &str) {
        let removed = {
            let mut table = self.table();
            let ours = table
                .slots
                .get(&slot)
                .is_some_and(|held| held.state.database() == Some(database));
            ours.then(|| table.slots.remove(&slot)).flatten()
        };
        if removed.is_some() {
            crate::timing::log_line(json!({
                "event": "slot_ended", "database_id": database, "slot": slot, "reason": reason,
            }));
        }
    }

    /// A slot that held the database and whose unit is over is gone; one whose unit is not over
    /// keeps the database held.
    async fn release_ended(&self, database: &str) -> Result<(), Error> {
        let held = self.table().holding(database);
        for slot in held {
            // A slot that is being built for another start of the database has no unit to be over
            // yet: it is that start's, and it holds the database.
            let building = self
                .table()
                .slots
                .get(&slot)
                .is_some_and(|held| matches!(held.state, State::Spawning(_)));
            if building {
                return Err(Error::Held);
            }
            let unit = self.host.unit(slot).await?;
            if !self.over(slot, &unit) {
                return Err(Error::Held);
            }
            self.forget(slot, database, "ended");
        }
        Ok(())
    }

    /// Sets the idle limits, starts the unit and asks the supervisor whether it is idle; the slot
    /// is entered as being built (`database`: the start that waits for it, if any). A failure
    /// stops the unit, keeps the number out of the next builds and says so; the entry goes once
    /// its unit is over, and stays, swept again, while a process of it remains.
    async fn build(&self, slot: u32, database: Option<&str>) -> Result<Spawned, Error> {
        let built = async {
            self.host.set(slot, &super::limits::idle()).await?;
            let spawned = self.host.start(slot).await?;
            self.host.ping(slot).await?;
            Ok::<_, Error>(spawned)
        }
        .await;
        match built {
            Ok(spawned) => {
                let mut table = self.table();
                table.failed.remove(&slot);
                if let Some(held) = table.slots.get_mut(&slot) {
                    held.main_pid = Some(spawned.main_pid);
                    held.invocation_id = Some(spawned.invocation_id.clone());
                    held.requested_us = spawned.requested_us;
                }
                Ok(spawned)
            }
            Err(error) => {
                self.table().failed.insert(slot);
                build_failed(
                    slot,
                    if database.is_some() {
                        "demand"
                    } else {
                        "refill"
                    },
                    database,
                    &error,
                );
                self.set_state(slot, State::Stopping(None));
                self.finish_stop(slot).await;
                Err(error)
            }
        }
    }

    /// An idle slot for the database, or a new one built inside the bind.
    ///
    /// The claim is one step under the table's lock: no slot holds the database in any state (a
    /// start that passed `release_ended` at the same time as this one is the other's, and loses),
    /// and then an idle slot becomes the database's, or a free number with a user is entered as
    /// being built for it.
    async fn take(&self, database: &str, volume: &VolumeId) -> Result<(u32, SlotFrom), Error> {
        loop {
            let claim = {
                let mut table = self.table();
                if !table.holding(database).is_empty() {
                    return Err(Error::Held);
                }
                let idle = table
                    .slots
                    .iter()
                    .find(|(_, held)| held.state == State::Idle)
                    .map(|(slot, _)| *slot);
                match idle {
                    Some(slot) => {
                        if let Some(held) = table.slots.get_mut(&slot) {
                            held.state = State::Taken(database.to_string());
                            held.volume = Some(volume.clone());
                        }
                        Claim::Idle(slot)
                    }
                    None => Claim::Build(table.reserve(&self.range, Some(database))?),
                }
            };
            match claim {
                Claim::Idle(slot) if self.host.alive(slot) => return Ok((slot, SlotFrom::Pool)),
                // The supervisor ended while it waited: the slot is no use.
                Claim::Idle(slot) => {
                    self.set_state(slot, State::Stopping(None));
                    self.finish_stop(slot).await;
                }
                Claim::Build(slot) => {
                    let spawned = self.build(slot, Some(database)).await?;
                    // The wake's own detail has what this one cost; the line is for the node's log.
                    crate::timing::log_line(json!({
                        "event": "slot_spawned", "slot": slot, "invocation": spawned.invocation_id,
                        "cause": "demand",
                    }));
                    if let Some(held) = self.table().slots.get_mut(&slot) {
                        held.state = State::Taken(database.to_string());
                        held.volume = Some(volume.clone());
                    }
                    return Ok((slot, SlotFrom::Demand));
                }
            }
        }
    }

    /// A slot that failed before the order: stopped, and the database holds nothing.
    async fn abort(&self, slot: u32) {
        let database = {
            let mut table = self.table();
            table.slots.get_mut(&slot).and_then(|held| {
                let database = held.state.database().map(str::to_string);
                held.state = State::Stopping(database.clone());
                database
            })
        };
        if self.finish_stop(slot).await
            && let Some(database) = database
        {
            crate::timing::log_line(json!({
                "event": "slot_ended", "database_id": database, "slot": slot,
                "reason": "aborted",
            }));
        }
    }

    /// Stops a slot that is marked `Stopping` and drops it once its unit is over; whether it is.
    async fn finish_stop(&self, slot: u32) -> bool {
        let stopped = self.host.stop(slot).await;
        let over = match stopped {
            Ok(()) => self
                .host
                .unit(slot)
                .await
                .is_ok_and(|unit| self.over(slot, &unit)),
            Err(_) => false,
        };
        if over {
            self.table().slots.remove(&slot);
        }
        over
    }

    /// Idle slots whose supervisor ended, and stops that failed earlier, are dealt with.
    async fn sweep(&self) {
        let dead: Vec<u32> = {
            let mut table = self.table();
            let dead: Vec<u32> = table
                .slots
                .iter()
                .filter(|(slot, held)| match held.state {
                    State::Idle => !self.host.alive(**slot),
                    State::Stopping(None) => true,
                    _ => false,
                })
                .map(|(slot, _)| *slot)
                .collect();
            for slot in &dead {
                if let Some(held) = table.slots.get_mut(slot) {
                    held.state = State::Stopping(None);
                }
            }
            dead
        };
        futures_util::future::join_all(dead.iter().map(|slot| self.finish_stop(*slot))).await;
    }

    /// The class of a slot unit that is not over, from the kernel's facts.
    async fn classify(&self, unit: &SlotUnit) -> Result<Class, Error> {
        let Some(facts) = self.host.facts(unit.slot, unit.main_pid)? else {
            // No process: the unit ends by itself.
            return Ok(Class::Stop {
                database: None,
                tainted: false,
            });
        };
        let database = facts
            .databases
            .first()
            .map(|(database, _)| database.clone());
        // The one database a PostgreSQL serves: its volume is named and it holds the lock. A mount
        // that cannot be named, a second mount and a missing lock are none.
        let served = match facts.databases.as_slice() {
            [(database, Some(volume))] if facts.locked => Some((database.clone(), volume.clone())),
            _ => None,
        };
        Ok(match (unit.active, facts.exe, served) {
            (ActiveState::Active, Exe::Supervisor, _) if facts.databases.is_empty() => {
                match self.host.ping(unit.slot).await {
                    Ok(()) => Class::Idle,
                    // Another protocol, or a supervisor that does not answer: built again.
                    Err(_) => Class::Stop {
                        database: None,
                        tainted: false,
                    },
                }
            }
            // A mount at a database's directory, named or not, and the order was not sent: the
            // database never ran.
            (_, Exe::Supervisor, _) => Class::Stop {
                tainted: database.is_some(),
                database,
            },
            (ActiveState::Deactivating, _, _) => Class::Stop {
                database,
                tainted: false,
            },
            (
                ActiveState::Active | ActiveState::Activating,
                Exe::Postgres,
                Some((database, volume)),
            ) => {
                match facts.postmaster {
                    Some(ready::Status::Ready) => Class::Serving(database, volume),
                    // It holds the lock and has not written a status yet, or says it starts: the
                    // order was carried out and PostgreSQL comes up.
                    Some(ready::Status::Starting) | None => Class::Starting(database, volume),
                    Some(ready::Status::Stopping | ready::Status::Standby) => Class::Stop {
                        database: Some(database),
                        tainted: false,
                    },
                }
            }
            _ => Class::Stop {
                tainted: database.is_some(),
                database,
            },
        })
    }
}

/// What a start's claim on the pool got.
enum Claim {
    /// An idle slot, now the database's.
    Idle(u32),
    /// A number entered as being built for the database.
    Build(u32),
}

/// A slot that could not be built: its number is kept out of the next builds, and the node says
/// which and why (`cause`: the `refill`, a `demand` build inside a wake, or the `user` of a number).
fn build_failed(slot: u32, cause: &str, database: Option<&str>, error: &Error) {
    let mut event = json!({
        "event": "slot_build_failed", "slot": slot, "cause": cause,
        "class": crate::diagnostics::units_code(error),
    });
    if let Some(database) = database {
        event["database_id"] = database.into();
    }
    crate::timing::emit_event(event);
}

/// The class of a unit the agent finds when it starts.
enum Class {
    Idle,
    Starting(String, VolumeId),
    Serving(String, VolumeId),
    Stop {
        database: Option<String>,
        /// It held a database it was not ready to serve.
        tainted: bool,
    },
}

/// The database's unit as the agent reads it: the slot's, with the states a slot has that a unit
/// of its own did not. A slot is `active` as soon as its supervisor is idle, so the unit of a
/// database that is not ready is `activating`.
fn unit_state(database: &str, slot: u32, uid: u32, held: &Slot, unit: &SlotUnit) -> UnitState {
    UnitState {
        database: database.to_string(),
        active: view(&held.state, unit.active),
        main_pid: unit.main_pid,
        invocation_id: unit.invocation_id.clone(),
        uid: Some(uid),
        memory_max_bytes: unit.memory_max_bytes,
        slot: Some(slot),
    }
}

/// The unit's active state as the agent reads it, from the slot's state and systemd's.
fn view(state: &State, active: ActiveState) -> ActiveState {
    match (state, active) {
        (State::Taken(_) | State::Starting(_), ActiveState::Active) => ActiveState::Activating,
        (State::Stopping(_), ActiveState::Active) => ActiveState::Deactivating,
        (_, active) => active,
    }
}

/// What [`Pool::adopt`] found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    pub idle: Vec<u32>,
    pub starting: Vec<String>,
    pub serving: Vec<String>,
    /// Slots that held a database without being ready for it, which were stopped.
    pub tainted: Vec<(u32, String)>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn volume(database: &str, generation: u64) -> VolumeId {
        VolumeId::new(database, generation).unwrap()
    }
    const D1: &str = "abcdefghij0123456789";
    const D2: &str = "bcdefghijk1234567890";

    /// systemd and the kernel of one node, for the pool alone: units with a state, a process of
    /// one program, the mounts and the lock they would have, and a log of the calls the pool made.
    #[derive(Clone)]
    struct Sim(Arc<Mutex<SimState>>);
    #[derive(Default)]
    struct SimState {
        units: BTreeMap<u32, SimUnit>,
        users: BTreeSet<u32>,
        calls: Vec<String>,
        next_pid: u32,
        next_invocation: u64,
        /// The next call of this name fails: `set`, `mount`, `start`, `ping`, `order`, `ready`.
        fail: BTreeSet<&'static str>,
        legacy: BTreeSet<String>,
        /// Databases whose data directory a postmaster holds the lock on, by slot.
        locks: BTreeMap<String, u32>,
        /// Slots whose unit failed with a process left in its cgroup: a start is refused.
        stuck: BTreeSet<u32>,
        /// Numbers whose user cannot be made.
        no_user: BTreeSet<u32>,
        /// A start waits here for a permit, as a unit's job takes its time.
        start_gate: Option<Arc<tokio::sync::Semaphore>>,
    }
    #[derive(Clone)]
    struct SimUnit {
        active: ActiveState,
        pid: Option<u32>,
        invocation: String,
        exe: Exe,
        /// The database directory mounted in the slot, and the volume if the agent can name it.
        mounted: Option<(String, Option<VolumeId>)>,
        status: Option<ready::Status>,
        memory_max: Option<u64>,
        properties: Vec<Property>,
    }
    impl Sim {
        /// A node that has run for a while: the users of the first slot numbers exist.
        fn new() -> Self {
            let sim = Self::fresh();
            sim.state().users = (0..32).collect();
            sim
        }
        /// A node that never made a slot: no slot user exists.
        fn fresh() -> Self {
            Self(Arc::new(Mutex::new(SimState {
                next_pid: 1000,
                ..SimState::default()
            })))
        }
        fn state(&self) -> std::sync::MutexGuard<'_, SimState> {
            self.0.lock().unwrap()
        }
        fn calls(&self) -> Vec<String> {
            self.state().calls.clone()
        }
        fn clear(&self) {
            self.state().calls.clear();
        }
        fn fail_next(&self, call: &'static str) {
            self.state().fail.insert(call);
        }
        fn failing(&self, call: &'static str) -> bool {
            self.state().fail.remove(call)
        }
        fn unit_of(&self, slot: u32) -> Option<SimUnit> {
            self.state().units.get(&slot).cloned()
        }
        fn active(&self, slot: u32) -> ActiveState {
            self.unit_of(slot)
                .map_or(ActiveState::Inactive, |unit| unit.active)
        }
        /// The process of the slot ends by itself, cleanly: the unit is `inactive`.
        fn exit(&self, slot: u32) {
            let mut state = self.state();
            if let Some(unit) = state.units.get_mut(&slot) {
                unit.active = ActiveState::Inactive;
                unit.pid = None;
            }
            state.locks.retain(|_, held| *held != slot);
        }
        /// The process of the slot dies by itself, as a crashed postmaster does.
        fn die(&self, slot: u32) {
            let mut state = self.state();
            if let Some(unit) = state.units.get_mut(&slot) {
                unit.active = ActiveState::Failed;
                unit.pid = None;
            }
            state.locks.retain(|_, held| *held != slot);
        }
        fn properties(&self, slot: u32) -> Vec<Property> {
            self.unit_of(slot)
                .map(|unit| unit.properties)
                .unwrap_or_default()
        }
    }
    fn refused(call: &'static str) -> Error {
        Error::Unexpected(call)
    }
    impl Host for Sim {
        async fn unit(&self, slot: u32) -> Result<SlotUnit, Error> {
            let state = self.state();
            Ok(state.units.get(&slot).map_or(
                SlotUnit {
                    slot,
                    active: ActiveState::Inactive,
                    main_pid: None,
                    invocation_id: None,
                    memory_max_bytes: None,
                },
                |unit| SlotUnit {
                    slot,
                    active: unit.active,
                    main_pid: unit.pid,
                    invocation_id: Some(unit.invocation.clone()),
                    memory_max_bytes: unit.memory_max,
                },
            ))
        }
        async fn units(&self) -> Result<Vec<SlotUnit>, Error> {
            let slots: Vec<u32> = self.state().units.keys().copied().collect();
            let mut units = Vec::new();
            for slot in slots {
                units.push(self.unit(slot).await?);
            }
            Ok(units)
        }
        fn users(&self) -> BTreeSet<u32> {
            self.state().users.clone()
        }
        async fn ensure_user(&self, slot: u32) -> Result<(), Error> {
            let mut state = self.state();
            if state.no_user.contains(&slot) {
                return Err(refused("useradd"));
            }
            if state.users.insert(slot) {
                state.calls.push(format!("user {slot}"));
            }
            Ok(())
        }
        async fn set(&self, slot: u32, properties: &[Property]) -> Result<(), Error> {
            if self.failing("set") {
                return Err(refused("set"));
            }
            let mut state = self.state();
            state.calls.push(format!("set {slot}"));
            let unit = state.units.entry(slot).or_insert_with(|| SimUnit {
                active: ActiveState::Inactive,
                pid: None,
                invocation: String::new(),
                exe: Exe::Supervisor,
                mounted: None,
                status: None,
                memory_max: None,
                properties: vec![],
            });
            for property in properties {
                if let Property::MemoryMax(bytes) = property {
                    unit.memory_max = Some(*bytes);
                }
            }
            unit.properties = properties.to_vec();
            Ok(())
        }
        async fn start(&self, slot: u32) -> Result<Spawned, Error> {
            let gate = self.state().start_gate.clone();
            if let Some(gate) = gate {
                gate.acquire().await.unwrap().forget();
            }
            if self.failing("start") {
                return Err(refused("start"));
            }
            if self.state().stuck.contains(&slot) {
                return Err(Error::StrayProcesses);
            }
            let mut state = self.state();
            state.calls.push(format!("start {slot}"));
            state.next_pid += 1;
            state.next_invocation += 1;
            let (pid, invocation) = (
                state.next_pid,
                format!("00000000-0000-4000-8000-{:012x}", state.next_invocation),
            );
            let unit = state.units.entry(slot).or_insert_with(|| SimUnit {
                active: ActiveState::Inactive,
                pid: None,
                invocation: String::new(),
                exe: Exe::Supervisor,
                mounted: None,
                status: None,
                memory_max: None,
                properties: vec![],
            });
            *unit = SimUnit {
                active: ActiveState::Active,
                pid: Some(pid),
                invocation: invocation.clone(),
                exe: Exe::Supervisor,
                mounted: None,
                status: None,
                ..unit.clone()
            };
            Ok(Spawned {
                main_pid: pid,
                invocation_id: invocation,
                requested_us: Some(1),
            })
        }
        async fn stop(&self, slot: u32) -> Result<(), Error> {
            let mut state = self.state();
            state.calls.push(format!("stop {slot}"));
            if let Some(unit) = state.units.get_mut(&slot) {
                // A stop job leaves a failed unit failed, as systemd does until it is reset.
                if unit.active != ActiveState::Failed {
                    unit.active = ActiveState::Inactive;
                }
                unit.pid = None;
                unit.mounted = None;
                unit.status = None;
                unit.exe = Exe::Supervisor;
            }
            state.locks.retain(|_, held| *held != slot);
            Ok(())
        }
        async fn ping(&self, slot: u32) -> Result<(), Error> {
            if self.failing("ping") {
                return Err(refused("ping"));
            }
            self.state().calls.push(format!("ping {slot}"));
            Ok(())
        }
        fn alive(&self, slot: u32) -> bool {
            self.unit_of(slot)
                .is_some_and(|unit| unit.pid.is_some() && unit.active == ActiveState::Active)
        }
        fn uid(&self, slot: u32) -> u32 {
            slot_uid(slot)
        }
        async fn mount(&self, slot: u32, bind: &Bind) -> Result<(), Error> {
            if self.failing("mount") {
                return Err(refused("mount"));
            }
            let mut state = self.state();
            state.calls.push(format!("mount {slot}"));
            let database = bind.volume.database().to_string();
            if let Some(unit) = state.units.get_mut(&slot) {
                unit.mounted = Some((database, Some(bind.volume.clone())));
            }
            Ok(())
        }
        async fn order(&self, slot: u32, database: &str) -> Result<Ordered, Error> {
            if self.failing("order") {
                return Err(refused("order"));
            }
            let mut state = self.state();
            state.calls.push(format!("order {slot} {database}"));
            if state.locks.get(database).is_some_and(|held| *held != slot) {
                return Err(Error::Refused("held"));
            }
            state.locks.insert(database.to_string(), slot);
            if let Some(unit) = state.units.get_mut(&slot) {
                unit.exe = Exe::Postgres;
                unit.status = Some(ready::Status::Starting);
            }
            let main_pid = state
                .units
                .get(&slot)
                .and_then(|unit| unit.pid)
                .unwrap_or(0);
            Ok(Ordered {
                main_pid,
                sent_us: Some(2),
                took: Duration::from_micros(10),
            })
        }
        async fn ready(&self, slot: u32, database: &str, main_pid: u32) -> Result<PathBuf, Error> {
            if self.failing("ready") {
                return Err(Error::NotReady("exited"));
            }
            let mut state = self.state();
            state.calls.push(format!("ready {slot}"));
            match state.units.get_mut(&slot) {
                Some(unit) if unit.pid == Some(main_pid) => {
                    unit.status = Some(ready::Status::Ready);
                    Ok(PathBuf::from(format!("/run/pgcf/{database}/.s.PGSQL.5432")))
                }
                _ => Err(Error::NotReady("exited")),
            }
        }
        fn facts(&self, slot: u32, pid: Option<u32>) -> Result<Option<Facts>, Error> {
            let state = self.state();
            let Some(unit) = state.units.get(&slot) else {
                return Ok(None);
            };
            let Some(process) = unit.pid.or(pid) else {
                return Ok(None);
            };
            let databases: Vec<_> = unit.mounted.iter().cloned().collect();
            let locked = databases
                .first()
                .is_some_and(|(database, _)| state.locks.get(database) == Some(&slot));
            Ok(Some(Facts {
                pid: process,
                exe: unit.exe,
                databases,
                locked,
                postmaster: unit.status,
            }))
        }
        async fn legacy_holds(&self, database: &str) -> Result<bool, Error> {
            Ok(self.state().legacy.contains(database))
        }
        async fn timestamps(&self, _slot: u32) -> Result<Option<(u64, u64)>, Error> {
            Ok(Some((100, 160)))
        }
    }

    fn account() -> Account {
        Account {
            name: "pgcf-abc".into(),
            uid: 200_123,
            gid: 200_123,
        }
    }
    fn bind_of(database: &str, generation: u64, data: &Path) -> Bind {
        Bind {
            volume: volume(database, generation),
            account: account(),
            device: PathBuf::from("/dev/mapper/pgcf-test"),
            data: data.to_path_buf(),
            properties: vec![Property::MemoryMax(256 << 20), Property::CpuWeight(100)],
        }
    }
    /// A data directory the agent can try-lock.
    fn data_directory(label: &str) -> PathBuf {
        let directory = super::super::test_dir(label);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }
    fn pool(sim: &Sim) -> Pool<Sim> {
        Pool::new(sim.clone(), POOL)
    }

    // 1. The binding rule.

    /// A bind of a database is refused while any slot holds any generation of it, and until the
    /// slot has reached `inactive`; a second database binds at once.
    #[tokio::test]
    async fn a_bind_is_refused_while_any_slot_holds_any_generation_of_the_database() {
        let (sim, data) = (Sim::new(), data_directory("bind-held"));
        let pool = pool(&sim);
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        // Taken, bound, ordered and serving are all held; so is another generation of the volume.
        assert_eq!(
            pool.bind(D1, &bind_of(D1, 1, &data))
                .await
                .unwrap_err()
                .to_string(),
            Error::Held.to_string()
        );
        assert!(matches!(
            pool.bind(D1, &bind_of(D1, 2, &data)).await,
            Err(Error::Held)
        ));
        pool.exec(&bound).await.unwrap();
        assert!(matches!(
            pool.bind(D1, &bind_of(D1, 2, &data)).await,
            Err(Error::Held)
        ));
        // Another database is not held by it.
        let other = pool.bind(D2, &bind_of(D2, 1, &data)).await.unwrap();
        assert_ne!(other.slot, bound.slot);
        // The unit has not reached `inactive`: the slot is deactivating, and still holds D1.
        sim.state().units.get_mut(&bound.slot).unwrap().active = ActiveState::Deactivating;
        assert!(matches!(
            pool.bind(D1, &bind_of(D1, 2, &data)).await,
            Err(Error::Held)
        ));
        // Once it has, a bind of the next generation is taken.
        sim.state().units.get_mut(&bound.slot).unwrap().active = ActiveState::Inactive;
        let next = pool.bind(D1, &bind_of(D1, 2, &data)).await.unwrap();
        assert_eq!(pool.volume_of(D1), Some(volume(D1, 2)));
        assert_eq!(next.database, D1);
    }

    /// The agent's own try-lock of the data directory refuses a bind while a postmaster holds it.
    #[tokio::test]
    async fn a_bind_is_refused_while_the_data_directory_is_locked() {
        let (sim, data) = (Sim::new(), data_directory("bind-locked"));
        let pool = pool(&sim);
        let holder = open_directory(&data).unwrap();
        holder.lock().unwrap();
        assert!(matches!(
            pool.bind(D1, &bind_of(D1, 1, &data)).await,
            Err(Error::Held)
        ));
        assert!(
            sim.calls().is_empty(),
            "nothing was taken: {:?}",
            sim.calls()
        );
        drop(holder);
        pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        // The agent's own lock, held while it writes a sleeping database's files, is a lock too.
        let lock = DataLock::try_new(&data).unwrap();
        assert!(matches!(data_lock_free(&data), Err(Error::Held)));
        drop(lock);
        data_lock_free(&data).unwrap();
    }

    /// The database's unit of its own, if one runs, is a holder too.
    #[tokio::test]
    async fn a_bind_is_refused_while_the_databases_unit_of_its_own_runs() {
        let (sim, data) = (Sim::new(), data_directory("bind-legacy"));
        let pool = pool(&sim);
        sim.state().legacy.insert(D1.to_string());
        assert!(matches!(
            pool.bind(D1, &bind_of(D1, 1, &data)).await,
            Err(Error::Held)
        ));
        // The slot that was taken for it is stopped and gone, and D2 is not held.
        assert_eq!(pool.snapshot(), Snapshot::default());
        pool.bind(D2, &bind_of(D2, 1, &data)).await.unwrap();
    }

    // 4. The order is the last step.

    /// The order is never sent when the properties fail, or the mounts: the slot is stopped, the
    /// database holds nothing, and the next bind works.
    #[tokio::test]
    async fn the_order_is_not_sent_when_the_properties_or_the_mounts_fail() {
        for failing in ["set", "mount"] {
            let (sim, data) = (Sim::new(), data_directory("bind-fails"));
            let pool = pool(&sim);
            // An idle slot, so that the failure is the bind's and not the build's.
            pool.refill(1).await.unwrap();
            sim.fail_next(failing);
            assert!(
                pool.bind(D1, &bind_of(D1, 1, &data)).await.is_err(),
                "{failing}"
            );
            assert!(
                !sim.calls().iter().any(|call| call.starts_with("order")),
                "{failing}: {:?}",
                sim.calls()
            );
            assert!(
                sim.calls().iter().any(|call| call.starts_with("stop")),
                "{failing}"
            );
            assert_eq!(pool.slot_of(D1), None);
            assert_eq!(pool.snapshot(), Snapshot::default(), "{failing}");
            assert!(pool.holder(slot_uid(0)).is_none());
            // The database was not started: the next bind and start go through.
            let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
            pool.exec(&bound).await.unwrap();
        }
    }

    // 6. A miss builds inside the bind.

    /// A bind with no idle slot builds one and says so; with an idle slot it builds none. A miss
    /// makes no user: the node's users exist already.
    #[tokio::test]
    async fn a_pool_miss_builds_the_slot_inside_the_bind_and_a_hit_builds_none() {
        let (sim, data) = (Sim::new(), data_directory("miss"));
        let pool = pool(&sim);
        // A miss on a pool that never built a slot: the unit, then the bind.
        let miss = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(miss.from, SlotFrom::Demand);
        assert_eq!(
            sim.calls(),
            ["set 0", "start 0", "ping 0", "set 0", "mount 0"]
        );
        // The refill built one beforehand; a hit only binds.
        assert_eq!(pool.refill(1).await.unwrap(), Some(1));
        sim.clear();
        let hit = pool.bind(D2, &bind_of(D2, 1, &data)).await.unwrap();
        assert_eq!(hit.from, SlotFrom::Pool);
        assert_eq!(hit.slot, 1);
        assert_eq!(sim.calls(), ["set 1", "mount 1"]);
        // A miss takes the lowest free number.
        sim.clear();
        let again = pool
            .bind(
                "cdefghijkl2345678901",
                &bind_of("cdefghijkl2345678901", 1, &data),
            )
            .await
            .unwrap();
        assert_eq!(again.from, SlotFrom::Demand);
        assert_eq!(again.slot, 2, "the lowest free number");
        assert_eq!(
            sim.calls(),
            ["set 2", "start 2", "ping 2", "set 2", "mount 2"]
        );
    }

    /// A wake makes no slot user (`groupadd` and `useradd` lock the node's account files, and a
    /// storm of builds on a new node would contend for them): a miss takes only a number that has
    /// one, and fails where none has. The refill makes the users, lowest number first, ahead of
    /// the highest slot in use by twice the target.
    #[tokio::test]
    async fn a_miss_never_makes_a_user_and_the_refill_makes_them_ahead() {
        let (sim, data) = (Sim::fresh(), data_directory("users"));
        let pool = pool(&sim);
        let databases = [
            D1,
            D2,
            "cdefghijkl2345678901",
            "defghijklm3456789012",
            "efghijklmn4567890123",
            "fghijklmno5678901234",
        ];
        let bind = |database: &'static str| {
            let (pool, data) = (&pool, data.clone());
            async move { pool.bind(database, &bind_of(database, 1, &data)).await }
        };
        // A node that never made a slot: a miss has no number with a user, and runs no useradd.
        assert!(matches!(bind(databases[0]).await, Err(Error::NoSlot)));
        assert!(sim.calls().is_empty(), "{:?}", sim.calls());
        assert_eq!(pool.snapshot(), Snapshot::default());
        assert_eq!(
            pool.slot_of(databases[0]),
            None,
            "a failed claim holds nothing"
        );

        // The refill: users 0 to 3 (twice the target of 2, from slot 0), then the first idle slot;
        // the second refill is ahead of slot 0, so one more.
        assert_eq!(pool.refill(2).await.unwrap(), Some(0));
        assert_eq!(
            sim.calls()[..4],
            ["user 0", "user 1", "user 2", "user 3"],
            "{:?}",
            sim.calls()
        );
        assert_eq!(pool.refill(2).await.unwrap(), Some(1));
        assert_eq!(sim.state().users, BTreeSet::from([0, 1, 2, 3, 4]));
        sim.clear();
        // Two hits, then three misses on the numbers whose users the refill made: no user on a wake.
        let mut taken = Vec::new();
        for (at, database) in databases[..5].iter().enumerate() {
            let bound = bind(database).await.unwrap();
            let from = if at < 2 {
                SlotFrom::Pool
            } else {
                SlotFrom::Demand
            };
            assert_eq!(bound.from, from, "{database}");
            taken.push(bound.slot);
        }
        assert_eq!(taken, [0, 1, 2, 3, 4]);
        assert!(
            !sim.calls().iter().any(|call| call.starts_with("user")),
            "{:?}",
            sim.calls()
        );
        // Past the numbers that have a user, a miss fails; the next refill makes more users, ahead
        // of the highest number in use (4 + 1 + 4 = 9, so up to 8).
        assert!(matches!(bind(databases[5]).await, Err(Error::NoSlot)));
        assert_eq!(pool.refill(2).await.unwrap(), Some(5));
        assert_eq!(sim.state().users, (0..9).collect::<BTreeSet<u32>>());
    }

    /// A user that cannot be made keeps its number out of the builds, and the refill goes on with
    /// the numbers above it on its next pass.
    #[tokio::test]
    async fn a_number_whose_user_cannot_be_made_is_skipped() {
        let (sim, data) = (Sim::fresh(), data_directory("no-user"));
        sim.state().no_user.insert(1);
        let pool = pool(&sim);
        assert!(pool.refill(1).await.is_err(), "user 1 fails");
        assert!(sim.state().users.contains(&0));
        assert!(!sim.state().users.contains(&1));
        assert_eq!(pool.refill(1).await.unwrap(), Some(0));
        let hit = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(hit.slot, 0);
        // Number 0 is in use and number 1 has no user: a wake finds nothing to take, and makes none.
        assert!(matches!(
            pool.bind(D2, &bind_of(D2, 1, &data)).await,
            Err(Error::NoSlot)
        ));
        // The refill goes past number 1 and makes the user of number 2, and no attempt is made at 1.
        sim.clear();
        assert_eq!(pool.refill(1).await.unwrap(), Some(2));
        assert!(
            sim.calls().iter().any(|call| call == "user 2"),
            "{:?}",
            sim.calls()
        );
        assert!(
            !sim.calls().iter().any(|call| call == "user 1"),
            "{:?}",
            sim.calls()
        );
    }

    // 6. The binding rule is one step.

    /// Two binds of one database that both passed the check of the table before either claimed a
    /// slot claim one slot between them: the table is looked at again in the step that takes it.
    #[tokio::test]
    async fn two_binds_of_one_database_claim_one_slot_between_them() {
        let (sim, data) = (Sim::new(), data_directory("claim-twice"));
        let pool = pool(&sim);
        pool.refill(2).await.unwrap();
        pool.refill(2).await.unwrap();
        let (one, two) = (bind_of(D1, 1, &data), bind_of(D1, 2, &data));
        let (first, second) = tokio::join!(pool.bind(D1, &one), pool.bind(D1, &two));
        let outcomes = [first.is_ok(), second.is_ok()];
        assert_eq!(
            outcomes.iter().filter(|ok| **ok).count(),
            1,
            "exactly one bind wins: {first:?} {second:?}"
        );
        let refused = first.err().or(second.err());
        assert!(matches!(refused, Some(Error::Held)), "{refused:?}");
        assert_eq!(pool.snapshot().held, 1, "one slot holds D1");
        assert_eq!(
            pool.snapshot().idle,
            1,
            "the other idle slot was not touched"
        );
    }

    /// A start that builds its slot already holds the database: a second bind of it, begun while
    /// the unit is still starting, is refused, and the slot being built is neither taken nor
    /// forgotten by it.
    #[tokio::test]
    async fn a_slot_being_built_for_a_start_already_holds_its_database() {
        let (sim, data) = (Sim::new(), data_directory("building"));
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        sim.state().start_gate = Some(gate.clone());
        let pool = Arc::new(pool(&sim));
        let first = {
            let (pool, data) = (pool.clone(), data.clone());
            tokio::spawn(async move { pool.bind(D1, &bind_of(D1, 1, &data)).await })
        };
        // The first bind is building: its unit has not started (the gate holds it).
        for _ in 0..200 {
            if pool.slot_of(D1).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            pool.slot_of(D1).is_some(),
            "the slot being built holds the database"
        );
        assert_eq!(
            pool.snapshot().spawning,
            0,
            "it is no idle slot in the making"
        );
        let second = pool.bind(D1, &bind_of(D1, 1, &data)).await;
        assert!(matches!(second, Err(Error::Held)), "{second:?}");
        // The first bind finishes undisturbed.
        gate.add_permits(1);
        let bound = first.await.unwrap().unwrap();
        assert_eq!(bound.from, SlotFrom::Demand);
        assert_eq!(pool.slot_of(D1), Some(bound.slot));
        assert_eq!(pool.snapshot().held, 1);
    }

    // 4. A number whose build fails is kept out.

    /// A build that fails leaves its number out of the next builds, so that a slot whose unit
    /// failed with a process left in its cgroup (which refuses every start) cannot take every
    /// wake of the node with it, and it says so.
    #[tokio::test]
    async fn a_slot_number_whose_build_fails_is_not_the_next_one_built() {
        let (sim, data) = (Sim::new(), data_directory("failed-number"));
        let pool = pool(&sim);
        // A wake whose build of slot 0 fails: the unit refuses its start over a stray process.
        sim.state().stuck.insert(0);
        let database = "ghijklmnop6789012345";
        assert!(matches!(
            pool.bind(database, &bind_of(database, 1, &data)).await,
            Err(Error::StrayProcesses)
        ));
        assert_eq!(pool.snapshot(), Snapshot::default());
        let event = crate::events::seen().into_iter().find(|event| {
            event["event"] == "slot_build_failed" && event["database_id"] == database
        });
        let event = event.expect("a failed build is an event");
        let fields = &event["fields"];
        assert_eq!(
            (fields["slot"].as_u64(), fields["cause"].as_str()),
            (Some(0), Some("demand"))
        );
        assert_eq!(fields["class"], "units_stray_processes");
        // The next wake, and the refill, build the next number and not that one again.
        sim.clear();
        let next = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(next.slot, 1, "{:?}", sim.calls());
        assert!(
            !sim.calls().iter().any(|call| call == "start 0"),
            "{:?}",
            sim.calls()
        );
        assert_eq!(pool.refill(1).await.unwrap(), Some(2));
    }

    /// The number a build takes is free, has a user, and failed last: where every other number is
    /// in use the failed one is tried again, as it may work by then.
    #[test]
    fn a_failed_number_is_the_last_one_a_build_takes() {
        let serving = |database: &str| Slot {
            state: State::Serving(database.to_string()),
            main_pid: None,
            invocation_id: None,
            requested_us: None,
            volume: None,
        };
        let mut table = Table {
            users: BTreeSet::from([0, 1, 2, 3]),
            failed: BTreeSet::from([0]),
            ..Table::default()
        };
        assert_eq!(table.free_number(&(0..4)), Some(1), "not the failed 0");
        table.slots.insert(1, serving("a"));
        table.slots.insert(2, serving("b"));
        assert_eq!(table.free_number(&(0..4)), Some(3));
        table.slots.insert(3, serving("c"));
        assert_eq!(
            table.free_number(&(0..4)),
            Some(0),
            "the failed one is the last"
        );
        table.slots.insert(0, serving("d"));
        assert_eq!(table.free_number(&(0..4)), None, "every number is in use");
        // A number without a user is never taken, free as it is.
        table.users.remove(&2);
        table.slots.remove(&2);
        assert_eq!(table.free_number(&(0..4)), None);
    }

    /// A refill whose build fails keeps the number out too.
    #[tokio::test]
    async fn a_refill_whose_build_fails_goes_on_with_the_next_number() {
        let sim = Sim::new();
        let pool = pool(&sim);
        sim.fail_next("start");
        assert!(pool.refill(1).await.is_err());
        assert_eq!(pool.refill(1).await.unwrap(), Some(1), "not slot 0 again");
    }

    // 7. The refill.

    /// The refill builds one slot at a time up to the target and stops there; a dead idle slot is
    /// replaced.
    #[tokio::test]
    async fn the_refill_builds_one_idle_slot_at_a_time_up_to_the_target() {
        let sim = Sim::new();
        let pool = pool(&sim);
        assert_eq!(pool.refill(2).await.unwrap(), Some(0));
        assert_eq!(pool.snapshot().idle, 1);
        assert_eq!(pool.refill(2).await.unwrap(), Some(1));
        assert_eq!(pool.refill(2).await.unwrap(), None);
        assert_eq!(
            pool.snapshot(),
            Snapshot {
                idle: 2,
                spawning: 0,
                held: 0
            }
        );
        // An idle slot whose supervisor ended is dropped, and a new one built in its place.
        sim.exit(0);
        assert_eq!(pool.refill(2).await.unwrap(), Some(0));
        assert_eq!(pool.snapshot().idle, 2);
        // The idle limits go on at every build: they take back what the last incarnation set.
        assert_eq!(sim.properties(0), crate::units::limits::idle());
        // One that failed is dropped too, and its number is the last one built again: a unit that
        // failed may hold a process that refuses every start.
        sim.die(1);
        assert_eq!(pool.refill(2).await.unwrap(), Some(2));
        assert_eq!(pool.snapshot().idle, 2);
    }

    // 8. Fence and maintenance.

    /// The idle slots stop and the bound ones stay.
    #[tokio::test]
    async fn draining_the_idle_slots_leaves_the_bound_ones() {
        let (sim, data) = (Sim::new(), data_directory("drain"));
        let pool = pool(&sim);
        pool.refill(2).await.unwrap();
        pool.refill(2).await.unwrap();
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(pool.drain_idle().await, 1);
        assert_eq!(
            pool.snapshot(),
            Snapshot {
                idle: 0,
                spawning: 0,
                held: 1
            }
        );
        assert_eq!(sim.active(bound.slot), ActiveState::Active);
    }

    // 3. A crash at each step.

    /// What the agent finds after a restart is read from the kernel's facts alone, and each step
    /// of a start where the agent may have stopped is one class (the table of the design).
    #[tokio::test]
    async fn an_agent_that_restarts_finds_each_slot_in_its_class_from_the_kernels_facts() {
        // The agent stopped with a slot taken and its limits set: an idle slot, reused. The limits
        // are the idle ones again.
        let (sim, data) = (Sim::new(), data_directory("adopt-idle"));
        let first = pool(&sim);
        first.refill(1).await.unwrap();
        sim.state().units.get_mut(&0).unwrap().properties = vec![Property::MemoryMax(256 << 20)];
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert_eq!(adopted.idle, [0]);
        assert_eq!(
            second.snapshot(),
            Snapshot {
                idle: 1,
                spawning: 0,
                held: 0
            }
        );
        assert_eq!(sim.properties(0), crate::units::limits::idle());
        let hit = second.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(hit.from, SlotFrom::Pool);

        // The mounts are in and the order was not sent: tainted, stopped, and the database stays
        // asleep: it binds again.
        let (sim, data) = (Sim::new(), data_directory("adopt-tainted"));
        let first = pool(&sim);
        first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert_eq!(adopted.tainted, [(0, D1.to_string())]);
        assert!(adopted.idle.is_empty());
        assert_eq!(sim.active(0), ActiveState::Inactive);
        assert_eq!(second.snapshot(), Snapshot::default());
        assert_eq!(
            second.state(D1).await.unwrap(),
            None,
            "the database holds nothing: it is asleep with its proof"
        );
        second.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();

        // The order was acknowledged and PostgreSQL is not ready: starting, and waited for.
        let (sim, data) = (Sim::new(), data_directory("adopt-starting"));
        let first = pool(&sim);
        let bound = first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        sim.order(bound.slot, D1).await.unwrap();
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert_eq!(adopted.starting, [D1]);
        let holder = second.holder(slot_uid(bound.slot)).unwrap();
        assert_eq!(holder.database, D1, "the archiver may already call");
        let started = second.wait_started(D1).await.unwrap();
        assert_eq!(started.uid, slot_uid(bound.slot));
        assert_eq!(started.invocation_id, bound.invocation_id);
        assert_eq!(second.volume_of(D1), Some(volume(D1, 1)));

        // The supervisor refused the order, or its exec failed: the unit is over and the
        // database is unchanged.
        let (sim, data) = (Sim::new(), data_directory("adopt-refused"));
        let first = pool(&sim);
        let bound = first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        sim.stop(bound.slot).await.unwrap();
        let second = pool(&sim);
        assert_eq!(second.adopt().await.unwrap(), Adopted::default());
        assert_eq!(second.snapshot(), Snapshot::default());
        second.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();

        // PostgreSQL is ready and was not yet released: serving, adopted as running.
        let (sim, data) = (Sim::new(), data_directory("adopt-serving"));
        let first = pool(&sim);
        let bound = first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        first.exec(&bound).await.unwrap();
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert_eq!(adopted.serving, [D1]);
        let unit = second.state(D1).await.unwrap().unwrap();
        assert_eq!(unit.active, ActiveState::Active);
        assert_eq!(unit.uid, Some(slot_uid(bound.slot)));
        assert_eq!(unit.slot, Some(bound.slot));
        assert!(matches!(
            second.bind(D1, &bind_of(D1, 1, &data)).await,
            Err(Error::Held)
        ));

        // The agent stopped in the middle of a stop: it waits for the unit to be over, and the
        // database is then decided by its control file, which is the agent's to read.
        let (sim, data) = (Sim::new(), data_directory("adopt-stopping"));
        let first = pool(&sim);
        let bound = first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        first.exec(&bound).await.unwrap();
        sim.state().units.get_mut(&bound.slot).unwrap().active = ActiveState::Deactivating;
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert!(adopted.serving.is_empty() && adopted.idle.is_empty());
        assert_eq!(sim.active(bound.slot), ActiveState::Inactive);
        assert_eq!(second.snapshot(), Snapshot::default());
        assert_eq!(second.state(D1).await.unwrap(), None);
    }

    /// A slot that is not what it should be is not kept: a supervisor of another protocol, a
    /// PostgreSQL without the lock on its data directory (the second witness of the one writer),
    /// and a process that is neither.
    #[tokio::test]
    async fn an_idle_slot_of_another_protocol_and_a_postmaster_without_the_lock_are_stopped() {
        let (sim, data) = (Sim::new(), data_directory("adopt-wrong"));
        let first = pool(&sim);
        first.refill(1).await.unwrap();
        sim.fail_next("ping");
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert!(adopted.idle.is_empty());
        assert_eq!(sim.active(0), ActiveState::Inactive);

        let (sim, data2) = (Sim::new(), data_directory("adopt-unlocked"));
        let first = pool(&sim);
        let bound = first.bind(D1, &bind_of(D1, 1, &data2)).await.unwrap();
        first.exec(&bound).await.unwrap();
        sim.state().locks.clear();
        let second = pool(&sim);
        let adopted = second.adopt().await.unwrap();
        assert_eq!(adopted.tainted, [(bound.slot, D1.to_string())]);
        assert!(adopted.serving.is_empty());
        assert_eq!(sim.active(bound.slot), ActiveState::Inactive);
        let _ = data;
    }

    /// A mount at a database's directory that the agent cannot name as a volume of that database
    /// (the `lvs` listing failed, or the device is none of the database's) is held all the same:
    /// the slot that has one is stopped, whether its supervisor still answers a ping or its
    /// postmaster holds the lock, and never kept idle. Kept idle, it would take the next database
    /// beside a tenant's volume mapped to the same slot uid (D13: unknown means tainted).
    #[tokio::test]
    async fn a_slot_with_a_mount_the_agent_cannot_name_is_stopped_not_kept() {
        for serving in [false, true] {
            let (sim, data) = (Sim::new(), data_directory("adopt-unnamed"));
            let first = pool(&sim);
            if serving {
                let bound = first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
                first.exec(&bound).await.unwrap();
            } else {
                // The agent was killed between the mount and the order: the supervisor still
                // answers its ping, because it never got an order.
                first.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
            }
            sim.state().units.get_mut(&0).unwrap().mounted = Some((D1.to_string(), None));
            let second = pool(&sim);
            let adopted = second.adopt().await.unwrap();
            assert!(
                adopted.idle.is_empty()
                    && adopted.serving.is_empty()
                    && adopted.starting.is_empty(),
                "serving {serving}: {adopted:?}"
            );
            assert_eq!(adopted.tainted, [(0, D1.to_string())], "serving {serving}");
            assert_eq!(sim.active(0), ActiveState::Inactive, "serving {serving}");
            assert_eq!(second.snapshot(), Snapshot::default());
            // The database stays asleep with its proof, and the next bind never meets the mount.
            let next = second.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
            assert!(sim.unit_of(next.slot).unwrap().mounted.is_some());
        }
    }

    /// A postmaster that dies on its own leaves its slot to be reaped: the database is held until
    /// systemd reports the unit over, and then it binds again.
    #[tokio::test]
    async fn a_postmaster_that_dies_frees_its_database_only_when_its_unit_is_over() {
        let (sim, data) = (Sim::new(), data_directory("dies"));
        let pool = pool(&sim);
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        pool.exec(&bound).await.unwrap();
        sim.die(bound.slot);
        let unit = pool.state(D1).await.unwrap().unwrap();
        assert!(!unit.active.awake(), "{unit:?}");
        // The unit is failed: it is over, so the next bind reaps it and takes a slot, and not the
        // number of the unit that failed: it may hold a process that refuses every start.
        let again = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(again.database, D1);
        assert_ne!(again.slot, bound.slot);
    }

    /// `wait_started` is a wait for the PostgreSQL that is coming up, and an error for one that
    /// is not.
    #[tokio::test]
    async fn waiting_for_a_database_that_no_slot_holds_is_an_error() {
        let (sim, data) = (Sim::new(), data_directory("wait"));
        let pool = pool(&sim);
        assert!(matches!(
            pool.wait_started(D1).await,
            Err(Error::NotReady("unit_not_active"))
        ));
        // A slot that is bound and was not ordered has no PostgreSQL to wait for.
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert!(pool.wait_started(D1).await.is_err());
        pool.exec(&bound).await.unwrap();
        assert_eq!(
            pool.wait_started(D1).await.unwrap().invocation_id,
            bound.invocation_id
        );
    }

    /// The report of a start carries every step, and a hit differs from a miss in the slot step
    /// alone.
    #[tokio::test]
    async fn a_start_reports_where_its_slot_came_from_and_what_each_step_took() {
        let (sim, data) = (Sim::new(), data_directory("report"));
        let pool = pool(&sim);
        pool.refill(1).await.unwrap();
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        let started = pool.exec(&bound).await.unwrap();
        let report = started.slot.unwrap();
        assert_eq!((report.slot, report.from), (0, SlotFrom::Pool));
        assert_eq!(
            started.requested_us,
            Some(2),
            "the order, not the unit's start"
        );
        assert_eq!(started.uid, slot_uid(0));
        assert!(started.socket.ends_with(".s.PGSQL.5432"));
        assert_eq!(SlotFrom::Pool.word(), "pool");
        assert_eq!(SlotFrom::Demand.word(), "demand");
    }

    /// The fork of the supervisor and the executor's handoff are part of a wake's timeline only
    /// when the slot was built inside it; the three messages of PostgreSQL's start are counted from
    /// the order, which the journal of a machine without one cannot give.
    #[tokio::test]
    async fn a_timeline_has_the_slots_fork_and_handoff_only_for_a_slot_built_on_demand() {
        let (sim, data) = (Sim::new(), data_directory("timeline"));
        let pool = pool(&sim);
        let miss = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        let started = pool.exec(&miss).await.unwrap();
        let timeline = pool.timeline(D1, &started).await.unwrap();
        // Sim's unit was asked to start at 1, forked at 100 and handed over at 160 (microseconds).
        assert_eq!(timeline.job_to_fork_us, Some(99));
        assert_eq!(timeline.fork_to_handoff_us, Some(60));
        assert!(timeline.startup.is_none(), "no journal here");
        assert!(pool.stop(D1).await.unwrap());

        pool.refill(1).await.unwrap();
        let hit = pool.bind(D2, &bind_of(D2, 1, &data)).await.unwrap();
        assert_eq!(hit.from, SlotFrom::Pool);
        let started = pool.exec(&hit).await.unwrap();
        let timeline = pool.timeline(D2, &started).await.unwrap();
        assert_eq!(
            (timeline.job_to_fork_us, timeline.fork_to_handoff_us),
            (None, None)
        );
        // A start that is another invocation's has no timeline: the slot started again since.
        let other = Started {
            invocation_id: "00000000-0000-4000-8000-0000000000ff".into(),
            ..started
        };
        assert_eq!(
            pool.timeline(D2, &other).await.unwrap(),
            crate::units::Timeline::default()
        );
    }

    // The archive socket's holder.

    /// A slot's uid maps to its database from the bind to the end of the stop, and to nobody
    /// before and after.
    #[tokio::test]
    async fn a_slots_uid_maps_to_its_database_while_it_holds_one() {
        let (sim, data) = (Sim::new(), data_directory("holder"));
        let pool = pool(&sim);
        pool.refill(1).await.unwrap();
        assert_eq!(pool.holder(slot_uid(0)), None, "idle");
        let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        let holder = pool.holder(slot_uid(0)).unwrap();
        assert_eq!(holder.database, D1);
        assert_eq!(holder.cgroup, "/pgcf.slice/pgcf-slot@0.service");
        assert_eq!(holder.invocation_id, bound.invocation_id);
        pool.exec(&bound).await.unwrap();
        assert!(pool.holder(slot_uid(0)).is_some());
        assert_eq!(pool.holder(100_000), None, "no slot's uid");
        assert_eq!(pool.holder(slot_uid(5)), None, "a slot that holds nothing");
        assert!(pool.stop(D1).await.unwrap());
        assert_eq!(pool.holder(slot_uid(0)), None);
    }

    /// A call from another cgroup or invocation than the holder's is not the holder's.
    #[test]
    fn a_caller_is_the_holder_only_from_its_cgroup_and_its_invocation() {
        let holder = Holder {
            database: D1.into(),
            cgroup: slot_cgroup(7),
            invocation_id: "00000000-0000-4000-8000-000000000001".into(),
        };
        let (cgroup, invocation) = (
            slot_cgroup(7),
            "00000000-0000-4000-8000-000000000001".to_string(),
        );
        assert!(is_holder(&holder, Some(&cgroup), Some(&invocation)));
        assert!(!is_holder(
            &holder,
            Some(&slot_cgroup(8)),
            Some(&invocation)
        ));
        assert!(!is_holder(
            &holder,
            Some("/user.slice/session-1.scope"),
            Some(&invocation)
        ));
        assert!(!is_holder(
            &holder,
            Some(&cgroup),
            Some("00000000-0000-4000-8000-000000000002")
        ));
        assert!(!is_holder(&holder, Some(&cgroup), None));
        assert!(!is_holder(&holder, None, Some(&invocation)));
    }

    #[test]
    fn the_names_of_a_slot_round_trip_and_stay_clear_of_the_databases() {
        assert_eq!(slot_unit(12), "pgcf-slot@12.service");
        assert_eq!(slot_of("pgcf-slot@12.service"), Some(12));
        assert_eq!(slot_of("pgcf-slot@1023.service"), Some(1023));
        for other in [
            "pgcf-slot@1024.service",
            "pgcf-slot@012.service",
            "pgcf-slot@-1.service",
            "pgcf-slot@.service",
            "pgcf-slot@check.service",
            "pgcf-pg@12.service",
            "pgcf-slot@12.timer",
        ] {
            assert_eq!(slot_of(other), None, "{other}");
        }
        assert_eq!(slot_uid(0), 300_000);
        assert_eq!(slot_of_uid(300_007), Some(7));
        assert_eq!(slot_of_uid(299_999), None);
        assert_eq!(slot_of_uid(300_000 + SLOT_COUNT), None);
        assert_eq!(slot_account(7), "pgcf-slot-7");
        assert_eq!(slot_cgroup(7), "/pgcf.slice/pgcf-slot@7.service");
        assert!(POOL.end <= CHECK_SLOT && !POOL.contains(&CHECK_SLOT));
    }
}
