// SPDX-License-Identifier: Apache-2.0
//! The handoff of a database's mounts to a pooled slot (plan 5.5, 5.9): the database's volume and
//! its socket directory, cloned from the agent's own mounts, idmapped so that the slot's user owns
//! what the database's user owns on disk, and moved into the slot's mount namespace.
//!
//! A slot is a sandbox that runs as a user of its own and was built before any database was
//! chosen. The files of a database stay owned by the database's fixed user on disk (plan 5.5), so
//! the slot's user can only act on them through a mount that translates ids: a user namespace
//! whose single mapping is the database's id to the slot's id, applied to a clone of the mount
//! with `mount_setattr(2)`. Files the slot's user creates reach the disk with the database's id.
//! Any other id shows as the overflow id, and the kernel lets nobody write to an inode that has
//! one: a file of another owner in the volume, even one with mode 0666, can be read and not
//! written, and a socket directory of the gateway's group is mapped to itself for that reason.
//!
//! The steps, which the privileged lab (`idmap_lab`) runs against systemd and a real kernel:
//!
//! 1. A user namespace with the one uid mapping and the gid mappings of `Ids`. A child created
//!    with `CLONE_NEWUSER` holds it open while the agent writes its maps and opens it, and is
//!    then killed. The child shares the agent's memory (`CLONE_VM`) and does not copy it: a
//!    `fork` copies the page tables, so its time grows with the agent's memory, and this one is
//!    the same at any size (lab). `CLONE_VFORK` is not an option, as it suspends the agent until
//!    the child has ended, and the child has to wait for the agent. The child makes raw system
//!    calls only, as it uses the agent's memory.
//! 2. For each mount, `open_tree(OPEN_TREE_CLONE)` of the agent's mount, a check that it is what
//!    the caller expects (a directory, and for a volume the device of the volume), and
//!    `mount_setattr(2)` with the idmap, the attributes of its [`Kind`] and `MS_PRIVATE`: a clone
//!    is born in the peer group of the agent's mount, which under `PrivateMounts=yes` is a shared
//!    one, and it must not stay in it (see `mount_attr`).
//! 3. A thread of its own that leaves the agent's file-system state (`unshare(CLONE_FS)`, which
//!    `setns(2)` into a mount namespace needs), enters the slot's mount namespace through the
//!    slot's pidfd, and moves each clone onto the same path there, without following a symlink
//!    at the end of the path. The thread then ends, and with it its place in the slot's namespace.
//!
//! No mount-namespace descriptor is ever opened or kept: a descriptor of the slot's namespace
//! would keep its mounts, and so the volume's filesystem, alive after the slot has ended. The
//! clones are closed when the handoff returns.
//!
//! An error leaves the slot with those of the mounts that were already moved. The caller stops
//! the slot and does not use it again.
use std::{
    ffi::{CStr, CString},
    fs::File,
    io,
    os::{
        fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
    thread,
};

// linux/mount.h
const OPEN_TREE_CLONE: libc::c_uint = 1;
/// The clone is closed on exec, and a symlink at the end of the path is not followed.
const OPEN_TREE_FLAGS: libc::c_uint =
    OPEN_TREE_CLONE | libc::O_CLOEXEC as libc::c_uint | libc::AT_SYMLINK_NOFOLLOW as libc::c_uint;
const MOVE_MOUNT_F_EMPTY_PATH: libc::c_uint = 0x4;
const MOUNT_ATTR_NOSUID: u64 = 0x2;
const MOUNT_ATTR_NODEV: u64 = 0x4;
const MOUNT_ATTR_NOEXEC: u64 = 0x8;
const MOUNT_ATTR_NOATIME: u64 = 0x10;
/// `MOUNT_ATTR__ATIME`: the three bits of the access-time setting, which a change must clear.
const MOUNT_ATTR_ATIME_MASK: u64 = 0x70;
const MOUNT_ATTR_IDMAP: u64 = 0x10_0000;

/// `struct mount_attr` in its first version, 32 bytes (`MOUNT_ATTR_SIZE_VER0`).
#[repr(C)]
struct MountAttr {
    attr_set: u64,
    attr_clr: u64,
    propagation: u64,
    userns_fd: u64,
}

/// The ids of one handoff: the database's user and group on disk, the slot's, which the slot sees
/// them as, and the gateway's group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ids {
    pub db_uid: u32,
    pub db_gid: u32,
    pub slot_uid: u32,
    pub slot_gid: u32,
    /// The group of the socket directory, which lets the gateway dial the database's socket
    /// (`machine/node.rs`, `prepare_socket_directory`). It maps to itself: the kernel refuses every write
    /// to an inode whose owner or group the mount cannot map (`EACCES`, as it could not write the
    /// ids back), so a directory of a group the map does not know could not hold the socket.
    pub gateway_gid: u32,
}

