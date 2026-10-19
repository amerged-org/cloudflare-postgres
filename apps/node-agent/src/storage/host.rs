// SPDX-License-Identifier: Apache-2.0
//! The kernel side of a volume: mounting it with the new mount API, unmounting, `statvfs`, and
//! the mount table and ext4's error counter.
use super::FsUsage;
use std::{
    ffi::CString,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

// linux/mount.h
const MOVE_MOUNT_F_EMPTY_PATH: libc::c_uint = 0x4;
const FSOPEN_CLOEXEC: libc::c_uint = 0x1;
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

/// A detached mount of `fstype`, with `source` when given.
pub(crate) fn detached(fstype: &str, source: Option<&str>) -> io::Result<OwnedFd> {
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
pub fn mount_ext4(device: &str, target: &Path) -> io::Result<()> {
    attach(detached("ext4", Some(device))?, target)
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
        let mount = match detached("tmpfs", None) {
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
}
