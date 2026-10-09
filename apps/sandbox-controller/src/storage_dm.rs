// SPDX-License-Identifier: Apache-2.0
//! Fixed Linux6.18.51/6.18.54 device-mapper ABI (their UAPI headers are byte-identical) for an already verified CF thin-volume identity.
//! No table load, create, remove, name-based operation or caller-supplied ioctl is exposed.
use pgcf_native_protocol::storage::VerifiedStorageAuthority;
use std::{
    fs::{self, OpenOptions},
    os::fd::AsRawFd,
    path::PathBuf,
};
use tonic::Status;
const SUSPENDED: u32 = 1 << 1;
const SKIP_LOCKFS: u32 = 1 << 10;
const NOFLUSH: u32 = 1 << 11;
#[repr(C)]
struct Header {
    version: [u32; 3],
    data_size: u32,
    data_start: u32,
    target_count: u32,
    open_count: i32,
    flags: u32,
    event_nr: u32,
    padding: u32,
    dev: u64,
    name: [u8; 128],
    uuid: [u8; 129],
    data: [u8; 7],
}
fn failed() -> Status {
    Status::failed_precondition("storage_dm_identity_or_quiescence_unconfirmed")
}
fn header(uuid: &str, flags: u32, size: usize) -> Result<Header, Status> {
    if uuid.len() > 128 || !uuid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(failed());
    }
    let mut out = Header {
        version: [4, 50, 0],
        data_size: u32::try_from(size).map_err(|_| failed())?,
        data_start: std::mem::size_of::<Header>() as u32,
        target_count: 0,
        open_count: 0,
        flags,
        event_nr: 0,
        padding: 0,
        dev: 0,
        name: [0; 128],
        uuid: [0; 129],
        data: [0; 7],
    };
    out.uuid[..uuid.len()].copy_from_slice(uuid.as_bytes());
    Ok(out)
}
fn code(command: u32) -> libc::c_ulong {
    ((3u32 << 30) | ((std::mem::size_of::<Header>() as u32) << 16) | (0xfdu32 << 8) | command)
        .into()
}
fn uuid(raw: &[u8]) -> Result<&str, Status> {
    let end = raw.iter().position(|b| *b == 0).ok_or_else(failed)?;
    std::str::from_utf8(&raw[..end]).map_err(|_| failed())
}
fn ioctl(command: u32, value: &mut Header) -> Result<(), Status> {
    use std::os::unix::fs::{FileTypeExt, OpenOptionsExt};
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/dev/mapper/control")
        .map_err(|_| failed())?;
    if !file
        .metadata()
        .map_err(|_| failed())?
        .file_type()
        .is_char_device()
    {
        return Err(failed());
    }
    // SAFETY: Header is the exact pinned UAPI layout; buffer length is checked by each caller.
    if unsafe { libc::ioctl(file.as_raw_fd(), code(command) as _, value as *mut Header) } < 0 {
        return Err(failed());
    }
    Ok(())
}
fn status(expected: &str) -> Result<Header, Status> {
    let mut value = header(expected, 0, std::mem::size_of::<Header>())?;
    ioctl(7, &mut value)?;
    if uuid(&value.uuid)? != expected || value.version[0] != 4 {
        return Err(failed());
    }
    Ok(value)
}
fn table(expected: &str) -> Result<(String, String), Status> {
    #[repr(C, align(8))]
    struct Buffer([u8; 4096]);
    let mut buffer = Buffer([0; 4096]);
    let start = header(expected, 1 << 4, buffer.0.len())?;
    // SAFETY: Buffer is aligned for Header, contains4096 live bytes, and has no competing references.
    let pointer = buffer.0.as_mut_ptr().cast::<Header>();
    unsafe {
        pointer.write(start);
    }
    let value = unsafe { &mut *pointer };
    ioctl(12, value)?;
    if uuid(&value.uuid)? != expected || value.target_count != 1 || value.flags & (1 << 8) != 0 {
        return Err(failed());
    }
    let offset = value.data_start as usize;
    if offset < 312 || offset + 40 >= buffer.0.len() {
        return Err(failed());
    }
    let kind = uuid(&buffer.0[offset + 24..offset + 40])?.to_owned();
    let params = uuid(&buffer.0[offset + 40..])?.to_owned();
    Ok((kind, params))
}
fn kernel_path(expected: &str) -> Result<Option<PathBuf>, Status> {
    let mut found = None;
    let mut count = 0;
    for entry in fs::read_dir("/sys/class/block").map_err(|_| failed())? {
        count += 1;
        if count > 8192 {
            return Err(failed());
        }
        let entry = entry.map_err(|_| failed())?;
        let name = entry.file_name();
        if !name
            .to_str()
            .is_some_and(|n| n.starts_with("dm-") && n[3..].bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        let actual = fs::read_to_string(entry.path().join("dm/uuid")).map_err(|_| failed())?;
        if actual.trim() == expected {
            if found.is_some() {
                return Err(failed());
            }
            found = Some(entry.path());
        }
    }
    if count == 0 {
        return Err(failed());
    }
    Ok(found)
}
/// Only a complete kernel UUID inventory can confirm a signed mapper is absent.
/// This does not claim that an inactive LVM volume or its disk capacity has been deleted.
pub fn absent(authority: &VerifiedStorageAuthority) -> Result<bool, Status> {
    let c = authority.claims();
    let expected = format!(
        "LVM-{}{}",
        c.volume_group_uuid.replace('-', ""),
        c.lv_uuid.replace('-', "")
    );
    Ok(kernel_path(&expected)?.is_none())
}
fn identities(authority: &VerifiedStorageAuthority) -> Result<String, Status> {
    let c = authority.claims();
    let expected = format!(
        "LVM-{}{}",
        c.volume_group_uuid.replace('-', ""),
        c.lv_uuid.replace('-', "")
    );
    if kernel_path(&expected)?.is_none() {
        return Err(failed());
    }
    let (kind, params) = table(&expected)?;
    if kind != "thin" {
        return Err(failed());
    }
    let pool_device = params.split_whitespace().next().ok_or_else(failed)?;
    let parts = pool_device.split(':').collect::<Vec<_>>();
    if parts.len() != 2
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(failed());
    }
    let actual = fs::read_to_string(format!("/sys/dev/block/{pool_device}/dm/uuid"))
        .map_err(|_| failed())?;
    let pool = format!(
        "LVM-{}{}",
        c.volume_group_uuid.replace('-', ""),
        c.pool_uuid.replace('-', "")
    );
    if actual.trim() != pool && actual.trim() != format!("{pool}-tpool") {
        return Err(failed());
    }
    if table(actual.trim())?.0 != "thin-pool" {
        return Err(failed());
    }
    Ok(expected)
}
/// Success means the kernel has blocked new IO and completed/requeued existing thin-target IO.
pub fn suspend(authority: &VerifiedStorageAuthority) -> Result<(), Status> {
    let expected = identities(authority)?;
    if status(&expected)?.flags & SUSPENDED == 0 {
        let mut value = header(&expected, SUSPENDED | SKIP_LOCKFS | NOFLUSH, 312)?;
        ioctl(6, &mut value)?;
    }
    if identities(authority)? != expected || status(&expected)?.flags & SUSPENDED == 0 {
        return Err(failed());
    }
    Ok(())
}
/// Caller must hold a newer explicit CF startup/drain intent. No mapping table is changed.
pub fn resume(authority: &VerifiedStorageAuthority) -> Result<(), Status> {
    let expected = identities(authority)?;
    if status(&expected)?.flags & SUSPENDED != 0 {
        let mut value = header(&expected, SKIP_LOCKFS | NOFLUSH, 312)?;
        ioctl(6, &mut value)?;
    }
    if identities(authority)? != expected || status(&expected)?.flags & SUSPENDED != 0 {
        return Err(failed());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pinned_uapi_has_exact_layout_and_fixed_commands() {
        assert_eq!(std::mem::size_of::<Header>(), 312);
        assert_eq!(std::mem::offset_of!(Header, uuid), 176);
        assert_eq!(code(6), 0xc138fd06);
        assert_eq!(code(7), 0xc138fd07);
        assert_eq!(code(12), 0xc138fd0c);
        assert!(header("../../unowned", 0, 312).is_err());
    }
}
