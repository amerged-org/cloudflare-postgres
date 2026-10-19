// SPDX-License-Identifier: Apache-2.0
//! The node's sample for placement (plan 4.8, 4.9; `NodeSample`): what Cloudflare derives the
//! active RAM and the CPU load of the 80 % rule from, every 15 s.
use crate::{
    admission::Snapshot,
    archive::facts::timestamp,
    machine::{CpuTimes, Memory, Throttle},
    storage::PoolSample,
};
use serde_json::{Value, json};
use std::time::Instant;

/// The CPU times of `/proc/stat`: the first line sums the cores, which `cpuN` lines count.
/// `None` for a text that is not `/proc/stat`.
pub fn cpu_times(stat: &str, ticks_per_second: u64) -> Option<CpuTimes> {
    let mut lines = stat.lines();
    let total_line = lines.next()?.strip_prefix("cpu ")?;
    let fields: Vec<u64> = total_line
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    // user nice system idle iowait irq softirq steal [guest guest_nice]; the last two are
    // already counted in user and nice.
    let [user, nice, system, idle, iowait, irq, softirq, steal, ..] = fields[..] else {
        return None;
    };
    let busy = user + nice + system + irq + softirq + steal;
    let cores = lines
        .take_while(|line| line.starts_with("cpu"))
        .filter(|line| {
            line.strip_prefix("cpu")
                .and_then(|rest| rest.split_whitespace().next())
                .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
        })
        .count();
    Some(CpuTimes {
        busy,
        total: busy + idle + iowait,
        steal,
        cores: u32::try_from(cores).ok().filter(|c| *c > 0)?,
        ticks_per_second,
    })
}

/// The throttling of a unit's `cpu.stat`: how often its CPU quota stopped it, and for how long.
/// `None` for a text without the two counters, which the kernel writes where it has CFS bandwidth.
pub fn throttle(cpu_stat: &str) -> Option<Throttle> {
    let counter = |name: &str| {
        cpu_stat.lines().find_map(|line| {
            let (key, value) = line.split_once(' ')?;
            (key == name).then_some(value)?.trim().parse().ok()
        })
    };
    Some(Throttle {
        nr_throttled: counter("nr_throttled")?,
        throttled_usec: counter("throttled_usec")?,
    })
}

/// The whole seconds since boot of `/proc/uptime`, whose first field is the uptime. `None` for a
/// text that is not `/proc/uptime`.
pub fn uptime_seconds(uptime: &str) -> Option<u64> {
    let seconds: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds as u64)
}

/// The busy CPU in millicores since the previous reading: the share of the clock ticks that were
/// not idle, times the cores. Without a previous reading the whole time since boot is averaged.
pub fn busy_millicores(previous: Option<CpuTimes>, now: CpuTimes) -> u64 {
    let (busy, total) = match previous {
        Some(previous) if now.total > previous.total && now.busy >= previous.busy => {
            (now.busy - previous.busy, now.total - previous.total)
        }
        Some(_) => return 0,
        None => (now.busy, now.total),
    };
    if total == 0 {
        return 0;
    }
    let millicores = u128::from(busy) * u128::from(now.cores) * 1000 / u128::from(total);
    u64::try_from(millicores)
        .unwrap_or(u64::MAX)
        .min(u64::from(now.cores) * 1000)
}

/// What a `NodeSample` is made of.
pub struct Inputs<'a> {
    pub now_ms: i64,
    pub memory: Memory,
    pub busy_millicores: u64,
    pub cores: u32,
    /// The latest reading of the pool, and the sum of the nominal sizes of the volumes.
    pub pool: Option<(&'a PoolSample, u64)>,
    pub room: bool,
    pub volumes_total: u64,
    pub volumes_mounted: u64,
    /// `NodeSample.archive` (`facts::node_archive`).
    pub archive: Value,
    pub awake: &'a Snapshot,
    pub credentials_revision: Option<u64>,
}

