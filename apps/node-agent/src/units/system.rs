// SPDX-License-Identifier: Apache-2.0
//! The slots' systemd and kernel (`slots::Host`) on a node: the unit over D-Bus (`Units`), the
//! idmapped handoff of the database's mounts (`idmap`), the supervisor's control socket, the
//! kernel's facts about a process, and the readiness of a postmaster by `inotify` and a `pidfd`.
//!
//! Nothing here polls. A start waits for systemd's job; the order waits for the supervisor's
//! answer; PostgreSQL's readiness waits for the postmaster's own write of `ready` to
//! `postmaster.pid` (it writes the status just before `READY=1`, which no longer ends a job, as
//! the supervisor sent its own long before) or for the process to end, whichever the kernel tells
//! first.
use super::{
    Error, Units,
    idmap::{self, Ids, Kind, Mount},
    limits::Property,
    ready,
    slots::{
        self, Bind, Exe, Facts, Host, MAJOR, Ordered, SlotUnit, Spawned, slot_account, slot_of,
        slot_uid, slot_unit,
    },
};
use crate::{
    layout::Layout,
    storage::{CommandRunner, Storage, SystemRunner},
};
use std::{
    collections::{BTreeSet, HashMap},
    io,
    os::{
        fd::{AsFd, AsRawFd, FromRawFd, OwnedFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock, PoisonError},
    time::{Duration, Instant},
};
use tokio::{
    io::unix::AsyncFd,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// How long the supervisor has to answer a line.
const CONVERSATION_BOUND: Duration = Duration::from_secs(10);
/// What the supervisor answers a `ping`.
const IDLE: &str = "pgcf-slot/1 idle";
/// The group of the gateway, which the socket directory's idmap maps to itself.
const GATEWAY_GROUP: &str = "pgcf-gateway";

/// Runs a program of the system to its end; its failure carries what it said.
pub(crate) async fn run(program: &str, arguments: &[&str]) -> io::Result<()> {
    let output = tokio::process::Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .output()
        .await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{program} ended with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

/// The node's systemd and kernel, for the slots. The storage's commands go where `R` says: to the
/// system, on a node; a lab may stand in for LVM alone.
pub struct System<R = SystemRunner> {
    units: Units,
    layout: Layout,
    storage: Arc<Storage<R>>,
    /// The pidfd of each slot's main process, with the process it is of.
    pidfds: Mutex<HashMap<u32, (u32, Arc<OwnedFd>)>>,
    gateway: OnceLock<u32>,
}

impl<R: CommandRunner + Send + Sync + 'static> System<R> {
    pub fn new(units: Units, layout: Layout, storage: Arc<Storage<R>>) -> Self {
        Self {
            units,
            layout,
            storage,
            pidfds: Mutex::new(HashMap::new()),
            gateway: OnceLock::new(),
        }
    }

    fn pidfds(&self) -> std::sync::MutexGuard<'_, HashMap<u32, (u32, Arc<OwnedFd>)>> {
        self.pidfds.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The pidfd of the slot's main process `pid`: the one held, or a new one.
    fn pidfd(&self, slot: u32, pid: u32) -> io::Result<Arc<OwnedFd>> {
        let mut pidfds = self.pidfds();
        if let Some((held, fd)) = pidfds.get(&slot)
            && *held == pid
        {
            return Ok(fd.clone());
        }
        let fd = Arc::new(pidfd_open(pid)?);
        pidfds.insert(slot, (pid, fd.clone()));
        Ok(fd)
    }

    /// The control socket of a slot: `RuntimeDirectory=pgcf/slot/%i` of its unit.
    fn control(&self, slot: u32) -> PathBuf {
        self.layout
            .run
            .join("slot")
            .join(slot.to_string())
            .join("control")
    }

    /// One line to the supervisor and its one line back.
    async fn converse(&self, slot: u32, line: &str) -> io::Result<String> {
        let exchange = async {
            let mut stream = UnixStream::connect(self.control(slot)).await?;
            stream.write_all(format!("{line}\n").as_bytes()).await?;
            let mut answer = String::new();
            BufReader::new(stream).read_line(&mut answer).await?;
            Ok::<_, io::Error>(answer.trim_end().to_string())
        };
        tokio::time::timeout(CONVERSATION_BOUND, exchange)
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
    }

    fn gateway_gid(&self) -> io::Result<u32> {
        if let Some(gid) = self.gateway.get() {
            return Ok(*gid);
        }
        let group = std::fs::read_to_string("/etc/group")?;
        let gid = group_gid(&group, GATEWAY_GROUP)
            .ok_or_else(|| io::Error::other("the gateway's group does not exist"))?;
        Ok(*self.gateway.get_or_init(|| gid))
    }

    /// The program of a process, from its `/proc/<pid>/exe`.
    fn program(&self, pid: u32) -> Option<Exe> {
        let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        Some(program_at(
            &link,
            Path::new(&self.layout.archive_command),
            &self.layout.postgres_bin.join("postgres"),
        ))
    }

    /// The first process of the slot's cgroup, for a unit that has no main process.
    fn first_process(slot: u32) -> Option<u32> {
        let processes =
            std::fs::read_to_string(super::unit_cgroup_file(&slot_unit(slot), "cgroup.procs"))
                .ok()?;
        processes.lines().next()?.trim().parse().ok()
    }
}

fn pidfd_open(pid: u32) -> io::Result<OwnedFd> {
    // SAFETY: a plain system call with two integers; the descriptor it returns is ours alone.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
    match libc::c_int::try_from(fd) {
        // SAFETY: the kernel just returned this descriptor.
        Ok(fd) if fd >= 0 => Ok(unsafe { OwnedFd::from_raw_fd(fd) }),
        _ => Err(io::Error::last_os_error()),
    }
}

/// The gid of the group `name` in the text of `/etc/group`.
fn group_gid(text: &str, name: &str) -> Option<u32> {
    text.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.first() == Some(&name))
            .then(|| fields.get(2)?.parse().ok())
            .flatten()
    })
}

