// SPDX-License-Identifier: Apache-2.0
//! Physical LVM capacity from the existing OpenEBS LocalPV exporter, read through the
//! authenticated API-server Pod proxy: no exec, host writer or new daemon. A sample is a
//! measurement, never thin write authority, and anything unproven is unknown, never zero use.
use crate::{
    Error,
    api::timestamp,
    contracts::{constant, schema_valid, text},
    kubernetes::Kubernetes,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::{Duration, Instant},
};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
struct Metric {
    name: String,
    labels: BTreeMap<String, String>,
    value: f64,
}
/// ECMAScript `\s`, so exposition lines parse exactly as the TypeScript sampler parses them.
fn space(c: char) -> bool {
    let unicode = [
        '\u{a0}', '\u{1680}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}',
        '\u{feff}',
    ];
    matches!(c, '\t'..='\r' | ' ' | '\u{2000}'..='\u{200a}') || unicode.contains(&c)
}
/// `-?\d+(\.\d+)?([eE][+-]?\d+)?`; NaN, infinities and overflow are never measurements.
fn decimal(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    let digits = |start: usize| {
        start
            + bytes[start..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count()
    };
    let mut end = usize::from(bytes.first() == Some(&b'-'));
    let integer = digits(end);
    if integer == end {
        return None;
    }
    end = integer;
    if bytes.get(end) == Some(&b'.') {
        let fraction = digits(end + 1);
        if fraction == end + 1 {
            return None;
        }
        end = fraction;
    }
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let start = end + 1 + usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        end = digits(start);
        if end == start {
            return None;
        }
    }
    if end != bytes.len() {
        return None;
    }
    value.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn labels(mut body: &str) -> Option<BTreeMap<String, String>> {
    let mut labels = BTreeMap::new();
    while !body.is_empty() {
        let name = body
            .bytes()
            .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
            .count();
        if name == 0 || body.as_bytes()[0].is_ascii_digit() {
            return None;
        }
        let quoted = body[name..].strip_prefix("=\"")?;
        let mut chars = quoted.char_indices();
        let mut value = String::new();
        let end = loop {
            match chars.next()? {
                (index, '"') => break index,
                (_, '\\') => value.push(match chars.next()?.1 {
                    '\\' => '\\',
                    '"' => '"',
                    'n' => '\n',
                    _ => return None,
                }),
                (_, c) => value.push(c),
            }
        };
        if labels.insert(body[..name].to_string(), value).is_some() {
            return None;
        }
        body = &quoted[end + 1..];
        if !body.is_empty() {
            body = body.strip_prefix(',')?;
        }
    }
    Some(labels)
}
fn metric(line: &str) -> Option<Metric> {
    let name = 4 + line[4..]
        .bytes()
        .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
        .count();
    let rest = line[name..].strip_prefix('{')?;
    let close = rest.rfind('}')?;
    let (body, tail) = (&rest[..close], &rest[close + 1..]);
    let value = tail.trim_start_matches(space);
    // An ECMAScript `.` never matches a line terminator inside the label set.
    if name == 4 || body.contains(['\r', '\u{2028}', '\u{2029}']) || value.len() == tail.len() {
        return None;
    }
    Some(Metric {
        name: line[..name].to_string(),
        labels: labels(body)?,
        value: decimal(value.trim_end_matches(space))?,
    })
}
fn volume_group_uuid(value: &str) -> bool {
    let parts: Vec<_> = value.split('-').collect();
    parts.len() == 7
        && parts.iter().enumerate().all(|(index, part)| {
            part.len() == if index == 0 || index == 6 { 6 } else { 4 }
                && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}
/// OpenEBS LocalPV LVM 1.10.1 runs vgs/lvs on each scrape, so its text is the measurement.
/// Thin percentages become conservative upper-bound bytes; every gauge must be unambiguous.
pub fn physical(source: &str, group_uuid: &str) -> Option<Value> {
    if source.len() > 2 * 1024 * 1024 {
        return None;
    }
    let metrics = source
        .split('\n')
        .filter(|line| line.starts_with("lvm_"))
        .map(metric)
        .collect::<Option<Vec<_>>>()?;
    let one = |name: &str, labels: &BTreeMap<String, String>| {
        let mut found = metrics
            .iter()
            .filter(|metric| metric.name == name && metric.labels == *labels);
        let first = found.next()?;
        found.next().is_none().then_some(first.value)
    };
    let label = |labels: &'_ BTreeMap<String, String>, key: &str| labels.get(key).cloned();
    let group = BTreeMap::from([("name".to_string(), "pgcf".to_string())]);
    let total = one("lvm_vg_total_size_bytes", &group)?;
    let free = one("lvm_vg_free_size_bytes", &group)?;
    if one("lvm_vg_permission", &group)? != 0.0
        || one("lvm_vg_missing_pv_count", &group)? != 0.0
        || one("lvm_vg_pv_count", &group)? != 1.0
    {
        return None;
    }
    let volumes: Vec<_> = metrics
        .iter()
        .filter(|metric| {
            metric.name == "lvm_lv_total_size_bytes"
                && label(&metric.labels, "vg").as_deref() == Some("pgcf")
        })
        .collect();
    let mut names = HashSet::new();
    let mut thick = 0.0;
    let mut pool = None;
    for volume in &volumes {
        let labels = &volume.labels;
        let name = label(labels, "name").unwrap_or_default();
        if name.is_empty()
            || !names.insert(name.clone())
            || label(labels, "active_status").as_deref() != Some("active")
            || label(labels, "path") != Some(format!("/dev/pgcf/{name}"))
            || one("lvm_lv_health_status", labels)? != 0.0
            || one("lvm_lv_permission", labels)? != 1.0
            || volume.value.fract() != 0.0
            || volume.value <= 0.0
            || volume.value > MAX_SAFE
        {
            return None;
        }
        match (
            label(labels, "segtype").as_deref(),
            label(labels, "pool").as_deref(),
        ) {
            (Some("linear"), Some("")) => thick += volume.value,
            (Some("thin-pool"), Some("")) if name == "pgcf_thinpool" && pool.is_none() => {
                let metadata = one("lvm_lv_mda_total_size_bytes", labels)?;
                if one("lvm_lv_when_full", labels)? != 0.0 {
                    return None;
                }
                // lvs rounds percentages to hundredths; charge the next hundredth conservatively.
                let upper = |gauge: &str, size: f64| {
                    let percent = one(gauge, labels)?;
                    (0.0..=100.0)
                        .contains(&percent)
                        .then(|| size.min((size * (percent + 0.01) / 100.0).ceil()))
                };
                pool = Some([
                    volume.value,
                    upper("lvm_lv_used_percent", volume.value)?,
                    metadata,
                    upper("lvm_lv_mda_used_percent", metadata)?,
                ]);
            }
            (Some("thin"), Some("pgcf_thinpool")) => {}
            _ => return None,
        }
    }
    if pool.is_none()
        && volumes
            .iter()
            .any(|volume| label(&volume.labels, "segtype").as_deref() == Some("thin"))
    {
        return None;
    }
    let bytes = |value: f64| {
        (value.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&value)).then_some(value as u64)
    };
    let (total, free, thick) = (bytes(total)?, bytes(free)?, bytes(thick)?);
    let allocated = total.checked_sub(free)?;
    if total == 0 || thick > allocated || !volume_group_uuid(group_uuid) {
        return None;
    }
    let thin_pool = match pool {
        None => Value::Null,
        Some(values) => {
            let [data, data_used, metadata, metadata_used] = values.map(bytes);
            let (data, data_used, metadata, metadata_used) =
                (data?, data_used?, metadata?, metadata_used?);
            if data == 0
                || metadata == 0
                || data_used > data
                || metadata_used > metadata
                || data + metadata + thick > allocated
            {
                return None;
            }
            json!({"name":"pgcf_thinpool","data_total_bytes":data,"data_used_bytes_upper_bound":data_used,"metadata_total_bytes":metadata,"metadata_used_bytes_upper_bound":metadata_used})
        }
    };
    Some(
        json!({"volume_group_uuid":group_uuid,"total_bytes":total,"free_bytes":free,"thick_allocated_bytes":thick,"thin_pool":thin_pool}),
    )
}
fn condition<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value["status"]["conditions"]
        .as_array()?
        .iter()
        .find(|c| text(c, "type") == name)?["status"]
        .as_str()
}
fn stable(node: &Value, uid: &str) -> bool {
    node["kind"] == "Node"
        && text(&node["metadata"], "uid") == uid
        && node["metadata"]["deletionTimestamp"].is_null()
        && condition(node, "Ready") == Some("True")
}
fn image(value: &str) -> &str {
    value.strip_prefix("docker.io/").unwrap_or(value)
}
fn digest(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    let hex = value.get(value.len().checked_sub(64)?..)?;
    let prefix = &value[..value.len() - 64];
    (hex.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && (prefix == "sha256:" || prefix.ends_with("@sha256:")))
    .then_some(hex)
}
/// The single ready driver container of the selected image, controlled by one DaemonSet.
fn identity(pod: &Value, node: &Value, driver: &str) -> Option<Value> {
    let owners = pod["metadata"]["ownerReferences"].as_array()?;
    let containers = pod["spec"]["containers"].as_array()?;
    let statuses = pod["status"]["containerStatuses"].as_array()?;
    if driver.is_empty()
        || pod["metadata"]["namespace"] != "openebs"
        || !pod["metadata"]["deletionTimestamp"].is_null()
        || pod["spec"]["nodeName"] != node["metadata"]["name"]
        || condition(pod, "Ready") != Some("True")
    {
        return None;
    }
    let controllers: Vec<_> = owners.iter().filter(|o| o["controller"] == true).collect();
    let drivers: Vec<_> = containers
        .iter()
        .filter(|c| {
            c["image"]
                .as_str()
                .is_some_and(|i| image(i) == image(driver))
        })
        .collect();
    let ([owner], [container]) = (controllers.as_slice(), drivers.as_slice()) else {
        return None;
    };
    let status = statuses.iter().find(|s| s["name"] == container["name"])?;
    if owner["kind"] != "DaemonSet"
        || text(&pod["metadata"], "uid").is_empty()
        || text(owner, "uid").is_empty()
        || text(owner, "name").is_empty()
        || status["ready"] != true
        || time::OffsetDateTime::parse(
            text(&status["state"]["running"], "startedAt"),
            &time::format_description::well_known::Rfc3339,
        )
        .is_err()
    {
        return None;
    }
    Some(
        json!({"podUid":pod["metadata"]["uid"],"ownerUid":owner["uid"],"ownerName":owner["name"],"image":container["image"],"name":container["name"],"imageId":digest(&status["imageID"])?,"restarts":status["restartCount"]}),
    )
}
fn groups(lvm: &Value) -> Vec<&Value> {
    lvm["volumeGroups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|group| group["name"] == "pgcf")
        .collect()
}
fn lvm_owned(lvm: &Value, node: &Value) -> bool {
    lvm["metadata"]["ownerReferences"]
        .as_array()
        .is_some_and(|owners| {
            owners.len() == 1
                && owners[0]["uid"] == node["metadata"]["uid"]
                && owners[0]["kind"] == "Node"
                && owners[0]["name"] == node["metadata"]["name"]
                && owners[0]["controller"] == true
        })
}
fn present(value: &Option<Value>) -> bool {
    value.as_ref().is_some_and(|value| {
        !text(&value["metadata"], "uid").is_empty()
            && value["metadata"]["deletionTimestamp"].is_null()
    })
}
async fn observe(
    kube: &Kubernetes,
    node: &Value,
    uid: &str,
    driver: &str,
    started: Instant,
) -> Result<Option<Value>, Error> {
    if !stable(node, uid) {
        return Ok(None);
    }
    let name = text(&node["metadata"], "name");
    let (cluster, namespace, lvm, pods) = tokio::try_join!(
        kube.read("Namespace", None, "kube-system"),
        kube.read("Namespace", None, "openebs"),
        kube.read("LVMNode", Some("openebs"), name),
        kube.list("Pod", Some("openebs"), None)
    )?;
    if !present(&cluster) || !present(&namespace) || !present(&lvm) {
        return Ok(None);
    }
    let lvm = lvm.ok_or("LVMNode disappeared")?;
    let group = match groups(&lvm).as_slice() {
        [group] if lvm_owned(&lvm, node) && !text(group, "uuid").is_empty() => {
            text(group, "uuid").to_string()
        }
        _ => return Ok(None),
    };
    let candidates: Vec<_> = pods
        .iter()
        .filter_map(|pod| identity(pod, node, driver).map(|bound| (pod, bound)))
        .collect();
    let [(pod, bound)] = candidates.as_slice() else {
        return Ok(None);
    };
    let owner_name = text(bound, "ownerName");
    let Some(owner) = kube
        .read("DaemonSet", Some("openebs"), owner_name)
        .await?
        .filter(|owner| {
            owner["metadata"]["uid"] == bound["ownerUid"]
                && owner["metadata"]["deletionTimestamp"].is_null()
                && owner["spec"]["template"]["spec"]["containers"]
                    .as_array()
                    .is_some_and(|containers| {
                        containers
                            .iter()
                            .any(|c| c["name"] == bound["name"] && c["image"] == bound["image"])
                    })
        })
    else {
        return Ok(None);
    };
    let pod_name = text(&pod["metadata"], "name");
    let measured = physical(&kube.openebs_metrics(pod_name).await?, &group);
    let (fresh_node, fresh_pod, fresh_owner, fresh_lvm, fresh_namespace, fresh_cluster) = tokio::try_join!(
        kube.read("Node", None, name),
        kube.read("Pod", Some("openebs"), pod_name),
        kube.read("DaemonSet", Some("openebs"), owner_name),
        kube.read("LVMNode", Some("openebs"), name),
        kube.read("Namespace", None, "openebs"),
        kube.read("Namespace", None, "kube-system")
    )?;
    let same = |fresh: &Option<Value>, original: &Option<Value>| {
        present(fresh)
            && fresh.as_ref().map(|v| &v["metadata"]["uid"])
                == original.as_ref().map(|v| &v["metadata"]["uid"])
    };
    let unchanged = fresh_node.as_ref().is_some_and(|fresh| {
        stable(fresh, uid)
            && fresh_pod
                .as_ref()
                .and_then(|pod| identity(pod, fresh, driver))
                .as_ref()
                == Some(bound)
    }) && fresh_owner.as_ref().is_some_and(|fresh| {
        fresh["metadata"]["uid"] == owner["metadata"]["uid"]
            && fresh["metadata"]["deletionTimestamp"].is_null()
            && fresh["metadata"]["resourceVersion"] == owner["metadata"]["resourceVersion"]
    }) && fresh_lvm.as_ref().is_some_and(|fresh| {
        fresh["metadata"]["uid"] == lvm["metadata"]["uid"]
            && fresh["metadata"]["deletionTimestamp"].is_null()
            && lvm_owned(fresh, node)
            && groups(fresh)
                .iter()
                .filter(|g| text(g, "uuid") == group)
                .count()
                == 1
    }) && same(&fresh_namespace, &namespace)
        && same(&fresh_cluster, &cluster)
        && started.elapsed() <= Duration::from_secs(20);
    Ok(if unchanged { measured } else { None })
}
/// The driver a fleet patch installs: the release's `openebs-lvm` pin, else the locked chart's.
pub fn driver_image(fleet: &Value) -> &str {
    fleet["release"]["spec"]["components"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|pin| pin["name"] == "openebs-lvm" && pin["kind"] == "image")
        .map_or(constant("OPENEBS_DRIVER_IMAGE"), |pin| &pin["reference"])
        .as_str()
        .unwrap_or("")
}
/// One bounded scrape of a Node. Every failure or mid-scrape replacement is an explicit unknown.
pub async fn sample(kube: &Kubernetes, node: &Value, driver: &str) -> Option<Value> {
    let uid = text(&node["metadata"], "uid");
    if !pgcf_native_protocol::valid_pattern("uuid", uid) {
        return None;
    }
    let physical = observe(kube, node, uid, driver, Instant::now())
        .await
        .ok()
        .flatten();
    let observed_at = timestamp().ok()?;
    let sample = json!({"node_uid":uid,"observed_at":observed_at,"physical":physical});
    Some(if schema_valid("NodeStorageSample", &sample) {
        sample
    } else {
        json!({"node_uid":uid,"observed_at":observed_at,"physical":null})
    })
}
/// Samples every Node once; the controller starts these slow scrapes at most every 60 seconds.
pub async fn samples(kube: &Kubernetes, fleet: &Value) -> Result<HashMap<String, Value>, Error> {
    let driver = driver_image(fleet);
    let mut result = HashMap::new();
    for node in kube.list("Node", None, None).await? {
        if let Some(sample) = sample(kube, &node, driver).await {
            result.insert(text(&sample, "node_uid").to_string(), sample);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{Server, uid};
    #[test]
    fn typescript_exporter_conformance() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-storage-vectors.generated.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            assert_eq!(
                physical(text(vector, "metrics"), text(vector, "volume_group_uuid"))
                    .unwrap_or(Value::Null),
                vector["physical"],
                "{}",
                vector["name"]
            );
        }
    }
    const WRAPPER: &str = "ghcr.io/example/pgcf-regional:lvm-thin-sha-0123456789ab@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    /// One customer Node whose OpenEBS driver runs the release-pinned wrapper image.
    fn cluster(server: &Server) -> Value {
        let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"customer","uid":uid(1)},"status":{"conditions":[{"type":"Ready","status":"True"}]}});
        let owner = json!([{"apiVersion":"apps/v1","kind":"DaemonSet","name":"openebs-lvm-localpv-node","uid":uid(5),"controller":true}]);
        for object in [
            node.clone(),
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"kube-system","uid":uid(2)}}),
            json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"openebs","uid":uid(3)}}),
            json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMNode","metadata":{"name":"customer","namespace":"openebs","uid":uid(4),"ownerReferences":[{"apiVersion":"v1","kind":"Node","name":"customer","uid":uid(1),"controller":true}]},"volumeGroups":[{"name":"pgcf","uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef"}]}),
            json!({"apiVersion":"apps/v1","kind":"DaemonSet","metadata":{"name":"openebs-lvm-localpv-node","namespace":"openebs","uid":uid(5)},"spec":{"template":{"spec":{"containers":[{"name":"openebs-lvm-plugin","image":WRAPPER}]}}}}),
            json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"openebs-lvm-localpv-node-x","namespace":"openebs","uid":uid(6),"ownerReferences":owner},"spec":{"nodeName":"customer","containers":[{"name":"openebs-lvm-plugin","image":WRAPPER}]},"status":{"conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"openebs-lvm-plugin","ready":true,"restartCount":0,"imageID":format!("ghcr.io/example/pgcf-regional@sha256:{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-11T00:00:00Z"}}}]}}),
        ] {
            server.put(object);
        }
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-storage-vectors.generated.json"
        ))
        .unwrap();
        server.state.lock().unwrap().texts.insert(
            "/api/v1/namespaces/openebs/pods/openebs-lvm-localpv-node-x:9500/proxy/metrics".into(),
            text(&vectors[0], "metrics").into(),
        );
        node
    }
    #[tokio::test]
    async fn the_release_selected_driver_proves_physical_storage() {
        let server = Server::start().await;
        let node = cluster(&server);
        let fleet = json!({"release":{"spec":{"components":[{"name":"openebs-lvm","kind":"image","reference":WRAPPER}]}}});
        assert_eq!(driver_image(&fleet), WRAPPER);
        let measured = samples(&server.k8s, &fleet).await.unwrap();
        assert_eq!(measured[&uid(1)]["physical"]["thick_allocated_bytes"], 3000);
        assert!(schema_valid("NodeStorageSample", &measured[&uid(1)]));
        // Without the release pin the locked stock driver is expected; the wrapper is not it.
        assert_eq!(
            driver_image(&Value::Null),
            constant("OPENEBS_DRIVER_IMAGE").as_str().unwrap()
        );
        let unknown = sample(&server.k8s, &node, driver_image(&Value::Null))
            .await
            .unwrap();
        assert_eq!(unknown["node_uid"], uid(1));
        assert!(unknown["physical"].is_null());
    }
    #[tokio::test]
    async fn a_node_replaced_during_the_scrape_yields_unknown_storage() {
        let server = Server::start().await;
        let node = cluster(&server);
        server.state.lock().unwrap().during_text = Some(Box::new(|objects| {
            objects.get_mut("/api/v1/nodes/customer").unwrap()["metadata"]["uid"] = uid(9).into();
        }));
        let sample = sample(&server.k8s, &node, WRAPPER).await.unwrap();
        assert_eq!(sample["node_uid"], uid(1));
        assert!(sample["physical"].is_null());
    }
}
