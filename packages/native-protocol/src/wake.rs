// SPDX-License-Identifier: Apache-2.0
//! Wake protocol. Route token v5 is the Edge's wake ticket for a sleeping database (authoritative
//! TypeScript contract: packages/contracts/src/route-token.ts; tests/conformance.rs pins these
//! constants and this behaviour to it). The wire types are what the gateway queues for the node
//! agent and what the agent answers with, over its channel (`agent`).
use crate::{
    constant,
    route::{Connection, Keyring, decode, seal},
    valid_pattern, valid_role,
};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

pub const ROUTE_VERSION: u8 = 5;
pub const ROUTE_PREFIX: &str = "v5";
pub const ROUTE_DOMAIN: &str = "pgcf-route/v5\n";
/// The most wakes one delivery to the agent carries.
pub const MAX_WAKES_PER_POLL: usize = 64;
/// How long a held wake connection waits for its release, counted from its upgrade. Nested under
/// the Edge's ADMISSION_DEADLINE_MS (60 s).
pub const WAKE_BOUND_MS: u64 = 25_000;
/// How long one wait of the gateway for deliverable wakes lasts before it begins again.
pub const POLL_HOLD_MS: u64 = 20_000;
/// A delivered wake without a result is delivered again after this long.
pub const REDELIVER_MS: u64 = 3_000;
/// How long a delivered ticket whose connections all left is kept for its late result.
pub const TICKET_LEASE_MS: u64 = 10_000;
pub const MAX_HELD_PER_DATABASE: usize = 32;
pub const MAX_HELD_TOTAL: usize = 512;
/// Every reason the node agent's wake result may name (`WAKE_REASONS` of
/// `packages/contracts/src/node-local.ts`).
pub const REASONS: [&str; 22] = [
    "no_room",
    "no_headroom",
    "deleted",
    "suspended",
    "moving",
    "maintenance",
    "fenced",
    "superseded",
    "unproven",
    "storage_full",
    "desired_stale",
    "wake_in_progress",
    "identity_mismatch",
    "control_version",
    "volume_missing",
    "uuid_mismatch",
    "volume_suspended",
    "volume_open",
    "holder_busy",
    "mount_failed",
    "start_timeout",
    "release_failed",
];
/// The one reason that is not an answer (`WAKE_AGAIN_REASON` of the contract): the agent already
/// serves the wake, so the held connections keep waiting and the ticket is delivered again.
pub const AGAIN_REASON: &str = "wake_in_progress";
/// The one refusal that waiting can undo, and so the only one with a retry hint.
pub const RETRY_REASON: &str = "no_headroom";
/// The longest retry hint, in seconds.
pub const RETRY_AFTER_MAX_SECONDS: u32 = 300;
/// The DETAIL of the 57P03 that answers a refused wake (`ADMISSION_REFUSAL_DETAILS` of the
/// contract): the admission refusals have one, every other reason answers the 57P03 alone.
pub fn refusal_detail(reason: &str) -> Option<&'static str> {
    match reason {
        "no_room" => Some("storage"),
        "no_headroom" => Some("node at awake capacity"),
        _ => None,
    }
}
/// The HINT of that 57P03: `retry after <n> s` for the refusal that carries a retry hint.
pub fn refusal_hint(reason: &str, retry_after_seconds: Option<u32>) -> Option<String> {
    (reason == RETRY_REASON)
        .then_some(retry_after_seconds)
        .flatten()
        .map(|seconds| format!("retry after {seconds} s"))
}
pub(crate) const MAX_SAFE: u64 = 9_007_199_254_740_991;

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
pub(crate) fn lower_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
pub(crate) fn kid(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}
pub(crate) fn positive(value: u64) -> bool {
    (1..=MAX_SAFE).contains(&value)
}
pub fn claims_valid(claims: &WakeClaims) -> bool {
    claims.v == ROUTE_VERSION
        && valid_pattern("database", &claims.db)
        && valid_role(&claims.user)
        && lower_uuid(&claims.cid)
        && valid_pattern("region", &claims.rg)
        && kid(&claims.kid)
        && claims.iat <= MAX_SAFE
        && claims.exp <= MAX_SAFE
        && valid_pattern("operation", &claims.op)
        && positive(claims.generation)
        && positive(claims.route_revision)
        && lower_hex(&claims.rh, 64)
}
/// Signs a v5 route with the master keyring's active key, derived for the connection's node.
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
    if !claims_valid(&claims) || !valid_pattern("node", connection.node) {
        return Err("invalid claims");
    }
    seal(master, connection.node, &claims, ROUTE_PREFIX, ROUTE_DOMAIN)
}
/// Verifies a v5 route with the gateway's node keys. Failure codes and their order are
/// the TypeScript verifier's.
pub fn verify_wake(
    token: Option<&str>,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    now_ms: u64,
) -> Result<WakeClaims, &'static str> {
    let token = token.filter(|v| !v.is_empty()).ok_or("missing")?;
    if token.len() > constant("ROUTE_TOKEN_MAX_LENGTH") as usize {
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
/// SHA-256 (lowercase hex) of the sorted lines `"<name>\t<revision>\n"`, one per live role.
pub fn role_revision_hash<'a>(roles: impl IntoIterator<Item = (&'a str, u64)>) -> String {
    let mut lines: Vec<String> = roles
        .into_iter()
        .map(|(name, revision)| format!("{name}\t{revision}\n"))
        .collect();
    lines.sort();
    hex(&Sha256::digest(lines.concat().as_bytes()))
}

