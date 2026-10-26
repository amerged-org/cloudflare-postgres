// SPDX-License-Identifier: Apache-2.0
//! `Storage` against real LVM, ext4 and the kernel's mount API on loop devices. They change the
//! machine, so they run only in a privileged Linux container with lvm2, thin-provisioning-tools,
//! e2fsprogs and util-linux, one at a time, and exist only in a build made for them. The kernel
//! step of CI runs every ignored test in an unprivileged container and must not meet them:
//! `RUSTFLAGS='--cfg pgcf_storage_lab' cargo test -p pgcf-node-agent --lib -- --test-threads=1 storage::lab_tests`
use super::{
    commands::{self, FS_TAG},
    lvm::{self, LogicalVolume},
    mountinfo, *,
};
use std::{
    fs,
    os::unix::fs::{FileExt, MetadataExt, chown},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    slice,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicUsize, Ordering},
    },
    time::Duration,
};

static LABS: AtomicU32 = AtomicU32::new(0);
const TENANT: u32 = 1234;
const ID: &str = "a1b2c3d4e5f6g7h8i9j0";
const OTHER: &str = "k1l2m3n4o5p6q7r8s9t0";
const THIRD: &str = "u1v2w3x4y5z6a7b8c9d0";

fn sh(program: &str, args: &[&str]) -> String {
    let output = Command::new(program).args(args).output().expect("starts");
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}
fn policy() -> Policy {
    Policy {
        reserve_bytes: 4 << 20,
        metadata_no_room_percent: 75,
        sample_max_age: Duration::from_secs(10),
    }
}
fn id(database: &str, generation: u64) -> VolumeId {
    VolumeId::new(database, generation).unwrap()
}

/// Runs the commands on the system and counts the `lvs` among them.
struct Counting(Arc<AtomicUsize>);

impl CommandRunner for Counting {
    fn run(&self, command: &[String]) -> std::io::Result<Output> {
        if command[0] == "lvs" {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
        SystemRunner.run(command)
    }
}

/// A loop device of its own with its own volume group, removed again when the test ends.
struct Lab {
    dir: PathBuf,
    loop_device: String,
    storage: Storage,
}

impl Lab {
    fn new(disk_mib: u64) -> Lab {
        Lab::new_with(disk_mib, |_| {})
    }
    fn new_with(disk_mib: u64, adjust: impl FnOnce(&mut Config)) -> Lab {
        let name = format!(
            "pgcflab{}x{}",
            std::process::id(),
            LABS.fetch_add(1, Ordering::Relaxed)
        );
        let dir = std::env::temp_dir().join(&name);
        fs::create_dir_all(&dir).unwrap();
        let disk = dir.join("disk.img");
        fs::File::create(&disk)
            .unwrap()
            .set_len(disk_mib << 20)
            .unwrap();
        let loop_device = sh("losetup", &["-f", "--show", disk.to_str().unwrap()])
            .trim()
            .to_string();
        if !Path::new(&loop_device).exists() {
            let number = loop_device.trim_start_matches("/dev/loop");
            sh("mknod", &[&loop_device, "b", "7", number]);
        }
        let mut config = Config {
            device: loop_device.clone().into(),
            group: name,
            mount_root: dir.join("db"),
            device_links: dir.join("run/dev"),
            pool_metadata_bytes: 8 << 20,
            ..Config::default()
        };
        adjust(&mut config);
        Lab {
            dir,
            loop_device,
            storage: Storage::new(SystemRunner, config),
        }
    }
    /// A lab with the pool made.
    fn open(disk_mib: u64) -> Lab {
        Lab::open_with(disk_mib, |_| {})
    }
    fn open_with(disk_mib: u64, adjust: impl FnOnce(&mut Config)) -> Lab {
        let lab = Lab::new_with(disk_mib, adjust);
        lab.storage.open().unwrap();
        lab
    }
    fn config(&self) -> &Config {
        self.storage.config()
    }
    fn run(&self, command: Vec<String>) -> String {
        let output = SystemRunner.run(&command).unwrap();
        assert_eq!(output.code, 0, "{command:?}: {}", output.stderr);
        output.stdout
    }
    fn dir_of(&self, id: &VolumeId) -> PathBuf {
        self.config().mount_root.join(id.database())
    }
    fn lvs(&self) -> Vec<LogicalVolume> {
        lvm::parse_lvs(&self.run(commands::lvs(self.config()))).unwrap()
    }
    fn lv(&self, id: &VolumeId) -> Option<LogicalVolume> {
        self.lvs().into_iter().find(|lv| lv.name == id.lv_name())
    }
    fn group(&self) -> lvm::VolumeGroup {
        lvm::parse_vgs(&self.run(commands::vgs()))
            .unwrap()
            .into_iter()
            .find(|group| group.name == self.config().group)
            .unwrap()
    }
    fn mount_table(&self) -> String {
        fs::read_to_string("/proc/self/mountinfo").unwrap()
    }
    /// What the database's device link names, if there is one.
    fn link(&self, id: &VolumeId) -> Option<PathBuf> {
        fs::read_link(self.config().device_links.join(id.database())).ok()
    }
    /// The link names exactly this volume's device, and that device is the filesystem mounted at
    /// the database's directory: the unit that follows the link mounts what the agent has.
    fn linked_to_the_mounted_volume(&self, id: &VolumeId) -> bool {
        let device = PathBuf::from(commands::device(self.config(), id));
        self.link(id).as_deref() == Some(device.as_path()) && self.mounted(id)
    }
    /// The volume's own filesystem is mounted at its directory.
    fn mounted(&self, id: &VolumeId) -> bool {
        let device = commands::device(self.config(), id);
        mountinfo::parse(&self.mount_table())
            .unwrap()
            .iter()
            .any(|mount| mount.mount_point == self.dir_of(id) && mount.source == device)
    }
    /// What is mounted on top at the database's directory.
    fn top_source(&self, id: &VolumeId) -> String {
        mountinfo::parse(&self.mount_table())
            .unwrap()
            .into_iter()
            .rev()
            .find(|mount| mount.mount_point == self.dir_of(id))
            .unwrap()
            .source
    }
    fn create(&self, id: &VolumeId, size_mib: u64) {
        self.storage
            .create_volume(id, size_mib << 20, &policy())
            .unwrap();
        chown(self.dir_of(id), Some(TENANT), Some(TENANT)).unwrap();
    }
    fn volume(&self, id: &VolumeId) -> VolumeInfo {
        self.storage
            .inventory()
            .unwrap()
            .volumes
            .into_iter()
            .find(|volume| volume.id == *id)
            .unwrap()
    }
    /// What a database's PostgreSQL does: writes as its own user, never as root.
    fn tenant_dd(&self, id: &VolumeId, file: &str, kib: u64, source: &str) -> bool {
        Command::new("setpriv")
            .args([
                &format!("--reuid={TENANT}"),
                &format!("--regid={TENANT}"),
                "--clear-groups",
            ])
            .args(["dd", &format!("if={source}")])
            .arg(format!("of={}", self.dir_of(id).join(file).display()))
            .args(["bs=64k", &format!("count={}", kib / 64), "conv=fsync"])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    }
    /// A tenant that appends `source` to a file of its own until its filesystem has no room.
    fn tenant_fill_with(&self, id: &VolumeId, file: &str, source: &Path) {
        let target = self.dir_of(id).join(file);
        let script = format!(
            "while cat '{}' >> '{}' 2>/dev/null; do :; done",
            source.display(),
            target.display()
        );
        let status = Command::new("setpriv")
            .args([
                &format!("--reuid={TENANT}"),
                &format!("--regid={TENANT}"),
                "--clear-groups",
                "sh",
                "-c",
                &script,
            ])
            .status()
            .unwrap();
        assert!(status.success());
        sh("sync", &[]);
    }
    /// What a unit with `MountImages=` is to the agent: a process in a mount namespace of its own
    /// that has the volume's device mounted, which the agent's mount table does not list. It holds
    /// the volume until the returned value is dropped.
    fn unit_holding(&self, id: &VolumeId) -> Holder {
        let (ready, mount_point) = (
            self.dir.join(format!("unit-{}-ready", id.database())),
            self.dir.join(format!("unit-{}-mount", id.database())),
        );
        fs::create_dir_all(&mount_point).unwrap();
        let script = format!(
            "mount -t ext4 -o nosuid,nodev,noexec,noatime {} {} && touch {} && exec sleep 600",
            commands::device(self.config(), id),
            mount_point.display(),
            ready.display()
        );
        let unit = Holder(
            Command::new("unshare")
                .args(["--mount", "--propagation", "private", "sh", "-c", &script])
                .spawn()
                .unwrap(),
        );
        for _ in 0..200 {
            if ready.exists() {
                return unit;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the unit's namespace did not mount the volume");
    }
    fn pool_used(&self) -> u64 {
        sh("sync", &[]);
        self.storage.poll_pool().unwrap().data_used_bytes
    }

    // ---- the pool's metadata, on the loop device, while the group is inactive

    fn deactivate_group(&self) {
        sh(
            "vgchange",
            &["--quiet", "--activate", "n", &self.config().group],
        );
    }
    /// The byte offset on the loop device of the pool's metadata (`<pool>_tmeta`), from the first
    /// extent of the part and the physical volume's data start.
    fn metadata_offset(&self) -> u64 {
        let report = sh(
            "lvs",
            &[
                "--all",
                "--noheadings",
                "--separator",
                ",",
                "--units",
                "b",
                "--nosuffix",
                "-o",
                "lv_name,seg_pe_ranges",
                &self.config().group,
            ],
        );
        let part = format!("[{}_tmeta]", self.config().pool);
        let ranges = report
            .lines()
            .filter_map(|line| line.trim().split_once(','))
            .find(|(name, _)| *name == part)
            .map(|(_, ranges)| ranges.to_string())
            .expect("the metadata part");
        // "/dev/loop0:257-257"
        let first: u64 = ranges
            .rsplit_once(':')
            .and_then(|(_, extents)| extents.split('-').next())
            .and_then(|first| first.parse().ok())
            .expect("an extent range");
        let data_start: u64 = sh(
            "pvs",
            &[
                "--noheadings",
                "--units",
                "b",
                "--nosuffix",
                "-o",
                "pe_start",
                &self.loop_device,
            ],
        )
        .trim()
        .parse()
        .expect("the data start");
        data_start + first * self.group().extent_bytes
    }
    fn metadata_block(&self, block: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; METADATA_BLOCK];
        fs::File::open(&self.loop_device)
            .unwrap()
            .read_exact_at(
                &mut bytes,
                self.metadata_offset() + block * METADATA_BLOCK as u64,
            )
            .unwrap();
        bytes
    }
    fn write_metadata_block(&self, block: u64, bytes: &[u8]) {
        let device = fs::OpenOptions::new()
            .write(true)
            .open(&self.loop_device)
            .unwrap();
        device
            .write_all_at(
                bytes,
                self.metadata_offset() + block * METADATA_BLOCK as u64,
            )
            .unwrap();
        // lvm2 reads the device through device-mapper, not through this page cache.
        device.sync_all().unwrap();
    }
    /// The whole metadata device as it is now.
    fn metadata_image(&self) -> Vec<u8> {
        let mut bytes = vec![0u8; self.config().pool_metadata_bytes as usize];
        fs::File::open(&self.loop_device)
            .unwrap()
            .read_exact_at(&mut bytes, self.metadata_offset())
            .unwrap();
        bytes
    }
    /// What `thin_check` says of the metadata as it is on the device now: its exit status and what
    /// it printed.
    fn thin_check(&self) -> (i32, String) {
        let image = self.dir.join("metadata.img");
        fs::write(&image, self.metadata_image()).unwrap();
        let output = Command::new("thin_check").arg(&image).output().unwrap();
        let text = String::from_utf8_lossy(&output.stdout).into_owned()
            + &String::from_utf8_lossy(&output.stderr);
        (output.status.code().unwrap(), text)
    }
    /// What a hard reset left on EU1 (2026-10-23): the data space map counts the pool's last data
    /// block as used and no mapping uses it. The block is made used in the bitmap, the free count
    /// of its bitmap and the total of the root are made to agree, and the three checksums are
    /// written again, so that `thin_check` reads a well-formed map with a leak and no other
    /// error. The pool must be inactive and hold no mapping at its last block.
    fn leak_the_last_data_block(&self) {
        let root = self.metadata_block(0);
        let word =
            |bytes: &[u8], at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        // `disk_sm_root` at byte 64 of the superblock: blocks, allocated, bitmap root (the
        // index), reference count root.
        let (blocks, allocated, index_root) = (word(&root, 64), word(&root, 72), word(&root, 80));
        let block = blocks - 1;
        let mut index = self.metadata_block(index_root);
        assert_eq!(
            u32::from_le_bytes(index[4..8].try_into().unwrap()),
            2,
            "a leaf: the lab's pool has few bitmaps"
        );
        let max_entries = u32::from_le_bytes(index[20..24].try_into().unwrap()) as usize;
        let per_bitmap = (METADATA_BLOCK as u64 - 16) * 4;
        // The entry of the bitmap that holds the block: block, free blocks, none free before.
        let entry = 32 + 8 * max_entries + 16 * (block / per_bitmap) as usize;
        let (bitmap_block, free) = (
            word(&index, entry),
            u32::from_le_bytes(index[entry + 8..entry + 12].try_into().unwrap()),
        );
        let mut bitmap = self.metadata_block(bitmap_block);
        // Two bits a block, in little-endian words, the high bit of the count first.
        let (position, bit) = (
            16 + 8 * ((block % per_bitmap) / 32) as usize,
            (block % 32) * 2,
        );
        let mut cells = word(&bitmap, position);
        assert_eq!((cells >> bit) & 3, 0, "the last block is free");
        cells |= 1 << (bit + 1);
        bitmap[position..position + 8].copy_from_slice(&cells.to_le_bytes());
        index[entry + 8..entry + 12].copy_from_slice(&(free - 1).to_le_bytes());
        let mut root = root;
        root[72..80].copy_from_slice(&(allocated + 1).to_le_bytes());
        for (number, bytes, salt) in [
            (bitmap_block, &mut bitmap, BITMAP_CHECKSUM_SALT),
            (index_root, &mut index, BTREE_CHECKSUM_SALT),
            (0, &mut root, SUPERBLOCK_CHECKSUM_SALT),
        ] {
            let checksum = crc32c(&bytes[4..]) ^ salt;
            bytes[..4].copy_from_slice(&checksum.to_le_bytes());
            self.write_metadata_block(number, bytes);
        }
    }
    /// A wrong byte in the root of the mapping tree, whose checksum no longer holds: damage that
    /// no leak check can read past.
    fn damage_the_mapping_tree(&self) {
        let root = self.metadata_block(0);
        let mapping_root = u64::from_le_bytes(root[320..328].try_into().unwrap());
        let mut node = self.metadata_block(mapping_root);
        node[100] ^= 0xff;
        self.write_metadata_block(mapping_root, &node);
    }
}

const METADATA_BLOCK: usize = 4096;
// The salts the kernel's persistent-data library gives the checksum of each kind of block.
const SUPERBLOCK_CHECKSUM_SALT: u32 = 160_774;
const BTREE_CHECKSUM_SALT: u32 = 121_107;
const BITMAP_CHECKSUM_SALT: u32 = 240_779;
/// CRC-32C as the kernel's `crc32c(~0, ...)` has it: the register, without the final inversion.
fn crc32c(bytes: &[u8]) -> u32 {
    let mut register = u32::MAX;
    for byte in bytes {
        register ^= u32::from(*byte);
        for _ in 0..8 {
            register = (register >> 1) ^ (0x82F6_3B78 & 0u32.wrapping_sub(register & 1));
        }
    }
    register
}

impl Drop for Lab {
    fn drop(&mut self) {
        if let Ok(mounts) = mountinfo::parse(&self.mount_table()) {
            for mount in mounts
                .iter()
                .rev()
                .filter(|m| m.mount_point.starts_with(&self.dir))
            {
                let _ = Command::new("umount").arg(&mount.mount_point).output();
            }
        }
        let _ = Command::new("vgremove")
            .args(["-ff", "-y", "--quiet", &self.config().group])
            .output();
        let _ = Command::new("losetup")
            .args(["-d", &self.loop_device])
            .output();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Ends a child that holds a mount busy, also when the test fails.
struct Holder(Child);
impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn first_boot_makes_the_group_and_a_pool_over_the_whole_partition_and_repeats_as_a_no_op() {
    let lab = Lab::new(512);
    lab.storage.open().unwrap();
    let group = lab.group();
    // No slack: the pool, its metadata and the spare use every extent.
    assert_eq!(group.free_bytes, 0);
    assert!(group.mda_bytes >= 64 << 20, "{}", group.mda_bytes);
    let lvs = lab.lvs();
    let pool = lvs.iter().find(|lv| lv.name == "pgcf_thinpool").unwrap();
    assert!(pool.is_pool());
    assert_eq!(pool.size_bytes, group.size_bytes - 2 * (8 << 20));
    assert_eq!((pool.chunk_bytes, pool.metadata_bytes), (65_536, 8 << 20));
    assert_eq!(
        (pool.when_full.as_str(), pool.zero.as_str()),
        ("error", "zero")
    );
    // The pool fails writes at once and the status reads back through dmsetup.
    let sample = lab.storage.poll_pool().unwrap();
    assert_eq!(sample.data_total_bytes, pool.size_bytes);
    assert_eq!(sample.metadata_total_bytes, 8 << 20);
    assert_eq!(sample.mode, PoolMode::ReadWrite);
    lab.storage.open().unwrap();
    assert_eq!(lab.lvs(), lvs);
    // No volume yet: nothing to report, and nothing nominal.
    let inventory = lab.storage.inventory().unwrap();
    assert_eq!((inventory.volumes.len(), inventory.nominal_bytes), (0, 0));
}

/// Found live on EU1 (2026-10-23): a hard power-off left one leaked data block in the pool's
/// metadata; `thin_check -q` found it (exit 64), `vgchange --activate y` ended with 5, and the
/// agent crash-looped (798 starts) with every database of the node down for 27 minutes.
#[test]
fn a_pool_with_a_leaked_block_after_a_reset_is_activated_repaired_and_reported() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    fs::write(lab.dir_of(&a).join("kept"), b"committed").unwrap();
    lab.storage.unmount_volume(&a).unwrap();
    lab.deactivate_group();
    lab.leak_the_last_data_block();
    // The state of EU1: only a leak, the same words, exit 64, and the plain activation refused.
    let (status, report) = lab.thin_check();
    assert_eq!(status, 64, "{report}");
    assert!(report.contains("1 data blocks have leaked"), "{report}");
    let plain = SystemRunner.run(&commands::activate(lab.config())).unwrap();
    assert_eq!(plain.code, 5, "{}", plain.stderr);

    let opened = lab.storage.open().unwrap();
    assert_eq!(
        opened,
        Activation {
            released_parts: vec![],
            repair_run: true
        }
    );
    // The leak is repaired in the metadata, not only tolerated: the plain check passes now, and
    // so does a plain activation after the next reset.
    lab.deactivate_group();
    assert_eq!(lab.thin_check().0, 0);
    let plain = SystemRunner.run(&commands::activate(lab.config())).unwrap();
    assert_eq!(plain.code, 0, "{}", plain.stderr);
    // No committed byte was lost, and a clean start does not run the repairing activation.
    assert_eq!(lab.storage.open().unwrap(), Activation::default());
    assert!(
        lab.storage
            .mount_all(slice::from_ref(&a))
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read(lab.dir_of(&a).join("kept")).unwrap(), b"committed");
}

/// `--auto-repair` repairs a leak and nothing else: metadata that is damaged stays as it is, the
/// pool stays down and the agent's start fails with the error of `vgchange`, so that the node goes
/// stale and an operator decides. A leak beside the damage is not repaired either, because the
/// check reads the trees first.
#[test]
fn a_pool_with_damaged_metadata_is_never_activated_or_repaired() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    lab.storage.unmount_volume(&a).unwrap();
    lab.deactivate_group();
    lab.leak_the_last_data_block();
    lab.damage_the_mapping_tree();
    let before = lab.metadata_image();
    let (status, report) = lab.thin_check();
    assert_eq!(status, 64, "{report}");
    assert!(report.contains("checksum error"), "{report}");

