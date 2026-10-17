// SPDX-License-Identifier: Apache-2.0
//! `Storage`: the pool, the volumes and their recovery, on this node. Every operation reads what
//! lvm2, `dmsetup` and the kernel report now and decides from that; nothing but the latest pool
//! sample is kept in memory, so an agent restart loses nothing.
use super::{
    CommandRunner, Config, Error, NoRoom, Output, Policy, PoolSample, ReserveAction, SystemRunner,
    VolumeId,
    commands::{self, FS_TAG, RESERVE_FREED_TAG, SUSPECT_TAG},
    host,
    ids::dm_name,
    lvm::{self, GroupStep, LogicalVolume, PoolStep},
    mountinfo::{self, Mount},
    pool::{self, parse_pool, parse_thin_mapped},
    usage::{MountInfo, VolumeInfo},
};
use std::{
    fs,
    io::ErrorKind,
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    path::{Path, PathBuf},
    slice,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Instant,
};

/// A volume is a whole number of extents; the volume group is made with lvm2's 4 MiB.
const EXTENT_BYTES: u64 = 4 << 20;

/// Why a volume may go (plan invariant 7: only explicit orders remove anything). Each carries the
/// storage generation the persisted desired state or order names, which the volume's own
/// generation must not pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// The desired state of its database is `deleted` at this storage generation.
    DatabaseDeleted { storage_generation: u64 },
    /// A `superseded` order for this storage generation or an older one; `remove_volume` is the
    /// order's flag.
    Superseded {
        storage_generation: u64,
        remove_volume: bool,
    },
}

impl Removal {
    /// Whether the order lets the volume of `id` go.
    fn releases(self, id: &VolumeId) -> bool {
        match self {
            Removal::DatabaseDeleted { storage_generation } => {
                id.generation() <= storage_generation
            }
            Removal::Superseded {
                storage_generation,
                remove_volume,
            } => remove_volume && id.generation() <= storage_generation,
        }
    }
}

/// Every volume of the node and the sum of the pool's nominal sizes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub volumes: Vec<VolumeInfo>,
    /// The sum of every thin volume's nominal size, for the logical cap.
    pub nominal_bytes: u64,
}

impl Inventory {
    /// The volumes a full pool may have left damaged: those mounted while the pool took no
    /// writes, and those on which ext4 recorded an error.
    pub fn damaged(&self) -> Vec<&VolumeInfo> {
        self.volumes
            .iter()
            .filter(|volume| volume.needs_repair())
            .collect()
    }
}

