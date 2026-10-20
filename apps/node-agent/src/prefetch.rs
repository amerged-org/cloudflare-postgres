// SPDX-License-Identifier: Apache-2.0
//! Readahead of the files a database's first request reads (plan 11.2, package F).
//!
//! A database that slept for hours has had its pages evicted, and the login and the first
//! statements read them from the disk one random read at a time (EU1, 2026-10-20, p50 / p95: login
//! 66 / 133 ms and six statements 208 / 452 ms; with the catalogs read ahead the login took 23 ms,
//! and with the whole autoprewarm list resident the statements took 66 ms). The agent knows which
//! files those are before the request does. It asks the kernel to read them ahead with
//! `posix_fadvise(WILLNEED)`, in two sets:
//!
//! - **`catalog`**: `pg_control`, a window of the WAL at the latest checkpoint, `global/`, and in
//!   each user database (`base/<oid>`, oid 16384 and up) its `PG_VERSION`, its `pg_filenode.map`
//!   and the catalogs a login and a first statement read, with their indexes and forks. A catalog
//!   that PostgreSQL has rewritten (`VACUUM FULL`) lives at the file number the map names, not at
//!   its oid. About 5 MB, found without starting PostgreSQL.
//! - **`list`**: the blocks of `autoprewarm.blocks`, which PostgreSQL writes at each clean stop,
//!   merged where they are contiguous and ordered by the fewest listed blocks per relation first
//!   (catalogs, indexes and small tables before the one big heap), so that a time budget cuts off
//!   the heap's tail and nothing else.
//!
//! Both are two steps. Building the `Plan` reads the directories and a few small files and opens
//! each file once to learn its length (blocking: run it in `spawn_blocking`, and before the moment
//! it matters; it warms the dentries and inodes the issuing needs). `Plan::issue` advises the
//! kernel in pieces of `PIECE` and stops at a time budget, a byte bound or a cancel; it returns a
//! `Report` of counts and timings, which is the page cache accounting of a wake: it takes the place
//! of the residency diagnostic of `cache.rs`, which opens and lists files while the wake runs,
//! once a flow calls this module.
//!
//! The kernel reads at most `max(read_ahead_kb, the size asked)` of a range per `WILLNEED` call
//! (EU1: 128 KiB), so one call over a large range reads only its first part. The lab tool of
//! 2026-10-20 did that first; every call here covers at most `PIECE`.
//!
//! The data directory is the database user's, and the agent reads as root: a link at a directory
//! is not followed (checked when the plan lists it and again before its files are opened), a link
//! at a file is not opened (`O_NOFOLLOW`), a pipe or a device is not opened, every name below the
//! data directory is built from numbers PostgreSQL wrote, and the number of directory entries,
//! files, databases and bytes of `autoprewarm.blocks` read is bounded.
use crate::{
    cache,
    pg_control::{Lsn, parse_control_file},
    sleep::is_segment,
};
use std::{
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

/// The most one `posix_fadvise` call covers.
pub const PIECE: u64 = 128 << 10;
/// PostgreSQL's `BLCKSZ`, and the block size of the WAL (`XLOG_BLCKSZ`): the Debian build's.
const BLOCK: u64 = 8192;
/// Blocks in a segment file of a relation: `RELSEG_SIZE`, 1 GiB of `BLOCK`s.
const SEGMENT_BLOCKS: u64 = 131_072;
/// The WAL read from the latest checkpoint record.
const WAL_WINDOW: u64 = 256 << 10;
/// Files in a plan: a plan with more is cut off (a list names at most a few hundred).
const MAX_FILES: usize = 4096;
/// User databases whose catalogs the catalog set names.
const MAX_DATABASES: usize = 32;
/// `autoprewarm.blocks` read at most. A real list is at most one line per block of the shared
/// buffers, about 6 MB for 128 MiB of them.
const MAX_LIST_BYTES: u64 = 32 << 20;
/// Lines a list may name.
const MAX_LIST_BLOCKS: usize = 1 << 20;
/// `pg_control` (8 KiB) and `pg_filenode.map` (524 bytes) are read to this length at most.
const MAX_SMALL: u64 = 8192;
/// The first object ID of the user's own objects (`FirstNormalObjectId`): the databases below it
/// are `template1`, `template0` and `postgres`, which a request does not connect to.
const FIRST_USER_DATABASE: u32 = 16_384;
/// `DEFAULTTABLESPACE_OID` and `GLOBALTABLESPACE_OID`.
const DEFAULT_TABLESPACE: u32 = 1663;
const GLOBAL_TABLESPACE: u32 = 1664;
/// `RELMAPPER_FILEMAGIC`, and the mappings a map file holds at most (`MAX_MAPPINGS`).
const MAP_MAGIC: u32 = 0x59_2717;
const MAP_MAPPINGS: usize = 64;

/// The catalogs a login and a first statement read, each followed by its indexes (OIDs of
/// PostgreSQL 18; a test checks every one against a real cluster). The first is `pg_class`.
const CATALOGS: &[u32] = &[
    1259, 2662, 2663, 3455, // pg_class
    1249, 2658, 2659, // pg_attribute
    2610, 2678, 2679, // pg_index
    1247, 2703, 2704, // pg_type
    2615, 2684, 2685, // pg_namespace
    1255, 2690, 2691, // pg_proc
    2601, 2651, 2652, // pg_am
    2616, 2686, 2687, // pg_opclass
    2617, 2688, 2689, // pg_operator
    2602, 2653, 2654, 2756, // pg_amop
    2603, 2655, 2757, // pg_amproc
    2619, 2696, // pg_statistic
    2606, 2664, 2665, 2666, 2579, // pg_constraint
    2604, 2656, 2657, // pg_attrdef
    2618, 2692, 2693, // pg_rewrite
    2620, 2699, 2701, 2702, // pg_trigger
    2605, 2660, 2661, // pg_cast
    2224, 5002, // pg_sequence
    3256, 3257, 3258, // pg_policy
];
/// The forks of a catalog that exist: the main fork and the free-space and visibility maps.
const CATALOG_FORKS: [&str; 3] = ["", "_fsm", "_vm"];

/// A file to advise, with the byte ranges of it (`[from, to)`, ascending, inside its length when
/// the plan was made).
#[derive(Debug)]
struct Target {
    /// Index in `Plan::directories`.
    directory: usize,
    name: String,
    spans: Vec<(u64, u64)>,
}

/// What to read ahead, found without starting PostgreSQL.
#[derive(Debug)]
pub struct Plan {
    data: PathBuf,
    /// The directories of the targets, relative to the data directory.
    directories: Vec<PathBuf>,
    targets: Vec<Target>,
    /// The bytes of all spans.
    bytes: u64,
    /// Files that the plan named and that were not there (a list of an older database).
    missing: u64,
    plan_us: u64,
}

/// Why the autoprewarm list gives no plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unavailable {
    /// There is no list: the database never stopped cleanly, or autoprewarm is off.
    Missing,
    /// The file is no list this module reads: a link, a pipe, too large, or not in the format.
    Unreadable,
}
impl Unavailable {
    /// The name an event carries.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Missing => "list_missing",
            Self::Unreadable => "list_unreadable",
        }
    }
}

/// How far to go.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// From the call of `issue`; the first piece that would start after it is not issued.
    pub budget: Duration,
    /// Bytes advised, to the piece that reaches it.
    pub max_bytes: u64,
}

