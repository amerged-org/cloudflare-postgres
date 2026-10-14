// SPDX-License-Identifier: Apache-2.0
//! Test-only same-UID child; report access results without reading or printing private payloads.
use serde_json::json;
use std::{fs, os::unix::fs::MetadataExt};
fn attempted(call: impl FnOnce() -> libc::c_long) -> serde_json::Value {
    let result = call();
    json!({"succeeded": result >= 0, "errno": if result < 0 { std::io::Error::last_os_error().raw_os_error() } else { None }})
}
fn main() {
    assert_eq!(unsafe { libc::geteuid() }, 26);
    let access = |path: &str| match fs::File::open(path) {
        Ok(_) => json!({"opened":true,"errno":null}),
        Err(error) => json!({"opened":false,"errno":error.raw_os_error()}),
    };
    let status = fs::read_to_string("/proc/1/status").expect("target status unavailable");
    let target_uid = status
        .lines()
        .find(|l| l.starts_with("Uid:"))
        .expect("target uid absent")
        .split_whitespace()
        .skip(1)
        .all(|v| v == "26");
    let mut byte = 0u8;
    let local = libc::iovec {
        iov_base: std::ptr::addr_of_mut!(byte).cast(),
        iov_len: 1,
    };
    // Null remote address cannot expose or alter data even if access is unexpectedly permitted.
    let remote = libc::iovec {
        iov_base: std::ptr::null_mut(),
        iov_len: 1,
    };
    let vm_read = attempted(|| unsafe {
        libc::process_vm_readv(1, &local, 1, &remote, 1, 0) as libc::c_long
    });
    let vm_write = attempted(|| unsafe {
        libc::process_vm_writev(1, &local, 1, &remote, 1, 0) as libc::c_long
    });
    let attach = attempted(|| unsafe {
        libc::ptrace(
            libc::PTRACE_ATTACH,
            1,
            std::ptr::null_mut::<libc::c_void>(),
            std::ptr::null_mut::<libc::c_void>(),
        )
    });
    if attach["succeeded"] == true {
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(1, &mut status, 0) }, 1);
        assert_eq!(
            unsafe {
                libc::ptrace(
                    libc::PTRACE_DETACH,
                    1,
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>(),
                )
            },
            0
        );
    }
    println!(
        "{}",
        json!({"target_uid_26":target_uid,"target_environ_owner_uid":fs::metadata("/proc/1/environ").expect("target proc unavailable").uid(),"self_environ":access("/proc/self/environ"),"target_environ":access("/proc/1/environ"),"target_maps":access("/proc/1/maps"),"target_mem":access("/proc/1/mem"),"process_vm_read":vm_read,"process_vm_write":vm_write,"ptrace_attach":attach})
    );
}
