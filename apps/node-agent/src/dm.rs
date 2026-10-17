// SPDX-License-Identifier: Apache-2.0
//! The device-mapper ioctl interface (`linux/dm-ioctl.h`, interface 4) as byte layouts. Pure: the
//! Linux host passes these buffers to `ioctl(/dev/mapper/control)`.
use std::mem::{offset_of, size_of};

/// `struct dm_ioctl`.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct DmIoctl {
    pub version: [u32; 3],
    pub data_size: u32,
    pub data_start: u32,
    pub target_count: u32,
    pub open_count: i32,
    pub flags: u32,
    pub event_nr: u32,
    pub padding: u32,
    pub dev: u64,
    pub name: [u8; 128],
    pub uuid: [u8; 129],
    pub data: [u8; 7],
}

const DM_IOCTL: u32 = 0xfd;
const fn iowr(number: u32) -> u32 {
    (3 << 30) | ((size_of::<DmIoctl>() as u32) << 16) | (DM_IOCTL << 8) | number
}
pub(crate) const DM_LIST_DEVICES: u32 = iowr(2);
pub(crate) const DM_DEV_STATUS: u32 = iowr(7);
pub(crate) const DM_SUSPEND_FLAG: u32 = 1 << 1;
pub(crate) const DM_BUFFER_FULL_FLAG: u32 = 1 << 8;
const VERSION: [u32; 3] = [4, 0, 0];

/// What `DM_DEV_STATUS` answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Status {
    pub open_count: u32,
    pub suspended: bool,
    pub uuid: String,
    /// `major:minor` of the mapped device.
    pub dev: (u32, u32),
}

fn word(buffer: &[u8], offset: usize) -> u32 {
    u32::from_ne_bytes(buffer[offset..offset + 4].try_into().expect("four bytes"))
}
fn text(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().position(|b| *b == 0)?;
    String::from_utf8(bytes[..end].to_vec()).ok()
}
/// The kernel's `huge_encode_dev` for a 64-bit `dev_t`.
pub(crate) fn decode_dev(dev: u64) -> (u32, u32) {
    let major = ((dev >> 8) & 0xfff) as u32;
    let minor = ((dev & 0xff) | ((dev >> 12) & 0xfff00)) as u32;
    (major, minor)
}

/// A request buffer of `length` bytes (at least the header) naming `name` (empty for
/// `DM_LIST_DEVICES`).
pub(crate) fn request(name: &str, length: usize) -> Result<Vec<u8>, &'static str> {
    let header = size_of::<DmIoctl>();
    if name.len() >= 128 || name.contains('\0') || length < header {
        return Err("invalid");
    }
    let mut buffer = vec![0u8; length];
    for (index, part) in VERSION.iter().enumerate() {
        let offset = offset_of!(DmIoctl, version) + index * 4;
        buffer[offset..offset + 4].copy_from_slice(&part.to_ne_bytes());
    }
    let size = u32::try_from(length).map_err(|_| "invalid")?;
    buffer[offset_of!(DmIoctl, data_size)..][..4].copy_from_slice(&size.to_ne_bytes());
    buffer[offset_of!(DmIoctl, data_start)..][..4].copy_from_slice(&(header as u32).to_ne_bytes());
    let offset = offset_of!(DmIoctl, name);
    buffer[offset..offset + name.len()].copy_from_slice(name.as_bytes());
    Ok(buffer)
}

/// Decodes the header the kernel wrote back for `DM_DEV_STATUS`.
pub(crate) fn status(buffer: &[u8]) -> Result<Status, &'static str> {
    if buffer.len() < size_of::<DmIoctl>() {
        return Err("invalid");
    }
    let open_count = word(buffer, offset_of!(DmIoctl, open_count)) as i32;
    let flags = word(buffer, offset_of!(DmIoctl, flags));
    let dev = u64::from_ne_bytes(
        buffer[offset_of!(DmIoctl, dev)..][..8]
            .try_into()
            .expect("eight bytes"),
    );
    let uuid = text(&buffer[offset_of!(DmIoctl, uuid)..][..129]).ok_or("invalid")?;
    Ok(Status {
        open_count: u32::try_from(open_count).map_err(|_| "invalid")?,
        suspended: flags & DM_SUSPEND_FLAG != 0,
        uuid,
        dev: decode_dev(dev),
    })
}

