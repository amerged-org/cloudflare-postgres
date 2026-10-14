// SPDX-License-Identifier: Apache-2.0
//! Real supervisor peer conformance hook. No Dev node/THIN qualification claim is produced.
use pgcf_native_controller::{Error, pool::SupervisorConnection};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
fn read(path: &Path) -> Result<Value, Error> {
    let metadata = fs::symlink_metadata(path)?;
    let parent = path.parent().ok_or("peer custody parent missing")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o777 != 0o600
        || fs::symlink_metadata(parent)?.file_type().is_symlink()
        || fs::metadata(parent)?.permissions().mode() & 0o777 != 0o700
        || metadata.len() > 256 * 1024
    {
        return Err("peer custody rejected".into());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
async fn run() -> Result<Value, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 7
        || args[1] != "--binding-file"
        || args[3] != "--attestation-file"
        || args[5] != "--control-file"
    {
        return Err("peer filename flags required".into());
    }
    let binding = read(Path::new(&args[2]))?;
    let attestation = read(Path::new(&args[4]))?;
    let body = read(Path::new(&args[6]))?;
    let peer = SupervisorConnection::new(&attestation, &binding)?;
    let report = peer.request("/status", &body).await?;
    if report["state"] != "ready"
        || report["system_identifier"] != binding["scope"]["system_identifier"]
        || report["timeline"] != binding["scope"]["timeline"]
    {
        return Err("peer actual PostgreSQL identity disagrees".into());
    }
    Ok(
        json!({"event":"pool_supervisor_peer_status","state":"ready","binding_identity":"matched","system_identifier":"matched","timeline":"matched","qualification":"not_exercised"}),
    )
}
#[tokio::main]
async fn main() {
    match run().await {
        Ok(result) => println!("{result}"),
        Err(_) => {
            eprintln!(
                "{}",
                json!({"event":"pool_supervisor_peer_status","outcome":"refused"})
            );
            std::process::exit(1);
        }
    }
}
