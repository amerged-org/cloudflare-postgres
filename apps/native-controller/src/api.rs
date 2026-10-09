// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{desired_valid, schema_valid, text},
    kubernetes::bounded,
};
use futures_util::{StreamExt, stream};
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, time::Duration};
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
        if recorded.checked_add(duplicates)
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
        if !response.status().is_success() {
            return Err(format!("Cloudflare API HTTP{}", response.status().as_u16()).into());
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
                    if state.region != page["region"]
                        || state.fleet_release != page["fleet_release"]
                    {
                        return Err("desired authority changed across hint reads".into());
                    }
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
                if state.region != page["region"] || state.fleet_release != page["fleet_release"] {
                    return Err("desired authority changed across pages".into());
                }
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
    pub async fn observation(&self, db: Value) -> Result<(), Error> {
        let envelope = json!({"observed_at":timestamp()?,"nodes":[],"databases":[db]});
        if !schema_valid("ObservationRequest", &envelope) {
            return Err("native observation contract invalid".into());
        }
        let result = self
            .request("/agent/v1/observations", Some(&envelope))
            .await?;
        if crate::contracts::integer(&result, "accepted")? != 1 {
            return Err("Cloudflare observation acknowledgement invalid".into());
        }
        Ok(())
    }
    pub async fn inventory(&self, envelope: &Value) -> Result<(), Error> {
        if !schema_valid("ObservationRequest", envelope) {
            return Err("native inventory contract invalid".into());
        }
        self.request("/agent/v1/observations", Some(envelope))
            .await?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
    fn native_timestamps_match_date_iso_precision() {
        let timestamp = timestamp().unwrap();
        assert_eq!(timestamp.len(), 24);
        assert!(timestamp.ends_with('Z'));
    }
}
