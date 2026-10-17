// SPDX-License-Identifier: Apache-2.0
//! The health of a database's continuous archive: its WAL queue and the archiver's progress,
//! judged stalled once nothing advanced for `ARCHIVE_FAILURE_MS`.
use crate::{Error, contracts::integer};
use serde_json::{Value, json};
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
}
