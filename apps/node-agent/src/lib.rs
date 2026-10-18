// SPDX-License-Identifier: Apache-2.0
//! The node agent's reusable parts, moved from the native controller without their Kubernetes
//! surroundings. The agent binary is built in Stage 3.
pub mod admission;
pub mod agent;
pub mod api;
pub mod archive;
pub mod contracts;
pub mod credentials;
pub mod diagnostics;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod dm;
pub mod fence;
pub mod gateway;
pub mod health;
pub mod holder;
pub mod layout;
pub mod link;
pub mod machine;
pub mod measurements;
#[cfg(target_os = "linux")]
pub mod mount;
pub mod node_link;
pub mod pg_control;
pub mod postgres;
pub mod proof;
pub mod roles;
pub mod sample;
pub mod scram;
pub mod service;
pub mod settings;
pub mod sleep;
pub mod sleep_record;
pub mod state;
pub mod storage;
#[cfg(test)]
mod test_api;
#[cfg(test)]
mod testpg;
pub mod timing;
pub mod units;
pub mod volume;
pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Whether `region` is a region ID of the contract (`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`).
pub fn valid_region(region: &str) -> bool {
    pgcf_native_protocol::valid_pattern("region", region)
}
