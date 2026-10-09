// SPDX-License-Identifier: Apache-2.0
//! Real disposable Linux/containerd/runc boundary and PostgreSQL expiry proof. No fleet/CF/CNPG acceptance.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_sandbox_controller::{
    containerd::{
        services::{containers::v1 as containers, sandbox::v1 as sandbox, tasks::v1 as tasks},
        types::{Sandbox, sandbox::Runtime},
    },
    controller::SandboxController,
    cri,
    slot::Settings,
    transport::{connect, namespaced},
};
use prost::Message;
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Command, Stdio},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tonic::transport::Server;

const NS: &str = "pgcf-proof";
const STORAGE_DATABASE: &str = "abcdefghijklmnopqrst";
fn pod_uid(name: &str) -> String {
    format!(
        "33333333-3333-4333-8333-33333333333{}",
        match name {
            "tenant-a" => 1,
            "tenant-b" => 2,
            _ => 3,
        }
    )
}
fn storage_snapshot(
    local: &pgcf_sandbox_controller::policy::Cloudflare,
    expires: u64,
    startup: Option<u64>,
    token: Option<String>,
) -> serde_json::Value {
    json!({"purpose":"pgcf-storage-host/v1","boot_id":fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),"node_uid":local.node_uid,"material_revision":local.material_revision,"issued_at":pgcf_sandbox_controller::policy::now_ms() as u64,"expires_at":expires,"legacy":[],"databases":[{"database_id":STORAGE_DATABASE,"generation":1,"authority_revision":1,"write_blocked":false,"desired_state":"running","startup_operation_id":startup.map(|_|"op_abcdefghijklmnopqrst"),"volume":null,"node_uid":local.node_uid,"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","profile_sha256":"a".repeat(64),"startup_expires_at":startup,"runtime_authority":token}]})
}
static PROC_ROOT: OnceLock<PathBuf> = OnceLock::new();
fn namespace(
    pid: u32,
    kind: &str,
) -> Result<pgcf_node_runtime::protocol::NamespaceIdentity, tonic::Status> {
    use std::os::fd::AsFd;
    let path = PROC_ROOT
        .get()
        .expect("CRI proc context observed")
        .join(format!("{pid}/ns/{kind}"));
    let file = fs::File::open(path)
        .map_err(|_| tonic::Status::failed_precondition("independent_namespace_missing"))?;
    pgcf_node_runtime::linux::namespace_identity(file.as_fd())
        .map_err(|_| tonic::Status::failed_precondition("independent_namespace_invalid"))
}

