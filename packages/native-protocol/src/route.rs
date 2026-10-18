// SPDX-License-Identifier: Apache-2.0
//! Edge-to-gateway route tokens (authoritative TypeScript contract:
//! packages/contracts/src/route-token.ts; tests/conformance.rs holds this code to its vectors).
//!
//! A route is signed for one node with a key derived for that node, so the gateway of a node can
//! verify only the tokens made for it. Route v6 is the route to an awake database: the
//! generation the node runs, the admission route revision, the node and the invocation ID of the
//! PostgreSQL unit that serves the database. The wake ticket of a sleeping database is route v5
//! (`wake`).
use crate::{
    constant, valid_pattern, valid_role,
    wake::{MAX_SAFE, kid, lower_uuid, positive},
    wire,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;

/// Route token v6 claims.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RouteClaims {
    pub v: u8,
    pub db: String,
    pub user: String,
    pub cid: String,
    pub rg: String,
    pub kid: String,
    pub iat: u64,
    pub exp: u64,
    /// The generation the node runs.
    pub rev: u64,
    /// The admission route revision.
    pub route_revision: u64,
    /// The node the database runs on; only its gateway verifies the route.
    pub node: String,
    /// The invocation ID of the unit that serves the database.
    pub inst: String,
}
impl RouteClaims {
    fn valid(&self) -> bool {
        self.v == wire_version()
            && valid_pattern("database", &self.db)
            && valid_role(&self.user)
            && lower_uuid(&self.cid)
            && valid_pattern("region", &self.rg)
            && kid(&self.kid)
            && self.iat <= MAX_SAFE
            && self.exp <= MAX_SAFE
            && positive(self.rev)
            && positive(self.route_revision)
            && valid_pattern("node", &self.node)
            && lower_uuid(&self.inst)
    }
}
fn wire_version() -> u8 {
    crate::CONTRACT["nodeRouteClaims"]["properties"]["v"]["const"]
        .as_u64()
        .expect("generated route version") as u8
}

/// The route a connection is admitted under, once the gateway has checked it: from a v6 route, or
/// from a v5 wake ticket whose wake the agent released (`Route::released`). Both end in the same
/// checks against the agent's table, and in the same session and replay accounting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub db: String,
    pub user: String,
    pub cid: String,
    pub exp: u64,
    /// The generation the unit runs.
    pub generation: u64,
    pub route_revision: u64,
    /// The invocation ID of the unit.
    pub instance: String,
}
impl From<&RouteClaims> for Route {
    fn from(claims: &RouteClaims) -> Self {
        Self {
            db: claims.db.clone(),
            user: claims.user.clone(),
            cid: claims.cid.clone(),
            exp: claims.exp,
            generation: claims.rev,
            route_revision: claims.route_revision,
            instance: claims.inst.clone(),
        }
    }
}

impl Route {
    /// The route of a wake ticket the agent released: the ticket's connection at its generation,
    /// on the unit the agent started, under the route revision that released it.
    pub fn released(ticket: &crate::wake::WakeClaims, instance: &str, route_revision: u64) -> Self {
        Self {
            db: ticket.db.clone(),
            user: ticket.user.clone(),
            cid: ticket.cid.clone(),
            exp: ticket.exp,
            generation: ticket.generation,
            route_revision,
            instance: instance.into(),
        }
    }
}

