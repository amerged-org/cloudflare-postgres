// SPDX-License-Identifier: Apache-2.0
//! The pool of slots (`slots::Pool` over `system::System`) against a real systemd, a real kernel
//! and a real PostgreSQL 18: the parts of package P-e that no double can prove. The tests run as
//! root on a Debian 13 host with systemd as PID 1 (Linux 6.3 or newer), one at a time, and exist
//! only in a build made for them (`--cfg pgcf_slot_lab`): the kernel step of CI runs every ignored
//! test in an unprivileged container and must not meet them. The host has the image's
//! `pgcf-slot@.service` and `pgcf.slice`, the supervisor at `/usr/libexec/pgcf/pgcf-archive`
//! (`pgcf-archive slot <n>`), PostgreSQL 18 under `/usr/lib/postgresql/18`, util-linux,
//! e2fsprogs, perl and `nsenter`. The test binary runs as the agent runs, in a mount namespace of
//! its own with the propagation that `PrivateMounts=yes` of `pgcf-agent.service` gives it (the
//! idmapped handoff needs it, see `idmap_lab`):
//!
//! ```sh
//! RUSTFLAGS='--cfg pgcf_slot_lab' cargo test -p pgcf-node-agent --lib --no-run
//! systemd-run --wait --pipe -p PrivateMounts=yes <test binary> --ignored --test-threads=1 \
//!     --nocapture units::slot_lab
//! ```
//!
//! Everything the lab makes lives under `/var/tmp/pgcf-lab-slots`, in the mounts
//! `/var/lib/pgcf/db/labslot*`, in the slots 900 to 915 (their units and users `pgcf-slot-900` ...)
//! and the users `pgcf-lab-*`, and is removed again. A database, a slot or a user of the node is
//! never touched: the lab's pool has its own numbers.
use super::{
    ActiveState, DB_ROOT, Error, Units, limits, ready,
    slots::{self, Bind, Host, Pool, SlotFrom, slot_uid, slot_unit},
    system::System,
};
use crate::{
    layout::Layout,
    machine::{Account, initdb_arguments},
    postgres, settings,
    storage::{CommandRunner, Config, Output, Storage, VolumeId},
};
use std::{
    fs,
    io::{self, BufRead, BufReader},
    os::unix::{
        fs::{MetadataExt, PermissionsExt, chown},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const SCRATCH: &str = "/var/tmp/pgcf-lab-slots";
/// The lab's slots: far from the node's, whose first numbers an agent fills.
const POOL: std::ops::Range<u32> = 900..916;
const DB_ID: u32 = 298_201;
const GATEWAY_ID: u32 = 398_601;
const DB_USER: &str = "pgcf-lab-db";
const GATEWAY_USER: &str = "pgcf-lab-gw";
const POSTGRES: &str = "/usr/lib/postgresql/18/bin";

fn sh(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{program}: {error}"));
    assert!(
        output.status.success(),
        "{program} {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}
/// A command whose failure and output do not matter: the cleanup of what may not exist.
fn quiet(program: &str, args: &[&str]) {
    let _ = Command::new(program).args(args).output();
}
fn show(unit: &str, property: &str) -> String {
    sh("systemctl", &["show", "-p", property, "--value", unit])
}
fn account(name: &str, id: u32) {
    quiet("userdel", &[name]);
    quiet("groupdel", &[name]);
    let id = id.to_string();
    sh("groupadd", &["-g", &id, name]);
    sh(
        "useradd",
        &[
            "-u",
            &id,
            "-g",
            name,
            "-M",
            "-s",
            "/usr/sbin/nologin",
            "-d",
            "/nonexistent",
            name,
        ],
    );
}
fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (sorted.len() as f64 * fraction).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}
/// Prints `name: n=.. p50=.. p95=.. max=..` in milliseconds and returns (p50, p95).
fn report(name: &str, mut millis: Vec<f64>) -> (f64, f64) {
    millis.sort_by(f64::total_cmp);
    let (p50, p95) = (percentile(&millis, 0.5), percentile(&millis, 0.95));
    println!(
        "slot_lab {name}: n={} p50={p50:.2} ms p95={p95:.2} ms max={:.2} ms",
        millis.len(),
        millis[millis.len() - 1]
    );
    (p50, p95)
}

/// What the storage module asks LVM: one volume of the lab's database. Every other command
/// succeeds and says nothing.
struct LabLvm(String);
impl CommandRunner for LabLvm {
    fn run(&self, command: &[String]) -> io::Result<Output> {
        Ok(Output {
            code: 0,
            stdout: if command.first().map(String::as_str) == Some("lvs") {
                self.0.clone()
            } else {
                String::new()
            },
            stderr: String::new(),
        })
    }
}

/// The lab runs one test at a time: the users, the scratch directory and the units are shared.
static ONE_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LABS: AtomicU64 = AtomicU64::new(0);

/// A database of the lab: a volume (an ext4 on a loop device, named as the node's thin volume is,
/// by a link in `/dev/mapper`) mounted at `/var/lib/pgcf/db/<id>` in the lab's mount namespace, a
/// cluster that `initdb` made as the database's user with the configuration the agent writes, and
/// a socket directory of the database's user and the gateway's group, mode 0750.
struct Database {
    id: String,
    volume: VolumeId,
    loop_device: String,
    root: PathBuf,
    sockets: PathBuf,
    dir: PathBuf,
}
impl Database {
    fn new(label: &str) -> Database {
        let id = format!(
            "labslot{label}{:012}",
            u64::from(std::process::id()) + LABS.fetch_add(1, Ordering::Relaxed)
        );
        assert!(pgcf_native_protocol::valid_pattern("database", &id), "{id}");
        let dir = Path::new(SCRATCH).join(&id);
        fs::create_dir_all(&dir).unwrap();
        let image = dir.join("volume.img");
        fs::File::create(&image)
            .unwrap()
            .set_len(256 << 20)
            .unwrap();
        let loop_device = sh("losetup", &["-f", "--show", image.to_str().unwrap()]);
        if !Path::new(&loop_device).exists() {
            let number = loop_device.trim_start_matches("/dev/loop");
            sh("mknod", &[&loop_device, "b", "7", number]);
        }
        sh("mkfs.ext4", &["-F", "-q", &loop_device]);
        let volume = VolumeId::new(&id, 1).unwrap();
        // The device the storage module names for the volume, a link to the loop device.
        fs::create_dir_all("/dev/mapper").unwrap();
        let device = Self::device_of(&volume);
        let _ = fs::remove_file(&device);
        std::os::unix::fs::symlink(&loop_device, &device).unwrap();
        let root = Path::new(DB_ROOT).join(&id);
        fs::create_dir_all(&root).unwrap();
        sh(
            "mount",
            &[
                "-t",
                "ext4",
                "-o",
                "nosuid,nodev,noexec,noatime",
                &loop_device,
                root.to_str().unwrap(),
            ],
        );
        chown(&root, Some(DB_ID), Some(DB_ID)).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let sockets = Path::new("/run/pgcf").join(&id);
        fs::create_dir_all(&sockets).unwrap();
        let gateway = group_gid("pgcf-gateway");
        chown(&sockets, Some(DB_ID), Some(gateway)).unwrap();
        fs::set_permissions(&sockets, fs::Permissions::from_mode(0o750)).unwrap();
        let lab = Database {
            id,
            volume,
            loop_device,
            root,
            sockets,
            dir,
        };
        lab.make_cluster();
        lab
    }

    /// The device node the storage module names for the volume.
    fn device_of(volume: &VolumeId) -> PathBuf {
        Storage::new(LabLvm(String::new()), Config::default())
            .device(volume)
            .into()
    }

    fn data(&self) -> PathBuf {
        self.root.join("data")
    }

    /// The cluster, as the agent makes it: `initdb` as the database's user, the agent's
    /// configuration, and no login before `pg_hba.conf` is there.
    fn make_cluster(&self) {
        let data = self.data();
        let status = Command::new(format!("{POSTGRES}/initdb"))
            .args(initdb_arguments(&data, None))
            .uid(DB_ID)
            .gid(DB_ID)
            .env_clear()
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "initdb");
        let conf = settings::postgresql_conf(&settings::Settings {
            socket_directory: &self.sockets,
            memory_mib: 512,
            volume_bytes: 256 << 20,
            max_connections: 20,
            archive_timeout_seconds: 60,
            archive_command: None,
        })
        .unwrap();
        let ident = settings::pg_ident("root", DB_USER).unwrap();
        for (name, content) in [
            ("postgresql.conf", conf.as_str()),
            ("pg_hba.conf", settings::PG_HBA),
            ("pg_ident.conf", ident.as_str()),
        ] {
            fs::write(data.join(name), content).unwrap();
            chown(data.join(name), Some(DB_ID), Some(DB_ID)).unwrap();
        }
    }

    fn lvs(&self) -> String {
        format!(
            r#"{{"report":[{{"lv":[{{"lv_name":"{lv}","lv_size":"268435456","lv_attr":"Vwi-a-tz--","pool_lv":"pgcf_thinpool","chunk_size":"0","lv_metadata_size":"","lv_when_full":"","zero":"zero","lv_tags":"pgcf.db.{id},pgcf.fs,pgcf.gen.1"}}]}}]}}"#,
            lv = self.volume.lv_name(),
            id = self.id
        )
    }

    fn account() -> Account {
        Account {
            name: DB_USER.into(),
            uid: DB_ID,
            gid: DB_ID,
        }
    }

    /// What the agent hands a bind of this database, with limits of `memory_mib`.
    fn bind(&self, memory_mib: u64) -> Bind {
        let properties = limits::Limits {
            memory_mib,
            cpu_millicores: 500,
            tasks_max: 64,
            io: Some(limits::Io::scaled(
                self.loop_device.clone(),
                20 << 20,
                500,
                memory_mib,
            )),
        }
        .properties();
        Bind {
            volume: self.volume.clone(),
            account: Self::account(),
            device: PathBuf::from(&self.loop_device),
            data: self.data(),
            properties,
        }
    }

    /// The agent's session over the database's socket, as root, which `pg_ident.conf` maps to the
    /// agent's role.
    async fn agent(&self) -> postgres::Session {
        postgres::agent(&self.sockets).await.unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        quiet("umount", &["-l", self.root.to_str().unwrap()]);
        let _ = fs::remove_file(Self::device_of(&self.volume));
        quiet("losetup", &["-d", &self.loop_device]);
        let _ = fs::remove_dir(&self.root);
        let _ = fs::remove_dir_all(&self.sockets);
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn group_gid(name: &str) -> u32 {
    let group = fs::read_to_string("/etc/group").unwrap();
    group
        .lines()
        .find_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            (fields.first() == Some(&name)).then(|| fields.get(2)?.parse().ok())?
        })
        .unwrap_or_else(|| panic!("no group {name}"))
}

/// The host: the lab's `System`, its pool and what has to be taken away at the end.
struct Lab {
    pool: Pool<System<LabLvm>>,
    made_gateway_group: bool,
    _one_at_a_time: tokio::sync::MutexGuard<'static, ()>,
}
impl Lab {
    /// The host and a database, in that order: the database goes first at the end.
    async fn new(label: &str) -> (Lab, Database) {
        let guard = ONE_AT_A_TIME.lock().await;
        assert_ne!(
            fs::read_link("/proc/1/ns/mnt").unwrap(),
            fs::read_link("/proc/self/ns/mnt").unwrap(),
            "run the lab under `systemd-run --wait --pipe -p PrivateMounts=yes`"
        );
        assert!(
            Path::new("/run/systemd/system").is_dir(),
            "the lab needs systemd as PID 1"
        );
        for needed in [
            "/usr/libexec/pgcf/pgcf-archive",
            "/usr/lib/systemd/system/pgcf-slot@.service",
            "/usr/lib/systemd/system/pgcf.slice",
        ] {
            assert!(Path::new(needed).exists(), "the lab needs {needed}");
        }
        let made_gateway_group = !fs::read_to_string("/etc/group")
            .unwrap()
            .lines()
            .any(|line| line.starts_with("pgcf-gateway:"));
        if made_gateway_group {
            sh("groupadd", &["--system", "pgcf-gateway"]);
        }
        account(GATEWAY_USER, GATEWAY_ID);
        account(DB_USER, DB_ID);
        let lab_without_pool = made_gateway_group;
        let database = Database::new(label);
        let pool = Self::pool_of(&database).await;
        (
            Lab {
                pool,
                made_gateway_group: lab_without_pool,
                _one_at_a_time: guard,
            },
            database,
        )
    }

    async fn pool_of(database: &Database) -> Pool<System<LabLvm>> {
        let layout = Layout::default();
        let units = Units::connect(layout.volumes()).await.unwrap();
        let storage = Arc::new(Storage::new(LabLvm(database.lvs()), Config::default()));
        Pool::new(System::new(units, layout, storage), POOL)
    }

    /// A pool of an agent that started after the last one died: nothing in memory.
    async fn another_pool(&self, database: &Database) -> Pool<System<LabLvm>> {
        Self::pool_of(database).await
    }
}
impl Drop for Lab {
    fn drop(&mut self) {
        for slot in POOL {
            quiet("systemctl", &["stop", &slot_unit(slot)]);
            quiet("systemctl", &["reset-failed", &slot_unit(slot)]);
            quiet("userdel", &[&slots::slot_account(slot)]);
            quiet("groupdel", &[&slots::slot_account(slot)]);
        }
        let _ = fs::remove_dir_all("/run/pgcf/slot");
        for name in [GATEWAY_USER, DB_USER] {
            quiet("userdel", &[name]);
            quiet("groupdel", &[name]);
        }
        if self.made_gateway_group {
            quiet("groupdel", &["pgcf-gateway"]);
        }
        let _ = fs::remove_dir(SCRATCH);
    }
}

fn signal(pid: u32, name: &str) {
    sh("kill", &[&format!("-{name}"), &pid.to_string()]);
}

struct Killed(Child);
impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A database runs in a pooled slot: the limits are the database's before the order, the order
/// makes the supervisor PostgreSQL itself, and what PostgreSQL does there is what a database unit
/// did (it answers the agent, holds the data directory's lock, and the gateway's group dials it).
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn a_database_runs_in_a_pooled_slot_with_its_limits_set_before_the_order() {
    let (lab, database) = Lab::new("a").await;
    let pool = &lab.pool;

    // An idle slot: the supervisor, with the idle limits of the unit file.
    assert_eq!(pool.refill(1).await.unwrap(), Some(900));
    let unit = slot_unit(900);
    assert_eq!(show(&unit, "ActiveState"), "active");
    assert_eq!(show(&unit, "MemoryMax"), (32u64 << 20).to_string());
    assert_eq!(
        show(&unit, "User"),
        slots::slot_account(900),
        "the user was made by the refill"
    );

    // The bind: the limits of the database's size and its two mounts, with no PostgreSQL yet.
    let bound = pool.bind(&database.id, &database.bind(512)).await.unwrap();
    assert_eq!((bound.slot, bound.from), (900, SlotFrom::Pool));
    assert_eq!(show(&unit, "MemoryMax"), (512u64 << 20).to_string());
    assert_eq!(show(&unit, "CPUWeight"), "50");
    assert!(
        show(&unit, "IOWriteBandwidthMax").contains(&database.loop_device),
        "{}",
        show(&unit, "IOWriteBandwidthMax")
    );
    let facts = pool.host().facts(900, None).unwrap().unwrap();
    assert_eq!(facts.exe, slots::Exe::Supervisor);
    assert_eq!(facts.databases.len(), 1, "{facts:?}");
    assert!(!facts.locked, "nothing holds the data directory yet");
    assert!(
        pool.holder(slot_uid(900)).is_some(),
        "the archive socket knows the slot from the bind"
    );

    // The order: PostgreSQL is the unit's main process, as the slot's user, and answers.
    let started = pool.exec(&bound).await.unwrap();
    assert_eq!(started.uid, slot_uid(900));
    assert_eq!(
        started.main_pid,
        show(&unit, "MainPID").parse::<u32>().unwrap()
    );
    assert_eq!(
        fs::read_link(format!("/proc/{}/exe", started.main_pid)).unwrap(),
        Path::new(POSTGRES).join("postgres")
    );
    assert_eq!(
        fs::metadata(format!("/proc/{}", started.main_pid))
            .unwrap()
            .uid(),
        slot_uid(900)
    );
    let session = database.agent().await;
    assert_eq!(
        session
            .query("SELECT 1::int4", &[])
            .await
            .unwrap()
            .first()
            .map(|row| row.get::<_, i32>(0)),
        Some(1)
    );
    // The files PostgreSQL wrote are the database's user's on disk.
    let metadata = fs::metadata(database.data().join("postmaster.pid")).unwrap();
    assert_eq!((metadata.uid(), metadata.gid()), (DB_ID, DB_ID));
    let facts = pool.host().facts(900, None).unwrap().unwrap();
    assert_eq!(facts.exe, slots::Exe::Postgres);
    assert!(facts.locked, "PostgreSQL holds the data directory's lock");
    assert_eq!(facts.postmaster, Some(ready::Status::Ready));
    drop(session);

    // The gateway's group dials the socket, and the peer it sees is the slot's user and the
    // postmaster: what the gateway checks.
    let socket = database.sockets.join(".s.PGSQL.5432");
    let dial = Command::new("perl")
        .args([
            "-MSocket",
            "-e",
            "my $p = shift; socket(my $s, PF_UNIX, SOCK_STREAM, 0) or die \"socket: $!\"; \
             connect($s, sockaddr_un($p)) or die \"connect: $!\"; \
             my ($pid, $uid, $gid) = unpack('iII', getsockopt($s, SOL_SOCKET, SO_PEERCRED)); \
             print \"$pid $uid $gid\\n\";",
            socket.to_str().unwrap(),
        ])
        .uid(GATEWAY_ID)
        .gid(group_gid("pgcf-gateway"))
        .output()
        .unwrap();
    assert!(
        dial.status.success(),
        "the gateway's group cannot dial: {}",
        String::from_utf8_lossy(&dial.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&dial.stdout).trim(),
        format!("{} {} {}", started.main_pid, slot_uid(900), slot_uid(900))
    );

    // The caller of the archive socket is the holder only from the slot's cgroup and invocation.
    let (cgroup, invocation) = super::system::peer_unit(started.main_pid);
    assert_eq!(cgroup.as_deref(), Some(slots::slot_cgroup(900).as_str()));
    assert_eq!(invocation.as_deref(), Some(started.invocation_id.as_str()));
    let holder = pool.holder(slot_uid(900)).unwrap();
    assert!(slots::is_holder(
        &holder,
        cgroup.as_deref(),
        invocation.as_deref()
    ));
    let (here, there) = super::system::peer_unit(std::process::id());
    assert!(!slots::is_holder(
        &holder,
        here.as_deref(),
        there.as_deref()
    ));

    // A second bind of the database is refused while the slot holds it.
    assert!(matches!(
        pool.bind(&database.id, &database.bind(512)).await,
        Err(Error::Held)
    ));
    // The stop frees the slot, and a started unit does not leave its mount in the node's namespace.
    assert!(pool.stop(&database.id).await.unwrap());
    assert_eq!(show(&unit, "ActiveState"), "inactive");
    assert_eq!(pool.snapshot(), slots::Snapshot::default());
}

/// Exactly one writer. Two slots that see one data directory as their own are kept from running
/// two postmasters on it by the supervisor's lock, and a database whose postmaster was killed is
/// bound again only when its unit is over.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn the_kernel_lets_one_slot_run_a_postmaster_on_a_data_directory_and_postgresql_alone_would_let_two()
 {
    let (lab, database) = Lab::new("b").await;
    let pool = &lab.pool;
    let host = pool.host();
    pool.refill(2).await.unwrap();
    pool.refill(2).await.unwrap();
    let first = pool.bind(&database.id, &database.bind(512)).await.unwrap();
    let started = pool.exec(&first).await.unwrap();

    // A second slot, with the same volume handed to it by the node's own code (the pool would not
    // do it), is refused at the order: the postmaster there never starts.
    let bind = database.bind(512);
    let other = 901;
    host.set(other, &bind.properties).await.unwrap();
    host.mount(other, &bind).await.unwrap();
    let refused = host.order(other, &database.id).await.unwrap_err();
    assert!(matches!(refused, Error::Refused("held")), "{refused}");
    assert!(
        started.main_pid
            == show(&slot_unit(first.slot), "MainPID")
                .parse::<u32>()
                .unwrap(),
        "the first postmaster runs on"
    );
    // The supervisor that refused ends: the slot may hold mounts and is not used again.
    for _ in 0..100 {
        if !host.alive(other) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!host.alive(other));
    let session = database.agent().await;
    session.query("SELECT 1::int4", &[]).await.unwrap();
    drop(session);

    // The postmaster is killed. systemd ends the rest of the unit's processes at once (a backend
    // that outlived its postmaster would keep the open file's lock, which `pgcf-archive`'s tests
    // prove), and the pool binds the database again only when the unit has reached `inactive`:
    // until then it is refused, and after it the crash recovery runs under a lock that is free.
    signal(started.main_pid, "KILL");
    let began = Instant::now();
    let restarted = loop {
        match pool.bind(&database.id, &bind).await {
            Ok(again) => break pool.exec(&again).await.unwrap(),
            Err(Error::Held) => {
                assert!(
                    began.elapsed() < Duration::from_secs(40),
                    "the unit never ended"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("{error}"),
        }
    };
    assert_ne!(restarted.invocation_id, started.invocation_id);
    assert_eq!(
        show(&slot_unit(first.slot), "ActiveState"),
        if first.slot == restarted.slot.unwrap().slot {
            "active"
        } else {
            "inactive"
        },
    );
    let session = database.agent().await;
    session.query("SELECT 1::int4", &[]).await.unwrap();
    drop(session);
    assert!(pool.stop(&database.id).await.unwrap());
}

/// The hole the lock closes, shown on a database the lab throws away: PostgreSQL's own guard
/// accepts a second postmaster of another user on a data directory that a live postmaster holds,
/// because `kill(pid, 0)` of another user's process is `EPERM`, which `miscinit.c` takes for a
/// stale `postmaster.pid`, and the old shared memory segment, in another IPC namespace, is not
/// found. Nothing here is what the agent does; it is why the agent does what it does.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn postgresql_alone_accepts_a_second_postmaster_of_another_slot_on_the_same_directory() {
    let (lab, database) = Lab::new("c").await;
    let pool = &lab.pool;
    let host = pool.host();
    pool.refill(2).await.unwrap();
    pool.refill(2).await.unwrap();
    let bind = database.bind(512);
    let first = pool.bind(&database.id, &bind).await.unwrap();
    let started = pool.exec(&first).await.unwrap();
    let other = if first.slot == 900 { 901 } else { 900 };
    host.mount(other, &bind).await.unwrap();

    // The second postmaster, run as the second slot's user in its mount namespace with no
    // supervisor's lock before it.
    let unit = host.unit(other).await.unwrap();
    let mut second = Killed(
        Command::new("nsenter")
            .args([
                "--target",
                &unit.main_pid.unwrap().to_string(),
                "--mount",
                "--",
                "setpriv",
                &format!("--reuid={}", slot_uid(other)),
                &format!("--regid={}", slot_uid(other)),
                "--clear-groups",
                &format!("{POSTGRES}/postgres"),
                "-D",
            ])
            .arg(database.data())
            .args(["-c", "listen_addresses=", "-c"])
            .arg(format!(
                "unix_socket_directories={}",
                database.sockets.display()
            ))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let log = second.0.stderr.take().unwrap();
    let (lines, ready) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(log).lines().map_while(Result::ok) {
            if lines.send(line).is_err() {
                return;
            }
        }
    });
    let mut seen = Vec::new();
    let began = Instant::now();
    let mut started_second = false;
    while began.elapsed() < Duration::from_secs(15) {
        match ready.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                let accepted = line.contains("database system is ready to accept connections")
                    || line.contains("database system was interrupted");
                let refused = line.contains("lock file") && line.contains("already exists");
                seen.push(line);
                assert!(!refused, "PostgreSQL's own guard held: {seen:?}");
                if accepted {
                    started_second = true;
                    break;
                }
            }
            Err(_) => {
                assert!(
                    second.0.try_wait().unwrap().is_none(),
                    "the second postmaster ended: {seen:?}"
                );
            }
        }
    }
    println!("slot_lab the second postmaster's log: {seen:?}");
    assert!(
        started_second,
        "PostgreSQL alone let a second postmaster come up on the directory: {seen:?}"
    );
    // And the supervisor's order, for the same slot and directory, is refused.
    let refused = host.order(other, &database.id).await.unwrap_err();
    assert!(matches!(refused, Error::Refused("held")), "{refused}");
    drop(second);
    signal(started.main_pid, "KILL");
    let _ = pool.stop(&database.id).await;
}

