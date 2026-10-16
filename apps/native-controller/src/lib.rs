// SPDX-License-Identifier: Apache-2.0
pub mod api;
pub mod attach_protocol;
pub mod contracts;
pub mod diagnostics;
pub mod fleet;
pub mod health;
pub mod initial_backup;
pub mod inventory;
pub mod kubernetes;
pub mod manifests;
pub mod measurements;
pub mod node_storage;
pub mod pool;
pub mod postgres;
pub mod power;
pub mod reconcile;
#[cfg(test)]
mod test_postgres;
#[cfg(test)]
mod test_server;
#[cfg(test)]
mod test_world;
pub mod timing;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
/// Plain-HTTP client for in-cluster endpoints (gateway activity and power, PostgreSQL exporter).
/// The image is `FROM scratch`, where Linux has no platform CA roots, so it pins an empty trust
/// store instead of loading them; any HTTPS use fails closed.
pub fn cluster_http(timeout: std::time::Duration) -> Result<reqwest::Client, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::Client::builder()
        .tls_certs_only(Vec::new())
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()?)
}
