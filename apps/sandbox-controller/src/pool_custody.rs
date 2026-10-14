// SPDX-License-Identifier: Apache-2.0
//! Actual running ordinary containerd/CRI pool process projection; Pod annotations never prove boot.
use crate::{
    containerd::services::{containers::v1 as containers, tasks::v1 as tasks},
    cri,
    pool_io::Process,
    slot::Settings,
    transport,
};
use serde_json::Value;
use std::{collections::BTreeSet, fs};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_oci_process_custody_unconfirmed")
}
pub struct Container {
    pub process: Process,
    pub pod_uid: String,
    pub pod_name: String,
    pub sandbox_id: String,
    pub role: String,
    pub image: String,
    pub configured_image: String,
    pub mount_namespace_inode: u64,
    pub specification: Value,
}
fn status_safe(pid: u32) -> Result<(), Status> {
    let raw = fs::read_to_string(format!("/proc/{pid}/status")).map_err(|_| refused())?;
    if raw.len() > 65536 {
        return Err(refused());
    }
    let field = |key: &str| {
        raw.lines()
            .find_map(|l| l.strip_prefix(key))
            .map(str::trim)
            .ok_or_else(refused)
    };
    let uid = field("Uid:")?
        .split_whitespace()
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| refused())?;
    if uid.len() != 4
        || uid.iter().any(|id| *id != 26)
        || field("NoNewPrivs:")? != "1"
        || field("Seccomp:")? != "2"
    {
        return Err(refused());
    }
    for name in ["CapEff:", "CapPrm:", "CapBnd:", "CapInh:", "CapAmb:"] {
        if u64::from_str_radix(field(name)?, 16).map_err(|_| refused())? != 0 {
            return Err(refused());
        }
    }
    // task_dump_owner() makes this sensitive regular inode namespace-root-owned when ND=0.
    // The /proc/PID DIRECTORY is intentionally not a witness; it retains the process EUID.
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::metadata(format!("/proc/{pid}/environ")).map_err(|_| refused())?;
    if !metadata.is_file() || metadata.uid() != 0 {
        return Err(refused());
    }
    Ok(())
}
pub fn oci_safe(spec: &Value) -> bool {
    if spec["process"]["user"]["uid"] != 26 || spec["process"]["noNewPrivileges"] != true {
        return false;
    }
    for key in [
        "bounding",
        "effective",
        "permitted",
        "ambient",
        "inheritable",
    ] {
        let Some(caps) = spec["process"]["capabilities"][key].as_array() else {
            return false;
        };
        if !caps.is_empty() {
            return false;
        }
    }
    let seccomp = &spec["linux"]["seccomp"];
    if seccomp["defaultAction"] != "SCMP_ACT_ERRNO" {
        return false;
    }
    let Some(rules) = seccomp["syscalls"].as_array() else {
        return false;
    };
    let mount = [
        "mount",
        "umount2",
        "fsopen",
        "fsconfig",
        "fsmount",
        "open_tree",
        "move_mount",
        "mount_setattr",
        "setns",
        "unshare",
    ];
    for rule in rules {
        if rule["action"] != "SCMP_ACT_ALLOW" {
            continue;
        }
        let Some(names) = rule["names"].as_array() else {
            return false;
        };
        if names
            .iter()
            .any(|n| mount.iter().any(|name| n == name) || n == "clone3")
        {
            return false;
        }
        if names.iter().any(|n| n == "clone") {
            let Some(args) = rule["args"].as_array() else {
                return false;
            };
            if !args.iter().any(|arg| {
                arg["index"] == 0
                    && arg["op"] == "SCMP_CMP_MASKED_EQ"
                    && arg["valueTwo"] == 0
                    && arg["value"]
                        .as_u64()
                        .is_some_and(|mask| mask & 0x7e02_0000 == 0x7e02_0000)
            }) {
                return false;
            }
        }
    }
    true
}
pub async fn running(settings: &Settings) -> Result<Vec<Container>, Status> {
    let channel = transport::connect(&settings.containerd_socket).await?;
    let listed = containers::containers_client::ContainersClient::new(channel.clone())
        .list(transport::namespaced(
            containers::ListContainersRequest { filters: vec![] },
            &settings.namespace,
        )?)
        .await?
        .into_inner()
        .containers;
    if listed.len() > 10000 {
        return Err(refused());
    }
    let mut tasks = tasks::tasks_client::TasksClient::new(channel.clone());
    let mut cri = cri::runtime_service_client::RuntimeServiceClient::new(channel);
    let mut output = Vec::new();
    let mut seen = BTreeSet::new();
    for container in listed {
        let Some(spec) = container
            .spec
            .as_ref()
            .filter(|s| s.value.len() <= 512 * 1024)
        else {
            continue;
        };
        let Ok(spec) = serde_json::from_slice::<Value>(&spec.value) else {
            continue;
        };
        let a = &spec["annotations"];
        if a["io.kubernetes.cri.container-type"] != "container"
            || a["io.kubernetes.cri.sandbox-namespace"] != "pgcf-pool"
        {
            continue;
        }
        let Some(role) = a["io.kubernetes.cri.container-name"]
            .as_str()
            .filter(|r| matches!(*r, "postgres" | "archiver"))
        else {
            continue;
        };
        let Some(uid) = a["io.kubernetes.cri.sandbox-uid"]
            .as_str()
            .filter(|uid| uid.len() == 36)
        else {
            return Err(refused());
        };
        let Some(name) = a["io.kubernetes.cri.sandbox-name"]
            .as_str()
            .filter(|n| !n.is_empty() && n.len() <= 63)
        else {
            return Err(refused());
        };
        if a["io.kubernetes.cri.sandbox-id"] != container.sandbox
            || !oci_safe(&spec)
            || !seen.insert(container.id.clone())
        {
            return Err(refused());
        }
        let task = tasks
            .get(transport::namespaced(
                tasks::GetRequest {
                    container_id: container.id.clone(),
                    exec_id: String::new(),
                },
                &settings.namespace,
            )?)
            .await?
            .into_inner()
            .process
            .ok_or_else(refused)?;
        if task.status != 2 || task.pid == 0 {
            return Err(refused());
        }
        let status = cri
            .container_status(cri::ContainerStatusRequest {
                container_id: container.id.clone(),
                verbose: false,
            })
            .await?
            .into_inner()
            .status
            .ok_or_else(refused)?;
        if status.id != container.id
            || status.state != 1
            || status.metadata.as_ref().is_none_or(|m| m.name != role)
        {
            return Err(refused());
        }
        status_safe(task.pid)?;
        let process = Process::capture(task.pid, uid, &container.id)?;
        let mount_namespace_inode = crate::slot::namespace(task.pid, "mnt")?.inode;
        let result = Container {
            process,
            pod_uid: uid.to_owned(),
            pod_name: name.to_owned(),
            sandbox_id: container.sandbox,
            role: role.to_owned(),
            configured_image: status.image.as_ref().ok_or_else(refused)?.image.clone(),
            image: status.image_ref,
            mount_namespace_inode,
            specification: spec,
        };
        result.process.recheck()?;
        output.push(result);
        if output.len() > 256 {
            return Err(refused());
        }
    }
    Ok(output)
}
/// CRI may remove a tag from the reported digest reference, but never change its repository/digest.
pub fn image_matches(configured: &str, actual: &str, expected: &str) -> bool {
    let Some((repository, digest)) = expected.split_once("@sha256:") else {
        return false;
    };
    if configured != expected
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || repository.contains('@')
    {
        return false;
    }
    let slash = repository.rfind('/').unwrap_or(0);
    let without_tag = repository
        .rfind(':')
        .filter(|i| *i > slash)
        .map_or(repository, |i| &repository[..i]);
    actual == expected || actual == format!("{without_tag}@sha256:{digest}")
}
