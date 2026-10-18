// SPDX-License-Identifier: Apache-2.0
//! The node itself: `Storage` on LVM, `Units` over systemd's D-Bus, the users in `/etc/passwd`
//! and `initdb` as the database's user.
use super::{Account, CpuTimes, Machine, Memory, initdb_arguments};
use crate::{
    layout::Layout,
    storage::{
        self, Config, Inventory, NoRoom, PoolSample, Removal, Storage, SystemRunner, VolumeId,
    },
    units::{
        self, Started, UnitState, Units,
        limits::Limits,
        users::{Users, account_name},
    },
};
use std::{
    io,
    num::NonZeroU32,
    os::unix::fs::{DirBuilderExt, PermissionsExt, chown},
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, PoisonError},
};

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
        .find_map(|line| {
            let fields: Vec<String> = line.split(':').map(String::from).collect();
            (fields.first().map(String::as_str) == Some(name)).then_some(fields)
        })
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
        let users = Users::load(layout.uids())?;
        Ok(Self {
            layout,
            storage,
            units,
            users: Mutex::new(users),
        })
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
        region: &str,
        credentials: &serde_json::Value,
        restart: bool,
    ) -> io::Result<()> {
        use crate::link::file::{create_private_directory, sync_directory, write_private};
        let directory = self.layout.state.join("credentials");
        create_private_directory(&directory)?;
        // The route keyring, as the gateway's environment reads it: one line in single quotes,
        // which an environment file takes literally.
        let keyring = serde_json::to_string(&credentials["route_keyring"])?;
        if keyring.contains(['\'', '\n']) || !crate::valid_region(region) {
            return Err(io::Error::other("credentials that cannot be written"));
        }
        write_private(
            &directory.join("gateway.env"),
            format!("PGCF_REGION_ID={region}\nPGCF_ROUTE_KEY='{keyring}'\n").as_bytes(),
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
}
