// SPDX-License-Identifier: Apache-2.0
//! The units against a real systemd and a real PostgreSQL 18. They run as root on a Debian 13 host
//! with systemd as PID 1, the image's `pgcf-pg@.service` and `pgcf.slice`, PGDG PostgreSQL 18 and
//! `useradd`, with `--ignored`; the CI kernel step has no systemd and skips them. They create
//! users, a tmpfs volume and a database, and remove them again.
use super::{
    ActiveState, DB_ROOT, Error, Units,
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
struct Database {
    id: String,
    uid: u32,
    root: PathBuf,
    users_dir: PathBuf,
}
impl Database {
    fn new(n: u32) -> Self {
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
        run(
            "mount",
            &[
                "-t",
                "tmpfs",
                "-o",
                "size=512m,mode=0700",
                "tmpfs",
                root.to_str().unwrap(),
            ],
        );
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
        Self {
            id,
            uid,
            root,
            users_dir,
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
        quiet("umount", &[self.root.to_str().unwrap()]);
        let _ = fs::remove_dir_all(&self.root);
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
    // A unit that never started is loaded on demand and inactive, at the template's ceiling.
    let idle = units.state(id).await.unwrap();
    assert_eq!(idle.active, ActiveState::Inactive);
    assert_eq!(
        (idle.main_pid, idle.invocation_id, idle.uid),
        (None, None, None)
    );
    assert_eq!(idle.memory_max_bytes, Some(256 << 20));

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
    assert_eq!(within(units.start(id)).await.unwrap(), started);

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
    assert_eq!(joined.unwrap(), started);
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
    // The image's unit asserts that the volume is mounted.
    run("umount", &[database.root.to_str().unwrap()]);
    let error = within(units.start(&database.id)).await.unwrap_err();
    assert!(
        matches!(&error, Error::Job { unit, result } if *unit == database.unit() && result == "assert"),
        "{error:?}"
    );
    assert!(matches!(
        units.start("not a database").await,
        Err(Error::InvalidDatabase)
    ));
    // Back on a volume for the guard's cleanup.
    run(
        "mount",
        &["-t", "tmpfs", "tmpfs", database.root.to_str().unwrap()],
    );
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
