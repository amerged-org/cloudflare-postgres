// SPDX-License-Identifier: Apache-2.0
use crate::{
    containerd::{
        services::{containers::v1 as containers, sandbox::v1::*, tasks::v1 as tasks},
        task::v3,
        types::Platform,
    },
    cri::{self, PodSandboxConfig},
    policy::{Authority, Client},
    slot::{Identity, Settings, Slot},
    transport,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tonic::{Request, Response, Status};

struct Assigned {
    slot: Slot,
    created: bool,
    started: bool,
    labels: HashMap<String, String>,
    spec: Option<prost_types::Any>,
    pod: cri::PodSandboxMetadata,
    source: String,
    protective_storage_authority: Option<String>,
}
struct Pool {
    available: Vec<Slot>,
    retiring: Vec<Slot>,
    assigned: HashMap<String, Assigned>,
    authority: Option<Authority>,
    claiming: HashSet<String>,
    material_revision: Option<u32>,
    retired_storage: HashMap<String, RetiredStorage>,
}
struct RetiredStorage {
    owner: Owner,
    directory: std::path::PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    sandbox_id: String,
    identity: Identity,
    created: bool,
    started: bool,
    pod_uid: String,
    pod_name: String,
    pod_namespace: String,
    pod_attempt: u32,
    network_device: u64,
    network_inode: u64,
    created_ms: u64,
    profile: Option<crate::policy::Profile>,
    source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protective_storage_authority: Option<String>,
    #[serde(default)]
    retired: bool,
}
fn save_owner(id: &str, entry: &Assigned) -> Result<(), Status> {
    save_owner_mode(id, entry, false)
}
fn save_owner_mode(id: &str, entry: &Assigned, retired: bool) -> Result<(), Status> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let network = entry
        .slot
        .assigned_network
        .ok_or_else(|| Status::failed_precondition("assigned_network_missing"))?;
    let owner = Owner {
        sandbox_id: id.into(),
        identity: entry.slot.identity.clone(),
        created: entry.created,
        started: entry.started,
        pod_uid: entry.pod.uid.clone(),
        pod_name: entry.pod.name.clone(),
        pod_namespace: entry.pod.namespace.clone(),
        pod_attempt: entry.pod.attempt,
        network_device: network.device,
        network_inode: network.inode,
        created_ms: entry
            .slot
            .created_at
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        profile: entry.slot.profile.clone(),
        source: entry.source.clone(),
        protective_storage_authority: entry.protective_storage_authority.clone(),
        retired,
    };
    let path = entry.slot.directory.join("owner.pending");
    let target = entry.slot.directory.join("owner.json");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .map_err(|_| Status::internal("runtime_owner_write_failed"))?;
    file.write_all(
        &serde_json::to_vec(&owner).map_err(|_| Status::internal("runtime_owner_encode_failed"))?,
    )
    .and_then(|()| file.sync_all())
    .map_err(|_| Status::internal("runtime_owner_write_failed"))?;
    std::fs::rename(path, target)
        .and_then(|()| std::fs::File::open(&entry.slot.directory)?.sync_all())
        .map_err(|_| Status::internal("runtime_owner_commit_failed"))
}
#[derive(Clone)]
pub struct SandboxController {
    settings: Arc<Settings>,
    pool: Arc<Mutex<Pool>>,
    _ownership_lock: Arc<std::fs::File>,
    storage_guard: Option<Arc<Mutex<crate::storage::Guard>>>,
}
fn timestamp(time: SystemTime) -> prost_types::Timestamp {
    let elapsed = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    prost_types::Timestamp {
        seconds: elapsed.as_secs() as i64,
        nanos: elapsed.subsec_nanos() as i32,
    }
}
fn host_version(text: &str, program: &str, version: &str) -> bool {
    let mut lines = text.lines();
    let Some(first) = lines.next() else {
        return false;
    };
    match program {
        "containerd-shim-runc-v2" => {
            first == "containerd-shim-runc-v2:"
                && lines
                    .find_map(|line| line.trim().strip_prefix("Version:"))
                    .is_some_and(|value| value.trim().trim_start_matches('v') == version)
        }
        "containerd" => {
            first.split_whitespace().next() == Some("containerd")
                && first
                    .split_whitespace()
                    .nth(2)
                    .is_some_and(|value| value.trim_start_matches('v') == version)
        }
        "runc" => first.strip_prefix("runc version ") == Some(version),
        _ => false,
    }
}

