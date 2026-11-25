// SPDX-License-Identifier: Apache-2.0
//! FD-anchored filesystem operations for root-privileged operations on tenant-writable database
//! directories: every directory step uses `O_DIRECTORY | O_NOFOLLOW` and verifies `st_dev` stays
//! on the database volume, preventing symlink traversal and TOCTOU swaps.
use std::{
    ffi::{CStr, CString, OsString},
    fs::File,
    io::{self, Write},
    os::unix::{
        ffi::OsStringExt,
        fs::{MetadataExt, fchown},
        io::{AsRawFd, FromRawFd},
    },
    path::Path,
};

const MAX_DIR_ENTRIES: usize = 65_536;

#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}

#[cfg(target_os = "macos")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

fn c_name(name: &str) -> io::Result<CString> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsafe relative path component",
        ));
    }
    CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid path"))
}

fn c_path(path: &Path) -> io::Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

/// Opens `path` as a directory without following a symlink at its final component.
pub(crate) fn open_dir_root_nofollow(path: &Path) -> io::Result<File> {
    let raw = c_path(path)?;
    let fd = unsafe {
        libc::open(
            raw.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Opens a direct child directory `name` below `parent` without following symlinks and verifies it
/// stays on the same filesystem (`st_dev`) as `parent`.
pub(crate) fn open_dir_child_same_dev(parent: &File, name: &str) -> io::Result<File> {
    let component = c_name(name)?;
    let parent_dev = parent.metadata()?.dev();
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            component.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let child = unsafe { File::from_raw_fd(fd) };
    if child.metadata()?.dev() != parent_dev {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "directory crossed filesystem boundary",
        ));
    }
    Ok(child)
}

/// Unlinks `name` inside `dir` (never following symlinks). A missing entry is treated as done.
pub(crate) fn unlink_at(dir: &File, name: &str) -> io::Result<()> {
    let component = c_name(name)?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), component.as_ptr(), 0) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
    }
    Ok(())
}

/// Creates a new regular file `name` exclusively inside `dir` (`O_CREAT | O_EXCL | O_NOFOLLOW`).
pub(crate) fn create_exclusive_at(dir: &File, name: &str, mode: u32) -> io::Result<File> {
    let component = c_name(name)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            component.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Replaces `name` inside `dir` atomically via `unlinkat` + `openat(O_CREAT|O_EXCL|O_NOFOLLOW)`,
/// writes `content`, sets ownership to `(uid, gid)` via `fchown`, and fsyncs the file.
pub(crate) fn write_owned_at(
    dir: &File,
    name: &str,
    content: &str,
    uid: u32,
    gid: u32,
) -> io::Result<()> {
    unlink_at(dir, name)?;
    let mut file = create_exclusive_at(dir, name, 0o600)?;
    file.write_all(content.as_bytes())?;
    fchown(&file, Some(uid), Some(gid))?;
    file.sync_all()
}

/// Stats `name` inside `dir` without following symlinks and verifies it is a regular file on the
/// same filesystem (`st_dev`) as `dir`.
pub(crate) fn stat_regular_same_dev(dir: &File, name: &str) -> io::Result<libc::stat> {
    let component = c_name(name)?;
    let parent_dev = dir.metadata()?.dev();
    let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            component.as_ptr(),
            info.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if (info.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "entry is not a regular file",
        ));
    }
    #[allow(clippy::unnecessary_cast)]
    let dev = info.st_dev as u64;
    if dev != parent_dev {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "file crossed filesystem boundary",
        ));
    }
    Ok(info)
}

/// Reads entry names from an already-anchored directory descriptor.
pub(crate) fn read_dir_names(dir: &File) -> io::Result<Vec<String>> {
    let fd = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(fd);
        }
        return Err(error);
    }
    struct Guard(*mut libc::DIR);
    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let guard = Guard(raw);
    unsafe {
        libc::rewinddir(guard.0);
    }
    let mut names = Vec::new();
    loop {
        unsafe {
            *errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(guard.0) };
        if entry.is_null() {
            let err = unsafe { *errno_location() };
            if err != 0 {
                return Err(io::Error::from_raw_os_error(err));
            }
            break;
        }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if matches!(bytes, b"." | b"..") {
            continue;
        }
        if let Ok(name) = OsString::from_vec(bytes.to_vec()).into_string() {
            names.push(name);
            if names.len() > MAX_DIR_ENTRIES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "directory entry bound exceeded",
                ));
            }
        }
    }
    Ok(names)
}
