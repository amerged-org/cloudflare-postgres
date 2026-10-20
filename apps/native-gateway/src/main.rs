// SPDX-License-Identifier: Apache-2.0
use pgcf_native_gateway::{
    activation, local,
    transport::{self, Config, Gateway},
};
use pgcf_native_protocol::{agent, constant, route::Keyring, valid_pattern};
use std::{net::Ipv4Addr, path::PathBuf, sync::Arc};
use tokio::{net::TcpListener, sync::watch};
fn positive(
    name: &str,
    fallback: usize,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let value = std::env::var(name).unwrap_or_else(|_| fallback.to_string());
    if value.is_empty() || !value.bytes().all(|v| v.is_ascii_digit()) {
        return Err("invalid numeric configuration".into());
    }
    let value: usize = value.parse()?;
    if value == 0 || value > 9_007_199_254_740_991 {
        return Err("invalid numeric configuration".into());
    }
    Ok(value)
}
async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let region = std::env::var("PGCF_REGION_ID")?;
    if !valid_pattern("region", &region) {
        return Err("invalid gateway identity".into());
    }
    let node = std::env::var("PGCF_NODE_ID")?;
    if !valid_pattern("node", &node) {
        return Err("invalid gateway identity".into());
    }
    let keyring = Keyring::parse(&std::env::var("PGCF_ROUTE_KEY")?)?;
    let port: u16 = positive("PGCF_GATEWAY_PORT", 8080)?.try_into()?;
    let maximum_memory = positive(
        "PGCF_GATEWAY_MEMORY_BYTES",
        constant("DEFAULT_MEMORY_LIMIT_BYTES") as usize,
    )?;
    let database_memory = positive(
        "PGCF_GATEWAY_DATABASE_MEMORY_BYTES",
        constant("DEFAULT_DATABASE_MEMORY_LIMIT_BYTES") as usize,
    )?;
    if database_memory > maximum_memory {
        return Err("invalid gateway memory bounds".into());
    }
    let config = Arc::new(Config {
        region,
        node,
        keyring,
        maximum_memory,
        database_memory,
    });
    let (stop, receiver) = watch::channel(false);
    // On a node: the agent's table over its local channel, PostgreSQL on Unix sockets, and only
    // cloudflared, on loopback, as a client.
    let socket = std::env::var_os("PGCF_AGENT_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| agent::GATEWAY_SOCKET.into());
    let gateway = Gateway::new(config);
    let synchronizer = tokio::spawn(local::synchronize(
        gateway.clone(),
        socket,
        receiver.clone(),
    ));
    // Under systemd the socket is the unit's, which outlives this process; by hand the gateway
    // binds its own.
    let (listener, inherited) = match activation::inherited()? {
        Some(listener) => (TcpListener::from_std(listener)?, true),
        None => (TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?, false),
    };
    let port = listener.local_addr()?.port();
    println!("{{\"event\":\"gateway_listening\",\"port\":{port},\"inherited\":{inherited}}}");
    let served = transport::serve(
        listener,
        gateway,
        stop,
        shutdown_signal(),
        transport::DRAIN_BOUND,
    )
    .await;
    let _ = synchronizer.await;
    Ok(served?)
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
#[tokio::main]
async fn main() {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == "--version")
    {
        let source = option_env!("PGCF_SOURCE_REVISION")
            .filter(|value| value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()));
        println!(
            "{}",
            serde_json::json!({"program":"pgcf-native-gateway","version":env!("CARGO_PKG_VERSION"),"sourceRevision":source,"rustVersion":option_env!("PGCF_RUST_VERSION"),"versionsLockSha256":option_env!("PGCF_VERSIONS_LOCK_SHA256"),"cargoLockSha256":option_env!("PGCF_CARGO_LOCK_SHA256")})
        );
        return;
    }
    if run().await.is_err() {
        eprintln!("{{\"event\":\"gateway_stopped_with_error\"}}");
        std::process::exit(1);
    }
}
