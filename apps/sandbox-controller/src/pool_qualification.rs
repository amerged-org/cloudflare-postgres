// SPDX-License-Identifier: Apache-2.0
//! One CF-signed finite action/report. The node never invents Kubernetes sleep facts.
use crate::{policy::Client, pool_permission, slot::Settings};
use pgcf_native_protocol::{pool, qualification};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt},
        process::ExitStatusExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tonic::Status;
const HOST_PRODUCER: &str = "node_agent";
// Unmodified LVM ELF pin from infra/storage/sources.lock.json, independently of the driver filesystem.
const LVM_BINARY_SHA256: &str = "fdc5aa9706d9982553ff4ee8497e4236dbfba4e790a8b81883789739e0176546";
#[path = "pool_qualification_physical.rs"]
mod physical;
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
fn claims_match(input: &Value, claims: &Value) -> bool {
    claims["scope"] == input["scope"]
        && claims["scope_sha256"] == input["scope_sha256"]
        && claims["challenge"] == input["challenge"]
        && qualification::progress_hash(&input["pending_progress"])
            .is_some_and(|hash| claims["progress_sha256"] == hash)
}
pub fn claims(input: &Value, client: &Client) -> Result<Value, Status> {
    local_claims(input, client.local())
}
fn local_claims(input: &Value, local: &crate::policy::Cloudflare) -> Result<Value, Status> {
    if !qualification::validate("PostgresPoolQualificationInput", input) {
        return Err(refused());
    }
    let config = local.storage_authority.as_ref().ok_or_else(refused)?;
    let keys = pool_permission::keys(config)?;
    let claims =
        qualification::verify_qualification_permission(text(input, "permission")?, &keys, now())
            .ok_or_else(refused)?;
    if !claims_match(input, &claims)
        || claims["scope"]["node_id"] != local.node_id
        || claims["scope"]["node_uid"] != local.node_uid
        || claims["scope"]["region_id"] != local.region_id
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerRequest {
    v: u8,
    settings: Settings,
    input: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordProof {
    inode: u64,
    sha256: String,
}
fn record_proof(record: &crate::pool_gate::Record) -> Result<RecordProof, Status> {
    let root = crate::pool_gate::GateRoot::open(Path::new(crate::pool_gate::ROOT))?;
    if !root.record_matches(record)? {
        return Err(refused());
    }
    let path = Path::new(crate::pool_gate::ROOT).join(format!(
        "{}.deny",
        crate::pool_gate::digest(record.volume_handle.as_bytes())
    ));
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| refused())?;
    let meta = file.metadata().map_err(|_| refused())?;
    if meta.uid() != 0 || meta.nlink() != 1 || meta.mode() & 0o7777 != 0o600 || meta.len() > 4096 {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| refused())?;
    if bytes != record.bytes()? {
        return Err(refused());
    }
    file.sync_all().map_err(|_| refused())?;
    File::open(crate::pool_gate::ROOT)
        .and_then(|d| d.sync_all())
        .map_err(|_| refused())?;
    Ok(RecordProof {
        inode: meta.ino(),
        sha256: crate::pool_gate::digest(&bytes),
    })
}
fn scope_record(scope: &Value, hash: &str) -> Result<crate::pool_gate::Record, Status> {
    let s = storage(scope);
    crate::pool_gate::Record::new(
        text(&s, "volume_handle")?,
        hash,
        &format!(
            "LVM-{}{}",
            text(&s, "volume_group_uuid")?.replace('-', ""),
            text(&s, "lv_uuid")?.replace('-', "")
        ),
    )
}
fn zero(scope: &Value) -> Result<crate::pool_device::ZeroDevice, Status> {
    let s = storage(scope);
    crate::pool_device::zero_thin(
        text(&s, "volume_group_uuid")?,
        text(&s, "lv_uuid")?,
        text(&s, "volume_handle")?,
        text(&s["profile"], "pool_uuid")?,
        scope["thin_id"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(refused)?,
    )
    .map_err(|_| refused())
}
fn survey(record: &crate::pool_gate::Record, scope: &Value, device: u64) -> Result<(), Status> {
    let s = storage(scope);
    let observation = crate::pool_inspector::inspect(
        record,
        text(&s, "volume_group_uuid")?,
        text(&s, "lv_uuid")?,
        device,
        crate::pool_device::Backend::Thin {
            pool_uuid: text(&s["profile"], "pool_uuid")?.to_owned(),
            thin_id: scope["thin_id"]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(refused)?,
        },
    )?;
    if !observation.aliases.is_empty() || !observation.named_namespace_scan_complete {
        return Err(refused());
    }
    Ok(())
}
fn owner_path(device: u64) -> Result<File, Status> {
    use std::os::unix::fs::FileTypeExt;
    let actual = std::fs::canonicalize(format!(
        "/sys/dev/block/{}:{}",
        libc::major(device),
        libc::minor(device)
    ))
    .map_err(|_| refused())?;
    let name = actual
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|n| {
            n.starts_with("dm-") && !n[3..].is_empty() && n[3..].bytes().all(|b| b.is_ascii_digit())
        })
        .ok_or_else(refused)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(format!("/dev/{name}"))
        .map_err(|_| refused())?;
    let meta = file.metadata().map_err(|_| refused())?;
    if !meta.file_type().is_block_device() || meta.rdev() != device {
        return Err(refused());
    }
    Ok(file)
}
/// Fixed private-payload worker: retain only the existing lock and an O_PATH descriptor.
/// It cannot mount, resume or obtain a tenant write grant.
pub fn owner_worker(path: &Path) -> Result<(), Status> {
    let request: OwnerRequest = crate::pool_worker::private_payload(path)?;
    if request.v != 1
        || unsafe { libc::geteuid() } != 0
        || std::fs::read_dir("/proc/self/task")
            .map_err(|_| refused())?
            .take(2)
            .count()
            != 1
    {
        return Err(refused());
    }
    let grant = local_claims(
        &request.input,
        request.settings.cloudflare.as_ref().ok_or_else(refused)?,
    )?;
    if grant["challenge"]["gate"] != "finite_creator_fence"
        || grant["challenge"]["producer"] != HOST_PRODUCER
        || request.input["pending_progress"]
            .as_array()
            .is_none_or(|p| !p.is_empty())
    {
        return Err(refused());
    }
    let remaining = grant["exp"]
        .as_u64()
        .ok_or_else(refused)?
        .saturating_sub(now());
    let gate = crate::pool_gate::GateRoot::open(Path::new(crate::pool_gate::ROOT))?;
    let record = scope_record(&grant["scope"], text(&grant, "scope_sha256")?)?;
    let _lock = gate.lock_until(
        &record.volume_handle,
        Instant::now() + Duration::from_millis(remaining),
    )?;
    let before = zero(&grant["scope"])?;
    let _path = owner_path(before.device)?;
    if !before.still_zero().map_err(|_| refused())? {
        return Err(refused());
    }
    let proof = record_proof(&record)?;
    let body = serde_json::to_vec(&proof).map_err(|_| refused())?;
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&body)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|_| refused())?;
    while now() < grant["exp"].as_u64().ok_or_else(refused)? {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
struct Owner {
    child: tokio::process::Child,
    stdout: Option<tokio::process::ChildStdout>,
    _payload: Option<crate::pool_runtime::Payload>,
}
static OWNER: LazyLock<tokio::sync::Mutex<Option<Owner>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));
/// Cancellation retains the handle/payload until an actual wait confirms descriptor closure.
pub async fn reap_pending_owner() -> Result<(), Status> {
    let mut state = OWNER.lock().await;
    if let Some(owner) = state.as_mut() {
        owner.child.start_kill().map_err(|_| refused())?;
        if owner.child.try_wait().map_err(|_| refused())?.is_none() {
            return Err(refused());
        }
        state.take();
    }
    Ok(())
}
async fn start_owner(
    settings: &Settings,
    input: &Value,
    deadline: Instant,
) -> Result<RecordProof, Status> {
    reap_pending_owner().await?;
    let mut state = tokio::time::timeout_at(deadline.into(), OWNER.lock())
        .await
        .map_err(|_| refused())?;
    let payload = crate::pool_runtime::Payload::create(&OwnerRequest {
        v: 1,
        settings: settings.clone(),
        input: input.clone(),
    })?;
    let mut child = tokio::process::Command::new(std::env::current_exe().map_err(|_| refused())?)
        .arg("--pool-qualification-owner-worker")
        .arg(&payload.path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| refused())?;
    let stdout = child.stdout.take().ok_or_else(refused)?;
    *state = Some(Owner {
        child,
        stdout: Some(stdout),
        _payload: Some(payload),
    });
    let stdout = state
        .as_mut()
        .ok_or_else(refused)?
        .stdout
        .take()
        .ok_or_else(refused)?;
    let mut reader = tokio::io::BufReader::new(stdout.take(4097));
    let mut bytes = Vec::new();
    tokio::time::timeout_at(deadline.into(), reader.read_until(b'\n', &mut bytes))
        .await
        .map_err(|_| refused())?
        .map_err(|_| refused())?;
    if bytes.len() > 4096 || bytes.last() != Some(&b'\n') {
        return Err(refused());
    }
    serde_json::from_slice(&bytes).map_err(|_| refused())
}
async fn kill_owner(deadline: Instant) -> Result<(), Status> {
    let mut state = OWNER.lock().await;
    let owner = state.as_mut().ok_or_else(refused)?;
    owner.child.start_kill().map_err(|_| refused())?;
    let exit = tokio::time::timeout_at(deadline.into(), owner.child.wait())
        .await
        .map_err(|_| refused())?
        .map_err(|_| refused())?;
    state.take();
    if exit.signal() != Some(libc::SIGKILL) {
        return Err(refused());
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    v: u8,
    run_id: String,
    scope_sha256: String,
    nonce_sha256: String,
    report: Value,
    denials: Value,
}
fn ready_path(grant: &Value) -> Result<PathBuf, Status> {
    Ok(Path::new(crate::pool_gate::ROOT).join(format!(
        "{}.qualification",
        crate::pool_gate::digest(
            format!(
                "{}:{}:{}",
                text(&grant["scope"], "run_id")?,
                text(grant, "scope_sha256")?,
                text(&grant["challenge"], "nonce")?
            )
            .as_bytes()
        )
    )))
}
fn save_ready(path: &Path, ready: &Ready) -> Result<(), Status> {
    let bytes = serde_json::to_vec(ready).map_err(|_| refused())?;
    if bytes.len() > 16384 {
        return Err(refused());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| refused())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| refused())?;
    File::open(path.parent().ok_or_else(refused)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| refused())?;
    Ok(())
}
fn load_ready(path: &Path, grant: &Value) -> Result<Ready, Status> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| refused())?;
    let m = file.metadata().map_err(|_| refused())?;
    if !m.is_file()
        || m.uid() != 0
        || m.nlink() != 1
        || m.mode() & 0o7777 != 0o600
        || m.len() > 16384
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    file.take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    let r: Ready = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if r.v != 1
        || r.run_id != text(&grant["scope"], "run_id")?
        || r.scope_sha256 != text(grant, "scope_sha256")?
        || r.nonce_sha256
            != crate::pool_gate::digest(text(&grant["challenge"], "nonce")?.as_bytes())
        || !qualification::validate("PostgresPoolQualificationProgressReport", &r.report)
    {
        return Err(refused());
    }
    Ok(r)
}
fn envelope(grant: &Value, started: u64) -> Value {
    let scope = &grant["scope"];
    let challenge = &grant["challenge"];
    json!({"run_id":scope["run_id"],"scope_sha256":grant["scope_sha256"],"sequence":challenge["sequence"],"nonce":challenge["nonce"],"producer":HOST_PRODUCER,"node_uid":grant["execution"]["node_uid"],"boot_id":grant["execution"]["boot_id"],"candidate_spec_sha256":grant["execution"]["candidate_spec_sha256"],"started_at":started,"observed_at":now()})
}
/// Execute only the node half of the existing finite challenge. Missing controller
/// pieces return no report; pq1 never grants a filesystem write or device resume.
pub async fn finite_creator(
    settings: &Settings,
    client: &Client,
    input: &Value,
) -> Result<Option<Value>, Status> {
    let grant = claims(input, client)?;
    if grant["challenge"]["gate"] != "finite_creator_fence"
        || grant["challenge"]["producer"] != HOST_PRODUCER
    {
        return Err(refused());
    }
    let progress = input["pending_progress"].as_array().ok_or_else(refused)?;
    let nonce_hash = crate::pool_gate::digest(text(&grant["challenge"], "nonce")?.as_bytes());
    let phases = [
        "node_fence_ready",
        "driver_delete_intent",
        "driver_restarted",
        "snapshot_create_intent",
        "snapshot_created",
        "snapshot_removed",
    ];
    if progress.len() > 6
        || progress.iter().enumerate().any(|(i, p)| {
            p["sequence"] != grant["challenge"]["sequence"]
                || p["nonce_sha256"] != nonce_hash
                || p["progress"]["phase"] != phases[i]
        })
    {
        return Err(refused());
    }
    let path = ready_path(&grant)?;
    if progress.is_empty() {
        if path.exists() {
            return Ok(Some(load_ready(&path, &grant)?.report));
        }
        crate::pool_child::reap().await?;
        let started = now();
        let deadline = Instant::now()
            + Duration::from_millis(
                grant["exp"]
                    .as_u64()
                    .ok_or_else(refused)?
                    .saturating_sub(started),
            );
        let driver = crate::pool_driver::verify(
            settings,
            text(&grant["execution"], "driver_image")?,
            text(&grant["execution"], "driver_sha256")?,
        )
        .await?;
        if driver.pod_uid != grant["execution"]["driver_pod_uid"] {
            return Err(refused());
        }
        let record = scope_record(&grant["scope"], text(&grant, "scope_sha256")?)?;
        let before = zero(&grant["scope"])?;
        survey(&record, &grant["scope"], before.device)?;
        let proof = start_owner(settings, input, deadline).await?;
        let (publish, expand, killed) = tokio::join!(
            crate::pool_csi::publish(&record, &driver, false),
            crate::pool_csi::expand(&record, &driver),
            async {
                tokio::task::yield_now().await;
                kill_owner(deadline).await
            }
        );
        killed?;
        let denials = serde_json::to_value([publish?, expand?]).map_err(|_| refused())?;
        let after = record_proof(&record)?;
        if proof.inode != after.inode || proof.sha256 != after.sha256 {
            return Err(refused());
        }
        let current = zero(&grant["scope"])?;
        if current.device != before.device {
            return Err(refused());
        }
        survey(&record, &grant["scope"], current.device)?;
        let mut report = envelope(&grant, started);
        report["progress"] = json!({"gate":"finite_creator_fence","phase":"node_fence_ready","source_generation":grant["scope"]["database_generation"].as_u64().and_then(|n|n.checked_sub(1)).ok_or_else(refused)?,"volume_handle":record.volume_handle,"driver_sha256":driver.executable_sha256,"deny_record_inode":after.inode,"deny_record_sha256":after.sha256,"deny_record_scope_sha256":record.scope_sha256,"deny_record_fsync_errno":0,"agent_owner_deaths":1,"before_claim_requests_completed":2,"surviving_creation_descriptors":0,"dm_open_count":0,"foreign_mounts":0,"named_namespace_scan_errno":0});
        claims(input, client)?;
        if !qualification::validate("PostgresPoolQualificationProgressReport", &report) {
            return Err(refused());
        }
        save_ready(
            &path,
            &Ready {
                v: 1,
                run_id: text(&grant["scope"], "run_id")?.to_owned(),
                scope_sha256: text(&grant, "scope_sha256")?.to_owned(),
                nonce_sha256: nonce_hash,
                report: report.clone(),
                denials,
            },
        )?;
        return Ok(Some(report));
    }
    let ready = load_ready(&path, &grant)?;
    if progress[0]["progress"] != ready.report["progress"] {
        return Err(refused());
    }
    if progress.len() != 6 {
        return Ok(None);
    }
    final_creator(settings, client, input, &grant, &ready)
        .await
        .map(Some)
}

