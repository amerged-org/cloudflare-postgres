// SPDX-License-Identifier: Apache-2.0
//! Pure admission policy shared by native conformance tests and the actual Wasm Worker.
use pgcf_native_protocol::{valid_pattern, valid_role};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Failure {
    pub sqlstate: String,
    pub message: String,
    pub decoy: bool,
}
impl Failure {
    pub fn new(sqlstate: &str, message: &str) -> Self {
        Self {
            sqlstate: sqlstate.into(),
            message: message.into(),
            decoy: false,
        }
    }
    pub fn interrupted() -> Self {
        Self::new("08006", "connection admission interrupted")
    }
    pub fn gateway() -> Self {
        Self::new("08006", "gateway connection failed")
    }
    pub fn unavailable() -> Self {
        Self::new("53300", "connection admission unavailable")
    }
    pub fn rate() -> Self {
        Self::new("53300", "connection rate limit exceeded")
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hints {
    pub database: String,
    pub user: String,
}
pub fn routing_hints(query: &str) -> Result<Hints, Failure> {
    let pairs: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
    let databases: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "database")
        .map(|(_, value)| value.as_ref())
        .collect();
    let users: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "user")
        .map(|(_, value)| value.as_ref())
        .collect();
    if databases.len() > 1 || users.len() > 1 {
        return Err(Failure::new("08P01", "duplicate connection admission hint"));
    }
    if databases.len() != 1 || !valid_pattern("database", databases[0]) {
        return Err(Failure::new("3D000", "database does not exist"));
    }
    if users.len() != 1 || !valid_role(users[0]) {
        return Err(Failure::new("28P01", "authentication failed"));
    }
    Ok(Hints {
        database: databases[0].into(),
        user: users[0].into(),
    })
}
/// Match the existing trusted CF-Connecting-IP policy: IPv4 address or canonical IPv6 /64.
pub fn connection_rate_key(input: Option<&str>) -> Option<String> {
    let text = input?;
    if text.len() < 2 || text.len() > 45 {
        return None;
    }
    if !text.contains(':') {
        let address = Ipv4Addr::from_str(text).ok()?;
        return Some(format!("ipv4:{address}"));
    }
    if !text
        .bytes()
        .all(|v| v.is_ascii_hexdigit() || matches!(v, b':' | b'.'))
    {
        return None;
    }
    let address = Ipv6Addr::from_str(text).ok()?;
    let parts = address.segments();
    Some(format!(
        "ipv6:{:04x}:{:04x}:{:04x}:{:04x}/64",
        parts[0], parts[1], parts[2], parts[3]
    ))
}
pub fn actor_failure(sqlstate: &str) -> Failure {
    match sqlstate {
        "3D000" | "28P01" => Failure {
            sqlstate: "28P01".into(),
            message: "password authentication failed".into(),
            decoy: true,
        },
        "57P03" => Failure::new("57P03", "database is not accepting connections"),
        "53300" => Failure::new("53300", "database connection rate limit exceeded"),
        _ => Failure::gateway(),
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GatewayRegion {
    pub id: String,
    pub gateway_url: String,
    pub gateway_binding: Option<String>,
}
/// The verified connection target an admission names: route revision and primary Pod UID.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct AdmittedTarget {
    pub revision: u64,
    pub pod_uid: String,
    #[serde(default)]
    pub route_revision: Option<u64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub binding_id: Option<String>,
    #[serde(default)]
    pub node_uid: Option<String>,
    #[serde(default)]
    pub pod_ip: Option<String>,
    #[serde(default)]
    pub storage_generation: Option<u64>,
    #[serde(default)]
    pub scope_sha256: Option<String>,
}
impl AdmittedTarget {
    pub fn pool(&self) -> Option<pgcf_native_protocol::route::PoolRouteTarget<'_>> {
        if self.kind.as_deref() != Some("pool") {
            return None;
        }
        Some(pgcf_native_protocol::route::PoolRouteTarget {
            binding_id: self.binding_id.as_deref()?,
            node_uid: self.node_uid.as_deref()?,
            pod_ip: self.pod_ip.as_deref()?,
            storage_generation: self.storage_generation?,
            scope_sha256: self.scope_sha256.as_deref()?,
        })
    }
}
/// Parses the trusted DatabaseActor admission. Every field the Edge uses is required and
/// validated; fields a newer API adds are ignored, as the TypeScript Edge does, so an API
/// deploy never breaks this Edge, and they gain no authority because only known fields are
/// signed. Temporary rollout compatibility (route-token.ts): the verified target may be
/// absent; a present target must be complete and well formed.
pub fn admission(value: &Value) -> Result<(GatewayRegion, Option<AdmittedTarget>), Failure> {
    let object = value.as_object().ok_or_else(Failure::gateway)?;
    match object.get("ok").and_then(Value::as_bool) {
        Some(false) => Err(actor_failure(
            object
                .get("sqlstate")
                .and_then(Value::as_str)
                .ok_or_else(Failure::gateway)?,
        )),
        Some(true) => {
            let value = object.get("region").ok_or_else(Failure::gateway)?;
            if value.get("gateway_binding").is_none() {
                return Err(Failure::gateway());
            }
            let route: GatewayRegion =
                serde_json::from_value(value.clone()).map_err(|_| Failure::gateway())?;
            if !valid_pattern("region", &route.id)
                || route.gateway_url.encode_utf16().count()
                    > pgcf_native_protocol::CONTRACT["gatewayRegion"]["properties"]["gateway_url"]
                        ["maxLength"]
                        .as_u64()
                        .unwrap() as usize
            {
                return Err(Failure::gateway());
            }
            let target = object
                .get("target")
                .map(|value| {
                    let mut target: AdmittedTarget =
                        serde_json::from_value(value.clone()).map_err(|_| Failure::gateway())?;
                    if target.revision == 0
                        || (value.get("route_revision").is_some()
                            && target.route_revision.is_none())
                        || target.revision > 9_007_199_254_740_991
                        || target.route_revision.is_some_and(|revision| {
                            revision == 0 || revision > 9_007_199_254_740_991
                        })
                        || !valid_pattern("uuid", &target.pod_uid)
                    {
                        return Err(Failure::gateway());
                    }
                    let has_pool_fields = ["kind", "binding_id", "scope_sha256"]
                        .iter()
                        .any(|key| value.get(*key).is_some());
                    if has_pool_fields {
                        let pool = target.pool().ok_or_else(Failure::gateway)?;
                        if target.route_revision.is_none()
                            || !valid_pattern("uuid", pool.binding_id)
                            || !valid_pattern("uuid", pool.node_uid)
                            || pool.pod_ip.parse::<std::net::IpAddr>().is_err()
                            || pool.storage_generation == 0
                            || pool.storage_generation > 9_007_199_254_740_991
                            || pool.scope_sha256.len() != 64
                            || !pool
                                .scope_sha256
                                .bytes()
                                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
                        {
                            return Err(Failure::gateway());
                        }
                    } else {
                        target.node_uid = None;
                        target.pod_ip = None;
                        target.storage_generation = None;
                    }
                    Ok(target)
                })
                .transpose()?;
            Ok((route, target))
        }
        _ => Err(Failure::gateway()),
    }
}
impl GatewayRegion {
    pub fn transport_url(&self) -> Result<url::Url, Failure> {
        let url = url::Url::parse(&self.gateway_url).map_err(|_| Failure::gateway())?;
        if !matches!(url.scheme(), "http" | "https")
            || (self.gateway_binding.is_none() && url.scheme() != "https")
            || !url.username().is_empty()
            || url.password().is_some_and(|value| !value.is_empty())
        {
            return Err(Failure::gateway());
        }
        Ok(url)
    }
}