    let result = lab.storage.open();
    assert!(
        matches!(&result, Err(Error::Command { program, code: 5, .. }) if program == "vgchange"),
        "{result:?}"
    );
    assert!(
        lab.metadata_image() == before,
        "a byte of the metadata changed"
    );
    let pool = format!("{}/{}", lab.config().group, lab.config().pool);
    let attributes = sh("lvs", &["--noheadings", "-o", "lv_attr", &pool]);
    assert_eq!(attributes.trim().as_bytes()[4], b'-', "{attributes}");
}

/// The read-only activation of the pool's metadata for an inspection (`lvchange --activate y
/// --yes` on the part, as the operator of EU1 did) leaves the part active, and lvm2 then refuses
/// to activate the pool.
#[test]
fn parts_of_the_pool_that_an_inspection_left_active_are_deactivated_before_the_pool_is() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    fs::write(lab.dir_of(&a).join("kept"), b"committed").unwrap();
    lab.storage.unmount_volume(&a).unwrap();
    lab.deactivate_group();
    for part in ["tmeta", "tdata"] {
        sh(
            "lvchange",
            &[
                "--quiet",
                "--activate",
                "y",
                "--yes",
                &format!("{}/{}_{part}", lab.config().group, lab.config().pool),
            ],
        );
    }
    let plain = SystemRunner.run(&commands::activate(lab.config())).unwrap();
    assert_eq!(plain.code, 5, "{}", plain.stderr);
    assert!(plain.stderr.contains("prohibited"), "{}", plain.stderr);

