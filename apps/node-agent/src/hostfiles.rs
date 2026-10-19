// SPDX-License-Identifier: Apache-2.0
//! Host files (plan 9.3): the files of the image that matter at run time and that a release
//! changes on a running node, without a new image: systemd units and their masks, and the
//! configuration of sshd, journald, sysctl, tmpfiles, sysusers and modprobe. The release lists
//! them with a digest and how each takes effect, and the release key signs the list
//! (`update::Release::manifest`), so by the time anything here runs the list is as CI made it. The
//! agent still holds it to its own rules before a root write:
//!
//! - a path is one of the allow-listed directories and a plain name in it: no `..`, no further
//!   directory, no name that starts with a dot;
//! - a file has the mode 0644 or 0755 and is owned by the agent's user (root on a node), a link is
//!   a link to `/dev/null` and nothing else;
//! - a directory on the way is never a link, and a file is never written through one.
//!
//! A file is written whole or not at all: a hidden file beside it is written and synced, renamed
//! over it, and the directory is synced. What the agent may touch is only what it recorded:
//! `State::owned` is written before the first file, so a crash at any point leaves a record that
//! covers every path that may have been changed, and the next start applies the list again. How a
//! file takes effect is recorded the same way before it is written (`State::reload`,
//! `State::runs`, `State::restarts`), so a crash between the write and the restart still ends in
//! the restart. The caller (`service`) does the systemd side: one reload, then the runs of
//! `systemd-sysusers` and `systemd-tmpfiles` on the files that say so, then the restarts, the
//! agent's own last.
//!
//! The agent's own unit is the one file that is not trusted when it is written: a unit that cannot
//! start leaves the node with no link, no wake and no archive until someone with a shell reaches
//! it, so the new unit is written to `/run/systemd/system`, which systemd reads before
//! `/usr/lib/systemd/system` and which a boot empties. The agent that starts under it moves it to
//! its place only once it has run far enough to read the first page (`promote`); a node that
//! cannot start it is restarted from the API and runs the unit it had.
use crate::{link::file::write_private, node_link::constant};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    ffi::{CStr, CString},
    fmt::Write as _,
    fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
        unix::fs::PermissionsExt,
    },
    path::{Path, PathBuf},
};

/// The kinds of host file (`HOST_FILE_KINDS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    #[serde(rename = "file")]
    File,
    /// A symbolic link to `/dev/null`: a unit's mask.
    #[serde(rename = "symlink-to-dev-null")]
    Mask,
}

/// What the page says of one host file (`HostFile` of the contract). The values are kept as the
/// page gave them, so that `check` can refuse each by its class.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HostFile {
    pub path: String,
    pub kind: Kind,
    /// `0644` or `0755`; empty for a mask.
    #[serde(default)]
    pub mode: String,
    /// The sha256 of the bytes, lower-case hex; empty for a mask.
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    /// `daemon_reload`, `next_start`, `sysusers`, `tmpfiles` or `restart_unit:<unit>`.
    pub apply: String,
}

/// What the agent does with a file besides writing it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Apply<'a> {
    DaemonReload,
    NextStart,
    /// `systemd-sysusers <file>`.
    Sysusers,
    /// `systemd-tmpfiles --create <file>`.
    Tmpfiles,
    RestartUnit(&'a str),
}

/// The agent's own unit: restarted last, by the agent leaving.
pub const AGENT_UNIT: &str = "pgcf-agent.service";

impl HostFile {
    /// A host file of a page that passed the contract's schema; `None` for any other shape.
    pub fn parse(value: &Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    pub fn apply(&self) -> Option<Apply<'_>> {
        match self.apply.as_str() {
            "daemon_reload" => Some(Apply::DaemonReload),
            "next_start" => Some(Apply::NextStart),
            "sysusers" => Some(Apply::Sysusers),
            "tmpfiles" => Some(Apply::Tmpfiles),
            other => other.strip_prefix("restart_unit:").map(Apply::RestartUnit),
        }
    }

    /// What can be told of the file by looking at it (`hostFileFacts` of the contract): the path,
    /// the kind, the mode and the digest and size of the bytes, `-` for a mask.
    pub fn facts(&self) -> String {
        match self.kind {
            Kind::File => format!(
                "{} file {} {}:{}",
                self.path, self.mode, self.sha256, self.size_bytes
            ),
            Kind::Mask => format!("{} symlink-to-dev-null - -", self.path),
        }
    }