pub struct Storage<R = SystemRunner> {
    runner: R,
    config: Config,
    latest: Mutex<Option<PoolSample>>,
    /// Serializes everything that changes the group, the pool or a volume.
    changes: Mutex<()>,
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
            changes: Mutex::new(()),
        }
    }
    pub fn config(&self) -> &Config {
        &self.config
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        // The lock guards no data: a panic while holding it leaves nothing half-updated in memory.
        self.changes.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn run(&self, command: Vec<String>) -> Result<Output, Error> {
        let output = self.runner.run(&command)?;
        if output.code != 0 {
            return Err(Error::Command {
                program: command[0].clone(),
                code: output.code,
                stderr: output.stderr,
            });
        }
        Ok(output)
    }
    fn read_lvs(&self) -> Result<Vec<LogicalVolume>, Error> {
        lvm::parse_lvs(&self.run(commands::lvs(&self.config))?.stdout)
    }
    fn read_group(&self) -> Result<lvm::VolumeGroup, Error> {
        lvm::parse_vgs(&self.run(commands::vgs())?.stdout)?
            .into_iter()
            .find(|group| group.name == self.config.group)
            .ok_or(Error::Unexpected("the volume group"))
    }
    fn mounts(&self) -> Result<Vec<Mount>, Error> {
        mountinfo::parse(&host::mount_table()?)
    }
    /// A database has one directory, the unit's mount point, whatever generation is mounted.
    fn mount_dir(&self, id: &VolumeId) -> PathBuf {
        self.config.mount_root.join(id.database())
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
    /// is an error, never repaired in place.
    pub fn open(&self) -> Result<(), Error> {
        let _guard = self.lock();
        let device = fs::canonicalize(&self.config.device)?;
        let device = lvm::parse_pvs(&self.run(commands::pvs())?.stdout)?
            .into_iter()
            .find(|pv| Path::new(&pv.name) == device);
        let groups = lvm::parse_vgs(&self.run(commands::vgs())?.stdout)?;
        for step in lvm::plan_group(&self.config, device.as_ref(), &groups)? {
            self.run(match step {
                GroupStep::CreatePhysicalVolume => commands::pvcreate(&self.config),
                GroupStep::CreateGroup => commands::vgcreate(&self.config),
            })?;
        }
        let group = self.read_group()?;
        self.run(commands::activate(&self.config))?;
        for step in lvm::plan_pool(&self.config, &group, &self.read_lvs()?)? {
            self.run(match step {
                PoolStep::Create { data_bytes } => commands::pool_create(&self.config, data_bytes),
                PoolStep::ErrorWhenFull => commands::error_when_full(&self.config),
            })?;
        }
        // What was made is what plan 4.3 asks for, or the pool is not trusted.
        if !lvm::plan_pool(&self.config, &group, &self.read_lvs()?)?.is_empty() {
            return Err(Error::Unexpected("the thin pool after creating it"));
        }
        Ok(())
    }

    /// Reads the pool now and keeps the reading for `room`. A read that fails leaves no reading,
    /// so `room` answers `Unobserved` rather than the last healthy sample.
    fn read_pool(&self) -> Result<PoolSample, Error> {
        let sample = self.run(commands::dm_status_pool()).and_then(|status| {
            let table = self.run(commands::dm_table_pool())?;
            parse_pool(
                &self.config.group,
                &self.config.pool,
                &status.stdout,
                &table.stdout,
                Instant::now(),
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
    fn sample_pool(&self, held: &MutexGuard<'_, ()>) -> Result<PoolSample, Error> {
        let sample = self.read_pool()?;
        if !sample.writable() {
            self.mark_suspects(held)?;
        }
        Ok(sample)
    }

    /// While the pool takes no writes, a mounted ext4 loses metadata blocks without recording an
    /// error: only a later write notices, and PostgreSQL stops at its first failed WAL write and
    /// makes none. So the pool's state, not ext4's error count, decides which volumes may be
    /// damaged: every volume mounted now. The tag is LVM metadata, so it outlives the agent and
    /// the node, and it stays until `recover_volume` has repaired the volume.
    fn mark_suspects(&self, _held: &MutexGuard<'_, ()>) -> Result<(), Error> {
        let lvs = self.read_lvs()?;
        let mounts = self.mounts()?;
        let unmarked: Vec<VolumeId> = self
            .database_volumes(&lvs)
            .filter(|(id, lv)| !lv.has_tag(SUSPECT_TAG) && self.mount_of(id, &mounts).is_some())
            .map(|(id, _)| id)
            .collect();
        if !unmarked.is_empty() {
            self.run(commands::volumes_add_tag(
                &self.config,
                &unmarked,
                SUSPECT_TAG,
            ))?;
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
                    fs_errors: host::ext4_errors(mount.minor)? > 0,
                }),
                None => None,
            };
            volumes.push(VolumeInfo {
                id,
                size_bytes: lv.size_bytes,
                pool_used_bytes,
                formatted: lv.has_tag(FS_TAG),
                reserve_released: lv.has_tag(RESERVE_FREED_TAG),
                suspect: lv.has_tag(SUSPECT_TAG),
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

    /// Whether the volume must be repaired (`recover_volume`) before its database starts again:
    /// the one question a wake asks about a volume, without reading every volume's space.
    pub fn needs_repair(&self, id: &VolumeId) -> Result<bool, Error> {
        if self.volume(&self.read_lvs()?, id)?.has_tag(SUSPECT_TAG) {
            return Ok(true);
        }
        match self.mount_of(id, &self.mounts()?) {
            Some(mount) => Ok(host::ext4_errors(mount.minor)? > 0),
            None => Ok(false),
        }
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
            self.run(commands::mkfs(&self.config, id))?;
            self.run(commands::volumes_add_tag(
                &self.config,
                slice::from_ref(id),
                FS_TAG,
            ))?;
        }
        self.attach(id, suspect)
    }

    /// Mounts the formatted volume at its directory with mode 0700, unless it is. The directory
    /// is the database's, so a filesystem of another volume on it, another generation's included,
    /// refuses the mount. A volume tagged as suspect is not mounted: `recover_volume` repairs it
    /// first.
    fn attach(&self, id: &VolumeId, suspect: bool) -> Result<(), Error> {
        let (dir, device) = (self.mount_dir(id), commands::device(&self.config, id));
        // The table is read now: an earlier attach of the same call has changed it.
        if let Some(top) = self.top_mount(id, &self.mounts()?) {
            return if top.source == device {
                Ok(())
            } else {
                Err(self.occupied(id, top))
            };
        }
        if suspect {
            return Err(Error::NeedsRepair);
        }
        // Traversable but not listable: a database reaches its own directory only.
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o711)
            .create(&self.config.mount_root)?;
        match fs::DirBuilder::new().mode(0o700).create(&dir) {
            Err(error) if error.kind() != ErrorKind::AlreadyExists => return Err(error.into()),
            _ => {}
        }
        host::mount_ext4(&device, &dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
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

    /// Grows the volume and its filesystem online (plan 3.5: storage never shrinks). The logical
    /// cap holds; a sleeping database's volume is mounted first, as `resize2fs` needs it. A
    /// reserve that was freed goes back by the usual rule once the volume has room again, and a
    /// suspect volume is repaired before it grows.
    pub fn grow_volume(&self, id: &VolumeId, size_bytes: u64) -> Result<(), Error> {
        check_size(size_bytes)?;
        let guard = self.lock();
        let lvs = self.read_lvs()?;
        let lv = self.formatted(&lvs, id)?;
        if lv.has_tag(SUSPECT_TAG) {
            return Err(Error::NeedsRepair);
        }
        let (current, released) = (lv.size_bytes, lv.has_tag(RESERVE_FREED_TAG));
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
        self.attach(id, false)?;
        if size_bytes > current {
            self.run(commands::volume_extend(&self.config, id, size_bytes))?;
        }
        self.run(commands::resize_fs(&self.config, id))?;
        if released {
            let usage = host::fs_usage(&self.mount_dir(id))?;
            self.apply_reserve(id, usage.reserve_action(true, false), true)?;
        }
        Ok(())
    }

    pub fn mount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        let suspect = self.formatted(&lvs, id)?.has_tag(SUSPECT_TAG);
        self.attach(id, suspect)
    }

    /// After a boot: mounts the formatted volume of every database in `current`, as sleeping
    /// databases keep theirs mounted. `current` is the storage generation the persisted desired
    /// state names for each database: an older generation that has not been removed yet is never
    /// mounted, and the unit would start its data. A volume that does not mount is returned and
    /// the others still are. One that does not exist, or whose create stopped before its
    /// filesystem, is the create's to finish.
    pub fn mount_all(&self, current: &[VolumeId]) -> Result<Vec<(VolumeId, Error)>, Error> {
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
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
            if let Err(error) = self.attach(id, lv.has_tag(SUSPECT_TAG)) {
                failures.push((id.clone(), error));
            }
        }
        Ok(failures)
    }

    /// Unmounts the volume's own filesystem. What is on top at its directory must be that
    /// filesystem; `umount` would take whatever is on top.
    fn detach(&self, id: &VolumeId) -> Result<(), Error> {
        let mounts = self.mounts()?;
        let Some(own) = self.mount_of(id, &mounts) else {
            return Ok(());
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
        })
    }

    pub fn unmount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock();
        self.detach(id)
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
                self.run(commands::volume_remove(&self.config, id))?;
            }
            // Removing what is gone is done; its empty directory may remain.
            Err(Error::Missing) => {}
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

    /// Returns the filesystem's free blocks to the pool (plan 4.3: after every clean sleep).
    pub fn trim_volume(&self, id: &VolumeId) -> Result<(), Error> {
        if self.mount_of(id, &self.mounts()?).is_none() {
            return Err(Error::NotMounted);
        }
        self.run(commands::trim(&self.config, id))?;
        Ok(())
    }

    /// Frees or restores the root-only 1 % reserve by `FsUsage::reserve_action` on the volume's
    /// space now, and returns what it did. `write_failed` is whether the database's unit ended on
    /// its own after a failed write: the one fact the caller knows and the volume does not.
    pub fn set_reserve(&self, id: &VolumeId, write_failed: bool) -> Result<ReserveAction, Error> {
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        let released = self.formatted(&lvs, id)?.has_tag(RESERVE_FREED_TAG);
        let mounts = self.mounts()?;
        let mount = self.mount_of(id, &mounts).ok_or(Error::NotMounted)?;
        let action = host::fs_usage(&mount.mount_point)?.reserve_action(released, write_failed);
        self.apply_reserve(id, action, released)?;
        Ok(action)
    }

    /// The tag goes first when freeing and last when restoring, so a stop between the two steps
    /// leaves a volume that the next sample frees or restores again.
    fn apply_reserve(
        &self,
        id: &VolumeId,
        action: ReserveAction,
        released: bool,
    ) -> Result<(), Error> {
        match action {
            ReserveAction::Keep => {}
            ReserveAction::Release => {
                if !released {
                    self.run(commands::volumes_add_tag(
                        &self.config,
                        slice::from_ref(id),
                        RESERVE_FREED_TAG,
                    ))?;
                }
                self.run(commands::reserve(&self.config, id, 0))?;
            }
            ReserveAction::Restore => {
                self.run(commands::reserve(&self.config, id, 1))?;
                if released {
                    self.run(commands::volume_delete_tag(
                        &self.config,
                        id,
                        RESERVE_FREED_TAG,
                    ))?;
                }
            }
        }
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
    pub fn recover_volume(&self, id: &VolumeId, policy: &Policy) -> Result<(), Error> {
        let guard = self.lock();
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
        self.attach(id, false)
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
