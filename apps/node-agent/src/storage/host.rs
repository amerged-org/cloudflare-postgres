// SPDX-License-Identifier: Apache-2.0
//! The kernel side of a volume: mounting it with the new mount API, unmounting, `statvfs`, and
//! the mount table and ext4's error counter.
use super::{
    FsUsage,
    quota::{self, Limits},
};
use std::{
    ffi::CString,
    fs, io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::FileExt, fs::OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

// linux/mount.h
const MOVE_MOUNT_F_EMPTY_PATH: libc::c_uint = 0x4;
const FSOPEN_CLOEXEC: libc::c_uint = 0x1;
const FSCONFIG_SET_FLAG: libc::c_uint = 0;
const FSCONFIG_SET_STRING: libc::c_uint = 1;
const FSCONFIG_CMD_CREATE: libc::c_uint = 6;
const FSMOUNT_CLOEXEC: libc::c_uint = 0x1;
const MOUNT_ATTR_NOSUID: libc::c_uint = 0x2;
const MOUNT_ATTR_NODEV: libc::c_uint = 0x4;
const MOUNT_ATTR_NOEXEC: libc::c_uint = 0x8;
const MOUNT_ATTR_NOATIME: libc::c_uint = 0x10;
/// What every mount of a volume has: nosuid, nodev and noexec, as the database's user can leave
/// anything in its volume, and noatime, so that no read writes an inode (with the default
/// relatime the first read after a write does, through the ext4 journal). PostgreSQL does not use
/// access times.
const VOLUME_MOUNT_ATTRIBUTES: libc::c_uint =
    MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC | MOUNT_ATTR_NOATIME;

fn path_text(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn owned(fd: libc::c_long) -> io::Result<OwnedFd> {
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = libc::c_int::try_from(fd).map_err(|_| io::Error::from_raw_os_error(libc::EBADF))?;
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
fn text(value: &str) -> io::Result<CString> {
    CString::new(value).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

/// A detached mount of `fstype`, with `source` when given and each of `flags` set (`prjquota`).
pub(crate) fn detached(fstype: &str, source: Option<&str>, flags: &[&str]) -> io::Result<OwnedFd> {
    let fstype = text(fstype)?;
    // SAFETY: plain syscalls with valid NUL-terminated strings; results are checked.
    let context =
        owned(unsafe { libc::syscall(libc::SYS_fsopen, fstype.as_ptr(), FSOPEN_CLOEXEC) })?;
    if let Some(source) = source {
        let (key, value) = (text("source")?, text(source)?);
        ok(unsafe {
            libc::syscall(
                libc::SYS_fsconfig,
                context.as_raw_fd(),
                FSCONFIG_SET_STRING,
                key.as_ptr(),
                value.as_ptr(),
                0,
            )
        })?;
    }
    for flag in flags {
        let key = text(flag)?;
        ok(unsafe {
            libc::syscall(
                libc::SYS_fsconfig,
                context.as_raw_fd(),
                FSCONFIG_SET_FLAG,
                key.as_ptr(),
                std::ptr::null::<libc::c_void>(),
                0,
            )
        })?;
    }
    ok(unsafe {
        libc::syscall(
            libc::SYS_fsconfig,
            context.as_raw_fd(),
            FSCONFIG_CMD_CREATE,
            std::ptr::null::<libc::c_char>(),
            std::ptr::null::<libc::c_void>(),
            0,
        )
    })?;
    owned(unsafe {
        libc::syscall(
            libc::SYS_fsmount,
            context.as_raw_fd(),
            FSMOUNT_CLOEXEC,
            VOLUME_MOUNT_ATTRIBUTES,
        )
    })
}

fn attach(mount: OwnedFd, target: &Path) -> io::Result<()> {
    let target = path_text(target)?;
    // SAFETY: plain syscall with a valid descriptor and NUL-terminated strings; the result is checked.
    let result = unsafe {
        libc::syscall(
            libc::SYS_move_mount,
            mount.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            MOVE_MOUNT_F_EMPTY_PATH,
        )
    };
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Mounts the ext4 on `device` at `target`: fsopen, fsconfig and fsmount as the attach path
/// does, then move_mount to the volume's directory. The mount is nosuid, nodev, noexec and
/// noatime, and has no `discard` (plan Appendix C): space returns to the pool through `fstrim`.
/// A filesystem with a project quota (`Superblock::project_quota`) is mounted with its limits
/// enforced (`prjquota`); a superblock that is already mounted anywhere keeps the options of its
/// first mount, which is why the agent mounts before any unit does.
pub fn mount_ext4(device: &str, target: &Path, project_quota: bool) -> io::Result<()> {
    let flags: &[&str] = if project_quota { &["prjquota"] } else { &[] };
    attach(detached("ext4", Some(device), flags)?, target)
}

/// Unmounts without force and without lazy detach: a filesystem that something holds stays.
pub fn unmount(target: &Path) -> io::Result<()> {
    let target = path_text(target)?;
    // SAFETY: plain syscall with a valid NUL-terminated string; the result is checked.
    if unsafe { libc::umount2(target.as_ptr(), 0) } < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The directory of the device links (`Config::device_links`): the agent's alone, mode 0700. The
/// unit and the jobs follow a link in it as root and mount whatever it names, so a directory
/// another user can write would let that user mount any device into a tenant's sandbox. It is
/// made if it is not there, and checked every time: a directory that another user owns, or that
/// has another mode, is refused, not trusted. Its parent is made 0755 if missing, as the
/// databases' socket directories live there too.
pub fn ensure_link_directory(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    if let Some(parent) = dir.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o755)
            .create(parent)?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(dir)?;
    // SAFETY: geteuid has no arguments and cannot fail.
    let agent = unsafe { libc::geteuid() };
    if !metadata.is_dir()
        || metadata.uid() != agent
        || metadata.permissions().mode() & 0o7777 != 0o700
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the device link directory is not the agent's alone",
        ));
    }
    Ok(())
}

/// Where a link is staged before it takes its place: the same directory, so the rename is atomic.
fn staged(link: &Path) -> PathBuf {
    let mut name = link.file_name().unwrap_or_default().to_os_string();
    name.push(".new");
    link.with_file_name(name)
}

/// Makes `link` point to `target`, by rename: a reader sees the old link or the new one, never
/// none. A link that already points there is left.
pub fn install_link(link: &Path, target: &str) -> io::Result<()> {
    if let Some(dir) = link.parent() {
        ensure_link_directory(dir)?;
    }
    if link_names(link, target) {
        return Ok(());
    }
    let staged = staged(link);
    match std::fs::remove_file(&staged) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    std::os::unix::fs::symlink(target, &staged)?;
    std::fs::rename(&staged, link)
}

/// Removes `link` while it points to `target`. A link to another volume, which another generation
/// of the database owns, and no link at all, are left as they are.
pub fn drop_link(link: &Path, target: &str) -> io::Result<()> {
    match std::fs::read_link(link) {
        Ok(current) if current == Path::new(target) => std::fs::remove_file(link),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Whether `link` points to `target`.
pub fn link_names(link: &Path, target: &str) -> bool {
    std::fs::read_link(link).is_ok_and(|current| current == Path::new(target))
}

/// The agent's start: no link survives it. A link names a volume that the agent attached in its
/// namespace, and that namespace is gone with the agent that had it.
pub fn reset_links(dir: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    ensure_link_directory(dir)
}

pub fn fs_usage(path: &Path) -> io::Result<FsUsage> {
    let path = path_text(path)?;
    // SAFETY: statvfs is plain data; zero is a valid value to overwrite.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a statvfs the kernel fills in.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // Block counts are in units of the fragment size.
    Ok(FsUsage::from_blocks(
        stat.f_frsize as u64,
        stat.f_blocks as u64,
        stat.f_bfree as u64,
        stat.f_bavail as u64,
        stat.f_files as u64,
        stat.f_ffree as u64,
    ))
}

/// `statvfs` of what the tenant can use of the mounted volume: the project's view of the data
/// directory when the volume has a project quota, where the size is the limit and the use is the
/// project's (`ext4_statfs_project`), else of the volume as a whole. A mount that has no data
/// directory yet is read at its root.
pub fn tenant_usage(mount_point: &Path) -> io::Result<FsUsage> {
    match fs_usage(&mount_point.join("data").join(quota::DIRECTORIES[0])) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => fs_usage(mount_point),
        other => other,
    }
}

/// The fields of ext4's superblock that the agent reads (`struct ext4_super_block`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Superblock {
    pub block_count: u64,
    pub block_size: u64,
    pub ro_compat: u32,
}

impl Superblock {
    const SIZE: usize = 1024;
    /// Where the superblock is on a device: 1,024 bytes from its start.
    const OFFSET: u64 = 1024;
    const MAGIC: u16 = 0xef53;
    const INCOMPAT_64BIT: u32 = 0x80;
    /// `EXT4_FEATURE_RO_COMPAT_QUOTA` and `_PROJECT`.
    const RO_COMPAT_QUOTA: u32 = 0x100;
    const RO_COMPAT_PROJECT: u32 = 0x2000;

    /// The superblock in its first 1,024 bytes; `None` when they are none of ext4's.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let bytes = bytes.get(..Self::SIZE)?;
        let word = |at: usize| -> Option<u32> {
            Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
        };
        let magic = u16::from_le_bytes(bytes.get(0x38..0x3a)?.try_into().ok()?);
        if magic != Self::MAGIC {
            return None;
        }
        let high = if word(0x60)? & Self::INCOMPAT_64BIT != 0 {
            u64::from(word(0x150)?) << 32
        } else {
            0
        };
        let block_shift = word(0x18)?;
        (block_shift <= 6).then_some(())?;
        Some(Self {
            block_count: high | u64::from(word(0x04)?),
            block_size: 1024 << block_shift,
            ro_compat: word(0x64)?,
        })
    }

    /// What the filesystem has: its block count times its block size, which is what `resize2fs`
    /// sets and what the volume's size bounds.
    pub fn bytes(&self) -> u64 {
        self.block_count.saturating_mul(self.block_size)
    }

    /// Whether the filesystem has a project quota that the agent can set limits on.
    pub fn project_quota(&self) -> bool {
        self.ro_compat & (Self::RO_COMPAT_QUOTA | Self::RO_COMPAT_PROJECT)
            == (Self::RO_COMPAT_QUOTA | Self::RO_COMPAT_PROJECT)
    }
}

/// The superblock of the filesystem on `device`, mounted or not: a read of the device sees the
/// kernel's own copy of it, as `dumpe2fs` does.
pub fn read_superblock(device: &str) -> io::Result<Superblock> {
    let mut bytes = [0u8; Superblock::SIZE];
    fs::File::open(device)?.read_exact_at(&mut bytes, Superblock::OFFSET)?;
    Superblock::parse(&bytes)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an ext4 superblock"))
}

/// The size of the block device at `path`: a thin volume's nominal size.
pub fn device_bytes(path: &str) -> io::Result<u64> {
    use std::io::{Seek, SeekFrom};
    fs::File::open(path)?.seek(SeekFrom::End(0))
}

// linux/quota.h and linux/fs.h
const Q_GETQUOTA: u32 = 0x80_0007;
const Q_SETQUOTA: u32 = 0x80_0008;
const PRJQUOTA: u32 = 2;
const QIF_BLIMITS: u32 = 1;
const QIF_ILIMITS: u32 = 4;
const FS_XFLAG_PROJINHERIT: u32 = 0x200;
/// `_IOR('X', 31, struct fsxattr)` and `_IOW('X', 32, struct fsxattr)`: the same on x86-64 and arm64.
const FS_IOC_FSGETXATTR: libc::c_ulong = 0x801c_581f;
const FS_IOC_FSSETXATTR: libc::c_ulong = 0x401c_5820;

/// `struct fsxattr` of `linux/fs.h`.
#[repr(C)]
#[derive(Default)]
struct FsxAttr {
    xflags: u32,
    extsize: u32,
    nextents: u32,
    projid: u32,
    cowextsize: u32,
    pad: [u8; 8],
}

/// `QCMD(command, PRJQUOTA)`.
fn project_command(command: u32) -> libc::c_int {
    ((command << 8) | PRJQUOTA) as libc::c_int
}

/// The limits of project `project` on the filesystem of `device`, mounted anywhere: the call finds
/// the filesystem by its device, in no mount namespace.
pub fn quota_limits(device: &str, project: u32) -> io::Result<Limits> {
    let special = text(device)?;
    // SAFETY: dqblk is plain data; zero is a valid value for the kernel to overwrite.
    let mut block: libc::dqblk = unsafe { std::mem::zeroed() };
    // SAFETY: `special` is NUL-terminated and `block` is the structure the command fills in.
    let result = unsafe {
        libc::quotactl(
            project_command(Q_GETQUOTA),
            special.as_ptr(),
            project as libc::c_int,
            std::ptr::from_mut(&mut block).cast(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Limits {
        blocks: block.dqb_bhardlimit,
        inodes: block.dqb_ihardlimit,
    })
}

/// Sets the hard limits of project `project` (and no soft limit, which would block at its grace's
/// end whatever the hard limit is).
pub fn set_quota_limits(device: &str, project: u32, limits: Limits) -> io::Result<()> {
    let special = text(device)?;
    // SAFETY: dqblk is plain data; zero is a valid value, and the fields set below are the ones
    // `dqb_valid` names.
    let mut block: libc::dqblk = unsafe { std::mem::zeroed() };
    block.dqb_bhardlimit = limits.blocks;
    block.dqb_ihardlimit = limits.inodes;
    block.dqb_valid = QIF_BLIMITS | QIF_ILIMITS;
    // SAFETY: `special` is NUL-terminated and `block` is the structure the command reads.
    let result = unsafe {
        libc::quotactl(
            project_command(Q_SETQUOTA),
            special.as_ptr(),
            project as libc::c_int,
            std::ptr::from_mut(&mut block).cast(),
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Puts the data directory's `base` and `global`, with everything in them, in project `project`:
/// each directory also passes the project on to what is made in it later, which is how a
/// running PostgreSQL's new relations, forks and temporary files get into it. The tree is read
/// with no symlink followed and no file other than directories and regular files touched, for a
/// restored data directory is the tenant's. Called with no PostgreSQL running on the tree: after
/// `initdb`, and after a restore has fetched the files.
pub fn mark_project(data: &Path, project: u32) -> io::Result<()> {
    for directory in quota::DIRECTORIES {
        mark_tree(&data.join(directory), project)?;
    }
    Ok(())
}

fn mark_tree(path: &Path, project: u32) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        mark_inode(path, project, true)?;
        for entry in fs::read_dir(path)? {
            mark_tree(&entry?.path(), project)?;
        }
    } else if metadata.is_file() {
        mark_inode(path, project, false)?;
    }
    Ok(())
}

fn mark_inode(path: &Path, project: u32, directory: bool) -> io::Result<()> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let mut attributes = FsxAttr::default();
    // SAFETY: the descriptor is open and `attributes` is the structure the ioctl fills in.
    if unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_FSGETXATTR as _, &mut attributes) } < 0 {
        return Err(io::Error::last_os_error());
    }
    attributes.projid = project;
    if directory {
        attributes.xflags |= FS_XFLAG_PROJINHERIT;
    } else {
        attributes.xflags &= !FS_XFLAG_PROJINHERIT;
    }
    // SAFETY: the descriptor is open and `attributes` is the structure the ioctl reads.
    if unsafe { libc::ioctl(file.as_raw_fd(), FS_IOC_FSSETXATTR as _, &attributes) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn mount_table() -> io::Result<String> {
    std::fs::read_to_string("/proc/self/mountinfo")
}

/// The minor number of the block device at `path`, which `/dev/mapper` makes a link to.
pub fn block_minor(path: &str) -> io::Result<u32> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let metadata = std::fs::metadata(path)?;
    if !metadata.file_type().is_block_device() {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    Ok(libc::minor(metadata.rdev()))
}

/// ext4's count of errors on a mounted device-mapper device (`/sys/fs/ext4/dm-<minor>`).
pub fn ext4_errors(minor: u32) -> io::Result<u64> {
    std::fs::read_to_string(format!("/sys/fs/ext4/dm-{minor}/errors_count"))?
        .trim()
        .parse()
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A superblock as `mkfs` makes it, 60 MiB of 1 KiB blocks with the project quota (captured
    /// from the lab, e2fsprogs 1.47.2): `dumpe2fs -h` said 61,440 blocks of 1,024 bytes.
    #[test]
    fn a_real_superblock_tells_the_size_of_its_filesystem_and_its_project_quota() {
        let bytes = include_bytes!("fixtures/ext4-superblock.bin");
        let superblock = Superblock::parse(bytes).unwrap();
        assert_eq!(superblock.block_count, 61_440);
        assert_eq!(superblock.block_size, 1024);
        assert_eq!(superblock.bytes(), 60 << 20);
        assert!(superblock.project_quota());
        // A filesystem of an earlier release has neither feature; one of them alone is not enough.
        let mut older = *bytes;
        older[0x64..0x68].copy_from_slice(&0x0000_0463u32.to_le_bytes());
        assert!(!Superblock::parse(&older).unwrap().project_quota());
        let mut quota_only = *bytes;
        quota_only[0x64..0x68].copy_from_slice(&0x0000_0563u32.to_le_bytes());
        assert!(!Superblock::parse(&quota_only).unwrap().project_quota());
        // The high half of the block count counts with the `64bit` feature only.
        let mut large = *bytes;
        large[0x150..0x154].copy_from_slice(&3u32.to_le_bytes());
        assert_eq!(
            Superblock::parse(&large).unwrap().block_count,
            (3 << 32) | 61_440
        );
        large[0x60..0x64].copy_from_slice(&0x0000_0002u32.to_le_bytes());
        assert_eq!(Superblock::parse(&large).unwrap().block_count, 61_440);
        // Anything else is no superblock.
        assert_eq!(Superblock::parse(&[0; 1024]), None);
        assert_eq!(Superblock::parse(&bytes[..1000]), None);
        let mut huge = *bytes;
        huge[0x18..0x1c].copy_from_slice(&40u32.to_le_bytes());
        assert_eq!(Superblock::parse(&huge), None);
    }

    /// The calls into the kernel are the ABI, so a wrong number does something else without an
    /// error: `linux/quota.h` and `linux/fs.h`, and the sizes of the two structures they move.
    #[test]
    fn the_quota_calls_and_the_attribute_ioctls_are_the_kernels() {
        assert_eq!(project_command(Q_GETQUOTA) as u32, 0x8000_0702);
        assert_eq!(project_command(Q_SETQUOTA) as u32, 0x8000_0802);
        assert_eq!(std::mem::size_of::<FsxAttr>(), 28);
        assert_eq!(std::mem::size_of::<libc::dqblk>(), 72);
        let ioctl = |direction: u64, number: u64| {
            (direction << 30) | (28 << 16) | (u64::from(b'X') << 8) | number
        };
        assert_eq!(FS_IOC_FSGETXATTR, ioctl(2, 31));
        assert_eq!(FS_IOC_FSSETXATTR, ioctl(1, 32));
        assert_eq!(FS_XFLAG_PROJINHERIT, 0x200);
        assert_eq!((QIF_BLIMITS, QIF_ILIMITS), (1, 4));
    }

    /// The kernel's `MOUNT_ATTR_*` values (`linux/mount.h`, uapi): the constants above are the
    /// ABI, so a wrong one mounts with other attributes without any error.
    #[test]
    fn a_volume_is_mounted_nosuid_nodev_noexec_and_without_access_times() {
        assert_eq!(MOUNT_ATTR_NOSUID, 0x0000_0002);
        assert_eq!(MOUNT_ATTR_NODEV, 0x0000_0004);
        assert_eq!(MOUNT_ATTR_NOEXEC, 0x0000_0008);
        assert_eq!(MOUNT_ATTR_NOATIME, 0x0000_0010);
        assert_eq!(
            VOLUME_MOUNT_ATTRIBUTES,
            MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC | MOUNT_ATTR_NOATIME
        );
    }

    /// The kernel takes the attributes and lists them. A tmpfs stands in for a volume's ext4: the
    /// calls that mount it are the same. It needs `CAP_SYS_ADMIN`, which the kernel step of CI
    /// has; elsewhere the test says so and passes.
    #[test]
    #[ignore = "needs CAP_SYS_ADMIN to mount (the kernel step)"]
    fn the_kernel_lists_a_mounted_volume_as_nosuid_nodev_noexec_and_noatime() {
        let target = std::env::temp_dir().join(format!("pgcf-host-{}", std::process::id()));
        std::fs::create_dir_all(&target).unwrap();
        let mount = match detached("tmpfs", None, &[]) {
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => {
                eprintln!("skipped: no CAP_SYS_ADMIN");
                return;
            }
            mount => mount.unwrap(),
        };
        attach(mount, &target).unwrap();
        let table = mount_table().unwrap();
        unmount(&target).unwrap();
        std::fs::remove_dir(&target).unwrap();
        let line = table
            .lines()
            .find(|line| line.split(' ').nth(4).map(Path::new) == Some(target.as_path()))
            .unwrap_or_else(|| panic!("{} is not in the mount table", target.display()));
        assert!(line.contains(" rw,nosuid,nodev,noexec,noatime "), "{line}");
    }
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pgcf-links-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// The directory of the links is made for the agent alone: the root executor follows what is
    /// in it, so nobody else may add a link there.
    #[test]
    fn the_link_directory_is_private_to_the_agent() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("dir").join("run/dev");
        ensure_link_directory(&dir).unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o7777;
        assert_eq!(mode(&dir), 0o700);
        // Again: nothing changes, and a directory with another mode is refused, not trusted.
        ensure_link_directory(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(ensure_link_directory(&dir).is_err());
        std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[test]
    fn a_link_is_put_in_place_by_rename_and_replaced_by_rename() {
        let dir = scratch("install").join("dev");
        let link = dir.join("a1b2c3d4e5f6g7h8i9j0");
        install_link(&link, "/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g1").unwrap();
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            Path::new("/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g1")
        );
        // Another generation takes the link over without a moment in which there is none.
        install_link(&link, "/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g2").unwrap();
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            Path::new("/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g2")
        );
        // The directory holds the link and nothing of the rename.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["a1b2c3d4e5f6g7h8i9j0"]);
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    /// A volume drops only its own link: the link of another generation of the database stays.
    #[test]
    fn a_link_is_dropped_only_while_it_points_to_the_volume() {
        let dir = scratch("drop").join("dev");
        let link = dir.join("a1b2c3d4e5f6g7h8i9j0");
        let (first, second) = ("/dev/mapper/pgcf-x_g1", "/dev/mapper/pgcf-x_g2");
        install_link(&link, second).unwrap();
        drop_link(&link, first).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), Path::new(second));
        drop_link(&link, second).unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        // No link is no error: it is what a volume that was never attached has.
        drop_link(&link, second).unwrap();
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    /// Agent start: the namespace of the agent before is gone, so every link is stale.
    #[test]
    fn the_agents_start_drops_every_link_and_the_leftovers_of_a_rename() {
        let dir = scratch("reset").join("dev");
        install_link(&dir.join("aaaaaaaaaaaaaaaaaaaa"), "/dev/mapper/a").unwrap();
        install_link(&dir.join("bbbbbbbbbbbbbbbbbbbb"), "/dev/mapper/b").unwrap();
        std::os::unix::fs::symlink("/dev/mapper/c", dir.join("cccccccccccccccccccc.new")).unwrap();
        reset_links(&dir).unwrap();
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