    /// The line of the signed manifest (`hostFileLine`): the facts and how it takes effect.
    pub fn line(&self) -> String {
        format!("{} {}", self.facts(), self.apply)
    }

    fn mode_bits(&self) -> u32 {
        u32::from_str_radix(&self.mode, 8).unwrap_or(0)
    }
}

/// Why the agent does not write a release's host files: the codes are the contract's
/// `RELEASE_REFUSALS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A directory or name that is not allowed.
    Path,
    /// A mode that is neither 0644 nor 0755.
    Mode,
    /// A way to take effect the agent does not know.
    Apply,
    /// The list or an entry is malformed: empty, too long, not ascending, a path twice, a digest
    /// or size that is none, a mask that states facts of a file.
    Invalid,
}
impl Refusal {
    pub const ALL: [Self; 4] = [Self::Path, Self::Mode, Self::Apply, Self::Invalid];
    pub const fn code(self) -> &'static str {
        match self {
            Self::Path => "host_file_path_refused",
            Self::Mode => "host_file_mode_refused",
            Self::Apply => "host_file_apply_refused",
            Self::Invalid => "host_files_invalid",
        }
    }
}

fn strings(name: &str) -> impl Iterator<Item = &'static str> {
    constant(name)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

/// Whether `path` is an allow-listed directory and a plain name in it (`HOST_FILE_DIRECTORIES`).
fn path_allowed(path: &str) -> bool {
    let Some((directory, name)) = path.rsplit_once('/') else {
        return false;
    };
    let plain = |b: u8| b.is_ascii_alphanumeric() || matches!(b, b'@' | b'.' | b'_' | b'+' | b'-');
    strings("HOST_FILE_DIRECTORIES").any(|allowed| allowed == directory)
        && (1..=128).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.bytes().all(plain)
}

fn lower_hex(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The agent's own rules for a release's host files (`RELEASE_REFUSALS`), applied to what the
/// signature already covers. The first broken rule is the class.
pub fn check(files: &[HostFile]) -> Result<(), Refusal> {
    let bound = constant("HOST_FILES_MAX").as_u64().unwrap_or(0) as usize;
    if files.is_empty() || files.len() > bound {
        return Err(Refusal::Invalid);
    }
    if files.windows(2).any(|pair| pair[0].path >= pair[1].path) {
        return Err(Refusal::Invalid);
    }
    let largest = constant("HOST_FILE_MAX_BYTES").as_u64().unwrap_or(0);
    for file in files {
        if !path_allowed(&file.path) {
            return Err(Refusal::Path);
        }
        match file.kind {
            Kind::File => {
                if !strings("HOST_FILE_MODES").any(|mode| mode == file.mode) {
                    return Err(Refusal::Mode);
                }
                if !lower_hex(&file.sha256, 64) || file.size_bytes > largest {
                    return Err(Refusal::Invalid);
                }
            }
            Kind::Mask => {
                if !file.mode.is_empty() || !file.sha256.is_empty() || file.size_bytes != 0 {
                    return Err(Refusal::Invalid);
                }
            }
        }
        if !strings("HOST_FILE_APPLIES").any(|apply| apply == file.apply) {
            return Err(Refusal::Apply);
        }
    }
    Ok(())
}

/// The digest of a list (`hostFilesSha256` of the contract): sha256 over the facts of each file,
/// one line each ended by a line feed, in the list's order.
pub fn list_digest(files: &[HostFile]) -> String {
    let mut digest = Sha256::new();
    for file in files {
        digest.update(file.facts().as_bytes());
        digest.update(b"\n");
    }
    crate::update::hex(&digest.finalize())
}

// ---- the files of the disk, below a root

/// What a path holds now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Installed {
    Absent,
    File {
        mode: u32,
        sha256: String,
        size_bytes: u64,
        /// The file belongs to the agent's user (root on a node), as the agent makes it.
        ours: bool,
    },
    Mask,
    /// A directory, a link elsewhere, a device: nothing the agent wrote.
    Other,
}

fn cstring(name: &str) -> io::Result<CString> {
    CString::new(name).map_err(|_| io::ErrorKind::InvalidInput.into())
}
fn check_call(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}
fn owned(fd: libc::c_int) -> OwnedFd {
    // SAFETY: `fd` was just returned by a successful `openat` and nobody else holds it.
    unsafe { OwnedFd::from_raw_fd(fd) }
}

