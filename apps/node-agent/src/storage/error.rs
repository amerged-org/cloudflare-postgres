// SPDX-License-Identifier: Apache-2.0
//! What storage operations fail with.
use super::pool::NoRoom;
use std::{fmt, io};

#[derive(Debug)]
pub enum Error {
    /// A command could not be started, or a file could not be read.
    Io(io::Error),
    /// A command ended with a failure code.
    Command {
        program: String,
        code: i32,
        stderr: String,
    },
    /// A report, status line or mount table is not what lvm2, dmsetup or the kernel write.
    Parse(&'static str),
    /// A database ID or storage generation that cannot name a volume.
    InvalidId(&'static str),
    /// A volume size that is not a whole number of 4 MiB extents.
    InvalidSize,
    /// The disk, volume group, pool or volume is not what this module made. It is never repaired
    /// in place: the agent owns the pool and does not guess.
    Unexpected(&'static str),
    /// The volume group has no room for a pool.
    TooSmall,
    /// The room rule of plan 4.6 does not hold.
    NoRoom(NoRoom),
    /// The sum of nominal volume sizes would pass the logical cap of plan 4.3.
    LogicalCap { nominal_bytes: u64, cap_bytes: u64 },
    /// A `superseded` order without `remove_volume` does not let a volume go.
    NotAuthorised,
    /// The volume does not exist.
    Missing,
    /// The volume is mounted.
    Mounted,
    /// The volume is not mounted.
    NotMounted,
    /// Something still holds the filesystem.
    Busy,
    /// Storage only grows (plan 3.5).
    Shrink,
    /// `e2fsck -p` could not repair the filesystem.
    Fsck(i32),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(error) => write!(f, "storage io: {error}"),
            Error::Command {
                program,
                code,
                stderr,
            } => write!(f, "{program} ended with {code}: {}", stderr.trim()),
            Error::Parse(what) => write!(f, "unreadable {what}"),
            Error::InvalidId(what) => write!(f, "invalid {what}"),
            Error::InvalidSize => write!(f, "a volume is a whole number of 4 MiB extents"),
            Error::NotAuthorised => write!(f, "the order does not remove the volume"),
            Error::Unexpected(what) => write!(f, "unexpected storage: {what}"),
            Error::TooSmall => write!(f, "the volume group has no room for the pool"),
            Error::NoRoom(reason) => write!(f, "no room: {reason:?}"),
            Error::LogicalCap {
                nominal_bytes,
                cap_bytes,
            } => write!(f, "logical cap: {nominal_bytes} would pass {cap_bytes}"),
            Error::Missing => write!(f, "no such volume"),
            Error::Mounted => write!(f, "the volume is mounted"),
            Error::NotMounted => write!(f, "the volume is not mounted"),
            Error::Busy => write!(f, "the filesystem is busy"),
            Error::Shrink => write!(f, "a volume never shrinks"),
            Error::Fsck(code) => write!(f, "e2fsck could not repair the filesystem ({code})"),
        }
    }
}
impl std::error::Error for Error {}
impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Error::Io(error)
    }
}