    let opened = lab.storage.open().unwrap();
    assert_eq!(
        opened,
        Activation {
            released_parts: vec!["pgcf_thinpool_tdata".into(), "pgcf_thinpool_tmeta".into()],
            repair_run: false
        }
    );
    assert!(
        lab.storage
            .mount_all(slice::from_ref(&a))
            .unwrap()
            .is_empty()
    );
    assert_eq!(fs::read(lab.dir_of(&a).join("kept")).unwrap(), b"committed");
}

#[test]
fn a_first_boot_that_stopped_halfway_is_finished() {
    // After pvcreate.
    let lab = Lab::new(512);
    lab.run(commands::pvcreate(lab.config()));
    lab.storage.open().unwrap();
    assert!(lab.lv(&id(ID, 1)).is_none());
    assert_eq!(lab.lvs()[0].when_full, "error");

    // After lvcreate of the pool, before `lvchange --errorwhenfull y`.
    let lab = Lab::new(512);
    lab.run(commands::pvcreate(lab.config()));
    lab.run(commands::vgcreate(lab.config()));
    let data = lab.group().free_bytes - 2 * (8 << 20);
    lab.run(commands::pool_create(lab.config(), data));
    assert_eq!(lab.lvs()[0].when_full, "queue");
    lab.storage.open().unwrap();
    assert_eq!(lab.lvs()[0].when_full, "error");
}

#[test]
fn a_disk_of_another_group_is_never_adopted() {
    let lab = Lab::new(512);
    sh(
        "vgcreate",
        &["--quiet", "pgcf-someone-else", &lab.loop_device],
    );
    let result = lab.storage.open();
    let other = Command::new("vgremove")
        .args(["-f", "pgcf-someone-else"])
        .output();
    assert!(matches!(result, Err(Error::Unexpected(_))), "{result:?}");
    assert!(other.unwrap().status.success());
}

#[test]
fn a_volume_is_created_formatted_and_mounted_for_its_owner_alone() {
    let lab = Lab::open(1024);
    let id = id(ID, 1);
    lab.create(&id, 256);
    let lv = lab.lv(&id).unwrap();
    assert!(lv.is_thin());
    assert_eq!(lv.size_bytes, 256 << 20);
    for tag in [&format!("pgcf.db.{ID}"), "pgcf.gen.1", FS_TAG] {
        assert!(lv.has_tag(tag), "{tag}: {:?}", lv.tags);
    }
    assert!(lab.mounted(&id));
    assert!(lab.linked_to_the_mounted_volume(&id));
    assert_eq!(
        fs::metadata(lab.dir_of(&id)).unwrap().mode() & 0o7777,
        0o700
    );
    assert_eq!(
        fs::metadata(&lab.config().mount_root).unwrap().mode() & 0o7777,
        0o711
    );
    let table = lab.mount_table();
    let line = table
        .lines()
        .find(|l| l.contains(&format!("/{ID} ")))
        .unwrap();
    // The kernel lists the access-time attribute last, and `relatime` is the default it replaces.
    assert!(line.contains(" rw,nosuid,nodev,noexec,noatime "), "{line}");
    assert!(!line.contains("relatime"), "{line}");
    assert!(!line.contains("discard"), "{line}");

    let inventory = lab.storage.inventory().unwrap();
    assert_eq!(inventory.nominal_bytes, 256 << 20);
    let volume = &inventory.volumes[0];
    assert_eq!(
        (volume.id.clone(), volume.size_bytes),
        (id.clone(), 256 << 20)
    );
    assert!(volume.formatted);
    assert!(!volume.fs_errors);
    let mount = volume.mount.unwrap();
    assert!(mount.usage.total_bytes > 200 << 20 && mount.usage.total_bytes < 256 << 20);
    assert!(mount.usage.inodes_total > 1000);
    // mkfs wrote its inode tables and journal: some chunks, far fewer than the nominal size.
    assert!(volume.pool_used_bytes > 1 << 20 && volume.pool_used_bytes < 64 << 20);
    let report = serde_json::json!({
        "observed_at": "2026-10-18T10:00:00.000Z",
        "volumes": inventory.volumes.iter().map(VolumeInfo::to_contract).collect::<Vec<_>>(),
    });
    assert!(crate::node_link::contract_valid(
        "NodeVolumeReport",
        &report
    ));
}

#[test]
fn creating_again_never_formats_again_and_a_stopped_create_continues() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 256);
    fs::write(lab.dir_of(&a).join("kept"), b"committed").unwrap();
    lab.storage.create_volume(&a, 256 << 20, &policy()).unwrap();
    lab.storage.unmount_volume(&a).unwrap();
    assert!(!lab.mounted(&a));
    lab.storage.create_volume(&a, 256 << 20, &policy()).unwrap();
    assert!(lab.mounted(&a));
    assert_eq!(fs::read(lab.dir_of(&a).join("kept")).unwrap(), b"committed");
    // Another size is another volume, never this one.
    assert!(matches!(
        lab.storage.create_volume(&a, 512 << 20, &policy()),
        Err(Error::Unexpected(_))
    ));

    // The agent stopped after lvcreate: no filesystem yet.
    let b = id(OTHER, 1);
    lab.run(commands::volume_create(lab.config(), &b, 256 << 20));
    assert!(!lab.lv(&b).unwrap().has_tag(FS_TAG));
    lab.storage.create_volume(&b, 256 << 20, &policy()).unwrap();
    assert!(lab.lv(&b).unwrap().has_tag(FS_TAG) && lab.mounted(&b));

    for bad in [0, (256 << 20) + 1, 6 << 20] {
        assert!(matches!(
            lab.storage
                .create_volume(&id("c1b2c3d4e5f6g7h8i9j0", 1), bad, &policy()),
            Err(Error::InvalidSize)
        ));
    }
}

#[test]
fn creating_is_refused_without_room_and_past_the_logical_cap() {
    let lab = Lab::open(256);
    // The pool is about 170 MiB: the cap of 4 x pool is below 1 GiB.
    let big = id(ID, 1);
    let result = lab.storage.create_volume(&big, 1 << 30, &policy());
    assert!(
        matches!(result, Err(Error::LogicalCap { .. })),
        "{result:?}"
    );
    assert!(lab.lv(&big).is_none());

    let reserve = Policy {
        reserve_bytes: 1 << 40,
        ..policy()
    };
    let result = lab.storage.create_volume(&big, 64 << 20, &reserve);
    assert!(
        matches!(result, Err(Error::NoRoom(NoRoom::Reserve))),
        "{result:?}"
    );
    assert!(lab.lv(&big).is_none());
    lab.create(&big, 64);
}

#[test]
fn a_volume_goes_only_when_unmounted_and_ordered_and_returns_its_chunks() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 256);
    assert!(lab.tenant_dd(&a, "data", 30720, "/dev/urandom"));
    let used = lab.pool_used();

    let ordered = Removal::DatabaseDeleted {
        storage_generation: 1,
    };
    assert!(matches!(
        lab.storage.remove_volume(&a, ordered),
        Err(Error::Mounted)
    ));
    let kept = Removal::Superseded {
        storage_generation: 1,
        remove_volume: false,
    };
    assert!(matches!(
        lab.storage.remove_volume(&a, kept),
        Err(Error::NotAuthorised)
    ));
    assert!(lab.lv(&a).is_some());

    lab.storage.unmount_volume(&a).unwrap();
    assert!(matches!(
        lab.storage.remove_volume(&a, kept),
        Err(Error::NotAuthorised)
    ));
    assert!(lab.lv(&a).is_some());
    lab.storage
        .remove_volume(
            &a,
            Removal::Superseded {
                storage_generation: 1,
                remove_volume: true,
            },
        )
        .unwrap();
    assert!(lab.lv(&a).is_none());
    assert!(!lab.dir_of(&a).exists());
    assert!(lab.pool_used() + (25 << 20) < used);
    // Removing what is gone is done.
    lab.storage.remove_volume(&a, ordered).unwrap();
}

#[test]
fn a_volume_that_is_not_a_database_volume_is_never_removed() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    // Named like a database volume but without its tags.
    sh(
        "lvcreate",
        &[
            "--quiet",
            "--thin",
            "--virtualsize",
            "64m",
            "--name",
            &a.lv_name(),
            &format!("{}/{}", lab.config().group, lab.config().pool),
        ],
    );
    let result = lab.storage.remove_volume(
        &a,
        Removal::DatabaseDeleted {
            storage_generation: 1,
        },
    );
    assert!(matches!(result, Err(Error::Unexpected(_))), "{result:?}");
    assert!(lab.lv(&a).is_some());
    // It is not reported as a database's volume, but it counts toward the logical cap.
    let inventory = lab.storage.inventory().unwrap();
    assert_eq!(
        (inventory.volumes.len(), inventory.nominal_bytes),
        (0, 64 << 20)
    );
}

#[test]
fn a_filesystem_that_something_holds_is_not_unmounted() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 256);
    let holder = Holder(
        Command::new("sleep")
            .arg("60")
            .current_dir(lab.dir_of(&a))
            .spawn()
            .unwrap(),
    );
    assert!(matches!(lab.storage.unmount_volume(&a), Err(Error::Busy)));
    assert!(lab.mounted(&a));
    drop(holder);
    lab.storage.unmount_volume(&a).unwrap();
    assert!(!lab.mounted(&a));
    // Not mounted is done.
    lab.storage.unmount_volume(&a).unwrap();
}

#[test]
fn a_volume_grows_online_never_shrinks_and_never_passes_the_cap() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 256);
    let before = lab.volume(&a).mount.unwrap().usage.total_bytes;
    lab.storage.grow_volume(&a, 512 << 20).unwrap();
    let grown = lab.volume(&a);
    assert_eq!(grown.size_bytes, 512 << 20);
    assert!(grown.mount.unwrap().usage.total_bytes > before + (200 << 20));
    lab.storage.grow_volume(&a, 512 << 20).unwrap();
    assert!(matches!(
        lab.storage.grow_volume(&a, 256 << 20),
        Err(Error::Shrink)
    ));
    // A volume that sleeps unmounted is mounted again to grow.
    lab.storage.unmount_volume(&a).unwrap();
    lab.storage.grow_volume(&a, 768 << 20).unwrap();
    assert!(lab.mounted(&a));
    assert!(lab.volume(&a).mount.unwrap().usage.total_bytes > 700 << 20);
    let result = lab.storage.grow_volume(&a, 64 << 30);
    assert!(
        matches!(result, Err(Error::LogicalCap { .. })),
        "{result:?}"
    );
    assert_eq!(lab.volume(&a).size_bytes, 768 << 20);
    assert!(matches!(
        lab.storage.grow_volume(&id(OTHER, 1), 256 << 20),
        Err(Error::Missing)
    ));
}

#[test]
fn the_pool_sample_follows_writes_and_the_room_rule_follows_the_policy() {
    let lab = Lab::open(1024);
    assert_eq!(lab.storage.room(&policy()), Err(NoRoom::Unobserved));
    let a = id(ID, 1);
    lab.create(&a, 256);
    let before = lab.pool_used();
    assert_eq!(lab.storage.room(&policy()), Ok(()));
    assert!(lab.tenant_dd(&a, "data", 40960, "/dev/urandom"));
    assert!(lab.pool_used() >= before + (40 << 20));
    let reserve = Policy {
        reserve_bytes: 1 << 40,
        ..policy()
    };
    assert_eq!(lab.storage.room(&reserve), Err(NoRoom::Reserve));
    let quick = Policy {
        sample_max_age: Duration::from_millis(300),
        ..policy()
    };
    lab.storage.poll_pool().unwrap();
    assert_eq!(lab.storage.room(&quick), Ok(()));
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(lab.storage.room(&quick), Err(NoRoom::Stale));
}

#[test]
fn trimming_returns_deleted_data_to_the_pool() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 256);
    assert!(lab.tenant_dd(&a, "data", 61440, "/dev/urandom"));
    let full = lab.pool_used();
    fs::remove_file(lab.dir_of(&a).join("data")).unwrap();
    sh("sync", &[]);
    assert!(lab.pool_used() + (10 << 20) > full);
    lab.storage.trim_volume(&a).unwrap();
    assert!(lab.pool_used() + (50 << 20) < full);
    lab.storage.unmount_volume(&a).unwrap();
    assert!(matches!(
        lab.storage.trim_volume(&a),
        Err(Error::NotMounted)
    ));
}

#[test]
fn a_booted_node_mounts_every_formatted_volume_again() {
    let lab = Lab::open(1024);
    let (a, b) = (id(ID, 1), id(OTHER, 2));
    lab.create(&a, 128);
    lab.create(&b, 128);
    fs::write(lab.dir_of(&a).join("kept"), b"committed").unwrap();
    // A volume whose create stopped before mkfs is not mounted.
    let c = id("c1b2c3d4e5f6g7h8i9j0", 1);
    lab.run(commands::volume_create(lab.config(), &c, 128 << 20));
    for volume in [&a, &b] {
        lab.storage.unmount_volume(volume).unwrap();
    }
    // What a reboot does to the volumes: the group is inactive until lvm2 activates it.
    sh(
        "vgchange",
        &["--quiet", "--activate", "n", &lab.config().group],
    );
    lab.storage.open().unwrap();
    let current = [a.clone(), b.clone(), c.clone()];
    assert!(lab.storage.mount_all(&current).unwrap().is_empty());
    assert!(lab.mounted(&a) && lab.mounted(&b) && !lab.mounted(&c));
    assert_eq!(fs::read(lab.dir_of(&a).join("kept")).unwrap(), b"committed");
    // Mounting twice changes nothing.
    assert!(lab.storage.mount_all(&current).unwrap().is_empty());
    // A volume the desired state does not name is not mounted.
    lab.storage.unmount_volume(&b).unwrap();
    assert!(
        lab.storage
            .mount_all(slice::from_ref(&a))
            .unwrap()
            .is_empty()
    );
    assert!(!lab.mounted(&b));
}