/// The directory `name` of `parent`, never through a link.
fn open_directory(parent: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: a plain syscall with a NUL-terminated name.
    let fd = check_call(unsafe { libc::openat(parent, name.as_ptr(), flags) })?;
    Ok(owned(fd))
}

fn sync_fd(fd: RawFd) -> io::Result<()> {
    // SAFETY: a plain syscall on an open descriptor.
    check_call(unsafe { libc::fsync(fd) }).map(drop)
}

/// The directory that holds `path`, opened component by component from the root without ever
/// following a link, and the file's name in it. `create` makes the last directory if it is
/// missing (an allow-listed directory a package of the image does not make).
fn open_parent(root: &Path, path: &str, create: bool) -> io::Result<(OwnedFd, CString)> {
    let (directory, name) = path.rsplit_once('/').ok_or(io::ErrorKind::InvalidInput)?;
    let components: Vec<&str> = directory.split('/').filter(|c| !c.is_empty()).collect();
    let root_directory = fs::File::open(root)?;
    if !root_directory.metadata()?.is_dir() {
        return Err(io::ErrorKind::NotADirectory.into());
    }
    let mut current: OwnedFd = root_directory.into();
    for (at, component) in components.iter().enumerate() {
        let name = cstring(component)?;
        let next = match open_directory(current.as_raw_fd(), &name) {
            Ok(next) => next,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    && create
                    && at + 1 == components.len() =>
            {
                // SAFETY: a plain syscall with a NUL-terminated name.
                check_call(unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o755) })?;
                sync_fd(current.as_raw_fd())?;
                open_directory(current.as_raw_fd(), &name)?
            }
            Err(error) => return Err(directory_error(error)),
        };
        current = next;
    }
    Ok((current, cstring(name)?))
}

/// A directory on the way that is a link or a file: said in plain words, as the class of the
/// event (`diagnostics::phrase`).
fn directory_error(error: io::Error) -> io::Error {
    match error.raw_os_error() {
        Some(code) if code == libc::ELOOP || code == libc::ENOTDIR => {
            io::Error::other("a link or a file stands where a directory belongs")
        }
        _ => error,
    }
}

fn status(directory: RawFd, name: &CStr) -> io::Result<Option<libc::stat>> {
    // SAFETY: `stat` is plain data that `fstatat` fills in; the name is NUL-terminated.
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let result = unsafe {
        libc::fstatat(
            directory,
            name.as_ptr(),
            &raw mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result < 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(stat))
}

fn read_link(directory: RawFd, name: &CStr) -> io::Result<Vec<u8>> {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is as long as the length given, the name is NUL-terminated.
    let length = check_call(unsafe {
        libc::readlinkat(
            directory,
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        ) as libc::c_int
    })?;
    Ok(buffer[..length as usize].to_vec())
}

/// The most a host file may hold (`HOST_FILE_MAX_BYTES`): a file is read no further.
fn largest() -> u64 {
    constant("HOST_FILE_MAX_BYTES").as_u64().unwrap_or(0)
}

fn inspect_at(directory: RawFd, name: &CStr) -> io::Result<Installed> {
    let largest = largest();
    let Some(stat) = status(directory, name)? else {
        return Ok(Installed::Absent);
    };
    match stat.st_mode & libc::S_IFMT {
        libc::S_IFLNK => Ok(if read_link(directory, name)? == b"/dev/null" {
            Installed::Mask
        } else {
            Installed::Other
        }),
        libc::S_IFREG => {
            let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            // SAFETY: a plain syscall with a NUL-terminated name.
            let fd = check_call(unsafe { libc::openat(directory, name.as_ptr(), flags) })?;
            let mut file = fs::File::from(owned(fd));
            let mut bytes = Vec::new();
            (&mut file).take(largest + 1).read_to_end(&mut bytes)?;
            // SAFETY: a plain syscall.
            let euid = unsafe { libc::geteuid() };
            Ok(Installed::File {
                // `st_mode` is a `u16` on some targets.
                #[allow(clippy::unnecessary_cast)]
                mode: stat.st_mode as u32 & 0o7777,
                sha256: crate::update::hex(&Sha256::digest(&bytes)),
                size_bytes: bytes.len() as u64,
                ours: stat.st_uid == euid,
            })
        }
        _ => Ok(Installed::Other),
    }
}

/// What `path` holds now, below `root` (`/` on a node), read without following a link.
pub fn inspect(root: &Path, path: &str) -> io::Result<Installed> {
    let (directory, name) = match open_parent(root, path, false) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Installed::Absent),
        Err(error) => return Err(error),
    };
    inspect_at(directory.as_raw_fd(), &name)
}

