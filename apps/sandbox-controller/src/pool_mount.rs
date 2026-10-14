// SPDX-License-Identifier: Apache-2.0
//! Fixed ext4 mount primitives. Authorization, CSI custody and global DM zero precede creation.
//! These calls run only in a bounded single-thread worker in the proven CRI mount context.
use std::{
    ffi::CString,
    fs::File,
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::{FileTypeExt, MetadataExt},
    },
    path::Path,
};

const TMPFS_MAGIC: i128 = 0x0102_1994;
fn refused() -> io::Error {
    io::Error::other("pool_mount_identity_unconfirmed")
}
fn owned(value: libc::c_long) -> io::Result<OwnedFd> {
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { OwnedFd::from_raw_fd(value as i32) })
    }
}
#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}
fn beneath(parent: &File, path: &str) -> io::Result<File> {
    let path = CString::new(path).map_err(|_| refused())?;
    let how = OpenHow {
        flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: 0x08 | 0x04 | 0x02,
    };
    owned(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            parent.as_raw_fd(),
            path.as_ptr(),
            &how,
            std::mem::size_of::<OpenHow>(),
        )
    })
    .map(File::from)
}
fn pre_mount_directory(file: &File) -> io::Result<()> {
    let meta = file.metadata()?;
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if !meta.is_dir()
        || meta.uid() != 0
        || meta.mode() & 0o7777 != 0o755
        || unsafe { libc::fstatfs(file.as_raw_fd(), &mut stat) } != 0
        || i128::from(stat.f_type) != TMPFS_MAGIC
    {
        return Err(refused());
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MountIdentity {
    pub device: u64,
    pub mount_id: u64,
}
fn identity(file: &File) -> io::Result<MountIdentity> {
    let mut stat: libc::statx = unsafe { std::mem::zeroed() };
    // Pinned 6.18.54's unique mount ID must be measured; no proc path or recycled ID fallback.
    if unsafe {
        libc::statx(
            file.as_raw_fd(),
            c"".as_ptr(),
            libc::AT_EMPTY_PATH,
            0x4000,
            &mut stat,
        )
    } != 0
        || stat.stx_mask & 0x4000 == 0
        || stat.stx_mnt_id == 0
    {
        return Err(refused());
    }
    Ok(MountIdentity {
        device: file.metadata()?.dev(),
        mount_id: stat.stx_mnt_id,
    })
}
pub struct DataAnchor {
    parent: File,
    target: File,
}
/// Recovery opens only the lower tmpfs parent; retaining the attached ext4 directory would
/// itself make a normal unmount busy. This object cannot be used as a mount destination.
pub struct MountedAnchor {
    parent: File,
}
impl MountedAnchor {
    pub fn open(empty_dir: &Path) -> io::Result<Self> {
        if !empty_dir.is_absolute() || std::fs::canonicalize(empty_dir)? != empty_dir {
            return Err(refused());
        }
        let path = CString::new(empty_dir.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
        let how = OpenHow {
            flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: 0x04 | 0x02,
        };
        let parent = File::from(owned(unsafe {
            libc::syscall(
                libc::SYS_openat2,
                libc::AT_FDCWD,
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        })?);
        pre_mount_directory(&parent)?;
        Ok(Self { parent })
    }
    pub fn for_pod(uid: &str) -> io::Result<Self> {
        if !crate::pool_mount::pod_uid_valid(uid) {
            return Err(refused());
        }
        Self::open(Path::new(&format!(
            "/var/lib/kubelet/pods/{uid}/volumes/kubernetes.io~empty-dir/volume"
        )))
    }
    pub fn identity(&self) -> io::Result<MountIdentity> {
        identity(&beneath(&self.parent, "data")?)
    }
    pub fn detach_in_one_shot(&self, expected: MountIdentity) -> io::Result<()> {
        detach(&self.parent, expected)
    }
}
fn pod_uid_valid(uid: &str) -> bool {
    uid.len() == 36
        && !uid.bytes().enumerate().any(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b != b'-'
            } else {
                !b.is_ascii_hexdigit()
            }
        })
}
fn detach(parent: &File, expected: MountIdentity) -> io::Result<()> {
    if std::fs::read_dir("/proc/self/task")?.take(2).count() != 1 {
        return Err(refused());
    }
    pre_mount_directory(parent)?;
    let current = beneath(parent, "data")?;
    if identity(&current)? != expected {
        return Err(refused());
    }
    drop(current);
    let prior = File::open(".")?;
    if unsafe { libc::fchdir(parent.as_raw_fd()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { libc::umount2(c"data".as_ptr(), libc::UMOUNT_NOFOLLOW) };
    let error = io::Error::last_os_error();
    if unsafe { libc::fchdir(prior.as_raw_fd()) } != 0 {
        return Err(refused());
    }
    if result != 0 {
        return Err(error);
    }
    pre_mount_directory(&beneath(parent, "data")?)
}
impl DataAnchor {
    /// Only an authenticated tenant-free preparation invokes this fixed Pod path. No ownership
    /// is repaired: kubelet's root-owned tmpfs0777 is sealed0755, and data is created root0755.
    pub fn prepare_for_pod(uid: &str) -> io::Result<()> {
        if !pod_uid_valid(uid) {
            return Err(refused());
        }
        let root = Path::new("/var/lib/kubelet/pods")
            .join(uid)
            .join("volumes/kubernetes.io~empty-dir/volume");
        Self::prepare(&root)
    }
    pub fn prepare(empty_dir: &Path) -> io::Result<()> {
        if !empty_dir.is_absolute() || std::fs::canonicalize(empty_dir)? != empty_dir {
            return Err(refused());
        }
        let path = CString::new(empty_dir.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
        let how = OpenHow {
            flags: (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: 0x04 | 0x02,
        };
        let directory = File::from(owned(unsafe {
            libc::syscall(
                libc::SYS_openat2,
                libc::AT_FDCWD,
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        })?);
        let m = directory.metadata()?;
        let mut fs: libc::statfs = unsafe { std::mem::zeroed() };
        if m.uid() != 0
            || ![0o755, 0o777].contains(&(m.mode() & 0o7777))
            || unsafe { libc::fstatfs(directory.as_raw_fd(), &mut fs) } != 0
            || i128::from(fs.f_type) != TMPFS_MAGIC
        {
            return Err(refused());
        }
        for entry in std::fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))? {
            if entry?.file_name() != "data" {
                return Err(refused());
            }
        }
        let data = c"data";
        if unsafe { libc::mkdirat(directory.as_raw_fd(), data.as_ptr(), 0o755) } != 0
            && io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(io::Error::last_os_error());
        }
        pre_mount_directory(&beneath(&directory, "data")?)?;
        if unsafe { libc::fchmod(directory.as_raw_fd(), 0o755) } != 0 {
            return Err(io::Error::last_os_error());
        }
        pre_mount_directory(&directory)
    }
    pub fn tmpfs_device(&self) -> io::Result<u64> {
        pre_mount_directory(&self.parent)?;
        pre_mount_directory(&self.target)?;
        Ok(self.parent.metadata()?.dev())
    }
    /// A prepared root-owned tmpfs emptyDir and its existing data directory; rechecked EACH bind.
    pub fn open(empty_dir: &Path) -> io::Result<Self> {
        if !empty_dir.is_absolute() || std::fs::canonicalize(empty_dir)? != empty_dir {
            return Err(refused());
        }
        let path = CString::new(empty_dir.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
        let how = OpenHow {
            flags: (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
            mode: 0,
            resolve: 0x04 | 0x02,
        };
        let parent = File::from(owned(unsafe {
            libc::syscall(
                libc::SYS_openat2,
                libc::AT_FDCWD,
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        })?);
        pre_mount_directory(&parent)?;
        let target = beneath(&parent, "data")?;
        pre_mount_directory(&target)?;
        Ok(Self { parent, target })
    }
    pub fn for_pod(uid: &str) -> io::Result<Self> {
        if !pod_uid_valid(uid) {
            return Err(refused());
        }
        Self::open(Path::new(&format!(
            "/var/lib/kubelet/pods/{uid}/volumes/kubernetes.io~empty-dir/volume"
        )))
    }
    /// This worker must have no other threads and no open descriptors into the mounted ext4.
    pub fn detach_in_one_shot(&self, expected: MountIdentity) -> io::Result<()> {
        detach(&self.parent, expected)
    }
}
/// Both descriptors stay tracked until attachment or drop. fsmount does not close fc->root.
pub struct Ext4Creation {
    context: OwnedFd,
    mount: OwnedFd,
    device: u64,
}
impl Ext4Creation {
    pub fn exclusive(device: &File) -> io::Result<Self> {
        Self::create(device, false)
    }
    fn create(device: &File, readonly: bool) -> io::Result<Self> {
        let meta = device.metadata()?;
        if !meta.file_type().is_block_device() {
            return Err(refused());
        }
        let context = owned(unsafe { libc::syscall(libc::SYS_fsopen, c"ext4".as_ptr(), 1) })?;
        // This is an already verified O_PATH block-device descriptor, not a native CLI payload.
        let source =
            CString::new(format!("/proc/self/fd/{}", device.as_raw_fd())).map_err(|_| refused())?;
        if unsafe {
            libc::syscall(
                libc::SYS_fsconfig,
                context.as_raw_fd(),
                1,
                c"source".as_ptr(),
                source.as_ptr(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if readonly {
            // ro + noload prevents both writes and ext4 journal replay. Mount attributes alone
            // would not prove that filesystem creation did not perform recovery writes.
            for key in [c"ro", c"noload"] {
                if unsafe {
                    libc::syscall(
                        libc::SYS_fsconfig,
                        context.as_raw_fd(),
                        0,
                        key.as_ptr(),
                        std::ptr::null::<libc::c_char>(),
                        0,
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
        }
        if unsafe {
            libc::syscall(
                libc::SYS_fsconfig,
                context.as_raw_fd(),
                8,
                std::ptr::null::<libc::c_char>(),
                std::ptr::null::<libc::c_char>(),
                0,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let mount = owned(unsafe {
            libc::syscall(
                libc::SYS_fsmount,
                context.as_raw_fd(),
                1,
                if readonly { 15 } else { 14 },
            )
        })?;
        let actual = File::from(mount.try_clone()?).metadata()?.dev();
        if actual != meta.rdev() {
            return Err(refused());
        }
        if readonly {
            let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
            if unsafe { libc::fstatfs(mount.as_raw_fd(), &mut stat) } != 0
                || stat.f_flags as u64 & libc::ST_RDONLY == 0
            {
                return Err(refused());
            }
        }
        Ok(Self {
            context,
            mount,
            device: actual,
        })
    }
    pub fn attach(self, target: &DataAnchor) -> io::Result<MountIdentity> {
        pre_mount_directory(&target.parent)?;
        pre_mount_directory(&target.target)?;
        let current = beneath(&target.parent, "data")?;
        let one = current.metadata()?;
        let two = target.target.metadata()?;
        pre_mount_directory(&current)?;
        if one.dev() != two.dev() || one.ino() != two.ino() || one.nlink() == 0 {
            return Err(refused());
        }
        drop(current);
        if unsafe {
            libc::syscall(
                libc::SYS_move_mount,
                self.mount.as_raw_fd(),
                c"".as_ptr(),
                target.target.as_raw_fd(),
                c"".as_ptr(),
                0x04 | 0x40,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        let actual = identity(&beneath(&target.parent, "data")?)?;
        if actual.device != self.device {
            return Err(refused());
        }
        drop(self.mount);
        drop(self.context); // no invisible creation reference survives acceptance
        Ok(actual)
    }
}

/// Prewake inspection cannot attach or remount this tree. Both invisible creation references
/// remain tracked until the caller closes the passed PGDATA FD and drops this object.
pub struct Ext4ReadOnly {
    creation: Ext4Creation,
}
impl Ext4ReadOnly {
    pub fn exclusive_noload(device: &File) -> io::Result<Self> {
        Ok(Self {
            creation: Ext4Creation::create(device, true)?,
        })
    }
    pub fn pgdata(&self) -> io::Result<File> {
        let root = File::from(self.creation.mount.try_clone()?);
        let data = beneath(&root, "pgdata")?;
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if data.metadata()?.dev() != self.creation.device
            || unsafe { libc::fstatfs(data.as_raw_fd(), &mut stat) } != 0
            || stat.f_flags as u64 & libc::ST_RDONLY == 0
        {
            return Err(refused());
        }
        Ok(data)
    }
}
