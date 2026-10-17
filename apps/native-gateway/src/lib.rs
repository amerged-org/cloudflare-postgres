// SPDX-License-Identifier: Apache-2.0
//! Native data transport. Lifecycle control/activity parity is a release gate.
pub mod auth;
pub mod budget;
pub mod hold;
pub mod http;
pub mod local;
pub mod sessions;
pub mod sql;
pub mod telemetry;
pub mod transport;
