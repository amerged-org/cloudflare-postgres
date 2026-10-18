// SPDX-License-Identifier: Apache-2.0
//! What the agent reports about a database's archive, decided from facts alone (plan 7.5-7.7,
//! contract `NodeDatabaseObservation.archive` and `.backup`, `NodeSample.archive`): which WAL file
//! was archived last, how many wait and for how long, since when archiving fails, and the newest
//! DONE base backup. None of it depends on retention: the Worker deletes old backups and never
//! the newest DONE one.
use super::protocol::valid_name;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{io, path::Path};

/// One backup of `barman-cloud-backup-list --format json` (barman 3.20; the fields the agent
/// uses).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Backup {
    pub backup_id: String,
    pub status: String,
    pub timeline: u32,
    pub system_identifier: String,
    pub end_wal: Option<String>,
    /// When the backup ended, in milliseconds since the Unix epoch.
    pub completed_at_ms: Option<i64>,
    /// The size of a WAL segment of the backed-up cluster.
    pub segment_bytes: Option<u64>,
}
#[derive(Deserialize)]
struct Listing {
    backups_list: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    backup_id: String,
    status: String,
    timeline: Option<u32>,
    systemid: Option<String>,
    end_wal: Option<String>,
    end_time_iso: Option<String>,
    xlog_segment_size: Option<u64>,
}

/// The backups of a listing; `backup_list_unreadable` for anything else.
pub fn parse_backup_list(stdout: &str) -> Result<Vec<Backup>, &'static str> {
    let listing: Listing = serde_json::from_str(stdout).map_err(|_| "backup_list_unreadable")?;
    Ok(listing
        .backups_list
        .into_iter()
        .map(|entry| Backup {
            segment_bytes: entry.xlog_segment_size,
            backup_id: entry.backup_id,
            status: entry.status,
            timeline: entry.timeline.unwrap_or(0),
            system_identifier: entry.systemid.unwrap_or_default(),
            end_wal: entry.end_wal,
            completed_at_ms: entry.end_time_iso.and_then(|end| {
                let end = time::OffsetDateTime::parse(
                    &end,
                    &time::format_description::well_known::Iso8601::DEFAULT,
                )
                .ok()?;
                i64::try_from(end.unix_timestamp_nanos().div_euclid(1_000_000)).ok()
            }),
        })
        .collect())
}
/// The newest DONE backup: what a restore starts from and what a sleeping database keeps.
pub fn newest_done(backups: &[Backup]) -> Option<&Backup> {
    backups
        .iter()
        .filter(|backup| backup.status == "DONE" && backup.timeline >= 1)
        .filter_map(|backup| Some((backup.completed_at_ms?, backup)))
        .max_by(|(a, one), (b, other)| a.cmp(b).then_with(|| one.backup_id.cmp(&other.backup_id)))
        .map(|(_, backup)| backup)
}
/// A time as the contract writes it: UTC, milliseconds, `Z`.
pub fn timestamp(unix_ms: i64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(unix_ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}
/// `NodeDatabaseObservation.backup`: the newest DONE base backup, or null.
pub fn backup_observation(backup: Option<&Backup>) -> Value {
    match backup.and_then(|backup| Some((backup, backup.completed_at_ms?))) {
        Some((backup, completed_at)) => json!({
            "backup_id": backup.backup_id,
            "timeline": backup.timeline,
            "completed_at": timestamp(completed_at),
        }),
        None => Value::Null,
    }
}

/// A WAL file PostgreSQL has marked `.ready` and the time it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyFile {
    pub name: String,
    pub since_ms: i64,
}
/// The WAL files of `data_directory` that wait for archive, from `pg_wal/archive_status`.
pub fn ready_files(data_directory: &Path) -> io::Result<Vec<ReadyFile>> {
    let mut ready = Vec::new();
    for entry in std::fs::read_dir(data_directory.join("pg_wal/archive_status"))? {
        let entry = entry?;
        let file = entry.file_name();
        let Some(name) = file
            .to_str()
            .and_then(|file| file.strip_suffix(".ready"))
            .filter(|name| valid_name(name))
        else {
            continue;
        };
        let since = entry.metadata()?.modified()?;
        ready.push(ReadyFile {
            name: name.into(),
            since_ms: since
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as i64),
        });
    }
    ready.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ready)
}