/// The agent mounts a database's volume when it decides on the database, many at once: the
/// mounts of different databases share the lock, and each gets its link.
#[test]
fn the_volumes_of_different_databases_are_mounted_at_once() {
    let lab = Lab::open(2048);
    let volumes: Vec<VolumeId> = (0..8)
        .map(|n| id(&format!("m{n}b2c3d4e5f6g7h8i9j0"), 1))
        .collect();
    for volume in &volumes {
        lab.create(volume, 32);
        fs::write(lab.dir_of(volume).join("kept"), b"committed").unwrap();
        lab.storage.unmount_volume(volume).unwrap();
        assert!(!lab.mounted(volume) && lab.link(volume).is_none());
    }
    let failures: Vec<_> = std::thread::scope(|scope| {
        let mounting: Vec<_> = volumes
            .iter()
            .map(|volume| scope.spawn(|| lab.storage.mount_all(slice::from_ref(volume))))
            .collect();
        mounting
            .into_iter()
            .flat_map(|mounting| mounting.join().unwrap().unwrap())
            .collect()
    });
    assert!(failures.is_empty(), "{failures:?}");
    for volume in &volumes {
        assert!(lab.linked_to_the_mounted_volume(volume));
        assert_eq!(
            fs::read(lab.dir_of(volume).join("kept")).unwrap(),
            b"committed"
        );
    }
}

/// The agent's exit unmounts what it mounted, many at once, and leaves what it did not mount.
#[test]
fn the_agents_exit_unmounts_every_volume_it_mounted() {
    let lab = Lab::open(2048);
    let volumes: Vec<VolumeId> = (0..6)
        .map(|n| id(&format!("x{n}b2c3d4e5f6g7h8i9j0"), 1))
        .collect();
    for volume in &volumes {
        lab.create(volume, 32);
        fs::write(lab.dir_of(volume).join("kept"), b"committed").unwrap();
    }
    // Something else of the agent's namespace stays, a mount below the volumes' root that is no
    // volume's.
    let other = lab.config().mount_root.join("other");
    fs::create_dir_all(&other).unwrap();
    sh("mount", &["-t", "tmpfs", "tmpfs", other.to_str().unwrap()]);
    lab.storage.unmount_all();
    for volume in &volumes {
        assert!(!lab.mounted(volume), "{volume:?}");
    }
    assert!(
        mountinfo::parse(&lab.mount_table())
            .unwrap()
            .iter()
            .any(|mount| mount.mount_point == other)
    );
    sh("umount", &[other.to_str().unwrap()]);
    // The volumes and what is in them are as they were: the next agent mounts them again.
    assert!(lab.storage.mount_all(&volumes).unwrap().is_empty());
    for volume in &volumes {
        assert_eq!(
            fs::read(lab.dir_of(volume).join("kept")).unwrap(),
            b"committed"
        );
    }
}

/// Runs the commands on the system and keeps the program of each.
struct Recording(Arc<std::sync::Mutex<Vec<String>>>);

impl CommandRunner for Recording {
    fn run(&self, command: &[String]) -> std::io::Result<Output> {
        self.0.lock().unwrap().push(command[0].clone());
        SystemRunner.run(command)
    }
}

/// The agent opens its storage at every start, and a report of LVM takes 150 to 300 ms with 312
/// volumes (EU1, 2026-10-23: 1.8 s to open, before the first page could be used). An agent that
/// restarts finds the pool and every volume active: it asks for the three reports at once and
/// activates nothing, and the volumes it read are the ones it keeps.
#[test]
fn opening_a_node_that_is_active_asks_for_three_reports_at_once_and_activates_nothing() {
    let lab = Lab::open(512);
    let a = id(ID, 1);
    lab.create(&a, 128);
    let ran = Arc::new(std::sync::Mutex::new(Vec::new()));
    let storage = Storage::new(Recording(ran.clone()), lab.config().clone());
    assert_eq!(storage.open().unwrap(), Activation::default());
    let mut programs = ran.lock().unwrap().clone();
    programs.sort();
    assert_eq!(programs, ["lvs", "pvs", "vgs"]);
    // The volumes it read answer the questions of the first decisions: no `lvs` more.
    assert!(storage.exists(&a).unwrap());
    assert_eq!(ran.lock().unwrap().len(), 3);
}

/// After a boot nothing is active: the group is activated, and the volumes are read again, so that
/// the reading the agent keeps shows them active.
#[test]
fn opening_a_node_after_a_boot_activates_the_group_and_reads_the_volumes_again() {
    let lab = Lab::open(512);
    let a = id(ID, 1);
    lab.create(&a, 128);
    lab.storage.unmount_volume(&a).unwrap();
    lab.run(vec![
        "vgchange".into(),
        "--quiet".into(),
        "--activate".into(),
        "n".into(),
        lab.config().group.clone(),
    ]);
    let ran = Arc::new(std::sync::Mutex::new(Vec::new()));
    let storage = Storage::new(Recording(ran.clone()), lab.config().clone());
    assert_eq!(storage.open().unwrap(), Activation::default());
    let mut programs = ran.lock().unwrap().clone();
    programs.sort();
    assert_eq!(programs, ["lvs", "lvs", "pvs", "vgchange", "vgs"]);
    assert!(lab.lvs().iter().all(|lv| lv.is_active()));
    assert!(storage.exists(&a).unwrap());
    assert_eq!(
        ran.lock().unwrap().len(),
        5,
        "the second reading is the one kept"
    );
}

#[test]
fn a_wake_asks_the_kernel_and_not_lvm2_about_a_mounted_volume() {
    let lab = Lab::open(512);
    let a = id(ID, 1);
    lab.create(&a, 128);
    let reads = Arc::new(AtomicUsize::new(0));
    let storage = Storage::new(Counting(reads.clone()), lab.config().clone());
    let reads = || reads.load(Ordering::Relaxed);

    // The first question reads the list; the others are the kernel's, whatever volumes there are.
    assert!(storage.exists(&a).unwrap());
    assert_eq!(reads(), 1);
    for _ in 0..3 {
        assert!(storage.exists(&a).unwrap());
        assert!(!storage.needs_repair(&a).unwrap());
    }
    assert_eq!(reads(), 1);

    // ext4 has no entry for a volume that is not mounted: lvm2 and the mount table answer.
    lab.storage.unmount_volume(&a).unwrap();
    assert!(storage.exists(&a).unwrap());
    assert!(!storage.needs_repair(&a).unwrap());
    assert_eq!(reads(), 2);

    // A volume that was removed is gone for the next question, though the list showed it.
    lab.storage
        .remove_volume(
            &a,
            Removal::DatabaseDeleted {
                storage_generation: 1,
            },
        )
        .unwrap();
    assert!(!storage.exists(&a).unwrap());
    assert!(matches!(storage.needs_repair(&a), Err(Error::Missing)));
}

