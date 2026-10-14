// SPDX-License-Identifier: Apache-2.0
//! Read-only pre-start and post-stop checks against unmodified PostgreSQL's own control tool.
use crate::Error;
use std::{
    fs,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::OpenOptionsExt, process::CommandExt},
    },
    path::Path,
    process::{Command, Output},
};

#[derive(Clone)]
pub struct Control {
    pub system_identifier: String,
    pub timeline: u64,
    pub control_state: String,
}

pub fn control(path: &Path) -> Result<Control, Error> {
    let output = Command::new("/usr/lib/postgresql/18/bin/pg_controldata")
        .arg(path)
        .env("LC_ALL", "C")
        .output()
        .map_err(|_| Error("pool_control_unavailable"))?;
    parse_control(output)
}

/// Consume an agent-owned read-only directory descriptor; no caller path reaches the tool.
/// The directory is deliberately inherited by only the fixed stock child, never through stdin.
pub fn readonly_control(directory: OwnedFd) -> Result<Control, Error> {
    let descriptor = directory.as_raw_fd();
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    let mut filesystem: libc::statvfs = unsafe { std::mem::zeroed() };
    let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
    if unsafe { libc::fstat(descriptor, &mut metadata) } != 0
        || metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
        || unsafe { libc::fstatvfs(descriptor, &mut filesystem) } != 0
        || filesystem.f_flag & libc::ST_RDONLY == 0
        || flags < 0
        || flags & libc::O_PATH == 0
    {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let global = unsafe {
        libc::openat(
            descriptor,
            c"global".as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if global < 0 {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let global = unsafe { OwnedFd::from_raw_fd(global) };
    let control = unsafe {
        libc::openat(
            global.as_raw_fd(),
            c"pg_control".as_ptr(),
            libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if control < 0 {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let control = unsafe { OwnedFd::from_raw_fd(control) };
    let mut global_metadata: libc::stat = unsafe { std::mem::zeroed() };
    let mut control_metadata: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(global.as_raw_fd(), &mut global_metadata) } != 0
        || unsafe { libc::fstat(control.as_raw_fd(), &mut control_metadata) } != 0
        || control_metadata.st_mode & libc::S_IFMT != libc::S_IFREG
        || global_metadata.st_dev != metadata.st_dev
        || control_metadata.st_dev != metadata.st_dev
    {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let inherited = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
    if inherited < 0 {
        return Err(Error("pool_readonly_descriptor_refused"));
    }
    let inherited = unsafe { OwnedFd::from_raw_fd(inherited) };
    let child_fd = inherited.as_raw_fd();
    let mut command = Command::new("/usr/lib/postgresql/18/bin/pg_controldata");
    command
        .arg(format!("/proc/self/fd/{child_fd}"))
        .env("LC_ALL", "C");
    unsafe {
        command.pre_exec(move || {
            if libc::fcntl(child_fd, libc::F_SETFD, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command
        .output()
        .map_err(|_| Error("pool_control_unavailable"))?;
    // Stock pg_controldata can exit zero with a CRC/version warning; that is not valid evidence.
    if !output.stderr.is_empty() {
        return Err(Error("pool_control_invalid"));
    }
    parse_control(output)
}

fn parse_control(output: Output) -> Result<Control, Error> {
    if !output.status.success() || output.stdout.len() > 65536 {
        return Err(Error("pool_control_unavailable"));
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| Error("pool_control_invalid"))?;
    let field = |key| {
        text.lines().find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| *name == key)
                .map(|(_, value)| value.trim().to_owned())
        })
    };
    let system_identifier =
        field("Database system identifier").ok_or(Error("pool_control_invalid"))?;
    if system_identifier
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0)
        .is_none()
    {
        return Err(Error("pool_control_invalid"));
    }
    let timeline = field("Latest checkpoint's TimeLineID")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0 && *value <= u32::MAX as u64)
        .ok_or(Error("pool_control_invalid"))?;
    let control_state = field("Database cluster state").ok_or(Error("pool_control_invalid"))?;
    Ok(Control {
        system_identifier,
        timeline,
        control_state,
    })
}

pub fn inspect_clean(
    path: &Path,
    expected_system: &str,
    expected_timeline: u64,
) -> Result<Control, Error> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Error("pool_data_unavailable"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error("pool_data_identity_changed"));
    }
    let mut version = String::new();
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path.join("PG_VERSION"))
        .map_err(|_| Error("pool_data_version_changed"))?
        .take(32)
        .read_to_string(&mut version)
        .map_err(|_| Error("pool_data_version_changed"))?;
    if version.trim() != "18" {
        return Err(Error("pool_data_version_changed"));
    }
    for marker in [
        "postmaster.pid",
        "standby.signal",
        "recovery.signal",
        ".check-empty-wal-archive",
    ] {
        match fs::symlink_metadata(path.join(marker)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err(Error("pool_data_recovery_or_holder")),
        }
    }
    let record = control(path)?;
    if record.control_state != "shut down" {
        return Err(Error("pool_data_recovery_or_holder"));
    }
    if record.system_identifier != expected_system || record.timeline != expected_timeline {
        return Err(Error("pool_data_identity_changed"));
    }
    Ok(record)
}

pub fn ready(path: &Path, pid: u32) -> bool {
    fs::read_to_string(path.join("postmaster.pid")).is_ok_and(|text| {
        let lines: Vec<_> = text.lines().collect();
        lines.first().and_then(|line| line.parse::<u32>().ok()) == Some(pid)
            && lines.get(7).is_some_and(|line| line.trim() == "ready")
    })
}
