// SPDX-License-Identifier: Apache-2.0
//! The machine of the agent's tests: real PostgreSQL 18 postmasters started as the image's unit
//! starts them and signalled as systemd signals them, in directories that stand for the thin
//! volumes. Only systemd, LVM and the users are stood in for; their own behaviour is proved in the
//! lab (`units::lab`, `storage::lab_tests`) and on a node.
use super::{Account, Boot, CpuTimes, Machine, Memory, Throttle, initdb_arguments};
use crate::{
    diagnostics::probe,
    layout::Layout,
    link::NodeIdentity,
    storage::{
        self, FsUsage, Inventory, MountInfo, NoRoom, PoolMode, PoolSample, Removal, VolumeId,
        VolumeInfo,
    },
    testpg,
    units::{
        self, ActiveState, Started, Timeline, UnitState,
        limits::{Limits, Property, cpu_quota},
        ready,
        slots::{
            self, Adopted, Bind, Bound, Exe, Facts, Host, Ordered, Pool, SlotUnit, Snapshot,
            Spawned,
        },
    },
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs, io,
    num::NonZeroU32,
    ops::Deref,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// A database's unit of its own (`pgcf-pg@`), which an agent of an earlier release started and
/// the agent finds running: PostgreSQL started as that unit started it, in the directories that
/// stand for the thin volumes. Nothing starts one but a test (`Local::start_legacy`).
struct Unit {
    child: Option<Child>,
    /// The postmaster ended without being asked to: a crash.
    crashed: bool,
    invocations: u64,
    invocation_id: Option<String>,
    /// The volume the unit mounted when it started, from the agent's link: what it runs on until
    /// it stops, whatever the agent has attached since.
    volume: Option<VolumeId>,
    /// systemd has the unit's start job open: the unit is `activating`, as a `Type=notify` unit is
    /// until its postmaster says it is ready (`READY=1`, which `postmaster.pid`'s status line
    /// precedes). The instant is the earliest the job may end (`delay_next_start`).
    activating: Option<Instant>,
}

/// A slot of the test machine (`pgcf-slot@<n>`): a placeholder process for the supervisor until
/// the order, PostgreSQL after it, started as the supervisor starts it.
struct Slot {
    /// The supervisor, a `sleep`, until the order; PostgreSQL after it.
    child: Option<Child>,
    /// The process ended on its own after the order: a crash.
    crashed: bool,
    invocations: u64,
    invocation_id: Option<String>,
    /// The database whose volume and socket directory the handoff moved in, and the volume.
    mounted: Option<(String, VolumeId)>,
    properties: Vec<Property>,
    /// The order was given: the process is PostgreSQL.
    postgres: bool,
    /// The supervisor's `flock` of the data directory, which PostgreSQL inherits.
    lock: Option<fs::File>,
}
impl Slot {
    fn new() -> Self {
        Self {
            child: None,
            crashed: false,
            invocations: 0,
            invocation_id: None,
            mounted: None,
            properties: Vec::new(),
            postgres: false,
            lock: None,
        }
    }
    /// Whether the slot's process lives; one that ended on its own is a crash.
    fn alive(&mut self) -> bool {
        let ended = self
            .child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_some());
        if ended {
            self.child = None;
            self.crashed = true;
            self.lock = None;
        }
        self.child.is_some()
    }
}

#[derive(Default)]
struct State {
    /// The units of their own that run on the machine: only what a test started.
    legacy: HashMap<String, Unit>,
    slots: BTreeMap<u32, Slot>,
    volumes: BTreeMap<VolumeId, u64>,
    /// The volumes the agent has mounted in its mount namespace, each with its link for the
    /// database's unit: what the agent's restart ends. A unit that runs keeps its own mount.
    attached: BTreeSet<VolumeId>,
    /// The volumes that a job (`MountImages=`) holds, in a namespace of its own, until it ends:
    /// `hold_volume` and `release_volume`.
    jobs: BTreeSet<VolumeId>,
    accounts: Vec<String>,
    /// The slot numbers whose user exists. A node that has run for a while has them all; the
    /// process of the health check starts with none, and its refill makes the one it needs.
    slot_users: BTreeSet<u32>,
    /// The slot numbers whose unit refuses to start, as one does with a process left in its
    /// cgroup (`StrayProcesses`).
    stray_slots: BTreeSet<u32>,
    quotas: HashMap<String, Option<NonZeroU32>>,
    /// Every `set_cpu_quota` the agent made, in order: (database, quota). A stop lifts a quota
    /// without a call, as systemd's does.
    quota_calls: Vec<(String, Option<NonZeroU32>)>,
    /// Calls the tests assert on, in order: `start <id>`, `stop <id>`, `trim <id>`, `remove <id>`.
    calls: Vec<String>,
    no_room: bool,
    available_bytes: u64,
    cpu_calls: u64,
    slice_memory_mib: Option<u64>,
    /// `create_volume` fails once with this.
    volume_error: Option<storage::Error>,
    /// The order to execute PostgreSQL fails once: the supervisor's exec does not happen.
    start_fails: bool,
    /// The handoff of the next bind fails once.
    handoff_fails: bool,
    /// The order fails once after PostgreSQL is up, as the real one can (EU1, 2026-10-20): the
    /// slot runs on.
    start_fails_after_up: bool,
    /// `reboot` fails once, and the node keeps running.
    reboot_fails: bool,
    /// `purge_packages` fails once, as dpkg does for a package that others depend on.
    purge_fails: bool,
    /// How long the next start takes before the postmaster begins.
    start_delay: Option<Duration>,
    /// LVM, or systemd, cannot be read: what they hold is not known.
    volumes_unreadable: bool,
    /// The next this many questions of `has_volume`, or of `unit`, fail as an unreadable LVM or
    /// systemd does, and the questions asked: what a reconciliation that retries costs.
    volume_reads_fail: u32,
    unit_reads_fail: u32,
    volume_reads: u64,
    unit_reads: u64,
    /// The databases whose unit reads wait for `release_unit_reads`: a systemd that is slow to
    /// answer about them.
    held_units: BTreeSet<String>,
    /// The next this many waits for a unit to be ready cannot read it, as a bus does that refuses
    /// the call (`LimitsExceeded`).
    wait_reads_fail: u32,
    /// Every volume must be repaired before its database starts again.
    needs_repair: bool,
    units_unreadable: bool,
    /// The `archive_command` of a database, where it is not the layout's.
    archive_commands: HashMap<String, String>,
    /// Every database archives straight into its upload log.
    direct_archive: bool,
    /// The credentials applied: region, node, revision, restart.
    credentials: Vec<(String, String, u64, bool)>,
    /// The Debian packages of the node, as dpkg would list them.
    packages: BTreeMap<String, String>,
    /// How often the node booted since the test began, and the kernel it runs: a boot starts the
    /// installed kernel image of the highest version.
    boots: u64,
    kernel_release: String,
    /// The thin pool is gone: `lvs` cannot find it.
    pool_lost: bool,
    /// A journal file is damaged: `journalctl` prints the entries it read, then fails.
    journal_damaged: bool,
    /// What systemd has loaded of each unit file, as of its last reload (or of the boot): the
    /// definition (`None` for a mask) that the next start of the unit takes.
    loaded: BTreeMap<String, Option<Vec<u8>>>,
    /// The definition each unit runs with: that of its last restart.
    running: BTreeMap<String, Vec<u8>>,
    /// `daemon_reload` fails once.
    reload_fails: bool,
    /// `restart_service` fails once, as a job that ends with `failed`.
    restart_fails: bool,
    /// `restart_service` fails for this unit every time, as a unit that cannot start.
    restart_fails_for: BTreeSet<String>,
    /// The users `systemd-sysusers` made, and the directories (with their mode) `systemd-tmpfiles`
    /// made.
    users: BTreeSet<String>,
    directories: BTreeMap<String, String>,
    /// The next `run_sysusers` or `run_tmpfiles` fails, as the tools do with exit status 1.
    run_fails: bool,
}

/// The units of the image that a release restarts, as the packages and the image leave them: the
/// files `systemd` loaded at the boot. A test that changes one writes the new file below the
/// machine's root and has the release do it.
const IMAGE_UNITS: [&str; 6] = [
    "pgcf-agent.service",
    "pgcf-cloudflared.service",
    "pgcf-gateway.service",
    "ssh.service",
    "systemd-journald.service",
    "systemd-sysctl.service",
];

/// A tool of systemd that ended with exit status 1, as `run` of the node reports it.
fn tool_failed(program: &str, file: &str) -> io::Error {
    io::Error::other(format!(
        "{program} ended with exit status: 1: Failed to read '{file}'"
    ))
}

/// The parent of process `pid` as `/proc/<pid>/stat` names it, `None` for a process that is gone.
fn parent_of(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name may hold spaces and parentheses: the fields follow its last one.
    let after = stat.get(stat.rfind(')')? + 1..)?;
    after.split_whitespace().nth(1)?.parse().ok()
}

