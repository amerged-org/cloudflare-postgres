// SPDX-License-Identifier: Apache-2.0
//! The Linux host: device-mapper status ioctls, the new mount API (fsopen, fsconfig, fsmount,
//! open_tree, move_mount), mount-namespace entry on a short-lived thread, and `/proc` scans.
use crate::{
    agent::{Device, Host, Mounted},
    dm,
};
use pgcf_native_controller::attach_protocol::{CONTROL_PATH, Control, DATA_PATH, Volume};
use std::{
    ffi::CString,
    fs::File,
    io::{self, Read},
    mem,
    os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
    path::PathBuf,
    sync::{Mutex, PoisonError, mpsc},
    time::Duration,
};

// linux/mount.h
const FSOPEN_CLOEXEC: libc::c_uint = 0x1;
const FSCONFIG_SET_STRING: libc::c_uint = 1;
const FSCONFIG_CMD_CREATE: libc::c_uint = 6;
const FSMOUNT_CLOEXEC: libc::c_uint = 0x1;
const MOUNT_ATTR_NOSUID: libc::c_uint = 0x2;
const MOUNT_ATTR_NODEV: libc::c_uint = 0x4;
const MOUNT_ATTR_NOEXEC: libc::c_uint = 0x8;
const MOVE_MOUNT_F_EMPTY_PATH: libc::c_uint = 0x4;
const OPEN_TREE_CLONE: libc::c_uint = 0x1;
/// How long fsopen..fsmount of the tenant volume may take before the attach gives up.
const MOUNT_DEADLINE: Duration = Duration::from_secs(2);
const POSTMASTER_PATH: &str = "pgdata/postmaster.pid";

pub(crate) struct LinuxHost {
    proc: PathBuf,
    control: PathBuf,
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
            MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC,
        )
    })
}
fn mounted(fd: OwnedFd) -> Mounted {
    Mounted {
        fd: Some(fd),
        clone: Mutex::default(),
        live: None,
    }
}

/// `openat2` below `directory` with `resolve` restrictions.
fn open_below(
    directory: BorrowedFd<'_>,
    path: &str,
    flags: libc::c_int,
    resolve: u64,
) -> io::Result<File> {
    let path = text(path)?;
    // SAFETY: open_how is plain data; zero is its documented default.
    let mut how: libc::open_how = unsafe { mem::zeroed() };
    how.flags = (flags | libc::O_CLOEXEC | libc::O_NOCTTY) as u64;
    how.resolve = resolve;
    let fd = owned(unsafe {
        libc::syscall(
            libc::SYS_openat2,
            directory.as_raw_fd(),
            path.as_ptr(),
            &how as *const libc::open_how,
            mem::size_of::<libc::open_how>(),
        )
    })?;
    Ok(File::from(fd))
}
fn read_control_file(mut file: File) -> Result<Control, &'static str> {
    let mut bytes = Vec::with_capacity(512);
    file.by_ref()
        .take(512)
        .read_to_end(&mut bytes)
        .map_err(|_| "control_unreadable")?;
    pgcf_native_controller::attach_protocol::parse_control(&bytes)
}

impl LinuxHost {
    pub(crate) fn new() -> Self {
        Self {
            proc: PathBuf::from("/proc"),
            control: PathBuf::from("/dev/mapper/control"),
        }
    }

