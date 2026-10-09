// SPDX-License-Identifier: Apache-2.0
//! Authenticated discovery and physical write authority, outside connection hot paths.
use crate::{
    control,
    kubernetes::Kubernetes,
    storage::{StorageBinding, StorageGate, StorageTrust},
};
use futures_util::StreamExt;
use pgcf_native_protocol::{valid_pattern, wire};
use serde::Deserialize;
use serde_json::Value;
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
    legacy: HashMap<String, LegacyStorageBinding>,
    identities: HashMap<String, TargetIdentity>,
    slices: HashMap<String, Value>,
    maps: HashMap<String, Value>,
    gates: HashMap<String, StorageGate>,
    slices_observed: Option<Instant>,
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
    if v["apiVersion"] != "v1"
        || v["kind"] != "ConfigMap"
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
    Ok(
        (name == format!("storage-{database}") || name == format!("gateway-fence-{database}"))
            .then(|| name.into()),
    )
}
fn owned_slice(v: &Value) -> Result<String, &'static str> {
    if v["apiVersion"] != "discovery.k8s.io/v1"
        || v["kind"] != "EndpointSlice"
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
        } else {
            owned_map(object)?
        };
        if let Some(key) = key {
            let records = if kind == "endpointslices" {
                &mut self.slices
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
        let database = if kind == "endpointslices" {
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
        } else {
            self.maps_observed = Some(Instant::now());
        }
    }
    pub fn disconnect(&mut self, kind: &str) {
        if kind == "endpointslices" {
            self.slices_observed = None;
        } else {
            self.maps_observed = None;
        }
        for gate in self.gates.values_mut() {
            gate.disconnect();
        }
    }
    fn endpoint(&self, database: &str) -> Result<(IpAddr, String, String), &'static str> {
        let namespace = format!("pgcf-db-{database}");
        let mut endpoints = BTreeMap::new();
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
                if endpoint["conditions"]["ready"] != true
                    || endpoint["conditions"]["terminating"] == true
                {
                    continue;
                }
                let reference = &endpoint["targetRef"];
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
                    endpoints.insert((uid.clone(), node.clone(), address), ());
                }
            }
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
        selected.ok_or("writer target unavailable")
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
        for database in names {
            self.refresh_gate(&database, trust);
        }
    }
    fn refresh_gate(&mut self, database: &str, trust: Option<&StorageTrust>) {
        let now = control::now();
        let identity = self
            .endpoint(database)
            .and_then(|(address, pod_uid, node)| {
                Ok(TargetIdentity {
                    address,
                    storage: self.binding(database, &pod_uid, &node)?,
                    pod_uid,
                    node,
                })
            });
        if !self.maps.contains_key(&format!("storage-{database}"))
            && !self.maps.contains_key(&format!("gateway-fence-{database}"))
        {
            self.identities.remove(database);
            self.gates.remove(database);
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
                let trust = trust.ok_or("storage signer unavailable")?;
                let raw = text(
                    &self.maps[&format!("storage-{database}")]["data"],
                    wire("storageAuthorityLedgerKey"),
                )?;
                gate.update(trust.verify(raw, now)?, binding, now)
            })();
            if outcome.is_err() {
                gate.disconnect();
            }
        }
        self.identities.insert(database.into(), identity);
    }
    fn current_target(&self, database: &str, now: u64) -> Result<&TargetIdentity, &'static str> {
        if !valid_pattern("database", database) || !self.synchronized() {
            return Err("writer discovery unavailable");
        }
        let target = self
            .identities
            .get(database)
            .ok_or("writer target unavailable")?;
        if target.storage.as_ref().is_some_and(|binding| {
            !self
                .gates
                .get(database)
                .is_some_and(|gate| gate.permits(binding, now))
        }) {
            return Err("physical write authority unavailable");
        }
        Ok(target)
    }
    pub fn target(&self, database: &str, now: u64) -> Result<TargetIdentity, &'static str> {
        self.current_target(database, now).cloned()
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

pub async fn synchronize(
    api: Arc<Kubernetes>,
    state: Arc<RwLock<Targets>>,
    trust: Option<StorageTrust>,
    kind: &'static str,
    mut stop: watch::Receiver<bool>,
) {
    let path = if kind == "endpointslices" {
        "/apis/discovery.k8s.io/v1/endpointslices".to_string()
    } else {
        format!("/api/v1/namespaces/{}/configmaps", wire("fenceNamespace"))
    };
    let selector = if kind == "endpointslices" {
        "kubernetes.io/service-name=database-rw"
    } else {
        "pgcf.io/database-id"
    };
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
            } else {
                "ConfigMapList"
            };
            if list["apiVersion"] == expected_api
                && list["kind"] == expected_kind
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
    let path = if kind == "endpointslices" {
        "/apis/discovery.k8s.io/v1/endpointslices".to_string()
    } else {
        format!("/api/v1/namespaces/{}/configmaps", wire("fenceNamespace"))
    };
    let selector = if kind == "endpointslices" {
        "kubernetes.io/service-name=database-rw"
    } else {
        "pgcf.io/database-id"
    };
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
}
