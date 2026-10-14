// SPDX-License-Identifier: Apache-2.0
//! One scoped root→supervisor message. Peer custody is checked before any authority bytes are sent.
use crate::{pool_custody::Container, pool_guard::Active};
use serde_json::Value;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        },
    },
    time::Duration,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_mount_signal_unconfirmed")
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
pub fn mounted(container: &Container, active: &Active, signal: &Value) -> Result<Value, Status> {
    let guard = active.snapshot()?;
    let scope = &guard.scope;
    if !active.current()
        || container.role != "postgres"
        || container.pod_uid != scope["pool_pod_uid"]
        || container.process.container_id != scope["container_id"]
        || !pgcf_native_protocol::pool::validate("PoolMountSignal", signal)
        || signal["storage_authority"] != guard.token
        || signal["scope_sha256"]
            != pgcf_native_protocol::pool::scope_hash(scope).ok_or_else(refused)?
    {
        return Err(refused());
    }
    for key in [
        "binding_id",
        "bundle_nonce",
        "node_uid",
        "boot_id",
        "pool_pod_uid",
    ] {
        if signal[key] != scope[key] {
            return Err(refused());
        }
    }
    if signal["device_major"] != libc::major(guard.device)
        || signal["device_minor"] != libc::minor(guard.device)
    {
        return Err(refused());
    }
    container.process.recheck()?;
    let path = CString::new(format!(
        "/var/lib/kubelet/pods/{}/volumes/kubernetes.io~empty-dir/control/private",
        container.pod_uid
    ))
    .map_err(|_| refused())?;
    let how = OpenHow {
        flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: 0x04 | 0x02,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            libc::AT_FDCWD,
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(refused());
    }
    let directory = unsafe { File::from_raw_fd(fd as i32) };
    let meta = directory.metadata().map_err(|_| refused())?;
    if meta.uid() != 26 || meta.mode() & 0o7777 != 0o700 {
        return Err(refused());
    }
    let path = format!("/proc/self/fd/{}/agent.sock", directory.as_raw_fd());
    let before = std::fs::symlink_metadata(&path).map_err(|_| refused())?;
    if !before.file_type().is_socket()
        || before.uid() != 26
        || before.mode() & 0o7777 != 0o600
        || before.nlink() != 1
    {
        return Err(refused());
    }
    let mut stream = UnixStream::connect(&path).map_err(|_| refused())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| refused())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| refused())?;
    let mut peer: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&peer) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut peer as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
        || length as usize != std::mem::size_of_val(&peer)
        || peer.uid != 26
        || u32::try_from(peer.pid).ok() != Some(container.process.pid)
    {
        return Err(refused());
    }
    container.process.recheck()?;
    if !active.current() {
        return Err(refused());
    }
    let request = serde_json::to_vec(signal).map_err(|_| refused())?;
    if request.len() > 65536 {
        return Err(refused());
    }
    stream.write_all(&request).map_err(|_| refused())?;
    stream
        .shutdown(std::net::Shutdown::Write)
        .map_err(|_| refused())?;
    let mut bytes = Vec::new();
    stream
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 65536 {
        return Err(refused());
    }
    let response: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    let waiting = response.as_object().is_some_and(|o| {
        o.len() == 2 && response["accepted"] == true && response["waiting"] == true
    });
    if !waiting
        && (!pgcf_native_protocol::pool::validate("PoolSupervisorReport", &response)
            || response["binding_id"] != scope["binding_id"]
            || response["scope_sha256"] != signal["scope_sha256"])
    {
        return Err(refused());
    }
    let after = std::fs::symlink_metadata(&path).map_err(|_| refused())?;
    if before.dev() != after.dev() || before.ino() != after.ino() {
        return Err(refused());
    }
    container.process.recheck()?;
    if !active.current() {
        return Err(refused());
    }
    Ok(response)
}
