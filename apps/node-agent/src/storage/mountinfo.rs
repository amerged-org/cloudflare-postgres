// SPDX-License-Identifier: Apache-2.0
//! `/proc/self/mountinfo`: which volumes are mounted where.
use super::Error;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    pub major: u32,
    pub minor: u32,
    pub mount_point: PathBuf,
    pub fstype: String,
    pub source: String,
}

/// The octal escapes the kernel writes for a space, tab, newline or backslash.
fn unescape(field: &str) -> Option<String> {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            let octal = field.get(at + 1..at + 4)?;
            out.push(u8::from_str_radix(octal, 8).ok()?);
            at += 4;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `<id> <parent> <major>:<minor> <root> <mount point> <options> [<optional fields>] - <fstype>
/// <source> <super options>`
pub fn parse(text: &str) -> Result<Vec<Mount>, Error> {
    const BAD: Error = Error::Parse("mount table");
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let words: Vec<&str> = line.split(' ').collect();
            let separator = words.iter().position(|word| *word == "-").ok_or(BAD)?;
            let (device, mount_point) = (words.get(2).ok_or(BAD)?, words.get(4).ok_or(BAD)?);
            let (major, minor) = device.split_once(':').ok_or(BAD)?;
            let after = &words[separator + 1..];
            let [fstype, source, ..] = after else {
                return Err(BAD);
            };
            Ok(Mount {
                major: major.parse().map_err(|_| BAD)?,
                minor: minor.parse().map_err(|_| BAD)?,
                mount_point: PathBuf::from(unescape(mount_point).ok_or(BAD)?),
                fstype: unescape(fstype).ok_or(BAD)?,
                source: unescape(source).ok_or(BAD)?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MOUNTINFO: &str = include_str!("fixtures/mountinfo.txt");

    #[test]
    fn the_mount_table_reads_as_the_kernel_writes_it() {
        let mounts = parse(MOUNTINFO).unwrap();
        assert_eq!(mounts.len(), 4);
        assert_eq!(
            mounts[1],
            Mount {
                major: 252,
                minor: 4,
                mount_point: "/mnt/a".into(),
                fstype: "ext4".into(),
                source: "/dev/mapper/pgcf-db_a1b2c3d4e5f6g7h8i9j0_g1".into(),
            }
        );
        // Spaces in a mount point are written as \040.
        assert_eq!(mounts[2].mount_point, PathBuf::from("/mnt/with space"));
        assert_eq!(
            (mounts[0].fstype.as_str(), mounts[0].source.as_str()),
            ("proc", "proc")
        );
        assert_eq!(mounts[3].fstype, "tmpfs");
    }

    #[test]
    fn a_line_that_is_not_a_mount_is_an_error() {
        assert!(parse("1 2 3").is_err());
        assert!(parse("1 2 x:y / /a rw - ext4 /dev/x rw").is_err());
        assert!(parse("1 2 0:1 / /a rw ext4 /dev/x rw").is_err());
        assert_eq!(parse("").unwrap(), vec![]);
    }
}
