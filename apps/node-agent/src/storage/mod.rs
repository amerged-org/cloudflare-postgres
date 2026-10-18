// SPDX-License-Identifier: Apache-2.0
//! Thin LVM storage of the node (ULTRA plan 4.3, 5.6 job 3 and 5.10): the volume group and thin
//! pool the agent makes at first boot, one thin volume with its own ext4 per database, the pool
//! and volume samples, the room rule and the recovery of a full pool or a full volume.
//!
//! The decisions are pure functions over what lvm2, `dmsetup` and the kernel report; `Storage`
//! reads those reports, runs the decided commands through its `CommandRunner` and calls the
//! kernel's mount API.
// `Storage` and the kernel calls are Linux only, like the attach path's `mount`; the decisions
// they use compile everywhere and are tested everywhere.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
// `pgcf_storage_lab` is set by RUSTFLAGS, not declared in the manifest.
#![allow(unexpected_cfgs)]
mod command;
mod commands;
mod error;
#[cfg(target_os = "linux")]
mod host;
mod ids;
// The lab tests change the machine: they exist only when the lab run sets `--cfg
// pgcf_storage_lab` (see the module), so that the unprivileged kernel step, which runs every
// ignored test, never meets them.
#[cfg(all(test, target_os = "linux", pgcf_storage_lab))]
mod lab_tests;
mod lvm;
mod mountinfo;
mod pool;
#[cfg(target_os = "linux")]
mod store;
mod usage;

pub use command::{CommandRunner, Output, SystemRunner};
pub use error::Error;
pub use ids::VolumeId;
pub use pool::{NoRoom, Policy, PoolMode, PoolSample};
#[cfg(target_os = "linux")]
pub use store::Storage;
pub use usage::{Alert, FsUsage, Inventory, MountInfo, Removal, ReserveAction, VolumeInfo};

use crate::units::DB_ROOT;
use std::{path::PathBuf, time::Duration};

/// How often the agent reads the pool (plan 4.3: the sample is at most 10 s old for the room rule).
pub const POOL_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// How often the agent reads every volume's space and inodes.
pub const VOLUME_SAMPLE_INTERVAL: Duration = Duration::from_secs(60);

/// Where the node's storage is. `Config::default()` is the node image's layout; the fields exist
/// so that tests can run the same code on a loop device.
#[derive(Clone, Debug)]
pub struct Config {
    /// The LVM partition the image's first boot makes.
    pub device: PathBuf,
    pub group: String,
    pub pool: String,
    /// Each volume is mounted at `<mount_root>/<database id>`: the directory is the database's, so
    /// one storage generation of it is mounted at a time.
    pub mount_root: PathBuf,
    /// The LVM metadata area of the physical volume: about 95,000 volumes (Stage 1).
    pub pv_metadata_bytes: u64,
    pub pool_metadata_bytes: u64,
    /// The node's own ceiling: the sum of nominal volume sizes stays at or below this many times
    /// the pool's data size (plan 4.3's default). It is not part of the node policy on the link,
    /// so the cap Cloudflare enforces when it places a database or accepts a resize must not
    /// exceed it, or the node refuses what Cloudflare accepted.
    pub logical_cap_factor: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            device: PathBuf::from("/dev/disk/by-partlabel/pgcf-lvm"),
            group: "pgcf".into(),
            pool: "pgcf_thinpool".into(),
            mount_root: PathBuf::from(DB_ROOT),
            pv_metadata_bytes: 64 << 20,
            pool_metadata_bytes: 1 << 30,
            logical_cap_factor: 4,
        }
    }
}

/// The pool's chunk size: 64 KiB (plan 4.3).
pub const CHUNK_BYTES: u64 = 64 * 1024;
