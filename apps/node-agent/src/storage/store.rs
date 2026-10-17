// SPDX-License-Identifier: Apache-2.0
//! `Storage`: the pool, the volumes and their recovery, on this node. Every operation reads what
//! lvm2, `dmsetup` and the kernel report now and decides from that; nothing but the latest pool
//! sample is kept in memory, so an agent restart loses nothing.
use super::{
    CommandRunner, Config, Error, NoRoom, Output, Policy, PoolSample, ReserveAction, SystemRunner,
    VolumeId,
    commands::{self, FS_TAG, RESERVE_FREED_TAG},
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
    sync::{Mutex, MutexGuard, PoisonError},
    time::Instant,
};

/// A volume is a whole number of extents; the volume group is made with lvm2's 4 MiB.
const EXTENT_BYTES: u64 = 4 << 20;

/// Why a volume may go (plan invariant 7: only explicit orders remove anything).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// The desired state of its database is `deleted`.
    DatabaseDeleted,
    /// A `superseded` order for its storage generation; `remove_volume` is the order's flag.
    Superseded { remove_volume: bool },
}

/// Every volume of the node and the sum of the pool's nominal sizes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub volumes: Vec<VolumeInfo>,
    /// The sum of every thin volume's nominal size, for the logical cap.
    pub nominal_bytes: u64,
}

impl Inventory {
    /// Mounted volumes on which ext4 recorded an error: those a full pool leaves behind.
    pub fn damaged(&self) -> Vec<&VolumeInfo> {
        self.volumes
            .iter()
            .filter(|volume| volume.mount.is_some_and(|mount| mount.fs_errors))
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

    /// Reads the pool now (plan 4.3: every 5 s) and keeps the reading for `room`.
    pub fn poll_pool(&self) -> Result<PoolSample, Error> {
        let status = self.run(commands::dm_status_pool())?;
        let table = self.run(commands::dm_table_pool())?;
        let sample = parse_pool(
            &self.config.group,
            &self.config.pool,
            &status.stdout,
            &table.stdout,
            Instant::now(),
        )?;
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) = Some(sample.clone());
        Ok(sample)
    }

    /// The room rule of plan 4.6 on the latest `poll_pool` reading.
    pub fn room(&self, policy: &Policy) -> Result<(), NoRoom> {
        let latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        pool::room(latest.as_ref(), Instant::now(), policy)
    }

