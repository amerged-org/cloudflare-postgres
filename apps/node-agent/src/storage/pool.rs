// SPDX-License-Identifier: Apache-2.0
//! The thin pool's health from `dmsetup`, the policy Cloudflare sets for it, and the room rule of
//! plan 4.6 that every start, create and restore on the node asks.
use super::{Error, ids::dm_name};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

const SECTOR_BYTES: u64 = 512;
/// The thin-pool target counts its metadata in blocks of 4 KiB.
const METADATA_BLOCK_BYTES: u64 = 4096;

/// The kernel's thin-pool mode (`Documentation/admin-guide/device-mapper/thin-provisioning`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolMode {
    ReadWrite,
    ReadOnly,
    /// No free data block: writes fail at once (the pool has `error_if_no_space`).
    OutOfDataSpace,
}

/// One reading of the pool. Plan 4.3: it is read every 5 s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolSample {
    pub observed: Instant,
    pub data_total_bytes: u64,
    pub data_used_bytes: u64,
    pub metadata_total_bytes: u64,
    pub metadata_used_bytes: u64,
    pub mode: PoolMode,
    /// The kernel wants `thin_check` before the metadata can be trusted again.
    pub needs_check: bool,
}

impl PoolSample {
    pub fn free_data_bytes(&self) -> u64 {
        self.data_total_bytes.saturating_sub(self.data_used_bytes)
    }
    /// The pool takes writes. Otherwise every write to a volume fails, and a mounted ext4 can lose
    /// metadata without recording an error.
    pub fn writable(&self) -> bool {
        self.mode == PoolMode::ReadWrite && !self.needs_check
    }
    /// The `pool` object of the contract's `NodeSample`. `nominal_bytes` is the sum of every
    /// volume's nominal size (from the volume inventory).
    pub fn to_contract(&self, observed_at: &str, nominal_bytes: u64) -> Value {
        json!({
            "observed_at": observed_at,
            "data_total_bytes": self.data_total_bytes,
            "data_used_bytes": self.data_used_bytes,
            "metadata_total_bytes": self.metadata_total_bytes,
            "metadata_used_bytes": self.metadata_used_bytes,
            "nominal_bytes": nominal_bytes,
        })
    }
}

/// Reads the pool of `group`/`pool` from `dmsetup status --target thin-pool` and `dmsetup table
/// --target thin-pool`.
pub fn parse_pool(
    group: &str,
    pool: &str,
    status: &str,
    table: &str,
    observed: Instant,
) -> Result<PoolSample, Error> {
    const BAD: Error = Error::Parse("thin pool status");
    // lvm2 names the pool target `<group>-<pool>-tpool` once a thin volume exists, and
    // `<group>-<pool>` before.
    let visible = dm_name(group, pool);
    let devices = [format!("{visible}:"), format!("{visible}-tpool:")];
    let line = |text: &str| -> Result<Vec<String>, Error> {
        text.lines()
            .map(|line| {
                line.split_whitespace()
                    .map(String::from)
                    .collect::<Vec<_>>()
            })
            .find(|words| {
                words.first().is_some_and(|name| devices.contains(name))
                    && words.get(3).is_some_and(|word| word == "thin-pool")
            })
            .ok_or(BAD)
    };
    let (status, table) = (line(status)?, line(table)?);
    // `<name>: 0 <sectors> thin-pool <txid> <meta used>/<total> <data used>/<total> <held root>
    // <mode> <discard> <no space> <needs_check> <low water mark>`
    let [
        _,
        _,
        sectors,
        _,
        _,
        metadata,
        data,
        _,
        mode,
        _,
        _,
        needs_check,
        ..,
    ] = &status[..]
    else {
        return Err(BAD);
    };
    // `<name>: 0 <sectors> thin-pool <metadata dev> <data dev> <chunk sectors> ...`
    let chunk = table
        .get(6)
        .and_then(|w| w.parse::<u64>().ok())
        .filter(|c| *c > 0)
        .ok_or(BAD)?;
    let counts = |pair: &str| -> Result<(u64, u64), Error> {
        let (used, total) = pair.split_once('/').ok_or(BAD)?;
        let (used, total) = (
            used.parse().map_err(|_| BAD)?,
            total.parse().map_err(|_| BAD)?,
        );
        if used > total {
            return Err(BAD);
        }
        Ok((used, total))
    };
    let (metadata_used, metadata_total) = counts(metadata)?;
    let (data_used, data_total) = counts(data)?;
    if sectors.parse::<u64>().map_err(|_| BAD)? != data_total * chunk {
        return Err(BAD);
    }
    let mode = match mode.as_str() {
        "rw" => PoolMode::ReadWrite,
        "ro" => PoolMode::ReadOnly,
        "out_of_data_space" => PoolMode::OutOfDataSpace,
        _ => return Err(BAD),
    };
    let needs_check = match needs_check.as_str() {
        "needs_check" => true,
        "-" => false,
        _ => return Err(BAD),
    };
    let (chunk_bytes, block) = (chunk * SECTOR_BYTES, METADATA_BLOCK_BYTES);
    Ok(PoolSample {
        observed,
        data_total_bytes: data_total * chunk_bytes,
        data_used_bytes: data_used * chunk_bytes,
        metadata_total_bytes: metadata_total * block,
        metadata_used_bytes: metadata_used * block,
        mode,
        needs_check,
    })
}

