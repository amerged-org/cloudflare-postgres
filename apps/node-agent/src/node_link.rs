// SPDX-License-Identifier: Apache-2.0
//! The node's contract with Cloudflare (`packages/contracts/src/node-link.ts`, ULTRA plan 5.3,
//! 5.6, 7.11 and 8): the generated JSON Schemas and constants, the rules of a desired page that a
//! JSON Schema cannot state, and the node's Ed25519 signature on its requests.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/node.generated.json"
    ))
    .expect("generated node contract")
});
static SCHEMAS: LazyLock<HashMap<String, jsonschema::Validator>> = LazyLock::new(|| {
    CONTRACT["schemas"]
        .as_object()
        .expect("generated schemas")
        .iter()
        .map(|(name, schema)| {
            (
                name.clone(),
                jsonschema::options()
                    .should_validate_formats(true)
                    .build(schema)
                    .expect("generated schema is valid"),
            )
        })
        .collect()
});
pub fn schema_valid(name: &str, value: &Value) -> bool {
    SCHEMAS.get(name).is_some_and(|s| s.is_valid(value))
}
pub fn constant(name: &str) -> &'static Value {
    &CONTRACT["constants"][name]
}
fn text(name: &str) -> &'static str {
    constant(name).as_str().expect("generated text constant")
}

/// The parts of an archive path `s3://<bucket>/<region>/<database>/g<generation>-<operation>`.
#[derive(Debug, PartialEq, Eq)]
pub struct ArchivePath<'a> {
    pub bucket: &'a str,
    pub region: &'a str,
    pub database: &'a str,
    pub generation: u64,
    pub operation: &'a str,
}
/// Splits a path the schema already accepted; `None` for anything else.
pub fn archive_path(path: &str) -> Option<ArchivePath<'_>> {
    let parts: Vec<&str> = path.strip_prefix("s3://")?.split('/').collect();
    let [bucket, region, database, storage] = parts[..] else {
        return None;
    };
    let (generation, operation) = storage.strip_prefix('g')?.split_once('-')?;
    Some(ArchivePath {
        bucket,
        region,
        database,
        generation: generation.parse().ok()?,
        operation,
    })
}

/// A desired page the agent may act on: its schema, and the rules no JSON Schema states.
pub fn desired_page_valid(page: &Value) -> bool {
    schema_valid("NodeDesiredPage", page) && page_rules(page)
}

fn page_rules(page: &Value) -> bool {
    let region = page["node"]["region_id"].as_str();
    let mut served: HashMap<&str, u64> = HashMap::new();
    for db in page["databases"].as_array().into_iter().flatten() {
        let (Some(id), Some(storage)) = (db["id"].as_str(), db["storage_generation"].as_u64())
        else {
            return false;
        };
        if served.insert(id, storage).is_some() {
            return false;
        }
        let Some(archive) = db["archive"]["path"].as_str().and_then(archive_path) else {
            return false;
        };
        if archive.database != id
            || archive.generation != storage
            || Some(archive.region) != region
            || !origin_valid(&db["origin"], id, storage)
            || !roles_valid(db)
        {
            return false;
        }
    }
    let orders = page["orders"].as_array().into_iter().flatten();
    // A fenced node's page holds no database and no release, and only fence and superseded orders.
    if orders.clone().any(|order| order["type"] == "fence")
        && (!served.is_empty()
            || !page["release"].is_null()
            || !page["next"].is_null()
            || orders
                .clone()
                .any(|order| !matches!(order["type"].as_str(), Some("fence" | "superseded"))))
    {
        return false;
    }
    let mut operations = HashSet::new();
    for order in orders {
        if !operations.insert(order["operation"].as_str()) {
            return false;
        }
        // An order never retires a storage generation the page serves.
        if order["type"] == "superseded"
            && order["database"]
                .as_str()
                .and_then(|database| served.get(database))
                .is_some_and(|storage| Some(*storage) <= order["storage_generation"].as_u64())
        {
            return false;
        }
    }
    true
}

