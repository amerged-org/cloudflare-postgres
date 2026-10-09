// SPDX-License-Identifier: Apache-2.0
pub mod authority;
pub mod state;
pub mod target;
pub mod worker;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
