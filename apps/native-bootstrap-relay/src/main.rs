// SPDX-License-Identifier: Apache-2.0
use pgcf_native_bootstrap_relay::{authority::Configuration, transport::Relay};
#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--version"] {
        let source = option_env!("PGCF_SOURCE_REVISION")
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()));
        println!(
            "{}",
            serde_json::json!({"program":"pgcf-native-bootstrap-relay","version":env!("CARGO_PKG_VERSION"),"sourceRevision":source,"rustVersion":option_env!("PGCF_RUST_VERSION"),"versionsLockSha256":option_env!("PGCF_VERSIONS_LOCK_SHA256"),"cargoLockSha256":option_env!("PGCF_CARGO_LOCK_SHA256"),"protocolSha256":option_env!("PGCF_PROTOCOL_SHA256"),"bootstrapContractSha256":option_env!("PGCF_BOOTSTRAP_CONTRACT_SHA256")})
        );
        return;
    }
    if args == ["--help"] {
        println!(
            "PGCF bootstrap byte relay. Required environment: PGCF_BOOTSTRAP_RELAY_REGION, PGCF_BOOTSTRAP_RELAY_ISSUER_REGION, PGCF_BOOTSTRAP_RELAY_HOST, PGCF_BOOTSTRAP_RELAY_PORT, PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS, PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS. Target regions are 1–16 unique region IDs. Issuer region equals relay region. Keys are a public Ed25519 kid-to-base64url map. Clients retain end-to-end SSH/TLS identity verification."
        );
        return;
    }
    if !args.is_empty() {
        eprintln!("{{\"event\":\"bootstrap_relay_invalid_arguments\"}}");
        std::process::exit(1);
    }
    if run().await.is_err() {
        eprintln!("{{\"event\":\"bootstrap_relay_stopped_with_error\"}}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), pgcf_native_bootstrap_relay::Error> {
    let config = Configuration::from_env()?;
    let region = config.region.clone();
    let server = Relay::bind(config).await?;
    println!(
        "{}",
        serde_json::json!({"event":"bootstrap_relay_listening","region":region,"port":server.address.port()})
    );
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
    }
    server.close().await;
    Ok(())
}
