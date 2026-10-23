// SPDX-License-Identifier: Apache-2.0
//! What a database may fill of its volume (plan 4.3, "A full single volume").
//!
//! PostgreSQL cannot write when its filesystem is full, and a write it must make, the WAL record
//! of a `DELETE` or `DROP`, the checkpoint, the crash recovery, panics the server when it fails
//! (lab, EU1 2026-10-23: a tenant who filled a 2 GiB volume could not clean up, and the database
//! stayed in recovery until a resize). So the tenant's data is limited to less than the
//! filesystem: an ext4 project quota on the directories where the tenant's data grows (`base`
//! and `global` of the data directory, which hold the relations, their forks and the temporary
//! files), with a block limit and an inode limit below the filesystem's. Everything else stays
//! outside it, so that the room that is left is for what a checkpoint and a crash recovery write:
//! `pg_wal` first, and the small directories of the commit logs and the statistics.
//!
//! The tenant that reaches the limit gets "Disk quota exceeded" on the write that would pass it,
//! as an error of the statement, and the database goes on serving (lab: `DELETE`, `DROP` and the
//! crash recovery with the limit reached). The limit follows the volume: the agent sets it at
//! every attach and after every growth, from what the filesystem has then.
//!
//! The kernel's view of the limited directories is the tenant's: `statvfs` of `data/base` reports
//! the limit as the size and the project's use as the use (`ext4_statfs_project`), which is what
//! the volume report and the 80 % and 90 % alerts measure.
use crate::settings::max_wal_bytes;

/// The project that the files of the tenant's data belong to. Every other file of the volume is
/// project 0 and has no limit.
pub const PROJECT_ID: u32 = 1;

/// The directories of the data directory that belong to the project, with everything below them.
pub const DIRECTORIES: [&str; 2] = ["base", "global"];

/// The block limit of the kernel's quota calls is counted in these units.
pub const BLOCK_UNIT: u64 = 1024;

/// A WAL segment's size, which the inode room counts in (`initdb` default).
const WAL_SEGMENT_BYTES: u64 = 16 << 20;
/// What the data directory needs outside `base` and `global` besides the WAL: the commit logs,
/// the statistics and the files of a checkpoint (lab: below 25 MiB).
const SLACK_BYTES: u64 = 64 << 20;
/// The inodes that the files outside the project use besides the WAL segments: the commit logs,
/// the statistics, the replication directories and the top-level files of the data directory.
const OTHER_INODES: u64 = 1024;

/// The limits of the project, in the units of `Q_SETQUOTA`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    /// The hard limit of the space, in `BLOCK_UNIT`s.
    pub blocks: u64,
    /// The hard limit of the inodes.
    pub inodes: u64,
}

/// The limits for a filesystem of `usable_bytes` and `inodes` (`statvfs` of the mount), on a
/// volume of `volume_bytes`: what is left after the room that the WAL has up to `max_wal_size`
/// and a quarter more, and the files of the rest of the data directory. `max_wal_size` is a soft
/// limit: the lab saw `pg_wal` 16 to 112 MiB over it at the peak of a `DELETE` of every row at
/// the limit, and a write of the WAL that finds no room panics the server, so the room is
/// generous. Never more than half of the filesystem is taken out, so that a volume smaller than
/// its own WAL (a lab's) still has a share for the tenant.
pub fn limits(usable_bytes: u64, inodes: u64, volume_bytes: u64) -> Limits {
    let wal = max_wal_bytes(volume_bytes);
    let outside = (wal + wal / 4 + SLACK_BYTES).min(usable_bytes / 2);
    let outside_inodes =
        (wal / WAL_SEGMENT_BYTES + wal / WAL_SEGMENT_BYTES / 8 + OTHER_INODES).min(inodes / 2);
    Limits {
        blocks: (usable_bytes - outside) / BLOCK_UNIT,
        inodes: inodes - outside_inodes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;
    const GIB: u64 = 1 << 30;

    /// A 2 GiB volume (xs) holds a filesystem of 2,044 MiB less its own metadata: `statvfs` of the
    /// lab's volume said 519,128 blocks of 4 KiB and 32,768 inodes. `max_wal_size` is 512 MiB, so
    /// 640 MiB are for the WAL and 64 MiB beside it, and the tenant has the rest.
    #[test]
    fn the_wal_and_the_rest_of_the_data_directory_keep_their_room_outside_the_tenants_limit() {
        let usable = 519_128 * 4096;
        let limits = limits(usable, 32_768, 2 * GIB);
        assert_eq!(limits.blocks * BLOCK_UNIT, usable - 704 * MIB);
        // 32 segments of the WAL and an eighth more, and 1,024 for everything else.
        assert_eq!(limits.inodes, 32_768 - (32 + 4 + 1024));
        // What is left outside holds `max_wal_size` with room to spare.
        assert!(usable - limits.blocks * BLOCK_UNIT > 512 * MIB * 5 / 4);
    }

    #[test]
    fn the_tenants_share_grows_with_the_filesystem_and_never_passes_it() {
        let share = |gib: u64| {
            let usable = gib * GIB - gib * GIB / 100;
            limits(usable, usable / 65536, gib * GIB).blocks * BLOCK_UNIT
        };
        let mut last = 0;
        for gib in [1, 2, 5, 25, 100, 1024, 65536] {
            let now = share(gib);
            assert!(now > last && now < gib * GIB, "{gib} GiB: {now}");
            last = now;
        }
        // 62 to 67 percent of a volume at every size: `max_wal_size` is a quarter of it.
        assert!(share(1) * 100 / GIB > 55 && share(65536) * 100 / (65536 * GIB) > 66);
    }

    /// The lab's volumes of 64 and 256 MiB are smaller than the WAL they would have: the tenant
    /// still gets half of the filesystem.
    #[test]
    fn a_volume_smaller_than_its_wal_gives_the_tenant_half() {
        let limits = limits(60 * MIB, 1024, 64 * MIB);
        assert_eq!(limits.blocks * BLOCK_UNIT, 30 * MIB);
        assert_eq!(limits.inodes, 512);
    }

    #[test]
    fn the_limited_directories_are_the_ones_the_tenants_data_grows_in() {
        assert_eq!(DIRECTORIES, ["base", "global"]);
        assert_ne!(PROJECT_ID, 0);
    }
}
