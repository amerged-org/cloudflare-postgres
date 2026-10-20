// SPDX-License-Identifier: Apache-2.0
//! The idmapped handoff (`idmap`) against a real kernel and a real systemd. A slot is a transient
//! unit with the namespace directives of `pgcf-pg@.service`, started before the database exists as
//! a pooled slot is; the database's volume (an ext4 on a loop device) and socket directory are
//! handed to it. The tests run as root on a Debian 13 host with systemd as PID 1 (Linux 6.3 or
//! newer, for the idmapped tmpfs), util-linux, e2fsprogs and perl, one at a time, and exist only in
//! a build made for them: the kernel step of CI runs every ignored test in an unprivileged
//! container and must not meet them. The test binary must run as the agent runs, in a mount
//! namespace of its own with the propagation that `PrivateMounts=yes` of `pgcf-agent.service` gives
//! it, so that the lab's volumes stay out of PID 1's namespace, which every unit's executor
//! copies, and every mount of the lab is a member of a peer group (`shared:N`), as every mount of
//! the agent is. A namespace made with `unshare --mount --propagation slave` is not that: its
//! mounts are private and hide any coupling between the agent's mounts and a slot's. `Lab::new`
//! refuses a namespace that is not the agent's:
//!
//! ```sh
//! RUSTFLAGS='--cfg pgcf_idmap_lab' cargo test -p pgcf-node-agent --lib --no-run
//! systemd-run --wait --pipe -p PrivateMounts=yes <test binary> --test-threads=1 --nocapture units::idmap_lab
//! ```
//!
//! Everything the lab makes lives under `/var/tmp/pgcf-lab`, in the mounts `/var/lib/pgcf/db/labidm*`
//! and `/run/pgcf/labidm*`, in the units `pgcf-lab-slot-*` and in the users `pgcf-lab-*`, and is
//! removed again. The lab does not touch a database, a slot or a user of the node.
//!
//! The last test is the acceptance of the handoff on a quiet node: it prints the times of 24
//! handoffs and fails above 6 ms at p50 or 12 ms at p95.
use super::idmap::{self, Ids, Kind, Mount, UserNamespace, hand_over};
use std::{
    fs,
    io::{BufRead, BufReader},
    os::{
        fd::{AsFd, BorrowedFd, FromRawFd, OwnedFd},
        unix::{
            fs::{MetadataExt, OpenOptionsExt, chown},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

const SCRATCH: &str = "/var/tmp/pgcf-lab";
/// Ids like the node's (a database's from 200000, a slot's from 300000) where none of its
/// databases or slots are.
const DB_ID: u32 = 298_001;
const SLOT_ID: u32 = 398_001;
const GATEWAY_ID: u32 = 398_501;
const DB_USER: &str = "pgcf-lab-db";
const SLOT_USER: &str = "pgcf-lab-slot";
const GATEWAY_USER: &str = "pgcf-lab-gw";
/// What the kernel shows for an id the user namespace does not map.
const OVERFLOW: u32 = 65_534;

/// The directives of `pgcf-pg@.service` that build the unit's mount namespace and its other
/// namespaces, minus `MountImages=` and `ReadWritePaths=`, which the handoff replaces. The
/// directives of the system-call filter and the limits are left out: they do not change a mount.
const SANDBOX: &[&str] = &[
    "Type=exec",
    "PrivateNetwork=yes",
    "RestrictAddressFamilies=AF_UNIX",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "PrivateIPC=yes",
    "TemporaryFileSystem=/dev/shm:size=64M,mode=1777,noexec,nosuid,nodev",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "NoNewPrivileges=yes",
    "CapabilityBoundingSet=",
    "RemoveIPC=yes",
    "UMask=0077",
];

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

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let rank = (sorted.len() as f64 * fraction).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}
/// Prints `name: n=.. p50=.. p95=.. max=..` in milliseconds and returns (p50, p95).
fn report(name: &str, mut millis: Vec<f64>) -> (f64, f64) {
    millis.sort_by(f64::total_cmp);
    let (p50, p95) = (percentile(&millis, 0.5), percentile(&millis, 0.95));
    println!(
        "idmap_lab {name}: n={} p50={p50:.2} ms p95={p95:.2} ms max={:.2} ms",
        millis.len(),
        millis[millis.len() - 1]
    );
    (p50, p95)
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

/// The lab runs one test at a time: the users, the scratch directory and the units are shared.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
static LABS: AtomicU64 = AtomicU64::new(0);

/// A database for the handoff: a volume (an ext4 on a loop device) mounted at
/// `/var/lib/pgcf/db/<id>` in the lab's mount namespace, owned by the database's user with a
/// `data` directory, and a socket directory `/run/pgcf/<id>` of the database's user and the
/// gateway's group, mode 0750.
struct Lab {
    id: String,
    root: PathBuf,
    sockets: PathBuf,
    dir: PathBuf,
    loop_device: String,
    _one_at_a_time: MutexGuard<'static, ()>,
}

impl Lab {
    fn new() -> Lab {
        let guard = ONE_AT_A_TIME.lock().unwrap_or_else(PoisonError::into_inner);
        assert_ne!(
            fs::read_link("/proc/1/ns/mnt").unwrap(),
            fs::read_link("/proc/self/ns/mnt").unwrap(),
            "run the lab under `systemd-run --wait --pipe -p PrivateMounts=yes`"
        );
        assert!(
            !groups_at(&peer_groups("/proc/self/mountinfo"), Path::new("/")).is_empty(),
            "the lab's mounts are private, the agent's are shared: run the lab under \
             `systemd-run --wait --pipe -p PrivateMounts=yes`"
        );
        assert!(
            Path::new("/run/systemd/system").is_dir(),
            "the lab needs systemd as PID 1"
        );
        account(DB_USER, DB_ID);
        account(SLOT_USER, SLOT_ID);
        account(GATEWAY_USER, GATEWAY_ID);
        let id = format!(
            "labidm{:014}",
            u64::from(std::process::id()) * 100 + LABS.fetch_add(1, Ordering::Relaxed)
        );
        Lab {
            root: Path::new("/var/lib/pgcf/db").join(&id),
            sockets: Path::new("/run/pgcf").join(&id),
            dir: Path::new(SCRATCH).join(&id),
            id,
            loop_device: String::new(),
            _one_at_a_time: guard,
        }
    }

    /// Makes the database: its volume and its socket directory. A test makes it after the slot has
    /// started, as the agent does: the slot has existed before the database did.
    fn provide(&mut self) {
        fs::create_dir_all(&self.dir).unwrap();
        let image = self.dir.join("volume.img");
        fs::File::create(&image).unwrap().set_len(64 << 20).unwrap();
        let loop_device = sh("losetup", &["-f", "--show", image.to_str().unwrap()]);
        if !Path::new(&loop_device).exists() {
            let number = loop_device.trim_start_matches("/dev/loop");
            sh("mknod", &[&loop_device, "b", "7", number]);
        }
        sh("mkfs.ext4", &["-F", "-q", &loop_device]);
        fs::create_dir_all(&self.root).unwrap();
        sh(
            "mount",
            &[
                "-t",
                "ext4",
                "-o",
                "nosuid,nodev,noexec,noatime",
                &loop_device,
                self.root.to_str().unwrap(),
            ],
        );
        chown(&self.root, Some(DB_ID), Some(DB_ID)).unwrap();
        fs::create_dir(self.root.join("data")).unwrap();
        chown(self.root.join("data"), Some(DB_ID), Some(DB_ID)).unwrap();
        fs::create_dir_all(&self.sockets).unwrap();
        chown(&self.sockets, Some(DB_ID), Some(GATEWAY_ID)).unwrap();
        sh("chmod", &["0750", self.sockets.to_str().unwrap()]);
        self.loop_device = loop_device;
    }

    fn ids() -> Ids {
        Ids {
            db_uid: DB_ID,
            db_gid: DB_ID,
            slot_uid: SLOT_ID,
            slot_gid: SLOT_ID,
            gateway_gid: GATEWAY_ID,
        }
    }

    /// The volume with its device and the socket directory: what the agent hands a slot.
    fn mounts(&self) -> [Mount<'_>; 2] {
        let device = fs::metadata(&self.root).unwrap().dev();
        [
            Mount {
                path: &self.root,
                kind: Kind::Volume {
                    major: libc::major(device),
                    minor: libc::minor(device),
                },
            },
            Mount {
                path: &self.sockets,
                kind: Kind::Socket,
            },
        ]
    }

    /// Whether something holds the volume's filesystem: a mount of it, anywhere, makes an
    /// exclusive open of its device fail.
    fn filesystem_held(&self) -> bool {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_EXCL)
            .open(&self.loop_device)
            .is_err()
    }

    fn unmount_agent_side(&self) {
        sh("umount", &[self.root.to_str().unwrap()]);
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        quiet("umount", &["-l", self.root.to_str().unwrap()]);
        quiet("losetup", &["-d", &self.loop_device]);
        let _ = fs::remove_dir(&self.root);
        let _ = fs::remove_dir_all(&self.sockets);
        let _ = fs::remove_dir_all(&self.dir);
        let _ = fs::remove_dir(SCRATCH);
        for name in [SLOT_USER, DB_USER, GATEWAY_USER] {
            quiet("userdel", &[name]);
            quiet("groupdel", &[name]);
        }
    }
}

/// A slot: a transient unit with the sandbox of a database unit, running as the slot's user. It is
/// started with `Type=exec`, which returns once the executor has built the namespaces, as the
/// notify of a slot's supervisor does.
struct Slot {
    unit: String,
    pid: u32,
    pidfd: OwnedFd,
}

impl Slot {
    fn start() -> Slot {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let unit = format!(
            "pgcf-lab-slot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut args = vec![
            "--quiet".to_string(),
            "--collect".to_string(),
            format!("--unit={unit}"),
            format!("--uid={SLOT_USER}"),
            format!("--gid={SLOT_USER}"),
        ];
        for directive in SANDBOX {
            args.push("-p".to_string());
            args.push((*directive).to_string());
        }
        args.extend(["/usr/bin/sleep".to_string(), "infinity".to_string()]);
        sh(
            "systemd-run",
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let pid: u32 = sh("systemctl", &["show", "-p", "MainPID", "--value", &unit])
            .parse()
            .unwrap();
        assert_ne!(pid, 0, "{unit} has no main process");
        // SAFETY: plain syscall; the descriptor is new.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        assert!(fd >= 0, "pidfd_open: {}", std::io::Error::last_os_error());
        // SAFETY: the kernel just returned this descriptor and nothing else owns it.
        let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        Slot { unit, pid, pidfd }
    }
    fn pidfd(&self) -> BorrowedFd<'_> {
        self.pidfd.as_fd()
    }
    fn stop(&self) {
        sh("systemctl", &["stop", &self.unit]);
    }
    /// A command in the slot's mount namespace as a user without groups.
    fn command(&self, uid: u32, gid: u32, script: &str) -> Command {
        let mut command = Command::new("nsenter");
        command.args([
            "--target",
            &self.pid.to_string(),
            "--mount",
            "--",
            "setpriv",
            &format!("--reuid={uid}"),
            &format!("--regid={gid}"),
            "--clear-groups",
            "sh",
            "-c",
            script,
        ]);
        command
    }
    fn run(&self, uid: u32, gid: u32, script: &str) -> Output {
        self.command(uid, gid, script).output().unwrap()
    }
    fn run_ok(&self, uid: u32, gid: u32, script: &str) -> String {
        let output = self.run(uid, gid, script);
        assert!(
            output.status.success(),
            "{script}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
    /// The slot's mount table: (mount point, device, options).
    fn mounts(&self) -> Vec<(String, String, String)> {
        mount_table(&format!("/proc/{}/mountinfo", self.pid))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        quiet("systemctl", &["stop", &self.unit]);
        quiet("systemctl", &["reset-failed", &self.unit]);
    }
}

/// (mount point, `major:minor`, options) of every line of a mountinfo.
fn mount_table(file: &str) -> Vec<(String, String, String)> {
    fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(|line| {
            let words: Vec<&str> = line.split(' ').collect();
            (
                words[4].to_string(),
                words[2].to_string(),
                words[5].to_string(),
            )
        })
        .collect()
}
fn mount_at<'a>(
    table: &'a [(String, String, String)],
    path: &Path,
) -> Option<&'a (String, String, String)> {
    table.iter().find(|(point, ..)| Path::new(point) == path)
}
fn has_options(options: &str, wanted: &[&str]) -> bool {
    let present: Vec<&str> = options.split(',').collect();
    wanted.iter().all(|option| present.contains(option))
}

/// (mount point, peer group) for every `shared:N` in the optional fields of a mountinfo, so a
/// mount in two groups is listed twice. The numbers are the kernel's, the same in every namespace.
fn peer_groups(file: &str) -> Vec<(PathBuf, u64)> {
    let mut groups = Vec::new();
    for line in fs::read_to_string(file).unwrap().lines() {
        let words: Vec<&str> = line.split(' ').collect();
        let end = words.iter().position(|word| *word == "-").unwrap();
        for field in &words[6..end] {
            if let Some(group) = field.strip_prefix("shared:") {
                groups.push((PathBuf::from(words[4]), group.parse().unwrap()));
            }
        }
    }
    groups
}
/// The groups of the mounts at `path`.
fn groups_at(groups: &[(PathBuf, u64)], path: &Path) -> Vec<u64> {
    groups
        .iter()
        .filter(|(point, _)| point == path)
        .map(|(_, group)| *group)
        .collect()
}

fn ids_of(path: &Path) -> String {
    let metadata = fs::metadata(path).unwrap();
    format!("{}:{}", metadata.uid(), metadata.gid())
}

/// The volume and the socket directory of a database arrive in a slot under `ProtectSystem=strict`
/// at their paths on the node, owned by the slot's user; what the slot's user makes there is owned
/// by the database's user on disk; and nothing of it is in PID 1's mount namespace.
#[test]
fn the_slot_gets_the_volume_and_the_socket_directory_as_its_own_under_strict_protection() {
    let mut lab = Lab::new();
    let slot = Slot::start();
    lab.provide();
    let root = lab.root.to_str().unwrap();
    let sockets = lab.sockets.to_str().unwrap();
    let before = slot.run(SLOT_ID, SLOT_ID, &format!("test -d {root}/data"));
    assert!(
        !before.status.success(),
        "the volume is in the slot before the handoff"
    );

    hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap();

    let own = format!("{SLOT_ID}:{SLOT_ID}");
    assert_eq!(
        slot.run_ok(
            SLOT_ID,
            SLOT_ID,
            &format!("stat -c %u:%g {root} {root}/data")
        ),
        format!("{own}\n{own}")
    );
    // The group of the socket directory is the gateway's, which the map leaves as it is.
    assert_eq!(
        slot.run_ok(SLOT_ID, SLOT_ID, &format!("stat -c %u:%g {sockets}")),
        format!("{SLOT_ID}:{GATEWAY_ID}")
    );
    // A file made in the slot is the slot's there and the database's on disk.
    assert_eq!(
        slot.run_ok(
            SLOT_ID,
            SLOT_ID,
            &format!("touch {root}/data/made && stat -c %u:%g {root}/data/made")
        ),
        own
    );
    assert_eq!(
        ids_of(&lab.root.join("data/made")),
        format!("{DB_ID}:{DB_ID}")
    );
    // A file of any other owner shows as nobody. The slot can read it and cannot write it, even
    // with mode 0666: the kernel refuses a write to an inode it cannot map the ids of.
    let foreign = lab.root.join("data/foreign");
    fs::write(&foreign, "x").unwrap();
    fs::set_permissions(
        &foreign,
        std::os::unix::fs::PermissionsExt::from_mode(0o666),
    )
    .unwrap();
    assert_eq!(
        slot.run_ok(
            SLOT_ID,
            SLOT_ID,
            &format!("stat -c %u:%g {root}/data/foreign")
        ),
        format!("{OVERFLOW}:{OVERFLOW}")
    );
    assert_eq!(
        slot.run_ok(SLOT_ID, SLOT_ID, &format!("cat {root}/data/foreign")),
        "x"
    );
    assert!(
        !slot
            .run(SLOT_ID, SLOT_ID, &format!("echo y >> {root}/data/foreign"))
            .status
            .success()
    );
    assert_eq!(fs::read_to_string(&foreign).unwrap(), "x");
    // The rest of the slot's file system is still read-only.
    assert!(
        !slot
            .run(SLOT_ID, SLOT_ID, "touch /var/lib/pgcf/db/probe")
            .status
            .success()
    );
    assert!(
        !slot
            .run(0, 0, "touch /var/lib/pgcf/db/probe")
            .status
            .success()
    );

    // The clones carry the attributes of their kind.
    let table = slot.mounts();
    let agent = mount_table("/proc/self/mountinfo");
    let (_, volume_device, volume) = mount_at(&table, &lab.root).expect("the volume is mounted");
    assert!(
        has_options(
            volume,
            &["rw", "nosuid", "nodev", "noexec", "noatime", "idmapped"]
        ),
        "{volume}"
    );
    assert_eq!(
        volume_device,
        &mount_at(&agent, &lab.root).unwrap().1,
        "the clone is the agent's filesystem"
    );
    let (_, _, socket) = mount_at(&table, &lab.sockets).expect("the socket directory is mounted");
    assert!(
        has_options(socket, &["rw", "nosuid", "nodev", "noexec", "idmapped"]),
        "{socket}"
    );
    // The agent's own mount is not idmapped, and PID 1 has none of them.
    assert!(!mount_at(&agent, &lab.root).unwrap().2.contains("idmapped"));
    let init = mount_table("/proc/1/mountinfo");
    assert!(mount_at(&init, &lab.root).is_none());
    assert!(mount_at(&init, &lab.sockets).is_none());
}

/// The agent's mounts are shared (`PrivateMounts=yes`), and a clone of one that kept its peer group
/// would be a peer of it: a mount made on or under either would appear in the other and in every
/// other slot that holds the volume. The slot's mounts are in groups of their own.
#[test]
fn the_slots_mounts_are_not_peers_of_the_agents_or_of_another_slots() {
    let mut lab = Lab::new();
    let slots = [Slot::start(), Slot::start()];
    lab.provide();
    let agent_file = "/proc/self/mountinfo";
    let agent = peer_groups(agent_file);
    assert!(
        !groups_at(&agent, &lab.root).is_empty(),
        "the agent's volume is not shared"
    );
    for slot in &slots {
        hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap();
    }
    // The socket directory is a directory of the agent's /run, so its clone is a clone of that
    // mount: it must not be in the group of /run either.
    let mut seen: Vec<u64> = agent.iter().map(|(_, group)| *group).collect();
    for slot in &slots {
        let slot_groups = peer_groups(&format!("/proc/{}/mountinfo", slot.pid));
        for path in [&lab.root, &lab.sockets] {
            let groups = groups_at(&slot_groups, path);
            for group in &groups {
                assert!(
                    !seen.contains(group),
                    "{} in {} is in the group {group} of another mount",
                    path.display(),
                    slot.unit
                );
            }
            seen.extend(groups);
        }
    }

    // A mount on the agent's volume does not reach the slots.
    let probe = lab.root.join("data/probe");
    fs::create_dir(&probe).unwrap();
    let probe_text = probe.to_str().unwrap();
    sh("mount", &["-t", "tmpfs", "tmpfs", probe_text]);
    fs::write(probe.join("marker"), "x").unwrap();
    for slot in &slots {
        assert!(
            mount_at(&slot.mounts(), &probe).is_none(),
            "a mount under the agent's volume reached {}",
            slot.unit
        );
        assert_eq!(
            slot.run_ok(SLOT_ID, SLOT_ID, &format!("ls -A {probe_text}")),
            "",
            "the content of a mount under the agent's volume reached {}",
            slot.unit
        );
    }
    sh("umount", &[probe_text]);

    // A mount on a slot's volume reaches neither the agent nor the other slot.
    slots[0].run_ok(0, 0, &format!("mount -t tmpfs tmpfs {probe_text}"));
    assert!(mount_at(&slots[0].mounts(), &probe).is_some());
    assert!(
        mount_at(&mount_table(agent_file), &probe).is_none(),
        "a mount under a slot's volume reached the agent"
    );
    assert!(
        mount_at(&slots[1].mounts(), &probe).is_none(),
        "a mount under a slot's volume reached another slot"
    );
}

/// The gateway's group dials a socket that PostgreSQL makes in the idmapped socket directory, and
/// the peer it sees is the slot's user and the listener's process: what the gateway checks.
#[test]
fn the_gateways_group_dials_a_socket_made_in_the_idmapped_socket_directory() {
    let mut lab = Lab::new();
    let slot = Slot::start();
    lab.provide();
    hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap();
    let socket = lab.sockets.join(".s.PGSQL.5432");
    let socket_text = socket.to_str().unwrap();

    let mut listener = Killed(slot
        .command(
            SLOT_ID,
            SLOT_ID,
            &format!(
                "exec perl -MSocket -e '\
                 my $p = shift; socket(my $s, PF_UNIX, SOCK_STREAM, 0) or die \"socket: $!\"; \
                 bind($s, sockaddr_un($p)) or die \"bind: $!\"; chmod(0777, $p) or die \"chmod: $!\"; \
                 listen($s, 1) or die \"listen: $!\"; $| = 1; print \"ready $$\\n\"; \
                 accept(my $c, $s) or die \"accept: $!\"; print $c \"pong\\n\"; close $c;' {socket_text}"
            ),
        )
        .stdout(Stdio::piped())
        .spawn()
        .unwrap());
    let mut ready = String::new();
    BufReader::new(listener.0.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let listener_pid: u32 = ready
        .trim()
        .strip_prefix("ready ")
        .expect(&ready)
        .parse()
        .unwrap();

    // The socket is the slot's user's in the slot and the database's on disk.
    assert_eq!(ids_of(&socket), format!("{DB_ID}:{DB_ID}"));
    let dial = Command::new("perl")
        .args([
            "-MSocket",
            "-e",
            "my $p = shift; socket(my $s, PF_UNIX, SOCK_STREAM, 0) or die \"socket: $!\"; \
             connect($s, sockaddr_un($p)) or die \"connect: $!\"; my $l = <$s>; chomp $l; \
             my ($pid, $uid, $gid) = unpack('iII', getsockopt($s, SOL_SOCKET, SO_PEERCRED)); \
             print \"$l $pid $uid $gid\\n\";",
            socket_text,
        ])
        .uid(GATEWAY_ID)
        .gid(GATEWAY_ID)
        .output()
        .unwrap();
    assert!(
        dial.status.success(),
        "the gateway's group cannot dial: {}",
        String::from_utf8_lossy(&dial.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&dial.stdout).trim(),
        format!("pong {listener_pid} {SLOT_ID} {SLOT_ID}")
    );
    listener.0.wait().unwrap();
}

/// The slot's mount holds the filesystem while the slot lives and ends with it: nothing of the
/// handoff outlives the unit, with no descriptor of the agent's keeping it.
#[test]
fn the_mount_holds_the_filesystem_while_the_slot_lives_and_ends_with_it() {
    let mut lab = Lab::new();
    let slot = Slot::start();
    lab.provide();
    hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap();
    // The agent's own mount can go: the slot's is a mount of its own.
    lab.unmount_agent_side();
    assert!(
        lab.filesystem_held(),
        "the slot's mount holds the filesystem"
    );
    slot.stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while lab.filesystem_held() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !lab.filesystem_held(),
        "the filesystem is still held after the slot has ended"
    );
}

/// A handoff that fails holds nothing: not the clones, and not the user namespace.
#[test]
fn a_handoff_to_an_ended_slot_fails_and_holds_nothing() {
    let mut lab = Lab::new();
    let slot = Slot::start();
    lab.provide();
    slot.stop();
    let error = hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap_err();
    println!("idmap_lab ended slot: {error}");
    lab.unmount_agent_side();
    assert!(!lab.filesystem_held(), "the failed handoff keeps a mount");
}

/// A volume is only the device that was asked for, and a symlink at the end of the target is not
/// followed.
#[test]
fn a_wrong_device_is_refused_and_a_symlink_at_the_target_is_not_followed() {
    let mut lab = Lab::new();
    let slot = Slot::start();
    lab.provide();
    let mut wrong = lab.mounts();
    if let Kind::Volume { major, minor } = wrong[0].kind {
        wrong[0].kind = Kind::Volume {
            major,
            minor: minor + 1,
        };
    }
    let error = hand_over(slot.pidfd(), &Lab::ids(), &wrong).unwrap_err();
    assert!(error.to_string().contains("not the volume"), "{error}");
    assert!(mount_at(&slot.mounts(), &lab.root).is_none());

    // The clone of a volume goes to a real directory and is refused at a symlink to it.
    let namespace = UserNamespace::new(&Lab::ids()).unwrap();
    let planned = idmap::plan(&lab.mounts()[..1]).unwrap();
    let tree = idmap::clone_tree(&planned[0], &namespace).unwrap();
    let real = PathBuf::from(format!("/var/lib/pgcf/db/{}-real", lab.id));
    let link = PathBuf::from(format!("/var/lib/pgcf/db/{}-link", lab.id));
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let cleanup = Cleanup(vec![real.clone(), link.clone()]);
    let to = |path: &Path| std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    let through_the_link = idmap::move_into(slot.pidfd(), &[(tree.as_fd(), to(&link).as_c_str())]);
    assert!(through_the_link.is_err(), "the symlink was followed");
    assert!(mount_at(&slot.mounts(), &real).is_none());
    idmap::move_into(slot.pidfd(), &[(tree.as_fd(), to(&real).as_c_str())]).unwrap();
    assert!(mount_at(&slot.mounts(), &real).is_some());
    drop(cleanup);
}

/// A process in a slot's namespace that must not outlive the test: it would hold the slot's mounts.
struct Killed(std::process::Child);
impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Removes paths the lab made on the host's side of the slot.
struct Cleanup(Vec<PathBuf>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
            let _ = fs::remove_dir(path);
        }
    }
}