/// Why the issuing ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// Every piece of the plan was advised.
    Done,
    Budget,
    Bytes,
    Cancelled,
    /// The kernel refused an advice, or this system has none.
    Failed,
}
impl Stop {
    /// The name an event carries.
    pub fn name(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Budget => "budget",
            Self::Bytes => "bytes",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// What a plan and its issuing did: the counts and timings of an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Report {
    pub stop: Stop,
    /// Files the plan holds, and the bytes of their ranges.
    pub files: u64,
    pub planned_bytes: u64,
    /// Files that the plan named and found missing.
    pub missing: u64,
    /// Files that could not be opened when they were issued (gone, replaced by a link or a pipe,
    /// or below a directory that became a link).
    pub skipped: u64,
    /// `posix_fadvise` calls made and the bytes they covered.
    pub pieces: u64,
    pub issued_bytes: u64,
    /// Of the bytes advised, those that the page cache already held when the piece was issued;
    /// `None` where the kernel cannot say (before Linux 6.5, or another system).
    pub resident_bytes: Option<u64>,
    /// Building the plan, and the issuing, in microseconds.
    pub plan_us: u64,
    pub issue_us: u64,
}

/// What the kernel does with a piece. Production uses `Host`; a test brings a model of the
/// kernel's read-ahead.
trait Kernel {
    /// `posix_fadvise(WILLNEED)` for a range of a file.
    fn advise(&mut self, file: &File, offset: u64, length: u64) -> io::Result<()>;
    /// The pages of the range in the page cache.
    fn resident(&mut self, file: &File, offset: u64, length: u64) -> Option<u64>;
}

/// This machine's kernel.
struct Host;
#[cfg(target_os = "linux")]
impl Kernel for Host {
    fn advise(&mut self, file: &File, offset: u64, length: u64) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let invalid = |_| io::Error::from(io::ErrorKind::InvalidInput);
        let offset = libc::off_t::try_from(offset).map_err(invalid)?;
        let length = libc::off_t::try_from(length).map_err(invalid)?;
        // SAFETY: advice for an open descriptor and a range; the call touches no memory of ours.
        let error = unsafe {
            libc::posix_fadvise(file.as_raw_fd(), offset, length, libc::POSIX_FADV_WILLNEED)
        };
        if error == 0 {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(error))
        }
    }
    fn resident(&mut self, file: &File, offset: u64, length: u64) -> Option<u64> {
        cache::cachestat_range(file, offset, length)
            .ok()
            .map(|pages| pages.resident)
    }
}
/// Other systems have no `posix_fadvise` in `libc` and no `cachestat`: nothing is advised.
#[cfg(not(target_os = "linux"))]
impl Kernel for Host {
    fn advise(&mut self, _file: &File, _offset: u64, _length: u64) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
    fn resident(&mut self, _file: &File, _offset: u64, _length: u64) -> Option<u64> {
        None
    }
}

/// Whether `relative` below `data` is a directory all the way down, none of its parts a link.
fn real_directory(data: &Path, relative: &Path) -> bool {
    let mut path = data.to_path_buf();
    if !cache::is_directory(&path) {
        return false;
    }
    for part in relative.components() {
        path.push(part);
        if !cache::is_directory(&path) {
            return false;
        }
    }
    true
}

/// Up to `limit` bytes of a small file of the data directory.
fn read_small(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let file = cache::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

/// The catalogs that PostgreSQL has moved to a file number of their own, from a database's
/// `pg_filenode.map`: `(oid, file number)`.
#[derive(Debug, Default, PartialEq, Eq)]
struct FilenodeMap(Vec<(u32, u32)>);
impl FilenodeMap {
    /// `RelMapFile`: a magic number, the number of mappings, and that many `(oid, file number)`
    /// pairs, all 32-bit and little-endian here, then a checksum that is not checked (a damaged map
    /// misdirects a readahead and nothing else). A file of another shape is no map.
    fn parse(bytes: &[u8]) -> Option<Self> {
        let word = |at: usize| -> Option<u32> {
            Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
        };
        if word(0)? != MAP_MAGIC {
            return None;
        }
        let count = usize::try_from(word(4)?)
            .ok()
            .filter(|n| *n <= MAP_MAPPINGS)?;
        let mut mappings = Vec::with_capacity(count);
        for n in 0..count {
            mappings.push((word(8 + 8 * n)?, word(12 + 8 * n)?));
        }
        Some(Self(mappings))
    }
    /// The file number of a catalog: the map's where it has one, its oid otherwise.
    fn file_number(&self, oid: u32) -> u32 {
        self.0
            .iter()
            .find(|(mapped, number)| *mapped == oid && *number != 0)
            .map_or(oid, |(_, number)| *number)
    }
}

/// One line of `autoprewarm.blocks`, in the order of its fields so that sorting groups a
/// relation's blocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Block {
    database: u32,
    tablespace: u32,
    file_number: u32,
    fork: u8,
    block: u32,
}
impl Block {
    /// The blocks a request reads from the node's own layout: shared relations in `global/` and
    /// the user databases' relations in `base/<database>/`. A system database (a request does not
    /// connect to it) and another tablespace are left out.
    fn supported(&self) -> bool {
        (self.database == 0 && self.tablespace == GLOBAL_TABLESPACE)
            || (self.database >= FIRST_USER_DATABASE && self.tablespace == DEFAULT_TABLESPACE)
    }
    fn relation(&self) -> (u32, u32, u32, u8) {
        (self.database, self.tablespace, self.file_number, self.fork)
    }
}

/// A decimal number of the file: digits only, which `u32::from_str` would not insist on.
fn number(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `autoprewarm.blocks` of PostgreSQL 18: `<<N>>`, then N lines `database,tablespace,
/// filenumber,fork,block`. Anything else is no list: a line that does not parse, a fork above 3,
/// more or fewer lines than the header says, or more than `MAX_LIST_BLOCKS`.
fn parse_blocks(bytes: &[u8]) -> Option<Vec<Block>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    let count = lines
        .next()?
        .strip_prefix("<<")?
        .strip_suffix(">>")
        .and_then(|n| usize::try_from(number(n)?).ok())
        .filter(|n| *n <= MAX_LIST_BLOCKS)?;
    let mut blocks = Vec::with_capacity(count);
    for line in lines {
        let mut fields = line.split(',');
        let mut next = || number(fields.next()?);
        let block = Block {
            database: next()?,
            tablespace: next()?,
            file_number: next()?,
            fork: u8::try_from(next()?).ok().filter(|fork| *fork <= 3)?,
            block: next()?,
        };
        if fields.next().is_some() || blocks.len() == count {
            return None;
        }
        blocks.push(block);
    }
    (blocks.len() == count).then_some(blocks)
}

/// The name of a relation's file: `<file number>[_fsm|_vm|_init][.<segment>]`.
fn file_name(file_number: u32, fork: u8, segment: u64) -> String {
    let suffix = ["", "_fsm", "_vm", "_init"][usize::from(fork.min(3))];
    if segment == 0 {
        format!("{file_number}{suffix}")
    } else {
        format!("{file_number}{suffix}.{segment}")
    }
}

/// A directory of the data directory that a plan names.
struct Directory {
    relative: PathBuf,
    /// Whether it is a directory, none of its parts a link, when the plan named it.
    real: bool,
}

/// Whether a file was added to the plan.
enum Added {
    Planned,
    /// There is no such file, or nothing of it inside its length.
    Absent,
    /// The plan holds `MAX_FILES` files.
    Full,
}

/// A plan being made.
struct Builder {
    data: PathBuf,
    directories: Vec<Directory>,
    targets: Vec<Target>,
    bytes: u64,
    missing: u64,
}
impl Builder {
    fn new(data: &Path) -> Self {
        Self {
            data: data.to_path_buf(),
            directories: Vec::new(),
            targets: Vec::new(),
            bytes: 0,
            missing: 0,
        }
    }

