// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tonic::Status;

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub release_id: String,
    pub image: String,
    pub holder_sha256: String,
    pub controller_sha256: String,
    pub containerd_version: String,
    pub runc_version: String,
    pub architecture: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub version: u32,
    pub target_slots: u32,
    pub max_idle_cpu_millicores: u32,
    pub max_idle_memory_mib: u32,
    pub per_slot_cpu_millicores: u32,
    pub per_slot_memory_mib: u32,
    pub max_age_seconds: u32,
    pub profile: Profile,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Lease {
    pub purpose: String,
    pub node_id: String,
    pub node_uid: String,
    pub region_id: String,
    pub revision: u32,
    pub policy: Policy,
    pub updated_at: String,
    pub material_revision: u32,
    pub assignment_revision: u32,
    pub region_revision: u32,
    pub node_observed_at: String,
    pub issued_at: String,
    pub expires_at: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StorageAuthorityTrust {
    pub keys: std::collections::BTreeMap<String, String>,
    pub sha256: String,
    #[serde(default)]
    pub legacy_database_ids: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Cloudflare {
    pub api_url: String,
    pub agent_key_file: PathBuf,
    pub node_id: String,
    pub node_uid: String,
    pub region_id: String,
    pub material_revision: u32,
    pub image: String,
    pub cgroup_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_authority: Option<StorageAuthorityTrust>,
}
#[derive(Clone)]
pub struct Authority {
    pub lease: Lease,
    received: Instant,
    valid_for: Duration,
}
fn limits() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/compute-pool.generated.json"
    ))
    .expect("generated_compute_contract_invalid")
}
fn invalid() -> Status {
    Status::failed_precondition("compute_pool_authority_invalid")
}
fn instant(value: &str) -> Result<i128, Status> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map(|time| time.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| invalid())
}
pub fn now_ms() -> i128 {
    OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}
