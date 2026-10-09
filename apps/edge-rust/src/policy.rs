// SPDX-License-Identifier: Apache-2.0
//! Pure admission policy shared by native conformance tests and the actual Wasm Worker.
use pgcf_native_protocol::{valid_pattern, valid_role};
use serde::{Deserialize, Serialize};
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
#[serde(deny_unknown_fields)]
pub struct GatewayRegion {
    pub id: String,
    pub gateway_url: String,
    pub gateway_binding: Option<String>,
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
