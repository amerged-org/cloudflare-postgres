// SPDX-License-Identifier: Apache-2.0
//! What the agent needs of the machine it runs on (plan 5.4, 5.6 jobs 3 and 4): the Linux users of
//! the databases, their thin volumes, their systemd units, `initdb` and the memory the kernel
//! reports. The agent's flows are written against this trait, so that they run against a real
//! PostgreSQL in a test on any machine; `Node` is the node itself, and the tests' `Local` stands
//! in for systemd and LVM only.
use crate::{
    layout::Layout,
    storage::{self, Inventory, NoRoom, PoolSample, Removal, VolumeId},
    units::{self, Started, UnitState, limits::Limits},
};
use std::{future::Future, io, num::NonZeroU32};

/// The Linux user and group of a database: a fixed uid from the agent's range, named
/// `pgcf-<id>` (plan 5.5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
}

#[cfg(test)]
pub(crate) mod local;
#[cfg(target_os = "linux")]
mod node;
#[cfg(target_os = "linux")]
pub use node::Node;

/// The arguments of `initdb` for a database cluster at `data`: the agent is the cluster's
/// superuser, and nobody logs in until the agent has written `pg_hba.conf` (a start without it
/// would refuse every login).
pub fn initdb_arguments(data: &std::path::Path, locale: Option<&str>) -> Vec<String> {
    let mut arguments: Vec<String> = [
        "-D",
        &data.to_string_lossy(),
        "-U",
        crate::settings::AGENT_ROLE,
        "--auth-local=reject",
        "--auth-host=reject",
        "-E",
        "UTF8",
        "--no-instructions",
    ]
    .map(String::from)
    .into();
    match locale {
        Some(locale) => arguments.push(format!("--locale={locale}")),
        None => arguments.push("--no-locale".into()),
    }
    arguments
}

