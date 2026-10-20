// SPDX-License-Identifier: Apache-2.0
//! The node itself: `Storage` on LVM, `Units` over systemd's D-Bus, the users in `/etc/passwd`
//! and `initdb` as the database's user.
use super::{
    Account, Boot, CpuTimes, Machine, Memory, Throttle, gateway_environment, initdb_arguments,
};
use crate::{
    diagnostics::probe,
    layout::Layout,
    link::NodeIdentity,
    storage::{
        self, Config, Inventory, NoRoom, PoolSample, Removal, Storage, SystemRunner, VolumeId,
    },
    units::{
        self, Started, Timeline, UnitState, Units,
        limits::Limits,
        users::{Users, account_name},
    },
};
use std::{
    collections::BTreeMap,
    io,
    num::NonZeroU32,
    os::unix::fs::{DirBuilderExt, PermissionsExt, chown},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, PoisonError},
};

/// The image's apt sources for the Debian snapshot (`mkosi.postinst.chroot`).
const APT_SOURCES: &str = "/etc/apt/sources.list.d/trixie.sources";
/// The group of the gateway, which reads the database's socket directory (plan 5.5).
const GATEWAY_GROUP: &str = "pgcf-gateway";
/// The locale of every database (plan Appendix C): the image has it.
const LOCALE: &str = "C.UTF-8";
/// Clock ticks per second of `/proc/stat`; the kernel's `USER_HZ`, 100 on every Linux the node
/// image runs.
const USER_HZ: u64 = 100;

pub struct Node {
    layout: Layout,
    storage: Arc<Storage<SystemRunner>>,
    units: Units,
    users: Mutex<Users>,
}

/// The first entry of a colon-separated database such as `/etc/passwd` or `/etc/group` whose first
/// field is `name`: its fields.
fn lookup(path: &str, name: &str) -> Option<Vec<String>> {
    std::fs::read_to_string(path)
        .ok()?
        .lines()
        .find(|line| line.split(':').next() == Some(name))
        .map(|line| line.split(':').map(String::from).collect())
}

