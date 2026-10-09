// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    authority::{limit, schema, text, unsigned},
};
use pgcf_native_controller::kubernetes::Kubernetes;
use serde_json::{Value, json};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::Path,
};
const PROC: &str = "/host/proc";
const CGROUP: &str = "/host/cgroup";
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
fn beneath(root: &File, path: &str, flags: i32) -> Result<File, Error> {
    let path = CString::new(path)?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
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
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(unsafe { File::from_raw_fd(fd as i32) })
}
fn read(root: &File, name: &str) -> Result<String, Error> {
    let mut data = String::new();
    beneath(root, name, libc::O_RDONLY)?
        .take(65537)
        .read_to_string(&mut data)?;
    if data.len() > 65536 {
        return Err("local binding read exceeds bound".into());
    }
    Ok(data)
}
pub fn bounded_json(path: &Path, max: usize) -> Result<Value, Error> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    if meta.uid() != 0 || meta.mode() & 0o022 != 0 || !meta.is_file() {
        return Err("untrusted local reclaim producer".into());
    }
    let mut data = vec![];
    file.take(max as u64 + 1).read_to_end(&mut data)?;
    if data.len() > max {
        return Err("local reclaim input exceeds bound".into());
    }
    Ok(serde_json::from_slice(&data)?)
}
pub fn start_ticks(stat: &str) -> Result<u64, Error> {
    stat.rsplit_once(") ")
        .and_then(|(_, fields)| fields.split_whitespace().nth(19))
        .ok_or("process start binding absent")?
        .parse()
        .map_err(Into::into)
}
pub fn cgroup_path(source: &str, pod: &str, container: &str) -> Result<String, Error> {
    let rows: Vec<_> = source.lines().collect();
    if rows.len() != 1 {
        return Err("reclaimer requires unified cgroup v2".into());
    }
    let path = rows[0]
        .strip_prefix("0::/")
        .ok_or("invalid cgroup binding")?;
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(['\\', '\0', ' ']))
    {
        return Err("cgroup path cannot escape".into());
    }
    let systemd_pod = format!("kubepods-burstable-pod{}.slice", pod.replace('-', "_"));
    let systemd_container = format!("cri-containerd-{container}.scope");
    let cgroupfs_pod = format!("pod{pod}");
    let systemd = parts.windows(4).any(|p| {
        p == [
            "kubepods.slice",
            "kubepods-burstable.slice",
            systemd_pod.as_str(),
            systemd_container.as_str(),
        ]
    }) && parts.last() == Some(&systemd_container.as_str());
    let cgroupfs = parts
        .windows(4)
        .any(|p| p == ["kubepods", "burstable", cgroupfs_pod.as_str(), container])
        && parts.last() == Some(&container);
    if !systemd && !cgroupfs {
        return Err("target is not the exact Burstable PostgreSQL cgroup".into());
    }
    Ok(path.into())
}
fn proc_membership(source: &str, pod: &str, container: &str) -> bool {
    let rows: Vec<_> = source.lines().collect();
    if rows.len() != 1 {
        return false;
    }
    let Some(raw) = rows[0].strip_prefix("0::/") else {
        return false;
    };
    let parts: Vec<_> = raw.split('/').skip_while(|part| *part == "..").collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == ".." || *part == ".")
    {
        return false;
    }
    let systemd_pod = format!("kubepods-burstable-pod{}.slice", pod.replace('-', "_"));
    parts.ends_with(&[
        systemd_pod.as_str(),
        format!("cri-containerd-{container}.scope").as_str(),
    ]) || parts.ends_with(&[format!("pod{pod}").as_str(), container])
}
fn condition(v: &Value, name: &str) -> bool {
    v["status"]["conditions"].as_array().is_some_and(|rows| {
        rows.iter()
            .any(|r| r["type"] == name && r["status"] == "True")
    })
}
fn owned(v: &Value, claims: &Value, uid: &str) -> bool {
    v["metadata"]["uid"] == claims[uid]
        && v["metadata"]["labels"]["pgcf.io/database-id"] == claims["database_id"]
        && v["metadata"]["deletionTimestamp"].is_null()
        && !text(&v["metadata"], "resourceVersion").is_empty()
}
pub async fn kube_binding(kube: &Kubernetes, node_name: &str, claims: &Value) -> Result<(), Error> {
    kube.assert_cluster(text(claims, "cluster_uid")).await?;
    let namespace = format!("pgcf-db-{}", text(claims, "database_id"));
    let storage_name = format!("storage-{}", text(claims, "database_id"));
    let (node, ns, cluster, storage) = tokio::try_join!(
        kube.read("Node", None, node_name),
        kube.read("Namespace", None, &namespace),
        kube.read("Cluster", Some(&namespace), "database"),
        kube.read("ConfigMap", Some("pgcf-system"), &storage_name)
    )?;
    let node = node.ok_or("reclaim node unavailable")?;
    let ns = ns.ok_or("reclaim Namespace unavailable")?;
    let cluster = cluster.ok_or("reclaim Cluster unavailable")?;
    let storage = storage.ok_or("reclaim storage receipt unavailable")?;
    if node["metadata"]["uid"] != claims["node_uid"]
        || node["status"]["nodeInfo"]["bootID"] != claims["boot_id"]
        || node["metadata"]["labels"]
            .as_object()
            .is_some_and(|labels| labels.contains_key("node-role.kubernetes.io/control-plane"))
        || !condition(&node, "Ready")
        || node["spec"]["unschedulable"] == true
        || !owned(&ns, claims, "namespace_uid")
        || !owned(&cluster, claims, "cnpg_cluster_uid")
        || !owned(&storage, claims, "storage_uid")
        || !condition(&cluster, "Ready")
        || condition(&cluster, "Hibernated")
    {
        return Err("reclaim workload identity or approved worker changed".into());
    }
    if [&ns, &cluster, &storage].iter().any(|value| {
        pgcf_native_controller::contracts::generation(value)
            != unsigned(claims, "generation").unwrap_or(0)
    }) {
        return Err("reclaim configuration generation changed".into());
    }
    let state: Value = serde_json::from_str(text(&storage["data"], "state"))?;
    let archive = text(&state, "archivePath");
    if state["namespaceUid"] != claims["namespace_uid"]
        || state["clusterUid"] != claims["cnpg_cluster_uid"]
        || state["node"] != node_name
        || !archive.rsplit('/').next().is_some_and(|part| {
            part.starts_with(&format!(
                "g{}-",
                unsigned(claims, "storage_generation").unwrap_or(0)
            ))
        })
    {
        return Err("reclaim physical storage generation changed".into());
    }
    let pod_name = text(&cluster["status"], "currentPrimary");
    let pod = kube
        .read("Pod", Some(&namespace), pod_name)
        .await?
        .ok_or("reclaim primary unavailable")?;
    let owner = pod["metadata"]["ownerReferences"]
        .as_array()
        .is_some_and(|owners| {
            owners
                .iter()
                .any(|o| o["kind"] == "Cluster" && o["uid"] == claims["cnpg_cluster_uid"])
        });
    let status = pod["status"]["containerStatuses"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["name"] == "postgres"));
    let container = pod["spec"]["containers"]
        .as_array()
        .and_then(|rows| rows.iter().find(|r| r["name"] == "postgres"));
    if pod["metadata"]["uid"] != claims["pod_uid"]
        || pod["spec"]["nodeName"] != node_name
        || !owner
        || !condition(&pod, "Ready")
        || !pod["metadata"]["deletionTimestamp"].is_null()
        || status.is_none_or(|s| {
            s["containerID"] != format!("containerd://{}", text(claims, "container_id"))
                || s["ready"] != true
                || s["state"]["running"].is_null()
                || !text(s, "imageID")
                    .ends_with(&format!("sha256:{}", text(claims, "postgres_image_sha256")))
        })
        || container.is_none_or(|c| {
            pgcf_native_controller::reconcile::quantity(&c["resources"]["requests"]["memory"])
                != Some(unsigned(claims, "memory_request_bytes").unwrap_or(0) as f64)
                || pgcf_native_controller::reconcile::quantity(&c["resources"]["limits"]["memory"])
                    != Some(unsigned(claims, "memory_limit_bytes").unwrap_or(0) as f64)
        })
    {
        return Err("reclaim PostgreSQL container binding changed".into());
    }
    let claim_name = pod["spec"]["volumes"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v["name"] == "pgdata"))
        .map(|v| text(&v["persistentVolumeClaim"], "claimName"))
        .ok_or("reclaim pgdata binding missing")?;
    let pvc = kube
        .read("PersistentVolumeClaim", Some(&namespace), claim_name)
        .await?
        .ok_or("reclaim PVC missing")?;
    let pv = kube
        .read("PersistentVolume", None, text(&pvc["spec"], "volumeName"))
        .await?
        .ok_or("reclaim PV missing")?;
    if pvc["metadata"]["uid"] != claims["pvc_uid"]
        || pv["metadata"]["uid"] != claims["pv_uid"]
        || pv["spec"]["claimRef"]["uid"] != claims["pvc_uid"]
        || pv["spec"]["claimRef"]["namespace"] != namespace
    {
        return Err("reclaim PV/PVC custody changed".into());
    }
    Ok(())
}
pub fn encrypted_swap(expected: &[String]) -> Result<(), Error> {
    use std::os::unix::fs::FileTypeExt;
    if expected.is_empty() || expected.len() > 8 {
        return Err("encrypted swap qualification absent".into());
    }
    let swaps = fs::read_to_string(format!("{PROC}/swaps"))?;
    let mut count = 0;
    for line in swaps.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() != 5 || fields[1] != "partition" {
            return Err("unqualified swap backend".into());
        }
        let relative = fields[0]
            .strip_prefix("/dev/")
            .ok_or("unexpected swap device")?;
        if relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        {
            return Err("swap device path invalid".into());
        }
        let path = fs::canonicalize(Path::new("/host/dev").join(relative))?;
        if !path.starts_with("/host/dev") {
            return Err("swap device escaped approved host mount".into());
        }
        let metadata = fs::metadata(path)?;
        if !metadata.file_type().is_block_device() {
            return Err("swap is not an encrypted block device".into());
        }
        let major = libc::major(metadata.rdev());
        let minor = libc::minor(metadata.rdev());
        let uuid = fs::read_to_string(format!("/host/sys/dev/block/{major}:{minor}/dm/uuid"))?;
        let uuid = uuid.trim();
        if !uuid.starts_with("CRYPT-LUKS2-") || !expected.iter().any(|wanted| wanted == uuid) {
            return Err("actual encrypted swap identity changed".into());
        }
        count += 1;
    }
    if count == 0 {
        return Err("encrypted swap is not active".into());
    }
    Ok(())
}
pub struct Target {
    proc: File,
    cgroup: File,
    pidfd: OwnedFd,
    pid: u32,
    start: u64,
    pod: String,
    container: String,
    limit: u64,
}
impl Target {
    pub fn open(snapshot: &Value, claims: &Value, now: u64) -> Result<Self, Error> {
        if !schema("ReclaimTaskSnapshot", snapshot)
            || snapshot["node_uid"] != claims["node_uid"]
            || snapshot["boot_id"] != claims["boot_id"]
            || unsigned(snapshot, "captured_at")? > now.saturating_add(1000)
            || unsigned(snapshot, "expires_at")? <= now
            || unsigned(snapshot, "expires_at")?
                > unsigned(snapshot, "captured_at")?.saturating_add(limit("snapshot_ms"))
        {
            return Err("local task snapshot stale or changed".into());
        }
        if fs::read_to_string(format!("{PROC}/sys/kernel/random/boot_id"))?.trim()
            != text(claims, "boot_id")
            || fs::metadata("/proc/self/ns/pid")?.ino()
                != unsigned(snapshot, "cri_pid_namespace_inode")?
        {
            return Err("reclaimer is outside the trusted CRI PID namespace".into());
        }
        let candidates: Vec<_> = snapshot["tasks"]
            .as_array()
            .ok_or("local task inventory missing")?
            .iter()
            .filter(|t| {
                t["database_id"] == claims["database_id"]
                    && t["pod_uid"] == claims["pod_uid"]
                    && t["container_id"] == claims["container_id"]
            })
            .collect();
        if candidates.len() != 1 {
            return Err("ambiguous or missing PostgreSQL task".into());
        }
        let task = candidates[0];
        if !text(task, "postgres_image_id")
            .ends_with(&format!("sha256:{}", text(claims, "postgres_image_sha256")))
            || task["container_name"] != "postgres"
            || task["namespace"] != format!("pgcf-db-{}", text(claims, "database_id"))
        {
            return Err("reclaim target namespace invalid".into());
        }
        let pid = u32::try_from(unsigned(task, "cri_pid")?)?;
        let proc = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(format!("{PROC}/{pid}"))?;
        let start = unsigned(task, "start_ticks")?;
        if start_ticks(&read(&proc, "stat")?)? != start {
            return Err("reclaim process was replaced".into());
        }
        if !proc_membership(
            &read(&proc, "cgroup")?,
            text(claims, "pod_uid"),
            text(claims, "container_id"),
        ) {
            return Err("reclaim process moved cgroup".into());
        }
        let path = cgroup_path(
            &format!("0::{}", text(task, "cgroup_path")),
            text(claims, "pod_uid"),
            text(claims, "container_id"),
        )?;
        let root = File::open(CGROUP)?;
        let cgroup = beneath(&root, &path, libc::O_RDONLY | libc::O_DIRECTORY)?;
        let mut fsinfo = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(cgroup.as_raw_fd(), fsinfo.as_mut_ptr()) } != 0
            || unsafe { fsinfo.assume_init() }.f_type != 0x63677270
            || cgroup.metadata()?.ino() != unsigned(task, "cgroup_inode")?
        {
            return Err("reclaim cgroup identity changed".into());
        }
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let target = Self {
            proc,
            cgroup,
            pidfd: unsafe { OwnedFd::from_raw_fd(fd as i32) },
            pid,
            start,
            pod: text(claims, "pod_uid").into(),
            container: text(claims, "container_id").into(),
            limit: unsigned(claims, "memory_limit_bytes")?,
        };
        target.verify()?;
        Ok(target)
    }
    pub fn verify(&self) -> Result<(), Error> {
        let mut poll = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } != 0
            || start_ticks(&read(&self.proc, "stat")?)? != self.start
            || !proc_membership(&read(&self.proc, "cgroup")?, &self.pod, &self.container)
            || !read(&self.cgroup, "cgroup.procs")?
                .lines()
                .any(|p| p.parse::<u32>().ok() == Some(self.pid))
            || read(&self.cgroup, "memory.max")?.trim().parse::<u64>()? != self.limit
            || read(&self.cgroup, "memory.swap.max")?
                .trim()
                .parse::<u64>()?
                == 0
            || !read(&self.cgroup, "cgroup.events")?
                .lines()
                .any(|line| line == "populated 1")
            || read(&self.cgroup, "cgroup.events")?
                .lines()
                .any(|line| line == "frozen 1")
        {
            return Err("reclaim local process or swap allowance changed".into());
        }
        Ok(())
    }
    pub fn metrics(&self) -> Result<Value, Error> {
        self.verify()?;
        let memory = read(&self.cgroup, "memory.current")?
            .trim()
            .parse::<u64>()?;
        let swap = read(&self.cgroup, "memory.swap.current")?
            .trim()
            .parse::<u64>()?;
        let mut stats = serde_json::Map::new();
        for line in read(&self.cgroup, "memory.stat")?.lines() {
            let mut v = line.split_whitespace();
            if let (Some(name), Some(value)) = (v.next(), v.next())
                && [
                    "anon",
                    "file",
                    "zswap",
                    "zswapped",
                    "pswpin",
                    "pswpout",
                    "pgfault",
                    "pgmajfault",
                ]
                .contains(&name)
            {
                stats.insert(name.into(), value.parse::<u64>()?.into());
            }
        }
        Ok(json!({"memory_current_bytes":memory,"swap_current_bytes":swap,"memory_stat":stats}))
    }
    pub fn reclaim_fd(&self) -> Result<File, Error> {
        self.verify()?;
        beneath(&self.cgroup, "memory.reclaim", libc::O_WRONLY)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cgroup_derivation_cannot_target_system_services_or_other_container() {
        let pod = "01234567-89ab-4def-8123-012345678901";
        let id = "a".repeat(64);
        let path = format!(
            "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod{}.slice/cri-containerd-{id}.scope",
            pod.replace('-', "_")
        );
        assert!(cgroup_path(&path, pod, &id).is_ok());
        assert!(cgroup_path(&path, pod, &"b".repeat(64)).is_err());
        assert!(cgroup_path("0::/system.slice/containerd.service", pod, &id).is_err());
        assert!(
            cgroup_path(
                &path.replace("kubepods.slice/", "kubepods.slice/../"),
                pod,
                &id
            )
            .is_err()
        );
    }
    #[test]
    fn stat_parser_handles_parentheses_without_weakening_pid_start_binding() {
        let fields = (0..20)
            .map(|i| {
                if i == 19 {
                    "987".to_owned()
                } else {
                    "0".to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            start_ticks(&format!("1 (postgres ) helper) {fields}")).unwrap(),
            987
        );
        assert!(start_ticks("1 (postgres) bad").is_err());
    }
}
