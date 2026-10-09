// SPDX-License-Identifier: Apache-2.0
//! CF-authorized opaque bootstrap transport. End clients keep SSH/TLS verification.
pub mod authority;
pub mod transport;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
