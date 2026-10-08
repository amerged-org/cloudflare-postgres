//! The node-local, one-assignment namespace holder for a prepared compute slot.
//! This primitive does not claim Kubernetes, CNPG, or database readiness.

#[cfg(target_os = "linux")]
pub mod linux;
pub mod protocol;
