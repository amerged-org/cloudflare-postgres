// SPDX-License-Identifier: Apache-2.0
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};
pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/controller.generated.json"
    ))
    .expect("generated controller contracts")
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
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn number(value: &Value, key: &str) -> u64 {
    integer(value, key).unwrap_or(0)
}
/** Use for authority facts: missing, fractional or out-of-range is unknown, never measured zero. */
pub fn integer(value: &Value, key: &str) -> Result<u64, crate::Error> {
    const MAX_SAFE: u64 = 9_007_199_254_740_991;
    if let Some(n) = value[key].as_u64().filter(|n| *n <= MAX_SAFE) {
        return Ok(n);
    }
    if let Some(n) = value[key]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= MAX_SAFE as f64)
    {
        return Ok(n as u64);
    }
    Err("integer authority fact is unknown".into())
}
pub fn optional_number(value: &Value, key: &str, default: u64) -> u64 {
    if value[key].is_null() {
        default
    } else {
        number(value, key)
    }
}
pub fn constant(name: &str) -> &'static Value {
    &CONTRACT["constants"][name]
}
pub fn namespace(db: &Value) -> String {
    format!("pgcf-db-{}", text(db, "id"))
}
pub fn generation(value: &Value) -> u64 {
    value["metadata"]["annotations"]["pgcf.io/generation"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}
fn archive(path: &str) -> Option<(&str, &str, &str, u64, &str)> {
    let parts: Vec<_> = path.strip_prefix("s3://")?.split('/').collect();
    if parts.len() != 4 {
        return None;
    }
    let (generation, op) = parts[3].strip_prefix('g')?.split_once('-')?;
    Some((parts[0], parts[1], parts[2], generation.parse().ok()?, op))
}
pub fn database_valid(db: &Value) -> bool {
    if !schema_valid("DesiredDatabase", db) {
        return false;
    }
    let state = text(db, "desired_state");
    let power = &db["power"];
    if state == "suspended" && power.is_null() {
        return false;
    }
    if !power.is_null()
        && (number(power, "revision") != number(db, "generation")
            || if state == "suspended" {
                text(power, "mode") != "quiesce" || power["reason"].is_null()
            } else {
                text(power, "mode") != "running" || !power["reason"].is_null()
            })
    {
        return false;
    }
    let Some(dest) = archive(text(&db["archive"], "destination_path")) else {
        return false;
    };
    if dest.2 != text(db, "id") || dest.3 != optional_number(db, "storage_generation", 1) {
        return false;
    }
    if !db["creation"].is_null()
        && (text(&db["creation"], "operation_id") != dest.4
            || number(&db["creation"], "generation") > number(db, "generation"))
    {
        return false;
    }
    if !db["recovery"].is_null() {
        let r = &db["recovery"];
        let Some(source) = archive(text(r, "source_archive_path")) else {
            return false;
        };
        let expected_bucket = r["source_archive"]["bucket"].as_str().unwrap_or(dest.0);
        let expected_region = r["source_archive"]["region_id"].as_str().unwrap_or(dest.1);
        if source.2 != text(r, "source_database_id")
            || source.3 != number(r, "source_storage_generation")
            || source.0 != expected_bucket
            || source.1 != expected_region
            || source.2 == dest.2
            || text(r, "operation_id") != dest.4
            || !db["creation"].is_null()
        {
            return false;
        }
    }
    let mut names = HashSet::new();
    let mut owners = 0;
    for role in db["roles"].as_array().into_iter().flatten() {
        let name = text(role, "name");
        if !pgcf_native_protocol::valid_role(name)
            || name == constant("MAINTENANCE_ROLE").as_str().unwrap()
            || !names.insert(name)
        {
            return false;
        }
        if role["owner"] == true {
            owners += 1;
            if name != constant("OWNER_ROLE_NAME").as_str().unwrap() {
                return false;
            }
        }
    }
    if owners > 1 || (["running", "suspended"].contains(&state) && owners != 1) {
        return false;
    }
    let size = &db["size"];
    let storage = &db["storage"];
    if !storage.is_null()
        && (text(storage, "storage_class")
            != format!(
                "pgcf-lvm-thin-v1-{}",
                &text(storage, "profile_sha256")[..16]
            )
            || storage["volume_attributes_class"] != storage["storage_class"])
    {
        return false;
    }
    if optional_number(
        size,
        "cpu_request_millicores",
        number(size, "cpu_millicores"),
    ) > number(size, "cpu_millicores")
        || optional_number(size, "memory_request_mib", number(size, "memory_mib"))
            > number(size, "memory_mib")
    {
        return false;
    }
    true
}
pub fn desired_valid(value: &Value, region: &str) -> bool {
    schema_valid("DesiredResponse", value)
        && text(&value["region"], "id") == region
        && value["databases"].as_array().is_some_and(|rows| {
            rows.iter().all(|db| {
                if !database_valid(db) {
                    return false;
                }
                let Some(path) = archive(text(&db["archive"], "destination_path")) else {
                    return false;
                };
                if path.0 != text(&value["region"]["backup"], "bucket") || path.1 != region {
                    return false;
                }
                let scheduling = &value["region"]["scheduling"];
                text(db, "desired_state") != "running"
                    || (db["size"]["memory_request_mib"]
                        == scheduling["postgres_memory_request_mib"]
                        && (scheduling.is_null()
                            || (number(&db["size"], "memory_mib")
                                <= number(scheduling, "maximum_database_memory_mib")
                                && number(&db["size"], "memory_mib").is_multiple_of(256))))
            })
        })
}
/// Same nonsecret tuple as the authoritative reclaimConfigurationInput TypeScript helper.
pub fn configuration_input(db: &Value, fallback: &str) -> Value {
    let size = &db["size"];
    let mut roles: Vec<_> = db["roles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|role| serde_json::json!([role["name"], role["owner"], number(role, "revision")]))
        .collect();
    roles.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
    let storage = &db["storage"];
    let storage = if storage.is_null() {
        Value::Null
    } else {
        serde_json::json!([
            storage["backend"],
            storage["storage_class"],
            storage["volume_attributes_class"],
            number(storage, "profile_revision"),
            storage["profile_sha256"],
            storage["node_uid"],
            storage["volume_group_uuid"],
            storage["pool_uuid"],
            number(storage, "startup_reserve_bytes"),
            number(storage, "write_bytes_per_second"),
            number(storage, "write_iops_per_second"),
            number(storage, "guard_seconds"),
            number(storage, "drain_seconds")
        ])
    };
    serde_json::json!([
        "pgcf-config/v1",
        number(db, "pg_major"),
        db["postgres"]["image"].as_str().unwrap_or(fallback),
        [
            number(size, "memory_mib"),
            optional_number(size, "memory_request_mib", number(size, "memory_mib")),
            number(size, "cpu_millicores"),
            optional_number(
                size,
                "cpu_request_millicores",
                number(size, "cpu_millicores")
            ),
            number(size, "storage_gib"),
            number(size, "max_connections"),
            number(size, "archive_timeout_seconds"),
            number(size, "backup_retention_days")
        ],
        optional_number(db, "storage_generation", 1),
        db["archive"]["destination_path"],
        db["archive"]["server_name"],
        roles,
        if db["maintenance"].is_null() {
            Value::Null
        } else {
            number(&db["maintenance"], "revision").into()
        },
        storage
    ])
}
pub fn configuration_fingerprint(db: &Value, fallback: &str) -> Result<String, crate::Error> {
    use sha2::{Digest, Sha256};
    Ok(
        Sha256::digest(serde_json::to_vec(&configuration_input(db, fallback))?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoritative_nonsecret_configuration_fingerprints_match() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let fallback = text(&vector["ctx"], "postgresImage");
            assert_eq!(
                configuration_input(&vector["db"], fallback),
                vector["configuration_input"]
            );
            assert_eq!(
                configuration_fingerprint(&vector["db"], fallback).unwrap(),
                text(vector, "configuration_fingerprint")
            );
        }
        let mut changed = vectors[0]["db"].clone();
        changed["generation"] = 9.into();
        changed["roles"][0]["password"] = "not-hashed".into();
        changed["storage_authority"] = "renewed".into();
        assert_eq!(
            configuration_fingerprint(&changed, text(&vectors[0]["ctx"], "postgresImage")).unwrap(),
            text(&vectors[0], "configuration_fingerprint")
        );
    }
    #[test]
    fn authority_numbers_preserve_integral_json_float_counts() {
        let busy: Value = serde_json::from_str("{\"busyConnections\":1.0}").unwrap();
        assert_eq!(number(&busy, "busyConnections"), 1);
        assert!(integer(&serde_json::json!({}), "busyConnections").is_err());
        assert!(
            integer(
                &serde_json::json!({"busyConnections":-1}),
                "busyConnections"
            )
            .is_err()
        );
        assert!(
            integer(
                &serde_json::json!({"busyConnections":0.5}),
                "busyConnections"
            )
            .is_err()
        );
        assert!(
            integer(
                &serde_json::json!({"busyConnections":9_007_199_254_740_992_u64}),
                "busyConnections"
            )
            .is_err()
        );
        let busy: Value = serde_json::from_str("{\"busyConnections\":1e0}").unwrap();
        assert_eq!(number(&busy, "busyConnections"), 1);
    }
    #[test]
    fn authoritative_builder_inputs_and_cross_field_refusals() {
        let v: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        for vector in v.as_array().unwrap() {
            assert!(database_valid(&vector["db"]));
        }
        let mut db = v[0]["db"].clone();
        db["desired_state"] = "suspended".into();
        assert!(!database_valid(&db));
        db = v[0]["db"].clone();
        db["size"]["cpu_request_millicores"] = 999.into();
        assert!(!database_valid(&db));
        db = v[0]["db"].clone();
        db["roles"][1]["name"] = "pgcf_maintenance".into();
        assert!(!database_valid(&db));
    }
}
