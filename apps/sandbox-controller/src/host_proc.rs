// SPDX-License-Identifier: Apache-2.0
//! Read-only host procfs retained by the qualified self-launcher. Host and CRI PID numbers are distinct.
use pgcf_node_runtime::protocol::NamespaceIdentity;
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs::{self, File},
    io::Read,
    os::fd::{AsRawFd, FromRawFd},
    path::PathBuf,
};
use tonic::Status;
fn unknown() -> Status {
    Status::failed_precondition("host_process_mapping_unknown")
}
fn open_at(directory: &File, path: &str, flags: i32) -> Result<File, Status> {
    let path = CString::new(path).map_err(|_| unknown())?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            path.as_ptr(),
            flags | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(unknown());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn text(directory: &File, path: &str) -> Result<String, Status> {
    let file = open_at(directory, path, libc::O_RDONLY | libc::O_NOFOLLOW)?;
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| unknown())?;
    if bytes.len() > 65536 {
        return Err(unknown());
    }
    String::from_utf8(bytes).map_err(|_| unknown())
}
fn namespace(directory: &File, path: &str) -> Result<NamespaceIdentity, Status> {
    use std::os::fd::AsFd;
    let file = open_at(directory, path, libc::O_RDONLY)?;
    if unsafe { libc::ioctl(file.as_raw_fd(), 0xb703) } != libc::CLONE_NEWPID {
        return Err(unknown());
    }
    pgcf_node_runtime::linux::namespace_identity(file.as_fd()).map_err(|_| unknown())
}
fn ticks(stat: &str) -> Option<u64> {
    stat.rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()
}
pub struct HostProc {
    root: File,
    pub host_namespace: NamespaceIdentity,
    cri_index: usize,
}
#[derive(Clone)]
pub struct ProcessMapping {
    pub cri_pid: u32,
    pub start_ticks: u64,
    pub pid_namespace: NamespaceIdentity,
}
impl HostProc {
    pub fn inherited() -> Result<Self, Status> {
        use std::os::fd::AsFd;
        let copy = |fd| {
            let fd = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
            if fd < 0 {
                Err(unknown())
            } else {
                Ok(unsafe { File::from_raw_fd(fd) })
            }
        };
        let root = copy(crate::host_context::HOST_PROC_FD)?;
        let pidns = copy(crate::host_context::HOST_PID_NAMESPACE_FD)?;
        let mut fs = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(root.as_raw_fd(), fs.as_mut_ptr()) } < 0
            || unsafe { fs.assume_init() }.f_type as i64 != libc::PROC_SUPER_MAGIC
        {
            return Err(unknown());
        }
        if unsafe { libc::ioctl(pidns.as_raw_fd(), 0xb703) } != libc::CLONE_NEWPID {
            return Err(unknown());
        }
        let host_namespace =
            pgcf_node_runtime::linux::namespace_identity(pidns.as_fd()).map_err(|_| unknown())?;
        if namespace(&root, "1/ns/pid")? != host_namespace {
            return Err(unknown());
        }
        let current = text(&root, "self/status")?;
        let pids = current
            .lines()
            .find_map(|line| line.strip_prefix("NSpid:"))
            .ok_or_else(unknown)?
            .split_whitespace()
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| unknown())?;
        if pids.last().copied() != Some(std::process::id()) {
            return Err(unknown());
        }
        let cri_index = pids.len().checked_sub(1).ok_or_else(unknown)?;
        Ok(Self {
            root,
            host_namespace,
            cri_index,
        })
    }
    pub fn boot_id(&self) -> Result<String, Status> {
        Ok(text(&self.root, "sys/kernel/random/boot_id")?
            .trim()
            .to_owned())
    }
    pub fn map(&self, requested: &[ProcessMapping]) -> Result<BTreeMap<u32, u32>, Status> {
        if requested.len() > 4096 {
            return Err(unknown());
        }
        let targets = requested
            .iter()
            .map(|value| (value.cri_pid, value))
            .collect::<BTreeMap<_, _>>();
        if targets.len() != requested.len() {
            return Err(unknown());
        }
        let path = PathBuf::from(format!("/proc/self/fd/{}", self.root.as_raw_fd()));
        let mut matches: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        let mut count = 0;
        for entry in fs::read_dir(path).map_err(|_| unknown())? {
            let entry = entry.map_err(|_| unknown())?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|value| value.parse::<u32>().ok())
            else {
                continue;
            };
            count += 1;
            if count > 65536 {
                return Err(unknown());
            }
            let Ok(process) = open_at(
                &self.root,
                &pid.to_string(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            ) else {
                continue;
            };
            let Ok(status) = text(&process, "status") else {
                continue;
            };
            let Some(pids) = status.lines().find_map(|line| line.strip_prefix("NSpid:")) else {
                continue;
            };
            let pids = pids
                .split_whitespace()
                .filter_map(|value| value.parse::<u32>().ok())
                .collect::<Vec<_>>();
            let Some(cri_pid) = pids.get(self.cri_index).copied() else {
                continue;
            };
            let Some(expected) = targets.get(&cri_pid) else {
                continue;
            };
            if pids.first().copied() != Some(pid)
                || text(&process, "stat").ok().as_deref().and_then(ticks)
                    != Some(expected.start_ticks)
                || namespace(&process, "ns/pid").ok().as_ref() != Some(&expected.pid_namespace)
            {
                continue;
            }
            matches.entry(cri_pid).or_default().push(pid);
        }
        Ok(matches
            .into_iter()
            .filter_map(|(cri, host)| {
                if host.len() == 1 {
                    Some((cri, host[0]))
                } else {
                    None
                }
            })
            .collect())
    }
}
