// SPDX-License-Identifier: Apache-2.0
//! CF-owned ordinary-Pod holder execution. A durable dispatch is never replayed after uncertainty.
use crate::{
    policy::{Client, StorageAuthorityTrust},
    pool_custody::Container,
    pool_device::{Backend, Device},
    pool_gate::{GateRoot, ROOT, Record},
    pool_guard::{Active, Armed},
    pool_journal::{Journal, Phase, State},
    pool_permission::{self, Permission},
    slot::Settings,
};
use pgcf_native_protocol::{pool, storage::StorageTrust};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_holder_execution_unconfirmed")
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn trust(config: &StorageAuthorityTrust) -> Result<StorageTrust, Status> {
    StorageTrust::parse(
        &serde_json::to_string(&config.keys).map_err(|_| refused())?,
        &config.sha256,
    )
    .map_err(|_| refused())
}
fn backend(scope: &Value) -> Result<Backend, Status> {
    Ok(Backend::Thin {
        pool_uuid: text(&scope["storage"]["profile"], "pool_uuid")?.to_owned(),
        thin_id: scope["storage"]["thin_id"]
            .as_u64()
            .ok_or_else(refused)?
            .try_into()
            .map_err(|_| refused())?,
    })
}
fn device(scope: &Value) -> Result<Device, Status> {
    let s = &scope["storage"];
    Device::verify(
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        text(s, "volume_handle")?,
        backend(scope)?,
    )
    .map_err(|_| refused())
}
fn journal_path(record: &Record) -> PathBuf {
    Path::new(ROOT).join(format!(
        "{}.state",
        crate::pool_gate::digest(record.volume_handle.as_bytes())
    ))
}
fn matching<'a>(scope: &Value, containers: &'a [Container]) -> Result<Vec<&'a Container>, Status> {
    let found = containers
        .iter()
        .filter(|c| c.pod_uid == scope["pool_pod_uid"])
        .collect::<Vec<_>>();
    let expected = scope["container_ids"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .map(|id| id.as_str().ok_or_else(refused))
        .collect::<Result<BTreeSet<_>, _>>()?;
    if found.len() != 2
        || found
            .iter()
            .map(|c| c.process.container_id.as_str())
            .collect::<BTreeSet<_>>()
            != expected
        || !found
            .iter()
            .any(|c| c.role == "postgres" && c.process.container_id == scope["container_id"])
        || !found.iter().any(|c| c.role == "archiver")
    {
        return Err(refused());
    }
    Ok(found)
}
fn processes(
    scope: &Value,
    containers: &[Container],
) -> Result<Vec<crate::pool_io::Process>, Status> {
    matching(scope, containers)?
        .iter()
        .map(|c| {
            crate::pool_io::Process::capture(c.process.pid, &c.pod_uid, &c.process.container_id)
        })
        .collect()
}
pub(crate) struct Payload {
    directory: PathBuf,
    pub(crate) path: PathBuf,
}
impl Payload {
    pub(crate) fn grant<T: serde::Serialize>(&self, value: &T) -> Result<(), Status> {
        let bytes = serde_json::to_vec(value).map_err(|_| refused())?;
        if bytes.len() > 131072 {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.directory.join("grant.json"))
            .map_err(|_| refused())?;
        file.write_all(&bytes).map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        File::open(&self.directory)
            .map_err(|_| refused())?
            .sync_all()
            .map_err(|_| refused())
    }
    pub(crate) fn create<T: serde::Serialize>(request: &T) -> Result<Self, Status> {
        GateRoot::open(Path::new(ROOT))?;
        let mut entropy = [0u8; 16];
        if unsafe { libc::getrandom(entropy.as_mut_ptr().cast(), entropy.len(), 0) }
            != entropy.len() as isize
        {
            return Err(refused());
        }
        let name = entropy
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let directory = Path::new(ROOT).join(format!("worker-{name}"));
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| refused())?;
        let path = directory.join("request.json");
        let payload = Self { directory, path };
        let bytes = serde_json::to_vec(request).map_err(|_| refused())?;
        if bytes.len() > 131072 {
            return Err(refused());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&payload.path)
            .map_err(|_| refused())?;
        file.write_all(&bytes).map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        File::open(&payload.directory)
            .map_err(|_| refused())?
            .sync_all()
            .map_err(|_| refused())?;
        Ok(payload)
    }
}
impl Drop for Payload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.directory.join("grant.json"));
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}
async fn mount_once(
    settings: &Settings,
    desired: &Value,
    permission: &Permission,
) -> Result<crate::pool_worker::Observation, Status> {
    let payload = Payload::create(&crate::pool_worker::Request {
        v: 1,
        settings: settings.clone(),
        desired: desired.clone(),
    })?;
    let bytes = crate::pool_child::execute(
        crate::pool_child::Kind::Mount,
        payload,
        permission.deadline(),
        8192,
    )
    .await?;
    let output =
        serde_json::from_slice::<crate::pool_worker::Observation>(&bytes).map_err(|_| refused())?;
    if !permission.current() {
        return Err(refused());
    }
    Ok(output)
}
struct Holder {
    scope: Value,
    record: Record,
    state: State,
    active: std::sync::Arc<Active>,
    cleanup: Option<crate::pool_cleanup::Session>,
    report: Value,
}
struct PendingResume {
    authority: pgcf_native_protocol::storage::VerifiedStorageAuthority,
    armed: bool,
}
impl Drop for PendingResume {
    fn drop(&mut self) {
        if !self.armed {
            let _ = crate::storage_dm::suspend(&self.authority);
        }
    }
}
fn survey(
    scope: &Value,
    record: &Record,
    dev: u64,
) -> Result<crate::pool_namespaces::Survey, Status> {
    let s = &scope["storage"];
    crate::pool_inspector::inspect(
        record,
        text(s, "volume_group_uuid")?,
        text(s, "lv_uuid")?,
        dev,
        backend(scope)?,
    )
}
fn foreign(
    survey: &crate::pool_namespaces::Survey,
    scope: &Value,
    containers: &[Container],
) -> Result<u64, Status> {
    let platform = crate::pool_inspector::platform()?;
    let mut node = BTreeSet::from([
        platform.initial_mount_namespace_id,
        platform.kubelet_mount_namespace_id,
        crate::pool_namespaces::namespace_id(
            &File::open("/proc/self/ns/mnt").map_err(|_| refused())?,
        )
        .map_err(|_| refused())?,
    ]);
    let mut writers = BTreeSet::new();
    for c in matching(scope, containers)? {
        c.process.recheck()?;
        writers.insert(
            crate::pool_namespaces::namespace_id(
                &File::open(format!("/proc/{}/ns/mnt", c.process.pid)).map_err(|_| refused())?,
            )
            .map_err(|_| refused())?,
        );
    }
    let point = format!(
        "/var/lib/kubelet/pods/{}/volumes/kubernetes.io~empty-dir/volume/data",
        text(scope, "pool_pod_uid")?
    );
    let unknown = survey
        .aliases
        .iter()
        .filter(|a| {
            a.root != "/"
                || !((node.contains(&a.namespace_id) && a.point == point)
                    || (writers.contains(&a.namespace_id) && a.point == "/var/lib/postgresql/data"))
        })
        .count();
    node.clear();
    Ok(unknown as u64)
}
fn mounted_report(
    scope: &Value,
    record: &Record,
    state: &State,
    active: &Active,
    driver: &crate::pool_driver::Driver,
    containers: &[Container],
) -> Result<Value, Status> {
    driver.recheck()?;
    let d = device(scope)?;
    let observed = survey(scope, record, d.device())?;
    let unknown = foreign(&observed, scope, containers)?;
    let identity = crate::pool_mount::MountedAnchor::for_pod(text(scope, "pool_pod_uid")?)
        .map_err(|_| refused())?
        .identity()
        .map_err(|_| refused())?;
    if unknown != 0
        || observed.aliases.is_empty()
        || identity.device != state.device
        || Some(identity.mount_id) != state.mount_id
    {
        return Err(refused());
    }
    let s = &scope["storage"];
    let proof = json!({"device_major":libc::major(d.device()),"device_minor":libc::minor(d.device()),"mount_id":identity.mount_id,"dm_open_count":d.open_count().map_err(|_|refused())?,"foreign_mounts":unknown,"complete_namespace_scan":false,"named_namespace_scan_complete":observed.named_namespace_scan_complete,"zero_before_bind":true,"exclusive_superblock_creation":true,"nonlazy_unmount_verified":false,"never_attached_verified":false,"creator_fence":{"v":1,"scope_sha256":record.scope_sha256,"storage_uid":s["storage_uid"],"volume_handle":s["volume_handle"],"volume_group_uuid":s["volume_group_uuid"],"lv_uuid":s["lv_uuid"],"driver_gate_protocol":1,"driver_image":scope["driver_image"],"driver_sha256":driver.executable_sha256,"deny_record_durable":true,"csi_node_publish_serialized":true,"csi_node_expand_serialized":true,"creation_fds_closed":true},"mountpoint":{"pool_pod_uid":scope["pool_pod_uid"],"root_uid":0,"mode":493,"tmpfs":true,"opened_beneath":true,"symlink_free":true}});
    let thin_guard = active.proof()?;
    let value = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":record.scope_sha256,"node_uid":scope["node_uid"],"boot_id":crate::storage::current_boot_id()?,"pool_pod_uid":scope["pool_pod_uid"],"state":"mounted","observed_at":now(),"storage_backend":"lvm-thin-v1","thin_guard":thin_guard,"kernel_proof":proof,"clean_stop":null,"error":null});
    if !active.current() || !pool::validate("PoolNodeReport", &value) {
        return Err(refused());
    }
    Ok(value)
}
async fn begin(
    settings: &Settings,
    client: &Client,
    config: &StorageAuthorityTrust,
    desired: &Value,
    preparation: &Value,
    containers: &[Container],
) -> Result<Holder, Status> {
    let anchors = pool_permission::keys(config)?;
    let permission = Permission::new(desired, client.local(), &anchors)?;
    let scope = permission.scope().clone();
    let scoped_pod = text(&scope, "pool_pod_uid")?;
    let mut prepared = preparation.clone();
    let pod = prepared["pods"]
        .as_array()
        .ok_or_else(refused)?
        .iter()
        .find(|p| p["pod_uid"] == scoped_pod)
        .ok_or_else(refused)?
        .clone();
    prepared["pods"] = json!([pod]);
    let inventory =
        crate::pool_inventory::measure(&prepared, client.local(), containers, &BTreeSet::new())?;
    let att = &inventory.value["pods"][0];
    if att["container_ids"] != scope["container_ids"]
        || att["supervisor_key_sha256"] != scope["supervisor_key_sha256"]
        || att["supervisor_sha256"] != scope["supervisor_sha256"]
        || att["class"] != scope["class"]
        || prepared["policy"]["driver_image"] != scope["driver_image"]
        || prepared["policy"]["driver_sha256"] != scope["driver_sha256"]
        || prepared["pool_namespace_uid"] != scope["pool_namespace_uid"]
    {
        return Err(refused());
    }
    let io = crate::pool_pregrant::measure(&permission, &inventory.processes)?;
    client.report_pool("PoolIoAttestation", &io).await?;
    let details = client
        .pool_binding_details(text(&scope, "binding_id")?)
        .await?;
    let current = &details["binding"];
    if current["binding"]["scope"] != scope
        || current["binding"]["holder_revision"] != desired["binding"]["holder_revision"]
        || current["authority"] != "current"
        || current["binding"]["state"] != "claimed"
        || !permission.current()
    {
        return Err(refused());
    }
    let token = text(current, "storage_authority")?;
    let storage = &scope["storage"];
    let t = trust(config)?;
    let authority =
        pool::verify_pool_storage_authority(&t, token, &scope, now()).ok_or_else(refused)?;
    let metadata = crate::pool_device::thin_metadata(
        text(storage, "volume_group_uuid")?,
        text(storage, "lv_uuid")?,
        text(storage, "volume_handle")?,
        text(&storage["profile"], "pool_uuid")?,
    )
    .map_err(|_| refused())?;
    if metadata.open_count != 0
        || u64::from(metadata.thin_id) != storage["thin_id"].as_u64().ok_or_else(refused)?
    {
        return Err(refused());
    }
    let record = Record::new(
        text(storage, "volume_handle")?,
        permission.scope_sha256(),
        &format!(
            "LVM-{}{}",
            text(storage, "volume_group_uuid")?.replace('-', ""),
            text(storage, "lv_uuid")?.replace('-', "")
        ),
    )?;
    let gate = GateRoot::open(Path::new(ROOT))?;
    let mut locked = gate.lock_until(&record.volume_handle, permission.deadline())?;
    let journal = Journal::open(&journal_path(&record))?;
    if journal.read()?.is_some() {
        return Err(refused());
    } // durable intent cannot re-enter the initial dispatch branch
    let driver = crate::pool_driver::verify(
        settings,
        text(&scope, "driver_image")?,
        text(&scope, "driver_sha256")?,
    )
    .await?;
    if locked.claim(&record).is_err() {
        let q = client.pool_qualification().await?;
        let input = &q["qualification"];
        let claims = crate::pool_qualification::claims(input, client)?;
        let zero = crate::pool_device::zero_thin(
            text(storage, "volume_group_uuid")?,
            text(storage, "lv_uuid")?,
            text(storage, "volume_handle")?,
            text(&storage["profile"], "pool_uuid")?,
            metadata.thin_id,
        )
        .map_err(|_| refused())?;
        let physical = &input["accepted_evidence"][1]["measurement"];
        if driver.pod_uid != claims["execution"]["driver_pod_uid"]
            || !zero.still_zero().map_err(|_| refused())?
            || zero.device != metadata.device
            || physical["device_major"] != libc::major(metadata.device)
            || physical["device_minor"] != libc::minor(metadata.device)
        {
            return Err(refused());
        }
        driver.recheck()?;
        locked.claim_qualified(&record, current, input, preparation, &anchors, now())?;
    }
    let mut pending = PendingResume {
        authority: authority.clone(),
        armed: false,
    };
    if metadata.suspended {
        if !permission.current() {
            return Err(refused());
        }
        crate::storage_dm::resume(&authority)?
    }
    let d = device(&scope)?;
    d.zero().map_err(|_| refused())?;
    let before = survey(&scope, &record, d.device())?;
    if !before.aliases.is_empty() {
        return Err(refused());
    }
    let armed = Armed::arm(
        &t,
        &scope,
        token,
        &client.local().node_uid,
        processes(&scope, containers)?,
    )?;
    let active = std::sync::Arc::new(Active::start(armed));
    pending.armed = true;
    let mut state = State {
        v: 1,
        record: record.clone(),
        binding_id: text(&scope, "binding_id")?.to_owned(),
        node_uid: text(&scope, "node_uid")?.to_owned(),
        boot_id: text(&scope, "boot_id")?.to_owned(),
        pool_pod_uid: scoped_pod.to_owned(),
        container_ids: scope["container_ids"]
            .as_array()
            .ok_or_else(refused)?
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or_else(refused))
            .collect::<Result<Vec<_>, _>>()?,
        phase: Phase::Prepared,
        ever_attached: false,
        device: d.device(),
        mount_id: None,
        authority_revision: authority.claims().authority_revision,
        storage_authority: Some(token.to_owned()),
        scope: Some(scope.clone()),
        io_attestation: Some(io),
        terminal_report: None,
        terminal_history: vec![],
        terminal_acknowledged: false,
        cleanup: None,
        groups: inventory
            .processes
            .iter()
            .map(|p| p.group_record())
            .collect(),
    };
    journal.store(&state)?;
    state = state.dispatch_mount()?;
    journal.store(&state)?;
    drop(locked);
    drop(d);
    let mut worker_desired = desired.clone();
    worker_desired["storage_authority"] = token.into();
    let outcome = mount_once(settings, &worker_desired, &permission).await;
    if outcome.is_err() {
        let _ = active.revoke();
        return Err(refused());
    }
    state = journal
        .read()?
        .filter(|s| s.phase == Phase::Mounted && s.ever_attached)
        .ok_or_else(refused)?;
    let report = mounted_report(&scope, &record, &state, &active, &driver, containers)?;
    client.report_pool("PoolNodeReport", &report).await?;
    let main = matching(&scope, containers)?
        .into_iter()
        .find(|c| c.role == "postgres")
        .ok_or_else(refused)?;
    let signal = json!({"v":1,"scope_sha256":record.scope_sha256,"binding_id":scope["binding_id"],"bundle_nonce":scope["bundle_nonce"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"pool_pod_uid":scope["pool_pod_uid"],"permission":permission.token(),"storage_authority":token,"mount_id":state.mount_id,"device_major":libc::major(state.device),"device_minor":libc::minor(state.device),"observed_at":now()});
    crate::pool_signal::mounted(main, &active, &signal)?;
    Ok(Holder {
        scope,
        record,
        state,
        active,
        cleanup: None,
        report,
    })
}
fn holder_observations(scope: &Value, report: Value) -> Result<Vec<(&'static str, Value)>, Status> {
    if pool::scope_hash(scope).as_deref() != report["scope_sha256"].as_str()
        || report["binding_id"] != scope["binding_id"]
        || report["node_uid"] != scope["node_uid"]
        || report["boot_id"] != scope["boot_id"]
        || report["pool_pod_uid"] != scope["pool_pod_uid"]
    {
        return Err(refused());
    }
    let storage = &scope["storage"];
    let proof = &report["kernel_proof"];
    // Both values come from the current kernel/armed-holder measurement above. The initial
    // pregrant receipt is never restamped to keep a later SA1 eligible.
    let io = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":report["scope_sha256"],
        "node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"pool_namespace_uid":scope["pool_namespace_uid"],
        "pool_pod_uid":scope["pool_pod_uid"],"observed_at":report["observed_at"],
        "device":{"volume_group_uuid":storage["volume_group_uuid"],"lv_uuid":storage["lv_uuid"],"thin_id":storage["thin_id"],
            "device_major":proof["device_major"],"device_minor":proof["device_minor"]},
        "shared_pod_io":report["thin_guard"]["shared_pod_io"],"cgroups":report["thin_guard"]["cgroups"]});
    if !pool::validate("PoolIoAttestation", &io) {
        return Err(refused());
    }
    Ok(vec![("PoolIoAttestation", io), ("PoolNodeReport", report)])
}

