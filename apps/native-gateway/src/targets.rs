// SPDX-License-Identifier: Apache-2.0
//! Authenticated discovery and physical write authority, outside connection hot paths.
use crate::{
    control,
    kubernetes::{AdmissionTarget, Intent, Kubernetes, admission_target},
    storage::{StorageBinding, StorageGate, StorageTrust},
};
use futures_util::StreamExt;
use pgcf_native_protocol::{valid_pattern, valid_schema, wake, wire};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Notify, RwLock, watch};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetIdentity {
    pub address: IpAddr,
    pub pod_uid: String,
    pub node: String,
    pub storage: Option<StorageBinding>,
    pub container_id: Option<String>,
    pub ca: Option<CaIdentity>,
    /// The writer is admitted on the controller's attestation instead of the kubelet's report:
    /// its endpoint, or its `postgres` container, is not yet reported Ready. It is evidence of
    /// how the writer was chosen, never part of its identity: a session started on it continues
    /// when the kubelet's report arrives.
    pub unready: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaIdentity {
    pub ca_secret_uid: String,
    pub ca_secret_resource_version: String,
    pub ca_sha256: String,
}
/// Fixed diagnostic classes only; no discovery object or capability reaches a log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetUnavailable {
    DiscoveryUnavailable,
    WriterIdentityUnavailable,
    StorageAuthorityMissing,
    StorageAuthorityInvalid,
    StorageAuthorityScopeOrFreshnessChanged,
    StorageAuthorityRegressedOrConflicted,
    StorageAuthorityExpired,
    StorageAuthorityRefused,
}
impl TargetUnavailable {
    pub fn code(self) -> &'static str {
        match self {
            Self::DiscoveryUnavailable => "discovery_unavailable",
            Self::WriterIdentityUnavailable => "writer_identity_unavailable",
            Self::StorageAuthorityMissing => "storage_authority_missing",
            Self::StorageAuthorityInvalid => "storage_authority_invalid",
            Self::StorageAuthorityScopeOrFreshnessChanged => {
                "storage_authority_scope_or_freshness_changed"
            }
            Self::StorageAuthorityRegressedOrConflicted => {
                "storage_authority_regressed_or_conflicted"
            }
            Self::StorageAuthorityExpired => "storage_authority_expired",
            Self::StorageAuthorityRefused => "storage_authority_refused",
        }
    }
}
impl std::fmt::Display for TargetUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyStorageBinding {
    pub database_id: String,
    pub storage_uid: String,
    pub namespace_uid: String,
    pub cluster_uid: String,
    pub physical_generation: u64,
    pub volume_identity: Value,
}
/// How long the controller's attestation may stand in for the kubelet's report, counted from the
/// first time this gateway relied on it for a Pod and container. It is the bound a connection has
/// to complete its startup: a Pod the kubelet has not reported Ready within the time a
/// connection is given to start is routed as a Ready endpoint only. The bound is needed because
/// the report cannot always have been seen: a Pod that never becomes Ready, or one that went not
/// Ready before this gateway started, leaves no Ready for the attestation to be spent on.
const ATTESTED_ROUTE_BOUND: Duration = Duration::from_secs(10);