    /// The index of the directory `relative` to the data directory; a link or a file in its
    /// place gives a directory that has no files.
    fn directory(&mut self, relative: &str) -> usize {
        let relative = PathBuf::from(relative);
        if let Some(found) = self.directories.iter().position(|d| d.relative == relative) {
            return found;
        }
        let real = real_directory(&self.data, &relative);
        self.directories.push(Directory { relative, real });
        self.directories.len() - 1
    }

    /// The path of a directory that is real.
    fn directory_path(&self, directory: usize) -> Option<PathBuf> {
        let directory = &self.directories[directory];
        directory.real.then(|| self.data.join(&directory.relative))
    }

    /// The path of a file of a directory that is real.
    fn path(&self, directory: usize, name: &str) -> Option<PathBuf> {
        self.directory_path(directory).map(|path| path.join(name))
    }

    /// The names in a directory that is real.
    fn names(&self, directory: usize) -> Vec<String> {
        self.directory_path(directory)
            .map(|path| cache::names(&path))
            .unwrap_or_default()
    }

    /// Adds a file of a directory, with `spans` (the whole file for `None`) cut to its length.
    /// The file is opened once, as the issuing will, which also warms its inode.
    fn add(&mut self, directory: usize, name: &str, spans: Option<&[(u64, u64)]>) -> Added {
        if self.targets.len() >= MAX_FILES {
            return Added::Full;
        }
        let Some(length) = self
            .path(directory, name)
            .and_then(|path| cache::open(&path).ok())
            .and_then(|file| file.metadata().ok())
            .map(|metadata| metadata.len())
        else {
            return Added::Absent;
        };
        let whole = [(0, length)];
        let spans: Vec<(u64, u64)> = spans
            .unwrap_or(&whole)
            .iter()
            .map(|(from, to)| (*from, (*to).min(length)))
            .filter(|(from, to)| from < to)
            .collect();
        if spans.is_empty() {
            return Added::Absent;
        }
        self.bytes += spans.iter().map(|(from, to)| to - from).sum::<u64>();
        self.targets.push(Target {
            directory,
            name: name.to_string(),
            spans,
        });
        Added::Planned
    }

    /// `pg_control` and the WAL at the latest checkpoint: what PostgreSQL reads first.
    fn control_and_wal(&mut self) {
        let global = self.directory("global");
        self.add(global, "pg_control", None);
        let Some(bytes) = self
            .path(global, "pg_control")
            .and_then(|path| read_small(&path, MAX_SMALL))
        else {
            return;
        };
        let Ok(control) = parse_control_file(&bytes) else {
            return;
        };
        let wal = self.directory("pg_wal");
        // Every segment has the size the cluster was made with.
        let segment_bytes = self
            .names(wal)
            .iter()
            .find(|name| is_segment(name))
            .and_then(|name| self.path(wal, name))
            .and_then(|path| cache::open(&path).ok())
            .and_then(|file| file.metadata().ok())
            .map(|metadata| metadata.len())
            .filter(|bytes| bytes.is_power_of_two() && (1 << 20..=1 << 30).contains(bytes));
        let Some(segment_bytes) = segment_bytes else {
            return;
        };
        let name = Lsn(control.checkpoint).segment(control.control.timeline, segment_bytes);
        let from = control.checkpoint % segment_bytes / BLOCK * BLOCK;
        self.add(
            wal,
            &name,
            Some(&[(from, (from + WAL_WINDOW).min(segment_bytes))]),
        );
    }

    fn catalog(&mut self) {
        self.control_and_wal();
        let global = self.directory("global");
        // `pg_control` is planned first. `pg_internal.init` is removed at every start of
        // PostgreSQL, so a read of it is wasted.
        for name in self.names(global) {
            if name != "pg_control" && name != "pg_internal.init" {
                self.add(global, &name, None);
            }
        }
        let mut databases: Vec<u32> = cache::names(&self.data.join("base"))
            .iter()
            .filter_map(|name| number(name))
            .filter(|oid| *oid >= FIRST_USER_DATABASE)
            .collect();
        databases.sort_unstable();
        for oid in databases.into_iter().take(MAX_DATABASES) {
            let relative = format!("base/{oid}");
            let directory = self.directory(&relative);
            self.add(directory, "PG_VERSION", None);
            self.add(directory, "pg_filenode.map", None);
            let map = self
                .path(directory, "pg_filenode.map")
                .and_then(|path| read_small(&path, MAX_SMALL))
                .and_then(|bytes| FilenodeMap::parse(&bytes))
                .unwrap_or_default();
            for &catalog in CATALOGS {
                let number = map.file_number(catalog);
                for fork in CATALOG_FORKS {
                    self.add(directory, &format!("{number}{fork}"), None);
                }
            }
        }
    }

    /// The blocks of a dump, relation by relation, the relations with the fewest blocks first.
    fn list(&mut self, mut blocks: Vec<Block>) {
        blocks.retain(Block::supported);
        blocks.sort_unstable();
        blocks.dedup();
        // The runs of one relation: (blocks in it, where it starts, where it ends).
        let mut relations: Vec<(usize, usize, usize)> = Vec::new();
        let mut start = 0;
        for end in 1..=blocks.len() {
            if end == blocks.len() || blocks[end].relation() != blocks[start].relation() {
                relations.push((end - start, start, end));
                start = end;
            }
        }
        relations.sort_by_key(|(count, start, _)| (*count, blocks[*start].relation()));
        for (_, start, end) in relations {
            let first = blocks[start];
            let relative = if first.database == 0 {
                "global".to_string()
            } else {
                format!("base/{}", first.database)
            };
            let directory = self.directory(&relative);
            // One file per segment, with the contiguous blocks of it as one span.
            let mut segment = u64::from(first.block) / SEGMENT_BLOCKS;
            let mut spans: Vec<(u64, u64)> = Vec::new();
            for block in &blocks[start..end] {
                let wanted = u64::from(block.block) / SEGMENT_BLOCKS;
                if wanted != segment {
                    if !self.add_segment(directory, &first, segment, &spans) {
                        return;
                    }
                    segment = wanted;
                    spans.clear();
                }
                let from = u64::from(block.block) % SEGMENT_BLOCKS * BLOCK;
                match spans.last_mut() {
                    Some((_, to)) if *to == from => *to += BLOCK,
                    _ => spans.push((from, from + BLOCK)),
                }
            }
            if !self.add_segment(directory, &first, segment, &spans) {
                return;
            }
        }
    }

    /// Adds one segment file of the relation of `first`; false when the plan is full.
    fn add_segment(
        &mut self,
        directory: usize,
        first: &Block,
        segment: u64,
        spans: &[(u64, u64)],
    ) -> bool {
        match self.add(
            directory,
            &file_name(first.file_number, first.fork, segment),
            Some(spans),
        ) {
            Added::Planned => {}
            Added::Absent => self.missing += 1,
            Added::Full => return false,
        }
        true
    }

