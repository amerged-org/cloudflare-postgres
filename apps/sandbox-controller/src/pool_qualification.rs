// SPDX-License-Identifier: Apache-2.0
//! One CF-signed finite action/report. The node never invents Kubernetes sleep facts.
use crate::{policy::Client, pool_permission, slot::Settings};
use pgcf_native_protocol::{pool, qualification};
use serde_json::{Value, json};
use std::path::Path;
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_qualification_execution_unconfirmed")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
fn storage(scope: &Value) -> Value {
    let mut s = scope["volume"].clone();
    if let Some(o) = s.as_object_mut() {
        o.remove("node_uid");
        o.remove("pool_uuid");
        o.remove("profile_sha256");
        if let Some(cluster) = o.remove("cluster_uid") {
            o.insert("cnpg_cluster_uid".into(), cluster);
        }
    }
    s["backend"] = "lvm-thin-v1".into();
    s["thin_id"] = scope["thin_id"].clone();
    s["profile"] = scope["storage"].clone();
    s
}
pub fn claims(input: &Value, client: &Client) -> Result<Value, Status> {
    if !qualification::validate("PostgresPoolQualificationInput", input) {
        return Err(refused());
    }
    let config = client
        .local()
        .storage_authority
        .as_ref()
        .ok_or_else(refused)?;
    let keys = pool_permission::keys(config)?;
    let claims =
        qualification::verify_qualification_permission(text(input, "permission")?, &keys, now())
            .ok_or_else(refused)?;
    if claims["scope"] != input["scope"]
        || claims["scope_sha256"] != input["scope_sha256"]
        || claims["challenge"] != input["challenge"]
        || claims["scope"]["node_id"] != client.local().node_id
        || claims["scope"]["node_uid"] != client.local().node_uid
        || claims["scope"]["region_id"] != client.local().region_id
        || claims["execution"]["boot_id"] != crate::storage::current_boot_id()?
        || claims["execution"]["verifier_keys_sha256"] != config.sha256
        || crate::policy::digest(Path::new("/proc/self/exe"))?
            != claims["execution"]["host_controller_sha256"]
                .as_str()
                .ok_or_else(refused)?
    {
        return Err(refused());
    }
    Ok(claims)
}
async fn read_once(
    settings: &Settings,
    request: &Value,
) -> Result<crate::pool_read_worker::Observation, Status> {
    let payload = crate::pool_runtime::Payload::create(&crate::pool_read_worker::Request {
        v: 1,
        settings: settings.clone(),
        request: request.clone(),
    })?;
    let remaining = request["signal"]["expires_at"]
        .as_u64()
        .ok_or_else(refused)?
        .saturating_sub(now());
    let bytes = crate::pool_child::execute(
        crate::pool_child::Kind::Read,
        payload,
        std::time::Instant::now() + std::time::Duration::from_millis(remaining),
        131072,
    )
    .await?;
    let result = serde_json::from_slice::<crate::pool_read_worker::Observation>(&bytes)
        .map_err(|_| refused())?;
    Ok(result)
}
pub async fn host_context(
    settings: &Settings,
    client: &Client,
    input: &Value,
    preparation: &Value,
) -> Result<Value, Status> {
    let grant = claims(input, client)?;
    let scope = &grant["scope"];
    let challenge = &grant["challenge"];
    if challenge["gate"] != "host_mount_context"
        || challenge["producer"] != "node"
        || grant["preparation_sha256"].is_null()
        || !crate::pool_inventory::context_valid(preparation, client.local())
        || pool::preparation_hash(preparation).as_deref() != grant["preparation_sha256"].as_str()
    {
        return Err(refused());
    }
    let pod = preparation["pods"]
        .as_array()
        .ok_or_else(refused)?
        .first()
        .ok_or_else(refused)?;
    let physical = storage(scope);
    if !pool::validate("PoolThinPhysicalStorage", &physical) {
        return Err(refused());
    }
    let issued = now();
    let end = grant["exp"]
        .as_u64()
        .ok_or_else(refused)?
        .min(preparation["expires_at"].as_u64().ok_or_else(refused)?);
    let signal = json!({"v":1,"command":"inspect_readonly","permission":input["permission"],"qualification_run_id":scope["run_id"],"qualification_scope_sha256":grant["scope_sha256"],"preparation_sha256":grant["preparation_sha256"],"nonce":challenge["nonce"],"database_id":scope["database_id"],"source_generation":scope["database_generation"].as_u64().and_then(|n|n.checked_sub(1)).ok_or_else(refused)?,"configuration_fingerprint":scope["configuration_fingerprint"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"storage":physical,"pool_namespace":"pgcf-pool","pool_namespace_uid":preparation["pool_namespace_uid"],"pool_pod_uid":pod["pod_uid"],"container_ids":pod["container_ids"],"postgres_image_sha256":preparation["policy"]["class"]["postgres_image_sha256"],"supervisor_sha256":scope["software"]["supervisor_sha256"],"issued_at":issued,"expires_at":end,"readonly":true,"noload":true});
    let request = json!({"signal":signal,"preparation":preparation});
    if !pool::validate("PoolStorageReadRequest", &request) {
        return Err(refused());
    }
    let context = crate::pool_inspector::context()?;
    let result = read_once(settings, &request).await?;
    if result.v != 1
        || !result.creation_descriptors_closed
        || result.dm_open_count != 0
        || result.report["state"] != "read"
        || result.report["nonce"] != challenge["nonce"]
    {
        return Err(refused());
    }
    let s = &request["signal"]["storage"];
    let zero = crate::pool_device::zero_thin(
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        text(s, "volume_handle")?,
        text(&s["profile"], "pool_uuid")?,
        result.thin_id,
    )
    .map_err(|_| refused())?;
    if result.device_uuid != zero.uuid || result.device != zero.device {
        return Err(refused());
    }
    let record = crate::pool_gate::Record::new(
        text(s, "volume_handle")?,
        text(&grant, "scope_sha256")?,
        &result.device_uuid,
    )?;
    let survey = crate::pool_inspector::inspect(
        &record,
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        result.device,
        crate::pool_device::Backend::Thin {
            pool_uuid: text(&s["profile"], "pool_uuid")?.to_owned(),
            thin_id: result.thin_id,
        },
    )?;
    if !survey.aliases.is_empty() || !zero.still_zero().map_err(|_| refused())? {
        return Err(refused());
    }
    let observation = json!({"v":1,"database_id":scope["database_id"],"generation":request["signal"]["source_generation"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"storage":s,"kernel_proof":{"device_major":libc::major(result.device),"device_minor":libc::minor(result.device),"mount_id":null,"dm_open_count":0,"foreign_mounts":0,"complete_namespace_scan":false,"named_namespace_scan_complete":survey.named_namespace_scan_complete,"zero_before_bind":true,"exclusive_superblock_creation":true,"nonlazy_unmount_verified":false,"never_attached_verified":true,"creator_fence":null,"mountpoint":null},"observed_at":now()});
    if !pool::validate("PoolStorageObservation", &observation) {
        return Err(refused());
    }
    client.report_pool_storage(&observation).await?;
    let mut read = result.report;
    let nonce = read
        .as_object_mut()
        .ok_or_else(refused)?
        .remove("nonce")
        .ok_or_else(refused)?;
    read["nonce_sha256"] =
        crate::pool_gate::digest(nonce.as_str().ok_or_else(refused)?.as_bytes()).into();
    let mut measurement = serde_json::to_value(context).map_err(|_| refused())?;
    measurement["gate"] = "host_mount_context".into();
    measurement["storage_read"] = read;
    measurement["storage_observation"] = observation;
    if !qualification::validate("PostgresPoolQualificationMeasurement", &measurement) {
        return Err(refused());
    }
    claims(input, client)?;
    Ok(
        json!({"run_id":scope["run_id"],"scope_sha256":grant["scope_sha256"],"sequence":challenge["sequence"],"nonce":challenge["nonce"],"producer":"node","node_uid":grant["execution"]["node_uid"],"boot_id":grant["execution"]["boot_id"],"candidate_spec_sha256":grant["execution"]["candidate_spec_sha256"],"started_at":issued,"observed_at":now(),"measurement":measurement}),
    )
}
