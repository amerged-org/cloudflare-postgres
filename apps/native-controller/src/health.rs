// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{generation, integer, namespace, number, text},
    kubernetes::Kubernetes,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
const SYSTEM: &str = "pgcf-system";
const PROGRESS: &str = "pgcf.io/archive-observation";
const UNKNOWN: &str = "pgcf.io/archive-unknown-since";
const PLUGIN: &str = "barman-cloud.cloudnative-pg.io";
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn iso(t: i64) -> Result<String, Error> {
    let t = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(t) * 1_000_000)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        u8::from(t.month()),
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    ))
}
fn time_ms(t: &Value, now: i64) -> Result<i64, Error> {
    let s = t.as_str().ok_or("backup time missing")?;
    if !s.ends_with('Z') {
        return Err("backup time is not UTC".into());
    }
    let t = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)?;
    let ms = (t.unix_timestamp_nanos() / 1_000_000) as i64;
    if ms < 0 || ms > now {
        return Err("backup time invalid".into());
    }
    Ok(ms)
}
fn owned(v: &Value, db: &Value, ns: Option<&str>) -> Result<(), Error> {
    if text(&v["metadata"], "uid").is_empty()
        || text(&v["metadata"], "resourceVersion").is_empty()
        || v["metadata"]["namespace"].as_str() != ns
        || v["metadata"]["labels"]["pgcf.io/database-id"] != db["id"]
        || !v["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("health resource ownership changed".into());
    }
    Ok(())
}
fn fingerprint(v: &Value) -> Value {
    let mut metadata = v["metadata"].clone();
    metadata
        .as_object_mut()
        .map(|m| m.remove("resourceVersion"));
    json!({"metadata":metadata,"spec":v["spec"]})
}
#[derive(Clone, Copy, Debug)]
pub struct ArchiveSample {
    pub count: u64,
    pub progress: Option<(u64, f64)>,
    pub valid: bool,
}
fn progress_valid(count: u64, t: f64, now: i64) -> bool {
    count <= 9_007_199_254_740_991
        && t.is_finite()
        && (t >= 0.0 || (count == 0 && t == -1.0))
        && t <= now as f64 / 1000.0
        && (count == 0 || t != 0.0)
}
fn metric_value(tail: &str) -> Result<f64, Error> {
    let parts: Vec<_> = tail.split_whitespace().collect();
    if parts.is_empty()
        || parts.len() > 2
        || parts.len() == 2 && !parts[1].bytes().all(|b| b.is_ascii_digit())
    {
        return Err("archive metric invalid".into());
    }
    let value = parts[0].parse::<f64>()?;
    if !value.is_finite() {
        return Err("archive metric invalid".into());
    }
    Ok(value)
}
fn metric(source: &str, name: &str) -> Result<Option<f64>, Error> {
    let mut rows = source.lines().filter(|line| {
        line.strip_prefix(name)
            .is_some_and(|tail| tail.starts_with('{') || tail.starts_with(char::is_whitespace))
    });
    let Some(line) = rows.next() else {
        return Ok(None);
    };
    if rows.next().is_some() {
        return Err("archive metric ambiguous".into());
    }
    let tail = line.strip_prefix(name).ok_or("archive metric missing")?;
    let tail = if tail.starts_with('{') {
        tail.split_once('}').ok_or("archive metric invalid")?.1
    } else {
        tail
    };
    let v = metric_value(tail)?;
    Ok(Some(v))
}
pub fn metrics(source: &str, now: i64) -> Result<ArchiveSample, Error> {
    let rows: Vec<_> = source
        .lines()
        .filter(|line| {
            line.starts_with("cnpg_collector_pg_wal_archive_status{")
                && line.split_once('}').is_some_and(|(labels, _)| {
                    labels.split(',').any(|label| {
                        label == "value=\"ready\"" || label.ends_with("{value=\"ready\"")
                    })
                })
        })
        .collect();
    if rows.len() != 1 {
        return Err("WAL queue metric ambiguous".into());
    }
    let count = metric_value(rows[0].split_once('}').ok_or("WAL queue metric invalid")?.1)?;
    if !count.is_finite() || count < 0.0 || count.fract() != 0.0 || count > 9_007_199_254_740_991.0
    {
        return Err("WAL queue metric invalid".into());
    }
    let a = metric(source, "cnpg_pg_stat_archiver_archived_count");
    let t = metric(source, "cnpg_pg_stat_archiver_last_archived_time");
    let (progress, valid) = match (a, t) {
        (Ok(None), Ok(None)) => (None, count == 0.0),
        (Ok(Some(a)), Ok(Some(t)))
            if a >= 0.0
                && a.fract() == 0.0
                && a <= 9_007_199_254_740_991.0
                && progress_valid(a as u64, t, now) =>
        {
            (Some((a as u64, t)), true)
        }
        _ => (None, false),
    };
    Ok(ArchiveSample {
        count: count as u64,
        progress,
        valid,
    })
}
pub fn archive_transition(
    saved: Option<&str>,
    sample: Option<ArchiveSample>,
    now: i64,
) -> Result<(Option<String>, Option<bool>), Error> {
    let previous = if let Some(saved) = saved {
        let v: Value = serde_json::from_str(saved)?;
        if v.as_object().is_none_or(|v| {
            v.len() != 3
                || !["archivedCount", "lastArchivedTime", "pendingSince"]
                    .iter()
                    .all(|key| v.contains_key(*key))
        }) {
            return Err("archive observation invalid".into());
        }
        let count = integer(&v, "archivedCount")?;
        let time = v["lastArchivedTime"]
            .as_f64()
            .ok_or("archive timestamp invalid")?;
        if !progress_valid(count, time, now)
            || !v["pendingSince"].is_null()
                && integer(&v, "pendingSince")
                    .ok()
                    .and_then(|t| i64::try_from(t).ok())
                    .is_none_or(|t| t > now)
        {
            return Err("archive observation invalid".into());
        }
        Some(v)
    } else {
        None
    };
    let Some(sample) = sample.filter(|s| s.valid) else {
        return Ok((None, None));
    };
    if sample.count > 0 && sample.progress.is_none() {
        return Ok((None, None));
    }
    if sample.count == 0 && previous.is_none() {
        return Ok((None, Some(false)));
    }
    let (count, t) = match sample.progress {
        Some(progress) => progress,
        None => {
            let previous = previous.as_ref().ok_or("archive baseline missing")?;
            (
                integer(previous, "archivedCount")?,
                previous["lastArchivedTime"]
                    .as_f64()
                    .ok_or("archive baseline missing")?,
            )
        }
    };
    let advanced = previous.as_ref().is_some_and(|p| {
        count >= integer(p, "archivedCount").unwrap_or(u64::MAX)
            && t >= p["lastArchivedTime"].as_f64().unwrap_or(f64::INFINITY)
            && (count > integer(p, "archivedCount").unwrap_or(u64::MAX)
                || t > p["lastArchivedTime"].as_f64().unwrap_or(f64::INFINITY))
    });
    let pending = if sample.count == 0 {
        None
    } else if advanced {
        Some(now)
    } else {
        Some(
            previous
                .as_ref()
                .and_then(|p| integer(p, "pendingSince").ok())
                .and_then(|t| i64::try_from(t).ok())
                .unwrap_or(now),
        )
    };
    let next = json!({"archivedCount":count,"lastArchivedTime":t,"pendingSince":pending});
    Ok((
        Some(serde_json::to_string(&next)?),
        Some(pending.is_some_and(|t| {
            now - t
                >= crate::contracts::constant("ARCHIVE_FAILURE_MS")
                    .as_i64()
                    .unwrap_or(i64::MAX)
        })),
    ))
}
pub async fn archive_health(
    kube: &Kubernetes,
    db: &Value,
    cluster: &Value,
    sample: Option<ArchiveSample>,
) -> Result<(Value, bool), Error> {
    let now = now_ms();
    let name = format!("storage-{}", text(db, "id"));
    let fence = kube
        .read("ConfigMap", Some(SYSTEM), &name)
        .await?
        .ok_or("archive storage receipt missing")?;
    owned(&fence, db, Some(SYSTEM))?;
    if generation(&fence) != number(db, "generation") {
        return Err("archive storage revision changed".into());
    }
    let saved = fence["metadata"]["annotations"][PROGRESS].as_str();
    let (next, stalled) = archive_transition(saved, sample, now)?;
    let queue = sample.map(|s| s.count);
    let backlog = queue.is_some_and(|n| {
        n >= crate::contracts::constant("WAL_BACKLOG_LIMIT")
            .as_u64()
            .unwrap_or(0)
    });
    let condition = cluster["status"]["conditions"]
        .as_array()
        .and_then(|c| c.iter().find(|c| text(c, "type") == "ContinuousArchiving"));
    let status = condition.map(|c| text(c, "status"));
    let continuous = status == Some("True")
        && sample.is_some_and(|s| {
            s.valid
                && (s.count == 0 || s.progress.is_some_and(|(_, t)| t != -1.0) && stalled.is_some())
        })
        && !backlog
        && stalled != Some(true);
    let failing = stalled == Some(true) || backlog || status == Some("False");
    let health = if continuous {
        "ok"
    } else if failing {
        "failing"
    } else {
        "unknown"
    };
    let prior = fence["metadata"]["annotations"][UNKNOWN]
        .as_str()
        .map(|v| {
            let parsed = v.parse::<i64>()?;
            if parsed.to_string() != v {
                return Err::<i64, Error>("archive unknown observation invalid".into());
            }
            Ok(parsed)
        })
        .transpose()?;
    if prior.is_some_and(|t| t < 0 || t > now) {
        return Err("archive unknown clock invalid".into());
    }
    let unknown = if health == "unknown" {
        Some(prior.unwrap_or(now))
    } else {
        None
    };
    let mut annotations = json!({});
    if let Some(next) = next.as_deref()
        && saved != Some(next)
    {
        annotations[PROGRESS] = next.into();
    }
    if prior != unknown {
        annotations[UNKNOWN] = unknown.map(|n| n.to_string()).into();
    }
    if annotations.as_object().is_some_and(|a| !a.is_empty()) {
        let changed = kube
            .patch(&fence, &json!({"metadata":{"annotations":annotations}}))
            .await?;
        if changed["data"]["state"] != fence["data"]["state"]
            || generation(&changed) != number(db, "generation")
        {
            return Err("archive receipt changed".into());
        }
        for (k, v) in annotations
            .as_object()
            .ok_or("archive annotations invalid")?
        {
            if changed["metadata"]["annotations"][k] != *v {
                return Err("archive annotation readback changed".into());
            }
        }
    }
    let false_long = status == Some("False")
        && condition
            .and_then(|c| time_ms(&c["lastTransitionTime"], now).ok())
            .is_some_and(|t| {
                now - t
                    >= crate::contracts::constant("ARCHIVE_FAILURE_MS")
                        .as_i64()
                        .unwrap_or(i64::MAX)
            });
    Ok((
        json!({"continuous":continuous,"ready_wal_files":queue,"health":health}),
        stalled == Some(true)
            || backlog
            || false_long
            || unknown.is_some_and(|t| {
                now - t
                    >= crate::contracts::constant("ARCHIVE_FAILURE_MS")
                        .as_i64()
                        .unwrap_or(i64::MAX)
            }),
    ))
}
struct BackupEntry {
    namespace_uid: Value,
    cluster_uid: Value,
    generation: u64,
    archive: Value,
    at: i64,
    result: Value,
}
#[derive(Default)]
pub struct Health {
    backups: Mutex<HashMap<String, BackupEntry>>,
}
impl Health {
    pub fn backup(&self, db: &Value, ns: &Value, cluster: &Value) -> Value {
        let now = now_ms();
        if let Ok(cache) = self.backups.lock()
            && let Some(entry) = cache.get(text(db, "id"))
            && entry.namespace_uid == ns["metadata"]["uid"]
            && entry.cluster_uid == cluster["metadata"]["uid"]
            && entry.generation == number(db, "generation")
            && entry.archive == db["archive"]
            && now >= entry.at
            && now - entry.at < 120_000
        {
            return entry.result.clone();
        }
        json!({"observed_at":iso(now).unwrap_or_default(),"health":"unknown","last_completed_at":null,"last_failed_at":null})
    }
    pub async fn refresh(&self, kube: &Kubernetes, db: &Value) -> Result<(), Error> {
        let now = now_ms();
        let result = collect_backup(kube, db, now).await;
        let mut cache = self
            .backups
            .lock()
            .map_err(|_| "backup cache unavailable")?;
        match result {
            Ok((ns, cluster, result)) => {
                if cache.len() >= 10_000
                    && !cache.contains_key(text(db, "id"))
                    && let Some(key) = cache.keys().next().cloned()
                {
                    cache.remove(&key);
                }
                cache.insert(
                    text(db, "id").to_string(),
                    BackupEntry {
                        namespace_uid: ns["metadata"]["uid"].clone(),
                        cluster_uid: cluster["metadata"]["uid"].clone(),
                        generation: number(db, "generation"),
                        archive: db["archive"].clone(),
                        at: now,
                        result,
                    },
                );
            }
            Err(_) => {
                cache.remove(text(db, "id"));
            }
        }
        Ok(())
    }
}
pub fn backup_inventory(
    db: &Value,
    cluster: &Value,
    backups: &[Value],
    store_name: &str,
    now: i64,
) -> Result<Value, Error> {
    let ns = namespace(db);
    let mut ids = HashSet::new();
    let (mut completed, mut failed): (Option<i64>, Option<i64>) = (None, None);
    for backup in backups {
        let id = text(&backup["metadata"], "uid");
        if id.is_empty()
            || !ids.insert(id)
            || text(backup, "kind") != "Backup"
            || backup["apiVersion"] != cluster["apiVersion"]
            || backup["metadata"]["namespace"] != ns
            || text(&backup["metadata"], "resourceVersion").is_empty()
            || !backup["metadata"]["deletionTimestamp"].is_null()
        {
            return Err("backup inventory identity invalid".into());
        }
        let source = text(&backup["spec"]["cluster"], "name");
        if source.is_empty() {
            return Err("backup source missing".into());
        }
        if source != text(&cluster["metadata"], "name") {
            continue;
        }
        let config = &backup["spec"]["pluginConfiguration"];
        if backup["spec"]["method"] != "plugin" || config["name"] != PLUGIN {
            return Err("backup plugin invalid".into());
        }
        for (holder, key, expected) in [
            (
                &config["parameters"],
                "barmanObjectName",
                Value::String(store_name.into()),
            ),
            (
                &config["parameters"],
                "serverName",
                db["archive"]["server_name"].clone(),
            ),
            (
                &backup["status"],
                "destinationPath",
                db["archive"]["destination_path"].clone(),
            ),
            (
                &backup["status"],
                "serverName",
                db["archive"]["server_name"].clone(),
            ),
        ] {
            if !holder[key].is_null() && holder[key] != expected {
                return Err("backup archive binding changed".into());
            }
        }
        let owners: Vec<_> = backup["metadata"]["ownerReferences"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["kind"] == cluster["kind"])
            .collect();
        let exact = owners.len() == 1
            && owners[0]["uid"] == cluster["metadata"]["uid"]
            && owners[0]["name"] == cluster["metadata"]["name"]
            && owners[0]["apiVersion"] == cluster["apiVersion"];
        if !owners.is_empty() && !exact {
            return Err("backup cluster owner changed".into());
        }
        let status = &backup["status"];
        let metadata = &status["pluginMetadata"];
        if !metadata["clusterUID"].is_null() && metadata["clusterUID"] != cluster["metadata"]["uid"]
        {
            return Err("backup plugin cluster changed".into());
        }
        let phase = text(status, "phase");
        if ["pending", "started", "running", "finalizing"].contains(&phase) {
            continue;
        }
        let created = time_ms(&backup["metadata"]["creationTimestamp"], now)?;
        let terminated = time_ms(&status["reconciliationTerminatedAt"], now)?;
        if terminated < created {
            return Err("backup completion clock invalid".into());
        }
        match phase {
            "completed" => {
                let started = time_ms(&status["startedAt"], now)?;
                let stopped = time_ms(&status["stoppedAt"], now)?;
                let id = text(status, "backupId");
                if metadata["clusterUID"] != cluster["metadata"]["uid"]
                    || metadata["pluginName"] != PLUGIN
                    || id.is_empty()
                    || id.len() > 253
                    || started < created
                    || stopped < started
                    || stopped > terminated
                {
                    return Err("backup completion unproven".into());
                }
                completed = Some(completed.map_or(stopped, |old| old.max(stopped)));
            }
            "failed" => {
                if !exact {
                    return Err("failed backup owner unproven".into());
                }
                failed = Some(failed.map_or(terminated, |old| old.max(terminated)));
            }
            _ => return Err("backup phase unknown".into()),
        }
    }
    let health = if failed.is_some_and(|f| completed.is_none_or(|c| f >= c)) {
        "failing"
    } else if completed.is_some() {
        "ok"
    } else {
        "unknown"
    };
    Ok(
        json!({"observed_at":iso(now)?,"health":health,"last_completed_at":completed.map(iso).transpose()?,"last_failed_at":failed.map(iso).transpose()?}),
    )
}
async fn collect_backup(
    kube: &Kubernetes,
    db: &Value,
    now: i64,
) -> Result<(Value, Value, Value), Error> {
    let ns = namespace(db);
    let (namespace, cluster) = tokio::try_join!(
        kube.read("Namespace", None, &ns),
        kube.read("Cluster", Some(&ns), "database")
    )?;
    let namespace = namespace.ok_or("backup Namespace missing")?;
    let cluster = cluster.ok_or("backup Cluster missing")?;
    owned(&namespace, db, None)?;
    owned(&cluster, db, Some(&ns))?;
    if cluster["apiVersion"] != "postgresql.cnpg.io/v1" {
        return Err("backup Cluster API version unknown".into());
    }
    let plugins: Vec<_> = cluster["spec"]["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["name"] == PLUGIN)
        .collect();
    if plugins.len() != 1
        || plugins[0]["enabled"] != true
        || plugins[0]["isWALArchiver"] != true
        || plugins[0]["parameters"]["serverName"] != db["archive"]["server_name"]
    {
        return Err("backup archiver unknown".into());
    }
    let name = text(&plugins[0]["parameters"], "barmanObjectName");
    let store = kube
        .read("ObjectStore", Some(&ns), name)
        .await?
        .ok_or("backup ObjectStore missing")?;
    owned(&store, db, Some(&ns))?;
    if store["apiVersion"] != "barmancloud.cnpg.io/v1"
        || store["spec"]["configuration"]["destinationPath"] != db["archive"]["destination_path"]
    {
        return Err("backup ObjectStore changed".into());
    }
    let backups = kube.list("Backup", Some(&ns), None).await?;
    let result = backup_inventory(db, &cluster, &backups, name, now)?;
    for before in [&namespace, &cluster, &store] {
        let after = kube
            .read(
                text(before, "kind"),
                before["metadata"]["namespace"].as_str(),
                text(&before["metadata"], "name"),
            )
            .await?
            .ok_or("backup owner disappeared")?;
        owned(&after, db, before["metadata"]["namespace"].as_str())?;
        if fingerprint(before) != fingerprint(&after) {
            return Err("backup owner changed during read".into());
        }
    }
    Ok((namespace, cluster, result))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stalled_queue_survives_restart_and_counter_reset() {
        let first = ArchiveSample {
            count: 1,
            progress: Some((10, 1.0)),
            valid: true,
        };
        let (saved, stalled) = archive_transition(None, Some(first), 10_000).unwrap();
        assert_eq!(stalled, Some(false));
        assert_eq!(
            archive_transition(saved.as_deref(), Some(first), 610_000)
                .unwrap()
                .1,
            Some(true)
        );
        let reset = ArchiveSample {
            progress: Some((0, -1.0)),
            ..first
        };
        assert_eq!(
            archive_transition(saved.as_deref(), Some(reset), 610_000)
                .unwrap()
                .1,
            Some(true)
        );
        let advanced = ArchiveSample {
            progress: Some((11, 600.0)),
            ..first
        };
        assert_eq!(
            archive_transition(saved.as_deref(), Some(advanced), 610_000)
                .unwrap()
                .1,
            Some(false)
        );
        assert!(archive_transition(saved.as_deref(), None, 0).is_err());
    }
    #[test]
    fn missing_or_partial_metrics_never_become_healthy_empty_queue() {
        let zero = "cnpg_collector_pg_wal_archive_status{value=\"ready\"} 0";
        assert!(metrics(zero, 1_000).unwrap().valid);
        assert!(
            !metrics(
                &format!("{zero}\ncnpg_pg_stat_archiver_archived_count 0"),
                1_000
            )
            .unwrap()
            .valid
        );
        let malformed=metrics("cnpg_collector_pg_wal_archive_status{value=\"ready\"} 32\ncnpg_pg_stat_archiver_archived_count broken",1000).unwrap();
        assert_eq!(malformed.count, 32);
        assert!(!malformed.valid);
        assert!(metrics(&zero.replace(" 0", " 1"), 1_000).is_ok_and(|s| !s.valid));
        assert!(metrics(&format!("{zero}\n{zero}"), 1_000).is_err());
    }
    #[test]
    fn completed_backup_requires_actual_cluster_and_plugin_receipts() {
        let db = json!({"id":"db","archive":{"destination_path":"s3://bucket/db","server_name":"database"}});
        let cluster = json!({"kind":"Cluster","apiVersion":"postgresql.cnpg.io/v1","metadata":{"name":"database","uid":"cluster"}});
        let backup = json!({"kind":"Backup","apiVersion":"postgresql.cnpg.io/v1","metadata":{"namespace":"pgcf-db-db","uid":"backup","resourceVersion":"1","creationTimestamp":"1970-01-01T00:00:00.000Z"},"spec":{"cluster":{"name":"database"},"method":"plugin","pluginConfiguration":{"name":PLUGIN}},"status":{"phase":"completed","startedAt":"1970-01-01T00:00:01.000Z","stoppedAt":"1970-01-01T00:00:02.000Z","reconciliationTerminatedAt":"1970-01-01T00:00:03.000Z","backupId":"actual","pluginMetadata":{"clusterUID":"cluster","pluginName":PLUGIN}}});
        assert_eq!(
            backup_inventory(
                &db,
                &cluster,
                std::slice::from_ref(&backup),
                "archive",
                4000
            )
            .unwrap()["health"],
            "ok"
        );
        let mut wrong = backup.clone();
        wrong["status"]["pluginMetadata"]["clusterUID"] = "old".into();
        assert!(backup_inventory(&db, &cluster, &[wrong], "archive", 4000).is_err());
        assert!(
            backup_inventory(&db, &cluster, &[backup.clone(), backup], "archive", 4000).is_err()
        );
    }
}
