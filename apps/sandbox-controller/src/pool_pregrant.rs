// SPDX-License-Identifier: Apache-2.0
//! PB1 changes only actual tenant-free cgroup limits. It never resumes or mounts a device.
use crate::{
    pool_io::{Process, SharedBudget},
    pool_permission::Permission,
};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_pregrant_io_unconfirmed")
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
fn num(v: &Value, k: &str) -> Result<u64, Status> {
    v[k].as_u64().ok_or_else(refused)
}
pub fn measure(permission: &Permission, processes: &[Process]) -> Result<Value, Status> {
    let scope = permission.scope();
    let storage = &scope["storage"];
    let profile = &storage["profile"];
    if !permission.current() {
        return Err(refused());
    }
    let expected = scope["container_ids"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(|v| v.as_str().ok_or_else(refused))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if processes.len() != expected.len()
        || processes
            .iter()
            .map(|p| p.container_id.as_str())
            .collect::<BTreeSet<_>>()
            != expected
    {
        return Err(refused());
    }
    let actual = crate::pool_device::thin_metadata(
        text(storage, "volume_group_uuid")?,
        text(storage, "lv_uuid")?,
        text(storage, "volume_handle")?,
        text(profile, "pool_uuid")?,
    )
    .map_err(|_| refused())?;
    if u64::from(actual.thin_id) != num(storage, "thin_id")? || actual.open_count != 0 {
        return Err(refused());
    }
    let bps = num(profile, "write_bytes_per_second")?;
    let iops = num(profile, "write_iops_per_second")?;
    let shared = SharedBudget::capture(processes)?;
    shared.set_io(actual.device, bps, iops)?;
    for p in processes {
        p.set_io(actual.device, bps, iops)?
    }
    let host_pids = crate::pool_io::host_pids(processes)?;
    let cgroups=processes.iter().map(|p|Ok(json!({"container_id":p.container_id,"cgroup_inode":p.cgroup_inode,"pid":host_pids.get(&p.pid).ok_or_else(refused)?,"start_ticks":p.start_ticks,"pid_namespace":p.pid_namespace.inode,"device_major":libc::major(actual.device),"device_minor":libc::minor(actual.device),"write_bytes_per_second":bps,"write_iops_per_second":iops,"io_max_verified":true}))).collect::<Result<Vec<_>,Status>>()?;
    let value = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":permission.scope_sha256(),"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"pool_namespace_uid":scope["pool_namespace_uid"],"pool_pod_uid":scope["pool_pod_uid"],"observed_at":u64::try_from(crate::policy::now_ms()).map_err(|_|refused())?,"device":{"volume_group_uuid":storage["volume_group_uuid"],"lv_uuid":storage["lv_uuid"],"thin_id":actual.thin_id,"device_major":libc::major(actual.device),"device_minor":libc::minor(actual.device)},"shared_pod_io":{"pod_cgroup_inode":shared.pod_cgroup_inode,"device_major":libc::major(actual.device),"device_minor":libc::minor(actual.device),"write_bytes_per_second":bps,"write_iops_per_second":iops,"io_max_verified":true,"all_writer_cgroups_descendants":true},"cgroups":cgroups});
    if !permission.current()
        || !pgcf_native_protocol::pool::validate("PoolIoAttestation", &value)
        || !shared.io_matches(actual.device, bps, iops)?
    {
        return Err(refused());
    }
    for p in processes {
        p.recheck()?;
        if !p.io_matches(actual.device, bps, iops)? {
            return Err(refused());
        }
    }
    Ok(value)
}
