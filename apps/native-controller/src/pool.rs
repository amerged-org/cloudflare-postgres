// SPDX-License-Identifier: Apache-2.0
//! Pre-created PostgreSQL Pods. Inventory is not tenant readiness or mount authority.

use crate::{Error, contracts, kubernetes};
use pgcf_native_protocol::{pool, valid_pattern};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn clock() -> Result<u64, Error> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}

fn typed(value: &Value, api: &str, kind: &str) -> bool {
    value["apiVersion"] == api && value["kind"] == kind
}
fn integer(value: &Value, name: &str) -> Result<u64, Error> {
    value[name]
        .as_u64()
        .ok_or_else(|| "pool numeric field unavailable".into())
}
fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, Error> {
    value[name]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "pool text field unavailable".into())
}
fn hash(value: &Value) -> Result<String, Error> {
    Ok(Sha256::digest(serde_json::to_vec(value)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
fn mount(name: &str, path: &str, private: bool, readonly: bool) -> Value {
    let mut value = json!({"name":name,"mountPath":path,"readOnly":readonly});
    if private {
        value["subPath"] = "private".into();
    }
    value
}
fn env(name: &str, value: &str) -> Value {
    json!({"name":name,"value":value})
}
fn downward(name: &str, path: &str) -> Value {
    json!({"name":name,"valueFrom":{"fieldRef":{"fieldPath":path}}})
}
fn security() -> Value {
    json!({"runAsNonRoot":true,"runAsUser":26,"runAsGroup":26,"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}})
}

/// An explicit startup feature flag and the API's gated policy are both necessary. Disabled
/// controllers make no pool resources; a ready idle Pod still needs the node's real attestation.
pub fn inventory_plan(
    feature_enabled: bool,
    state: &Value,
    node: &Value,
    namespace: &Value,
    postgres_image: &str,
    expected_keys_sha256: &str,
) -> Result<Vec<Value>, Error> {
    if !feature_enabled {
        return Ok(Vec::new());
    }
    let (template, slots) =
        inventory_template(state, node, namespace, postgres_image, expected_keys_sha256)?;
    let prefix = text(&template["metadata"], "name")?
        .strip_suffix("-0")
        .ok_or("pool plan name invalid")?;
    Ok((0..slots)
        .map(|slot| {
            let mut pod = template.clone();
            pod["metadata"]["name"] = format!("{prefix}-{slot}").into();
            pod
        })
        .collect())
}
fn inventory_template(
    state: &Value,
    node: &Value,
    namespace: &Value,
    postgres_image: &str,
    expected_keys_sha256: &str,
) -> Result<(Value, u64), Error> {
    if !pool::validate("PostgresPoolPolicyState", state)
        || !typed(node, "v1", "Node")
        || !typed(namespace, "v1", "Namespace")
        || namespace["metadata"]["name"] != *pool::constant("namespace")
        || !namespace["metadata"]["deletionTimestamp"].is_null()
        || !namespace["metadata"]["uid"]
            .as_str()
            .is_some_and(|uid| valid_pattern("uuid", uid))
        || expected_keys_sha256.len() != 64
        || !expected_keys_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("pool policy or node contract invalid".into());
    }
    let policy = &state["policy"];
    let class = &policy["class"];
    let slots = integer(policy, "target_slots")?;
    let idle_cpu = integer(policy, "idle_cpu_millicores")?;
    let idle_memory = integer(policy, "idle_memory_mib")?;
    let class_cpu = integer(class, "cpu_request_millicores")?;
    let class_memory = integer(class, "memory_request_bytes")?;
    let cpu_limit = integer(class, "cpu_limit_millicores")?;
    let memory_limit = integer(class, "memory_limit_bytes")?;
    if slots
        .checked_mul(idle_cpu)
        .is_none_or(|value| value > integer(policy, "max_idle_cpu_millicores").unwrap_or(0))
        || slots
            .checked_mul(idle_memory)
            .is_none_or(|value| value > integer(policy, "max_idle_memory_mib").unwrap_or(0))
        || class_cpu > cpu_limit
        || class_memory > memory_limit
        || !postgres_image.ends_with(&format!(
            "@sha256:{}",
            text(class, "postgres_image_sha256")?
        ))
        || postgres_image.len() > 512
        || postgres_image
            .bytes()
            .any(|byte| byte.is_ascii_whitespace())
        || !text(policy, "archiver_image")?
            .ends_with(&format!("@sha256:{}", text(policy, "archiver_sha256")?))
        || node["metadata"]["uid"] != state["node_uid"]
        || !node["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("pool image, identity or resource budget changed".into());
    }
    let node_name = text(&node["metadata"], "name")?;
    let boot = text(&node["status"]["nodeInfo"], "bootID")?;
    if !valid_pattern("uuid", boot)
        || !node["status"]["conditions"]
            .as_array()
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .filter(|value| value["type"] == "Ready")
                    .count()
                    == 1
                    && conditions
                        .iter()
                        .any(|value| value["type"] == "Ready" && value["status"] == "True")
            })
    {
        return Err("pool node is not currently ready".into());
    }
    let sidecar = contracts::constant("SIDECAR");
    let side_cpu = integer(sidecar, "requestCpuMillicores")?;
    let side_memory = integer(sidecar, "requestMemoryMib")?;
    if class_cpu
        .checked_add(side_cpu)
        .is_none_or(|value| value > idle_cpu)
        || idle_memory
            .checked_sub(side_memory)
            .and_then(|value| value.checked_mul(1024 * 1024))
            .is_none_or(|value| class_memory > value)
    {
        return Err("pool idle budget does not cover actual startup requests".into());
    }
    let primary_cpu = class_cpu;
    let primary_memory = class_memory;
    let class_hash = hash(class)?;
    let node_id = text(state, "node_id")?;
    let node_uid = text(state, "node_uid")?;
    let revision = integer(state, "revision")?;
    let primary_resources = json!({"requests":{"cpu":format!("{primary_cpu}m"),"memory":primary_memory.to_string()},"limits":{"cpu":format!("{cpu_limit}m"),"memory":memory_limit.to_string()}});
    let side_resources = json!({"requests":{"cpu":format!("{side_cpu}m"),"memory":format!("{side_memory}Mi")},"limits":{"cpu":format!("{}m",integer(sidecar,"limitCpuMillicores")?),"memory":format!("{}Mi",integer(sidecar,"limitMemoryMib")?)}});
    let namespace_uid = text(&namespace["metadata"], "uid")?;
    let namespace = pool::constant("namespace")
        .as_str()
        .ok_or("pool namespace constant unavailable")?;
    let shared_env = vec![
        env("PGCF_POOL_ENABLED", "1"),
        json!({"name":"PGCF_POOL_BIND_KEYS","valueFrom":{"configMapKeyRef":{"name":"pgcf-pool-bind-keys","key":"keys"}}}),
        env("PGCF_POOL_BIND_KEYS_SHA256", expected_keys_sha256),
        downward("PGCF_POOL_POD_UID", "metadata.uid"),
        downward("PGCF_POOL_POD_IP", "status.podIP"),
        env("PGCF_POOL_NODE_UID", node_uid),
        env("PGCF_POOL_BOOT_ID", boot),
        env(
            "PGCF_POOL_SUPERVISOR_SHA256",
            text(policy, "supervisor_sha256")?,
        ),
        env(
            "PGCF_POOL_POSTGRES_IMAGE_SHA256",
            text(class, "postgres_image_sha256")?,
        ),
    ];
    let mut volume_mount = mount("volume", "/var/lib/postgresql", false, false);
    volume_mount["mountPropagation"] = "HostToContainer".into();
    let mut primary_mounts = vec![
        volume_mount.clone(),
        mount("binary", "/pgcf/bin", false, true),
        mount("controller", "/controller", false, false),
        mount("controller-run", "/controller/run", true, false),
        mount("run", "/run", false, false),
        mount("shm", "/dev/shm", false, false),
        mount("tmp", "/tmp", false, false),
        mount("control", "/pgcf/control", true, false),
        mount("certificates", "/controller/certificates", true, false),
    ];
    let archiver_mounts = primary_mounts.drain(..7).collect::<Vec<_>>();
    primary_mounts.splice(0..0, archiver_mounts.iter().cloned());
    let mut archive_env = shared_env.clone();
    archive_env.extend([env("AWS_DEFAULT_REGION","auto"),json!({"name":"AWS_ACCESS_KEY_ID","valueFrom":{"secretKeyRef":{"name":"pgcf-pool-archive","key":"ACCESS_KEY_ID"}}}),json!({"name":"AWS_SECRET_ACCESS_KEY","valueFrom":{"secretKeyRef":{"name":"pgcf-pool-archive","key":"ACCESS_SECRET_KEY"}}})]);
    let volumes = [
        "binary",
        "volume",
        "controller",
        "controller-run",
        "run",
        "shm",
        "tmp",
        "control",
        "certificates",
    ]
    .into_iter()
    .map(|name| json!({"name":name,"emptyDir":{"medium":"Memory"}}))
    .collect::<Vec<_>>();
    let name = format!(
        "pgcf-pool-{}-{revision}-0",
        node_id.strip_prefix("nod_").ok_or("pool node ID invalid")?
    );
    Ok((
        json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":name,"namespace":namespace,"labels":{"app.kubernetes.io/name":"pgcf-pool","app.kubernetes.io/part-of":"pgcf"},"annotations":{"pgcf.io/pool-node-id":node_id,"pgcf.io/pool-node-uid":node_uid,"pgcf.io/pool-namespace-uid":namespace_uid,"pgcf.io/pool-policy-revision":revision.to_string(),"pgcf.io/pool-class-sha256":class_hash,"pgcf.io/pool-class":class.to_string()}},"spec":{"nodeName":node_name,"priorityClassName":"pgcf-pool","restartPolicy":"Never","automountServiceAccountToken":false,"enableServiceLinks":false,"shareProcessNamespace":false,"securityContext":{"runAsNonRoot":true,"runAsUser":26,"runAsGroup":26,"seccompProfile":{"type":"RuntimeDefault"}},"initContainers":[{"name":"install-supervisor","image":policy["supervisor_image"],"command":["/pgcf-supervisor","install","/pgcf/bin/pgcf-supervisor","/prep/control/private","/prep/certificates/private","/prep/run/private"],"securityContext":security(),"resources":primary_resources,"volumeMounts":[mount("binary","/pgcf/bin",false,false),mount("control","/prep/control",false,false),mount("certificates","/prep/certificates",false,false),mount("controller-run","/prep/run",false,false)]}],"containers":[{"name":"postgres","image":postgres_image,"command":["/pgcf/bin/pgcf-supervisor","serve"],"env":shared_env,"securityContext":security(),"resources":primary_resources,"volumeMounts":primary_mounts,"ports":[{"name":"supervisor","containerPort":pool::constant("supervisor_port")} ]},{"name":"archiver","image":policy["archiver_image"],"command":["/pgcf/bin/pgcf-supervisor","archiver"],"env":archive_env,"securityContext":security(),"resources":side_resources,"volumeMounts":archiver_mounts}],"volumes":volumes}}),
        slots,
    ))
}

/// Exact configured archive host only. Invalid endpoints leave the pool's default deny in place.
pub fn archive_network(endpoint: &str) -> Result<Value, Error> {
    let url = reqwest::Url::parse(endpoint)?;
    let host = url.host_str().ok_or("pool archive host missing")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || host.parse::<std::net::IpAddr>().is_ok()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("pool archive endpoint invalid".into());
    }
    Ok(
        json!({"apiVersion":"cilium.io/v2","kind":"CiliumNetworkPolicy","metadata":{"name":"pgcf-pool-archive","namespace":pool::constant("namespace"),"labels":{"app.kubernetes.io/part-of":"pgcf"}},"spec":{"endpointSelector":{"matchLabels":{"app.kubernetes.io/name":"pgcf-pool"}},"egress":[{"toEndpoints":[{"matchLabels":{"k8s:io.kubernetes.pod.namespace":"kube-system","k8s-app":"kube-dns"}}],"toPorts":[{"ports":[{"port":"53","protocol":"ANY"}],"rules":{"dns":[{"matchName":host}]}}]},{"toFQDNs":[{"matchName":host}],"toPorts":[{"ports":[{"port":"443","protocol":"TCP"}]}]}]}}),
    )
}

fn cpu_millicores(value: &Value) -> Option<u64> {
    let source = value.as_str()?;
    if let Some(value) = source.strip_suffix('m') {
        return value.parse().ok();
    }
    let value = source.parse::<u64>().ok()?;
    value.checked_mul(1000)
}

/// Actual API custody, independent of tenant labels and the Pod's self-reported environment.
pub async fn binding_pod(
    k8s: &kubernetes::Kubernetes,
    binding: &Value,
) -> Result<(Value, Value, Value), Error> {
    if !pool::binding_valid(binding) {
        return Err("pool binding contract invalid".into());
    }
    let scope = &binding["scope"];
    let namespace = text(scope, "pool_namespace")?;
    let (namespace, pod) = tokio::try_join!(
        k8s.read("Namespace", None, namespace),
        k8s.read("Pod", Some(namespace), text(scope, "pool_pod_name")?)
    )?;
    let namespace = namespace.ok_or("pool namespace absent")?;
    let pod = pod.ok_or("pool Pod absent")?;
    let node = k8s
        .read("Node", None, text(&pod["spec"], "nodeName")?)
        .await?
        .ok_or("pool Pod Node absent")?;
    if !binding_pod_matches(binding, &namespace, &pod, &node) {
        return Err("pool actual writer custody changed".into());
    }
    Ok((namespace, pod, node))
}
pub fn binding_pod_matches(binding: &Value, namespace: &Value, pod: &Value, node: &Value) -> bool {
    if !pool::binding_valid(binding)
        || !typed(namespace, "v1", "Namespace")
        || !typed(pod, "v1", "Pod")
        || !typed(node, "v1", "Node")
    {
        return false;
    }
    let scope = &binding["scope"];
    if namespace["metadata"]["name"] != scope["pool_namespace"]
        || namespace["metadata"]["uid"] != scope["pool_namespace_uid"]
        || pod["metadata"]["namespace"] != scope["pool_namespace"]
        || pod["metadata"]["name"] != scope["pool_pod_name"]
        || pod["metadata"]["uid"] != scope["pool_pod_uid"]
        || pod["status"]["podIP"] != scope["pool_pod_ip"]
        || node["metadata"]["uid"] != scope["node_uid"]
        || pod["spec"]["nodeName"] != node["metadata"]["name"]
        || node["status"]["nodeInfo"]["bootID"] != scope["boot_id"]
        || [namespace, pod, node].iter().any(|value| {
            !value["metadata"]["deletionTimestamp"].is_null()
                || text(&value["metadata"], "resourceVersion").is_err()
        })
        || !node["status"]["conditions"]
            .as_array()
            .is_some_and(|items| {
                items.iter().filter(|item| item["type"] == "Ready").count() == 1
                    && items
                        .iter()
                        .any(|item| item["type"] == "Ready" && item["status"] == "True")
            })
    {
        return false;
    }
    let Some(statuses) = pod["status"]["containerStatuses"].as_array() else {
        return false;
    };
    let Some(specs) = pod["spec"]["containers"].as_array() else {
        return false;
    };
    if statuses.len() != specs.len()
        || statuses
            .iter()
            .any(|status| status["state"]["running"].is_null() || status["ready"] != true)
    {
        return false;
    }
    let mut ids = statuses
        .iter()
        .filter_map(|status| {
            status["containerID"]
                .as_str()?
                .strip_prefix("containerd://")
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    ids.sort();
    let mut expected = scope["container_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    expected.sort();
    if ids.len() != statuses.len() || ids != expected {
        return false;
    }
    let main = statuses
        .iter()
        .filter(|status| status["name"] == "postgres")
        .collect::<Vec<_>>();
    let container = specs
        .iter()
        .filter(|container| container["name"] == "postgres")
        .collect::<Vec<_>>();
    if main.len() != 1 || container.len() != 1 {
        return false;
    }
    let main = main[0];
    let container = container[0];
    let class = &scope["class"];
    main["containerID"]
        == format!(
            "containerd://{}",
            scope["container_id"].as_str().unwrap_or("")
        )
        && main["imageID"].as_str().is_some_and(|image| {
            image.ends_with(&format!(
                "@sha256:{}",
                class["postgres_image_sha256"].as_str().unwrap_or("")
            ))
        })
        && container["image"].as_str().is_some_and(|image| {
            image.ends_with(&format!(
                "@sha256:{}",
                class["postgres_image_sha256"].as_str().unwrap_or("")
            ))
        })
        && cpu_millicores(&container["resources"]["requests"]["cpu"])
            == class["cpu_request_millicores"].as_u64()
        && cpu_millicores(&container["resources"]["limits"]["cpu"])
            == class["cpu_limit_millicores"].as_u64()
        && crate::reconcile::quantity(&container["resources"]["requests"]["memory"])
            == class["memory_request_bytes"]
                .as_u64()
                .map(|value| value as f64)
        && crate::reconcile::quantity(&container["resources"]["limits"]["memory"])
            == class["memory_limit_bytes"]
                .as_u64()
                .map(|value| value as f64)
}

fn primary_lease_patch(
    current: &Value,
    binding: &Value,
    acquire: bool,
    now: &str,
) -> Result<Value, Error> {
    if !pool::binding_valid(binding)
        || !typed(current, "coordination.k8s.io/v1", "Lease")
        || current["metadata"]["name"] != "database"
        || current["metadata"]["namespace"]
            != format!("pgcf-db-{}", text(&binding["scope"], "database_id")?)
        || !current["metadata"]["deletionTimestamp"].is_null()
        || text(&current["metadata"], "uid")?.is_empty()
        || text(&current["metadata"], "resourceVersion")?.is_empty()
    {
        return Err("pool primary Lease scope unavailable".into());
    }
    let holder = format!("pgcf-pool/{}", text(&binding["scope"], "binding_id")?);
    let old = current["spec"]["holderIdentity"].as_str().unwrap_or("");
    if old != holder && (!acquire || !old.is_empty()) {
        return Err("pool cannot replace the current primary Lease holder".into());
    }
    let mut spec = json!({"holderIdentity":holder,"leaseDurationSeconds":15,"renewTime":now});
    if old.is_empty() {
        spec["acquireTime"] = now.into();
        spec["leaseTransitions"] = current["spec"]["leaseTransitions"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .filter(|value| *value <= 2147483647)
            .ok_or("pool primary Lease transition exceeded")?
            .into();
    }
    Ok(json!({"spec":spec}))
}

/// Lease timestamps are metav1.MicroTime, whose API parser requires six fractional digits.
pub fn primary_lease_timestamp() -> Result<String, Error> {
    let now = time::OffsetDateTime::now_utc();
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.microsecond()
    ))
}

/// Initial acquisition needs current, unexpired Cloudflare admission. Continuing and detaching
/// holders retain the exact Lease until verified release; expiry never grants it to a second writer.
pub async fn maintain_primary_lease(
    k8s: &kubernetes::Kubernetes,
    desired: &Value,
) -> Result<Value, Error> {
    if !pool::validate("DesiredPoolBinding", desired) || !pool::binding_valid(&desired["binding"]) {
        return Err("pool desired holder invalid".into());
    }
    let binding = &desired["binding"];
    if matches!(binding["state"].as_str(), Some("released" | "refused")) {
        return Err("pool holder already released".into());
    }
    let scope = &binding["scope"];
    let namespace = format!("pgcf-db-{}", text(scope, "database_id")?);
    let (tenant, cluster) = tokio::try_join!(
        k8s.read("Namespace", None, &namespace),
        k8s.read("Cluster", Some(&namespace), "database")
    )?;
    let tenant = tenant.ok_or("pool tenant namespace missing")?;
    let cluster = cluster.ok_or("pool retained CNPG Cluster missing")?;
    if tenant["metadata"]["uid"] != scope["storage"]["namespace_uid"]
        || cluster["metadata"]["uid"] != scope["storage"]["cnpg_cluster_uid"]
        || !tenant["metadata"]["deletionTimestamp"].is_null()
        || !cluster["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("pool retained tenant identity changed".into());
    }
    let current = k8s
        .read("Lease", Some(&namespace), "database")
        .await?
        .ok_or("CNPG primary Lease missing")?;
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?;
    let acquire = original_lease_permission(desired, now);
    if acquire
        && (cluster["metadata"]["annotations"]["cnpg.io/hibernation"] != "on"
            || !cluster["status"]["conditions"]
                .as_array()
                .is_some_and(|conditions| {
                    conditions.iter().any(|condition| {
                        condition["type"] == "cnpg.io/hibernation" && condition["status"] == "True"
                    })
                })
            || !k8s
                .list("Pod", Some(&namespace), Some("cnpg.io/cluster=database"))
                .await?
                .is_empty())
    {
        return Err("pool CNPG clean sleep changed before primary Lease claim".into());
    }
    let patch = primary_lease_patch(&current, binding, acquire, &primary_lease_timestamp()?)?;
    let actual = k8s.patch(&current, &patch).await?;
    if !primary_lease_readback_matches(&actual, &patch) {
        return Err("pool primary Lease renewal unconfirmed".into());
    }
    Ok(actual)
}
fn original_lease_permission(desired: &Value, now: u64) -> bool {
    let binding = &desired["binding"];
    desired["authority"] == "current"
        && matches!(binding["state"].as_str(), Some("claimed" | "mounted"))
        && desired["permission"]
            .as_str()
            .is_some_and(|token| !token.is_empty())
        && binding["created_at"]
            .as_u64()
            .and_then(|start| {
                start.checked_add(pool::constant("permission_ms").as_u64().unwrap_or(0))
            })
            .is_some_and(|expires| expires > now)
}

/// Kubernetes stores Lease renewTime as MicroTime; readback must preserve the instant and holder.
pub fn primary_lease_readback_matches(actual: &Value, patch: &Value) -> bool {
    let parse = |value: &Value| {
        value.as_str().and_then(|text| {
            time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()
        })
    };
    actual["spec"]["holderIdentity"] == patch["spec"]["holderIdentity"]
        && parse(&actual["spec"]["renewTime"])
            .zip(parse(&patch["spec"]["renewTime"]))
            .is_some_and(|(actual, expected)| actual == expected)
}

/// Only the API's validated released/refused outcome authorizes hand-back to CNPG. Lost, failed,
/// expired permission and a missing Pod are not release proofs.
pub async fn release_primary_lease(
    k8s: &kubernetes::Kubernetes,
    binding: &Value,
) -> Result<Value, Error> {
    if !pool::binding_valid(binding)
        || !matches!(binding["state"].as_str(), Some("released" | "refused"))
    {
        return Err("pool cleanup outcome unproved".into());
    }
    let namespace = format!("pgcf-db-{}", text(&binding["scope"], "database_id")?);
    let current = k8s
        .read("Lease", Some(&namespace), "database")
        .await?
        .ok_or("CNPG primary Lease missing")?;
    if current["spec"]["holderIdentity"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        return Ok(current);
    }
    if current["spec"]["holderIdentity"]
        != format!("pgcf-pool/{}", text(&binding["scope"], "binding_id")?)
    {
        return Err("primary Lease belongs to another holder".into());
    }
    let patch = json!({"spec":{"holderIdentity":"","acquireTime":null,"renewTime":null,"leaseDurationSeconds":null}});
    match k8s.patch(&current, &patch).await {
        Ok(after) if after["spec"]["holderIdentity"] == "" => Ok(after),
        Ok(_) => Err("pool primary Lease handback unconfirmed".into()),
        Err(error) => {
            let after = k8s
                .read("Lease", Some(&namespace), "database")
                .await?
                .ok_or("pool primary Lease handback unknown")?;
            if after["metadata"]["uid"] == current["metadata"]["uid"]
                && after["spec"]["holderIdentity"] == ""
            {
                Ok(after)
            } else {
                Err(error)
            }
        }
    }
}

/// Regional archive credentials reach only the archiver's Secret mount/env. Bind verification
/// keys are public and independently checked against the qualified Fleet's existing trust pin.
pub fn custody_manifests(
    regional_secret: &Value,
    keys: &str,
    keys_sha256: &str,
    endpoint: &str,
) -> Result<Vec<Value>, Error> {
    pgcf_native_protocol::storage::StorageTrust::parse(keys, keys_sha256)?;
    if !typed(regional_secret, "v1", "Secret")
        || regional_secret["metadata"]["namespace"] != "pgcf-system"
        || regional_secret["metadata"]["name"] != "pgcf-backup-s3"
        || !regional_secret["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("regional pool archive custody invalid".into());
    }
    let access = text(&regional_secret["data"], "AWS_ACCESS_KEY_ID")?;
    let secret = text(&regional_secret["data"], "AWS_SECRET_ACCESS_KEY")?;
    let namespace = pool::constant("namespace")
        .as_str()
        .ok_or("pool namespace unavailable")?;
    Ok(vec![
        json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"pgcf-pool-bind-keys","namespace":namespace,"labels":{"app.kubernetes.io/part-of":"pgcf"}},"data":{"keys":keys}}),
        json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":"pgcf-pool-archive","namespace":namespace,"labels":{"app.kubernetes.io/part-of":"pgcf"}},"type":"Opaque","data":{"ACCESS_KEY_ID":access,"ACCESS_SECRET_KEY":secret}}),
        archive_network(endpoint)?,
    ])
}

