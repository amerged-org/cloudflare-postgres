// SPDX-License-Identifier: Apache-2.0
//! What the agent needs of the machine it runs on (plan 5.4, 5.6 jobs 3 and 4): the Linux users of
//! the databases, their thin volumes, their systemd units, `initdb` and the memory the kernel
//! reports. The agent's flows are written against this trait, so that they run against a real
//! PostgreSQL in a test on any machine; `Node` is the node itself, and the tests' `Local` stands
//! in for systemd and LVM only.
use crate::{
    layout::Layout,
    link::NodeIdentity,
    storage::{self, Inventory, NoRoom, PoolSample, Removal, VolumeId},
    units::{self, Started, UnitState, limits::Limits},
    update,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, future::Future, io, num::NonZeroU32, path::PathBuf};

/// What a boot loses, restored when the agent starts and before any page comes (plan 5.6 job 4,
/// the image's `README.md`): the CPU quota of every stopped unit is lifted, because a quota can
/// outlive a stop or an agent crash and would throttle the next start, and the socket directory of
/// every database the node has a volume of is made again, because `/run` is empty after a boot and
/// a start without it fails. What cannot be read now is left to the next time.
pub async fn restore_runtime<M: Machine>(machine: &M) {
    if let Ok(units) = machine.units().await {
        for unit in units.iter().filter(|unit| !unit.active.awake()) {
            let _ = machine.set_cpu_quota(&unit.database, None).await;
        }
    }
    if let Ok(inventory) = machine.inventory().await {
        for volume in inventory.volumes {
            if let Some(account) = machine.account(volume.id.database()) {
                let _ = machine.prepare_socket_directory(volume.id.database(), &account);
            }
        }
    }
}

/// What the hello reports of the node's operating system (`NodeOs`, SEC-03): this boot, the running
/// kernel, and the digest of the installed packages (`update::packages_digest`). The agent reads it
/// when it starts and again after a maintenance cycle that did not reboot, not with every sample.
pub async fn os_report<M: Machine>(machine: &M) -> Result<Value, crate::Error> {
    let boot = machine
        .boot()
        .ok_or("the boot and the kernel cannot be read")?;
    let installed =
        update::without_idle_kernels(machine.installed_packages().await?, &boot.kernel_release);
    let booted_at_ms = i64::try_from(boot.booted_at)?.saturating_mul(1000);
    Ok(json!({
        "boot_id": boot.id,
        "booted_at": crate::archive::facts::timestamp(booted_at_ms),
        "kernel_release": boot.kernel_release,
        "packages_sha256": update::packages_digest(&installed),
    }))
}

/// The gateway's environment file (`EnvironmentFile=` of `pgcf-gateway.service`): the node's
/// region and ID, and the keyring derived for the node, which verifies only the routes made for
/// it. The keyring is one line in single quotes, which an environment file takes literally.
#[cfg(any(target_os = "linux", test))]
pub(crate) fn gateway_environment(
    node: &NodeIdentity,
    credentials: &serde_json::Value,
) -> io::Result<String> {
    let keyring = serde_json::to_string(&credentials["route_keyring"])?;
    if keyring.contains(['\'', '\n'])
        || !crate::valid_region(&node.region_id)
        || !pgcf_native_protocol::valid_pattern("node", &node.id)
    {
        return Err(io::Error::other("credentials that cannot be written"));
    }
    Ok(format!(
        "PGCF_REGION_ID={}\nPGCF_NODE_ID={}\nPGCF_ROUTE_KEY='{keyring}'\n",
        node.region_id, node.id
    ))
}

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
        node: &NodeIdentity,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> impl Future<Output = io::Result<()>> + Send;

    // ---- updates (plan 9.3)
    /// Restarts one of the image's own services and waits for the job.
    fn restart_service(&self, unit: &str) -> impl Future<Output = Result<(), units::Error>> + Send;
    /// The installed Debian packages and their versions.
    fn installed_packages(
        &self,
    ) -> impl Future<Output = io::Result<BTreeMap<String, String>>> + Send;
    /// Installs exactly these package versions from the Debian snapshot `snapshot`, and these
    /// package files, with apt and without asking anything.
    fn install_packages(
        &self,
        snapshot: &str,
        versions: &[String],
        files: &[PathBuf],
    ) -> impl Future<Output = io::Result<()>> + Send;
    /// Reboots the node. The databases are asleep with their proofs when this is called.
    fn reboot(&self) -> impl Future<Output = io::Result<()>> + Send;
    /// The health check (`pgcf-agent check`, plan 5.6 job 10) of the release that is installed:
    /// ok only when the scratch database answered.
    fn health_check(&self) -> impl Future<Output = io::Result<()>> + Send;

    // ---- the kernel's facts
    /// This boot and the running kernel.
    fn boot(&self) -> Option<Boot>;
    /// `MemTotal` and `MemAvailable` now.
    fn memory(&self) -> Option<Memory>;
    /// The CPU times since boot, summed over the cores.
    fn cpu(&self) -> Option<CpuTimes>;
}

