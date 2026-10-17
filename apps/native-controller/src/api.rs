// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{desired_valid, schema_valid, text},
    kubernetes::bounded,
};
use futures_util::{StreamExt, stream};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    path::PathBuf,
    time::Duration,
};
#[derive(Clone)]
enum AgentKey {
    File(PathBuf),
    Environment(String),
}
#[derive(Clone)]
pub struct ControlApi {
    client: Client,
    pub origin: Url,
    pub region: String,
    key: AgentKey,
}
#[derive(Clone)]
pub struct DesiredSnapshot {
    pub region: Value,
    pub fleet_release: Value,
    pub databases: Vec<Value>,
}
/// Region configuration and fleet identity stay fixed throughout a pull. Node readings may
/// advance between pages: keep the greatest revision of each same node, never merge away an
/// omitted authority (which can revoke writing) or hide a changed configuration.
fn merge_page_authority(snapshot: &mut DesiredSnapshot, page: &Value) -> Result<(), Error> {
    let mut held = snapshot.region.clone();
    let mut candidate = page["region"].clone();
    held.as_object_mut()
        .ok_or("desired region invalid")?
        .remove("storage_nodes");
    candidate
        .as_object_mut()
        .ok_or("desired region invalid")?
        .remove("storage_nodes");
    if held != candidate || snapshot.fleet_release != page["fleet_release"] {
        return Err("desired configuration changed across reads".into());
    }
    let nodes = |region: &Value| -> Result<BTreeMap<String, Value>, Error> {
        let mut nodes = BTreeMap::new();
        if let Some(rows) = region["storage_nodes"].as_array() {
            for row in rows {
                if nodes
                    .insert(text(row, "node_uid").to_string(), row.clone())
                    .is_some()
                {
                    return Err("duplicate desired node authority".into());
                }
            }
        }
        Ok(nodes)
    };
    let mut held = nodes(&snapshot.region)?;
    let candidate = nodes(&page["region"])?;
    if held.keys().ne(candidate.keys()) {
        return Err("desired node authority membership changed across reads".into());
    }
    for (uid, row) in candidate {
        let current = held
            .get_mut(&uid)
            .ok_or("desired node authority disappeared")?;
        if ["node_id", "name"]
            .iter()
            .any(|key| current[*key] != row[*key])
        {
            return Err("desired node authority identity changed across reads".into());
        }
        let (old, new) = (
            crate::contracts::integer(current, "revision")?,
            crate::contracts::integer(&row, "revision")?,
        );
        if old == new && *current != row {
            return Err("desired node authority revision changed across reads".into());
        }
        if new > old {
            *current = row;
        }
    }
    if snapshot.region.get("storage_nodes").is_some()
        || page["region"].get("storage_nodes").is_some()
    {
        snapshot.region["storage_nodes"] = held.into_values().collect::<Vec<_>>().into();
    }
    Ok(())
}
pub fn timestamp() -> Result<String, Error> {
    let now = time::OffsetDateTime::now_utc();
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    ))
}

/// A partial database update: its explicit coverage leaves Cloudflare's node, orphan and
/// memory inventory unchanged.
pub fn database_update(db: Value, observed_at: String) -> Result<Value, Error> {
    let envelope = json!({"coverage":"databases","observed_at":observed_at,"databases":[db]});
    if !schema_valid("DatabaseObservationUpdate", &envelope) {
        return Err("native observation contract invalid".into());
    }
    Ok(envelope)
}

