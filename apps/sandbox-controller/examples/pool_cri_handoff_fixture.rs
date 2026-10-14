// SPDX-License-Identifier: Apache-2.0
//! Disposable pinned containerd/CRI experiment. No fleet, physical-release or live permission proof.
use pgcf_sandbox_controller::{
    cri,
    pool_io::{CapturedGroup, Process},
    transport,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
type Error = Box<dyn std::error::Error>;
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
fn private_file(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let mut f = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn command(command: &mut Command) -> Result<(), Error> {
    let log = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open("/run/pgcf-owned-cri/command.log")?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()?;
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err("fixed owned fixture command failed".into())
            };
        }
        if Instant::now() >= end {
            child.kill()?;
            child.wait()?;
            return Err("fixed owned fixture command expired".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn blob(layout: &Path, value: &[u8], media: &str) -> Result<Value, Error> {
    let hash = digest(value);
    private_file(&layout.join("blobs/sha256").join(&hash), value)?;
    Ok(json!({"mediaType":media,"digest":format!("sha256:{hash}"),"size":value.len()}))
}
fn image(base: &Path) -> Result<PathBuf, Error> {
    let root = base.join("rootfs");
    fs::create_dir(&root)?;
    fs::copy(std::env::current_exe()?, root.join("probe"))?;
    let layer = base.join("layer.tar");
    command(
        Command::new("tar")
            .args(["-C"])
            .arg(&root)
            .args(["-cf"])
            .arg(&layer)
            .arg("."),
    )?;
    let bytes = fs::read(layer)?;
    let layout = base.join("oci");
    fs::create_dir_all(layout.join("blobs/sha256"))?;
    let layer = blob(&layout, &bytes, "application/vnd.oci.image.layer.v1.tar")?;
    let config = json!({"architecture":std::env::consts::ARCH.replace("aarch64","arm64").replace("x86_64","amd64"),"os":"linux","config":{"Entrypoint":["/probe","--resident"]},"rootfs":{"type":"layers","diff_ids":[format!("sha256:{}",digest(&bytes))]}});
    let config = blob(
        &layout,
        &serde_json::to_vec(&config)?,
        "application/vnd.oci.image.config.v1+json",
    )?;
    let manifest = json!({"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":config,"layers":[layer]});
    let mut descriptor = blob(
        &layout,
        &serde_json::to_vec(&manifest)?,
        "application/vnd.oci.image.manifest.v1+json",
    )?;
    descriptor["annotations"] =
        json!({"org.opencontainers.image.ref.name":"pgcf.invalid/handoff:owned"});
    descriptor["platform"] = json!({"os":"linux","architecture":std::env::consts::ARCH.replace("aarch64","arm64").replace("x86_64","amd64")});
    private_file(
        &layout.join("index.json"),
        &serde_json::to_vec(&json!({"schemaVersion":2,"manifests":[descriptor]}))?,
    )?;
    private_file(
        &layout.join("oci-layout"),
        b"{\"imageLayoutVersion\":\"1.0.0\"}",
    )?;
    let tar = base.join("image.tar");
    command(
        Command::new("tar")
            .args(["-C"])
            .arg(layout)
            .args(["-cf"])
            .arg(&tar)
            .arg("."),
    )?;
    fs::set_permissions(&tar, fs::Permissions::from_mode(0o600))?;
    Ok(tar)
}
struct Owned {
    daemon: Child,
    worker: Option<Child>,
}
impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(w) = self.worker.as_mut() {
            let _ = w.kill();
            let _ = w.wait();
        }
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}
async fn pause() {
    tokio::time::sleep(Duration::from_millis(20)).await;
}
fn ready(worker: &mut Child, expected: &str) -> Result<(), Error> {
    let stdout = worker.stdout.take().ok_or("worker stdout missing")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(Duration::from_secs(5))?;
    task.join().map_err(|_| "worker read failed")?;
    if line.trim() != expected {
        return Err("worker original leaf unconfirmed".into());
    }
    Ok(())
}
async fn run(kernel_helper: PathBuf) -> Result<(), Error> {
    // This entire cgroup namespace belongs to this one disposable outer container.
    fs::create_dir("/sys/fs/cgroup/fixture-supervisor")?;
    fs::write(
        "/sys/fs/cgroup/fixture-supervisor/cgroup.procs",
        std::process::id().to_string(),
    )?;
    fs::write(
        "/sys/fs/cgroup/cgroup.subtree_control",
        "+memory +pids +cpu",
    )?;
    let base = Path::new("/run/pgcf-owned-cri");
    fs::DirBuilder::new().mode(0o700).create(base)?;
    let archive = image(base)?;
    let socket = base.join("containerd.sock");
    let config = format!(
        r#"version = 3
root = "/run/pgcf-owned-cri/content"
state = "/run/pgcf-owned-cri/state"
[grpc]
address = "{}"
[plugins."io.containerd.cri.v1.images"]
snapshotter = "native"
[plugins."io.containerd.cri.v1.images".pinned_images]
sandbox = "pgcf.invalid/handoff:owned"
[plugins."io.containerd.cri.v1.runtime"]
disable_apparmor = true
disable_hugetlb_controller = true
enable_cdi = false
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc]
runtime_type = "io.containerd.runc.v2"
snapshotter = "native"
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc.options]
BinaryName = "/pinned/runc"
SystemdCgroup = false
"#,
        socket.display()
    );
    let config_file = base.join("containerd.toml");
    private_file(&config_file, config.as_bytes())?;
    let log = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(base.join("daemon.log"))?;
    let daemon = Command::new("/pinned/containerd")
        .arg("--config")
        .arg(&config_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()?;
    let mut owned = Owned {
        daemon,
        worker: None,
    };
    let end = Instant::now() + Duration::from_secs(10);
    let channel = loop {
        if let Ok(channel) = transport::connect(&socket).await {
            break channel;
        }
        if owned.daemon.try_wait()?.is_some() || Instant::now() >= end {
            return Err("pinned daemon startup unconfirmed".into());
        }
        pause().await;
    };
    let mut runtime = cri::runtime_service_client::RuntimeServiceClient::new(channel);
    let version = runtime
        .version(cri::VersionRequest {
            version: "0.1.0".into(),
        })
        .await?
        .into_inner();
    if version.runtime_name != "containerd"
        || !matches!(version.runtime_version.as_str(), "2.3.6" | "v2.3.6")
    {
        return Err("unexpected runtime version".into());
    }
    command(
        Command::new("/pinned/ctr")
            .arg("--address")
            .arg(&socket)
            .args([
                "--namespace",
                "k8s.io",
                "images",
                "import",
                "--local",
                "--snapshotter",
                "native",
            ])
            .arg(archive),
    )?;
    let pod = fs::read_to_string("/proc/sys/kernel/random/uuid")?
        .trim()
        .to_owned();
    let group = PathBuf::from("/sys/fs/cgroup/kubepods").join(format!("pod{pod}"));
    fs::create_dir_all(&group)?;
    let config = cri::PodSandboxConfig {
        metadata: Some(cri::PodSandboxMetadata {
            name: "owned-handoff".into(),
            uid: pod.clone(),
            namespace: "pgcf-owned-fixture".into(),
            attempt: 0,
        }),
        log_directory: base.join("logs").to_string_lossy().into_owned(),
        linux: Some(cri::LinuxPodSandboxConfig {
            cgroup_parent: format!("/kubepods/pod{pod}"),
            security_context: Some(cri::LinuxSandboxSecurityContext {
                namespace_options: Some(cri::NamespaceOption {
                    network: cri::NamespaceMode::Node.into(),
                    pid: cri::NamespaceMode::Container.into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    fs::create_dir(base.join("logs"))?;
    let sandbox = runtime
        .run_pod_sandbox(cri::RunPodSandboxRequest {
            config: Some(config.clone()),
            runtime_handler: String::new(),
        })
        .await?
        .into_inner()
        .pod_sandbox_id;
    let container = runtime
        .create_container(cri::CreateContainerRequest {
            pod_sandbox_id: sandbox.clone(),
            sandbox_config: Some(config),
            config: Some(cri::ContainerConfig {
                metadata: Some(cri::ContainerMetadata {
                    name: "postgres".into(),
                    attempt: 0,
                }),
                image: Some(cri::ImageSpec {
                    image: "pgcf.invalid/handoff:owned".into(),
                    ..Default::default()
                }),
                log_path: "container.log".into(),
                linux: Some(cri::LinuxContainerConfig {
                    security_context: Some(cri::LinuxContainerSecurityContext {
                        namespace_options: Some(cri::NamespaceOption {
                            network: cri::NamespaceMode::Node.into(),
                            pid: cri::NamespaceMode::Container.into(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            }),
        })
        .await?
        .into_inner()
        .container_id;
    runtime
        .start_container(cri::StartContainerRequest {
            container_id: container.clone(),
        })
        .await?;
    let status = runtime
        .container_status(cri::ContainerStatusRequest {
            container_id: container.clone(),
            verbose: true,
        })
        .await?
        .into_inner();
    let info: Value =
        serde_json::from_str(status.info.get("info").ok_or("actual CRI info absent")?)?;
    let pid = u32::try_from(info["pid"].as_u64().ok_or("actual CRI PID absent")?)?;
    let original = Process::capture(pid, &pod, &container)?;
    assert_eq!(process_identity(pid)?["namespace_pid"], 1);
    let captured = CapturedGroup::restore(&original.group_record())?;
    let files = std::env::temp_dir().join(format!("pgcf-handoff-{pod}"));
    fs::DirBuilder::new().mode(0o700).create(&files)?;
    let record = files.join("record.json");
    private_file(&record, &serde_json::to_vec(&original.group_record())?)?;
    let worker_group = original.directory_path();
    let inode_before = fs::metadata(&worker_group)?.ino();
    let procs = worker_group.join("cgroup.procs");
    let mut worker = Command::new(kernel_helper);
    worker
        .arg("--worker")
        .arg(&record)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    unsafe {
        worker.pre_exec(move || {
            fs::write(&procs, std::process::id().to_string())?;
            Ok(())
        });
    }
    owned.worker = Some(worker.spawn()?);
    ready(owned.worker.as_mut().unwrap(), "joined_original_live_leaf")?;
    let worker_pid = owned.worker.as_ref().unwrap().id();
    let worker_identity = process_identity(worker_pid)?;
    assert_ne!(
        worker_identity["pid_namespace"],
        original.pid_namespace.inode
    );
    assert_eq!(
        Process::capture(worker_pid, &pod, &container)?.cgroup_inode,
        original.cgroup_inode
    );
    assert_eq!(fs::metadata(&worker_group)?.ino(), inode_before);
    private_file(
        &files.join("dispatch.json"),
        &serde_json::to_vec(
            &json!({"phase":"worker_waiting","original":original.group_record(),"worker":worker_identity,"cleanup_cgroup_path":worker_group,"cleanup_cgroup_inode":inode_before}),
        )?,
    )?;
    fs::File::open(&files)?.sync_all()?;
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    assert!(pidfd >= 0);
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd as i32) };
    original.recheck()?;
    let mut client = runtime.clone();
    let id = container.clone();
    let stop_task = tokio::spawn(async move {
        client
            .stop_container(cri::StopContainerRequest {
                container_id: id,
                timeout: 1,
            })
            .await
    });
    let end = Instant::now() + Duration::from_secs(5);
    let mut poll = libc::pollfd {
        fd: pidfd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    while unsafe { libc::poll(&mut poll, 1, 0) } != 1
        || poll.revents & libc::POLLIN == 0
        || namespace_tasks(original.pid_namespace.inode)? != 0
    {
        if Instant::now() >= end {
            return Err("original pidfd/namespace closure unconfirmed".into());
        }
        pause().await;
    }
    assert!(original.recheck().is_err());
    println!(
        "actual_cri_stop_requested=true original_pidfd_exited=true original_pid_namespace_tasks=0 private_pid_namespace_verified=true"
    );
    let worker_exited_on_init_exit = owned.worker.as_mut().unwrap().try_wait()?.is_some();
    let original_leaf_after_exit = captured.recheck().is_ok();
    println!(
        "actual_private_pidns_original_init_exited=true cleanup_worker_exited_after_kernel_exit={worker_exited_on_init_exit} original_leaf_present_after_kernel_exit={original_leaf_after_exit}"
    );
    assert!(!worker_exited_on_init_exit);
    captured.recheck()?;
    assert_eq!(process_identity(worker_pid)?, worker_identity);
    owned
        .worker
        .as_mut()
        .unwrap()
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"confirm_original_tasks_gone\n")?;
    let end = Instant::now() + Duration::from_secs(5);
    while !files.join("sole").exists() {
        if Instant::now() >= end {
            return Err("actual original leaf sole-worker proof absent".into());
        }
        pause().await;
    }
    assert!(!stop_task.is_finished());
    assert_eq!(
        fs::metadata(original.directory_path())?.ino(),
        original.cgroup_inode
    );
    assert_eq!(
        fs::remove_dir(original.directory_path())
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EBUSY)
    );
    println!(
        "original_private_pidns_tasks_zero=true original_exact_leaf_sole_worker_survived=true cri_stop_pending_until_worker_reap=true"
    );
    drop(owned.worker.as_mut().unwrap().stdin.take());
    assert!(owned.worker.as_mut().unwrap().wait()?.success());
    tokio::time::timeout(Duration::from_secs(15), stop_task).await???;
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        let status = runtime
            .container_status(cri::ContainerStatusRequest {
                container_id: container.clone(),
                verbose: false,
            })
            .await?
            .into_inner()
            .status
            .ok_or("CRI status absent")?;
        if status.state == cri::ContainerState::ContainerExited as i32 {
            break;
        }
        if Instant::now() >= end {
            return Err("CRI terminal status after worker reap unconfirmed".into());
        }
        pause().await;
    }
    runtime
        .remove_container(cri::RemoveContainerRequest {
            container_id: container,
        })
        .await?;
    assert!(owned.worker.as_mut().unwrap().try_wait()?.is_some());
    assert!(!original.directory_path().exists());
    assert!(CapturedGroup::restore(&original.group_record()).is_err());
    println!(
        "actual_cri_stop_and_remove_completed_after_worker_reap=true original_leaf_missing=true original_inode_restore_refused=true"
    );
    runtime
        .stop_pod_sandbox(cri::StopPodSandboxRequest {
            pod_sandbox_id: sandbox.clone(),
        })
        .await?;
    runtime
        .remove_pod_sandbox(cri::RemovePodSandboxRequest {
            pod_sandbox_id: sandbox,
        })
        .await?;
    assert!(
        runtime
            .list_containers(cri::ListContainersRequest::default())
            .await?
            .into_inner()
            .containers
            .is_empty()
    );
    assert!(
        runtime
            .list_pod_sandbox(cri::ListPodSandboxRequest::default())
            .await?
            .into_inner()
            .items
            .is_empty()
    );
    let end = Instant::now() + Duration::from_secs(5);
    while fs::read_dir(&group)?.any(|e| e.is_ok_and(|e| e.path().is_dir())) {
        if Instant::now() >= end {
            return Err("owned CRI cgroups remain".into());
        }
        pause().await;
    }
    fs::remove_dir(group)?;
    fs::remove_dir("/sys/fs/cgroup/kubepods")?;
    fs::remove_dir_all(files)?;
    println!(
        "owned_cri_containers_sandboxes_workers_cgroups_cleaned=true storage_release_authorized=false"
    );
    Ok(())
}
fn process_identity(pid: u32) -> Result<Value, Error> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let start = stat
        .rsplit_once(") ")
        .ok_or("process stat invalid")?
        .1
        .split_whitespace()
        .nth(19)
        .ok_or("start ticks absent")?
        .parse::<u64>()?;
    let status = fs::read_to_string(format!("/proc/{pid}/status"))?;
    let namespace_pid = status
        .lines()
        .find_map(|s| s.strip_prefix("NSpid:"))
        .ok_or("NSpid absent")?
        .split_whitespace()
        .last()
        .ok_or("namespace pid absent")?
        .parse::<u32>()?;
    Ok(
        json!({"pid":pid,"namespace_pid":namespace_pid,"start_ticks":start,"pid_namespace":fs::metadata(format!("/proc/{pid}/ns/pid"))?.ino(),"executable_sha256":digest(&fs::read(format!("/proc/{pid}/exe"))?)}),
    )
}
fn namespace_tasks(inode: u64) -> Result<usize, Error> {
    let mut count = 0;
    let mut scanned = 0;
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        if entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
            .is_none()
        {
            continue;
        }
        scanned += 1;
        if scanned > 4096 {
            return Err("owned proc scan overflow".into());
        }
        match fs::metadata(entry.path().join("ns/pid")) {
            Ok(meta) => {
                if meta.ino() == inode {
                    count += 1;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(count)
}
fn main() -> Result<(), Error> {
    match std::env::args().nth(1).as_deref() {
        Some("--resident") => loop {
            std::thread::sleep(Duration::from_secs(60));
        },
        Some("--owned-cri-fixture") => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(async {
                let helper = std::env::args_os()
                    .nth(2)
                    .ok_or("owned kernel helper path required")?;
                tokio::time::timeout(Duration::from_secs(60), run(helper.into())).await?
            }),
        _ => Err("explicit owned CRI fixture command required".into()),
    }
}