/// The node's sample (`NodeSample`): what Cloudflare derives the active RAM and the CPU load of
/// the 80 % rule from.
pub fn node_sample(inputs: &Inputs) -> Value {
    let pool = inputs.pool.map(|(pool, nominal_bytes)| {
        let age = i64::try_from(
            Instant::now()
                .saturating_duration_since(pool.observed)
                .as_millis(),
        )
        .unwrap_or(0);
        pool.to_contract(&timestamp(inputs.now_ms - age), nominal_bytes)
    });
    json!({
        "observed_at": timestamp(inputs.now_ms),
        "memory": {
            "total_bytes": inputs.memory.total_bytes,
            "available_bytes": inputs.memory.available_bytes.min(inputs.memory.total_bytes),
        },
        "cpu": {"cores": inputs.cores, "busy_millicores": inputs.busy_millicores},
        "pool": pool,
        "room": inputs.room,
        "volumes": {"total": inputs.volumes_total, "mounted": inputs.volumes_mounted},
        "archive": inputs.archive,
        "awake": inputs.awake.awake,
        "awake_memory_mib": inputs.awake.awake_memory_mib,
        "starting": inputs.awake.starting,
        "queued": inputs.awake.queued,
        "credentials_revision": inputs.credentials_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const STAT: &str = "cpu  4705 150 1120 16250 520 10 55 20 0 0\ncpu0 1175 37 280 4062 130 2 14 5 0 0\ncpu1 1176 38 280 4063 130 3 14 5 0 0\ncpu2 1177 37 280 4062 130 2 13 5 0 0\ncpu3 1177 38 280 4063 130 3 14 5 0 0\nintr 12345 0 0\nctxt 999\nbtime 1\n";

    #[test]
    fn the_uptime_is_the_whole_seconds_since_boot_of_proc_uptime() {
        assert_eq!(uptime_seconds("1234.56 4321.00\n"), Some(1234));
        assert_eq!(uptime_seconds("0.99 0.00\n"), Some(0));
        for broken in ["", "up 12", "-3.0 1.0", "NaN 1", "inf 1"] {
            assert_eq!(uptime_seconds(broken), None, "{broken:?}");
        }
    }

    #[test]
    fn the_times_of_proc_stat_are_busy_and_total_ticks_over_the_cores() {
        let times = cpu_times(STAT, 100).unwrap();
        assert_eq!(times.cores, 4);
        assert_eq!(times.busy, 4705 + 150 + 1120 + 10 + 55 + 20);
        assert_eq!(times.total, times.busy + 16250 + 520);
        assert_eq!(times.steal, 20);
        assert_eq!(times.ticks_per_second, 100);
        for broken in [
            "",
            "cpu  1 2 3",
            "memory 1 2 3 4 5 6 7 8",
            "cpu  a b c d e f g h\ncpu0 1\n",
            "cpu  1 2 3 4 5 6 7 8\n",
        ] {
            assert_eq!(cpu_times(broken, 100), None, "{broken:?}");
        }
    }

    /// The `cpu.stat` of a database's unit in the lab after 3 million rows under `CPUQuota=10%`
    /// (systemd 257, cgroup v2).
    const CPU_STAT: &str = "usage_usec 564646\nuser_usec 459642\nsystem_usec 105004\ncore_sched.force_idle_usec 0\nnr_periods 47\nnr_throttled 46\nthrottled_usec 4220415\nnr_bursts 0\nburst_usec 0\n";

    #[test]
    fn the_throttling_of_a_unit_is_its_two_counters_in_cpu_stat() {
        assert_eq!(
            throttle(CPU_STAT),
            Some(Throttle {
                nr_throttled: 46,
                throttled_usec: 4_220_415
            })
        );
        // A name that only ends in a counter's is not the counter.
        for broken in [
            "",
            "usage_usec 1\n",
            "nr_throttled 7\n",
            "nr_throttled 7\nthrottled_usec x\n",
            "burst_nr_throttled 7\nthrottled_usec 1\n",
        ] {
            assert_eq!(throttle(broken), None, "{broken:?}");
        }
    }

    fn times(busy: u64, total: u64) -> CpuTimes {
        CpuTimes {
            busy,
            total,
            steal: 0,
            cores: 4,
            ticks_per_second: 100,
        }
    }

    #[test]
    fn the_busy_cpu_is_the_share_of_the_ticks_since_the_previous_reading_times_the_cores() {
        // 25 % busy over 1000 ticks of four cores' time: one core.
        assert_eq!(
            busy_millicores(Some(times(100, 1000)), times(350, 2000)),
            1000
        );
        // Fully busy is every core; a counter that went backwards is not a reading.
        assert_eq!(busy_millicores(Some(times(0, 0)), times(500, 500)), 4000);
        assert_eq!(busy_millicores(Some(times(400, 1000)), times(300, 2000)), 0);
        assert_eq!(busy_millicores(Some(times(5, 10)), times(5, 10)), 0);
        // The first reading averages the time since boot.
        assert_eq!(busy_millicores(None, times(250, 1000)), 1000);
        assert_eq!(busy_millicores(None, times(0, 0)), 0);
    }

    #[test]
    fn the_sample_of_the_node_is_what_the_contract_states() {
        let awake = Snapshot {
            awake: vec!["dbbbbbbbbbbbbbbbbbbb".into()],
            awake_memory_mib: 256,
            starting: 0,
            queued: 1,
        };
        let pool = PoolSample {
            observed: Instant::now(),
            data_total_bytes: 134_217_728_000,
            data_used_bytes: 42_949_672_960,
            metadata_total_bytes: 1_073_741_824,
            metadata_used_bytes: 1_048_576,
            mode: crate::storage::PoolMode::ReadWrite,
            needs_check: false,
        };
        let now_ms = 1_792_319_000_000;
        let inputs = Inputs {
            now_ms,
            memory: Memory {
                total_bytes: 12 << 30,
                available_bytes: 9 << 30,
            },
            busy_millicores: 1200,
            cores: 6,
            pool: Some((&pool, 300 << 30)),
            room: true,
            volumes_total: 300,
            volumes_mounted: 280,
            archive: json!({"ready_files": 3, "oldest_ready_seconds": 42}),
            awake: &awake,
            credentials_revision: Some(3),
        };
        let sample = node_sample(&inputs);
        assert!(
            crate::node_link::contract_valid("NodeSample", &sample),
            "{sample}"
        );
        assert_eq!(sample["pool"]["nominal_bytes"], 300u64 << 30);
        assert_eq!(sample["awake"], json!(["dbbbbbbbbbbbbbbbbbbb"]));
        // What is not known is null and never zero: no pool, no archive facts, no credentials yet.
        let unknown = node_sample(&Inputs {
            pool: None,
            archive: json!({"ready_files": null, "oldest_ready_seconds": null}),
            credentials_revision: None,
            ..inputs
        });
        assert!(
            crate::node_link::contract_valid("NodeSample", &unknown),
            "{unknown}"
        );
        assert_eq!(unknown["pool"], Value::Null);
        assert_eq!(unknown["credentials_revision"], Value::Null);
        // More memory available than there is cannot be told.
        let odd = node_sample(&Inputs {
            memory: Memory {
                total_bytes: 100,
                available_bytes: 200,
            },
            ..inputs
        });
        assert_eq!(odd["memory"]["available_bytes"], 100);
    }
}
