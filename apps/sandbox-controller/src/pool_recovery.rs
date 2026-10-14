// SPDX-License-Identifier: Apache-2.0
//! No-write restart recovery. Historical permissions never authorize resume or filesystem creation.
use crate::{
    policy::Client,
    pool_gate::{GateRoot, ROOT},
    pool_journal::{Journal, Phase, State},
    slot::Settings,
};
use pgcf_native_protocol::pool;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
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
/// Frozen immediately after startup protection, before any new holder or worker can dispatch.
/// Later missing guard registration is never evidence that a current dispatch was lost.
pub(crate) struct Restarted {
    scopes: BTreeMap<String, String>,
}
impl Restarted {
    pub(crate) fn capture(root: &Path, node_uid: &str, boot: &str) -> Result<Self, Status> {
        GateRoot::open(root)?;
        let mut scopes = BTreeMap::new();
        let mut count = 0;
        for entry in std::fs::read_dir(root).map_err(|_| refused())? {
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
            let state = Journal::open(&entry.path())?.read()?.ok_or_else(refused)?;
            if state.node_uid != node_uid {
                return Err(refused());
            }
            if state.boot_id == boot
                && scopes
                    .insert(state.binding_id, state.record.scope_sha256)
                    .is_some()
            {
                return Err(refused());
            }
        }
        Ok(Self { scopes })
    }
    pub(crate) fn needs_observation(&self, state: &State, boot: &str) -> bool {
        state.boot_id != boot
            || state.terminal_report.is_some()
            || self.scopes.get(&state.binding_id) == Some(&state.record.scope_sha256)
    }
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
    if (released
        && state.boot_id == boot
        && state
            .cleanup
            .as_ref()
            .is_none_or(|c| !c.dispatched || !c.worker_reaped))
        || !survey.named_namespace_scan_complete
    {
        return Err(refused());
    }
    let mut value = json!({
        "v":1,"binding_id":state.binding_id,"scope_sha256":state.record.scope_sha256,
        "node_uid":state.node_uid,"boot_id":boot,"pool_pod_uid":state.pool_pod_uid,
        "state":if released {"released"} else {"lost"},"observed_at":now(),
        "storage_backend":"lvm-thin-v1","thin_guard":null,"clean_stop":false,
        "error":if released {Value::Null} else if state.boot_id == boot {json!("pool_process_restart_cleanup_pending")} else {json!("pool_boot_loss_cleanup_pending")},
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
    if released && state.boot_id != boot {
        value["boot_loss"] = json!({"holder_boot_id":state.boot_id,"storage":s});
    } else if released {
        let cleanup = state.cleanup.as_ref().ok_or_else(refused)?;
        // The journal's completed marker was fsynced only after the actual nonlazy syscall.
        value["kernel_proof"]["nonlazy_unmount_verified"] = cleanup.nonlazy_completed.into();
        value["clean_stop"] = (cleanup.nonlazy_completed
            && pool::validate("PoolSupervisorReport", &cleanup.supervisor_report)
            && cleanup.supervisor_report["state"] == "stopped"
            && cleanup.supervisor_report["control_state"] == "shut down"
            && cleanup.supervisor_report["binding_id"] == state.binding_id
            && cleanup.supervisor_report["scope_sha256"] == state.record.scope_sha256)
            .into();
    } else if state.boot_id == boot {
        // A prior sameboot worker may still be dying in a kernel operation. Durable denial
        // and driver readback do not prove its creation descriptors have closed.
        value["kernel_proof"]["creator_fence"] = Value::Null;
    }
    // The historical grant joins the unclean variant in finish_cleanup before validation.
    if !(released
        && state.boot_id == boot
        && state.cleanup.as_ref().is_some_and(|c| !c.nonlazy_completed))
        && !pool::node_report_valid(&value)
    {
        return Err(refused());
    }
    Ok(value)
}

/// Sameboot closure requires the retained parent's actual worker reap, durable dispatch, and a
/// fresh physical survey. An absent guard or a failed Stop request never enters this path.
pub(crate) async fn finish_cleanup(
    settings: &Settings,
    client: &Client,
    journal: &Journal,
    active: Option<&crate::pool_guard::Active>,
) -> Result<bool, Status> {
    let mut state = journal.read()?.ok_or_else(refused)?;
    let scope = state.scope.as_ref().ok_or_else(refused)?.clone();
    let cleanup = state.cleanup.as_ref().ok_or_else(refused)?;
    if state.boot_id != crate::storage::current_boot_id()?
        || !cleanup.dispatched
        || !cleanup.worker_reaped
    {
        return Err(refused());
    }
    let io = cleanup.io.as_ref().ok_or_else(refused)?;
    let claims = crate::pool_cleanup_permission::historical(
        &scope,
        &cleanup.holder,
        io,
        cleanup.authority.as_deref().ok_or_else(refused)?,
        client.local(),
    )?;
    let destruction = json!({"v":1,"operation_id":claims["operation_id"],"authority_revision":claims["authority_revision"],"cleanup_io_sha256":claims["cleanup_io_sha256"],
        "cleanup_mode":"drain_unmount","dispatch_persisted":true,"worker":cleanup.worker,"worker_reaped":true,"stopped_writers":io["stopped_writers"]});
    let nonlazy = cleanup.nonlazy_completed;
    let root = GateRoot::open(Path::new(ROOT))?;
    let mut locked = root.lock(&state.record.volume_handle)?;
    let details = client.pool_binding_details(&state.binding_id).await?;
    scoped_details(&state, &details)?;
    if state.terminal_report.is_some()
        && let Ok(ack) = state.acknowledge(&details)
    {
        journal.store(&ack)?;
        state = ack;
    }
    if locked.publish_allowed()? {
        if !state.terminal_acknowledged {
            return Err(refused());
        }
        if let Some(active) = active {
            active.retire_cleanup(&state, &zero(&scope)?)?;
        }
        journal.retire_acknowledged()?;
        return Ok(true);
    }
    if !root.record_matches(&state.record)? {
        return Err(refused());
    }
    let driver = crate::pool_driver::verify(
        settings,
        text(&scope, "driver_image")?,
        text(&scope, "driver_sha256")?,
    )
    .await?;
    let s = &scope["storage"];
    let actual = crate::pool_device::thin_metadata(
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        text(s, "volume_handle")?,
        text(&s["profile"], "pool_uuid")?,
    )
    .map_err(|_| refused())?;
    if actual.device != state.device
        || u64::from(actual.thin_id) != s["thin_id"].as_u64().ok_or_else(refused)?
    {
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
    if actual.open_count != 0 || !survey.aliases.is_empty() || !survey.named_namespace_scan_complete
    {
        return Ok(false);
    }
    let zero = zero(&scope)?;
    driver.recheck()?;
    if !state.terminal_acknowledged {
        if matches!(
            details["binding"]["binding"]["state"].as_str(),
            Some("released" | "refused")
        ) {
            return Err(refused());
        }
        state = state.detached(&zero)?;
        journal.store(&state)?;
        let fresh = state.terminal_report.as_ref().is_some_and(|r| {
            r["observed_at"].as_u64().is_some_and(|at| {
                now().saturating_sub(at)
                    < pool::constant("observation_max_age_ms")
                        .as_u64()
                        .unwrap_or(0)
            })
        });
        if !fresh {
            let mut value = report(&state, &state.boot_id, &actual, &survey, &driver, true)?;
            if !nonlazy {
                value["reference_destruction"] = destruction;
            }
            if !pool::node_report_valid(&value) {
                return Err(refused());
            }
            state = state.terminal(value)?;
            journal.store(&state)?;
        }
        client
            .report_pool(
                "PoolNodeReport",
                state.terminal_report.as_ref().ok_or_else(refused)?,
            )
            .await?;
        state = state.acknowledge(&client.pool_binding_details(&state.binding_id).await?)?;
        journal.store(&state)?;
    }
    driver.recheck()?;
    if let Some(active) = active {
        active.retire_cleanup(&state, &zero)?;
    }
    locked.release_zero(&state.record, &zero)?;
    journal.retire_acknowledged()?;
    Ok(true)
}

/// Every attempt reads retained Cloudflare details. Snapshot omission is never release authority.
pub(crate) async fn reconcile(
    settings: &Settings,
    client: &Client,
    restarted: &Restarted,
    owned: &std::collections::BTreeSet<String>,
) -> Result<(), Status> {
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
        if owned.contains(&state.binding_id) {
            continue;
        }
        if !restarted.needs_observation(&state, &boot) {
            continue;
        }
        if state.boot_id == boot
            && state
                .cleanup
                .as_ref()
                .is_some_and(|c| c.dispatched && c.worker_reaped)
        {
            finish_cleanup(settings, client, &journal, None).await?;
            continue;
        }
        let details = client.pool_binding_details(&state.binding_id).await?;
        scoped_details(&state, &details)?;
        let sameboot_loss = state.boot_id == boot && state.terminal_report.is_none();
        if sameboot_loss && details["binding"]["binding"]["state"] == "lost" {
            continue;
        }
        if sameboot_loss
            && matches!(
                details["binding"]["binding"]["state"].as_str(),
                Some("released" | "refused")
            )
        {
            return Err(refused());
        }
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
        if sameboot_loss {
            // Startup protection and this actual survey establish a loss observation only.
            // Even global zero does not establish a sameboot terminal/unmount outcome.
            client
                .report_pool(
                    "PoolNodeReport",
                    &report(&state, &boot, &actual, &survey, &driver, false)?,
                )
                .await?;
            continue;
        }
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
