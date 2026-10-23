// SPDX-License-Identifier: Apache-2.0
//! `Storage`: the pool, the volumes and their recovery, on this node. Every operation reads what
//! lvm2, `dmsetup` and the kernel report now and decides from that; nothing but the latest pool
//! sample and the last volume list is kept in memory, so an agent restart loses nothing. Only a
//! wake's two questions (`exists`, `needs_repair`) answer from the list, and only for a volume it
//! shows as there and not suspect; any other volume is read from lvm2 again.
use super::{
    Activation, CommandRunner, Config, Error, NoRoom, Output, Policy, PoolSample, SystemRunner,
    VOLUME_LIST_MAX_AGE, VolumeId,
    commands::{self, FS_TAG, SUSPECT_TAG},
    host,
    ids::dm_name,
    listing::Listing,
    lvm::{self, GroupStep, LogicalVolume, PoolStep},
    mountinfo::{self, Mount},
    pool::{self, parse_pool, parse_thin_mapped},
    usage::{Inventory, MountInfo, Removal, VolumeInfo},
};
use std::{
    fs,
    io::{self, ErrorKind},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    slice,
    sync::{Arc, Mutex, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard},
    time::{Duration, Instant},
};

/// How many volumes are unmounted at once when the namespace is about to end
/// (`Storage::unmount_all`).
const UNMOUNTS_AT_ONCE: usize = 16;

/// A volume is a whole number of extents; the volume group is made with lvm2's 4 MiB.
const EXTENT_BYTES: u64 = 4 << 20;

/// How long a volume's filesystem may stay alive after its last holder went (or after the agent's
/// own unmount) before a unit or a job is taken to still hold it, and how often `detach` looks.
const SUPERBLOCK_RELEASE_WAIT: Duration = Duration::from_millis(250);
const SUPERBLOCK_POLL: Duration = Duration::from_millis(10);

/// What the kernel says of a volume's device without a process: its minor number, and ext4's
/// error count on that minor.
struct Kernel {
    minor: fn(&str) -> io::Result<u32>,
    ext4_errors: fn(u32) -> io::Result<u64>,
}

pub struct Storage<R = SystemRunner> {
    runner: R,
    config: Config,
    latest: Mutex<Option<PoolSample>>,
    /// Serializes everything that changes the group, the pool or a volume. The mounts of volumes of
    /// different databases only share it: they change nothing of the others.
    changes: RwLock<()>,
    /// One read of the volume list at a time for the questions that any read answers
    /// (`read_lvs_shared`).
    refreshing: Mutex<()>,
    listing: Listing,
    kernel: Kernel,
}

fn check_size(size_bytes: u64) -> Result<(), Error> {
    if size_bytes == 0 || !size_bytes.is_multiple_of(EXTENT_BYTES) {
        return Err(Error::InvalidSize);
    }
    Ok(())
}

impl<R: CommandRunner> Storage<R> {
    pub fn new(runner: R, config: Config) -> Self {
        Self {
            runner,
            config,
            latest: Mutex::new(None),
            changes: RwLock::new(()),
            refreshing: Mutex::new(()),
            listing: Listing::new(VOLUME_LIST_MAX_AGE),
            kernel: Kernel {
                minor: host::block_minor,
                ext4_errors: host::ext4_errors,
            },
        }
    }
    pub fn config(&self) -> &Config {
        &self.config
    }
    /// The device-mapper node of a volume, where its database's write limits are set.
    pub fn device(&self, id: &VolumeId) -> String {
        commands::device(&self.config, id)
    }

