// SPDX-License-Identifier: Apache-2.0
//! CF mount permission is distinct from sa1 writes and pc1 cleanup. Disk history never renews it.
use crate::policy::{Cloudflare, StorageAuthorityTrust};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::{pool, storage::StorageTrust};
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use tonic::Status;
fn refused() -> Status {
    Status::failed_precondition("pool_bind_permission_unconfirmed")
}
pub fn keys(config: &StorageAuthorityTrust) -> Result<HashMap<String, Vec<u8>>, Status> {
    StorageTrust::parse(
        &serde_json::to_string(&config.keys).map_err(|_| refused())?,
        &config.sha256,
    )
    .map_err(|_| refused())?;
    config
        .keys
        .iter()
        .map(|(kid, encoded)| {
            let key = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| refused())?;
            if key.len() != 32 || URL_SAFE_NO_PAD.encode(&key) != *encoded {
                return Err(refused());
            }
            Ok((kid.clone(), key))
        })
        .collect()
}
pub struct Permission {
    claims: Value,
    token: String,
    received: Instant,
    remaining: Duration,
}
impl Permission {
    pub fn new(
        desired: &Value,
        local: &Cloudflare,
        anchors: &HashMap<String, Vec<u8>>,
    ) -> Result<Self, Status> {
        let received = Instant::now();
        let now = u64::try_from(crate::policy::now_ms()).map_err(|_| refused())?;
        if !pool::validate("DesiredPoolBinding", desired)
            || !pool::binding_valid(&desired["binding"])
            || desired["authority"] != "current"
            || !matches!(
                desired["binding"]["state"].as_str(),
                Some("claimed" | "mounted" | "serving")
            )
        {
            return Err(refused());
        }
        let token = desired["permission"].as_str().ok_or_else(refused)?;
        let claims = pool::verify_permission(token, anchors, now).ok_or_else(refused)?;
        let binding = &desired["binding"];
        let scope = &binding["scope"];
        if claims["scope"] != *scope
            || claims["scope_sha256"] != binding["scope_sha256"]
            || claims["holder_revision"] != binding["holder_revision"]
            || scope["node_id"] != local.node_id
            || scope["node_uid"] != local.node_uid
            || scope["region_id"] != local.region_id
            || scope["boot_id"] != crate::storage::current_boot_id()?
            || scope["storage"]["backend"] != "lvm-thin-v1"
        {
            return Err(refused());
        }
        let remaining = Duration::from_millis(
            claims["exp"]
                .as_u64()
                .ok_or_else(refused)?
                .saturating_sub(now),
        );
        let permission = Self {
            claims,
            token: token.to_owned(),
            received,
            remaining,
        };
        if !permission.current() {
            return Err(refused());
        }
        Ok(permission)
    }
    pub fn current(&self) -> bool {
        self.received.elapsed() < self.remaining
            && u64::try_from(crate::policy::now_ms())
                .is_ok_and(|now| self.claims["exp"].as_u64().is_some_and(|exp| now < exp))
    }
    pub fn scope(&self) -> &Value {
        &self.claims["scope"]
    }
    pub fn scope_sha256(&self) -> &str {
        self.claims["scope_sha256"]
            .as_str()
            .expect("verifiedscopehash")
    }
    pub fn holder_revision(&self) -> u64 {
        self.claims["holder_revision"]
            .as_u64()
            .expect("verifiedholderrevision")
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn deadline(&self) -> Instant {
        self.received + self.remaining
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };
    #[test]
    fn real_signature_binds_current_holder_region_boot_and_finite_mount_clock() {
        let pair = Ed25519KeyPair::from_pkcs8(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref(),
        )
        .unwrap();
        let anchors = HashMap::from([("cf".to_owned(), pair.public_key().as_ref().to_vec())]);
        let mut scope = pool::CONTRACT["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "thin-scope")
            .unwrap()["value"]
            .clone();
        scope["boot_id"] = crate::storage::current_boot_id().unwrap().into();
        let now = u64::try_from(crate::policy::now_ms()).unwrap();
        let hash = pool::scope_hash(&scope).unwrap();
        let claims = serde_json::json!({"v":1,"kid":"cf","scope":scope,"scope_sha256":hash,"holder_revision":1,"iat":now,"exp":now+1000});
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signature = pair.sign(
            format!(
                "{}{}",
                pool::constant("bind_domain").as_str().unwrap(),
                encoded
            )
            .as_bytes(),
        );
        let token = format!(
            "pb1.{encoded}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        );
        let mut desired = serde_json::json!({"binding":{"v":1,"scope":claims["scope"],"scope_sha256":hash,"holder_revision":1,"state":"claimed","created_at":now,"updated_at":now},"authority":"current","storage_authority":null,"permission":token});
        let mut local = Cloudflare {
            api_url: "https://example.invalid".to_owned(),
            agent_key_file: "/never-opened".into(),
            node_id: scope["node_id"].as_str().unwrap().to_owned(),
            node_uid: scope["node_uid"].as_str().unwrap().to_owned(),
            region_id: scope["region_id"].as_str().unwrap().to_owned(),
            material_revision: 1,
            image: String::new(),
            cgroup_root: "/sys/fs/cgroup".into(),
            storage_authority: None,
        };
        let permission = Permission::new(&desired, &local, &anchors).unwrap();
        assert!(permission.current());
        desired["binding"]["holder_revision"] = 2.into();
        assert!(Permission::new(&desired, &local, &anchors).is_err());
        desired["binding"]["holder_revision"] = 1.into();
        desired["authority"] = "revoked".into();
        assert!(Permission::new(&desired, &local, &anchors).is_err());
        desired["authority"] = "current".into();
        local.region_id = "elsewhere".to_owned();
        assert!(Permission::new(&desired, &local, &anchors).is_err());
        local.region_id = scope["region_id"].as_str().unwrap().to_owned();
        std::thread::sleep(Duration::from_millis(1050));
        assert!(!permission.current());
        assert!(Permission::new(&desired, &local, &anchors).is_err());
    }
}
