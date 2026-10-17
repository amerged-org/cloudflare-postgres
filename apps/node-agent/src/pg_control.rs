// SPDX-License-Identifier: Apache-2.0
//! PostgreSQL 18 `pg_control`: the data directory's identity and whether it shut down cleanly.
use serde::{Deserialize, Serialize};

/// `pg_control` below the volume's root.
pub const CONTROL_PATH: &str = "pgdata/global/pg_control";
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