/// What this gateway has itself seen of the controller's current attestation of one database's
/// Pod, kept per Pod, container and revision: an attestation of any other starts again. It is the
/// gateway's own memory and part of no identity, the controller publishes nothing for it.
struct Witness {
    pod_uid: String,
    container_id: String,
    generation: u64,
    /// The first time an identity rested on the attestation instead of the kubelet's report.
    relied_since: Option<Instant>,
    /// The kubelet reported that Pod's endpoint and `postgres` container Ready. The attestation
    /// was for the wake: from then on only the ordinary rules apply to that Pod and container.
    ready_seen: bool,
}
impl Witness {
    fn of(target: &AdmissionTarget) -> Self {
        Self {
            pod_uid: target.pod_uid.clone(),
            container_id: target.container_id.clone(),
            generation: target.generation,
            relied_since: None,
            ready_seen: false,
        }
    }
    fn is(&self, target: &AdmissionTarget) -> bool {
        self.pod_uid == target.pod_uid
            && self.container_id == target.container_id
            && self.generation == target.generation
    }
    /// Whether the attestation may still stand in for the kubelet's report.
    fn open(&self, now: Instant) -> bool {
        !self.ready_seen
            && self
                .relied_since
                .is_none_or(|since| now.saturating_duration_since(since) < ATTESTED_ROUTE_BOUND)
    }
}
#[derive(Default)]
pub struct Targets {
    legacy: HashMap<String, LegacyStorageBinding>,
    identities: HashMap<String, TargetIdentity>,
    slices: HashMap<String, Value>,
    pods: HashMap<String, Value>,
    maps: HashMap<String, Value>,
    gates: HashMap<String, StorageGate>,
    witnesses: HashMap<String, Witness>,
    // The existing gate clears its current claims when verification fails. Retain only the
    // finite reason from that same evaluation, never an additional authorization decision.
    authority_refusals: HashMap<String, TargetUnavailable>,
    slices_observed: Option<Instant>,
    pods_observed: Option<Instant>,
    maps_observed: Option<Instant>,
    /// Signalled after every applied list or event and every loss of a watch: a held wake
    /// connection waits on it for the writer the fence releases it to.
    pub changed: Arc<Notify>,
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16_384)
        .ok_or("missing discovery identity")
}
fn uuid(v: &Value, key: &str) -> Result<String, &'static str> {
    let s = text(v, key)?;
    if !valid_pattern("uuid", s) {
        return Err("invalid discovery UID");
    }
    Ok(s.into())
}
fn json(v: &Value, key: &str) -> Result<Value, &'static str> {
    let raw = text(v, key)?;
    serde_json::from_str(raw).map_err(|_| "invalid storage identity")
}
fn safe_integer(v: &Value) -> Result<u64, &'static str> {
    let n = v.as_f64().ok_or("invalid generation")?;
    if !n.is_finite() || n < 1.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return Err("invalid generation");
    }
    Ok(n as u64)
}
fn owned_map(v: &Value) -> Result<Option<String>, &'static str> {
    if !crate::kubernetes::typed(v, "v1", "ConfigMap")
        || v["metadata"]["namespace"] != wire("fenceNamespace")
    {
        return Err("invalid discovery map");
    }
    let database = text(&v["metadata"]["labels"], "pgcf.io/database-id")?;
    if !valid_pattern("database", database) {
        return Err("invalid discovery database");
    }
    let name = text(&v["metadata"], "name")?;
    uuid(&v["metadata"], "uid")?;
    Ok((name == format!("storage-{database}")
        || name == format!("gateway-fence-{database}")
        || name == format!("ca-{database}"))
    .then(|| name.into()))
}
/// A writer runs in its database's own namespace or in a pool slot's.
fn writer_namespace(namespace: &str) -> bool {
    namespace
        .strip_prefix("pgcf-db-")
        .is_some_and(|v| valid_pattern("database", v))
        || wake::is_slot_namespace(namespace)
}
fn owned_slice(v: &Value) -> Result<String, &'static str> {
    if !crate::kubernetes::typed(v, "discovery.k8s.io/v1", "EndpointSlice")
        || v["metadata"]["labels"]["kubernetes.io/service-name"] != "database-rw"
    {
        return Err("invalid writer discovery");
    }
    if !writer_namespace(text(&v["metadata"], "namespace")?) {
        return Err("invalid writer namespace");
    }
    uuid(&v["metadata"], "uid")
}
fn owned_pod(v: &Value) -> Result<String, &'static str> {
    if !crate::kubernetes::typed(v, "v1", "Pod")
        || v["metadata"]["labels"]["cnpg.io/cluster"] != "database"
    {
        return Err("invalid runtime Pod discovery");
    }
    if !writer_namespace(text(&v["metadata"], "namespace")?) {
        return Err("invalid runtime Pod namespace");
    }
    uuid(&v["metadata"], "uid")
}
impl Targets {
    pub fn with_legacy(raw: &str) -> Result<Self, &'static str> {
        if raw.len() > 1024 * 1024 {
            return Err("legacy custody configuration too large");
        }
        let values: Value =
            serde_json::from_str(raw).map_err(|_| "invalid legacy custody configuration")?;
        let records = values
            .as_array()
            .filter(|v| v.len() <= 2000)
            .ok_or("legacy custody capacity exceeded")?;
        let mut legacy = HashMap::new();
        for raw in records {
            if !pgcf_native_protocol::valid_legacy_storage_binding(raw) {
                return Err("invalid generated legacy custody contract");
            }
            let mut normalized = raw.clone();
            normalized["physical_generation"] = safe_integer(&raw["physical_generation"])?.into();
            let record: LegacyStorageBinding = serde_json::from_value(normalized)
                .map_err(|_| "invalid legacy custody configuration")?;
            if legacy.insert(record.database_id.clone(), record).is_some() {
                return Err("duplicate legacy custody identity");
            }
        }
        Ok(Self {
            legacy,
            ..Self::default()
        })
    }

    /// The running `postgres` container of the Pod. `attested` is the container the controller
    /// verified as running PostgreSQL: only that exact container is accepted before the
    /// kubelet reports it ready.
    fn runtime_container(
        &self,
        pod_uid: &str,
        address: IpAddr,
        node: &str,
        attested: Option<&str>,
    ) -> Option<String> {
        if !self.pods_synchronized() {
            return None;
        }
        let pod = self.pods.get(pod_uid)?;
        if !pod["metadata"]["deletionTimestamp"].is_null()
            || pod["spec"]["nodeName"] != node
            || pod["status"]["podIP"].as_str()?.parse::<IpAddr>().ok()? != address
        {
            return None;
        }
        let container = pod["status"]["containerStatuses"]
            .as_array()?
            .iter()
            .find(|c| c["name"] == "postgres")?;
        let cid = container["containerID"]
            .as_str()?
            .strip_prefix("containerd://")?;
        if (container["ready"] != true && attested != Some(cid))
            || container["state"]["running"].is_null()
        {
            return None;
        }
        (cid.len() == 64
            && cid
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .then(|| cid.into())
    }
    fn current_ca(&self, database: &str) -> Option<CaIdentity> {
        if !self
            .maps_observed
            .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
        {
            return None;
        }
        let map = self.maps.get(&format!("ca-{database}"))?;
        if !map["metadata"]["deletionTimestamp"].is_null() {
            return None;
        }
        let annotations = &map["metadata"]["annotations"];
        let uid = annotations["pgcf.io/source-ca-secret-uid"]
            .as_str()
            .filter(|uid| valid_pattern("uuid", uid))?;
        let rv = annotations["pgcf.io/source-ca-secret-resource-version"]
            .as_str()
            .filter(|rv| !rv.is_empty() && rv.len() <= 128)?;
        let material = map["data"]["ca.crt"]
            .as_str()
            .filter(|ca| !ca.is_empty() && ca.len() <= 65536)?;
        Some(CaIdentity {
            ca_secret_uid: uid.into(),
            ca_secret_resource_version: rv.into(),
            ca_sha256: Sha256::digest(material.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        })
    }
    /// The intent of this database's fence and the target the controller last published in it,
    /// whatever the fence's mode.
    fn published(&self, database: &str) -> Option<(Intent, AdmissionTarget)> {
        let fence = self.maps.get(&format!("gateway-fence-{database}"))?;
        let intent = json(&fence["data"], "intent.json").ok()?;
        if !valid_schema("intent", &intent) {
            return None;
        }
        let intent: Intent = serde_json::from_value(intent).ok()?;
        if intent.database != database {
            return None;
        }
        let target = admission_target(&fence["data"], &intent).ok()??;
        Some((intent, target))
    }
    /// The controller's target for the running revision of this database's fence. A fence that
    /// is quiesced, retired, deleting or ahead of its target attests nothing.
    fn attested(&self, database: &str) -> Option<AdmissionTarget> {
        let fence = self.maps.get(&format!("gateway-fence-{database}"))?;
        if !fence["metadata"]["deletionTimestamp"].is_null() {
            return None;
        }
        let (intent, target) = self.published(database)?;
        (intent.mode == "running" && target.generation == intent.revision).then_some(target)
    }
    /// The namespace of the database's writer: the pool slot its fence's target names, from the
    /// claim until the slot is deleted, or the database's own.
    fn writer_namespace(&self, database: &str) -> String {
        self.published(database)
            .and_then(|(_, target)| {
                wake::slot_namespace_of_tls_name(&target.tls_server_name).map(str::to_string)
            })
            .unwrap_or_else(|| format!("pgcf-db-{database}"))
    }
    /// The databases whose fence names this pool slot: none for a free slot, one for a claimed.
    pub fn slot_databases(&self, namespace: &str) -> Vec<String> {
        self.maps
            .keys()
            .filter_map(|name| name.strip_prefix("gateway-fence-"))
            .filter(|database| {
                self.published(database).is_some_and(|(_, target)| {
                    wake::slot_namespace_of_tls_name(&target.tls_server_name) == Some(namespace)
                })
            })
            .map(str::to_string)
            .collect()
    }
    /// Whether the attestation may still stand in for the kubelet's report of its Pod: not once
    /// this gateway has seen that Pod and container Ready at that revision, and not after the
    /// bound. A new Pod, container or revision is a new attestation.
    fn may_stand_in(&self, database: &str, target: &AdmissionTarget) -> bool {
        self.witnesses
            .get(database)
            .is_none_or(|seen| !seen.is(target) || seen.open(Instant::now()))
    }
    /// Notes in the witness what the identity just derived shows of the attestation the fence
    /// publishes: that the kubelet reported its Pod and container Ready, or that the
    /// attestation stood in for the report.
    fn witness(
        &mut self,
        database: &str,
        published: &AdmissionTarget,
        identity: Option<&TargetIdentity>,
    ) {
        let seen = self
            .witnesses
            .entry(database.into())
            .or_insert_with(|| Witness::of(published));
        if !seen.is(published) {
            *seen = Witness::of(published);
        }
        let Some(identity) = identity.filter(|identity| {
            identity.pod_uid == published.pod_uid
                && identity.container_id.as_deref() == Some(published.container_id.as_str())
        }) else {
            return;
        };
        if identity.unready {
            seen.relied_since.get_or_insert_with(Instant::now);
        } else {
            seen.ready_seen = true;
        }
    }
    /// Whether this Pod runs, in the watched cluster state, the container and TLS authority the
    /// controller attested: nothing else is accepted before the kubelet reports it Ready.
    fn runs_attested(
        &self,
        database: &str,
        attested: &AdmissionTarget,
        pod_uid: &str,
        address: IpAddr,
        node: &str,
    ) -> bool {
        self.runtime_container(pod_uid, address, node, Some(&attested.container_id))
            .as_deref()
            == Some(attested.container_id.as_str())
            && self.current_ca(database).is_some_and(|ca| {
                ca.ca_secret_uid == attested.ca_secret_uid
                    && ca.ca_secret_resource_version == attested.ca_secret_resource_version
                    && ca.ca_sha256 == attested.ca_sha256
            })
    }
    pub fn synchronized(&self) -> bool {
        [self.slices_observed, self.maps_observed]
            .iter()
            .all(|at| at.is_some_and(|at| at.elapsed() < Duration::from_secs(70)))
    }
    /// Whether the Pod watch is current. A container the kubelet has not reported ready, and so
    /// any v4 route, rests on it: a gateway without it cannot admit the connection of a wake.
    pub fn pods_synchronized(&self) -> bool {
        self.pods_observed
            .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
    }
    pub fn replace(
        &mut self,
        kind: &str,
        items: &[Value],
        trust: Option<&StorageTrust>,
    ) -> Result<(), &'static str> {
        if items.len() > 4000 {
            return Err("discovery capacity exceeded");
        }
        let mut next = HashMap::new();
        for item in items {
            let key = if kind == "endpointslices" {
                Some(owned_slice(item)?)
            } else if kind == "pods" {
                Some(owned_pod(item)?)
            } else {
                owned_map(item)?
            };
            if let Some(key) = key
                && next.insert(key, item.clone()).is_some()
            {
                return Err("duplicate discovery identity");
            }
        }
        if kind == "endpointslices" {
            self.slices = next;
            self.slices_observed = Some(Instant::now());
        } else if kind == "pods" {
            self.pods = next;
            self.pods_observed = Some(Instant::now());
        } else {
            self.maps = next;
            self.maps_observed = Some(Instant::now());
        }
        self.refresh_gates(trust);
        self.changed.notify_waiters();
        Ok(())
    }
    pub fn event(
        &mut self,
        kind: &str,
        event: &Value,
        trust: Option<&StorageTrust>,
    ) -> Result<(), &'static str> {
        if event["object"]["metadata"]["resourceVersion"]
            .as_str()
            .is_none_or(|v| v.is_empty() || v.len() > 128)
        {
            return Err("invalid discovery watch version");
        }
        if event["type"] == "BOOKMARK" {
            self.touch(kind);
            return Ok(());
        }
        if !["ADDED", "MODIFIED", "DELETED"]
            .iter()
            .any(|t| event["type"] == *t)
        {
            return Err("invalid discovery watch");
        }
        let object = &event["object"];
        let key = if kind == "endpointslices" {
            Some(owned_slice(object)?)
        } else if kind == "pods" {
            Some(owned_pod(object)?)
        } else {
            owned_map(object)?
        };
        if let Some(key) = key {
            let records = if kind == "endpointslices" {
                &mut self.slices
            } else if kind == "pods" {
                &mut self.pods
            } else {
                &mut self.maps
            };
            if event["type"] == "DELETED" {
                if records
                    .get(&key)
                    .is_some_and(|prior| prior["metadata"]["uid"] != object["metadata"]["uid"])
                {
                    return Err("discovery deletion identity changed");
                }
                records.remove(&key);
            } else {
                if records.len() >= 4000 && !records.contains_key(&key) {
                    return Err("discovery capacity exceeded");
                }
                records.insert(key, object.clone());
            }
        }
        self.touch(kind);
        let databases = if kind == "endpointslices" || kind == "pods" {
            let namespace = text(&object["metadata"], "namespace")?;
            match namespace.strip_prefix("pgcf-db-") {
                Some(database) => vec![database.to_string()],
                // A pool slot belongs to the database whose fence names it, a free one to none.
                None => self.slot_databases(namespace),
            }
        } else {
            vec![text(&object["metadata"]["labels"], "pgcf.io/database-id")?.to_string()]
        };
        for database in databases {
            self.refresh_gate(&database, trust);
        }
        self.changed.notify_waiters();
        Ok(())
    }
    fn touch(&mut self, kind: &str) {
        if kind == "endpointslices" {
            self.slices_observed = Some(Instant::now());
        } else if kind == "pods" {
            self.pods_observed = Some(Instant::now());
        } else {
            self.maps_observed = Some(Instant::now());
        }
    }
    pub fn disconnect(&mut self, kind: &str) {
        if kind == "pods" {
            self.pods_observed = None;
            for target in self.identities.values_mut() {
                target.container_id = None;
            }
        } else {
            if kind == "endpointslices" {
                self.slices_observed = None;
            } else {
                self.maps_observed = None;
            }
            for gate in self.gates.values_mut() {
                gate.disconnect();
            }
        }
        self.changed.notify_waiters();
    }
    /// The writer's address, Pod UID and node, and whether its endpoint is Ready. A Pod the
    /// kubelet has not reported Ready is the writer only when it is the Pod of `attested` (the
    /// attestation that may stand in for the report), nothing else is a candidate, and it runs
    /// the attested container.
    fn endpoint(
        &self,
        database: &str,
        attested: Option<&AdmissionTarget>,
    ) -> Result<(IpAddr, String, String, bool), &'static str> {
        let namespace = self.writer_namespace(database);
        if wake::is_slot_namespace(&namespace) && self.slot_databases(&namespace).len() != 1 {
            return Err("pool slot claimed twice");
        }
        let mut endpoints = BTreeMap::new();
        // The attested Pod while not Ready, and the other endpoints not Ready either.
        let mut waiting = BTreeMap::new();
        let mut others = 0_usize;
        for slice in self.slices.values().filter(|v| {
            v["metadata"]["namespace"] == namespace && v["metadata"]["deletionTimestamp"].is_null()
        }) {
            let ports = slice["ports"].as_array().ok_or("invalid writer ports")?;
            if !ports
                .iter()
                .any(|p| p["port"] == 5432 && (p["protocol"].is_null() || p["protocol"] == "TCP"))
            {
                continue;
            }
            for endpoint in slice["endpoints"]
                .as_array()
                .filter(|v| v.len() <= 1000)
                .ok_or("invalid writer endpoints")?
            {
                if endpoint["conditions"]["terminating"] == true {
                    continue;
                }
                let reference = &endpoint["targetRef"];
                let ready = endpoint["conditions"]["ready"] == true;
                if !ready
                    && !attested.is_some_and(|target| {
                        reference["kind"] == "Pod"
                            && reference["namespace"] == namespace
                            && reference["uid"] == target.pod_uid
                    })
                {
                    others += 1;
                    continue;
                }
                if reference["kind"] != "Pod" || reference["namespace"] != namespace {
                    return Err("writer has no exact Pod target");
                }
                let uid = uuid(reference, "uid")?;
                let node = text(endpoint, "nodeName")?.to_string();
                for address in endpoint["addresses"]
                    .as_array()
                    .filter(|v| v.len() <= 16)
                    .ok_or("invalid writer address")?
                {
                    let address: IpAddr = address
                        .as_str()
                        .ok_or("invalid writer address")?
                        .parse()
                        .map_err(|_| "invalid writer address")?;
                    if !match address {
                        IpAddr::V4(ip) => ip.is_private(),
                        IpAddr::V6(ip) => ip.is_unique_local(),
                    } {
                        return Err("invalid writer address");
                    }
                    if (slice["addressType"] == "IPv4") != address.is_ipv4()
                        || !["IPv4", "IPv6"].iter().any(|t| slice["addressType"] == *t)
                    {
                        return Err("writer address family changed");
                    }
                    if ready {
                        endpoints.insert((uid.clone(), node.clone(), address), ());
                    } else {
                        waiting.insert((uid.clone(), node.clone(), address), ());
                    }
                }
            }
        }
        if endpoints.is_empty() {
            // The kubelet's reflection of readiness trails the controller's own verification of
            // the Pod it resumed. The EndpointSlice still proves the Service selects this Pod.
            let mut waiting = waiting.into_keys();
            return match (attested, waiting.next(), waiting.next(), others) {
                (Some(attested), Some((uid, node, address)), None, 0)
                    if self.runs_attested(database, attested, &uid, address, &node) =>
                {
                    Ok((address, uid, node, false))
                }
                _ => Err("writer target unavailable"),
            };
        }
        let mut selected = None;
        for ((uid, node, address), _) in endpoints {
            if let Some((_, old_uid, old_node)) = &selected {
                if *old_uid != uid || *old_node != node {
                    return Err("ambiguous writer target");
                }
            } else {
                selected = Some((address, uid, node));
            }
        }
        selected
            .map(|(address, uid, node)| (address, uid, node, true))
            .ok_or("writer target unavailable")
    }
    /// The storage binding the writer's I/O authority is checked against. A pool slot has none:
    /// it is routed on the controller's attestation of its Pod and container, on the node of the
    /// database's volume.
    fn binding(
        &self,
        database: &str,
        pod_uid: &str,
        node: &str,
        slot: bool,
    ) -> Result<Option<StorageBinding>, &'static str> {
        let storage = self
            .maps
            .get(&format!("storage-{database}"))
            .ok_or("storage identity unavailable")?;
        let fence = self
            .maps
            .get(&format!("gateway-fence-{database}"))
            .ok_or("power identity unavailable")?;
        if !storage["metadata"]["deletionTimestamp"].is_null()
            || !fence["metadata"]["deletionTimestamp"].is_null()
        {
            return Err("database retiring");
        }
        let state = json(&storage["data"], "state")?;
        if state["node"] != node {
            return Err("writer node changed");
        }
        if slot {
            return Ok(None);
        }
        if state["storage"].is_null() {
            let retained = self
                .legacy
                .get(database)
                .ok_or("database requires signed thin authority")?;
            let power = json(&fence["data"], "power.json")?;
            let anchor = &power["anchor"];
            let identity = json(
                &storage["metadata"]["annotations"],
                "pgcf.io/volume-identity",
            )?;
            if storage["metadata"]["uid"] != retained.storage_uid
                || state["namespaceUid"] != retained.namespace_uid
                || state["clusterUid"] != retained.cluster_uid
                || identity != retained.volume_identity
                || safe_integer(&anchor["physicalGeneration"])? != retained.physical_generation
                || anchor["storageUid"] != retained.storage_uid
                || !anchor["storage"].is_null()
                || json(anchor, "storageState")? != state
                || json(anchor, "volumeIdentity")? != identity
            {
                return Err("retained legacy custody changed");
            }
            return Ok(None);
        }
        let power = json(&fence["data"], "power.json")?;
        let anchor = &power["anchor"];
        if storage["metadata"]["uid"] != anchor["storageUid"]
            || storage["metadata"]["annotations"]["pgcf.io/gateway-fence-uid"]
                != fence["metadata"]["uid"]
            || json(anchor, "storageState")? != state
            || json(anchor, "volumeIdentity")?
                != json(
                    &storage["metadata"]["annotations"],
                    "pgcf.io/volume-identity",
                )?
        {
            return Err("sealed storage identity changed");
        }
        let profile = &state["storage"];
        let hash = text(profile, "profile_sha256")?;
        if profile["backend"] != "lvm-thin-v1"
            || hash.len() != 64
            || !hash
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || profile["storage_class"] != format!("pgcf-lvm-thin-v1-{}", &hash[..16])
            || anchor["storage"] != *profile
        {
            return Err("unapproved storage profile");
        }
        let identity = json(
            &storage["metadata"]["annotations"],
            "pgcf.io/volume-identity",
        )?;
        let intent = json(&fence["data"], "intent.json")?;
        Ok(Some(StorageBinding {
            database_id: database.into(),
            generation: safe_integer(&intent["revision"])?,
            storage_uid: uuid(&storage["metadata"], "uid")?,
            node_uid: uuid(profile, "node_uid")?,
            volume_group_uuid: text(profile, "volume_group_uuid")?.into(),
            pool_uuid: text(profile, "pool_uuid")?.into(),
            profile_sha256: hash.into(),
            volume_handle: text(&identity, "handle")?.into(),
            lv_uuid: text(&identity, "lvUuid")?.into(),
            pvc_uid: uuid(&identity, "claimUid")?,
            pv_uid: uuid(&identity, "volumeUid")?,
            pod_uid: pod_uid.into(),
        }))
    }
    fn refresh_gates(&mut self, trust: Option<&StorageTrust>) {
        let names = self
            .maps
            .keys()
            .filter_map(|name| name.strip_prefix("storage-").map(str::to_string))
            .collect::<Vec<_>>();
        self.identities
            .retain(|database, _| self.maps.contains_key(&format!("storage-{database}")));
        self.gates.retain(|database, _| {
            self.maps.contains_key(&format!("storage-{database}"))
                || self.maps.contains_key(&format!("gateway-fence-{database}"))
        });
        self.authority_refusals.retain(|database, _| {
            self.maps.contains_key(&format!("storage-{database}"))
                || self.maps.contains_key(&format!("gateway-fence-{database}"))
        });
        self.witnesses.retain(|database, _| {
            self.maps.contains_key(&format!("storage-{database}"))
                || self.maps.contains_key(&format!("gateway-fence-{database}"))
        });
        for database in names {
            self.refresh_gate(&database, trust);
        }
    }
    /// The CNPG writer: the Pod of the Ready endpoint, or the controller's attested Pod while the
    /// kubelet has not reported it. What the identity shows of the attestation is kept in the
    /// witness, which is what ends the attestation's standing in for the report.
    fn writer_identity(&mut self, database: &str) -> Result<TargetIdentity, &'static str> {
        let published = self.attested(database);
        let usable = published
            .as_ref()
            .filter(|target| self.may_stand_in(database, target));
        let identity =
            self.endpoint(database, usable)
                .and_then(|(address, pod_uid, node, ready)| {
                    // The attestation of this Pod alone can vouch for its container.
                    let attested = usable.filter(|target| target.pod_uid == pod_uid);
                    let reported = self.runtime_container(&pod_uid, address, &node, None);
                    let container_id = match attested {
                        Some(target) => self.runtime_container(
                            &pod_uid,
                            address,
                            &node,
                            Some(&target.container_id),
                        ),
                        None => reported.clone(),
                    };
                    Ok(TargetIdentity {
                        address,
                        // Not reported Ready by the kubelet: its endpoint, or a container that only
                        // the attestation accepts.
                        unready: !ready || container_id != reported,
                        container_id,
                        ca: self.current_ca(database),
                        storage: self.binding(
                            database,
                            &pod_uid,
                            &node,
                            wake::is_slot_namespace(&self.writer_namespace(database)),
                        )?,
                        pod_uid,
                        node,
                    })
                });
        if let Some(published) = &published {
            self.witness(database, published, identity.as_ref().ok());
        }
        identity
    }
    fn refresh_gate(&mut self, database: &str, trust: Option<&StorageTrust>) {
        let now = control::now();
        let identity = self.writer_identity(database);
        if !self.maps.contains_key(&format!("storage-{database}"))
            && !self.maps.contains_key(&format!("gateway-fence-{database}"))
        {
            self.identities.remove(database);
            self.gates.remove(database);
            self.authority_refusals.remove(database);
            self.witnesses.remove(database);
            return;
        }
        if self.gates.len() >= 4000 && !self.gates.contains_key(database) {
            self.identities.remove(database);
            return;
        }
        let gate = self.gates.entry(database.to_string()).or_default();
        let Ok(identity) = identity else {
            self.identities.remove(database);
            gate.disconnect();
            return;
        };
        if let Some(binding) = &identity.storage {
            let outcome = (|| {
                let trust = trust.ok_or(TargetUnavailable::StorageAuthorityMissing)?;
                let raw = text(
                    &self.maps[&format!("storage-{database}")]["data"],
                    wire("storageAuthorityLedgerKey"),
                )
                .map_err(|_| TargetUnavailable::StorageAuthorityMissing)?;
                let verified = trust
                    .verify(raw, now)
                    .map_err(|_| TargetUnavailable::StorageAuthorityInvalid)?;
                gate.update(verified, binding, now)
                    .map_err(|reason| match reason {
                        "storage authority identity or freshness changed" => {
                            TargetUnavailable::StorageAuthorityScopeOrFreshnessChanged
                        }
                        "storage authority regressed or conflicted" => {
                            TargetUnavailable::StorageAuthorityRegressedOrConflicted
                        }
                        _ => TargetUnavailable::StorageAuthorityInvalid,
                    })
            })();
            if let Err(reason) = outcome {
                gate.disconnect();
                self.authority_refusals.insert(database.into(), reason);
            } else {
                self.authority_refusals.remove(database);
            }
        } else {
            self.authority_refusals.remove(database);
        }
        self.identities.insert(database.into(), identity);
    }
    fn current_target(
        &self,
        database: &str,
        now: u64,
    ) -> Result<&TargetIdentity, TargetUnavailable> {
        if !valid_pattern("database", database) || !self.synchronized() {
            return Err(TargetUnavailable::DiscoveryUnavailable);
        }
        let target = self
            .identities
            .get(database)
            .ok_or(TargetUnavailable::WriterIdentityUnavailable)?;
        // The attestation ends with the kubelet's report or with its bound, and no event of the
        // cluster marks the bound: it is read here, for every admission and every check of a
        // session.
        if target.unready
            && !self
                .witnesses
                .get(database)
                .is_some_and(|seen| seen.open(Instant::now()))
        {
            return Err(TargetUnavailable::WriterIdentityUnavailable);
        }
        if target.storage.as_ref().is_some_and(|binding| {
            !self
                .gates
                .get(database)
                .is_some_and(|gate| gate.permits(binding, now))
        }) {
            return Err(self
                .authority_refusals
                .get(database)
                .copied()
                .unwrap_or_else(|| {
                    if self
                        .gates
                        .get(database)
                        .and_then(StorageGate::deadline)
                        .is_some_and(|expiry| expiry <= now)
                    {
                        TargetUnavailable::StorageAuthorityExpired
                    } else {
                        TargetUnavailable::StorageAuthorityRefused
                    }
                }));
        }
        Ok(target)
    }
    pub fn target(&self, database: &str, now: u64) -> Result<TargetIdentity, TargetUnavailable> {
        let mut target = self.current_target(database, now)?.clone();
        if !self.pods_synchronized() {
            // The Pod watch is what recognized a writer the kubelet has not reported Ready.
            if target.unready {
                return Err(TargetUnavailable::WriterIdentityUnavailable);
            }
            target.container_id = None;
        }
        Ok(target)
    }
    pub fn write_budget(&self, database: &str, now: u64) -> Duration {
        if self
            .identities
            .get(database)
            .is_some_and(|target| target.storage.is_some())
        {
            Duration::from_millis(
                self.gates
                    .get(database)
                    .and_then(StorageGate::deadline)
                    .unwrap_or(now)
                    .saturating_sub(now)
                    .min(10_000),
            )
        } else {
            Duration::from_secs(10)
        }
    }
    pub fn storage_generation(&self, database: &str) -> Option<u64> {
        self.identities
            .get(database)
            .and_then(|v| v.storage.as_ref().map(|v| v.generation))
    }
    pub fn permits(&self, database: &str, target: &TargetIdentity, now: u64) -> bool {
        let Ok(current) = self.current_target(database, now) else {
            return false;
        };
        if current.address != target.address
            || current.pod_uid != target.pod_uid
            || current.node != target.node
            || (target.container_id.is_some()
                && (current.container_id != target.container_id || !self.pods_synchronized()))
            || (target.ca.is_some() && current.ca != target.ca)
        {
            return false;
        }
        match (&current.storage, &target.storage) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                a.database_id == b.database_id
                    && a.storage_uid == b.storage_uid
                    && a.node_uid == b.node_uid
                    && a.volume_group_uuid == b.volume_group_uuid
                    && a.pool_uuid == b.pool_uuid
                    && a.profile_sha256 == b.profile_sha256
                    && a.volume_handle == b.volume_handle
                    && a.lv_uuid == b.lv_uuid
                    && a.pvc_uid == b.pvc_uid
                    && a.pv_uid == b.pv_uid
                    && a.pod_uid == b.pod_uid
            }
            _ => false,
        }
    }
}