/// PostgreSQL's `ready` in `postmaster.pid` reaches the agent through `inotify` no later than the
/// postmaster's own `READY=1` to the notify socket, which is what the unit's start job waited for
/// before the supervisor. The postmaster writes its status line just before it sends `READY=1`, and
/// its closing of the file is what `inotify` reports. A postmaster of the lab's own is started with
/// a notify socket of the test's, and `System::ready` waits on it as it waits in a slot.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn readiness_by_inotify_is_no_later_than_the_postmasters_ready_to_the_notify_socket() {
    let (lab, database) = Lab::new("d").await;
    let host = lab.pool.host();
    let notify = Path::new(SCRATCH).join("notify.sock");
    let mut after = Vec::new();
    for _ in 0..8 {
        let _ = fs::remove_file(&notify);
        let socket = tokio::net::UnixDatagram::bind(&notify).unwrap();
        chown(&notify, Some(DB_ID), Some(DB_ID)).unwrap();
        let child = Command::new(format!("{POSTGRES}/postgres"))
            .arg("-D")
            .arg(database.data())
            .args(["-c", "listen_addresses=", "-c"])
            .arg(format!(
                "unix_socket_directories={}",
                database.sockets.display()
            ))
            .env("NOTIFY_SOCKET", &notify)
            .uid(DB_ID)
            .gid(DB_ID)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut child = Killed(child);
        let waiting = async {
            let socket_reached = host.ready(900, &database.id, pid).await.unwrap();
            (super::monotonic_micros().unwrap(), socket_reached)
        };
        let notified = async {
            let mut buffer = [0u8; 256];
            loop {
                let read = socket.recv(&mut buffer).await.unwrap();
                if buffer[..read].starts_with(b"READY=1") {
                    return super::monotonic_micros().unwrap();
                }
            }
        };
        let ((observed, _), notified) = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::join!(waiting, notified)
        })
        .await
        .expect("PostgreSQL did not become ready");
        // Negative: the agent knew before systemd would have.
        after.push((observed as f64 - notified as f64) / 1000.0);
        signal(pid, "INT");
        child.0.wait().unwrap();
    }
    let mut sorted = after.clone();
    sorted.sort_by(f64::total_cmp);
    println!("slot_lab the return of ready() after READY=1, ms: {sorted:?}");
    let (_, p95) = report("ready() after READY=1", after);
    assert!(
        sorted.last().copied().unwrap() < 3.0,
        "the agent learns of readiness after READY=1: {sorted:?}"
    );
    assert!(p95 < 3.0);
}