    fn finish(self, started: Instant) -> Plan {
        Plan {
            data: self.data,
            directories: self.directories.into_iter().map(|d| d.relative).collect(),
            targets: self.targets,
            bytes: self.bytes,
            missing: self.missing,
            plan_us: micros(started.elapsed()),
        }
    }
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

/// The catalog set of the data directory `data`: nothing, for a directory that is not there or is
/// a link. About 5 MB for a database with its own small schema.
pub fn catalog(data: &Path) -> Plan {
    let started = Instant::now();
    let mut builder = Builder::new(data);
    if cache::is_directory(data) {
        builder.catalog();
    }
    builder.finish(started)
}

/// The hot list of the data directory `data`, from its `autoprewarm.blocks`.
pub fn list(data: &Path) -> Result<Plan, Unavailable> {
    let started = Instant::now();
    if !cache::is_directory(data) {
        return Err(Unavailable::Missing);
    }
    let path = data.join("autoprewarm.blocks");
    let file = match cache::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(Unavailable::Missing),
        Err(_) => return Err(Unavailable::Unreadable),
    };
    let mut bytes = Vec::new();
    file.take(MAX_LIST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Unavailable::Unreadable)?;
    if bytes.len() as u64 > MAX_LIST_BYTES {
        return Err(Unavailable::Unreadable);
    }
    let blocks = parse_blocks(&bytes).ok_or(Unavailable::Unreadable)?;
    let mut builder = Builder::new(data);
    builder.list(blocks);
    Ok(builder.finish(started))
}

impl Plan {
    /// Advises the kernel to read the plan's ranges ahead, in pieces of at most `PIECE`, until the
    /// plan is done or `limits` or `cancel` stop it. Blocking: run it in `spawn_blocking`.
    pub fn issue(&self, limits: Limits, cancel: &AtomicBool) -> Report {
        self.issue_with(limits, cancel, &mut Host)
    }