/// The mapped bytes of every thin device in `dmsetup status --target thin`, by device name.
pub fn parse_thin_mapped(status: &str) -> Result<Vec<(String, u64)>, Error> {
    status
        .lines()
        .filter(|line| !line.trim().is_empty() && line.trim() != "No devices found")
        .map(|line| {
            // `<name>: 0 <sectors> thin <mapped sectors> <highest mapped sector>`
            let words: Vec<&str> = line.split_whitespace().collect();
            let [name, _, _, "thin", mapped, ..] = words[..] else {
                return Err(Error::Parse("thin device status"));
            };
            let mapped: u64 = mapped
                .parse()
                .map_err(|_| Error::Parse("thin device status"))?;
            let name = name
                .strip_suffix(':')
                .ok_or(Error::Parse("thin device status"))?;
            Ok((name.to_string(), mapped * SECTOR_BYTES))
        })
        .collect()
}

/// The storage rules Cloudflare sets for the node (`NodePolicy.storage`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Free pool data below this refuses starts, creates and restores.
    pub reserve_bytes: u64,
    /// Pool metadata at or above this share refuses them too.
    pub metadata_no_room_percent: u8,
    /// The pool sample may be this old.
    pub sample_max_age: Duration,
}

impl Policy {
    /// From the `storage` object of a desired page that passed its schema.
    pub fn from_json(storage: &Value) -> Option<Self> {
        let number = |field: &str| storage[field].as_u64();
        let percent = u8::try_from(number("metadata_no_room_percent")?).ok()?;
        let seconds = number("sample_max_age_seconds")?;
        if !(1..=100).contains(&percent) || !(1..=60).contains(&seconds) {
            return None;
        }
        Some(Self {
            reserve_bytes: number("reserve_bytes")?,
            metadata_no_room_percent: percent,
            sample_max_age: Duration::from_secs(seconds),
        })
    }
}

/// Why the room rule does not hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoRoom {
    /// No pool reading yet, or the pool could not be read.
    Unobserved,
    /// The reading is older than the policy allows.
    Stale,
    /// The pool is read-only, out of data space or wants a check: writes fail.
    Unwritable,
    /// Free data is below the reserve.
    Reserve,
    /// Metadata use reached the policy's share.
    Metadata,
}