/// A runtime property outlives the stop of its unit. The build of the next incarnation takes back
/// the memory, the weight, the quota and the write limits that the last database set, with the
/// empty array that resets the write limits of every device.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn a_slot_that_served_has_the_idle_limits_again_after_its_refill() {
    let (lab, database) = Lab::new("e").await;
    let pool = &lab.pool;
    pool.refill(1).await.unwrap();
    let bound = pool.bind(&database.id, &database.bind(512)).await.unwrap();
    pool.exec(&bound).await.unwrap();
    assert!(
        pool.set(
            &database.id,
            &[limits::cpu_quota(std::num::NonZeroU32::new(250))]
        )
        .await
        .unwrap()
    );
    let unit = slot_unit(bound.slot);
    assert_eq!(show(&unit, "CPUQuotaPerSecUSec"), "250ms");
    assert!(show(&unit, "IOWriteBandwidthMax").contains(&database.loop_device));
    assert!(pool.stop(&database.id).await.unwrap());
    // The stop leaves them as they were, and the refill does not.
    assert_eq!(show(&unit, "CPUQuotaPerSecUSec"), "250ms");
    assert_eq!(pool.refill(1).await.unwrap(), Some(bound.slot));
    assert_eq!(show(&unit, "CPUQuotaPerSecUSec"), "infinity");
    assert_eq!(show(&unit, "MemoryMax"), (32u64 << 20).to_string());
    assert_eq!(show(&unit, "MemoryHigh"), (28u64 << 20).to_string());
    assert_eq!(show(&unit, "CPUWeight"), "10");
    assert_eq!(show(&unit, "IOWriteBandwidthMax"), "");
    assert_eq!(show(&unit, "IOWriteIOPSMax"), "");
}