/// Whether the disk already holds what the list says of `file`.
fn holds(installed: &Installed, file: &HostFile) -> bool {
    match (installed, file.kind) {
        (Installed::Mask, Kind::Mask) => true,
        (
            Installed::File {
                mode,
                sha256,
                size_bytes,
                ours,
            },
            Kind::File,
        ) => {
            *ours
                && *mode == file.mode_bits()
                && *sha256 == file.sha256
                && *size_bytes == file.size_bytes
        }
        _ => false,
    }
}

/// The points between the steps of placing one file, where a crash may come. The caller of
/// `place` is told after each; production lets them all pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    /// The hidden file (or link) beside the target is made.
    Created,
    /// Its bytes are written and its mode set.
    Written,
    /// The file is on the disk.
    Synced,
    /// It has replaced the target.
    Renamed,
    /// The directory entry is on the disk.
    DirectorySynced,
}

/// The name of the hidden file beside `name`.
fn partial_name(name: &CStr) -> io::Result<CString> {
    let mut text = Vec::from(b".".as_slice());
    text.extend_from_slice(name.to_bytes());
    text.extend_from_slice(b".pgcf-new");
    CString::new(text).map_err(|_| io::ErrorKind::InvalidInput.into())
}

fn unlink(directory: RawFd, name: &CStr) -> io::Result<()> {
    // SAFETY: a plain syscall with a NUL-terminated name.
    match check_call(unsafe { libc::unlinkat(directory, name.as_ptr(), 0) }) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Writes `file` below `root`: a file with `bytes` and its mode, or the mask. A hidden file beside
/// the target is made, written, synced and renamed over it, and the directory is synced; a reader
/// sees the old target or the new one, never a part. A link or a file that stands at the target is
/// replaced and never followed; a directory is refused. A partial file an earlier call left is
/// removed first. `crash` is told after each step (`Step`) and may fail the call.
pub fn place(
    root: &Path,
    file: &HostFile,
    bytes: &[u8],
    crash: &mut dyn FnMut(Step) -> io::Result<()>,
) -> io::Result<()> {
    let (directory, name) = open_parent(root, &file.path, true)?;
    let fd = directory.as_raw_fd();
    // A file, a link or anything else at the target is replaced by the rename and never followed;
    // a directory is not the agent's to replace.
    if status(fd, &name)?.is_some_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFDIR) {
        return Err(io::Error::other(
            "a directory stands where a host file belongs",
        ));
    }
    let partial = partial_name(&name)?;
    unlink(fd, &partial)?;
    match file.kind {
        Kind::File => {
            let flags =
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            // SAFETY: a plain syscall with a NUL-terminated name.
            let made = check_call(unsafe { libc::openat(fd, partial.as_ptr(), flags, 0o600) })?;
            let mut target = fs::File::from(owned(made));
            crash(Step::Created)?;
            target.write_all(bytes)?;
            target.set_permissions(fs::Permissions::from_mode(file.mode_bits()))?;
            crash(Step::Written)?;
            target.sync_all()?;
            crash(Step::Synced)?;
        }
        Kind::Mask => {
            let to = cstring("/dev/null")?;
            // SAFETY: a plain syscall with NUL-terminated names.
            check_call(unsafe { libc::symlinkat(to.as_ptr(), fd, partial.as_ptr()) })?;
            crash(Step::Created)?;
            crash(Step::Written)?;
            crash(Step::Synced)?;
        }
    }
    // SAFETY: a plain syscall with NUL-terminated names in one directory.
    check_call(unsafe { libc::renameat(fd, partial.as_ptr(), fd, name.as_ptr()) })?;
    crash(Step::Renamed)?;
    sync_fd(fd)?;
    crash(Step::DirectorySynced)
}

