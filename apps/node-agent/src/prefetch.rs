// SPDX-License-Identifier: Apache-2.0
//! Readahead of the files a database's start and first request read (plan 11.2, package F).
//!
//! A database that slept for hours has had its pages evicted, and the start of its PostgreSQL, the
//! login and the first statements read them from the disk one random read at a time (EU1,
//! 2026-10-20, p50 / p95: login 66 / 133 ms and six statements 208 / 452 ms; with the catalogs
//! read ahead the login took 23 ms, and with the whole autoprewarm list resident the statements
//! took 66 ms). The agent knows which files those are before the request does. It asks the kernel
//! to read them ahead with `posix_fadvise(WILLNEED)`, in four sets:
//!
//! - **`start`**: what PostgreSQL reads between its exec and its ready, found without starting it:
//!   the configuration files (`postgresql.conf`, `postgresql.auto.conf`, `pg_hba.conf`,
//!   `pg_ident.conf`) and `PG_VERSION`; `pg_control`; the WAL at the latest checkpoint record and,
//!   when it lies earlier (a crash), at the redo point; the last segment of `pg_xact` and of
//!   `pg_multixact`'s two directories, `pg_stat/pgstat.stat` and `pg_logical/replorigin_checkpoint`,
//!   which the startup process reads; and `global/`. About 1 MB (a strace of PostgreSQL 18.6 on
//!   Debian 13 lists them; `pg_internal.init` of `global/` is removed at every start and is not
//!   read).
//! - **`catalog`**: in each user database (`base/<oid>`, oid 16384 and up) its `PG_VERSION`, its
//!   `pg_filenode.map` and the catalogs a login and a first statement read, with their indexes and
//!   forks. A mapped catalog (`pg_class`, `pg_attribute`, `pg_proc`, `pg_type` and their indexes)
//!   that PostgreSQL has rewritten (`VACUUM FULL`) lives at the file number the map names, not at
//!   its oid. Every other catalog is read at its oid: a rewrite of one gives it a file number that
//!   only `pg_class` records, which the plan does not read, so it drops out of the set and its
//!   absent main fork is counted in `Report::missing`. About 5 MB, found without starting
//!   PostgreSQL.
//! - **`list`**: the blocks of `autoprewarm.blocks`, which PostgreSQL writes at each clean stop,
//!   merged where they are contiguous and ordered by the fewest listed blocks per relation first
//!   (catalogs, indexes and small tables before the one big heap), so that a time budget cuts off
//!   the heap's tail and nothing else.
//! - **`files`**: whole files that are not in a data directory, the program of PostgreSQL
//!   (`program`).
//!
//! Each set is two steps. Building the `Plan` reads the directories and a few small files and opens
//! each file once to learn its length (blocking: run it in `spawn_blocking`, and before the moment
//! it matters; it warms the dentries and inodes the issuing needs). `Plan::issue` advises the
//! kernel in pieces of `PIECE` and stops at a time budget, a byte bound or a cancel; it returns a
//! `Report` of counts and timings, which is the page cache accounting of a wake. A piece that the
//! page cache holds entirely is not advised (its pages are counted first with `cachestat(2)`): a
//! set that is resident costs one lookup per piece and no read. The issuing replaces the
//! residency diagnostic that `cache.rs` made, which opened up to 64 files and listed directories
//! while the wake ran (judge gap 12): the counts now come from the files the issuing advises
//! anyway, and the wake itself opens and lists nothing to count pages.
//!
//! The kernel reads at most `max(read_ahead_kb, the size asked)` of a range per `WILLNEED` call
//! (EU1: 128 KiB), so one call over a large range reads only its first part. The lab tool of
//! 2026-10-20 did that first; every call here covers at most `PIECE`.
//!
//! The data directory is the database user's, and the agent reads as root, so nothing in it
//! chooses what the plan costs. A link at a directory is not followed (checked when the plan lists
//! it and again before its files are opened), a link at a file is not opened (`O_NOFOLLOW`), a pipe
//! or a device is not opened, and every name below the data directory is built from numbers
//! PostgreSQL wrote. The databases a plan reads are the real directories of `base/` (at most
//! `MAX_DATABASES`, lowest OID first), whatever `autoprewarm.blocks` names: a line for another
//! database is dropped before it costs a lookup. The directory entries, the files planned, the
//! files a list names that are not there (each is a lookup that leaves a negative dentry) and the
//! bytes and lines of the list are bounded, and the planning stops at a budget and a cancel as the
//! issuing does (a plan that was stopped reports `budget`, `cancelled` or `bounded`).
use crate::{
    cache,
    pg_control::{ControlFile, Lsn, parse_control_file},
    sleep::is_segment,
};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
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
/// Absent files of a list at which its plan stops: a real list names a few hundred relations, and
/// a stale one a few that were dropped since. Each absent name is a lookup that leaves a negative
/// dentry in a directory the database's user owns.
const MAX_ABSENT: u64 = 512;
/// `autoprewarm.blocks` read at most. A real list is at most one line per block of the shared
/// buffers, about 6 MB for 128 MiB of them.
const MAX_LIST_BYTES: u64 = 32 << 20;
/// Lines a list may name.
const MAX_LIST_BLOCKS: usize = 1 << 20;
/// Lines of a list parsed between two looks at the budget and the cancel.
const HALT_EVERY: usize = 4096;
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
    /// Files that the plan named and that were not there: a list of an older database, or a
    /// catalog that was rewritten to a file number that only `pg_class` knows.
    missing: u64,
    /// Why the plan is not all the data directory names: the budget or the cancel of the planning,
    /// or one of its bounds.
    cut: Option<Stop>,
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

/// Why the planning or the issuing ended before the data directory's files were all advised: the
/// reason that cut the plan, unless the issuing ended for another one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stop {
    /// The plan is whole and every piece of it was advised.
    Done,
    Budget,
    /// Only the issuing has a byte bound.
    Bytes,
    Cancelled,
    /// Only the planning has this: it stopped at one of its bounds, the files in the plan or the
    /// files a list names that are not there.
    Bounded,
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
            Self::Bounded => "bounded",
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
    /// Files that the plan named and found missing: the files of a list that are gone, and the
    /// catalogs of a catalog set whose main fork is not at the file number the plan reads (the
    /// ones `VACUUM FULL` or `REINDEX` moved, other than the mapped ones).
    pub missing: u64,
    /// Files that could not be opened when they were issued (gone, replaced by a link or a pipe,
    /// or below a directory that became a link).
    pub skipped: u64,
    /// The pieces of at most `PIECE` the issuing looked at and the bytes they cover.
    pub pieces: u64,
    pub issued_bytes: u64,
    /// The pieces among them that the kernel was asked to read: a piece that the page cache holds
    /// entirely is not (a pass over a resident set is `advised` 0 and reads nothing).
    pub advised: u64,
    /// Of the bytes looked at, those that the page cache already held; `None` where the kernel
    /// cannot say (before Linux 6.5, or another system).
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
        cache::cachestat_range(file, offset, length).ok()
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

