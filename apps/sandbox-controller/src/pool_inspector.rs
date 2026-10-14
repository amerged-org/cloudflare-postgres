// SPDX-License-Identifier: Apache-2.0
//! Private fixed read-only request channel to the retained initial-PID parent. No mount/exec selectors.
use crate::{
    pool_device::Device,
    pool_gate::{GateRoot, ROOT, Record},
    pool_namespaces::{self, Survey},
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tonic::Status;
pub const FD: i32 = 196;
static SERIAL: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(1);
fn refused() -> Status {
    Status::failed_precondition("pool_parent_inspection_unconfirmed")
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    v: u8,
    id: u64,
    purpose: String,
    record: Record,
    vg_uuid: String,
    lv_uuid: String,
    backend: crate::pool_device::Backend,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextRequest {
    v: u8,
    id: u64,
    purpose: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextResponse {
    v: u8,
    id: u64,
    context: Option<pool_namespaces::ContextProof>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PlatformResponse {
    v: u8,
    id: u64,
    platform: Option<pool_namespaces::PlatformContext>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnchorRequest {
    v: u8,
    id: u64,
    purpose: String,
    device: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AnchorResponse {
    v: u8,
    id: u64,
    device: u64,
    survey: Option<Survey>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    v: u8,
    id: u64,
    scope_sha256: String,
    device: u64,
    survey: Option<Survey>,
}
pub fn inspect(
    record: &Record,
    vg: &str,
    lv: &str,
    device: u64,
    backend: crate::pool_device::Backend,
) -> Result<Survey, Status> {
    let _serial = SERIAL.lock().map_err(|_| refused())?;
    record.bytes()?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == u64::MAX {
        return Err(refused());
    }
    let request = serde_json::to_vec(&Request {
        v: 1,
        id,
        purpose: "device".to_owned(),
        record: record.clone(),
        vg_uuid: vg.to_owned(),
        lv_uuid: lv.to_owned(),
        backend,
    })
    .map_err(|_| refused())?;
    if request.len() > 4096 {
        return Err(refused());
    }
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        if unsafe {
            libc::setsockopt(
                FD,
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                std::mem::size_of_val(&timeout) as libc::socklen_t,
            )
        } != 0
        {
            return Err(refused());
        }
    }
    if unsafe {
        libc::send(
            FD,
            request.as_ptr().cast(),
            request.len(),
            libc::MSG_NOSIGNAL,
        )
    } != request.len() as isize
    {
        return Err(refused());
    }
    let mut bytes = [0u8; 65536];
    let count = unsafe { libc::recv(FD, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_TRUNC) };
    if count <= 0 || count as usize > bytes.len() {
        return Err(refused());
    }
    let response: Response =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if response.v != 1
        || response.id != id
        || response.scope_sha256 != record.scope_sha256
        || response.device != device
    {
        return Err(refused());
    }
    response
        .survey
        .filter(|s| !s.complete_namespace_scan && s.named_namespace_scan_complete)
        .ok_or_else(refused)
}
pub(crate) fn serve_once(fd: i32) -> Result<(), Status> {
    let mut bytes = [0u8; 4096];
    let count = unsafe {
        libc::recv(
            fd,
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            libc::MSG_DONTWAIT | libc::MSG_TRUNC,
        )
    };
    if count < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EAGAIN) {
        return Ok(());
    }
    if count <= 0 || count as usize > bytes.len() {
        return Err(refused());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if value["purpose"] == "platform" {
        let request: ContextRequest = serde_json::from_value(value).map_err(|_| refused())?;
        if request.v != 1 || request.id == 0 || request.purpose != "platform" {
            return Err(refused());
        }
        let bytes = serde_json::to_vec(&PlatformResponse {
            v: 1,
            id: request.id,
            platform: pool_namespaces::platform_context().ok(),
        })
        .map_err(|_| refused())?;
        if unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL) }
            != bytes.len() as isize
        {
            return Err(refused());
        }
        return Ok(());
    }
    if value["purpose"] == "anchor" {
        let request: AnchorRequest = serde_json::from_value(value).map_err(|_| refused())?;
        if request.v != 1
            || request.id == 0
            || request.purpose != "anchor"
            || request.device == 0
            || libc::major(request.device) != 0
        {
            return Err(refused());
        }
        let response = serde_json::to_vec(&AnchorResponse {
            v: 1,
            id: request.id,
            device: request.device,
            survey: pool_namespaces::for_tmpfs(request.device).ok(),
        })
        .map_err(|_| refused())?;
        if response.len() > 65536
            || unsafe {
                libc::send(
                    fd,
                    response.as_ptr().cast(),
                    response.len(),
                    libc::MSG_NOSIGNAL,
                )
            } != response.len() as isize
        {
            return Err(refused());
        }
        return Ok(());
    }
    if value["purpose"] == "context" {
        let request: ContextRequest = serde_json::from_value(value).map_err(|_| refused())?;
        if request.v != 1 || request.id == 0 || request.purpose != "context" {
            return Err(refused());
        }
        let response = serde_json::to_vec(&ContextResponse {
            v: 1,
            id: request.id,
            context: pool_namespaces::context().ok(),
        })
        .map_err(|_| refused())?;
        if unsafe {
            libc::send(
                fd,
                response.as_ptr().cast(),
                response.len(),
                libc::MSG_NOSIGNAL,
            )
        } != response.len() as isize
        {
            return Err(refused());
        }
        return Ok(());
    }
    let request: Request =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if request.v != 1 || request.id == 0 || request.purpose != "device" {
        return Err(refused());
    }
    request.record.bytes()?;
    let result = (|| {
        if !GateRoot::open(std::path::Path::new(ROOT))?.record_matches(&request.record)? {
            return Err(refused());
        }
        let expected = format!(
            "LVM-{}{}",
            request.vg_uuid.replace('-', ""),
            request.lv_uuid.replace('-', "")
        );
        let device = match request.backend {
            crate::pool_device::Backend::Thin { pool_uuid, thin_id } => {
                let actual = crate::pool_device::thin_metadata(
                    &request.vg_uuid,
                    &request.lv_uuid,
                    &request.record.volume_handle,
                    &pool_uuid,
                )
                .map_err(|_| refused())?;
                if actual.thin_id != thin_id {
                    return Err(refused());
                }
                actual.device
            }
            backend => Device::verify(
                &request.vg_uuid,
                &request.lv_uuid,
                &request.record.volume_handle,
                backend,
            )
            .map_err(|_| refused())?
            .device(),
        };
        if expected != request.record.device_uuid {
            return Err(refused());
        }
        let survey = pool_namespaces::for_device(device).map_err(|_| refused())?;
        Ok((device, survey))
    })();
    let (device, survey) = match result {
        Ok((device, survey)) => (device, Some(survey)),
        Err(_) => (0, None),
    };
    let response = serde_json::to_vec(&Response {
        v: 1,
        id: request.id,
        scope_sha256: request.record.scope_sha256,
        device,
        survey,
    })
    .map_err(|_| refused())?;
    if response.len() > 65536
        || unsafe {
            libc::send(
                fd,
                response.as_ptr().cast(),
                response.len(),
                libc::MSG_NOSIGNAL,
            )
        } != response.len() as isize
    {
        return Err(refused());
    }
    Ok(())
}
/// Current authoritative preparation supplies the exact verified lower tmpfs descriptor.
pub fn anchor(anchor: &crate::pool_mount::DataAnchor) -> Result<Survey, Status> {
    let device = anchor.tmpfs_device().map_err(|_| refused())?;
    let _serial = SERIAL.lock().map_err(|_| refused())?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == u64::MAX {
        return Err(refused());
    }
    let request = serde_json::to_vec(&AnchorRequest {
        v: 1,
        id,
        purpose: "anchor".to_owned(),
        device,
    })
    .map_err(|_| refused())?;
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        if unsafe {
            libc::setsockopt(
                FD,
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                std::mem::size_of_val(&timeout) as libc::socklen_t,
            )
        } != 0
        {
            return Err(refused());
        }
    }
    if unsafe {
        libc::send(
            FD,
            request.as_ptr().cast(),
            request.len(),
            libc::MSG_NOSIGNAL,
        )
    } != request.len() as isize
    {
        return Err(refused());
    }
    let mut bytes = [0u8; 65536];
    let count = unsafe { libc::recv(FD, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_TRUNC) };
    if count <= 0 || count as usize > bytes.len() {
        return Err(refused());
    }
    let response: AnchorResponse =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if response.v != 1 || response.id != id || response.device != device {
        return Err(refused());
    }
    response
        .survey
        .filter(|s| {
            !s.complete_namespace_scan && s.named_namespace_scan_complete && !s.aliases.is_empty()
        })
        .ok_or_else(refused)
}
pub fn context() -> Result<pool_namespaces::ContextProof, Status> {
    let _serial = SERIAL.lock().map_err(|_| refused())?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == u64::MAX {
        return Err(refused());
    }
    let request = serde_json::to_vec(&ContextRequest {
        v: 1,
        id,
        purpose: "context".to_owned(),
    })
    .map_err(|_| refused())?;
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        if unsafe {
            libc::setsockopt(
                FD,
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                std::mem::size_of_val(&timeout) as libc::socklen_t,
            )
        } != 0
        {
            return Err(refused());
        }
    }
    if unsafe {
        libc::send(
            FD,
            request.as_ptr().cast(),
            request.len(),
            libc::MSG_NOSIGNAL,
        )
    } != request.len() as isize
    {
        return Err(refused());
    }
    let mut bytes = [0u8; 4096];
    let count = unsafe { libc::recv(FD, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_TRUNC) };
    if count <= 0 || count as usize > bytes.len() {
        return Err(refused());
    }
    let response: ContextResponse =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if response.v != 1 || response.id != id {
        return Err(refused());
    }
    response.context.ok_or_else(refused)
}
pub(crate) fn poll(parent: i32, child: i32) -> Result<(), Status> {
    let mut fds = [
        libc::pollfd {
            fd: parent,
            events: libc::POLLIN,
            revents: 0,
        },
        libc::pollfd {
            fd: child,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    let ready = unsafe {
        libc::poll(
            fds.as_mut_ptr(),
            fds.len() as libc::nfds_t,
            Duration::from_millis(100).as_millis() as i32,
        )
    };
    if ready < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
        return Ok(());
    }
    if ready < 0 {
        return Err(refused());
    }
    if fds[0].revents & libc::POLLIN != 0 {
        serve_once(parent)?
    }
    Ok(())
}

pub fn platform() -> Result<pool_namespaces::PlatformContext, Status> {
    let _serial = SERIAL.lock().map_err(|_| refused())?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    if id == u64::MAX {
        return Err(refused());
    }
    let bytes = serde_json::to_vec(&ContextRequest {
        v: 1,
        id,
        purpose: "platform".to_owned(),
    })
    .map_err(|_| refused())?;
    let timeout = libc::timeval {
        tv_sec: 5,
        tv_usec: 0,
    };
    for opt in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        if unsafe {
            libc::setsockopt(
                FD,
                libc::SOL_SOCKET,
                opt,
                (&timeout as *const libc::timeval).cast(),
                std::mem::size_of_val(&timeout) as libc::socklen_t,
            )
        } != 0
        {
            return Err(refused());
        }
    }
    if unsafe { libc::send(FD, bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL) }
        != bytes.len() as isize
    {
        return Err(refused());
    }
    let mut bytes = [0u8; 4096];
    let count = unsafe { libc::recv(FD, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_TRUNC) };
    if count <= 0 || count as usize > bytes.len() {
        return Err(refused());
    }
    let response: PlatformResponse =
        serde_json::from_slice(&bytes[..count as usize]).map_err(|_| refused())?;
    if response.v != 1 || response.id != id {
        return Err(refused());
    }
    response.platform.ok_or_else(refused)
}