    fn ioctl(&self, command: u32, buffer: &mut [u8]) -> io::Result<()> {
        let control = File::options().read(true).write(true).open(&self.control)?;
        // SAFETY: `buffer` is a dm_ioctl header plus data area of the size it declares.
        let result = unsafe { libc::ioctl(control.as_raw_fd(), command as _, buffer.as_mut_ptr()) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    fn status(&self, name: &str) -> Result<Option<Device>, &'static str> {
        let mut buffer = dm::request(name, mem::size_of::<dm::DmIoctl>())?;
        match self.ioctl(dm::DM_DEV_STATUS, &mut buffer) {
            Err(error) if error.raw_os_error() == Some(libc::ENXIO) => return Ok(None),
            Err(_) => return Err("device_status_failed"),
            Ok(()) => {}
        }
        let status = dm::status(&buffer).map_err(|_| "device_status_failed")?;
        Ok(Some(Device {
            open_count: status.open_count,
            suspended: status.suspended,
            uuid: status.uuid,
            dev: status.dev,
        }))
    }

    /// Runs `work` on a fresh thread inside the mount namespace of `pid`. The thread unshares its
    /// filesystem attributes first, so nothing else in the agent changes namespace.
    fn in_namespace(
        &self,
        pid: u32,
        work: impl FnOnce() -> io::Result<()> + Send,
    ) -> Result<(), &'static str> {
        let namespace = File::open(self.proc.join(pid.to_string()).join("ns/mnt"))
            .map_err(|_| "container_missing")?;
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    // SAFETY: both act on this thread only; their results are checked.
                    if unsafe { libc::unshare(libc::CLONE_FS) } != 0
                        || unsafe { libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) } != 0
                    {
                        return Err("namespace_failed");
                    }
                    work().map_err(|_| "mount_failed")
                })
                .join()
                .unwrap_or(Err("mount_failed"))
        })
    }
}