fn snapshot_valid(snapshot: &Value, state: &Value, node: &Value, now: u64) -> bool {
    if !pool::validate("PoolBindingSnapshot", snapshot)
        || snapshot["node_id"] != state["node_id"]
        || snapshot["node_uid"] != state["node_uid"]
        || node["metadata"]["uid"] != state["node_uid"]
        || snapshot["boot_id"] != node["status"]["nodeInfo"]["bootID"]
        || snapshot["issued_at"].as_u64().is_none_or(|issued| {
            issued > now.saturating_add(5000) || issued < now.saturating_sub(30000)
        })
        || snapshot["expires_at"]
            .as_u64()
            .is_none_or(|expires| expires <= now || expires > now.saturating_add(35000))
    {
        return false;
    }
    let mut pods = std::collections::HashSet::new();
    snapshot["bindings"].as_array().is_some_and(|bindings| {
        bindings.iter().all(|desired| {
            let binding = &desired["binding"];
            let scope = &binding["scope"];
            pool::binding_valid(binding)
                && scope["node_uid"] == snapshot["node_uid"]
                && scope["node_id"] == snapshot["node_id"]
                && scope["boot_id"] == snapshot["boot_id"]
                && text(scope, "pool_pod_uid").is_ok_and(|uid| pods.insert(uid.to_string()))
        })
    })
}
/// Reuse the centralized authenticated bounded client. The response is complete node ownership,
/// including failed/lost holders, and never inferred from desired page membership or Pod labels.
pub async fn binding_snapshot(
    api: &crate::api::ControlApi,
    state: &Value,
    node: &Value,
) -> Result<Value, Error> {
    let node_id = text(state, "node_id")?;
    if !pool::validate("PostgresPoolPolicyState", state) {
        return Err("pool policy scope invalid".into());
    }
    let value = api
        .request(
            &format!("/agent/v1/nodes/{node_id}/postgres-pool/bindings?after=0&wait_ms=0"),
            None,
        )
        .await?;
    let now = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?;
    if !snapshot_valid(&value, state, node, now) {
        return Err("complete current pool holder snapshot unavailable".into());
    }
    Ok(value)
}