/// The numbers of the slot users in the text of `/etc/passwd`.
fn slot_users(passwd: &str) -> BTreeSet<u32> {
    passwd
        .lines()
        .filter_map(|line| {
            let name = line.split(':').next()?;
            let number: u32 = name.strip_prefix("pgcf-slot-")?.parse().ok()?;
            (number < slots::SLOT_COUNT && slot_account(number) == name).then_some(number)
        })
        .collect()
}

/// Which program a process runs, from its `exe` link: [`program_of`] with the paths of the
/// supervisor and of PostgreSQL as the image names them. The kernel names the file a process runs
/// by its real path, with every link followed, and the image names the supervisor by a link
/// (`/usr/libexec/pgcf/pgcf-archive`, which leads through `bin/current` to the running release),
/// so both are resolved first. The supervisor of an earlier release is not the file the link leads
/// to now: it is another program, and an idle slot that runs it is built again.
fn program_at(exe: &Path, supervisor: &Path, postgres: &Path) -> Exe {
    let resolved = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    program_of(exe, &resolved(supervisor), &resolved(postgres))
}

/// Which program a process runs, from its `exe` link. The link of a binary that a release
/// replaced says `(deleted)` after its path; the process still is that program.
fn program_of(link: &Path, supervisor: &Path, postgres: &Path) -> Exe {
    let text = link.to_string_lossy();
    let path = Path::new(text.strip_suffix(" (deleted)").unwrap_or(&text));
    if path == supervisor {
        Exe::Supervisor
    } else if path == postgres {
        Exe::Postgres
    } else {
        Exe::Other
    }
}

/// What the supervisor answers an `exec` order: the time it took the order (`exec <µs>`), or one
/// of the words of its refusals.
fn order_reply(line: &str) -> Result<u64, Error> {
    if let Some(micros) = line.strip_prefix("exec ") {
        return micros.parse().map_err(|_| Error::Refused("reply"));
    }
    Err(Error::Refused(
        ["order", "id", "major", "unbound", "held", "lock"]
            .into_iter()
            .find(|word| line.strip_prefix("refused ") == Some(word))
            .unwrap_or("reply"),
    ))
}