impl Host for LinuxHost {
    fn boot_id(&self) -> Result<String, &'static str> {
        std::fs::read_to_string(self.proc.join("sys/kernel/random/boot_id"))
            .map(|text| text.trim().to_string())
            .map_err(|_| "boot_id_unreadable")
    }

    fn device(&self, volume: &Volume) -> Result<Option<Device>, &'static str> {
        self.status(&volume.dm_name())
    }

    fn devices(&self) -> Result<Vec<(String, Device)>, &'static str> {
        let mut length = 16 * 1024;
        let names = loop {
            let mut buffer = dm::request("", length)?;
            self.ioctl(dm::DM_LIST_DEVICES, &mut buffer)
                .map_err(|_| "device_list_failed")?;
            match dm::names(&buffer).map_err(|_| "device_list_failed")? {
                Some(names) => break names,
                None if length < 1024 * 1024 => length *= 4,
                None => return Err("device_list_failed"),
            }
        };
        let mut devices = Vec::with_capacity(names.len());
        for name in names {
            if let Some(device) = self.status(&name)? {
                devices.push((name, device));
            }
        }
        Ok(devices)
    }

    fn mount(&self, volume: &Volume) -> Result<Mounted, &'static str> {
        let source = format!("/dev/mapper/{}", volume.dm_name());
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("attach-mount".into())
            .spawn(move || {
                // A mount that finishes after the deadline is closed here again.
                let _ = sender.send(detached("ext4", Some(&source)));
            })
            .map_err(|_| "mount_failed")?;
        match receiver.recv_timeout(MOUNT_DEADLINE) {
            Ok(Ok(fd)) => Ok(mounted(fd)),
            _ => Err("mount_failed"),
        }
    }

    fn read_control(&self, mounted: &Mounted) -> Result<Control, &'static str> {
        let mount = mounted.fd.as_ref().ok_or("control_unreadable")?;
        let resolve = libc::RESOLVE_BENEATH
            | libc::RESOLVE_NO_SYMLINKS
            | libc::RESOLVE_NO_MAGICLINKS
            | libc::RESOLVE_NO_XDEV;
        let file = open_below(
            mount.as_fd(),
            CONTROL_PATH,
            libc::O_RDONLY | libc::O_NOFOLLOW,
            resolve,
        )
        .map_err(|_| "control_unreadable")?;
        read_control_file(file)
    }

    fn container_pid(&self, container_id: &str) -> Result<Option<u32>, &'static str> {
        let mut lowest: Option<u32> = None;
        for entry in std::fs::read_dir(&self.proc).map_err(|_| "proc_unreadable")? {
            let Ok(entry) = entry else { continue };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if lowest.is_some_and(|known| known < pid) {
                continue;
            }
            // Processes come and go during the scan; an unreadable one is not the container.
            if std::fs::read_to_string(entry.path().join("cgroup"))
                .is_ok_and(|cgroup| cgroup.contains(container_id))
            {
                lowest = Some(pid);
            }
        }
        Ok(lowest)
    }

    /// The first move takes the detached mount and, still inside that namespace, clones it: a
    /// detached mount cannot be cloned before kernel 6.15, an attached one always can. A later
    /// move takes that clone.
    fn move_into(&self, mounted: &Mounted, pid: u32, clone: bool) -> Result<(), &'static str> {
        let (empty, target) = (
            text("").map_err(|_| "mount_failed")?,
            text(DATA_PATH).map_err(|_| "mount_failed")?,
        );
        let move_mount = |fd: libc::c_int| {
            // SAFETY: move_mount with a live mount fd and NUL-terminated paths.
            ok(unsafe {
                libc::syscall(
                    libc::SYS_move_mount,
                    fd,
                    empty.as_ptr(),
                    libc::AT_FDCWD,
                    target.as_ptr(),
                    MOVE_MOUNT_F_EMPTY_PATH,
                )
            })
        };
        if clone {
            let copy = mounted
                .clone
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
                .ok_or("mount_failed")?;
            return self.in_namespace(pid, || move_mount(copy.as_raw_fd()));
        }
        let fd = mounted.fd.as_ref().ok_or("mount_failed")?.as_raw_fd();
        self.in_namespace(pid, || {
            move_mount(fd)?;
            // A missing clone only fails the move that needs it.
            // SAFETY: open_tree on the mount just attached in this namespace.
            if let Ok(copy) = owned(unsafe {
                libc::syscall(
                    libc::SYS_open_tree,
                    fd,
                    empty.as_ptr(),
                    OPEN_TREE_CLONE
                        | libc::O_CLOEXEC as libc::c_uint
                        | libc::AT_EMPTY_PATH as libc::c_uint,
                )
            }) {
                *mounted.clone.lock().unwrap_or_else(PoisonError::into_inner) = Some(copy);
            }
            Ok(())
        })
    }

    fn unmount_in(&self, pid: u32) -> Result<(), &'static str> {
        let target = text(DATA_PATH).map_err(|_| "mount_failed")?;
        self.in_namespace(pid, || {
            // SAFETY: umount2 with a NUL-terminated path; flags 0, never MNT_DETACH.
            ok(libc::c_long::from(unsafe {
                libc::umount2(target.as_ptr(), 0)
            }))
        })
    }

    fn mounted_in(&self, pid: u32, dev: (u32, u32)) -> Result<bool, &'static str> {
        let mountinfo = std::fs::read_to_string(self.proc.join(pid.to_string()).join("mountinfo"))
            .map_err(|_| "audit_failed")?;
        let wanted = format!("{}:{}", dev.0, dev.1);
        // The topmost mount on the data path is the last one listed for it.
        Ok(mountinfo
            .lines()
            .rev()
            .find_map(|line| {
                let fields: Vec<&str> = line.split(' ').collect();
                (fields.len() > 4 && fields[4] == DATA_PATH).then(|| fields[2] == wanted)
            })
            .unwrap_or(false))
    }

    fn control_in(&self, pid: u32) -> Result<(Option<Control>, bool), &'static str> {
        let root = File::open(self.proc.join(pid.to_string()).join("root"))
            .map_err(|_| "container_missing")?;
        let resolve = libc::RESOLVE_IN_ROOT | libc::RESOLVE_NO_MAGICLINKS;
        let data = DATA_PATH.trim_start_matches('/');
        let control = open_below(
            root.as_fd(),
            &format!("{data}/{CONTROL_PATH}"),
            libc::O_RDONLY,
            resolve,
        )
        .ok()
        .and_then(|file| read_control_file(file).ok());
        // Only a postmaster.pid that is provably absent counts as stopped.
        let running = !matches!(
            open_below(
                root.as_fd(),
                &format!("{data}/{POSTMASTER_PATH}"),
                libc::O_PATH,
                resolve,
            ),
            Err(error) if error.raw_os_error() == Some(libc::ENOENT)
        );
        Ok((control, running))
    }
}

