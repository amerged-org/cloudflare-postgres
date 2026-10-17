// SPDX-License-Identifier: Apache-2.0
//! The node agent's reusable parts, moved from the native controller without their Kubernetes
//! surroundings. The agent binary is built in Stage 3.
pub mod api;
pub mod contracts;
pub mod diagnostics;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod dm;
pub mod health;
pub mod holder;
pub mod measurements;
#[cfg(target_os = "linux")]
pub mod mount;
pub mod node_link;
pub mod pg_control;
pub mod postgres;
pub mod sleep;
pub mod sleep_record;
#[cfg(test)]
mod test_api;
#[cfg(test)]
mod test_postgres;
#[cfg(test)]
mod test_sql;
pub mod timing;
pub mod units;
pub mod volume;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
