// SPDX-License-Identifier: Apache-2.0
//! Fixed self-launch in the actual CRI PID/mount context, including Talos workload isolation.
use crate::{
    policy::digest,
    slot::{Settings, start_ticks},
};
use std::{
    ffi::{CString, OsString},
    fs::{self, File},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt, process::CommandExt},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicI32, Ordering},
    time::{Duration, Instant},
};
use tonic::Status;
static CHILD: AtomicI32 = AtomicI32::new(-1);
static STOP: AtomicBool = AtomicBool::new(false);
pub const HOST_PROC_FD: i32 = 198;
pub const HOST_PID_NAMESPACE_FD: i32 = 197;
/// The self-exec retains these read-only handles, but holders/shims and all later children must not inherit them.
pub fn seal_inherited_handles() -> Result<(), Status> {
    for fd in [HOST_PROC_FD, HOST_PID_NAMESPACE_FD] {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) {
                continue;
            }
            return Err(failed());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err(failed());
        }
    }
    Ok(())
}
extern "C" fn terminate(_: i32) {
    STOP.store(true, Ordering::Relaxed);
    let fd = CHILD.load(Ordering::Relaxed);
    if fd >= 0 {
        unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd,
                libc::SIGTERM,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
    }
}
fn failed() -> Status {
    Status::failed_precondition("CRI_host_context_unavailable")
}
fn same(one: &File, two: &File) -> Result<bool, Status> {
    let one = one.metadata().map_err(|_| failed())?;
    let two = two.metadata().map_err(|_| failed())?;
    Ok(one.dev() == two.dev() && one.ino() == two.ino())
}
pub fn discover(settings: &Settings) -> Result<u32, Status> {
    let expected = File::open(&settings.containerd_binary).map_err(|_| failed())?;
    let mut matches = Vec::new();
    let mut count = 0;
    for entry in fs::read_dir("/proc").map_err(|_| failed())? {
        let entry = entry.map_err(|_| failed())?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        count += 1;
        if count > 65536 {
            return Err(failed());
        }
        let Ok(arguments) = fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if arguments.len() > 65536 {
            continue;
        }
        let parts = arguments.split(|byte| *byte == 0).collect::<Vec<_>>();
        if !parts.windows(2).any(|pair| {
            pair[0] == b"--address"
                && pair[1] == settings.containerd_socket.as_os_str().as_encoded_bytes()
        }) {
            continue;
        }
        let executable = entry.path().join("exe");
        let Ok(actual) = File::open(&executable) else {
            continue;
        };
        if actual.metadata().map_err(|_| failed())?.uid() != 0 {
            continue;
        }
        if same(&expected, &actual)? || digest(&settings.containerd_binary)? == digest(&executable)?
        {
            matches.push(pid);
        }
    }
    if matches.len() != 1 {
        return Err(failed());
    }
    Ok(matches[0])
}
pub fn process_root(pid: u32) -> PathBuf {
    PathBuf::from(format!("/proc/{pid}/root"))
}
/// Call before creating threads. The executable is always this same qualified binary.
pub fn launch(settings_file: &Path, args: &[OsString]) -> Result<i32, Status> {
    if fs::read_dir("/proc/self/task")
        .map_err(|_| failed())?
        .take(2)
        .count()
        != 1
    {
        return Err(failed());
    }
    let settings_hash = digest(settings_file)?;
    let bytes = fs::read(settings_file).map_err(|_| failed())?;
    if bytes.len() > 16384 {
        return Err(failed());
    }
    let settings: Settings = serde_json::from_slice(&bytes).map_err(|_| failed())?;
    let executable = std::env::current_exe().map_err(|_| failed())?;
    let executable_hash = digest(&executable)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        match discover(&settings) {
            Ok(pid) => break pid,
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    let ticks = start_ticks(pid)?;
    let mount = File::open(format!("/proc/{pid}/ns/mnt")).map_err(|_| failed())?;
    let pidns = File::open(format!("/proc/{pid}/ns/pid")).map_err(|_| failed())?;
    let root = File::open(process_root(pid)).map_err(|_| failed())?;
    let current_mount = File::open("/proc/self/ns/mnt").map_err(|_| failed())?;
    let current_pid = File::open("/proc/self/ns/pid").map_err(|_| failed())?;
    let current_root = File::open("/").map_err(|_| failed())?;
    let host_proc = File::open("/proc").map_err(|_| failed())?;
    if start_ticks(pid)? != ticks {
        return Err(failed());
    }
    // Namespace handles stay open across the transition. The parent stays in its original PID namespace.
    if !same(&mount, &current_mount)?
        && unsafe { libc::setns(mount.as_raw_fd(), libc::CLONE_NEWNS) } < 0
    {
        return Err(failed());
    }
    if !same(&root, &current_root)? {
        let dot = CString::new(".").unwrap();
        if unsafe { libc::fchdir(root.as_raw_fd()) } < 0
            || unsafe { libc::chroot(dot.as_ptr()) } < 0
        {
            return Err(failed());
        }
    }
    std::env::set_current_dir("/").map_err(|_| failed())?;
    if !same(&pidns, &current_pid)?
        && unsafe { libc::setns(pidns.as_raw_fd(), libc::CLONE_NEWPID) } < 0
    {
        return Err(failed());
    }
    if digest(settings_file)? != settings_hash || digest(&executable)? != executable_hash {
        return Err(failed());
    }
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    action.sa_sigaction = terminate as *const () as usize;
    unsafe { libc::sigemptyset(&mut action.sa_mask) };
    for signal in [libc::SIGTERM, libc::SIGINT] {
        if unsafe { libc::sigaction(signal, &action, std::ptr::null_mut()) } < 0 {
            return Err(failed());
        }
    }
    let mut command = std::process::Command::new(executable);
    command.args(args);
    let parent_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) } as i32;
    if parent_fd < 0 {
        return Err(failed());
    }
    let parent_handle = unsafe { OwnedFd::from_raw_fd(parent_fd) };
    let host_proc_fd = host_proc.as_raw_fd();
    let host_pidns_fd = current_pid.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            for (source, target) in [
                (host_proc_fd, HOST_PROC_FD),
                (host_pidns_fd, HOST_PID_NAMESPACE_FD),
            ] {
                let result = if source == target {
                    libc::fcntl(source, libc::F_SETFD, 0)
                } else {
                    libc::dup3(source, target, 0)
                };
                if result < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut poll = libc::pollfd {
                fd: parent_fd,
                events: libc::POLLIN,
                revents: 0,
            };
            if libc::poll(&mut poll, 1, 0) != 0 {
                return Err(std::io::Error::from_raw_os_error(libc::EPIPE));
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|_| failed())?;
    drop(parent_handle);
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id(), 0) } as i32;
    if fd < 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(failed());
    }
    let handle = unsafe { OwnedFd::from_raw_fd(fd) };
    CHILD.store(handle.as_raw_fd(), Ordering::Relaxed);
    if STOP.load(Ordering::Relaxed) {
        terminate(0);
    }
    let status = child.wait().map_err(|_| failed())?;
    CHILD.store(-1, Ordering::Relaxed);
    Ok(status.code().unwrap_or(137))
}
