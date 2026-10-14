// SPDX-License-Identifier: Apache-2.0
//! Fixed single-thread mount worker. The parent owns the independent expiry clock and CF reports.
use crate::{
    pool_device::{Backend, Device},
    pool_gate::{GateRoot, ROOT, Record},
    pool_guard::Armed,
    pool_journal::{Journal, Phase},
    pool_mount::DataAnchor,
    pool_permission::{self, Permission},
    slot::Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::OpenOptions,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_worker_unconfirmed")
}
pub fn bind_parent() -> Result<(), Status> {
    let before = unsafe { libc::getppid() };
    if before <= 1
        || unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) } != 0
        || unsafe { libc::getppid() } != before
    {
        return Err(refused());
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub settings: Settings,
    pub desired: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub v: u8,
    pub scope_sha256: String,
    pub device: u64,
    pub mount_id: u64,
    pub pool_pod_uid: String,
    pub observed_at: u64,
}
pub(crate) fn private_payload<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Status> {
    let parent = path.parent().ok_or_else(refused)?;
    let d = std::fs::symlink_metadata(parent).map_err(|_| refused())?;
    if !path.is_absolute()
        || std::fs::canonicalize(parent).map_err(|_| refused())? != parent
        || !d.is_dir()
        || d.uid() != 0
        || d.mode() & 0o7777 != 0o700
    {
        return Err(refused());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    if !m.is_file()
        || m.uid() != 0
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > 131072
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(131073)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 131072 {
        return Err(refused());
    }
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
pub fn payload(path: &Path) -> Result<Request, Status> {
    let request: Request = private_payload(path)?;
    if request.v != 1 || !request.settings.postgres_pool {
        return Err(refused());
    }
    Ok(request)
}
pub fn mount(request: Request) -> Result<Observation, Status> {
    if std::fs::read_dir("/proc/self/task")
        .map_err(|_| refused())?
        .take(2)
        .count()
        != 1
        || unsafe { libc::geteuid() } != 0
    {
        return Err(refused());
    }
    let local = request.settings.cloudflare.as_ref().ok_or_else(refused)?;
    let config = local.storage_authority.as_ref().ok_or_else(refused)?;
    let keys = pool_permission::keys(config)?;
    let permission = Permission::new(&request.desired, local, &keys)?;
    let scope = permission.scope();
    if crate::policy::digest(std::path::Path::new("/proc/self/exe"))?
        != scope["host_controller_sha256"]
            .as_str()
            .ok_or_else(refused)?
    {
        return Err(refused());
    }
    let trust = pgcf_native_protocol::storage::StorageTrust::parse(
        &serde_json::to_string(&config.keys).map_err(|_| refused())?,
        &config.sha256,
    )
    .map_err(|_| refused())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| refused())?;
    let containers = runtime.block_on(crate::pool_custody::running(&request.settings))?;
    let driver = runtime.block_on(crate::pool_driver::verify(
        &request.settings,
        scope["driver_image"].as_str().ok_or_else(refused)?,
        scope["driver_sha256"].as_str().ok_or_else(refused)?,
    ))?;
    drop(runtime);
    let matching = containers
        .iter()
        .filter(|c| c.pod_uid == scope["pool_pod_uid"])
        .collect::<Vec<_>>();
    if matching.len() != 2
        || !matching.iter().any(|c| c.role == "postgres")
        || !matching.iter().any(|c| c.role == "archiver")
        || matching.iter().any(|c| {
            scope["container_ids"]
                .as_array()
                .is_none_or(|ids| !ids.iter().any(|id| id == &c.process.container_id))
        })
    {
        return Err(refused());
    }
    let processes = matching
        .iter()
        .map(|c| {
            crate::pool_io::Process::capture(c.process.pid, &c.pod_uid, &c.process.container_id)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let token = request.desired["storage_authority"]
        .as_str()
        .ok_or_else(refused)?;
    let guard = Armed::arm(&trust, scope, token, &local.node_uid, processes)?;
    let main = matching
        .iter()
        .find(|c| c.process.container_id == scope["container_id"] && c.role == "postgres")
        .ok_or_else(refused)?;
    main.process.join_own_worker()?;
    let storage = &scope["storage"];
    let text = |key| storage[key].as_str().ok_or_else(refused);
    let device = Device::verify(
        text("volume_group_uuid")?,
        text("lv_uuid")?,
        text("volume_handle")?,
        Backend::Thin {
            pool_uuid: storage["profile"]["pool_uuid"]
                .as_str()
                .ok_or_else(refused)?
                .to_owned(),
            thin_id: storage["thin_id"]
                .as_u64()
                .ok_or_else(refused)?
                .try_into()
                .map_err(|_| refused())?,
        },
    )
    .map_err(|_| refused())?;
    let record = Record::new(
        text("volume_handle")?,
        permission.scope_sha256(),
        device.uuid(),
    )?;
    let gate = GateRoot::open(Path::new(ROOT))?;
    let locked = gate.lock_until(text("volume_handle")?, permission.deadline())?;
    if !gate.record_matches(&record)? {
        return Err(refused());
    }
    let path = locked.record_path().with_extension("state");
    let journal = Journal::open(&path)?;
    let state = journal.read()?.ok_or_else(refused)?;
    if state.phase != Phase::MountDispatched
        || state.scope.as_ref() != Some(scope)
        || state
            .io_attestation
            .as_ref()
            .is_none_or(|io| !pgcf_native_protocol::pool::validate("PoolIoAttestation", io))
        || state.record != record
        || state.binding_id != scope["binding_id"]
        || state.pool_pod_uid != scope["pool_pod_uid"]
        || state.boot_id != scope["boot_id"]
        || state.device != device.device()
        || state.storage_authority.as_deref() != Some(token)
    {
        return Err(refused());
    }
    driver.recheck()?;
    if !permission.current() || !guard.permits() {
        return Err(refused());
    }
    device.zero().map_err(|_| refused())?;
    let anchor = DataAnchor::for_pod(scope["pool_pod_uid"].as_str().ok_or_else(refused)?)
        .map_err(|_| refused())?;
    let attached = crate::pool_mount::Ext4Creation::exclusive(device.descriptor())
        .map_err(|_| refused())?
        .attach(&anchor)
        .map_err(|_| refused())?;
    journal.store(&state.mounted(attached)?)?;
    // A successful syscall with a lost response remains journalled and is never issued twice.
    Ok(Observation {
        v: 1,
        scope_sha256: permission.scope_sha256().to_owned(),
        device: attached.device,
        mount_id: attached.mount_id,
        pool_pod_uid: scope["pool_pod_uid"]
            .as_str()
            .ok_or_else(refused)?
            .to_owned(),
        observed_at: u64::try_from(crate::policy::now_ms()).map_err(|_| refused())?,
    })
}
