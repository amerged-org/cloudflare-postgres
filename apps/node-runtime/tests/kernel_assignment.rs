#![cfg(target_os = "linux")]
//! Requires an isolated Linux environment with CAP_SYS_ADMIN and CAP_SETPCAP.
//! This is a real kernel proof, not CRI/CNPG/database acceptance.

use pgcf_node_runtime::{
    linux,
    protocol::{self, Assignment},
};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    mem,
    os::{
        fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
        unix::fs::PermissionsExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    thread,
    time::{Duration, Instant},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn start_slot(uid: u32, ttl: u64) -> (Process, Directory, String, [u8; 16]) {
    let number = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = Directory(PathBuf::from(format!(
        "/tmp/pgcf-slot-{}-{number}",
        std::process::id()
    )));
    fs::create_dir(&dir.0).unwrap();
    fs::set_permissions(&dir.0, fs::Permissions::from_mode(0o700)).unwrap();
    let socket = dir.0.join("control.sock");
    let mut id = [7_u8; 16];
    id[15] = number as u8;
    let hex: String = id.iter().map(|b| format!("{b:02x}")).collect();
    let mut child = Process(
        Command::new(env!("CARGO_BIN_EXE_pgcf-node-runtime"))
            .args([
                socket.to_str().unwrap(),
                &hex,
                &uid.to_string(),
                &ttl.to_string(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut ready = String::new();
    let mut reader = BufReader::new(child.0.stdout.take().unwrap());
    reader.read_line(&mut ready).unwrap();
    child.0.stdout = Some(reader.into_inner());
    assert!(
        ready.contains("\"event\":\"prepared\""),
        "prepared namespace process did not start"
    );
    (child, dir, ready, id)
}
fn connect(path: &Path) -> OwnedFd {
    // SAFETY: socket returns a new owned FD; address is initialized and bounded by this test path.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    assert!(raw >= 0);
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (to, from) in address
        .sun_path
        .iter_mut()
        .zip(path.as_os_str().as_encoded_bytes())
    {
        *to = *from as libc::c_char;
    }
    assert_eq!(
        unsafe {
            libc::connect(
                fd.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                mem::size_of_val(&address) as libc::socklen_t,
            )
        },
        0
    );
    let timeout = libc::timeval {
        tv_sec: 2,
        tv_usec: 0,
    };
    assert_eq!(
        unsafe {
            libc::setsockopt(
                fd.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                (&timeout as *const libc::timeval).cast(),
                mem::size_of_val(&timeout) as libc::socklen_t,
            )
        },
        0
    );
    fd
}
fn send(fd: &OwnedFd, wire: &[u8], namespace: &File) {
    let mut iov = libc::iovec {
        iov_base: wire.as_ptr() as *mut _,
        iov_len: wire.len(),
    };
    let mut control = [0_usize; 8];
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of::<libc::c_int>() as u32) } as _;
    unsafe {
        let h = libc::CMSG_FIRSTHDR(&message);
        (*h).cmsg_level = libc::SOL_SOCKET;
        (*h).cmsg_type = libc::SCM_RIGHTS;
        (*h).cmsg_len = libc::CMSG_LEN(mem::size_of::<libc::c_int>() as u32) as _;
        *libc::CMSG_DATA(h).cast::<libc::c_int>() = namespace.as_raw_fd();
        assert_eq!(
            libc::sendmsg(fd.as_raw_fd(), &message, libc::MSG_NOSIGNAL),
            wire.len() as isize
        );
    }
}
fn wait(child: &mut Process) -> std::process::ExitStatus {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < end, "owned process failed to terminate");
        thread::sleep(Duration::from_millis(5));
    }
}
fn target_namespace() -> (Process, File) {
    let target = Process(
        Command::new("/bin/busybox")
            .args(["unshare", "-n", "/bin/sleep", "60"])
            .spawn()
            .unwrap(),
    );
    let own = linux::network_namespace_identity(File::open("/proc/self/ns/net").unwrap().as_fd())
        .unwrap();
    let end = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(fd) = File::open(format!("/proc/{}/ns/net", target.0.id()))
            && linux::network_namespace_identity(fd.as_fd()).unwrap() != own
        {
            return (target, fd);
        }
        assert!(
            Instant::now() < end,
            "target network namespace was not created"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "real isolated Linux namespace capability required"]
fn same_prestarted_pid_accepts_one_real_network_fd_drops_privileges_and_is_destroyed() {
    let uid = unsafe { libc::geteuid() };
    let (mut slot, dir, ready, id) = start_slot(uid, 5_000);
    let pid = slot.0.id();
    let before_ipc =
        linux::namespace_identity(File::open(format!("/proc/{pid}/ns/ipc")).unwrap().as_fd())
            .unwrap();
    let before_uts =
        linux::namespace_identity(File::open(format!("/proc/{pid}/ns/uts")).unwrap().as_fd())
            .unwrap();
    let before_net = linux::network_namespace_identity(
        File::open(format!("/proc/{pid}/ns/net")).unwrap().as_fd(),
    )
    .unwrap();
    assert_ne!(
        before_ipc,
        linux::namespace_identity(File::open("/proc/self/ns/ipc").unwrap().as_fd()).unwrap()
    );
    assert_ne!(
        before_uts,
        linux::namespace_identity(File::open("/proc/self/ns/uts").unwrap().as_fd()).unwrap()
    );
    let (_target, network_fd) = target_namespace();
    let network = linux::network_namespace_identity(network_fd.as_fd()).unwrap();
    assert_ne!(before_net, network);
    let requested = Instant::now();
    let connection = connect(&dir.0.join("control.sock"));
    let wire = protocol::encode(&Assignment {
        slot_id: id,
        network,
        hostname: "actual-cnpg-pod-1",
    })
    .unwrap();
    send(&connection, &wire, &network_fd);
    let mut ack = [0_u8; 32];
    let n = unsafe {
        libc::recv(
            connection.as_raw_fd(),
            ack.as_mut_ptr().cast(),
            ack.len(),
            0,
        )
    };
    assert_eq!(&ack[..usize::try_from(n).unwrap()], b"assigned\n");
    assert_eq!(slot.0.id(), pid);
    assert_eq!(
        linux::network_namespace_identity(
            File::open(format!("/proc/{pid}/ns/net")).unwrap().as_fd()
        )
        .unwrap(),
        network
    );
    assert_eq!(
        linux::namespace_identity(File::open(format!("/proc/{pid}/ns/ipc")).unwrap().as_fd())
            .unwrap(),
        before_ipc
    );
    assert_eq!(
        linux::namespace_identity(File::open(format!("/proc/{pid}/ns/uts")).unwrap().as_fd())
            .unwrap(),
        before_uts
    );
    let hostname = Command::new("/bin/busybox")
        .args(["nsenter", "-t", &pid.to_string(), "-u", "/bin/hostname"])
        .output()
        .unwrap();
    assert!(hostname.status.success());
    assert_eq!(
        String::from_utf8(hostname.stdout).unwrap().trim(),
        "actual-cnpg-pod-1"
    );
    let status = fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    for field in ["CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"] {
        let line = status.lines().find(|line| line.starts_with(field)).unwrap();
        assert_eq!(line.split_whitespace().nth(1).unwrap(), "0000000000000000");
    }
    assert_eq!(
        status
            .lines()
            .find(|line| line.starts_with("NoNewPrivs:"))
            .unwrap()
            .split_whitespace()
            .nth(1),
        Some("1")
    );
    // A second connection cannot consume or change the same slot.
    let retry = Command::new("/bin/busybox")
        .args(["test", "-S", dir.0.join("control.sock").to_str().unwrap()])
        .status()
        .unwrap();
    assert!(retry.success());
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    assert!(raw >= 0);
    let second = unsafe { OwnedFd::from_raw_fd(raw) };
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (to, from) in address
        .sun_path
        .iter_mut()
        .zip(dir.0.join("control.sock").as_os_str().as_encoded_bytes())
    {
        *to = *from as libc::c_char;
    }
    assert_eq!(
        unsafe {
            libc::connect(
                second.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                mem::size_of_val(&address) as libc::socklen_t,
            )
        },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECONNREFUSED)
    );
    println!(
        "{{\"prepared_before_request\":true,\"same_pid\":true,\"network_fd_bound\":true,\"independent_ipc_uts_preserved\":true,\"capabilities_zero\":true,\"one_assignment\":true,\"assignment_ms\":{},\"prepared_observation\":{:?}}}",
        requested.elapsed().as_secs_f64() * 1000.0,
        ready.trim()
    );
    assert_eq!(unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) }, 0);
    assert!(wait(&mut slot).success());
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
}

#[test]
#[ignore = "real isolated Linux namespace capability required"]
fn expiry_and_unauthorized_peer_destroy_the_unassigned_slot() {
    let uid = unsafe { libc::geteuid() };
    let (mut expired, _dir, _ready, _id) = start_slot(uid, 60);
    assert!(!wait(&mut expired).success());
    let mut error = String::new();
    expired
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut error)
        .unwrap();
    assert_eq!(error.trim(), "slot_expired");
    let (mut denied, dir, _ready, _id) = start_slot(uid.wrapping_add(1), 2_000);
    let _connection = connect(&dir.0.join("control.sock"));
    assert!(!wait(&mut denied).success());
    let mut error = String::new();
    denied
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut error)
        .unwrap();
    assert_eq!(error.trim(), "peer_not_authorized");
}