/// One queued wake, as the gateway hands it to the node agent.
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The agent started the database's unit; its table entry releases the held connections.
    Started,
    /// The agent did not start it: the held connections answer 57P03.
    Refused,
}
/// The agent's answer to a wake, with the times of its steps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WakeResult {
    pub database: String,
    pub operation: String,
    pub generation: u64,
    pub outcome: Outcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The HINT of the 57P03, exactly with `no_headroom` (`RETRY_REASON`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub steps_ms: BTreeMap<String, u64>,
}
impl WakeResult {
    /// The agent is still on the wake: the gateway keeps its connections held.
    pub fn again(&self) -> bool {
        self.outcome == Outcome::Refused && self.reason.as_deref() == Some(AGAIN_REASON)
    }
    /// The DETAIL and HINT of the 57P03 that answers the connections held for this refused wake.
    pub fn refusal_fields(&self) -> (Option<&'static str>, Option<String>) {
        match self.reason.as_deref() {
            Some(reason) => (
                refusal_detail(reason),
                refusal_hint(reason, self.retry_after_seconds),
            ),
            None => (None, None),
        }
    }
    /// `started`, or `refused` with a reason of `REASONS`. Exactly the refusal that waiting can
    /// undo carries the retry hint.
    pub fn valid(&self) -> bool {
        valid_pattern("database", &self.database)
            && valid_pattern("operation", &self.operation)
            && positive(self.generation)
            && match (&self.outcome, &self.reason, self.retry_after_seconds) {
                (Outcome::Started, None, None) => true,
                (Outcome::Refused, Some(reason), seconds) if REASONS.contains(&reason.as_str()) => {
                    (reason == RETRY_REASON) == seconds.is_some()
                        && seconds.is_none_or(|s| (1..=RETRY_AFTER_MAX_SECONDS).contains(&s))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn result(outcome: Outcome, reason: Option<&str>, hint: Option<u32>) -> WakeResult {
        WakeResult {
            database: "a".repeat(20),
            operation: format!("op_{}", "b".repeat(20)),
            generation: 3,
            outcome,
            reason: reason.map(String::from),
            retry_after_seconds: hint,
            steps_ms: BTreeMap::new(),
        }
    }

    #[test]
    fn the_agents_answers_are_started_or_refused_and_only_no_headroom_carries_the_hint() {
        let valid = |r: WakeResult| r.valid();
        assert!(valid(result(Outcome::Started, None, None)));
        assert!(!valid(result(Outcome::Started, Some("no_room"), None)));
        assert!(!valid(result(Outcome::Started, None, Some(5))));
        for reason in REASONS {
            let hint = (reason == RETRY_REASON).then_some(5);
            assert!(
                valid(result(Outcome::Refused, Some(reason), hint)),
                "{reason}"
            );
        }
        assert!(!valid(result(Outcome::Refused, Some("no_headroom"), None)));
        assert!(!valid(result(Outcome::Refused, Some("no_room"), Some(5))));
        assert!(!valid(result(
            Outcome::Refused,
            Some("no_headroom"),
            Some(0)
        )));
        assert!(!valid(result(
            Outcome::Refused,
            Some("no_headroom"),
            Some(RETRY_AFTER_MAX_SECONDS + 1)
        )));
        assert!(!valid(result(
            Outcome::Refused,
            Some("a_reason_nobody_named"),
            None
        )));
        assert!(!valid(result(Outcome::Refused, None, None)));
        // The Kubernetes pool's reasons are gone.
        assert!(!valid(result(Outcome::Refused, Some("no_free_slot"), None)));
    }
}
