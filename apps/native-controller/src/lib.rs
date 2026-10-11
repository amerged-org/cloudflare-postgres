// SPDX-License-Identifier: Apache-2.0
pub mod api;
pub mod contracts;
pub mod fleet;
pub mod health;
pub mod inventory;
pub mod kubernetes;
pub mod manifests;
pub mod measurements;
pub mod node_storage;
pub mod postgres;
pub mod power;
pub mod reconcile;
#[cfg(test)]
mod test_server;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
