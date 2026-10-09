// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    api::{ControlApi, timestamp},
    contracts::{integer, text},
    kubernetes::Kubernetes,
    reconcile::quantity,
};
use serde_json::{Value, json};
use std::collections::HashSet;
fn condition<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|c| text(c, "type") == name)?["status"]
        .as_str()
}
fn request(container: &Value, resource: &str) -> Result<f64, Error> {
    let value = &container["resources"]["requests"][resource];
    if value.is_null() {
        return Ok(0.0);
    }
    let value = quantity(value).ok_or("platform resource request invalid")?;
    if value < 0.0 {
        return Err("platform resource request negative".into());
    }
    Ok(if resource == "cpu" {
        (value * 1000.0).ceil()
    } else {
        value
    })
}
fn pod_request(pod: &Value, resource: &str) -> Result<f64, Error> {
    let mut restartable = 0.0;
    let mut initial = 0.0_f64;
    for container in pod["spec"]["initContainers"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let count = request(container, resource)?;
        if text(container, "restartPolicy") == "Always" {
            restartable += count;
            initial = initial.max(restartable);
        } else {
            initial = initial.max(restartable + count);
        }
    }
    let mut apps = restartable;
    for container in pod["spec"]["containers"].as_array().into_iter().flatten() {
        apps += request(container, resource)?;
    }
    let overhead = &pod["spec"]["overhead"][resource];
    let overhead = if overhead.is_null() {
        0.0
    } else {
        quantity(overhead).ok_or("platform Pod overhead invalid")?
            * if resource == "cpu" { 1000.0 } else { 1.0 }
    };
    let result = apps.max(initial) + overhead;
    if !result.is_finite() || result < 0.0 || result > 9_007_199_254_740_991.0 {
        return Err("platform request total invalid".into());
    }
    Ok(result)
}
fn iso_millis(t: &str) -> Option<String> {
    let time =
        time::OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339).ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.year(),
        u8::from(time.month()),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.millisecond()
    ))
}
fn memory(node: &Value, summary: &Value) -> Option<Value> {
    if condition(node, "Ready") != Some("True")
        || summary["node"]["nodeName"] != node["metadata"]["name"]
    {
        return None;
    }
    let source = &summary["node"]["memory"];
    let sampled = time::OffsetDateTime::parse(
        text(source, "time"),
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    let now = time::OffsetDateTime::now_utc();
    if sampled > now || sampled < now - time::Duration::seconds(90) {
        return None;
    }
    let working = integer(source, "workingSetBytes").ok()?;
    let capacity = quantity(&node["status"]["capacity"]["memory"])?;
    if capacity <= 0.0
        || capacity.fract() != 0.0
        || capacity > 9_007_199_254_740_991.0
        || working > capacity as u64
    {
        return None;
    }
    let available = if source["availableBytes"].is_null() {
        None
    } else {
        Some(integer(source, "availableBytes").ok()?)
    };
    if available.is_some_and(|v| v > capacity as u64) {
        return None;
    }
    let pressure = match condition(node, "MemoryPressure") {
        Some("True") => Some(true),
        Some("False") => Some(false),
        _ => None,
    };
    Some(
        json!({"node_uid":node["metadata"]["uid"],"observed_at":iso_millis(text(source,"time"))?,"working_set_bytes":working,"capacity_memory_bytes":capacity as u64,"available_bytes":available,"memory_pressure":pressure}),
    )
}
fn stable_node(before: &Value, after: Option<&Value>) -> bool {
    after.is_some_and(|after| {
        after["metadata"]["uid"] == before["metadata"]["uid"]
            && after["status"]["capacity"] == before["status"]["capacity"]
            && after["status"]["allocatable"] == before["status"]["allocatable"]
            && after["spec"]["unschedulable"] == before["spec"]["unschedulable"]
            && condition(after, "Ready") == condition(before, "Ready")
            && after["metadata"]["deletionTimestamp"].is_null()
    })
}
pub async fn collect(
    kube: &Kubernetes,
    api: &ControlApi,
    desired_ids: &HashSet<String>,
) -> Result<(), Error> {
    let (nodes, pods, namespaces) = tokio::try_join!(
        kube.list("Node", None, None),
        kube.list("Pod", None, None),
        kube.list("Namespace", None, None)
    )?;
    let database_namespaces: HashSet<_> = namespaces
        .iter()
        .filter(|ns| {
            let id = text(&ns["metadata"]["labels"], "pgcf.io/database-id");
            desired_ids.contains(id) && text(&ns["metadata"], "name") == format!("pgcf-db-{id}")
        })
        .map(|ns| text(&ns["metadata"], "name").to_string())
        .collect();
    let mut reports = vec![];
    let mut samples = vec![];
    for node in nodes {
        let name = text(&node["metadata"], "name");
        let mut cpu = 0.0;
        let mut memory_requests = 0.0;
        for pod in &pods {
            if text(&pod["spec"], "nodeName") == name
                && !database_namespaces.contains(text(&pod["metadata"], "namespace"))
                && !matches!(text(&pod["status"], "phase"), "Succeeded" | "Failed")
            {
                cpu += pod_request(pod, "cpu")?;
                memory_requests += pod_request(pod, "memory")?;
            }
        }
        let allocatable_memory = quantity(&node["status"]["allocatable"]["memory"])
            .ok_or("node allocatable memory unknown")?;
        let allocatable_cpu = quantity(&node["status"]["allocatable"]["cpu"])
            .ok_or("node allocatable CPU unknown")?;
        let storage = text(
            &node["metadata"]["annotations"],
            "pgcf.io/storage-gib-total",
        )
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991);
        let mut report = json!({"name":name,"ready":condition(&node,"Ready")==Some("True")&&node["spec"]["unschedulable"]!=true,"allocatable_memory_mib":(allocatable_memory/2_f64.powi(20)).floor() as u64,"allocatable_cpu_millicores":(allocatable_cpu*1000.0).floor() as u64,"storage_gib_total":storage,"platform_reserved_memory_mib":(memory_requests/2_f64.powi(20)).ceil() as u64,"platform_reserved_cpu_millicores":cpu.ceil() as u64});
        if node["metadata"]["labels"]["pgcf.io/database-placement"] == "disabled" {
            report["database_placement_enabled"] = false.into();
        }
        let node_id = text(&node["metadata"]["labels"], "pgcf.io/node-id");
        let provider_id = text(&node["metadata"]["labels"], "pgcf.io/provider-instance-id");
        let uid = text(&node["metadata"], "uid");
        if !node_id.is_empty() && !provider_id.is_empty() && !uid.is_empty() {
            report["node_id"] = node_id.into();
            report["provider_instance_id"] = provider_id.into();
            report["node_uid"] = uid.into();
            let summary = kube.stats_summary(name).await.ok();
            let after = kube.read("Node", None, name).await?;
            // Do not refresh identity-bound hardware facts from a Node replaced mid-collection.
            if !stable_node(&node, after.as_ref()) {
                continue;
            }
            let sample = summary.as_ref().and_then(|summary| memory(&node, summary));
            samples.push(json!({"node_id":node_id,"provider_instance_id":provider_id,"node_uid":uid,"memory":sample}));
        }
        reports.push(report);
    }
    let orphans: Vec<_> = namespaces
        .iter()
        .filter_map(|ns| {
            let name = text(&ns["metadata"], "name");
            if !name.starts_with("pgcf-db-") {
                return None;
            }
            let id = text(&ns["metadata"]["labels"], "pgcf.io/database-id");
            if desired_ids.contains(id) {
                return None;
            }
            Some(json!({"namespace":name,"database_id":if id.is_empty(){None}else{Some(id)}}))
        })
        .collect();
    let envelope = json!({"observed_at":timestamp()?,"nodes":reports,"databases":[],"orphans":orphans,"node_memory_samples":samples});
    api.inventory(&envelope).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replaced_or_rescheduled_node_cannot_refresh_old_identity() {
        let node = json!({"metadata":{"uid":"old"},"status":{"capacity":{"memory":"8Gi"},"allocatable":{"memory":"7Gi"},"conditions":[{"type":"Ready","status":"True"}]}});
        assert!(stable_node(&node, Some(&node)));
        let mut changed = node.clone();
        changed["metadata"]["uid"] = "new".into();
        assert!(!stable_node(&node, Some(&changed)));
        changed = node.clone();
        changed["spec"]["unschedulable"] = true.into();
        assert!(!stable_node(&node, Some(&changed)));
        assert!(!stable_node(&node, None));
    }
    #[test]
    fn restartable_init_and_overhead_count_as_real_platform_capacity() {
        let pod = json!({"spec":{"containers":[{"resources":{"requests":{"cpu":"25m","memory":"64Mi"}}}],"initContainers":[{"restartPolicy":"Always","resources":{"requests":{"cpu":"100m","memory":"128Mi"}}},{"resources":{"requests":{"cpu":"500m","memory":"256Mi"}}}],"overhead":{"cpu":"10m","memory":"16Mi"}}});
        assert_eq!(pod_request(&pod, "cpu").unwrap(), 610.0);
        assert_eq!(pod_request(&pod, "memory").unwrap(), 400.0 * 2_f64.powi(20));
    }
    #[test]
    fn missing_memory_is_unknown_and_never_a_free_sample() {
        let node = json!({"metadata":{"name":"customer","uid":"f49d2ed7-b845-4ecb-9c81-20ec4b345958"},"status":{"capacity":{"memory":"8Gi"},"conditions":[{"type":"Ready","status":"True"}]}});
        assert!(
            memory(
                &node,
                &json!({"node":{"nodeName":"customer","memory":{"time":timestamp().unwrap()}}})
            )
            .is_none()
        );
    }
}
