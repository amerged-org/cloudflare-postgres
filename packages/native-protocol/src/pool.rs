// SPDX-License-Identifier: Apache-2.0
//! Pool wire schemas and scope hashing come only from the authoritative generated Zod contracts.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

pub static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../contracts/native/postgres-pool.generated.json"
    ))
    .expect("generated PostgreSQL pool contracts")
});
pub fn constant(name: &str) -> &'static Value {
    &CONTRACT["constants"][name]
}
pub fn validate(name: &str, value: &Value) -> bool {
    let Some(schema) = CONTRACT["schemas"].get(name) else {
        return false;
    };
    validate_generated_schema(schema, value) && semantics(name, value)
}
/// Reuse the bounded structural engine; each authoritative module adds its own semantic refinements.
pub(crate) fn validate_generated_schema(schema: &Value, value: &Value) -> bool {
    check(schema, schema, value, 0)
}
fn check(root: &Value, schema: &Value, value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    if let Some(reference) = schema["$ref"].as_str() {
        let Some(path) = reference.strip_prefix('#') else {
            return false;
        };
        return root
            .pointer(path)
            .is_some_and(|s| check(root, s, value, depth + 1));
    }
    if let Some(branches) = schema["oneOf"].as_array() {
        return branches
            .iter()
            .filter(|s| check(root, s, value, depth + 1))
            .count()
            == 1;
    }
    if let Some(branches) = schema["anyOf"].as_array() {
        return branches.iter().any(|s| check(root, s, value, depth + 1));
    }
    if let Some(expected) = schema.get("const")
        && expected != value
    {
        return false;
    }
    if let Some(choices) = schema["enum"].as_array()
        && !choices.contains(value)
    {
        return false;
    }
    if let Some(types) = schema["type"].as_array() {
        return types.iter().any(|kind| {
            let mut branch = schema.clone();
            branch["type"] = kind.clone();
            check(root, &branch, value, depth + 1)
        });
    }
    match schema["type"].as_str() {
        Some("object") => {
            let (Some(object), Some(properties)) =
                (value.as_object(), schema["properties"].as_object())
            else {
                return false;
            };
            if schema["additionalProperties"] == false
                && object.keys().any(|key| !properties.contains_key(key))
            {
                return false;
            }
            if schema["required"].as_array().is_some_and(|keys| {
                keys.iter()
                    .any(|key| key.as_str().is_none_or(|key| !object.contains_key(key)))
            }) {
                return false;
            }
            object.iter().all(|(key, item)| {
                properties
                    .get(key)
                    .is_some_and(|field| check(root, field, item, depth + 1))
            })
        }
        Some("array") => value.as_array().is_some_and(|items| {
            schema["minItems"]
                .as_u64()
                .is_none_or(|min| items.len() >= min as usize)
                && schema["maxItems"]
                    .as_u64()
                    .is_none_or(|max| items.len() <= max as usize)
                && items
                    .iter()
                    .all(|item| check(root, &schema["items"], item, depth + 1))
        }),
        Some("string") => value.as_str().is_some_and(|text| {
            if schema["minLength"]
                .as_u64()
                .is_some_and(|n| text.encode_utf16().count() < n as usize)
                || schema["maxLength"]
                    .as_u64()
                    .is_some_and(|n| text.encode_utf16().count() > n as usize)
            {
                return false;
            }
            if let Some(pattern) = schema["pattern"].as_str()
                && !regex::Regex::new(pattern).is_ok_and(|r| r.is_match(text))
            {
                return false;
            }
            match schema["format"].as_str() {
                Some("ipv4") => text.parse::<std::net::Ipv4Addr>().is_ok(),
                Some("ipv6") => text.parse::<std::net::Ipv6Addr>().is_ok(),
                _ => true,
            }
        }),
        Some("integer" | "number") => value.as_u64().is_some_and(|n| {
            n <= 9_007_199_254_740_991
                && schema["minimum"].as_u64().is_none_or(|min| n >= min)
                && schema["maximum"].as_u64().is_none_or(|max| n <= max)
                && schema["exclusiveMinimum"]
                    .as_u64()
                    .is_none_or(|min| n > min)
        }),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => false,
    }
}
pub fn scope_hash(scope: &Value) -> Option<String> {
    if !validate("PoolBindingScope", scope) {
        return None;
    }
    // serde_json::Map uses lexicographic key order recursively, matching canonicalPoolBindingScope.
    Some(
        Sha256::digest(serde_json::to_vec(scope).ok()?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
pub fn preparation_hash(value: &Value) -> Option<String> {
    if !validate("PoolPodPreparationContext", value) {
        return None;
    }
    Some(
        Sha256::digest(serde_json::to_vec(value).ok()?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
pub fn cleanup_io_hash(value: &Value) -> Option<String> {
    if !validate("PoolCleanupIoAttestation", value) {
        return None;
    }
    Some(
        Sha256::digest(serde_json::to_vec(value).ok()?)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}
pub fn binding_valid(binding: &Value) -> bool {
    validate("PoolBinding", binding)
        && scope_hash(&binding["scope"]).as_deref() == binding["scope_sha256"].as_str()
}
fn class_valid(value: &Value) -> bool {
    value["cpu_request_millicores"]
        .as_u64()
        .zip(value["cpu_limit_millicores"].as_u64())
        .is_some_and(|(r, l)| r <= l)
        && value["memory_request_bytes"]
            .as_u64()
            .zip(value["memory_limit_bytes"].as_u64())
            .is_some_and(|(r, l)| r <= l)
}
fn scope_valid(value: &Value) -> bool {
    if !class_valid(&value["class"]) {
        return false;
    }
    let Some(ids) = value["container_ids"].as_array() else {
        return false;
    };
    let mut set = std::collections::HashSet::new();
    if !ids.iter().all(|id| set.insert(id.as_str())) || !ids.contains(&value["container_id"]) {
        return false;
    }
    let storage = &value["storage"];
    storage["backend"] != "lvm-thin-v1"
        || (storage["profile"]["node_uid"] == value["node_uid"]
            && storage["profile"]["volume_group_uuid"] == storage["volume_group_uuid"]
            && thin_profile_valid(&storage["profile"]))
}
fn thin_profile_valid(profile: &Value) -> bool {
    let Some(hash) = profile["profile_sha256"].as_str() else {
        return false;
    };
    hash.len() == 64
        && profile["storage_class"] == format!("pgcf-lvm-thin-v1-{}", &hash[..16])
        && profile["volume_attributes_class"] == profile["storage_class"]
}
pub fn workload_probe_safe(probe: &Value) -> bool {
    if !validate("PoolWorkloadIsolationProbe", probe) {
        return false;
    }
    if probe["uid"] != 26
        || probe["cap_eff"] != "0000000000000000"
        || probe["cap_sys_admin"] != false
        || probe["seccomp_mode"] != 2
        || probe["no_new_privs"] != true
    {
        return false;
    }
    let Some(results) = CONTRACT["constants"]["workload_probe_results"].as_array() else {
        return false;
    };
    results.iter().all(|name| {
        let key = name.as_str().unwrap();
        let errno = &probe["results"][key];
        errno == 1 || errno == 13 || (key == "clone3" && errno == 38)
    })
}
fn semantics(name: &str, value: &Value) -> bool {
    match name {
        "PostgresPoolClass" => class_valid(value),
        "PostgresPoolPolicy" => {
            class_valid(&value["class"])
                && value["idle_cpu_millicores"]
                    .as_u64()
                    .zip(value["class"]["cpu_request_millicores"].as_u64())
                    .is_some_and(|(idle, pg)| {
                        idle >= pg
                            + constant("archiver_cpu_request_millicores")
                                .as_u64()
                                .unwrap_or(u64::MAX - pg)
                    })
                && value["idle_memory_mib"]
                    .as_u64()
                    .zip(value["class"]["memory_request_bytes"].as_u64())
                    .is_some_and(|(idle, pg)| {
                        idle >= pg.div_ceil(1048576)
                            + constant("archiver_memory_request_mib")
                                .as_u64()
                                .unwrap_or(u64::MAX - pg.div_ceil(1048576))
                    })
                && value["target_slots"]
                    .as_u64()
                    .zip(value["idle_cpu_millicores"].as_u64())
                    .and_then(|(n, c)| n.checked_mul(c))
                    .zip(value["max_idle_cpu_millicores"].as_u64())
                    .is_some_and(|(used, max)| used <= max)
                && value["target_slots"]
                    .as_u64()
                    .zip(value["idle_memory_mib"].as_u64())
                    .and_then(|(n, c)| n.checked_mul(c))
                    .zip(value["max_idle_memory_mib"].as_u64())
                    .is_some_and(|(used, max)| used <= max)
                && value["archiver_image"]
                    .as_str()
                    .zip(value["archiver_sha256"].as_str())
                    .is_some_and(|(image, hash)| image.ends_with(&format!("@sha256:{hash}")))
        }
        "PoolBindingScope" => scope_valid(value),
        "PostgresPoolPolicyState" => semantics("PostgresPoolPolicy", &value["policy"]),
        "PoolThinPhysicalStorage" => {
            thin_profile_valid(&value["profile"])
                && value["profile"]["volume_group_uuid"] == value["volume_group_uuid"]
        }
        "PoolPhysicalStorage" => {
            value["backend"] != "lvm-thin-v1" || semantics("PoolThinPhysicalStorage", value)
        }
        "PoolCleanupClaims" => semantics("PoolThinPhysicalStorage", &value["storage"]),
        "PoolSleepRecord" => {
            class_valid(&value["class"]) && semantics("PoolPhysicalStorage", &value["storage"])
        }
        "PoolStorageObservation" => semantics("PoolPhysicalStorage", &value["storage"]),
        "PoolIoAttestation" => {
            let Some(cgroups) = value["cgroups"].as_array() else {
                return false;
            };
            let mut ids = std::collections::HashSet::new();
            value["shared_pod_io"]["device_major"] == value["device"]["device_major"]
                && value["shared_pod_io"]["device_minor"] == value["device"]["device_minor"]
                && cgroups.iter().all(|c| {
                    ids.insert(c["container_id"].as_str())
                        && c["device_major"] == value["device"]["device_major"]
                        && c["device_minor"] == value["device"]["device_minor"]
                })
        }
        "PoolCleanupIoAttestation" => {
            value["stopped_writers"].as_array().is_some_and(|writers| {
                let mut ids = std::collections::HashSet::new();
                writers
                    .iter()
                    .all(|w| ids.insert(w["container_id"].as_str()))
            }) && ["device_major", "device_minor"].iter().all(|key| {
                value["worker"][*key] == value["device"][*key]
                    && value["shared_pod_io"][*key] == value["device"][*key]
            }) && ["write_bytes_per_second", "write_iops_per_second"]
                .iter()
                .all(|key| value["worker"][*key] == value["shared_pod_io"][*key])
        }
        "PoolHostCustody" => unique_strings(&value["container_ids"]),
        "PoolPodPreparationContext" => {
            let Some(pods) = value["pods"].as_array() else {
                return false;
            };
            let mut ids = std::collections::HashSet::new();
            semantics("PostgresPoolPolicy", &value["policy"])
                && finite_interval(
                    &value["observed_at"],
                    &value["expires_at"],
                    constant("observation_max_age_ms").as_u64().unwrap_or(0),
                )
                && value["qualification_run_id"].is_null()
                    == value["qualification_scope_sha256"].is_null()
                && pods.iter().all(|pod| {
                    ids.insert(pod["pod_uid"].as_str()) && unique_strings(&pod["container_ids"])
                })
        }
        "PoolStorageReadSignal" => {
            finite_interval(&value["issued_at"], &value["expires_at"], 30000)
                && unique_strings(&value["container_ids"])
                && semantics("PoolThinPhysicalStorage", &value["storage"])
                && value["storage"]["profile"]["node_uid"] == value["node_uid"]
        }
        "PoolStorageReadRequest" => {
            let v = &value["signal"];
            let p = &value["preparation"];
            let Some(pod) = p["pods"]
                .as_array()
                .and_then(|pods| pods.iter().find(|pod| pod["pod_uid"] == v["pool_pod_uid"]))
            else {
                return false;
            };
            semantics("PoolStorageReadSignal", v)
                && semantics("PoolPodPreparationContext", p)
                && [
                    "node_uid",
                    "boot_id",
                    "pool_namespace_uid",
                    "qualification_run_id",
                    "qualification_scope_sha256",
                ]
                .iter()
                .all(|key| p[*key] == v[*key])
                && p["policy"]["class"]["postgres_image_sha256"] == v["postgres_image_sha256"]
                && p["policy"]["supervisor_sha256"] == v["supervisor_sha256"]
                && v["expires_at"]
                    .as_u64()
                    .zip(p["expires_at"].as_u64())
                    .is_some_and(|(end, bound)| end <= bound)
                && same_string_set(&pod["container_ids"], &v["container_ids"])
        }
        "PoolStorageReadReport" => {
            value["state"] != "read"
                || ([
                    "system_identifier",
                    "timeline",
                    "control_state",
                    "device_major",
                    "device_minor",
                ]
                .iter()
                .all(|key| !value[*key].is_null())
                    && value["error"].is_null())
        }
        "PoolPodAttestation" => {
            let Some(ids) = value["container_ids"].as_array() else {
                return false;
            };
            let Some(probes) = value["workload_probes"].as_array() else {
                return false;
            };
            let mut unique_ids = std::collections::HashSet::new();
            let mut unique_probes = std::collections::HashSet::new();
            class_valid(&value["class"])
                && ids.contains(&value["container_id"])
                && ids.len() == probes.len()
                && ids.iter().all(|id| unique_ids.insert(id.as_str()))
                && probes
                    .iter()
                    .all(|p| unique_probes.insert(p["container_id"].as_str()))
                && ids.iter().all(|id| {
                    probes
                        .iter()
                        .any(|p| p["container_id"] == *id && workload_probe_safe(&p["probe"]))
                })
        }
        "PoolBinding" => scope_valid(&value["scope"]),
        "PoolBindClaims" => scope_valid(&value["scope"]),
        "DesiredPoolBinding" => semantics("PoolBinding", &value["binding"]),
        "PoolTenantBundle" => scope_valid(&value["scope"]),
        "PoolBundleReply" => value["waiting"] == true || semantics("PoolSupervisorReport", value),
        "PoolBindingDetails" => {
            semantics("DesiredPoolBinding", &value["binding"])
                && semantics("PoolPodAttestation", &value["pod_attestation"])
                && (value["node_report"].is_null()
                    || semantics("PoolNodeReport", &value["node_report"]))
                && (value["io_attestation"].is_null()
                    || semantics("PoolIoAttestation", &value["io_attestation"]))
                && (value["supervisor_report"].is_null()
                    || semantics("PoolSupervisorReport", &value["supervisor_report"]))
        }
        "PoolBindingSnapshot" => value["bindings"]
            .as_array()
            .is_some_and(|bindings| bindings.iter().all(|b| semantics("DesiredPoolBinding", b))),
        "PoolPodInventory" => value["pods"].as_array().is_some_and(|pods| {
            let mut ids = std::collections::HashSet::new();
            pods.iter().all(|pod| {
                semantics("PoolPodAttestation", pod) && ids.insert(pod["pool_pod_uid"].as_str())
            })
        }),
        "PoolSupervisorReport" => match value["state"].as_str() {
            Some("ready") => {
                value["postmaster_pid"].as_u64().is_some_and(|v| v > 0)
                    && value["control_state"] == "in production"
                    && !value["postgres_started_at"].is_null()
                    && !value["readiness_at"].is_null()
            }
            Some("stopped") => {
                value["postmaster_pid"].is_null() && value["control_state"] == "shut down"
            }
            _ => true,
        },
        "PoolNodeReport" => node_report_semantics(value),
        _ => true,
    }
}
fn unique_strings(value: &Value) -> bool {
    let Some(items) = value.as_array() else {
        return false;
    };
    let mut ids = std::collections::HashSet::new();
    items.iter().all(|item| ids.insert(item.as_str()))
}
fn same_string_set(a: &Value, b: &Value) -> bool {
    let Some(a) = a.as_array() else {
        return false;
    };
    let Some(b) = b.as_array() else {
        return false;
    };
    let mut a = a.iter().map(Value::as_str).collect::<Vec<_>>();
    let mut b = b.iter().map(Value::as_str).collect::<Vec<_>>();
    a.sort();
    b.sort();
    a == b
}
fn finite_interval(start: &Value, end: &Value, maximum: u64) -> bool {
    start
        .as_u64()
        .zip(end.as_u64())
        .is_some_and(|(start, end)| end > start && end - start <= maximum)
}
fn node_report_semantics(value: &Value) -> bool {
    let proof = &value["kernel_proof"];
    let destruction = &value["reference_destruction"];
    if !destruction.is_null()
        && (!value["boot_loss"].is_null()
            || value["state"] != "released"
            || value["storage_backend"] != "lvm-thin-v1"
            || value["clean_stop"] != false
            || !value["thin_guard"].is_null()
            || proof["nonlazy_unmount_verified"] != false
            || proof["creator_fence"].is_null()
            || proof["creator_fence"]["scope_sha256"] != value["scope_sha256"]
            || destruction["worker"]["pool_pod_uid"] != value["pool_pod_uid"]
            || destruction["worker"]["device_major"] != proof["device_major"]
            || destruction["worker"]["device_minor"] != proof["device_minor"]
            || destruction["stopped_writers"]
                .as_array()
                .is_none_or(|writers| {
                    let mut ids = std::collections::HashSet::new();
                    !writers
                        .iter()
                        .all(|w| ids.insert(w["container_id"].as_str()))
                        || !writers.iter().any(|w| {
                            w["container_id"] == destruction["worker"]["container_id"]
                                && w["cgroup_inode"] == destruction["worker"]["cgroup_inode"]
                        })
                }))
    {
        return false;
    }
    if !value["boot_loss"].is_null()
        && (value["state"] != "released"
            || value["clean_stop"] != false
            || !value["thin_guard"].is_null()
            || value["boot_loss"]["holder_boot_id"] == value["boot_id"]
            || proof["creator_fence"].is_null()
            || proof["creator_fence"]["scope_sha256"] != value["scope_sha256"]
            || !semantics("PoolPhysicalStorage", &value["boot_loss"]["storage"]))
    {
        return false;
    }
    if let Some(cgroups) = value["thin_guard"]["cgroups"].as_array() {
        let mut ids = std::collections::HashSet::new();
        if !cgroups
            .iter()
            .all(|c| ids.insert(c["container_id"].as_str()))
        {
            return false;
        }
    }
    match value["state"].as_str() {
        Some("mounted") => {
            if value["storage_backend"] == "lvm-thin-v1"
                && (value["thin_guard"].is_null()
                    || value["thin_guard"]["expires_at"]
                        .as_u64()
                        .zip(value["observed_at"].as_u64())
                        .is_none_or(|(expires, at)| expires <= at))
            {
                return false;
            }
            proof["mount_id"].as_u64().is_some_and(|id| id > 0)
                && proof["foreign_mounts"] == 0
                && proof["named_namespace_scan_complete"] == true
                && proof["zero_before_bind"] == true
                && proof["exclusive_superblock_creation"] == true
                && !proof["creator_fence"].is_null()
                && !proof["mountpoint"].is_null()
                && proof["creator_fence"]["scope_sha256"] == value["scope_sha256"]
                && proof["mountpoint"]["pool_pod_uid"] == value["pool_pod_uid"]
        }
        Some("released" | "refused") => {
            proof["mount_id"].is_null()
                && proof["foreign_mounts"] == 0
                && proof["dm_open_count"] == 0
                && proof["named_namespace_scan_complete"] == true
                && (proof["creator_fence"].is_null()
                    || proof["creator_fence"]["creation_fds_closed"] == true)
                && (value["state"] != "released"
                    || !value["boot_loss"].is_null()
                    || !destruction.is_null()
                    || proof["nonlazy_unmount_verified"] == true)
                && (value["state"] != "refused"
                    || proof["never_attached_verified"] == true
                    || proof["nonlazy_unmount_verified"] == true)
        }
        _ => true,
    }
}
pub fn node_report_valid(value: &Value) -> bool {
    validate("PoolNodeReport", value)
}
#[cfg(not(target_arch = "wasm32"))]
pub fn verify_permission(
    token: &str,
    keys: &std::collections::HashMap<String, Vec<u8>>,
    now: u64,
) -> Option<Value> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let parts: Vec<_> = token.split('.').collect();
    if token.len() > constant("bind_max_length").as_u64()? as usize
        || parts.len() != 3
        || parts[0] != constant("bind_prefix").as_str()?
    {
        return None;
    }
    let body = crate::route::decode(parts[1])?;
    let signature = crate::route::decode(parts[2])?;
    if signature.len() != 64
        || URL_SAFE_NO_PAD.encode(&body) != parts[1]
        || URL_SAFE_NO_PAD.encode(&signature) != parts[2]
    {
        return None;
    }
    let claims: Value = serde_json::from_slice(&body).ok()?;
    if !validate("PoolBindClaims", &claims)
        || scope_hash(&claims["scope"]).as_deref() != claims["scope_sha256"].as_str()
    {
        return None;
    }
    let iat = claims["iat"].as_u64()?;
    let exp = claims["exp"].as_u64()?;
    if iat > now.checked_add(constant("clock_skew_ms").as_u64()?)?
        || exp <= now
        || exp <= iat
        || exp > iat.checked_add(constant("permission_ms").as_u64()?)?
    {
        return None;
    }
    let key = keys.get(claims["kid"].as_str()?)?;
    if key.len() != 32 {
        return None;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(
            format!("{}{}", constant("bind_domain").as_str()?, parts[1]).as_bytes(),
            &signature,
        )
        .ok()?;
    Some(claims)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn verify_cleanup_authority(
    token: &str,
    keys: &std::collections::HashMap<String, Vec<u8>>,
    now: u64,
) -> Option<Value> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let parts = token.split('.').collect::<Vec<_>>();
    if token.len() > constant("cleanup_max_length").as_u64()? as usize
        || parts.len() != 3
        || parts[0] != constant("cleanup_prefix").as_str()?
    {
        return None;
    }
    let body = crate::route::decode(parts[1])?;
    let signature = crate::route::decode(parts[2])?;
    if signature.len() != 64
        || URL_SAFE_NO_PAD.encode(&body) != parts[1]
        || URL_SAFE_NO_PAD.encode(&signature) != parts[2]
    {
        return None;
    }
    let claims: Value = serde_json::from_slice(&body).ok()?;
    if !validate("PoolCleanupClaims", &claims) {
        return None;
    }
    let iat = claims["iat"].as_u64()?;
    let exp = claims["exp"].as_u64()?;
    let profile = &claims["storage"]["profile"];
    let ttl = profile["drain_seconds"]
        .as_u64()?
        .checked_mul(1000)?
        .min(constant("cleanup_max_ms").as_u64()?);
    if iat > now.checked_add(constant("clock_skew_ms").as_u64()?)?
        || exp <= now
        || exp <= iat
        || exp > iat.checked_add(ttl)?
        || profile["node_uid"] != claims["node_uid"]
        || profile["volume_group_uuid"] != claims["storage"]["volume_group_uuid"]
        || claims["write_bytes_per_second"].as_u64()?
            > profile["write_bytes_per_second"].as_u64()?
        || claims["write_iops_per_second"].as_u64()? > profile["write_iops_per_second"].as_u64()?
    {
        return None;
    }
    let key = keys.get(claims["kid"].as_str()?)?;
    if key.len() != 32 {
        return None;
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(
            format!("{}{}", constant("cleanup_domain").as_str()?, parts[1]).as_bytes(),
            &signature,
        )
        .ok()?;
    Some(claims)
}

#[cfg(not(target_arch = "wasm32"))]
pub fn verify_pool_storage_authority(
    trust: &crate::storage::StorageTrust,
    token: &str,
    scope: &Value,
    now: u64,
) -> Option<crate::storage::VerifiedStorageAuthority> {
    if !validate("PoolBindingScope", scope) || scope["storage"]["backend"] != "lvm-thin-v1" {
        return None;
    }
    let storage = &scope["storage"];
    let profile = &storage["profile"];
    let expected = crate::storage::StorageBinding {
        database_id: scope["database_id"].as_str()?.to_owned(),
        generation: scope["generation"].as_u64()?,
        storage_uid: storage["storage_uid"].as_str()?.to_owned(),
        node_uid: scope["node_uid"].as_str()?.to_owned(),
        volume_group_uuid: storage["volume_group_uuid"].as_str()?.to_owned(),
        pool_uuid: profile["pool_uuid"].as_str()?.to_owned(),
        profile_sha256: profile["profile_sha256"].as_str()?.to_owned(),
        volume_handle: storage["volume_handle"].as_str()?.to_owned(),
        lv_uuid: storage["lv_uuid"].as_str()?.to_owned(),
        pvc_uid: storage["pvc_uid"].as_str()?.to_owned(),
        pv_uid: storage["pv_uid"].as_str()?.to_owned(),
        pod_uid: scope["pool_pod_uid"].as_str()?.to_owned(),
    };
    let verified = trust.verify(token, now).ok()?;
    let claims = verified.claims();
    if !verified.permits(&expected, now)
        || claims.guard_seconds != profile["guard_seconds"].as_u64()?
        || claims.drain_seconds != profile["drain_seconds"].as_u64()?
    {
        return None;
    }
    Some(verified)
}
