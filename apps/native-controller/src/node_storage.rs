// SPDX-License-Identifier: Apache-2.0
//! Physical LVM capacity from the existing OpenEBS LocalPV exporter, read through the
//! authenticated API-server Pod proxy: no exec, host writer or new daemon. A sample is a
//! measurement, never thin write authority, and anything unproven is unknown, never zero use.
//! A sampled thin node's readings go to Cloudflare against its nonce; only Cloudflare renews
//! write authority from them, and the controller delivers what Cloudflare signed.
use crate::{
    Error,
    api::{ControlApi, timestamp},
    contracts::{constant, integer, schema_valid, text},
    kubernetes::Kubernetes,
    reconcile::{storage_claims, write_ledger},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;

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
/// One complete exporter scrape of VG `pgcf`: its physical facts and every LV series it listed,
/// which number exactly the exporter's own LV count.
struct Scrape {
    physical: Value,
    lvs: Vec<Value>,
}
/// OpenEBS LocalPV LVM 1.10.1 runs vgs/lvs on each scrape, so its text is the measurement.
/// Thin percentages become conservative upper-bound bytes; every gauge must be unambiguous.
pub fn physical(source: &str, group_uuid: &str) -> Option<Value> {
    scrape(source, group_uuid, false).map(|scrape| scrape.physical)
}
fn scrape(source: &str, group_uuid: &str, qualification: bool) -> Option<Scrape> {
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
    // OpenEBS emits no LV series at all when one LV path does not resolve, while vgs still
    // counts every LV: a scrape is complete only when both agree.
    if one("lvm_vg_lv_count", &group)? != volumes.len() as f64 {
        return None;
    }
    let mut names = HashSet::new();
    let mut thick = 0.0;
    let mut other_pool_allocated = 0.0;
    let mut pool = None;
    let pools: HashSet<_> = volumes
        .iter()
        .filter(|volume| {
            label(&volume.labels, "segtype").as_deref() == Some("thin-pool")
                && label(&volume.labels, "pool").as_deref() == Some("")
        })
        .map(|volume| label(&volume.labels, "name").unwrap_or_default())
        .collect();
    let mut lvs = Vec::with_capacity(volumes.len());
    for volume in &volumes {
        let labels = &volume.labels;
        let name = label(labels, "name").unwrap_or_default();
        let primary =
            name == "pgcf_thinpool" && label(labels, "segtype").as_deref() == Some("thin-pool");
        let mapper = format!("/dev/mapper/pgcf-{}", name.replace('-', "--"));
        let path = label(labels, "path");
        let dm_path = label(labels, "dm_path");
        let path_valid = path == Some(format!("/dev/pgcf/{name}"))
            || (path.as_deref() == Some("")
                && if primary {
                    dm_path.as_deref() == Some(mapper.as_str())
                } else {
                    qualification
                });
        let scratch_mapper_valid = !qualification
            || primary
            || dm_path.as_deref() == Some("")
            || dm_path.as_deref() == Some(mapper.as_str());
        if name.is_empty()
            || name.len() > 128
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.+[]-".contains(&b))
            || !names.insert(name.clone())
            || !path_valid
            || !scratch_mapper_valid
            || if qualification && !primary {
                !matches!(
                    label(labels, "active_status").as_deref(),
                    Some("active" | "inactive")
                )
            } else {
                label(labels, "active_status").as_deref() != Some("active")
                    || one("lvm_lv_health_status", labels)? != 0.0
                    || one("lvm_lv_permission", labels)? != 1.0
            }
            || volume.value.fract() != 0.0
            || volume.value <= 0.0
            || volume.value > MAX_SAFE
        {
            return None;
        }
        lvs.push(
            json!({"name":name,"segtype":label(labels,"segtype"),"size_bytes":volume.value as u64}),
        );
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
            (Some("thin"), Some(parent))
                if if qualification {
                    pools.contains(parent)
                } else {
                    parent == "pgcf_thinpool"
                } => {}
            (Some("thin-pool"), Some("")) if qualification => {
                // Other pools reserve their own extents; they are never charged as thick LVs or
                // given invented usage. Qualification only publishes the primary pool's use.
                other_pool_allocated += volume.value;
                let metadata: Vec<_> = metrics
                    .iter()
                    .filter(|metric| {
                        metric.name == "lvm_lv_mda_total_size_bytes" && metric.labels == *labels
                    })
                    .collect();
                match metadata.as_slice() {
                    [] => {}
                    [metric]
                        if metric.value.fract() == 0.0
                            && metric.value > 0.0
                            && metric.value <= MAX_SAFE =>
                    {
                        other_pool_allocated += metric.value
                    }
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
    if !qualification
        && pool.is_none()
        && volumes
            .iter()
            .any(|volume| label(&volume.labels, "segtype").as_deref() == Some("thin"))
    {
        return None;
    }
    let bytes = |value: f64| {
        (value.fract() == 0.0 && (0.0..=MAX_SAFE).contains(&value)).then_some(value as u64)
    };
    let (total, free, thick, other_pool_allocated) = (
        bytes(total)?,
        bytes(free)?,
        bytes(thick)?,
        bytes(other_pool_allocated)?,
    );
    let allocated = total.checked_sub(free)?;
    if total == 0
        || thick.checked_add(other_pool_allocated)? > allocated
        || !volume_group_uuid(group_uuid)
    {
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
                || data + metadata + thick + other_pool_allocated > allocated
            {
                return None;
            }
            json!({"name":"pgcf_thinpool","data_total_bytes":data,"data_used_bytes_upper_bound":data_used,"metadata_total_bytes":metadata,"metadata_used_bytes_upper_bound":metadata_used})
        }
    };
    Some(Scrape {
        physical: json!({"volume_group_uuid":group_uuid,"total_bytes":total,"free_bytes":free,"thick_allocated_bytes":thick,"thin_pool":thin_pool}),
        lvs,
    })
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
/// One complete scrape between two identical identity reads of its node, cluster, VG and driver;
/// the witnesses bind it to Cloudflare's identity proof of the node.
struct Observed {
    scrape: Scrape,
    witnesses: Value,
}
async fn observe(
    kube: &Kubernetes,
    node: &Value,
    uid: &str,
    driver: &str,
    started: Instant,
    qualification: bool,
) -> Result<Option<Observed>, Error> {
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
    let measured = scrape(
        &kube.openebs_metrics(pod_name).await?,
        &group,
        qualification,
    );
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
    let boot = &node["status"]["nodeInfo"]["bootID"];
    let unchanged = fresh_node.as_ref().is_some_and(|fresh| {
        stable(fresh, uid)
            && fresh["status"]["nodeInfo"]["bootID"] == *boot
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
    if !unchanged {
        return Ok(None);
    }
    let cluster = cluster.as_ref().map(|value| &value["metadata"]["uid"]);
    Ok(measured.map(|scrape| Observed {
        scrape,
        witnesses: json!({"cluster_uid":cluster,"boot_id":boot,"volume_group_uuid":group,"driver_pod_uid":pod["metadata"]["uid"],"driver_image":bound["image"]}),
    }))
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
    let physical = observe(kube, node, uid, driver, Instant::now(), false)
        .await
        .ok()
        .flatten()
        .map(|observed| observed.scrape.physical);
    let observed_at = timestamp().ok()?;
    let sample = json!({"node_uid":uid,"observed_at":observed_at,"physical":physical});
    Some(if schema_valid("NodeStorageSample", &sample) {
        sample
    } else {
        json!({"node_uid":uid,"observed_at":observed_at,"physical":null})
    })
}
/// A headroom sample of one sampled node, without its nonce: one complete scrape and its
/// witnesses (thin-authority-renewal.md, 4.1). None is an unknown reading; it is never posted.
pub async fn headroom(kube: &Kubernetes, target: &Value, driver: &str) -> Option<Value> {
    let started = Instant::now();
    let captured_at = timestamp().ok()?;
    let node = kube.read("Node", None, text(target, "name")).await.ok()??;
    let observed = observe(
        kube,
        &node,
        text(target, "node_uid"),
        driver,
        started,
        !target["qualification_run"].is_null(),
    )
    .await
    .ok()??;
    // A complete scrape lists exactly as many LV series as the exporter counts.
    let count = observed.scrape.lvs.len();
    let sample = json!({"nonce":null,"qualification_run":target["qualification_run"],"node_uid":target["node_uid"],"captured_at":captured_at,"physical":observed.scrape.physical,"lvs":observed.scrape.lvs,"lv_count":count,"witnesses":observed.witnesses,"scrape_milliseconds":started.elapsed().as_millis() as u64});
    sample_valid(&sample).then_some(sample)
}
/// The headroom sample contract with the refinement JSON Schema cannot state: one complete
/// scrape of the witnessed volume group.
pub fn sample_valid(sample: &Value) -> bool {
    schema_valid("NodeStorageHeadroomSample", sample)
        && sample["lvs"].as_array().is_some_and(|lvs| {
            Some(lvs.len() as u64) == sample["lv_count"].as_u64()
                && lvs
                    .iter()
                    .map(|lv| text(lv, "name"))
                    .collect::<HashSet<_>>()
                    .len()
                    == lvs.len()
        })
        && sample["physical"]["volume_group_uuid"] == sample["witnesses"]["volume_group_uuid"]
}
/// What an accepted product sample renewed: the node's composed authority and the current write
/// token of each of its thin databases (database ID to token) at that authority.
#[derive(Debug)]
pub struct Renewal {
    pub node_uid: String,
    pub revision: u64,
    pub authority: Value,
    pub tokens: HashMap<String, String>,
}
/// How one sample ended.
#[derive(Debug)]
pub enum Sampled {
    /// The scrape was incomplete or an identity changed around it: nothing was posted.
    Unknown,
    /// Cloudflare refused the reading with this reason; only the next nonce changed.
    Refused(String),
    /// Cloudflare accepted the reading; a product sample also renewed its node.
    Accepted(Option<Renewal>),
}
/// The fast loop's state for one `storage_samples` target: the nonce the next sample answers
/// (none before Cloudflare's first answer) and the period Cloudflare asks for.
pub struct Sampler {
    target: Value,
    driver: String,
    nonce: Option<String>,
    period: Duration,
    /// How long the last complete scrape took.
    scraped: Option<Duration>,
}
impl Sampler {
    pub fn new(target: &Value, driver: &str) -> Option<Self> {
        schema_valid("ThinStorageSampleTarget", target).then(|| Self {
            target: target.clone(),
            driver: driver.to_string(),
            nonce: None,
            period: Duration::from_millis(target["period_milliseconds"].as_u64().unwrap_or(0)),
            scraped: None,
        })
    }
    pub fn period(&self) -> Duration {
        self.period
    }
    /// Scrapes once and posts the reading with the last nonce. The scrape is bounded by two
    /// periods, the post by the nonce's validity (guard / 2, 2.5 periods); a failed post keeps
    /// the nonce. An accepted reply also sets the next period, a refused one only the nonce.
    pub async fn sample(&mut self, kube: &Kubernetes, api: &ControlApi) -> Result<Sampled, Error> {
        let started = Instant::now();
        let scrape =
            tokio::time::timeout(self.period * 2, headroom(kube, &self.target, &self.driver));
        let Ok(Some(mut body)) = scrape.await else {
            return Ok(Sampled::Unknown);
        };
        self.scraped = Some(started.elapsed());
        body["nonce"] = self.nonce.clone().into();
        let reply = tokio::time::timeout(
            self.period * 5 / 2,
            api.storage_headroom(text(&self.target, "node_id"), &body),
        )
        .await
        .map_err(|_| "headroom sample deadline exceeded")??;
        self.nonce = Some(text(&reply, "nonce").to_string());
        if reply["accepted"] != true {
            return Ok(Sampled::Refused(text(&reply, "reason").to_string()));
        }
        self.period = Duration::from_millis(reply["period_milliseconds"].as_u64().unwrap_or(0));
        Ok(Sampled::Accepted(self.renewal(&reply)))
    }
    /// The renewal of an accepted product reply: this node's authority and the tokens that name a
    /// database on this node. A qualification run's samples renew nothing.
    fn renewal(&self, reply: &Value) -> Option<Renewal> {
        let authority = &reply["authority"];
        if !self.target["qualification_run"].is_null()
            || authority.is_null()
            || ["node_id", "name", "node_uid"]
                .iter()
                .any(|key| authority[*key] != self.target[*key])
        {
            return None;
        }
        let tokens = reply["tokens"]
            .as_array()?
            .iter()
            .filter(|entry| {
                storage_claims(text(entry, "token")).is_some_and(|claims| {
                    claims["database_id"] == entry["database_id"]
                        && claims["node_uid"] == self.target["node_uid"]
                })
            })
            .map(|entry| {
                (
                    text(entry, "database_id").to_string(),
                    text(entry, "token").to_string(),
                )
            })
            .collect();
        Some(Renewal {
            node_uid: text(&self.target, "node_uid").to_string(),
            revision: integer(authority, "revision").ok()?,
            authority: authority.clone(),
            tokens,
        })
    }
}
/// Samples one node until the controller stops it: one sample in flight, each scrape once the
/// period has passed since the previous one started. A renewal reaches the controller first and
/// then the gateway ledgers, never over a newer token. Reconcile and wake never wait for it.
pub async fn sample_node(
    kube: Kubernetes,
    api: ControlApi,
    mut sampler: Sampler,
    renewals: mpsc::Sender<Renewal>,
) {
    let mut next = tokio::time::Instant::now();
    loop {
        tokio::time::sleep_until(next).await;
        let started = tokio::time::Instant::now();
        sampler.scraped = None;
        let outcome = sampler.sample(&kube, &api).await;
        let mut event = json!({"event":"thin_storage_sample","node_id":sampler.target["node_id"],"outcome":"failed","milliseconds":started.elapsed().as_millis() as u64,"scrape_milliseconds":sampler.scraped.map(|scraped| scraped.as_millis() as u64)});
        match outcome {
            Ok(Sampled::Unknown) => event["outcome"] = "unknown".into(),
            Ok(Sampled::Refused(reason)) => {
                event["outcome"] = "refused".into();
                event["reason"] = reason.into();
            }
            Ok(Sampled::Accepted(renewal)) => {
                event["outcome"] = "accepted".into();
                if let Some(renewal) = renewal {
                    let (revision, tokens) = (renewal.revision, renewal.tokens.clone());
                    event["revision"] = revision.into();
                    if renewals.send(renewal).await.is_err() {
                        return;
                    }
                    event["ledgers"] = deliver(&kube, &tokens, revision, sampler.period * 2)
                        .await
                        .into();
                }
            }
            Err(_) => {}
        }
        eprintln!("{event}");
        next = started + sampler.period;
    }
}
/// Writes each renewed token into its database's ledger, a few at a time and bounded as a whole;
/// returns how many ledgers changed. A write cut off is superseded by the next renewal.
async fn deliver(
    kube: &Kubernetes,
    tokens: &HashMap<String, String>,
    revision: u64,
    bound: Duration,
) -> u64 {
    let mut writes = futures_util::stream::iter(tokens.iter().map(|(id, token)| async move {
        write_ledger(kube, &json!({ "id": id }), Some(token), Some(revision)).await
    }))
    .buffer_unordered(4);
    let mut written = 0;
    let _ = tokio::time::timeout(bound, async {
        while let Some(result) = writes.next().await {
            written += u64::from(matches!(result, Ok(true)));
        }
    })
    .await;
    written
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
    use crate::test_server::{Server, api_double, token, uid};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[test]
    fn typescript_exporter_conformance() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-storage-vectors.generated.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            assert_eq!(
                scrape(
                    text(vector, "metrics"),
                    text(vector, "volume_group_uuid"),
                    vector["qualification"] == true
                )
                .map(|scrape| scrape.physical)
                .unwrap_or(Value::Null),
                vector["physical"],
                "{}",
                vector["name"]
            );
        }
    }
    /// A thin pool with one thin LV; `lv_count` is the VG's own count and `lvs` the LV series.
    fn exporter(lv_count: u64, lvs: bool) -> String {
        let labels = |name: &str, segtype: &str, pool: &str| {
            format!(
                "active_status=\"active\",device=\"dm-0\",dm_path=\"/dev/mapper/pgcf-{}\",host=\"driver\",name=\"{name}\",path=\"/dev/pgcf/{name}\",pool=\"{pool}\",segtype=\"{segtype}\",vg=\"pgcf\"",
                name.replace('-', "--")
            )
        };
        let pool = labels("pgcf_thinpool", "thin-pool", "");
        let thin = labels("pvc-thin", "thin", "pgcf_thinpool");
        let mut text = format!(
            "lvm_vg_total_size_bytes{{name=\"pgcf\"}} 10000\nlvm_vg_free_size_bytes{{name=\"pgcf\"}} 5990\nlvm_vg_permission{{name=\"pgcf\"}} 0\nlvm_vg_missing_pv_count{{name=\"pgcf\"}} 0\nlvm_vg_pv_count{{name=\"pgcf\"}} 1\nlvm_vg_lv_count{{name=\"pgcf\"}} {lv_count}\n"
        );
        if lvs {
            text += &format!(
                "lvm_lv_total_size_bytes{{{pool}}} 4000\nlvm_lv_health_status{{{pool}}} 0\nlvm_lv_permission{{{pool}}} 1\nlvm_lv_mda_total_size_bytes{{{pool}}} 10\nlvm_lv_used_percent{{{pool}}} 25\nlvm_lv_mda_used_percent{{{pool}}} 20\nlvm_lv_when_full{{{pool}}} 0\nlvm_lv_total_size_bytes{{{thin}}} 2000\nlvm_lv_health_status{{{thin}}} 0\nlvm_lv_permission{{{thin}}} 1\n"
            );
        }
        text
    }
    #[test]
    fn an_exporter_scrape_without_its_lv_series_is_unknown_never_an_empty_volume_group() {
        let group = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
        assert_eq!(
            physical(&exporter(2, true), group).unwrap()["thin_pool"]["data_total_bytes"],
            4000
        );
        // OpenEBS emits no LV series at all when one LV path does not resolve; the VG gauges
        // still count its LVs. That is no reading, never a volume group without LVs or pool.
        assert!(physical(&exporter(2, false), group).is_none());
        // A count that differs from the series (lvcreate or lvremove between vgs and lvs).
        assert!(physical(&exporter(3, true), group).is_none());
        // A volume group without LVs is complete only when the exporter counts none.
        assert!(
            physical(&exporter(0, false), group)
                .unwrap()
                .get("thin_pool")
                .is_some_and(Value::is_null)
        );
    }
    #[test]
    fn a_primary_pool_with_a_truthful_blank_path_uses_the_exact_mapper_path() {
        let group = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef";
        let metrics = exporter(2, true).replace("path=\"/dev/pgcf/pgcf_thinpool\"", "path=\"\"");
        assert_eq!(
            physical(&metrics, group).unwrap()["thin_pool"]["data_total_bytes"],
            4000
        );
        assert!(
            physical(
                &metrics.replace(
                    "dm_path=\"/dev/mapper/pgcf-pgcf_thinpool\"",
                    "dm_path=\"/dev/mapper/other-pgcf_thinpool\""
                ),
                group
            )
            .is_none()
        );
    }
    const WRAPPER: &str = "ghcr.io/example/pgcf-regional:lvm-thin-sha-0123456789ab@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    /// One customer Node whose OpenEBS driver runs the release-pinned wrapper image.
    fn cluster(server: &Server) -> Value {
        let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"customer","uid":uid(1)},"status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"bootID":uid(8)}}});
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
    const NODE: &str = "nod_customer000000000000";
    fn target(qualification: Value) -> Value {
        // Periods of a second keep the scrape and post bounds above an emulated test build's latency.
        json!({"node_id":NODE,"name":"customer","node_uid":uid(1),"period_milliseconds":1000,"qualification_run":qualification})
    }
    /// The node's composed authority as Cloudflare returns it with an accepted sample.
    fn authority(revision: u64) -> Value {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let mut authority = vectors["reclamation"][0]["nodes"][0].clone();
        authority["node_id"] = NODE.into();
        authority["name"] = "customer".into();
        authority["node_uid"] = uid(1).into();
        authority["revision"] = revision.into();
        authority
    }
    fn reply(
        accepted: bool,
        nonce: char,
        period: u64,
        renewal: Option<(u64, Vec<Value>)>,
    ) -> Value {
        let (authority, tokens) = match renewal {
            Some((revision, tokens)) => (authority(revision), tokens),
            None => (Value::Null, vec![]),
        };
        json!({"accepted":accepted,"reason":if accepted {Value::Null} else {"thin_storage_sample_nonce_invalid".into()},"nonce":nonce.to_string().repeat(32),"period_milliseconds":period,"authority":authority,"tokens":tokens})
    }
    fn nonces(requests: &crate::test_server::Requests) -> Vec<Value> {
        requests
            .lock()
            .unwrap()
            .iter()
            .map(|(path, body)| {
                assert_eq!(path, &format!("/agent/v1/nodes/{NODE}/storage-headroom"));
                body["nonce"].clone()
            })
            .collect()
    }
    #[tokio::test]
    async fn a_headroom_sample_binds_one_complete_scrape_to_its_witnesses() {
        let server = Server::start().await;
        cluster(&server);
        let sample = headroom(&server.k8s, &target(Value::Null), WRAPPER)
            .await
            .unwrap();
        assert_eq!(
            sample["witnesses"],
            json!({"cluster_uid":uid(2),"boot_id":uid(8),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","driver_pod_uid":uid(6),"driver_image":WRAPPER})
        );
        assert_eq!(
            (&sample["lvs"], &sample["lv_count"], &sample["nonce"]),
            (
                &json!([{"name":"pvc-a","segtype":"linear","size_bytes":3000}]),
                &json!(1),
                &Value::Null
            )
        );
        // A reboot between the two identity reads leaves no reading.
        server.state.lock().unwrap().during_text = Some(Box::new(|objects| {
            objects.get_mut("/api/v1/nodes/customer").unwrap()["status"]["nodeInfo"]["bootID"] =
                uid(9).into();
        }));
        assert!(
            headroom(&server.k8s, &target(Value::Null), WRAPPER)
                .await
                .is_none()
        );
    }
    #[tokio::test]
    async fn only_a_qualification_target_inventories_all_scratch_lvs() {
        let server = Server::start().await;
        cluster(&server);
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-storage-vectors.generated.json"
        ))
        .unwrap();
        let vector = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "qualification-scratch-pools-and-inactive-raw")
            .unwrap();
        server.state.lock().unwrap().texts.insert(
            "/api/v1/namespaces/openebs/pods/openebs-lvm-localpv-node-x:9500/proxy/metrics".into(),
            text(vector, "metrics").into(),
        );
        assert!(
            headroom(&server.k8s, &target(Value::Null), WRAPPER)
                .await
                .is_none()
        );
        let sample = headroom(
            &server.k8s,
            &target("op_abcdefghijklmnopqrst".into()),
            WRAPPER,
        )
        .await
        .unwrap();
        assert_eq!(sample["lv_count"], 3);
        assert_eq!(sample["qualification_run"], "op_abcdefghijklmnopqrst");
        assert_eq!(sample["lvs"].as_array().unwrap().len(), 3);
        assert_eq!(sample["physical"], vector["physical"]);
        assert_eq!(sample["physical"]["thin_pool"]["name"], "pgcf_thinpool");
    }
    #[tokio::test]
    async fn each_sample_answers_the_last_nonce_and_a_refusal_changes_only_the_nonce() {
        let server = Server::start().await;
        cluster(&server);
        let database = "db000000000000000001";
        let renewed = token(database, 3, &uid(1), 7, 10_000);
        let foreign = token("db000000000000000002", 3, &uid(99), 7, 10_000);
        let tokens = vec![
            json!({"database_id":database,"token":renewed}),
            json!({"database_id":"db000000000000000002","token":foreign}),
        ];
        let (api, requests) = api_double(move |_, body| match body["nonce"].as_str() {
            None => (200, reply(false, 'a', 400, None)),
            Some(nonce) if nonce.starts_with('a') => {
                (200, reply(true, 'b', 1500, Some((7, tokens.clone()))))
            }
            Some(_) => (200, reply(false, 'c', 900, None)),
        })
        .await;
        let mut sampler = Sampler::new(&target(Value::Null), WRAPPER).unwrap();
        assert!(matches!(
            sampler.sample(&server.k8s, &api).await.unwrap(),
            Sampled::Refused(reason) if reason == "thin_storage_sample_nonce_invalid"
        ));
        assert_eq!(sampler.period(), Duration::from_millis(1000));
        let Sampled::Accepted(Some(renewal)) = sampler.sample(&server.k8s, &api).await.unwrap()
        else {
            panic!("an accepted product sample renews its node");
        };
        assert_eq!(
            (renewal.node_uid.as_str(), renewal.revision),
            (uid(1).as_str(), 7)
        );
        assert_eq!(renewal.authority, authority(7));
        // Only tokens of this node's databases are delivered.
        assert_eq!(
            renewal.tokens,
            HashMap::from([(database.to_string(), renewed)])
        );
        assert_eq!(sampler.period(), Duration::from_millis(1500));
        assert!(matches!(
            sampler.sample(&server.k8s, &api).await.unwrap(),
            Sampled::Refused(_)
        ));
        assert_eq!(sampler.period(), Duration::from_millis(1500));
        assert_eq!(
            nonces(&requests),
            [Value::Null, "a".repeat(32).into(), "b".repeat(32).into()]
        );
    }
    #[tokio::test]
    async fn a_qualification_run_samples_the_same_way_and_renews_nothing() {
        let server = Server::start().await;
        cluster(&server);
        let (api, requests) = api_double(|_, body| {
            if body["nonce"].is_null() {
                (200, reply(true, 'a', 1000, None))
            } else {
                (200, reply(true, 'b', 1000, Some((7, vec![]))))
            }
        })
        .await;
        let mut sampler =
            Sampler::new(&target(format!("op_{}", "q".repeat(20)).into()), WRAPPER).unwrap();
        for _ in 0..2 {
            assert!(matches!(
                sampler.sample(&server.k8s, &api).await.unwrap(),
                Sampled::Accepted(None)
            ));
        }
        assert_eq!(nonces(&requests), [Value::Null, "a".repeat(32).into()]);
    }
    #[tokio::test]
    async fn an_unknown_scrape_posts_nothing_and_a_stalled_post_keeps_the_nonce() {
        let server = Server::start().await;
        cluster(&server);
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let (api, requests) = api_double(move |_, _| {
            match counted.fetch_add(1, Ordering::SeqCst) {
                0 => (200, reply(false, 'a', 1000, None)),
                // The second post never gets an answer.
                1 => (0, Value::Null),
                _ => (200, reply(false, 'b', 1000, None)),
            }
        })
        .await;
        let mut sampler = Sampler::new(&target(Value::Null), WRAPPER).unwrap();
        sampler.sample(&server.k8s, &api).await.unwrap();
        let stalled = Instant::now();
        assert!(sampler.sample(&server.k8s, &api).await.is_err());
        // Bounded by the nonce's validity, 2.5 periods.
        assert!(stalled.elapsed() < Duration::from_secs(4));
        sampler.sample(&server.k8s, &api).await.unwrap();
        // The exporter lost its LV series: nothing is posted.
        let metrics =
            "/api/v1/namespaces/openebs/pods/openebs-lvm-localpv-node-x:9500/proxy/metrics";
        let lost = server.state.lock().unwrap().texts[metrics]
            .lines()
            .filter(|line| !line.starts_with("lvm_lv_"))
            .collect::<Vec<_>>()
            .join("\n");
        server
            .state
            .lock()
            .unwrap()
            .texts
            .insert(metrics.into(), lost);
        assert!(matches!(
            sampler.sample(&server.k8s, &api).await.unwrap(),
            Sampled::Unknown
        ));
        let a = Value::from("a".repeat(32));
        assert_eq!(nonces(&requests), [Value::Null, a.clone(), a]);
    }
    #[tokio::test]
    async fn the_loop_hands_each_renewal_to_the_controller_and_then_the_ledger() {
        let server = Server::start().await;
        cluster(&server);
        let database = "db000000000000000001";
        let soon =
            (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as u64 + 60_000;
        let (older, renewed) = (
            token(database, 3, &uid(1), 3, soon),
            token(database, 3, &uid(1), 7, soon),
        );
        server.put(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{database}"),"namespace":"pgcf-system","uid":uid(40),"labels":{"pgcf.io/database-id":database}},"data":{"state":"{}","write-authority":older}}));
        let token = renewed.clone();
        let (api, requests) = api_double(move |_, body| match body["nonce"].as_str() {
            None => (200, reply(false, 'a', 1000, None)),
            Some(_) => (
                200,
                reply(
                    true,
                    'b',
                    1000,
                    Some((7, vec![json!({"database_id":database,"token":token})])),
                ),
            ),
        })
        .await;
        let (sender, mut receiver) = mpsc::channel(4);
        let sampler = Sampler::new(&target(Value::Null), WRAPPER).unwrap();
        let local = tokio::task::LocalSet::new();
        local
            .run_until(async {
                let task =
                    tokio::task::spawn_local(sample_node(server.k8s.clone(), api, sampler, sender));
                let renewal = receiver.recv().await.unwrap();
                assert_eq!(renewal.revision, 7);
                let ledger = || {
                    server
                        .get(
                            "ConfigMap",
                            Some("pgcf-system"),
                            &format!("storage-{database}"),
                        )
                        .unwrap()["data"]["write-authority"]
                        .clone()
                };
                let deadline = Instant::now() + Duration::from_secs(5);
                while ledger() != renewed && Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                assert_eq!(ledger(), renewed);
                // A later renewal of the same revision rewrites nothing.
                receiver.recv().await.unwrap();
                task.abort();
            })
            .await;
        let sent = nonces(&requests);
        assert_eq!(sent[..2], [Value::Null, "a".repeat(32).into()]);
        assert_eq!(
            server
                .state
                .lock()
                .unwrap()
                .writes
                .iter()
                .filter(|(method, _, _)| method == "PATCH")
                .count(),
            1
        );
    }
}
