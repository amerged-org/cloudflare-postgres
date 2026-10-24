// SPDX-License-Identifier: Apache-2.0
//! `restore_command = '/usr/libexec/pgcf/pgcf-wal-fetch %f %p'`. Exits 0 when the node agent
//! restored the file, and 1 only when the agent answered that the archive does not hold it, which
//! is how PostgreSQL learns where the archived WAL ends. Every other outcome (no agent, no answer
//! in time, a failed download) exits 255: PostgreSQL then aborts the recovery instead of ending
//! it early at the last file it got. The agent may retry an unpublished restore after a fetch
//! timeout, within its fixed attempt limit; other failures never mean the archive ended.
use pgcf_archive::{CLIENT_BOUND, Reply, Request, exchange, socket, valid_destination, valid_name};
use std::process::ExitCode;

/// Any exit status above 125 makes PostgreSQL abort the recovery.
const ABORT_RECOVERY: u8 = 255;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string().unwrap_or_default())
        .collect();
    let [name, destination] = &arguments[..] else {
        eprintln!("pgcf-wal-fetch: usage: pgcf-wal-fetch <WAL file> pg_wal/<destination>");
        return ExitCode::from(ABORT_RECOVERY);
    };
    if !valid_name(name) || !valid_destination(destination) {
        eprintln!("pgcf-wal-fetch: usage: pgcf-wal-fetch <WAL file> pg_wal/<destination>");
        return ExitCode::from(ABORT_RECOVERY);
    }
    let request = Request::Fetch {
        name: name.clone(),
        destination: destination.clone(),
    };
    match exchange(&socket(), &request, CLIENT_BOUND) {
        Ok(Reply::Ok) => ExitCode::SUCCESS,
        Ok(Reply::Missing) => ExitCode::FAILURE,
        Ok(Reply::Failed(reason)) => {
            eprintln!(
                "pgcf-wal-fetch: {name} not restored: {}",
                reason.as_deref().unwrap_or("failed")
            );
            ExitCode::from(ABORT_RECOVERY)
        }
        Err(failure) => {
            eprintln!("pgcf-wal-fetch: {name} not restored: {failure}");
            ExitCode::from(ABORT_RECOVERY)
        }
    }
}