#[cfg(test)]
mod kernel_tests {
    //! Run as root with CAP_SYS_ADMIN, CAP_SYS_CHROOT and no seccomp/AppArmor mount filter (the
    //! CI kernel step); a tmpfs stands in for the tenant volume.
    use super::*;
    use std::{
        io::Write,
        os::unix::process::CommandExt,
        process::{Child, Command},
    };

    struct Namespace(Child);
    impl Drop for Namespace {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    /// A process in a private copy of this mount namespace.
    fn namespace() -> Namespace {
        let mut command = Command::new("sleep");
        command.arg("60");
        // SAFETY: only async-signal-safe syscalls run between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::unshare(libc::CLONE_NEWNS) != 0
                    || libc::mount(
                        std::ptr::null(),
                        c"/".as_ptr(),
                        std::ptr::null(),
                        libc::MS_REC | libc::MS_PRIVATE,
                        std::ptr::null(),
                    ) != 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Namespace(command.spawn().expect("child in its own mount namespace"))
    }
    fn dev_of(fd: &OwnedFd) -> (u32, u32) {
        let mut stat: libc::stat = unsafe { mem::zeroed() };
        assert_eq!(unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) }, 0);
        (libc::major(stat.st_dev), libc::minor(stat.st_dev))
    }
    fn tmpfs() -> Mounted {
        mounted(detached("tmpfs", None).expect("detached tmpfs"))
    }

    #[test]
    #[ignore = "needs CAP_SYS_ADMIN and CAP_SYS_CHROOT (CI kernel step)"]
    fn a_tmpfs_fsmount_moves_into_another_mount_namespace_and_appears_in_its_mountinfo() {
        std::fs::create_dir_all(DATA_PATH).unwrap();
        let host = LinuxHost::new();
        let child = namespace();
        let pid = child.0.id();
        let mounted = tmpfs();
        let dev = dev_of(mounted.fd.as_ref().unwrap());
        host.move_into(&mounted, pid, false).unwrap();
        drop(mounted);
        assert_eq!(host.mounted_in(pid, dev), Ok(true));
        assert_eq!(host.mounted_in(std::process::id(), dev), Ok(false));
        // The clone carries the same filesystem into a second namespace.
        let other = namespace();
        let mounted = tmpfs();
        let dev = dev_of(mounted.fd.as_ref().unwrap());
        host.move_into(&mounted, pid, false).unwrap();
        host.move_into(&mounted, other.0.id(), true).unwrap();
        assert_eq!(host.mounted_in(pid, dev), Ok(true));
        assert_eq!(host.mounted_in(other.0.id(), dev), Ok(true));
    }

    #[test]
    #[ignore = "needs CAP_SYS_ADMIN (CI kernel step)"]
    fn pg_control_is_read_through_the_detached_mount_fd() {
        let host = LinuxHost::new();
        let mounted = tmpfs();
        let root = mounted.fd.as_ref().unwrap().as_raw_fd();
        for directory in [c"pgdata", c"pgdata/global"] {
            assert_eq!(unsafe { libc::mkdirat(root, directory.as_ptr(), 0o700) }, 0);
        }
        let mut bytes = vec![0u8; 296];
        bytes[..8].copy_from_slice(&7_431_215_993_172_011_234u64.to_le_bytes());
        bytes[8..12].copy_from_slice(&1800u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1i32.to_le_bytes());
        bytes[48..52].copy_from_slice(&3u32.to_le_bytes());
        let fd = unsafe {
            libc::openat(
                root,
                c"pgdata/global/pg_control".as_ptr(),
                libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
                0o600,
            )
        };
        assert!(fd >= 0);
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&bytes).unwrap();
        drop(file);
        assert_eq!(
            host.read_control(&mounted),
            Ok(Control {
                state: 1,
                system_identifier: "7431215993172011234".into(),
                timeline: 3,
            })
        );
        // A symlinked pg_control is never followed out of the volume.
        let other = tmpfs();
        let root = other.fd.as_ref().unwrap().as_raw_fd();
        for directory in [c"pgdata", c"pgdata/global"] {
            assert_eq!(unsafe { libc::mkdirat(root, directory.as_ptr(), 0o700) }, 0);
        }
        assert_eq!(
            unsafe {
                libc::symlinkat(
                    c"/proc/self/stat".as_ptr(),
                    root,
                    c"pgdata/global/pg_control".as_ptr(),
                )
            },
            0
        );
        assert_eq!(host.read_control(&other), Err("control_unreadable"));
    }

    #[test]
    #[ignore = "needs CAP_SYS_ADMIN and CAP_SYS_CHROOT (CI kernel step)"]
    fn unmount_in_removes_the_mount_from_the_target_namespace_only() {
        std::fs::create_dir_all(DATA_PATH).unwrap();
        let host = LinuxHost::new();
        let own = std::process::id();
        let placeholder = tmpfs();
        let placeholder_dev = dev_of(placeholder.fd.as_ref().unwrap());
        // The placeholder sits on the data path here and, copied, in the child.
        host.move_into(&placeholder, own, false).unwrap();
        // An open mount fd keeps the mount busy; the agent closes it before any unmount.
        drop(placeholder);
        let child = namespace();
        let pid = child.0.id();
        let tenant = tmpfs();
        let tenant_dev = dev_of(tenant.fd.as_ref().unwrap());
        host.move_into(&tenant, pid, false).unwrap();
        drop(tenant);
        assert_eq!(host.mounted_in(pid, tenant_dev), Ok(true));
        host.unmount_in(pid).unwrap();
        assert_eq!(host.mounted_in(pid, tenant_dev), Ok(false));
        assert_eq!(host.mounted_in(pid, placeholder_dev), Ok(true));
        assert_eq!(host.mounted_in(own, placeholder_dev), Ok(true));
        host.unmount_in(own).unwrap();
        assert_eq!(host.mounted_in(own, placeholder_dev), Ok(false));
    }

    #[test]
    #[ignore = "reads a /proc layout (CI kernel step)"]
    fn container_pid_finds_the_lowest_pid_of_a_cgroup_marker() {
        let root = std::env::temp_dir().join(format!("pgcf-attach-proc-{}", std::process::id()));
        let marker = "cri-containerd-".to_string() + &"a".repeat(64);
        for (pid, cgroup) in [
            ("7", "0::/kubepods/other\n".to_string()),
            ("12", format!("0::/kubepods/pod1/{marker}.scope\n")),
            ("300", format!("0::/kubepods/pod1/{marker}.scope\n")),
            ("self", format!("0::/{marker}\n")),
        ] {
            std::fs::create_dir_all(root.join(pid)).unwrap();
            std::fs::write(root.join(pid).join("cgroup"), cgroup).unwrap();
        }
        std::fs::create_dir_all(root.join("44")).unwrap();
        let host = LinuxHost {
            proc: root.clone(),
            control: PathBuf::from("/dev/mapper/control"),
        };
        assert_eq!(host.container_pid(&"a".repeat(64)), Ok(Some(12)));
        assert_eq!(host.container_pid(&"b".repeat(64)), Ok(None));
        // The real /proc: this process is found by a marker of its own cgroup.
        let own = std::fs::read_to_string("/proc/self/cgroup").unwrap();
        assert!(
            LinuxHost::new()
                .container_pid(own.trim())
                .unwrap()
                .is_some()
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
