// SPDX-License-Identifier: Apache-2.0
//! The Linux host of a database volume: device-mapper status ioctls, the new mount API (fsopen,
//! fsconfig, fsmount) and `openat2` below a detached mount.
use crate::{
    dm,
    holder::{Device, Host, Mounted},
    pg_control::{CONTROL_PATH, Control, parse_control},
    volume::Volume,
};
use std::{
    ffi::CString,
    fs::File,
    io::{self, Read},
    mem,
    os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd},
    path::PathBuf,
    sync::mpsc,
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
/// How long fsopen..fsmount of the tenant volume may take before the attach gives up.
const MOUNT_DEADLINE: Duration = Duration::from_secs(2);

pub struct LinuxHost {
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
    parse_control(&bytes)
}

impl Default for LinuxHost {
    fn default() -> Self {
        Self {
            control: PathBuf::from("/dev/mapper/control"),
        }
    }
}

impl LinuxHost {
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
}

impl Host for LinuxHost {
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
            Ok(Ok(fd)) => Ok(Mounted { fd }),
            _ => Err("mount_failed"),
        }
    }

    fn read_control(&self, mounted: &Mounted) -> Result<Control, &'static str> {
        let resolve = libc::RESOLVE_BENEATH
            | libc::RESOLVE_NO_SYMLINKS
            | libc::RESOLVE_NO_MAGICLINKS
            | libc::RESOLVE_NO_XDEV;
        let file = open_below(
            mounted.fd.as_fd(),
            CONTROL_PATH,
            libc::O_RDONLY | libc::O_NOFOLLOW,
            resolve,
        )
        .map_err(|_| "control_unreadable")?;
        read_control_file(file)
    }
}

#[cfg(test)]
mod kernel_tests {
    //! Run as root with CAP_SYS_ADMIN and no seccomp/AppArmor mount filter (the CI kernel step);
    //! a tmpfs stands in for the tenant volume.
    use super::*;
    use std::io::Write;

    fn tmpfs() -> Mounted {
        Mounted {
            fd: detached("tmpfs", None).expect("detached tmpfs"),
        }
    }

    #[test]
    #[ignore = "needs CAP_SYS_ADMIN (CI kernel step)"]
    fn pg_control_is_read_through_the_detached_mount_fd() {
        let host = LinuxHost::default();
        let mounted = tmpfs();
        let root = mounted.fd.as_raw_fd();
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
        let root = other.fd.as_raw_fd();
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
}
