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
//!    it: its limits as runtime properties and its two mounts, in parallel;
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
//! table, which refuses a bind while any slot holds the database in any state, whichever
//! generation of its volume it has, until the slot has reached `inactive`; and, in the kernel, the
//! supervisor's `flock` of the data directory (a lock belongs to one inode, so two generations
//! need the table). The agent also tries the lock before every bind ([`data_lock_free`]).
//! PostgreSQL's own guard cannot be the only one once two slots with two users see the directory
//! as their own: `miscinit.c` takes `EPERM` of `kill(pid, 0)` on the `postmaster.pid` for a stale
//! file, and `sysv_shmem.c` takes `EACCES` on the old segment for a foreign one.
//!
//! **A restart of the agent loses nothing.** The table is never written to disk. [`Pool::adopt`]
//! reads it back from kernel facts only: the unit list, each unit's main process, its
//! `/proc/<pid>/exe`, its mount table and `/proc/locks`.
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
    uid.checked_sub(SLOT_FIRST_UID).filter(|slot| *slot < SLOT_COUNT)
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
    pub spawning: usize,
    /// Slots that hold a database, from the bind to the end of its stop.
    pub held: usize,
}

/// What a start of a slot cost, for the journal event and the wake's detail.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Spawn {
    /// When the agent asked systemd to start the unit (`CLOCK_MONOTONIC`).
    pub requested_us: Option<u64>,
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
    /// The databases whose volume is mounted in the process's mount namespace, with the volume.
    pub databases: Vec<(String, VolumeId)>,
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
    /// Whether the database's unit of its own (`pgcf-pg@`) is awake.
    fn legacy_awake(&self, database: &str) -> impl Future<Output = Result<bool, Error>> + Send;
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
    /// Being built.
    Spawning,
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
            Self::Stopping(database) => database.as_deref(),
            Self::Spawning | Self::Idle => None,
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
    /// The numbers whose user exists.
    users: BTreeSet<u32>,
}
impl Table {
    fn holding(&self, database: &str) -> Vec<u32> {
        self.slots
            .iter()
            .filter(|(_, slot)| slot.state.database() == Some(database))
            .map(|(number, _)| *number)
            .collect()
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
        Self {
            host,
            range,
            table: Mutex::new(Table::default()),
        }
    }
    pub fn host(&self) -> &H {
        &self.host
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
            spawning: count(|state| *state == State::Spawning),
            held: count(|state| state.database().is_some()),
        }
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
            self.host.legacy_awake(database),
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
        crate::timing::emit_event(json!({
            "event": "slot_bound", "database_id": database, "slot": slot,
            "invocation": invocation_id, "slot_from": from.word(),
        }));
        Ok(Bound {
            slot,
            database: database.to_string(),
            uid: slot_uid(slot),
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
        let (pid, volume) = {
            let table = self.table();
            let held = table
                .slots
                .get(&bound.slot)
                .filter(|held| {
                    held.state == State::Taken(bound.database.clone())
                        && held.invocation_id.as_deref() == Some(bound.invocation_id.as_str())
                })
                .ok_or(Error::Unexpected("the slot is not bound to this start"))?;
            (
                held.main_pid
                    .ok_or(Error::Unexpected("a slot without a process"))?,
                held.volume.clone(),
            )
        };
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
        self.set_state(bound.slot, State::Starting(bound.database.clone()));
        let starting = Instant::now();
        let socket = match self
            .host
            .ready(bound.slot, &bound.database, pid)
            .await
        {
            Ok(socket) => socket,
            Err(error) => {
                self.abort(bound.slot).await;
                return Err(error);
            }
        };
        self.set_state(bound.slot, State::Serving(bound.database.clone()));
        let _ = volume;
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
            uid: slot_uid(slot),
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
        if self.host.unit(slot).await?.ended() {
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
        Ok(Some(unit_state(database, slot, &held, &unit)))
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
            Ok::<_, Error>(unit_state(database, *slot, held, &unit))
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
    /// must not take it from a wake.
    pub async fn refill(&self, target: usize) -> Result<Option<u32>, Error> {
        self.sweep().await;
        let counted = self.snapshot();
        if counted.idle + counted.spawning >= target {
            return Ok(None);
        }
        let slot = self.reserve()?;
        let spawned = self.build(slot).await?;
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
        self.table().users = self.host.users();
        let units = self.host.units().await?;
        let mut adopted = Adopted::default();
        let mut stopping = Vec::new();
        for unit in units
            .into_iter()
            .filter(|unit| self.range.contains(&unit.slot) && !unit.ended())
        {
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
            crate::timing::emit_event(json!({
                "event": "slot_ended", "database_id": database, "slot": slot, "reason": reason,
            }));
        }
    }

    /// A slot that held the database and whose unit is over is gone; one whose unit is not over
    /// keeps the database held.
    async fn release_ended(&self, database: &str) -> Result<(), Error> {
        let held = self.table().holding(database);
        for slot in held {
            if !self.host.unit(slot).await?.ended() {
                return Err(Error::Held);
            }
            self.forget(slot, database, "ended");
        }
        Ok(())
    }

    /// The lowest free number of the pool's range, entered as being built.
    fn reserve(&self) -> Result<u32, Error> {
        let mut table = self.table();
        let slot = self
            .range
            .clone()
            .find(|slot| !table.slots.contains_key(slot))
            .ok_or(Error::NoSlot)?;
        table.slots.insert(
            slot,
            Slot {
                state: State::Spawning,
                main_pid: None,
                invocation_id: None,
                requested_us: None,
                volume: None,
            },
        );
        Ok(slot)
    }

    /// Makes the slot's user if it has none, sets the idle limits, starts the unit and asks the
    /// supervisor whether it is idle. A failure stops the unit and drops the entry.
    async fn build(&self, slot: u32) -> Result<Spawned, Error> {
        let built = async {
            if !self.table().users.contains(&slot) {
                self.host.ensure_user(slot).await?;
                self.table().users.insert(slot);
            }
            self.host.set(slot, &super::limits::idle()).await?;
            let spawned = self.host.start(slot).await?;
            self.host.ping(slot).await?;
            Ok::<_, Error>(spawned)
        }
        .await;
        match built {
            Ok(spawned) => {
                if let Some(held) = self.table().slots.get_mut(&slot) {
                    held.main_pid = Some(spawned.main_pid);
                    held.invocation_id = Some(spawned.invocation_id.clone());
                    held.requested_us = spawned.requested_us;
                }
                Ok(spawned)
            }
            Err(error) => {
                let _ = self.host.stop(slot).await;
                self.table().slots.remove(&slot);
                Err(error)
            }
        }
    }

    /// An idle slot for the database, or a new one built inside the bind.
    async fn take(&self, database: &str, volume: &VolumeId) -> Result<(u32, SlotFrom), Error> {
        loop {
            let idle = {
                let mut table = self.table();
                let idle = table
                    .slots
                    .iter()
                    .find(|(_, held)| held.state == State::Idle)
                    .map(|(slot, _)| *slot);
                if let Some(held) = idle.and_then(|slot| table.slots.get_mut(&slot)) {
                    held.state = State::Taken(database.to_string());
                    held.volume = Some(volume.clone());
                }
                idle
            };
            match idle {
                Some(slot) if self.host.alive(slot) => return Ok((slot, SlotFrom::Pool)),
                // The supervisor ended while it waited: the slot is no use.
                Some(slot) => {
                    self.set_state(slot, State::Stopping(None));
                    self.finish_stop(slot).await;
                }
                None => break,
            }
        }
        let slot = self.reserve()?;
        let spawned = self.build(slot).await?;
        crate::timing::emit_event(json!({
            "event": "slot_spawned", "slot": slot, "invocation": spawned.invocation_id,
            "cause": "demand",
        }));
        if let Some(held) = self.table().slots.get_mut(&slot) {
            held.state = State::Taken(database.to_string());
            held.volume = Some(volume.clone());
        }
        Ok((slot, SlotFrom::Demand))
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
            crate::timing::emit_event(json!({
                "event": "slot_ended", "database_id": database, "slot": slot,
                "reason": "aborted",
            }));
        }
    }

    /// Stops a slot that is marked `Stopping` and drops it once its unit is over; whether it is.
    async fn finish_stop(&self, slot: u32) -> bool {
        let stopped = self.host.stop(slot).await;
        let over = match stopped {
            Ok(()) => self.host.unit(slot).await.is_ok_and(|unit| unit.ended()),
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
        let held = facts.databases.first().cloned();
        let database = held.as_ref().map(|(database, _)| database.clone());
        Ok(match (unit.active, facts.exe) {
            (ActiveState::Active, Exe::Supervisor) if facts.databases.is_empty() => {
                match self.host.ping(unit.slot).await {
                    Ok(()) => Class::Idle,
                    // Another protocol, or a supervisor that does not answer: built again.
                    Err(_) => Class::Stop {
                        database: None,
                        tainted: false,
                    },
                }
            }
            // The mounts are in and the order was not sent: the database never ran.
            (_, Exe::Supervisor) => Class::Stop {
                tainted: database.is_some(),
                database,
            },
            (ActiveState::Deactivating, _) => Class::Stop {
                database,
                tainted: false,
            },
            (ActiveState::Active | ActiveState::Activating, Exe::Postgres)
                if facts.databases.len() == 1 && facts.locked =>
            {
                let (database, volume) = facts.databases[0].clone();
                match facts.postmaster {
                    Some(ready::Status::Ready) => Class::Serving(database, volume),
                    Some(ready::Status::Starting) => Class::Starting(database, volume),
                    _ => Class::Stop {
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
fn unit_state(database: &str, slot: u32, held: &Slot, unit: &SlotUnit) -> UnitState {
    let active = match (&held.state, unit.active) {
        (State::Taken(_) | State::Starting(_), ActiveState::Active) => ActiveState::Activating,
        (State::Stopping(_), ActiveState::Active) => ActiveState::Deactivating,
        (_, active) => active,
    };
    UnitState {
        database: database.to_string(),
        active,
        main_pid: unit.main_pid,
        invocation_id: unit.invocation_id.clone(),
        uid: Some(slot_uid(slot)),
        memory_max_bytes: unit.memory_max_bytes,
        slot: Some(slot),
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
    }
    #[derive(Clone)]
    struct SimUnit {
        active: ActiveState,
        pid: Option<u32>,
        invocation: String,
        exe: Exe,
        mounted: Option<(String, VolumeId)>,
        status: Option<ready::Status>,
        memory_max: Option<u64>,
        properties: Vec<Property>,
    }
    impl Sim {
        fn new() -> Self {
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
            self.unit_of(slot).map(|unit| unit.properties).unwrap_or_default()
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
            if self.failing("start") {
                return Err(refused("start"));
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
                unit.active = ActiveState::Inactive;
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
        async fn mount(&self, slot: u32, bind: &Bind) -> Result<(), Error> {
            if self.failing("mount") {
                return Err(refused("mount"));
            }
            let mut state = self.state();
            state.calls.push(format!("mount {slot}"));
            let database = bind.volume.database().to_string();
            if let Some(unit) = state.units.get_mut(&slot) {
                unit.mounted = Some((database, bind.volume.clone()));
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
            Ok(Ordered {
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
        async fn legacy_awake(&self, database: &str) -> Result<bool, Error> {
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
            pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap_err().to_string(),
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
        assert!(sim.calls().is_empty(), "nothing was taken: {:?}", sim.calls());
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
            assert!(pool.bind(D1, &bind_of(D1, 1, &data)).await.is_err(), "{failing}");
            assert!(
                !sim.calls().iter().any(|call| call.starts_with("order")),
                "{failing}: {:?}",
                sim.calls()
            );
            assert!(sim.calls().iter().any(|call| call.starts_with("stop")), "{failing}");
            assert_eq!(pool.slot_of(D1), None);
            assert_eq!(pool.snapshot(), Snapshot::default(), "{failing}");
            assert!(pool.holder(slot_uid(0)).is_none());
            // The database was not started: the next bind and start go through.
            let bound = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
            pool.exec(&bound).await.unwrap();
        }
    }

    // 6. A miss builds inside the bind.

    /// A bind with no idle slot builds one and says so; with an idle slot it builds none, and the
    /// user of a slot is made at the refill, not in the bind.
    #[tokio::test]
    async fn a_pool_miss_builds_the_slot_inside_the_bind_and_a_hit_builds_none() {
        let (sim, data) = (Sim::new(), data_directory("miss"));
        let pool = pool(&sim);
        // A miss on a pool that never built a slot: the user and the unit, then the bind.
        let miss = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(miss.from, SlotFrom::Demand);
        assert_eq!(
            sim.calls(),
            ["user 0", "set 0", "start 0", "ping 0", "set 0", "mount 0"]
        );
        // The refill built one beforehand, users included; a hit only binds.
        assert_eq!(pool.refill(1).await.unwrap(), Some(1));
        sim.clear();
        let hit = pool.bind(D2, &bind_of(D2, 1, &data)).await.unwrap();
        assert_eq!(hit.from, SlotFrom::Pool);
        assert_eq!(hit.slot, 1);
        assert_eq!(sim.calls(), ["set 1", "mount 1"]);
        // A miss on a slot whose user is there does not make it again.
        sim.clear();
        let again = pool.bind("cdefghijkl2345678901", &bind_of("cdefghijkl2345678901", 1, &data)).await.unwrap();
        assert_eq!(again.from, SlotFrom::Demand);
        assert_eq!(again.slot, 2, "the lowest free number");
        assert_eq!(
            sim.calls(),
            ["user 2", "set 2", "start 2", "ping 2", "set 2", "mount 2"]
        );
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
        assert_eq!(pool.snapshot(), Snapshot { idle: 2, spawning: 0, held: 0 });
        // An idle slot whose supervisor ended is dropped, and a new one built in its place.
        sim.die(0);
        assert_eq!(pool.refill(2).await.unwrap(), Some(0));
        assert_eq!(pool.snapshot().idle, 2);
        // The idle limits go on at every build: they take back what the last incarnation set.
        assert_eq!(sim.properties(0), crate::units::limits::idle());
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
        assert_eq!(pool.snapshot(), Snapshot { idle: 0, spawning: 0, held: 1 });
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
        assert_eq!(second.snapshot(), Snapshot { idle: 1, spawning: 0, held: 0 });
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
        // The unit is failed: it is over, so the next bind reaps it and takes a slot.
        let again = pool.bind(D1, &bind_of(D1, 1, &data)).await.unwrap();
        assert_eq!(again.database, D1);
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
        assert_eq!(pool.wait_started(D1).await.unwrap().invocation_id, bound.invocation_id);
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
        assert_eq!(started.requested_us, Some(2), "the order, not the unit's start");
        assert_eq!(started.uid, slot_uid(0));
        assert!(started.socket.ends_with(".s.PGSQL.5432"));
        assert_eq!(SlotFrom::Pool.word(), "pool");
        assert_eq!(SlotFrom::Demand.word(), "demand");
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
        assert!(!is_holder(&holder, Some(&slot_cgroup(8)), Some(&invocation)));
        assert!(!is_holder(&holder, Some("/user.slice/session-1.scope"), Some(&invocation)));
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
