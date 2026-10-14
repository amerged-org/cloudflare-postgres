// SPDX-License-Identifier: Apache-2.0
//! Pinned Linux6.18.54 named-tree inventory. Anonymous fscontexts/detached mounts are NOT enumerable.
//! Run only in the retained initial-PID parent with its original root; never rejoin an ancestor PID NS.
use std::{
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
};

fn refused() -> io::Error {
    io::Error::other("pool_named_namespace_inventory_unconfirmed")
}
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct NamespaceInfo {
    size: u32,
    mounts: u32,
    id: u64,
}
fn info(fd: i32) -> io::Result<NamespaceInfo> {
    let mut value = NamespaceInfo {
        size: 16,
        mounts: 0,
        id: 0,
    };
    if unsafe { libc::ioctl(fd, 0x8010_b70au32 as _, &mut value) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if value.size != 16 || value.id == 0 || value.mounts > 65536 {
        return Err(refused());
    }
    Ok(value)
}
fn step(file: &File, next: bool) -> io::Result<Option<File>> {
    let mut value = NamespaceInfo {
        size: 16,
        mounts: 0,
        id: 0,
    };
    let fd = unsafe {
        libc::ioctl(
            file.as_raw_fd(),
            if next { 0x8010_b70bu32 } else { 0x8010_b70cu32 } as _,
            &mut value,
        )
    };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    let file = unsafe { File::from_raw_fd(fd) };
    if value != info(file.as_raw_fd())? {
        return Err(refused());
    }
    Ok(Some(file))
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextProof {
    pub kernel_version: String,
    pub caller_pid_namespace_inode: u64,
    pub initial_pid_namespace_inode: u64,
    pub caller_user_namespace_inode: u64,
    pub initial_user_namespace_inode: u64,
    pub next_namespace_errno: u32,
}
pub fn context() -> io::Result<ContextProof> {
    let kernel_version = fs::read_to_string("/proc/sys/kernel/osrelease")?
        .trim()
        .to_owned();
    let caller_pid_namespace_inode = File::open("/proc/self/ns/pid")?.metadata()?.ino();
    let initial_pid_namespace_inode = File::open("/proc/1/ns/pid")?.metadata()?.ino();
    let caller_user_namespace_inode = File::open("/proc/self/ns/user")?.metadata()?.ino();
    let initial_user_namespace_inode = File::open("/proc/1/ns/user")?.metadata()?.ino();
    if kernel_version != "6.18.54"
        || caller_pid_namespace_inode != 0xefff_fffcu64
        || initial_pid_namespace_inode != caller_pid_namespace_inode
        || caller_user_namespace_inode != 0xefff_fffdu64
        || initial_user_namespace_inode != caller_user_namespace_inode
    {
        return Err(refused());
    }
    let current = File::open("/proc/self/ns/mnt")?;
    // NEXT checks may_see_all_namespaces before tree lookup. Success OR exact ENOENT proves eligibility.
    let next_namespace_errno = if step(&current, true)?.is_some() {
        0
    } else {
        libc::ENOENT as u32
    };
    Ok(ContextProof {
        kernel_version,
        caller_pid_namespace_inode,
        initial_pid_namespace_inode,
        caller_user_namespace_inode,
        initial_user_namespace_inode,
        next_namespace_errno,
    })
}
pub fn eligible() -> io::Result<()> {
    context().map(|_| ())
}
fn namespaces() -> io::Result<Vec<(File, NamespaceInfo)>> {
    eligible()?;
    let mut file = File::open("/proc/self/ns/mnt")?;
    let mut previous = info(file.as_raw_fd())?.id;
    let mut walked = 0;
    while let Some(before) = step(&file, false)? {
        walked += 1;
        if walked > 32768 {
            return Err(refused());
        }
        let id = info(before.as_raw_fd())?.id;
        if id >= previous {
            return Err(refused());
        }
        previous = id;
        file = before;
    }
    let mut all = Vec::new();
    loop {
        let observed = info(file.as_raw_fd())?;
        let next = step(&file, true)?;
        all.push((file, observed));
        if all.len() > 32768 {
            return Err(refused());
        }
        let Some(next) = next else { break };
        if info(next.as_raw_fd())?.id <= observed.id {
            return Err(refused());
        }
        file = next;
    }
    Ok(all)
}
#[repr(C)]
struct Request {
    size: u32,
    namespace_fd: u32,
    mount_id: u64,
    param: u64,
    namespace_id: u64,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Alias {
    pub namespace_id: u64,
    pub mount_id: u64,
    pub parent_mount_id: u64,
    pub attributes: u64,
    pub propagation: u64,
    pub peer_group: u64,
    pub master: u64,
    pub root: String,
    pub point: String,
}
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Survey {
    pub complete_namespace_scan: bool,
    pub named_namespace_scan_complete: bool,
    pub namespaces: u32,
    pub mounts: u32,
    pub aliases: Vec<Alias>,
}
fn ids(file: &File) -> io::Result<Vec<u64>> {
    let mut all = Vec::new();
    let mut last = 0u64;
    loop {
        let req = Request {
            size: 32,
            namespace_fd: file.as_raw_fd().try_into().map_err(|_| refused())?,
            mount_id: u64::MAX,
            param: last,
            namespace_id: 0,
        };
        let mut output = [0u64; 1024];
        let count = unsafe {
            libc::syscall(
                458 as libc::c_long,
                &req,
                output.as_mut_ptr(),
                output.len(),
                0,
            )
        };
        if count < 0 {
            return Err(io::Error::last_os_error());
        }
        let count = count as usize;
        if count > output.len() {
            return Err(refused());
        }
        if count == 0 {
            break;
        }
        for id in &output[..count] {
            if *id <= last {
                return Err(refused());
            }
            last = *id;
            all.push(*id)
        }
        if all.len() > 65536 {
            return Err(refused());
        }
    }
    Ok(all)
}
fn u32_at(b: &[u8], o: usize) -> io::Result<u32> {
    Ok(u32::from_ne_bytes(
        b.get(o..o + 4)
            .ok_or_else(refused)?
            .try_into()
            .map_err(|_| refused())?,
    ))
}
fn u64_at(b: &[u8], o: usize) -> io::Result<u64> {
    Ok(u64::from_ne_bytes(
        b.get(o..o + 8)
            .ok_or_else(refused)?
            .try_into()
            .map_err(|_| refused())?,
    ))
}
fn string(b: &[u8], o: usize) -> io::Result<String> {
    let start = 512usize
        .checked_add(u32_at(b, o)? as usize)
        .ok_or_else(refused)?;
    let s = b.get(start..).ok_or_else(refused)?;
    let end = s.iter().position(|b| *b == 0).ok_or_else(refused)?;
    if end > 4096 {
        return Err(refused());
    }
    Ok(std::str::from_utf8(&s[..end])
        .map_err(|_| refused())?
        .to_owned())
}
pub fn for_device(device: u64) -> io::Result<Survey> {
    for_filesystem(device, "ext4")
}
pub fn for_tmpfs(device: u64) -> io::Result<Survey> {
    for_filesystem(device, "tmpfs")
}
pub fn namespace_id(file: &File) -> io::Result<u64> {
    info(file.as_raw_fd()).map(|n| n.id)
}
fn for_filesystem(device: u64, filesystem: &str) -> io::Result<Survey> {
    let all = namespaces()?;
    let mut aliases = Vec::new();
    let mut total = 0u32;
    for (file, before) in &all {
        if before.mounts == 0 {
            if info(file.as_raw_fd())? != *before {
                return Err(refused());
            }
            continue;
        }
        let listed = ids(file)?;
        if listed.len() != before.mounts as usize {
            return Err(refused());
        }
        for id in &listed {
            #[repr(C, align(8))]
            struct Buffer([u8; 16384]);
            let mut b = Buffer([0; 16384]);
            const MASK: u64 = 1 | 2 | 4 | 8 | 16 | 32 | 64;
            let req = Request {
                size: 32,
                namespace_fd: file.as_raw_fd().try_into().map_err(|_| refused())?,
                mount_id: *id,
                param: MASK,
                namespace_id: 0,
            };
            if unsafe { libc::syscall(457 as libc::c_long, &req, b.0.as_mut_ptr(), b.0.len(), 0) }
                != 0
            {
                return Err(io::Error::last_os_error());
            }
            let size = u32_at(&b.0, 0)? as usize;
            if !(512..=b.0.len()).contains(&size) {
                return Err(refused());
            }
            let b = &b.0[..size];
            if u64_at(b, 8)? & MASK != MASK || u64_at(b, 40)? != *id || u64_at(b, 112)? != before.id
            {
                return Err(refused());
            }
            total = total
                .checked_add(1)
                .filter(|n| *n <= 1_000_000)
                .ok_or_else(refused)?;
            if libc::makedev(u32_at(b, 16)?, u32_at(b, 20)?) == device {
                if string(b, 36)? != filesystem || aliases.len() >= 128 {
                    return Err(refused());
                }
                aliases.push(Alias {
                    namespace_id: before.id,
                    mount_id: *id,
                    parent_mount_id: u64_at(b, 48)?,
                    attributes: u64_at(b, 64)?,
                    propagation: u64_at(b, 72)?,
                    peer_group: u64_at(b, 80)?,
                    master: u64_at(b, 88)?,
                    root: string(b, 104)?,
                    point: string(b, 108)?,
                });
            }
        }
        if info(file.as_raw_fd())? != *before || ids(file)? != listed {
            return Err(refused());
        }
    }
    let after = namespaces()?;
    if all.iter().map(|(_, i)| *i).collect::<Vec<_>>()
        != after.iter().map(|(_, i)| *i).collect::<Vec<_>>()
    {
        return Err(refused());
    }
    Ok(Survey {
        complete_namespace_scan: false,
        named_namespace_scan_complete: true,
        namespaces: all.len().try_into().map_err(|_| refused())?,
        mounts: total,
        aliases,
    })
}

/// Fixed platform actors discovered only by the eligible initial-PID parent. No caller PID selector.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlatformContext {
    pub initial_mount_namespace_id: u64,
    pub kubelet_pid: u32,
    pub kubelet_start_ticks: u64,
    pub kubelet_mount_namespace_inode: u64,
    pub kubelet_mount_namespace_id: u64,
}
pub fn platform_context() -> io::Result<PlatformContext> {
    eligible()?;
    let initial_mount_namespace_id = namespace_id(&File::open("/proc/1/ns/mnt")?)?;
    let mut found = None;
    let mut count = 0;
    for entry in fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        count += 1;
        if count > 65536 {
            return Err(refused());
        }
        if fs::read_to_string(entry.path().join("comm"))
            .ok()
            .as_deref()
            != Some("kubelet\n")
        {
            continue;
        }
        let exe = entry.path().join("exe");
        let Ok(path) = fs::read_link(&exe) else {
            continue;
        };
        if path.file_name().and_then(|v| v.to_str()) != Some("kubelet") {
            continue;
        }
        if File::open(&exe)?.metadata()?.uid() != 0 {
            return Err(refused());
        }
        let status = fs::read_to_string(entry.path().join("status"))?;
        if status
            .lines()
            .find_map(|l| l.strip_prefix("Uid:"))
            .is_none_or(|l| l.split_whitespace().collect::<Vec<_>>() != ["0", "0", "0", "0"])
        {
            return Err(refused());
        }
        let stat = fs::read_to_string(entry.path().join("stat"))?;
        let start = stat
            .rsplit_once(") ")
            .and_then(|(_, s)| s.split_whitespace().nth(19))
            .and_then(|s| s.parse::<u64>().ok())
            .ok_or_else(refused)?;
        let ns = File::open(entry.path().join("ns/mnt"))?;
        let ns_inode = ns.metadata()?.ino();
        let ns_id = namespace_id(&ns)?;
        let after = fs::read_to_string(entry.path().join("stat"))?;
        if after
            .rsplit_once(") ")
            .and_then(|(_, s)| s.split_whitespace().nth(19))
            .and_then(|s| s.parse::<u64>().ok())
            != Some(start)
            || found.is_some()
        {
            return Err(refused());
        }
        found = Some(PlatformContext {
            initial_mount_namespace_id,
            kubelet_pid: pid,
            kubelet_start_ticks: start,
            kubelet_mount_namespace_inode: ns_inode,
            kubelet_mount_namespace_id: ns_id,
        });
    }
    found.ok_or_else(refused)
}
