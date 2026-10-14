// SPDX-License-Identifier: Apache-2.0
//! The existing pq1 host challenge authorizes one fixed, read-only control inspection.
use crate::{
    Error, data, now,
    protocol::{number, text},
    runtime::Identity,
};
use pgcf_native_protocol::{pool, qualification};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    os::fd::{AsRawFd, OwnedFd},
};

pub fn inspect(
    identity: &Identity,
    keys: &HashMap<String, Vec<u8>>,
    keys_sha256: &str,
    request: Value,
    descriptor: OwnedFd,
) -> Result<Value, Error> {
    if !pool::validate("PoolStorageReadRequest", &request) {
        return Err(Error("pool_inspection_request_invalid"));
    }
    let signal = &request["signal"];
    let preparation = &request["preparation"];
    let claims =
        qualification::verify_qualification_permission(text(signal, "permission")?, keys, now())
            .ok_or(Error("pool_inspection_permission_refused"))?;
    let scope = &claims["scope"];
    let challenge = &claims["challenge"];
    let software = &scope["software"];
    let policy = &preparation["policy"];
    let volume = &scope["volume"];
    let storage = &signal["storage"];
    let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|_| Error("pool_inspection_boot_unavailable"))?;
    if challenge["gate"] != "host_mount_context"
        || challenge["nonce"] != signal["nonce"]
        || claims["preparation_sha256"].is_null()
        || claims["preparation_sha256"] != signal["preparation_sha256"]
        || pool::preparation_hash(preparation).as_deref() != signal["preparation_sha256"].as_str()
        || scope["run_id"] != signal["qualification_run_id"]
        || claims["scope_sha256"] != signal["qualification_scope_sha256"]
        || scope["database_id"] != signal["database_id"]
        || number(signal, "source_generation")?.checked_add(1)
            != scope["database_generation"].as_u64()
        || scope["configuration_fingerprint"] != signal["configuration_fingerprint"]
        || scope["node_uid"] != signal["node_uid"]
        || text(signal, "node_uid")? != identity.node
        || scope["boot_id"] != signal["boot_id"]
        || text(signal, "boot_id")? != boot.trim()
        || scope["node_id"] != preparation["node_id"]
        || scope["candidate_release_id"] != policy["release_id"]
        || text(signal, "pool_pod_uid")? != identity.pod
        || text(signal, "supervisor_sha256")? != identity.executable
        || software["supervisor_sha256"] != signal["supervisor_sha256"]
        || text(signal, "postgres_image_sha256")? != identity.image
        || software["postgres_image"]
            .as_str()
            .and_then(|s| s.split_once("@sha256:").map(|(_, hash)| hash))
            != signal["postgres_image_sha256"].as_str()
        || claims["execution"]["verifier_keys_sha256"] != keys_sha256
        || number(signal, "issued_at")? > now() + 5000
        || number(signal, "issued_at")? < number(&claims, "iat")?
        || number(signal, "expires_at")? > number(&claims, "exp")?
        || number(signal, "expires_at")? <= now()
        || preparation["observed_at"]
            .as_u64()
            .is_none_or(|time| time > now() + 5000)
        || storage["profile"] != scope["storage"]
        || storage["thin_id"] != scope["thin_id"]
        || storage["cnpg_cluster_uid"] != volume["cluster_uid"]
    {
        return Err(Error("pool_inspection_scope_changed"));
    }
    for field in [
        "driver_image",
        "driver_sha256",
        "supervisor_image",
        "supervisor_sha256",
        "archiver_image",
    ] {
        if policy[field] != software[field] {
            return Err(Error("pool_inspection_software_changed"));
        }
    }
    for field in [
        "storage_generation",
        "storage_uid",
        "namespace_uid",
        "pvc_uid",
        "pv_uid",
        "volume_handle",
        "volume_group_uuid",
        "lv_uuid",
    ] {
        if storage[field] != volume[field] {
            return Err(Error("pool_inspection_storage_changed"));
        }
    }
    let pod = preparation["pods"]
        .as_array()
        .and_then(|pods| pods.iter().find(|p| p["pod_uid"] == signal["pool_pod_uid"]))
        .ok_or(Error("pool_inspection_pod_unavailable"))?;
    if text(pod, "pod_ip")? != identity.ip {
        return Err(Error("pool_inspection_pod_changed"));
    }
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(descriptor.as_raw_fd(), &mut metadata) } != 0 {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let device_major = libc::major(metadata.st_dev);
    let device_minor = libc::minor(metadata.st_dev);
    // This call consumes/closes every directory and child descriptor before any acknowledgement.
    let measured = data::readonly_control(descriptor);
    if number(&claims, "exp")? <= now() || number(signal, "expires_at")? <= now() {
        return Err(Error("pool_inspection_deadline_elapsed"));
    }
    let mut report = json!({"v":1,"command":"inspect_readonly","device_major":device_major,"device_minor":device_minor,"state":"failed","system_identifier":null,"timeline":null,"control_state":null,"observed_at":now(),"error":null});
    for field in [
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
        report[field] = signal[field].clone();
    }
    match measured {
        Ok(control) => {
            report["state"] = json!("read");
            report["system_identifier"] = json!(control.system_identifier);
            report["timeline"] = json!(control.timeline);
            report["control_state"] = json!(control.control_state);
        }
        Err(error) => {
            report["error"] = json!(error.0);
        }
    }
    if !pool::validate("PoolStorageReadReport", &report) {
        return Err(Error("pool_inspection_report_invalid"));
    }
    Ok(report)
}
