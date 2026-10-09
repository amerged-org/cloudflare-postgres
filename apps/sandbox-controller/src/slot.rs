// SPDX-License-Identifier: Apache-2.0
use crate::{
    containerd::runtime::bootstrap::v1::{BootstrapParams, BootstrapResult},
    transport,
};
use pgcf_node_runtime::{
    linux,
    protocol::{self, Assignment, NamespaceIdentity},
};
use prost::Message;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    mem,
    os::{
        fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    process::Stdio,
    time::SystemTime,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::{Duration, timeout},
};
use tonic::Status;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub socket: PathBuf,
    pub state: PathBuf,
    pub shim_sockets: PathBuf,
    pub containerd_socket: PathBuf,
    pub containerd_binary: PathBuf,
    pub shim_binary: PathBuf,
    pub runc_binary: PathBuf,
    pub holder_binary: PathBuf,
    pub namespace: String,
    pub slots: usize,
    pub slot_lifetime_ms: u64,
    #[serde(default)]
    pub cloudflare: Option<crate::policy::Cloudflare>,
    #[serde(skip)]
    pub budget: Option<crate::cgroup::Budget>,
    #[serde(skip)]
    pub runtime_profile: Option<crate::policy::Profile>,
}
#[derive(Deserialize)]
struct Prepared {
    version: u32,
    event: String,
    slot_id: String,
    pid_namespace_local: u32,
    network_inode: u64,
    ipc_inode: u64,
    uts_inode: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    pub slot: String,
    pub pid: u32,
    pub shim_pid: u32,
    pub task_address: String,
    pub network_inode: u64,
    pub ipc_inode: u64,
    pub uts_inode: u64,
    pub holder_start_ticks: u64,
    pub shim_start_ticks: u64,
}
pub struct Slot {
    pub identity: Identity,
    pub child: Option<Child>,
    pidfd: Option<OwnedFd>,
    shim_pidfd: Option<OwnedFd>,
    pub socket: PathBuf,
    pub directory: PathBuf,
    pub created_at: SystemTime,
    pub prepared_at: std::time::Instant,
    pub lifetime: Duration,
    pub assigned_network: Option<NamespaceIdentity>,
    pub exited_at: Option<SystemTime>,
    pub exit_status: u32,
    _log_reader: LogReader,
    cgroup: Option<PathBuf>,
    budget: Option<crate::cgroup::Budget>,
    pub profile: Option<crate::policy::Profile>,
}
struct LogReader(tokio::task::JoinHandle<()>);
impl Drop for LogReader {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct SetupChild(Option<Child>);
impl Drop for SetupChild {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.start_kill();
        }
    }
}
fn shim_log(directory: &Path) -> Result<tokio::task::JoinHandle<()>, Status> {
    let path = directory.join("log");
    let cpath = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|_| unavailable("shim_log_path_invalid"))?;
    // SAFETY: cpath is a valid owned path in the newly created private slot directory.
    if unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) } < 0 {
        use std::os::unix::fs::FileTypeExt;
        if !fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_fifo()) {
            return Err(unavailable("shim_log_fifo_failed"));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| unavailable("shim_log_open_failed"))?;
    let fd = tokio::io::unix::AsyncFd::new(file)
        .map_err(|_| unavailable("shim_log_registration_failed"))?;
    Ok(tokio::spawn(async move {
        let mut buffer = [0_u8; 4096];
        loop {
            let Ok(mut ready) = fd.readable().await else {
                break;
            };
            let result = ready.try_io(|fd| {
                let read = unsafe {
                    libc::read(
                        fd.get_ref().as_raw_fd(),
                        buffer.as_mut_ptr().cast(),
                        buffer.len(),
                    )
                };
                if read < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(read)
                }
            });
            if let Ok(Ok(0) | Err(_)) = result {
                break;
            }
        }
    }))
}
fn unavailable(code: &'static str) -> Status {
    Status::failed_precondition(code)
}
pub fn ensure_private_directory(path: &Path) -> Result<(), Status> {
    use std::os::unix::fs::MetadataExt;
    if !path.exists() {
        return private_directory(path);
    }
    let meta =
        fs::symlink_metadata(path).map_err(|_| unavailable("private_directory_unavailable"))?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(unavailable("private_directory_identity_invalid"));
    }
    Ok(())
}
pub fn start_ticks(pid: u32) -> Result<u64, Status> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))
        .map_err(|_| unavailable("process_identity_missing"))?;
    stat.rsplit_once(") ")
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| unavailable("process_identity_invalid"))
}
fn pidfd(pid: u32) -> Result<OwnedFd, Status> {
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
    if fd < 0 {
        return Err(unavailable("process_handle_unavailable"));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn handle_live(fd: &OwnedFd) -> Result<bool, Status> {
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let result = unsafe { libc::poll(&mut poll, 1, 0) };
    if result < 0 {
        return Err(unavailable("process_handle_unavailable"));
    }
    Ok(result == 0)
}
fn observed_process(pid: u32, ticks: u64) -> Result<Option<OwnedFd>, Status> {
    if !start_ticks(pid).is_ok_and(|value| value == ticks) {
        return Ok(None);
    }
    let fd = match pidfd(pid) {
        Ok(fd) => fd,
        Err(_) if !start_ticks(pid).is_ok_and(|value| value == ticks) => return Ok(None),
        Err(error) => return Err(error),
    };
    Ok((handle_live(&fd)? && start_ticks(pid).is_ok_and(|value| value == ticks)).then_some(fd))
}
pub fn private_directory(path: &Path) -> Result<(), Status> {
    fs::create_dir(path).map_err(|_| unavailable("new_private_directory_required"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| unavailable("private_directory_mode_failed"))
}
fn private_file(path: &Path, data: &[u8]) -> Result<(), Status> {
    use std::io::Write;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| unavailable("private_file_create_failed"))?;
    file.write_all(data)
        .map_err(|_| unavailable("private_file_write_failed"))
}
pub fn namespace(pid: u32, kind: &str) -> Result<NamespaceIdentity, Status> {
    let file = File::open(format!("/proc/{pid}/ns/{kind}"))
        .map_err(|_| unavailable("namespace_not_present"))?;
    linux::namespace_identity(file.as_fd()).map_err(|_| unavailable("namespace_read_failed"))
}
impl Slot {
    pub async fn prepare(settings: &Settings) -> Result<Self, Status> {
        let mut random = [0_u8; 16];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(|_| unavailable("slot_randomness_failed"))?;
        let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let directory = settings.state.join(&id);
        private_directory(&directory)?;
        let socket = directory.join("control.sock");
        private_file(&directory.join("config.json"), b"{\"annotations\":{}}")?;
        let log_reader = LogReader(shim_log(&directory)?);
        let cgroup = settings
            .budget
            .as_ref()
            .map(|budget| budget.prepare(&id))
            .transpose()?;
        let cgroup_proc = cgroup
            .as_deref()
            .map(crate::cgroup::proc_path)
            .transpose()?;
        let mut command = Command::new(&settings.holder_binary);
        command.args([
            socket
                .to_str()
                .ok_or_else(|| unavailable("socket_path_invalid"))?,
            &id,
            &unsafe { libc::geteuid() }.to_string(),
            &settings.slot_lifetime_ms.to_string(),
        ]);
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(false);
        // SAFETY: the fork child performs only async-signal-safe cgroup syscalls before exec.
        unsafe {
            command.pre_exec(move || {
                if let Some(path) = &cgroup_proc {
                    crate::cgroup::enter_before_exec(path)?;
                }
                Ok(())
            });
        }
        let mut setup = SetupChild(Some(
            command
                .spawn()
                .map_err(|_| unavailable("holder_start_failed"))?,
        ));
        let child = setup.0.as_mut().unwrap();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| unavailable("holder_stdout_missing"))?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .map_err(|_| unavailable("holder_preparation_timeout"))?
            .map_err(|_| unavailable("holder_preparation_failed"))?;
        if line.len() > 2048 {
            return Err(unavailable("holder_observation_oversized"));
        }
        let observed: Prepared =
            serde_json::from_str(&line).map_err(|_| unavailable("holder_observation_invalid"))?;
        let pid = child
            .id()
            .ok_or_else(|| unavailable("holder_pid_missing"))?;
        if observed.version != 1
            || observed.event != "prepared"
            || observed.slot_id != id
            || observed.pid_namespace_local != pid
            || namespace(pid, "net")?.inode != observed.network_inode
            || namespace(pid, "ipc")?.inode != observed.ipc_inode
            || namespace(pid, "uts")?.inode != observed.uts_inode
        {
            return Err(unavailable("holder_identity_not_observed"));
        }
        // Drain only fixed-field holder observations. This task ends with its owned child.
        tokio::spawn(async move {
            let mut line = String::new();
            while reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                line.clear();
            }
        });
        let params = BootstrapParams {
            instance_id: id.clone(),
            namespace: settings.namespace.clone(),
            containerd_version: "2.3.6".into(),
            containerd_grpc_address: settings.containerd_socket.to_string_lossy().into_owned(),
            containerd_ttrpc_address: format!("{}.ttrpc", settings.containerd_socket.display()),
            containerd_binary: settings.containerd_binary.to_string_lossy().into_owned(),
            socket_dir: Some(settings.shim_sockets.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let mut shim_command = Command::new(&settings.shim_binary);
        let cgroup_proc = cgroup
            .as_deref()
            .map(crate::cgroup::proc_path)
            .transpose()?;
        unsafe {
            shim_command.pre_exec(move || {
                if let Some(path) = &cgroup_proc {
                    crate::cgroup::enter_before_exec(path)?;
                }
                Ok(())
            });
        }
        let mut shim = shim_command
            .args([
                "-namespace",
                &settings.namespace,
                "-id",
                &id,
                "-address",
                settings
                    .containerd_socket
                    .to_str()
                    .ok_or_else(|| unavailable("containerd_socket_invalid"))?,
                "start",
            ])
            .env(
                "TTRPC_ADDRESS",
                format!("{}.ttrpc", settings.containerd_socket.display()),
            )
            .env("GRPC_ADDRESS", &settings.containerd_socket)
            .env("NAMESPACE", &settings.namespace)
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| unavailable("shim_start_failed"))?;
        shim.stdin
            .take()
            .ok_or_else(|| unavailable("shim_stdin_missing"))?
            .write_all(&params.encode_to_vec())
            .await
            .map_err(|_| unavailable("shim_bootstrap_failed"))?;
        let result = timeout(Duration::from_secs(5), shim.wait_with_output())
            .await
            .map_err(|_| unavailable("shim_start_timeout"))?
            .map_err(|_| unavailable("shim_start_failed"))?;
        if !result.status.success() || result.stdout.len() > 65536 {
            return Err(unavailable("shim_start_refused"));
        }
        let boot = BootstrapResult::decode(result.stdout.as_slice())
            .map_err(|_| unavailable("shim_bootstrap_invalid"))?;
        if boot.version != 3 || boot.protocol != "ttrpc" || !boot.address.starts_with("unix://") {
            return Err(unavailable("shim_version_or_protocol_unsupported"));
        }
        let address = format!("{}+{}", boot.protocol, boot.address);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let shim_pid = loop {
            match transport::shim_pid(&address, &settings.namespace).await {
                Ok(pid) => break pid,
                Err(error) if std::time::Instant::now() >= deadline => return Err(error),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        let identity = Identity {
            slot: id,
            pid,
            shim_pid,
            task_address: address,
            network_inode: observed.network_inode,
            ipc_inode: observed.ipc_inode,
            uts_inode: observed.uts_inode,
            holder_start_ticks: start_ticks(pid)?,
            shim_start_ticks: start_ticks(shim_pid)?,
        };
        private_file(
            &directory.join("identity.json"),
            &serde_json::to_vec(&identity).map_err(|_| unavailable("identity_encode_failed"))?,
        )?;
        let process = pidfd(pid)?;
        // Assigned holders must survive controller restart. Failed setup above still owns kill-on-drop.
        Ok(Self {
            identity,
            child: setup.0.take(),
            pidfd: Some(process),
            shim_pidfd: Some(pidfd(shim_pid)?),
            socket,
            directory,
            created_at: SystemTime::now(),
            prepared_at: std::time::Instant::now(),
            lifetime: Duration::from_millis(settings.slot_lifetime_ms),
            assigned_network: None,
            exited_at: None,
            exit_status: 0,
            _log_reader: log_reader,
            cgroup,
            budget: settings.budget.clone(),
            profile: settings.runtime_profile.clone(),
        })
    }
    pub async fn restore(
        settings: &Settings,
        directory: PathBuf,
        identity: Identity,
        network: Option<NamespaceIdentity>,
    ) -> Result<Self, Status> {
        ensure_private_directory(&directory)?;
        if directory.file_name().and_then(|value| value.to_str()) != Some(&identity.slot)
            || identity.slot.len() != 32
            || !identity.slot.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(unavailable("retained_slot_identity_invalid"));
        }
        let process = observed_process(identity.pid, identity.holder_start_ticks)?;
        let shim_process = observed_process(identity.shim_pid, identity.shim_start_ticks)?;
        if process.is_some()
            && (namespace(identity.pid, "ipc")?.inode != identity.ipc_inode
                || namespace(identity.pid, "uts")?.inode != identity.uts_inode)
        {
            return Err(unavailable("retained_holder_identity_changed"));
        }
        if shim_process.is_some()
            && transport::shim_pid(&identity.task_address, &settings.namespace).await?
                != identity.shim_pid
        {
            return Err(unavailable("retained_shim_identity_changed"));
        }
        let cgroup = settings.cloudflare.as_ref().map(|local| {
            local
                .cgroup_root
                .join(if network.is_some() {
                    "assigned"
                } else {
                    "idle"
                })
                .join(&identity.slot)
        });
        let log_reader = LogReader(shim_log(&directory)?);
        Ok(Self {
            socket: directory.join("control.sock"),
            directory,
            identity,
            child: None,
            pidfd: process,
            shim_pidfd: shim_process,
            created_at: SystemTime::now(),
            prepared_at: std::time::Instant::now(),
            lifetime: Duration::ZERO,
            assigned_network: network,
            exited_at: None,
            exit_status: 0,
            _log_reader: log_reader,
            cgroup,
            budget: None,
            profile: None,
        })
    }
    pub fn live(&mut self) -> Result<bool, Status> {
        let exit = match self.child.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|_| unavailable("holder_wait_failed"))?,
            None => None,
        };
        match exit {
            Some(exit) => {
                self.exited_at.get_or_insert(SystemTime::now());
                self.exit_status = exit.code().unwrap_or(137) as u32;
                Ok(false)
            }
            None => {
                let live = self.pidfd.as_ref().is_some_and(|fd| {
                    let mut poll = libc::pollfd {
                        fd: fd.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    unsafe { libc::poll(&mut poll, 1, 0) == 0 }
                }) && start_ticks(self.identity.pid)
                    .is_ok_and(|ticks| ticks == self.identity.holder_start_ticks)
                    && namespace(self.identity.pid, "net")
                        .is_ok_and(|ns| ns.inode == self.identity.network_inode)
                    && namespace(self.identity.pid, "ipc")
                        .is_ok_and(|ns| ns.inode == self.identity.ipc_inode)
                    && namespace(self.identity.pid, "uts")
                        .is_ok_and(|ns| ns.inode == self.identity.uts_inode);
                if !live {
                    self.exited_at.get_or_insert(SystemTime::now());
                }
                Ok(live)
            }
        }
    }
    pub fn assign(&mut self, network_path: &str, hostname: &str) -> Result<(), Status> {
        if self.assigned_network.is_some()
            || !self.live()?
            || self.prepared_at.elapsed() >= self.lifetime
        {
            return Err(unavailable("slot_not_unassigned"));
        }
        let fd = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(network_path)
            .map_err(|_| unavailable("CNI_namespace_open_failed"))?;
        let network = linux::network_namespace_identity(fd.as_fd())
            .map_err(|_| unavailable("CNI_network_namespace_required"))?;
        let slot_id = protocol::parse_slot_id(&self.identity.slot)
            .map_err(|_| unavailable("slot_identity_invalid"))?;
        let wire = protocol::encode(&Assignment {
            slot_id,
            network,
            hostname,
        })
        .map_err(|_| Status::invalid_argument("hostname_invalid"))?;
        let raw =
            unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
        if raw < 0 {
            return Err(unavailable("assignment_socket_failed"));
        }
        // SAFETY: raw is a new owned socket; sockaddr/iovec/cmsg reference initialized bounded buffers.
        let socket = unsafe { OwnedFd::from_raw_fd(raw) };
        let mut addr: libc::sockaddr_un = unsafe { mem::zeroed() };
        addr.sun_family = libc::AF_UNIX as _;
        let path = self.socket.as_os_str().as_encoded_bytes();
        if path.len() >= addr.sun_path.len() {
            return Err(unavailable("assignment_socket_path_long"));
        }
        for (to, from) in addr.sun_path.iter_mut().zip(path) {
            *to = *from as _;
        }
        let time = libc::timeval {
            tv_sec: 2,
            tv_usec: 0,
        };
        if unsafe {
            libc::setsockopt(
                raw,
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                (&time as *const libc::timeval).cast(),
                mem::size_of_val(&time) as _,
            )
        } < 0
            || unsafe {
                libc::connect(
                    raw,
                    (&addr as *const libc::sockaddr_un).cast(),
                    mem::size_of_val(&addr) as _,
                )
            } < 0
        {
            return Err(unavailable("assignment_connect_failed"));
        }
        let mut iov = libc::iovec {
            iov_base: wire.as_ptr() as *mut _,
            iov_len: wire.len(),
        };
        let mut control = [0_usize; 8];
        let mut msg: libc::msghdr = unsafe { mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.as_mut_ptr().cast();
        msg.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<libc::c_int>() as u32) } as _;
        unsafe {
            let h = libc::CMSG_FIRSTHDR(&msg);
            (*h).cmsg_level = libc::SOL_SOCKET;
            (*h).cmsg_type = libc::SCM_RIGHTS;
            (*h).cmsg_len = libc::CMSG_LEN(mem::size_of::<libc::c_int>() as u32) as _;
            *libc::CMSG_DATA(h).cast::<libc::c_int>() = fd.as_raw_fd();
        }
        // Consume before send: any uncertain acknowledgement destroys this slot; it never returns to inventory.
        self.assigned_network = Some(network);
        let sent = unsafe { libc::sendmsg(raw, &msg, libc::MSG_NOSIGNAL) };
        if sent != wire.len() as isize {
            return Err(unavailable("assignment_send_uncertain"));
        }
        let mut ack = [0_u8; 32];
        let count =
            unsafe { libc::recv(socket.as_raw_fd(), ack.as_mut_ptr().cast(), ack.len(), 0) };
        if count != 9
            || &ack[..9] != b"assigned\n"
            || namespace(self.identity.pid, "net")? != network
            || namespace(self.identity.pid, "ipc")?.inode != self.identity.ipc_inode
            || namespace(self.identity.pid, "uts")?.inode != self.identity.uts_inode
        {
            return Err(unavailable("assignment_not_observed"));
        }
        self.identity.network_inode = network.inode;
        if let Some(budget) = &self.budget {
            self.cgroup = Some(budget.assign(
                &self.identity.slot,
                &[self.identity.pid, self.identity.shim_pid],
            )?);
        }
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<(), Status> {
        if self.pidfd.as_ref().is_some_and(|fd| {
            let mut poll = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            unsafe { libc::poll(&mut poll, 1, 0) == 0 }
        }) {
            let fd = self
                .pidfd
                .as_ref()
                .ok_or_else(|| unavailable("holder_handle_missing"))?;
            if unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            } < 0
            {
                return Err(unavailable("holder_stop_failed"));
            }
        }
        if let Some(child) = &mut self.child {
            child
                .wait()
                .await
                .map_err(|_| unavailable("holder_reap_failed"))?;
        } else if let Some(fd) = &self.pidfd {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let mut poll = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut poll, 1, 0) } > 0 {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(unavailable("holder_stop_unconfirmed"));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        self.exited_at.get_or_insert(SystemTime::now());
        self.exit_status = 137;
        Ok(())
    }
    pub async fn destroy(&mut self, namespace: &str) -> Result<(), Status> {
        self.destroy_mode(namespace, false).await
    }
    pub async fn destroy_retaining_owner(&mut self, namespace: &str) -> Result<(), Status> {
        self.destroy_mode(namespace, true).await
    }
    async fn destroy_mode(&mut self, namespace: &str, retain_owner: bool) -> Result<(), Status> {
        self.stop().await?;
        if self
            .shim_pidfd
            .as_ref()
            .map(handle_live)
            .transpose()?
            .unwrap_or(false)
            && start_ticks(self.identity.shim_pid)
                .is_ok_and(|ticks| ticks == self.identity.shim_start_ticks)
        {
            let _: () = transport::shim_call(
                &self.identity.task_address,
                "Shutdown",
                crate::containerd::task::v3::ShutdownRequest {
                    id: String::new(),
                    now: false,
                },
                namespace,
            )
            .await?;
        }
        if let Some(fd) = &self.shim_pidfd {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            loop {
                let mut poll = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                if unsafe { libc::poll(&mut poll, 1, 0) } > 0 {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(unavailable("shim_shutdown_unconfirmed"));
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        if !retain_owner {
            let _ = fs::remove_file(self.directory.join("identity.json"));
            let _ = fs::remove_file(self.directory.join("owner.json"));
        }
        if let Some(path) = &self.cgroup
            && path.exists()
        {
            fs::remove_dir(path).map_err(|_| unavailable("slot_cgroup_cleanup_unconfirmed"))?;
        }
        if retain_owner {
            Ok(())
        } else {
            fs::remove_dir_all(&self.directory)
                .map_err(|_| unavailable("retired_slot_cleanup_failed"))
        }
    }
    pub async fn shim_live(&self, namespace: &str) -> bool {
        start_ticks(self.identity.shim_pid)
            .is_ok_and(|ticks| ticks == self.identity.shim_start_ticks)
            && transport::shim_pid(&self.identity.task_address, namespace)
                .await
                .is_ok_and(|pid| pid == self.identity.shim_pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exited_unreaped_shim_is_not_contacted_when_restoring_retired_ownership() {
        let base = PathBuf::from(format!("/tmp/sr-{}", std::process::id()));
        let directory = base.join("a".repeat(32));
        std::fs::create_dir(&base).unwrap();
        private_directory(&directory).unwrap();
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        let ticks = start_ticks(pid).unwrap();
        let fd = pidfd(pid).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            let mut poll = libc::pollfd {
                fd: fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut poll, 1, 0) } > 0 {
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(start_ticks(pid).unwrap(), ticks);
        let settings = Settings {
            socket: base.join("rpc"),
            state: base.clone(),
            shim_sockets: base.clone(),
            containerd_socket: base.join("containerd"),
            containerd_binary: "/bin/false".into(),
            shim_binary: "/bin/false".into(),
            runc_binary: "/bin/false".into(),
            holder_binary: "/bin/false".into(),
            namespace: "k8s.io".into(),
            slots: 0,
            slot_lifetime_ms: 1,
            cloudflare: None,
            budget: None,
            runtime_profile: None,
        };
        let identity = Identity {
            slot: "a".repeat(32),
            pid: u32::MAX,
            shim_pid: pid,
            task_address: format!("ttrpc+unix:///tmp/no-shim-{pid}"),
            network_inode: 1,
            ipc_inode: 1,
            uts_inode: 1,
            holder_start_ticks: 0,
            shim_start_ticks: ticks,
        };
        let restored = Slot::restore(&settings, directory, identity, None).await;
        child.wait().unwrap();
        std::fs::remove_dir_all(base).unwrap();
        assert!(
            restored.is_ok(),
            "an exited shim must not require a live socket: {}",
            restored
                .err()
                .map(|e| e.message().to_string())
                .unwrap_or_default()
        );
    }
}
