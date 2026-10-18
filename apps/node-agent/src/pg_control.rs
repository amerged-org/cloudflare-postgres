// SPDX-License-Identifier: Apache-2.0
//! PostgreSQL 18 `pg_control`: the data directory's identity and whether it shut down cleanly.
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
/// checkpoint of a clean stop is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlFile {
    pub control: Control,
    /// `checkPoint`: the location of the latest checkpoint record.
    pub checkpoint: u64,
}
/// The offset of `checkPoint` in PostgreSQL 18's `ControlFileData`.
const CHECKPOINT_OFFSET: usize = 32;
pub fn parse_control_file(bytes: &[u8]) -> Result<ControlFile, &'static str> {
    let control = parse_control(bytes)?;
    let mut checkpoint = [0u8; 8];
    checkpoint.copy_from_slice(&bytes[CHECKPOINT_OFFSET..CHECKPOINT_OFFSET + 8]);
    Ok(ControlFile {
        control,
        checkpoint: u64::from_le_bytes(checkpoint),
    })
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
}