/// Runs a program of the system to its end; its failure carries what it said.
async fn run(program: &str, arguments: &[&str]) -> io::Result<()> {
    let output = tokio::process::Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .output()
        .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{program} ended with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

impl Node {
    /// Connects to systemd and opens the node's storage: the volume group and the pool exist as
    /// plan 4.3 describes, or are made.
    pub async fn connect(layout: Layout, storage: Config) -> Result<Self, crate::Error> {
        let units = Units::connect(layout.volumes()).await?;
        let storage = Arc::new(Storage::new(SystemRunner, storage));
        {
            let storage = storage.clone();
            tokio::task::spawn_blocking(move || storage.open()).await??;
        }
        // What the agent keeps of its own, below a directory only root reads.
        crate::link::file::create_private_directory(&layout.agent())?;
        let users = Users::load(layout.uids())?;
        Ok(Self {
            layout,
            storage,
            units,
            users: Mutex::new(users),
        })
    }
    /// The agent's start, and only the agent's (not the check's, which runs `connect` too): the
    /// device links of an earlier agent are dropped, because the namespace that held the volumes
    /// they name is gone. Each volume gets its link back when it is attached.
    pub async fn reset_device_links(&self) -> Result<(), storage::Error> {
        self.storage(|storage| storage.reset_device_links()).await
    }
    /// The agent's exit: its mounts of the volumes go, many at once, before the kernel would end
    /// them one by one with the namespace (`Storage::unmount_all`).
    pub async fn release_mounts(&self) {
        let _ = self
            .storage(|storage| {
                storage.unmount_all();
                Ok(())
            })
            .await;
    }
    /// The user of the scratch database that `pgcf-agent check` makes, or finds: a system account
    /// of the system's own uid range. The agent's table of uids stays the running agent's alone;
    /// a second process, the check, never writes it.
    pub async fn scratch_account(&self, database: &str) -> io::Result<Account> {
        if let Some(account) = self.account(database) {
            return Ok(account);
        }
        let name = account_name(database);
        run("groupadd", &["--system", &name]).await?;
        run(
            "useradd",
            &[
                "--system",
                "-g",
                &name,
                "-M",
                "-s",
                "/usr/sbin/nologin",
                "-d",
                "/nonexistent",
                &name,
            ],
        )
        .await?;
        self.account(database)
            .ok_or_else(|| io::Error::other("the account is missing after it was made"))
    }

    fn users(&self) -> std::sync::MutexGuard<'_, Users> {
        self.users.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Runs a blocking storage call on the blocking pool.
    async fn storage<T: Send + 'static>(
        &self,
        call: impl FnOnce(&Storage<SystemRunner>) -> Result<T, storage::Error> + Send + 'static,
    ) -> Result<T, storage::Error> {
        let storage = self.storage.clone();
        tokio::task::spawn_blocking(move || call(&storage))
            .await
            .map_err(|error| storage::Error::Io(io::Error::other(error)))?
    }

    /// The gateway's environment file and the Tunnel's token, each where its unit reads it, and
    /// the two units started, or restarted when `restart`.
    async fn apply_gateway_credentials(
        &self,
        node: &NodeIdentity,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> io::Result<()> {
        use crate::link::file::{create_private_directory, sync_directory, write_private};
        let directory = self.layout.state.join("credentials");
        create_private_directory(&directory)?;
        write_private(
            &directory.join("gateway.env"),
            gateway_environment(node, credentials)?.as_bytes(),
        )?;
        // The Tunnel token becomes an encrypted systemd credential: through a file, since a
        // command line is public to the node's users.
        let token = credentials["tunnel_token"]
            .as_str()
            .ok_or_else(|| io::Error::other("no Tunnel token"))?;
        let work = directory.join(".tunnel-token.work");
        let _ = std::fs::remove_dir_all(&work);
        create_private_directory(&work)?;
        write_private(&work.join("token"), token.as_bytes())?;
        let encrypted = run(
            "systemd-creds",
            &[
                "encrypt",
                "--with-key=host",
                "--name=tunnel-token",
                &work.join("token").to_string_lossy(),
                &work.join("tunnel-token.cred").to_string_lossy(),
            ],
        )
        .await;
        let moved = encrypted.and_then(|()| {
            std::fs::rename(
                work.join("tunnel-token.cred"),
                directory.join("tunnel-token.cred"),
            )?;
            sync_directory(&directory)
        });
        let _ = std::fs::remove_dir_all(&work);
        moved?;
        for unit in ["pgcf-gateway.service", "pgcf-cloudflared.service"] {
            self.units
                .start_service(unit, restart)
                .await
                .map_err(|error| io::Error::other(error.to_string()))?;
        }
        Ok(())
    }
}

impl Machine for Node {
    fn layout(&self) -> &Layout {
        &self.layout
    }

    async fn ensure_account(&self, database: &str) -> io::Result<Account> {
        let uid = self.users().allocate(database)?;
        let name = account_name(database);
        if let Some(account) = self.account(database) {
            if account.uid != uid {
                return Err(io::Error::other(
                    "the account has another uid than the agent gave it",
                ));
            }
            return Ok(account);
        }
        let uid_text = uid.to_string();
        run("groupadd", &["-g", &uid_text, &name]).await?;
        run(
            "useradd",
            &[
                "-u",
                &uid_text,
                "-g",
                &name,
                "-M",
                "-s",
                "/usr/sbin/nologin",
                "-d",
                "/nonexistent",
                &name,
            ],
        )
        .await?;
        Ok(Account {
            name,
            uid,
            gid: uid,
        })
    }

    fn account(&self, database: &str) -> Option<Account> {
        let name = account_name(database);
        let fields = lookup("/etc/passwd", &name)?;
        Some(Account {
            uid: fields.get(2)?.parse().ok()?,
            gid: fields.get(3)?.parse().ok()?,
            name,
        })
    }

    async fn remove_account(&self, database: &str) -> io::Result<()> {
        let name = account_name(database);
        if lookup("/etc/passwd", &name).is_some() {
            run("userdel", &[&name]).await?;
        }
        if lookup("/etc/group", &name).is_some() {
            run("groupdel", &[&name]).await?;
        }
        self.users().release(database)
    }

    async fn create_volume(
        &self,
        id: &VolumeId,
        size_bytes: u64,
        account: &Account,
        policy: &storage::Policy,
    ) -> Result<(), storage::Error> {
        let (volume, policy) = (id.clone(), policy.clone());
        self.storage(move |storage| storage.create_volume(&volume, size_bytes, &policy))
            .await?;
        // The mount point is the database's: it holds the data directory and the files of a
        // restore, and nobody else lists it.
        let mount = self.layout.volume(id.database());
        chown(&mount, Some(account.uid), Some(account.gid))?;
        std::fs::set_permissions(&mount, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    async fn has_volume(&self, id: &VolumeId) -> Result<bool, storage::Error> {
        let id = id.clone();
        self.storage(move |storage| storage.exists(&id)).await
    }

    fn attached(&self, id: &VolumeId) -> bool {
        self.storage.attached(id)
    }

    async fn unit_volume(&self, database: &str) -> Result<Option<VolumeId>, storage::Error> {
        let unit = self
            .units
            .state(database)
            .await
            .map_err(|_| storage::Error::Unexpected("the state of the database's unit"))?;
        if !unit.active.awake() {
            return Ok(None);
        }
        let pid = unit.main_pid.ok_or(storage::Error::Unexpected(
            "a unit that runs without a main process",
        ))?;
        let database = database.to_string();
        let volume = self
            .storage(move |storage| storage.volume_mounted_by(pid, &database))
            .await?;
        volume.map(Some).ok_or(storage::Error::Unexpected(
            "a unit that runs without its volume",
        ))
    }

    async fn mount_volumes(
        &self,
        current: &[VolumeId],
    ) -> Result<Vec<(VolumeId, storage::Error)>, storage::Error> {
        let current = current.to_vec();
        self.storage(move |storage| storage.mount_all(&current))
            .await
    }

    async fn unmount_volume(&self, id: &VolumeId) -> Result<(), storage::Error> {
        let id = id.clone();
        self.storage(move |storage| storage.unmount_volume(&id))
            .await
    }

    async fn grow_volume(&self, id: &VolumeId, size_bytes: u64) -> Result<(), storage::Error> {
        let id = id.clone();
        self.storage(move |storage| storage.grow_volume(&id, size_bytes))
            .await
    }

    async fn remove_volume(&self, id: &VolumeId, removal: Removal) -> Result<(), storage::Error> {
        let id = id.clone();
        self.storage(move |storage| match storage.remove_volume(&id, removal) {
            // The unit is stopped; a volume that stays mounted for the next wake goes with its
            // database, after the order has been checked.
            Err(storage::Error::Mounted) => {
                storage.unmount_volume(&id)?;
                storage.remove_volume(&id, removal)
            }
            other => other,
        })
        .await
    }

    async fn trim_volume(&self, id: &VolumeId) -> Result<(), storage::Error> {
        let id = id.clone();
        self.storage(move |storage| storage.trim_volume(&id)).await
    }

    async fn needs_repair(&self, id: &VolumeId) -> Result<bool, storage::Error> {
        let id = id.clone();
        self.storage(move |storage| storage.needs_repair(&id)).await
    }

    async fn recover_volume(
        &self,
        id: &VolumeId,
        policy: &storage::Policy,
    ) -> Result<(), storage::Error> {
        let (id, policy) = (id.clone(), policy.clone());
        self.storage(move |storage| storage.recover_volume(&id, &policy))
            .await
    }

    async fn inventory(&self) -> Result<Inventory, storage::Error> {
        self.storage(|storage| storage.inventory()).await
    }

    async fn poll_pool(&self) -> Result<PoolSample, storage::Error> {
        self.storage(|storage| storage.poll_pool()).await
    }

    fn room(&self, policy: &storage::Policy) -> Result<(), NoRoom> {
        self.storage.room(policy)
    }

    fn device(&self, id: &VolumeId) -> String {
        self.storage.device(id)
    }

    fn archive_command(&self, _database: &str) -> String {
        self.layout.archive_command.clone()
    }

    fn agent_user(&self) -> String {
        "root".into()
    }

    fn prepare_socket_directory(&self, database: &str, account: &Account) -> io::Result<()> {
        let gateway = lookup("/etc/group", GATEWAY_GROUP)
            .and_then(|fields| fields.get(2)?.parse::<u32>().ok())
            .ok_or_else(|| io::Error::other("the gateway's group does not exist"))?;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(&self.layout.run)?;
        let directory = self.layout.socket_directory(database);
        match std::fs::DirBuilder::new().mode(0o750).create(&directory) {
            Err(error) if error.kind() != io::ErrorKind::AlreadyExists => return Err(error),
            _ => {}
        }
        chown(&directory, Some(account.uid), Some(gateway))?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o750))
    }

    async fn initdb(&self, account: &Account, data: &Path) -> io::Result<()> {
        let output = tokio::process::Command::new(self.layout.postgres_bin.join("initdb"))
            .args(initdb_arguments(data, Some(LOCALE)))
            .uid(account.uid)
            .gid(account.gid)
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "initdb ended with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }

    async fn unit(&self, database: &str) -> Result<UnitState, units::Error> {
        self.units.state(database).await
    }
    async fn units(&self) -> Result<Vec<UnitState>, units::Error> {
        self.units.running().await
    }
    async fn start(&self, database: &str) -> Result<Started, units::Error> {
        self.units.start(database).await
    }
    async fn wait_started(&self, database: &str) -> Result<Started, units::Error> {
        self.units.wait_started(database).await
    }
    async fn start_timeline(
        &self,
        database: &str,
        started: &Started,
    ) -> Result<Timeline, units::Error> {
        self.units.timeline(database, started).await
    }
    async fn stop(&self, database: &str) -> Result<(), units::Error> {
        self.units.stop(database).await
    }
    async fn set_limits(&self, database: &str, limits: &Limits) -> Result<(), units::Error> {
        self.units.set_limits(database, limits).await
    }
    async fn set_cpu_quota(
        &self,
        database: &str,
        millicores: Option<NonZeroU32>,
    ) -> Result<(), units::Error> {
        self.units.set_cpu_quota(database, millicores).await
    }
    async fn set_slice_memory(&self, awake_budget_mib: u64) -> Result<(), units::Error> {
        self.units.set_slice_memory(awake_budget_mib).await
    }

    async fn apply_credentials(
        &self,
        node: &NodeIdentity,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> io::Result<()> {
        // The shell's key first, so that a shell Cloudflare turned off is closed whatever fails
        // below, and a failure here does not keep the gateway from starting: the error is
        // returned at the end, the revision stays unapplied, and the next page reads the
        // credentials again.
        let shell = crate::shell_ca::apply(
            &self.layout.ssh_user_ca,
            crate::shell_ca::key_of(credentials),
        );
        if let Ok(change) = shell
            && let Some(event) = change.event()
        {
            crate::timing::emit_event(serde_json::json!({ "event": event }));
        }
        let gateway = self
            .apply_gateway_credentials(node, credentials, restart)
            .await;
        gateway.and(shell.map(|_| ()))
    }

    async fn restart_service(&self, unit: &str) -> Result<(), units::Error> {
        self.units.start_service(unit, true).await
    }

    async fn daemon_reload(&self) -> Result<(), units::Error> {
        self.units.reload().await
    }

    async fn run_sysusers(&self, file: &str) -> io::Result<()> {
        run("systemd-sysusers", &[file]).await
    }

    async fn run_tmpfiles(&self, file: &str) -> io::Result<()> {
        run("systemd-tmpfiles", &["--create", file]).await
    }

    async fn installed_packages(&self) -> io::Result<BTreeMap<String, String>> {
        let output = tokio::process::Command::new("dpkg-query")
            .args(["-W", "-f", "${db:Status-Abbrev}\t${Package}\t${Version}\n"])
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            return Err(io::Error::other("dpkg-query failed"));
        }
        Ok(crate::update::installed_packages(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    async fn install_packages(
        &self,
        snapshot: &str,
        versions: &[String],
        files: &[std::path::PathBuf],
    ) -> io::Result<()> {
        // The node's apt sources name the snapshot of the image; the release names another.
        let sources = Path::new(APT_SOURCES);
        let rewritten = crate::update::apt_sources(&std::fs::read_to_string(sources)?, snapshot)
            .ok_or_else(|| io::Error::other("the apt sources name no snapshot"))?;
        crate::link::file::write_private(sources, rewritten.as_bytes())?;
        std::fs::set_permissions(sources, std::fs::Permissions::from_mode(0o644))?;
        let apt = |arguments: Vec<String>| async move {
            let output = tokio::process::Command::new("apt-get")
                .args(&arguments)
                .env("LC_ALL", "C")
                .env("DEBIAN_FRONTEND", "noninteractive")
                .stdin(Stdio::null())
                .output()
                .await?;
            if output.status.success() {
                Ok(())
            } else {
                Err(io::Error::other(format!(
                    "apt-get {} ended with {}: {}",
                    arguments.first().map_or("", String::as_str),
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                )))
            }
        };
        apt(vec!["update".into()]).await?;
        // The conffiles of the image (nftables) are kept as they are; versions are exact, so a
        // package may also go down; recommendations are not installed.
        let mut install: Vec<String> = [
            "install",
            "--yes",
            "--no-install-recommends",
            "--allow-downgrades",
            "-o",
            "Dpkg::Options::=--force-confold",
        ]
        .map(String::from)
        .into();
        install.extend(versions.iter().cloned());
        install.extend(files.iter().map(|file| file.to_string_lossy().into_owned()));
        apt(install).await
    }

    async fn purge_packages(&self, names: &[String]) -> io::Result<()> {
        if let Some(name) = names
            .iter()
            .find(|name| !crate::update::is_package_name(name))
        {
            return Err(io::Error::other(format!("{name:?} is not a package name")));
        }
        let output = tokio::process::Command::new("dpkg-query")
            .args(["-W", "-f", "${Package}\t${Essential}\t${Protected}\n"])
            .args(names)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()
            .await?;
        if !output.status.success() {
            return Err(io::Error::other("dpkg-query failed"));
        }
        let names = crate::update::without_protected(
            names.to_vec(),
            &String::from_utf8_lossy(&output.stdout),
        );
        if names.is_empty() {
            return Ok(());
        }
        let output = tokio::process::Command::new("dpkg")
            .arg("--purge")
            .args(&names)
            .env("LC_ALL", "C")
            .env("DEBIAN_FRONTEND", "noninteractive")
            .stdin(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "dpkg --purge ended with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }

    async fn reboot(&self) -> io::Result<()> {
        run("systemctl", &["reboot"]).await
    }

    async fn health_check(&self) -> io::Result<()> {
        // The binary of the release that is installed, not this process: a check of the new build.
        let output = tokio::process::Command::new(self.layout.bin().join("current/pgcf-agent"))
            .arg("check")
            .stdin(Stdio::null())
            .output()
            .await;
        // The check tags the volumes it finds mounted when the pool takes no writes, in a storage
        // of its own: what this one listed before may be out of date, however the check ended.
        self.storage.changed_elsewhere();
        let output = output?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "pgcf-agent check ended with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }

    async fn previous_boot_journal(&self) -> io::Result<Option<String>> {
        let output = tokio::process::Command::new("journalctl")
            .args(crate::diagnostics::boot_report::previous_boot_arguments())
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await?;
        crate::diagnostics::boot_report::previous_boot(&output)
    }

    async fn diagnostic(&self, argv: &probe::Argv) -> io::Result<std::process::Output> {
        tokio::process::Command::new(argv.program)
            .args(&argv.arguments)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
    }

    fn proc_file(&self, file: probe::ProcFile) -> io::Result<String> {
        std::fs::read_to_string(file.path())
    }

    fn boot(&self) -> Option<Boot> {
        let read = |path| std::fs::read_to_string(path).ok();
        Boot::parse(
            &read("/proc/sys/kernel/random/boot_id")?,
            &read("/proc/stat")?,
            &read("/proc/sys/kernel/osrelease")?,
        )
    }

    fn memory(&self) -> Option<Memory> {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let field = |name: &str| {
            text.lines().find_map(|line| {
                let kib: u64 = line
                    .strip_prefix(name)?
                    .strip_prefix(':')?
                    .trim()
                    .strip_suffix("kB")?
                    .trim()
                    .parse()
                    .ok()?;
                kib.checked_mul(1024)
            })
        };
        Some(Memory {
            total_bytes: field("MemTotal")?,
            available_bytes: field("MemAvailable")?,
        })
    }

    fn cpu(&self) -> Option<CpuTimes> {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        crate::sample::cpu_times(&text, USER_HZ)
    }

    fn throttle(&self, database: &str) -> Option<Throttle> {
        let text = std::fs::read_to_string(units::cpu_stat_path(database)?).ok()?;
        crate::sample::throttle(&text)
    }

    fn cache_residency(&self, database: &str) -> Option<crate::cache::Residency> {
        crate::cache::host(&self.layout.data(database))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wake looks its database's user up twice, in a file with a line for every database.
    #[test]
    fn a_user_is_found_by_the_first_field_of_its_line_alone() {
        let path = std::env::temp_dir().join(format!("pgcf-lookup-{}", std::process::id()));
        let text =
            "root:x:0:0:root:/root:/bin/bash\npgcf-a:x:20000:20001::/nonexistent:/bin/false\n";
        std::fs::write(&path, text).unwrap();
        let path_text = path.to_str().unwrap();
        let found = lookup(path_text, "pgcf-a").unwrap();
        assert_eq!(found[2..4], ["20000", "20001"]);
        assert!(lookup(path_text, "20000").is_none() && lookup(path_text, "pgcf").is_none());
        assert!(lookup("/nonexistent/passwd", "root").is_none());
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod lab {
    //! The node's machine against a real systemd as PID 1, LVM on a loop device and PostgreSQL 18.
    //! It runs as root in the lab with the node image's units (`pgcf-pg@.service`, `pgcf.slice`, the
    //! masks of `modprobe@loop`, `@dm_mod` and `@dm_verity`) and a group `pgcf-gateway`, with
    //! `--ignored`; anywhere else it is skipped. It makes users, a volume group and a database, and
    //! removes them again. Like the units' lab it belongs under `unshare --mount --propagation
    //! slave`, so that its mounts stay out of PID 1's namespace as the agent's do.
    use super::*;
    use crate::{
        machine::Machine,
        postgres, settings,
        storage::{Policy, Removal, VolumeId},
        units::limits::{Io, Limits},
    };
    use std::{path::PathBuf, process::Command, time::Duration};

    const ID: &str = "labnode0000000000001";

    fn sh(program: &str, args: &[&str]) -> String {
        let output = Command::new(program).args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{program} {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
    /// A property of a unit, as `systemctl show` spells it.
    fn show(unit: &str, property: &str) -> String {
        sh("systemctl", &["show", "-p", property, "--value", unit])
    }

    /// What udev does on a node and a container does not: the `/dev/dm-<minor>` node of a
    /// device-mapper device, which systemd's image dissection reads the device number through.
    fn dm_node(device: &str) {
        let name = device.trim_start_matches("/dev/mapper/");
        let info = sh(
            "dmsetup",
            &["info", "-c", "--noheadings", "-o", "major,minor", name],
        );
        let (major, minor) = info.split_once(':').unwrap();
        let node = format!("/dev/dm-{minor}");
        if !Path::new(&node).exists() {
            sh("mknod", &[&node, "b", major, minor]);
        }
    }

    /// The loop device, the volume group and the users, removed again however the test ends.
    struct Lab {
        disk: PathBuf,
        loop_device: String,
        group: String,
    }
    impl Drop for Lab {
        fn drop(&mut self) {
            let run = |program: &str, args: &[&str]| {
                let _ = Command::new(program).args(args).output();
            };
            run("systemctl", &["stop", &format!("pgcf-pg@{ID}.service")]);
            run("umount", &[&format!("/var/lib/pgcf/db/{ID}")]);
            let _ = std::fs::remove_file(format!("/run/pgcf/dev/{ID}"));
            run("vgremove", &["-f", &self.group]);
            run("losetup", &["-d", &self.loop_device]);
            run("userdel", &[&format!("pgcf-{ID}")]);
            run("groupdel", &[&format!("pgcf-{ID}")]);
            let _ = std::fs::remove_dir_all(format!("/run/pgcf/{ID}"));
            let _ = std::fs::remove_file(&self.disk);
        }
    }

    #[tokio::test]
    #[ignore = "needs systemd as PID 1, root, LVM and the node image's units (lab)"]
    async fn a_database_lives_on_the_real_stack_from_its_account_to_its_removal() {
        if !Path::new("/run/systemd/system").is_dir() || unsafe { libc::geteuid() } != 0 {
            eprintln!("skipped: needs systemd as PID 1 and root");
            return;
        }
        let group = format!("pgcflab{}", std::process::id());
        let disk = std::env::temp_dir().join(format!("{group}.img"));
        std::fs::File::create(&disk)
            .unwrap()
            .set_len(4 << 30)
            .unwrap();
        let loop_device = sh("losetup", &["-f", "--show", disk.to_str().unwrap()]);
        let _lab = Lab {
            disk,
            loop_device: loop_device.clone(),
            group: group.clone(),
        };
        let layout = Layout::default();
        let node = Node::connect(
            layout.clone(),
            storage::Config {
                device: loop_device.into(),
                group,
                ..storage::Config::default()
            },
        )
        .await
        .unwrap();
        let policy = Policy {
            reserve_bytes: 0,
            metadata_no_room_percent: 100,
            sample_max_age: Duration::from_secs(60),
        };
        let volume = VolumeId::new(ID, 1).unwrap();

        // The database's user has the uid the agent handed it, and a second call finds it.
        let account = node.ensure_account(ID).await.unwrap();
        assert_eq!(node.account(ID), Some(account.clone()));
        assert_eq!(node.ensure_account(ID).await.unwrap(), account);
        assert_eq!(account.name, format!("pgcf-{ID}"));

        // Its volume is made, formatted and mounted for it; its socket directory is the gateway's
        // to read; initdb runs as the database's user.
        node.poll_pool().await.unwrap();
        node.create_volume(&volume, 1 << 30, &account, &policy)
            .await
            .unwrap();
        assert!(node.has_volume(&volume).await.unwrap());
        let owner = |path: &Path| {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(path).unwrap();
            (metadata.uid(), metadata.mode() & 0o777)
        };
        assert_eq!(owner(&layout.volume(ID)), (account.uid, 0o700));
        // The agent has attached the volume, so the unit has its link, and only the agent's
        // namespace has the mount.
        let link = layout.device_link(ID);
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            PathBuf::from(node.device(&volume))
        );
        dm_node(&node.device(&volume));
        node.prepare_socket_directory(ID, &account).unwrap();
        assert_eq!(owner(&layout.socket_directory(ID)), (account.uid, 0o750));
        let data = layout.data(ID);
        node.initdb(&account, &data).await.unwrap();
        assert_eq!(owner(&data.join("PG_VERSION")).0, account.uid);

        // The agent's configuration, written for the database's user, and the unit's limits.
        let socket = layout.socket_directory(ID);
        let conf = settings::postgresql_conf(&settings::Settings {
            socket_directory: &socket,
            memory_mib: 512,
            volume_bytes: 1 << 30,
            max_connections: 20,
            archive_timeout_seconds: 60,
            archive_command: None,
        })
        .unwrap();
        let ident = settings::pg_ident(&node.agent_user(), &account.name).unwrap();
        for (name, content) in [
            ("postgresql.conf", conf.as_str()),
            ("pg_hba.conf", settings::PG_HBA),
            ("pg_ident.conf", ident.as_str()),
        ] {
            std::fs::write(data.join(name), content).unwrap();
            chown(data.join(name), Some(account.uid), Some(account.gid)).unwrap();
        }
        let unit = format!("pgcf-pg@{ID}.service");
        node.set_limits(
            ID,
            &Limits {
                memory_mib: 512,
                cpu_millicores: 500,
                tasks_max: 64,
                io: Some(Io::scaled(node.device(&volume), 20 << 20, 500, 512)),
            },
        )
        .await
        .unwrap();
        assert_eq!(show(&unit, "MemoryMax"), (512u64 << 20).to_string());
        assert_eq!(show(&unit, "CPUWeight"), "50");

        // It starts as its user, answers the agent over the socket, takes a CPU quota that its
        // stop lifts again.
        assert!(node.attached(&volume));
        assert_eq!(node.unit_volume(ID).await.unwrap(), None);
        let started = node.start(ID).await.unwrap();
        assert_eq!(started.uid, account.uid);
        // The unit has mounted the volume itself, and that mount is what tells which volume it
        // serves, whatever the agent has mounted: the agent's namespace ending (its restart)
        // leaves the unit, its mount and the answer as they are.
        assert_eq!(node.unit_volume(ID).await.unwrap(), Some(volume.clone()));
        sh("umount", &[&format!("/var/lib/pgcf/db/{ID}")]);
        node.reset_device_links().await.unwrap();
        assert!(!node.attached(&volume));
        assert_eq!(node.unit_volume(ID).await.unwrap(), Some(volume.clone()));
        // The restarted agent has no mount of the volume, and the unit has: what the agent's mount
        // table says is free is held. It is not detached, repaired or removed from under the unit,
        // and the next generation is neither made nor mounted over it.
        let busy = |result: Result<(), storage::Error>| {
            assert!(matches!(result, Err(storage::Error::Busy)), "{result:?}");
        };
        busy(node.unmount_volume(&volume).await);
        busy(node.recover_volume(&volume, &policy).await);
        let ordered = Removal::DatabaseDeleted {
            storage_generation: 1,
        };
        busy(node.remove_volume(&volume, ordered).await);
        assert!(node.has_volume(&volume).await.unwrap() && !node.attached(&volume));
        let next = VolumeId::new(ID, 2).unwrap();
        let refused = node.create_volume(&next, 1 << 30, &account, &policy).await;
        assert!(
            matches!(refused, Err(storage::Error::OtherGeneration)),
            "{refused:?}"
        );
        assert!(!node.has_volume(&next).await.unwrap());
        assert_eq!(node.unit_volume(ID).await.unwrap(), Some(volume.clone()));
        // The agent's unmount of a volume that a unit holds is refused: it is mounted again.
        assert!(
            node.mount_volumes(std::slice::from_ref(&volume))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(node.attached(&volume));
        let busy = node.unmount_volume(&volume).await.unwrap_err();
        assert!(matches!(busy, storage::Error::Busy), "{busy:?}");
        assert!(node.attached(&volume));
        node.set_cpu_quota(ID, NonZeroU32::new(250)).await.unwrap();
        assert_eq!(show(&unit, "CPUQuotaPerSecUSec"), "250ms");
        let session = postgres::agent(&socket).await.unwrap();
        assert_eq!(
            session
                .query("SELECT 1::int4", &[])
                .await
                .unwrap()
                .first()
                .map(|row| row.get::<_, i32>(0)),
            Some(1)
        );
        drop(session);
        node.stop(ID).await.unwrap();
        assert_eq!(show(&unit, "CPUQuotaPerSecUSec"), "infinity");
        assert!(!node.unit(ID).await.unwrap().active.awake());
        assert_eq!(node.unit_volume(ID).await.unwrap(), None);

        // The volume grows online, is trimmed, unmounted and mounted again as after a boot.
        node.grow_volume(&volume, 2 << 30).await.unwrap();
        node.trim_volume(&volume).await.unwrap();
        let listed = |inventory: Inventory| {
            inventory
                .volumes
                .into_iter()
                .find(|info| info.id == volume)
                .map(|info| (info.size_bytes, info.mounted()))
        };
        assert_eq!(
            listed(node.inventory().await.unwrap()),
            Some((2 << 30, true))
        );
        node.unmount_volume(&volume).await.unwrap();
        assert_eq!(
            listed(node.inventory().await.unwrap()),
            Some((2 << 30, false))
        );
        // A volume that is not attached has no link: no start on its empty directory.
        assert!(!node.attached(&volume));
        assert!(std::fs::symlink_metadata(&link).is_err());
        let refused = node.start(ID).await.unwrap_err();
        assert!(
            matches!(&refused, units::Error::Job { result, .. } if result == "assert"),
            "{refused:?}"
        );
        assert!(
            node.mount_volumes(std::slice::from_ref(&volume))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(data.join("PG_VERSION").exists());
        assert!(node.attached(&volume));
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            PathBuf::from(node.device(&volume))
        );
        // The agent's start drops every link; the volume gets its own back when it is attached.
        node.reset_device_links().await.unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert!(
            node.mount_volumes(std::slice::from_ref(&volume))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(std::fs::symlink_metadata(&link).is_ok());

        // The memory all databases may hold together, and what the kernel reports.
        node.set_slice_memory(300).await.unwrap();
        assert_eq!(show("pgcf.slice", "MemoryMax"), (300u64 << 20).to_string());
        assert!(node.memory().is_some_and(|memory| memory.total_bytes > 0));
        assert!(node.cpu().is_some_and(|cpu| cpu.cores > 0));

        // A deleted database takes its volume and its user with it, and the uid is free again.
        node.remove_volume(
            &volume,
            Removal::DatabaseDeleted {
                storage_generation: 1,
            },
        )
        .await
        .unwrap();
        assert!(!node.has_volume(&volume).await.unwrap());
        node.remove_account(ID).await.unwrap();
        assert_eq!(node.account(ID), None);
    }
}
