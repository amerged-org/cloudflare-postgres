// SPDX-License-Identifier: Apache-2.0
//! `archive_command = '/usr/libexec/pgcf/pgcf-archive %p'`. Exits 0 only when the node agent
//! answered that the segment is durable in R2; every other outcome exits 1, and PostgreSQL keeps
//! the segment and retries.
use pgcf_archive::{CLIENT_BOUND, Reply, Request, exchange, socket, valid_name};
use std::process::ExitCode;

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.into_string().unwrap_or_default())
        .collect();
    // PostgreSQL's %p is the segment's path relative to the data directory.
    let name = match &arguments[..] {
        [path] => path.strip_prefix("pg_wal/").filter(|name| valid_name(name)),
        _ => None,
    };
    let Some(name) = name else {
        eprintln!("pgcf-archive: usage: pgcf-archive pg_wal/<WAL file>");
        return ExitCode::FAILURE;
    };
    let request = Request::Archive { name: name.into() };
    match exchange(&socket(), &request, CLIENT_BOUND) {
        Ok(Reply::Ok) => ExitCode::SUCCESS,
        Ok(Reply::Failed(reason)) => {
            eprintln!(
                "pgcf-archive: {name} not archived: {}",
                reason.as_deref().unwrap_or("failed")
            );
            ExitCode::FAILURE
        }
        Ok(Reply::Missing) => {
            eprintln!("pgcf-archive: {name} not archived: invalid answer");
            ExitCode::FAILURE
        }
        Err(failure) => {
            eprintln!("pgcf-archive: {name} not archived: {failure}");
            ExitCode::FAILURE
        }
    }
}