#[derive(Debug, PartialEq, Eq)]
enum ExistingHolderAction {
    ObserveMounted,
    Drain,
    Protect,
}
fn existing_holder_action(scope: &Value, desired: &Value) -> ExistingHolderAction {
    if *scope != desired["binding"]["scope"] {
        return ExistingHolderAction::Protect;
    }
    match (
        desired["authority"].as_str(),
        desired["binding"]["state"].as_str(),
    ) {
        (Some("current"), Some("mounted" | "serving")) => ExistingHolderAction::ObserveMounted,
        (Some("revoked"), Some("detaching")) => ExistingHolderAction::Drain,
        _ => ExistingHolderAction::Protect,
    }
}

/// Omitted/revoked holders protect immediately; network failures leave the finite local clock intact.
pub async fn run(
    settings: Settings,
    mut client: Client,
    mut updates: tokio::sync::watch::Receiver<Client>,
) -> Result<(), Status> {
    let config = client
        .local()
        .storage_authority
        .clone()
        .ok_or_else(refused)?;
    let trusted = trust(&config)?;
    GateRoot::provision(Path::new(ROOT))?;
    protect_journals(&config, &client.local().node_uid)?;
    let restarted = crate::pool_recovery::Restarted::capture(
        Path::new(ROOT),
        &client.local().node_uid,
        &crate::storage::current_boot_id()?,
    )?;
    let mut holders: BTreeMap<String, Holder> = BTreeMap::new();
    let mut last_revision = 0u64;
    loop {
        if crate::pool_child::reap().await.is_err() {
            eprintln!("pool_worker_cleanup_pending");
        }
        if crate::pool_qualification::reap_pending_owner()
            .await
            .is_err()
        {
            eprintln!("pool_qualification_owner_cleanup_pending");
        }
        if updates.has_changed().unwrap_or(false) {
            client = updates.borrow_and_update().clone()
        }
        let mut completed = Vec::new();
        for (id, holder) in &mut holders {
            if let Some(cleanup) = holder.cleanup.as_mut() {
                match cleanup.poll(&settings, &client, &holder.state).await {
                    Ok(true) => completed.push(id.clone()),
                    Ok(false) => {}
                    Err(_) => eprintln!("pool_cleanup_pending"),
                }
            }
        }
        for id in completed {
            holders.remove(&id);
        }
        let mut cleanup_scopes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for holder in holders.values().filter(|holder| holder.cleanup.is_some()) {
            cleanup_scopes
                .entry(holder.state.pool_pod_uid.clone())
                .or_default()
                .extend(holder.state.container_ids.iter().cloned());
        }
        let result: Result<(), Status> = async {
            if let Ok(q) = client.pool_qualification().await {
                let input = &q["qualification"];
                if input["challenge"]["gate"] == "finite_creator_fence" {
                    // Driver replacement can outlive preparation freshness. Finite scope and full
                    // progress are independently signed and verified by the node producer.
                    if let Ok(Some(report)) =
                        crate::pool_qualification::finite_creator(&settings, &client, input).await
                    {
                        if report.get("progress").is_some() {
                            client.report_qualification_progress(&report).await?;
                        } else {
                            client.report_qualification(&report).await?;
                        }
                    }
                }
            }
            crate::pool_recovery::reconcile(
                &settings,
                &client,
                &restarted,
                &holders.keys().cloned().collect(),
            )
            .await?;
            let snapshot = client.pool_bindings(None).await;
            if let Ok(snapshot) = snapshot {
                let revision = snapshot["revision"].as_u64().ok_or_else(refused)?;
                if revision < last_revision {
                    return Err(refused());
                }
                last_revision = revision;
                let desired = snapshot["bindings"].as_array().ok_or_else(refused)?;
                let mut seen = BTreeSet::new();
                for entry in desired {
                    let scope = &entry["binding"]["scope"];
                    let id = text(scope, "binding_id")?.to_owned();
                    seen.insert(id.clone());
                    if let Some(holder) = holders.get_mut(&id) {
                        if holder.cleanup.is_some() {
                            continue;
                        }
                        let action = existing_holder_action(&holder.scope, entry);
                        if action == ExistingHolderAction::Protect {
                            let _ = holder.active.revoke();
                            continue;
                        }
                        let result = entry["storage_authority"]
                            .as_str()
                            .ok_or_else(refused)
                            .and_then(|token| holder.active.refresh(&trusted, token));
                        if result.is_err() {
                            let _ = holder.active.revoke();
                            continue;
                        }
                        let containers =
                            crate::pool_custody::running_except(&settings, &cleanup_scopes).await?;
                        let driver = crate::pool_driver::verify(
                            &settings,
                            text(scope, "driver_image")?,
                            text(scope, "driver_sha256")?,
                        )
                        .await?;
                        holder.report = mounted_report(
                            scope,
                            &holder.record,
                            &holder.state,
                            &holder.active,
                            &driver,
                            &containers,
                        )?;
                        for (schema, observation) in
                            holder_observations(scope, holder.report.clone())?
                        {
                            if action != ExistingHolderAction::Drain || schema != "PoolNodeReport" {
                                client.report_pool(schema, &observation).await?;
                            }
                        }
                        if action == ExistingHolderAction::Drain {
                            let details = client.pool_binding_details(&id).await?;
                            if details["supervisor_report"]["state"] == "stopped" {
                                let lease = client.storage_lease().await?;
                                if lease.node_uid != client.local().node_uid
                                    || lease.boot_id.as_deref()
                                        != Some(crate::storage::current_boot_id()?.as_str())
                                    || lease.expires_at <= now()
                                {
                                    return Err(refused());
                                }
                                if let Some(custody) =
                                    lease.databases.iter().filter_map(|d| d.pool.as_ref()).find(
                                        |p| p["binding_id"] == id && !p["cleanup_intent"].is_null(),
                                    )
                                {
                                    crate::pool_child::reap().await?;
                                    holder.cleanup = Some(crate::pool_cleanup::Session::start(
                                        &settings,
                                        scope,
                                        custody,
                                        &details["supervisor_report"],
                                        &containers,
                                        holder.active.clone(),
                                    )?);
                                }
                            }
                        }
                    }
                }
                for (id, holder) in &holders {
                    if !seen.contains(id) {
                        let _ = holder.active.revoke();
                    }
                }
                let lease = client.storage_lease().await?;
                let lease_value = serde_json::to_value(&lease).map_err(|_| refused())?;
                if !jsonschema::validator_for(&pgcf_native_protocol::CONTRACT["storageHostLease"])
                    .map_err(|_| refused())?
                    .is_valid(&lease_value)
                    || lease.node_uid != client.local().node_uid
                    || lease.boot_id.as_deref() != Some(crate::storage::current_boot_id()?.as_str())
                    || lease.material_revision != u64::from(client.local().material_revision)
                    || lease.expires_at <= now()
                {
                    return Err(refused());
                }
                if let Some(preparations) = lease.preparations {
                    let containers =
                        crate::pool_custody::running_except(&settings, &cleanup_scopes).await?;
                    for preparation in preparations {
                        let q = client.pool_qualification().await?;
                        let input = &q["qualification"];
                        if !input.is_null()
                            && cleanup_scopes.is_empty()
                            && input["challenge"]["gate"] == "host_mount_context"
                            && preparation["qualification_run_id"] == input["scope"]["run_id"]
                            && preparation["qualification_scope_sha256"] == input["scope_sha256"]
                        {
                            // Namespace-only null-preparation grants cannot advance this gate. The measured PG
                            // reply plus post-close physical proof is preserved for the controller's Kube join.
                            if let Ok(report) = crate::pool_qualification::host_context(
                                &settings,
                                &client,
                                input,
                                &preparation,
                            )
                            .await
                            {
                                client.report_qualification(&report).await?;
                            }
                        }
                        let held = desired
                            .iter()
                            .filter_map(|d| {
                                d["binding"]["scope"]["pool_pod_uid"]
                                    .as_str()
                                    .map(str::to_owned)
                            })
                            .collect::<BTreeSet<_>>();
                        if let Ok(inventory) = crate::pool_inventory::measure(
                            &preparation,
                            client.local(),
                            &containers,
                            &held,
                        ) {
                            client
                                .report_pool("PoolPodInventory", &inventory.value)
                                .await?
                        }
                        for entry in desired {
                            let scope = &entry["binding"]["scope"];
                            let id = text(scope, "binding_id")?;
                            if !holders.contains_key(id)
                                && entry["authority"] == "current"
                                && entry["binding"]["state"] == "claimed"
                            {
                                match begin(
                                    &settings,
                                    &client,
                                    &config,
                                    entry,
                                    &preparation,
                                    &containers,
                                )
                                .await
                                {
                                    Ok(holder) => {
                                        holders.insert(id.to_owned(), holder);
                                    }
                                    Err(_) => {
                                        eprintln!("pool_initial_holder_unconfirmed");
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            if error.code() != tonic::Code::Unavailable {
                for holder in holders.values() {
                    let _ = holder.active.revoke();
                }
            }
            eprintln!("pool_iteration_unconfirmed");
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Historical signed identity permits only quiescence on restart, never a mount/resume.
/// This also runs in the credentialless parent if the CRI child terminates unexpectedly.
pub fn protect_journals(config: &StorageAuthorityTrust, node_uid: &str) -> Result<(), Status> {
    let trust = trust(config)?;
    let root = GateRoot::open(Path::new(ROOT))?;
    let mut count = 0usize;
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
        let Some(state) = journal.read()? else {
            continue;
        };
        if state.phase == Phase::Detached {
            continue;
        }
        let scope = state.scope.as_ref().ok_or_else(refused)?;
        if state.node_uid != node_uid
            || !pool::validate("PoolBindingScope", scope)
            || !root.record_matches(&state.record)?
        {
            return Err(refused());
        }
        let old = trust
            .verify_for_protection(state.storage_authority.as_deref().ok_or_else(refused)?)
            .map_err(|_| refused())?;
        let c = old.claims();
        let storage = &scope["storage"];
        if c.node_uid != node_uid
            || scope["node_uid"] != node_uid
            || c.database_id != text(scope, "database_id")?
            || c.generation != scope["generation"].as_u64().ok_or_else(refused)?
            || c.pod_uid != state.pool_pod_uid
            || c.volume_handle != state.record.volume_handle
            || c.volume_group_uuid != text(storage, "volume_group_uuid")?
            || c.lv_uuid != text(storage, "lv_uuid")?
            || c.pool_uuid != text(&storage["profile"], "pool_uuid")?
            || c.profile_sha256 != text(&storage["profile"], "profile_sha256")?
        {
            return Err(refused());
        }
        let actual = crate::pool_device::thin_metadata(
            &c.volume_group_uuid,
            &c.lv_uuid,
            &c.volume_handle,
            &c.pool_uuid,
        )
        .map_err(|_| refused())?;
        if !protection_device_matches(&state, &crate::storage::current_boot_id()?, &actual)? {
            return Err(refused());
        }
        crate::storage_dm::suspend(&old)?;
        if state.boot_id == crate::storage::current_boot_id()? {
            let io = state.io_attestation.as_ref().ok_or_else(refused)?;
            if !pool::validate("PoolIoAttestation", io)
                || state.groups.len() != state.container_ids.len()
            {
                return Err(refused());
            }
            for g in &state.groups {
                if g.pod_uid != state.pool_pod_uid
                    || !state.container_ids.contains(&g.container_id)
                    || !io["cgroups"].as_array().is_some_and(|rows| {
                        rows.iter().any(|r| {
                            r["container_id"] == g.container_id
                                && r["cgroup_inode"] == g.cgroup_inode
                        })
                    })
                {
                    return Err(refused());
                }
                let group = crate::pool_io::CapturedGroup::restore(g)?;
                if group.populated()? {
                    group.stop()?
                }
            }
        }
    }
    Ok(())
}

fn protection_device_matches(
    state: &State,
    current_boot: &str,
    actual: &crate::pool_device::ThinMetadata,
) -> Result<bool, Status> {
    let scope = state.scope.as_ref().ok_or_else(refused)?;
    Ok(
        u64::from(actual.thin_id) == scope["storage"]["thin_id"].as_u64().ok_or_else(refused)?
            && (state.boot_id != current_boot || actual.device == state.device),
    )
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    fn state() -> State {
        let mut scope = pool::CONTRACT["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "thin-scope")
            .unwrap()["value"]
            .clone();
        scope["boot_id"] = crate::storage::current_boot_id().unwrap().into();
        State {
            v: 1,
            record: Record::new(
                text(&scope["storage"], "volume_handle").unwrap(),
                &pool::scope_hash(&scope).unwrap(),
                &format!(
                    "LVM-{}{}",
                    text(&scope["storage"], "volume_group_uuid")
                        .unwrap()
                        .replace('-', ""),
                    text(&scope["storage"], "lv_uuid").unwrap().replace('-', "")
                ),
            )
            .unwrap(),
            binding_id: text(&scope, "binding_id").unwrap().to_owned(),
            node_uid: text(&scope, "node_uid").unwrap().to_owned(),
            boot_id: text(&scope, "boot_id").unwrap().to_owned(),
            pool_pod_uid: text(&scope, "pool_pod_uid").unwrap().to_owned(),
            container_ids: serde_json::from_value(scope["container_ids"].clone()).unwrap(),
            phase: Phase::Mounted,
            ever_attached: true,
            device: libc::makedev(253, 1),
            mount_id: Some(123),
            authority_revision: 1,
            storage_authority: None,
            scope: Some(scope),
            io_attestation: None,
            groups: vec![],
            terminal_report: None,
            terminal_history: vec![],
            terminal_acknowledged: false,
            cleanup: None,
        }
    }
    #[test]
    fn existing_holder_observation_refreshes_io_before_node_report() {
        let scope = state().scope.unwrap();
        let measured = pool::CONTRACT["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "measured-thin-device")
            .unwrap()["value"]
            .clone();
        let observed_at = measured["observed_at"].as_u64().unwrap() + 1;
        let report = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":pool::scope_hash(&scope).unwrap(),
            "node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"pool_pod_uid":scope["pool_pod_uid"],"observed_at":observed_at,
            "kernel_proof":{"device_major":measured["device"]["device_major"],"device_minor":measured["device"]["device_minor"]},
            "thin_guard":{"shared_pod_io":measured["shared_pod_io"],"cgroups":measured["cgroups"]}});
        let reports = holder_observations(&scope, report).unwrap();
        assert_eq!(reports[0].0, "PoolIoAttestation");
        assert_eq!(reports[0].1["observed_at"], observed_at);
        assert_eq!(reports[0].1["cgroups"], measured["cgroups"]);
        assert_eq!(reports[1].0, "PoolNodeReport");
    }
    #[test]
    fn exact_existing_detaching_holder_can_use_separate_drain_authority() {
        let scope = state().scope.unwrap();
        let mut desired =
            json!({"authority":"current","binding":{"scope":scope,"state":"serving"}});
        assert_eq!(
            existing_holder_action(&scope, &desired),
            ExistingHolderAction::ObserveMounted
        );
        desired["authority"] = "revoked".into();
        desired["binding"]["state"] = "detaching".into();
        // This only classifies the already armed holder. A separate valid SA1 remains mandatory.
        assert_eq!(
            existing_holder_action(&scope, &desired),
            ExistingHolderAction::Drain
        );
        desired["binding"]["scope"]["generation"] = 999.into();
        assert_eq!(
            existing_holder_action(&scope, &desired),
            ExistingHolderAction::Protect
        );
    }
    #[test]
    fn reboot_reuses_physical_uuid_and_thin_id_without_reusing_old_device_number() {
        let state = state();
        let mut actual = crate::pool_device::ThinMetadata {
            device: libc::makedev(253, 9),
            logical_size_bytes: 32 * 1024 * 1024,
            thin_id: state.scope.as_ref().unwrap()["storage"]["thin_id"]
                .as_u64()
                .unwrap() as u32,
            open_count: 0,
            suspended: true,
            read_only: false,
        };
        assert!(!protection_device_matches(&state, &state.boot_id, &actual).unwrap());
        assert!(
            protection_device_matches(&state, "ffeeddcc-bbaa-4999-8888-776655443322", &actual)
                .unwrap()
        );
        actual.thin_id += 1;
        assert!(
            !protection_device_matches(&state, "ffeeddcc-bbaa-4999-8888-776655443322", &actual)
                .unwrap()
        );
    }
    #[test]
    fn terminal_acknowledgment_cannot_exist_without_durable_physical_report() {
        let mut state = state();
        state.terminal_acknowledged = true;
        assert!(state.valid().is_err());
        state.phase = Phase::Detached;
        state.mount_id = None;
        assert!(state.valid().is_err());
    }
    fn restart_state(later: bool) -> State {
        let mut state = state();
        state.phase = Phase::Prepared;
        state.ever_attached = false;
        state.mount_id = None;
        if later {
            state.binding_id = "aa001122-3344-4556-8778-990011223344".to_owned();
            let scope = state.scope.as_mut().unwrap();
            scope["binding_id"] = state.binding_id.clone().into();
            scope["storage"]["volume_handle"] = "pvc-aa001122-3344-4556-8778-990011223344".into();
            state.record = Record::new(
                scope["storage"]["volume_handle"].as_str().unwrap(),
                &pool::scope_hash(scope).unwrap(),
                &state.record.device_uuid,
            )
            .unwrap();
        }
        state
    }
    fn restart_journal(root: &Path, state: &State) -> Journal {
        Journal::open(&root.join(format!(
            "{}.state",
            crate::pool_gate::digest(state.record.volume_handle.as_bytes())
        )))
        .unwrap()
    }
    #[test]
    fn real_host_process_restart_selects_only_prior_durable_bindings() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "pool-restart-selection-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let command = |action: &str| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "pool_runtime::recovery_tests::restart_selection_process",
                    "--nocapture",
                ])
                .env("PGCF_RESTART_TEST_ROOT", &root)
                .env("PGCF_RESTART_TEST_ACTION", action);
            command
        };
        assert!(command("record").status().unwrap().success());
        let mut restarted = command("observe").spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("captured").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // This real durable mount dispatch appears after the new process's startup census,
        // while registration of its eventual active guard is still pending.
        let later = restart_state(true);
        let journal = restart_journal(&root, &later);
        journal.store(&later).unwrap();
        journal.store(&later.dispatch_mount().unwrap()).unwrap();
        std::fs::write(root.join("continue"), b"ready").unwrap();
        let status = restarted.wait().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert!(status.success());
    }
    #[test]
    fn restart_selection_process() {
        let Ok(root) = std::env::var("PGCF_RESTART_TEST_ROOT") else {
            return;
        };
        let root = Path::new(&root);
        let prior = restart_state(false);
        if std::env::var("PGCF_RESTART_TEST_ACTION").unwrap() == "record" {
            restart_journal(root, &prior).store(&prior).unwrap();
            return;
        }
        let selected =
            crate::pool_recovery::Restarted::capture(root, &prior.node_uid, &prior.boot_id)
                .unwrap();
        std::fs::write(root.join("captured"), b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("continue").exists() {
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let prior = restart_journal(root, &prior).read().unwrap().unwrap();
        let later = restart_state(true);
        let later = restart_journal(root, &later).read().unwrap().unwrap();
        assert!(selected.needs_observation(&prior, &prior.boot_id));
        assert!(!selected.needs_observation(&later, &later.boot_id));
    }
    #[test]
    fn delayed_terminal_commit_acknowledges_the_original_observed_report() {
        let mut initial = state();
        initial.phase = Phase::Detached;
        initial.mount_id = None;
        let first = json!({"binding_id":initial.binding_id,"scope_sha256":initial.record.scope_sha256,
            "node_uid":initial.node_uid,"pool_pod_uid":initial.pool_pod_uid,"state":"released",
            "observed_at":1,"kernel_proof":{"mount_id":null,"dm_open_count":0,"foreign_mounts":0,"named_namespace_scan_complete":true}});
        initial = initial.terminal(first.clone()).unwrap();
        let mut fresh = first.clone();
        fresh["observed_at"] = 2.into();
        initial = initial.terminal(fresh).unwrap();
        for observed in 3..=32 {
            let mut actual_attempt = first.clone();
            actual_attempt["observed_at"] = observed.into();
            initial = initial.terminal(actual_attempt).unwrap();
        }
        let mut overflow = first.clone();
        overflow["observed_at"] = 33.into();
        assert!(initial.terminal(overflow).is_err());
        assert_eq!(initial.terminal_history.len(), 32);
        let details = json!({"binding":{"binding":{"scope":initial.scope,"scope_sha256":initial.record.scope_sha256,"state":"released"},"authority":"revoked","permission":null,"storage_authority":null},"node_report":first});
        assert!(initial.acknowledge(&details).is_ok());
    }
    #[test]
    fn terminal_report_and_ack_survive_restart_and_cannot_be_rewritten() {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!(
            "pool-recovery-journal-{}-{}",
            std::process::id(),
            now()
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let journal = Journal::open(&path.join(format!("{}.state", "a".repeat(64)))).unwrap();
        let mut initial = state();
        initial.phase = Phase::Prepared;
        initial.ever_attached = false;
        initial.mount_id = None;
        journal.store(&initial).unwrap();
        let mut detached = initial.clone();
        detached.phase = Phase::Detached;
        let report = json!({"binding_id":detached.binding_id,"scope_sha256":detached.record.scope_sha256,
            "node_uid":detached.node_uid,"pool_pod_uid":detached.pool_pod_uid,"state":"refused",
            "observed_at":1,"kernel_proof":{"mount_id":null,"dm_open_count":0,"foreign_mounts":0,"named_namespace_scan_complete":true}});
        detached = detached.terminal(report.clone()).unwrap();
        journal.store(&detached).unwrap();
        assert!(journal.retire_acknowledged().is_err());
        let restored = journal.read().unwrap().unwrap();
        assert_eq!(restored.terminal_report.as_ref(), Some(&report));
        assert!(!restored.terminal_acknowledged);
        let mut details = json!({"binding":{"binding":{"scope":restored.scope,"scope_sha256":restored.record.scope_sha256,"state":"refused"},"authority":"revoked","permission":null,"storage_authority":null},"node_report":report});
        details["node_report"]["observed_at"] = 2.into();
        assert!(restored.acknowledge(&details).is_err());
        details["node_report"]["observed_at"] = 1.into();
        let acknowledged = restored.acknowledge(&details).unwrap();
        journal.store(&acknowledged).unwrap();
        assert!(journal.read().unwrap().unwrap().terminal_acknowledged);
        let mut erased = acknowledged.clone();
        erased.terminal_acknowledged = false;
        assert!(journal.store(&erased).is_err());
        let mut changed = acknowledged.clone();
        changed.terminal_report.as_mut().unwrap()["observed_at"] = 2.into();
        assert!(journal.store(&changed).is_err());
        assert!(acknowledged.terminal(report).is_err());
        journal.retire_acknowledged().unwrap();
        assert!(journal.read().unwrap().is_none());
        std::fs::remove_dir(path).unwrap();
    }
}
