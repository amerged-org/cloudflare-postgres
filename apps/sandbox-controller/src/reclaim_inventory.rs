// SPDX-License-Identifier: Apache-2.0
//! Fixed public-only metadata projection. This never exposes controller sockets, credentials or arbitrary execution.
use crate::{
    controller::SandboxController,
    host_proc::{HostProc, ProcessMapping},
    policy::Client,
};
use pgcf_node_runtime::protocol::NamespaceIdentity;
use serde_json::{Value, json};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};
use tonic::Status;
static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/reclaim.generated.json"
    ))
    .expect("generated_reclaim_contract_invalid")
});
pub struct Candidate {
    pub database_id: String,
    pub namespace: String,
    pub pod_uid: String,
    pub container_id: String,
    pub cri_pid: u32,
    pub start_ticks: u64,
    pub pid_namespace: NamespaceIdentity,
    pub cgroup_path: String,
    pub postgres_image_id: String,
}
fn unknown() -> Status {
    Status::failed_precondition("reclaim_inventory_unknown")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn schema(name: &str, value: &Value) -> bool {
    jsonschema::validator_for(&CONTRACT["schemas"][name])
        .is_ok_and(|validator| validator.is_valid(value))
}
fn fixed(name: &str) -> PathBuf {
    PathBuf::from(
        CONTRACT["constants"]["RECLAIM_FILES"][name]
            .as_str()
            .expect("fixed_reclaim_path_missing"),
    )
}
pub fn cgroup_path(raw: &str, pod: &str, container: &str) -> Option<String> {
    let rows = raw.lines().collect::<Vec<_>>();
    if rows.len() != 1 {
        return None;
    }
    let path = rows[0].strip_prefix("0::/")?;
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| {
        part.is_empty() || matches!(*part, "." | "..") || part.contains(['\\', '\0', ' '])
    }) {
        return None;
    }
    let unit = format!("kubepods-burstable-pod{}.slice", pod.replace('-', "_"));
    let scope = format!("cri-containerd-{container}.scope");
    let pod_group = format!("pod{pod}");
    let systemd = parts.windows(4).any(|parts| {
        parts
            == [
                "kubepods.slice",
                "kubepods-burstable.slice",
                unit.as_str(),
                scope.as_str(),
            ]
    }) && parts.last() == Some(&scope.as_str());
    let cgroupfs = parts
        .windows(4)
        .any(|parts| parts == ["kubepods", "burstable", pod_group.as_str(), container])
        && parts.last() == Some(&container);
    (systemd || cgroupfs).then(|| format!("/{path}"))
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
fn beneath(root: &File, path: &str, flags: i32) -> Result<File, Status> {
    let path = CString::new(path).map_err(|_| unknown())?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
        mode: 0,
        resolve: 0x08 | 0x04 | 0x02,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(unknown());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
fn cgroup(candidate: &Candidate) -> Result<File, Status> {
    let raw =
        fs::read_to_string(format!("/proc/{}/cgroup", candidate.cri_pid)).map_err(|_| unknown())?;
    if cgroup_path(&raw, &candidate.pod_uid, &candidate.container_id).as_deref()
        != Some(candidate.cgroup_path.as_str())
        || crate::slot::start_ticks(candidate.cri_pid)? != candidate.start_ticks
        || crate::slot::namespace(candidate.cri_pid, "pid")? != candidate.pid_namespace
    {
        return Err(unknown());
    }
    let root = File::open("/sys/fs/cgroup").map_err(|_| unknown())?;
    let directory = beneath(
        &root,
        candidate.cgroup_path.trim_start_matches('/'),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(directory.as_raw_fd(), filesystem.as_mut_ptr()) } < 0
        || unsafe { filesystem.assume_init() }.f_type != 0x63677270
    {
        return Err(unknown());
    }
    Ok(directory)
}
/// Only a current authenticated CF scope may delegate this one write-only control to the unprivileged reclaimer group.
pub fn delegate_reclaim(
    candidate: &Candidate,
    scope: &pgcf_native_protocol::reclaim::Verified,
    node_uid: &str,
    boot_id: &str,
) -> Result<u64, Status> {
    let claims = scope.claims();
    let digest = candidate
        .postgres_image_id
        .rsplit("sha256:")
        .next()
        .filter(|value| value.len() == 64)
        .ok_or_else(unknown)?;
    if claims["mode"] != "reclaim"
        || claims["node_uid"] != node_uid
        || claims["boot_id"] != boot_id
        || claims["database_id"] != candidate.database_id
        || claims["pod_uid"] != candidate.pod_uid
        || claims["container_id"] != candidate.container_id
        || claims["postgres_image_sha256"] != digest
        || !pgcf_native_protocol::reclaim::valid_at(claims, now())
    {
        return Err(unknown());
    }
    let directory = cgroup(candidate)?;
    let inode = directory.metadata().map_err(|_| unknown())?.ino();
    let control = beneath(&directory, "memory.reclaim", libc::O_WRONLY)?;
    if control.metadata().map_err(|_| unknown())?.uid() != 0 {
        return Err(unknown());
    }
    if unsafe { libc::fchown(control.as_raw_fd(), u32::MAX, 65532) } < 0
        || unsafe { libc::fchmod(control.as_raw_fd(), 0o220) } < 0
    {
        return Err(unknown());
    }
    Ok(inode)
}
fn public_directory(path: &Path) -> Result<(), Status> {
    match fs::create_dir(path) {
        Ok(()) => {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|_| unknown())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(unknown()),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| unknown())?;
    if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o777 != 0o755 {
        return Err(unknown());
    }
    Ok(())
}
pub fn publish_public(kind: &str, value: &Value) -> Result<(), Status> {
    let path = fixed(kind);
    let directory = path.parent().ok_or_else(unknown)?;
    public_directory(directory)?;
    let pending = path.with_extension("pending");
    if let Ok(metadata) = fs::symlink_metadata(&pending) {
        if !metadata.is_file() || metadata.uid() != 0 {
            return Err(unknown());
        }
        fs::remove_file(&pending).map_err(|_| unknown())?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&pending)
        .map_err(|_| unknown())?;
    file.set_permissions(fs::Permissions::from_mode(0o644))
        .map_err(|_| unknown())?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| unknown())?)
        .and_then(|()| file.sync_all())
        .map_err(|_| unknown())?;
    fs::rename(pending, path).map_err(|_| unknown())
}
pub async fn snapshot(
    controller: &SandboxController,
    host: &HostProc,
    node_uid: &str,
) -> Result<Value, Status> {
    let candidates = tokio::time::timeout(Duration::from_secs(1), controller.reclaim_candidates())
        .await
        .map_err(|_| unknown())??;
    snapshot_candidates(host, node_uid, candidates)
}
pub fn snapshot_candidates(
    host: &HostProc,
    node_uid: &str,
    candidates: Vec<Candidate>,
) -> Result<Value, Status> {
    let captured = now();
    let requested = candidates
        .iter()
        .map(|value| ProcessMapping {
            cri_pid: value.cri_pid,
            start_ticks: value.start_ticks,
            pid_namespace: value.pid_namespace,
        })
        .collect::<Vec<_>>();
    let mapped = host.map(&requested)?;
    let mut tasks = Vec::new();
    for candidate in candidates {
        let Some(pid) = mapped.get(&candidate.cri_pid) else {
            continue;
        };
        let Ok(directory) = cgroup(&candidate) else {
            continue;
        };
        let Ok(metadata) = directory.metadata() else {
            continue;
        };
        tasks.push(json!({"database_id":candidate.database_id,"namespace":candidate.namespace,"pod_uid":candidate.pod_uid,"container_id":candidate.container_id,"container_name":"postgres","pid":pid,"cri_pid":candidate.cri_pid,"start_ticks":candidate.start_ticks,"cgroup_path":candidate.cgroup_path,"cgroup_inode":metadata.ino(),"postgres_image_id":candidate.postgres_image_id}));
    }
    let snapshot = json!({"v":1,"node_uid":node_uid,"boot_id":host.boot_id()?,"pid_namespace_inode":host.host_namespace.inode,"cri_pid_namespace_inode":crate::slot::namespace(std::process::id(),"pid")?.inode,"captured_at":captured,"expires_at":captured+2000,"tasks":tasks});
    if now() >= captured + 1000 || !schema("ReclaimTaskSnapshot", &snapshot) {
        return Err(unknown());
    }
    Ok(snapshot)
}
fn current_report(client: &Client, boot: &str) -> Result<Value, Status> {
    let path = fixed("report");
    let directory = path.parent().ok_or_else(unknown)?;
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory)
        .map_err(|_| unknown())?;
    let file = beneath(
        &root,
        path.file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(unknown)?,
        libc::O_RDONLY,
    )?;
    let meta = file.metadata().map_err(|_| unknown())?;
    if !meta.is_file() || meta.uid() != 65532 || meta.mode() & 0o022 != 0 {
        return Err(unknown());
    }
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unknown())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(unknown());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| unknown())?;
    let clock = now();
    if !schema("ReclaimObservations", &value)
        || value["node_uid"] != client.local().node_uid
        || value["boot_id"] != boot
        || value["material_revision"].as_u64() != Some(u64::from(client.local().material_revision))
        || !value["observed_at"]
            .as_u64()
            .is_some_and(|at| at >= clock.saturating_sub(2000) && at <= clock.saturating_add(1000))
    {
        return Err(unknown());
    }
    Ok(value)
}
pub async fn run(
    controller: SandboxController,
    mut client: Client,
    mut updates: tokio::sync::watch::Receiver<Client>,
) {
    let host = match HostProc::inherited() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{}", error.message());
            return;
        }
    };
    let Some(public) = client.local().storage_authority.as_ref() else {
        return;
    };
    let trust = match pgcf_native_protocol::reclaim::Trust::new(
        &serde_json::to_string(&public.keys).unwrap_or_default(),
        &public.sha256,
    ) {
        Ok(value) => value,
        Err(_) => return,
    };
    let mut last_report = None;
    loop {
        if updates.has_changed().unwrap_or(false) {
            client = updates.borrow_and_update().clone();
        }
        if let Ok(snapshot) = snapshot(&controller, &host, &client.local().node_uid).await {
            let _ = publish_public("tasks", &snapshot);
        }
        if let Ok(intents) = client.reclaim_intents().await {
            let clock = now();
            if schema("ReclaimIntentSnapshot", &intents)
                && intents["node_uid"] == client.local().node_uid
                && intents["boot_id"] == host.boot_id().unwrap_or_default()
                && intents["material_revision"].as_u64()
                    == Some(u64::from(client.local().material_revision))
                && intents["issued_at"].as_u64().is_some_and(|at| {
                    at <= clock.saturating_add(1000) && at >= clock.saturating_sub(1000)
                })
                && intents["expires_at"].as_u64().is_some_and(|expiry| {
                    expiry > clock
                        && expiry <= clock.saturating_add(2000)
                        && expiry
                            <= intents["issued_at"]
                                .as_u64()
                                .unwrap_or(0)
                                .saturating_add(2000)
                })
            {
                let tokens = intents["tokens"].as_array().cloned().unwrap_or_default();
                let verified = tokens
                    .iter()
                    .map(|token| {
                        token
                            .as_str()
                            .ok_or(())
                            .and_then(|token| trust.verify(token, clock).map_err(|_| ()))
                    })
                    .collect::<Result<Vec<_>, _>>();
                if let Ok(verified) = verified {
                    if let Ok(candidates) = controller.reclaim_candidates().await {
                        let boot = host.boot_id().unwrap_or_default();
                        for candidate in &candidates {
                            for scope in &verified {
                                let _ = delegate_reclaim(
                                    candidate,
                                    scope,
                                    &client.local().node_uid,
                                    &boot,
                                );
                            }
                        }
                    }
                    let _ = publish_public("intents", &intents);
                }
            }
        }
        if let Ok(report) = current_report(&client, &host.boot_id().unwrap_or_default())
            && report["results"]
                .as_array()
                .is_some_and(|results| !results.is_empty())
            && last_report.as_ref() != Some(&report)
            && client.report_reclaim(&report).await.is_ok()
        {
            last_report = Some(report);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
