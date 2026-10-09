// SPDX-License-Identifier: Apache-2.0
use pgcf_native_gateway::{
    kubernetes::{self, Kubernetes},
    storage::StorageTrust,
    targets,
    transport::{self, ClusterPostgresDial, Config, Gateway},
};
use pgcf_native_protocol::{constant, route::Keyring, valid_pattern};
use std::sync::{Arc, atomic::Ordering};
use tokio::{
    net::TcpListener,
    sync::{Semaphore, watch},
    task::JoinSet,
};
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
    let pod = std::env::var("PGCF_GATEWAY_POD_UID")?;
    if !valid_pattern("region", &region) || !valid_pattern("uuid", &pod) {
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
        keyring,
        maximum_memory,
        database_memory,
    });
    let api = Arc::new(Kubernetes::in_cluster().await?);
    let gateway = Gateway::new(config, pod, Arc::new(ClusterPostgresDial(api.clone())));
    let trust = match (
        std::env::var("PGCF_STORAGE_AUTHORITY_KEYS"),
        std::env::var("PGCF_STORAGE_AUTHORITY_KEYS_SHA256"),
    ) {
        (Ok(keys), Ok(pin)) => Some(StorageTrust::parse(&keys, &pin)?),
        (Err(std::env::VarError::NotPresent), Err(std::env::VarError::NotPresent)) => None,
        _ => return Err("incomplete storage trust configuration".into()),
    };
    let legacy = std::env::var("PGCF_GATEWAY_LEGACY_BINDINGS_JSON").unwrap_or_else(|_| "[]".into());
    *gateway.targets.write().await = targets::Targets::with_legacy(&legacy)?;
    let (stop, receiver) = watch::channel(false);
    let endpoints = tokio::spawn(targets::synchronize(
        api.clone(),
        gateway.targets.clone(),
        trust.clone(),
        "endpointslices",
        receiver.clone(),
    ));
    let storage = tokio::spawn(targets::synchronize(
        api.clone(),
        gateway.targets.clone(),
        trust,
        "configmaps",
        receiver.clone(),
    ));
    let synchronize = tokio::spawn(kubernetes::synchronize(
        api,
        gateway.fences.clone(),
        gateway.sessions.clone(),
        receiver.clone(),
    ));
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let pending = Arc::new(Semaphore::new(128));
    let mut sessions = JoinSet::new();
    let shutdown = shutdown_signal();
    tokio::pin!(shutdown);
    println!("{{\"event\":\"gateway_listening\",\"port\":{port}}}");
    loop {
        tokio::select! {
            _=&mut shutdown=>break,
            Some(_)=sessions.join_next()=>{},
            accepted=listener.accept()=>{
                let(socket,_)=accepted?;let Ok(permit)=pending.clone().try_acquire_owned()else{drop(socket);continue;};
                let(gateway,receiver)=(gateway.clone(),receiver.clone());
                sessions.spawn(async move{let _=transport::serve_socket(socket,gateway,receiver,permit).await;});
            }
        }
    }
    gateway.draining.store(true, Ordering::Release);
    stop.send(true)?;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while sessions.join_next().await.is_some() {}
    })
    .await;
    sessions.abort_all();
    let _ = synchronize.await;
    let _ = endpoints.await;
    let _ = storage.await;
    Ok(())
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