#[test]
fn a_full_pool_marks_the_mounted_volumes_and_recovery_brings_them_back_with_their_data() {
    let lab = Lab::open(320);
    let (a, b) = (id(ID, 1), id(OTHER, 1));
    lab.create(&a, 256);
    lab.create(&b, 256);
    // A wake before the pool fills finds both clean, and the list that says so is kept.
    lab.storage.inventory().unwrap();
    assert!(!lab.storage.needs_repair(&a).unwrap() && !lab.storage.needs_repair(&b).unwrap());
    // `kept` is committed before the pool fills.
    assert!(lab.tenant_dd(&a, "kept", 1024, "/dev/urandom"));
    let kept = fs::read(lab.dir_of(&a).join("kept")).unwrap();
    assert!(lab.tenant_dd(&b, "bulk", 122880, "/dev/urandom"));
    // The tenant of `a` fills what is left, and the pool fails the write at once. PostgreSQL
    // stops at its first failed write: nothing writes to `a` again, so ext4 has not noticed.
    assert!(!lab.tenant_dd(&a, "more", 204800, "/dev/urandom"));
    sh("sync", &[]);

    // Whatever looks at the pool first tags what is mounted; here a create that is refused.
    let result = lab
        .storage
        .create_volume(&id("c1b2c3d4e5f6g7h8i9j0", 1), 64 << 20, &policy());
    assert!(
        matches!(result, Err(Error::NoRoom(NoRoom::Unwritable))),
        "{result:?}"
    );
    assert!(lab.storage.needs_repair(&a).unwrap() && lab.storage.needs_repair(&b).unwrap());
    // They are still mounted, and no unit may start on either: the marking took their links.
    assert!(lab.mounted(&a) && lab.mounted(&b));
    assert!(lab.link(&a).is_none() && lab.link(&b).is_none());
    let sample = lab.storage.poll_pool().unwrap();
    assert_eq!(sample.mode, PoolMode::OutOfDataSpace);
    assert_eq!(lab.storage.room(&policy()), Err(NoRoom::Unwritable));
    let damaged = |lab: &Lab| -> Vec<VolumeId> {
        let mut ids: Vec<_> = (lab.storage.inventory().unwrap().damaged().iter())
            .map(|v| v.id.clone())
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(damaged(&lab), vec![a.clone(), b.clone()]);

    // No space yet: recovery would write into a full pool.
    lab.storage.unmount_volume(&b).unwrap();
    let result = lab.storage.recover_volume(&a, &policy());
    assert!(matches!(result, Err(Error::NoRoom(_))), "{result:?}");
    assert!(lab.mounted(&a));

    // A deleted database returns its chunks and the pool takes writes again. Nothing has
    // written to `a`, and it is still found.
    lab.storage
        .remove_volume(
            &b,
            Removal::DatabaseDeleted {
                storage_generation: 1,
            },
        )
        .unwrap();
    assert_eq!(lab.storage.poll_pool().unwrap().mode, PoolMode::ReadWrite);
    assert_eq!(damaged(&lab), vec![a.clone()]);

    // The unit is stopped, and the volume is not mounted again until it is repaired.
    lab.storage.unmount_volume(&a).unwrap();
    assert!(matches!(
        lab.storage.mount_volume(&a),
        Err(Error::NeedsRepair)
    ));
    let failures = lab.storage.mount_all(slice::from_ref(&a)).unwrap();
    assert!(
        matches!(&failures[..], [(_, Error::NeedsRepair)]),
        "{failures:?}"
    );
    assert!(matches!(
        lab.storage.grow_volume(&a, 512 << 20),
        Err(Error::NeedsRepair)
    ));
    assert!(!lab.mounted(&a));
    assert!(lab.link(&a).is_none());
    // Its journal can hold transactions whose flag was lost, and `e2fsck -p` alone then refuses
    // (4, which `recover_volume` answers by setting the flag): which blocks the full pool refused
    // decides, and on the filesystem without reserved descriptors the lab has had it end 0, the
    // journal replayed. The repair below ends well either way.
    let output = SystemRunner.run(&commands::fsck(lab.config(), &a)).unwrap();
    assert!(matches!(output.code, 0 | 1 | 4), "{}", output.stderr);

    lab.storage.recover_volume(&a, &policy()).unwrap();
    assert!(lab.mounted(&a));
    // The repaired volume is attached again, and only now has its link.
    assert!(lab.linked_to_the_mounted_volume(&a));
    assert!(damaged(&lab).is_empty());
    assert!(!lab.storage.needs_repair(&a).unwrap());
    assert!(!lab.lv(&a).unwrap().has_tag(commands::SUSPECT_TAG));
    assert_eq!(fs::read(lab.dir_of(&a).join("kept")).unwrap(), kept);
    assert!(lab.tenant_dd(&a, "after", 1024, "/dev/zero"));
    assert_eq!(lab.storage.room(&policy()), Ok(()));
}

/// The mount table of the agent is its own namespace's: after a restart it lists the volumes it
/// has mounted since, and a unit's or a job's mount of a volume is in no table of its. What
/// decides which volumes the pool's failure may have damaged is that something has the volume
/// open, whoever it is.
#[test]
fn a_full_pool_marks_a_volume_that_only_a_unit_holds_and_leaves_one_that_nothing_holds() {
    let lab = Lab::open(320);
    let (a, b, c) = (id(ID, 1), id(OTHER, 1), id("c1b2c3d4e5f6g7h8i9j0", 1));
    lab.create(&a, 64);
    lab.create(&b, 256);
    lab.create(&c, 64);
    lab.storage.unmount_volume(&c).unwrap();
    // `a`'s unit has its own mount; the agent's is gone with the namespace of the agent before.
    let _unit = lab.unit_holding(&a);
    sh("umount", &[lab.dir_of(&a).to_str().unwrap()]);
    assert!(!lab.mounted(&a));
    assert!(
        lab.link(&a).is_some(),
        "the agent's start has not dropped it yet"
    );

    // The tenant of `b` fills the pool, and the pool fails the write at once.
    assert!(!lab.tenant_dd(&b, "bulk", 245760, "/dev/urandom"));
    sh("sync", &[]);
    assert_eq!(
        lab.storage.poll_pool().unwrap().mode,
        PoolMode::OutOfDataSpace
    );

    let suspect = |id: &VolumeId| lab.lv(id).unwrap().has_tag(commands::SUSPECT_TAG);
    assert!(suspect(&b), "mounted by the agent");
    assert!(
        suspect(&a),
        "held by its unit only: it was written while the pool took none"
    );
    assert!(!suspect(&c), "held by nothing: nothing wrote to it");
    // No unit may start on either, and the wake asks the tag.
    assert!(lab.link(&a).is_none() && lab.link(&b).is_none());
    assert!(lab.storage.needs_repair(&a).unwrap());
    assert!(!lab.storage.needs_repair(&c).unwrap());
}

/// The finding of the code reading of 2026-10-23: a pool that takes no writes tags every volume
/// that is open, the volume of a sleeping database included, and the first wake of that database
/// was refused for it. Nothing writes to a volume whose database sleeps, and the lab (a pool with
/// the agent's flags) takes it through a full data area clean: `e2fsck -p` exits 0, its data is
/// unchanged, and the repair after space has returned lists it, clears the tag and attaches it.
#[test]
fn a_volume_nothing_writes_to_comes_through_a_full_data_area_clean_and_is_repaired_when_space_returns()
 {
    let lab = Lab::open(320);
    let (idle, bulk) = (id(ID, 1), id(OTHER, 1));
    lab.create(&idle, 64);
    lab.create(&bulk, 256);
    // The sleeping database's committed data, and the digest it is compared with at the end.
    assert!(lab.tenant_dd(&idle, "kept", 2048, "/dev/urandom"));
    sh("sync", &[]);
    let kept = fs::read(lab.dir_of(&idle).join("kept")).unwrap();
    assert!(lab.storage.suspects().unwrap().is_empty());

    // Another tenant fills the pool; the pool fails its write at once and takes no more.
    assert!(!lab.tenant_dd(&bulk, "bulk", 245_760, "/dev/urandom"));
    sh("sync", &[]);
    assert_eq!(
        lab.storage.poll_pool().unwrap().mode,
        PoolMode::OutOfDataSpace
    );
    let sorted = |lab: &Lab| {
        let mut suspects = lab.storage.suspects().unwrap();
        suspects.sort();
        suspects
    };
    assert_eq!(sorted(&lab), vec![idle.clone(), bulk.clone()]);
    // The repair writes, and the pool has no room for it yet.
    assert!(matches!(
        lab.storage.recover_volume(&idle, &policy()),
        Err(Error::NoRoom(_))
    ));
    assert!(lab.mounted(&idle) && lab.link(&idle).is_none());

    // The other database is deleted and its chunks return: the pool takes writes again.
    lab.storage.unmount_volume(&bulk).unwrap();
    lab.storage
        .remove_volume(
            &bulk,
            Removal::DatabaseDeleted {
                storage_generation: 1,
            },
        )
        .unwrap();
    assert_eq!(lab.storage.poll_pool().unwrap().mode, PoolMode::ReadWrite);
    assert_eq!(lab.storage.room(&policy()), Ok(()));
    assert_eq!(sorted(&lab), vec![idle.clone()]);

    // Its filesystem is clean as it stands: nothing was written to it while the pool took none.
    lab.storage.unmount_volume(&idle).unwrap();
    let output = SystemRunner
        .run(&commands::fsck(lab.config(), &idle))
        .unwrap();
    assert_eq!(output.code, 0, "{}", output.stderr);
    let began = std::time::Instant::now();
    lab.storage.recover_volume(&idle, &policy()).unwrap();
    eprintln!(
        "lab: the repair of the idle volume took {} ms",
        began.elapsed().as_millis()
    );
    assert!(lab.linked_to_the_mounted_volume(&idle));
    assert!(lab.storage.suspects().unwrap().is_empty());
    assert!(!lab.storage.needs_repair(&idle).unwrap());
    assert_eq!(fs::read(lab.dir_of(&idle).join("kept")).unwrap(), kept);
    assert!(lab.tenant_dd(&idle, "after", 1024, "/dev/zero"));
}

/// The same event with the pool's metadata: its area is full, the pool is read-only (the writes
/// fail with EIO and not with ENOSPC), and every volume that is open is tagged. A larger metadata
/// area (`lvextend --poolmetadatasize`, which an operator does) brings the pool back to read-write
/// online, and the volume of the database that sleeps is repaired as after a full data area.
#[test]
fn a_volume_nothing_writes_to_comes_through_a_full_metadata_area_clean_and_is_repaired_when_it_has_room_again()
 {
    let lab = Lab::open(320);
    let idle = id(ID, 1);
    lab.create(&idle, 64);
    assert!(lab.tenant_dd(&idle, "kept", 1024, "/dev/urandom"));
    sh("sync", &[]);
    let kept = fs::read(lab.dir_of(&idle).join("kept")).unwrap();
    assert_eq!(lab.storage.poll_pool().unwrap().mode, PoolMode::ReadWrite);

    // Every thin device takes a block of the pool's metadata for its tree: enough of them (made
    // with the pool's own message, which is quick) fill the 8 MiB area, and the pool goes
    // read-only. They are no volume of a database, and the agent does not list them.
    let listed = lab.run(vec![
        "dmsetup".into(),
        "ls".into(),
        "--target".into(),
        "thin-pool".into(),
    ]);
    let pool = listed
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .find(|name| name.starts_with(&format!("{}-", lab.config().group)))
        .unwrap()
        .to_string();
    let mut made = 0;
    loop {
        let output = SystemRunner
            .run(&[
                "dmsetup".into(),
                "message".into(),
                pool.clone(),
                "0".into(),
                format!("create_thin {}", 100_000 + made),
            ])
            .unwrap();
        if output.code != 0 {
            break;
        }
        made += 1;
        assert!(made < 5000, "the metadata did not fill");
    }
    let sample = lab.storage.poll_pool().unwrap();
    eprintln!("lab: the pool is {:?} after {made} devices", sample.mode);
    assert_eq!(sample.mode, PoolMode::ReadOnly, "{sample:?}");
    assert!(!sample.writable());
    assert_eq!(lab.storage.suspects().unwrap(), vec![idle.clone()]);
    assert!(matches!(
        lab.storage.recover_volume(&idle, &policy()),
        Err(Error::NoRoom(_))
    ));

    // The operator gives the pool more metadata: the disk grows by 32 MiB and the group with it.
    let image = lab.dir.join("disk.img");
    fs::OpenOptions::new()
        .write(true)
        .open(&image)
        .unwrap()
        .set_len((320 + 32) << 20)
        .unwrap();
    sh("losetup", &["-c", &lab.loop_device]);
    sh("pvresize", &[&lab.loop_device]);
    let target = format!("{}/{}", lab.config().group, lab.config().pool);
    let began = std::time::Instant::now();
    sh(
        "lvextend",
        &["--quiet", "--poolmetadatasize", "+4m", &target],
    );
    eprintln!(
        "lab: lvextend --poolmetadatasize took {} ms",
        began.elapsed().as_millis()
    );
    let sample = lab.storage.poll_pool().unwrap();
    assert_eq!(sample.mode, PoolMode::ReadWrite, "{sample:?}");
    assert!(sample.writable(), "{sample:?}");
    assert_eq!(lab.storage.room(&policy()), Ok(()));

    // The tag stays until the repair, which finds the filesystem clean.
    assert_eq!(lab.storage.suspects().unwrap(), vec![idle.clone()]);
    lab.storage.unmount_volume(&idle).unwrap();
    let output = SystemRunner
        .run(&commands::fsck(lab.config(), &idle))
        .unwrap();
    assert_eq!(output.code, 0, "{}", output.stderr);
    let began = std::time::Instant::now();
    lab.storage.recover_volume(&idle, &policy()).unwrap();
    eprintln!(
        "lab: the repair of the idle volume took {} ms",
        began.elapsed().as_millis()
    );
    assert!(lab.linked_to_the_mounted_volume(&idle));
    assert!(lab.storage.suspects().unwrap().is_empty());
    assert_eq!(fs::read(lab.dir_of(&idle).join("kept")).unwrap(), kept);
    assert!(lab.tenant_dd(&idle, "after", 1024, "/dev/zero"));
}

/// A unit holds the filesystem in a namespace of its own, which the agent's unmount does not see:
/// the agent's own mount goes, the superblock stays, and the volume is still in use. The unmount
/// says so, keeps the volume attached and its link, and goes through once the unit has let go.
#[test]
fn an_unmount_under_a_unit_that_holds_the_filesystem_is_busy_and_leaves_the_volume_attached() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    assert!(lab.tenant_dd(&a, "data", 1024, "/dev/urandom"));
    let data = fs::read(lab.dir_of(&a).join("data")).unwrap();
    let unit = lab.unit_holding(&a);

    let result = lab.storage.unmount_volume(&a);
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    assert!(lab.linked_to_the_mounted_volume(&a));
    assert_eq!(fs::read(lab.dir_of(&a).join("data")).unwrap(), data);
    // The next generation of the database is not built while the unit of this one runs: the
    // directory is this generation's.
    let result = lab.storage.create_volume(&id(ID, 2), 128 << 20, &policy());
    assert!(matches!(result, Err(Error::OtherGeneration)), "{result:?}");
    // A volume cannot be taken from under its unit by removal either.
    let order = Removal::DatabaseDeleted {
        storage_generation: 1,
    };
    assert!(matches!(
        lab.storage.remove_volume(&a, order),
        Err(Error::Mounted)
    ));
    // Nor repaired: the recovery stops before it touches the device.
    let result = lab.storage.recover_volume(&a, &policy());
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    assert!(lab.mounted(&a));
    assert_eq!(fs::read(lab.dir_of(&a).join("data")).unwrap(), data);
    // The unit stops. Its namespace goes, and the superblock a moment after.
    drop(unit);
    let mut result = lab.storage.unmount_volume(&a);
    for _ in 0..40 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
        result = lab.storage.unmount_volume(&a);
    }
    assert!(result.is_ok(), "{result:?}");
    assert!(!lab.mounted(&a) && lab.link(&a).is_none());
}