fn subset(expected: &Value, actual: &Value) -> bool {
    match expected {
        Value::Object(object) => object.iter().all(|(key, value)| {
            actual.get(key).is_some_and(|item| subset(value, item))
                || (key == "readOnly" && *value == false && actual.get(key).is_none())
        }),
        Value::Array(items) => actual.as_array().is_some_and(|values| {
            items.len() == values.len() && items.iter().zip(values).all(|(a, b)| subset(a, b))
        }),
        _ => expected == actual,
    }
}
/// Preparation is not permission. Every declared writer is read from the authenticated Kube
/// API and checked against the same immutable plan used to create the Pod before CF sees it.
fn preparation_context(
    state: &Value,
    node: &Value,
    namespace: &Value,
    pods: &[Value],
    images: (&str, &str),
    clock: u64,
    qualification: Option<&Value>,
) -> Result<Value, Error> {
    let (postgres_image, keys_sha256) = images;
    let (plan, _) = inventory_template(state, node, namespace, postgres_image, keys_sha256)?;
    if pods.len()
        > pool::constant("max_inventory")
            .as_u64()
            .ok_or("pool inventory bound unavailable")? as usize
    {
        return Err("pool preparation exceeds its scoped inventory bound".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut writers = Vec::new();
    for pod in pods {
        if !typed(pod, "v1", "Pod")
            || pod["metadata"]["namespace"] != namespace["metadata"]["name"]
            || !pod["metadata"]["deletionTimestamp"].is_null()
            || !subset(&plan["spec"], &pod["spec"])
            || !pod["metadata"]["uid"]
                .as_str()
                .is_some_and(|uid| valid_pattern("uuid", uid) && seen.insert(uid.to_owned()))
            || text(&pod["metadata"], "resourceVersion").is_err()
        {
            return Err("pool prepared Pod custody or resources changed".into());
        }
        if pod["status"]["phase"] == "Pending" {
            continue;
        }
        if pod["status"]["phase"] != "Running" {
            return Err("pool prepared Pod is not running".into());
        }
        let address: std::net::IpAddr = text(&pod["status"], "podIP")?.parse()?;
        if !match address {
            std::net::IpAddr::V4(v) => v.is_private(),
            std::net::IpAddr::V6(v) => v.is_unique_local(),
        } {
            return Err("pool preparation address is not private".into());
        }
        let statuses = pod["status"]["containerStatuses"]
            .as_array()
            .ok_or("pool writer statuses unavailable")?;
        if statuses.len() != 2 {
            return Err("pool writer inventory incomplete".into());
        }
        let mut ids = Vec::new();
        for container in plan["spec"]["containers"]
            .as_array()
            .ok_or("pool plan containers unavailable")?
        {
            let matching = statuses
                .iter()
                .filter(|status| status["name"] == container["name"])
                .collect::<Vec<_>>();
            if matching.len() != 1 {
                return Err("pool writer identity ambiguous".into());
            }
            let status = matching[0];
            if status["state"]["running"].is_null()
                || status["ready"] != true
                || status["imageID"] != container["image"]
            {
                return Err("pool writer is not running the qualified image".into());
            }
            let cid = text(status, "containerID")?
                .strip_prefix("containerd://")
                .filter(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or("pool writer CID invalid")?;
            if ids.contains(&cid) {
                return Err("pool writer CID duplicated".into());
            }
            ids.push(cid);
        }
        ids.sort_unstable();
        writers.push(json!({"pod_uid":pod["metadata"]["uid"],"pod_name":pod["metadata"]["name"],"pod_ip":pod["status"]["podIP"],"container_ids":ids}));
    }
    let mut value = json!({"v":1,"node_id":state["node_id"],"node_uid":node["metadata"]["uid"],"boot_id":node["status"]["nodeInfo"]["bootID"],"pool_namespace":namespace["metadata"]["name"],"pool_namespace_uid":namespace["metadata"]["uid"],"policy_revision":state["revision"],"policy":state["policy"],"observed_at":clock,"expires_at":clock.checked_add(pool::constant("observation_max_age_ms").as_u64().ok_or("pool preparation age unavailable")?).ok_or("pool preparation clock exceeded")?,"pods":writers});
    if let Some(q) = qualification {
        value["qualification_run_id"] = q["scope"]["run_id"].clone();
        value["qualification_scope_sha256"] = q["scope_sha256"].clone();
    }
    if !pool::validate("PoolPodPreparationContext", &value) {
        return Err("pool preparation contract invalid".into());
    }
    Ok(value)
}

/// Refilling creates only tenant-free Pods. No inventory readiness is published here: the node
/// must attest propagation, executable/process identity and actual cgroup counters first.
pub async fn reconcile_inventory(
    enabled: bool,
    k8s: &kubernetes::Kubernetes,
    api: &crate::api::ControlApi,
    state: &Value,
    node: &Value,
    postgres_image: &str,
    expected_keys_sha256: &str,
) -> Result<Vec<Value>, Error> {
    if !enabled {
        return Ok(Vec::new());
    }
    let node = k8s
        .read("Node", None, text(&node["metadata"], "name")?)
        .await?
        .ok_or("pool Node unavailable")?;
    let namespace = k8s
        .read(
            "Namespace",
            None,
            pool::constant("namespace")
                .as_str()
                .ok_or("pool namespace unavailable")?,
        )
        .await?
        .ok_or("pool namespace missing")?;
    let plans = inventory_plan(
        true,
        state,
        &node,
        &namespace,
        postgres_image,
        expected_keys_sha256,
    )?;
    let snapshot = binding_snapshot(api, state, &node).await?;
    let holders = snapshot["bindings"]
        .as_array()
        .ok_or("pool holder snapshot invalid")?
        .iter()
        .map(|desired| text(&desired["binding"]["scope"], "pool_pod_uid"))
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    let namespace = pool::constant("namespace")
        .as_str()
        .ok_or("pool namespace unavailable")?;
    let existing = k8s
        .list(
            "Pod",
            Some(namespace),
            Some("app.kubernetes.io/name=pgcf-pool"),
        )
        .await?;
    let local = existing
        .iter()
        .filter(|pod| pod["spec"]["nodeName"] == node["metadata"]["name"])
        .collect::<Vec<_>>();
    if local.len()
        > pool::constant("max_inventory")
            .as_u64()
            .ok_or("pool inventory bound unavailable")? as usize
    {
        return Err("pool Pod inventory exceeds its bound".into());
    }
    let mut free = 0;
    let revision = integer(state, "revision")?.to_string();
    if let Some(plan) = plans.first() {
        for pod in &local {
            let uid = text(&pod["metadata"], "uid")?;
            if holders.contains(uid) {
                continue;
            }
            if !pod["metadata"]["deletionTimestamp"].is_null()
                || !subset(&plan["spec"], &pod["spec"])
                || pod["metadata"]["annotations"]["pgcf.io/pool-node-uid"] != state["node_uid"]
                || pod["metadata"]["annotations"]["pgcf.io/pool-policy-revision"].as_str()
                    != Some(revision.as_str())
                || matches!(
                    pod["status"]["phase"].as_str(),
                    Some("Failed" | "Succeeded")
                )
            {
                return Err("obsolete or unconfirmed pool Pod requires scoped cleanup".into());
            }
            free += 1;
        }
    }
    let missing = plans.len().saturating_sub(free);
    let occupied = existing
        .iter()
        .map(|pod| text(&pod["metadata"], "name"))
        .collect::<Result<std::collections::HashSet<_>, _>>()?;
    let prefix = format!(
        "pgcf-pool-{}-{}-",
        text(state, "node_id")?
            .strip_prefix("nod_")
            .ok_or("pool node ID invalid")?,
        integer(state, "revision")?
    );
    let available = (0..pool::constant("max_inventory")
        .as_u64()
        .ok_or("pool inventory bound unavailable")?)
        .map(|slot| format!("{prefix}{slot}"))
        .filter(|name| !occupied.contains(name.as_str()))
        .take(missing)
        .collect::<Vec<_>>();
    if available.len() != missing {
        return Err("pool Pod names exhausted".into());
    }
    let mut created = Vec::new();
    for name in available {
        let mut plan = plans[0].clone();
        plan["metadata"]["name"] = name.into();
        // A lost create is never replayed here. The next full API list must discover its name/UID.
        created.push(k8s.create(&plan).await?);
    }
    Ok(created)
}

pub async fn delete_released_pod(
    k8s: &kubernetes::Kubernetes,
    binding: &Value,
) -> Result<(), Error> {
    if !pool::binding_valid(binding)
        || !matches!(binding["state"].as_str(), Some("released" | "refused"))
    {
        return Err("pool holder cleanup unproved".into());
    }
    let scope = &binding["scope"];
    let namespace = pool::constant("namespace")
        .as_str()
        .ok_or("pool namespace unavailable")?;
    let Some(pod) = k8s
        .read("Pod", Some(namespace), text(scope, "pool_pod_name")?)
        .await?
    else {
        return Ok(());
    };
    if pod["metadata"]["uid"] != scope["pool_pod_uid"] {
        return Ok(());
    }
    if !pod["metadata"]["deletionTimestamp"].is_null() {
        return Ok(());
    }
    if let Err(error) = k8s.delete(&pod, "Background").await {
        let after = k8s
            .read("Pod", Some(namespace), text(scope, "pool_pod_name")?)
            .await?;
        if after.as_ref().is_some_and(|after| {
            after["metadata"]["uid"] == scope["pool_pod_uid"]
                && after["metadata"]["deletionTimestamp"].is_null()
        }) {
            return Err(error);
        }
    }
    Ok(())
}

/// A verified public node attestation selects exactly one supervisor. The HTTPS client retains
/// normal certificate/IP verification, adds only that attested leaf as trust, and never follows
/// a redirect that could disclose a tenant certificate/key bundle.
fn supervisor_tls(
    cert_pem: &str,
    public_pem: &str,
    expected_sha256: &str,
    address: std::net::IpAddr,
) -> Result<(reqwest::Client, reqwest::Url), Error> {
    use rustls_pki_types::{CertificateDer, pem::PemObject};
    let certs =
        CertificateDer::pem_slice_iter(cert_pem.as_bytes()).collect::<Result<Vec<_>, _>>()?;
    if certs.len() != 1 {
        return Err("pool supervisor certificate ambiguous".into());
    }
    let (_, cert) = x509_parser::parse_x509_certificate(certs[0].as_ref())
        .map_err(|_| "pool supervisor certificate invalid")?;
    let (_, public) = x509_parser::pem::parse_x509_pem(public_pem.as_bytes())
        .map_err(|_| "pool supervisor public key invalid")?;
    let spki = cert.public_key().raw;
    let digest = Sha256::digest(spki)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if public.label != "PUBLIC KEY" || public.contents != spki || digest != expected_sha256 {
        return Err("pool supervisor certificate key changed".into());
    }
    let exact = cert
        .subject_alternative_name()
        .map_err(|_| "pool supervisor SAN invalid")?
        .is_some_and(|san| {
            san.value.general_names.iter().any(|name| {
                if let x509_parser::extensions::GeneralName::IPAddress(bytes) = name {
                    match address {
                        std::net::IpAddr::V4(ip) => *bytes == ip.octets(),
                        std::net::IpAddr::V6(ip) => *bytes == ip.octets(),
                    }
                } else {
                    false
                }
            })
        });
    if !exact {
        return Err("pool supervisor IP identity changed".into());
    }
    let host = match address {
        std::net::IpAddr::V4(ip) => ip.to_string(),
        std::net::IpAddr::V6(ip) => format!("[{ip}]"),
    };
    let origin = reqwest::Url::parse(&format!(
        "https://{host}:{}/",
        pool::constant("supervisor_port")
            .as_u64()
            .ok_or("pool supervisor port unavailable")?
    ))?;
    let client = reqwest::Client::builder()
        .tls_certs_only([reqwest::Certificate::from_pem(cert_pem.as_bytes())?])
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    Ok((client, origin))
}

pub struct SupervisorConnection {
    client: reqwest::Client,
    origin: reqwest::Url,
    scope: Value,
    scope_sha256: String,
    holder_revision: u64,
}
fn supervisor_reply_valid(
    path: &str,
    body: &Value,
    scope: &Value,
    scope_sha256: &str,
    reply: &Value,
) -> bool {
    let schema = match path {
        "/backup" => "PoolBackupReport",
        "/bundle" => "PoolBundleReply",
        _ => "PoolSupervisorReport",
    };
    if !pool::validate(schema, reply) {
        return false;
    }
    if path == "/bundle" && reply["waiting"] == true {
        return true;
    }
    reply["binding_id"] == scope["binding_id"]
        && reply["scope_sha256"] == scope_sha256
        && reply["bundle_nonce"] == scope["bundle_nonce"]
        && (path != "/backup" || reply["backup_name"] == body["backup_name"])
}
impl SupervisorConnection {
    pub fn new(attestation: &Value, binding: &Value) -> Result<Self, Error> {
        if !pool::validate("PoolPodAttestation", attestation) || !pool::binding_valid(binding) {
            return Err("pool supervisor attestation invalid".into());
        }
        let scope = &binding["scope"];
        for field in [
            "node_id",
            "node_uid",
            "boot_id",
            "pool_namespace",
            "pool_namespace_uid",
            "container_ids",
            "pool_pod_uid",
            "pool_pod_name",
            "pool_pod_ip",
            "container_id",
            "supervisor_sha256",
            "supervisor_key_sha256",
            "class",
        ] {
            if attestation[field] != scope[field] {
                return Err("pool supervisor attestation scope changed".into());
            }
        }
        let now = u64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis(),
        )?;
        let observed = integer(attestation, "observed_at")?;
        if observed > now.saturating_add(5000) || observed < now.saturating_sub(60000) {
            return Err("pool supervisor attestation stale".into());
        }
        let address: std::net::IpAddr = text(scope, "pool_pod_ip")?.parse()?;
        let (client, origin) = supervisor_tls(
            text(attestation, "supervisor_certificate_pem")?,
            text(attestation, "supervisor_public_key_pem")?,
            text(scope, "supervisor_key_sha256")?,
            address,
        )?;
        Ok(Self {
            client,
            origin,
            scope: scope.clone(),
            scope_sha256: text(binding, "scope_sha256")?.into(),
            holder_revision: integer(binding, "holder_revision")?,
        })
    }
    pub async fn request(&self, path: &str, body: &Value) -> Result<Value, Error> {
        let request_schema = match path {
            "/bundle" => "PoolTenantBundle",
            "/status" | "/stop" => "PoolControlRequest",
            "/backup" => "PoolBackupRequest",
            _ => return Err("pool supervisor operation invalid".into()),
        };
        if !pool::validate(request_schema, body) {
            return Err("pool supervisor request contract invalid".into());
        }
        if path == "/bundle" {
            if body["scope"] != self.scope
                || body["scope_sha256"] != self.scope_sha256
                || body["holder_revision"].as_u64() != Some(self.holder_revision)
            {
                return Err("pool bundle holder changed".into());
            }
        } else if body["binding_id"] != self.scope["binding_id"]
            || body["scope_sha256"] != self.scope_sha256
            || body["bundle_nonce"] != self.scope["bundle_nonce"]
        {
            return Err("pool supervisor control scope changed".into());
        }
        let encoded = serde_json::to_vec(body)?;
        if encoded.len() > 256 * 1024 {
            return Err("pool supervisor request exceeds bound".into());
        }
        let response = self
            .client
            .post(self.origin.join(path)?)
            .header("Content-Type", "application/json")
            .body(encoded)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("pool supervisor request refused".into());
        }
        let reply: Value =
            serde_json::from_slice(&kubernetes::bounded(response, 256 * 1024).await?)?;
        if !supervisor_reply_valid(path, body, &self.scope, &self.scope_sha256, &reply) {
            return Err("pool supervisor response scope invalid".into());
        }
        Ok(reply)
    }
}

/// The controller uses the same qualified public storage-key pin as both pool writers.
/// Absence/zero is a source feature-off state and reads no key material or pool API.
#[derive(Clone)]
pub struct Runtime {
    pub(crate) api: crate::api::ControlApi,
    pub(crate) public_keys: String,
    pub(crate) keys_sha256: String,
    pub(crate) storage_trust: pgcf_native_protocol::storage::StorageTrust,
}
impl Runtime {
    pub fn from_env(api: crate::api::ControlApi) -> Result<Option<Self>, Error> {
        match std::env::var("PGCF_POSTGRES_POOL_ENABLED").as_deref() {
            Err(std::env::VarError::NotPresent) | Ok("0") => return Ok(None),
            Ok("1") => {}
            _ => return Err("pool feature flag invalid".into()),
        }
        let public_keys = std::env::var("PGCF_STORAGE_AUTHORITY_KEYS")?;
        let keys_sha256 = std::env::var("PGCF_STORAGE_AUTHORITY_KEYS_SHA256")?;
        let storage_trust =
            pgcf_native_protocol::storage::StorageTrust::parse(&public_keys, &keys_sha256)?;
        Ok(Some(Self {
            api,
            public_keys,
            keys_sha256,
            storage_trust,
        }))
    }
    pub async fn details(&self, expected: &Value) -> Result<Value, Error> {
        if !pool::binding_valid(expected) {
            return Err("pool expected binding invalid".into());
        }
        let id = text(&expected["scope"], "binding_id")?;
        let details = self
            .api
            .request(&format!("/agent/v1/pool-bindings/{id}"), None)
            .await?;
        let actual = &details["binding"]["binding"];
        if !pool::validate("PoolBindingDetails", &details)
            || !pool::binding_valid(actual)
            || actual["scope"] != expected["scope"]
            || actual["scope_sha256"] != expected["scope_sha256"]
            || actual["holder_revision"].as_u64() < expected["holder_revision"].as_u64()
            || actual["updated_at"].as_u64() < expected["updated_at"].as_u64()
        {
            return Err("pool authoritative binding read changed".into());
        }
        Ok(details)
    }
    pub async fn handoff_current(
        &self,
        db: &Value,
        old: &Value,
        node: &Value,
        postgres_image: &str,
    ) -> Result<bool, Error> {
        let id = text(db, "id")?.to_owned();
        let fresh = self.api.desired(Some(std::slice::from_ref(&id))).await?;
        let matches = fresh
            .databases
            .iter()
            .filter(|current| current["id"] == db["id"])
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err("pool handoff current desired unavailable".into());
        }
        if contracts::configuration_fingerprint(db, postgres_image)?
            != contracts::configuration_fingerprint(matches[0], postgres_image)?
        {
            return Ok(false);
        }
        let node_id = text(&old["scope"], "node_id")?;
        let bindings = self
            .api
            .request(
                &format!("/agent/v1/nodes/{node_id}/postgres-pool/bindings?after=0&wait_ms=0"),
                None,
            )
            .await?;
        Ok(handoff_selection_current(
            db,
            matches[0],
            old,
            &bindings,
            node,
            clock()?,
        ))
    }
    pub fn verify_write(&self, desired: &Value, clock: u64) -> Result<(), Error> {
        let scope = &desired["binding"]["scope"];
        if scope["storage"]["backend"] == "lvm-thin-v1" {
            let token = desired["storage_authority"]
                .as_str()
                .ok_or("pool thin write token missing")?;
            pool::verify_pool_storage_authority(&self.storage_trust, token, scope, clock)
                .ok_or("pool thin write token expired or changed")?;
        }
        Ok(())
    }
    pub async fn report(&self, path: &str, schema: &str, value: &Value) -> Result<(), Error> {
        if !pool::validate(schema, value) {
            return Err("pool outgoing report contract invalid".into());
        }
        let accepted = self.api.request(path, Some(value)).await?;
        if accepted != json!({"accepted":true}) {
            return Err("pool report acceptance unconfirmed".into());
        }
        Ok(())
    }
    pub async fn qualification(&self, node_id: &str) -> Result<Option<Value>, Error> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        if !node_id.strip_prefix("nod_").is_some_and(|id| {
            id.len() == 20
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        }) {
            return Err("pool qualification node invalid".into());
        }
        let envelope = self
            .api
            .request(
                &format!("/agent/v1/nodes/{node_id}/postgres-pool/qualification"),
                None,
            )
            .await?;
        let q = &envelope["qualification"];
        if q.is_null() {
            return Ok(None);
        }
        let encoded: std::collections::HashMap<String, String> =
            serde_json::from_str(&self.public_keys)?;
        let keys = encoded
            .into_iter()
            .map(|(kid, key)| Ok((kid, URL_SAFE_NO_PAD.decode(key)?)))
            .collect::<Result<std::collections::HashMap<_, _>, Error>>()?;
        let clock = clock()?;
        let claims = pgcf_native_protocol::qualification::verify_qualification_permission(
            text(q, "permission")?,
            &keys,
            clock,
        )
        .ok_or("pool qualification permission refused")?;
        if claims["scope"] != q["scope"]
            || claims["scope_sha256"] != q["scope_sha256"]
            || claims["challenge"] != q["challenge"]
            || pgcf_native_protocol::qualification::progress_hash(&q["pending_progress"]).as_deref()
                != claims["progress_sha256"].as_str()
            || q["scope"]["node_id"] != node_id
            || q["scope"]["region_id"] != self.api.region
            || q["expires_at"]
                .as_u64()
                .is_none_or(|expiry| expiry <= clock)
            || !matches!(q["status"].as_str(), Some("running" | "cleanup"))
        {
            return Err("pool qualification envelope changed".into());
        }
        let mut verified = q.clone();
        verified["execution"] = claims["execution"].clone();
        Ok(Some(verified))
    }
    async fn prepare(
        &self,
        k8s: &kubernetes::Kubernetes,
        state: &Value,
        node: &Value,
        postgres_image: &str,
        qualification: Option<&Value>,
    ) -> Result<(), Error> {
        if let Some(q) = qualification
            && (q["scope"]["node_uid"] != node["metadata"]["uid"]
                || q["scope"]["boot_id"] != node["status"]["nodeInfo"]["bootID"]
                || q["execution"]["boot_id"] != q["scope"]["boot_id"])
        {
            return Err("pool candidate Node boot changed before preparation".into());
        }
        reconcile_inventory(
            true,
            k8s,
            &self.api,
            state,
            node,
            postgres_image,
            &self.keys_sha256,
        )
        .await?;
        let namespace = k8s
            .read("Namespace", None, "pgcf-pool")
            .await?
            .ok_or("pool namespace missing")?;
        let node = k8s
            .read("Node", None, text(&node["metadata"], "name")?)
            .await?
            .ok_or("pool Node missing")?;
        let pods = k8s
            .list("Pod", Some("pgcf-pool"), None)
            .await?
            .into_iter()
            .filter(|pod| {
                pod["spec"]["nodeName"] == node["metadata"]["name"]
                    && pod["metadata"]["labels"]["app.kubernetes.io/name"] == "pgcf-pool"
            })
            .collect::<Vec<_>>();
        let context = preparation_context(
            state,
            &node,
            &namespace,
            &pods,
            (postgres_image, &self.keys_sha256),
            clock()?,
            qualification,
        )?;
        self.report(
            &format!(
                "/agent/v1/nodes/{}/postgres-pool/preparations",
                text(state, "node_id")?
            ),
            "PoolPodPreparationContext",
            &context,
        )
        .await
    }
    async fn join_sleep(&self, k8s: &kubernetes::Kubernetes, q: &Value) -> Result<(), Error> {
        if !q["accepted_sleep"].is_null() {
            let sleep = &q["accepted_sleep"];
            let scope = &q["scope"];
            if !pool::validate("PoolSleepRecord", sleep)
                || sleep["database_id"] != scope["database_id"]
                || sleep["generation"]
                    .as_u64()
                    .and_then(|generation| generation.checked_add(1))
                    != scope["database_generation"].as_u64()
                || sleep["node_uid"] != scope["node_uid"]
                || sleep["boot_id"] != scope["boot_id"]
                || sleep["configuration_fingerprint"] != scope["configuration_fingerprint"]
                || sleep["storage"]["backend"] != "lvm-thin-v1"
                || sleep["storage"]["thin_id"] != scope["thin_id"]
                || sleep["storage"]["profile"] != scope["storage"]
            {
                return Err("pool accepted immutable sleep changed".into());
            }
            return Ok(());
        }
        let entries = q["accepted_evidence"]
            .as_array()
            .ok_or("pool qualification accepted prefix unavailable")?;
        let Some(entry) = entries
            .iter()
            .find(|entry| entry["measurement"]["gate"] == "host_mount_context")
        else {
            return Ok(());
        };
        if !pgcf_native_protocol::qualification::validate(
            "PostgresPoolQualificationEvidence",
            entry,
        ) {
            return Err("pool qualification host prefix invalid".into());
        }
        let scope = &q["scope"];
        let physical = &entry["measurement"]["storage_observation"]["storage"];
        let nodes = k8s.list("Node", None, None).await?;
        let current_node = nodes
            .iter()
            .find(|node| node["metadata"]["uid"] == scope["node_uid"])
            .ok_or("pool qualification Node missing")?;
        let bindings = binding_snapshot(&self.api, &q["policy"], current_node).await?;
        if bindings["bindings"].as_array().is_some_and(|items| {
            items.iter().any(|desired| {
                desired["binding"]["scope"]["database_id"] == scope["database_id"]
                    && desired["binding"]["scope"]["generation"] == scope["database_generation"]
            })
        }) {
            return Ok(());
        }

        let namespace = format!("pgcf-db-{}", text(scope, "database_id")?);
        let storage_name = format!("storage-{}", text(scope, "database_id")?);
        let (tenant, cluster, pods, lease, storage) = tokio::try_join!(
            k8s.read("Namespace", None, &namespace),
            k8s.read("Cluster", Some(&namespace), "database"),
            k8s.list("Pod", Some(&namespace), Some("cnpg.io/cluster=database")),
            k8s.read("Lease", Some(&namespace), "database"),
            k8s.read("ConfigMap", Some("pgcf-system"), &storage_name)
        )?;
        let tenant = tenant.ok_or("pool sleep tenant missing")?;
        let cluster = cluster.ok_or("pool sleep Cluster missing")?;
        let lease = lease.ok_or("pool sleep Lease missing")?;
        let storage = storage.ok_or("pool sleep sealed storage missing")?;
        let claim = k8s
            .list("PersistentVolumeClaim", Some(&namespace), None)
            .await?
            .into_iter()
            .find(|value| value["metadata"]["uid"] == physical["pvc_uid"])
            .ok_or("pool sleep PVC missing")?;
        let pv = k8s
            .read(
                "PersistentVolume",
                None,
                text(&claim["spec"], "volumeName")?,
            )
            .await?
            .ok_or("pool sleep PV missing")?;
        let lvm = k8s
            .read(
                "LVMVolume",
                Some("openebs"),
                text(physical, "volume_handle")?,
            )
            .await?
            .ok_or("pool sleep LVMVolume missing")?;
        let node = k8s
            .read("Node", None, text(&lvm["spec"], "ownerNodeID")?)
            .await?
            .ok_or("pool sleep Node missing")?;
        let record = qualification_sleep_record(
            q,
            &entry["measurement"],
            &SleepReadback {
                node: &node,
                tenant: &tenant,
                cluster: &cluster,
                pods: &pods,
                lease: &lease,
                storage: &storage,
                claim: &claim,
                pv: &pv,
                lvm: &lvm,
            },
            clock()?,
        )?;
        for resource in [
            &node, &tenant, &cluster, &lease, &storage, &claim, &pv, &lvm,
        ] {
            let fresh = k8s
                .read(
                    text(resource, "kind")?,
                    resource["metadata"]["namespace"].as_str(),
                    text(&resource["metadata"], "name")?,
                )
                .await?
                .ok_or("pool sleep custody disappeared")?;
            if !same_resource(resource, &fresh) {
                return Err("pool sleep custody changed during join".into());
            }
        }
        if !k8s
            .list("Pod", Some(&namespace), Some("cnpg.io/cluster=database"))
            .await?
            .is_empty()
        {
            return Err("pool sleep writer appeared during join".into());
        }
        self.report(
            &format!(
                "/agent/v1/databases/{}/postgres-pool/sleep",
                text(scope, "database_id")?
            ),
            "PoolSleepRecord",
            &record,
        )
        .await
    }
    pub async fn inventory(
        &self,
        k8s: &kubernetes::Kubernetes,
        snapshot: &crate::api::DesiredSnapshot,
        postgres_image: &str,
    ) -> Result<(), Error> {
        let mut policies = Vec::<(Value, Option<Value>, String)>::new();
        let mut identities = std::collections::HashSet::new();
        if let Some(normal) = snapshot.region["postgres_pools"].as_array() {
            for state in normal {
                if !pool::validate("PostgresPoolPolicyState", state)
                    || state["region_id"] != snapshot.region["id"]
                    || !identities.insert(text(state, "node_uid")?.to_owned())
                {
                    return Err("pool desired policy membership invalid".into());
                }
                policies.push((state.clone(), None, postgres_image.to_owned()));
            }
        }
        // Qualification policy is the signed candidate override returned by CF, never a
        // native policy invented from labels or an incapable legacy desired Fleet.
        if let Some(targets) = snapshot.region["storage_samples"].as_array() {
            for target in targets {
                if identities.contains(text(target, "node_uid")?) {
                    continue;
                }
                let Some(q) = self.qualification(text(target, "node_id")?).await? else {
                    continue;
                };
                if q["status"] == "cleanup" {
                    crate::pool_qualification::observe_cleanup(self, k8s, &q).await?;
                    continue;
                }
                if q["status"] != "running" || q["policy"].is_null() {
                    continue;
                }
                let state = &q["policy"];
                let software = &q["scope"]["software"];
                if !pool::validate("PostgresPoolPolicyState", state)
                    || state["region_id"] != snapshot.region["id"]
                    || state["node_uid"] != target["node_uid"]
                    || [
                        "driver_image",
                        "driver_sha256",
                        "host_controller_sha256",
                        "supervisor_image",
                        "supervisor_sha256",
                        "archiver_image",
                    ]
                    .iter()
                    .any(|key| state["policy"][*key] != software[*key])
                    || !identities.insert(text(state, "node_uid")?.to_owned())
                {
                    return Err("pool candidate policy scope changed".into());
                }
                policies.push((
                    state.clone(),
                    Some(q.clone()),
                    text(software, "postgres_image")?.to_owned(),
                ));
            }
        }
        if policies.is_empty() {
            return Ok(());
        }
        let nodes = k8s.list("Node", None, None).await?;
        // Validate every policy/node before changing shared pool custody resources.
        let namespace = k8s
            .read("Namespace", None, "pgcf-pool")
            .await?
            .ok_or("pool namespace missing")?;
        for (state, _, image) in &policies {
            let node = nodes
                .iter()
                .find(|node| node["metadata"]["uid"] == state["node_uid"])
                .ok_or("pool policy Node absent")?;
            inventory_plan(true, state, node, &namespace, image, &self.keys_sha256)?;
        }
        let secret = k8s
            .read("Secret", Some("pgcf-system"), "pgcf-backup-s3")
            .await?
            .ok_or("pool archive custody missing")?;
        for manifest in custody_manifests(
            &secret,
            &self.public_keys,
            &self.keys_sha256,
            text(&snapshot.region["backup"], "endpoint_url")?,
        )? {
            let name = text(&manifest["metadata"], "name")?;
            let ns = manifest["metadata"]["namespace"].as_str();
            if let Some(current) = k8s.read(text(&manifest, "kind")?, ns, name).await? {
                if current["metadata"]["labels"]["app.kubernetes.io/part-of"] != "pgcf"
                    || !current["metadata"]["deletionTimestamp"].is_null()
                {
                    return Err("pool custody resource ownership changed".into());
                }
                let field = if manifest["kind"] == "CiliumNetworkPolicy" {
                    "spec"
                } else {
                    "data"
                };
                if current[field] != manifest[field] {
                    k8s.patch(&current, &json!({field:manifest[field]})).await?;
                }
            } else {
                k8s.create(&manifest).await?;
            }
        }
        for (state, q, image) in policies {
            let node = nodes
                .iter()
                .find(|node| node["metadata"]["uid"] == state["node_uid"])
                .ok_or("pool policy Node absent")?;
            self.prepare(k8s, &state, node, &image, q.as_ref()).await?;
            if let Some(q) = q.as_ref() {
                self.join_sleep(k8s, q).await?;
                crate::pool_qualification::advance(self, k8s, q).await?;
            }
        }
        Ok(())
    }
}