    /// Every volume with its pool use, mount, space and inodes: the volume report of plan 4.3,
    /// read every 60 s.
    pub fn inventory(&self) -> Result<Inventory, Error> {
        let lvs = self.read_lvs()?;
        let mapped = parse_thin_mapped(&self.run(commands::dm_status_thin())?.stdout)?;
        let mounts = self.mounts()?;
        let thin = || lvs.iter().filter(|lv| lv.is_thin());
        let mut volumes = Vec::new();
        for lv in thin() {
            // A thin volume that is not a database's counts toward the cap and is not reported.
            let Some(id) = VolumeId::from_lv_name(&lv.name).filter(|id| self.owned(lv, id).is_ok())
            else {
                continue;
            };
            let name = dm_name(&self.config.group, &lv.name);
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
                pool_used_bytes: mapped
                    .iter()
                    .find(|(device, _)| *device == name)
                    .map_or(0, |(_, bytes)| *bytes),
                formatted: lv.has_tag(FS_TAG),
                reserve_released: lv.has_tag(RESERVE_FREED_TAG),
                mount,
            });
        }
        Ok(Inventory {
            volumes,
            nominal_bytes: thin().map(|lv| lv.size_bytes).sum(),
        })
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
    /// formatted twice, and one of another size is an error.
    pub fn create_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
        policy: &Policy,
    ) -> Result<(), Error> {
        check_size(size_bytes)?;
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        let sample = self.poll_pool()?;
        pool::room(Some(&sample), Instant::now(), policy).map_err(Error::NoRoom)?;
        let formatted = match self.volume(&lvs, id) {
            Ok(lv) if lv.size_bytes != size_bytes => {
                return Err(Error::Unexpected("a volume of another size"));
            }
            Ok(lv) => lv.has_tag(FS_TAG),
            Err(Error::Missing) => {
                self.within_cap(&sample, &lvs, size_bytes)?;
                self.run(commands::volume_create(&self.config, id, size_bytes))?;
                false
            }
            Err(error) => return Err(error),
        };
        if !formatted {
            if self
                .mounts()?
                .iter()
                .any(|mount| mount.source == commands::device(&self.config, id))
            {
                return Err(Error::Mounted);
            }
            self.run(commands::mkfs(&self.config, id))?;
            self.run(commands::volume_add_tag(&self.config, id, FS_TAG))?;
        }
        self.attach(id, &self.mounts()?)
    }

    /// Mounts the formatted volume at its directory with mode 0700, unless it is.
    fn attach(&self, id: &VolumeId, mounts: &[Mount]) -> Result<(), Error> {
        let (dir, device) = (self.mount_dir(id), commands::device(&self.config, id));
        if let Some(mount) = mounts.iter().rev().find(|mount| mount.mount_point == dir) {
            return if mount.source == device {
                Ok(())
            } else {
                Err(Error::Unexpected(
                    "another filesystem at the volume's directory",
                ))
            };
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
    /// cap holds; a sleeping database's volume is mounted first, as `resize2fs` needs it.
    pub fn grow_volume(&self, id: &VolumeId, size_bytes: u64) -> Result<(), Error> {
        check_size(size_bytes)?;
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        let current = self.formatted(&lvs, id)?.size_bytes;
        if size_bytes < current {
            return Err(Error::Shrink);
        }
        if size_bytes > current {
            self.within_cap(&self.poll_pool()?, &lvs, size_bytes - current)?;
        }
        self.attach(id, &self.mounts()?)?;
        if size_bytes > current {
            self.run(commands::volume_extend(&self.config, id, size_bytes))?;
        }
        self.run(commands::resize_fs(&self.config, id))?;
        Ok(())
    }

    pub fn mount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock();
        self.formatted(&self.read_lvs()?, id)?;
        self.attach(id, &self.mounts()?)
    }

    /// After a boot: mounts every formatted volume, as sleeping databases keep theirs mounted.
    /// A volume that does not mount is returned and the others still are.
    pub fn mount_all(&self) -> Result<Vec<(VolumeId, Error)>, Error> {
        let _guard = self.lock();
        let lvs = self.read_lvs()?;
        let mounts = self.mounts()?;
        let mut failures = Vec::new();
        for lv in lvs.iter().filter(|lv| lv.is_thin() && lv.has_tag(FS_TAG)) {
            let Some(id) = VolumeId::from_lv_name(&lv.name) else {
                continue;
            };
            if let Err(error) = self.owned(lv, &id).and_then(|()| self.attach(&id, &mounts)) {
                failures.push((id, error));
            }
        }
        Ok(failures)
    }

    fn detach(&self, id: &VolumeId, mounts: &[Mount]) -> Result<(), Error> {
        if self.mount_of(id, mounts).is_none() {
            return Ok(());
        }
        // No force and no lazy detach: a filesystem that something holds stays mounted.
        host::unmount(&self.mount_dir(id)).map_err(|error| match error.raw_os_error() {
            Some(libc::EBUSY) => Error::Busy,
            _ => error.into(),
        })
    }

    pub fn unmount_volume(&self, id: &VolumeId) -> Result<(), Error> {
        let _guard = self.lock();
        self.detach(id, &self.mounts()?)
    }

    /// Removes the volume of a deleted database or of a superseded generation, and its chunks
    /// return to the pool. Never a volume that is mounted, one that is not a database volume,
    /// or one the order does not release.
    pub fn remove_volume(&self, id: &VolumeId, removal: Removal) -> Result<(), Error> {
        if removal
            == (Removal::Superseded {
                remove_volume: false,
            })
        {
            return Err(Error::NotAuthorised);
        }
        let _guard = self.lock();
        let dir = self.mount_dir(id);
        match self.volume(&self.read_lvs()?, id) {
            Ok(_) => {
                let device = commands::device(&self.config, id);
                if self
                    .mounts()?
                    .iter()
                    .any(|mount| mount.source == device || mount.mount_point == dir)
                {
                    return Err(Error::Mounted);
                }
                self.run(commands::volume_remove(&self.config, id))?;
            }
            // Removing what is gone is done; its empty directory may remain.
            Err(Error::Missing) => {}
            Err(error) => return Err(error),
        }
        match fs::remove_dir(&dir) {
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

    /// Frees or restores the root-only 1 % reserve (`usage::FsUsage::reserve_action`). The tag
    /// goes first when freeing and last when restoring, so a stop between the two steps leaves a
    /// volume that the next sample frees or restores again.
    pub fn set_reserve(&self, id: &VolumeId, action: ReserveAction) -> Result<(), Error> {
        let _guard = self.lock();
        match action {
            ReserveAction::Keep => Ok(()),
            ReserveAction::Release => {
                let lvs = self.read_lvs()?;
                if !self.formatted(&lvs, id)?.has_tag(RESERVE_FREED_TAG) {
                    self.run(commands::volume_add_tag(
                        &self.config,
                        id,
                        RESERVE_FREED_TAG,
                    ))?;
                }
                self.run(commands::reserve(&self.config, id, 0))?;
                Ok(())
            }
            ReserveAction::Restore => {
                let lvs = self.read_lvs()?;
                let tagged = self.formatted(&lvs, id)?.has_tag(RESERVE_FREED_TAG);
                self.run(commands::reserve(&self.config, id, 1))?;
                if tagged {
                    self.run(commands::volume_delete_tag(
                        &self.config,
                        id,
                        RESERVE_FREED_TAG,
                    ))?;
                }
                Ok(())
            }
        }
    }

    /// Full-pool recovery of one volume (plan 4.3), once its database's unit is stopped: unmounts
    /// it, repairs it with `e2fsck -p` and mounts it again. The pool must take writes with space
    /// above the reserve, as the repair writes. Waking the database is the caller's, through
    /// admission.
    pub fn recover_volume(&self, id: &VolumeId, policy: &Policy) -> Result<(), Error> {
        let _guard = self.lock();
        self.formatted(&self.read_lvs()?, id)?;
        let sample = self.poll_pool()?;
        pool::room(Some(&sample), Instant::now(), policy).map_err(Error::NoRoom)?;
        self.detach(id, &self.mounts()?)?;
        // 0: clean, 1: errors corrected. Anything else needs an operator.
        let output = self.runner.run(&commands::fsck(&self.config, id))?;
        if !matches!(output.code, 0 | 1) {
            return Err(Error::Fsck(output.code));
        }
        self.attach(id, &self.mounts()?)
    }
}