/// The WAL a start reads first, as `(segment, spans)` with the spans ascending and merged: a
/// window of `WAL_WINDOW` at the block of the latest checkpoint record, and, where a crash left
/// the redo point earlier, a window at the block of that. The redo point of a clean stop is the
/// record's own; one that is 0 or lies after the record is none.
fn wal_windows(file: &ControlFile, segment_bytes: u64) -> Vec<(String, Vec<(u64, u64)>)> {
    let mut positions = vec![file.checkpoint];
    if file.redo != 0 && file.redo < file.checkpoint {
        positions.push(file.redo);
    }
    let mut windows: Vec<(String, Vec<(u64, u64)>)> = Vec::new();
    for position in positions {
        let name = Lsn(position).segment(file.control.timeline, segment_bytes);
        let from = position % segment_bytes / BLOCK * BLOCK;
        let span = (from, (from + WAL_WINDOW).min(segment_bytes));
        match windows.iter_mut().find(|(known, _)| *known == name) {
            Some((_, spans)) => spans.push(span),
            None => windows.push((name, vec![span])),
        }
    }
    for (_, spans) in &mut windows {
        spans.sort_unstable();
        // Windows that touch or overlap are one.
        let mut merged: Vec<(u64, u64)> = Vec::new();
        for &(from, to) in spans.iter() {
            match merged.last_mut() {
                Some((_, end)) if from <= *end => *end = (*end).max(to),
                _ => merged.push((from, to)),
            }
        }
        *spans = merged;
    }
    windows
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
fn parse_blocks(bytes: &[u8], halt: &Halt) -> Option<Vec<Block>> {
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
        // A parse that has to stop returns the lines read so far; the plan is cut at its first step.
        if blocks.len() % HALT_EVERY == 0 && halt.check() {
            return Some(blocks);
        }
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

/// What stops a plan being made: a budget and a cancel, asked as the issuing asks them. The first
/// reason is kept.
struct Halt<'a> {
    started: Instant,
    budget: Duration,
    cancel: &'a AtomicBool,
    stopped: Cell<Option<Stop>>,
}
impl<'a> Halt<'a> {
    fn new(started: Instant, budget: Duration, cancel: &'a AtomicBool) -> Self {
        Self {
            started,
            budget,
            cancel,
            stopped: Cell::new(None),
        }
    }
    /// Whether the planning has to stop now.
    fn check(&self) -> bool {
        if self.stopped.get().is_none() {
            if self.cancel.load(Ordering::Relaxed) {
                self.stopped.set(Some(Stop::Cancelled));
            } else if self.started.elapsed() >= self.budget {
                self.stopped.set(Some(Stop::Budget));
            }
        }
        self.stopped.get().is_some()
    }
}

/// A directory of the data directory that a plan names.
struct Directory {
    relative: PathBuf,
    /// Whether it is a directory, none of its parts a link, when the plan named it.
    real: bool,
}

/// Whether a file was added to the plan.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Added {
    Planned,
    /// There is no such file.
    Absent,
    /// The file is there and nothing of it is inside its length: a catalog with no rows, or a
    /// relation that was truncated since the list was written.
    Empty,
    /// The planning stopped: its budget or cancel, or a bound of the plan.
    Stopped,
}

/// A plan being made.
struct Builder<'a> {
    data: PathBuf,
    halt: Halt<'a>,
    directories: Vec<Directory>,
    /// `directories` by their path relative to the data directory.
    index: HashMap<String, usize>,
    targets: Vec<Target>,
    bytes: u64,
    missing: u64,
    /// A bound of the plan was reached.
    bounded: bool,
}
impl<'a> Builder<'a> {
    fn new(data: &Path, started: Instant, budget: Duration, cancel: &'a AtomicBool) -> Self {
        Self {
            data: data.to_path_buf(),
            halt: Halt::new(started, budget, cancel),
            directories: Vec::new(),
            index: HashMap::new(),
            targets: Vec::new(),
            bytes: 0,
            missing: 0,
            bounded: false,
        }
    }

    /// Whether nothing more is to be planned: the budget, the cancel or a bound.
    fn stopped(&self) -> bool {
        self.bounded || self.halt.check()
    }

    /// The index of the directory `relative` to the data directory; a link or a file in its
    /// place gives a directory that has no files.
    fn directory(&mut self, relative: &str) -> usize {
        if let Some(found) = self.index.get(relative) {
            return *found;
        }
        let real = real_directory(&self.data, Path::new(relative));
        self.directories.push(Directory {
            relative: PathBuf::from(relative),
            real,
        });
        self.index
            .insert(relative.to_string(), self.directories.len() - 1);
        self.directories.len() - 1
    }

    /// The user databases of the data directory, lowest OID first: the directories of `base/`
    /// (not links, not files) named by a number from the first user database on, at most
    /// `MAX_DATABASES`. What a plan reads below `base/` is chosen from these and from nothing a
    /// list or a file says.
    fn databases(&self) -> Vec<u32> {
        let mut oids: Vec<u32> = cache::subdirectories(&self.data.join("base"))
            .iter()
            .filter_map(|name| number(name))
            .filter(|oid| *oid >= FIRST_USER_DATABASE)
            .collect();
        oids.sort_unstable();
        oids.truncate(MAX_DATABASES);
        oids
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
        if self.stopped() {
            return Added::Stopped;
        }
        if self.targets.len() >= MAX_FILES {
            self.bounded = true;
            return Added::Stopped;
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
            return Added::Empty;
        }
        self.bytes += spans.iter().map(|(from, to)| to - from).sum::<u64>();
        self.targets.push(Target {
            directory,
            name: name.to_string(),
            spans,
        });
        Added::Planned
    }

    /// `pg_control` and the WAL at the latest checkpoint record and redo point: what PostgreSQL
    /// reads first.
    fn control_and_wal(&mut self) {
        let global = self.directory("global");
        self.add(global, "pg_control", None);
        if self.stopped() {
            return;
        }
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
        for (name, spans) in wal_windows(&control, segment_bytes) {
            self.add(wal, &name, Some(&spans));
        }
    }

    /// The last segment of an SLRU directory (`pg_xact`, `pg_multixact/offsets`): the one that
    /// holds the transaction or multixact the start continues from. The names are hexadecimal
    /// and as long as each other, so the greatest is the last.
    fn last_segment(&mut self, relative: &str) {
        let directory = self.directory(relative);
        let last = self
            .names(directory)
            .into_iter()
            .filter(|name| !name.is_empty() && name.bytes().all(|b| b.is_ascii_hexdigit()))
            .max_by_key(|name| (name.len(), name.clone()));
        if let Some(last) = last {
            self.add(directory, &last, None);
        }
    }

    /// What PostgreSQL reads between its exec and its ready (a strace of 18.6): the configuration,
    /// `pg_control` and the WAL at the checkpoint, the SLRU segments, the statistics and the
    /// replication origins the startup process restores, and `global/`.
    fn start(&mut self) {
        self.control_and_wal();
        if self.stopped() {
            return;
        }
        let root = self.directory("");
        for name in [
            "postgresql.conf",
            "postgresql.auto.conf",
            "pg_hba.conf",
            "pg_ident.conf",
            "PG_VERSION",
        ] {
            self.add(root, name, None);
        }
        for slru in ["pg_xact", "pg_multixact/offsets", "pg_multixact/members"] {
            self.last_segment(slru);
        }
        for (relative, name) in [
            ("pg_stat", "pgstat.stat"),
            ("pg_logical", "replorigin_checkpoint"),
        ] {
            let directory = self.directory(relative);
            self.add(directory, name, None);
        }
        let global = self.directory("global");
        // `pg_control` is planned first. `pg_internal.init` is removed at every start of
        // PostgreSQL, so a read of it is wasted.
        for name in self.names(global) {
            if name != "pg_control" && name != "pg_internal.init" {
                self.add(global, &name, None);
            }
        }
    }

