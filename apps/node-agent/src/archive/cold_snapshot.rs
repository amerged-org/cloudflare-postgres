// SPDX-License-Identifier: Apache-2.0
//! Lossless snapshots of a cleanly stopped PostgreSQL 18 data directory. The complete expected
//! manifest is captured before uploading any bytes. Files are packed into one ordered byte
//! stream, so tiny catalog files share bounded chunks. Extraction validates every expected
//! chunk and every complete file before a caller may start PostgreSQL; no archive recovery is
//! involved, which preserves UNLOGGED relations and the original clean-shutdown checkpoint.
use crate::{pg_control, state::ProvenSleepRecord};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString, OsString},
    fs::{File, OpenOptions},
    future::Future,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStringExt,
            fs::{OpenOptionsExt, PermissionsExt},
        },
    },
    path::Path,
    pin::Pin,
    sync::Arc,
};

pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const MANIFEST_MAX_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FILES: usize = 16_384;
pub const MAX_DIRECTORIES: usize = 4_096;
pub const MAX_CHUNKS: usize = 16_384;
pub const MAX_TOTAL_BYTES: u64 = (CHUNK_BYTES as u64) * (MAX_CHUNKS as u64);
pub type Error = &'static str;
pub type Transfer<'a, T> = Pin<Box<dyn Future<Output = Result<T, Error>> + Send + 'a>>;
pub type BoxFuture<'a, T> = Transfer<'a, T>;

