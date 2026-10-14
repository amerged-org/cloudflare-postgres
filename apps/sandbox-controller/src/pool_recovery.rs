// SPDX-License-Identifier: Apache-2.0
//! No-write reboot recovery. Historical permissions never authorize resume or filesystem creation.
use crate::{
    policy::Client,
    pool_gate::{GateRoot, ROOT},
    pool_journal::{Journal, Phase, State},
    slot::Settings,
};
use pgcf_native_protocol::pool;
use serde_json::{Value, json};
use std::path::Path;
use tonic::Status;

fn refused() -> Status {
    Status::failed_precondition("pool_recovery_unconfirmed")
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Status> {
    value[key].as_str().ok_or_else(refused)
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn scoped_details(state: &State, details: &Value) -> Result<(), Status> {
    let binding = &details["binding"]["binding"];
    if state.scope.as_ref() != Some(&binding["scope"])
        || binding["scope_sha256"] != state.record.scope_sha256
        || !pool::binding_valid(binding)
    {
        return Err(refused());
    }
    Ok(())
}
fn zero(scope: &Value) -> Result<crate::pool_device::ZeroDevice, Status> {
    let s = &scope["storage"];
    crate::pool_device::zero_thin(
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        text(s, "volume_handle")?,
        text(&s["profile"], "pool_uuid")?,
        s["thin_id"]
            .as_u64()
            .ok_or_else(refused)?
            .try_into()
            .map_err(|_| refused())?,
    )
    .map_err(|_| refused())
}
fn report(
    state: &State,
    boot: &str,
    device: &crate::pool_device::ThinMetadata,
    survey: &crate::pool_namespaces::Survey,
    driver: &crate::pool_driver::Driver,
    released: bool,
) -> Result<Value, Status> {
    let scope = state.scope.as_ref().ok_or_else(refused)?;
    let s = &scope["storage"];
    if state.boot_id == boot || !survey.named_namespace_scan_complete {
        return Err(refused());
    }
    let mut value = json!({
        "v":1,"binding_id":state.binding_id,"scope_sha256":state.record.scope_sha256,
        "node_uid":state.node_uid,"boot_id":boot,"pool_pod_uid":state.pool_pod_uid,
        "state":if released {"released"} else {"lost"},"observed_at":now(),
        "storage_backend":"lvm-thin-v1","thin_guard":null,"clean_stop":false,
        "error":if released {Value::Null} else {json!("pool_boot_loss_cleanup_pending")},
        "kernel_proof":{
            "device_major":libc::major(device.device),"device_minor":libc::minor(device.device),
            "mount_id":null,"dm_open_count":device.open_count,"foreign_mounts":survey.aliases.len(),
            "complete_namespace_scan":false,"named_namespace_scan_complete":survey.named_namespace_scan_complete,
            "zero_before_bind":false,"exclusive_superblock_creation":false,
            "nonlazy_unmount_verified":false,"never_attached_verified":false,
            "creator_fence":{"v":1,"scope_sha256":state.record.scope_sha256,
                "storage_uid":s["storage_uid"],"volume_handle":s["volume_handle"],
                "volume_group_uuid":s["volume_group_uuid"],"lv_uuid":s["lv_uuid"],
                "driver_gate_protocol":1,"driver_image":scope["driver_image"],
                "driver_sha256":driver.executable_sha256,"deny_record_durable":true,
                "csi_node_publish_serialized":true,"csi_node_expand_serialized":true,
                "creation_fds_closed":true},"mountpoint":null
        }
    });
    if released {
        value["boot_loss"] = json!({"holder_boot_id":state.boot_id,"storage":s});
    }
    if !pool::node_report_valid(&value) {
        return Err(refused());
    }
    Ok(value)
}

/// Every attempt reads retained Cloudflare details. Snapshot omission is never release authority.
pub async fn reconcile(settings: &Settings, client: &Client) -> Result<(), Status> {
    let boot = crate::storage::current_boot_id()?;
    let root = GateRoot::open(Path::new(ROOT))?;
    let mut count = 0;
    for entry in std::fs::read_dir(ROOT).map_err(|_| refused())? {
        let entry = entry.map_err(|_| refused())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.len() != 70
            || !name.ends_with(".state")
            || !name[..64]
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            continue;
        }
        count += 1;
        if count > 2000 {
            return Err(refused());
        }
        let journal = Journal::open(&entry.path())?;
        let Some(mut state) = journal.read()? else {
            continue;
        };
        if state.node_uid != client.local().node_uid {
            return Err(refused());
        }
        if state.boot_id == boot && state.terminal_report.is_none() {
            continue;
        }
        let details = client.pool_binding_details(&state.binding_id).await?;
        scoped_details(&state, &details)?;
        // A lost POST response can be acknowledged from exact retained history before retrying.
        if state.terminal_report.is_some() {
            match state.acknowledge(&details) {
                Ok(acked) => {
                    journal.store(&acked)?;
                    state = acked;
                }
                Err(_) if state.terminal_acknowledged => return Err(refused()),
                Err(_) => {}
            }
        }
        let mut locked = root.lock(&state.record.volume_handle)?;
        // A crash between durable deny removal and state retirement must not recreate denial.
        if locked.publish_allowed()? {
            if !state.terminal_acknowledged {
                return Err(refused());
            }
            journal.retire_acknowledged()?;
            continue;
        }
        if !root.record_matches(&state.record)? {
            return Err(refused());
        }
        let scope = state.scope.as_ref().ok_or_else(refused)?;
        let s = &scope["storage"];
        let driver = crate::pool_driver::verify(
            settings,
            text(scope, "driver_image")?,
            text(scope, "driver_sha256")?,
        )
        .await?;
        let actual = crate::pool_device::thin_metadata(
            text(s, "volume_group_uuid")?,
            text(s, "lv_uuid")?,
            text(s, "volume_handle")?,
            text(&s["profile"], "pool_uuid")?,
        )
        .map_err(|_| refused())?;
        if u64::from(actual.thin_id) != s["thin_id"].as_u64().ok_or_else(refused)? {
            return Err(refused());
        }
        let survey = crate::pool_inspector::inspect(
            &state.record,
            text(s, "volume_group_uuid")?,
            text(s, "lv_uuid")?,
            actual.device,
            crate::pool_device::Backend::Thin {
                pool_uuid: text(&s["profile"], "pool_uuid")?.to_owned(),
                thin_id: actual.thin_id,
            },
        )?;
        driver.recheck()?;
        if actual.open_count != 0 || !survey.aliases.is_empty() {
            if !state.terminal_acknowledged
                && state.boot_id != boot
                && !matches!(
                    details["binding"]["binding"]["state"].as_str(),
                    Some("lost" | "released" | "refused")
                )
            {
                client
                    .report_pool(
                        "PoolNodeReport",
                        &report(&state, &boot, &actual, &survey, &driver, false)?,
                    )
                    .await?;
            }
            continue;
        }
        let physical_zero = zero(scope)?;
        if state.terminal_acknowledged {
            locked.release_zero(&state.record, &physical_zero)?;
            journal.retire_acknowledged()?;
            continue;
        }
        if matches!(
            details["binding"]["binding"]["state"].as_str(),
            Some("released" | "refused")
        ) {
            // A different terminal report can never be adopted by local recovery.
            return Err(refused());
        }
        if state.phase == Phase::Mounted {
            state = state.dispatch_detach()?;
            journal.store(&state)?;
        }
        state = state.detached(&physical_zero)?;
        journal.store(&state)?;
        let fresh = state.terminal_report.as_ref().is_some_and(|r| {
            r["boot_id"] == boot
                && r["observed_at"].as_u64().is_some_and(|at| {
                    now().saturating_sub(at)
                        < pool::constant("observation_max_age_ms")
                            .as_u64()
                            .unwrap_or(0)
                })
        });
        if !fresh {
            // A nonterminal GET does not fence an in-flight prior POST. Retain every actual
            // submitted proof so a delayed Cloudflare commit can acknowledge any one of them.
            state = state.terminal(report(&state, &boot, &actual, &survey, &driver, true)?)?;
            journal.store(&state)?;
        }
        client
            .report_pool(
                "PoolNodeReport",
                state.terminal_report.as_ref().ok_or_else(refused)?,
            )
            .await?;
        let acknowledged =
            state.acknowledge(&client.pool_binding_details(&state.binding_id).await?)?;
        journal.store(&acknowledged)?;
        driver.recheck()?;
        locked.release_zero(&state.record, &physical_zero)?;
        journal.retire_acknowledged()?;
    }
    Ok(())
}
