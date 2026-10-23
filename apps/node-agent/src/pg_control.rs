// SPDX-License-Identifier: Apache-2.0
//! PostgreSQL 18 `pg_control`: the data directory's identity, whether it shut down cleanly, and
//! the settings it ran with.
use crate::settings::Capacity;
use serde::{Deserialize, Serialize};

/// `pg_control` below the volume's root.
pub const CONTROL_PATH: &str = "pgdata/global/pg_control";
/// `pg_control` of a database of the node, below its volume's mount point.
pub const CONTROL_FILE: &str = "data/global/pg_control";
pub const PG_CONTROL_VERSION: u32 = 1800;
pub const DB_SHUTDOWNED: i32 = 1;

/// `pg_control` as the agent read it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    /// PostgreSQL's DBState: 1 is "shut down".
    pub state: i32,
    pub system_identifier: String,
    /// `checkPointCopy.ThisTimeLineID`.
    pub timeline: u32,
}
impl Control {
    pub fn shut_down(&self) -> bool {
        self.state == DB_SHUTDOWNED
    }
}
/// A position in the write-ahead log, as `pg_control` and `pg_switch_wal()` write it: two hexadecimal
/// words, `X/Y`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Lsn(pub u64);
impl Lsn {
    /// The upper-case text of the contract (`ProvenSleepRecord.checkpoint_lsn`): `None` for any
    /// other.
    pub fn parse(text: &str) -> Option<Self> {
        let (high, low) = text.split_once('/')?;
        let word = |word: &str| -> Option<u64> {
            let valid = (1..=8).contains(&word.len())
                && word
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b));
            if valid {
                u64::from_str_radix(word, 16).ok()
            } else {
                None
            }
        };
        Some(Self((word(high)? << 32) | word(low)?))
    }
    /// The last byte of the position before this one: the segment a WAL switch closed holds it.
    pub fn previous_byte(self) -> Self {
        Self(self.0.saturating_sub(1))
    }
    /// The name of the WAL segment of `timeline` that holds this position, for segments of
    /// `segment_bytes`.
    pub fn segment(self, timeline: u32, segment_bytes: u64) -> String {
        let number = self.0 / segment_bytes;
        let per_xlogid = (1u64 << 32) / segment_bytes;
        format!(
            "{timeline:08X}{:08X}{:08X}",
            number / per_xlogid,
            number % per_xlogid
        )
    }
}
impl std::fmt::Display for Lsn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:X}/{:X}", self.0 >> 32, self.0 & 0xFFFF_FFFF)
    }
}

/// `pg_control` with the position of its latest checkpoint, which is where the shutdown
/// checkpoint of a clean stop is, and the position recovery would start reading from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlFile {
    pub control: Control,
    /// `checkPoint`: the location of the latest checkpoint record.
    pub checkpoint: u64,
    /// `checkPointCopy.redo`: where the WAL replay of a crash starts. It is the checkpoint
    /// record's own position after a clean stop, and an earlier one after a crash.
    pub redo: u64,
}
/// The offset of `checkPoint` in PostgreSQL 18's `ControlFileData`.
const CHECKPOINT_OFFSET: usize = 32;
/// The offset of `checkPointCopy.redo`, the first member of `CheckPoint`, which follows `checkPoint`.
const REDO_OFFSET: usize = 40;
pub fn parse_control_file(bytes: &[u8]) -> Result<ControlFile, &'static str> {
    let control = parse_control(bytes)?;
    let position = |offset: usize| {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[offset..offset + 8]);
        u64::from_le_bytes(word)
    };
    Ok(ControlFile {
        control,
        checkpoint: position(CHECKPOINT_OFFSET),
        redo: position(REDO_OFFSET),
    })
}

/// The offset of `MaxConnections` in PostgreSQL 18's `ControlFileData`, followed by
/// `max_worker_processes`, `max_wal_senders`, `max_prepared_xacts` and `max_locks_per_xact`, each
/// an `int`.
const CAPACITY_OFFSET: usize = 180;
/// The settings the server that wrote `pg_control` ran with (see `Capacity`). A copy of the file in
/// a base backup has the source's.
pub fn parse_capacity(bytes: &[u8]) -> Result<Capacity, &'static str> {
    parse_control(bytes)?;
    let setting = |index: usize| {
        let offset = CAPACITY_OFFSET + 4 * index;
        let word = bytes.get(offset..offset + 4)?;
        u32::try_from(i32::from_le_bytes([word[0], word[1], word[2], word[3]])).ok()
    };
    let read = || {
        Some(Capacity {
            max_connections: setting(0)?,
            max_worker_processes: setting(1)?,
            max_wal_senders: setting(2)?,
            max_prepared_transactions: setting(3)?,
            max_locks_per_transaction: setting(4)?,
        })
    };
    read().ok_or("control_unreadable")
}

