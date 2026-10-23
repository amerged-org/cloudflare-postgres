// SPDX-License-Identifier: Apache-2.0
//! The command lines of storage, one function each so that the exact words are pinned by tests.
//! Sizes are absolute bytes and reports are JSON (plan Appendix C).
use super::{CHUNK_BYTES, Config, VolumeId, command::words, ids::dm_name};

const REPORT: [&str; 6] = [
    "--reportformat",
    "json",
    "--units",
    "b",
    "--nosuffix",
    "--options",
];
pub const VG_FIELDS: &str = "vg_name,vg_uuid,vg_size,vg_free,vg_extent_size,vg_permissions,vg_missing_pv_count,pv_count,vg_mda_size";
pub const PV_FIELDS: &str = "pv_name,vg_name,pv_size,pv_mda_size";
pub const LV_FIELDS: &str =
    "lv_name,lv_size,lv_attr,pool_lv,chunk_size,lv_metadata_size,lv_when_full,zero,lv_tags";

/// The tag that marks a volume whose ext4 was made: a create that stopped before it may format
/// again, one that passed it never does.
pub const FS_TAG: &str = "pgcf.fs";
/// The tag of a volume that was mounted while the pool took no writes (plan 4.3, full pool): it
/// stays until the volume is repaired, so a restart of the agent or of the node keeps it.
pub const SUSPECT_TAG: &str = "pgcf.suspect";

/// Whether the command may change what `lvs` reports: every lvm2 command does but its reports.
pub fn changes_volumes(command: &[String]) -> bool {
    let program = command.first().map_or("", String::as_str);
    ["lv", "vg", "pv"]
        .iter()
        .any(|family| program.starts_with(family))
        && !["lvs", "vgs", "pvs"].contains(&program)
}

fn report(program: &str, fields: &str, target: Option<&str>) -> Vec<String> {
    let mut words = vec![program.to_string()];
    words.extend(REPORT.iter().map(|word| word.to_string()));
    words.push(fields.to_string());
    words.extend(target.map(String::from));
    words
}
fn pool_path(config: &Config) -> String {
    format!("{}/{}", config.group, config.pool)
}
fn volume_path(config: &Config, id: &VolumeId) -> String {
    format!("{}/{}", config.group, id.lv_name())
}