/// Removes a file or a mask; a directory or anything else is left alone. The caller names only a
/// path an earlier list named, which the agent wrote or the image brought: both are the list's.
fn remove(root: &Path, path: &str) -> io::Result<bool> {
    let (directory, name) = match open_parent(root, path, false) {
        Ok(parent) => parent,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    let fd = directory.as_raw_fd();
    match inspect_at(fd, &name)? {
        Installed::File { .. } | Installed::Mask => {
            unlink(fd, &name)?;
            sync_fd(fd)?;
            Ok(true)
        }
        Installed::Absent | Installed::Other => Ok(false),
    }
}

// ---- the agent's own unit

/// Where systemd reads units that last until the next boot. It reads this directory before the
/// image's (`/usr/lib/systemd/system`), so a unit here wins over the file of the same name there.
pub const RUNTIME_UNITS: &str = "/run/systemd/system";

/// The agent's unit as the image keeps it, which the list names.
fn agent_unit_path() -> String {
    format!("/usr/lib/systemd/system/{AGENT_UNIT}")
}
/// Where the new agent unit stands until the agent that runs it has proven itself.
pub fn runtime_agent_unit() -> String {
    format!("{RUNTIME_UNITS}/{AGENT_UNIT}")
}
/// Whether `file` is the agent's own unit in the image's directory: the one file that is written
/// to the runtime directory first and moves to its place with `promote`.
fn staged(file: &HostFile) -> bool {
    file.kind == Kind::File && file.path == agent_unit_path()
}

// ---- what the agent keeps

/// A tool of systemd that the agent runs on a file, once the units are read again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Tool {
    /// `systemd-sysusers <file>`: the users and groups the file lists.
    #[serde(rename = "sysusers")]
    Sysusers,
    /// `systemd-tmpfiles --create <file>`: the directories and files it lists.
    #[serde(rename = "tmpfiles")]
    Tmpfiles,
}

/// A run of a tool on a file. The users come before the directories that may name them.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Run {
    pub tool: Tool,
    pub path: String,
}

/// What the agent records of its host files, in `agent/host-files.json` (0600).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// The release whose list was last applied whole.
    pub release: String,
    /// Every path the agent may change: those of the list it applied and those it began to apply.
    /// A file that is not here is never removed.
    pub owned: Vec<String>,
    /// The list last applied whole.
    pub files: Vec<HostFile>,
    /// The boot during which `reload` and `restarts` were recorded: a boot reads every unit again
    /// and starts each with its file, so what is left of them for an earlier boot is moot.
    #[serde(default)]
    pub boot_id: String,
    /// systemd has to read its units again.
    #[serde(default)]
    pub reload: bool,
    /// Units to restart once it has; the agent's own is last.
    #[serde(default)]
    pub restarts: Vec<String>,
    /// Tools to run once it has, before any restart. A boot does not do these (systemd makes users
    /// at a boot only when /usr is newer than /etc/.updated), so they stay until they have run.
    #[serde(default)]
    pub runs: Vec<Run>,
}

impl State {
    /// The state kept at `path`: nothing recorded where there is no file or it is not ours.
    pub fn load(path: &Path) -> Self {
        fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_private(path, &serde_json::to_vec(self).map_err(io::Error::other)?)
    }

    /// Enters the boot `boot_id`: a reload and restarts of an earlier boot are dropped, because
    /// the boot read every unit again and started each with its file.
    pub fn begin(&mut self, boot_id: &str) {
        if self.boot_id != boot_id {
            self.reload = false;
            self.restarts.clear();
            self.boot_id = boot_id.to_string();
        }
    }

    /// Whether systemd has still to be told what an earlier apply began, in the boot `boot_id`.
    /// The node does not hold its release's files meanwhile: it runs the old definition.
    pub fn unfinished(&self, boot_id: &str) -> bool {
        !self.runs.is_empty()
            || (self.boot_id == boot_id && (self.reload || !self.restarts.is_empty()))
    }
}

/// What differs between the disk and a release's list.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// The files the disk does not hold as listed.
    pub writes: Vec<HostFile>,
    /// The paths of files the agent wrote for a list before and this one drops.
    pub removals: Vec<String>,
    /// The agent's unit stands in the runtime directory as the list has it and the image's file is
    /// another: the agent that runs it moves it with `promote`, once it has proven itself.
    pub staged: Option<HostFile>,
    /// A copy of the agent's unit in the runtime directory that the image's file has made of no
    /// use, or that is not the list's: removed, which a reload then makes known.
    pub unstage: bool,
}
impl Plan {
    pub fn is_empty(&self) -> bool {
        self.writes.is_empty() && self.removals.is_empty() && !self.unstage
    }
}