/// Transport is scoped to one immutable snapshot operation by the signed node API.
/// Implementations bound reads before allocating (manifest/chunk: at most four MiB).
pub trait Transport: Send + Sync {
    fn put_manifest<'a>(&'a self, bytes: &'a [u8], sha256: &'a str) -> Transfer<'a, ()>;
    fn get_manifest(&self) -> Transfer<'_, Vec<u8>>;
    fn put_chunk<'a>(&'a self, index: u32, bytes: &'a [u8], sha256: &'a str) -> Transfer<'a, ()>;
    fn get_chunk(&self, index: u32) -> Transfer<'_, Vec<u8>>;
    fn seal<'a>(&'a self, manifest_sha256: &'a str) -> Transfer<'a, ()>;
}
pub trait Store: Send + Sync {
    fn operation(&self, operation: &str) -> Arc<dyn Transport>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub operation: String,
    pub database_id: String,
    pub source_generation: u64,
    pub source_storage_generation: u64,
    pub end: ProvenSleepRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub path: String,
    pub offset: u64,
    pub size_bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Chunk {
    pub index: u32,
    pub size_bytes: u32,
    pub sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: u8,
    pub operation: String,
    pub database_id: String,
    pub source_generation: u64,
    pub source_storage_generation: u64,
    pub pg_major: u8,
    pub end: ProvenSleepRecord,
    pub total_bytes: u64,
    pub directories: Vec<String>,
    pub files: Vec<SnapshotFile>,
    pub chunks: Vec<Chunk>,
}

impl Manifest {
    pub fn binding(&self) -> Binding {
        Binding {
            operation: self.operation.clone(),
            database_id: self.database_id.clone(),
            source_generation: self.source_generation,
            source_storage_generation: self.source_storage_generation,
            end: self.end.clone(),
        }
    }
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        self.validate()?;
        let bytes = serde_json::to_vec(self).map_err(|_| "snapshot_manifest_invalid")?;
        if bytes.len() > MANIFEST_MAX_BYTES {
            return Err("snapshot_manifest_too_large");
        }
        Ok(bytes)
    }
    pub fn sha256(&self) -> Result<String, Error> {
        Ok(hash(&self.encode()?))
    }
    pub fn decode(bytes: &[u8], expected_sha256: &str) -> Result<Self, Error> {
        if bytes.len() > MANIFEST_MAX_BYTES {
            return Err("snapshot_manifest_too_large");
        }
        if !digest_valid(expected_sha256) || hash(bytes) != expected_sha256 {
            return Err("snapshot_manifest_mismatch");
        }
        let manifest: Self =
            serde_json::from_slice(bytes).map_err(|_| "snapshot_manifest_invalid")?;
        manifest.validate()?;
        Ok(manifest)
    }
    pub fn validate(&self) -> Result<(), Error> {
        if self.version != 1
            || self.pg_major != 18
            || !binding_valid(&self.binding())
            || self.files.len() < 2
            || self.chunks.is_empty()
            || self.total_bytes == 0
            || self.files.len() > MAX_FILES
            || self.directories.len() > MAX_DIRECTORIES
            || self.chunks.len() > MAX_CHUNKS
            || self.total_bytes > MAX_TOTAL_BYTES
        {
            return Err("snapshot_manifest_invalid");
        }
        let mut known = BTreeMap::new();
        let mut previous = None;
        for directory in &self.directories {
            if !path_valid(directory)
                || previous.is_some_and(|old: &String| old >= directory)
                || !parent_known(directory, &known)
                || known.insert(directory.clone(), true).is_some()
            {
                return Err("snapshot_manifest_invalid");
            }
            previous = Some(directory);
        }
        let mut next = 0u64;
        previous = None;
        for file in &self.files {
            if !path_valid(&file.path)
                || previous.is_some_and(|old| old >= &file.path)
                || !parent_known(&file.path, &known)
                || known.insert(file.path.clone(), false).is_some()
                || file.offset != next
                || !digest_valid(&file.sha256)
            {
                return Err("snapshot_manifest_invalid");
            }
            next = next
                .checked_add(file.size_bytes)
                .filter(|n| *n <= MAX_TOTAL_BYTES)
                .ok_or("snapshot_manifest_invalid")?;
            previous = Some(&file.path);
        }
        if next != self.total_bytes
            || !known.get("global").copied().unwrap_or(false)
            || known.get("global/pg_control") != Some(&false)
            || known.get("PG_VERSION") != Some(&false)
            || !known.get("pg_wal").copied().unwrap_or(false)
        {
            return Err("snapshot_manifest_invalid");
        }
        if self.end.timeline > 1 {
            let history = format!("pg_wal/{:08X}.history", self.end.timeline);
            if !self
                .files
                .iter()
                .any(|file| file.path == history && file.size_bytes > 0)
            {
                return Err("snapshot_timeline_history_missing");
            }
        }
        let mut total = 0u64;
        for (index, chunk) in self.chunks.iter().enumerate() {
            if chunk.index != index as u32
                || chunk.size_bytes == 0
                || chunk.size_bytes as usize > CHUNK_BYTES
                || !digest_valid(&chunk.sha256)
                || (index + 1 < self.chunks.len() && chunk.size_bytes as usize != CHUNK_BYTES)
            {
                return Err("snapshot_manifest_invalid");
            }
            total += u64::from(chunk.size_bytes);
        }
        if total != self.total_bytes {
            return Err("snapshot_manifest_invalid");
        }
        Ok(())
    }
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn finish_hash(digest: Sha256) -> String {
    digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn digest_valid(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn binding_valid(binding: &Binding) -> bool {
    pgcf_native_protocol::valid_pattern("operation", &binding.operation)
        && pgcf_native_protocol::valid_pattern("database", &binding.database_id)
        && (1..=9_007_199_254_740_991).contains(&binding.source_generation)
        && (1..=9_007_199_254_740_991).contains(&binding.source_storage_generation)
        && binding.end.valid()
}
fn path_valid(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
        && !matches!(
            path,
            "postmaster.pid"
                | "recovery.signal"
                | "standby.signal"
                | "backup_label"
                | "tablespace_map"
        )
}
fn parent_known(path: &str, known: &BTreeMap<String, bool>) -> bool {
    path.rsplit_once('/')
        .is_none_or(|(parent, _)| known.get(parent) == Some(&true))
}

/// An opened directory anchors every child access. No component below it is followed through
/// a symlink, including when a path changes between enumeration and opening.
struct Directory(File);
impl Directory {
    fn open(path: &Path) -> Result<Self, Error> {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map(Self)
            .map_err(|_| "snapshot_unsafe_path")
    }
    fn child(&self, name: &str) -> Result<Self, Error> {
        let name = CString::new(name).map_err(|_| "snapshot_unsafe_path")?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("snapshot_unsafe_path");
        }
        Ok(Self(unsafe { File::from_raw_fd(fd) }))
    }
    fn relative(&self, path: &str) -> Result<Self, Error> {
        let mut held = Self(self.0.try_clone().map_err(|_| "snapshot_io")?);
        if path.is_empty() {
            return Ok(held);
        }
        for name in path.split('/') {
            held = held.child(name)?;
        }
        Ok(held)
    }
    fn parent(&self, path: &str) -> Result<(Self, CString), Error> {
        if !path_valid(path) {
            return Err("snapshot_unsafe_path");
        }
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        Ok((
            self.relative(parent)?,
            CString::new(name).map_err(|_| "snapshot_unsafe_path")?,
        ))
    }
    fn read_file(&self, path: &str) -> Result<File, Error> {
        let (parent, name) = self.parent(path)?;
        let fd = unsafe {
            libc::openat(
                parent.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("snapshot_source_changed");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata().map_err(|_| "snapshot_io")?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.dev() != self.0.metadata().map_err(|_| "snapshot_io")?.dev()
        {
            return Err("snapshot_unsupported_file");
        }
        Ok(file)
    }
    fn create_directory(&self, path: &str, owner: Option<(u32, u32)>) -> Result<(), Error> {
        let (parent, name) = self.parent(path)?;
        if unsafe { libc::mkdirat(parent.0.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err("snapshot_destination_not_empty");
        }
        let directory = self.relative(path)?;
        set_owner(&directory.0, owner, 0o700)
    }
    fn create_file(&self, path: &str, owner: Option<(u32, u32)>) -> Result<File, Error> {
        let (parent, name) = self.parent(path)?;
        let fd = unsafe {
            libc::openat(
                parent.0.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("snapshot_destination_not_empty");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        set_owner(&file, owner, 0o600)?;
        Ok(file)
    }
    fn names(&self) -> Result<Vec<String>, Error> {
        let fd = unsafe { libc::fcntl(self.0.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
        if fd < 0 {
            return Err("snapshot_io");
        }
        let directory = unsafe { libc::fdopendir(fd) };
        if directory.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err("snapshot_io");
        }
        struct Dir(*mut libc::DIR);
        impl Drop for Dir {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let directory = Dir(directory);
        unsafe {
            libc::rewinddir(directory.0);
        }
        let mut names = Vec::new();
        loop {
            unsafe {
                *errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(directory.0) };
            if entry.is_null() {
                if unsafe { *errno_location() } != 0 {
                    return Err("snapshot_io");
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if matches!(name, b"." | b"..") {
                continue;
            }
            let name = OsString::from_vec(name.to_vec())
                .into_string()
                .map_err(|_| "snapshot_unsafe_path")?;
            if name.contains('/') {
                return Err("snapshot_unsafe_path");
            }
            names.push(name);
            if names.len() > MAX_FILES + MAX_DIRECTORIES {
                return Err("snapshot_manifest_too_large");
            }
        }
        names.sort();
        Ok(names)
    }
    fn kind(&self, name: &str) -> Result<libc::mode_t, Error> {
        let name = CString::new(name).map_err(|_| "snapshot_unsafe_path")?;
        let mut info = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.0.as_raw_fd(),
                name.as_ptr(),
                info.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err("snapshot_source_changed");
        }
        Ok(unsafe { info.assume_init() }.st_mode & libc::S_IFMT)
    }
}
#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}
#[cfg(target_os = "macos")]
unsafe fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

fn set_owner(file: &File, owner: Option<(u32, u32)>, mode: u32) -> Result<(), Error> {
    if let Some((uid, gid)) = owner
        && (uid == u32::MAX
            || gid == u32::MAX
            || unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0)
    {
        return Err("snapshot_owner_failed");
    }
    file.set_permissions(std::fs::Permissions::from_mode(mode))
        .map_err(|_| "snapshot_owner_failed")
}

fn inventory(root: &Directory) -> Result<(Vec<String>, Vec<String>), Error> {
    use std::os::unix::fs::MetadataExt;
    let device = root.0.metadata().map_err(|_| "snapshot_io")?.dev();
    let mut directories = Vec::new();
    let mut files = Vec::new();
    let mut pending = vec![String::new()];
    while let Some(parent) = pending.pop() {
        let directory = root.relative(&parent)?;
        if directory.0.metadata().map_err(|_| "snapshot_io")?.dev() != device {
            return Err("snapshot_unsupported_mount");
        }
        for name in directory.names()? {
            let path = if parent.is_empty() {
                name.clone()
            } else {
                format!("{parent}/{name}")
            };
            if !path_valid(&path) {
                return Err("snapshot_unsafe_path");
            }
            match directory.kind(&name)? {
                kind if kind == libc::S_IFDIR => {
                    directories.push(path.clone());
                    pending.push(path);
                }
                kind if kind == libc::S_IFREG => {
                    files.push(path);
                }
                _ => return Err("snapshot_unsupported_file"),
            }
            if directories.len() > MAX_DIRECTORIES || files.len() > MAX_FILES {
                return Err("snapshot_manifest_too_large");
            }
        }
    }
    directories.sort();
    files.sort();
    Ok((directories, files))
}

fn clean_control(
    root: &Directory,
    end: &ProvenSleepRecord,
) -> Result<pg_control::ControlFile, Error> {
    let mut version = Vec::new();
    root.read_file("PG_VERSION")?
        .take(32)
        .read_to_end(&mut version)
        .map_err(|_| "snapshot_io")?;
    if version != b"18\n" {
        return Err("snapshot_pg_version");
    }
    let mut bytes = Vec::new();
    root.read_file("global/pg_control")?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "snapshot_io")?;
    if bytes.len() != 8192 {
        return Err("snapshot_not_clean");
    }
    let control = pg_control::parse_control_file(&bytes).map_err(|_| "snapshot_not_clean")?;
    if !control.control.shut_down()
        || control.control.system_identifier != end.system_identifier
        || control.control.timeline != end.timeline
        || Some(pg_control::Lsn(control.checkpoint)) != pg_control::Lsn::parse(&end.checkpoint_lsn)
    {
        return Err("snapshot_not_clean");
    }
    if end.timeline > 1 {
        let history = root
            .read_file(&format!("pg_wal/{:08X}.history", end.timeline))
            .map_err(|_| "snapshot_timeline_history_missing")?;
        if history
            .metadata()
            .map_err(|_| "snapshot_timeline_history_missing")?
            .len()
            == 0
        {
            return Err("snapshot_timeline_history_missing");
        }
    }
    Ok(control)
}

fn complete_chunk(chunks: &mut Vec<Chunk>, bytes: &[u8]) -> Result<(), Error> {
    if chunks.len() == MAX_CHUNKS {
        return Err("snapshot_manifest_too_large");
    }
    chunks.push(Chunk {
        index: chunks.len() as u32,
        size_bytes: bytes.len() as u32,
        sha256: hash(bytes),
    });
    Ok(())
}

/// Captures the full expected inventory and digests from the stopped source, without transport
/// calls. Cooperative yields bound hashing work between cancellation points to one chunk.
pub async fn capture_manifest(data: &Path, binding: &Binding) -> Result<Manifest, Error> {
    if !binding_valid(binding) {
        return Err("snapshot_binding_invalid");
    }
    let root = Directory::open(data)?;
    let (directories, paths) = inventory(&root)?;
    clean_control(&root, &binding.end)?;
    let mut manifest = Manifest {
        version: 1,
        operation: binding.operation.clone(),
        database_id: binding.database_id.clone(),
        source_generation: binding.source_generation,
        source_storage_generation: binding.source_storage_generation,
        pg_major: 18,
        end: binding.end.clone(),
        total_bytes: 0,
        directories,
        files: Vec::new(),
        chunks: Vec::new(),
    };
    let mut packed = Vec::with_capacity(CHUNK_BYTES);
    for path in paths {
        let mut file = root.read_file(&path)?;
        let size = file.metadata().map_err(|_| "snapshot_io")?.len();
        let offset = manifest.total_bytes;
        manifest.total_bytes = offset
            .checked_add(size)
            .filter(|n| *n <= MAX_TOTAL_BYTES)
            .ok_or("snapshot_too_large")?;
        let mut remaining = size;
        let mut digest = Sha256::new();
        while remaining > 0 {
            let start = packed.len();
            let take = remaining.min((CHUNK_BYTES - start) as u64) as usize;
            packed.resize(start + take, 0);
            file.read_exact(&mut packed[start..])
                .map_err(|_| "snapshot_source_changed")?;
            digest.update(&packed[start..]);
            remaining -= take as u64;
            if packed.len() == CHUNK_BYTES {
                complete_chunk(&mut manifest.chunks, &packed)?;
                packed.clear();
            }
            tokio::task::yield_now().await;
        }
        let mut extra = [0u8; 1];
        if file.read(&mut extra).map_err(|_| "snapshot_io")? != 0 {
            return Err("snapshot_source_changed");
        }
        manifest.files.push(SnapshotFile {
            path,
            offset,
            size_bytes: size,
            sha256: finish_hash(digest),
        });
        tokio::task::yield_now().await;
    }
    if !packed.is_empty() {
        complete_chunk(&mut manifest.chunks, &packed)?;
    }
    clean_control(&root, &binding.end)?;
    // Encoding enforces both structural validation and the transport's exact manifest bound.
    manifest.encode()?;
    Ok(manifest)
}

/// Declares the complete expected source manifest before uploading data. Only its matching
/// chunks can be accepted, and a complete source recheck precedes sealing the snapshot.
pub async fn capture_and_upload(
    data: &Path,
    binding: &Binding,
    transport: &dyn Transport,
) -> Result<Manifest, Error> {
    let manifest = capture_manifest(data, binding).await?;
    let bytes = manifest.encode()?;
    transport.put_manifest(&bytes, &hash(&bytes)).await?;
    let root = Directory::open(data)?;
    let mut packed = Vec::with_capacity(CHUNK_BYTES);
    let mut index = 0usize;
    for item in &manifest.files {
        let mut file = root.read_file(&item.path)?;
        if file.metadata().map_err(|_| "snapshot_io")?.len() != item.size_bytes {
            return Err("snapshot_source_changed");
        }
        let mut remaining = item.size_bytes;
        let mut digest = Sha256::new();
        while remaining > 0 {
            let start = packed.len();
            let take = remaining.min((CHUNK_BYTES - start) as u64) as usize;
            packed.resize(start + take, 0);
            file.read_exact(&mut packed[start..])
                .map_err(|_| "snapshot_source_changed")?;
            digest.update(&packed[start..]);
            remaining -= take as u64;
            if packed.len() == CHUNK_BYTES {
                upload_chunk(&manifest, index, &packed, transport).await?;
                index += 1;
                packed.clear();
            }
            tokio::task::yield_now().await;
        }
        let mut extra = [0u8; 1];
        if file.read(&mut extra).map_err(|_| "snapshot_io")? != 0
            || finish_hash(digest) != item.sha256
        {
            return Err("snapshot_source_changed");
        }
    }
    if !packed.is_empty() {
        upload_chunk(&manifest, index, &packed, transport).await?;
        index += 1;
    }
    if index != manifest.chunks.len() || capture_manifest(data, binding).await? != manifest {
        return Err("snapshot_source_changed");
    }
    transport.seal(&hash(&bytes)).await?;
    Ok(manifest)
}
async fn upload_chunk(
    manifest: &Manifest,
    index: usize,
    bytes: &[u8],
    transport: &dyn Transport,
) -> Result<(), Error> {
    let chunk = manifest
        .chunks
        .get(index)
        .ok_or("snapshot_source_changed")?;
    if bytes.len() != chunk.size_bytes as usize || hash(bytes) != chunk.sha256 {
        return Err("snapshot_source_changed");
    }
    transport.put_chunk(chunk.index, bytes, &chunk.sha256).await
}

/// Extracts only into an empty operation-owned directory. A partial or corrupt restore never
/// counts as verified and is left for its owning journal to remove. No PostgreSQL process starts.
pub async fn restore_and_verify(
    data: &Path,
    binding: &Binding,
    manifest_sha256: &str,
    transport: &dyn Transport,
    owner: Option<(u32, u32)>,
) -> Result<Manifest, Error> {
    let bytes = transport.get_manifest().await?;
    let manifest = Manifest::decode(&bytes, manifest_sha256)?;
    if manifest.binding() != *binding {
        return Err("snapshot_binding_mismatch");
    }
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(data) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("snapshot_io"),
    }
    let root = Directory::open(data)?;
    if !root.names()?.is_empty() {
        return Err("snapshot_destination_not_empty");
    }
    set_owner(&root.0, owner, 0o700)?;
    for directory in &manifest.directories {
        root.create_directory(directory, owner)?;
    }
    let mut chunk_index = 0usize;
    let mut packed = Vec::new();
    let mut cursor = 0usize;
    for item in &manifest.files {
        let mut file = root.create_file(&item.path, owner)?;
        let mut remaining = item.size_bytes;
        let mut digest = Sha256::new();
        while remaining > 0 {
            if cursor == packed.len() {
                let expected = manifest
                    .chunks
                    .get(chunk_index)
                    .ok_or("snapshot_chunk_missing")?;
                packed = transport.get_chunk(expected.index).await?;
                if packed.len() != expected.size_bytes as usize
                    || packed.len() > CHUNK_BYTES
                    || hash(&packed) != expected.sha256
                {
                    return Err("snapshot_chunk_mismatch");
                }
                cursor = 0;
                chunk_index += 1;
            }
            let take = remaining.min((packed.len() - cursor) as u64) as usize;
            file.write_all(&packed[cursor..cursor + take])
                .map_err(|_| "snapshot_io")?;
            digest.update(&packed[cursor..cursor + take]);
            cursor += take;
            remaining -= take as u64;
            tokio::task::yield_now().await;
        }
        if finish_hash(digest) != item.sha256 {
            return Err("snapshot_file_mismatch");
        }
        file.sync_all().map_err(|_| "snapshot_io")?;
    }
    if cursor != packed.len() || chunk_index != manifest.chunks.len() {
        return Err("snapshot_chunk_mismatch");
    }
    for directory in manifest.directories.iter().rev() {
        root.relative(directory)?
            .0
            .sync_all()
            .map_err(|_| "snapshot_io")?;
    }
    root.0.sync_all().map_err(|_| "snapshot_io")?;
    clean_control(&root, &binding.end)?;
    // The complete namespace must still be precisely what the manifest authorized.
    let (directories, files) = inventory(&root)?;
    if directories != manifest.directories
        || files
            != manifest
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
    {
        return Err("snapshot_destination_changed");
    }
    Ok(manifest)
}

/// Revalidates a recovered directory before controlled configuration changes or any PostgreSQL
/// start. Returns the original clean-shutdown control identity for the durable start attestation.
pub async fn verify_data(
    data: &Path,
    manifest: &Manifest,
) -> Result<pg_control::ControlFile, Error> {
    manifest.validate()?;
    if capture_manifest(data, &manifest.binding()).await? != *manifest {
        return Err("snapshot_file_mismatch");
    }
    clean_control(&Directory::open(data)?, &manifest.end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        archive::{cold_snapshot_test_store::MemoryStore, test_support::directory},
        settings::Capacity,
    };
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        path::PathBuf,
        sync::atomic::{AtomicBool, Ordering},
    };

    fn binding(end: ProvenSleepRecord) -> Binding {
        Binding {
            operation: "op_cccccccccccccccccccc".into(),
            database_id: "abcdefghijklmnopqrst".into(),
            source_generation: 7,
            source_storage_generation: 2,
            end,
        }
    }
    fn fixture(name: &str) -> (PathBuf, Binding) {
        let root = directory(name);
        let data = root.join("source");
        for dir in ["global", "pg_wal", "base/1"] {
            std::fs::create_dir_all(data.join(dir)).unwrap();
        }
        std::fs::write(data.join("PG_VERSION"), b"18\n").unwrap();
        let control = pg_control::control_file(&Capacity::of_class(256, 20));
        let parsed = pg_control::parse_control_file(&control).unwrap();
        std::fs::write(data.join("global/pg_control"), control).unwrap();
        std::fs::write(data.join("base/1/100"), b"committed logged rows").unwrap();
        std::fs::write(data.join("base/1/101"), b"committed unlogged rows").unwrap();
        std::fs::write(data.join("base/1/101_init"), b"initial fork").unwrap();
        std::fs::write(data.join("base/1/empty"), b"").unwrap();
        std::fs::write(
            data.join("pg_wal/000000010000000000000001"),
            vec![7u8; CHUNK_BYTES + 17],
        )
        .unwrap();
        let end = ProvenSleepRecord {
            system_identifier: parsed.control.system_identifier,
            timeline: parsed.control.timeline,
            checkpoint_lsn: pg_control::Lsn(parsed.checkpoint).to_string(),
            last_archived_segment: "000000010000000000000001".into(),
            proven_at: "2026-11-06T00:00:00.000Z".into(),
        };
        (root, binding(end))
    }

    #[test]
    fn snapshot_limits_match_the_generated_authoritative_contract() {
        for (name, expected) in [
            ("COLD_SNAPSHOT_VERSION", 1u64),
            ("COLD_SNAPSHOT_CHUNK_BYTES", CHUNK_BYTES as u64),
            (
                "COLD_SNAPSHOT_MANIFEST_MAX_BYTES",
                MANIFEST_MAX_BYTES as u64,
            ),
            ("COLD_SNAPSHOT_FILES_MAX", MAX_FILES as u64),
            ("COLD_SNAPSHOT_DIRECTORIES_MAX", MAX_DIRECTORIES as u64),
            ("COLD_SNAPSHOT_CHUNKS_MAX", MAX_CHUNKS as u64),
            ("COLD_SNAPSHOT_TOTAL_MAX_BYTES", MAX_TOTAL_BYTES),
        ] {
            assert_eq!(
                crate::node_link::constant(name).as_u64(),
                Some(expected),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn captures_all_files_before_upload_and_packs_tiny_files_into_shared_chunks() {
        let (root, binding) = fixture("cs-packed");
        let data = root.join("source");
        let store = MemoryStore::default();
        let transport = store.operation(&binding.operation);
        let expected = capture_manifest(&data, &binding).await.unwrap();
        assert_eq!(store.writes(&binding.operation), 0);
        let manifest = capture_and_upload(&data, &binding, transport.as_ref())
            .await
            .unwrap();
        assert_eq!(manifest, expected);
        assert!(crate::node_link::contract_valid(
            "ColdSnapshotManifest",
            &serde_json::to_value(&manifest).unwrap()
        ));
        assert_eq!(manifest.chunks.len(), 2);
        assert!(manifest.files.len() > manifest.chunks.len());
        assert!(
            manifest
                .files
                .iter()
                .any(|file| file.path.ends_with("_init"))
        );
        let target = root.join("restored");
        let actual = restore_and_verify(
            &target,
            &binding,
            &manifest.sha256().unwrap(),
            transport.as_ref(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(actual, manifest);
        let control = verify_data(&target, &manifest).await.unwrap();
        assert_eq!(
            control.control.system_identifier,
            binding.end.system_identifier
        );
        for item in &manifest.files {
            assert_eq!(
                std::fs::read(data.join(&item.path)).unwrap(),
                std::fs::read(target.join(&item.path)).unwrap()
            );
            assert_eq!(
                std::fs::metadata(target.join(&item.path)).unwrap().mode() & 0o777,
                0o600
            );
        }
        assert!(!target.join("recovery.signal").exists());
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn missing_or_corrupt_chunks_never_complete_and_identity_changes_fail_before_extraction()
    {
        let (root, binding) = fixture("cs-integrity");
        let data = root.join("source");
        let store = MemoryStore::default();
        let transport = store.operation(&binding.operation);
        let manifest = capture_and_upload(&data, &binding, transport.as_ref())
            .await
            .unwrap();
        let digest = manifest.sha256().unwrap();
        let original = store.chunk(&binding.operation, 0).unwrap();
        store.remove_chunk(&binding.operation, 0);
        assert!(
            restore_and_verify(
                &root.join("missing"),
                &binding,
                &digest,
                transport.as_ref(),
                None
            )
            .await
            .is_err()
        );
        let mut corrupt = original;
        corrupt[0] ^= 1;
        store.replace_chunk(&binding.operation, 0, corrupt);
        assert_eq!(
            restore_and_verify(
                &root.join("corrupt"),
                &binding,
                &digest,
                transport.as_ref(),
                None
            )
            .await
            .unwrap_err(),
            "snapshot_chunk_mismatch"
        );
        let mut wrong = binding.clone();
        wrong.source_storage_generation += 1;
        assert_eq!(
            restore_and_verify(
                &root.join("wrong"),
                &wrong,
                &digest,
                transport.as_ref(),
                None
            )
            .await
            .unwrap_err(),
            "snapshot_binding_mismatch"
        );
        assert!(!root.join("wrong").exists());
        let mut altered_manifest = store.manifest(&binding.operation).unwrap();
        altered_manifest[0] ^= 1;
        store.replace_manifest(&binding.operation, altered_manifest);
        assert_eq!(
            restore_and_verify(
                &root.join("manifest"),
                &binding,
                &digest,
                transport.as_ref(),
                None
            )
            .await
            .unwrap_err(),
            "snapshot_manifest_mismatch"
        );
        assert!(!root.join("manifest").exists());
        assert!(data.join("base/1/101").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn traversal_aliases_symlinks_special_files_and_nonempty_destinations_are_refused() {
        let (root, binding) = fixture("cs-paths");
        let data = root.join("source");
        let store = MemoryStore::default();
        let transport = store.operation(&binding.operation);
        let manifest = capture_and_upload(&data, &binding, transport.as_ref())
            .await
            .unwrap();
        for bad in [
            "../escape",
            "/absolute",
            "base//escape",
            "base/../escape",
            "base\\escape",
            "postmaster.pid",
            "backup_label",
            "recovery.signal",
        ] {
            let mut malformed = manifest.clone();
            malformed.files[0].path = bad.into();
            let encoded = serde_json::to_vec(&malformed).unwrap();
            assert!(
                Manifest::decode(&encoded, &hash(&encoded)).is_err(),
                "{bad}"
            );
        }
        let mut malformed = manifest.clone();
        malformed.files[1].offset += 1;
        assert!(malformed.validate().is_err());
        let mut malformed = manifest.clone();
        malformed.chunks[0].size_bytes -= 1;
        assert!(malformed.validate().is_err());
        let mut unknown = serde_json::to_value(&manifest).unwrap();
        unknown["unexpected"] = serde_json::json!(true);
        let encoded = serde_json::to_vec(&unknown).unwrap();
        assert!(Manifest::decode(&encoded, &hash(&encoded)).is_err());
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let destination = root.join("destination");
        symlink(&outside, &destination).unwrap();
        assert!(
            restore_and_verify(
                &destination,
                &binding,
                &manifest.sha256().unwrap(),
                transport.as_ref(),
                None
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        symlink(&outside, data.join("linked")).unwrap();
        assert_eq!(
            capture_manifest(&data, &binding).await.unwrap_err(),
            "snapshot_unsupported_file"
        );
        std::fs::remove_file(data.join("linked")).unwrap();
        let fifo = CString::new(data.join("fifo").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            capture_manifest(&data, &binding).await.unwrap_err(),
            "snapshot_unsupported_file"
        );
        std::fs::remove_file(data.join("fifo")).unwrap();
        let populated = root.join("populated");
        std::fs::create_dir(&populated).unwrap();
        std::fs::write(populated.join("keep"), b"untouched").unwrap();
        assert_eq!(
            restore_and_verify(
                &populated,
                &binding,
                &manifest.sha256().unwrap(),
                transport.as_ref(),
                None
            )
            .await
            .unwrap_err(),
            "snapshot_destination_not_empty"
        );
        assert_eq!(std::fs::read(populated.join("keep")).unwrap(), b"untouched");
        std::fs::remove_dir_all(root).unwrap();
    }

    struct Mutating {
        inner: Arc<dyn Transport>,
        path: PathBuf,
        changed: AtomicBool,
    }
    impl Transport for Mutating {
        fn put_manifest<'a>(&'a self, bytes: &'a [u8], sha: &'a str) -> Transfer<'a, ()> {
            self.inner.put_manifest(bytes, sha)
        }
        fn get_manifest(&self) -> Transfer<'_, Vec<u8>> {
            self.inner.get_manifest()
        }
        fn put_chunk<'a>(&'a self, index: u32, bytes: &'a [u8], sha: &'a str) -> Transfer<'a, ()> {
            Box::pin(async move {
                self.inner.put_chunk(index, bytes, sha).await?;
                if !self.changed.swap(true, Ordering::SeqCst) {
                    std::fs::write(&self.path, b"source changed after first chunk").unwrap();
                }
                Ok(())
            })
        }
        fn get_chunk(&self, index: u32) -> Transfer<'_, Vec<u8>> {
            self.inner.get_chunk(index)
        }
        fn seal<'a>(&'a self, manifest_sha256: &'a str) -> Transfer<'a, ()> {
            self.inner.seal(manifest_sha256)
        }
    }
    #[tokio::test]
    async fn a_changed_source_cannot_seal_a_snapshot() {
        let (root, binding) = fixture("cs-changed");
        let data = root.join("source");
        let store = MemoryStore::default();
        let inner = store.operation(&binding.operation);
        let transport = Mutating {
            inner: inner.clone(),
            path: data.join("base/1/100"),
            changed: AtomicBool::new(false),
        };
        assert_eq!(
            capture_and_upload(&data, &binding, &transport)
                .await
                .unwrap_err(),
            "snapshot_source_changed"
        );
        assert!(inner.get_manifest().await.is_err());
        assert!(data.join("global/pg_control").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn later_timelines_require_their_nonempty_history_before_capture_or_restore() {
        let (root, mut binding) = fixture("cs-history");
        let data = root.join("source");
        let mut control = std::fs::read(data.join("global/pg_control")).unwrap();
        control[48..52].copy_from_slice(&2u32.to_le_bytes());
        std::fs::write(data.join("global/pg_control"), control).unwrap();
        binding.end.timeline = 2;
        binding.end.last_archived_segment = "000000020000000000000001".into();
        let store = MemoryStore::default();
        let transport = store.operation(&binding.operation);
        assert_eq!(
            capture_and_upload(&data, &binding, transport.as_ref())
                .await
                .unwrap_err(),
            "snapshot_timeline_history_missing"
        );
        assert_eq!(store.writes(&binding.operation), 0);
        let history = data.join("pg_wal/00000002.history");
        std::fs::write(&history, []).unwrap();
        assert_eq!(
            capture_manifest(&data, &binding).await.unwrap_err(),
            "snapshot_timeline_history_missing"
        );
        std::fs::write(&history, b"1\t0/1000000\tcomplete parent timeline\n").unwrap();
        let manifest = capture_and_upload(&data, &binding, transport.as_ref())
            .await
            .unwrap();
        let target = root.join("restored");
        restore_and_verify(
            &target,
            &binding,
            &manifest.sha256().unwrap(),
            transport.as_ref(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(&history).unwrap(),
            std::fs::read(target.join("pg_wal/00000002.history")).unwrap()
        );
        let mut incomplete = manifest.clone();
        let file = incomplete
            .files
            .iter_mut()
            .find(|file| file.path == "pg_wal/00000002.history")
            .unwrap();
        // Even a structurally complete, correctly hashed manifest cannot replace its required
        // current history with an unrelated filename.
        file.path = "pg_wal/00000003.history".into();
        assert!(incomplete.validate().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_real_clean_snapshot_preserves_logged_and_unlogged_rows_and_sequence_values() {
        use crate::testpg::Cluster;
        let Some(source) = Cluster::create("cs-source") else {
            return;
        };
        source.start();
        let session = source.agent().await;
        session.batch("CREATE TABLE stable(id integer); INSERT INTO stable VALUES(42); CREATE UNLOGGED TABLE volatile(id bigint GENERATED ALWAYS AS IDENTITY, payload text); INSERT INTO volatile(payload) VALUES('retained'); CHECKPOINT").await.unwrap();
        drop(session);
        source.stop();
        let bytes = std::fs::read(source.data().join("global/pg_control")).unwrap();
        let control = pg_control::parse_control_file(&bytes).unwrap();
        let binding = binding(ProvenSleepRecord {
            system_identifier: control.control.system_identifier.clone(),
            timeline: control.control.timeline,
            checkpoint_lsn: pg_control::Lsn(control.checkpoint).to_string(),
            last_archived_segment: format!("{:08X}0000000000000001", control.control.timeline),
            proven_at: "2026-11-06T00:00:00.000Z".into(),
        });
        let store = MemoryStore::default();
        let transport = store.operation(&binding.operation);
        let manifest = capture_and_upload(&source.data(), &binding, transport.as_ref())
            .await
            .unwrap();
        assert!(
            manifest.chunks.len() < 100,
            "{} chunks",
            manifest.chunks.len()
        );
        let target = Cluster::create("cs-target").unwrap();
        std::fs::remove_dir_all(target.data()).unwrap();
        restore_and_verify(
            &target.data(),
            &binding,
            &manifest.sha256().unwrap(),
            transport.as_ref(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read(target.data().join("global/pg_control")).unwrap(),
            bytes
        );
        target.configure(256, None);
        target.start();
        let session = target.agent().await;
        let row=session.query("SELECT (SELECT count(*) FROM stable),(SELECT count(*) FROM volatile),pg_is_in_recovery()",&[]).await.unwrap();
        assert_eq!(row[0].get::<_, i64>(0), 1);
        assert_eq!(row[0].get::<_, i64>(1), 1);
        assert!(!row[0].get::<_, bool>(2));
        let row = session
            .query(
                "INSERT INTO volatile(payload) VALUES('next') RETURNING id",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(row[0].get::<_, i64>(0), 2);
        let row=session.query("SELECT system_identifier::text,(SELECT timeline_id FROM pg_control_checkpoint()) FROM pg_control_system()",&[]).await.unwrap();
        assert_eq!(
            row[0].get::<_, String>(0),
            control.control.system_identifier
        );
        assert_eq!(row[0].get::<_, i32>(1) as u32, control.control.timeline);
    }
}
