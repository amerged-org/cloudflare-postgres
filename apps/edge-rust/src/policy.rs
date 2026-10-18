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
/// Match the existing trusted CF-Connecting-IP policy: IPv4 address or canonical IPv6 /64. A
/// caller without the header arrives through a service binding and is limited under a key of
/// its own; a present but malformed address is refused.
pub fn connection_rate_key(input: Option<&str>) -> Option<String> {
    let Some(text) = input else {
        return Some("binding".into());
    };
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
/// What an admission lets the Edge sign: the route to the unit that serves an awake database
/// (route v6), or the wake ticket of a sleeping one (route v5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signable {
    Awake {
        revision: u64,
        route_revision: u64,
        instance: String,
    },
    Wake {
        operation: String,
        generation: u64,
        route_revision: u64,
        role_revision_hash: String,
    },
}
/// A trusted DatabaseActor admission: the region's gateway, the node whose key signs the route,
/// and what is signed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub region: GatewayRegion,
    pub node: String,
    pub signable: Signable,
}
fn revision(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
}
fn text<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Option<&'a str> {
    object.get(field).and_then(Value::as_str)
}
/// Parses the trusted DatabaseActor admission (`DatabaseWakeAdmission`). Every field the Edge
/// uses is required and validated; fields a newer API adds are ignored, as the TypeScript Edge
/// does, so an API deploy never breaks this Edge, and they gain no authority because only known
/// fields are signed. Exactly one of a target and a wake ticket is present.
pub fn admission(value: &Value) -> Result<Admission, Failure> {
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
            let region: GatewayRegion =
                serde_json::from_value(value.clone()).map_err(|_| Failure::gateway())?;
            if !valid_pattern("region", &region.id)
                || region.gateway_url.encode_utf16().count()
                    > pgcf_native_protocol::CONTRACT["gatewayRegion"]["properties"]["gateway_url"]
                        ["maxLength"]
                        .as_u64()
                        .unwrap() as usize
            {
                return Err(Failure::gateway());
            }
            let node = text(object, "node")
                .filter(|node| valid_pattern("node", node))
                .ok_or_else(Failure::gateway)?;
            let signable = match (object.get("target"), object.get("wake")) {
                (Some(Value::Object(target)), None) => Signable::Awake {
                    revision: revision(target.get("revision")).ok_or_else(Failure::gateway)?,
                    route_revision: revision(target.get("route_revision"))
                        .ok_or_else(Failure::gateway)?,
                    instance: text(target, "instance")
                        .filter(|instance| valid_pattern("uuid", instance))
                        .ok_or_else(Failure::gateway)?
                        .into(),
                },
                (None, Some(Value::Object(wake))) => Signable::Wake {
                    operation: text(wake, "operation")
                        .filter(|operation| valid_pattern("operation", operation))
                        .ok_or_else(Failure::gateway)?
                        .into(),
                    generation: revision(wake.get("generation")).ok_or_else(Failure::gateway)?,
                    route_revision: revision(wake.get("route_revision"))
                        .ok_or_else(Failure::gateway)?,
                    role_revision_hash: text(wake, "role_revision_hash")
                        .filter(|hash| {
                            hash.len() == 64
                                && hash
                                    .bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        })
                        .ok_or_else(Failure::gateway)?
                        .into(),
                },
                _ => return Err(Failure::gateway()),
            };
            Ok(Admission {
                region,
                node: node.into(),
                signable,
            })
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
/// One rate limiter an admission consults: the binding, the key it counts under, and the message
/// of the refusal when it denies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limit {
    pub binding: &'static str,
    pub key: String,
    pub message: &'static str,
}
/// The limiters of one request, in the order their refusals take precedence. `network` is the
/// caller's `connection_rate_key`; `scope` prefixes the keys, so that a kind of request (HTTP
/// queries: `["sql"]`) counts in buckets of its own of the same limiters. A same-account Worker
/// on a service binding has a budget of its own per database and role, and never drains, or is
/// drained by, the public buckets.
pub fn limits(network: &str, hints: &Hints, scope: &[&str]) -> Vec<Limit> {
    let key = |tail: &[&str]| {
        let parts: Vec<&str> = scope.iter().chain(tail).copied().collect();
        serde_json::to_string(&parts).expect("strings serialize")
    };
    let identity = key(&[&hints.database, &hints.user, network]);
    if network == "binding" {
        return vec![Limit {
            binding: "BINDING_CONNECTION_RATE_LIMITER",
            key: identity,
            message: "connection rate limit exceeded",
        }];
    }
    vec![
        Limit {
            binding: "CONNECTION_RATE_LIMITER",
            key: identity,
            message: "connection rate limit exceeded",
        },
        Limit {
            binding: "DATABASE_CONNECTION_RATE_LIMITER",
            key: if scope.is_empty() {
                hints.database.clone()
            } else {
                key(&[&hints.database])
            },
            message: "database connection rate limit exceeded",
        },
    ]
}
/// What the limiters decided, once all of them answered: a limiter that failed refuses the
/// request as unavailable, ahead of one that denied it. `outcomes` is in the order of `limits`.
pub fn limit_failure(limits: &[Limit], outcomes: &[Result<bool, ()>]) -> Option<Failure> {
    if outcomes.iter().any(Result::is_err) {
        return Some(Failure::unavailable());
    }
    limits
        .iter()
        .zip(outcomes)
        .find(|(_, outcome)| matches!(outcome, Ok(false)))
        .map(|(limit, _)| Failure::new("53300", limit.message))
}
/// The error code of a gateway's refusal, `{"error": "<snake_case>"}`; nothing else of its answer
/// is kept, so no free text reaches a log. A body that is not exactly that has no code.
/// `refusalCode` in packages/contracts/src/edge-policy.ts holds this to the same vectors.
pub fn refusal_code(text: &str) -> Option<String> {
    let answer: Value = serde_json::from_str(text).ok()?;
    let code = answer.get("error")?.as_str()?;
    (matches!(code.len(), 1..=64)
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
    .then(|| code.into())
}
/// What the Edge itself spent on a request: all of `duration` but the `waits` that were another's,
/// the client's upload and the gateway's answer. Network transit and the node are not in it.
pub fn edge_share(duration: u64, waits: &[Option<u64>]) -> u64 {
    duration.saturating_sub(waits.iter().flatten().sum())
}
/// Milliseconds of each stage that ran, logged with the request; a stage that did not run is
/// absent.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct Timings {
    /// The limiters, which run in parallel with the Actor's admission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limiters_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admit_ms: Option<u64>,
    /// The route token version signed: v6 for an awake database, v5 for a wake ticket.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_ms: Option<u64>,
    /// The gateway's upgrade of a connection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_connect_ms: Option<u64>,
    /// Reading and understanding the body of an HTTP query: a client that uploads slowly shows
    /// here, not in `edge_ms`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_ms: Option<u64>,
    /// The statements of an HTTP query, counted and never logged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statements: Option<usize>,
    /// The gateway's answer to an HTTP query, from the send to its response head.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_ms: Option<u64>,
    /// The status of a gateway's answer to an HTTP query, or of its refusal of an upgrade.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_status: Option<u16>,
    /// The error code of that refusal (`{"error": …}`), when it sent one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_error: Option<String>,
    /// When the gateway stage began, for the handler to read; never logged.
    #[serde(skip)]
    pub gateway_started: Option<u64>,
}
impl Timings {
    /// An upgrade that the client or the deadline interrupted is still pending when the request
    /// is logged: the wait so far is the gateway's, not the Edge's.
    pub fn settle_gateway(&mut self, finished: u64) {
        if let Some(started) = self.gateway_started {
            self.gateway_connect_ms
                .get_or_insert(finished.saturating_sub(started));
        }
    }
}
/// One request's line in the log: who asked, how long it took, where the time went, and how it
/// ended. Never a password, a statement, a parameter or a token.
pub struct Log<'a> {
    /// `conn_admission` or `sql_admission`.
    pub event: &'static str,
    /// The connection ID the gateway receives in the route token.
    pub cid: &'a str,
    /// The Cloudflare location that admitted the request; none on a service binding.
    pub colo: Option<&'a str>,
    pub hints: Option<&'a Hints>,
    pub region: Option<&'a str>,
    /// From the request's arrival to its answer.
    pub duration_ms: u64,
    /// The part of it that was the Edge's own.
    pub edge_ms: u64,
    /// The database requests this isolate has taken, this one included; 1 is its first.
    pub isolate_requests: u64,
    pub outcome: &'a str,
}
impl Log<'_> {
    pub fn line(&self, timings: &Timings) -> Value {
        let mut line = serde_json::json!({
            "event": self.event,
            "cid": self.cid,
            "colo": self.colo,
            "database_id": self.hints.map(|hints| &hints.database),
            "user": self.hints.map(|hints| &hints.user),
            "region_id": self.region,
            "duration_ms": self.duration_ms,
            "edge_ms": self.edge_ms,
            "isolate_requests": self.isolate_requests,
            "outcome": self.outcome,
        });
        if let (Some(line), Ok(Value::Object(stages))) =
            (line.as_object_mut(), serde_json::to_value(timings))
        {
            line.extend(stages);
        }
        line
    }
}