/// The agent restarts while a unit runs on the old generation of its database: the agent's mounts
/// and links are gone with its namespace, and the agent has no mount of the volume. Its own mount
/// table says the volume is free; the kernel says a unit holds it. Every operation that needs the
/// volume or the database's directory asks the kernel: nothing is detached, repaired, removed or
/// built over a filesystem a unit has, and what a boot mounts is the generation the page names
/// only once the old one is let go. The unit's data is untouched throughout.
#[test]
fn after_an_agents_restart_the_old_generation_that_only_a_unit_holds_is_held_for_every_operation() {
    let lab = Lab::open(1024);
    let (g1, g2) = (id(ID, 1), id(ID, 2));
    lab.create(&g1, 128);
    assert!(lab.tenant_dd(&g1, "data", 1024, "/dev/urandom"));
    let data = fs::read(lab.dir_of(&g1).join("data")).unwrap();
    lab.storage.unmount_volume(&g1).unwrap();
    // The next generation exists (its create finished earlier) and is not mounted.
    lab.create(&g2, 128);
    lab.storage.unmount_volume(&g2).unwrap();
    lab.storage.mount_volume(&g1).unwrap();
    let unit = lab.unit_holding(&g1);
    // The restart: the agent's namespace is gone, and the agent's start drops every link.
    sh("umount", &[lab.dir_of(&g1).to_str().unwrap()]);
    lab.storage.reset_device_links().unwrap();
    assert!(!lab.mounted(&g1) && lab.link(&g1).is_none());

    // The boot mounts what the page names, which is the next generation, and it is refused while
    // the unit has the old one: a start on it would be a start of a unit that runs.
    let failures = lab.storage.mount_all(slice::from_ref(&g2)).unwrap();
    assert!(
        matches!(&failures[..], [(failed, Error::OtherGeneration)] if *failed == g2),
        "{failures:?}"
    );
    assert!(!lab.mounted(&g2) && !lab.storage.attached(&g2));
    assert!(matches!(
        lab.storage.mount_volume(&g2),
        Err(Error::OtherGeneration)
    ));
    // A third generation is not made over it either.
    let g3 = id(ID, 3);
    let result = lab.storage.create_volume(&g3, 128 << 20, &policy());
    assert!(matches!(result, Err(Error::OtherGeneration)), "{result:?}");
    assert!(lab.lv(&g3).is_none());
    // The old generation is not detached, repaired or removed from under its unit.
    let result = lab.storage.unmount_volume(&g1);
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    let result = lab.storage.recover_volume(&g1, &policy());
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    let order = Removal::Superseded {
        storage_generation: 1,
        remove_volume: true,
    };
    let result = lab.storage.remove_volume(&g1, order);
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    assert!(lab.lv(&g1).is_some());
    // Nothing of that gave the unit's volume a link, a mount of the agent's or a tag.
    assert!(lab.link(&g1).is_none() && !lab.mounted(&g1));
    assert!(!lab.lv(&g1).unwrap().has_tag(commands::SUSPECT_TAG));

    // The unit's own view of the volume is as it was: nothing was repaired, mounted over or taken.
    let at_the_unit = format!(
        "/proc/{}/root{}/data",
        unit.0.id(),
        lab.dir
            .join(format!("unit-{}-mount", g1.database()))
            .display()
    );
    assert_eq!(fs::read(at_the_unit).unwrap(), data);

    // The unit stops. Its namespace goes, and the superblock a moment after: the next generation
    // is mounted, and the old one can be removed.
    drop(unit);
    let mut result = lab.storage.unmount_volume(&g1);
    for _ in 0..40 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
        result = lab.storage.unmount_volume(&g1);
    }
    assert!(result.is_ok(), "{result:?}");
    assert!(
        lab.storage
            .mount_all(slice::from_ref(&g2))
            .unwrap()
            .is_empty()
    );
    assert!(lab.linked_to_the_mounted_volume(&g2));
    lab.storage.remove_volume(&g1, order).unwrap();
    assert!(lab.lv(&g1).is_none() && lab.mounted(&g2));
}

#[test]
fn the_generations_of_a_database_take_turns_at_its_directory() {
    let lab = Lab::open(1024);
    let (g1, g2) = (id(ID, 1), id(ID, 2));
    lab.create(&g1, 128);
    fs::write(lab.dir_of(&g1).join("marker"), b"g1").unwrap();
    // g1 holds the directory: the next generation is refused before anything is made.
    let result = lab.storage.create_volume(&g2, 128 << 20, &policy());
    assert!(matches!(result, Err(Error::OtherGeneration)), "{result:?}");
    assert!(lab.lv(&g2).is_none());

    lab.storage.unmount_volume(&g1).unwrap();
    lab.create(&g2, 128);
    fs::write(lab.dir_of(&g2).join("marker"), b"g2").unwrap();
    // g1 does not come back over g2, and unmounting it leaves g2 alone.
    assert!(matches!(
        lab.storage.mount_volume(&g1),
        Err(Error::OtherGeneration)
    ));
    lab.storage.unmount_volume(&g1).unwrap();
    assert!(lab.mounted(&g2) && !lab.mounted(&g1));

    // The superseded generation goes while g2 is mounted, and the directory stays with g2.
    let order = Removal::Superseded {
        storage_generation: 1,
        remove_volume: true,
    };
    lab.storage.remove_volume(&g1, order).unwrap();
    assert!(lab.lv(&g1).is_none() && lab.mounted(&g2));
    lab.storage.remove_volume(&g1, order).unwrap();
    assert_eq!(fs::read(lab.dir_of(&g2).join("marker")).unwrap(), b"g2");
    // The order does not reach a newer generation.
    assert!(matches!(
        lab.storage.remove_volume(&g2, order),
        Err(Error::NotAuthorised)
    ));
    // The last volume takes the directory with it.
    lab.storage.unmount_volume(&g2).unwrap();
    lab.storage
        .remove_volume(
            &g2,
            Removal::DatabaseDeleted {
                storage_generation: 2,
            },
        )
        .unwrap();
    assert!(!lab.dir_of(&g2).exists());
}

#[test]
fn unmounting_never_takes_a_filesystem_that_is_not_the_volumes_own() {
    let lab = Lab::open(1024);
    let (g1, g2) = (id(ID, 1), id(ID, 2));
    lab.create(&g1, 128);
    lab.storage.unmount_volume(&g1).unwrap();
    lab.create(&g2, 128);
    // Someone mounts g1 over g2 at the directory.
    let (device1, device2) = (
        commands::device(lab.config(), &g1),
        commands::device(lab.config(), &g2),
    );
    sh("mount", &[&device1, lab.dir_of(&g2).to_str().unwrap()]);
    let result = lab.storage.unmount_volume(&g2);
    assert!(matches!(result, Err(Error::Unexpected(_))), "{result:?}");
    assert_eq!(lab.top_source(&g2), device1);
    // Neither is removed while it is mounted.
    let order = |storage_generation| Removal::Superseded {
        storage_generation,
        remove_volume: true,
    };
    assert!(matches!(
        lab.storage.remove_volume(&g1, order(1)),
        Err(Error::Mounted)
    ));
    assert!(matches!(
        lab.storage.remove_volume(&g2, order(2)),
        Err(Error::Mounted)
    ));
    lab.storage.unmount_volume(&g1).unwrap();
    assert_eq!(lab.top_source(&g2), device2);
    lab.storage.unmount_volume(&g2).unwrap();
}

#[test]
fn a_booted_node_mounts_the_current_generation_only() {
    let lab = Lab::open(1024);
    // lvm2 lists g10 before g9: mounting everything would put the older generation on top.
    let (old, current) = (id(ID, 9), id(ID, 10));
    lab.create(&old, 128);
    fs::write(lab.dir_of(&old).join("marker"), b"g9 superseded").unwrap();
    lab.storage.unmount_volume(&old).unwrap();
    lab.create(&current, 128);
    fs::write(lab.dir_of(&current).join("marker"), b"g10 current").unwrap();
    lab.storage.unmount_volume(&current).unwrap();
    sh(
        "vgchange",
        &["--quiet", "--activate", "n", &lab.config().group],
    );
    lab.storage.open().unwrap();
    assert!(
        lab.storage
            .mount_all(slice::from_ref(&current))
            .unwrap()
            .is_empty()
    );
    assert!(lab.mounted(&current) && !lab.mounted(&old));
    assert_eq!(
        fs::read(lab.dir_of(&current).join("marker")).unwrap(),
        b"g10 current"
    );
    // Two generations named for one database mount the first and refuse the second, instead of
    // stacking them.
    lab.storage.unmount_volume(&current).unwrap();
    let failures = lab
        .storage
        .mount_all(&[old.clone(), current.clone()])
        .unwrap();
    assert!(
        matches!(&failures[..], [(failed, Error::OtherGeneration)] if *failed == current),
        "{failures:?}"
    );
    assert!(lab.mounted(&old) && !lab.mounted(&current));
}

#[test]
fn a_volume_that_is_not_active_is_not_reported_as_empty() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    assert!(lab.tenant_dd(&a, "data", 20480, "/dev/urandom"));
    lab.storage.unmount_volume(&a).unwrap();
    let path = format!("{}/{}", lab.config().group, a.lv_name());
    sh("lvchange", &["--quiet", "--activate", "n", &path]);
    let result = lab.storage.inventory();
    assert!(matches!(result, Err(Error::Unexpected(_))), "{result:?}");
    sh("lvchange", &["--quiet", "--activate", "y", &path]);
    assert!(lab.volume(&a).pool_used_bytes > 20 << 20);
}

/// The filesystem's size from its superblock: block count times block size.
fn filesystem_bytes(lab: &Lab, id: &VolumeId) -> u64 {
    let report = sh("dumpe2fs", &["-h", &commands::device(lab.config(), id)]);
    let field = |name: &str| -> u64 {
        report
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    };
    field("Block count:") * field("Block size:")
}

