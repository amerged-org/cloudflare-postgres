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
        limits::{Limits, Property},
        ready,
    },
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs, io,
    num::NonZeroU32,
    path::Path,
    process::{Child, Command, Output, Stdio},
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// A unit as the test machine keeps it.
struct Unit {
    child: Option<Child>,
    /// The postmaster ended without being asked to: a crash.
    crashed: bool,
    invocations: u64,
    invocation_id: Option<String>,
    /// The volume the unit mounted when it started, from the agent's link: what it runs on until
    /// it stops, whatever the agent has attached since.
    volume: Option<VolumeId>,
}

#[derive(Default)]
struct State {
    units: HashMap<String, Unit>,
    volumes: BTreeMap<VolumeId, u64>,
    /// The volumes the agent has mounted in its mount namespace, each with its link for the
    /// database's unit: what the agent's restart ends. A unit that runs keeps its own mount.
    attached: BTreeSet<VolumeId>,
    accounts: Vec<String>,
    limits: HashMap<String, Limits>,
    quotas: HashMap<String, Option<NonZeroU32>>,
    /// Calls the tests assert on, in order: `start <id>`, `stop <id>`, `trim <id>`, `remove <id>`.
    calls: Vec<String>,
    no_room: bool,
    available_bytes: u64,
    cpu_calls: u64,
    slice_memory_mib: Option<u64>,
    /// `create_volume` fails once with this.
    volume_error: Option<storage::Error>,
    /// `start` fails once.
    start_fails: bool,
    /// `reboot` fails once, and the node keeps running.
    reboot_fails: bool,
    /// `purge_packages` fails once, as dpkg does for a package that others depend on.
    purge_fails: bool,
    /// How long the next start takes before the postmaster begins.
    start_delay: Option<Duration>,
    /// LVM, or systemd, cannot be read: what they hold is not known.
    volumes_unreadable: bool,
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
    /// How long reading the page cache takes: a disk that is slow to list.
    cache_delay: Option<Duration>,
}

/// The kernel's boot ID of the node's `boots`th boot.
fn boot_id(boots: u64) -> String {
    format!("00000000-0000-4000-8000-{boots:012x}")
}

