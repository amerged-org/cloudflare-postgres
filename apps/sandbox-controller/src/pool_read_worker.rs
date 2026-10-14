// SPDX-License-Identifier: Apache-2.0
//! Single-thread, signed prewake readonly inspector. No resume, attach, initdb or replay operation.
use crate::{
    pool_device::{Backend, Device},
    pool_gate::{GateRoot, ROOT, Record},
    pool_permission,
    slot::Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_readonly_worker_unconfirmed")
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u8,
    pub settings: Settings,
    pub request: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub v: u8,
    pub report: Value,
    pub device: u64,
    pub thin_id: u32,
    pub device_uuid: String,
    pub creation_descriptors_closed: bool,
    pub dm_open_count: u32,
}
pub fn payload(path: &Path) -> Result<Request, Status> {
    let value: Request = crate::pool_worker::private_payload(path)?;
    if value.v != 1
        || !value.settings.postgres_pool
        || !pgcf_native_protocol::pool::validate("PoolStorageReadRequest", &value.request)
    {
        return Err(refused());
    }
    Ok(value)
}
pub fn read(request: Request) -> Result<Observation, Status> {
    if unsafe { libc::geteuid() } != 0
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
    let keys = pool_permission::keys(config)?;
    let signal = &request.request["signal"];
    let preparation = &request.request["preparation"];
    let claims = crate::pool_readonly::validate(signal, preparation, local, &keys)?;
    if crate::policy::digest(Path::new("/proc/self/exe"))?
        != text(&claims["execution"], "host_controller_sha256")?
    {
        return Err(refused());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| refused())?;
    let containers = runtime.block_on(crate::pool_custody::running(&request.settings))?;
    let driver = runtime.block_on(crate::pool_driver::verify(
        &request.settings,
        text(&claims["execution"], "driver_image")?,
        text(&claims["execution"], "driver_sha256")?,
    ))?;
    drop(runtime);
    if driver.pod_uid != text(&claims["execution"], "driver_pod_uid")? {
        return Err(refused());
    }
    let actual = containers
        .iter()
        .filter(|c| c.pod_uid == signal["pool_pod_uid"])
        .collect::<Vec<_>>();
    if actual.len() != 2
        || actual.iter().any(|c| {
            signal["container_ids"]
                .as_array()
                .is_none_or(|ids| !ids.iter().any(|id| id == &c.process.container_id))
        })
    {
        return Err(refused());
    }
    let main = actual
        .iter()
        .find(|c| c.role == "postgres")
        .ok_or_else(refused)?;
    let s = &signal["storage"];
    let thin_id = s["thin_id"]
        .as_u64()
        .ok_or_else(refused)?
        .try_into()
        .map_err(|_| refused())?;
    let d = Device::verify(
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        text(s, "volume_handle")?,
        Backend::Thin {
            pool_uuid: text(&s["profile"], "pool_uuid")?.to_owned(),
            thin_id,
        },
    )
    .map_err(|_| refused())?;
    d.zero().map_err(|_| refused())?;
    let record = Record::new(
        text(s, "volume_handle")?,
        text(signal, "qualification_scope_sha256")?,
        d.uuid(),
    )?;
    let gate = GateRoot::open(Path::new(ROOT))?;
    let mut locked = gate.lock(&record.volume_handle)?;
    locked.claim(&record)?;
    driver.recheck()?;
    crate::pool_readonly::validate(signal, preparation, local, &keys)?;
    let tree =
        crate::pool_mount::Ext4ReadOnly::exclusive_noload(d.descriptor()).map_err(|_| refused())?;
    let pgdata = tree.pgdata().map_err(|_| refused())?;
    let result = crate::pool_readonly::inspect(main, signal, preparation, local, &keys, &pgdata);
    drop(pgdata);
    drop(tree);
    // An IPC timeout never means that the receiver or pg_controldata has closed its own references.
    let zero = d
        .zero()
        .map_err(|_| Status::failed_precondition("pool_readonly_cleanup_pending"))?;
    if !zero.still_zero().map_err(|_| refused())? {
        return Err(refused());
    }
    let report = result?;
    if report["state"] != "read" {
        return Err(refused());
    }
    Ok(Observation {
        v: 1,
        report,
        device: d.device(),
        thin_id,
        device_uuid: d.uuid().to_owned(),
        creation_descriptors_closed: true,
        dm_open_count: d.open_count().map_err(|_| refused())?,
    })
}