/// A lock of `/proc/locks`.
#[derive(Debug, PartialEq, Eq)]
struct Lock {
    flock: bool,
    pid: u32,
    major: u32,
    minor: u32,
    inode: u64,
}

/// The locks of the text of `/proc/locks`, one per line:
/// `1: FLOCK  ADVISORY  WRITE 2461 08:02:1055 0 EOF`, the device in hexadecimal. A waiter has
/// `->` before the type; it is no holder, and is left out.
fn locks(text: &str) -> Vec<Lock> {
    text.lines()
        .filter_map(|line| {
            let words: Vec<&str> = line.split_whitespace().collect();
            let kind = words.get(1)?;
            if *kind == "->" {
                return None;
            }
            let pid: u32 = words.get(4)?.parse().ok()?;
            let mut device = words.get(5)?.split(':');
            let major = u32::from_str_radix(device.next()?, 16).ok()?;
            let minor = u32::from_str_radix(device.next()?, 16).ok()?;
            let inode = device.next()?.parse().ok()?;
            Some(Lock {
                flock: *kind == "FLOCK",
                pid,
                major,
                minor,
                inode,
            })
        })
        .collect()
}

/// Whether the process `pid` holds an `flock` on the inode `data`.
fn holds_lock(pid: u32, data: &std::fs::Metadata, text: &str) -> bool {
    let (major, minor) = (libc::major(data.dev()), libc::minor(data.dev()));
    locks(text).iter().any(|lock| {
        lock.flock
            && lock.pid == pid
            && (lock.major, lock.minor, lock.inode) == (major, minor, data.ino())
    })
}

/// The cgroup of the process `pid` and the invocation ID systemd keeps on that cgroup, as the
/// kernel and systemd say them: the slot a caller of the archive socket is in, and which start of
/// it. `None` for what cannot be read, which no caller is trusted by.
pub fn peer_unit(pid: u32) -> (Option<String>, Option<String>) {
    if pid == 0 {
        return (None, None);
    }
    let cgroup = std::fs::read_to_string(format!("/proc/{pid}/cgroup"))
        .ok()
        .and_then(|text| unified_cgroup(&text));
    let invocation = cgroup.as_deref().and_then(invocation_of);
    (cgroup, invocation)
}

/// The path of the unified hierarchy in the text of `/proc/<pid>/cgroup`: the line `0::<path>`.
fn unified_cgroup(text: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix("0::"))
        .filter(|path| path.starts_with('/') && !path.split('/').any(|part| part == ".."))
        .map(str::to_string)
}

