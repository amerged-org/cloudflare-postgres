// SPDX-License-Identifier: Apache-2.0
//! Inventory measured from exact CF-prepared ordinary Pods, actual OCI tasks and named mounts.
use crate::{
    policy::Cloudflare,
    pool_custody::{Container, image_matches},
    pool_io::Process,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs::{File, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_prepared_inventory_unconfirmed")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
fn num(v: &Value, k: &str) -> Result<u64, Status> {
    v[k].as_u64().ok_or_else(refused)
}
pub fn context_valid(context: &Value, local: &Cloudflare) -> bool {
    pgcf_native_protocol::pool::validate("PoolPodPreparationContext", context)
        && context["node_id"] == local.node_id
        && context["node_uid"] == local.node_uid
        && crate::storage::current_boot_id().is_ok_and(|boot| context["boot_id"] == boot)
        && context["observed_at"]
            .as_u64()
            .is_some_and(|t| t <= now().saturating_add(5000) && now().saturating_sub(t) <= 60000)
        && context["expires_at"].as_u64().is_some_and(|t| t > now())
}
fn resources(container: &Container, expected: &Value, sidecar: bool) -> Result<(), Status> {
    let cpu = &container.specification["linux"]["resources"]["cpu"];
    let memory = &container.specification["linux"]["resources"]["memory"];
    let request = if sidecar {
        100
    } else {
        num(expected, "cpu_request_millicores")?
    };
    let limit = if sidecar {
        100
    } else {
        num(expected, "cpu_limit_millicores")?
    };
    let mem = if sidecar {
        128 * 1024 * 1024
    } else {
        num(expected, "memory_limit_bytes")?
    };
    let period = num(cpu, "period")?;
    if period == 0
        || cpu["shares"].as_u64() != Some((request.saturating_mul(1024) / 1000).clamp(2, 262144))
        || cpu["quota"].as_u64() != Some(limit.checked_mul(period).ok_or_else(refused)? / 1000)
        || memory["limit"].as_u64() != Some(mem)
    {
        return Err(refused());
    }
    Ok(())
}
fn archiver_probe(container: &Container, expected_exe: &str) -> Result<Value, Status> {
    container.process.recheck()?;
    if crate::policy::digest(Path::new(&format!("/proc/{}/exe", container.process.pid)))?
        != expected_exe
    {
        return Err(refused());
    }
    let path = format!(
        "/var/lib/kubelet/pods/{}/volumes/kubernetes.io~empty-dir/controller-run/private",
        container.pod_uid
    );
    let m = std::fs::symlink_metadata(&path).map_err(|_| refused())?;
    if std::fs::canonicalize(&path).map_err(|_| refused())? != Path::new(&path)
        || !m.is_dir()
        || m.uid() != 26
        || m.mode() & 0o7777 != 0o700
    {
        return Err(refused());
    }
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(format!("{path}/archiver-isolation.json"))
        .map_err(|_| refused())?;
    let m = f.metadata().map_err(|_| refused())?;
    if !m.is_file()
        || m.uid() != 26
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > 65536
    {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    f.take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| refused())?;
    if bytes.len() > 65536 {
        return Err(refused());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| refused())?;
    if !pgcf_native_protocol::pool::workload_probe_safe(&value) {
        return Err(refused());
    }
    container.process.recheck()?;
    Ok(value)
}
/// Positive propagation uses the measured shared source and actual namespace slaves, not Pod flags.
pub fn anchor_propagation(pod: &str, containers: &[&Container]) -> Result<(), Status> {
    let anchor = crate::pool_mount::DataAnchor::for_pod(pod).map_err(|_| refused())?;
    let survey = crate::pool_inspector::anchor(&anchor)?;
    let own = crate::pool_namespaces::namespace_id(
        &File::open("/proc/self/ns/mnt").map_err(|_| refused())?,
    )
    .map_err(|_| refused())?;
    let point = format!("/var/lib/kubelet/pods/{pod}/volumes/kubernetes.io~empty-dir/volume");
    let sources = survey
        .aliases
        .iter()
        .filter(|a| a.namespace_id == own && a.point == point && a.root == "/" && a.peer_group > 0)
        .collect::<Vec<_>>();
    if sources.len() != 1 {
        return Err(refused());
    }
    let peer = sources[0].peer_group;
    for c in containers {
        c.process.recheck()?;
        let ns = crate::pool_namespaces::namespace_id(
            &File::open(format!("/proc/{}/ns/mnt", c.process.pid)).map_err(|_| refused())?,
        )
        .map_err(|_| refused())?;
        let aliases = survey
            .aliases
            .iter()
            .filter(|a| {
                a.namespace_id == ns
                    && a.point == "/var/lib/postgresql"
                    && a.root == "/"
                    && (a.master == peer || a.peer_group == peer)
            })
            .count();
        if aliases != 1 {
            return Err(refused());
        }
    }
    Ok(())
}
pub struct Inventory {
    pub value: Value,
    pub processes: Vec<Process>,
}
pub fn measure(
    context: &Value,
    local: &Cloudflare,
    containers: &[Container],
    held_pods: &BTreeSet<String>,
) -> Result<Inventory, Status> {
    if !context_valid(context, local) {
        return Err(refused());
    }
    if crate::policy::digest(Path::new("/proc/self/exe"))?
        != text(&context["policy"], "host_controller_sha256")?
    {
        return Err(refused());
    }
    let mut pods = Vec::new();
    let mut processes = Vec::new();
    let mut memory = 0u64;
    let mut cpu = 0u64;
    let policy = &context["policy"];
    for prepared in context["pods"].as_array().ok_or_else(refused)? {
        let uid = text(prepared, "pod_uid")?;
        if held_pods.contains(uid) {
            continue;
        }
        let actual = containers
            .iter()
            .filter(|c| c.pod_uid == uid)
            .collect::<Vec<_>>();
        let expected = prepared["container_ids"]
            .as_array()
            .ok_or_else(refused)?
            .iter()
            .map(|v| v.as_str().ok_or_else(refused))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let ids = actual
            .iter()
            .map(|c| c.process.container_id.as_str())
            .collect::<BTreeSet<_>>();
        if actual.len() != 2
            || ids != expected
            || actual.iter().any(|c| c.pod_name != prepared["pod_name"])
        {
            return Err(refused());
        }
        let main = actual
            .iter()
            .find(|c| c.role == "postgres")
            .ok_or_else(refused)?;
        let archive = actual
            .iter()
            .find(|c| c.role == "archiver")
            .ok_or_else(refused)?;
        resources(main, &policy["class"], false)?;
        resources(archive, &policy["class"], true)?;
        if (!main.configured_image.ends_with(&format!(
            "@sha256:{}",
            text(&policy["class"], "postgres_image_sha256")?
        )) || !image_matches(&main.configured_image, &main.image, &main.configured_image))
            || !image_matches(
                &archive.configured_image,
                &archive.image,
                text(policy, "archiver_image")?,
            )
        {
            return Err(refused());
        }
        let address = text(prepared, "pod_ip")?.parse().map_err(|_| refused())?;
        let att = crate::pool_attestation::read(
            main,
            &local.node_uid,
            text(policy, "supervisor_sha256")?,
            address,
        )?;
        let archive_probe = archiver_probe(archive, text(policy, "supervisor_sha256")?)?;
        crate::pool_mount::DataAnchor::prepare_for_pod(uid).map_err(|_| refused())?;
        anchor_propagation(uid, &actual)?;
        let value = json!({"v":1,"node_id":local.node_id,"node_uid":local.node_uid,"boot_id":context["boot_id"],"pool_namespace":"pgcf-pool","pool_namespace_uid":context["pool_namespace_uid"],"container_ids":prepared["container_ids"],"pool_pod_uid":uid,"pool_pod_name":prepared["pod_name"],"pool_pod_ip":prepared["pod_ip"],"container_id":main.process.container_id,"supervisor_sha256":att["supervisor_sha256"],"supervisor_key_sha256":att["supervisor_key_sha256"],"supervisor_public_key_pem":att["supervisor_public_key_pem"],"supervisor_certificate_pem":att["supervisor_certificate_pem"],"class":policy["class"],"propagation_verified":true,"workload_isolation":{"uid":26,"cap_sys_admin":false,"seccomp_runtime_default":true,"namespace_creation_denied":true,"mount_api_denied":true},"workload_probes":[{"container_id":main.process.container_id,"probe":att["workload_probe"]},{"container_id":archive.process.container_id,"probe":archive_probe}],"observed_at":now()});
        if !pgcf_native_protocol::pool::validate("PoolPodAttestation", &value) {
            return Err(refused());
        }
        pods.push(value);
        for c in actual {
            let (m, u) = c.process.idle_counters()?;
            memory = memory.checked_add(m).ok_or_else(refused)?;
            cpu = cpu.checked_add(u).ok_or_else(refused)?;
            processes.push(Process::capture(
                c.process.pid,
                uid,
                &c.process.container_id,
            )?)
        }
    }
    let mut value = json!({"v":1,"node_id":local.node_id,"node_uid":local.node_uid,"boot_id":context["boot_id"],"policy_revision":context["policy_revision"],"observed_at":now(),"pods":pods,"idle_memory_current_bytes":memory,"idle_cpu_usage_usec":cpu});
    for k in ["qualification_run_id", "qualification_scope_sha256"] {
        if let Some(v) = context.get(k) {
            value[k] = v.clone()
        }
    }
    if !pgcf_native_protocol::pool::validate("PoolPodInventory", &value)
        || !context_valid(context, local)
    {
        return Err(refused());
    }
    Ok(Inventory { value, processes })
}