/// The device names `DM_LIST_DEVICES` returned; `None` when the buffer was too small.
pub(crate) fn names(buffer: &[u8]) -> Result<Option<Vec<String>>, &'static str> {
    let header = size_of::<DmIoctl>();
    if buffer.len() < header {
        return Err("invalid");
    }
    if word(buffer, offset_of!(DmIoctl, flags)) & DM_BUFFER_FULL_FLAG != 0 {
        return Ok(None);
    }
    let start = word(buffer, offset_of!(DmIoctl, data_start)) as usize;
    let size = (word(buffer, offset_of!(DmIoctl, data_size)) as usize).min(buffer.len());
    let mut result = Vec::new();
    if start < header || start + 12 > size {
        return Ok(Some(result));
    }
    let mut entry = start;
    loop {
        // struct dm_name_list { __u64 dev; __u32 next; char name[]; }
        let dev = u64::from_ne_bytes(buffer[entry..entry + 8].try_into().expect("eight bytes"));
        if dev == 0 {
            break;
        }
        let next = word(buffer, entry + 8) as usize;
        let name = text(&buffer[entry + 12..size]).ok_or("invalid")?;
        result.push(name);
        if next == 0 {
            break;
        }
        entry = entry.checked_add(next).ok_or("invalid")?;
        if entry + 12 > size {
            return Err("invalid");
        }
    }
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dm_ioctl_layout_is_312_bytes_and_dev_status_is_0xc138fd07() {
        assert_eq!(size_of::<DmIoctl>(), 312);
        assert_eq!(offset_of!(DmIoctl, open_count), 24);
        assert_eq!(offset_of!(DmIoctl, flags), 28);
        assert_eq!(offset_of!(DmIoctl, dev), 40);
        assert_eq!(offset_of!(DmIoctl, name), 48);
        assert_eq!(offset_of!(DmIoctl, uuid), 176);
        assert_eq!(DM_DEV_STATUS, 0xc138fd07);
        assert_eq!(DM_LIST_DEVICES, 0xc138fd02);
        assert_eq!((DM_SUSPEND_FLAG, DM_BUFFER_FULL_FLAG), (2, 256));
        let buffer = request("pgcf-pvc--a", 312).unwrap();
        assert_eq!(&buffer[..12], &[4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][..]);
        assert_eq!(word(&buffer, 12), 312);
        assert_eq!(word(&buffer, 16), 312);
        assert_eq!(&buffer[48..60], b"pgcf-pvc--a\0");
        assert!(request(&"x".repeat(128), 312).is_err());
    }

    #[test]
    fn status_decodes_open_count_suspend_flag_uuid_and_dev() {
        let mut buffer = request("pgcf-pvc--a", 312).unwrap();
        buffer[24..28].copy_from_slice(&1i32.to_ne_bytes());
        buffer[28..32].copy_from_slice(&(DM_SUSPEND_FLAG | 1 << 5).to_ne_bytes());
        // major 253, minor 300: (minor & 0xff) | major << 8 | (minor & !0xff) << 12
        let dev: u64 = (300 & 0xff) | (253 << 8) | ((300 & !0xff) << 12);
        buffer[40..48].copy_from_slice(&dev.to_ne_bytes());
        let uuid = "LVM-abc";
        buffer[176..176 + uuid.len()].copy_from_slice(uuid.as_bytes());
        assert_eq!(
            status(&buffer).unwrap(),
            Status {
                open_count: 1,
                suspended: true,
                uuid: uuid.into(),
                dev: (253, 300),
            }
        );
        buffer[28..32].copy_from_slice(&0u32.to_ne_bytes());
        assert!(!status(&buffer).unwrap().suspended);
        assert!(status(&buffer[..300]).is_err());
    }

    #[test]
    fn list_devices_yields_every_name_and_asks_again_when_the_buffer_was_full() {
        let mut buffer = request("x", 312 + 64).unwrap();
        buffer[16..20].copy_from_slice(&312u32.to_ne_bytes());
        let mut put = |at: usize, dev: u64, next: u32, name: &str| {
            buffer[at..at + 8].copy_from_slice(&dev.to_ne_bytes());
            buffer[at + 8..at + 12].copy_from_slice(&next.to_ne_bytes());
            buffer[at + 12..at + 12 + name.len()].copy_from_slice(name.as_bytes());
        };
        put(312, 0xfd00, 32, "pgcf-pvc--a");
        put(344, 0xfd01, 0, "pgcf-tpool");
        assert_eq!(
            names(&buffer).unwrap(),
            Some(vec!["pgcf-pvc--a".to_string(), "pgcf-tpool".to_string()])
        );
        buffer[28..32].copy_from_slice(&DM_BUFFER_FULL_FLAG.to_ne_bytes());
        assert_eq!(names(&buffer).unwrap(), None);
        let empty = request("x", 312 + 16).unwrap();
        assert_eq!(names(&empty).unwrap(), Some(vec![]));
    }
}
