// SPDX-License-Identifier: Apache-2.0
use crate::{Error, now};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use pgcf_native_protocol::pool;
use serde_json::Value;
use std::collections::HashMap;

pub fn valid(name: &str, value: Value) -> Result<Value, Error> {
    if !pool::validate(name, &value) {
        return Err(Error(match name {
            "PoolTenantBundle" => "pool_bundle_invalid",
            "PoolMountSignal" => "pool_mount_invalid",
            "PoolArchiverCommand" => "pool_archiver_command_invalid",
            "PoolSupervisorReport" => "pool_report_invalid",
            "PoolBackupRequest" => "pool_backup_request_invalid",
            "PoolBackupReport" => "pool_backup_report_invalid",
            _ => "pool_request_invalid",
        }));
    }
    Ok(value)
}
pub fn text<'a>(value: &'a Value, name: &str) -> Result<&'a str, Error> {
    value[name].as_str().ok_or(Error("pool_request_invalid"))
}
pub fn number(value: &Value, name: &str) -> Result<u64, Error> {
    value[name].as_u64().ok_or(Error("pool_request_invalid"))
}
pub fn permissions() -> Result<HashMap<String, Vec<u8>>, Error> {
    let raw = std::env::var("PGCF_POOL_BIND_KEYS").map_err(|_| Error("pool_trust_missing"))?;
    let pinned =
        std::env::var("PGCF_POOL_BIND_KEYS_SHA256").map_err(|_| Error("pool_trust_pin_missing"))?;
    pgcf_native_protocol::storage::StorageTrust::parse(&raw, &pinned)
        .map_err(|_| Error("pool_trust_invalid"))?;
    let map: HashMap<String, String> =
        serde_json::from_str(&raw).map_err(|_| Error("pool_trust_invalid"))?;
    if map.is_empty() || map.len() > 16 {
        return Err(Error("pool_trust_invalid"));
    }
    map.into_iter()
        .map(|(kid, key)| {
            let bytes = URL_SAFE_NO_PAD
                .decode(key)
                .map_err(|_| Error("pool_trust_invalid"))?;
            if bytes.len() != 32 {
                return Err(Error("pool_trust_invalid"));
            }
            Ok((kid, bytes))
        })
        .collect()
}
pub fn storage_trust() -> Result<pgcf_native_protocol::storage::StorageTrust, Error> {
    let raw = std::env::var("PGCF_POOL_BIND_KEYS").map_err(|_| Error("pool_trust_missing"))?;
    let pinned =
        std::env::var("PGCF_POOL_BIND_KEYS_SHA256").map_err(|_| Error("pool_trust_pin_missing"))?;
    pgcf_native_protocol::storage::StorageTrust::parse(&raw, &pinned)
        .map_err(|_| Error("pool_trust_invalid"))
}
pub fn storage_authority(
    trust: &pgcf_native_protocol::storage::StorageTrust,
    value: &Value,
    scope: &Value,
) -> Result<(), Error> {
    if scope["storage"]["backend"] == "lvm-thin-v1" {
        let token = value
            .as_str()
            .ok_or(Error("pool_storage_authority_missing"))?;
        pool::verify_pool_storage_authority(trust, token, scope, now())
            .ok_or(Error("pool_storage_authority_refused"))?;
    } else if !value.is_null() {
        return Err(Error("pool_storage_authority_changed"));
    }
    Ok(())
}
pub fn permission(token: &str, keys: &HashMap<String, Vec<u8>>) -> Result<Value, Error> {
    pool::verify_permission(token, keys, now()).ok_or(Error("pool_permission_refused"))
}
pub fn same(a: &Value, b: &Value, keys: &[&str]) -> bool {
    keys.iter().all(|key| a[*key] == b[*key])
}
pub fn constant(name: &str) -> Result<&'static str, Error> {
    pool::constant(name)
        .as_str()
        .ok_or(Error("pool_protocol_missing"))
}