pub struct Local {
    layout: Layout,
    user: String,
    uid: u32,
    gid: u32,
    state: Mutex<State>,
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
            postgres_bin: bin,
            ..Layout::default()
        };
        let (uid, gid) = {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&root).unwrap();
            (metadata.uid(), metadata.gid())
        };
        Some(Self {
            layout,
            user: testpg::current_user(),
            uid,
            gid,
            state: Mutex::new(State {
                available_bytes: 8 << 30,
                kernel_release: "6.12.111+deb13-amd64".into(),
                ..State::default()
            }),
        })
    }
    pub fn with_layout(mut self, change: impl FnOnce(&mut Layout)) -> Self {
        change(&mut self.layout);
        self
    }
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
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
    /// Whether `database` has a postmaster running.
    pub fn running(&self, database: &str) -> bool {
        let mut state = self.state();
        state
            .units
            .get_mut(database)
            .and_then(|unit| unit.child.as_mut())
            .is_some_and(|child| child.try_wait().ok().flatten().is_none())
    }
    /// SIGKILL: a crash the units do not report.
    pub fn crash(&self, database: &str) {
        let mut state = self.state();
        if let Some(unit) = state.units.get_mut(database)
            && let Some(mut child) = unit.child.take()
        {
            let _ = child.kill();
            let _ = child.wait();
            unit.crashed = true;
            drop(state);
            self.release_shared_memory(database);
        }
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
    pub fn limits(&self, database: &str) -> Option<Limits> {
        self.state().limits.get(database).cloned()
    }
    pub fn quota(&self, database: &str) -> Option<Option<NonZeroU32>> {
        self.state().quotas.get(database).copied()
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
    /// Reading what the page cache holds takes `delay` from now on.
    pub fn slow_cache(&self, delay: Duration) {
        self.state().cache_delay = Some(delay);
    }
    pub fn delay_next_start(&self, delay: Duration) {
        self.state().start_delay = Some(delay);
    }
    pub fn fail_next_start(&self) {
        self.state().start_fails = true;
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
    /// A unit that exists and is stopped, as one is after a stop or a boot.
    pub fn add_stopped_unit(&self, database: &str) {
        self.state().units.insert(
            database.to_string(),
            Unit {
                child: None,
                crashed: false,
                invocations: 0,
                invocation_id: None,
                volume: None,
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
    pub fn has_account(&self, database: &str) -> bool {
        self.state().accounts.iter().any(|a| a == database)
    }
}
impl Drop for Local {
    fn drop(&mut self) {
        let databases: Vec<String> = self.state().units.keys().cloned().collect();
        for database in databases {
            let child = self
                .state()
                .units
                .get_mut(&database)
                .and_then(|unit| unit.child.take());
            if let Some(mut child) = child {
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
        let state = self.state();
        if state.volumes_unreadable {
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
        let state = self.state();
        match state
            .units
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
        let mut state = self.state();
        let mut failures = Vec::new();
        for id in current {
            state.calls.push(format!("mount {}", id.database()));
            if !state.volumes.contains_key(id) {
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
        {
            let mut state = self.state();
            state.calls.push(format!("unmount {}", id.database()));
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
        let mut state = self.state();
        state.calls.push(format!("remove {}", id.database()));
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
        let mut state = self.state();
        if state.units_unreadable {
            return Err(units::Error::NotReady("bus"));
        }
        let memory_max = state.limits.get(database).and_then(|limits| {
            limits
                .properties()
                .iter()
                .find_map(|property| match property {
                    Property::MemoryMax(bytes) => Some(*bytes),
                    _ => None,
                })
        });
        let unit = state.units.get_mut(database);
        let (active, main_pid, invocation_id) = match unit {
            Some(unit) => {
                let alive = unit
                    .child
                    .as_mut()
                    .is_some_and(|child| child.try_wait().ok().flatten().is_none());
                if !alive && unit.child.is_some() {
                    // The postmaster ended on its own.
                    unit.child = None;
                    unit.crashed = true;
                }
                match (&unit.child, unit.crashed) {
                    (Some(child), _) => (
                        ActiveState::Active,
                        Some(child.id()),
                        unit.invocation_id.clone(),
                    ),
                    (None, true) => (ActiveState::Failed, None, unit.invocation_id.clone()),
                    (None, false) => (ActiveState::Inactive, None, unit.invocation_id.clone()),
                }
            }
            None => (ActiveState::Inactive, None, None),
        };
        Ok(UnitState {
            database: database.to_string(),
            active,
            main_pid,
            invocation_id,
            uid: (active == ActiveState::Active).then_some(self.uid),
            memory_max_bytes: memory_max.or(Some(256 << 20)),
        })
    }
    async fn units(&self) -> Result<Vec<UnitState>, units::Error> {
        let databases: Vec<String> = self.state().units.keys().cloned().collect();
        let mut states = Vec::new();
        for database in databases {
            states.push(self.unit(&database).await?);
        }
        Ok(states)
    }
    async fn start(&self, database: &str) -> Result<Started, units::Error> {
        {
            let mut state = self.state();
            state.calls.push(format!("start {database}"));
            if state.start_fails {
                state.start_fails = false;
                return Err(units::Error::Job {
                    unit: units::unit_name(database),
                    result: "failed".into(),
                });
            }
        }
        if self.running(database) {
            return self.wait_started(database).await;
        }
        // The unit asserts the agent's link, and mounts the volume the link names.
        let attached = {
            let state = self.state();
            state
                .attached
                .iter()
                .find(|volume| volume.database() == database)
                .cloned()
        };
        let Some(attached) = attached else {
            return Err(units::Error::Job {
                unit: units::unit_name(database),
                result: "assert".into(),
            });
        };
        let volume = self.layout.volume(database);
        if !self.layout.data(database).join("PG_VERSION").exists() {
            return Err(units::Error::Job {
                unit: units::unit_name(database),
                result: "failed".into(),
            });
        }
        let log = fs::File::create(volume.join("postgres.log"))
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
        let pid = child.id();
        {
            let mut state = self.state();
            let unit = state.units.entry(database.to_string()).or_insert(Unit {
                child: None,
                crashed: false,
                invocations: 0,
                invocation_id: None,
                volume: None,
            });
            unit.volume = Some(attached);
            unit.invocations += 1;
            unit.crashed = false;
            unit.child = Some(child);
            unit.invocation_id = Some(format!("00000000-0000-4000-8000-{:012x}", unit.invocations));
        }
        // A start that takes long, as a recovery does, goes on in systemd whether or not the caller
        // still waits for it.
        let delay = self.state().start_delay.take();
        if let Some(delay) = delay {
            tokio::time::sleep(delay).await;
        }
        let started = Instant::now();
        loop {
            if ready::ready_socket(&volume, pid).is_ok() {
                return self.started(database);
            }
            if !self.running(database) {
                let mut state = self.state();
                if let Some(unit) = state.units.get_mut(database) {
                    unit.child = None;
                    unit.crashed = true;
                }
                return Err(units::Error::Job {
                    unit: units::unit_name(database),
                    result: "failed".into(),
                });
            }
            if started.elapsed() > Duration::from_secs(60) {
                return Err(units::Error::NotReady("postmaster_not_ready"));
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    /// Neither systemd nor a journal runs here: nothing was recorded.
    async fn start_timeline(&self, _: &str, _: &Started) -> Result<Timeline, units::Error> {
        Ok(Timeline::default())
    }
    async fn wait_started(&self, database: &str) -> Result<Started, units::Error> {
        let waited = Instant::now();
        loop {
            match self.started(database) {
                Err(units::Error::NotReady(_))
                    if self.running(database) && waited.elapsed() < Duration::from_secs(60) => {}
                other => return other,
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    async fn stop(&self, database: &str) -> Result<(), units::Error> {
        let child = {
            let mut state = self.state();
            state.calls.push(format!("stop {database}"));
            state.quotas.insert(database.to_string(), None);
            state
                .units
                .get_mut(database)
                .and_then(|unit| unit.child.take())
        };
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
        self.state()
            .limits
            .insert(database.to_string(), limits.clone());
        Ok(())
    }
    async fn set_cpu_quota(
        &self,
        database: &str,
        millicores: Option<NonZeroU32>,
    ) -> Result<(), units::Error> {
        self.state().quotas.insert(database.to_string(), millicores);
        Ok(())
    }
    async fn set_slice_memory(&self, awake_budget_mib: u64) -> Result<(), units::Error> {
        self.state().slice_memory_mib = Some(awake_budget_mib);
        Ok(())
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

    async fn restart_service(&self, unit: &str) -> Result<(), units::Error> {
        self.state().calls.push(format!("restart {unit}"));
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
    /// The resident pages of the real files of the database's directory, as `mincore` says; the
    /// kernel of a laptop has no `cachestat`, and the other counts are not known to `mincore`.
    fn cache_residency(&self, database: &str) -> Option<crate::cache::Residency> {
        let delay = self.state().cache_delay;
        if let Some(delay) = delay {
            std::thread::sleep(delay);
        }
        crate::cache::read(&self.layout.data(database), mincore)
    }
}

/// The pages of `file` that `mincore` finds in memory, of a private mapping of its `length` bytes.
fn mincore(file: &fs::File, length: u64) -> io::Result<crate::cache::Pages> {
    use std::os::fd::AsRawFd;
    let length = usize::try_from(length).map_err(io::Error::other)?;
    if length == 0 {
        return Ok(crate::cache::Pages::default());
    }
    let page = usize::try_from(crate::cache::page_size()).map_err(io::Error::other)?;
    let mut vector = vec![0u8; length.div_ceil(page)];
    // SAFETY: a read-only mapping of an open file, unmapped before the function returns, and
    // `mincore` writes one byte a page into `vector`, which has room for that many.
    let (mapped, failure) = unsafe {
        let map = libc::mmap(
            std::ptr::null_mut(),
            length,
            libc::PROT_READ,
            libc::MAP_PRIVATE,
            file.as_raw_fd(),
            0,
        );
        if map == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        let result = libc::mincore(map, length, vector.as_mut_ptr().cast());
        let failure = io::Error::last_os_error();
        libc::munmap(map, length);
        (result == 0, failure)
    };
    if !mapped {
        return Err(failure);
    }
    Ok(crate::cache::Pages {
        resident: vector.iter().filter(|byte| *byte & 1 == 1).count() as u64,
        ..crate::cache::Pages::default()
    })
}

impl Local {
    /// The facts of a unit that is ready.
    fn started(&self, database: &str) -> Result<Started, units::Error> {
        let mut state = self.state();
        let unit = state
            .units
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
        drop(state);
        let socket = ready::ready_socket(&self.layout.volume(database), main_pid)
            .map_err(units::Error::NotReady)?;
        Ok(Started {
            main_pid,
            invocation_id,
            uid: self.uid,
            socket,
            requested_us: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The double's counts are those of the kernel: a file that was just written is in memory, and
    /// an empty one holds no page.
    #[test]
    fn mincore_finds_the_pages_of_a_file_that_was_just_written() {
        let directory = testpg::directory("mincore");
        let bytes = 64 * 4096;
        fs::write(directory.join("full"), vec![7u8; bytes]).unwrap();
        fs::write(directory.join("empty"), b"").unwrap();
        let full = fs::File::open(directory.join("full")).unwrap();
        let pages = mincore(&full, bytes as u64).unwrap();
        assert_eq!(
            pages.resident,
            (bytes as u64).div_ceil(crate::cache::page_size())
        );
        let empty = fs::File::open(directory.join("empty")).unwrap();
        assert_eq!(mincore(&empty, 0).unwrap().resident, 0);
    }
}
