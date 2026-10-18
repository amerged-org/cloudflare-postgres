// SPDX-License-Identifier: Apache-2.0
//! `pgcf-agent check` (plan 5.6 job 10, 9.1): the node's whole local path on one scratch database,
//! without Cloudflare. The first call makes the database's user, its thin volume, its filesystem
//! and its cluster; every call writes the configuration, starts the unit, asks PostgreSQL over its
//! socket as the agent and stops the unit. The image's boot test runs it after the first boot and
//! again after a reboot and requires the same volume both times.
//!
//! The scratch database belongs to no page, so nothing of Cloudflare's reaches it: it has no
//! archive, no roles and no admission, and it is not the agent's to place, wake or delete. Its
//! user is a system account of the system's own range, so the agent's table of uids is never
//! written by a second process.
use super::build::write_owned;
use crate::{
    Error,
    machine::{Account, Machine},
    postgres, settings,
    settings::Settings,
    storage::{self, VolumeId},
};
use std::time::Duration;

/// The scratch database's identifier, a valid database id no placement ever draws (they are random).
pub const SCRATCH: &str = "pgcfcheckscratch0000";
/// The smallest database: a 1 GiB volume, which a thin pool commits almost nothing for.
const VOLUME_BYTES: u64 = 1 << 30;
const MEMORY_MIB: u64 = 256;
const MAX_CONNECTIONS: u32 = 10;
const ARCHIVE_TIMEOUT_SECONDS: u32 = 60;

/// What a check found.
#[derive(Debug, PartialEq, Eq)]
pub struct Checked {
    /// Whether this call made the scratch database; later calls wake it.
    pub created: bool,
    /// The uid the postmaster ran as, which is the database's own user.
    pub uid: u32,
}

/// The room rule for the scratch volume: the pool takes it while it takes writes at all.
fn policy() -> storage::Policy {
    storage::Policy {
        reserve_bytes: 0,
        metadata_no_room_percent: 100,
        sample_max_age: Duration::from_secs(60),
    }
}

/// Makes or wakes the scratch database, queries it and stops it. `account` is the database's user.
/// The unit is stopped when this returns, whether the database answered or not.
pub async fn run<M: Machine>(machine: &M, account: &Account) -> Result<Checked, Error> {
    let volume = VolumeId::new(SCRATCH, 1)?;
    let layout = machine.layout();
    let data = layout.data(SCRATCH);
    // A call that was killed left the unit running; the files are rewritten only while it is down.
    machine.stop(SCRATCH).await?;
    machine.poll_pool().await?;
    // Finishes what an earlier call left: it makes the volume and its filesystem, or only mounts it.
    machine
        .create_volume(&volume, VOLUME_BYTES, account, &policy())
        .await?;
    let created = !data.join("PG_VERSION").exists();
    if created {
        machine.initdb(account, &data).await?;
    }
    let conf = settings::postgresql_conf(&Settings {
        socket_directory: &layout.socket_directory(SCRATCH),
        memory_mib: MEMORY_MIB,
        volume_bytes: VOLUME_BYTES,
        max_connections: MAX_CONNECTIONS,
        archive_timeout_seconds: ARCHIVE_TIMEOUT_SECONDS,
        archive_command: None,
    })
    .ok_or("the settings cannot be written")?;
    let ident = settings::pg_ident(&machine.agent_user(), &account.name)
        .ok_or("the users cannot be written")?;
    for (name, content) in [
        ("postgresql.conf", conf.as_str()),
        ("pg_hba.conf", settings::PG_HBA),
        ("pg_ident.conf", ident.as_str()),
    ] {
        write_owned(&data, name, content, account)?;
    }
    machine.prepare_socket_directory(SCRATCH, account)?;
    let answered = answer(machine, account, &data).await;
    let stopped = machine.stop(SCRATCH).await;
    let uid = answered?;
    stopped?;
    Ok(Checked { created, uid })
}

/// Starts the unit and asks it: the postmaster runs as the database's user on the volume's data
/// directory, and PostgreSQL answers the agent over the socket.
async fn answer<M: Machine>(
    machine: &M,
    account: &Account,
    data: &std::path::Path,
) -> Result<u32, Error> {
    let started = machine.start(SCRATCH).await?;
    if started.uid != account.uid {
        return Err("the scratch database runs as another user".into());
    }
    let session = postgres::agent(&machine.layout().socket_directory(SCRATCH)).await?;
    let rows = session
        .query(
            "SELECT 1::int4 AS answer, current_setting('data_directory') AS data",
            &[],
        )
        .await?;
    let row = rows.first().ok_or("the scratch database gave no row")?;
    if row.get::<_, i32>("answer") != 1 {
        return Err("the scratch database gave a wrong answer".into());
    }
    let reported = row.get::<_, String>("data");
    if std::fs::canonicalize(&reported)? != std::fs::canonicalize(data)? {
        return Err("the scratch database runs on another directory than its volume".into());
    }
    Ok(started.uid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{machine::local::Local, proof::read_control};

    fn identity(machine: &Local) -> Vec<u8> {
        let bytes = read_control(&machine.layout().volume(SCRATCH)).unwrap();
        // The first eight bytes of pg_control are the cluster's system identifier.
        bytes[..8].to_vec()
    }

    #[tokio::test]
    async fn the_first_check_makes_the_scratch_database_and_the_next_wakes_the_same_one() {
        let Some(machine) = Local::new("check") else {
            return;
        };
        let account = machine.ensure_account(SCRATCH).await.unwrap();

        let first = run(&machine, &account).await.unwrap();
        assert!(first.created);
        assert_eq!(first.uid, account.uid);
        assert!(!machine.running(SCRATCH), "the check leaves the unit down");
        let made = identity(&machine);

        let second = run(&machine, &account).await.unwrap();
        assert!(!second.created);
        assert!(!machine.running(SCRATCH));
        assert_eq!(identity(&machine), made, "the same cluster, not a new one");
        assert_eq!(machine.volumes().len(), 1);
    }

    #[tokio::test]
    async fn a_database_that_does_not_start_fails_the_check_and_the_next_call_recovers() {
        let Some(machine) = Local::new("check-fail") else {
            return;
        };
        let account = machine.ensure_account(SCRATCH).await.unwrap();
        run(&machine, &account).await.unwrap();

        machine.fail_next_start();
        assert!(run(&machine, &account).await.is_err());
        assert!(!machine.running(SCRATCH));

        assert!(!run(&machine, &account).await.unwrap().created);
    }
}