/// What a read of a unit fails with when the bus refuses the call, as dbus-daemon does past its
/// limit of calls that are not answered yet: an error reply named `LimitsExceeded`, which is what
/// `Units::state` gets from `GetUnit` (a method call's refusal is a `MethodError`).
fn bus_refused() -> units::Error {
    let name = "org.freedesktop.DBus.Error.LimitsExceeded";
    let call = zbus::message::Message::method_call("/org/freedesktop/systemd1", "GetUnit")
        .unwrap()
        .build(&())
        .unwrap();
    let reply = zbus::message::Message::error(&call.header(), name.to_string())
        .unwrap()
        .build(&())
        .unwrap();
    units::Error::Bus(zbus::Error::MethodError(
        name.try_into().unwrap(),
        Some("the maximum number of pending replies per connection has been reached".into()),
        reply,
    ))
}

/// The kernel's boot ID of the node's `boots`th boot.
fn boot_id(boots: u64) -> String {
    format!("00000000-0000-4000-8000-{boots:012x}")
}

/// What the machine and its slots' host share.
pub struct Shared {
    layout: Layout,
    user: String,
    uid: u32,
    gid: u32,
    state: Mutex<State>,
    /// `false` while the reads of `held_units` wait.
    unit_gate: tokio::sync::watch::Sender<bool>,
    /// `false` while the agent's mounts wait: a disk that answers late.
    mount_gate: tokio::sync::watch::Sender<bool>,
}

/// The test machine: the same pool of slots as a node has, over a host that starts real
/// PostgreSQL processes in place of units.
pub struct Local {
    shared: Arc<Shared>,
    pool: Pool<LocalHost>,
}
impl Deref for Local {
    type Target = Shared;
    fn deref(&self) -> &Shared {
        &self.shared
    }
}

/// systemd and the kernel of the test machine, for the pool of slots (`slots::Host`).
pub struct LocalHost(Arc<Shared>);

impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn release_shared_memory(&self, database: &str) {
        let pid_file = fs::read_to_string(self.layout.data(database).join("postmaster.pid"))
            .unwrap_or_default();
        if let Some(id) = pid_file
            .lines()
            .nth(6)
            .and_then(|line| line.split_whitespace().nth(1))
        {
            let _ = Command::new("ipcrm").args(["-m", id]).output();
        }
    }
}