    /// The catalogs of the user databases.
    fn catalog(&mut self) {
        for oid in self.databases() {
            if self.stopped() {
                break;
            }
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
                    let added = self.add(directory, &format!("{number}{fork}"), None);
                    // Only the main fork is always there. One that is not has been rewritten to a
                    // file number that only `pg_class` records (`VACUUM FULL`, `REINDEX`); the
                    // plan does not read `pg_class`, so it counts the gap and leaves it.
                    if fork.is_empty() && added == Added::Absent {
                        self.missing += 1;
                    }
                }
            }
        }
    }

    /// The blocks of a dump, relation by relation, the relations with the fewest blocks first.
    /// Only the blocks of the shared relations and of the databases that `base/` holds are
    /// planned: a line for any other costs nothing but its parsing.
    fn list(&mut self, mut blocks: Vec<Block>) {
        if self.stopped() {
            return;
        }
        let mut directories = HashMap::new();
        directories.insert(0, self.directory("global"));
        for oid in self.databases() {
            let directory = self.directory(&format!("base/{oid}"));
            directories.insert(oid, directory);
        }
        blocks.retain(|block| block.supported() && directories.contains_key(&block.database));
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
            if self.stopped() {
                return;
            }
            let first = blocks[start];
            let directory = directories[&first.database];
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

    /// Adds one segment file of the relation of `first`; false when the plan stopped: it is full,
    /// it has met `MAX_ABSENT` files that are not there, or the budget or the cancel ended it.
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
            Added::Absent | Added::Empty => {
                self.missing += 1;
                if self.missing >= MAX_ABSENT {
                    self.bounded = true;
                    return false;
                }
            }
            Added::Stopped => return false,
        }
        true
    }

    fn finish(self, started: Instant) -> Plan {
        let cut = self
            .halt
            .stopped
            .get()
            .or(self.bounded.then_some(Stop::Bounded));
        Plan {
            data: self.data,
            directories: self.directories.into_iter().map(|d| d.relative).collect(),
            targets: self.targets,
            bytes: self.bytes,
            missing: self.missing,
            cut,
            plan_us: micros(started.elapsed()),
        }
    }
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

/// The start set of the data directory `data`: nothing, for a directory that is not there or is
/// a link. About 1 MB. The planning stops at `budget` and at `cancel`, as the issuing does, and
/// the plan says so (`Report::stop`).
pub fn start(data: &Path, budget: Duration, cancel: &AtomicBool) -> Plan {
    let started = Instant::now();
    let mut builder = Builder::new(data, started, budget, cancel);
    if cache::is_directory(data) {
        builder.start();
    }
    builder.finish(started)
}

/// The catalog set of the data directory `data`: nothing, for a directory that is not there or is
/// a link. About 5 MB for a database with its own small schema. The planning stops as that of
/// `start` does.
pub fn catalog(data: &Path, budget: Duration, cancel: &AtomicBool) -> Plan {
    let started = Instant::now();
    let mut builder = Builder::new(data, started, budget, cancel);
    if cache::is_directory(data) {
        builder.catalog();
    }
    builder.finish(started)
}

/// The files of `paths`, whole, by the file each path leads to (a link is followed once, here; a
/// file that two paths lead to is planned once). A path that leads to no regular file is counted
/// in `Report::missing`. The files are not the database user's, so the links of a data directory
/// are not in question; the planning stops as that of `start` does.
pub fn files(paths: &[PathBuf], budget: Duration, cancel: &AtomicBool) -> Plan {
    let started = Instant::now();
    let mut builder = Builder::new(Path::new("/"), started, budget, cancel);
    let mut seen = HashSet::new();
    for path in paths {
        if builder.stopped() {
            break;
        }
        let real = std::fs::canonicalize(path).ok();
        let placed = real.as_deref().and_then(|real| {
            let parent = real.parent()?.strip_prefix("/").ok()?.to_str()?;
            Some((parent, real.file_name()?.to_str()?))
        });
        let Some((parent, name)) = placed else {
            builder.missing += 1;
            continue;
        };
        if !seen.insert(real.clone()) {
            continue;
        }
        let directory = builder.directory(parent);
        if builder.add(directory, name, None) == Added::Absent {
            builder.missing += 1;
        }
    }
    builder.finish(started)
}

