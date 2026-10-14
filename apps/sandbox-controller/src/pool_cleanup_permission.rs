// SPDX-License-Identifier: Apache-2.0
//! PC1 is cleanup-only authority for one exact stopped holder and measured worker.
use crate::{policy::Cloudflare, pool_device::ThinMetadata, pool_permission};
use pgcf_native_protocol::pool;
use serde_json::Value;
use std::time::{Duration, Instant};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_cleanup_authority_unconfirmed")
}
fn now() -> u64 {
    u64::try_from(crate::policy::now_ms()).unwrap_or(0)
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Status> {
    v[k].as_str().ok_or_else(refused)
}
#[derive(Clone)]
pub struct Permission {
    claims: Value,
    token: String,
    io: Value,
    received: Instant,
    remaining: Duration,
}
fn matches(scope: &Value, holder: &Value, io: &Value, claims: &Value) -> bool {
    let intent = &holder["cleanup_intent"];
    pool::validate("PoolBindingScope", scope)
        && pool::validate("PoolCleanupIoAttestation", io)
        && matches!(
            holder["state"].as_str(),
            Some("detaching" | "failed" | "lost")
        )
        && pool::scope_hash(scope).is_some_and(|hash| {
            claims["scope_sha256"] == hash
                && holder["scope_sha256"] == hash
                && io["scope_sha256"] == hash
        })
        && pool::cleanup_io_hash(io).is_some_and(|hash| claims["cleanup_io_sha256"] == hash)
        && claims["binding_id"] == scope["binding_id"]
        && holder["binding_id"] == scope["binding_id"]
        && io["binding_id"] == scope["binding_id"]
        && claims["holder_revision"] == holder["holder_revision"]
        && io["holder_revision"] == holder["holder_revision"]
        && claims["holder_generation"] == scope["generation"]
        && holder["holder_generation"] == scope["generation"]
        && io["holder_generation"] == scope["generation"]
        && claims["database_generation"] == intent["database_generation"]
        && io["database_generation"] == intent["database_generation"]
        && claims["operation_id"] == intent["operation_id"]
        && io["operation_id"] == intent["operation_id"]
        && claims["operation_target_generation"] == intent["operation_target_generation"]
        && claims["database_id"] == scope["database_id"]
        && claims["storage"] == scope["storage"]
        && claims["node_uid"] == scope["node_uid"]
        && io["node_uid"] == scope["node_uid"]
        && claims["boot_id"] == scope["boot_id"]
        && holder["holder_boot_id"] == scope["boot_id"]
        && io["boot_id"] == scope["boot_id"]
        && holder["pool_namespace_uid"] == scope["pool_namespace_uid"]
        && holder["pool_pod_uid"] == scope["pool_pod_uid"]
        && holder["container_ids"] == scope["container_ids"]
        && io["worker"]["container_id"] == scope["container_id"]
        && io["worker"]["pool_pod_uid"] == scope["pool_pod_uid"]
        && io["worker"]["executable_sha256"] == scope["host_controller_sha256"]
        && io["device"]["volume_group_uuid"] == scope["storage"]["volume_group_uuid"]
        && io["device"]["lv_uuid"] == scope["storage"]["lv_uuid"]
        && io["device"]["thin_id"] == scope["storage"]["thin_id"]
        && holder["device"] == io["device"]
        && claims["device_major"] == io["device"]["device_major"]
        && claims["device_minor"] == io["device"]["device_minor"]
        && claims["write_bytes_per_second"] == io["worker"]["write_bytes_per_second"]
        && claims["write_iops_per_second"] == io["worker"]["write_iops_per_second"]
        && claims["cleanup_mode"] == "drain_unmount"
}
impl Permission {
    pub fn new(
        scope: &Value,
        holder: &Value,
        io: &Value,
        local: &Cloudflare,
    ) -> Result<Self, Status> {
        let received = Instant::now();
        let at = now();
        let config = local.storage_authority.as_ref().ok_or_else(refused)?;
        let token = text(holder, "cleanup_authority")?;
        let claims = pool::verify_cleanup_authority(token, &pool_permission::keys(config)?, at)
            .ok_or_else(refused)?;
        if !matches(scope, holder, io, &claims)
            || scope["node_uid"] != local.node_uid
            || scope["node_id"] != local.node_id
            || scope["region_id"] != local.region_id
            || claims["boot_id"] != crate::storage::current_boot_id()?
        {
            return Err(refused());
        }
        let remaining = Duration::from_millis(
            claims["exp"]
                .as_u64()
                .ok_or_else(refused)?
                .saturating_sub(at),
        );
        let value = Self {
            claims,
            token: token.to_owned(),
            io: io.clone(),
            received,
            remaining,
        };
        if !value.current() {
            return Err(refused());
        }
        Ok(value)
    }
    pub fn current(&self) -> bool {
        self.received.elapsed() < self.remaining
            && self.claims["exp"].as_u64().is_some_and(|exp| now() < exp)
    }
    pub fn claims(&self) -> &Value {
        &self.claims
    }
    pub fn io(&self) -> &Value {
        &self.io
    }
    pub fn worker_matches(&self, worker: &crate::pool_io::Process, host_pid: u32) -> bool {
        let expected = &self.io["worker"];
        expected["pid"] == host_pid
            && expected["start_ticks"] == worker.start_ticks
            && expected["pid_namespace"] == worker.pid_namespace.inode
            && expected["cgroup_inode"] == worker.cgroup_inode
            && expected["container_id"] == worker.container_id
    }

    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn deadline(&self) -> Instant {
        self.received + self.remaining
    }
    /// Full logical allocation equality is independently measured; IO rates are not an all-BIO bound.
    pub fn device(&self) -> Result<ThinMetadata, Status> {
        let s = &self.claims["storage"];
        let actual = crate::pool_device::thin_metadata(
            text(s, "volume_group_uuid")?,
            text(s, "lv_uuid")?,
            text(s, "volume_handle")?,
            text(&s["profile"], "pool_uuid")?,
        )
        .map_err(|_| refused())?;
        if u64::from(actual.thin_id) != s["thin_id"].as_u64().ok_or_else(refused)?
            || u64::from(libc::major(actual.device))
                != self.claims["device_major"].as_u64().ok_or_else(refused)?
            || u64::from(libc::minor(actual.device))
                != self.claims["device_minor"].as_u64().ok_or_else(refused)?
            || actual.logical_size_bytes
                != self.claims["allocation_reserve_bytes"]
                    .as_u64()
                    .ok_or_else(refused)?
        {
            return Err(refused());
        }
        Ok(actual)
    }
}
/// Signature-checked historical claims are observation evidence only. This never constructs a
/// Permission and cannot reach resume_cleanup, including after its finite deadline has expired.
pub(crate) fn historical(
    scope: &Value,
    holder: &Value,
    io: &Value,
    token: &str,
    local: &Cloudflare,
) -> Result<Value, Status> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    if token.len() > 8192 {
        return Err(refused());
    }
    let body = token.split('.').nth(1).ok_or_else(refused)?;
    let untrusted: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).map_err(|_| refused())?)
            .map_err(|_| refused())?;
    let at = untrusted["iat"].as_u64().ok_or_else(refused)?;
    let keys = pool_permission::keys(local.storage_authority.as_ref().ok_or_else(refused)?)?;
    let claims = pool::verify_cleanup_authority(token, &keys, at).ok_or_else(refused)?;
    if !matches(scope, holder, io, &claims)
        || scope["node_uid"] != local.node_uid
        || claims["boot_id"] != crate::storage::current_boot_id()?
    {
        return Err(refused());
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    use serde_json::json;
    #[test]
    fn expired_signed_cleanup_remains_observation_only_and_cannot_dispatch_again() {
        let vector = |name| {
            pool::CONTRACT["vectors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == name)
                .unwrap()["value"]
                .clone()
        };
        let mut scope = vector("thin-scope");
        scope["boot_id"] = crate::storage::current_boot_id().unwrap().into();
        let hash = pool::scope_hash(&scope).unwrap();
        let at = now();
        let profile = &scope["storage"]["profile"];
        let destruction = &vector("same-boot-reference-destruction")["reference_destruction"];
        let mut worker = destruction["worker"].clone();
        worker["executable_sha256"] = scope["host_controller_sha256"].clone();
        worker["write_bytes_per_second"] = profile["write_bytes_per_second"].clone();
        worker["write_iops_per_second"] = profile["write_iops_per_second"].clone();
        let device = json!({"volume_group_uuid":scope["storage"]["volume_group_uuid"],"lv_uuid":scope["storage"]["lv_uuid"],"thin_id":scope["storage"]["thin_id"],"device_major":worker["device_major"],"device_minor":worker["device_minor"]});
        let operation = destruction["operation_id"].clone();
        let io = json!({"v":1,"binding_id":scope["binding_id"],"scope_sha256":hash,"holder_revision":1,"operation_id":operation,
            "holder_generation":scope["generation"],"database_generation":scope["generation"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"observed_at":at,
            "device":device,"worker":worker,"shared_pod_io":{"pod_cgroup_inode":1,"device_major":worker["device_major"],"device_minor":worker["device_minor"],
                "write_bytes_per_second":profile["write_bytes_per_second"],"write_iops_per_second":profile["write_iops_per_second"],"io_max_verified":true,"all_writer_cgroups_descendants":true},
            "stopped_writers":destruction["stopped_writers"],"cleanup_worker_only_verified":true});
        assert!(pool::validate("PoolCleanupIoAttestation", &io));
        let claims = json!({"v":1,"kid":"cf","binding_id":scope["binding_id"],"scope_sha256":hash,"holder_revision":1,"operation_id":operation,
            "cleanup_io_sha256":pool::cleanup_io_hash(&io).unwrap(),"holder_generation":scope["generation"],"database_generation":scope["generation"],"operation_target_generation":scope["generation"],
            "authority_revision":1,"database_id":scope["database_id"],"node_uid":scope["node_uid"],"boot_id":scope["boot_id"],"storage":scope["storage"],
            "device_major":worker["device_major"],"device_minor":worker["device_minor"],"allocation_reserve_bytes":33554432,"cleanup_mode":"drain_unmount",
            "write_bytes_per_second":profile["write_bytes_per_second"],"write_iops_per_second":profile["write_iops_per_second"],"iat":at,"exp":at+1000});
        let pair = Ed25519KeyPair::from_pkcs8(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let keys = std::collections::BTreeMap::from([(
            "cf".to_owned(),
            URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        )]);
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signature = pair.sign(
            format!(
                "{}{}",
                pool::constant("cleanup_domain").as_str().unwrap(),
                body
            )
            .as_bytes(),
        );
        let token = format!("pc1.{body}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()));
        let local = Cloudflare {
            api_url: "https://example.invalid".into(),
            agent_key_file: "/never-opened".into(),
            node_id: scope["node_id"].as_str().unwrap().into(),
            node_uid: scope["node_uid"].as_str().unwrap().into(),
            region_id: scope["region_id"].as_str().unwrap().into(),
            material_revision: 1,
            image: String::new(),
            cgroup_root: "/sys/fs/cgroup".into(),
            storage_authority: Some(crate::policy::StorageAuthorityTrust {
                sha256: crate::pool_gate::digest(serde_json::to_string(&keys).unwrap().as_bytes()),
                keys,
                legacy_database_ids: vec![],
            }),
        };
        let holder = json!({"binding_id":scope["binding_id"],"scope_sha256":hash,"holder_revision":1,"holder_generation":scope["generation"],"holder_boot_id":scope["boot_id"],"state":"detaching",
            "pool_namespace_uid":scope["pool_namespace_uid"],"pool_pod_uid":scope["pool_pod_uid"],"container_ids":scope["container_ids"],"device":device,"cleanup_authority":token,
            "cleanup_intent":{"operation_id":operation,"database_generation":scope["generation"],"operation_target_generation":scope["generation"]}});
        let permission = Permission::new(&scope, &holder, &io, &local).unwrap();
        assert!(permission.current());
        std::thread::sleep(Duration::from_millis(1050));
        assert!(!permission.current());
        assert!(Permission::new(&scope, &holder, &io, &local).is_err());
        assert_eq!(
            historical(&scope, &holder, &io, &token, &local).unwrap(),
            claims
        );
        let mut altered = io.clone();
        altered["worker"]["cgroup_inode"] = 9999.into();
        assert!(historical(&scope, &holder, &altered, &token, &local).is_err());
        assert!(
            pool::verify_permission(
                &token,
                &pool_permission::keys(local.storage_authority.as_ref().unwrap()).unwrap(),
                at
            )
            .is_none()
        );
    }
}
