// SPDX-License-Identifier: Apache-2.0
use crate::policy::Policy;
use std::{
    ffi::CString,
    fs,
    path::{Path, PathBuf},
};
use tonic::Status;

#[derive(Clone)]
pub struct Budget {
    pub root: PathBuf,
    pub cpu_millicores: u32,
    pub memory_mib: u32,
}
fn failed() -> Status {
    Status::failed_precondition("idle_cgroup_budget_unavailable")
}
fn write(path: &Path, name: &str, value: impl ToString) -> Result<(), Status> {
    fs::write(path.join(name), value.to_string()).map_err(|_| failed())
}
fn directory(path: &Path) -> Result<(), Status> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) =>
        {
            Ok(())
        }
        Err(_) => Err(failed()),
    }
}
pub fn configure(root: &Path, policy: &Policy) -> Result<Budget, Status> {
    if !root.starts_with("/sys/fs/cgroup/")
        || root == Path::new("/sys/fs/cgroup")
        || root
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(failed());
    }
    directory(root)?;
    write(root, "cgroup.subtree_control", "+cpu +memory +pids")?;
    let idle = root.join("idle");
    directory(&idle)?;
    directory(&root.join("assigned"))?;
    write(
        &idle,
        "cpu.max",
        format!("{} 100000", policy.max_idle_cpu_millicores * 100),
    )?;
    write(
        &idle,
        "memory.max",
        u64::from(policy.max_idle_memory_mib) * 1048576,
    )?;
    write(&idle, "pids.max", policy.target_slots.max(1) * 32)?;
    write(&idle, "cgroup.subtree_control", "+cpu +memory +pids")?;
    Ok(Budget {
        root: root.to_owned(),
        cpu_millicores: policy.per_slot_cpu_millicores,
        memory_mib: policy.per_slot_memory_mib,
    })
}
impl Budget {
    pub fn prepare(&self, id: &str) -> Result<PathBuf, Status> {
        let path = self.root.join("idle").join(id);
        directory(&path)?;
        write(
            &path,
            "cpu.max",
            format!("{} 100000", self.cpu_millicores * 100),
        )?;
        write(&path, "memory.max", u64::from(self.memory_mib) * 1048576)?;
        write(&path, "pids.max", 32)?;
        Ok(path)
    }
    pub fn assign(&self, id: &str, pids: &[u32]) -> Result<PathBuf, Status> {
        let path = self.root.join("assigned").join(id);
        directory(&path)?;
        for pid in pids {
            write(&path, "cgroup.procs", pid)?;
        }
        let _ = fs::remove_dir(self.root.join("idle").join(id));
        Ok(path)
    }
}
pub fn metrics(root: &Path) -> (Option<u64>, Option<u64>) {
    let idle = root.join("idle");
    let memory = fs::read_to_string(idle.join("memory.current"))
        .ok()
        .and_then(|value| value.trim().parse().ok());
    let cpu = fs::read_to_string(idle.join("cpu.stat"))
        .ok()
        .and_then(|value| {
            value.lines().find_map(|line| {
                line.strip_prefix("usage_usec ")
                    .and_then(|value| value.parse().ok())
            })
        });
    (memory, cpu)
}
pub fn proc_path(path: &Path) -> Result<CString, Status> {
    CString::new(path.join("cgroup.procs").as_os_str().as_encoded_bytes()).map_err(|_| failed())
}
pub async fn discard_unassigned(root: &Path, id: &str) -> Result<(), Status> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(failed());
    }
    let path = root.join("idle").join(id);
    if path.exists() {
        write(&path, "cgroup.kill", 1)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if fs::read_to_string(path.join("cgroup.procs"))
                .is_ok_and(|value| value.trim().is_empty())
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(failed());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        fs::remove_dir(path).map_err(|_| failed())?;
    }
    Ok(())
}
/// Only async-signal-safe syscalls; invoked in the owned fork child before exec.
pub fn enter_before_exec(path: &CString) -> std::io::Result<()> {
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let count = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
    let error = std::io::Error::last_os_error();
    unsafe { libc::close(fd) };
    if count != 1 {
        return Err(error);
    }
    Ok(())
}