/// What is known of one database's archive at `now_ms`; `None` is unknown, never zero.
pub struct ArchiveState<'a> {
    pub now_ms: i64,
    /// The newest segment in the upload log.
    pub last_segment: Option<&'a str>,
    /// The `.ready` files, or `None` when `archive_status` could not be read.
    pub ready: Option<&'a [ReadyFile]>,
    /// When the current run of failed archive calls began; `None` when the last call succeeded.
    pub failing_since_ms: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchiveFacts {
    pub last_segment: Option<String>,
    pub ready_files: Option<u64>,
    /// How long the oldest waiting file has waited; `None` when none waits or when unknown.
    pub oldest_ready_seconds: Option<u64>,
    pub failing_since: Option<String>,
}
pub fn archive_facts(state: &ArchiveState) -> ArchiveFacts {
    ArchiveFacts {
        last_segment: state.last_segment.map(Into::into),
        ready_files: state.ready.map(|ready| ready.len() as u64),
        oldest_ready_seconds: state
            .ready
            .and_then(|ready| ready.iter().map(|file| file.since_ms).min())
            .map(|since| (state.now_ms - since).max(0) as u64 / 1000),
        failing_since: state.failing_since_ms.map(timestamp),
    }
}
impl ArchiveFacts {
    /// `NodeDatabaseObservation.archive`.
    pub fn observation(&self) -> Value {
        json!({
            "last_segment": self.last_segment,
            "ready_files": self.ready_files,
            "failing_since": self.failing_since,
        })
    }
}
/// `NodeSample.archive` over the databases of the node: the files that wait, and the age of the
/// oldest. Unknown if any database is.
pub fn node_archive(databases: &[ArchiveFacts]) -> Value {
    let files: Option<u64> = databases.iter().map(|facts| facts.ready_files).sum();
    json!({
        "ready_files": files,
        "oldest_ready_seconds": files.and_then(|_| {
            databases.iter().filter_map(|facts| facts.oldest_ready_seconds).max()
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `barman-cloud-backup-list --format json`, barman 3.20.1 against PostgreSQL 18.6, captured
    /// from a real run on the node's systemd 257: a backup that failed (the backup role lacked a
    /// privilege) and the one that succeeded after the grant.
    const LISTING: &str = include_str!("barman-backup-list.json");

    fn backup(id: &str, status: &str, timeline: u32, end: Option<&str>) -> Backup {
        Backup {
            backup_id: id.into(),
            status: status.into(),
            timeline,
            system_identifier: "7697773764701949975".into(),
            end_wal: Some("000000010000000000000003".into()),
            completed_at_ms: end.map(|end| {
                (time::OffsetDateTime::parse(end, &time::format_description::well_known::Rfc3339)
                    .unwrap()
                    .unix_timestamp_nanos()
                    / 1_000_000) as i64
            }),
            segment_bytes: Some(1 << 20),
        }
    }

    #[test]
    fn a_real_listing_yields_its_backups() {
        let backups = parse_backup_list(LISTING).unwrap();
        assert_eq!(
            backups,
            [
                Backup {
                    backup_id: "20261017T232516".into(),
                    status: "FAILED".into(),
                    timeline: 1,
                    system_identifier: "7697781764826800331".into(),
                    end_wal: Some("000000010000000000000016".into()),
                    completed_at_ms: Some(1_792_279_520_372),
                    segment_bytes: Some(1 << 20),
                },
                Backup {
                    backup_id: "20261017T232528".into(),
                    status: "DONE".into(),
                    timeline: 1,
                    system_identifier: "7697781764826800331".into(),
                    end_wal: Some("000000010000000000000018".into()),
                    completed_at_ms: Some(1_792_279_533_233),
                    segment_bytes: Some(1 << 20),
                },
            ]
        );
        // The failed backup ended first and is no backup; the done one is the newest.
        assert_eq!(newest_done(&backups).unwrap().backup_id, "20261017T232528");
        assert_eq!(timestamp(1_792_279_533_233), "2026-10-17T23:25:33.233Z");
        assert_eq!(parse_backup_list(r#"{"backups_list": []}"#).unwrap(), []);
        for broken in [
            "",
            "[]",
            r#"{"backups_list": [{"status": "DONE"}]}"#,
            "Backup ID  End Time",
        ] {
            assert_eq!(
                parse_backup_list(broken),
                Err("backup_list_unreadable"),
                "{broken}"
            );
        }
    }

    #[test]
    fn the_newest_done_backup_is_the_one_reported_and_a_started_or_failed_one_never_is() {
        let backups = [
            backup("20261001T000000", "DONE", 1, Some("2026-10-01T00:05:00Z")),
            backup("20261003T000000", "DONE", 2, Some("2026-10-03T00:05:00Z")),
            backup("20261004T000000", "FAILED", 2, Some("2026-10-04T00:05:00Z")),
            backup("20261005T000000", "STARTED", 2, None),
        ];
        let newest = newest_done(&backups).unwrap();
        assert_eq!(newest.backup_id, "20261003T000000");
        assert_eq!(
            backup_observation(Some(newest)),
            json!({"backup_id": "20261003T000000", "timeline": 2, "completed_at": "2026-10-03T00:05:00.000Z"})
        );
        assert!(newest_done(&backups[2..]).is_none());
        assert!(newest_done(&[]).is_none());
        assert_eq!(backup_observation(None), Value::Null);
        // A DONE backup with no end time is no backup this agent can date.
        assert!(newest_done(&[backup("20261001T000000", "DONE", 1, None)]).is_none());
    }

    #[test]
    fn waiting_files_and_failures_become_the_archive_facts() {
        let ready = [
            ReadyFile {
                name: "000000010000000000000007".into(),
                since_ms: 100_000,
            },
            ReadyFile {
                name: "000000010000000000000008".into(),
                since_ms: 130_000,
            },
        ];
        let facts = archive_facts(&ArchiveState {
            now_ms: 161_900,
            last_segment: Some("000000010000000000000006"),
            ready: Some(&ready),
            failing_since_ms: Some(100_000),
        });
        assert_eq!(
            facts,
            ArchiveFacts {
                last_segment: Some("000000010000000000000006".into()),
                ready_files: Some(2),
                oldest_ready_seconds: Some(61),
                failing_since: Some("1970-01-01T00:01:40.000Z".into()),
            }
        );
        assert_eq!(
            facts.observation(),
            json!({"last_segment": "000000010000000000000006", "ready_files": 2, "failing_since": "1970-01-01T00:01:40.000Z"})
        );
        // Nothing waits: zero files, and no age.
        let idle = archive_facts(&ArchiveState {
            now_ms: 1_000,
            last_segment: None,
            ready: Some(&[]),
            failing_since_ms: None,
        });
        assert_eq!(idle.ready_files, Some(0));
        assert_eq!(idle.oldest_ready_seconds, None);
        assert_eq!(
            idle.observation(),
            json!({"last_segment": null, "ready_files": 0, "failing_since": null})
        );
        // A directory that could not be read is unknown, not empty.
        let unknown = archive_facts(&ArchiveState {
            now_ms: 1_000,
            last_segment: None,
            ready: None,
            failing_since_ms: None,
        });
        assert_eq!(
            (unknown.ready_files, unknown.oldest_ready_seconds),
            (None, None)
        );
        // A file that became ready after `now` (a clock step) has waited no time.
        let step = archive_facts(&ArchiveState {
            now_ms: 1_000,
            last_segment: None,
            ready: Some(&ready),
            failing_since_ms: None,
        });
        assert_eq!(step.oldest_ready_seconds, Some(0));
    }

    #[test]
    fn the_node_reports_the_sum_of_waiting_files_and_the_oldest_age() {
        let facts = |files: Option<u64>, oldest: Option<u64>| ArchiveFacts {
            last_segment: None,
            ready_files: files,
            oldest_ready_seconds: oldest,
            failing_since: None,
        };
        assert_eq!(
            node_archive(&[
                facts(Some(2), Some(61)),
                facts(Some(0), None),
                facts(Some(1), Some(130))
            ]),
            json!({"ready_files": 3, "oldest_ready_seconds": 130})
        );
        assert_eq!(
            node_archive(&[facts(Some(0), None)]),
            json!({"ready_files": 0, "oldest_ready_seconds": null})
        );
        assert_eq!(
            node_archive(&[facts(Some(2), Some(61)), facts(None, None)]),
            json!({"ready_files": null, "oldest_ready_seconds": null})
        );
        assert_eq!(
            node_archive(&[]),
            json!({"ready_files": 0, "oldest_ready_seconds": null})
        );
    }

    #[test]
    fn the_ready_files_of_a_data_directory_carry_the_time_they_appeared() {
        let directory = crate::archive::test_support::directory("ready");
        let status = directory.join("pg_wal/archive_status");
        std::fs::create_dir_all(&status).unwrap();
        std::fs::write(status.join("000000010000000000000007.ready"), "").unwrap();
        std::fs::write(status.join("000000010000000000000006.done"), "").unwrap();
        std::fs::write(status.join("not-a-segment.ready"), "").unwrap();
        let ready = ready_files(&directory).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].name, "000000010000000000000007");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!((now - ready[0].since_ms).abs() < 5_000);
        assert!(ready_files(&directory.join("missing")).is_err());
    }

    #[test]
    fn the_facts_are_what_the_node_contract_accepts() {
        let backups = parse_backup_list(LISTING).unwrap();
        let facts = archive_facts(&ArchiveState {
            now_ms: 1_792_277_700_000,
            last_segment: Some("000000010000000000000003"),
            ready: Some(&[ReadyFile {
                name: "000000010000000000000004".into(),
                since_ms: 1_792_277_690_000,
            }]),
            failing_since_ms: Some(1_792_277_690_000),
        });
        let report = |archive: Value| {
            json!({
                "observed_at": "2026-10-17T12:00:00.000Z",
                "databases": [{
                    "id": "abcdefghijklmnopqrst",
                    "generation": 3,
                    "operation": format!("op_{}", "a".repeat(20)),
                    "storage_generation": 1,
                    "state": "ready",
                    "instance": "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
                    "proven_sleep": null,
                    "backup": backup_observation(newest_done(&backups)),
                    "archive": archive,
                }],
                "orders": [],
            })
        };
        assert!(crate::node_link::contract_valid(
            "NodeObservationReport",
            &report(facts.observation())
        ));
        // An unknown count is null, and the contract has no other way to say it.
        let unknown = archive_facts(&ArchiveState {
            now_ms: 1,
            last_segment: None,
            ready: None,
            failing_since_ms: None,
        });
        assert!(crate::node_link::contract_valid(
            "NodeObservationReport",
            &report(unknown.observation())
        ));
        let mut wrong = facts.observation();
        wrong["ready_files"] = json!("1");
        assert!(!crate::node_link::contract_valid(
            "NodeObservationReport",
            &report(wrong)
        ));
        assert_eq!(
            node_archive(&[facts]),
            json!({"ready_files": 1, "oldest_ready_seconds": 10})
        );
    }
}