impl Ids {
    /// The contents of `uid_map` and `gid_map` of the user namespace: `<id inside> <id outside>
    /// <count>`. An idmapped mount reads the id on disk as the "inside" id and shows the "outside"
    /// id, so the database's id is the first and the slot's the second, with a count of 1: no
    /// other id is mapped, except the gateway's group to itself. Root and the id the kernel reads
    /// as "none" are refused, whatever the caller says, and so is a gateway group that is also
    /// the database's or the slot's.
    pub fn maps(&self) -> io::Result<(String, String)> {
        let all = [
            self.db_uid,
            self.db_gid,
            self.slot_uid,
            self.slot_gid,
            self.gateway_gid,
        ];
        if let Some(id) = all.into_iter().find(|id| *id == 0 || *id == u32::MAX) {
            return Err(invalid(format!("id {id} cannot be mapped")));
        }
        if [self.db_gid, self.slot_gid].contains(&self.gateway_gid) {
            return Err(invalid("the gateway group is the database's or the slot's"));
        }
        Ok((
            format!("{} {} 1\n", self.db_uid, self.slot_uid),
            format!(
                "{} {} 1\n{} {} 1\n",
                self.db_gid, self.slot_gid, self.gateway_gid, self.gateway_gid
            ),
        ))
    }
}

/// What a mount is, which sets its attributes and what is checked on its clone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A database's volume: the clone must be the filesystem of the device `major:minor` (the
    /// agent's mount of the volume's generation, not the empty directory under it). The database's
    /// user can leave anything in it, so it is nosuid, nodev and noexec, and noatime, as the
    /// agent's own mounts of a volume are.
    Volume { major: u32, minor: u32 },
    /// A database's socket directory, on a tmpfs: nosuid, nodev and noexec. Its access times stay
    /// as they are, as a read of a tmpfs writes nothing.
    Socket,
}

impl Kind {
    /// The `attr_set` and `attr_clr` of `mount_setattr(2)`.
    fn attributes(self) -> (u64, u64) {
        let idmapped = MOUNT_ATTR_IDMAP | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC;
        match self {
            Kind::Volume { .. } => (idmapped | MOUNT_ATTR_NOATIME, MOUNT_ATTR_ATIME_MASK),
            Kind::Socket => (idmapped, 0),
        }
    }
}

/// A mount to hand over: the path of the agent's mount, which is also where it appears in the
/// slot.
#[derive(Clone, Copy, Debug)]
pub struct Mount<'a> {
    pub path: &'a Path,
    pub kind: Kind,
}

