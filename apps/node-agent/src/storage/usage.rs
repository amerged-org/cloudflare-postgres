// SPDX-License-Identifier: Apache-2.0
//! How full a database's volume is (plan 4.3, "A full single volume"): the alert levels.
use super::VolumeId;
use serde_json::{Value, json};

/// A volume at this share of its space or inodes raises a warning.
pub const WARNING_PERCENT: u64 = 80;
/// A volume at this share raises the critical alert.
pub const CRITICAL_PERCENT: u64 = 90;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Alert {
    Warning,
    Critical,
}

/// `statvfs` of the mounted filesystem, read every 60 seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FsUsage {
    pub total_bytes: u64,
    /// Total minus free, as `df` counts it.
    pub used_bytes: u64,
    /// Free space available to PostgreSQL.
    pub available_bytes: u64,
    pub inodes_total: u64,
    pub inodes_used: u64,
}

impl FsUsage {
    /// From the numbers of `statvfs`: block size, blocks, free blocks, blocks free for users, and
    /// inodes and free inodes.
    pub fn from_blocks(
        block_size: u64,
        blocks: u64,
        free_blocks: u64,
        available_blocks: u64,
        inodes: u64,
        free_inodes: u64,
    ) -> Self {
        Self {
            total_bytes: blocks * block_size,
            used_bytes: blocks.saturating_sub(free_blocks) * block_size,
            available_bytes: available_blocks * block_size,
            inodes_total: inodes,
            inodes_used: inodes.saturating_sub(free_inodes),
        }
    }
    /// The share of space a user has taken, rounded up like `df` does: 100 means full, even with
    /// one block left.
    pub fn space_percent(&self) -> u64 {
        percent(self.used_bytes, self.used_bytes + self.available_bytes)
    }
    pub fn inode_percent(&self) -> u64 {
        percent(self.inodes_used, self.inodes_total)
    }
    pub fn space_alert(&self) -> Option<Alert> {
        alert(self.space_percent())
    }
    pub fn inode_alert(&self) -> Option<Alert> {
        alert(self.inode_percent())
    }
}

fn percent(used: u64, of: u64) -> u64 {
    if of == 0 {
        return 100;
    }
    (u128::from(used) * 100).div_ceil(u128::from(of)) as u64
}
fn alert(percent: u64) -> Option<Alert> {
    match percent {
        CRITICAL_PERCENT.. => Some(Alert::Critical),
        WARNING_PERCENT.. => Some(Alert::Warning),
        _ => None,
    }
}

/// What the node knows of one volume.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VolumeInfo {
    pub id: VolumeId,
    /// The nominal size.
    pub size_bytes: u64,
    /// Pool chunks the volume holds.
    pub pool_used_bytes: u64,
    /// Its ext4 was made.
    pub formatted: bool,
    /// The pool took no writes while the volume was mounted: it may have lost some (the volume
    /// carries a tag for it). Only `recover_volume` mounts it again.
    pub suspect: bool,
    /// ext4 recorded an error on the volume's filesystem, mounted anywhere on the node (the
    /// agent's namespace, a unit's, a job's): a journal abort after a write failed, for example.
    pub fs_errors: bool,
    /// The agent's own mount of the volume, which space and inodes are read from; none after the
    /// agent restarted, until it has mounted the volume again.
    pub mount: Option<MountInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MountInfo {
    pub usage: FsUsage,
}

impl VolumeInfo {
    pub fn mounted(&self) -> bool {
        self.mount.is_some()
    }
    /// The volume needs the stop, unmount, repair and mount of `recover_volume` before its
    /// database starts again.
    pub fn needs_repair(&self) -> bool {
        self.suspect || self.fs_errors
    }
    /// One entry of the contract's `NodeVolumeReport`.
    pub fn to_contract(&self) -> Value {
        json!({
            "database": self.id.database(),
            "storage_generation": self.id.generation(),
            "mounted": self.mounted(),
            "size_bytes": self.size_bytes,
            "pool_used_bytes": self.pool_used_bytes,
            "filesystem": self.mount.map(|mount| json!({
                "total_bytes": mount.usage.total_bytes,
                "used_bytes": mount.usage.used_bytes,
                "inodes_total": mount.usage.inodes_total,
                "inodes_used": mount.usage.inodes_used,
            })),
        })
    }
}

/// Why a volume may go (plan invariant 7: only explicit orders remove anything). Each carries the
/// storage generation the persisted desired state or order names, which the volume's own
/// generation must not pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removal {
    /// The desired state of its database is `deleted` at this storage generation.
    DatabaseDeleted { storage_generation: u64 },
    /// A `superseded` order for this storage generation or an older one; `remove_volume` is the
    /// order's flag.
    Superseded {
        storage_generation: u64,
        remove_volume: bool,
    },
}

impl Removal {
    /// Whether the order lets the volume of `id` go.
    pub(super) fn releases(self, id: &VolumeId) -> bool {
        match self {
            Removal::DatabaseDeleted { storage_generation } => {
                id.generation() <= storage_generation
            }
            Removal::Superseded {
                storage_generation,
                remove_volume,
            } => remove_volume && id.generation() <= storage_generation,
        }
    }
}

/// Every volume of the node and the sum of the pool's nominal sizes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inventory {
    pub volumes: Vec<VolumeInfo>,
    /// The sum of every thin volume's nominal size, for the logical cap.
    pub nominal_bytes: u64,
}