    fn lock(&self) -> RwLockWriteGuard<'_, ()> {
        // The lock guards no data: a panic while holding it leaves nothing half-updated in memory.
        self.changes.write().unwrap_or_else(PoisonError::into_inner)
    }
    /// The lock of an operation that changes one database's volume alone and leaves the pool, the
    /// group and the other volumes as they are: the mount. Many hold it at once, none while
    /// something exclusive runs. The caller keeps the operations on one database apart; the
    /// agent's flow of a database does.
    fn lock_shared(&self) -> RwLockReadGuard<'_, ()> {
        self.changes.read().unwrap_or_else(PoisonError::into_inner)
    }
    fn run(&self, command: Vec<String>) -> Result<Output, Error> {
        let output = self.runner.run(&command);
        // Whatever it answered: a command that failed may have changed some of what it was told.
        if commands::changes_volumes(&command) {
            self.listing.changed();
        }
        let output = output?;
        if output.code != 0 {
            return Err(Error::Command {
                program: command[0].clone(),
                code: output.code,
                stderr: output.stderr,
            });
        }
        Ok(output)
    }
    /// The volumes now, from lvm2. The reading is kept for a wake's questions.
    fn read_lvs(&self) -> Result<Arc<Vec<LogicalVolume>>, Error> {
        let read = self.listing.begin();
        let began = Instant::now();
        let output = self.run(commands::lvs(&self.config));
        crate::timing::LVS.add(began.elapsed());
        let lvs = Arc::new(lvm::parse_lvs(&output?.stdout)?);
        self.listing.keep(read, &lvs);
        Ok(lvs)
    }
    /// The volumes, for a question that any read answers that began after the question was asked
    /// (`Listing::since`): the read that is running for another question, or one that ended since
    /// the question began, serves it, and a burst of questions runs `lvs` once or twice and not
    /// once each. The agent decides on every database at its start, and each decision asks.
    fn read_lvs_shared(&self) -> Result<Arc<Vec<LogicalVolume>>, Error> {
        let asked = Instant::now();
        let _turn = self
            .refreshing
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(lvs) = self.listing.since(asked) {
            return Ok(lvs);
        }
        self.read_lvs()
    }
    /// The volumes for a mount: the recent list answers it, as it answers a wake's questions (any
    /// command that changed a volume or a tag made it old), and when there is none, one read for
    /// all that ask.
    fn volumes_for_mount(&self) -> Result<Arc<Vec<LogicalVolume>>, Error> {
        match self.listing.recent() {
            Some(lvs) => Ok(lvs),
            None => self.read_lvs_shared(),
        }
    }
    fn mounts(&self) -> Result<Vec<Mount>, Error> {
        mountinfo::parse(&host::mount_table()?)
    }
    /// A database has one directory, the unit's mount point, whatever generation is mounted.
    fn mount_dir(&self, id: &VolumeId) -> PathBuf {
        self.config.mount_root.join(id.database())
    }
    /// The link of the database's unit (`Config::device_links`), and the device it names for `id`.
    fn link_of(&self, id: &VolumeId) -> (PathBuf, String) {
        (
            self.config.device_links.join(id.database()),
            commands::device(&self.config, id),
        )
    }
    /// Lets the database's unit start on this volume: the link names the device of this
    /// generation, by rename. Only for a volume that the agent has mounted in its namespace and
    /// that is not suspect; the rest of this module drops it before anything detaches, repairs or
    /// removes the volume.
    fn install_link(&self, id: &VolumeId) -> Result<(), Error> {
        let (link, device) = self.link_of(id);
        Ok(host::install_link(&link, &device)?)
    }
    /// Takes the link away while it is this volume's: a start of the unit is refused from then on.
    fn drop_link(&self, id: &VolumeId) -> Result<(), Error> {
        let (link, device) = self.link_of(id);
        Ok(host::drop_link(&link, &device)?)
    }
    /// The agent's start: no link of an earlier agent stays, because the namespace that held the
    /// volumes it names is gone. A volume gets its link back when `mount_all` or a wake attaches
    /// it. The check, which runs `open` as well, must not call this.
    pub fn reset_device_links(&self) -> Result<(), Error> {
        let _guard = self.lock();
        Ok(host::reset_links(&self.config.device_links)?)
    }
    /// Whether the volume is attached: its link for the database's unit names its device. The link
    /// is made last by `attach` and taken first by everything that detaches, repairs or removes
    /// the volume, and is no more after the agent's start, so it is the one fact that says the
    /// agent has the volume mounted and may start a unit on it.
    pub fn attached(&self, id: &VolumeId) -> bool {
        let (link, device) = self.link_of(id);
        host::link_names(&link, &device)
    }
    /// The volume that the process `pid`, a unit's main process, has mounted at the database's
    /// directory, from its own mount table: the unit mounts its volume itself, so this is what it
    /// serves, and the agent's table says nothing of it. `None` when it has no mount there.
    pub fn volume_mounted_by(&self, pid: u32, database: &str) -> Result<Option<VolumeId>, Error> {
        let table = fs::read_to_string(format!("/proc/{pid}/mountinfo"))?;
        self.volume_of_mount(database, &mountinfo::parse(&table)?)
    }
    /// The database volumes mounted at their directories in the mount table of the process `pid`,
    /// with the database each is for: what a slot holds. Read from its mount table alone, and
    /// no mount of the agent's own is needed (the agent has none when it starts).
    pub fn volumes_held_by(&self, pid: u32) -> Result<Vec<(String, Option<VolumeId>)>, Error> {
        let table = fs::read_to_string(format!("/proc/{pid}/mountinfo"))?;
        Ok(self.volumes_in(&mountinfo::parse(&table)?))
    }
    /// Every mount at a database's directory, with the volume it is: `None` for one that cannot be
    /// named (the `lvs` listing failed, or the device is no volume of that database). Such a mount
    /// is held all the same, because it is some filesystem in the process's namespace at a
    /// tenant's directory, and what cannot be named cannot be called idle.
    fn volumes_in(&self, mounts: &[Mount]) -> Vec<(String, Option<VolumeId>)> {
        let mut found: Vec<(String, Option<VolumeId>)> = Vec::new();
        for mount in mounts {
            let Some(database) = mount
                .mount_point
                .strip_prefix(&self.config.mount_root)
                .ok()
                .and_then(|rest| rest.to_str())
                .filter(|rest| pgcf_native_protocol::valid_pattern("database", rest))
            else {
                continue;
            };
            if found.iter().any(|(held, _)| held == database) {
                continue;
            }
            let volume = self.volume_of_mount(database, mounts).ok().flatten();
            found.push((database.to_string(), volume));
        }
        found
    }
    fn volume_of_mount(&self, database: &str, mounts: &[Mount]) -> Result<Option<VolumeId>, Error> {
        let dir = self.config.mount_root.join(database);
        let Some(mount) = mounts.iter().rev().find(|mount| mount.mount_point == dir) else {
            return Ok(None);
        };
        // The device's number says which of the database's volumes it is. The listing is the
        // recent one where there is one: the agent's start asks this for every slot that holds a
        // database, and an `lvs` for each took 13.7 s with 104 of them (EU1, 2026-10-23). Any
        // command that changes a volume ends the listing (`Listing::changed`).
        let lvs = self.volumes_for_mount()?;
        self.database_volumes(&lvs)
            .filter(|(id, _)| id.database() == database)
            .map(|(id, _)| id)
            .find(|id| {
                (self.kernel.minor)(&commands::device(&self.config, id)).ok() == Some(mount.minor)
            })
            .map(Some)
            .ok_or(Error::Unexpected(
                "a mount at the database's directory that is no volume of it",
            ))
    }
    /// The mount of this volume's own filesystem at its directory, if any.
    fn mount_of<'a>(&self, id: &VolumeId, mounts: &'a [Mount]) -> Option<&'a Mount> {
        let (dir, device) = (self.mount_dir(id), commands::device(&self.config, id));
        mounts
            .iter()
            .rev()
            .find(|mount| mount.mount_point == dir && mount.source == device)
    }
    /// The filesystem on top at this volume's directory, whichever volume it is.
    fn top_mount<'a>(&self, id: &VolumeId, mounts: &'a [Mount]) -> Option<&'a Mount> {
        let dir = self.mount_dir(id);
        mounts.iter().rev().find(|mount| mount.mount_point == dir)
    }
    /// The volume whose device-mapper node is `source`.
    fn volume_of_device(&self, source: &str) -> Option<VolumeId> {
        let prefix = format!("/dev/mapper/{}", dm_name(&self.config.group, ""));
        VolumeId::from_lv_name(source.strip_prefix(&prefix)?)
    }
    /// Why `top` keeps `id` from its directory.
    fn occupied(&self, id: &VolumeId, top: &Mount) -> Error {
        match self.volume_of_device(&top.source) {
            Some(other) if other.database() == id.database() => Error::OtherGeneration,
            _ => Error::Unexpected("another filesystem at the volume's directory"),
        }
    }
    /// The volume's LV if it is this database's thin volume.
    fn volume<'a>(
        &self,
        lvs: &'a [LogicalVolume],
        id: &VolumeId,
    ) -> Result<&'a LogicalVolume, Error> {
        let lv = lvs
            .iter()
            .find(|lv| lv.name == id.lv_name())
            .ok_or(Error::Missing)?;
        self.owned(lv, id)?;
        Ok(lv)
    }
    fn owned(&self, lv: &LogicalVolume, id: &VolumeId) -> Result<(), Error> {
        if !lv.is_thin() || lv.pool != self.config.pool || id.tags().iter().any(|t| !lv.has_tag(t))
        {
            return Err(Error::Unexpected("a volume that is not this database's"));
        }
        Ok(())
    }
    /// The thin volumes that are a database's. Any other thin volume counts toward the cap and is
    /// not reported.
    fn database_volumes<'a>(
        &'a self,
        lvs: &'a [LogicalVolume],
    ) -> impl Iterator<Item = (VolumeId, &'a LogicalVolume)> {
        lvs.iter().filter(|lv| lv.is_thin()).filter_map(|lv| {
            let id = VolumeId::from_lv_name(&lv.name)?;
            self.owned(lv, &id).ok().map(|()| (id, lv))
        })
    }

    /// First boot and every start of the agent: the volume group and the pool exist as plan 4.3
    /// describes, or are made; the group is active. A disk, group or pool that is something else
    /// is an error, never repaired in place. What the activation had to do besides `vgchange` is
    /// in the answer, for the caller to report.
    pub fn open(&self) -> Result<Activation, Error>
    where
        R: Sync,
    {
        let _guard = self.lock();
        let device = fs::canonicalize(&self.config.device)?;
        // The three reports of a node that is set up do not depend on each other: they are asked
        // for at once (each is 100 to 300 ms with hundreds of volumes, and the agent's start waits
        // for the storage). The volumes are read on a node that has no group yet as well; that
        // read fails, and the first boot goes on without it.
        let (pvs, vgs, lvs) = std::thread::scope(|scope| {
            let lvs = scope.spawn(|| self.read_lvs());
            let pvs = scope.spawn(|| self.run(commands::pvs()));
            let vgs = self.run(commands::vgs());
            (
                pvs.join()
                    .unwrap_or(Err(Error::Unexpected("the physical volumes"))),
                vgs,
                lvs.join().unwrap_or(Err(Error::Unexpected("the volumes"))),
            )
        });
        let device = lvm::parse_pvs(&pvs?.stdout)?
            .into_iter()
            .find(|pv| Path::new(&pv.name) == device);
        let mut groups = lvm::parse_vgs(&vgs?.stdout)?;
        let steps = lvm::plan_group(&self.config, device.as_ref(), &groups)?;
        // What was made is read again; what was not is the report the plan was made from.
        let mut lvs = lvs.ok();
        if !steps.is_empty() {
            for step in steps {
                self.run(match step {
                    GroupStep::CreatePhysicalVolume => commands::pvcreate(&self.config),
                    GroupStep::CreateGroup => commands::vgcreate(&self.config),
                })?;
            }
            groups = lvm::parse_vgs(&self.run(commands::vgs())?.stdout)?;
            lvs = None;
        }
        let group = groups
            .into_iter()
            .find(|group| group.name == self.config.group)
            .ok_or(Error::Unexpected("the volume group"))?;
        // An agent that restarts finds the pool and every volume active, and there is nothing to
        // activate: `vgchange` reads the metadata of every volume to find that out (150 to 350
        // ms with 312 of them). After a boot nothing is active, and it is run.
        let active = lvs
            .as_ref()
            .is_some_and(|lvs| !lvs.is_empty() && lvs.iter().all(|lv| lv.is_active()));
        let activation = if active {
            Activation::default()
        } else {
            lvs = None;
            self.activate_group()?
        };
        let lvs = match lvs {
            Some(lvs) => lvs,
            None => self.read_lvs()?,
        };
        let steps = lvm::plan_pool(&self.config, &group, &lvs)?;
        if steps.is_empty() {
            return Ok(activation);
        }
        for step in steps {
            self.run(match step {
                PoolStep::Create { data_bytes } => commands::pool_create(&self.config, data_bytes),
                PoolStep::ErrorWhenFull => commands::error_when_full(&self.config),
            })?;
        }
        // What was made is what plan 4.3 asks for, or the pool is not trusted.
        if !lvm::plan_pool(&self.config, &group, &self.read_lvs()?)?.is_empty() {
            return Err(Error::Unexpected("the thin pool after creating it"));
        }
        Ok(activation)
    }

    /// Activates the group, and the pool with it. A reset that was not clean can leave the pool's
    /// metadata with a leaked block (a block the space map counts that no mapping uses), which
    /// lvm2's own check refuses: `vgchange` ends with 5 and the pool, with every database on the
    /// node, stays down (found live on EU1, 2026-10-23, 27 minutes of a crash-looping agent).
    /// When the plain activation fails:
    ///
    /// 1. A part of the pool that is active on its own keeps lvm2 from activating the pool (an
    ///    inspection of the metadata does it). It is deactivated, which is safe because a pool
    ///    that is not active has no active volume, and the plain activation is tried again.
    /// 2. Otherwise the activation is tried once more with `thin_check --auto-repair`
    ///    (`commands::REPAIRING_CHECK`), which repairs a leak and nothing else and writes nothing
    ///    when the trees are damaged. A damaged pool stays down with the error of `vgchange`: the
    ///    agent stops and the node goes stale, and only an operator decides what happens to it.
    fn activate_group(&self) -> Result<Activation, Error> {
        match self.run(commands::activate(&self.config)) {
            Ok(_) => return Ok(Activation::default()),
            Err(Error::Command { .. }) => {}
            Err(other) => return Err(other),
        }
        let mut activation = Activation::default();
        // A report that cannot be read leaves the parts to the operator; the repair still runs.
        let listed = self
            .run(commands::volume_attributes(&self.config))
            .and_then(|output| lvm::active_pool_parts(&self.config.pool, &output.stdout))
            .unwrap_or_default();
        for part in &listed {
            self.run(commands::deactivate_pool_part(&self.config, part))?;
            activation.released_parts.push(part.clone());
        }
        if !listed.is_empty() && self.run(commands::activate(&self.config)).is_ok() {
            return Ok(activation);
        }
        self.run(commands::activate_repairing(&self.config))?;
        activation.repair_run = true;
        Ok(activation)
    }

    /// Reads the pool now and keeps the reading for `room`. A read that fails leaves no reading,
    /// so `room` answers `Unobserved` rather than the last healthy sample.
    fn read_pool(&self) -> Result<PoolSample, Error> {
        // A delayed status/table command cannot make old facts appear newly observed.
        let observed = Instant::now();
        let sample = self.run(commands::dm_status_pool()).and_then(|status| {
            let table = self.run(commands::dm_table_pool())?;
            parse_pool(
                &self.config.group,
                &self.config.pool,
                &status.stdout,
                &table.stdout,
                observed,
            )
        });
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) = sample.as_ref().ok().cloned();
        sample
    }

    /// Reads the pool (plan 4.3: every 5 s) and keeps the reading for `room`. A reading that shows
    /// a pool without writes tags every mounted volume as suspect first (`mark_suspects`).
    pub fn poll_pool(&self) -> Result<PoolSample, Error> {
        let sample = self.read_pool()?;
        if !sample.writable() {
            self.mark_suspects(&self.lock())?;
        }
        Ok(sample)
    }

    /// `poll_pool` inside a change, which holds the lock.
    fn sample_pool(&self, held: &RwLockWriteGuard<'_, ()>) -> Result<PoolSample, Error> {
        let sample = self.read_pool()?;
        if !sample.writable() {
            self.mark_suspects(held)?;
        }
        Ok(sample)
    }

    /// While the pool takes no writes, a mounted ext4 loses metadata blocks without recording an
    /// error: only a later write notices, and PostgreSQL stops at its first failed WAL write and
    /// makes none. So the pool's state, not ext4's error count, decides which volumes may be
    /// damaged: every volume that is open now, whoever has it open. The agent's own mount table
    /// is no witness: the agent has mounted what its namespace has since it started, and a unit
    /// or a job mounts the volume in a namespace of its own. The tag is LVM metadata, so it
    /// outlives the agent and the node, and it stays until `recover_volume` has repaired the
    /// volume.
    fn mark_suspects(&self, _held: &RwLockWriteGuard<'_, ()>) -> Result<(), Error> {
        let lvs = self.read_lvs()?;
        let open: Vec<(VolumeId, bool)> = self
            .database_volumes(&lvs)
            .filter(|(_, lv)| lv.is_open())
            .map(|(id, lv)| (id, lv.has_tag(SUSPECT_TAG)))
            .collect();
        let unmarked: Vec<VolumeId> = open
            .iter()
            .filter(|(_, suspect)| !suspect)
            .map(|(id, _)| id.clone())
            .collect();
        if !unmarked.is_empty() {
            self.run(commands::volumes_add_tag(
                &self.config,
                &unmarked,
                SUSPECT_TAG,
            ))?;
        }
        // A suspect volume may not be started on, whoever asks: every volume open now has no
        // link, also one a failed attempt left, which the tag no longer makes a candidate. Units
        // that run keep their own mounts and are stopped by their databases' recovery.
        for (id, _) in &open {
            self.drop_link(id)?;
        }
        Ok(())
    }

    /// The room rule of plan 4.6 on the latest `poll_pool` reading.
    pub fn room(&self, policy: &Policy) -> Result<(), NoRoom> {
        let latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        pool::room(latest.as_ref(), Instant::now(), policy)
    }

    /// Every volume with its pool use, mount, space and inodes: the volume report of plan 4.3,
    /// read every 60 s. A volume that is not active holds chunks no tool reports, so it fails the
    /// inventory instead of reporting none.
    pub fn inventory(&self) -> Result<Inventory, Error> {
        let lvs = self.read_lvs()?;
        let mapped = parse_thin_mapped(&self.run(commands::dm_status_thin())?.stdout)?;
        let mounts = self.mounts()?;
        let mut volumes = Vec::new();
        for (id, lv) in self.database_volumes(&lvs) {
            let name = dm_name(&self.config.group, &lv.name);
            let pool_used_bytes = mapped
                .iter()
                .find(|(device, _)| *device == name)
                .map(|(_, bytes)| *bytes)
                .ok_or(Error::Unexpected("a volume that is not active"))?;
            let mount = match self.mount_of(&id, &mounts) {
                Some(mount) => Some(MountInfo {
                    usage: host::fs_usage(&mount.mount_point)?,
                }),
                None => None,
            };
            let fs_errors = self.fs_errors(&id)?;
            volumes.push(VolumeInfo {
                id,
                size_bytes: lv.size_bytes,
                pool_used_bytes,
                formatted: lv.has_tag(FS_TAG),
                suspect: lv.has_tag(SUSPECT_TAG),
                fs_errors,
                mount,
            });
        }
        Ok(Inventory {
            volumes,
            nominal_bytes: lvs
                .iter()
                .filter(|lv| lv.is_thin())
                .map(|lv| lv.size_bytes)
                .sum(),
        })
    }

    /// ext4's count of errors on the volume's filesystem, from its entry for the device
    /// (`/sys/fs/ext4/dm-<minor>`), which exists while a superblock does, in any mount namespace:
    /// the agent's own, a unit's or a job's. `None` when no filesystem of the volume is alive (no
    /// device, or no entry). This is what says that a volume is held, and the agent's own mount
    /// table never does: after an agent's restart it lists none of what the units have.
    fn ext4_entry(&self, id: &VolumeId) -> Result<Option<u64>, Error> {
        let absent = |error: io::Error| match error.kind() {
            ErrorKind::NotFound => Ok(None),
            _ => Err(Error::from(error)),
        };
        match (self.kernel.minor)(&commands::device(&self.config, id)) {
            Ok(minor) => match (self.kernel.ext4_errors)(minor) {
                Ok(errors) => Ok(Some(errors)),
                Err(error) => absent(error),
            },
            Err(error) => absent(error),
        }
    }

    /// Whether ext4 recorded an error on the volume's filesystem, wherever it is mounted. A device
    /// with no filesystem mounted has no error to count.
    fn fs_errors(&self, id: &VolumeId) -> Result<bool, Error> {
        Ok(self.ext4_entry(id)?.is_some_and(|errors| errors > 0))
    }

    /// Whether a filesystem of the volume is still alive a moment after the agent's own mount of
    /// it went or never was: a unit or a job holds it in a namespace of its own. A holder that has
    /// just ended leaves its namespace, and the superblock with it, a moment after (lab: 1 to 2
    /// ms, 20 runs), which the wait covers many times over.
    fn held(&self, id: &VolumeId) -> Result<bool, Error> {
        let ended = Instant::now() + SUPERBLOCK_RELEASE_WAIT;
        loop {
            match self.ext4_entry(id)? {
                None => return Ok(false),
                Some(_) if Instant::now() >= ended => return Ok(true),
                Some(_) => std::thread::sleep(SUPERBLOCK_POLL),
            }
        }
    }

    /// The directory is the database's, one generation at a time: refuses with `OtherGeneration`
    /// while a filesystem of another generation of `id`'s database is alive, whoever holds it. The
    /// agent's mount table does not tell, since after its restart a unit that runs has the old
    /// generation and the agent has none of its own, and a unit that is started on the next
    /// generation while the old one runs is not started at all: systemd leaves it running.
    fn ensure_no_other_generation_alive(
        &self,
        id: &VolumeId,
        lvs: &[LogicalVolume],
    ) -> Result<(), Error> {
        // By name first: a boot attaches every volume, and a database nearly always has one.
        let prefix = format!("db_{}_g", id.database());
        for lv in lvs.iter().filter(|lv| lv.name.starts_with(&prefix)) {
            let Some(other) = VolumeId::from_lv_name(&lv.name) else {
                continue;
            };
            if other != *id && self.owned(lv, &other).is_ok() && self.held(&other)? {
                return Err(Error::OtherGeneration);
            }
        }
        Ok(())
    }

    /// What the recent list and the kernel say of the volume, without a process: whether it is
    /// tagged as suspect, and the minor number of its device. `None` when the list is old or
    /// changed, does not show the volume as this database's, or the kernel has no device for it.
    fn listed(&self, id: &VolumeId) -> Option<(bool, u32)> {
        let lvs = self.listing.recent()?;
        let suspect = self.volume(&lvs, id).ok()?.has_tag(SUSPECT_TAG);
        let minor = (self.kernel.minor)(&commands::device(&self.config, id)).ok()?;
        Some((suspect, minor))
    }

    /// Call when a process other than this one may have changed a volume or a tag: the health
    /// check, which runs with a storage of its own.
    pub fn changed_elsewhere(&self) {
        self.listing.changed();
    }

    /// Whether the database's volume of this generation exists on the node. A yes can come from
    /// the recent list; a no, and any doubt, is read from lvm2.
    pub fn exists(&self, id: &VolumeId) -> Result<bool, Error> {
        if self.listed(id).is_some() {
            return Ok(true);
        }
        match self.volume(&self.read_lvs_shared()?, id) {
            Ok(_) => Ok(true),
            Err(Error::Missing) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Whether the volume must be repaired (`recover_volume`) before its database starts again:
    /// the one question a wake asks about a volume, without reading every volume's space. A
    /// volume the recent list shows as not suspect, and whose filesystem is mounted, is decided
    /// by ext4's error count alone; the tag, and any doubt, is read from lvm2.
    pub fn needs_repair(&self, id: &VolumeId) -> Result<bool, Error> {
        if let Some((false, minor)) = self.listed(id)
            && let Ok(errors) = (self.kernel.ext4_errors)(minor)
        {
            return Ok(errors > 0);
        }
        if self
            .volume(&self.read_lvs_shared()?, id)?
            .has_tag(SUSPECT_TAG)
        {
            return Ok(true);
        }
        self.fs_errors(id)
    }

    /// The volumes a pool without writes tagged as suspect (`mark_suspects`) and no repair has
    /// cleared since, whoever has them open: what the repair of the sleeping databases' volumes
    /// goes through once the pool takes writes again. From the recent list, which any command
    /// that changes a tag makes old; one lvm2 read otherwise.
    pub fn suspects(&self) -> Result<Vec<VolumeId>, Error> {
        let lvs = self.volumes_for_mount()?;
        Ok(self
            .database_volumes(&lvs)
            .filter(|(_, lv)| lv.has_tag(SUSPECT_TAG))
            .map(|(id, _)| id)
            .collect())
    }

    /// The logical cap of plan 4.3: nominal sizes stay at or below a multiple of the pool.
    fn within_cap(
        &self,
        sample: &PoolSample,
        lvs: &[LogicalVolume],
        adding_bytes: u64,
    ) -> Result<(), Error> {
        let nominal_bytes = lvs
            .iter()
            .filter(|lv| lv.is_thin())
            .map(|lv| lv.size_bytes)
            .sum::<u64>()
            + adding_bytes;
        let cap_bytes = sample
            .data_total_bytes
            .saturating_mul(self.config.logical_cap_factor);
        if nominal_bytes > cap_bytes {
            return Err(Error::LogicalCap {
                nominal_bytes,
                cap_bytes,
            });
        }
        Ok(())
    }

    /// Creates the database's volume, its ext4 and its mount, or finishes what an earlier call
    /// left: the room rule and the logical cap hold for a new volume, an existing one is never
    /// formatted twice, and one of another size is an error. Another generation of the database
    /// that is mounted refuses the create before anything is made.
    pub fn create_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
        policy: &Policy,
    ) -> Result<(), Error> {
        check_size(size_bytes)?;
        let guard = self.lock();
        let device = commands::device(&self.config, id);
        let mounts = self.mounts()?;
        if let Some(top) = self
            .top_mount(id, &mounts)
            .filter(|top| top.source != device)
        {
            return Err(self.occupied(id, top));
        }
        let lvs = self.read_lvs()?;
        self.ensure_no_other_generation_alive(id, &lvs)?;
        let sample = self.sample_pool(&guard)?;
        pool::room(Some(&sample), Instant::now(), policy).map_err(Error::NoRoom)?;
        let (formatted, suspect) = match self.volume(&lvs, id) {
            Ok(lv) if lv.size_bytes != size_bytes => {
                return Err(Error::Unexpected("a volume of another size"));
            }
            Ok(lv) => (lv.has_tag(FS_TAG), lv.has_tag(SUSPECT_TAG)),
            Err(Error::Missing) => {
                self.within_cap(&sample, &lvs, size_bytes)?;
                self.run(commands::volume_create(&self.config, id, size_bytes))?;
                (false, false)
            }
            Err(error) => return Err(error),
        };
        if !formatted {
            if mounts.iter().any(|mount| mount.source == device) {
                return Err(Error::Mounted);
            }
            self.run(commands::mkfs(&self.config, id, size_bytes))?;
            self.run(commands::volumes_add_tag(
                &self.config,
                slice::from_ref(id),
                FS_TAG,
            ))?;
        }
        self.attach(id, suspect, &lvs)
    }

    /// Mounts the formatted volume at its directory with mode 0700, unless it is, and then gives
    /// the database's unit its link. The directory is the database's, so a filesystem of another
    /// volume on it, another generation's included, refuses the mount. A volume tagged as suspect
    /// is not mounted: `recover_volume` repairs it first; one that is mounted and suspect keeps
    /// its mount and has no link. A filesystem of another generation that a unit or a job holds
    /// refuses it too (`ensure_no_other_generation_alive`), `lvs` being what lvm2 lists now.
    fn attach(&self, id: &VolumeId, suspect: bool, lvs: &[LogicalVolume]) -> Result<(), Error> {
        let (dir, device) = (self.mount_dir(id), commands::device(&self.config, id));
        // The table is read now: an earlier attach of the same call has changed it.
        if let Some(top) = self.top_mount(id, &self.mounts()?) {
            if top.source != device {
                return Err(self.occupied(id, top));
            }
            return if suspect {
                self.drop_link(id)
            } else {
                self.install_link(id)
            };
        }
        if suspect {
            return Err(Error::NeedsRepair);
        }
        self.ensure_no_other_generation_alive(id, lvs)?;
        // Traversable but not listable: a database reaches its own directory only.
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o711)
            .create(&self.config.mount_root)?;
        match fs::DirBuilder::new().mode(0o700).create(&dir) {
            Err(error) if error.kind() != ErrorKind::AlreadyExists => return Err(error.into()),
            _ => {}
        }
        let began = Instant::now();
        let mounted = self.mount_own(id);
        crate::timing::MOUNT.add(began.elapsed());
        mounted?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        // Last: the link is the unit's permission to start, and exists only for what is mounted.
        self.install_link(id)
    }

    /// Mounts only this volume, with no tenant quota or reduced-capacity share.
    fn mount_own(&self, id: &VolumeId) -> Result<(), Error> {
        host::mount_ext4(&commands::device(&self.config, id), &self.mount_dir(id))?;
        Ok(())
    }

    /// Makes `grow` or `mount` see a formatted volume.
    fn formatted<'a>(
        &self,
        lvs: &'a [LogicalVolume],
        id: &VolumeId,
    ) -> Result<&'a LogicalVolume, Error> {
        let lv = self.volume(lvs, id)?;
        if !lv.has_tag(FS_TAG) {
            return Err(Error::Unexpected("a volume without a filesystem"));
        }
        Ok(lv)
    }

    /// Grows the volume and its filesystem (plan 3.5: storage never shrinks). The logical
    /// cap holds; a sleeping database's volume is mounted first, as `resize2fs` needs it, and a
    /// suspect volume is repaired before it grows. It ends well only when the filesystem has the
    /// size: `resize2fs` that ends 0 and leaves the filesystem as it was is an error. Legacy
    /// geometry grows offline, after every mount holder is gone; it is never reformatted.
    pub fn grow_volume(&self, id: &VolumeId, size_bytes: u64) -> Result<(), Error> {
        check_size(size_bytes)?;
        let guard = self.lock();
        let lvs = self.read_lvs()?;
        let lv = self.formatted(&lvs, id)?;
        if lv.has_tag(SUSPECT_TAG) {
            return Err(Error::NeedsRepair);
        }
        let current = lv.size_bytes;
        if size_bytes < current {
            return Err(Error::Shrink);
        }
        // The resize writes: not into a pool that takes none.
        let sample = self.sample_pool(&guard)?;
        if !sample.writable() {
            return Err(Error::NoRoom(NoRoom::Unwritable));
        }
        if size_bytes > current {
            self.within_cap(&sample, &lvs, size_bytes - current)?;
        }
        let target = commands::fs_target_kib(size_bytes) * 1024;
        let geometry = host::read_superblock(&commands::device(&self.config, id))?;
        if geometry.bytes() >= target {
            return self.attach(id, false, &lvs);
        }
        let offline = !geometry.online_grow();
        if offline {
            // The kernel checks all mount namespaces, including pooled units and backup jobs.
            // A busy detach restores the agent's mount; restore the start link too.
            if let Err(error) = self.detach(id) {
                self.restore_link(id);
                return Err(match error {
                    Error::Busy => Error::OfflineGrowRequired,
                    other => other,
                });
            }
            // Interrupted or failed offline work must be checked before a subsequent mount.
            self.run(commands::volumes_add_tag(
                &self.config,
                slice::from_ref(id),
                SUSPECT_TAG,
            ))?;
            let check = self
                .runner
                .run(&commands::check_before_grow(&self.config, id))?;
            if !matches!(check.code, 0 | 1) {
                return Err(Error::Fsck(check.code));
            }
        } else {
            self.attach(id, false, &lvs)?;
        }
        if size_bytes > current {
            self.run(commands::volume_extend(&self.config, id, size_bytes))?;
        }
        self.run(commands::resize_fs(&self.config, id, size_bytes))?;
        if self.filesystem_bytes(id)? < target {
            return Err(Error::Unexpected("the filesystem did not grow"));
        }
        if offline {
            self.run(commands::volume_delete_tag(&self.config, id, SUSPECT_TAG))?;
            self.attach(id, false, &lvs)?;
        }
        Ok(())
    }

    /// The size of the volume's filesystem, from its superblock: what `resize2fs` made it.
    pub fn filesystem_bytes(&self, id: &VolumeId) -> Result<u64, Error> {
        Ok(host::read_superblock(&commands::device(&self.config, id))?.bytes())
    }

    pub fn mount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock_shared();
        let lvs = self.volumes_for_mount()?;
        let suspect = self.formatted(&lvs, id)?.has_tag(SUSPECT_TAG);
        self.attach(id, suspect, &lvs)
    }

    /// After a boot, and after an agent's restart, which ends its mount namespace and with it every
    /// mount it made: mounts the formatted volume of each database in `current`, as sleeping
    /// databases keep theirs mounted. `current` is the storage generation the page names for each
    /// database: an older generation that has not been removed yet is never mounted, and the unit
    /// would start its data. A volume that does not mount is returned and the others still are.
    /// One that does not exist, or whose create stopped before its filesystem, is the create's to
    /// finish. The agent mounts a database's volume when it decides on the database, many at once
    /// (each mount waits for the disk), and a wake attaches the volume it needs.
    pub fn mount_all(&self, current: &[VolumeId]) -> Result<Vec<(VolumeId, Error)>, Error> {
        let _guard = self.lock_shared();
        let lvs = self.volumes_for_mount()?;
        let mut failures = Vec::new();
        for id in current {
            let lv = match self.volume(&lvs, id) {
                Ok(lv) if lv.has_tag(FS_TAG) => lv,
                Ok(_) | Err(Error::Missing) => continue,
                Err(error) => {
                    failures.push((id.clone(), error));
                    continue;
                }
            };
            if let Err(error) = self.attach(id, lv.has_tag(SUSPECT_TAG), &lvs) {
                failures.push((id.clone(), error));
            }
        }
        Ok(failures)
    }

    /// Unmounts the volume's own filesystem, after taking its link away: from the first moment no
    /// unit can be started on a volume that is going. What is on top at its directory must be that
    /// filesystem; `umount` would take whatever is on top.
    ///
    /// A unit or a job mounts the volume in a namespace of its own, and the agent's mount table
    /// does not list that mount: after the agent's restart it lists none of the volumes, and a
    /// mount of its own is not busy because of another namespace's. So the answer comes from the
    /// kernel: ext4's entry for the device exists as long as any namespace has the superblock
    /// (`held`). The volume is detached when the entry is gone after the agent's own unmount, or
    /// was not there to begin with. If it stays, the volume is held: the agent mounts it again
    /// where it had unmounted it, and the call is `Busy`.
    fn detach(&self, id: &VolumeId) -> Result<(), Error> {
        self.drop_link(id)?;
        let mounts = self.mounts()?;
        let Some(own) = self.mount_of(id, &mounts) else {
            return if self.held(id)? {
                Err(Error::Busy)
            } else {
                Ok(())
            };
        };
        if self.top_mount(id, &mounts) != Some(own) {
            return Err(Error::Unexpected(
                "another filesystem above the volume's mount",
            ));
        }
        // No force and no lazy detach: a filesystem that something holds stays mounted.
        host::unmount(&self.mount_dir(id)).map_err(|error| match error.raw_os_error() {
            Some(libc::EBUSY) => Error::Busy,
            _ => error.into(),
        })?;
        if self.held(id)? {
            self.mount_own(id)?;
            return Err(Error::Busy);
        }
        Ok(())
    }

    /// The exit of an agent that did not join the holder's namespace, and the stop of the holder
    /// (`mount_holder`): unmounts the volumes mounted here, many at once. A process that exits
    /// leaves its mount namespace, and the kernel unmounts what the namespace holds one after the
    /// other, each as slow as the disk's flushes (lab: 89 ms each, and EU1's agent took 14 s to
    /// stop with 301 volumes). The process is not gone until it has, and systemd starts the next
    /// agent after it. A mount that is busy stays for the kernel, as does everything when an
    /// operation that changes volumes does not end in two seconds. The databases run on: a unit
    /// has a mount of its own, and the superblock stays.
    pub fn unmount_all(&self) {
        let mut waited = 0;
        let _guard = loop {
            match self.changes.try_write() {
                Ok(guard) => break guard,
                Err(std::sync::TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) if waited < 100 => {
                    waited += 1;
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(std::sync::TryLockError::WouldBlock) => return,
            }
        };
        let Ok(mounts) = self.mounts() else {
            return;
        };
        let mut ours: Vec<PathBuf> = mounts
            .iter()
            .filter(|mount| {
                mount.mount_point.parent() == Some(self.config.mount_root.as_path())
                    && self.volume_of_device(&mount.source).is_some()
            })
            .map(|mount| mount.mount_point.clone())
            .collect();
        ours.sort();
        ours.dedup();
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..UNMOUNTS_AT_ONCE.min(ours.len()) {
                scope.spawn(|| {
                    while let Some(directory) =
                        ours.get(next.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
                    {
                        let _ = host::unmount(directory);
                    }
                });
            }
        });
    }

    pub fn unmount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock();
        let result = self.detach(id);
        if result.is_err() {
            // The volume is still attached, so its unit may still be started on it.
            self.restore_link(id);
        }
        result
    }

    /// After an unmount that did not happen: the link of a volume that is still mounted and not
    /// suspect. A failure here leaves the volume without a link, which refuses starts: the next
    /// attach of the volume makes it again.
    fn restore_link(&self, id: &VolumeId) {
        let attached = self
            .mounts()
            .is_ok_and(|mounts| self.mount_of(id, &mounts).is_some());
        let suspect = self
            .read_lvs()
            .and_then(|lvs| Ok(self.volume(&lvs, id)?.has_tag(SUSPECT_TAG)))
            .unwrap_or(true);
        if attached && !suspect {
            let _ = self.install_link(id);
        }
    }

    /// Removes the volume of a deleted database or of a superseded generation, and its chunks
    /// return to the pool. Never a volume that is mounted, one that is not a database volume, or
    /// one the order does not release. The database's directory goes with its last volume.
    pub fn remove_volume(&self, id: &VolumeId, removal: Removal) -> Result<(), Error> {
        if !removal.releases(id) {
            return Err(Error::NotAuthorised);
        }
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        match self.volume(&lvs, id) {
            Ok(_) => {
                let device = commands::device(&self.config, id);
                if self.mounts()?.iter().any(|mount| mount.source == device) {
                    return Err(Error::Mounted);
                }
                self.drop_link(id)?;
                self.remove_logical_volume(id)?;
            }
            // Removing what is gone is done; its empty directory and its link may remain.
            Err(Error::Missing) => self.drop_link(id)?,
            Err(error) => return Err(error),
        }
        let others = self
            .database_volumes(&lvs)
            .any(|(other, _)| other.database() == id.database() && other != *id);
        if others {
            return Ok(());
        }
        match fs::remove_dir(self.mount_dir(id)) {
            Err(error) if error.kind() != ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }

    /// `lvremove` of a volume that no mount of the agent holds. A unit or a job has its own
    /// mount of the volume, in a namespace the agent's mount table does not list, so the refusal
    /// of lvm2 ("in use") is what tells that one still has it, and it is `Busy`. lvm2 itself asks
    /// again for about five seconds before it refuses (`activation/retry_deactivation`), which
    /// covers the moment in which the device of a unit or a job that has just ended is still open
    /// (measured in the lab: 40-240 ms); a job that runs on is for the caller to try again.
    fn remove_logical_volume(&self, id: &VolumeId) -> Result<(), Error> {
        match self.run(commands::volume_remove(&self.config, id)) {
            Err(Error::Command { stderr, .. }) if stderr.contains(" in use") => Err(Error::Busy),
            other => other.map(|_| ()),
        }
    }

    /// Returns the filesystem's free blocks to the pool (plan 4.3: after every clean sleep).
    pub fn trim_volume(&self, id: &VolumeId) -> Result<(), Error> {
        if self.mount_of(id, &self.mounts()?).is_none() {
            return Err(Error::NotMounted);
        }
        self.run(commands::trim(&self.config, id))?;
        Ok(())
    }

    /// Full-pool recovery of one volume (plan 4.3), once its database's unit is stopped: unmounts
    /// it, repairs it with `e2fsck -p`, takes it off the suspects and mounts it again. The pool
    /// must take writes with space above the reserve, as the repair writes. Waking the database
    /// is the caller's, through admission.
    ///
    /// A pool without writes can leave the journal with committed transactions while the
    /// filesystem's `needs_recovery` flag is clear. `-p` then refuses (4); the journal is replayed
    /// by setting the flag, and `-p` runs again. Anything it still refuses needs an operator.
    ///
    /// Between the two `e2fsck` runs the flag is set with `debugfs -w`, which does not refuse a
    /// filesystem that another namespace has mounted (lab: it wrote one, where `e2fsck` stopped
    /// with 8). Nothing can mount the device then: the volume is detached first, which is refused
    /// (`Busy`) while a unit or a job holds the filesystem; the unit cannot start without its
    /// link, which is gone; and a job starts only from a flow of the database, which waits for the
    /// database's lock that the recovery holds, or at the request of the database's own
    /// processes, of which the stopped unit has none.
    pub fn recover_volume(&self, id: &VolumeId, policy: &Policy) -> Result<(), Error> {
        let guard = self.lock();
        // First of all: from here on no start may run on a volume that is being repaired, and the
        // link comes back only with the repaired volume's attach.
        self.drop_link(id)?;
        let lvs = self.read_lvs()?;
        let suspect = self.formatted(&lvs, id)?.has_tag(SUSPECT_TAG);
        let sample = self.sample_pool(&guard)?;
        pool::room(Some(&sample), Instant::now(), policy).map_err(Error::NoRoom)?;
        self.detach(id)?;
        let mut code = self.runner.run(&commands::fsck(&self.config, id))?.code;
        if code == 4 {
            self.run(commands::replay_journal(&self.config, id))?;
            code = self.runner.run(&commands::fsck(&self.config, id))?.code;
        }
        // 0: clean, 1: errors corrected. Anything else needs an operator.
        if !matches!(code, 0 | 1) {
            return Err(Error::Fsck(code));
        }
        if suspect {
            self.run(commands::volume_delete_tag(&self.config, id, SUSPECT_TAG))?;
        }
        self.attach(id, false, &lvs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        sync::atomic::{AtomicBool, Ordering},
        time::Duration,
    };

    /// Answers the pool commands with `dmsetup` output recorded from a pool, until told to fail.
    struct Recorded(AtomicBool);

    impl CommandRunner for Recorded {
        fn run(&self, command: &[String]) -> io::Result<Output> {
            if self.0.load(Ordering::Relaxed) {
                return Ok(Output {
                    code: 1,
                    stdout: String::new(),
                    stderr: "device-mapper: status ioctl failed".into(),
                });
            }
            let stdout = match command.get(1).map(String::as_str) {
                Some("status") => include_str!("fixtures/dm-status-pool.txt"),
                Some("table") => include_str!("fixtures/dm-table-pool.txt"),
                _ => return Err(io::Error::from(io::ErrorKind::InvalidInput)),
            };
            Ok(Output {
                code: 0,
                stdout: stdout.into(),
                stderr: String::new(),
            })
        }
    }

    /// Answers each command with the first of the queued answers whose words it contains, in
    /// order, and with success when none is left; keeps the command lines it ran.
    struct Scripted(
        Mutex<Vec<(&'static str, i32, &'static str)>>,
        Mutex<Vec<String>>,
    );
    impl Scripted {
        fn new(answers: Vec<(&'static str, i32, &'static str)>) -> Storage<Self> {
            Storage::new(
                Self(Mutex::new(answers), Mutex::default()),
                Config::default(),
            )
        }
    }
    impl CommandRunner for Scripted {
        fn run(&self, command: &[String]) -> io::Result<Output> {
            let line = command.join(" ");
            self.1.lock().unwrap().push(line.clone());
            let mut answers = self.0.lock().unwrap();
            let at = answers
                .iter()
                .position(|(needle, ..)| line.contains(needle));
            let (code, stdout) = at.map_or((0, ""), |at| {
                let (_, code, stdout) = answers.remove(at);
                (code, stdout)
            });
            Ok(Output {
                code,
                stdout: stdout.into(),
                stderr: String::new(),
            })
        }
    }
    fn ran(storage: &Storage<Scripted>) -> Vec<String> {
        storage.runner.1.lock().unwrap().clone()
    }
    const VGCHANGE: &str = "vgchange --quiet --activate y pgcf";
    const REPAIRING: &str = r#"vgchange --quiet --config global{thin_check_options=["-q","--auto-repair"]} --activate y pgcf"#;
    const PARTS_LEFT: &str = include_str!("fixtures/lvs-all-pool-parts-left-active.json");

    #[test]
    fn an_activation_that_works_runs_nothing_else() {
        let storage = Scripted::new(vec![]);
        assert_eq!(storage.activate_group().unwrap(), Activation::default());
        assert_eq!(ran(&storage), [VGCHANGE]);
    }

    /// The pool's own check refused it (a leaked block after a reset that was not clean): one
    /// more activation, with the repair, and the caller is told.
    #[test]
    fn a_refused_activation_is_tried_once_more_with_the_repair() {
        let storage = Scripted::new(vec![(VGCHANGE, 5, "")]);
        let activation = storage.activate_group().unwrap();
        assert_eq!(
            activation,
            Activation {
                released_parts: vec![],
                repair_run: true
            }
        );
        let ran = ran(&storage);
        assert_eq!(ran[0], VGCHANGE);
        assert!(ran[1].starts_with("lvs --all"), "{ran:?}");
        assert_eq!(ran[2], REPAIRING);
        assert_eq!(ran.len(), 3);
    }

    /// Damaged metadata: the repairing activation is refused as well, and the error is the
    /// activation's. Nothing else is run (no `thin_repair`, no `lvconvert --repair`): the agent
    /// does not decide what becomes of a pool whose trees are wrong.
    #[test]
    fn damaged_metadata_ends_in_the_error_of_the_activation_and_nothing_else() {
        let storage = Scripted::new(vec![(VGCHANGE, 5, ""), ("--config", 5, "")]);
        let result = storage.activate_group();
        assert!(
            matches!(&result, Err(Error::Command { program, code: 5, .. }) if program == "vgchange"),
            "{result:?}"
        );
        let ran = ran(&storage);
        assert_eq!(ran.len(), 3, "{ran:?}");
        assert!(
            ran.iter()
                .all(|line| { line.starts_with("vgchange") || line.starts_with("lvs --all") })
        );
    }

    /// An inspection that left the metadata active keeps the pool down: the parts are
    /// deactivated and the plain activation is the one that works, with no repair.
    #[test]
    fn parts_an_inspection_left_active_are_deactivated_and_the_plain_activation_tried_again() {
        let storage = Scripted::new(vec![(VGCHANGE, 5, ""), ("lvs --all", 0, PARTS_LEFT)]);
        // The recorded report is of a pool named `pool`.
        let storage = Storage::new(
            storage.runner,
            Config {
                pool: "pool".into(),
                ..Config::default()
            },
        );
        let activation = storage.activate_group().unwrap();
        assert_eq!(
            activation,
            Activation {
                released_parts: vec!["pool_tdata".into(), "pool_tmeta".into()],
                repair_run: false
            }
        );
        let ran = ran(&storage);
        assert_eq!(ran[0], VGCHANGE);
        assert!(ran[1].starts_with("lvs --all"));
        assert_eq!(ran[2], "lvchange --quiet --activate n pgcf/pool_tdata");
        assert_eq!(ran[3], "lvchange --quiet --activate n pgcf/pool_tmeta");
        assert_eq!(ran[4], VGCHANGE);
        assert_eq!(ran.len(), 5);
    }

    /// A command that cannot even be started is not a refusal of the pool's check.
    #[test]
    fn a_failure_that_is_no_exit_status_is_not_retried() {
        struct Missing;
        impl CommandRunner for Missing {
            fn run(&self, _: &[String]) -> io::Result<Output> {
                Err(io::Error::from(io::ErrorKind::NotFound))
            }
        }
        let storage = Storage::new(Missing, Config::default());
        assert!(matches!(storage.activate_group(), Err(Error::Io(_))));
    }

    #[test]
    fn a_failed_pool_read_leaves_no_reading_to_admit_on() {
        let policy = Policy {
            reserve_bytes: 1 << 20,
            metadata_no_room_percent: 75,
            sample_max_age: Duration::from_secs(10),
        };
        let storage = Storage::new(Recorded(AtomicBool::new(false)), Config::default());
        assert_eq!(storage.room(&policy), Err(NoRoom::Unobserved));
        storage.poll_pool().unwrap();
        assert_eq!(storage.room(&policy), Ok(()));
        // The pool cannot be read now: the reading from before no longer admits a wake.
        storage.runner.0.store(true, Ordering::Relaxed);
        assert!(matches!(storage.poll_pool(), Err(Error::Command { .. })));
        assert_eq!(storage.room(&policy), Err(NoRoom::Unobserved));
    }

    /// A command that finishes late must not make its earlier status look newly observed.
    #[test]
    fn a_slow_pool_read_keeps_the_age_of_its_facts() {
        struct Delayed(Mutex<Option<Instant>>);
        impl CommandRunner for Delayed {
            fn run(&self, command: &[String]) -> io::Result<Output> {
                if command.get(1).map(String::as_str) == Some("status") {
                    *self.0.lock().unwrap() = Some(Instant::now());
                    std::thread::sleep(Duration::from_millis(20));
                }
                Recorded(AtomicBool::new(false)).run(command)
            }
        }
        let storage = Storage::new(Delayed(Mutex::new(None)), Config::default());
        let sample = storage.poll_pool().unwrap();
        let began = storage.runner.0.lock().unwrap().unwrap();
        assert!(
            sample.observed <= began,
            "completion time cannot be the sample time"
        );
        assert_eq!(
            storage.room(&Policy {
                sample_max_age: Duration::from_millis(5),
                ..policy()
            }),
            Err(NoRoom::Stale)
        );
    }

    fn policy() -> Policy {
        Policy {
            reserve_bytes: 1 << 20,
            metadata_no_room_percent: 75,
            sample_max_age: Duration::from_secs(10),
        }
    }

    const LVS: &str = include_str!("fixtures/lvs-volumes.json");
    const LISTED: &str = "a1b2c3d4e5f6g7h8i9j0";

    /// Answers `lvs` with a recorded report and every other command with success, and keeps
    /// the programs it was asked to run.
    struct Listed(String, Mutex<Vec<String>>);

    impl Listed {
        fn new(lvs: &str) -> Self {
            Self(lvs.into(), Mutex::default())
        }
        fn ran(&self, program: &str) -> usize {
            let ran = self.1.lock().unwrap();
            ran.iter().filter(|ran| *ran == program).count()
        }
    }
    impl CommandRunner for Listed {
        fn run(&self, command: &[String]) -> io::Result<Output> {
            self.1.lock().unwrap().push(command[0].clone());
            Ok(Output {
                code: 0,
                stdout: if command[0] == "lvs" {
                    self.0.clone()
                } else {
                    String::new()
                },
                stderr: String::new(),
            })
        }
    }

    /// A storage whose kernel has every volume's device at minor 7 with `errors` errors on it.
    fn storage_with(lvs: &str, errors: fn(u32) -> io::Result<u64>) -> Storage<Listed> {
        let mut storage = Storage::new(Listed::new(lvs), Config::default());
        storage.kernel = Kernel {
            minor: |_| Ok(7),
            ext4_errors: errors,
        };
        storage
    }
    fn clean_storage() -> Storage<Listed> {
        storage_with(LVS, |_| Ok(0))
    }
    fn listed_volume() -> VolumeId {
        VolumeId::new(LISTED, 1).unwrap()
    }

    /// `lvs` that takes a while, as it does on a node with hundreds of volumes.
    struct SlowLvs(Listed);
    impl CommandRunner for SlowLvs {
        fn run(&self, command: &[String]) -> io::Result<Output> {
            if command[0] == "lvs" {
                std::thread::sleep(Duration::from_millis(50));
            }
            self.0.run(command)
        }
    }

    /// The agent decides on every database of the node at once when it starts, and each decision
    /// asks whether the volume exists. While the list is old each of them would run `lvs`: the
    /// read that one of them runs answers the others, which asked before it began.
    #[test]
    fn a_burst_of_questions_about_volumes_runs_lvs_a_few_times_and_not_once_each() {
        let mut storage = Storage::new(SlowLvs(Listed::new(LVS)), Config::default());
        storage.kernel = Kernel {
            minor: |_| Ok(7),
            ext4_errors: |_| Ok(0),
        };
        storage.listing = Listing::new(Duration::ZERO);
        let id = listed_volume();
        let together = std::sync::Barrier::new(24);
        std::thread::scope(|scope| {
            for _ in 0..24 {
                scope.spawn(|| {
                    together.wait();
                    assert!(storage.exists(&id).unwrap());
                });
            }
        });
        // The first read answers the questions that asked before it began, a second the ones that
        // asked while it ran; a third is a thread that the machine kept waiting for 50 ms.
        let ran = storage.runner.0.ran("lvs");
        assert!((1..=3).contains(&ran), "{ran} runs of lvs for 24 questions");
    }

    #[test]
    fn a_wake_reads_the_volume_list_once_and_then_asks_the_kernel() {
        let storage = clean_storage();
        let id = listed_volume();
        for _ in 0..3 {
            assert!(storage.exists(&id).unwrap());
            assert!(!storage.needs_repair(&id).unwrap());
        }
        assert_eq!(storage.runner.ran("lvs"), 1);
    }

    #[test]
    fn the_kernels_error_count_decides_a_listed_volume_without_lvm2() {
        let storage = storage_with(LVS, |minor| Ok(u64::from(minor)));
        let id = listed_volume();
        assert!(storage.exists(&id).unwrap());
        assert!(storage.needs_repair(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 1);
    }

    /// Only a yes comes from the list: a volume it does not show may have been made since.
    #[test]
    fn a_volume_the_list_does_not_show_is_read_from_lvm2_every_time() {
        let storage = clean_storage();
        let missing = VolumeId::new("z1b2c3d4e5f6g7h8i9j0", 1).unwrap();
        for read in 1..=3 {
            assert!(!storage.exists(&missing).unwrap());
            assert!(matches!(
                storage.needs_repair(&missing),
                Err(Error::Missing)
            ));
            assert_eq!(storage.runner.ran("lvs"), 2 * read);
        }
        // Another volume's generation is another volume.
        let other = VolumeId::new(LISTED, 2).unwrap();
        assert!(!storage.exists(&other).unwrap());
    }

    /// The tag is read from lvm2 before a wake is refused for it.
    #[test]
    fn a_volume_the_list_shows_as_suspect_is_read_again_before_it_is_refused() {
        let suspect = LVS.replace(
            "pgcf.db.a1b2c3d4e5f6g7h8i9j0,pgcf.fs,pgcf.gen.1",
            "pgcf.db.a1b2c3d4e5f6g7h8i9j0,pgcf.fs,pgcf.gen.1,pgcf.suspect",
        );
        let storage = storage_with(&suspect, |_| Ok(0));
        let id = listed_volume();
        assert!(storage.needs_repair(&id).unwrap());
        assert!(storage.needs_repair(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
        // That it exists is no question of the tag.
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
    }

    #[test]
    fn a_device_or_filesystem_the_kernel_does_not_show_falls_back_to_lvm2() {
        let id = listed_volume();
        let mut storage = clean_storage();
        storage.kernel.minor = |_| Err(io::Error::from(io::ErrorKind::NotFound));
        assert!(storage.exists(&id).unwrap());
        assert!(!storage.needs_repair(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
        // Not mounted: ext4 has no entry for the device. The volume is not mounted, so it is
        // not damaged.
        let storage = storage_with(LVS, |_| Err(io::Error::from(io::ErrorKind::NotFound)));
        assert!(storage.exists(&id).unwrap());
        assert!(!storage.needs_repair(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
    }

    /// A unit or a job mounts the volume in a namespace of its own, so the agent's mount table
    /// does not list a volume that has a filesystem mounted (the agent's own mounts end with its
    /// restart): ext4's entry for the device, which exists while any namespace has the
    /// superblock, is what tells that it recorded an error. No entry is no filesystem and no error.
    #[test]
    fn a_filesystem_that_the_agent_has_not_mounted_is_damaged_when_ext4_says_so() {
        let id = listed_volume();
        for list_is_old in [false, true] {
            let mut storage = storage_with(LVS, |_| Ok(3));
            if list_is_old {
                storage.listing = Listing::new(Duration::ZERO);
            }
            assert!(storage.needs_repair(&id).unwrap(), "{list_is_old}");
        }
        let mut storage = storage_with(LVS, |_| Ok(0));
        storage.listing = Listing::new(Duration::ZERO);
        assert!(!storage.needs_repair(&id).unwrap());
        let mut storage = storage_with(LVS, |_| Err(io::Error::from(io::ErrorKind::NotFound)));
        storage.listing = Listing::new(Duration::ZERO);
        assert!(!storage.needs_repair(&id).unwrap());
        // Not being able to read ext4's entry is no answer, and no "clean".
        let mut storage = storage_with(LVS, |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        storage.listing = Listing::new(Duration::ZERO);
        assert!(storage.needs_repair(&id).is_err());
    }

    /// A unit mounts its volume itself, so which generation it serves is in its own mount table:
    /// the device number of the mount at the database's directory names the volume.
    /// The recorded list with a second, formatted generation of the listed database in the place
    /// of the other database's volume.
    fn two_generations() -> String {
        LVS.replace("db_k1l2m3n4o5p6q7r8s9t0_g12", "db_a1b2c3d4e5f6g7h8i9j0_g2")
            .replace(
                "pgcf.db.k1l2m3n4o5p6q7r8s9t0,pgcf.gen.12",
                "pgcf.db.a1b2c3d4e5f6g7h8i9j0,pgcf.fs,pgcf.gen.2",
            )
    }

    #[test]
    fn the_generation_a_unit_serves_is_the_volume_whose_device_number_it_has_mounted() {
        let mut storage = Storage::new(Listed::new(&two_generations()), Config::default());
        storage.kernel = Kernel {
            minor: |device| match device {
                device if device.ends_with("_g1") => Ok(7),
                device if device.ends_with("_g2") => Ok(9),
                _ => Err(io::Error::from(io::ErrorKind::NotFound)),
            },
            ext4_errors: |_| Ok(0),
        };
        let mount = |minor: u32, at: &str| Mount {
            major: 252,
            minor,
            mount_point: at.into(),
            fstype: "ext4".into(),
            source: format!("/dev/dm-{minor}"),
        };
        let at = format!("/var/lib/pgcf/db/{LISTED}");
        let serves = |mounts: &[Mount]| storage.volume_of_mount(LISTED, mounts);
        let generation = |volume: Option<VolumeId>| volume.map(|volume| volume.generation());
        assert_eq!(generation(serves(&[mount(7, &at)]).unwrap()), Some(1));
        assert_eq!(generation(serves(&[mount(9, &at)]).unwrap()), Some(2));
        // The mounts of other directories say nothing, and the top mount at the directory counts.
        let other = mount(7, "/var/lib/pgcf/db/k1l2m3n4o5p6q7r8s9t0");
        assert_eq!(serves(std::slice::from_ref(&other)).unwrap(), None);
        assert_eq!(
            generation(serves(&[mount(7, &at), other, mount(9, &at)]).unwrap()),
            Some(2)
        );
        // A device that is no volume of the database is no answer, and no guess.
        assert!(serves(&[mount(11, &at)]).is_err());
    }

    /// A process that holds database volumes is told by its mount table alone: every mount
    /// directly below the databases' directory that is the volume of the database it is named for.
    /// The agent adopts a slot from this when it starts, with no mount of its own.
    #[test]
    fn the_volumes_a_process_holds_are_read_from_its_mount_table_alone() {
        let mut storage = Storage::new(Listed::new(&two_generations()), Config::default());
        storage.kernel = Kernel {
            minor: |device| match device {
                device if device.ends_with("_g1") => Ok(7),
                device if device.ends_with("_g2") => Ok(9),
                _ => Err(io::Error::from(io::ErrorKind::NotFound)),
            },
            ext4_errors: |_| Ok(0),
        };
        let mount = |minor: u32, at: &str| Mount {
            major: 252,
            minor,
            mount_point: at.into(),
            fstype: "ext4".into(),
            source: format!("/dev/dm-{minor}"),
        };
        let at = format!("/var/lib/pgcf/db/{LISTED}");
        let tmpfs = Mount {
            major: 0,
            minor: 64,
            mount_point: "/var/lib/pgcf/db/k1l2m3n4o5p6q7r8s9t0".into(),
            fstype: "tmpfs".into(),
            source: "tmpfs".into(),
        };
        let held = storage.volumes_in(&[
            mount(7, "/var"),
            mount(9, &at),
            tmpfs,
            mount(7, "/var/lib/pgcf/db/not-a-database-id"),
            mount(7, &format!("{at}/data")),
        ]);
        // The tmpfs at another database's directory is held too, and nameless: a mount there that
        // the agent cannot name as a volume of that database is no reason to leave it out.
        assert_eq!(held.len(), 2, "{held:?}");
        assert_eq!(held[0].0, LISTED);
        assert_eq!(held[0].1.as_ref().unwrap().generation(), 2);
        assert_eq!(held[1], ("k1l2m3n4o5p6q7r8s9t0".to_string(), None));
        assert!(storage.volumes_in(&[]).is_empty());
    }

    /// Found live (EU1, 2026-10-23, `kill -9` of the agent): the agent named the volume of each of
    /// the 104 slots that held a database by running `lvs` for each, one after the other, 160 ms
    /// each; the adoption of the slots took 13.7 s of a start of 28.7 s to the first wake. The
    /// adoption asks once per slot, so the answer comes from one listing for all of them.
    #[test]
    fn the_volumes_that_many_slots_hold_are_named_from_one_listing() {
        let mut storage = Storage::new(Listed::new(&two_generations()), Config::default());
        storage.kernel = Kernel {
            minor: |_| Ok(7),
            ext4_errors: |_| Ok(0),
        };
        let at = format!("/var/lib/pgcf/db/{LISTED}");
        let mount = Mount {
            major: 252,
            minor: 7,
            mount_point: at.into(),
            fstype: "ext4".into(),
            source: "/dev/dm-7".into(),
        };
        for _ in 0..40 {
            let held = storage.volumes_in(std::slice::from_ref(&mount));
            assert!(held[0].1.is_some(), "{held:?}");
        }
        assert_eq!(storage.runner.ran("lvs"), 1);
        // A change of a volume ends the listing: the next question is read again.
        storage.listing.changed();
        storage.volumes_in(std::slice::from_ref(&mount));
        assert_eq!(storage.runner.ran("lvs"), 2);
    }

    /// Every mount at a database's directory is held, whether the agent can name its volume or
    /// not: the process that has it holds some tenant's filesystem, and a slot that holds one is
    /// never idle. The failures to name it are an `lvs` that cannot be read and a device that is
    /// no volume of the database (D13: unknown means tainted, never dropped).
    #[test]
    fn a_mount_at_a_database_directory_is_held_when_its_volume_cannot_be_named() {
        let at = format!("/var/lib/pgcf/db/{LISTED}");
        let ext4 = |minor: u32| Mount {
            major: 252,
            minor,
            mount_point: at.clone().into(),
            fstype: "ext4".into(),
            source: format!("/dev/dm-{minor}"),
        };
        // `lvs` answers what no report is: the volumes cannot be listed.
        let mut unreadable = Storage::new(Listed::new("not a report"), Config::default());
        unreadable.kernel = Kernel {
            minor: |_| Ok(7),
            ext4_errors: |_| Ok(0),
        };
        assert_eq!(
            unreadable.volumes_in(&[ext4(7)]),
            [(LISTED.to_string(), None)]
        );
        // The listing is fine and the mount is the device of no volume of the database.
        let mut storage = Storage::new(Listed::new(&two_generations()), Config::default());
        storage.kernel = Kernel {
            minor: |device| {
                if device.ends_with("_g1") {
                    Ok(7)
                } else {
                    Ok(9)
                }
            },
            ext4_errors: |_| Ok(0),
        };
        assert_eq!(
            storage.volumes_in(&[ext4(11)]),
            [(LISTED.to_string(), None)]
        );
        // A volume it can name is named.
        let named = storage.volumes_in(&[ext4(7)]);
        assert_eq!(named.len(), 1);
        assert_eq!(named[0].1.as_ref().map(VolumeId::generation), Some(1));
    }

    /// A storage whose kernel has a filesystem alive on the first generation's device only: the
    /// other devices have no entry in ext4's sysfs, as a volume nothing has mounted has none.
    fn storage_with_the_first_generation_alive(lvs: &str) -> Storage<Listed> {
        let mut storage = Storage::new(Listed::new(lvs), Config::default());
        storage.kernel = Kernel {
            minor: |device| {
                if device.ends_with("_g1") {
                    Ok(7)
                } else {
                    Err(io::Error::from(io::ErrorKind::NotFound))
                }
            },
            ext4_errors: |_| Ok(0),
        };
        storage
    }

    /// After the agent's restart nothing in its mount table is a volume: a unit or a job has the
    /// filesystem, in a namespace of its own. The detach asks the kernel, whose ext4 entry for the
    /// device exists while any namespace has the superblock, and a held volume is `Busy`.
    #[test]
    fn a_volume_that_only_a_unit_holds_is_not_detached_and_one_that_nothing_holds_is() {
        let id = listed_volume();
        assert!(matches!(
            clean_storage().unmount_volume(&id),
            Err(Error::Busy)
        ));
        // No filesystem of the volume is alive: nothing to detach, and it is done.
        let free = storage_with(LVS, |_| Err(io::Error::from(io::ErrorKind::NotFound)));
        free.unmount_volume(&id).unwrap();
        // A volume with no device (it was removed) is no holder either.
        let mut gone = clean_storage();
        gone.kernel.minor = |_| Err(io::Error::from(io::ErrorKind::NotFound));
        gone.unmount_volume(&id).unwrap();
        // An entry that cannot be read is no answer, and no "free".
        let unreadable = storage_with(LVS, |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert!(matches!(unreadable.unmount_volume(&id), Err(Error::Io(_))));
    }

    /// The next generation is not made while the filesystem of an earlier one is alive in any
    /// namespace, whether or not the agent's own table lists it: the unit that has it would run
    /// on, and a start of its unit on the new generation would be a start of a unit that runs.
    #[test]
    fn the_next_generation_is_refused_before_anything_is_made_while_another_is_alive() {
        let next = VolumeId::new(LISTED, 2).unwrap();
        let storage = storage_with_the_first_generation_alive(LVS);
        let result = storage.create_volume(&next, 128 << 20, &policy());
        assert!(matches!(result, Err(Error::OtherGeneration)), "{result:?}");
        for program in ["lvcreate", "mkfs.ext4", "dmsetup"] {
            assert_eq!(storage.runner.ran(program), 0, "{program}");
        }
        // Once nothing has the first generation, the create goes on to the pool: the recorded
        // runner has no pool to read, which is another answer.
        let free = storage_with(LVS, |_| Err(io::Error::from(io::ErrorKind::NotFound)));
        let result = free.create_volume(&next, 128 << 20, &policy());
        assert!(!matches!(result, Err(Error::OtherGeneration)), "{result:?}");
        assert!(free.runner.ran("dmsetup") > 0);
    }

    /// The same for every mount of a generation at the database's directory: a boot's, a wake's
    /// and a recovery's attach.
    #[test]
    fn a_generation_is_not_attached_while_the_filesystem_of_another_is_alive() {
        let storage = storage_with_the_first_generation_alive(&two_generations());
        let second = VolumeId::new(LISTED, 2).unwrap();
        let failures = storage.mount_all(slice::from_ref(&second)).unwrap();
        assert!(
            matches!(&failures[..], [(failed, Error::OtherGeneration)] if *failed == second),
            "{failures:?}"
        );
        assert!(matches!(
            storage.mount_volume(&second),
            Err(Error::OtherGeneration)
        ));
        assert!(!storage.attached(&second));
    }

    #[test]
    fn a_list_older_than_its_bound_is_read_again() {
        let mut storage = clean_storage();
        storage.listing = Listing::new(Duration::ZERO);
        let id = listed_volume();
        assert!(storage.exists(&id).unwrap());
        assert!(!storage.needs_repair(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
    }

    #[test]
    fn a_command_that_changes_a_volume_drops_the_list() {
        let storage = clean_storage();
        let id = listed_volume();
        assert!(storage.exists(&id).unwrap());
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 1);
        storage
            .remove_volume(
                &id,
                Removal::DatabaseDeleted {
                    storage_generation: 1,
                },
            )
            .unwrap();
        assert_eq!(storage.runner.ran("lvremove"), 1);
        // The removal read the list itself, and the command that followed made it old.
        let read = storage.runner.ran("lvs");
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), read + 1);
        // A command that only reads leaves the list.
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), read + 1);
    }

    /// The health check runs in a process of its own, with a storage of its own, and tags the
    /// volumes it finds mounted when the pool takes no writes.
    #[test]
    fn a_change_made_by_another_process_drops_the_list() {
        let storage = clean_storage();
        let id = listed_volume();
        assert!(storage.exists(&id).unwrap());
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 1);
        storage.changed_elsewhere();
        assert!(storage.exists(&id).unwrap());
        assert_eq!(storage.runner.ran("lvs"), 2);
    }

    /// Answers `lvs` with the recorded report and `lvremove` with the failure given.
    struct Refusing {
        lvs: String,
        stderr: &'static str,
    }
    impl CommandRunner for Refusing {
        fn run(&self, command: &[String]) -> io::Result<Output> {
            match command[0].as_str() {
                "lvs" => Ok(Output {
                    code: 0,
                    stdout: self.lvs.clone(),
                    stderr: String::new(),
                }),
                "lvremove" => Ok(Output {
                    code: 5,
                    stdout: String::new(),
                    stderr: self.stderr.into(),
                }),
                _ => Err(io::Error::from(io::ErrorKind::InvalidInput)),
            }
        }
    }

    /// The agent's mount table lists no mount of a unit or a job, which are in namespaces of their
    /// own: lvm2 refuses a volume that one has open, and that is `Busy`, not a failed command.
    #[test]
    fn a_volume_that_lvm2_says_is_in_use_is_busy_and_any_other_refusal_stays_a_command_error() {
        let removal = Removal::DatabaseDeleted {
            storage_generation: 1,
        };
        let remove = |stderr| {
            let storage = Storage::new(
                Refusing {
                    lvs: LVS.into(),
                    stderr,
                },
                Config {
                    device_links: std::env::temp_dir()
                        .join(format!("pgcf-in-use-{}", stderr.len())),
                    ..Config::default()
                },
            );
            storage.remove_volume(&listed_volume(), removal)
        };
        // As lvm2 2.03.31 wrote it for a thin volume that a process holds open (lab).
        let in_use = "  Logical volume pgcf/db_a1b2c3d4e5f6g7h8i9j0_g1 in use.\n";
        assert!(matches!(remove(in_use), Err(Error::Busy)));
        let other = "  Failed to find logical volume \"pgcf/db_a1b2c3d4e5f6g7h8i9j0_g1\"\n";
        assert!(matches!(remove(other), Err(Error::Command { code: 5, .. })));
    }

    #[test]
    fn an_order_releases_the_volumes_of_its_generation_and_older_ones_only() {
        let volume = |generation| VolumeId::new("a1b2c3d4e5f6g7h8i9j0", generation).unwrap();
        let deleted = Removal::DatabaseDeleted {
            storage_generation: 2,
        };
        assert!(deleted.releases(&volume(1)) && deleted.releases(&volume(2)));
        assert!(!deleted.releases(&volume(3)));
        let superseded = |remove_volume| Removal::Superseded {
            storage_generation: 2,
            remove_volume,
        };
        assert!(superseded(true).releases(&volume(1)) && superseded(true).releases(&volume(2)));
        assert!(!superseded(true).releases(&volume(3)));
        // Without `remove_volume` the order keeps the volume.
        assert!(!superseded(false).releases(&volume(1)));
    }
}
