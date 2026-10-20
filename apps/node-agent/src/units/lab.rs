// SPDX-License-Identifier: Apache-2.0
//! The units against a real systemd and a real PostgreSQL 18. They run as root on a Debian 13 host
//! with systemd as PID 1, the image's `pgcf-pg@.service`, `pgcf.slice` and the masks of
//! `modprobe@loop`, `@dm_mod` and `@dm_verity`, a group `pgcf-gateway`, PGDG PostgreSQL 18 and
//! `useradd`, with `--ignored`; the CI kernel step has no systemd and skips them. They create
//! users, a device-mapper volume with an ext4 and a database, and remove them again.
//!
//! Run the test binary under `unshare --mount --propagation slave`: as the agent does under
//! `PrivateMounts=yes`, it then mounts the volumes in a namespace of its own, which PID 1 and the
//! executors of the units never see, and the units mount their volumes themselves from the link
//! `/run/pgcf/dev/<id>` (`MountImages=`). A host without udev (a container) has no `/dev/dm-<n>`
//! nodes, which systemd's image dissection needs: the lab makes them as udev does.
use super::{
    ActiveState, DB_ROOT, Error, READS_IN_FLIGHT, Units,
    limits::{Io, Limits},
    unit_name,
    users::Users,
};
use std::{
    fs,
    num::NonZeroU32,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use zbus::proxy::CacheProperties;

const BIN: &str = "/usr/lib/postgresql/18/bin";

fn run(program: &str, args: &[&str]) {
    let output = Command::new(program).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Whether this host can run the lab: systemd is PID 1.
fn lab() -> bool {
    if Path::new("/run/systemd/system").is_dir() {
        return true;
    }
    eprintln!("skipped: systemd is not PID 1 on this host");
    false
}

/// One database's volume, user and socket directory, and everything removed again.
pub(crate) struct Database {
    pub(crate) id: String,
    pub(crate) uid: u32,
    pub(crate) root: PathBuf,
    users_dir: PathBuf,
    /// The volume: a loop device under an image file, a device-mapper device over it.
    pub(crate) volume: Volume,
}

/// A block device for a database's filesystem, removed with the value.
pub(crate) struct Volume {
    image: PathBuf,
    loop_device: String,
    mapper: String,
}
impl Volume {
    /// The device-mapper node a unit's link names, like a thin volume of the node.
    pub(crate) fn device(&self) -> String {
        format!("/dev/mapper/{}", self.mapper)
    }
    fn make(id: &str) -> Self {
        let image = PathBuf::from(format!("/var/tmp/{id}.img"));
        fs::File::create(&image)
            .unwrap()
            .set_len(128 << 20)
            .unwrap();
        let loop_device = String::from_utf8(
            Command::new("losetup")
                .args(["-f", "--show", image.to_str().unwrap()])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        if !Path::new(&loop_device).exists() {
            let number = loop_device.trim_start_matches("/dev/loop");
            run("mknod", &[&loop_device, "b", "7", number]);
        }
        let mapper = format!("pgcflab-{id}");
        let sectors = (128u64 << 20) / 512;
        run(
            "dmsetup",
            &[
                "create",
                "--noudevsync",
                &mapper,
                "--table",
                &format!("0 {sectors} linear {loop_device} 0"),
            ],
        );
        run("dmsetup", &["mknodes", &mapper]);
        // What udev does on a node: the `/dev/dm-<minor>` node that systemd's dissection reads
        // its device number through.
        let info = Command::new("dmsetup")
            .args(["info", "-c", "--noheadings", "-o", "major,minor", &mapper])
            .output()
            .unwrap();
        let info = String::from_utf8(info.stdout).unwrap();
        let (major, minor) = info.trim().split_once(':').unwrap();
        let node = format!("/dev/dm-{minor}");
        if !Path::new(&node).exists() {
            run("mknod", &[&node, "b", major, minor]);
        }
        // Shorter than the device by the gap, as the agent makes every filesystem.
        run(
            "mkfs.ext4",
            &[
                "-F",
                "-q",
                &format!("/dev/mapper/{mapper}"),
                &format!(
                    "{}K",
                    ((128u64 << 20) - crate::storage::FS_END_GAP_BYTES) / 1024
                ),
            ],
        );
        Self {
            image,
            loop_device,
            mapper,
        }
    }
}
impl Drop for Volume {
    fn drop(&mut self) {
        quiet("dmsetup", &["remove", "--retry", &self.mapper]);
        quiet("losetup", &["-d", &self.loop_device]);
        let _ = fs::remove_file(&self.image);
    }
}

/// The link of the agent: `/run/pgcf/dev/<id>`, in a directory of root's alone.
fn link_path(id: &str) -> PathBuf {
    Path::new(crate::units::DEVICE_LINKS).join(id)
}
fn link_to(id: &str, device: &str) {
    use std::os::unix::fs::DirBuilderExt;
    let directory = Path::new(crate::units::DEVICE_LINKS);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)
        .unwrap();
    let _ = fs::remove_file(link_path(id));
    std::os::unix::fs::symlink(device, link_path(id)).unwrap();
}
impl Database {
    pub(crate) fn new(n: u32) -> Self {
        let id = format!("lab{n:017}");
        let users_dir = super::test_dir("lab-users");
        fs::create_dir_all(&users_dir).unwrap();
        let uid = Users::load(users_dir.join("uids.json"))
            .unwrap()
            .allocate(&id)
            .unwrap();
        let account = super::users::account_name(&id);
        let (uid_text, root) = (uid.to_string(), Path::new(DB_ROOT).join(&id));
        run("groupadd", &["-g", &uid_text, &account]);
        run(
            "useradd",
            &[
                "-u",
                &uid_text,
                "-g",
                &account,
                "-M",
                "-s",
                "/usr/sbin/nologin",
                "-d",
                "/nonexistent",
                &account,
            ],
        );
        fs::create_dir_all(&root).unwrap();
        let volume = Volume::make(&id);
        // The agent's mount, in the agent's namespace; the unit mounts the volume again itself.
        run(
            "mount",
            &[
                "-t",
                "ext4",
                "-o",
                "nosuid,nodev,noexec,noatime",
                &volume.device(),
                root.to_str().unwrap(),
            ],
        );
        run("chmod", &["0700", root.to_str().unwrap()]);
        run("chown", &[&account, root.to_str().unwrap()]);
        let sockets = format!("/run/pgcf/{id}");
        fs::create_dir_all(&sockets).unwrap();
        run("chown", &[&format!("{account}:pgcf-gateway"), &sockets]);
        run("chmod", &["0750", &sockets]);
        run(
            "runuser",
            &[
                "-u",
                &account,
                "--",
                &format!("{BIN}/initdb"),
                "-D",
                root.join("data").to_str().unwrap(),
                "-A",
                "trust",
                "--no-sync",
                "-E",
                "UTF8",
                "--locale=C.UTF-8",
            ],
        );
        // The unit's memory-deny-write-execute needs the JIT off.
        let mut configuration = fs::read_to_string(root.join("data/postgresql.conf")).unwrap();
        configuration.push_str("\njit = off\n");
        fs::write(root.join("data/postgresql.conf"), configuration).unwrap();
        link_to(&id, &volume.device());
        Self {
            id,
            uid,
            root,
            users_dir,
            volume,
        }
    }
    fn unit(&self) -> String {
        unit_name(&self.id)
    }
}
/// A command whose failure and output do not matter: the cleanup of what may not exist.
fn quiet(program: &str, args: &[&str]) {
    let _ = Command::new(program).args(args).output();
}

impl Drop for Database {
    fn drop(&mut self) {
        let unit = self.unit();
        quiet("systemctl", &["stop", &unit]);
        quiet("systemctl", &["reset-failed", &unit]);
        let _ = fs::remove_file(link_path(&self.id));
        quiet("umount", &[self.root.to_str().unwrap()]);
        let _ = fs::remove_dir(&self.root);
        let _ = fs::remove_dir_all(format!("/run/pgcf/{}", self.id));
        for directory in ["/etc/systemd/system.control", "/run/systemd/system.control"] {
            let _ = fs::remove_dir_all(format!("{directory}/{unit}.d"));
        }
        let _ = fs::remove_dir_all(format!("/run/systemd/system/{unit}.d"));
        let account = super::users::account_name(&self.id);
        quiet("userdel", &[&account]);
        quiet("groupdel", &[&account]);
        let _ = fs::remove_dir_all(&self.users_dir);
        quiet("systemctl", &["daemon-reload"]);
    }
}

/// The cgroup directory of a running process.
fn cgroup_of(pid: u32) -> PathBuf {
    let text = fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let path = text.trim().strip_prefix("0::").expect("cgroup v2");
    Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/'))
}
fn cgroup_file(pid: u32, name: &str) -> String {
    fs::read_to_string(cgroup_of(pid).join(name))
        .unwrap()
        .trim()
        .to_string()
}

fn limits(memory_mib: u64, cpu_millicores: u32) -> Limits {
    Limits {
        memory_mib,
        cpu_millicores,
        tasks_max: 64,
        io: None,
    }
}

/// A start without the time the agent asked for it, which differs between two asks of one unit.
fn same_unit(started: super::Started) -> super::Started {
    super::Started {
        requested_us: None,
        ..started
    }
}

async fn within<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("the call took more than a minute")
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_database_unit_starts_serves_changes_its_limits_and_stops() {
    if !lab() {
        return;
    }
    let database = Database::new(1);
    let id = database.id.as_str();
    let units = Units::connect(DB_ROOT).await.unwrap();
    // A unit that never started is not loaded, and is inactive: the read does not load it.
    let idle = units.state(id).await.unwrap();
    assert_eq!(idle.active, ActiveState::Inactive);
    assert_eq!(
        (
            idle.main_pid,
            idle.invocation_id,
            idle.uid,
            idle.memory_max_bytes
        ),
        (None, None, None, None)
    );
    assert!(loaded(&database.unit()).is_empty());

    // Limits before the first start, persistent and without a reload.
    units.set_limits(id, &limits(256, 500)).await.unwrap();
    assert!(
        Path::new(&format!(
            "/etc/systemd/system.control/{}.d/50-MemoryMax.conf",
            database.unit()
        ))
        .is_file()
    );

    let started = within(units.start(id)).await.unwrap();
    assert_eq!(started.uid, database.uid);
    assert_eq!(
        started.socket,
        Path::new("/run/pgcf").join(id).join(".s.PGSQL.5432")
    );
    assert!(std::os::unix::net::UnixStream::connect(&started.socket).is_ok());
    assert_eq!(
        fs::read_to_string(format!("/proc/{}/comm", started.main_pid))
            .unwrap()
            .trim(),
        "postgres",
        "the unit's main process is the postmaster"
    );
    assert_eq!(started.invocation_id.len(), 36);

    // The state reads what the start returned, with the limit the agent set.
    let state = units.state(id).await.unwrap();
    assert_eq!(state.active, ActiveState::Active);
    assert_eq!(state.main_pid, Some(started.main_pid));
    assert_eq!(
        state.invocation_id.as_deref(),
        Some(started.invocation_id.as_str())
    );
    assert_eq!(state.uid, Some(database.uid));
    assert_eq!(state.memory_max_bytes, Some(256 << 20));
    let running = units.running().await.unwrap();
    assert!(running.contains(&state), "{running:?}");

    // A start of a running unit finds it running.
    assert_eq!(
        same_unit(within(units.start(id)).await.unwrap()),
        same_unit(started.clone())
    );

    // Live limits, without a restart and without a reload.
    assert_eq!(cgroup_file(started.main_pid, "cpu.max"), "max 100000");
    units.set_cpu_quota(id, NonZeroU32::new(500)).await.unwrap();
    assert_eq!(cgroup_file(started.main_pid, "cpu.max"), "50000 100000");
    units.set_limits(id, &limits(512, 500)).await.unwrap();
    assert_eq!(
        cgroup_file(started.main_pid, "memory.max"),
        (512u64 << 20).to_string()
    );
    assert_eq!(
        cgroup_file(started.main_pid, "memory.high"),
        (460u64 << 20).to_string()
    );
    assert_eq!(cgroup_file(started.main_pid, "cpu.weight"), "50");
    assert_eq!(cgroup_file(started.main_pid, "memory.swap.max"), "0");
    assert_eq!(cgroup_file(started.main_pid, "pids.max"), "64");

    // A stop waits for the shutdown and lifts the quota, which would outlive it.
    within(units.stop(id)).await.unwrap();
    assert!(!Path::new(&format!("/proc/{}", started.main_pid)).exists());
    let after = units.state(id).await.unwrap();
    assert_eq!(after.active, ActiveState::Inactive);
    assert_eq!((after.main_pid, after.uid), (None, None));
    let dropin = fs::read_to_string(format!(
        "/run/systemd/system.control/{}.d/50-CPUQuota.conf",
        database.unit()
    ))
    .unwrap();
    assert!(dropin.contains("\nCPUQuota=\n"), "{dropin}");
    within(units.stop(id)).await.unwrap();

    // The next start has no quota and is a new invocation of the same limits.
    let again = within(units.start(id)).await.unwrap();
    assert_eq!(cgroup_file(again.main_pid, "cpu.max"), "max 100000");
    assert_eq!(
        cgroup_file(again.main_pid, "memory.max"),
        (512u64 << 20).to_string()
    );
    assert_ne!(again.invocation_id, started.invocation_id);
    assert_ne!(again.main_pid, started.main_pid);
    within(units.stop(id)).await.unwrap();
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_start_has_a_timeline_of_the_fork_the_handoff_and_the_journals_three_messages() {
    if !lab() {
        return;
    }
    let database = Database::new(7);
    let id = database.id.as_str();
    let units = Units::connect(DB_ROOT).await.unwrap();
    let asked = super::monotonic_micros().unwrap();
    let started = within(units.start(id)).await.unwrap();
    let requested = started.requested_us.expect("the clock is read on Linux");
    assert!(requested >= asked && requested - asked < 1_000_000);

    // The fork follows the request within a moment, the handoff (the executor's sandbox done, the
    // execve next) the fork, and journald has the postmaster's three messages shortly after the
    // start; the agent reads them seconds later.
    let mut timeline = units.timeline(id, &started).await.unwrap();
    for _ in 0..100 {
        if timeline.startup.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        timeline = units.timeline(id, &started).await.unwrap();
    }
    // Each gap is a subtraction that gives none when the times are out of order: the request, the
    // fork, the handoff and `starting PostgreSQL` follow each other in that order.
    let job_to_fork = timeline.job_to_fork_us.expect("the fork after the request");
    let fork_to_handoff = timeline
        .fork_to_handoff_us
        .expect("the handoff after the fork");
    assert!(job_to_fork < 5_000_000, "{timeline:?}");
    assert!(fork_to_handoff < 5_000_000, "{timeline:?}");
    let startup = timeline
        .startup
        .expect("the three messages of the start, the first after the handoff");
    for gap in [
        startup.handoff_to_starting_us,
        startup.starting_to_shut_down_us,
        startup.shut_down_to_ready_us,
    ] {
        assert!(gap < 10_000_000, "{timeline:?}");
    }

    // The unit started again: the fork and handoff times and the journal are the new invocation's,
    // not this start's.
    within(units.stop(id)).await.unwrap();
    let again = within(units.start(id)).await.unwrap();
    assert_ne!(again.invocation_id, started.invocation_id);
    assert_eq!(
        units.timeline(id, &started).await.unwrap(),
        super::Timeline::default()
    );
    // And the cgroup of the running unit counts its throttling, which the sample parses.
    let throttle =
        crate::sample::throttle(&fs::read_to_string(super::cpu_stat_path(id).unwrap()).unwrap());
    assert_eq!(
        throttle.map(|t| t.nr_throttled),
        Some(0),
        "no quota, no throttling"
    );
    within(units.stop(id)).await.unwrap();
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_unit_that_is_still_starting_is_waited_for() {
    if !lab() {
        return;
    }
    let database = Database::new(2);
    let id = database.id.as_str();
    let units = Units::connect(DB_ROOT).await.unwrap();
    // A start that takes two seconds more, so the unit is seen activating.
    let dropin = format!("/run/systemd/system/{}.d", database.unit());
    fs::create_dir_all(&dropin).unwrap();
    fs::write(
        format!("{dropin}/slow.conf"),
        "[Service]\nExecStartPre=/bin/sleep 2\n",
    )
    .unwrap();
    run("systemctl", &["daemon-reload"]);
    run("systemctl", &["start", "--no-block", &database.unit()]);
    let mut seen = ActiveState::Inactive;
    for _ in 0..100 {
        seen = units.state(id).await.unwrap().active;
        if seen == ActiveState::Activating {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(seen, ActiveState::Activating);
    // A start of a unit that is starting joins the start under way: both see the same unit.
    let (waited, joined) = tokio::join!(within(units.wait_started(id)), within(units.start(id)),);
    let started = waited.unwrap();
    assert_eq!(same_unit(joined.unwrap()), same_unit(started.clone()));
    assert_eq!(started.uid, database.uid);
    assert_eq!(
        units.state(id).await.unwrap().main_pid,
        Some(started.main_pid)
    );
    // A unit that is not starting is not waited for.
    within(units.stop(id)).await.unwrap();
    assert!(matches!(
        units.wait_started(id).await,
        Err(Error::NotReady("unit_not_active"))
    ));
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_stop_replaces_a_start_that_is_under_way() {
    if !lab() {
        return;
    }
    let database = Database::new(5);
    let id = database.id.clone();
    let units = Units::connect(DB_ROOT).await.unwrap();
    let dropin = format!("/run/systemd/system/{}.d", database.unit());
    fs::create_dir_all(&dropin).unwrap();
    fs::write(
        format!("{dropin}/slow.conf"),
        "[Service]\nExecStartPre=/bin/sleep 5\n",
    )
    .unwrap();
    run("systemctl", &["daemon-reload"]);
    let starting = tokio::spawn({
        let (units, id) = (units.clone(), id.clone());
        async move { units.start(&id).await }
    });
    for _ in 0..100 {
        if units.state(&id).await.unwrap().active == ActiveState::Activating {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    within(units.stop(&id)).await.unwrap();
    // The aborted start leaves the unit failed or inactive, either way not awake.
    let after = units.state(&id).await.unwrap();
    assert!(!after.active.awake(), "{after:?}");
    let error = within(starting).await.unwrap().unwrap_err();
    assert!(
        matches!(&error, Error::Job { result, .. } if result == "canceled"),
        "{error:?}"
    );
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_start_that_fails_names_the_jobs_result() {
    if !lab() {
        return;
    }
    let database = Database::new(3);
    let units = Units::connect(DB_ROOT).await.unwrap();
    // The image's unit asserts that the agent's link exists: a volume the agent has not attached,
    // or has taken away, is not started on, and nothing runs on its empty mount point.
    let mut failed = Vec::new();
    for link in ["none", "dangling"] {
        let _ = fs::remove_file(link_path(&database.id));
        if link == "dangling" {
            std::os::unix::fs::symlink("/dev/mapper/pgcflab-gone", link_path(&database.id))
                .unwrap();
        }
        let error = within(units.start(&database.id)).await.unwrap_err();
        assert!(
            matches!(&error, Error::Job { unit, result } if *unit == database.unit() && result == "assert"),
            "{link}: {error:?}"
        );
        assert!(!units.state(&database.id).await.unwrap().active.awake());
        failed.push(link);
    }
    assert_eq!(failed, ["none", "dangling"]);
    assert!(matches!(
        units.start("not a database").await,
        Err(Error::InvalidDatabase)
    ));
    // The link back, and the unit starts again from it.
    link_to(&database.id, &database.volume.device());
    within(units.start(&database.id)).await.unwrap();
    within(units.stop(&database.id)).await.unwrap();
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn write_limits_of_a_device_are_accepted() {
    if !lab() {
        return;
    }
    let database = Database::new(4);
    let units = Units::connect(DB_ROOT).await.unwrap();
    // The io controller limits block devices; the node's volumes are thin LVs under /dev/mapper.
    let device = Command::new("losetup").arg("-f").output().unwrap();
    let device = String::from_utf8(device.stdout).unwrap().trim().to_string();
    assert!(
        device.starts_with("/dev/loop"),
        "no loop device in this lab"
    );
    let mut with_io = limits(256, 500);
    with_io.io = Some(Io::scaled(device.clone(), 16_000_000, 1000, 256));
    units.set_limits(&database.id, &with_io).await.unwrap();
    let properties = Command::new("systemctl")
        .args([
            "show",
            "-p",
            "IOWriteBandwidthMax",
            "-p",
            "IOWriteIOPSMax",
            &database.unit(),
        ])
        .output()
        .unwrap();
    let text = String::from_utf8(properties.stdout).unwrap();
    assert!(text.contains("16000000") && text.contains("1000"), "{text}");
}

/// Whether this process has a mount namespace of its own, as the agent has under
/// `PrivateMounts=yes` (the module's note: run under `unshare --mount --propagation slave`).
fn own_mount_namespace() -> bool {
    let namespace = |pid: &str| fs::read_link(format!("/proc/{pid}/ns/mnt")).unwrap();
    if namespace("self") != namespace("1") {
        return true;
    }
    eprintln!("skipped: the test binary shares PID 1's mount namespace (unshare -m)");
    false
}
/// The lines of a mount table whose mount point is `volume`.
fn mount_lines(pid: &str, volume: &Path) -> Vec<String> {
    fs::read_to_string(format!("/proc/{pid}/mountinfo"))
        .unwrap()
        .lines()
        .filter(|line| line.split(' ').nth(4).map(Path::new) == Some(volume))
        .map(String::from)
        .collect()
}

/// systemd puts the devices that image dissection touches on a unit with `MountImages=` (unit.c,
/// `unit_patch_contexts`), and the unit's `PrivateDevices=yes` closed policy and empty capability
/// set keep the database's user from any of them: the policy is the image's `char-rtc` and these
/// five, and nothing else.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn the_units_device_policy_is_the_image_s_closed_one_and_what_mount_images_adds() {
    if !lab() {
        return;
    }
    let database = Database::new(9);
    let show = |property: &str| {
        let output = Command::new("systemctl")
            .args(["show", "-p", property, "--value", &database.unit()])
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };
    assert_eq!(show("DevicePolicy").trim(), "closed");
    let mut allowed: Vec<String> = show("DeviceAllow")
        .lines()
        .map(String::from)
        .filter(|line| !line.is_empty())
        .collect();
    allowed.sort();
    assert_eq!(
        allowed,
        [
            "/dev/loop-control rw",
            "/dev/mapper/control rw",
            "block-blkext rwm",
            "block-device-mapper rwm",
            "block-loop rwm",
            "char-rtc r",
        ]
    );
    // What neutralises it: no capability to make a device node, and a private /dev.
    assert_eq!(show("CapabilityBoundingSet").trim(), "");
    assert_eq!(show("PrivateDevices").trim(), "yes");
    // The three oneshots that `MountImages=` pulls in are masked, so a start forks none of them.
    for module in ["loop", "dm_mod", "dm_verity"] {
        let output = Command::new("systemctl")
            .args([
                "show",
                "-p",
                "LoadState",
                "--value",
                &format!("modprobe@{module}.service"),
            ])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            "masked",
            "{module}"
        );
    }
}

/// The agent mounts the volume in its own namespace; PID 1 never sees it, and the unit mounts the
/// same filesystem again, so that what either writes the other sees, the agent's resize and
/// fstrim included, and the unit runs on when the agent's mount is gone.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn the_unit_and_the_agent_hold_one_filesystem_each_in_a_namespace_of_its_own() {
    if !lab() || !own_mount_namespace() {
        return;
    }
    let database = Database::new(8);
    let id = database.id.as_str();
    let units = Units::connect(DB_ROOT).await.unwrap();
    // The agent has the volume, PID 1 has not.
    assert_eq!(mount_lines("self", &database.root).len(), 1);
    assert!(mount_lines("1", &database.root).is_empty());
    let started = within(units.start(id)).await.unwrap();
    assert!(mount_lines("1", &database.root).is_empty());
    let pid = started.main_pid.to_string();
    let unit_mount = mount_lines(&pid, &database.root);
    assert_eq!(unit_mount.len(), 1, "{unit_mount:?}");
    assert!(
        unit_mount[0].contains(" rw,nosuid,nodev,noexec,noatime "),
        "{unit_mount:?}"
    );
    assert!(!unit_mount[0].contains(" ro,"), "{unit_mount:?}");
    let seen_by_unit =
        |name: &str| Path::new(&format!("/proc/{pid}/root/var/lib/pgcf/db/{id}")).join(name);

    // One superblock: each side sees what the other writes at once.
    fs::write(database.root.join("agent-wrote"), "a").unwrap();
    assert_eq!(
        fs::read_to_string(seen_by_unit("agent-wrote")).unwrap(),
        "a"
    );
    fs::write(seen_by_unit("unit-wrote"), "u").unwrap();
    assert_eq!(
        fs::read_to_string(database.root.join("unit-wrote")).unwrap(),
        "u"
    );

    // The agent grows the device and the filesystem while the unit runs: both see it.
    let blocks = |path: &Path| {
        let output = Command::new("stat")
            .args(["-f", "-c", "%b", path.to_str().unwrap()])
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse::<u64>()
            .unwrap()
    };
    let before = blocks(&database.root);
    let bigger = 192u64 << 20;
    fs::OpenOptions::new()
        .write(true)
        .open(&database.volume.image)
        .unwrap()
        .set_len(bigger)
        .unwrap();
    run("losetup", &["-c", &database.volume.loop_device]);
    run("dmsetup", &["suspend", &database.volume.mapper]);
    run(
        "dmsetup",
        &[
            "reload",
            &database.volume.mapper,
            "--table",
            &format!(
                "0 {} linear {} 0",
                bigger / 512,
                database.volume.loop_device
            ),
        ],
    );
    run("dmsetup", &["resume", &database.volume.mapper]);
    run(
        "resize2fs",
        &[
            &database.volume.device(),
            &format!("{}K", (bigger - crate::storage::FS_END_GAP_BYTES) / 1024),
        ],
    );
    assert!(blocks(&database.root) > before);
    assert_eq!(blocks(&database.root), blocks(&seen_by_unit("")));
    // fstrim from the agent's namespace reaches the filesystem the unit has mounted as well.
    run("fstrim", &[database.root.to_str().unwrap()]);

    // The agent's namespace ends (an agent restart): the unit has its own mount and runs on.
    run("umount", &[database.root.to_str().unwrap()]);
    assert!(mount_lines("self", &database.root).is_empty());
    assert_eq!(
        units.state(id).await.unwrap().main_pid,
        Some(started.main_pid)
    );
    assert!(std::os::unix::net::UnixStream::connect(&started.socket).is_ok());
    assert!(Path::new(&format!("/proc/{pid}")).exists());
    // A repair is refused while the unit holds the device: e2fsck takes the device exclusively.
    let refused = Command::new("e2fsck")
        .args(["-p", &database.volume.device()])
        .output()
        .unwrap();
    assert_eq!(
        refused.status.code(),
        Some(8),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    within(units.stop(id)).await.unwrap();
    // The unit stopped: the device is free, and the filesystem is clean.
    let repaired = Command::new("e2fsck")
        .args(["-p", &database.volume.device()])
        .output()
        .unwrap();
    assert_eq!(
        repaired.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&repaired.stderr)
    );
    // The agent mounts it again as after its restart, and the data is there.
    run(
        "mount",
        &[
            "-t",
            "ext4",
            "-o",
            "nosuid,nodev,noexec,noatime",
            &database.volume.device(),
            database.root.to_str().unwrap(),
        ],
    );
    assert!(database.root.join("data/PG_VERSION").exists());
    assert_eq!(
        fs::read_to_string(database.root.join("agent-wrote")).unwrap(),
        "a"
    );
}

/// What a database's user sees and may do in the unit's sandbox, as the user: its own volume is
/// writable and the other databases' directories are empty and not writable, nothing else is
/// writable, it has no capability and no network. What the sandbox does not hide, the same as
/// before the unit mounted its volume itself: the ids of the other databases in the device-mapper
/// names of sysfs and in the cgroup tree, and what a neighbour that runs does.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn a_database_user_writes_its_own_volume_and_sees_the_neighbours_only_where_the_kernel_shows_them()
 {
    if !lab() || !own_mount_namespace() {
        return;
    }
    let (own, other) = (Database::new(11), Database::new(12));
    let units = Units::connect(DB_ROOT).await.unwrap();
    within(units.start(&other.id)).await.unwrap();
    let dropin = format!("/run/systemd/system/{}.d", own.unit());
    let _cleanup = scopeguard(|| {
        let _ = fs::remove_dir_all(&dropin);
        let _ = fs::remove_dir_all("/usr/local/lib/pgcf-lab");
        let _ = fs::remove_dir("/srv/ww");
        quiet("systemctl", &["daemon-reload"]);
    });
    // A world-writable directory of the root filesystem: the sandbox's read-only system keeps
    // the user out of it.
    fs::create_dir_all("/srv/ww").unwrap();
    run("chmod", &["1777", "/srv/ww"]);
    let script = Path::new("/usr/local/lib/pgcf-lab/probe.sh");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::write(script, PROBE).unwrap();
    run("chmod", &["0755", script.to_str().unwrap()]);
    fs::create_dir_all(&dropin).unwrap();
    fs::write(
        format!("{dropin}/probe.conf"),
        format!(
            "[Service]\nType=oneshot\nNotifyAccess=none\nExecStart=\nExecStart={} {} {}\nTimeoutStartSec=60\n",
            script.display(),
            own.id,
            other.id
        ),
    )
    .unwrap();
    run("systemctl", &["daemon-reload"]);
    let ended = Command::new("systemctl")
        .args(["start", &own.unit()])
        .output()
        .unwrap();
    assert!(
        ended.status.success(),
        "{}",
        String::from_utf8_lossy(&ended.stderr)
    );
    let report = fs::read_to_string(format!("/run/pgcf/{}/probe.txt", own.id)).unwrap();
    let field = |name: &str| -> String {
        report
            .lines()
            .find_map(|line| line.strip_prefix(&format!("{name}=")))
            .unwrap_or_else(|| panic!("{name} in\n{report}"))
            .to_string()
    };
    assert_eq!(field("uid"), own.uid.to_string());
    // No capability, no network.
    assert_eq!(field("cap_eff"), "0000000000000000");
    assert_eq!(field("network").trim(), "lo");
    // Its own volume: a mount of its own, read-write, nosuid, nodev, noexec and noatime.
    assert_eq!(field("own_mounts"), "1");
    assert_eq!(field("own_options"), "rw,nosuid,nodev,noexec,noatime");
    assert_eq!(field("own_write"), "yes");
    // No other volume in its mount table, and their directories are empty, not writable.
    assert_eq!(field("volume_mounts"), "1");
    assert_eq!(field("other_in_mountinfo"), "0");
    assert_eq!(field("other_entries"), "0");
    assert_eq!(field("other_write"), "no");
    assert_eq!(field("list_volumes"), "no");
    // The system is read-only, a world-writable directory included.
    assert_eq!(field("system_write"), "no");
    // The device policy of the unit allows the block devices that image dissection touches, and
    // what keeps its user from them is this: a private /dev with the character nodes of any
    // /dev and no block node, no capability to make one, and neither the device-mapper node of
    // a volume nor the volume's own device to open, by number or by name.
    assert_eq!(field("block_nodes"), "0");
    assert!(
        field("character_nodes").parse::<u32>().unwrap() > 0,
        "{report}"
    );
    for attempt in [
        "mknod_block",
        "open_dm_node",
        "open_own_device",
        "open_other_device",
    ] {
        assert_eq!(field(attempt), "no", "{attempt}\n{report}");
    }
    // What stays visible, as before: the device-mapper names, and a neighbour's cgroup.
    assert!(
        field("dm_names").contains(&format!("pgcflab-{}", other.id)),
        "{report}"
    );
    assert!(
        field("cgroup_siblings").contains(&format!("pgcf-pg@{}.service", other.id)),
        "{report}"
    );
    within(units.stop(&other.id)).await.unwrap();
}

/// Runs `cleanup` when dropped.
struct Guard<F: FnMut()>(F);
impl<F: FnMut()> Drop for Guard<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}
fn scopeguard<F: FnMut()>(cleanup: F) -> Guard<F> {
    Guard(cleanup)
}

/// The probe of the sandbox: `probe.sh <own id> <other id>`, run as the database's user in the
/// unit's sandbox, writing what it found to its own socket directory.
const PROBE: &str = r#"#!/bin/sh
me=$1; other=$2
t() { "$@" >/dev/null 2>&1 && echo yes || echo no; }
mine=/var/lib/pgcf/db/$me
cgroup=$(sed 's#^0::##' /proc/self/cgroup)
{
echo "uid=$(id -u)"
echo "cap_eff=$(grep CapEff /proc/self/status | cut -f2)"
echo "network=$(ls /sys/class/net | tr '\n' ' ')"
echo "own_mounts=$(grep -c " $mine " /proc/self/mountinfo)"
echo "own_options=$(awk -v p=$mine '$5==p {print $6}' /proc/self/mountinfo)"
echo "own_write=$(t touch $mine/probe.tmp)"
echo "volume_mounts=$(grep -c ' /var/lib/pgcf/db/' /proc/self/mountinfo)"
echo "other_in_mountinfo=$(grep -c "$other" /proc/self/mountinfo)"
echo "other_entries=$(ls -A /var/lib/pgcf/db/$other 2>/dev/null | wc -l)"
echo "other_write=$(t touch /var/lib/pgcf/db/$other/probe.tmp)"
echo "list_volumes=$(t ls /var/lib/pgcf/db)"
echo "system_write=$(t touch /srv/ww/probe.tmp)"
dm=$(cat "$(ls -d /sys/block/dm-* | head -1)/dev")
echo "block_nodes=$(find /dev -type b 2>/dev/null | wc -l)"
echo "character_nodes=$(find /dev -type c 2>/dev/null | wc -l)"
echo "mknod_block=$(t mknod $mine/block-node b ${dm%:*} ${dm#*:})"
echo "open_dm_node=$(t sh -c ": < /dev/dm-${dm#*:}")"
echo "open_own_device=$(t sh -c ": < /dev/mapper/pgcflab-$me")"
echo "open_other_device=$(t sh -c ": < /dev/mapper/pgcflab-$other")"
echo "dm_names=$(cat /sys/block/dm-*/dm/name 2>/dev/null | tr '\n' ' ')"
echo "cgroup_siblings=$(ls /sys/fs/cgroup$(dirname $cgroup) 2>/dev/null | tr '\n' ' ')"
} > /run/pgcf/$me/probe.txt
rm -f $mine/probe.tmp
"#;

/// Removes what `set_slice_memory` left on the image's slice, so the next run starts from it.
struct Slice;
impl Drop for Slice {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all("/etc/systemd/system.control/pgcf.slice.d");
        quiet("systemctl", &["daemon-reload"]);
    }
}

#[tokio::test]
#[ignore = "needs systemd as PID 1, root and the node image's units (lab)"]
async fn the_awake_budget_is_the_memory_ceiling_of_the_database_slice() {
    if !lab() {
        return;
    }
    let _slice = Slice;
    let database = Database::new(6);
    let units = Units::connect(DB_ROOT).await.unwrap();
    // Set before any database runs, and kept across a reboot.
    units.set_slice_memory(2048).await.unwrap();
    assert!(Path::new("/etc/systemd/system.control/pgcf.slice.d/50-MemoryMax.conf").is_file());
    let started = within(units.start(&database.id)).await.unwrap();
    let slice = cgroup_of(started.main_pid).parent().unwrap().to_path_buf();
    assert!(slice.ends_with("pgcf.slice"), "{slice:?}");
    let memory_max = || {
        fs::read_to_string(slice.join("memory.max"))
            .unwrap()
            .trim()
            .to_string()
    };
    assert_eq!(memory_max(), (2048u64 << 20).to_string());
    // A new policy reaches the running slice, with neither a reload nor a restart.
    units.set_slice_memory(3000).await.unwrap();
    assert_eq!(memory_max(), (3000u64 << 20).to_string());
    assert_eq!(
        units.state(&database.id).await.unwrap().main_pid,
        Some(started.main_pid)
    );
    within(units.stop(&database.id)).await.unwrap();
}

/// What `systemctl show` says of one property of a unit.
fn show(unit: &str, property: &str) -> String {
    let output = Command::new("systemctl")
        .args(["show", "-p", property, "--value", unit])
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// The command line of a process, which says which `ExecStart=` it was started with. A start job
/// of `Type=simple` ends when the process is forked, and until it has executed its command its
/// name is `(name)`: this waits for the command.
async fn command_line(pid: &str) -> String {
    let mut line = String::new();
    for _ in 0..100 {
        line = fs::read(format!("/proc/{pid}/cmdline"))
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .replace('\0', " ")
                    .trim()
                    .to_string()
            })
            .unwrap_or_default();
        if !line.starts_with('(') && !line.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    line
}

const LAB_TEMPLATE: &str = "/run/systemd/system/pgcf-labhf@.service";
const LAB_STOP_MARKER: &str = "/run/pgcf-labhf-stopped";

fn lab_template(version: u32) -> String {
    match version {
        1 => "[Service]\nExecStart=/bin/sleep 1000\nMemoryMax=64M\nTimeoutStopSec=30\nKillSignal=SIGTERM\n".to_string(),
        _ => format!(
            "[Service]\nExecStart=/bin/sleep 2000\nMemoryMax=96M\nTimeoutStopSec=45\nKillSignal=SIGINT\nExecStop=/bin/sh -c 'echo stopped > {LAB_STOP_MARKER}'\n"
        ),
    }
}

/// The memory ceiling the kernel enforces on the unit's cgroup, which is what the unit started with
/// and not what `systemctl show` says once the file changed.
fn cgroup_memory_max(unit: &str) -> String {
    let file = format!("/sys/fs/cgroup{}/memory.max", show(unit, "ControlGroup"));
    fs::read_to_string(file).unwrap().trim().to_string()
}

/// What a release's host file does to a template instance that runs (plan 9.3, `next_start`): the
/// D-Bus `Reload` the agent makes after it wrote the file, and what a start takes after it. Measured
/// on Debian 13's systemd 257: the reload gives the loaded unit the new file (its properties and,
/// at its next stop, its `ExecStop=`, `KillSignal=` and `TimeoutStopSec=`), and the running process
/// and its cgroup limits are left as they were until the unit starts again.
#[tokio::test]
#[ignore = "needs systemd as PID 1 and root (lab)"]
async fn a_reload_changes_what_the_next_stop_does_and_a_start_what_a_running_instance_is_made_of() {
    if !lab() {
        return;
    }
    let unit = "pgcf-labhf@a.service";
    let _clean = scopeguard(|| {
        quiet("systemctl", &["stop", unit]);
        let _ = fs::remove_file(LAB_TEMPLATE);
        let _ = fs::remove_file(LAB_STOP_MARKER);
        quiet("systemctl", &["daemon-reload"]);
    });
    let _ = fs::remove_file(LAB_STOP_MARKER);
    fs::write(LAB_TEMPLATE, lab_template(1)).unwrap();
    let units = Units::connect(DB_ROOT).await.unwrap();
    within(units.reload()).await.unwrap();
    within(units.start_service(unit, false)).await.unwrap();
    let pid = show(unit, "MainPID");
    assert_ne!(pid, "0");
    assert_eq!(command_line(&pid).await, "/bin/sleep 1000");
    let bytes = |mib: u64| (mib << 20).to_string();
    assert_eq!(show(unit, "MemoryMax"), bytes(64));
    assert_eq!(cgroup_memory_max(unit), bytes(64));

    // The file changes on disk.
    fs::write(LAB_TEMPLATE, lab_template(2)).unwrap();

    // After the reload the instance is the same process and keeps the cgroup limit it started
    // with, though the unit now reports the new one; its stop settings are the file's.
    within(units.reload()).await.unwrap();
    assert_eq!(show(unit, "MainPID"), pid);
    assert_eq!(command_line(&pid).await, "/bin/sleep 1000");
    assert_eq!(show(unit, "MemoryMax"), bytes(96));
    assert_eq!(cgroup_memory_max(unit), bytes(64));
    assert_eq!(show(unit, "TimeoutStopUSec"), "45s");
    assert_eq!(show(unit, "KillSignal"), "2");

    // The next stop of that very instance runs the `ExecStop=` the file added.
    assert!(!Path::new(LAB_STOP_MARKER).exists());
    run("systemctl", &["stop", unit]);
    assert!(Path::new(LAB_STOP_MARKER).exists());

    // The next start takes the exec settings and the cgroup limits of the file.
    within(units.start_service(unit, false)).await.unwrap();
    let started = show(unit, "MainPID");
    assert_ne!(started, pid);
    assert_eq!(command_line(&started).await, "/bin/sleep 2000");
    assert_eq!(cgroup_memory_max(unit), bytes(96));
}

/// The agent's own new unit stands in `/run/systemd/system` until the agent that runs it moves it
/// to its place (`hostfiles::promote`): systemd reads it before the image's file, and a boot, which
/// empties `/run`, leaves the image's file as the unit that runs.
#[tokio::test]
#[ignore = "needs systemd as PID 1 and root (lab)"]
async fn a_unit_in_the_runtime_directory_wins_over_the_images_and_leaves_with_its_file() {
    if !lab() {
        return;
    }
    let unit = "pgcf-labhf-stage.service";
    let image = format!("/usr/lib/systemd/system/{unit}");
    let runtime = format!("/run/systemd/system/{unit}");
    let _clean = scopeguard(|| {
        let _ = fs::remove_file(&image);
        let _ = fs::remove_file(&runtime);
        quiet("systemctl", &["daemon-reload"]);
    });
    let body = |description: &str| {
        format!("[Unit]\nDescription={description}\n[Service]\nType=oneshot\nExecStart=/bin/true\n")
    };
    fs::write(&image, body("last good")).unwrap();
    let units = Units::connect(DB_ROOT).await.unwrap();
    within(units.reload()).await.unwrap();
    assert_eq!(show(unit, "FragmentPath"), image);
    assert_eq!(show(unit, "Description"), "last good");

    // The agent stages the new unit and reads the units again: the copy in /run is the unit.
    fs::write(&runtime, body("new")).unwrap();
    within(units.reload()).await.unwrap();
    assert_eq!(show(unit, "FragmentPath"), runtime);
    assert_eq!(show(unit, "Description"), "new");

    // A boot empties /run: the image's file is what systemd reads, the last good unit.
    fs::remove_file(&runtime).unwrap();
    within(units.reload()).await.unwrap();
    assert_eq!(show(unit, "FragmentPath"), image);
    assert_eq!(show(unit, "Description"), "last good");

    // The promotion: the file of the image is written, the copy goes, one reload reads the file.
    fs::write(&runtime, body("new")).unwrap();
    within(units.reload()).await.unwrap();
    fs::write(&image, body("new")).unwrap();
    fs::remove_file(&runtime).unwrap();
    within(units.reload()).await.unwrap();
    assert_eq!(show(unit, "FragmentPath"), image);
    assert_eq!(show(unit, "Description"), "new");
}

/// The units that systemd has loaded and that match `pattern`, as `systemctl list-units` lists
/// them: it does not load a unit, as `systemctl show` of one does.
fn loaded(pattern: &str) -> Vec<String> {
    let output = Command::new("systemctl")
        .args(["list-units", "--all", "--no-legend", "--plain", pattern])
        .output()
        .unwrap();
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(String::from)
        .collect()
}

/// The agent reads the state of every database's unit when it starts, all at once: the bus
/// connection has one pending reply per call, and the bus daemon (dbus-daemon's
/// `max_replies_per_connection`) refuses the calls past its limit. A node has hundreds of
/// databases and almost all of them are asleep, not loaded, and a read of one of their properties
/// loads the unit.
#[tokio::test]
#[ignore = "needs systemd as PID 1 and the node image's units (lab)"]
async fn the_state_of_hundreds_of_units_is_read_at_once_and_every_read_is_answered() {
    if !lab() {
        return;
    }
    const UNITS: usize = 300;
    let units = Units::connect(DB_ROOT).await.unwrap();
    let ids: Vec<String> = (0..UNITS).map(|n| format!("labrd{n:015}")).collect();
    let started = std::time::Instant::now();
    let reads = futures_util::future::join_all(ids.iter().map(|id| units.state(id))).await;
    eprintln!(
        "lab: {UNITS} unit reads at once took {} ms",
        started.elapsed().as_millis()
    );
    let failed: Vec<String> = reads
        .iter()
        .filter_map(|read| read.as_ref().err().map(ToString::to_string))
        .collect();
    assert!(
        failed.is_empty(),
        "{} of {UNITS} reads failed: {:?}",
        failed.len(),
        failed.first()
    );
    assert!(
        reads
            .iter()
            .all(|read| matches!(read, Ok(state) if state.active == ActiveState::Inactive))
    );
    // The reads loaded none of them.
    assert!(loaded("pgcf-pg@labrd*").is_empty());
}

/// The limit the bound stands on: the bus daemon answers one connection with no more than 128
/// calls that are not answered yet, and a read of a unit that systemd has not loaded is five
/// calls that it answers one after the other, each after it has loaded the unit. The reads that
/// `READS_IN_FLIGHT` allows are far below the limit, and a few times as many are not.
#[tokio::test]
#[ignore = "needs systemd as PID 1 (lab)"]
async fn the_bus_answers_the_reads_in_flight_and_refuses_those_past_its_limit() {
    if !lab() {
        return;
    }
    let units = Units::connect(DB_ROOT).await.unwrap();
    // The five properties of `state`, asked of a unit that is not loaded, so that systemd loads it
    // before it answers.
    let read = |unit: String| {
        let units = units.clone();
        async move {
            let (unit_proxy, service) = (
                units.unit_proxy(&unit, CacheProperties::No).await.unwrap(),
                units.service_proxy(&unit).await.unwrap(),
            );
            let (a, b, c, d, e) = tokio::join!(
                unit_proxy.active_state(),
                unit_proxy.invocation_id(),
                service.main_pid(),
                service.uid(),
                service.memory_max(),
            );
            a.is_ok() && b.is_ok() && c.is_ok() && d.is_ok() && e.is_ok()
        }
    };
    let mut report = Vec::new();
    for reads in [READS_IN_FLIGHT, 24, 25, 26, 32, 64] {
        let answered = futures_util::future::join_all(
            (0..reads).map(|n| read(unit_name(&format!("labbs{reads:05}{n:010}")))),
        )
        .await
        .into_iter()
        .filter(|ok| *ok)
        .count();
        report.push((reads, answered));
    }
    eprintln!("lab: reads at once and reads answered: {report:?}");
    assert_eq!(report[0], (READS_IN_FLIGHT, READS_IN_FLIGHT));
    assert!(
        report
            .last()
            .is_some_and(|(reads, answered)| answered < reads)
    );
}
