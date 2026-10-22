// SPDX-License-Identifier: Apache-2.0
//! The limits of one database's unit (plan 4.3, 4.4 and Appendix C) as the unit properties that
//! systemd takes over D-Bus `SetUnitProperties`.
use std::num::NonZeroU32;

const MIB: u64 = 1024 * 1024;
/// The contract's write limits are those of a database of this size (`policy.io`).
const IO_BASE_MEMORY_MIB: u64 = 256;
/// `CPUWeight` is 1..=10000; a database gets 100 per core of its CPU size, the default of one core.
const CPU_WEIGHT_MIN: u64 = 1;
const CPU_WEIGHT_MAX: u64 = 10_000;
/// The limits of an idle slot (`pgcf-slot@.service`).
const IDLE_MEMORY_MIB: u64 = 32;
const IDLE_MEMORY_HIGH_MIB: u64 = 28;
const IDLE_CPU_WEIGHT: u64 = 10;
const IDLE_TASKS_MAX: u64 = 64;

/// A unit property in the form systemd's cgroup settings take it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Property {
    /// Bytes.
    MemoryMax(u64),
    /// Bytes.
    MemoryHigh(u64),
    CpuWeight(u64),
    TasksMax(u64),
    /// Per device: bytes per second.
    IoWriteBandwidthMax(String, u64),
    /// Per device: operations per second.
    IoWriteIopsMax(String, u64),
    /// Microseconds of CPU per second; `u64::MAX` is no quota.
    CpuQuotaPerSecUsec(u64),
    /// No write limit on any device: the empty array, which clears the limits of every device that
    /// an earlier incarnation of the unit set. Setting one device's limit again does not.
    IoWriteBandwidthMaxNone,
    IoWriteIopsMaxNone,
}
impl Property {
    /// The property's name on the unit's D-Bus interfaces.
    pub fn name(&self) -> &'static str {
        match self {
            Self::MemoryMax(_) => "MemoryMax",
            Self::MemoryHigh(_) => "MemoryHigh",
            Self::CpuWeight(_) => "CPUWeight",
            Self::TasksMax(_) => "TasksMax",
            Self::IoWriteBandwidthMax(..) | Self::IoWriteBandwidthMaxNone => "IOWriteBandwidthMax",
            Self::IoWriteIopsMax(..) | Self::IoWriteIopsMaxNone => "IOWriteIOPSMax",
            Self::CpuQuotaPerSecUsec(_) => "CPUQuotaPerSecUSec",
        }
    }
}

/// A database's write limits on its volume's device.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Io {
    /// The device node of the thin volume, for example `/dev/mapper/pgcf-<lv>`.
    pub device: String,
    pub write_bytes_per_second: u64,
    pub write_iops: u64,
}
impl Io {
    /// The limits of a database of `memory_mib`: those of a 256 MiB database times `memory_mib / 256`.
    pub fn scaled(
        device: impl Into<String>,
        base_bytes_per_second: u64,
        base_iops: u64,
        memory_mib: u64,
    ) -> Self {
        let scale = |base: u64| {
            let scaled = u128::from(base) * u128::from(memory_mib) / u128::from(IO_BASE_MEMORY_MIB);
            u64::try_from(scaled).unwrap_or(u64::MAX)
        };
        Self {
            device: device.into(),
            write_bytes_per_second: scale(base_bytes_per_second),
            write_iops: scale(base_iops),
        }
    }
}

/// What a database's sizes set on its unit. The CPU quota is not among them: it is applied after
/// ready and lifted at stop (`cpu_quota`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub memory_mib: u64,
    pub cpu_millicores: u32,
    pub tasks_max: u64,
    pub io: Option<Io>,
}
impl Limits {
    /// The properties to set persistently: memory ceiling and 90 % soft limit, CPU weight, tasks
    /// and, with `io`, the write limits.
    pub fn properties(&self) -> Vec<Property> {
        let mut properties = vec![
            Property::MemoryMax(self.memory_mib.saturating_mul(MIB)),
            Property::MemoryHigh((self.memory_mib.saturating_mul(9) / 10).saturating_mul(MIB)),
            Property::CpuWeight(
                (u64::from(self.cpu_millicores) / 10).clamp(CPU_WEIGHT_MIN, CPU_WEIGHT_MAX),
            ),
            Property::TasksMax(self.tasks_max),
        ];
        if let Some(io) = &self.io {
            properties.push(Property::IoWriteBandwidthMax(
                io.device.clone(),
                io.write_bytes_per_second,
            ));
            properties.push(Property::IoWriteIopsMax(io.device.clone(), io.write_iops));
        }
        properties
    }
}