fn discovery(kind: &str) -> (String, &'static str) {
    match kind {
        "endpointslices" => (
            "/apis/discovery.k8s.io/v1/endpointslices".into(),
            "kubernetes.io/service-name=database-rw",
        ),
        "pods" => ("/api/v1/pods".into(), "cnpg.io/cluster=database"),
        _ => (
            format!("/api/v1/namespaces/{}/configmaps", wire("fenceNamespace")),
            "pgcf.io/database-id",
        ),
    }
}
pub async fn synchronize(
    api: Arc<Kubernetes>,
    state: Arc<RwLock<Targets>>,
    trust: Option<StorageTrust>,
    kind: &'static str,
    mut stop: watch::Receiver<bool>,
) {
    let (path, selector) = discovery(kind);
    loop {
        if *stop.borrow() {
            break;
        }
        let result =
            tokio::select! {v=api.discovery_list(&path,selector)=>v,_=stop.changed()=>break};
        let mut clean_rollover = false;
        if let Ok(list) = result {
            let expected_api = if kind == "endpointslices" {
                "discovery.k8s.io/v1"
            } else {
                "v1"
            };
            let expected_kind = if kind == "endpointslices" {
                "EndpointSliceList"
            } else if kind == "pods" {
                "PodList"
            } else {
                "ConfigMapList"
            };
            if list["apiVersion"] == expected_api
                && list["kind"] == expected_kind
                && list["metadata"]["continue"]
                    .as_str()
                    .is_none_or(str::is_empty)
                && let (Some(items), Some(version)) = (
                    list["items"].as_array(),
                    list["metadata"]["resourceVersion"].as_str(),
                )
                && state
                    .write()
                    .await
                    .replace(kind, items, trust.as_ref())
                    .is_ok()
            {
                clean_rollover =
                    watch_stream(&api, version, &state, trust.as_ref(), kind, &mut stop)
                        .await
                        .is_ok();
            }
        }

        if clean_rollover {
            continue;
        }
        state.write().await.disconnect(kind);
        if *stop.borrow() {
            break;
        }
        tokio::select! {_=tokio::time::sleep(Duration::from_secs(1))=>{},_=stop.changed()=>break}
    }
    state.write().await.disconnect(kind);
}
async fn watch_stream(
    api: &Kubernetes,
    version: &str,
    state: &RwLock<Targets>,
    trust: Option<&StorageTrust>,
    kind: &str,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (path, selector) = discovery(kind);
    let response = tokio::select! {v=api.discovery_watch(&path,selector,version)=>v?,_=stop.changed()=>return Ok(())};
    let started = Instant::now();
    let mut stream = response.bytes_stream();
    let mut line = Vec::new();
    loop {
        let next = tokio::select! {v=tokio::time::timeout(Duration::from_secs(60),stream.next())=>v?,_=stop.changed()=>return Ok(())};
        let Some(chunk) = next else {
            if !line.is_empty() {
                return Err("truncated discovery event".into());
            }
            if started.elapsed() < Duration::from_secs(50) {
                return Err("discovery watch ended early".into());
            }
            return Ok(());
        };
        for byte in chunk? {
            if byte == b'\n' {
                if !line.is_empty() {
                    let event: Value = serde_json::from_slice(&line)?;
                    state.write().await.event(kind, &event, trust)?;
                    line.clear();
                }
            } else {
                if line.len() >= 64 * 1024 {
                    return Err("discovery event too large".into());
                }
                line.push(byte);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn slice(uid: &str, ip: &str) -> Value {
        json!({"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice","metadata":{"namespace":"pgcf-db-aaaaaaaaaaaaaaaaaaaa","uid":"11111111-1111-4111-8111-111111111111","labels":{"kubernetes.io/service-name":"database-rw"}},"addressType":"IPv4","ports":[{"port":5432,"protocol":"TCP"}],"endpoints":[{"addresses":[ip],"conditions":{"ready":true},"targetRef":{"kind":"Pod","namespace":"pgcf-db-aaaaaaaaaaaaaaaaaaaa","uid":uid},"nodeName":"customer-us1"}]})
    }
    #[test]
    fn pod_watch_binds_the_running_container_and_a_gap_never_preserves_it() {
        let uid = "22222222-2222-4222-8222-222222222222";
        let mut state = Targets::default();
        let mut pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":"pgcf-db-aaaaaaaaaaaaaaaaaaaa","uid":uid,"resourceVersion":"1","labels":{"cnpg.io/cluster":"database"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.7","containerStatuses":[{"name":"postgres","ready":true,"containerID":format!("containerd://{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-13T10:00:00Z"}}}]}});
        state
            .replace("pods", std::slice::from_ref(&pod), None)
            .unwrap();
        let address = "10.0.0.7".parse().unwrap();
        assert_eq!(
            state.runtime_container(uid, address, "customer-us1", None),
            Some("a".repeat(64))
        );
        pod["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "b".repeat(64)).into();
        pod["metadata"]["resourceVersion"] = "2".into();
        state
            .event("pods", &json!({"type":"MODIFIED","object":pod}), None)
            .unwrap();
        assert_eq!(
            state.runtime_container(uid, address, "customer-us1", None),
            Some("b".repeat(64))
        );
        state.disconnect("pods");
        assert_eq!(
            state.runtime_container(uid, address, "customer-us1", None),
            None
        );
    }
    #[test]
    fn watched_ca_replacement_and_missing_source_identity_invalidate_v4_trust() {
        let database = "a".repeat(20);
        let uid = "22222222-2222-4222-8222-222222222222";
        let mut state = Targets::default();
        let mut params = rcgen::CertificateParams::new(vec!["runtime-ca".into()]).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = params
            .self_signed(&rcgen::KeyPair::generate().unwrap())
            .unwrap()
            .pem();
        let mut map = json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"namespace":"pgcf-system","name":format!("ca-{database}"),"uid":uid,"resourceVersion":"1","labels":{"pgcf.io/database-id":database},"annotations":{"pgcf.io/source-ca-secret-uid":uid,"pgcf.io/source-ca-secret-resource-version":"7"}},"data":{"ca.crt":ca}});
        state.replace("configmaps", &[map.clone()], None).unwrap();
        let before = state.current_ca(&database).unwrap();
        map["metadata"]["annotations"]["pgcf.io/source-ca-secret-resource-version"] = "8".into();
        state
            .event(
                "configmaps",
                &json!({"type":"MODIFIED","object":map.clone()}),
                None,
            )
            .unwrap();
        assert_ne!(before, state.current_ca(&database).unwrap());
        map["metadata"]["annotations"] = Value::Null;
        state.replace("configmaps", &[map], None).unwrap();
        assert!(state.current_ca(&database).is_none());
        state.disconnect("configmaps");
        assert!(state.current_ca(&database).is_none());
    }
    #[test]
    fn list_items_without_type_meta_synchronize_and_a_stated_mismatch_fails() {
        // kube-apiserver omits TypeMeta on built-in list items; watch objects carry it.
        let mut state = Targets::default();
        let mut object = slice("22222222-2222-4222-8222-222222222222", "10.0.0.7");
        object.as_object_mut().unwrap().remove("apiVersion");
        object.as_object_mut().unwrap().remove("kind");
        state
            .replace("endpointslices", &[object.clone()], None)
            .unwrap();
        let map = json!({"metadata":{"namespace":"pgcf-system","name":"storage-aaaaaaaaaaaaaaaaaaaa","uid":"55555555-5555-4555-8555-555555555555","labels":{"pgcf.io/database-id":"aaaaaaaaaaaaaaaaaaaa"}},"data":{}});
        state.replace("configmaps", &[map], None).unwrap();
        assert!(state.synchronized());
        object["kind"] = "Service".into();
        assert!(state.replace("endpointslices", &[object], None).is_err());
    }
    #[test]
    fn exact_ready_target_is_required_and_ambiguous_writers_are_rejected() {
        let mut state = Targets::default();
        let mut object = slice("22222222-2222-4222-8222-222222222222", "10.0.0.7");
        state
            .replace("endpointslices", &[object.clone()], None)
            .unwrap();
        assert_eq!(
            state
                .endpoint("aaaaaaaaaaaaaaaaaaaa", None)
                .unwrap()
                .0
                .to_string(),
            "10.0.0.7"
        );
        object["endpoints"][0]["conditions"]["ready"] = false.into();
        state
            .replace("endpointslices", &[object.clone()], None)
            .unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa", None).is_err());
        object["endpoints"][0]["conditions"]["ready"] = true.into();
        let mut replacement = slice("33333333-3333-4333-8333-333333333333", "10.0.0.8");
        replacement["metadata"]["uid"] = "44444444-4444-4444-8444-444444444444".into();
        state
            .replace("endpointslices", &[object, replacement], None)
            .unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa", None).is_err());
    }
    #[test]
    fn endpoint_identity_cannot_be_inferred_from_a_certificate_or_claim() {
        let mut state = Targets::default();
        let mut object = slice("22222222-2222-4222-8222-222222222222", "10.0.0.7");
        object["endpoints"][0]["targetRef"]["uid"] = Value::Null;
        state.replace("endpointslices", &[object], None).unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa", None).is_err());
    }
    #[test]
    fn public_or_loopback_writer_addresses_are_never_dialed() {
        for ip in ["127.0.0.1", "8.8.8.8", "0.0.0.0", "224.0.0.1"] {
            let mut state = Targets::default();
            state
                .replace(
                    "endpointslices",
                    &[slice("22222222-2222-4222-8222-222222222222", ip)],
                    None,
                )
                .unwrap();
            assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa", None).is_err());
        }
    }
    #[test]
    fn immutable_legacy_configuration_rejects_unknown_or_duplicate_identities() {
        assert!(Targets::with_legacy("{}").is_err());
        assert!(Targets::with_legacy("[{\"database_id\":\"invalid\"}]").is_err());
        assert!(Targets::with_legacy("[]").unwrap().legacy.is_empty());
    }

    #[test]
    fn target_refusal_distinguishes_discovery_from_missing_writer_identity() {
        let mut state = Targets::default();
        assert_eq!(
            state
                .target("aaaaaaaaaaaaaaaaaaaa", 0)
                .unwrap_err()
                .to_string(),
            "discovery_unavailable"
        );
        state.replace("endpointslices", &[], None).unwrap();
        state.replace("configmaps", &[], None).unwrap();
        assert_eq!(
            state
                .target("aaaaaaaaaaaaaaaaaaaa", 0)
                .unwrap_err()
                .to_string(),
            "writer_identity_unavailable"
        );
    }

    // The Pod a fast wake resumed is routed before the kubelet reports it Ready, on the
    // controller's attestation and nothing weaker.
    const WAKE: &str = "aaaaaaaaaaaaaaaaaaaa";
    const WAKE_CA: &str = "public test certificate material";
    fn wake_id(number: u32) -> String {
        format!("00000000-0000-4000-8000-{number:012x}")
    }
    fn sha256_hex(text: &str) -> String {
        Sha256::digest(text.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    /// A retained thick database whose parked Pod `wake_id(3)` was resumed: the fence runs at
    /// revision 7 and carries the controller's target for that Pod's `postgres` container, and
    /// the kubelet has reported neither the endpoint nor the container Ready.
    struct Wake {
        state: Targets,
        slices: Vec<Value>,
        pods: Vec<Value>,
        maps: Vec<Value>,
    }
    impl Wake {
        fn new() -> Self {
            let id = wake_id;
            let volume =
                json!({"handle":format!("pvc-{}",id(5)),"claimUid":id(5),"volumeUid":id(6)});
            let storage = json!({"node":"customer-us1","namespaceUid":id(7),"clusterUid":id(8)});
            let cohort = json!([{"database_id":WAKE,"storage_uid":id(2),"namespace_uid":id(7),"cluster_uid":id(8),"physical_generation":1,"volume_identity":volume}]);
            let labels = json!({"pgcf.io/database-id":WAKE});
            let target = json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":id(3),"container_id":"a".repeat(64),"ca_secret_uid":id(21),"ca_secret_resource_version":"81","ca_sha256":sha256_hex(WAKE_CA),"tls_server_name":format!("database-rw.pgcf-db-{WAKE}.svc")});
            let intent = json!({"database":WAKE,"operation":format!("op_{}","b".repeat(20)),"revision":7,"mode":"running"});
            let mut writer = slice(&id(3), "10.0.0.7");
            writer["endpoints"][0]["conditions"] =
                json!({"ready":false,"serving":false,"terminating":false});
            let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":format!("pgcf-db-{WAKE}"),"uid":id(3),"resourceVersion":"1","labels":{"cnpg.io/cluster":"database"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.7","containerStatuses":[{"name":"postgres","ready":false,"containerID":format!("containerd://{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-15T10:00:00Z"}}}]}});
            Self {
                state: Targets::with_legacy(&cohort.to_string()).unwrap(),
                slices: vec![writer],
                pods: vec![pod],
                maps: vec![
                    json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{WAKE}"),"namespace":"pgcf-system","uid":id(2),"labels":labels,"annotations":{"pgcf.io/volume-identity":volume.to_string()}},"data":{"state":storage.to_string()}}),
                    json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{WAKE}"),"namespace":"pgcf-system","uid":id(100),"labels":labels},"data":{"power.json":json!({"anchor":{"storageUid":id(2),"storageState":storage.to_string(),"volumeIdentity":volume.to_string(),"physicalGeneration":1}}).to_string(),"intent.json":intent.to_string(),"admission_target":target.to_string()}}),
                    json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{WAKE}"),"namespace":"pgcf-system","uid":id(20),"labels":labels,"annotations":{"pgcf.io/source-ca-secret-uid":id(21),"pgcf.io/source-ca-secret-resource-version":"81"}},"data":{"ca.crt":WAKE_CA}}),
                ],
            }
        }
        /// The fixture as the controller leaves it; it must route, so that a refusal below is
        /// the doing of the one thing a test changes.
        fn armed() -> Self {
            let mut wake = Self::new();
            wake.apply();
            wake.route().expect("the attested Pod routes before Ready");
            wake
        }
        fn apply(&mut self) {
            let state = &mut self.state;
            state.replace("endpointslices", &self.slices, None).unwrap();
            state.replace("pods", &self.pods, None).unwrap();
            state.replace("configmaps", &self.maps, None).unwrap();
        }
        fn route(&self) -> Result<TargetIdentity, TargetUnavailable> {
            self.state.target(WAKE, control::now())
        }
        fn edit(&mut self, key: &str, change: impl FnOnce(&mut Value)) {
            let mut value: Value =
                serde_json::from_str(self.maps[1]["data"][key].as_str().unwrap()).unwrap();
            change(&mut value);
            self.maps[1]["data"][key] = value.to_string().into();
        }
        /// What the kubelet reports of the resumed Pod: its endpoint and its `postgres`
        /// container ready or not. Applied with the next `apply`.
        fn kubelet(&mut self, ready: bool) {
            self.slices[0]["endpoints"][0]["conditions"] = if ready {
                json!({"ready":true})
            } else {
                json!({"ready":false,"serving":false,"terminating":false})
            };
            self.pods[0]["status"]["containerStatuses"][0]["ready"] = ready.into();
        }
    }
    #[test]
    fn an_attested_pod_is_routed_before_its_ready_condition_and_keeps_its_route_when_ready() {
        let mut wake = Wake::new();
        wake.apply();
        let target = wake.route().unwrap();
        assert!(target.unready);
        assert_eq!(target.address.to_string(), "10.0.0.7");
        assert_eq!(target.pod_uid, wake_id(3));
        assert_eq!(target.container_id, Some("a".repeat(64)));
        assert_eq!(target.ca.as_ref().unwrap().ca_sha256, sha256_hex(WAKE_CA));
        assert!(wake.state.permits(WAKE, &target, control::now()));
        // The kubelet's reflection arrives: the same writer, so the connection that triggered
        // the wake is not interrupted by it.
        wake.slices[0]["endpoints"][0]["conditions"] = json!({"ready":true});
        wake.pods[0]["status"]["containerStatuses"][0]["ready"] = true.into();
        wake.apply();
        let ready = wake.route().unwrap();
        assert!(!ready.unready);
        assert_eq!(
            TargetIdentity {
                unready: true,
                ..ready
            },
            target
        );
        assert!(wake.state.permits(WAKE, &target, control::now()));
    }
    #[test]
    fn an_unready_pod_is_not_routed_without_an_attested_target() {
        let mut wake = Wake::armed();
        wake.maps[1]["data"]
            .as_object_mut()
            .unwrap()
            .remove("admission_target");
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn an_attested_target_never_routes_a_pod_with_another_uid() {
        let mut wake = Wake::armed();
        // A replacement Pod is not the attested one, whatever container it reports.
        wake.slices[0]["endpoints"][0]["targetRef"]["uid"] = wake_id(4).into();
        wake.pods[0]["metadata"]["uid"] = wake_id(4).into();
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn the_attested_pod_must_be_listed_for_this_database_by_its_own_service() {
        let mut wake = Wake::armed();
        wake.slices[0]["metadata"]["namespace"] = "pgcf-db-bbbbbbbbbbbbbbbbbbbb".into();
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.slices[0]["endpoints"][0]["targetRef"]["namespace"] =
            "pgcf-db-bbbbbbbbbbbbbbbbbbbb".into();
        wake.apply();
        assert!(wake.route().is_err());
        // Another Service's slice is not discovery for the writer at all.
        let wake = Wake::armed();
        let mut other = wake.slices[0].clone();
        other["metadata"]["labels"]["kubernetes.io/service-name"] = "database-ro".into();
        let mut state = Targets::default();
        assert!(state.replace("endpointslices", &[other], None).is_err());
    }
    #[test]
    fn a_terminating_attested_pod_is_never_routed() {
        let mut wake = Wake::armed();
        wake.slices[0]["endpoints"][0]["conditions"]["terminating"] = true.into();
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.pods[0]["metadata"]["deletionTimestamp"] = "2026-10-15T10:00:00Z".into();
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn two_candidate_writers_are_never_routed() {
        // The attested Pod listed at a second address.
        let mut wake = Wake::armed();
        let mut second = wake.slices[0].clone();
        second["metadata"]["uid"] = wake_id(30).into();
        second["endpoints"][0]["addresses"] = json!(["10.0.0.8"]);
        wake.slices.push(second);
        wake.apply();
        assert!(wake.route().is_err());
        // The attested Pod beside another Pod the kubelet has not reported Ready either.
        let mut wake = Wake::armed();
        let mut stranger = wake.slices[0].clone();
        stranger["metadata"]["uid"] = wake_id(30).into();
        stranger["endpoints"][0]["addresses"] = json!(["10.0.0.9"]);
        stranger["endpoints"][0]["targetRef"]["uid"] = wake_id(4).into();
        wake.slices.push(stranger);
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn an_unready_container_must_be_the_attested_running_one() {
        // A restarted container carries another ID.
        let mut wake = Wake::armed();
        wake.pods[0]["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "b".repeat(64)).into();
        wake.apply();
        assert!(wake.route().is_err());
        // A container that is not running is not evidence of anything.
        let mut wake = Wake::armed();
        wake.pods[0]["status"]["containerStatuses"][0]["state"] =
            json!({"terminated":{"exitCode":1}});
        wake.apply();
        assert!(wake.route().is_err());
        // A Ready endpoint keeps what it always had: its container is evidence only once the
        // kubelet reports it ready, unless it is the attested one.
        let mut wake = Wake::armed();
        wake.slices[0]["endpoints"][0]["conditions"] = json!({"ready":true});
        wake.pods[0]["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "b".repeat(64)).into();
        wake.apply();
        assert_eq!(wake.route().unwrap().container_id, None);
    }
    #[test]
    fn an_attested_pod_is_routed_only_under_its_running_fence_at_its_revision() {
        let mut wake = Wake::armed();
        wake.edit("intent.json", |intent| intent["mode"] = "quiesce".into());
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.edit("intent.json", |intent| intent["mode"] = "retired".into());
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.maps[1]["metadata"]["deletionTimestamp"] = "2026-10-15T10:00:00Z".into();
        wake.apply();
        assert!(wake.route().is_err());
        // The fence moved on to a revision the controller has not attested yet.
        let mut wake = Wake::armed();
        wake.edit("intent.json", |intent| intent["revision"] = 8.into());
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn an_attested_endpoint_needs_one_private_address() {
        let mut wake = Wake::armed();
        wake.slices[0]["endpoints"][0]["addresses"] = json!(["8.8.8.8"]);
        wake.pods[0]["status"]["podIP"] = "8.8.8.8".into();
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.slices[0]["endpoints"][0]["addresses"] = json!(["10.0.0.7", "10.0.0.8"]);
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn a_lost_pod_watch_withdraws_the_unready_route_it_was_built_on() {
        let mut wake = Wake::armed();
        let target = wake.route().unwrap();
        wake.state.disconnect("pods");
        assert!(wake.route().is_err());
        assert!(!wake.state.permits(WAKE, &target, control::now()));
        // The watch comes back and shows the same container: the route returns.
        wake.apply();
        assert_eq!(wake.route().unwrap(), target);
    }
    #[test]
    fn a_changed_tls_authority_withdraws_the_unready_route() {
        let mut wake = Wake::armed();
        wake.maps[2]["metadata"]["annotations"]["pgcf.io/source-ca-secret-resource-version"] =
            "82".into();
        wake.maps[2]["data"]["ca.crt"] = "refreshed public certificate material".into();
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn a_not_ready_flip_after_ready_withdraws_the_attested_route_and_permits() {
        let mut wake = Wake::armed();
        let attested = wake.route().unwrap();
        assert!(attested.unready);
        // The kubelet reports the Pod Ready: the attestation has done its work for it.
        wake.kubelet(true);
        wake.apply();
        let ready = wake.route().unwrap();
        assert!(!ready.unready);
        // It is not Ready again while the fence still carries the same attestation: PostgreSQL
        // down under the same container, an operator's fence, a lost node. Only the ordinary
        // rules apply to that Pod and container from now on, and they refuse it.
        wake.kubelet(false);
        wake.apply();
        assert!(wake.route().is_err());
        for target in [&attested, &ready] {
            assert!(!wake.state.permits(WAKE, target, control::now()));
        }
        // Neither the next list nor a watch event of the same Pod brings the route back.
        wake.apply();
        assert!(wake.route().is_err());
        let pod = wake.pods[0].clone();
        wake.state
            .event("pods", &json!({"type":"MODIFIED","object":pod}), None)
            .unwrap();
        assert!(wake.route().is_err());
        assert!(!wake.state.permits(WAKE, &ready, control::now()));
        // The kubelet's report is what routes it again.
        wake.kubelet(true);
        wake.apply();
        let again = wake.route().unwrap();
        assert!(!again.unready);
        assert!(wake.state.permits(WAKE, &ready, control::now()));
    }
    #[test]
    fn a_new_revision_of_the_attestation_is_not_spent_by_an_earlier_ready() {
        let mut wake = Wake::armed();
        wake.kubelet(true);
        wake.apply();
        assert!(!wake.route().unwrap().unready);
        wake.kubelet(false);
        wake.apply();
        assert!(wake.route().is_err());
        // The controller attests the same Pod and container at the next revision of the
        // fence, as it does after every wake.
        wake.edit("intent.json", |intent| intent["revision"] = 8.into());
        wake.edit("admission_target", |target| target["generation"] = 8.into());
        wake.apply();
        assert!(wake.route().unwrap().unready);
    }
    #[test]
    fn a_ready_endpoint_of_another_pod_wins_and_never_borrows_the_attestation() {
        let mut wake = Wake::armed();
        // Another Pod of the Service, Ready, whose container carries the attested ID but is
        // not reported ready: the attestation names the first Pod, not this one.
        let mut other = wake.slices[0].clone();
        other["metadata"]["uid"] = wake_id(30).into();
        other["endpoints"][0]["addresses"] = json!(["10.0.0.8"]);
        other["endpoints"][0]["conditions"] = json!({"ready":true});
        other["endpoints"][0]["targetRef"]["uid"] = wake_id(4).into();
        wake.slices.push(other);
        let mut pod = wake.pods[0].clone();
        pod["metadata"]["uid"] = wake_id(4).into();
        pod["status"]["podIP"] = "10.0.0.8".into();
        wake.pods.push(pod);
        wake.apply();
        let routed = wake.route().unwrap();
        assert_eq!(routed.pod_uid, wake_id(4));
        assert_eq!(routed.address.to_string(), "10.0.0.8");
        assert!(!routed.unready);
        assert_eq!(routed.container_id, None);
    }
    #[test]
    fn an_attested_pod_whose_watched_node_or_address_differs_from_its_endpoint_is_not_routed() {
        let mut wake = Wake::armed();
        wake.pods[0]["spec"]["nodeName"] = "customer-us2".into();
        wake.apply();
        assert!(wake.route().is_err());
        let mut wake = Wake::armed();
        wake.pods[0]["status"]["podIP"] = "10.0.0.8".into();
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn a_stale_pod_watch_without_a_disconnect_withdraws_the_unready_route() {
        let mut wake = Wake::armed();
        let target = wake.route().unwrap();
        // The watch neither failed nor delivered an event or bookmark for longer than it may.
        wake.state.pods_observed = Instant::now().checked_sub(Duration::from_secs(71));
        assert!(wake.state.pods_observed.is_some());
        assert!(wake.route().is_err());
        assert!(!wake.state.permits(WAKE, &target, control::now()));
        // Its next event is the proof of the Pod again.
        let pod = wake.pods[0].clone();
        wake.state
            .event("pods", &json!({"type":"MODIFIED","object":pod}), None)
            .unwrap();
        assert_eq!(wake.route().unwrap(), target);
    }
    #[test]
    fn an_established_unready_target_fails_permits_on_every_withdrawal() {
        type Withdrawal = (&'static str, fn(&mut Wake));
        let withdrawals: [Withdrawal; 5] = [
            ("the fence quiesces at the next revision", |wake| {
                wake.edit("intent.json", |intent| {
                    intent["mode"] = "quiesce".into();
                    intent["revision"] = 8.into();
                });
            }),
            ("the container is restarted under a new ID", |wake| {
                wake.pods[0]["status"]["containerStatuses"][0]["containerID"] =
                    format!("containerd://{}", "b".repeat(64)).into();
            }),
            ("the endpoint names another Pod", |wake| {
                wake.slices[0]["endpoints"][0]["targetRef"]["uid"] = wake_id(4).into();
            }),
            ("the CA is replaced", |wake| {
                wake.maps[2]["metadata"]["annotations"]["pgcf.io/source-ca-secret-resource-version"] =
                    "82".into();
                wake.maps[2]["data"]["ca.crt"] = "refreshed public certificate material".into();
            }),
            ("the Pod is deleted", |wake| {
                wake.pods[0]["metadata"]["deletionTimestamp"] = "2026-10-15T10:00:00Z".into();
            }),
        ];
        for (reason, withdraw) in withdrawals {
            let mut wake = Wake::armed();
            let target = wake.route().unwrap();
            assert!(
                wake.state.permits(WAKE, &target, control::now()),
                "{reason}"
            );
            withdraw(&mut wake);
            wake.apply();
            assert!(
                !wake.state.permits(WAKE, &target, control::now()),
                "{reason}"
            );
        }
    }
    /// The controller's attestation of the wake fixture's Pod, as the fence carries it.
    fn wake_target() -> AdmissionTarget {
        serde_json::from_value(json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":wake_id(3),"container_id":"a".repeat(64),"ca_secret_uid":wake_id(21),"ca_secret_resource_version":"81","ca_sha256":sha256_hex(WAKE_CA),"tls_server_name":format!("database-rw.pgcf-db-{WAKE}.svc")})).unwrap()
    }
    #[test]
    fn the_attestation_stands_in_until_ready_is_seen_or_the_bound_since_its_first_use() {
        let start = Instant::now();
        let mut seen = Witness::of(&wake_target());
        assert!(seen.is(&wake_target()));
        let mut next = wake_target();
        next.generation = 8;
        assert!(!seen.is(&next));
        // Nothing counts before an identity rested on it.
        assert!(seen.open(start + Duration::from_secs(3600)));
        seen.relied_since = Some(start);
        assert!(seen.open(start + ATTESTED_ROUTE_BOUND - Duration::from_millis(1)));
        assert!(!seen.open(start + ATTESTED_ROUTE_BOUND));
        // The kubelet's report spends it at once, whatever the time.
        seen.relied_since = None;
        seen.ready_seen = true;
        assert!(!seen.open(start));
    }
    #[test]
    fn an_attestation_the_kubelet_never_confirms_stops_routing_after_the_bound() {
        let mut wake = Wake::armed();
        let target = wake.route().unwrap();
        assert!(target.unready);
        assert!(wake.state.permits(WAKE, &target, control::now()));
        // This gateway has relied on the attestation for as long as a connection has to start,
        // and no event of the cluster marks that moment.
        wake.state.witnesses.get_mut(WAKE).unwrap().relied_since =
            Instant::now().checked_sub(ATTESTED_ROUTE_BOUND + Duration::from_millis(1));
        assert!(wake.state.witnesses[WAKE].relied_since.is_some());
        assert!(wake.route().is_err());
        assert!(!wake.state.permits(WAKE, &target, control::now()));
        // A list, an event of the Pod or a flap of the report does not count it again.
        wake.apply();
        assert!(wake.route().is_err());
        let pod = wake.pods[0].clone();
        wake.state
            .event("pods", &json!({"type":"MODIFIED","object":pod}), None)
            .unwrap();
        assert!(wake.route().is_err());
        // The kubelet's report routes the Pod as any Ready endpoint, whatever the attestation.
        wake.kubelet(true);
        wake.apply();
        let ready = wake.route().unwrap();
        assert!(!ready.unready);
        assert!(wake.state.permits(WAKE, &ready, control::now()));
        // ... and it is not an unready writer again for the attestation it was spent on.
        wake.kubelet(false);
        wake.apply();
        assert!(wake.route().is_err());
    }
    #[test]
    fn the_next_attestation_of_the_same_pod_starts_its_own_bound() {
        let mut wake = Wake::armed();
        wake.state.witnesses.get_mut(WAKE).unwrap().relied_since =
            Instant::now().checked_sub(ATTESTED_ROUTE_BOUND + Duration::from_millis(1));
        wake.apply();
        assert!(wake.route().is_err());
        wake.edit("intent.json", |intent| intent["revision"] = 8.into());
        wake.edit("admission_target", |target| target["generation"] = 8.into());
        wake.apply();
        let target = wake.route().unwrap();
        assert!(target.unready);
        assert!(wake.state.permits(WAKE, &target, control::now()));
    }
    // A database woken into a pool slot: its fence attests the slot's Pod, which runs in the
    // slot's own namespace and not in `pgcf-db-<id>`.
    const SLOT: &str = "pgcf-slot-0a1b2c3d";
    /// The wake fixture as the pool leaves it: a thin database whose running fence attests the
    /// `postgres` container of the slot Pod `wake_id(40)`, not yet reported Ready.
    fn slot_wake() -> Wake {
        let mut wake = Wake::new();
        let profile = json!({"backend":"lvm-thin-v1","storage_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16)),"profile_sha256":"a".repeat(64),"node_uid":wake_id(50),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg"});
        wake.maps[0]["data"]["state"] = json!({"node":"customer-us1","storage":profile})
            .to_string()
            .into();
        wake.edit("admission_target", |target| {
            target["pod_uid"] = wake_id(40).into();
            target["tls_server_name"] = pgcf_native_protocol::wake::slot_tls_name(SLOT).into();
        });
        wake.slices[0]["metadata"]["namespace"] = SLOT.into();
        wake.slices[0]["endpoints"][0]["targetRef"]["namespace"] = SLOT.into();
        wake.slices[0]["endpoints"][0]["targetRef"]["uid"] = wake_id(40).into();
        wake.pods[0]["metadata"]["namespace"] = SLOT.into();
        wake.pods[0]["metadata"]["uid"] = wake_id(40).into();
        wake
    }
    /// A free slot: its Pod runs with PostgreSQL fenced, and no fence names it.
    fn free_slot(namespace: &str, uid: u32) -> (Value, Value) {
        let mut slice = slice(&wake_id(uid), "10.0.0.9");
        slice["metadata"]["namespace"] = namespace.into();
        slice["metadata"]["uid"] = wake_id(uid + 1).into();
        slice["metadata"]["resourceVersion"] = "1".into();
        slice["endpoints"][0]["targetRef"]["namespace"] = namespace.into();
        slice["endpoints"][0]["conditions"] =
            json!({"ready":false,"serving":false,"terminating":false});
        let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":namespace,"uid":wake_id(uid),"resourceVersion":"1","labels":{"cnpg.io/cluster":"database","pgcf.io/slot":"0a1b2c3d"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.9","containerStatuses":[{"name":"postgres","ready":false,"containerID":format!("containerd://{}","d".repeat(64)),"state":{"running":{"startedAt":"2026-10-16T10:00:00Z"}}}]}});
        (slice, pod)
    }
    #[test]
    fn slot_pods_and_slices_never_break_discovery_and_free_slots_map_to_no_database() {
        let (slice, pod) = free_slot(SLOT, 60);
        // Beside a database routed on its own Pod, a free slot changes nothing.
        let mut wake = Wake::armed();
        let before = wake.route().unwrap();
        wake.slices.push(slice.clone());
        wake.pods.push(pod.clone());
        wake.apply();
        assert_eq!(wake.route().unwrap(), before);
        assert!(wake.state.slot_databases(SLOT).is_empty());
        for (kind, object) in [("pods", &pod), ("endpointslices", &slice)] {
            for change in ["MODIFIED", "DELETED", "ADDED"] {
                wake.state
                    .event(kind, &json!({"type":change,"object":object}), None)
                    .unwrap();
            }
        }
        assert_eq!(wake.route().unwrap(), before);
        // Only a slot namespace is discovery besides the databases' own.
        for namespace in ["pgcf-slot-0A1B2C3D", "pgcf-slot-0a1b2c3", "kube-system"] {
            let (slice, pod) = free_slot(namespace, 70);
            let mut state = Targets::default();
            assert!(state.replace("pods", &[pod], None).is_err(), "{namespace}");
            assert!(
                state.replace("endpointslices", &[slice], None).is_err(),
                "{namespace}"
            );
        }
    }
    #[test]
    fn a_slot_target_is_routed_by_its_attestation_without_a_storage_gate() {
        let mut wake = slot_wake();
        wake.apply();
        // A thin database with no signed authority at all: the slot is routed on the
        // controller's attestation alone.
        let target = wake.route().unwrap();
        assert_eq!(target.pod_uid, wake_id(40));
        assert_eq!(target.address.to_string(), "10.0.0.7");
        assert_eq!(target.container_id, Some("a".repeat(64)));
        assert!(target.storage.is_none());
        assert!(target.unready);
        assert_eq!(wake.state.slot_databases(SLOT), vec![WAKE.to_string()]);
        assert!(wake.state.permits(WAKE, &target, control::now()));
        // An event of the slot Pod is an event of the database it serves.
        let mut restarted = wake.pods[0].clone();
        restarted["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "b".repeat(64)).into();
        restarted["metadata"]["resourceVersion"] = "2".into();
        wake.state
            .event("pods", &json!({"type":"MODIFIED","object":restarted}), None)
            .unwrap();
        assert!(wake.route().is_err());
        assert!(!wake.state.permits(WAKE, &target, control::now()));
    }
    #[test]
    fn a_slot_target_requires_the_attested_running_postgres_container_on_its_node() {
        type Change = (&'static str, fn(&mut Wake));
        let changes: [Change; 6] = [
            ("another container", |wake| {
                wake.pods[0]["status"]["containerStatuses"][0]["containerID"] =
                    format!("containerd://{}", "b".repeat(64)).into();
            }),
            ("a stopped container", |wake| {
                wake.pods[0]["status"]["containerStatuses"][0]["state"] =
                    json!({"terminated":{"exitCode":0}});
            }),
            ("a Pod on another node", |wake| {
                wake.pods[0]["spec"]["nodeName"] = "customer-us2".into();
            }),
            ("an endpoint on another node than the database's", |wake| {
                wake.slices[0]["endpoints"][0]["nodeName"] = "customer-us2".into();
                wake.pods[0]["spec"]["nodeName"] = "customer-us2".into();
            }),
            ("a deleting Pod", |wake| {
                wake.pods[0]["metadata"]["deletionTimestamp"] = "2026-10-16T10:00:00Z".into();
            }),
            ("another slot's Pod", |wake| {
                wake.slices[0]["endpoints"][0]["targetRef"]["uid"] = wake_id(41).into();
                wake.pods[0]["metadata"]["uid"] = wake_id(41).into();
            }),
        ];
        for (reason, change) in changes {
            let mut wake = slot_wake();
            wake.apply();
            let target = wake.route().expect(reason);
            change(&mut wake);
            wake.apply();
            assert!(wake.route().is_err(), "{reason}");
            assert!(
                !wake.state.permits(WAKE, &target, control::now()),
                "{reason}"
            );
        }
    }
}
