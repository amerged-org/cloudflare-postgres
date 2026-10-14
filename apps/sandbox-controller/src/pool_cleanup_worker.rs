// SPDX-License-Identifier: Apache-2.0
//! Fixed one-shot drain worker. It joins the original live leaf before the original private PID1 stops.
use crate::{
    pool_gate::{GateRoot, ROOT},
    pool_io::{Process, SharedBudget},
    pool_journal::{Journal, Phase},
    slot::Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::{Read, Write},
    path::Path,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_cleanup_worker_unconfirmed")
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub settings: Settings,
    pub scope: Value,
    pub main_pid: u32,
    pub storage_authority: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub v: u8,
    pub holder: Value,
    pub io: Value,
    pub worker_caller_pid: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ready {
    pub v: u8,
    pub pid: u32,
    pub start_ticks: u64,
    pub pid_namespace: u64,
    pub cgroup_inode: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Completed {
    pub v: u8,
    pub nonlazy_unmount_verified: bool,
}
pub fn run(path: &Path) -> Result<(), Status> {
    crate::pool_worker::bind_parent()?;
    let request: Request = crate::pool_worker::private_payload(path)?;
    if request.v != 1
        || !request.settings.postgres_pool
        || unsafe { libc::geteuid() } != 0
        || std::fs::read_dir("/proc/self/task")
            .map_err(|_| refused())?
            .take(2)
            .count()
            != 1
    {
        return Err(refused());
    }
    let local = request.settings.cloudflare.as_ref().ok_or_else(refused)?;
    let config = local.storage_authority.as_ref().ok_or_else(refused)?;
    let trust = pgcf_native_protocol::storage::StorageTrust::parse(
        &serde_json::to_string(&config.keys).map_err(|_| refused())?,
        &config.sha256,
    )
    .map_err(|_| refused())?;
    let scope = &request.scope;
    let now = u64::try_from(crate::policy::now_ms()).map_err(|_| refused())?;
    if pgcf_native_protocol::pool::verify_pool_storage_authority(
        &trust,
        &request.storage_authority,
        scope,
        now,
    )
    .is_none()
        || scope["node_uid"] != local.node_uid
        || scope["boot_id"] != crate::storage::current_boot_id()?
        || crate::policy::digest(Path::new("/proc/self/exe"))?
            != text(scope, "host_controller_sha256")?
    {
        return Err(refused());
    }
    let main = Process::capture(
        request.main_pid,
        text(scope, "pool_pod_uid")?,
        text(scope, "container_id")?,
    )?;
    main.private_namespace()?;
    main.join_own_worker()?;
    let worker = Process::capture(
        std::process::id(),
        text(scope, "pool_pod_uid")?,
        text(scope, "container_id")?,
    )?;
    let ready = Ready {
        v: 1,
        pid: worker.pid,
        start_ticks: worker.start_ticks,
        pid_namespace: worker.pid_namespace.inode,
        cgroup_inode: worker.cgroup_inode,
    };
    println!("{}", serde_json::to_string(&ready).map_err(|_| refused())?);
    std::io::stdout().flush().map_err(|_| refused())?;
    let mut command = String::new();
    std::io::stdin()
        .take(65)
        .read_to_string(&mut command)
        .map_err(|_| refused())?;
    if command != "execute\n" {
        return Err(refused());
    }
    let grant: Grant = crate::pool_worker::private_payload(&path.with_file_name("grant.json"))?;
    if grant.v != 1 || grant.worker_caller_pid != std::process::id() {
        return Err(refused());
    }
    let permission =
        crate::pool_cleanup_permission::Permission::new(scope, &grant.holder, &grant.io, local)?;
    let expected = &grant.io["worker"];
    if expected["start_ticks"] != worker.start_ticks
        || expected["pid_namespace"] != worker.pid_namespace.inode
        || expected["cgroup_inode"] != worker.cgroup_inode
        || expected["container_id"] != worker.container_id
    {
        return Err(refused());
    }
    let group = crate::pool_io::CapturedGroup::restore(&worker.group_record())?;
    group.only_worker()?;
    let metadata = permission.device()?;
    let claims = permission.claims();
    let bps = claims["write_bytes_per_second"]
        .as_u64()
        .ok_or_else(refused)?;
    let iops = claims["write_iops_per_second"]
        .as_u64()
        .ok_or_else(refused)?;
    let budget = SharedBudget::capture(std::slice::from_ref(&worker))?;
    if budget.pod_cgroup_inode
        != grant.io["shared_pod_io"]["pod_cgroup_inode"]
            .as_u64()
            .ok_or_else(refused)?
        || !worker.io_matches(metadata.device, bps, iops)?
        || !budget.io_matches(metadata.device, bps, iops)?
    {
        return Err(refused());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| refused())?;
    let driver = runtime.block_on(crate::pool_driver::verify(
        &request.settings,
        text(scope, "driver_image")?,
        text(scope, "driver_sha256")?,
    ))?;
    drop(runtime);
    let root = GateRoot::open(Path::new(ROOT))?;
    let handle = text(&scope["storage"], "volume_handle")?;
    let locked = root.lock_until(handle, permission.deadline())?;
    let journal = Journal::open(&locked.record_path().with_extension("state"))?;
    let mut state = journal.read()?.ok_or_else(refused)?;
    let cleanup = state.cleanup.as_ref().ok_or_else(refused)?;
    if state.phase != Phase::DetachDispatched
        || state.scope.as_ref() != Some(scope)
        || !root.record_matches(&state.record)?
        || !cleanup.dispatched
        || cleanup.worker_caller_pid != std::process::id()
        || cleanup.io.as_ref() != Some(&grant.io)
        || cleanup.authority.as_deref() != Some(permission.token())
        || cleanup.nonlazy_completed
        || cleanup.worker_reaped
    {
        return Err(refused());
    }
    state
        .cleanup
        .as_mut()
        .ok_or_else(refused)?
        .write_bytes_before = budget.write_bytes(metadata.device)?;
    journal.store(&state)?;
    driver.recheck()?;
    group.only_worker()?;
    crate::storage_dm::resume_cleanup(&permission)?;
    let anchor = crate::pool_mount::MountedAnchor::for_pod(text(scope, "pool_pod_uid")?)
        .map_err(|_| refused())?;
    let expected = crate::pool_mount::MountIdentity {
        device: state.device,
        mount_id: state.mount_id.ok_or_else(refused)?,
    };
    if anchor.identity().map_err(|_| refused())? != expected || !permission.current() {
        return Err(refused());
    }
    anchor.detach_in_one_shot(expected).map_err(|_| refused())?;
    state
        .cleanup
        .as_mut()
        .ok_or_else(refused)?
        .nonlazy_completed = true;
    state
        .cleanup
        .as_mut()
        .ok_or_else(refused)?
        .write_bytes_after = budget.write_bytes(metadata.device)?;
    journal.store(&state)?;
    println!(
        "{}",
        serde_json::to_string(&Completed {
            v: 1,
            nonlazy_unmount_verified: true
        })
        .map_err(|_| refused())?
    );
    Ok(())
}
