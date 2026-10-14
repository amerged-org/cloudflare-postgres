// SPDX-License-Identifier: Apache-2.0
//! Runs in the stock PostgreSQL image with real clean/dirty PGDATA mounted read-only.
use pgcf_pool_supervisor::{Error, data::ReadonlyReader, now};
use std::{
    ffi::CString,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    },
    path::Path,
};

fn directory(path: &Path) -> OwnedFd {
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    let fd = unsafe {
        libc::openat(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    unsafe { OwnedFd::from_raw_fd(fd) }
}

#[test]
fn fixed_control_reader_measures_clean_and_dirty_data_and_refuses_writable_descriptors() {
    let mut reader = ReadonlyReader::default();
    let root = std::env::var("PGCF_TEST_READONLY_ROOT")
        .expect("actual read-only PostgreSQL data fixture required");
    let root = Path::new(&root);
    let descriptor = directory(&root.join("clean"));
    let received_fd = descriptor.as_raw_fd();
    let mut mounted: libc::statvfs = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::fstatvfs(received_fd, &mut mounted) }, 0);
    assert_ne!(
        mounted.f_flag & libc::ST_RDONLY,
        0,
        "fixture must be kernel read-only"
    );
    let clean = reader.read(descriptor, now() + 5000).unwrap();
    assert_eq!(unsafe { libc::fcntl(received_fd, libc::F_GETFD) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EBADF)
    );
    assert_eq!(clean.control_state, "shut down");
    assert!(clean.system_identifier.parse::<u64>().unwrap() > 0);
    assert!(clean.timeline > 0);
    let dirty = reader
        .read(directory(&root.join("dirty")), now() + 5000)
        .unwrap();
    assert_eq!(dirty.control_state, "in production");
    assert_ne!(dirty.system_identifier, clean.system_identifier);
    assert!(matches!(
        reader.read(directory(Path::new("/tmp")), now() + 5000),
        Err(Error("pool_readonly_descriptor_refused"))
    ));
    let path = CString::new(root.join("clean/PG_VERSION").as_os_str().as_bytes()).unwrap();
    let fd = unsafe {
        libc::openat(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    let file = unsafe { OwnedFd::from_raw_fd(fd) };
    assert!(matches!(
        reader.read(file, now() + 5000),
        Err(Error("pool_readonly_descriptor_refused"))
    ));
    assert!(matches!(
        reader.read(directory(&root.join("escape")), now() + 5000),
        Err(Error("pool_readonly_descriptor_refused"))
    ));
    assert!(matches!(
        reader.read(directory(&root.join("corrupt")), now() + 5000),
        Err(Error("pool_control_invalid"))
    ));
}