/// One admitted connection: the exact Edge wire inputs of a route token. `node` is the node whose
/// key seals it.
pub struct Connection<'a> {
    pub region: &'a str,
    pub node: &'a str,
    pub database: &'a str,
    pub user: &'a str,
    pub cid: &'a str,
    pub now_ms: u64,
    pub ttl_seconds: u64,
}
/// What the node reported of the unit that serves the database, signed into a v6 route.
pub struct NodeTarget<'a> {
    pub revision: u64,
    pub route_revision: u64,
    pub instance: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodedKeyring {
    active: String,
    keys: HashMap<String, String>,
}
pub struct Keyring {
    pub active: String,
    pub keys: HashMap<String, Vec<u8>>,
}
impl Keyring {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        let parsed: EncodedKeyring = serde_json::from_str(value).map_err(|_| "invalid keyring")?;
        let valid_kid = regex::Regex::new(
            crate::CONTRACT["nodeRouteClaims"]["properties"]["kid"]["pattern"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        if !valid_kid.is_match(&parsed.active) || !parsed.keys.contains_key(&parsed.active) {
            return Err("invalid keyring");
        }
        let mut keys = HashMap::new();
        for (name, encoded) in parsed.keys {
            if !valid_kid.is_match(&name) || encoded.len() > 1024 {
                return Err("invalid keyring");
            }
            let bytes = decode(&encoded).ok_or("invalid keyring")?;
            if bytes.len() < constant("ROUTE_KEY_MIN_BYTES") as usize {
                return Err("invalid keyring");
            }
            keys.insert(name, bytes);
        }
        Ok(Self {
            active: parsed.active,
            keys,
        })
    }
}

/// Signs the exact Edge wire claims of a v6 route with the key derived for the connection's node.
pub fn sign(
    master: &Keyring,
    connection: &Connection,
    target: &NodeTarget,
) -> Result<String, &'static str> {
    if connection.ttl_seconds == 0
        || connection.ttl_seconds > constant("ROUTE_TOKEN_SIGN_TTL_SECONDS")
    {
        return Err("invalid lifetime");
    }
    let issued = connection.now_ms / 1000;
    let claims = RouteClaims {
        v: wire_version(),
        db: connection.database.into(),
        user: connection.user.into(),
        cid: connection.cid.into(),
        rg: connection.region.into(),
        kid: master.active.clone(),
        iat: issued,
        exp: issued
            .checked_add(connection.ttl_seconds)
            .ok_or("invalid claims")?,
        rev: target.revision,
        route_revision: target.route_revision,
        node: connection.node.into(),
        inst: target.instance.into(),
    };
    if !claims.valid() {
        return Err("invalid claims");
    }
    seal(
        master,
        connection.node,
        &claims,
        wire("nodeRouteTokenPrefix"),
        wire("nodeRouteSignatureDomain"),
    )
}
/// Seals `claims` with the key derived for `node` from the master key that is active.
pub(crate) fn seal(
    master: &Keyring,
    node: &str,
    claims: &impl Serialize,
    prefix: &str,
    domain: &str,
) -> Result<String, &'static str> {
    let key = master
        .keys
        .get(&master.active)
        .ok_or("active key missing")?;
    let derived = derive_node_key(key, node)?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).map_err(|_| "invalid claims")?);
    let mut mac = Hmac::<Sha256>::new_from_slice(&derived).map_err(|_| "invalid key")?;
    mac.update(domain.as_bytes());
    mac.update(payload.as_bytes());
    Ok(format!(
        "{prefix}.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
/// The key of one node: the HMAC of the node's ID under a master key.
pub fn derive_node_key(master: &[u8], node: &str) -> Result<Vec<u8>, &'static str> {
    if !valid_pattern("node", node) || master.len() < constant("ROUTE_KEY_MIN_BYTES") as usize {
        return Err("invalid node key");
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(master).map_err(|_| "invalid key")?;
    mac.update(wire("nodeRouteKeyDomain").as_bytes());
    mac.update(node.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn decode(value: &str) -> Option<Vec<u8>> {
    // The authoritative decoder rejects padding and noncanonical trailing bits.
    URL_SAFE_NO_PAD.decode(value).ok()
}
/// Verifies a v6 route with the gateway's node keys. Failure codes and their order are the
/// TypeScript verifier's. `node` is the node this gateway serves.
pub fn verify(
    token: Option<&str>,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    node: &str,
    now_ms: u64,
) -> Result<RouteClaims, &'static str> {
    let token = token.filter(|v| !v.is_empty()).ok_or("missing")?;
    if token.len() > constant("ROUTE_TOKEN_MAX_LENGTH") as usize {
        return Err("too_long");
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != wire("nodeRouteTokenPrefix") {
        return Err("malformed");
    }
    let payload = decode(parts[1])
        .filter(|v| !v.is_empty())
        .ok_or("malformed")?;
    let signature = decode(parts[2])
        .filter(|v| v.len() == constant("ROUTE_TOKEN_SIGNATURE_BYTES") as usize)
        .ok_or("malformed")?;
    let text = std::str::from_utf8(&payload).map_err(|_| "malformed")?;
    let value: serde_json::Value =
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
            .map_err(|_| "malformed")?;
    let key_id = value
        .as_object()
        .and_then(|v| v.get("kid"))
        .and_then(|v| v.as_str())
        .ok_or("malformed")?;
    let key = keys
        .get(key_id)
        .filter(|v| v.len() >= constant("ROUTE_KEY_MIN_BYTES") as usize)
        .ok_or("unknown_kid")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "unknown_kid")?;
    mac.update(wire("nodeRouteSignatureDomain").as_bytes());
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&signature).map_err(|_| "bad_signature")?;
    let claims: RouteClaims = serde_json::from_value(value).map_err(|_| "invalid_claims")?;
    if !claims.valid() {
        return Err("invalid_claims");
    }
    if claims.rg != region {
        return Err("wrong_region");
    }
    if claims.node != node {
        return Err("wrong_node");
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

/// Database-partitioned single use, matching the existing TS guard. Capacity
/// exhaustion refuses admission and can never evict a still-valid token.
pub struct ReplayCache {
    maximum: usize,
    entries: HashMap<String, HashMap<String, u64>>,
}
impl ReplayCache {
    pub fn new(maximum: usize) -> Self {
        assert!(maximum > 0);
        Self {
            maximum,
            entries: HashMap::new(),
        }
    }
    /// Records the connection `cid` of `database`, whose token expires at `exp` (Unix seconds).
    pub fn use_token(
        &mut self,
        database: &str,
        cid: &str,
        exp: u64,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        self.entries.retain(|_, entries| {
            entries.retain(|_, expiry| *expiry >= now_ms);
            !entries.is_empty()
        });
        let expiry = (exp + constant("ROUTE_TOKEN_SKEW_SECONDS"))
            .checked_mul(1000)
            .ok_or("full")?;
        if expiry < now_ms
            || expiry - now_ms
                > (constant("ROUTE_TOKEN_MAX_LIFETIME_SECONDS")
                    + 2 * constant("ROUTE_TOKEN_SKEW_SECONDS"))
                    * 1000
        {
            return Err("full");
        }
        let partition = self.entries.entry(database.to_string()).or_default();
        if partition.contains_key(cid) {
            return Err("replayed");
        }
        if partition.len() >= self.maximum {
            return Err("full");
        }
        partition.insert(cid.to_string(), expiry);
        Ok(())
    }
}

pub fn valid_websocket_key(value: &str) -> bool {
    use base64::engine::general_purpose::STANDARD;
    value.len() == 24
        && value.ends_with("==")
        && STANDARD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 16 && STANDARD.encode(bytes) == value)
}