fn predecessor(id: &str) -> Result<Option<String>, Error> {
    if !pgcf_native_protocol::valid_pattern("database", id) {
        return Err("invalid desired database identifier".into());
    }
    let alphabet = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut result = id.as_bytes().to_vec();
    for index in (0..20).rev() {
        let minimum = if index == 0 { 10 } else { 0 };
        let current = alphabet
            .iter()
            .position(|v| *v == result[index])
            .ok_or("invalid desired identifier")?;
        if current > minimum {
            result[index] = alphabet[current - 1];
            return Ok(Some(String::from_utf8(result)?));
        }
        if index == 0 {
            return Ok(None);
        }
        result[index] = b'z';
    }
    Ok(None)
}
impl ControlApi {
    pub async fn fleet_observation(&self, value: &Value) -> Result<(), Error> {
        if !schema_valid("FleetNodeReleaseObservation", value)
            || serde_json::to_vec(value)?.len() > 64 * 1024
        {
            return Err("native fleet observation invalid".into());
        }
        let reply = self
            .request("/agent/v1/fleet-observations", Some(value))
            .await?;
        if reply["accepted"] != true {
            return Err("fleet observation acknowledgement invalid".into());
        }
        Ok(())
    }
    pub async fn activity(&self, envelope: &Value) -> Result<Value, Error> {
        if !schema_valid("AgentActivityRequest", envelope)
            || serde_json::to_vec(envelope)?.len() > 64 * 1024
        {
            return Err("native activity report invalid".into());
        }
        let reply = self.request("/agent/v1/activity", Some(envelope)).await?;
        let accepted = crate::contracts::integer(&reply, "accepted")?;
        let idle = crate::contracts::integer(&reply, "idle_intents")?;
        if accepted > envelope["databases"].as_array().map_or(0, Vec::len) as u64 || idle > accepted
        {
            return Err("activity acknowledgement invalid".into());
        }
        Ok(reply)
    }
    pub async fn usage(&self, envelope: &Value) -> Result<Value, Error> {
        if !schema_valid("AgentUsageRequest", envelope)
            || serde_json::to_vec(envelope)?.len() > 64 * 1024
        {
            return Err("native usage report invalid".into());
        }
        let reply = self.request("/agent/v1/usage", Some(envelope)).await?;
        let recorded = crate::contracts::integer(&reply, "recorded")?;
        let duplicates = crate::contracts::integer(&reply, "duplicates")?;
        // An API released before refusals omits the count.
        let refused = if reply["refused"].is_null() {
            0
        } else {
            crate::contracts::integer(&reply, "refused")?
        };
        if recorded
            .checked_add(duplicates)
            .and_then(|sum| sum.checked_add(refused))
            != Some(envelope["samples"].as_array().map_or(0, Vec::len) as u64)
        {
            return Err("usage acknowledgement invalid".into());
        }
        Ok(reply)
    }
    pub async fn from_env() -> Result<Self, Error> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let region = std::env::var("PGCF_REGION_ID")?;
        if !pgcf_native_protocol::valid_pattern("region", &region) {
            return Err("invalid regional identity".into());
        }
        let origin = Url::parse(&std::env::var("PGCF_API_URL")?)?;
        if origin.scheme() != "https"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.path() != "/"
        {
            return Err("invalid Cloudflare API origin".into());
        }
        let key = match (
            std::env::var("PGCF_AGENT_KEY_FILE").ok(),
            std::env::var("PGCF_AGENT_KEY").ok(),
        ) {
            (Some(path), None) => AgentKey::File(path.into()),
            (None, Some(value)) => AgentKey::Environment(value),
            _ => return Err("ambiguous or missing regional credential".into()),
        };
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let client = Client::builder()
            .use_preconfigured_tls(tls)
            .https_only(true)
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .build()?;
        let api = Self {
            client,
            origin,
            region,
            key,
        };
        api.key().await?;
        Ok(api)
    }
    pub async fn key(&self) -> Result<String, Error> {
        let value = match &self.key {
            AgentKey::File(path) => tokio::fs::read_to_string(path).await?.trim().to_string(),
            AgentKey::Environment(value) => value.clone(),
        };
        let secret = value
            .strip_prefix(&format!("pgcf_ak_{}_", self.region))
            .ok_or("regional credential identity mismatch")?;
        if secret.len() != 43
            || !secret
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("invalid regional credential".into());
        }
        Ok(value)
    }
    async fn request(&self, path: &str, body: Option<&Value>) -> Result<Value, Error> {
        let mut request = self
            .client
            .request(
                if body.is_some() {
                    Method::POST
                } else {
                    Method::GET
                },
                self.origin.join(path)?,
            )
            .bearer_auth(self.key().await?);
        if let Some(body) = body {
            let encoded = serde_json::to_vec(body)?;
            if encoded.len() > 2 * 1024 * 1024 {
                return Err("Cloudflare observation exceeds bound".into());
            }
            request = request
                .header("Content-Type", "application/json")
                .body(encoded);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let code = bounded(response, 64 * 1024)
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|body| body["error"]["code"].as_str().map(str::to_string));
            return Err(Box::new(Refusal {
                status: status.as_u16(),
                code,
            }));
        }
        Ok(serde_json::from_slice(
            &bounded(response, 2 * 1024 * 1024).await?,
        )?)
    }
    async fn page(&self, after: Option<&str>, limit: usize) -> Result<Value, Error> {
        let mut url = self.origin.join("/agent/v1/desired")?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", &limit.to_string());
            if let Some(after) = after {
                query.append_pair("after", after);
            }
        }
        let value = self
            .request(
                &format!("{}?{}", url.path(), url.query().unwrap_or("")),
                None,
            )
            .await?;
        if !desired_valid(&value, &self.region) {
            return Err("Cloudflare desired page invalid".into());
        }
        Ok(value)
    }
    pub async fn desired(&self, ids: Option<&[String]>) -> Result<DesiredSnapshot, Error> {
        tokio::time::timeout(Duration::from_secs(60), async {
            if let Some(ids) = ids {
                if ids.is_empty() || ids.len() > 200 {
                    return Err("desired hint exceeds bound".into());
                }
                let mut pages = stream::iter(ids.iter().map(|id| async move {
                    let prior = predecessor(id)?;
                    let page = self.page(prior.as_deref(), 1).await?;
                    Ok::<_, Error>((id, page))
                }))
                .buffer_unordered(4);
                let mut snapshot: Option<DesiredSnapshot> = None;
                while let Some(result) = pages.next().await {
                    let (id, page) = result?;
                    let state = snapshot.get_or_insert_with(|| DesiredSnapshot {
                        region: page["region"].clone(),
                        fleet_release: page["fleet_release"].clone(),
                        databases: vec![],
                    });
                    merge_page_authority(state, &page)?;
                    if let Some(db) = page["databases"]
                        .as_array()
                        .and_then(|rows| rows.first())
                        .filter(|db| text(db, "id") == id)
                    {
                        state.databases.push(db.clone());
                    }
                }
                return snapshot.ok_or_else(|| "desired hint has no authority".into());
            }
            let mut cursor = None;
            let mut seen = HashSet::new();
            let mut snapshot = None;
            for _ in 0..50 {
                let page = self.page(cursor.as_deref(), 200).await?;
                let state = snapshot.get_or_insert_with(|| DesiredSnapshot {
                    region: page["region"].clone(),
                    fleet_release: page["fleet_release"].clone(),
                    databases: vec![],
                });
                merge_page_authority(state, &page)?;
                for db in page["databases"].as_array().ok_or("desired rows invalid")? {
                    if !seen.insert(text(db, "id").to_string()) {
                        return Err("duplicate desired database".into());
                    }
                    state.databases.push(db.clone());
                }
                let next = page["next"].as_str();
                if next.is_none() {
                    return Ok(snapshot.unwrap());
                }
                if next == cursor.as_deref() {
                    return Err("desired cursor did not advance".into());
                }
                cursor = next.map(str::to_string);
            }
            Err("desired page count exceeds bound".into())
        })
        .await?
    }
    /// Publishes one verified database observation at once, apart from inventory work.
    pub async fn observation(&self, db: Value) -> Result<(), Error> {
        let envelope = database_update(db, timestamp()?)?;
        let result = self.report(&envelope).await?;
        if crate::contracts::integer(&result, "accepted")? != 1 {
            return Err("Cloudflare observation acknowledgement invalid".into());
        }
        Ok(())
    }
    pub async fn inventory(&self, envelope: &Value) -> Result<(), Error> {
        if !schema_valid("RegionalInventory", envelope) {
            return Err("native inventory contract invalid".into());
        }
        self.report(envelope).await?;
        Ok(())
    }
    /// An API released before explicit coverage refuses the label as `invalid_request`; the same
    /// facts are then sent once in the legacy shape, where omitted orphans equally keep the
    /// recorded inventory. An API rollback therefore never needs a fleet rollback first.
    async fn report(&self, envelope: &Value) -> Result<Value, Error> {
        match self.request("/agent/v1/observations", Some(envelope)).await {
            Err(error)
                if error.downcast_ref::<Refusal>().is_some_and(|refusal| {
                    refusal.status == 400 && refusal.code.as_deref() == Some("invalid_request")
                }) =>
            {
                self.request("/agent/v1/observations", Some(&legacy_report(envelope)?))
                    .await
            }
            result => result,
        }
    }
}
#[cfg(test)]
impl ControlApi {
    /// A client of a plain-HTTP Cloudflare API double.
    pub(crate) fn double(origin: Url) -> Self {
        Self {
            client: crate::cluster_http(Duration::from_secs(5)).unwrap(),
            origin,
            region: "eu-test".into(),
            key: AgentKey::Environment(format!("pgcf_ak_eu-test_{}", "a".repeat(43))),
        }
    }
}
/// A Cloudflare API refusal with its HTTP status and error code.
#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    pub code: Option<String>,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Cloudflare API HTTP{}", self.status)
    }
}
impl std::error::Error for Refusal {}
/// The pre-coverage shape of a partial update or regional inventory.
fn legacy_report(envelope: &Value) -> Result<Value, Error> {
    let mut legacy = match text(envelope, "coverage") {
        "databases" => {
            json!({"observed_at":envelope["observed_at"],"nodes":[],"databases":envelope["databases"]})
        }
        "inventory" => {
            json!({"observed_at":envelope["observed_at"],"nodes":envelope["nodes"],"databases":[],"orphans":envelope["orphans"]})
        }
        _ => return Err("observation coverage unknown".into()),
    };
    if !envelope["node_memory_samples"].is_null() {
        legacy["node_memory_samples"] = envelope["node_memory_samples"].clone();
    }
    if !schema_valid("ObservationRequest", &legacy) {
        return Err("native legacy observation contract invalid".into());
    }
    Ok(legacy)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_server::{Requests, api_double};
    /// Authority readings are mutable while one desired pull pages through a stable region.
    fn desired_page(revision: u64, next: Value) -> Value {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let mut authority = vectors["reclamation"][0]["nodes"][0].clone();
        authority["revision"] = revision.into();
        json!({"region":{"id":"eu-test","backup":{"bucket":"pgcf-backups","endpoint_url":"https://r2.example.test","region":"auto"},"storage_nodes":[authority]},"databases":[],"next":next})
    }
    #[tokio::test]
    async fn a_renewal_between_desired_pages_keeps_the_newest_node_authority() {
        let (api, requests) = api_double(|path, _| {
            if path.contains("after=") {
                (200, desired_page(8, Value::Null))
            } else {
                (200, desired_page(7, "a0000000000000000001".into()))
            }
        })
        .await;
        let snapshot = api.desired(None).await.unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(snapshot.region["storage_nodes"][0]["revision"], 8);
    }
    #[tokio::test]
    async fn a_renewal_between_hinted_reads_never_regresses_the_node_authority() {
        let (api, requests) = api_double(|path, _| {
            let revision = if path.contains("after=a0000000000000000001") {
                8
            } else {
                7
            };
            (200, desired_page(revision, Value::Null))
        })
        .await;
        let snapshot = api
            .desired(Some(&[
                "a0000000000000000001".into(),
                "a0000000000000000002".into(),
            ]))
            .await
            .unwrap();
        assert_eq!(requests.lock().unwrap().len(), 2);
        assert_eq!(snapshot.region["storage_nodes"][0]["revision"], 8);
    }
    #[tokio::test]
    async fn mutable_authority_never_hides_a_region_configuration_or_membership_change() {
        for membership in [false, true] {
            let (api, _) = api_double(move |path, _| {
                let mut page = desired_page(
                    7,
                    if path.contains("after=") {
                        Value::Null
                    } else {
                        "a0000000000000000001".into()
                    },
                );
                if path.contains("after=") {
                    if membership {
                        page["region"]["storage_nodes"] = json!([]);
                    } else {
                        page["region"]["backup"]["endpoint_url"] =
                            "https://changed.example.test".into();
                    }
                }
                (200, page)
            })
            .await;
            assert!(api.desired(None).await.is_err());
        }
    }
    #[test]
    fn exact_target_lookup_never_broadens_a_wake_into_a_fleet_scan() {
        assert_eq!(predecessor("a0000000000000000000").unwrap(), None);
        assert_eq!(
            predecessor("a0000000000000000001").unwrap(),
            Some("a0000000000000000000".into())
        );
        assert_eq!(
            predecessor("b0000000000000000000").unwrap(),
            Some("azzzzzzzzzzzzzzzzzzz".into())
        );
        assert!(predecessor("../../kube-system").is_err());
    }
    #[test]
    fn a_ready_database_is_published_as_a_partial_update_that_cannot_replace_inventory() {
        let db = json!({"id":"a0000000000000000001","generation":3,"state":"ready","archive":{"continuous":false,"ready_wal_files":null,"health":"unknown"},"power":{"operation":format!("op_{}","a".repeat(20)),"revision":3,"state":"awake"}});
        let at = timestamp().unwrap();
        let envelope = database_update(db.clone(), at.clone()).unwrap();
        assert_eq!(
            envelope,
            json!({"coverage":"databases","observed_at":at,"databases":[db]})
        );
        assert!(!schema_valid("RegionalInventory", &envelope));
        for (key, value) in [
            ("nodes", json!([])),
            ("orphans", json!([])),
            ("node_memory_samples", json!([])),
        ] {
            let mut mixed = envelope.clone();
            mixed[key] = value;
            assert!(!schema_valid("DatabaseObservationUpdate", &mixed), "{key}");
        }
        assert!(database_update(json!({"id":"a0000000000000000001"}), at).is_err());
    }
    #[test]
    fn native_timestamps_match_date_iso_precision() {
        let timestamp = timestamp().unwrap();
        assert_eq!(timestamp.len(), 24);
        assert!(timestamp.ends_with('Z'));
    }
    /// With `coverage_known` false the double refuses labelled reports like an API released before coverage.
    async fn observation_api(coverage_known: bool, status: u16) -> (ControlApi, Requests) {
        api_double(move |_, body| {
            if status != 200 {
                (
                    status,
                    json!({"error":{"code":"unauthorized","message":"Unauthorized","request_id":"test"}}),
                )
            } else if !coverage_known && !body["coverage"].is_null() {
                (
                    400,
                    json!({"error":{"code":"invalid_request","message":"Request validation failed","request_id":"test"}}),
                )
            } else {
                (
                    200,
                    json!({"accepted":body["databases"].as_array().map_or(0, Vec::len)}),
                )
            }
        })
        .await
    }
    #[tokio::test]
    async fn a_refused_usage_sample_is_acknowledged_so_the_outbox_drains_past_it() {
        let sample = |sequence: u64| json!({"database_id":"a0000000000000000001","source":"agent","producer_id":"fixture","sequence":sequence,"observed_at":timestamp().unwrap(),"storage_used_bytes":null,"storage_allocated_bytes":1});
        let envelope = json!({"samples":[sample(1),sample(2)]});
        let (refusing, _) =
            api_double(|_, _| (200, json!({"recorded":1,"duplicates":0,"refused":1}))).await;
        refusing.usage(&envelope).await.unwrap();
        // An API released before refusals omits the count; its acknowledgement still covers every sample.
        let (legacy, _) = api_double(|_, _| (200, json!({"recorded":1,"duplicates":1}))).await;
        legacy.usage(&envelope).await.unwrap();
        let (short, _) =
            api_double(|_, _| (200, json!({"recorded":1,"duplicates":0,"refused":0}))).await;
        assert!(short.usage(&envelope).await.is_err());
    }
    #[tokio::test]
    async fn an_api_released_before_coverage_receives_the_same_report_in_the_legacy_shape() {
        let db = json!({"id":"a0000000000000000001","generation":3,"state":"ready","archive":{"continuous":false,"ready_wal_files":null,"health":"unknown"}});
        let (api, bodies) = observation_api(false, 200).await;
        api.observation(db.clone()).await.unwrap();
        let sent: Vec<_> = bodies
            .lock()
            .unwrap()
            .iter()
            .map(|(_, body)| body.clone())
            .collect();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["coverage"], "databases");
        assert_eq!(
            sent[1],
            json!({"observed_at":sent[0]["observed_at"],"nodes":[],"databases":[db]})
        );
        let scan = json!({"coverage":"inventory","observed_at":timestamp().unwrap(),"nodes":[],"orphans":[],"node_memory_samples":[]});
        api.inventory(&scan).await.unwrap();
        let sent: Vec<_> = bodies
            .lock()
            .unwrap()
            .iter()
            .map(|(_, body)| body.clone())
            .collect();
        assert_eq!(sent.len(), 4);
        assert_eq!(
            sent[3],
            json!({"observed_at":scan["observed_at"],"nodes":[],"databases":[],"orphans":[],"node_memory_samples":[]})
        );
        // A current API takes the labelled report once; another refusal is never re-sent.
        let (current, bodies) = observation_api(true, 200).await;
        current.observation(db.clone()).await.unwrap();
        assert_eq!(bodies.lock().unwrap().len(), 1);
        let (refusing, bodies) = observation_api(false, 401).await;
        assert!(refusing.observation(db).await.is_err());
        assert_eq!(bodies.lock().unwrap().len(), 1);
    }
}
