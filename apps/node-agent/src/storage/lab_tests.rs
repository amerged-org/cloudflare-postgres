// SPDX-License-Identifier: Apache-2.0
//! `Storage` against real LVM, ext4 and the kernel's mount API on loop devices. They change the
//! machine, so they run only in a privileged Linux container with lvm2, thin-provisioning-tools,
//! e2fsprogs and util-linux, one at a time, and exist only in a build made for them. The kernel
//! step of CI runs every ignored test in an unprivileged container and must not meet them:
//! `RUSTFLAGS='--cfg pgcf_storage_lab' cargo test -p pgcf-node-agent --lib -- --test-threads=1 storage::lab_tests`
use super::{
    commands::{self, FS_TAG, RESERVE_FREED_TAG},
    lvm::{self, LogicalVolume},
    mountinfo,
    usage::WAL_SEGMENT_BYTES,
    *,
};
use std::{
    fs,
    os::unix::fs::{MetadataExt, chown},
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
        let config = Config {
            device: loop_device.clone().into(),
            group: name,
            mount_root: dir.join("db"),
            device_links: dir.join("run/dev"),
            pool_metadata_bytes: 8 << 20,
            ..Config::default()
        };
        Lab {
            dir,
            loop_device,
            storage: Storage::new(SystemRunner, config),
        }
    }
    /// A lab with the pool made.
    fn open(disk_mib: u64) -> Lab {
        let lab = Lab::new(disk_mib);
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
    fn pool_used(&self) -> u64 {
        sh("sync", &[]);
        self.storage.poll_pool().unwrap().data_used_bytes
    }
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
    assert!(volume.formatted && !volume.reserve_released);
    let mount = volume.mount.unwrap();
    assert!(!mount.fs_errors);
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
    // Its journal holds transactions whose flag was lost: `e2fsck -p` alone refuses (4).
    let output = SystemRunner.run(&commands::fsck(lab.config(), &a)).unwrap();
    assert_eq!(output.code, 4, "{}", output.stderr);

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

#[test]
fn a_full_volume_gets_its_reserve_freed_after_its_database_failed_and_back_on_growth_or_when_use_drops()
 {
    let lab = Lab::open(512);
    let a = id(ID, 1);
    lab.create(&a, 64);
    let reserved = |lab: &Lab| -> u64 {
        sh("tune2fs", &["-l", &commands::device(lab.config(), &a)])
            .lines()
            .find_map(|l| l.strip_prefix("Reserved block count:"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    };
    let at_one_percent = reserved(&lab);
    assert!(at_one_percent > 0);

    assert!(!lab.tenant_dd(&a, "fill", 102400, "/dev/zero"));
    let usage = lab.volume(&a).mount.unwrap().usage;
    assert!(usage.available_bytes < WAL_SEGMENT_BYTES, "{usage:?}");
    // The database still runs: its tenant would spend the reserve.
    assert_eq!(
        lab.storage.set_reserve(&a, false).unwrap(),
        ReserveAction::Keep
    );
    assert_eq!(reserved(&lab), at_one_percent);
    // It stopped on the failed write: the crash recovery and the deletes of the tenant have room.
    assert_eq!(
        lab.storage.set_reserve(&a, true).unwrap(),
        ReserveAction::Release
    );
    assert!(lab.lv(&a).unwrap().has_tag(RESERVE_FREED_TAG));
    assert!(lab.volume(&a).reserve_released);
    assert_eq!(reserved(&lab), 0);
    assert!(lab.tenant_dd(&a, "room", 256, "/dev/zero"));

    // Growing the volume gives it room: the reserve goes back, 1 % of the larger filesystem.
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert!(!lab.lv(&a).unwrap().has_tag(RESERVE_FREED_TAG));
    let grown = reserved(&lab);
    assert!(grown > at_one_percent);

    // Full again and freed again; deleting data gives it back as well.
    assert!(!lab.tenant_dd(&a, "fill2", 262144, "/dev/zero"));
    assert_eq!(
        lab.storage.set_reserve(&a, true).unwrap(),
        ReserveAction::Release
    );
    assert_eq!(reserved(&lab), 0);
    for file in ["fill", "fill2", "room"] {
        fs::remove_file(lab.dir_of(&a).join(file)).unwrap();
    }
    assert_eq!(
        lab.storage.set_reserve(&a, false).unwrap(),
        ReserveAction::Restore
    );
    assert!(!lab.lv(&a).unwrap().has_tag(RESERVE_FREED_TAG));
    assert_eq!(reserved(&lab), grown);
    assert_eq!(
        lab.storage.set_reserve(&a, false).unwrap(),
        ReserveAction::Keep
    );
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

/// The databases' units and jobs mount a volume through systemd's image dissection, whose libblkid
/// probers read the last blocks of the device as root: nothing a tenant writes may reach them.
#[test]
fn a_filesystem_ends_one_mib_before_its_volume_when_made_and_when_grown_and_the_tail_stays_zero() {
    let lab = Lab::open(1024);
    let a = id(ID, 1);
    lab.create(&a, 128);
    let gap = commands::FS_END_GAP_BYTES;
    assert_eq!(filesystem_bytes(&lab, &a), (128 << 20) - gap);
    // The tenant fills everything its filesystem has, with data of any kind.
    assert!(!lab.tenant_dd(&a, "fill", 131072, "/dev/urandom"));
    assert!(device_tail(&lab, &a, 1).iter().all(|byte| *byte == 0));
    // Growing keeps the gap at the new end, and the same call again changes nothing.
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (256 << 20) - gap);
    lab.storage.grow_volume(&a, 256 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (256 << 20) - gap);
    assert!(!lab.tenant_dd(&a, "fill2", 262144, "/dev/urandom"));
    assert!(device_tail(&lab, &a, 1).iter().all(|byte| *byte == 0));
    // A volume that sleeps unmounted is mounted to grow, and ends the same way.
    lab.storage.unmount_volume(&a).unwrap();
    lab.storage.grow_volume(&a, 512 << 20).unwrap();
    assert_eq!(filesystem_bytes(&lab, &a), (512 << 20) - gap);
}

/// The unit mounts its volume from `<device_links>/<id>` as root (`MountImages=`), so the link
/// names the device of the attached generation and exists only while the agent has it attached.
#[test]
fn a_database_has_a_device_link_exactly_while_its_volume_is_attached() {
    let lab = Lab::open(1024);
    let (g1, g2) = (id(ID, 1), id(ID, 2));
    assert!(lab.link(&g1).is_none());
    lab.create(&g1, 128);
    assert!(lab.linked_to_the_mounted_volume(&g1));
    // The directory is root's alone: the root executor follows what is in it.
    let links = fs::metadata(&lab.config().device_links).unwrap();
    assert_eq!((links.uid(), links.mode() & 0o7777), (0, 0o700));
    // The link is made again for a volume that is mounted already, and never staged visibly.
    lab.storage.mount_volume(&g1).unwrap();
    assert_eq!(fs::read_dir(&lab.config().device_links).unwrap().count(), 1);

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

/// A wake needs its own volume mounted, and a node with many volumes mounts them for seconds
/// after its agent starts: the wake waits for one mount of the batch, not for all of them.
#[test]
fn a_wake_mounts_its_own_volume_while_the_batch_is_still_running() {
    let lab = Lab::open(3072);
    let ids: Vec<VolumeId> = (0..40)
        .map(|n| id(&format!("a1b2c3d4e5f6g7h8i{n:03}"), 1))
        .collect();
    for volume in &ids {
        lab.create(volume, 32);
        lab.storage.unmount_volume(volume).unwrap();
    }
    let (first, last) = (ids[0].clone(), ids[ids.len() - 1].clone());
    let storage = &lab.storage;
    let (batch_ended, wake_ended) = std::thread::scope(|scope| {
        let batch = scope.spawn(|| {
            assert!(storage.mount_all(&ids).unwrap().is_empty());
            std::time::Instant::now()
        });
        // The batch has begun when its first volume is mounted.
        while !lab.mounted(&first) {
            std::thread::yield_now();
        }
        storage.mount_volume(&last).unwrap();
        let wake_ended = std::time::Instant::now();
        (batch.join().unwrap(), wake_ended)
    });
    assert!(
        wake_ended < batch_ended,
        "the wake's mount waited for the whole batch"
    );
    assert!(
        ids.iter()
            .all(|volume| lab.linked_to_the_mounted_volume(volume))
    );
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
