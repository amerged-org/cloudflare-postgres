// SPDX-License-Identifier: Apache-2.0
//! The node agent (plan 5.6): the only local actor on a node. The library holds its parts; the
//! `pgcf-agent` binary runs them.
pub mod admission;
pub mod agent;
pub mod api;
pub mod archive;
pub mod cache;
pub mod credentials;
pub mod diagnostics;
pub(crate) mod events;
pub mod fence;
pub mod gateway;
pub mod hostfiles;
pub mod layout;
pub mod link;
pub mod machine;
#[cfg(target_os = "linux")]
pub mod mount_holder;
pub mod node_link;
pub mod notify;
pub mod pg_control;
pub mod postgres;
pub mod prefetch;
pub mod proof;
pub mod release;
pub mod roles;
pub mod sample;
pub mod scram;
pub mod service;
pub mod settings;
#[cfg(any(target_os = "linux", test))]
pub(crate) mod shell_ca;
pub mod sleep;
#[cfg(all(test, target_os = "linux"))]
mod start_lab;
pub mod state;
pub mod storage;
#[cfg(test)]
mod testpg;
pub mod timing;
pub mod units;
pub mod update;
pub mod usage;
pub type Error = Box<dyn std::error::Error + Send + Sync>;

/// Whether `region` is a region ID of the contract (`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`).
pub fn valid_region(region: &str) -> bool {
    pgcf_native_protocol::valid_pattern("region", region)
}
