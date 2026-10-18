// SPDX-License-Identifier: Apache-2.0
//! How full a database's volume is (plan 4.3, "A full single volume"): the alert levels, and when
//! the filesystem's root-only reserve is freed and given back.
use super::VolumeId;
use serde_json::{Value, json};

/// A volume at this share of its space or inodes raises a warning.
pub const WARNING_PERCENT: u64 = 80;
/// A volume at this share raises the critical alert.
pub const CRITICAL_PERCENT: u64 = 90;
/// A database whose unit failed a write with less than this left for users has run out: one WAL
/// segment is the least that crash recovery and the next checkpoint need.
pub const WAL_SEGMENT_BYTES: u64 = 16 << 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Alert {
    Warning,
    Critical,
}

/// `statvfs` of a mounted volume, as the agent reads it every 60 s.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FsUsage {
    pub total_bytes: u64,
    /// Total minus free, as `df` counts it.
    pub used_bytes: u64,
    /// Free space a user other than root can still take.
    pub available_bytes: u64,
    pub inodes_total: u64,
    pub inodes_used: u64,
}

/// What to do with the 1 % root-only reserve of ext4 (`tune2fs -m`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReserveAction {
    Keep,
    /// The database stopped on a failed write and the tenant has no space left: let PostgreSQL's
    /// crash recovery and the tenant's deletes run.
    Release,
    /// Use dropped, or the volume grew: back to 1 %.
    Restore,
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
    /// `released` is whether the reserve was freed earlier (the volume carries a tag for it, as
    /// the filesystem cannot tell its root-only reserve from the share ext4 keeps for itself).
    /// `write_failed` is whether the database's unit ended on its own after a failed write. The
    /// reserve is freed once both that and the lack of space hold (plan 4.3): a tenant who is
    /// still running would spend it, and crash recovery after it would have none.
    pub fn reserve_action(&self, released: bool, write_failed: bool) -> ReserveAction {
        if write_failed && self.available_bytes < WAL_SEGMENT_BYTES {
            ReserveAction::Release
        } else if released && self.space_percent() < WARNING_PERCENT {
            ReserveAction::Restore
        } else {
            ReserveAction::Keep
        }
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
    pub reserve_released: bool,
    /// The pool took no writes while the volume was mounted: it may have lost some (the volume
    /// carries a tag for it). Only `recover_volume` mounts it again.
    pub suspect: bool,
    pub mount: Option<MountInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MountInfo {
    pub usage: FsUsage,
    /// ext4 recorded an error on this mount: a journal abort after a write failed, for example.
    pub fs_errors: bool,
}

impl VolumeInfo {
    pub fn mounted(&self) -> bool {
        self.mount.is_some()
    }
    /// The volume needs the stop, unmount, repair and mount of `recover_volume` before its
    /// database starts again.
    pub fn needs_repair(&self) -> bool {
        self.suspect || self.mount.is_some_and(|mount| mount.fs_errors)
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
    /// (1 block left for users), and after `tune2fs -m 0` (1,311 blocks).
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
    fn the_reserve_is_freed_once_the_database_failed_a_write_and_the_tenant_has_no_space() {
        assert_eq!(full().reserve_action(false, true), ReserveAction::Release);
        // Releasing again is harmless; it covers a stop between the tag and the tune2fs.
        assert_eq!(full().reserve_action(true, true), ReserveAction::Release);
        // A database that still runs would spend the reserve, and crash recovery would find none.
        assert_eq!(full().reserve_action(false, false), ReserveAction::Keep);
        // 500 MiB of a 100 GiB volume are still available: the share reads 100 %, the tenant
        // can still write, and a stop for another reason does not free the reserve.
        let nearly = FsUsage {
            total_bytes: 100 << 30,
            used_bytes: (99 << 30) - (500 << 20),
            available_bytes: 500 << 20,
            inodes_total: 1000,
            inodes_used: 10,
        };
        assert_eq!(nearly.space_percent(), 100);
        assert_eq!(nearly.reserve_action(false, true), ReserveAction::Keep);
        // Less than a WAL segment is left: the tenant has run out.
        let spent = FsUsage {
            available_bytes: WAL_SEGMENT_BYTES - 1,
            ..nearly
        };
        assert_eq!(spent.reserve_action(false, true), ReserveAction::Release);
        // Freed, and still almost full: keep it freed.
        let released = FsUsage::from_blocks(1024, 120_787, 3_932, 1_311, 2_048, 2_035);
        assert_eq!(released.reserve_action(true, false), ReserveAction::Keep);
        // Use dropped below the warning level (a delete, or a resize): back to 1 %.
        assert_eq!(
            usage(790, 210, 0).reserve_action(true, false),
            ReserveAction::Restore
        );
        assert_eq!(
            usage(800, 200, 0).reserve_action(true, false),
            ReserveAction::Keep
        );
        // Never freed: nothing to give back.
        assert_eq!(
            usage(100, 900, 0).reserve_action(false, false),
            ReserveAction::Keep
        );
        // Out of inodes is not helped by the reserve.
        let no_inodes = FsUsage {
            available_bytes: 1 << 30,
            inodes_used: 1000,
            ..nearly
        };
        assert_eq!(no_inodes.reserve_action(false, true), ReserveAction::Keep);
    }

    #[test]
    fn a_volume_needs_repair_when_the_pool_failed_under_it_or_ext4_recorded_an_error() {
        let id = VolumeId::new("a1b2c3d4e5f6g7h8i9j0", 1).unwrap();
        let volume = |suspect: bool, mount: Option<MountInfo>| VolumeInfo {
            id: id.clone(),
            size_bytes: 128 << 20,
            pool_used_bytes: 0,
            formatted: true,
            reserve_released: false,
            suspect,
            mount,
        };
        let mounted = |fs_errors: bool| {
            Some(MountInfo {
                usage: full(),
                fs_errors,
            })
        };
        assert!(!volume(false, mounted(false)).needs_repair());
        assert!(!volume(false, None).needs_repair());
        // A volume the pool failed under has no recorded error, and may be unmounted since.
        assert!(volume(true, mounted(false)).needs_repair());
        assert!(volume(true, None).needs_repair());
        assert!(volume(false, mounted(true)).needs_repair());
    }

    #[test]
    fn a_volume_reports_what_the_contracts_volume_report_carries() {
        let id = VolumeId::new("a1b2c3d4e5f6g7h8i9j0", 1).unwrap();
        let mounted = VolumeInfo {
            id: id.clone(),
            size_bytes: 128 << 20,
            pool_used_bytes: 9_699_328,
            formatted: true,
            reserve_released: false,
            suspect: false,
            mount: Some(MountInfo {
                usage: full(),
                fs_errors: false,
            }),
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
        assert!(crate::node_link::schema_valid(
            "NodeVolumeReport",
            &one(&mounted)
        ));
        assert!(crate::node_link::schema_valid(
            "NodeVolumeReport",
            &one(&asleep_unmounted)
        ));
        assert_eq!(report["volumes"][0]["mounted"], true);
        assert_eq!(report["volumes"][0]["filesystem"]["inodes_used"], 13);
        assert_eq!(report["volumes"][1]["filesystem"], Value::Null);
        assert_eq!(report["volumes"][1]["storage_generation"], 1);
    }
}