fn cmd(binary: &str, args: &[&str]) {
    let output = Command::new(binary).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "owned local command failed: {binary}, {:?}",
        output.status.code()
    );
}
fn pod_config(name: &str) -> cri::PodSandboxConfig {
    cri::PodSandboxConfig {
        metadata: Some(cri::PodSandboxMetadata {
            name: name.into(),
            namespace: if name == "tenant-c" {
                format!("pgcf-db-{STORAGE_DATABASE}")
            } else {
                "pgcf-proof".into()
            },
            uid: pod_uid(name),
            attempt: 0,
        }),
        hostname: name.into(),
        linux: Some(cri::LinuxPodSandboxConfig {
            security_context: Some(cri::LinuxSandboxSecurityContext {
                namespace_options: Some(cri::NamespaceOption {
                    network: cri::NamespaceMode::Pod as i32,
                    ipc: cri::NamespaceMode::Pod as i32,
                    pid: cri::NamespaceMode::Container as i32,
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    }
}
fn fresh_lease(
    mut lease: pgcf_sandbox_controller::policy::Lease,
    local: &pgcf_sandbox_controller::policy::Cloudflare,
    seconds: i64,
) -> Result<pgcf_sandbox_controller::policy::Authority, tonic::Status> {
    let now = time::OffsetDateTime::now_utc();
    let format = time::format_description::well_known::Rfc3339;
    lease.issued_at = now.format(&format).unwrap();
    lease.updated_at = lease.issued_at.clone();
    lease.node_observed_at = lease.issued_at.clone();
    lease.expires_at = (now + time::Duration::seconds(seconds))
        .format(&format)
        .unwrap();
    pgcf_sandbox_controller::policy::Authority::validate(
        lease,
        local,
        pgcf_sandbox_controller::policy::now_ms(),
    )
}
// This driver exists only in the disposable example. Product main always obtains authority over HTTPS.
struct ProofController {
    child: std::process::Child,
    lease: pgcf_sandbox_controller::policy::Lease,
    base: PathBuf,
}
impl Drop for ProofController {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn atomic(
    path: &std::path::Path,
    value: &impl serde::Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    let temporary = path.with_extension("pending");
    fs::write(&temporary, serde_json::to_vec(value)?)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(temporary, path)?;
    Ok(())
}
impl ProofController {
    async fn spawn(
        settings: Settings,
        lease: pgcf_sandbox_controller::policy::Lease,
        local: pgcf_sandbox_controller::policy::Cloudflare,
        base: PathBuf,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        atomic(&base.join("settings.json"), &settings)?;
        let authority = fresh_lease(lease.clone(), &local, 30)?;
        atomic(&base.join("lease.json"), &authority.lease)?;
        let _ = fs::remove_file(base.join("snapshot.json"));
        let child = Command::new(std::env::current_exe()?)
            .arg("--owned-controller-host")
            .arg(&base)
            .stdout(Stdio::null())
            .stderr(fs::File::create(base.join("controller-child.log"))?)
            .spawn()?;
        let driver = Self {
            child,
            lease: authority.lease,
            base,
        };
        driver.maintain().await?;
        Ok(driver)
    }
    async fn snapshot(&self) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(bytes) = fs::read(self.base.join("snapshot.json"))
                && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
                && value["epoch"] == self.lease.issued_at
            {
                return Ok(value);
            }
            assert!(
                Instant::now() < deadline,
                "owned controller did not publish current observation"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    async fn inventory(&self) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
        Ok(self.snapshot().await?["inventory"].clone())
    }
    async fn observation(&self) -> Result<Option<serde_json::Value>, Box<dyn std::error::Error>> {
        let value = self.snapshot().await?["observation"].clone();
        Ok((!value.is_null()).then_some(value))
    }
    async fn refresh(
        &mut self,
        authority: pgcf_sandbox_controller::policy::Authority,
    ) -> Result<(), Box<dyn std::error::Error>> {
        self.lease = authority.lease;
        atomic(&self.base.join("lease.json"), &self.lease)?;
        self.snapshot().await?;
        Ok(())
    }
    async fn maintain(&self) -> Result<(), Box<dyn std::error::Error>> {
        let requested = pgcf_sandbox_controller::policy::now_ms() as i64;
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let value = self.snapshot().await?;
            let expires = time::OffsetDateTime::parse(
                &self.lease.expires_at,
                &time::format_description::well_known::Rfc3339,
            )?;
            let target = if expires > time::OffsetDateTime::now_utc() {
                self.lease.policy.target_slots as usize
            } else {
                0
            };
            if value["sample_ms"]
                .as_i64()
                .is_some_and(|sample| sample >= requested)
                && value["inventory"]["available"]
                    .as_array()
                    .is_some_and(|slots| slots.len() == target)
            {
                return Ok(());
            }
            assert!(
                Instant::now() < deadline,
                "owned controller did not reconcile real pool"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
async fn child_controller(base: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    let settings: Settings = serde_json::from_slice(&fs::read(base.join("settings.json"))?)?;
    let mut local = settings.cloudflare.clone().unwrap();
    let controller = SandboxController::prepare(settings.clone()).await?;
    let listener = tokio::net::UnixListener::bind(&settings.socket)?;
    let service = controller.clone();
    let server = tokio::spawn(async move {
        Server::builder()
            .add_service(sandbox::controller_server::ControllerServer::new(service))
            .serve_with_incoming(tokio_stream::wrappers::UnixListenerStream::new(listener))
            .await
    });
    let mut epoch = String::new();
    let client = pgcf_sandbox_controller::policy::Client::new(local.clone())?;
    let (configuration_sender, mut configuration_updates) = tokio::sync::watch::channel(client);
    let configuration_task = tokio::spawn(pgcf_sandbox_controller::configuration::run(
        base.join("settings.json"),
        settings.clone(),
        controller.clone(),
        configuration_sender,
    ));
    let (storage_sender, storage_receiver) = tokio::sync::mpsc::channel(1);
    tokio::spawn(pgcf_sandbox_controller::storage::supervise_bound(
        controller.clone(),
        storage_receiver,
    ));
    let mut storage_epoch = Vec::new();
    let host = pgcf_sandbox_controller::host_proc::HostProc::inherited()?;
    let mut reclaim_proved = false;
    loop {
        if configuration_updates.has_changed().unwrap_or(false) {
            local = configuration_updates.borrow_and_update().local().clone();
        }
        if !reclaim_proved && let Ok(bytes) = fs::read(base.join("reclaim-proof.json")) {
            let request: serde_json::Value = serde_json::from_slice(&bytes)?;
            let cri_pid = request["cri_pid"].as_u64().unwrap() as u32;
            let candidate = pgcf_sandbox_controller::reclaim_inventory::Candidate {
                database_id: STORAGE_DATABASE.into(),
                namespace: format!("pgcf-db-{STORAGE_DATABASE}"),
                pod_uid: pod_uid("tenant-c"),
                container_id: request["container_id"].as_str().unwrap().into(),
                cri_pid,
                start_ticks: pgcf_sandbox_controller::slot::start_ticks(cri_pid)?,
                pid_namespace: pgcf_sandbox_controller::slot::namespace(cri_pid, "pid")?,
                cgroup_path: request["cgroup_path"].as_str().unwrap().into(),
                postgres_image_id: request["image"].as_str().unwrap().into(),
            };
            let trust: pgcf_sandbox_controller::policy::StorageAuthorityTrust =
                serde_json::from_slice(&fs::read(base.join("storage-trust.json"))?)?;
            let verifier = pgcf_native_protocol::reclaim::Trust::new(
                &serde_json::to_string(&trust.keys)?,
                &trust.sha256,
            )
            .unwrap();
            let scope = verifier
                .verify(
                    request["token"].as_str().unwrap(),
                    pgcf_sandbox_controller::policy::now_ms() as u64,
                )
                .unwrap();
            pgcf_sandbox_controller::reclaim_inventory::delegate_reclaim(
                &candidate,
                &scope,
                &local.node_uid,
                &host.boot_id()?,
            )?;
            let snapshot = pgcf_sandbox_controller::reclaim_inventory::snapshot_candidates(
                &host,
                &local.node_uid,
                vec![candidate],
            )?;
            assert_eq!(snapshot["tasks"].as_array().unwrap().len(), 1);
            assert_ne!(
                snapshot["pid_namespace_inode"],
                snapshot["cri_pid_namespace_inode"]
            );
            pgcf_sandbox_controller::reclaim_inventory::publish_public("tasks", &snapshot)?;
            atomic(
                &base.join("reclaim-ready.json"),
                &json!({"controller_pid":std::process::id(),"mapped_host_pid":snapshot["tasks"][0]["pid"],"cri_pid":cri_pid}),
            )?;
            reclaim_proved = true;
        }
        if let Ok(bytes) = fs::read(base.join("storage-lease.json"))
            && bytes != storage_epoch
        {
            storage_sender.send(serde_json::from_slice(&bytes)?).await?;
            storage_epoch = bytes;
        }
        let lease: pgcf_sandbox_controller::policy::Lease =
            serde_json::from_slice(&fs::read(base.join("lease.json"))?)?;
        if lease.issued_at != epoch && lease.material_revision == local.material_revision {
            controller
                .refresh(pgcf_sandbox_controller::policy::Authority::validate(
                    lease.clone(),
                    &local,
                    pgcf_sandbox_controller::policy::now_ms(),
                )?)
                .await?;
            epoch = lease.issued_at;
        }
        controller.maintain().await?;
        let protective_scope_present = controller
            .storage_guard()
            .unwrap()
            .lock()
            .await
            .protection(&format!("pgcf-db-{STORAGE_DATABASE}"), &pod_uid("tenant-c"))
            .is_some();
        let storage_create_permitted = controller
            .storage_guard()
            .unwrap()
            .lock()
            .await
            .permits_create(
                &format!("pgcf-db-{STORAGE_DATABASE}"),
                &pod_uid("tenant-c"),
                pgcf_sandbox_controller::policy::now_ms() as u64,
            );
        atomic(
            &base.join("snapshot.json"),
            &json!({"protective_scope_present":protective_scope_present,"material_revision":local.material_revision,"controller_pid":std::process::id(),"storage_create_permitted":storage_create_permitted,"epoch":epoch,"sample_ms":pgcf_sandbox_controller::policy::now_ms() as i64,"inventory":controller.inventory().await?,"observation":controller.observation().await?}),
        )?;
        if server.is_finished() || configuration_task.is_finished() {
            return Err("owned controller service exited".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--owned-unprivileged-access") {
        let args = std::env::args().collect::<Vec<_>>();
        assert_eq!(unsafe { libc::unshare(libc::CLONE_NEWCGROUP) }, 0);
        let last = fs::read_to_string("/proc/sys/kernel/cap_last_cap")?
            .trim()
            .parse::<i32>()?;
        assert!(last <= 63);
        for capability in 0..=last {
            assert_eq!(
                unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) },
                0
            );
        }
        assert_eq!(unsafe { libc::setgroups(0, std::ptr::null()) }, 0);
        assert_eq!(unsafe { libc::setgid(65532) }, 0);
        assert_eq!(unsafe { libc::setuid(65532) }, 0);
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
            0
        );
        let own = fs::read_to_string("/proc/self/status")?;
        for field in ["CapEff:", "CapPrm:", "CapInh:", "CapAmb:", "CapBnd:"] {
            assert_eq!(
                own.lines()
                    .find_map(|line| line.strip_prefix(field))
                    .unwrap()
                    .trim(),
                "0000000000000000"
            );
        }
        let public: serde_json::Value =
            serde_json::from_slice(&fs::read("/run/pgcf-reclaim-input/reclaim.json")?)?;
        assert_eq!(public["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(
            fs::write("/run/pgcf-reclaim-input/tamper", b"no")
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let task = &public["tasks"][0];
        assert_eq!(
            pgcf_sandbox_controller::slot::start_ticks(task["cri_pid"].as_u64().unwrap() as u32)?,
            task["start_ticks"].as_u64().unwrap()
        );
        for path in [&args[3], &args[4]] {
            assert_eq!(
                std::os::unix::net::UnixStream::connect(path)
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        for path in [&args[5], &args[6]] {
            assert_eq!(
                fs::read(path).unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        for name in ["memory.max", "cgroup.procs", "cgroup.kill"] {
            assert_eq!(
                fs::OpenOptions::new()
                    .write(true)
                    .open(PathBuf::from(&args[2]).join(name))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        use std::io::Write;
        let mut control = fs::OpenOptions::new()
            .write(true)
            .open(PathBuf::from(&args[2]).join("memory.reclaim"))?;
        match control.write_all(b"4096") {
            Ok(()) => {}
            Err(error) => assert_eq!(error.raw_os_error(), Some(libc::EAGAIN)),
        };
        println!(
            "{{\"unprivileged\":true,\"private_sockets_denied\":true,\"private_config_denied\":true,\"other_cgroup_controls_denied\":true,\"delegated_reclaim_only\":true}}"
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("--owned-controller-host") {
        let base = PathBuf::from(std::env::args().nth(2).unwrap());
        let code = pgcf_sandbox_controller::host_context::launch(
            &base.join("settings.json"),
            &["--owned-controller".into(), base.into_os_string()],
        )?;
        std::process::exit(code);
    }
    pgcf_sandbox_controller::host_context::seal_inherited_handles()?;
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run())
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("--owned-controller") {
        return child_controller(PathBuf::from(std::env::args().nth(2).unwrap())).await;
    }
    // The disposable outer container owns this entire private cgroup namespace.
    // Move only this proof process before enabling child controllers for real runc tasks.
    fs::create_dir("/sys/fs/cgroup/pgcf-proof-supervisor")?;
    fs::write(
        "/sys/fs/cgroup/pgcf-proof-supervisor/cgroup.procs",
        std::process::id().to_string(),
    )?;
    fs::write(
        "/sys/fs/cgroup/cgroup.subtree_control",
        "+memory +pids +cpu",
    )?;
    let base = PathBuf::from("/run/pgcf-proof");
    fs::create_dir(&base)?;
    fs::set_permissions(&base, fs::Permissions::from_mode(0o700))?;
    let daemon_socket = base.join("containerd.sock");
    let controller_socket = base.join("controller.sock");
    let config = format!(
        "version=3\nroot=\"/run/pgcf-proof/containerd-root\"\nstate=\"/run/pgcf-proof/containerd-state\"\ndisabled_plugins=[\"io.containerd.cri.v1.images\",\"io.containerd.cri.v1.runtime\"]\n[grpc]\naddress=\"{}\"\n[proxy_plugins.pgcf]\ntype=\"sandbox\"\naddress=\"{}\"\n",
        daemon_socket.display(),
        controller_socket.display()
    );
    fs::write(base.join("containerd.toml"), config)?;
    let log = fs::File::create(base.join("daemon.log"))?;
    let mut daemon = Command::new("unshare")
        .args(["-m", "-p", "-f", "--mount-proc", "containerd", "--address"])
        .arg(&daemon_socket)
        .arg("--config")
        .arg(base.join("containerd.toml"))
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !daemon_socket.exists() {
        assert!(
            Instant::now() < deadline,
            "actual containerd failed to start"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let generated: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/contracts/native/compute-pool.generated.json"
    ))?;
    let mut lease: pgcf_sandbox_controller::policy::Lease =
        serde_json::from_value(generated["lease"].clone())?;
    let storage_key = Ed25519KeyPair::from_pkcs8(
        Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref(),
    )
    .unwrap();
    let keys = std::collections::BTreeMap::from([(
        "fixture-cf".to_owned(),
        URL_SAFE_NO_PAD.encode(storage_key.public_key().as_ref()),
    )]);
    let trust = pgcf_sandbox_controller::policy::StorageAuthorityTrust {
        sha256: Sha256::digest(serde_json::to_vec(&keys)?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        keys,
        legacy_database_ids: Vec::new(),
    };
    atomic(&base.join("storage-trust.json"), &trust)?;
    let key_path = base.join("fixture-agent-key");
    fs::write(&key_path, format!("pgcf_ak_{}_fixture", lease.region_id))?;
    fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
    let mut local = pgcf_sandbox_controller::policy::Cloudflare {
        api_url: "https://api.invalid".into(),
        agent_key_file: key_path,
        node_id: lease.node_id.clone(),
        node_uid: lease.node_uid.clone(),
        region_id: lease.region_id.clone(),
        material_revision: lease.material_revision,
        image: lease.policy.profile.image.clone(),
        cgroup_root: "/sys/fs/cgroup/pgcf-proof-idle".into(),
        storage_authority: Some(trust.clone()),
    };
    lease.policy.profile.holder_sha256 = pgcf_sandbox_controller::policy::digest(&PathBuf::from(
        "/usr/local/bin/pgcf-node-runtime",
    ))?;
    lease.policy.profile.controller_sha256 =
        pgcf_sandbox_controller::policy::digest(&std::env::current_exe()?)?;
    lease.policy.profile.architecture = std::env::consts::ARCH
        .replace("aarch64", "arm64")
        .replace("x86_64", "amd64");
    let settings = Settings {
        socket: controller_socket.clone(),
        state: base.join("slots"),
        shim_sockets: base.join("s"),
        containerd_socket: daemon_socket.clone(),
        containerd_binary: "/usr/local/bin/containerd".into(),
        shim_binary: "/usr/local/bin/containerd-shim-runc-v2".into(),
        runc_binary: "/usr/local/bin/runc".into(),
        holder_binary: "/usr/local/bin/pgcf-node-runtime".into(),
        namespace: NS.into(),
        slots: 0,
        slot_lifetime_ms: 300000,
        cloudflare: Some(local.clone()),
        budget: None,
        runtime_profile: None,
    };
    let cri_host_pid = pgcf_sandbox_controller::host_context::discover(&settings)?;
    let cri_pid_namespace = pgcf_sandbox_controller::slot::namespace(cri_host_pid, "pid")?;
    assert_ne!(
        cri_pid_namespace,
        pgcf_sandbox_controller::slot::namespace(std::process::id(), "pid")?
    );
    assert_ne!(
        pgcf_sandbox_controller::slot::namespace(cri_host_pid, "mnt")?,
        pgcf_sandbox_controller::slot::namespace(std::process::id(), "mnt")?
    );
    PROC_ROOT
        .set(pgcf_sandbox_controller::host_context::process_root(cri_host_pid).join("proc"))
        .unwrap();
    let mut controller =
        ProofController::spawn(settings.clone(), lease.clone(), local.clone(), base.clone())
            .await?;
    let before = controller.inventory().await?;
    let before: Vec<pgcf_sandbox_controller::slot::Identity> =
        serde_json::from_value(before["available"].clone())?;
    assert_eq!(before.len(), 2);
    for identity in &before {
        for fd in [197, 198] {
            assert!(
                !PROC_ROOT
                    .get()
                    .unwrap()
                    .join(format!("{}/fd/{fd}", identity.pid))
                    .exists(),
                "prepared holder inherited privileged host handles"
            );
        }
        assert_eq!(namespace(identity.pid, "pid")?, cri_pid_namespace);
        assert_eq!(
            namespace(identity.pid, "net")?.inode,
            identity.network_inode
        );
        assert_eq!(namespace(identity.pid, "ipc")?.inode, identity.ipc_inode);
        assert_eq!(namespace(identity.pid, "uts")?.inode, identity.uts_inode);
    }
    let daemon_channel = connect(&daemon_socket).await?;
    let mut store = sandbox::store_client::StoreClient::new(daemon_channel.clone());
    let mut runtime = sandbox::controller_client::ControllerClient::new(daemon_channel.clone());
    let mut direct_runtime =
        sandbox::controller_client::ControllerClient::new(connect(&controller_socket).await?);
    let mut container_client =
        containers::containers_client::ContainersClient::new(daemon_channel.clone());
    let mut tasks = tasks::tasks_client::TasksClient::new(daemon_channel.clone());
    let mut evidence = Vec::new();
    let mut storage_stop_ms = 0.0;
    for name in ["tenant-a", "tenant-b", "tenant-c"] {
        if name == "tenant-c" {
            lease.policy.target_slots = 0;
            controller
                .refresh(fresh_lease(lease.clone(), &local, 30)?)
                .await?;
        }
        controller.maintain().await?;
        let before: Vec<pgcf_sandbox_controller::slot::Identity> =
            serde_json::from_value(controller.inventory().await?["available"].clone())?;
        cmd(
            "nsenter",
            &[
                &format!("--mount=/proc/{cri_host_pid}/ns/mnt"),
                &format!("--pid=/proc/{cri_host_pid}/ns/pid"),
                "--",
                "ip",
                "netns",
                "add",
                name,
            ],
        );
        let subject = Sandbox {
            sandbox_id: name.into(),
            runtime: Some(Runtime {
                name: "io.containerd.runc.v2".into(),
                options: None,
            }),
            sandboxer: "pgcf".into(),
            labels: HashMap::new(),
            ..Default::default()
        };
        store
            .create(namespaced(
                sandbox::StoreCreateRequest {
                    sandbox: Some(subject.clone()),
                },
                NS,
            )?)
            .await?;
        let request = sandbox::ControllerCreateRequest {
            sandbox_id: name.into(),
            netns_path: format!("/run/netns/{name}"),
            options: Some(prost_types::Any {
                type_url: "runtime.v1.PodSandboxConfig".into(),
                value: pod_config(name).encode_to_vec(),
            }),
            sandbox: Some(subject),
            sandboxer: "pgcf".into(),
            ..Default::default()
        };
        if name == "tenant-c" {
            assert_eq!(
                runtime
                    .create(namespaced(request.clone(), NS)?)
                    .await
                    .unwrap_err()
                    .code(),
                tonic::Code::PermissionDenied
            );
            let expires = pgcf_sandbox_controller::policy::now_ms() as u64 + 60000;
            atomic(
                &base.join("storage-lease.json"),
                &storage_snapshot(&local, expires, Some(expires), None),
            )?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if controller.snapshot().await?["storage_create_permitted"] == true {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "real shared startup guard did not authorize the held task"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let started = Instant::now();
        runtime.create(namespaced(request.clone(), NS)?).await?;
        assert_eq!(
            runtime
                .create(namespaced(request, NS)?)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::AlreadyExists
        );
        let mut assigned = runtime
            .start(namespaced(
                sandbox::ControllerStartRequest {
                    sandbox_id: name.into(),
                    sandboxer: "pgcf".into(),
                },
                NS,
            )?)
            .await?
            .into_inner();
        let assignment_ms = started.elapsed().as_secs_f64() * 1000.;
        // The daemon's public wrapper omits these fields in 2.3.6. Its CRI
        // in-memory client uses this actual remote controller endpoint directly.
        let status = direct_runtime
            .status(namespaced(
                sandbox::ControllerStatusRequest {
                    sandbox_id: name.into(),
                    sandboxer: "pgcf".into(),
                    verbose: true,
                },
                NS,
            )?)
            .await?
            .into_inner();
        assert_eq!(status.state, "SANDBOX_READY");
        assert_eq!(assigned.pid, status.pid);
        assert_eq!(status.version, 3);
        assigned.address = status.address.clone();
        assigned.version = status.version;
        if name == "tenant-c" {
            assert!(before.is_empty());
            assert_eq!(status.info["pgcf_compute_source"], "on_demand");
        } else {
            let prepared_identity = before
                .iter()
                .find(|identity| identity.pid == assigned.pid)
                .expect("same independently observed pre-request holder required");
            assert_eq!(prepared_identity.task_address, assigned.address);
            assert_eq!(status.info["pgcf_compute_source"], "prestarted");
        }
        let process_status = fs::read_to_string(
            PROC_ROOT
                .get()
                .unwrap()
                .join(format!("{}/status", assigned.pid)),
        )?;
        for field in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] {
            assert_eq!(
                process_status
                    .lines()
                    .find_map(|line| line.strip_prefix(&format!("{field}:")))
                    .unwrap()
                    .trim(),
                "0000000000000000"
            );
        }
        assert_eq!(
            process_status
                .lines()
                .find_map(|line| line.strip_prefix("NoNewPrivs:"))
                .unwrap()
                .trim(),
            "1"
        );
        let prepared = fs::read_dir(base.join("slots"))?
            .map(|p| p.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(prepared.contains(status.info.get("pgcf_slot_id").unwrap()));
        assert_eq!(
            status.info["pgcf_prestarted_holder_pid"],
            assigned.pid.to_string()
        );
        let sql = name == "tenant-c";
        let rootfs = if sql {
            PathBuf::from("/fixtures/postgres")
        } else {
            base.join(format!("{name}-rootfs"))
        };
        let data = base.join(format!("{name}-PGDATA"));
        fs::create_dir_all(&rootfs)?;
        fs::create_dir(&data)?;
        for part in ["bin", "proc", "dev", "data"] {
            fs::create_dir_all(rootfs.join(part))?;
        }
        if !sql {
            fs::copy("/bin/busybox.static", rootfs.join("bin/busybox"))?;
        }
        fs::write(data.join("marker"), format!("committed-{name}"))?;
        let task_id = if sql {
            "c".repeat(64)
        } else {
            format!("{name}-postgres-boundary")
        };
        let cg = if sql {
            format!("/kubepods/burstable/pod{}/{task_id}", pod_uid(name))
        } else {
            format!("/pgcf-proof-{name}")
        };
        let mut spec = json!({"ociVersion":"1.2.1","root":{"path":rootfs,"readonly":true},"process":{"terminal":false,"user":{"uid":0,"gid":0},"args":["/bin/busybox","sh","-c","test -f /data/marker && /bin/busybox cat /data/marker && /bin/busybox sleep 60"],"env":["PATH=/bin"],"cwd":"/","capabilities":{"bounding":[],"effective":[],"permitted":[],"inheritable":[],"ambient":[]},"noNewPrivileges":true,"rlimits":[{"type":"RLIMIT_NOFILE","soft":1024,"hard":1024}]},"mounts":[{"destination":"/proc","type":"proc","source":"proc"},{"destination":"/dev","type":"tmpfs","source":"tmpfs"},{"destination":"/data","type":"bind","source":data,"options":["rbind","ro","nosuid","nodev"]}],"linux":{"cgroupsPath":cg,"resources":{"memory":{"limit":33554432},"pids":{"limit":16}},"namespaces":[{"type":"pid"},{"type":"mount"},{"type":"network","path":format!("/proc/{}/ns/net",assigned.pid)},{"type":"ipc","path":format!("/proc/{}/ns/ipc",assigned.pid)},{"type":"uts","path":format!("/proc/{}/ns/uts",assigned.pid)}]}});
        if sql {
            use std::os::unix::ffi::OsStrExt;
            let directory = std::ffi::CString::new(data.as_os_str().as_bytes())?;
            assert_eq!(unsafe { libc::chown(directory.as_ptr(), 26, 26) }, 0);
            let script = r#"set -eu
initdb -D /data/db --username=postgres --no-locale --encoding=UTF8 --auth=trust >/data/init.log 2>&1
postgres -D /data/db -k /data -c listen_addresses='' -c shared_buffers=8MB -c max_connections=10 >/data/postgres.log 2>&1 &
server=$!
until pg_isready -h /data -U postgres >/dev/null 2>&1; do sleep 0.1; done
psql -X -h /data -U postgres -v ON_ERROR_STOP=1 -c "CREATE TABLE committed_marker(v text); INSERT INTO committed_marker VALUES ('committed-tenant-c');" >/data/setup.log
psql -X -h /data -U postgres -tAc 'SELECT v FROM committed_marker' >/data/sql-committed
cat /data/sql-committed
PGAPPNAME=lease-long-sql psql -X -h /data -U postgres -v ON_ERROR_STOP=1 -c 'SELECT pg_sleep(60)' >/data/long-query.log 2>&1 &
long=$!
until test "$(psql -X -h /data -U postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE application_name='lease-long-sql' AND wait_event='PgSleep'")" = 1; do sleep 0.1; done
printf active >/data/sql-active
wait "$long"
printf returned >/data/sql-returned
wait "$server"
"#;
            // This is the unchanged pinned PostgreSQL engine; fixture data/authority never enter a product image.
            spec["process"]["user"] = json!({"uid":26,"gid":26});
            spec["process"]["args"] = json!(["/bin/bash", "-c", script]);
            spec["process"]["env"] =
                json!(["PATH=/usr/lib/postgresql/18/bin:/usr/bin:/bin", "LANG=C"]);
            spec["mounts"][2]["options"] = json!(["rbind", "rw", "nosuid", "nodev"]);
            spec["mounts"].as_array_mut().unwrap().extend([json!({"destination":"/dev/null","type":"bind","source":"/dev/null","options":["bind","rw"]}),json!({"destination":"/dev/shm","type":"tmpfs","source":"tmpfs","options":["size=64m","mode=1777"]})]);
            spec["linux"]["resources"]["memory"]["limit"] = json!(134217728);
            spec["linux"]["resources"]["pids"]["limit"] = json!(32);
            let expiry = pgcf_sandbox_controller::policy::now_ms() as u64 + 90000;
            atomic(
                &base.join("storage-lease.json"),
                &storage_snapshot(&local, expiry, Some(expiry), None),
            )?;
        }
        container_client
            .create(namespaced(
                containers::CreateContainerRequest {
                    container: Some(containers::Container {
                        id: task_id.clone(),
                        runtime: Some(containers::container::Runtime {
                            name: "io.containerd.runc.v2".into(),
                            options: None,
                        }),
                        spec: Some(prost_types::Any {
                            type_url: "types.containerd.io/opencontainers/runtime-spec/1/Spec"
                                .into(),
                            value: serde_json::to_vec(&spec)?,
                        }),
                        sandbox: name.into(),
                        ..Default::default()
                    }),
                },
                NS,
            )?)
            .await?;
        let output = base.join(format!("{name}-stdout"));
        fs::File::create(&output)?;
        let created = tasks
            .create(namespaced(
                tasks::CreateTaskRequest {
                    container_id: task_id.clone(),
                    stdout: format!("file://{}", output.display()),
                    stderr: format!("file://{}", output.display()),
                    task_api_address: assigned.address.clone(),
                    task_api_version: 3,
                    ..Default::default()
                },
                NS,
            )?)
            .await?
            .into_inner();
        tasks
            .start(namespaced(
                tasks::StartRequest {
                    container_id: task_id.clone(),
                    exec_id: String::new(),
                },
                NS,
            )?)
            .await?;
        assert_eq!(
            namespace(created.pid, "net")?,
            namespace(assigned.pid, "net")?
        );
        assert_eq!(
            namespace(created.pid, "ipc")?,
            namespace(assigned.pid, "ipc")?
        );
        assert_eq!(
            namespace(created.pid, "uts")?,
            namespace(assigned.pid, "uts")?
        );
        assert_ne!(
            namespace(created.pid, "pid")?,
            namespace(assigned.pid, "pid")?
        );
        assert_eq!(
            fs::read_to_string(format!("/sys/fs/cgroup{cg}/memory.max"))?.trim(),
            if sql { "134217728" } else { "33554432" }
        );
        let deadline = Instant::now() + Duration::from_secs(if sql { 60 } else { 3 });
        while !fs::read_to_string(&output)?.contains(&format!("committed-{name}")) {
            assert!(
                Instant::now() < deadline,
                "actual late-bound data was not read"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let contents = fs::read_to_string(&output)?;
        assert!(!contents.contains(if name == "tenant-a" {
            "tenant-b"
        } else {
            "tenant-a"
        }));
        evidence.push(json!({"subject":name,"holder_pid":assigned.pid,"shim_pid":status.info["pgcf_prestarted_shim_pid"],"task_pid":created.pid,"task_endpoint":assigned.address,"assignment_ms":assignment_ms,"assignment_mode":status.info["pgcf_compute_source"],"late_bound_marker":true,"private_pid_and_mount_namespace":true,"memory_limit_enforced":true}));
        if name == "tenant-b" {
            controller.maintain().await?;
            controller.maintain().await?;
            let observation = controller.observation().await?.unwrap();
            assert!(
                observation["idle_memory_current_bytes"]
                    .as_u64()
                    .is_some_and(|value| value > 0 && value <= 128 * 1048576)
            );
            assert!(observation["idle_cpu_usage_usec"].is_u64());
            controller
                .refresh(fresh_lease(lease.clone(), &local, 1)?)
                .await?;
            tokio::time::sleep(Duration::from_millis(1200)).await;
            controller.maintain().await?;
            assert!(
                controller.inventory().await?["available"]
                    .as_array()
                    .unwrap()
                    .is_empty()
            );
            assert!(namespace(created.pid, "net").is_ok());
            assert_eq!(
                direct_runtime
                    .status(namespaced(
                        sandbox::ControllerStatusRequest {
                            sandbox_id: name.into(),
                            sandboxer: "pgcf".into(),
                            verbose: false
                        },
                        NS
                    )?)
                    .await?
                    .into_inner()
                    .state,
                "SANDBOX_READY"
            );
            controller
                .refresh(fresh_lease(lease.clone(), &local, 30)?)
                .await?;
            controller.maintain().await?;
            controller.maintain().await?;
            let discarded: Vec<pgcf_sandbox_controller::slot::Identity> =
                serde_json::from_value(controller.inventory().await?["available"].clone())?;
            assert_eq!(discarded.len(), 2);
            drop(controller);
            fs::remove_file(&controller_socket)?;
            controller = ProofController::spawn(
                settings.clone(),
                lease.clone(),
                local.clone(),
                base.clone(),
            )
            .await?;
            for slot in discarded {
                assert!(namespace(slot.pid, "net").is_err());
            }
            let recovered = controller.inventory().await?;
            assert_eq!(recovered["assigned"].as_array().unwrap().len(), 1);
            assert_eq!(recovered["assigned"][0]["identity"]["pid"], assigned.pid);
            assert_eq!(recovered["assigned"][0]["live"], true);
            assert!(namespace(created.pid, "net").is_ok());
            direct_runtime = sandbox::controller_client::ControllerClient::new(
                connect(&controller_socket).await?,
            );
            assert_eq!(
                direct_runtime
                    .status(namespaced(
                        sandbox::ControllerStatusRequest {
                            sandbox_id: name.into(),
                            sandboxer: "pgcf".into(),
                            verbose: true
                        },
                        NS
                    )?)
                    .await?
                    .into_inner()
                    .pid,
                assigned.pid
            );
            controller
                .refresh(fresh_lease(lease.clone(), &local, 30)?)
                .await?;
            controller.maintain().await?;
            controller.maintain().await?;
            assert_eq!(
                controller.inventory().await?["available"]
                    .as_array()
                    .unwrap()
                    .len(),
                2
            );
        }
        if sql {
            let deadline = Instant::now() + Duration::from_secs(60);
            while !data.join("sql-active").exists() {
                assert!(
                    Instant::now() < deadline,
                    "actual PostgreSQL long SQL did not enter PgSleep"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(
                fs::read_to_string(data.join("sql-committed"))?.trim(),
                "committed-tenant-c"
            );
            let image = option_env!("PGCF_POSTGRES_FIXTURE_IMAGE")
                .ok_or("qualified fixture image metadata missing")?;
            let clock = pgcf_sandbox_controller::policy::now_ms() as u64;
            let reclaim = json!({"v":1,"kid":"fixture-cf","database_id":STORAGE_DATABASE,"operation_id":"op_abcdefghijklmnopqrst","intent_revision":1,"generation":1,"storage_generation":1,"node_uid":local.node_uid,"boot_id":fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim(),"cluster_uid":"77777777-7777-4777-8777-777777777777","namespace_uid":"88888888-8888-4888-8888-888888888888","cnpg_cluster_uid":"99999999-9999-4999-8999-999999999999","storage_uid":"44444444-4444-4444-8444-444444444444","pvc_uid":"55555555-5555-4555-8555-555555555555","pv_uid":"66666666-6666-4666-8666-666666666666","pod_uid":pod_uid(name),"container_id":task_id,"postgres_image_sha256":image.rsplit("sha256:").next().unwrap(),"mode":"reclaim","budget_bytes":4096,"step_bytes":4096,"memory_request_bytes":67108864,"memory_limit_bytes":134217728,"issued_at":clock,"expires_at":clock+5000});
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&reclaim)?);
            let contract: serde_json::Value = serde_json::from_str(include_str!(
                "../../../packages/contracts/native/reclaim.generated.json"
            ))?;
            let signed = storage_key.sign(
                format!(
                    "{}{body}",
                    contract["constants"]["RECLAIM_DOMAIN"].as_str().unwrap()
                )
                .as_bytes(),
            );
            let reclaim_token = format!("rc1.{body}.{}", URL_SAFE_NO_PAD.encode(signed.as_ref()));
            atomic(
                &base.join("reclaim-proof.json"),
                &json!({"cri_pid":created.pid,"container_id":task_id,"cgroup_path":cg,"image":image,"token":reclaim_token}),
            )?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while !base.join("reclaim-ready.json").exists() {
                assert!(
                    Instant::now() < deadline,
                    "actual host/CRI task mapping was not published"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let ready: serde_json::Value =
                serde_json::from_slice(&fs::read(base.join("reclaim-ready.json"))?)?;
            let secret = base.join("fixture-private-config");
            fs::write(&secret, b"fixture-only-private")?;
            fs::set_permissions(&secret, fs::Permissions::from_mode(0o600))?;
            let output = Command::new("nsenter")
                .args([
                    format!("--mount=/proc/{cri_host_pid}/ns/mnt"),
                    format!("--pid=/proc/{cri_host_pid}/ns/pid"),
                    "--".into(),
                    "/usr/local/bin/pgcf-containerd-proof".into(),
                    "--owned-unprivileged-access".into(),
                    format!("/sys/fs/cgroup{cg}"),
                    controller_socket.to_string_lossy().into_owned(),
                    assigned
                        .address
                        .strip_prefix("ttrpc+unix://")
                        .unwrap()
                        .to_owned(),
                    secret.to_string_lossy().into_owned(),
                    format!(
                        "/proc/{}/root{}",
                        ready["controller_pid"].as_u64().unwrap(),
                        secret.display()
                    ),
                ])
                .output()?;
            if !output.status.success() {
                eprintln!(
                    "owned_unprivileged_failure: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            assert!(
                output.status.success(),
                "least-privilege reclaimer kernel boundary failed"
            );
            let checked: serde_json::Value = serde_json::from_slice(&output.stdout)?;
            assert_eq!(checked["delegated_reclaim_only"], true);
            let now = pgcf_sandbox_controller::policy::now_ms() as u64;
            let expires = now + 8000;
            let claims = pgcf_native_protocol::storage::StorageWriteClaims {
                v: 1,
                kid: "fixture-cf".into(),
                database_id: STORAGE_DATABASE.into(),
                generation: 1,
                authority_revision: 1,
                storage_uid: "44444444-4444-4444-8444-444444444444".into(),
                node_uid: local.node_uid.clone(),
                volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef".into(),
                pool_uuid: "bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg".into(),
                profile_sha256: "a".repeat(64),
                volume_handle: "pvc-55555555-5555-4555-8555-555555555555".into(),
                lv_uuid: "cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh".into(),
                pvc_uid: "55555555-5555-4555-8555-555555555555".into(),
                pv_uid: "66666666-6666-4666-8666-666666666666".into(),
                pod_uid: pod_uid(name),
                observed_at: now,
                iat: now,
                exp: expires,
                guard_seconds: 10,
                drain_seconds: 1,
                write_allowed: true,
            };
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);
            let signed = storage_key.sign(
                format!(
                    "{}{body}",
                    pgcf_native_protocol::wire("storageAuthorityDomain")
                )
                .as_bytes(),
            );
            let token = format!("sa1.{body}.{}", URL_SAFE_NO_PAD.encode(signed.as_ref()));
            let started = Instant::now();
            atomic(
                &base.join("storage-lease.json"),
                &storage_snapshot(&local, expires, None, Some(token)),
            )?;
            // Consume an authenticated material-only file update while the real SQL task is alive.
            tokio::time::sleep(Duration::from_millis(400)).await;
            let before_refresh = controller.snapshot().await?;
            let mut next_settings = settings.clone();
            local.material_revision += 1;
            next_settings.cloudflare = Some(local.clone());
            atomic(&base.join("settings.json"), &next_settings)?;
            lease.material_revision = local.material_revision;
            let next_authority = fresh_lease(lease.clone(), &local, 30)?;
            atomic(&base.join("lease.json"), &next_authority.lease)?;
            controller.lease = next_authority.lease;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let observed: serde_json::Value =
                    serde_json::from_slice(&fs::read(base.join("snapshot.json"))?)?;
                if observed["material_revision"] == local.material_revision {
                    assert_eq!(observed["controller_pid"], before_refresh["controller_pid"]);
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "authenticated material reload was not observed by the running controller"
                );
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(
                tasks
                    .get(namespaced(
                        tasks::GetRequest {
                            container_id: task_id.clone(),
                            exec_id: String::new()
                        },
                        NS
                    )?)
                    .await?
                    .into_inner()
                    .process
                    .unwrap()
                    .status,
                2
            );
            // No new storage authority or Kubernetes API exists; the unchanged monotonic expiry must still stop SQL.
            tokio::time::timeout(
                Duration::from_millis(9000),
                tasks.wait(namespaced(
                    tasks::WaitRequest {
                        container_id: task_id.clone(),
                        exec_id: String::new(),
                    },
                    NS,
                )?),
            )
            .await??;
            storage_stop_ms = (started.elapsed().as_secs_f64() * 1000. - 8000.).max(0.);
            assert!(
                storage_stop_ms < 1000.,
                "actual local SQL task exceeded configured drain bound"
            );
            assert!(
                !data.join("sql-returned").exists(),
                "long SQL unexpectedly completed before the host expiry stop"
            );
        }
        if !sql {
            runtime
                .stop(namespaced(
                    sandbox::ControllerStopRequest {
                        sandbox_id: name.into(),
                        sandboxer: "pgcf".into(),
                        timeout_secs: 3,
                    },
                    NS,
                )?)
                .await?;
        }
        let exited = tasks
            .wait(namespaced(
                tasks::WaitRequest {
                    container_id: task_id.clone(),
                    exec_id: String::new(),
                },
                NS,
            )?)
            .await?
            .into_inner();
        assert_eq!(exited.exit_status, 137);
        tasks
            .delete(namespaced(
                tasks::DeleteTaskRequest {
                    container_id: task_id.clone(),
                },
                NS,
            )?)
            .await?;
        container_client
            .delete(namespaced(
                containers::DeleteContainerRequest { id: task_id },
                NS,
            )?)
            .await?;
        if sql {
            runtime
                .stop(namespaced(
                    sandbox::ControllerStopRequest {
                        sandbox_id: name.into(),
                        sandboxer: "pgcf".into(),
                        timeout_secs: 3,
                    },
                    NS,
                )?)
                .await?;
        }
        runtime
            .shutdown(namespaced(
                sandbox::ControllerShutdownRequest {
                    sandbox_id: name.into(),
                    sandboxer: "pgcf".into(),
                },
                NS,
            )?)
            .await?;
        if sql {
            let owner_path = settings
                .state
                .join(&status.info["pgcf_slot_id"])
                .join("owner.json");
            let owner: serde_json::Value = serde_json::from_slice(
                &fs::read(owner_path)
                    .map_err(|_| "normal CRI remove discarded its signed physical scope")?,
            )?;
            assert_eq!(owner["retired"], true);
            assert_eq!(owner["pod_uid"], pod_uid(name));
            assert!(
                owner["protective_storage_authority"]
                    .as_str()
                    .is_some_and(|token| token.starts_with("sa1."))
            );
        }
        store
            .delete(namespaced(
                sandbox::StoreDeleteRequest {
                    sandbox_id: name.into(),
                },
                NS,
            )?)
            .await?;
        cmd(
            "nsenter",
            &[
                &format!("--mount=/proc/{cri_host_pid}/ns/mnt"),
                &format!("--pid=/proc/{cri_host_pid}/ns/pid"),
                "--",
                "ip",
                "netns",
                "delete",
                name,
            ],
        );
    }
    let removed_at = pgcf_sandbox_controller::policy::now_ms() as i64;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let observed = controller.snapshot().await?;
        if observed["sample_ms"]
            .as_i64()
            .is_some_and(|at| at >= removed_at)
            && observed["inventory"]["assigned"]
                .as_array()
                .unwrap()
                .is_empty()
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "normal CRI removal was not freshly observed"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        controller.snapshot().await?["protective_scope_present"],
        true
    );
    drop(controller);
    fs::remove_file(&controller_socket)?;
    fs::remove_file(base.join("reclaim-proof.json"))?;
    fs::remove_file(base.join("reclaim-ready.json"))?;
    let mut restart_settings = settings.clone();
    restart_settings.cloudflare = Some(local.clone());
    controller =
        ProofController::spawn(restart_settings, lease.clone(), local.clone(), base.clone())
            .await?;
    assert!(
        controller.inventory().await?["assigned"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        controller.snapshot().await?["protective_scope_present"],
        true,
        "expired signed scope was not restored for physical protection after normal CRI removal"
    );
    assert_eq!(
        controller.snapshot().await?["storage_create_permitted"],
        false
    );
    assert_ne!(evidence[0]["holder_pid"], evidence[1]["holder_pid"]);
    assert_ne!(evidence[0]["shim_pid"], evidence[1]["shim_pid"]);
    assert!(
        tasks
            .list(namespaced(
                tasks::ListTasksRequest {
                    filter: String::new()
                },
                NS
            )?)
            .await?
            .into_inner()
            .tasks
            .is_empty()
    );
    println!(
        "{}",
        json!({"actual_separate_CRI_PID_and_mount_context":true,"real_containerd":"2.3.6","tenant_free_slots_prestarted":2,"assigned_once":true,"separate_shims":true,"normal_runc_tasks_late_bound":true,"all_tasks_deleted":true,"idle_cgroup_limits_observed":true,"expired_lease_retires_idle_preserves_running_tenant":true,"actual_process_restart_recovers_same_assigned_PID_and_discards_unassigned":true,"bounded_on_demand_miss_verified_separately":true,"background_refill_primitive_verified":true,"actual_PostgreSQL_18_6_long_SQL_stopped_without_CF_or_Kube_API":true,"retired_physical_scope_survives_normal_CRI_remove_and_restart":true,"material_revision_reload_preserves_running_SQL_and_expiry":true,"storage_expiry_stop_ms":storage_stop_ms,"thin_physical_storage_acceptance":false,"readonly_reclaimer_host_CRI_PID_mapping_verified":true,"unprivileged_reclaimer_private_inputs_and_controls_denied":true,"warm_reclaim_acceptance":false,"runc":"1.5.2","evidence":evidence,"CF_CRI_CNI_CNPG_SQL_acceptance":false})
    );
    // Retire remaining unassigned runtimes through actual lease expiry before stopping the disposable daemon.
    controller.refresh(fresh_lease(lease, &local, 1)?).await?;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    controller.maintain().await?;
    drop(controller);
    unsafe { libc::kill(cri_host_pid as i32, libc::SIGKILL) };
    if daemon.try_wait()?.is_none() {
        let _ = daemon.kill();
    }
    daemon.wait()?;
    Ok(())
}
