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
    path::{Path, PathBuf},
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