pub fn vgs() -> Vec<String> {
    report("vgs", VG_FIELDS, None)
}
pub fn pvs() -> Vec<String> {
    report("pvs", PV_FIELDS, None)
}
pub fn lvs(config: &Config) -> Vec<String> {
    report("lvs", LV_FIELDS, Some(&config.group))
}
pub fn pvcreate(config: &Config) -> Vec<String> {
    words([
        "pvcreate",
        "--quiet",
        "--metadatasize",
        &format!("{}b", config.pv_metadata_bytes),
        &config.device.to_string_lossy(),
    ])
}
pub fn vgcreate(config: &Config) -> Vec<String> {
    words([
        "vgcreate",
        "--quiet",
        &config.group,
        &config.device.to_string_lossy(),
    ])
}
pub fn activate(config: &Config) -> Vec<String> {
    words(["vgchange", "--quiet", "--activate", "y", &config.group])
}
/// The check `vgchange` runs on a thin pool's metadata before it activates the pool, as Debian 13
/// has it (`thin_check_options = ["-q"]`), with `--auto-repair` added. thin-provisioning-tools
/// 1.1.0 documents the option as "automatically repair any trivial issues found with the
/// metadata. Currently only fixes metadata leaks": once the trees have been read without an
/// error, it rewrites the space map of a leak (a block the map counts as used that no tree
/// refers to). It writes nothing when a tree or a checksum is wrong, because the leak check comes
/// after the walk of the trees (lab: a metadata image with a leaked block and a wrong checksum in
/// the mapping tree is left byte for byte as it was). Its exit status cannot tell the two apart:
/// the Rust `thin_check` ends with 64 for every error, the man page's 1 notwithstanding.
pub const REPAIRING_CHECK: &str = r#"global{thin_check_options=["-q","--auto-repair"]}"#;
/// `activate` for a pool whose plain check was refused (found live on EU1, 2026-10-23: one leaked
/// block after a hard reset made `vgchange` end with 5 and the agent crash-loop for 27 minutes).
pub fn activate_repairing(config: &Config) -> Vec<String> {
    words([
        "vgchange",
        "--quiet",
        "--config",
        REPAIRING_CHECK,
        "--activate",
        "y",
        &config.group,
    ])
}
/// Every volume of the group with its attributes, hidden ones included: the parts of the pool
/// (`pgcf_thinpool_tdata`, `pgcf_thinpool_tmeta`) are listed only by `--all`.
pub fn volume_attributes(config: &Config) -> Vec<String> {
    let mut command = words(["lvs", "--all"]);
    command.extend(REPORT.iter().map(|word| word.to_string()));
    command.push("lv_name,lv_attr".to_string());
    command.push(config.group.clone());
    command
}
/// A part of the pool, which lvm2 activates only with the pool: `lvchange --activate n` ends the
/// activation of a part that an inspection of the metadata (`lvchange --activate y --yes` on the
/// part) left active, which keeps `vgchange` from activating the pool.
pub fn deactivate_pool_part(config: &Config, part: &str) -> Vec<String> {
    words([
        "lvchange",
        "--quiet",
        "--activate",
        "n",
        &format!("{}/{part}", config.group),
    ])
}
pub fn pool_create(config: &Config, data_bytes: u64) -> Vec<String> {
    words([
        "lvcreate",
        "--quiet",
        "--thinpool",
        &config.pool,
        "--size",
        &format!("{data_bytes}b"),
        "--poolmetadatasize",
        &format!("{}b", config.pool_metadata_bytes),
        "--chunksize",
        &format!("{}k", CHUNK_BYTES / 1024),
        "--zero",
        "y",
        &config.group,
    ])
}
pub fn error_when_full(config: &Config) -> Vec<String> {
    words([
        "lvchange",
        "--quiet",
        "--errorwhenfull",
        "y",
        &pool_path(config),
    ])
}
pub fn volume_create(config: &Config, id: &VolumeId, size_bytes: u64) -> Vec<String> {
    let [database_tag, generation_tag] = id.tags();
    words([
        "lvcreate",
        "--quiet",
        "--thin",
        "--virtualsize",
        &format!("{size_bytes}b"),
        "--name",
        &id.lv_name(),
        "--addtag",
        &database_tag,
        "--addtag",
        &generation_tag,
        &pool_path(config),
    ])
}
/// One `lvchange` for all of `ids`, as the pool-full marking tags every mounted volume at once.
pub fn volumes_add_tag(config: &Config, ids: &[VolumeId], tag: &str) -> Vec<String> {
    let mut command = words(["lvchange", "--quiet", "--addtag", tag]);
    command.extend(ids.iter().map(|id| volume_path(config, id)));
    command
}
pub fn volume_delete_tag(config: &Config, id: &VolumeId, tag: &str) -> Vec<String> {
    words([
        "lvchange",
        "--quiet",
        "--deltag",
        tag,
        &volume_path(config, id),
    ])
}
pub fn volume_extend(config: &Config, id: &VolumeId, size_bytes: u64) -> Vec<String> {
    words([
        "lvextend",
        "--quiet",
        "--size",
        &format!("{size_bytes}b"),
        &volume_path(config, id),
    ])
}
/// No `--force`: lvm2 itself refuses a volume that is in use.
pub fn volume_remove(config: &Config, id: &VolumeId) -> Vec<String> {
    words(["lvremove", "--quiet", "--yes", &volume_path(config, id)])
}
/// `--noflush`: without it the kernel commits the pool's metadata before it answers each status
/// call, so the 5 s poll would force a commit every time. The block counts the agent reads come
/// from the in-core space maps either way.
pub fn dm_status_pool() -> Vec<String> {
    words(["dmsetup", "status", "--noflush", "--target", "thin-pool"])
}
pub fn dm_table_pool() -> Vec<String> {
    words(["dmsetup", "table", "--target", "thin-pool"])
}
pub fn dm_status_thin() -> Vec<String> {
    words(["dmsetup", "status", "--target", "thin"])
}
/// The device-mapper node of a volume, which libdevmapper makes with or without udev.
pub fn device(config: &Config, id: &VolumeId) -> String {
    format!("/dev/mapper/{}", dm_name(&config.group, &id.lv_name()))
}
/// What a filesystem leaves unused at the end of its volume: one extent of the volume group. The
/// unit and the jobs mount a volume through systemd's image dissection, which runs libblkid's
/// probers as root over the whole device, and a filesystem that ends with the device lets a
/// database's own data form a RAID or ZFS signature where they look, which makes the dissection
/// refuse the mount (the database could no longer start or archive). The farthest probe from the
/// end is `promise_raid`'s, 3087 sectors or 1.5 MiB (`commands::tests::PROBED_FROM_THE_END`).
/// Nothing writes to the gap, so it stays zero.
pub const FS_END_GAP_BYTES: u64 = 4 << 20;
/// The size, in whole KiB, that `mkfs.ext4` and `resize2fs` give the filesystem of a volume of
/// `volume_bytes`.
pub fn fs_target_kib(volume_bytes: u64) -> u64 {
    volume_bytes.saturating_sub(FS_END_GAP_BYTES) / 1024
}
/// The same, as the argument of those tools: KiB with the suffix both read as such.
fn fs_size(volume_bytes: u64) -> String {
    format!("{}K", fs_target_kib(volume_bytes))
}
/// The filesystem is made with an explicit size that ends `FS_END_GAP_BYTES` before the end of
/// the volume, never the whole device.
///
/// - `-J size=8`: an 8 MiB journal (the pool pays for every block `mkfs` writes).
/// - `-O ^resize_inode,meta_bg`: no reserved group descriptor blocks. `mke2fs` reserves them for
///   1,024 times the size: 255 for 2 GiB, 639 for 5 GiB and 1,024 from 8 GiB. An online grow
///   that adds a flex group asks the journal for 6 credits and one for each reserved block, and
///   the 8 MiB journal allows 678 on kernel 6.12 (508 on 6.8): a filesystem from 5.4 GiB failed
///   with -28 and stayed as it was (US1 2026-10-23: 25 GiB to 50 GiB asked for 1,030). With
///   `meta_bg` the descriptors of a group are beside the group, nothing is reserved, and a grow
///   asks for 6 credits at any size, up to the 64 TiB that the API accepts (lab, `plan` 11.1).
/// - `-m 0`: no root-only reserve. PostgreSQL does not run as root, so it never had the use of it,
///   recovery after a full volume is by growing it.
pub fn mkfs(config: &Config, id: &VolumeId, volume_bytes: u64) -> Vec<String> {
    words([
        "mkfs.ext4",
        "-F",
        "-q",
        "-J",
        "size=8",
        "-i",
        "65536",
        "-m",
        "0",
        "-O",
        "^resize_inode,meta_bg",
        "-E",
        "lazy_itable_init=0,lazy_journal_init=0",
        &device(config, id),
        &fs_size(volume_bytes),
    ])
}
/// Grows the filesystem to the size `mkfs` gives a volume of `volume_bytes`.
pub fn resize_fs(config: &Config, id: &VolumeId, volume_bytes: u64) -> Vec<String> {
    words(["resize2fs", &device(config, id), &fs_size(volume_bytes)])
}
pub fn fsck(config: &Config, id: &VolumeId) -> Vec<String> {
    words(["e2fsck", "-p", &device(config, id)])
}
/// An offline grow must check the filesystem even when its clean flag is set.
pub fn check_before_grow(config: &Config, id: &VolumeId) -> Vec<String> {
    words(["e2fsck", "-p", "-f", &device(config, id)])
}
/// Sets the filesystem's `needs_recovery` flag so that `e2fsck -p` replays the journal. After a
/// full pool the journal can hold committed transactions while the flag is clear, because the
/// write that would have set it was lost; `-p` then ends with 4 and "run journal anyway" is a
/// question only an operator may answer. The flag answers exactly that question, and a damaged
/// journal still stops `-p`.
pub fn replay_journal(config: &Config, id: &VolumeId) -> Vec<String> {
    words([
        "debugfs",
        "-w",
        "-R",
        "feature needs_recovery",
        &device(config, id),
    ])
}
pub fn trim(config: &Config, id: &VolumeId) -> Vec<String> {
    words([
        "fstrim",
        &config.mount_root.join(id.database()).to_string_lossy(),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> VolumeId {
        VolumeId::new("a1b2c3d4e5f6g7h8i9j0", 3).unwrap()
    }
    fn line(command: Vec<String>) -> String {
        command.join(" ")
    }

    #[test]
    fn reports_are_json_in_absolute_bytes() {
        let report = "--reportformat json --units b --nosuffix --options";
        assert_eq!(line(vgs()), format!("vgs {report} {VG_FIELDS}"));
        assert_eq!(line(pvs()), format!("pvs {report} {PV_FIELDS}"));
        assert_eq!(
            line(lvs(&Config::default())),
            format!("lvs {report} {LV_FIELDS} pgcf")
        );
        assert!(VG_FIELDS.contains("vg_mda_size") && PV_FIELDS.contains("pv_mda_size"));
    }

    #[test]
    fn the_pool_is_made_with_the_corrected_sequence() {
        let config = Config::default();
        assert_eq!(
            line(pvcreate(&config)),
            "pvcreate --quiet --metadatasize 67108864b /dev/disk/by-partlabel/pgcf-lvm"
        );
        assert_eq!(
            line(vgcreate(&config)),
            "vgcreate --quiet pgcf /dev/disk/by-partlabel/pgcf-lvm"
        );
        // lvm2 2.03.31 sets errors on a full pool only through lvchange after the lvcreate.
        assert_eq!(
            line(pool_create(&config, 125 << 30)),
            "lvcreate --quiet --thinpool pgcf_thinpool --size 134217728000b \
             --poolmetadatasize 1073741824b --chunksize 64k --zero y pgcf"
        );
        assert_eq!(CHUNK_BYTES, 64 * 1024);
        assert_eq!(
            line(error_when_full(&config)),
            "lvchange --quiet --errorwhenfull y pgcf/pgcf_thinpool"
        );
        assert_eq!(
            line(activate(&config)),
            "vgchange --quiet --activate y pgcf"
        );
    }

    /// The second activation changes the pool check and nothing else: the host's own options
    /// (`-q`) stay, `--auto-repair` is the only addition, and it is one word of the command line
    /// (no shell reads the brackets).
    #[test]
    fn the_repairing_activation_adds_auto_repair_to_the_hosts_check_and_nothing_else() {
        let config = Config::default();
        let command = activate_repairing(&config);
        assert_eq!(
            command,
            [
                "vgchange",
                "--quiet",
                "--config",
                r#"global{thin_check_options=["-q","--auto-repair"]}"#,
                "--activate",
                "y",
                "pgcf"
            ]
        );
        assert!(!command.iter().any(|word| word.contains("ignore-non-fatal")));
        assert!(changes_volumes(&command));
    }

    #[test]
    fn the_parts_of_the_pool_are_listed_with_all_and_deactivated_by_name() {
        let config = Config::default();
        assert_eq!(
            line(volume_attributes(&config)),
            "lvs --all --reportformat json --units b --nosuffix --options lv_name,lv_attr pgcf"
        );
        assert!(!changes_volumes(&volume_attributes(&config)));
        assert_eq!(
            line(deactivate_pool_part(&config, "pgcf_thinpool_tmeta")),
            "lvchange --quiet --activate n pgcf/pgcf_thinpool_tmeta"
        );
        assert!(changes_volumes(&deactivate_pool_part(
            &config,
            "pgcf_thinpool_tmeta"
        )));
    }

    #[test]
    fn a_volume_is_a_tagged_thin_lv_of_its_nominal_size() {
        let config = Config::default();
        assert_eq!(
            line(volume_create(&config, &id(), 1 << 30)),
            "lvcreate --quiet --thin --virtualsize 1073741824b --name db_a1b2c3d4e5f6g7h8i9j0_g3 \
             --addtag pgcf.db.a1b2c3d4e5f6g7h8i9j0 --addtag pgcf.gen.3 pgcf/pgcf_thinpool"
        );
        assert_eq!(
            line(volumes_add_tag(&config, &[id()], FS_TAG)),
            "lvchange --quiet --addtag pgcf.fs pgcf/db_a1b2c3d4e5f6g7h8i9j0_g3"
        );
        let other = VolumeId::new("k1l2m3n4o5p6q7r8s9t0", 1).unwrap();
        assert_eq!(
            line(volumes_add_tag(&config, &[id(), other], SUSPECT_TAG)),
            "lvchange --quiet --addtag pgcf.suspect pgcf/db_a1b2c3d4e5f6g7h8i9j0_g3 \
             pgcf/db_k1l2m3n4o5p6q7r8s9t0_g1"
        );
        assert_eq!(
            line(volume_delete_tag(&config, &id(), SUSPECT_TAG)),
            "lvchange --quiet --deltag pgcf.suspect pgcf/db_a1b2c3d4e5f6g7h8i9j0_g3"
        );
        assert_eq!(
            line(volume_extend(&config, &id(), 2 << 30)),
            "lvextend --quiet --size 2147483648b pgcf/db_a1b2c3d4e5f6g7h8i9j0_g3"
        );
        // Without --force: LVM itself refuses a volume that is in use.
        assert_eq!(
            line(volume_remove(&config, &id())),
            "lvremove --quiet --yes pgcf/db_a1b2c3d4e5f6g7h8i9j0_g3"
        );
    }

    #[test]
    fn the_filesystem_commands_name_the_device_mapper_node() {
        let config = Config::default();
        let device = "/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g3";
        assert_eq!(super::device(&config, &id()), device);
        // 1 GiB volume: the filesystem ends 4 MiB before it.
        assert_eq!(
            line(mkfs(&config, &id(), 1 << 30)),
            format!(
                "mkfs.ext4 -F -q -J size=8 -i 65536 -m 0 -O ^resize_inode,meta_bg \
                 -E lazy_itable_init=0,lazy_journal_init=0 {device} 1044480K"
            )
        );
        assert_eq!(
            line(resize_fs(&config, &id(), 2 << 30)),
            format!("resize2fs {device} 2093056K")
        );
        assert_eq!(line(fsck(&config, &id())), format!("e2fsck -p {device}"));
        assert_eq!(
            line(replay_journal(&config, &id())),
            format!("debugfs -w -R feature needs_recovery {device}")
        );
        assert_eq!(
            line(trim(&config, &id())),
            "fstrim /var/lib/pgcf/db/a1b2c3d4e5f6g7h8i9j0"
        );
    }

    /// The target is what the commands are given, for a volume of any size.
    #[test]
    fn the_filesystem_ends_one_gap_before_its_volume() {
        assert_eq!(fs_target_kib(1 << 30), 1_044_480);
        assert_eq!(fs_size(1 << 30), "1044480K");
        assert_eq!(FS_END_GAP_BYTES, 4 << 20);
    }

    /// What libblkid 2.41, which systemd 257's image dissection runs over the device as root, reads
    /// counted back from the end of a device: `promise_raid` probes sectors 63, 255, 256, 16, 399,
    /// 591, 675, 735, 911, 974, 991, 951 and 3087, the last of them 1,580,544 bytes from the end
    /// (the lab wrote the signature there: `blkid -p` then reports a RAID member of an ext4
    /// device, and the dissection refuses the mount). The others are nearer: UDF's anchor is 256
    /// blocks of 4 KiB from the end, ZFS's last label within 768 KiB, a RAID superblock within
    /// 128 KiB.
    const PROBED_FROM_THE_END: u64 = 3087 * 512;

    /// A database's data can be anything, so the bytes libblkid reads at the end of the device are
    /// never the filesystem's, for every size of volume.
    #[test]
    fn a_filesystem_ends_before_everything_libblkid_reads_at_the_end_of_its_volume() {
        let (config, id) = (Config::default(), id());
        for extents in [2u64, 3, 8, 256, 25_600] {
            let volume = extents * (4 << 20);
            let size = |command: Vec<String>| -> u64 {
                let last = command.last().unwrap();
                last.strip_suffix('K').unwrap().parse::<u64>().unwrap() * 1024
            };
            for command in [mkfs(&config, &id, volume), resize_fs(&config, &id, volume)] {
                let fs_bytes = size(command);
                assert!(
                    volume - fs_bytes > PROBED_FROM_THE_END,
                    "{volume}: {fs_bytes}"
                );
                assert!(
                    volume - fs_bytes >= FS_END_GAP_BYTES,
                    "{volume}: {fs_bytes}"
                );
                // Whole kibibytes, and whole 4 KiB blocks, so the tools round nothing.
                assert_eq!(fs_bytes % 4096, 0);
            }
        }
    }

    /// The list of volumes is dropped after exactly these: every command of the storage is here.
    #[test]
    fn only_lvm2_commands_but_its_reports_may_change_a_volume() {
        let (config, id) = (Config::default(), id());
        let ids = std::slice::from_ref(&id);
        for command in [
            pvcreate(&config),
            vgcreate(&config),
            activate(&config),
            pool_create(&config, 125 << 30),
            error_when_full(&config),
            volume_create(&config, &id, 1 << 30),
            volumes_add_tag(&config, ids, SUSPECT_TAG),
            volume_delete_tag(&config, &id, SUSPECT_TAG),
            volume_extend(&config, &id, 2 << 30),
            volume_remove(&config, &id),
        ] {
            assert!(changes_volumes(&command), "{command:?}");
        }
        for command in [
            vgs(),
            pvs(),
            lvs(&config),
            dm_status_pool(),
            dm_table_pool(),
            dm_status_thin(),
            mkfs(&config, &id, 1 << 30),
            resize_fs(&config, &id, 2 << 30),
            fsck(&config, &id),
            replay_journal(&config, &id),
            trim(&config, &id),
            vec![],
        ] {
            assert!(!changes_volumes(&command), "{command:?}");
        }
    }

    #[test]
    fn the_pool_and_thin_status_are_read_with_dmsetup() {
        assert_eq!(
            line(dm_status_pool()),
            "dmsetup status --noflush --target thin-pool"
        );
        assert_eq!(line(dm_table_pool()), "dmsetup table --target thin-pool");
        assert_eq!(line(dm_status_thin()), "dmsetup status --target thin");
        assert_eq!(dm_name("pgcf", "pgcf_thinpool"), "pgcf-pgcf_thinpool");
    }
}
