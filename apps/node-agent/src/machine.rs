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
};
use std::{
    collections::BTreeMap,
    future::Future,
    io,
    num::NonZeroU32,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

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

/// How long the warm-up of the start path may take before the agent stops waiting for it.
pub const WARM_BOUND: Duration = Duration::from_secs(30);

/// After a boot the page cache is empty, and the first wake of a database would read what its
/// start runs from the disk: the helper systemd runs for every unit, `postgres`, and the libraries
/// that `postgres` loads. The kernel is asked to read the first two ahead, and `postgres -V` is
/// run once, which makes the loader map the libraries and touch the pages it needs; its answer is
/// dropped. Every step runs even when an earlier one failed, and the first failure is returned.
/// Past `bound` the warm-up is given up and `postgres` killed. The agent runs this in a task of
/// its own: a node that cannot warm its start path starts all the same.
pub async fn warm_start_path<M: Machine>(machine: &M, bound: Duration) -> io::Result<()> {
    let layout = machine.layout();
    let postgres = layout.postgres_bin.join("postgres");
    let steps = async {
        let server = read_ahead(postgres.clone()).await;
        let executor = read_ahead(layout.systemd_executor.clone()).await;
        let version = postgres_version(&postgres).await;
        server.and(executor).and(version)
    };
    tokio::time::timeout(bound, steps)
        .await
        .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
}

/// Advises the kernel to read `path` into the page cache (`POSIX_FADV_WILLNEED`). The reading is
/// the kernel's, in the background, and skipped when memory is short.
async fn read_ahead(path: PathBuf) -> io::Result<()> {
    tokio::task::spawn_blocking(move || advise_will_need(&std::fs::File::open(path)?))
        .await
        .map_err(io::Error::other)?
}
#[cfg(target_os = "linux")]
fn advise_will_need(file: &std::fs::File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: a plain syscall on a descriptor that is open; length 0 means to the end of the
    // file. It returns the error number itself, not -1.
    let error = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_WILLNEED) };
    match error {
        0 => Ok(()),
        error => Err(io::Error::from_raw_os_error(error)),
    }
}
/// A laptop's tests have no such call; they run the other steps.
#[cfg(not(target_os = "linux"))]
fn advise_will_need(_file: &std::fs::File) -> io::Result<()> {
    Ok(())
}

/// `postgres -V`, killed when the future is dropped.
async fn postgres_version(program: &Path) -> io::Result<()> {
    let status = tokio::process::Command::new(program)
        .arg("-V")
        .env_clear()
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("postgres -V failed"))
    }
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

#[cfg(test)]
mod tests {
    use super::{local::Local, *};
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

    /// A machine whose `postgres` records its arguments in the returned file, and with `stays`
    /// its process ID too, and then becomes a `sleep`; the executor of systemd is a file of the
    /// test. `None` where there is no PostgreSQL 18 (the tests skip).
    fn fake_start_path(label: &str, stays: bool) -> Option<(Local, PathBuf)> {
        use std::os::unix::fs::PermissionsExt;
        let machine = Local::new(label)?;
        let directory = crate::testpg::directory(label);
        let bin = directory.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let marker = directory.join("marker");
        let stay = if stays {
            format!("echo $$ >> '{}'\nexec sleep 60\n", marker.display())
        } else {
            String::new()
        };
        let program = bin.join("postgres");
        std::fs::write(
            &program,
            format!("#!/bin/sh\necho \"$@\" > '{}'\n{stay}", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let executor = directory.join("systemd-executor");
        std::fs::write(&executor, vec![0u8; 1 << 20]).unwrap();
        let machine = machine.with_layout(|layout| {
            layout.postgres_bin = bin;
            layout.systemd_executor = executor;
        });
        Some((machine, marker))
    }

    /// After a boot the page cache is empty. The agent asks `postgres` for its version, which
    /// makes the loader read the server's libraries, and has the kernel read the server and the
    /// executor of systemd ahead, so that the first wake finds them in memory.
    #[tokio::test]
    async fn the_agent_asks_postgres_for_its_version_and_reads_the_start_path_ahead() {
        let Some((machine, marker)) = fake_start_path("warm", false) else {
            return;
        };
        warm_start_path(&machine, Duration::from_secs(10))
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "-V\n");

        // A file that is not there is that step's failure, and the other steps still run.
        let Some((machine, marker)) = fake_start_path("warm-missing", false) else {
            return;
        };
        let machine = machine.with_layout(|layout| {
            layout.systemd_executor = layout.systemd_executor.with_file_name("missing");
        });
        let error = warm_start_path(&machine, Duration::from_secs(10))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "-V\n");
    }

    /// Advice for a file that is there, and the error of one that is not; no machine is needed.
    #[tokio::test]
    async fn the_kernel_is_advised_to_read_a_file_that_is_there() {
        let file = crate::testpg::directory("read-ahead").join("file");
        std::fs::write(&file, vec![0u8; 1 << 20]).unwrap();
        read_ahead(file.clone()).await.unwrap();
        let error = read_ahead(file.with_file_name("missing"))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }

    /// A start path that does not answer is waited for as long as the bound, and its process
    /// does not outlive it.
    #[tokio::test]
    async fn a_warm_up_that_does_not_finish_ends_at_its_bound_and_leaves_no_process() {
        let Some((machine, marker)) = fake_start_path("warm-stuck", true) else {
            return;
        };
        let started = std::time::Instant::now();
        let warm =
            tokio::spawn(async move { warm_start_path(&machine, Duration::from_secs(3)).await });
        // The process is running once it has written its ID, the second line.
        let pid = loop {
            let text = std::fs::read_to_string(&marker).unwrap_or_default();
            if let Some(pid) = text.lines().nth(1) {
                break pid.to_string();
            }
            assert!(started.elapsed() < Duration::from_secs(3), "it never ran");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let error = warm.await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        for _ in 0..100 {
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid])
                .output()
                .unwrap()
                .status
                .success();
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!("the process {pid} of the warm-up is still running");
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