/// What an idle slot holds, the limits of `pgcf-slot@.service` as it is written: a supervisor
/// with no database. A runtime property outlives the stop of its unit (until the next boot), so the
/// agent sets these again whenever it builds a slot, and they take back what the database of its
/// last incarnation set: the memory ceiling, the CPU weight, the CPU quota and the write limits.
pub fn idle() -> Vec<Property> {
    vec![
        Property::MemoryMax(IDLE_MEMORY_MIB * MIB),
        Property::MemoryHigh(IDLE_MEMORY_HIGH_MIB * MIB),
        Property::CpuWeight(IDLE_CPU_WEIGHT),
        Property::TasksMax(IDLE_TASKS_MAX),
        cpu_quota(None),
        Property::IoWriteBandwidthMaxNone,
        Property::IoWriteIopsMaxNone,
    ]
}

/// The memory ceiling of the slice that holds every database: the operator's awake-database budget
/// (plan 4.5). The kernel enforces it as the backstop under either memory rule (plan 4.6).
pub fn slice_memory(awake_budget_mib: u64) -> Property {
    Property::MemoryMax(awake_budget_mib.saturating_mul(MIB))
}

/// The quota of a database's CPU size, or none (`CPUQuota=`).
pub fn cpu_quota(millicores: Option<NonZeroU32>) -> Property {
    Property::CpuQuotaPerSecUsec(match millicores {
        Some(millicores) => u64::from(millicores.get()) * 1000,
        None => u64::MAX,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::dbus;

    fn limits(memory_mib: u64, cpu_millicores: u32, io: Option<Io>) -> Limits {
        Limits {
            memory_mib,
            cpu_millicores,
            tasks_max: 64,
            io,
        }
    }

    #[test]
    fn memory_ceiling_is_the_size_and_the_soft_limit_is_90_percent_rounded_down_to_a_mib() {
        // The image's unit carries `MemoryMax=256M` and `MemoryHigh=230M` for the smallest class.
        let small = limits(256, 1000, None).properties();
        assert_eq!(small[0], Property::MemoryMax(256 * MIB));
        assert_eq!(small[1], Property::MemoryHigh(230 * MIB));
        let medium = limits(512, 1000, None).properties();
        assert_eq!(medium[0], Property::MemoryMax(512 * MIB));
        assert_eq!(medium[1], Property::MemoryHigh(460 * MIB));
        let large = limits(4096, 1000, None).properties();
        assert_eq!(large[1], Property::MemoryHigh(3686 * MIB));
    }

    #[test]
    fn cpu_weight_is_100_per_core_within_systemds_range() {
        let weight = |millicores| match limits(256, millicores, None).properties()[2] {
            Property::CpuWeight(weight) => weight,
            ref other => panic!("expected the CPU weight, got {other:?}"),
        };
        assert_eq!(weight(100), 10);
        assert_eq!(weight(1000), 100);
        assert_eq!(weight(6000), 600);
        assert_eq!(weight(9), 1, "below the range's floor");
        assert_eq!(weight(0), 1);
        assert_eq!(weight(u32::MAX), 10_000, "above the range's ceiling");
    }

    #[test]
    fn tasks_and_io_follow_the_limits_and_io_is_optional() {
        let without = limits(256, 1000, None).properties();
        assert_eq!(without.len(), 4);
        assert_eq!(without[3], Property::TasksMax(64));
        let io = Io {
            device: "/dev/mapper/pgcf-lv".into(),
            write_bytes_per_second: 16_000_000,
            write_iops: 1000,
        };
        let with = limits(256, 1000, Some(io)).properties();
        assert_eq!(with.len(), 6);
        assert_eq!(
            with[4],
            Property::IoWriteBandwidthMax("/dev/mapper/pgcf-lv".into(), 16_000_000)
        );
        assert_eq!(
            with[5],
            Property::IoWriteIopsMax("/dev/mapper/pgcf-lv".into(), 1000)
        );
    }

    #[test]
    fn write_limits_scale_with_the_memory_size_from_the_256_mib_base() {
        let scaled = |memory_mib| Io::scaled("/dev/x", 16_000_000, 1000, memory_mib);
        assert_eq!(scaled(256).write_bytes_per_second, 16_000_000);
        assert_eq!(scaled(256).write_iops, 1000);
        assert_eq!(scaled(512).write_bytes_per_second, 32_000_000);
        assert_eq!(scaled(1024).write_iops, 4000);
        assert_eq!(scaled(4096).write_bytes_per_second, 256_000_000);
        assert_eq!(scaled(4096).write_iops, 16_000);
        assert_eq!(scaled(256).device, "/dev/x");
        // A size between two steps rounds down; the product is exact in 128 bits.
        assert_eq!(scaled(300).write_iops, 1171);
        assert_eq!(
            Io::scaled("/dev/x", u64::MAX, u64::MAX, 4096).write_iops,
            u64::MAX,
            "saturates instead of wrapping"
        );
    }

    #[test]
    fn the_quota_is_the_cpu_size_in_microseconds_per_second_or_unlimited() {
        let quota = |millicores| cpu_quota(NonZeroU32::new(millicores));
        assert_eq!(quota(500), Property::CpuQuotaPerSecUsec(500_000));
        assert_eq!(quota(100), Property::CpuQuotaPerSecUsec(100_000));
        assert_eq!(quota(6000), Property::CpuQuotaPerSecUsec(6_000_000));
        assert_eq!(quota(0), Property::CpuQuotaPerSecUsec(u64::MAX));
    }

    #[test]
    fn the_slice_ceiling_is_the_awake_budget_in_bytes() {
        assert_eq!(slice_memory(9913), Property::MemoryMax(9913 * MIB));
        assert_eq!(slice_memory(256), Property::MemoryMax(256 * MIB));
        // The contract's largest budget, 1 TiB.
        assert_eq!(slice_memory(1_048_576), Property::MemoryMax(1 << 40));
        assert_eq!(slice_memory(9913).name(), "MemoryMax");
    }


    #[test]
    fn an_idle_slot_holds_the_units_idle_limits_and_none_of_a_database() {
        let idle = idle();
        // The file of `pgcf-slot@.service` says MemoryMax=32M, MemoryHigh=28M, TasksMax=64 and
        // CPUWeight=10; what a database set at its bind is reset to these, and to nothing else.
        assert_eq!(
            idle,
            [
                Property::MemoryMax(32 * MIB),
                Property::MemoryHigh(28 * MIB),
                Property::CpuWeight(10),
                Property::TasksMax(64),
                Property::CpuQuotaPerSecUsec(u64::MAX),
                Property::IoWriteBandwidthMaxNone,
                Property::IoWriteIopsMaxNone,
            ]
        );
    }

    #[test]
    fn the_write_limits_of_every_device_are_reset_with_an_empty_array() {
        // A runtime property outlives the stop of the unit, and a per-device limit that is set
        // again for another device adds to the first: an empty `a(st)` clears them all.
        for property in [Property::IoWriteBandwidthMaxNone, Property::IoWriteIopsMaxNone] {
            let (name, value) = dbus::encode(&property);
            assert_eq!(value.value_signature().to_string(), "a(st)");
            match value {
                zbus::zvariant::Value::Array(array) => assert!(array.is_empty(), "{name}"),
                other => panic!("{name} is not an array: {other:?}"),
            }
        }
        assert_eq!(Property::IoWriteBandwidthMaxNone.name(), "IOWriteBandwidthMax");
        assert_eq!(Property::IoWriteIopsMaxNone.name(), "IOWriteIOPSMax");
    }

    #[test]
    fn property_names_are_systemds() {
        let names: Vec<&str> = limits(
            256,
            1000,
            Some(Io {
                device: "/dev/x".into(),
                write_bytes_per_second: 1,
                write_iops: 1,
            }),
        )
        .properties()
        .iter()
        .map(Property::name)
        .collect();
        assert_eq!(
            names,
            [
                "MemoryMax",
                "MemoryHigh",
                "CPUWeight",
                "TasksMax",
                "IOWriteBandwidthMax",
                "IOWriteIOPSMax"
            ]
        );
        assert_eq!(cpu_quota(None).name(), "CPUQuotaPerSecUSec");
    }
}
