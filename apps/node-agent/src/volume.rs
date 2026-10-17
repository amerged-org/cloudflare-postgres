// SPDX-License-Identifier: Apache-2.0
//! A database's thin LV and the device-mapper names LVM gives it.
use serde::{Deserialize, Serialize};

pub const VOLUME_GROUP: &str = "pgcf";

fn uuid_text(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
/// LVM's UUID text: 6-4-4-4-4-4-6 alphanumerics (contracts StorageLvmUuid).
pub fn lvm_uuid(value: &str) -> bool {
    let groups: Vec<&str> = value.split('-').collect();
    groups.len() == 7
        && groups
            .iter()
            .zip([6, 4, 4, 4, 4, 4, 6])
            .all(|(group, length)| {
                group.len() == length && group.bytes().all(|b| b.is_ascii_alphanumeric())
            })
}

/// The tenant LV, as the database's storage receipt recorded it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Volume {
    /// The PV volume handle, `pvc-<uuid>`; OpenEBS names the LV after it.
    pub lv_name: String,
    /// The receipt's `lvUuid`.
    pub lv_uuid: String,
    /// The database's `storage.volume_group_uuid`.
    pub vg_uuid: String,
}
impl Volume {
    pub fn valid(&self) -> bool {
        self.lv_name.strip_prefix("pvc-").is_some_and(uuid_text)
            && lvm_uuid(&self.lv_uuid)
            && lvm_uuid(&self.vg_uuid)
    }
    /// The device-mapper name: VG and LV with every `-` doubled, joined by `-`.
    pub fn dm_name(&self) -> String {
        format!(
            "{}-{}",
            VOLUME_GROUP.replace('-', "--"),
            self.lv_name.replace('-', "--")
        )
    }
    /// The device-mapper UUID LVM gives the LV.
    pub fn dm_uuid(&self) -> String {
        format!(
            "LVM-{}{}",
            self.vg_uuid.replace('-', ""),
            self.lv_uuid.replace('-', "")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LV: &str = "aB3dE9-x1y2-Z3w4-v5u6-t7s8-r9q0-P1o2N3";
    #[test]
    fn volume_dm_name_doubles_dashes_and_dm_uuid_is_lvm_vg_then_lv_without_dashes() {
        let volume = Volume {
            lv_name: "pvc-0b1c2d3e-4f50-4617-8899-aabbccddeeff".into(),
            lv_uuid: LV.into(),
            vg_uuid: "Vg0001-a1b2-c3d4-e5f6-g7h8-i9j0-k1l2m3".into(),
        };
        assert!(volume.valid());
        assert_eq!(
            volume.dm_name(),
            "pgcf-pvc--0b1c2d3e--4f50--4617--8899--aabbccddeeff"
        );
        assert_eq!(
            volume.dm_uuid(),
            "LVM-Vg0001a1b2c3d4e5f6g7h8i9j0k1l2m3aB3dE9x1y2Z3w4v5u6t7s8r9q0P1o2N3"
        );
        let mut invalid = volume.clone();
        invalid.lv_name = "pvc-x".into();
        assert!(!invalid.valid());
    }
}
