// SPDX-License-Identifier: Apache-2.0
//! Authenticated discovery and physical write authority, outside connection hot paths.
use crate::{
    control,
    kubernetes::{AdmissionTarget, Intent, Kubernetes, admission_target},
    storage::{StorageBinding, StorageGate, StorageTrust},
};
use futures_util::StreamExt;
use pgcf_native_protocol::{valid_pattern, valid_schema, wire};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    net::IpAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{RwLock, watch};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TargetIdentity {
    pub address: IpAddr,
    pub pod_uid: String,
    pub node: String,
    pub storage: Option<StorageBinding>,
    pub container_id: Option<String>,
    pub ca: Option<CaIdentity>,
    pub pool: Option<PoolIdentity>,
    /// The writer is the controller's attested Pod before the kubelet reports it Ready. It is
    /// evidence of how the writer was chosen, never part of its identity: a session started on
    /// it continues when the kubelet's report arrives.
    pub unready: bool,
}
/// The immutable Cloudflare holder scope. Current CA and route revision live in the admission
/// target, so a same-holder certificate refresh never rewrites the binding's original scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolIdentity {
    pub binding_id: String,
    pub node_uid: String,
    pub boot_id: String,
    pub scope_sha256: String,
    pub storage_generation: u64,
    pub generation: u64,
    pub admission_epoch: u64,
    pub route_revision: u64,
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
#[derive(Default)]
pub struct Targets {
    pool_enabled: bool,
    legacy: HashMap<String, LegacyStorageBinding>,
    identities: HashMap<String, TargetIdentity>,
    slices: HashMap<String, Value>,
    pods: HashMap<String, Value>,
    pool_pods: HashMap<String, Value>,
    pool_nodes: HashMap<String, Value>,
    pool_history: HashMap<String, Value>,
    maps: HashMap<String, Value>,
    gates: HashMap<String, StorageGate>,
    // The existing gate clears its current claims when verification fails. Retain only the
    // finite reason from that same evaluation, never an additional authorization decision.
    authority_refusals: HashMap<String, TargetUnavailable>,
    slices_observed: Option<Instant>,
    pods_observed: Option<Instant>,
    pool_pods_observed: Option<Instant>,
    pool_nodes_observed: Option<Instant>,
    maps_observed: Option<Instant>,
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
fn owned_slice(v: &Value) -> Result<String, &'static str> {
    if !crate::kubernetes::typed(v, "discovery.k8s.io/v1", "EndpointSlice")
        || v["metadata"]["labels"]["kubernetes.io/service-name"] != "database-rw"
    {
        return Err("invalid writer discovery");
    }
    let namespace = text(&v["metadata"], "namespace")?;
    if !namespace
        .strip_prefix("pgcf-db-")
        .is_some_and(|v| valid_pattern("database", v))
    {
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
    let namespace = text(&v["metadata"], "namespace")?;
    if !namespace
        .strip_prefix("pgcf-db-")
        .is_some_and(|v| valid_pattern("database", v))
    {
        return Err("invalid runtime Pod namespace");
    }
    uuid(&v["metadata"], "uid")
}
fn owned_pool_pod(v: &Value) -> Result<String, &'static str> {
    if !crate::kubernetes::typed(v, "v1", "Pod")
        || v["metadata"]["namespace"]
            != pgcf_native_protocol::pool::constant("namespace")
                .as_str()
                .ok_or("pool namespace unavailable")?
        || v["metadata"]["labels"]["app.kubernetes.io/name"] != "pgcf-pool"
    {
        return Err("invalid pool Pod discovery");
    }
    uuid(&v["metadata"], "uid")
}
fn owned_pool_node(v: &Value) -> Result<String, &'static str> {
    if !crate::kubernetes::typed(v, "v1", "Node") {
        return Err("invalid pool Node discovery");
    }
    uuid(&v["metadata"], "uid")?;
    Ok(text(&v["metadata"], "name")?.into())
}
impl Targets {
    pub fn enable_pool(&mut self, enabled: bool) {
        self.pool_enabled = enabled;
    }
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
        if !self
            .pods_observed
            .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
        {
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
    /// The controller's target for the running revision of this database's fence. A fence that
    /// is quiesced, retired, deleting or ahead of its target attests nothing.
    fn attested(&self, database: &str) -> Option<AdmissionTarget> {
        let fence = self.maps.get(&format!("gateway-fence-{database}"))?;
        if !fence["metadata"]["deletionTimestamp"].is_null() {
            return None;
        }
        let intent = json(&fence["data"], "intent.json").ok()?;
        if !valid_schema("intent", &intent) {
            return None;
        }
        let intent: Intent = serde_json::from_value(intent).ok()?;
        if intent.database != database || intent.mode != "running" {
            return None;
        }
        let target = admission_target(&fence["data"], &intent).ok()??;
        (target.generation == intent.revision).then_some(target)
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
            } else if kind == "poolpods" {
                Some(owned_pool_pod(item)?)
            } else if kind == "poolnodes" {
                Some(owned_pool_node(item)?)
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
        } else if kind == "poolpods" {
            self.pool_pods = next;
            self.pool_pods_observed = Some(Instant::now());
        } else if kind == "poolnodes" {
            self.pool_nodes = next;
            self.pool_nodes_observed = Some(Instant::now());
        } else {
            self.maps = next;
            self.maps_observed = Some(Instant::now());
        }
        self.refresh_gates(trust);
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
        } else if kind == "poolpods" {
            Some(owned_pool_pod(object)?)
        } else if kind == "poolnodes" {
            Some(owned_pool_node(object)?)
        } else {
            owned_map(object)?
        };
        if let Some(key) = key {
            let records = if kind == "endpointslices" {
                &mut self.slices
            } else if kind == "pods" {
                &mut self.pods
            } else if kind == "poolpods" {
                &mut self.pool_pods
            } else if kind == "poolnodes" {
                &mut self.pool_nodes
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
        if matches!(kind, "poolpods" | "poolnodes") {
            self.refresh_gates(trust);
            return Ok(());
        }
        let database = if kind == "endpointslices" || kind == "pods" {
            text(&object["metadata"], "namespace")?
                .strip_prefix("pgcf-db-")
                .ok_or("invalid writer namespace")?
        } else {
            text(&object["metadata"]["labels"], "pgcf.io/database-id")?
        };
        self.refresh_gate(database, trust);
        Ok(())
    }
    fn touch(&mut self, kind: &str) {
        if kind == "endpointslices" {
            self.slices_observed = Some(Instant::now());
        } else if kind == "pods" {
            self.pods_observed = Some(Instant::now());
        } else if kind == "poolpods" {
            self.pool_pods_observed = Some(Instant::now());
        } else if kind == "poolnodes" {
            self.pool_nodes_observed = Some(Instant::now());
        } else {
            self.maps_observed = Some(Instant::now());
        }
    }
    pub fn disconnect(&mut self, kind: &str) {
        if matches!(kind, "poolpods" | "poolnodes") {
            if kind == "poolpods" {
                self.pool_pods_observed = None;
            } else {
                self.pool_nodes_observed = None;
            }
            self.identities.retain(|_, target| target.pool.is_none());
            return;
        }
        if kind == "pods" {
            self.pods_observed = None;
            for target in self.identities.values_mut() {
                target.container_id = None;
            }
            return;
        }
        if kind == "endpointslices" {
            self.slices_observed = None;
        } else {
            self.maps_observed = None;
        }
        for gate in self.gates.values_mut() {
            gate.disconnect();
        }
    }
    /// The writer's address, Pod UID and node, and whether its endpoint is Ready. A Pod the
    /// kubelet has not reported Ready is the writer only when it is the one the controller
    /// attested, nothing else is a candidate, and it runs the attested container.
    fn endpoint(&self, database: &str) -> Result<(IpAddr, String, String, bool), &'static str> {
        // A pool holder is distinct from CNPG. Disabled, malformed or non-serving pool authority
        // never admits the CNPG Pod that may still have a stale Ready EndpointSlice.
        if self
            .maps
            .get(&format!("gateway-fence-{database}"))
            .is_some_and(|fence| {
                fence["data"]
                    .as_object()
                    .is_some_and(|data| data.contains_key("pool-binding.json"))
            })
        {
            return Err("pool target unavailable");
        }
        if self
            .pool_history
            .get(database)
            .is_some_and(|prior| !matches!(prior["state"].as_str(), Some("released" | "refused")))
        {
            return Err("pool holder disappeared");
        }
        let namespace = format!("pgcf-db-{database}");
        let attested = self.attested(database);
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
                    && !attested.as_ref().is_some_and(|target| {
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
                    if self.runs_attested(database, &attested, &uid, address, &node) =>
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
    fn pool_record(&self, database: &str) -> Result<Option<Value>, &'static str> {
        let Some(fence) = self.maps.get(&format!("gateway-fence-{database}")) else {
            return Ok(None);
        };
        if !fence["data"]
            .as_object()
            .is_some_and(|data| data.contains_key("pool-binding.json"))
        {
            return Ok(None);
        }
        let record = json(&fence["data"], "pool-binding.json")?;
        if !pgcf_native_protocol::pool::binding_valid(&record)
            || record["scope"]["database_id"] != database
        {
            return Err("pool binding invalid");
        }
        Ok(Some(record))
    }
    fn remember_pool(&mut self, database: &str, record: &Value) -> Result<(), &'static str> {
        if let Some(prior) = self.pool_history.get(database) {
            if prior["scope"]["binding_id"] == record["scope"]["binding_id"] {
                if prior["scope"] != record["scope"]
                    || prior["scope_sha256"] != record["scope_sha256"]
                    || safe_integer(&record["holder_revision"])?
                        < safe_integer(&prior["holder_revision"])?
                    || record["updated_at"].as_u64() < prior["updated_at"].as_u64()
                    || (prior["state"] != record["state"]
                        && !match prior["state"].as_str() {
                            Some("claimed") => matches!(
                                record["state"].as_str(),
                                Some(
                                    "mounted"
                                        | "serving"
                                        | "detaching"
                                        | "failed"
                                        | "lost"
                                        | "refused"
                                )
                            ),
                            Some("mounted") => matches!(
                                record["state"].as_str(),
                                Some("serving" | "detaching" | "failed" | "lost" | "released")
                            ),
                            Some("serving") => matches!(
                                record["state"].as_str(),
                                Some("detaching" | "failed" | "lost")
                            ),
                            Some("detaching") => matches!(
                                record["state"].as_str(),
                                Some("failed" | "lost" | "released" | "refused")
                            ),
                            Some("failed" | "lost") => matches!(
                                record["state"].as_str(),
                                Some("failed" | "lost" | "released" | "refused")
                            ),
                            _ => false,
                        })
                {
                    return Err("pool holder history changed");
                }
            } else if !matches!(prior["state"].as_str(), Some("released" | "refused"))
                || safe_integer(&record["scope"]["route_revision"])?
                    <= safe_integer(&prior["scope"]["route_revision"])?
            {
                return Err("pool holder replaced before release");
            }
        } else if self.pool_history.len() >= 4000 {
            return Err("pool holder capacity exceeded");
        }
        self.pool_history.insert(database.into(), record.clone());
        Ok(())
    }
    fn pool_identity(
        &self,
        database: &str,
        record: &Value,
    ) -> Result<TargetIdentity, &'static str> {
        if !self.pool_enabled
            || !matches!(record["state"].as_str(), Some("serving" | "detaching"))
            || !self
                .pool_pods_observed
                .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
            || !self
                .pool_nodes_observed
                .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
        {
            return Err("pool writer unavailable");
        }
        let scope = &record["scope"];
        let fence = self
            .maps
            .get(&format!("gateway-fence-{database}"))
            .ok_or("pool power identity unavailable")?;
        let storage = self
            .maps
            .get(&format!("storage-{database}"))
            .ok_or("pool storage identity unavailable")?;
        if !fence["metadata"]["deletionTimestamp"].is_null()
            || !storage["metadata"]["deletionTimestamp"].is_null()
        {
            return Err("pool storage retiring");
        }
        let intent = json(&fence["data"], "intent.json")?;
        let generation = safe_integer(&scope["generation"])?;
        let intent_generation = safe_integer(&intent["revision"])?;
        if intent["database"] != database
            || !matches!(intent["mode"].as_str(), Some("running" | "quiesce"))
            || (record["state"] == "serving" && intent_generation != generation)
            || (record["state"] == "detaching" && intent_generation < generation)
        {
            return Err("pool power scope changed");
        }
        let state = json(&storage["data"], "state")?;
        let volume = json(
            &storage["metadata"]["annotations"],
            "pgcf.io/volume-identity",
        )?;
        let power = json(&fence["data"], "power.json")?;
        let anchor = &power["anchor"];
        let physical = &scope["storage"];
        if storage["metadata"]["uid"] != physical["storage_uid"]
            || anchor["storageUid"] != physical["storage_uid"]
            || anchor["storage"] != state["storage"]
            || safe_integer(&anchor["physicalGeneration"])?
                != safe_integer(&physical["storage_generation"])?
            || json(anchor, "storageState")? != state
            || json(anchor, "volumeIdentity")? != volume
            || state["namespaceUid"] != physical["namespace_uid"]
            || state["clusterUid"] != physical["cnpg_cluster_uid"]
            || volume["handle"] != physical["volume_handle"]
            || volume["claimUid"] != physical["pvc_uid"]
            || volume["volumeUid"] != physical["pv_uid"]
            || volume["lvUuid"] != physical["lv_uuid"]
        {
            return Err("pool retained storage changed");
        }
        match physical["backend"].as_str() {
            Some("lvm-thick-v1") if state["storage"].is_null() => {}
            Some("lvm-thin-v1")
                if state["storage"] == physical["profile"]
                    && physical["profile"]["node_uid"] == scope["node_uid"]
                    && physical["profile"]["volume_group_uuid"]
                        == physical["volume_group_uuid"] => {}
            _ => return Err("pool storage profile changed"),
        }
        let pod_uid = text(scope, "pool_pod_uid")?;
        let pod = self.pool_pods.get(pod_uid).ok_or("pool Pod unavailable")?;
        let address: IpAddr = text(scope, "pool_pod_ip")?
            .parse()
            .map_err(|_| "pool address invalid")?;
        if !match address {
            IpAddr::V4(ip) => ip.is_private(),
            IpAddr::V6(ip) => ip.is_unique_local(),
        } {
            return Err("pool address invalid");
        }
        if !pod["metadata"]["deletionTimestamp"].is_null()
            || pod["metadata"]["name"] != scope["pool_pod_name"]
            || pod["spec"]["nodeName"] != state["node"]
            || pod["status"]["podIP"]
                .as_str()
                .and_then(|value| value.parse::<IpAddr>().ok())
                != Some(address)
        {
            return Err("pool Pod scope changed");
        }
        let node = text(&state, "node")?.to_string();
        let host = self.pool_nodes.get(&node).ok_or("pool Node unavailable")?;
        if host["metadata"]["uid"] != scope["node_uid"]
            || host["status"]["nodeInfo"]["bootID"] != scope["boot_id"]
            || !host["metadata"]["deletionTimestamp"].is_null()
            || !host["status"]["conditions"]
                .as_array()
                .is_some_and(|items| {
                    items.iter().filter(|item| item["type"] == "Ready").count() == 1
                        && items
                            .iter()
                            .any(|item| item["type"] == "Ready" && item["status"] == "True")
                })
        {
            return Err("pool Node identity changed");
        }
        let statuses = pod["status"]["containerStatuses"]
            .as_array()
            .ok_or("pool runtime unavailable")?;
        let mut actual_ids = statuses
            .iter()
            .map(|container| {
                if container["state"]["running"].is_null() {
                    return Err("pool container stopped");
                }
                text(container, "containerID")?
                    .strip_prefix("containerd://")
                    .map(str::to_string)
                    .ok_or("pool container identity invalid")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut scoped_ids = scope["container_ids"]
            .as_array()
            .ok_or("pool container scope unavailable")?
            .iter()
            .map(|id| {
                id.as_str()
                    .map(str::to_string)
                    .ok_or("pool container scope invalid")
            })
            .collect::<Result<Vec<_>, _>>()?;
        actual_ids.sort();
        scoped_ids.sort();
        if actual_ids != scoped_ids || pod["metadata"]["namespace"] != scope["pool_namespace"] {
            return Err("pool container or namespace scope changed");
        }
        let postgres = statuses
            .iter()
            .filter(|item| item["name"] == "postgres")
            .collect::<Vec<_>>();
        if postgres.len() != 1
            || postgres[0]["ready"] != true
            || postgres[0]["state"]["running"].is_null()
            || postgres[0]["containerID"]
                .as_str()
                .and_then(|value| value.strip_prefix("containerd://"))
                != scope["container_id"].as_str()
            || !postgres[0]["imageID"].as_str().is_some_and(|image| {
                image.ends_with(&format!(
                    "@sha256:{}",
                    text(&scope["class"], "postgres_image_sha256").unwrap_or("")
                ))
            })
        {
            return Err("pool runtime changed");
        }
        let ca = self
            .current_ca(database)
            .ok_or("pool TLS authority unavailable")?;
        let physical_authority = if physical["backend"] == "lvm-thin-v1" {
            let mut binding = self
                .binding(database, pod_uid, &node)?
                .ok_or("pool thin authority identity unavailable")?;
            // The old writer drains only under its immutable CF-issued generation, even while a
            // future mutation is pending. A current/new generation sa1 cannot cover this holder.
            binding.generation = generation;
            Some(binding)
        } else {
            None
        };
        Ok(TargetIdentity {
            address,
            pod_uid: pod_uid.into(),
            node,
            storage: physical_authority,
            container_id: Some(text(scope, "container_id")?.into()),
            ca: Some(ca),
            pool: Some(PoolIdentity {
                binding_id: text(scope, "binding_id")?.into(),
                node_uid: text(scope, "node_uid")?.into(),
                boot_id: text(scope, "boot_id")?.into(),
                scope_sha256: text(record, "scope_sha256")?.into(),
                storage_generation: safe_integer(&physical["storage_generation"])?,
                generation,
                admission_epoch: safe_integer(&scope["admission_epoch"])?,
                route_revision: safe_integer(&scope["route_revision"])?,
            }),
            unready: false,
        })
    }
    fn binding(
        &self,
        database: &str,
        pod_uid: &str,
        node: &str,
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
        for database in names {
            self.refresh_gate(&database, trust);
        }
    }
    fn refresh_gate(&mut self, database: &str, trust: Option<&StorageTrust>) {
        let now = control::now();
        let record = self.pool_record(database).and_then(|record| {
            if let Some(record) = &record {
                self.remember_pool(database, record)?;
            }
            Ok(record)
        });
        let identity = match record {
            Ok(Some(record)) => self.pool_identity(database, &record),
            Err(error) => Err(error),
            Ok(None) => self
                .endpoint(database)
                .and_then(|(address, pod_uid, node, ready)| {
                    let attested = self
                        .attested(database)
                        .filter(|target| target.pod_uid == pod_uid);
                    Ok(TargetIdentity {
                        address,
                        container_id: self.runtime_container(
                            &pod_uid,
                            address,
                            &node,
                            attested.as_ref().map(|target| target.container_id.as_str()),
                        ),
                        ca: self.current_ca(database),
                        storage: self.binding(database, &pod_uid, &node)?,
                        pod_uid,
                        node,
                        pool: None,
                        unready: !ready,
                    })
                }),
        };
        if !self.maps.contains_key(&format!("storage-{database}"))
            && !self.maps.contains_key(&format!("gateway-fence-{database}"))
        {
            self.identities.remove(database);
            self.gates.remove(database);
            self.authority_refusals.remove(database);
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
        if !valid_pattern("database", database)
            || !self
                .maps_observed
                .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
        {
            return Err(TargetUnavailable::DiscoveryUnavailable);
        }
        let target = self
            .identities
            .get(database)
            .ok_or(TargetUnavailable::WriterIdentityUnavailable)?;
        if target.pool.is_some() {
            if !self.pool_enabled
                || ![self.pool_pods_observed, self.pool_nodes_observed]
                    .iter()
                    .all(|at| at.is_some_and(|at| at.elapsed() < Duration::from_secs(70)))
            {
                return Err(TargetUnavailable::DiscoveryUnavailable);
            }
        } else if !self.synchronized() {
            return Err(TargetUnavailable::DiscoveryUnavailable);
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
        if target.pool.is_some() {
            let record = self
                .pool_record(database)
                .map_err(|_| TargetUnavailable::WriterIdentityUnavailable)?
                .ok_or(TargetUnavailable::WriterIdentityUnavailable)?;
            let fence = self
                .maps
                .get(&format!("gateway-fence-{database}"))
                .ok_or(TargetUnavailable::WriterIdentityUnavailable)?;
            if record["state"] != "serving"
                || json(&fence["data"], "intent.json")
                    .map_err(|_| TargetUnavailable::WriterIdentityUnavailable)?["mode"]
                    != "running"
            {
                return Err(TargetUnavailable::WriterIdentityUnavailable);
            }
            let pod = self
                .pool_pods
                .get(&target.pod_uid)
                .ok_or(TargetUnavailable::WriterIdentityUnavailable)?;
            if !pod["status"]["conditions"].as_array().is_some_and(|items| {
                items.iter().filter(|item| item["type"] == "Ready").count() == 1
                    && items
                        .iter()
                        .any(|item| item["type"] == "Ready" && item["status"] == "True")
            }) {
                return Err(TargetUnavailable::WriterIdentityUnavailable);
            }
            return Ok(target);
        }
        if !self
            .pods_observed
            .is_some_and(|at| at.elapsed() < Duration::from_secs(70))
        {
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
                && (current.container_id != target.container_id
                    || (current.pool.is_none()
                        && !self
                            .pods_observed
                            .is_some_and(|at| at.elapsed() < Duration::from_secs(70)))))
            || (target.pool.is_none() && target.ca.is_some() && current.ca != target.ca)
            || current.pool != target.pool
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
    /// Closing idle sessions under a running intent is restricted to the exact detaching
    /// thin holder. This uses the same physical/watch/SA1 decision as existing sessions.
    pub fn running_pool_close_permitted(
        &self,
        database: &str,
        operation: &str,
        revision: u64,
        now: u64,
    ) -> bool {
        let Ok(target) = self.current_target(database, now) else {
            return false;
        };
        let Some(identity) = target.pool.as_ref() else {
            return false;
        };
        let Ok(Some(record)) = self.pool_record(database) else {
            return false;
        };
        let Some(fence) = self.maps.get(&format!("gateway-fence-{database}")) else {
            return false;
        };
        let Ok(intent) = json(&fence["data"], "intent.json") else {
            return false;
        };
        target.storage.is_some()
            && record["state"] == "detaching"
            && identity.generation == revision
            && record["scope"]["generation"].as_u64() == Some(revision)
            && record["scope"]["binding_id"] == identity.binding_id
            && record["scope_sha256"] == identity.scope_sha256
            && intent["database"] == database
            && intent["operation"] == operation
            && intent["revision"].as_u64() == Some(revision)
            && intent["mode"] == "running"
    }
}

fn discovery(kind: &str) -> (String, &'static str) {
    match kind {
        "endpointslices" => (
            "/apis/discovery.k8s.io/v1/endpointslices".into(),
            "kubernetes.io/service-name=database-rw",
        ),
        "pods" => ("/api/v1/pods".into(), "cnpg.io/cluster=database"),
        "poolpods" => (
            format!(
                "/api/v1/namespaces/{}/pods",
                pgcf_native_protocol::pool::constant("namespace")
                    .as_str()
                    .unwrap()
            ),
            "app.kubernetes.io/name=pgcf-pool",
        ),
        "poolnodes" => ("/api/v1/nodes".into(), ""),
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
            } else if matches!(kind, "pods" | "poolpods") {
                "PodList"
            } else if kind == "poolnodes" {
                "NodeList"
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
                .endpoint("aaaaaaaaaaaaaaaaaaaa")
                .unwrap()
                .0
                .to_string(),
            "10.0.0.7"
        );
        object["endpoints"][0]["conditions"]["ready"] = false.into();
        state
            .replace("endpointslices", &[object.clone()], None)
            .unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa").is_err());
        object["endpoints"][0]["conditions"]["ready"] = true.into();
        let mut replacement = slice("33333333-3333-4333-8333-333333333333", "10.0.0.8");
        replacement["metadata"]["uid"] = "44444444-4444-4444-8444-444444444444".into();
        state
            .replace("endpointslices", &[object, replacement], None)
            .unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa").is_err());
    }
    #[test]
    fn endpoint_identity_cannot_be_inferred_from_a_certificate_or_claim() {
        let mut state = Targets::default();
        let mut object = slice("22222222-2222-4222-8222-222222222222", "10.0.0.7");
        object["endpoints"][0]["targetRef"]["uid"] = Value::Null;
        state.replace("endpointslices", &[object], None).unwrap();
        assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa").is_err());
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
            assert!(state.endpoint("aaaaaaaaaaaaaaaaaaaa").is_err());
        }
    }
    #[test]
    fn immutable_legacy_configuration_rejects_unknown_or_duplicate_identities() {
        assert!(Targets::with_legacy("{}").is_err());
        assert!(Targets::with_legacy("[{\"database_id\":\"invalid\"}]").is_err());
        assert!(Targets::with_legacy("[]").unwrap().legacy.is_empty());
    }
    #[test]
    fn a_pool_record_never_falls_back_to_a_ready_cnpg_endpoint() {
        let database = "aaaaaaaaaaaaaaaaaaaa";
        let id = |number: u32| format!("00000000-0000-4000-8000-{number:012x}");
        let volume = json!({"handle":format!("pvc-{}",id(5)),"claimUid":id(5),"volumeUid":id(6)});
        let storage = json!({"node":"customer-us1","namespaceUid":id(7),"clusterUid":id(8)});
        let cohort = json!([{"database_id":database,"storage_uid":id(2),"namespace_uid":id(7),"cluster_uid":id(8),"physical_generation":1,"volume_identity":volume}]);
        let labels = json!({"pgcf.io/database-id":database});
        let mut maps = vec![
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{database}"),"namespace":"pgcf-system","uid":id(2),"labels":labels,"annotations":{"pgcf.io/volume-identity":volume.to_string()}},"data":{"state":storage.to_string()}}),
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{database}"),"namespace":"pgcf-system","uid":id(100),"labels":labels},"data":{"power.json":json!({"anchor":{"storageUid":id(2),"storageState":storage.to_string(),"volumeIdentity":volume.to_string(),"physicalGeneration":1}}).to_string()}}),
        ];
        let mut state = Targets::with_legacy(&cohort.to_string()).unwrap();
        state
            .replace("endpointslices", &[slice(&id(3), "10.0.0.7")], None)
            .unwrap();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(state.target(database, control::now()).is_ok());
        // Presence is authority intent even when disabled, malformed or not serving. It is never a hit
        // on the old CNPG Pod, and must not be bypassed by that Pod's remaining EndpointSlice.
        maps[1]["data"]["pool-binding.json"] = json!({"state":"claimed"}).to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(state.target(database, control::now()).is_err());
    }
    fn pool_fixture() -> (Targets, Vec<Value>, Value, Value, Value) {
        let database = "a".repeat(20);
        let id = |number: u32| format!("00000000-0000-4000-8000-{number:012x}");
        let physical = json!({"backend":"lvm-thick-v1","storage_generation":1,"storage_uid":id(2),"namespace_uid":id(7),"cnpg_cluster_uid":id(8),"pvc_uid":id(5),"pv_uid":id(6),"volume_handle":format!("pvc-{}",id(5)),"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","lv_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg"});
        let class = json!({"postgres_image_sha256":"a".repeat(64),"cpu_request_millicores":250,"cpu_limit_millicores":500,"memory_request_bytes":268435456,"memory_limit_bytes":536870912,"configuration_profile_sha256":"b".repeat(64)});
        let scope = json!({"v":1,"binding_id":id(10),"database_id":database,"generation":7,"route_revision":19,"admission_epoch":11,"configuration_fingerprint":"c".repeat(64),"region_id":"eu-test","node_id":format!("nod_{}","a".repeat(20)),"node_uid":id(11),"boot_id":id(12),"pool_namespace":"pgcf-pool","pool_namespace_uid":id(22),"container_ids":["d".repeat(64)],"pool_pod_uid":id(13),"pool_pod_name":"pgcf-pool-test","pool_pod_ip":"10.0.0.9","container_id":"d".repeat(64),"supervisor_key_sha256":"e".repeat(64),"supervisor_sha256":"f".repeat(64),"driver_image":format!("registry.test/driver@sha256:{}","1".repeat(64)),"driver_sha256":"2".repeat(64),"host_controller_sha256":"3".repeat(64),"class":class,"storage":physical,"system_identifier":"7000000000000000000","timeline":1,"bundle_nonce":id(14)});
        let scope_hash = Sha256::digest(serde_json::to_vec(&scope).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let record = json!({"v":1,"scope":scope,"scope_sha256":scope_hash,"holder_revision":1,"state":"serving","created_at":1000,"updated_at":2000});
        let volume = json!({"handle":physical["volume_handle"],"claimUid":physical["pvc_uid"],"volumeUid":physical["pv_uid"],"lvUuid":physical["lv_uuid"]});
        let storage = json!({"node":"customer-us1","namespaceUid":physical["namespace_uid"],"clusterUid":physical["cnpg_cluster_uid"]});
        let labels = json!({"pgcf.io/database-id":database});
        let maps = vec![
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("storage-{database}"),"namespace":"pgcf-system","uid":physical["storage_uid"],"labels":labels,"annotations":{"pgcf.io/volume-identity":volume.to_string()}},"data":{"state":storage.to_string()}}),
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("gateway-fence-{database}"),"namespace":"pgcf-system","uid":id(100),"labels":labels},"data":{"power.json":json!({"anchor":{"storageUid":physical["storage_uid"],"storageState":storage.to_string(),"volumeIdentity":volume.to_string(),"physicalGeneration":1}}).to_string(),"intent.json":json!({"database":database,"operation":format!("op_{}","a".repeat(20)),"revision":7,"mode":"running"}).to_string(),"pool-binding.json":record.to_string()}}),
            json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":format!("ca-{database}"),"namespace":"pgcf-system","uid":id(20),"labels":labels,"annotations":{"pgcf.io/source-ca-secret-uid":id(21),"pgcf.io/source-ca-secret-resource-version":"81"}},"data":{"ca.crt":"public test certificate material"}}),
        ];
        let pod = json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"pgcf-pool-test","namespace":"pgcf-pool","uid":id(13),"resourceVersion":"1","labels":{"app.kubernetes.io/name":"pgcf-pool"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.9","conditions":[{"type":"Ready","status":"True"}],"containerStatuses":[{"name":"postgres","ready":true,"containerID":format!("containerd://{}","d".repeat(64)),"imageID":format!("registry.test/postgres@sha256:{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-13T10:00:00Z"}}}]}});
        let node = json!({"apiVersion":"v1","kind":"Node","metadata":{"name":"customer-us1","uid":id(11),"resourceVersion":"1"},"status":{"nodeInfo":{"bootID":id(12)},"conditions":[{"type":"Ready","status":"True"}]}});
        let mut state = Targets::default();
        state.enable_pool(true);
        state
            .replace("endpointslices", &[slice(&id(3), "10.0.0.7")], None)
            .unwrap();
        state
            .replace("poolnodes", std::slice::from_ref(&node), None)
            .unwrap();
        state
            .replace("poolpods", std::slice::from_ref(&pod), None)
            .unwrap();
        state.replace("configmaps", &maps, None).unwrap();
        (state, maps, pod, node, record)
    }
    #[test]
    fn pool_uses_exact_binding_and_watched_runtime_not_cnpg_endpoints_or_late_labels() {
        let database = "a".repeat(20);
        let (mut state, maps, mut pod, mut node, _) = pool_fixture();
        let target = state.target(&database, control::now()).unwrap();
        assert_eq!(target.address.to_string(), "10.0.0.9");
        assert!(target.pool.is_some());
        pod["metadata"]["labels"]["pgcf.io/pool-database"] = "b".repeat(20).into();
        state
            .replace("poolpods", std::slice::from_ref(&pod), None)
            .unwrap();
        assert!(state.permits(&database, &target, control::now()));
        pod["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "e".repeat(64)).into();
        state
            .replace("poolpods", std::slice::from_ref(&pod), None)
            .unwrap();
        assert!(state.target(&database, control::now()).is_err());
        assert!(!state.permits(&database, &target, control::now()));
        pod["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "d".repeat(64)).into();
        state.replace("poolpods", &[pod], None).unwrap();
        node["status"]["nodeInfo"]["bootID"] = "00000000-0000-4000-8000-000000000099".into();
        state.replace("poolnodes", &[node], None).unwrap();
        assert!(!state.permits(&database, &target, control::now()));
        state.replace("configmaps", &maps, None).unwrap();
        assert!(state.target(&database, control::now()).is_err());
    }
    #[test]
    fn same_pool_busy_session_survives_ca_refresh_and_graceful_detach_but_not_rollback_or_unknown_scope()
     {
        let database = "a".repeat(20);
        let (mut state, mut maps, _, _, mut record) = pool_fixture();
        let target = state.target(&database, control::now()).unwrap();
        maps[2]["metadata"]["annotations"]["pgcf.io/source-ca-secret-resource-version"] =
            "82".into();
        maps[2]["data"]["ca.crt"] = "refreshed public certificate material".into();
        state.replace("configmaps", &maps, None).unwrap();
        let fresh = state.target(&database, control::now()).unwrap();
        assert_ne!(target.ca, fresh.ca);
        assert!(state.permits(&database, &target, control::now()));
        record["state"] = "detaching".into();
        record["holder_revision"] = 2.into();
        record["updated_at"] = 3000.into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        maps[1]["data"]["intent.json"]=json!({"database":database,"operation":format!("op_{}","a".repeat(20)),"revision":8,"mode":"quiesce"}).to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(state.target(&database, control::now()).is_err());
        assert!(state.permits(&database, &target, control::now()));
        record["state"] = "serving".into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(!state.permits(&database, &target, control::now()));
        record["state"] = "detaching".into();
        record["unexpected_proof"] = true.into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(!state.permits(&database, &target, control::now()));
        record.as_object_mut().unwrap().remove("unexpected_proof");
        record["state"] = "lost".into();
        record["holder_revision"] = 3.into();
        record["updated_at"] = 4000.into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(!state.permits(&database, &target, control::now()));
        record["state"] = "detaching".into();
        record["holder_revision"] = 4.into();
        record["updated_at"] = 5000.into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        state.replace("configmaps", &maps, None).unwrap();
        assert!(
            !state.permits(&database, &target, control::now()),
            "hard proof loss cannot be softened into a same-holder drain before release"
        );
    }

    #[test]
    fn thin_pool_holder_needs_its_own_signed_write_authority_and_keeps_expiry_protection() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use ring::signature::KeyPair;
        let database = "a".repeat(20);
        let (_, mut maps, pod, node, mut record) = pool_fixture();
        let profile = json!({"backend":"lvm-thin-v1","storage_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16)),"volume_attributes_class":format!("pgcf-lvm-thin-v1-{}","a".repeat(16)),"profile_revision":1,"profile_sha256":"a".repeat(64),"node_uid":record["scope"]["node_uid"],"volume_group_uuid":record["scope"]["storage"]["volume_group_uuid"],"pool_uuid":"cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh","startup_reserve_bytes":1048576,"write_bytes_per_second":1048576,"write_iops_per_second":64,"guard_seconds":120,"drain_seconds":1});
        record["scope"]["storage"]["backend"] = "lvm-thin-v1".into();
        record["scope"]["storage"]["thin_id"] = 1.into();
        record["scope"]["storage"]["profile"] = profile.clone();
        record["scope_sha256"] = Sha256::digest(serde_json::to_vec(&record["scope"]).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            .into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        let mut storage: Value =
            serde_json::from_str(maps[0]["data"]["state"].as_str().unwrap()).unwrap();
        storage["storage"] = profile.clone();
        maps[0]["data"]["state"] = storage.to_string().into();
        maps[0]["metadata"]["annotations"]["pgcf.io/gateway-fence-uid"] =
            maps[1]["metadata"]["uid"].clone();
        let mut power: Value =
            serde_json::from_str(maps[1]["data"]["power.json"].as_str().unwrap()).unwrap();
        power["anchor"]["storage"] = profile.clone();
        power["anchor"]["storageState"] = storage.to_string().into();
        maps[1]["data"]["power.json"] = power.to_string().into();
        let key = ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(key.as_ref()).unwrap();
        let public = serde_json::to_string(&std::collections::BTreeMap::from([(
            "cf",
            URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        )]))
        .unwrap();
        let pin = Sha256::digest(public.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let trust = StorageTrust::parse(&public, &pin).unwrap();
        let now = control::now();
        let expires = now + 10000;
        let issue = |generation, revision| {
            let scope = &record["scope"];
            let physical = &scope["storage"];
            let claims = json!({"v":1,"kid":"cf","database_id":database,"generation":generation,"authority_revision":revision,"storage_uid":physical["storage_uid"],"node_uid":scope["node_uid"],"volume_group_uuid":profile["volume_group_uuid"],"pool_uuid":profile["pool_uuid"],"profile_sha256":profile["profile_sha256"],"volume_handle":physical["volume_handle"],"lv_uuid":physical["lv_uuid"],"pvc_uid":physical["pvc_uid"],"pv_uid":physical["pv_uid"],"pod_uid":scope["pool_pod_uid"],"observed_at":now,"iat":now,"exp":expires,"guard_seconds":120,"drain_seconds":1,"write_allowed":true});
            let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
            let signed = pair.sign(format!("{}{body}", wire("storageAuthorityDomain")).as_bytes());
            format!(
                "{}.{body}.{}",
                wire("storageAuthorityPrefix"),
                URL_SAFE_NO_PAD.encode(signed.as_ref())
            )
        };
        let mut state = Targets::default();
        state.enable_pool(true);
        state.replace("poolnodes", &[node], Some(&trust)).unwrap();
        state.replace("poolpods", &[pod], Some(&trust)).unwrap();
        state.replace("endpointslices", &[], Some(&trust)).unwrap();
        state.replace("configmaps", &maps, Some(&trust)).unwrap();
        assert!(state.target(&database, now).is_err());
        maps[0]["data"][wire("storageAuthorityLedgerKey")] = issue(8, 1).into();
        state.replace("configmaps", &maps, Some(&trust)).unwrap();
        assert!(
            state.target(&database, now).is_err(),
            "a newer generation token cannot cover the old holder"
        );
        maps[0]["data"][wire("storageAuthorityLedgerKey")] = issue(7, 2).into();
        state.replace("configmaps", &maps, Some(&trust)).unwrap();
        let target = state.target(&database, now).unwrap();
        assert_eq!(target.storage.as_ref().unwrap().generation, 7);
        assert!(state.permits(&database, &target, now));
        assert!(!state.permits(&database, &target, expires));
        assert!(state.target(&database, expires).is_err());
        let operation = format!("op_{}", "a".repeat(20));
        assert!(
            !state.running_pool_close_permitted(&database, &operation, 7, now),
            "serving is not a detach request"
        );
        record["state"] = "detaching".into();
        record["holder_revision"] = 2.into();
        record["updated_at"] = 3000.into();
        maps[1]["data"]["pool-binding.json"] = record.to_string().into();
        state.replace("configmaps", &maps, Some(&trust)).unwrap();
        assert!(state.running_pool_close_permitted(&database, &operation, 7, now));
        assert!(!state.running_pool_close_permitted(&database, &operation, 8, now));
        assert!(!state.running_pool_close_permitted(&database, "op_wrong", 7, now));
        assert!(!state.running_pool_close_permitted(&database, &operation, 7, expires));
        maps[1]["data"]["intent.json"] =
            json!({"database":database,"operation":operation,"revision":8,"mode":"running"})
                .to_string()
                .into();
        state.replace("configmaps", &maps, Some(&trust)).unwrap();
        assert!(
            !state.running_pool_close_permitted(&database, &operation, 8, now),
            "a newer running fence cannot authorize the old holder close"
        );
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
    fn a_pool_holder_never_falls_back_to_an_attested_unready_writer() {
        let database = "a".repeat(20);
        let (mut state, mut maps, mut pool_pod, _, _) = pool_fixture();
        // The CNPG Pod the holder replaced is still attested by the fence and not Ready.
        let mut writer = slice(&wake_id(3), "10.0.0.7");
        writer["endpoints"][0]["conditions"] = json!({"ready":false,"terminating":false});
        let cnpg = json!({"apiVersion":"v1","kind":"Pod","metadata":{"namespace":format!("pgcf-db-{database}"),"uid":wake_id(3),"resourceVersion":"1","labels":{"cnpg.io/cluster":"database"}},"spec":{"nodeName":"customer-us1"},"status":{"podIP":"10.0.0.7","containerStatuses":[{"name":"postgres","ready":false,"containerID":format!("containerd://{}","a".repeat(64)),"state":{"running":{"startedAt":"2026-10-15T10:00:00Z"}}}]}});
        let target = json!({"v":1,"generation":7,"route_revision":19,"admission_epoch":11,"pod_uid":wake_id(3),"container_id":"a".repeat(64),"ca_secret_uid":wake_id(21),"ca_secret_resource_version":"81","ca_sha256":sha256_hex(WAKE_CA),"tls_server_name":format!("database-rw.pgcf-db-{database}.svc")});
        maps[1]["data"]["admission_target"] = target.to_string().into();
        state.replace("endpointslices", &[writer], None).unwrap();
        state.replace("pods", &[cnpg], None).unwrap();
        state.replace("configmaps", &maps, None).unwrap();
        let routed = state.target(&database, control::now()).unwrap();
        assert_eq!(routed.address.to_string(), "10.0.0.9");
        // The holder's runtime changes: nothing is routed, least of all the attested Pod.
        pool_pod["status"]["containerStatuses"][0]["containerID"] =
            format!("containerd://{}", "e".repeat(64)).into();
        state.replace("poolpods", &[pool_pod], None).unwrap();
        assert!(state.target(&database, control::now()).is_err());
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
        let withdrawals: [(&str, fn(&mut Wake)); 5] = [
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
}
