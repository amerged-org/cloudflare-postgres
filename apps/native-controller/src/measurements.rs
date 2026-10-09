// SPDX-License-Identifier: Apache-2.0
//! Background usage/idle observations. Persist immutable samples before sending;
//! missing history or physical facts remain unknown, never manufactured zeroes.
use crate::{
    Error,
    api::ControlApi,
    contracts::{database_valid, integer, namespace, number, schema_valid, text},
    kubernetes::{Kubernetes, bounded},
    power::GatewaySnapshot,
    reconcile::Reconciler,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, stream};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_protocol::{constant, valid_pattern, wire};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Mutex, OnceCell};
type Summaries = Arc<Mutex<HashMap<String, Arc<OnceCell<Value>>>>>;
static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/measurements.generated.json"
    ))
    .expect("generated measurement contract")
});
fn limit(name: &str) -> u64 {
    CONTRACT["constants"][name]
        .as_u64()
        .expect("generated measurement limit")
}
fn key(name: &str) -> &'static str {
    CONTRACT["constants"][name]
        .as_str()
        .expect("generated measurement key")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_millis()
        .try_into()
        .expect("bounded clock")
}
fn iso(ms: u64) -> Result<String, Error> {
    let value = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    ))
}
fn millis(value: &Value) -> Result<u64, Error> {
    let raw = value.as_str().ok_or("measurement timestamp missing")?;
    let time = time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)?;
    let ms: u64 = (time.unix_timestamp_nanos() / 1_000_000).try_into()?;
    if iso(ms)? != raw {
        return Err("measurement timestamp precision invalid".into());
    }
    Ok(ms)
}
fn uuid() -> Result<String, Error> {
    let mut bytes = [0; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .map_err(|_| "measurement process identity unavailable")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
fn remove(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(key);
    }
}
fn history(v: &Value) -> bool {
    !v["countersSince"].is_null()
        && (v["history"] == "current_process_absence"
            || (v["history"] == "complete" && !v["lastActivityAt"].is_null()))
}
fn same_epoch(a: &Value, b: &Value) -> bool {
    [
        "pod",
        "processEpoch",
        "epoch",
        "startedAt",
        "counterStartedAt",
        "countersSince",
    ]
    .iter()
    .all(|field| a[*field] == b[*field])
}
fn producer(v: &Value) -> String {
    format!(
        "gw_{}_{}_{}",
        text(v, "pod"),
        text(v, "processEpoch"),
        text(v, "epoch")
    )
}
fn same_snapshot(a: &GatewaySnapshot, b: &GatewaySnapshot) -> bool {
    a.pods == b.pods && a.key_uid == b.key_uid && a.key_version == b.key_version
}
fn report_valid(v: &Value) -> bool {
    if !schema_valid("GatewayActivityReport", v) {
        return false;
    }
    let checked = (|| -> Result<(), Error> {
        let start = millis(&v["startedAt"])?;
        let counter = millis(&v["counterStartedAt"])?;
        let observed = millis(&v["observedAt"])?;
        if counter < start || observed < counter {
            return Err("measurement report clock invalid".into());
        }
        for field in ["countersSince", "lastActivityAt"] {
            if !v[field].is_null() {
                let n = millis(&v[field])?;
                if n < counter || n > observed {
                    return Err("measurement report clock invalid".into());
                }
            }
        }
        if integer(v, "authenticatedConnections")? > integer(v, "connections")?
            || integer(v, "busyConnections")? > integer(v, "authenticatedConnections")?
            || integer(v, "pendingDials")? > integer(v, "connections")?
        {
            return Err("measurement report count invalid".into());
        }
        let fields = [
            "ingressBytes",
            "egressBytes",
            "totalConnections",
            "connectionMilliseconds",
        ];
        if v["history"] == "unavailable" {
            if !v["countersSince"].is_null() || fields.iter().any(|f| !v[*f].is_null()) {
                return Err("unknown history invalid".into());
            }
        } else if v["countersSince"].is_null() || fields.iter().any(|f| integer(v, f).is_err()) {
            return Err("known history invalid".into());
        }
        if ["complete", "current_process_absence"]
            .iter()
            .any(|h| v["history"] == *h)
            && v["countersSince"] != v["counterStartedAt"]
        {
            return Err("measurement history start invalid".into());
        }
        if v["history"] == "current_process_absence"
            && (!v["lastActivityAt"].is_null()
                || fields.iter().any(|f| number(v, f) != 0)
                || integer(v, "authenticatedConnections")? != 0
                || integer(v, "busyConnections")? != 0)
        {
            return Err("absence conceals activity".into());
        }
        Ok(())
    })();
    checked.is_ok()
}
fn checkpoint(resource: &Value, identity: &Value) -> Result<Value, Error> {
    let Some(raw) = resource["data"][key("MEASUREMENT_CHECKPOINT_KEY")].as_str() else {
        if !resource["data"][key("MEASUREMENT_CHECKPOINT_KEY")].is_null() {
            return Err("measurement checkpoint invalid".into());
        }
        return Ok(json!({"version":1,"identity":identity,"outbox":[]}));
    };
    if raw.len() > limit("MEASUREMENT_CHECKPOINT_BYTES") as usize {
        return Err("measurement checkpoint exceeds bound".into());
    }
    let value: Value = serde_json::from_str(raw)?;
    if value["version"] != 1 || value["identity"] != *identity {
        return Err("measurement checkpoint identity changed".into());
    }
    let outbox = value["outbox"]
        .as_array()
        .filter(|rows| rows.len() <= limit("MEASUREMENT_MAX_OUTBOX") as usize)
        .ok_or("measurement outbox invalid")?;
    if outbox
        .iter()
        .any(|sample| !schema_valid("UsageSample", sample))
    {
        return Err("measurement outbox invalid".into());
    }
    let mut result = json!({"version":1,"identity":identity,"outbox":outbox});
    for field in ["gapSince", "idleObservedSince"] {
        if !value[field].is_null() {
            millis(&value[field])?;
            result[field] = value[field].clone();
        }
    }
    if !value["baseline"].is_null() {
        let base = &value["baseline"];
        let reports = base["reports"]
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 16)
            .ok_or("measurement baseline invalid")?;
        let inventory = base["inventory"]
            .as_array()
            .filter(|rows| rows.len() == reports.len())
            .ok_or("measurement inventory invalid")?;
        if text(base, "keyUid").is_empty()
            || text(base, "keyVersion").is_empty()
            || reports.iter().any(|v| !report_valid(v))
        {
            return Err("measurement baseline invalid".into());
        }
        let mut pod_ids = HashSet::new();
        for pod in inventory {
            if !valid_pattern("uuid", text(pod, "uid"))
                || text(pod, "name").is_empty()
                || text(pod, "name").len() > 253
                || text(pod, "ip").parse::<std::net::IpAddr>().is_err()
                || integer(pod, "restarts").is_err()
                || !pod_ids.insert(text(pod, "uid"))
            {
                return Err("measurement inventory invalid".into());
            }
        }
        let mut respondents = HashSet::new();
        if reports.iter().any(|report| {
            !pod_ids.contains(text(report, "pod")) || !respondents.insert(text(report, "pod"))
        }) {
            return Err("measurement baseline respondents invalid".into());
        }
        let mut normalized = json!({"inventory":inventory,"reports":reports,"keyUid":base["keyUid"],"keyVersion":base["keyVersion"]});
        if !base["sampledAt"].is_null() {
            millis(&base["sampledAt"])?;
            normalized["sampledAt"] = base["sampledAt"].clone();
        }
        result["baseline"] = normalized;
    }
    if !result["idleObservedSince"].is_null() {
        let idle = millis(&result["idleObservedSince"])?;
        if result["baseline"]["sampledAt"].is_null()
            || idle > millis(&result["baseline"]["sampledAt"])?
            || (!result["gapSince"].is_null() && idle < millis(&result["gapSince"])?)
        {
            return Err("measurement idle boundary invalid".into());
        }
    }
    Ok(result)
}
fn differences(
    previous: &Value,
    current: &Value,
    expected: &Value,
    continuous: bool,
) -> Result<Vec<Value>, Error> {
    let start = millis(&previous["observedAt"])?;
    let end = millis(&current["observedAt"])?;
    if end <= start {
        return Ok(vec![]);
    }
    let fields = [
        "ingressBytes",
        "egressBytes",
        "totalConnections",
        "connectionMilliseconds",
    ];
    let known = continuous
        && same_epoch(previous, current)
        && history(previous)
        && history(current)
        && fields.iter().all(|f| {
            integer(previous, f)
                .ok()
                .zip(integer(current, f).ok())
                .is_some_and(|(a, b)| b >= a)
        });
    let hour = limit("USAGE_HOUR_MS");
    let same_hour = start / hour == (end - 1) / hour;
    let intervals = if same_hour {
        vec![(start, end)]
    } else {
        let first = (start / hour + 1) * hour;
        let last = (end - 1) / hour * hour;
        let mut result = vec![(start, first)];
        if last >= first {
            result.push((last, end));
        }
        result
    };
    intervals.into_iter().map(|(start,end)|{let diff=|field:&str|if known&&same_hour{Value::from(number(current,field)-number(previous,field))}else{Value::Null};let sample=json!({"database_id":current["database"],"source":"gateway","producer_id":producer(current),"sequence":end,"observed_at":current["observedAt"],"interval_start":iso(start)?,"interval_end":iso(end)?,"expected_producers":expected,"ingress_bytes":diff("ingressBytes"),"egress_bytes":diff("egressBytes"),"connections":diff("totalConnections"),"connection_seconds":if known&&same_hour{json!((number(current,"connectionMilliseconds")-number(previous,"connectionMilliseconds"))as f64/1000.0)}else{Value::Null}});if !schema_valid("UsageSample",&sample){return Err("measurement delta invalid".into());}Ok(sample)}).collect()
}
#[derive(Default)]
struct State {
    cursor: String,
    loaded: bool,
    sampling: HashMap<String, (u64, u64, bool)>,
}
struct Work {
    db: Value,
    resource: Value,
    namespace: Value,
    cluster: Value,
    checkpoint: Value,
    allocated: Option<u64>,
    volume_identity: Value,
}
pub struct Measurements {
    k8s: Kubernetes,
    api: ControlApi,
    controller: Arc<Reconciler>,
    http: reqwest::Client,
    state: Mutex<State>,
    process: String,
}
fn owned(v: &Value, kind: &str, name: &str, ns: Option<&str>, db: &Value) -> Result<(), Error> {
    if v["kind"] != kind
        || text(&v["metadata"], "name") != name
        || v["metadata"]["namespace"].as_str() != ns
        || v["metadata"]["labels"]["pgcf.io/database-id"] != db["id"]
        || !v["metadata"]["deletionTimestamp"].is_null()
        || !valid_pattern("uuid", text(&v["metadata"], "uid"))
        || text(&v["metadata"], "resourceVersion").is_empty()
    {
        return Err("measurement resource ownership changed".into());
    }
    Ok(())
}
fn cluster_owner(v: &Value, cluster: &Value) -> bool {
    let Some(owners) = v["metadata"]["ownerReferences"].as_array() else {
        return false;
    };
    let matching = owners
        .iter()
        .filter(|v| v["kind"] == cluster["kind"])
        .collect::<Vec<_>>();
    matching.len() == 1
        && matching[0]["apiVersion"] == cluster["apiVersion"]
        && matching[0]["name"] == cluster["metadata"]["name"]
        && matching[0]["uid"] == cluster["metadata"]["uid"]
}
fn capacity(claim: &Value) -> Option<u64> {
    crate::reconcile::quantity(&claim["status"]["capacity"]["storage"])
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n as u64)
}
impl Measurements {
    pub fn new(
        k8s: Kubernetes,
        api: ControlApi,
        controller: Arc<Reconciler>,
    ) -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Ok(Self {
            k8s,
            api,
            controller,
            http: reqwest::Client::builder()
                .retry(reqwest::retry::never())
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_millis(2500))
                .build()?,
            state: Mutex::new(State::default()),
            process: format!("agent_{}", uuid()?),
        })
    }
    async fn owner(&self, db: &Value) -> Result<Work, Error> {
        let id = text(db, "id");
        let ns = namespace(db);
        let storage_name = format!("storage-{id}");
        let fence_name = format!("gateway-fence-{id}");
        let (storage, namespace_value, cluster, fence) = tokio::try_join!(
            self.k8s
                .read("ConfigMap", Some("pgcf-system"), &storage_name),
            self.k8s.read("Namespace", None, &ns),
            self.k8s.read("Cluster", Some(&ns), "database"),
            self.k8s.read("ConfigMap", Some("pgcf-system"), &fence_name)
        )?;
        let resource = storage.ok_or("measurement storage unavailable")?;
        let namespace_value = namespace_value.ok_or("measurement namespace unavailable")?;
        let cluster = cluster.ok_or("measurement Cluster unavailable")?;
        let fence = fence.ok_or("measurement fence unavailable")?;
        for (v, kind, name, namespace) in [
            (
                &resource,
                "ConfigMap",
                storage_name.as_str(),
                Some("pgcf-system"),
            ),
            (&namespace_value, "Namespace", ns.as_str(), None),
            (&cluster, "Cluster", "database", Some(ns.as_str())),
            (
                &fence,
                "ConfigMap",
                fence_name.as_str(),
                Some("pgcf-system"),
            ),
        ] {
            owned(v, kind, name, namespace, db)?;
        }
        let raw = text(&resource["data"], "state");
        if raw.len() > 4096 {
            return Err("measurement custody exceeds bound".into());
        }
        let state: Value = serde_json::from_str(raw)?;
        let intent: Value = serde_json::from_str(text(&fence["data"], "intent.json"))?;
        if state["namespaceUid"] != namespace_value["metadata"]["uid"]
            || state["clusterUid"] != cluster["metadata"]["uid"]
            || state["node"] != db["node"]
            || state["archivePath"] != db["archive"]["destination_path"]
            || state["storage"] != db["storage"]
            || crate::contracts::generation(&resource) > number(db, "generation")
            || fence["metadata"]["labels"][wire("fenceLabel")] != "true"
            || !pgcf_native_protocol::valid_schema("intent", &intent)
            || intent["database"] != db["id"]
            || !["running", "quiesce"]
                .iter()
                .any(|mode| intent["mode"] == *mode)
            || intent["revision"] != db["generation"]
            || resource["metadata"]["annotations"]["pgcf.io/gateway-fence-uid"]
                .as_str()
                .is_some_and(|uid| fence["metadata"]["uid"] != uid)
        {
            return Err("measurement custody or fence changed".into());
        }
        let identity = json!({"storage":resource["metadata"]["uid"],"namespace":namespace_value["metadata"]["uid"],"cluster":cluster["metadata"]["uid"],"fence":fence["metadata"]["uid"],"state":raw});
        let checkpoint = checkpoint(&resource, &identity)?;
        if checkpoint["outbox"]
            .as_array()
            .unwrap()
            .iter()
            .any(|sample| sample["database_id"] != db["id"])
            || checkpoint["baseline"]["reports"]
                .as_array()
                .is_some_and(|reports| {
                    reports.iter().any(|report| {
                        report["database"] != db["id"] || report["region"] != self.api.region
                    })
                })
        {
            return Err("measurement checkpoint subject changed".into());
        }
        let volume_identity =
            resource["metadata"]["annotations"]["pgcf.io/volume-identity"].clone();
        let mut allocated = None;
        // PVC capacity is physical allocation only for the retained thick backend.
        if db["storage"].is_null()
            && let Some(raw) = volume_identity.as_str()
            && let Ok(identity) = serde_json::from_str::<Value>(raw)
        {
            let primary = text(&cluster["status"], "currentPrimary");
            let claims = if primary.is_empty() {
                self.k8s
                    .list(
                        "PersistentVolumeClaim",
                        Some(&ns),
                        Some("cnpg.io/cluster=database"),
                    )
                    .await?
            } else {
                self.k8s
                    .read("PersistentVolumeClaim", Some(&ns), primary)
                    .await?
                    .into_iter()
                    .collect()
            };
            let matches = claims
                .iter()
                .filter(|claim| claim["metadata"]["uid"] == identity["claimUid"])
                .collect::<Vec<_>>();
            if matches.len() == 1 {
                let claim = matches[0];
                if claim["metadata"]["namespace"] == ns
                    && (primary.is_empty() || claim["metadata"]["name"] == primary)
                    && claim["metadata"]["labels"]["cnpg.io/cluster"] == cluster["metadata"]["name"]
                    && cluster_owner(claim, &cluster)
                    && claim["metadata"]["deletionTimestamp"].is_null()
                    && claim["status"]["phase"] == "Bound"
                    && claim["spec"]["storageClassName"] == "pgcf-lvm"
                {
                    allocated = capacity(claim);
                }
            }
        }
        Ok(Work {
            db: db.clone(),
            resource,
            namespace: namespace_value,
            cluster,
            checkpoint,
            allocated,
            volume_identity,
        })
    }
    async fn save(&self, work: &mut Work) -> Result<(), Error> {
        let encoded = serde_json::to_string(&work.checkpoint)?;
        if encoded.len() > limit("MEASUREMENT_CHECKPOINT_BYTES") as usize {
            return Err("measurement checkpoint exceeds bound".into());
        }
        let actual = self
            .k8s
            .patch(
                &work.resource,
                &json!({"data":{key("MEASUREMENT_CHECKPOINT_KEY"):encoded}}),
            )
            .await?;
        if actual["metadata"]["uid"] != work.resource["metadata"]["uid"]
            || actual["data"]["state"] != work.checkpoint["identity"]["state"]
            || actual["metadata"]["annotations"]["pgcf.io/volume-identity"] != work.volume_identity
            || actual["data"][key("MEASUREMENT_CHECKPOINT_KEY")] != encoded
        {
            return Err("measurement checkpoint acknowledgement changed".into());
        }
        work.resource = actual;
        Ok(())
    }
    fn remember(state: &mut State, work: &Work) {
        let Ok(persisted) = checkpoint(&work.resource, &work.checkpoint["identity"]) else {
            state.sampling.remove(text(&work.db, "id"));
            return;
        };
        let reports = persisted["baseline"]["reports"].as_array();
        if reports.is_none_or(|rows| {
            rows.is_empty()
                || rows
                    .iter()
                    .any(|report| report["revision"] != work.db["generation"])
        }) {
            state.sampling.remove(text(&work.db, "id"));
            return;
        }
        let observed = reports
            .unwrap()
            .iter()
            .filter_map(|v| millis(&v["observedAt"]).ok())
            .chain(millis(&persisted["baseline"]["sampledAt"]).ok())
            .max()
            .unwrap_or(0);
        state.sampling.insert(
            text(&work.db, "id").into(),
            (
                number(&work.db, "generation"),
                observed,
                persisted["outbox"]
                    .as_array()
                    .is_some_and(|v| !v.is_empty()),
            ),
        );
    }
    async fn reports(&self, db: &Value, snapshot: &GatewaySnapshot) -> Result<Vec<Value>, Error> {
        if snapshot.pods.is_empty()
            || snapshot.pods.len() > 16
            || snapshot
                .pods
                .iter()
                .map(|v| &v.uid)
                .collect::<HashSet<_>>()
                .len()
                != snapshot.pods.len()
        {
            return Err("measurement gateway inventory invalid".into());
        }
        let key = snapshot
            .keys
            .get(&snapshot.active)
            .ok_or("measurement signing key unavailable")?;
        let reports=stream::iter(snapshot.pods.iter().map(|pod|async move{
   let clock=now();let issued=clock/1000;let claims=json!({"v":1,"region":self.api.region,"database":db["id"],"revision":db["generation"],"pod":pod.uid,"nonce":uuid()?,"kid":snapshot.active,"iat":issued,"exp":issued+constant("GATEWAY_ACTIVITY_MAX_LIFETIME_SECONDS")});if !pgcf_native_protocol::valid_schema("activityClaims",&claims){return Err::<Value,Error>("measurement activity credential invalid".into());}
   let payload=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims)?);let derived=mac(key,wire("activityKeyPurpose").as_bytes())?;let signature=mac(&derived,format!("{}{payload}",wire("activitySigningPurpose")).as_bytes())?;let token=format!("{}.{payload}.{}",wire("activityTokenPrefix"),URL_SAFE_NO_PAD.encode(signature));
   let ip:std::net::IpAddr=pod.ip.parse()?;let host=match ip{std::net::IpAddr::V4(ip)=>ip.to_string(),std::net::IpAddr::V6(ip)=>format!("[{ip}]")};let response=self.http.post(format!("http://{host}:8080{}",wire("activityPath"))).header(wire("activityHeader"),token).send().await?;if !response.status().is_success(){return Err("measurement report unavailable".into());}let value:Value=serde_json::from_slice(&bounded(response,4096).await?)?;let observed=millis(&value["observedAt"])?;let now=now();if !report_valid(&value)||value["region"]!=self.api.region||value["database"]!=db["id"]||value["revision"]!=db["generation"]||value["pod"]!=pod.uid||observed<now.saturating_sub(limit("GATEWAY_ACTIVITY_FRESH_MS"))||observed>now.saturating_add(limit("GATEWAY_ACTIVITY_FUTURE_MS")){return Err("measurement report identity or freshness invalid".into());}Ok(value)
  })).buffered(4).collect::<Vec<_>>().await;
        reports.into_iter().collect()
    }
    async fn flush(&self, works: &mut [Work], persisted: &HashSet<String>) -> Result<(), Error> {
        let samples = works
            .iter()
            .filter(|work| persisted.contains(text(&work.db, "id")))
            .flat_map(|work| {
                work.checkpoint["outbox"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
            })
            .take(100)
            .collect::<Vec<_>>();
        for batch in batches("samples", samples)? {
            if self.api.usage(&json!({"samples":batch})).await.is_err() {
                return Ok(());
            }
            let saves = stream::iter(works.iter_mut().map(|work| {
                let count = batch
                    .iter()
                    .filter(|v| v["database_id"] == work.db["id"])
                    .count();
                async move {
                    if count > 0 {
                        work.checkpoint["outbox"]
                            .as_array_mut()
                            .unwrap()
                            .drain(..count);
                        let _ = self.save(work).await;
                    }
                }
            }))
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
            drop(saves);
        }
        Ok(())
    }
}
fn mac(key: &[u8], value: &[u8]) -> Result<Vec<u8>, Error> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key).map_err(|_| "measurement signing key invalid")?;
    mac.update(value);
    Ok(mac.finalize().into_bytes().to_vec())
}
fn batches(field: &str, values: Vec<Value>) -> Result<Vec<Vec<Value>>, Error> {
    let mut result = Vec::new();
    let mut current = Vec::new();
    for value in values {
        let mut candidate = current.clone();
        candidate.push(value.clone());
        if current.len() == limit("MEASUREMENT_COHORT") as usize
            || serde_json::to_vec(&json!({field:candidate}))?.len()
                > limit("MEASUREMENT_BODY_BYTES") as usize
        {
            if current.is_empty() {
                return Err("measurement record exceeds body bound".into());
            }
            result.push(std::mem::take(&mut current));
        }
        if serde_json::to_vec(&json!({field:[&value]}))?.len()
            > limit("MEASUREMENT_BODY_BYTES") as usize
        {
            return Err("measurement record exceeds body bound".into());
        }
        current.push(value);
    }
    if !current.is_empty() {
        result.push(current);
    }
    Ok(result)
}
fn volume_used(summary: &Value, binding: &Value, now: u64) -> Option<u64> {
    if summary["node"]["nodeName"] != binding["node"] {
        return None;
    }
    let pods = summary["pods"].as_array().filter(|v| v.len() <= 10000)?;
    let selected = pods
        .iter()
        .filter(|v| {
            v["podRef"]["name"] == binding["pod"]
                && v["podRef"]["namespace"] == binding["namespace"]
        })
        .collect::<Vec<_>>();
    if selected.len() != 1 || selected[0]["podRef"]["uid"] != binding["podUid"] {
        return None;
    }
    let volumes = selected[0]["volume"].as_array().filter(|v| v.len() <= 64)?;
    let selected = volumes
        .iter()
        .filter(|v| v["name"] == binding["volume"])
        .collect::<Vec<_>>();
    if selected.len() != 1 {
        return None;
    }
    let volume = selected[0];
    let time = millis(&volume["time"]).ok()?;
    let used = integer(volume, "usedBytes").ok()?;
    let capacity = integer(volume, "capacityBytes").ok()?;
    (volume["pvcRef"]["name"] == binding["claim"]
        && volume["pvcRef"]["namespace"] == binding["namespace"]
        && time >= now.saturating_sub(120000)
        && time <= now.saturating_add(5000)
        && capacity > 0
        && used <= capacity
        && capacity <= integer(binding, "allocated").ok()?)
    .then_some(used)
}
fn signature(value: &Value) -> Value {
    json!({"metadata":value["metadata"],"spec":value["spec"]})
}
impl Measurements {
    async fn storage_used(&self, work: &Work, summaries: &Summaries) -> Option<u64> {
        let allocated = work.allocated?;
        let identity: Value = serde_json::from_str(work.volume_identity.as_str()?).ok()?;
        let primary = text(&work.cluster["status"], "currentPrimary");
        if primary.is_empty()
            || primary.len() > 63
            || !primary
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return None;
        }
        let ns = namespace(&work.db);
        let (pod, claim, node) = tokio::try_join!(
            self.k8s.read("Pod", Some(&ns), primary),
            self.k8s.read("PersistentVolumeClaim", Some(&ns), primary),
            self.k8s.read("Node", None, text(&work.db, "node"))
        )
        .ok()?;
        let (pod, claim, node) = (pod?, claim?, node?);
        if [&pod, &claim, &node]
            .iter()
            .any(|v| !v["metadata"]["deletionTimestamp"].is_null())
            || pod["metadata"]["name"] != primary
            || pod["metadata"]["namespace"] != ns
            || pod["metadata"]["labels"]["cnpg.io/cluster"] != work.cluster["metadata"]["name"]
            || !cluster_owner(&pod, &work.cluster)
            || pod["spec"]["nodeName"] != work.db["node"]
            || node["metadata"]["name"] != work.db["node"]
            || claim["metadata"]["namespace"] != ns
            || claim["metadata"]["name"] != primary
            || claim["metadata"]["uid"] != identity["claimUid"]
            || !cluster_owner(&claim, &work.cluster)
            || claim["status"]["phase"] != "Bound"
            || claim["spec"]["storageClassName"] != "pgcf-lvm"
        {
            return None;
        }
        let volume_name = text(&claim["spec"], "volumeName");
        if volume_name.is_empty() || volume_name.len() > 253 {
            return None;
        }
        let volume = self
            .k8s
            .read("PersistentVolume", None, volume_name)
            .await
            .ok()??;
        if volume["metadata"]["uid"] != identity["volumeUid"]
            || !volume["metadata"]["deletionTimestamp"].is_null()
            || volume["spec"]["claimRef"]["uid"] != claim["metadata"]["uid"]
            || volume["spec"]["claimRef"]["namespace"] != ns
            || volume["spec"]["claimRef"]["name"] != primary
            || volume["spec"]["csi"]["driver"] != "local.csi.openebs.io"
            || volume["spec"]["csi"]["volumeHandle"] != identity["handle"]
            || volume["status"]["phase"] != "Bound"
        {
            return None;
        }
        let mounts = pod["spec"]["volumes"]
            .as_array()?
            .iter()
            .filter(|v| v["persistentVolumeClaim"]["claimName"] == primary)
            .collect::<Vec<_>>();
        if mounts.len() != 1 || text(mounts[0], "name").is_empty() {
            return None;
        }
        let before = [&pod, &claim, &volume, &node].map(signature);
        let cache = format!(
            "{}_{}",
            text(&node["metadata"], "uid"),
            text(&node["metadata"], "resourceVersion")
        );
        let cell = {
            let mut cached = summaries.lock().await;
            cached
                .entry(cache)
                .or_insert_with(|| Arc::new(OnceCell::new()))
                .clone()
        };
        let summary = cell
            .get_or_init(|| async {
                self.k8s
                    .stats_summary(text(&work.db, "node"))
                    .await
                    .unwrap_or(Value::Null)
            })
            .await;
        let used = volume_used(
            summary,
            &json!({"node":work.db["node"],"namespace":ns,"pod":primary,"podUid":pod["metadata"]["uid"],"volume":mounts[0]["name"],"claim":primary,"allocated":allocated}),
            now(),
        )?;
        let (new_pod, new_claim, new_volume, new_node, new_namespace, new_cluster, new_storage) =
            tokio::try_join!(
                self.k8s.read("Pod", Some(&ns), primary),
                self.k8s.read("PersistentVolumeClaim", Some(&ns), primary),
                self.k8s.read("PersistentVolume", None, volume_name),
                self.k8s.read("Node", None, text(&work.db, "node")),
                self.k8s.read("Namespace", None, &ns),
                self.k8s.read("Cluster", Some(&ns), "database"),
                self.k8s.read(
                    "ConfigMap",
                    Some("pgcf-system"),
                    text(&work.resource["metadata"], "name")
                )
            )
            .ok()?;
        for (index, current) in [new_pod?, new_claim?, new_volume?, new_node?]
            .iter()
            .enumerate()
        {
            if !current["metadata"]["deletionTimestamp"].is_null()
                || signature(current) != before[index]
            {
                return None;
            }
        }
        let (new_namespace, new_cluster, new_storage) =
            (new_namespace?, new_cluster?, new_storage?);
        (new_namespace["metadata"]["uid"] == work.namespace["metadata"]["uid"]
            && new_namespace["metadata"]["deletionTimestamp"].is_null()
            && new_namespace["metadata"]["labels"]["pgcf.io/database-id"] == work.db["id"]
            && new_cluster["metadata"]["uid"] == work.cluster["metadata"]["uid"]
            && new_cluster["metadata"]["deletionTimestamp"].is_null()
            && new_cluster["status"]["currentPrimary"] == primary
            && new_storage["metadata"]["uid"] == work.resource["metadata"]["uid"]
            && new_storage["metadata"]["deletionTimestamp"].is_null()
            && new_storage["data"]["state"] == work.checkpoint["identity"]["state"]
            && new_storage["metadata"]["annotations"]["pgcf.io/volume-identity"]
                == work.volume_identity)
            .then_some(used)
    }
    pub async fn cycle(&self, databases: &[Value]) -> Result<(), Error> {
        let Ok(mut state) = self.state.try_lock() else {
            return Ok(());
        };
        tokio::time::timeout(Duration::from_secs(10), self.collect(databases, &mut state)).await?
    }
    async fn collect(&self, databases: &[Value], state: &mut State) -> Result<(), Error> {
        if databases.len() > 10000
            || databases.iter().any(|db| !database_valid(db))
            || databases
                .iter()
                .map(|db| text(db, "id"))
                .collect::<HashSet<_>>()
                .len()
                != databases.len()
        {
            return Err("measurement subjects invalid".into());
        }
        let mut targets = databases
            .iter()
            .filter(|db| db["desired_state"] != "deleted")
            .collect::<Vec<_>>();
        targets.sort_by_key(|db| text(db, "id"));
        if targets.is_empty() {
            state.sampling.clear();
            return Ok(());
        }
        state.sampling.retain(|id, (generation, _, _)| {
            targets
                .iter()
                .any(|db| text(db, "id") == id && number(db, "generation") == *generation)
        });
        let anchor = targets[0];
        if !state.loaded {
            state.cursor = self
                .k8s
                .read(
                    "ConfigMap",
                    Some("pgcf-system"),
                    &format!("storage-{}", text(anchor, "id")),
                )
                .await
                .ok()
                .flatten()
                .as_ref()
                .map(|v| {
                    text(
                        &v["metadata"]["annotations"],
                        key("MEASUREMENT_CURSOR_ANNOTATION"),
                    )
                    .to_string()
                })
                .unwrap_or_default();
            state.loaded = true;
        }
        let cohort = targets
            .iter()
            .filter(|db| text(db, "id") > state.cursor.as_str())
            .chain(
                targets
                    .iter()
                    .filter(|db| text(db, "id") <= state.cursor.as_str()),
            )
            .take(limit("MEASUREMENT_COHORT") as usize)
            .copied()
            .collect::<Vec<_>>();
        let cooled = |db: &Value, state: &State| {
            state
                .sampling
                .get(text(db, "id"))
                .is_some_and(|(generation, observed, _)| {
                    *generation == number(db, "generation")
                        && now().saturating_sub(*observed) < limit("MEASUREMENT_INTERVAL_MS")
                })
        };
        let candidates = cohort
            .iter()
            .filter(|db| {
                !cooled(db, state) || state.sampling.get(text(db, "id")).is_some_and(|v| v.2)
            })
            .copied()
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            if let Some(last) = cohort.last() {
                state.cursor = text(last, "id").into();
            }
            return Ok(());
        }
        let owner_results = stream::iter(candidates.into_iter().map(|db| self.owner(db)))
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
        let mut works = Vec::new();
        for work in owner_results.into_iter().flatten() {
            Self::remember(state, &work);
            works.push(work);
        }
        let replaying = works
            .iter()
            .filter(|work| !work.checkpoint["outbox"].as_array().unwrap().is_empty())
            .map(|work| text(&work.db, "id").to_string())
            .collect::<HashSet<_>>();
        let mut persisted = replaying.clone();
        let due = works
            .iter()
            .filter(|work| !cooled(&work.db, state) && !replaying.contains(text(&work.db, "id")))
            .map(|work| text(&work.db, "id").to_string())
            .collect::<HashSet<_>>();
        let snapshot = if due.is_empty() {
            None
        } else {
            self.controller.power.gateway_snapshot().await.ok()
        };
        let mut collected = HashMap::new();
        let mut storage_used = HashMap::new();
        let summaries: Summaries = Arc::new(Mutex::new(HashMap::new()));
        if let Some(snapshot) = &snapshot {
            let measured = stream::iter(
                works
                    .iter()
                    .filter(|work| due.contains(text(&work.db, "id")))
                    .map(|work| async {
                        let used = self.storage_used(work, &summaries).await;
                        (
                            text(&work.db, "id").to_string(),
                            used,
                            self.reports(&work.db, snapshot).await,
                        )
                    }),
            )
            .buffered(4)
            .collect::<Vec<_>>()
            .await;
            for (id, used, reports) in measured {
                storage_used.insert(id.clone(), used);
                if let Ok(reports) = reports {
                    collected.insert(id, reports);
                }
            }
            if self
                .controller
                .power
                .gateway_snapshot()
                .await
                .as_ref()
                .map_or(true, |current| !same_snapshot(snapshot, current))
            {
                collected.clear();
            }
        }
        let mut activities = Vec::new();
        for work in &mut works {
            let id = text(&work.db, "id").to_string();
            if !due.contains(&id) {
                continue;
            }
            let Some(reports) = collected.get(&id) else {
                work.checkpoint["gapSince"] = iso(now())?.into();
                remove(&mut work.checkpoint, "idleObservedSince");
                continue;
            };
            let snapshot = snapshot
                .as_ref()
                .ok_or("measurement snapshot unavailable")?;
            if work.checkpoint["baseline"]["reports"]
                .as_array()
                .is_some_and(|prior| {
                    prior.iter().any(|last| {
                        reports.iter().any(|report| {
                            report["pod"] == last["pod"]
                                && text(report, "observedAt") < text(last, "observedAt")
                        })
                    })
                })
            {
                work.checkpoint["gapSince"] = iso(now())?.into();
                remove(&mut work.checkpoint, "idleObservedSince");
                collected.remove(&id);
                continue;
            }
            let activity = advance(
                work,
                reports,
                snapshot,
                storage_used.get(&id).copied().flatten(),
                &self.process,
                now(),
            )?;
            if let Some(activity) = activity {
                activities.push(activity);
            }
        }
        let saved = stream::iter(works.into_iter().map(|mut work| {
            let save = due.contains(text(&work.db, "id"));
            async move {
                let success = !save || self.save(&mut work).await.is_ok();
                (work, save, success)
            }
        }))
        .buffered(4)
        .collect::<Vec<_>>()
        .await;
        works = Vec::new();
        for (work, saved, success) in saved {
            let id = text(&work.db, "id").to_string();
            if saved {
                if success {
                    persisted.insert(id.clone());
                } else {
                    collected.remove(&id);
                }
            }
            works.push(work);
        }
        let confirmed = stream::iter(
            works
                .iter()
                .filter(|work| collected.contains_key(text(&work.db, "id")))
                .map(|work| async {
                    let matched = self.owner(&work.db).await.is_ok_and(|fresh| {
                        fresh.checkpoint["identity"] == work.checkpoint["identity"]
                    });
                    (text(&work.db, "id").to_string(), matched)
                }),
        )
        .buffered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .filter_map(|(id, valid)| valid.then_some(id))
        .collect::<HashSet<_>>();
        for batch in batches(
            "databases",
            activities
                .into_iter()
                .filter(|v| confirmed.contains(text(v, "id")))
                .collect(),
        )? {
            if batch.iter().any(|v| {
                millis(&v["observed_at"]).map_or(true, |ms| {
                    ms < now().saturating_sub(limit("GATEWAY_ACTIVITY_FRESH_MS"))
                })
            }) {
                continue;
            }
            let _ = self.api.activity(&json!({"databases":batch})).await;
        }
        self.flush(&mut works, &persisted).await?;
        for work in &works {
            Self::remember(state, work);
        }
        if let Some(last) = cohort.last() {
            state.cursor = text(last, "id").into();
        }
        let name = format!("storage-{}", text(anchor, "id"));
        if let Ok(Some(resource)) = self.k8s.read("ConfigMap", Some("pgcf-system"), &name).await
            && owned(&resource, "ConfigMap", &name, Some("pgcf-system"), anchor).is_ok()
        {
            let _=self.k8s.patch(&resource,&json!({"metadata":{"annotations":{key("MEASUREMENT_CURSOR_ANNOTATION"):state.cursor}}})).await;
        }
        Ok(())
    }
}
fn advance(
    work: &mut Work,
    reports: &[Value],
    snapshot: &GatewaySnapshot,
    used: Option<u64>,
    process: &str,
    clock: u64,
) -> Result<Option<Value>, Error> {
    let db = &work.db;
    let checkpoint = &mut work.checkpoint;
    let now = iso(clock)?;
    let inventory = serde_json::to_value(&snapshot.pods)?;
    let prior = checkpoint["baseline"].clone();
    let previous = prior["reports"].as_array();
    let complete = reports.iter().all(history);
    let continuous = !prior.is_null()
        && prior["inventory"] == inventory
        && prior["keyUid"] == snapshot.key_uid
        && prior["keyVersion"] == snapshot.key_version;
    let monotonic = previous.is_none_or(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_none_or(|last| {
                    !same_epoch(last, report)
                        || [
                            "ingressBytes",
                            "egressBytes",
                            "totalConnections",
                            "connectionMilliseconds",
                        ]
                        .iter()
                        .all(|field| {
                            last[*field].is_null()
                                || report[*field].is_null()
                                || number(report, field) >= number(last, field)
                        })
                })
        })
    });
    let epochs_match = previous.is_some_and(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_some_and(|last| {
                    same_epoch(last, report) && last["revision"] == report["revision"]
                })
        })
    });
    let later = previous.is_some_and(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_some_and(|last| {
                    history(last) && text(report, "observedAt") > text(last, "observedAt")
                })
        })
    });
    let had_gap = !checkpoint["gapSince"].is_null();
    let gap_detected =
        !complete || (!prior.is_null() && (!continuous || !epochs_match)) || !monotonic;
    if gap_detected {
        checkpoint["gapSince"] = now.clone().into();
        remove(checkpoint, "idleObservedSince");
    }
    let oldest = reports
        .iter()
        .map(|v| text(v, "observedAt"))
        .min()
        .ok_or("measurement respondents missing")?;
    let recovered = complete
        && continuous
        && epochs_match
        && monotonic
        && later
        && !checkpoint["idleObservedSince"].is_null()
        && text(checkpoint, "idleObservedSince") <= oldest;
    if !checkpoint["gapSince"].is_null() && complete {
        if recovered {
            remove(checkpoint, "gapSince");
        } else if checkpoint["idleObservedSince"].is_null()
            && clock >= millis(&checkpoint["gapSince"])?
        {
            checkpoint["idleObservedSince"] = now.clone().into();
        }
    }
    let mut boundaries = reports
        .iter()
        .flat_map(|report| {
            [
                "startedAt",
                "counterStartedAt",
                "countersSince",
                "lastActivityAt",
            ]
            .iter()
            .filter_map(move |key| report[*key].as_str())
        })
        .collect::<Vec<_>>();
    if let Some(idle) = checkpoint["idleObservedSince"].as_str() {
        boundaries.push(idle);
    }
    let boundary = boundaries
        .into_iter()
        .max()
        .ok_or("measurement boundary unavailable")?;
    let mut activity = None;
    if complete && checkpoint["gapSince"].is_null() {
        let sum = |field: &str| -> Result<u64, Error> {
            reports
                .iter()
                .map(|report| integer(report, field))
                .try_fold(0u64, |sum, v| {
                    sum.checked_add(v?)
                        .filter(|v| *v <= 1_000_000)
                        .ok_or_else(|| "measurement count exceeds bound".into())
                })
        };
        let mut candidate = json!({"id":db["id"],"revision":db["generation"],"observed_at":reports.iter().map(|v|text(v,"observedAt")).max(),"last_activity_at":boundary,"connections":sum("connections")?,"busy_connections":sum("busyConnections")?,"pending_dials":sum("pendingDials")?,"expected_gateway_pods":snapshot.pods.iter().map(|pod|&pod.uid).collect::<Vec<_>>(),"reports":reports});
        if !checkpoint["idleObservedSince"].is_null() {
            candidate["idle_observed_since"] = checkpoint["idleObservedSince"].clone();
        }
        let process_epochs = reports
            .iter()
            .map(|v| text(v, "processEpoch"))
            .collect::<HashSet<_>>();
        let epochs = reports
            .iter()
            .map(|v| text(v, "epoch"))
            .collect::<HashSet<_>>();
        if process_epochs.len() == reports.len()
            && epochs.len() == reports.len()
            && number(&candidate, "busy_connections")
                .checked_add(number(&candidate, "pending_dials"))
                .is_some_and(|v| v <= 1_000_000)
            && schema_valid("AgentActivityRequest", &json!({"databases":[&candidate]}))
        {
            activity = Some(candidate);
        }
    }
    let mut pending = checkpoint["outbox"]
        .as_array()
        .ok_or("measurement outbox missing")?
        .clone();
    if let Some(previous) = previous {
        let mut expected = reports.iter().map(producer).collect::<Vec<_>>();
        expected.sort();
        for report in reports {
            if let Some(last) = previous.iter().find(|last| last["pod"] == report["pod"]) {
                pending.extend(differences(
                    last,
                    report,
                    &json!(expected),
                    continuous && ((!had_gap && !gap_detected) || recovered),
                )?);
            }
        }
    }
    let sample = json!({"database_id":db["id"],"source":"agent","producer_id":process,"sequence":clock,"observed_at":now,"storage_used_bytes":used,"storage_allocated_bytes":work.allocated});
    if !schema_valid("UsageSample", &sample) {
        return Err("measurement storage sample invalid".into());
    }
    pending.push(sample);
    let mut candidate = checkpoint.clone();
    candidate["outbox"] = json!(pending);
    if pending.len() <= limit("MEASUREMENT_MAX_OUTBOX") as usize
        && serde_json::to_vec(&candidate)?.len() <= limit("MEASUREMENT_CHECKPOINT_BYTES") as usize
    {
        checkpoint["outbox"] = candidate["outbox"].clone();
        checkpoint["baseline"] = json!({"sampledAt":now,"inventory":inventory,"keyUid":snapshot.key_uid,"keyVersion":snapshot.key_version,"reports":reports});
    }
    Ok(activity)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/measurements-vectors.generated.json"
        ))
        .unwrap()
    }
    #[test]
    fn authoritative_typescript_checkpoint_contract() {
        for value in vectors()["checkpoints"].as_array().unwrap() {
            let result = checkpoint(&json!({"data":value["data"]}), &value["identity"]);
            if value["rejected"] == true {
                assert!(result.is_err(), "{}", value["name"]);
            } else {
                assert_eq!(result.unwrap(), value["result"], "{}", value["name"]);
            }
        }
    }
    #[test]
    fn authoritative_typescript_counter_deltas_never_distribute_unknown_traffic() {
        for value in vectors()["differences"].as_array().unwrap() {
            assert_eq!(
                json!(
                    differences(
                        &value["previous"],
                        &value["current"],
                        &value["expected_producers"],
                        value["continuous"].as_bool().unwrap()
                    )
                    .unwrap()
                ),
                value["result"],
                "{}",
                value["name"]
            );
        }
    }
    fn snapshot(base: &Value) -> GatewaySnapshot {
        GatewaySnapshot {
            pods: serde_json::from_value(base["inventory"].clone()).unwrap(),
            active: "test".into(),
            keys: HashMap::new(),
            key_uid: text(base, "keyUid").into(),
            key_version: text(base, "keyVersion").into(),
        }
    }
    #[test]
    fn process_restart_requires_two_complete_observations_before_idle_recovers() {
        let vector = &vectors()["checkpoints"][1];
        let mut checkpoint = vector["result"].clone();
        let snapshot = snapshot(&checkpoint["baseline"]);
        let mut report = checkpoint["baseline"]["reports"][0].clone();
        report["processEpoch"] = "01234567-89ab-4def-8123-000000000004".into();
        report["epoch"] = "01234567-89ab-4def-8123-000000000005".into();
        report["startedAt"] = iso(120000).unwrap().into();
        report["counterStartedAt"] = iso(120000).unwrap().into();
        report["countersSince"] = iso(120000).unwrap().into();
        report["lastActivityAt"] = Value::Null;
        report["history"] = "current_process_absence".into();
        for field in [
            "ingressBytes",
            "egressBytes",
            "totalConnections",
            "connectionMilliseconds",
        ] {
            report[field] = 0.into();
        }
        report["observedAt"] = iso(130000).unwrap().into();
        assert!(report_valid(&report));
        let mut work = Work {
            db: json!({"id":report["database"],"generation":1,"storage":{"backend":"lvm-thin-v1"}}),
            resource: Value::Null,
            namespace: Value::Null,
            cluster: Value::Null,
            checkpoint: std::mem::take(&mut checkpoint),
            allocated: None,
            volume_identity: Value::Null,
        };
        assert!(
            advance(
                &mut work,
                &[report.clone()],
                &snapshot,
                None,
                "agent_test",
                130000
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(work.checkpoint["gapSince"], iso(130000).unwrap());
        assert_eq!(work.checkpoint["idleObservedSince"], iso(130000).unwrap());
        let sample = work.checkpoint["outbox"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert!(sample["storage_allocated_bytes"].is_null());
        assert!(sample["storage_used_bytes"].is_null());
        work.checkpoint["outbox"] = json!([]);
        report["observedAt"] = iso(145000).unwrap().into();
        let activity = advance(&mut work, &[report], &snapshot, None, "agent_test", 145000)
            .unwrap()
            .unwrap();
        assert!(work.checkpoint["gapSince"].is_null());
        assert_eq!(activity["last_activity_at"], iso(130000).unwrap());
        assert_eq!(activity["idle_observed_since"], iso(130000).unwrap());
        assert_eq!(activity["connections"], 0);
    }
    #[test]
    fn unknown_counters_or_impossible_counts_never_authorize_idle() {
        let mut report = vectors()["differences"][0]["current"].clone();
        report["connections"] = Value::Null;
        assert!(!report_valid(&report));
        report["connections"] = 0.into();
        report["busyConnections"] = 1.into();
        assert!(!report_valid(&report));
    }
    #[test]
    fn storage_gauge_requires_exact_pod_uid_and_fresh_complete_filesystem_facts() {
        let binding = json!({"node":"node-test","namespace":"pgcf-db-test","pod":"database-1","podUid":"01234567-89ab-4def-8123-000000000001","volume":"pgdata","claim":"database-1","allocated":4096});
        let mut summary = json!({"node":{"nodeName":"node-test"},"pods":[{"podRef":{"name":"database-1","namespace":"pgcf-db-test","uid":binding["podUid"]},"volume":[{"name":"pgdata","pvcRef":{"name":"database-1","namespace":"pgcf-db-test"},"time":iso(100000).unwrap(),"usedBytes":512,"capacityBytes":2048}]}]});
        assert_eq!(volume_used(&summary, &binding, 100001), Some(512));
        summary["pods"][0]["podRef"]["uid"] = "01234567-89ab-4def-8123-000000000002".into();
        assert_eq!(volume_used(&summary, &binding, 100001), None);
    }
}
