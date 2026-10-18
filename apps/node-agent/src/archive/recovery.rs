// SPDX-License-Identifier: Apache-2.0
//! The recovery of a restore, a point-in-time restore and a move target (plan 7.8, 9.5): a new
//! database starts from the base backup `barman-cloud-restore` wrote into its empty volume and
//! replays WAL, which `restore_command` fetches through the archive socket. The settings live in a
//! file of their own that the database's `postgresql.conf` includes with
//! `include_if_exists = 'pgcf-recovery.conf'`, so that the agent removes them without editing
//! the configuration (step 5).
use super::facts::Backup;
use std::{
    io,
    path::{Path, PathBuf},
};

/// The `restore_command` client the node image installs: it asks the archive socket for `%f` and
/// places it at `%p`.
pub const WAL_FETCH_COMMAND: &str = "/usr/libexec/pgcf/pgcf-wal-fetch";
pub const SETTINGS_FILE: &str = "pgcf-recovery.conf";
/// PostgreSQL starts archive recovery when this file exists, and removes it when it promotes.
pub const SIGNAL_FILE: &str = "recovery.signal";

/// The recovery settings: fetch through the archive socket, follow the latest timeline, and for a
/// point in time (`target_time`, a contract timestamp) stop there and promote. Without a target
/// the recovery ends where the archive does, and PostgreSQL promotes. `None` for a time that is
/// not a contract timestamp. PostgreSQL 18 refuses `Z` here, which it reads as a time zone
/// abbreviation, so the time is written with a numeric offset.
pub fn settings(fetch_command: &str, target_time: Option<&str>) -> Option<String> {
    let plain_path = fetch_command.starts_with('/')
        && fetch_command
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'));
    if !plain_path {
        return None;
    }
    let mut settings =
        format!("restore_command = '{fetch_command} %f %p'\nrecovery_target_timeline = 'latest'\n");
    if let Some(time) = target_time {
        let contract_timestamp = time.len() == 24
            && time.ends_with('Z')
            && time::OffsetDateTime::parse(time, &time::format_description::well_known::Rfc3339)
                .is_ok();
        if !contract_timestamp {
            return None;
        }
        settings.push_str(&format!(
            "recovery_target_time = '{} {}+00'\nrecovery_target_action = 'promote'\n",
            &time[..10],
            &time[11..23]
        ));
    }
    Some(settings)
}
/// The spool of one operation's `barman-cloud-wal-restore -p`: a directory of its own, never
/// barman's shared default, where two restores could receive each other's WAL.
pub fn spool_directory(volume: &Path, operation: &str) -> PathBuf {
    volume.join(format!("spool-{operation}"))
}
/// An entry that is not there is as good as removed.
fn absent_is_done(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
/// Writes the settings and the signal file into the restored data directory, readable by the
/// database's user alone.
///
/// The directory is the source database's, and its user can leave anything under either name,
/// while the agent runs as root. An entry that is there is unlinked, which follows nothing and
/// does not wait on a pipe. The file is then created exclusively, which fails on a link that
/// appears in between instead of following it, and is handed over by its descriptor.
pub fn prepare(data_directory: &Path, settings: &str, uid: u32, gid: u32) -> io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    if !std::fs::symlink_metadata(data_directory)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the restored data directory is no directory",
        ));
    }
    for (file, content) in [(SETTINGS_FILE, settings), (SIGNAL_FILE, "")] {
        absent_is_done(std::fs::remove_file(data_directory.join(file)))?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(data_directory.join(file))?;
        file.write_all(content.as_bytes())?;
        std::os::unix::fs::fchown(&file, Some(uid), Some(gid))?;
        file.sync_all()?;
    }
    std::fs::File::open(data_directory)?.sync_all()
}
/// Removes the settings, the signal file and the operation's spool.
pub fn finish(data_directory: &Path, spool: &Path) -> io::Result<()> {
    absent_is_done(std::fs::remove_file(data_directory.join(SETTINGS_FILE)))?;
    absent_is_done(std::fs::remove_file(data_directory.join(SIGNAL_FILE)))?;
    absent_is_done(std::fs::remove_dir_all(spool))
}