/// A restore reads another database; a move reads this database's earlier generation to its end
/// (the schema gives a move its `end` record and no target time).
fn origin_valid(origin: &Value, id: &str, storage: u64) -> bool {
    let kind = origin["kind"].as_str();
    if matches!(kind, None | Some("create")) {
        return true;
    }
    let source = &origin["source"];
    let Some(source_id) = source["database_id"].as_str() else {
        return false;
    };
    let Some(from) = source["path"].as_str().and_then(archive_path) else {
        return false;
    };
    from.database == source_id
        && match kind {
            Some("restore") => source_id != id,
            Some("move") => source_id == id && from.generation < storage,
            _ => false,
        }
}

fn reserved_role(name: &str) -> bool {
    let listed = |key: &str| {
        constant(key)
            .as_array()
            .expect("generated role list")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
    };
    listed("RESERVED_ROLE_NAMES").contains(&name)
        || listed("RESERVED_ROLE_PREFIXES")
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// The roles of one database: unique, unreserved names; the owner `app`, never removed, exactly
/// once while the database exists; memberships of other present roles only.
fn roles_valid(db: &Value) -> bool {
    let owner_name = text("OWNER_ROLE_NAME");
    let roles: Vec<&Value> = db["roles"].as_array().into_iter().flatten().collect();
    let mut names = HashSet::new();
    let mut present: HashMap<&str, bool> = HashMap::new();
    for role in &roles {
        let Some(name) = role["name"].as_str() else {
            return false;
        };
        if !names.insert(name) || reserved_role(name) || name == text("MAINTENANCE_ROLE") {
            return false;
        }
        if role.get("state").is_some() {
            if name == owner_name {
                return false;
            }
            continue;
        }
        let owner = role["owner"].as_bool() == Some(true);
        if owner && name != owner_name {
            return false;
        }
        present.insert(name, owner);
    }
    let owners = present.values().filter(|owner| **owner).count();
    if owners > 1 || (db["desired_state"] != "deleted" && owners != 1) {
        return false;
    }
    roles
        .iter()
        .filter(|role| role.get("state").is_none())
        .all(|role| {
            role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|target| {
                    target.as_str().is_some_and(|target| {
                        Some(target) != role["name"].as_str()
                            && target != owner_name
                            && present.get(target) == Some(&false)
                    })
                })
        })
}

/// What the agent does with one database's entry of a desired page, given the generation and
/// operation it runs (`NodeDesiredDatabase.generation` in the contract). The generation never
/// falls: the wake claim the agent released may be above what the page names, because D1 commits
/// the claim after the answer.
#[derive(Debug, PartialEq, Eq)]
pub enum PageEntry {
    /// Below what runs: ignored. The orders of its page still apply.
    Stale,
    /// The generation and operation that run: nothing to do.
    Current,
    /// Above what runs, or the same generation of another operation: the page wins. The agent
    /// applies it and republishes the gateway's table entry.
    Apply,
}
pub fn page_entry(running: &(u64, String), entry: (u64, &str)) -> PageEntry {
    match entry.0.cmp(&running.0) {
        std::cmp::Ordering::Less => PageEntry::Stale,
        std::cmp::Ordering::Equal if entry.1 == running.1 => PageEntry::Current,
        _ => PageEntry::Apply,
    }
}

