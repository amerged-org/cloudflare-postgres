// SPDX-License-Identifier: Apache-2.0
//! Fixed, unassigned, single-threaded child probe in the workload's actual OCI security context.
use crate::{Error, now};
use serde_json::{Value, json};
use std::{
    fs,
    process::{Command, Stdio},
};

fn errno(result: libc::c_long) -> Value {
    if result >= 0 {
        Value::Null
    } else {
        json!(
            std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(4095)
        )
    }
}
fn cloned(flags: u64) -> Value {
    let result =
        unsafe { libc::syscall(libc::SYS_clone, flags | libc::SIGCHLD as u64, 0, 0, 0, 0) };
    if result == 0 {
        unsafe { libc::_exit(0) }
    }
    if result > 0 {
        unsafe {
            libc::waitpid(result as i32, std::ptr::null_mut(), 0);
        }
    }
    errno(result)
}
#[repr(C)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

pub fn probe() -> Result<Value, Error> {
    let uid = unsafe { libc::geteuid() };
    if uid != 26 {
        return Err(Error("pool_probe_uid_required"));
    }
    let status = fs::read_to_string("/proc/self/status")
        .map_err(|_| Error("pool_probe_context_unavailable"))?;
    let field = |name: &str| {
        status.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(key, _)| *key == name)
                .map(|(_, value)| value.trim().to_owned())
        })
    };
    let cap = field("CapEff").ok_or(Error("pool_probe_context_unavailable"))?;
    let capabilities =
        u64::from_str_radix(&cap, 16).map_err(|_| Error("pool_probe_context_unavailable"))?;
    let seccomp = field("Seccomp")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Error("pool_probe_context_unavailable"))?;
    let nnp = field("NoNewPrivs").ok_or(Error("pool_probe_context_unavailable"))? == "1";
    let mut results = serde_json::Map::new();
    for (name, flag) in [
        ("mount", libc::CLONE_NEWNS),
        ("user", libc::CLONE_NEWUSER),
        ("pid", libc::CLONE_NEWPID),
        ("ipc", libc::CLONE_NEWIPC),
        ("net", libc::CLONE_NEWNET),
        ("uts", libc::CLONE_NEWUTS),
        ("cgroup", libc::CLONE_NEWCGROUP),
    ] {
        results.insert(
            format!("unshare_{name}"),
            errno(unsafe { libc::syscall(libc::SYS_unshare, flag) }),
        );
        results.insert(format!("clone_{name}"), cloned(flag as u64));
    }
    results.insert(
        "unshare_time".into(),
        errno(unsafe { libc::syscall(libc::SYS_unshare, libc::CLONE_NEWTIME) }),
    );
    let own = unsafe {
        libc::open(
            c"/proc/self/ns/mnt".as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC,
        )
    };
    if own < 0 {
        return Err(Error("pool_probe_context_unavailable"));
    }
    let setns = errno(unsafe { libc::syscall(libc::SYS_setns, own, libc::CLONE_NEWNS) });
    unsafe {
        libc::close(own);
    }
    results.insert("setns_own_mount".into(), setns);
    let args = CloneArgs {
        flags: libc::CLONE_NEWUSER as u64,
        pidfd: 0,
        child_tid: 0,
        parent_tid: 0,
        exit_signal: libc::SIGCHLD as u64,
        stack: 0,
        stack_size: 0,
        tls: 0,
        set_tid: 0,
        set_tid_size: 0,
        cgroup: 0,
    };
    let clone3 =
        unsafe { libc::syscall(libc::SYS_clone3, &args, std::mem::size_of::<CloneArgs>()) };
    if clone3 == 0 {
        unsafe { libc::_exit(0) }
    }
    if clone3 > 0 {
        unsafe {
            libc::waitpid(clone3 as i32, std::ptr::null_mut(), 0);
        }
    }
    results.insert("clone3".into(), errno(clone3));
    // Missing target cannot attach a mount, even if a security profile unexpectedly permits it.
    results.insert(
        "mount_missing_target".into(),
        errno(unsafe {
            libc::syscall(
                libc::SYS_mount,
                c"/".as_ptr(),
                c"/pgcf/__missing_isolation_probe_target__".as_ptr(),
                std::ptr::null::<libc::c_char>(),
                libc::MS_BIND,
                std::ptr::null::<libc::c_char>(),
            )
        }),
    );
    for (name, result) in [
        ("fsopen_ext4", unsafe {
            libc::syscall(libc::SYS_fsopen, c"ext4".as_ptr(), 1)
        }),
        ("open_tree_clone_root", unsafe {
            libc::syscall(
                libc::SYS_open_tree,
                libc::AT_FDCWD,
                c"/".as_ptr(),
                1 | libc::O_CLOEXEC,
            )
        }),
    ] {
        let denial = errno(result);
        if result >= 0 {
            unsafe {
                libc::close(result as i32);
            }
        }
        results.insert(name.into(), denial);
    }
    Ok(
        json!({"v":1,"uid":uid,"cap_eff":format!("{capabilities:016x}"),"cap_sys_admin":capabilities&(1<<21)!=0,"seccomp_mode":seccomp,"no_new_privs":nnp,"observed_at":now(),"results":results}),
    )
}
pub fn sealed(probe: &Value) -> bool {
    pgcf_native_protocol::pool::workload_probe_safe(probe)
}
pub fn child() -> Result<Value, Error> {
    let output =
        Command::new(std::env::current_exe().map_err(|_| Error("pool_executable_unavailable"))?)
            .arg("isolation-probe")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| Error("pool_probe_unavailable"))?;
    if !output.status.success() || output.stdout.len() > 16384 {
        return Err(Error("pool_probe_unavailable"));
    }
    let probe: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| Error("pool_probe_invalid"))?;
    if !sealed(&probe) {
        return Err(Error("pool_workload_isolation_refused"));
    }
    Ok(probe)
}