/// What the promoted database says of itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Restored {
    pub in_recovery: bool,
    pub system_identifier: String,
    pub timeline: u32,
}
/// Whether the database is the one the backup came from and has left recovery on a later
/// timeline (plan 7.8 step 4). A move target must also be the database of the source's
/// proven-sleep record, `end` (system identifier and timeline), on a timeline after it (9.5).
/// The error is the node contract's `identity_mismatch` or `no_recovery_point`.
pub fn verify_restored(
    backup: &Backup,
    end: Option<(&str, u32)>,
    restored: &Restored,
) -> Result<(), &'static str> {
    let identity = |system_identifier: &str| restored.system_identifier == system_identifier;
    if !identity(&backup.system_identifier) || end.is_some_and(|(id, _)| !identity(id)) {
        return Err("identity_mismatch");
    }
    let later = |timeline: u32| restored.timeline > timeline;
    if restored.in_recovery || !later(backup.timeline) || end.is_some_and(|(_, tl)| !later(tl)) {
        return Err("no_recovery_point");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[test]
    fn recovery_fetches_through_the_socket_and_stops_where_the_order_says() {
        assert_eq!(
            settings(WAL_FETCH_COMMAND, None).unwrap(),
            "restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'\nrecovery_target_timeline = 'latest'\n"
        );
        assert_eq!(
            settings(WAL_FETCH_COMMAND, Some("2026-10-17T22:53:45.664Z")).unwrap(),
            "restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'\nrecovery_target_timeline = 'latest'\nrecovery_target_time = '2026-10-17 22:53:45.664+00'\nrecovery_target_action = 'promote'\n"
        );
        for bad in [
            "",
            "2026-10-17 22:53:45",
            "2026-10-17T22:53:45Z",
            "2026-10-17T22:53:45.664+02:00",
            "2026-10-17T22:53:45.664Z'\nrestore_command = 'x",
            "2026-13-17T22:53:45.664Z",
            "'; DROP",
        ] {
            assert_eq!(settings(WAL_FETCH_COMMAND, Some(bad)), None, "{bad:?}");
        }
    }

    #[test]
    fn the_fetch_command_is_a_plain_absolute_path() {
        assert!(settings("/opt/pgcf/bin/wal-fetch_2", None).is_some());
        for bad in ["", "wal-fetch", "/a b", "/a'; touch /x; '", "/a%f", "/a\nb"] {
            assert_eq!(settings(bad, None), None, "{bad:?}");
        }
    }

    #[test]
    fn the_spool_of_an_operation_is_beside_the_data_directory_and_named_for_the_operation() {
        let operation = format!("op_{}", "b".repeat(20));
        assert_eq!(
            spool_directory(Path::new("/var/lib/pgcf/db/abc"), &operation),
            Path::new("/var/lib/pgcf/db/abc").join(format!("spool-{operation}"))
        );
    }

    #[test]
    fn prepare_makes_the_directory_recover_and_finish_leaves_nothing_of_it() {
        let volume = crate::archive::test_support::directory("recovery");
        let data = volume.join("data");
        let spool = spool_directory(&volume, "op_cccccccccccccccccccc");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&spool).unwrap();
        std::fs::write(spool.join("000000010000000000000009"), b"prefetched").unwrap();
        let text = settings(WAL_FETCH_COMMAND, Some("2026-10-17T22:53:45.664Z")).unwrap();
        // The directory's own user and group, here the test's.
        let owner = std::fs::metadata(&data).unwrap();
        prepare(&data, &text, owner.uid(), owner.gid()).unwrap();
        assert_eq!(
            std::fs::read_to_string(data.join(SETTINGS_FILE)).unwrap(),
            text
        );
        assert!(data.join(SIGNAL_FILE).exists());
        for file in [SETTINGS_FILE, SIGNAL_FILE] {
            assert_eq!(
                std::fs::metadata(data.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
                "{file}"
            );
        }
        finish(&data, &spool).unwrap();
        assert!(!data.join(SETTINGS_FILE).exists());
        assert!(!data.join(SIGNAL_FILE).exists());
        assert!(!spool.exists());
        // Finishing twice, or after PostgreSQL removed its signal file, is not an error.
        finish(&data, &spool).unwrap();
    }

    /// Runs `prepare` where a pipe could block it, and gives it five seconds.
    fn prepare_within_five_seconds(data: &Path, text: &str) -> io::Result<()> {
        let owner = std::fs::metadata(data).unwrap();
        let (data, text) = (data.to_path_buf(), text.to_string());
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(prepare(&data, &text, owner.uid(), owner.gid()));
        });
        receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("prepare blocked on an entry of the restored directory")
    }

    /// The restored directory is the source database's: its user can leave a link or a pipe under
    /// either name for the agent, which prepares the directory as root.
    #[test]
    fn prepare_replaces_a_link_or_a_pipe_of_the_restored_directory_and_follows_none() {
        let volume = crate::archive::test_support::directory("planted");
        let data = volume.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let state = volume.join("agent-state");
        std::fs::write(&state, "fence").unwrap();
        std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o640)).unwrap();
        let created = volume.join("created-by-a-link");
        // One link to a file of the node, one to a file that does not exist.
        std::os::unix::fs::symlink("../agent-state", data.join(SETTINGS_FILE)).unwrap();
        std::os::unix::fs::symlink(&created, data.join(SIGNAL_FILE)).unwrap();
        prepare_within_five_seconds(&data, "restore_command = 'x %f %p'\n").unwrap();
        assert_eq!(std::fs::read_to_string(&state).unwrap(), "fence");
        assert_eq!(
            std::fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert!(!created.exists());
        for file in [SETTINGS_FILE, SIGNAL_FILE] {
            let metadata = std::fs::symlink_metadata(data.join(file)).unwrap();
            assert!(metadata.file_type().is_file(), "{file}");
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600, "{file}");
        }
        assert_eq!(
            std::fs::read_to_string(data.join(SETTINGS_FILE)).unwrap(),
            "restore_command = 'x %f %p'\n"
        );

        // A pipe would block an agent that opens it.
        let piped = volume.join("piped");
        std::fs::create_dir_all(&piped).unwrap();
        for file in [SETTINGS_FILE, SIGNAL_FILE] {
            let made = std::process::Command::new("mkfifo")
                .arg(piped.join(file))
                .status()
                .unwrap();
            assert!(made.success());
        }
        prepare_within_five_seconds(&piped, "a = 1\n").unwrap();
        for file in [SETTINGS_FILE, SIGNAL_FILE] {
            let metadata = std::fs::symlink_metadata(piped.join(file)).unwrap();
            assert!(metadata.file_type().is_file(), "{file}");
        }
        assert_eq!(
            std::fs::read_to_string(piped.join(SETTINGS_FILE)).unwrap(),
            "a = 1\n"
        );
    }

    #[test]
    fn prepare_refuses_a_data_directory_that_is_a_link_and_a_directory_in_place_of_a_file() {
        let volume = crate::archive::test_support::directory("planted-directory");
        let elsewhere = volume.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, volume.join("data")).unwrap();
        assert!(prepare_within_five_seconds(&volume.join("data"), "a = 1\n").is_err());
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none());

        let data = volume.join("real");
        std::fs::create_dir_all(data.join(SETTINGS_FILE)).unwrap();
        std::fs::write(data.join(SETTINGS_FILE).join("kept"), "x").unwrap();
        assert!(prepare_within_five_seconds(&data, "a = 1\n").is_err());
        assert!(data.join(SETTINGS_FILE).join("kept").exists());
    }

    fn backup() -> Backup {
        Backup {
            backup_id: "20261017T225342".into(),
            status: "DONE".into(),
            timeline: 1,
            system_identifier: "7697773764701949975".into(),
            end_wal: Some("000000010000000000000003".into()),
            completed_at_ms: Some(1),
            segment_bytes: Some(1 << 20),
        }
    }
    fn restored(in_recovery: bool, system_identifier: &str, timeline: u32) -> Restored {
        Restored {
            in_recovery,
            system_identifier: system_identifier.into(),
            timeline,
        }
    }

    #[test]
    fn a_restore_counts_only_as_the_backups_database_promoted_onto_a_later_timeline() {
        let id = "7697773764701949975";
        assert_eq!(
            verify_restored(&backup(), None, &restored(false, id, 2)),
            Ok(())
        );
        assert_eq!(
            verify_restored(&backup(), None, &restored(false, "7697773764701949976", 2)),
            Err("identity_mismatch")
        );
        // Still replaying, or promoted without leaving the backup's timeline: no recovery point.
        assert_eq!(
            verify_restored(&backup(), None, &restored(true, id, 2)),
            Err("no_recovery_point")
        );
        assert_eq!(
            verify_restored(&backup(), None, &restored(false, id, 1)),
            Err("no_recovery_point")
        );
    }

    #[test]
    fn a_move_target_must_also_be_the_source_on_a_timeline_after_its_last() {
        let id = "7697773764701949975";
        // The source slept on timeline 2; the target promoted onto 3.
        assert_eq!(
            verify_restored(&backup(), Some((id, 2)), &restored(false, id, 3)),
            Ok(())
        );
        // A target on timeline 2 stopped short of, or at, the source's end.
        assert_eq!(
            verify_restored(&backup(), Some((id, 2)), &restored(false, id, 2)),
            Err("no_recovery_point")
        );
        assert_eq!(
            verify_restored(
                &backup(),
                Some(("7697773764701949999", 2)),
                &restored(false, id, 3)
            ),
            Err("identity_mismatch")
        );
    }
}