/// The claims of a signed node request, in the contract's field order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequestClaims {
    pub v: u8,
    pub node: String,
    pub uid: String,
    pub method: String,
    pub path: String,
    /// SHA-256 of the body bytes, lowercase hex; of nothing for a GET and the link.
    pub body: String,
    pub iat: u64,
    pub exp: u64,
}
impl RequestClaims {
    pub fn new(node: &str, uid: &str, method: &str, path: &str, body: &[u8], now_ms: u64) -> Self {
        let iat = now_ms / 1000;
        Self {
            v: 1,
            node: node.into(),
            uid: uid.into(),
            method: method.into(),
            path: path.into(),
            body: Sha256::digest(body)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
            iat,
            exp: iat
                + constant("NODE_REQUEST_MAX_LIFETIME_SECONDS")
                    .as_u64()
                    .expect("generated lifetime"),
        }
    }
}
/// The bearer token of one request: `pgcf_nr1.<claims>.<signature>`.
pub fn sign_request(key: &Ed25519KeyPair, claims: &RequestClaims) -> String {
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("request claims serialize"));
    let signature =
        key.sign(format!("{}{payload}", text("NODE_REQUEST_SIGNATURE_DOMAIN")).as_bytes());
    format!(
        "{}.{payload}.{}",
        text("NODE_REQUEST_TOKEN_PREFIX"),
        URL_SAFE_NO_PAD.encode(signature.as_ref())
    )
}
/// The public key the enrollment sends.
pub fn public_key(key: &Ed25519KeyPair) -> String {
    URL_SAFE_NO_PAD.encode(key.public_key().as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    static VECTORS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-vectors.generated.json"
        ))
        .unwrap()
    });
    #[test]
    fn the_schemas_and_page_rules_decide_as_the_contract_does() {
        for vector in VECTORS["schemas"].as_array().unwrap() {
            let (schema, name, value) = (
                vector["schema"].as_str().unwrap(),
                vector["name"].as_str().unwrap(),
                &vector["value"],
            );
            let valid = vector["valid"].as_bool().unwrap();
            let refinement = vector["refinement"].as_bool().unwrap();
            // A refinement is exactly what the JSON Schema alone accepts.
            assert_eq!(
                schema_valid(schema, value),
                valid || refinement,
                "{schema}/{name}"
            );
            if schema == "NodeDesiredPage" {
                assert_eq!(desired_page_valid(value), valid, "{schema}/{name}");
            }
        }
    }
    #[test]
    fn requests_are_signed_byte_for_byte_as_the_contract_signs_them() {
        for vector in VECTORS["requests"].as_array().unwrap() {
            let seed: Vec<u8> = (0..64)
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&vector["seed"].as_str().unwrap()[i..i + 2], 16).unwrap()
                })
                .collect();
            let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
            assert_eq!(public_key(&key), vector["public_key"]);
            let claims = RequestClaims::new(
                vector["claims"]["node"].as_str().unwrap(),
                vector["claims"]["uid"].as_str().unwrap(),
                vector["method"].as_str().unwrap(),
                vector["path"].as_str().unwrap(),
                vector["body"].as_str().unwrap().as_bytes(),
                vector["claims"]["iat"].as_u64().unwrap() * 1000 + 999,
            );
            assert_eq!(serde_json::to_value(&claims).unwrap(), vector["claims"]);
            assert!(schema_valid("NodeRequestClaims", &vector["claims"]));
            assert_eq!(sign_request(&key, &claims), vector["token"]);
        }
    }
    #[test]
    fn a_page_entry_never_lowers_what_the_agent_runs() {
        let op = |letter: char| format!("op_{}", letter.to_string().repeat(20));
        let running = (4, op('a'));
        // An older entry is stale and ignored; the orders of its page still apply.
        assert_eq!(page_entry(&running, (3, &op('z'))), PageEntry::Stale);
        // The same generation and operation is what runs.
        assert_eq!(page_entry(&running, (4, &op('a'))), PageEntry::Current);
        // The same generation of another operation: a concurrent suspend or resize won the D1
        // claim of the wake the agent released, so the page wins and is applied again.
        assert_eq!(page_entry(&running, (4, &op('b'))), PageEntry::Apply);
        assert_eq!(page_entry(&running, (5, &op('a'))), PageEntry::Apply);
    }

    #[test]
    fn archive_paths_split_into_their_parts() {
        let path = format!(
            "s3://pgcf-eu/eu-dev/{}/g12-op_{}",
            "a".repeat(20),
            "b".repeat(20)
        );
        let parts = archive_path(&path).unwrap();
        assert_eq!(
            (parts.bucket, parts.region, parts.generation),
            ("pgcf-eu", "eu-dev", 12)
        );
        assert!(archive_path("s3://pgcf-eu/eu-dev/a").is_none());
    }
}