#[derive(Debug)]
pub(crate) struct Planned {
    path: CString,
    kind: Kind,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

/// An error with the step that failed, in the kind of the original.
fn context(what: impl std::fmt::Display, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{what}: {error}"))
}
fn failed(what: impl std::fmt::Display) -> io::Error {
    context(what, io::Error::last_os_error())
}

/// Every path is absolute, as the slot sees it at the same place, and has no NUL.
pub(crate) fn plan(mounts: &[Mount<'_>]) -> io::Result<Vec<Planned>> {
    mounts
        .iter()
        .map(|mount| {
            if !mount.path.is_absolute() {
                return Err(invalid(format!("{} is not absolute", mount.path.display())));
            }
            let path = CString::new(mount.path.as_os_str().as_bytes())
                .map_err(|_| invalid("a path has a NUL"))?;
            Ok(Planned {
                path,
                kind: mount.kind,
            })
        })
        .collect()
}

fn owned(fd: libc::c_long) -> io::Result<OwnedFd> {
    let fd = libc::c_int::try_from(fd).map_err(|_| io::Error::last_os_error())?;
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the kernel just returned this descriptor and nothing else owns it.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
fn ok(value: libc::c_long) -> io::Result<()> {
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The child's main. It shares the agent's memory, so it makes raw system calls only and never
/// returns into Rust: it asks the kernel to kill it when the agent's thread that made it ends,
/// makes sure that has not happened already, and waits for the agent's `SIGKILL`. System calls
/// through `libc::syscall` do not touch the thread state of the libc wrappers, which is shared too.
extern "C" fn hold(arg: *mut libc::c_void) -> libc::c_int {
    // SAFETY: `arg` is the process ID in `UserNamespace::new`, whose frame lives until the child
    // has been waited for. The calls take plain integers.
    unsafe {
        let parent = arg.cast::<libc::pid_t>().read();
        libc::syscall(
            libc::SYS_prctl,
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL,
            0,
            0,
            0,
        );
        if libc::syscall(libc::SYS_getppid) != libc::c_long::from(parent) {
            libc::syscall(libc::SYS_exit_group, 1);
        }
        // ppoll(NULL, 0, NULL, NULL, 0): sleep until a signal comes.
        loop {
            libc::syscall(libc::SYS_ppoll, 0usize, 0usize, 0usize, 0usize, 0usize);
        }
    }
}

/// The child that holds a new user namespace open while its maps are written; it is killed and
/// waited for when the value is dropped.
///
/// The child does not wait on a pipe that the agent closes: a child made at the same time by
/// another thread holds a copy of that pipe's end, and two handoffs at once would wait for each
/// other (the lab's storm test).
struct Holder(libc::pid_t);
impl Drop for Holder {
    fn drop(&mut self) {
        // SAFETY: signals and waits for our own child.
        unsafe { libc::kill(self.0, libc::SIGKILL) };
        let mut status = 0;
        loop {
            // SAFETY: waits for our own child and writes one int.
            let result = unsafe { libc::waitpid(self.0, &raw mut status, 0) };
            if result >= 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                return;
            }
        }
    }
}

/// The stack of the child: it makes four system calls.
const HOLD_STACK_BYTES: usize = 16 * 1024;

/// A user namespace whose only mappings are a database's id to a slot's, uid and gid, and the
/// gateway's group to itself.
pub(crate) struct UserNamespace(OwnedFd);

impl UserNamespace {
    pub(crate) fn new(ids: &Ids) -> io::Result<Self> {
        let (uid_map, gid_map) = ids.maps()?;
        // The child's stack: its memory is not touched here, and it outlives the child, which the
        // holder below waits for before the function ends.
        let mut stack: Vec<u8> = Vec::with_capacity(HOLD_STACK_BYTES);
        let top = (stack.as_mut_ptr() as usize + HOLD_STACK_BYTES) & !15;
        // SAFETY: `getpid` has no arguments and cannot fail.
        let mut parent = unsafe { libc::getpid() };
        // SAFETY: the child runs `hold` on `stack` with a pointer to `parent`, both alive until
        // it is waited for. It shares our memory and only reads `parent` and makes system calls.
        let pid = unsafe {
            libc::clone(
                hold,
                top as *mut libc::c_void,
                libc::CLONE_VM | libc::CLONE_NEWUSER | libc::SIGCHLD,
                (&raw mut parent).cast::<libc::c_void>(),
            )
        };
        if pid < 0 {
            return Err(failed("clone(CLONE_NEWUSER)"));
        }
        let holder = Holder(pid);
        let proc = format!("/proc/{pid}");
        std::fs::write(format!("{proc}/uid_map"), uid_map).map_err(|e| context("uid_map", e))?;
        std::fs::write(format!("{proc}/gid_map"), gid_map).map_err(|e| context("gid_map", e))?;
        let namespace =
            File::open(format!("{proc}/ns/user")).map_err(|e| context("open ns/user", e))?;
        drop(holder);
        drop(stack);
        Ok(Self(namespace.into()))
    }
}

/// The attributes `mount_setattr(2)` applies to a clone: those of its kind, the user namespace of
/// the idmap, and no peer group.
///
/// `open_tree(OPEN_TREE_CLONE)` leaves the clone in the peer group of the mount it copies, and
/// under `PrivateMounts=yes` every mount of the agent is shared. A clone that kept that group would
/// be a peer of the agent's mount for as long as it lives: a mount made on or under either one
/// would appear in the other, in every other slot that holds the volume, and the next
/// `open_tree` of the agent's mount would copy a mount that was already idmapped.
fn mount_attr(kind: Kind, namespace: BorrowedFd<'_>) -> MountAttr {
    let (set, clear) = kind.attributes();
    MountAttr {
        attr_set: set,
        attr_clr: clear,
        propagation: libc::MS_PRIVATE,
        userns_fd: namespace.as_raw_fd() as u64,
    }
}

/// A detached, idmapped clone of the mount at `mount.path`: a descriptor, mounted nowhere.
pub(crate) fn clone_tree(mount: &Planned, namespace: &UserNamespace) -> io::Result<OwnedFd> {
    let path = mount.path.to_string_lossy();
    // SAFETY: plain syscall with a valid NUL-terminated string; the result is checked.
    let tree = owned(unsafe {
        libc::syscall(
            libc::SYS_open_tree,
            libc::AT_FDCWD,
            mount.path.as_ptr(),
            OPEN_TREE_FLAGS,
        )
    })
    .map_err(|e| context(format!("open_tree {path}"), e))?;
    verify(&tree, mount.kind).map_err(|e| context(format!("{path}"), e))?;
    let attributes = mount_attr(mount.kind, namespace.0.as_fd());
    // SAFETY: plain syscall with valid descriptors, an empty path and the struct's own size.
    ok(unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            tree.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            &raw const attributes,
            size_of::<MountAttr>(),
        )
    })
    .map_err(|e| context(format!("mount_setattr {path}"), e))?;
    Ok(tree)
}

/// The clone is a directory, and a volume's is the filesystem of the device that was asked for.
fn verify(tree: &OwnedFd, kind: Kind) -> io::Result<()> {
    // SAFETY: `fstat` writes one `stat`; it works on the path descriptor `open_tree` returns.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(tree.as_raw_fd(), &raw mut stat) } != 0 {
        return Err(failed("fstat"));
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
        return Err(io::Error::new(
            io::ErrorKind::NotADirectory,
            "it is not a directory",
        ));
    }
    if let Kind::Volume { major, minor } = kind {
        let (found_major, found_minor) = (libc::major(stat.st_dev), libc::minor(stat.st_dev));
        if (found_major, found_minor) != (major, minor) {
            return Err(io::Error::other(format!(
                "it is the filesystem {found_major}:{found_minor}, not the volume {major}:{minor}"
            )));
        }
    }
    Ok(())
}