/// The hot list of the data directory `data`, from its `autoprewarm.blocks`. The planning stops at
/// `budget` and at `cancel`; what it plans is bounded by the files the data directory holds
/// whatever the list names (`MAX_DATABASES`, `MAX_FILES`, `MAX_ABSENT`).
pub fn list(data: &Path, budget: Duration, cancel: &AtomicBool) -> Result<Plan, Unavailable> {
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
    let mut builder = Builder::new(data, started, budget, cancel);
    let blocks = parse_blocks(&bytes, &builder.halt).ok_or(Unavailable::Unreadable)?;
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
            stop: self.cut.unwrap_or(Stop::Done),
            files: self.targets.len() as u64,
            planned_bytes: self.bytes,
            missing: self.missing,
            skipped: 0,
            pieces: 0,
            issued_bytes: 0,
            advised: 0,
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
                    // A piece the cache holds entirely has nothing to read.
                    let resident = held.is_some_and(|pages| pages >= piece.div_ceil(page));
                    if !resident {
                        if kernel.advise(&file, at, piece).is_err() {
                            report.stop = Stop::Failed;
                            break 'targets;
                        }
                        report.advised += 1;
                    }
                    report.resident_bytes = report
                        .resident_bytes
                        .zip(held)
                        .map(|(sum, pages)| sum + (pages * page).min(piece));
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
        pg_control::Control,
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
        /// Pieces that begin below this offset are in the cache entirely, and the others not at
        /// all (the kernel can say); it takes the place of `held`.
        warm_below: Option<u64>,
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
        fn resident(&mut self, _file: &File, offset: u64, length: u64) -> Option<u64> {
            match self.warm_below {
                Some(below) if offset < below => Some(length.div_ceil(cache::page_size())),
                Some(_) => Some(0),
                None => self.held,
            }
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
    /// The plans, with a budget that nothing in a test reaches.
    fn make_catalog(data: &Path) -> Plan {
        catalog(data, Duration::from_secs(600), &no_cancel())
    }
    fn make_start(data: &Path) -> Plan {
        start(data, Duration::from_secs(600), &no_cancel())
    }
    /// What the start set and the catalog set name, in this order.
    fn both(data: &Path) -> Vec<String> {
        let mut all = names(&make_start(data));
        all.extend(names(&make_catalog(data)));
        all
    }
    fn make_list(data: &Path) -> Result<Plan, Unavailable> {
        list(data, Duration::from_secs(600), &no_cancel())
    }
    fn parse(bytes: &[u8]) -> Option<Vec<Block>> {
        let never = no_cancel();
        parse_blocks(
            bytes,
            &Halt::new(Instant::now(), Duration::from_secs(600), &never),
        )
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
                let directory = plan.directories[t.directory].display().to_string();
                let name = if directory.is_empty() {
                    t.name.clone()
                } else {
                    format!("{directory}/{}", t.name)
                };
                (name, t.spans.clone())
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
        let plan = make_list(&data).unwrap();
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
        let ok = parse(b"<<2>>\n5,1663,1259,0,0\n16384,1663,16500,3,131072\n").unwrap();
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
        assert_eq!(parse(b"<<0>>\n").unwrap(), []);
        // The last line may lack its newline; blocks up to the largest 32-bit number are blocks.
        assert_eq!(
            parse(b"<<1>>\n1,2,3,0,4294967295").unwrap()[0].block,
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
            assert_eq!(parse(bad), None, "{what}");
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

        let plan = make_list(&data).unwrap();
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

    /// The window of the WAL that a start reads: at the checkpoint record, and at the redo point
    /// where a crash would replay from.
    #[test]
    fn the_wal_a_start_reads_is_the_window_at_the_checkpoint_and_at_the_redo_point() {
        let file = |checkpoint: u64, redo: u64| ControlFile {
            control: Control {
                state: 1,
                system_identifier: "1".into(),
                timeline: 1,
            },
            checkpoint,
            redo,
        };
        let segment = 16 << 20;
        let name = |number: u64| format!("00000001{:08X}{:08X}", number / 256, number % 256);
        let window = WAL_WINDOW;
        // A clean stop: the redo point is the record's own, and there is one window at its block.
        assert_eq!(
            wal_windows(&file(0x0300_5A40, 0x0300_5A40), segment),
            [(name(3), vec![(0x4000, 0x4000 + window)])]
        );
        // A crash in the same segment: a window at each when they are far apart, in the order
        // of the file, and one window when the second begins inside the first.
        let far = wal_windows(&file(0x0320_0040, 0x0300_5A40), segment);
        assert_eq!(
            far,
            [(
                name(3),
                vec![(0x4000, 0x4000 + window), (0x20_0000, 0x20_0000 + window)]
            )]
        );
        let near = wal_windows(&file(0x0301_0040, 0x0300_5A40), segment);
        assert_eq!(near, [(name(3), vec![(0x4000, 0x1_0000 + window)])]);
        // A redo point in the segment before: the checkpoint's segment first, and the window at
        // the end of the earlier one cut where the segment ends.
        let before = wal_windows(&file(0x0300_5A40, 0x02FF_F040), segment);
        assert_eq!(
            before,
            [
                (name(3), vec![(0x4000, 0x4000 + window)]),
                (name(2), vec![(0xFF_E000, segment)]),
            ]
        );
        // A redo point that is none (0) or lies after the checkpoint is not used.
        for redo in [0, 0x0300_5A41, 0x0900_0000] {
            assert_eq!(
                wal_windows(&file(0x0300_5A40, redo), segment),
                [(name(3), vec![(0x4000, 0x4000 + window)])],
                "redo {redo:x}"
            );
        }
        // The timeline is the checkpoint's.
        let mut later = file(0x0300_5A40, 0x0300_5A40);
        later.control.timeline = 2;
        assert_eq!(
            wal_windows(&later, segment)[0].0,
            "000000020000000000000003"
        );
    }

    #[test]
    fn the_start_set_takes_what_postgresql_reads_between_its_exec_and_its_ready() {
        let data = data("prefetch-start");
        // A checkpoint at 0x0300_5A40 of timeline 1, 16 MiB segments: segment 3, offset 0x5A40.
        fs::write(data.join("global/pg_control"), control(0x0300_5A40)).unwrap();
        sparse(data.join("pg_wal/000000010000000000000003"), 16 << 20);
        sparse(data.join("pg_wal/000000010000000000000004"), 16 << 20);
        for (name, length) in [
            ("postgresql.conf", 2048),
            ("postgresql.auto.conf", 88),
            ("pg_hba.conf", 150),
            ("pg_ident.conf", 120),
            ("PG_VERSION", 3),
            // Written by the start, never read.
            ("postmaster.opts", 100),
            ("postmaster.pid", 80),
        ] {
            sparse(data.join(name), length);
        }
        // The segment that holds the next transaction ID is the last one: 000A is after 0009.
        for (dir, segments) in [
            ("pg_xact", &["0000", "0009", "000A"][..]),
            ("pg_multixact/offsets", &["0000"]),
            ("pg_multixact/members", &["0000", "0001"]),
        ] {
            fs::create_dir_all(data.join(dir)).unwrap();
            for segment in segments {
                sparse(data.join(dir).join(segment), 256 << 10);
            }
        }
        fs::create_dir_all(data.join("pg_stat")).unwrap();
        sparse(data.join("pg_stat/pgstat.stat"), 40_000);
        fs::create_dir_all(data.join("pg_logical")).unwrap();
        sparse(data.join("pg_logical/replorigin_checkpoint"), 4);
        sparse(data.join("global/1260"), 8 * BLOCK);
        sparse(data.join("global/pg_filenode.map"), 524);
        // Removed at every start of PostgreSQL, so a read of it is wasted.
        sparse(data.join("global/pg_internal.init"), 4096);
        // The catalogs of a user database are the other set's.
        sparse(data.join("base/16384/1259"), 3 * BLOCK);

        let plan = make_start(&data);
        assert_eq!(
            planned(&plan),
            [
                ("global/pg_control".to_string(), vec![(0, 296)]),
                (
                    "pg_wal/000000010000000000000003".to_string(),
                    vec![(0x4000, 0x4000 + (256 << 10))]
                ),
                ("postgresql.conf".to_string(), vec![(0, 2048)]),
                ("postgresql.auto.conf".to_string(), vec![(0, 88)]),
                ("pg_hba.conf".to_string(), vec![(0, 150)]),
                ("pg_ident.conf".to_string(), vec![(0, 120)]),
                ("PG_VERSION".to_string(), vec![(0, 3)]),
                ("pg_xact/000A".to_string(), vec![(0, 256 << 10)]),
                (
                    "pg_multixact/offsets/0000".to_string(),
                    vec![(0, 256 << 10)]
                ),
                (
                    "pg_multixact/members/0001".to_string(),
                    vec![(0, 256 << 10)]
                ),
                ("pg_stat/pgstat.stat".to_string(), vec![(0, 40_000)]),
                ("pg_logical/replorigin_checkpoint".to_string(), vec![(0, 4)]),
                ("global/1260".to_string(), vec![(0, 8 * BLOCK)]),
                ("global/pg_filenode.map".to_string(), vec![(0, 524)]),
            ]
        );
        assert_eq!(plan.missing, 0);
        // What is not there (no list of statistics after a crash) is no gap to report.
        let bare = self::data("prefetch-start-bare");
        fs::write(bare.join("global/pg_control"), control(0x0100_0100)).unwrap();
        assert_eq!(names(&make_start(&bare)), ["global/pg_control"]);
        // A directory that is a link is not followed.
        let outside = testpg::directory("prefetch-start-outside");
        sparse(outside.join("0000"), 4096);
        fs::remove_dir_all(data.join("pg_xact")).unwrap();
        symlink(&outside, data.join("pg_xact")).unwrap();
        assert!(
            !names(&make_start(&data))
                .iter()
                .any(|name| name.starts_with("pg_xact"))
        );
        assert_eq!(make_start(&data.join("missing")).targets.len(), 0);
    }

    #[test]
    fn the_catalog_set_takes_the_catalogs_of_user_databases_through_the_map() {
        let data = data("prefetch-catalog");
        fs::write(data.join("global/pg_control"), control(0x0300_5A40)).unwrap();
        sparse(data.join("global/1260"), 8 * BLOCK);
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
        // A catalog with no rows is a file of no length: it is there, and there is nothing to read.
        sparse(data.join("base/16384/2663"), 0);
        // The system databases are left out.
        sparse(data.join("base/1/1259"), 3 * BLOCK);
        sparse(data.join("base/5/1259"), 3 * BLOCK);

        let plan = make_catalog(&data);
        assert_eq!(
            planned(&plan),
            [
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
        // files are not in it. The main forks of the catalogs that are not there are counted as
        // missing, the way a list counts the files it names that are gone: the 60 catalogs less
        // pg_class (through the map), pg_attribute, 2662 and the empty 2663. The forks of a catalog
        // are mostly absent and are not counted.
        assert_eq!(plan.missing, (CATALOGS.len() - 4) as u64);
        assert_eq!(make_catalog(&data.join("missing")).targets.len(), 0);
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
        let plan = make_list(&data).unwrap();

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

    /// A pass over pages that the cache holds reads nothing: it counts them and advises no piece.
    #[test]
    fn a_piece_the_cache_holds_entirely_is_not_advised() {
        let data = data("prefetch-resident");
        sparse(data.join("base/16384/16500"), 10 << 20);
        let all: Vec<_> = (0..1280).map(|b| (16384, 1663, 16500, 0, b)).collect();
        dump(&data, &all);
        let plan = make_list(&data).unwrap();
        let minute = limits(Duration::from_secs(60));
        let page = cache::page_size();

        // Every piece resident: 80 pieces looked at, none advised.
        let mut warm = Model {
            warm_below: Some(u64::MAX),
            ..Model::default()
        };
        let report = plan.issue_with(minute, &no_cancel(), &mut warm);
        assert_eq!(
            (
                report.stop,
                report.pieces,
                report.advised,
                report.issued_bytes
            ),
            (Stop::Done, 80, 0, 10 << 20)
        );
        assert_eq!(report.resident_bytes, Some(10 << 20));
        assert!(warm.calls.is_empty());

        // The first half resident: only the second half is advised, from where it begins.
        let mut half = Model {
            warm_below: Some(5 << 20),
            ..Model::default()
        };
        let report = plan.issue_with(minute, &no_cancel(), &mut half);
        assert_eq!((report.pieces, report.advised), (80, 40));
        assert_eq!(half.calls.len(), 40);
        assert_eq!(half.calls[0], (5 << 20, PIECE));
        assert_eq!(report.resident_bytes, Some(5 << 20));

        // A piece that is one page short of resident is advised, and so is one the kernel cannot
        // count.
        let mut short = Model {
            held: Some(PIECE / page - 1),
            ..Model::default()
        };
        assert_eq!(
            plan.issue_with(minute, &no_cancel(), &mut short).advised,
            80
        );
        let report = plan.issue_with(minute, &no_cancel(), &mut Model::default());
        assert_eq!((report.advised, report.resident_bytes), (80, None));
    }

    /// The program of PostgreSQL is planned by the files themselves: a link leads to the file it
    /// names, which is planned once.
    #[test]
    fn files_are_planned_whole_once_by_the_path_a_link_leads_to_and_the_gaps_are_counted() {
        let dir = testpg::directory("prefetch-files").canonicalize().unwrap();
        sparse(dir.join("libreal.so.1.2"), 5 * BLOCK);
        symlink("libreal.so.1.2", dir.join("libreal.so.1")).unwrap();
        sparse(dir.join("other"), BLOCK);
        sparse(dir.join("empty"), 0);
        fs::create_dir(dir.join("directory")).unwrap();
        let paths = [
            dir.join("libreal.so.1"),
            dir.join("libreal.so.1.2"),
            dir.join("other"),
            dir.join("absent"),
            dir.join("directory"),
            dir.join("empty"),
        ];
        let plan = files(&paths, Duration::from_secs(60), &no_cancel());
        let relative = dir.strip_prefix("/").unwrap().display().to_string();
        assert_eq!(
            planned(&plan),
            [
                (format!("{relative}/libreal.so.1.2"), vec![(0, 5 * BLOCK)]),
                (format!("{relative}/other"), vec![(0, BLOCK)]),
            ]
        );
        // The file that is not there and the directory are gaps; an empty file is not.
        assert_eq!((plan.bytes, plan.missing), (6 * BLOCK, 2));
        let report = plan.issue_with(
            limits(Duration::from_secs(60)),
            &no_cancel(),
            &mut Model::default(),
        );
        assert_eq!(
            (report.stop, report.files, report.pieces),
            (Stop::Done, 2, 2)
        );
        // The same budget and cancel as the other plans.
        let cancel = AtomicBool::new(true);
        let stopped = files(&paths, Duration::from_secs(60), &cancel);
        assert_eq!(
            (stopped.targets.len(), stopped.cut),
            (0, Some(Stop::Cancelled))
        );
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
            assert_eq!(both(&data), expected, "{place}");
        }
        let data = data("prefetch-link-database");
        let outside = testpg::directory("prefetch-outside");
        sparse(outside.join("PG_VERSION"), 3);
        sparse(outside.join("16500"), 8192);
        fs::remove_dir_all(data.join("base/16384")).unwrap();
        symlink(&outside, data.join("base/16384")).unwrap();
        assert_eq!(both(&data), Vec::<String>::new());
        dump(&data, &[(16384, 1663, 16500, 0, 0)]);
        let plan = make_list(&data).unwrap();
        // A line for a database that is a link is dropped: that database is not planned.
        assert_eq!((plan.targets.len(), plan.missing), (0, 0));
        // The data directory itself, and a list that is a link.
        let real = self::data("prefetch-link-data");
        sparse(real.join("base/16384/16500"), 8192);
        dump(&real, &[(16384, 1663, 16500, 0, 0)]);
        let linked = testpg::directory("prefetch-linked").join("data");
        symlink(&real, &linked).unwrap();
        assert_eq!(names(&make_list(&real).unwrap()), ["base/16384/16500"]);
        assert_eq!(make_list(&linked).err(), Some(Unavailable::Missing));
        assert_eq!(both(&linked), Vec::<String>::new());
        let other = testpg::directory("prefetch-other").join("list");
        fs::copy(real.join("autoprewarm.blocks"), &other).unwrap();
        fs::remove_file(real.join("autoprewarm.blocks")).unwrap();
        symlink(&other, real.join("autoprewarm.blocks")).unwrap();
        assert_eq!(make_list(&real).err(), Some(Unavailable::Unreadable));
        fs::remove_file(real.join("autoprewarm.blocks")).unwrap();
        assert_eq!(make_list(&real).err(), Some(Unavailable::Missing));

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
        let plan = make_list(&data).unwrap();
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

    /// The database's own user writes `autoprewarm.blocks` and owns the directories it names
    /// (the threat model of `cache.rs`), and the agent plans as root in a thread of the node's
    /// blocking pool: a list of one line per database that is not there, or per file that is not
    /// there, must cost a plan that is bounded by what the data directory really holds. Before the
    /// bounds, 5,000 such lines took 1.6 s, 20,000 took 26 s and 40,000 (680 KB) took 109 s, as the
    /// time grew with the square of the lines.
    #[test]
    fn a_crafted_list_costs_a_plan_bounded_by_what_the_data_directory_holds() {
        let data = data("prefetch-crafted");
        sparse(data.join("base/16384/16500"), 8 * BLOCK);
        // 5,000 databases that are not there, 5,000 files that are not in the one that is, and
        // the one block of a file that is.
        let mut blocks: Vec<_> = (0..5000).map(|n| (20_000 + n, 1663, 16500, 0, 0)).collect();
        blocks.extend((0..5000).map(|n| (16384, 1663, 30_000 + n, 0, 0)));
        blocks.push((16384, 1663, 16500, 0, 0));
        dump(&data, &blocks);

        let plan = make_list(&data).unwrap();
        // Only directories of the data directory are planned, never one a line made up.
        assert!(
            plan.directories.len() <= MAX_DATABASES + 2,
            "{} directories",
            plan.directories.len()
        );
        // The files that are not there are counted to a bound, where the plan stops and says so.
        assert_eq!(plan.missing, MAX_ABSENT);
        assert_eq!(names(&plan), ["base/16384/16500"]);
        let report = plan.issue_with(
            limits(Duration::from_secs(60)),
            &no_cancel(),
            &mut Model::default(),
        );
        assert_eq!(
            (report.stop, report.missing, report.pieces),
            (Stop::Bounded, MAX_ABSENT, 1)
        );

        // A link, a file or a pipe in `base/` is no database either, and neither are more than
        // `MAX_DATABASES` real ones: the lowest are planned.
        let data = self::data("prefetch-crafted-databases");
        let outside = testpg::directory("prefetch-crafted-outside");
        sparse(outside.join("16500"), 8 * BLOCK);
        symlink(&outside, data.join("base/16385")).unwrap();
        sparse(data.join("base/16386"), 8 * BLOCK);
        let mut blocks = vec![
            (16385, 1663, 16500, 0, 0),
            (16386, 1663, 16500, 0, 0),
            (16384, 1663, 16500, 0, 0),
        ];
        sparse(data.join("base/16384/16500"), 8 * BLOCK);
        for oid in 20_000..20_000 + 2 * MAX_DATABASES as u32 {
            fs::create_dir_all(data.join(format!("base/{oid}"))).unwrap();
            sparse(data.join(format!("base/{oid}/16500")), 8 * BLOCK);
            blocks.push((oid, 1663, 16500, 0, 0));
        }
        dump(&data, &blocks);
        let plan = make_list(&data).unwrap();
        let planned = names(&plan);
        assert_eq!(planned.len(), MAX_DATABASES);
        assert_eq!(planned[0], "base/16384/16500");
        assert_eq!(planned[MAX_DATABASES - 1], "base/20030/16500");
        assert_eq!(plan.missing, 0);
        assert!(make_catalog(&data).directories.len() <= MAX_DATABASES + 2);

        // So many files that are there, one block each, as the plan holds at most.
        let data = self::data("prefetch-crafted-files");
        let blocks: Vec<_> = (0..MAX_FILES as u32 + 100)
            .map(|n| {
                sparse(data.join(format!("base/16384/{}", 30_000 + n)), BLOCK);
                (16384, 1663, 30_000 + n, 0, 0)
            })
            .collect();
        dump(&data, &blocks);
        let plan = make_list(&data).unwrap();
        assert_eq!(
            (plan.targets.len(), plan.cut),
            (MAX_FILES, Some(Stop::Bounded))
        );
    }

    /// The planning has the budget and the cancel the issuing has, and a plan that was stopped
    /// says why in its report.
    #[test]
    fn planning_stops_at_its_budget_and_at_a_cancel_and_the_plan_says_so() {
        let data = data("prefetch-plan-stops");
        fs::write(data.join("global/pg_control"), control(0x0100_0100)).unwrap();
        sparse(data.join("pg_wal/000000010000000000000001"), 16 << 20);
        sparse(data.join("base/16384/16500"), 10 << 20);
        sparse(data.join("base/16384/16501"), 10 << 20);
        dump(
            &data,
            &[(16384, 1663, 16500, 0, 0), (16384, 1663, 16501, 0, 0)],
        );
        let minute = Duration::from_secs(60);
        let issued =
            |plan: &Plan| plan.issue_with(limits(minute), &no_cancel(), &mut Model::default());

        // Not stopped: both files and `Done`.
        let plan = make_list(&data).unwrap();
        assert_eq!((plan.targets.len(), plan.cut), (2, None));
        assert_eq!(issued(&plan).stop, Stop::Done);
        // A budget of nothing plans nothing, in the list and in the start and catalog sets.
        for plan in [
            list(&data, Duration::ZERO, &no_cancel()).unwrap(),
            start(&data, Duration::ZERO, &no_cancel()),
            catalog(&data, Duration::ZERO, &no_cancel()),
        ] {
            assert_eq!((plan.targets.len(), plan.cut), (0, Some(Stop::Budget)));
            let report = issued(&plan);
            assert_eq!(
                (report.stop, report.files, report.pieces),
                (Stop::Budget, 0, 0)
            );
        }
        // A cancel that is up plans nothing, and the issuing does not start either.
        let cancel = AtomicBool::new(true);
        for plan in [
            list(&data, minute, &cancel).unwrap(),
            start(&data, minute, &cancel),
            catalog(&data, minute, &cancel),
        ] {
            assert_eq!((plan.targets.len(), plan.cut), (0, Some(Stop::Cancelled)));
            let report = plan.issue_with(limits(minute), &cancel, &mut Model::default());
            assert_eq!((report.stop, report.pieces), (Stop::Cancelled, 0));
        }
        // The first reason is kept: a flag that goes down again does not start the planning again.
        let flag = AtomicBool::new(true);
        let halt = Halt::new(Instant::now(), minute, &flag);
        assert!(halt.check());
        flag.store(false, Ordering::Relaxed);
        assert!(halt.check());
        assert_eq!(halt.stopped.get(), Some(Stop::Cancelled));
        // A list that is cut while it is read, a long one: the lines read are not planned.
        let lines = HALT_EVERY * 3;
        let mut text = format!("<<{lines}>>\n");
        for n in 0..lines {
            text += &format!("16384,1663,16500,0,{n}\n");
        }
        let cancel = AtomicBool::new(true);
        let halt = Halt::new(Instant::now(), minute, &cancel);
        assert_eq!(parse_blocks(text.as_bytes(), &halt), Some(Vec::new()));
        assert_eq!(parse(text.as_bytes()).unwrap().len(), lines);
    }

    // The real PostgreSQL 18 tests.

    /// A stopped cluster of the agent's layout with the user database `app`, a table with an
    /// index, catalogs rewritten by `VACUUM FULL` (two mapped ones, and two that are not mapped,
    /// which only `pg_class` knows the new file of), and what PostgreSQL says of its files.
    struct Real {
        cluster: Cluster,
        /// `app`'s OID.
        database: u32,
        /// `pg_relation_filepath` of each catalog of `CATALOGS` in `app`.
        catalogs: Vec<(u32, String)>,
        /// The catalogs of `CATALOGS` that are at a file number other than their oid and are not
        /// in `pg_filenode.map`: `pg_class.relfilenode` is neither 0 (a mapped catalog) nor the oid.
        rewritten: Vec<u32>,
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
        // Two catalogs that PostgreSQL rewrites to a file number of their own and records in the
        // map, and two that it rewrites to one that only `pg_class` records (each with its indexes).
        app.batch_long("VACUUM FULL pg_class").await.unwrap();
        app.batch_long("VACUUM FULL pg_proc").await.unwrap();
        app.batch_long("VACUUM FULL pg_namespace").await.unwrap();
        app.batch_long("VACUUM FULL pg_index").await.unwrap();
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
                "SELECT oid::pg_catalog.int8, pg_relation_filepath(oid), relfilenode::pg_catalog.int8 FROM pg_class WHERE oid::pg_catalog.int8 = ANY($1)",
                &[&oids],
            )
            .await
            .unwrap();
        let oid_of = |row: &tokio_postgres::Row| u32::try_from(row.get::<_, i64>(0)).unwrap();
        let catalogs = rows
            .iter()
            .map(|row| (oid_of(row), row.get::<_, String>(1)))
            .collect();
        let rewritten = rows
            .iter()
            .filter(|row| row.get::<_, i64>(2) != 0 && row.get::<_, i64>(2) != row.get::<_, i64>(0))
            .map(oid_of)
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
            rewritten,
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
        // Every catalog of the list is a relation of PostgreSQL 18. Two of them are mapped and are
        // not at the file number of their oid: without the map the plan would name the old files.
        // Six more (pg_namespace and pg_index with their indexes) are not mapped and are not at
        // their oid either: only `pg_class` records where they are.
        assert_eq!(real.catalogs.len(), CATALOGS.len());
        assert_eq!(real.rewritten.len(), 6, "{:?}", real.rewritten);
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

        let plan = make_catalog(&data);
        let planned = names(&plan);
        // Every catalog with something in it is planned at the file PostgreSQL names, through the
        // map or at its oid; an empty one (nothing in `pg_attrdef`) has nothing to read. A catalog
        // that was rewritten and is not mapped is not planned: the plan reads no `pg_class`, and
        // its old file is gone.
        let mut with_content = 0;
        for (oid, path) in &real.catalogs {
            if fs::metadata(data.join(path)).is_ok_and(|m| m.len() > 0) {
                if real.rewritten.contains(oid) {
                    assert!(!planned.contains(path), "catalog {oid} at {path}");
                    continue;
                }
                with_content += 1;
                assert!(
                    planned.contains(path),
                    "catalog {oid} at {path} is not planned"
                );
            }
        }
        assert!(with_content > CATALOGS.len() / 2, "{with_content}");
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

        // The start set holds what PostgreSQL opens before it is ready, whichever of these the
        // clean stop left in the data directory, and the WAL window is at the checkpoint (and the
        // redo point) that `pg_controldata` reports.
        let start_plan = make_start(&data);
        let started = names(&start_plan);
        for name in [
            "global/pg_control",
            "global/pg_filenode.map",
            "postgresql.conf",
            "postgresql.auto.conf",
            "pg_hba.conf",
            "pg_ident.conf",
            "PG_VERSION",
            "pg_xact/0000",
            "pg_multixact/offsets/0000",
            "pg_multixact/members/0000",
            "pg_logical/replorigin_checkpoint",
        ] {
            assert!(
                data.join(name).exists(),
                "{name} is not in the data directory"
            );
            assert!(
                started.contains(&name.to_string()),
                "{name} is not planned: {started:?}"
            );
        }
        assert!(
            !started
                .iter()
                .any(|name| name.ends_with("pg_internal.init")),
            "{started:?}"
        );
        assert!(
            (64 << 10..4 << 20).contains(&start_plan.bytes),
            "{} bytes",
            start_plan.bytes
        );
        let control = controldata(&real.cluster);
        let checkpoint = control.checkpoint;
        assert_eq!(
            control.redo, control.checkpoint,
            "a clean stop has no earlier redo point"
        );
        let segment_bytes = fs::metadata(
            data.join("pg_wal")
                .join(checkpoint.segment(control.timeline, 16 << 20)),
        )
        .unwrap()
        .len();
        let wal = format!(
            "pg_wal/{}",
            checkpoint.segment(control.timeline, segment_bytes)
        );
        let window = planned_spans(&start_plan, &wal);
        let from = checkpoint.0 % segment_bytes / BLOCK * BLOCK;
        assert_eq!(window, [(from, (from + WAL_WINDOW).min(segment_bytes))]);

        // About 5 MB for a database of its own; the issuing advises all of it on a Linux kernel.
        assert!(
            (1 << 20..16 << 20).contains(&plan.bytes),
            "{} bytes",
            plan.bytes
        );
        // The event shows the gap: the main forks of the rewritten catalogs that are not mapped.
        assert_eq!(plan.missing, real.rewritten.len() as u64);
        #[cfg(target_os = "linux")]
        {
            for plan in [&plan, &start_plan] {
                let report = plan.issue(limits(Duration::from_secs(10)), &no_cancel());
                assert_eq!((report.stop, report.skipped), (Stop::Done, 0), "{report:?}");
                assert_eq!(report.issued_bytes, plan.bytes);
            }
        }
    }

    /// The files of the directories `dirs` that are read (`read(2)`, `pread(2)`) while `during`
    /// runs, as inotify reports them: `IN_ACCESS` on a directory names the file read below it.
    /// Relative to `base`.
    #[cfg(target_os = "linux")]
    fn read_while(base: &Path, dirs: &[PathBuf], during: impl FnOnce()) -> Vec<String> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        // SAFETY: plain calls with valid arguments; the descriptor is closed below.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        assert!(fd >= 0, "inotify_init1: {}", io::Error::last_os_error());
        let mut watched = HashMap::new();
        for dir in dirs.iter().filter(|dir| dir.is_dir()) {
            let path = CString::new(dir.as_os_str().as_bytes()).unwrap();
            // SAFETY: `path` is a NUL-terminated string that lives through the call.
            let wd = unsafe { libc::inotify_add_watch(fd, path.as_ptr(), libc::IN_ACCESS) };
            assert!(wd >= 0, "inotify_add_watch: {}", io::Error::last_os_error());
            watched.insert(wd, dir.clone());
        }
        during();
        let mut read = Vec::new();
        let mut buffer = vec![0u8; 1 << 16];
        loop {
            // SAFETY: the buffer is writable for its length.
            let n = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if n <= 0 {
                break;
            }
            let mut at = 0;
            while at < n as usize {
                let word = |from: usize| {
                    u32::from_ne_bytes(buffer[at + from..at + from + 4].try_into().unwrap())
                };
                let wd = word(0) as i32;
                let length = word(12) as usize;
                let name = &buffer[at + 16..at + 16 + length];
                let name = String::from_utf8_lossy(
                    &name[..name.iter().position(|b| *b == 0).unwrap_or(length)],
                );
                if let Some(dir) = watched.get(&wd) {
                    let path = dir.join(name.as_ref());
                    read.push(path.strip_prefix(base).unwrap().display().to_string());
                }
                at += 16 + length;
            }
        }
        // SAFETY: closing the descriptor opened above.
        unsafe { libc::close(fd) };
        read.sort();
        read.dedup();
        read
    }

    /// The start set names the files a real postmaster reads between its exec and its ready.
    /// inotify reports every read of the directories PostgreSQL's start uses; each file read there
    /// is in the start set, except the few that are not data (the lock file, which the start
    /// reads to check for a postmaster, and the hot list, which is the other set's).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_start_set_names_every_file_a_real_postmaster_reads_before_ready() {
        let Some(real) = real("prefetch-real-start").await else {
            return;
        };
        let (cluster, data) = (&real.cluster, real.cluster.data());
        let directories: Vec<PathBuf> = [
            "",
            "global",
            "pg_wal",
            "pg_xact",
            "pg_multixact/offsets",
            "pg_multixact/members",
            "pg_stat",
            "pg_logical",
            "pg_commit_ts",
            "pg_subtrans",
            "pg_serial",
            "pg_twophase",
        ]
        .iter()
        .map(|dir| data.join(dir))
        .collect();
        let planned = names(&make_start(&data));
        // A directory listed is no file to read ahead (`base`, `pg_notify`, `pg_tblspc`).
        let read: Vec<String> = read_while(&data, &directories, || cluster.start())
            .into_iter()
            .filter(|name| !data.join(name).is_dir())
            .collect();
        // The lock file, which the start reads to check for another postmaster, and the hot list,
        // which the autoprewarm worker reads once the database is ready and is the other set's.
        let allowed = ["postmaster.pid", "autoprewarm.blocks"];
        for name in &read {
            assert!(
                planned.contains(name) || allowed.contains(&name.as_str()),
                "{name} is read by the start and is not in the start set: {planned:?}"
            );
        }
        assert!(read.len() >= 5, "{read:?}");
    }

    /// Tells the kernel to drop the pages of every file below `directory` (`POSIX_FADV_DONTNEED`,
    /// as the prefetch lab did before each cold request) and returns the pages the cache held
    /// before and after, or `None` where the kernel cannot count. Dirty pages are written first,
    /// since a dirty page is not dropped.
    #[cfg(target_os = "linux")]
    fn drop_cache(directory: &Path) -> Option<(u64, u64)> {
        use std::os::fd::AsRawFd;
        fn files(directory: &Path, found: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
                match entry.file_type() {
                    Ok(kind) if kind.is_dir() => files(&entry.path(), found),
                    Ok(kind) if kind.is_file() => found.push(entry.path()),
                    _ => {}
                }
            }
        }
        let mut all = Vec::new();
        files(directory, &mut all);
        // SAFETY: a plain call without arguments to memory.
        unsafe { libc::sync() };
        let (mut before, mut after) = (0u64, 0u64);
        for path in &all {
            let Ok(file) = File::open(path) else { continue };
            before += cache::cachestat_range(&file, 0, 0).ok()?;
            // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
            after += cache::cachestat_range(&file, 0, 0).ok()?;
        }
        Some((before, after))
    }

    /// A start that reads the start set and the catalogs ahead reaches ready no later than a start
    /// that does not, at the median of 20 starts of each, every start on a data directory whose
    /// pages the kernel was told to drop first, the two arms interleaved (the order swapping each
    /// round). The reading is what the agent's hook does, in a thread of its own that starts with
    /// the postmaster and that nothing waits for: the worst case of the agent's overlap, whose
    /// bind (13 ms at p50 on EU1) gives the reading a head start. The disk of this test is the test
    /// machine's, and the live pass on EU1's disk is the real test (plan 11.2): this one shows that
    /// the reading costs a start nothing on a disk where the pages are really gone, and it says
    /// where the file system cannot drop them (tmpfs, overlayfs).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_start_with_the_sets_read_ahead_is_ready_no_later_at_the_median() {
        let Some(real) = real("prefetch-ab").await else {
            return;
        };
        let (cluster, data) = (&real.cluster, real.cluster.data());
        // The stopped cluster's pages are in the cache, and the kernel drops them: a file system
        // that reports none or keeps what it is told to drop shows nothing of a disk.
        let held = match drop_cache(&data) {
            Some((before, after)) if before > 0 && after * 2 < before => before,
            other => {
                eprintln!(
                    "skipped: this file system does not drop the pages it is told to drop ({other:?})"
                );
                return;
            }
        };
        let never = no_cancel();
        let budget = Duration::from_millis(50);
        let (mut without, mut with) = (Vec::new(), Vec::new());
        let mut reads = 0;
        for round in 0..20 {
            // One of each, the order swapping from round to round.
            let arms = if round % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            };
            for read_ahead in arms {
                // Whatever the last start read is dropped again: little is held afterwards.
                assert!(drop_cache(&data).is_some_and(|(_, after)| after * 2 < held));
                let started = std::thread::scope(|scope| {
                    let reading = read_ahead.then(|| {
                        scope.spawn(|| {
                            let mut advised = 0;
                            for plan in
                                [start(&data, budget, &never), catalog(&data, budget, &never)]
                            {
                                let limits = Limits {
                                    budget,
                                    max_bytes: 12 << 20,
                                };
                                advised += plan.issue(limits, &never).advised;
                            }
                            advised
                        })
                    });
                    let started = cluster.start_timed();
                    reads += reading.map_or(0, |reading| reading.join().unwrap());
                    started
                });
                if read_ahead { &mut with } else { &mut without }.push(started);
                cluster.stop();
            }
        }
        let median = |times: &mut Vec<Duration>| {
            times.sort();
            (times[times.len() / 2], times[times.len() * 19 / 20])
        };
        let (a, b) = (median(&mut without), median(&mut with));
        eprintln!(
            "start to ready, 20 starts of each, pages dropped before each: without {:.1} / {:.1} ms, \
             with the start set and the catalogs read ahead {:.1} / {:.1} ms (p50 / p95), {reads} pieces advised",
            a.0.as_secs_f64() * 1e3,
            a.1.as_secs_f64() * 1e3,
            b.0.as_secs_f64() * 1e3,
            b.1.as_secs_f64() * 1e3,
        );
        assert!(reads > 20 * 40, "the reading did not read: {reads} pieces");
        // The acceptance of the live pass: the median grows by at most 10 ms.
        assert!(
            b.0 <= a.0 + Duration::from_millis(10),
            "with {:?}, without {:?}",
            b.0,
            a.0
        );
    }

    /// What `pg_controldata` says of a stopped cluster's latest checkpoint.
    struct Controldata {
        checkpoint: Lsn,
        redo: Lsn,
        timeline: u32,
    }
    fn controldata(cluster: &Cluster) -> Controldata {
        let output = std::process::Command::new(cluster.layout.postgres_bin.join("pg_controldata"))
            .arg(cluster.data())
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
        let lsn = |key: &str| Lsn::parse(&value(key).to_uppercase()).unwrap();
        Controldata {
            checkpoint: lsn("Latest checkpoint location:"),
            redo: lsn("Latest checkpoint's REDO location:"),
            timeline: value("Latest checkpoint's TimeLineID:").parse().unwrap(),
        }
    }

    /// A cluster that crashed after an online checkpoint replays from the redo point, which is
    /// before the checkpoint record: the control file and `pg_controldata` say the same, and the
    /// windows cover both positions. How far the redo point lies before the record depends on the
    /// WAL written while the checkpoint ran, which a test cannot choose; the windows of positions
    /// that are far apart are the pure test's.
    #[tokio::test]
    async fn the_wal_a_crashed_cluster_replays_from_is_named_by_pg_controldata() {
        let Some(cluster) = Cluster::create("prefetch-crash") else {
            return;
        };
        cluster.start();
        let agent = cluster.agent().await;
        agent
            .batch("CREATE TABLE t AS SELECT g FROM generate_series(1, 20000) g")
            .await
            .unwrap();
        agent.batch_long("CHECKPOINT").await.unwrap();
        agent
            .batch("INSERT INTO t SELECT g FROM generate_series(1, 20000) g")
            .await
            .unwrap();
        drop(agent);
        cluster.kill();
        let control = controldata(&cluster);
        assert!(
            control.redo < control.checkpoint,
            "an online checkpoint's redo precedes its record"
        );
        let file = parse_control_file(&fs::read(cluster.data().join("global/pg_control")).unwrap())
            .unwrap();
        assert_eq!(
            (file.checkpoint, file.redo),
            (control.checkpoint.0, control.redo.0)
        );
        assert_eq!(file.control.timeline, control.timeline);
        let wal = cluster.data().join("pg_wal");
        let segment_bytes =
            fs::metadata(wal.join(control.checkpoint.segment(control.timeline, 16 << 20)))
                .unwrap()
                .len();
        let windows = wal_windows(&file, segment_bytes);
        for position in [control.checkpoint, control.redo] {
            let name = position.segment(control.timeline, segment_bytes);
            let from = position.0 % segment_bytes / BLOCK * BLOCK;
            assert!(
                windows.iter().any(|(known, spans)| *known == name
                    && spans
                        .iter()
                        .any(|(start, end)| *start <= from && from < *end)),
                "{position} is in no window: {windows:?}"
            );
        }
        // The plan reads them, as it does a start that is no crash.
        let planned = names(&make_start(&cluster.data()));
        for (name, _) in &windows {
            assert!(
                planned.contains(&format!("pg_wal/{name}")),
                "{name}: {planned:?}"
            );
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
        let blocks = parse(&text).expect("PostgreSQL's own dump is a list");
        assert!(blocks.len() > 500, "{} blocks", blocks.len());

        let plan = make_list(&data).unwrap();
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
        let plan = make_list(&data).unwrap();

        let mut file = File::open(&path).unwrap();
        let pages = u64::from(blocks) * BLOCK / cache::page_size();
        let held = |file: &File| cache::cachestat_range(file, 0, 0);
        // A file system can only be checked if it reports the pages of a file that was read in
        // full (overlayfs, the root of a container, counts the pages of its own inode and finds
        // none), and if it drops the pages it is told to drop (a tmpfs keeps every page).
        file.read_to_end(&mut Vec::new()).unwrap();
        match held(&file) {
            Ok(0) => {
                return eprintln!(
                    "skipped: this file system does not report the pages of its files"
                );
            }
            Ok(_) => {}
            Err(error) => return eprintln!("skipped: no cachestat here ({error})"),
        }
        // SAFETY: advice for an open descriptor; length 0 is to the end of the file.
        let error =
            unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
        assert_eq!(error, 0);
        if held(&file).unwrap() != 0 {
            return eprintln!("skipped: this file system keeps the pages it is told to drop");
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