    fn issue_with(&self, limits: Limits, cancel: &AtomicBool, kernel: &mut impl Kernel) -> Report {
        let started = Instant::now();
        let page = cache::page_size();
        let mut report = Report {
            stop: Stop::Done,
            files: self.targets.len() as u64,
            planned_bytes: self.bytes,
            missing: self.missing,
            skipped: 0,
            pieces: 0,
            issued_bytes: 0,
            resident_bytes: Some(0),
            plan_us: self.plan_us,
            issue_us: 0,
        };
        // Whether each directory is still a directory: asked once, when its first file is opened.
        let mut checked: Vec<Option<bool>> = vec![None; self.directories.len()];
        'targets: for target in &self.targets {
            let relative = &self.directories[target.directory];
            let still_real = *checked[target.directory]
                .get_or_insert_with(|| real_directory(&self.data, relative));
            let file = still_real
                .then(|| cache::open(&self.data.join(relative).join(&target.name)).ok())
                .flatten();
            let length = file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .map(|metadata| metadata.len());
            let (Some(file), Some(length)) = (file, length) else {
                report.skipped += 1;
                continue;
            };
            for (from, to) in &target.spans {
                let mut at = *from;
                let to = (*to).min(length);
                while at < to {
                    if cancel.load(Ordering::Relaxed) {
                        report.stop = Stop::Cancelled;
                        break 'targets;
                    }
                    if report.issued_bytes >= limits.max_bytes {
                        report.stop = Stop::Bytes;
                        break 'targets;
                    }
                    if started.elapsed() >= limits.budget {
                        report.stop = Stop::Budget;
                        break 'targets;
                    }
                    let piece = (to - at).min(PIECE);
                    let held = kernel.resident(&file, at, piece);
                    if kernel.advise(&file, at, piece).is_err() {
                        report.stop = Stop::Failed;
                        break 'targets;
                    }
                    report.resident_bytes = report
                        .resident_bytes
                        .zip(held)
                        .map(|(sum, pages)| sum + pages * page);
                    report.pieces += 1;
                    report.issued_bytes += piece;
                    at += piece;
                }
            }
        }
        report.issue_us = micros(started.elapsed());
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        postgres,
        settings::AGENT_ROLE,
        testpg::{self, Cluster},
    };
    use std::{fs, os::unix::fs::symlink, sync::Arc};

    // The tests that need a PostgreSQL 18 start here; the others make their files themselves.

    /// A model of the kernel's read-ahead as the lab measured it on EU1 (`read_ahead_kb` 128): one
    /// `WILLNEED` call reads the first `PIECE` bytes of the range it is given, whatever its size.
    #[derive(Default)]
    struct Model {
        calls: Vec<(u64, u64)>,
        /// Bytes that the calls made the kernel read.
        read: u64,
        /// Time one call takes.
        cost: Duration,
        /// Pages of a piece that are in the cache already.
        held: Option<u64>,
        /// The flag to raise after that many calls.
        cancel: Option<(usize, Arc<AtomicBool>)>,
    }
    impl Kernel for Model {
        fn advise(&mut self, _file: &File, offset: u64, length: u64) -> io::Result<()> {
            std::thread::sleep(self.cost);
            self.calls.push((offset, length));
            self.read += length.min(PIECE);
            if let Some((after, flag)) = &self.cancel
                && self.calls.len() == *after
            {
                flag.store(true, Ordering::Relaxed);
            }
            Ok(())
        }
        fn resident(&mut self, _file: &File, _offset: u64, _length: u64) -> Option<u64> {
            self.held
        }
    }
    fn limits(budget: Duration) -> Limits {
        Limits {
            budget,
            max_bytes: u64::MAX,
        }
    }
    fn no_cancel() -> AtomicBool {
        AtomicBool::new(false)
    }

    /// A data directory with the places a plan lists.
    fn data(label: &str) -> PathBuf {
        let data = testpg::directory(label).join("data");
        for directory in ["global", "pg_wal", "base/1", "base/5", "base/16384"] {
            fs::create_dir_all(data.join(directory)).unwrap();
        }
        data
    }
    /// A file of `length` bytes (sparse).
    fn sparse(path: impl AsRef<Path>, length: u64) {
        fs::File::create(path).unwrap().set_len(length).unwrap();
    }
    /// A `pg_control` of PostgreSQL 18, shut down, whose latest checkpoint is at `checkpoint` on
    /// timeline 1.
    fn control(checkpoint: u64) -> Vec<u8> {
        let mut control = vec![0u8; 296];
        control[8..12].copy_from_slice(&1800u32.to_le_bytes());
        control[16..20].copy_from_slice(&1i32.to_le_bytes());
        control[32..40].copy_from_slice(&checkpoint.to_le_bytes());
        control[48..52].copy_from_slice(&1u32.to_le_bytes());
        control
    }
    /// A dump of `autoprewarm.blocks` for the user database 16384 and the default tablespace.
    fn dump(data: &Path, blocks: &[(u32, u32, u32, u8, u32)]) {
        let mut text = format!("<<{}>>\n", blocks.len());
        for (database, tablespace, file_number, fork, block) in blocks {
            text += &format!("{database},{tablespace},{file_number},{fork},{block}\n");
        }
        fs::write(data.join("autoprewarm.blocks"), text).unwrap();
    }
    /// The planned files as `directory/name`, in order, each with its ranges.
    fn planned(plan: &Plan) -> Vec<(String, Vec<(u64, u64)>)> {
        plan.targets
            .iter()
            .map(|t| {
                (
                    format!("{}/{}", plan.directories[t.directory].display(), t.name),
                    t.spans.clone(),
                )
            })
            .collect()
    }
    fn names(plan: &Plan) -> Vec<String> {
        planned(plan).into_iter().map(|(name, _)| name).collect()
    }

    /// The bug of the lab's first tool: one `WILLNEED` call over a range of megabytes reads only
    /// the first part of it, and the tool counted the whole range as issued.
    #[test]
    fn a_piece_is_at_most_128_kib_so_that_a_large_range_is_never_one_call() {
        let data = data("prefetch-pieces");
        // A heap of 10 MiB and 100 KiB over 1,300 blocks (the last piece is short).
        sparse(data.join("base/16384/16500"), (1280 + 12) * BLOCK);
        let all: Vec<_> = (0..1292).map(|b| (16384, 1663, 16500, 0, b)).collect();
        dump(&data, &all);
        let plan = list(&data).unwrap();
        let mut model = Model::default();
        let report = plan.issue_with(limits(Duration::from_secs(60)), &no_cancel(), &mut model);

        let total = 1292 * BLOCK;
        assert!(model.calls.iter().all(|(_, length)| *length <= PIECE));
        assert_eq!(model.calls.len(), total.div_ceil(PIECE) as usize);
        // Every byte of the range is covered once, in order.
        let mut next = 0;
        for (offset, length) in &model.calls {
            assert_eq!(*offset, next);
            next += length;
        }
        assert_eq!(next, total);
        // What the report calls issued is what the kernel read.
        assert_eq!(report.issued_bytes, model.read);
        assert_eq!(
            (report.pieces, report.stop),
            (model.calls.len() as u64, Stop::Done)
        );
        assert_eq!((report.files, report.planned_bytes), (1, total));
    }

    #[test]
    fn a_list_is_read_strictly_and_anything_else_is_no_list() {
        let ok = parse_blocks(b"<<2>>\n5,1663,1259,0,0\n16384,1663,16500,3,131072\n").unwrap();
        assert_eq!(
            ok,
            [
                Block {
                    database: 5,
                    tablespace: 1663,
                    file_number: 1259,
                    fork: 0,
                    block: 0
                },
                Block {
                    database: 16384,
                    tablespace: 1663,
                    file_number: 16500,
                    fork: 3,
                    block: 131_072
                },
            ]
        );
        assert_eq!(parse_blocks(b"<<0>>\n").unwrap(), []);
        // The last line may lack its newline; blocks up to the largest 32-bit number are blocks.
        assert_eq!(
            parse_blocks(b"<<1>>\n1,2,3,0,4294967295").unwrap()[0].block,
            u32::MAX
        );
        let too_many = format!("<<{}>>\n", MAX_LIST_BLOCKS + 1);
        for (what, bad) in [
            ("empty", &b""[..]),
            ("no header", b"5,1663,1259,0,0\n"),
            ("a header of text", b"<<x>>\n"),
            ("a signed header", b"<<+1>>\n1,2,3,0,4\n"),
            ("a header above the bound", too_many.as_bytes()),
            ("fewer lines than the header", b"<<2>>\n1,2,3,0,4\n"),
            (
                "more lines than the header",
                b"<<1>>\n1,2,3,0,4\n1,2,3,0,5\n",
            ),
            ("four fields", b"<<1>>\n1,2,3,0\n"),
            ("six fields", b"<<1>>\n1,2,3,0,4,5\n"),
            ("a signed number", b"<<1>>\n1,2,+3,0,4\n"),
            ("a negative number", b"<<1>>\n1,2,-3,0,4\n"),
            ("a number above 32 bits", b"<<1>>\n1,2,3,0,4294967296\n"),
            ("a fork above 3", b"<<1>>\n1,2,3,4,5\n"),
            ("text", b"<<1>>\n1,2,3,0,x\n"),
            ("not UTF-8", b"<<1>>\n1,2,3,0,\xff\n"),
        ] {
            assert_eq!(parse_blocks(bad), None, "{what}");
        }
    }

    #[test]
    fn listed_blocks_are_merged_cut_at_the_segment_ordered_fewest_first_and_the_system_left_out() {
        let data = data("prefetch-list");
        sparse(data.join("base/16384/16500"), 1 << 20); // 128 blocks
        sparse(data.join("base/16384/16500_fsm"), 3 * BLOCK);
        sparse(data.join("base/16384/16501"), 1 << 30);
        sparse(data.join("base/16384/16501.1"), 1 << 20);
        sparse(data.join("global/1260"), 8 * BLOCK);
        sparse(data.join("base/5/1259"), 8 * BLOCK);
        let d = 16384;
        let mut blocks = vec![
            // Seven blocks in three runs, listed out of order and one twice.
            (d, 1663, 16500, 0, 11),
            (d, 1663, 16500, 0, 0),
            (d, 1663, 16500, 0, 3),
            (d, 1663, 16500, 0, 1),
            (d, 1663, 16500, 0, 10),
            (d, 1663, 16500, 0, 2),
            (d, 1663, 16500, 0, 5),
            (d, 1663, 16500, 0, 5),
            // Three blocks across the end of the first segment.
            (d, 1663, 16501, 0, 131_071),
            (d, 1663, 16501, 0, 131_072),
            (d, 1663, 16501, 0, 131_073),
            // One block of a free-space map; a shared relation with five.
            (d, 1663, 16500, 1, 2),
            (0, 1664, 1260, 0, 0),
            (0, 1664, 1260, 0, 1),
            (0, 1664, 1260, 0, 2),
            (0, 1664, 1260, 0, 3),
            (0, 1664, 1260, 0, 4),
            // The system database, another tablespace and a file that is not there.
            (5, 1663, 1259, 0, 0),
            (d, 1700, 16500, 0, 0),
            (d, 1663, 99999, 0, 0),
        ];
        blocks.sort_by_key(|b| std::cmp::Reverse(b.4));
        dump(&data, &blocks);

        let plan = list(&data).unwrap();
        let end = SEGMENT_BLOCKS * BLOCK;
        assert_eq!(
            planned(&plan),
            [
                (
                    "base/16384/16500_fsm".to_string(),
                    vec![(2 * BLOCK, 3 * BLOCK)]
                ),
                ("base/16384/16501".to_string(), vec![(end - BLOCK, end)]),
                ("base/16384/16501.1".to_string(), vec![(0, 2 * BLOCK)]),
                ("global/1260".to_string(), vec![(0, 5 * BLOCK)]),
                (
                    "base/16384/16500".to_string(),
                    vec![
                        (0, 4 * BLOCK),
                        (5 * BLOCK, 6 * BLOCK),
                        (10 * BLOCK, 12 * BLOCK)
                    ]
                ),
            ]
        );
        // 1 + 1 + 2 + 5 + 7 blocks; the file that is not there is counted as missing.
        assert_eq!((plan.bytes, plan.missing), (16 * BLOCK, 1));
    }

    #[test]
    fn the_catalog_set_takes_control_wal_global_and_the_catalogs_of_user_databases_through_the_map()
    {
        let data = data("prefetch-catalog");
        // A checkpoint at 0x0300_5A40 of timeline 1, 16 MiB segments: segment 3, offset 0x5A40.
        fs::write(data.join("global/pg_control"), control(0x0300_5A40)).unwrap();
        sparse(data.join("pg_wal/000000010000000000000003"), 16 << 20);
        sparse(data.join("pg_wal/000000010000000000000004"), 16 << 20);
        sparse(data.join("global/1260"), 8 * BLOCK);
        sparse(data.join("global/pg_filenode.map"), 524);
        sparse(data.join("global/pg_internal.init"), 4096);
        // pg_class (1259) moved to file number 17000 by a VACUUM FULL; pg_attribute (1249) is not.
        let mut map = vec![0u8; 524];
        map[0..4].copy_from_slice(&MAP_MAGIC.to_le_bytes());
        map[4..8].copy_from_slice(&1u32.to_le_bytes());
        map[8..12].copy_from_slice(&1259u32.to_le_bytes());
        map[12..16].copy_from_slice(&17000u32.to_le_bytes());
        fs::write(data.join("base/16384/pg_filenode.map"), &map).unwrap();
        for name in [
            "PG_VERSION",
            "17000",
            "17000_fsm",
            "17000_vm",
            "1259",
            "1249",
            "1249_vm",
            "2662",
            "16500",
            "pg_internal.init",
        ] {
            sparse(data.join("base/16384").join(name), 3 * BLOCK);
        }
        // The system databases are left out.
        sparse(data.join("base/1/1259"), 3 * BLOCK);
        sparse(data.join("base/5/1259"), 3 * BLOCK);

        let plan = catalog(&data);
        assert_eq!(
            planned(&plan),
            [
                ("global/pg_control".to_string(), vec![(0, 296)]),
                // The window starts at the block of the checkpoint record and is 256 KiB.
                (
                    "pg_wal/000000010000000000000003".to_string(),
                    vec![(0x4000, 0x4000 + (256 << 10))]
                ),
                ("global/1260".to_string(), vec![(0, 8 * BLOCK)]),
                ("global/pg_filenode.map".to_string(), vec![(0, 524)]),
                ("base/16384/PG_VERSION".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/pg_filenode.map".to_string(), vec![(0, 524)]),
                // pg_class through the map; the indexes by their oid; forks that exist.
                ("base/16384/17000".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/17000_fsm".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/17000_vm".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/2662".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/1249".to_string(), vec![(0, 3 * BLOCK)]),
                ("base/16384/1249_vm".to_string(), vec![(0, 3 * BLOCK)]),
            ]
        );
        // The old file of pg_class (1259), the relation of the user (16500) and the relcache init
        // files are not in it.
        assert_eq!(plan.missing, 0);
        assert_eq!(catalog(&data.join("missing")).targets.len(), 0);
    }

    #[test]
    fn the_filenode_map_is_read_as_postgresql_writes_it_and_nothing_else_is_a_map() {
        let map = |magic: u32, count: u32, pairs: &[(u32, u32)]| {
            let mut bytes = vec![0u8; 524];
            bytes[0..4].copy_from_slice(&magic.to_le_bytes());
            bytes[4..8].copy_from_slice(&count.to_le_bytes());
            for (n, (oid, number)) in pairs.iter().enumerate() {
                bytes[8 + 8 * n..12 + 8 * n].copy_from_slice(&oid.to_le_bytes());
                bytes[12 + 8 * n..16 + 8 * n].copy_from_slice(&number.to_le_bytes());
            }
            bytes
        };
        let parsed =
            FilenodeMap::parse(&map(MAP_MAGIC, 2, &[(1259, 17000), (1249, 17001)])).unwrap();
        assert_eq!(parsed.file_number(1259), 17000);
        assert_eq!(parsed.file_number(1249), 17001);
        assert_eq!(parsed.file_number(1255), 1255);
        // A mapping to file number 0 is none.
        let zero = FilenodeMap::parse(&map(MAP_MAGIC, 1, &[(1259, 0)])).unwrap();
        assert_eq!(zero.file_number(1259), 1259);
        assert_eq!(FilenodeMap::parse(&map(0x1234, 1, &[(1259, 17000)])), None);
        assert_eq!(FilenodeMap::parse(&map(MAP_MAGIC, 65, &[])), None);
        // Declared mappings that the file does not hold.
        assert_eq!(FilenodeMap::parse(&map(MAP_MAGIC, 40, &[])[..100]), None);
        assert_eq!(FilenodeMap::parse(&[]), None);
    }

    #[test]
    fn the_issuing_stops_at_its_budget_its_byte_bound_and_a_cancel() {
        let data = data("prefetch-stops");
        sparse(data.join("base/16384/16500"), 10 << 20);
        let all: Vec<_> = (0..1280).map(|b| (16384, 1663, 16500, 0, b)).collect();
        dump(&data, &all);
        let plan = list(&data).unwrap();

        // A budget of nothing issues nothing; a budget of 40 ms at 5 ms a piece issues some.
        let report = plan.issue_with(limits(Duration::ZERO), &no_cancel(), &mut Model::default());
        assert_eq!(
            (report.stop, report.pieces, report.issued_bytes),
            (Stop::Budget, 0, 0)
        );
        let mut slow = Model {
            cost: Duration::from_millis(5),
            ..Model::default()
        };
        let report = plan.issue_with(limits(Duration::from_millis(40)), &no_cancel(), &mut slow);
        assert_eq!(report.stop, Stop::Budget);
        assert!((1..80).contains(&report.pieces), "{report:?}");
        assert!(report.issue_us < 500_000, "{report:?}");

        // 1 MiB is eight pieces.
        let mut model = Model::default();
        let bounded = Limits {
            budget: Duration::from_secs(60),
            max_bytes: 1 << 20,
        };
        let report = plan.issue_with(bounded, &no_cancel(), &mut model);
        assert_eq!(
            (report.stop, report.pieces, report.issued_bytes),
            (Stop::Bytes, 8, 1 << 20)
        );

        // A cancel raised during the third piece stops before the fourth.
        let flag = Arc::new(AtomicBool::new(false));
        let mut model = Model {
            cancel: Some((3, flag.clone())),
            ..Model::default()
        };
        let report = plan.issue_with(limits(Duration::from_secs(60)), &flag, &mut model);
        assert_eq!((report.stop, report.pieces), (Stop::Cancelled, 3));
        assert_eq!(model.calls.len(), 3);

        // Done where nothing stops it; the pages the cache held are counted from the kernel.
        let mut held = Model {
            held: Some(10),
            ..Model::default()
        };
        let report = plan.issue_with(limits(Duration::from_secs(60)), &no_cancel(), &mut held);
        assert_eq!(
            (report.stop, report.pieces, report.issued_bytes),
            (Stop::Done, 80, 10 << 20)
        );
        assert_eq!(report.resident_bytes, Some(80 * 10 * cache::page_size()));
        // A kernel that cannot count leaves the count out and still advises.
        let report = plan.issue_with(
            limits(Duration::from_secs(60)),
            &no_cancel(),
            &mut Model::default(),
        );
        assert_eq!((report.stop, report.resident_bytes), (Stop::Done, None));
    }

    /// The data directory is the database user's: a link in place of a directory or a file is not
    /// followed or opened, whether it is there when the plan is made or put there before the
    /// files are opened.
    #[test]
    fn a_link_in_place_of_a_directory_or_a_file_is_not_followed() {
        // The plan is made over a link: only what the real directories hold is planned.
        for (place, expected) in [
            ("global", Vec::<&str>::new()),
            ("pg_wal", vec!["global/pg_control"]),
            ("base", vec!["global/pg_control"]),
        ] {
            let data = data("prefetch-link");
            fs::write(data.join("global/pg_control"), control(0x0100_0100)).unwrap();
            let outside = testpg::directory("prefetch-outside");
            fs::write(outside.join("pg_control"), control(0x0100_0100)).unwrap();
            fs::create_dir_all(outside.join("16384")).unwrap();
            sparse(outside.join("16384/PG_VERSION"), 3);
            sparse(outside.join("16384/1259"), 8192);
            sparse(outside.join("000000010000000000000001"), 16 << 20);
            fs::remove_dir_all(data.join(place)).unwrap();
            symlink(&outside, data.join(place)).unwrap();
            assert_eq!(names(&catalog(&data)), expected, "{place}");
        }
        let data = data("prefetch-link-database");
        let outside = testpg::directory("prefetch-outside");
        sparse(outside.join("PG_VERSION"), 3);
        sparse(outside.join("16500"), 8192);
        fs::remove_dir_all(data.join("base/16384")).unwrap();
        symlink(&outside, data.join("base/16384")).unwrap();
        assert_eq!(names(&catalog(&data)), Vec::<String>::new());
        dump(&data, &[(16384, 1663, 16500, 0, 0)]);
        let plan = list(&data).unwrap();
        assert_eq!((plan.targets.len(), plan.missing), (0, 1));
        // The data directory itself, and a list that is a link.
        let real = self::data("prefetch-link-data");
        sparse(real.join("base/16384/16500"), 8192);
        dump(&real, &[(16384, 1663, 16500, 0, 0)]);
        let linked = testpg::directory("prefetch-linked").join("data");
        symlink(&real, &linked).unwrap();
        assert_eq!(names(&list(&real).unwrap()), ["base/16384/16500"]);
        assert_eq!(list(&linked).err(), Some(Unavailable::Missing));
        assert_eq!(names(&catalog(&linked)), Vec::<String>::new());
        let other = testpg::directory("prefetch-other").join("list");
        fs::copy(real.join("autoprewarm.blocks"), &other).unwrap();
        fs::remove_file(real.join("autoprewarm.blocks")).unwrap();
        symlink(&other, real.join("autoprewarm.blocks")).unwrap();
        assert_eq!(list(&real).err(), Some(Unavailable::Unreadable));
        fs::remove_file(real.join("autoprewarm.blocks")).unwrap();
        assert_eq!(list(&real).err(), Some(Unavailable::Missing));

        // A directory that becomes a link, and a file that becomes a link or a pipe, after the
        // plan: the files are skipped and the kernel is never asked.
        let data = self::data("prefetch-swap");
        sparse(data.join("base/16384/16500"), 8192);
        sparse(data.join("base/16384/16501"), 8192);
        sparse(data.join("global/1260"), 8192);
        dump(
            &data,
            &[
                (16384, 1663, 16500, 0, 0),
                (16384, 1663, 16501, 0, 0),
                (0, 1664, 1260, 0, 0),
            ],
        );
        let plan = list(&data).unwrap();
        assert_eq!(plan.targets.len(), 3);
        let outside = testpg::directory("prefetch-outside");
        sparse(outside.join("16500"), 8192);
        sparse(outside.join("16501"), 8192);
        fs::remove_dir_all(data.join("base/16384")).unwrap();
        symlink(&outside, data.join("base/16384")).unwrap();
        fs::remove_file(data.join("global/1260")).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(data.join("global/1260"))
                .status()
                .unwrap()
                .success()
        );
        let mut model = Model::default();
        let report = plan.issue_with(limits(Duration::from_secs(60)), &no_cancel(), &mut model);
        assert_eq!(
            (report.skipped, report.pieces, report.stop),
            (3, 0, Stop::Done)
        );
        assert!(model.calls.is_empty());
    }

    // The real PostgreSQL 18 tests.

    /// A stopped cluster of the agent's layout with the user database `app`, a table with an
    /// index, two mapped catalogs rewritten by `VACUUM FULL`, and what PostgreSQL says of its
    /// files.
    struct Real {
        cluster: Cluster,
        /// `app`'s OID.
        database: u32,
        /// `pg_relation_filepath` of each catalog of `CATALOGS` in `app`.
        catalogs: Vec<(u32, String)>,
        table: String,
        index: String,
    }
    async fn real(label: &str) -> Option<Real> {
        let cluster = Cluster::create(label)?;
        cluster.start();
        let admin = cluster.agent().await;
        admin.batch_long("CREATE DATABASE app").await.unwrap();
        let rows = admin
            .query(
                "SELECT oid::pg_catalog.int8 FROM pg_database WHERE datname = 'app'",
                &[],
            )
            .await
            .unwrap();
        let database = u32::try_from(rows[0].get::<_, i64>(0)).unwrap();
        let app = postgres::connect(&cluster.socket_directory(), AGENT_ROLE, "app")
            .await
            .unwrap();
        app.batch(
            "CREATE TABLE t AS SELECT g, repeat('x', 100) AS pad FROM generate_series(1, 20000) g",
        )
        .await
        .unwrap();
        app.batch("CREATE INDEX t_g ON t (g)").await.unwrap();
        // Two catalogs that PostgreSQL rewrites to a file number of their own.
        app.batch_long("VACUUM FULL pg_class").await.unwrap();
        app.batch_long("VACUUM FULL pg_proc").await.unwrap();
        drop(app);
        // A session after the rewrite reads the catalogs through the map and the heap.
        let app = postgres::connect(&cluster.socket_directory(), AGENT_ROLE, "app")
            .await
            .unwrap();
        app.query("SELECT count(*) FROM t WHERE g > 0", &[])
            .await
            .unwrap();
        let oids: Vec<i64> = CATALOGS.iter().map(|oid| i64::from(*oid)).collect();
        let rows = app
            .query(
                "SELECT oid::pg_catalog.int8, pg_relation_filepath(oid) FROM pg_class WHERE oid::pg_catalog.int8 = ANY($1)",
                &[&oids],
            )
            .await
            .unwrap();
        let catalogs = rows
            .iter()
            .map(|row| {
                (
                    u32::try_from(row.get::<_, i64>(0)).unwrap(),
                    row.get::<_, String>(1),
                )
            })
            .collect();
        let path = |name: &'static str| {
            let app = &app;
            async move {
                let rows = app
                    .query(&format!("SELECT pg_relation_filepath('{name}')"), &[])
                    .await
                    .unwrap();
                rows[0].get::<_, String>(0)
            }
        };
        let (table, index) = (path("t").await, path("t_g").await);
        drop(app);
        drop(admin);
        cluster.stop();
        Some(Real {
            cluster,
            database,
            catalogs,
            table,
            index,
        })
    }

    #[tokio::test]
    async fn the_catalog_set_of_a_real_cluster_names_the_files_postgresql_reads_at_a_login() {
        let Some(real) = real("prefetch-real-catalog").await else {
            return;
        };
        let data = real.cluster.data();
        // Every catalog of the list is a relation of PostgreSQL 18, and two of them are not at the
        // file number of their oid: without the map the plan would name the old, empty files.
        assert_eq!(real.catalogs.len(), CATALOGS.len());
        let moved = |oid: u32| {
            real.catalogs
                .iter()
                .find(|(o, _)| *o == oid)
                .unwrap()
                .1
                .clone()
        };
        let prefix = format!("base/{}", real.database);
        assert_ne!(moved(1259), format!("{prefix}/1259"));
        assert_ne!(moved(1255), format!("{prefix}/1255"));

        let plan = catalog(&data);
        let planned = names(&plan);
        // Every catalog with something in it is planned at the file PostgreSQL names; an empty one
        // (nothing in `pg_attrdef`) has nothing to read.
        let mut with_content = 0;
        for (oid, path) in &real.catalogs {
            if fs::metadata(data.join(path)).is_ok_and(|m| m.len() > 0) {
                with_content += 1;
                assert!(
                    planned.contains(path),
                    "catalog {oid} at {path} is not planned"
                );
            }
        }
        assert!(with_content > CATALOGS.len() / 2, "{with_content}");
        for name in ["pg_control", "pg_filenode.map"] {
            assert!(planned.contains(&format!("global/{name}")), "{name}");
        }
        for name in ["PG_VERSION", "pg_filenode.map"] {
            assert!(planned.contains(&format!("{prefix}/{name}")), "{name}");
        }
        // The relcache init files exist after the clean stop and are not planned; the user's own
        // relations are not catalogs.
        assert!(data.join(&prefix).join("pg_internal.init").exists());
        assert!(
            !planned
                .iter()
                .any(|name| name.ends_with("pg_internal.init"))
        );
        assert!(!planned.contains(&real.table) && !planned.contains(&real.index));
        // No database below the first user database.
        assert!(
            planned
                .iter()
                .all(|name| !name.starts_with("base/1/") && !name.starts_with("base/5/"))
        );

        // The WAL window is at the checkpoint that `pg_controldata` reports.
        let output =
            std::process::Command::new(real.cluster.layout.postgres_bin.join("pg_controldata"))
                .arg(&data)
                .output()
                .unwrap();
        let text = String::from_utf8_lossy(&output.stdout).to_string();
        let value = |key: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(key))
                .unwrap()
                .trim()
                .to_string()
        };
        let checkpoint = Lsn::parse(&value("Latest checkpoint location:").to_uppercase()).unwrap();
        let timeline: u32 = value("Latest checkpoint's TimeLineID:").parse().unwrap();
        let segment_bytes = fs::metadata(
            data.join("pg_wal")
                .join(checkpoint.segment(timeline, 16 << 20)),
        )
        .unwrap()
        .len();
        let wal = format!("pg_wal/{}", checkpoint.segment(timeline, segment_bytes));
        let window = planned_spans(&plan, &wal);
        let from = checkpoint.0 % segment_bytes / BLOCK * BLOCK;
        assert_eq!(window, [(from, (from + WAL_WINDOW).min(segment_bytes))]);

        // About 5 MB for a database of its own; the issuing advises all of it on a Linux kernel.
        assert!(
            (1 << 20..16 << 20).contains(&plan.bytes),
            "{} bytes",
            plan.bytes
        );
        assert_eq!(plan.missing, 0);
        #[cfg(target_os = "linux")]
        {
            let report = plan.issue(limits(Duration::from_secs(10)), &no_cancel());
            assert_eq!((report.stop, report.skipped), (Stop::Done, 0), "{report:?}");
            assert_eq!(report.issued_bytes, plan.bytes);
        }
    }

    fn planned_spans(plan: &Plan, name: &str) -> Vec<(u64, u64)> {
        planned(plan)
            .into_iter()
            .find(|(n, _)| n == name)
            .unwrap_or_else(|| panic!("{name} is not planned"))
            .1
    }

    #[tokio::test]
    async fn the_hot_list_of_a_real_dump_is_found_file_by_file_and_the_heap_comes_last() {
        let Some(real) = real("prefetch-real-list").await else {
            return;
        };
        let data = real.cluster.data();
        let text = fs::read(data.join("autoprewarm.blocks")).unwrap();
        let blocks = parse_blocks(&text).expect("PostgreSQL's own dump is a list");
        assert!(blocks.len() > 500, "{} blocks", blocks.len());

        let plan = list(&data).unwrap();
        // Every supported block is in the plan, and every file it names is there.
        let supported = blocks.iter().filter(|b| b.supported()).count() as u64;
        assert_eq!((plan.bytes, plan.missing), (supported * BLOCK, 0));
        // The relations with the fewest blocks first: the table's index, and the heap last.
        let planned = names(&plan);
        let (index, table) = (
            planned
                .iter()
                .position(|n| *n == real.index)
                .expect("the index is listed"),
            planned
                .iter()
                .position(|n| *n == real.table)
                .expect("the table is listed"),
        );
        assert!(index < table);
        assert_eq!(table, planned.len() - 1);
        let spans_of = |name: &str| -> u64 {
            planned_spans(&plan, name)
                .iter()
                .map(|(from, to)| (to - from) / BLOCK)
                .sum()
        };
        let counts: Vec<u64> = planned.iter().map(|name| spans_of(name)).collect();
        assert!(
            counts.windows(2).all(|pair| pair[0] <= pair[1]),
            "{counts:?}"
        );
        assert!(counts[table] >= 250);

        #[cfg(target_os = "linux")]
        {
            let report = plan.issue(limits(Duration::from_secs(10)), &no_cancel());
            assert_eq!((report.stop, report.skipped), (Stop::Done, 0), "{report:?}");
            assert_eq!(report.issued_bytes, plan.bytes);
        }
    }

    /// The catalog set leaves `pg_internal.init` out because PostgreSQL removes it at its start,
    /// before the database accepts a connection (source: `RelationCacheInitFileRemove`). Checked
    /// against PostgreSQL 18.
    #[tokio::test]
    async fn postgresql_removes_the_relcache_init_files_at_every_start() {
        let Some(real) = real("prefetch-real-init").await else {
            return;
        };
        let data = real.cluster.data();
        let init = [
            data.join("global/pg_internal.init"),
            data.join(format!("base/{}/pg_internal.init", real.database)),
        ];
        assert!(
            init.iter().all(|path| path.exists()),
            "a session writes them"
        );
        // Autoprewarm's worker is a session of `app`, which writes the file again.
        real.cluster.append_conf("pg_prewarm.autoprewarm = off\n");
        real.cluster.start();
        assert!(
            init.iter().all(|path| !path.exists()),
            "the start removes them"
        );
        let session = postgres::connect(&real.cluster.socket_directory(), AGENT_ROLE, "app")
            .await
            .unwrap();
        session
            .query("SELECT 1::pg_catalog.int4", &[])
            .await
            .unwrap();
        assert!(
            init.iter().all(|path| path.exists()),
            "the first session writes them"
        );
    }

    /// The kernel itself: a file whose pages were dropped is read ahead, in pieces, and the pages
    /// are in the cache afterwards. What the call reports depends on the file system, as in
    /// `cache.rs`: the test says where it cannot check.
    #[cfg(target_os = "linux")]
    #[test]
    fn willneed_in_pieces_brings_the_pages_of_a_real_file_into_the_cache() {
        use std::os::fd::AsRawFd;
        let data = data("prefetch-kernel");
        let blocks = 512u32; // 4 MiB: 32 pieces
        let path = data.join("base/16384/16500");
        let bytes: Vec<u8> = (0..u64::from(blocks) * BLOCK)
            .map(|i| (i % 251) as u8)
            .collect();
        fs::write(&path, &bytes).unwrap();
        File::open(&path).unwrap().sync_all().unwrap();
        let all: Vec<_> = (0..blocks).map(|b| (16384, 1663, 16500, 0, b)).collect();
        dump(&data, &all);
        let plan = list(&data).unwrap();

        let file = File::open(&path).unwrap();
        // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
        let error =
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        assert_eq!(error, 0);
        let pages = u64::from(blocks) * BLOCK / cache::page_size();
        let held = |file: &File| cache::cachestat_range(file, 0, 0).map(|p| p.resident);
        match held(&file) {
            Ok(0) => {}
            Ok(_) => {
                return eprintln!("skipped: this file system keeps the pages it is told to drop");
            }
            Err(error) => return eprintln!("skipped: no cachestat here ({error})"),
        }

        let report = plan.issue(limits(Duration::from_secs(10)), &no_cancel());
        assert_eq!((report.stop, report.pieces), (Stop::Done, 32), "{report:?}");
        assert_eq!(report.issued_bytes, u64::from(blocks) * BLOCK);
        // None of it was resident when it was advised.
        assert_eq!(report.resident_bytes, Some(0));
        // The reads are asynchronous: wait for them.
        let started = Instant::now();
        while held(&file).unwrap() < pages && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(held(&file).unwrap(), pages);
        // Advised again, all of it is resident now.
        let again = plan.issue(limits(Duration::from_secs(10)), &no_cancel());
        assert_eq!(again.resident_bytes, Some(u64::from(blocks) * BLOCK));
    }
}
