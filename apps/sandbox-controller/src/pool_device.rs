// SPDX-License-Identifier: Apache-2.0
//! Read-only UUID-scoped DM proof for retained linear/thin volumes. No device/table mutation.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt},
    },
};

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
fn refused() -> io::Error {
    io::Error::other("pool_device_identity_unconfirmed")
}
fn text(bytes: &[u8]) -> io::Result<&str> {
    let end = bytes.iter().position(|b| *b == 0).ok_or_else(refused)?;
    std::str::from_utf8(&bytes[..end]).map_err(|_| refused())
}
fn lvm_uuid(value: &str) -> bool {
    value.len() == 38
        && value.split('-').map(str::len).eq([6, 4, 4, 4, 4, 4, 6])
        && value
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_alphanumeric())
}
fn header(uuid: &str, size: usize, flags: u32) -> io::Result<Header> {
    if uuid.len() > 128 {
        return Err(refused());
    }
    let mut h = Header {
        version: [4, 0, 0],
        data_size: size.try_into().map_err(|_| refused())?,
        data_start: 312,
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
    h.uuid[..uuid.len()].copy_from_slice(uuid.as_bytes());
    Ok(h)
}
fn ioctl(command: u32, h: &mut Header) -> io::Result<()> {
    let control = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open("/dev/mapper/control")?;
    if !control.metadata()?.file_type().is_char_device() {
        return Err(refused());
    }
    let code = (3u32 << 30) | (312u32 << 16) | (0xfd << 8) | command;
    if unsafe { libc::ioctl(control.as_raw_fd(), code as _, h as *mut Header) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
fn status(uuid: &str) -> io::Result<Header> {
    let h = observed_status(uuid)?;
    if h.flags & (1 << 1) != 0 {
        return Err(refused());
    }
    Ok(h)
}
fn observed_status(uuid: &str) -> io::Result<Header> {
    let mut h = header(uuid, 312, 0)?;
    ioctl(7, &mut h)?;
    if text(&h.uuid)? != uuid
        || h.version[0] != 4
        || h.data_size as usize != std::mem::offset_of!(Header, data)
        || h.data_start != 312
        || h.open_count < 0
        || h.flags & ((1 << 17) | (1 << 18)) != 0
        || h.dev == 0
    {
        return Err(refused());
    }
    Ok(h)
}
/// This observation is not a device descriptor and never authorizes resume, mount or writes.
pub struct ThinMetadata {
    pub device: u64,
    pub thin_id: u32,
    pub open_count: u32,
    pub suspended: bool,
    pub read_only: bool,
}
pub fn thin_metadata(
    vg: &str,
    lv: &str,
    handle: &str,
    pool_uuid: &str,
) -> io::Result<ThinMetadata> {
    if !lvm_uuid(vg)
        || !lvm_uuid(lv)
        || !lvm_uuid(pool_uuid)
        || handle.is_empty()
        || handle.len() > 128
        || !handle
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(refused());
    }
    let uuid = format!("LVM-{}{}", vg.replace('-', ""), lv.replace('-', ""));
    let before = observed_status(&uuid)?;
    if !text(&before.name)?.ends_with(&format!("-{}", handle.replace('-', "--"))) {
        return Err(refused());
    }
    let rows = targets(&uuid)?;
    if rows.len() != 1 || rows[0].0 != "thin" {
        return Err(refused());
    }
    let fields = rows[0].1.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2 {
        return Err(refused());
    }
    let thin_id = fields[1].parse().map_err(|_| refused())?;
    target_identity(
        &uuid,
        vg,
        &Backend::Thin {
            pool_uuid: pool_uuid.to_owned(),
            thin_id,
        },
    )?;
    let after = observed_status(&uuid)?;
    if before.dev != after.dev || before.flags != after.flags || targets(&uuid)? != rows {
        return Err(refused());
    }
    Ok(ThinMetadata {
        device: after.dev,
        thin_id,
        open_count: after.open_count.try_into().map_err(|_| refused())?,
        suspended: after.flags & (1 << 1) != 0,
        read_only: after.flags & 1 != 0,
    })
}
fn targets(uuid: &str) -> io::Result<Vec<(String, String)>> {
    #[repr(C, align(8))]
    struct Buffer([u8; 65536]);
    let mut b = Buffer([0; 65536]);
    let p = b.0.as_mut_ptr().cast::<Header>();
    unsafe { p.write(header(uuid, b.0.len(), 1 << 4)?) };
    let h = unsafe { &mut *p };
    ioctl(12, h)?;
    if text(&h.uuid)? != uuid
        || h.version[0] != 4
        || h.data_start != 312
        || h.data_size as usize > b.0.len()
        || h.data_size < 312
        || h.target_count == 0
        || h.target_count > 128
        || h.flags & (1 << 8) != 0
    {
        return Err(refused());
    }
    let data_end = h.data_size as usize;
    let targets = h.target_count as usize;
    let mut offset = h.data_start as usize;
    let mut end_sector = 0u64;
    let mut output = Vec::new();
    for i in 0..targets {
        if offset < 312 || offset + 40 >= data_end {
            return Err(refused());
        }
        let start = u64::from_ne_bytes(b.0[offset..offset + 8].try_into().map_err(|_| refused())?);
        let length = u64::from_ne_bytes(
            b.0[offset + 8..offset + 16]
                .try_into()
                .map_err(|_| refused())?,
        );
        let next = u32::from_ne_bytes(
            b.0[offset + 20..offset + 24]
                .try_into()
                .map_err(|_| refused())?,
        ) as usize;
        if start != end_sector || length == 0 {
            return Err(refused());
        }
        end_sector = start.checked_add(length).ok_or_else(refused)?;
        let end = if i + 1 == targets {
            data_end
        } else {
            offset
                .checked_add(next)
                .filter(|end| *end > offset + 40 && *end <= data_end)
                .ok_or_else(refused)?
        };
        let params = text(&b.0[offset + 40..end])?;
        output.push((
            text(&b.0[offset + 24..offset + 40])?.to_owned(),
            params.to_owned(),
        ));
        offset = end;
    }
    Ok(output)
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(tag = "backend", deny_unknown_fields)]
pub enum Backend {
    #[serde(rename = "lvm-thick-v1")]
    Linear,
    #[serde(rename = "lvm-thin-v1")]
    Thin { pool_uuid: String, thin_id: u32 },
}
fn target_identity(uuid: &str, vg: &str, backend: &Backend) -> io::Result<()> {
    let rows = targets(uuid)?;
    match backend {
        Backend::Linear => {
            for (kind, params) in rows {
                let fields = params.split_whitespace().collect::<Vec<_>>();
                if kind != "linear"
                    || fields.len() != 2
                    || fields[1].parse::<u64>().is_err()
                    || fields[0].split(':').count() != 2
                    || fields[0].split(':').any(|p| p.parse::<u32>().is_err())
                {
                    return Err(refused());
                }
            }
        }
        Backend::Thin { pool_uuid, thin_id } => {
            if !lvm_uuid(pool_uuid)
                || *thin_id > 0x00ff_ffff
                || rows.len() != 1
                || rows[0].0 != "thin"
            {
                return Err(refused());
            }
            let fields = rows[0].1.split_whitespace().collect::<Vec<_>>();
            if fields.len() != 2
                || fields[1].parse::<u32>().ok() != Some(*thin_id)
                || fields[0].split(':').count() != 2
                || fields[0].split(':').any(|p| p.parse::<u32>().is_err())
            {
                return Err(refused());
            }
            let actual = fs::read_to_string(format!("/sys/dev/block/{}/dm/uuid", fields[0]))?;
            let expected = format!("LVM-{}{}", vg.replace('-', ""), pool_uuid.replace('-', ""));
            if actual.trim() != expected && actual.trim() != format!("{expected}-tpool") {
                return Err(refused());
            }
            let pool = status(actual.trim())?;
            let number = fields[0]
                .split(':')
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| refused())?;
            if pool.dev != libc::makedev(number[0], number[1]) {
                return Err(refused());
            }
            let pool_rows = targets(actual.trim())?;
            if pool_rows.len() != 1 || pool_rows[0].0 != "thin-pool" {
                return Err(refused());
            }
        }
    }
    Ok(())
}
pub struct Device {
    uuid: String,
    vg: String,
    backend: Backend,
    handle: String,
    file: File,
    device: u64,
}
/// This token has no public constructor and is measured again immediately before gate removal.
pub struct ZeroDevice {
    pub(crate) uuid: String,
    pub(crate) handle: String,
    pub(crate) device: u64,
    vg: String,
    backend: Backend,
}
impl Device {
    /// Before CF grants a binding, report the actual thin ID from an already assigned VG/LV.
    /// The discovered value grants no IO and is verified again against the exact pool/dev/table.
    pub fn discover_thin(
        vg: &str,
        lv: &str,
        handle: &str,
        pool_uuid: &str,
    ) -> io::Result<(Self, u32)> {
        if !lvm_uuid(vg) || !lvm_uuid(lv) || !lvm_uuid(pool_uuid) {
            return Err(refused());
        }
        let uuid = format!("LVM-{}{}", vg.replace('-', ""), lv.replace('-', ""));
        let before = status(&uuid)?;
        let rows = targets(&uuid)?;
        if rows.len() != 1 || rows[0].0 != "thin" {
            return Err(refused());
        }
        let fields = rows[0].1.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 2 {
            return Err(refused());
        }
        let thin_id = fields[1].parse::<u32>().map_err(|_| refused())?;
        let device = Self::verify(
            vg,
            lv,
            handle,
            Backend::Thin {
                pool_uuid: pool_uuid.to_owned(),
                thin_id,
            },
        )?;
        if before.dev != device.device || status(&uuid)?.dev != before.dev {
            return Err(refused());
        }
        Ok((device, thin_id))
    }
    pub fn verify(vg: &str, lv: &str, handle: &str, backend: Backend) -> io::Result<Self> {
        if !lvm_uuid(vg)
            || !lvm_uuid(lv)
            || handle.is_empty()
            || handle.len() > 128
            || !handle
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(refused());
        }
        let uuid = format!("LVM-{}{}", vg.replace('-', ""), lv.replace('-', ""));
        let mut found = None;
        let mut count = 0;
        for entry in fs::read_dir("/sys/class/block")? {
            count += 1;
            if count > 8192 {
                return Err(refused());
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with("dm-")
                || name[3..].is_empty()
                || !name[3..].bytes().all(|b| b.is_ascii_digit())
            {
                continue;
            }
            if fs::read_to_string(entry.path().join("dm/uuid"))?.trim() == uuid {
                if found.is_some() {
                    return Err(refused());
                }
                found = Some(name.to_owned());
            }
        }
        let name = found.ok_or_else(refused)?;
        let before = status(&uuid)?;
        if !text(&before.name)?.ends_with(&format!("-{}", handle.replace('-', "--"))) {
            return Err(refused());
        }
        target_identity(&uuid, vg, &backend)?;
        let mapper = text(&before.name)?;
        if !mapper
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_+.".contains(&b))
        {
            return Err(refused());
        }
        let path = if std::path::Path::new(&format!("/dev/{name}")).exists() {
            std::path::PathBuf::from(format!("/dev/{name}"))
        } else {
            fs::canonicalize(format!("/dev/mapper/{mapper}"))?
        };
        if !path.starts_with("/dev") {
            return Err(refused());
        }
        let path =
            std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| refused())?;
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat,
                libc::AT_FDCWD,
                path.as_ptr(),
                libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd as i32) };
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) } & libc::O_PATH == 0 {
            return Err(refused());
        }
        let meta = file.metadata()?;
        let after = status(&uuid)?;
        if !meta.file_type().is_block_device()
            || meta.rdev() != before.dev
            || after.dev != before.dev
        {
            return Err(refused());
        }
        target_identity(&uuid, vg, &backend)?;
        Ok(Self {
            uuid,
            vg: vg.to_owned(),
            backend,
            handle: handle.to_owned(),
            file,
            device: meta.rdev(),
        })
    }
    pub fn descriptor(&self) -> &File {
        &self.file
    }
    pub fn device(&self) -> u64 {
        self.device
    }
    pub fn uuid(&self) -> &str {
        &self.uuid
    }
    pub fn open_count(&self) -> io::Result<u32> {
        let h = status(&self.uuid)?;
        if h.dev != self.device {
            return Err(refused());
        }
        h.open_count.try_into().map_err(|_| refused())
    }
    pub fn zero(&self) -> io::Result<ZeroDevice> {
        target_identity(&self.uuid, &self.vg, &self.backend)?;
        if self.open_count()? != 0 {
            return Err(refused());
        }
        Ok(ZeroDevice {
            uuid: self.uuid.clone(),
            handle: self.handle.clone(),
            device: self.device,
            vg: self.vg.clone(),
            backend: self.backend.clone(),
        })
    }
}
impl ZeroDevice {
    pub(crate) fn still_zero(&self) -> io::Result<bool> {
        target_identity(&self.uuid, &self.vg, &self.backend)?;
        let h = observed_status(&self.uuid)?;
        Ok(h.dev == self.device && h.open_count == 0)
    }
}
/// Post-expiry absence is read-only and remains measurable while the device is suspended.
pub fn zero_thin(
    vg: &str,
    lv: &str,
    handle: &str,
    pool: &str,
    thin_id: u32,
) -> io::Result<ZeroDevice> {
    let actual = thin_metadata(vg, lv, handle, pool)?;
    if actual.open_count != 0 || actual.thin_id != thin_id {
        return Err(refused());
    }
    let zero = ZeroDevice {
        uuid: format!("LVM-{}{}", vg.replace('-', ""), lv.replace('-', "")),
        handle: handle.to_owned(),
        device: actual.device,
        vg: vg.to_owned(),
        backend: Backend::Thin {
            pool_uuid: pool.to_owned(),
            thin_id,
        },
    };
    if !zero.still_zero()? {
        return Err(refused());
    }
    Ok(zero)
}
