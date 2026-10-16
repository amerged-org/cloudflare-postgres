// SPDX-License-Identifier: Apache-2.0
//! `pgcf-attach`: the node agent that attaches a sleeping database's volume to a free pool slot
//! (pool design 2026-10-16). One privileged hostPID Pod per node answers the native controller on
//! port 8081 (`attach_protocol`); it never calls Kubernetes.
mod agent;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod dm;
mod http;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(target_os = "linux"))]
mod unsupported;

use pgcf_native_controller::attach_protocol::{HOLDER_DIRECTORY, PORT};
use std::{
    net::TcpListener,
    os::unix::fs::DirBuilderExt,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn main() {
    let node = std::env::var("NODE_NAME").unwrap_or_default();
    let keys_file = std::env::var("PGCF_ATTACH_KEYS_FILE").unwrap_or_default();
    if node.is_empty() || keys_file.is_empty() {
        eprintln!(r#"{{"event":"attach_start_failed","reason":"environment"}}"#);
        std::process::exit(2);
    }
    if let Err(error) = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(HOLDER_DIRECTORY)
    {
        eprintln!(
            r#"{{"event":"attach_start_failed","reason":"holder_directory","errno":{}}}"#,
            error.raw_os_error().unwrap_or(0)
        );
        std::process::exit(2);
    }
    #[cfg(target_os = "linux")]
    let host = linux::LinuxHost::new();
    #[cfg(not(target_os = "linux"))]
    let host = unsupported::UnsupportedHost;
    let agent = Arc::new(agent::Agent::new(
        host,
        node,
        PathBuf::from(keys_file),
        PathBuf::from(HOLDER_DIRECTORY),
    ));
    // Adopt every volume already in use before the first request is answered.
    agent.tick();
    let background = agent.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(2));
            background.tick();
        }
    });
    let listener = match TcpListener::bind(("0.0.0.0", PORT)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                r#"{{"event":"attach_start_failed","reason":"listen","errno":{}}}"#,
                error.raw_os_error().unwrap_or(0)
            );
            std::process::exit(2);
        }
    };
    eprintln!(r#"{{"event":"attach_started","port":{PORT}}}"#);
    http::serve(
        listener,
        Arc::new(move |action, token, body| {
            let started = std::time::Instant::now();
            let result = agent.handle(action, token, body, now_ms());
            eprintln!(
                r#"{{"event":"attach_request","action":"{}","outcome":"{}","us":{}}}"#,
                action.name(),
                result.as_ref().err().copied().unwrap_or("ok"),
                started.elapsed().as_micros()
            );
            result
        }),
    );
}