/// The actual host-armed token has its own CF expiry. A later delivery never extends this
/// measured guard: both the current desired authority and this token must verify separately.
pub fn mounted_guard_current(
    trust: &pgcf_native_protocol::storage::StorageTrust,
    report: &Value,
    scope: &Value,
    clock: u64,
) -> bool {
    if scope["storage"]["backend"] != "lvm-thin-v1" {
        return report["thin_guard"].is_null();
    }
    let guard = &report["thin_guard"];
    let Some(token) = guard["authority_token"].as_str() else {
        return false;
    };
    let Some(verified) = pool::verify_pool_storage_authority(trust, token, scope, clock) else {
        return false;
    };
    guard["authority_revision"].as_u64() == Some(verified.claims().authority_revision)
        && guard["expires_at"].as_u64() == Some(verified.claims().exp)
        && guard["protect_on_expiry_armed"] == true
}

struct SleepReadback<'a> {
    node: &'a Value,
    tenant: &'a Value,
    cluster: &'a Value,
    pods: &'a [Value],
    lease: &'a Value,
    storage: &'a Value,
    claim: &'a Value,
    pv: &'a Value,
    lvm: &'a Value,
}
fn qualification_sleep_record(
    q: &Value,
    measurement: &Value,
    current: &SleepReadback<'_>,
    clock: u64,
) -> Result<Value, Error> {
    let scope = &q["scope"];
    let observed = &measurement["storage_observation"];
    let physical = &observed["storage"];
    let read = &measurement["storage_read"];
    let source = integer(scope, "database_generation")?
        .checked_sub(1)
        .ok_or("pool qualification source generation invalid")?;
    let at = integer(observed, "observed_at")?;
    if read["state"] != "read"
        || read["control_state"] != "shut down"
        || !read["error"].is_null()
        || read["system_identifier"].as_str().is_none()
        || read["timeline"].as_u64().is_none()
        || at > clock.saturating_add(5000)
        || observed["database_id"] != scope["database_id"]
        || observed["generation"].as_u64() != Some(source)
        || observed["node_uid"] != scope["node_uid"]
        || observed["boot_id"] != scope["boot_id"]
        || observed["kernel_proof"]["dm_open_count"] != 0
        || observed["kernel_proof"]["foreign_mounts"] != 0
        || observed["kernel_proof"]["named_namespace_scan_complete"] != true
        || physical["backend"] != "lvm-thin-v1"
        || physical["profile"] != scope["storage"]
        || physical["thin_id"] != scope["thin_id"]
        || current.node["metadata"]["uid"] != scope["node_uid"]
        || current.node["status"]["nodeInfo"]["bootID"] != scope["boot_id"]
        || current.tenant["metadata"]["uid"] != physical["namespace_uid"]
        || current.cluster["metadata"]["uid"] != physical["cnpg_cluster_uid"]
        || current.storage["metadata"]["uid"] != physical["storage_uid"]
        || current.claim["metadata"]["uid"] != physical["pvc_uid"]
        || current.pv["metadata"]["uid"] != physical["pv_uid"]
        || current.claim["spec"]["volumeName"] != current.pv["metadata"]["name"]
        || current.pv["spec"]["csi"]["volumeHandle"] != physical["volume_handle"]
        || current.lvm["metadata"]["name"] != physical["volume_handle"]
        || current.lvm["spec"]["ownerNodeID"] != current.node["metadata"]["name"]
        || current.lvm["status"]["state"] != "Ready"
        || current.cluster["metadata"]["annotations"]["cnpg.io/hibernation"] != "on"
        || !current.cluster["status"]["conditions"]
            .as_array()
            .is_some_and(|values| {
                values
                    .iter()
                    .any(|v| v["type"] == "cnpg.io/hibernation" && v["status"] == "True")
            })
        || !current.pods.is_empty()
        || current.lease["spec"]["holderIdentity"]
            .as_str()
            .is_some_and(|holder| !holder.is_empty())
        || [
            current.node,
            current.tenant,
            current.cluster,
            current.lease,
            current.storage,
            current.claim,
            current.pv,
            current.lvm,
        ]
        .iter()
        .any(|resource| !resource["metadata"]["deletionTimestamp"].is_null())
    {
        return Err("pool qualification clean sleep join unavailable".into());
    }
    let volume: Value = serde_json::from_str(text(
        &current.storage["metadata"]["annotations"],
        "pgcf.io/volume-identity",
    )?)?;
    for (saved, actual) in [
        ("handle", "volume_handle"),
        ("claimUid", "pvc_uid"),
        ("volumeUid", "pv_uid"),
        ("lvUuid", "lv_uuid"),
    ] {
        if volume[saved] != physical[actual] {
            return Err("pool qualification sealed volume changed".into());
        }
    }
    let value = json!({"v":1,"database_id":scope["database_id"],"generation":source,"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"configuration_fingerprint":scope["configuration_fingerprint"],"class":q["policy"]["policy"]["class"],"storage":physical,"system_identifier":read["system_identifier"],"timeline":read["timeline"],"clean_stop":true,"hibernation_on":true,"instance_pods_absent":true,"primary_lease_empty":true,"observed_at":at});
    if !pool::validate("PoolSleepRecord", &value) {
        return Err("pool qualification sleep contract invalid".into());
    }
    Ok(value)
}

pub fn terminal_handoff_patch(current: &Value, binding: &Value) -> Result<Value, Error> {
    if !pool::binding_valid(binding)
        || !matches!(binding["state"].as_str(), Some("released" | "refused"))
    {
        return Err("pool terminal handoff unproved".into());
    }
    let key = pool::constant("binding_record_key")
        .as_str()
        .ok_or("pool record key unavailable")?;
    let raw = current["data"][key]
        .as_str()
        .ok_or("pool handoff record absent")?;
    let old: Value = serde_json::from_str(raw)?;
    if !pool::binding_valid(&old)
        || old["scope"] != binding["scope"]
        || old["scope_sha256"] != binding["scope_sha256"]
        || old["holder_revision"].as_u64() > binding["holder_revision"].as_u64()
        || old["updated_at"].as_u64() > binding["updated_at"].as_u64()
    {
        return Err("pool handoff history changed".into());
    }
    if let Some(raw) = current["data"]["admission_target"].as_str() {
        let target: Value = serde_json::from_str(raw)?;
        if !pgcf_native_protocol::valid_schema("gatewayAdmissionTarget", &target)
            || target["generation"] != binding["scope"]["generation"]
            || target["pod_uid"] != binding["scope"]["pool_pod_uid"]
            || target["container_id"] != binding["scope"]["container_id"]
        {
            return Err("pool handoff admission target changed".into());
        }
    }
    Ok(json!({"data":{key:null,"admission_target":null}}))
}
pub fn handoff_selection_current(
    expected: &Value,
    current: &Value,
    old: &Value,
    bindings: &Value,
    node: &Value,
    now: u64,
) -> bool {
    let scope = &old["scope"];
    let identity = json!({"node_id":scope["node_id"],"node_uid":scope["node_uid"]});
    if !pool::binding_valid(old)
        || !snapshot_valid(bindings, &identity, node, now)
        || [
            "id",
            "generation",
            "desired_state",
            "node",
            "storage",
            "power",
        ]
        .iter()
        .any(|field| expected[field] != current[field])
    {
        return false;
    }
    let selected = current.get("pool_binding");
    match (expected.get("pool_binding"), selected) {
        (None, None) => {}
        (Some(wanted), Some(actual))
            if pool::binding_valid(&actual["binding"])
                && wanted["binding"]["scope"] == actual["binding"]["scope"]
                && wanted["binding"]["scope_sha256"] == actual["binding"]["scope_sha256"]
                && wanted["binding"]["holder_revision"].as_u64()
                    <= actual["binding"]["holder_revision"].as_u64() => {}
        _ => return false,
    }
    let active = bindings["bindings"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|desired| desired["binding"]["scope"]["database_id"] == expected["id"])
        .collect::<Vec<_>>();
    match selected {
        None => active.is_empty(),
        Some(desired)
            if matches!(
                desired["binding"]["state"].as_str(),
                Some("released" | "refused")
            ) =>
        {
            active.is_empty() && desired["binding"]["scope"] == *scope
        }
        Some(desired) => {
            active.len() == 1
                && active[0]["binding"]["scope"] == desired["binding"]["scope"]
                && active[0]["binding"]["scope_sha256"] == desired["binding"]["scope_sha256"]
                && active[0]["binding"]["holder_revision"].as_u64()
                    >= desired["binding"]["holder_revision"].as_u64()
        }
    }
}
pub fn terminal_report_matches(details: &Value, db: &Value) -> bool {
    let binding = &details["binding"]["binding"];
    let report = &details["node_report"];
    let scope = &binding["scope"];
    pool::binding_valid(binding)
        && pool::node_report_valid(report)
        && scope["database_id"] == db["id"]
        && scope["generation"]
            .as_u64()
            .zip(db["generation"].as_u64())
            .is_some_and(|(holder, desired)| holder <= desired)
        && matches!(binding["state"].as_str(), Some("released" | "refused"))
        && report["state"] == binding["state"]
        && report["binding_id"] == scope["binding_id"]
        && report["scope_sha256"] == binding["scope_sha256"]
        && report["node_uid"] == scope["node_uid"]
        && report["pool_pod_uid"] == scope["pool_pod_uid"]
        && (report["boot_id"] == scope["boot_id"]
            || report["boot_loss"]["holder_boot_id"] == scope["boot_id"])
}

pub fn same_resource(before: &Value, after: &Value) -> bool {
    before["metadata"]["uid"] == after["metadata"]["uid"]
        && before["metadata"]["resourceVersion"] == after["metadata"]["resourceVersion"]
        && after["metadata"]["deletionTimestamp"].is_null()
}
pub fn ready_report_current(report: &Value, binding: &Value, clock: u64) -> bool {
    pool::validate("PoolSupervisorReport", report)
        && report["state"] == "ready"
        && report["binding_id"] == binding["scope"]["binding_id"]
        && report["scope_sha256"] == binding["scope_sha256"]
        && report["bundle_nonce"] == binding["scope"]["bundle_nonce"]
        && report["system_identifier"] == binding["scope"]["system_identifier"]
        && report["timeline"] == binding["scope"]["timeline"]
        && report["observed_at"]
            .as_u64()
            .is_some_and(|at| at <= clock.saturating_add(5000) && at > clock.saturating_sub(60000))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HolderStage {
    Mount,
    Start,
    Serving,
    Drain,
    Retain,
    Release,
}

/// A persisted holder is an exclusive routing branch, even while disabled, expired or lost.
/// Only the explicit released/refused outcome may hand its storage back to CNPG.
pub fn holder_stage(enabled: bool, db: &Value, clock: u64) -> Result<Option<HolderStage>, Error> {
    let Some(desired) = db.get("pool_binding") else {
        return Ok(None);
    };
    if !enabled
        || !pool::validate("DesiredPoolBinding", desired)
        || !pool::binding_valid(&desired["binding"])
    {
        return Err("pool holder capability or contract unavailable".into());
    }
    let binding = &desired["binding"];
    let scope = &binding["scope"];
    if scope["database_id"] != db["id"]
        || scope["generation"].as_u64() > db["generation"].as_u64()
        || binding["created_at"]
            .as_u64()
            .is_none_or(|start| start > clock.saturating_add(5000))
    {
        return Err("pool holder database scope changed".into());
    }
    let stage = match text(binding, "state")? {
        "released" | "refused" => HolderStage::Release,
        "failed" | "lost" => HolderStage::Retain,
        "detaching" => HolderStage::Drain,
        "claimed" | "mounted" | "serving" => {
            if desired["authority"] != "current" || db["desired_state"] != "running" {
                HolderStage::Drain
            } else {
                if scope["generation"] != db["generation"] {
                    return Err("pool current holder generation changed".into());
                }
                if binding["state"] == "serving" {
                    HolderStage::Serving
                } else {
                    if desired["permission"].as_str().is_none_or(str::is_empty)
                        || binding["created_at"]
                            .as_u64()
                            .and_then(|start| {
                                start.checked_add(
                                    pool::constant("permission_ms").as_u64().unwrap_or(0),
                                )
                            })
                            .is_none_or(|expires| expires <= clock)
                    {
                        return Err("pool initial holder permission expired".into());
                    }
                    if binding["state"] == "claimed" {
                        HolderStage::Mount
                    } else {
                        HolderStage::Start
                    }
                }
            }
        }
        _ => return Err("pool holder outcome invalid".into()),
    };
    Ok(Some(stage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn policy() -> Value {
        json!({"node_id":"nod_aaaaaaaaaaaaaaaaaaaa","node_uid":"11111111-1111-4111-8111-111111111111","region_id":"test","revision":1,"updated_at":"2026-10-13T00:00:00.000Z","policy":{"version":1,"kind":"postgres_pods","target_slots":1,"max_idle_cpu_millicores":350,"max_idle_memory_mib":384,"idle_cpu_millicores":350,"idle_memory_mib":384,"release_id":"r2-pool-test","class":{"postgres_image_sha256":"a".repeat(64),"cpu_request_millicores":250,"cpu_limit_millicores":500,"memory_request_bytes":268435456,"memory_limit_bytes":536870912,"configuration_profile_sha256":"b".repeat(64)},"driver_image":format!("registry.test/driver@sha256:{}","1".repeat(64)),"driver_sha256":"2".repeat(64),"host_controller_sha256":"3".repeat(64),"supervisor_image":format!("registry.test/supervisor@sha256:{}","c".repeat(64)),"supervisor_sha256":"d".repeat(64),"archiver_image":format!("registry.test/archiver@sha256:{}","e".repeat(64)),"archiver_sha256":"e".repeat(64)}})
    }
    fn namespace() -> Value {
        json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"pgcf-pool","uid":"77777777-7777-4777-8777-777777777777"}})
    }
    fn node() -> Value {
        json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"pool-node","uid":"11111111-1111-4111-8111-111111111111"},"status":{"nodeInfo":{"bootID":"22222222-2222-4222-8222-222222222222"},"conditions":[{"type":"Ready","status":"True"}]}})
    }
    #[test]
    fn feature_disabled_does_not_plan_pods_even_for_an_enabled_policy() {
        assert!(
            inventory_plan(
                false,
                &policy(),
                &node(),
                &namespace(),
                &format!("registry.test/postgres@sha256:{}", "a".repeat(64)),
                &"9".repeat(64)
            )
            .unwrap()
            .is_empty()
        );
    }
    #[test]
    fn idle_pod_has_no_tenant_volume_or_kubernetes_credential_and_is_never_restarted() {
        let plans = inventory_plan(
            true,
            &policy(),
            &node(),
            &namespace(),
            &format!("registry.test/postgres@sha256:{}", "a".repeat(64)),
            &"9".repeat(64),
        )
        .unwrap();
        assert_eq!(plans.len(), 1);
        let spec = &plans[0]["spec"];
        assert_eq!(spec["restartPolicy"], "Never");
        assert_eq!(spec["automountServiceAccountToken"], false);
        assert_eq!(spec["shareProcessNamespace"], false);
        assert!(spec["securityContext"].get("fsGroup").is_none());
        assert!(spec["volumes"].as_array().unwrap().iter().all(|volume| {
            volume.get("persistentVolumeClaim").is_none()
                && volume.get("hostPath").is_none()
                && volume["emptyDir"]["medium"] == "Memory"
        }));
        let postgres = &spec["containers"][0];
        let archiver = &spec["containers"][1];
        assert_eq!(
            postgres["resources"]["requests"],
            json!({"cpu":"250m","memory":"268435456"})
        );
        assert_eq!(
            postgres["command"],
            json!(["/pgcf/bin/pgcf-supervisor", "serve"])
        );
        assert_eq!(
            archiver["command"],
            json!(["/pgcf/bin/pgcf-supervisor", "archiver"])
        );
        assert!(
            archiver["volumeMounts"]
                .as_array()
                .unwrap()
                .iter()
                .all(
                    |mount| !["control", "certificates"].contains(&mount["name"].as_str().unwrap())
                )
        );
        assert!(
            postgres["env"]
                .as_array()
                .unwrap()
                .iter()
                .all(|value| value["name"].as_str().unwrap().starts_with("PGCF_POOL_"))
        );
        assert!(
            postgres["env"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value["name"] == "PGCF_POOL_BIND_KEYS"
                    && value["valueFrom"]["configMapKeyRef"]["name"] == "pgcf-pool-bind-keys")
        );
        for container in spec["containers"].as_array().unwrap() {
            let mount = container["volumeMounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|mount| mount["name"] == "volume")
                .unwrap();
            assert_eq!(mount["mountPath"], "/var/lib/postgresql");
            assert_eq!(mount["mountPropagation"], "HostToContainer");
        }
        for name in ["control", "certificates", "controller-run"] {
            let mount = postgres["volumeMounts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|mount| mount["name"] == name)
                .unwrap();
            assert_eq!(mount["subPath"], "private");
        }
    }
    #[test]
    fn changed_node_or_image_and_unaffordable_idle_budget_are_refused() {
        let image = format!("registry.test/postgres@sha256:{}", "a".repeat(64));
        let mut wrong_node = node();
        wrong_node["metadata"]["uid"] = "33333333-3333-4333-8333-333333333333".into();
        assert!(
            inventory_plan(
                true,
                &policy(),
                &wrong_node,
                &namespace(),
                &image,
                &"9".repeat(64)
            )
            .is_err()
        );
        assert!(
            inventory_plan(
                true,
                &policy(),
                &node(),
                &namespace(),
                &format!("registry.test/postgres@sha256:{}", "f".repeat(64)),
                &"9".repeat(64)
            )
            .is_err()
        );
        let mut too_small = policy();
        too_small["policy"]["idle_memory_mib"] = 1.into();
        assert!(
            inventory_plan(
                true,
                &too_small,
                &node(),
                &namespace(),
                &image,
                &"9".repeat(64)
            )
            .is_err()
        );
        let mut undersized = policy();
        undersized["policy"]["idle_cpu_millicores"] = 300.into();
        assert!(
            inventory_plan(
                true,
                &undersized,
                &node(),
                &namespace(),
                &image,
                &"9".repeat(64)
            )
            .is_err(),
            "actual startup class requests cannot be reduced to fit an idle quote"
        );
    }
    #[test]
    fn lease_microtime_normalization_does_not_turn_a_confirmed_renewal_into_an_unknown_write() {
        let actual = json!({"spec":{"holderIdentity":"pgcf-pool/holder","renewTime":"2026-10-14T00:00:00.123000Z"}});
        let patch = json!({"spec":{"holderIdentity":"pgcf-pool/holder","renewTime":"2026-10-14T00:00:00.123Z"}});
        assert!(primary_lease_readback_matches(&actual, &patch));
        let mut changed = actual.clone();
        changed["spec"]["holderIdentity"] = "foreign-holder".into();
        assert!(!primary_lease_readback_matches(&changed, &patch));
    }

    #[test]
    fn supervisor_tls_requires_actual_ip_san_and_the_attested_spki() {
        use rcgen::PublicKeyData;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let address = "127.0.0.1".parse().unwrap();
        let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        let public = identity.signing_key.public_key_pem();
        let hash = Sha256::digest(identity.signing_key.subject_public_key_info())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert!(supervisor_tls(&identity.cert.pem(), &public, &hash, address).is_ok());
        let other = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
        assert!(supervisor_tls(&other.cert.pem(), &public, &hash, address).is_err());
        assert!(
            supervisor_tls(
                &identity.cert.pem(),
                &public,
                &hash,
                "127.0.0.2".parse().unwrap()
            )
            .is_err()
        );
    }

    fn holder_db(state: &str, clock: u64) -> Value {
        let scope = pool::CONTRACT["thin_scope"].clone();
        let binding = json!({"v":1,"scope_sha256":pool::scope_hash(&scope).unwrap(),"scope":scope,"holder_revision":1,"state":state,"created_at":clock,"updated_at":clock});
        json!({"id":binding["scope"]["database_id"],"generation":binding["scope"]["generation"],"desired_state":"running","pool_binding":{"binding":binding,"authority":"current","storage_authority":null,"permission":"initial-scoped-permission"}})
    }
    fn handoff_target(binding: &Value) -> Value {
        let scope = &binding["scope"];
        json!({"v":1,"generation":scope["generation"],"route_revision":scope["route_revision"],"admission_epoch":scope["admission_epoch"],"pod_uid":scope["pool_pod_uid"],"container_id":scope["container_id"],"ca_secret_uid":scope["pool_namespace_uid"],"ca_secret_resource_version":"1","ca_sha256":"f".repeat(64),"tls_server_name":format!("database-rw.pgcf-db-{}.svc",scope["database_id"].as_str().unwrap())})
    }
    #[test]
    fn a_pool_holder_never_falls_through_to_cnpg_and_original_permission_cannot_restart_it() {
        let clock = 100_000;
        assert_eq!(
            holder_stage(false, &json!({"id":"legacy"}), clock).unwrap(),
            None
        );
        assert!(holder_stage(false, &holder_db("claimed", clock), clock).is_err());
        assert_eq!(
            holder_stage(true, &holder_db("claimed", clock), clock).unwrap(),
            Some(HolderStage::Mount)
        );
        assert_eq!(
            holder_stage(true, &holder_db("mounted", clock), clock).unwrap(),
            Some(HolderStage::Start)
        );
        assert!(holder_stage(true, &holder_db("mounted", clock), clock + 30_000).is_err());
        let mut serving = holder_db("serving", clock);
        serving["pool_binding"]["permission"] = Value::Null;
        assert_eq!(
            holder_stage(true, &serving, clock + 60_000).unwrap(),
            Some(HolderStage::Serving)
        );
        serving["pool_binding"]["authority"] = "revoked".into();
        assert_eq!(
            holder_stage(true, &serving, clock + 60_000).unwrap(),
            Some(HolderStage::Drain)
        );
        assert_eq!(
            holder_stage(true, &holder_db("detaching", clock), clock).unwrap(),
            Some(HolderStage::Drain)
        );
        assert_eq!(
            holder_stage(true, &holder_db("lost", clock), clock).unwrap(),
            Some(HolderStage::Retain)
        );
        assert_eq!(
            holder_stage(true, &holder_db("released", clock), clock).unwrap(),
            Some(HolderStage::Release)
        );
        let mut changed = holder_db("mounted", clock);
        changed["generation"] = 999.into();
        assert!(holder_stage(true, &changed, clock).is_err());
    }
    #[test]
    fn the_actual_pending_bundle_reply_is_accepted_without_inventing_a_ready_report() {
        // This is the exact reply observed from the real supervisor when the bundle preceded
        // the node's mount signal. It has no postmaster, storage or admission proof.
        let pending = json!({"accepted":true,"waiting":true});
        let scope = &pool::CONTRACT["thin_scope"];
        let scope_sha256 = pool::scope_hash(scope).unwrap();
        assert!(supervisor_reply_valid(
            "/bundle",
            &Value::Null,
            scope,
            &scope_sha256,
            &pending
        ));
        assert!(!pool::validate("PoolSupervisorReport", &pending));
        assert!(!supervisor_reply_valid(
            "/status",
            &Value::Null,
            scope,
            &scope_sha256,
            &pending
        ));
        let mut disguised = pending;
        disguised["state"] = "ready".into();
        assert!(!supervisor_reply_valid(
            "/bundle",
            &Value::Null,
            scope,
            &scope_sha256,
            &disguised
        ));
    }

    #[test]
    fn preparation_uses_actual_namespace_and_all_writer_resources_before_cf_submission() {
        let state = policy();
        let mut ns = namespace();
        ns["metadata"]["resourceVersion"] = "1".into();
        let mut n = node();
        n["metadata"]["resourceVersion"] = "1".into();
        let image = format!("registry.test/postgres@sha256:{}", "a".repeat(64));
        let mut pod = inventory_plan(true, &state, &n, &ns, &image, &"9".repeat(64))
            .unwrap()
            .remove(0);
        pod["metadata"]["uid"] = "33333333-3333-4333-8333-333333333333".into();
        pod["metadata"]["resourceVersion"] = "2".into();
        pod["status"] = json!({"phase":"Running","podIP":"10.0.0.2","containerStatuses":[{"name":"postgres","ready":true,"state":{"running":{}},"containerID":format!("containerd://{}","4".repeat(64)),"imageID":image},{"name":"archiver","ready":true,"state":{"running":{}},"containerID":format!("containerd://{}","5".repeat(64)),"imageID":state["policy"]["archiver_image"]}]});
        let context = preparation_context(
            &state,
            &n,
            &ns,
            &[pod.clone()],
            (&image, &"9".repeat(64)),
            1000,
            None,
        )
        .unwrap();
        assert_eq!(context["pool_namespace_uid"], ns["metadata"]["uid"]);
        assert_eq!(
            context["pods"][0]["container_ids"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(pool::validate("PoolPodPreparationContext", &context));
        let mut pending = pod.clone();
        pending["metadata"]["uid"] = "66666666-6666-4666-8666-666666666666".into();
        pending["status"] = json!({"phase":"Pending"});
        let mixed = preparation_context(
            &state,
            &n,
            &ns,
            &[pod.clone(), pending.clone()],
            (&image, &"9".repeat(64)),
            1001,
            None,
        )
        .unwrap();
        assert_eq!(
            mixed["pods"].as_array().unwrap().len(),
            1,
            "a real Pending refill cannot suppress the retained Running holder's refresh"
        );
        pending["spec"]["containers"][1]["resources"]["requests"]["memory"] = "1Mi".into();
        assert!(
            preparation_context(
                &state,
                &n,
                &ns,
                &[pod.clone(), pending],
                (&image, &"9".repeat(64)),
                1001,
                None
            )
            .is_err(),
            "Pending resources still require the exact qualified Pod plan"
        );
        let mut disabled_refill = state.clone();
        disabled_refill["policy"]["target_slots"] = 0.into();
        assert_eq!(
            preparation_context(
                &disabled_refill,
                &n,
                &ns,
                std::slice::from_ref(&pod),
                (&image, &"9".repeat(64)),
                1001,
                None
            )
            .unwrap()["pods"]
                .as_array()
                .unwrap()
                .len(),
            1,
            "zero free target does not drop a retained holder's measured process context"
        );
        let mut changed = pod.clone();
        changed["spec"]["containers"][1]["resources"]["requests"]["memory"] = "1Mi".into();
        assert!(
            preparation_context(
                &state,
                &n,
                &ns,
                &[changed],
                (&image, &"9".repeat(64)),
                1000,
                None
            )
            .is_err()
        );
        let mut changed = pod.clone();
        changed["spec"]["restartPolicy"] = "Always".into();
        assert!(
            preparation_context(
                &state,
                &n,
                &ns,
                &[changed],
                (&image, &"9".repeat(64)),
                1000,
                None
            )
            .is_err()
        );
        let mut changed = pod;
        changed["status"]["containerStatuses"][1]["containerID"] =
            context["pods"][0]["container_ids"][0]
                .as_str()
                .map(|id| format!("containerd://{id}"))
                .unwrap()
                .into();
        assert!(
            preparation_context(
                &state,
                &n,
                &ns,
                &[changed],
                (&image, &"9".repeat(64)),
                1000,
                None
            )
            .is_err()
        );
    }

    #[test]
    fn mounted_guard_verifies_the_actual_armed_token_without_retiming_it_to_a_later_delivery() {
        let fixture = &pool::CONTRACT["storage"];
        let trust = pgcf_native_protocol::storage::StorageTrust::parse(
            fixture["keys_json"].as_str().unwrap(),
            fixture["keys_sha256"].as_str().unwrap(),
        )
        .unwrap();
        let token = fixture["token"].as_str().unwrap();
        let claims = &fixture["claims"];
        let report = json!({"thin_guard":{"authority_token":token,"authority_revision":claims["authority_revision"],"expires_at":claims["exp"],"protect_on_expiry_armed":true}});
        assert!(mounted_guard_current(
            &trust,
            &report,
            &pool::CONTRACT["thin_scope"],
            1001
        ));
        assert!(!mounted_guard_current(
            &trust,
            &report,
            &pool::CONTRACT["thin_scope"],
            11000
        ));
        let mut changed = pool::CONTRACT["thin_scope"].clone();
        changed["pool_pod_uid"] = "11111111-1111-4111-8111-111111111111".into();
        assert!(!mounted_guard_current(&trust, &report, &changed, 1001));
        let mut changed = report;
        changed["thin_guard"]["expires_at"] = 12000.into();
        assert!(!mounted_guard_current(
            &trust,
            &changed,
            &pool::CONTRACT["thin_scope"],
            1001
        ));
    }
    #[test]
    fn qualification_sleep_joins_only_real_closed_read_evidence_to_current_kube_custody() {
        let scope =
            pgcf_native_protocol::qualification::CONTRACT["fixture"]["claims"]["scope"].clone();
        let volume = &scope["volume"];
        let class = pool::CONTRACT["preparation"]["policy"]["class"].clone();
        let physical = json!({"backend":"lvm-thin-v1","storage_generation":volume["storage_generation"],"storage_uid":volume["storage_uid"],"namespace_uid":volume["namespace_uid"],"cnpg_cluster_uid":volume["cluster_uid"],"pvc_uid":volume["pvc_uid"],"pv_uid":volume["pv_uid"],"volume_handle":volume["volume_handle"],"volume_group_uuid":volume["volume_group_uuid"],"lv_uuid":volume["lv_uuid"],"thin_id":scope["thin_id"],"profile":scope["storage"]});
        let measurement = json!({"gate":"host_mount_context","storage_read":{"state":"read","system_identifier":"1234567890123456789","timeline":1,"control_state":"shut down","error":null},"storage_observation":{"v":1,"database_id":scope["database_id"],"generation":scope["database_generation"].as_u64().unwrap()-1,"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"storage":physical,"kernel_proof":{"dm_open_count":0,"foreign_mounts":0,"named_namespace_scan_complete":true},"observed_at":1000}});
        let q = json!({"scope":scope,"policy":{"policy":{"class":class}}});
        let name = format!("pgcf-db-{}", scope["database_id"].as_str().unwrap());
        let mut n = node();
        n["metadata"]["uid"] = scope["node_uid"].clone();
        n["status"]["nodeInfo"]["bootID"] = scope["boot_id"].clone();
        let tenant = json!({"kind":"Namespace","apiVersion":"v1","metadata":{"name":name,"uid":volume["namespace_uid"],"resourceVersion":"1"}});
        let cluster = json!({"kind":"Cluster","apiVersion":"postgresql.cnpg.io/v1","metadata":{"name":"database","namespace":name,"uid":volume["cluster_uid"],"resourceVersion":"2","annotations":{"cnpg.io/hibernation":"on"}},"status":{"conditions":[{"type":"cnpg.io/hibernation","status":"True"}]}});
        let lease = json!({"spec":{"holderIdentity":""}});
        let storage = json!({"metadata":{"uid":volume["storage_uid"],"annotations":{"pgcf.io/volume-identity":json!({"handle":volume["volume_handle"],"claimUid":volume["pvc_uid"],"volumeUid":volume["pv_uid"],"lvUuid":volume["lv_uuid"]}).to_string()}}});
        let claim = json!({"metadata":{"uid":volume["pvc_uid"]},"spec":{"volumeName":"owned-pv"}});
        let pv = json!({"metadata":{"name":"owned-pv","uid":volume["pv_uid"]},"spec":{"csi":{"volumeHandle":volume["volume_handle"]}}});
        let lvm = json!({"metadata":{"name":volume["volume_handle"]},"spec":{"ownerNodeID":n["metadata"]["name"]},"status":{"state":"Ready"}});
        let mut readback = SleepReadback {
            node: &n,
            tenant: &tenant,
            cluster: &cluster,
            pods: &[],
            lease: &lease,
            storage: &storage,
            claim: &claim,
            pv: &pv,
            lvm: &lvm,
        };
        let record = qualification_sleep_record(&q, &measurement, &readback, 1001).unwrap();
        assert_eq!(
            record["system_identifier"],
            measurement["storage_read"]["system_identifier"]
        );
        assert_eq!(
            record["observed_at"], 1000,
            "a later Kubernetes read never retimes the closed physical read"
        );
        assert!(pool::validate("PoolSleepRecord", &record));
        let actual_pods = [json!({"metadata":{"name":"actual-primary-still-present"}})];
        readback.pods = &actual_pods;
        assert!(qualification_sleep_record(&q, &measurement, &readback, 1001).is_err());
        readback.pods = &[];
        assert_eq!(
            qualification_sleep_record(&q, &measurement, &readback, 61001).unwrap()["observed_at"],
            1000,
            "immutable clean sleep is not retimed; CF joins current physical/no-writer proof"
        );
        let mut changed = measurement;
        changed["storage_read"]["control_state"] = "unclean".into();
        assert!(qualification_sleep_record(&q, &changed, &readback, 1001).is_err());
    }
    #[test]
    fn terminal_handoff_clears_only_the_matching_verified_holder_and_stale_admission_target() {
        let db = holder_db("released", 1000);
        let binding = &db["pool_binding"]["binding"];
        let map = json!({"data":{"pool-binding.json":binding.to_string(),"admission_target":handoff_target(binding).to_string(),"power.json":"retained-physical-anchor","intent.json":"retained-power-intent"}});
        let patch = terminal_handoff_patch(&map, binding).unwrap();
        assert_eq!(
            patch,
            json!({"data":{"pool-binding.json":null,"admission_target":null}})
        );
        let mut active = binding.clone();
        active["state"] = "serving".into();
        assert!(terminal_handoff_patch(&map, &active).is_err());
        let mut changed = binding.clone();
        changed["scope"]["binding_id"] = "11111111-1111-4111-8111-111111111111".into();
        changed["scope_sha256"] = pool::scope_hash(&changed["scope"]).unwrap().into();
        assert!(terminal_handoff_patch(&map, &changed).is_err());
        let mut fresh = map.clone();
        let mut target = handoff_target(binding);
        target["pod_uid"] = "11111111-1111-4111-8111-111111111111".into();
        fresh["data"]["admission_target"] = target.to_string().into();
        assert!(
            terminal_handoff_patch(&fresh, binding).is_err(),
            "the old terminal record cannot clear another current writer target"
        );
        let no_record = json!({"data":{"admission_target":"fresh-cnpg-target"}});
        assert!(
            terminal_handoff_patch(&no_record, binding).is_err(),
            "an absent old holder never authorizes clearing a newer ordinary target"
        );
    }
    #[test]
    fn terminal_handback_requires_the_actual_scoped_reference_closure_and_never_invents_clean_sleep()
     {
        let db = holder_db("released", 1000);
        let report = pool::CONTRACT["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "same-boot-reference-destruction")
            .unwrap()["value"]
            .clone();
        let mut details = json!({"binding":db["pool_binding"],"node_report":report});
        assert!(
            !terminal_report_matches(&details, &db),
            "a standalone valid report with another scope hash cannot hand back this binding"
        );
        details["node_report"]["scope_sha256"] =
            db["pool_binding"]["binding"]["scope_sha256"].clone();
        details["node_report"]["kernel_proof"]["creator_fence"]["scope_sha256"] =
            db["pool_binding"]["binding"]["scope_sha256"].clone();
        assert!(terminal_report_matches(&details, &db));
        let mut other = db.clone();
        other["id"] = "b".repeat(20).into();
        assert!(
            !terminal_report_matches(&details, &other),
            "terminal cleanup cannot cross the desired database scope"
        );
        other = db.clone();
        other["generation"] = (db["generation"].as_u64().unwrap() - 1).into();
        assert!(
            !terminal_report_matches(&details, &other),
            "an older desired page cannot hand back a newer holder"
        );
        assert_eq!(
            details["node_report"]["clean_stop"], false,
            "reference destruction is terminal custody, never a clean Sleep record"
        );
        details["node_report"]["kernel_proof"]["dm_open_count"] = 1.into();
        assert!(!terminal_report_matches(&details, &db));
    }
    #[test]
    fn terminal_history_cannot_substitute_for_the_current_cf_selection_and_complete_holder_snapshot()
     {
        let terminal = holder_db("released", 1000);
        let old = &terminal["pool_binding"]["binding"];
        let scope = &old["scope"];
        let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"actual-node","uid":scope["node_uid"]},"status":{"nodeInfo":{"bootID":scope["boot_id"]}}});
        let mut snapshot = json!({"v":1,"revision":1,"node_id":scope["node_id"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"issued_at":1000,"expires_at":31000,"bindings":[]});
        let mut cnpg = terminal.clone();
        cnpg.as_object_mut().unwrap().remove("pool_binding");
        assert!(handoff_selection_current(
            &cnpg, &cnpg, old, &snapshot, &node, 1000
        ));
        let mut next = holder_db("claimed", 1000);
        next["pool_binding"]["binding"]["scope"]["binding_id"] =
            "11111111-1111-4111-8111-111111111111".into();
        next["pool_binding"]["binding"]["scope"]["route_revision"] =
            (scope["route_revision"].as_u64().unwrap() + 1).into();
        next["pool_binding"]["binding"]["scope_sha256"] =
            pool::scope_hash(&next["pool_binding"]["binding"]["scope"])
                .unwrap()
                .into();
        snapshot["bindings"] = json!([next["pool_binding"]]);
        assert!(
            !handoff_selection_current(&cnpg, &cnpg, old, &snapshot, &node, 1000),
            "complete current ownership refuses stale CNPG fallback"
        );
        assert!(
            !handoff_selection_current(&terminal, &next, old, &snapshot, &node, 1000),
            "historical terminal details do not prove current selection"
        );
        assert!(handoff_selection_current(
            &next, &next, old, &snapshot, &node, 1000
        ));
        assert!(!handoff_selection_current(
            &next, &next, old, &snapshot, &node, 31000
        ));
        let mut changed = node.clone();
        changed["status"]["nodeInfo"]["bootID"] = "11111111-1111-4111-8111-111111111111".into();
        assert!(!handoff_selection_current(
            &next, &next, old, &snapshot, &changed, 1000
        ));
    }
    #[test]
    fn an_async_mount_callback_does_not_lose_the_original_bounded_empty_lease_claim() {
        let claimed = holder_db("claimed", 1000);
        assert!(original_lease_permission(&claimed["pool_binding"], 1001));
        let mut mounted = holder_db("mounted", 1000);
        assert!(original_lease_permission(&mounted["pool_binding"], 1001));
        assert!(!original_lease_permission(&mounted["pool_binding"], 31000));
        mounted["pool_binding"]["permission"] = Value::Null;
        assert!(!original_lease_permission(&mounted["pool_binding"], 1001));
        mounted = holder_db("serving", 1000);
        assert!(!original_lease_permission(&mounted["pool_binding"], 1001));
    }
}
