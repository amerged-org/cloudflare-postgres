// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use regex::Regex;
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{ED25519, UnparsedPublicKey},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    net::IpAddr,
    sync::LazyLock,
};
pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/bootstrap.generated.json"
    ))
    .expect("generated bootstrap contract")
});
pub fn limit(name: &str) -> u64 {
    CONTRACT["limits"][name]
        .as_u64()
        .expect("generated bootstrap bound")
}
pub fn wire(name: &str) -> &'static str {
    CONTRACT["wire"][name]
        .as_str()
        .expect("generated bootstrap wire field")
}
fn invalid() -> Error {
    "bootstrap_relay_configuration_invalid".into()
}
static PATTERNS: LazyLock<HashMap<&'static str, Regex>> = LazyLock::new(|| {
    let mut values = HashMap::new();
    for name in ["region", "node", "operation"] {
        values.insert(
            name,
            Regex::new(CONTRACT["patterns"][name].as_str().unwrap()).unwrap(),
        );
    }
    for (name, field) in [("uuid", "relay_epoch"), ("nonce", "nonce"), ("kid", "kid")] {
        values.insert(
            name,
            Regex::new(
                CONTRACT["schemas"]["claims"]["properties"][field]["pattern"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
    }
    values
});
fn matches(name: &str, value: &str) -> bool {
    PATTERNS
        .get(name)
        .expect("generated bootstrap pattern")
        .is_match(value)
}
fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = URL_SAFE_NO_PAD.decode(text).ok()?;
    (URL_SAFE_NO_PAD.encode(&bytes) == text).then_some(bytes)
}
#[derive(Clone)]
pub struct VerificationKeys(BTreeMap<String, Vec<u8>>);
impl VerificationKeys {
    pub fn parse(raw: &str) -> Result<Self, Error> {
        if raw.len() > 2048 {
            return Err(invalid());
        }
        let values: BTreeMap<String, String> = serde_json::from_str(raw).map_err(|_| invalid())?;
        if values.is_empty() || values.len() > 8 {
            return Err(invalid());
        }
        let mut keys = BTreeMap::new();
        for (name, text) in values {
            if !matches("kid", &name) {
                return Err(invalid());
            }
            let bytes = decode(&text)
                .filter(|v| v.len() == 32)
                .ok_or_else(invalid)?;
            keys.insert(name, bytes);
        }
        Ok(Self(keys))
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Identity {
    pub v: u8,
    pub region: String,
    pub issuer_region: String,
    pub relay_epoch: String,
    pub allowed_target_regions: Vec<String>,
    pub capabilities: Vec<String>,
}
#[derive(Clone)]
pub struct Configuration {
    pub region: String,
    pub issuer_region: String,
    pub allowed_target_regions: Vec<String>,
    pub host: IpAddr,
    pub port: u16,
    pub keys: VerificationKeys,
    pub memory_bytes: usize,
    pub connection_memory_bytes: usize,
    pub connections: usize,
    pub session_ms: u64,
}
impl Configuration {
    pub fn new(
        region: String,
        issuer_region: String,
        allowed_target_regions: Vec<String>,
        host: IpAddr,
        port: u16,
        keys: VerificationKeys,
    ) -> Result<Self, Error> {
        let value = Self {
            region,
            issuer_region,
            allowed_target_regions,
            host,
            port,
            keys,
            memory_bytes: limit("memoryBytes") as usize,
            connection_memory_bytes: limit("connectionMemoryBytes") as usize,
            connections: limit("connections") as usize,
            session_ms: limit("sessionMs"),
        };
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if !matches("region", &self.region)
            || self.issuer_region != self.region
            || self.allowed_target_regions.is_empty()
            || self.allowed_target_regions.len() > 16
            || self
                .allowed_target_regions
                .iter()
                .any(|v| !matches("region", v))
            || self
                .allowed_target_regions
                .iter()
                .collect::<HashSet<_>>()
                .len()
                != self.allowed_target_regions.len()
            || self.memory_bytes < 256 * 1024
            || self.memory_bytes > limit("memoryBytes") as usize
            || self.connection_memory_bytes < 128 * 1024
            || self.connection_memory_bytes > limit("connectionMemoryBytes") as usize
            || self.connection_memory_bytes > self.memory_bytes
            || self.connections == 0
            || self.connections > limit("connections") as usize
            || self.session_ms < 50
            || self.session_ms > limit("sessionMs")
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub fn from_env() -> Result<Self, Error> {
        const NAMES: [&str; 6] = [
            "PGCF_BOOTSTRAP_RELAY_REGION",
            "PGCF_BOOTSTRAP_RELAY_ISSUER_REGION",
            "PGCF_BOOTSTRAP_RELAY_HOST",
            "PGCF_BOOTSTRAP_RELAY_PORT",
            "PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS",
            "PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS",
        ];
        for (name, _) in std::env::vars_os() {
            let name = name.to_string_lossy();
            if name.starts_with("PGCF_BOOTSTRAP_RELAY_") && !NAMES.contains(&name.as_ref()) {
                return Err(invalid());
            }
        }
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.is_empty())
                .ok_or_else(invalid)
        };
        let raw = read(NAMES[3])?;
        let port = raw.parse::<u16>().map_err(|_| invalid())?;
        if port == 0 || port.to_string() != raw {
            return Err(invalid());
        }
        let targets = read(NAMES[5])?;
        if targets.len() > 2048 {
            return Err(invalid());
        }
        let allowed: Vec<String> = serde_json::from_str(&targets).map_err(|_| invalid())?;
        Self::new(
            read(NAMES[0])?,
            read(NAMES[1])?,
            allowed,
            read(NAMES[2])?.parse().map_err(|_| invalid())?,
            port,
            VerificationKeys::parse(&read(NAMES[4])?)?,
        )
    }
    pub fn identity(&self) -> Result<Identity, Error> {
        Ok(Identity {
            v: 1,
            region: self.region.clone(),
            issuer_region: self.issuer_region.clone(),
            relay_epoch: uuid()?,
            allowed_target_regions: self.allowed_target_regions.clone(),
            capabilities: CONTRACT["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect(),
        })
    }
}
pub fn uuid() -> Result<String, Error> {
    let mut bytes = [0; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| invalid())?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let value = bytes.iter().map(|v| format!("{v:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &value[..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..]
    ))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Target {
    pub address: String,
    pub port: u16,
}
// Field order deliberately follows the authoritative Zod parse/JSON.stringify order.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Claims {
    pub v: u8,
    pub region: String,
    pub issuer_region: String,
    pub relay_epoch: String,
    pub purpose: String,
    pub operation: String,
    pub node: String,
    pub revision: u64,
    pub capability: String,
    pub target: Target,
    pub nonce: String,
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
}
pub(crate) fn verify(
    token: Option<&str>,
    config: &Configuration,
    identity: &Identity,
    now: u64,
) -> Option<Claims> {
    let token = token?;
    if token.len() > CONTRACT["maxTokenLength"].as_u64()? as usize || now > 9_007_199_254_740_991 {
        return None;
    }
    let mut parts = token.split('.');
    if parts.next()? != wire("prefix") {
        return None;
    }
    let body = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let bytes = decode(body)?;
    let signature = decode(signature)?;
    if signature.len() != 64 {
        return None;
    }
    let claims: Claims = serde_json::from_slice(&bytes).ok()?;
    if serde_json::to_vec(&claims).ok()? != bytes
        || claims.v != 1
        || claims.purpose
            != CONTRACT["schemas"]["claims"]["properties"]["purpose"]["const"].as_str()?
        || !matches("region", &claims.region)
        || !matches("region", &claims.issuer_region)
        || !matches("uuid", &claims.relay_epoch)
        || !matches("operation", &claims.operation)
        || !matches("node", &claims.node)
        || !matches("nonce", &claims.nonce)
        || !matches("kid", &claims.kid)
        || claims.revision == 0
        || claims.revision > 9_007_199_254_740_991
        || claims.iat > 9_007_199_254_740_991
        || claims.exp > 9_007_199_254_740_991
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > CONTRACT["maxTokenSeconds"].as_u64()?
        || now < claims.iat * 1000
        || now >= claims.exp * 1000
        || claims.issuer_region != identity.region
        || identity.issuer_region != identity.region
        || claims.relay_epoch != identity.relay_epoch
        || !identity.allowed_target_regions.contains(&claims.region)
        || CONTRACT["ports"][&claims.capability].as_u64() != Some(u64::from(claims.target.port))
        || claims.target.address.contains('%')
        || claims.target.address.parse::<IpAddr>().is_err()
    {
        return None;
    }
    let key = config.keys.0.get(&claims.kid)?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(format!("{}{body}", wire("purpose")).as_bytes(), &signature)
        .ok()?;
    Some(claims)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoritative_typescript_bootstrap_scopes_and_canonicality() {
        let values: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/bootstrap-vectors.generated.json"
        ))
        .unwrap();
        let keys = VerificationKeys::parse(&values["public_keys"].to_string()).unwrap();
        let config = Configuration::new(
            "eu-test".into(),
            "eu-test".into(),
            vec!["us-test".into()],
            "127.0.0.1".parse().unwrap(),
            0,
            keys,
        )
        .unwrap();
        let mut identity = config.identity().unwrap();
        identity.relay_epoch = values["identity"]["relay_epoch"].as_str().unwrap().into();
        for value in values["cases"].as_array().unwrap() {
            let checked = verify(
                value["token"].as_str(),
                &config,
                &identity,
                value["now"].as_u64().unwrap(),
            );
            assert_eq!(
                checked.is_some(),
                value["expected"].as_bool().unwrap(),
                "{}",
                value["name"]
            );
            if let Some(claims) = checked {
                assert_eq!(serde_json::to_value(claims).unwrap(), value["claims"]);
            }
        }
    }
}
