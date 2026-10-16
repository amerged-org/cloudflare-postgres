// SPDX-License-Identifier: Apache-2.0
//! Edge-to-gateway route tokens. A v3 route names the database generation and verified primary Pod
//! that Cloudflare admitted. Temporary rollout compatibility: v2 routes name neither; the
//! authoritative TypeScript contract (route-token.ts) states when v2 is removed.
use crate::{constant, valid_claims, valid_legacy_claims, wire};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;

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
    /// Existing database generation; absent only in a v2 route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rev: Option<u64>,
    /// Verified primary Pod UID of that revision; absent only in a v2 route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod: Option<String>,
    /// Independent route revision, required by v4.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route_revision: Option<u64>,
}
/// One admitted connection: the exact Edge wire inputs of a route token.
pub struct Connection<'a> {
    pub region: &'a str,
    pub database: &'a str,
    pub user: &'a str,
    pub cid: &'a str,
    pub now_ms: u64,
    pub ttl_seconds: u64,
}
/// The admission's verified connection target, signed into a v3 route.
pub struct RouteTarget<'a> {
    pub revision: u64,
    pub pod_uid: &'a str,
    pub route_revision: Option<u64>,
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
        let kid = regex::Regex::new(
            crate::CONTRACT["routeClaims"]["properties"]["kid"]["pattern"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        if !kid.is_match(&parsed.active) || !parsed.keys.contains_key(&parsed.active) {
            return Err("invalid keyring");
        }
        let mut keys = HashMap::new();
        for (name, encoded) in parsed.keys {
            if !kid.is_match(&name) || encoded.len() > 1024 {
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
/// Sign the exact Edge wire claims of a v3 route with a region-derived key.
pub fn sign(
    master: &Keyring,
    connection: &Connection,
    target: &RouteTarget,
) -> Result<String, &'static str> {
    let schema = if target.route_revision.is_some() {
        "admissionRouteClaims"
    } else {
        "routeClaims"
    };
    let mut claims = claims(master, connection, schema)?;
    claims.rev = Some(target.revision);
    claims.pod = Some(target.pod_uid.into());
    claims.route_revision = target.route_revision;
    if !crate::valid_schema(
        schema,
        &serde_json::to_value(&claims).map_err(|_| "invalid claims")?,
    ) || !crate::valid_role(&claims.user)
    {
        return Err("invalid claims");
    }
    seal(
        master,
        connection.region,
        &claims,
        wire(if target.route_revision.is_some() {
            "admissionRouteTokenPrefix"
        } else {
            "routeTokenPrefix"
        }),
        wire(if target.route_revision.is_some() {
            "admissionRouteSignatureDomain"
        } else {
            "routeSignatureDomain"
        }),
    )
}
/// Temporary rollout compatibility: a v2 route for an admission without a verified target.
pub fn sign_legacy(master: &Keyring, connection: &Connection) -> Result<String, &'static str> {
    let claims = claims(master, connection, "legacyRouteClaims")?;
    if !valid_legacy_claims(&serde_json::to_value(&claims).map_err(|_| "invalid claims")?) {
        return Err("invalid claims");
    }
    seal(
        master,
        connection.region,
        &claims,
        wire("legacyRouteTokenPrefix"),
        wire("legacyRouteSignatureDomain"),
    )
}
fn claims(
    master: &Keyring,
    connection: &Connection,
    schema: &str,
) -> Result<RouteClaims, &'static str> {
    if connection.ttl_seconds == 0
        || connection.ttl_seconds > constant("ROUTE_TOKEN_SIGN_TTL_SECONDS")
    {
        return Err("invalid lifetime");
    }
    let issued = connection.now_ms / 1000;
    Ok(RouteClaims {
        v: crate::CONTRACT[schema]["properties"]["v"]["const"]
            .as_u64()
            .unwrap() as u8,
        db: connection.database.into(),
        user: connection.user.into(),
        cid: connection.cid.into(),
        rg: connection.region.into(),
        kid: master.active.clone(),
        iat: issued,
        exp: issued
            .checked_add(connection.ttl_seconds)
            .ok_or("invalid claims")?,
        rev: None,
        pod: None,
        route_revision: None,
    })
}
fn seal(
    master: &Keyring,
    region: &str,
    claims: &RouteClaims,
    prefix: &str,
    domain: &str,
) -> Result<String, &'static str> {
    let key = master
        .keys
        .get(&master.active)
        .ok_or("active key missing")?;
    let derived = derive_region_key(key, region)?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).map_err(|_| "invalid claims")?);
    let mut mac = Hmac::<Sha256>::new_from_slice(&derived).map_err(|_| "invalid key")?;
    mac.update(domain.as_bytes());
    mac.update(payload.as_bytes());
    Ok(format!(
        "{prefix}.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
pub fn derive_region_key(master: &[u8], region: &str) -> Result<Vec<u8>, &'static str> {
    if !crate::valid_pattern("region", region)
        || master.len() < constant("ROUTE_KEY_MIN_BYTES") as usize
    {
        return Err("invalid region key");
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(master).map_err(|_| "invalid key")?;
    mac.update(wire("routeKeyDomain").as_bytes());
    mac.update(region.as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn decode(value: &str) -> Option<Vec<u8>> {
    // The authoritative decoder rejects padding and noncanonical trailing bits.
    URL_SAFE_NO_PAD.decode(value).ok()
}
pub fn verify(
    token: Option<&str>,
    keys: &HashMap<String, Vec<u8>>,
    region: &str,
    now_ms: f64,
) -> Result<RouteClaims, &'static str> {
    if !now_ms.is_finite() {
        return Err("invalid_time");
    }
    let token = token.filter(|v| !v.is_empty()).ok_or("missing")?;
    let limit = if token.starts_with(&format!("{}.", wire("admissionRouteTokenPrefix"))) {
        constant("ROUTE_TOKEN_ADMISSION_MAX_LENGTH")
    } else {
        constant("ROUTE_TOKEN_MAX_LENGTH")
    };
    if token.len() > limit as usize {
        return Err("too_long");
    }
    let parts: Vec<_> = token.split('.').collect();
    // Temporary rollout compatibility: v2 keeps its own prefix, domain and claims.
    let legacy = parts[0] == wire("legacyRouteTokenPrefix");
    let admission = parts[0] == wire("admissionRouteTokenPrefix");
    if parts.len() != 3 || (parts[0] != wire("routeTokenPrefix") && !legacy && !admission) {
        return Err("malformed");
    }
    let payload = decode(parts[1]).ok_or("malformed")?;
    let signature = decode(parts[2])
        .filter(|v| v.len() == constant("ROUTE_TOKEN_SIGNATURE_BYTES") as usize)
        .ok_or("malformed")?;
    let text = std::str::from_utf8(&payload).map_err(|_| "malformed")?;
    let mut value: serde_json::Value =
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
            .map_err(|_| "malformed")?;
    let kid = value
        .as_object()
        .and_then(|v| v.get("kid"))
        .and_then(|v| v.as_str())
        .ok_or("malformed")?;
    let key = keys
        .get(kid)
        .filter(|v| v.len() >= constant("ROUTE_KEY_MIN_BYTES") as usize)
        .ok_or("unknown_kid")?;
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| "unknown_kid")?;
    mac.update(
        wire(if legacy {
            "legacyRouteSignatureDomain"
        } else if admission {
            "admissionRouteSignatureDomain"
        } else {
            "routeSignatureDomain"
        })
        .as_bytes(),
    );
    mac.update(parts[1].as_bytes());
    mac.verify_slice(&signature).map_err(|_| "bad_signature")?;
    // JSON.parse has one number type. Accept equivalent integral JSON spelling
    // before typed deserialization, without accepting fractional/unsafe claims.
    if let Some(object) = value.as_object_mut() {
        for field in object.values_mut() {
            if let Some(number) = field.as_f64()
                && number >= 0.0
                && number.fract() == 0.0
                && number <= 9_007_199_254_740_991.0
            {
                *field = serde_json::Value::from(number as u64);
            }
        }
    }
    if !(if legacy {
        valid_legacy_claims(&value)
    } else if admission {
        crate::valid_schema("admissionRouteClaims", &value)
            && value["user"].as_str().is_some_and(crate::valid_role)
    } else {
        valid_claims(&value)
    }) {
        return Err("invalid_claims");
    }
    let claims: RouteClaims = serde_json::from_value(value).map_err(|_| "invalid_claims")?;
    if claims.rg != region {
        return Err("wrong_region");
    }
    if claims.exp <= claims.iat
        || claims.exp - claims.iat > constant("ROUTE_TOKEN_MAX_LIFETIME_SECONDS")
    {
        return Err("invalid_lifetime");
    }
    let now = now_ms / 1000.0;
    if claims.iat as f64 > now + constant("ROUTE_TOKEN_SKEW_SECONDS") as f64 {
        return Err("not_yet_valid");
    }
    if now > claims.exp as f64 + constant("ROUTE_TOKEN_SKEW_SECONDS") as f64 {
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
    pub fn use_token(&mut self, claims: &RouteClaims, now_ms: u64) -> Result<(), &'static str> {
        self.entries.retain(|_, entries| {
            entries.retain(|_, expiry| *expiry >= now_ms);
            !entries.is_empty()
        });
        let expiry = (claims.exp + constant("ROUTE_TOKEN_SKEW_SECONDS"))
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
        let partition = self.entries.entry(claims.db.clone()).or_default();
        if partition.contains_key(&claims.cid) {
            return Err("replayed");
        }
        if partition.len() >= self.maximum {
            return Err("full");
        }
        partition.insert(claims.cid.clone(), expiry);
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
