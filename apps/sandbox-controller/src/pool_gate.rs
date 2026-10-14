// SPDX-License-Identifier: Apache-2.0
//! Protocol 1 custody shared with the pinned CSI driver. A lock disappearing never removes denial.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
use tonic::Status;
mod qualified;

pub const ROOT: &str = "/var/lib/kubelet/pgcf-pool-gates";
const MAX_RECORD: u64 = 4096;
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn refused() -> Status {
    Status::failed_precondition("pool_creator_fence_unconfirmed")
}
fn handle_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn key(handle: &str) -> Result<String, Status> {
    if !handle_valid(handle) {
        return Err(refused());
    }
    Ok(Sha256::digest(handle.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub v: u8,
    pub volume_handle: String,
    pub scope_sha256: String,
    pub device_uuid: String,
}
impl Record {
    pub fn new(handle: &str, scope: &str, device_uuid: &str) -> Result<Self, Status> {
        if !handle_valid(handle)
            || !hash_valid(scope)
            || !device_uuid.starts_with("LVM-")
            || device_uuid.len() != 68
            || !device_uuid[4..].bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err(refused());
        }
        Ok(Self {
            v: 1,
            volume_handle: handle.to_owned(),
            scope_sha256: scope.to_owned(),
            device_uuid: device_uuid.to_owned(),
        })
    }
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, Status> {
        if self.v != 1
            || !handle_valid(&self.volume_handle)
            || !hash_valid(&self.scope_sha256)
            || !self.device_uuid.starts_with("LVM-")
            || self.device_uuid.len() != 68
            || !self.device_uuid[4..]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric())
        {
            return Err(refused());
        }
        serde_json::to_vec(self).map_err(|_| refused())
    }
}