pub fn pod_config(
    request: &ControllerCreateRequest,
    sandboxer: &str,
) -> Result<PodSandboxConfig, Status> {
    if request.sandboxer != sandboxer
        || request.sandbox_id.is_empty()
        || request.sandbox_id.len() > 128
        || !request
            .sandbox_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || request.netns_path.is_empty()
        || !request.rootfs.is_empty()
    {
        return Err(Status::invalid_argument(
            "sandbox_identity_or_network_invalid",
        ));
    }
    let sandbox = request
        .sandbox
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("sandbox_metadata_required"))?;
    if sandbox.sandbox_id != request.sandbox_id
        || sandbox.sandboxer != sandboxer
        || sandbox
            .runtime
            .as_ref()
            .is_none_or(|runtime| runtime.name != "io.containerd.runc.v2")
    {
        return Err(Status::invalid_argument("sandbox_runtime_mismatch"));
    }
    let options = request
        .options
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("CRI_PodSandboxConfig_required"))?;
    if ![
        "runtime.v1.PodSandboxConfig",
        "type.googleapis.com/runtime.v1.PodSandboxConfig",
    ]
    .contains(&options.type_url.as_str())
        || options.value.len() > 256 * 1024
    {
        return Err(Status::invalid_argument("CRI_PodSandboxConfig_invalid"));
    }
    let config = PodSandboxConfig::decode(options.value.as_slice())
        .map_err(|_| Status::invalid_argument("CRI_PodSandboxConfig_decode_failed"))?;
    let metadata = config
        .metadata
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("Pod_metadata_required"))?;
    if metadata.uid.is_empty()
        || metadata.uid.len() > 128
        || metadata.name.is_empty()
        || metadata.namespace.is_empty()
    {
        return Err(Status::invalid_argument("Pod_identity_required"));
    }
    let linux = config
        .linux
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("Linux_Pod_required"))?;
    let security = linux
        .security_context
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("explicit_namespace_modes_required"))?;
    let ns = security
        .namespace_options
        .as_ref()
        .ok_or_else(|| Status::invalid_argument("explicit_namespace_modes_required"))?;
    if ns.network != cri::NamespaceMode::Pod as i32
        || ns.ipc != cri::NamespaceMode::Pod as i32
        || ns.pid != cri::NamespaceMode::Container as i32
        || !ns.target_id.is_empty()
        || ns
            .userns_options
            .as_ref()
            .is_some_and(|user| user.mode != cri::NamespaceMode::Node as i32)
        || security.privileged
        || security.selinux_options.is_some()
        || !linux.sysctls.is_empty()
    {
        return Err(Status::unimplemented(
            "requested_sandbox_isolation_unsupported",
        ));
    }
    let wire = pgcf_node_runtime::protocol::Assignment {
        slot_id: [1; 16],
        network: pgcf_node_runtime::protocol::NamespaceIdentity {
            device: 1,
            inode: 1,
        },
        hostname: &config.hostname,
    };
    pgcf_node_runtime::protocol::encode(&wire)
        .map_err(|_| Status::invalid_argument("Pod_hostname_invalid"))?;
    Ok(config)
}
impl SandboxController {
    pub async fn inventory(&self) -> Result<serde_json::Value, Status> {
        let mut pool = self.pool.lock().await;
        let mut available = Vec::<Identity>::new();
        let mut assigned = Vec::new();
        for slot in &mut pool.available {
            if slot.live()?
                && slot.shim_live(&self.settings.namespace).await
                && slot.prepared_at.elapsed() < slot.lifetime
            {
                available.push(slot.identity.clone());
            }
        }
        for (id, entry) in &mut pool.assigned {
            let live = entry.slot.live()? && entry.slot.shim_live(&self.settings.namespace).await;
            assigned.push(serde_json::json!({"sandbox_id":id,"pod_uid":entry.pod.uid,"runtime_release_id":entry.slot.profile.as_ref().map(|profile|&profile.release_id),"assignment_mode":entry.source,"pod_name":entry.pod.name,"pod_namespace":entry.pod.namespace,"identity":entry.slot.identity,"live":live,"started":entry.started}));
        }
        Ok(serde_json::json!({"available":available,"assigned":assigned}))
    }
    pub async fn prepare(settings: Settings) -> Result<Self, Status> {
        if settings.slots > 16
            || settings.slot_lifetime_ms == 0
            || settings.slot_lifetime_ms > 300_000
            || settings.namespace.is_empty()
            || settings.shim_sockets.as_os_str().len() > 36
        {
            return Err(Status::invalid_argument("pool_settings_invalid"));
        }
        crate::slot::ensure_private_directory(&settings.state)?;
        crate::slot::ensure_private_directory(
            settings
                .socket
                .parent()
                .ok_or_else(|| Status::invalid_argument("controller_socket_parent_required"))?,
        )?;
        crate::slot::ensure_private_directory(&settings.shim_sockets)?;
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let ownership_lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(settings.state.join("controller.lock"))
            .map_err(|_| Status::failed_precondition("runtime_ownership_lock_unavailable"))?;
        if unsafe { libc::flock(ownership_lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Status::already_exists("runtime_controller_already_running"));
        }
        let mut assigned = HashMap::new();
        let mut retired_storage = HashMap::new();
        // containerd remains the authoritative Pod store. Private records retain only runtime ownership.
        for path in std::fs::read_dir(&settings.state)
            .map_err(|_| Status::internal("runtime_inventory_unavailable"))?
        {
            let directory = path
                .map_err(|_| Status::internal("runtime_inventory_unavailable"))?
                .path();
            if !directory.is_dir() {
                continue;
            }
            crate::slot::ensure_private_directory(&directory)?;
            let identity_bytes = match std::fs::read(directory.join("identity.json")) {
                Ok(bytes) => bytes,
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound
                        && settings.cloudflare.is_some() =>
                {
                    let id = directory
                        .file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| {
                            Status::failed_precondition("retained_slot_directory_invalid")
                        })?;
                    crate::cgroup::discard_unassigned(
                        &settings.cloudflare.as_ref().unwrap().cgroup_root,
                        id,
                    )
                    .await?;
                    std::fs::remove_dir_all(directory).map_err(|_| {
                        Status::failed_precondition("incomplete_slot_cleanup_failed")
                    })?;
                    continue;
                }
                Err(_) => return Err(Status::failed_precondition("incomplete_runtime_inventory")),
            };
            let identity: Identity = serde_json::from_slice(&identity_bytes)
                .map_err(|_| Status::failed_precondition("retained_identity_invalid"))?;
            let owner = match std::fs::read(directory.join("owner.json")) {
                Ok(bytes) => Some(
                    serde_json::from_slice::<Owner>(&bytes)
                        .map_err(|_| Status::failed_precondition("retained_owner_invalid"))?,
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(_) => return Err(Status::failed_precondition("retained_owner_unavailable")),
            };
            if let Some(owner) = owner {
                if identity.slot != owner.identity.slot
                    || identity.pid != owner.identity.pid
                    || identity.holder_start_ticks != owner.identity.holder_start_ticks
                    || identity.shim_pid != owner.identity.shim_pid
                    || identity.shim_start_ticks != owner.identity.shim_start_ticks
                {
                    return Err(Status::failed_precondition(
                        "retained_owner_identity_changed",
                    ));
                }
                if owner.retired {
                    if owner.protective_storage_authority.is_none() {
                        return Err(Status::failed_precondition(
                            "retired_storage_authority_missing",
                        ));
                    }
                    // The durable normal-Shutdown intent follows positive deletion of all child tasks.
                    // Finish only these exact owned holder/shim identities after a lost cleanup reply.
                    let mut slot = Slot::restore(
                        &settings,
                        directory.clone(),
                        owner.identity.clone(),
                        Some(pgcf_node_runtime::protocol::NamespaceIdentity {
                            device: owner.network_device,
                            inode: owner.network_inode,
                        }),
                    )
                    .await?;
                    slot.destroy_retaining_owner(&settings.namespace).await?;
                    retired_storage.insert(
                        owner.identity.slot.clone(),
                        RetiredStorage { owner, directory },
                    );
                    continue;
                }
                let channel = transport::connect(&settings.containerd_socket).await?;
                let sandbox = store_client::StoreClient::new(channel)
                    .get(transport::namespaced(
                        StoreGetRequest {
                            sandbox_id: owner.sandbox_id.clone(),
                        },
                        &settings.namespace,
                    )?)
                    .await?
                    .into_inner()
                    .sandbox
                    .ok_or_else(|| {
                        Status::failed_precondition("retained_containerd_owner_missing")
                    })?;
                if sandbox.sandboxer != "pgcf"
                    || sandbox.sandbox_id != owner.sandbox_id
                    || sandbox
                        .runtime
                        .as_ref()
                        .is_none_or(|runtime| runtime.name != "io.containerd.runc.v2")
                {
                    return Err(Status::failed_precondition(
                        "retained_containerd_owner_changed",
                    ));
                }
                let mut slot = Slot::restore(
                    &settings,
                    directory,
                    owner.identity,
                    Some(pgcf_node_runtime::protocol::NamespaceIdentity {
                        device: owner.network_device,
                        inode: owner.network_inode,
                    }),
                )
                .await?;
                slot.created_at = UNIX_EPOCH + std::time::Duration::from_millis(owner.created_ms);
                slot.profile = owner.profile;
                let entry = Assigned {
                    slot,
                    created: owner.created,
                    started: owner.started,
                    labels: sandbox.labels,
                    spec: sandbox.spec,
                    source: owner.source,
                    protective_storage_authority: owner.protective_storage_authority,
                    pod: cri::PodSandboxMetadata {
                        uid: owner.pod_uid,
                        name: owner.pod_name,
                        namespace: owner.pod_namespace,
                        attempt: owner.pod_attempt,
                    },
                };
                if assigned.insert(owner.sandbox_id, entry).is_some() {
                    return Err(Status::failed_precondition("duplicate_runtime_owner"));
                }
            } else {
                let mut slot = Slot::restore(&settings, directory, identity, None).await?;
                slot.destroy(&settings.namespace).await?;
            }
        }
        let mut available = Vec::new();
        if settings.cloudflare.is_none() {
            for _ in 0..settings.slots {
                available.push(Slot::prepare(&settings).await?);
            }
        }
        let storage_guard = settings
            .cloudflare
            .as_ref()
            .and_then(|local| local.storage_authority.clone().map(|trust| (local, trust)))
            .map(|(local, trust)| {
                let mut guard = crate::storage::Guard::new(
                    trust,
                    local.node_uid.clone(),
                    u64::from(local.material_revision),
                )?;
                // Restore authenticated protective history before any CRI request can create a task.
                for entry in assigned.values() {
                    if let Some(token) = &entry.protective_storage_authority {
                        guard.retain_protective(&entry.pod.uid, token)?;
                    }
                }
                for entry in retired_storage.values() {
                    let token = entry
                        .owner
                        .protective_storage_authority
                        .as_ref()
                        .ok_or_else(|| {
                            Status::failed_precondition("retired_storage_authority_missing")
                        })?;
                    guard.retain_protective(&entry.owner.pod_uid, token)?;
                    guard.note_stopped(&entry.owner.pod_uid);
                }
                Ok::<_, Status>(Arc::new(Mutex::new(guard)))
            })
            .transpose()?;
        let material_revision = settings
            .cloudflare
            .as_ref()
            .map(|local| local.material_revision);
        Ok(Self {
            settings: Arc::new(settings),
            pool: Arc::new(Mutex::new(Pool {
                available,
                retiring: Vec::new(),
                assigned,
                authority: None,
                claiming: HashSet::new(),
                material_revision,
                retired_storage,
            })),
            _ownership_lock: Arc::new(ownership_lock),
            storage_guard,
        })
    }
    async fn verify_profile(&self, authority: &Authority) -> Result<(), Status> {
        let profile = &authority.lease.policy.profile;
        if profile.architecture
            != std::env::consts::ARCH
                .replace("x86_64", "amd64")
                .replace("aarch64", "arm64")
            || crate::policy::digest(&self.settings.holder_binary)? != profile.holder_sha256
            || crate::policy::digest(
                &std::env::current_exe()
                    .map_err(|_| Status::failed_precondition("controller_binary_unavailable"))?,
            )? != profile.controller_sha256
        {
            return Err(Status::failed_precondition(
                "qualified_runtime_profile_mismatch",
            ));
        }
        for (path, program, version) in [
            (
                &self.settings.containerd_binary,
                "containerd",
                profile.containerd_version.as_str(),
            ),
            (
                &self.settings.shim_binary,
                "containerd-shim-runc-v2",
                profile.containerd_version.as_str(),
            ),
            (
                &self.settings.runc_binary,
                "runc",
                profile.runc_version.as_str(),
            ),
        ] {
            let output = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                tokio::process::Command::new(path)
                    .arg("--version")
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| Status::failed_precondition("host_runtime_probe_timeout"))?
            .map_err(|_| Status::failed_precondition("host_runtime_probe_failed"))?;
            let text = std::str::from_utf8(&output.stdout)
                .map_err(|_| Status::failed_precondition("host_runtime_probe_invalid"))?;
            if !output.status.success()
                || text.len() > 16384
                || !host_version(text, program, version)
            {
                return Err(Status::failed_precondition(
                    "qualified_host_runtime_mismatch",
                ));
            }
        }
        Ok(())
    }
    pub async fn refresh(&self, authority: Authority) -> Result<(), Status> {
        self.verify_profile(&authority).await?;
        let mut pool = self.pool.lock().await;
        if pool
            .material_revision
            .is_some_and(|revision| revision != authority.lease.material_revision)
        {
            return Err(Status::permission_denied(
                "current_material_authority_required",
            ));
        }
        let mut retired = if pool
            .authority
            .as_ref()
            .is_some_and(|current| current.lease.policy != authority.lease.policy)
        {
            std::mem::take(&mut pool.available)
        } else {
            Vec::new()
        };
        pool.authority = Some(authority);
        drop(pool);
        let mut failure = None;
        for mut slot in retired.drain(..) {
            if let Err(error) = slot.destroy(&self.settings.namespace).await {
                self.pool.lock().await.retiring.push(slot);
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(())
    }
    pub fn storage_guard(&self) -> Option<Arc<Mutex<crate::storage::Guard>>> {
        self.storage_guard.clone()
    }
    pub async fn assigned_pods(&self) -> Vec<(String, String)> {
        let pool = self.pool.lock().await;
        pool.assigned
            .values()
            .map(|value| (value.pod.uid.clone(), value.pod.namespace.clone()))
            .collect()
    }
    pub async fn rebind_material_revision(&self, revision: u32) -> Result<(), Status> {
        let mut pool = self.pool.lock().await;
        if pool.material_revision.is_some_and(|old| revision < old) {
            return Err(Status::permission_denied("material_rollback_refused"));
        }
        if pool.material_revision != Some(revision) {
            pool.authority = None;
            pool.material_revision = Some(revision);
        }
        Ok(())
    }
    pub async fn maintain(&self) -> Result<(), Status> {
        let (mut retired, preparation, authority) = {
            let mut pool = self.pool.lock().await;
            let authority = pool.authority.clone().filter(Authority::valid);
            let target = authority
                .as_ref()
                .map_or(0, |authority| authority.lease.policy.target_slots as usize);
            let mut retained = Vec::new();
            let mut retired = std::mem::take(&mut pool.retiring);
            for mut slot in std::mem::take(&mut pool.available) {
                if authority.is_some()
                    && slot.live()?
                    && slot.shim_live(&self.settings.namespace).await
                    && slot.prepared_at.elapsed() < slot.lifetime
                    && retained.len() < target
                {
                    retained.push(slot);
                } else {
                    retired.push(slot);
                }
            }
            pool.available = retained;
            let preparation = authority
                .as_ref()
                .filter(|_| pool.available.len() < target)
                .map(|authority| authority.lease.policy.clone());
            (retired, preparation, authority)
        };
        let mut failure = None;
        for mut slot in retired.drain(..) {
            if let Err(error) = slot.destroy(&self.settings.namespace).await {
                self.pool.lock().await.retiring.push(slot);
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        if let (Some(policy), Some(authority)) = (preparation, authority) {
            let local = self
                .settings
                .cloudflare
                .as_ref()
                .ok_or_else(|| Status::failed_precondition("Cloudflare_policy_required"))?;
            let mut settings = (*self.settings).clone();
            settings.slot_lifetime_ms = u64::from(policy.max_age_seconds) * 1000;
            settings.budget = Some(crate::cgroup::configure(&local.cgroup_root, &policy)?);
            settings.runtime_profile = Some(policy.profile.clone());
            let mut slot = Slot::prepare(&settings).await?;
            let mut pool = self.pool.lock().await;
            if pool.authority.as_ref().is_some_and(|current| {
                current.valid()
                    && current.lease.revision == authority.lease.revision
                    && current.lease.policy == policy
            }) && pool.available.len() < (policy.target_slots as usize)
            {
                pool.available.push(slot);
            } else {
                drop(pool);
                slot.destroy(&self.settings.namespace).await?;
            }
        }
        Ok(())
    }
    pub async fn observation(&self) -> Result<Option<serde_json::Value>, Status> {
        let mut pool = self.pool.lock().await;
        let Some(authority) = pool.authority.clone().filter(Authority::valid) else {
            return Ok(None);
        };
        let mut slots = Vec::new();
        for slot in &mut pool.available {
            slots.push(serde_json::json!({"slot_id":slot.identity.slot,"holder_pid":slot.identity.pid,"shim_pid":slot.identity.shim_pid,"live":slot.live()?&&slot.shim_live(&self.settings.namespace).await,"sandbox_id":null,"pod_uid":null,"runtime_release_id":slot.profile.as_ref().map(|profile|&profile.release_id),"assignment_mode":null}));
        }
        for slot in &mut pool.retiring {
            slots.push(serde_json::json!({"slot_id":slot.identity.slot,"holder_pid":slot.identity.pid,"shim_pid":slot.identity.shim_pid,"live":slot.live()?&&slot.shim_live(&self.settings.namespace).await,"sandbox_id":null,"pod_uid":null,"runtime_release_id":slot.profile.as_ref().map(|profile|&profile.release_id),"assignment_mode":null}));
        }
        for (id, entry) in &mut pool.assigned {
            slots.push(serde_json::json!({"slot_id":entry.slot.identity.slot,"holder_pid":entry.slot.identity.pid,"shim_pid":entry.slot.identity.shim_pid,"live":entry.slot.live()?&&entry.slot.shim_live(&self.settings.namespace).await,"sandbox_id":id,"pod_uid":entry.pod.uid,"runtime_release_id":entry.slot.profile.as_ref().map(|profile|&profile.release_id),"assignment_mode":entry.source}));
        }
        let local = self
            .settings
            .cloudflare
            .as_ref()
            .ok_or_else(|| Status::failed_precondition("Cloudflare_policy_required"))?;
        let (memory, cpu) = crate::cgroup::metrics(&local.cgroup_root);
        Ok(Some(
            serde_json::json!({"node_id":authority.lease.node_id,"node_uid":authority.lease.node_uid,"policy_revision":authority.lease.revision,"material_revision":authority.lease.material_revision,"observed_at":crate::policy::timestamp()?,"profile":authority.lease.policy.profile,"idle_memory_current_bytes":memory,"idle_cpu_usage_usec":cpu,"slots":slots}),
        ))
    }
    pub async fn run_policy(
        self,
        mut client: Client,
        mut updates: tokio::sync::watch::Receiver<Client>,
    ) {
        let mut next_fetch = std::time::Instant::now();
        loop {
            if updates.has_changed().unwrap_or(false) {
                client = updates.borrow_and_update().clone();
                next_fetch = std::time::Instant::now();
            }
            if std::time::Instant::now() >= next_fetch {
                match client.lease().await {
                    Ok(authority) => {
                        if let Err(error) = self.refresh(authority).await {
                            eprintln!("{}", error.message());
                        }
                    }
                    Err(error) => eprintln!("{}", error.message()),
                };
                next_fetch = std::time::Instant::now() + std::time::Duration::from_secs(5);
                if let Ok(Some(observation)) = self.observation().await
                    && let Err(error) = client.report(&observation).await
                {
                    eprintln!("{}", error.message());
                }
            }
            if let Err(error) = self.maintain().await {
                eprintln!("{}", error.message());
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }
    fn authorize<T>(&self, request: &Request<T>) -> Result<(), Status> {
        let namespace = request
            .metadata()
            .get("containerd-namespace")
            .and_then(|v| v.to_str().ok());
        if namespace != Some(self.settings.namespace.as_str()) {
            return Err(Status::permission_denied("containerd_namespace_required"));
        }
        if let Some(info) = request
            .extensions()
            .get::<tonic::transport::server::UdsConnectInfo>()
            && info
                .peer_cred
                .as_ref()
                .is_none_or(|cred| cred.uid() != unsafe { libc::geteuid() })
        {
            return Err(Status::permission_denied("local_runtime_peer_required"));
        }
        Ok(())
    }
    fn id(&self, id: &str, sandboxer: &str) -> Result<(), Status> {
        if id.is_empty() || sandboxer != "pgcf" {
            return Err(Status::invalid_argument("sandbox_identity_invalid"));
        }
        Ok(())
    }
    async fn child_ids(&self, id: &str) -> Result<Vec<String>, Status> {
        let channel = transport::connect(&self.settings.containerd_socket).await?;
        let response = containers::containers_client::ContainersClient::new(channel)
            .list(transport::namespaced(
                containers::ListContainersRequest { filters: vec![] },
                &self.settings.namespace,
            )?)
            .await?
            .into_inner();
        if response.containers.len() > 10000 {
            return Err(Status::resource_exhausted(
                "bounded_container_inventory_exceeded",
            ));
        }
        Ok(response
            .containers
            .into_iter()
            .filter(|container| container.sandbox == id)
            .map(|container| container.id)
            .collect())
    }
    /// Internal verified supervisor only; retained signed scope permits protective action after restart, never a grant.
    pub async fn remember_storage_authority(
        &self,
        pod_uid: &str,
        token: &str,
    ) -> Result<(), Status> {
        if token.is_empty() || token.len() > 4096 {
            return Err(Status::invalid_argument("storage_protection_token_invalid"));
        }
        let mut pool = self.pool.lock().await;
        let mut found = pool
            .assigned
            .iter_mut()
            .filter(|(_, entry)| entry.pod.uid == pod_uid);
        let (id, entry) = found
            .next()
            .ok_or_else(|| Status::not_found("assigned_pod_not_found"))?;
        if found.next().is_some() {
            return Err(Status::failed_precondition(
                "assigned_pod_identity_ambiguous",
            ));
        }
        if entry.protective_storage_authority.as_deref() != Some(token) {
            entry.protective_storage_authority = Some(token.to_owned());
            save_owner(id, entry)?;
        }
        Ok(())
    }
    pub async fn protective_storage_authorities(&self) -> Vec<(String, String)> {
        let pool = self.pool.lock().await;
        let mut result: Vec<_> = pool
            .assigned
            .values()
            .filter_map(|entry| {
                entry
                    .protective_storage_authority
                    .as_ref()
                    .map(|token| (entry.pod.uid.clone(), token.clone()))
            })
            .collect();
        result.extend(pool.retired_storage.values().filter_map(|entry| {
            entry
                .owner
                .protective_storage_authority
                .as_ref()
                .map(|token| (entry.owner.pod_uid.clone(), token.clone()))
        }));
        result
    }
    /// These private records follow actual child-task deletion and completed owned process cleanup.
    pub async fn retired_storage_authorities(&self) -> Vec<(String, String)> {
        self.pool
            .lock()
            .await
            .retired_storage
            .values()
            .filter_map(|entry| {
                entry
                    .owner
                    .protective_storage_authority
                    .as_ref()
                    .map(|token| (entry.owner.pod_uid.clone(), token.clone()))
            })
            .collect()
    }
    /// Call only after positive exact-volume resume or deletion, never merely after task exit.
    pub async fn forget_retired_storage_authority(&self, pod_uid: &str) -> Result<(), Status> {
        let mut pool = self.pool.lock().await;
        let ids = pool
            .retired_storage
            .iter()
            .filter(|(_, entry)| entry.owner.pod_uid == pod_uid)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            let entry = &pool.retired_storage[&id];
            crate::slot::ensure_private_directory(&entry.directory)?;
            std::fs::remove_dir_all(&entry.directory)
                .map_err(|_| Status::internal("retired_storage_owner_cleanup_unconfirmed"))?;
            pool.retired_storage.remove(&id);
        }
        Ok(())
    }
    pub(crate) async fn reclaim_candidates(
        &self,
    ) -> Result<Vec<crate::reclaim_inventory::Candidate>, Status> {
        let pool = self.pool.lock().await;
        if !pool.authority.as_ref().is_some_and(Authority::valid) {
            return Err(Status::permission_denied(
                "reclaim_inventory_pool_authority_expired",
            ));
        }
        let assigned = pool
            .assigned
            .iter()
            .map(|(id, value)| (id.clone(), value.pod.clone()))
            .collect::<HashMap<_, _>>();
        drop(pool);
        let channel = transport::connect(&self.settings.containerd_socket).await?;
        let containers = containers::containers_client::ContainersClient::new(channel.clone())
            .list(transport::namespaced(
                containers::ListContainersRequest { filters: vec![] },
                &self.settings.namespace,
            )?)
            .await?
            .into_inner()
            .containers;
        if containers.len() > 10000 {
            return Err(Status::resource_exhausted(
                "bounded_container_inventory_exceeded",
            ));
        }
        let mut tasks = tasks::tasks_client::TasksClient::new(channel.clone());
        let mut cri = cri::runtime_service_client::RuntimeServiceClient::new(channel);
        let mut result = Vec::new();
        for container in containers {
            let Some(pod) = assigned.get(&container.sandbox) else {
                continue;
            };
            let Some(database) = pod.namespace.strip_prefix("pgcf-db-") else {
                continue;
            };
            if !pgcf_native_protocol::valid_pattern("database", database)
                || container.id.len() != 64
                || !container.id.bytes().all(|b| b.is_ascii_hexdigit())
            {
                continue;
            }
            let Some(spec) = container
                .spec
                .as_ref()
                .filter(|spec| spec.value.len() <= 512 * 1024)
            else {
                continue;
            };
            let Ok(spec) = serde_json::from_slice::<serde_json::Value>(&spec.value) else {
                continue;
            };
            let annotations = &spec["annotations"];
            if annotations["io.kubernetes.cri.container-type"] != "container"
                || annotations["io.kubernetes.cri.container-name"] != "postgres"
                || annotations["io.kubernetes.cri.sandbox-id"] != container.sandbox
                || annotations["io.kubernetes.cri.sandbox-uid"] != pod.uid
                || annotations["io.kubernetes.cri.sandbox-namespace"] != pod.namespace
            {
                continue;
            }
            let process = match tasks
                .get(transport::namespaced(
                    tasks::GetRequest {
                        container_id: container.id.clone(),
                        exec_id: String::new(),
                    },
                    &self.settings.namespace,
                )?)
                .await
            {
                Ok(value) => value.into_inner().process,
                Err(_) => continue,
            };
            let Some(process) = process.filter(|process| process.status == 2 && process.pid > 0)
            else {
                continue;
            };
            let status = match cri
                .container_status(cri::ContainerStatusRequest {
                    container_id: container.id.clone(),
                    verbose: false,
                })
                .await
            {
                Ok(value) => value.into_inner().status,
                Err(_) => continue,
            };
            let Some(status) = status.filter(|status| {
                status.id == container.id
                    && status.state == 1
                    && status
                        .metadata
                        .as_ref()
                        .is_some_and(|meta| meta.name == "postgres")
                    && status.image_ref.len() <= 512
                    && !status.image_ref.is_empty()
            }) else {
                continue;
            };
            let Ok(start_ticks) = crate::slot::start_ticks(process.pid) else {
                continue;
            };
            let Ok(pid_namespace) = crate::slot::namespace(process.pid, "pid") else {
                continue;
            };
            let Ok(cgroup) = std::fs::read_to_string(format!("/proc/{}/cgroup", process.pid))
            else {
                continue;
            };
            let Some(cgroup) =
                crate::reclaim_inventory::cgroup_path(&cgroup, &pod.uid, &container.id)
            else {
                continue;
            };
            result.push(crate::reclaim_inventory::Candidate {
                database_id: database.to_owned(),
                namespace: pod.namespace.clone(),
                pod_uid: pod.uid.clone(),
                container_id: container.id,
                cri_pid: process.pid,
                start_ticks,
                pid_namespace,
                cgroup_path: cgroup,
                postgres_image_id: status.image_ref,
            });
            if result.len() > 4096 {
                return Err(Status::resource_exhausted(
                    "bounded_reclaim_inventory_exceeded",
                ));
            }
        }
        Ok(result)
    }
    /// CF storage expiry may stop only the tasks of one currently tracked physical Pod UID.
    pub async fn stop_pod_tasks(&self, pod_uid: &str) -> Result<(), Status> {
        let pool = self.pool.lock().await;
        let mut matching = pool
            .assigned
            .iter()
            .filter(|(_, assigned)| assigned.pod.uid == pod_uid);
        let id = matching.next().map(|(id, _)| id.clone());
        if matching.next().is_some() {
            return Err(Status::failed_precondition(
                "assigned_pod_identity_ambiguous",
            ));
        }
        let Some(id) = id else {
            return if pool
                .retired_storage
                .values()
                .any(|entry| entry.owner.pod_uid == pod_uid)
            {
                Ok(())
            } else {
                Err(Status::not_found("assigned_pod_not_found"))
            };
        };
        drop(matching);
        drop(pool);
        // Capture immutable task IDs and recheck the Pod binding; no network wait may hold the shared pool lock.
        let ids = tokio::time::timeout(std::time::Duration::from_millis(100), self.child_ids(&id))
            .await
            .map_err(|_| Status::deadline_exceeded("storage_task_inventory_unconfirmed"))??;
        if !self
            .pool
            .lock()
            .await
            .assigned
            .get(&id)
            .is_some_and(|entry| entry.pod.uid == pod_uid)
        {
            return Err(Status::not_found("assigned_pod_not_found"));
        }
        let channel = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            transport::connect(&self.settings.containerd_socket),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("storage_task_channel_unavailable"))??;
        let mut stops = tokio::task::JoinSet::new();
        for id in ids {
            let mut client = tasks::tasks_client::TasksClient::new(channel.clone());
            let namespace = self.settings.namespace.clone();
            stops.spawn(async move {
                let kill = tokio::time::timeout(
                    std::time::Duration::from_millis(100),
                    client.kill(transport::namespaced(
                        tasks::KillRequest {
                            container_id: id.clone(),
                            exec_id: String::new(),
                            signal: 9,
                            all: true,
                        },
                        &namespace,
                    )?),
                )
                .await
                .map_err(|_| Status::deadline_exceeded("storage_task_kill_unconfirmed"))?;
                match kill {
                    Ok(_) => {}
                    Err(status) if status.code() == tonic::Code::NotFound => return Ok(()),
                    Err(status) => return Err(status),
                }
                tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    client.wait(transport::namespaced(
                        tasks::WaitRequest {
                            container_id: id,
                            exec_id: String::new(),
                        },
                        &namespace,
                    )?),
                )
                .await
                .map_err(|_| Status::deadline_exceeded("storage_task_stop_unconfirmed"))??;
                Ok(())
            });
        }
        let mut failure = None;
        while let Some(result) = stops.join_next().await {
            if let Err(status) = result
                .map_err(|_| Status::internal("storage_task_stop_failed"))
                .and_then(|value| value)
            {
                failure = Some(status);
            }
        }
        if let Some(status) = failure {
            return Err(status);
        }
        Ok(())
    }
    async fn stop_children(&self, id: &str) -> Result<(), Status> {
        let ids = self.child_ids(id).await?;
        let channel = transport::connect(&self.settings.containerd_socket).await?;
        let mut client = tasks::tasks_client::TasksClient::new(channel);
        for id in ids {
            let request = tasks::KillRequest {
                container_id: id.clone(),
                exec_id: String::new(),
                signal: 9,
                all: true,
            };
            match client
                .kill(transport::namespaced(request, &self.settings.namespace)?)
                .await
            {
                Ok(_) => {}
                Err(status) if status.code() == tonic::Code::NotFound => continue,
                Err(status) => return Err(status),
            }
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                client.wait(transport::namespaced(
                    tasks::WaitRequest {
                        container_id: id,
                        exec_id: String::new(),
                    },
                    &self.settings.namespace,
                )?),
            )
            .await
            .map_err(|_| Status::deadline_exceeded("tenant_task_stop_unconfirmed"))??;
        }
        Ok(())
    }
}
#[tonic::async_trait]
impl controller_server::Controller for SandboxController {
    async fn create(
        &self,
        request: Request<ControllerCreateRequest>,
    ) -> Result<Response<ControllerCreateResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        let config = pod_config(&input, "pgcf")?;
        if let Some(guard) = &self.storage_guard {
            let metadata = config
                .metadata
                .as_ref()
                .ok_or_else(|| Status::invalid_argument("pod_metadata_required"))?;
            if !guard.lock().await.permits_create(
                &metadata.namespace,
                &metadata.uid,
                u64::try_from(crate::policy::now_ms()).unwrap_or(0),
            ) {
                return Err(Status::permission_denied(
                    "current_storage_startup_authority_required",
                ));
            }
        }
        let mut pool = self.pool.lock().await;
        if self.settings.cloudflare.is_some()
            && !pool.authority.as_ref().is_some_and(Authority::valid)
        {
            return Err(Status::permission_denied(
                "fresh_Cloudflare_pool_lease_required",
            ));
        }
        if pool.assigned.len() + pool.claiming.len() >= 240 {
            return Err(Status::resource_exhausted("bounded_runtime_inventory_full"));
        }
        if pool.assigned.contains_key(&input.sandbox_id)
            || pool.claiming.contains(&input.sandbox_id)
        {
            return Err(Status::already_exists("sandbox_already_claimed"));
        }
        let (mut slot, source) = if let Some(slot) = pool.available.pop() {
            (slot, "prestarted")
        } else {
            let authority = pool
                .authority
                .clone()
                .filter(Authority::valid)
                .ok_or_else(|| {
                    Status::resource_exhausted("prepared_pool_miss_without_authority")
                })?;
            let local = self
                .settings
                .cloudflare
                .as_ref()
                .ok_or_else(|| Status::failed_precondition("Cloudflare_policy_required"))?;
            let mut settings = (*self.settings).clone();
            settings.slot_lifetime_ms = u64::from(authority.lease.policy.max_age_seconds) * 1000;
            settings.runtime_profile = Some(authority.lease.policy.profile.clone());
            settings.budget = Some(crate::cgroup::configure(
                &local.cgroup_root,
                &authority.lease.policy,
            )?);
            pool.claiming.insert(input.sandbox_id.clone());
            drop(pool);
            let prepared = Slot::prepare(&settings).await;
            pool = self.pool.lock().await;
            let mut slot = match prepared {
                Ok(slot) => slot,
                Err(error) => return Err(error),
            };
            if !pool.claiming.contains(&input.sandbox_id)
                || !pool.authority.as_ref().is_some_and(|current| {
                    current.valid()
                        && current.lease.revision == authority.lease.revision
                        && current.lease.policy == authority.lease.policy
                })
            {
                drop(pool);
                slot.destroy(&self.settings.namespace).await?;
                return Err(Status::permission_denied("on_demand_authority_changed"));
            }
            (slot, "on_demand")
        };
        // A failed or uncertain claim is consumed, killed and never reinserted.
        let assignment = slot.assign(&input.netns_path, &config.hostname);
        if assignment.is_err() {
            let _ = slot.stop().await;
            let _: Result<(), _> = transport::shim_call(
                &slot.identity.task_address,
                "Shutdown",
                v3::ShutdownRequest {
                    id: String::new(),
                    now: false,
                },
                &self.settings.namespace,
            )
            .await;
        }
        let mut labels = input.sandbox.as_ref().unwrap().labels.clone();
        labels.insert("pgcf_compute_source".into(), source.into());
        let spec = input.sandbox.as_ref().unwrap().spec.clone();
        let id = input.sandbox_id.clone();
        pool.assigned.insert(
            id.clone(),
            Assigned {
                slot,
                created: assignment.is_ok(),
                started: false,
                labels,
                spec,
                pod: config.metadata.unwrap(),
                source: source.into(),
                protective_storage_authority: None,
            },
        );
        pool.claiming.remove(&id);
        assignment?;
        if let Err(error) = save_owner(&id, pool.assigned.get(&id).unwrap()) {
            let entry = pool.assigned.get_mut(&id).unwrap();
            entry.created = false;
            let _ = entry.slot.stop().await;
            return Err(error);
        }
        Ok(Response::new(ControllerCreateResponse { sandbox_id: id }))
    }
    async fn start(
        &self,
        request: Request<ControllerStartRequest>,
    ) -> Result<Response<ControllerStartResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        self.id(&input.sandbox_id, &input.sandboxer)?;
        let (pod, already_started) = {
            let pool = self.pool.lock().await;
            let assigned = pool
                .assigned
                .get(&input.sandbox_id)
                .ok_or_else(|| Status::not_found("sandbox_not_claimed"))?;
            (assigned.pod.clone(), assigned.started)
        };
        if !already_started
            && let Some(guard) = &self.storage_guard
            && !guard.lock().await.permits_create(
                &pod.namespace,
                &pod.uid,
                u64::try_from(crate::policy::now_ms()).unwrap_or(0),
            )
        {
            return Err(Status::permission_denied(
                "current_storage_startup_authority_required",
            ));
        }
        let mut pool = self.pool.lock().await;
        let assigned = pool
            .assigned
            .get_mut(&input.sandbox_id)
            .ok_or_else(|| Status::not_found("sandbox_not_claimed"))?;
        if assigned.pod.uid != pod.uid {
            return Err(Status::failed_precondition("assigned_pod_identity_changed"));
        }
        if !assigned.created || !assigned.slot.live()? || assigned.slot.assigned_network.is_none() {
            return Err(Status::failed_precondition("assigned_runtime_not_running"));
        }
        if !assigned.slot.shim_live(&self.settings.namespace).await {
            return Err(Status::failed_precondition(
                "prepared_shim_identity_changed",
            ));
        }
        assigned.started = true;
        save_owner(&input.sandbox_id, assigned)?;
        Ok(Response::new(ControllerStartResponse {
            sandbox_id: input.sandbox_id,
            pid: assigned.slot.identity.pid,
            created_at: Some(timestamp(assigned.slot.created_at)),
            labels: assigned.labels.clone(),
            address: assigned.slot.identity.task_address.clone(),
            version: 3,
            spec: assigned.spec.clone(),
        }))
    }
    async fn platform(
        &self,
        request: Request<ControllerPlatformRequest>,
    ) -> Result<Response<ControllerPlatformResponse>, Status> {
        self.authorize(&request)?;
        self.id(&request.get_ref().sandbox_id, &request.get_ref().sandboxer)?;
        Ok(Response::new(ControllerPlatformResponse {
            platform: Some(Platform {
                os: "linux".into(),
                architecture: std::env::consts::ARCH
                    .replace("x86_64", "amd64")
                    .replace("aarch64", "arm64"),
                ..Default::default()
            }),
        }))
    }
    async fn status(
        &self,
        request: Request<ControllerStatusRequest>,
    ) -> Result<Response<ControllerStatusResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        self.id(&input.sandbox_id, &input.sandboxer)?;
        let mut pool = self.pool.lock().await;
        let assigned = pool
            .assigned
            .get_mut(&input.sandbox_id)
            .ok_or_else(|| Status::not_found("sandbox_not_claimed"))?;
        let running = assigned.started
            && assigned.slot.live()?
            && assigned.slot.shim_live(&self.settings.namespace).await;
        let identity = &assigned.slot.identity;
        let info = if input.verbose {
            HashMap::from([
                ("pgcf_slot_id".into(), identity.slot.clone()),
                ("pgcf_compute_source".into(), assigned.source.clone()),
                (
                    "pgcf_prestarted_holder_pid".into(),
                    identity.pid.to_string(),
                ),
                (
                    "pgcf_prestarted_shim_pid".into(),
                    identity.shim_pid.to_string(),
                ),
            ])
        } else {
            HashMap::new()
        };
        Ok(Response::new(ControllerStatusResponse {
            sandbox_id: input.sandbox_id,
            pid: identity.pid,
            state: if running {
                "SANDBOX_READY"
            } else {
                "SANDBOX_NOTREADY"
            }
            .into(),
            info,
            created_at: Some(timestamp(assigned.slot.created_at)),
            exited_at: assigned.slot.exited_at.map(timestamp),
            address: identity.task_address.clone(),
            version: 3,
            extra: None,
        }))
    }
    async fn stop(
        &self,
        request: Request<ControllerStopRequest>,
    ) -> Result<Response<ControllerStopResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        self.id(&input.sandbox_id, &input.sandboxer)?;
        self.stop_children(&input.sandbox_id).await?;
        let mut pool = self.pool.lock().await;
        let mut stopped_uid = None;
        pool.claiming.remove(&input.sandbox_id);
        if let Some(assigned) = pool.assigned.get_mut(&input.sandbox_id) {
            assigned.started = false;
            assigned.slot.stop().await?;
            if assigned.slot.assigned_network.is_some() {
                save_owner(&input.sandbox_id, assigned)?;
            }
            stopped_uid = Some(assigned.pod.uid.clone());
        }
        drop(pool);
        if let Some(uid) = stopped_uid
            && let Some(guard) = &self.storage_guard
        {
            guard.lock().await.note_stopped(&uid);
        }
        Ok(Response::new(ControllerStopResponse {}))
    }
    async fn wait(
        &self,
        request: Request<ControllerWaitRequest>,
    ) -> Result<Response<ControllerWaitResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        self.id(&input.sandbox_id, &input.sandboxer)?;
        loop {
            {
                let mut pool = self.pool.lock().await;
                let assigned = pool
                    .assigned
                    .get_mut(&input.sandbox_id)
                    .ok_or_else(|| Status::not_found("sandbox_not_claimed"))?;
                if !assigned.slot.live()? {
                    return Ok(Response::new(ControllerWaitResponse {
                        exit_status: assigned.slot.exit_status,
                        exited_at: assigned.slot.exited_at.map(timestamp),
                    }));
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    async fn shutdown(
        &self,
        request: Request<ControllerShutdownRequest>,
    ) -> Result<Response<ControllerShutdownResponse>, Status> {
        self.authorize(&request)?;
        let input = request.into_inner();
        self.id(&input.sandbox_id, &input.sandboxer)?;
        let ids = self.child_ids(&input.sandbox_id).await?;
        let channel = transport::connect(&self.settings.containerd_socket).await?;
        let mut client = tasks::tasks_client::TasksClient::new(channel);
        for id in ids {
            match client
                .get(transport::namespaced(
                    tasks::GetRequest {
                        container_id: id,
                        exec_id: String::new(),
                    },
                    &self.settings.namespace,
                )?)
                .await
            {
                Err(status) if status.code() == tonic::Code::NotFound => {}
                _ => {
                    return Err(Status::failed_precondition(
                        "tenant_tasks_must_be_deleted_before_shutdown",
                    ));
                }
            }
        }
        let mut pool = self.pool.lock().await;
        let mut retired = None;
        if let Some(assigned) = pool.assigned.get_mut(&input.sandbox_id) {
            if assigned.protective_storage_authority.is_some() {
                assigned.started = false;
                save_owner_mode(&input.sandbox_id, assigned, true)?;
                let owner: Owner = serde_json::from_slice(
                    &std::fs::read(assigned.slot.directory.join("owner.json"))
                        .map_err(|_| Status::internal("retired_storage_owner_unavailable"))?,
                )
                .map_err(|_| Status::internal("retired_storage_owner_invalid"))?;
                assigned
                    .slot
                    .destroy_retaining_owner(&self.settings.namespace)
                    .await?;
                retired = Some(RetiredStorage {
                    owner,
                    directory: assigned.slot.directory.clone(),
                });
            } else {
                assigned.slot.destroy(&self.settings.namespace).await?;
            }
        }
        let mut stopped_uid = None;
        if let Some(entry) = retired {
            stopped_uid = Some(entry.owner.pod_uid.clone());
            pool.retired_storage
                .insert(entry.owner.identity.slot.clone(), entry);
        }
        pool.assigned.remove(&input.sandbox_id);
        pool.claiming.remove(&input.sandbox_id);
        drop(pool);
        if let Some(uid) = stopped_uid
            && let Some(guard) = &self.storage_guard
        {
            guard.lock().await.note_stopped(&uid);
        }
        Ok(Response::new(ControllerShutdownResponse {}))
    }
    async fn metrics(
        &self,
        _: Request<ControllerMetricsRequest>,
    ) -> Result<Response<ControllerMetricsResponse>, Status> {
        Err(Status::unimplemented("sandbox_metrics_not_implemented"))
    }
    async fn update(
        &self,
        _: Request<ControllerUpdateRequest>,
    ) -> Result<Response<ControllerUpdateResponse>, Status> {
        Err(Status::unimplemented(
            "sandbox_resource_update_not_implemented",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_containerd_shim_multiline_version_is_accepted_and_wrong_versions_are_rejected() {
        let shim = "containerd-shim-runc-v2:\n  Version:  v2.3.6\n  Revision: fixture-source-revision\n  Go version: go1.26.5\n";
        assert!(host_version(shim, "containerd-shim-runc-v2", "2.3.6"));
        assert!(!host_version(shim, "containerd-shim-runc-v2", "2.3.4"));
        assert!(host_version(
            "containerd github.com/containerd/containerd/v2 v2.3.6 fixture-source-revision",
            "containerd",
            "2.3.6"
        ));
        assert!(host_version(
            "runc version 1.5.2\ncommit: fixture-source-revision",
            "runc",
            "1.5.2"
        ));
    }
    fn request() -> ControllerCreateRequest {
        let config = PodSandboxConfig {
            metadata: Some(cri::PodSandboxMetadata {
                name: "database-pod".into(),
                uid: "actual-pod-uid".into(),
                namespace: "pgcf-db-example".into(),
                attempt: 0,
            }),
            hostname: "database-pod".into(),
            linux: Some(cri::LinuxPodSandboxConfig {
                security_context: Some(cri::LinuxSandboxSecurityContext {
                    namespace_options: Some(cri::NamespaceOption {
                        network: cri::NamespaceMode::Pod as i32,
                        pid: cri::NamespaceMode::Container as i32,
                        ipc: cri::NamespaceMode::Pod as i32,
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };
        ControllerCreateRequest {
            sandbox_id: "actual-sandbox".into(),
            netns_path: "/run/netns/actual-CNI-handle".into(),
            options: Some(prost_types::Any {
                type_url: "runtime.v1.PodSandboxConfig".into(),
                value: config.encode_to_vec(),
            }),
            sandbox: Some(crate::containerd::types::Sandbox {
                sandbox_id: "actual-sandbox".into(),
                sandboxer: "pgcf".into(),
                runtime: Some(crate::containerd::types::sandbox::Runtime {
                    name: "io.containerd.runc.v2".into(),
                    options: None,
                }),
                ..Default::default()
            }),
            sandboxer: "pgcf".into(),
            ..Default::default()
        }
    }
    #[test]
    fn real_cri_wire_types_preserve_pod_identity_and_require_isolated_container_pid_mode() {
        let request = request();
        assert_eq!(
            pod_config(&request, "pgcf").unwrap().metadata.unwrap().uid,
            "actual-pod-uid"
        );
        let mut config = pod_config(&request, "pgcf").unwrap();
        config
            .linux
            .as_mut()
            .unwrap()
            .security_context
            .as_mut()
            .unwrap()
            .namespace_options
            .as_mut()
            .unwrap()
            .pid = cri::NamespaceMode::Pod as i32;
        let mut changed = request;
        changed.options.as_mut().unwrap().value = config.encode_to_vec();
        assert_eq!(
            pod_config(&changed, "pgcf").unwrap_err().code(),
            tonic::Code::Unimplemented
        );
    }
    #[test]
    fn unrelated_runtime_and_empty_cni_namespace_are_rejected_before_claim() {
        let mut request = request();
        request.netns_path.clear();
        assert!(pod_config(&request, "pgcf").is_err());
        request.netns_path = "/run/netns/CNI".into();
        request
            .sandbox
            .as_mut()
            .unwrap()
            .runtime
            .as_mut()
            .unwrap()
            .name = "unrelated".into();
        assert!(pod_config(&request, "pgcf").is_err());
    }
}
