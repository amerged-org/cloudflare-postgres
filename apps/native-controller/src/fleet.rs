// SPDX-License-Identifier: Apache-2.0
//! Kube-observed fleet facts. Receipt-backed Talos/Kubernetes provenance is never invented here.
use crate::{
    Error,
    api::{ControlApi, timestamp},
    contracts::{constant, integer, schema_valid, text},
    kubernetes::Kubernetes,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
fn ready(node: &Value) -> bool {
    node["status"]["conditions"].as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row["type"] == "Ready" && row["status"] == "True")
    })
}
fn controller(pod: &Value) -> Option<&Value> {
    let rows: Vec<_> = pod["metadata"]["ownerReferences"]
        .as_array()?
        .iter()
        .filter(|row| row["controller"] == true)
        .collect();
    (rows.len() == 1).then(|| rows[0])
}
fn digest(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    let sha = s.rsplit("sha256:").next()?;
    if sha.len() != 64
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let prefix = &s[..s.len() - sha.len()];
    (prefix == "sha256:" || prefix.ends_with("@sha256:") || prefix.ends_with("://sha256:"))
        .then_some(sha)
}
fn repository(s: &str) -> &str {
    let s = s.split('@').next().unwrap_or(s);
    if let Some((base, _)) = s.rsplit_once(':')
        && !s.rsplit(':').next().unwrap_or("").contains('/')
    {
        return base;
    }
    s
}
pub fn flux_ready(v: &Value) -> bool {
    let Ok(generation) = integer(&v["metadata"], "generation") else {
        return false;
    };
    generation > 0
        && integer(&v["status"], "observedGeneration").ok() == Some(generation)
        && v["status"]["conditions"].as_array().is_some_and(|rows| {
            rows.iter().any(|row| {
                row["type"] == "Ready"
                    && row["status"] == "True"
                    && integer(row, "observedGeneration").ok() == Some(generation)
            }) && !rows.iter().any(|row| {
                ["Stalled", "Reconciling"]
                    .iter()
                    .any(|name| row["type"] == *name)
                    && row["status"] == "True"
            })
        })
}
pub fn chart(pin: &Value, release: &Value, source: &Value, artifact: &Value) -> Option<Value> {
    if pin["kind"] != "chart" || !flux_ready(release) {
        return None;
    }
    let history = release["status"]["history"].as_array()?.first()?;
    let actual = text(history, "chartVersion").trim_start_matches('v');
    let wanted = text(pin, "version").trim_start_matches('v');
    if actual != wanted
        && !actual.starts_with(&format!("{wanted}+"))
        && !actual.starts_with(&format!("{wanted}@sha256:"))
    {
        return None;
    }
    let sha = format!("sha256:{}", text(pin, "sha256"));
    if text(pin, "reference").starts_with("oci://") {
        if !flux_ready(source)
            || source["spec"]["url"] != text(pin, "reference").split('@').next()?
            || source["spec"]["ref"]["digest"] != sha
            || !text(&source["status"]["artifact"], "revision").ends_with(&sha)
            || history["ociDigest"] != sha
            || history["status"] != "deployed"
        {
            return None;
        }
    } else if !flux_ready(artifact) || artifact["status"]["artifact"]["digest"] != sha {
        return None;
    }
    Some(json!({"name":pin["name"],"version":pin["version"],"sha256":pin["sha256"]}))
}
fn unchanged_node(before: &Value, after: &Value, assignment: &Value) -> bool {
    after["metadata"]["uid"] == assignment["node_uid"]
        && after["metadata"]["deletionTimestamp"].is_null()
        && ready(after)
        && [
            "kubeletVersion",
            "osImage",
            "bootID",
            "systemUUID",
            "machineID",
            "containerRuntimeVersion",
            "kernelVersion",
        ]
        .iter()
        .all(|field| before["status"]["nodeInfo"][*field] == after["status"]["nodeInfo"][*field])
}
fn static_images(pods: &[Value], node: &Value) -> Value {
    let mut images = json!({});
    for (key, name) in [
        ("apiServer", "kube-apiserver"),
        ("controllerManager", "kube-controller-manager"),
        ("scheduler", "kube-scheduler"),
    ] {
        let candidates: Vec<_> = pods
            .iter()
            .filter(|pod| {
                pod["metadata"]["namespace"] == "kube-system"
                    && pod["spec"]["nodeName"] == node["metadata"]["name"]
                    && pod["metadata"]["deletionTimestamp"].is_null()
                    && !text(
                        &pod["metadata"]["annotations"],
                        "kubernetes.io/config.mirror",
                    )
                    .is_empty()
                    && controller(pod).is_some_and(|owner| {
                        owner["kind"] == "Node" && owner["uid"] == node["metadata"]["uid"]
                    })
                    && pod["spec"]["containers"]
                        .as_array()
                        .is_some_and(|containers| {
                            containers.iter().any(|container| container["name"] == name)
                        })
            })
            .collect();
        if candidates.len() != 1 {
            continue;
        }
        let status = candidates[0]["status"]["containerStatuses"]
            .as_array()
            .and_then(|statuses| {
                statuses.iter().find(|status| {
                    status["name"] == name
                        && status["ready"] == true
                        && !status["state"]["running"].is_null()
                })
            });
        if let Some(sha) = status.and_then(|status| digest(&status["imageID"])) {
            images[key] = sha.into();
        }
    }
    images
}
pub async fn collect(kube: &Kubernetes, api: &ControlApi, desired: &Value) -> Result<(), Error> {
    if desired.is_null() {
        return Ok(());
    }
    tokio::time::timeout(Duration::from_secs(30), collect_inner(kube, api, desired))
        .await
        .map_err(|_| "fleet inventory deadline exceeded")?
}
async fn collect_inner(kube: &Kubernetes, api: &ControlApi, desired: &Value) -> Result<(), Error> {
    let started = Instant::now();
    let spec = &desired["release"]["spec"];
    let pins = spec["components"]
        .as_array()
        .ok_or("fleet release components missing")?;
    let pods = kube.list("Pod", None, None).await?;
    let mut charts = vec![];
    let mut platform_commit = None;
    let namespace = kube.read("Namespace", None, "flux-system").await?;
    if let Some(namespace) = namespace.filter(|ns| {
        !text(&ns["metadata"], "uid").is_empty() && ns["metadata"]["deletionTimestamp"].is_null()
    }) {
        let inventory = async {
            let (releases, sources, artifacts, source, platform, regional) = tokio::try_join!(
                kube.list("HelmRelease", Some("flux-system"), None),
                kube.list("OCIRepository", Some("flux-system"), None),
                kube.list("HelmChart", Some("flux-system"), None),
                kube.read("GitRepository", Some("flux-system"), "pgcf-platform"),
                kube.read("Kustomization", Some("flux-system"), "pgcf-platform"),
                kube.read("Kustomization", Some("flux-system"), "pgcf-regional")
            )?;
            let after = kube
                .read("Namespace", None, "flux-system")
                .await?
                .ok_or("Flux Namespace disappeared")?;
            if after["metadata"]["uid"] != namespace["metadata"]["uid"]
                || !after["metadata"]["deletionTimestamp"].is_null()
            {
                return Err::<(), Error>("Flux Namespace changed".into());
            }
            for pin in pins.iter().filter(|pin| pin["kind"] == "chart") {
                let name = if pin["name"] == "chart/plugin-barman-cloud" {
                    "plugin-barman-cloud"
                } else {
                    text(pin, "name")
                };
                let release = releases
                    .iter()
                    .find(|release| release["metadata"]["name"] == name)
                    .unwrap_or(&Value::Null);
                let source = sources
                    .iter()
                    .find(|source| {
                        source["metadata"]["name"] == release["spec"]["chartRef"]["name"]
                    })
                    .unwrap_or(&Value::Null);
                let artifact = artifacts
                    .iter()
                    .find(|artifact| {
                        format!(
                            "{}/{}",
                            text(&artifact["metadata"], "namespace"),
                            text(&artifact["metadata"], "name")
                        ) == text(&release["status"], "helmChart")
                    })
                    .unwrap_or(&Value::Null);
                if let Some(observed) = chart(pin, release, source, artifact) {
                    charts.push(observed);
                }
            }
            if let Some(target) = spec["platform_source_commit"].as_str()
                && let (Some(source), Some(platform), Some(regional)) = (source, platform, regional)
                && [&source, &platform, &regional]
                    .iter()
                    .all(|v| flux_ready(v))
                && source["spec"]["ref"]["commit"] == target
                && [
                    &source["status"]["artifact"]["revision"],
                    &platform["status"]["lastAppliedRevision"],
                    &regional["status"]["lastAppliedRevision"],
                ]
                .iter()
                .all(|v| {
                    v.as_str()
                        .is_some_and(|v| v.ends_with(&format!("sha1:{target}")))
                })
            {
                platform_commit = Some(target);
            }
            Ok(())
        }
        .await;
        if inventory.is_err() {
            charts.clear();
            platform_commit = None;
        }
    }
    let api_version = kube.version().await.ok().and_then(|v| {
        v["gitVersion"]
            .as_str()
            .map(|s| s.trim_start_matches('v').to_string())
    });
    for assignment in desired["nodes"]
        .as_array()
        .ok_or("fleet assignments missing")?
    {
        if started.elapsed() >= Duration::from_secs(25) {
            break;
        }
        let name = text(assignment, "k8s_node_name");
        let Some(node) = kube.read("Node", None, name).await? else {
            continue;
        };
        if node["metadata"]["uid"] != assignment["node_uid"]
            || !node["metadata"]["deletionTimestamp"].is_null()
            || !ready(&node)
        {
            continue;
        }
        let role = &spec["roles"][text(assignment, "role")];
        let wanted: HashSet<_> = role["components"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(role["talos_extensions"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect();
        let mut components: Vec<_> = charts
            .iter()
            .filter(|component| wanted.contains(text(component, "name")))
            .cloned()
            .collect();
        for pin in pins.iter().filter(|pin| {
            pin["kind"] == "image"
                && wanted.contains(text(pin, "name"))
                && !pin["workload"].is_null()
        }) {
            let workload = &pin["workload"];
            let scope = text(workload, "scope");
            let ns = text(workload, "namespace");
            let Some(namespace) = kube.read("Namespace", None, ns).await? else {
                continue;
            };
            if text(&namespace["metadata"], "uid").is_empty()
                || !namespace["metadata"]["deletionTimestamp"].is_null()
            {
                continue;
            }
            let selection = |pod: &Value| {
                pod["metadata"]["namespace"] == ns
                    && pod["metadata"]["deletionTimestamp"].is_null()
                    && (scope == "cluster" || pod["spec"]["nodeName"] == name)
                    && controller(pod).is_some()
                    && workload["selector"].as_object().is_some_and(|selector| {
                        selector
                            .iter()
                            .all(|(key, value)| pod["metadata"]["labels"][key] == *value)
                    })
            };
            let mut candidates = vec![];
            for pod in pods.iter().filter(|pod| selection(pod)) {
                for container in pod["spec"]["containers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|container| {
                        repository(text(container, "image")) == repository(text(pin, "reference"))
                    })
                {
                    let status = pod["status"]["containerStatuses"]
                        .as_array()
                        .and_then(|rows| rows.iter().find(|row| row["name"] == container["name"]));
                    candidates.push((pod, container, status));
                }
            }
            if candidates.is_empty()
                || candidates.iter().any(|(pod, _, status)| {
                    text(&pod["metadata"], "uid").is_empty()
                        || status.is_none_or(|status| {
                            status["ready"] != true
                                || text(&status["state"]["running"], "startedAt").is_empty()
                                || digest(&status["imageID"]).is_none()
                        })
                })
            {
                continue;
            }
            let digests: HashSet<_> = candidates
                .iter()
                .filter_map(|(_, _, status)| status.and_then(|status| digest(&status["imageID"])))
                .collect();
            if digests.len() != 1 {
                continue;
            }
            let sha = *digests.iter().next().ok_or("runtime digest missing")?;
            let mut stable = true;
            for (pod, container, status) in &candidates {
                let Some(fresh) = kube
                    .read("Pod", Some(ns), text(&pod["metadata"], "name"))
                    .await?
                else {
                    stable = false;
                    break;
                };
                let current = fresh["status"]["containerStatuses"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|row| row["name"] == container["name"]));
                if !selection(&fresh)
                    || fresh["metadata"]["uid"] != pod["metadata"]["uid"]
                    || controller(&fresh).map(|v| &v["uid"]) != controller(pod).map(|v| &v["uid"])
                    || fresh["spec"]["nodeName"] != pod["spec"]["nodeName"]
                    || current.is_none_or(|current| {
                        current["ready"] != true
                            || status.is_none_or(|status| {
                                current["imageID"] != status["imageID"]
                                    || current["restartCount"] != status["restartCount"]
                            })
                    })
                {
                    stable = false;
                    break;
                }
            }
            let after = kube.read("Namespace", None, ns).await?;
            if after.is_none_or(|after| {
                after["metadata"]["uid"] != namespace["metadata"]["uid"]
                    || !after["metadata"]["deletionTimestamp"].is_null()
            }) {
                stable = false;
            }
            if stable {
                let mut component = json!({"name":pin["name"],"runtime_image_sha256":sha});
                if pin["sha256"] == sha {
                    component["version"] = pin["version"].clone();
                    component["sha256"] = pin["sha256"].clone();
                }
                components.push(component);
            }
        }
        let Some(after) = kube.read("Node", None, name).await? else {
            continue;
        };
        if !unchanged_node(&node, &after, assignment) {
            continue;
        }
        let info = &node["status"]["nodeInfo"];
        let mut facts = json!({"configuration_schema_revision":constant("CONFIGURATION_SCHEMA_REVISION"),"components":components});
        if let Some(commit) = platform_commit {
            facts["platform_source_commit"] = commit.into();
        }
        if pgcf_native_protocol::valid_pattern("uuid", text(info, "bootID")) {
            facts["boot_id"] = info["bootID"].clone();
        }
        for (field, version) in [
            (
                "kubelet_version",
                info["kubeletVersion"]
                    .as_str()
                    .map(|s| s.trim_start_matches('v').to_string()),
            ),
            ("kubernetes_version", api_version.clone()),
            (
                "talos_version",
                info["osImage"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("Talos ("))
                    .and_then(|s| s.strip_suffix(')'))
                    .map(|s| s.trim_start_matches('v').to_string()),
            ),
        ] {
            if let Some(version) = version {
                let mut test = json!({"components":[]});
                test[field] = version.clone().into();
                if schema_valid("FleetReleaseFacts", &test) {
                    facts[field] = version.into();
                }
            }
        }
        let control = node["metadata"]["labels"]
            .as_object()
            .is_some_and(|labels| labels.contains_key("node-role.kubernetes.io/control-plane"));
        facts["kubernetes_control_plane"] = control.into();
        if control {
            let mut actual = vec![];
            for pod in pods.iter().filter(|pod| {
                pod["metadata"]["namespace"] == "kube-system"
                    && pod["spec"]["nodeName"] == name
                    && !pod["metadata"]["annotations"]["kubernetes.io/config.mirror"].is_null()
            }) {
                if let Some(fresh) = kube
                    .read("Pod", Some("kube-system"), text(&pod["metadata"], "name"))
                    .await?
                    && fresh["metadata"]["uid"] == pod["metadata"]["uid"]
                    && fresh["status"]["containerStatuses"] == pod["status"]["containerStatuses"]
                {
                    actual.push(fresh);
                }
            }
            facts["kubernetes_static_images"] = static_images(&actual, &after);
        }
        let Some(final_node) = kube.read("Node", None, name).await? else {
            continue;
        };
        if !unchanged_node(&node, &final_node, assignment) {
            continue;
        }
        api.fleet_observation(&json!({"node_id":assignment["node_id"],"node_uid":assignment["node_uid"],"assignment_revision":assignment["revision"],"observed_at":timestamp()?,"facts":facts})).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn semantic_flux_chart_conformance() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/fleet-vectors.generated.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            assert_eq!(
                flux_ready(&vector["release"]),
                vector["ready"].as_bool().unwrap()
            );
            assert_eq!(
                chart(
                    &vector["pin"],
                    &vector["release"],
                    &vector["source"],
                    &vector["chart"]
                ),
                vector["observed"]
                    .as_object()
                    .map(|_| vector["observed"].clone()),
                "{}",
                vector["name"]
            );
        }
    }
    #[test]
    fn static_images_require_exact_node_mirror_ownership_and_runtime_digest() {
        let node = json!({"metadata":{"uid":"node-uid","name":"control"}});
        let pod = json!({"metadata":{"uid":"pod","namespace":"kube-system","annotations":{"kubernetes.io/config.mirror":"hash"},"ownerReferences":[{"kind":"Node","uid":"node-uid","controller":true}]},"spec":{"nodeName":"control","containers":[{"name":"kube-apiserver"}]},"status":{"containerStatuses":[{"name":"kube-apiserver","ready":true,"state":{"running":{}},"imageID":format!("containerd://sha256:{}","a".repeat(64))}]}});
        assert_eq!(
            static_images(std::slice::from_ref(&pod), &node)["apiServer"],
            "a".repeat(64)
        );
        let mut changed = pod;
        changed["metadata"]["ownerReferences"][0]["uid"] = "replacement".into();
        assert!(
            static_images(&[changed], &node)
                .as_object()
                .unwrap()
                .is_empty()
        );
    }
}