/// The last `mib` MiB of the volume's device, read raw.
fn device_tail(lab: &Lab, id: &VolumeId, mib: u64) -> Vec<u8> {
    let size_mib = lab.lv(id).unwrap().size_bytes >> 20;
    let output = Command::new("dd")
        .arg(format!("if={}", commands::device(lab.config(), id)))
        .args([
            "bs=1M",
            &format!("skip={}", size_mib - mib),
            &format!("count={mib}"),
        ])
        .stderr(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout
}

/// The sectors counted back from the end of a device that libblkid's `promise_raid` probes
/// (`commands` tests): the farthest is 3087.
const PROMISE_SECTORS_FROM_THE_END: [u64; 13] = [
    63, 255, 256, 16, 399, 591, 675, 735, 911, 974, 991, 951, 3087,
];

/// A file of sectors that each begin with the signature of a Promise FastTrack RAID member, which
/// libblkid looks for 3087 sectors from the end of a device.
fn promise_sectors(lab: &Lab) -> PathBuf {
    let mut sector = [0u8; 512];
    sector[..24].copy_from_slice(b"Promise Technology, Inc.");
    let path = lab.dir.join("promise.bin");
    fs::write(&path, sector.repeat(2048)).unwrap();
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
    path
}

/// What `blkid -p` makes of the device: the filesystem's type, or the RAID signature that would
/// make systemd's image dissection refuse the volume.
fn probed_type(lab: &Lab, id: &VolumeId) -> String {
    let export = sh(
        "blkid",
        &["-p", "-o", "export", &commands::device(lab.config(), id)],
    );
    export
        .lines()
        .find_map(|line| line.strip_prefix("TYPE=").map(String::from))
        .unwrap_or_default()
}

/// Every sector that `promise_raid` probes holds nothing but zeros.
fn probed_sectors_are_zero(lab: &Lab, id: &VolumeId) -> bool {
    let sectors = lab.lv(id).unwrap().size_bytes / 512;
    PROMISE_SECTORS_FROM_THE_END.iter().all(|back| {
        let output = Command::new("dd")
            .arg(format!("if={}", commands::device(lab.config(), id)))
            .args(["bs=512", &format!("skip={}", sectors - back), "count=1"])
            .stderr(Stdio::null())
            .output()
            .unwrap();
        output.status.success() && output.stdout.iter().all(|byte| *byte == 0)
    })
}

/// The databases' units and jobs mount a volume through systemd's image dissection, whose libblkid
/// probers read the end of the device as root: nothing a tenant writes may reach what they read.
/// The tenant here writes a Promise signature into every sector it can, which is what a tenant that
/// knew the prober would do.
#[test]
fn a_filesystem_ends_before_what_libblkid_reads_at_the_end_when_made_and_when_grown() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    let gap = commands::FS_END_GAP_BYTES;
    let signature = promise_sectors(&lab);
    lab.create(&a, 128);
    assert_eq!(filesystem_bytes(&lab, &a), (128 << 20) - gap);
    // No block of the filesystem is one that libblkid probes.
    let farthest = PROMISE_SECTORS_FROM_THE_END.iter().max().unwrap() * 512;
    assert!((128u64 << 20) - filesystem_bytes(&lab, &a) > farthest);
    // The tenant takes everything its filesystem has.
    lab.tenant_fill_with(&a, "fill", &signature);
    assert_eq!(probed_type(&lab, &a), "ext4");
    assert!(probed_sectors_are_zero(&lab, &a));
    assert!(
        device_tail(&lab, &a, gap >> 20)
            .iter()
            .all(|byte| *byte == 0)
    );
    // Growing keeps the gap at the new end, and the same call again changes nothing.
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (256 << 20) - gap);
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (256 << 20) - gap);
    lab.tenant_fill_with(&a, "fill2", &signature);
    assert_eq!(probed_type(&lab, &a), "ext4");
    assert!(probed_sectors_are_zero(&lab, &a));
    assert!(
        device_tail(&lab, &a, gap >> 20)
            .iter()
            .all(|byte| *byte == 0)
    );
    // A volume that sleeps unmounted is mounted to grow, and ends the same way.
    lab.storage.unmount_volume(&a).unwrap();
    lab.storage.grow_volume(&a, 512 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (512 << 20) - gap);

    // What the gap is for: the prober does read 3087 sectors from the end. A signature written
    // there by hand, where nothing of the filesystem is, makes libblkid call the ext4 device a
    // RAID member, which is what the dissection refuses; zeroed again, it is ext4.
    let device = commands::device(lab.config(), &a);
    let sector = lab.lv(&a).unwrap().size_bytes / 512 - 3087;
    sh(
        "sh",
        &[
            "-c",
            &format!(
                "printf 'Promise Technology, Inc.' | dd of={device} bs=512 seek={sector} conv=notrunc 2>/dev/null"
            ),
        ],
    );
    assert_eq!(probed_type(&lab, &a), "promise_fasttrack_raid_member");
    sh(
        "dd",
        &[
            "if=/dev/zero",
            &format!("of={device}"),
            "bs=512",
            &format!("seek={sector}"),
            "count=1",
            "conv=notrunc",
            "status=none",
        ],
    );
    assert_eq!(probed_type(&lab, &a), "ext4");
}

/// A volume made before the gap existed has a filesystem that fills it. Asked again for the size
/// the volume has (a retry after a crash between `resize2fs` and the saved state), the grow must
/// not ask `resize2fs` for a smaller filesystem, which it refuses ("On-line shrinking not
/// supported") for ever; it grows the volume when it is asked for more, to the gap's size.
#[test]
fn a_grow_to_the_size_the_volume_has_leaves_a_filesystem_that_fills_it_as_it_is() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    lab.storage.unmount_volume(&a).unwrap();
    let device = commands::device(lab.config(), &a);
    sh("e2fsck", &["-fp", &device]);
    sh(
        "resize2fs",
        &[&device, &format!("{}K", (128u64 << 20) / 1024)],
    );
    assert_eq!(filesystem_bytes(&lab, &a), 128 << 20);
    lab.storage.grow_volume(&a, 128 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), 128 << 20);
    assert!(lab.linked_to_the_mounted_volume(&a));
    // More room gives the filesystem the gap at its new end.
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert_eq!(
        filesystem_bytes(&lab, &a),
        (256 << 20) - commands::FS_END_GAP_BYTES
    );
}

/// The unit mounts its volume from `<device_links>/<id>` as root (`MountImages=`), so the link
/// names the device of the attached generation and exists only while the agent has it attached.
#[test]
fn a_database_has_a_device_link_exactly_while_its_volume_is_attached() {
    let lab = Lab::open(1024);
    let (g1, g2) = (id(ID, 1), id(ID, 2));
    assert!(lab.link(&g1).is_none());
    assert!(!lab.storage.attached(&g1));
    lab.create(&g1, 128);
    assert!(lab.linked_to_the_mounted_volume(&g1));
    assert!(lab.storage.attached(&g1));
    // The directory is root's alone: the root executor follows what is in it.
    let links = fs::metadata(&lab.config().device_links).unwrap();
    assert_eq!((links.uid(), links.mode() & 0o7777), (0, 0o700));
    // The link is made again for a volume that is mounted already, and never staged visibly. A
    // volume that is mounted without its link (the rename failed after the mount) is not attached:
    // the agent asks for the attach, which makes the link.
    lab.storage.mount_volume(&g1).unwrap();
    assert_eq!(fs::read_dir(&lab.config().device_links).unwrap().count(), 1);
    fs::remove_file(lab.config().device_links.join(g1.database())).unwrap();
    assert!(lab.mounted(&g1) && !lab.storage.attached(&g1));
    lab.storage.mount_all(slice::from_ref(&g1)).unwrap();
    assert!(lab.linked_to_the_mounted_volume(&g1) && lab.storage.attached(&g1));

    // An unmount that fails leaves the volume attached, so it keeps its link.
    let holder = Holder(
        Command::new("sleep")
            .arg("60")
            .current_dir(lab.dir_of(&g1))
            .spawn()
            .unwrap(),
    );
    assert!(matches!(lab.storage.unmount_volume(&g1), Err(Error::Busy)));
    assert!(lab.linked_to_the_mounted_volume(&g1));
    drop(holder);

    // Unmounted: no link, and so no start.
    lab.storage.unmount_volume(&g1).unwrap();
    assert!(lab.link(&g1).is_none() && !lab.mounted(&g1));
    lab.storage.mount_volume(&g1).unwrap();
    assert!(lab.linked_to_the_mounted_volume(&g1));

    // The next generation takes the directory, and the link, only after g1 has gone from both.
    let result = lab.storage.create_volume(&g2, 128 << 20, &policy());
    assert!(matches!(result, Err(Error::OtherGeneration)), "{result:?}");
    assert!(lab.linked_to_the_mounted_volume(&g1));
    lab.storage.unmount_volume(&g1).unwrap();
    assert!(lab.link(&g1).is_none());
    lab.create(&g2, 128);
    assert!(lab.linked_to_the_mounted_volume(&g2));
    // g1 does not come back over g2, and neither its unmount nor its removal touches g2's link.
    assert!(matches!(
        lab.storage.mount_volume(&g1),
        Err(Error::OtherGeneration)
    ));
    lab.storage.unmount_volume(&g1).unwrap();
    assert!(lab.linked_to_the_mounted_volume(&g2));
    let order = Removal::Superseded {
        storage_generation: 1,
        remove_volume: true,
    };
    lab.storage.remove_volume(&g1, order).unwrap();
    assert!(lab.linked_to_the_mounted_volume(&g2));

    // A volume that goes loses its link before it is removed, and the link of a volume that is
    // not there is cleaned up as well.
    lab.storage.unmount_volume(&g2).unwrap();
    assert!(lab.link(&g2).is_none());
    std::os::unix::fs::symlink(
        commands::device(lab.config(), &g2),
        lab.config().device_links.join(g2.database()),
    )
    .unwrap();
    lab.storage
        .remove_volume(
            &g2,
            Removal::DatabaseDeleted {
                storage_generation: 2,
            },
        )
        .unwrap();
    assert!(lab.link(&g2).is_none());
}

/// An agent's start: the namespace that held the volumes is gone, and with it the truth of every
/// link. A link is made again with the attach of its volume, whether the volume is mounted by
/// then or not.
#[test]
fn the_agents_start_drops_every_link_and_an_attach_makes_them_again() {
    let lab = Lab::open(1024);
    let (a, b) = (id(ID, 1), id(OTHER, 1));
    lab.create(&a, 64);
    lab.create(&b, 64);
    // A link of a database that is gone, and one that was staged and never renamed.
    let links = lab.config().device_links.clone();
    std::os::unix::fs::symlink("/dev/mapper/gone", links.join("zzzzzzzzzzzzzzzzzzzz")).unwrap();
    std::os::unix::fs::symlink("/dev/mapper/gone", links.join("yyyyyyyyyyyyyyyyyyyy.new")).unwrap();
    lab.storage.reset_device_links().unwrap();
    assert_eq!(fs::read_dir(&links).unwrap().count(), 0);
    assert_eq!(fs::metadata(&links).unwrap().mode() & 0o7777, 0o700);
    // `a` is still mounted, `b` is not (as after the restart that ended the agent's namespace).
    lab.storage.unmount_volume(&b).unwrap();
    assert!(lab.mounted(&a) && lab.link(&a).is_none());
    assert!(
        lab.storage
            .mount_all(&[a.clone(), b.clone()])
            .unwrap()
            .is_empty()
    );
    assert!(lab.linked_to_the_mounted_volume(&a) && lab.linked_to_the_mounted_volume(&b));
}

/// A unit or a job mounts the volume in a namespace of its own, which the agent's mount table does
/// not list: lvm2's refusal is what says that one still has it. lvm2 asks again for about five
/// seconds before it refuses, so a device that is let go of in that time does not stop the removal.
#[test]
fn a_volume_that_a_unit_or_a_job_still_has_open_is_busy_and_goes_when_it_lets_go() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    lab.storage.unmount_volume(&a).unwrap();
    let ordered = Removal::DatabaseDeleted {
        storage_generation: 1,
    };
    let hold = |seconds: u32| {
        Holder(
            Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "exec sleep {seconds} < {}",
                    commands::device(lab.config(), &a)
                ))
                .spawn()
                .unwrap(),
        )
    };
    let holder = hold(60);
    std::thread::sleep(Duration::from_millis(200));
    let result = lab.storage.remove_volume(&a, ordered);
    assert!(matches!(result, Err(Error::Busy)), "{result:?}");
    assert!(lab.lv(&a).is_some());
    drop(holder);

    // One that lets go while lvm2 still asks again does not stop the removal.
    let holder = hold(60);
    std::thread::sleep(Duration::from_millis(200));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        drop(holder);
    });
    lab.storage.remove_volume(&a, ordered).unwrap();
    release.join().unwrap();
    assert!(lab.lv(&a).is_none());
}

// ---------- growth and recovery with a real tenant PostgreSQL ----------

/// A tenant's PostgreSQL on the volume of a lab: `initdb` as the tenant's user, the files of
/// `base` and `global` in the project as the agent puts them, the agent's `postgresql.conf` for
/// the volume's size, and the postmaster run as the tenant's user (not root, which a quota does
/// not limit and PostgreSQL refuses). The tenant's user needs a passwd entry (the lab container
/// makes one for `TENANT`).
struct TenantPg {
    data: PathBuf,
    socket: PathBuf,
    bin: PathBuf,
    child: Option<Child>,
}

