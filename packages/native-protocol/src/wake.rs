// SPDX-License-Identifier: Apache-2.0
//! Pool wake protocol (pool design 2026-10-16). Route token v5 is the Edge's wake ticket for a
//! sleeping database (authoritative TypeScript contract: packages/contracts/src/route-token.ts;
//! tests/conformance.rs pins these constants and this behaviour to it). `gw1` is the scoped token
//! of the controller's wake long-poll on the gateway control port. The wire types are what the
//! gateway queues and the controller answers with.
use crate::{
    constant,
    route::{Connection, Keyring, RouteClaims, decode, derive_region_key},
    valid_pattern, valid_role,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

pub const ROUTE_VERSION: u8 = 5;
pub const ROUTE_PREFIX: &str = "v5";
pub const ROUTE_DOMAIN: &str = "pgcf-route/v5\n";
pub const POLL_PREFIX: &str = "gw1";
pub const POLL_KEY_PURPOSE: &str = "pgcf-gateway-wake-key/v1\n";
pub const POLL_SIGNING_PURPOSE: &str = "pgcf-gateway-wake/v1\n";
pub const POLL_HEADER: &str = "x-pgcf-wake";
pub const POLL_ACTION: &str = "wakes";
pub const RESULT_ACTION: &str = "wake-result";
pub const POLL_PATH: &str = "/_pgcf/gateway/wakes";
pub const RESULT_PATH: &str = "/_pgcf/gateway/wake-result";
pub const POLL_MAX_LENGTH: usize = 1024;
pub const POLL_MAX_LIFETIME_SECONDS: u64 = 30;
pub const RESULT_MAX_BYTES: usize = 4096;
pub const MAX_WAKES_PER_POLL: usize = 64;
/// How long a held wake connection waits for its release, counted from its upgrade. Nested under
/// the Edge's ADMISSION_DEADLINE_MS (60 s).
pub const WAKE_BOUND_MS: u64 = 25_000;
/// How long the gateway holds an empty long-poll before it answers it.
pub const POLL_HOLD_MS: u64 = 20_000;
/// A delivered wake without a result is delivered again after this long.
pub const REDELIVER_MS: u64 = 3_000;
/// How long a released pool hit serves before D1 must confirm its generation.
pub const TICKET_LEASE_MS: u64 = 10_000;
pub const MAX_HELD_PER_DATABASE: usize = 32;
pub const MAX_HELD_TOTAL: usize = 512;
pub const SLOT_NAMESPACE_PREFIX: &str = "pgcf-slot-";
/// Every reason a wake result may name.
pub const REASONS: [&str; 32] = [
    "no_desired_row",
    "not_sleeping",
    "wake_in_progress",
    "desired_stale",
    "no_room",
    "thick_storage",
    "volume_identity_missing",
    "no_power_record",
    "no_sleep_record",
    "image_changed",
    "configuration_changed",
    "no_free_slot",
    "no_headroom",
    "gateways_not_ready",
    "agent_unavailable",
    "holder_busy",
    "volume_open",
    "volume_suspended",
    "volume_missing",
    "uuid_mismatch",
    "unclean",
    "control_version",
    "identity_mismatch",
    "container_missing",
    "mount_failed",
    "audit_failed",
    "bind_failed",
    "start_timeout",
    "sql_identity_mismatch",
    "release_failed",
    "deleted",
    "not_in_region",
];
const MAX_SAFE: u64 = 9_007_199_254_740_991;

/// Route token v5 claims. `v: 5` is the wake flag: a v5 token exists only for a wake ticket.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeClaims {
    pub v: u8,
    pub db: String,
    pub user: String,
    pub cid: String,
    pub rg: String,
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
    /// The wake operation the DatabaseActor allocated or reused.
    pub op: String,
    /// The generation the wake claims in D1: the Actor snapshot's generation + 1.
    #[serde(rename = "gen")]
    pub generation: u64,
    /// The admission route revision of the Actor snapshot.
    pub route_revision: u64,
    /// `role_revision_hash` of the Actor snapshot's roles.
    pub rh: String,
}
/// What a wake ticket adds to a connection's claims.
pub struct Ticket<'a> {
    pub operation: &'a str,
    pub generation: u64,
    pub route_revision: u64,
    pub role_revision_hash: &'a str,
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid_text(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
fn kid(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
fn positive(value: u64) -> bool {
    (1..=MAX_SAFE).contains(&value)
}
pub fn claims_valid(claims: &WakeClaims) -> bool {
    claims.v == ROUTE_VERSION
        && valid_pattern("database", &claims.db)
        && valid_role(&claims.user)
        && uuid_text(&claims.cid)
        && valid_pattern("region", &claims.rg)
        && kid(&claims.kid)
        && claims.iat <= MAX_SAFE
        && claims.exp <= MAX_SAFE
        && valid_pattern("operation", &claims.op)
        && positive(claims.generation)
        && positive(claims.route_revision)
        && lower_hex(&claims.rh, 64)
}
/// Signs a v5 route with the master keyring's active key, derived for the connection's region.
pub fn sign_wake(
    master: &Keyring,
    connection: &Connection,
    ticket: &Ticket,
) -> Result<String, &'static str> {
    if connection.ttl_seconds == 0
        || connection.ttl_seconds > constant("ROUTE_TOKEN_SIGN_TTL_SECONDS")
    {
        return Err("invalid lifetime");
    }
    let iat = connection.now_ms / 1000;
    let claims = WakeClaims {
        v: ROUTE_VERSION,
        db: connection.database.into(),
        user: connection.user.into(),
        cid: connection.cid.into(),
        rg: connection.region.into(),
        kid: master.active.clone(),
        iat,
        exp: iat
            .checked_add(connection.ttl_seconds)
            .ok_or("invalid claims")?,
        op: ticket.operation.into(),
        generation: ticket.generation,
        route_revision: ticket.route_revision,
        rh: ticket.role_revision_hash.into(),
    };
    if !claims_valid(&claims) {
        return Err("invalid claims");
    }
    let key = master
        .keys
        .get(&master.active)
        .ok_or("active key missing")?;
    let derived = derive_region_key(key, connection.region)?;
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| "invalid claims")?);
    let mut mac = Hmac::<Sha256>::new_from_slice(&derived).map_err(|_| "invalid key")?;
    mac.update(ROUTE_DOMAIN.as_bytes());
    mac.update(payload.as_bytes());
    Ok(format!(
        "{ROUTE_PREFIX}.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
/// Verifies a v5 route with the gateway's region-derived keys. Failure codes and their order are
/// the TypeScript verifier's.
pub fn verify_wake(
    token: Option<&str>,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    now_ms: u64,
) -> Result<WakeClaims, &'static str> {
    let token = token.filter(|v| !v.is_empty()).ok_or("missing")?;
    if token.len() > constant("ROUTE_TOKEN_ADMISSION_MAX_LENGTH") as usize {
        return Err("too_long");
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != ROUTE_PREFIX {
        return Err("malformed");
    }
    let payload = decode(parts[1])
        .filter(|v| !v.is_empty())
        .ok_or("malformed")?;
    let signature = decode(parts[2])
        .filter(|v| v.len() == constant("ROUTE_TOKEN_SIGNATURE_BYTES") as usize)
        .ok_or("malformed")?;
    let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|_| "malformed")?;
    let key_id = value
        .get("kid")
        .and_then(serde_json::Value::as_str)
        .ok_or("malformed")?;
    let key = keys
        .get(key_id)
        .filter(|v| v.len() >= constant("ROUTE_KEY_MIN_BYTES") as usize)
        .ok_or("unknown_kid")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "unknown_kid")?;
    mac.update(ROUTE_DOMAIN.as_bytes());
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&signature).map_err(|_| "bad_signature")?;
    let claims: WakeClaims = serde_json::from_value(value).map_err(|_| "invalid_claims")?;
    if !claims_valid(&claims) {
        return Err("invalid_claims");
    }
    if claims.rg != region {
        return Err("wrong_region");
    }
    if claims.exp <= claims.iat
        || claims.exp - claims.iat > constant("ROUTE_TOKEN_MAX_LIFETIME_SECONDS")
    {
        return Err("invalid_lifetime");
    }
    let skew = constant("ROUTE_TOKEN_SKEW_SECONDS") * 1000;
    if claims.iat * 1000 > now_ms + skew {
        return Err("not_yet_valid");
    }
    if now_ms > claims.exp * 1000 + skew {
        return Err("expired");
    }
    Ok(claims)
}
impl WakeClaims {
    /// The v4-shaped claims a released wake is routed under: the same connection, the claimed
    /// generation as `rev`, the admitted Pod and the route revision. `pod` is `None` only for the
    /// replay check before release.
    pub fn admitted(&self, pod: Option<&str>) -> RouteClaims {
        RouteClaims {
            v: 4,
            db: self.db.clone(),
            user: self.user.clone(),
            cid: self.cid.clone(),
            rg: self.rg.clone(),
            kid: self.kid.clone(),
            iat: self.iat,
            exp: self.exp,
            rev: Some(self.generation),
            pod: pod.map(str::to_string),
            route_revision: Some(self.route_revision),
        }
    }
}
/// SHA-256 (lowercase hex) of the sorted lines `"<name>\t<revision>\n"`, one per live role.
pub fn role_revision_hash<'a>(roles: impl IntoIterator<Item = (&'a str, u64)>) -> String {
    let mut lines: Vec<String> = roles
        .into_iter()
        .map(|(name, revision)| format!("{name}\t{revision}\n"))
        .collect();
    lines.sort();
    hex(&Sha256::digest(lines.concat().as_bytes()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PollClaims {
    pub v: u8,
    pub region: String,
    /// The gateway Pod UID the token is for.
    pub pod: String,
    pub action: String,
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
}
fn poll_claims_valid(claims: &PollClaims) -> bool {
    claims.v == 1
        && valid_pattern("region", &claims.region)
        && valid_pattern("uuid", &claims.pod)
        && (claims.action == POLL_ACTION || claims.action == RESULT_ACTION)
        && kid(&claims.kid)
        && claims.iat <= MAX_SAFE
        && claims.exp <= MAX_SAFE
}
fn poll_mac(key: &[u8]) -> Option<Hmac<Sha256>> {
    let mut inner = Hmac::<Sha256>::new_from_slice(key).ok()?;
    inner.update(POLL_KEY_PURPOSE.as_bytes());
    let derived = inner.finalize().into_bytes();
    let mut mac = Hmac::<Sha256>::new_from_slice(&derived).ok()?;
    mac.update(POLL_SIGNING_PURPOSE.as_bytes());
    Some(mac)
}
/// Verifies a `gw1` token for this gateway Pod, region and action.
pub fn verify_poll(
    token: Option<&str>,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    pod: &str,
    action: &str,
    now_ms: u64,
) -> Option<PollClaims> {
    let token = token?;
    if token.len() > POLL_MAX_LENGTH {
        return None;
    }
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != POLL_PREFIX {
        return None;
    }
    let payload = decode(parts[1])?;
    let signature = decode(parts[2]).filter(|v| v.len() == 32)?;
    let claims: PollClaims = serde_json::from_slice(&payload).ok()?;
    if !poll_claims_valid(&claims) {
        return None;
    }
    let key = keys
        .get(&claims.kid)
        .filter(|k| k.len() >= constant("ROUTE_KEY_MIN_BYTES") as usize)?;
    let mut mac = poll_mac(key)?;
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&signature).ok()?;
    if claims.exp <= claims.iat
        || claims.exp - claims.iat > POLL_MAX_LIFETIME_SECONDS
        || now_ms < claims.iat * 1000
        || now_ms > claims.exp * 1000
        || claims.region != region
        || claims.pod != pod
        || claims.action != action
    {
        return None;
    }
    Some(claims)
}

/// One queued wake, as the gateway hands it to the controller's long-poll.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeRequest {
    pub database: String,
    pub operation: String,
    pub generation: u64,
    pub route_revision: u64,
    pub role_revision_hash: String,
    /// Gateway wall clock (ms) when the first connection of this wake was queued.
    pub queued_at_ms: u64,
}
impl WakeRequest {
    pub fn of(claims: &WakeClaims, queued_at_ms: u64) -> Self {
        Self {
            database: claims.db.clone(),
            operation: claims.op.clone(),
            generation: claims.generation,
            route_revision: claims.route_revision,
            role_revision_hash: claims.rh.clone(),
            queued_at_ms,
        }
    }
    pub fn valid(&self) -> bool {
        valid_pattern("database", &self.database)
            && valid_pattern("operation", &self.operation)
            && positive(self.generation)
            && positive(self.route_revision)
            && lower_hex(&self.role_revision_hash, 64)
            && self.queued_at_ms <= MAX_SAFE
    }
}
/// The answer to `POST /_pgcf/gateway/wakes`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakePoll {
    pub pod: String,
    pub wakes: Vec<WakeRequest>,
}
impl WakePoll {
    pub fn valid(&self) -> bool {
        valid_pattern("uuid", &self.pod)
            && self.wakes.len() <= MAX_WAKES_PER_POLL
            && self.wakes.iter().all(WakeRequest::valid)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Hit,
    Miss,
    Refused,
}
/// The body of `POST /_pgcf/gateway/wake-result`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeResult {
    pub database: String,
    pub operation: String,
    pub generation: u64,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub steps_ms: BTreeMap<String, u64>,
}
impl WakeResult {
    pub fn valid(&self) -> bool {
        valid_pattern("database", &self.database)
            && valid_pattern("operation", &self.operation)
            && positive(self.generation)
            && match (&self.outcome, &self.reason) {
                (Outcome::Hit, None) => true,
                (Outcome::Miss | Outcome::Refused, Some(reason)) => {
                    REASONS.contains(&reason.as_str())
                }
                _ => false,
            }
            && self.steps_ms.len() <= 16
            && self.steps_ms.iter().all(|(key, value)| {
                !key.is_empty()
                    && key.len() <= 32
                    && key.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    && *value <= 600_000
            })
    }
}
/// Whether `value` is a slot namespace: `pgcf-slot-` and 8 lowercase hex digits.
pub fn is_slot_namespace(value: &str) -> bool {
    value
        .strip_prefix(SLOT_NAMESPACE_PREFIX)
        .is_some_and(|rest| lower_hex(rest, 8))
}
/// The TLS name CNPG gives the read-write service of a slot's Cluster `database`.
pub fn slot_tls_name(namespace: &str) -> String {
    format!("database-rw.{namespace}.svc")
}
/// The slot namespace a slot TLS name names; `None` for any other name.
pub fn slot_namespace_of_tls_name(name: &str) -> Option<&str> {
    let namespace = name.strip_prefix("database-rw.")?.strip_suffix(".svc")?;
    is_slot_namespace(namespace).then_some(namespace)
}
