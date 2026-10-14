// SPDX-License-Identifier: Apache-2.0
//! Authenticate the CF-accepted prewake prefix before adopting its retained deny record.
use super::{Record, refused};
use pgcf_native_protocol::{pool, qualification};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use tonic::Status;

pub(super) struct Evidence {
    pub previous: Record,
    pub inode: u64,
    pub record_sha256: String,
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Status> {
    value[key].as_str().ok_or_else(refused)
}
fn same(a: &Value, b: &Value, keys: &[&str]) -> bool {
    keys.iter()
        .all(|key| !a[*key].is_null() && a[*key] == b[*key])
}
fn image_digest(image: &Value) -> Option<&str> {
    image
        .as_str()?
        .split_once("@sha256:")
        .map(|(_, digest)| digest)
}
fn same_containers(a: &Value, b: &Value) -> bool {
    let set = |value: &Value| -> Option<BTreeSet<String>> {
        value
            .as_array()?
            .iter()
            .map(|id| id.as_str().map(str::to_owned))
            .collect()
    };
    set(a).zip(set(b)).is_some_and(|(a, b)| a == b)
}
pub(super) fn accepted(
    next: &Record,
    desired: &Value,
    input: &Value,
    preparation: &Value,
    keys: &HashMap<String, Vec<u8>>,
    now: u64,
) -> Result<Evidence, Status> {
    if !pool::validate("DesiredPoolBinding", desired)
        || !pool::binding_valid(&desired["binding"])
        || !qualification::validate("PostgresPoolQualificationInput", input)
        || !pool::validate("PoolPodPreparationContext", preparation)
        || desired["authority"] != "current"
        || desired["binding"]["state"] != "claimed"
        || input["status"] != "running"
        || input["expires_at"].as_u64().is_none_or(|end| end <= now)
    {
        return Err(refused());
    }
    let bind =
        pool::verify_permission(text(desired, "permission")?, keys, now).ok_or_else(refused)?;
    let grant =
        qualification::verify_qualification_permission(text(input, "permission")?, keys, now)
            .ok_or_else(refused)?;
    let scope = &bind["scope"];
    let source = &grant["scope"];
    let challenge = &grant["challenge"];
    if scope != &desired["binding"]["scope"]
        || bind["scope_sha256"] != desired["binding"]["scope_sha256"]
        || bind["holder_revision"] != desired["binding"]["holder_revision"]
        || grant["scope"] != input["scope"]
        || grant["scope_sha256"] != input["scope_sha256"]
        || challenge != &input["challenge"]
        || challenge["gate"] != "single_writer"
        || challenge["sequence"] != 3
        || qualification::progress_hash(&input["pending_progress"]).as_deref()
            != grant["progress_sha256"].as_str()
        || pool::preparation_hash(preparation).as_deref() != grant["preparation_sha256"].as_str()
        || preparation["qualification_run_id"] != source["run_id"]
        || preparation["qualification_scope_sha256"] != grant["scope_sha256"]
        || preparation["expires_at"]
            .as_u64()
            .is_none_or(|end| end <= now)
        || preparation["observed_at"]
            .as_u64()
            .is_none_or(|at| at > now.saturating_add(5000))
        || !same(
            scope,
            source,
            &[
                "database_id",
                "configuration_fingerprint",
                "region_id",
                "node_id",
                "node_uid",
                "boot_id",
            ],
        )
        || scope["generation"] != source["database_generation"]
        || !same(
            preparation,
            scope,
            &[
                "node_id",
                "node_uid",
                "boot_id",
                "pool_namespace",
                "pool_namespace_uid",
            ],
        )
        || scope["storage"]["backend"] != "lvm-thin-v1"
        || scope["storage"]["profile"] != source["storage"]
        || scope["storage"]["thin_id"] != source["thin_id"]
        || scope["storage"]["cnpg_cluster_uid"] != source["volume"]["cluster_uid"]
        || !same(
            &scope["storage"],
            &source["volume"],
            &[
                "storage_generation",
                "storage_uid",
                "namespace_uid",
                "pvc_uid",
                "pv_uid",
                "volume_handle",
                "volume_group_uuid",
                "lv_uuid",
            ],
        )
        || !same(
            scope,
            &source["software"],
            &[
                "driver_image",
                "driver_sha256",
                "supervisor_sha256",
                "host_controller_sha256",
            ],
        )
        || preparation["policy"]["release_id"] != source["candidate_release_id"]
        || preparation["policy"]["class"] != scope["class"]
        || !same(
            &preparation["policy"],
            &source["software"],
            &[
                "driver_image",
                "driver_sha256",
                "supervisor_image",
                "supervisor_sha256",
                "host_controller_sha256",
                "archiver_image",
            ],
        )
        || image_digest(&source["software"]["postgres_image"])
            != scope["class"]["postgres_image_sha256"].as_str()
    {
        return Err(refused());
    }
    let pod = preparation["pods"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .find(|pod| pod["pod_uid"] == scope["pool_pod_uid"])
        .ok_or_else(refused)?;
    if pod["pod_name"] != scope["pool_pod_name"]
        || pod["pod_ip"] != scope["pool_pod_ip"]
        || !same_containers(&pod["container_ids"], &scope["container_ids"])
    {
        return Err(refused());
    }
    let evidence = input["accepted_evidence"].as_array().ok_or_else(refused)?;
    if evidence.len() != 2
        || evidence[0]["sequence"] != 1
        || evidence[1]["sequence"] != 2
        || evidence
            .iter()
            .any(|entry| entry["producer"] != "node_agent")
    {
        return Err(refused());
    }
    let host = &evidence[0]["measurement"];
    let finite = &evidence[1]["measurement"];
    let execution_keys = [
        "node_uid",
        "boot_id",
        "candidate_release_id",
        "candidate_spec_sha256",
        "verifier_keys_sha256",
        "driver_image",
        "driver_sha256",
        "host_extension_image",
        "host_controller_sha256",
        "kernel_version",
    ];
    let read = &host["storage_read"];
    let physical = &host["storage_observation"];
    let source_generation = source["database_generation"]
        .as_u64()
        .and_then(|n| n.checked_sub(1));
    if host["gate"] != "host_mount_context"
        || finite["gate"] != "finite_creator_fence"
        || !same(
            &evidence[0]["execution"],
            &grant["execution"],
            &execution_keys,
        )
        || !same(
            &evidence[1]["execution"],
            &grant["execution"],
            &execution_keys,
        )
        || host["kernel_version"] != source["software"]["kernel_version"]
        || read["state"] != "read"
        || read["control_state"] != "shut down"
        || read["qualification_run_id"] != source["run_id"]
        || read["qualification_scope_sha256"] != grant["scope_sha256"]
        || read["source_generation"].as_u64() != source_generation
        || !same(
            read,
            scope,
            &[
                "database_id",
                "node_uid",
                "boot_id",
                "pool_pod_uid",
                "system_identifier",
                "timeline",
            ],
        )
        || read["postgres_image_sha256"] != scope["class"]["postgres_image_sha256"]
        || physical["storage"] != scope["storage"]
        || physical["generation"].as_u64() != source_generation
        || !same(physical, scope, &["database_id", "node_uid", "boot_id"])
        || physical["kernel_proof"]["dm_open_count"] != 0
        || physical["kernel_proof"]["foreign_mounts"] != 0
        || physical["kernel_proof"]["named_namespace_scan_complete"] != true
        || !physical["kernel_proof"]["mount_id"].is_null()
        || finite["source_generation"].as_u64() != source_generation
        || finite["deny_record_scope_sha256"] != grant["scope_sha256"]
        || finite["volume_handle"] != scope["storage"]["volume_handle"]
        || !same(finite, scope, &["driver_image", "driver_sha256"])
        || !finite["binding_id"].is_null()
        || finite["driver_pod_uid_before_restart"] != evidence[0]["execution"]["driver_pod_uid"]
        || finite["driver_pod_uid_after_restart"] != grant["execution"]["driver_pod_uid"]
        || finite["driver_pod_uid_after_restart"] != evidence[1]["execution"]["driver_pod_uid"]
        || finite["driver_pod_uid_before_restart"] == finite["driver_pod_uid_after_restart"]
        || finite["deny_record_inode_before_restart"] != finite["deny_record_inode_after_restart"]
        || finite["deny_record_sha256_before_restart"] != finite["deny_record_sha256_after_restart"]
        || finite["deny_record_fsync_errno"] != 0
        || finite["agent_owner_deaths"].as_u64().is_none_or(|n| n == 0)
        || finite["surviving_creation_descriptors"] != 0
        || finite["final_dm_open_count"] != 0
        || finite["physical_snapshot_count"] != 0
        || !same(
            finite,
            &physical["kernel_proof"],
            &["device_major", "device_minor"],
        )
    {
        return Err(refused());
    }
    let uuid = format!(
        "LVM-{}{}",
        text(&scope["storage"], "volume_group_uuid")?.replace('-', ""),
        text(&scope["storage"], "lv_uuid")?.replace('-', "")
    );
    if next
        != &Record::new(
            text(&scope["storage"], "volume_handle")?,
            text(&bind, "scope_sha256")?,
            &uuid,
        )?
    {
        return Err(refused());
    }
    Ok(Evidence {
        previous: Record::new(&next.volume_handle, text(&grant, "scope_sha256")?, &uuid)?,
        inode: finite["deny_record_inode_after_restart"]
            .as_u64()
            .ok_or_else(refused)?,
        record_sha256: text(finite, "deny_record_sha256_after_restart")?.to_owned(),
    })
}
