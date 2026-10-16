// SPDX-License-Identifier: Apache-2.0
//! Existing CNPG power and deletion execution; Cloudflare remains authoritative.
use crate::{
    Error,
    contracts::{constant, database_valid, generation, namespace, number, text},
    kubernetes::{Kubernetes, identifier, terminal_pod},
    postgres, timing,
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use futures_util::{StreamExt, stream};
use hmac::{Hmac, KeyInit, Mac};
use pgcf_native_protocol::{route::Keyring, valid_pattern, valid_schema, wire};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::{
    collections::{HashMap, HashSet},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const SYSTEM: &str = "pgcf-system";
/// The namespace OpenEBS keeps its LVMVolumes in.
const OPENEBS: &str = "openebs";
const DATABASE_LABEL: &str = "pgcf.io/database-id";
const GENERATION: &str = "pgcf.io/generation";
const POWER_REVISION: &str = "pgcf.io/power-revision";
const POWER_OPERATION: &str = "pgcf.io/power-operation";
const HIBERNATION: &str = "cnpg.io/hibernation";
/// CNPG's instance fence: a JSON list of instance names, `["*"]` for every instance.
const FENCE: &str = "cnpg.io/fencedInstances";
const FENCE_BINDING: &str = "pgcf.io/gateway-fence-uid";
const VOLUME_IDENTITY: &str = "pgcf.io/volume-identity";
const MAX_WAIT: u64 = 600_000;
/// How far ahead of this controller's clock a time it recorded may be: a clock step after the
/// write, not a forged record.
const CLOCK_SKEW: u64 = 5_000;
/// How long one sleep pass waits for the fenced PostgreSQL to be seen stopped.
const STOP_BUDGET: Duration = Duration::from_secs(5);
const MAX_SAFE: u64 = 9_007_199_254_740_991;
/// How long a release is asked again of a gateway that has not yet seen the intent it follows.
const RELEASE_RETRY_WINDOW: Duration = Duration::from_millis(150);
/// The pause between two asks of one release.
const RELEASE_RETRY_SPACING: Duration = Duration::from_millis(5);
mod parked;
use parked::{Resumed, Retained};
pub(crate) use parked::{fenced, runs_wake};
#[derive(Debug)]
enum Fault {
    Stale,
    Recovery(&'static str),
    Busy,
    Unavailable(&'static str),
}
impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Stale => "stale power intent",
            Self::Recovery(v) | Self::Unavailable(v) => v,
            Self::Busy => "database busy",
        })
    }
}
impl std::error::Error for Fault {}
impl From<Error> for Fault {
    /// A write the API server refused says how: a conflict, a refusal of an admission webhook,
    /// a server that failed (the operator's webhooks being down is one). The rest is unavailable.
    fn from(error: Error) -> Self {
        Self::Unavailable(
            match error
                .downcast_ref::<crate::kubernetes::KubernetesError>()
                .map(|refused| refused.status)
            {
                Some(409) => "kubernetes_conflict",
                Some(500..=599) => "kubernetes_server_error",
                Some(400..=499) => "kubernetes_rejected",
                _ => "power_step_unavailable",
            },
        )
    }
}
type Result<T> = std::result::Result<T, Fault>;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PowerIntent {
    pub database: String,
    pub operation: String,
    pub revision: u64,
    pub mode: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPod {
    pub name: String,
    pub uid: String,
    pub ip: String,
    pub restarts: u64,
}
pub struct GatewaySnapshot {
    pub pods: Vec<GatewayPod>,
    pub active: String,
    pub keys: HashMap<String, Vec<u8>>,
    pub key_uid: String,
    pub key_version: String,
}
impl GatewaySnapshot {
    fn same_identity(&self, other: &Self) -> bool {
        self.pods == other.pods
            && self.key_uid == other.key_uid
            && self.key_version == other.key_version
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Anchor {
    storage_uid: String,
    storage_state: String,
    volume_identity: String,
    physical_generation: u64,
    namespace_uid: String,
    cluster_uid: String,
    node: String,
    archive_path: String,
    claim_name: String,
    claim_uid: String,
    volume_name: String,
    volume_uid: String,
    handle: String,
    affinity: String,
    lvm_name: String,
    lvm_namespace: String,
    lvm_uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    storage: Option<Value>,
}
impl Anchor {
    fn matches(&self, other: &Self) -> bool {
        let mut a = serde_json::to_value(self).unwrap();
        let mut b = serde_json::to_value(other).unwrap();
        for field in ["storageState", "volumeIdentity", "affinity"] {
            for value in [&mut a, &mut b] {
                let Some(raw) = value[field].as_str() else {
                    return false;
                };
                let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
                    return false;
                };
                value[field] = parsed;
            }
        }
        a == b
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Quiescing,
    Switching,
    Archive,
    Proved,
    Hibernating,
    Hibernated,
    Wake,
    Awake,
    Refused,
    /// The fence is written and the stop of PostgreSQL is being confirmed (parked sleep tier).
    Parking,
    /// PostgreSQL is stopped by CNPG's fence; the instance Pod stays (parked sleep tier).
    Parked,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Refusal {
    Busy,
    Archive,
    Unknown,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    target: PowerIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proof_intent: Option<PowerIntent>,
    phase: Phase,
    started_at: u64,
    anchor: Anchor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refusal: Option<Refusal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gateways: Option<Vec<GatewayPod>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    segment: Option<String>,
    /// The retained instance Pod of a parked database, from `Parking` until its demotion ends.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    park: Option<Park>,
    /// The data directory the proof of the sleep found PostgreSQL running on; `None` if it could
    /// not be read, which only keeps the Pod from being parked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system: Option<SystemIdentity>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}
/// The data directory a postmaster runs on: the system identifier of its `pg_control` and the
/// timeline of its latest checkpoint (see `postgres::SERVER_IDENTITY_QUERY`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SystemIdentity {
    pub(crate) identifier: String,
    pub(crate) timeline: i32,
}
impl SystemIdentity {
    /// What a row of `SERVER_IDENTITY_QUERY` or of `ACCEPTING_QUERY` says; `None` if it says none.
    pub(crate) fn of(row: &tokio_postgres::Row) -> Option<Self> {
        let identifier = row.try_get::<_, String>("system_identifier").ok()?;
        let timeline = row.try_get::<_, i32>("timeline").ok()?;
        Self::valid(&identifier, timeline).then_some(Self {
            identifier,
            timeline,
        })
    }
    /// An identifier is the 64-bit number `initdb` drew, in decimal; timelines count from 1.
    fn valid(identifier: &str, timeline: i32) -> bool {
        (1..=20).contains(&identifier.len())
            && identifier.bytes().all(|b| b.is_ascii_digit())
            && timeline >= 1
    }
}
impl Progress {
    fn new(target: PowerIntent, phase: Phase, anchor: Anchor, now: u64) -> Self {
        Self {
            target,
            proof_intent: None,
            phase,
            started_at: now,
            anchor,
            refusal: None,
            gateways: None,
            key_uid: None,
            key_version: None,
            segment: None,
            park: None,
            system: None,
            extra: Map::new(),
        }
    }
}
/// One container's resource requests as Kubernetes quantity strings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ContainerRequests {
    pub(crate) cpu: String,
    pub(crate) memory: String,
}
/// The requests of the two containers the parked tier resizes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Requests {
    pub(crate) postgres: ContainerRequests,
    pub(crate) sidecar: ContainerRequests,
}
/// The instance Pod a parked database keeps: the identity a wake or a demotion must find again.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Park {
    pod_name: String,
    pod_uid: String,
    /// Container IDs of `postgres` and the `plugin-barman-cloud` sidecar.
    postgres_container_id: String,
    sidecar_container_id: String,
    node_boot_id: String,
    release_id: String,
    spec_sha256: String,
    assignment_revision: u64,
    requests_before: Requests,
    requests_parked: Requests,
    parked_at: u64,
    /// The data directory PostgreSQL ran on when the sleep was proved: the postmaster a wake starts
    /// must answer with the same. A record without them is never resumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    system_identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeline: Option<i32>,
    /// PostgreSQL was seen stopped and fenced: nothing can have been written since, whatever
    /// gateway Pods came and went. Set when the Pod is parked, not while it is being parked.
    stopped: bool,
}
impl Park {
    /// The data directory the Pod was parked with, if the record has one.
    fn system(&self) -> Option<SystemIdentity> {
        Some(SystemIdentity {
            identifier: self.system_identifier.clone()?,
            timeline: self.timeline?,
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteVolume {
    name: String,
    uid: String,
    claim_uid: String,
    handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lvm: Option<LvmIdentity>,
}
#[derive(Clone, Serialize, Deserialize)]
struct LvmIdentity {
    name: String,
    namespace: String,
    uid: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteState {
    started_at: u64,
    namespace_uid: Option<String>,
    volumes: Vec<DeleteVolume>,
    completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    physical_lv_uuid: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RetirementReceipt {
    marker_uid: String,
    intent: PowerIntent,
    published_at: String,
    observed_at: String,
    phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    marker_version: Option<String>,
}
/// What a retained Pod is judged against, for a sleep as for a wake: the node and the fleet
/// release it must still be under, and the manifests the desired state would apply to it.
pub struct Basis<'a> {
    pub node: &'a Value,
    pub release: &'a Value,
    /// The manifests desired state would apply; `None` when they cannot be built.
    pub manifests: Option<&'a [Value]>,
    pub runtime_class: &'a str,
}
/// What the sleep step needs from the regional snapshot and the database's Node.
pub struct Sleep<'a> {
    /// `region.parking`; null while the region has no parked sleep tier.
    pub parking: &'a Value,
    pub basis: Basis<'a>,
    /// The pool slot that serves the database, which the sleep is proved on instead of the
    /// database's own Pod.
    pub slot: Option<SlotSleep>,
}
/// The pool slot a slot-served database sleeps from.
pub struct SlotSleep {
    /// Where the proof's session dials: the slot Pod's address and port.
    pub pod: std::net::SocketAddr,
    /// The slot's own service name its certificate is verified under.
    pub tls_name: String,
    /// The slot was retired: fenced, recorded, deleted and its volume released.
    pub gone: bool,
}
#[cfg(test)]
static NOTHING: Value = Value::Null;
#[cfg(test)]
impl Basis<'static> {
    /// Nothing is known of the retained Pod's surroundings: it is never judged fit to resume.
    fn cold() -> Self {
        Self {
            node: &NOTHING,
            release: &NOTHING,
            manifests: None,
            runtime_class: "",
        }
    }
}
#[cfg(test)]
impl Sleep<'static> {
    /// A region without the parked sleep tier: every idle sleep is a real hibernation.
    fn cold() -> Self {
        Self {
            parking: &NOTHING,
            basis: Basis::cold(),
            slot: None,
        }
    }
}
/// The identity of the retained Pod that a fast wake resumed; the verification chain must find it.
pub struct ParkedWake {
    pub pod_name: String,
    pub pod_uid: String,
    pub postgres_container_id: String,
    pub sidecar_container_id: String,
    /// The `postgres` container's restarts when the fence was lifted; `None` if the Pod could not
    /// be read then, which no later read can equal.
    pub postgres_restarts: Option<u64>,
    /// The Pod's address as the inspection read it before the fence was lifted.
    pub pod_ip: Option<String>,
    /// The data directory the Pod was parked with: the postmaster that answers must run on it.
    pub(crate) system: SystemIdentity,
    /// The requests the Pod is resized back to; the wake is verified only once they are actuated.
    pub(crate) requests_before: Requests,
    /// Taken before the unfence was sent: a postmaster older than this did not start for it.
    pub started: std::time::Instant,
}
pub enum PrepareRunning {
    Proceed,
    Pending,
    Observation(Value),
    /// The fence was lifted on the retained Pod: PostgreSQL starts on it.
    Parked(Box<ParkedWake>),
}
pub struct PowerCoordinator {
    k8s: Kubernetes,
    region: String,
    replicas: usize,
    pub(crate) http: reqwest::Client,
    /// Where PostgreSQL clients dial instead of the Pod's address and port 5432. Only a test
    /// double sets it.
    pub(crate) postgres: Option<std::net::SocketAddr>,
    /// How long a sleep waits for PostgreSQL to be seen stopped after it fenced the instance.
    pub(crate) stop_budget: Duration,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// The kubelet's Ready bit of a database's resumed Pod, which its wake did not wait for, by
    /// database id: the measurement that ends when a later pass finds the bit set.
    kubelet: Mutex<HashMap<String, parked::KubeletWait>>,
    /// The node agents that hold the single-writer rule of thin volumes (pool design 2026-10-16).
    pub(crate) attach: crate::pool::Attach,
    /// The image a database runs under unless it names one.
    pub(crate) postgres_image: String,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn required(value: &str, max: usize) -> Result<&str> {
    if value.is_empty() || value.len() > max {
        Err(Fault::Recovery("power_identity_missing"))
    } else {
        Ok(value)
    }
}
fn uid(resource: &Value) -> Result<&str> {
    required(text(&resource["metadata"], "uid"), 253)
}
fn rv(resource: &Value) -> Result<&str> {
    required(text(&resource["metadata"], "resourceVersion"), 128)
}
fn annotation_number(value: &Value, key: &str) -> Result<Option<u64>> {
    let Some(raw) = value["metadata"]["annotations"].get(key) else {
        return Ok(None);
    };
    let raw = raw
        .as_str()
        .ok_or(Fault::Recovery("resource_generation_annotation_invalid"))?;
    let parsed = raw
        .parse::<u64>()
        .map_err(|_| Fault::Recovery("resource_generation_annotation_invalid"))?;
    if parsed == 0 || parsed > MAX_SAFE || parsed.to_string() != raw {
        return Err(Fault::Recovery("resource_generation_annotation_invalid"));
    }
    Ok(Some(parsed))
}
fn owned(
    resource: Option<Value>,
    name: &str,
    database: &str,
    scope: Option<&str>,
    deleting: bool,
) -> Result<Value> {
    let resource = resource.ok_or(Fault::Recovery(
        "established_database_resource_missing_or_replaced",
    ))?;
    if text(&resource["metadata"], "name") != name
        || resource["metadata"]["namespace"].as_str() != scope
        || text(&resource["metadata"]["labels"], DATABASE_LABEL) != database
        || (!deleting && !resource["metadata"]["deletionTimestamp"].is_null())
    {
        return Err(Fault::Recovery(
            "established_database_resource_missing_or_replaced",
        ));
    }
    uid(&resource)?;
    rv(&resource)?;
    for key in [GENERATION, "pgcf.io/accepted-generation", POWER_REVISION] {
        annotation_number(&resource, key)?;
    }
    Ok(resource)
}
fn parse_intent(value: &Value) -> Result<PowerIntent> {
    if !valid_schema("intent", value) {
        return Err(Fault::Recovery("gateway_fence_invalid"));
    }
    serde_json::from_value(value.clone()).map_err(|_| Fault::Recovery("gateway_fence_invalid"))
}
fn intent_from(map: &Value, database: &str) -> Result<PowerIntent> {
    if map["metadata"]["labels"][wire("fenceLabel")] != "true" {
        return Err(Fault::Recovery("gateway_fence_ownership_invalid"));
    }
    let text = required(text(&map["data"], "intent.json"), 1024)?;
    let parsed: Value =
        serde_json::from_str(text).map_err(|_| Fault::Recovery("gateway_fence_invalid"))?;
    let intent = parse_intent(&parsed)?;
    if intent.database != database {
        return Err(Fault::Recovery("gateway_fence_invalid"));
    }
    Ok(intent)
}
pub fn desired_power(db: &Value) -> std::result::Result<Option<PowerIntent>, Error> {
    if db["power"].is_null() {
        return Ok(None);
    }
    let raw = &db["power"];
    let intent = parse_intent(
        &json!({"database":text(db,"id"),"operation":raw["operation"],"revision":raw["revision"],"mode":raw["mode"]}),
    )?;
    if intent.revision != number(db, "generation")
        || !(raw["reason"].is_null() || matches!(raw["reason"].as_str(), Some("manual" | "idle")))
        || (if intent.mode == "quiesce" {
            text(db, "desired_state") != "suspended"
        } else {
            text(db, "desired_state") != "running"
        })
    {
        return Err(Fault::Recovery("power_intent_invalid").into());
    }
    Ok(Some(intent))
}
fn private_ip(value: &str) -> Result<String> {
    let ip: IpAddr = value
        .parse()
        .map_err(|_| Fault::Unavailable("gateway_private_address_unavailable"))?;
    let valid = match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
        }
        IpAddr::V6(v) => (v.octets()[0] & 0xfe) == 0xfc,
    };
    if !valid {
        return Err(Fault::Unavailable("gateway_private_address_unavailable"));
    }
    Ok(value.to_string())
}
fn decode(value: &str, max: usize) -> Result<String> {
    if value.len() > max {
        return Err(Fault::Unavailable("protected_credentials_unavailable"));
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| Fault::Unavailable("protected_credentials_unavailable"))?;
    if STANDARD.encode(&bytes) != value {
        return Err(Fault::Unavailable("protected_credentials_unavailable"));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| Fault::Unavailable("protected_credentials_unavailable"))?;
    if text.is_empty() || text.contains('\0') {
        return Err(Fault::Unavailable("protected_credentials_unavailable"));
    }
    Ok(text)
}
fn segment(value: &str) -> bool {
    value.len() == 24
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(&v))
}
fn iso(value: u64) -> Result<String> {
    let value = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(value) * 1_000_000)
        .map_err(|_| Fault::Recovery("power_clock_invalid"))?;
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
fn timestamp(text: &str, now: u64) -> Result<u64> {
    let parsed = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .map_err(|_| Fault::Recovery("gateway_retirement_recovery_required"))?;
    let millis: u64 = (parsed.unix_timestamp_nanos() / 1_000_000)
        .try_into()
        .map_err(|_| Fault::Recovery("gateway_retirement_recovery_required"))?;
    if millis > now || iso(millis)? != text {
        return Err(Fault::Recovery("gateway_retirement_recovery_required"));
    }
    Ok(millis)
}
fn progress_from(map: &Value, now: u64) -> Result<Option<Progress>> {
    let Some(raw) = map["data"]["power.json"].as_str() else {
        if !map["data"]["power.json"].is_null() {
            return Err(Fault::Recovery("power_progress_invalid"));
        }
        return Ok(None);
    };
    if raw.len() > 16384 {
        return Err(Fault::Recovery("power_progress_invalid"));
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|_| Fault::Recovery("power_progress_invalid"))?;
    parse_intent(&value["target"])?;
    let p: Progress =
        serde_json::from_value(value).map_err(|_| Fault::Recovery("power_progress_invalid"))?;
    if p.started_at > now || p.started_at > MAX_SAFE || p.anchor.physical_generation == 0 {
        return Err(Fault::Recovery("power_progress_invalid"));
    }
    for text in [
        &p.anchor.storage_uid,
        &p.anchor.storage_state,
        &p.anchor.volume_identity,
        &p.anchor.namespace_uid,
        &p.anchor.cluster_uid,
        &p.anchor.node,
        &p.anchor.archive_path,
        &p.anchor.claim_name,
        &p.anchor.claim_uid,
        &p.anchor.volume_name,
        &p.anchor.volume_uid,
        &p.anchor.handle,
        &p.anchor.lvm_name,
        &p.anchor.lvm_namespace,
        &p.anchor.lvm_uid,
    ] {
        required(text, 4096)?;
    }
    if p.anchor.affinity.len() > 4096 || p.segment.as_ref().is_some_and(|v| !segment(v)) {
        return Err(Fault::Recovery("power_progress_invalid"));
    }
    if let Some(intent) = &p.proof_intent {
        parse_intent(&serde_json::to_value(intent).unwrap())?;
        if intent.mode != "quiesce"
            || intent.database != p.target.database
            || intent.revision > p.target.revision
        {
            return Err(Fault::Recovery("power_proof_origin_invalid"));
        }
    }
    if matches!(
        p.phase,
        Phase::Archive
            | Phase::Proved
            | Phase::Hibernating
            | Phase::Hibernated
            | Phase::Parking
            | Phase::Parked
    ) && (p.segment.is_none() || p.proof_intent.is_none())
    {
        return Err(Fault::Recovery("power_segment_missing"));
    }
    match &p.park {
        None if matches!(p.phase, Phase::Parking | Phase::Parked) => {
            return Err(Fault::Recovery("power_park_missing"));
        }
        Some(_)
            if !matches!(
                p.phase,
                Phase::Parking | Phase::Parked | Phase::Hibernating | Phase::Wake
            ) =>
        {
            return Err(Fault::Recovery("power_park_invalid"));
        }
        Some(park) => {
            for text in [
                &park.pod_name,
                &park.postgres_container_id,
                &park.sidecar_container_id,
                &park.node_boot_id,
                &park.release_id,
                &park.spec_sha256,
            ] {
                required(text, 4096)?;
            }
            if !valid_pattern("uuid", &park.pod_uid)
                || park.system_identifier.is_some() != park.timeline.is_some()
                || park.system().is_some_and(|system| {
                    !SystemIdentity::valid(&system.identifier, system.timeline)
                })
                || park.parked_at > now.saturating_add(CLOCK_SKEW)
                || park.parked_at > MAX_SAFE
                || park.assignment_revision > MAX_SAFE
            {
                return Err(Fault::Recovery("power_park_invalid"));
            }
        }
        None => {}
    }
    if let Some(gateways) = &p.gateways {
        validate_pods(gateways)?;
        required(p.key_uid.as_deref().unwrap_or(""), 253)?;
        required(p.key_version.as_deref().unwrap_or(""), 128)?;
    }
    if matches!(
        p.phase,
        Phase::Switching
            | Phase::Archive
            | Phase::Proved
            | Phase::Hibernating
            | Phase::Hibernated
            | Phase::Parking
            | Phase::Parked
    ) && p.gateways.is_none()
    {
        return Err(Fault::Recovery("power_continuity_missing"));
    }
    Ok(Some(p))
}
fn validate_pods(pods: &[GatewayPod]) -> Result<()> {
    if pods.is_empty() || pods.len() > 64 {
        return Err(Fault::Unavailable("gateway_inventory_incomplete"));
    }
    let mut ids = HashSet::new();
    for pod in pods {
        required(&pod.name, 253)?;
        if !valid_pattern("uuid", &pod.uid) || pod.restarts > MAX_SAFE || !ids.insert(&pod.uid) {
            return Err(Fault::Unavailable("gateway_inventory_invalid"));
        }
        private_ip(&pod.ip)?;
    }
    Ok(())
}
fn observation(db: &Value, intent: &PowerIntent, state: &str, refusal: Option<Refusal>) -> Value {
    let mut value = json!({"id":db["id"],"generation":db["generation"],"state":if refusal.is_some(){"error"}else if state=="hibernated"{"hibernated"}else{"ready"},"archive":{"continuous":false,"ready_wal_files":null},"power":{"operation":intent.operation,"revision":intent.revision,"state":state}});
    if let Some(refusal) = refusal {
        let text = serde_json::to_value(refusal).unwrap();
        value["power"]["refusal"] = text.clone();
        value["message"] = format!("sleep refused: {}", text.as_str().unwrap()).into();
    }
    value
}
/// A hibernated observation whose instance Pod is still alive with PostgreSQL stopped. `fast`
/// claims that the Pod's wake is the fast one: every predicate of it was just established.
fn parked_observation(
    db: &Value,
    intent: &PowerIntent,
    pod_uid: &str,
    cpu_millicores: u64,
    memory_mib: u64,
    fast: bool,
) -> Value {
    let mut value = observation(db, intent, "hibernated", None);
    value["power"]["parked"] =
        json!({"pod_uid":pod_uid,"cpu_millicores":cpu_millicores,"memory_mib":memory_mib});
    if fast {
        value["power"]["parked"]["wake"] = "fast".into();
    }
    value
}
fn recovery_observation(db: &Value, message: &str) -> Value {
    json!({"id":db["id"],"generation":db["generation"],"state":"error","message":format!("{message}; recovery required"),"archive":{"continuous":false,"ready_wal_files":null}})
}
impl PowerCoordinator {
    pub fn region(&self) -> &str {
        &self.region
    }
    pub fn new(
        k8s: Kubernetes,
        region: String,
        replicas: usize,
    ) -> std::result::Result<Self, Error> {
        Self::with_clock(k8s, region, replicas, Arc::new(now))
    }
    pub fn with_clock(
        k8s: Kubernetes,
        region: String,
        replicas: usize,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    ) -> std::result::Result<Self, Error> {
        if !valid_pattern("region", &region) || replicas == 0 || replicas > 64 {
            return Err("power coordinator configuration invalid".into());
        }
        let http = crate::cluster_http(Duration::from_secs(3))?;
        Ok(Self {
            k8s: k8s.clone(),
            region,
            replicas,
            http,
            postgres: None,
            stop_budget: STOP_BUDGET,
            clock,
            kubelet: Mutex::default(),
            attach: crate::pool::Attach::new(k8s.clone())?,
            postgres_image: String::new(),
        })
    }
    fn now(&self) -> u64 {
        (self.clock)()
    }
    async fn anchor(&self, db: &Value) -> Result<(Anchor, Value)> {
        let id = text(db, "id");
        let ns = namespace(db);
        let storage_name = format!("storage-{id}");
        let (ns_value, cluster_value, storage_value) = tokio::try_join!(
            self.k8s.read_known("Namespace", None, &ns),
            self.k8s.read_known("Cluster", Some(&ns), "database"),
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &storage_name),
        )?;
        let ns_value = owned(ns_value, &ns, id, None, false)?;
        let cluster = owned(cluster_value, "database", id, Some(&ns), false)?;
        let storage = owned(storage_value, &storage_name, id, Some(SYSTEM), false)?;
        if generation(&storage) > number(db, "generation") {
            return Err(Fault::Stale);
        }
        let stored_text = required(text(&storage["data"], "state"), 4096)?;
        let stored: Value = serde_json::from_str(stored_text)
            .map_err(|_| Fault::Recovery("storage_identity_changed"))?;
        if stored["namespaceUid"] != uid(&ns_value)?
            || stored["clusterUid"] != uid(&cluster)?
            || stored["node"] != db["node"]
            || stored["archivePath"] != db["archive"]["destination_path"]
        {
            return Err(Fault::Recovery("storage_identity_changed"));
        }
        let storage_profile = if db["storage"].is_null() {
            None
        } else {
            Some(db["storage"].clone())
        };
        if stored.get("storage").filter(|v| !v.is_null()) != storage_profile.as_ref() {
            return Err(Fault::Recovery("storage_profile_identity_changed"));
        }
        let storage_class = storage_class(db)?;
        // The volume and its LVMVolume are read by the handle the receipt recorded: OpenEBS names
        // the PersistentVolume and the LVMVolume after the volume ID. They are read together with
        // the Node, and judged below in the order the checks always had.
        let recorded = serde_json::from_str::<Value>(text(
            &storage["metadata"]["annotations"],
            VOLUME_IDENTITY,
        ))
        .ok()
        .and_then(|identity| {
            let handle = text(&identity, "handle");
            identifier(handle).then(|| handle.to_string())
        });
        // The Node, the volume and the LVMVolume are only compared with the identity the receipt
        // recorded, so their versions do not matter: they come from the watch cache.
        let (node, volume, lvm) = tokio::try_join!(
            async {
                match &storage_profile {
                    Some(_) => {
                        self.k8s
                            .read_known_cached("Node", None, text(db, "node"))
                            .await
                    }
                    None => Ok(None),
                }
            },
            async {
                match &recorded {
                    Some(handle) => {
                        self.k8s
                            .read_known_cached("PersistentVolume", None, handle)
                            .await
                    }
                    None => Ok(None),
                }
            },
            async {
                match &recorded {
                    Some(handle) => {
                        self.k8s
                            .read_known_cached("LVMVolume", Some(OPENEBS), handle)
                            .await
                    }
                    None => Ok(None),
                }
            },
        )?;
        if let Some(profile) = &storage_profile {
            let node = node.ok_or(Fault::Recovery("storage_node_identity_changed"))?;
            if node["metadata"]["uid"] != profile["node_uid"] {
                return Err(Fault::Recovery("storage_node_identity_changed"));
            }
        }
        let archive_path = text(&db["archive"], "destination_path");
        let physical_generation = archive_path
            .rsplit('/')
            .next()
            .and_then(|v| v.strip_prefix('g'))
            .and_then(|v| v.split_once('-'))
            .and_then(|(v, _)| v.parse::<u64>().ok())
            .filter(|v| *v > 0)
            .ok_or(Fault::Recovery("archive_identity_invalid"))?;
        let volume_text = required(
            text(&storage["metadata"]["annotations"], VOLUME_IDENTITY),
            4096,
        )?;
        let identity: Value = serde_json::from_str(volume_text)
            .map_err(|_| Fault::Recovery("persistent_volume_identity_changed"))?;
        if recorded.is_none() {
            return Err(Fault::Recovery("persistent_volume_identity_changed"));
        }
        let Some(volume) = volume.filter(|v| v["metadata"]["uid"] == identity["volumeUid"]) else {
            return Err(Fault::Recovery("persistent_volume_missing_or_replaced"));
        };
        let volume = &volume;
        let spec = &volume["spec"];
        let reference = &spec["claimRef"];
        let handle = required(text(&spec["csi"], "volumeHandle"), 253)?;
        let claim_name = required(text(reference, "name"), 253)?;
        if !volume["metadata"]["deletionTimestamp"].is_null()
            || reference["namespace"] != ns
            || reference["uid"] != identity["claimUid"]
            || identity["handle"] != handle
            || spec["csi"]["driver"] != "local.csi.openebs.io"
            || spec["storageClassName"] != storage_class
            || volume["status"]["phase"] != "Bound"
        {
            return Err(Fault::Recovery("persistent_volume_identity_changed"));
        }
        let claim = self
            .k8s
            .read_known_cached("PersistentVolumeClaim", Some(&ns), claim_name)
            .await?
            .ok_or(Fault::Recovery("persistent_claim_missing_or_replaced"))?;
        if claim["metadata"]["uid"] != identity["claimUid"]
            || !claim["metadata"]["deletionTimestamp"].is_null()
            || claim["spec"]["volumeName"] != volume["metadata"]["name"]
            || claim["status"]["phase"] != "Bound"
            || claim["spec"]["storageClassName"] != storage_class
        {
            return Err(Fault::Recovery("persistent_claim_missing_or_replaced"));
        }
        let Some(lvm) = lvm.filter(|v| v["metadata"]["deletionTimestamp"].is_null()) else {
            return Err(Fault::Recovery("lvm_volume_missing_or_replaced"));
        };
        let lvm = &lvm;
        let revision = cluster["metadata"]["annotations"][POWER_REVISION]
            .as_str()
            .map(|v| v.parse::<u64>())
            .transpose()
            .map_err(|_| Fault::Stale)?
            .unwrap_or(0);
        if revision > number(db, "generation") {
            return Err(Fault::Stale);
        }
        let anchor = Anchor {
            storage_uid: uid(&storage)?.into(),
            storage_state: stored_text.into(),
            volume_identity: volume_text.into(),
            physical_generation,
            namespace_uid: uid(&ns_value)?.into(),
            cluster_uid: uid(&cluster)?.into(),
            node: text(db, "node").into(),
            archive_path: archive_path.into(),
            claim_name: claim_name.into(),
            claim_uid: uid(&claim)?.into(),
            volume_name: text(&volume["metadata"], "name").into(),
            volume_uid: uid(volume)?.into(),
            handle: handle.into(),
            affinity: serde_json::to_string(&spec["nodeAffinity"]).unwrap(),
            lvm_name: text(&lvm["metadata"], "name").into(),
            lvm_namespace: required(text(&lvm["metadata"], "namespace"), 253)?.into(),
            lvm_uid: uid(lvm)?.into(),
            storage: storage_profile,
        };
        Ok((anchor, cluster))
    }
    async fn fence(&self, db: &Value) -> Result<Option<Value>> {
        let id = text(db, "id");
        let name = format!("gateway-fence-{id}");
        let storage_name = format!("storage-{id}");
        let (map, storage) = tokio::try_join!(
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &name),
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &storage_name)
        )?;
        if let Some(expected) = storage
            .as_ref()
            .and_then(|v| v["metadata"]["annotations"][FENCE_BINDING].as_str())
            && map
                .as_ref()
                .is_none_or(|v| v["metadata"]["uid"] != expected)
        {
            return Err(Fault::Recovery("gateway_fence_missing_or_replaced"));
        }
        let Some(map) = map else {
            return Ok(None);
        };
        self.fence_checked(db, map).map(Some)
    }
    /// The gateway fence `map` as the database's own, at no revision beyond the desired one.
    fn fence_checked(&self, db: &Value, map: Value) -> Result<Value> {
        let id = text(db, "id");
        let map = owned(
            Some(map),
            &format!("gateway-fence-{id}"),
            id,
            Some(SYSTEM),
            false,
        )?;
        let intent = intent_from(&map, id)?;
        if intent.revision > number(db, "generation") {
            return Err(Fault::Stale);
        }
        Ok(map)
    }
    async fn write(
        &self,
        db: &Value,
        map: Option<&Value>,
        intent: Option<&PowerIntent>,
        progress: &Progress,
    ) -> Result<Value> {
        let id = text(db, "id");
        let name = format!("gateway-fence-{id}");
        let progress_text = serde_json::to_string(progress)
            .map_err(|_| Fault::Recovery("power_progress_invalid"))?;
        if progress_text.len() > 16384 {
            return Err(Fault::Recovery("power_progress_overflow"));
        }
        let mut data = map
            .and_then(|m| m["data"].as_object())
            .cloned()
            .unwrap_or_default();
        if let Some(intent) = intent {
            data.insert(
                "intent.json".into(),
                serde_json::to_string(intent).unwrap().into(),
            );
        }
        data.insert("power.json".into(), progress_text.clone().into());
        // What the write answers is the fence as it was written: it is not read again.
        let written = if let Some(map) = map {
            let prior = intent_from(map, id)?;
            let superseded = unconfirmed_pool_release(map, &prior, self.now());
            if intent.is_some_and(|next| {
                next.revision < prior.revision
                    || (next.revision == prior.revision && *next != prior && !superseded)
            }) || progress_from(map, self.now())?
                .is_some_and(|prior| prior.target.revision > progress.target.revision)
            {
                return Err(Fault::Stale);
            }
            // A write that would change nothing is not made: it would still make the cluster's
            // watch deliver it.
            if map["data"].as_object() == Some(&data) {
                return Ok(map.clone());
            }
            self.k8s.patch(map, &json!({"data":data})).await?
        } else {
            if intent.is_none() {
                return Err(Fault::Recovery("gateway_fence_missing"));
            }
            self.k8s.create(&json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"labels":{DATABASE_LABEL:id,wire("fenceLabel"):"true"}},"data":data})).await?
        };
        let next = self.fence_checked(db, written)?;
        if map.is_some_and(|prior| prior["metadata"]["uid"] != next["metadata"]["uid"])
            || text(&next["data"], "power.json") != progress_text
        {
            return Err(Fault::Stale);
        }
        Ok(next)
    }
    async fn bind_fence(&self, db: &Value, map: &Value) -> Result<()> {
        let id = text(db, "id");
        let name = format!("storage-{id}");
        let storage = owned(
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &name)
                .await?,
            &name,
            id,
            Some(SYSTEM),
            false,
        )?;
        if generation(&storage) > number(db, "generation") {
            return Err(Fault::Stale);
        }
        if let Some(previous) = storage["metadata"]["annotations"][FENCE_BINDING].as_str() {
            if previous != uid(map)? {
                return Err(Fault::Recovery("gateway_fence_replaced"));
            }
            return Ok(());
        }
        let result = self
            .k8s
            .patch(
                &storage,
                &json!({"metadata":{"annotations":{FENCE_BINDING:uid(map)?}}}),
            )
            .await?;
        if result["metadata"]["annotations"][FENCE_BINDING] != uid(map)? {
            return Err(Fault::Unavailable("fence_binding_unknown"));
        }
        Ok(())
    }
    async fn gateways(&self) -> Result<Vec<GatewayPod>> {
        // Node shutdown leaves terminal Pods behind: no connections, controls or replica count.
        // The list is the cache's: a replica that appeared in the last few milliseconds is a
        // replica that has loaded its fence from the persisted record itself, and the set is
        // compared again after the acknowledgements.
        let resources: Vec<_> = self
            .k8s
            .list_cached(
                "Pod",
                Some(SYSTEM),
                Some("app.kubernetes.io/name=pgcf-gateway"),
            )
            .await?
            .into_iter()
            .filter(|pod| !terminal_pod(pod))
            .collect();
        if resources.len() < self.replicas || resources.len() > 64 {
            return Err(Fault::Unavailable("gateway_inventory_incomplete"));
        }
        let mut pods = Vec::new();
        for pod in resources {
            if pod["kind"] != "Pod"
                || pod["metadata"]["namespace"] != SYSTEM
                || pod["metadata"]["labels"]["app.kubernetes.io/name"] != "pgcf-gateway"
                || pod["spec"]["serviceAccountName"] != "pgcf-gateway"
            {
                return Err(Fault::Unavailable("gateway_inventory_invalid"));
            }
            let statuses: Vec<_> = pod["status"]["containerStatuses"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v["name"] == "gateway")
                .collect();
            if statuses.len() != 1 {
                return Err(Fault::Unavailable("gateway_continuity_unknown"));
            }
            pods.push(GatewayPod {
                name: required(text(&pod["metadata"], "name"), 253)?.into(),
                uid: required(text(&pod["metadata"], "uid"), 253)?.into(),
                ip: private_ip(text(&pod["status"], "podIP"))?,
                restarts: statuses[0]["restartCount"]
                    .as_u64()
                    .filter(|v| *v <= MAX_SAFE)
                    .ok_or(Fault::Unavailable("gateway_continuity_unknown"))?,
            });
        }
        validate_pods(&pods)?;
        pods.sort_by(|a, b| a.uid.cmp(&b.uid));
        Ok(pods)
    }
    async fn keyring(&self) -> Result<(String, HashMap<String, Vec<u8>>, String, String)> {
        let secret = self
            .k8s
            .read_known("Secret", Some(SYSTEM), "pgcf-gateway")
            .await?
            .ok_or(Fault::Unavailable("regional_keyring_missing"))?;
        if secret["metadata"]["name"] != "pgcf-gateway"
            || secret["metadata"]["namespace"] != SYSTEM
            || !secret["metadata"]["deletionTimestamp"].is_null()
        {
            return Err(Fault::Unavailable("regional_keyring_missing"));
        }
        let raw = decode(text(&secret["data"], "PGCF_ROUTE_KEY"), 32768)?;
        let keyring =
            Keyring::parse(&raw).map_err(|_| Fault::Unavailable("regional_keyring_missing"))?;
        let encoded: Value = serde_json::from_str(&raw)
            .map_err(|_| Fault::Unavailable("regional_keyring_missing"))?;
        Ok((
            text(&encoded, "active").into(),
            keyring.keys,
            uid(&secret)?.into(),
            rv(&secret)?.into(),
        ))
    }
    /// The gateway Pods controls and wake polls go to.
    pub(crate) async fn gateway_pods(&self) -> std::result::Result<Vec<GatewayPod>, Error> {
        Ok(self.gateways().await?)
    }
    /// The regional keyring the controller signs gateway and agent tokens with: its active key
    /// ID and every key.
    pub(crate) async fn regional_keys(
        &self,
    ) -> std::result::Result<(String, HashMap<String, Vec<u8>>), Error> {
        let (active, keys, _, _) = self.keyring().await?;
        Ok((active, keys))
    }
    /// The attach keyring derived from the regional keyring.
    pub(crate) async fn attach_keys(
        &self,
    ) -> std::result::Result<crate::attach_protocol::Keys, Error> {
        let (active, keys) = self.regional_keys().await?;
        Ok(crate::attach_protocol::Keys::derive(
            &self.region,
            &active,
            &keys,
        )?)
    }
    /// The phase of the power record in the database's gateway fence, if it holds one.
    pub(crate) async fn sleep_phase(&self, db: &Value) -> Option<&'static str> {
        let map = self.fence(db).await.ok()??;
        let progress = progress_from(&map, self.now()).ok()??;
        Some(phase_name(progress.phase))
    }
    /// Releases the gateways to a pool slot (pool design 2026-10-16): one CAS write of the fence
    /// `map` as it was read when the slot was claimed, with the running intent and the slot's
    /// admission target, then the release control of every gateway. The power record stays the
    /// sleep's until Cloudflare confirms the wake, so an unconfirmed claim can be undone.
    ///
    /// A gateway releases its held connections from the fence its watch delivers; the control is
    /// its acknowledgement only. Once the write committed, the release is made: a refused control
    /// (a watch that lags, a gateway that restarts) is asked again by the pass that publishes the
    /// confirmed wake, and never undoes a release gateways may already route by.
    pub(crate) async fn release_slot(
        &self,
        db: &Value,
        map: &Value,
        intent: &PowerIntent,
        target: &Value,
    ) -> std::result::Result<Value, Error> {
        let result: Result<Value> = async {
            let map = self.fence_checked(db, map.clone())?;
            if intent.mode != "running"
                || intent.revision != number(db, "generation")
                || !valid_schema("gatewayAdmissionTarget", target)
                || target["generation"] != intent.revision
            {
                return Err(Fault::Unavailable("slot_release_invalid"));
            }
            // The fence's history holds, as for every other write of it.
            let prior = intent_from(&map, text(db, "id"))?;
            if prior.revision == intent.revision
                && prior != *intent
                && !unconfirmed_pool_release(&map, &prior, self.now())
            {
                return Err(Fault::Stale);
            }
            let intent_text = serde_json::to_string(intent).unwrap();
            let target_text = serde_json::to_string(target).unwrap();
            let patch = json!({"data":{"intent.json":intent_text,"admission_target":target_text}});
            let (written, snapshot) = tokio::join!(self.k8s.patch(&map, &patch), self.snapshot());
            let written = self.fence_checked(db, written?)?;
            if written["metadata"]["uid"] != map["metadata"]["uid"]
                || text(&written["data"], "intent.json") != intent_text
                || text(&written["data"], "admission_target") != target_text
            {
                return Err(Fault::Unavailable("slot_release_unknown"));
            }
            self.bind_fence(db, &written).await?;
            if let Ok(snapshot) = snapshot {
                let _ = self.controls(intent, &snapshot, "release").await;
            }
            Ok(written)
        }
        .await;
        Ok(result?)
    }
    /// Takes the volume's holder for the database's own CNPG Pod. A database without thin
    /// storage or without a recorded LV takes none. Every node runs the agent: while none is
    /// Ready on the database's node (a restart or a rollout of it) the pass waits.
    async fn hold_cnpg(&self, db: &Value, identity: &str) -> Result<()> {
        use crate::attach_protocol::{Action, HoldRequest, HoldResponse, Holder};
        let Some(volume) = crate::pool::volume_of(db, identity) else {
            return Ok(());
        };
        let busy = Fault::Unavailable("volume_holder_busy");
        let agent = self
            .attach
            .agent(text(db, "node"))
            .await
            .map_err(|_| Fault::Unavailable("volume_holder_busy"))?
            .ok_or(Fault::Unavailable("volume_holder_busy"))?;
        let keys = self
            .attach_keys()
            .await
            .map_err(|_| Fault::Unavailable("volume_holder_busy"))?;
        let request = HoldRequest {
            holder: Holder::Cnpg {
                database: text(db, "id").into(),
            },
            volume: volume.clone(),
        };
        self.attach
            .call::<_, HoldResponse>(
                &keys,
                &agent,
                Action::Hold,
                &volume.lv_uuid,
                &request,
                Duration::from_secs(2),
                self.now(),
            )
            .await
            .map(|_| ())
            .map_err(|_| busy)
    }
    /// Records the clean sleep of a database's own CNPG Pod on its storage receipt, and releases
    /// the holder its Pod had once the volume is closed; while no agent is Ready on the node the
    /// sleep waits for it. Thick databases record nothing.
    async fn record_sleep(
        &self,
        db: &Value,
        anchor: &Anchor,
        system: Option<&SystemIdentity>,
    ) -> Result<()> {
        use crate::attach_protocol::{Action, Holder, ReleaseRequest, ReleaseResponse};
        if db["storage"].is_null() {
            return Ok(());
        }
        let record = system.and_then(|system| {
            Some(crate::pool::SleepRecord {
                v: 1,
                system_identifier: system.identifier.clone(),
                timeline: u32::try_from(system.timeline).ok()?,
                configuration_sha256: crate::pool::sleep_fingerprint(db, &self.postgres_image)
                    .ok()?,
                image: db["postgres"]["image"]
                    .as_str()
                    .unwrap_or(&self.postgres_image)
                    .into(),
                written_at_ms: self.now(),
                via: crate::pool::Via::Cnpg,
            })
        });
        crate::pool::write_sleep_record(&self.k8s, text(db, "id"), record.as_ref()).await?;
        let Some(volume) = crate::pool::volume_of(db, &anchor.volume_identity) else {
            return Ok(());
        };
        let unavailable = || Fault::Unavailable("volume_holder_busy");
        let agent = self
            .attach
            .agent(text(db, "node"))
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(unavailable)?;
        let keys = self.attach_keys().await.map_err(|_| unavailable())?;
        let request = ReleaseRequest {
            volume: volume.clone(),
            holder: Holder::Cnpg {
                database: text(db, "id").into(),
            },
            wait_ms: crate::attach_protocol::MAX_RELEASE_WAIT_MS,
        };
        match self
            .attach
            .call::<_, ReleaseResponse>(
                &keys,
                &agent,
                Action::Release,
                &volume.lv_uuid,
                &request,
                Duration::from_millis(crate::attach_protocol::MAX_RELEASE_WAIT_MS + 2_000),
                self.now(),
            )
            .await
        {
            Ok(_) => Ok(()),
            // Another holder holds the volume: not this Pod's to release.
            Err(crate::attach_protocol::CallError::Refused(code)) if code == "holder_mismatch" => {
                Ok(())
            }
            Err(_) => Err(unavailable()),
        }
    }
    pub async fn gateway_snapshot(&self) -> std::result::Result<GatewaySnapshot, Error> {
        Ok(tokio::time::timeout(Duration::from_secs(3), self.snapshot()).await??)
    }
    async fn snapshot(&self) -> Result<GatewaySnapshot> {
        let (pods, key) = tokio::try_join!(self.gateways(), self.keyring())?;
        Ok(GatewaySnapshot {
            pods,
            active: key.0,
            keys: key.1,
            key_uid: key.2,
            key_version: key.3,
        })
    }
    fn control_token(
        &self,
        intent: &PowerIntent,
        snapshot: &GatewaySnapshot,
        pod: &GatewayPod,
        action: &str,
    ) -> Result<String> {
        let issued = now() / 1000;
        let claims = json!({"v":1,"region":self.region,"database":intent.database,"operation":intent.operation,"revision":intent.revision,"pod":pod.uid,"action":action,"kid":snapshot.active,"iat":issued,"exp":issued+pgcf_native_protocol::constant("GATEWAY_CONTROL_MAX_LIFETIME_SECONDS")});
        if !valid_schema("controlClaims", &claims) {
            return Err(Fault::Unavailable("gateway_ack_identity_mismatch"));
        }
        let key = snapshot
            .keys
            .get(&snapshot.active)
            .ok_or(Fault::Unavailable("regional_keyring_missing"))?;
        let mut inner = Hmac::<Sha256>::new_from_slice(key)
            .map_err(|_| Fault::Unavailable("regional_keyring_missing"))?;
        inner.update(wire("controlKeyPurpose").as_bytes());
        let derived = inner.finalize().into_bytes();
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let mut mac = Hmac::<Sha256>::new_from_slice(&derived).unwrap();
        mac.update(wire("controlSigningPurpose").as_bytes());
        mac.update(payload.as_bytes());
        Ok(format!(
            "{}.{}.{}",
            wire("controlTokenPrefix"),
            payload,
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    async fn controls(
        &self,
        intent: &PowerIntent,
        snapshot: &GatewaySnapshot,
        action: &str,
    ) -> Result<Vec<Value>> {
        tokio::time::timeout(
            Duration::from_secs(3),
            self.controls_step(intent, snapshot, action),
        )
        .await
        .map_err(|_| Fault::Unavailable("gateway_ack_unavailable"))?
    }
    async fn controls_step(
        &self,
        intent: &PowerIntent,
        snapshot: &GatewaySnapshot,
        action: &str,
    ) -> Result<Vec<Value>> {
        let work = stream::iter(snapshot.pods.iter())
            .map(|pod| async move {
                let token = self.control_token(intent, snapshot, pod, action)?;
                let ip: IpAddr = pod
                    .ip
                    .parse()
                    .map_err(|_| Fault::Unavailable("gateway_private_address_unavailable"))?;
                let host = if ip.is_ipv6() {
                    format!("[{}]", pod.ip)
                } else {
                    pod.ip.clone()
                };
                // A release is refused while the gateway's own watch has not yet delivered the
                // intent the controller wrote just before it (409), or while its fences are not
                // synchronized (503). Both pass within milliseconds, and the retry of the whole
                // pass would wait a second for them. The request is the same each time: a
                // release is idempotent and the token names it. Every other control is judged on
                // its first answer.
                let retry_until = Instant::now() + RELEASE_RETRY_WINDOW;
                let response = loop {
                    let response = self
                        .http
                        .post(format!(
                            "http://{host}:8080{}{}",
                            wire("controlPathPrefix"),
                            action
                        ))
                        .header(wire("controlHeader"), token.clone())
                        .send()
                        .await
                        .map_err(|_| Fault::Unavailable("gateway_ack_unavailable"))?;
                    let status = response.status();
                    if status.is_success() {
                        break response;
                    }
                    if action == "release"
                        && matches!(status.as_u16(), 409 | 503)
                        && Instant::now() < retry_until
                    {
                        tokio::time::sleep(RELEASE_RETRY_SPACING).await;
                        continue;
                    }
                    return Err(Fault::Unavailable("gateway_ack_unavailable"));
                };
                let mut stream = response.bytes_stream();
                let mut bytes = Vec::new();
                while let Some(part) = stream.next().await {
                    let part = part.map_err(|_| Fault::Unavailable("gateway_ack_unavailable"))?;
                    if part.len() > 4096 - bytes.len() {
                        return Err(Fault::Unavailable("gateway_report_overflow"));
                    }
                    bytes.extend_from_slice(&part);
                }
                let report: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| Fault::Unavailable("gateway_ack_unavailable"))?;
                if !crate::contracts::schema_valid("GatewayControlReport", &report)
                    || report["database"] != intent.database
                    || report["operation"] != intent.operation
                    || report["revision"] != intent.revision
                    || report["pod"] != pod.uid
                    || report["mode"] != intent.mode
                {
                    return Err(Fault::Unavailable("gateway_ack_identity_mismatch"));
                }
                if intent.mode == "quiesce"
                    && (report_count(&report, "busyConnections")? != 0
                        || report_count(&report, "pendingDials")? != 0
                        || !["idle", "closed"].contains(&text(&report, "status"))
                        || (["close", "status"].contains(&action)
                            && report_count(&report, "connections")? != 0))
                {
                    return Err(Fault::Busy);
                }
                if intent.mode == "running" && report["status"] != "running" {
                    return Err(Fault::Unavailable("gateway_release_unacknowledged"));
                }
                if intent.mode == "retired"
                    && (report["status"] != "retired"
                        || report_count(&report, "connections")? != 0
                        || report_count(&report, "busyConnections")? != 0
                        || report_count(&report, "pendingDials")? != 0)
                {
                    return Err(Fault::Unavailable("gateway_ack_identity_mismatch"));
                }
                Ok(report)
            })
            .buffer_unordered(4);
        tokio::pin!(work);
        let mut reports = Vec::new();
        let mut failure = None;
        while let Some(result) = work.next().await {
            match result {
                Ok(report) => reports.push(report),
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        Ok(reports)
    }
    async fn cluster_intent(
        &self,
        intent: &PowerIntent,
        cluster: &Value,
        hibernation: &str,
    ) -> Result<()> {
        // A wake always lifts the instance fence a retained Pod may still carry, together with
        // hibernation, so CNPG can never create a fenced replacement Pod.
        self.cluster_power(intent, cluster, hibernation, hibernation == "off")
            .await
    }
    /// The power annotations and hibernation in one CAS patch, read back; `unfence` removes the
    /// instance fence in the same write.
    async fn cluster_power(
        &self,
        intent: &PowerIntent,
        cluster: &Value,
        hibernation: &str,
        unfence: bool,
    ) -> Result<()> {
        let revision = cluster["metadata"]["annotations"][POWER_REVISION]
            .as_str()
            .map(|v| v.parse::<u64>())
            .transpose()
            .map_err(|_| Fault::Stale)?
            .unwrap_or(0);
        if revision > intent.revision
            || (revision == intent.revision
                && cluster["metadata"]["annotations"][POWER_OPERATION]
                    .as_str()
                    .is_some_and(|value| value != intent.operation))
        {
            return Err(Fault::Stale);
        }
        if revision == intent.revision
            && cluster["metadata"]["annotations"][POWER_OPERATION] == intent.operation
            && cluster["metadata"]["annotations"][HIBERNATION] == hibernation
            && !(unfence && cluster["metadata"]["annotations"].get(FENCE).is_some())
        {
            return Ok(());
        }
        let mut patch = json!({"metadata":{"annotations":{POWER_REVISION:intent.revision.to_string(),POWER_OPERATION:intent.operation,HIBERNATION:hibernation}}});
        if unfence {
            patch["metadata"]["annotations"][FENCE] = Value::Null;
        }
        let actual = self.k8s.patch(cluster, &patch).await?;
        if annotation_number(&actual, POWER_REVISION)? != Some(intent.revision)
            || actual["metadata"]["annotations"][POWER_OPERATION] != intent.operation
            || actual["metadata"]["annotations"][HIBERNATION] != hibernation
            || (unfence && actual["metadata"]["annotations"].get(FENCE).is_some())
        {
            return Err(Fault::Unavailable("cluster_power_write_unknown"));
        }
        Ok(())
    }
    async fn verify(
        &self,
        db: &Value,
        intent: &PowerIntent,
        map: &Value,
        progress: &Progress,
        snapshot: &GatewaySnapshot,
    ) -> Result<Vec<Value>> {
        let active = self.fence(db).await?.ok_or(Fault::Stale)?;
        if uid(&active)? != uid(map)? || intent_from(&active, text(db, "id"))? != *intent {
            return Err(Fault::Stale);
        }
        let (anchor, _) = self.anchor(db).await?;
        if !anchor.matches(&progress.anchor) {
            return Err(Fault::Recovery("power_storage_identity_changed"));
        }
        let fresh = self.snapshot().await?;
        if !snapshot.same_identity(&fresh) {
            return Err(Fault::Unavailable("gateway_inventory_changed"));
        }
        self.controls(intent, &fresh, "status").await
    }
}
static POWER_CONTRACT: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/power.generated.json"
    ))
    .expect("generated power constants")
});
pub(crate) fn sql(name: &str) -> &'static str {
    POWER_CONTRACT["constants"]["SLEEP_SQL"][name]
        .as_str()
        .expect("generated SQL")
}
fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Quiescing => "quiescing",
        Phase::Switching => "switching",
        Phase::Archive => "archive",
        Phase::Proved => "proved",
        Phase::Hibernating => "hibernating",
        Phase::Hibernated => "hibernated",
        Phase::Wake => "wake",
        Phase::Awake => "awake",
        Phase::Refused => "refused",
        Phase::Parking => "parking",
        Phase::Parked => "parked",
    }
}
/// Whether `map`, a gateway fence running at `intent`, is a pool slot's release that Cloudflare
/// has not confirmed: its admission target is a slot's at that revision, and its power record is
/// not the completed wake of that intent. Cloudflare may still commit another operation or state
/// at the revision, and the fence that names it supersedes the release (the gateway accepts
/// that for a slot's release only).
fn unconfirmed_pool_release(map: &Value, intent: &PowerIntent, now: u64) -> bool {
    let target: Option<Value> = map["data"]["admission_target"]
        .as_str()
        .and_then(|raw| serde_json::from_str(raw).ok());
    intent.mode == "running"
        && target.is_some_and(|target| {
            target["generation"] == intent.revision
                && pgcf_native_protocol::wake::slot_namespace_of_tls_name(text(
                    &target,
                    "tls_server_name",
                ))
                .is_some()
        })
        && !woke_under(map, intent, now)
}
/// Whether `map`, a gateway fence, holds the power record of a completed sleep: a valid record
/// with its anchor, at `Hibernated`.
pub(crate) fn sleep_completed(map: &Value, now: u64) -> bool {
    progress_from(map, now).is_ok_and(|p| p.is_some_and(|p| p.phase == Phase::Hibernated))
}
/// The intent of `map`, a gateway fence of database `id`.
pub(crate) fn fence_intent(map: &Value, id: &str) -> Option<PowerIntent> {
    intent_from(map, id).ok()
}
/// Whether the power record of `map` is the completed wake of `intent`.
pub(crate) fn woke_under(map: &Value, intent: &PowerIntent, now: u64) -> bool {
    progress_from(map, now)
        .is_ok_and(|p| p.is_some_and(|p| p.phase == Phase::Awake && p.target == *intent))
}
fn condition(cluster: &Value, name: &str) -> bool {
    cluster["status"]["conditions"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|v| v["type"] == name && v["status"] == "True" && v["reason"] == "Hibernated")
}
impl PowerCoordinator {
    async fn safety(&self, session: &postgres::Session) -> Result<Option<&'static str>> {
        session.query(sql("CLEAR"), &[]).await?;
        let rows = session.query(sql("GUARD"), &[]).await?;
        if rows.len() != 1 {
            return Ok(Some("sql_unknown"));
        }
        let busy = rows[0].try_get::<_, i32>("busy").ok();
        let prepared = rows[0].try_get::<_, i32>("prepared").ok();
        if busy.is_none_or(|v| v < 0) || prepared.is_none_or(|v| v < 0) {
            return Ok(Some("sql_unknown"));
        }
        if prepared.is_some_and(|v| v > 0) {
            return Ok(Some("prepared_work"));
        }
        if busy.is_some_and(|v| v > 0) {
            return Ok(Some("sql_busy"));
        }
        Ok(None)
    }
    async fn sleep_proof(
        &self,
        db: &Value,
        intent: &PowerIntent,
        (map, progress): (&mut Value, &mut Progress),
        snapshot: &GatewaySnapshot,
        slot: Option<&SlotSleep>,
    ) -> Result<Option<&'static str>> {
        let result = tokio::time::timeout(Duration::from_secs(2), async {
            self.verify(db, intent, map, progress, snapshot).await?;
            let role = constant("MAINTENANCE_ROLE")
                .as_str()
                .ok_or(Fault::Unavailable("maintenance_capability_missing"))?;
            let ns = namespace(db);
            let maintenance = owned(
                self.k8s
                    .read("Secret", Some(&ns), "maintenance-credentials")
                    .await?,
                "maintenance-credentials",
                text(db, "id"),
                Some(&ns),
                false,
            )?;
            if decode(text(&maintenance["data"], "username"), 4096)? != role
                || decode(text(&maintenance["data"], "password"), 8192)?
                    != text(&db["maintenance"], "password")
                || db["maintenance"]["role"] != role
            {
                return Err(Fault::Unavailable("maintenance_credentials_unacknowledged"));
            }
            let ca_name = format!("ca-{}", text(db, "id"));
            let ca = owned(
                self.k8s.read("ConfigMap", Some(SYSTEM), &ca_name).await?,
                &ca_name,
                text(db, "id"),
                Some(SYSTEM),
                false,
            )?;
            let ca = required(text(&ca["data"], "ca.crt"), 128 * 1024)?;
            postgres::validate_ca(ca.as_bytes())?;
            let session = match slot {
                Some(slot) => {
                    postgres::connect_slot(
                        db,
                        slot.pod,
                        &slot.tls_name,
                        ca.as_bytes(),
                        role,
                        text(&db["maintenance"], "password"),
                    )
                    .await?
                }
                None => {
                    postgres::connect_via(
                        db,
                        ca.as_bytes(),
                        role,
                        text(&db["maintenance"], "password"),
                        text(db, "id"),
                        self.postgres,
                    )
                    .await?
                }
            };
            let rows = session.query(sql("IDENTITY"), &[&role]).await?;
            if rows.len() != 1
                || rows[0].try_get::<_, String>("database").ok().as_deref() != Some(text(db, "id"))
                || rows[0].try_get::<_, bool>("recovery").ok() != Some(false)
                || rows[0].try_get::<_, bool>("tls").ok() != Some(true)
                || rows[0].try_get::<_, bool>("stats").ok() != Some(true)
                || [
                    "rolsuper",
                    "rolcreatedb",
                    "rolcreaterole",
                    "rolreplication",
                    "rolbypassrls",
                ]
                .iter()
                .any(|name| rows[0].try_get::<_, bool>(*name).ok() != Some(false))
            {
                return Ok(Some("probe_unavailable"));
            }
            if let Some(reason) = self.safety(&session).await? {
                return Ok(Some(reason));
            }
            // The data directory the postmaster runs on, while it runs, for the wake of a parked
            // Pod to compare. A statement that does not answer only keeps the Pod from being
            // parked; a second proof pass that finds another data directory is not a sleep.
            let system = session
                .query(postgres::SERVER_IDENTITY_QUERY, &[])
                .await
                .ok()
                .and_then(|rows| match rows.as_slice() {
                    [row] => SystemIdentity::of(row),
                    _ => None,
                });
            if progress.system.is_some() && system.is_some() && progress.system != system {
                return Ok(Some("system_identity_changed"));
            }
            if system.is_some() {
                progress.system = system;
            }
            self.verify(db, intent, map, progress, snapshot).await?;
            if progress.segment.is_none() {
                // Switching was durably recorded before entering this method. A lost query
                // outcome must retain that uncertainty, never dispatch this statement again.
                let rows = match session.query(sql("SWITCH"), &[]).await {
                    Ok(rows) => rows,
                    Err(_) => return Ok(Some("switch_unknown")),
                };
                if rows.len() != 1 {
                    return Ok(Some("switch_unknown"));
                }
                let lsn = rows[0].try_get::<_, String>("lsn").ok();
                let closed = rows[0].try_get::<_, String>("segment").ok();
                let valid_lsn = lsn.as_deref().is_some_and(|v| {
                    v != "0/0"
                        && v.split_once('/').is_some_and(|(a, b)| {
                            !a.is_empty()
                                && !b.is_empty()
                                && a.bytes()
                                    .chain(b.bytes())
                                    .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(&v))
                        })
                });
                if !valid_lsn || closed.as_deref().is_none_or(|v| !segment(v)) {
                    return Ok(Some("switch_unknown"));
                }
                progress.segment = closed;
                progress.phase = Phase::Archive;
                let current = self.fence(db).await?.ok_or(Fault::Stale)?;
                if uid(&current)? != uid(map)? {
                    return Err(Fault::Stale);
                }
                *map = self.write(db, Some(&current), None, progress).await?;
            }
            let segment = progress
                .segment
                .as_deref()
                .ok_or(Fault::Unavailable("closed_segment_not_persisted"))?;
            let filename = format!("{segment}.done");
            loop {
                let rows = session.query(sql("ARCHIVE_STATUS"), &[&filename]).await?;
                if rows.len() != 1 {
                    return Ok(Some("sql_unknown"));
                }
                match rows[0].try_get::<_, bool>("done") {
                    Ok(true) => break,
                    Ok(false) => tokio::time::sleep(Duration::from_millis(250)).await,
                    Err(_) => return Ok(Some("sql_unknown")),
                }
            }
            if let Some(reason) = self.safety(&session).await? {
                return Ok(Some(reason));
            }
            self.verify(db, intent, map, progress, snapshot).await?;
            Ok(None)
        })
        .await;
        match result {
            Ok(value) => value,
            Err(_) => Ok(Some(if progress.segment.is_some() {
                "archive_timeout"
            } else {
                "switch_unknown"
            })),
        }
    }
    pub async fn suspend(
        &self,
        db: &Value,
        sleep: &Sleep<'_>,
    ) -> std::result::Result<Option<Value>, Error> {
        if !database_valid(db) || text(db, "desired_state") != "suspended" {
            return Err("invalid suspension desired state".into());
        }
        let intent = desired_power(db)?.ok_or("suspension intent missing")?;
        Ok(tokio::time::timeout(
            Duration::from_secs(10),
            self.suspend_step(db, &intent, sleep),
        )
        .await
        .unwrap_or_default())
    }
    async fn suspend_step(
        &self,
        db: &Value,
        intent: &PowerIntent,
        sleep: &Sleep<'_>,
    ) -> Option<Value> {
        if sleep.slot.is_none() {
            match self.protected_manual_suspend(db, intent).await {
                Ok(Some(result)) => return result,
                Ok(None) => {}
                Err(Fault::Recovery(reason)) => return Some(recovery_observation(db, reason)),
                Err(_) => return None,
            }
        }
        let mut map = None;
        let mut progress = None;
        let result: Result<Option<Value>> = async {
            let (physical, cluster) = self.anchor(db).await?;
            map = self.fence(db).await?;
            progress = map
                .as_ref()
                .map(|map| progress_from(map, self.now()))
                .transpose()?
                .flatten();
            if progress
                .as_ref()
                .is_some_and(|p| !physical.matches(&p.anchor))
            {
                return Err(Fault::Recovery("power_storage_identity_changed"));
            }
            if progress
                .as_ref()
                .is_some_and(|p| p.target.revision > intent.revision)
            {
                return Err(Fault::Stale);
            }
            // A database that holds its instance Pod (parked, being parked or demoted) is
            // handled apart: it is never proved again, and never refused for an unknown write.
            if let (Some(held), Some(current)) =
                (progress.as_ref().filter(|p| p.park.is_some()), map.as_ref())
            {
                match self
                    .retained_sleep(
                        db,
                        intent,
                        sleep,
                        current.clone(),
                        held.clone(),
                        cluster.clone(),
                    )
                    .await
                {
                    Ok(Retained::Observed(value)) => return Ok(value),
                    Ok(Retained::Ordinary) => {
                        if let Some(p) = progress.as_mut() {
                            p.park = None;
                        }
                    }
                    Err(Fault::Recovery(reason)) => return Err(Fault::Recovery(reason)),
                    Err(Fault::Stale) => return Err(Fault::Stale),
                    Err(_) => return Ok(None),
                }
            }
            if progress.as_ref().is_none_or(|p| p.target != *intent) {
                let already_off = sleep.slot.is_none()
                    && progress
                        .as_ref()
                        .is_some_and(|p| matches!(p.phase, Phase::Hibernating | Phase::Hibernated))
                    && cluster["metadata"]["annotations"][HIBERNATION] == "on"
                    && condition(&cluster, HIBERNATION)
                    && self
                        .k8s
                        .list(
                            "Pod",
                            Some(&namespace(db)),
                            Some("cnpg.io/cluster=database"),
                        )
                        .await?
                        .iter()
                        .all(terminal_pod);
                let next = if already_off {
                    let mut prior = progress.clone().unwrap();
                    prior.target = intent.clone();
                    prior.phase = Phase::Hibernated;
                    prior
                } else {
                    Progress::new(
                        intent.clone(),
                        Phase::Quiescing,
                        physical.clone(),
                        self.now(),
                    )
                };
                map = Some(self.write(db, map.as_ref(), Some(intent), &next).await?);
                progress = Some(next);
                if already_off {
                    self.cluster_intent(intent, &cluster, "on").await?;
                }
            }
            let p = progress
                .as_mut()
                .ok_or(Fault::Recovery("power_progress_invalid"))?;
            let mut current = map
                .clone()
                .ok_or(Fault::Recovery("gateway_fence_missing"))?;
            self.bind_fence(db, &current).await?;
            if p.phase == Phase::Refused {
                return Ok(Some(observation(
                    db,
                    intent,
                    "awake",
                    Some(p.refusal.unwrap_or(Refusal::Unknown)),
                )));
            }
            // A slot-served database is hibernated once its slot is retired; its own Cluster has
            // been hibernated all along.
            if let Some(slot) = &sleep.slot
                && matches!(p.phase, Phase::Hibernating | Phase::Hibernated)
            {
                if !slot.gone {
                    return Ok(None);
                }
                let snapshot = self.snapshot().await?;
                if p.phase == Phase::Hibernating
                    && (p.gateways.as_ref() != Some(&snapshot.pods)
                        || p.key_uid.as_deref() != Some(&snapshot.key_uid)
                        || p.key_version.as_deref() != Some(&snapshot.key_version))
                {
                    return Ok(None);
                }
                self.controls(intent, &snapshot, "status").await?;
                let (confirmed, _) = self.anchor(db).await?;
                if !confirmed.matches(&p.anchor) {
                    return Err(Fault::Recovery("power_storage_identity_changed"));
                }
                p.phase = Phase::Hibernated;
                self.write(db, Some(&current), None, p).await?;
                return Ok(Some(observation(db, intent, "hibernated", None)));
            }
            if matches!(p.phase, Phase::Hibernating | Phase::Hibernated)
                && cluster["metadata"]["annotations"][HIBERNATION] == "on"
            {
                let snapshot = self.snapshot().await?;
                if p.phase == Phase::Hibernating
                    && (p.gateways.as_ref() != Some(&snapshot.pods)
                        || p.key_uid.as_deref() != Some(&snapshot.key_uid)
                        || p.key_version.as_deref() != Some(&snapshot.key_version))
                {
                    return Ok(None);
                }
                self.controls(intent, &snapshot, "status").await?;
                if !condition(&cluster, HIBERNATION)
                    || !self
                        .k8s
                        .list(
                            "Pod",
                            Some(&namespace(db)),
                            Some("cnpg.io/cluster=database"),
                        )
                        .await?
                        .iter()
                        .all(terminal_pod)
                {
                    return Ok(None);
                }
                let (confirmed, _) = self.anchor(db).await?;
                if !confirmed.matches(&p.anchor) {
                    return Err(Fault::Recovery("power_storage_identity_changed"));
                }
                if self.gateways().await? != snapshot.pods {
                    return Ok(None);
                }
                // The sleep is clean and the Pod gone: the record a pool wake starts from, and the
                // volume is free for the next holder.
                if p.phase == Phase::Hibernating {
                    self.record_sleep(db, &p.anchor, p.system.as_ref()).await?;
                }
                p.phase = Phase::Hibernated;
                self.write(db, Some(&current), None, p).await?;
                return Ok(Some(observation(db, intent, "hibernated", None)));
            }
            let snapshot = self.snapshot().await?;
            if p.gateways.as_ref().is_some_and(|pods| {
                pods != &snapshot.pods
                    || p.key_uid.as_deref() != Some(&snapshot.key_uid)
                    || p.key_version.as_deref() != Some(&snapshot.key_version)
            }) {
                return Err(Fault::Unavailable("fence_continuity_lost"));
            }
            self.controls(intent, &snapshot, "begin").await?;
            self.controls(intent, &snapshot, "close").await?;
            if p.phase == Phase::Switching {
                return Err(Fault::Unavailable("switch_result_unknown"));
            }
            if db["maintenance"].is_null() {
                return Err(Fault::Unavailable("maintenance_capability_missing"));
            }
            if p.segment.is_none() {
                p.phase = Phase::Switching;
                p.proof_intent = Some(intent.clone());
                p.gateways = Some(snapshot.pods.clone());
                p.key_uid = Some(snapshot.key_uid.clone());
                p.key_version = Some(snapshot.key_version.clone());
                current = self.write(db, Some(&current), None, p).await?;
                map = Some(current.clone());
            }
            if let Some(reason) = self
                .sleep_proof(
                    db,
                    intent,
                    (&mut current, p),
                    &snapshot,
                    sleep.slot.as_ref(),
                )
                .await?
            {
                map = Some(current.clone());
                if reason == "archive_timeout"
                    && p.segment.is_some()
                    && self.now().saturating_sub(p.started_at) < MAX_WAIT
                {
                    return Ok(None);
                }
                p.phase = Phase::Refused;
                p.refusal = Some(match reason {
                    "sql_busy" | "prepared_work" | "not_quiescent" => Refusal::Busy,
                    "archive_timeout" => Refusal::Archive,
                    _ => Refusal::Unknown,
                });
                self.write(db, Some(&current), None, p).await?;
                return Ok(Some(observation(db, intent, "awake", p.refusal)));
            }
            map = Some(current.clone());
            if p.segment.is_none() {
                return Err(Fault::Unavailable("closed_segment_not_persisted"));
            }
            self.verify(db, intent, &current, p, &snapshot).await?;
            p.phase = Phase::Proved;
            current = self.write(db, Some(&current), None, p).await?;
            map = Some(current.clone());
            let (latest, cluster) = self.anchor(db).await?;
            if !latest.matches(&p.anchor) {
                return Err(Fault::Recovery("power_storage_identity_changed"));
            }
            // Step S5: a proved idle sleep keeps the Pod when the region's tier admits it. Any
            // read that fails here only means the ordinary hibernation.
            if sleep.slot.is_none()
                && let Some(system) = p.system.clone()
                && let Ok(Some(park)) = self.park_plan(db, intent, &cluster, sleep, &system).await
            {
                // Step S6: the record is persisted before the Cluster is written (S7).
                p.phase = Phase::Parking;
                p.park = Some(park);
                current = self.write(db, Some(&current), None, p).await?;
                map = Some(current);
                self.cluster_fence(intent, &cluster).await?;
                return Ok(None);
            }
            p.phase = Phase::Hibernating;
            current = self.write(db, Some(&current), None, p).await?;
            map = Some(current);
            // A slot-served database's own Cluster is hibernated already: its slot is retired by
            // the pool, and the next pass completes the sleep.
            if sleep.slot.is_none() {
                self.cluster_intent(intent, &cluster, "on").await?;
            }
            Ok(None)
        }
        .await;
        match result {
            Ok(value) => value,
            Err(Fault::Stale) => None,
            Err(Fault::Recovery(message)) => Some(recovery_observation(db, message)),
            Err(error) => {
                if progress.as_ref().is_some_and(|p| {
                    matches!(
                        p.phase,
                        Phase::Hibernating | Phase::Hibernated | Phase::Parking | Phase::Parked
                    )
                }) {
                    return None;
                }
                if matches!(
                    error,
                    Fault::Unavailable(
                        "gateway_ack_unavailable"
                            | "gateway_inventory_incomplete"
                            | "gateway_continuity_unknown"
                            | "gateway_private_address_unavailable"
                    )
                ) && progress.as_ref().is_some_and(|p| {
                    p.phase == Phase::Quiescing && self.now().saturating_sub(p.started_at) < 30_000
                }) {
                    return None;
                }
                let refusal = if matches!(error, Fault::Busy) {
                    Refusal::Busy
                } else {
                    Refusal::Unknown
                };
                if let (Some(p), Some(map)) = (progress.as_mut(), map.as_ref()) {
                    p.phase = Phase::Refused;
                    p.refusal = Some(refusal);
                    if self.write(db, Some(map), None, p).await.is_err() {
                        return None;
                    }
                }
                Some(observation(db, intent, "awake", Some(refusal)))
            }
        }
    }
    /// An explicit stop may confirm an already protected postmaster's absence. This
    /// neither proves archival completion nor repeats SQL against a stopped process.
    async fn protected_manual_suspend(
        &self,
        db: &Value,
        intent: &PowerIntent,
    ) -> Result<Option<Option<Value>>> {
        if db["storage"].is_null()
            || text(&db["power"], "reason") != "manual"
            || intent.mode != "quiesce"
        {
            return Ok(None);
        }
        let id = text(db, "id");
        let ns = namespace(db);
        let storage_name = format!("storage-{id}");
        let Some(storage) = self
            .k8s
            .read("ConfigMap", Some(SYSTEM), &storage_name)
            .await?
        else {
            return Ok(None);
        };
        let storage = owned(Some(storage), &storage_name, id, Some(SYSTEM), false)?;
        let Some(raw) = storage["data"][protection_key()].as_str() else {
            return Ok(None);
        };
        let marker: Value = serde_json::from_str(required(raw, 4096)?)
            .map_err(|_| Fault::Recovery("storage_protection_marker_invalid"))?;
        let (physical, cluster) = self.anchor(db).await?;
        let generation = crate::contracts::integer(&marker, "generation")?;
        if marker["v"] != 1
            || marker["database_id"] != id
            || generation == 0
            || generation >= intent.revision
            || !valid_pattern("operation", text(&marker, "operation_id"))
            || marker["operation_id"] == intent.operation
            || marker["storage_uid"] != physical.storage_uid
            || uid(&storage)? != physical.storage_uid
            || marker["namespace_uid"] != physical.namespace_uid
            || marker["cluster_uid"] != physical.cluster_uid
            || marker["node_uid"] != db["storage"]["node_uid"]
            || marker["profile_sha256"] != db["storage"]["profile_sha256"]
            || crate::contracts::integer(&marker, "requested_at")? > self.now()
        {
            return Err(Fault::Recovery("storage_protection_marker_changed"));
        }
        let mut map = self.fence(db).await?;
        let previous = map
            .as_ref()
            .map(|value| progress_from(value, self.now()))
            .transpose()?
            .flatten();
        if previous
            .as_ref()
            .is_some_and(|progress| !progress.anchor.matches(&physical))
        {
            return Err(Fault::Recovery("power_storage_identity_changed"));
        }
        if previous
            .as_ref()
            .is_some_and(|progress| progress.target.revision > intent.revision)
        {
            return Err(Fault::Stale);
        }
        if cluster["metadata"]["annotations"][HIBERNATION] != "on"
            || !condition(&cluster, HIBERNATION)
            || !self
                .k8s
                .list("Pod", Some(&ns), Some("cnpg.io/cluster=database"))
                .await?
                .iter()
                .all(terminal_pod)
        {
            return Ok(Some(None));
        }
        if map
            .as_ref()
            .map(|value| intent_from(value, id))
            .transpose()?
            .as_ref()
            != Some(intent)
        {
            // Retain any existing switch/archival uncertainty verbatim. Only the
            // normal gateway intent advances to the current CF-owned manual stop.
            let progress = previous.unwrap_or_else(|| {
                Progress::new(
                    intent.clone(),
                    Phase::Quiescing,
                    physical.clone(),
                    self.now(),
                )
            });
            map = Some(
                self.write(db, map.as_ref(), Some(intent), &progress)
                    .await?,
            );
        }
        let current = map.ok_or(Fault::Recovery("gateway_fence_missing"))?;
        self.bind_fence(db, &current).await?;
        let snapshot = self.snapshot().await?;
        self.controls(intent, &snapshot, "begin").await?;
        self.controls(intent, &snapshot, "close").await?;
        self.controls(intent, &snapshot, "status").await?;
        let (confirmed, cluster) = self.anchor(db).await?;
        let actual = self.fence(db).await?.ok_or(Fault::Stale)?;
        let fresh = owned(
            self.k8s
                .read("ConfigMap", Some(SYSTEM), &storage_name)
                .await?,
            &storage_name,
            id,
            Some(SYSTEM),
            false,
        )?;
        if !confirmed.matches(&physical)
            || uid(&actual)? != uid(&current)?
            || intent_from(&actual, id)? != *intent
            || fresh["data"][protection_key()] != raw
            || uid(&fresh)? != physical.storage_uid
        {
            return Err(Fault::Recovery("protected_stop_identity_changed"));
        }
        if cluster["metadata"]["annotations"][HIBERNATION] != "on"
            || !condition(&cluster, HIBERNATION)
            || !self
                .k8s
                .list("Pod", Some(&ns), Some("cnpg.io/cluster=database"))
                .await?
                .iter()
                .all(terminal_pod)
            || !self.snapshot().await?.same_identity(&snapshot)
        {
            return Ok(Some(None));
        }
        self.cluster_intent(intent, &cluster, "on").await?;
        let mut value = observation(db, intent, "hibernated", None);
        value["message"]="Physical storage protection stopped PostgreSQL; committed WAL is retained locally and archive completion is unknown".into();
        Ok(Some(Some(value)))
    }
    pub async fn prepare_running(
        &self,
        db: &Value,
        basis: &Basis<'_>,
    ) -> std::result::Result<PrepareRunning, Error> {
        if !database_valid(db) || text(db, "desired_state") != "running" {
            return Err("invalid running desired state".into());
        }
        let intent = desired_power(db)?.ok_or("wake intent missing")?;
        let phase = timing::Phase::begin(db, "wake_prepare");
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            // The anchor is read while the fence and the thin receipt are, and looked at only
            // if this wake is not the creation's own (which has no anchor yet).
            let (map, protected, anchored) = tokio::join!(
                self.fence(db),
                self.storage_protection_for_running(db, &intent),
                self.anchor(db)
            );
            let map = map?;
            let protected = protected?;
            if map.is_none()
                && db["creation"]["ever_ready"] == false
                && number(&db["creation"], "generation") <= number(db, "generation")
                && !protected
            {
                return Ok(PrepareRunning::Proceed);
            }
            let (physical, mut cluster) = anchored?;
            let mut map = map;
            let mut previous = map
                .as_ref()
                .map(|m| progress_from(m, self.now()))
                .transpose()?
                .flatten();
            if previous
                .as_ref()
                .is_some_and(|p| !physical.matches(&p.anchor))
            {
                return Err(Fault::Recovery("power_storage_identity_changed"));
            }
            if previous
                .as_ref()
                .is_some_and(|p| p.target.revision > intent.revision)
            {
                return Err(Fault::Stale);
            }
            // A same-generation/rebound marker must reject before either progress
            // or hibernation-off changes. CAS clearing belongs only to the new CF intent.
            self.clear_storage_protection(db, &intent, &physical.storage_uid)
                .await?;
            // A database that retains its instance Pod resumes it when nothing it was parked
            // under has changed, and otherwise demotes it before the ordinary CNPG wake.
            if let (Some(held), Some(current)) =
                (previous.as_ref().filter(|p| p.park.is_some()), map.as_ref())
            {
                match self
                    .resume_retained(
                        db,
                        &intent,
                        current.clone(),
                        held.clone(),
                        cluster.clone(),
                        basis,
                    )
                    .await
                {
                    Ok((Resumed::Fast(resumed), ..)) => {
                        return Ok(PrepareRunning::Parked(resumed));
                    }
                    Ok((Resumed::Waiting, ..)) => return Ok(PrepareRunning::Pending),
                    Ok((Resumed::Ordinary, next_map, next_progress, next_cluster)) => {
                        map = Some(next_map);
                        previous = Some(next_progress);
                        cluster = next_cluster;
                    }
                    // An unknown write or a conflict is read again by the next pass.
                    Err(Fault::Unavailable(_)) => return Ok(PrepareRunning::Pending),
                    Err(error) => return Err(error),
                }
            }
            // The miss path takes the volume's holder before its own Pod is created on it: never
            // while a pool slot holds it (pool design 2026-10-16).
            if cluster["metadata"]["annotations"][HIBERNATION] == "on" {
                self.hold_cnpg(db, &physical.volume_identity).await?;
            }
            let mut progress = Progress::new(intent.clone(), Phase::Wake, physical, self.now());
            if let Some(prior) = &previous
                && prior.target.revision == intent.revision
            {
                progress.started_at = prior.started_at;
            }
            // A wake that continues on a retained Pod keeps its record until the wake ends, so
            // every pass of it can still give the Pod its requests back.
            progress.park = previous.as_ref().and_then(|prior| prior.park.clone());
            // A wake that completed under this very intent is not begun again: the pass that
            // looks at an awake database once more would turn its record back into `Wake`, write
            // `Awake` at its end once more, and have the cluster's watch make it due again.
            let completed = previous
                .as_ref()
                .is_some_and(|prior| prior.phase == Phase::Awake && prior.target == intent);
            if !completed && let Some(map) = &map {
                self.write(db, Some(map), None, &progress).await?;
            }
            self.cluster_intent(&intent, &cluster, "off").await?;
            Ok(PrepareRunning::Proceed)
        })
        .await;
        let outcome = match result {
            Ok(Ok(value)) => value,
            Ok(Err(Fault::Stale | Fault::Unavailable("volume_holder_busy"))) | Err(_) => {
                PrepareRunning::Pending
            }
            Ok(Err(_)) => {
                PrepareRunning::Observation(recovery_observation(db, "wake identity unavailable"))
            }
        };
        match &outcome {
            PrepareRunning::Proceed | PrepareRunning::Parked(_) => phase.completed(),
            PrepareRunning::Pending => phase.pending(),
            PrepareRunning::Observation(_) => phase.failed(),
        }
        Ok(outcome)
    }
    pub async fn publish_ready_fence(
        &self,
        db: &Value,
        observation: Value,
        slot: bool,
    ) -> std::result::Result<Option<Value>, Error> {
        // The operation that brought this database into existence: its creation or, for a
        // restored database, which has no creation, the restore.
        let origin = if db["creation"].is_null() {
            &db["recovery"]
        } else {
            &db["creation"]
        };
        if observation["state"] != "ready"
            || text(db, "desired_state") != "running"
            || origin.is_null()
        {
            // No running intent is published for it; the target its attestation names is.
            self.publish_target(db, None, &observation).await?;
            return Ok(Some(observation));
        }
        let result: Result<Option<PowerIntent>> = async {
            let map = self.fence(db).await?;
            let current = map
                .as_ref()
                .map(|map| intent_from(map, text(db, "id")))
                .transpose()?;
            if current.as_ref().is_some_and(|v| v.mode == "quiesce") {
                return Ok(None);
            }
            if current
                .as_ref()
                .is_some_and(|v| v.revision == number(db, "generation"))
            {
                return Ok(current);
            }
            Ok(Some(PowerIntent {
                database: text(db, "id").into(),
                operation: current
                    .map(|v| v.operation)
                    .unwrap_or_else(|| text(origin, "operation_id").into()),
                revision: number(db, "generation"),
                mode: "running".into(),
            }))
        }
        .await;
        match result {
            Ok(Some(intent)) => {
                self.finish_running(db, observation, Some(&serde_json::to_value(intent)?), slot)
                    .await
            }
            Ok(None) => Ok(None),
            Err(Fault::Recovery(_)) => {
                let mut value = observation;
                value["state"] = "error".into();
                value["message"] = "running fence identity unavailable; recovery required".into();
                Ok(Some(value))
            }
            Err(_) => Ok(None),
        }
    }
    /// `slot`: the database runs in a pool slot, and its own Cluster stays hibernated.
    pub async fn finish_running(
        &self,
        db: &Value,
        observation: Value,
        execution_intent: Option<&Value>,
        slot: bool,
    ) -> std::result::Result<Option<Value>, Error> {
        if observation["state"] != "ready" {
            return Ok(Some(observation));
        }
        if !database_valid(db) {
            return Err("invalid running desired state".into());
        }
        let intent = if let Some(value) = execution_intent {
            parse_intent(value)?
        } else {
            desired_power(db)?.ok_or("wake intent missing")?
        };
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let ((physical, cluster), map) = tokio::try_join!(self.anchor(db), self.fence(db))?;
            let prior = map
                .as_ref()
                .map(|m| progress_from(m, self.now()))
                .transpose()?
                .flatten();
            if prior.as_ref().is_some_and(|p| !physical.matches(&p.anchor)) {
                return Err(Fault::Recovery("power_storage_identity_changed"));
            }
            if !slot && cluster["metadata"]["annotations"][HIBERNATION] == "on" {
                return Ok(None);
            }
            let mut progress = Progress::new(intent.clone(), Phase::Awake, physical, self.now());
            // An awake database's record says when its wake completed: another pass over it
            // leaves it as it is.
            if let Some(prior) = prior
                .as_ref()
                .filter(|p| p.phase == Phase::Awake && p.target == intent)
            {
                progress.started_at = prior.started_at;
            }
            // The gateways and the keyring the release goes to are read while the intent is
            // written: they depend on nothing of it, and the release is asked of them only after
            // it, with the read-back after the acknowledgements still comparing them.
            let (current, snapshot) = tokio::join!(
                self.write(db, map.as_ref(), Some(&intent), &progress),
                self.snapshot()
            );
            let current = current?;
            let snapshot = snapshot?;
            self.bind_fence(db, &current).await?;
            self.controls(&intent, &snapshot, "release").await?;
            // Every gateway has acknowledged the release. The read-back that the gateways and
            // the fence are still what they were released under, and the publication of the
            // target the gateway routes this revision by, need nothing of one another and are
            // issued together; the target is never written before the acknowledgements, and the
            // observation that names it is posted after both.
            let read_back = async {
                let (gateways, fence) = tokio::try_join!(self.gateways(), self.fence(db))?;
                if gateways != snapshot.pods {
                    return Ok::<bool, Fault>(false);
                }
                let fence = fence.ok_or(Fault::Stale)?;
                Ok(uid(&fence)? == uid(&current)?
                    && intent_from(&fence, text(db, "id"))? == intent)
            };
            let (confirmed, published) = tokio::join!(
                read_back,
                self.publish_target(db, Some(&current), &observation)
            );
            if !confirmed? {
                return Ok(None);
            }
            let mut value = observation.clone();
            if !db["power"].is_null() {
                value["power"] = json!({"operation":intent.operation,"revision":intent.revision,"state":"awake"});
            }
            Ok(Some((value, published)))
        })
        .await;
        Ok(match result {
            // A target that could not be published is an error of the pass, as it always was.
            Ok(Ok(Some((value, published)))) => {
                published?;
                Some(value)
            }
            Ok(Ok(None)) => None,
            Ok(Err(Fault::Recovery(_))) => {
                let mut value = observation;
                value["state"] = "error".into();
                value["message"] = "wake storage identity changed; recovery required".into();
                Some(value)
            }
            _ => None,
        })
    }
    /// Writes the target the gateway routes the running revision of `db` to by into its fence:
    /// the Pod, its container and the CA that the v2 runtime attestation of `observation`
    /// names. `fence` is the fence as the running intent was written, or read here. Nothing is
    /// written for an observation without such an attestation, or while the controller's watch
    /// no longer holds the objects it names at the versions it names.
    pub(crate) async fn publish_target(
        &self,
        db: &Value,
        fence: Option<&Value>,
        observation: &Value,
    ) -> std::result::Result<(), Error> {
        let proof = &observation["runtime_attestation"];
        if proof["v"] != 2 {
            return Ok(());
        }
        let read;
        let map = match fence {
            Some(map) => map,
            None => {
                read = self
                    .fence(db)
                    .await?
                    .ok_or("admitted running fence missing")?;
                &read
            }
        };
        let intent: Value = serde_json::from_str(text(&map["data"], "intent.json"))?;
        if intent["database"] != db["id"]
            || intent["revision"] != db["generation"]
            || intent["mode"] != "running"
        {
            return Err("admitted fence revision changed".into());
        }
        let target = json!({"v":1,"generation":proof["generation"],"route_revision":proof["route_revision"],"admission_epoch":proof["admission_epoch"],"pod_uid":proof["pod_uid"],"container_id":proof["container_id"],"ca_secret_uid":proof["ca_secret_uid"],"ca_secret_resource_version":proof["ca_secret_resource_version"],"ca_sha256":proof["ca_sha256"],"tls_server_name":proof["tls_server_name"]});
        if !valid_schema("gatewayAdmissionTarget", &target) {
            return Err("admitted target contract invalid".into());
        }
        if !self.k8s.runtime_proof_current(proof) {
            return Err("runtime proof changed before target publication".into());
        }
        if let Some(raw) = map["data"]["admission_target"].as_str() {
            let prior: Value = serde_json::from_str(raw)?;
            if !valid_schema("gatewayAdmissionTarget", &prior)
                || prior["route_revision"].as_u64() > target["route_revision"].as_u64()
                || prior["admission_epoch"].as_u64() > target["admission_epoch"].as_u64()
                || prior["generation"].as_u64() > target["generation"].as_u64()
            {
                return Err("admitted target history regressed".into());
            }
            if prior == target {
                return Ok(());
            }
        }
        self.k8s
            .patch(
                map,
                &json!({"data":{"admission_target":serde_json::to_string(&target)?}}),
            )
            .await?;
        if !self.k8s.runtime_proof_current(proof) {
            return Err("runtime proof changed during target publication".into());
        }
        Ok(())
    }
}
fn storage_class(db: &Value) -> Result<&str> {
    if db["storage"].is_null() {
        return Ok("pgcf-lvm");
    }
    let profile = &db["storage"];
    let hash = text(profile, "profile_sha256");
    let class = text(profile, "storage_class");
    if profile["backend"] != "lvm-thin-v1"
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
        || class != format!("pgcf-lvm-thin-v1-{}", &hash[..16])
    {
        return Err(Fault::Recovery("storage_profile_identity_changed"));
    }
    Ok(class)
}
fn delete_state(ledger: &Value, now: u64) -> Result<DeleteState> {
    let raw = required(text(&ledger["data"], "state"), 32768)?;
    let value: Value =
        serde_json::from_str(raw).map_err(|_| Fault::Recovery("delete_ledger_invalid"))?;
    let state: DeleteState =
        serde_json::from_value(value).map_err(|_| Fault::Recovery("delete_ledger_invalid"))?;
    if state.started_at > now
        || state.started_at > MAX_SAFE
        || state.volumes.len() > 100
        || state
            .namespace_uid
            .as_deref()
            .is_some_and(|v| v.is_empty() || v.len() > 253)
    {
        return Err(Fault::Recovery("delete_ledger_invalid"));
    }
    let mut volumes = HashSet::new();
    for volume in &state.volumes {
        for field in [&volume.name, &volume.uid, &volume.claim_uid, &volume.handle] {
            required(field, 253)?;
        }
        if !volumes.insert(&volume.name) {
            return Err(Fault::Recovery("delete_ledger_invalid"));
        }
        if let Some(lvm) = &volume.lvm {
            required(&lvm.name, 253)?;
            required(&lvm.namespace, 253)?;
            required(&lvm.uid, 253)?;
        }
    }
    Ok(state)
}
fn operation_id() -> Result<String> {
    let alphabet = POWER_CONTRACT["constants"]["ID_ALPHABET"]
        .as_str()
        .expect("generated alphabet")
        .as_bytes();
    let mut result = String::from("op_");
    let bound = 256 / alphabet.len() * alphabet.len();
    let provider = rustls::crypto::ring::default_provider();
    while result.len() < 23 {
        let mut bytes = [0; 32];
        provider
            .secure_random
            .fill(&mut bytes)
            .map_err(|_| Fault::Unavailable("operation_identity_unavailable"))?;
        for byte in bytes {
            if (byte as usize) < bound {
                result.push(alphabet[byte as usize % alphabet.len()] as char);
                if result.len() == 23 {
                    break;
                }
            }
        }
    }
    Ok(result)
}
fn receipt_from(ledger: &Value, db: &Value, now: u64) -> Result<Option<RetirementReceipt>> {
    let Some(raw) = ledger["data"]["gateway-retirement.json"].as_str() else {
        if !ledger["data"]["gateway-retirement.json"].is_null() {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        return Ok(None);
    };
    required(raw, 4096)?;
    let raw: Value = serde_json::from_str(raw)
        .map_err(|_| Fault::Recovery("gateway_retirement_recovery_required"))?;
    parse_intent(&raw["intent"])?;
    let receipt: RetirementReceipt = serde_json::from_value(raw)
        .map_err(|_| Fault::Recovery("gateway_retirement_recovery_required"))?;
    if !valid_pattern("uuid", &receipt.marker_uid)
        || receipt.intent.database != text(db, "id")
        || receipt.intent.revision != number(db, "generation")
        || receipt.intent.mode != "retired"
        || !["published", "deleting"].contains(&receipt.phase.as_str())
        || timestamp(&receipt.observed_at, now)? < timestamp(&receipt.published_at, now)?
    {
        return Err(Fault::Recovery("gateway_retirement_recovery_required"));
    }
    if receipt.phase == "deleting" {
        required(receipt.marker_version.as_deref().unwrap_or(""), 128)?;
    }
    Ok(Some(receipt))
}
impl PowerCoordinator {
    async fn ledger(&self, db: &Value) -> Result<Value> {
        let id = text(db, "id");
        let name = format!("delete-{id}");
        let ledger = owned(
            self.k8s.read("ConfigMap", Some(SYSTEM), &name).await?,
            &name,
            id,
            Some(SYSTEM),
            false,
        )?;
        if generation(&ledger) != number(db, "generation") {
            return Err(Fault::Recovery("delete_ledger_identity_changed"));
        }
        Ok(ledger)
    }
    async fn save_delete(
        &self,
        db: &Value,
        state: &DeleteState,
        current: Option<&Value>,
    ) -> Result<Value> {
        let id = text(db, "id");
        let name = format!("delete-{id}");
        let mut data = current
            .and_then(|v| v["data"].as_object())
            .cloned()
            .unwrap_or_default();
        data.insert(
            "state".into(),
            serde_json::to_string(state)
                .map_err(|_| Fault::Recovery("delete_ledger_invalid"))?
                .into(),
        );
        if let Some(current) = current {
            self.k8s.patch(current,&json!({"metadata":{"annotations":{GENERATION:number(db,"generation").to_string()}},"data":data})).await?;
        } else {
            self.k8s.create(&json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"labels":{DATABASE_LABEL:id},"annotations":{GENERATION:number(db,"generation").to_string()}},"data":data})).await?;
        }
        let ledger = self.ledger(db).await?;
        let actual = delete_state(&ledger, self.now())?;
        if serde_json::to_value(actual).unwrap() != serde_json::to_value(state).unwrap() {
            return Err(Fault::Recovery("delete_ledger_identity_changed"));
        }
        Ok(ledger)
    }
    async fn save_receipt(
        &self,
        db: &Value,
        ledger: &Value,
        receipt: &RetirementReceipt,
    ) -> Result<Value> {
        let mut data = ledger["data"]
            .as_object()
            .cloned()
            .ok_or(Fault::Recovery("delete_ledger_invalid"))?;
        data.insert(
            "gateway-retirement.json".into(),
            serde_json::to_string(receipt).unwrap().into(),
        );
        self.k8s.patch(ledger, &json!({"data":data})).await?;
        let current = self.ledger(db).await?;
        if receipt_from(&current, db, self.now())?
            .as_ref()
            .map(|v| serde_json::to_value(v).unwrap())
            != Some(serde_json::to_value(receipt).unwrap())
        {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        Ok(current)
    }
    async fn reclaimed(&self, db: &Value, ledger: &Value) -> Result<()> {
        if generation(ledger) != number(db, "generation") {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        let state = delete_state(ledger, self.now())?;
        if state
            .namespace_uid
            .as_deref()
            .is_some_and(|v| !valid_pattern("uuid", v))
        {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        let ns = namespace(db);
        let (namespace, pvs, lvs) = tokio::try_join!(
            self.k8s.read("Namespace", None, &ns),
            self.k8s.list("PersistentVolume", None, None),
            self.k8s.list("LVMVolume", None, None)
        )?;
        if namespace.is_some()
            || pvs.iter().any(|pv| {
                pv["spec"]["claimRef"]["namespace"] == ns
                    || state.volumes.iter().any(|v| {
                        pv["metadata"]["name"] == v.name
                            || pv["metadata"]["uid"] == v.uid
                            || pv["spec"]["csi"]["volumeHandle"] == v.handle
                    })
            })
            || lvs.iter().any(|lv| {
                lv["metadata"]["labels"][DATABASE_LABEL] == db["id"]
                    || state.volumes.iter().any(|v| {
                        lv["metadata"]["name"] == v.handle
                            || v.lvm
                                .as_ref()
                                .is_some_and(|owned| lv["metadata"]["uid"] == owned.uid)
                    })
            })
        {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        Ok(())
    }
    pub async fn retire_gateway_fence(&self, db: &Value) -> std::result::Result<bool, Error> {
        if !database_valid(db) || text(db, "desired_state") != "deleted" {
            return Err("invalid gateway retirement desired state".into());
        }
        match tokio::time::timeout(Duration::from_secs(10), self.retire_step(db)).await {
            Ok(Ok(result)) => Ok(result),
            _ => Err("gateway_retirement_recovery_required".into()),
        }
    }
    async fn retire_step(&self, db: &Value) -> Result<bool> {
        let id = text(db, "id");
        let name = format!("gateway-fence-{id}");
        let storage_name = format!("storage-{id}");
        let mut ledger = self.ledger(db).await?;
        self.reclaimed(db, &ledger).await?;
        let mut receipt = receipt_from(&ledger, db, self.now())?;
        let mut map = self.k8s.read("ConfigMap", Some(SYSTEM), &name).await?;
        let storage = self
            .k8s
            .read("ConfigMap", Some(SYSTEM), &storage_name)
            .await?;
        if let Some(storage) = &storage {
            owned(
                Some(storage.clone()),
                &storage_name,
                id,
                Some(SYSTEM),
                false,
            )?;
        }
        let bound = storage
            .as_ref()
            .and_then(|v| v["metadata"]["annotations"][FENCE_BINDING].as_str());
        let Some(initial) = map.take() else {
            if receipt.as_ref().is_some_and(|v| {
                v.phase == "deleting"
                    && timestamp(&v.observed_at, self.now()).is_ok_and(|t| {
                        self.now().saturating_sub(t)
                            >= pgcf_native_protocol::constant("GATEWAY_RETIRE_HOLD_MS")
                    })
            }) {
                return Ok(true);
            }
            if receipt.is_some() {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            if bound.is_none()
                && (delete_state(&ledger, self.now())?.completed
                    || db["creation"]["ever_ready"] == false)
            {
                return Ok(true);
            }
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        };
        let mut current = owned(Some(initial), &name, id, Some(SYSTEM), true)?;
        if current["kind"] != "ConfigMap"
            || bound.is_some_and(|expected| current["metadata"]["uid"] != expected)
            || receipt
                .as_ref()
                .is_some_and(|v| current["metadata"]["uid"] != v.marker_uid)
        {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        let mut intent = intent_from(&current, id)?;
        if !current["metadata"]["deletionTimestamp"].is_null() {
            let r = receipt
                .as_ref()
                .ok_or(Fault::Recovery("gateway_retirement_recovery_required"))?;
            if r.phase != "deleting"
                || r.intent != intent
                || current["data"]["retired-at"] != r.published_at
            {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            return Ok(false);
        }
        if receipt.as_ref().is_some_and(|v| {
            v.phase == "deleting"
                && v.marker_version.as_deref()
                    != Some(text(&current["metadata"], "resourceVersion"))
        }) {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        if intent.revision > number(db, "generation") {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        if intent.mode != "retired" {
            if receipt.is_some() || intent.revision >= number(db, "generation") {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            intent = PowerIntent {
                database: id.into(),
                operation: operation_id()?,
                revision: number(db, "generation"),
                mode: "retired".into(),
            };
            let published = iso(self.now())?;
            let mut data = current["data"]
                .as_object()
                .cloned()
                .ok_or(Fault::Recovery("gateway_retirement_recovery_required"))?;
            data.insert(
                "intent.json".into(),
                serde_json::to_string(&intent).unwrap().into(),
            );
            data.insert("retired-at".into(), published.clone().into());
            self.k8s.patch(&current, &json!({"data":data})).await?;
            let actual = owned(
                self.k8s.read("ConfigMap", Some(SYSTEM), &name).await?,
                &name,
                id,
                Some(SYSTEM),
                false,
            )?;
            if uid(&actual)? != uid(&current)?
                || intent_from(&actual, id)? != intent
                || actual["data"]["retired-at"] != published
            {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            current = actual;
            receipt = Some(RetirementReceipt {
                marker_uid: uid(&current)?.into(),
                intent: intent.clone(),
                published_at: published,
                observed_at: iso(self.now())?,
                phase: "published".into(),
                marker_version: None,
            });
        } else {
            if intent.revision != number(db, "generation") {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            let published = text(&current["data"], "retired-at");
            timestamp(published, self.now())?;
            if receipt
                .as_ref()
                .is_some_and(|v| v.published_at != published || v.intent != intent)
            {
                return Err(Fault::Recovery("gateway_retirement_recovery_required"));
            }
            if receipt.is_none() {
                receipt = Some(RetirementReceipt {
                    marker_uid: uid(&current)?.into(),
                    intent: intent.clone(),
                    published_at: published.into(),
                    observed_at: iso(self.now())?,
                    phase: "published".into(),
                    marker_version: None,
                });
            }
        }
        let receipt = receipt.ok_or(Fault::Recovery("gateway_retirement_recovery_required"))?;
        if ledger["data"]["gateway-retirement.json"].is_null() {
            ledger = self.save_receipt(db, &ledger, &receipt).await?;
        }
        if self
            .now()
            .saturating_sub(timestamp(&receipt.observed_at, self.now())?)
            < pgcf_native_protocol::constant("GATEWAY_RETIRE_HOLD_MS")
        {
            return Ok(false);
        }
        let snapshot = self.snapshot().await?;
        self.controls(&intent, &snapshot, "retire").await?;
        self.reclaimed(db, &ledger).await?;
        if !snapshot.same_identity(&self.snapshot().await?) {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        let actual = owned(
            self.k8s.read("ConfigMap", Some(SYSTEM), &name).await?,
            &name,
            id,
            Some(SYSTEM),
            false,
        )?;
        if uid(&actual)? != uid(&current)?
            || rv(&actual)? != rv(&current)?
            || actual["data"] != current["data"]
        {
            return Err(Fault::Recovery("gateway_retirement_recovery_required"));
        }
        ledger = self.ledger(db).await?;
        let pending = RetirementReceipt {
            phase: "deleting".into(),
            marker_version: Some(rv(&actual)?.into()),
            ..receipt.clone()
        };
        self.save_receipt(db, &ledger, &pending).await?;
        self.k8s.delete(&actual, "Background").await?;
        let remaining = self.k8s.read("ConfigMap", Some(SYSTEM), &name).await?;
        let Some(remaining) = remaining else {
            return Ok(true);
        };
        let remaining = owned(Some(remaining), &name, id, Some(SYSTEM), true)?;
        if !remaining["metadata"]["deletionTimestamp"].is_null()
            && uid(&remaining)? == uid(&actual)?
            && intent_from(&remaining, id)? == intent
            && remaining["data"]["retired-at"] == receipt.published_at
        {
            return Ok(false);
        }
        Err(Fault::Recovery("gateway_retirement_recovery_required"))
    }
    pub async fn delete_database(
        &self,
        db: &Value,
        storage_nodes: &Value,
    ) -> std::result::Result<Option<Value>, Error> {
        if !database_valid(db) || text(db, "desired_state") != "deleted" {
            return Err("invalid deleted desired state".into());
        }
        Ok(
            match tokio::time::timeout(Duration::from_secs(10), self.delete_step(db, storage_nodes))
                .await
            {
                Ok(Ok(value)) => value,
                Ok(Err(Fault::Stale)) | Err(_) => None,
                Ok(Err(Fault::Recovery(message))) => Some(recovery_observation(db, message)),
                Ok(Err(_)) => Some(recovery_observation(
                    db,
                    "storage deletion could not be verified",
                )),
            },
        )
    }
    async fn delete_step(&self, db: &Value, storage_nodes: &Value) -> Result<Option<Value>> {
        let id = text(db, "id");
        let ns = namespace(db);
        let ledger_name = format!("delete-{id}");
        let storage_name = format!("storage-{id}");
        let (namespace_value, ledger_value, storage_value) = tokio::try_join!(
            self.k8s.read("Namespace", None, &ns),
            self.k8s.read("ConfigMap", Some(SYSTEM), &ledger_name),
            self.k8s.read("ConfigMap", Some(SYSTEM), &storage_name)
        )?;
        let namespace_value = namespace_value
            .map(|v| owned(Some(v), &ns, id, None, true))
            .transpose()?;
        let ledger = ledger_value
            .map(|v| owned(Some(v), &ledger_name, id, Some(SYSTEM), false))
            .transpose()?;
        let storage = storage_value
            .map(|v| owned(Some(v), &storage_name, id, Some(SYSTEM), false))
            .transpose()?;
        let mut high_water = 0;
        for value in [&namespace_value, &ledger, &storage].into_iter().flatten() {
            high_water = high_water.max(generation(value));
            high_water = high_water.max(
                value["metadata"]["annotations"]["pgcf.io/accepted-generation"]
                    .as_str()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            );
        }
        if high_water > number(db, "generation") {
            return Err(Fault::Stale);
        }
        if let Some(storage) = &storage {
            let raw: Value = serde_json::from_str(required(text(&storage["data"], "state"), 4096)?)
                .map_err(|_| Fault::Recovery("storage_fence_invalid"))?;
            if raw["storage"] != db["storage"] || raw["node"] != db["node"] {
                return Err(Fault::Recovery("delete_storage_profile_changed"));
            }
            if namespace_value.as_ref().is_some_and(|namespace| {
                raw["namespaceUid"]
                    .as_str()
                    .is_some_and(|bound| namespace["metadata"]["uid"] != bound)
            }) {
                return Err(Fault::Recovery("delete_namespace_identity_changed"));
            }
        }
        let mut state = if let Some(ledger) = &ledger {
            delete_state(ledger, self.now())?
        } else {
            DeleteState {
                started_at: self.now(),
                namespace_uid: namespace_value
                    .as_ref()
                    .map(|v| uid(v).map(String::from))
                    .transpose()?,
                volumes: vec![],
                completed: false,
                physical_lv_uuid: None,
            }
        };
        if namespace_value.as_ref().is_some_and(|v| {
            state
                .namespace_uid
                .as_deref()
                .is_some_and(|saved| v["metadata"]["uid"] != saved)
        }) {
            return Err(Fault::Recovery("delete_namespace_identity_changed"));
        }
        let mut physical_changed = false;
        if !db["storage"].is_null()
            && !state.completed
            && let Some(storage) = &storage
            && storage["metadata"]["annotations"][VOLUME_IDENTITY].is_string()
        {
            let identity: Value = serde_json::from_str(required(
                text(&storage["metadata"]["annotations"], VOLUME_IDENTITY),
                4096,
            )?)
            .map_err(|_| Fault::Recovery("delete_physical_volume_identity_invalid"))?;
            let actual = required(text(&identity, "lvUuid"), 64)?;
            if !valid_pattern("storageLvmUuid", actual) {
                return Err(Fault::Recovery("delete_physical_volume_identity_invalid"));
            }
            if state
                .physical_lv_uuid
                .as_deref()
                .is_some_and(|saved| saved != actual)
            {
                return Err(Fault::Recovery("delete_physical_volume_identity_changed"));
            }
            if state.physical_lv_uuid.is_none() {
                state.physical_lv_uuid = Some(actual.into());
                physical_changed = true;
            }
        }
        let (pvs, lvs) = tokio::try_join!(
            self.k8s.list("PersistentVolume", None, None),
            self.k8s.list("LVMVolume", None, None)
        )?;
        let mut changed = physical_changed
            || ledger
                .as_ref()
                .is_none_or(|v| generation(v) != number(db, "generation"));
        let expected_class = storage_class(db)?;
        for pv in pvs
            .iter()
            .filter(|pv| pv["spec"]["claimRef"]["namespace"] == ns)
        {
            let spec = &pv["spec"];
            let reference = &spec["claimRef"];
            let handle = required(text(&spec["csi"], "volumeHandle"), 253)?;
            let claim_uid = required(text(reference, "uid"), 253)?;
            if spec["storageClassName"] != expected_class
                || spec["csi"]["driver"] != "local.csi.openebs.io"
            {
                return Err(Fault::Recovery("delete_volume_ownership_invalid"));
            }
            if !db["storage"].is_null()
                && state.physical_lv_uuid.is_none()
                && let (Some(authority), Some(storage), Some(namespace_value)) = (
                    physical_authority(db, storage_nodes, state.started_at, self.now()),
                    storage.as_ref(),
                    namespace_value.as_ref(),
                )
            {
                let stored: Value =
                    serde_json::from_str(required(text(&storage["data"], "state"), 4096)?)
                        .map_err(|_| Fault::Recovery("storage_fence_invalid"))?;
                let receipts = authority["volumes"]
                    .as_array()
                    .ok_or(Fault::Recovery("delete_physical_custody_invalid"))?
                    .iter()
                    .filter(|volume| {
                        volume["database_id"] == db["id"]
                            && volume["storage_uid"] == storage["metadata"]["uid"]
                            && volume["namespace_uid"] == namespace_value["metadata"]["uid"]
                            && volume["cluster_uid"] == stored["clusterUid"]
                            && volume["volume_handle"] == handle
                            && volume["pvc_uid"] == claim_uid
                            && volume["pv_uid"] == pv["metadata"]["uid"]
                    })
                    .collect::<Vec<_>>();
                if receipts.len() > 1 {
                    return Err(Fault::Recovery("delete_physical_custody_ambiguous"));
                }
                if let Some(receipt) = receipts.first() {
                    let expected_generation = text(&db["archive"], "destination_path")
                        .rsplit('/')
                        .next()
                        .and_then(|part| part.strip_prefix('g'))
                        .and_then(|part| part.split_once('-'))
                        .and_then(|(generation, _)| generation.parse::<u64>().ok());
                    if number(receipt, "generation") > number(db, "generation")
                        || Some(number(receipt, "storage_generation")) != expected_generation
                        || !valid_pattern("storageLvmUuid", text(receipt, "lv_uuid"))
                    {
                        return Err(Fault::Recovery("delete_physical_custody_changed"));
                    }
                    let claim = self
                        .k8s
                        .read(
                            "PersistentVolumeClaim",
                            Some(&ns),
                            required(text(reference, "name"), 253)?,
                        )
                        .await?
                        .ok_or(Fault::Recovery("delete_physical_claim_missing"))?;
                    if claim["metadata"]["uid"] != claim_uid
                        || claim["spec"]["volumeName"] != pv["metadata"]["name"]
                        || claim["spec"]["storageClassName"] != expected_class
                    {
                        return Err(Fault::Recovery("delete_physical_claim_changed"));
                    }
                    state.physical_lv_uuid = Some(text(receipt, "lv_uuid").into());
                    changed = true;
                }
            }
            if let Some(old) = state
                .volumes
                .iter()
                .find(|old| pv["metadata"]["name"] == old.name)
            {
                if uid(pv)? != old.uid || claim_uid != old.claim_uid || handle != old.handle {
                    return Err(Fault::Recovery("delete_volume_identity_changed"));
                }
            } else {
                let matches: Vec<_> = lvs
                    .iter()
                    .filter(|lv| lv["metadata"]["name"] == handle)
                    .collect();
                if matches.len() > 1 {
                    return Err(Fault::Recovery("delete_lvm_identity_ambiguous"));
                }
                let lvm = matches
                    .first()
                    .map(|lv| {
                        Ok::<_, Fault>(LvmIdentity {
                            name: required(text(&lv["metadata"], "name"), 253)?.into(),
                            namespace: required(text(&lv["metadata"], "namespace"), 253)?.into(),
                            uid: uid(lv)?.into(),
                        })
                    })
                    .transpose()?;
                state.volumes.push(DeleteVolume {
                    name: required(text(&pv["metadata"], "name"), 253)?.into(),
                    uid: uid(pv)?.into(),
                    claim_uid: claim_uid.into(),
                    handle: handle.into(),
                    lvm,
                });
                changed = true;
            }
        }
        let no_allocation = !db["storage"].is_null()
            && !state.completed
            && state.physical_lv_uuid.is_none()
            && namespace_value.is_none()
            && storage.is_none()
            && state.namespace_uid.is_none()
            && state.volumes.is_empty()
            && db["creation"]["ever_ready"] != true
            && db["recovery"]["ever_ready"] != true
            && (db["creation"]["ever_ready"] == false || db["recovery"]["ever_ready"] == false)
            && !pvs.iter().any(|pv| {
                pv["spec"]["claimRef"]["namespace"] == ns || mentions_subject(pv, id, &ns)
            })
            && !lvs.iter().any(|lv| mentions_subject(lv, id, &ns));
        if !db["storage"].is_null() && !state.completed && state.physical_lv_uuid.is_none() {
            if changed {
                self.save_delete(db, &state, ledger.as_ref()).await?;
                changed = false;
            }
            if !no_allocation
                || !physical_unallocated(db, storage_nodes, state.started_at, self.now())
            {
                let failed = self.now().saturating_sub(state.started_at) >= MAX_WAIT;
                return Ok(Some(
                    json!({"id":db["id"],"generation":db["generation"],"state":if failed{"error"}else{"deleting"},"message":if no_allocation{"Waiting for fresh complete no-allocation proof"}else{"Waiting for exact Native physical-volume custody; no LV identity is synthesized"},"archive":{"continuous":false,"ready_wal_files":null}}),
                ));
            }
        }
        if state.completed && (namespace_value.is_some() || !state.volumes.is_empty()) {
            return Err(Fault::Recovery("delete_terminal_identity_conflict"));
        }
        if changed {
            self.save_delete(db, &state, ledger.as_ref()).await?;
        }
        for volume in &state.volumes {
            if let Some(pv) = pvs.iter().find(|pv| pv["metadata"]["name"] == volume.name) {
                if uid(pv)? != volume.uid
                    || pv["spec"]["claimRef"]["uid"] != volume.claim_uid
                    || pv["spec"]["claimRef"]["namespace"] != ns
                {
                    return Err(Fault::Recovery("delete_volume_identity_changed"));
                }
                if pv["spec"]["persistentVolumeReclaimPolicy"] != "Delete" {
                    let actual = self
                        .k8s
                        .patch(
                            pv,
                            &json!({"spec":{"persistentVolumeReclaimPolicy":"Delete"}}),
                        )
                        .await?;
                    if actual["spec"]["persistentVolumeReclaimPolicy"] != "Delete" {
                        return Err(Fault::Unavailable("delete_policy_result_unknown"));
                    }
                }
            }
        }
        if let Some(namespace) = &namespace_value
            && namespace["metadata"]["deletionTimestamp"].is_null()
        {
            self.k8s.delete(namespace, "Background").await?;
        }
        let (remaining_namespace, remaining_pvs, remaining_lvs) = tokio::try_join!(
            self.k8s.read("Namespace", None, &ns),
            self.k8s.list("PersistentVolume", None, None),
            self.k8s.list("LVMVolume", None, None)
        )?;
        let remains = remaining_namespace.is_some()
            || remaining_pvs.iter().any(|pv| {
                pv["spec"]["claimRef"]["namespace"] == ns
                    || state
                        .volumes
                        .iter()
                        .any(|v| pv["metadata"]["name"] == v.name)
            })
            || remaining_lvs.iter().any(|lv| {
                state
                    .volumes
                    .iter()
                    .any(|v| lv["metadata"]["name"] == v.handle)
            });
        if remains {
            let failed = self.now().saturating_sub(state.started_at) >= MAX_WAIT;
            let mut value = json!({"id":db["id"],"generation":db["generation"],"state":if failed{"error"}else{"deleting"},"archive":{"continuous":false,"ready_wal_files":null}});
            if failed {
                value["message"] = "storage deletion did not complete within ten minutes".into();
            }
            return Ok(Some(value));
        }
        if !db["storage"].is_null()
            && !state.completed
            && !no_allocation
            && !physical_reclaimed(
                db,
                storage_nodes,
                state
                    .physical_lv_uuid
                    .as_deref()
                    .ok_or(Fault::Recovery("delete_physical_volume_identity_missing"))?,
                state.started_at,
                self.now(),
            )
        {
            return Ok(Some(
                json!({"id":db["id"],"generation":db["generation"],"state":"deleting","message":"Waiting for fresh physical LV reclamation proof","archive":{"continuous":false,"ready_wal_files":null}}),
            ));
        }
        let fence_name = format!("gateway-fence-{id}");
        let gateway_fence = self
            .k8s
            .read("ConfigMap", Some(SYSTEM), &fence_name)
            .await?;
        let current_ledger = self.ledger(db).await?;
        if (gateway_fence.is_some()
            || storage
                .as_ref()
                .is_some_and(|v| !v["metadata"]["annotations"][FENCE_BINDING].is_null())
            || !current_ledger["data"]["gateway-retirement.json"].is_null())
            && !self.retire_step(db).await?
        {
            return Ok(Some(
                json!({"id":db["id"],"generation":db["generation"],"state":"deleting","archive":{"continuous":false,"ready_wal_files":null}}),
            ));
        }
        let ca_name = format!("ca-{id}");
        if let Some(ca) = self.k8s.read("ConfigMap", Some(SYSTEM), &ca_name).await? {
            let ca = owned(Some(ca), &ca_name, id, Some(SYSTEM), false)?;
            self.k8s.delete(&ca, "Background").await?;
            if self
                .k8s
                .read("ConfigMap", Some(SYSTEM), &ca_name)
                .await?
                .is_some()
            {
                return Ok(None);
            }
        }
        if let Some(old) = storage {
            let fresh = owned(
                self.k8s
                    .read("ConfigMap", Some(SYSTEM), &storage_name)
                    .await?,
                &storage_name,
                id,
                Some(SYSTEM),
                false,
            )?;
            if uid(&fresh)? != uid(&old)? {
                return Err(Fault::Recovery("storage_fence_identity_changed"));
            }
            self.k8s.delete(&fresh, "Background").await?;
            if self
                .k8s
                .read("ConfigMap", Some(SYSTEM), &storage_name)
                .await?
                .is_some()
            {
                return Ok(None);
            }
        }
        if !state.completed {
            state.completed = true;
            state.volumes.clear();
            state.namespace_uid = None;
            state.physical_lv_uuid = None;
            self.save_delete(db, &state, Some(&self.ledger(db).await?))
                .await?;
        }
        Ok(Some(
            json!({"id":db["id"],"generation":db["generation"],"state":"deleted","archive":{"continuous":false,"ready_wal_files":0}}),
        ))
    }
}
fn physical_authority<'a>(db: &Value, nodes: &'a Value, after: u64, now: u64) -> Option<&'a Value> {
    let nodes = nodes.as_array().filter(|rows| rows.len() <= 64)?;
    let matching: Vec<_> = nodes
        .iter()
        .filter(|v| v["node_uid"] == db["storage"]["node_uid"] && v["name"] == db["node"])
        .collect();
    if matching.len() != 1 {
        return None;
    }
    let value = matching[0];
    if !crate::contracts::schema_valid("NodeThinStorageAuthority", value)
        || value["volume_group_uuid"] != db["storage"]["volume_group_uuid"]
        || value["profile_sha256"] != db["storage"]["profile_sha256"]
        || number(value, "profile_revision") < number(&db["storage"], "profile_revision")
    {
        return None;
    }
    let parse = |key: &str| -> Option<u64> {
        let raw = text(value, key);
        let parsed =
            time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
                .ok()?;
        let millis: u64 = (parsed.unix_timestamp_nanos() / 1_000_000)
            .try_into()
            .ok()?;
        (iso(millis).ok()?.as_str() == raw).then_some(millis)
    };
    let (Some(observed), Some(expires)) = (parse("observed_at"), parse("expires_at")) else {
        return None;
    };
    // LVs, volumes and receipts are the identity proof's read. A fast renewal moves only
    // observed_at, so a read after the deletion is judged by the proof's own times, which an
    // authority recorded before composition shares with its reading.
    let (read, valid) = match (
        value.get("inventory_observed_at"),
        value.get("inventory_expires_at"),
        value.get("inventory_revision"),
    ) {
        (None, None, None) => (observed, expires),
        (Some(_), Some(_), Some(_)) => {
            let read = parse("inventory_observed_at")?;
            let valid = parse("inventory_expires_at")?;
            let maximum = crate::contracts::constant("THIN_INVENTORY_MAX_SECONDS").as_u64()?;
            if valid <= read
                || valid - read > maximum * 1000
                || read > observed
                || expires > valid
                || crate::contracts::integer(value, "inventory_revision").ok()?
                    > number(value, "revision")
            {
                return None;
            }
            (read, valid)
        }
        _ => return None,
    };
    (value["physical"]["volume_group_uuid"] == value["volume_group_uuid"]
        && value["pool_uuid"].is_null() == value["physical"]["thin_pool"].is_null()
        && expires > observed
        && expires - observed <= 120_000
        && read > after
        && read >= now.saturating_sub(120_000)
        && read <= now.saturating_add(5000)
        && valid > now
        && value["data_accounting_complete"] == true)
        .then_some(value)
}
/// Materialize an already observed Native volume, not a writer or a guessed device identity.
/// This is the same physical custody used by deletion, before a Ready Pod can provide IO proof.
pub(crate) fn native_volume_identity(
    db: &Value,
    authority: &Value,
    scope: (&Value, &Value, &Value),
    binding: (&Value, &Value),
    now: u64,
) -> Option<Value> {
    let (namespace_value, cluster, storage) = scope;
    let (claim, pv) = binding;
    let ns = namespace(db);
    let nodes = json!([authority]);
    physical_authority(db, &nodes, 0, now)?;
    if authority["pool_uuid"] != db["storage"]["pool_uuid"]
        || authority["storage_class"] != db["storage"]["storage_class"]
        || [&namespace_value, &cluster, &storage].iter().any(|value| {
            generation(value) > number(db, "generation")
                || !annotation_number(value, "pgcf.io/accepted-generation").is_ok_and(
                    |generation| generation.is_none_or(|g| g <= number(db, "generation")),
                )
        })
    {
        return None;
    }
    owned(
        Some(namespace_value.clone()),
        &ns,
        text(db, "id"),
        None,
        false,
    )
    .ok()?;
    owned(
        Some(cluster.clone()),
        "database",
        text(db, "id"),
        Some(&ns),
        false,
    )
    .ok()?;
    owned(
        Some(storage.clone()),
        &format!("storage-{}", text(db, "id")),
        text(db, "id"),
        Some(SYSTEM),
        false,
    )
    .ok()?;
    let stored: Value = serde_json::from_str(storage["data"]["state"].as_str()?).ok()?;
    if stored["namespaceUid"] != namespace_value["metadata"]["uid"]
        || stored["clusterUid"] != cluster["metadata"]["uid"]
        || stored["node"] != db["node"]
        || stored["archivePath"] != db["archive"]["destination_path"]
        || stored["storage"] != db["storage"]
        || !crate::reconcile::cluster_owned(claim, cluster)
        || claim["metadata"]["namespace"] != ns
        || !claim["metadata"]["deletionTimestamp"].is_null()
        || !pv["metadata"]["deletionTimestamp"].is_null()
        || claim["status"]["phase"] != "Bound"
        || pv["status"]["phase"] != "Bound"
        || claim["spec"]["volumeName"] != pv["metadata"]["name"]
        || pv["spec"]["claimRef"]["uid"] != claim["metadata"]["uid"]
        || pv["spec"]["claimRef"]["name"] != claim["metadata"]["name"]
        || pv["spec"]["claimRef"]["namespace"] != ns
        || pv["spec"]["csi"]["driver"] != "local.csi.openebs.io"
        || claim["spec"]["storageClassName"] != db["storage"]["storage_class"]
        || pv["spec"]["storageClassName"] != db["storage"]["storage_class"]
        || claim["spec"]["volumeAttributesClassName"] != db["storage"]["volume_attributes_class"]
        || claim["status"]["currentVolumeAttributesClassName"]
            != db["storage"]["volume_attributes_class"]
        || !claim["status"]["modifyVolumeStatus"].is_null()
        || !crate::reconcile::pinned_to_node(pv, text(db, "node"))
    {
        return None;
    }
    let capacity = number(&db["size"], "storage_gib") as f64 * 2_f64.powi(30);
    if crate::reconcile::quantity(&claim["spec"]["resources"]["requests"]["storage"])
        != Some(capacity)
        || crate::reconcile::quantity(&claim["status"]["capacity"]["storage"]) != Some(capacity)
        || crate::reconcile::quantity(&pv["spec"]["capacity"]["storage"]) != Some(capacity)
    {
        return None;
    }
    let receipts = authority["volumes"]
        .as_array()?
        .iter()
        .filter(|receipt| {
            receipt["database_id"] == db["id"]
                && receipt["generation"] == db["generation"]
                && number(receipt, "storage_generation")
                    == db["storage_generation"].as_u64().unwrap_or(1)
        })
        .collect::<Vec<_>>();
    if receipts.len() != 1 {
        return None;
    }
    let receipt = receipts[0];
    if receipt["storage_uid"] != storage["metadata"]["uid"]
        || receipt["namespace_uid"] != namespace_value["metadata"]["uid"]
        || receipt["cluster_uid"] != cluster["metadata"]["uid"]
        || receipt["pvc_uid"] != claim["metadata"]["uid"]
        || receipt["pv_uid"] != pv["metadata"]["uid"]
        || receipt["volume_handle"] != pv["spec"]["csi"]["volumeHandle"]
        || receipt["storage_class"] != db["storage"]["storage_class"]
        || receipt["volume_attributes_class"] != db["storage"]["volume_attributes_class"]
    {
        return None;
    }
    let leaves = authority["physical_lvs"]
        .as_array()?
        .iter()
        .filter(|lv| lv["lv_uuid"] == receipt["lv_uuid"])
        .collect::<Vec<_>>();
    if leaves.len() != 1
        || leaves[0]["segtype"] != "thin"
        || leaves[0]["name"] != receipt["volume_handle"]
        || leaves[0]["size_bytes"].as_u64()? != capacity as u64
    {
        return None;
    }
    Some(
        json!({"claimUid":receipt["pvc_uid"],"volumeUid":receipt["pv_uid"],"handle":receipt["volume_handle"],"lvUuid":receipt["lv_uuid"]}),
    )
}
fn physical_reclaimed(db: &Value, nodes: &Value, lv_uuid: &str, after: u64, now: u64) -> bool {
    valid_pattern("storageLvmUuid", lv_uuid)
        && physical_authority(db, nodes, after, now).is_some_and(|value| {
            value["physical_lvs"]
                .as_array()
                .is_some_and(|rows| !rows.iter().any(|lv| lv["lv_uuid"] == lv_uuid))
                && value["active_lv_uuids"]
                    .as_array()
                    .is_some_and(|rows| !rows.iter().any(|id| id == lv_uuid))
        })
}
fn physical_unallocated(db: &Value, nodes: &Value, after: u64, now: u64) -> bool {
    physical_authority(db, nodes, after, now).is_some_and(|value| {
        value["volumes"]
            .as_array()
            .is_some_and(|rows| !rows.iter().any(|volume| volume["database_id"] == db["id"]))
    })
}
fn mentions_subject(value: &Value, id: &str, namespace: &str) -> bool {
    match value {
        Value::String(v) => v == id || v == namespace,
        Value::Array(v) => v.iter().any(|v| mentions_subject(v, id, namespace)),
        Value::Object(v) => v.values().any(|v| mentions_subject(v, id, namespace)),
        _ => false,
    }
}
fn report_count(value: &Value, key: &str) -> Result<u64> {
    value[key]
        .as_u64()
        .or_else(|| {
            value[key]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.0 && v.fract() == 0.0 && *v <= MAX_SAFE as f64)
                .map(|v| v as u64)
        })
        .filter(|v| *v <= MAX_SAFE)
        .ok_or(Fault::Unavailable("gateway_ack_identity_mismatch"))
}
/// The generation of the storage protection marker a storage receipt holds, if it holds one.
pub(crate) fn protection_generation(storage: &Value) -> Option<u64> {
    let raw = storage["data"][protection_key()].as_str()?;
    let marker: Value = serde_json::from_str(raw).ok()?;
    marker["generation"].as_u64()
}
fn protection_key() -> &'static str {
    POWER_CONTRACT["constants"]["STORAGE_PROTECTION_LEDGER_KEY"]
        .as_str()
        .expect("generated protection key")
}
fn storage_operation(db: &Value) -> Value {
    db["power"]["operation"]
        .as_str()
        .or_else(|| db["recovery"]["operation_id"].as_str())
        .or_else(|| db["creation"]["operation_id"].as_str())
        .map(|v| Value::String(v.into()))
        .unwrap_or(Value::Null)
}
#[cfg(test)]
#[test]
fn a_protected_restore_keeps_the_current_cloudflare_restore_operation_for_node_readback() {
    let restore = format!("op_{}", "r".repeat(20));
    let mut db = json!({"power":null,"creation":{"operation_id":null},"recovery":{"operation_id":restore,"status":"running"}});
    assert_eq!(
        storage_operation(&db),
        db["recovery"]["operation_id"],
        "a restore archive suffix and NodeBootstrap protection witness name this operation"
    );
    db["power"] = json!({"operation":format!("op_{}","w".repeat(20))});
    assert_eq!(
        storage_operation(&db),
        db["power"]["operation"],
        "a later CF resume remains the current protection owner"
    );
}
impl PowerCoordinator {
    /// Physical lease failure is not a Cloudflare suspend operation. This path
    /// cannot force a WAL switch, claim successful hibernation or release CPU holds.
    pub async fn protect_storage(&self, db: &Value) -> std::result::Result<Option<Value>, Error> {
        if !database_valid(db) || db["storage"].is_null() || text(db, "desired_state") == "deleted"
        {
            return Err("invalid physical storage protection scope".into());
        }
        let result=tokio::time::timeout(Duration::from_secs(10),async{
   let id=text(db,"id");let ns=namespace(db);let storage_name=format!("storage-{id}");let(namespace_value,cluster_value,storage_value)=tokio::try_join!(self.k8s.read("Namespace",None,&ns),self.k8s.read("Cluster",Some(&ns),"database"),self.k8s.read("ConfigMap",Some(SYSTEM),&storage_name))?;
   // No object identity is invented before an authorized bounded startup has
   // actually created it. The caller owns the separate CF start-admission check.
   let(Some(namespace_value),Some(cluster_value),Some(storage_value))=(namespace_value,cluster_value,storage_value)else{return Ok(None);};
   let namespace_value=owned(Some(namespace_value),&ns,id,None,false)?;let cluster=owned(Some(cluster_value),"database",id,Some(&ns),false)?;let storage=owned(Some(storage_value),&storage_name,id,Some(SYSTEM),false)?;
   if [&namespace_value,&cluster,&storage].iter().any(|v|generation(v)>number(db,"generation")||v["metadata"]["annotations"]["pgcf.io/accepted-generation"].as_str().and_then(|s|s.parse::<u64>().ok()).is_some_and(|g|g>number(db,"generation"))){return Err(Fault::Stale);}
   let state:Value=serde_json::from_str(required(text(&storage["data"],"state"),4096)?).map_err(|_|Fault::Recovery("storage_fence_invalid"))?;
   if state["namespaceUid"]!=uid(&namespace_value)?||state["clusterUid"]!=uid(&cluster)?||state["storage"]!=db["storage"]{return Err(Fault::Recovery("storage_protection_identity_changed"));}
   let prior=storage["data"][protection_key()].as_str().map(serde_json::from_str::<Value>).transpose().map_err(|_|Fault::Recovery("storage_protection_marker_invalid"))?;
   let operation=storage_operation(db);
   let marker=if let Some(prior)=prior {
    if prior["v"]!=1||prior["database_id"]!=id||prior["generation"]!=db["generation"]||prior["operation_id"]!=operation||prior["storage_uid"]!=storage["metadata"]["uid"]||prior["namespace_uid"]!=namespace_value["metadata"]["uid"]||prior["cluster_uid"]!=cluster["metadata"]["uid"]||prior["node_uid"]!=db["storage"]["node_uid"]||prior["profile_sha256"]!=db["storage"]["profile_sha256"]||crate::contracts::integer(&prior,"requested_at")?>self.now(){return Err(Fault::Recovery("storage_protection_marker_changed"));}
    prior
   } else {json!({"v":1,"database_id":id,"generation":db["generation"],"operation_id":operation,"storage_uid":uid(&storage)?,"namespace_uid":uid(&namespace_value)?,"cluster_uid":uid(&cluster)?,"node_uid":db["storage"]["node_uid"],"profile_sha256":db["storage"]["profile_sha256"],"requested_at":self.now()})};
   let serialized=serde_json::to_string(&marker).unwrap();if text(&storage["data"],protection_key())!=serialized{let written=self.k8s.patch(&storage,&json!({"data":{protection_key():serialized}})).await?;if written["data"][protection_key()]!=serialized{return Err(Fault::Unavailable("storage_protection_marker_unknown"));}}
   let drain=crate::contracts::integer(&db["storage"],"drain_seconds")?;
   if cluster["metadata"]["annotations"][HIBERNATION]!="on"||number(&cluster["spec"],"stopDelay")!=drain||number(&cluster["spec"],"smartShutdownTimeout")!=0{
    let actual=self.k8s.patch(&cluster,&json!({"metadata":{"annotations":{HIBERNATION:"on"}},"spec":{"stopDelay":drain,"smartShutdownTimeout":0}})).await?;
    if actual["metadata"]["annotations"][HIBERNATION]!="on"||number(&actual["spec"],"stopDelay")!=drain||number(&actual["spec"],"smartShutdownTimeout")!=0{return Err(Fault::Unavailable("storage_protection_result_unknown"));}
   }
   Ok(Some(json!({"id":db["id"],"generation":db["generation"],"state":"provisioning","message":"Storage write authority unavailable; physical protection requested","archive":{"continuous":false,"ready_wal_files":null}})))
  }).await;
        Ok(match result {
            Ok(Ok(value)) => value,
            Ok(Err(Fault::Stale)) | Err(_) => None,
            Ok(Err(Fault::Recovery(reason))) => Some(recovery_observation(db, reason)),
            Ok(Err(_)) => None,
        })
    }
    fn running_protection_valid(
        &self,
        db: &Value,
        intent: &PowerIntent,
        storage: &Value,
    ) -> Result<bool> {
        if storage["data"][protection_key()].is_null() {
            return Ok(false);
        }
        let raw = required(text(&storage["data"], protection_key()), 4096)?;
        let marker: Value = serde_json::from_str(raw)
            .map_err(|_| Fault::Recovery("storage_protection_marker_invalid"))?;
        let state: Value = serde_json::from_str(required(text(&storage["data"], "state"), 4096)?)
            .map_err(|_| Fault::Recovery("storage_fence_invalid"))?;
        let operation_valid = match marker.get("operation_id") {
            Some(Value::Null) => db.get("creation").is_none_or(Value::is_null),
            Some(Value::String(operation)) => valid_pattern("operation", operation),
            _ => false,
        };
        if marker["v"] != 1
            || state["storage"] != db["storage"]
            || marker["cluster_uid"] != state["clusterUid"]
            || marker["namespace_uid"] != state["namespaceUid"]
            || marker["database_id"] != db["id"]
            || marker["storage_uid"] != uid(storage)?
            || marker["node_uid"] != db["storage"]["node_uid"]
            || marker["profile_sha256"] != db["storage"]["profile_sha256"]
            || crate::contracts::integer(&marker, "generation")? == 0
            || crate::contracts::integer(&marker, "generation")? >= intent.revision
            || crate::contracts::integer(&marker, "requested_at")? > self.now()
            || !operation_valid
            || marker["operation_id"] == intent.operation
        {
            return Err(Fault::Recovery(
                "storage_protection_recovery_authority_missing",
            ));
        }
        Ok(true)
    }
    async fn storage_protection_for_running(
        &self,
        db: &Value,
        intent: &PowerIntent,
    ) -> Result<bool> {
        if db["storage"].is_null() {
            return Ok(false);
        }
        let id = text(db, "id");
        let name = format!("storage-{id}");
        let Some(storage) = self
            .k8s
            .read_known("ConfigMap", Some(SYSTEM), &name)
            .await?
        else {
            return Ok(false);
        };
        let storage = owned(Some(storage), &name, id, Some(SYSTEM), false)?;
        self.running_protection_valid(db, intent, &storage)
    }
    async fn clear_storage_protection(
        &self,
        db: &Value,
        intent: &PowerIntent,
        expected_uid: &str,
    ) -> Result<()> {
        if db["storage"].is_null() {
            return Ok(());
        }
        let id = text(db, "id");
        let name = format!("storage-{id}");
        let storage = owned(
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &name)
                .await?,
            &name,
            id,
            Some(SYSTEM),
            false,
        )?;
        if uid(&storage)? != expected_uid {
            return Err(Fault::Recovery("storage_protection_identity_changed"));
        }
        if !self.running_protection_valid(db, intent, &storage)? {
            return Ok(());
        }
        // Anchor validation and the new CF running intent precede this exact marker CAS;
        // hibernation remains on until clearing succeeds, so denial cannot wake a tenant.
        let result = self
            .k8s
            .patch(&storage, &json!({"data":{protection_key():Value::Null}}))
            .await?;
        if !result["data"][protection_key()].is_null() {
            return Err(Fault::Unavailable("storage_protection_clear_unknown"));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap()
    }
    #[test]
    fn malformed_present_generation_never_becomes_legacy_zero() {
        let id = "aaaaaaaaaaaaaaaaaaaa";
        let mut value = json!({"metadata":{"name":"storage-aaaaaaaaaaaaaaaaaaaa","namespace":"pgcf-system","uid":uid_string(1),"resourceVersion":"1","labels":{DATABASE_LABEL:id},"annotations":{GENERATION:"not-an-integer"}}});
        assert!(
            owned(
                Some(value.clone()),
                "storage-aaaaaaaaaaaaaaaaaaaa",
                id,
                Some(SYSTEM),
                false
            )
            .is_err()
        );
        value["metadata"]["annotations"][GENERATION] = "1".into();
        value["metadata"]["annotations"]["pgcf.io/accepted-generation"] = "9007199254740992".into();
        assert!(
            owned(
                Some(value),
                "storage-aaaaaaaaaaaaaaaaaaaa",
                id,
                Some(SYSTEM),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn authoritative_typescript_power_intent_contract() {
        for case in vectors()["intents"].as_array().unwrap() {
            let result = desired_power(&case["db"]);
            if case["rejected"] == true {
                assert!(result.is_err(), "{}", case["name"]);
            } else {
                assert_eq!(
                    serde_json::to_value(result.unwrap()).unwrap(),
                    case["intent"],
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn a_refused_write_is_told_from_a_conflict_and_from_a_server_that_failed() {
        // The Cluster write that unfences is two admission webhooks of the CNPG operator long: an
        // operator that is down refuses it with a server error, which no read of the Cluster
        // cures, and a conflict is cured by one.
        let reason = |status: u16| -> String {
            let error: Error = Box::new(crate::kubernetes::KubernetesError { status });
            Fault::from(error).to_string()
        };
        assert_eq!(reason(409), "kubernetes_conflict");
        assert_eq!(reason(500), "kubernetes_server_error");
        assert_eq!(reason(503), "kubernetes_server_error");
        assert_eq!(reason(422), "kubernetes_rejected");
        assert_eq!(reason(403), "kubernetes_rejected");
        let other: Error = "the connection ended".into();
        assert_eq!(Fault::from(other).to_string(), "power_step_unavailable");
    }
    #[test]
    fn authoritative_typescript_persisted_phase_traces_roundtrip_without_losing_proof() {
        for case in vectors()["progress"].as_array().unwrap() {
            let map =
                json!({"data":{"power.json":serde_json::to_string(&case["progress"]).unwrap()}});
            let p = progress_from(&map, 100_000).unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(&p).unwrap(),
                case["progress"],
                "{}",
                case["name"]
            );
            if p.phase == Phase::Refused {
                assert_eq!(
                    observation(&case["db"], &p.target, "awake", p.refusal),
                    case["observation"]
                );
            }
            if p.phase == Phase::Hibernated {
                assert_eq!(
                    observation(&case["db"], &p.target, "hibernated", None),
                    case["observation"]
                );
            }
        }
    }
    #[test]
    fn physical_reclamation_matches_authoritative_thin_storage_semantics() {
        for case in vectors()["reclamation"].as_array().unwrap() {
            assert_eq!(
                physical_reclaimed(
                    &case["db"],
                    &case["nodes"],
                    case["lv"].as_str().unwrap(),
                    case["after"].as_u64().unwrap(),
                    case["now"].as_u64().unwrap()
                ),
                case["expected"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn storage_anchor_compares_json_semantically_but_never_accepts_changed_uids() {
        let p = &vectors()["progress"][0]["progress"];
        let mut anchor: Anchor = serde_json::from_value(p["anchor"].clone()).unwrap();
        let original = anchor.clone();
        let state: Value = serde_json::from_str(&anchor.storage_state).unwrap();
        anchor.storage_state = serde_json::to_string_pretty(&state).unwrap();
        assert!(anchor.matches(&original));
        anchor.volume_uid = uid_string(999);
        assert!(!anchor.matches(&original));
    }
    fn uid_string(n: u64) -> String {
        format!("01234567-89ab-4def-8123-{n:012x}")
    }
    #[test]
    fn unknown_or_fractional_gateway_counts_never_become_zero() {
        let measured: Value = serde_json::from_str(
            "{\"busyConnections\":1.0,\"connections\":1e0,\"pendingDials\":0}",
        )
        .unwrap();
        assert_eq!(report_count(&measured, "busyConnections").unwrap(), 1);
        assert_eq!(report_count(&measured, "connections").unwrap(), 1);
        assert!(report_count(&json!({}), "busyConnections").is_err());
        assert!(report_count(&json!({"busyConnections":0.5}), "busyConnections").is_err());
    }
    #[test]
    fn switching_requires_original_replica_and_key_continuity_and_never_invents_segment() {
        let mut p = vectors()["progress"][0]["progress"].clone();
        p["phase"] = "switching".into();
        p.as_object_mut().unwrap().remove("segment");
        let map = json!({"data":{"power.json":p.to_string()}});
        let parsed = progress_from(&map, 100_000).unwrap().unwrap();
        assert!(parsed.segment.is_none());
        assert_eq!(parsed.phase, Phase::Switching);
        p.as_object_mut().unwrap().remove("gateways");
        let map = json!({"data":{"power.json":p.to_string()}});
        assert!(progress_from(&map, 100_000).is_err());
    }
    #[test]
    fn exact_recorded_archive_segment_is_required_for_a_hibernated_proof() {
        let mut p = vectors()["progress"][4]["progress"].clone();
        assert_eq!(p["phase"], "hibernated");
        p.as_object_mut().unwrap().remove("segment");
        assert!(progress_from(&json!({"data":{"power.json":p.to_string()}}), 100_000).is_err());
    }
    #[test]
    fn scratch_or_changed_thin_classes_cannot_become_customer_storage() {
        assert_eq!(storage_class(&json!({})).unwrap(), "pgcf-lvm");
        let mut db = json!({"storage":{"backend":"lvm-thin-v1","profile_sha256":"a".repeat(64),"storage_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16))}});
        assert_eq!(
            storage_class(&db).unwrap(),
            "pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa"
        );
        db["storage"]["storage_class"] = "pgcf-thin-q-scratch".into();
        assert!(storage_class(&db).is_err());
    }
    #[test]
    fn deletion_receipt_requires_exact_terminal_generation_and_observed_order() {
        let db = &vectors()["progress"][0]["db"];
        let mut deleted = db.clone();
        deleted["desired_state"] = "deleted".into();
        let receipt = json!({"markerUid":uid_string(1),"intent":{"database":db["id"],"operation":format!("op_{}","z".repeat(20)),"revision":db["generation"],"mode":"retired"},"publishedAt":iso(10_000).unwrap(),"observedAt":iso(11_000).unwrap(),"phase":"deleting","markerVersion":"7"});
        assert!(
            receipt_from(
                &json!({"data":{"gateway-retirement.json":receipt.to_string()}}),
                &deleted,
                100_000
            )
            .unwrap()
            .is_some()
        );
        let mut wrong = receipt;
        wrong["intent"]["revision"] = 1.into();
        assert!(
            receipt_from(
                &json!({"data":{"gateway-retirement.json":wrong.to_string()}}),
                &deleted,
                100_000
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod tls_tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tokio_rustls::TlsAcceptor;
    struct Server {
        k8s: Kubernetes,
        objects: Arc<Mutex<HashMap<String, Value>>>,
        marker_writes: Arc<AtomicUsize>,
        cluster_writes: Arc<AtomicUsize>,
        fail: Arc<AtomicBool>,
        requests: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
        token: std::path::PathBuf,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
            let _ = std::fs::remove_file(&self.token);
        }
    }
    fn id(n: u64) -> String {
        format!("01234567-89ab-4def-8123-{n:012x}")
    }
    fn database() -> Value {
        let mut db: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        db = db["intents"][0]["db"].clone();
        db["storage"] = json!({"backend":"lvm-thin-v1","storage_class":"pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa","volume_attributes_class":"pgcf-lvm-thin-v1-aaaaaaaaaaaaaaaa","profile_revision":1,"profile_sha256":"a".repeat(64),"node_uid":id(4),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","startup_reserve_bytes":1048576,"write_bytes_per_second":1048576,"write_iops_per_second":10,"guard_seconds":2,"drain_seconds":1});
        assert!(database_valid(&db));
        db
    }
    /// The first live thin creation was stopped before Ready: its native receipt existed,
    /// but the legacy volume annotation and IO readback did not. These are physical facts only.
    fn before_ready_volume_facts() -> (Value, Value, Value, Value, Value, Value, Value) {
        let mut db = database();
        db["generation"] = 2.into();
        db["desired_state"] = "running".into();
        db["size"]["storage_gib"] = 5.into();
        let ns = namespace(&db);
        let lv = "iLeDnR-3bK4-F2Sh-j05A-x0NW-MCcd-TfCn8O";
        let handle = format!("pvc-{}", id(5));
        let namespace_value = json!({"metadata":metadata(&ns,None,&id(1),&db)});
        let cluster = json!({"apiVersion":"postgresql.cnpg.io/v1","metadata":metadata("database",Some(&ns),&id(2),&db)});
        let storage = json!({"metadata":metadata(&format!("storage-{}",text(&db,"id")),Some(SYSTEM),&id(3),&db),"data":{"state":json!({"namespaceUid":id(1),"clusterUid":id(2),"node":db["node"],"archivePath":db["archive"]["destination_path"],"storage":db["storage"]}).to_string()}});
        let mut claim = json!({"metadata":metadata("database-1",Some(&ns),&id(5),&db),"spec":{"volumeName":"bound-pv","storageClassName":db["storage"]["storage_class"],"volumeAttributesClassName":db["storage"]["volume_attributes_class"],"resources":{"requests":{"storage":"5Gi"}}},"status":{"phase":"Bound","capacity":{"storage":"5Gi"},"currentVolumeAttributesClassName":db["storage"]["volume_attributes_class"]}});
        claim["metadata"]["ownerReferences"] = json!([{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":id(2),"controller":true}]);
        let pv = json!({"metadata":{"name":"bound-pv","uid":id(6)},"spec":{"claimRef":{"name":"database-1","namespace":ns,"uid":id(5)},"csi":{"driver":"local.csi.openebs.io","volumeHandle":handle},"storageClassName":db["storage"]["storage_class"],"capacity":{"storage":"5Gi"},"nodeAffinity":{"required":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":[db["node"]]}]}]}}},"status":{"phase":"Bound"}});
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let mut authority = vectors["reclamation"][0]["nodes"][0].clone();
        authority["node_uid"] = db["storage"]["node_uid"].clone();
        authority["name"] = db["node"].clone();
        authority["profile_revision"] = db["storage"]["profile_revision"].clone();
        authority["profile_sha256"] = db["storage"]["profile_sha256"].clone();
        authority["storage_class"] = db["storage"]["storage_class"].clone();
        authority["volume_group_uuid"] = db["storage"]["volume_group_uuid"].clone();
        authority["pool_uuid"] = db["storage"]["pool_uuid"].clone();
        authority["observed_at"] = iso(100_000).unwrap().into();
        authority["captured_at"] = iso(100_000).unwrap().into();
        authority["expires_at"] = iso(102_000).unwrap().into();
        authority["physical"] = json!({"volume_group_uuid":db["storage"]["volume_group_uuid"],"total_bytes":100*1073741824_u64,"free_bytes":60*1073741824_u64,"thick_allocated_bytes":0,"thin_pool":{"name":"pgcf_thinpool","data_total_bytes":32*1073741824_u64,"data_used_bytes_upper_bound":0,"metadata_total_bytes":8*1073741824_u64,"metadata_used_bytes_upper_bound":0}});
        authority["physical_lvs"] =
            json!([{"name":handle,"lv_uuid":lv,"size_bytes":5*1073741824_u64,"segtype":"thin"}]);
        authority["volumes"] = json!([{"database_id":db["id"],"generation":2,"storage_generation":1,"storage_uid":id(3),"namespace_uid":id(1),"cluster_uid":id(2),"volume_handle":handle,"lv_uuid":lv,"pvc_uid":id(5),"pv_uid":id(6),"storage_class":db["storage"]["storage_class"],"volume_attributes_class":db["storage"]["volume_attributes_class"],"quiesced":false,"io":[]}]);
        assert!(crate::contracts::schema_valid(
            "NodeThinStorageAuthority",
            &authority
        ));
        (db, authority, namespace_value, cluster, storage, claim, pv)
    }
    #[test]
    fn a_native_bound_volume_can_be_pinned_before_ready_without_inventing_identity() {
        let (db, authority, ns, cluster, storage, claim, pv) = before_ready_volume_facts();
        assert!(storage["metadata"]["annotations"][VOLUME_IDENTITY].is_null());
        let identity = native_volume_identity(
            &db,
            &authority,
            (&ns, &cluster, &storage),
            (&claim, &pv),
            100_100,
        )
        .unwrap();
        assert_eq!(
            identity,
            json!({"claimUid":id(5),"volumeUid":id(6),"handle":format!("pvc-{}",id(5)),"lvUuid":"iLeDnR-3bK4-F2Sh-j05A-x0NW-MCcd-TfCn8O"})
        );
        let mut replaced = pv.clone();
        replaced["metadata"]["uid"] = id(66).into();
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&claim, &replaced),
                100_100
            )
            .is_none()
        );
        let mut replaced = cluster.clone();
        replaced["metadata"]["uid"] = id(22).into();
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &replaced, &storage),
                (&claim, &pv),
                100_100
            )
            .is_none()
        );
        let mut changed = authority.clone();
        changed["physical_lvs"][0]["lv_uuid"] = "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef".into();
        assert!(
            native_volume_identity(
                &db,
                &changed,
                (&ns, &cluster, &storage),
                (&claim, &pv),
                100_100
            )
            .is_none()
        );
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&claim, &pv),
                102_000
            )
            .is_none()
        );
    }
    #[test]
    fn restore_before_ready_keeps_the_same_physical_custody() {
        let (mut db, authority, ns, cluster, storage, claim, pv) = before_ready_volume_facts();
        db["creation"] = Value::Null;
        db["recovery"] = json!({"operation_id":format!("op_{}","r".repeat(20)),"ever_ready":false,"status":"running"});
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&claim, &pv),
                100_100
            )
            .is_some()
        );
        let mut changed = claim.clone();
        changed["metadata"]["uid"] = id(55).into();
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&changed, &pv),
                100_100
            )
            .is_none()
        );
    }
    #[test]
    fn a_native_leaf_name_or_quota_change_cannot_be_pinned() {
        let (db, authority, ns, cluster, storage, claim, pv) = before_ready_volume_facts();
        let mut renamed = authority.clone();
        renamed["physical_lvs"][0]["name"] = "unexpected-volume".into();
        let mut oversized = authority.clone();
        oversized["physical_lvs"][0]["size_bytes"] = (6 * 1073741824_u64).into();
        assert_eq!(
            (
                native_volume_identity(
                    &db,
                    &renamed,
                    (&ns, &cluster, &storage),
                    (&claim, &pv),
                    100_100
                ),
                native_volume_identity(
                    &db,
                    &oversized,
                    (&ns, &cluster, &storage),
                    (&claim, &pv),
                    100_100
                ),
            ),
            (None, None)
        );
    }
    #[test]
    fn deleting_claims_and_volumes_never_materialize_thin_custody() {
        let (db, authority, ns, cluster, storage, claim, pv) = before_ready_volume_facts();
        let mut deleting = claim.clone();
        deleting["metadata"]["deletionTimestamp"] = "2026-10-13T20:57:10.382Z".into();
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&deleting, &pv),
                100_100
            )
            .is_none()
        );
        let mut deleting = pv.clone();
        deleting["metadata"]["deletionTimestamp"] = "2026-10-13T20:57:10.382Z".into();
        assert!(
            native_volume_identity(
                &db,
                &authority,
                (&ns, &cluster, &storage),
                (&claim, &deleting),
                100_100
            )
            .is_none()
        );
    }
    fn metadata(name: &str, ns: Option<&str>, uid: &str, db: &Value) -> Value {
        let mut v = json!({"name":name,"uid":uid,"resourceVersion":"1","labels":{"pgcf.io/database-id":db["id"]},"annotations":{"pgcf.io/generation":"1","pgcf.io/accepted-generation":"1"}});
        if let Some(ns) = ns {
            v["namespace"] = ns.into();
        }
        v
    }
    impl Server {
        async fn new(db: &Value, replace_after_unknown: bool) -> Self {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let identity = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
            let ca = identity.cert.pem();
            let tls = rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(
                    vec![identity.cert.der().clone()],
                    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                        identity.signing_key.serialize_der(),
                    )),
                )
                .unwrap();
            let acceptor = TlsAcceptor::from(Arc::new(tls));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let token = std::env::temp_dir().join(format!(
                "pgcf-native-power-{}-{}.token",
                std::process::id(),
                address.port()
            ));
            tokio::fs::write(&token, "generated-local-test-token")
                .await
                .unwrap();
            let k8s = Kubernetes::with_ca(
                reqwest::Url::parse(&format!("https://{address}/")).unwrap(),
                ca.as_bytes(),
                token.clone(),
            )
            .unwrap();
            let ns = namespace(db);
            let storage_name = format!("storage-{}", text(db, "id"));
            let objects = Arc::new(Mutex::new(HashMap::from([
                (
                    format!("/api/v1/namespaces/{ns}"),
                    json!({"apiVersion":"v1","kind":"Namespace","metadata":metadata(&ns,None,&id(1),db)}),
                ),
                (
                    format!("/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database"),
                    json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":metadata("database",Some(&ns),&id(2),db),"spec":{"stopDelay":1800,"smartShutdownTimeout":180}}),
                ),
                (
                    format!("/api/v1/namespaces/pgcf-system/configmaps/{storage_name}"),
                    json!({"apiVersion":"v1","kind":"ConfigMap","metadata":metadata(&storage_name,Some("pgcf-system"),&id(3),db),"data":{"state":json!({"namespaceUid":id(1),"clusterUid":id(2),"storage":db["storage"]}).to_string()}}),
                ),
            ])));
            let marker_writes = Arc::new(AtomicUsize::new(0));
            let cluster_writes = Arc::new(AtomicUsize::new(0));
            let fail = Arc::new(AtomicBool::new(true));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let (server_objects, markers, clusters) = (
                objects.clone(),
                marker_writes.clone(),
                cluster_writes.clone(),
            );
            let cluster_path =
                format!("/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database");
            let returned_fail = fail.clone();
            let server_requests = requests.clone();
            let task = tokio::spawn(async move {
                let mut handlers = tokio::task::JoinSet::new();
                loop {
                    let (tcp, _) = listener.accept().await.unwrap();
                    let (acceptor, objects, markers, clusters, fail, cluster_path) = (
                        acceptor.clone(),
                        server_objects.clone(),
                        markers.clone(),
                        clusters.clone(),
                        fail.clone(),
                        cluster_path.clone(),
                    );
                    let requests = server_requests.clone();
                    handlers.spawn(async move{
    let mut tls=acceptor.accept(tcp).await.unwrap();let mut bytes=Vec::new();let mut byte=[0];while !bytes.ends_with(b"\r\n\r\n"){if tls.read_exact(&mut byte).await.is_err(){return;}bytes.push(byte[0]);assert!(bytes.len()<64*1024);}let header=String::from_utf8(bytes).unwrap();assert!(header.to_lowercase().contains("authorization: bearer generated-local-test-token"));let mut first=header.lines().next().unwrap().split_whitespace();let method=first.next().unwrap();let path=first.next().unwrap().split('?').next().unwrap();let length=header.lines().find_map(|line|line.split_once(':').filter(|(key,_)|key.eq_ignore_ascii_case("content-length")).map(|(_,n)|n.trim().parse::<usize>().unwrap())).unwrap_or(0);assert!(length<=2*1024*1024);let mut body=vec![0;length];tls.read_exact(&mut body).await.unwrap();
    requests.lock().unwrap().push(format!("{method} {path}"));
    let (status,response,unknown)={let mut resources=objects.lock().unwrap();let current=resources.get(path).cloned();match (method,current){("GET",Some(v))=>(200,v,false),("POST",None)=>{let mut value:Value=serde_json::from_slice(&body).unwrap();assert_eq!(value["kind"],"ConfigMap");value["metadata"]["uid"]=id(500).into();value["metadata"]["resourceVersion"]="1".into();let target=format!("{path}/{}",text(&value["metadata"],"name"));resources.insert(target,value.clone());(201,value,false)},("PATCH",Some(mut v))=>{let patch:Value=serde_json::from_slice(&body).unwrap();if patch["metadata"]["uid"]!=v["metadata"]["uid"]||patch["metadata"]["resourceVersion"]!=v["metadata"]["resourceVersion"]{(409,json!({"message":"precondition"}),false)}else{if path==cluster_path{clusters.fetch_add(1,Ordering::SeqCst);}else{markers.fetch_add(1,Ordering::SeqCst);}merge(&mut v,&patch);v["metadata"]["resourceVersion"]=(text(&v["metadata"],"resourceVersion").parse::<u64>().unwrap()+1).to_string().into();resources.insert(path.into(),v.clone());let unknown=path!=cluster_path&&fail.swap(false,Ordering::SeqCst);if unknown&&replace_after_unknown{resources.get_mut(&cluster_path).unwrap()["metadata"]["uid"]=id(999).into();}(200,v,unknown)}},_=>(404,json!({}),false)}};
    if unknown{return;}let body=serde_json::to_vec(&response).unwrap();tls.write_all(format!("HTTP/1.1 {status} OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n",body.len()).as_bytes()).await.unwrap();tls.write_all(&body).await.unwrap();let _=tls.shutdown().await;
   });
                }
            });
            Self {
                k8s,
                objects,
                marker_writes,
                cluster_writes,
                fail: returned_fail,
                requests,
                task,
                token,
            }
        }
    }
    fn merge(value: &mut Value, patch: &Value) {
        if let Some(object) = patch.as_object() {
            if !value.is_object() {
                *value = json!({});
            }
            for (key, new) in object {
                if new.is_null() {
                    value.as_object_mut().unwrap().remove(key);
                } else {
                    merge(&mut value[key], new);
                }
            }
        } else {
            *value = patch.clone();
        }
    }
    fn protected_database() -> Value {
        let mut db = database();
        db["generation"] = 2.into();
        db["desired_state"] = "suspended".into();
        db["power"] = json!({"operation":format!("op_{}","z".repeat(20)),"revision":2,"mode":"quiesce","reason":"manual"});
        assert!(database_valid(&db));
        db
    }
    fn protected_objects(server: &Server, db: &Value) {
        let ns = namespace(db);
        let storage_name = format!("storage-{}", text(db, "id"));
        let claim = "database-1";
        let handle = "pvc-retained";
        let mut resources = server.objects.lock().unwrap();
        let cluster = resources
            .get_mut(&format!(
                "/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database"
            ))
            .unwrap();
        cluster["metadata"]["annotations"][HIBERNATION] = "on".into();
        cluster["status"] =
            json!({"conditions":[{"type":HIBERNATION,"status":"True","reason":"Hibernated"}]});
        let storage = resources
            .get_mut(&format!(
                "/api/v1/namespaces/pgcf-system/configmaps/{storage_name}"
            ))
            .unwrap();
        storage["data"]["state"]=json!({"namespaceUid":id(1),"clusterUid":id(2),"storage":db["storage"],"node":db["node"],"archivePath":db["archive"]["destination_path"]}).to_string().into();
        storage["metadata"]["annotations"][VOLUME_IDENTITY]=json!({"claimUid":id(5),"volumeUid":id(6),"handle":handle,"lvUuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef"}).to_string().into();
        storage["data"][protection_key()]=json!({"v":1,"database_id":db["id"],"generation":1,"operation_id":db["creation"]["operation_id"],"storage_uid":id(3),"namespace_uid":id(1),"cluster_uid":id(2),"node_uid":db["storage"]["node_uid"],"profile_sha256":db["storage"]["profile_sha256"],"requested_at":90_000}).to_string().into();
        resources.insert(format!("/api/v1/nodes/{}",text(db,"node")),json!({"apiVersion":"v1","kind":"Node","metadata":{"name":db["node"],"uid":id(4),"resourceVersion":"1"}}));
        // OpenEBS names the PersistentVolume and the LVMVolume after the volume ID.
        let pv = json!({"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":handle,"uid":id(6),"resourceVersion":"1"},"spec":{"claimRef":{"name":claim,"namespace":ns,"uid":id(5)},"csi":{"driver":"local.csi.openebs.io","volumeHandle":handle},"storageClassName":db["storage"]["storage_class"],"nodeAffinity":{"required":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"kubernetes.io/hostname","operator":"In","values":[db["node"]]}]}]}}},"status":{"phase":"Bound"}});
        resources.insert(format!("/api/v1/persistentvolumes/{handle}"), pv);
        resources.insert(format!("/api/v1/namespaces/{ns}/persistentvolumeclaims/{claim}"),json!({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":claim,"namespace":ns,"uid":id(5),"resourceVersion":"1"},"spec":{"volumeName":handle,"storageClassName":db["storage"]["storage_class"]},"status":{"phase":"Bound"}}));
        resources.insert(format!("/apis/local.openebs.io/v1alpha1/namespaces/openebs/lvmvolumes/{handle}"),json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMVolume","metadata":{"name":handle,"namespace":"openebs","uid":id(7),"resourceVersion":"1"}}));
        resources.insert(
            format!("/api/v1/namespaces/{ns}/pods"),
            json!({"metadata":{"resourceVersion":"1"},"items":[]}),
        );
        resources.insert("/api/v1/namespaces/pgcf-system/pods".into(),json!({"metadata":{"resourceVersion":"1"},"items":[{"kind":"Pod","metadata":{"name":"gateway","namespace":SYSTEM,"uid":id(20),"labels":{"app.kubernetes.io/name":"pgcf-gateway"}},"spec":{"serviceAccountName":"pgcf-gateway"},"status":{"podIP":"10.0.0.1","containerStatuses":[{"name":"gateway","restartCount":0}]}}]}));
        let keyring = json!({"active":"local","keys":{"local":URL_SAFE_NO_PAD.encode([7_u8;32])}})
            .to_string();
        resources.insert("/api/v1/namespaces/pgcf-system/secrets/pgcf-gateway".into(),json!({"kind":"Secret","metadata":{"name":"pgcf-gateway","namespace":SYSTEM,"uid":id(21),"resourceVersion":"1"},"data":{"PGCF_ROUTE_KEY":STANDARD.encode(keyring)}}));
        server.fail.store(false, Ordering::SeqCst);
    }
    struct Controls {
        client: reqwest::Client,
        busy: Arc<AtomicBool>,
        swap: Arc<AtomicBool>,
        calls: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Controls {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Controls {
        async fn new(server: &Server, db: &Value) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let client = reqwest::Client::builder()
                .proxy(reqwest::Proxy::all(format!("http://{addr}")).unwrap())
                .retry(reqwest::retry::never())
                .build()
                .unwrap();
            let busy = Arc::new(AtomicBool::new(false));
            let swap = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(AtomicUsize::new(0));
            let (busy_copy, swap_copy, calls_copy, objects, ns) = (
                busy.clone(),
                swap.clone(),
                calls.clone(),
                server.objects.clone(),
                namespace(db),
            );
            let task = tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    let mut byte = [0];
                    while !bytes.ends_with(b"\r\n\r\n") {
                        socket.read_exact(&mut byte).await.unwrap();
                        bytes.push(byte[0]);
                        assert!(bytes.len() < 16 * 1024);
                    }
                    let header = String::from_utf8(bytes).unwrap();
                    let action = header
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .rsplit('/')
                        .next()
                        .unwrap();
                    let token = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| {
                                    name.eq_ignore_ascii_case(wire("controlHeader"))
                                })
                                .map(|(_, value)| value.trim())
                        })
                        .unwrap();
                    let keys = HashMap::from([("local".to_string(), vec![7_u8; 32])]);
                    let claims = pgcf_native_protocol::scoped_tokens::control(
                        token,
                        &keys,
                        "eu-test",
                        &id(20),
                        action,
                        now(),
                    )
                    .unwrap();
                    calls_copy.fetch_add(1, Ordering::SeqCst);
                    if action == "close" && swap_copy.load(Ordering::SeqCst) {
                        objects
                            .lock()
                            .unwrap()
                            .get_mut(&format!(
                                "/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database"
                            ))
                            .unwrap()["metadata"]["uid"] = id(999).into();
                    }
                    let busy = busy_copy.load(Ordering::SeqCst);
                    // A release acknowledges the running intent; every other action reports quiescence.
                    let (mode, status) = if action == "release" {
                        ("running", "running")
                    } else {
                        ("quiesce", if busy { "busy" } else { "closed" })
                    };
                    let body=json!({"database":claims["database"],"operation":claims["operation"],"revision":claims["revision"],"mode":mode,"pod":id(20),"status":status,"connections":u64::from(busy),"busyConnections":u64::from(busy),"pendingDials":0}).to_string();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    let _ = socket.shutdown().await;
                }
            });
            Self {
                client,
                busy,
                swap,
                calls,
                task,
            }
        }
    }
    #[tokio::test]
    async fn protected_manual_suspend_finishes_without_sql_or_archival_claim() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let result = coordinator
            .suspend(&db, &Sleep::cold())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            result["state"],
            "hibernated",
            "{result}; reads {:?}",
            server.requests.lock().unwrap()
        );
        assert_eq!(result["power"]["operation"], db["power"]["operation"]);
        assert_eq!(result["archive"]["continuous"], false);
        assert!(result["archive"]["ready_wal_files"].is_null());
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("maintenance-credentials") || path.contains("ca-"))
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 3);
        let repeated = coordinator
            .suspend(&db, &Sleep::cold())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(repeated["state"], "hibernated");
        let objects = server.objects.lock().unwrap();
        let map = objects
            .values()
            .find(|v| v["data"]["power.json"].is_string())
            .unwrap();
        let progress: Value = serde_json::from_str(text(&map["data"], "power.json")).unwrap();
        assert_eq!(progress["phase"], "quiescing");
        assert!(progress["segment"].is_null());
        assert!(
            objects
                .values()
                .any(|v| v["data"][protection_key()].is_string())
        );
    }
    #[tokio::test]
    async fn protected_stop_waits_for_condition_pods_sessions_and_rechecks_identity() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let ns = namespace(&db);
        let cluster_path = format!("/apis/postgresql.cnpg.io/v1/namespaces/{ns}/clusters/database");
        let pods_path = format!("/api/v1/namespaces/{ns}/pods");
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&cluster_path)
            .unwrap()["status"]["conditions"] = json!([]);
        assert!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 0);
        {
            let mut objects = server.objects.lock().unwrap();
            objects.get_mut(&cluster_path).unwrap()["status"]["conditions"] =
                json!([{"type":HIBERNATION,"status":"True","reason":"Stopping"}]);
        }
        assert!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .is_none()
        );
        {
            let mut objects = server.objects.lock().unwrap();
            objects.get_mut(&cluster_path).unwrap()["status"]["conditions"] =
                json!([{"type":HIBERNATION,"status":"True","reason":"Hibernated"}]);
            objects.get_mut(&pods_path).unwrap()["items"] =
                json!([{"kind":"Pod","metadata":{"namespace":ns,"uid":id(88)}}]);
        }
        assert!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 0);
        server.objects.lock().unwrap().get_mut(&pods_path).unwrap()["items"] = json!([]);
        controls.busy.store(true, Ordering::SeqCst);
        assert!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 1);
        controls.busy.store(false, Ordering::SeqCst);
        controls.swap.store(true, Ordering::SeqCst);
        let rejected = coordinator
            .suspend(&db, &Sleep::cold())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(rejected["state"], "error");
        assert!(rejected.get("power").is_none());
        assert_eq!(rejected["archive"]["continuous"], false);
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("maintenance-credentials"))
        );
    }
    #[tokio::test]
    async fn protected_stop_rejects_future_or_rebound_marker_without_touching_wal() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        let storage_path = format!(
            "/api/v1/namespaces/pgcf-system/configmaps/storage-{}",
            text(&db, "id")
        );
        let mut marker: Value = serde_json::from_str(text(
            &server.objects.lock().unwrap()[&storage_path]["data"],
            protection_key(),
        ))
        .unwrap();
        marker["generation"] = 2.into();
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&storage_path)
            .unwrap()["data"][protection_key()] = marker.to_string().into();
        assert_eq!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .unwrap()["state"],
            "error"
        );
        marker["generation"] = 1.into();
        marker["cluster_uid"] = id(999).into();
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&storage_path)
            .unwrap()["data"][protection_key()] = marker.to_string().into();
        assert_eq!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .unwrap()["state"],
            "error"
        );
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("maintenance-credentials"))
        );
    }
    #[tokio::test]
    async fn protected_stop_preserves_unknown_switch_progress_and_does_not_relax_idle_sleep() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let intent = desired_power(&db).unwrap().unwrap();
        let (anchor, _) = coordinator.anchor(&db).await.unwrap();
        let snapshot = coordinator.snapshot().await.unwrap();
        let mut progress = Progress::new(intent.clone(), Phase::Switching, anchor, 99_000);
        progress.proof_intent = Some(intent.clone());
        progress.gateways = Some(snapshot.pods);
        progress.key_uid = Some(snapshot.key_uid);
        progress.key_version = Some(snapshot.key_version);
        let raw = serde_json::to_string(&progress).unwrap();
        let name = format!("gateway-fence-{}", text(&db, "id"));
        server.objects.lock().unwrap().insert(format!("/api/v1/namespaces/pgcf-system/configmaps/{name}"),json!({"kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"uid":id(500),"resourceVersion":"1","labels":{DATABASE_LABEL:db["id"],wire("fenceLabel"):"true"}},"data":{"intent.json":serde_json::to_string(&intent).unwrap(),"power.json":raw}}));
        assert_eq!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .unwrap()["state"],
            "hibernated"
        );
        assert_eq!(
            server.objects.lock().unwrap()
                [&format!("/api/v1/namespaces/pgcf-system/configmaps/{name}")]["data"]["power.json"],
            raw
        );
        let mut idle = db.clone();
        idle["power"]["reason"] = "idle".into();
        assert!(
            coordinator
                .protected_manual_suspend(&idle, &intent)
                .await
                .unwrap()
                .is_none()
        );
    }
    #[tokio::test]
    async fn original_creation_can_start_after_queued_release_generations() {
        let mut db = database();
        db["generation"] = 3.into();
        db["desired_state"] = "running".into();
        db["creation"]["generation"] = 1.into();
        db["creation"]["status"] = "running".into();
        db["creation"]["ever_ready"] = false.into();
        db["power"] = json!({"operation":db["creation"]["operation_id"],"revision":3,"mode":"running","reason":null});
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        server.objects.lock().unwrap().clear();
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Proceed
        ));
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 0);
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert!(server.objects.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn protected_running_generation_is_rejected_before_any_wake_write() {
        let mut db = protected_database();
        db["generation"] = 1.into();
        db["desired_state"] = "running".into();
        db["power"] = json!({"operation":db["creation"]["operation_id"],"revision":1,"mode":"running","reason":null});
        db["creation"]["ever_ready"] = true.into();
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        let (anchor, _) = coordinator.anchor(&db).await.unwrap();
        let snapshot = coordinator.snapshot().await.unwrap();
        let prior = PowerIntent {
            database: text(&db, "id").into(),
            operation: text(&db["creation"], "operation_id").into(),
            revision: 1,
            mode: "quiesce".into(),
        };
        let mut p = Progress::new(prior.clone(), Phase::Switching, anchor, 99_000);
        p.proof_intent = Some(prior.clone());
        p.gateways = Some(snapshot.pods);
        p.key_uid = Some(snapshot.key_uid);
        p.key_version = Some(snapshot.key_version);
        let raw = serde_json::to_string(&p).unwrap();
        let name = format!("gateway-fence-{}", text(&db, "id"));
        let path = format!("/api/v1/namespaces/pgcf-system/configmaps/{name}");
        server.objects.lock().unwrap().insert(path.clone(),json!({"kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"uid":id(500),"resourceVersion":"1","labels":{DATABASE_LABEL:db["id"],wire("fenceLabel"):"true"}},"data":{"intent.json":serde_json::to_string(&prior).unwrap(),"power.json":raw}}));
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Observation(_)
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.objects.lock().unwrap()[&path]["data"]["power.json"],
            raw
        );
        assert!(
            server
                .objects
                .lock()
                .unwrap()
                .values()
                .any(|v| v["data"][protection_key()].is_string())
        );
        db["generation"] = 2.into();
        db["power"] = json!({"operation":format!("op_{}","z".repeat(20)),"revision":2,"mode":"running","reason":null});
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Proceed
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 1);
        assert!(
            !server
                .objects
                .lock()
                .unwrap()
                .values()
                .any(|v| v["data"][protection_key()].is_string())
        );
    }
    #[tokio::test]
    async fn protected_creation_shortcut_cannot_reuse_current_generation_startup() {
        let mut db = protected_database();
        db["generation"] = 1.into();
        db["desired_state"] = "running".into();
        db["power"] = json!({"operation":db["creation"]["operation_id"],"revision":1,"mode":"running","reason":null});
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Observation(_)
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn malformed_or_future_protection_cannot_clear_or_overwrite_switch_state() {
        let mut db = protected_database();
        db["desired_state"] = "running".into();
        db["power"] = json!({"operation":format!("op_{}","z".repeat(20)),"revision":2,"mode":"running","reason":null});
        db["creation"]["ever_ready"] = true.into();
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        let (anchor, _) = coordinator.anchor(&db).await.unwrap();
        let snapshot = coordinator.snapshot().await.unwrap();
        let prior = PowerIntent {
            database: text(&db, "id").into(),
            operation: text(&db["creation"], "operation_id").into(),
            revision: 1,
            mode: "quiesce".into(),
        };
        let mut progress = Progress::new(prior.clone(), Phase::Switching, anchor, 99_000);
        progress.proof_intent = Some(prior.clone());
        progress.gateways = Some(snapshot.pods);
        progress.key_uid = Some(snapshot.key_uid);
        progress.key_version = Some(snapshot.key_version);
        let raw = serde_json::to_string(&progress).unwrap();
        let name = format!("gateway-fence-{}", text(&db, "id"));
        let path = format!("/api/v1/namespaces/pgcf-system/configmaps/{name}");
        server.objects.lock().unwrap().insert(path.clone(),json!({"kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"uid":id(500),"resourceVersion":"1","labels":{DATABASE_LABEL:db["id"],wire("fenceLabel"):"true"}},"data":{"intent.json":serde_json::to_string(&prior).unwrap(),"power.json":raw}}));
        let storage_path = format!(
            "/api/v1/namespaces/pgcf-system/configmaps/storage-{}",
            text(&db, "id")
        );
        let mut marker: Value = serde_json::from_str(text(
            &server.objects.lock().unwrap()[&storage_path]["data"],
            protection_key(),
        ))
        .unwrap();
        marker["requested_at"] = 100_001.into();
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&storage_path)
            .unwrap()["data"][protection_key()] = marker.to_string().into();
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Observation(_)
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.objects.lock().unwrap()[&path]["data"]["power.json"],
            raw
        );
        marker["requested_at"] = 90_000.into();
        marker["operation_id"] = "not-an-operation".into();
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&storage_path)
            .unwrap()["data"][protection_key()] = marker.to_string().into();
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Observation(_)
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.objects.lock().unwrap()[&path]["data"]["power.json"],
            raw
        );
        marker["operation_id"] = Value::Null;
        server
            .objects
            .lock()
            .unwrap()
            .get_mut(&storage_path)
            .unwrap()["data"][protection_key()] = marker.to_string().into();
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Observation(_)
        ));
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 0);
        assert_eq!(
            server.objects.lock().unwrap()[&path]["data"]["power.json"],
            raw
        );
        db["creation"] = Value::Null;
        assert!(database_valid(&db));
        assert!(matches!(
            coordinator
                .prepare_running(&db, &Basis::cold())
                .await
                .unwrap(),
            PrepareRunning::Proceed
        ));
    }
    #[tokio::test]
    async fn uncertain_marker_write_is_read_before_same_uid_protection_continues() {
        let db = database();
        let server = Server::new(&db, false).await;
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        assert!(coordinator.protect_storage(&db).await.unwrap().is_none());
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 1);
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        let resumed = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_001),
        )
        .unwrap();
        let observed = resumed.protect_storage(&db).await.unwrap().unwrap();
        assert_eq!(observed["state"], "provisioning");
        assert!(observed.get("power").is_none());
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 1);
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 1);
        assert!(
            server
                .objects
                .lock()
                .unwrap()
                .values()
                .any(|v| v["kind"] == "Cluster"
                    && v["metadata"]["annotations"][HIBERNATION] == "on"
                    && v["spec"]["stopDelay"] == 1
                    && v["spec"]["smartShutdownTimeout"] == 0)
        );
    }
    #[tokio::test]
    async fn replaced_cluster_is_never_stopped_after_uncertain_marker_result() {
        let db = database();
        let server = Server::new(&db, true).await;
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        assert!(coordinator.protect_storage(&db).await.unwrap().is_none());
        let observed = coordinator.protect_storage(&db).await.unwrap().unwrap();
        assert_eq!(observed["state"], "error");
        assert!(text(&observed, "message").contains("identity_changed"));
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 1);
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn a_newer_or_rebound_protection_marker_is_not_overwritten() {
        let db = database();
        let server = Server::new(&db, false).await;
        {
            let mut objects = server.objects.lock().unwrap();
            let storage = objects
                .values_mut()
                .find(|v| v["kind"] == "ConfigMap")
                .unwrap();
            storage["data"][protection_key()]=json!({"v":1,"database_id":db["id"],"generation":2,"operation_id":db["creation"]["operation_id"],"storage_uid":id(3),"namespace_uid":id(1),"cluster_uid":id(2),"node_uid":db["storage"]["node_uid"],"profile_sha256":db["storage"]["profile_sha256"],"requested_at":90_000}).to_string().into();
        }
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        let observed = coordinator.protect_storage(&db).await.unwrap().unwrap();
        assert_eq!(observed["state"], "error");
        assert!(text(&observed, "message").contains("marker_changed"));
        assert_eq!(server.marker_writes.load(Ordering::SeqCst), 0);
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn a_failed_before_allocation_thin_database_deletes_only_after_complete_fresh_host_proof()
    {
        let mut db = database();
        db["desired_state"] = "deleted".into();
        db["generation"] = 2.into();
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        server.fail.store(false, Ordering::SeqCst);
        {
            let mut resources = server.objects.lock().unwrap();
            resources.clear();
            for (path, kind) in [
                ("/api/v1/persistentvolumes", "PersistentVolumeList"),
                (
                    "/apis/local.openebs.io/v1alpha1/lvmvolumes",
                    "LVMVolumeList",
                ),
            ] {
                resources.insert(path.into(),json!({"apiVersion":"v1","kind":kind,"metadata":{"resourceVersion":"1"},"items":[]}));
            }
        }
        let clock = Arc::new(std::sync::atomic::AtomicU64::new(100_000));
        let owned_clock = clock.clone();
        let coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(move || owned_clock.load(Ordering::SeqCst)),
        )
        .unwrap();
        let waiting = coordinator
            .delete_database(&db, &json!([]))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(waiting["state"], "deleting");
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let nodes = &fixture["reclamation"][0]["nodes"];
        clock.store(100_002, Ordering::SeqCst);
        let deleted = coordinator
            .delete_database(&db, nodes)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(deleted["state"], "deleted");
        assert_eq!(server.cluster_writes.load(Ordering::SeqCst), 0);
        let resources = server.objects.lock().unwrap();
        let ledger = resources
            .values()
            .find(|v| v["kind"] == "ConfigMap")
            .unwrap();
        let state: Value = serde_json::from_str(text(&ledger["data"], "state")).unwrap();
        assert_eq!(state["completed"], true);
        assert!(state["physicalLvUuid"].is_null());
        assert_eq!(state["startedAt"], 100_000);
    }
    #[tokio::test]
    async fn terminal_gateway_pods_neither_block_nor_receive_power_controls() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        // Graceful node shutdown leaves Deployment Pods behind as terminal objects without an address.
        server
            .objects
            .lock()
            .unwrap()
            .get_mut("/api/v1/namespaces/pgcf-system/pods")
            .unwrap()["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"kind":"Pod","metadata":{"name":"gateway-shutdown","namespace":SYSTEM,"uid":id(22),"labels":{"app.kubernetes.io/name":"pgcf-gateway"}},"spec":{"serviceAccountName":"pgcf-gateway"},"status":{"phase":"Succeeded","containerStatuses":[{"name":"gateway","restartCount":0,"state":{"terminated":{"exitCode":0}}}]}}));
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let result = coordinator
            .suspend(&db, &Sleep::cold())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["state"], "hibernated");
        // The control endpoint accepts only the live Pod: begin, close and status reached it alone.
        assert_eq!(controls.calls.load(Ordering::SeqCst), 3);
        let two = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            2,
            Arc::new(|| 100_000),
        )
        .unwrap();
        assert!(matches!(
            two.gateways().await,
            Err(Fault::Unavailable("gateway_inventory_incomplete"))
        ));
    }
    #[tokio::test]
    async fn a_terminal_instance_pod_is_stopped_but_a_terminating_one_blocks_a_protected_stop() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let ns = namespace(&db);
        let pods_path = format!("/api/v1/namespaces/{ns}/pods");
        server.objects.lock().unwrap().get_mut(&pods_path).unwrap()["items"] = json!([{"kind":"Pod","metadata":{"name":"database-1","namespace":ns,"uid":id(88),"deletionTimestamp":"2026-10-11T00:00:00Z","labels":{"cnpg.io/cluster":"database"}},"status":{"phase":"Running"}}]);
        assert!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 0);
        server.objects.lock().unwrap().get_mut(&pods_path).unwrap()["items"][0]["status"]["phase"] =
            "Failed".into();
        assert_eq!(
            coordinator
                .suspend(&db, &Sleep::cold())
                .await
                .unwrap()
                .unwrap()["state"],
            "hibernated"
        );
    }
    #[tokio::test]
    async fn a_terminal_instance_pod_does_not_hold_a_hibernated_database_awake() {
        let db = protected_database();
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        let ns = namespace(&db);
        let storage_path = format!(
            "/api/v1/namespaces/pgcf-system/configmaps/storage-{}",
            text(&db, "id")
        );
        {
            // This database slept through the normal proof, not a physical protection stop.
            let mut objects = server.objects.lock().unwrap();
            objects.get_mut(&storage_path).unwrap()["data"]
                .as_object_mut()
                .unwrap()
                .remove(protection_key());
            objects
                .get_mut(&format!("/api/v1/namespaces/{ns}/pods"))
                .unwrap()["items"] = json!([{"kind":"Pod","metadata":{"name":"database-1","namespace":ns,"uid":id(88),"labels":{"cnpg.io/cluster":"database"}},"status":{"phase":"Failed","reason":"Terminated"}}]);
        }
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let (anchor, _) = coordinator.anchor(&db).await.unwrap();
        let snapshot = coordinator.snapshot().await.unwrap();
        let prior = PowerIntent {
            database: text(&db, "id").into(),
            operation: text(&db["creation"], "operation_id").into(),
            revision: 1,
            mode: "quiesce".into(),
        };
        let mut p = Progress::new(prior.clone(), Phase::Hibernated, anchor, 99_000);
        p.proof_intent = Some(prior.clone());
        p.segment = Some("000000010000000000000001".into());
        p.gateways = Some(snapshot.pods);
        p.key_uid = Some(snapshot.key_uid);
        p.key_version = Some(snapshot.key_version);
        let name = format!("gateway-fence-{}", text(&db, "id"));
        server.objects.lock().unwrap().insert(format!("/api/v1/namespaces/pgcf-system/configmaps/{name}"),json!({"kind":"ConfigMap","metadata":{"name":name,"namespace":SYSTEM,"uid":id(500),"resourceVersion":"1","labels":{DATABASE_LABEL:db["id"],wire("fenceLabel"):"true"}},"data":{"intent.json":serde_json::to_string(&prior).unwrap(),"power.json":serde_json::to_string(&p).unwrap()}}));
        let result = coordinator
            .suspend(&db, &Sleep::cold())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result["state"], "hibernated", "{result}");
        assert_eq!(result["power"]["revision"], 2);
        assert!(
            !server
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|path| path.contains("maintenance-credentials"))
        );
    }
    #[tokio::test]
    async fn a_ready_restored_database_publishes_its_running_fence_under_the_restore() {
        // A restore creates its database without a creation operation; v3 routes need the
        // running fence of the admitted revision before its first sleep.
        let restore = format!("op_{}", "r".repeat(20));
        let source = format!("d{}", "s".repeat(19));
        let mut db = database();
        db["creation"] = Value::Null;
        db["storage_generation"] = 2.into();
        db["archive"]["destination_path"] = format!(
            "s3://native-controller-test/eu-test/{}/g2-{restore}",
            text(&db, "id")
        )
        .into();
        db["recovery"] = json!({"operation_id":restore,"source_database_id":source,"source_archive_path":format!("s3://native-controller-test/eu-test/{source}/g1-op_{}","s".repeat(20)),"source_storage_generation":1,"backup_id":"20261012T000000","status":"running","ever_ready":false});
        assert!(database_valid(&db));
        let server = Server::new(&db, false).await;
        protected_objects(&server, &db);
        {
            // Running PostgreSQL: no hibernation and no physical protection stop.
            let mut objects = server.objects.lock().unwrap();
            let cluster = objects
                .get_mut(&format!(
                    "/apis/postgresql.cnpg.io/v1/namespaces/{}/clusters/database",
                    namespace(&db)
                ))
                .unwrap();
            cluster["metadata"]["annotations"]
                .as_object_mut()
                .unwrap()
                .remove(HIBERNATION);
            cluster["status"] = json!({});
        }
        let controls = Controls::new(&server, &db).await;
        let mut coordinator = PowerCoordinator::with_clock(
            server.k8s.clone(),
            "eu-test".into(),
            1,
            Arc::new(|| 100_000),
        )
        .unwrap();
        coordinator.http = controls.client.clone();
        let ready = json!({"id":db["id"],"generation":1,"state":"ready","archive":{"continuous":true,"ready_wal_files":0}});
        assert_eq!(
            coordinator
                .publish_ready_fence(&db, ready.clone(), false)
                .await
                .unwrap(),
            Some(ready)
        );
        let objects = server.objects.lock().unwrap();
        let fence = &objects[&format!(
            "/api/v1/namespaces/pgcf-system/configmaps/gateway-fence-{}",
            text(&db, "id")
        )];
        let intent: Value = serde_json::from_str(text(&fence["data"], "intent.json")).unwrap();
        assert_eq!(
            intent,
            json!({"database":db["id"],"operation":restore,"revision":1,"mode":"running"})
        );
        assert_eq!(controls.calls.load(Ordering::SeqCst), 1);
    }
}
#[cfg(test)]
mod parked_tests;
