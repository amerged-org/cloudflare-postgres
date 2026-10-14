// SPDX-License-Identifier: Apache-2.0
//! Fixed prewake PG control inspection: one scoped readonly directory FD, never an exec selector.
use crate::{
    policy::Cloudflare,
    pool_custody::Container,
    pool_gate::{GateRoot, ROOT, Record},
};
use pgcf_native_protocol::{pool, qualification};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{fs::MetadataExt, net::UnixStream},
    },
    time::Duration,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_readonly_inspection_unconfirmed")
}
pub fn validate(
    signal: &Value,
    preparation: &Value,
    local: &Cloudflare,
    keys: &HashMap<String, Vec<u8>>,
) -> Result<Value, Status> {
    if !pool::validate(
        "PoolStorageReadRequest",
        &serde_json::json!({"signal":signal,"preparation":preparation}),
    ) {
        return Err(refused());
    }
    let now = u64::try_from(crate::policy::now_ms()).map_err(|_| refused())?;
    let claims = qualification::verify_qualification_permission(
        signal["permission"].as_str().ok_or_else(refused)?,
        keys,
        now,
    )
    .ok_or_else(refused)?;
    let hash = Sha256::digest(serde_json::to_vec(preparation).map_err(|_| refused())?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let scope = &claims["scope"];
    let storage = &signal["storage"];
    let execution = &claims["execution"];
    if execution["node_uid"] != local.node_uid
        || execution["boot_id"] != signal["boot_id"]
        || local
            .storage_authority
            .as_ref()
            .is_none_or(|trust| execution["verifier_keys_sha256"] != trust.sha256)
        || execution["candidate_release_id"] != scope["candidate_release_id"]
        || execution["candidate_spec_sha256"] != scope["candidate_spec_sha256"]
        || claims["preparation_sha256"] != hash
        || signal["preparation_sha256"] != hash
        || signal["qualification_run_id"] != scope["run_id"]
        || signal["qualification_scope_sha256"] != claims["scope_sha256"]
        || signal["nonce"] != claims["challenge"]["nonce"]
        || signal["database_id"] != scope["database_id"]
        || signal["configuration_fingerprint"] != scope["configuration_fingerprint"]
        || signal["source_generation"]
            .as_u64()
            .and_then(|n| n.checked_add(1))
            != scope["database_generation"].as_u64()
        || scope["node_id"] != local.node_id
        || signal["node_uid"] != local.node_uid
        || scope["node_uid"] != local.node_uid
        || scope["region_id"] != local.region_id
        || signal["boot_id"] != crate::storage::current_boot_id()?
        || signal["boot_id"] != scope["boot_id"]
        || signal["issued_at"].as_u64().is_none_or(|n| {
            n > now.saturating_add(5000) || n < claims["iat"].as_u64().unwrap_or(u64::MAX)
        })
        || signal["expires_at"]
            .as_u64()
            .is_none_or(|n| n <= now || n > claims["exp"].as_u64().unwrap_or(0))
    {
        return Err(refused());
    }
    for key in [
        "storage_uid",
        "storage_generation",
        "namespace_uid",
        "pvc_uid",
        "pv_uid",
        "volume_handle",
        "volume_group_uuid",
        "lv_uuid",
    ] {
        if storage[key] != scope["volume"][key] {
            return Err(refused());
        }
    }
    if storage["cnpg_cluster_uid"] != scope["volume"]["cluster_uid"]
        || storage["thin_id"] != scope["thin_id"]
        || storage["profile"] != scope["storage"]
        || signal["supervisor_sha256"] != scope["software"]["supervisor_sha256"]
        || preparation["node_id"] != local.node_id
        || preparation["node_uid"] != local.node_uid
        || preparation["boot_id"] != signal["boot_id"]
        || preparation["pool_namespace_uid"] != signal["pool_namespace_uid"]
        || preparation["expires_at"].as_u64().is_none_or(|n| n <= now)
        || preparation["observed_at"]
            .as_u64()
            .is_none_or(|n| n > now.saturating_add(5000))
        || preparation["policy"]["supervisor_sha256"] != signal["supervisor_sha256"]
        || preparation["policy"]["class"]["postgres_image_sha256"]
            != signal["postgres_image_sha256"]
        || scope["software"]["postgres_image"]
            .as_str()
            .and_then(|s| s.split_once("@sha256:").map(|(_, h)| h))
            != signal["postgres_image_sha256"].as_str()
    {
        return Err(refused());
    }
    let pod = preparation["pods"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .find(|p| p["pod_uid"] == signal["pool_pod_uid"])
        .ok_or_else(refused)?;
    let set = |v: &Value| {
        v.as_array().map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<BTreeSet<_>>()
        })
    };
    if set(&pod["container_ids"]) != set(&signal["container_ids"]) {
        return Err(refused());
    }
    Ok(claims)
}
pub fn inspect(
    container: &Container,
    signal: &Value,
    preparation: &Value,
    local: &Cloudflare,
    keys: &HashMap<String, Vec<u8>>,
    pgdata: &File,
) -> Result<Value, Status> {
    let _claims = validate(signal, preparation, local, keys)?;
    container.process.recheck()?;
    if container.role != "postgres"
        || container.pod_uid != signal["pool_pod_uid"]
        || signal["container_ids"]
            .as_array()
            .is_none_or(|ids| !ids.iter().any(|id| id == &container.process.container_id))
        || crate::policy::digest(std::path::Path::new(&format!(
            "/proc/{}/exe",
            container.process.pid
        )))? != signal["supervisor_sha256"].as_str().ok_or_else(refused)?
    {
        return Err(refused());
    }
    let meta = pgdata.metadata().map_err(|_| refused())?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if !meta.is_dir()
        || unsafe { libc::fcntl(pgdata.as_raw_fd(), libc::F_GETFL) } & libc::O_PATH == 0
        || unsafe { libc::fstatfs(pgdata.as_raw_fd(), &mut stat) } != 0
        || stat.f_flags as u64 & libc::ST_RDONLY == 0
    {
        return Err(refused());
    }
    let storage = &signal["storage"];
    let physical = crate::pool_device::thin_metadata(
        storage["volume_group_uuid"].as_str().ok_or_else(refused)?,
        storage["lv_uuid"].as_str().ok_or_else(refused)?,
        storage["volume_handle"].as_str().ok_or_else(refused)?,
        storage["profile"]["pool_uuid"]
            .as_str()
            .ok_or_else(refused)?,
    )
    .map_err(|_| refused())?;
    if physical.device != meta.dev()
        || Some(u64::from(physical.thin_id)) != storage["thin_id"].as_u64()
    {
        return Err(refused());
    }
    let uuid = format!(
        "LVM-{}{}",
        storage["volume_group_uuid"]
            .as_str()
            .ok_or_else(refused)?
            .replace('-', ""),
        storage["lv_uuid"]
            .as_str()
            .ok_or_else(refused)?
            .replace('-', "")
    );
    let record = Record::new(
        storage["volume_handle"].as_str().ok_or_else(refused)?,
        signal["qualification_scope_sha256"]
            .as_str()
            .ok_or_else(refused)?,
        &uuid,
    )?;
    if !GateRoot::open(std::path::Path::new(ROOT))?.record_matches(&record)? {
        return Err(refused());
    }
    let path = format!(
        "/var/lib/kubelet/pods/{}/volumes/kubernetes.io~empty-dir/control/private/agent.sock",
        container.pod_uid
    );
    let mut stream = UnixStream::connect(path).map_err(|_| refused())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| refused())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
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
        || peer.uid != 26
        || u32::try_from(peer.pid).ok() != Some(container.process.pid)
    {
        return Err(refused());
    }
    container.process.recheck()?;
    validate(signal, preparation, local, keys)?;
    let body = serde_json::to_vec(&serde_json::json!({"signal":signal,"preparation":preparation}))
        .map_err(|_| refused())?;
    if body.len() > 65536 {
        return Err(refused());
    }
    let mut control = [0u64; 8];
    let mut io = libc::iovec {
        iov_base: body.as_ptr().cast_mut().cast(),
        iov_len: body.len(),
    };
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut io;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(4) } as _;
    let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
    if header.is_null() {
        return Err(refused());
    }
    unsafe {
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(4) as _;
        std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<i32>(), pgdata.as_raw_fd());
    }
    let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, libc::MSG_NOSIGNAL) };
    if sent <= 0 || sent as usize > body.len() {
        return Err(refused());
    }
    stream
        .write_all(&body[sent as usize..])
        .map_err(|_| refused())?;
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
    let report: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if !pool::validate("PoolStorageReadReport", &report) {
        return Err(refused());
    }
    for key in [
        "qualification_run_id",
        "qualification_scope_sha256",
        "preparation_sha256",
        "nonce",
        "database_id",
        "source_generation",
        "node_uid",
        "boot_id",
        "pool_pod_uid",
        "postgres_image_sha256",
    ] {
        if report[key] != signal[key] {
            return Err(refused());
        }
    }
    if report["device_major"] != libc::major(meta.dev())
        || report["device_minor"] != libc::minor(meta.dev())
    {
        return Err(refused());
    }
    container.process.recheck()?;
    Ok(report)
}