/// What an idle slot costs: the memory of eight supervisors with their namespaces, and the most
/// each used while its unit was built, from the kernel's own accounting, which sets `MemoryMax=`
/// of the unit file.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn eight_idle_slots_cost_less_than_the_idle_ceiling_each() {
    let (lab, _database) = Lab::new("f").await;
    let pool = &lab.pool;
    for _ in 0..8 {
        pool.refill(8).await.unwrap();
    }
    assert_eq!(pool.snapshot().idle, 8);
    tokio::time::sleep(Duration::from_secs(2)).await;
    let slice = Path::new("/sys/fs/cgroup/pgcf.slice");
    let read = |slot: u32, file: &str| -> String {
        fs::read_to_string(slice.join(slot_unit(slot)).join(file)).unwrap_or_default()
    };
    let stat = |slot: u32, key: &str| -> u64 {
        read(slot, "memory.stat")
            .lines()
            .find_map(|line| line.strip_prefix(key)?.trim().parse().ok())
            .unwrap_or(0)
    };
    let mut current = Vec::new();
    for slot in 900..908 {
        let bytes: u64 = read(slot, "memory.current").trim().parse().unwrap();
        let peak: u64 = read(slot, "memory.peak").trim().parse().unwrap_or(0);
        assert!(
            peak < 16 << 20,
            "the build of a slot peaked at {peak} bytes"
        );
        println!(
            "slot_lab idle slot {slot}: memory.current={} KiB memory.peak={} KiB anon={} KiB file={} KiB slab={} KiB kernel={} KiB pids={}",
            bytes / 1024,
            peak / 1024,
            stat(slot, "anon ") / 1024,
            stat(slot, "file ") / 1024,
            stat(slot, "slab ") / 1024,
            stat(slot, "kernel ") / 1024,
            read(slot, "pids.current").trim(),
        );
        current.push(bytes as f64 / (1024.0 * 1024.0));
    }
    let (_, p95) = report("idle slot memory.current in MiB", current.clone());
    // The ceiling of the unit file (32 MiB) holds each with room to spare.
    assert!(current.iter().all(|mib| *mib < 28.0), "{current:?}");
    println!(
        "slot_lab eight idle slots together: {:.1} MiB (p95 of one: {p95:.1})",
        current.iter().sum::<f64>()
    );
}