impl Inventory {
    /// The volumes a full pool may have left damaged: those mounted while the pool took no
    /// writes, and those on which ext4 recorded an error.
    pub fn damaged(&self) -> Vec<&VolumeInfo> {
        self.volumes
            .iter()
            .filter(|volume| volume.needs_repair())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 128 MiB volume with 1 KiB blocks, as `stat -f` showed it after a non-root user filled it
    /// (1 block left for users).
    fn full() -> FsUsage {
        FsUsage::from_blocks(1024, 120_787, 3_932, 1, 2_048, 2_035)
    }
    fn usage(used: u64, available: u64, inodes_used: u64) -> FsUsage {
        FsUsage {
            total_bytes: 1000,
            used_bytes: used,
            available_bytes: available,
            inodes_total: 100,
            inodes_used,
        }
    }

    #[test]
    fn usage_reads_from_statvfs_numbers() {
        let u = full();
        assert_eq!(u.total_bytes, 120_787 * 1024);
        assert_eq!(u.used_bytes, (120_787 - 3_932) * 1024);
        assert_eq!(u.available_bytes, 1024);
        assert_eq!((u.inodes_total, u.inodes_used), (2_048, 13));
        // A free count above the total (a racing statvfs) never underflows.
        let odd = FsUsage::from_blocks(1024, 10, 20, 30, 5, 9);
        assert_eq!((odd.used_bytes, odd.inodes_used), (0, 0));
    }

    #[test]
    fn the_share_is_rounded_up_so_that_one_free_block_is_still_full() {
        assert_eq!(full().space_percent(), 100);
        let released = FsUsage::from_blocks(1024, 120_787, 3_932, 1_311, 2_048, 2_035);
        assert_eq!(released.space_percent(), 99);
        assert_eq!(usage(800, 200, 0).space_percent(), 80);
        assert_eq!(usage(801, 199, 0).space_percent(), 81);
        assert_eq!(usage(0, 0, 0).space_percent(), 100);
        assert_eq!(usage(0, 1000, 0).space_percent(), 0);
        assert_eq!(usage(0, 10, 79).inode_percent(), 79);
        assert_eq!(usage(0, 10, 100).inode_percent(), 100);
    }

    #[test]
    fn alerts_start_at_80_and_become_critical_at_90_percent_of_space_or_inodes() {
        assert_eq!(usage(790, 210, 0).space_alert(), None);
        assert_eq!(usage(800, 200, 0).space_alert(), Some(Alert::Warning));
        assert_eq!(usage(890, 110, 0).space_alert(), Some(Alert::Warning));
        assert_eq!(usage(900, 100, 0).space_alert(), Some(Alert::Critical));
        // Rounded up like df: 79.1 % shows as 80 %.
        assert_eq!(usage(791, 209, 0).space_alert(), Some(Alert::Warning));
        assert_eq!(usage(0, 10, 79).inode_alert(), None);
        assert_eq!(usage(0, 10, 80).inode_alert(), Some(Alert::Warning));
        assert_eq!(usage(0, 10, 90).inode_alert(), Some(Alert::Critical));
        assert!(Alert::Critical > Alert::Warning);
    }

    #[test]
    fn a_volume_needs_repair_when_the_pool_failed_under_it_or_ext4_recorded_an_error() {
        let id = VolumeId::new("a1b2c3d4e5f6g7h8i9j0", 1).unwrap();
        let volume = |suspect: bool, fs_errors: bool, mounted: bool| VolumeInfo {
            id: id.clone(),
            size_bytes: 128 << 20,
            pool_used_bytes: 0,
            formatted: true,
            suspect,
            fs_errors,
            mount: mounted.then(|| MountInfo { usage: full() }),
        };
        assert!(!volume(false, false, true).needs_repair());
        assert!(!volume(false, false, false).needs_repair());
        // A volume the pool failed under has no recorded error, and may be unmounted since.
        assert!(volume(true, false, true).needs_repair());
        assert!(volume(true, false, false).needs_repair());
        // ext4's error is the volume's, whether or not the agent has it mounted: a unit may be
        // the only one that has.
        assert!(volume(false, true, true).needs_repair());
        assert!(volume(false, true, false).needs_repair());
    }

    #[test]
    fn a_volume_reports_what_the_contracts_volume_report_carries() {
        let id = VolumeId::new("a1b2c3d4e5f6g7h8i9j0", 1).unwrap();
        let mounted = VolumeInfo {
            id: id.clone(),
            size_bytes: 128 << 20,
            pool_used_bytes: 9_699_328,
            formatted: true,
            suspect: false,
            fs_errors: false,
            mount: Some(MountInfo { usage: full() }),
        };
        let asleep_unmounted = VolumeInfo {
            mount: None,
            ..mounted.clone()
        };
        let report = json!({
            "observed_at": "2026-10-18T10:00:00.000Z",
            "volumes": [mounted.to_contract(), asleep_unmounted.to_contract()],
        });
        // The same volume twice breaks the report's own rule; the entries are what is checked.
        let one = |v: &VolumeInfo| json!({"observed_at": "2026-10-18T10:00:00.000Z", "volumes": [v.to_contract()]});
        assert!(crate::node_link::contract_valid(
            "NodeVolumeReport",
            &one(&mounted)
        ));
        assert!(crate::node_link::contract_valid(
            "NodeVolumeReport",
            &one(&asleep_unmounted)
        ));
        assert_eq!(report["volumes"][0]["mounted"], true);
        assert_eq!(report["volumes"][0]["filesystem"]["inodes_used"], 13);
        assert_eq!(report["volumes"][1]["filesystem"], Value::Null);
        assert_eq!(report["volumes"][1]["storage_generation"], 1);
    }
}