async fn lvm_inventory(
    settings: &Settings,
    driver: &crate::pool_driver::Driver,
    scope: &Value,
    expires: u64,
) -> Result<Value, Status> {
    driver.recheck()?;
    let executable = PathBuf::from(format!("/proc/{}/root/sbin/lvm", driver.pid));
    if crate::policy::digest(&executable)? != LVM_BINARY_SHA256 {
        return Err(refused());
    }
    let remaining = expires.saturating_sub(now());
    if remaining == 0 {
        return Err(refused());
    }
    let channel = crate::transport::connect(&settings.containerd_socket).await?;
    let response = tokio::time::timeout(
        Duration::from_millis(remaining.min(5000)),
        crate::cri::runtime_service_client::RuntimeServiceClient::new(channel)
            .max_decoding_message_size(1100000)
            .exec_sync(crate::cri::ExecSyncRequest {
                container_id: driver.container_id.clone(),
                cmd: vec![
                    "/sbin/lvm".into(),
                    "lvs".into(),
                    "--readonly".into(),
                    "--nohints".into(),
                    "--reportformat".into(),
                    "json".into(),
                    "--all".into(),
                    "--options".into(),
                    "vg_uuid,lv_uuid,lv_name,lv_attr,origin_uuid,pool_lv_uuid".into(),
                    "--select".into(),
                    format!("vg_uuid={}", text(&scope["volume"], "volume_group_uuid")?),
                ],
                timeout: 5,
            }),
    )
    .await
    .map_err(|_| refused())?
    .map_err(|_| refused())?
    .into_inner();
    driver.recheck()?;
    if response.exit_code != 0
        || !response.stderr.is_empty()
        || response.stdout.len() > 1048576
        || crate::policy::digest(&executable)? != LVM_BINARY_SHA256
    {
        return Err(refused());
    }
    serde_json::from_slice(&response.stdout).map_err(|_| refused())
}
async fn final_creator(
    settings: &Settings,
    client: &Client,
    input: &Value,
    grant: &Value,
    ready: &Ready,
) -> Result<Value, Status> {
    reap_pending_owner().await?;
    crate::pool_child::reap().await?;
    let started = now();
    let scope = &grant["scope"];
    let progress = input["pending_progress"].as_array().ok_or_else(refused)?;
    let restarted = &progress[2]["progress"];
    let created = &progress[4]["progress"];
    let removed = &progress[5]["progress"];
    let first = &progress[0]["progress"];
    if started.saturating_add(5000) < progress[5]["received_at"].as_u64().ok_or_else(refused)?
        || created["snapshot_name"] != format!("pgcf-q-{}", &text(grant, "scope_sha256")?[..24])
        || created["snapshot_uid"] != removed["snapshot_uid"]
        || created["source_volume_handle"] != scope["volume"]["volume_handle"]
        || removed["source_volume_handle"] != scope["volume"]["volume_handle"]
    {
        return Err(refused());
    }
    let driver = crate::pool_driver::verify(
        settings,
        text(&grant["execution"], "driver_image")?,
        text(&grant["execution"], "driver_sha256")?,
    )
    .await?;
    if driver.pod_uid != restarted["driver_pod_uid_after_restart"]
        || driver.pod_uid != grant["execution"]["driver_pod_uid"]
        || restarted["driver_pod_uid_before_restart"] == restarted["driver_pod_uid_after_restart"]
        || restarted["driver_image"] != grant["execution"]["driver_image"]
    {
        return Err(refused());
    }
    let record = scope_record(scope, text(grant, "scope_sha256")?)?;
    let root = crate::pool_gate::GateRoot::open(Path::new(crate::pool_gate::ROOT))?;
    let deadline = Instant::now()
        + Duration::from_millis(
            grant["exp"]
                .as_u64()
                .ok_or_else(refused)?
                .saturating_sub(started),
        );
    let _lock = root.lock_until(&record.volume_handle, deadline)?;
    let before = record_proof(&record)?;
    if before.inode != first["deny_record_inode"].as_u64().ok_or_else(refused)?
        || before.sha256 != first["deny_record_sha256"]
        || first["deny_record_scope_sha256"] != grant["scope_sha256"]
    {
        return Err(refused());
    }
    let initial = zero(scope)?;
    survey(&record, scope, initial.device)?;
    let first_inventory = lvm_inventory(
        settings,
        &driver,
        scope,
        grant["exp"].as_u64().ok_or_else(refused)?,
    )
    .await?;
    let second_inventory = lvm_inventory(
        settings,
        &driver,
        scope,
        grant["exp"].as_u64().ok_or_else(refused)?,
    )
    .await?;
    if first_inventory != second_inventory {
        return Err(refused());
    }
    let count = physical::snapshot_count(
        &second_inventory,
        text(&scope["volume"], "volume_group_uuid")?,
        text(&scope["volume"], "lv_uuid")?,
        text(&scope["storage"], "pool_uuid")?,
        text(&scope["volume"], "volume_handle")?,
        text(created, "snapshot_name")?,
    )?;
    if count != 0 {
        return Err(refused());
    }
    let physical_observed_at = now();
    let current = zero(scope)?;
    if current.device != initial.device {
        return Err(refused());
    }
    survey(&record, scope, current.device)?;
    let after = record_proof(&record)?;
    if before.inode != after.inode
        || before.sha256 != after.sha256
        || !current.still_zero().map_err(|_| refused())?
    {
        return Err(refused());
    }
    let host = input["accepted_evidence"]
        .as_array()
        .and_then(|a| a.first())
        .filter(|e| e["measurement"]["gate"] == "host_mount_context")
        .ok_or_else(refused)?;
    let expected = &host["measurement"]["storage_observation"]["kernel_proof"];
    if expected["device_major"] != libc::major(current.device)
        || expected["device_minor"] != libc::minor(current.device)
    {
        return Err(refused());
    }
    let mut denials = ready
        .denials
        .as_array()
        .filter(|a| a.len() == 2)
        .ok_or_else(refused)?
        .clone();
    denials
        .push(json!({"operation":"volume_reconcile","error":restarted["volume_reconcile_error"]}));
    denials.push(json!({"operation":"snapshot_create","error":removed["error"],"snapshot_uid":removed["snapshot_uid"],"source_volume_handle":removed["source_volume_handle"],"state_at_denial":removed["state_at_denial"],"requested_at":removed["requested_at"],"deleted_at":removed["deleted_at"],"absent_at":removed["absent_at"]}));
    let measurement = json!({"gate":"finite_creator_fence","binding_id":null,"source_generation":first["source_generation"],"volume_handle":record.volume_handle,"driver_sha256":driver.executable_sha256,"deny_record_inode_before_restart":first["deny_record_inode"],"deny_record_inode_after_restart":after.inode,"deny_record_sha256_before_restart":first["deny_record_sha256"],"deny_record_sha256_after_restart":after.sha256,"deny_record_scope_sha256":record.scope_sha256,"deny_record_fsync_errno":0,"driver_restarts":1,"driver_pod_uid_before_restart":restarted["driver_pod_uid_before_restart"],"driver_pod_uid_after_restart":restarted["driver_pod_uid_after_restart"],"driver_daemonset_uid":restarted["driver_daemonset_uid"],"driver_image":restarted["driver_image"],"driver_deleted_at":restarted["driver_deleted_at"],"driver_replacement_ready_at":restarted["driver_replacement_ready_at"],"agent_owner_deaths":first["agent_owner_deaths"],"before_claim_requests_completed":first["before_claim_requests_completed"],"denied_operations":denials,"surviving_creation_descriptors":0,"final_dm_open_count":0,"physical_snapshot_count":count,"physical_observed_at":physical_observed_at,"progress_sha256":qualification::progress_hash(&input["pending_progress"]).ok_or_else(refused)?,"device_major":libc::major(current.device),"device_minor":libc::minor(current.device)});
    claims(input, client)?;
    driver.recheck()?;
    if !qualification::validate("PostgresPoolQualificationMeasurement", &measurement) {
        return Err(refused());
    }
    let mut report = envelope(grant, started);
    report["measurement"] = measurement;
    if !qualification::validate("PostgresPoolQualificationReport", &report) {
        return Err(refused());
    }
    Ok(report)
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
        || challenge["producer"] != HOST_PRODUCER
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
        json!({"run_id":scope["run_id"],"scope_sha256":grant["scope_sha256"],"sequence":challenge["sequence"],"nonce":challenge["nonce"],"producer":HOST_PRODUCER,"node_uid":grant["execution"]["node_uid"],"boot_id":grant["execution"]["boot_id"],"candidate_spec_sha256":grant["execution"]["candidate_spec_sha256"],"started_at":issued,"observed_at":now(),"measurement":measurement}),
    )
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    #[test]
    fn readonly_lvm_pin_matches_the_qualified_storage_source_lock() {
        let locked: Value =
            serde_json::from_str(include_str!("../../../infra/storage/sources.lock.json")).unwrap();
        assert_eq!(locked["driver"]["lvm_binary_sha256"], LVM_BINARY_SHA256);
    }
    #[tokio::test]
    async fn owned_lock_worker_death_requires_actual_sigkill_and_wait() {
        let child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exec sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        *OWNER.lock().await = Some(Owner {
            child,
            stdout: None,
            _payload: None,
        });
        kill_owner(Instant::now() + Duration::from_secs(5))
            .await
            .unwrap();
        assert!(OWNER.lock().await.is_none());
    }
    #[test]
    fn canonical_node_challenge_and_report_use_the_same_producer() {
        let challenge = &qualification::CONTRACT["fixture"]["claims"]["challenge"];
        assert_eq!(challenge["gate"], "host_mount_context");
        assert_eq!(challenge["producer"], HOST_PRODUCER);
        let schema = &qualification::CONTRACT["schemas"]["PostgresPoolQualificationReport"]["properties"]
            ["producer"];
        assert!(
            jsonschema::validator_for(schema)
                .unwrap()
                .is_valid(&json!(HOST_PRODUCER))
        );
    }
    #[test]
    fn signed_progress_is_bound_before_any_node_action() {
        let pending = qualification::CONTRACT["fixture"]["progress"].clone();
        let hash = qualification::progress_hash(&pending).unwrap();
        let mut claims = qualification::CONTRACT["fixture"]["claims"].clone();
        claims["progress_sha256"] = hash.into();
        let mut input = json!({"scope":claims["scope"],"scope_sha256":claims["scope_sha256"],"challenge":claims["challenge"],"pending_progress":pending});
        assert!(claims_match(&input, &claims));
        input["pending_progress"][0]["received_at"] = input["pending_progress"][0]["received_at"]
            .as_u64()
            .unwrap()
            .saturating_add(1)
            .into();
        assert!(!claims_match(&input, &claims));
    }
}