/// Enters the mount namespace of the process `slot` names and moves each clone onto its path
/// there. The calls are made by a thread of their own, which has left the agent's file-system
/// state first and ends afterwards: nothing else in the agent ever runs in the slot's namespace.
pub(crate) fn move_into(slot: BorrowedFd<'_>, moves: &[(BorrowedFd<'_>, &CStr)]) -> io::Result<()> {
    thread::scope(|scope| {
        thread::Builder::new()
            .name("pgcf-idmap".into())
            .spawn_scoped(scope, || enter_and_move(slot, moves))
            .map_err(|e| context("spawn", e))?
            .join()
            .unwrap_or_else(|_| Err(io::Error::other("the handoff thread panicked")))
    })
}

fn enter_and_move(slot: BorrowedFd<'_>, moves: &[(BorrowedFd<'_>, &CStr)]) -> io::Result<()> {
    // SAFETY: both calls take plain values; the thread changes only its own state.
    if unsafe { libc::unshare(libc::CLONE_FS) } != 0 {
        return Err(failed("unshare(CLONE_FS)"));
    }
    if unsafe { libc::setns(slot.as_raw_fd(), libc::CLONE_NEWNS) } != 0 {
        return Err(failed("setns(CLONE_NEWNS)"));
    }
    for (tree, target) in moves {
        // SAFETY: plain syscall with valid descriptors and NUL-terminated strings. Without
        // `MOVE_MOUNT_T_SYMLINKS` a symlink at the end of the target is not followed.
        ok(unsafe {
            libc::syscall(
                libc::SYS_move_mount,
                tree.as_raw_fd(),
                c"".as_ptr(),
                libc::AT_FDCWD,
                target.as_ptr(),
                MOVE_MOUNT_F_EMPTY_PATH,
            )
        })
        .map_err(|e| context(format!("move_mount {}", target.to_string_lossy()), e))?;
    }
    Ok(())
}