/// The time of `fork` and the wait for the child: a user namespace made by a forked child would
/// cost at least this, and the more the more memory the process holds.
fn fork_millis() -> f64 {
    let started = Instant::now();
    // SAFETY: the child makes one call that is async-signal-safe and ends.
    unsafe {
        let pid = libc::fork();
        assert!(pid >= 0);
        if pid == 0 {
            libc::_exit(0);
        }
        let mut status = 0;
        libc::waitpid(pid, &mut status, 0);
    }
    started.elapsed().as_secs_f64() * 1000.0
}
fn userns_millis() -> f64 {
    let started = Instant::now();
    let namespace = UserNamespace::new(&Lab::ids()).unwrap();
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    drop(namespace);
    elapsed
}
fn resident_mib() -> u64 {
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let line = status.lines().find(|l| l.starts_with("VmRSS:")).unwrap();
    line.split_whitespace()
        .nth(1)
        .unwrap()
        .parse::<u64>()
        .unwrap()
        / 1024
}

/// The user namespace costs the same in a small process and in one that holds a lot of memory,
/// where a `fork` costs more the more the process holds. `PGCF_LAB_BALLAST_MIB` sets the memory
/// (default 512).
#[test]
fn the_user_namespace_costs_the_same_at_any_resident_size() {
    let _lab = Lab::new();
    let small = resident_mib();
    let (small_userns, _) = report("userns small", (0..30).map(|_| userns_millis()).collect());
    let (small_fork, _) = report("fork small", (0..30).map(|_| fork_millis()).collect());
    let ballast_mib: usize = std::env::var("PGCF_LAB_BALLAST_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(512);
    let mut ballast = vec![1u8; ballast_mib << 20];
    for page in ballast.chunks_mut(4096) {
        page[0] = 2;
    }
    println!(
        "idmap_lab resident: {small} MiB small, {} MiB with the ballast",
        resident_mib()
    );
    let (large_userns, _) = report("userns large", (0..30).map(|_| userns_millis()).collect());
    let (large_fork, _) = report("fork large", (0..30).map(|_| fork_millis()).collect());
    drop(ballast);
    assert!(
        large_userns <= small_userns + 1.0,
        "the user namespace grows with the resident size: {small_userns:.2} ms to {large_userns:.2} ms"
    );
    println!("idmap_lab fork p50 {small_fork:.2} ms to {large_fork:.2} ms with the same ballast");
}

/// A storm of wakes hands over to several slots at once, from several threads of the agent: every
/// handoff gets its own user namespace and every slot its own mounts. Each round stacks one more
/// pair of mounts on the same paths in each slot.
#[test]
fn handoffs_from_eight_threads_at_once_reach_eight_slots() {
    const SLOTS: usize = 8;
    const ROUNDS: usize = 10;
    let mut lab = Lab::new();
    let slots: Vec<Slot> = (0..SLOTS).map(|_| Slot::start()).collect();
    lab.provide();
    for _ in 0..ROUNDS {
        let results: Vec<std::io::Result<()>> = std::thread::scope(|scope| {
            let handles: Vec<_> = slots
                .iter()
                .map(|slot| scope.spawn(|| hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts())))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for result in results {
            result.unwrap();
        }
    }
    let root = lab.root.to_str().unwrap();
    for slot in &slots {
        let table = slot.mounts();
        let at = |path: &Path| {
            table
                .iter()
                .filter(|(point, ..)| Path::new(point) == path)
                .count()
        };
        assert_eq!((at(&lab.root), at(&lab.sockets)), (ROUNDS, ROUNDS));
        let file = format!("data/from-{}", slot.pid);
        slot.run_ok(SLOT_ID, SLOT_ID, &format!("touch {root}/{file}"));
        assert_eq!(ids_of(&lab.root.join(file)), format!("{DB_ID}:{DB_ID}"));
    }
}

/// The acceptance of the handoff: the volume and the socket directory, 24 times, each into a slot
/// of its own, on a node that is quiet. p50 at most 6 ms and p95 at most 12 ms.
#[test]
fn a_handoff_takes_at_most_6_ms_at_p50_and_12_ms_at_p95_on_a_quiet_node() {
    let mut lab = Lab::new();
    lab.provide();
    let (mut handoffs, mut namespaces) = (Vec::new(), Vec::new());
    for _ in 0..24 {
        let slot = Slot::start();
        namespaces.push(userns_millis());
        let started = Instant::now();
        hand_over(slot.pidfd(), &Lab::ids(), &lab.mounts()).unwrap();
        handoffs.push(started.elapsed().as_secs_f64() * 1000.0);
        slot.stop();
    }
    report("user namespace alone", namespaces);
    let (p50, p95) = report("handoff of the volume and the socket directory", handoffs);
    assert!(p50 <= 6.0, "p50 {p50:.2} ms");
    assert!(p95 <= 12.0, "p95 {p95:.2} ms");
}