/// An agent that dies loses its table and nothing else: the slots run on, and the next agent reads
/// them back from the kernel. After a boot there is nothing to read: the units are gone with
/// `/run`, the users stay.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn slots_are_adopted_after_the_agent_dies_and_a_boot_leaves_nothing_to_adopt() {
    let (lab, database) = Lab::new("g").await;
    let pool = &lab.pool;
    for _ in 0..3 {
        pool.refill(3).await.unwrap();
    }
    let serving = pool.bind(&database.id, &database.bind(512)).await.unwrap();
    let started = pool.exec(&serving).await.unwrap();
    pool.refill(3).await.unwrap();
    let before: Vec<_> = {
        let mut units = pool.host().units().await.unwrap();
        units.sort_by_key(|unit| unit.slot);
        units
            .into_iter()
            .filter(|unit| {
                POOL.contains(&unit.slot) && !matches!(unit.active, ActiveState::Inactive)
            })
            .map(|unit| (unit.slot, unit.main_pid, unit.invocation_id))
            .collect()
    };

    // The agent is killed: its memory is gone. The next agent finds the idle slots idle and the
    // database's PostgreSQL serving, the same processes and the same invocations.
    let next = lab.another_pool(&database).await;
    let adopted = next.adopt().await.unwrap();
    assert_eq!(adopted.serving, std::slice::from_ref(&database.id));
    assert_eq!(adopted.idle.len(), 3, "{adopted:?}");
    assert!(adopted.tainted.is_empty());
    let after: Vec<_> = {
        let mut units = next.host().units().await.unwrap();
        units.sort_by_key(|unit| unit.slot);
        units
            .into_iter()
            .filter(|unit| {
                POOL.contains(&unit.slot) && !matches!(unit.active, ActiveState::Inactive)
            })
            .map(|unit| (unit.slot, unit.main_pid, unit.invocation_id))
            .collect()
    };
    assert_eq!(before, after);
    let again = next.wait_started(&database.id).await.unwrap();
    assert_eq!(
        (again.main_pid, again.invocation_id.as_str(), again.uid),
        (
            started.main_pid,
            started.invocation_id.as_str(),
            started.uid
        )
    );
    assert!(matches!(
        next.bind(&database.id, &database.bind(512)).await,
        Err(Error::Held)
    ));
    // An idle slot of the next agent is bound at once.
    assert_eq!(next.snapshot().idle, 3);

    // The agent dies between the bind and the order: the mounts are in, PostgreSQL never ran. The
    // next agent stops the slot, and the database holds nothing.
    assert!(next.stop(&database.id).await.unwrap());
    let half = next.bind(&database.id, &database.bind(512)).await.unwrap();
    let latest = lab.another_pool(&database).await;
    let adopted = latest.adopt().await.unwrap();
    assert_eq!(adopted.tainted, [(half.slot, database.id.clone())]);
    assert_eq!(show(&slot_unit(half.slot), "ActiveState"), "inactive");
    latest
        .bind(&database.id, &database.bind(512))
        .await
        .unwrap();
    assert!(latest.stop(&database.id).await.unwrap());

    // A boot: what lived in `/run` and in memory is gone, and the users of the slots stay.
    latest.drain_idle().await;
    for slot in POOL {
        quiet("systemctl", &["stop", &slot_unit(slot)]);
    }
    let _ = fs::remove_dir_all("/run/pgcf/slot");
    let booted = lab.another_pool(&database).await;
    let adopted = booted.adopt().await.unwrap();
    assert_eq!(adopted, slots::Adopted::default());
    assert!(booted.host().users().contains(&900), "the users stay");
    assert!(booted.refill(2).await.unwrap().is_some());
    let bound = booted
        .bind(&database.id, &database.bind(512))
        .await
        .unwrap();
    assert_eq!(bound.from, SlotFrom::Pool);
    booted.exec(&bound).await.unwrap();
    assert!(booted.stop(&database.id).await.unwrap());
}