pub trait Machine: Send + Sync + 'static {
    fn layout(&self) -> &Layout;

    // ---- the users of the databases
    /// The database's user: made with the uid the agent handed it, or found.
    fn ensure_account(&self, database: &str) -> impl Future<Output = io::Result<Account>> + Send;
    /// The user of a database the node has, if it has one.
    fn account(&self, database: &str) -> Option<Account>;
    /// Removes the user and gives its uid back, once the volume is gone (plan 5.10).
    fn remove_account(&self, database: &str) -> impl Future<Output = io::Result<()>> + Send;

    // ---- the thin volumes
    /// Creates the volume, its filesystem and its mount, or finishes what an earlier call left;
    /// the mount point belongs to `account` afterwards.
    fn create_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
        account: &Account,
        policy: &storage::Policy,
    ) -> impl Future<Output = Result<(), storage::Error>> + Send;
    /// Whether the volume exists on the node.
    fn has_volume(
        &self,
        id: &VolumeId,
    ) -> impl Future<Output = Result<bool, storage::Error>> + Send;
    /// After a boot: mounts the volume of every database in `current` that is formatted.
    fn mount_volumes(
        &self,
        current: &[VolumeId],
    ) -> impl Future<Output = Result<Vec<(VolumeId, storage::Error)>, storage::Error>> + Send;
    /// Unmounts the volume, which the next storage generation of its database needs: a database has
    /// one directory.
    fn unmount_volume(
        &self,
        id: &VolumeId,
    ) -> impl Future<Output = Result<(), storage::Error>> + Send;
    fn grow_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
    ) -> impl Future<Output = Result<(), storage::Error>> + Send;
    fn remove_volume(
        &self,
        id: &VolumeId,
        removal: Removal,
    ) -> impl Future<Output = Result<(), storage::Error>> + Send;
    /// Returns the filesystem's free blocks to the pool (after every clean sleep).
    fn trim_volume(&self, id: &VolumeId)
    -> impl Future<Output = Result<(), storage::Error>> + Send;
    /// Whether the volume must be repaired before its database starts again.
    fn needs_repair(
        &self,
        id: &VolumeId,
    ) -> impl Future<Output = Result<bool, storage::Error>> + Send;
    /// Full-pool recovery of one volume whose unit is stopped (plan 4.3).
    fn recover_volume(
        &self,
        id: &VolumeId,
        policy: &storage::Policy,
    ) -> impl Future<Output = Result<(), storage::Error>> + Send;
    fn inventory(&self) -> impl Future<Output = Result<Inventory, storage::Error>> + Send;
    /// Reads the pool (every 5 s) and keeps the reading for `room`.
    fn poll_pool(&self) -> impl Future<Output = Result<PoolSample, storage::Error>> + Send;
    /// The room rule of plan 4.6 on the latest reading of the pool.
    fn room(&self, policy: &storage::Policy) -> Result<(), NoRoom>;
    /// The device-mapper node of a volume, where its unit's write limits are set.
    fn device(&self, id: &VolumeId) -> String;

    // ---- the databases' directories and clusters
    /// The `archive_command` client of a database's PostgreSQL (plan 7.5).
    fn archive_command(&self, database: &str) -> String;
    /// The Linux user that reaches the databases as the agent role: the node's root.
    fn agent_user(&self) -> String;
    /// `/run/pgcf/<id>`: owned by the database's user, readable by the gateway's group, mode 0750.
    /// It is gone after a boot, so the agent makes it for every database when it starts.
    fn prepare_socket_directory(&self, database: &str, account: &Account) -> io::Result<()>;
    /// Runs `initdb` as the database's user into `data`.
    fn initdb(
        &self,
        account: &Account,
        data: &std::path::Path,
    ) -> impl Future<Output = io::Result<()>> + Send;

    // ---- the units
    fn unit(&self, database: &str) -> impl Future<Output = Result<UnitState, units::Error>> + Send;
    /// Every loaded database unit, whatever its state.
    fn units(&self) -> impl Future<Output = Result<Vec<UnitState>, units::Error>> + Send;
    /// Starts the unit and returns when PostgreSQL accepts connections.
    fn start(&self, database: &str) -> impl Future<Output = Result<Started, units::Error>> + Send;
    /// Waits for a unit that is starting, one the agent found activating when it started.
    fn wait_started(
        &self,
        database: &str,
    ) -> impl Future<Output = Result<Started, units::Error>> + Send;
    /// A fast shutdown, returning when the unit is stopped; lifts its CPU quota.
    fn stop(&self, database: &str) -> impl Future<Output = Result<(), units::Error>> + Send;
    fn set_limits(
        &self,
        database: &str,
        limits: &Limits,
    ) -> impl Future<Output = Result<(), units::Error>> + Send;
    fn set_cpu_quota(
        &self,
        database: &str,
        millicores: Option<NonZeroU32>,
    ) -> impl Future<Output = Result<(), units::Error>> + Send;
    /// The memory ceiling of all databases together.
    fn set_slice_memory(
        &self,
        awake_budget_mib: u64,
    ) -> impl Future<Output = Result<(), units::Error>> + Send;

    // ---- the node's credentials
    /// Applies what Cloudflare delivered (`NodeCredentials`): the route keyring for the gateway and
    /// the Tunnel token for cloudflared, each where its unit reads it, and starts the units, or
    /// restarts them when `restart` (the credentials changed). The token is stored as an encrypted
    /// systemd credential and never appears on a command line.
    fn apply_credentials(
        &self,
        region: &str,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> impl Future<Output = io::Result<()>> + Send;

    // ---- the kernel's facts
    /// `MemTotal` and `MemAvailable` now.
    fn memory(&self) -> Option<Memory>;
    /// The CPU times since boot, summed over the cores.
    fn cpu(&self) -> Option<CpuTimes>;
}

/// `MemTotal` and `MemAvailable` of `/proc/meminfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Memory {
    pub total_bytes: u64,
    pub available_bytes: u64,
}

/// The first line of `/proc/stat` and the cores it sums.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuTimes {
    /// Time not idle (user, nice, system, irq, softirq, steal), in clock ticks.
    pub busy: u64,
    /// All time, in clock ticks.
    pub total: u64,
    pub cores: u32,
    /// Clock ticks per second.
    pub ticks_per_second: u64,
}