impl TenantPg {
    fn new(lab: &Lab, id: &VolumeId) -> TenantPg {
        let bin = crate::testpg::bin_directory().expect("a PostgreSQL 18 for the lab");
        let data = lab.dir_of(id).join("data");
        let socket = lab.dir.join(format!("sock-{}", id.generation()));
        fs::create_dir_all(&socket).unwrap();
        chown(&socket, Some(TENANT), Some(TENANT)).unwrap();
        let mut initdb = Command::new(bin.join("initdb"));
        initdb
            .args(crate::machine::initdb_arguments(&data))
            .arg("--no-sync");
        let output = tenant(&mut initdb).output().unwrap();
        assert!(
            output.status.success(),
            "initdb: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let volume_bytes = lab.lv(id).unwrap().size_bytes;
        let conf = crate::settings::postgresql_conf(&crate::settings::Settings {
            socket_directory: &socket,
            memory_mib: 256,
            volume_bytes,
            max_connections: 20,
            archive_timeout_seconds: 60,
            archive_command: None,
        })
        .unwrap();
        fs::write(data.join("postgresql.conf"), conf).unwrap();
        fs::write(data.join("pg_hba.conf"), "local all all trust\n").unwrap();
        for file in ["postgresql.conf", "pg_hba.conf"] {
            chown(data.join(file), Some(TENANT), Some(TENANT)).unwrap();
        }
        let mut pg = TenantPg {
            data,
            socket,
            bin,
            child: None,
        };
        pg.start();
        pg
    }

    fn start(&mut self) {
        let mut postgres = Command::new(self.bin.join("postgres"));
        postgres
            .arg("-D")
            .arg(&self.data)
            .stdout(Stdio::null())
            .stderr(fs::File::create(self.log_path()).unwrap());
        let child = tenant(&mut postgres).spawn().unwrap();
        self.child = Some(child);
        for _ in 0..600 {
            if self.sql("SELECT 1").is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("the postmaster is not ready:\n{}", self.log());
    }

    fn log_path(&self) -> PathBuf {
        self.socket.join("postgres.log")
    }
    fn log(&self) -> String {
        fs::read_to_string(self.log_path()).unwrap_or_default()
    }

    /// One statement as the agent's superuser over the socket: the output, or the error text.
    fn sql(&self, statement: &str) -> Result<String, String> {
        let mut psql = Command::new(self.bin.join("psql"));
        psql.args(["-h"])
            .arg(&self.socket)
            .args([
                "-U",
                "postgres",
                "-X",
                "-q",
                "-t",
                "-A",
                "-v",
                "ON_ERROR_STOP=1",
            ])
            .args(["-d", "postgres", "-c", statement]);
        let output = tenant(&mut psql).output().unwrap();
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    /// A crash: SIGKILL of the postmaster and of what it left, and its System V segment removed.
    fn crash(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let pid_file = fs::read_to_string(self.data.join("postmaster.pid")).unwrap_or_default();
        let _ = Command::new("pkill")
            .args(["-9", "-u", &TENANT.to_string(), "postgres"])
            .output();
        std::thread::sleep(Duration::from_millis(500));
        if let Some(id) = pid_file
            .lines()
            .nth(6)
            .and_then(|line| line.split_whitespace().nth(1))
        {
            let _ = Command::new("ipcrm").args(["-m", id]).output();
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = Command::new("kill")
                .args(["-INT", &child.id().to_string()])
                .status();
            let _ = child.wait();
        }
    }

    /// Inserts rows of `row_bytes` in batches of about 10 MB until a statement fails: the number
    /// of rows that were acknowledged, and the error that ended it. The table has a primary key
    /// when `indexed`.
    fn fill(&self, table: &str, row_bytes: u64, indexed: bool) -> (u64, String) {
        let key = if indexed { " PRIMARY KEY" } else { "" };
        self.sql(&format!(
            "CREATE TABLE IF NOT EXISTS {table}(id bigserial{key}, v text); \
             ALTER TABLE {table} ALTER v SET STORAGE PLAIN"
        ))
        .unwrap();
        let batch = 10_000_000 / row_bytes;
        let mut rows = 0;
        loop {
            match self.sql(&format!(
                "INSERT INTO {table}(v) SELECT repeat('x', {row_bytes}) FROM generate_series(1, {batch})"
            )) {
                Ok(_) => rows += batch,
                Err(error) => return (rows, error),
            }
        }
    }
}

impl Drop for TenantPg {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Runs the command as the tenant's user, as PostgreSQL's unit does.
fn tenant(command: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    command
        .uid(TENANT)
        .gid(TENANT)
        .env_clear()
        .env("HOME", "/tmp")
        .env("PATH", "/usr/bin:/bin")
        .current_dir("/")
}

/// An older filesystem with resize_inode and an 8 MiB journal grows safely offline.
#[test]
fn an_older_filesystem_grows_offline_without_losing_data() {
    let lab = Lab::open_with(3072, |config| config.logical_cap_factor = 64);
    let a = id(ID, 1);
    let size = 8u64 << 30;
    lab.run(commands::volume_create(lab.config(), &a, size));
    lab.run(
        [
            "mkfs.ext4",
            "-F",
            "-q",
            "-J",
            "size=8",
            "-i",
            "65536",
            "-m",
            "1",
            "-E",
            "lazy_itable_init=0,lazy_journal_init=0",
            &commands::device(lab.config(), &a),
            &format!("{}K", commands::fs_target_kib(size)),
        ]
        .map(String::from)
        .to_vec(),
    );
    lab.run(commands::volumes_add_tag(
        lab.config(),
        slice::from_ref(&a),
        FS_TAG,
    ));
    lab.storage.changed_elsewhere();
    lab.storage.mount_volume(&a).unwrap();
    assert!(
        !host::read_superblock(&commands::device(lab.config(), &a))
            .unwrap()
            .online_grow()
    );
    fs::write(lab.dir_of(&a).join("acknowledged"), b"committed data").unwrap();
    let holder = lab.unit_holding(&a);
    assert!(matches!(
        lab.storage.grow_volume(&a, 9 << 30),
        Err(Error::OfflineGrowRequired)
    ));
    assert_eq!(lab.lv(&a).unwrap().size_bytes, size);
    assert!(lab.linked_to_the_mounted_volume(&a));
    drop(holder);
    lab.storage.grow_volume(&a, 9 << 30).unwrap();
    assert_eq!(
        filesystem_bytes(&lab, &a),
        (9 << 30) - commands::FS_END_GAP_BYTES
    );
    assert_eq!(
        fs::read(lab.dir_of(&a).join("acknowledged")).unwrap(),
        b"committed data"
    );
    assert!(lab.linked_to_the_mounted_volume(&a));
    lab.storage.grow_volume(&a, 9 << 30).unwrap();
}

/// A volume made as the agent makes it grows online under a running PostgreSQL, from the least the
/// API creates to a terabyte in one call, and in steps from the class size, at every size: the
/// filesystem has the size at each end, `resize2fs` is never refused, the database keeps taking
/// writes.
#[test]
fn a_volume_grows_online_under_a_running_postgresql_in_one_call_and_in_steps() {
    // The sold storage of the lab is far over its pool: the logical cap is lifted.
    let lab = Lab::open_with(3072, |config| config.logical_cap_factor = 1 << 20);
    let (one_call, steps) = (id(ID, 1), id(OTHER, 1));
    let gap = commands::FS_END_GAP_BYTES;
    for (volume, start_gib) in [(&one_call, 1u64), (&steps, 2u64)] {
        lab.storage
            .create_volume(volume, start_gib << 30, &policy())
            .unwrap();
        chown(lab.dir_of(volume), Some(TENANT), Some(TENANT)).unwrap();
    }
    let started = lab.pool_used();
    let mut pg = TenantPg::new(&lab, &one_call);
    pg.sql("CREATE TABLE written(id bigserial primary key, v text)")
        .unwrap();
    let write = |pg: &TenantPg, rows: u64| {
        pg.sql(&format!(
            "INSERT INTO written(v) SELECT repeat('w', 500) FROM generate_series(1, {rows})"
        ))
        .unwrap();
    };
    write(&pg, 20_000);
    let tib = 1u64 << 40;
    lab.storage.grow_volume(&one_call, tib).unwrap();
    assert_eq!(filesystem_bytes(&lab, &one_call), tib - gap);
    write(&pg, 20_000);
    assert_eq!(pg.sql("SELECT count(*) FROM written").unwrap(), "40000");
    // The checkpoint and a restart work on the grown filesystem.
    pg.sql("CHECKPOINT").unwrap();
    pg.stop();
    pg.start();
    assert_eq!(pg.sql("SELECT count(*) FROM written").unwrap(), "40000");
    sh("sync", &[]);
    eprintln!(
        "pool used by 1 GiB grown to 1 TiB in one call, with 40,000 rows of 500 bytes: {} MiB",
        (lab.pool_used() - started) >> 20
    );
    drop(pg);
    lab.storage.unmount_volume(&one_call).unwrap();

    let pg = TenantPg::new(&lab, &steps);
    pg.sql("CREATE TABLE written(id bigserial primary key, v text)")
        .unwrap();
    let mut size_gib = 2u64;
    for next in [3u64, 6, 25, 50, 100, 250, 1024] {
        write(&pg, 5_000);
        lab.storage.grow_volume(&steps, next << 30).unwrap();
        assert_eq!(
            filesystem_bytes(&lab, &steps),
            (next << 30) - gap,
            "{next} GiB"
        );
        size_gib = next;
    }
    assert_eq!(size_gib, 1024);
    write(&pg, 5_000);
    assert_eq!(pg.sql("SELECT count(*) FROM written").unwrap(), "40000");
    assert!(!pg.log().contains("PANIC"), "{}", pg.log());
    drop(pg);
    lab.storage.unmount_volume(&steps).unwrap();

    // A volume born large is the one that failed (US1, 25 GiB to 50 GiB: 1,030 credits asked of a
    // journal that allows 678 or fewer): it has no reserved descriptors to pay for.
    let large = id(THIRD, 1);
    lab.storage
        .create_volume(&large, 25 << 30, &policy())
        .unwrap();
    chown(lab.dir_of(&large), Some(TENANT), Some(TENANT)).unwrap();
    for next in [50u64, 80, 400, 4096] {
        lab.storage.grow_volume(&large, next << 30).unwrap();
        assert_eq!(
            filesystem_bytes(&lab, &large),
            (next << 30) - gap,
            "{next} GiB"
        );
    }
}

/// No quota reservation: a full tenant filesystem recovers by the explicitly requested grow.
#[test]
fn a_full_postgres_volume_recovers_by_growth_with_acknowledged_rows_intact() {
    let lab = Lab::open(2048);
    let a = id(ID, 1);
    lab.create(&a, 256);
    let mut pg = TenantPg::new(&lab, &a);
    let (rows, error) = pg.fill("acknowledged", 2000, true);
    assert!(rows > 0, "{error}");
    let full = lab.volume(&a).mount.unwrap().usage;
    assert!(full.space_percent() >= 90, "{full:?}: {error}");
    assert_eq!(full.space_alert(), Some(Alert::Critical));
    pg.crash();
    lab.storage.grow_volume(&a, 512 << 20).unwrap();
    pg.start();
    assert_eq!(
        pg.sql(&format!(
            "SELECT count(*) FROM acknowledged WHERE id <= {rows}"
        ))
        .unwrap(),
        rows.to_string()
    );
    pg.sql("INSERT INTO acknowledged(v) VALUES ('after grow'); CHECKPOINT")
        .unwrap();
    assert!(!pg.log().contains("PANIC"), "{}", pg.log());
}

#[test]
fn inode_exhaustion_is_observed_and_growth_adds_usable_inodes() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    let directory = lab.dir_of(&a).join("inodes");
    fs::create_dir(&directory).unwrap();
    let mut count = 0u64;
    loop {
        match fs::File::create(directory.join(count.to_string())) {
            Ok(_) => count += 1,
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(libc::ENOSPC));
                break;
            }
        }
    }
    let full = lab.volume(&a).mount.unwrap().usage;
    assert_eq!(full.inode_alert(), Some(Alert::Critical));
    assert_eq!(full.inodes_used, full.inodes_total);
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    let grown = lab.volume(&a).mount.unwrap().usage;
    assert!(grown.inodes_total > full.inodes_total);
    fs::File::create(directory.join("after-grow")).unwrap();
}