/// This boot of the node and the kernel it runs (SEC-03).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Boot {
    /// `/proc/sys/kernel/random/boot_id`: a new one with every boot.
    pub id: String,
    /// `btime` of `/proc/stat`: the boot, in seconds since the epoch.
    pub booted_at: u64,
    /// `uname -r`, which `/proc/sys/kernel/osrelease` holds.
    pub kernel_release: String,
}
impl Boot {
    /// The boot of the texts of the three files, whose contents end in a newline. `None` if one
    /// is not what its file holds, or the kernel's release does not fit the contract.
    pub fn parse(boot_id: &str, stat: &str, osrelease: &str) -> Option<Self> {
        let (id, kernel_release) = (boot_id.trim(), osrelease.trim());
        let fits = (1..=64).contains(&kernel_release.len())
            && kernel_release.bytes().all(|byte| byte.is_ascii_graphic());
        if id.is_empty() || !fits {
            return None;
        }
        Some(Self {
            id: id.into(),
            booted_at: crate::sample::boot_time(stat)?,
            kernel_release: kernel_release.into(),
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node() -> NodeIdentity {
        NodeIdentity {
            id: "nod_nnnnnnnnnnnnnnnnnnnn".into(),
            uid: "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c".into(),
            hostname: "eu1".into(),
            region_id: "eu-dev".into(),
        }
    }

    #[test]
    fn a_boot_is_the_kernels_boot_id_the_boot_time_and_the_release_of_the_running_kernel() {
        let stat = "cpu  4705 150 1120 16250 520 10 55 20 0 0\nctxt 999\nbtime 1792318800\nprocesses 4242\n";
        assert_eq!(
            Boot::parse(
                "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90\n",
                stat,
                "6.12.111+deb13-amd64\n"
            ),
            Some(Boot {
                id: "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90".into(),
                booted_at: 1_792_318_800,
                kernel_release: "6.12.111+deb13-amd64".into(),
            })
        );
        let (id, kernel) = ("2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90\n", "6.12.111\n");
        for broken in [
            Boot::parse("\n", stat, kernel),
            Boot::parse(id, "ctxt 1\n", kernel),
            Boot::parse(id, stat, "\n"),
            Boot::parse(id, stat, &"k".repeat(65)),
            Boot::parse(id, stat, "6.12 amd64\n"),
        ] {
            assert_eq!(broken, None);
        }
    }

    #[tokio::test]
    async fn the_os_report_names_the_boot_the_kernel_and_the_installed_packages() {
        use crate::{machine::local::Local, node_link::contract_valid, update::packages_digest};
        let Some(machine) = Local::new("os-report") else {
            return;
        };
        machine.set_packages(&[("bash", "5.2"), ("libc6", "2.41-1")]);
        let hello = |os: &serde_json::Value| json!({"type": "hello", "protocol": 1, "agent_version": "0.1.0", "release_id": null, "os": os});
        let first = os_report(&machine).await.unwrap();
        assert!(
            contract_valid("AgentLinkMessage", &hello(&first)),
            "{first}"
        );
        assert_eq!(
            first["packages_sha256"],
            packages_digest(&machine.installed_packages().await.unwrap())
        );
        // A reboot is another boot ID, and a kernel installed before it is the kernel after it.
        // The previous kernel stays installed, and of the kernels the running one counts alone.
        machine.set_packages(&[
            ("bash", "5.2"),
            ("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
            ("linux-image-6.12.113+deb13-amd64", "6.12.113-1"),
        ]);
        machine.reboot().await.unwrap();
        let second = os_report(&machine).await.unwrap();
        assert!(
            contract_valid("AgentLinkMessage", &hello(&second)),
            "{second}"
        );
        assert_ne!(second["boot_id"], first["boot_id"]);
        assert_eq!(second["kernel_release"], "6.12.113+deb13-amd64");
        assert_ne!(first["kernel_release"], second["kernel_release"]);
        assert_eq!(
            second["packages_sha256"],
            packages_digest(&BTreeMap::from([
                ("bash".to_string(), "5.2".to_string()),
                (
                    "linux-image-6.12.113+deb13-amd64".to_string(),
                    "6.12.113-1".to_string()
                ),
            ]))
        );
    }

    #[tokio::test]
    async fn a_boot_starts_the_highest_kernel_version_not_the_last_name() {
        use crate::machine::local::Local;
        let Some(machine) = Local::new("os-kernel-order") else {
            return;
        };
        // 6.12.99 sorts after 6.12.113 as text, and 6.9 after 6.12: GRUB orders by version.
        for (images, newest) in [
            (
                ["6.12.99-amd64", "6.12.113+deb13-amd64"],
                "6.12.113+deb13-amd64",
            ),
            (["6.9.12-amd64", "6.12.1-amd64"], "6.12.1-amd64"),
        ] {
            let packages: Vec<(String, &str)> = images
                .iter()
                .map(|abi| (format!("linux-image-{abi}"), "1"))
                .collect();
            let packages: Vec<(&str, &str)> = packages
                .iter()
                .map(|(name, v)| (name.as_str(), *v))
                .collect();
            machine.set_packages(&packages);
            machine.reboot().await.unwrap();
            assert_eq!(machine.boot().unwrap().kernel_release, newest);
        }
    }

    #[test]
    fn the_gateways_environment_names_its_region_its_node_and_the_nodes_keyring() {
        let keyring =
            json!({"active": "k1", "keys": {"k1": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"}});
        let text = gateway_environment(&node(), &json!({"route_keyring": keyring})).unwrap();
        assert_eq!(
            text,
            format!(
                "PGCF_REGION_ID=eu-dev\nPGCF_NODE_ID=nod_nnnnnnnnnnnnnnnnnnnn\nPGCF_ROUTE_KEY='{keyring}'\n"
            )
        );
        // What the gateway reads is what the file says: its three variables parse as it parses them.
        let value = text.lines().last().unwrap();
        let ring = value
            .strip_prefix("PGCF_ROUTE_KEY='")
            .and_then(|rest| rest.strip_suffix('\''))
            .unwrap();
        assert!(pgcf_native_protocol::route::Keyring::parse(ring).is_ok());
    }

    /// A boot loses what lived in memory and in `/run`: the CPU quota of a unit that stopped, and
    /// the socket directories of the databases. The agent restores both when it starts, before a
    /// page comes (the image's boot test requires the directory of a database it made).
    #[tokio::test]
    async fn the_agent_restores_the_quotas_and_the_socket_directories_a_boot_lost() {
        use crate::{agent::check::SCRATCH, machine::local::Local, storage::VolumeId};
        use std::os::unix::fs::PermissionsExt;
        let Some(machine) = Local::new("restore") else {
            return;
        };
        let account = machine.ensure_account(SCRATCH).await.unwrap();
        let volume = VolumeId::new(SCRATCH, 1).unwrap();
        let policy = crate::storage::Policy {
            reserve_bytes: 0,
            metadata_no_room_percent: 100,
            sample_max_age: std::time::Duration::from_secs(60),
        };
        machine
            .create_volume(&volume, 1 << 30, &account, &policy)
            .await
            .unwrap();
        // The unit stopped, and a quota outlived the stop; /run is empty.
        machine.add_stopped_unit(SCRATCH);
        machine
            .set_cpu_quota(SCRATCH, std::num::NonZeroU32::new(250))
            .await
            .unwrap();
        let directory = machine.layout().socket_directory(SCRATCH);
        let _ = std::fs::remove_dir_all(&directory);
        restore_runtime(&machine).await;
        assert_eq!(machine.quota(SCRATCH), Some(None));
        assert_eq!(
            std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o750
        );
    }

    #[test]
    fn credentials_that_could_break_out_of_the_line_are_not_written() {
        let credentials = json!({"route_keyring": {"active": "it's"}});
        assert!(gateway_environment(&node(), &credentials).is_err());
        let credentials = json!({"route_keyring": {"active": "k1"}});
        for broken in [
            NodeIdentity {
                id: "nod_short".into(),
                ..node()
            },
            NodeIdentity {
                region_id: "EU\nPGCF_X=1".into(),
                ..node()
            },
        ] {
            assert!(gateway_environment(&broken, &credentials).is_err());
        }
    }
}
