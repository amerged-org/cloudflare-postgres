// SPDX-License-Identifier: Apache-2.0
//! Complete readonly LVM metadata, independent of Kubernetes snapshot absence.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use tonic::Status;

fn refused() -> Status {
    Status::failed_precondition("pool_qualification_physical_unconfirmed")
}

pub fn snapshot_count(
    report: &Value,
    vg: &str,
    source: &str,
    pool: &str,
    handle: &str,
    attempted_name: &str,
) -> Result<u64, Status> {
    let reports = report["report"]
        .as_array()
        .filter(|r| r.len() == 1)
        .ok_or_else(refused)?;
    let entries = reports[0]["lv"]
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 8192)
        .ok_or_else(refused)?;
    let mut rows = BTreeMap::new();
    for entry in entries {
        let field = |name| entry[name].as_str().map(str::trim).ok_or_else(refused);
        if field("vg_uuid")? != vg {
            return Err(refused());
        }
        let uuid = field("lv_uuid")?;
        let origin = field("origin_uuid")?;
        let pool_uuid = field("pool_lv_uuid")?;
        if !lvm_uuid(uuid)
            || (!origin.is_empty() && !lvm_uuid(origin))
            || (!pool_uuid.is_empty() && !lvm_uuid(pool_uuid))
        {
            return Err(refused());
        }
        let row = (
            field("lv_name")?.to_owned(),
            field("lv_attr")?.to_owned(),
            origin.to_owned(),
            pool_uuid.to_owned(),
        );
        if row.0.is_empty() || row.1.is_empty() || rows.insert(uuid.to_owned(), row).is_some() {
            return Err(refused());
        }
    }
    let target = rows.get(source).ok_or_else(refused)?;
    if target.0 != handle
        || !target.1.starts_with('V')
        || !target.2.is_empty()
        || target.3 != pool
        || !rows.get(pool).is_some_and(|p| p.1.starts_with('t'))
    {
        return Err(refused());
    }
    for row in rows.values() {
        let mut ancestor = row.2.as_str();
        let mut visited = BTreeSet::new();
        while !ancestor.is_empty() {
            if !visited.insert(ancestor) {
                return Err(refused());
            }
            ancestor = rows.get(ancestor).ok_or_else(refused)?.2.as_str();
        }
    }
    let attempted_name = attempted_name
        .strip_prefix("snapshot-")
        .unwrap_or(attempted_name);
    let mut descendants = BTreeSet::from([source.to_owned()]);
    for _ in 0..rows.len() {
        let mut added = false;
        for (uuid, row) in &rows {
            if !row.2.is_empty() && descendants.contains(&row.2) {
                if uuid == source {
                    return Err(refused());
                }
                added |= descendants.insert(uuid.clone());
            }
        }
        if !added {
            break;
        }
    }
    descendants.remove(source);
    // The pinned driver removes only "snapshot-" from LVMSnapshot.Name. Names alone
    // cannot prove zero: all real origin-UUID descendants are also counted.
    for (uuid, row) in &rows {
        if row.0 == attempted_name {
            if uuid == source || uuid == pool {
                return Err(refused());
            }
            descendants.insert(uuid.clone());
        }
    }
    u64::try_from(descendants.len()).map_err(|_| refused())
}
fn lvm_uuid(value: &str) -> bool {
    value.len() == 38
        && value.split('-').map(str::len).eq([6, 4, 4, 4, 4, 4, 6])
        && value
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const VG: &str = "aaaaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaaaa";
    const SOURCE: &str = "bbbbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbbbb";
    const POOL: &str = "cccccc-cccc-cccc-cccc-cccc-cccc-cccccc";
    const SNAPSHOT: &str = "dddddd-dddd-dddd-dddd-dddd-dddd-dddddd";
    fn source() -> Value {
        json!({"report":[{"lv":[
            {"vg_uuid":VG,"lv_uuid":SOURCE,"lv_name":"volume","lv_attr":"Vri-a-tz--","origin_uuid":"","pool_lv_uuid":POOL},
            {"vg_uuid":VG,"lv_uuid":POOL,"lv_name":"pool","lv_attr":"twi-a-tz--","origin_uuid":"","pool_lv_uuid":""}
        ]}]})
    }
    #[test]
    fn source_and_pool_are_required_before_measuring_zero() {
        assert_eq!(
            snapshot_count(&source(), VG, SOURCE, POOL, "volume", "attempt").unwrap(),
            0
        );
        let mut missing = source();
        missing["report"][0]["lv"].as_array_mut().unwrap().remove(0);
        assert!(snapshot_count(&missing, VG, SOURCE, POOL, "volume", "attempt").is_err());
        assert!(
            snapshot_count(
                &json!({"report":[{"lv":[]}]}),
                VG,
                SOURCE,
                POOL,
                "volume",
                "attempt"
            )
            .is_err()
        );
    }
    #[test]
    fn actual_origin_relationship_counts_a_differently_named_snapshot() {
        let mut report = source();
        report["report"][0]["lv"].as_array_mut().unwrap().push(json!({"vg_uuid":VG,"lv_uuid":SNAPSHOT,"lv_name":"different","lv_attr":"Vri-a-tz--","origin_uuid":SOURCE,"pool_lv_uuid":POOL}));
        assert_eq!(
            snapshot_count(&report, VG, SOURCE, POOL, "volume", "attempt").unwrap(),
            1
        );
        report["report"][0]["lv"].as_array_mut().unwrap().pop();
        assert_eq!(
            snapshot_count(&report, VG, SOURCE, POOL, "volume", "attempt").unwrap(),
            0
        );
    }
    #[test]
    fn duplicate_or_ambiguous_origin_metadata_is_unknown() {
        let mut duplicate = source();
        let row = duplicate["report"][0]["lv"][0].clone();
        duplicate["report"][0]["lv"]
            .as_array_mut()
            .unwrap()
            .push(row);
        assert!(snapshot_count(&duplicate, VG, SOURCE, POOL, "volume", "attempt").is_err());
        let mut ambiguous = source();
        ambiguous["report"][0]["lv"][0]["origin_uuid"] = "unknown".into();
        assert!(snapshot_count(&ambiguous, VG, SOURCE, POOL, "volume", "attempt").is_err());
        ambiguous["report"][0]["lv"][0]["origin_uuid"] = SNAPSHOT.into();
        assert!(snapshot_count(&ambiguous, VG, SOURCE, POOL, "volume", "attempt").is_err());
    }
}