impl Local {
    /// A machine of its own under a fresh short directory, or `None` where there is no
    /// PostgreSQL 18 (the tests skip).
    pub fn new(label: &str) -> Option<Self> {
        let bin = testpg::bin_directory()?;
        let root = testpg::directory(label);
        let layout = Layout {
            state: root.join("s"),
            run: root.join("r"),
            postgres_lib: testpg::lib_directory(&bin),
            postgres_bin: bin,
            host_root: root.join("h"),
            ..Layout::default()
        };
        let (uid, gid) = {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&root).unwrap();
            (metadata.uid(), metadata.gid())
        };
        // The directories of the image's units and its configuration, and its own units in them.
        for directory in crate::node_link::constant("HOST_FILE_DIRECTORIES")
            .as_array()
            .unwrap()
        {
            fs::create_dir_all(
                layout
                    .host_root
                    .join(directory.as_str().unwrap().trim_start_matches('/')),
            )
            .unwrap();
        }
        // `/run/systemd` is there at every boot; its `system` directory is made when a unit needs it.
        fs::create_dir_all(layout.host_root.join("run/systemd")).unwrap();
        for unit in IMAGE_UNITS {
            fs::write(
                layout.host_root.join("usr/lib/systemd/system").join(unit),
                format!("[Service]\n# {unit} of the image\n"),
            )
            .unwrap();
        }
        let machine = Self::wrap(Shared {
            layout,
            user: testpg::current_user(),
            uid,
            gid,
            state: Mutex::new(State {
                available_bytes: 8 << 30,
                kernel_release: "6.12.111+deb13-amd64".into(),
                slot_users: (0..slots::SLOT_COUNT).collect(),
                ..State::default()
            }),
            unit_gate: tokio::sync::watch::channel(true).0,
            mount_gate: tokio::sync::watch::channel(true).0,
        });
        machine.load_units();
        Some(machine)
    }

    fn wrap(shared: Shared) -> Self {
        Self::wrap_in(shared, slots::POOL)
    }

    fn wrap_in(shared: Shared, range: std::ops::Range<u32>) -> Self {
        let shared = Arc::new(shared);
        Self {
            pool: Pool::new(LocalHost(shared.clone()), range),
            shared,
        }
    }

    /// A machine whose pool has the one slot of the health check alone, as the process of
    /// `pgcf-agent check` has.
    pub fn for_check(label: &str) -> Option<Self> {
        let Self { shared, pool } = Self::new(label)?;
        drop(pool);
        let shared = Arc::try_unwrap(shared).unwrap_or_else(|_| panic!("not shared yet"));
        // A process that never made a slot: no slot user exists yet.
        shared.state().slot_users.clear();
        Some(Self::wrap_in(
            shared,
            slots::CHECK_SLOT..slots::CHECK_SLOT + 1,
        ))
    }

    /// The unit files below the root, as systemd's search path finds them: `/etc` before
    /// `/usr/lib`. A mask (a link to `/dev/null`) is `None`; anything but a file or a mask is no
    /// unit.
    fn unit_files(&self) -> BTreeMap<String, Option<Vec<u8>>> {
        let mut found = BTreeMap::new();
        // systemd's search path: the administrator's directory, then the runtime one, then the
        // vendor's (a boot empties the runtime one).
        for directory in [
            "etc/systemd/system",
            "run/systemd/system",
            "usr/lib/systemd/system",
        ] {
            let Ok(entries) = fs::read_dir(self.layout.host_root.join(directory)) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !(name.ends_with(".service") || name.ends_with(".slice"))
                    || found.contains_key(&name)
                {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if meta.file_type().is_symlink() {
                    if fs::read_link(&path).is_ok_and(|to| to == Path::new("/dev/null")) {
                        found.insert(name, None);
                    }
                } else if meta.is_file() {
                    found.insert(name, fs::read(&path).ok());
                }
            }
        }
        found
    }
    /// What systemd does at a boot: it loads every unit file there is.
    pub fn load_units(&self) {
        let files = self.unit_files();
        self.state().loaded = files;
    }
    /// The file a tool of systemd (`sysusers`, `tmpfiles`) is asked to read, below the machine's
    /// root. The call is kept, and a tool that was told to fail does.
    fn config_file(&self, tool: &str, file: &str) -> io::Result<String> {
        let mut state = self.state();
        state.calls.push(format!("{tool} {file}"));
        if std::mem::take(&mut state.run_fails) {
            return Err(tool_failed(&format!("systemd-{tool}"), file));
        }
        drop(state);
        fs::read_to_string(self.layout.host_root.join(file.trim_start_matches('/')))
            .map_err(|_| tool_failed(&format!("systemd-{tool}"), file))
    }
    /// The definition `unit` runs with: its file as it was loaded when it last restarted.
    pub fn running_definition(&self, unit: &str) -> Option<String> {
        self.state()
            .running
            .get(unit)
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
    }
    pub fn fail_next_reload(&self) {
        self.state().reload_fails = true;
    }
    pub fn fail_next_restart(&self) {
        self.state().restart_fails = true;
    }
    /// Every restart of `unit` fails, as a unit does that cannot start.
    pub fn fail_restarts_of(&self, unit: &str) {
        self.state().restart_fails_for.insert(unit.to_string());
    }
    /// Restarts of `unit` work again.
    pub fn mend_restarts_of(&self, unit: &str) {
        self.state().restart_fails_for.remove(unit);
    }
    pub fn fail_next_run(&self) {
        self.state().run_fails = true;
    }
    /// The users `systemd-sysusers` made.
    pub fn created_users(&self) -> Vec<String> {
        self.state().users.iter().cloned().collect()
    }
    /// The directories `systemd-tmpfiles` made, with the mode the file gave them.
    pub fn created_directories(&self) -> BTreeMap<String, String> {
        self.state().directories.clone()
    }
    pub fn with_layout(self, change: impl FnOnce(&mut Layout)) -> Self {
        let Self { shared, pool } = self;
        let range = pool.range();
        drop(pool);
        let mut shared =
            Arc::try_unwrap(shared).unwrap_or_else(|_| panic!("the machine is not shared yet"));
        change(&mut shared.layout);
        Self::wrap_in(shared, range)
    }
    pub fn calls(&self) -> Vec<String> {
        self.state().calls.clone()
    }
    pub fn clear_calls(&self) {
        self.state().calls.clear();
    }
    /// The thin pool is gone, as on a node whose volume group lost it.
    pub fn lose_pool(&self) {
        self.state().pool_lost = true;
    }
    /// A journal file of the node was damaged by a crash.
    pub fn damage_journal(&self) {
        self.state().journal_damaged = true;
    }
    /// The Debian packages the node has.
    pub fn set_packages(&self, packages: &[(&str, &str)]) {
        self.state().packages = packages
            .iter()
            .map(|(name, version)| (name.to_string(), version.to_string()))
            .collect();
    }
    /// How many slot numbers have a user on this machine.
    pub fn slot_users(&self) -> usize {
        self.state().slot_users.len()
    }
    /// A node that made the users of the first `count` slot numbers only, as one just installed
    /// has: the pool reads them again, as an agent that starts does.
    pub async fn limit_slot_users(&self, count: u32) {
        self.state().slot_users = (0..count).collect();
        self.pool.adopt().await.unwrap();
    }
    /// The unit of slot `number` refuses to start until the process in its cgroup ends.
    pub fn stray_slot(&self, number: u32) {
        self.state().stray_slots.insert(number);
    }
    /// Whether `database` has a postmaster running, in a slot or as a unit of its own.
    pub fn running(&self, database: &str) -> bool {
        let mut state = self.state();
        if let Some(slot) = self.pool.slot_of(database) {
            return state
                .slots
                .get_mut(&slot)
                .is_some_and(|unit| unit.postgres && unit.alive());
        }
        state
            .legacy
            .get_mut(database)
            .and_then(|unit| unit.child.as_mut())
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
    }
    /// Whether the postmaster of `database` has written `ready` to its `postmaster.pid`, which the
    /// kernel shows to whoever reads the volume, mounted by the agent or not.
    pub fn postmaster_ready(&self, database: &str) -> bool {
        let pid = {
            let mut state = self.state();
            let Some(slot) = self.pool.slot_of(database) else {
                return false;
            };
            let unit = state.slots.get_mut(&slot);
            unit.and_then(|unit| {
                (unit.postgres && unit.alive())
                    .then(|| unit.child.as_ref().map(Child::id))
                    .flatten()
            })
        };
        pid.is_some_and(|pid| ready::ready_socket(&self.layout.volume(database), pid).is_ok())
    }
    /// SIGKILL: a crash the units do not report.
    pub fn crash(&self, database: &str) {
        let mut state = self.state();
        let child = match self.pool.slot_of(database) {
            Some(slot) => state.slots.get_mut(&slot).and_then(|unit| {
                unit.lock = None;
                unit.child.take().inspect(|_| unit.crashed = true)
            }),
            None => state
                .legacy
                .get_mut(database)
                .and_then(|unit| unit.child.take().inspect(|_| unit.crashed = true)),
        };
        if let Some(mut child) = child {
            let _ = child.kill();
            let _ = child.wait();
            drop(state);
            self.release_shared_memory(database);
        }
    }
    /// The limits the slot that holds the database was given at its bind, or since.
    pub fn limits(&self, database: &str) -> Option<Limits> {
        let slot = self.pool.slot_of(database)?;
        let state = self.state();
        let properties = &state.slots.get(&slot)?.properties;
        let number = |wanted: fn(&Property) -> Option<u64>| properties.iter().find_map(wanted);
        Some(Limits {
            memory_mib: number(|p| match p {
                Property::MemoryMax(bytes) => Some(*bytes),
                _ => None,
            })? >> 20,
            cpu_millicores: u32::try_from(
                number(|p| match p {
                    Property::CpuWeight(weight) => Some(*weight),
                    _ => None,
                })? * 10,
            )
            .ok()?,
            tasks_max: number(|p| match p {
                Property::TasksMax(tasks) => Some(*tasks),
                _ => None,
            })?,
            io: None,
        })
    }
    pub fn quota(&self, database: &str) -> Option<Option<NonZeroU32>> {
        self.state().quotas.get(database).copied()
    }
    /// The quotas the agent set on the database, in order.
    pub fn quota_calls(&self, database: &str) -> Vec<Option<NonZeroU32>> {
        self.state()
            .quota_calls
            .iter()
            .filter(|(id, _)| id == database)
            .map(|(_, quota)| *quota)
            .collect()
    }
    pub fn credentials_applied(&self) -> Vec<(String, String, u64, bool)> {
        self.state().credentials.clone()
    }
    pub fn slice_memory_mib(&self) -> Option<u64> {
        self.state().slice_memory_mib
    }
    pub fn volumes(&self) -> Vec<(VolumeId, u64)> {
        self.state()
            .volumes
            .iter()
            .map(|(id, size)| (id.clone(), *size))
            .collect()
    }
    pub fn set_no_room(&self, no_room: bool) {
        self.state().no_room = no_room;
    }
    pub fn set_available_bytes(&self, bytes: u64) {
        self.state().available_bytes = bytes;
    }
    /// Every database archives straight into its upload log, as `archive_with` does for one.
    pub fn direct_archive(&self) {
        self.state().direct_archive = true;
    }
    pub fn delay_next_start(&self, delay: Duration) {
        self.state().start_delay = Some(delay);
    }
    pub fn fail_next_start(&self) {
        self.state().start_fails = true;
    }
    /// The next bind cannot move the database's mounts into its slot.
    pub fn fail_next_handoff(&self) {
        self.state().handoff_fails = true;
    }
    /// The next start fails after the unit is up and keeps running.
    pub fn fail_next_start_after_up(&self) {
        self.state().start_fails_after_up = true;
    }
    pub fn fail_next_reboot(&self) {
        self.state().reboot_fails = true;
    }
    pub fn fail_next_purge(&self) {
        self.state().purge_fails = true;
    }
    pub fn set_volumes_unreadable(&self, unreadable: bool) {
        self.state().volumes_unreadable = unreadable;
    }
    pub fn set_needs_repair(&self, needs_repair: bool) {
        self.state().needs_repair = needs_repair;
    }
    pub fn set_units_unreadable(&self, unreadable: bool) {
        self.state().units_unreadable = unreadable;
    }
    /// LVM cannot be read for the next `count` questions, and can be after them.
    pub fn fail_next_volume_reads(&self, count: u32) {
        self.state().volume_reads_fail = count;
    }
    /// systemd cannot be read for the next `count` questions, and can be after them.
    pub fn fail_next_unit_reads(&self, count: u32) {
        self.state().unit_reads_fail = count;
    }
    /// The reads of these databases' units wait until `release_unit_reads`.
    pub fn hold_unit_reads(&self, databases: impl IntoIterator<Item = String>) {
        self.state().held_units = databases.into_iter().collect();
        self.unit_gate.send_replace(false);
    }
    pub fn release_unit_reads(&self) {
        self.unit_gate.send_replace(true);
    }
    /// The agent's mounts of volumes wait until `release_mounts`.
    pub fn hold_mounts(&self) {
        self.mount_gate.send_replace(false);
    }
    pub fn release_mounts(&self) {
        self.mount_gate.send_replace(true);
    }
    /// The next `count` waits for a unit to be ready fail as a bus does that refuses the call.
    pub fn fail_next_waits(&self, count: u32) {
        self.state().wait_reads_fail = count;
    }
    /// How often `has_volume` was asked, and how often `unit` was.
    pub fn reads(&self) -> (u64, u64) {
        let state = self.state();
        (state.volume_reads, state.unit_reads)
    }
    /// A unit that exists and is stopped, as one is after a stop or a boot.
    pub fn add_stopped_unit(&self, database: &str) {
        self.state().legacy.insert(
            database.to_string(),
            Unit {
                child: None,
                crashed: false,
                invocations: 0,
                invocation_id: None,
                volume: None,
                activating: None,
            },
        );
    }
    /// The agent restarts: its mount namespace ends with it, and with it the mounts and the links
    /// of every volume. The units run on, on the volumes they mounted themselves.
    pub fn forget_mounts(&self) {
        self.state().attached.clear();
    }
    /// A volume that the agent has mounted but whose link is gone (a failed rename, or a link
    /// dropped by a pool failure that did not reach the volume's recovery).
    pub fn lose_link(&self, id: &VolumeId) {
        self.state().attached.remove(id);
    }
    /// A job holds the volume in a namespace of its own, as a barman job with `MountImages=`
    /// does: the agent's unmount and removal of it are `Busy` until `release_volume`.
    pub fn hold_volume(&self, id: &VolumeId) {
        self.state().jobs.insert(id.clone());
    }
    pub fn release_volume(&self, id: &VolumeId) {
        self.state().jobs.remove(id);
    }
    /// Whether a unit that runs or a job has the filesystem of the volume, in a mount namespace
    /// of its own: what the node answers with `Busy` (lvm2: "in use"; the agent's unmount: ext4's
    /// superblock outlives it), whether or not the agent has a mount of its own.
    fn held(&self, id: &VolumeId) -> bool {
        self.holders(id, |held| held == id)
    }
    /// Whether a unit that runs or a job has another generation of the volume's database: the
    /// directory is the database's, so the next generation is not made or mounted then.
    fn other_generation_held(&self, id: &VolumeId) -> bool {
        self.holders(id, |held| held != id)
    }
    fn holders(&self, id: &VolumeId, wanted: impl Fn(&VolumeId) -> bool) -> bool {
        let running = self.running(id.database());
        let slot = self.pool.slot_of(id.database());
        let mut state = self.state();
        // A slot holds the filesystem while its process lives, bound or running: the mount is in
        // its namespace.
        let in_slot = slot.and_then(|slot| {
            let unit = state.slots.get_mut(&slot)?;
            unit.alive()
                .then(|| unit.mounted.as_ref().map(|(_, volume)| volume.clone()))
                .flatten()
        });
        let unit = state
            .legacy
            .get(id.database())
            .filter(|_| running)
            .and_then(|unit| unit.volume.clone());
        in_slot
            .iter()
            .chain(unit.iter())
            .chain(state.jobs.iter())
            .any(|held| held.database() == id.database() && wanted(held))
    }
    pub fn has_account(&self, database: &str) -> bool {
        self.state().accounts.iter().any(|a| a == database)
    }
}
impl Drop for Shared {
    fn drop(&mut self) {
        let mut ending: Vec<(Child, Option<String>)> = Vec::new();
        {
            let mut state = self.state();
            for unit in state.slots.values_mut() {
                let database = unit.mounted.as_ref().map(|(database, _)| database.clone());
                if let Some(child) = unit.child.take() {
                    ending.push((child, database));
                }
            }
            for (database, unit) in state.legacy.iter_mut() {
                if let Some(child) = unit.child.take() {
                    ending.push((child, Some(database.clone())));
                }
            }
        }
        for (mut child, database) in ending {
            let _ = Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status();
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(10)
                && child.try_wait().ok().flatten().is_none()
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
            if let Some(database) = database {
                self.release_shared_memory(&database);
            }
        }
        if let Some(root) = self.layout.state.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }
}