/// The handoff does not grow with the size of the agent: the user namespace is made by a child that
/// shares the agent's memory, so a bind made when the process is large takes what it takes when
/// it is small. Bind times of 12 binds each, with the process at its own size and with half a
/// gibibyte resident.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn a_bind_takes_the_same_time_whatever_the_agent_has_resident() {
    let (lab, database) = Lab::new("h").await;
    let pool = &lab.pool;
    async fn binds(pool: &Pool<System<LabLvm>>, database: &Database, n: usize) -> Vec<f64> {
        let mut times = Vec::new();
        for _ in 0..n {
            pool.refill(1).await.unwrap();
            let began = Instant::now();
            let bound = pool.bind(&database.id, &database.bind(512)).await.unwrap();
            times.push(began.elapsed().as_secs_f64() * 1000.0);
            pool.exec(&bound).await.unwrap();
            assert!(pool.stop(&database.id).await.unwrap());
        }
        times
    }
    let small = binds(pool, &database, 12).await;
    let (small_p50, _) = report("bind at the lab's own size", small);
    let mut resident = vec![0u8; 512 << 20];
    for page in resident.iter_mut().step_by(4096) {
        *page = 1;
    }
    let large = binds(pool, &database, 12).await;
    let (large_p50, large_p95) = report("bind with 512 MiB resident", large);
    std::hint::black_box(&resident);
    assert!(
        large_p50 < small_p50 + 10.0,
        "{small_p50} ms against {large_p50} ms"
    );
    assert!(large_p95 < 150.0, "{large_p95} ms");
}