/// Hands `mounts` over to the slot whose main process `slot` is a pidfd of: a clone of each,
/// idmapped as `ids` say, appears in the slot's mount namespace at the same path. It takes well
/// under a millisecond to a few, with a thread and a child of its own, so an async caller may
/// run it where blocking is allowed.
pub fn hand_over(slot: BorrowedFd<'_>, ids: &Ids, mounts: &[Mount<'_>]) -> io::Result<()> {
    let planned = plan(mounts)?;
    let namespace = UserNamespace::new(ids)?;
    let trees = planned
        .iter()
        .map(|mount| clone_tree(mount, &namespace))
        .collect::<io::Result<Vec<_>>>()?;
    drop(namespace);
    let moves: Vec<_> = trees
        .iter()
        .zip(&planned)
        .map(|(tree, mount)| (tree.as_fd(), mount.path.as_c_str()))
        .collect();
    move_into(slot, &moves)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDS: Ids = Ids {
        db_uid: 200_123,
        db_gid: 200_456,
        slot_uid: 300_007,
        slot_gid: 300_009,
        gateway_gid: 999,
    };

    #[test]
    fn the_maps_send_the_database_id_to_the_slot_id_and_the_gateway_group_to_itself() {
        let (uid, gid) = IDS.maps().unwrap();
        assert_eq!(uid, "200123 300007 1\n");
        assert_eq!(gid, "200456 300009 1\n999 999 1\n");
    }

    #[test]
    fn a_gateway_group_that_is_the_databases_or_the_slots_would_map_one_id_twice() {
        for gid in [IDS.db_gid, IDS.slot_gid] {
            let ids = Ids {
                gateway_gid: gid,
                ..IDS
            };
            assert_eq!(
                ids.maps().unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{ids:?}"
            );
        }
    }

    #[test]
    fn root_and_the_invalid_id_are_never_mapped() {
        for bad in [0, u32::MAX] {
            for ids in [
                Ids { db_uid: bad, ..IDS },
                Ids { db_gid: bad, ..IDS },
                Ids {
                    slot_uid: bad,
                    ..IDS
                },
                Ids {
                    slot_gid: bad,
                    ..IDS
                },
                Ids {
                    gateway_gid: bad,
                    ..IDS
                },
            ] {
                assert_eq!(
                    ids.maps().unwrap_err().kind(),
                    io::ErrorKind::InvalidInput,
                    "{ids:?}"
                );
            }
        }
    }

    // The values of linux/mount.h: a typo here would set another attribute on a database's mount.
    const NOSUID: u64 = 0x2;
    const NODEV: u64 = 0x4;
    const NOEXEC: u64 = 0x8;
    const NOATIME: u64 = 0x10;
    const ATIME_MASK: u64 = 0x70;
    const IDMAP: u64 = 0x10_0000;

    #[test]
    fn a_volume_is_idmapped_nosuid_nodev_noexec_and_noatime() {
        let volume = Kind::Volume {
            major: 252,
            minor: 4,
        };
        assert_eq!(
            volume.attributes(),
            (IDMAP | NOSUID | NODEV | NOEXEC | NOATIME, ATIME_MASK)
        );
    }

    #[test]
    fn the_socket_directory_is_the_same_without_noatime() {
        // A tmpfs has no inode to write on a read; its access time is left as the parent has it.
        assert_eq!(
            Kind::Socket.attributes(),
            (IDMAP | NOSUID | NODEV | NOEXEC, 0)
        );
    }

    #[test]
    fn a_clone_gets_the_attributes_of_its_kind_the_namespace_and_a_peer_group_of_its_own() {
        let namespace = std::fs::File::open("/dev/null").unwrap();
        for kind in [
            Kind::Volume {
                major: 252,
                minor: 4,
            },
            Kind::Socket,
        ] {
            let attributes = mount_attr(kind, namespace.as_fd());
            let (set, clear) = kind.attributes();
            assert_eq!((attributes.attr_set, attributes.attr_clr), (set, clear));
            assert_eq!(attributes.userns_fd, namespace.as_raw_fd() as u64);
            // MS_PRIVATE, from linux/mount.h: the clone leaves the peer group of the agent's mount.
            // Zero leaves the group as it is, and the clone stays a peer of the agent's mount.
            assert_eq!(attributes.propagation, 1 << 18, "{kind:?}");
        }
    }

    #[test]
    fn the_attribute_struct_is_the_kernels_first_version() {
        // MOUNT_ATTR_SIZE_VER0: attr_set, attr_clr, propagation and userns_fd, 8 bytes each.
        assert_eq!(std::mem::size_of::<MountAttr>(), 32);
    }

    #[test]
    fn a_path_the_slot_cannot_read_the_same_way_is_refused() {
        let kind = Kind::Socket;
        for path in ["relative/dir", "", "/with\0nul"] {
            let mounts = [Mount {
                path: Path::new(path),
                kind,
            }];
            assert_eq!(
                plan(&mounts).unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{path:?}"
            );
        }
        let ok = [Mount {
            path: Path::new("/run/pgcf/abc"),
            kind,
        }];
        assert_eq!(plan(&ok).unwrap().len(), 1);
    }
}