impl Machine for Local {
    fn layout(&self) -> &Layout {
        &self.layout
    }

    async fn ensure_account(&self, database: &str) -> io::Result<Account> {
        let mut state = self.state();
        if !state.accounts.iter().any(|a| a == database) {
            state.accounts.push(database.to_string());
        }
        Ok(Account {
            name: self.user.clone(),
            uid: self.uid,
            gid: self.gid,
        })
    }
    fn account(&self, database: &str) -> Option<Account> {
        self.has_account(database).then(|| Account {
            name: self.user.clone(),
            uid: self.uid,
            gid: self.gid,
        })
    }
    async fn remove_account(&self, database: &str) -> io::Result<()> {
        self.state().accounts.retain(|a| a != database);
        Ok(())
    }

    async fn create_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
        _account: &Account,
        _policy: &storage::Policy,
    ) -> Result<(), storage::Error> {
        let mut state = self.state();
        if let Some(error) = state.volume_error.take() {
            return Err(error);
        }
        if state.no_room {
            return Err(storage::Error::NoRoom(NoRoom::Reserve));
        }
        // A database has one directory, and a unit or a job that has another generation's
        // filesystem keeps the next one from being made, whatever the agent has mounted.
        drop(state);
        if self.other_generation_held(id) {
            return Err(storage::Error::OtherGeneration);
        }
        let mut state = self.state();
        // A database has one directory: the volume of another generation that is still mounted
        // there is in the way, as it is on the node.
        let live = self.layout.volume(id.database());
        if live.exists()
            && state
                .volumes
                .keys()
                .any(|other| other.database() == id.database() && other != id)
            && !state.volumes.contains_key(id)
        {
            return Err(storage::Error::OtherGeneration);
        }
        fs::create_dir_all(&live)?;
        state.volumes.insert(id.clone(), size_bytes);
        state.attached.insert(id.clone());
        Ok(())
    }
    async fn has_volume(&self, id: &VolumeId) -> Result<bool, storage::Error> {
        let mut state = self.state();
        state.volume_reads += 1;
        if state.volumes_unreadable || state.volume_reads_fail > 0 {
            state.volume_reads_fail = state.volume_reads_fail.saturating_sub(1);
            return Err(storage::Error::Unexpected("lvs"));
        }
        Ok(state.volumes.contains_key(id))
    }
    fn attached(&self, id: &VolumeId) -> bool {
        self.state().attached.contains(id)
    }
    async fn unit_volume(&self, database: &str) -> Result<Option<VolumeId>, storage::Error> {
        if !self.running(database) {
            return Ok(None);
        }
        if let Some(volume) = self.pool.volume_of(database) {
            return Ok(Some(volume));
        }
        let state = self.state();
        match state
            .legacy
            .get(database)
            .and_then(|unit| unit.volume.clone())
        {
            Some(volume) => Ok(Some(volume)),
            None => Err(storage::Error::Unexpected(
                "a running unit without its volume",
            )),
        }
    }
    async fn mount_volumes(
        &self,
        current: &[VolumeId],
    ) -> Result<Vec<(VolumeId, storage::Error)>, storage::Error> {
        let mut gate = self.mount_gate.subscribe();
        while !*gate.borrow_and_update() {
            if gate.changed().await.is_err() {
                break;
            }
        }
        let mut failures = Vec::new();
        for id in current {
            let other_held = self.other_generation_held(id);
            let mut state = self.state();
            state.calls.push(format!("mount {}", id.database()));
            if !state.volumes.contains_key(id) {
                continue;
            }
            if other_held {
                failures.push((id.clone(), storage::Error::OtherGeneration));
                continue;
            }
            // A database has one directory: the generation that is attached holds it.
            if state
                .attached
                .iter()
                .any(|other| other.database() == id.database() && other != id)
            {
                failures.push((id.clone(), storage::Error::OtherGeneration));
                continue;
            }
            state.attached.insert(id.clone());
        }
        Ok(failures)
    }
    /// The volume is set aside beside its directory, as the unmounted logical volume is: its
    /// files are there for the generation, not for the database's directory.
    async fn unmount_volume(&self, id: &VolumeId) -> Result<(), storage::Error> {
        let held = self.held(id);
        {
            let mut state = self.state();
            state.calls.push(format!("unmount {}", id.database()));
            // The agent's own mount goes and the superblock stays: the node mounts the volume
            // again where it was and answers `Busy`, with the link as it was.
            if held {
                return Err(storage::Error::Busy);
            }
            state.attached.remove(id);
        }
        let live = self.layout.volume(id.database());
        let aside = self
            .layout
            .volume(&format!("{}.g{}", id.database(), id.generation()));
        match fs::rename(&live, &aside) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
    async fn grow_volume(&self, id: &VolumeId, size_bytes: u64) -> Result<(), storage::Error> {
        let mut state = self.state();
        match state.volumes.get_mut(id) {
            None => Err(storage::Error::Missing),
            Some(size) if size_bytes < *size => Err(storage::Error::Shrink),
            Some(size) => {
                *size = size_bytes;
                Ok(())
            }
        }
    }
    async fn remove_volume(&self, id: &VolumeId, _removal: Removal) -> Result<(), storage::Error> {
        let held = self.held(id);
        let mut state = self.state();
        state.calls.push(format!("remove {}", id.database()));
        // lvm2 refuses a volume that a unit or a job has open: "in use".
        if held {
            return Err(storage::Error::Busy);
        }
        state.volumes.remove(id);
        state.attached.remove(id);
        let others = state
            .volumes
            .keys()
            .any(|other| other.database() == id.database());
        drop(state);
        // The directory of the generation: the aside one if it was unmounted, else the live one.
        let aside = self
            .layout
            .volume(&format!("{}.g{}", id.database(), id.generation()));
        let target = if aside.exists() {
            aside
        } else if others {
            return Ok(());
        } else {
            self.layout.volume(id.database())
        };
        match fs::remove_dir_all(target) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
    async fn trim_volume(&self, id: &VolumeId) -> Result<(), storage::Error> {
        self.state().calls.push(format!("trim {}", id.database()));
        Ok(())
    }
    async fn needs_repair(&self, _id: &VolumeId) -> Result<bool, storage::Error> {
        Ok(self.state().needs_repair)
    }
    async fn recover_volume(
        &self,
        id: &VolumeId,
        _policy: &storage::Policy,
    ) -> Result<(), storage::Error> {
        self.state()
            .calls
            .push(format!("recover {}", id.database()));
        // The repair detaches the volume first, which a holder refuses.
        if self.held(id) {
            return Err(storage::Error::Busy);
        }
        Ok(())
    }
    async fn inventory(&self) -> Result<Inventory, storage::Error> {
        let state = self.state();
        let volumes: Vec<VolumeInfo> = state
            .volumes
            .iter()
            .map(|(id, size)| VolumeInfo {
                id: id.clone(),
                size_bytes: *size,
                pool_used_bytes: 150 << 20,
                formatted: true,
                reserve_released: false,
                suspect: false,
                fs_errors: false,
                mount: state.attached.contains(id).then_some(MountInfo {
                    usage: FsUsage {
                        total_bytes: *size,
                        used_bytes: 100 << 20,
                        available_bytes: size - (100 << 20),
                        inodes_total: 1 << 20,
                        inodes_used: 1500,
                    },
                }),
            })
            .collect();
        Ok(Inventory {
            nominal_bytes: volumes.iter().map(|v| v.size_bytes).sum(),
            volumes,
        })
    }
    async fn poll_pool(&self) -> Result<PoolSample, storage::Error> {
        Ok(PoolSample {
            observed: Instant::now(),
            data_total_bytes: 100 << 30,
            data_used_bytes: 10 << 30,
            metadata_total_bytes: 1 << 30,
            metadata_used_bytes: 10 << 20,
            mode: PoolMode::ReadWrite,
            needs_check: false,
        })
    }
    fn room(&self, _policy: &storage::Policy) -> Result<(), NoRoom> {
        if self.state().no_room {
            Err(NoRoom::Reserve)
        } else {
            Ok(())
        }
    }
    fn device(&self, id: &VolumeId) -> String {
        format!("/dev/mapper/pgcf-{}", id.lv_name())
    }

    fn archive_command(&self, database: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let state = self.state();
        if let Some(command) = state.archive_commands.get(database) {
            return command.clone();
        }
        if !state.direct_archive {
            return self.layout.archive_command.clone();
        }
        // The archive socket tells databases apart by their user, and the tests' databases all run
        // as one: this script is the archive of one database.
        let log = self.layout.database_files(database).join("uploads-g1.log");
        let script = self
            .layout
            .state
            .parent()
            .unwrap_or(&self.layout.state)
            .join(format!("direct-{database}.sh"));
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nmkdir -p '{dir}'\nbasename \"$1\" >> '{log}'\n",
                dir = log.parent().unwrap().display(),
                log = log.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script.display().to_string()
    }
    fn agent_user(&self) -> String {
        self.user.clone()
    }

    fn prepare_socket_directory(&self, database: &str, _account: &Account) -> io::Result<()> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let directory = self.layout.socket_directory(database);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o750)
            .create(&directory)?;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750))
    }

    async fn initdb(&self, _account: &Account, data: &Path) -> io::Result<()> {
        let output = tokio::process::Command::new(self.layout.postgres_bin.join("initdb"))
            .args(initdb_arguments(data, None))
            .arg("--no-sync")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ))
        }
    }

    async fn unit(&self, database: &str) -> Result<UnitState, units::Error> {
        let held = {
            let mut state = self.state();
            state.unit_reads += 1;
            state.held_units.contains(database)
        };
        if held {
            let mut gate = self.unit_gate.subscribe();
            while !*gate.borrow_and_update() {
                if gate.changed().await.is_err() {
                    break;
                }
            }
        }
        {
            let mut state = self.state();
            if state.units_unreadable || state.unit_reads_fail > 0 {
                state.unit_reads_fail = state.unit_reads_fail.saturating_sub(1);
                return Err(bus_refused());
            }
        }
        if let Some(unit) = self.pool.state(database).await? {
            return Ok(unit);
        }
        let mut state = self.state();
        let (active, main_pid, invocation_id) = self.unit_facts(&mut state, database);
        Ok(UnitState {
            database: database.to_string(),
            active,
            main_pid,
            invocation_id,
            uid: (active == ActiveState::Active).then_some(self.uid),
            memory_max_bytes: Some(256 << 20),
            slot: None,
        })
    }
    async fn units(&self) -> Result<Vec<UnitState>, units::Error> {
        let mut databases = self.pool.databases();
        databases.extend(self.state().legacy.keys().cloned());
        databases.sort();
        databases.dedup();
        let mut states = Vec::new();
        for database in databases {
            states.push(self.unit(&database).await?);
        }
        Ok(states)
    }
    async fn bind(&self, database: &str, bind: &Bind) -> Result<Bound, units::Error> {
        self.pool.bind(database, bind).await
    }
    async fn exec(&self, bound: &Bound) -> Result<Started, units::Error> {
        self.state().calls.push(format!("start {}", bound.database));
        let started = self.pool.exec(bound).await?;
        if std::mem::take(&mut self.state().start_fails_after_up) {
            return Err(bus_refused());
        }
        Ok(started)
    }
    /// Neither systemd nor a journal runs here: nothing was recorded.
    async fn start_timeline(&self, _: &str, _: &Started) -> Result<Timeline, units::Error> {
        Ok(Timeline::default())
    }
    async fn wait_started(&self, database: &str) -> Result<Started, units::Error> {
        {
            let mut state = self.state();
            if state.wait_reads_fail > 0 {
                state.wait_reads_fail -= 1;
                return Err(bus_refused());
            }
        }
        if self.pool.slot_of(database).is_some() {
            return self.pool.wait_started(database).await;
        }
        // As the unit's own answer does: it waits while the unit is activating, reads the files
        // once when the unit is active, and a unit that is not active is not ready.
        loop {
            match self.active_state(database) {
                ActiveState::Activating => {}
                ActiveState::Active => return self.started(database),
                _ => return Err(units::Error::NotReady("unit_not_active")),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    async fn stop(&self, database: &str) -> Result<(), units::Error> {
        {
            let mut state = self.state();
            state.calls.push(format!("stop {database}"));
            state.quotas.insert(database.to_string(), None);
        }
        if self.pool.stop(database).await? {
            return Ok(());
        }
        let child = self
            .state()
            .legacy
            .get_mut(database)
            .and_then(|unit| unit.child.take());
        if let Some(mut child) = child {
            let _ = Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status();
            let started = Instant::now();
            while child.try_wait().ok().flatten().is_none() {
                if started.elapsed() > Duration::from_secs(30) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        Ok(())
    }
    async fn set_limits(&self, database: &str, limits: &Limits) -> Result<(), units::Error> {
        self.pool.set(database, &limits.properties()).await?;
        Ok(())
    }
    async fn set_cpu_quota(
        &self,
        database: &str,
        millicores: Option<NonZeroU32>,
    ) -> Result<(), units::Error> {
        {
            let mut state = self.state();
            state.quotas.insert(database.to_string(), millicores);
            state.quota_calls.push((database.to_string(), millicores));
        }
        self.pool.set(database, &[cpu_quota(millicores)]).await?;
        Ok(())
    }
    async fn set_slice_memory(&self, awake_budget_mib: u64) -> Result<(), units::Error> {
        self.state().slice_memory_mib = Some(awake_budget_mib);
        Ok(())
    }

    async fn adopt_slots(&self) -> Result<Adopted, units::Error> {
        self.pool.adopt().await
    }
    async fn refill_slot(&self, target: usize) -> Result<Option<u32>, units::Error> {
        self.pool.refill(target).await
    }
    async fn make_slot_user(&self) -> Result<Option<u32>, units::Error> {
        self.pool.make_user().await
    }
    async fn drain_idle_slots(&self) -> usize {
        self.pool.drain_idle().await
    }
    fn slots(&self) -> Snapshot {
        self.pool.snapshot()
    }
    /// The processes of the machine all run as one user, so a caller is the database whose
    /// postmaster is an ancestor of its process (a node tells slots apart by their uids, cgroups
    /// and invocations). A caller that is none of them (the test's own process) is the one
    /// database a slot holds, if there is exactly one.
    fn caller(&self, _uid: u32, pid: u32) -> Option<String> {
        let databases = self.pool.databases();
        let postmasters: Vec<(String, u32)> = {
            let state = self.state();
            databases
                .iter()
                .filter_map(|database| {
                    let slot = self.pool.slot_of(database)?;
                    let main = state.slots.get(&slot)?.child.as_ref()?.id();
                    Some((database.clone(), main))
                })
                .collect()
        };
        let mut at = pid;
        while at > 1 {
            if let Some((database, _)) = postmasters.iter().find(|(_, main)| *main == at) {
                return Some(database.clone());
            }
            at = parent_of(at)?;
        }
        match databases.as_slice() {
            [database] => Some(database.clone()),
            _ => None,
        }
    }

    async fn apply_credentials(
        &self,
        node: &NodeIdentity,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> io::Result<()> {
        self.state().credentials.push((
            node.region_id.clone(),
            node.id.clone(),
            credentials["revision"].as_u64().unwrap_or(0),
            restart,
        ));
        Ok(())
    }

    /// `systemctl restart`: the unit starts with the definition systemd has loaded, which is its
    /// file as of the last reload and not as it is now; a unit with no file, or a mask, cannot be
    /// started.
    async fn restart_service(&self, unit: &str) -> Result<(), units::Error> {
        let files = self.unit_files();
        let mut state = self.state();
        state.calls.push(format!("restart {unit}"));
        let job = |result: &str| units::Error::Job {
            unit: unit.to_string(),
            result: result.to_string(),
        };
        if std::mem::take(&mut state.restart_fails) || state.restart_fails_for.contains(unit) {
            return Err(job("failed"));
        }
        // systemd loads a unit it has not loaded yet when it is asked for it.
        if !state.loaded.contains_key(unit)
            && let Some(file) = files.get(unit)
        {
            state.loaded.insert(unit.to_string(), file.clone());
        }
        match state.loaded.get(unit).cloned() {
            Some(Some(definition)) => {
                state.running.insert(unit.to_string(), definition);
                Ok(())
            }
            Some(None) => Err(job("masked")),
            None => Err(job("not-found")),
        }
    }

    /// `systemctl daemon-reload`: every unit file is read again, and no unit restarts.
    async fn daemon_reload(&self) -> Result<(), units::Error> {
        let files = self.unit_files();
        let mut state = self.state();
        state.calls.push("daemon-reload".into());
        if std::mem::take(&mut state.reload_fails) {
            return Err(units::Error::Unexpected("the reload failed"));
        }
        state.loaded = files;
        Ok(())
    }

    /// `systemd-sysusers <file>`: reads the file as given and makes the users and groups it lists;
    /// a file it cannot read or parse is exit status 1, and a user that exists stays as it is.
    async fn run_sysusers(&self, file: &str) -> io::Result<()> {
        let text = self.config_file("sysusers", file)?;
        let mut users = Vec::new();
        for line in text
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#') && !line.is_empty())
        {
            let fields: Vec<&str> = line.split_whitespace().collect();
            match fields.as_slice() {
                ["u" | "g" | "m", name, ..] => users.push((*name).to_string()),
                _ => return Err(tool_failed("systemd-sysusers", file)),
            }
        }
        self.state().users.extend(users);
        Ok(())
    }

    /// `systemd-tmpfiles --create <file>`: makes the directories (`d`) it lists with the mode it
    /// gives, and leaves one that exists as it is; another type of line is not modelled and a
    /// line that is none is exit status 1.
    async fn run_tmpfiles(&self, file: &str) -> io::Result<()> {
        let text = self.config_file("tmpfiles", file)?;
        let mut directories = Vec::new();
        for line in text
            .lines()
            .map(str::trim)
            .filter(|line| !line.starts_with('#') && !line.is_empty())
        {
            let fields: Vec<&str> = line.split_whitespace().collect();
            match fields.as_slice() {
                ["d", path, mode, ..] => {
                    directories.push(((*path).to_string(), (*mode).to_string()))
                }
                [kind, _, ..] if kind.len() == 1 => {}
                _ => return Err(tool_failed("systemd-tmpfiles", file)),
            }
        }
        let mut state = self.state();
        for (path, mode) in directories {
            state.directories.entry(path).or_insert(mode);
        }
        Ok(())
    }

    async fn installed_packages(&self) -> io::Result<BTreeMap<String, String>> {
        Ok(self.state().packages.clone())
    }

    /// Apt's effect on the package list: the versions named are installed. A package file is only
    /// recorded: the lock of a release lists the package of each file among its packages too, so
    /// the versions already name it.
    async fn install_packages(
        &self,
        snapshot: &str,
        versions: &[String],
        files: &[std::path::PathBuf],
    ) -> io::Result<()> {
        let mut state = self.state();
        let names: Vec<_> = files
            .iter()
            .filter_map(|file| file.file_name()?.to_str().map(String::from))
            .collect();
        let mut call = format!("install {snapshot} {}", versions.join(" "));
        if !names.is_empty() {
            call += &format!(" + {}", names.join(" "));
        }
        state.calls.push(call);
        for spec in versions {
            if let Some((name, version)) = spec.split_once('=') {
                state.packages.insert(name.into(), version.into());
            }
        }
        Ok(())
    }

    /// Dpkg's effect on the package list: the packages named are gone.
    async fn purge_packages(&self, names: &[String]) -> io::Result<()> {
        let mut state = self.state();
        state.calls.push(format!("purge {}", names.join(" ")));
        if std::mem::take(&mut state.purge_fails) {
            return Err(io::Error::other(
                "dpkg --purge ended with exit status: 1: dependency problems - not removing",
            ));
        }
        for name in names {
            state.packages.remove(name);
        }
        Ok(())
    }

    async fn reboot(&self) -> io::Result<()> {
        let mut state = self.state();
        state.calls.push("reboot".into());
        if std::mem::take(&mut state.reboot_fails) {
            return Err(io::Error::other(
                "systemctl reboot ended with exit status: 1",
            ));
        }
        state.boots += 1;
        // A boot empties /run, which holds the units of the runtime directory, and systemd reads
        // every unit file again and starts the units with them.
        let runtime = self.layout.host_root.join("run/systemd/system");
        let _ = fs::remove_dir_all(&runtime);
        drop(state);
        let files = self.unit_files();
        let mut state = self.state();
        state.running = files
            .iter()
            .filter_map(|(unit, definition)| Some((unit.clone(), definition.clone()?)))
            .collect();
        state.loaded = files;
        // GRUB boots the highest version, which is not the last name: 6.12.99 is below 6.12.113.
        let numbers = |abi: &str| -> Vec<u64> {
            abi.split(|c: char| !c.is_ascii_digit())
                .filter_map(|number| number.parse().ok())
                .collect()
        };
        let newest = state
            .packages
            .keys()
            .filter_map(|name| name.strip_prefix("linux-image-"))
            .filter(|abi| abi.starts_with(|c: char| c.is_ascii_digit()))
            .max_by_key(|abi| numbers(abi))
            .map(String::from);
        if let Some(abi) = newest {
            state.kernel_release = abi;
        }
        Ok(())
    }

    /// The scratch database, made or woken, answers: the same check the node runs.
    async fn health_check(&self) -> io::Result<()> {
        self.state().calls.push("health_check".into());
        let account = self.ensure_account(crate::agent::check::SCRATCH).await?;
        crate::agent::check::run(self, &account)
            .await
            .map(|_| ())
            .map_err(|error| io::Error::other(error.to_string()))
    }

    /// What `journalctl` printed on a node that rebooted, captured from a real one; a node that has
    /// not rebooted has no earlier boot.
    async fn previous_boot_journal(&self) -> io::Result<Option<String>> {
        let boots = self.state().boots;
        // The capture's lines name the boot they are from, as journald prints its ID (32 hex
        // digits): they are made the lines of the boot before this one.
        Ok((boots > 0).then(|| {
            include_str!("../diagnostics/previous-boot.jsonl").replace(
                "11111111111141118111111111111111",
                &boot_id(boots - 1).replace('-', ""),
            )
        }))
    }

    /// What the tools printed on a systemd 257 lab on Debian trixie (`diagnostics/probe/`): the
    /// outputs of the commands the probes build, as their exit status and streams.
    async fn diagnostic(&self, argv: &probe::Argv) -> io::Result<Output> {
        use std::os::unix::process::ExitStatusExt;
        // journalctl's line when reading the journal fails after it printed entries (systemd's
        // "Failed to iterate through journal: %m" with EBADMSG). The lab's journalctl read files
        // with random damage and ended with status 0, so this line is from the source, not a capture.
        const DAMAGED_JOURNAL: &str = "Failed to iterate through journal: Bad message\n";
        let exited = |code: i32, stdout: &str, stderr: &str| Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.into(),
            stderr: stderr.into(),
        };
        let mut state = self.state();
        state.calls.push(format!(
            "diagnostic {} {}",
            argv.program,
            argv.arguments.join(" ")
        ));
        let has = |word: &str| argv.arguments.iter().any(|argument| argument == word);
        Ok(match argv.program {
            "journalctl" if has("--list-boots") => {
                exited(0, include_str!("../diagnostics/probe/boots.txt"), "")
            }
            // A node that has not rebooted has no boot before this one.
            "journalctl" if has("--boot=-1") && state.boots == 0 => exited(
                1,
                "",
                "No journal boot entry found for the specified boot (-1).\n",
            ),
            "journalctl" if state.journal_damaged && has("-k") => exited(
                1,
                include_str!("../diagnostics/probe/kernel.jsonl"),
                DAMAGED_JOURNAL,
            ),
            "journalctl" if state.journal_damaged => exited(
                1,
                include_str!("../diagnostics/probe/journal.jsonl"),
                DAMAGED_JOURNAL,
            ),
            "journalctl" if has("-k") => {
                exited(0, include_str!("../diagnostics/probe/kernel.jsonl"), "")
            }
            "journalctl" => exited(0, include_str!("../diagnostics/probe/journal.jsonl"), ""),
            "systemctl" if has("--failed") => {
                exited(0, include_str!("../diagnostics/probe/failed-units.txt"), "")
            }
            "systemctl" if has("list-sockets") => {
                exited(0, include_str!("../diagnostics/probe/sockets.txt"), "")
            }
            "ss" => exited(0, include_str!("../diagnostics/probe/listeners.txt"), ""),
            "lvs" if state.pool_lost => {
                exited(5, include_str!("../diagnostics/probe/pool-missing.txt"), "")
            }
            "lvs" => exited(0, include_str!("../diagnostics/probe/pool-report.txt"), ""),
            _ => return Err(io::Error::from(io::ErrorKind::NotFound)),
        })
    }

    fn proc_file(&self, file: probe::ProcFile) -> io::Result<String> {
        use probe::ProcFile::*;
        Ok(match file {
            PressureCpu => include_str!("../diagnostics/probe/proc-pressure-cpu.txt"),
            PressureMemory => include_str!("../diagnostics/probe/proc-pressure-memory.txt"),
            PressureIo => include_str!("../diagnostics/probe/proc-pressure-io.txt"),
            Meminfo => include_str!("../diagnostics/probe/proc-meminfo.txt"),
            Loadavg => include_str!("../diagnostics/probe/proc-loadavg.txt"),
            Stat => include_str!("../diagnostics/probe/proc-stat.txt"),
        }
        .to_string())
    }

    fn boot(&self) -> Option<Boot> {
        let state = self.state();
        Some(Boot {
            id: boot_id(state.boots),
            booted_at: 1_792_318_800 + state.boots * 600,
            kernel_release: state.kernel_release.clone(),
        })
    }
    fn memory(&self) -> Option<Memory> {
        Some(Memory {
            total_bytes: 12 << 30,
            available_bytes: self.state().available_bytes,
        })
    }
    fn cpu(&self) -> Option<CpuTimes> {
        let mut state = self.state();
        state.cpu_calls += 1;
        Some(CpuTimes {
            busy: state.cpu_calls * 50,
            total: state.cpu_calls * 600,
            steal: state.cpu_calls * 2,
            cores: 6,
            ticks_per_second: 100,
        })
    }
    /// No cgroup here: nothing counted.
    fn throttle(&self, _: &str) -> Option<Throttle> {
        None
    }
}

impl Local {
    /// What systemd says of a unit of its own: its active state, its main process and its
    /// invocation. A postmaster that ended on its own is a crash. A unit whose start job is open is
    /// `activating`: until its postmaster is ready, and, for a start that takes long
    /// (`delay_next_start`), not before the job may end, ready or failed.
    fn unit_facts(
        &self,
        state: &mut State,
        database: &str,
    ) -> (ActiveState, Option<u32>, Option<String>) {
        let Some(unit) = state.legacy.get_mut(database) else {
            return (ActiveState::Inactive, None, None);
        };
        if unit.child.is_none() {
            unit.activating = None;
        }
        if unit
            .activating
            .is_some_and(|earliest| Instant::now() < earliest)
        {
            let pid = unit.child.as_ref().map(Child::id);
            return (ActiveState::Activating, pid, unit.invocation_id.clone());
        }
        let alive = unit
            .child
            .as_mut()
            .is_some_and(|child| child.try_wait().ok().flatten().is_none());
        if !alive && unit.child.is_some() {
            // The postmaster ended on its own.
            unit.child = None;
            unit.crashed = true;
            unit.activating = None;
        }
        let Some(pid) = unit.child.as_ref().map(Child::id) else {
            let active = if unit.crashed {
                ActiveState::Failed
            } else {
                ActiveState::Inactive
            };
            return (active, None, unit.invocation_id.clone());
        };
        if unit.activating.is_some()
            && ready::ready_socket(&self.layout.volume(database), pid).is_ok()
        {
            unit.activating = None;
        }
        let active = if unit.activating.is_some() {
            ActiveState::Activating
        } else {
            ActiveState::Active
        };
        (active, Some(pid), unit.invocation_id.clone())
    }

    /// The database's unit as the agent reads it, which reading it counts as no read of the test:
    /// its slot's, mapped as the pool maps it, or its unit of its own.
    pub fn active_state(&self, database: &str) -> ActiveState {
        if let Some(slot) = self.pool.slot_of(database) {
            let active = {
                let mut state = self.state();
                match state.slots.get_mut(&slot) {
                    Some(unit) => {
                        if unit.alive() {
                            ActiveState::Active
                        } else if unit.crashed {
                            ActiveState::Failed
                        } else {
                            ActiveState::Inactive
                        }
                    }
                    None => ActiveState::Inactive,
                }
            };
            return self.pool.view_of(database, active).unwrap_or(active);
        }
        self.unit_facts(&mut self.state(), database).0
    }

    /// The facts of a unit of its own that is ready, read as the agent reads them: through its own
    /// mount of the volume, where an agent that has not attached it finds an empty directory.
    fn started(&self, database: &str) -> Result<Started, units::Error> {
        let mut state = self.state();
        let unit = state
            .legacy
            .get_mut(database)
            .ok_or(units::Error::NotReady("unit_not_active"))?;
        let child = unit
            .child
            .as_ref()
            .ok_or(units::Error::NotReady("unit_not_active"))?;
        let main_pid = child.id();
        let invocation_id = unit
            .invocation_id
            .clone()
            .ok_or(units::Error::NotReady("no_invocation_id"))?;
        let mounted = state
            .attached
            .iter()
            .any(|volume| volume.database() == database);
        drop(state);
        if !mounted {
            return Err(units::Error::NotReady("postmaster_pid_missing"));
        }
        let socket = ready::ready_socket(&self.layout.volume(database), main_pid)
            .map_err(units::Error::NotReady)?;
        Ok(Started {
            main_pid,
            invocation_id,
            uid: self.uid,
            socket,
            requested_us: None,
            slot: None,
        })
    }

    /// PostgreSQL started in a slot on the volume the agent has attached, as the agent starts it
    /// (the pool's bind and the order), without the agent: what a test does to have a database
    /// running that an agent then finds.
    pub async fn start(&self, database: &str) -> Result<Started, units::Error> {
        let (volume, account) = {
            let state = self.state();
            (
                state
                    .attached
                    .iter()
                    .find(|volume| volume.database() == database)
                    .cloned(),
                state.accounts.iter().any(|held| held == database),
            )
        };
        let (Some(volume), true) = (volume, account) else {
            return Err(units::Error::Job {
                unit: units::unit_name(database),
                result: "assert".into(),
            });
        };
        let bind = Bind {
            device: self.device(&volume).into(),
            data: self.layout.data(database),
            properties: Limits {
                memory_mib: 256,
                cpu_millicores: 1000,
                tasks_max: 64,
                io: None,
            }
            .properties(),
            volume,
            account: Account {
                name: self.user.clone(),
                uid: self.uid,
                gid: self.gid,
            },
        };
        let bound = self.bind(database, &bind).await?;
        self.exec(&bound).await
    }

    /// PostgreSQL started the way an agent of an earlier release started it: as the database's
    /// unit of its own, with no slot, on the volume the agent has attached. The agent that finds
    /// it adopts it and puts it to sleep as it did; nothing but a test starts one.
    pub async fn start_legacy(&self, database: &str) -> Result<Started, units::Error> {
        let volume = {
            let state = self.state();
            state
                .attached
                .iter()
                .find(|volume| volume.database() == database)
                .cloned()
        };
        let Some(volume) = volume else {
            return Err(units::Error::Job {
                unit: units::unit_name(database),
                result: "assert".into(),
            });
        };
        let log = fs::File::create(self.layout.volume(database).join("postgres.log"))
            .map_err(|error| units::Error::Bus(zbus::Error::Failure(error.to_string())))?;
        let child = Command::new(self.layout.postgres_bin.join("postgres"))
            .arg("-D")
            .arg(self.layout.data(database))
            .arg("-c")
            .arg("listen_addresses=")
            .arg("-c")
            .arg(format!(
                "unix_socket_directories={}",
                self.layout.socket_directory(database).display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(|error| units::Error::Bus(zbus::Error::Failure(error.to_string())))?;
        {
            let mut state = self.state();
            let unit = state.legacy.entry(database.to_string()).or_insert(Unit {
                child: None,
                crashed: false,
                invocations: 0,
                invocation_id: None,
                volume: None,
                activating: None,
            });
            unit.volume = Some(volume);
            unit.invocations += 1;
            unit.crashed = false;
            unit.child = Some(child);
            unit.invocation_id = Some(format!("00000000-0000-4000-8000-{:012x}", unit.invocations));
            unit.activating = Some(Instant::now());
        }
        let started = Instant::now();
        loop {
            match self.active_state(database) {
                ActiveState::Active => return self.started(database),
                ActiveState::Activating => {}
                _ => {
                    return Err(units::Error::Job {
                        unit: units::unit_name(database),
                        result: "failed".into(),
                    });
                }
            }
            if started.elapsed() > Duration::from_secs(60) {
                return Err(units::Error::NotReady("postmaster_not_ready"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}

/// Merges properties into a slot's: a property replaces the one of its name, as systemd's
/// `SetUnitProperties` does for the setting it names.
fn merge(held: &mut Vec<Property>, set: &[Property]) {
    for property in set {
        match held.iter_mut().find(|held| held.name() == property.name()) {
            Some(held) => *held = property.clone(),
            None => held.push(property.clone()),
        }
    }
}

fn unit_assert(slot: u32) -> units::Error {
    units::Error::Job {
        unit: slots::slot_unit(slot),
        result: "assert".into(),
    }
}

impl Host for LocalHost {
    async fn unit(&self, slot: u32) -> Result<SlotUnit, units::Error> {
        let mut state = self.0.state();
        let Some(unit) = state.slots.get_mut(&slot) else {
            return Ok(SlotUnit {
                slot,
                active: ActiveState::Inactive,
                main_pid: None,
                invocation_id: None,
                memory_max_bytes: None,
            });
        };
        let alive = unit.alive();
        let active = if alive {
            ActiveState::Active
        } else if unit.crashed {
            ActiveState::Failed
        } else {
            ActiveState::Inactive
        };
        Ok(SlotUnit {
            slot,
            active,
            main_pid: unit.child.as_ref().map(Child::id),
            invocation_id: unit.invocation_id.clone(),
            memory_max_bytes: unit
                .properties
                .iter()
                .find_map(|property| match property {
                    Property::MemoryMax(bytes) => Some(*bytes),
                    _ => None,
                })
                .or(Some(256 << 20)),
        })
    }

    async fn units(&self) -> Result<Vec<SlotUnit>, units::Error> {
        let slots: Vec<u32> = self.0.state().slots.keys().copied().collect();
        let mut units = Vec::new();
        for slot in slots {
            units.push(self.unit(slot).await?);
        }
        Ok(units)
    }

    /// The processes of the machine all run as the user of the test, so no slot has an account of
    /// its own: a number "has a user" when the test machine says so.
    fn users(&self) -> BTreeSet<u32> {
        self.0.state().slot_users.clone()
    }

    async fn ensure_user(&self, slot: u32) -> Result<(), units::Error> {
        self.0.state().slot_users.insert(slot);
        Ok(())
    }

    async fn set(&self, slot: u32, properties: &[Property]) -> Result<(), units::Error> {
        let mut state = self.0.state();
        let unit = state.slots.entry(slot).or_insert_with(Slot::new);
        merge(&mut unit.properties, properties);
        Ok(())
    }

    /// The unit starts with a process that waits, which stands for the supervisor.
    async fn start(&self, slot: u32) -> Result<Spawned, units::Error> {
        if self.0.state().stray_slots.contains(&slot) {
            return Err(units::Error::StrayProcesses);
        }
        let child = Command::new("sleep")
            .arg("3600")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(units::Error::Io)?;
        let mut state = self.0.state();
        let unit = state.slots.entry(slot).or_insert_with(Slot::new);
        unit.invocations += 1;
        // An RFC 4122 UUID (variant 8) that names the slot and the start.
        let invocation = format!("00000000-0000-4000-8{slot:03x}-{:012x}", unit.invocations);
        let main_pid = child.id();
        unit.child = Some(child);
        unit.crashed = false;
        unit.postgres = false;
        unit.mounted = None;
        unit.lock = None;
        unit.invocation_id = Some(invocation.clone());
        Ok(Spawned {
            main_pid,
            invocation_id: invocation,
            requested_us: None,
        })
    }

    async fn stop(&self, slot: u32) -> Result<(), units::Error> {
        let (child, database) = {
            let mut state = self.0.state();
            let Some(unit) = state.slots.get_mut(&slot) else {
                return Ok(());
            };
            let database = unit.mounted.take().map(|(database, _)| database);
            let postgres = std::mem::replace(&mut unit.postgres, false);
            unit.lock = None;
            unit.crashed = false;
            (unit.child.take().map(|child| (child, postgres)), database)
        };
        if let Some((mut child, postgres)) = child {
            if postgres {
                let _ = Command::new("kill")
                    .args(["-INT", &child.id().to_string()])
                    .status();
                let started = Instant::now();
                while child.try_wait().ok().flatten().is_none() {
                    if started.elapsed() > Duration::from_secs(30) {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            } else {
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(database) = database {
                self.0.release_shared_memory(&database);
            }
        }
        Ok(())
    }

    async fn ping(&self, slot: u32) -> Result<(), units::Error> {
        let mut state = self.0.state();
        let idle = state
            .slots
            .get_mut(&slot)
            .is_some_and(|unit| unit.alive() && !unit.postgres);
        if idle {
            Ok(())
        } else {
            Err(units::Error::Refused("reply"))
        }
    }

    fn alive(&self, slot: u32) -> bool {
        self.0.state().slots.get_mut(&slot).is_some_and(Slot::alive)
    }

    /// The processes of the machine all run as the user of the test.
    fn uid(&self, _slot: u32) -> u32 {
        self.0.uid
    }

    /// The handoff clones the agent's own mount of the volume: a volume the agent has not
    /// attached cannot be moved in.
    async fn mount(&self, slot: u32, bind: &Bind) -> Result<(), units::Error> {
        let mut state = self.0.state();
        if std::mem::take(&mut state.handoff_fails) || !state.attached.contains(&bind.volume) {
            return Err(unit_assert(slot));
        }
        let unit = state.slots.entry(slot).or_insert_with(Slot::new);
        if !unit.alive() {
            return Err(unit_assert(slot));
        }
        unit.mounted = Some((bind.volume.database().to_string(), bind.volume.clone()));
        Ok(())
    }

    /// The supervisor's order: the lock of the data directory, then PostgreSQL started as the
    /// image's unit starts it, in the place of the supervisor.
    async fn order(&self, slot: u32, database: &str) -> Result<Ordered, units::Error> {
        let began = Instant::now();
        let layout = self.0.layout.clone();
        {
            let mut state = self.0.state();
            if std::mem::take(&mut state.start_fails) {
                // The exec failed: the supervisor ends.
                if let Some(unit) = state.slots.get_mut(&slot)
                    && let Some(mut child) = unit.child.take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err(units::Error::Refused("reply"));
            }
        }
        let refuse = |word: &'static str| units::Error::Refused(word);
        if !layout.data(database).join("PG_VERSION").exists() {
            return Err(refuse("unbound"));
        }
        let data = fs::File::open(layout.data(database)).map_err(units::Error::Io)?;
        match data.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(refuse("held")),
            Err(fs::TryLockError::Error(error)) => return Err(units::Error::Io(error)),
        }
        let log = fs::File::create(layout.volume(database).join("postgres.log"))
            .map_err(units::Error::Io)?;
        let delay = self.0.state().start_delay.take();
        // A start that takes long, as a crash recovery does: the process is there, holds the lock
        // and has written no status yet. The process that waits executes PostgreSQL, as the
        // supervisor does, so that it is the same process.
        let mut command = match delay {
            Some(delay) => {
                let mut command = Command::new("sh");
                command
                    .arg("-c")
                    .arg("sleep \"$1\"; shift; exec \"$@\"")
                    .arg("sh")
                    .arg(format!("{:.3}", delay.as_secs_f64()))
                    .arg(layout.postgres_bin.join("postgres"));
                command
            }
            None => Command::new(layout.postgres_bin.join("postgres")),
        };
        let child = command
            .arg("-D")
            .arg(layout.data(database))
            .arg("-c")
            .arg("listen_addresses=")
            .arg("-c")
            .arg(format!(
                "unix_socket_directories={}",
                layout.socket_directory(database).display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()
            .map_err(units::Error::Io)?;
        let mut state = self.0.state();
        let unit = state.slots.entry(slot).or_insert_with(Slot::new);
        if let Some(mut supervisor) = unit.child.replace(child) {
            let _ = supervisor.kill();
            let _ = supervisor.wait();
        }
        unit.postgres = true;
        unit.crashed = false;
        unit.lock = Some(data);
        let main_pid = unit.child.as_ref().map_or(0, Child::id);
        Ok(Ordered {
            main_pid,
            sent_us: None,
            took: began.elapsed(),
        })
    }

    async fn ready(
        &self,
        slot: u32,
        database: &str,
        main_pid: u32,
    ) -> Result<PathBuf, units::Error> {
        let began = Instant::now();
        loop {
            {
                let mut state = self.0.state();
                let mounted = state
                    .attached
                    .iter()
                    .any(|volume| volume.database() == database);
                let unit = state
                    .slots
                    .get_mut(&slot)
                    .ok_or(units::Error::NotReady("exited"))?;
                if !unit.alive() {
                    return Err(units::Error::NotReady("exited"));
                }
                if !mounted {
                    return Err(units::Error::NotReady("postmaster_pid_missing"));
                }
                if let Ok(socket) = ready::ready_socket(&self.0.layout.volume(database), main_pid) {
                    return Ok(socket);
                }
            }
            if began.elapsed() > Duration::from_secs(60) {
                return Err(units::Error::NotReady("postmaster_not_ready"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// What the kernel says of the slot's process: the program it runs, the databases whose
    /// volume it has mounted, whether it holds the lock, and the status in `postmaster.pid`.
    fn facts(&self, slot: u32, _pid: Option<u32>) -> Result<Option<Facts>, units::Error> {
        let mut state = self.0.state();
        let Some(unit) = state.slots.get_mut(&slot) else {
            return Ok(None);
        };
        if !unit.alive() {
            return Ok(None);
        }
        let pid = unit.child.as_ref().map_or(0, Child::id);
        let databases: Vec<_> = unit
            .mounted
            .iter()
            .map(|(database, volume)| (database.clone(), Some(volume.clone())))
            .collect();
        let postmaster = unit
            .postgres
            .then(|| databases.first())
            .flatten()
            .and_then(|(database, _)| {
                fs::read_to_string(self.0.layout.data(database).join("postmaster.pid")).ok()
            })
            .and_then(|text| ready::parse(&text).ok())
            .filter(|postmaster| postmaster.pid == pid)
            .map(|postmaster| postmaster.status);
        Ok(Some(Facts {
            pid,
            exe: if unit.postgres {
                Exe::Postgres
            } else {
                Exe::Supervisor
            },
            databases,
            locked: unit.lock.is_some(),
            postmaster,
        }))
    }

    async fn legacy_holds(&self, database: &str) -> Result<bool, units::Error> {
        Ok(self
            .0
            .state()
            .legacy
            .get_mut(database)
            .and_then(|unit| unit.child.as_mut())
            .is_some_and(|child| child.try_wait().ok().flatten().is_none()))
    }

    async fn timestamps(&self, _slot: u32) -> Result<Option<(u64, u64)>, units::Error> {
        Ok(None)
    }
}