/// Parses the first bytes of a PostgreSQL 18 `pg_control`.
pub fn parse_control(bytes: &[u8]) -> Result<Control, &'static str> {
    if bytes.len() < 52 {
        return Err("control_unreadable");
    }
    let word = |offset: usize| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    let mut identifier = [0u8; 8];
    identifier.copy_from_slice(&bytes[..8]);
    if word(8) != PG_CONTROL_VERSION {
        return Err("control_version");
    }
    let state = word(16) as i32;
    let timeline = word(48);
    if !(0..=6).contains(&state) || timeline == 0 {
        return Err("control_unreadable");
    }
    Ok(Control {
        state,
        system_identifier: u64::from_le_bytes(identifier).to_string(),
        timeline,
    })
}

/// A `pg_control` of PostgreSQL 18 as a server that ran with `capacity` left it: one block, shut
/// down, on timeline 1. The test double of a restored backup's file; the offsets are those a real
/// server's file is read at (`the_settings_a_real_server_ran_with_are_in_its_control_file`).
#[cfg(test)]
pub(crate) fn control_file(capacity: &Capacity) -> Vec<u8> {
    let mut bytes = vec![0u8; 8192];
    bytes[..8].copy_from_slice(&7_431_215_993_172_011_234u64.to_le_bytes());
    bytes[8..12].copy_from_slice(&PG_CONTROL_VERSION.to_le_bytes());
    bytes[16..20].copy_from_slice(&DB_SHUTDOWNED.to_le_bytes());
    bytes[48..52].copy_from_slice(&1u32.to_le_bytes());
    for (index, setting) in [
        capacity.max_connections,
        capacity.max_worker_processes,
        capacity.max_wal_senders,
        capacity.max_prepared_transactions,
        capacity.max_locks_per_transaction,
    ]
    .into_iter()
    .enumerate()
    {
        let offset = CAPACITY_OFFSET + 4 * index;
        bytes[offset..offset + 4].copy_from_slice(&setting.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    fn control(version: u32, state: i32, timeline: u32, length: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; length];
        let identifier = 7_431_215_993_172_011_234u64.to_le_bytes();
        let mut put = |offset: usize, value: &[u8]| {
            if offset + value.len() <= length {
                bytes[offset..offset + value.len()].copy_from_slice(value);
            }
        };
        put(0, &identifier);
        put(8, &version.to_le_bytes());
        put(16, &state.to_le_bytes());
        put(48, &timeline.to_le_bytes());
        bytes
    }

    #[test]
    fn an_lsn_is_two_upper_case_hexadecimal_words_and_orders_as_a_number() {
        let lsn = Lsn::parse("1A/2B3C4D5E").unwrap();
        assert_eq!(lsn.0, (0x1A << 32) | 0x2B3C4D5E);
        assert_eq!(lsn.to_string(), "1A/2B3C4D5E");
        assert_eq!(Lsn(0).to_string(), "0/0");
        assert!(Lsn::parse("0/FFFFFFFF").unwrap() < Lsn::parse("1/0").unwrap());
        for bad in [
            "",
            "0",
            "0/",
            "/0",
            "0/g",
            "0/1/2",
            "100000000/0",
            "0/100000000",
            "0/a",
        ] {
            assert_eq!(Lsn::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_wal_segment_is_named_by_its_timeline_and_position() {
        // 16 MiB segments: 256 per xlogid.
        let lsn = Lsn::parse("1/0200ABCD").unwrap();
        assert_eq!(lsn.segment(1, 16 << 20), "000000010000000100000002");
        assert_eq!(
            Lsn::parse("0/FFFFFF").unwrap().segment(3, 16 << 20),
            "000000030000000000000000"
        );
        // 1 MiB segments (a test cluster): 4096 per xlogid.
        assert_eq!(
            Lsn::parse("2/00300000").unwrap().segment(1, 1 << 20),
            "000000010000000200000003"
        );
        // The segment before the one an LSN starts is the one the switch closed.
        assert_eq!(
            Lsn::parse("1/03000000")
                .unwrap()
                .previous_byte()
                .segment(1, 16 << 20),
            "000000010000000100000002"
        );
    }

    #[test]
    fn pg_control_bytes_yield_identifier_state_and_timeline_and_refuse_other_versions() {
        let clean = parse_control(&control(1800, 1, 1, 296)).unwrap();
        assert_eq!(clean.system_identifier, "7431215993172011234");
        assert_eq!((clean.state, clean.timeline), (1, 1));
        assert!(clean.shut_down());
        let running = parse_control(&control(1800, 6, 3, 296)).unwrap();
        assert_eq!((running.state, running.timeline), (6, 3));
        assert!(!running.shut_down());
        assert_eq!(
            parse_control(&control(1700, 1, 1, 296)),
            Err("control_version")
        );
        assert_eq!(
            parse_control(&control(1800, 1, 1, 40)),
            Err("control_unreadable")
        );
    }

    /// The checkpoint record and the redo point are the two 64-bit words that follow the state and
    /// the time (`ControlFileData.checkPoint`, then `checkPointCopy.redo`).
    #[test]
    fn the_checkpoint_and_the_redo_position_are_read_at_their_own_offsets() {
        let mut bytes = control(1800, 1, 1, 296);
        bytes[CHECKPOINT_OFFSET..CHECKPOINT_OFFSET + 8]
            .copy_from_slice(&0x0000_0003_0200_5A40u64.to_le_bytes());
        bytes[REDO_OFFSET..REDO_OFFSET + 8]
            .copy_from_slice(&0x0000_0003_01FF_0000u64.to_le_bytes());
        let file = parse_control_file(&bytes).unwrap();
        assert_eq!((file.checkpoint, file.redo), (0x3_0200_5A40, 0x3_01FF_0000));
        // The timeline that follows them is the checkpoint's own.
        assert_eq!(file.control.timeline, 1);
    }

    #[test]
    fn the_settings_of_a_control_file_are_its_five_ints_and_nothing_else_is_accepted() {
        let capacity = Capacity {
            max_connections: 213,
            max_worker_processes: 11,
            max_wal_senders: 7,
            max_prepared_transactions: 5,
            max_locks_per_transaction: 77,
        };
        assert_eq!(parse_capacity(&control_file(&capacity)), Ok(capacity));
        let mut other_version = control_file(&capacity);
        other_version[8..12].copy_from_slice(&1700u32.to_le_bytes());
        assert_eq!(parse_capacity(&other_version), Err("control_version"));
        // A file that stops before the settings, and a setting that is no count.
        assert_eq!(
            parse_capacity(&control_file(&capacity)[..190]),
            Err("control_unreadable")
        );
        let mut negative = control_file(&capacity);
        negative[CAPACITY_OFFSET..CAPACITY_OFFSET + 4].copy_from_slice(&(-1i32).to_le_bytes());
        assert_eq!(parse_capacity(&negative), Err("control_unreadable"));
    }

    /// The offsets are PostgreSQL 18's `ControlFileData` (checked against 18.6): a server that ran
    /// with the settings of a class, or with others, leaves exactly those in its control file.
    #[test]
    fn the_settings_a_real_server_ran_with_are_in_its_control_file() {
        use crate::testpg::Cluster;
        let unusual = "max_connections = 213\nmax_worker_processes = 11\nmax_wal_senders = 7\n\
                       max_prepared_transactions = 5\nmax_locks_per_transaction = 77\n";
        for (memory_mib, extra, expected) in [
            (256, "", Capacity::of_class(256, 25)),
            (1024, "", Capacity::of_class(1024, 25)),
            (
                256,
                unusual,
                Capacity {
                    max_connections: 213,
                    max_worker_processes: 11,
                    max_wal_senders: 7,
                    max_prepared_transactions: 5,
                    max_locks_per_transaction: 77,
                },
            ),
        ] {
            let Some(cluster) = Cluster::create("control-settings") else {
                return;
            };
            cluster.configure(memory_mib, None);
            cluster.append_conf(extra);
            cluster.start();
            cluster.stop();
            let bytes = crate::proof::read_control(&cluster.volume()).unwrap();
            assert_eq!(parse_capacity(&bytes), Ok(expected), "{memory_mib} MiB");
        }
    }
}