pub fn timestamp() -> Result<String, Status> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| invalid())
}
pub fn policy_valid(policy: &Policy) -> bool {
    let generated = limits();
    let Ok(schema) = jsonschema::validator_for(&generated["policy_schema"]) else {
        return false;
    };
    schema.is_valid(&serde_json::to_value(policy).expect("serializable_pool_policy"))
        && u64::from(policy.target_slots) * u64::from(policy.per_slot_cpu_millicores)
            <= u64::from(policy.max_idle_cpu_millicores)
        && u64::from(policy.target_slots) * u64::from(policy.per_slot_memory_mib)
            <= u64::from(policy.max_idle_memory_mib)
}
pub fn digest(path: &std::path::Path) -> Result<String, Status> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(|_| invalid())?;
    let mut hash = Sha256::new();
    let mut chunk = [0_u8; 65536];
    loop {
        let count = file.read(&mut chunk).map_err(|_| invalid())?;
        if count == 0 {
            break;
        }
        hash.update(&chunk[..count]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}
impl Authority {
    pub fn validate(lease: Lease, local: &Cloudflare, now: i128) -> Result<Self, Status> {
        let generated = limits();
        let bounds = &generated["limits"];
        let issued = instant(&lease.issued_at)?;
        let expires = instant(&lease.expires_at)?;
        let observed = instant(&lease.node_observed_at)?;
        let skew = bounds["clock_skew_ms"].as_i64().ok_or_else(invalid)? as i128;
        let lease_ms = bounds["lease_ms"].as_i64().ok_or_else(invalid)? as i128;
        if lease.purpose != "pgcf-compute-pool/v1"
            || lease.node_id != local.node_id
            || lease.node_uid != local.node_uid
            || lease.region_id != local.region_id
            || lease.material_revision != local.material_revision
            || lease.policy.profile.image != local.image
            || lease.revision == 0
            || lease.assignment_revision == 0
            || lease.region_revision == 0
            || !policy_valid(&lease.policy)
            || issued > now + skew
            || issued < now - lease_ms
            || expires <= now
            || expires <= issued
            || expires - issued > lease_ms
            || observed < issued - bounds["node_max_age_ms"].as_i64().ok_or_else(invalid)? as i128
            || observed > issued + skew
        {
            return Err(invalid());
        }
        Ok(Self {
            valid_for: Duration::from_millis((expires - now) as u64),
            lease,
            received: Instant::now(),
        })
    }
    pub fn valid(&self) -> bool {
        self.received.elapsed() < self.valid_for
            && instant(&self.lease.expires_at).is_ok_and(|expires| expires > now_ms())
    }
}
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    local: Cloudflare,
    key: String,
}
impl Client {
    pub fn local(&self) -> &Cloudflare {
        &self.local
    }
    #[cfg(target_os = "linux")]
    pub async fn reclaim_intents(&self) -> Result<serde_json::Value, Status> {
        let mut response = self
            .http
            .get(format!(
                "{}/agent/v1/nodes/{}/reclaim",
                self.local.api_url.trim_end_matches('/'),
                self.local.node_id
            ))
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|_| Status::unavailable("reclaim_intents_unavailable"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Status::permission_denied("reclaim_intents_refused"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(Status::resource_exhausted(
                    "bounded_reclaim_intents_exceeded",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    }
    pub fn new(local: Cloudflare) -> Result<Self, Status> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let url = reqwest::Url::parse(&local.api_url).map_err(|_| invalid())?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "" | "/")
        {
            return Err(invalid());
        }
        let key = std::fs::read_to_string(&local.agent_key_file)
            .map_err(|_| invalid())?
            .trim()
            .to_owned();
        if !key.starts_with(&format!("pgcf_ak_{}_", local.region_id))
            || key.len() > 4096
            || key.bytes().any(|b| b.is_ascii_whitespace())
        {
            return Err(invalid());
        }
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| invalid())?;
        Ok(Self { http, local, key })
    }
    fn url(&self) -> String {
        format!(
            "{}/agent/v1/nodes/{}/compute-pool",
            self.local.api_url.trim_end_matches('/'),
            self.local.node_id
        )
    }
    #[cfg(target_os = "linux")]
    pub async fn storage_lease(&self) -> Result<crate::storage::HostStorageLease, Status> {
        let url = format!(
            "{}/agent/v1/nodes/{}/storage-guard",
            self.local.api_url.trim_end_matches('/'),
            self.local.node_id
        );
        let mut response = self
            .http
            .get(url)
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|_| Status::unavailable("storage_guard_fetch_failed"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Status::permission_denied(
                "storage_guard_authority_unavailable",
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(Status::resource_exhausted(
                    "storage_guard_snapshot_too_large",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| invalid())
    }
    #[cfg(target_os = "linux")]
    pub async fn report_reclaim(&self, report: &serde_json::Value) -> Result<(), Status> {
        let response = self
            .http
            .post(format!(
                "{}/agent/v1/nodes/{}/reclaim-observations",
                self.local.api_url.trim_end_matches('/'),
                self.local.node_id
            ))
            .bearer_auth(&self.key)
            .json(report)
            .send()
            .await
            .map_err(|_| Status::unavailable("reclaim_observation_unconfirmed"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Status::permission_denied("reclaim_observation_refused"));
        }
        Ok(())
    }
    pub async fn lease(&self) -> Result<Authority, Status> {
        let mut response = self
            .http
            .get(self.url())
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|_| Status::unavailable("compute_pool_fetch_failed"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Status::permission_denied(
                "compute_pool_authority_unavailable",
            ));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
            if body.len() + chunk.len() > 65536 {
                return Err(invalid());
            }
            body.extend_from_slice(&chunk);
        }
        Authority::validate(
            serde_json::from_slice(&body).map_err(|_| invalid())?,
            &self.local,
            now_ms(),
        )
    }
    pub async fn report(&self, observation: &serde_json::Value) -> Result<(), Status> {
        let response = self
            .http
            .post(self.url())
            .bearer_auth(&self.key)
            .json(observation)
            .send()
            .await
            .map_err(|_| Status::unavailable("compute_pool_report_unconfirmed"))?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Status::permission_denied("compute_pool_report_refused"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_uses_generated_zod_schema_and_rejects_the_same_oversized_target() {
        let generated = limits();
        let lease: Lease = serde_json::from_value(generated["lease"].clone()).unwrap();
        assert!(generated["valid_policy"].as_bool().unwrap());
        assert!(policy_valid(&lease.policy));
        let bad: Policy =
            serde_json::from_value(generated["invalid_budget_policy"].clone()).unwrap();
        assert!(!generated["invalid_budget_accepted"].as_bool().unwrap());
        assert!(!policy_valid(&bad));
    }
    #[test]
    fn short_lease_requires_the_independently_bound_physical_node_and_material() {
        let generated = limits();
        let lease: Lease = serde_json::from_value(generated["lease"].clone()).unwrap();
        let local = Cloudflare {
            api_url: "https://api.invalid".into(),
            agent_key_file: "/private/agent".into(),
            node_id: lease.node_id.clone(),
            node_uid: lease.node_uid.clone(),
            region_id: lease.region_id.clone(),
            material_revision: lease.material_revision,
            image: lease.policy.profile.image.clone(),
            cgroup_root: "/sys/fs/cgroup/pgcf-pool".into(),
            storage_authority: None,
        };
        let now = instant(&lease.issued_at).unwrap();
        assert!(Authority::validate(lease.clone(), &local, now).is_ok());
        let mut changed = local.clone();
        changed.node_uid = "different-physical-node".into();
        assert!(Authority::validate(lease.clone(), &changed, now).is_err());
        assert!(Authority::validate(lease, &local, now + 30000).is_err());
    }
    #[test]
    fn scratch_https_client_initializes_ring_and_compiled_trust_without_host_ca_files() {
        use std::{io::Write, os::unix::fs::OpenOptionsExt};
        let generated = limits();
        let lease: Lease = serde_json::from_value(generated["lease"].clone()).unwrap();
        let path = std::env::temp_dir().join(format!(
            "pgcf-client-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        write!(file, "pgcf_ak_{}_fixture", lease.region_id).unwrap();
        drop(file);
        let local = Cloudflare {
            api_url: "https://api.invalid".into(),
            agent_key_file: path.clone(),
            node_id: lease.node_id,
            node_uid: lease.node_uid,
            region_id: lease.region_id,
            material_revision: lease.material_revision,
            image: lease.policy.profile.image,
            cgroup_root: "/sys/fs/cgroup/pgcf-pool".into(),
            storage_authority: None,
        };
        assert!(Client::new(local).is_ok());
        std::fs::remove_file(path).unwrap();
    }
}