/// Compares the disk with the list: every file whose installed content, mode, owner or kind
/// differs is a write, and every path the agent owns that the list no longer names and that still
/// holds a file or a mask is a removal. The agent's own unit counts as held where it stands in the
/// runtime directory (`Plan::staged`); it is a write to that directory when it stands nowhere.
pub fn plan(root: &Path, state: &State, files: &[HostFile]) -> io::Result<Plan> {
    let mut plan = Plan::default();
    for file in files {
        let image = holds(&inspect(root, &file.path)?, file);
        if !staged(file) {
            if !image {
                plan.writes.push(file.clone());
            }
            continue;
        }
        let runtime = inspect(root, &runtime_agent_unit())?;
        match (image, holds(&runtime, file), runtime != Installed::Absent) {
            (true, _, present) => plan.unstage |= present,
            (false, true, _) => plan.staged = Some(file.clone()),
            (false, false, _) => plan.writes.push(file.clone()),
        }
    }
    let named: BTreeSet<&str> = files.iter().map(|file| file.path.as_str()).collect();
    for path in &state.owned {
        if !named.contains(path.as_str())
            && matches!(
                inspect(root, path)?,
                Installed::File { .. } | Installed::Mask
            )
        {
            plan.removals.push(path.clone());
        }
    }
    Ok(plan)
}

/// What an apply did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Applied {
    pub written: usize,
    pub removed: usize,
}

/// Where and when an apply happens: the root the files are below (`/` on a node), the file the
/// agent keeps its record in, and the boot, which says what of the record still counts.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub root: &'a Path,
    pub state: &'a Path,
    pub boot_id: &'a str,
}

/// Applies the list: the record of what may change and of how each change takes effect is saved
/// first, then each file is written (`bytes` holds the content of every file with content that
/// `plan` found missing, by digest; the agent's own unit goes to the runtime directory), then what
/// the list dropped is removed, then the list is recorded as applied. `crash` is told after each
/// step of each file, and after each removal as `Step::DirectorySynced`. A failure stops the apply
/// where it is; calling it again finishes it.
pub fn apply(
    target: &Target,
    release: &str,
    files: &[HostFile],
    plan: &Plan,
    bytes: &HashMap<String, Vec<u8>>,
    crash: &mut dyn FnMut(Step) -> io::Result<()>,
) -> io::Result<Applied> {
    let Target {
        root,
        state: state_path,
        boot_id,
    } = *target;
    let mut state = State::load(state_path);
    state.begin(boot_id);
    // Before the first file: every path that may change, and how each change takes effect, so
    // that a crash anywhere in the writes leaves the work to the next start.
    let mut owned: BTreeSet<String> = state.owned.iter().cloned().collect();
    owned.extend(files.iter().map(|file| file.path.clone()));
    state.owned = owned.into_iter().collect();
    if !plan.is_empty() {
        state.reload = true;
    }
    let mut restarts: BTreeSet<String> = state.restarts.iter().cloned().collect();
    let mut runs: BTreeSet<Run> = state.runs.iter().cloned().collect();
    for file in &plan.writes {
        match file.apply() {
            Some(Apply::RestartUnit(unit)) => {
                restarts.insert(unit.to_string());
            }
            Some(Apply::Sysusers) => {
                runs.insert(Run {
                    tool: Tool::Sysusers,
                    path: file.path.clone(),
                });
            }
            Some(Apply::Tmpfiles) => {
                runs.insert(Run {
                    tool: Tool::Tmpfiles,
                    path: file.path.clone(),
                });
            }
            _ => {}
        }
    }
    // A file the list drops is gone from the disk, and what runs on it keeps the setting it had
    // until it restarts: the way the dropped file took effect is the one it was applied with.
    for path in &plan.removals {
        if let Some(Apply::RestartUnit(unit)) = state
            .files
            .iter()
            .find(|file| file.path == *path)
            .and_then(HostFile::apply)
        {
            restarts.insert(unit.to_string());
        }
    }
    // A copy of the agent's unit that goes was the definition the running agent started with: it
    // restarts to run the unit of the image.
    if plan.unstage {
        restarts.insert(AGENT_UNIT.to_string());
    }
    state.restarts = restarts.into_iter().collect();
    state.runs = runs.into_iter().collect();
    state.save(state_path)?;

    for file in &plan.writes {
        let content: &[u8] = match file.kind {
            Kind::File => bytes
                .get(&file.sha256)
                .map(Vec::as_slice)
                .ok_or_else(|| io::Error::other("the bytes of a host file are missing"))?,
            Kind::Mask => &[],
        };
        if staged(file) {
            let runtime = HostFile {
                path: runtime_agent_unit(),
                ..file.clone()
            };
            place(root, &runtime, content, crash)?;
        } else {
            place(root, file, content, crash)?;
        }
    }
    for path in &plan.removals {
        remove(root, path)?;
        crash(Step::DirectorySynced)?;
    }
    if plan.unstage {
        remove(root, &runtime_agent_unit())?;
        crash(Step::DirectorySynced)?;
    }

    state.release = release.to_string();
    state.owned = files.iter().map(|file| file.path.clone()).collect();
    state.files = files.to_vec();
    state.save(state_path)?;
    Ok(Applied {
        written: plan.writes.len(),
        removed: plan.removals.len(),
    })
}