/// The invocation of the unit whose cgroup is `cgroup`: systemd writes it as the 32 hexadecimal
/// digits of `trusted.invocation_id` on the cgroup's directory, where only a process with
/// `CAP_SYS_ADMIN` can write or change it, and the journal reads it from there.
fn invocation_of(cgroup: &str) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(
        Path::new("/sys/fs/cgroup")
            .join(cgroup.trim_start_matches('/'))
            .as_os_str()
            .as_bytes(),
    )
    .ok()?;
    let mut value = [0u8; 64];
    // SAFETY: a NUL-terminated path and name, and a buffer of the length given.
    let length = unsafe {
        libc::getxattr(
            path.as_ptr(),
            c"trusted.invocation_id".as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    let value = value.get(..usize::try_from(length).ok()?)?;
    invocation_from_hex(std::str::from_utf8(value).ok()?)
}

/// The invocation ID as a UUID from its 32 hexadecimal digits.
fn invocation_from_hex(hex: &str) -> Option<String> {
    if hex.len() != 32 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = (0..16)
        .map(|at| u8::from_str_radix(&hex[2 * at..2 * at + 2], 16))
        .collect::<Result<_, _>>()
        .ok()?;
    super::invocation_uuid(&bytes)
}

/// An `inotify` watch of one directory, for what is written in it.
struct Watch(AsyncFd<OwnedFd>);
impl Watch {
    fn new(directory: &Path) -> io::Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        // SAFETY: a plain system call; the descriptor is ours alone.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the kernel just returned this descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let path = std::ffi::CString::new(directory.as_os_str().as_bytes())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: the descriptor is an inotify instance and the path a NUL-terminated string.
        let watch = unsafe {
            libc::inotify_add_watch(
                fd.as_raw_fd(),
                path.as_ptr(),
                libc::IN_CLOSE_WRITE | libc::IN_MOVED_TO | libc::IN_CREATE,
            )
        };
        if watch < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(AsyncFd::with_interest(
            fd,
            tokio::io::Interest::READABLE,
        )?))
    }

    /// Waits until something was written, and reads what is queued.
    async fn changed(&self) -> io::Result<()> {
        let mut ready = self.0.readable().await?;
        // The closure reads until the queue is empty and ends with the error that says so, which
        // is what clears the descriptor's readiness; only another error is an error.
        let drained = ready.try_io(|fd| {
            let mut buffer = [0u8; 4096];
            loop {
                // SAFETY: reads into a buffer that is ours, of the length given.
                let read =
                    unsafe { libc::read(fd.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
                if read < 0 {
                    return Err::<(), _>(io::Error::last_os_error());
                }
                if read == 0 {
                    return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
                }
            }
        });
        match drained {
            Ok(Err(error)) => Err(error),
            Ok(Ok(())) | Err(_) => Ok(()),
        }
    }
}

impl<R: CommandRunner + Send + Sync + 'static> Host for System<R> {
    async fn unit(&self, slot: u32) -> Result<SlotUnit, Error> {
        let raw = self.units.raw(&slot_unit(slot)).await?;
        Ok(SlotUnit {
            slot,
            active: raw.active,
            main_pid: raw.main_pid,
            invocation_id: raw.invocation_id,
            memory_max_bytes: raw.memory_max_bytes,
        })
    }

    async fn units(&self) -> Result<Vec<SlotUnit>, Error> {
        let names = self
            .units
            .loaded(&format!("{}*.service", slots::SLOT_PREFIX))
            .await?;
        let found = futures_util::future::try_join_all(
            names
                .iter()
                .filter_map(|name| slot_of(name))
                .map(|slot| self.unit(slot)),
        )
        .await?;
        // A process the agent did not start has a pidfd the agent has not: it is opened now.
        for unit in &found {
            if let Some(pid) = unit.main_pid {
                let _ = self.pidfd(unit.slot, pid);
            }
        }
        Ok(found)
    }

    fn users(&self) -> BTreeSet<u32> {
        std::fs::read_to_string("/etc/passwd")
            .map(|passwd| slot_users(&passwd))
            .unwrap_or_default()
    }

    async fn ensure_user(&self, slot: u32) -> Result<(), Error> {
        if self.users().contains(&slot) {
            return Ok(());
        }
        let (name, id) = (slot_account(slot), slot_uid(slot).to_string());
        run("groupadd", &["-g", &id, &name]).await?;
        run(
            "useradd",
            &[
                "-u",
                &id,
                "-g",
                &name,
                "-M",
                "-s",
                "/usr/sbin/nologin",
                "-d",
                "/nonexistent",
                &name,
            ],
        )
        .await?;
        Ok(())
    }

    async fn set(&self, slot: u32, properties: &[Property]) -> Result<(), Error> {
        self.units
            .set_properties(&slot_unit(slot), true, properties)
            .await
    }

    async fn start(&self, slot: u32) -> Result<Spawned, Error> {
        let unit = slot_unit(slot);
        let requested_us = self.units.start_job(&unit).await?;
        let raw = self.units.raw(&unit).await?;
        let main_pid = raw.main_pid.ok_or(Error::NotReady("no_main_pid"))?;
        self.pidfd(slot, main_pid)?;
        if self.program(main_pid) != Some(Exe::Supervisor) {
            return Err(Error::Unexpected("a slot that does not run its supervisor"));
        }
        Ok(Spawned {
            main_pid,
            invocation_id: raw
                .invocation_id
                .ok_or(Error::NotReady("no_invocation_id"))?,
            requested_us,
        })
    }

    async fn stop(&self, slot: u32) -> Result<(), Error> {
        self.units.stop_job(&slot_unit(slot)).await?;
        self.pidfds().remove(&slot);
        Ok(())
    }

    async fn ping(&self, slot: u32) -> Result<(), Error> {
        if self.converse(slot, "ping").await? == IDLE {
            Ok(())
        } else {
            Err(Error::Refused("reply"))
        }
    }

    fn alive(&self, slot: u32) -> bool {
        let Some((_, fd)) = self.pidfds().get(&slot).cloned() else {
            return false;
        };
        let mut poll = libc::pollfd {
            fd: fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one pollfd that lives through the call, and a zero timeout.
        let ready = unsafe { libc::poll(&raw mut poll, 1, 0) };
        // A pidfd becomes readable when the process has ended.
        ready == 0
    }

    fn uid(&self, slot: u32) -> u32 {
        slot_uid(slot)
    }

    async fn mount(&self, slot: u32, bind: &Bind) -> Result<(), Error> {
        let pidfd = self
            .pidfds()
            .get(&slot)
            .map(|(_, fd)| fd.clone())
            .ok_or(Error::Unexpected("a slot without a pidfd"))?;
        let rdev = std::fs::metadata(&bind.device)?.rdev();
        let (database, uid) = (bind.volume.database().to_string(), slot_uid(slot));
        let ids = Ids {
            db_uid: bind.account.uid,
            db_gid: bind.account.gid,
            slot_uid: uid,
            slot_gid: uid,
            gateway_gid: self.gateway_gid()?,
        };
        let (volume, socket) = (
            self.layout.volume(&database),
            self.layout.socket_directory(&database),
        );
        let (major, minor) = (libc::major(rdev), libc::minor(rdev));
        tokio::task::spawn_blocking(move || {
            idmap::hand_over(
                pidfd.as_fd(),
                &ids,
                &[
                    Mount {
                        path: &volume,
                        kind: Kind::Volume { major, minor },
                    },
                    Mount {
                        path: &socket,
                        kind: Kind::Socket,
                    },
                ],
            )
        })
        .await
        .map_err(|_| Error::Unexpected("the handoff panicked"))??;
        Ok(())
    }

    async fn order(&self, slot: u32, database: &str) -> Result<Ordered, Error> {
        let began = Instant::now();
        let sent_us = super::monotonic_micros();
        let answer = self
            .converse(slot, &format!("exec {database} {MAJOR}"))
            .await?;
        order_reply(&answer)?;
        // The supervisor replaced itself with PostgreSQL: the process, and its pidfd, are the same.
        let main_pid = self
            .pidfds()
            .get(&slot)
            .map(|(pid, _)| *pid)
            .ok_or(Error::Unexpected("a slot without a pidfd"))?;
        Ok(Ordered {
            main_pid,
            sent_us,
            took: began.elapsed(),
        })
    }

    async fn ready(&self, slot: u32, database: &str, main_pid: u32) -> Result<PathBuf, Error> {
        let pidfd = AsyncFd::with_interest(
            self.pidfd(slot, main_pid)?.try_clone()?,
            tokio::io::Interest::READABLE,
        )?;
        // The watch is armed before the first look, so that a write in between is queued.
        let watch = Watch::new(&self.layout.data(database))?;
        let directory = self.layout.volume(database);
        loop {
            if let Ok(socket) = ready::ready_socket(&directory, main_pid) {
                return Ok(socket);
            }
            tokio::select! {
                changed = watch.changed() => changed?,
                exited = pidfd.readable() => {
                    let _ = exited?;
                    // It wrote `ready` and ended, or it ended: one last look settles which.
                    return ready::ready_socket(&directory, main_pid)
                        .map_err(|_| Error::NotReady("exited"));
                }
            }
        }
    }

    fn facts(&self, slot: u32, pid: Option<u32>) -> Result<Option<Facts>, Error> {
        let Some(pid) = pid.or_else(|| Self::first_process(slot)) else {
            return Ok(None);
        };
        // A process that is gone has no facts.
        let Some(exe) = self.program(pid) else {
            return Ok(None);
        };
        let Ok(databases) = self.storage.volumes_held_by(pid) else {
            return Ok(None);
        };
        let (mut locked, mut postmaster) = (false, None);
        if let [(database, _)] = databases.as_slice() {
            // The process's own view of the data directory, which needs no mount of the agent's.
            let data = PathBuf::from(format!(
                "/proc/{pid}/root{}",
                self.layout.data(database).display()
            ));
            if let (Ok(metadata), Ok(table)) = (
                std::fs::metadata(&data),
                std::fs::read_to_string("/proc/locks"),
            ) {
                locked = holds_lock(pid, &metadata, &table);
            }
            postmaster = std::fs::read_to_string(data.join("postmaster.pid"))
                .ok()
                .and_then(|text| ready::parse(&text).ok())
                .filter(|postmaster| postmaster.pid == pid)
                .map(|postmaster| postmaster.status);
        }
        Ok(Some(Facts {
            pid,
            exe,
            databases,
            locked,
            postmaster,
        }))
    }

    async fn legacy_holds(&self, database: &str) -> Result<bool, Error> {
        self.units.holds_database(database).await
    }

    async fn timestamps(&self, slot: u32) -> Result<Option<(u64, u64)>, Error> {
        let (fork_us, handoff_us) = self.units.exec_timestamps(&slot_unit(slot)).await?;
        Ok((fork_us != 0 && handoff_us != 0).then_some((fork_us, handoff_us)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cgroup_of_a_process_is_the_unified_line_of_its_cgroup_file() {
        assert_eq!(
            unified_cgroup("0::/pgcf.slice/pgcf-slot@12.service\n").as_deref(),
            Some("/pgcf.slice/pgcf-slot@12.service")
        );
        assert_eq!(
            unified_cgroup("12:memory:/old\n0::/user.slice/session-1.scope\n").as_deref(),
            Some("/user.slice/session-1.scope")
        );
        for other in ["", "1:name=systemd:/x\n", "0::relative\n", "0::/a/../b\n"] {
            assert_eq!(unified_cgroup(other), None, "{other:?}");
        }
        // The caller's own cgroup is readable, and no process 0 has one.
        assert!(peer_unit(std::process::id()).0.is_some());
        assert_eq!(peer_unit(0), (None, None));
    }

    #[test]
    fn the_invocation_of_a_cgroup_is_a_uuid_of_the_32_digits_systemd_writes() {
        assert_eq!(
            invocation_from_hex("1d7e15fa5e6c47a0895fa72e000ab9fd").as_deref(),
            Some("1d7e15fa-5e6c-47a0-895f-a72e000ab9fd")
        );
        for other in [
            "",
            "1d7e15fa",
            "1d7e15fa5e6c47a0895fa72e000ab9fg",
            "1d7e15fa5e6c47a0895fa72e000ab9fd0",
        ] {
            assert_eq!(invocation_from_hex(other), None, "{other:?}");
        }
        assert_eq!(invocation_from_hex(&"0".repeat(32)), None, "never started");
    }

    #[test]
    fn the_slot_users_are_the_numbered_accounts_of_the_password_file() {
        let passwd = "root:x:0:0:root:/root:/bin/bash\n\
            pgcf-slot-0:x:300000:300000::/nonexistent:/usr/sbin/nologin\n\
            pgcf-slot-17:x:300017:300017::/nonexistent:/usr/sbin/nologin\n\
            pgcf-slot-017:x:1:1::/:/bin/false\n\
            pgcf-slot-2000:x:2:2::/:/bin/false\n\
            pgcf-slot-check:x:3:3::/:/bin/false\n\
            pgcf-abcdefghij0123456789:x:200123:200123::/nonexistent:/usr/sbin/nologin\n";
        assert_eq!(slot_users(passwd), BTreeSet::from([0, 17]));
        assert_eq!(slot_users(""), BTreeSet::new());
    }

    #[test]
    fn a_group_is_found_by_its_name_alone() {
        let group = "root:x:0:\npgcf-gateway:x:995:pgcf-gateway\npgcf-gateway-extra:x:996:\n";
        assert_eq!(group_gid(group, "pgcf-gateway"), Some(995));
        assert_eq!(group_gid(group, "gateway"), None);
    }

    #[test]
    fn the_program_of_a_process_is_its_exe_even_after_a_release_replaced_the_file() {
        let (supervisor, postgres) = (
            Path::new("/usr/libexec/pgcf/pgcf-archive"),
            Path::new("/usr/lib/postgresql/18/bin/postgres"),
        );
        let program = |link: &str| program_of(Path::new(link), supervisor, postgres);
        assert_eq!(program("/usr/libexec/pgcf/pgcf-archive"), Exe::Supervisor);
        assert_eq!(
            program("/usr/libexec/pgcf/pgcf-archive (deleted)"),
            Exe::Supervisor
        );
        assert_eq!(
            program("/usr/lib/postgresql/18/bin/postgres"),
            Exe::Postgres
        );
        assert_eq!(program("/usr/lib/postgresql/17/bin/postgres"), Exe::Other);
        assert_eq!(program("/bin/sh"), Exe::Other);
        assert_eq!(program("/tmp/usr/libexec/pgcf/pgcf-archive"), Exe::Other);
    }

    #[test]
    fn a_supervisor_started_through_the_images_links_is_known_by_the_file_they_lead_to() {
        // The image's layout: `/usr/libexec/pgcf/pgcf-archive` links to
        // `/var/lib/pgcf/bin/current/pgcf-archive`, and `current` links to the release's directory.
        // The kernel names the file a process runs by its real path, with every link followed.
        let root = crate::link::test_server::tempdir();
        let root = std::fs::canonicalize(&*root).unwrap();
        let bin = root.join("var/lib/pgcf/bin");
        for release in ["release-a", "release-b"] {
            std::fs::create_dir_all(bin.join(release)).unwrap();
            std::fs::write(bin.join(release).join("pgcf-archive"), b"").unwrap();
        }
        std::os::unix::fs::symlink("release-b", bin.join("current")).unwrap();
        let libexec = root.join("usr/libexec/pgcf");
        std::fs::create_dir_all(&libexec).unwrap();
        let command = libexec.join("pgcf-archive");
        std::os::unix::fs::symlink(bin.join("current/pgcf-archive"), &command).unwrap();
        let postgres = root.join("usr/lib/postgresql/18/bin/postgres");
        let program = |exe: &Path| program_at(exe, &command, &postgres);

        let running = bin.join("release-b/pgcf-archive");
        assert_eq!(program(&running), Exe::Supervisor);
        let replaced = format!("{} (deleted)", running.display());
        assert_eq!(program(Path::new(&replaced)), Exe::Supervisor);
        // The supervisor of the release before is another program: an agent of this release does
        // not trust its protocol.
        assert_eq!(program(&bin.join("release-a/pgcf-archive")), Exe::Other);
        // A file of another name in the running release's directory is not the supervisor.
        assert_eq!(program(&bin.join("release-b/pgcf-agent")), Exe::Other);
    }

    #[test]
    fn the_supervisors_answers_to_an_order_are_its_clock_or_one_of_its_refusals() {
        assert_eq!(order_reply("exec 4811200").unwrap(), 4_811_200);
        for word in ["order", "id", "major", "unbound", "held", "lock"] {
            match order_reply(&format!("refused {word}")) {
                Err(Error::Refused(found)) => assert_eq!(found, word),
                other => panic!("{word}: {other:?}"),
            }
        }
        for other in [
            "",
            "exec",
            "exec soon",
            "refused",
            "refused everything",
            "pgcf-slot/1 idle",
        ] {
            assert!(
                matches!(order_reply(other), Err(Error::Refused("reply"))),
                "{other:?}"
            );
        }
    }

    /// The kernel's own lines: a lock of a process, a lock of another kind, and a waiter, which
    /// holds nothing.
    const LOCKS: &str = "1: FLOCK  ADVISORY  WRITE 2461 fc:04:1055 0 EOF\n\
        2: POSIX  ADVISORY  WRITE 4 00:2d:7 0 EOF\n\
        2: -> POSIX  ADVISORY  WRITE 9 00:2d:7 0 EOF\n\
        3: FLOCK  ADVISORY  WRITE 777 fc:04:2000 0 EOF\n\
        4: OFDLCK ADVISORY  READ  12 08:02:10 0 EOF\n";

    #[test]
    fn the_locks_of_proc_locks_are_read_with_their_device_in_hexadecimal() {
        let found = locks(LOCKS);
        assert_eq!(found.len(), 4);
        assert_eq!(
            found[0],
            Lock {
                flock: true,
                pid: 2461,
                major: 0xfc,
                minor: 4,
                inode: 1055
            }
        );
        assert!(!found[1].flock);
        assert!(locks("").is_empty());
        assert!(locks("not a lock\n").is_empty());
    }

    /// A process holds the data directory's lock only with an `flock` on that very inode: not a
    /// POSIX lock on it, not another process's, not another inode's.
    #[test]
    fn a_process_holds_a_data_directory_by_an_flock_of_its_inode_alone() {
        let directory = super::super::test_dir("system-lock");
        std::fs::create_dir_all(&directory).unwrap();
        let metadata = std::fs::metadata(&directory).unwrap();
        let (major, minor) = (libc::major(metadata.dev()), libc::minor(metadata.dev()));
        let line = |kind: &str, pid: u32, inode: u64| {
            format!("1: {kind}  ADVISORY  WRITE {pid} {major:02x}:{minor:02x}:{inode} 0 EOF\n")
        };
        let inode = metadata.ino();
        assert!(holds_lock(2461, &metadata, &line("FLOCK", 2461, inode)));
        assert!(!holds_lock(2461, &metadata, &line("POSIX", 2461, inode)));
        assert!(!holds_lock(2461, &metadata, &line("FLOCK", 2462, inode)));
        assert!(!holds_lock(
            2461,
            &metadata,
            &line("FLOCK", 2461, inode + 1)
        ));
        assert!(!holds_lock(2461, &metadata, ""));
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// The agent's wait for a postmaster: a file written in the directory ends it, and nothing is
    /// polled. A real directory and a real `inotify`.
    #[tokio::test]
    async fn a_watch_wakes_on_a_file_written_and_closed_in_its_directory() {
        let directory = super::super::test_dir("system-watch");
        std::fs::create_dir_all(&directory).unwrap();
        let watch = Watch::new(&directory).unwrap();
        let writer = {
            let file = directory.join("postmaster.pid");
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                std::fs::write(file, "1\n").unwrap();
            })
        };
        tokio::time::timeout(Duration::from_secs(5), watch.changed())
            .await
            .expect("the write woke the watch")
            .unwrap();
        writer.await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// A pidfd of a process that has ended is readable, and one of a process that lives is not.
    #[tokio::test]
    async fn a_pidfd_is_readable_when_its_process_has_ended() {
        let mut child = std::process::Command::new("sleep")
            .arg("60")
            .spawn()
            .unwrap();
        let fd = AsyncFd::with_interest(
            pidfd_open(child.id()).unwrap(),
            tokio::io::Interest::READABLE,
        )
        .unwrap();
        let waiting = tokio::time::timeout(Duration::from_millis(100), fd.readable()).await;
        assert!(waiting.is_err(), "the process lives");
        child.kill().unwrap();
        child.wait().unwrap();
        let _ready = tokio::time::timeout(Duration::from_secs(5), fd.readable())
            .await
            .expect("the end of the process was seen")
            .unwrap();
    }
}