/// Plan 4.6, rule 1: the pool sample is fresh and the "no room" rule of 4.3 does not hold. The
/// answer to a client is `57P03` with detail "storage".
pub fn room(sample: Option<&PoolSample>, now: Instant, policy: &Policy) -> Result<(), NoRoom> {
    let sample = sample.ok_or(NoRoom::Unobserved)?;
    if now.saturating_duration_since(sample.observed) > policy.sample_max_age {
        return Err(NoRoom::Stale);
    }
    if !sample.writable() {
        return Err(NoRoom::Unwritable);
    }
    if sample.free_data_bytes() < policy.reserve_bytes {
        return Err(NoRoom::Reserve);
    }
    if u128::from(sample.metadata_used_bytes) * 100
        >= u128::from(sample.metadata_total_bytes) * u128::from(policy.metadata_no_room_percent)
    {
        return Err(NoRoom::Metadata);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STATUS: &str = include_str!("fixtures/dm-status-pool.txt");
    const FULL: &str = include_str!("fixtures/dm-status-pool-full.txt");
    const TABLE: &str = include_str!("fixtures/dm-table-pool.txt");
    const THIN: &str = include_str!("fixtures/dm-status-thin.txt");

    fn read(status: &str) -> Result<PoolSample, Error> {
        parse_pool("pgcf", "pgcf_thinpool", status, TABLE, Instant::now())
    }

    #[test]
    fn the_pool_reads_in_blocks_of_the_tables_chunk_size() {
        let sample = read(STATUS).unwrap();
        // 8192 chunks of 64 KiB, 148 used; 2048 metadata blocks of 4 KiB, 216 used.
        assert_eq!(sample.data_total_bytes, 536_870_912);
        assert_eq!(sample.data_used_bytes, 148 * 65_536);
        assert_eq!(sample.metadata_total_bytes, 2048 * 4096);
        assert_eq!(sample.metadata_used_bytes, 216 * 4096);
        assert_eq!(sample.free_data_bytes(), 536_870_912 - 148 * 65_536);
        assert_eq!(
            (sample.mode, sample.needs_check),
            (PoolMode::ReadWrite, false)
        );
    }

    #[test]
    fn a_pool_without_thin_volumes_is_the_visible_device_without_the_tpool_suffix() {
        // lvm2 maps the pool target under `<group>-<pool>-tpool` only once a thin volume exists.
        let status = include_str!("fixtures/dm-status-pool-bare.txt");
        let table = include_str!("fixtures/dm-table-pool-bare.txt");
        let sample = parse_pool("pgcf", "pgcf_thinpool", status, table, Instant::now()).unwrap();
        assert_eq!(
            (sample.data_used_bytes, sample.data_total_bytes),
            (0, 6848 * 65_536)
        );
        assert_eq!(sample.mode, PoolMode::ReadWrite);
    }

    #[test]
    fn a_full_pool_reads_as_out_of_data_space() {
        // The status of a 64 MiB pool; its table has the same chunk size.
        let sample = read(FULL).unwrap();
        assert_eq!(sample.mode, PoolMode::OutOfDataSpace);
        assert_eq!(sample.free_data_bytes(), 0);
    }

    #[test]
    fn read_only_and_needs_check_are_read_from_their_places() {
        let ro = read(&STATUS.replace(" rw ", " ro ")).unwrap();
        assert_eq!(ro.mode, PoolMode::ReadOnly);
        let check = read(&STATUS.replace(
            "error_if_no_space - 512",
            "error_if_no_space needs_check 512",
        ))
        .unwrap();
        assert!(check.needs_check);
    }

    #[test]
    fn a_status_that_is_not_this_pools_is_an_error() {
        assert!(parse_pool("other", "pgcf_thinpool", STATUS, TABLE, Instant::now()).is_err());
        assert!(parse_pool("pgcf", "other", STATUS, TABLE, Instant::now()).is_err());
        assert!(read("").is_err());
        // A failed pool has no counters.
        assert!(read("pgcf-pgcf_thinpool-tpool: 0 1048576 thin-pool Fail\n").is_err());
        assert!(read(&STATUS.replace(" rw ", " weird ")).is_err());
        assert!(read(&STATUS.replace("148/8192", "9000/8192")).is_err());
        // The table must describe the same chunks as the status counts.
        assert!(read(&STATUS.replace("148/8192", "148/4096")).is_err());
        assert!(
            parse_pool(
                "pgcf",
                "pgcf_thinpool",
                STATUS,
                "pgcf-pgcf_thinpool-tpool: 0 1048576 thin-pool 252:0 252:1 0 0 1\n",
                Instant::now()
            )
            .is_err()
        );
    }

    #[test]
    fn thin_devices_report_their_mapped_bytes() {
        assert_eq!(
            parse_thin_mapped(THIN).unwrap(),
            vec![
                ("pgcf-db_a1b2c3d4e5f6g7h8i9j0_g1".to_string(), 18_944 * 512),
                ("pgcf-db_k1l2m3n4o5p6q7r8s9t0_g12".to_string(), 0),
                ("pgcf-stranger".to_string(), 0),
            ]
        );
        assert_eq!(parse_thin_mapped("").unwrap(), vec![]);
        assert!(parse_thin_mapped("pgcf-x: 0 8 thin\n").is_err());
        // "No devices found" is what dmsetup prints when none exists.
        assert_eq!(parse_thin_mapped("No devices found\n").unwrap(), vec![]);
    }

    fn policy() -> Policy {
        Policy {
            reserve_bytes: 6 << 30,
            metadata_no_room_percent: 75,
            sample_max_age: Duration::from_secs(10),
        }
    }
    fn sample(observed: Instant) -> PoolSample {
        PoolSample {
            observed,
            data_total_bytes: 100 << 30,
            data_used_bytes: 50 << 30,
            metadata_total_bytes: 4_096_000,
            metadata_used_bytes: 1_000_000,
            mode: PoolMode::ReadWrite,
            needs_check: false,
        }
    }

    #[test]
    fn the_room_rule_needs_a_pool_sample_that_is_at_most_ten_seconds_old() {
        let t0 = Instant::now();
        let s = sample(t0);
        assert_eq!(room(None, t0, &policy()), Err(NoRoom::Unobserved));
        assert_eq!(room(Some(&s), t0, &policy()), Ok(()));
        assert_eq!(
            room(Some(&s), t0 + Duration::from_secs(10), &policy()),
            Ok(())
        );
        assert_eq!(
            room(
                Some(&s),
                t0 + Duration::from_secs(10) + Duration::from_nanos(1),
                &policy()
            ),
            Err(NoRoom::Stale)
        );
    }

    #[test]
    fn the_room_rule_refuses_below_the_reserve_and_at_the_metadata_share() {
        let t0 = Instant::now();
        let mut s = sample(t0);
        s.data_used_bytes = s.data_total_bytes - (6 << 30);
        assert_eq!(room(Some(&s), t0, &policy()), Ok(()));
        s.data_used_bytes += 1;
        assert_eq!(room(Some(&s), t0, &policy()), Err(NoRoom::Reserve));

        let mut s = sample(t0);
        s.metadata_used_bytes = 3_071_999;
        assert_eq!(room(Some(&s), t0, &policy()), Ok(()));
        s.metadata_used_bytes = 3_072_000;
        assert_eq!(room(Some(&s), t0, &policy()), Err(NoRoom::Metadata));
    }

    #[test]
    fn a_pool_that_takes_no_writes_has_no_room_even_with_no_reserve() {
        let t0 = Instant::now();
        let no_reserve = Policy {
            reserve_bytes: 0,
            ..policy()
        };
        for change in [
            (|s: &mut PoolSample| s.mode = PoolMode::OutOfDataSpace) as fn(&mut PoolSample),
            |s| s.mode = PoolMode::ReadOnly,
            |s| s.needs_check = true,
        ] {
            let mut s = sample(t0);
            assert!(s.writable());
            change(&mut s);
            assert!(!s.writable());
            assert_eq!(room(Some(&s), t0, &no_reserve), Err(NoRoom::Unwritable));
        }
    }

    #[test]
    fn the_policy_reads_from_the_desired_pages_storage_object() {
        let storage = json!({"reserve_bytes": 6_442_450_944u64, "metadata_no_room_percent": 75, "sample_max_age_seconds": 10});
        assert_eq!(Policy::from_json(&storage), Some(policy()));
        assert_eq!(Policy::from_json(&json!({})), None);
        assert_eq!(
            Policy::from_json(
                &json!({"reserve_bytes": 1, "metadata_no_room_percent": 300, "sample_max_age_seconds": 10})
            ),
            None
        );
    }

    #[test]
    fn the_pool_object_is_what_the_contracts_node_sample_carries() {
        let sample = read(STATUS).unwrap();
        let node_sample = json!({
            "observed_at": "2026-10-18T10:00:00.000Z",
            "memory": {"total_bytes": 12_000_000_000u64, "available_bytes": 9_000_000_000u64},
            "cpu": {"cores": 6, "busy_millicores": 300},
            "pool": sample.to_contract("2026-10-18T10:00:00.000Z", 3 << 30),
            "room": true,
            "volumes": {"total": 3, "mounted": 3},
            "archive": {"ready_files": 0, "oldest_ready_seconds": null},
            "awake": [],
            "awake_memory_mib": 0,
            "starting": 0,
            "queued": 0,
            "credentials_revision": 1,
        });
        assert!(crate::node_link::schema_valid("NodeSample", &node_sample));
    }
}
