// SPDX-License-Identifier: Apache-2.0
//! The parts of systemd's D-Bus API the agent uses (`org.freedesktop.systemd1`, systemd 257).
use super::limits::Property;
use zbus::{proxy, zvariant::OwnedObjectPath, zvariant::Value};

/// One row of `ListUnitsByPatterns`: name, description, load state, active state, sub state,
/// followed unit, object path, job id, job type and job path.
pub type Listed = (
    String,
    String,
    String,
    String,
    String,
    String,
    OwnedObjectPath,
    u32,
    String,
    OwnedObjectPath,
);

#[proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1",
    gen_blocking = false
)]
pub trait Manager {
    /// Makes systemd send job signals to this client.
    fn subscribe(&self) -> zbus::Result<()>;
    fn start_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    fn stop_unit(&self, name: &str, mode: &str) -> zbus::Result<OwnedObjectPath>;
    /// Sets properties on a unit that is loaded or not, without a reload. `runtime` keeps them
    /// until the next boot; otherwise systemd also writes a drop-in under `system.control`.
    fn set_unit_properties(
        &self,
        name: &str,
        runtime: bool,
        properties: &[(&str, Value<'_>)],
    ) -> zbus::Result<()>;
    fn list_units_by_patterns(
        &self,
        states: &[&str],
        patterns: &[&str],
    ) -> zbus::Result<Vec<Listed>>;
}

#[proxy(
    interface = "org.freedesktop.systemd1.Unit",
    default_service = "org.freedesktop.systemd1",
    gen_blocking = false
)]
pub trait Unit {
    #[zbus(property)]
    fn active_state(&self) -> zbus::Result<String>;
    #[zbus(property, name = "InvocationID")]
    fn invocation_id(&self) -> zbus::Result<Vec<u8>>;
}

#[proxy(
    interface = "org.freedesktop.systemd1.Service",
    default_service = "org.freedesktop.systemd1",
    gen_blocking = false
)]
pub trait Service {
    #[zbus(property, name = "MainPID")]
    fn main_pid(&self) -> zbus::Result<u32>;
    #[zbus(property, name = "UID")]
    fn uid(&self) -> zbus::Result<u32>;
    #[zbus(property)]
    fn memory_max(&self) -> zbus::Result<u64>;
}

/// A property as `SetUnitProperties` takes it.
pub fn encode(property: &Property) -> (&'static str, Value<'static>) {
    let value = match property {
        Property::MemoryMax(value)
        | Property::MemoryHigh(value)
        | Property::CpuWeight(value)
        | Property::TasksMax(value)
        | Property::CpuQuotaPerSecUsec(value) => Value::from(*value),
        // `a(st)`: the device and its limit.
        Property::IoWriteBandwidthMax(device, value) | Property::IoWriteIopsMax(device, value) => {
            Value::new(vec![(device.clone(), *value)])
        }
    };
    (property.name(), value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn properties_have_the_wire_types_systemd_defines_for_them() {
        let signature = |property| encode(&property).1.value_signature().to_string();
        // Sizes and limits are `t`; the quota's `CPUQuotaPerSecUSec` is `t`, too.
        assert_eq!(signature(Property::MemoryMax(1)), "t");
        assert_eq!(signature(Property::MemoryHigh(1)), "t");
        assert_eq!(signature(Property::CpuWeight(1)), "t");
        assert_eq!(signature(Property::TasksMax(1)), "t");
        assert_eq!(signature(Property::CpuQuotaPerSecUsec(u64::MAX)), "t");
        // The per-device limits are arrays of (device, limit).
        assert_eq!(
            signature(Property::IoWriteBandwidthMax("/dev/x".into(), 1)),
            "a(st)"
        );
        assert_eq!(
            signature(Property::IoWriteIopsMax("/dev/x".into(), 1)),
            "a(st)"
        );
    }
}