/// The bytes of the file at `path` below `root`, read without following a link, no more than a
/// host file may hold.
fn read_file(root: &Path, path: &str) -> io::Result<Vec<u8>> {
    let (directory, name) = open_parent(root, path, false)?;
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: a plain syscall with a NUL-terminated name.
    let fd = check_call(unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) })?;
    let mut bytes = Vec::new();
    fs::File::from(owned(fd))
        .take(largest() + 1)
        .read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Moves the agent's unit from the runtime directory to its place in the image's, once the agent
/// that runs the runtime copy has read its first page: the unit started, so it may stay through a
/// boot. The reload that follows (recorded first) makes systemd read the file of the image and let
/// go of the copy; the definition is the same, so nothing restarts. A crash between the steps is
/// finished by the next call (`plan`), and the runtime copy goes last.
pub fn promote(
    target: &Target,
    file: &HostFile,
    crash: &mut dyn FnMut(Step) -> io::Result<()>,
) -> io::Result<()> {
    let Target {
        root,
        state: state_path,
        boot_id,
    } = *target;
    let bytes = read_file(root, &runtime_agent_unit())?;
    if crate::update::hex(&Sha256::digest(&bytes)) != file.sha256 {
        return Err(io::Error::other(
            "the agent's unit in the runtime directory is not the one of the list",
        ));
    }
    let mut state = State::load(state_path);
    state.begin(boot_id);
    state.reload = true;
    state.save(state_path)?;
    place(root, file, &bytes, crash)?;
    remove(root, &runtime_agent_unit())?;
    crash(Step::DirectorySynced)
}

/// What the node reports in its hello (`NodeOs::host_files_sha256`): the digest of the facts of
/// the files of the last applied list, read from the disk now. It is the contract's digest of the
/// release's list exactly when the disk holds that list and systemd has been told everything of
/// it: while a reload, a restart or a run is still to do, the digest is another. A node that has
/// applied nothing reports the digest of no file at all.
pub fn observed_digest(root: &Path, state: &State, boot_id: &str) -> String {
    let mut digest = Sha256::new();
    for file in &state.files {
        let mut line = String::new();
        match inspect(root, &file.path) {
            Ok(Installed::File {
                mode,
                sha256,
                size_bytes,
                ..
            }) => {
                let _ = write!(line, "{} file {mode:04o} {sha256}:{size_bytes}", file.path);
            }
            Ok(Installed::Mask) => {
                let _ = write!(line, "{} symlink-to-dev-null - -", file.path);
            }
            Ok(Installed::Absent) => {
                let _ = write!(line, "{} absent", file.path);
            }
            Ok(Installed::Other) | Err(_) => {
                let _ = write!(line, "{} unreadable", file.path);
            }
        }
        digest.update(line.as_bytes());
        digest.update(b"\n");
    }
    if state.unfinished(boot_id) {
        digest.update(b"unfinished\n");
    }
    crate::update::hex(&digest.finalize())
}

/// Where the agent keeps its state of host files.
pub fn state_path(agent: &Path) -> PathBuf {
    agent.join("host-files.json")
}

/// The units a state still has to restart, other than the agent's, in the order they restart, and
/// whether the agent's own is among them.
pub fn restart_order(state: &State) -> (Vec<String>, bool) {
    let units: BTreeSet<&str> = state
        .restarts
        .iter()
        .map(String::as_str)
        .filter(|unit| *unit != AGENT_UNIT)
        .collect();
    (
        units.into_iter().map(String::from).collect(),
        state.restarts.iter().any(|unit| unit == AGENT_UNIT),
    )
}

#[cfg(test)]
mod tests;
