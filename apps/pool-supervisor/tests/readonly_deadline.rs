// SPDX-License-Identifier: Apache-2.0
//! Explicit owned suspended-DM fixture; the executable is the unmodified pinned PG18 tool.
use pgcf_pool_supervisor::{Error, data::ReadonlyReader, now};
use std::{
    ffi::CString,
    fs,
    os::fd::{FromRawFd, OwnedFd},
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};

fn wait(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !path.exists() {
        assert!(Instant::now() < deadline, "owned fixture handshake elapsed");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn suspended_device_read_is_bounded_and_retains_unreaped_child_fence() {
    let root =
        std::env::var("PGCF_TEST_BLOCKED_ROOT").expect("owned suspended DM fixture required");
    let root = Path::new(&root);
    wait(&root.join("mounted"));
    let data = root.join("readonly/pgdata");
    let path = CString::new(data.as_os_str().as_encoded_bytes()).unwrap();
    let fd = unsafe {
        libc::openat(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    let directory = unsafe { OwnedFd::from_raw_fd(fd) };
    assert!(fs::symlink_metadata(data.join("global")).unwrap().is_dir());
    assert!(
        fs::symlink_metadata(data.join("global/pg_control"))
            .unwrap()
            .is_file()
    );
    fs::write(root.join("ready"), []).unwrap();
    wait(&root.join("suspended"));
    let root_owned = root.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut reader = ReadonlyReader::default();
        let result = reader.read(directory, now() + 1000);
        let pending = reader.pending();
        let refused = if pending {
            let path = CString::new(
                root_owned
                    .join("readonly/pgdata")
                    .as_os_str()
                    .as_encoded_bytes(),
            )
            .unwrap();
            let fd = unsafe {
                libc::openat(
                    libc::AT_FDCWD,
                    path.as_ptr(),
                    libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
                )
            };
            assert!(fd >= 0);
            let retry = reader.read(unsafe { OwnedFd::from_raw_fd(fd) }, now() + 1000);
            assert!(matches!(retry, Err(Error("pool_control_cleanup_pending"))));
            true
        } else {
            false
        };
        assert!(
            reader.started(),
            "stock tool must actually spawn before its measured timeout"
        );
        println!(
            "fixed_reader_started=true deadline_failed=true pending_before_resume={pending} pending_second_read_refused={refused}"
        );
        sender.send((result.map(|_| ()), pending)).unwrap();
        wait(&root_owned.join("resume"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while reader.reap().is_err() {
            assert!(
                Instant::now() < deadline,
                "actual child did not reap after owned resume"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        sender.send((Ok(()), reader.pending())).unwrap();
    });
    let bounded = receiver.recv_timeout(Duration::from_secs(2));
    // Always let the exclusively owned fixture resume for normal cleanup, including RED.
    fs::write(root.join("resume"), []).unwrap();
    let closed = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    worker.join().unwrap();
    fs::write(root.join("reaped"), []).unwrap();
    let (outcome, pending) = bounded.expect("fixed stock tool exceeded the signed read deadline");
    assert_eq!(
        outcome,
        Err(if pending {
            Error("pool_control_cleanup_pending")
        } else {
            Error("pool_control_deadline_elapsed")
        })
    );
    assert_eq!(closed, (Ok(()), false));
    println!("actual_child_reaped_before_ack=true");
}