pub struct GateRoot {
    path: PathBuf,
    directory: File,
}
impl GateRoot {
    /// Host startup must establish custody before the first CSI volume operation.
    pub fn provision(path: &Path) -> Result<Self, Status> {
        let parent = path.parent().ok_or_else(refused)?;
        if unsafe { libc::geteuid() } != 0
            || !path.is_absolute()
            || fs::canonicalize(parent).map_err(|_| refused())? != parent
        {
            return Err(refused());
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(parent)
            .map_err(|_| refused())?;
        let meta = directory.metadata().map_err(|_| refused())?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err(refused());
        }
        let name = std::ffi::CString::new(path.file_name().ok_or_else(refused)?.as_encoded_bytes())
            .map_err(|_| refused())?;
        // Existing custody is never repaired or emptied. mkdirat anchors the only mutation in
        // the verified parent; the ordinary opener rejects symlinks and unexpected permissions.
        if unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) } != 0
            && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST)
        {
            return Err(refused());
        }
        let root = Self::open(path)?;
        directory.sync_all().map_err(|_| refused())?;
        Ok(root)
    }
    /// The root is provisioned before use. Missing, mutable or symlinked roots refuse all work.
    pub fn open(path: &Path) -> Result<Self, Status> {
        if !path.is_absolute() || fs::canonicalize(path).map_err(|_| refused())? != path {
            return Err(refused());
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| refused())?;
        let meta = directory.metadata().map_err(|_| refused())?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o7777 != 0o700 {
            return Err(refused());
        }
        Ok(Self {
            path: path.to_owned(),
            directory,
        })
    }
    pub fn lock(&self, handle: &str) -> Result<LockedVolume<'_>, Status> {
        self.lock_until(
            handle,
            std::time::Instant::now() + std::time::Duration::from_secs(5),
        )
    }
    pub fn lock_until(
        &self,
        handle: &str,
        deadline: std::time::Instant,
    ) -> Result<LockedVolume<'_>, Status> {
        let key = key(handle)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.path.join(format!("{key}.lock")))
            .map_err(|_| refused())?;
        let meta = file.metadata().map_err(|_| refused())?;
        if !meta.is_file() || meta.uid() != 0 || meta.nlink() != 1 || meta.mode() & 0o777 != 0o600 {
            return Err(refused());
        }
        // Lock files are never unlinked: waiters always serialize on this same inode.
        loop {
            if std::time::Instant::now() >= deadline {
                return Err(refused());
            }
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let code = std::io::Error::last_os_error().raw_os_error();
            if code != Some(libc::EWOULDBLOCK) && code != Some(libc::EAGAIN) {
                return Err(refused());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Ok(LockedVolume {
            root: self,
            _lock: file,
            handle: handle.to_owned(),
            key,
        })
    }
    /// The retained inspector reads an atomic already-durable record while the child owns its lock.
    pub(crate) fn record_matches(&self, record: &Record) -> Result<bool, Status> {
        let key = key(&record.volume_handle)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.path.join(format!("{key}.deny")))
            .map_err(|_| refused())?;
        let meta = file.metadata().map_err(|_| refused())?;
        if !meta.is_file()
            || meta.uid() != 0
            || meta.nlink() != 1
            || meta.mode() & 0o7777 != 0o600
            || meta.len() > MAX_RECORD
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        file.take(MAX_RECORD + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        Ok(bytes == record.bytes()?)
    }
}
pub struct LockedVolume<'a> {
    root: &'a GateRoot,
    _lock: File,
    handle: String,
    key: String,
}
impl LockedVolume<'_> {
    pub fn record_path(&self) -> PathBuf {
        self.root.path.join(format!("{}.deny", self.key))
    }
    fn existing_record(&self) -> Result<Option<(Vec<u8>, fs::Metadata)>, Status> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(self.record_path());
        let mut file = match file {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(refused()),
        };
        let meta = file.metadata().map_err(|_| refused())?;
        if !meta.is_file()
            || meta.uid() != 0
            || meta.nlink() != 1
            || meta.mode() & 0o777 != 0o600
            || meta.len() > MAX_RECORD
        {
            return Err(refused());
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_RECORD + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| refused())?;
        if bytes.len() as u64 > MAX_RECORD {
            return Err(refused());
        }
        Ok(Some((bytes, meta)))
    }
    fn existing(&self) -> Result<Option<Vec<u8>>, Status> {
        Ok(self.existing_record()?.map(|(bytes, _)| bytes))
    }
    /// CSI checks only durable absence, after acquiring the lock. Invalid records are denial.
    pub fn publish_allowed(&self) -> Result<bool, Status> {
        match self.existing() {
            Ok(None) => Ok(true),
            Ok(Some(_)) | Err(_) => Ok(false),
        }
    }
    /// Must precede exclusive filesystem creation; no drop/restart/expiry path clears this record.
    pub fn claim(&mut self, record: &Record) -> Result<(), Status> {
        if record.volume_handle != self.handle {
            return Err(refused());
        }
        let bytes = record.bytes()?;
        if let Some(existing) = self.existing()? {
            return if existing == bytes {
                Ok(())
            } else {
                Err(refused())
            };
        }
        self.write_record(&bytes)
    }
    /// Only a fresh authenticated CF qualification GET can provide accepted evidence. The
    /// caller first verifies current local driver, zero-device and absent dispatch journal.
    /// This changes deny ownership, never grants a mount/start or clears CSI denial.
    pub fn claim_qualified(
        &mut self,
        record: &Record,
        desired: &serde_json::Value,
        input: &serde_json::Value,
        preparation: &serde_json::Value,
        keys: &std::collections::HashMap<String, Vec<u8>>,
        now: u64,
    ) -> Result<(), Status> {
        let evidence = qualified::accepted(record, desired, input, preparation, keys, now)?;
        let (existing, meta) = self.existing_record()?.ok_or_else(refused)?;
        let lock = self._lock.metadata().map_err(|_| refused())?;
        let root = self.root.directory.metadata().map_err(|_| refused())?;
        let current_lock = fs::symlink_metadata(self.root.path.join(format!("{}.lock", self.key)))
            .map_err(|_| refused())?;
        let current_root = fs::symlink_metadata(&self.root.path).map_err(|_| refused())?;
        if record.volume_handle != self.handle
            || existing != evidence.previous.bytes()?
            || meta.ino() != evidence.inode
            || digest(&existing) != evidence.record_sha256
            || (lock.dev(), lock.ino()) != (current_lock.dev(), current_lock.ino())
            || (root.dev(), root.ino()) != (current_root.dev(), current_root.ino())
        {
            return Err(refused());
        }
        self.write_record(&record.bytes()?)
    }
    fn write_record(&self, bytes: &[u8]) -> Result<(), Status> {
        let temporary = self
            .root
            .path
            .join(format!("{}.{}.pending", self.key, std::process::id()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&temporary)
                .map_err(|_| refused())?;
            file.write_all(bytes).map_err(|_| refused())?;
            file.sync_all().map_err(|_| refused())?;
            fs::rename(&temporary, self.record_path()).map_err(|_| refused())?;
            self.root.directory.sync_all().map_err(|_| refused())?;
            Ok(())
        })();
        // A crash before rename cannot open a mounted writer: claim must return before fsconfig.
        let _ = fs::remove_file(temporary);
        result
    }
    /// Caller completes normal detach/FD closure first. Only a real, freshly measured DM token clears custody.
    pub fn release_zero(
        &mut self,
        record: &Record,
        zero: &crate::pool_device::ZeroDevice,
    ) -> Result<(), Status> {
        if zero.uuid != record.device_uuid
            || zero.handle != self.handle
            || record.volume_handle != self.handle
            || self.existing()?.as_deref() != Some(record.bytes()?.as_slice())
            || !zero.still_zero().map_err(|_| refused())?
        {
            return Err(refused());
        }
        fs::remove_file(self.record_path()).map_err(|_| refused())?;
        self.root.directory.sync_all().map_err(|_| refused())
    }
}
