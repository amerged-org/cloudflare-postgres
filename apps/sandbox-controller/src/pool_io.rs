// SPDX-License-Identifier: Apache-2.0
//! Actual ordinary pool Pod process/cgroup custody. A namespace string never grants protection.
use pgcf_node_runtime::protocol::NamespaceIdentity;
use std::{
    ffi::CString,
    fs::{self, File},
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    path::PathBuf,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_cgroup_custody_unconfirmed")
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
fn beneath(root: &File, path: &str, flags: i32) -> Result<File, Status> {
    let path = CString::new(path).map_err(|_| refused())?;
    let how = OpenHow {
        flags: (flags | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: 0x08 | 0x04 | 0x02,
    };
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if fd < 0 {
        return Err(refused());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
fn read(root: &File, name: &str) -> Result<String, Status> {
    let file = beneath(root, name, libc::O_RDONLY)?;
    let mut bytes = Vec::new();
    file.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 65536 {
        return Err(refused());
    }
    String::from_utf8(bytes).map_err(|_| refused())
}
fn path(raw: &str, pod: &str, cid: &str) -> Option<String> {
    let mut rows = raw.lines();
    let line = rows.next()?;
    if rows.next().is_some() {
        return None;
    }
    let path = line.strip_prefix("0::/")?;
    let parts = path.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|p| p.is_empty() || matches!(*p, "." | "..") || p.contains(['\\', '\0', ' ']))
    {
        return None;
    }
    let guaranteed = format!("kubepods-pod{}.slice", pod.replace('-', "_"));
    let burst = format!("kubepods-burstable-pod{}.slice", pod.replace('-', "_"));
    let scope = format!("cri-containerd-{cid}.scope");
    let group = format!("pod{pod}");
    let accepted = parts
        .windows(3)
        .any(|p| p == ["kubepods.slice", guaranteed.as_str(), scope.as_str()])
        || parts.windows(4).any(|p| {
            p == [
                "kubepods.slice",
                "kubepods-burstable.slice",
                burst.as_str(),
                scope.as_str(),
            ]
        })
        || parts
            .windows(3)
            .any(|p| p == ["kubepods", group.as_str(), cid])
        || parts
            .windows(4)
            .any(|p| p == ["kubepods", "burstable", group.as_str(), cid]);
    (accepted && (parts.last() == Some(&scope.as_str()) || parts.last() == Some(&cid)))
        .then(|| path.to_owned())
}
pub struct Process {
    pub container_id: String,
    pub pid: u32,
    pub start_ticks: u64,
    pub pid_namespace: NamespaceIdentity,
    pub cgroup_inode: u64,
    relative: String,
    directory: File,
    pidfd: OwnedFd,
    pod_uid: String,
}
/// Shared io.max configuration and measured IO for the exact Pod/device, including its host worker.
/// These limits do not bound metadata/swap BIOs or replace Cloudflare's allocation reservation.
pub struct SharedBudget {
    pub pod_cgroup_inode: u64,
    directory: File,
    relative: String,
}
/// Published PID numbers belong to the initial host namespace used by Talos readback.
/// Internal pidfds and CRI calls retain their original caller-namespace numbers.
pub fn host_pids(processes: &[Process]) -> Result<std::collections::BTreeMap<u32, u32>, Status> {
    let host = crate::host_proc::HostProc::inherited()?;
    if host.boot_id()? != crate::storage::current_boot_id()? {
        return Err(refused());
    }
    let requested = processes
        .iter()
        .map(|p| crate::host_proc::ProcessMapping {
            cri_pid: p.pid,
            start_ticks: p.start_ticks,
            pid_namespace: p.pid_namespace,
        })
        .collect::<Vec<_>>();
    host.map(&requested)
}
impl SharedBudget {
    pub fn capture(processes: &[Process]) -> Result<Self, Status> {
        let first = processes.first().ok_or_else(refused)?;
        let parent = std::path::Path::new(&first.relative)
            .parent()
            .and_then(|p| p.to_str())
            .ok_or_else(refused)?;
        for p in processes {
            p.recheck()?;
            if p.pod_uid != first.pod_uid
                || std::path::Path::new(&p.relative)
                    .parent()
                    .and_then(|p| p.to_str())
                    != Some(parent)
            {
                return Err(refused());
            }
        }
        let root = File::open("/sys/fs/cgroup").map_err(|_| refused())?;
        let directory = beneath(&root, parent, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let meta = directory.metadata().map_err(|_| refused())?;
        if !meta.is_dir() || meta.uid() != 0 {
            return Err(refused());
        }
        Ok(Self {
            pod_cgroup_inode: meta.ino(),
            directory,
            relative: parent.to_owned(),
        })
    }
    pub fn recheck(&self) -> Result<(), Status> {
        let root = File::open("/sys/fs/cgroup").map_err(|_| refused())?;
        let current = beneath(&root, &self.relative, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let a = current.metadata().map_err(|_| refused())?;
        let b = self.directory.metadata().map_err(|_| refused())?;
        if a.dev() != b.dev() || a.ino() != self.pod_cgroup_inode {
            return Err(refused());
        }
        Ok(())
    }
    pub fn set_io(&self, device: u64, bps: u64, iops: u64) -> Result<(), Status> {
        self.recheck()?;
        if bps == 0 || iops == 0 {
            return Err(refused());
        }
        let mut f = beneath(&self.directory, "io.max", libc::O_WRONLY)?;
        f.write_all(
            format!(
                "{}:{} wbps={bps} wiops={iops}\n",
                libc::major(device),
                libc::minor(device)
            )
            .as_bytes(),
        )
        .map_err(|_| refused())?;
        if !self.io_matches(device, bps, iops)? {
            return Err(refused());
        }
        Ok(())
    }
    pub fn io_matches(&self, device: u64, bps: u64, iops: u64) -> Result<bool, Status> {
        self.recheck()?;
        limits_match(&self.directory, device, bps, iops)
    }
    pub fn write_bytes(&self, device: u64) -> Result<Option<u64>, Status> {
        self.recheck()?;
        counter(&self.directory, device)
    }
}
fn limits_match(directory: &File, device: u64, bps: u64, iops: u64) -> Result<bool, Status> {
    let wanted = format!("{}:{}", libc::major(device), libc::minor(device));
    let raw = read(directory, "io.max")?;
    let rows = raw
        .lines()
        .filter(|l| l.split_whitespace().next() == Some(&wanted))
        .collect::<Vec<_>>();
    if rows.len() != 1 {
        return Ok(false);
    }
    let fields = rows[0].split_whitespace().skip(1).collect::<Vec<_>>();
    Ok(
        fields.iter().filter(|f| f.starts_with("wbps=")).count() == 1
            && fields.iter().filter(|f| f.starts_with("wiops=")).count() == 1
            && fields.contains(&format!("wbps={bps}").as_str())
            && fields.contains(&format!("wiops={iops}").as_str()),
    )
}
fn counter(directory: &File, device: u64) -> Result<Option<u64>, Status> {
    let wanted = format!("{}:{}", libc::major(device), libc::minor(device));
    let raw = read(directory, "io.stat")?;
    let rows = raw
        .lines()
        .filter(|l| l.split_whitespace().next() == Some(&wanted))
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Ok(None);
    }
    if rows.len() != 1 {
        return Err(refused());
    }
    let fields = rows[0]
        .split_whitespace()
        .filter_map(|f| f.strip_prefix("wbytes="))
        .collect::<Vec<_>>();
    if fields.is_empty() {
        return Ok(None);
    }
    if fields.len() != 1 {
        return Err(refused());
    }
    Ok(Some(fields[0].parse().map_err(|_| refused())?))
}
impl Process {
    pub fn capture(pid: u32, pod: &str, cid: &str) -> Result<Self, Status> {
        if pid == 0
            || pod.len() != 36
            || cid.len() != 64
            || !cid
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(refused());
        }
        let start = crate::slot::start_ticks(pid)?;
        let pid_namespace = crate::slot::namespace(pid, "pid")?;
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            return Err(refused());
        }
        let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let raw = fs::read_to_string(format!("/proc/{pid}/cgroup")).map_err(|_| refused())?;
        let relative = path(&raw, pod, cid).ok_or_else(refused)?;
        let root = File::open("/sys/fs/cgroup").map_err(|_| refused())?;
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(root.as_raw_fd(), &mut stat) } != 0
            || i128::from(stat.f_type) != 0x6367_7270
        {
            return Err(refused());
        }
        let directory = beneath(&root, &relative, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let meta = directory.metadata().map_err(|_| refused())?;
        if meta.uid() != 0 || !meta.is_dir() {
            return Err(refused());
        }
        let out = Self {
            container_id: cid.to_owned(),
            pid,
            start_ticks: start,
            pid_namespace,
            cgroup_inode: meta.ino(),
            relative,
            directory,
            pidfd,
            pod_uid: pod.to_owned(),
        };
        out.recheck()?;
        Ok(out)
    }
    pub fn recheck(&self) -> Result<(), Status> {
        let mut poll = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } != 0
            || crate::slot::start_ticks(self.pid)? != self.start_ticks
            || crate::slot::namespace(self.pid, "pid")? != self.pid_namespace
        {
            return Err(refused());
        }
        let raw =
            fs::read_to_string(format!("/proc/{}/cgroup", self.pid)).map_err(|_| refused())?;
        if path(&raw, &self.pod_uid, &self.container_id).as_deref() != Some(self.relative.as_str())
        {
            return Err(refused());
        }
        self.group_recheck()
    }
    /// This already-captured immutable group may still hold descendants after PID1 exits.
    /// It grants protection/cleanup custody only, never a new writer or process identity.
    pub fn group_recheck(&self) -> Result<(), Status> {
        let root = File::open("/sys/fs/cgroup").map_err(|_| refused())?;
        let current = beneath(&root, &self.relative, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let a = current.metadata().map_err(|_| refused())?;
        let b = self.directory.metadata().map_err(|_| refused())?;
        if a.dev() != b.dev()
            || a.ino() != self.cgroup_inode
            || a.uid() != 0
            || b.ino() != self.cgroup_inode
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn set_io(&self, device: u64, bps: u64, iops: u64) -> Result<(), Status> {
        self.recheck()?;
        if bps == 0 || iops == 0 {
            return Err(refused());
        }
        let mut file = beneath(&self.directory, "io.max", libc::O_WRONLY)?;
        let limits = format!(
            "{}:{} wbps={bps} wiops={iops}\n",
            libc::major(device),
            libc::minor(device)
        );
        file.write_all(limits.as_bytes()).map_err(|_| refused())?;
        self.recheck()?;
        if !self.io_matches(device, bps, iops)? {
            return Err(refused());
        }
        Ok(())
    }
    pub fn io_matches(&self, device: u64, bps: u64, iops: u64) -> Result<bool, Status> {
        self.recheck()?;
        limits_match(&self.directory, device, bps, iops)
    }
    pub fn write_bytes(&self, device: u64) -> Result<Option<u64>, Status> {
        counter(&self.directory, device)
    }
    pub fn idle_counters(&self) -> Result<(u64, u64), Status> {
        self.recheck()?;
        let memory = read(&self.directory, "memory.current")?
            .trim()
            .parse()
            .map_err(|_| refused())?;
        let cpu = read(&self.directory, "cpu.stat")?;
        let rows = cpu
            .lines()
            .filter_map(|line| line.strip_prefix("usage_usec "))
            .collect::<Vec<_>>();
        if rows.len() != 1 {
            return Err(refused());
        }
        Ok((memory, rows[0].parse().map_err(|_| refused())?))
    }
    /// The fixed single-thread host worker enters the already verified/throttled supervisor cgroup.
    pub fn join_own_worker(&self) -> Result<(), Status> {
        self.recheck()?;
        if unsafe { libc::geteuid() } != 0
            || fs::read_dir("/proc/self/task")
                .map_err(|_| refused())?
                .take(2)
                .count()
                != 1
        {
            return Err(refused());
        }
        let mut file = beneath(&self.directory, "cgroup.procs", libc::O_WRONLY)?;
        file.write_all(std::process::id().to_string().as_bytes())
            .map_err(|_| refused())?;
        let raw = fs::read_to_string("/proc/self/cgroup").map_err(|_| refused())?;
        if path(&raw, &self.pod_uid, &self.container_id).as_deref() != Some(self.relative.as_str())
        {
            return Err(refused());
        }
        Ok(())
    }
    pub fn stop_group(&self) -> Result<(), Status> {
        self.group_recheck()?;
        let mut file = beneath(&self.directory, "cgroup.kill", libc::O_WRONLY)?;
        file.write_all(b"1").map_err(|_| refused())
    }
    pub fn populated(&self) -> Result<bool, Status> {
        self.group_recheck()?;
        let raw = read(&self.directory, "cgroup.events")?;
        let rows = raw
            .lines()
            .filter_map(|l| l.strip_prefix("populated "))
            .collect::<Vec<_>>();
        if rows.len() != 1 {
            return Err(refused());
        }
        match rows[0] {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(refused()),
        }
    }
    pub fn directory_path(&self) -> PathBuf {
        PathBuf::from("/sys/fs/cgroup").join(&self.relative)
    }
}
/// Durable captured groups allow protection after PID1 exits; they never establish a fresh writer.
pub use crate::pool_journal::GroupRecord;
pub struct CapturedGroup {
    pub record: GroupRecord,
    directory: File,
}
impl Process {
    pub fn group_record(&self) -> GroupRecord {
        GroupRecord {
            pod_uid: self.pod_uid.clone(),
            container_id: self.container_id.clone(),
            cgroup_inode: self.cgroup_inode,
            relative: self.relative.clone(),
        }
    }
}
impl CapturedGroup {
    pub fn restore(record: &GroupRecord) -> Result<Self, Status> {
        if record.cgroup_inode == 0
            || path(
                &format!("0::/{}\n", record.relative),
                &record.pod_uid,
                &record.container_id,
            )
            .as_deref()
                != Some(record.relative.as_str())
        {
            return Err(refused());
        }
        let root = File::open("/sys/fs/cgroup").map_err(|_| refused())?;
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatfs(root.as_raw_fd(), &mut stat) } != 0
            || i128::from(stat.f_type) != 0x6367_7270
        {
            return Err(refused());
        }
        let directory = beneath(&root, &record.relative, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let m = directory.metadata().map_err(|_| refused())?;
        if !m.is_dir() || m.uid() != 0 || m.ino() != record.cgroup_inode {
            return Err(refused());
        }
        Ok(Self {
            record: record.clone(),
            directory,
        })
    }
    pub fn recheck(&self) -> Result<(), Status> {
        let current = Self::restore(&self.record)?;
        let a = current.directory.metadata().map_err(|_| refused())?;
        let b = self.directory.metadata().map_err(|_| refused())?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err(refused());
        }
        Ok(())
    }
    pub fn populated(&self) -> Result<bool, Status> {
        self.recheck()?;
        let raw = read(&self.directory, "cgroup.events")?;
        let rows = raw
            .lines()
            .filter_map(|l| l.strip_prefix("populated "))
            .collect::<Vec<_>>();
        if rows.len() != 1 {
            return Err(refused());
        }
        match rows[0] {
            "0" => Ok(false),
            "1" => Ok(true),
            _ => Err(refused()),
        }
    }
    pub fn stop(&self) -> Result<(), Status> {
        self.recheck()?;
        let mut file = beneath(&self.directory, "cgroup.kill", libc::O_WRONLY)?;
        file.write_all(b"1").map_err(|_| refused())
    }
    pub fn join_cleanup_worker(&self) -> Result<(), Status> {
        self.recheck()?;
        if self.populated()?
            || unsafe { libc::geteuid() } != 0
            || fs::read_dir("/proc/self/task")
                .map_err(|_| refused())?
                .take(2)
                .count()
                != 1
        {
            return Err(refused());
        }
        let mut f = beneath(&self.directory, "cgroup.procs", libc::O_WRONLY)?;
        f.write_all(std::process::id().to_string().as_bytes())
            .map_err(|_| refused())?;
        let raw = fs::read_to_string("/proc/self/cgroup").map_err(|_| refused())?;
        if path(&raw, &self.record.pod_uid, &self.record.container_id).as_deref()
            != Some(self.record.relative.as_str())
        {
            return Err(refused());
        }
        self.only_worker()
    }
    pub fn only_worker(&self) -> Result<(), Status> {
        self.recheck()?;
        let raw = read(&self.directory, "cgroup.procs")?;
        let pids = raw
            .split_whitespace()
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| refused())?;
        if pids != [std::process::id()] {
            return Err(refused());
        }
        // Ordinary container groups have no nested tasks at pre-grant; any populated subgroup refuses.
        let root = PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()));
        let mut pending = vec![root];
        let mut seen = 0;
        while let Some(dir) = pending.pop() {
            for entry in fs::read_dir(&dir).map_err(|_| refused())? {
                let entry = entry.map_err(|_| refused())?;
                seen += 1;
                if seen > 4096 {
                    return Err(refused());
                }
                let kind = entry.file_type().map_err(|_| refused())?;
                if kind.is_symlink() {
                    return Err(refused());
                }
                if kind.is_dir() {
                    let child = beneath(
                        &self.directory,
                        entry
                            .path()
                            .strip_prefix(pending_root(self))
                            .map_err(|_| refused())?
                            .to_str()
                            .ok_or_else(refused)?,
                        libc::O_RDONLY | libc::O_DIRECTORY,
                    )?;
                    let raw = read(&child, "cgroup.events")?;
                    if raw.lines().any(|l| l == "populated 1") {
                        return Err(refused());
                    }
                    pending.push(entry.path())
                }
            }
        }
        Ok(())
    }
}
fn pending_root(group: &CapturedGroup) -> PathBuf {
    PathBuf::from(format!("/proc/self/fd/{}", group.directory.as_raw_fd()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_bind_real_guaranteed_or_burstable_pod_and_container_suffix() {
        let pod = "d14b4e92-5b29-455d-adcc-3b9ba6a4ca74";
        let cid = "a".repeat(64);
        let unit = pod.replace('-', "_");
        assert!(
            path(
                &format!(
                    "0::/kubepods.slice/kubepods-pod{unit}.slice/cri-containerd-{cid}.scope\n"
                ),
                pod,
                &cid
            )
            .is_some()
        );
        assert!(
            path(
                &format!("0::/kubepods/burstable/pod{pod}/{cid}\n"),
                pod,
                &cid
            )
            .is_some()
        );
        assert!(path(&format!("0::/kubepods/pod{pod}/{cid}/other\n"), pod, &cid).is_none());
        assert!(path("0::/../../unsafe\n", pod, &cid).is_none());
    }
}
